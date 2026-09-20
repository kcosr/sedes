import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { RequestScope } from "../identity/identity-provider.js";

export type TerminalJournalRecord =
  | {
      readonly seq: number;
      readonly kind: "output";
      readonly bytes: Uint8Array;
    }
  | {
      readonly seq: number;
      readonly kind: "resize";
      readonly rows: number;
      readonly columns: number;
    }
  | {
      readonly seq: number;
      readonly kind: "final_status";
      readonly lifecycle: "exited" | "failed" | "interrupted";
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
      readonly publicReason: string | null;
    };

export type TerminalJournalRecovery =
  | { readonly kind: "ok"; readonly state: TerminalJournalState }
  | { readonly kind: "corrupt" };

export type TerminalCheckpoint = {
  readonly seq: number;
  readonly rows: number;
  readonly columns: number;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

export type TerminalJournalState = {
  readonly checkpoint: TerminalCheckpoint;
  readonly records: readonly TerminalJournalRecord[];
  readonly headSeq: number;
};

type StoredRecord = {
  readonly v: 1;
  readonly seq: number;
  readonly kind: TerminalJournalRecord["kind"];
  readonly data?: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly lifecycle?: "exited" | "failed" | "interrupted";
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly publicReason?: string | null;
  readonly checksum: string;
};

type StoredCheckpoint = {
  readonly v: 1;
  readonly seq: number;
  readonly rows: number;
  readonly columns: number;
  readonly data: string;
  readonly sha256: string;
  readonly checksum: string;
};

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_STORED_CHECKPOINT_BYTES = 11_185_152;

function scopeDirectory(scope: RequestScope): string {
  return createHash("sha256")
    .update(`${scope.tenantId}\0${scope.principalId}`)
    .digest("hex");
}

function core(record: TerminalJournalRecord): Omit<StoredRecord, "checksum"> {
  switch (record.kind) {
    case "output":
      return {
        v: 1,
        seq: record.seq,
        kind: record.kind,
        data: Buffer.from(record.bytes).toString("base64url"),
      };
    case "resize":
      return {
        v: 1,
        seq: record.seq,
        kind: record.kind,
        rows: record.rows,
        columns: record.columns,
      };
    case "final_status":
      return { v: 1, ...record };
  }
}

function serialize(record: TerminalJournalRecord): string {
  const payload = core(record);
  const checksum = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return `${JSON.stringify({ ...payload, checksum })}\n`;
}

export class TerminalJournalStore {
  readonly #root: string;
  readonly #maximumBytes: number;
  readonly #afterCheckpointPersisted?: () => void;

  constructor(input: {
    readonly stateDirectory: string;
    readonly maximumBytes?: number;
    readonly afterCheckpointPersisted?: () => void;
  }) {
    this.#root = path.join(input.stateDirectory, "terminals");
    this.#maximumBytes = input.maximumBytes ?? 64 * 1024 * 1024;
    this.#afterCheckpointPersisted = input.afterCheckpointPersisted;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#root, 0o700);
    } catch {
      // Supported non-POSIX filesystems may not expose mode bits.
    }
  }

  append(
    scope: RequestScope,
    terminalId: string,
    record: TerminalJournalRecord,
  ): void {
    const filename = this.#filename(scope, terminalId, true);
    const serialized = serialize(record);
    const currentBytes = existsSync(filename) ? statSync(filename).size : 0;
    if (currentBytes + Buffer.byteLength(serialized) > this.#maximumBytes) {
      throw new Error("terminal_journal_quota_exceeded");
    }
    const descriptor = openSync(filename, "a", 0o600);
    try {
      const bytes = Buffer.from(serialized, "utf8");
      const written = writeSync(descriptor, bytes);
      if (written !== bytes.byteLength) {
        throw new Error("terminal_journal_short_write");
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  read(scope: RequestScope, terminalId: string): TerminalJournalState {
    const checkpoint = this.#readCheckpoint(scope, terminalId);
    const filename = this.#filename(scope, terminalId, false);
    if (!existsSync(filename)) {
      return { checkpoint, records: [], headSeq: checkpoint.seq };
    }
    const bytes = readFileSync(filename);
    if (bytes.byteLength === 0) {
      return { checkpoint, records: [], headSeq: checkpoint.seq };
    }
    let content = bytes.toString("utf8");
    if (!content.endsWith("\n")) {
      const boundary = content.lastIndexOf("\n");
      const validLength =
        boundary < 0 ? 0 : Buffer.byteLength(content.slice(0, boundary + 1));
      truncateSync(filename, validLength);
      const descriptor = openSync(filename, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      content = boundary < 0 ? "" : content.slice(0, boundary + 1);
    }
    const records: TerminalJournalRecord[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      let stored: StoredRecord;
      try {
        stored = JSON.parse(line) as StoredRecord;
      } catch {
        throw new Error("terminal_journal_corrupt");
      }
      if (!this.#isStoredRecord(stored)) {
        throw new Error("terminal_journal_record_invalid");
      }
      const { checksum, ...payload } = stored;
      const actual = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      if (checksum !== actual) {
        throw new Error("terminal_journal_corrupt");
      }
      const expectedSeq = records.at(-1)?.seq;
      if (
        expectedSeq === undefined
          ? stored.seq > checkpoint.seq + 1
          : stored.seq !== expectedSeq + 1
      ) throw new Error("terminal_journal_gap");
      if (records.at(-1)?.kind === "final_status") {
        throw new Error("terminal_journal_record_invalid");
      }
      if (stored.kind === "output" && stored.data !== undefined) {
        records.push({
          seq: stored.seq,
          kind: "output",
          bytes: Uint8Array.from(Buffer.from(stored.data, "base64url")),
        });
      } else if (
        stored.kind === "resize" &&
        stored.rows !== undefined &&
        stored.columns !== undefined
      ) {
        records.push({
          seq: stored.seq,
          kind: "resize",
          rows: stored.rows,
          columns: stored.columns,
        });
      } else if (stored.kind === "final_status" && stored.lifecycle) {
        records.push({
          seq: stored.seq,
          kind: "final_status",
          lifecycle: stored.lifecycle,
          exitCode: stored.exitCode ?? null,
          exitSignal: stored.exitSignal ?? null,
          publicReason: stored.publicReason ?? null,
        });
      } else {
        throw new Error("terminal_journal_record_invalid");
      }
    }
    const suffix = records.filter((record) => record.seq > checkpoint.seq);
    return {
      checkpoint,
      records: suffix,
      headSeq: suffix.at(-1)?.seq ?? checkpoint.seq,
    };
  }

  /**
   * Atomically advances the retained screen checkpoint, then replaces the raw
   * suffix. Persisting the checkpoint first is deliberate: a crash between
   * the two renames leaves a valid new checkpoint plus a redundant old prefix,
   * which read() can safely discard after checksum and sequence validation.
   */
  compact(
    scope: RequestScope,
    terminalId: string,
    checkpoint: Omit<TerminalCheckpoint, "sha256">,
    records: readonly TerminalJournalRecord[],
  ): TerminalCheckpoint {
    if (checkpoint.bytes.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new Error("terminal_checkpoint_too_large");
    }
    if (
      records.some((record, index) =>
        record.seq !== checkpoint.seq + index + 1 ||
        (index > 0 && records[index - 1]!.kind === "final_status"),
      )
    ) {
      throw new Error("terminal_journal_gap");
    }
    const directory = this.#directory(scope, terminalId, true);
    const data = Buffer.from(checkpoint.bytes).toString("base64url");
    const sha256 = createHash("sha256").update(checkpoint.bytes).digest("hex");
    const checkpointCore = {
      v: 1 as const,
      seq: checkpoint.seq,
      rows: checkpoint.rows,
      columns: checkpoint.columns,
      data,
      sha256,
    };
    const storedCheckpoint: StoredCheckpoint = {
      ...checkpointCore,
      checksum: createHash("sha256")
        .update(JSON.stringify(checkpointCore))
        .digest("hex"),
    };
    const journalBytes = Buffer.from(records.map(serialize).join(""), "utf8");
    if (journalBytes.byteLength > this.#maximumBytes) {
      throw new Error("terminal_journal_quota_exceeded");
    }
    const checkpointBytes = Buffer.from(JSON.stringify(storedCheckpoint), "utf8");
    this.#writeReplacement(path.join(directory, "checkpoint.json"), checkpointBytes);
    this.#syncParentDirectory(path.join(directory, "checkpoint.json"));
    this.#afterCheckpointPersisted?.();
    this.#writeReplacement(path.join(directory, "journal.ndjson"), journalBytes);
    this.#syncParentDirectory(path.join(directory, "journal.ndjson"));
    return { ...checkpoint, bytes: Uint8Array.from(checkpoint.bytes), sha256 };
  }

  recover(scope: RequestScope, terminalId: string): TerminalJournalRecovery {
    try {
      return { kind: "ok", state: this.read(scope, terminalId) };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("terminal_journal_")
      ) {
        throw error;
      }
      this.quarantineCorrupt(scope, terminalId);
      return { kind: "corrupt" };
    }
  }

  quarantineCorrupt(scope: RequestScope, terminalId: string): void {
    const directory = this.#directory(scope, terminalId, false);
    if (!existsSync(directory)) return;
    const quarantine = `${directory}.corrupt`;
    if (existsSync(quarantine))
      rmSync(quarantine, { recursive: true, force: true });
    renameSync(directory, quarantine);
    this.#syncParentDirectory(directory);
  }

  delete(scope: RequestScope, terminalId: string): void {
    const directory = this.#directory(scope, terminalId, false);
    const tombstone = `${directory}.deleting`;
    const quarantine = `${directory}.corrupt`;
    if (existsSync(tombstone)) {
      rmSync(tombstone, { recursive: true, force: true });
      this.#syncParentDirectory(directory);
    }
    if (existsSync(directory)) {
      renameSync(directory, tombstone);
      this.#syncParentDirectory(directory);
      rmSync(tombstone, { recursive: true, force: true });
      this.#syncParentDirectory(directory);
    }
    if (existsSync(quarantine)) {
      rmSync(quarantine, { recursive: true, force: true });
      this.#syncParentDirectory(directory);
    }
  }

  #directory(scope: RequestScope, terminalId: string, create: boolean): string {
    if (!/^[0-9a-f-]{36}$/i.test(terminalId)) {
      throw new Error("terminal_journal_identity_invalid");
    }
    const directory = path.join(this.#root, scopeDirectory(scope), terminalId);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  #filename(scope: RequestScope, terminalId: string, create: boolean): string {
    return path.join(
      this.#directory(scope, terminalId, create),
      "journal.ndjson",
    );
  }

  #readCheckpoint(scope: RequestScope, terminalId: string): TerminalCheckpoint {
    const filename = path.join(
      this.#directory(scope, terminalId, false),
      "checkpoint.json",
    );
    if (!existsSync(filename)) {
      return { seq: 0, rows: 1, columns: 2, bytes: new Uint8Array(), sha256: EMPTY_SHA256 };
    }
    if (statSync(filename).size > MAX_STORED_CHECKPOINT_BYTES) {
      throw new Error("terminal_journal_record_invalid");
    }
    let stored: StoredCheckpoint;
    try {
      stored = JSON.parse(readFileSync(filename, "utf8")) as StoredCheckpoint;
    } catch {
      throw new Error("terminal_journal_corrupt");
    }
    if (!this.#isStoredCheckpoint(stored)) {
      throw new Error("terminal_journal_record_invalid");
    }
    const { checksum, ...payload } = stored;
    if (
      createHash("sha256").update(JSON.stringify(payload)).digest("hex") !==
      checksum
    ) {
      throw new Error("terminal_journal_corrupt");
    }
    const bytes = Uint8Array.from(Buffer.from(stored.data, "base64url"));
    if (createHash("sha256").update(bytes).digest("hex") !== stored.sha256) {
      throw new Error("terminal_journal_corrupt");
    }
    return {
      seq: stored.seq,
      rows: stored.rows,
      columns: stored.columns,
      bytes,
      sha256: stored.sha256,
    };
  }

  #isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
    if (!value || typeof value !== "object") return false;
    const checkpoint = value as Record<string, unknown>;
    return (
      checkpoint.v === 1 &&
      Number.isSafeInteger(checkpoint.seq) &&
      (checkpoint.seq as number) > 0 &&
      Number.isInteger(checkpoint.rows) &&
      (checkpoint.rows as number) >= 1 &&
      (checkpoint.rows as number) <= 256 &&
      Number.isInteger(checkpoint.columns) &&
      (checkpoint.columns as number) >= 2 &&
      (checkpoint.columns as number) <= 512 &&
      typeof checkpoint.data === "string" &&
      /^[A-Za-z0-9_-]*$/.test(checkpoint.data) &&
      checkpoint.data.length <= 11_184_811 &&
      Buffer.from(checkpoint.data, "base64url").toString("base64url") === checkpoint.data &&
      Buffer.from(checkpoint.data, "base64url").byteLength <= MAX_CHECKPOINT_BYTES &&
      typeof checkpoint.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(checkpoint.sha256) &&
      typeof checkpoint.checksum === "string" &&
      /^[0-9a-f]{64}$/.test(checkpoint.checksum)
    );
  }

  #writeReplacement(filename: string, bytes: Uint8Array): void {
    const temporary = `${filename}.next`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      const written = writeSync(descriptor, bytes);
      if (written !== bytes.byteLength) {
        throw new Error("terminal_journal_short_write");
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, filename);
  }

  #isStoredRecord(value: unknown): value is StoredRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1 ||
      !Number.isSafeInteger(record.seq) ||
      (record.seq as number) < 1 ||
      typeof record.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.checksum)
    ) {
      return false;
    }
    if (record.kind === "output") {
      if (
        typeof record.data !== "string" ||
        !/^[A-Za-z0-9_-]*$/.test(record.data)
      ) {
        return false;
      }
      return (
        Buffer.from(record.data, "base64url").toString("base64url") ===
        record.data
      );
    }
    if (record.kind === "resize") {
      return (
        Number.isInteger(record.rows) &&
        (record.rows as number) >= 1 &&
        (record.rows as number) <= 256 &&
        Number.isInteger(record.columns) &&
        (record.columns as number) >= 2 &&
        (record.columns as number) <= 512
      );
    }
    if (record.kind === "final_status") {
      return (
        ["exited", "failed", "interrupted"].includes(
          String(record.lifecycle),
        ) &&
        (record.exitCode === null || Number.isInteger(record.exitCode)) &&
        (record.exitSignal === null || typeof record.exitSignal === "string") &&
        (record.publicReason === null ||
          typeof record.publicReason === "string")
      );
    }
    return false;
  }

  #syncParentDirectory(childPath: string): void {
    const parent = path.dirname(childPath);
    if (!existsSync(parent)) return;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(parent, "r");
      fsyncSync(descriptor);
    } catch {
      // Some supported filesystems do not permit opening directories.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
