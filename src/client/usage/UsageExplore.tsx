import { useMemo, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { Button } from "@client/components/ui/button";
import type { UsageAnalyticsAggregate, UsageAnalyticsDimension, UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import {
  DIMENSION_META, DIMENSION_ORDER, EFFORT_ORDER, METRIC_META, METRIC_ORDER, dimensionLabel, formatCount, formatMetric, formatPercent,
  metricReported, metricValue, toNumber, type DimensionLabel, type UsageMetric,
} from "./usage-format.js";
import { toggleFilter, type UsageFilterState, type UsageViewSettings } from "./usage-settings.js";
import { DimensionIcon, MenuSelect, UsageCard } from "./usage-ui.js";

type Column = UsageMetric | "share" | "threads" | "cacheShare";
const TABLE_COLUMNS: readonly { id: Column; label: string; title?: string }[] = [
  { id: "tokens", label: "Tokens" }, { id: "share", label: "Share" }, { id: "cost", label: "Est. cost" },
  { id: "input", label: "Input" }, { id: "cacheRead", label: "Cache read" }, { id: "cacheShare", label: "Cached", title: "Share of input read from cache" },
  { id: "cacheWrite", label: "Cache write" }, { id: "output", label: "Output" }, { id: "reasoning", label: "Reasoning" },
  { id: "requests", label: "Requests" }, { id: "threads", label: "Threads" },
];
const MATRIX_ROWS = 30, MATRIX_COLUMNS = 8;

interface ExploreRow { readonly id: string; readonly key: string | null; readonly other: boolean; readonly label: DimensionLabel; readonly totals: UsageAnalyticsAggregate }

/** Quote as needed and neutralize spreadsheet formulas in names such as thread titles. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * CSV for what Explore shows: the row table, or the split matrix in long form.
 * Blank cells mean "not reported"; zero is exported only when a record reported it.
 */
export function exploreCsv(data: UsageAnalyticsResponse, dimension: UsageAnalyticsDimension, columns: UsageAnalyticsDimension | null,
  rows: readonly { readonly label: DimensionLabel; readonly totals: UsageAnalyticsAggregate }[]): string {
  const currency = data.costCurrency;
  const metrics = (totals: UsageAnalyticsAggregate): string[] => {
    const known = (metric: string, value: string) => metricReported(totals, metric) ? value : "";
    return [metricReported(totals, "input") || metricReported(totals, "output") ? totals.tokens : "",
      known("input", totals.input), known("input", totals.uncachedInput), known("cacheRead", totals.cacheRead), known("cacheWrite", totals.cacheWrite),
      known("output", totals.output), known("reasoning", totals.reasoning), known("requests", totals.requests),
      totals.costs.find((cost) => cost.currency === currency)?.amount ?? "", totals.threads];
  };
  const header = ["Tokens", "Input", "Uncached input", "Cache read", "Cache write", "Output", "Reasoning", "Requests", `Estimated cost (${currency})`, "Threads"];
  const split = columns && data.matrix ? data.matrix : null;
  const lines = split
    ? [[DIMENSION_META[dimension].label, "Detail", DIMENSION_META[split.columns].label, ...header],
      ...split.cells.map((cell) => {
        const row = dimensionLabel(data.labels, dimension, cell.row), column = dimensionLabel(data.labels, split.columns, cell.column);
        return [row.label, row.detail ?? "", column.label, ...metrics(cell.totals)];
      })]
    : [[DIMENSION_META[dimension].label, "Detail", ...header], ...rows.map((row) => [row.label.label, row.label.detail ?? "", ...metrics(row.totals)])];
  return lines.map((line) => line.map(csvCell).join(",")).join("\n");
}

function columnValue(row: ExploreRow, column: Column, currency: string, total: number): number {
  if (column === "share") return total > 0 ? toNumber(row.totals.tokens) / total : 0;
  if (column === "threads") return toNumber(row.totals.threads);
  if (column === "cacheShare") return toNumber(row.totals.input) > 0 ? toNumber(row.totals.cacheRead) / toNumber(row.totals.input) : 0;
  return metricValue(row.totals, column, currency);
}

export function UsageExplore({ data, settings, onSettings, filters, onFilters }: {
  readonly data: UsageAnalyticsResponse;
  readonly settings: UsageViewSettings;
  readonly onSettings: (patch: Partial<UsageViewSettings>) => void;
  readonly filters: UsageFilterState;
  readonly onFilters: (filters: UsageFilterState) => void;
}) {
  const [sort, setSort] = useState<{ column: Column; descending: boolean }>({ column: "tokens", descending: true });
  const dimension = settings.exploreRows;
  const currency = data.costCurrency;
  const breakdown = data.breakdowns[dimension];
  const totalTokens = toNumber(data.totals.tokens);
  const rows = useMemo<ExploreRow[]>(() => {
    const list: ExploreRow[] = breakdown.rows.map((row) => ({ id: row.key ?? "∅", key: row.key, other: false,
      label: dimensionLabel(data.labels, dimension, row.key), totals: row.totals }));
    if (breakdown.other) list.push({ id: "\u0000other", key: null, other: true, totals: breakdown.other,
      label: { label: `Other (${formatCount(toNumber(breakdown.distinct) - breakdown.rows.length)} more)`, detail: null, brand: undefined, retired: false, unknown: true } });
    return list;
  }, [breakdown, data.labels, dimension]);
  const sorted = [...rows].sort((a, b) => {
    if (a.other !== b.other) return a.other ? 1 : -1;
    const difference = columnValue(a, sort.column, currency, totalTokens) - columnValue(b, sort.column, currency, totalTokens);
    return (sort.descending ? -difference : difference) || a.label.label.localeCompare(b.label.label);
  });
  const hasRequests = toNumber(data.totals.requests) > 0;
  const columns = TABLE_COLUMNS.filter((column) => column.id !== "requests" || hasRequests);
  const format = (row: ExploreRow, column: Column): string => {
    const value = columnValue(row, column, currency, totalTokens);
    if (column === "share" || column === "cacheShare") return value ? formatPercent(value) : "–";
    if (column === "threads") return formatCount(value);
    if (column === "cost" && !row.totals.costs.length) return "—";
    if (!metricReported(row.totals, column)) return "—";
    return formatMetric(value, column, currency, true);
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([exploreCsv(data, dimension, settings.exploreColumns, sorted)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sedes-usage-by-${dimension}${settings.exploreColumns && data.matrix ? `-and-${settings.exploreColumns}` : ""}-${data.from.slice(0, 10)}-${data.to.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="usage-explore">
      <div className="usage-explore-controls">
        <MenuSelect label="Rows" prefix="Rows" value={dimension} onChange={(next) => onSettings({ exploreRows: next, exploreColumns: settings.exploreColumns === next ? null : settings.exploreColumns })}
          options={DIMENSION_ORDER.map((value) => ({ value, label: DIMENSION_META[value].label }))} />
        <MenuSelect label="Split by" prefix="Split" value={settings.exploreColumns ?? "none"}
          onChange={(next) => onSettings({ exploreColumns: next === "none" ? null : next })}
          options={[{ value: "none" as const, label: "Nothing" }, ...DIMENSION_ORDER.filter((value) => value !== dimension).map((value) => ({ value, label: DIMENSION_META[value].label }))]} />
        {settings.exploreColumns ? <MenuSelect label="Metric" value={settings.metric} onChange={(metric) => onSettings({ metric })}
          options={METRIC_ORDER.map((value) => ({ value, label: METRIC_META[value].short }))} /> : null}
        <span className="usage-toolbar-spacer" />
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}><Download aria-hidden="true" />Export CSV</Button>
      </div>
      {settings.exploreColumns && data.matrix ? (
        <MatrixCard data={data} rows={rows.filter((row) => !row.other)} dimension={dimension} columns={settings.exploreColumns} metric={settings.metric} />
      ) : (
        <UsageCard className="usage-card-wide" title={`Usage by ${DIMENSION_META[dimension].label.toLocaleLowerCase()}`}
          subtitle={`${formatCount(breakdown.distinct)} ${DIMENSION_META[dimension].plural.toLocaleLowerCase()} · select a name to filter`}>
          {rows.length === 0 ? <p className="usage-empty-note">No recorded usage in this range</p> : (
            <div className="usage-table-scroll">
              <table className="usage-table usage-explore-table">
                <thead>
                  <tr>
                    <th scope="col">{DIMENSION_META[dimension].label}</th>
                    {columns.map((column) => (
                      <th key={column.id} scope="col" className="usage-num" title={column.title}
                        aria-sort={sort.column === column.id ? (sort.descending ? "descending" : "ascending") : undefined}>
                        <button type="button" onClick={() => setSort((current) => ({ column: column.id, descending: current.column === column.id ? !current.descending : true }))}>
                          {column.label}
                          {sort.column === column.id ? (sort.descending ? <ArrowDown aria-hidden="true" size={12} /> : <ArrowUp aria-hidden="true" size={12} />) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => {
                    const selected = !row.other && (filters[dimension]?.includes(row.key) ?? false);
                    return (
                      <tr key={row.id} data-selected={selected ? "true" : undefined}>
                        <th scope="row">
                          {row.other ? <span className="usage-explore-name usage-muted">{row.label.label}</span> : (
                            <button type="button" className="usage-explore-name" aria-pressed={selected}
                              onClick={() => onFilters(toggleFilter(filters, dimension, row.key))} title={selected ? "Remove filter" : "Filter to this"}>
                              <DimensionIcon dimension={dimension} label={row.label} />
                              <span className="usage-explore-name-text">
                                <span data-unknown={row.label.unknown ? "true" : undefined}>{row.label.label}</span>
                                {row.label.detail ? <small>{row.label.detail}</small> : null}
                              </span>
                              {row.label.retired ? <span className="usage-bar-badge">{dimension === "thread" ? "Archived" : "Removed"}</span> : null}
                            </button>
                          )}
                        </th>
                        {columns.map((column) => (
                          <td key={column.id} className="usage-num">
                            {column.id === "share" ? (
                              <span className="usage-share-cell">
                                <i aria-hidden="true"><b style={{ width: `${Math.min(100, columnValue(row, "share", currency, totalTokens) * 100)}%` }} /></i>
                                <span>{format(row, column.id)}</span></span>
                            ) : format(row, column.id)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    {columns.map((column) => (
                      <td key={column.id} className="usage-num">
                        {format({ id: "total", key: null, other: false, label: { label: "Total", detail: null, brand: undefined, retired: false, unknown: false }, totals: data.totals }, column.id)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </UsageCard>
      )}
    </div>
  );
}

function MatrixCard({ data, rows, dimension, columns: columnDimension, metric }: {
  readonly data: UsageAnalyticsResponse; readonly rows: readonly ExploreRow[]; readonly dimension: UsageAnalyticsDimension;
  readonly columns: UsageAnalyticsDimension; readonly metric: UsageMetric;
}) {
  const currency = data.costCurrency;
  const cells = data.matrix?.cells ?? [];
  const columnTotals = new Map<string, number>();
  const value = new Map<string, number>();
  const id = (key: string | null) => key ?? "∅";
  for (const cell of cells) {
    const amount = metricValue(cell.totals, metric, currency);
    columnTotals.set(id(cell.column), (columnTotals.get(id(cell.column)) ?? 0) + amount);
    value.set(`${id(cell.row)}\u0001${id(cell.column)}`, amount);
  }
  // Effort is ordinal: keep its scale in order instead of ranking by volume.
  const ordinal = (key: string) => { const index = EFFORT_ORDER.indexOf(key); return index < 0 ? EFFORT_ORDER.length : index; };
  const ranked = [...columnTotals.entries()].sort((a, b) => b[1] - a[1]);
  if (columnDimension === "effort") ranked.splice(0, MATRIX_COLUMNS, ...ranked.slice(0, MATRIX_COLUMNS).sort((a, b) => ordinal(a[0]) - ordinal(b[0])));
  const shownColumns = ranked.slice(0, MATRIX_COLUMNS).map(([key]) => key);
  const folded = ranked.length > MATRIX_COLUMNS;
  const shownRows = rows.slice(0, MATRIX_ROWS);
  const cell = (row: string, column: string) => value.get(`${row}\u0001${column}`) ?? 0;
  const otherFor = (row: string) => ranked.slice(MATRIX_COLUMNS).reduce((sum, [column]) => sum + cell(row, column), 0);
  const maximum = Math.max(0, ...shownRows.flatMap((row) => [...shownColumns.map((column) => cell(row.id, column)), folded ? otherFor(row.id) : 0]));
  const format = (amount: number) => amount ? formatMetric(amount, metric, currency) : "–";
  const shade = (amount: number) => maximum > 0 && amount > 0 ? { "--usage-cell": `${Math.round(6 + (amount / maximum) * 58)}%` } as CSSProperties : undefined;
  const columnLabel = (key: string) => dimensionLabel(data.labels, columnDimension, key === "∅" ? null : key);
  return (
    <UsageCard className="usage-card-wide" title={`${DIMENSION_META[dimension].label} × ${DIMENSION_META[columnDimension].label.toLocaleLowerCase()}`}
      subtitle={`${METRIC_META[metric].label}. Darker cells carry more.${cells.length >= 2000 ? " Only the largest 2,000 combinations are shown; totals include all." : ""}`}>
      {shownRows.length === 0 ? <p className="usage-empty-note">No recorded usage in this range</p> : (
        <div className="usage-table-scroll">
          <table className="usage-table usage-matrix">
            <thead>
              <tr>
                <th scope="col">{DIMENSION_META[dimension].label}</th>
                {shownColumns.map((column) => <th key={column} scope="col" className="usage-num" title={columnLabel(column).label}>{columnLabel(column).label}</th>)}
                {folded ? <th scope="col" className="usage-num">Other</th> : null}
                <th scope="col" className="usage-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => {
                const values = shownColumns.map((column) => cell(row.id, column));
                const other = folded ? otherFor(row.id) : 0;
                return (
                  <tr key={row.id}>
                    <th scope="row"><span className="usage-explore-name-text"><span>{row.label.label}</span>{row.label.detail ? <small>{row.label.detail}</small> : null}</span></th>
                    {values.map((amount, index) => <td key={shownColumns[index]} className="usage-num usage-matrix-cell" style={shade(amount)}>{format(amount)}</td>)}
                    {folded ? <td className="usage-num usage-matrix-cell" style={shade(other)}>{format(other)}</td> : null}
                    <td className="usage-num usage-strong">{format(metricValue(row.totals, metric, currency))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </UsageCard>
  );
}
