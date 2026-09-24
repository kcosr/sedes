import { useMemo, useState } from "react";
import { ChartColumnBig, ChartLine, Table2 } from "lucide-react";
import { Button } from "@client/components/ui/button";
import type { UsageAnalyticsDimension, UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { BarList } from "./charts/BarList.js";
import { TimeSeriesChart, type ChartSeries } from "./charts/TimeSeriesChart.js";
import { OTHER_COLOR, assignSeriesColors, seriesColor } from "./charts/chart-kit.js";
import {
  DIMENSION_META, DIMENSION_ORDER, GRANULARITY_LABEL, GRANULARITY_NOUN, METRIC_META, METRIC_ORDER, bucketLabel, dimensionLabel,
  formatCount, formatMetric, metricReported, metricValue, toNumber, type UsageMetric,
} from "./usage-format.js";
import { toggleFilter, type UsageFilterState, type UsageViewSettings } from "./usage-settings.js";
import { DimensionIcon, MenuSelect, Segmented, UsageCard } from "./usage-ui.js";

const CARD_DIMENSIONS: readonly UsageAnalyticsDimension[] = ["model", "provider", "effort", "backend", "environment", "workspace", "agentRole", "activity"];
const CARD_ROWS = 6;

/** Chart series for the selected metric, colored by filter-independent rank. */
export function timelineSeries(data: UsageAnalyticsResponse, metric: UsageMetric): ChartSeries[] {
  const values = (points: UsageAnalyticsResponse["timeline"]["overall"]) => points[metric].map(toNumber);
  const { series, groupBy, colorOrder } = data.timeline;
  if (!groupBy || !series.length) return [{ id: "all", label: METRIC_META[metric].short, color: seriesColor(0), values: values(data.timeline.overall) }];
  const colors = assignSeriesColors(series, colorOrder);
  return series.map((entry, index) => ({
    // Prefixed so a stored key such as "other" never collides with the fold.
    id: entry.other ? "other" : entry.key === null ? "unknown" : `key:${entry.key}`,
    label: entry.other ? "Other" : dimensionLabel(data.labels, groupBy, entry.key).label,
    color: colors[index]!,
    values: values(entry.points),
  }));
}

export function UsageOverview({ data, settings, onSettings, filters, onFilters, onExplore }: {
  readonly data: UsageAnalyticsResponse;
  readonly settings: UsageViewSettings;
  readonly onSettings: (patch: Partial<UsageViewSettings>) => void;
  readonly filters: UsageFilterState;
  readonly onFilters: (filters: UsageFilterState) => void;
  readonly onExplore: (dimension: UsageAnalyticsDimension) => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [table, setTable] = useState(false);
  const metric = settings.metric;
  const currency = data.costCurrency;
  const all = useMemo(() => timelineSeries(data, metric), [data, metric]);
  const visible = all.filter((entry) => !hidden.has(entry.id));
  const format = (value: number) => formatMetric(value, metric, currency);
  const groupLabel = data.timeline.groupBy ? DIMENSION_META[data.timeline.groupBy].label.toLocaleLowerCase() : null;
  const spanning = toNumber(data.placement.spanning);
  const straddling = toNumber(data.placement.straddling);
  const seriesColors = new Map(all.map((entry) => [entry.id, entry.color]));
  const toggle = (id: string) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next.size >= all.length ? new Set() : next;
  });

  return (
    <div className="usage-overview">
      <UsageCard
        className="usage-card-wide"
        title="Usage over time"
        subtitle={`${METRIC_META[metric].label}${groupLabel ? ` by ${groupLabel}` : ""} · ${GRANULARITY_LABEL[data.bucket].toLocaleLowerCase()}`}
        actions={<>
          <MenuSelect label="Metric" value={metric} onChange={(next) => onSettings({ metric: next })}
            options={METRIC_ORDER.map((value) => ({ value, label: METRIC_META[value].short }))} />
          <MenuSelect label="Group by" prefix="By" value={settings.groupBy ?? "none"}
            onChange={(next) => { setHidden(new Set()); onSettings({ groupBy: next === "none" ? null : next }); }}
            options={[{ value: "none" as const, label: "Nothing" }, ...DIMENSION_ORDER.map((value) => ({ value, label: DIMENSION_META[value].label }))]} />
          <Segmented label="Chart type" value={settings.chart} onChange={(chart) => onSettings({ chart })}
            options={[{ value: "bars", label: "Stacked columns", icon: <ChartColumnBig size={15} /> }, { value: "lines", label: "Lines", icon: <ChartLine size={15} /> }]} />
          <Button variant={table ? "secondary" : "ghost"} size="icon-sm" aria-pressed={table} aria-label="Show as table" title="Show as table"
            onClick={() => setTable((current) => !current)}><Table2 /></Button>
        </>}
        footer={spanning > 0 || straddling > 0 ? (
          <p className="usage-footnote">
            {spanning > 0 ? `${formatCount(spanning)} tokens recovered after capture gaps span more than one ${GRANULARITY_NOUN[data.bucket]} and are included in totals but not drawn.${data.bucket !== "month" ? " A coarser granularity can place them." : ""}` : ""}
            {spanning > 0 && straddling > 0 ? " " : ""}
            {straddling > 0 ? `${formatCount(straddling)} tokens recovered in this range began before it, so they are in neither the totals nor the chart.` : ""}
          </p>
        ) : null}
      >
        {table ? <SeriesTable data={data} series={visible} format={format} /> : (
          <TimeSeriesChart buckets={data.buckets} granularity={data.bucket} series={visible} mode={settings.chart} format={format}
            formatTooltip={(value) => formatMetric(value, metric, currency, true)}
            ariaLabel={`${METRIC_META[metric].label}${groupLabel ? ` by ${groupLabel}` : ""}. Use arrow keys to read each ${GRANULARITY_NOUN[data.bucket]}.`} />
        )}
        {all.length > 1 || data.timeline.groupBy ? (
          <ul className="usage-legend" aria-label="Series">
            {all.map((entry) => {
              const total = entry.values.reduce((sum, value) => sum + value, 0);
              return (
                <li key={entry.id}>
                  <button type="button" aria-pressed={!hidden.has(entry.id)} onClick={() => toggle(entry.id)}
                    title={hidden.has(entry.id) ? `Show ${entry.label}` : `Hide ${entry.label}`}>
                    <i style={{ background: entry.color }} aria-hidden="true" />
                    <span>{entry.label}</span>
                    <strong>{format(total)}</strong>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </UsageCard>

      <div className="usage-breakdown-grid">
        {CARD_DIMENSIONS.map((dimension) => {
          const breakdown = data.breakdowns[dimension];
          const total = metricValue(data.totals, metric, currency);
          const rows = breakdown.rows.slice(0, CARD_ROWS).map((row) => {
            const label = dimensionLabel(data.labels, dimension, row.key);
            const value = metricValue(row.totals, metric, currency);
            const id = row.key ?? "∅";
            // The card for the charted dimension reuses the chart's colors; rows folded into Other stay neutral.
            const matching = data.timeline.groupBy === dimension ? seriesColors.get(row.key === null ? "unknown" : `key:${row.key}`) ?? OTHER_COLOR : undefined;
            return { id, label: label.label, detail: label.detail, icon: <DimensionIcon dimension={dimension} label={label} />,
              value, display: metricReported(row.totals, metric) ? format(value) : "—", color: matching, muted: label.unknown,
              selected: filters[dimension]?.includes(row.key) ?? false, badge: label.retired ? (dimension === "thread" ? "Archived" : "Removed") : null };
          });
          const more = toNumber(breakdown.distinct) - rows.length;
          return (
            <UsageCard key={dimension} title={DIMENSION_META[dimension].plural}
              subtitle={`${formatCount(breakdown.distinct)} with usage`}
              footer={more > 0 ? <button type="button" className="usage-link" onClick={() => onExplore(dimension)}>View all {formatCount(toNumber(breakdown.distinct))} in Explore</button> : null}>
              <BarList label={`${METRIC_META[metric].label} by ${DIMENSION_META[dimension].label.toLocaleLowerCase()}`} rows={rows} total={total}
                onSelect={(id) => onFilters(toggleFilter(filters, dimension, id === "∅" ? null : id))} />
            </UsageCard>
          );
        })}
      </div>
    </div>
  );
}

export function SeriesTable({ data, series, format }: { readonly data: UsageAnalyticsResponse; readonly series: readonly ChartSeries[]; readonly format: (value: number) => string }) {
  return (
    <div className="usage-table-scroll usage-series-table">
      <table className="usage-table">
        <thead>
          <tr><th scope="col">{GRANULARITY_NOUN[data.bucket].charAt(0).toUpperCase() + GRANULARITY_NOUN[data.bucket].slice(1)}</th>
            {series.map((entry) => <th key={entry.id} scope="col" className="usage-num"><i className="usage-key" style={{ background: entry.color }} aria-hidden="true" />{entry.label}</th>)}
            {series.length > 1 ? <th scope="col" className="usage-num">Total</th> : null}</tr>
        </thead>
        <tbody>
          {data.buckets.map((bucket, index) => {
            const values = series.map((entry) => entry.values[index] ?? 0);
            return (
              <tr key={bucket.start}>
                <th scope="row">{bucketLabel(bucket, data.bucket)}</th>
                {values.map((value, column) => <td key={series[column]!.id} className="usage-num">{value ? format(value) : "–"}</td>)}
                {series.length > 1 ? <td className="usage-num">{format(values.reduce((sum, value) => sum + value, 0))}</td> : null}
              </tr>
            );
          }).reverse()}
        </tbody>
      </table>
    </div>
  );
}
