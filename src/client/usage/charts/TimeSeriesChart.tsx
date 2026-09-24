import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { UsageAnalyticsBucket } from "../../../shared/protocol/usage-analytics.js";
import { bucketAxisLabel, bucketLabel } from "../usage-format.js";
import { niceTicks, roundedTopRect, useElementWidth } from "./chart-kit.js";

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
}
export interface TimeSeriesChartProps {
  readonly buckets: readonly { start: string; end: string }[];
  readonly granularity: UsageAnalyticsBucket;
  readonly series: readonly ChartSeries[];
  readonly mode: "bars" | "lines";
  readonly format: (value: number) => string;
  readonly formatTooltip?: (value: number) => string;
  readonly ariaLabel: string;
  readonly height?: number;
  readonly showTotal?: boolean;
  /** Fixed axis top, such as 1 for ratios. */
  readonly maximum?: number;
}

const AXIS_HEIGHT = 26;
const TOP = 10;
const GAP = 2;

/** Stacked columns or lines over calendar buckets, with a crosshair readout. */
export function TimeSeriesChart({
  buckets, granularity, series, mode, format, formatTooltip = format, ariaLabel, height = 240, showTotal = true, maximum,
}: TimeSeriesChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const width = useElementWidth(container);
  const [active, setActive] = useState<number | null>(null);
  const count = buckets.length;
  const totals = useMemo(() => buckets.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0)), [buckets, series]);
  const peak = maximum ?? (mode === "bars" ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((entry) => entry.values)));
  const ticks = niceTicks(peak, height < 180 ? 3 : 4);
  const top = ticks.at(-1)!;
  const tickLabels = ticks.map(format);
  const left = Math.max(28, Math.max(...tickLabels.map((label) => label.length)) * 6.6 + 10);
  const right = 8;
  const plotWidth = Math.max(10, width - left - right);
  const slot = plotWidth / Math.max(1, count);
  const y = (value: number) => TOP + height - (top > 0 ? (value / top) * height : 0);
  const barWidth = slot >= 4 ? Math.min(24, Math.max(2, slot * 0.62)) : Math.max(1, slot - 1);
  const center = (index: number) => left + slot * index + slot / 2;
  const labelEvery = Math.max(1, Math.ceil(64 / slot));
  const empty = totals.every((value) => value === 0);

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - bounds.left) / bounds.width) * count);
    setActive(Math.max(0, Math.min(count - 1, index)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? count - 1;
    const next = event.key === "ArrowLeft" ? current - 1 : event.key === "ArrowRight" ? current + 1
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (event.key === "Escape") { setActive(null); return; }
    if (next === null) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(count - 1, next)));
  };

  const bars = mode === "bars" ? buckets.map((_, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    let base = 0;
    const segments: { id: string; color: string; top: number; bottom: number }[] = [];
    for (const entry of series) {
      const value = entry.values[index] ?? 0;
      if (value <= 0) continue;
      segments.push({ id: entry.id, color: entry.color, bottom: y(base), top: y(base + value) });
      base += value;
    }
    return segments.map((segment, position) => {
      const gap = position > 0 ? GAP : 0;
      const segmentHeight = segment.bottom - segment.top - gap;
      if (segmentHeight < 0.75) return null;
      const last = position === segments.length - 1;
      return last
        ? <path key={segment.id} d={roundedTopRect(x, segment.top, barWidth, segmentHeight, 4)} fill={segment.color} />
        : <rect key={segment.id} x={x} y={segment.top} width={barWidth} height={segmentHeight} fill={segment.color} />;
    });
  }) : null;

  const lines = mode === "lines" ? series.map((entry) => {
    const points = entry.values.map((value, index) => `${center(index).toFixed(2)},${y(value).toFixed(2)}`);
    const path = `M${points.join("L")}`;
    const area = series.length === 1 ? `${path}L${center(count - 1).toFixed(2)},${y(0)}L${center(0).toFixed(2)},${y(0)}Z` : null;
    const lastIndex = entry.values.length - 1;
    return (
      <g key={entry.id}>
        {area ? <path d={area} fill={entry.color} opacity={0.1} /> : null}
        <path d={path} fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {count <= 1 || lastIndex < 0 ? null : (
          <circle cx={center(lastIndex)} cy={y(entry.values[lastIndex] ?? 0)} r={4} fill={entry.color} stroke="var(--card)" strokeWidth={2} />
        )}
      </g>
    );
  }) : null;

  const tooltip = active === null || !buckets[active] ? null : (() => {
    const rows = series.map((entry) => ({ entry, value: entry.values[active] ?? 0 })).filter((row) => row.value > 0);
    const visibleRows = mode === "bars" ? [...rows].reverse() : [...rows].sort((a, b) => b.value - a.value);
    const x = center(active);
    const flip = x > width - 230;
    return (
      <div className="usage-chart-tooltip" role="status" style={flip ? { right: width - x + 12 } : { left: x + 12 }}>
        <p className="usage-chart-tooltip-title">{bucketLabel(buckets[active], granularity)}</p>
        {visibleRows.length === 0 ? <p className="usage-chart-tooltip-empty">No recorded usage</p> : (
          <ul>
            {visibleRows.slice(0, 9).map(({ entry, value }) => (
              <li key={entry.id}><i style={{ background: entry.color }} aria-hidden="true" /><strong>{formatTooltip(value)}</strong><span>{entry.label}</span></li>
            ))}
            {visibleRows.length > 9 ? <li className="usage-chart-tooltip-more">+{visibleRows.length - 9} more</li> : null}
          </ul>
        )}
        {showTotal && series.length > 1 && mode === "bars" && visibleRows.length > 1
          ? <p className="usage-chart-tooltip-total"><strong>{formatTooltip(totals[active] ?? 0)}</strong><span>Total</span></p> : null}
      </div>
    );
  })();

  return (
    <div ref={container} className="usage-chart" tabIndex={0} role="group" aria-label={ariaLabel}
      aria-roledescription="chart" onKeyDown={onKeyDown} onFocus={() => setActive((current) => current ?? Math.max(0, count - 1))}
      onBlur={() => setActive(null)}>
      <svg width={width} height={height + TOP + AXIS_HEIGHT} role="img" aria-hidden="true" focusable="false">
        {ticks.map((tick, index) => (
          <g key={tick}>
            <line x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} className={index === 0 ? "usage-chart-baseline" : "usage-chart-grid"} />
            <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="usage-chart-axis">{tickLabels[index]}</text>
          </g>
        ))}
        {active !== null ? (mode === "bars"
          ? <rect x={left + slot * active} y={TOP} width={slot} height={height} className="usage-chart-hover" />
          : <line x1={center(active)} x2={center(active)} y1={TOP} y2={TOP + height} className="usage-chart-crosshair" />) : null}
        {bars}
        {lines}
        {mode === "lines" && active !== null ? series.map((entry) => (
          <circle key={entry.id} cx={center(active)} cy={y(entry.values[active] ?? 0)} r={4} fill={entry.color} stroke="var(--card)" strokeWidth={2} />
        )) : null}
        {buckets.map((bucket, index) => index % labelEvery !== 0 ? null : (
          <text key={bucket.start} x={Math.max(left + 18, Math.min(left + plotWidth - 18, center(index)))} y={TOP + height + 18} textAnchor="middle" className="usage-chart-axis">
            {bucketAxisLabel(bucket.start, granularity, index >= labelEvery ? buckets[index - labelEvery]?.start : undefined)}
          </text>
        ))}
        <rect x={left} y={TOP} width={plotWidth} height={height} fill="transparent" onPointerMove={pick} onPointerDown={pick}
          onPointerLeave={() => setActive(null)} />
      </svg>
      {empty ? <p className="usage-chart-empty">No placed usage in this range</p> : null}
      {tooltip}
    </div>
  );
}
