import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import type { SessionMessageInfo } from "@opencode/client";
import type { ConversationActorEvent } from "../../src/server/conversations/conversation-actor.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(input: Parameters<typeof createOpenCodeConversationFixture>[0] = {}) {
  const current = createOpenCodeConversationFixture(input);
  cleanup.push(current.dispose);
  return current;
}

function completedMessages(turns: number): SessionMessageInfo[] {
  return Array.from({ length: turns }, (_, index) => [
    { id: `msg_user_${index}`, type: "user", text: `Question ${index}`, time: { created: index * 3 + 1 } },
    { id: `msg_assistant_${index}`, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
      content: [{ type: "text", text: `Answer ${index}` }], time: { created: index * 3 + 2, completed: index * 3 + 2 } },
    { id: `msg_idle_${index}`, type: "idle", outcome: "succeeded", time: { created: index * 3 + 3 } },
  ] as SessionMessageInfo[]).flat();
}

describe("OpenCode driver through the shared conversation actor", () => {
  it("publishes native control before slow initial history and admits Stop before releasing that read", async () => {
    const current = fixture({ messages: completedMessages(1) });
    const gate = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    let completed = false;
    const acquisition = current.acquire().then(value => { completed = true; return value; });
    await gate.entered;
    const borrowed = current.manager.acquireExistingControl(scope, threadID);
    expect(borrowed).toBeDefined(); expect(completed).toBe(false);
    try {
      await borrowed!.control.interrupt({ applicationOperationId: "stop-before-history", deadlineAt: Date.now() + 30_000 });
      expect(current.interrupts()).toHaveLength(1); expect(completed).toBe(false);
      expect(current.manager.acquireExistingControl({ ...scope, principalId: "foreign" }, threadID)).toBeUndefined();
    } finally { borrowed!.release(); gate.release(); }
    const acquired = await acquisition;
    expect(acquired.actor.timeline.runState).toBe("idle"); expect(current.attached).toHaveBeenCalledOnce();
    acquired.release();
  });

  it("retains control and the same handle after failed initial hydration, then recovers on explicit acquisition", async () => {
    const current = fixture({ messages: completedMessages(1) });
    const messages = `/api/session/${current.wire.sessionID}/message`;
    current.wire.setResponse(messages, 503, { message: "fixture unavailable" });
    await expect(current.acquire()).rejects.toBeInstanceOf(Error);
    const borrowed = current.manager.acquireExistingControl(scope, threadID);
    expect(borrowed).toBeDefined();
    try {
      await borrowed!.control.interrupt({ applicationOperationId: "stop-after-failed-hydration", deadlineAt: Date.now() + 30_000 });
      expect(current.interrupts()).toHaveLength(1);
      expect(current.runtime.snapshot().references).toBe(2);
    } finally { borrowed!.release(); }
    current.wire.clearResponse(messages);
    const recovered = await current.acquire();
    expect(recovered.actor.projectionRecoveryRequired).toBe(false);
    expect(recovered.actor.timeline.orderedTurnIds).toHaveLength(1);
    expect(current.attached).toHaveBeenCalledOnce();
    expect(current.environmentRelease).not.toHaveBeenCalled();
    recovered.release();
  });

  it("revokes control and observes raw provider_handle_closed during uncompleted hydration", async () => {
    const current = fixture(); const gate = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const acquisition = current.acquire(); const failed = expect(acquisition).rejects.toBeInstanceOf(Error);
    await gate.entered;
    const handle = await current.handle(); const raw: BackendConversationEvent[] = []; handle.subscribe(event => raw.push(event));
    const borrowed = current.manager.acquireExistingControl(scope, threadID)!;
    current.client.close();
    // Manager cleanup drains borrowed controls before retiring the actor.
    borrowed.release(); await failed; gate.release();
    expect(raw).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
    expect(borrowed.control.lifetime.aborted).toBe(true);
    expect(current.manager.acquireExistingControl(scope, threadID)).toBeUndefined();
    expect(current.runtime.snapshot().references).toBe(0);
    expect(current.interrupts()).toHaveLength(0);
  });

  it.each(["moved", "deleted"])("revokes a %s session's bound control without retiring its native owner", async kind => {
    const current = fixture({ messages: completedMessages(1) }); const acquired = await current.acquire();
    const handle = await current.handle();
    const raw: BackendConversationEvent[] = []; handle.subscribe(event => raw.push(event));
    const borrowed = current.manager.acquireExistingControl(scope, threadID)!;
    try {
      if (kind === "moved") current.wire.session.location = { directory: "/fixture/other-workspace" };
      else current.wire.setResponse(`/api/session/${current.wire.sessionID}`, 404,
        { _tag: "SessionNotFoundError", sessionID: current.wire.sessionID, message: "fixture missing" });
      current.wire.send({ id: `evt_${kind}`, type: `session.${kind}`, created: 2,
        durable: { aggregateID: current.wire.sessionID, seq: 1, version: kind === "deleted" ? 2 : 1 },
        data: { sessionID: current.wire.sessionID, ...(kind === "moved"
          ? { location: current.wire.session.location, projectID: current.wire.session.projectID } : {}) } });
      await vi.waitFor(() => expect(borrowed.control.lifetime.aborted).toBe(true));
      expect(raw).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
      expect(acquired.actor.replacementRequired).toBe(true);
      expect(current.manager.acquireExistingControl(scope, threadID)).toBeUndefined();
      await expect(borrowed.control.interrupt({ applicationOperationId: `stop-after-${kind}`, deadlineAt: Date.now() + 30_000 })).rejects.toBeInstanceOf(Error);
      expect(current.runtime.snapshot()).toMatchObject({ state: "ready", references: 0, generation: "native-generation" });
      expect(current.client.lifetime.aborted).toBe(false); expect(current.interrupts()).toHaveLength(0);
    } finally { borrowed.release(); acquired.release(); }
  });

  it("rejects Stop before native dispatch when the location changed without an observed SSE event", async () => {
    const current = fixture({ messages: completedMessages(1) }); const acquired = await current.acquire();
    const borrowed = current.manager.acquireExistingControl(scope, threadID)!;
    const operation = { applicationOperationId: "stop-after-missed-move", deadlineAt: Date.now() + 30_000 };
    try {
      current.wire.session.location = { directory: "/fixture/other-workspace" };
      await expect(borrowed.control.interrupt(operation)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
      await expect(borrowed.control.reconcileInterrupt(operation)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
      expect(borrowed.control.lifetime.aborted).toBe(true);
      expect(acquired.actor.replacementRequired).toBe(true);
      expect(current.manager.acquireExistingControl(scope, threadID)).toBeUndefined();
      expect(current.interrupts()).toHaveLength(0); expect(current.client.lifetime.aborted).toBe(false);
    } finally { borrowed.release(); acquired.release(); }
  });

  it("cancels an actor retained-history request while independent control remains usable", async () => {
    const current = fixture({ messages: completedMessages(1) }); const acquired = await current.acquire();
    const abort = new AbortController();
    const history = acquired.actor.history({ limit: 10, signal: abort.signal });
    const failed = expect(history).rejects.toBeInstanceOf(Error);
    abort.abort();
    const borrowed = current.manager.acquireExistingControl(scope, threadID)!;
    try {
      await borrowed.control.interrupt({ applicationOperationId: "stop-during-history", deadlineAt: Date.now() + 30_000 });
      await failed;
      expect(current.interrupts()).toHaveLength(1);
      expect(borrowed.control.lifetime.aborted).toBe(false);
    } finally { borrowed.release(); acquired.release(); }
  });

  it("reacquires a truthful bounded snapshot after SSE EOF without replacing the native owner", async () => {
    const current = fixture({ messages: completedMessages(25) }); const acquired = await current.acquire();
    const initial = await acquired.actor.captureSnapshotState();
    const publications: ConversationActorEvent[] = []; acquired.actor.subscribe(event => publications.push(event));
    expect(initial.timeline.orderedTurnIds).toHaveLength(10); expect(initial.history?.previousCursor).toBeDefined();
    const older = await acquired.actor.history({ limit: 10, cursor: initial.history!.previousCursor! });
    expect(older.page.orderedTurnIds).toHaveLength(10);
    current.wire.disconnect();
    await vi.waitFor(() => expect(publications.filter(event => event.type === "projection_replaced")).toHaveLength(2));
    const recovered = await acquired.actor.captureSnapshotState();
    expect(recovered.timeline.generation).not.toBe(initial.timeline.generation);
    expect(recovered.timeline.orderedTurnIds).toEqual(initial.timeline.orderedTurnIds);
    expect(acquired.actor.projectionRecoveryRequired).toBe(false);
    expect(current.attached).toHaveBeenCalledOnce(); expect(current.runtime.snapshot()).toMatchObject({ generation: "native-generation", references: 2 });
    // The resident owner reconnects its single native stream; input evidence and
    // presentation subscribe independently to that shared observation hub.
    expect(current.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(2);
    expect(current.interrupts()).toHaveLength(0); acquired.release();
  });

  it("recovers through the actual actor after SSE overflow while a history read holds projection", async () => {
    const current = fixture({ messages: completedMessages(1) }); const acquired = await current.acquire();
    const initial = await acquired.actor.captureSnapshotState();
    const raw: BackendConversationEvent[] = []; (await current.handle()).subscribe(event => raw.push(event));
    const gate = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const history = (await current.handle()).establishProjection({ signal: new AbortController().signal });
    const rejected = expect(history).rejects.toBeInstanceOf(Error);
    await gate.entered;
    try {
      for (let index = 1; index <= 4_097; index++) current.wire.send({ id: `evt_overflow_${index}`,
        type: "session.renamed", created: index, durable: { aggregateID: current.wire.sessionID, seq: index, version: 1 },
        data: { sessionID: current.wire.sessionID, title: `Fixture ${index}` } });
      await vi.waitFor(() => expect(raw).toContainEqual({ type: "resnapshot_required", reason: "buffer_overflow" }));
    } finally { gate.release(); }
    await rejected;
    await vi.waitFor(() => expect(acquired.actor.projectionRecoveryRequired).toBe(false));
    const recovered = await acquired.actor.captureSnapshotState();
    expect(recovered.timeline.generation).not.toBe(initial.timeline.generation);
    expect(recovered.timeline.orderedTurnIds).toEqual(initial.timeline.orderedTurnIds);
    expect(current.runtime.snapshot()).toMatchObject({ state: "ready", references: 2, generation: "native-generation" });
    expect(current.attached).toHaveBeenCalledOnce(); expect(current.interrupts()).toHaveLength(0);
    acquired.release();
  });

  it("evicts the idle presentation while retaining the owner and background shell, with strict residency release", async () => {
    const current = fixture({ retentionMilliseconds: 0 });
    const shell = { id: "sh_background", status: "running", command: "sleep 60", cwd: current.wire.directory,
      shell: "/bin/sh", file: "/fixture/output", metadata: { sessionID: current.wire.sessionID }, time: { started: 1 } };
    current.wire.setResponse("/api/shell", 200, { location: { directory: current.wire.directory }, data: [shell] });
    const acquired = await current.acquire();
    expect(acquired.actor.timeline.backgroundActivity).toMatchObject({ state: "known", commands: 1 });
    expect(acquired.actor.canAutomaticallyEvict).toBe(true); expect(acquired.actor.canEvict).toBe(false);
    acquired.release();
    await vi.waitFor(() => expect(acquired.actor.closed).toBe(true));
    expect(current.runtime.snapshot()).toMatchObject({ state: "ready", references: 0, generation: "native-generation" });
    expect(current.environmentRelease).toHaveBeenCalledOnce(); expect(current.client.lifetime.aborted).toBe(false);
    await expect(current.driver.releaseConversationResidency!(current.target)).resolves.toBe("busy");
    current.wire.setResponse("/api/shell", 200, { location: { directory: current.wire.directory }, data: [{ ...shell, status: "exited", time: { started: 1, completed: 2 }, exit: 0 }] });
    await expect(current.driver.releaseConversationResidency!(current.target)).resolves.toBe("released");
    expect(current.interrupts()).toHaveLength(0); expect(current.client.lifetime.aborted).toBe(false);
  });

  it("preserves unknown residency after failed activity refresh without native cancellation", async () => {
    const current = fixture();
    current.wire.setResponse("/api/shell", 503, { message: "fixture unavailable" });
    await expect(current.driver.releaseConversationResidency!(current.target)).resolves.toBe("busy");
    expect(current.interrupts()).toHaveLength(0); expect(current.client.lifetime.aborted).toBe(false);
  });
});
