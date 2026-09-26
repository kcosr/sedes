import { NO_USAGE_CAPTURE } from "../../src/server/usage/contracts.js";
import { usageMoneyAmountSchema } from "../../src/shared/protocol/usage-accounting.js";
import { describe, expect, it, vi } from "vitest";
import type { SDKResultMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeMessageObservation, claudePipelineObservation, claudeStartupResult, claudeTurnObservation, ClaudeUsageAccounting } from "../../src/server/backends/claude/claude-usage-accounting.js";
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
  it.each(["No response requested.", "API Error: synthetic failure"])("ignores Claude Code's locally written %j rows", text => {
    const zero = {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
    const message = {type: "assistant", uuid: "frame", parent_tool_use_id: null, parent_agent_id: null, message: {id: "a5d0a52e-3f43-4c56-9b6c-6f4a4f1d2b10",
      model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{type: "text", text}], usage: zero}} as unknown as SessionMessage;
    expect(claudeMessageObservation(message, "turn", "history")).toBeUndefined();
    expect(claudeMessageObservation({...message, message: {...message.message as object, model: "model-a"}} as SessionMessage, "turn", "history")).toBeDefined();
  });
  it("reuses actual query epochs and keeps history independent of resumed query checkpoints", () => {
    const epochs: string[] = [], captured: UsageObservation[] = [], sealed: string[] = [];
    const sink: UsageSink = {enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open: (source) => {epochs.push(source.epoch); return {registerTurns: () => {}, capture: (entries) => { captured.push(...entries); return true; }, gap: () => {}, reconcile: () => true, seal: (reason) => sealed.push(reason)};}};
    const accounting = new ClaudeUsageAccounting({sink, nativeNamespace: "native-store", launch: "new", binding: {tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread", backendInstanceId: "claude", connectionProfileId: "c", executionEnvironmentId: "e", backendConversationId: "native", createdAt: "2026-09-22T00:00:00Z"}});
    accounting.admitQuery("query-1", false); accounting.admitQuery("query-1", true);
    accounting.pipeline(result(20)); accounting.pipeline(result(30, "next")); accounting.result(result(30), "turn"); accounting.reset();
    expect(epochs).toEqual(["history", "query-1"]); expect(captured).toHaveLength(3); expect(sealed).toEqual(["reset"]);
  });
  describe("query series baselines", () => {
    const startup = (inputTokens: number, uuid = "startup-result", probe = "probe") => ({...result(inputTokens, uuid), num_turns: 0, is_error: false, user_message_uuid: probe,
      usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}} as unknown as SDKResultMessage);
    const recorder = () => {
      const opened: Parameters<UsageSink["open"]>[0][] = [], captured: UsageObservation[] = [];
      const sink: UsageSink = {enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings: [], nextCursor: null}), listSubagents: () => [],
        open: (source) => { opened.push(source); return {...NO_USAGE_CAPTURE, capture: (entries) => { captured.push(...entries); return true; }}; }};
      const accounting = (launch: "new" | "resume") => new ClaudeUsageAccounting({sink, nativeNamespace: "store", launch,
        binding: {tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread", backendInstanceId: "claude", connectionProfileId: "c", executionEnvironmentId: "e", backendConversationId: "native", createdAt: "2026-09-22T00:00:00Z"}});
      return {opened, captured, accounting};
    };

    it("recognizes only the startup message's own model-free result as a query's start", () => {
      expect(claudeStartupResult(startup(20), "probe")).toBe(true);
      expect(claudeStartupResult(startup(20), "other")).toBe(false);
      expect(claudeStartupResult({...startup(20), num_turns: 1} as SDKResultMessage, "probe")).toBe(false);
      expect(claudeStartupResult({...startup(20), user_message_uuids: ["probe", "prompt"]} as SDKResultMessage, "probe")).toBe(false);
      expect(claudeStartupResult({...startup(20), usage: result(20).usage} as SDKResultMessage, "probe")).toBe(false);
      expect(claudeStartupResult({...startup(20), subtype: "error_during_execution", is_error: true} as unknown as SDKResultMessage, "probe")).toBe(false);
    });

    it("counts a new launch from zero as soon as it is admitted", () => {
      const {opened, accounting} = recorder();
      accounting("new").admitQuery("probe", false);
      expect(opened.map(({epoch, initialBaseline, reportedBaseline}) => ({epoch, initialBaseline, reportedBaseline}))).toEqual([
        {epoch: "history", initialBaseline: "unknown", reportedBaseline: undefined}, {epoch: "probe", initialBaseline: "proven_zero", reportedBaseline: undefined}]);
    });

    it("opens a resumed query at its startup result, which reports the totals its transcript saved", () => {
      const {opened, captured, accounting} = recorder();
      const resumed = accounting("resume");
      resumed.admitQuery("probe", false);
      expect(opened.map(({epoch}) => epoch)).toEqual(["history"]);
      resumed.pipeline(startup(20), "high", "model-a"); resumed.pipeline(result(30, "next"));
      const {attribution: _attribution, ...start} = claudePipelineObservation(startup(20))!;
      expect(opened[1]).toMatchObject({epoch: "probe", initialBaseline: "proven_zero", reportedBaseline: {...start, id: "startup-result:baseline"}});
      expect(opened[1]!.reportedBaseline).not.toHaveProperty("attribution");
      expect(captured.map(({id}) => id)).toEqual(["startup-result:pipeline", "next:pipeline"]);
      expect(opened).toHaveLength(2);
    });

    it("never takes work before an unrecognized first result as the query's own", () => {
      const {opened, accounting} = recorder();
      const resumed = accounting("resume");
      resumed.admitQuery("probe", false); resumed.pipeline(result(30, "first"));
      const reattached = accounting("new");
      reattached.admitQuery("probe", true); reattached.pipeline(startup(20));
      expect(opened.filter(({epoch}) => epoch === "probe").map(({initialBaseline, reportedBaseline}) => [initialBaseline, reportedBaseline?.id])).toEqual([
        ["unknown", "first:baseline"], ["proven_zero", "startup-result:baseline"]]);
    });
  });

  it("reports each delivery transaction outcome for existing replay acknowledgement", () => {
    let durable=false;
    const sink:UsageSink={enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({registerTurns:()=>{},capture:()=>durable,gap:()=>{},reconcile:()=>true,seal:()=>{}})};
    const accounting=new ClaudeUsageAccounting({sink,nativeNamespace:"store",launch:"new",binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"claude",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:"native",createdAt:"2026-09-22T00:00:00Z"}});
    accounting.admitQuery("query",false);accounting.beginDelivery();accounting.pipeline(result(20));
    expect(accounting.deliveryCommitted).toBe(false);
    durable=true;accounting.beginDelivery();accounting.pipeline(result(20));
    expect(accounting.deliveryCommitted).toBe(true);
  });
  it("normalizes Claude summed floating-point costs to supported decimal money", () => {
    const message={...result(20),total_cost_usd:0.0007+0.0002};
    const observation=claudePipelineObservation(message)!;
    const amount=observation.facts.find(fact=>fact.id==="query_cost")!.costs[0]!.amount;
    expect(amount).toBe("0.0009");expect(usageMoneyAmountSchema.safeParse(amount).success).toBe(true);
  });
  it("batches history once and caches only successfully committed message revisions", () => {
    let durable=true;
    const capture=vi.fn((_observations:readonly UsageObservation[])=>durable);
    const accounting=new ClaudeUsageAccounting({sink:{enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,capture})},nativeNamespace:"store",launch:"new",binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"claude",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:"native",createdAt:"2026-09-22T00:00:00Z"}});
    const message=(id:number)=>({type:"assistant",uuid:`frame-${id}`,parent_tool_use_id:null,message:{id:`message-${id}`,model:"model-a",usage:{input_tokens:id,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}}} as SessionMessage);
    const history=Array.from({length:130},(_,id)=>({message:message(id),backendTurnId:`turn-${id}`}));
    accounting.messages(history,"history");expect(capture.mock.calls.map(([batch])=>batch.length)).toEqual([64,64,2]);
    accounting.messages(history,"history");expect(capture).toHaveBeenCalledTimes(3);
    durable=false;accounting.beginDelivery();accounting.message(message(131),"turn-131","live");expect(accounting.deliveryCommitted).toBe(false);
    durable=true;accounting.beginDelivery();accounting.message(message(131),"turn-131","live");expect(accounting.deliveryCommitted).toBe(true);
    accounting.message(message(131),"turn-131","live");expect(capture).toHaveBeenCalledTimes(5);
    const corrected=message(131);(corrected.message as {usage:{output_tokens:number}}).usage.output_tokens=3;
    accounting.message(corrected,"turn-131","live");expect(capture).toHaveBeenCalledTimes(6);
  });
  it("attributes the confirmed effort to the pipeline checkpoint only", () => {
    const captured: UsageObservation[] = [];
    const accounting=new ClaudeUsageAccounting({sink:{enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [], open:()=>({...NO_USAGE_CAPTURE,capture:(observations)=>{captured.push(...observations);return true;}})},nativeNamespace:"store",launch:"new",binding:{tenantId:"t",ownerPrincipalId:"p",applicationThreadId:"thread",backendInstanceId:"claude",connectionProfileId:"c",executionEnvironmentId:"e",backendConversationId:"native",createdAt:"2026-09-22T00:00:00Z"}});
    accounting.admitQuery("query",false);accounting.pipeline(result(20),"xhigh");accounting.pipeline(result(30,"next"));accounting.result(result(30),"turn");
    expect(captured.map(observation=>observation.attribution)).toEqual([{model:null,reasoningEffort:"xhigh"},{model:null,reasoningEffort:null},undefined]);
    expect(claudePipelineObservation(result(20),"high")!.facts).toEqual(claudePipelineObservation(result(20))!.facts);
  });
  it("does not replace real counters with synthetic startup failures", () => {
    expect(claudePipelineObservation({...result(0), subtype: "error_during_execution", startup_failure_reason: "cwd_unavailable"} as SDKResultMessage)).toBeUndefined();
  });
});
