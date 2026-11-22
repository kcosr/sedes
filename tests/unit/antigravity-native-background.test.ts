import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAntigravityNativeHistory } from "../../src/server/backends/antigravity/native-history.js";
import { antigravityNativeActivity } from "../../src/server/backends/antigravity/host/native-activity.js";
import type { AntigravityNativeStep } from "../../src/server/backends/antigravity/native-schema.js";

const parentId = "8a54e222-1000-4000-8000-000000000001", childId = "8a54e222-1000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function varint(value: number): Buffer { let n = BigInt(value); const bytes: number[] = []; do { const byte = Number(n & 127n); n >>= 7n; bytes.push(n ? byte | 128 : byte); } while (n); return Buffer.from(bytes); }
function field(number: number, value: string | number | Buffer): Buffer {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = typeof value === "string" ? Buffer.from(value) : value; return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const proto = (...values: Buffer[]) => Buffer.concat(values);
function response(status = 3, reason = 2) { return proto(field(1, 15), field(4, status), field(20, proto(field(1, "response"), field(12, reason)))); }
function toolMetadata(name: string, source = 1) { return proto(field(4, proto(field(1, "tool-call"), field(2, name), field(3, JSON.stringify({ CommandLine: "sleep 1", IsDaemon: false })))), field(38, source)); }
function generic(name: string, payload: Buffer, typeName: string, status = 3, source = 1) {
  return proto(field(1, 132), field(4, status), field(5, toolMetadata(name, source)), field(140, field(2,
    field(6, proto(field(1, `type.googleapis.com/exa.cortex.core.tools.${typeName}`), field(2, payload))))));
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-antigravity-native-test-")); roots.push(root);
  const directory = path.join(root, "antigravity-cli", "conversations"); await mkdir(directory, { recursive: true });
  const configuration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "environment", geminiDirectory: root, initializationTimeoutMs: 1000 };
  const databases: Database.Database[] = [];
  function create(sessionId: string, parent?: string) {
    const database = new Database(path.join(directory, `${sessionId}.db`)); databases.push(database);
    database.exec("CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, step_format INTEGER, step_payload BLOB)");
    database.prepare("INSERT INTO trajectory_meta VALUES (?)").run(sessionId);
    const metadata = proto(field(1, field(1, pathToFileURL(root).href)), ...(parent ? [field(5, parent)] : []));
    database.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(metadata);
    return database;
  }
  function step(database: Database.Database, index: number, type: number, status: number, payload: Buffer) {
    database.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, 0, 0, ?)").run(index, type, status, payload);
  }
  const read = () => readAntigravityNativeHistory(configuration, { sessionId: parentId, cwd: root });
  return { root, directory, configuration, create, step, read, close: () => databases.forEach(database => database.close()) };
}
describe("Antigravity native background authority", () => {
  it("follows only exact typed native child identities and observes child changes without changing the parent DB", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), child = f.create(childId, parentId);
      const result = proto(field(1, childId), field(3, pathToFileURL(f.root).href));
      f.step(parent, 0, 132, 3, generic("invoke_subagent", field(2, result), "InvokeSubagent"));
      f.step(child, 0, 15, 8, response(8, 0));
      const filename = path.join(f.directory, `${parentId}.db`), before = await stat(filename);
      const initial = await f.read(); expect(initial.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "active" }]);
      f.step(child, 0, 15, 3, response());
      const complete = await f.read(); expect(complete.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "terminal" }]);
      expect(complete.native.revision).not.toBe(initial.native.revision); expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
      expect(antigravityNativeActivity(complete.native)).toMatchObject({ active: true, pendingContinuations: true, agents: 1 });
    } finally { f.close(); }
  });
  it("keeps wrong-parent children unknown rather than adopting another scope's store", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId); const child = f.create(childId, childId); f.step(child, 0, 15, 3, response());
      f.step(parent, 0, 132, 3, generic("invoke_subagent", field(2, proto(field(1, childId), field(3, pathToFileURL(f.root).href))), "InvokeSubagent"));
      const history = await f.read(); expect(history.native.steps[0]?.subagents).toEqual([{ sessionId: childId, state: "unknown" }]);
      expect(antigravityNativeActivity(history.native).unknown).toBe(true);
    } finally { f.close(); }
  });
  it("denies an incoming continuation addressed to another native session", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      const message = proto(field(1, childId), field(2, childId), field(3, "task-id"), field(4, "done"));
      f.step(parent, 0, 101, 3, proto(field(1, 101), field(4, 3), field(5, field(3, 5)), field(114, proto(field(3, "task_notification"), field(4, message)))));
      await expect(f.read()).rejects.toThrow("continuation_identity_invalid");
    } finally { f.close(); }
  });
  it("requires both native source and typed payload for tool meaning, and decodes timer cancellation without prose", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      const payload = proto(field(1, "timer"), field(2, "cancelled"));
      f.step(parent, 0, 132, 3, generic("schedule", payload, "Schedule"));
      f.step(parent, 1, 132, 3, generic("schedule", payload, "Schedule", 3, 2));
      const history = await f.read(); expect(history.native.steps[0]?.schedule).toEqual({ mode: "timer", outcome: "cancelled", iterations: 0 });
      expect(history.native.steps[1]?.schedule).toBeUndefined();
    } finally { f.close(); }
  });
  it("holds completed background work until the exact durable wake and its response are consumed", () => {
    const task: AntigravityNativeStep = { index: 0, type: 132, status: 3, hasSubtrajectory: false, task: { id: "task", title: "Timer", description: "timer", daemon: false }, schedule: { mode: "timer", outcome: "fired", iterations: 0 } };
    const wake: AntigravityNativeStep = { index: 2, type: 101, status: 3, hasSubtrajectory: false, continuation: { id: "wake", recipient: parentId, sender: "task", kind: "task_notification", content: "wake" } };
    const final: AntigravityNativeStep = { index: 3, type: 15, status: 3, hasSubtrajectory: false, response: { text: "done", thinking: "", stopReason: 2, toolCalls: [] } };
    const history = { revision: "a".repeat(64), steps: [task] };
    expect(antigravityNativeActivity(history)).toMatchObject({ active: true, foregroundActive: false, pendingContinuations: true, other: 1 });
    history.steps.push(wake); expect(antigravityNativeActivity(history)).toMatchObject({ active: true, foregroundActive: true });
    history.steps.push(final); expect(antigravityNativeActivity(history)).toMatchObject({ active: false, unknown: false, pendingContinuations: false, other: 0 });
    const cancelled = { ...task, schedule: { mode: "timer", outcome: "cancelled", iterations: 0 } };
    expect(antigravityNativeActivity({ ...history, steps: [cancelled] })).toMatchObject({ active: false, pendingContinuations: false });
  });
  it("settles explicit cancelled children without fabricating a completion callback", () => {
    const step: AntigravityNativeStep = { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: childId, state: "cancelled" }] };
    expect(antigravityNativeActivity({ revision: "a".repeat(64), steps: [step] })).toMatchObject({ active: false, unknown: false, agents: 0 });
  });
});
