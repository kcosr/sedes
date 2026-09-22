import { CodexUsageCapture } from "../../src/server/backends/codex/codex-usage-capture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { UsageService, addUsageMoney } from "../../src/server/usage/usage-service.js";
import type { UsageFact, UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";

const scope = {tenantId: "tenant", principalId: "principal"};
const binding = {tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: "thread", backendInstanceId: "backend", executionEnvironmentId: "environment", connectionProfileId: "connection", backendConversationId: "native-session", createdAt: "2026-09-22T00:00:00Z"};
const source: Parameters<UsageSink["open"]>[0] = {binding, nativeNamespace: "native-store", nativeSession: "native-session", epoch: "query", normalizationVersion: "fixture-v1", initialBaseline: "proven_zero"};
const databases: Database.Database[] = [], directories: string[] = [];
afterEach(() => {vi.useRealTimers();for(const db of databases.splice(0)) if(db.open)db.close();for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function database(file = ":memory:", legacy = false): Database.Database {
  const db = new Database(file); databases.push(db); db.pragma("foreign_keys = ON");
  db.exec(`
CREATE TABLE application_threads(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,environment_id TEXT NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(tenant_id,owner_principal_id,id));
CREATE TABLE agent_backend_instances(tenant_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE conversation_bindings(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,execution_environment_id TEXT NOT NULL,backend_conversation_id TEXT NOT NULL,connection_profile_id TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 1790035200000);
CREATE TABLE conversation_creation_attempts(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,force_reset_at INTEGER,phase TEXT);
CREATE TABLE thread_lineage_closure(tenant_id TEXT, owner_principal_id TEXT, ancestor_thread_id TEXT, descendant_thread_id TEXT);
CREATE TABLE thread_fork_origins(tenant_id TEXT, owner_principal_id TEXT, child_thread_id TEXT, source_thread_id TEXT, creation_operation_id TEXT, source_thread_state TEXT);
CREATE TABLE claude_usage_ledgers(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,request_count INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO application_threads VALUES('tenant','principal','thread','backend','environment','workspace');
INSERT INTO agent_backend_instances VALUES('tenant','backend','claude_agent_sdk');
INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','thread','backend','environment','native-session','connection');`);
  if(legacy)db.exec("INSERT INTO claude_usage_ledgers VALUES('tenant','principal','thread',100,20,30,40,5,1720000000000)");
  db.exec(durableUsageAccountingMigration.sql);
  db.exec(usageGapSessionScopeMigration.sql); db.exec(usageSubagentsMigration.sql); return db;
}
function fact(id: string, input: string, overrides: Partial<UsageFact> = {}): UsageFact {
  return {id, kind: "operation", sessionContribution: "additive", coverageDomain: "main_loop", tokens: {input}, costs: [], models: [{provider: "provider", model: "model"}], basis: ["sdk_normalized"], providerPresence: "unknown", quality: "complete", reasons: [], activity: "model", turn: null, ...overrides};
}
function observation(id: string, facts: readonly UsageFact[], replaceCheckpoint = false, order: string | null = null): UsageObservation {
  return {id, revision: "1", order, provenance: "live", occurredAt: null, replaceCheckpoint, facts};
}
const turnId = applicationTurnIdForBackendTurn({backendInstanceId: "backend", sourceApplicationThreadId: "thread", backendTurnId: "turn"});
describe("durable scoped usage service", () => {
  it("reports complete measurements within main-loop scope despite unknown model attribution", () => {
    const db=database(), service=new UsageService(db), capture=service.open(source);
    const reasons=["main_loop_only", "model_coverage_unknown"] as const;
    capture.registerTurns([{backendTurnId:"turn",status:"in_progress",orderedBackendItemIds:[]}]);
    capture.capture([observation("main",[fact("main","100",{
      models:[],reasons, costs:[{amount:"0.25",currency:"USD",kind:"estimated",provenance:"SDK"}],
      turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"},
    })])]);
    expect(service.read(scope,"thread",turnId).state).toBe("partial");
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    const report=service.read(scope,"thread",turnId);
    expect(report).toMatchObject({state:"complete",measurementScope:"main_loop",summary:{
      metrics:{input:{value:"100",quality:"complete"}},costQuality:"complete",models:[],reasons,
      costs:[{amount:"0.25",quality:"complete"}],
    }});
    expect(service.read(scope,"thread").state).toBe("complete");
    expect(new UsageService(db).read(scope,"thread",turnId)).toEqual(report);
  });
  it.each(["capture_gap", "unknown_baseline", "history_partial", "invalid_evidence", "child_coverage_unknown"] as const)("retains incomplete main-loop measurements for %s", reason => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    capture.capture([observation("main",[fact("main","100",{
      reasons:["main_loop_only","model_coverage_unknown",reason],
      turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"},
    })])]);
    expect(service.read(scope,"thread",turnId)).toMatchObject({state:"partial",summary:{metrics:{input:{value:"100",quality:"partial"}}}});
  });
  it.each([false,true])("preserves explicit partial fact quality with informational reasons (costOnly=%s)", costOnly => {
    const db=database(), service=new UsageService(db), capture=service.open(source);
    const turn={backendTurnId:"turn",status:"completed" as const,orderedBackendItemIds:[]};
    capture.registerTurns([turn]);
    capture.capture([observation("partial",[fact("partial","100",{
      quality:"partial",reasons:["main_loop_only","model_coverage_unknown"],
      tokens:costOnly?{}:{input:"100"},costs:[{amount:"0.25",currency:"USD",kind:"estimated",provenance:"SDK"}],
      turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"},
    })])]);
    const reopened=new UsageService(db);
    reopened.registerVisibleTurns(scope,"thread",[{id:turnId,revision:1,status:"completed",orderedItemIds:[]}]);
    const report=reopened.read(scope,"thread",turnId);
    expect(report.state).toBe("partial");
    expect(report.summary.costQuality).toBe("partial");
    expect(report.summary.metrics.input.quality).toBe(costOnly?"unreported":"partial");
  });
  it("keeps a turn partial when known main-loop measurements coexist with a partial interval", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    capture.capture([observation("mixed",[
      fact("known","100",{turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"}}),
      fact("interval","10",{turn:{backendTurnId:"turn",scope:"partial_interval",contribution:"additive"}}),
    ])]);
    expect(service.read(scope,"thread",turnId)).toMatchObject({state:"partial",measurementScope:"partial_interval",summary:{metrics:{input:{value:"110"}}}});
  });
  it("reports availability only for ended turns with durable data and enforces owner scope", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"in_progress",orderedBackendItemIds:[]},{backendTurnId:"empty",status:"completed",orderedBackendItemIds:[]}]);
    capture.capture([observation("entry",[fact("entry","10",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    expect(service.availability(scope,"thread",[turnId]).turns).toEqual([{turnId,available:false}]);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    expect(service.availability(scope,"thread",[turnId,"absent"]).turns).toEqual([{turnId,available:true},{turnId:"absent",available:false}]);
    const empty=applicationTurnIdForBackendTurn({backendInstanceId:"backend",sourceApplicationThreadId:"thread",backendTurnId:"empty"});
    expect(service.availability(scope,"thread",[empty]).turns[0]?.available).toBe(false);
    expect(()=>service.availability({...scope,principalId:"other"},"thread",[turnId])).toThrow();
  });
  it.each(["completed", "failed", "interrupted"] as const)("keeps recorded zero usage available for a %s turn", status => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status,orderedBackendItemIds:[]}]);
    capture.capture([observation("zero",[fact("zero","0",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    expect(service.availability(scope,"thread",[turnId]).turns).toEqual([{turnId,available:true}]);
  });
  it("keeps additive turn conflicts visible on session totals without affecting another turn", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]},{backendTurnId:"other",status:"completed",orderedBackendItemIds:[]}]);
    const entry=(input:string)=>observation("entry",[fact("entry",input,{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})]);
    capture.capture([entry("10"),entry("20"),observation("other",[fact("other","5",{turn:{backendTurnId:"other",scope:"whole_turn",contribution:"additive"}})])]);
    expect(service.read(scope,"thread").summary.metrics.input).toMatchObject({value:"15",quality:"conflict"});
    const other=applicationTurnIdForBackendTurn({backendInstanceId:"backend",sourceApplicationThreadId:"thread",backendTurnId:"other"});
    expect(service.read(scope,"thread",other).summary.metrics.input.quality).toBe("complete");
  });

  it.each([false,true])("keeps one durable Codex series across resume (regression=%s)", regression => {
    const db=database(), service=new UsageService(db);
    const adapter=new CodexUsageCapture({sink:service,binding,nativeNamespace:"native-store",provenZero:false,ancestry:null,onError:vi.fn()});
    const send=(generation:number,sequence:number,inputTokens:number)=>{
      const counts={inputTokens,outputTokens:0,totalTokens:inputTokens,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0};
      adapter.observe({generation,sequence,turnId:"turn",usage:{total:counts,last:counts,modelContextWindow:1000}});
    };
    send(1,1,150); adapter.gap("capture_gap"); send(2,1,regression?20:150); send(2,2,regression?200:175);
    const report=service.read(scope,"thread");
    expect(report.summary.metrics.input.value).toBe(regression?"150":"175");
    expect(report.summary.reasons.includes("counter_regression")).toBe(regression);
    expect(db.prepare("SELECT count(*) AS count FROM usage_sources").get()).toEqual({count:1});
  });

  it("repairs interrupted capture only after authoritative history reconciliation and retains conflicts", () => {
    const db=database(), first=new UsageService(db), capture=first.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    const evidence=observation("entry",[fact("entry","10",{turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"}})]);
    capture.capture([evidence]);
    expect(first.read(scope,"thread",turnId).state).toBe("complete");
    capture.gap("capture_gap");
    expect(first.read(scope,"thread",turnId)).toMatchObject({state:"partial",summary:{metrics:{input:{value:"10"}}}});
    capture.reconcile();
    expect(first.read(scope,"thread",turnId).state).toBe("complete");
    const service=new UsageService(db); service.recoverInterruptedCapture();
    const recovered=service.open(source);
    expect(service.read(scope,"thread").summary.reasons).toContain("capture_gap");
    expect(service.read(scope,"thread",turnId).state).toBe("partial");
    recovered.capture([evidence]);
    expect(recovered.reconcile()).toBe(true);
    expect(service.read(scope,"thread").state).toBe("complete");
    expect(service.read(scope,"thread",turnId).state).toBe("complete");
    recovered.capture([observation("entry",[fact("entry","20")])]);
    recovered.reconcile();
    expect(service.read(scope,"thread").summary.reasons).toContain("conflicting_evidence");
  });
  it("keeps invalid evidence partial without labelling valid tokens conflicting", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.capture([observation("valid",[fact("valid","10")])]);
    capture.capture([observation("invalid",[fact("invalid","-1")])]);
    const report=service.read(scope,"thread");
    expect(report.summary.metrics.input).toMatchObject({value:"10",quality:"partial"});
    expect(report.summary.reasons).toContain("invalid_evidence");
  });
  it("replaces ordered per-result allocations independently of cumulative regression locks", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    const result=(order:string,input:string)=>observation(`result-${order}`,[fact("turn-result",input,{sessionContribution:"none",kind:"turn_aggregate",turn:{backendTurnId:"turn",scope:"main_loop",contribution:"checkpoint"}})],false,order);
    capture.capture([result("1","30"), result("3","10"), result("2","20")]);
    capture.capture([observation("pipeline",[fact("counter","100",{sessionContribution:"checkpoint"})],true,"3")]);
    expect(service.read(scope,"thread",turnId).summary.metrics.input.value).toBe("10");
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("100");
    expect(service.read(scope,"thread").summary.reasons).not.toContain("counter_regression");
  });
  it("scopes ambiguous direct-result conflicts to the affected turn without freezing pipeline totals", () => {
    const service=new UsageService(database()), capture=service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]},{backendTurnId:"other",status:"completed",orderedBackendItemIds:[]}]);
    const direct=(id:string,input:string)=>observation(id,[fact("result",input,{sessionContribution:"none",turn:{backendTurnId:"turn",scope:"main_loop",contribution:"checkpoint"}})]);
    capture.capture([direct("first","30"),direct("different","10")]);
    capture.capture([observation("pipeline",[fact("counter","100",{sessionContribution:"checkpoint"})],true,"1"),observation("pipeline-next",[fact("counter","120",{sessionContribution:"checkpoint"})],true,"2")]);
    capture.capture([observation("other",[fact("other","5",{sessionContribution:"none",turn:{backendTurnId:"other",scope:"whole_turn",contribution:"additive"}})])]);
    expect(service.read(scope,"thread").summary.metrics.input).toMatchObject({value:"120",quality:"complete"});
    expect(service.read(scope,"thread").summary.reasons).not.toContain("conflicting_evidence");
    expect(service.read(scope,"thread",turnId).summary.metrics.input.quality).toBe("conflict");
    const other=applicationTurnIdForBackendTurn({backendInstanceId:"backend",sourceApplicationThreadId:"thread",backendTurnId:"other"});
    expect(service.read(scope,"thread",other).state).toBe("complete");
  });

  it("persists exact 64-bit counts and decimal money through database reopen without runtime dependencies", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sedes-usage-")); directories.push(dir);
    const file = path.join(dir,"usage.sqlite"), db = database(file), service = new UsageService(db), capture = service.open(source);
    capture.capture([observation("a", [fact("a", "9007199254740993", {costs:[{amount:"0.1",currency:"USD",kind:"estimated",provenance:"SDK"}]})]), observation("b", [fact("b", "1", {costs:[{amount:"0.2",currency:"USD",kind:"estimated",provenance:"SDK"}]})])]);
    capture.seal("detached"); db.close();
    const reopened = new Database(file); databases.push(reopened);
    const report = new UsageService(reopened).read(scope,"thread");
    expect(report.summary.metrics.input.value).toBe("9007199254740994");
    expect(report.summary.costs).toMatchObject([{amount:"0.3",billing:"unknown"}]);
    expect(report.captureState).toBe("disconnected");
  });
  it("makes duplicate history/live delivery and turn registration true revision no-ops", () => {
    const service = new UsageService(database()), capture = service.open(source);
    const turn = {backendTurnId:"turn",status:"completed" as const,orderedBackendItemIds:[]};
    capture.registerTurns([turn]);
    const evidence = observation("entry",[fact("entry","10",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})]);
    capture.capture([evidence]); const revision = service.read(scope,"thread").revision;
    const listener=vi.fn();const unsubscribe=service.subscribe(listener);
    capture.capture([{...evidence,provenance:"history"}]); capture.registerTurns([turn]);
    expect(listener).not.toHaveBeenCalled();unsubscribe();
    expect(service.read(scope,"thread").revision).toBe(revision);
    expect(service.read(scope,"thread",turnId).summary.metrics.input.value).toBe("10");
  });
  it("replaces cumulative model maps instead of adding their successive observations", () => {
    const service = new UsageService(database()), capture = service.open(source);
    const checkpoint = (id:string,input:string) => fact(id,input,{kind:"cumulative",sessionContribution:"checkpoint"});
    capture.capture([observation("first",[checkpoint("model-a","100")],true,"1")]);
    capture.capture([observation("second",[checkpoint("model-a","120"),checkpoint("model-b","30")],true,"2")]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("150");
    capture.capture([observation("third",[checkpoint("model-b","160")],true,"3")]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("160");
  });
  it("keeps regressed series unresolved even when a later observation exceeds the old checkpoint", () => {
    const service = new UsageService(database()), capture = service.open(source);
    const send = (order:string,input:string) => capture.capture([observation(order,[fact("counter",input,{kind:"cumulative",sessionContribution:"checkpoint"})],true,order)]);
    send("1","100");send("2","80");send("3","120");
    const report=service.read(scope,"thread");
    expect(report.summary.metrics.input.value).toBe("100");
    expect(report.summary.reasons).toContain("counter_regression");
    expect(report.state).toBe("partial");
  });
  it("uses direct main-loop result allocations over overlapping historical message evidence across sources", () => {
    const service = new UsageService(database()), history = service.open({...source,epoch:"history",initialBaseline:"unknown"}), query=service.open(source);
    history.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    history.capture([observation("message",[fact("message","10",{sessionContribution:"none",quality:"partial",reasons:["history_partial","main_loop_only"],turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"}})])]);
    query.capture([observation("pipeline",[fact("pipeline","40",{kind:"cumulative",sessionContribution:"checkpoint",coverageDomain:"pipeline"})],true,"1")]);
    query.capture([observation("result",[fact("result","30",{kind:"turn_aggregate",sessionContribution:"none",reasons:["main_loop_only"],turn:{backendTurnId:"turn",scope:"main_loop",contribution:"checkpoint"}})])]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("40");
    expect(service.read(scope,"thread").summary.reasons).not.toContain("main_loop_only");
    const turn=service.read(scope,"thread",turnId);expect(turn.summary.metrics.input.value).toBe("30");
    expect(turn.summary.reasons).toContain("main_loop_only");expect(turn.summary.reasons).not.toContain("history_partial");
  });
  it("retains a delayed direct turn result behind a later cumulative source frontier", () => {
    const service = new UsageService(database()), capture = service.open(source);
    capture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    capture.capture([observation("pipeline-new",[fact("model","100",{kind:"cumulative",sessionContribution:"checkpoint",coverageDomain:"pipeline"})],true,"2")]);
    expect(capture.capture([observation("turn-delayed",[fact("result","30",{kind:"turn_aggregate",sessionContribution:"none",turn:{backendTurnId:"turn",scope:"main_loop",contribution:"checkpoint"}})],false,"1")])).toBe(true);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("100");
    expect(service.read(scope,"thread",turnId).summary.metrics.input.value).toBe("30");
  });
  it("exposes unsupported live turn stubs without creating a provider capture", () => {
    const db=database(), service=new UsageService(db);
    db.prepare("UPDATE agent_backend_instances SET kind='grok_build'").run();
    service.registerVisibleTurns(scope,"thread",[{id:"live-turn",revision:1,status:"in_progress",orderedItemIds:[]}]);
    const report=service.read(scope,"thread","live-turn");
    expect(report.support).toBe("unsupported");expect(report.state).toBe("unavailable");expect(report.turnState).toBe("in_progress");
    expect(db.prepare("SELECT count(*) AS count FROM usage_sources").get()).toEqual({count:0});
    expect(()=>service.read(scope,"thread","foreign-turn")).toThrow();
  });
  it("denies wrong principal reads and binding admission without leaking or mutating totals", () => {
    const service=new UsageService(database()),capture=service.open(source);
    capture.capture([observation("valid",[fact("valid","5")])]);
    expect(()=>service.read({...scope,principalId:"other"},"thread")).toThrow();
    const wrong=service.open({...source,binding:{...binding,ownerPrincipalId:"other"}});
    expect(()=>wrong.capture([observation("bad",[fact("bad","500")])])).not.toThrow();
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("5");
    expect(()=>service.read(scope,"thread","unknown-turn")).toThrow();
  });
  it("captures identified first-send work before the durable binding is finalized", () => {
    const db=database(), service=new UsageService(db);
    db.exec("DELETE FROM conversation_bindings; INSERT INTO conversation_creation_attempts VALUES('tenant','principal','thread','backend','connection','environment','native-session','owned-detail',NULL,'conversation_identified')");
    const capture=service.open(source);
    expect(capture.capture([observation("early",[fact("early","11")])])).toBe(true);
    db.exec("INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','thread','backend','environment','native-session','connection'); UPDATE conversation_creation_attempts SET phase='bound'");
    expect(capture.capture([observation("later",[fact("later","7")])])).toBe(true);
    const report=service.read(scope,"thread");
    expect(report.summary.metrics.input.value).toBe("18");expect(report.summary.reasons).not.toContain("capture_failed");
  });
  it.each([
    {name:"different principal",update:"owner_principal_id='other'"},
    {name:"different profile",update:"connection_profile_id='other'"},
    {name:"different environment",update:"execution_environment_id='other'"},
    {name:"different backend",update:"backend_instance_id='other'"},
    {name:"different native identity",update:"provisional_backend_conversation_id='other'"},
    {name:"missing private binding detail",update:"provisional_opaque_binding_detail=NULL"},
    {name:"force-reset attempt",update:"force_reset_at=1"},
    {name:"aborted attempt",update:"phase='aborted_unpersisted'"},
    {name:"prepared attempt",update:"phase='prepared'"},
  ])("rejects provisional capture with $name", ({update}) => {
    const db=database(), service=new UsageService(db);
    db.exec("DELETE FROM conversation_bindings; INSERT INTO conversation_creation_attempts VALUES('tenant','principal','thread','backend','connection','environment','native-session','owned-detail',NULL,'conversation_identified')");
    db.exec(`UPDATE conversation_creation_attempts SET ${update}`);
    expect(service.open(source).capture([observation("denied",[fact("denied","11")])])).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM usage_sources").get()).toEqual({count:0});
  });
  it("does not use a creation attempt to bypass a mismatched durable binding", () => {
    const db=database(), service=new UsageService(db);
    db.exec("INSERT INTO conversation_creation_attempts VALUES('tenant','principal','thread','backend','connection','environment','native-session','owned-detail',NULL,'conversation_identified'); UPDATE conversation_bindings SET backend_conversation_id='different'");
    expect(service.open(source).capture([observation("denied",[fact("denied","11")])])).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM usage_sources").get()).toEqual({count:0});
  });
  it("preserves legacy values separately and removes the obsolete ledger", () => {
    const db=database(":memory:",true),service=new UsageService(db);
    expect(()=>db.prepare("SELECT * FROM claude_usage_ledgers")).toThrow();
    const old=service.read(scope,"thread");expect(old.legacy?.metrics.input.value).toBe("100");
    expect(old.legacyRecordedAt).toBe(new Date(1720000000000).toISOString());
    expect(old.legacy?.reasons).toEqual(["legacy_coverage_unknown"]);expect(old.summary.metrics.input.value).toBeNull();
    service.open(source).capture([observation("new",[fact("new","2")])]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("2");
    expect(service.read(scope,"thread").legacy?.metrics.input.value).toBe("100");
  });
  it("isolates storage failure from provider execution, then records the gap when storage recovers", () => {
    const db=database(),service=new UsageService(db),capture=service.open(source);
    db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage_observations BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");
    expect(()=>capture.capture([observation("first",[fact("first","10")])])).not.toThrow();
    expect(service.read(scope,"thread").captureState).toBe("failed");
    db.exec("DROP TRIGGER fail_usage");capture.capture([observation("first",[fact("first","10")])]);
    const report=service.read(scope,"thread");expect(report.summary.metrics.input.value).toBe("10");expect(report.summary.reasons).toContain("capture_failed");
  });
  it("retains restrictive ownership/evidence foreign keys", () => {
    const db=database(),service=new UsageService(db);service.open(source).capture([observation("a",[fact("a","1")])]);
    expect(()=>db.prepare("DELETE FROM application_threads").run()).toThrow();
    expect(()=>db.prepare("DELETE FROM usage_observations").run()).toThrow();
  });
  it("fences retired capture objects and exposes interrupted startup intervals", () => {
    const db=database(),service=new UsageService(db),capture=service.open(source);
    capture.capture([observation("before",[fact("before","10")])]);
    capture.seal("closed");
    capture.capture([observation("stale",[fact("stale","100")])]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("10");
    const retained=service.open(source);retained.capture([observation("next",[fact("next","5")])]);
    const restarted=new UsageService(db);restarted.recoverInterruptedCapture();
    const report=restarted.read(scope,"thread");expect(report.captureState).toBe("disconnected");
    expect(report.summary.reasons).toContain("capture_gap");
  });
  it("references inherited turn totals through validated scoped lineage without charging child spend", () => {
    const db=database(),service=new UsageService(db),parent=service.open(source);
    parent.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    parent.capture([observation("parent",[fact("parent","30",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    db.exec("INSERT INTO application_threads VALUES('tenant','principal','child','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','child','backend','environment','child-native','connection'); INSERT INTO thread_lineage_closure VALUES('tenant','principal','thread','child');");
    const child=service.open({...source,binding:{...binding,applicationThreadId:"child",backendConversationId:"child-native"},nativeSession:"child-native"});
    child.registerTurns([{backendTurnId:"child-turn",status:"completed",orderedBackendItemIds:[]}],{nativeSession:"native-session",turns:[{backendTurnId:"child-turn",sourceBackendTurnId:"turn"}]});
    const childTurn=applicationTurnIdForBackendTurn({backendInstanceId:"backend",sourceApplicationThreadId:"child",backendTurnId:"child-turn"});
    const report=service.read(scope,"child",childTurn);expect(report.inherited).toBe(true);expect(report.summary.metrics.input.value).toBe("30");
    expect(service.availability(scope,"child",[childTurn]).turns).toEqual([{turnId:childTurn,available:true}]);
    expect(service.read(scope,"child").summary.metrics.input.value).toBeNull();
    parent.capture([observation("more",[fact("more","5",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    expect(service.read(scope,"child",childTurn).summary.metrics.input.value).toBe("35");
    db.exec("UPDATE usage_thread_state SET report_json=NULL; UPDATE usage_turn_state SET report_json=NULL;");
    const reopened=new UsageService(db);
    expect(reopened.availability(scope,"child",[childTurn]).turns).toEqual([{turnId:childTurn,available:true}]);
    expect(reopened.read(scope,"child",childTurn).summary.metrics.input.value).toBe("35");
  });
  it("rejects malformed native evidence without turning unreported values into zero", () => {
    const service=new UsageService(database()),capture=service.open(source);
    capture.capture([observation("partial",[fact("partial","0",{tokens:{input:"0",output:null}})])]);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("0");expect(service.read(scope,"thread").summary.metrics.output.value).toBeNull();
    expect(()=>capture.capture([observation("bad",[fact("bad","-1")])])).not.toThrow();
    const report=service.read(scope,"thread");expect(report.summary.metrics.input.value).toBe("0");expect(report.summary.reasons).toContain("invalid_evidence");
  });
  it("retains diagnostic pricing components without adding them to authoritative money", () => {
    const db=database(),service=new UsageService(db),capture=service.open(source);
    capture.capture([observation("pricing",[fact("priced","1",{costs:[{amount:"0.3",currency:"USD",kind:"estimated",provenance:"SDK"}],pricing:{canonicalModel:"model-a",basis:"managed",components:[{kind:"input",amount:"0.1",currency:"USD"},{kind:"output",amount:"0.2",currency:"USD"}]}})])]);
    expect(service.read(scope,"thread").summary.costs[0]?.amount).toBe("0.3");
    const stored=db.prepare("SELECT evidence_json FROM usage_observations").get() as {evidence_json:string};
    expect(JSON.parse(stored.evidence_json).facts[0].pricing).toMatchObject({basis:"managed",components:[{amount:"0.1"},{amount:"0.2"}]});
  });
  it("keeps identical checkpoint redelivery as a revision no-op even with a new receipt identity", () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const service=new UsageService(database()),capture=service.open(source);
    const checkpoint=fact("counter","100",{kind:"cumulative",sessionContribution:"checkpoint"});
    capture.capture([observation("receipt-one",[checkpoint],true,"1")]);
    const before=service.read(scope,"thread");
    vi.setSystemTime(new Date("2026-09-22T01:00:00Z"));
    capture.capture([observation("receipt-two",[checkpoint],true,"2")]);
    const after=service.read(scope,"thread");expect(after.revision).toBe(before.revision);expect(after.lastRecordedAt).toBe(before.lastRecordedAt);
  });
  it("preserves the last valid checkpoint timestamp when later counter evidence is rejected", () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const service=new UsageService(database()),capture=service.open(source);
    capture.capture([observation("valid",[fact("counter","100",{kind:"cumulative",sessionContribution:"checkpoint"})],true,"1")]);
    const before=service.read(scope,"thread");
    vi.setSystemTime(new Date("2026-09-22T01:00:00Z"));
    capture.capture([observation("regressed",[fact("counter","80",{kind:"cumulative",sessionContribution:"checkpoint"})],true,"2")]);
    const after=service.read(scope,"thread");expect(after.summary.reasons).toContain("counter_regression");expect(after.lastRecordedAt).toBe(before.lastRecordedAt);
  });
  it("retains the valid cumulative money checkpoint on a cost-only regression", () => {
    const service=new UsageService(database()),capture=service.open(source);
    const priced=(input:string,amount:string)=>fact("counter",input,{kind:"cumulative",sessionContribution:"checkpoint",costs:[{amount,currency:"USD",kind:"estimated",provenance:"SDK"}]});
    capture.capture([observation("a",[priced("100","0.5")],true,"1")]);
    capture.capture([observation("b",[priced("120","0.4")],true,"2")]);
    const report=service.read(scope,"thread");expect(report.summary.metrics.input.value).toBe("100");expect(report.summary.costs[0]?.amount).toBe("0.5");expect(report.summary.reasons).toContain("counter_regression");
  });
  it("rejects oversized normalized evidence without retaining its payload or throwing into execution", () => {
    const db=database(),service=new UsageService(db),capture=service.open(source);
    const evidence=observation("oversize",Array.from({length:100},(_,i)=>fact(`${i}-${"x".repeat(1000)}`,"1")));
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeGreaterThan(65536);
    expect(()=>capture.capture([evidence])).not.toThrow();
    expect(service.read(scope,"thread").summary.reasons).toContain("invalid_evidence");
    expect(db.prepare("SELECT count(*) AS count FROM usage_observations WHERE observation_id='oversize'").get()).toEqual({count:0});
  });
  it("preserves zero money and decimal precision", () => {
    expect(addUsageMoney(["0.0","0.00"])).toBe("0");
    expect(addUsageMoney(["999999999999999999.999999999999999999","0.000000000000000001"])).toBe("1000000000000000000");
  });
});

describe("Codex subagent accounting", () => {
  function setup() {
    const db=database();db.prepare("UPDATE agent_backend_instances SET kind='codex_app_server'").run();
    return {db,service:new UsageService(db)};
  }
  function child(nativeSession="child",nativeParentSession=binding.backendConversationId):Parameters<UsageSink["open"]>[0] {
    return {...source,nativeSession,epoch:"native-counter-v1",subagent:{nativeParentSession}};
  }
  const checkpoint=(id:string,input:string)=>observation(id,[fact("total",input,{kind:"cumulative",sessionContribution:"checkpoint"})],true,input);
  it("counts each nested child once in session totals and never changes the main turn", () => {
    const {db,service}=setup(), main=service.open(source);
    main.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    main.capture([observation("main",[fact("main","100",{turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"}})])]);
    main.seal("closed");
    const before=service.read(scope,"thread",turnId);
    const first=service.open(child());
    first.capture([checkpoint("first","30"),checkpoint("first","30")]);
    first.capture([checkpoint("later","45")]);
    const nested=service.open(child("nested","child"));nested.capture([checkpoint("nested","5")]);
    first.gap("capture_gap");
    const report=service.read(scope,"thread");
    expect(report.summary.metrics.input.value).toBe("150");
    expect(report.breakdown?.main.metrics.input).toMatchObject({value:"100",quality:"complete"});
    expect(report.breakdown?.subagents.metrics.input).toMatchObject({value:"50",quality:"partial"});
    expect(report.breakdown?.subagents.reasons).toContain("capture_gap");
    expect({...service.read(scope,"thread",turnId),revision:before.revision}).toEqual(before);
    expect(before.breakdown).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_turn_state").get()).toEqual({n:1});
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_subagents").get()).toEqual({n:2});
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observations").get()).toEqual({n:4});
    expect(JSON.stringify(report)).not.toContain("native-session");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("isolates child storage failures from main-turn accounting and retains the session failure until recovery", () => {
    const {db,service}=setup(), main=service.open(source);vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    main.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    main.capture([observation("main",[fact("main","100",{turn:{backendTurnId:"turn",scope:"main_loop",contribution:"additive"}})])]);
    const childCapture=service.open(child());
    db.exec("CREATE TRIGGER fail_child_capture BEFORE INSERT ON usage_observations WHEN NEW.source_id IN (SELECT id FROM usage_sources WHERE agent_role='subagent') BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    expect(childCapture.capture([checkpoint("one","10")])).toBe(false);
    expect(service.read(scope,"thread").captureState).toBe("failed");
    expect(service.read(scope,"thread",turnId).state).toBe("complete");
    main.capture([observation("other",[fact("other","1")])]);
    expect(service.read(scope,"thread").captureState).toBe("failed");
    db.exec("DROP TRIGGER fail_child_capture");
    expect(childCapture.capture([checkpoint("one","10")])).toBe(true);childCapture.reconcile();
    expect(service.read(scope,"thread").summary.reasons).not.toContain("capture_failed");
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("111");
  });
  it("enumerates only durable child roots in the exact runtime scope with stable pagination", () => {
    const {db,service}=setup();
    const query={tenantId:scope.tenantId,principalId:scope.principalId,backendInstanceId:binding.backendInstanceId,executionEnvironmentId:binding.executionEnvironmentId,connectionProfileId:binding.connectionProfileId,nativeNamespace:source.nativeNamespace,cursor:null,limit:1};
    expect(service.listSubagentRoots(query)).toEqual({bindings:[],nextCursor:null});
    service.open(child()).capture([checkpoint("one","10")]);
    service.open(child("nested","child"));
    db.exec("INSERT INTO application_threads VALUES('tenant','principal','thread-2','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','thread-2','backend','environment','root-2','connection')");
    const second={...binding,applicationThreadId:"thread-2",backendConversationId:"root-2"};
    service.open({...child("child-2","root-2"),binding:second});
    const first=service.listSubagentRoots(query);
    expect(first.bindings.map(row=>row.applicationThreadId)).toEqual(["thread"]);
    expect(first.bindings[0]).toEqual({...binding,createdAt:"2026-09-22T00:00:00.000Z"});
    expect(first.nextCursor).toBe("thread");
    expect(service.listSubagentRoots({...query,cursor:first.nextCursor})).toMatchObject({bindings:[{applicationThreadId:"thread-2"}],nextCursor:null});
    for(const wrong of [{tenantId:"other"},{principalId:"other"},{backendInstanceId:"other"},{executionEnvironmentId:"other"},{connectionProfileId:"other"},{nativeNamespace:"other"}]) {
      expect(service.listSubagentRoots({...query,...wrong})).toEqual({bindings:[],nextCursor:null});
    }
    expect(()=>service.listSubagentRoots({...query,limit:129})).toThrow();
    // A stale binding must not abort enumeration of unrelated admitted roots.
    // Filter it before pagination so a full page of stale rows cannot hide
    // valid roots that follow it.
    db.prepare("UPDATE application_threads SET environment_id='retargeted' WHERE id='thread'").run();
    expect(service.listSubagentRoots(query)).toMatchObject({bindings:[{applicationThreadId:"thread-2"}],nextCursor:null});
    db.prepare("UPDATE agent_backend_instances SET kind='claude_agent_sdk'").run();
    expect(service.listSubagentRoots(query)).toEqual({bindings:[],nextCursor:null});
  });
  it("restores durable child ownership and cumulative checkpoints without history rereads", () => {
    const {db,service}=setup(), capture=service.open(child());capture.capture([checkpoint("one","30")]);
    const restarted=new UsageService(db);restarted.recoverInterruptedCapture();
    expect(restarted.listSubagents({binding,nativeNamespace:source.nativeNamespace})).toEqual([{
      nativeSession:"child",nativeParentSession:"native-session",epoch:"native-counter-v1",normalizationVersion:"fixture-v1",captureState:"disconnected",
    }]);
    const resumed=restarted.open(child());resumed.capture([checkpoint("two","50")]);resumed.reconcile();
    expect(restarted.read(scope,"thread").summary.metrics.input).toMatchObject({value:"50",quality:"complete"});
    expect(restarted.read(scope,"thread").summary.reasons).not.toContain("capture_gap");
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_sources").get()).toEqual({n:1});
    expect(restarted.listSubagents({binding,nativeNamespace:"other"})).toEqual([]);
  });
  it("rejects unknown parents, cycles, root aliases, and an existing ordinary conversation", () => {
    const {db,service}=setup();vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    db.exec("INSERT INTO application_threads VALUES('tenant','principal','other','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','other','backend','environment','ordinary','connection')");
    for(const input of [child("orphan","unknown"),child("self","self"),child("native-session"),child("ordinary")]){
      expect(service.open(input).capture([checkpoint("bad","900")])).toBe(false);
    }
    const original=service.open(child());original.capture([checkpoint("one","10")]);
    service.open(child("nested","child")).capture([checkpoint("nested","5")]);
    expect(service.open(child("child","nested")).capture([checkpoint("cycle","900")])).toBe(false);
    // Rejected ownership cannot retire the original authorized capture handle.
    expect(original.capture([checkpoint("two","20")])).toBe(true);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("25");
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_subagents").get()).toEqual({n:2});
  });
  it("rejects wrong binding scopes and cross-root claims while preserving the rightful source", () => {
    const {db,service}=setup();vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    const original=service.open(child());original.capture([checkpoint("one","10")]);
    for(const overrides of [{ownerPrincipalId:"other"},{tenantId:"other"},{backendInstanceId:"other"},{executionEnvironmentId:"other"},{connectionProfileId:"other"}]) {
      const wrong={...binding,...overrides};
      expect(()=>service.listSubagents({binding:wrong,nativeNamespace:source.nativeNamespace})).toThrow();
      expect(service.open({...child(),binding:wrong}).capture([checkpoint("foreign","900")])).toBe(false);
    }
    db.exec("INSERT INTO application_threads VALUES('tenant','principal','other','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','other','backend','environment','other-native','connection')");
    const other={...binding,applicationThreadId:"other",backendConversationId:"other-native"};
    expect(service.listSubagents({binding:other,nativeNamespace:source.nativeNamespace})).toEqual([]);
    expect(service.open({...child("child","other-native"),binding:other}).capture([checkpoint("stolen","900")])).toBe(false);
    expect(original.capture([checkpoint("two","20")])).toBe(true);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("20");
    expect(service.read(scope,"other").summary.metrics.input.value).toBeNull();
  });
  it("does not double-charge a registered child if later imported as a main conversation", () => {
    const {db,service}=setup();vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    service.open(child()).capture([checkpoint("one","10")]);
    db.exec("INSERT INTO application_threads VALUES('tenant','principal','imported','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal','imported','backend','environment','child','connection')");
    const imported={...binding,applicationThreadId:"imported",backendConversationId:"child"};
    expect(service.open({...source,binding:imported,nativeSession:"child"}).capture([checkpoint("double","10")])).toBe(false);
    expect(service.read(scope,"thread").summary.metrics.input.value).toBe("10");
    expect(service.read(scope,"imported").summary.metrics.input.value).toBeNull();
  });
  it("prevents a second principal claiming a child on the same native endpoint", () => {
    const {db,service}=setup();vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    service.open(child()).capture([checkpoint("one","10")]);
    db.exec("INSERT INTO application_threads VALUES('tenant','second','second-thread','backend','environment','workspace'); INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','second','second-thread','backend','environment','second-native','connection')");
    const second={...binding,ownerPrincipalId:"second",applicationThreadId:"second-thread",backendConversationId:"second-native"};
    expect(service.open({...child("child","second-native"),binding:second}).capture([checkpoint("stolen","100")])).toBe(false);
    expect(service.listSubagents({binding:second,nativeNamespace:source.nativeNamespace})).toEqual([]);
  });
  it("rejects child turn allocations and leaves other backends explicitly unsupported for children", () => {
    const {db,service}=setup(), childCapture=service.open(child());
    childCapture.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    childCapture.capture([observation("bad",[fact("bad","10",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_turn_state").get()).toEqual({n:0});
    expect(service.read(scope,"thread").summary.metrics.input.value).toBeNull();
    for(const kind of ["claude_agent_sdk","pi_sdk","grok_build"]){
      const other=database();other.prepare("UPDATE agent_backend_instances SET kind=?").run(kind);
      const receiver=new UsageService(other);vi.spyOn(console,"warn").mockImplementation(()=>undefined);
      expect(receiver.open(child()).capture([checkpoint("bad","10")])).toBe(false);
      expect(receiver.read(scope,"thread").breakdown).toBeNull();
    }
  });
  it("rematerializes cleared cached projections from retained evidence after upgrade", () => {
    const {db,service}=setup(), main=service.open(source);
    main.registerTurns([{backendTurnId:"turn",status:"completed",orderedBackendItemIds:[]}]);
    main.capture([observation("one",[fact("one","10",{turn:{backendTurnId:"turn",scope:"whole_turn",contribution:"additive"}})])]);
    db.exec("UPDATE usage_thread_state SET report_json=NULL; UPDATE usage_turn_state SET report_json=NULL;");
    const reopened=new UsageService(db);
    expect(reopened.read(scope,"thread",turnId).summary.metrics.input.value).toBe("10");
    expect(reopened.read(scope,"thread").breakdown?.main.metrics.input.value).toBe("10");
  });
});
