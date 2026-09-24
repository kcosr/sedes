import { describe, expect, it, vi } from "vitest";
import { CodexSubagentUsageCoordinator } from "../../src/server/backends/codex/codex-subagent-usage.js";
import { CodexSharedClientFacade, type CodexReadyClientGeneration } from "../../src/server/backends/codex/codex-client-facade.js";
import { decodeCodexServerNotificationParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { UsageCapture, UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";

const binding = { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "app", backendConversationId: "root",
  backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", createdAt: "2026-09-23T00:00:00Z" };
const scope = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment" };
type StoredChild = { id: string; parent: string; state: "idle" | "active" | "disconnected" | "failed" };

function fixture(rows: StoredChild[], loaded: string[] = [], loadedResponse?: Promise<{ result: { data: string[]; nextCursor: null }; generation: number; inboundSequence: number }>) {
  let generation = 1, sequence = 0;
  const stored = new Map(rows.map(row => [row.id, { ...row }]));
  const observations = new Map<string, UsageObservation[]>();
  const captures = new Map<string, UsageCapture>();
  const request = vi.fn(async (method: { method: string }, params: { threadId?: string }) => {
    if (method.method === "thread/loaded/list") return loadedResponse ?? { result: { data: loaded, nextCursor: null }, generation, inboundSequence: ++sequence };
    if (method.method === "thread/resume") return { result: { thread: { id: params.threadId, status: { type: "active", activeFlags: [] } } }, generation, inboundSequence: ++sequence };
    throw new Error(`Unexpected request ${method.method}`);
  });
  const detach = vi.fn(async () => undefined);
  const client = new CodexSharedClientFacade({
    current: () => ({ generation, requestWithReceipt: request } as unknown as CodexReadyClientGeneration),
    latestGeneration: () => generation, retireGeneration: async () => undefined,
    persistentSessions: { reattachThread: async () => undefined, detachThread: detach },
  });
  client.updateLifecycle({ state: "ready", generation });
  const open = vi.fn<UsageSink["open"]>(input => {
    const row = stored.get(input.nativeSession) ?? { id: input.nativeSession, parent: input.subagent!.nativeParentSession, state: "active" as const };
    stored.set(row.id, row);
    row.state = "active";
    const entries = observations.get(row.id) ?? [];
    observations.set(row.id, entries);
    const capture: UsageCapture = { registerTurns: vi.fn(), capture: vi.fn(items => { entries.push(...items); return true; }),
      gap: vi.fn(), reconcile: vi.fn(() => true), seal: vi.fn(reason => { row.state = reason === "closed" ? "idle" : "disconnected"; }) };
    captures.set(row.id, capture);
    return capture;
  });
  const listSubagentRoots = vi.fn(() => ({ bindings: [...stored.values()].some(row => row.state !== "idle") ? [binding] : [], nextCursor: null }));
  const listSubagents = vi.fn(() => [...stored.values()].filter(row => row.state !== "idle").map(row => ({ nativeSession: row.id,
    nativeParentSession: row.parent, epoch: "native-counter-v1", normalizationVersion: "codex-subagent-usage-v1", captureState: row.state })));
  const findSubagent = vi.fn((input: { nativeSession: string }) => {
    const row = stored.get(input.nativeSession);
    return row ? { binding, nativeParentSession: row.parent } : null;
  });
  const sink: UsageSink = { enabled: true, open, listSubagentRoots, listSubagents, findSubagent };
  const onError = vi.fn();
  const coordinator = new CodexSubagentUsageCoordinator({ client, sink, nativeNamespace: "store", runtimeScope: scope, onError });
  const status = (id: string, active: boolean) => client.forwardNotification(generation, {
    kind: "decoded_notification", method: "thread/status/changed", generation, sequence: ++sequence,
    params: decodeCodexServerNotificationParams("thread/status/changed", { threadId: id, status: active ? { type: "active", activeFlags: [] } : { type: "idle" } }),
  });
  const usage = (id: string, inputTokens: number) => {
    const total = { inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens };
    client.forwardNotification(generation, { kind: "decoded_notification", method: "thread/tokenUsage/updated", generation, sequence: ++sequence,
      params: decodeCodexServerNotificationParams("thread/tokenUsage/updated", { threadId: id, turnId: "turn", tokenUsage: { total, last: total, modelContextWindow: 1000 } }) });
  };
  const spawn = (id: string, parent: string) => client.forwardNotification(generation, {
    kind: "decoded_notification", method: "item/completed", generation, sequence: ++sequence,
    params: decodeCodexServerNotificationParams("item/completed", { threadId: parent, turnId: "turn", completedAtMs: 1700000000000, item: {
      id: "spawn-item", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: parent,
      receiverThreadIds: [id], prompt: "child task", model: null, reasoningEffort: null, agentsStates: {},
    } }),
  });
  const reconnect = () => { client.updateLifecycle({ state: "unavailable", generation }); generation++; client.updateLifecycle({ state: "ready", generation }); };
  return { coordinator, client, request, detach, open, stored, observations, captures, listSubagents, listSubagentRoots, findSubagent, onError, status, usage, spawn, reconnect };
}

describe("Codex recovery admits outstanding work instead of historical accounting", () => {
  it("does no native work for thousands of historical children on startup, root registration, or reconnect", async () => {
    const f = fixture(Array.from({ length: 5000 }, (_, index) => ({ id: `old-${index}`, parent: "root", state: "idle" })));
    f.coordinator.registerRoot(binding);
    f.reconnect();
    await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.findSubagent).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("retires an unresolved child absent from loaded inventory without eviction or repeated reconnect work", async () => {
    const f = fixture([{ id: "child", parent: "root", state: "disconnected" }]);
    await vi.waitFor(() => expect(f.stored.get("child")?.state).toBe("idle"));
    expect(f.captures.get("child")?.gap).toHaveBeenCalledWith("capture_gap");
    expect(f.captures.get("child")?.reconcile).not.toHaveBeenCalled();
    f.reconnect();
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("recovers an active grandchild without restoring its idle ancestor", async () => {
    const f = fixture([{ id: "ancestor", parent: "root", state: "idle" }, { id: "grandchild", parent: "ancestor", state: "disconnected" }], ["grandchild"]);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.open.mock.calls.map(([input]) => input.nativeSession)).toEqual(["grandchild"]);
    expect(f.open.mock.calls[0]?.[0]).toMatchObject({ binding, subagent: { nativeParentSession: "ancestor" } });
    f.status("grandchild", false);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    expect(f.detach).toHaveBeenCalledWith("grandchild", 1, true);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("does not retire newer active evidence when an earlier loaded inventory omitted the child", async () => {
    let resolve!: (receipt: { result: { data: string[]; nextCursor: null }; generation: number; inboundSequence: number }) => void;
    const loadedResponse = new Promise<{ result: { data: string[]; nextCursor: null }; generation: number; inboundSequence: number }>(done => { resolve = done; });
    const f = fixture([{ id: "child", parent: "root", state: "disconnected" }], [], loadedResponse);
    // Provider response and its following notification can share one transport
    // batch; the notification is delivered before the response continuation.
    resolve({ result: { data: [], nextCursor: null }, generation: 1, inboundSequence: 0 });
    f.status("child", true);
    await new Promise<void>(done => setImmediate(done));
    expect(f.stored.get("child")?.state).toBe("active");
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("admits renewed activity by exact scoped identity without scanning or resuming historical siblings", () => {
    const f = fixture([{ id: "child", parent: "root", state: "idle" }, { id: "sibling", parent: "root", state: "idle" }]);
    f.status("child", true);
    f.usage("child", 42);
    expect(f.findSubagent).toHaveBeenCalledWith({ ...scope, nativeNamespace: "store", nativeSession: "child" });
    expect(new Set(f.open.mock.calls.map(([input]) => input.nativeSession))).toEqual(new Set(["child"]));
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("42");
    f.status("child", false);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("attributes a new descendant through a historical parent's exact identity without monitoring the parent", () => {
    const f = fixture([{ id: "ancestor", parent: "root", state: "idle" }]);
    f.spawn("new-child", "ancestor");
    f.usage("new-child", 12);
    expect(f.findSubagent).toHaveBeenCalledWith({ ...scope, nativeNamespace: "store", nativeSession: "ancestor" });
    expect(f.open.mock.calls.map(([input]) => input.nativeSession)).toEqual(["new-child"]);
    expect(f.open.mock.calls[0]?.[0]).toMatchObject({ binding, subagent: { nativeParentSession: "ancestor" } });
    expect(f.observations.get("new-child")?.[0]?.facts[0]?.tokens.input).toBe("12");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("accepts a late final counter using durable identity without retaining or evicting the historical child", () => {
    const f = fixture([{ id: "child", parent: "root", state: "idle" }]);
    f.usage("child", 50);
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("50");
    expect(f.stored.get("child")?.state).toBe("idle");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("does not turn unrelated native activity into accounting authority", () => {
    const f = fixture([]);
    f.status("foreign", true);
    f.usage("foreign", 90);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("serializes only actual attachment cleanup and keeps interactive requests available", async () => {
    const ids = ["one", "two", "three", "four"];
    const f = fixture(ids.map(id => ({ id, parent: "root", state: "disconnected" })), ids);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(ids.length + 1));
    let releaseFirst!: () => void;
    const pending = new Promise<undefined>(resolve => { releaseFirst = () => resolve(undefined); });
    f.detach.mockImplementationOnce(() => pending);
    for (const id of ids) f.status(id, false);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    // Cleanup's pending request must not gate ordinary client operations.
    await f.client.requestWithReceipt({ method: "thread/loaded/list" } as never, { cursor: null, limit: 100 }, { timeoutMilliseconds: 1000 });
    expect(f.detach).toHaveBeenCalledOnce();
    releaseFirst();
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(ids.length));
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps a queued attachment when its child reactivates and releases it on the next idle", async () => {
    const f = fixture(["one", "two"].map(id => ({ id, parent: "root", state: "disconnected" })), ["one", "two"]);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3));
    let releaseFirst!: () => void;
    f.detach.mockImplementationOnce(() => new Promise<undefined>(resolve => { releaseFirst = () => resolve(undefined); }));
    f.status("one", false);
    f.status("two", false);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    f.status("two", true);
    releaseFirst();
    await new Promise<void>(done => setImmediate(done));
    expect(f.detach).toHaveBeenCalledOnce();
    f.status("two", false);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(2));
    expect(f.detach).toHaveBeenLastCalledWith("two", 1, true);
    expect(f.onError).not.toHaveBeenCalled();
  });
});
