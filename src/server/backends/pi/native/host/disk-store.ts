import { canonicalPiStoreDirectory } from "../../pi-store-directory.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { z } from "zod";
import {
  PiNativeError,
  type PiNativeCreateInput,
  type PiNativeForkInput,
  type PiNativeHistory,
  type PiNativeSessionIdentity,
  type PiNativeSessionSummary,
} from "../port.js";
import {
  parsePiNativeEntry,
  parsePiNativeSessionHeader,
  type PiNativeEntry,
  type PiNativeSessionHeader,
} from "../rpc/pi-rpc-wire.js";
import { PI_MANAGED_INPUT_MARKER, piManagedOperationSchema, signPiManagedOperation, verifyPiManagedOperations } from "../rpc/pi-managed-protocol.js";
import {
  PI_NATIVE_TOOL_MARKER, PI_NATIVE_TOOL_RESULT_MARKER, piNativeToolCallSchema, piNativeToolResultSchema,
  signPiNativeToolCall, signPiNativeToolResult, verifyPiNativeToolCalls, verifyPiNativeToolResults,
} from "../tool-provenance.js";
import { acquirePiSessionWriterLock } from "../../pi-session-writer-lock.js";

const operationMarkerType = "sedes.native.session_operation.v1";
const operationDomain = "sedes.pi-native.session-operation.v1";
const cursorPattern = /^pi-native-list:([A-Za-z0-9_-]{32}):([1-9][0-9]*)$/;
const operationMarkerSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(128),
  kind: z.enum(["create", "fork"]), operationId: z.string().min(1).max(256),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), historyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  inheritedEntryIds: z.array(z.string().min(1).max(512)).max(250_000),
  parentSessionId: z.string().min(1).max(128).optional(),
  tag: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
type OperationMarker = z.infer<typeof operationMarkerSchema>;
type InheritedProvenance = Pick<OperationMarker, "inheritedEntryIds" | "parentSessionId">;

export const PI_NATIVE_DISK_LIMITS = Object.freeze({
  maximumFileBytes: 64 * 1024 * 1024,
  maximumHeaderBytes: 1024 * 1024,
  maximumEntries: 250_000,
  maximumDirectoryEntries: 100_000,
  maximumSessions: 10_000,
  maximumScanBytes: 512 * 1024 * 1024,
  maximumScanAttempts: 3,
  maximumSnapshotBytes: 32 * 1024 * 1024,
  maximumSnapshots: 8,
  snapshotLifetimeMs: 5 * 60_000,
  maximumConcurrentReads: 4,
});

type Limits = { readonly [K in keyof typeof PI_NATIVE_DISK_LIMITS]: number };
type Snapshot = {
  readonly cwd: string;
  readonly directory: string;
  readonly sessions: readonly PiNativeSessionSummary[];
  readonly limit: number;
  readonly expiresAt: number;
  offset: number;
};
type CapturedPrefix = {
  readonly observed: BigIntStats;
  readonly requiredSize: bigint;
  readonly length: number;
  readonly fingerprint: string;
  readonly requireUnchanged: boolean;
};
type NativeSnapshot = {
  readonly header: PiNativeSessionHeader;
  readonly entries: readonly PiNativeEntry[];
  readonly leafId: string | null;
  readonly bytes: number;
  readonly readBytes: number;
  readonly modified: string;
  readonly capturedPrefix?: CapturedPrefix;
};
type Operation = {
  readonly kind: "create" | "fork";
  readonly operationId: string;
  readonly fingerprint: string;
};

function fail(code: string, cause?: unknown): PiNativeError {
  return new PiNativeError(code, "not_sent", cause === undefined ? undefined : { cause });
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw fail("pi_native_operation_cancelled");
}

function checkPath(value: string): void {
  if (value.length > 8192 || value.includes("\0") || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw fail("pi_native_disk_path_invalid");
  }
}

function checkSessionId(value: string): void {
  // Pi's native session ID contract; Sedes reservations use UUIDs, but native
  // discovery must also accept the custom IDs supported by the stock CLI.
  if (value.length > 128 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
    throw fail("pi_native_session_id_invalid");
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function appendCompatible(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && (right.size > left.size || unchanged(left, right));
}

function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function operation(input: PiNativeCreateInput | PiNativeForkInput, kind: Operation["kind"]): Operation {
  if (!input.operationId || input.operationId.length > 256 || /[\u0000-\u001f]/.test(input.operationId)) {
    throw fail("pi_native_operation_id_invalid");
  }
  if (input.title !== undefined && Buffer.byteLength(input.title, "utf8") > 4096) {
    throw fail("pi_native_title_invalid");
  }
  const identity = "childSessionId" in input
    ? [input.cwd, input.sourceSessionId, input.sourceSessionFile, input.sourceEntryId, input.childSessionId, input.inheritedSettings]
    : [input.cwd, input.sessionId];
  return { kind, operationId: input.operationId, fingerprint: digest([kind, ...identity, input.title ?? null]) };
}

/**
 * Detached native Pi v3 files. This class never loads extensions, opens the SDK,
 * starts Pi, or mutates an existing session. The host owns the shared Pi writer
 * lease and authentication key; these files remain in the stock native store.
 */
export class PiNativeDiskStore {
  readonly sessionDirectory: string;
  readonly #flatDirectory: boolean;
  readonly #authenticationKey: Buffer;
  readonly #limits: Limits;
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #mutations = new Map<string, Promise<unknown>>();
  #reads = 0;
  #closed = false;

  constructor(input: {
    readonly agentDirectory?: string;
    readonly sessionDirectory?: string;
    readonly authenticationKey: Uint8Array;
    readonly limits?: Partial<Limits>;
  }) {
    const agentDirectory = input.agentDirectory ?? path.join(homedir(), ".pi", "agent");
    checkPath(agentDirectory);
    this.sessionDirectory = input.sessionDirectory ?? path.join(agentDirectory, "sessions");
    checkPath(this.sessionDirectory);
    if (input.authenticationKey.byteLength < 32) throw fail("pi_native_authentication_key_invalid");
    this.#authenticationKey = Buffer.from(input.authenticationKey);
    this.#flatDirectory = input.sessionDirectory !== undefined;
    this.#limits = { ...PI_NATIVE_DISK_LIMITS, ...input.limits };
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw fail("pi_native_disk_limit_invalid");
    }
  }

  getSessionDirectory(cwd: string): string {
    checkPath(cwd);
    // Pinned Pi SessionManager.getDefaultSessionDirPath(), without its mkdir.
    return this.#flatDirectory
      ? this.sessionDirectory
      : path.join(this.sessionDirectory, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  }

  async resolveSessionDirectory(cwd: string, signal?: AbortSignal): Promise<string> {
    this.#assertOpen(signal);
    await this.#directory(cwd);
    const directory = await canonicalPiStoreDirectory(this.getSessionDirectory(cwd));
    this.#assertOpen(signal);
    return directory;
  }

  async listSessions(input: { readonly cwd: string; readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<{
    readonly sessions: readonly PiNativeSessionSummary[];
    readonly cursor?: string;
  }> {
    this.#assertOpen(signal);
    await this.#directory(input.cwd);
    const directory = this.getSessionDirectory(input.cwd);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("pi_native_list_limit_invalid");
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= Date.now()) this.#snapshots.delete(id);
    }
    if (input.cursor !== undefined) {
      const match = input.cursor.length <= 100 ? cursorPattern.exec(input.cursor) : null;
      const snapshot = match ? this.#snapshots.get(match[1]!) : undefined;
      if (!match || !snapshot || snapshot.cwd !== input.cwd || snapshot.directory !== directory || snapshot.limit !== limit || snapshot.offset !== Number(match[2])) {
        throw fail("pi_native_cursor_invalid");
      }
      const sessions = snapshot.sessions.slice(snapshot.offset, snapshot.offset + limit);
      snapshot.offset += sessions.length;
      if (snapshot.offset === snapshot.sessions.length) {
        this.#snapshots.delete(match[1]!);
        return { sessions };
      }
      return { sessions, cursor: `pi-native-list:${match[1]}:${snapshot.offset}` };
    }
    const sessions: PiNativeSessionSummary[] = [];
    const ids = new Set<string>();
    let snapshotBytes = 2;
    await this.#scan(directory, async (sessionFile, header, initial) => {
      if (header.cwd !== input.cwd) return;
      const native = await this.#snapshot(sessionFile, signal, false, initial);
      if (native.header.cwd !== input.cwd || native.header.id !== header.id) throw fail("pi_native_history_changed");
      if (ids.has(header.id)) throw fail("pi_native_session_id_ambiguous");
      ids.add(header.id);
      let title: string | undefined;
      for (const entry of native.entries) {
        if (entry.type === "session_info") title = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      }
      const summary = Object.freeze({ sessionId: header.id, sessionFile, cwd: input.cwd, ...(title === undefined ? {} : { title }), updatedAt: native.modified });
      snapshotBytes += Buffer.byteLength(JSON.stringify(summary), "utf8") + 1;
      if (snapshotBytes > this.#limits.maximumSnapshotBytes || sessions.length >= this.#limits.maximumSessions) throw fail("pi_native_list_capacity_exceeded");
      sessions.push(summary);
      return native;
    }, () => { sessions.length = 0; ids.clear(); snapshotBytes = 2; }, signal, true);
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionFile.localeCompare(right.sessionFile));
    this.#assertOpen(signal);
    if (sessions.length <= limit) return { sessions };
    if (this.#snapshots.size >= this.#limits.maximumSnapshots) throw fail("pi_native_list_capacity_exceeded");
    const id = randomBytes(24).toString("base64url");
    this.#snapshots.set(id, { cwd: input.cwd, directory, sessions, limit, offset: limit, expiresAt: Date.now() + this.#limits.snapshotLifetimeMs });
    return { sessions: sessions.slice(0, limit), cursor: `pi-native-list:${id}:${limit}` };
  }

  async readHistory(input: PiNativeSessionIdentity, signal?: AbortSignal): Promise<PiNativeHistory> {
    this.#assertOpen(signal);
    checkSessionId(input.sessionId);
    await this.#directory(input.cwd);
    checkPath(input.sessionFile);
    if (path.dirname(input.sessionFile) !== this.getSessionDirectory(input.cwd) || !input.sessionFile.endsWith(".jsonl")) throw fail("pi_native_session_path_mismatch");
    const native = await this.#snapshot(input.sessionFile, signal, false, "current");
    await this.#verifyCapturedPrefix(input.sessionFile, native.capturedPrefix!, signal);
    if (native.header.id !== input.sessionId || native.header.cwd !== input.cwd) throw fail("pi_native_session_identity_mismatch");
    try {
      return { ...input, entries: native.entries, leafId: native.leafId,
        operations: verifyPiManagedOperations(native.entries, input.sessionId, this.#authenticationKey),
        toolCalls: verifyPiNativeToolCalls(native.entries, input.sessionId, this.#authenticationKey),
        toolResults: verifyPiNativeToolResults(native.entries, input.sessionId, this.#authenticationKey),
        ...this.#provenance(input, native),
      };
    } catch (cause) {
      throw fail("pi_native_history_provenance_invalid", cause);
    }
  }

  async create(input: PiNativeCreateInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity> {
    this.#assertOpen(signal);
    checkSessionId(input.sessionId);
    const request = operation(input, "create");
    return this.#serialize(input.cwd, input.sessionId, async () => {
      this.#assertOpen(signal);
      await this.#directory(input.cwd);
      const existing = await this.#find(input.cwd, input.sessionId, signal);
      if (existing) return this.#verifyOperation(existing, request, signal);
      return this.#publish(input.cwd, input.sessionId, request, [], input.title, undefined, undefined, undefined, signal);
    });
  }

  async reconcileFork(input: PiNativeForkInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity | null> {
    const request = this.#forkOperation(input, signal);
    return this.#serialize(input.cwd, input.childSessionId, () => this.#reconcileFork(input, request, signal));
  }

  #forkOperation(input: PiNativeForkInput, signal?: AbortSignal): Operation {
    this.#assertOpen(signal);
    checkSessionId(input.sourceSessionId);
    checkSessionId(input.childSessionId);
    if (input.sourceSessionId === input.childSessionId || !input.sourceEntryId || input.sourceEntryId.length > 128) throw fail("pi_native_fork_boundary_invalid");
    checkPath(input.sourceSessionFile);
    if (path.dirname(input.sourceSessionFile) !== this.getSessionDirectory(input.cwd) || !input.sourceSessionFile.endsWith(".jsonl")) throw fail("pi_native_session_path_mismatch");
    const settings = input.inheritedSettings;
    if (!settings || !["read_only", "ask", "full"].includes(settings.toolAccess) ||
      (settings.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(settings.thinkingLevel)) ||
      (settings.model !== undefined && [settings.model.provider, settings.model.id].some((value) => typeof value !== "string" || !value || value.length > 512))) {
      throw fail("pi_native_fork_settings_invalid");
    }
    return operation(input, "fork");
  }

  async #reconcileFork(input: PiNativeForkInput, request: Operation, signal?: AbortSignal): Promise<PiNativeSessionIdentity | null> {
    this.#assertOpen(signal);
    await this.#directory(input.cwd);
    const identity = { cwd: input.cwd, sessionId: input.childSessionId, sessionFile: this.#reservationFile(input.cwd, input.childSessionId) };
    try { await lstat(identity.sessionFile); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw fail("pi_native_history_invalid", cause);
    }
    return this.#verifyOperation(identity, request, signal);
  }

  async fork(input: PiNativeForkInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity> {
    const request = this.#forkOperation(input, signal);
    return this.#serialize(input.cwd, input.childSessionId, async () => {
      const replay = await this.#reconcileFork(input, request, signal);
      if (replay) return replay;
      const existing = await this.#find(input.cwd, input.childSessionId, signal, true);
      // Replay does not reacquire a source that may have advanced or disappeared.
      if (existing) return this.#verifyOperation(existing, request, signal);
      const source = await this.readHistory({ cwd: input.cwd, sessionId: input.sourceSessionId, sessionFile: input.sourceSessionFile }, signal);
      const byId = new Map(source.entries.map((entry) => {
        const parsed = parsePiNativeEntry(entry);
        return [parsed.id, parsed] as const;
      }));
      const branch: PiNativeEntry[] = [];
      let id: string | null = input.sourceEntryId;
      while (id !== null) {
        const entry = byId.get(id);
        if (!entry) throw fail("pi_native_fork_boundary_invalid");
        branch.push(entry);
        id = entry.parentId;
      }
      branch.reverse();
      const included = new Set(branch.map((entry) => entry.id));
      for (const entry of branch) {
        if ((entry.type === "compaction" && entry.firstKeptEntryId !== null && !included.has(entry.firstKeptEntryId)) || (entry.type === "context_edit" && !included.has(entry.targetId))) {
          throw fail("pi_native_fork_context_unavailable");
        }
      }
      return this.#publish(input.cwd, input.childSessionId, request,
        this.#reattest(branch, input.sourceSessionId, input.childSessionId), input.title, input.sourceSessionFile, input.sourceSessionId, input.inheritedSettings, signal);
    });
  }

  close(): void {
    this.#closed = true;
    this.#snapshots.clear();
  }

  #assertOpen(signal?: AbortSignal): void {
    if (this.#closed) throw fail("pi_native_disk_store_closed");
    checkSignal(signal);
  }

  async #serialize<T>(cwd: string, sessionId: string, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([cwd, sessionId]);
    const previous = this.#mutations.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(run);
    this.#mutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#mutations.get(key) === pending) this.#mutations.delete(key);
    }
  }

  async #directory(directory: string): Promise<BigIntStats> {
    checkPath(directory);
    try {
      const before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || await realpath(directory) !== directory) throw fail("pi_native_directory_not_canonical");
      const after = await lstat(directory, { bigint: true });
      if (!sameIdentity(before, after)) throw fail("pi_native_directory_changed");
      return after;
    } catch (cause) {
      if (cause instanceof PiNativeError) throw cause;
      throw fail("pi_native_directory_unavailable", cause);
    }
  }

  async #ensureDirectory(directory: string): Promise<void> {
    checkPath(directory);
    const parent = path.dirname(directory);
    if (parent !== directory) await this.#ensureDirectory(parent);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw fail("pi_native_directory_create_failed", cause);
    }
    await this.#directory(directory);
  }

  async #scanFiles(directory: string, signal?: AbortSignal): Promise<Map<string, BigIntStats>> {
    const files = new Map<string, BigIntStats>();
    let count = 0;
    try {
      const handle = await opendir(directory);
      for await (const candidate of handle) {
        this.#assertOpen(signal);
        if (++count > this.#limits.maximumDirectoryEntries) throw fail("pi_native_list_capacity_exceeded");
        if (!candidate.name.endsWith(".jsonl")) continue;
        const file = path.join(directory, candidate.name);
        const identity = await lstat(file, { bigint: true });
        if (!identity.isFile()) throw fail("pi_native_session_file_invalid");
        files.set(file, identity);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw fail("pi_native_directory_changed", cause);
      throw cause;
    }
    return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
  }

  async #scan(directory: string, visit: (file: string, header: PiNativeSessionHeader, initial?: BigIntStats) => Promise<NativeSnapshot | void>, reset: () => void, signal?: AbortSignal, discovery = false): Promise<void> {
    this.#assertOpen(signal);
    try {
      await lstat(directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw fail("pi_native_directory_unavailable", cause);
    }
    let bytes = 0;
    for (let attempt = 0; attempt < this.#limits.maximumScanAttempts; attempt++) {
      reset();
      try {
        const before = await this.#directory(directory);
        const files = await this.#scanFiles(directory, signal);
        const prefixes: { readonly file: string; readonly prefix: CapturedPrefix }[] = [];
        for (const [file, initial] of files) {
          this.#assertOpen(signal);
          const native = await this.#snapshot(file, signal, true, discovery ? initial : undefined);
          bytes += native.readBytes;
          if (bytes > this.#limits.maximumScanBytes) throw fail("pi_native_list_capacity_exceeded");
          if (native.capturedPrefix) prefixes.push({ file, prefix: native.capturedPrefix });
          const complete = await visit(file, native.header, discovery ? initial : undefined);
          bytes += complete?.readBytes ?? 0;
          if (bytes > this.#limits.maximumScanBytes) throw fail("pi_native_list_capacity_exceeded");
          if (complete?.capturedPrefix) prefixes.push({ file, prefix: complete.capturedPrefix });
        }
        const after = await this.#scanFiles(directory, signal);
        // Only the native JSONL namespace determines discovery consistency.
        // Discovery accepts growth after checking the exact captured prefixes;
        // New-session lookup retains the strict metadata check. Fork lookup
        // also accepts growth because its source may be running.
        if (!sameIdentity(before, await this.#directory(directory)) || files.size !== after.size ||
            [...files].some(([file, identity]) => !after.has(file) ||
              !(discovery ? appendCompatible(identity, after.get(file)!) : unchanged(identity, after.get(file)!)))) {
          throw fail("pi_native_directory_changed");
        }
        let verifiedPrefix = false;
        for (const { file, prefix } of prefixes) {
          if (prefix.observed.size === prefix.requiredSize && unchanged(prefix.observed, after.get(file)!)) continue;
          verifiedPrefix = true;
          // Charge before verification so a failed prefix read cannot evade
          // the shared byte budget by causing another complete scan attempt.
          bytes += prefix.length;
          if (bytes > this.#limits.maximumScanBytes) throw fail("pi_native_list_capacity_exceeded");
          await this.#verifyCapturedPrefix(file, prefix, signal);
        }
        if (verifiedPrefix) {
          const final = await this.#scanFiles(directory, signal);
          if (!sameIdentity(before, await this.#directory(directory)) || after.size !== final.size ||
              [...after].some(([file, identity]) => !final.has(file) || !appendCompatible(identity, final.get(file)!)) ||
              prefixes.some(({ file, prefix }) => prefix.requireUnchanged && !unchanged(prefix.observed, final.get(file)!))) {
            throw fail("pi_native_directory_changed");
          }
        }
        return;
      } catch (cause) {
        if (!(cause instanceof PiNativeError) ||
            !["pi_native_directory_changed", "pi_native_history_changed", "pi_native_session_not_found"].includes(cause.code) ||
            attempt + 1 === this.#limits.maximumScanAttempts) throw cause;
      }
    }
  }

  async #find(cwd: string, sessionId: string, signal?: AbortSignal, allowGrowth = false): Promise<PiNativeSessionIdentity | undefined> {
    let found: PiNativeSessionIdentity | undefined;
    await this.#scan(this.getSessionDirectory(cwd), async (sessionFile, header) => {
      if (header.cwd !== cwd || header.id !== sessionId) return;
      if (found) throw fail("pi_native_session_id_ambiguous");
      found = { cwd, sessionId, sessionFile };
    }, () => { found = undefined; }, signal, allowGrowth);
    return found;
  }

  async #snapshot(file: string, signal?: AbortSignal, headerOnly = false, initial?: BigIntStats | "current"): Promise<NativeSnapshot> {
    this.#assertOpen(signal);
    if (this.#reads >= this.#limits.maximumConcurrentReads) throw fail("pi_native_history_capacity_exceeded");
    this.#reads++;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = path.dirname(file);
      const directoryBefore = await this.#directory(directory);
      const named = await lstat(file, { bigint: true });
      if (!named.isFile() || await realpath(file) !== file) throw fail("pi_native_session_file_invalid");
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameIdentity(named, before) || (initial && initial !== "current" && !appendCompatible(initial, before))) throw fail("pi_native_history_changed");
      const captured = initial === "current" ? before : initial ?? before;
      if (captured.size === 0n || (!headerOnly && captured.size > BigInt(this.#limits.maximumFileBytes))) throw fail("pi_native_history_capacity_exceeded");
      const length = Number(headerOnly ? (captured.size < BigInt(this.#limits.maximumHeaderBytes + 1) ? captured.size : BigInt(this.#limits.maximumHeaderBytes + 1)) : captured.size);
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        this.#assertOpen(signal);
        const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, length - offset), offset);
        if (!bytesRead) throw fail("pi_native_history_changed");
        offset += bytesRead;
        if (headerOnly && bytes.subarray(0, offset).includes(10)) break;
      }
      const after = await handle.stat({ bigint: true });
      const namedAfter = await lstat(file, { bigint: true });
      const stable = initial ? appendCompatible : unchanged;
      if (!stable(before, after) || !stable(after, namedAfter) || !sameIdentity(directoryBefore, await this.#directory(directory))) throw fail("pi_native_history_changed");
      const headerEnd = bytes.subarray(0, offset).indexOf(10);
      const firstLineBytes = headerEnd < 0 ? offset : headerEnd;
      if (firstLineBytes > this.#limits.maximumHeaderBytes || (headerOnly && headerEnd < 0 && BigInt(offset) < captured.size)) throw fail("pi_native_history_capacity_exceeded");
      const decode = new TextDecoder("utf-8", { fatal: true });
      // Active writes can stop inside UTF-8 or JSON. A valid unterminated
      // record is also native history, but only an unchanged-file proof can
      // distinguish its end from an in-progress append.
      let completeLength = initial ? (headerOnly ? headerEnd + 1 : bytes.subarray(0, offset).lastIndexOf(10) + 1) : offset;
      let requireUnchanged = false;
      if (initial && completeLength < offset && (!headerOnly || headerEnd < 0)) {
        try {
          const tail = decode.decode(bytes.subarray(completeLength, offset));
          if (tail.trim()) {
            JSON.parse(tail);
            completeLength = offset;
            requireUnchanged = true;
          }
        } catch {
          // Only newline-terminated records are authoritative while the tail
          // is incomplete. Normal entry parsing below still rejects invalid
          // schemas, duplicate IDs, and invalid parent references.
        }
        if (requireUnchanged && !unchanged(captured, namedAfter)) throw fail("pi_native_history_changed");
      }
      if (initial && completeLength === 0) throw fail("pi_native_history_changed");
      const text = decode.decode(bytes.subarray(0, headerOnly ? firstLineBytes : completeLength));
      let header: PiNativeSessionHeader | undefined;
      const entries: PiNativeEntry[] = [];
      const ids = new Set<string>();
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        const line = text.slice(start, end);
        start = end + 1;
        if (!line.trim()) continue;
        if (!header) {
          header = parsePiNativeSessionHeader(JSON.parse(line));
          checkSessionId(header.id);
          checkPath(header.cwd);
        } else {
          if (entries.length >= this.#limits.maximumEntries) throw fail("pi_native_history_capacity_exceeded");
          const entry = parsePiNativeEntry(JSON.parse(line));
          if (ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw fail("pi_native_history_tree_invalid");
          ids.add(entry.id);
          entries.push(entry);
          if (entries.length % 512 === 0) {
            await scheduler.yield();
            this.#assertOpen(signal);
          }
        }
      }
      if (!header) throw fail("pi_native_history_invalid");
      return { header, entries, leafId: entries.at(-1)?.id ?? null, bytes: Number(captured.size), readBytes: offset, modified: new Date(Number(captured.mtimeMs)).toISOString(),
        ...(initial ? { capturedPrefix: { observed: requireUnchanged ? captured : before, requiredSize: captured.size, length: completeLength, requireUnchanged,
          fingerprint: createHash("sha256").update(bytes.subarray(0, completeLength)).digest("hex") } } : {}) };
    } catch (cause) {
      if (cause instanceof PiNativeError) throw cause;
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw fail("pi_native_session_not_found", cause);
      throw fail("pi_native_history_invalid", cause);
    } finally {
      try { await handle?.close(); } finally { this.#reads--; }
    }
  }

  async #verifyCapturedPrefix(file: string, prefix: CapturedPrefix, signal?: AbortSignal): Promise<void> {
    this.#assertOpen(signal);
    if (this.#reads >= this.#limits.maximumConcurrentReads) throw fail("pi_native_history_capacity_exceeded");
    this.#reads++;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = path.dirname(file);
      const directoryBefore = await this.#directory(directory);
      const named = await lstat(file, { bigint: true });
      if (!named.isFile() || await realpath(file) !== file) throw fail("pi_native_history_changed");
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      const stable = prefix.requireUnchanged ? unchanged : appendCompatible;
      if (!before.isFile() || !sameIdentity(named, before) || !stable(prefix.observed, before) ||
          before.size < prefix.requiredSize) throw fail("pi_native_history_changed");
      const hash = createHash("sha256");
      const bytes = Buffer.alloc(Math.min(64 * 1024, prefix.length));
      let offset = 0;
      while (offset < prefix.length) {
        this.#assertOpen(signal);
        const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, prefix.length - offset), offset);
        if (!bytesRead) throw fail("pi_native_history_changed");
        hash.update(bytes.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const namedAfter = await lstat(file, { bigint: true });
      if (!stable(before, after) || !stable(after, namedAfter) ||
          !sameIdentity(directoryBefore, await this.#directory(directory)) || hash.digest("hex") !== prefix.fingerprint) {
        throw fail("pi_native_history_changed");
      }
    } catch (cause) {
      if (cause instanceof PiNativeError) throw cause;
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw fail("pi_native_session_not_found", cause);
      throw fail("pi_native_history_changed", cause);
    } finally {
      try { await handle?.close(); } finally { this.#reads--; }
    }
  }

  #signature(identity: PiNativeSessionIdentity, request: Operation, historyFingerprint: string, header: PiNativeSessionHeader, provenance: InheritedProvenance): string {
    return createHmac("sha256", this.#authenticationKey)
      .update(JSON.stringify([operationDomain, identity.cwd, identity.sessionId, identity.sessionFile, request.kind, request.operationId, request.fingerprint, historyFingerprint, header, provenance.inheritedEntryIds, provenance.parentSessionId ?? null]))
      .digest("base64url");
  }

  #markerAuthentic(identity: PiNativeSessionIdentity, native: NativeSnapshot, marker: OperationMarker): boolean {
    const expected = this.#signature(identity, marker, marker.historyFingerprint, native.header, marker);
    return timingSafeEqual(Buffer.from(marker.tag), Buffer.from(expected));
  }

  #assertMarkerPrefix(native: NativeSnapshot, marker: OperationMarker, index: number): void {
    if (digest(native.entries.slice(0, index)) !== marker.historyFingerprint ||
      marker.inheritedEntryIds.length > index || marker.inheritedEntryIds.some((id, offset) => native.entries[offset]?.id !== id) ||
      (marker.kind === "create" && (marker.parentSessionId !== undefined || marker.inheritedEntryIds.length !== 0 || native.header.parentSession !== undefined)) ||
      (marker.kind === "fork" && (marker.parentSessionId === undefined || marker.inheritedEntryIds.length === 0 || native.header.parentSession === undefined))) {
      throw fail("pi_native_operation_marker_invalid");
    }
  }

  #provenance(identity: PiNativeSessionIdentity, native: NativeSnapshot): {
    readonly inheritance: "none" | "verified" | "unknown";
    readonly inheritedEntryIds: readonly string[];
    readonly parentSessionId?: string;
  } {
    let found: OperationMarker | undefined;
    for (let index = 0; index < native.entries.length; index++) {
      const entry = native.entries[index]!;
      if (entry.type !== "custom" || entry.customType !== operationMarkerType) continue;
      const parsed = operationMarkerSchema.safeParse(entry.data);
      if (!parsed.success || parsed.data.sessionId !== identity.sessionId || !this.#markerAuthentic(identity, native, parsed.data)) continue;
      this.#assertMarkerPrefix(native, parsed.data, index);
      if (found) throw fail("pi_native_operation_conflict");
      found = parsed.data;
    }
    if (found?.kind === "fork") return { inheritance: "verified", inheritedEntryIds: found.inheritedEntryIds, parentSessionId: found.parentSessionId };
    return { inheritance: native.header.parentSession === undefined ? "none" : "unknown", inheritedEntryIds: [] };
  }

  async #verifyOperation(identity: PiNativeSessionIdentity, request: Operation, signal?: AbortSignal): Promise<PiNativeSessionIdentity> {
    const native = await this.#snapshot(identity.sessionFile, signal);
    if (native.header.id !== identity.sessionId || native.header.cwd !== identity.cwd) throw fail("pi_native_session_identity_mismatch");
    let found = false;
    for (let index = 0; index < native.entries.length; index++) {
      const entry = native.entries[index]!;
      if (entry.type !== "custom" || entry.customType !== operationMarkerType) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
      const marker = data as Record<string, unknown>;
      if (marker.sessionId !== identity.sessionId) continue;
      const parsed = operationMarkerSchema.safeParse(marker);
      if (found || !parsed.success || parsed.data.kind !== request.kind || parsed.data.operationId !== request.operationId || parsed.data.fingerprint !== request.fingerprint) throw fail("pi_native_operation_conflict");
      if (!this.#markerAuthentic(identity, native, parsed.data)) throw fail("pi_native_operation_marker_invalid");
      this.#assertMarkerPrefix(native, parsed.data, index);
      found = true;
    }
    if (!found) throw fail("pi_native_operation_conflict");
    return identity;
  }

  #reattest(entries: readonly PiNativeEntry[], sourceId: string, childId: string): readonly PiNativeEntry[] {
    // Validate the authenticated operation history before transferring its
    // authority. Unsigned extension data remains ordinary native history.
    let inputs: ReadonlySet<string>;
    let calls: ReadonlySet<string>;
    let results: ReadonlySet<string>;
    try {
      inputs = new Set(verifyPiManagedOperations(entries, sourceId, this.#authenticationKey).map(operation => signPiManagedOperation(sourceId, operation, this.#authenticationKey)));
      calls = new Set(verifyPiNativeToolCalls(entries, sourceId, this.#authenticationKey).map(call => signPiNativeToolCall(sourceId, call, this.#authenticationKey)));
      results = new Set(verifyPiNativeToolResults(entries, sourceId, this.#authenticationKey).map(result => signPiNativeToolResult(sourceId, result, this.#authenticationKey)));
    }
    catch (cause) { throw fail("pi_native_fork_provenance_invalid", cause); }
    return entries.map((entry): PiNativeEntry => {
      if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return entry;
      const data = entry.data as Record<string, unknown>;
      if (Object.keys(data).length !== 3 || data.version !== 1 || typeof data.authentication !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.authentication)) return entry;
      if (entry.customType === PI_NATIVE_TOOL_MARKER) {
        const decoded = piNativeToolCallSchema.safeParse(data.call);
        if (!decoded.success) return entry;
        const signature = signPiNativeToolCall(sourceId, decoded.data, this.#authenticationKey);
        if (!calls.has(signature)) return entry;
        const expected = Buffer.from(signature);
        if (!timingSafeEqual(Buffer.from(data.authentication), expected)) return entry;
        return { ...entry, data: { version: 1, call: decoded.data, authentication: signPiNativeToolCall(childId, decoded.data, this.#authenticationKey) } };
      }
      if (entry.customType === PI_NATIVE_TOOL_RESULT_MARKER) {
        const decoded = piNativeToolResultSchema.safeParse(data.result);
        if (!decoded.success) return entry;
        const signature = signPiNativeToolResult(sourceId, decoded.data, this.#authenticationKey);
        if (!results.has(signature)) return entry;
        const expected = Buffer.from(signature);
        if (!timingSafeEqual(Buffer.from(data.authentication), expected)) return entry;
        return { ...entry, data: { version: 1, result: decoded.data, authentication: signPiNativeToolResult(childId, decoded.data, this.#authenticationKey) } };
      }
      if (entry.customType !== PI_MANAGED_INPUT_MARKER) return entry;
      const decoded = piManagedOperationSchema.safeParse(data.operation);
      if (!decoded.success) return entry;
      const signature = signPiManagedOperation(sourceId, decoded.data, this.#authenticationKey);
      if (!inputs.has(signature)) return entry;
      const expected = Buffer.from(signature);
      if (!timingSafeEqual(Buffer.from(data.authentication), expected)) return entry;
      return { ...entry, data: { version: 1, operation: decoded.data, authentication: signPiManagedOperation(childId, decoded.data, this.#authenticationKey) } };
    });
  }

  #reservationFile(cwd: string, sessionId: string): string {
    return path.join(this.getSessionDirectory(cwd), `sedes-native-${digest([cwd, sessionId])}.jsonl`);
  }

  async #publish(cwd: string, sessionId: string, request: Operation, inherited: readonly PiNativeEntry[], title: string | undefined, parentSession: string | undefined, parentSessionId: string | undefined, settings: PiNativeForkInput["inheritedSettings"] | undefined, signal?: AbortSignal): Promise<PiNativeSessionIdentity> {
    const directory = this.getSessionDirectory(cwd);
    await this.#ensureDirectory(directory);
    const directoryBefore = await this.#directory(directory);
    const sessionFile = this.#reservationFile(cwd, sessionId);
    const identity = { cwd, sessionId, sessionFile };
    const timestamp = new Date().toISOString();
    const header: PiNativeSessionHeader = { type: "session", version: 3, id: sessionId, timestamp, cwd, ...(parentSession === undefined ? {} : { parentSession }) };
    const prefix = [...inherited];
    if (settings?.model) prefix.push({ type: "model_change", id: randomBytes(16).toString("hex"), parentId: prefix.at(-1)?.id ?? null, timestamp, provider: settings.model.provider, modelId: settings.model.id });
    if (settings?.thinkingLevel !== undefined) prefix.push({ type: "thinking_level_change", id: randomBytes(16).toString("hex"), parentId: prefix.at(-1)?.id ?? null, timestamp, thinkingLevel: settings.thinkingLevel });
    if (title !== undefined) prefix.push({ type: "session_info", id: randomBytes(16).toString("hex"), parentId: prefix.at(-1)?.id ?? null, timestamp, name: title });
    const historyFingerprint = digest(prefix);
    const provenance: InheritedProvenance = { inheritedEntryIds: inherited.map((entry) => entry.id), ...(parentSessionId === undefined ? {} : { parentSessionId }) };
    const marker: PiNativeEntry = {
      type: "custom", id: randomBytes(16).toString("hex"), parentId: prefix.at(-1)?.id ?? null, timestamp, customType: operationMarkerType,
      data: { version: 1, sessionId, ...request, historyFingerprint, ...provenance, tag: this.#signature(identity, request, historyFingerprint, header, provenance) },
    };
    const entries = [...prefix, marker];
    try {
      parsePiNativeSessionHeader(header);
      parsePiNativeEntry(marker);
    } catch (cause) { throw fail("pi_native_history_capacity_exceeded", cause); }
    const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    if (Buffer.byteLength(content, "utf8") > this.#limits.maximumFileBytes || entries.length > this.#limits.maximumEntries) throw fail("pi_native_history_capacity_exceeded");
    const temporary = path.join(directory, `.sedes-native-${randomBytes(24).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: BigIntStats | undefined;
    let lease: Awaited<ReturnType<typeof acquirePiSessionWriterLock>> | undefined;
    let published = false;
    try {
      this.#assertOpen(signal);
      lease = await acquirePiSessionWriterLock(sessionFile);
      this.#assertOpen(signal);
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      temporaryIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#assertOpen(signal);
      if (!sameIdentity(directoryBefore, await this.#directory(directory))) throw fail("pi_native_directory_changed");
      try {
        // Publish complete bytes without replacing a competing reservation.
        await link(temporary, sessionFile);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        const verified = await this.#verifyOperation(identity, request, signal);
        published = true;
        return verified;
      }
      published = true;
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
      // Cancellation after publication cannot turn the accepted operation into
      // a proved-unsent failure. Read the persisted proof before returning it.
      return await this.#verifyOperation(identity, request);
    } catch (cause) {
      if (published) throw new PiNativeError("pi_native_session_publish_uncertain", "sent_outcome_unknown", { cause });
      if (cause instanceof PiNativeError) throw cause;
      throw fail("pi_native_session_publish_failed", cause);
    } finally {
      try {
        try { await handle?.close(); }
        finally {
          if (temporaryIdentity) {
            const named = await lstat(temporary, { bigint: true }).catch((cause: unknown) => {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw cause;
            });
            if (named && sameIdentity(temporaryIdentity, named)) await unlink(temporary);
            else if (named) throw fail("pi_native_temporary_file_changed");
          }
        }
      } catch (cause) {
        throw new PiNativeError("pi_native_session_cleanup_failed", published ? "sent_outcome_unknown" : "not_sent", { cause });
      } finally {
        try { await lease?.release(); }
        catch (cause) { throw new PiNativeError("pi_native_session_lease_release_failed", published ? "sent_outcome_unknown" : "not_sent", { cause }); }
      }
    }
  }
}
