import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Validated eight-slot categorical palette (light and dark steps defined in
 * usage.css). Slot order is the colorblind-safety mechanism; never cycle it.
 */
export const SERIES_SLOTS = 8;
export const seriesColor = (slot: number): string => `var(--usage-series-${slot + 1})`;
export const OTHER_COLOR = "var(--usage-other)";
export const UNKNOWN_COLOR = "var(--usage-unknown)";

/**
 * Assign colors by the server's filter-independent all-time order, so a
 * series keeps its color when filters or ranges change. Keys outside that
 * order take the first free slot; unknown and Other stay neutral.
 */
export function assignSeriesColors(
  series: readonly { key: string | null; other: boolean }[], colorOrder: readonly (string | null)[],
): string[] {
  const ranked = colorOrder.filter((key): key is string => key !== null);
  const used = new Set<number>();
  const slots = series.map((entry) => {
    if (entry.other || entry.key === null) return -1;
    const slot = ranked.indexOf(entry.key);
    if (slot >= 0 && slot < SERIES_SLOTS) { used.add(slot); return slot; }
    return -2;
  });
  return series.map((entry, index) => {
    if (entry.other) return OTHER_COLOR;
    if (entry.key === null) return UNKNOWN_COLOR;
    let slot = slots[index]!;
    if (slot === -2) {
      slot = [...Array(SERIES_SLOTS).keys()].find((candidate) => !used.has(candidate)) ?? -1;
      if (slot >= 0) used.add(slot);
    }
    return slot >= 0 ? seriesColor(slot) : OTHER_COLOR;
  });
}

/** Round axis maximum and evenly spaced ticks. */
export function niceTicks(maximum: number, count = 4): number[] {
  if (!(maximum > 0)) return [0, 1];
  const rough = maximum / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const top = Math.ceil(maximum / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** Content width of an element, tracked with ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => { const next = Math.round(element.getBoundingClientRect().width); if (next > 0) setWidth(next); };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Path for a column with rounded data-end corners and a square baseline. */
export function roundedTopRect(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}
/** Path for a horizontal bar with a rounded data end on the right. */
export function roundedRightRect(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, height / 2, width));
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
}
