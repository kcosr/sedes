import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartColumnBig, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@client/components/ui/button";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { UsageAnalyticsDimension, UsageAnalyticsRequest, UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { useUsageAnalytics } from "./use-usage-analytics.js";
import {
  RANGE_PRESETS, USAGE_TABS, readUsageSettings, resolveRange, writeUsageSettings,
  type UsageFilterState, type UsageTab, type UsageViewSettings,
} from "./usage-settings.js";
import { formatCost, formatCount, formatCountPrecise, formatPercent, metricReported, relativeChange, relativeTime, toNumber } from "./usage-format.js";
import { FilterChips, FilterPicker, GranularityMenu, RangePicker } from "./UsageToolbar.js";
import { StatTile } from "./usage-ui.js";
import { UsageOverview } from "./UsageOverview.js";
import { UsageExplore } from "./UsageExplore.js";
import { UsageThreads } from "./UsageThreads.js";
import { UsagePatterns } from "./UsagePatterns.js";
import { UsageCoverage } from "./UsageCoverage.js";
import "./usage.css";

const timeZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

/** Per-tab query shape: only the Explore matrix and Threads list need wider reads. */
function tabQuery(tab: UsageTab, settings: UsageViewSettings): Pick<UsageAnalyticsRequest, "groupBy" | "crossBy" | "breakdownLimit"> {
  if (tab === "overview") return { groupBy: settings.groupBy, crossBy: null, breakdownLimit: 8 };
  if (tab === "explore") return { groupBy: settings.exploreRows, crossBy: settings.exploreColumns, breakdownLimit: 100 };
  if (tab === "threads") return { groupBy: null, crossBy: null, breakdownLimit: 100 };
  return { groupBy: null, crossBy: null, breakdownLimit: 8 };
}

/** Principal-wide recorded usage analytics page. */
export function UsageView({ store }: { store: ApplicationClientStore }) {
  const [settings, setSettings] = useState<UsageViewSettings>(() => readUsageSettings());
  const [filters, setFilters] = useState<UsageFilterState>({});
  const [now, setNow] = useState(() => Date.now());
  const update = useCallback((patch: Partial<UsageViewSettings>) => setSettings((current) => {
    const next = { ...current, ...patch };
    writeUsageSettings(next);
    return next;
  }), []);
  const zone = useMemo(timeZone, []);
  const query = useMemo(() => tabQuery(settings.tab, settings), [settings]);
  const baseKey = JSON.stringify([settings.preset, settings.customFrom, settings.customTo, settings.bucket, filters, zone]);
  const key = JSON.stringify([baseKey, query]);
  const build = useCallback((): UsageAnalyticsRequest => {
    const range = resolveRange(settings, new Date());
    return { from: range.from?.toISOString() ?? null, to: range.to.toISOString(), timeZone: zone, bucket: settings.bucket, filters, facets: false, ...query };
  }, [settings, filters, zone, query]);
  const analytics = useUsageAnalytics(store.api, key, build, { poll: true });
  const data = analytics.data;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { setNow(Date.now()); }, [data]);

  const explore = (dimension: UsageAnalyticsDimension) => update({ tab: "explore", exploreRows: dimension, exploreColumns: null });
  const neverRecorded = data && data.firstRecordedAt === null && toNumber(data.placement.unplaced) === 0 && toNumber(data.totals.increments) === 0;
  const rangeLabel = resolveRange(settings).label;

  return (
    <section className="usage-view" aria-labelledby="usage-view-title">
      <div className="usage-page">
        <header className="usage-header">
          <div>
            <p className="eyebrow">Recorded usage · Experimental</p>
            <h1 id="usage-view-title">Usage</h1>
            <p>Tokens and estimated spend recorded across your threads.</p>
          </div>
          <div className="usage-header-status">
            {data ? <span title={new Date(data.generatedAt).toLocaleString()}>Updated {relativeTime(data.generatedAt, now)}</span> : null}
            <Button variant="ghost" size="icon-sm" onClick={analytics.refresh} aria-label="Refresh usage" title="Refresh usage" disabled={analytics.loading && !data}>
              <RefreshCw className={analytics.loading ? "usage-spin" : undefined} />
            </Button>
          </div>
        </header>

        <div className="usage-toolbar" role="toolbar" aria-label="Usage range and filters">
          <RangePicker settings={settings} onChange={update} />
          <GranularityMenu value={settings.bucket} resolved={data?.bucket} onChange={(bucket) => update({ bucket })} />
          <FilterPicker api={store.api} filters={filters} onChange={setFilters} buildRequest={build} requestKey={baseKey} labels={data?.labels} />
          <FilterChips filters={filters} labels={data?.labels} onChange={setFilters} />
        </div>

        {analytics.error ? (
          <div className="usage-banner" role="alert">
            <TriangleAlert aria-hidden="true" size={16} />
            <span>{data ? "Usage could not be refreshed. Showing the last successful read." : "Usage is unavailable right now."} <small>{analytics.error}</small></span>
            <Button variant="outline" size="sm" onClick={analytics.refresh}>Retry</Button>
          </div>
        ) : null}

        {!data ? (analytics.error ? null : <UsageSkeleton />) : neverRecorded ? (
          <div className="usage-empty">
            <ChartColumnBig aria-hidden="true" size={24} />
            <h2>No recorded usage yet</h2>
            <p>Sedes records tokens and estimated cost on the server as Pi, Codex, and Claude threads run. Charts appear here after the first recorded turn. Grok does not report usage.</p>
          </div>
        ) : (
          <div className="usage-content" data-stale={analytics.stale ? "true" : undefined} aria-busy={analytics.loading}>
            <SummaryTiles data={data} rangeLabel={rangeLabel} comparable={settings.preset !== "all"} />
            <nav className="usage-tabs" role="tablist" aria-label="Usage views">
              {USAGE_TABS.map((tab) => (
                <button key={tab.id} type="button" role="tab" id={`usage-tab-${tab.id}`} aria-selected={settings.tab === tab.id}
                  aria-controls="usage-tab-panel" onClick={() => update({ tab: tab.id })}>{tab.label}</button>
              ))}
            </nav>
            <div id="usage-tab-panel" role="tabpanel" aria-labelledby={`usage-tab-${settings.tab}`} className="usage-tab-panel">
              {settings.tab === "overview" ? <UsageOverview data={data} settings={settings} onSettings={update} filters={filters} onFilters={setFilters} onExplore={explore} />
                : settings.tab === "explore" ? <UsageExplore data={data} settings={settings} onSettings={update} filters={filters} onFilters={setFilters} />
                : settings.tab === "threads" ? <UsageThreads data={data} filters={filters} onFilters={setFilters} />
                : settings.tab === "patterns" ? <UsagePatterns data={data} />
                : <UsageCoverage data={data} />}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryTiles({ data, rangeLabel, comparable }: { readonly data: UsageAnalyticsResponse; readonly rangeLabel: string; readonly comparable: boolean }) {
  const { totals, previous, costCurrency: currency } = data;
  const before = comparable ? previous?.totals ?? null : null;
  const cost = (aggregate: UsageAnalyticsResponse["totals"]) => toNumber(aggregate.costs.find((entry) => entry.currency === currency)?.amount ?? 0);
  const trend = (metric: "tokens" | "input" | "output" | "cost") => data.timeline.overall[metric].map(toNumber);
  const changeLabel = RANGE_PRESETS.some((preset) => preset.label === rangeLabel) ? "vs previous period" : "vs prior range";
  const tokens = toNumber(totals.tokens), input = toNumber(totals.input), output = toNumber(totals.output);
  const uncosted = toNumber(totals.uncostedTokens);
  const threads = toNumber(totals.threads);
  const estimated = totals.costs[0]?.kind !== "reported";
  return (
    <div className="usage-stats" aria-label={`Totals for ${rangeLabel}`}>
      <StatTile label="Total tokens" value={formatCountPrecise(tokens)} title={`${tokens.toLocaleString()} tokens`}
        change={before ? relativeChange(tokens, toNumber(before.tokens)) : null} changeLabel={changeLabel} trend={trend("tokens")} />
      <StatTile label={estimated ? "Estimated cost" : "Reported cost"} value={totals.costs.length ? formatCost(cost(totals), currency) : "—"}
        change={before && totals.costs.length && before.costs.length ? relativeChange(cost(totals), cost(before)) : null} changeLabel={changeLabel} trend={trend("cost")}
        detail={uncosted > 0 && tokens > 0 ? `${formatPercent(uncosted / tokens)} of tokens unpriced` : undefined} />
      <StatTile label="Input" value={formatCountPrecise(input)} title={`${input.toLocaleString()} input tokens`}
        change={before ? relativeChange(input, toNumber(before.input)) : null} changeLabel={changeLabel} trend={trend("input")}
        detail={input > 0 && metricReported(totals, "cacheRead") ? `${formatPercent(toNumber(totals.cacheRead) / input)} from cache` : undefined} />
      <StatTile label="Output" value={formatCountPrecise(output)} title={`${output.toLocaleString()} output tokens`}
        change={before ? relativeChange(output, toNumber(before.output)) : null} changeLabel={changeLabel} trend={trend("output")}
        detail={output > 0 && toNumber(totals.reasoning) > 0 ? `${formatPercent(toNumber(totals.reasoning) / output)} reasoning` : undefined} />
      <StatTile label="Active threads" value={formatCount(threads)}
        change={before ? relativeChange(threads, toNumber(before.threads)) : null} changeLabel={changeLabel}
        detail={threads > 0 ? `${formatCountPrecise(tokens / threads)} tokens each` : undefined} />
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="usage-skeleton" aria-busy="true" aria-label="Loading usage">
      <div className="usage-stats">{Array.from({ length: 5 }, (_, index) => <div key={index} className="usage-stat usage-skeleton-block" />)}</div>
      <div className="usage-card usage-skeleton-block usage-skeleton-chart" />
    </div>
  );
}
