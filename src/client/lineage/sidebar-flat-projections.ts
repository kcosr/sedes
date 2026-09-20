import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import {
  resolveModePreferences,
  sidebarEffectiveTimestamp,
  type SidebarFlatGroup,
  type SidebarModePreferences,
  type SidebarShowFilters,
  type SidebarViewPreferences,
} from "../app/sidebar-view-model.js";

/**
 * Pure projectors for the flat sidebar group modes (`time` / `state` /
 * `none`). The `project` mode keeps using `deriveSidebarLineage`; here fork
 * families flatten on purpose — nesting would drag children out of their true
 * buckets. No DOM, no clocks: callers pass `now`. User-visible behavior is
 * documented in docs/user/organize-work.md#choose-a-sidebar-organization.
 */

export type SidebarFlatMode = "time" | "state" | "none";

type ThreadComparator = (
  left: NormalizedApplicationThreadSummary,
  right: NormalizedApplicationThreadSummary,
) => number;

/** Run states that count as "currently running" for bucket membership. */
const ACTIVE_RUN_STATES: ReadonlySet<
  NormalizedApplicationThreadSummary["runState"]
> = new Set(["running", "starting", "stopping", "reconciling"]);

export function projectSidebarFlatGroups(
  mode: SidebarFlatMode,
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarViewPreferences,
  now: number,
): SidebarFlatGroup[] {
  const visible = filterSidebarThreads(threads, preferences.show);
  const modePreferences = resolveModePreferences(preferences, mode);
  const pinned = visible.filter((thread) => thread.pinned);
  if (modePreferences.pinnedOnly) {
    return projectPinned(pinned, modePreferences);
  }
  const ordinary = visible.filter((thread) => !thread.pinned);
  const pinnedGroup = projectPinned(pinned, modePreferences);
  switch (mode) {
    case "time": {
      const { rest, settled } = partitionSettled(ordinary);
      return [
        ...pinnedGroup,
        ...projectTimeline(rest, modePreferences, now),
        ...projectSettled(settled, modePreferences),
      ];
    }
    case "state":
      return [...pinnedGroup, ...projectState(ordinary, modePreferences)];
    case "none": {
      const { rest, settled } = partitionSettled(ordinary);
      return [
        ...pinnedGroup,
        ...projectAll(rest, modePreferences),
        ...projectSettled(settled, modePreferences),
      ];
    }
  }
}

function projectPinned(
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarModePreferences,
): SidebarFlatGroup[] {
  if (threads.length === 0) return [];
  return [
    {
      key: "pinned",
      label: "Pinned",
      kind: "pinned",
      futureTimes: false,
      threads: [...threads].sort(compareBySortAxis(preferences)),
    },
  ];
}

/**
 * Timeline and Flat list park unpinned settled threads below the working
 * set. State already has its own Settled bucket, including precedence that
 * can keep a settled thread in Needs attention, so it is left alone.
 */
function partitionSettled(
  threads: readonly NormalizedApplicationThreadSummary[],
): {
  readonly rest: readonly NormalizedApplicationThreadSummary[];
  readonly settled: readonly NormalizedApplicationThreadSummary[];
} {
  const rest: NormalizedApplicationThreadSummary[] = [];
  const settled: NormalizedApplicationThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.inventoryState === "settled") settled.push(thread);
    else rest.push(thread);
  }
  return { rest, settled };
}

function projectSettled(
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarModePreferences,
): SidebarFlatGroup[] {
  if (threads.length === 0) return [];
  return [
    {
      key: "settled",
      label: "Settled",
      kind: "settled",
      futureTimes: false,
      threads: [...threads].sort(compareBySortAxis(preferences)),
    },
  ];
}

/**
 * The global Show filters, applied before any grouping: archived threads stay
 * on their own page; snoozed, settled, and unbound drafts are opt-out.
 */
export function filterSidebarThreads(
  threads: readonly NormalizedApplicationThreadSummary[],
  show: SidebarShowFilters,
): readonly NormalizedApplicationThreadSummary[] {
  return threads.filter((thread) => {
    if (thread.inventoryState === "archived") return false;
    if (!show.snoozed && thread.inventoryState === "snoozed") return false;
    if (!show.settled && thread.inventoryState === "settled") return false;
    if (!show.drafts && thread.backingState === "unbound") return false;
    return true;
  });
}

/**
 * Upcoming holds dormant future items only: snoozed threads (with or without
 * a wake time) and enabled automations with a next run that are not currently
 * running — a running automation belongs to Today. Paused automations (or
 * enabled without nextRunAt) flow into time buckets instead.
 */
export function isUpcomingThread(
  thread: NormalizedApplicationThreadSummary,
): boolean {
  if (thread.inventoryState === "snoozed") return true;
  return (
    thread.automation !== null &&
    thread.automation.status === "enabled" &&
    thread.automation.nextRunAt !== undefined &&
    !ACTIVE_RUN_STATES.has(thread.runState)
  );
}

/**
 * The wake / next-run instant that orders future-times groups (Upcoming,
 * Scheduled, Snoozed). Undefined — a snoozed thread without a wake — sorts
 * after every dated entry.
 */
export function sidebarWakeTimestamp(
  thread: NormalizedApplicationThreadSummary,
): number | undefined {
  const nextRunAt =
    thread.automation !== null && thread.automation.status === "enabled"
      ? thread.automation.nextRunAt
      : undefined;
  const wake =
    thread.inventoryState === "snoozed"
      ? (thread.snoozedUntil ?? nextRunAt)
      : nextRunAt;
  if (wake === undefined) return undefined;
  const parsed = Date.parse(wake);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface SidebarTimeBucket {
  readonly key: string;
  readonly label: string;
  /** Position after Upcoming; lower renders first (most recent first). */
  readonly order: number;
}

/**
 * Top-down time bucket resolution on the effective timestamp, local time,
 * weeks starting Monday. Timestamps at or past the start of today (including
 * clock skew into the future) clamp into Today.
 */
export function resolveTimeBucket(
  timestamp: number,
  now: number,
): SidebarTimeBucket {
  const reference = new Date(now);
  if (timestamp >= startOfDay(reference).getTime()) {
    return { key: "today", label: "Today", order: 0 };
  }
  if (timestamp >= shiftDays(reference, -1).getTime()) {
    return { key: "yesterday", label: "Yesterday", order: 1 };
  }
  const weekStart = startOfWeek(reference);
  if (timestamp >= weekStart.getTime()) {
    return { key: "this-week", label: "This week", order: 2 };
  }
  if (timestamp >= shiftDays(weekStart, -7).getTime()) {
    return { key: "last-week", label: "Last week", order: 3 };
  }
  const monthStart = new Date(reference.getFullYear(), reference.getMonth(), 1);
  if (timestamp >= monthStart.getTime()) {
    return { key: "earlier-this-month", label: "Earlier this month", order: 4 };
  }
  const moment = new Date(timestamp);
  if (moment.getFullYear() === reference.getFullYear()) {
    return {
      key: `month-${moment.getMonth()}`,
      label: moment.toLocaleDateString(undefined, { month: "long" }),
      order: 5 + (reference.getMonth() - moment.getMonth()),
    };
  }
  return {
    key: `year-${moment.getFullYear()}`,
    label: String(moment.getFullYear()),
    order: 1_000 + (reference.getFullYear() - moment.getFullYear()),
  };
}

export type SidebarStateBucketKey =
  "needs-attention" | "running" | "scheduled" | "snoozed" | "settled" | "idle";

/** State-mode bucket by precedence; first match wins, each thread once. */
export function resolveStateBucket(
  thread: NormalizedApplicationThreadSummary,
): SidebarStateBucketKey {
  if (
    thread.runState === "failed" ||
    thread.runState === "waiting_for_input" ||
    thread.runState === "waiting_for_approval" ||
    thread.pendingQuestionCount > 0 ||
    thread.attention.queueFailure ||
    thread.attention.wake ||
    thread.attention.automationContext === "failed" ||
    thread.automation?.lastRun?.state === "failed"
  ) {
    return "needs-attention";
  }
  if (ACTIVE_RUN_STATES.has(thread.runState)) return "running";
  if (
    thread.automation !== null &&
    thread.automation.status === "enabled" &&
    thread.automation.nextRunAt !== undefined
  ) {
    return "scheduled";
  }
  if (thread.inventoryState === "snoozed") return "snoozed";
  if (thread.inventoryState === "settled") return "settled";
  return "idle";
}

const STATE_BUCKETS: readonly {
  readonly key: SidebarStateBucketKey;
  readonly label: string;
  readonly futureTimes: boolean;
}[] = [
  { key: "needs-attention", label: "Needs attention", futureTimes: false },
  { key: "running", label: "Running", futureTimes: false },
  { key: "scheduled", label: "Scheduled", futureTimes: true },
  { key: "idle", label: "Idle", futureTimes: false },
  { key: "snoozed", label: "Snoozed", futureTimes: true },
  { key: "settled", label: "Settled", futureTimes: false },
];

function projectTimeline(
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarModePreferences,
  now: number,
): SidebarFlatGroup[] {
  const upcoming: NormalizedApplicationThreadSummary[] = [];
  const buckets = new Map<
    string,
    { bucket: SidebarTimeBucket; threads: NormalizedApplicationThreadSummary[] }
  >();
  for (const thread of threads) {
    if (isUpcomingThread(thread)) {
      upcoming.push(thread);
      continue;
    }
    const bucket = resolveTimeBucket(timelineBucketTimestamp(thread, now), now);
    const entry = buckets.get(bucket.key) ?? { bucket, threads: [] };
    entry.threads.push(thread);
    buckets.set(bucket.key, entry);
  }
  const groups: SidebarFlatGroup[] = [];
  if (upcoming.length > 0) {
    groups.push({
      key: "upcoming",
      label: "Upcoming",
      kind: "upcoming",
      futureTimes: true,
      threads: upcoming.sort(compareByWake),
    });
  }
  const compare = compareBySortAxis(preferences);
  const ordered = [...buckets.values()].sort(
    (left, right) => left.bucket.order - right.bucket.order,
  );
  for (const { bucket, threads: members } of ordered) {
    groups.push({
      key: bucket.key,
      label: bucket.label,
      kind: "time",
      futureTimes: false,
      threads: members.sort(compare),
    });
  }
  return groups;
}

/**
 * The instant a thread buckets on in time mode. A running automation belongs
 * to Today even when its activity/state timestamps
 * are stale — run-state transitions need not bump them — so clamp it to
 * `now`. Plain threads keep the effective-timestamp rule while running.
 */
function timelineBucketTimestamp(
  thread: NormalizedApplicationThreadSummary,
  now: number,
): number {
  if (thread.automation !== null && ACTIVE_RUN_STATES.has(thread.runState)) {
    return now;
  }
  return sidebarEffectiveTimestamp(thread);
}

function projectState(
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarModePreferences,
): SidebarFlatGroup[] {
  const members = new Map<
    SidebarStateBucketKey,
    NormalizedApplicationThreadSummary[]
  >();
  for (const thread of threads) {
    const key = resolveStateBucket(thread);
    const bucket = members.get(key) ?? [];
    bucket.push(thread);
    members.set(key, bucket);
  }
  const compare = compareBySortAxis(preferences);
  const groups: SidebarFlatGroup[] = [];
  for (const bucket of STATE_BUCKETS) {
    const bucketThreads = members.get(bucket.key);
    if (!bucketThreads || bucketThreads.length === 0) continue;
    groups.push({
      key: bucket.key,
      label: bucket.label,
      kind: "state",
      futureTimes: bucket.futureTimes,
      threads: bucketThreads.sort(bucket.futureTimes ? compareByWake : compare),
    });
  }
  return groups;
}

function projectAll(
  threads: readonly NormalizedApplicationThreadSummary[],
  preferences: SidebarModePreferences,
): SidebarFlatGroup[] {
  if (threads.length === 0) return [];
  return [
    {
      key: "all",
      label: "All threads",
      kind: "all",
      futureTimes: false,
      threads: [...threads].sort(compareBySortAxis(preferences)),
    },
  ];
}

/**
 * Future-times groups always sort ascending soonest-first regardless of the
 * mode's sort axis; entries without a wake time trail, ties break by id.
 */
function compareByWake(
  left: NormalizedApplicationThreadSummary,
  right: NormalizedApplicationThreadSummary,
): number {
  const leftWake = sidebarWakeTimestamp(left);
  const rightWake = sidebarWakeTimestamp(right);
  if (leftWake === undefined && rightWake !== undefined) return 1;
  if (leftWake !== undefined && rightWake === undefined) return -1;
  if (
    leftWake !== undefined &&
    rightWake !== undefined &&
    leftWake !== rightWake
  ) {
    return leftWake - rightWake;
  }
  return left.id.localeCompare(right.id);
}

function compareBySortAxis(
  preferences: SidebarModePreferences,
): ThreadComparator {
  const direction = preferences.direction === "asc" ? 1 : -1;
  switch (preferences.sortBy) {
    case "activity":
      return (left, right) =>
        direction *
          (sidebarEffectiveTimestamp(left) -
            sidebarEffectiveTimestamp(right)) ||
        direction *
          (parseTimestamp(left.lastActivityAt) -
            parseTimestamp(right.lastActivityAt)) ||
        left.id.localeCompare(right.id);
    case "stateChanged":
      return (left, right) =>
        direction *
          (parseTimestamp(left.stateChangedAt) -
            parseTimestamp(right.stateChangedAt)) ||
        left.id.localeCompare(right.id);
    case "alpha":
      return (left, right) => {
        const leftTitle = left.title.text.trim().toLocaleLowerCase();
        const rightTitle = right.title.text.trim().toLocaleLowerCase();
        if (leftTitle === "" || rightTitle === "") {
          // Untitled threads stay last regardless of direction.
          if ((leftTitle === "") !== (rightTitle === "")) {
            return leftTitle === "" ? 1 : -1;
          }
          return left.id.localeCompare(right.id);
        }
        return (
          direction * leftTitle.localeCompare(rightTitle) ||
          left.id.localeCompare(right.id)
        );
      };
  }
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function startOfDay(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

function shiftDays(moment: Date, days: number): Date {
  return new Date(
    moment.getFullYear(),
    moment.getMonth(),
    moment.getDate() + days,
  );
}

/** Weeks start Monday, local time. */
function startOfWeek(moment: Date): Date {
  return shiftDays(moment, -((moment.getDay() + 6) % 7));
}
