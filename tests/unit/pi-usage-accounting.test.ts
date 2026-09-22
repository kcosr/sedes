import { describe, expect, it } from "vitest";
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
    const captured: UsageObservation[] = [];
    const sink: UsageSink = {open: () => ({registerTurns: () => {}, capture: (entries) => { captured.push(...entries); return true; }, gap: () => {}, seal: () => {}})};
    new PiUsageAccounting({sink, manager, nativeNamespace: "store", authentication: {conversationId: manager.getSessionId(), installationKey: new Uint8Array(32)},
      binding: {tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread", backendInstanceId: "pi", connectionProfileId: "c", executionEnvironmentId: "e", backendConversationId: manager.getSessionId(), createdAt: "2026-09-22T00:00:00Z"}});
    expect(captured).toHaveLength(3);
    expect(captured.map((o) => o.facts[0]!.tokens.uncachedInput)).toEqual(["10", "20", "30"]);
    expect(new Set(captured.map((o) => o.facts[0]!.turn?.backendTurnId))).toEqual(new Set([user]));
  });
  it("marks authenticated copied turns as inherited while capturing only new child work", () => {
    const manager=SessionManager.inMemory("/workspace"),key=new Uint8Array(32);
    const inheritedUser=manager.appendMessage({role:"user",content:"parent",timestamp:1});
    const leaf=manager.appendMessage(assistant(10));
    manager.appendCustomEntry(piBranchMarkerType,createPiBranchMarker({sourceBackendConversationId:"parent-native",targetBackendConversationId:manager.getSessionId(),sourceLeafEntryId:leaf,applicationOperationId:"operation",inheritedSettingsFingerprint:"a".repeat(64)},key));
    manager.appendMessage({role:"user",content:"child",timestamp:2});manager.appendMessage(assistant(20));
    const wrapped=new Proxy(manager,{get(target,key,receiver){if(key==="getHeader")return ()=>({...target.getHeader()!,parentSession:"/admitted-parent"});return Reflect.get(target,key,receiver);}});
    const captured:UsageObservation[]=[],inherited:unknown[]=[];
    const sink:UsageSink={open:()=>({registerTurns:(_turns,origin)=>{if(origin)inherited.push(origin);},capture:(observations)=>{captured.push(...observations);return true;},gap:()=>{},seal:()=>{}})};
    new PiUsageAccounting({sink,manager:wrapped,nativeNamespace:"store",authentication:{conversationId:manager.getSessionId(),installationKey:key},binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"pi",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:manager.getSessionId(),createdAt:"2026-09-22T00:00:00Z"}});
    expect(captured).toHaveLength(1);expect(captured[0]!.facts[0]!.tokens.uncachedInput).toBe("20");
    expect(inherited).toContainEqual({nativeSession:"parent-native",turns:[{backendTurnId:inheritedUser,sourceBackendTurnId:inheritedUser}]});
  });
  it("rejects unsafe native counts instead of rounding", () => {
    expect(() => piUsageObservation(entry(assistant(Number.MAX_SAFE_INTEGER + 1)), "turn", "live")).toThrow("invalid_native_usage_count");
  });
});
