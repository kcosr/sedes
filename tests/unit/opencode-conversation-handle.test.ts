import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import type { BackendConversationEvent, SequencedBackendEvent } from "../../src/shared/protocol/backend.js";
import { OpenCodeHistoryProjection } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { OPENCODE_HISTORY_LIMITS } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OPENCODE_MAXIMUM_RESPONSE_BYTES } from "../../src/server/backends/opencode/opencode-http-client.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(messages: SessionMessageInfo[] = []) {
  const fixture = createOpenCodeConversationFixture({ messages }); cleanup.push(fixture.dispose); return fixture;
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
function event(type: string, data: Record<string, unknown>, durable = false) {
  const index = ++eventNumber;
  return { id: `evt_handle_${index}`, created: index, type, data: { sessionID: "ses_fixture", ...data },
    ...(durable ? { durable: { aggregateID: "ses_fixture", seq: index, version: 1 } } : {}) };
}
function textEvent(kind: "text" | "reasoning", phase: "delta" | "ended", text: string, ordinal = 0) {
  return event(`session.${kind}.${phase}`, { assistantMessageID: "msg_assistant", ordinal, [phase === "delta" ? "delta" : "text"]: text }, phase === "ended");
}
function textOf(events: SequencedBackendEvent[], kind: "assistant_message" | "reasoning") {
  return events.flatMap(({ event: value }) => "item" in value && value.item.semanticKind === kind ? [value.item.markdown.text] : []).at(-1);
}

describe("OpenCode conversation authority and finite discovery", () => {
  it("rejects foreign scope and immutable binding fields before acquiring a runtime", async () => {
    const current = setup();
    for (const change of [{ scope: { ...scope, principalId: "foreign" } },
      { binding: { ...current.target.binding, backendConversationId: "ses_foreign" } },
      { opaqueBindingDetail: JSON.stringify({ ...JSON.parse(current.target.opaqueBindingDetail), nativeNamespaceKey: "foreign" }) },
      { workspace: { ...current.target.workspace, canonicalPath: "/foreign" } }]) {
      await expect(current.driver.attach({ ...current.target, ...change })).rejects.toMatchObject({ category: "permission_denied", crossedSubmissionBoundary: false });
    }
    expect(current.runtime.start).not.toHaveBeenCalled(); expect(current.wire.requests).toHaveLength(0);
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
    const current = await attached(); const held = current.wire.hold("/api/event");
    const read = current.handle.establishProjection({ signal: signal() });
    await held.entered;
    expect(current.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
    held.release();
    expect((await read).snapshot.orderedBackendTurnIds).toEqual([]);
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
    const read = current.handle.history({ limit: 10, cursor: baseline.history.previousCursor });
    const rejected = expect(read).rejects.toMatchObject({ backendCode: "opencode_history_invalidated" });
    await held.entered; current.wire.messages.splice(2);
    current.wire.send(event("session.revert.cleared", {}, true)); held.release(); await rejected;
    await current.handle.establishProjection({ signal: signal() });
    await expect(current.handle.history({ limit: 10, cursor: baseline.history.previousCursor })).rejects.toMatchObject({ backendCode: "opencode_history_cursor" });
  });
  it.each(["establishProjection", "history", "locateTurn"] as const)("keeps the original deadline through final %s selection", async method => {
    const current = await attached([user(), idle()]);
    if (method !== "establishProjection") await current.handle.establishProjection({ signal: signal() });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const expire = <T>(value: T): T => { now += 120_001; return value; };
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
