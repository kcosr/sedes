/**
 * One date format for every app: relative text in lists, the absolute date
 * and time in the `title`. Browser time zone, en-US wording.
 */
import { useSyncExternalStore } from "react";

export type DateLike = string | number | Date;

const LOCALE = "en-US";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parse to a valid Date, or null for empty/invalid input. */
export function toDate(value: DateLike | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Reused formatters: building an Intl.DateTimeFormat per call is slow in long lists.
const F_DATE = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
});
const F_DATE_Y = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const F_TIME = new Intl.DateTimeFormat(LOCALE, {
  hour: "numeric",
  minute: "2-digit",
});
const F_TIME_S = new Intl.DateTimeFormat(LOCALE, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const NUMBER = new Intl.NumberFormat(LOCALE);

/** "Sep 27" in the current year, "Sep 27, 2025" otherwise. */
export function formatDate(
  value: DateLike,
  now: DateLike = Date.now(),
): string {
  const d = toDate(value);
  if (!d) return "";
  const n = toDate(now) ?? new Date();
  return d.getFullYear() === n.getFullYear()
    ? F_DATE.format(d)
    : F_DATE_Y.format(d);
}

/** "7:45 PM" (or "7:45:12 PM" with seconds). */
export function formatTime(
  value: DateLike,
  options: { seconds?: boolean } = {},
): string {
  const d = toDate(value);
  if (!d) return "";
  return (options.seconds ? F_TIME_S : F_TIME).format(d);
}

/** "Sep 27, 2026, 7:45 PM" (or with seconds). */
export function formatDateTime(
  value: DateLike,
  options: { seconds?: boolean } = {},
): string {
  const d = toDate(value);
  if (!d) return "";
  return `${F_DATE_Y.format(d)}, ${formatTime(d, options)}`;
}

/**
 * Compact relative time: "just now", "5m ago", "3h ago", "2d ago", "3w ago",
 * "4mo ago", "2y ago"; "in 5m" for the future. Anything within a minute
 * either way is "just now": the shared clock ticks every 30 s and server
 * clocks skew, so a row that just arrived must not read "in a moment".
 */
export function formatRelative(
  value: DateLike,
  now: DateLike = Date.now(),
): string {
  const d = toDate(value);
  const n = toDate(now);
  if (!d || !n) return "";
  const diff = n.getTime() - d.getTime();
  const future = diff < 0;
  const m = Math.abs(diff) / MINUTE;
  if (m < 1) return "just now";
  let text: string;
  if (m < 60) text = `${Math.round(m)}m`;
  else if (m < 60 * 24) text = `${Math.round(m / 60)}h`;
  else {
    const days = m / (60 * 24);
    if (days < 7) text = `${Math.round(days)}d`;
    else if (days < 30) text = `${Math.round(days / 7)}w`;
    else if (days < 365) text = `${Math.max(1, Math.round(days / 30))}mo`;
    else text = `${Math.round(days / 365)}y`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

/** Duration: "850 ms", "12 s", "4 min", "26 h", "3.2 days". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < MINUTE) return `${(ms / 1000).toFixed(a < 10_000 ? 1 : 0)} s`;
  if (a < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (a < 36 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${(ms / DAY).toFixed(1)} days`;
}

export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Byte sizes, always with an abbreviated unit so size columns stay narrow:
 * "512 B", "1,004 B", "3.4 KB", "840 KB", "1.2 GB" (1024-based; one decimal
 * below 10, whole numbers above).
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 1024) return `${formatNumber(Math.round(n))} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let v = n / 1024;
  let i = 0;
  // 1023.9 KB reads "1.0 MB", not "1,024 KB".
  while (Math.abs(v) >= 1023.5 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = Math.abs(v) < 10 ? v.toFixed(1) : formatNumber(Math.round(v));
  return `${text} ${units[i] ?? "TB"}`;
}

// ---- a shared clock so relative times refresh without a timer per row

const TICK = 30_000;
const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function readClock(): number {
  const t = Date.now();
  if (t - clockNow >= TICK) clockNow = t;
  return clockNow;
}

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, TICK);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** Current time in ms, re-rendering every 30 s (shared timer). */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}
