import type Database from "better-sqlite3";
import {
  USAGE_ANALYTICS_DIMENSIONS, USAGE_ANALYTICS_MAX_FACETS, USAGE_ANALYTICS_SERIES_LIMIT, usageAnalyticsResponseSchema,
  type UsageAnalyticsAggregate, type UsageAnalyticsBreakdown, type UsageAnalyticsDimension, type UsageAnalyticsLabel,
  type UsageAnalyticsPoints, type UsageAnalyticsRequest, type UsageAnalyticsResponse,
} from "../../shared/protocol/usage-analytics.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { rebuildUsageTimeline, usageCostAmount, type TimelineSource } from "./usage-timeline.js";
import { assertTimeZone, localTime, zonedBuckets } from "./zoned-time.js";

const COLUMN: Record<UsageAnalyticsDimension, string> = {
  environment: "environment_id", backend: "backend_id", backendKind: "backend_kind", provider: "provider", model: "model",
  effort: "effort", workspace: "workspace_id", thread: "thread_id", agentRole: "agent_role", activity: "activity",
};
const PLACED = "placement IN ('reported','observed','interval')";
/** Unqualified columns are unambiguous against the bucket table `b(i,s,e)`. */
const IN_BUCKET = "occurred_at >= b.s AND occurred_at < b.e AND (interval_start IS NULL OR interval_start >= b.s)";
/** Name matches for searchable facets, scoped to the requesting principal's own rows. */
const FACET_NAMES: Partial<Record<UsageAnalyticsDimension, string>> = {
  thread: " OR thread_id IN (SELECT id FROM application_threads WHERE tenant_id=@tenant AND owner_principal_id=@principal AND title LIKE @facetLike ESCAPE '\\')",
  workspace: " OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id=@tenant AND owner_principal_id=@principal AND (display_name LIKE @facetLike ESCAPE '\\' OR canonical_path LIKE @facetLike ESCAPE '\\'))",
  environment: " OR environment_id IN (SELECT id FROM execution_environments WHERE tenant_id=@tenant AND owner_principal_id=@principal AND label LIKE @facetLike ESCAPE '\\')",
  backend: " OR backend_id IN (SELECT id FROM agent_backend_instances WHERE tenant_id=@tenant AND (owner_principal_id IS NULL OR owner_principal_id=@principal) AND label LIKE @facetLike ESCAPE '\\')",
};
/** Rows outside a shown key list; unknown (NULL) keys fold into Other unless shown. */
const outside = (column: string, list: string, includesNull: boolean) => includesNull
  ? `(${column} IS NOT NULL AND ${column} NOT IN (SELECT value FROM json_each(${list})))`
  : `(${column} IS NULL OR ${column} NOT IN (SELECT value FROM json_each(${list})))`;
/** Interval rows count in a window only when the whole interval falls inside it. */
const within = (start: string, end: string) =>
  `occurred_at >= ${start} AND occurred_at < ${end} AND (interval_start IS NULL OR interval_start >= ${start})`;

type AggregateRow = Record<string, bigint | string | null>;

function aggregateSelect(): string {
  const tokens = "COALESCE(input,0)+COALESCE(output,0)";
  return `SUM(${tokens}) AS tokens, SUM(input) AS input, SUM(uncached_input) AS uncachedInput, SUM(cache_read) AS cacheRead,
    SUM(cache_write) AS cacheWrite, SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(requests) AS requests,
    COUNT(*) AS increments, COUNT(DISTINCT thread_id) AS threads,
    SUM(CASE WHEN costed=0 THEN ${tokens} ELSE 0 END) AS uncostedTokens,
    SUM(input IS NULL) AS missingInput, SUM(output IS NULL) AS missingOutput, SUM(cache_read IS NULL) AS missingCacheRead,
    SUM(cache_write IS NULL) AS missingCacheWrite, SUM(reasoning IS NULL) AS missingReasoning, SUM(requests IS NULL) AS missingRequests,
    SUM(costed=0) AS missingCost,
    SUM(CASE WHEN currency=@currency THEN cost_units END) AS costUnits,
    SUM(currency=@currency AND cost_kind='estimated') AS estimatedCosts, SUM(currency=@currency AND cost_kind='reported') AS reportedCosts`;
}
const text = (value: bigint | string | null | undefined): string => value === null || value === undefined ? "0" : String(value);
function aggregate(row: AggregateRow | undefined, currency: string): UsageAnalyticsAggregate {
  const r = row ?? {};
  const estimated = BigInt(r.estimatedCosts ?? 0), reported = BigInt(r.reportedCosts ?? 0);
  return {
    tokens: text(r.tokens), input: text(r.input), uncachedInput: text(r.uncachedInput), cacheRead: text(r.cacheRead),
    cacheWrite: text(r.cacheWrite), output: text(r.output), reasoning: text(r.reasoning), requests: text(r.requests),
    costs: r.costUnits === null || r.costUnits === undefined ? [] : [{currency, amount: usageCostAmount(BigInt(r.costUnits)),
      kind: reported === 0n ? "estimated" : estimated === 0n ? "reported" : "mixed"}],
    increments: text(r.increments), threads: text(r.threads), uncostedTokens: text(r.uncostedTokens),
    missing: {input: text(r.missingInput), output: text(r.missingOutput), cacheRead: text(r.missingCacheRead), cacheWrite: text(r.missingCacheWrite),
      reasoning: text(r.missingReasoning), requests: text(r.missingRequests), cost: text(r.missingCost)},
  };
}
function emptyPoints(length: number): UsageAnalyticsPoints {
  const zeros = () => Array.from({length}, () => "0");
  return {tokens: zeros(), input: zeros(), output: zeros(), cacheRead: zeros(), cacheWrite: zeros(), reasoning: zeros(), requests: zeros(), cost: zeros()};
}
function setPoint(points: UsageAnalyticsPoints, index: number, row: AggregateRow): void {
  for (const metric of ["tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "requests"] as const) points[metric][index] = text(row[metric]);
  points.cost[index] = row.costUnits === null || row.costUnits === undefined ? "0" : usageCostAmount(BigInt(row.costUnits));
}

/** Principal-scoped, database-only reads over the usage timeline projection. */
export class UsageAnalyticsService {
  constructor(readonly database: Database.Database) {}

  /**
   * Rebuild one source captured before the projection existed, optionally
   * within one scope. Returns the observations replayed, or null when none
   * remain. Failures fall back to conservative rows inside the rebuild.
   */
  backfillStep(scope?: RequestScope): number | null {
    const source = (scope
      ? this.database.prepare(`SELECT s.*, b.kind AS backend_kind FROM usage_sources s JOIN agent_backend_instances b ON b.tenant_id=s.tenant_id AND b.id=s.backend_id
          WHERE s.tenant_id=? AND s.principal_id=? AND s.timeline_state='backfill' LIMIT 1`).get(scope.tenantId, scope.principalId)
      : this.database.prepare(`SELECT s.*, b.kind AS backend_kind FROM usage_sources s JOIN agent_backend_instances b ON b.tenant_id=s.tenant_id AND b.id=s.backend_id
          WHERE s.timeline_state='backfill' LIMIT 1`).get()) as (TimelineSource & {backend_kind: string}) | undefined;
    if (!source) return null;
    const observations = (this.database.prepare("SELECT COUNT(*) AS count FROM usage_observations WHERE source_id=?").get(source.id) as {count: number}).count;
    rebuildUsageTimeline(this.database, source, source.backend_kind);
    return observations;
  }

  query(scope: RequestScope, request: UsageAnalyticsRequest, now = new Date()): UsageAnalyticsResponse {
    assertTimeZone(request.timeZone);
    // Startup rebuilds pending sources in the background; a read finishes what
    // remains for its own scope within a bounded observation budget.
    for (let replayed = 0; replayed < 50_000;) {
      const step = this.backfillStep(scope);
      if (step === null) break;
      replayed += Math.max(1, step);
    }
    // One read transaction keeps every aggregate on the same snapshot.
    return this.database.transaction(() => this.#query(scope, request, now))();
  }

  #query(scope: RequestScope, request: UsageAnalyticsRequest, now: Date): UsageAnalyticsResponse {
    const to = Math.min(Date.parse(request.to), now.getTime() + 60_000);
    const scoped = {sql: "tenant_id=@tenant AND principal_id=@principal"};
    const base = {tenant: scope.tenantId, principal: scope.principalId};
    // An interval that begins before its receipt extends "all time" back to its start.
    const first = this.database.prepare(`SELECT MIN(COALESCE(interval_start, occurred_at)) AS at FROM usage_increments WHERE ${scoped.sql} AND ${PLACED}`).get(base) as {at: string | null};
    const requestedFrom = request.from === null ? (first.at ? Date.parse(first.at) : to - 86_400_000 * 7) : Date.parse(request.from);
    if (!(requestedFrom < to)) throw new DomainError("bad_request", "The range must start before it ends.");
    const {bucket, buckets} = zonedBuckets(requestedFrom, to, request.bucket, request.timeZone);
    const from = Math.min(requestedFrom, buckets[0]!.start);
    const iso = (value: number) => new Date(value).toISOString();
    const filter = this.#filters(request);
    const where = `${scoped.sql}${filter.sql}`;
    const currency = (this.database.prepare(`SELECT currency FROM usage_increments WHERE ${where} AND currency IS NOT NULL AND ${within("@from", "@to")}
      GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1`).get({...base, ...filter.values, from: iso(from), to: iso(to)}) as {currency: string} | undefined)?.currency ?? "USD";
    const values = {...base, ...filter.values, currency, from: iso(from), to: iso(to)};
    const total = (range: {from: string; to: string}) => aggregate(this.database.prepare(`SELECT ${aggregateSelect()} FROM usage_increments
      WHERE ${where} AND ${PLACED} AND ${within("@from", "@to")}`).safeIntegers().get({...values, ...range}) as AggregateRow, currency);
    const totals = total({from: iso(from), to: iso(to)});
    const previousFrom = from - (to - from);
    const previous = request.from === null ? null : {from: iso(previousFrom), to: iso(from), totals: total({from: iso(previousFrom), to: iso(from)})};

    // Buckets are bound as a JSON table so SQLite range-scans the time index per bucket.
    const bucketJson = JSON.stringify(buckets.map((b) => [iso(b.start), iso(Math.min(b.end, to))]));
    const bucketed = (groupExpression: string | null, extra: Record<string, unknown> = {}) => this.database.prepare(`WITH b(i,s,e) AS (SELECT key, json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@buckets))
      SELECT b.i AS bucketIndex${groupExpression ? `, ${groupExpression}` : ""}, ${aggregateSelect()}
      FROM b JOIN usage_increments ON ${where} AND ${PLACED} AND ${IN_BUCKET}
      GROUP BY b.i${groupExpression ? ", folded, groupKey" : ""}`).safeIntegers().all({...values, ...extra, buckets: bucketJson}) as AggregateRow[];
    const overall = emptyPoints(buckets.length);
    let placedIntervals = 0n;
    for (const row of bucketed(null)) setPoint(overall, Number(row.bucketIndex), row);
    const breakdowns = Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, this.#breakdown(dimension, where, values, request.breakdownLimit, currency)])) as Record<UsageAnalyticsDimension, UsageAnalyticsBreakdown>;

    let series: UsageAnalyticsResponse["timeline"]["series"] = [];
    let colorOrder: (string | null)[] = [];
    if (request.groupBy) {
      const column = COLUMN[request.groupBy];
      const ranked = this.#breakdown(request.groupBy, where, values, USAGE_ANALYTICS_SERIES_LIMIT + 1, currency);
      const named = ranked.rows.length > USAGE_ANALYTICS_SERIES_LIMIT ? ranked.rows.slice(0, USAGE_ANALYTICS_SERIES_LIMIT) : ranked.rows;
      const folded = ranked.rows.length > named.length || ranked.other !== null;
      const namedKeys = named.map((row) => row.key).filter((key): key is string => key !== null);
      const includesNull = named.some((row) => row.key === null);
      const named_ = `(${column} IN (SELECT value FROM json_each(@named)) OR (${column} IS NULL AND @includesNull))`;
      const expression = `CASE WHEN ${named_} THEN 0 ELSE 1 END AS folded, CASE WHEN ${named_} THEN ${column} END AS groupKey`;
      const pointsByKey = new Map<string, UsageAnalyticsPoints>();
      for (const row of bucketed(expression, {named: JSON.stringify(namedKeys), includesNull: includesNull ? 1 : 0})) {
        const key = row.folded === 1n ? "other" : row.groupKey === null ? "null" : `key:${String(row.groupKey)}`;
        let points = pointsByKey.get(key);
        if (!points) { points = emptyPoints(buckets.length); pointsByKey.set(key, points); }
        setPoint(points, Number(row.bucketIndex), row);
      }
      series = named.map((row) => ({key: row.key, other: false, totals: row.totals,
        points: pointsByKey.get(row.key === null ? "null" : `key:${row.key}`) ?? emptyPoints(buckets.length)}));
      if (folded) {
        const otherTotals = this.#aggregateWhere(`${where} AND ${PLACED} AND ${within("@from", "@to")} AND ${outside(column, "@named", includesNull)}`,
          {...values, named: JSON.stringify(namedKeys)}, currency);
        series.push({key: null, other: true, totals: otherTotals, points: pointsByKey.get("other") ?? emptyPoints(buckets.length)});
      }
      colorOrder = (this.database.prepare(`SELECT ${column} AS key FROM usage_increments WHERE ${scoped.sql} GROUP BY ${column}
        ORDER BY SUM(COALESCE(input,0)+COALESCE(output,0)) DESC, ${column} LIMIT 8`).all(base) as {key: string | null}[]).map((row) => row.key);
    }
    for (const row of this.database.prepare(`WITH b(i,s,e) AS (SELECT key, json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@buckets))
      SELECT SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM b JOIN usage_increments ON ${where} AND placement='interval' AND ${IN_BUCKET}`)
      .safeIntegers().all({...values, buckets: bucketJson}) as {tokens: bigint | null}[]) placedIntervals += row.tokens ?? 0n;

    let matrix: UsageAnalyticsResponse["matrix"] = null;
    if (request.groupBy && request.crossBy && request.crossBy !== request.groupBy) {
      const rows = COLUMN[request.groupBy], columns = COLUMN[request.crossBy];
      matrix = {rows: request.groupBy, columns: request.crossBy, cells: (this.database.prepare(`SELECT ${rows} AS rowKey, ${columns} AS columnKey, ${aggregateSelect()}
        FROM usage_increments WHERE ${where} AND ${PLACED} AND ${within("@from", "@to")}
        GROUP BY ${rows}, ${columns} ORDER BY tokens DESC LIMIT 2000`).safeIntegers().all(values) as AggregateRow[])
        .map((row) => ({row: row.rowKey === null ? null : String(row.rowKey), column: row.columnKey === null ? null : String(row.columnKey), totals: aggregate(row, currency)}))};
    }

    const heatmap = new Map<string, {weekday: number; hour: number; tokens: bigint; cost: bigint}>();
    for (const row of this.database.prepare(`SELECT substr(occurred_at,1,14) || (CAST(substr(occurred_at,15,2) AS INTEGER)/15) AS slot,
        SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens, SUM(CASE WHEN currency=@currency THEN cost_units ELSE 0 END) AS cost
      FROM usage_increments WHERE ${where} AND placement IN ('reported','observed') AND ${within("@from", "@to")} GROUP BY slot`).safeIntegers().all(values) as {slot: string; tokens: bigint; cost: bigint}[]) {
      const quarter = Number(row.slot.slice(14));
      const instant = Date.parse(`${row.slot.slice(0, 14)}${String(quarter * 15).padStart(2, "0")}:00.000Z`);
      const local = localTime(instant, request.timeZone);
      const key = `${local.weekday}:${local.hour}`;
      const cell = heatmap.get(key) ?? {weekday: local.weekday, hour: local.hour, tokens: 0n, cost: 0n};
      cell.tokens += row.tokens; cell.cost += row.cost;
      heatmap.set(key, cell);
    }

    const placementRows = this.database.prepare(`SELECT placement, SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM usage_increments
      WHERE ${where} AND ${within("@from", "@to")} GROUP BY placement`).safeIntegers().all(values) as {placement: string; tokens: bigint}[];
    const placed = (name: string) => placementRows.find((row) => row.placement === name)?.tokens ?? 0n;
    const unplaced = (this.database.prepare(`SELECT SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM usage_increments
      WHERE ${where} AND placement='unplaced'`).safeIntegers().get(values) as {tokens: bigint | null}).tokens ?? 0n;
    // Recovered work received in range whose interval began before it: in no range total.
    const straddling = (this.database.prepare(`SELECT SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM usage_increments
      WHERE ${where} AND placement='interval' AND occurred_at >= @from AND occurred_at < @to AND interval_start < @from`).safeIntegers().get(values) as {tokens: bigint | null}).tokens ?? 0n;

    const facets = request.facets ? Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => {
      // Each dimension's choices ignore only its own selection.
      const others = this.#filters(request, dimension);
      const column = COLUMN[dimension];
      const search = request.facetSearch?.dimension === dimension ? request.facetSearch.text : null;
      const matching = search === null ? "" : ` AND ${column} IS NOT NULL AND (${column} LIKE @facetLike ESCAPE '\\'${FACET_NAMES[dimension] ?? ""})`;
      return [dimension, (this.database.prepare(`SELECT ${column} AS key, SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM usage_increments
        WHERE ${scoped.sql}${others.sql}${matching} AND ${PLACED} AND ${within("@from", "@to")} GROUP BY ${column} ORDER BY tokens DESC, ${column} LIMIT ${USAGE_ANALYTICS_MAX_FACETS}`)
        .safeIntegers().all({...base, ...others.values, from: iso(from), to: iso(to),
          ...(search === null ? {} : {facetLike: `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`})}) as {key: string | null; tokens: bigint}[])
        .map((row) => ({key: row.key === null ? null : String(row.key), tokens: String(row.tokens)}))];
    })) as NonNullable<UsageAnalyticsResponse["facets"]> : null;
    const coverage = this.#coverage(scope, where, values, request);
    const labels = this.#labels(scope, breakdowns, series, matrix, colorOrder, request.groupBy, facets);
    return usageAnalyticsResponseSchema.parse({
      generatedAt: now.toISOString(), timeZone: request.timeZone, from: iso(from), to: iso(to),
      firstRecordedAt: first.at ? new Date(first.at).toISOString() : null, bucket,
      buckets: buckets.map((b) => ({start: iso(b.start), end: iso(b.end)})), costCurrency: currency,
      totals, previous,
      timeline: {overall, groupBy: request.groupBy, series, colorOrder},
      breakdowns, matrix, facets,
      heatmap: [...heatmap.values()].filter((cell) => cell.tokens > 0n || cell.cost > 0n)
        .map((cell) => ({weekday: cell.weekday, hour: cell.hour, tokens: String(cell.tokens), cost: usageCostAmount(cell.cost)})),
      placement: {reported: String(placed("reported")), observed: String(placed("observed")), interval: String(placedIntervals),
        spanning: String(placed("interval") - placedIntervals < 0n ? 0n : placed("interval") - placedIntervals), straddling: String(straddling), unplaced: String(unplaced)},
      coverage, labels,
    });
  }

  #filters(request: UsageAnalyticsRequest, except?: UsageAnalyticsDimension): {sql: string; values: Record<string, string>} {
    let sql = "";
    const values: Record<string, string> = {};
    for (const dimension of USAGE_ANALYTICS_DIMENSIONS) {
      const selected = dimension === except ? undefined : request.filters[dimension];
      if (!selected?.length) continue;
      const keys = selected.filter((value): value is string => value !== null);
      const name = `filter_${dimension}`;
      values[name] = JSON.stringify(keys);
      const column = COLUMN[dimension];
      sql += ` AND (${column} IN (SELECT value FROM json_each(@${name}))${selected.includes(null) ? ` OR ${column} IS NULL` : ""})`;
    }
    return {sql, values};
  }

  #aggregateWhere(where: string, values: Record<string, unknown>, currency: string): UsageAnalyticsAggregate {
    return aggregate(this.database.prepare(`SELECT ${aggregateSelect()} FROM usage_increments WHERE ${where}`).safeIntegers().get(values) as AggregateRow, currency);
  }

  #breakdown(dimension: UsageAnalyticsDimension, where: string, values: Record<string, unknown>, limit: number, currency: string): UsageAnalyticsBreakdown {
    const column = COLUMN[dimension];
    const range = `${where} AND ${PLACED} AND ${within("@from", "@to")}`;
    const rows = this.database.prepare(`SELECT ${column} AS groupKey, ${aggregateSelect()} FROM usage_increments WHERE ${range}
      GROUP BY ${column} ORDER BY tokens DESC, costUnits DESC, ${column} LIMIT @limit`).safeIntegers().all({...values, limit: limit + 1}) as AggregateRow[];
    const distinct = (this.database.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM usage_increments WHERE ${range} GROUP BY ${column})`).safeIntegers().get(values) as {count: bigint}).count;
    const shown = rows.slice(0, limit);
    const other = rows.length > limit ? this.#aggregateWhere(`${range} AND ${outside(column, "@shown", shown.some((row) => row.groupKey === null))}`,
      {...values, shown: JSON.stringify(shown.flatMap((row) => row.groupKey === null ? [] : [String(row.groupKey)]))}, currency) : null;
    return {rows: shown.map((row) => ({key: row.groupKey === null ? null : String(row.groupKey), totals: aggregate(row, currency)})), other, distinct: String(distinct)};
  }

  #coverage(scope: RequestScope, where: string, values: Record<string, unknown>, request: UsageAnalyticsRequest): UsageAnalyticsResponse["coverage"] {
    const range = `${where} AND ${PLACED} AND ${within("@from", "@to")}`;
    const tokens = (condition: string) => String((this.database.prepare(`SELECT SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens FROM usage_increments
      WHERE ${range} AND ${condition}`).safeIntegers().get(values) as {tokens: bigint | null}).tokens ?? 0n);
    const quality = this.database.prepare(`SELECT
        COUNT(*) AS threads,
        SUM(json_extract(s.report_json,'$.state')='partial') AS partialThreads,
        SUM(EXISTS(SELECT 1 FROM json_each(s.report_json,'$.summary.reasons') r WHERE r.value IN ('counter_regression','conflicting_evidence'))) AS conflictThreads
      FROM usage_thread_state s WHERE s.tenant_id=@tenant AND s.principal_id=@principal
        AND s.thread_id IN (SELECT thread_id FROM usage_increments WHERE ${range})`).safeIntegers().get(values) as Record<string, bigint | null>;
    // Grok threads report no usage: filters on recorded usage details exclude them all,
    // while thread-level filters still narrow them.
    const threadColumns: Partial<Record<UsageAnalyticsDimension, string>> = {environment: "t.environment_id", backend: "t.backend_instance_id", backendKind: "b.kind", workspace: "t.workspace_id", thread: "t.id"};
    const usageOnly = USAGE_ANALYTICS_DIMENSIONS.some((dimension) => !threadColumns[dimension] && request.filters[dimension]?.length && !request.filters[dimension]!.includes(null));
    let threadFilter = "";
    const threadValues: unknown[] = [];
    for (const [dimension, column] of Object.entries(threadColumns) as [UsageAnalyticsDimension, string][]) {
      const selected = request.filters[dimension]?.filter((value): value is string => value !== null);
      if (!request.filters[dimension]?.length) continue;
      threadFilter += ` AND ${column} IN (SELECT value FROM json_each(?))`;
      threadValues.push(JSON.stringify(selected ?? []));
    }
    const unsupported = usageOnly ? {count: 0n} : this.database.prepare(`SELECT COUNT(*) AS count FROM application_threads t
      JOIN agent_backend_instances b ON b.tenant_id=t.tenant_id AND b.id=t.backend_instance_id
      WHERE t.tenant_id=? AND t.owner_principal_id=? AND b.kind='grok_build' AND t.last_activity_at >= ? AND t.last_activity_at < ?${threadFilter}`)
      .safeIntegers().get(scope.tenantId, scope.principalId, Date.parse(String(values.from)), Date.parse(String(values.to)), ...threadValues) as {count: bigint};
    return {threads: text(quality.threads), partialThreads: text(quality.partialThreads), conflictThreads: text(quality.conflictThreads),
      unsupportedThreads: String(unsupported.count), modelUnknownTokens: tokens("model IS NULL"), effortUnknownTokens: tokens("effort IS NULL")};
  }

  #labels(scope: RequestScope, breakdowns: Record<UsageAnalyticsDimension, UsageAnalyticsBreakdown>, series: UsageAnalyticsResponse["timeline"]["series"],
    matrix: UsageAnalyticsResponse["matrix"], colorOrder: readonly (string | null)[], groupBy: UsageAnalyticsDimension | null,
    facets: UsageAnalyticsResponse["facets"]): UsageAnalyticsResponse["labels"] {
    const keys = Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, new Set<string>()])) as Record<UsageAnalyticsDimension, Set<string>>;
    for (const dimension of USAGE_ANALYTICS_DIMENSIONS) for (const row of breakdowns[dimension].rows) if (row.key !== null) keys[dimension].add(row.key);
    if (groupBy) for (const key of [...series.map((entry) => entry.key), ...colorOrder]) if (key !== null) keys[groupBy].add(key);
    if (facets) for (const dimension of USAGE_ANALYTICS_DIMENSIONS) for (const row of facets[dimension]) if (row.key !== null) keys[dimension].add(row.key);
    if (matrix) for (const cell of matrix.cells) {
      if (cell.row !== null) keys[matrix.rows].add(cell.row);
      if (cell.column !== null) keys[matrix.columns].add(cell.column);
    }
    const label = (value: string, detail: string | null = null, kind: string | null = null, retired = false, workspaceId: string | null = null): UsageAnalyticsLabel =>
      ({label: value.slice(0, 512), detail: detail?.slice(0, 512) ?? null, kind, retired, workspaceId});
    const lookup = <T>(sql: string, ids: Set<string>) => ids.size ? this.database.prepare(sql).all(scope.tenantId, scope.principalId, JSON.stringify([...ids])) as T[] : [];
    const labels = Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, {} as Record<string, UsageAnalyticsLabel>])) as UsageAnalyticsResponse["labels"];
    for (const row of lookup<{id: string; label: string; kind: string}>(`SELECT id,label,kind FROM execution_environments
      WHERE tenant_id=? AND owner_principal_id=? AND id IN (SELECT value FROM json_each(?))`, keys.environment)) labels.environment[row.id] = label(row.label, null, row.kind);
    for (const row of lookup<{id: string; label: string; kind: string}>(`SELECT id,label,kind FROM agent_backend_instances
      WHERE tenant_id=? AND (owner_principal_id IS NULL OR owner_principal_id=?) AND id IN (SELECT value FROM json_each(?))`, keys.backend)) labels.backend[row.id] = label(row.label, null, row.kind);
    for (const row of lookup<{id: string; name: string; path: string; environment: string | null; removed: number | null}>(`SELECT w.id,w.display_name AS name,w.canonical_path AS path,
        e.label AS environment,w.removed_at AS removed FROM workspaces w
      LEFT JOIN execution_environments e ON e.tenant_id=w.tenant_id AND e.owner_principal_id=w.owner_principal_id AND e.id=w.environment_id
      WHERE w.tenant_id=? AND w.owner_principal_id=? AND w.id IN (SELECT value FROM json_each(?))`, keys.workspace)) {
      labels.workspace[row.id] = label(row.name, row.environment ? `${row.environment} · ${row.path}` : row.path, null, row.removed !== null);
    }
    for (const row of lookup<{id: string; title: string; kind: string | null; workspace: string; archived: number}>(`SELECT t.id,t.title,b.kind,t.workspace_id AS workspace,
        COALESCE(p.inventory_state='archived',0) AS archived FROM application_threads t
      LEFT JOIN agent_backend_instances b ON b.tenant_id=t.tenant_id AND b.id=t.backend_instance_id
      LEFT JOIN thread_principal_state p ON p.tenant_id=t.tenant_id AND p.principal_id=t.owner_principal_id AND p.thread_id=t.id
      WHERE t.tenant_id=? AND t.owner_principal_id=? AND t.id IN (SELECT value FROM json_each(?))`, keys.thread)) {
      labels.thread[row.id] = label(row.title, null, row.kind, row.archived === 1, row.workspace);
    }
    return labels;
  }
}
