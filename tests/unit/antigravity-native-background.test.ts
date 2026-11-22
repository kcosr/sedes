import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAntigravityNativeHistory } from "../../src/server/backends/antigravity/native-history.js";
import { antigravityNativeActivity } from "../../src/server/backends/antigravity/host/native-activity.js";
import type { AntigravityNativeStep } from "../../src/server/backends/antigravity/native-schema.js";
import { antigravityReadError } from "../../src/server/backends/antigravity/errors.js";

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
function toolMetadata(name: string, source = 1, executionId?: string) { return proto(field(4, proto(field(1, "tool-call"), field(2, name), field(3, JSON.stringify({ CommandLine: "sleep 1", IsDaemon: false })))), field(38, source), ...(executionId ? [field(12, executionId)] : [])); }
function generic(name: string, payload: Buffer, typeName: string, status = 3, source = 1, executionId?: string) {
  return proto(field(1, 132), field(4, status), field(5, toolMetadata(name, source, executionId)), field(140, field(2,
    field(6, proto(field(1, `type.googleapis.com/exa.cortex.core.tools.${typeName}`), field(2, payload))))));
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-antigravity-native-test-")); roots.push(root);
  const directory = path.join(root, "antigravity-cli", "conversations"); await mkdir(directory, { recursive: true });
  const configuration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "environment", geminiDirectory: root, initializationTimeoutMs: 1000 };
  const databases: Database.Database[] = [];
  function create(sessionId: string, parent?: string) {
    const database = new Database(path.join(directory, `${sessionId}.db`)); databases.push(database);
    database.exec("CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, step_format INTEGER, step_payload BLOB)");
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
async function cancelledChildFixture(status = 6) {
  const f = await fixture(), parent = f.create(parentId), child = f.create(childId, parentId);
  const executionId = "child-execution";
  f.step(parent, 0, 132, 3, generic("invoke_subagent", field(2, proto(field(1, childId), field(3, pathToFileURL(f.root).href))), "InvokeSubagent"));
  f.step(child, 0, 15, 3, proto(field(1, 15), field(4, 3), field(5, field(12, executionId)), field(20,
    proto(field(12, 2), field(7, proto(field(1, "tool-call"), field(2, "run_command"), field(3, "{}")))))));
  f.step(child, 1, 132, status, generic("run_command", Buffer.alloc(0), "RunCommand", status, 1, executionId));
  return { ...f, child, executionId };
}
describe("Antigravity native background authority", () => {
  it.each((["child", "embedded"] as const).flatMap(kind => [1, 3, 6, 11].map(reason => ({ kind, reason }))))("keeps a failed tool tail in a $kind unknown until execution receipt $reason", async ({ kind, reason }) => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), child = kind === "child" ? f.create(childId, parentId) : undefined;
      const executionId = "failed-read-execution";
      const failedRead = proto(generic("read_file", Buffer.alloc(0), "ReadFile", 7, 1, executionId),
        field(31, field(1, "file does not exist")));
      const enclosing = generic("invoke_subagent", field(2, proto(field(1, childId), field(3, pathToFileURL(f.root).href))), "InvokeSubagent");
      const write = (final?: Buffer, receipt?: Buffer) => {
        if (child) {
          f.step(parent, 0, 132, 3, enclosing);
          f.step(child, 0, 132, 7, failedRead);
          if (final) f.step(child, 1, 15, 3, final);
          if (receipt) child.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(receipt);
        } else {
          f.step(parent, 0, 132, 3, proto(enclosing, field(6, proto(field(6, childId), field(2, failedRead),
            ...(final ? [field(2, final)] : []), ...(receipt ? [field(9, receipt)] : [])))));
          parent.exec("UPDATE steps SET has_subtrajectory = 1 WHERE idx = 0");
        }
      };
      const state = async () => {
        const history = (await f.read()).native;
        return kind === "child" ? history.steps[0]?.subagents?.[0]?.state : history.steps[0]?.subtrajectoryState;
      };
      write();
      expect(await state()).toBe("unknown");
      write(undefined, proto(field(1, reason), field(9, executionId)));
      expect(await state()).toBe("terminal");
      if (child) child.exec("DELETE FROM executor_metadata");
      write(response());
      expect(await state()).toBe("terminal");
    } finally { f.close(); }
  });
  it.each([6, 12])("requires exact executor proof for a child ending at canceled tool status %s", async status => {
    const f = await cancelledChildFixture(status);
    try {
      const before = await f.read();
      expect(before.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "unknown" }]);
      expect(antigravityNativeActivity(before.native)).toMatchObject({ unknown: true, agents: 1 });
      f.child.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, 2), field(3, 1), field(9, f.executionId)));
      const after = await f.read();
      expect(after.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "cancelled" }]);
      expect(after.native.revision).not.toBe(before.native.revision);
      expect(antigravityNativeActivity(after.native)).toMatchObject({ active: false, unknown: false, agents: 0 });
    } finally { f.close(); }
  });
  it.each(["wrong_execution", "wrong_head", "auto_continue", "conflict", "omitted"] as const)("keeps canceled child tools unknown with %s executor proof", async evidence => {
    const f = await cancelledChildFixture();
    try {
      const receipt = proto(field(1, 2), field(3, evidence === "wrong_head" ? 0 : 1),
        field(9, evidence === "wrong_execution" ? "other-execution" : f.executionId), ...(evidence === "auto_continue" ? [field(4, 1)] : []));
      f.child.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(receipt);
      if (evidence === "conflict") f.child.prepare("INSERT INTO executor_metadata VALUES (1, ?)").run(proto(field(1, 12), field(3, 1), field(9, f.executionId)));
      if (evidence === "omitted") f.child.prepare("INSERT INTO executor_metadata VALUES (1, zeroblob(?))").run(8 * 1024 * 1024 + 1);
      const history = await f.read();
      expect(history.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "unknown" }]);
      expect(antigravityNativeActivity(history.native).unknown).toBe(true);
    } finally { f.close(); }
  });
  it("does not mistake a child's tool-call response for its terminal response", async () => {
    const f = await cancelledChildFixture();
    try {
      f.child.exec("DELETE FROM steps WHERE idx = 1");
      const history = await f.read();
      expect(history.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "unknown" }]);
      expect(antigravityNativeActivity(history.native).unknown).toBe(true);
    } finally { f.close(); }
  });
  it("uses a late embedded executor receipt to settle an exact canceled subtrajectory", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), executionId = "embedded-execution";
      const tool = generic("run_command", Buffer.alloc(0), "RunCommand", 6, 1, executionId);
      const enclosing = generic("run_command", Buffer.alloc(0), "RunCommand");
      const write = (receipts: Buffer[]) => {
        f.step(parent, 0, 132, 3, proto(enclosing, field(6, proto(field(6, childId), field(2, tool), ...receipts.map(value => field(9, value))))));
        parent.exec("UPDATE steps SET has_subtrajectory = 1 WHERE idx = 0");
      };
      write([]);
      const before = await f.read();
      expect(before.native.steps[0]?.subtrajectoryState).toBe("unknown");
      expect(antigravityNativeActivity(before.native).unknown).toBe(true);
      write([proto(field(1, 2), field(3, 0), field(9, executionId))]);
      const after = await f.read();
      expect(after.native.steps[0]?.subtrajectoryState).toBe("terminal");
      expect(after.native.revision).not.toBe(before.native.revision);
      expect(antigravityNativeActivity(after.native)).toMatchObject({ active: false, unknown: false });
    } finally { f.close(); }
  });
  it.each(["missing", "wrong_execution", "wrong_head", "auto_continue", "conflict", "active_descendant"] as const)("keeps embedded cancellation unproven with %s evidence despite a canceled enclosing tool", async evidence => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), executionId = "embedded-execution";
      const receipt = proto(field(1, 2), field(3, evidence === "wrong_head" ? 1 : 0),
        field(9, evidence === "wrong_execution" ? "other" : executionId), ...(evidence === "auto_continue" ? [field(4, 1)] : []));
      const receipts = evidence === "missing" ? [] : [field(9, receipt)];
      if (evidence === "conflict") receipts.push(field(9, proto(field(1, 12), field(3, 0), field(9, executionId))));
      const tool = proto(generic("run_command", Buffer.alloc(0), "RunCommand", 6, 1, executionId),
        ...(evidence === "active_descendant" ? [field(6, proto(field(6, "active-descendant"), field(2, response(2, 0))))] : []));
      f.step(parent, 0, 132, 6, proto(generic("run_command", Buffer.alloc(0), "RunCommand", 6),
        field(6, proto(field(6, childId), field(2, tool), ...receipts))));
      parent.exec("UPDATE steps SET has_subtrajectory = 1 WHERE idx = 0");
      const history = await f.read();
      expect(history.native.steps[0]?.subtrajectoryState).toBe(evidence === "active_descendant" ? "active" : "unknown");
      expect(antigravityNativeActivity(history.native)).toMatchObject(evidence === "active_descendant" ? { active: true } : { unknown: true });
    } finally { f.close(); }
  });
  it("rejects a changed embedded executor field type instead of accepting enclosing cancellation", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      f.step(parent, 0, 132, 6, proto(generic("run_command", Buffer.alloc(0), "RunCommand", 6),
        field(6, proto(field(6, childId), field(2, generic("run_command", Buffer.alloc(0), "RunCommand", 6)), field(9, 2)))));
      parent.exec("UPDATE steps SET has_subtrajectory = 1 WHERE idx = 0");
      await expect(f.read()).rejects.toThrow("antigravity_native_field_type_changed");
    } finally { f.close(); }
  });
  it("rejects an oversized embedded proof set without using a partially decoded cancellation receipt", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), executionId = "embedded-execution";
      const receipt = field(9, proto(field(1, 2), field(3, 0), field(9, executionId)));
      const excessive = Buffer.concat(Array.from({ length: 100_000 }, () => field(9, Buffer.alloc(0))));
      f.step(parent, 0, 132, 6, proto(generic("run_command", Buffer.alloc(0), "RunCommand", 6),
        field(6, proto(field(6, childId), field(2, generic("run_command", Buffer.alloc(0), "RunCommand", 6, 1, executionId)), receipt, excessive))));
      parent.exec("UPDATE steps SET has_subtrajectory = 1 WHERE idx = 0");
      await expect(f.read()).rejects.toThrow("antigravity_native_field_limit");
    } finally { f.close(); }
  });
  it("reads only reviewed executor proof and changes revision when a late terminal receipt is stored", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      f.step(parent, 0, 15, 3, response());
      const before = await f.read();
      expect(before.native.executions).toEqual([]);
      // Other fields contain native configuration; neither the private wire nor
      // normalized history may acquire them just to establish cancellation.
      const data = proto(field(1, 2), field(3, 0), field(9, "cancelled-execution"), field(10, "private-native-config"));
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(data);
      const after = await f.read();
      expect(after.native.executions).toEqual([{ executionId: "cancelled-execution", lastStepIndex: 0,
        terminationReason: 2, proceededWithAutoContinue: false }]);
      expect(after.native.steps).toEqual(before.native.steps);
      expect(after.native.revision).not.toBe(before.native.revision);
      expect(JSON.stringify(after)).not.toContain("private-native-config");
    } finally { f.close(); }
  });
  it("fails closed on a changed executor field wire type", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, "cancelled"), field(9, "execution")));
      await expect(f.read()).rejects.toThrow("antigravity_native_field_type_changed");
    } finally { f.close(); }
  });
  it("hashes ID-less executor rows without treating their protobuf defaults as cancellation evidence", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId); f.step(parent, 0, 15, 3, response());
      const before = await f.read();
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, 2), field(3, 0)));
      const after = await f.read();
      expect(after.native.steps).toEqual(before.native.steps); expect(after.native.executions).toEqual([]);
      expect(after.native.revision).not.toBe(before.native.revision);
    } finally { f.close(); }
  });
  it("classifies a missing executor table as unsupported native format", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId); parent.exec("DROP TABLE executor_metadata");
      await expect(f.read().catch(error => { throw antigravityReadError(error); }))
        .rejects.toMatchObject({ backendCode: "antigravity_history_executor_format_unsupported", crossedSubmissionBoundary: false });
    } finally { f.close(); }
  });
  it("still rejects malformed executor indices rather than treating them as absent proof", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(9, "execution"), field(3, 4294967294)));
      await expect(f.read()).rejects.toThrow("antigravity_history_executor_format_unsupported");
    } finally { f.close(); }
  });
  it("omits the complete executor proof set when row capacity is exceeded, preserving step history", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      f.step(parent, 0, 15, 3, response());
      parent.exec("WITH RECURSIVE records(idx) AS (SELECT 0 UNION ALL SELECT idx + 1 FROM records WHERE idx < 100000) INSERT INTO executor_metadata SELECT idx, X'00' FROM records");
      const history = await f.read(); expect(history.native.steps).toHaveLength(1); expect(history.native.executions).toEqual([]);
    } finally { f.close(); }
  });
  it.each(["one oversized row", "aggregate bytes"])("omits all executor receipts before decoding %s, including otherwise valid cancellation proof", async kind => {
    const f = await fixture();
    try {
      const parent = f.create(parentId);
      f.step(parent, 0, 15, 3, response());
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, 2), field(9, "execution")));
      const insert = parent.prepare("INSERT INTO executor_metadata VALUES (?, zeroblob(?))");
      if (kind === "one oversized row") insert.run(1, 8 * 1024 * 1024 + 1);
      else for (let index = 1; index <= 5; index++) insert.run(index, 7 * 1024 * 1024);
      const history = await f.read(); expect(history.native.steps).toHaveLength(1); expect(history.native.executions).toEqual([]);
    } finally { f.close(); }
  });
  it("does not let executor rows consume the root and child step budget", async () => {
    const f = await fixture();
    try {
      const parent = f.create(parentId), child = f.create(childId, parentId);
      f.step(parent, 0, 132, 3, generic("invoke_subagent", field(2, proto(field(1, childId), field(3, pathToFileURL(f.root).href))), "InvokeSubagent"));
      parent.prepare("WITH RECURSIVE records(idx) AS (SELECT 1 UNION ALL SELECT idx + 1 FROM records WHERE idx < 99998) INSERT INTO steps SELECT idx, 15, 3, 0, 0, ? FROM records").run(response());
      parent.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(proto(field(1, 2), field(9, "execution")));
      f.step(child, 0, 15, 3, response());
      const history = await f.read();
      expect(history.native.steps).toHaveLength(99999);
      expect(history.native.steps[0]?.subagents).toMatchObject([{ sessionId: childId, state: "terminal" }]);
    } finally { f.close(); }
  });
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
    const history = { revision: "a".repeat(64), executions: [], steps: [task] };
    expect(antigravityNativeActivity(history)).toMatchObject({ active: true, foregroundActive: false, pendingContinuations: true, other: 1 });
    history.steps.push(wake); expect(antigravityNativeActivity(history)).toMatchObject({ active: true, foregroundActive: true });
    history.steps.push(final); expect(antigravityNativeActivity(history)).toMatchObject({ active: false, unknown: false, pendingContinuations: false, other: 0 });
    const cancelled = { ...task, schedule: { mode: "timer", outcome: "cancelled", iterations: 0 } };
    expect(antigravityNativeActivity({ ...history, steps: [cancelled] })).toMatchObject({ active: false, pendingContinuations: false });
  });
  it.each(["child", "timer"] as const)("keeps a %s wake outstanding through a response that still calls tools", kind => {
    const launch: AntigravityNativeStep = { index: 0, type: 132, status: 3, hasSubtrajectory: false,
      ...(kind === "child" ? { subagents: [{ sessionId: childId, state: "terminal" as const }] } : {
        task: { id: childId, title: "Timer", description: "", daemon: false }, schedule: { mode: "timer", outcome: "fired", iterations: 0 } }) };
    const wake: AntigravityNativeStep = { index: 1, type: 101, status: 3, hasSubtrajectory: false,
      continuation: { id: "wake", recipient: parentId, sender: childId, kind: "task_notification", content: "done" } };
    const calling: AntigravityNativeStep = { index: 2, type: 15, status: 3, hasSubtrajectory: false,
      response: { text: "", thinking: "", stopReason: 2, toolCalls: [{ id: "follow-up", name: "run_command", argumentsJson: "{}" }] } };
    const history = { revision: "a".repeat(64), executions: [], steps: [launch, wake, calling] };
    expect(antigravityNativeActivity(history)).toMatchObject({ active: true, pendingContinuations: true });
    history.steps.push({ ...calling, index: 3, response: { ...calling.response!, toolCalls: [] } });
    expect(antigravityNativeActivity(history)).toMatchObject({ active: false, pendingContinuations: false });
  });
  it.each([11, 13, 16])("preserves explicit error/cancel response reason %s as terminal wake evidence", stopReason => {
    const history = { revision: "a".repeat(64), executions: [], steps: [
      { index: 0, type: 101, status: 3, hasSubtrajectory: false,
        continuation: { id: "wake", recipient: parentId, sender: childId, kind: "task_notification" as const, content: "done" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false,
        response: { text: "", thinking: "", stopReason, toolCalls: [{ id: "not-executed", name: "run_command", argumentsJson: "{}" }] } },
    ] };
    expect(antigravityNativeActivity(history)).toMatchObject({ active: false, pendingContinuations: false });
  });
  it("settles explicit cancelled children without fabricating a completion callback", () => {
    const step: AntigravityNativeStep = { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: childId, state: "cancelled" }] };
    expect(antigravityNativeActivity({ revision: "a".repeat(64), executions: [], steps: [step] })).toMatchObject({ active: false, unknown: false, agents: 0 });
  });
});
