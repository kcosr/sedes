import type {
  ProviderPulseAccount,
  ProviderPulseBaselineMetric,
  ProviderPulseWindow,
} from "../../shared/protocol/provider-pulse.js";

export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export type UsageBand = "ok" | "warn" | "low" | "critical" | "unknown";

export function usageBand(remaining: number | undefined): UsageBand {
  if (remaining === undefined) return "unknown";
  if (remaining < 10) return "critical";
  if (remaining < 25) return "low";
  if (remaining < 50) return "warn";
  return "ok";
}

export function weeklyWindow(
  account: ProviderPulseAccount,
): ProviderPulseWindow | undefined {
  const windows = account.usage.snapshot?.windows ?? [];
  return (
    windows.find(
      (window) => window.durationMinutes === WEEKLY_WINDOW_MINUTES,
    ) ?? windows[0]
  );
}

export function remainingPercent(
  window: ProviderPulseWindow | undefined,
): number | undefined {
  if (!window) return undefined;
  if (window.remainingPercent !== undefined) return window.remainingPercent;
  if (window.usedPercent !== undefined) return 100 - window.usedPercent;
  return undefined;
}

export function accountRemainingPercent(
  account: ProviderPulseAccount,
): number | undefined {
  return accountUsageSummary(account).remainingPercent;
}

export function accountUsageSummary(account: ProviderPulseAccount): {
  readonly remainingPercent: number | undefined;
  readonly resetsAt: string | undefined;
} {
  const window = weeklyWindow(account);
  const windowRemaining = remainingPercent(window);
  if (windowRemaining !== undefined) {
    return {
      remainingPercent: windowRemaining,
      resetsAt: window?.resetsAt,
    };
  }
  const balance = account.usage.snapshot?.balances.find(
    (candidate) => candidate.remainingPercent !== undefined,
  );
  return {
    remainingPercent: balance?.remainingPercent,
    resetsAt: balance?.resetsAt,
  };
}

export function accountsByUpcomingReset(
  accounts: readonly ProviderPulseAccount[],
  now = Date.now(),
): ProviderPulseAccount[] {
  return accounts
    .map((account, index) => {
      const resetsAt = accountUsageSummary(account).resetsAt;
      const parsed = resetsAt ? Date.parse(resetsAt) : Number.NaN;
      const group = !Number.isFinite(parsed) ? 2 : parsed >= now ? 0 : 1;
      return { account, group, index, parsed };
    })
    .sort((left, right) => {
      if (left.group !== right.group) return left.group - right.group;
      if (left.group === 0) return left.parsed - right.parsed;
      if (left.group === 1) return right.parsed - left.parsed;
      return left.index - right.index;
    })
    .map(({ account }) => account);
}

export function accountShortLabel(account: ProviderPulseAccount): string {
  const separator = account.label.indexOf("·");
  if (separator >= 0) {
    const short = account.label.slice(separator + 1).trim();
    if (short) return short;
  }
  return account.label;
}

export function relativeTime(
  value: string | undefined,
  now = Date.now(),
): string {
  if (!value) return "not yet";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "not yet";
  const delta = parsed - now;
  const absolute = Math.abs(delta);
  const format = (count: number, unit: Intl.RelativeTimeFormatUnit) =>
    new Intl.RelativeTimeFormat(undefined, {
      numeric: "auto",
      style: "narrow",
    }).format(delta < 0 ? -count : count, unit);
  if (absolute < 60_000)
    return format(Math.max(1, Math.round(absolute / 1_000)), "second");
  if (absolute < 3_600_000)
    return format(Math.round(absolute / 60_000), "minute");
  if (absolute < 86_400_000)
    return format(Math.round(absolute / 3_600_000), "hour");
  return format(Math.round(absolute / 86_400_000), "day");
}

export function resetText(value: string | undefined): string {
  if (!value) return "Reset unavailable";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Reset unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed))}`;
}

export function resetDayLabel(
  value: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const resetDate = new Date(parsed);
  const currentDate = new Date(now);
  if (sameLocalDate(resetDate, currentDate)) return "today";
  const tomorrow = new Date(currentDate);
  tomorrow.setDate(currentDate.getDate() + 1);
  if (sameLocalDate(resetDate, tomorrow)) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(
    resetDate,
  );
}

function sameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function expiryText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return `Next expires ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed))}`;
}

export function baselineFor(
  metrics: readonly ProviderPulseBaselineMetric[],
  accountId: string,
  metricKind: "window" | "balance",
  metricId: string,
): ProviderPulseBaselineMetric | undefined {
  return metrics.find(
    (metric) =>
      metric.accountId === accountId &&
      metric.metricKind === metricKind &&
      metric.metricId === metricId,
  );
}

export function snapshotNote(
  current: number | undefined,
  baseline: ProviderPulseBaselineMetric | undefined,
): string | undefined {
  if (current === undefined || !baseline) return undefined;
  const capturedAt = Date.parse(baseline.capturedAt);
  if (!Number.isFinite(capturedAt)) return undefined;
  const consumed = Math.max(0, baseline.remainingPercent - current);
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(capturedAt));
  if (consumed < 0.1) return `Unchanged since snapshot ${when}`;
  const points =
    consumed < 1 ? consumed.toFixed(1) : String(Math.round(consumed));
  return `${points}% used since ${when}`;
}

export function weekElapsedDays(
  window: ProviderPulseWindow,
  now = Date.now(),
): number | undefined {
  if (window.durationMinutes !== WEEKLY_WINDOW_MINUTES || !window.resetsAt) {
    return undefined;
  }
  const resetAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetAt)) return undefined;
  const duration = WEEKLY_WINDOW_MINUTES * 60_000;
  return Math.max(0, Math.min(7, (duration - (resetAt - now)) / 86_400_000));
}
