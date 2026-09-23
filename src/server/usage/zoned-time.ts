import { DomainError } from "../domain/errors.js";
import { USAGE_ANALYTICS_MAX_BUCKETS, type UsageAnalyticsBucket } from "../../shared/protocol/usage-analytics.js";

export interface LocalTime { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly weekday: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = {Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6};

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat("en-US", {timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", weekday: "short"});
    } catch { throw new DomainError("bad_request", "The time zone is not recognized."); }
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone, value);
  }
  return value;
}
export function assertTimeZone(timeZone: string): void { formatter(timeZone); }

/** Wall-clock fields of an instant in an IANA zone; weekday 0 is Monday. */
export function localTime(instant: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday!]!};
}

/**
 * The first instant whose wall clock is at or after the given local fields.
 * Nonexistent local times (spring-forward gaps) resolve to the transition.
 */
export function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const shown = (instant: number): number => {
    const local = localTime(instant, timeZone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  };
  let guess = wall - (shown(wall) - wall);
  guess = wall - (shown(guess) - guess);
  // Every zone offset is a multiple of 15 minutes. Skipped wall times move
  // forward to the transition; repeated ones resolve to their first instant.
  const step = 900_000;
  for (let limit = 0; limit < 16 && shown(guess) < wall; limit += 1) guess += step;
  for (let limit = 0; limit < 16 && shown(guess - step) >= wall; limit += 1) guess -= step;
  return guess;
}

function startOf(bucket: UsageAnalyticsBucket, instant: number, timeZone: string): number {
  const local = localTime(instant, timeZone);
  if (bucket === "hour") return zonedInstant(local.year, local.month, local.day, local.hour, timeZone);
  if (bucket === "day") return zonedInstant(local.year, local.month, local.day, 0, timeZone);
  if (bucket === "month") return zonedInstant(local.year, local.month, 1, 0, timeZone);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day - local.weekday));
  return zonedInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, timeZone);
}
function next(bucket: UsageAnalyticsBucket, start: number, timeZone: string): number {
  const local = localTime(start, timeZone);
  if (bucket === "hour") {
    // Step in UTC so repeated fall-back hours remain distinct buckets.
    return start + 3_600_000;
  }
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (bucket === "day") date.setUTCDate(date.getUTCDate() + 1);
  else if (bucket === "week") date.setUTCDate(date.getUTCDate() + 7);
  else date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return zonedInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, timeZone);
}

const HOUR = 3_600_000, DAY = 86_400_000;
export function automaticBucket(from: number, to: number): UsageAnalyticsBucket {
  const span = to - from;
  return span <= 3 * DAY ? "hour" : span <= 93 * DAY ? "day" : span <= 2 * 366 * DAY ? "week" : "month";
}
const ORDER: readonly UsageAnalyticsBucket[] = ["hour", "day", "week", "month"];
function estimate(bucket: UsageAnalyticsBucket, span: number): number {
  return span / (bucket === "hour" ? HOUR : bucket === "day" ? DAY : bucket === "week" ? 7 * DAY : 28 * DAY);
}

/** Calendar buckets covering [from, to) in the zone, coarsened to stay within the bucket cap. */
export function zonedBuckets(from: number, to: number, requested: UsageAnalyticsBucket | "auto", timeZone: string): {
  bucket: UsageAnalyticsBucket; buckets: {start: number; end: number}[];
} {
  let bucket = requested === "auto" ? automaticBucket(from, to) : requested;
  while (bucket !== "month" && estimate(bucket, to - from) > USAGE_ANALYTICS_MAX_BUCKETS - 2) bucket = ORDER[ORDER.indexOf(bucket) + 1]!;
  const buckets: {start: number; end: number}[] = [];
  for (let start = startOf(bucket, from, timeZone); start < to; ) {
    const end = next(bucket, start, timeZone);
    buckets.push({start, end});
    if (buckets.length > USAGE_ANALYTICS_MAX_BUCKETS) throw new DomainError("bad_request", "The range is too long for the selected granularity.");
    start = end;
  }
  return {bucket, buckets};
}
