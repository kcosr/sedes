import { calculateCost, type Model } from "@earendil-works/pi-ai";
import { NO_USAGE_CAPTURE } from "../../src/server/usage/contracts.js";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import { usageMoneyAmountSchema } from "../../src/shared/protocol/usage-accounting.js";
import { describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPiBranchMarker, piBranchMarkerType } from "../../src/server/backends/pi/pi-branch-marker.js";
import { PiUsageAccounting, piUsageObservation } from "../../src/server/backends/pi/pi-usage-accounting.js";
import type { UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";
const usage = {input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
  cost: {input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003}};
const assistant = (n = 10) => ({role: "assistant" as const, content: [{type: "text" as const, text: "done"}], api: "openai-completions" as const,
  provider: "local-provider", model: "model-a", usage: {...usage, input: n}, stopReason: "stop" as const, timestamp: 1});
const entry = (message = assistant()): SessionEntry => ({type: "message", id: "a", parentId: "u", timestamp: "2026-09-22T00:00:00Z", message});
describe("Pi native usage accounting", () => {
  it("uses disjoint SDK buckets while retaining unknown reasoning and provider/model", () => {
    const observed = piUsageObservation(entry(), "turn", "history")!;
    expect(observed.facts[0]).toMatchObject({tokens: {input: "80", uncachedInput: "10", output: "20", reasoning: null, total: "100", requests: "1"},
      models: [{provider: "local-provider", model: "model-a"}], basis: ["sdk_normalized"], providerPresence: "unknown",
      pricing: {basis: "sdk_estimate", components: [{kind:"input",amount:"0.001"},{kind:"output",amount:"0.002"},{kind:"cacheRead",amount:"0"},{kind:"cacheWrite",amount:"0"}]},
      turn: {backendTurnId: "turn", contribution: "additive"}});
    expect(piUsageObservation(entry(), "turn", "live")!.id).toBe(observed.id);
    expect(piUsageObservation(entry(), "turn", "live")!.revision).toBe(observed.revision);
  });
  it("keeps dedicated extension usage non-additive unless disjointness is established", () => {
    const native: SessionEntry = {type: "usage", id: "warm", parentId: null, timestamp: "2026-09-22T00:00:00Z", provider: "p", model: "m", kind: "extension", usage};
    expect(piUsageObservation(native, "turn", "live")!.facts[0]).toMatchObject({sessionContribution: "none", turn: null, tokens: {requests: null}});
    expect(piUsageObservation({...native, kind: "cache_warm"}, "turn", "live")!.facts[0]).toMatchObject({sessionContribution: "additive", turn: null, tokens: {requests: "1"}});
  });
  it("captures inactive branches and multiple calls under their native turn", () => {
    const manager = SessionManager.inMemory("/workspace");
    const user = manager.appendMessage({role: "user", content: "question", timestamp: 1});
    manager.appendMessage(assistant(10)); manager.appendMessage(assistant(20));
    manager.branch(user); manager.appendMessage(assistant(30));
    manager.branchWithSummary(user, "Imported branch summary", undefined, false, usage);
    const captured: UsageObservation[] = [];
    const sink: UsageSink = {listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open: () => ({registerTurns: () => {}, capture: (entries) => { captured.push(...entries); return true; }, gap: () => {}, reconcile: () => true, seal: () => {}})};
    new PiUsageAccounting({sink, manager, nativeNamespace: "store", authentication: {conversationId: manager.getSessionId(), installationKey: new Uint8Array(32)},
      binding: {tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread", backendInstanceId: "pi", connectionProfileId: "c", executionEnvironmentId: "e", backendConversationId: manager.getSessionId(), createdAt: "2026-09-22T00:00:00Z"}});
    expect(captured).toHaveLength(4);
    expect(captured.map((o) => o.facts[0]!.tokens.uncachedInput)).toEqual(["10", "20", "30", "10"]);
    expect(new Set(captured.slice(0,3).map((o) => o.facts[0]!.turn?.backendTurnId))).toEqual(new Set([user]));
    expect(captured[3]!.facts[0]).toMatchObject({activity:"branch_summary",sessionContribution:"additive",turn:null,tokens:{input:"80",output:"20",requests:null},costs:[{amount:"0.003"}]});
  });
  it("marks authenticated copied turns as inherited while capturing only new child work", () => {
    const manager=SessionManager.inMemory("/workspace"),key=new Uint8Array(32);
    const inheritedUser=manager.appendMessage({role:"user",content:"parent",timestamp:1});
    const leaf=manager.appendMessage(assistant(10));
    manager.appendCustomEntry(piBranchMarkerType,createPiBranchMarker({sourceBackendConversationId:"parent-native",targetBackendConversationId:manager.getSessionId(),sourceLeafEntryId:leaf,applicationOperationId:"operation",inheritedSettingsFingerprint:"a".repeat(64)},key));
    manager.appendMessage({role:"user",content:"child",timestamp:2});manager.appendMessage(assistant(20));
    const wrapped=new Proxy(manager,{get(target,key,receiver){if(key==="getHeader")return ()=>({...target.getHeader()!,parentSession:"/admitted-parent"});return Reflect.get(target,key,receiver);}});
    const captured:UsageObservation[]=[],inherited:unknown[]=[];
    const sink:UsageSink={listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({registerTurns:(_turns,origin)=>{if(origin)inherited.push(origin);},capture:(observations)=>{captured.push(...observations);return true;},gap:()=>{},reconcile:()=>true,seal:()=>{}})};
    new PiUsageAccounting({sink,manager:wrapped,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:key},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}});
    expect(captured).toHaveLength(1);expect(captured[0]!.facts[0]!.tokens.uncachedInput).toBe("20");
    expect(inherited).toContainEqual({nativeSession:"parent-native",turns:[{backendTurnId:inheritedUser,sourceBackendTurnId:inheritedUser}]});
  });
  it("accepts real pi-ai pricing float artifacts without discarding tokens", () => {
    const nativeUsage = {input:17,output:0,cacheRead:0,cacheWrite:0,totalTokens:17,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const model: Model<"openai-completions"> = {id:"fixture-model",name:"Fixture",api:"openai-completions",provider:"fixture",baseUrl:"https://example.invalid",reasoning:false,input:["text"],contextWindow:128000,maxTokens:1024,cost:{input:0.3,output:0,cacheRead:0,cacheWrite:0}};
    calculateCost(model, nativeUsage);
    expect(String(nativeUsage.cost.input).split(".")[1]!.length).toBeGreaterThan(18);
    const observation=piUsageObservation(entry({...assistant(17),usage:nativeUsage}),"turn","live")!;
    expect(observation.facts[0]!.tokens.input).toBe("17");
    expect(observation.facts[0]!.costs[0]!.amount).toBe("0.0000051");
    for (const component of observation.facts[0]!.pricing!.components) expect(usageMoneyAmountSchema.safeParse(component.amount).success).toBe(true);
  });
  it("captures only new live entries without reprojection and retries failed commits", () => {
    const manager=SessionManager.inMemory("/workspace");
    const user=manager.appendMessage({role:"user",content:"question",timestamp:1});
    manager.appendMessage(assistant());
    let durable=true;
    const capture=vi.fn(() => durable), reconcile=vi.fn(() => true);
    const projection=vi.spyOn(PiHistoryProjector.prototype,"project");
    const accounting=new PiUsageAccounting({sink:{listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,capture,reconcile})},manager,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:new Uint8Array(32)},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}});
    expect(capture).toHaveBeenCalledTimes(1);expect(reconcile).toHaveBeenCalledTimes(1);projection.mockClear();capture.mockClear();
    const nextId=manager.appendMessage(assistant(20)), next=manager.getEntries().find(entry=>entry.id===nextId)!;
    durable=false;accounting.append(next,user);expect(capture).toHaveBeenCalledTimes(1);
    durable=true;accounting.retryPending();expect(capture).toHaveBeenCalledTimes(2);
    accounting.append(next,user);accounting.retryPending();expect(capture).toHaveBeenCalledTimes(2);
    expect(projection).not.toHaveBeenCalled();
    accounting.reconcile("history");expect(capture).toHaveBeenCalledTimes(2);expect(reconcile).toHaveBeenCalledTimes(2);
    projection.mockRestore();
  });
  it("stops a failed history batch and resumes the full scan when storage recovers", () => {
    const manager=SessionManager.inMemory("/workspace");manager.appendMessage({role:"user",content:"question",timestamp:1});
    for(let index=0;index<130;index++)manager.appendMessage(assistant(index));
    let durable=false;
    const capture=vi.fn((_observations:readonly UsageObservation[])=>durable),reconcile=vi.fn(()=>true);
    const accounting=new PiUsageAccounting({sink:{listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,capture,reconcile})},manager,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:new Uint8Array(32)},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}});
    expect(capture.mock.calls.map(([batch])=>batch.length)).toEqual([64]);expect(reconcile).not.toHaveBeenCalled();
    durable=true;accounting.retryPending();
    expect(capture.mock.calls.slice(1).map(([batch])=>batch.length)).toEqual([64,64,2]);expect(reconcile).toHaveBeenCalledTimes(1);
  });
  it("does not declare native history reconciled after invalid evidence or a failed commit", () => {
    const manager=SessionManager.inMemory("/workspace");manager.appendMessage(assistant(Number.MAX_SAFE_INTEGER+1));
    const reconcile=vi.fn(() => true),gap=vi.fn();
    const input={sink:{listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,reconcile,gap})},manager,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:new Uint8Array(32)},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}};
    new PiUsageAccounting(input);expect(gap).toHaveBeenCalledWith("invalid_evidence");expect(reconcile).not.toHaveBeenCalled();
    const validManager=SessionManager.inMemory("/workspace");validManager.appendMessage(assistant());
    new PiUsageAccounting({...input,manager:validManager,sink:{listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,reconcile,capture:()=>false})}});
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("attributes the thinking level of the entry's own native branch without changing the revision", () => {
    const plain = piUsageObservation(entry(), "turn", "history")!, attributed = piUsageObservation(entry(), "turn", "history", "high")!;
    expect(attributed.attribution).toEqual({model: null, reasoningEffort: "high"});
    expect(plain.attribution).toEqual({model: null, reasoningEffort: null});
    expect(attributed.revision).toBe(plain.revision);expect(attributed.facts).toEqual(plain.facts);
    const manager=SessionManager.inMemory("/workspace");
    const user=manager.appendMessage({role:"user",content:"question",timestamp:1});
    const before=manager.appendMessage(assistant(10));
    manager.appendThinkingLevelChange("high");const after=manager.appendMessage(assistant(20));
    manager.branch(user);const sibling=manager.appendMessage(assistant(30));
    const captured:UsageObservation[]=[];
    const accounting=new PiUsageAccounting({sink:{listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,capture:(observations)=>{captured.push(...observations);return true;}})},manager,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:new Uint8Array(32)},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}});
    const effort=(id:string)=>captured.find(observation=>observation.id===`${id}:usage`)!.attribution;
    expect([effort(before),effort(after),effort(sibling)]).toEqual([{model:null,reasoningEffort:null},{model:null,reasoningEffort:"high"},{model:null,reasoningEffort:null}]);
    manager.appendThinkingLevelChange("low");const liveId=manager.appendMessage(assistant(40));
    accounting.append(manager.getEntries().find(candidate=>candidate.id===liveId)!,user);
    expect(captured.at(-1)).toMatchObject({id:`${liveId}:usage`,attribution:{model:null,reasoningEffort:"low"}});
  });
  it("rejects unsafe native counts instead of rounding", () => {
    expect(() => piUsageObservation(entry(assistant(Number.MAX_SAFE_INTEGER + 1)), "turn", "live")).toThrow("invalid_native_usage_count");
  });
});
