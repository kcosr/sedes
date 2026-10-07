import type {
  NormalizedThreadSummary,
  ThreadRunState,
} from "../../shared/index.js";
import type { Tone } from "../components/ui/tone.js";

/**
 * The one automation state vocabulary. Every surface that shows an
 * automation (sidebar rows, peek, thread header, the Automations list and the
 * automation page) derives its glyph, tone and words from `automationHealth`,
 * so a state reads the same everywhere. Uncertain runs need attention
 * everywhere; paused is never a warning.
 */

export type SummaryAutomation = NonNullable<
  NormalizedThreadSummary["automation"]
>;
export type SummaryAutomationRun = NonNullable<
  SummaryAutomation["lastRun"]
>;

/** The summary fields health reads; application and thread summaries both carry them. */
export type AutomationHealthThread = Pick<
  NormalizedThreadSummary,
  "automation" | "inventoryState" | "snoozedUntil"
>;

export type AutomationHealthKind =
  | "sending"
  | "failed"
  | "unknown"
  | "archived"
  | "snoozed"
  | "active"
  | "paused"
  | "not_started";

export type AutomationHealthGroup =
  | "needs_attention"
  | "upcoming"
  | "paused"
  | "suspended";

/** Glyphs drawn by `AutomationGlyph`. */
export type AutomationGlyphKind =
  | "spinner"
  | "triangle"
  | "archive"
  | "snoozed"
  | "repeat"
  | "pause";

export interface AutomationHealth {
  readonly kind: AutomationHealthKind;
  readonly group: AutomationHealthGroup;
  readonly glyph: AutomationGlyphKind;
  /** Status-chip tone. Glyphs draw `success` (Active) in the neutral tone. */
  readonly tone: Tone;
  readonly label: string;
}

const IN_FLIGHT_RUN_STATES: ReadonlySet<SummaryAutomationRun["state"]> =
  new Set(["claimed", "dispatching", "queued", "running"]);

const GROUP_BY_KIND: Readonly<
  Record<AutomationHealthKind, AutomationHealthGroup>
> = {
  sending: "upcoming",
  failed: "needs_attention",
  unknown: "needs_attention",
  archived: "suspended",
  snoozed: "suspended",
  active: "upcoming",
  paused: "paused",
  not_started: "paused",
};

/** Group order on the Automations list. */
export const AUTOMATION_HEALTH_GROUPS: readonly AutomationHealthGroup[] = [
  "needs_attention",
  "upcoming",
  "paused",
  "suspended",
];

export const AUTOMATION_HEALTH_GROUP_LABELS: Readonly<
  Record<AutomationHealthGroup, string>
> = {
  needs_attention: "Needs attention",
  upcoming: "Upcoming",
  paused: "Paused",
  suspended: "Suspended",
};

function health(
  kind: AutomationHealthKind,
  glyph: AutomationGlyphKind,
  tone: Tone,
  label: string,
): AutomationHealth {
  return { kind, group: GROUP_BY_KIND[kind], glyph, tone, label };
}

/**
 * The automation's state, first match wins: a run in flight, then the last
 * run's problem, then suspension of the anchor, then the definition status.
 * A snooze suspends runs only until its wake time, the same rule the
 * dispatcher applies (an open-ended snooze does not skip runs), which is why
 * `now` is needed. Undefined when the thread has no automation.
 */
export function automationHealth(
  thread: AutomationHealthThread & {
    readonly automation: SummaryAutomation;
  },
  now: Date | number,
): AutomationHealth;
export function automationHealth(
  thread: AutomationHealthThread,
  now: Date | number,
): AutomationHealth | undefined;
export function automationHealth(
  thread: AutomationHealthThread,
  now: Date | number,
): AutomationHealth | undefined {
  const automation = thread.automation;
  if (!automation) return undefined;
  const lastRun = automation.lastRun;
  if (lastRun && IN_FLIGHT_RUN_STATES.has(lastRun.state)) {
    return health(
      "sending",
      "spinner",
      "info",
      lastRun.state === "queued" ? "Waiting for turn" : "Sending",
    );
  }
  if (lastRun?.state === "failed") {
    return health("failed", "triangle", "danger", "Failed");
  }
  if (lastRun?.state === "uncertain") {
    return health("unknown", "triangle", "warning", "Outcome unknown");
  }
  if (thread.inventoryState === "archived") {
    return health("archived", "archive", "neutral", "Thread archived");
  }
  if (snoozeSuspendsRuns(thread, now)) {
    return health("snoozed", "snoozed", "neutral", "Snoozed");
  }
  if (automation.status === "enabled") {
    return health("active", "repeat", "success", "Active");
  }
  return lastRun
    ? health("paused", "pause", "neutral", "Paused")
    : health("not_started", "pause", "neutral", "Not started");
}

function snoozeSuspendsRuns(
  thread: AutomationHealthThread,
  now: Date | number,
): boolean {
  if (
    thread.inventoryState !== "snoozed" ||
    thread.snoozedUntil === undefined
  ) {
    return false;
  }
  const until = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(until) && until >= epoch(now);
}

/** Failed and uncertain last runs; both need the user. */
export function automationNeedsAttention(
  automation: SummaryAutomation | null | undefined,
): boolean {
  const state = automation?.lastRun?.state;
  return state === "failed" || state === "uncertain";
}

/**
 * The glyph for surfaces that carry attention separately, as a row chip or a
 * tinted header ring: the spinner while a run is sending, CirclePause for
 * paused, never-started and suspended automations, Repeat otherwise.
 */
export function automationIdentityGlyph(
  health: AutomationHealth,
): "spinner" | "repeat" | "pause" {
  switch (health.kind) {
    case "sending":
      return "spinner";
    case "paused":
    case "not_started":
    case "archived":
    case "snoozed":
      return "pause";
    case "failed":
    case "unknown":
    case "active":
      return "repeat";
  }
}

/**
 * Accessible name for the identity glyph: "Automation" beside Repeat (an
 * attention chip names any problem), otherwise the state it draws.
 */
export function automationIdentityLabel(health: AutomationHealth): string {
  return automationIdentityGlyph(health) === "repeat"
    ? "Automation"
    : `Automation ${health.label.toLowerCase()}`;
}

/**
 * When the last run ended: its agent turn's end when the backend reported
 * it, else the run's own finish (for a delivered run, the delivery), else
 * when it was due while it has no end yet.
 */
export function lastRunAt(lastRun: SummaryAutomationRun): string {
  return lastRun.turn?.endedAt ?? lastRun.finishedAt ?? lastRun.scheduledFor;
}

/**
 * The phase of a thread's run state: settled (idle or failed), busy (a turn
 * in flight: starting, running, waiting for the user or stopping), or
 * transitioning (the backend is disconnected or reconciling).
 */
export function threadRunPhase(
  runState: ThreadRunState,
): "settled" | "busy" | "transitioning" {
  switch (runState) {
    case "idle":
    case "failed":
      return "settled";
    case "disconnected":
    case "reconciling":
      return "transitioning";
    case "starting":
    case "running":
    case "waiting_for_approval":
    case "waiting_for_input":
    case "stopping":
      return "busy";
  }
}

export interface AutomationSortSubject {
  readonly id: string;
  readonly title: NormalizedThreadSummary["title"];
  readonly automation: SummaryAutomation;
}

/**
 * Order within one list group: Upcoming by next run (undated last), Needs
 * attention by the last run, newest first, the rest by title. Ties fall back
 * to title, then id, so the order is stable.
 */
export function compareAutomationsInGroup(
  group: AutomationHealthGroup,
  left: AutomationSortSubject,
  right: AutomationSortSubject,
): number {
  if (group === "upcoming") {
    const order = compareOptionalInstants(
      left.automation.nextRunAt,
      right.automation.nextRunAt,
      1,
    );
    if (order !== 0) return order;
  } else if (group === "needs_attention") {
    const order = compareOptionalInstants(
      left.automation.lastRun && lastRunAt(left.automation.lastRun),
      right.automation.lastRun && lastRunAt(right.automation.lastRun),
      -1,
    );
    if (order !== 0) return order;
  }
  return (
    titleOf(left).localeCompare(titleOf(right), undefined, {
      sensitivity: "base",
      numeric: true,
    }) || left.id.localeCompare(right.id)
  );
}

function titleOf(subject: AutomationSortSubject): string {
  return subject.title.text || "Untitled thread";
}

/**
 * Instants ascending (direction 1) or descending (-1); an undefined or
 * unparseable instant sorts last either way.
 */
function compareOptionalInstants(
  left: string | undefined,
  right: string | undefined,
  direction: 1 | -1,
): number {
  const leftTime = left === undefined ? Number.NaN : Date.parse(left);
  const rightTime = right === undefined ? Number.NaN : Date.parse(right);
  if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? 0 : 1;
  if (Number.isNaN(rightTime)) return -1;
  return (leftTime - rightTime) * direction;
}

function epoch(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}
