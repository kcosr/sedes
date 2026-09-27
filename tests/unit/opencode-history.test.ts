import { afterEach, describe, expect, it, vi } from "vitest";
import { backendConversationSnapshotSchema, backendHistoryPageSchema } from "../../src/shared/protocol/backend.js";
import { MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES } from "../../src/shared/protocol/payload.js";
import { OpenCodeHistoryProjection, openCodeHistoryItemId, openCodeHistoryPartKey, openCodeHistoryTurnId, type OpenCodeHistoryProjectionInput } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { OPENCODE_HISTORY_LIMITS, openCodeHistoryFingerprint, readOpenCodeHistory, refreshOpenCodeHistory, restartOpenCodeHistoryAcquisition, type OpenCodeRetainedHistory } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError, parseOpenCodeNativeMessage,
  type OpenCodeNativeApi, type OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";

afterEach(() => vi.useRealTimers());
const sessionId = "ses_history";
const identity = { bindingScope: ["tenant", "principal", "backend", "store", "thread", sessionId], generation: "owner-1", activity: "idle" as const };
const user = (id: string, text = id): OpenCodeNativeMessage => parseOpenCodeNativeMessage({ id, type: "user", text, time: { created: 100 } });
const idle = (id: string, outcome = "succeeded"): OpenCodeNativeMessage => parseOpenCodeNativeMessage({ id, type: "idle", outcome, time: { created: 300 } });
const assistant = (id: string, extra: Record<string, unknown> = {}): OpenCodeNativeMessage => parseOpenCodeNativeMessage({
  id, type: "assistant", agent: "build", model: { providerID: "probe", id: "model" }, content: [{ type: "text", text: "" }], time: { created: 200 }, ...extra,
});
function retained(messages: readonly OpenCodeNativeMessage[]): OpenCodeRetainedHistory {
  return { sessionId, messages, ...(messages.length ? { headId: messages.at(-1)!.id } : {}),
    frontier: openCodeHistoryFingerprint(messages.map(message => [message.id, message.type])), decodedBytes: Buffer.byteLength(JSON.stringify(messages)), retainedDecodedBytes: Buffer.byteLength(JSON.stringify(messages)), records: messages.length };
}
function projection(messages: readonly OpenCodeNativeMessage[], options: Partial<OpenCodeHistoryProjectionInput> = {}) {
  return new OpenCodeHistoryProjection(retained(messages), { ...identity, ...options });
}
function apiFixture(initial: readonly OpenCodeNativeMessage[]) {
  const state = { messages: [...initial] };
  const getHistoryPage = vi.fn<OpenCodeNativeApi["getHistoryPage"]>(async (_session, input = {}) => {
    let start = 0;
    if (input.cursor) {
      const index = state.messages.findIndex(message => message.id === input.cursor!.slice(5));
      if (index < 0) return { data: [], cursor: {}, decodedBytes: 23 };
      start = index + 1;
    }
    const data = input.order === "desc" ? state.messages.slice().reverse().slice(0, input.limit ?? 50)
      : input.cursor?.startsWith("prev:") ? state.messages.slice(start, start + (input.limit ?? 50)).reverse()
      : state.messages.slice(start, start + (input.limit ?? 50));
    const value = { data, cursor: data.length ? { previous: `prev:${data[0]!.id}`, next: `next:${data.at(-1)!.id}` } : {} };
    return { ...value, decodedBytes: Buffer.byteLength(JSON.stringify(value)) };
  });
  const getMessage = vi.fn<OpenCodeNativeApi["getMessage"]>(async (_session, id) => {
    const value = state.messages.find(message => message.id === id);
    if (!value) throw new OpenCodeRuntimeError("opencode_native_not_found");
    return value;
  });
  return { state, api: { getHistoryPage, getMessage } };
}

describe("OpenCode complete retained native history acquisition", () => {
  it("uses opaque pages and validates each continuation anchor through an exact finite head", async () => {
    const messages = [user("msg_a"), idle("msg_b"), user("msg_c"), idle("msg_d"), user("msg_e")];
    const { api } = apiFixture(messages);
    const result = await readOpenCodeHistory(api, { sessionId, pageSize: 2 });
    expect(result.messages).toEqual(messages);
    expect(result).toMatchObject({ headId: "msg_e", forwardCursor: "prev:msg_e" });
    expect(api.getHistoryPage.mock.calls.map(([, options]) => ({ cursor: options?.cursor, order: options?.order, limit: options?.limit }))).toEqual([
      { cursor: undefined, order: "desc", limit: 1 }, { cursor: undefined, order: "asc", limit: 2 },
      { cursor: "next:msg_b", order: undefined, limit: 2 }, { cursor: "next:msg_d", order: undefined, limit: 2 },
    ]);
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_b", "msg_d", "msg_e"]);
  });

  it("finishes a finite cut while new messages append and the captured head gains full text", async () => {
    const head = assistant("msg_head");
    const { api, state } = apiFixture([user("msg_a"), head]);
    const original = api.getHistoryPage.getMockImplementation()!;
    api.getHistoryPage.mockImplementation(async (...args) => {
      if (args[1]?.order === "asc") state.messages.push(idle("msg_later"));
      return original(...args);
    });
    api.getMessage.mockImplementation(async () => assistant("msg_head", { content: [{ type: "text", text: "Final replacement" }] }));
    expect((await readOpenCodeHistory(api, { sessionId })).messages).toEqual([user("msg_a"), head]);
  });

  it("validates an empty finite cut without inventing a cursor", async () => {
    const { api } = apiFixture([]);
    expect(await readOpenCodeHistory(api, { sessionId })).toMatchObject({ messages: [], records: 0 });
    expect(api.getHistoryPage).toHaveBeenCalledTimes(2);
    expect(api.getMessage).not.toHaveBeenCalled();
  });

  it("refreshes a finite head through reverse-ordered forward pages and retains the completed prefix", async () => {
    const messages = [user("msg_a"), idle("msg_b"), user("msg_active"), assistant("msg_answer")];
    const { api, state } = apiFixture(messages);
    const before = await readOpenCodeHistory(api, { sessionId });
    api.getMessage.mockClear(); api.getHistoryPage.mockClear();
    state.messages[3] = assistant("msg_answer", { time: { created: 200, streamed: 210, completed: 250 }, content: [{ type: "text", text: "full" }] });
    state.messages.push(user("msg_steer"), idle("msg_settled"), user("msg_next"), assistant("msg_next_answer"));
    const refreshed = await refreshOpenCodeHistory(api, before, { sessionId, pageSize: 2 });
    expect(refreshed.messages).toEqual(state.messages);
    expect(refreshed.decodedBytes).toBeGreaterThan(before.decodedBytes);
    expect(api.getMessage.mock.calls.map(([, id]) => id)).not.toContain("msg_a");
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toContain("msg_answer");
    expect(api.getHistoryPage.mock.calls.map(([, options]) => options?.cursor)).toEqual([undefined, "prev:msg_answer", "prev:msg_settled"]);
    expect(refreshed.forwardCursor).toBe("prev:msg_next_answer");
  });

  it("rebudgets retained storage between acquisitions without replaying lifetime read charges", async () => {
    const { api } = apiFixture([user("msg_a"), idle("msg_b")]);
    const first = await readOpenCodeHistory(api, { sessionId });
    expect(first.retainedDecodedBytes).toBe(Buffer.byteLength(JSON.stringify(first.messages)));
    const next = restartOpenCodeHistoryAcquisition(first);
    expect(next.messages).toBe(first.messages);
    expect(next.decodedBytes).toBe(first.retainedDecodedBytes);
    expect(next.records).toBe(2);
    expect(next.decodedBytes).toBeLessThan(first.decodedBytes);
    const refreshed = await refreshOpenCodeHistory(api, next, { sessionId });
    expect(refreshed.retainedDecodedBytes).toBe(first.retainedDecodedBytes);
  });

  it.each(["user", "running read", "completed read"])("acquires and refreshes a maximal image %s head with a same-size drained event", async kind => {
    const data = Buffer.alloc(16 * 1024 * 1024).toString("base64");
    const head = kind === "user"
      ? parseOpenCodeNativeMessage({ id: "msg_image_head", type: "user", text: "Inspect", time: { created: 200 },
        files: [{ mime: "image/png", data, name: "image.png", source: { type: "inline" } }] })
      : assistant("msg_image_head", { content: [{ type: "tool", id: "tool_image", name: "read",
        state: { status: "completed", input: { path: "/workspace/image.png" }, content: [
          { type: "text", text: "Image read successfully" },
          { type: "file", mime: "image/png", uri: `data:image/png;base64,${data}`, name: "/workspace/image.png" },
        ] }, time: { created: 200, completed: 210 } }],
        time: { created: 200, streamed: 205, ...(kind === "completed read" ? { completed: 220 } : {}) } });
    const { api } = apiFixture([head]);
    const eventBytes = Buffer.byteLength(JSON.stringify(head)) + 1024;
    let drainedBytes = 0;
    const original = api.getHistoryPage.getMockImplementation()!;
    api.getHistoryPage.mockImplementation(async (...args) => {
      const page = await original(...args);
      drainedBytes = eventBytes;
      return page;
    });
    const input = { sessionId, additionalUsage: () => ({ decodedBytes: drainedBytes, records: drainedBytes ? 1 : 0 }) };
    expect(OPENCODE_HISTORY_LIMITS.decodedBytes).toBe(96 * 1024 * 1024);
    const acquired = await readOpenCodeHistory(api, input);
    expect(acquired.messages.map(message => message.id)).toEqual([head.id]);
    expect(acquired.decodedBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(acquired.decodedBytes).toBeLessThan(OPENCODE_HISTORY_LIMITS.decodedBytes);
    drainedBytes = 0;
    const refreshed = await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(acquired), input);
    expect(refreshed.messages.map(message => message.id)).toEqual([head.id]);
    expect(refreshed.decodedBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(refreshed.decodedBytes).toBeLessThan(OPENCODE_HISTORY_LIMITS.decodedBytes);
  });

  it.each([50, 1_000])("refreshes only mutable records and the head in an open period with %i settled steps", async steps => {
    const shell = parseOpenCodeNativeMessage({ id: "msg_background", type: "shell", shellID: "sh_background", status: "running", command: "background", time: { created: 200 } });
    const compaction = parseOpenCodeNativeMessage({ id: "msg_compaction", type: "compaction", status: "running", reason: "manual", summary: "", recent: "", time: { created: 200 } });
    const settled = Array.from({ length: steps }, (_, index) => [
      user(`msg_user_${index}`),
      assistant(`msg_answer_${index}`, { time: { created: 200, streamed: 220, completed: 250 }, content: [
        { type: "tool", id: `tool_${index}`, name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "large tool result ".repeat(100) }] }, time: { created: 210, completed: 220 } },
        { type: "text", text: "completed step" },
      ] }),
    ]).flat();
    const head = parseOpenCodeNativeMessage({ id: "msg_setting_head", type: "model-switched", model: { providerID: "probe", id: "next" }, time: { created: 400 } });
    const { api, state } = apiFixture([shell, idle("msg_old_idle"), ...settled, assistant("msg_mutable"), compaction, head]);
    const before = await readOpenCodeHistory(api, { sessionId });
    api.getHistoryPage.mockClear(); api.getMessage.mockClear();
    state.messages[0] = parseOpenCodeNativeMessage({ ...shell, status: "exited", exit: 0, time: { created: 200, completed: 500 } });
    state.messages[state.messages.length - 3] = assistant("msg_mutable", { content: [{ type: "text", text: "full answer" }], time: { created: 200, completed: 500 } });
    state.messages[state.messages.length - 2] = parseOpenCodeNativeMessage({ ...compaction, status: "completed", summary: "summary", recent: "recent" });
    const refreshed = await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(before), { sessionId });
    expect(refreshed.messages).toEqual(state.messages);
    expect(api.getHistoryPage.mock.calls.map(([, options]) => ({ order: options?.order, limit: options?.limit }))).toEqual([{ order: "desc", limit: 1 }]);
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_background", "msg_mutable", "msg_compaction", "msg_setting_head"]);
    for (let index = 1; index < settled.length + 2; index++) expect(refreshed.messages[index]).toBe(before.messages[index]);

    // Their settlement removes them from later refresh work, even though this
    // busy period remains open and its completed steps are still retained.
    api.getHistoryPage.mockClear(); api.getMessage.mockClear();
    state.messages.push(assistant("msg_new_head"));
    const appended = await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(refreshed), { sessionId });
    expect(appended.messages).toEqual(state.messages);
    expect(api.getHistoryPage).toHaveBeenCalledTimes(2);
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_setting_head", "msg_new_head"]);
    api.getHistoryPage.mockClear(); api.getMessage.mockClear();
    await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(appended), { sessionId });
    expect(api.getHistoryPage).toHaveBeenCalledOnce();
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_new_head"]);
  });

  it("refreshes mutable background records before the old idle and fails if rewind removed its head", async () => {
    const shell = parseOpenCodeNativeMessage({ id: "msg_shell", type: "shell", shellID: "sh_test", status: "running", command: "background", time: { created: 200 } });
    const { api, state } = apiFixture([shell, idle("msg_idle")]);
    const before = await readOpenCodeHistory(api, { sessionId });
    state.messages[0] = parseOpenCodeNativeMessage({ ...shell, status: "exited", exit: 0, time: { created: 200, completed: 400 } });
    expect((await refreshOpenCodeHistory(api, before, { sessionId })).messages[0]).toMatchObject({ status: "exited" });
    state.messages = [user("msg_rewind")];
    await expect(refreshOpenCodeHistory(api, before, { sessionId })).rejects.toMatchObject({ reason: "invalidated" });
    await expect(refreshOpenCodeHistory(api, before, { sessionId: "ses_foreign" })).rejects.toMatchObject({ reason: "invalidated" });
  });

  it("refetches exact dirty settled records without rereading the open suffix and invalidates a reopened retry anchor", async () => {
    const complete = assistant("msg_retry", { error: { type: "ProviderError", message: "retryable failure" }, time: { created: 200, completed: 250 } });
    const suffix = Array.from({ length: 500 }, (_, index) => user(`msg_suffix_${index}`));
    const { api, state } = apiFixture([complete, ...suffix]);
    const before = await readOpenCodeHistory(api, { sessionId });
    api.getMessage.mockClear(); api.getHistoryPage.mockClear();
    state.messages[0] = assistant("msg_retry", { time: { created: 200, completed: 250 }, content: [{ type: "text", text: "updated full value" }] });
    const dirtyMessageIds = new Set(["msg_retry"]);
    const updated = await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(before), { sessionId, dirtyMessageIds });
    expect(api.getHistoryPage).toHaveBeenCalledOnce();
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_retry", "msg_suffix_499"]);
    expect(updated.messages[0]).toBe(state.messages[0]);
    expect(updated.messages[1]).toBe(before.messages[1]);
    state.messages[0] = assistant("msg_retry", { time: { created: 400 } });
    await expect(refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(updated), { sessionId, dirtyMessageIds }))
      .rejects.toMatchObject({ reason: "invalidated" });
  });

  it.each(["running", "streaming"] as const)("keeps a completed assistant with %s tools mutable before later records", async status => {
    const tool = { type: "tool", id: "tool_pending", name: "read", state: status === "running"
      ? { status, input: {}, metadata: {} } : { status, input: "" }, time: { created: 210 } };
    const message = assistant("msg_tools", { content: [tool], time: { created: 200, completed: 250 } });
    const { api, state } = apiFixture([message, user("msg_later")]);
    const before = await readOpenCodeHistory(api, { sessionId }); api.getMessage.mockClear();
    state.messages[0] = assistant("msg_tools", { time: { created: 200, completed: 250 }, content: [
      { ...tool, state: { status: "completed", input: {}, content: [{ type: "text", text: "late tool result" }] }, time: { created: 210, completed: 300 } },
    ] });
    const updated = await refreshOpenCodeHistory(api, restartOpenCodeHistoryAcquisition(before), { sessionId });
    expect(api.getMessage.mock.calls.map(([, id]) => id)).toEqual(["msg_tools", "msg_later"]);
    expect(updated.messages[0]).toEqual(state.messages[0]);
  });

  it.each(["empty", "duplicate", "missing_anchor", "changed_anchor", "reused_cursor"] as const)("rejects %s continuity rather than installing a truncated prefix", async fault => {
    const { api } = apiFixture([user("msg_a"), user("msg_b"), idle("msg_c")]);
    const original = api.getHistoryPage.getMockImplementation()!;
    api.getHistoryPage.mockImplementation(async (...args) => {
      if (args[1]?.cursor) {
        if (fault === "empty") return { data: [], cursor: {}, decodedBytes: 23 };
        if (fault === "duplicate") return { data: [user("msg_a")], cursor: { next: "duplicate" }, decodedBytes: 100 };
        if (fault === "reused_cursor") return { data: [user("msg_b")], cursor: { next: "next:msg_a" }, decodedBytes: 100 };
      }
      return original(...args);
    });
    if (fault === "missing_anchor") api.getMessage.mockRejectedValue(new OpenCodeRuntimeError("opencode_native_not_found"));
    if (fault === "changed_anchor") api.getMessage.mockResolvedValue(idle("msg_a"));
    await expect(readOpenCodeHistory(api, { sessionId, pageSize: 1 })).rejects.toMatchObject({ reason: "invalidated", retryable: true });
  });

  it("does not start requests after cancellation and aborts a stalled request without waiting for its carrier", async () => {
    const { api } = apiFixture([]);
    const before = new AbortController(); before.abort();
    await expect(readOpenCodeHistory(api, { sessionId, signal: before.signal })).rejects.toMatchObject({ reason: "cancelled" });
    expect(api.getHistoryPage).not.toHaveBeenCalled();
    api.getHistoryPage.mockImplementation(async () => new Promise(() => undefined));
    const during = new AbortController();
    const read = readOpenCodeHistory(api, { sessionId, signal: during.signal });
    await Promise.resolve(); during.abort();
    await expect(read).rejects.toMatchObject({ reason: "cancelled" });
    expect(api.getHistoryPage.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });

  it("enforces the fixed time budget without waiting for a provider to honor cancellation", async () => {
    vi.useFakeTimers();
    const { api } = apiFixture([]);
    api.getHistoryPage.mockImplementation(async () => new Promise(() => undefined));
    const read = readOpenCodeHistory(api, { sessionId }).catch(error => error);
    await vi.advanceTimersByTimeAsync(OPENCODE_HISTORY_LIMITS.milliseconds);
    expect(await read).toMatchObject({ reason: "time", retryable: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts all pages, validation reads and buffered replacements against exact byte and record boundaries", async () => {
    const { api } = apiFixture([user("msg_a"), idle("msg_b")]);
    const complete = await readOpenCodeHistory(api, { sessionId });
    const exact = { decodedBytes: complete.decodedBytes, records: complete.records };
    await expect(readOpenCodeHistory(api, { sessionId, limits: exact })).resolves.toMatchObject(exact);
    await expect(readOpenCodeHistory(api, { sessionId, limits: { ...exact, decodedBytes: exact.decodedBytes - 1 } })).rejects.toMatchObject({ reason: "bytes", retryable: false });
    await expect(readOpenCodeHistory(api, { sessionId, limits: { ...exact, records: exact.records - 1 } })).rejects.toMatchObject({ reason: "records", retryable: false });
    await expect(readOpenCodeHistory(api, { sessionId, limits: exact, additionalUsage: () => ({ decodedBytes: 1, records: 0 }) })).rejects.toMatchObject({ reason: "bytes" });
    await expect(readOpenCodeHistory(api, { sessionId, limits: exact, additionalUsage: () => ({ decodedBytes: 0, records: 1 }) })).rejects.toMatchObject({ reason: "records" });
  });

  it("maps native response overflow and malformed wire values to terminal bounded failures", async () => {
    const { api } = apiFixture([]);
    api.getHistoryPage.mockRejectedValueOnce(new OpenCodeNativeReadLimitError("response_bytes"));
    await expect(readOpenCodeHistory(api, { sessionId })).rejects.toMatchObject({ reason: "response_bytes", retryable: false });
    api.getHistoryPage.mockRejectedValueOnce(new OpenCodeNativeProtocolError());
    await expect(readOpenCodeHistory(api, { sessionId })).rejects.toMatchObject({ reason: "invalid", retryable: false });
  });

  it("checks the caller's generation and mutation fence across native awaits", async () => {
    const { api } = apiFixture([user("msg_a")]);
    let current = true;
    const original = api.getHistoryPage.getMockImplementation()!;
    api.getHistoryPage.mockImplementation(async (...args) => { const page = await original(...args); current = false; return page; });
    await expect(readOpenCodeHistory(api, { sessionId, assertCurrent: () => { if (!current) throw new Error("generation_revoked"); } })).rejects.toThrow("generation_revoked");
    expect(api.getHistoryPage).toHaveBeenCalledOnce();
  });

  it("uses default 50-message pages and refuses enlarged adapter limits", async () => {
    const { api } = apiFixture([user("msg_a")]);
    await readOpenCodeHistory(api, { sessionId });
    expect(api.getHistoryPage.mock.calls[1]![1]!.limit).toBe(50);
    for (const pageSize of [0, 201, 1.5]) await expect(readOpenCodeHistory(api, { sessionId, pageSize })).rejects.toMatchObject({ reason: "invalid" });
    await expect(readOpenCodeHistory(api, { sessionId, limits: { records: 100_001 } })).rejects.toMatchObject({ reason: "invalid" });
  });
});

describe("OpenCode normalized retained history", () => {
  it("keeps the opening coordinate stable through steering and native settlement without inventing application provenance", () => {
    const initial = [user("msg_user"), assistant("msg_answer")];
    const active = projection(initial, { activity: "running" });
    const settled = projection([...initial, user("msg_steer"), idle("msg_idle")]);
    const id = active.activeBackendTurnId!;
    expect(id).toBe(openCodeHistoryTurnId(sessionId, "msg_user"));
    expect(settled.orderedBackendTurnIds).toEqual([id]);
    expect(settled.turnsById[id]).toMatchObject({ status: "completed", endedBy: "agent_settled" });
    expect(settled.turnsById[id]!.completionCorrelations).toBeUndefined();
    for (const item of Object.values(settled.itemsById)) expect(item).not.toHaveProperty("deliveryOperationId");
    expect(backendConversationSnapshotSchema.safeParse(active.snapshot().snapshot).success).toBe(true);
  });

  it("retains settings openings and empty periods without claiming model work or running ownership", () => {
    const setting = parseOpenCodeNativeMessage({ id: "msg_setting", type: "model-switched", model: { providerID: "probe", id: "second" }, time: { created: 301 } });
    const initial = [user("msg_a"), idle("msg_b"), idle("msg_empty"), setting];
    const pending = projection(initial);
    const [first, empty, open] = pending.orderedBackendTurnIds;
    expect(pending.turnsById[empty!]!.orderedBackendItemIds).toEqual([]);
    expect(pending.turnsById[open!]!.status).toBe("in_progress");
    expect(pending.activeBackendTurnId).toBeUndefined(); expect(pending.runState).toBe("idle");
    const settled = projection([...initial, user("msg_next"), idle("msg_end")]);
    expect(settled.orderedBackendTurnIds).toEqual([first, empty, open]);
    expect(settled.turnsById[open!]!.status).toBe("completed");
  });

  it.each(["interrupted", "failed"] as const)("preserves %s idle evidence and only observed unfinished text", outcome => {
    const records = [user("msg_a"), assistant("msg_partial"), idle("msg_end", outcome)];
    const result = projection(records, { observedParts: new Map([[openCodeHistoryPartKey("msg_partial", "text", 0), { text: "observed prefix", completed: false }]]) });
    expect(result.turnsById[result.orderedBackendTurnIds[0]!]!.status).toBe(outcome);
    expect(result.itemsById[openCodeHistoryItemId("msg_partial", 0)]).toMatchObject({ status: outcome, markdown: { text: "observed prefix" } });
    expect(result.runState).toBe(outcome === "failed" ? "failed" : "idle");
  });

  it("keeps an orphaned unfinished tail nonterminal after owner loss", () => {
    const result = projection([user("msg_a"), assistant("msg_b")], { activity: "unknown" });
    expect(result.runState).toBe("disconnected"); expect(result.activeBackendTurnId).toBeUndefined();
    expect(result.turnsById[result.orderedBackendTurnIds[0]!]!.status).toBe("in_progress");
    expect(result.itemsById[openCodeHistoryItemId("msg_b", 0)]).toMatchObject({ status: "streaming", markdown: { text: "" } });
  });

  it("replaces observed deltas with full final values including an authoritative empty result", () => {
    const key = openCodeHistoryItemId("msg_answer", 0);
    const partKey = openCodeHistoryPartKey("msg_answer", "text", 0);
    const options = { activity: "running" as const, observedParts: new Map([[partKey, { text: "OLD PREFIX", completed: false }]]) };
    expect(projection([assistant("msg_answer")], options).itemsById[key]).toMatchObject({ status: "streaming", markdown: { text: "OLD PREFIX" } });
    expect(projection([assistant("msg_answer", { content: [{ type: "text", text: "REPLACEMENT" }] })], options).itemsById[key]).toMatchObject({ status: "completed", markdown: { text: "REPLACEMENT" } });
    expect(projection([assistant("msg_answer", { time: { created: 200, streamed: 201 } })], options).itemsById[key]).toMatchObject({ status: "completed", markdown: { text: "" } });
    options.observedParts.set(partKey, { text: "", completed: true });
    expect(projection([assistant("msg_answer")], options).itemsById[key]).toMatchObject({ status: "completed", markdown: { text: "" } });
  });

  it("keeps native text and reasoning ordinal namespaces separate around intervening tools", () => {
    const message = assistant("msg_mixed", { content: [
      { type: "reasoning", text: "" },
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: {}, metadata: {} }, time: { created: 201 } },
      { type: "text", text: "" }, { type: "reasoning", text: "" }, { type: "text", text: "" },
    ] });
    const observedParts = new Map([
      [openCodeHistoryPartKey("msg_mixed", "reasoning", 0), { text: "reason-zero", completed: true }],
      [openCodeHistoryPartKey("msg_mixed", "reasoning", 1), { text: "reason-one", completed: false }],
      [openCodeHistoryPartKey("msg_mixed", "text", 0), { text: "text-zero", completed: true }],
      [openCodeHistoryPartKey("msg_mixed", "text", 1), { text: "text-one", completed: false }],
    ]);
    const result = projection([message], { activity: "running", observedParts });
    for (const [index, text, status] of [[0, "reason-zero", "completed"], [2, "text-zero", "completed"], [3, "reason-one", "streaming"], [4, "text-one", "streaming"]] as const) {
      expect(result.itemsById[openCodeHistoryItemId("msg_mixed", index)]).toMatchObject({ markdown: { text }, status });
    }
  });

  it("projects ordered reasoning, tool states, shell, compaction and settings from native records", () => {
    const messages = [user("msg_user"), assistant("msg_assistant", { content: [
      { type: "reasoning", text: "Reason", time: { created: 201, completed: 202 } },
      { type: "tool", id: "tool-1", name: "read", state: { status: "completed", input: { path: "file" }, content: [{ type: "text", text: "result" }] }, time: { created: 202, completed: 203 } },
      { type: "tool", id: "tool-2", name: "other", state: { status: "running", input: {}, metadata: {} }, time: { created: 204 } },
      { type: "text", text: "Answer" },
    ] }),
    parseOpenCodeNativeMessage({ id: "msg_shell", type: "shell", shellID: "sh_one", command: "echo output", status: "exited", exit: 0, output: { output: "output", cursor: 6, size: 6, truncated: false }, time: { created: 205, completed: 206 } }),
    parseOpenCodeNativeMessage({ id: "msg_compact", type: "compaction", status: "completed", reason: "manual", summary: "summary", recent: "recent", time: { created: 207 } }),
    parseOpenCodeNativeMessage({ id: "msg_agent", type: "agent-switched", agent: "review", time: { created: 208 } }), idle("msg_idle")];
    const result = projection(messages); const page = result.history({ limit: 10 });
    expect(Object.values(page.itemsById).map(item => item.semanticKind)).toEqual(["user_message", "reasoning", "tool", "tool", "assistant_message", "command", "compaction", "notice"]);
    expect(Object.values(page.itemsById).map(item => item.sourceOrder)).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
    expect(backendHistoryPageSchema.safeParse(page).success).toBe(true);
  });

  it("derives failure only from idle outcome and scrubs the selected diagnostic", () => {
    const failedStep = assistant("msg_failed", { error: { type: "ProviderError", message: "Bearer native-secret failed" }, time: { created: 200, completed: 250 } });
    const recovered = projection([user("msg_user"), failedStep, idle("msg_end")]);
    expect(recovered.turnsById[recovered.orderedBackendTurnIds[0]!]!.status).toBe("completed");
    const failed = projection([user("msg_user"), failedStep, idle("msg_end", "failed")]);
    expect(failed.turnsById[failed.orderedBackendTurnIds[0]!]!.failure).toEqual({ message: { text: "Bearer [redacted] failed" } });
  });

  it("pages whole turns and seeks an older turn while the head is active", () => {
    const messages = Array.from({ length: 15 }, (_, index) => [user(`msg_u${index}`), idle(`msg_i${index}`)]).flat();
    messages.push(user("msg_active"));
    const result = projection(messages, { activity: "running" });
    const first = result.snapshot({ limit: 3 });
    expect(first.snapshot.orderedBackendTurnIds).toHaveLength(3);
    const older = result.history({ cursor: first.previousCursor, limit: 20 });
    expect(older.orderedBackendTurnIds).toHaveLength(13); expect(older.previousCursor).toBeUndefined();
    const id = result.orderedBackendTurnIds[0]!;
    expect(result.locateTurn({ maximumTurnCandidates: 16, matchesBackendTurnId: value => value === id })).toMatchObject({ status: "found", page: { orderedBackendTurnIds: [id] } });
    expect(result.locateTurn({ maximumTurnCandidates: 15, matchesBackendTurnId: value => value === id })).toEqual({ status: "search_limit_reached" });
    expect(result.locateTurn({ maximumTurnCandidates: 16, matchesBackendTurnId: () => false })).toEqual({ status: "not_found" });
  });

  it("binds cursors to scope, generation, stable anchors and finite prefix while allowing later appends", () => {
    const messages = [user("msg_a"), idle("msg_b"), user("msg_c"), idle("msg_d")];
    const result = projection(messages); const cursor = result.snapshot({ limit: 1 }).previousCursor!;
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(projection([...messages, user("msg_e")]).history({ cursor, limit: 10 }).orderedBackendTurnIds).toEqual(result.orderedBackendTurnIds.slice(0, 1));
    for (const changed of [projection(messages, { generation: "owner-2" }), projection(messages, { bindingScope: ["foreign"] }),
      projection([user("msg_rewind"), ...messages.slice(1)]), projection([user("msg_a", "replaced"), ...messages.slice(1)])]) {
      expect(() => changed.history({ cursor, limit: 10 })).toThrow(expect.objectContaining({ reason: "cursor" }));
    }
    expect(() => result.history({ cursor: "foreign-cursor", limit: 10 })).toThrow(expect.objectContaining({ reason: "cursor" }));
  });

  it("does not reuse parent turn identities for regenerated native fork records", () => {
    const parent = projection([user("msg_parent"), idle("msg_parent_end")]);
    const child = new OpenCodeHistoryProjection({ ...retained([user("msg_child"), idle("msg_child_end")]), sessionId: "ses_fork" }, identity);
    expect(child.orderedBackendTurnIds[0]).not.toBe(parent.orderedBackendTurnIds[0]);
  });

  it("patches only affected live parts and reuses closed projections on native catch-up", () => {
    const closed = [user("msg_old", "old ".repeat(10_000)), idle("msg_old_end")];
    const native = assistant("msg_live", { content: [{ type: "reasoning", text: "" }, { type: "text", text: "" }] });
    const messages = [...closed, user("msg_new"), native];
    const value = projection(messages, { activity: "running" });
    const oldItem = value.itemsById[openCodeHistoryItemId("msg_old")];
    const key = openCodeHistoryPartKey("msg_live", "text", 0);
    const observations = new Map([[key, { text: "streamed prefix", completed: false }]]);
    const changed = value.applyObservedParts({ observedParts: observations, changedPartKeys: new Set([key]) });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ backendItemId: openCodeHistoryItemId("msg_live", 1), markdown: { text: "streamed prefix" }, sourceOrder: 2 });
    expect(value.itemsById[openCodeHistoryItemId("msg_old")]).toBe(oldItem);
    expect(value.snapshot().snapshot.itemsById[openCodeHistoryItemId("msg_live", 1)]).toEqual(changed[0]);
    expect(value.applyObservedParts({ observedParts: observations })).toEqual([]);
    const next = new OpenCodeHistoryProjection(retained([...messages, idle("msg_end")]), { ...identity, previous: value, observedParts: observations });
    expect(next.itemsById[openCodeHistoryItemId("msg_old")]).toBe(oldItem);
    expect(next.turnsById[value.orderedBackendTurnIds[0]!]).toBe(value.turnsById[value.orderedBackendTurnIds[0]!]);
    value.updateRuntimeState({ activity: "unknown", backgroundActivity: { state: "known", agents: 1, commands: 2, other: 0 } });
    expect(value.snapshot().snapshot).toMatchObject({ runState: "disconnected", backgroundActivity: { agents: 1, commands: 2 } });
  });

  it.each(["open", "closed"] as const)("refreshes private correlations in an unchanged %s cached period", state => {
    const messages = [user("msg_first"), user("msg_steer"), user("msg_native")];
    if (state === "closed") messages.push(idle("msg_idle"));
    const before = projection(messages, { activity: state === "open" ? "running" : "idle" });
    const turn = before.orderedBackendTurnIds[0]!;
    expect(before.turnsById[turn]!.completionCorrelations).toBeUndefined();
    const proofs = new Map([["msg_first", "ordinary-operation"], ["msg_steer", "steer-operation"]]);
    const after = projection(messages, { previous: before, deliveryCorrelations: proofs });
    expect(after.turnsById[turn]!.completionCorrelations).toEqual(["ordinary-operation", "steer-operation"]);
    expect(after.itemsById[openCodeHistoryItemId("msg_first")]).toMatchObject({ deliveryOperationId: "ordinary-operation" });
    expect(after.itemsById[openCodeHistoryItemId("msg_steer")]).toMatchObject({ deliveryOperationId: "steer-operation" });
    expect(after.itemsById[openCodeHistoryItemId("msg_native")]).not.toHaveProperty("deliveryOperationId");
    expect(after.itemsById[openCodeHistoryItemId("msg_first")]).not.toBe(before.itemsById[openCodeHistoryItemId("msg_first")]);
    const revoked = projection(messages, { previous: after, deliveryCorrelations: new Map() });
    expect(revoked.turnsById[turn]!.completionCorrelations).toBeUndefined();
    expect(revoked.itemsById[openCodeHistoryItemId("msg_first")]).not.toHaveProperty("deliveryOperationId");
    expect(before.turnsById[turn]!.completionCorrelations).toBeUndefined();
  });

  it("never infers correlation from native metadata or unrelated non-user records", () => {
    const forged = parseOpenCodeNativeMessage({ ...user("msg_external"), metadata: {
      applicationOperationId: "forged-operation", sedes: { operationId: "forged-operation" },
    } });
    const value = projection([forged, assistant("msg_assistant", { time: { created: 200, completed: 250 } }), idle("msg_idle")], {
      deliveryCorrelations: new Map([["msg_assistant", "not-a-user-operation"], ["msg_absent", "absent-operation"]]),
    });
    expect(value.turnsById[value.orderedBackendTurnIds[0]!]!.completionCorrelations).toBeUndefined();
    expect(value.itemsById[openCodeHistoryItemId("msg_external")]).not.toHaveProperty("deliveryOperationId");
  });

  it("reuses settled message items inside an open period while refreshing mutable work and settlement", () => {
    const settled = [user("msg_user"), assistant("msg_finished", {
      time: { created: 200, streamed: 220, completed: 250 }, content: [
        { type: "tool", id: "tool_finished", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "settled tool output ".repeat(1_000) }] }, time: { created: 210, completed: 220 } },
        { type: "text", text: "finished answer" },
      ],
    })];
    const mutable = (path: string) => assistant("msg_live", { content: [
      { type: "text", text: "" },
      { type: "tool", id: "tool_live", name: "read", state: { status: "running", input: { path }, metadata: {} }, time: { created: 260 } },
    ] });
    const key = openCodeHistoryPartKey("msg_live", "text", 0);
    const before = projection([...settled, mutable("old")], { activity: "running", observedParts: new Map([[key, { text: "old prefix", completed: false }]]) });
    const messages = [...settled, mutable("new")];
    const options = { ...identity, activity: "running" as const, observedParts: new Map([[key, { text: "new prefix", completed: false }]]) };
    const next = new OpenCodeHistoryProjection(retained(messages), { ...options, previous: before });
    const fresh = new OpenCodeHistoryProjection(retained(messages), options);
    for (const id of [openCodeHistoryItemId("msg_user"), openCodeHistoryItemId("msg_finished", 0), openCodeHistoryItemId("msg_finished", 1)]) {
      expect(next.itemsById[id]).toBe(before.itemsById[id]);
    }
    expect(next.itemsById[openCodeHistoryItemId("msg_live", 0)]).not.toBe(before.itemsById[openCodeHistoryItemId("msg_live", 0)]);
    expect(next.itemsById[openCodeHistoryItemId("msg_live", 0)]).toMatchObject({ status: "streaming", markdown: { text: "new prefix" } });
    expect(next.snapshot()).toEqual(fresh.snapshot());

    // A mutable message must also reproject when only its observed overlay
    // changes, even if the native DTO instance itself has not changed.
    const observations = new Map([[key, { text: "latest prefix", completed: false }]]);
    const observed = new OpenCodeHistoryProjection(retained(messages), { ...options, observedParts: observations, previous: next });
    expect(observed.itemsById[openCodeHistoryItemId("msg_live", 0)]).toMatchObject({ markdown: { text: "latest prefix" } });
    const endedMessages = [...messages, idle("msg_interrupted", "interrupted")];
    const endedOptions = { ...identity, observedParts: observations };
    const ended = new OpenCodeHistoryProjection(retained(endedMessages), { ...endedOptions, previous: observed });
    expect(ended.snapshot()).toEqual(new OpenCodeHistoryProjection(retained(endedMessages), endedOptions).snapshot());
    expect(ended.turnsById[ended.orderedBackendTurnIds[0]!]!.status).toBe("interrupted");
    expect(ended.itemsById[openCodeHistoryItemId("msg_finished", 0)]!.status).toBe("completed");
    expect(ended.itemsById[openCodeHistoryItemId("msg_live", 0)]!.status).toBe("interrupted");
    // An extensionless read lacks a terminal result needed to choose its stable
    // ordinary-tool or viewed-image item kind. Its source slots stay reserved.
    expect(ended.itemsById[openCodeHistoryItemId("msg_live", 1)]).toBeUndefined();
  });

  it("rejects an oversized overlay atomically and distinguishes invalid schema from byte overflow", () => {
    const messages = [user("msg_a"), assistant("msg_live")];
    const baseline = projection(messages, { activity: "running" });
    const value = projection(messages, { activity: "running", limits: { decodedBytes: baseline.decodedBytes + 32 } });
    const before = value.itemsById[openCodeHistoryItemId("msg_live", 0)];
    const key = openCodeHistoryPartKey("msg_live", "text", 0);
    expect(() => value.applyObservedParts({ observedParts: new Map([[key, { text: "x".repeat(64), completed: false }]]) }))
      .toThrow(expect.objectContaining({ reason: "bytes", projectionRecovery: "futile" }));
    expect(value.itemsById[openCodeHistoryItemId("msg_live", 0)]).toBe(before);
    expect(() => projection([{ ...user("msg_bad"), time: { created: -8_640_000_000_000_000 } }]))
      .toThrow(expect.objectContaining({ reason: "invalid", projectionRecovery: "futile" }));
  });

  it("charges raw plus normalized memory and rejects oversized whole turns without truncating text", () => {
    const messages = [user("msg_text", "full authoritative text"), idle("msg_end")];
    const normal = projection(messages);
    expect(() => projection(messages, { limits: { decodedBytes: normal.decodedBytes - 1 } })).toThrow(expect.objectContaining({ reason: "bytes", retryable: false }));
    expect(projection(messages, { limits: { decodedBytes: normal.decodedBytes } }).history({ limit: 1 }).orderedBackendTurnIds).toEqual(normal.orderedBackendTurnIds);
    for (const length of [MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES, MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - 100]) {
      // Isolate the normalized whole-turn bound from the earlier native JSON
      // envelope bound, which now rejects an individual record this large.
      expect(() => projection([{ ...user("msg_huge"), text: "x".repeat(length) } as OpenCodeNativeMessage, idle("msg_end")]))
        .toThrow(expect.objectContaining({ reason: "turn_bytes", retryable: false }));
    }
  });

  it("selects fewer large whole turns to fit one page, preserving complete message text", () => {
    const text = "x".repeat(9 * 1024 * 1024);
    const result = projection([user("msg_large_a", text), idle("msg_end_a"), user("msg_large_b", text), idle("msg_end_b")]);
    const latest = result.snapshot();
    expect(latest.snapshot.orderedBackendTurnIds).toHaveLength(1);
    const earlier = result.history({ cursor: latest.previousCursor, limit: 10 });
    expect(earlier.orderedBackendTurnIds).toHaveLength(1); expect(earlier.previousCursor).toBeUndefined();
    expect(earlier.itemsById[openCodeHistoryItemId("msg_large_a")]).toMatchObject({ content: [{ kind: "text", text: { text } }] });
  });

  it("enforces record, time and item limits before returning any projected window", () => {
    const source = retained([user("msg_a")]);
    expect(() => new OpenCodeHistoryProjection({ ...source, records: 100_001 }, identity)).toThrow(expect.objectContaining({ reason: "records", retryable: false }));
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(120_000);
    try { expect(() => projection([])).toThrow(expect.objectContaining({ reason: "time", retryable: false })); }
    finally { clock.mockRestore(); }
    const content = Array.from({ length: 20_001 }, () => ({ type: "text", text: "" }));
    expect(() => projection([assistant("msg_too_many", { content })])).toThrow(expect.objectContaining({ reason: "turn_items", retryable: false }));
  });

  it("rejects malformed duplicate identity and observes cancellation during projection, paging and candidate search", () => {
    expect(() => projection([user("msg_dup"), user("msg_dup")])).toThrow(expect.objectContaining({ reason: "invalid" }));
    const controller = new AbortController(); controller.abort();
    expect(() => projection([], { signal: controller.signal })).toThrow(expect.objectContaining({ reason: "cancelled" }));
    const result = projection([user("msg_a"), idle("msg_b")]);
    expect(() => result.history({ limit: 1, signal: controller.signal })).toThrow(expect.objectContaining({ reason: "cancelled" }));
    expect(() => result.snapshot({ signal: controller.signal })).toThrow(expect.objectContaining({ reason: "cancelled" }));
    const during = new AbortController();
    expect(() => result.locateTurn({ maximumTurnCandidates: 1, signal: during.signal,
      matchesBackendTurnId: () => { during.abort(); return true; } })).toThrow(expect.objectContaining({ reason: "cancelled" }));
  });
});
