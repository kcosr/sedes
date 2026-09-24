import { usageSubagentRecoveryIndexesMigration } from "../../src/server/db/migrations/114-usage-subagent-recovery-indexes.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { usageTimelineMigration } from "../../src/server/db/migrations/113-usage-timeline.js";
import type { UsageFact, UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { usageCostAmount, usageCostUnits } from "../../src/server/usage/usage-timeline.js";
import { zonedBuckets, zonedInstant } from "../../src/server/usage/zoned-time.js";
import { usageAnalyticsResponseSchema, type UsageAnalyticsRequest } from "../../src/shared/protocol/usage-analytics.js";

const scope = {tenantId: "tenant", principalId: "principal"};
const databases: Database.Database[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) if (db.open) db.close(); });

function database(kind = "codex_app_server"): Database.Database {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys = ON");
  db.exec(`
CREATE TABLE application_threads(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,environment_id TEXT NOT NULL,workspace_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT 'Thread',last_activity_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,owner_principal_id,id));
CREATE TABLE agent_backend_instances(tenant_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL DEFAULT 'Backend',owner_principal_id TEXT,PRIMARY KEY(tenant_id,id));
CREATE TABLE execution_environments(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL);
CREATE TABLE workspaces(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,environment_id TEXT NOT NULL,id TEXT NOT NULL,canonical_path TEXT NOT NULL,display_name TEXT NOT NULL,removed_at INTEGER);
CREATE TABLE thread_principal_state(tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,thread_id TEXT NOT NULL,inventory_state TEXT NOT NULL);
CREATE TABLE conversation_bindings(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,execution_environment_id TEXT NOT NULL,backend_conversation_id TEXT NOT NULL,connection_profile_id TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 1790035200000);
CREATE TABLE conversation_creation_attempts(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,force_reset_at INTEGER,phase TEXT);
CREATE TABLE thread_lineage_closure(tenant_id TEXT, owner_principal_id TEXT, ancestor_thread_id TEXT, descendant_thread_id TEXT);
CREATE TABLE thread_fork_origins(tenant_id TEXT, owner_principal_id TEXT, child_thread_id TEXT, source_thread_id TEXT, creation_operation_id TEXT, source_thread_state TEXT);
CREATE TABLE claude_usage_ledgers(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,request_count INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO agent_backend_instances(tenant_id,id,kind,label) VALUES('tenant','backend','${kind}','Primary');
INSERT INTO execution_environments VALUES('tenant','principal','environment','local','Laptop');
INSERT INTO workspaces VALUES('tenant','principal','environment','workspace','/src/app','App',NULL);`);
  for (const migration of [durableUsageAccountingMigration, usageGapSessionScopeMigration, usageSubagentsMigration, usageTimelineMigration, usageSubagentRecoveryIndexesMigration]) db.exec(migration.sql);
  addThread(db, "thread", "First thread");
  return db;
}
function addThread(db: Database.Database, id: string, title: string, principal = "principal"): void {
  db.prepare("INSERT INTO application_threads(tenant_id,owner_principal_id,id,backend_instance_id,environment_id,workspace_id,title) VALUES('tenant',?,?,'backend','environment','workspace',?)").run(principal, id, title);
  db.prepare("INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant',?,?,'backend','environment',?,'connection')").run(principal, id, `native-${id}`);
}
function source(thread = "thread", initialBaseline: "proven_zero" | "unknown" = "proven_zero", principal = "principal"): Parameters<UsageSink["open"]>[0] {
  return {binding: {tenantId: "tenant", ownerPrincipalId: principal, applicationThreadId: thread, backendInstanceId: "backend", executionEnvironmentId: "environment",
    connectionProfileId: "connection", backendConversationId: `native-${thread}`, createdAt: "2026-09-01T00:00:00Z"},
  nativeNamespace: "store", nativeSession: `native-${thread}`, epoch: "epoch", normalizationVersion: "fixture-v1", initialBaseline};
}
function fact(id: string, tokens: UsageFact["tokens"], overrides: Partial<UsageFact> = {}): UsageFact {
  return {id, kind: "operation", sessionContribution: "additive", coverageDomain: "entries", tokens, costs: [], models: [{provider: "anthropic", model: "claude"}],
    basis: ["sdk_normalized"], providerPresence: "unknown", quality: "complete", reasons: [], activity: "model", turn: null, ...overrides};
}
function counter(id: string, tokens: UsageFact["tokens"], extra: Partial<UsageObservation> = {}): UsageObservation {
  return {id, revision: "1", order: null, provenance: "live", occurredAt: null, replaceCheckpoint: true,
    facts: [fact("session-counter", tokens, {kind: "cumulative", sessionContribution: "checkpoint", models: [{provider: null, model: null}]})], ...extra};
}
function request(overrides: Partial<UsageAnalyticsRequest> = {}): UsageAnalyticsRequest {
  return {from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z", timeZone: "UTC", bucket: "day", filters: {},
    groupBy: null, crossBy: null, breakdownLimit: 20, facets: false, ...overrides};
}
const at = (value: string) => { vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(new Date(value)); };
const rows = (db: Database.Database) => db.prepare("SELECT fact_id,placement,occurred_at,interval_start,input,output,model,effort,cost_units FROM usage_increments ORDER BY id").safeIntegers(false).all();

describe("bucket time-index query plan", () => {
  function fixture() {
    const db = database("pi"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-11-02T00:00:00Z");
    const entry = (id: string, time: string, input: string, model: string | null = "known") => ({
      ...counter(id, {}), replaceCheckpoint: false, occurredAt: `2026-11-01T${time}.000Z`,
      facts: [fact(id, {input, output: "0"}, {models: [{provider: "provider", model}],
        costs: [{amount: "0.1", currency: "USD", kind: "reported" as const, provenance: "fixture"}]})],
    });
    capture.capture([
      entry("before", "04:59:59", "1"), entry("start", "05:00:00", "2"),
      entry("repeated-hour", "06:00:00", "3", null), entry("last-bucket", "07:00:00", "5"),
      entry("exclusive-end", "07:30:00", "7"), entry("contained", "05:20:00", "11"),
      entry("spanning", "06:05:00", "13"), entry("straddling", "05:10:00", "17"),
    ]);
    // Seed exact interval projections so this regression isolates read planning.
    for (const [id, start] of [["contained", "05:10:00"], ["spanning", "05:55:00"], ["straddling", "04:50:00"]]) {
      db.prepare("UPDATE usage_increments SET placement='interval',interval_start=? WHERE fact_id=?")
        .run(`2026-11-01T${start}.000Z`, id);
    }
    addThread(db, "foreign", "Other principal", "other");
    service.open(source("foreign", "proven_zero", "other")).capture([entry("foreign", "05:00:00", "1000")]);
    const query = request({from: "2026-11-01T05:00:00.000Z", to: "2026-11-01T07:30:00.000Z",
      timeZone: "America/New_York", bucket: "hour", groupBy: "model", crossBy: "provider", breakdownLimit: 1});
    return {db, service, query};
  }

  it.each([
    {}, {model: [null]}, {model: ["known", null], thread: ["thread"]},
    {model: ["known"], provider: ["provider"], environment: ["environment"]}, {workspace: ["missing"]},
  ])("preserves exact filtered, grouped DST and interval results (%j)", filters => {
    const {db, service, query} = fixture();
    const optimized = service.analytics(scope, {...query, filters});
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(sql => prepare(sql.replaceAll(
      "FROM b CROSS JOIN usage_increments INDEXED BY usage_increments_time ON", "FROM b JOIN usage_increments ON")));
    try { expect(service.analytics(scope, {...query, filters})).toEqual(optimized); }
    finally { spy.mockRestore(); }
    if (Object.keys(filters).length === 0) {
      expect(optimized.buckets.map(bucket => bucket.start)).toEqual([
        "2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z",
      ]);
      expect(optimized.totals.tokens).toBe("34");
      expect(optimized.timeline.overall.tokens).toEqual(["13", "3", "5"]);
      expect(optimized.placement).toMatchObject({interval: "11", spanning: "13", straddling: "17"});
      expect(optimized.timeline.series.find(series => series.key === null)?.points.tokens).toEqual(["0", "3", "0"]);
    }
  });

  it("range-scans the scoped time index inside buckets for overall, grouped and interval queries", () => {
    const {db, service, query} = fixture();
    const prepare = db.prepare.bind(db);
    const plans: {detail: string}[][] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("WITH b(i,s,e)")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters) => {
          plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {detail: string}[]);
          return all(...parameters);
        });
      }
      return statement;
    });
    try { service.analytics(scope, query); }
    finally { spy.mockRestore(); }
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      const buckets = plan.findIndex(row => row.detail.includes("SCAN json_each"));
      const increments = plan.findIndex(row => row.detail.includes("SEARCH usage_increments USING INDEX usage_increments_time") &&
        row.detail.includes("tenant_id=? AND principal_id=? AND occurred_at>? AND occurred_at<?"));
      expect(buckets).toBeGreaterThanOrEqual(0);
      expect(increments).toBeGreaterThan(buckets);
    }
  });
});

describe("usage timeline projection", () => {
  it("records checkpoint increases so their sum equals the selected session total", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "10"})]);
    at("2026-09-02T10:05:00Z"); capture.capture([counter("b", {input: "150", output: "30"})]);
    capture.capture([counter("b", {input: "150", output: "30"})]);
    expect(rows(db)).toMatchObject([
      {placement: "observed", occurred_at: "2026-09-02T10:00:00.000Z", input: 100, output: 10},
      {placement: "observed", occurred_at: "2026-09-02T10:05:00.000Z", input: 50, output: 20},
    ]);
    const session = service.read(scope, "thread").summary.metrics;
    const result = service.analytics(scope, request());
    expect(result.totals).toMatchObject({input: session.input.value, output: session.output.value, tokens: "180"});
    expect(result.timeline.overall.tokens[1]).toBe("180");
  });

  it("places deltas across a capture gap only when the whole interval fits one bucket", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"})]);
    capture.gap("capture_gap");
    at("2026-09-02T18:00:00Z"); capture.capture([counter("b", {input: "300", output: "0"})]);
    capture.gap("capture_gap");
    at("2026-09-04T09:00:00Z"); capture.capture([counter("c", {input: "600", output: "0"})]);
    at("2026-09-04T09:01:00Z"); capture.capture([counter("d", {input: "610", output: "0"})]);
    expect(rows(db).map((row) => (row as {placement: string}).placement)).toEqual(["observed", "interval", "interval", "observed"]);
    const daily = service.analytics(scope, request());
    expect(daily.timeline.overall.input.slice(0, 4)).toEqual(["0", "300", "0", "10"]);
    expect(daily.totals.input).toBe("610");
    expect(daily.placement).toMatchObject({observed: "110", interval: "200", spanning: "300", unplaced: "0"});
    const weekly = service.analytics(scope, request({bucket: "week", from: "2026-08-31T00:00:00.000Z"}));
    expect(weekly.placement).toMatchObject({interval: "500", spanning: "0"});
  });

  it("continues an observed series across checkpoints delivered in one batch", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source("thread", "unknown"));
    at("2026-09-02T10:00:00Z");
    capture.capture([counter("a", {input: "100", output: "0"}), counter("b", {input: "140", output: "0"})]);
    expect(rows(db)).toMatchObject([{placement: "unplaced", input: 100}, {placement: "observed", input: 40}]);
  });

  it("keeps an unknown-baseline checkpoint out of every time range", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source("thread", "unknown"));
    at("2026-09-03T12:00:00Z"); capture.capture([counter("a", {input: "900", output: "100"})]);
    at("2026-09-03T12:01:00Z"); capture.capture([counter("b", {input: "950", output: "110"})]);
    const result = service.analytics(scope, request());
    expect(result.totals.tokens).toBe("60");
    expect(result.placement).toMatchObject({unplaced: "1000", observed: "60"});
    expect(service.read(scope, "thread").summary.metrics.input.value).toBe("950");
  });

  it("applies backend attribution only to observed increments and never to the evidence fingerprint", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const attribution = {model: {provider: "openai", model: "gpt-5.5"}, reasoningEffort: "high"};
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"}, {attribution})]);
    capture.capture([counter("a", {input: "100", output: "0"}, {attribution: {model: null, reasoningEffort: "low"}})]);
    capture.gap("capture_gap");
    at("2026-09-02T11:00:00Z"); capture.capture([counter("b", {input: "130", output: "0"}, {attribution})]);
    expect(rows(db)).toMatchObject([
      {placement: "observed", model: "gpt-5.5", effort: "high", input: 100},
      {placement: "interval", model: null, effort: null, input: 30},
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_gaps WHERE reason='conflicting_evidence'").get()).toEqual({count: 0});
    expect(db.prepare("SELECT evidence_json FROM usage_observations WHERE observation_id='a'").pluck().get()).not.toContain("attribution");
    const result = service.analytics(scope, request({groupBy: "effort"}));
    expect(result.breakdowns.effort.rows.map((row) => [row.key, row.totals.tokens])).toEqual([["high", "100"], [null, "30"]]);
    expect(result.coverage.effortUnknownTokens).toBe("30");
  });

  it("uses reported occurrence time and fact models for additive evidence", () => {
    const db = database("pi"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-06T00:00:00Z");
    capture.capture([
      {...counter("x", {}), id: "x", replaceCheckpoint: false, occurredAt: "2026-09-02T08:30:00.000Z",
        facts: [fact("x", {input: "40", output: "8", cacheRead: "30", cacheWrite: "0", requests: "1"}, {costs: [{amount: "0.0004", currency: "USD", kind: "estimated", provenance: "sdk"}]})]},
      {...counter("y", {}), id: "y", replaceCheckpoint: false, occurredAt: "2026-09-03T20:00:00.000Z",
        facts: [fact("y", {input: "10", output: "2"}, {models: [{provider: "openai", model: "gpt"}], costs: [{amount: "0.000000000000123456", currency: "USD", kind: "estimated", provenance: "sdk"}]})]},
    ]);
    const result = service.analytics(scope, request({groupBy: "model", timeZone: "America/Los_Angeles"}));
    expect(result.placement.reported).toBe("60");
    expect(result.totals).toMatchObject({tokens: "60", requests: "1", uncachedInput: "10", costs: [{currency: "USD", amount: "0.0004", kind: "estimated"}]});
    expect(result.totals.missing).toMatchObject({requests: "1", cacheRead: "1", uncachedInput: "1"});
    expect(result.timeline.series.map((entry) => entry.key)).toEqual(["claude", "gpt"]);
    expect(result.labels.thread.thread).toMatchObject({label: "First thread", kind: "pi", workspaceId: "workspace"});
    expect(result.labels.workspace.workspace).toMatchObject({label: "App", detail: "Laptop · /src/app"});
    expect(result.labels.environment.environment).toMatchObject({label: "Laptop", kind: "local"});
    const heat = new Map(result.heatmap.map((cell) => [`${cell.weekday}:${cell.hour}`, cell.tokens]));
    expect(heat.get("2:1")).toBe("48");
    expect(heat.get("3:13")).toBe("12");
  });

  it("splits a cumulative cost summary by model only when supplied model totals add up", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, input: string, cost: string) => fact(`model:${name}`, {input, output: "0"}, {kind: "cumulative", sessionContribution: "checkpoint",
      models: [{provider: "firstParty", model: name}], pricing: {canonicalModel: null, basis: null, components: [{kind: "model_total", amount: cost, currency: "USD"}]}});
    const summary = (amount: string) => fact("query_cost", {}, {kind: "cumulative", sessionContribution: "checkpoint", models: [], costs: [{amount, currency: "USD", kind: "estimated", provenance: "sdk"}]});
    at("2026-09-02T10:00:00Z"); capture.capture([{...counter("a", {}), facts: [model("opus", "100", "0.3"), model("haiku", "50", "0.0100000001"), summary("0.31")]}]);
    at("2026-09-02T10:10:00Z"); capture.capture([{...counter("b", {}), facts: [model("opus", "150", "0.5"), model("haiku", "50", "0.02"), summary("0.9")]}]);
    const cost = (key: string | null) => service.analytics(scope, request()).breakdowns.model.rows.find((row) => row.key === key)?.totals.costs[0]?.amount;
    expect(cost("opus")).toBe("0.3");
    expect(cost("haiku")).toBe("0.0100000001");
    expect(cost(null)).toBe("0.59");
    expect(service.analytics(scope, request()).totals.costs[0]?.amount).toBe("0.9000000001");
    expect(service.analytics(scope, request()).totals.uncostedTokens).toBe("0");
  });

  it("rebuilds sources captured before the projection with conservative placement", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"})]);
    at("2026-09-02T10:05:00Z"); capture.capture([counter("b", {input: "160", output: "0"})]);
    at("2026-09-02T10:06:00Z"); capture.capture([counter("c", {input: "150", output: "0"})]);
    db.exec("DELETE FROM usage_increments; UPDATE usage_sources SET timeline_state='backfill'");
    const rebuilt = new UsageService(db, {enabled: true}).analytics(scope, request());
    expect(rows(db)).toMatchObject([
      {placement: "observed", input: 100, interval_start: null},
      {placement: "interval", input: 60, interval_start: "2026-09-02T10:00:00.000Z"},
    ]);
    expect(rebuilt.totals.input).toBe(service.read(scope, "thread").summary.metrics.input.value);
    expect(db.prepare("SELECT timeline_state FROM usage_sources").pluck().get()).toBe("current");
    db.exec("DELETE FROM usage_increments; UPDATE usage_sources SET timeline_state='backfill'");
    db.exec("UPDATE usage_records SET fact_json=json_set(fact_json,'$.tokens.input','170'), input=170");
    new UsageService(db, {enabled: true}).analytics(scope, request());
    expect(rows(db)).toMatchObject([{placement: "unplaced", input: 170}]);
  });

  it("backfills before live capture continues a pending source", () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    at("2026-09-02T10:00:00Z"); service.open(source()).capture([counter("a", {input: "100", output: "0"})]);
    db.exec("DELETE FROM usage_increments; UPDATE usage_sources SET timeline_state='backfill'");
    at("2026-09-02T10:05:00Z"); service.open(source("thread", "unknown")).capture([counter("b", {input: "130", output: "0"})]);
    expect(rows(db)).toMatchObject([{placement: "observed", input: 100}, {placement: "interval", input: 30}]);
  });
});

describe("usage timeline review regressions", () => {
  it("restores continuity when a reopened series replays its last checkpoint unchanged", () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    at("2026-09-01T10:00:00Z"); service.open(source()).capture([counter("a", {input: "100", output: "0"})]);
    const reopened = service.open(source("thread", "unknown"));
    at("2026-09-05T09:00:00Z"); reopened.capture([counter("replay", {input: "100", output: "0"})]);
    at("2026-09-05T09:01:00Z"); reopened.capture([counter("b", {input: "150", output: "0"})]);
    at("2026-09-05T09:02:00Z"); reopened.capture([counter("c", {input: "200", output: "0"})]);
    expect(rows(db).map((row) => (row as {placement: string}).placement)).toEqual(["observed", "observed", "observed"]);
    expect(service.analytics(scope, request({from: "2026-09-05T00:00:00.000Z", to: "2026-09-06T00:00:00.000Z"})).totals.input).toBe("100");
  });

  it("breaks continuity after a failed capture write", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    db.exec("CREATE TRIGGER fail_boom BEFORE INSERT ON usage_observations WHEN NEW.observation_id='boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"})]);
    at("2026-09-02T12:00:00Z"); capture.capture([counter("boom", {input: "500", output: "0"})]);
    at("2026-09-04T09:00:00Z"); capture.capture([counter("c", {input: "900", output: "0"})]);
    expect(rows(db)).toMatchObject([{placement: "observed", input: 100}, {placement: "interval", input: 800, interval_start: "2026-09-02T10:00:00.000Z"}]);
  });

  it("keeps a proven-zero reopen of a recorded series from claiming continuity", () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    at("2026-09-02T10:00:00Z"); service.open(source()).capture([counter("a", {input: "100", output: "0"})]);
    at("2026-09-03T10:00:00Z"); service.open(source()).capture([counter("b", {input: "160", output: "0"})]);
    expect(rows(db)).toMatchObject([{placement: "observed"}, {placement: "interval", input: 60}]);
  });

  it("extends all time to interval starts and reports intervals that straddle a range start", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source("thread", "unknown"));
    at("2026-09-01T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"})]);
    capture.gap("capture_gap");
    at("2026-09-03T10:00:00Z"); capture.capture([counter("b", {input: "300", output: "0"})]);
    at("2026-09-03T10:01:00Z"); capture.capture([counter("c", {input: "310", output: "0"})]);
    const all = service.analytics(scope, request({from: null, to: "2026-09-04T00:00:00.000Z", bucket: "week"}));
    expect(all.firstRecordedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(all.totals.input).toBe("210");
    expect(all.placement).toMatchObject({unplaced: "100", interval: "200", straddling: "0"});
    const bounded = service.analytics(scope, request({from: "2026-09-02T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z"}));
    expect(bounded.totals.input).toBe("10");
    expect(bounded.placement).toMatchObject({straddling: "200", interval: "0", spanning: "0"});
  });

  it("writes one snapshot delta when a replaced checkpoint member vanishes or shrinks", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, input: string) => fact(`model:${name}`, {input, output: "0"}, {kind: "cumulative", sessionContribution: "checkpoint", models: [{provider: null, model: name}]});
    at("2026-09-02T10:00:00Z"); capture.capture([{...counter("a", {}), facts: [model("opus", "100"), model("haiku", "50")]}]);
    at("2026-09-02T10:05:00Z"); capture.capture([{...counter("b", {}), facts: [model("opus", "90"), model("sonnet", "80")]}]);
    const session = service.read(scope, "thread").summary.metrics.input.value;
    expect(session).toBe("170");
    expect(rows(db).at(-1)).toMatchObject({fact_id: "*snapshot", input: 20, model: null});
    expect(service.analytics(scope, request()).totals.input).toBe(session);
  });

  it("drops only an invalid attribution and never the evidence it came with", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-02T10:00:00Z");
    capture.capture([{...counter("a", {input: "100", output: "0"}), attribution: {model: null, reasoningEffort: "x".repeat(65)}}]);
    expect(rows(db)).toMatchObject([{input: 100, effort: null}]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_gaps WHERE reason='invalid_evidence'").get()).toEqual({count: 0});
  });

  it("attributes effort only to the confirmed model's rows", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, input: string) => fact(`model:${name}`, {input, output: "0"}, {kind: "cumulative", sessionContribution: "checkpoint", models: [{provider: null, model: name}]});
    at("2026-09-02T10:00:00Z");
    capture.capture([{...counter("a", {}), facts: [model("claude-opus-5-5", "100"), model("claude-haiku-4-5", "10")],
      attribution: {model: {provider: null, model: "claude-opus-5-5[1m]"}, reasoningEffort: "high"}}]);
    expect(rows(db)).toMatchObject([{model: "claude-opus-5-5", effort: "high"}, {model: "claude-haiku-4-5", effort: null}]);
  });

  it("falls back to unplaced rows when a pending source cannot be replayed", async () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    at("2026-09-02T10:00:00Z"); service.open(source()).capture([counter("a", {input: "100", output: "0"})]);
    const sourceId = db.prepare("SELECT id FROM usage_sources").pluck().get() as string;
    db.prepare("INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,received_at) VALUES(?,'broken','1','x','{not json','v1','2026-09-02T11:00:00.000Z')").run(sourceId);
    db.exec("DELETE FROM usage_increments; UPDATE usage_sources SET timeline_state='backfill'");
    const stop = new UsageService(db, {enabled: true}).startTimelineBackfill();
    await vi.waitFor(() => expect(db.prepare("SELECT timeline_state FROM usage_sources").pluck().get()).toBe("current"));
    stop();
    expect(rows(db)).toMatchObject([{placement: "unplaced", input: 100}]);
    expect(service.analytics(scope, request()).placement).toMatchObject({unplaced: "100", observed: "0"});
  });

  it("folds unknown keys into Other when unknown is not a named series", () => {
    const db = database("pi"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-06T00:00:00Z");
    capture.capture(Array.from({length: 9}, (_, index) => ({...counter(`m${index}`, {}), id: `m${index}`, replaceCheckpoint: false,
      occurredAt: "2026-09-02T08:00:00.000Z", facts: [fact(`m${index}`, {input: String(index === 8 ? 5 : (index + 1) * 100), output: "0"}, {models: [{provider: null, model: index === 8 ? null : `model-${index}`}]})]})));
    const grouped = service.analytics(scope, request({groupBy: "model", breakdownLimit: 3}));
    const other = grouped.timeline.series.find((entry) => entry.other)!;
    expect(other.totals.input).toBe(other.points.input.reduce((sum, value) => String(BigInt(sum) + BigInt(value)), "0"));
    const shown = grouped.breakdowns.model.rows.reduce((sum, row) => sum + BigInt(row.totals.input), 0n);
    expect(String(shown + BigInt(grouped.breakdowns.model.other!.input))).toBe(grouped.totals.input);
  });

  it("counts no unsupported threads when a filter needs recorded usage details", () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    db.exec("INSERT INTO agent_backend_instances(tenant_id,id,kind,label) VALUES('tenant','grok','grok_build','Grok')");
    db.prepare("INSERT INTO application_threads(tenant_id,owner_principal_id,id,backend_instance_id,environment_id,workspace_id,title,last_activity_at) VALUES('tenant','principal','g1','grok','environment','workspace','Grok',?)").run(Date.parse("2026-09-03T00:00:00Z"));
    at("2026-09-06T00:00:00Z");
    expect(service.analytics(scope, request()).coverage.unsupportedThreads).toBe("1");
    expect(service.analytics(scope, request({filters: {model: ["opus"]}})).coverage.unsupportedThreads).toBe("0");
    expect(service.analytics(scope, request({filters: {workspace: ["elsewhere"]}})).coverage.unsupportedThreads).toBe("0");
  });
});

describe("usage timeline second review regressions", () => {
  it("does not recount cost when a later snapshot first allows a per-model split", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, input: string, cost?: string) => fact(`model:${name}`, {input, output: "0"}, {kind: "cumulative", sessionContribution: "checkpoint",
      models: [{provider: null, model: name}], ...(cost ? {pricing: {canonicalModel: null, basis: null, components: [{kind: "model_total" as const, amount: cost, currency: "USD"}]}} : {})});
    const summary = (amount: string) => fact("query_cost", {}, {kind: "cumulative", sessionContribution: "checkpoint", models: [], costs: [{amount, currency: "USD", kind: "estimated", provenance: "sdk"}]});
    at("2026-09-02T10:00:00Z"); capture.capture([{...counter("a", {}), facts: [model("opus", "100"), summary("0.5")]}]);
    at("2026-09-02T10:05:00Z"); capture.capture([{...counter("b", {}), facts: [model("opus", "150", "0.7"), summary("0.7")]}]);
    at("2026-09-02T10:10:00Z"); capture.capture([{...counter("c", {}), facts: [model("opus", "180", "0.9"), summary("0.9")]}]);
    expect(service.analytics(scope, request()).totals.costs[0]?.amount).toBe("0.9");
    expect(service.read(scope, "thread").summary.costs[0]?.amount).toBe("0.9");
  });

  it("treats a member metric that stops being reported as a reshaped snapshot", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, tokens: UsageFact["tokens"]) => fact(`model:${name}`, tokens, {kind: "cumulative", sessionContribution: "checkpoint", models: [{provider: null, model: name}]});
    at("2026-09-02T10:00:00Z"); capture.capture([{...counter("a", {}), facts: [model("opus", {input: "100", output: "1"}), model("haiku", {output: "1"})]}]);
    at("2026-09-02T10:05:00Z"); capture.capture([{...counter("b", {}), facts: [model("opus", {input: null, output: "1"}), model("haiku", {input: "120", output: "1"})]}]);
    const session = service.read(scope, "thread").summary.metrics.input.value;
    expect(session).toBe("120");
    expect(service.analytics(scope, request()).totals.input).toBe(session);
  });

  it("keeps the repeated daylight-saving hour in its own bucket", () => {
    const {buckets} = zonedBuckets(Date.parse("2026-11-01T06:30:00Z"), Date.parse("2026-11-01T08:00:00Z"), "hour", "America/New_York");
    expect(buckets.map((bucket) => new Date(bucket.start).toISOString())).toEqual(["2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
    const kathmandu = zonedBuckets(Date.parse("2026-09-01T18:20:00Z"), Date.parse("2026-09-01T19:00:00Z"), "hour", "Asia/Kathmandu");
    expect(new Date(kathmandu.buckets[0]!.start).toISOString()).toBe("2026-09-01T18:15:00.000Z");
  });

  it("starts an hour where a 30-minute daylight-saving jump begins and realigns after it", () => {
    const iso = (buckets: {start: number; end: number}[]) => buckets.map((bucket) => [new Date(bucket.start).toISOString(), new Date(bucket.end).toISOString()]);
    // Lord Howe springs from 02:00 (+10:30) to 02:30 (+11:00) at 15:30Z.
    expect(iso(zonedBuckets(Date.parse("2026-10-03T15:40:00Z"), Date.parse("2026-10-03T17:00:00Z"), "hour", "Australia/Lord_Howe").buckets)).toEqual([
      ["2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z"], ["2026-10-03T16:00:00.000Z", "2026-10-03T17:00:00.000Z"]]);
    expect(iso(zonedBuckets(Date.parse("2026-10-03T15:10:00Z"), Date.parse("2026-10-03T15:40:00Z"), "hour", "Australia/Lord_Howe").buckets)).toEqual([
      ["2026-10-03T14:30:00.000Z", "2026-10-03T15:30:00.000Z"], ["2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z"]]);
    // It falls back from 02:00 (+11:00) to 01:30 (+10:30) at 15:00Z; the repeated half-hour stays separate.
    expect(iso(zonedBuckets(Date.parse("2026-04-04T14:10:00Z"), Date.parse("2026-04-04T15:40:00Z"), "hour", "Australia/Lord_Howe").buckets)).toEqual([
      ["2026-04-04T14:00:00.000Z", "2026-04-04T15:00:00.000Z"], ["2026-04-04T15:00:00.000Z", "2026-04-04T15:30:00.000Z"],
      ["2026-04-04T15:30:00.000Z", "2026-04-04T16:30:00.000Z"]]);
  });

  it("charges a falling per-model estimate to the summary instead of dropping it", () => {
    const db = database("claude_agent_sdk"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    const model = (name: string, input: string, cost: string) => fact(`model:${name}`, {input, output: "0"}, {kind: "cumulative", sessionContribution: "checkpoint",
      models: [{provider: null, model: name}], pricing: {canonicalModel: null, basis: null, components: [{kind: "model_total" as const, amount: cost, currency: "USD"}]}});
    const summary = (amount: string) => fact("query_cost", {}, {kind: "cumulative", sessionContribution: "checkpoint", models: [], costs: [{amount, currency: "USD", kind: "estimated", provenance: "sdk"}]});
    at("2026-09-02T10:00:00Z"); capture.capture([{...counter("a", {}), facts: [model("opus", "100", "1.0"), model("haiku", "50", "0.3"), summary("1.3")]}]);
    at("2026-09-02T10:05:00Z"); capture.capture([{...counter("b", {}), facts: [model("opus", "120", "0.8"), model("haiku", "90", "0.7"), summary("1.5")]}]);
    at("2026-09-02T10:10:00Z"); capture.capture([{...counter("c", {}), facts: [model("opus", "130", "0.9"), model("haiku", "90", "0.7"), summary("1.6")]}]);
    const result = service.analytics(scope, request());
    const cost = (key: string | null) => result.breakdowns.model.rows.find((row) => row.key === key)?.totals.costs[0]?.amount;
    expect(result.totals.costs[0]?.amount).toBe("1.6");
    expect(service.read(scope, "thread").summary.costs[0]?.amount).toBe("1.6");
    // The first split and the one after the correction stay per model; the correction is model-less.
    expect([cost("opus"), cost("haiku"), cost(null)]).toEqual(["1.1", "0.3", "0.2"]);
  });

  it("searches facet choices beyond the top ranked values by ID or name", () => {
    const db = database("pi"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    addThread(db, "quiet", "Quiet 100% thread");
    at("2026-09-06T00:00:00Z");
    capture.capture(Array.from({length: 65}, (_, index) => ({...counter(`m${index}`, {}), id: `m${index}`, replaceCheckpoint: false,
      occurredAt: "2026-09-02T08:00:00.000Z", facts: [fact(`m${index}`, {input: String(1000 - index), output: "0"}, {models: [{provider: null, model: `model_${index}`}]})]})));
    service.open(source("quiet")).capture([{...counter("q", {}), id: "q", replaceCheckpoint: false, occurredAt: "2026-09-02T09:00:00.000Z",
      facts: [fact("q", {input: "1", output: "0"}, {models: [{provider: null, model: "model_0"}]})]}]);
    const ranked = service.analytics(scope, request({facets: true}));
    expect(ranked.facets?.model).toHaveLength(60);
    expect(ranked.facets?.model.some((row) => row.key === "model_64")).toBe(false);
    const found = service.analytics(scope, request({facets: true, facetSearch: {dimension: "model", text: "_64"}}));
    expect(found.facets?.model.map((row) => row.key)).toEqual(["model_64"]);
    const titled = service.analytics(scope, request({facets: true, facetSearch: {dimension: "thread", text: "100%"}}));
    expect(titled.facets?.thread.map((row) => row.key)).toEqual(["quiet"]);
    expect(titled.labels.thread.quiet?.label).toBe("Quiet 100% thread");
    expect(service.analytics(scope, request({facets: true, facetSearch: {dimension: "thread", text: "%"}})).facets?.thread.map((row) => row.key)).toEqual(["quiet"]);
  });

  it("breaks continuity when evidence is dropped as invalid", () => {
    const db = database(), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-02T10:00:00Z"); capture.capture([counter("a", {input: "100", output: "0"})]);
    at("2026-09-02T10:01:00Z"); capture.capture([{...counter("bad", {input: "120", output: "0"}), revision: ""}]);
    at("2026-09-02T10:02:00Z"); capture.capture([counter("c", {input: "150", output: "0"})]);
    expect(rows(db)).toMatchObject([{placement: "observed", input: 100}, {placement: "interval", input: 50, interval_start: "2026-09-02T10:00:00.000Z"}]);
    at("2026-09-02T10:03:00Z"); capture.capture([counter("d", {input: "160", output: "0"})]);
    expect(rows(db).at(-1)).toMatchObject({placement: "observed", input: 10});
  });
});

describe("usage analytics reads", () => {
  it("scopes every aggregate to the requesting principal", () => {
    const db = database(), service = new UsageService(db, {enabled: true});
    addThread(db, "foreign", "Foreign", "other");
    at("2026-09-02T10:00:00Z");
    service.open(source()).capture([counter("a", {input: "5", output: "0"})]);
    service.open(source("foreign", "proven_zero", "other")).capture([counter("a", {input: "900", output: "0"})]);
    const mine = service.analytics(scope, request({groupBy: "thread"}));
    expect(mine.totals.input).toBe("5");
    expect(Object.keys(mine.labels.thread)).toEqual(["thread"]);
    expect(service.analytics({...scope, principalId: "other"}, request()).totals.input).toBe("900");
    expect(service.analytics({...scope, principalId: "nobody"}, request()).totals.increments).toBe("0");
  });

  it("filters, folds series beyond seven into Other, and keeps a filter-independent color order", () => {
    const db = database("pi"), service = new UsageService(db, {enabled: true}), capture = service.open(source());
    at("2026-09-06T00:00:00Z");
    capture.capture(Array.from({length: 9}, (_, index) => ({...counter(`m${index}`, {}), id: `m${index}`, replaceCheckpoint: false,
      occurredAt: "2026-09-02T08:00:00.000Z", facts: [fact(`m${index}`, {input: String((index + 1) * 10), output: "0"}, {models: [{provider: null, model: index === 8 ? null : `model-${index}`}]})]})));
    const grouped = service.analytics(scope, request({groupBy: "model"}));
    expect(grouped.timeline.series).toHaveLength(8);
    expect(grouped.timeline.series.at(-1)).toMatchObject({other: true, totals: {input: "30"}});
    expect(grouped.timeline.series[0]).toMatchObject({key: null, totals: {input: "90"}});
    expect(grouped.timeline.colorOrder[0]).toBeNull();
    const filtered = service.analytics(scope, request({groupBy: "model", filters: {model: ["model-0", null]}, facets: true}));
    expect(filtered.totals.input).toBe("100");
    expect(filtered.breakdowns.model.distinct).toBe("2");
    expect(filtered.facets?.model).toHaveLength(9);
    expect(filtered.facets?.provider).toEqual([{key: null, tokens: "100"}]);
    expect(Object.keys(filtered.labels.model)).toHaveLength(0);
    expect(filtered.timeline.colorOrder).toEqual(grouped.timeline.colorOrder);
    const matrix = service.analytics(scope, request({groupBy: "model", crossBy: "provider", breakdownLimit: 3}));
    expect(matrix.matrix?.cells).toHaveLength(9);
    expect(matrix.breakdowns.model).toMatchObject({distinct: "9", other: {input: "210"}});
    expect(usageAnalyticsResponseSchema.parse(matrix)).toEqual(matrix);
  });

  it("rejects unknown time zones and empty ranges", () => {
    const service = new UsageService(database(), {enabled: true});
    expect(() => service.analytics(scope, request({timeZone: "Mars/Olympus"}))).toThrow(/time zone/);
    expect(() => service.analytics(scope, request({from: "2026-09-08T00:00:00.000Z"}))).toThrow(/range/);
  });
});

describe("zoned buckets", () => {
  it("follows daylight-saving transitions and Monday weeks", () => {
    const days = zonedBuckets(Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-03T06:00:00Z"), "day", "America/New_York").buckets;
    expect(days.map((day) => (day.end - day.start) / 3_600_000)).toEqual([25, 24, 24]);
    const weeks = zonedBuckets(Date.parse("2026-09-09T12:00:00Z"), Date.parse("2026-09-20T12:00:00Z"), "week", "UTC").buckets;
    expect(new Date(weeks[0]!.start).toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(zonedInstant(2026, 3, 8, 2, "America/New_York")).toBe(Date.parse("2026-03-08T07:00:00Z"));
    expect(zonedInstant(2026, 11, 1, 1, "America/New_York")).toBe(Date.parse("2026-11-01T05:00:00Z"));
    expect(zonedInstant(2026, 9, 1, 0, "Asia/Kathmandu")).toBe(Date.parse("2026-08-31T18:15:00Z"));
  });

  it("coarsens requested granularity to stay within the bucket cap", () => {
    const result = zonedBuckets(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"), "hour", "UTC");
    expect(result.bucket).toBe("day");
    expect(zonedBuckets(Date.parse("2024-01-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"), "day", "UTC").bucket).toBe("week");
    expect(zonedBuckets(Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-02T00:00:00Z"), "auto", "UTC").buckets).toHaveLength(24);
  });

  it("rounds projected cost half up at twelve decimals", () => {
    expect(usageCostUnits("0.0000000000015")).toBe(2n);
    expect(usageCostAmount(usageCostUnits("12.5"))).toBe("12.5");
    expect(usageCostAmount(0n)).toBe("0");
  });
});
