import { useState } from "react";
import { ArrowUpRight, ListFilter, Search } from "lucide-react";
import type { UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { openThreadRoute, pointerPanelPresentation } from "../workspace-panels/thread-panel-navigation.js";
import { dimensionLabel, formatCount, formatCost, formatMetric, formatPercent, metricValue, toNumber, type UsageMetric } from "./usage-format.js";
import { toggleFilter, type UsageFilterState } from "./usage-settings.js";
import { DimensionIcon, MenuSelect, UsageCard } from "./usage-ui.js";

type ThreadSort = Extract<UsageMetric, "tokens" | "cost" | "input" | "output" | "reasoning">;

export function UsageThreads({ data, filters, onFilters }: {
  readonly data: UsageAnalyticsResponse;
  readonly filters: UsageFilterState;
  readonly onFilters: (filters: UsageFilterState) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ThreadSort>("tokens");
  const currency = data.costCurrency;
  const breakdown = data.breakdowns.thread;
  const total = metricValue(data.totals, sort, currency);
  const needle = query.trim().toLocaleLowerCase();
  const rows = breakdown.rows
    .filter((row) => row.key !== null)
    .map((row) => ({ row, label: dimensionLabel(data.labels, "thread", row.key) }))
    .filter(({ label }) => !needle || `${label.label} ${label.detail ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => metricValue(b.row.totals, sort, currency) - metricValue(a.row.totals, sort, currency));
  const largest = Math.max(0, ...rows.map(({ row }) => metricValue(row.totals, sort, currency)));
  const truncated = toNumber(breakdown.distinct) > breakdown.rows.length;
  return (
    <UsageCard className="usage-card-wide" title="Threads"
      subtitle={truncated ? `The ${breakdown.rows.length} threads with the most tokens, of ${formatCount(breakdown.distinct)} with usage in this range` : `${formatCount(breakdown.distinct)} threads with usage in this range`}
      actions={<>
        <label className="usage-inline-search">
          <Search aria-hidden="true" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads" aria-label="Search threads" />
        </label>
        <MenuSelect label="Sort threads by" prefix="Sort" value={sort} onChange={setSort} align="end"
          options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }, { value: "input", label: "Input" }, { value: "output", label: "Output" }, { value: "reasoning", label: "Reasoning" }]} />
      </>}>
      {rows.length === 0 ? <p className="usage-empty-note">{needle ? "No threads match your search" : "No thread usage in this range"}</p> : (
        <ol className="usage-thread-list">
          {rows.map(({ row, label }) => {
            const value = metricValue(row.totals, sort, currency);
            const input = toNumber(row.totals.input);
            const cached = input > 0 ? toNumber(row.totals.cacheRead) / input : null;
            const cost = row.totals.costs.find((entry) => entry.currency === currency);
            const filtered = filters.thread?.includes(row.key) ?? false;
            return (
              <li key={row.key} className="usage-thread-row" data-thread-id={row.key ?? undefined} data-selected={filtered ? "true" : undefined}>
                <button type="button" className="usage-thread-open" onClick={(event) => openThreadRoute(row.key!, pointerPanelPresentation(event))}
                  disabled={label.unknown} title={label.unknown ? "This thread no longer exists" : "Open thread"}>
                  <span className="usage-thread-title">
                    <DimensionIcon dimension="thread" label={label} />
                    <span>{label.label}</span>
                    {label.retired ? <span className="usage-bar-badge">Archived</span> : null}
                    {label.unknown ? null : <ArrowUpRight aria-hidden="true" size={13} className="usage-thread-arrow" />}
                  </span>
                  {label.detail ? <small>{label.detail}</small> : null}
                  <span className="usage-bar-track" aria-hidden="true">
                    <i style={{ width: `${largest > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / largest) * 100) : 0}%` }} />
                  </span>
                </button>
                <dl className="usage-thread-figures">
                  <div><dt>{sort === "cost" ? "Cost" : sort === "tokens" ? "Tokens" : sort.charAt(0).toUpperCase() + sort.slice(1)}</dt>
                    <dd><strong>{formatMetric(value, sort, currency, true)}</strong><small>{total > 0 ? formatPercent(value / total) : "–"}</small></dd></div>
                  {sort !== "cost" ? <div><dt>Cost</dt><dd>{cost ? formatCost(cost.amount, currency) : "—"}</dd></div> : <div><dt>Tokens</dt><dd>{formatCount(row.totals.tokens)}</dd></div>}
                  <div><dt>Cached</dt><dd>{cached === null ? "—" : formatPercent(cached)}</dd></div>
                </dl>
                <button type="button" className="usage-thread-filter" aria-pressed={filtered} aria-label={filtered ? `Remove ${label.label} filter` : `Filter to ${label.label}`}
                  title={filtered ? "Remove filter" : "Filter the page to this thread"} onClick={() => onFilters(toggleFilter(filters, "thread", row.key))}>
                  <ListFilter aria-hidden="true" size={15} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </UsageCard>
  );
}
