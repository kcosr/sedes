import type Database from "better-sqlite3";
import type { UsageTokenKind } from "../../shared/protocol/usage-accounting.js";
import type { UsageAttribution, UsageFact } from "./contracts.js";

/** Projection cost scale: amounts are stored as integer 10^-12 units, rounded half up. */
export const USAGE_COST_SCALE = 12;
const COST_TOLERANCE = 1_000n; // 10^-9 of the currency.
const INT64_MAX = 9_223_372_036_854_775_807n;
/** Fact id of the one row that replaces per-member rows for a reshaped snapshot. */
export const SNAPSHOT_FACT_ID = "*snapshot";
const TOKEN_COLUMNS = [
  ["input", "input"], ["uncachedInput", "uncached_input"], ["cacheRead", "cache_read"], ["cacheWrite", "cache_write"],
  ["output", "output"], ["reasoning", "reasoning"], ["requests", "requests"],
] as const satisfies readonly (readonly [UsageTokenKind, string])[];

export type TimelinePlacement = "reported" | "observed" | "interval" | "unplaced";
export interface TimelineSource {
  readonly id: string; readonly tenant_id: string; readonly principal_id: string; readonly thread_id: string;
  readonly backend_id: string; readonly environment_id: string; readonly workspace_id: string;
  readonly agent_role: "main" | "subagent"; readonly baseline: "proven_zero" | "unknown";
}
export interface TimelineTime {
  readonly placement: TimelinePlacement;
  readonly occurredAt: string;
  readonly intervalStart: string | null;
}
interface Cost { readonly currency: string; readonly units: bigint; readonly kind: "estimated" | "reported" }

export function usageCostUnits(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const kept = BigInt(whole! + fraction.slice(0, USAGE_COST_SCALE).padEnd(USAGE_COST_SCALE, "0"));
  return fraction.length > USAGE_COST_SCALE && fraction[USAGE_COST_SCALE]! >= "5" ? kept + 1n : kept;
}
export function usageCostAmount(units: bigint): string {
  const digits = units.toString().padStart(USAGE_COST_SCALE + 1, "0");
  return `${digits.slice(0, -USAGE_COST_SCALE)}.${digits.slice(-USAGE_COST_SCALE)}`.replace(/\.?0+$/, "");
}
function factCost(fact: UsageFact | undefined): Cost | null {
  if (!fact?.costs.length) return null;
  const currency = [...new Set(fact.costs.map((cost) => cost.currency))].sort()[0]!;
  const selected = fact.costs.filter((cost) => cost.currency === currency);
  return {currency, units: selected.reduce((sum, cost) => sum + usageCostUnits(cost.amount), 0n),
    kind: selected.every((cost) => cost.kind === "reported") ? "reported" : "estimated"};
}
function modelTotal(fact: UsageFact | undefined, currency: string): bigint | null {
  const parts = fact?.pricing?.components.filter((part) => part.kind === "model_total" && part.currency === currency) ?? [];
  return parts.length === 1 ? usageCostUnits(parts[0]!.amount) : null;
}

/**
 * A cost-only checkpoint member may be split across the token-bearing members
 * of the same snapshot when their supplied per-model totals add up to it.
 * The split is an attribution of the same charge, never an additional one.
 */
export function costSplit(facts: readonly UsageFact[]): {summaryIds: Set<string>; currency: string; kind: Cost["kind"]} | null {
  const checkpoints = facts.filter((fact) => fact.sessionContribution === "checkpoint");
  const summaries = checkpoints.filter((fact) => fact.costs.length > 0 && Object.values(fact.tokens).every((value) => value == null));
  const parts = checkpoints.filter((fact) => Object.values(fact.tokens).some((value) => value != null));
  if (summaries.length !== 1 || !parts.length) return null;
  const summary = factCost(summaries[0]);
  if (!summary || parts.some((fact) => fact.costs.length > 0)) return null;
  const totals = parts.map((fact) => modelTotal(fact, summary.currency));
  if (totals.some((total) => total === null)) return null;
  const sum = totals.reduce<bigint>((total, value) => total + value!, 0n);
  const difference = sum > summary.units ? sum - summary.units : summary.units - sum;
  return difference <= COST_TOLERANCE * BigInt(parts.length) ? {summaryIds: new Set([summaries[0]!.id]), currency: summary.currency, kind: summary.kind} : null;
}

/** Model names match ignoring case and a bracketed variant suffix such as "[1m]". */
function sameModel(left: string, right: string): boolean {
  const normal = (value: string) => value.toLowerCase().replace(/\[[^\]]*\]$/, "").trim();
  return normal(left) === normal(right);
}

/**
 * Write the increase from `previous` to `fact` for one accepted fact. Returns
 * whether a row was written. Negative per-metric movement is left unknown.
 */
export function writeUsageIncrement(database: Database.Database, input: {
  readonly source: TimelineSource; readonly backendKind: string;
  readonly fact: UsageFact; readonly previous: UsageFact | undefined;
  readonly observationId: string; readonly observationRevision: string; readonly turnId: string | null;
  readonly time: TimelineTime; readonly attribution: UsageAttribution | undefined;
  readonly split: ReturnType<typeof costSplit>; readonly observationCosted: boolean;
}): boolean {
  const {fact, previous, split} = input;
  const values = new Map<UsageTokenKind, bigint | null>();
  for (const [key] of TOKEN_COLUMNS) {
    const now = fact.tokens[key];
    const before = previous?.tokens[key];
    const value = now == null ? null : before == null ? BigInt(now) : BigInt(now) - BigInt(before);
    values.set(key, value !== null && value < 0n ? null : value);
  }
  const input_ = values.get("input") ?? null, cacheRead = values.get("cacheRead") ?? null, cacheWrite = values.get("cacheWrite") ?? null;
  if (values.get("uncachedInput") == null && input_ !== null && cacheRead !== null && cacheWrite !== null && input_ >= cacheRead + cacheWrite) {
    values.set("uncachedInput", input_ - cacheRead - cacheWrite);
  }
  let cost: Cost | null = null;
  if (split?.summaryIds.has(fact.id)) cost = null;
  else if (split && fact.sessionContribution === "checkpoint") {
    const now = modelTotal(fact, split.currency), before = modelTotal(previous, split.currency);
    const units = now === null ? null : now - (before ?? 0n);
    cost = units === null || units < 0n ? null : {currency: split.currency, units, kind: split.kind};
  } else {
    const now = factCost(fact), before = factCost(previous);
    const units = now === null ? null : now.units - (before?.currency === now.currency ? before.units : 0n);
    cost = now === null || units === null || units < 0n ? null : {...now, units};
  }
  // An amount beyond the projection's integer range stays unknown rather than failing capture.
  if (cost && cost.units > INT64_MAX) cost = null;
  const hasTokens = [...values.values()].some((value) => value !== null && value > 0n);
  if (!hasTokens && !(cost && cost.units > 0n)) return false;
  const placed = input.time.placement === "reported" || input.time.placement === "observed";
  const reported = fact.models.length === 1 && (fact.models[0]!.model !== null || fact.models[0]!.provider !== null) ? fact.models[0]! : null;
  // Attribution names a model only for a single-model fact whose own model is unknown;
  // cost summaries and reshaped snapshots cover several models and stay unknown.
  const unknownSingle = fact.models.length === 1 && reported === null;
  const attributed = placed ? input.attribution : undefined;
  const model = reported ?? (unknownSingle ? attributed?.model ?? null : null);
  const effortModel = attributed?.model?.model ?? null;
  // Effort describes the confirmed model's work; other models in the same delta keep none.
  const effort = !attributed ? null : effortModel === null ? attributed.reasoningEffort
    : model?.model && sameModel(model.model, effortModel) ? attributed.reasoningEffort : null;
  const s = input.source;
  const result = database.prepare(`INSERT OR IGNORE INTO usage_increments(tenant_id,principal_id,thread_id,source_id,fact_id,observation_id,observation_revision,
      turn_id,backend_id,backend_kind,environment_id,workspace_id,agent_role,activity,provider,model,effort,placement,occurred_at,interval_start,
      ${TOKEN_COLUMNS.map(([, column]) => column).join(",")},cost_units,currency,cost_kind,costed)
    VALUES(${Array(31).fill("?").join(",")})`).run(
    s.tenant_id, s.principal_id, s.thread_id, s.id, fact.id, input.observationId, input.observationRevision,
    input.turnId, s.backend_id, input.backendKind, s.environment_id, s.workspace_id, s.agent_role, fact.activity,
    model?.provider ?? null, model?.model ?? null, effort, input.time.placement, input.time.occurredAt, input.time.intervalStart,
    ...TOKEN_COLUMNS.map(([key]) => values.get(key) ?? null),
    cost?.units ?? null, cost?.currency ?? null, cost?.kind ?? null, cost || input.observationCosted ? 1 : 0,
  );
  return result.changes === 1;
}

/**
 * Per-member deltas are exact only while every member of a replaced snapshot
 * persists and none shrinks. Otherwise one snapshot-level delta keeps the
 * timeline equal to the selected totals (their sum never decreases).
 */
export function snapshotReshaped(before: readonly UsageFact[], after: readonly UsageFact[]): boolean {
  const next = new Map(after.map((fact) => [fact.id, fact]));
  return before.some((old) => {
    const fact = next.get(old.id);
    if (!fact) return true;
    const shrank = TOKEN_COLUMNS.some(([key]) => old.tokens[key] != null && fact.tokens[key] != null && BigInt(fact.tokens[key]!) < BigInt(old.tokens[key]!));
    const oldCost = factCost(old), newCost = factCost(fact);
    return shrank || (oldCost !== null && newCost !== null && oldCost.currency === newCost.currency && newCost.units < oldCost.units);
  });
}
/** Sum a snapshot's members into one model-less fact for a snapshot-level delta. */
export function snapshotFact(facts: readonly UsageFact[]): UsageFact {
  const tokens: Partial<Record<UsageTokenKind, string | null>> = {};
  for (const [key] of TOKEN_COLUMNS) {
    const known = facts.filter((fact) => fact.tokens[key] != null);
    if (known.length) tokens[key] = String(known.reduce((sum, fact) => sum + BigInt(fact.tokens[key]!), 0n));
  }
  const costs = facts.flatMap((fact) => fact.costs);
  const currency = [...new Set(costs.map((cost) => cost.currency))].sort()[0];
  const selected = costs.filter((cost) => cost.currency === currency);
  const units = selected.reduce((sum, cost) => sum + usageCostUnits(cost.amount), 0n);
  return {id: SNAPSHOT_FACT_ID, kind: "cumulative", sessionContribution: "checkpoint", coverageDomain: "snapshot", tokens,
    costs: currency ? [{amount: usageCostAmount(units), currency, kind: selected.every((cost) => cost.kind === "reported") ? "reported" : "estimated", provenance: "snapshot"}] : [],
    models: [], basis: ["derived"], providerPresence: "unknown", quality: "partial", reasons: [], activity: "model", turn: null};
}

/** Normalize a stored or source ISO time to the projection's sortable form. */
export function timelineInstant(value: string): string {
  return new Date(value).toISOString();
}

type RecordRow = {fact_id:string;fact_json:string;turn_id:string|null;observation_id:string;observation_revision:string;occurred_at:string|null;received_at:string};
function readRecords(database: Database.Database, sourceId: string): RecordRow[] {
  return database.prepare(`SELECT r.fact_id,r.fact_json,r.turn_id,r.observation_id,r.observation_revision,o.occurred_at,o.received_at
    FROM usage_records r JOIN usage_observations o ON o.source_id=r.source_id AND o.observation_id=r.observation_id AND o.revision=r.observation_revision
    WHERE r.source_id=?`).all(sourceId) as RecordRow[];
}
function writeAdditiveRows(database: Database.Database, source: TimelineSource, backendKind: string, records: readonly RecordRow[]): void {
  for (const row of records) {
    const fact = JSON.parse(row.fact_json) as UsageFact;
    if (fact.sessionContribution !== "additive") continue;
    writeUsageIncrement(database, {source, backendKind, fact, previous: undefined, observationId: row.observation_id,
      observationRevision: row.observation_revision, turnId: row.turn_id, attribution: undefined, split: null, observationCosted: false,
      time: row.occurred_at ? {placement: "reported", occurredAt: timelineInstant(row.occurred_at), intervalStart: null}
        : {placement: "observed", occurredAt: timelineInstant(row.received_at), intervalStart: null}});
  }
}
/** Conservative rows when history cannot be replayed: each current checkpoint belongs to no time range. */
function writeUnplacedRows(database: Database.Database, source: TimelineSource, backendKind: string, records: readonly RecordRow[]): string | null {
  const checkpoints = records.filter((row) => (JSON.parse(row.fact_json) as UsageFact).sessionContribution === "checkpoint");
  const facts = checkpoints.map((row) => JSON.parse(row.fact_json) as UsageFact);
  const split = costSplit(facts);
  for (const [index, row] of checkpoints.entries()) {
    writeUsageIncrement(database, {source, backendKind, fact: facts[index]!, previous: undefined,
      observationId: row.observation_id, observationRevision: row.observation_revision, turnId: null, attribution: undefined,
      split, observationCosted: facts.some((fact) => fact.costs.length > 0),
      time: {placement: "unplaced", occurredAt: timelineInstant(row.received_at), intervalStart: null}});
  }
  return checkpoints.map((row) => timelineInstant(row.received_at)).sort().at(-1) ?? null;
}
const markCurrent = (database: Database.Database, sourceId: string, receipt: string | null) =>
  database.prepare("UPDATE usage_sources SET timeline_state='current', timeline_receipt=? WHERE id=?").run(receipt, sourceId);

/**
 * Rebuild the rows of a source captured before the projection existed. Replay
 * follows the service's frontier and regression rules; a result that does not
 * reproduce the current canonical records falls back to unplaced rows.
 */
export function backfillUsageTimeline(database: Database.Database, source: TimelineSource, backendKind: string): void {
  database.prepare("DELETE FROM usage_increments WHERE source_id=?").run(source.id);
  const records = readRecords(database, source.id);
  writeAdditiveRows(database, source, backendKind, records);
  const expected = records.filter((row) => (JSON.parse(row.fact_json) as UsageFact).sessionContribution === "checkpoint");
  if (!expected.length) { markCurrent(database, source.id, null); return; }
  // Writes cannot run while a statement iterates, so page by insertion order.
  const page = database.prepare("SELECT rowid,observation_id,revision,evidence_json,received_at FROM usage_observations WHERE source_id=? AND rowid>? ORDER BY rowid LIMIT 500");
  function* observations(): Generator<{observation_id:string;revision:string;evidence_json:string;received_at:string}> {
    let cursor = 0;
    for (;;) {
      const rows = page.all(source.id, cursor) as {rowid:number;observation_id:string;revision:string;evidence_json:string;received_at:string}[];
      if (!rows.length) return;
      yield* rows;
      cursor = rows.at(-1)!.rowid;
    }
  }
  let state = new Map<string, UsageFact>();
  let frontier: bigint | null = null;
  let previousReceipt: string | null = null;
  let replayed = true;
  for (const row of observations()) {
    const evidence = JSON.parse(row.evidence_json) as {order: string | null; replaceCheckpoint: boolean; facts: UsageFact[]};
    const checkpoints = evidence.facts.filter((fact) => fact.sessionContribution === "checkpoint" && !fact.inheritedFrom);
    if (!checkpoints.length) continue;
    if (!evidence.replaceCheckpoint) { replayed = false; break; }
    if (evidence.order !== null && frontier !== null && BigInt(evidence.order) < frontier) continue;
    const before = [...state.values()];
    const regressed = TOKEN_COLUMNS.some(([key]) => {
      const old = before.filter((fact) => fact.tokens[key] != null);
      const now = checkpoints.filter((fact) => fact.tokens[key] != null);
      return old.length > 0 && (!now.length || now.reduce((n, f) => n + BigInt(f.tokens[key]!), 0n) < old.reduce((n, f) => n + BigInt(f.tokens[key]!), 0n));
    });
    if (regressed) break;
    const split = costSplit(checkpoints);
    const summaryCost = checkpoints.some((fact) => fact.costs.length > 0);
    const receipt = timelineInstant(row.received_at);
    const time: TimelineTime = previousReceipt !== null
      ? {placement: "interval", occurredAt: receipt, intervalStart: previousReceipt > receipt ? receipt : previousReceipt}
      : source.baseline === "proven_zero" ? {placement: "observed", occurredAt: receipt, intervalStart: null}
      : {placement: "unplaced", occurredAt: receipt, intervalStart: null};
    if (snapshotReshaped(before, checkpoints)) {
      writeUsageIncrement(database, {source, backendKind, fact: snapshotFact(checkpoints), previous: snapshotFact(before),
        observationId: row.observation_id, observationRevision: row.revision, turnId: null, time, attribution: undefined, split: null, observationCosted: summaryCost});
    } else {
      for (const fact of checkpoints) {
        const previous = state.get(fact.id);
        if (previous && JSON.stringify(previous) === JSON.stringify(fact)) continue;
        writeUsageIncrement(database, {source, backendKind, fact, previous, observationId: row.observation_id, observationRevision: row.revision,
          turnId: null, time, attribution: undefined, split, observationCosted: summaryCost});
      }
    }
    state = new Map(checkpoints.map((fact) => [fact.id, fact]));
    previousReceipt = receipt;
    if (evidence.order !== null && (frontier === null || BigInt(evidence.order) > frontier)) frontier = BigInt(evidence.order);
  }
  const reproduced = replayed && state.size === expected.length && expected.every((row) => {
    const fact = state.get(row.fact_id);
    return fact !== undefined && sameFact(fact, JSON.parse(row.fact_json) as UsageFact);
  });
  if (reproduced) { markCurrent(database, source.id, previousReceipt); return; }
  database.prepare("DELETE FROM usage_increments WHERE source_id=?").run(source.id);
  writeAdditiveRows(database, source, backendKind, records);
  markCurrent(database, source.id, writeUnplacedRows(database, source, backendKind, records));
}

/**
 * Rebuild without ever failing the caller: a replay error falls back to
 * unplaced rows, and a fallback error leaves the source without rows. Nested
 * transactions are savepoints inside an active capture transaction.
 */
export function rebuildUsageTimeline(database: Database.Database, source: TimelineSource, backendKind: string): void {
  try { database.transaction(() => backfillUsageTimeline(database, source, backendKind))(); return; }
  catch (error) { console.warn("Usage timeline replay failed", {sourceId: source.id, code: error instanceof Error ? error.message.slice(0, 120) : "unknown"}); }
  try {
    database.transaction(() => {
      database.prepare("DELETE FROM usage_increments WHERE source_id=?").run(source.id);
      const records = readRecords(database, source.id);
      writeAdditiveRows(database, source, backendKind, records);
      markCurrent(database, source.id, writeUnplacedRows(database, source, backendKind, records));
    })();
  } catch {
    database.transaction(() => { database.prepare("DELETE FROM usage_increments WHERE source_id=?").run(source.id); markCurrent(database, source.id, null); })();
  }
}

function sameFact(left: UsageFact, right: UsageFact): boolean {
  return TOKEN_COLUMNS.every(([key]) => (left.tokens[key] ?? null) === (right.tokens[key] ?? null)) &&
    factCost(left)?.units === factCost(right)?.units;
}
