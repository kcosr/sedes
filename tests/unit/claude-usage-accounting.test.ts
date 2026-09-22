import { describe, expect, it } from "vitest";
import type { SDKResultMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeMessageObservation, claudePipelineObservation, claudeTurnObservation, ClaudeUsageAccounting } from "../../src/server/backends/claude/claude-usage-accounting.js";
import type { UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";
const result = (inputTokens: number, uuid = "result"): SDKResultMessage => ({type: "result", subtype: "success", uuid, session_id: "native", result_index: 1,
  usage: {input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
  modelUsage: {"model-a": {inputTokens, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.002, canonicalModel: "canonical-a", costBasis: "managed", provider: "bedrock", thinkingTokens: 3}}, total_cost_usd: 0.002,
} as unknown as SDKResultMessage);
describe("Claude native usage accounting", () => {
  it("keeps cumulative query map and direct main-loop turn measurements non-additive", () => {
    expect(claudePipelineObservation(result(20))!).toMatchObject({replaceCheckpoint: true, facts: [
      {sessionContribution: "checkpoint", turn: null, tokens: {input: "25", uncachedInput: "20", output:"20",reasoning:"3"}, models:[{provider:"bedrock",model:"model-a"}], pricing: {canonicalModel:"canonical-a",basis:"managed",components:[{kind:"model_total",amount:"0.002"}]}}, {id: "query_cost", tokens: {}, costs: [{amount: "0.002", kind: "estimated"}]}]});
    expect(claudeTurnObservation(result(20), "turn")!.facts[0]).toMatchObject({sessionContribution: "none", tokens: {input: "10", output: "20"}, costs: [], turn: {scope: "main_loop", contribution: "checkpoint"}});
  });
  it("maps nullable API message counts without fabricating cache zeros", () => {
    const message = {type: "assistant", uuid: "frame", parent_tool_use_id: null, message: {id: "message", model: "model-a", usage: {input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null}}} as SessionMessage;
    expect(claudeMessageObservation(message, "turn", "history")!.facts[0]).toMatchObject({tokens: {input: null, cacheRead: null, cacheWrite: null, uncachedInput: "10"}, basis: ["provider_reported"], models: [{model: "model-a", provider: null}]});
    expect(claudeMessageObservation({...message, parent_tool_use_id: "child"}, "turn", "history")).toBeUndefined();
  });
  it("reuses actual query epochs and keeps history independent of resumed query checkpoints", () => {
    const epochs: string[] = [], captured: UsageObservation[] = [], sealed: string[] = [];
    const sink: UsageSink = {open: (source) => {epochs.push(source.epoch); return {registerTurns: () => {}, capture: (entries) => { captured.push(...entries); return true; }, gap: () => {}, seal: (reason) => sealed.push(reason)};}};
    const accounting = new ClaudeUsageAccounting({sink, nativeNamespace: "native-store", binding: {tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread", backendInstanceId: "claude", connectionProfileId: "c", executionEnvironmentId: "e", backendConversationId: "native", createdAt: "2026-09-22T00:00:00Z"}});
    accounting.admitQuery("query-1", false); accounting.admitQuery("query-1", true);
    accounting.pipeline(result(20)); accounting.pipeline(result(30, "next")); accounting.result(result(30), "turn"); accounting.reset();
    expect(epochs).toEqual(["history", "query-1"]); expect(captured).toHaveLength(3); expect(sealed).toEqual(["reset"]);
  });
  it("reports each delivery transaction outcome for existing replay acknowledgement", () => {
    let durable=false;
    const sink:UsageSink={open:()=>({registerTurns:()=>{},capture:()=>durable,gap:()=>{},seal:()=>{}})};
    const accounting=new ClaudeUsageAccounting({sink,nativeNamespace:"store",binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"claude",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:"native",createdAt:"2026-09-22T00:00:00Z"}});
    accounting.admitQuery("query",false);accounting.beginDelivery();accounting.pipeline(result(20));
    expect(accounting.deliveryCommitted).toBe(false);
    durable=true;accounting.beginDelivery();accounting.pipeline(result(20));
    expect(accounting.deliveryCommitted).toBe(true);
  });
  it("does not replace real counters with synthetic startup failures", () => {
    expect(claudePipelineObservation({...result(0), subtype: "error_during_execution", startup_failure_reason: "cwd_unavailable"} as SDKResultMessage)).toBeUndefined();
  });
});
