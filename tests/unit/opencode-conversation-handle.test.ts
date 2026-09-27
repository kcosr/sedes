import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import type { BackendConversationEvent, SequencedBackendEvent } from "../../src/shared/protocol/backend.js";
import { OpenCodeHistoryProjection, openCodeHistoryItemId } from "../../src/server/backends/opencode/opencode-history-projection.js";
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
  it("still awaits the same SSE readiness after its first establishment caller cancels", async () => {
    const current = await attached(); const held = current.wire.hold("/api/event");
    const cancellation = new AbortController();
    const first = current.handle.establishProjection({ signal: cancellation.signal });
    const rejected = expect(first).rejects.toBeInstanceOf(Error);
    await held.entered; cancellation.abort(); await rejected;
    const second = current.handle.establishProjection({ signal: signal() });
    // Queue one microtask behind the establishment call so its reused-observer
    // path runs before checking that no native history request escaped.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(current.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
    held.release(); await second;
    expect(current.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
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
  it("keeps an older idle cut unknown until catch-up supplies the newer active turn coordinate", async () => {
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
    expect(baseline.snapshot.runState).toBe("disconnected");
    expect(baseline.snapshot.activeBackendTurnId).toBeUndefined();
    const events: SequencedBackendEvent[] = []; baseline.subscribeFromNext(value => events.push(value));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "run_state_changed", state: "running", activeBackendTurnId: expect.any(String),
    }) })));
    expect(events.some(value => value.event.type === "resnapshot_required")).toBe(false);
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
