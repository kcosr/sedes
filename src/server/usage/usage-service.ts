import type { ConversationTurn } from "../../shared/protocol/conversation.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { USAGE_TOKEN_KINDS, usageIntegerSchema, usageMoneySchema, usageModelSchema, usageBasisSchema, usageReasonSchema, usageReportSchema, type UsageAvailability, type UsageReport, type UsageSummary, type UsageReason, type UsageTokenKind } from "../../shared/protocol/usage-accounting.js";
import type { BackendTurn } from "../../shared/protocol/backend.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "../domain/errors.js";
import { applicationTurnIdForBackendTurn } from "../conversations/conversation-projector.js";
import type { UsageCapture, UsageFact, UsageObservation, UsageSink } from "./contracts.js";

const identifier = z.string().min(1).max(2048);
const factSchema = z.strictObject({
  id: identifier, kind: z.enum(["operation", "auxiliary", "cumulative", "turn_aggregate"]),
  sessionContribution: z.enum(["additive", "checkpoint", "none"]), coverageDomain: identifier,
  tokens: z.partialRecord(z.enum(USAGE_TOKEN_KINDS), usageIntegerSchema.nullable()),
  pricing: z.strictObject({canonicalModel: z.string().min(1).max(128).nullable(), basis: z.string().min(1).max(128).nullable(),
    components: z.array(usageMoneySchema.pick({amount:true,currency:true}).extend({kind:z.enum(["input","output","cacheRead","cacheWrite","model_total"])})).max(8)}).optional(),
  costs: z.array(usageMoneySchema).max(32), models: z.array(usageModelSchema).max(64),
  basis: z.array(usageBasisSchema).max(3), providerPresence: z.enum(["reported", "unknown"]),
  quality: z.enum(["complete", "partial"]), reasons: z.array(usageReasonSchema),
  activity: z.enum(["model", "tool", "compaction", "branch_summary", "cache_warming", "auxiliary"]),
  turn: z.strictObject({backendTurnId: identifier, scope: z.enum(["whole_turn", "main_loop", "partial_interval"]), contribution: z.enum(["additive", "checkpoint"])}).nullable(),
  inheritedFrom: z.strictObject({applicationThreadId: identifier, factId: identifier}).optional(),
});
const observationSchema = z.strictObject({id: identifier, revision: identifier, order: usageIntegerSchema.nullable(), provenance: z.enum(["live", "history"]), occurredAt: z.iso.datetime().nullable(), replaceCheckpoint: z.boolean(), facts: z.array(factSchema).max(10000)});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const uniq = <T>(values: readonly T[]): T[] => [...new Set(values)];
// Known measurement scope and missing model attribution do not imply missing
// token or cost measurements. Keep those facts visible without degrading them.
const hasIncompleteUsage = (reasons: readonly UsageReason[]): boolean => reasons.some(reason => reason !== "main_loop_only" && reason !== "model_coverage_unknown");
const maximum = 9_223_372_036_854_775_807n;
export function addUsageMoney(values: readonly string[]): string {
  const scale = Math.max(0, ...values.map(value => value.split(".")[1]?.length ?? 0));
  const sum = values.reduce((total, value) => { const [whole, fraction = ""] = value.split("."); return total + BigInt(whole! + fraction.padEnd(scale, "0")); }, 0n);
  if (!scale) return String(sum);
  const digits = String(sum).padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}
export function emptyUsageSummary(): UsageSummary {
  return {metrics: Object.fromEntries(USAGE_TOKEN_KINDS.map(key => [key, {value:null,quality:"unreported",basis:[],providerPresence:"unknown"}])) as unknown as UsageSummary["metrics"], costs:[], costQuality:"unreported", models:[], reasons:[]};
}
type StoredFact = {sourceId:string; turnId:string|null; recordedAt:string; fact:UsageFact};
type State = {revision:bigint; report_json:string|null; legacy_json:string|null};
type Source = {id:string; tenant_id:string; principal_id:string; thread_id:string; capture_state:UsageReport["captureState"]; frontier:string|null; agent_role:"main"|"subagent"};

/** Database-only scoped reads and nonthrowing provider capture. No transcript or provider IO. */
export class UsageService implements UsageSink {
  readonly #incarnations = new Map<string, symbol>();
  readonly #failed = new Set<string>();
  readonly #failedSubagents = new Map<string, Set<string>>();
  readonly #listeners = new Set<(scope:RequestScope, threadId:string, revision:string) => void>();
  constructor(readonly database: Database.Database) {}
  recoverInterruptedCapture(): void {
    this.database.transaction(() => {
      const active=this.database.prepare("SELECT id,tenant_id,principal_id,thread_id FROM usage_sources WHERE capture_state='active'").all() as Source[];
      for(const source of active){this.#gap(source.id,"capture_gap");this.database.prepare("UPDATE usage_sources SET capture_state='disconnected' WHERE id=?").run(source.id);}
      for(const source of active)this.#materialize({tenantId:source.tenant_id,principalId:source.principal_id},source.thread_id);
    })();
  }
  subscribe(listener:(scope:RequestScope, threadId:string, revision:string) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #recordFailure(scope:RequestScope,threadId:string,error:unknown,subagentSourceId?:string):void {
    const key=hash([scope.tenantId,scope.principalId,threadId]);
    if(!(subagentSourceId?this.#failedSubagents.get(key)?.has(subagentSourceId):this.#failed.has(key))){
      const message=error instanceof Error?error.message:"";
      const sqliteCode=typeof error==="object" && error!==null && "code" in error && typeof error.code==="string" && /^SQLITE_[A-Z_]+$/.test(error.code)?error.code:undefined;
      const code=["usage_binding_not_admitted","usage_source_owned_elsewhere"].includes(message)?message:sqliteCode??"accounting_write_failed";
      console.warn("Usage capture failed",{tenantId:scope.tenantId,principalId:scope.principalId,threadId,code});
    }
    if(subagentSourceId){const failed=this.#failedSubagents.get(key)??new Set<string>();failed.add(subagentSourceId);this.#failedSubagents.set(key,failed);}
    else this.#failed.add(key);
  }
  #authorize(scope:RequestScope, threadId:string) {
    const row = this.database.prepare(`SELECT t.backend_instance_id, t.environment_id, t.workspace_id, b.kind
      FROM application_threads t JOIN agent_backend_instances b ON b.tenant_id=t.tenant_id AND b.id=t.backend_instance_id
      WHERE t.tenant_id=? AND t.owner_principal_id=? AND t.id=?`).get(scope.tenantId,scope.principalId,threadId) as {backend_instance_id:string;environment_id:string;workspace_id:string;kind:string}|undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row;
  }
  #state(scope:RequestScope, threadId:string): State|undefined {
    return this.database.prepare("SELECT revision,report_json,legacy_json FROM usage_thread_state WHERE tenant_id=? AND principal_id=? AND thread_id=?").safeIntegers().get(scope.tenantId,scope.principalId,threadId) as State|undefined;
  }
  #ensure(scope:RequestScope, threadId:string): void {
    this.database.prepare("INSERT OR IGNORE INTO usage_thread_state(tenant_id,principal_id,thread_id) VALUES(?,?,?)").run(scope.tenantId,scope.principalId,threadId);
  }
  read(scope:RequestScope, threadId:string, turnId:string|null = null): UsageReport {
    const target = this.#authorize(scope,threadId);
    let state = this.#state(scope,threadId);
    if(state && state.report_json===null){this.database.transaction(()=>this.#materialize(scope,threadId))();state=this.#state(scope,threadId);}
    const turn = turnId === null ? undefined : this.database.prepare("SELECT status, report_json FROM usage_turn_state WHERE tenant_id=? AND principal_id=? AND thread_id=? AND turn_id=?").get(scope.tenantId,scope.principalId,threadId,turnId) as {status:UsageReport["turnState"];report_json:string|null}|undefined;
    if (turnId !== null && !turn) throw new DomainError("not_found", "The turn was not found.");
    const stored = turnId === null ? state?.report_json : turn?.report_json;
    const report:UsageReport = stored ? usageReportSchema.parse(JSON.parse(stored)) : {
      threadId,turnId,revision:String(state?.revision ?? 0n),support:target.kind === "grok_build" ? "unsupported" : "supported",state:"unavailable",captureState:"idle",measurementScope:turnId === null ? "session":null,turnState:turn?.status ?? null,lastRecordedAt:null,inherited:false,summary:emptyUsageSummary(),breakdown:turnId===null && target.kind==="codex_app_server"?{main:emptyUsageSummary(),subagents:emptyUsageSummary()}:null,legacy:null,legacyRecordedAt:null,
    };
    if (turnId === null && state?.legacy_json) {
      const legacy = emptyUsageSummary();
      const values = JSON.parse(state.legacy_json) as Partial<Record<UsageTokenKind,string>> & {updatedAt?: number};
      for (const key of USAGE_TOKEN_KINDS) if (values[key] !== undefined) legacy.metrics[key] = {value:usageIntegerSchema.parse(values[key]),quality:"partial",basis:["sdk_normalized"],providerPresence:"unknown"};
      legacy.reasons=["legacy_coverage_unknown"]; report.legacy=legacy;
      report.legacyRecordedAt=values.updatedAt === undefined ? null : new Date(values.updatedAt).toISOString();
    }
    if (this.#failed.has(hash([scope.tenantId,scope.principalId,threadId]))) { report.captureState="failed";report.state=report.state === "unavailable"?"unavailable":"partial";report.summary.reasons=uniq([...report.summary.reasons,"capture_failed"]); }
    if(turnId===null && this.#failedSubagents.has(hash([scope.tenantId,scope.principalId,threadId]))){
      report.captureState="failed";report.state=report.state==="unavailable"?"unavailable":"partial";
      report.summary.reasons=uniq([...report.summary.reasons,"capture_failed"]);
      if(report.breakdown)report.breakdown.subagents.reasons=uniq([...report.breakdown.subagents.reasons,"capture_failed"]);
    }
    return usageReportSchema.parse(report);
  }
  availability(scope:RequestScope,threadId:string,turnIds:readonly string[]):UsageAvailability {
    this.#authorize(scope,threadId);
    if(turnIds.length>100)throw new DomainError("bad_request","Too many turns.");
    const state=this.#state(scope,threadId);
    if(state && state.report_json===null)this.database.transaction(()=>this.#materialize(scope,threadId))();
    // Materialization marks reports unavailable exactly when no metric or cost
    // is recorded. Read that projection without decoding full reports per poll.
    const rows=this.database.prepare(`SELECT turn_id FROM usage_turn_state
      WHERE tenant_id=? AND principal_id=? AND thread_id=?
      AND turn_id IN (SELECT value FROM json_each(?)) AND status<>'in_progress'
      AND json_extract(report_json,'$.support')='supported'
      AND json_extract(report_json,'$.state')<>'unavailable'`)
      .all(scope.tenantId,scope.principalId,threadId,JSON.stringify(turnIds)) as {turn_id:string}[];
    const available=new Set(rows.map(row=>row.turn_id));
    return {threadId,revision:String(this.#state(scope,threadId)?.revision??0n),turns:[...new Set(turnIds)].map(turnId=>({turnId,available:available.has(turnId)}))};
  }
  registerVisibleTurns(scope: RequestScope, threadId: string, turns: readonly ConversationTurn[]): void {
    const failedKey=hash([scope.tenantId,scope.principalId,threadId]);
    try {
      let changes:{threadId:string;revision:string}[]=[];
      this.database.transaction(() => {
        this.#authorize(scope,threadId);this.#ensure(scope,threadId);
        const insert=this.database.prepare("INSERT INTO usage_turn_state(tenant_id,principal_id,thread_id,turn_id,status) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,principal_id,thread_id,turn_id) DO UPDATE SET status=excluded.status");
        for(const turn of turns)insert.run(scope.tenantId,scope.principalId,threadId,turn.id,turn.status);
        changes=this.#materialize(scope,threadId);
      })();
      for(const changed of changes)for(const listener of this.#listeners){try{listener(scope,changed.threadId,changed.revision);}catch{/* Durable reads remain authoritative. */}}
    } catch(error) { this.#recordFailure(scope,threadId,error); }
  }
  #admitBinding(binding: Parameters<UsageSink["open"]>[0]["binding"]) {
    const scope={tenantId:binding.tenantId,principalId:binding.ownerPrincipalId};
    const threadId=binding.applicationThreadId;
    const target=this.#authorize(scope,threadId);
    const durableBinding=this.database.prepare("SELECT backend_conversation_id,backend_instance_id,execution_environment_id,connection_profile_id FROM conversation_bindings WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?").get(scope.tenantId,scope.principalId,threadId) as {backend_conversation_id:string;backend_instance_id:string;execution_environment_id:string;connection_profile_id:string}|undefined;
    // First-send actors attach before the accepted binding is finalized.
    // Their identified native identity is already durably owned by the
    // scoped active creation attempt; capture must include that early work.
    const provisional = !durableBinding && this.database.prepare(`SELECT 1 FROM conversation_creation_attempts
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND backend_instance_id=?
        AND connection_profile_id=? AND execution_environment_id=? AND provisional_backend_conversation_id=?
        AND provisional_opaque_binding_detail IS NOT NULL AND force_reset_at IS NULL
        AND phase IN ('conversation_identified','first_submission_started','accepted_unpersisted','recovery_required')`).get(scope.tenantId,scope.principalId,threadId,binding.backendInstanceId,binding.connectionProfileId,binding.executionEnvironmentId,binding.backendConversationId);
    const admittedBinding = durableBinding ? durableBinding.backend_conversation_id === binding.backendConversationId && durableBinding.backend_instance_id === binding.backendInstanceId && durableBinding.execution_environment_id === binding.executionEnvironmentId && durableBinding.connection_profile_id === binding.connectionProfileId : Boolean(provisional);
    if (!admittedBinding || target.backend_instance_id !== binding.backendInstanceId || target.environment_id !== binding.executionEnvironmentId) throw new Error("usage_binding_not_admitted");
    return target;
  }
  listSubagentRoots(input:Parameters<UsageSink["listSubagentRoots"]>[0]):ReturnType<UsageSink["listSubagentRoots"]> {
    if(!Number.isSafeInteger(input.limit) || input.limit<1 || input.limit>128)throw new DomainError("bad_request","Invalid usage root page size.");
    const rows=this.database.prepare(`SELECT DISTINCT b.tenant_id AS tenantId,b.owner_principal_id AS ownerPrincipalId,
      b.application_thread_id AS applicationThreadId,b.backend_instance_id AS backendInstanceId,
      b.connection_profile_id AS connectionProfileId,b.execution_environment_id AS executionEnvironmentId,
      b.backend_conversation_id AS backendConversationId,b.created_at AS createdAt
      FROM usage_subagents c JOIN conversation_bindings b ON b.tenant_id=c.tenant_id AND b.owner_principal_id=c.principal_id
        AND b.application_thread_id=c.thread_id AND b.backend_instance_id=c.backend_id AND b.execution_environment_id=c.environment_id
        AND b.backend_conversation_id=c.root_native_session
      JOIN agent_backend_instances a ON a.tenant_id=b.tenant_id AND a.id=b.backend_instance_id AND a.kind='codex_app_server'
      WHERE c.tenant_id=? AND c.principal_id=? AND c.backend_id=? AND c.environment_id=? AND c.native_namespace=?
        AND b.connection_profile_id=? AND b.application_thread_id>?
      ORDER BY b.application_thread_id LIMIT ?`).all(input.tenantId,input.principalId,input.backendInstanceId,input.executionEnvironmentId,
        identifier.parse(input.nativeNamespace),input.connectionProfileId,input.cursor??"",input.limit+1) as (Omit<Parameters<UsageSink["open"]>[0]["binding"],"createdAt"> & {createdAt:number})[];
    const bindings=rows.slice(0,input.limit).map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()}));
    for(const binding of bindings)this.#admitBinding(binding);
    return {bindings,nextCursor:rows.length>input.limit?bindings.at(-1)!.applicationThreadId:null};
  }
  listSubagents(input:Parameters<UsageSink["listSubagents"]>[0]):ReturnType<UsageSink["listSubagents"]> {
    this.#admitBinding(input.binding);
    const b=input.binding;
    const rows=this.database.prepare(`SELECT c.native_session,c.native_parent_session,s.epoch,s.normalization_version,s.capture_state
      FROM usage_subagents c JOIN usage_sources s ON s.tenant_id=c.tenant_id AND s.principal_id=c.principal_id
        AND s.thread_id=c.thread_id AND s.backend_id=c.backend_id AND s.environment_id=c.environment_id
        AND s.native_namespace=c.native_namespace AND s.native_session=c.native_session AND s.agent_role='subagent'
      WHERE c.tenant_id=? AND c.principal_id=? AND c.thread_id=? AND c.backend_id=? AND c.environment_id=?
        AND c.native_namespace=? AND c.root_native_session=? ORDER BY s.rowid DESC`)
      .all(b.tenantId,b.ownerPrincipalId,b.applicationThreadId,b.backendInstanceId,b.executionEnvironmentId,identifier.parse(input.nativeNamespace),b.backendConversationId) as {
        native_session:string;native_parent_session:string;epoch:string;normalization_version:string;capture_state:UsageReport["captureState"]}[];
    const seen=new Set<string>();
    return rows.filter(row=>!seen.has(row.native_session) && Boolean(seen.add(row.native_session))).map(row=>({
      nativeSession:row.native_session,nativeParentSession:row.native_parent_session,epoch:row.epoch,
      normalizationVersion:row.normalization_version,captureState:row.capture_state,
    }));
  }
  #admitSubagent(input:Parameters<UsageSink["open"]>[0]):void {
    const b=input.binding, child=identifier.parse(input.nativeSession), parent=identifier.parse(input.subagent!.nativeParentSession);
    const key=[b.tenantId,b.ownerPrincipalId,b.backendInstanceId,b.executionEnvironmentId,identifier.parse(input.nativeNamespace)];
    if(child===parent || child===b.backendConversationId)throw new Error("usage_subagent_invalid_parent");
    if(parent!==b.backendConversationId && !this.database.prepare(`SELECT 1 FROM usage_subagents WHERE tenant_id=? AND principal_id=? AND backend_id=? AND environment_id=? AND native_namespace=? AND native_session=? AND thread_id=? AND root_native_session=?`)
      .get(...key,parent,b.applicationThreadId,b.backendConversationId))throw new Error("usage_subagent_invalid_parent");
    // A normal application conversation can never be charged as somebody else's child.
    if(this.database.prepare(`SELECT 1 FROM conversation_bindings WHERE tenant_id=? AND backend_instance_id=? AND execution_environment_id=? AND backend_conversation_id=?`)
      .get(b.tenantId,b.backendInstanceId,b.executionEnvironmentId,child))throw new Error("usage_source_owned_elsewhere");
    if(this.database.prepare(`SELECT 1 FROM usage_sources WHERE tenant_id=? AND backend_id=? AND environment_id=? AND native_namespace=? AND native_session=? AND (principal_id<>? OR thread_id<>? OR agent_role<>'subagent')`)
      .get(b.tenantId,b.backendInstanceId,b.executionEnvironmentId,input.nativeNamespace,child,b.ownerPrincipalId,b.applicationThreadId))throw new Error("usage_source_owned_elsewhere");
    this.database.prepare(`INSERT OR IGNORE INTO usage_subagents(tenant_id,principal_id,backend_id,environment_id,native_namespace,native_session,native_parent_session,thread_id,root_native_session) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(...key,child,parent,b.applicationThreadId,b.backendConversationId);
    const owned=this.database.prepare(`SELECT 1 FROM usage_subagents WHERE tenant_id=? AND principal_id=? AND backend_id=? AND environment_id=? AND native_namespace=? AND native_session=? AND native_parent_session=? AND thread_id=? AND root_native_session=?`)
      .get(...key,child,parent,b.applicationThreadId,b.backendConversationId);
    if(!owned)throw new Error("usage_source_owned_elsewhere");
  }
  open(input:Parameters<UsageSink["open"]>[0]): UsageCapture {
    const {binding} = input;
    const scope = {tenantId:binding.tenantId,principalId:binding.ownerPrincipalId} as RequestScope;
    const threadId=binding.applicationThreadId;
    const sourceId=hash(input.subagent ? ["subagent",binding.tenantId,binding.ownerPrincipalId,binding.backendInstanceId,binding.executionEnvironmentId,input.nativeNamespace,input.nativeSession,input.epoch] : [binding.tenantId,binding.ownerPrincipalId,input.nativeNamespace,input.nativeSession,input.epoch]);
    const failedKey=hash([scope.tenantId,scope.principalId,threadId]);
    let admitted=false;
    let sealed=false;
    const incarnation=Symbol();
    const run = (action:()=>void):boolean => {
      if(sealed || (admitted && this.#incarnations.get(sourceId)!==incarnation))return false;
      try {
        let changes:{threadId:string;revision:string}[]=[];
        this.database.transaction(() => {
          const target=this.#admitBinding(binding);
          if (input.subagent ? target.kind !== "codex_app_server" : input.nativeSession !== binding.backendConversationId) throw new Error("usage_binding_not_admitted");
          this.#ensure(scope,threadId);
          if(input.subagent)this.#admitSubagent(input);
          else if(this.database.prepare(`SELECT 1 FROM usage_subagents WHERE tenant_id=? AND backend_id=? AND environment_id=? AND native_namespace=? AND native_session=?`)
            .get(scope.tenantId,binding.backendInstanceId,binding.executionEnvironmentId,input.nativeNamespace,input.nativeSession))throw new Error("usage_source_owned_elsewhere");
          this.database.prepare(`INSERT OR IGNORE INTO usage_sources(id,tenant_id,principal_id,thread_id,backend_id,environment_id,workspace_id,native_namespace,native_session,epoch,normalization_version,baseline,capture_state,agent_role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(sourceId,scope.tenantId,scope.principalId,threadId,binding.backendInstanceId,target.environment_id,target.workspace_id,identifier.parse(input.nativeNamespace),identifier.parse(input.nativeSession),identifier.parse(input.epoch),identifier.parse(input.normalizationVersion),input.initialBaseline,input.subagent?"subagent":"main");
          const source=this.database.prepare("SELECT * FROM usage_sources WHERE id=?").get(sourceId) as Source;
          if (source.thread_id !== threadId || source.tenant_id !== scope.tenantId || source.principal_id !== scope.principalId) throw new Error("usage_source_owned_elsewhere");
          if (input.subagent ? this.#failedSubagents.get(failedKey)?.has(sourceId) : this.#failed.has(failedKey)) this.#gap(sourceId,"capture_failed");
          action();
          changes=this.#materialize(scope,threadId);
        })();
        admitted=true; this.#incarnations.set(sourceId,incarnation);
        if(input.subagent){const failed=this.#failedSubagents.get(failedKey);failed?.delete(sourceId);if(failed?.size===0)this.#failedSubagents.delete(failedKey);}
        else this.#failed.delete(failedKey);
        for(const changed of changes)for (const listener of this.#listeners) { try { listener(scope,changed.threadId,changed.revision); } catch { /* Durable reads remain authoritative. */ } }
        return true;
      } catch(error) { this.#recordFailure(scope,threadId,error,input.subagent?sourceId:undefined); return false; }
    };
    run(() => {this.database.prepare("UPDATE usage_sources SET capture_state='active' WHERE id=?").run(sourceId);});
    return {
      registerTurns:(turns, inherited) => run(() => {if(input.subagent) {if(turns.length)this.#gap(sourceId,"invalid_evidence");return;} this.#register(scope,threadId,binding.backendInstanceId,turns,inherited);}),
      capture:(observations) => run(() => {for (const raw of observations) { const parsed=observationSchema.safeParse(raw);if (!parsed.success || (input.subagent && parsed.data.facts.some(fact=>fact.turn!==null || fact.inheritedFrom!==undefined)) || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 65_536) {this.#gap(sourceId,"invalid_evidence");continue;} this.#capture(scope,threadId,binding.backendInstanceId,sourceId,parsed.data,input.normalizationVersion); }}),
      reconcile:() => run(() => {this.database.prepare("DELETE FROM usage_gaps WHERE source_id=? AND reason IN ('capture_gap','capture_failed')").run(sourceId);}),
      gap:(reason) => run(() => this.#gap(sourceId,usageReasonSchema.parse(reason))),
      seal:(reason) => {if (!admitted) return;run(() => {this.database.prepare("UPDATE usage_sources SET capture_state=? WHERE id=?").run(reason === "detached" ? "disconnected":"idle",sourceId);if(reason === "reset")this.#gap(sourceId,"source_reset");});sealed=true;if(this.#incarnations.get(sourceId)===incarnation)this.#incarnations.delete(sourceId);},
    };
  }
  #register(scope:RequestScope,threadId:string,backendId:string,turns:readonly BackendTurn[], inherited?: Parameters<UsageCapture["registerTurns"]>[1]):void {
    const insert=this.database.prepare("INSERT INTO usage_turn_state(tenant_id,principal_id,thread_id,turn_id,status) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,principal_id,thread_id,turn_id) DO UPDATE SET status=excluded.status");
    for(const turn of turns) insert.run(scope.tenantId,scope.principalId,threadId,applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:threadId,backendTurnId:turn.backendTurnId}),turn.status);
    if(inherited){
      const parent="nativeSession" in inherited ? this.database.prepare(`SELECT b.application_thread_id AS id FROM conversation_bindings b
        JOIN thread_lineage_closure l ON l.tenant_id=b.tenant_id AND l.owner_principal_id=b.owner_principal_id AND l.ancestor_thread_id=b.application_thread_id
        WHERE b.tenant_id=? AND b.owner_principal_id=? AND b.backend_instance_id=? AND b.backend_conversation_id=? AND l.descendant_thread_id=?`).get(scope.tenantId,scope.principalId,backendId,inherited.nativeSession,threadId) as {id:string}|undefined : this.database.prepare("SELECT source_thread_id AS id FROM thread_fork_origins WHERE tenant_id=? AND owner_principal_id=? AND child_thread_id=? AND creation_operation_id=? AND source_thread_state='resolved'").get(scope.tenantId,scope.principalId,threadId,inherited.forkOperationId) as {id:string}|undefined;
      if(parent)for(const {backendTurnId,sourceBackendTurnId} of inherited.turns){
        const childTurn=applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:threadId,backendTurnId});
        const originTurn=applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:parent.id,backendTurnId:sourceBackendTurnId});
        if(!this.database.prepare("SELECT 1 FROM usage_turn_state WHERE tenant_id=? AND principal_id=? AND thread_id=? AND turn_id=?").get(scope.tenantId,scope.principalId,parent.id,originTurn))continue;
        this.database.prepare("UPDATE usage_turn_state SET origin_thread_id=?,origin_turn_id=? WHERE tenant_id=? AND principal_id=? AND thread_id=? AND turn_id=?").run(parent.id,originTurn,scope.tenantId,scope.principalId,threadId,childTurn);
      }
    }

  }
  #gap(sourceId:string,reason:UsageReason,subject="",affectsSession=true):void {this.database.prepare("INSERT INTO usage_gaps(source_id,reason,subject,affects_session,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id,reason,subject) DO UPDATE SET affects_session=MAX(usage_gaps.affects_session,excluded.affects_session)").run(sourceId,reason,subject,affectsSession?1:0,new Date().toISOString());}
  #capture(scope:RequestScope,threadId:string,backendId:string,sourceId:string,observation:UsageObservation,normalizationVersion:string):void {
    const semantic={order:observation.order,replaceCheckpoint:observation.replaceCheckpoint,facts:observation.facts};
    const fingerprint=hash(semantic);
    const existing=this.database.prepare("SELECT fingerprint,evidence_json FROM usage_observations WHERE source_id=? AND observation_id=? AND revision=?").get(sourceId,observation.id,observation.revision) as {fingerprint:string;evidence_json:string}|undefined;
    if(existing){
      if(existing.fingerprint!==fingerprint){
        const facts=[...(JSON.parse(existing.evidence_json) as {facts:UsageFact[]}).facts,...observation.facts];
        if(facts.length && facts.every(fact=>fact.turn && fact.sessionContribution!=="checkpoint")){
          for(const fact of facts)this.#gap(sourceId,"conflicting_evidence",applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:threadId,backendTurnId:fact.turn!.backendTurnId}),fact.sessionContribution!=="none");
        }else this.#gap(sourceId,"conflicting_evidence");
      }
      return;
    }
    this.database.prepare("INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?)").run(sourceId,observation.id,observation.revision,fingerprint,canonical(semantic),normalizationVersion,observation.occurredAt,new Date().toISOString());
    const source=this.database.prepare("SELECT * FROM usage_sources WHERE id=?").get(sourceId) as Source;
    if(observation.replaceCheckpoint && observation.order!==null && source.frontier!==null && BigInt(observation.order)<BigInt(source.frontier)) return;
    const previous=this.database.prepare("SELECT r.fact_json, json_extract(o.evidence_json, '$.order') AS source_order FROM usage_records r JOIN usage_observations o ON o.source_id=r.source_id AND o.observation_id=r.observation_id AND o.revision=r.observation_revision WHERE r.source_id=?").all(sourceId) as {fact_json:string;source_order:string|null}[];
    const oldFacts=previous.map(row=>JSON.parse(row.fact_json) as UsageFact);
    const locked = this.database.prepare("SELECT 1 FROM usage_gaps WHERE source_id=? AND subject='' AND reason IN ('counter_regression','conflicting_evidence')").get(sourceId);
    if (locked && observation.facts.some(f => f.sessionContribution === "checkpoint")) return;
    if(observation.replaceCheckpoint){
      for(const key of USAGE_TOKEN_KINDS){
        const before=oldFacts.filter(f=>f.sessionContribution==="checkpoint" && f.tokens[key] != null);
        const after=observation.facts.filter(f=>f.sessionContribution==="checkpoint" && f.tokens[key] != null);
        if(before.length && (!after.length || after.reduce((n,f)=>n+BigInt(f.tokens[key]!),0n)<before.reduce((n,f)=>n+BigInt(f.tokens[key]!),0n))){this.#gap(sourceId,"counter_regression");return;}
      }
      const oldCosts=oldFacts.filter(f=>f.sessionContribution==="checkpoint").flatMap(f=>f.costs);
      const newCosts=observation.facts.filter(f=>f.sessionContribution==="checkpoint").flatMap(f=>f.costs);
      for(const currency of uniq(oldCosts.map(cost=>cost.currency))){
        const oldAmount=addUsageMoney(oldCosts.filter(cost=>cost.currency===currency).map(cost=>cost.amount));
        const newAmount=addUsageMoney(newCosts.filter(cost=>cost.currency===currency).map(cost=>cost.amount));
        const scale=Math.max(oldAmount.split(".")[1]?.length??0,newAmount.split(".")[1]?.length??0);
        const units=(amount:string)=>{const [whole,fraction=""]=amount.split(".");return BigInt(whole!+fraction.padEnd(scale,"0"));};
        if(units(newAmount)<units(oldAmount)){this.#gap(sourceId,"counter_regression");return;}
      }
      this.database.prepare("DELETE FROM usage_records WHERE source_id=? AND json_extract(fact_json,'$.sessionContribution')='checkpoint' AND fact_id NOT IN (SELECT value FROM json_each(?))").run(sourceId,JSON.stringify(observation.facts.filter(f=>f.sessionContribution==="checkpoint").map(f=>f.id)));
    }
    for(const fact of observation.facts){
      if(fact.inheritedFrom){this.#gap(sourceId,"inherited_baseline_unknown");continue;}
      const old=oldFacts.find(f=>f.id===fact.id);
      if(old && canonical(old)===canonical(fact))continue;
      if(old && !observation.replaceCheckpoint){
        const subject=fact.turn?applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:threadId,backendTurnId:fact.turn.backendTurnId}):"";
        if(fact.sessionContribution==="none" && fact.turn?.contribution==="checkpoint"){
          const oldOrder=previous[oldFacts.indexOf(old)]!.source_order;
          if(observation.order!==null && oldOrder!==null){
            if(BigInt(observation.order)<BigInt(oldOrder))continue;
            if(BigInt(observation.order)===BigInt(oldOrder)){this.#gap(sourceId,"conflicting_evidence",subject,fact.sessionContribution!=="none");continue;}
          }else{this.#gap(sourceId,"conflicting_evidence",subject,fact.sessionContribution!=="none");continue;}
        }else if(fact.sessionContribution!=="checkpoint"){this.#gap(sourceId,"conflicting_evidence",subject,fact.sessionContribution!=="none");continue;}
        else if(USAGE_TOKEN_KINDS.some(key=>old.tokens[key]!=null && (fact.tokens[key]==null || BigInt(fact.tokens[key]!)<BigInt(old.tokens[key]!)))){this.#gap(sourceId,"counter_regression");continue;}
      }
      const turnId=fact.turn?applicationTurnIdForBackendTurn({backendInstanceId:backendId,sourceApplicationThreadId:threadId,backendTurnId:fact.turn.backendTurnId}):null;
      const values=USAGE_TOKEN_KINDS.map(key=>fact.tokens[key]==null?null:BigInt(fact.tokens[key]!));
      this.database.prepare(`INSERT INTO usage_records(source_id,fact_id,observation_id,observation_revision,turn_id,fact_json,${USAGE_TOKEN_KINDS.join(",")}) VALUES(${Array(14).fill("?").join(",")}) ON CONFLICT(source_id,fact_id) DO UPDATE SET observation_id=excluded.observation_id,observation_revision=excluded.observation_revision,turn_id=excluded.turn_id,fact_json=excluded.fact_json,${USAGE_TOKEN_KINDS.map(key=>`${key}=excluded.${key}`).join(",")}`).run(sourceId,fact.id,observation.id,observation.revision,turnId,canonical(fact),...values);
    }
    if(observation.replaceCheckpoint && observation.order!==null && (source.frontier===null || BigInt(observation.order)>BigInt(source.frontier)))this.database.prepare("UPDATE usage_sources SET frontier=? WHERE id=?").run(observation.order,sourceId);
  }
  #summarize(records:StoredFact[],turn:boolean,reasons:UsageReason[]):UsageSummary {
    const summary=emptyUsageSummary();
    summary.reasons=uniq(reasons);
    const select=(has:(f:UsageFact)=>boolean):StoredFact[]=>{
      const candidates=records.filter(({fact})=>has(fact));
      const checkpoints=new Set(candidates.filter(({fact})=>(turn?fact.turn?.contribution:fact.sessionContribution)==="checkpoint")
        .map(row=>turn?row.fact.coverageDomain:row.sourceId));
      return candidates.filter(row=>{const mode=turn?row.fact.turn?.contribution:row.fact.sessionContribution;
        return mode==="checkpoint" || (mode==="additive" && !checkpoints.has(turn?row.fact.coverageDomain:row.sourceId));});
    };
    const contributing = [...new Set([...USAGE_TOKEN_KINDS.flatMap(key => select(f => f.tokens[key] != null)), ...select(f => f.costs.length > 0)])];
    summary.reasons = uniq([...reasons, ...contributing.flatMap(({fact}) => fact.reasons)]);
    const conflict=summary.reasons.some(reason=>["counter_regression","conflicting_evidence"].includes(reason));
    for(const key of USAGE_TOKEN_KINDS){
      const chosen=select(f=>f.tokens[key]!=null);
      if(!chosen.length)continue;
      const total=chosen.reduce((n,{fact})=>n+BigInt(fact.tokens[key]!),0n);
      if(total>maximum){summary.reasons=uniq([...summary.reasons,"invalid_evidence"]);summary.metrics[key].quality="conflict";continue;}
      summary.metrics[key]={value:String(total),quality:conflict?"conflict":hasIncompleteUsage(summary.reasons) || chosen.some(({fact})=>fact.quality!=="complete")?"partial":"complete",basis:uniq(chosen.flatMap(({fact})=>fact.basis)),providerPresence:chosen.every(({fact})=>fact.providerPresence==="reported")?"reported":"unknown"};
    }
    const chosen=select(f=>f.costs.length>0);
    const groups=new Map<string,{money:UsageFact["costs"][number];values:string[]}>();
    for(const {fact} of chosen)for(const money of fact.costs){const key=canonical([money.currency,money.kind,money.provenance]);const group=groups.get(key)??{money,values:[]};group.values.push(money.amount);groups.set(key,group);}
    summary.costs=[...groups.values()].map(({money,values})=>({...money,amount:addUsageMoney(values),quality:conflict?"conflict":hasIncompleteUsage(summary.reasons) || chosen.some(({fact})=>fact.quality==="partial")?"partial":"complete",billing:"unknown"}));
    summary.costQuality=summary.costs.length?(conflict?"conflict":summary.costs.some(c=>c.quality==="partial")?"partial":"complete"):"unreported";
    summary.models=[...new Map(contributing.flatMap(({fact})=>fact.models).map(model=>[canonical(model),model])).values()];
    if(summary.models.length>64){summary.models=summary.models.slice(0,64);summary.reasons=uniq([...summary.reasons,"model_coverage_unknown"]);}
    if(summary.costs.length>32){summary.costs=summary.costs.slice(0,32);summary.costQuality="partial";summary.reasons=uniq([...summary.reasons,"unknown_attribution"]);}

    return summary;
  }
  #materialize(scope:RequestScope,threadId:string):{threadId:string;revision:string}[] {
    const args=[scope.tenantId,scope.principalId,threadId];
    // A projection-shape migration invalidates both roots and inherited turn
    // reports. Rebuild ancestor reports before copying their turn summaries.
    const staleOrigins=this.database.prepare(`SELECT DISTINCT t.origin_thread_id FROM usage_turn_state t
      JOIN usage_thread_state s ON s.tenant_id=t.tenant_id AND s.principal_id=t.principal_id AND s.thread_id=t.origin_thread_id
      WHERE t.tenant_id=? AND t.principal_id=? AND t.thread_id=? AND s.report_json IS NULL`).all(...args) as {origin_thread_id:string}[];
    for(const origin of staleOrigins)this.#materialize(scope,origin.origin_thread_id);
    const state=this.#state(scope,threadId)!;
    const revision=state.revision;
    const rows=this.database.prepare("SELECT r.source_id,r.turn_id,r.fact_json,o.received_at FROM usage_records r JOIN usage_sources s ON s.id=r.source_id JOIN usage_observations o ON o.source_id=r.source_id AND o.observation_id=r.observation_id AND o.revision=r.observation_revision WHERE s.tenant_id=? AND s.principal_id=? AND s.thread_id=?").all(...args) as {source_id:string;turn_id:string|null;fact_json:string;received_at:string}[];
    const records=rows.map(row=>({sourceId:row.source_id,turnId:row.turn_id,recordedAt:row.received_at,fact:JSON.parse(row.fact_json) as UsageFact}));
    const gaps=this.database.prepare("SELECT g.source_id,g.reason,g.subject,g.affects_session FROM usage_gaps g JOIN usage_sources s ON s.id=g.source_id WHERE s.tenant_id=? AND s.principal_id=? AND s.thread_id=?").all(...args) as {source_id:string;reason:UsageReason;subject:string;affects_session:number}[];
    const sources=this.database.prepare("SELECT * FROM usage_sources WHERE tenant_id=? AND principal_id=? AND thread_id=?").all(...args) as Source[];
    const childIds=new Set(sources.filter(source=>source.agent_role==="subagent").map(source=>source.id));
    const last={time:records.filter(row=>row.fact.sessionContribution!=="none").map(row=>row.recordedAt).sort().at(-1)??null};
    const byTurn=new Map<string,StoredFact[]>();
    for(const row of records)if(row.turnId && !childIds.has(row.sourceId)){const entries=byTurn.get(row.turnId)??[];entries.push(row);byTurn.set(row.turnId,entries);}
    const make=(turnId:string|null,turnState:UsageReport["turnState"]):UsageReport=>{
      const selected=turnId===null?records:byTurn.get(turnId)??[];
      const reportSources=turnId===null?sources:sources.filter(source=>source.agent_role==="main");
      const sourceIds=new Set(selected.map(row=>row.sourceId));
      const reasons=uniq(gaps.filter(gap=>turnId===null ? gap.affects_session===1 : gap.subject===turnId || (gap.subject==="" && sourceIds.has(gap.source_id))).map(gap=>gap.reason));
      const summary=this.#summarize(selected,turnId!==null,reasons);
      const breakdown=turnId===null && this.#authorize(scope,threadId).kind==="codex_app_server" ? {
        main:this.#summarize(records.filter(row=>!childIds.has(row.sourceId)),false,uniq(gaps.filter(gap=>gap.affects_session===1 && !childIds.has(gap.source_id)).map(gap=>gap.reason))),
        subagents:this.#summarize(records.filter(row=>childIds.has(row.sourceId)),false,uniq(gaps.filter(gap=>gap.affects_session===1 && childIds.has(gap.source_id)).map(gap=>gap.reason))),
      }:null;
      const scopes=uniq(selected.flatMap(({fact})=>fact.turn?[fact.turn.scope]:[]));
      const hasValue=Object.values(summary.metrics).some(m=>m.value!==null)||summary.costs.length>0;
      const complete=hasValue && !hasIncompleteUsage(summary.reasons) && Object.values(summary.metrics).every(m=>m.quality==="complete"||m.quality==="unreported") && (summary.costQuality==="complete"||summary.costQuality==="unreported") && (turnId===null || (turnState==="completed" && scopes.length===1 && (scopes[0]==="whole_turn"||scopes[0]==="main_loop")));
      return usageReportSchema.parse({threadId,turnId,revision:String(revision),support:this.#authorize(scope,threadId).kind === "grok_build" ? "unsupported" : "supported",state:hasValue?(complete?"complete":"partial"):"unavailable",captureState:reportSources.some(s=>s.capture_state==="active")?"active":reportSources.some(s=>s.capture_state==="disconnected")?"disconnected":"idle",measurementScope:turnId===null?"session":scopes.length===1?scopes[0]:scopes.length?"partial_interval":null,turnState,lastRecordedAt:turnId===null?last.time:selected.map(row=>row.recordedAt).sort().at(-1)??null,inherited:false,summary,breakdown,legacy:null,legacyRecordedAt:null});
    };
    const report=make(null,null);
    const turns=this.database.prepare("SELECT turn_id,status,report_json,origin_thread_id,origin_turn_id FROM usage_turn_state WHERE tenant_id=? AND principal_id=? AND thread_id=?").all(...args) as {turn_id:string;status:UsageReport["turnState"];report_json:string|null;origin_thread_id:string|null;origin_turn_id:string|null}[];
    const reports=turns.map(turn=>{
      let report=make(turn.turn_id,turn.status);
      if(turn.origin_thread_id && turn.origin_turn_id){
        const original=this.database.prepare("SELECT report_json FROM usage_turn_state WHERE tenant_id=? AND principal_id=? AND thread_id=? AND turn_id=?").get(scope.tenantId,scope.principalId,turn.origin_thread_id,turn.origin_turn_id) as {report_json:string|null}|undefined;
        if(original?.report_json)report={...usageReportSchema.parse(JSON.parse(original.report_json)),threadId,turnId:turn.turn_id,revision:String(revision),turnState:turn.status};
        report.inherited=true;
      }
      return {turn,report};
    });
    const unchanged=(before:string|null, after:UsageReport):boolean => before !== null && canonical({...JSON.parse(before),revision:"0"})===canonical({...after,revision:"0"});
    if(unchanged(state.report_json,report) && reports.every(({turn,report})=>unchanged(turn.report_json,report)))return [];
    report.revision=String(revision+1n);
    this.database.prepare("UPDATE usage_thread_state SET revision=?,report_json=? WHERE tenant_id=? AND principal_id=? AND thread_id=?").run(revision+1n,JSON.stringify(report),...args);
    for(const {turn,report} of reports){report.revision=String(revision+1n);this.database.prepare("UPDATE usage_turn_state SET report_json=? WHERE tenant_id=? AND principal_id=? AND thread_id=? AND turn_id=?").run(JSON.stringify(report),...args,turn.turn_id);}
    const children=this.database.prepare("SELECT DISTINCT thread_id FROM usage_turn_state WHERE tenant_id=? AND principal_id=? AND origin_thread_id=?").all(...args) as {thread_id:string}[];
    return [{threadId,revision:String(revision+1n)},...children.flatMap(child=>this.#materialize(scope,child.thread_id))];

  }
}
