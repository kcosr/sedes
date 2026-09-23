import type { BackendBrand } from "../../shared/protocol/conversation.js";
import type {
  UsageAnalyticsAggregate, UsageAnalyticsBucket, UsageAnalyticsDimension, UsageAnalyticsPointMetric, UsageAnalyticsResponse,
} from "../../shared/protocol/usage-analytics.js";

export type UsageMetric = UsageAnalyticsPointMetric;

export const DIMENSION_META: Readonly<Record<UsageAnalyticsDimension, { label: string; plural: string; unknown: string }>> = {
  model: { label: "Model", plural: "Models", unknown: "Unknown model" },
  provider: { label: "Provider", plural: "Providers", unknown: "Unknown provider" },
  backend: { label: "Backend", plural: "Backends", unknown: "Unknown backend" },
  backendKind: { label: "Backend type", plural: "Backend types", unknown: "Unknown type" },
  environment: { label: "Environment", plural: "Environments", unknown: "Unknown environment" },
  workspace: { label: "Project", plural: "Projects", unknown: "Unknown project" },
  effort: { label: "Reasoning effort", plural: "Reasoning effort", unknown: "Not recorded" },
  thread: { label: "Thread", plural: "Threads", unknown: "Unknown thread" },
  agentRole: { label: "Agent", plural: "Agents", unknown: "Unknown agent" },
  activity: { label: "Activity", plural: "Activities", unknown: "Unknown activity" },
};
/** Display order for dimension pickers. */
export const DIMENSION_ORDER: readonly UsageAnalyticsDimension[] = [
  "model", "provider", "effort", "backend", "backendKind", "environment", "workspace", "thread", "agentRole", "activity",
];

export const METRIC_META: Readonly<Record<UsageMetric, { label: string; short: string; description: string }>> = {
  tokens: { label: "Total tokens", short: "Tokens", description: "Input, including cache, plus output." },
  cost: { label: "Estimated cost", short: "Cost", description: "Provider or SDK estimates where reported; not an invoice." },
  input: { label: "Input tokens", short: "Input", description: "All input, including cache reads and writes." },
  output: { label: "Output tokens", short: "Output", description: "All output, including reasoning." },
  cacheRead: { label: "Cache read", short: "Cache read", description: "Input served from the provider's prompt cache." },
  cacheWrite: { label: "Cache write", short: "Cache write", description: "Input written to the provider's prompt cache." },
  reasoning: { label: "Reasoning tokens", short: "Reasoning", description: "Output spent on reasoning, where reported." },
  requests: { label: "Model requests", short: "Requests", description: "Counted only where the source reports requests." },
};
export const METRIC_ORDER: readonly UsageMetric[] = ["tokens", "cost", "input", "output", "cacheRead", "cacheWrite", "reasoning", "requests"];

const BACKEND_KINDS: Readonly<Record<string, { label: string; brand: BackendBrand }>> = {
  pi: { label: "Pi", brand: "pi" },
  codex_app_server: { label: "Codex", brand: "codex" },
  claude_agent_sdk: { label: "Claude", brand: "claude" },
  grok_build: { label: "Grok", brand: "grok" },
};
const PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic", firstParty: "Anthropic API", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry", anthropicAws: "Anthropic on AWS", gateway: "Gateway", openai: "OpenAI", "openai-codex": "OpenAI Codex",
  google: "Google", "google-vertex": "Google Vertex AI", xai: "xAI", openrouter: "OpenRouter", mistral: "Mistral", groq: "Groq",
  deepseek: "DeepSeek", ollama: "Ollama", "azure-openai": "Azure OpenAI", "github-copilot": "GitHub Copilot",
};
/** Native effort levels from least to most; unrecognized levels sort after them. */
export const EFFORT_ORDER: readonly string[] = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "\u2205"];
const EFFORTS: Readonly<Record<string, string>> = {
  off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};
const ACTIVITIES: Readonly<Record<string, string>> = {
  model: "Model calls", tool: "Tool results", compaction: "Compaction", branch_summary: "Branch summaries",
  cache_warming: "Cache warming", auxiliary: "Other activity",
};

export interface DimensionLabel {
  readonly label: string;
  readonly detail: string | null;
  readonly brand: BackendBrand | undefined;
  readonly retired: boolean;
  readonly unknown: boolean;
}

export function backendKindBrand(kind: string | null | undefined): BackendBrand | undefined {
  return kind ? BACKEND_KINDS[kind]?.brand : undefined;
}

export function dimensionLabel(
  labels: UsageAnalyticsResponse["labels"] | undefined, dimension: UsageAnalyticsDimension, key: string | null,
): DimensionLabel {
  const plain = (label: string, extra: Partial<DimensionLabel> = {}): DimensionLabel =>
    ({ label, detail: null, brand: undefined, retired: false, unknown: false, ...extra });
  if (key === null) return plain(DIMENSION_META[dimension].unknown, { unknown: true });
  const known = labels?.[dimension][key];
  switch (dimension) {
    case "backendKind": return plain(BACKEND_KINDS[key]?.label ?? key, { brand: backendKindBrand(key) });
    case "provider": return plain(PROVIDERS[key] ?? key);
    case "effort": return plain(EFFORTS[key] ?? key.charAt(0).toUpperCase() + key.slice(1));
    case "agentRole": return plain(key === "main" ? "Main agent" : key === "subagent" ? "Subagents" : key);
    case "activity": return plain(ACTIVITIES[key] ?? key);
    case "model": return plain(key);
    case "backend": return plain(known?.label ?? "Removed backend", { brand: backendKindBrand(known?.kind), unknown: !known });
    case "environment": return plain(known?.label ?? "Removed environment", { unknown: !known });
    case "workspace": return plain(known?.label ?? "Removed project", { detail: shortenPath(known?.detail ?? null), retired: known?.retired ?? false, unknown: !known });
    case "thread": {
      const project = known?.workspaceId ? labels?.workspace[known.workspaceId]?.label ?? null : null;
      return plain(known?.label ?? "Removed thread", { detail: project, brand: backendKindBrand(known?.kind), retired: known?.retired ?? false, unknown: !known });
    }
  }
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compactPrecise = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const wholePercent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

export const toNumber = (value: string | number | null | undefined): number => value === null || value === undefined ? 0 : Number(value);

export function formatCount(value: string | number): string {
  const number = toNumber(value);
  return Math.abs(number) >= 10_000 ? compact.format(number) : integer.format(number);
}
export function formatCountPrecise(value: string | number): string {
  const number = toNumber(value);
  return Math.abs(number) >= 1_000_000 ? compactPrecise.format(number) : integer.format(number);
}
export const formatExact = (value: string | number): string => integer.format(toNumber(value));

const currencyFormats = new Map<string, Intl.NumberFormat[]>();
/** Two decimals for ordinary amounts; small estimates keep two significant digits instead of rounding to zero. */
export function formatCost(amount: string | number, currency = "USD"): string {
  const value = toNumber(amount);
  let formats = currencyFormats.get(currency);
  if (!formats) {
    formats = [
      new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      new Intl.NumberFormat(undefined, { style: "currency", currency, maximumSignificantDigits: 2 }),
      new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }),
    ];
    currencyFormats.set(currency, formats);
  }
  if (value !== 0 && Math.abs(value) < 0.01) return formats[1]!.format(value);
  return Math.abs(value) >= 100_000 ? formats[2]!.format(value) : formats[0]!.format(value);
}
export const formatPercent = (ratio: number): string => percent.format(ratio);
export const formatWholePercent = (ratio: number): string => wholePercent.format(ratio);

/** "Environment · /a/b/c/d" keeps the environment and the last two path segments. */
function shortenPath(detail: string | null): string | null {
  if (!detail) return detail;
  const separator = detail.lastIndexOf(" · ");
  const prefix = separator >= 0 ? detail.slice(0, separator + 3) : "";
  const path = separator >= 0 ? detail.slice(separator + 3) : detail;
  const segments = path.split("/").filter(Boolean);
  return segments.length > 2 ? `${prefix}…/${segments.slice(-2).join("/")}` : detail;
}

/** False when no record in the aggregate reported the metric; a dash, never zero. */
export function metricReported(aggregate: UsageAnalyticsAggregate, metric: string): boolean {
  const increments = toNumber(aggregate.increments);
  if (metric === "cost") return aggregate.costs.length > 0;
  const missing = (aggregate.missing as Record<string, string>)[metric];
  return missing === undefined || increments === 0 || toNumber(missing) < increments;
}

/** The aggregate's value for a metric, in the primary cost currency for cost. */
export function metricValue(aggregate: UsageAnalyticsAggregate, metric: UsageMetric, currency: string): number {
  if (metric === "cost") return toNumber(aggregate.costs.find((cost) => cost.currency === currency)?.amount ?? 0);
  return toNumber(aggregate[metric]);
}
export function formatMetric(value: number, metric: UsageMetric, currency: string, precise = false): string {
  if (metric === "cost") return formatCost(value, currency);
  return precise ? formatCountPrecise(value) : formatCount(value);
}

/** Relative change against the previous equal period; null when there is no base. */
export function relativeChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const longMonthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Compact axis label for a bucket start. */
export function bucketAxisLabel(start: string, bucket: UsageAnalyticsBucket, previousStart?: string): string {
  const date = new Date(start);
  if (bucket === "hour") {
    const previous = previousStart ? new Date(previousStart) : null;
    return !previous || previous.toDateString() !== date.toDateString() ? dayFormat.format(date) : hourFormat.format(date);
  }
  if (bucket === "month") return monthFormat.format(date);
  return dayFormat.format(date);
}
/** Full label for tooltips and tables. */
export function bucketLabel(bucket: { start: string; end: string }, granularity: UsageAnalyticsBucket): string {
  const start = new Date(bucket.start), end = new Date(bucket.end);
  if (granularity === "hour") return `${weekdayFormat.format(start)}, ${timeFormat.format(start)}–${timeFormat.format(end)}`;
  if (granularity === "day") return longDayFormat.format(start);
  if (granularity === "week") return `Week of ${dayFormat.format(start)}`;
  return longMonthFormat.format(start);
}
export const GRANULARITY_LABEL: Readonly<Record<UsageAnalyticsBucket, string>> = { hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly" };
export const GRANULARITY_NOUN: Readonly<Record<UsageAnalyticsBucket, string>> = { hour: "hour", day: "day", week: "week", month: "month" };

export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** Token composition that partitions input + output where components are reported. */
export interface TokenMix { uncached: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
export function tokenMix(values: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }): TokenMix {
  const reasoning = Math.min(values.reasoning, values.output);
  const cacheRead = Math.min(values.cacheRead, values.input);
  const cacheWrite = Math.min(values.cacheWrite, values.input - cacheRead);
  return { uncached: Math.max(0, values.input - cacheRead - cacheWrite), cacheRead, cacheWrite, output: Math.max(0, values.output - reasoning), reasoning };
}
export const TOKEN_MIX_LABELS: Readonly<Record<keyof TokenMix, string>> = {
  uncached: "Uncached input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning",
};
export const TOKEN_MIX_ORDER: readonly (keyof TokenMix)[] = ["uncached", "cacheRead", "cacheWrite", "output", "reasoning"];
