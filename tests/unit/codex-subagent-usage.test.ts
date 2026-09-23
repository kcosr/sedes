import { describe, expect, it, vi } from "vitest";
import { CodexSubagentUsageCoordinator } from "../../src/server/backends/codex/codex-subagent-usage.js";
import { CodexSharedClientFacade, type CodexReadyClientGeneration } from "../../src/server/backends/codex/codex-client-facade.js";
import { decodeCodexServerNotificationParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { UsageCapture, UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { RetainedRuntimeLifecycle } from "../../src/server/backends/retained-runtime-lifecycle.js";

const binding: ConversationBinding = { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "app",
  backendConversationId: "root", backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", createdAt: "2026-09-22T00:00:00Z" };
function thread(id: string, parent: string) {
  return { id, extra: {}, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "openai", model: null,
    reasoningEffort: null, createdAt: 1700000000, updatedAt: 1700000000, recencyAt: 1700000000, status: { type: "idle" },
    path: null, cwd: "/workspace", cliVersion: "0.153.0", source: { subAgent: { thread_spawn: { parent_thread_id: parent,
      depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } }, canAcceptDirectInput: true, threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] };
}
function fixture(restored: ReturnType<UsageSink["listSubagents"]> = [], residency?: RetainedRuntimeLifecycle, roots: readonly ConversationBinding[] = [], initiallyLoaded: readonly string[] = []) {
  let generation = 1;
  let sequence = 0;
  let loaded: string[] = [...initiallyLoaded];
  const captures = new Map<string, UsageCapture>();
  const observations = new Map<string, UsageObservation[]>();
  const request = vi.fn(async (method: { method: string }, params: { threadId?: string }) => {
    if (method.method === "thread/loaded/list") return { result: { data: loaded, nextCursor: null }, generation, inboundSequence: ++sequence };
    if (method.method === "thread/resume") return { result: { thread: { id: params.threadId, status: { type: "idle" } } }, generation, inboundSequence: ++sequence };
    throw new Error("Unexpected request");
  });
  const client = new CodexSharedClientFacade({ ...(residency ? { residency } : {}), current: () => ({ generation, requestWithReceipt: request } as unknown as CodexReadyClientGeneration), latestGeneration: () => generation, retireGeneration: async () => undefined });
  client.updateLifecycle({ state: "ready", generation });
  const open = vi.fn<UsageSink["open"]>(input => {
    const entries = observations.get(input.nativeSession) ?? [];
    observations.set(input.nativeSession, entries);
    const capture: UsageCapture = { registerTurns: vi.fn(), capture: vi.fn(items => { entries.push(...items); return true; }), gap: vi.fn(), seal: vi.fn(), reconcile: vi.fn(() => true) };
    captures.set(input.nativeSession, capture);
    return capture;
  });
  const sink: UsageSink = { open, findSubagent: vi.fn(() => null), listSubagentRoots: vi.fn(() => ({bindings:roots,nextCursor:null})), listSubagents: vi.fn(() => restored) };
  const onError = vi.fn();
  const coordinator = new CodexSubagentUsageCoordinator({ client, sink, nativeNamespace: "store", runtimeScope:{tenantId:binding.tenantId,principalId:binding.ownerPrincipalId,backendInstanceId:binding.backendInstanceId,executionEnvironmentId:binding.executionEnvironmentId,connectionProfileId:binding.connectionProfileId}, onError });
  const notify = (method: "thread/started" | "thread/tokenUsage/updated" | "turn/started" | "turn/completed" | "item/completed", params: unknown, receiptSequence = ++sequence, receiptGeneration = generation) => client.forwardNotification(generation, {
    kind: "decoded_notification", method, params: decodeCodexServerNotificationParams(method, params), generation: receiptGeneration, sequence: receiptSequence,
  });
  const spawn = (id: string, parent = "root") => notify("thread/started", { thread: thread(id, parent) });
  const usage = (id: string, inputTokens: number, receiptSequence?: number, receiptGeneration?: number) => {
    const total = { inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens };
    notify("thread/tokenUsage/updated", { threadId: id, turnId: "child-turn", tokenUsage: { total, last: total, modelContextWindow: 1000 } }, receiptSequence, receiptGeneration);
  };
  return { coordinator, client, captures, observations, open, onError, request, spawn, usage, notify, sink,
    loaded: (ids: string[]) => { loaded = ids; }, reconnect: () => { client.updateLifecycle({ state: "unavailable", generation }); generation++; client.updateLifecycle({ state: "ready", generation }); } };
}

describe("Codex subagent usage coordinator", () => {
  it("captures separate cumulative lifetime checkpoints and nested descendants without parent turn allocations", () => {
    const f = fixture(); f.coordinator.registerRoot(binding);
    f.spawn("child"); f.usage("child", 100); f.usage("child", 180);
    f.spawn("nested", "child"); f.usage("nested", 50);
    expect(f.open.mock.calls.map(([input]) => [input.nativeSession, input.subagent?.nativeParentSession, input.binding.applicationThreadId])).toEqual([["child", "root", "app"], ["nested", "child", "app"]]);
    expect(f.observations.get("child")?.map(entry => entry.facts[0]?.tokens.input)).toEqual(["100", "180"]);
    expect(f.observations.get("nested")?.[0]?.facts[0]).toMatchObject({ turn: null, sessionContribution: "checkpoint", tokens: { input: "50" } });
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("retries transient root admission on child spawn without reattaching the root", () => {
    const f=fixture();vi.mocked(f.sink.listSubagents).mockImplementationOnce(()=>{throw new Error("SQLITE_BUSY");});
    f.coordinator.registerRoot(binding);
    expect(f.onError).toHaveBeenCalledOnce();
    f.spawn("child");f.usage("child",20);
    expect(f.sink.listSubagents).toHaveBeenCalledTimes(2);
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("20");
  });

  it("retries unadmitted roots on reconnect without inventing a durable child relationship", () => {
    const f=fixture();vi.mocked(f.sink.listSubagents).mockImplementationOnce(()=>{throw new Error("SQLITE_BUSY");});
    f.coordinator.registerRoot(binding);f.reconnect();
    expect(f.sink.listSubagents).toHaveBeenCalledTimes(2);
    expect(f.open).not.toHaveBeenCalled();
    f.spawn("child");f.usage("child",20);
    expect(f.observations.get("child")).toHaveLength(1);
  });

  it("retains only the latest out-of-order counter until ancestry and the root are admitted", () => {
    const f = fixture(); f.usage("nested", 10); f.usage("nested", 30); f.spawn("nested", "child"); f.spawn("child");
    expect(f.open).not.toHaveBeenCalled();
    f.coordinator.registerRoot(binding);
    expect(f.observations.get("nested")?.map(entry => entry.facts[0]?.tokens.input)).toEqual(["30"]);
  });

  it("does not admit unrelated threads or claim another root's usage", () => {
    const f = fixture(); f.coordinator.registerRoot(binding); f.spawn("foreign", "unowned"); f.usage("foreign", 900);
    f.coordinator.registerRoot({ ...binding, applicationThreadId: "app-2", backendConversationId: "root-2" });
    f.spawn("child-2", "root-2"); f.usage("child-2", 12);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0]?.[0].binding.applicationThreadId).toBe("app-2");
  });

  it("ignores duplicate receipts and stale generation events", () => {
    const f = fixture(); f.coordinator.registerRoot(binding); f.spawn("child"); f.usage("child", 20, 20); f.usage("child", 99, 19); f.usage("child", 99, 21, 0);
    expect(f.observations.get("child")).toHaveLength(1);
  });

  it("reconnects only already-loaded children using lightweight resume and waits for a counter to recover", async () => {
    const f = fixture(); f.coordinator.registerRoot(binding); f.spawn("child"); f.spawn("completed"); f.usage("child", 20);
    const oldCapture = f.captures.get("child")!;
    f.loaded(["child", "foreign"]); f.reconnect();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.request.mock.calls.map(([method, params]) => [method.method, params])).toEqual([
      ["thread/loaded/list", { cursor: null, limit: 100 }], ["thread/resume", { threadId: "child", excludeTurns: true }],
    ]);
    expect(oldCapture.gap).toHaveBeenCalledWith("capture_gap");
    expect(f.captures.get("child")?.reconcile).not.toHaveBeenCalled();
    f.usage("child", 90);
    expect(f.captures.get("child")?.reconcile).toHaveBeenCalledOnce();
    expect(f.observations.get("child")?.at(-1)?.facts[0]?.tokens.input).toBe("90");
  });

  it("restores durable relations when the root is admitted without reading history", async () => {
    const f = fixture([{ nativeSession: "child", nativeParentSession: "root", epoch: "native-counter-v1", normalizationVersion: "codex-subagent-usage-v1", captureState: "disconnected" }]);
    f.loaded(["child"]); f.coordinator.registerRoot(binding);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.captures.get("child")?.gap).toHaveBeenCalledWith("capture_gap");
    expect(f.captures.get("child")?.reconcile).not.toHaveBeenCalled();
    f.coordinator.registerRoot(binding);
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("recovers stored children on runtime startup without opening or registering their root", async () => {
    const restored=[{nativeSession:"child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"codex-subagent-usage-v1",captureState:"disconnected" as const}];
    const f=fixture(restored,undefined,[binding],["child","foreign"]);
    expect(f.sink.listSubagentRoots).toHaveBeenCalledWith({tenantId:"tenant",principalId:"principal",backendInstanceId:"backend",executionEnvironmentId:"environment",connectionProfileId:"connection",nativeNamespace:"store",cursor:null,limit:128});
    await vi.waitFor(()=>expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.request.mock.calls.map(([method,params])=>[method.method,params])).toEqual([["thread/loaded/list",{cursor:null,limit:100}],["thread/resume",{threadId:"child",excludeTurns:true}]]);
    // Later actor attachment can present the same binding with a different property order.
    f.coordinator.registerRoot(Object.fromEntries(Object.entries(binding).reverse()) as unknown as ConversationBinding);
    expect(f.open).toHaveBeenCalledOnce();
    f.usage("child",70);
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("70");
    expect(f.captures.get("child")?.reconcile).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("paginates durable roots within the runtime scope on reconnect", async () => {
    const f=fixture();
    vi.mocked(f.sink.listSubagentRoots).mockReset()
      .mockReturnValueOnce({bindings:[binding],nextCursor:"app"})
      .mockReturnValueOnce({bindings:[{...binding,applicationThreadId:"app-2",backendConversationId:"root-2"}],nextCursor:null});
    f.reconnect();
    expect(f.sink.listSubagentRoots).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.sink.listSubagentRoots).mock.calls[1]?.[0].cursor).toBe("app");
    f.spawn("child","root-2");f.usage("child",3);
    expect(f.open.mock.calls[0]?.[0].binding.applicationThreadId).toBe("app-2");
  });

  it("retries durable child recovery when root admission failed transiently", async () => {
    const f = fixture([{ nativeSession: "child", nativeParentSession: "root", epoch: "native-counter-v1", normalizationVersion: "codex-subagent-usage-v1", captureState: "disconnected" }]);
    vi.mocked(f.sink.listSubagents).mockImplementationOnce(() => { throw new Error("temporary_database_failure"); });
    f.coordinator.registerRoot(binding);
    expect(f.open).not.toHaveBeenCalled();
    f.loaded(["child"]);f.coordinator.registerRoot(binding);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it("does not retain an already-completed child whose root was admitted after its completion", async () => {
    const retire=vi.fn(async()=>undefined), residency=new RetainedRuntimeLifecycle({wake:()=>undefined,retire});
    const rootLease=residency.retain(), f=fixture([],residency);
    f.spawn("child");f.usage("child",42);
    const ended={ threadId:"child",turn:{id:"child-turn",items:[],itemsView:"full",status:"completed",error:null,startedAt:1700000000,completedAt:1700000001,durationMs:1000} };
    f.notify("turn/completed",ended);
    f.coordinator.registerRoot(binding);
    await rootLease.release(true);
    expect(retire).toHaveBeenCalledOnce();
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("42");
    const nextRootLease=residency.retain();
    f.notify("turn/started",{threadId:"child",turn:{...ended.turn,id:"followup",status:"inProgress",completedAt:null,durationMs:null}});
    await nextRootLease.release(true);
    expect(retire).toHaveBeenCalledOnce();
    f.notify("turn/completed",{...ended,turn:{...ended.turn,id:"followup"}});
    await vi.waitFor(()=>expect(retire).toHaveBeenCalledTimes(2));
  });

  it("keeps the runtime resident after root eviction until background child completion", async () => {
    const retire = vi.fn(async () => undefined);
    const residency = new RetainedRuntimeLifecycle({ wake: () => undefined, retire });
    const rootLease = residency.retain();
    const f = fixture([], residency); f.coordinator.registerRoot(binding); f.spawn("child");
    await rootLease.release(true);
    expect(retire).not.toHaveBeenCalled();
    f.usage("child", 42);
    f.notify("turn/completed", { threadId: "child", turn: { id: "child-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1700000000, completedAt: 1700000001, durationMs: 1000 } });
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("42");
  });

  it("admits children from completed native spawn results, but never sendInput recipients", () => {
    const f = fixture(); f.coordinator.registerRoot(binding);
    const event = (tool: string, id: string) => ({ threadId: "root", turnId: "turn", completedAtMs: 1700000000000,
      item: { type: "collabAgentToolCall", id: "spawn", tool, status: "completed", senderThreadId: "root", receiverThreadIds: [id],
        prompt: null, model: null, reasoningEffort: null, agentsStates: {} } });
    f.notify("item/completed", event("sendInput", "foreign"));
    f.notify("item/completed", event("spawnAgent", "child"));
    f.usage("child", 15);
    expect(f.open.mock.calls.map(([input]) => input.nativeSession)).toEqual(["child"]);
  });

  it("fences a loaded-thread recovery response when the client disconnects before it returns", async () => {
    const f = fixture(); f.coordinator.registerRoot(binding); f.spawn("child");
    let resolve!: (value: { result: { data: string[]; nextCursor: null }; generation: number; inboundSequence: number }) => void;
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.reconnect();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.client.updateLifecycle({ state: "unavailable", generation: 2 });
    resolve({ result: { data: ["child"], nextCursor: null }, generation: 2, inboundSequence: 1 });
    await new Promise(done => setImmediate(done));
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.captures.get("child")?.reconcile).not.toHaveBeenCalled();
  });

  it("keeps completed child capture idle through reconnect and accepts a late final counter", async () => {
    const f=fixture();f.coordinator.registerRoot(binding);f.spawn("child");f.usage("child",10);
    const first=f.captures.get("child")!;
    const ended={threadId:"child",turn:{id:"done",items:[],itemsView:"full",status:"completed",error:null,startedAt:1700000000,completedAt:1700000001,durationMs:1000}};
    f.notify("turn/completed",ended);
    expect(first.seal).toHaveBeenCalledWith("closed");
    f.usage("child",12);
    const final=f.captures.get("child")!;
    expect(final).not.toBe(first);expect(final.seal).toHaveBeenCalledWith("closed");
    expect(f.observations.get("child")?.at(-1)?.facts[0]?.tokens.input).toBe("12");
    f.reconnect();await new Promise(done=>setImmediate(done));expect(f.request).not.toHaveBeenCalled();
    expect(first.gap).not.toHaveBeenCalled();expect(final.gap).not.toHaveBeenCalled();
  });

  it("does not manufacture a gap for persisted idle children and gaps active children that are now unloaded", async () => {
    const restored=[{nativeSession:"idle-child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"idle" as const},
      {nativeSession:"active-child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"disconnected" as const}];
    const f=fixture(restored,undefined,[binding]);
    await vi.waitFor(()=>expect(f.captures.get("active-child")?.seal).toHaveBeenCalledWith("closed"));
    expect(f.captures.has("idle-child")).toBe(false);
    expect(f.captures.get("active-child")?.gap).toHaveBeenCalledWith("capture_gap");
    expect(f.captures.get("active-child")?.reconcile).not.toHaveBeenCalled();
  });

  it("does not retain unproven restored children when loaded-list recovery fails", async () => {
    const retire=vi.fn(async()=>undefined),residency=new RetainedRuntimeLifecycle({wake:()=>undefined,retire}),rootLease=residency.retain();
    const f=fixture([{nativeSession:"child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"disconnected"}],residency);
    f.request.mockRejectedValueOnce(new Error("loaded_list_failed"));f.coordinator.registerRoot(binding);
    await vi.waitFor(()=>expect(f.onError).toHaveBeenCalledOnce());
    await rootLease.release(true);expect(retire).toHaveBeenCalledOnce();
  });

  it("releases old-generation child leases even when replacement inventory fails", async () => {
    const retire=vi.fn(async()=>undefined),residency=new RetainedRuntimeLifecycle({wake:()=>undefined,retire}),rootLease=residency.retain();
    const f=fixture([],residency);f.coordinator.registerRoot(binding);f.spawn("child");
    f.request.mockRejectedValueOnce(new Error("loaded_list_failed"));f.reconnect();
    await vi.waitFor(()=>expect(f.onError).toHaveBeenCalledOnce());
    await rootLease.release(true);expect(retire).toHaveBeenCalledOnce();
  });

  it.each(["systemError","notLoaded"])("does not retain an unhealthy recovered child with status %s", async status => {
    const retire=vi.fn(async()=>undefined),residency=new RetainedRuntimeLifecycle({wake:()=>undefined,retire}),rootLease=residency.retain();
    const f=fixture([{nativeSession:"child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"disconnected"}],residency);
    f.request.mockResolvedValueOnce({result:{data:["child"],nextCursor:null},generation:1,inboundSequence:1})
      .mockResolvedValueOnce({result:{thread:{id:"child",status:{type:status}}},generation:1,inboundSequence:2});
    f.coordinator.registerRoot(binding);
    await vi.waitFor(()=>expect(f.captures.get("child")?.seal).toHaveBeenCalledWith("closed"));
    expect(f.captures.get("child")?.gap).toHaveBeenCalledWith("capture_gap");
    await rootLease.release(true);expect(retire).toHaveBeenCalledOnce();
  });

  it("records capacity gaps once without letting a rejected pending child block later entries", () => {
    const f=fixture();f.coordinator.registerRoot(binding);
    for(let index=0;index<4096;index++)f.spawn(`child-${index}`);
    f.spawn("rejected-a");f.spawn("rejected-b");
    expect(f.open.mock.calls.filter(([input])=>input.nativeSession==="rejected-a")).toHaveLength(1);
    expect(f.captures.get("rejected-b")?.gap).toHaveBeenCalledWith("capture_gap");
    f.client.forwardNotification(1,{kind:"decoded_notification",method:"thread/closed",params:{threadId:"child-0"},generation:1,sequence:5000});
    f.spawn("admitted-after-close");f.usage("admitted-after-close",10);
    expect(f.observations.get("admitted-after-close")).toHaveLength(1);
    expect(f.captures.get("admitted-after-close")?.gap).not.toHaveBeenCalled();
  });

  it("does not resume already recovered children again when another root is registered", async () => {
    const restored=[{nativeSession:"child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"disconnected" as const}];
    const f=fixture(restored,undefined,[binding],["child"]);
    await vi.waitFor(()=>expect(f.request).toHaveBeenCalledTimes(2));
    vi.mocked(f.sink.listSubagents).mockReturnValueOnce([{...restored[0]!,nativeSession:"child-2",nativeParentSession:"root-2"}]);
    f.loaded(["child","child-2"]);
    f.coordinator.registerRoot({...binding,applicationThreadId:"app-2",backendConversationId:"root-2"});
    await vi.waitFor(()=>expect(f.request).toHaveBeenCalledTimes(4));
    expect(f.request.mock.calls.filter(([method,params])=>method.method==="thread/resume" && params.threadId==="child")).toHaveLength(1);
  });

  it("uses a newer resumed status when the streamed completion preceded the response fence", async () => {
    const retire=vi.fn(async()=>undefined),residency=new RetainedRuntimeLifecycle({wake:()=>undefined,retire}),rootLease=residency.retain();
    const f=fixture([{nativeSession:"child",nativeParentSession:"root",epoch:"native-counter-v1",normalizationVersion:"v1",captureState:"disconnected"}],residency);
    const completed={threadId:"child",turn:{id:"done",items:[],itemsView:"full",status:"completed",error:null,startedAt:1700000000,completedAt:1700000001,durationMs:1000}};
    f.request.mockImplementationOnce(async()=>({result:{data:["child"],nextCursor:null},generation:1,inboundSequence:1}))
      .mockImplementationOnce(async()=>{f.notify("turn/completed",completed,2);return {result:{thread:{id:"child",status:{type:"active"}}},generation:1,inboundSequence:3};});
    f.coordinator.registerRoot(binding);
    await vi.waitFor(()=>expect(f.captures.get("child")?.gap).toHaveBeenCalledWith("capture_gap"));
    await rootLease.release(true);expect(retire).not.toHaveBeenCalled();
    f.notify("turn/completed",completed,4);
    await vi.waitFor(()=>expect(retire).toHaveBeenCalledOnce());
  });

  it("prunes closed leaves and then closed ancestors while retaining nested ancestry until closure", () => {
    const f=fixture();f.coordinator.registerRoot(binding);f.spawn("child");f.spawn("nested","child");
    const close=(threadId:string,sequence:number)=>f.client.forwardNotification(1,{kind:"decoded_notification",method:"thread/closed",params:{threadId},generation:1,sequence});
    close("child",100);f.spawn("more","child");
    expect(f.open.mock.calls.at(-1)?.[0].nativeSession).toBe("more");
    close("nested",101);close("more",102);
    f.spawn("child");
    expect(f.open.mock.calls.filter(([input])=>input.nativeSession==="child")).toHaveLength(2);
  });

  it("rejects conflicting ancestry diagnostically without interrupting existing capture", () => {
    const f = fixture(); f.coordinator.registerRoot(binding); f.spawn("child"); f.spawn("child", "foreign"); f.usage("child", 7);
    expect(f.onError).toHaveBeenCalledOnce(); expect(f.observations.get("child")).toHaveLength(1);
  });
});
