import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";

const directories: string[] = [];
const scope = { tenantId: "tenant", principalId: "principal" };
const terminalId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TerminalJournalStore", () => {
  it("persists ordered opaque output, resize, and final status", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({ stateDirectory: directory });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Uint8Array.from([0, 255, 10]),
    });
    store.append(scope, terminalId, {
      seq: 2,
      kind: "resize",
      rows: 40,
      columns: 120,
    });
    store.append(scope, terminalId, {
      seq: 3,
      kind: "final_status",
      lifecycle: "exited",
      exitCode: 0,
      exitSignal: null,
      publicReason: null,
    });
    expect(store.read(scope, terminalId).records).toEqual([
      { seq: 1, kind: "output", bytes: Uint8Array.from([0, 255, 10]) },
      { seq: 2, kind: "resize", rows: 40, columns: 120 },
      {
        seq: 3,
        kind: "final_status",
        lifecycle: "exited",
        exitCode: 0,
        exitSignal: null,
        publicReason: null,
      },
    ]);
  });

  it("truncates only an incomplete final record and rejects checksum damage", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({ stateDirectory: directory });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("ok"),
    });
    const journal = findJournal(directory);
    writeFileSync(
      journal,
      Buffer.concat([readFileSync(journal), Buffer.from("partial")]),
    );
    expect(store.read(scope, terminalId).records).toHaveLength(1);
    const damaged = readFileSync(journal)
      .toString("utf8")
      .replace('"seq":1', '"seq":2');
    writeFileSync(journal, damaged);
    expect(() => store.read(scope, terminalId)).toThrow(
      "terminal_journal_corrupt",
    );
  });

  it("fails closed at the byte quota", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({
      stateDirectory: directory,
      maximumBytes: 100,
    });
    expect(() =>
      store.append(scope, terminalId, {
        seq: 1,
        kind: "output",
        bytes: new Uint8Array(200),
      }),
    ).toThrow("terminal_journal_quota_exceeded");
  });

  it("quarantines corruption and removes deletion remnants idempotently", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({ stateDirectory: directory });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("ok"),
    });
    const journal = findJournal(directory);
    writeFileSync(
      journal,
      readFileSync(journal).toString("utf8").replace('"seq":1', '"seq":2'),
    );
    expect(store.recover(scope, terminalId)).toEqual({
      kind: "corrupt",
    });
    const terminalDirectory = path.dirname(journal);
    expect(existsSync(`${terminalDirectory}.corrupt`)).toBe(true);
    store.delete(scope, terminalId);
    store.delete(scope, terminalId);
    expect(existsSync(`${terminalDirectory}.corrupt`)).toBe(false);

    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("new"),
    });
    renameSync(terminalDirectory, `${terminalDirectory}.deleting`);
    store.delete(scope, terminalId);
    expect(existsSync(`${terminalDirectory}.deleting`)).toBe(false);
  });

  it("rejects otherwise valid records after a final status", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({ stateDirectory: directory });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "final_status",
      lifecycle: "exited",
      exitCode: 0,
      exitSignal: null,
      publicReason: null,
    });
    store.append(scope, terminalId, {
      seq: 2,
      kind: "output",
      bytes: Buffer.from("late"),
    });
    expect(() => store.read(scope, terminalId)).toThrow(
      "terminal_journal_record_invalid",
    );
  });

  it("atomically replaces a raw prefix with a sequenced ANSI checkpoint", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    const store = new TerminalJournalStore({ stateDirectory: directory });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("old output"),
    });
    store.append(scope, terminalId, {
      seq: 2,
      kind: "output",
      bytes: Buffer.from("\x1b[2J\x1b[3Jnew output"),
    });
    const checkpoint = store.compact(
      scope,
      terminalId,
      { seq: 2, rows: 24, columns: 80, bytes: Buffer.from("new output") },
      [],
    );
    store.append(scope, terminalId, {
      seq: 3,
      kind: "output",
      bytes: Buffer.from(" suffix"),
    });

    expect(store.read(scope, terminalId)).toEqual({
      checkpoint,
      records: [
        { seq: 3, kind: "output", bytes: Uint8Array.from(Buffer.from(" suffix")) },
      ],
      headSeq: 3,
    });
    expect(readFileSync(findJournal(directory), "utf8")).not.toContain(
      Buffer.from("old output").toString("base64url"),
    );
  });

  it("recovers a new checkpoint with the prior compacted suffix after a second-compaction crash", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-"));
    directories.push(directory);
    let persistedCheckpoints = 0;
    const store = new TerminalJournalStore({
      stateDirectory: directory,
      afterCheckpointPersisted: () => {
        persistedCheckpoints += 1;
        if (persistedCheckpoints === 2) throw new Error("injected_crash");
      },
    });
    store.append(scope, terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("one"),
    });
    store.compact(
      scope,
      terminalId,
      { seq: 1, rows: 24, columns: 80, bytes: Buffer.from("state-one") },
      [],
    );
    store.append(scope, terminalId, {
      seq: 2,
      kind: "output",
      bytes: Buffer.from("two"),
    });
    store.append(scope, terminalId, {
      seq: 3,
      kind: "output",
      bytes: Buffer.from("three"),
    });
    expect(() =>
      store.compact(
        scope,
        terminalId,
        { seq: 3, rows: 24, columns: 80, bytes: Buffer.from("state-three") },
        [],
      ),
    ).toThrow("injected_crash");

    expect(store.read(scope, terminalId)).toMatchObject({
      checkpoint: {
        seq: 3,
        bytes: Uint8Array.from(Buffer.from("state-three")),
      },
      records: [],
      headSeq: 3,
    });
  });
});

function findJournal(directory: string): string {
  const scopeDirectory = readdirSync(path.join(directory, "terminals"))[0]!;
  return path.join(
    directory,
    "terminals",
    scopeDirectory,
    terminalId,
    "journal.ndjson",
  );
}
