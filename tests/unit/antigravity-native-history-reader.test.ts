import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AntigravityNativeHistoryStore, createAntigravityNativeHistoryReader } from "../../src/server/backends/antigravity/native-history.js";

const parentId = "8a54e222-1000-4000-8000-000000000001", childId = "8a54e222-1000-4000-8000-000000000002";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function varint(value: number): Buffer { let n = BigInt(value); const bytes: number[] = []; do { const byte = Number(n & 127n); n >>= 7n; bytes.push(n ? byte | 128 : byte); } while (n); return Buffer.from(bytes); }
function field(number: number, value: string | number | Buffer): Buffer {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const proto = (...values: Buffer[]) => Buffer.concat(values);
function response(text: string, status = 3) { return proto(field(1, 15), field(4, status), field(20, proto(field(1, text), field(12, status === 3 ? 2 : 0)))); }
function invocation(root: string) {
  return proto(field(1, 132), field(4, 3), field(5, proto(field(4, proto(field(1, "child"), field(2, "invoke_subagent"))), field(38, 1))),
    field(140, field(2, field(6, proto(field(1, "type.googleapis.com/exa.cortex.core.tools.InvokeSubagent"),
      field(2, field(2, proto(field(1, childId), field(3, pathToFileURL(root).href)))))))));
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-native-reader-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "antigravity-cli", "conversations"); await mkdir(directory, { recursive: true });
  const configuration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local", geminiDirectory: root, initializationTimeoutMs: 1000 };
  const identity = { sessionId: parentId, cwd: root };
  const databases: Database.Database[] = [];
  cleanups.push(async () => { for (const database of databases) if (database.open) database.close(); });
  const create = (id = parentId, parent?: string, filename = path.join(directory, `${id}.db`)) => {
    const database = new Database(filename); databases.push(database);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, step_format INTEGER, step_payload BLOB)");
    database.prepare("INSERT INTO trajectory_meta VALUES (?)").run(id);
    database.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(proto(field(1, field(1, pathToFileURL(root).href)), ...(parent ? [field(5, parent)] : [])));
    return database;
  };
  const step = (db: Database.Database, index: number, payload: Buffer, type = 15, status = 3) => db.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, 0, 0, ?)").run(index, type, status, payload);
  const store = new AntigravityNativeHistoryStore(configuration); cleanups.push(() => store.close());
  return { root, directory, configuration, identity, create, step, store };
}
const payloadReads = (spy: { mock: { calls: readonly (readonly unknown[])[] } }) => spy.mock.calls.filter(([sql]) => typeof sql === "string" && (sql.includes("SELECT idx, step_type") || sql.includes("SELECT idx, data FROM executor_metadata"))).length;

describe("retained Antigravity native history", () => {
  it("measures each native revision once and reuses exact escaped UTF-8 wire sizes", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response('escaped "text" \\ and café 🌎'));
    const stringify = vi.spyOn(JSON, "stringify");
    const history = await f.store.read(f.identity);
    expect(stringify.mock.calls.filter(([value]) => value === history.native)).toHaveLength(1);
    const bytes = f.store.serializedBytes(history);
    expect(stringify.mock.calls.filter(([value]) => value === history.native || (value as { native?: unknown })?.native === history.native)).toHaveLength(1);
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(history)));
    stringify.mockClear();
    expect((await f.store.read(f.identity)).native).toBe(history.native);
    expect(f.store.serializedBytes(history)).toBe(bytes);
    expect(stringify.mock.calls.some(([value]) => value === history.native)).toBe(false);
  });
  it("derives exact aggregate sizes without serializing a second whole parent transcript", async () => {
    const f = await fixture(), parent = f.create(), child = f.create(childId, parentId);
    f.step(parent, 0, invocation(f.root), 132); f.step(parent, 1, response("parent transcript"));
    f.step(child, 0, response("child transcript", 2), 15, 2);
    const stringify = vi.spyOn(JSON, "stringify");
    const active = await f.store.read(f.identity);
    expect(stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "revision" in value && "steps" in value)).toHaveLength(2);
    expect(f.store.serializedBytes(active)).toBe(Buffer.byteLength(JSON.stringify(active)));
    f.step(child, 0, response("finished"));
    const terminal = await f.store.read(f.identity);
    expect(terminal.native.steps[0]?.subagents?.[0]?.state).toBe("terminal");
    expect(f.store.serializedBytes(terminal)).toBe(Buffer.byteLength(JSON.stringify(terminal)));
  });
  it("avoids payload acquisition and decoding on unchanged WAL snapshots, then notices an external commit", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("before"));
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const before = await f.store.read(f.identity), reads = payloadReads(prepare);
    expect(reads).toBe(2);
    expect((await f.store.read(f.identity)).native).toBe(before.native);
    expect(payloadReads(prepare)).toBe(reads);
    f.step(db, 0, response("after"));
    const after = await f.store.read(f.identity);
    expect(after.native.revision).not.toBe(before.native.revision);
    expect(after.native.steps[0]?.response?.text).toBe("after");
    expect(payloadReads(prepare)).toBe(reads + 2);
    expect(db.prepare("SELECT count(*) AS count FROM steps").get()).toEqual({ count: 1 });
  });
  it("retries missing children and detects child-only writes without rescanning parent payloads", async () => {
    const f = await fixture(), parent = f.create(); f.step(parent, 0, invocation(f.root), 132);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const absent = await f.store.read(f.identity);
    expect(absent.native.steps[0]?.subagents?.[0]?.state).toBe("unknown");
    const reads = payloadReads(prepare);
    expect((await f.store.read(f.identity)).native).toBe(absent.native);
    expect(payloadReads(prepare)).toBe(reads);
    const child = f.create(childId, parentId); f.step(child, 0, response("active", 2), 15, 2);
    const active = await f.store.read(f.identity);
    expect(active.native.steps[0]?.subagents?.[0]?.state).toBe("active");
    expect(active.native.revision).not.toBe(absent.native.revision);
    expect(payloadReads(prepare)).toBe(reads + 2);
    f.step(child, 0, response("finished"));
    const completed = await f.store.read(f.identity);
    expect(completed.native.steps[0]?.subagents?.[0]?.state).toBe("terminal");
    expect(payloadReads(prepare)).toBe(reads + 4);
  });
  it("does not mark a pre-commit snapshot with the version of a commit racing its read transaction", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("before"));
    const original = DatabaseSync.prototype.prepare; let committed = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      // Metadata SELECT already pinned the read transaction, but payload rows
      // have not been acquired. The writer commits through a second connection.
      if (!committed && sql.includes("SELECT idx, step_type")) { committed = true; f.step(db, 0, response("after")); }
      return original.call(this, sql);
    });
    expect((await f.store.read(f.identity)).native.steps[0]?.response?.text).toBe("before");
    expect((await f.store.read(f.identity)).native.steps[0]?.response?.text).toBe("after");
  });
  it("rechecks cached child executor evidence against the aggregate allowance", async () => {
    const f = await fixture(), parent = f.create(), child = f.create(childId, parentId);
    f.step(parent, 0, invocation(f.root), 132);
    f.step(child, 0, proto(field(1, 132), field(4, 6), field(5, field(12, "child-execution")), field(140, Buffer.alloc(0))), 132, 6);
    const largeUnknownField = field(10, Buffer.alloc(7 * 1024 * 1024));
    for (let index = 0; index < 4; index++) child.prepare("INSERT INTO executor_metadata VALUES (?, ?)").run(index,
      proto(...(index === 0 ? [field(1, 2), field(9, "child-execution")] : []), largeUnknownField));
    const alone = await f.store.read({ ...f.identity, sessionId: childId }); expect(alone.native.executions).toHaveLength(1);
    parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(largeUnknownField);
    const omitted = await f.store.read(f.identity);
    expect(omitted.native.steps[0]?.subagents?.[0]?.state).toBe("unknown");
    expect((await f.store.read(f.identity)).native).toBe(omitted.native);
    parent.exec("DELETE FROM executor_metadata");
    expect((await f.store.read(f.identity)).native.steps[0]?.subagents?.[0]?.state).toBe("cancelled");
  });
  it("keeps exact child cancellation proof with a trailing unstarted input", async () => {
    const f = await fixture(), parent = f.create(), child = f.create(childId, parentId);
    f.step(parent, 0, invocation(f.root), 132);
    f.step(child, 0, proto(field(1, 132), field(4, 6), field(5, field(12, "child-execution")), field(140, Buffer.alloc(0))), 132, 6);
    f.step(child, 1, proto(field(1, 14), field(4, 3), field(5, field(12, "child-execution")),
      field(19, field(3, field(1, "Unstarted input")))), 14, 3);
    child.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, 2), field(9, "child-execution")));
    expect((await f.store.read(f.identity)).native.steps[0]?.subagents?.[0]?.state).toBe("cancelled");
  });
  it("invalidates a replaced inode, rejects a symlink, and never reuses a different workspace identity", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("old"));
    const before = await f.store.read(f.identity);
    await expect(f.store.read({ ...f.identity, cwd: path.join(f.root, "other") })).rejects.toThrow("workspace_mismatch");
    db.close(); const filename = path.join(f.directory, `${parentId}.db`);
    await rename(filename, `${filename}.old`);
    const replacement = f.create(); f.step(replacement, 0, response("replacement"));
    expect((await f.store.read(f.identity)).native.steps[0]?.response?.text).toBe("replacement");
    replacement.close(); await rm(filename); await symlink(`${filename}.old`, filename);
    await expect(f.store.read(f.identity)).rejects.toThrow("file_invalid");
    expect(before.native.steps[0]?.response?.text).toBe("old");
  });
  it("forgets retained connections, enforces aborts, and fences reads after close", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("data"));
    const before = await f.store.read(f.identity); await f.store.forget(f.identity);
    expect((await f.store.read(f.identity)).native).not.toBe(before.native);
    await expect(f.store.read(f.identity, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    await f.store.close(); await f.store.close(); await f.store.forget(f.identity);
    await expect(f.store.read(f.identity)).rejects.toThrow("reader_closed");
  });
  it("preserves an unchanged cached snapshot when cancellation arrives during its warm read", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("data"));
    const before = await f.store.read(f.identity), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    let checks = 0;
    await expect(f.store.read(f.identity, { throwIfAborted() { if (++checks === 3) throw new DOMException("Aborted", "AbortError"); } }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect((await f.store.read(f.identity)).native).toBe(before.native);
    expect(payloadReads(prepare)).toBe(0);
  });
  it("retains cached child payloads after a tighter parent traversal rejects their row budget", async () => {
    const f = await fixture(), parent = f.create(), child = f.create(childId, parentId);
    f.step(parent, 0, invocation(f.root), 132); f.step(parent, 1, invocation(f.root), 132);
    child.prepare("WITH RECURSIVE rows(idx) AS (SELECT 0 UNION ALL SELECT idx + 1 FROM rows WHERE idx < 59999) INSERT INTO steps SELECT idx, 0, 3, 0, 0, ? FROM rows").run(field(4, 3));
    const identity = { ...f.identity, sessionId: childId }, before = await f.store.read(identity);
    await f.store.read(f.identity);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect((await f.store.read(identity)).native).toBe(before.native);
    await f.store.read(f.identity);
    expect(payloadReads(prepare)).toBe(0);
  });
  it("closes the retained connection even when rollback itself fails after cancellation", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("data"));
    const exec = DatabaseSync.prototype.exec, close = vi.spyOn(DatabaseSync.prototype, "close");
    const rollback = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "ROLLBACK") throw new Error("injected rollback failure"); return exec.call(this, sql);
    });
    let checks = 0;
    await expect(f.store.read(f.identity, { throwIfAborted() { if (++checks === 3) throw new DOMException("Aborted", "AbortError"); } }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce(); rollback.mockRestore();
    expect((await f.store.read(f.identity)).native.steps[0]?.response?.text).toBe("data");
  });
  it("bounds retained SQLite connections across unrelated native sessions", async () => {
    const f = await fixture(); const close = vi.spyOn(DatabaseSync.prototype, "close");
    for (let index = 0; index < 65; index++) {
      const id = `8a54e222-1000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const db = f.create(id); f.step(db, 0, response("data")); db.close();
      await f.store.read({ ...f.identity, sessionId: id });
    }
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("bounds cached decoded histories across native databases", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("a".repeat(18 * 1024 * 1024))); db.close();
    const first = await f.store.read(f.identity);
    for (let index = 2; index <= 4; index++) {
      const id = `8a54e222-1000-4000-8000-${String(index).padStart(12, "0")}`;
      const other = f.create(id); f.step(other, 0, response("b".repeat(18 * 1024 * 1024))); other.close();
      await f.store.read({ ...f.identity, sessionId: id });
    }
    expect((await f.store.read(f.identity)).native).not.toBe(first.native);
  });
  it("does not double-charge a large parent when aggregate child state shares its transcript", async () => {
    const f = await fixture(), parent = f.create(), child = f.create(childId, parentId);
    f.step(parent, 0, invocation(f.root), 132);
    f.step(parent, 1, response("a".repeat(17 * 1024 * 1024)));
    f.step(parent, 2, response("b".repeat(17 * 1024 * 1024)));
    f.step(child, 0, response("finished"));
    const before = await f.store.read(f.identity), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect((await f.store.read(f.identity)).native).toBe(before.native);
    expect(payloadReads(prepare)).toBe(0);
  });
});

describe("Antigravity history worker", () => {
  it("returns unchanged snapshots by identity and applies changed native rows off-thread", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("before"));
    const reader = createAntigravityNativeHistoryReader(f.configuration); cleanups.push(() => reader.close());
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const before = await reader.read(f.identity);
    expect((await reader.read(f.identity))).toBe(before);
    expect(prepare).not.toHaveBeenCalled();
    f.step(db, 0, response("after")); expect((await reader.read(f.identity)).native.steps[0]?.response?.text).toBe("after");
    await reader.forget(f.identity); expect(await reader.read(f.identity)).not.toBe(before);
  });
  it("rejects aborted/closed reads and permits idempotent cleanup", async () => {
    const f = await fixture(), db = f.create(); f.step(db, 0, response("data"));
    const reader = createAntigravityNativeHistoryReader(f.configuration); cleanups.push(() => reader.close());
    await expect(reader.read(f.identity, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    const pending = reader.read(f.identity); const rejected = expect(pending).rejects.toThrow("reader_closed");
    await reader.close(); await rejected; await reader.close(); await reader.forget(f.identity);
    await expect(reader.read(f.identity)).rejects.toThrow("reader_closed");
  });
});
