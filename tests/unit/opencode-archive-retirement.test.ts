import type { SessionMessageInfo } from "@opencode/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
const orphan: SessionMessageInfo[] = [
  { id: "msg_imported_user", type: "user", text: "Old request", time: { created: 1 } },
  { id: "msg_imported_tool_step", type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, finish: "tool-calls",
    content: [{ type: "tool", id: "tool_imported_read", name: "read", state: { status: "completed", input: {},
      content: [{ type: "text", text: "Old read result" }] }, time: { created: 2, completed: 3 } }], time: { created: 2, completed: 3 } },
  { id: "msg_imported_assistant", type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
    content: [{ type: "text", text: "Partial response" }], error: { type: "aborted", message: "Aborted" }, time: { created: 4, completed: 5 } },
  { id: "msg_imported_system", type: "system", text: "Later system context", time: { created: 6 } },
];
function fixture() { const f = createOpenCodeConversationFixture({ messages: orphan }); cleanups.push(f.dispose); return f; }
type Fixture = ReturnType<typeof fixture>;
function unresolvedInput(f: Fixture) {
  f.repository.reserveOperation(scope, { applicationThreadId: threadID, connectionProfileId: f.target.binding.connectionProfileId,
    executionEnvironmentId: f.target.binding.executionEnvironmentId, nativeSessionId: f.wire.sessionID,
    applicationOperationId: "unknown-input", operationKind: "submit", nativeInputId: "msg_unknown_input", requestFingerprint: "a".repeat(64),
    requestSource: { kind: "user" }, deadlineAt: null }, Date.now());
  new OpenCodeInputEvidenceRepository(f.repository).begin(scope, threadID, "unknown-input", "submit", "fixture-tracker", "queue");
  f.repository.markDispatched(scope, threadID, "unknown-input", "submit", Date.now());
}
const blockers = ["active", "pending", "child", "shell", "permission", "form"] as const;
function block(f: Fixture, kind: typeof blockers[number]) {
  const id = f.wire.sessionID;
  if (kind === "active") f.wire.setResponse("/api/session/active", 200, { data: { [id]: { type: "running" } } });
  if (kind === "pending") f.wire.setResponse(`/api/session/${id}/inbox`, 200, { data: [{ type: "user", id: "msg_pending", sessionID: id,
    payload: { text: "Pending input" }, delivery: "queue", time: { created: 5 } }] });
  if (kind === "child") {
    f.wire.sessions.push({ ...f.wire.session, id: "ses_child", parentID: id });
    f.wire.setResponse("/api/session/active", 200, { data: { ses_child: { type: "running" } } });
  }
  if (kind === "shell") f.wire.setResponse("/api/shell", 200, { location: { directory: f.wire.directory }, data: [{ id: "sh_running", command: "work",
    cwd: f.wire.directory, shell: "/bin/sh", file: "/tmp/fixture.out", status: "running", metadata: { sessionID: id }, time: { started: 1 } }] });
  if (kind === "permission") f.wire.setResponse(`/api/session/${id}/permission`, 200,
    { data: [{ id: "per_pending", sessionID: id, action: "shell", resources: ["*"] }] });
  if (kind === "form") f.wire.setResponse(`/api/session/${id}/form`, 200,
    { data: [{ id: "frm_pending", sessionID: id, title: "Pending form", fields: [{ key: "answer", type: "string" }] }] });
}

describe("OpenCode archive retirement of incomplete imported history", () => {
  it("releases unloaded client residency for archive without weakening strict policy retirement or changing history", async () => {
    const f = fixture();
    await expect(f.driver.releaseConversationResidency(f.target)).resolves.toBe("busy");
    f.wire.requests.length = 0;
    await expect(f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" })).resolves.toBe("released");
    expect(f.wire.messages).toEqual(orphan);
    expect(f.wire.requests.every(request => request.method === "GET")).toBe(true);
    expect(f.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
    expect(f.runtime.snapshot().references).toBe(0);
    expect(f.client.lifetime.aborted).toBe(false);
  });

  it("retires a loaded disconnected reader for archive while preserving its unresolved historical turn", async () => {
    const f = fixture(), acquired = await f.acquire(), actor = acquired.actor;
    const snapshot = await actor.captureSnapshotState();
    expect(snapshot.timeline.runState).toBe("disconnected");
    expect(Object.values(snapshot.timeline.turnsById).map(turn => turn.status)).toEqual(["in_progress"]);
    expect(actor.canEvict).toBe(false);
    expect(actor.canRetireForArchive).toBe(true);
    expect((await f.handle()).archiveRetirementSafe).toBe(true);
    acquired.release();
    const operation = vi.fn(async () => f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" }));
    await expect(f.manager.runWithRuntimeRetired({ scope, applicationThreadId: threadID, disposition: { kind: "archive" },
      detachCoordinatorRuntime: async () => {}, operation })).resolves.toBe("released");
    expect(operation).toHaveBeenCalledOnce(); expect(actor.closed).toBe(true);
    expect(f.wire.messages).toEqual(orphan); expect(f.interrupts()).toEqual([]);
    const restored = await f.acquire();
    expect(restored.actor.timeline.runState).toBe("disconnected");
    expect(Object.values(restored.actor.timeline.turnsById).map(turn => turn.status)).toEqual(["in_progress"]);
    restored.release();
  });

  it.each(blockers)("refuses both loaded and unloaded archive when native %s work remains", async kind => {
    const f = fixture(); block(f, kind);
    await expect(f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" })).resolves.toBe("busy");
    const acquired = await f.acquire();
    expect((await f.handle()).archiveRetirementSafe).toBe(false);
    expect(acquired.actor.canRetireForArchive).toBe(false); acquired.release();
    expect(f.interrupts()).toEqual([]);
  });

  it("retains unknown Sedes input ownership even when native inventories are empty", async () => {
    const f = fixture(), handle = await f.driver.attach(f.target); cleanups.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(handle.archiveRetirementSafe).toBe(true);
    unresolvedInput(f);
    expect(handle.archiveRetirementSafe).toBe(false);
    await expect(f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" })).resolves.toBe("busy");
  });

  it("reads activity after inbox so promotion cannot combine an empty inbox with old inactivity", async () => {
    const f = fixture(), hold = f.wire.hold(`/api/session/${f.wire.sessionID}/inbox`);
    const release = f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" });
    await hold.entered;
    expect(f.wire.requests.some(request => request.pathname === "/api/session/active")).toBe(false);
    block(f, "active"); hold.release();
    await expect(release).resolves.toBe("busy");
  });

  it.each(["read failure", "malformed inventory", "runtime replacement"])("keeps archive closed after %s", async failure => {
    const f = fixture();
    if (failure === "read failure") f.wire.setResponse(`/api/session/${f.wire.sessionID}/inbox`, 503, {});
    if (failure === "malformed inventory") f.wire.setResponse("/api/session/active", 200, { data: { broken: { type: "idle" } } });
    if (failure === "runtime replacement") vi.mocked(f.runtime.assertCurrent).mockRejectedValue(new OpenCodeRuntimeError("opencode_runtime_identity_changed"));
    await expect(f.driver.releaseConversationResidency({ ...f.target, purpose: "archive" })).resolves.toBe("busy");
    expect(f.runtime.snapshot().references).toBe(0); expect(f.interrupts()).toEqual([]);
  });

  it.each(["activity event", "observation loss", "read failure", "generation change"])("invalidates loaded archive proof after %s", async change => {
    const f = fixture(), handle = await f.driver.attach(f.target); cleanups.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(handle.archiveRetirementSafe).toBe(true);
    if (change === "activity event") {
      block(f, "active");
      f.wire.send({ id: "evt_execution_started", type: "session.execution.started", created: 5,
        data: { sessionID: f.wire.sessionID }, durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 } });
    } else if (change === "observation loss") f.wire.disconnect();
    else if (change === "generation change") {
      const snapshot = f.runtime.snapshot(); vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, generation: "replaced" });
    } else {
      f.wire.setResponse(`/api/session/${f.wire.sessionID}/message`, 503, {});
      await expect(handle.establishProjection({ signal: new AbortController().signal })).rejects.toBeDefined();
    }
    await vi.waitFor(() => expect(handle.archiveRetirementSafe).toBe(false));
  });

  it.each(["child", "shell"] as const)("renews the full archive proof after observed %s work settles", async kind => {
    const f = fixture();
    if (kind === "child") f.wire.sessions.push({ ...f.wire.session, id: "ses_child", parentID: f.wire.sessionID });
    const handle = await f.driver.attach(f.target); cleanups.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(handle.archiveRetirementSafe).toBe(true);
    const shell = { id: "sh_activity", command: "work", cwd: f.wire.directory, shell: "/bin/sh", file: "/tmp/fixture.out",
      status: "running", metadata: { sessionID: f.wire.sessionID }, time: { started: 7 } };
    if (kind === "child") {
      f.wire.setResponse("/api/session/active", 200, { data: { ses_child: { type: "running" } } });
      f.wire.send({ id: "evt_child_started", type: "session.execution.started", created: 7, data: { sessionID: "ses_child" },
        durable: { aggregateID: "ses_child", seq: 1, version: 1 } });
    } else {
      f.wire.setResponse("/api/shell", 200, { location: { directory: f.wire.directory }, data: [shell] });
      f.wire.send({ id: "evt_shell_created", type: "shell.created", created: 7, data: { info: shell } });
    }
    await vi.waitFor(() => expect(handle.archiveRetirementSafe).toBe(false));
    // Wait until the first inventory is consumed, then publish a separate end.
    await handle.history({ limit: 10 });
    const pendingReads = f.wire.requests.filter(request => request.pathname.endsWith("/inbox")).length;
    if (kind === "child") {
      f.wire.setResponse("/api/session/active", 200, { data: {} });
      f.wire.send({ id: "evt_child_completed", type: "session.execution.succeeded", created: 8, data: { sessionID: "ses_child" },
        durable: { aggregateID: "ses_child", seq: 2, version: 1 } });
    } else {
      f.wire.setResponse("/api/shell", 200, { location: { directory: f.wire.directory }, data: [{ ...shell, status: "exited", exit: 0,
        time: { started: 7, completed: 8 } }] });
      f.wire.send({ id: "evt_shell_completed", type: "shell.exited", created: 8, data: { id: shell.id, status: "exited", exit: 0 } });
    }
    await vi.waitFor(() => expect(handle.archiveRetirementSafe).toBe(true));
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/inbox")).length).toBeGreaterThan(pendingReads);
    expect(Object.values((await handle.history({ limit: 10 })).turnsById).map(turn => turn.status)).toEqual(["in_progress"]);
  });
});
