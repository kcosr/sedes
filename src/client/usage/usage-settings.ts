import {
  USAGE_ANALYTICS_DIMENSIONS, USAGE_ANALYTICS_MAX_FILTER_VALUES, USAGE_ANALYTICS_POINT_METRICS,
  type UsageAnalyticsBucket, type UsageAnalyticsDimension, type UsageAnalyticsFilters,
} from "../../shared/protocol/usage-analytics.js";
import type { UsageMetric } from "./usage-format.js";

export const RANGE_PRESETS = [
  { id: "today", label: "Today" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "thisYear", label: "This year" },
  { id: "all", label: "All time" },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["id"] | "custom";
export const USAGE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "explore", label: "Explore" },
  { id: "threads", label: "Threads" },
  { id: "patterns", label: "Patterns" },
  { id: "coverage", label: "Coverage" },
] as const;
export type UsageTab = (typeof USAGE_TABS)[number]["id"];
export type ChartMode = "bars" | "lines";

export interface UsageViewSettings {
  readonly preset: RangePreset;
  /** Local calendar dates (YYYY-MM-DD), inclusive, for the custom range. */
  readonly customFrom: string | null;
  readonly customTo: string | null;
  readonly bucket: UsageAnalyticsBucket | "auto";
  readonly metric: UsageMetric;
  readonly groupBy: UsageAnalyticsDimension | null;
  readonly chart: ChartMode;
  readonly tab: UsageTab;
  readonly exploreRows: UsageAnalyticsDimension;
  readonly exploreColumns: UsageAnalyticsDimension | null;
}
export const DEFAULT_USAGE_SETTINGS: UsageViewSettings = {
  preset: "30d", customFrom: null, customTo: null, bucket: "auto", metric: "tokens", groupBy: "model",
  chart: "bars", tab: "overview", exploreRows: "model", exploreColumns: null,
};

const STORAGE_KEY = "sedes-usage-view-v1";
const isDimension = (value: unknown): value is UsageAnalyticsDimension => typeof value === "string" && (USAGE_ANALYTICS_DIMENSIONS as readonly string[]).includes(value);
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Filters are page-session state; only presentation preferences persist. */
export function readUsageSettings(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): UsageViewSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_USAGE_SETTINGS;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pick = <T>(candidate: unknown, valid: (value: unknown) => value is T, fallback: T): T => valid(candidate) ? candidate : fallback;
    return {
      preset: pick(value.preset, (v): v is RangePreset => v === "custom" || RANGE_PRESETS.some((p) => p.id === v), DEFAULT_USAGE_SETTINGS.preset),
      customFrom: isDate(value.customFrom) ? value.customFrom : null,
      customTo: isDate(value.customTo) ? value.customTo : null,
      bucket: pick(value.bucket, (v): v is UsageViewSettings["bucket"] => ["auto", "hour", "day", "week", "month"].includes(v as string), "auto"),
      metric: pick(value.metric, (v): v is UsageMetric => (USAGE_ANALYTICS_POINT_METRICS as readonly unknown[]).includes(v), "tokens"),
      groupBy: value.groupBy === null ? null : pick(value.groupBy, isDimension, DEFAULT_USAGE_SETTINGS.groupBy),
      chart: value.chart === "lines" ? "lines" : "bars",
      tab: pick(value.tab, (v): v is UsageTab => USAGE_TABS.some((tab) => tab.id === v), "overview"),
      exploreRows: pick(value.exploreRows, isDimension, DEFAULT_USAGE_SETTINGS.exploreRows),
      exploreColumns: value.exploreColumns === null ? null : pick(value.exploreColumns, isDimension, null),
    };
  } catch { return DEFAULT_USAGE_SETTINGS; }
}
export function writeUsageSettings(settings: UsageViewSettings, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Preferences are best effort. */ }
}

const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const parseLocalDate = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
};
export const localDateInput = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export interface ResolvedRange { readonly from: Date | null; readonly to: Date; readonly label: string }
/** Resolve a preset in the browser's local calendar. Ranges ending now are recomputed on refresh. */
export function resolveRange(settings: Pick<UsageViewSettings, "preset" | "customFrom" | "customTo">, now = new Date()): ResolvedRange {
  const today = startOfDay(now);
  const days = (count: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - count);
  const label = RANGE_PRESETS.find((preset) => preset.id === settings.preset)?.label ?? "Custom range";
  switch (settings.preset) {
    case "today": return { from: today, to: now, label };
    case "24h": return { from: new Date(now.getTime() - 86_400_000), to: now, label };
    case "7d": return { from: days(6), to: now, label };
    case "30d": return { from: days(29), to: now, label };
    case "90d": return { from: days(89), to: now, label };
    case "thisMonth": return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: now, label };
    case "lastMonth": return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1), label };
    case "thisYear": return { from: new Date(today.getFullYear(), 0, 1), to: now, label };
    case "all": return { from: null, to: now, label };
    case "custom": {
      const from = settings.customFrom ? parseLocalDate(settings.customFrom) : days(29);
      const through = settings.customTo ? parseLocalDate(settings.customTo) : today;
      const end = new Date(through.getFullYear(), through.getMonth(), through.getDate() + 1);
      const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: from.getFullYear() === through.getFullYear() ? undefined : "numeric" });
      return { from, to: end > from ? end : new Date(from.getTime() + 86_400_000), label: `${format.format(from)} – ${format.format(through)}` };
    }
  }
}

export type UsageFilterState = UsageAnalyticsFilters;
export function toggleFilter(filters: UsageFilterState, dimension: UsageAnalyticsDimension, key: string | null): UsageFilterState {
  const current = filters[dimension] ?? [];
  if (!current.includes(key) && current.length >= USAGE_ANALYTICS_MAX_FILTER_VALUES) return filters;
  const next = current.includes(key) ? current.filter((value) => value !== key) : [...current, key];
  const { [dimension]: _removed, ...rest } = filters;
  return next.length ? { ...rest, [dimension]: next } : rest;
}
export function activeFilterCount(filters: UsageFilterState): number {
  return Object.values(filters).reduce((count, values) => count + (values?.length ?? 0), 0);
}
