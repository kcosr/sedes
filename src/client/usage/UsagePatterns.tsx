import { useMemo, useState } from "react";
import { Table2 } from "lucide-react";
import { Button } from "@client/components/ui/button";
import type { UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { Heatmap, formatHour } from "./charts/Heatmap.js";
import { ShareBar } from "./charts/ShareBar.js";
import { TimeSeriesChart } from "./charts/TimeSeriesChart.js";
import { seriesColor } from "./charts/chart-kit.js";
import {
  GRANULARITY_LABEL, GRANULARITY_NOUN, TOKEN_MIX_LABELS, TOKEN_MIX_ORDER, bucketLabel, formatCost, formatCount, formatCountPrecise,
  formatPercent, formatWholePercent, toNumber, tokenMix,
} from "./usage-format.js";
import { Segmented, StatTile, UsageCard } from "./usage-ui.js";
import { SeriesTable } from "./UsageOverview.js";

function TableToggle({ pressed, onToggle }: { readonly pressed: boolean; readonly onToggle: () => void }) {
  return <Button variant={pressed ? "secondary" : "ghost"} size="icon-sm" aria-pressed={pressed} aria-label="Show as table" title="Show as table" onClick={onToggle}><Table2 /></Button>;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export function UsagePatterns({ data }: { readonly data: UsageAnalyticsResponse }) {
  const [heatMetric, setHeatMetric] = useState<"tokens" | "cost">("tokens");
  const [tables, setTables] = useState<ReadonlySet<string>>(new Set());
  const toggleTable = (id: string) => setTables((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const currency = data.costCurrency;
  const overall = data.timeline.overall;
  const tokens = overall.tokens.map(toNumber);
  const busiest = tokens.reduce((best, value, index) => (value > (tokens[best] ?? 0) ? index : best), 0);
  const active = tokens.filter((value) => value > 0).length;
  const peak = [...data.heatmap].sort((a, b) => toNumber(b.tokens) - toNumber(a.tokens))[0];
  const input = toNumber(data.totals.input), output = toNumber(data.totals.output);

  const mixSeries = useMemo(() => {
    const perBucket = data.buckets.map((_, index) => tokenMix({
      input: toNumber(overall.input[index]), cacheRead: toNumber(overall.cacheRead[index]), cacheWrite: toNumber(overall.cacheWrite[index]),
      output: toNumber(overall.output[index]), reasoning: toNumber(overall.reasoning[index]),
    }));
    return TOKEN_MIX_ORDER.map((part, slot) => ({ id: part, label: TOKEN_MIX_LABELS[part], color: seriesColor(slot), values: perBucket.map((mix) => mix[part]) }));
  }, [data.buckets, overall]);
  const totalMix = tokenMix({ input, cacheRead: toNumber(data.totals.cacheRead), cacheWrite: toNumber(data.totals.cacheWrite), output, reasoning: toNumber(data.totals.reasoning) });
  const ratios = useMemo(() => [
    { id: "cache", label: "Input read from cache", color: seriesColor(0),
      values: data.buckets.map((_, index) => { const value = toNumber(overall.input[index]); return value > 0 ? toNumber(overall.cacheRead[index]) / value : 0; }) },
    { id: "reasoning", label: "Output spent reasoning", color: seriesColor(1),
      values: data.buckets.map((_, index) => { const value = toNumber(overall.output[index]); return value > 0 ? toNumber(overall.reasoning[index]) / value : 0; }) },
  ], [data.buckets, overall]);
  const missingCache = toNumber(data.totals.missing.cacheRead), missingReasoning = toNumber(data.totals.missing.reasoning);
  const records = toNumber(data.totals.increments);

  return (
    <div className="usage-patterns">
      <div className="usage-stats usage-stats-compact">
        <StatTile label={`Busiest ${GRANULARITY_NOUN[data.bucket]}`} value={tokens[busiest] ? formatCountPrecise(tokens[busiest]!) : "—"}
          detail={tokens[busiest] ? bucketLabel(data.buckets[busiest]!, data.bucket) : "No usage"} />
        <StatTile label="Peak hour of the week" value={peak ? `${WEEKDAY_NAMES[peak.weekday]!.slice(0, 3)} ${formatHour(peak.hour)}` : "—"}
          detail={peak ? `${formatCount(peak.tokens)} tokens` : "No timed usage"} />
        <StatTile label={`Average per active ${GRANULARITY_NOUN[data.bucket]}`} value={active ? formatCountPrecise(toNumber(data.totals.tokens) / active) : "—"}
          detail={`${active} of ${data.buckets.length} ${GRANULARITY_NOUN[data.bucket]}s active`} />
        <StatTile label="Cache reuse" value={input > 0 ? formatWholePercent(toNumber(data.totals.cacheRead) / input) : "—"}
          detail="of input read from cache" />
      </div>

      <UsageCard className="usage-card-wide" title="When usage happens"
        subtitle={`Local weekday and hour, ${data.timeZone}. Only usage with a reported or live-observed time.`}
        actions={<>
          <Segmented label="Heatmap metric" value={heatMetric} onChange={setHeatMetric}
            options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} />
          <TableToggle pressed={tables.has("heatmap")} onToggle={() => toggleTable("heatmap")} />
        </>}>
        {tables.has("heatmap") ? <HeatmapTable data={data} metric={heatMetric} /> : (
          <Heatmap label={`${heatMetric === "tokens" ? "Tokens" : "Estimated cost"} by weekday and hour`}
            cells={data.heatmap.map((cell) => ({ weekday: cell.weekday, hour: cell.hour, value: toNumber(heatMetric === "tokens" ? cell.tokens : cell.cost) }))}
            format={(value) => heatMetric === "tokens" ? `${formatCountPrecise(value)} tokens` : formatCost(value, currency)} />
        )}
      </UsageCard>

      <div className="usage-two-column">
        <UsageCard title="Token mix" subtitle="Input and output split into their reported parts.">
          <ShareBar label="Token mix" segments={TOKEN_MIX_ORDER.map((part, slot) => ({
            id: part, label: TOKEN_MIX_LABELS[part], value: totalMix[part], color: seriesColor(slot), display: formatCountPrecise(totalMix[part]),
          }))} />
          {missingCache || missingReasoning ? (
            <p className="usage-footnote">
              {missingCache ? `${formatPercent(missingCache / Math.max(1, records))} of records do not report cache reads; that input counts as uncached. ` : ""}
              {missingReasoning ? `${formatPercent(missingReasoning / Math.max(1, records))} do not report reasoning; that output counts as plain output.` : ""}
            </p>
          ) : null}
        </UsageCard>
        <UsageCard title="Efficiency over time" subtitle={`${GRANULARITY_LABEL[data.bucket]} cache reuse and reasoning share`}
          actions={<TableToggle pressed={tables.has("ratios")} onToggle={() => toggleTable("ratios")} />}>
          {tables.has("ratios") ? <SeriesTable data={data} series={ratios} format={formatPercent} /> : (
            <TimeSeriesChart buckets={data.buckets} granularity={data.bucket} series={ratios} mode="lines" maximum={1} height={180}
              format={formatWholePercent} formatTooltip={formatPercent} ariaLabel="Cache reuse and reasoning share over time" />
          )}
          <ul className="usage-legend" aria-label="Series">
            {ratios.map((entry) => <li key={entry.id}><span className="usage-legend-static"><i data-shape="line" style={{ background: entry.color }} aria-hidden="true" /><span>{entry.label}</span></span></li>)}
          </ul>
        </UsageCard>
      </div>

      <UsageCard className="usage-card-wide" title="Token mix over time" subtitle={`${GRANULARITY_LABEL[data.bucket]} composition of total tokens`}
        actions={<TableToggle pressed={tables.has("mix")} onToggle={() => toggleTable("mix")} />}>
        {tables.has("mix") ? <SeriesTable data={data} series={mixSeries} format={formatCountPrecise} /> : (
          <TimeSeriesChart buckets={data.buckets} granularity={data.bucket} series={mixSeries} mode="bars" format={formatCount}
            formatTooltip={formatCountPrecise} ariaLabel="Token mix over time" />
        )}
        <ul className="usage-legend" aria-label="Series">
          {mixSeries.map((entry) => <li key={entry.id}><span className="usage-legend-static"><i style={{ background: entry.color }} aria-hidden="true" /><span>{entry.label}</span></span></li>)}
        </ul>
      </UsageCard>
    </div>
  );
}

function HeatmapTable({ data, metric }: { readonly data: UsageAnalyticsResponse; readonly metric: "tokens" | "cost" }) {
  const value = (weekday: number, hour: number) => {
    const cell = data.heatmap.find((entry) => entry.weekday === weekday && entry.hour === hour);
    return cell ? toNumber(metric === "tokens" ? cell.tokens : cell.cost) : 0;
  };
  const format = (amount: number) => amount ? (metric === "tokens" ? formatCountPrecise(amount) : formatCost(amount, data.costCurrency)) : "–";
  return (
    <div className="usage-table-scroll usage-series-table">
      <table className="usage-table">
        <thead><tr><th scope="col">Hour</th>{WEEKDAY_NAMES.map((day) => <th key={day} scope="col" className="usage-num">{day.slice(0, 3)}</th>)}</tr></thead>
        <tbody>
          {Array.from({ length: 24 }, (_, hour) => (
            <tr key={hour}><th scope="row">{formatHour(hour)}</th>{WEEKDAY_NAMES.map((day, weekday) => <td key={day} className="usage-num">{format(value(weekday, hour))}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
