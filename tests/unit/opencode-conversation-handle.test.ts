import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, SessionMessageInfo } from "@opencode/client";
import type { BackendConversationEvent, SequencedBackendEvent } from "../../src/shared/protocol/backend.js";
import { backendCapabilityDocumentSchema } from "../../src/shared/protocol/backend.js";
import { OpenCodeHistoryProjection, openCodeHistoryItemId } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { OPENCODE_HISTORY_LIMITS } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OPENCODE_MAXIMUM_RESPONSE_BYTES } from "../../src/server/backends/opencode/opencode-http-client.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(messages: SessionMessageInfo[] = [], wire?: ReturnType<typeof createOpenCodeApiFixture>) {
  const fixture = createOpenCodeConversationFixture({ messages, ...(wire ? { wire } : {}) }); cleanup.push(fixture.dispose); return fixture;
}
async function attached(messages: SessionMessageInfo[] = []) {
  const fixture = setup(messages); const handle = await fixture.driver.attach(fixture.target); cleanup.push(() => handle.close());
  return { ...fixture, handle };
}
const user = (id = "msg_user"): SessionMessageInfo => ({ id, type: "user", text: "Question", time: { created: 1 } });
const assistant = (content: Extract<SessionMessageInfo, { type: "assistant" }>["content"] = [{ type: "text", text: "" }]): Extract<SessionMessageInfo, { type: "assistant" }> => ({
  id: "msg_assistant", type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, time: { created: 2 }, content,
});
const idle = (id = "msg_idle"): SessionMessageInfo => ({ id, type: "idle", outcome: "succeeded", time: { created: 3 } });
const signal = () => new AbortController().signal;
let eventNumber = 0;
const durableSequences = new Map<string, number>();
function event(type: string, data: Record<string, unknown>, durable = false) {
  const index = ++eventNumber, aggregateID = typeof data.sessionID === "string" ? data.sessionID : "ses_fixture";
  const seq = (durableSequences.get(aggregateID) ?? 0) + 1;
  if (durable) durableSequences.set(aggregateID, seq);
  return { id: `evt_handle_${index}`, created: index, type, data: { sessionID: "ses_fixture", ...data },
    ...(durable ? { durable: { aggregateID, seq, version: 1 } } : {}) };
}
function textEvent(kind: "text" | "reasoning", phase: "delta" | "ended", text: string, ordinal = 0) {
  return event(`session.${kind}.${phase}`, { assistantMessageID: "msg_assistant", ordinal, [phase === "delta" ? "delta" : "text"]: text }, phase === "ended");
}
function textOf(events: SequencedBackendEvent[], kind: "assistant_message" | "reasoning") {
  return events.flatMap(({ event: value }) => "item" in value && value.item.semanticKind === kind ? [value.item.markdown.text] : []).at(-1);
}

describe("OpenCode conversation authority and finite discovery", () => {
  it("publishes current context and full-session counters independently of recorded accounting", async () => {
    const tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 200, write: 50 } };
    const messages = Array.from({ length: 12 }, (_, index) => [user(`msg_user_${index}`),
      { ...assistant([{ type: "text", text: "Done" }]), id: `msg_answer_${index}`, tokens, time: { created: 2, completed: 3 } }, idle(`msg_idle_${index}`)]).flat();
    const current = await attached(messages);
    const model: ModelInfo = { providerID: "fixture", id: "fixture", modelID: "fixture", name: "Fixture", package: "fixture", enabled: true, status: "active",
      capabilities: { input: ["text"], output: ["text"], tools: true }, variants: [], time: { released: 0 }, cost: [], limit: { context: 1_000, output: 100 } };
    current.wire.setResponse("/api/model", 200, { location: { directory: current.wire.directory }, data: [model] });
    current.wire.setResponse("/api/model/default", 200, { location: { directory: current.wire.directory }, data: model });
    const expected = { context: { usedTokens: 400, windowTokens: 1_000, percent: 40 },
      counters: { userMessages: 12, assistantMessages: 12, totalMessages: 24, toolCalls: 0, toolResults: 0, compactions: 0 } };
    expect(current.context.usage.enabled).toBe(false);
    const established = await current.handle.establishProjection({ signal: signal() });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(await current.handle.usage()).toEqual(expected);
    expect((await current.handle.backendCapabilities()).usageSections).toEqual(["context", "counters"]);
    const events: SequencedBackendEvent[] = [];
    established.subscribeFromNext(value => events.push(value));
    current.wire.messages.push(user("msg_new"), { ...assistant([{ type: "text", text: "Next" }]),
      tokens: { ...tokens, input: 200 }, time: { created: 4, completed: 5 } }, idle("msg_new_idle"));
    current.wire.send(event("session.step.ended", { assistantMessageID: "msg_assistant", finish: "stop", cost: 0, tokens: { ...tokens, input: 200 } }, true));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: { type: "usage_changed", usage: {
      context: { usedTokens: 500, windowTokens: 1_000, percent: 50 },
      counters: { ...expected.counters, userMessages: 13, assistantMessages: 13, totalMessages: 26 },
    } } })));
    const live = await current.handle.usage();
    expect((await current.driver.read(current.target)).usage).toEqual(live);
    // Neither paginating the display nor replaying a step adds message counts.
    await current.handle.history({ limit: 10, cursor: established.history.previousCursor, signal: signal() });
    expect(await current.handle.usage()).toEqual(live);
  });
  it("keeps transcript counters available when the native model catalog is unavailable", async () => {
    const current = await attached([user(), assistant(), idle()]);
    await current.handle.establishProjection({ signal: signal() });
    expect(await current.handle.usage()).toMatchObject({ counters: { totalMessages: 2, userMessages: 1, assistantMessages: 1 } });
    expect((await current.handle.usage()).context).toBeUndefined();
  });
  it("keeps transcript establishment alive when the meter catalog stalls", async () => {
    const current = await attached([user(), assistant(), idle()]);
    const held = current.wire.hold("/api/model");
    // Exercise the real fetch cancellation with a short wall-clock timeout;
    // the history's independent 60s budget remains untouched.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 5_000 ? 20 : ms));
    try {
      const projection = await current.handle.establishProjection({ signal: signal() });
      expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(1);
      expect(await current.handle.usage()).toMatchObject({ counters: { totalMessages: 2 } });
      expect((await current.handle.usage()).context).toBeUndefined();
      expect(deadlines).toHaveBeenCalledWith(5_000);
    } finally { held.release(); }
  });
  it("replaces the meter on native model selection, clears failed reads, and recovers after invalidation", async () => {
    const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
    const current = await attached([user(), { ...assistant(), tokens, time: { created: 2, completed: 3 } }, idle()]);
    const model: ModelInfo = { providerID: "fixture", id: "fixture", modelID: "fixture", name: "Fixture", package: "fixture", enabled: true, status: "active",
      capabilities: { input: ["text"], output: ["text"], tools: true }, variants: [], time: { released: 0 }, cost: [], limit: { context: 1_000, output: 100 } };
    const next = { ...model, id: "next", modelID: "next", limit: { context: 2_000, output: 100 } };
    current.wire.setResponse("/api/model", 200, { location: { directory: current.wire.directory }, data: [model, next] });
    current.wire.setResponse("/api/model/default", 200, { location: { directory: current.wire.directory }, data: model });
    const established = await current.handle.establishProjection({ signal: signal() });
    const counters = (await current.handle.usage()).counters;
    expect((await current.handle.usage()).context?.usedTokens).toBe(120);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    current.wire.session.model = { providerID: "fixture", id: "next" };
    current.wire.send(event("session.model.selected", { model: current.wire.session.model }, true));
    const nextUsage = { context: { windowTokens: 2_000 }, counters };
    await vi.waitFor(async () => expect(await current.handle.usage()).toEqual(nextUsage));
    expect(events.filter(value => value.type === "usage_changed")).toEqual([{ type: "usage_changed", usage: nextUsage }]);
    current.wire.setResponse("/api/model", 503, {});
    await current.handle.backendCapabilities();
    expect(await current.handle.usage()).toEqual({ counters });
    current.wire.setResponse("/api/model", 200, { location: { directory: current.wire.directory }, data: [model, next] });
    const gap = event("session.model.selected", { model: current.wire.session.model }, true);
    current.wire.send({ ...gap, durable: { ...gap.durable!, seq: gap.durable!.seq + 1 } });
    await vi.waitFor(() => expect(events.some(value => value.type === "resnapshot_required")).toBe(true));
    expect(await current.handle.usage()).toEqual({});
    await current.handle.establishProjection({ signal: signal() });
    expect(await current.handle.usage()).toEqual(nextUsage);
  });
  it("declares throughput unsupported and does not infer request timing from completed history", async () => {
    const current = await attached([user(), { ...assistant([{ type: "text", text: "Done" }]),
      time: { created: 2, completed: 3 } }, idle()]);
    const capabilities = backendCapabilityDocumentSchema.parse(await current.handle.backendCapabilities());
    expect(capabilities.turnThroughput).toBe("unsupported");
    const { snapshot } = await current.handle.establishProjection({ signal: signal() });
    const turns = Object.values(snapshot.turnsById);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "completed" });
    expect(turns[0]?.throughput).toBeUndefined();
  });
  it.each(["replay", "reconcile"] as const)("retries a lost terminal Stop ACK on %s without interrupting again", async mode => {
    const current = setup(); const acquire = vi.mocked(current.runtime.acquire).getMockImplementation()!;
    let lose = true;
    vi.mocked(current.runtime.acquire).mockImplementation(target => {
      const lease = acquire(target);
      return { ...lease, client: { ...lease.client, acknowledgeOperation: async identity => {
        if (lose && identity.operationKind === "interrupt") { lose = false; throw new Error("ACK response lost"); }
        await lease.client.acknowledgeOperation(identity);
      } } };
    });
    const handle = await current.driver.attach(current.target); cleanup.push(() => handle.close());
    const input = { applicationOperationId: "lost-terminal-stop-ack", deadlineAt: Date.now() + 30_000 };
    await handle.interrupt(input); expect(current.host.snapshot().operations).toHaveLength(1);
    if (mode === "replay") await handle.interrupt(input);
    else await expect(handle.reconcileInterrupt(input)).resolves.toEqual({ outcome: "accepted" });
    expect(current.host.snapshot().operations).toEqual([]); expect(current.interrupts()).toHaveLength(1);
  });
  it("publishes an actionable unavailable CLI diagnostic without replacing ordinary conversation controls", async () => {
    const current = await attached();
    vi.spyOn(current.context.executionEnvironment, "diagnostic").mockReturnValue("Sedes CLI tools are unavailable; messages remain available.");
    const events: BackendConversationEvent[] = [];
    const projection = await current.handle.establishProjection({ signal: signal() });
    const unsubscribe = projection.subscribeFromNext(value => events.push(value.event));
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", notice: expect.objectContaining({
      id: "opencode-tools-unavailable", tone: "warning", message: expect.objectContaining({ text: "Sedes CLI tools are unavailable; messages remain available." }),
    }) }));
    await current.handle.interrupt({ applicationOperationId: "cli-diagnostic-stop", deadlineAt: Date.now() + 1_000 });
    expect(current.interrupts()).toHaveLength(1); unsubscribe();
  });
  it("keeps an accepted Stop private receipt across handle replacement without interrupting later work", async () => {
    const current = await attached();
    const operation = { applicationOperationId: "stop-private-replay", deadlineAt: Date.now() + 30_000 };
    await current.handle.interrupt(operation);
    expect(current.interrupts()).toHaveLength(1);
    await current.handle.close();
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const replacement = await current.driver.attach(current.target); cleanup.push(() => replacement.close());
    expect(await replacement.reconcileInterrupt(operation)).toEqual({ outcome: "accepted" });
    await replacement.interrupt(operation);
    expect(current.interrupts()).toHaveLength(1);
    await expect(replacement.interrupt({ ...operation, deadlineAt: operation.deadlineAt + 1 })).rejects.toBeInstanceOf(Error);
    expect(current.interrupts()).toHaveLength(1);
  });
  it("does not retry an uncertain native Stop on a replacement handle", async () => {
    const current = await attached();
    current.wire.setResponse(`/api/session/${current.wire.sessionID}/interrupt`, 500, { error: "lost native reply" });
    const operation = { applicationOperationId: "stop-unknown-replay", deadlineAt: Date.now() + 30_000 };
    await expect(current.handle.interrupt(operation)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await current.handle.close();
    const replacement = await current.driver.attach(current.target); cleanup.push(() => replacement.close());
    expect(await replacement.reconcileInterrupt(operation)).toEqual({ outcome: "unknown" });
    current.wire.clearResponse(`/api/session/${current.wire.sessionID}/interrupt`);
    await expect(replacement.interrupt(operation)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(current.interrupts()).toHaveLength(1);
    await replacement.interrupt({ applicationOperationId: "fresh-stop", deadlineAt: Date.now() + 30_000 });
    expect(current.interrupts()).toHaveLength(2);
  });
  it("reclaims failed Stops beyond the control lane capacity and keeps a fresh Stop deliverable", async () => {
    const current = await attached(); const route = `/api/session/${current.wire.sessionID}/interrupt`;
    current.wire.setResponse(route, 500, { error: "native response failed" });
    for (let index = 0; index < 20; index++) {
      const operation = { applicationOperationId: `failed-stop-${index}`, deadlineAt: Date.now() + 1_000 };
      await expect(current.handle.interrupt(operation)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
      expect(await current.handle.reconcileInterrupt(operation)).toEqual({ outcome: "unknown" });
    }
    expect(current.host.snapshot().operations).toEqual([]);
    current.wire.clearResponse(route);
    await current.handle.interrupt({ applicationOperationId: "working-stop", deadlineAt: Date.now() + 1_000 });
    expect(current.interrupts()).toHaveLength(21); expect(current.host.snapshot().operations).toEqual([]);
  });
  it("defers timed-out Stop receipt release until its native effect settles", async () => {
    const current = await attached(); const held = current.wire.hold(`/api/session/${current.wire.sessionID}/interrupt`);
    const operation = { applicationOperationId: "pending-stop", deadlineAt: Date.now() + 100 };
    const pending = current.handle.interrupt(operation).catch(error => error);
    await held.entered;
    expect(await pending).toMatchObject({ crossedSubmissionBoundary: true });
    expect(await current.handle.reconcileInterrupt(operation)).toEqual({ outcome: "unknown" });
    held.release();
    await vi.waitFor(() => expect(current.host.snapshot().operations).toEqual([]));
    await current.handle.interrupt({ applicationOperationId: "stop-after-timeout", deadlineAt: Date.now() + 1_000 });
    expect(current.interrupts()).toHaveLength(2);
  });
  it("refuses an expired Stop before native mutation and records positive nonapplication", async () => {
    const current = await attached();
    const operation = { applicationOperationId: "expired-stop", deadlineAt: Date.now() - 1 };
    await expect(current.handle.interrupt(operation)).rejects.toBeInstanceOf(Error);
    expect(await current.handle.reconcileInterrupt(operation)).toEqual({ outcome: "not_applied" });
    expect(current.interrupts()).toHaveLength(0);
  });
  it("republishes current native interactions after a fresh projection cut and removes externally resolved gates", async () => {
    const current = await attached();
    const route = `/api/session/${current.wire.sessionID}/permission`;
    current.wire.setResponse(route, 200, { data: [{ id: "per_existing", sessionID: current.wire.sessionID, action: "write", resources: ["file"] }] });
    const projection = await current.handle.establishProjection({ signal: signal() });
    const events: SequencedBackendEvent[] = []; const unsubscribe = projection.subscribeFromNext(value => events.push(value));
    expect(events.filter(value => value.event.type === "interaction_opened")).toHaveLength(1);
    const refreshed = await current.handle.establishProjection({ signal: signal() });
    const later: SequencedBackendEvent[] = []; refreshed.subscribeFromNext(value => later.push(value));
    expect(later.filter(value => value.event.type === "interaction_opened")).toHaveLength(1);
    current.wire.clearResponse(route);
    current.wire.send({ id: "evt_external_permission", type: "permission.replied", created: 2, data: { sessionID: current.wire.sessionID,
      requestID: "per_existing", reply: "once" } });
    await vi.waitFor(() => expect(later.filter(value => value.event.type === "interaction_resolved")).toHaveLength(1));
    expect(events.map(value => value.handleSequence)).toEqual(events.map((_, index) => projection.handleSequence + index + 1));
    expect(later.map(value => value.handleSequence)).toEqual(later.map((_, index) => refreshed.handleSequence + index + 1));
    unsubscribe();
    expect(current.wire.requests.every(request => request.method === "GET")).toBe(true);
  });
  it.each([false, true])("replays external gate settlement across an unsubscribed projection cut (event observed: %s)", async observed => {
    const current = await attached(); const route = `/api/session/${current.wire.sessionID}/permission`;
    current.wire.setResponse(route, 200, { data: [{ id: "per_old", sessionID: current.wire.sessionID, action: "write", resources: ["file"] }] });
    const first = await current.handle.establishProjection({ signal: signal() }); const initial: SequencedBackendEvent[] = [];
    const unsubscribe = first.subscribeFromNext(value => initial.push(value));
    const opened = initial.find(value => value.event.type === "interaction_opened")!;
    unsubscribe(); current.wire.clearResponse(route);
    if (observed) {
      current.wire.send({ id: "evt_detached_permission", type: "permission.replied", created: 2,
        data: { sessionID: current.wire.sessionID, requestID: "per_old", reply: "once" } });
      await vi.waitFor(() => expect(current.wire.requests.filter(request => request.pathname === route).length).toBeGreaterThan(1));
    }
    const fresh = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    fresh.subscribeFromNext(value => events.push(value));
    expect(events.filter(value => value.event.type === "interaction_resolved")).toEqual([{
      handleSequence: fresh.handleSequence + 1, event: { type: "interaction_resolved", backendInteractionId:
        opened.event.type === "interaction_opened" ? opened.event.interaction.backendInteractionId : "unreachable" },
    }]);
    expect(events.some(value => value.event.type === "interaction_opened")).toBe(false);
  });
  it("rejects foreign scope and immutable binding fields before acquiring a runtime", async () => {
    const current = setup();
    for (const change of [{ scope: { ...scope, principalId: "foreign" } },
      { binding: { ...current.target.binding, backendConversationId: "ses_foreign" } },
      { opaqueBindingDetail: JSON.stringify({ ...JSON.parse(current.target.opaqueBindingDetail), nativeNamespaceKey: "foreign" }) },
      { workspace: { ...current.target.workspace, canonicalPath: "/foreign" } }]) {
      await expect(current.driver.attach({ ...current.target, ...change })).rejects.toMatchObject({ category: "permission_denied", crossedSubmissionBoundary: false });
    }
    expect(current.runtime.start).not.toHaveBeenCalled();
    expect(current.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]);
  });
  it("discovers native title/binding and carries a scope-bound opaque cursor without writes", async () => {
    const current = setup(); const input = { scope, workspace: current.target.workspace, signal: signal(), limit: 1 };
    const first = await current.driver.discover(input);
    expect(first.conversations).toHaveLength(1);
    expect(first.conversations[0]).toMatchObject({ backendConversationId: current.wire.sessionID, title: "Fixture", opaqueBindingDetail: current.target.opaqueBindingDetail });
    const end = await current.driver.discover({ ...input, cursor: first.nextCursor });
    expect(end.conversations).toEqual([]); expect(end.nextCursor).toBeUndefined();
    const before = current.wire.requests.length;
    await expect(current.driver.discover({ ...input, workspace: { ...input.workspace, canonicalPath: "/foreign" }, cursor: first.nextCursor })).rejects.toMatchObject({ backendCode: "opencode_discovery_cursor_invalid" });
    expect(current.wire.requests).toHaveLength(before);
    expect(current.wire.requests.every(request => request.method === "GET")).toBe(true);
    expect(current.runtime.snapshot().references).toBe(0);
  });
});

describe("OpenCode SSE and native history composition", () => {
  it("waits for SSE readiness before the first history request", async () => {
    const wire = createOpenCodeApiFixture(), held = wire.hold("/api/event"), fixture = setup([], wire);
    const handle = await fixture.driver.attach(fixture.target); cleanup.push(() => handle.close());
    const current = { ...fixture, handle };
    const read = current.handle.establishProjection({ signal: signal() });
    await held.entered;
    expect(current.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
    held.release();
    expect((await read).snapshot.orderedBackendTurnIds).toEqual([]);
  });
  it("still awaits the same SSE readiness after its first establishment caller cancels", async () => {
    const wire = createOpenCodeApiFixture(), held = wire.hold("/api/event"), fixture = setup([], wire);
    const handle = await fixture.driver.attach(fixture.target); cleanup.push(() => handle.close());
    const current = { ...fixture, handle };
    const cancellation = new AbortController();
    const first = current.handle.establishProjection({ signal: cancellation.signal });
    const rejected = expect(first).rejects.toBeInstanceOf(Error);
    await held.entered; cancellation.abort(); await rejected;
    const second = current.handle.establishProjection({ signal: signal() });
    // Queue one microtask behind the establishment call so its reused-observer
    // path runs before checking that no native history request escaped.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(current.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
    expect(current.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
    held.release(); await second;
    // Input evidence and presentation reuse the same resident native stream.
    expect(current.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
  });
  it("reports maximal-image event overflow while hydration is blocked and recovers authoritative history", async () => {
    const current = await attached([user(), { ...assistant([{ type: "text", text: "Before overflow" }]),
      time: { created: 2, completed: 3 } }, idle()]);
    const initial = await current.handle.establishProjection({ signal: signal() });
    const raw: BackendConversationEvent[] = []; current.handle.subscribe(value => raw.push(value));
    const gate = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const hydration = current.handle.establishProjection({ signal: signal() });
    const rejected = expect(hydration).rejects.toMatchObject({ backendCode: "opencode_history_invalidated" });
    await gate.entered;
    try {
      const data = Buffer.alloc(16 * 1024 * 1024).toString("base64");
      // Each valid native admission fits the 32 MiB frame bound; together they
      // exceed the projection observer's queued-byte limit while its reader waits.
      for (const inboxID of ["msg_native_image_one", "msg_native_image_two"]) {
        current.wire.send(event("session.inbox.enqueued", { inboxID, item: { type: "user", delivery: "queue",
          payload: { text: "Native image input", files: [{ data, mime: "image/png", source: { type: "inline" } }] } } }, true));
      }
      await vi.waitFor(() => expect(raw.filter(value => value.type === "resnapshot_required"))
        .toEqual([{ type: "resnapshot_required", reason: "buffer_overflow" }]), { timeout: 10_000 });
      // Admission events are not transcript proof. The native inbox is now
      // empty; the fresh authoritative transcript determines what is rendered.
      current.wire.messages[1] = { ...assistant([{ type: "text", text: "Recovered native result" }]),
        time: { created: 2, completed: 4 } };
    } finally { gate.release(); }
    await rejected;
    const recovered = await current.handle.establishProjection({ signal: signal() });
    expect(recovered.handleSequence).toBeGreaterThan(initial.handleSequence);
    const stale: SequencedBackendEvent[] = []; initial.subscribeFromNext(value => stale.push(value));
    expect(stale).toMatchObject([{ event: { type: "resnapshot_required", reason: "buffer_overflow" } }]);
    expect(recovered.snapshot.itemsById[openCodeHistoryItemId("msg_assistant", 0)])
      .toMatchObject({ status: "completed", markdown: { text: "Recovered native result" } });
    expect(recovered.snapshot.orderedBackendTurnIds).toEqual(initial.snapshot.orderedBackendTurnIds);
    expect(recovered.snapshot.runState).toBe("idle");
    expect(current.wire.requests.every(request => request.method === "GET")).toBe(true);
    expect(current.runtime.snapshot()).toMatchObject({ state: "ready", generation: "native-generation", references: 2 });
  });
  it("ignores child token fragments and main compaction fragments while refreshing child activity without history reads", async () => {
    const current = await attached([user(), assistant()]);
    const childID = "ses_child";
    current.wire.sessions.push({ ...current.wire.session, id: childID, parentID: current.wire.sessionID });
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" }, [childID]: { type: "running" } } });
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    expect(baseline.snapshot.backgroundActivity).toMatchObject({ state: "known", agents: 1 });
    const historyRequests = () => current.wire.requests.filter(request => request.pathname.includes("/message"));
    const before = historyRequests().length;
    // More fragments than the live journal's capacity prove excluded child
    // tokens cannot overflow or consume the parent's history-acquisition budget.
    for (let index = 0; index < 4_100; index++) {
      current.wire.send(event(`session.${index % 2 ? "text" : "reasoning"}.delta`, {
        sessionID: childID, assistantMessageID: "msg_child", ordinal: 0, delta: "child" }));
      current.wire.send(event("session.compaction.delta", { text: "summary fragment" }));
    }
    current.wire.send(textEvent("text", "delta", "parent"));
    await vi.waitFor(() => expect(textOf(events, "assistant_message")).toBe("parent"));
    expect(historyRequests()).toHaveLength(before);
    expect(events.some(value => value.event.type === "resnapshot_required")).toBe(false);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const settled = event("session.execution.succeeded", { sessionID: childID }, true);
    current.wire.send({ ...settled, durable: { ...settled.durable, aggregateID: childID } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: {
      type: "background_activity_changed", activity: { state: "known", agents: 0, commands: 0, other: 0 },
    } })));
    expect(historyRequests()).toHaveLength(before);
  });
  it("installs a finite cut despite compaction fragments arriving during every history response", async () => {
    const current = await attached([user(), assistant()]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const getPage = OpenCodeNativeApi.prototype.getHistoryPage;
    let pages = 0;
    vi.spyOn(OpenCodeNativeApi.prototype, "getHistoryPage").mockImplementation(async function (this: OpenCodeNativeApi, id, input) {
      if (++pages > 5) throw new Error("acquisition incorrectly waits for stream quiet");
      const result = await getPage.call(this, id, input);
      current.wire.send(event("session.compaction.delta", { text: "still compacting" }));
      await new Promise<void>(resolve => setImmediate(resolve));
      return result;
    });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("running");
    expect(pages).toBe(2);
  });
  it("publishes a finite baseline before durable parent updates become quiet", async () => {
    const current = await attached([user(), idle()]);
    const getPage = OpenCodeNativeApi.prototype.getHistoryPage;
    let injecting = true, pages = 0;
    vi.spyOn(OpenCodeNativeApi.prototype, "getHistoryPage").mockImplementation(async function (this: OpenCodeNativeApi, id, input) {
      if (++pages > 8) throw new Error("finite baseline waited for all parent events to stop");
      const page = await getPage.call(this, id, input);
      if (injecting) {
        current.wire.send(event("session.renamed", { title: `Concurrent title ${pages}` }, true));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return page;
    });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    injecting = false;
    expect(baseline.snapshot.runState).toBe("idle");
    expect(baseline.snapshot.orderedBackendTurnIds).toHaveLength(1);
    // The pending bounded catch-up can complete without replacing the owner or
    // forcing another ascending scan of the unchanged completed prefix.
    await current.handle.history({ limit: 1 });
    expect(current.wire.requests.filter(request => request.query.get("order") === "asc")).toHaveLength(1);
    expect(current.client.lifetime.aborted).toBe(false);
  });
  it("keeps an older idle cut starting until catch-up supplies the newer active turn coordinate", async () => {
    const current = await attached([user(), idle()]);
    const getPage = OpenCodeNativeApi.prototype.getHistoryPage;
    let admitted = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getHistoryPage").mockImplementation(async function (this: OpenCodeNativeApi, id, input) {
      const page = await getPage.call(this, id, input);
      if (!admitted && input?.order === "desc") {
        admitted = true;
        current.wire.messages.push({ ...user("msg_new_user"), time: { created: 4 } }, { ...assistant(), time: { created: 5 } });
        current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
        current.wire.send(event("session.execution.started", {}, true));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return page;
    });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("starting");
    expect(baseline.snapshot.activeBackendTurnId).toBeUndefined();
    const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "run_state_changed", state: "running", activeBackendTurnId: expect.any(String),
    }) })));
    expect(events.some(value => value.event.type === "resnapshot_required")).toBe(false);
    expect(events.some(({ event }) => event.type === "run_state_changed" &&
      (event.state === "disconnected" || event.state === "reconciling"))).toBe(false);
  });
  it.each([false, true])("expires an inactive pending input without SSE (repeated refresh: %s)", async repeatRefresh => {
    const current = await attached([user(), idle()]);
    const inbox = `/api/session/${current.wire.sessionID}/inbox`;
    current.wire.setResponse(inbox, 200, { data: [{ type: "user", id: "msg_parked", sessionID: current.wire.sessionID,
      time: { created: 4 }, payload: { text: "Parked input" }, delivery: "queue" }] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const baseline = await current.handle.establishProjection({ signal: signal() });
      expect(baseline.snapshot.runState).toBe("starting");
      const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
      await vi.advanceTimersByTimeAsync(1_000);
      if (repeatRefresh) for (let index = 0; index < 3; index++) {
        expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("starting");
      }
      const reads = current.wire.requests.filter(request => request.pathname === inbox).length;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(events).toContainEqual(expect.objectContaining({ event: { type: "run_state_changed", state: "disconnected" } }));
      expect(current.wire.requests.filter(request => request.pathname === inbox)).toHaveLength(reads + 1);
      expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("disconnected");
      expect(events.some(({ event }) => event.type === "resnapshot_required")).toBe(false);
      expect(current.interrupts()).toHaveLength(0);
    } finally { await current.handle.close(); vi.useRealTimers(); }
  });
  it("does not renew promotion grace as overlapping pending cohorts replace their first row", async () => {
    const current = await attached([user(), idle()]);
    const inbox = `/api/session/${current.wire.sessionID}/inbox`;
    const pending = (ids: readonly string[]) => current.wire.setResponse(inbox, 200, { data: ids.map(id => ({
      type: "user", id, sessionID: current.wire.sessionID, time: { created: 4 }, payload: { text: id }, delivery: "queue",
    })) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      pending(["msg_a"]);
      expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("starting");
      await vi.advanceTimersByTimeAsync(700); pending(["msg_a", "msg_b"]);
      expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("starting");
      await vi.advanceTimersByTimeAsync(700); pending(["msg_b"]);
      const baseline = await current.handle.establishProjection({ signal: signal() });
      expect(baseline.snapshot.runState).toBe("starting");
      const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
      await vi.advanceTimersByTimeAsync(601);
      expect(events).toContainEqual(expect.objectContaining({ event: { type: "run_state_changed", state: "disconnected" } }));
      expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("disconnected");
    } finally { await current.handle.close(); vi.useRealTimers(); }
  });
  it.each(["retained idle", "newer session terminal"])("keeps an input surviving %s uncertain immediately", async evidence => {
    const current = await attached([user(), { ...idle(), outcome: "interrupted" } as SessionMessageInfo]);
    const created = evidence === "retained idle" ? 2 : 4;
    if (evidence === "newer session terminal") {
      current.wire.session.outcome = "interrupted";
      current.wire.session.time.idle = 5;
    }
    current.wire.setResponse(`/api/session/${current.wire.sessionID}/inbox`, 200, { data: [{ type: "user", id: "msg_surviving_stop",
      sessionID: current.wire.sessionID, time: { created }, payload: { text: "Still parked" }, delivery: "queue" }] });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("disconnected");
    expect(baseline.snapshot.activeBackendTurnId).toBeUndefined();
    expect(current.interrupts()).toHaveLength(0);
  });
  it("does not let fresh pending input hide inactive unfinished history", async () => {
    const current = await attached([user(), assistant()]);
    current.wire.setResponse(`/api/session/${current.wire.sessionID}/inbox`, 200, { data: [{ type: "user", id: "msg_new_pending",
      sessionID: current.wire.sessionID, time: { created: 4 }, payload: { text: "New input" }, delivery: "queue" }] });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("disconnected");
    expect(Object.values(baseline.snapshot.turnsById)[0]?.status).toBe("in_progress");
    expect(baseline.snapshot.activeBackendTurnId).toBeUndefined();
    expect(current.wire.requests.filter(request => request.query.get("order") === "desc")).toHaveLength(2);
    expect(current.wire.requests.filter(request => request.query.get("order") === "asc")).toHaveLength(1);
  });
  it("does not classify a just-consumed inbox row against a newer session terminal", async () => {
    const current = await attached([user(), idle()]);
    const inbox = `/api/session/${current.wire.sessionID}/inbox`;
    current.wire.session.time.idle = 3;
    current.wire.setResponse(inbox, 200, { data: [{ type: "user", id: "msg_consumed_during_inventory", sessionID: current.wire.sessionID,
      time: { created: 4 }, payload: { text: "Fast input" }, delivery: "queue" }] });
    const getPending = OpenCodeNativeApi.prototype.getPending;
    let finished = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getPending").mockImplementation(async function (this: OpenCodeNativeApi, ...args) {
      const result = await getPending.apply(this, args);
      if (!finished) {
        finished = true;
        current.wire.clearResponse(inbox);
        current.wire.messages.push({ ...user("msg_consumed_during_inventory"), time: { created: 4 } },
          { ...idle("msg_terminal_after_inventory"), time: { created: 5 } });
        current.wire.session.time.idle = 5;
      }
      return result;
    });
    const raw: BackendConversationEvent[] = []; current.handle.subscribe(value => raw.push(value));
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("starting");
    expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("idle");
    expect(raw.some(event => event.type === "resnapshot_required" || event.type === "run_state_changed" &&
      (event.state === "disconnected" || event.state === "reconciling"))).toBe(false);
  });
  it("rechecks inbox after a confirmation cut adds a newer terminal", async () => {
    const current = await attached([user(), assistant()]);
    const inbox = `/api/session/${current.wire.sessionID}/inbox`;
    current.wire.setResponse(inbox, 200, { data: [{ type: "user", id: "msg_consumed_at_terminal", sessionID: current.wire.sessionID,
      time: { created: 2 }, payload: { text: "Consumed meanwhile" }, delivery: "queue" }] });
    const getActivity = OpenCodeNativeApi.prototype.getActivity;
    let finished = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getActivity").mockImplementation(async function (this: OpenCodeNativeApi, ...args) {
      if (!finished) {
        finished = true;
        current.wire.messages[1] = { ...assistant([{ type: "text", text: "Done" }]), time: { created: 2, completed: 3 } };
        current.wire.messages.push(idle());
        current.wire.clearResponse(inbox);
      }
      return getActivity.apply(this, args);
    });
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("idle");
    expect(Object.values(baseline.snapshot.turnsById)[0]?.status).toBe("completed");
    expect(current.wire.requests.filter(request => request.pathname === inbox)).toHaveLength(2);
    expect(current.wire.requests.filter(request => request.query.get("order") === "desc")).toHaveLength(2);
  });
  it("rechecks positive activity after the final idle cut without waiting for another SSE event", async () => {
    const current = await attached([user(), idle()]);
    current.wire.setResponse("/api/session/active", 200, { data: { [current.wire.sessionID]: { type: "running" } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const baseline = await current.handle.establishProjection({ signal: signal() });
      expect(baseline.snapshot.runState).toBe("starting");
      const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
      const reads = () => current.wire.requests.filter(request => request.pathname === "/api/session/active").length;
      const initialReads = reads();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(reads()).toBe(initialReads + 1);
      expect(events.some(({ event }) => event.type === "run_state_changed" && event.state === "disconnected")).toBe(false);
      // Native process-local ownership disappears after publishing its terminal;
      // no later durable event is required to announce this teardown.
      current.wire.clearResponse("/api/session/active");
      await vi.advanceTimersByTimeAsync(2_001);
      expect(events).toContainEqual(expect.objectContaining({ event: { type: "run_state_changed", state: "idle" } }));
      expect(events.some(({ event }) => event.type === "resnapshot_required")).toBe(false);
      expect(current.interrupts()).toHaveLength(0);
    } finally { await current.handle.close(); vi.useRealTimers(); }
  });
  it("confirms native settlement once when execution completes between history and activity reads", async () => {
    const current = await attached([user(), assistant()]);
    const getActivity = OpenCodeNativeApi.prototype.getActivity;
    let completed = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getActivity").mockImplementation(async function (this: OpenCodeNativeApi, ...args) {
      if (!completed) {
        completed = true;
        current.wire.messages[1] = { ...assistant([{ type: "text", text: "Final answer" }]), time: { created: 2, completed: 3 } };
        current.wire.messages.push(idle());
      }
      return getActivity.apply(this, args);
    });
    const raw: BackendConversationEvent[] = []; current.handle.subscribe(value => raw.push(value));
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("idle");
    expect(Object.values(baseline.snapshot.turnsById)[0]?.status).toBe("completed");
    expect(baseline.snapshot.itemsById[openCodeHistoryItemId("msg_assistant", 0)])
      .toMatchObject({ status: "completed", markdown: { text: "Final answer" } });
    expect(current.wire.requests.filter(request => request.query.get("order") === "desc")).toHaveLength(2);
    expect(current.wire.requests.filter(request => request.query.get("order") === "asc")).toHaveLength(1);
    expect(raw.some(event => event.type === "resnapshot_required" || event.type === "run_state_changed" &&
      (event.state === "disconnected" || event.state === "reconciling"))).toBe(false);
    expect(current.interrupts()).toHaveLength(0);
  });
  it("moves each native queued input through startup and execution without a recovery state", async () => {
    const current = await attached([user(), idle()]);
    const baseline = await current.handle.establishProjection({ signal: signal() });
    const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
    const states = () => events.flatMap(({ event }) => event.type === "run_state_changed" ? [event.state] : []);
    const inbox = `/api/session/${current.wire.sessionID}/inbox`;
    for (let index = 0; index < 2; index++) {
      const id = `msg_queued_${index}`, created = 4 + index * 3;
      current.wire.setResponse(inbox, 200, { data: [{ type: "user", id, sessionID: current.wire.sessionID,
        payload: { text: "Next question" }, delivery: "queue", time: { created } }] });
      current.wire.send(event("session.inbox.enqueued", { inboxID: id,
        item: { type: "user", delivery: "queue", payload: { text: "Next question" } } }, true));
      await vi.waitFor(() => expect(states().at(-1)).toBe("starting"));
      const starting = events.findLast(({ event }) => event.type === "run_state_changed")!.event;
      expect(starting).not.toHaveProperty("activeBackendTurnId");
      expect(events.filter(({ event }) => event.type === "turn_started")).toHaveLength(index);

      current.wire.clearResponse(inbox);
      current.wire.messages.push({ ...user(id), time: { created } });
      current.wire.setResponse("/api/session/active", 200, { data: { [current.wire.sessionID]: { type: "running" } } });
      current.wire.send(event("session.execution.started", {}, true));
      await vi.waitFor(() => expect(states().at(-1)).toBe("running"));
      expect(events.filter(({ event }) => event.type === "turn_started")).toHaveLength(index + 1);

      current.wire.messages.push({ ...idle(`msg_finished_${index}`), time: { created: created + 2 } });
      current.wire.clearResponse("/api/session/active");
      current.wire.send(event("session.execution.succeeded", {}, true));
      await vi.waitFor(() => expect(states().at(-1)).toBe("idle"));
    }
    expect(states()).toEqual(["starting", "running", "idle", "starting", "running", "idle"]);
    expect(events.some(({ event }) => event.type === "resnapshot_required")).toBe(false);
    expect(current.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
  });
  it("reads activity after inbox promotion instead of publishing an old idle observation", async () => {
    const current = await attached([user(), idle()]);
    let promoted = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getPending").mockImplementation(async () => {
      // The inbox response arrives after native execution has begun. An activity
      // request made concurrently would have captured the earlier inactive state.
      await new Promise<void>(resolve => setImmediate(resolve));
      promoted = true;
      return [];
    });
    vi.spyOn(OpenCodeNativeApi.prototype, "getActivity").mockImplementation(async () => ({
      active: promoted, children: [], activeChildren: [], shells: [], observedAt: Date.now(),
    }));
    const baseline = await current.handle.establishProjection({ signal: signal() });
    expect(baseline.snapshot.runState).toBe("starting");
    expect(baseline.snapshot.activeBackendTurnId).toBeUndefined();
    expect(baseline.snapshot.orderedBackendTurnIds).toHaveLength(1);
  });
  it("recovers a failed non-head assistant reopened by retry and observes its new text and settlement", async () => {
    const failed = { ...assistant(), time: { created: 2, completed: 3 }, error: { type: "ProviderError", message: "retry me" } } as SessionMessageInfo;
    const current = await attached([user(), failed]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    current.wire.messages.push({ id: "msg_model", type: "model-switched", model: { providerID: "fixture", id: "retry-model" }, time: { created: 4 } });
    current.wire.send(event("session.model.selected", { model: { providerID: "fixture", id: "retry-model" } }, true));
    await vi.waitFor(() => expect(events.some(({ event: value }) => "item" in value && value.item.semanticKind === "notice")).toBe(true));
    current.wire.messages[1] = { ...assistant(), model: { providerID: "fixture", id: "retry-model" }, time: { created: 5 } };
    current.wire.send(event("session.step.started", { assistantMessageID: "msg_assistant", agent: "build", model: { providerID: "fixture", id: "retry-model" }, started: 5 }, true));
    await vi.waitFor(() => expect(events.some(({ event: value }) => value.type === "resnapshot_required")).toBe(true));
    // A changed creation anchor discards the old retry generation and its
    // failure/overlay evidence; native sequence order itself remains unchanged.
    const recovered = await current.handle.establishProjection({ signal: signal() }); const updates: SequencedBackendEvent[] = [];
    recovered.subscribeFromNext(value => updates.push(value));
    expect(recovered.snapshot.itemsById[openCodeHistoryItemId("msg_assistant", 0)]).toMatchObject({ status: "streaming", startedAt: new Date(5).toISOString() });
    current.wire.send(textEvent("text", "delta", "retry prefix"));
    await vi.waitFor(() => expect(textOf(updates, "assistant_message")).toBe("retry prefix"));
    current.wire.messages[1] = { ...assistant([{ type: "text", text: "retry final" }]), time: { created: 5, streamed: 6, completed: 7 } };
    current.wire.send(textEvent("text", "ended", "retry final"));
    current.wire.send(event("session.step.ended", { assistantMessageID: "msg_assistant", finish: "stop", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, true));
    current.wire.messages.push({ ...idle(), time: { created: 8 } });
    current.wire.setResponse("/api/session/active", 200, { data: {} });
    current.wire.send(event("session.execution.succeeded", {}, true));
    await vi.waitFor(() => expect(updates.some(({ event: value }) => value.type === "turn_completed" && value.turn.status === "completed")).toBe(true));
    expect(textOf(updates, "assistant_message")).toBe("retry final");
    expect(updates.some(({ event: value }) => value.type === "resnapshot_required")).toBe(false);
  });
  it.each(["success", "failed"] as const)("observes late tool %s on a completed assistant behind later records", async outcome => {
    const message = assistant([{ type: "tool", id: "tool_late", name: "read", state: { status: "running", input: {}, metadata: {} }, time: { created: 2 } }]);
    message.time = { created: 2, completed: 3 };
    const current = await attached([user(), message, { id: "msg_later", type: "system", text: "Later system entry", time: { created: 4 } }]);
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    const state: Extract<Extract<SessionMessageInfo, { type: "assistant" }>["content"][number], { type: "tool" }>["state"] = outcome === "success" ? { status: "completed", input: {}, content: [{ type: "text", text: "late result" }] }
      : { status: "error" as const, input: {}, error: { type: "ToolError", message: "late failure" } };
    current.wire.messages[1] = { ...message, content: [{ type: "tool", id: "tool_late", name: "read", state, time: { created: 2, completed: 5 } }] };
    const native = event(`session.tool.${outcome}`, { assistantMessageID: "msg_assistant", id: "tool_late", executed: true,
      ...(outcome === "success" ? { content: [{ type: "text", text: "late result" }] } : { error: { type: "ToolError", message: "late failure" } }) }, true);
    current.wire.send({ ...native, durable: { ...native.durable, version: 2 } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "item_completed",
      item: expect.objectContaining({ semanticKind: "tool", status: outcome === "success" ? "completed" : "failed" }) }) })));
    expect(events.some(({ event: value }) => value.type === "resnapshot_required")).toBe(false);
  });
  it("retains a newer dirty-record revision arriving during a finite refresh", async () => {
    const tool = { type: "tool" as const, id: "tool_race", name: "read", state: { status: "running" as const, input: {}, metadata: {} }, time: { created: 2 } };
    const complete = { ...assistant([tool]), time: { created: 2, completed: 3 } };
    const current = await attached([user(), complete, { id: "msg_later", type: "system", text: "Later", time: { created: 4 } }]);
    // This test exercises live dirty revisions, not inactive orphan recovery.
    current.wire.setResponse("/api/session/active", 200, { data: { [current.wire.sessionID]: { type: "running" } } });
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    const readMessage = OpenCodeNativeApi.prototype.getMessage; let updated = false;
    vi.spyOn(OpenCodeNativeApi.prototype, "getMessage").mockImplementation(async function (this: OpenCodeNativeApi, id, messageID, signal) {
      const result = await readMessage.call(this, id, messageID, signal);
      if (messageID === "msg_assistant" && !updated) {
        updated = true;
        // The native updater reopens the exact tool on Called. Failed can
        // then settle that running tool after the assistant step completed.
        current.wire.messages[1] = { ...complete, content: [tool] };
        current.wire.send(event("session.tool.called", { assistantMessageID: messageID, id: tool.id, executed: true, input: {} }, true));
        const error = { type: "ToolError", message: "late terminal failure" };
        current.wire.messages[1] = { ...complete, content: [{ ...tool, state: { status: "error", input: {}, error }, time: { created: 2, completed: 6 } }] };
        const failed = event("session.tool.failed", { assistantMessageID: messageID, id: tool.id, executed: true, error }, true);
        current.wire.send({ ...failed, durable: { ...failed.durable, version: 2 } });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return result;
    });
    const content: [{ type: "text"; text: string }] = [{ type: "text", text: "first result" }];
    current.wire.messages[1] = { ...complete, content: [{ ...tool, state: { status: "completed", input: {}, content }, time: { created: 2, completed: 5 } }] };
    const success = event("session.tool.success", { assistantMessageID: "msg_assistant", id: tool.id, executed: true, content }, true);
    current.wire.send({ ...success, durable: { ...success.durable, version: 2 } });
    await vi.waitFor(() => expect(events.filter(({ event: value }) => "item" in value && value.item.semanticKind === "tool").at(-1)?.event)
      .toMatchObject({ item: { status: "failed", error: { message: { text: "late terminal failure" } } } }));
    expect(current.wire.requests.filter(request => request.pathname.endsWith("/message/msg_assistant"))).toHaveLength(2);
    expect(current.wire.requests.filter(request => request.query.get("order") === "asc")).toHaveLength(1);
  });
  it.each([1, 2])("rejects replay-only replacement frames and clears stale overlays when recovering %i text parts", async count => {
    const content = [{ type: "text" as const, text: "" }, { type: "text" as const, text: "" }];
    const current = await attached([user(), assistant(content)]);
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    current.wire.send(textEvent("text", "delta", "old zero", 0));
    current.wire.send(textEvent("text", "delta", "old one", 1));
    await vi.waitFor(() => expect(events.filter(({ event: value }) => "item" in value)).toHaveLength(2));
    const replacement = content.slice(0, count);
    current.wire.messages[1] = assistant(replacement);
    // Pinned SessionEvent excludes this replay-only event from the public
    // manifest. Keep strict SSE parsing: it invalidates instead of applying a
    // non-public replacement to the active generation's retained projection.
    current.wire.send(event("session.message.content.updated", { messageID: "msg_assistant", content: replacement }, true));
    await vi.waitFor(() => expect(events.some(({ event: value }) => value.type === "resnapshot_required")).toBe(true));
    const recovered = await current.handle.establishProjection({ signal: signal() });
    for (let index = 0; index < count; index++) expect(recovered.snapshot.itemsById[openCodeHistoryItemId("msg_assistant", index)])
      .toMatchObject({ markdown: { text: "" } });
    if (count === 1) expect(recovered.snapshot.itemsById[openCodeHistoryItemId("msg_assistant", 1)]).toBeUndefined();
  });
  it("observes attributed shell creation while idle and scopes terminal shell refreshes without rereading history", async () => {
    const current = await attached([user(), idle()]);
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    const before = current.wire.requests.filter(request => request.pathname.includes("/message")).length;
    const shell = { id: "sh_owned", status: "running", command: "sleep 60", cwd: current.wire.directory,
      shell: "/bin/sh", file: "/fixture/output", metadata: { sessionID: current.wire.sessionID }, time: { started: 1 } };
    current.wire.setResponse("/api/shell", 200, { location: { directory: current.wire.directory }, data: [shell] });
    current.wire.send({ id: "evt_foreign_shell", created: 1, type: "shell.created", data: { info: { ...shell, id: "sh_foreign", metadata: { sessionID: "ses_foreign" } } } });
    current.wire.send({ id: "evt_shell_created", created: 2, type: "shell.created", data: { info: shell } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: {
      type: "background_activity_changed", activity: { state: "known", agents: 0, commands: 1, other: 0 },
    } })));
    const shellReads = current.wire.requests.filter(request => request.pathname === "/api/shell").length;
    current.wire.send({ id: "evt_foreign_exit", created: 3, type: "shell.exited", data: { id: "sh_foreign", exit: 0, status: "exited" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(current.wire.requests.filter(request => request.pathname === "/api/shell")).toHaveLength(shellReads);
    current.wire.setResponse("/api/shell", 200, { location: { directory: current.wire.directory }, data: [{ ...shell, status: "exited", exit: 0, time: { started: 1, completed: 4 } }] });
    current.wire.send({ id: "evt_shell_exit", created: 4, type: "shell.exited", data: { id: shell.id, exit: 0, status: "exited" } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: {
      type: "background_activity_changed", activity: { state: "known", agents: 0, commands: 0, other: 0 },
    } })));
    expect(current.wire.requests.filter(request => request.pathname.includes("/message"))).toHaveLength(before);
    expect((await current.handle.establishProjection({ signal: signal() })).snapshot.runState).toBe("idle");
  });
  it("keeps reasoning/text ordinal zero distinct and replaces streamed text with exact ended values", async () => {
    const current = await attached([user(), assistant([{ type: "reasoning", text: "" }, { type: "text", text: "" }])]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    current.wire.send(textEvent("reasoning", "delta", "Think")); current.wire.send(textEvent("text", "delta", "Partial"));
    await vi.waitFor(() => { expect(textOf(events, "reasoning")).toBe("Think"); expect(textOf(events, "assistant_message")).toBe("Partial"); });
    const full = textEvent("text", "ended", "Final"); current.wire.send(full); current.wire.send(full);
    current.wire.send(textEvent("text", "delta", "late"));
    await vi.waitFor(() => expect(textOf(events, "assistant_message")).toBe("Final"));
    current.wire.send(textEvent("reasoning", "ended", ""));
    await vi.waitFor(() => expect(textOf(events, "reasoning")).toBe(""));
    expect(events.filter(value => value.event.type === "resnapshot_required")).toEqual([]);
  });
  it("recovers a missed prefix from native final history after disconnect without concatenating it twice", async () => {
    const current = await attached([user(), assistant()]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    await current.handle.establishProjection({ signal: signal() });
    const raw: BackendConversationEvent[] = []; current.handle.subscribe(value => raw.push(value));
    current.wire.disconnect(); await vi.waitFor(() => expect(raw.some(value => value.type === "resnapshot_required")).toBe(true));
    const recovered = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    recovered.subscribeFromNext(value => events.push(value));
    current.wire.send(textEvent("text", "delta", "SUFFIX"));
    await vi.waitFor(() => expect(textOf(events, "assistant_message")).toBe("SUFFIX"));
    current.wire.messages[1] = { ...assistant([{ type: "text", text: "PREFIXSUFFIX" }]), time: { created: 2, completed: 4 } };
    current.wire.messages.push(idle()); current.wire.setResponse("/api/session/active", 200, { data: {} });
    current.wire.send(event("session.execution.succeeded", {}, true));
    await vi.waitFor(() => expect(textOf(events, "assistant_message")).toBe("PREFIXSUFFIX"));
    expect(events.some(({ event: value }) => value.type === "turn_completed")).toBe(true);
    expect(current.interrupts()).toHaveLength(0);
  });
  it("does not settle inactive unfinished native history or forge an interrupted turn", async () => {
    const current = await attached([user(), assistant()]);
    const result = await current.handle.establishProjection({ signal: signal() });
    expect(result.snapshot.runState).toBe("disconnected"); expect(result.snapshot.activeBackendTurnId).toBeUndefined();
    expect(Object.values(result.snapshot.turnsById)[0]?.status).toBe("in_progress");
    expect(current.wire.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("rejects a rewind during paging and invalidates old history cursors", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => [user(`msg_user_${index}`), idle(`msg_idle_${index}`)]).flat();
    const current = await attached(messages); const baseline = await current.handle.establishProjection({ signal: signal() });
    const held = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const read = current.handle.establishProjection({ signal: signal() });
    const rejected = expect(read).rejects.toMatchObject({ backendCode: "opencode_history_invalidated" });
    await held.entered; current.wire.messages.splice(2);
    current.wire.send(event("session.revert.cleared", {}, true)); held.release(); await rejected;
    await current.handle.establishProjection({ signal: signal() });
    await expect(current.handle.history({ limit: 10, cursor: baseline.history.previousCursor })).rejects.toMatchObject({ backendCode: "opencode_history_cursor" });
  });
  it("keeps terminal native events live when an older retained-page request is cancelled", async () => {
    const current = await attached([user(), assistant()]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const baseline = await current.handle.establishProjection({ signal: signal() }); const events: SequencedBackendEvent[] = [];
    baseline.subscribeFromNext(value => events.push(value));
    const abort = new AbortController();
    const read = current.handle.history({ limit: 10, signal: abort.signal });
    const rejected = expect(read).rejects.toBeInstanceOf(Error);
    abort.abort();
    current.wire.messages[1] = { ...assistant([{ type: "text", text: "Finished" }]), time: { created: 2, completed: 3 } };
    current.wire.messages.push(idle()); current.wire.setResponse("/api/session/active", 200, { data: {} });
    current.wire.send(event("session.execution.succeeded", {}, true));
    await rejected;
    await vi.waitFor(() => expect(events.some(value => value.event.type === "turn_completed")).toBe(true));
    expect(textOf(events, "assistant_message")).toBe("Finished");
    expect(events.some(value => value.event.type === "resnapshot_required")).toBe(false);
    expect(current.wire.requests.filter(request => request.query.get("order") === "asc")).toHaveLength(1);
    const count = current.wire.requests.length;
    const older = await current.handle.history({ limit: 1 });
    expect(older.orderedBackendTurnIds).toHaveLength(1);
    await current.handle.locateTurn({ maximumTurnCandidates: 1, matchesBackendTurnId: () => true });
    expect(current.wire.requests).toHaveLength(count);
    await expect(current.handle.history({ limit: 1, cursor: "invalid" })).rejects.toMatchObject({ backendCode: "opencode_history_cursor" });
    expect(events.some(value => value.event.type === "resnapshot_required")).toBe(false);
  });
  it("delivers a newly observed already-completed turn through the actor without forcing resnapshot", async () => {
    const current = setup(); const acquired = await current.acquire();
    const generation = acquired.actor.timeline.generation;
    const raw: BackendConversationEvent[] = []; (await current.handle()).subscribe(value => raw.push(value));
    current.wire.messages.push(user(), { ...assistant([{ type: "text", text: "Complete between observations" }]), time: { created: 2, completed: 3 } }, idle());
    current.wire.send(event("session.execution.succeeded", {}, true));
    await vi.waitFor(() => {
      expect(acquired.actor.timeline.orderedTurnIds).toHaveLength(1);
      expect(Object.values(acquired.actor.timeline.turnsById)[0]?.status).toBe("completed");
    });
    expect(acquired.actor.timeline.generation).toBe(generation);
    expect(raw.some(value => value.type === "resnapshot_required")).toBe(false);
    expect(raw.find(value => value.type === "turn_started")).toMatchObject({ turn: { status: "in_progress", orderedBackendItemIds: [] } });
    expect(current.attached).toHaveBeenCalledOnce(); acquired.release();
  });
  it.each(["establishProjection", "history", "locateTurn"] as const)("keeps the original deadline through final %s selection", async method => {
    const current = await attached([user(), idle()]);
    if (method !== "establishProjection") await current.handle.establishProjection({ signal: signal() });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const expire = <T>(value: T): T => { now += OPENCODE_HISTORY_LIMITS.milliseconds + 1; return value; };
    if (method === "establishProjection") {
      const original = OpenCodeHistoryProjection.prototype.snapshot;
      vi.spyOn(OpenCodeHistoryProjection.prototype, "snapshot").mockImplementation(function (this: OpenCodeHistoryProjection, input) { return expire(original.call(this, input)); });
    } else if (method === "history") {
      const original = OpenCodeHistoryProjection.prototype.history;
      vi.spyOn(OpenCodeHistoryProjection.prototype, "history").mockImplementation(function (this: OpenCodeHistoryProjection, input) { return expire(original.call(this, input)); });
    } else {
      const original = OpenCodeHistoryProjection.prototype.locateTurn;
      vi.spyOn(OpenCodeHistoryProjection.prototype, "locateTurn").mockImplementation(function (this: OpenCodeHistoryProjection, input) { return expire(original.call(this, input)); });
    }
    const read = method === "establishProjection" ? current.handle.establishProjection({ signal: signal() }) : method === "history"
      ? current.handle.history({ limit: 10 }) : current.handle.locateTurn({ maximumTurnCandidates: 10, matchesBackendTurnId: () => false });
    await expect(read).rejects.toMatchObject({ backendCode: "opencode_history_limit_time", retryable: false });
  });
  it("charges both newly retained live overlay bytes and projected text against the aggregate bound", async () => {
    const current = await attached([user(), assistant()]);
    current.wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } });
    const getPage = OpenCodeNativeApi.prototype.getHistoryPage;
    // Transport byte enforcement is qualified separately. Inflate decoded
    // accounting here to exercise the aggregate composition without a64MiB fixture.
    vi.spyOn(OpenCodeNativeApi.prototype, "getHistoryPage").mockImplementation(async function (this: OpenCodeNativeApi, id, input) {
      const page = await getPage.call(this, id, input);
      return input?.order === "asc" ? { ...page, decodedBytes: OPENCODE_HISTORY_LIMITS.decodedBytes - 10_000 } : page;
    });
    let baselineBytes = 0;
    const snapshot = OpenCodeHistoryProjection.prototype.snapshot;
    vi.spyOn(OpenCodeHistoryProjection.prototype, "snapshot").mockImplementation(function (this: OpenCodeHistoryProjection, input) {
      baselineBytes = this.decodedBytes; return snapshot.call(this, input);
    });
    await current.handle.establishProjection({ signal: signal() });
    const remaining = OPENCODE_HISTORY_LIMITS.decodedBytes - baselineBytes;
    expect(remaining).toBeGreaterThan(1_000);
    const raw: BackendConversationEvent[] = []; current.handle.subscribe(value => raw.push(value));
    current.wire.send(textEvent("text", "delta", "x".repeat(Math.floor(remaining * 0.6))));
    await vi.waitFor(() => expect(raw).toContainEqual({ type: "resnapshot_required", reason: "history_changed" }));
    expect(current.client.lifetime.aborted).toBe(false);
  });
  it("does not automatically retry a fixed response-byte failure through the actual actor", async () => {
    const current = setup([user(), idle()]); const acquired = await current.acquire();
    const publications: unknown[] = []; acquired.actor.subscribe(value => publications.push(value));
    const readPath = `/api/session/${current.wire.sessionID}/message`;
    const before = current.wire.requests.filter(request => request.pathname === readPath).length;
    current.wire.setResponse(readPath, 200, { data: [{ ...user(), text: "x".repeat(OPENCODE_MAXIMUM_RESPONSE_BYTES) }], cursor: {} });
    current.wire.disconnect();
    await vi.waitFor(() => expect(acquired.actor.projectionRecoveryRequired).toBe(true));
    await vi.waitFor(() => expect(JSON.stringify(publications)).toContain("Conversation synchronization failed"));
    expect(current.wire.requests.filter(request => request.pathname === readPath)).toHaveLength(before + 1);
    expect(current.client.lifetime.aborted).toBe(false); expect(current.interrupts()).toHaveLength(0); acquired.release();
  });
});
