import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeSessions } from "../../src/server/backends/codex/runtime/codex-runtime-sessions.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { codexRuntimeMethod } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";

function thread(id = "thread", active = false) {
  return {
    id, extra: {}, sessionId: "session", forkedFromId: null, parentThreadId: null,
    preview: "A thread", ephemeral: false, section: null, sectionEnteredAt: null,
    projectId: null, historyMode: "legacy", modelProvider: "openai", model: null,
    reasoningEffort: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100, status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
    path: "/provider/rollout.jsonl", cwd: "/workspace", cliVersion: "0.153.0",
    source: "appServer", canAcceptDirectInput: true, threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: "Fixture", turns: [],
  };
}
function resumed() {
  return codexRuntimeMethod("thread/resume").decodeResult({
    thread: thread(), model: "gpt-5.6", modelProvider: "openai", serviceTier: "default",
    cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"], instructionSources: [],
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: { id: ":read-only", extends: null }, reasoningEffort: "low",
    multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  });
}
function fixture(answer: (method: string, params: Record<string, unknown>) => unknown) {
  let sequence = 0;
  const request = vi.fn(async (method, params) => ({ result: method.decodeResult(answer(method.method, params)), generation: 1, inboundSequence: ++sequence }));
  const client = new CodexSharedClientFacade({
    current: () => ({ generation: 1, request: async () => undefined as never, requestWithReceipt: request }),
    latestGeneration: () => 1, retireGeneration: async () => {},
  });
  client.updateLifecycle({ state: "ready", generation: 1 });
  return { sessions: new CodexRuntimeSessions(client), request, client };
}

describe("persistent Codex native session recovery", () => {
  it("requires every retained thread to be evicted and idle before retiring the shared process", () => {
    const f = fixture(() => ({}));
    f.sessions.observeResult("thread/resume", { ...resumed(), thread: thread("a") }, 1);
    f.sessions.observeResult("thread/resume", { ...resumed(), thread: thread("b") }, 1);
    f.sessions.evict("a", 1);
    expect(f.sessions.canIdle()).toBe(false);
    f.sessions.evict("b", 0);
    expect(f.sessions.canIdle()).toBe(false);
    f.sessions.evict("b", 1);
    expect(f.sessions.canIdle()).toBe(true);
    f.sessions.observeNotification({ kind: "decoded_notification", generation: 1, sequence: 1,
      method: "turn/started", params: { threadId: "b", turn: { id: "turn" } } } as Parameters<typeof f.sessions.observeNotification>[0]);
    expect(f.sessions.canIdle()).toBe(false);
    f.sessions.observeNotification({ kind: "decoded_notification", generation: 1, sequence: 2,
      method: "turn/completed", params: { threadId: "b", turn: { id: "turn" } } } as Parameters<typeof f.sessions.observeNotification>[0]);
    expect(f.sessions.canIdle()).toBe(true);
    f.sessions.observeResult("thread/resume", { ...resumed(), thread: thread("b") }, 1);
    expect(f.sessions.canIdle()).toBe(false);
  });

  it("interrupts only exact current-generation owned turns without querying fresh inventory", async () => {
    const f = fixture(method => { expect(method).toBe("turn/interrupt"); return {}; });
    for (const id of ["active", "idle", "unknown", "old", "finished"]) {
      f.sessions.observeResult("thread/resume", { ...resumed(), thread: thread(id) }, id === "old" ? 0 : 1);
    }
    const started = (threadId: string, generation = 1) => f.sessions.observeNotification({ kind: "decoded_notification", generation, sequence: 1,
      method: "turn/started", params: { threadId, turn: { id: `${threadId}-turn` } } } as Parameters<typeof f.sessions.observeNotification>[0]);
    started("active"); started("old", 0); started("finished");
    f.sessions.observeNotification({ kind: "decoded_notification", generation: 1, sequence: 2,
      method: "turn/completed", params: { threadId: "finished", turn: { id: "finished-turn" } } } as Parameters<typeof f.sessions.observeNotification>[0]);
    await f.sessions.interruptKnownActiveTurns();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ method: "turn/interrupt" }), { threadId: "active", turnId: "active-turn" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("bounds a wedged owned turn interrupt and does not replay onto a replacement generation", async () => {
    const f = fixture(() => ({}));
    f.sessions.observeResult("thread/resume", resumed(), 1);
    f.sessions.observeNotification({ kind: "decoded_notification", generation: 1, sequence: 1,
      method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } } as Parameters<typeof f.sessions.observeNotification>[0]);
    f.request.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const interrupted = f.sessions.interruptKnownActiveTurns();
      await vi.advanceTimersByTimeAsync(1_000);
      await interrupted;
      expect(f.request).toHaveBeenCalledOnce();
      f.client.updateLifecycle({ state: "ready", generation: 2 });
      await f.sessions.interruptKnownActiveTurns();
      expect(f.request).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("reattaches to live session settings using current native history without thread/resume", async () => {
    const f = fixture((method, params) => {
      expect(method).toBe("thread/read");
      return { thread: { ...thread(), name: params.includeTurns ? "Current history" : "Current metadata" } };
    });
    f.sessions.observeResult("thread/resume", resumed(), 1);
    const result = await f.sessions.reattach("thread", { timeoutMilliseconds: 1000 });
    expect(result?.result).toMatchObject({ model: "gpt-5.6", cwd: "/workspace", thread: { name: "Current history" } });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.map(([method]) => method.method)).toEqual(["thread/read", "thread/read"]);
  });

  it("keeps the first metadata fence when paginated history spans notifications", async () => {
    const f = fixture(method => method === "thread/read"
      ? { thread: { ...thread(), historyMode: "paginated" } }
      : { data: [], nextCursor: null, backwardsCursor: "head" });
    f.sessions.observeResult("thread/resume", resumed(), 1);
    const result = await f.sessions.reattach("thread", { timeoutMilliseconds: 1000 });
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(result?.inboundSequence).toBe(1);
    expect(result?.result).toMatchObject({ turnsBackwardsCursor: "head", itemsBackwardsCursor: "head" });
  });

  it("retries a paginated snapshot when status changes between history reads", async () => {
    let reads = 0;
    const f = fixture(method => method === "thread/read"
      ? { thread: { ...thread("thread", ++reads === 1), historyMode: "paginated" } }
      : { data: [], nextCursor: null, backwardsCursor: "head" });
    f.sessions.observeResult("thread/resume", resumed(), 1);
    const result = await f.sessions.reattach("thread", { timeoutMilliseconds: 1000 });
    expect(f.request).toHaveBeenCalledTimes(8);
    expect(result?.inboundSequence).toBe(5);
    expect(result?.result.thread.status).toEqual({ type: "idle" });
  });

  it("bounds retries when a paginated snapshot never stabilizes", async () => {
    let reads = 0;
    const f = fixture(method => method === "thread/read"
      ? { thread: { ...thread("thread", ++reads % 2 === 1), historyMode: "paginated" } }
      : { data: [], nextCursor: null, backwardsCursor: "head" });
    f.sessions.observeResult("thread/resume", resumed(), 1);
    await expect(f.sessions.reattach("thread", { timeoutMilliseconds: 1000 })).rejects.toThrow("snapshot_changed");
    expect(f.request).toHaveBeenCalledTimes(12);
  });

  it("queries every loaded page and includes activity owned by independent native clients", async () => {
    const f = fixture((method, params) => {
      if (method === "thread/loaded/list") return params.cursor ? { data: ["other"], nextCursor: null } : { data: ["thread"], nextCursor: "next" };
      if (method === "thread/read") return { thread: thread(String(params.threadId), params.threadId === "other") };
      if (method === "thread/goal/get") return { goal: null };
      throw new Error(method);
    });
    f.sessions.observeResult("thread/resume", resumed(), 1);
    expect(f.sessions.activity()).toBe("unknown");
    await f.sessions.refreshActivity();
    expect(f.sessions.activity()).toBe("active");
    expect(f.request.mock.calls.filter(([method]) => method.method === "thread/loaded/list")).toHaveLength(4);
  });

  it("proves an empty external inventory idle and refuses repeated cursors instead of truncating", async () => {
    let looping = false;
    const f = fixture(() => looping ? { data: [], nextCursor: "same" } : { data: [], nextCursor: null });
    await f.sessions.refreshActivity();
    expect(f.sessions.activity()).toBe("idle");
    looping = true;
    await expect(f.sessions.refreshActivity()).rejects.toThrow("inventory_incomplete");
    expect(f.sessions.activity()).toBe("unknown");
  });

  it("rejects a changed loaded set and a provider generation change during history attachment", async () => {
    let calls = 0;
    const f = fixture((method) => {
      if (method === "thread/loaded/list") return { data: ++calls === 1 ? [] : ["late"], nextCursor: null };
      f.client.updateLifecycle({ state: "ready", generation: 2 });
      return { thread: thread() };
    });
    await expect(f.sessions.refreshActivity()).rejects.toThrow("inventory_changed");
    expect(f.sessions.activity()).toBe("unknown");
    f.sessions.observeResult("thread/resume", resumed(), 1);
    await expect(f.sessions.reattach("thread", { timeoutMilliseconds: 1000 })).rejects.toThrow("generation_changed");
  });

  it.each(["notLoaded", "systemError"])("does not treat a loaded thread with %s status as idle", async status => {
    const f = fixture(method => method === "thread/loaded/list"
      ? { data: ["thread"], nextCursor: null }
      : { thread: { ...thread(), status: { type: status } } });
    await expect(f.sessions.refreshActivity()).rejects.toThrow("thread_unavailable");
    expect(f.sessions.activity()).toBe("unknown");
  });
});
