import type {
  AutomationSchedule,
  ThreadAutomationRun,
  ThreadRunState,
} from "../../shared/index.js";
import { formatActivityDuration } from "../components/thread/activity-groups.js";
import { futureTimeLabel, shortRelativeTime } from "../lib/time.js";
import {
  lastRunAt,
  threadRunPhase,
  type AutomationHealth,
  type SummaryAutomation,
  type SummaryAutomationRun,
} from "./automation-health.js";

/**
 * Words for automations: schedule sentences, run states, run meta and error
 * codes. Pure; shared by the sidebar, the thread surfaces, the Automations
 * list and the automation page.
 *
 * Time zones: a cron schedule's clock times are wall-clock times in its own
 * zone, so they are printed as written with the zone named and never shift
 * with DST or the viewer's zone. A whole-day interval repeats a fixed number
 * of seconds, so its time of day is stable only in UTC and is printed in UTC.
 * A one-shot is a single instant and is printed in the viewer's local time.
 */

type AutomationRunState = ThreadAutomationRun["state"];
type RunPrecheck = NonNullable<ThreadAutomationRun["precheck"]>;
type RunTurn = NonNullable<ThreadAutomationRun["turn"]>;

/** How a run's agent turn ended, in words. */
const TURN_OUTCOME_LABELS: Readonly<Record<RunTurn["outcome"], string>> = {
  completed: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const WEEKDAY_ABBREVIATIONS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** Sentences list days Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * One sentence for a schedule: "Every day at 2:00 AM UTC", "Every weekday at
 * 6:30 AM Europe/Berlin", "Every 4 hours", "Once · Oct 9, 9:00 PM". An
 * interval that has not started yet adds when it starts ("…, starting
 * Tmrw"). Cron expressions outside the common forms fall back to "Cron
 * <expr> (<zone>)".
 */
export function describeSchedule(
  schedule: AutomationSchedule,
  now: Date = new Date(),
): string {
  switch (schedule.kind) {
    case "date_time":
      return `Once · ${onceLabel(schedule.runAt, now)}`;
    case "interval":
      return describeInterval(schedule.everySeconds, schedule.anchorAt, now);
    case "cron": {
      const expression = schedule.expression.trim().replace(/\s+/gu, " ");
      return (
        describeCron(expression, schedule.timeZone) ??
        `Cron ${expression} (${zoneLabel(schedule.timeZone)})`
      );
    }
  }
}

function onceLabel(runAt: string, now: Date): string {
  const date = new Date(runAt);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

function describeInterval(everySeconds: number, anchorAt: string, now: Date): string {
  const wholeDays = everySeconds % 86_400 === 0;
  return `${describeEvery(everySeconds, anchorAt)}${startingClause(anchorAt, now, wholeDays)}`;
}

function describeEvery(everySeconds: number, anchorAt: string): string {
  if (everySeconds % 86_400 === 0) {
    const days = everySeconds / 86_400;
    const anchor = new Date(anchorAt);
    const clock = wallClock(anchor.getUTCHours(), anchor.getUTCMinutes());
    return `${days === 1 ? "Every day" : `Every ${days} days`} at ${clock} UTC`;
  }
  if (everySeconds % 3_600 === 0) {
    const hours = everySeconds / 3_600;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (everySeconds % 60 === 0) return `Every ${everySeconds / 60} minutes`;
  return `Every ${everySeconds} seconds`;
}

/**
 * ", starting today", ", starting Tmrw" or ", starting Oct 9" for an
 * interval whose first run is still to come; nothing once it has started.
 * A whole-day interval names its UTC day, as its sentence names its UTC
 * time; a shorter one names the viewer's day.
 */
function startingClause(anchorAt: string, now: Date, utc: boolean): string {
  const anchor = new Date(anchorAt);
  if (!(anchor.getTime() > now.getTime())) return "";
  const dayOf = (date: Date) =>
    utc
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      : new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((dayOf(anchor) - dayOf(now)) / 86_400_000);
  if (days === 0) return ", starting today";
  if (days === 1) return ", starting Tmrw";
  const year = utc ? anchor.getUTCFullYear() : anchor.getFullYear();
  const nowYear = utc ? now.getUTCFullYear() : now.getFullYear();
  const date = anchor.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(year === nowYear ? {} : { year: "numeric" }),
    ...(utc ? { timeZone: "UTC" } : {}),
  });
  return `, starting ${date}`;
}

/**
 * Sentences for fixed minute and hour on every day, weekdays or a
 * day-of-week list, a fixed minute every hour, and `*∕n` minute or hour
 * steps that divide the hour or day evenly. Anything else is undefined.
 */
function describeCron(expression: string, timeZone: string): string | undefined {
  const fields = expression.split(" ");
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!isWildcard(dayOfMonth) || !isWildcard(month)) return undefined;
  const everyDay = isWildcard(dayOfWeek);

  const minuteStep = cronStep(minute, 60);
  if (minuteStep !== undefined) {
    if (hour !== "*" || !everyDay) return undefined;
    return minuteStep === 1 ? "Every minute" : `Every ${minuteStep} minutes`;
  }
  const minuteValue = cronInteger(minute, 59);
  if (minuteValue === undefined) return undefined;
  const pastTheHour = minuteValue === 0 ? "" : ` at :${pad(minuteValue)}`;

  const hourStep = hour === "*" ? 1 : cronStep(hour, 24);
  if (hourStep !== undefined) {
    if (!everyDay) return undefined;
    return `${hourStep === 1 ? "Every hour" : `Every ${hourStep} hours`}${pastTheHour}`;
  }
  const hourValue = cronInteger(hour, 23);
  if (hourValue === undefined) return undefined;
  const days = cronDaysOfWeek(dayOfWeek);
  if (days === undefined) return undefined;
  return `${dayPhrase(days)} at ${wallClock(hourValue, minuteValue)} ${zoneLabel(timeZone)}`;
}

function isWildcard(field: string): boolean {
  return field === "*" || field === "?";
}

function cronInteger(field: string, maximum: number): number | undefined {
  if (!/^\d{1,2}$/u.test(field)) return undefined;
  const value = Number(field);
  return value <= maximum ? value : undefined;
}

/** `*∕n` where n divides the cycle; uneven steps restart early at the wrap. */
function cronStep(field: string, cycle: number): number | undefined {
  const match = /^\*\/(\d{1,2})$/u.exec(field);
  if (!match) return undefined;
  const step = Number(match[1]);
  return step >= 1 && cycle % step === 0 ? step : undefined;
}

/** A day-of-week token as written: 0–7 (both 0 and 7 are Sunday) or a name. */
function cronDay(token: string): number | undefined {
  const named = WEEKDAY_ABBREVIATIONS.indexOf(token.toUpperCase());
  if (named >= 0) return named;
  return cronInteger(token, 7);
}

/**
 * The day set of a day-of-week field built from days, names and ranges.
 * Range endpoints expand as written and fold 7 to Sunday afterwards, so
 * "5-7" and "7-7" mean what the server's cron parser schedules.
 */
function cronDaysOfWeek(field: string): ReadonlySet<number> | undefined {
  if (isWildcard(field)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const item of field.split(",")) {
    const bounds = item.split("-");
    if (bounds.length > 2) return undefined;
    const start = cronDay(bounds[0]!);
    const end = bounds.length === 2 ? cronDay(bounds[1]!) : start;
    if (start === undefined || end === undefined || end < start) {
      return undefined;
    }
    for (let day = start; day <= end; day++) days.add(day % 7);
  }
  return days;
}

function dayPhrase(days: ReadonlySet<number>): string {
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) {
    return "Every weekday";
  }
  const names = WEEK_ORDER.filter((day) => days.has(day)).map(
    (day) => WEEKDAY_NAMES[day],
  );
  return `Every ${joinList(names)}`;
}

function joinList(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A wall-clock time in the viewer's locale; no zone conversion, so DST-safe. */
function wallClock(hour: number, minute: number): string {
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function zoneLabel(timeZone: string): string {
  return /^(?:Etc\/)?(?:UTC|UCT|Universal|Zulu|GMT0?|Greenwich)$/iu.test(
    timeZone,
  )
    ? "UTC"
    : timeZone;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Whether a delivered run's agent turn is still going, as far as the client
 * can tell: the run is the automation's latest, its turn has not settled,
 * and its result thread is busy (starting, running, waiting for the user or
 * stopping). An older run, or one whose result thread the client does not
 * hold, reads "Delivered" until its turn settles.
 */
export function runTurnRunning(
  run: {
    readonly state: AutomationRunState;
    readonly turn?: Pick<RunTurn, "outcome">;
  },
  latest: boolean,
  resultRunState: ThreadRunState | undefined,
): boolean {
  return (
    latest &&
    run.state === "completed" &&
    run.turn === undefined &&
    resultRunState !== undefined &&
    threadRunPhase(resultRunState) === "busy"
  );
}

/**
 * A run in words. Once the agent turn it started settles, the turn's ending:
 * "Finished", "Failed" or "Interrupted". Before that, its raw state:
 * "Delivered" means the agent received the prompt, and reads "Running · 4m"
 * (since the agent accepted it) while `running` (see `runTurnRunning`).
 */
export function runStateLabel(
  run: {
    readonly state: AutomationRunState;
    readonly precheck?: Pick<RunPrecheck, "status">;
    readonly turn?: Pick<RunTurn, "outcome">;
    readonly acceptedAt?: string;
    readonly finishedAt?: string;
  },
  { running = false, now = Date.now() }: {
    readonly running?: boolean;
    readonly now?: Date | number;
  } = {},
): string {
  if (run.turn) return TURN_OUTCOME_LABELS[run.turn.outcome];
  switch (run.state) {
    case "claimed":
    case "dispatching":
      return run.precheck?.status === "checking" ? "Checking" : "Starting";
    case "queued":
      return "Waiting for turn";
    case "running":
      return "Sending";
    case "completed": {
      if (!running) return "Delivered";
      const elapsed = runRunningFor(run, now);
      return elapsed === undefined ? "Running" : `Running · ${elapsed}`;
    }
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "uncertain":
      return "Outcome unknown";
  }
}

/**
 * How long a delivered run's turn has been going, on a minute clock: "4m",
 * "2h"; undefined in its first minute.
 */
export function runRunningFor(
  run: { readonly acceptedAt?: string; readonly finishedAt?: string },
  now: Date | number,
): string | undefined {
  const since = run.acceptedAt ?? run.finishedAt;
  if (since === undefined) return undefined;
  const elapsed = shortRelativeTime(since, typeof now === "number" ? now : now.getTime());
  return elapsed === "now" ? undefined : elapsed;
}

/**
 * How long a run's agent turn took, as the transcript prints durations
 * ("2m 14s"); undefined unless the backend reported when it started and
 * ended.
 */
export function runTurnDuration(
  turn: Pick<RunTurn, "startedAt" | "endedAt"> | undefined,
): string | undefined {
  if (turn?.startedAt === undefined || turn.endedAt === undefined) return undefined;
  return formatActivityDuration(Date.parse(turn.endedAt) - Date.parse(turn.startedAt));
}

/** Why a skipped run did not reach the agent; undefined for other runs. */
export function runSkipReason(run: {
  readonly state: AutomationRunState;
  readonly errorCode?: string;
  readonly precheck?: Pick<RunPrecheck, "exitCode">;
}): string | undefined {
  if (run.state !== "skipped") return undefined;
  switch (run.errorCode) {
    case "automation_precheck_nonzero":
      return run.precheck?.exitCode === undefined
        ? "precheck said skip"
        : `precheck exit ${run.precheck.exitCode}`;
    case "automation_misfire_skipped":
      return "missed while Sedes was down";
    case "automation_snoozed":
      return "thread was snoozed";
    default:
      return undefined;
  }
}

/**
 * One line of run facts: "Scheduled · 2m 14s · precheck passed · 210 ms"
 * (the agent turn's duration when known), "Scheduled · missed ×2 merged",
 * "Manual · precheck exit 1 · 18 ms", "Scheduled · thread was snoozed". A
 * precheck that never ran (pending) is left out.
 */
export function runMeta(run: ThreadAutomationRun): string {
  const parts: string[] = [run.occurrence === "manual" ? "Manual" : "Scheduled"];
  const duration = runTurnDuration(run.turn);
  if (duration) parts.push(duration);
  if (run.coalescedCount > 0) parts.push(`missed ×${run.coalescedCount} merged`);
  const skipReason = runSkipReason(run);
  if (skipReason) parts.push(skipReason);
  const precheck = run.precheck;
  if (precheck) {
    const duration = precheckDuration(precheck.durationMilliseconds);
    switch (precheck.status) {
      case "passed":
        parts.push("precheck passed", duration);
        break;
      case "skipped":
        if (!skipReason) parts.push("precheck skipped the run");
        parts.push(duration);
        break;
      case "failed":
        parts.push(
          run.errorCode === "automation_precheck_timed_out"
            ? `precheck timed out after ${duration}`
            : `precheck failed after ${duration}`,
        );
        break;
      case "checking":
      case "pending":
        break;
    }
  }
  return parts.join(" · ");
}

function precheckDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)} s`;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Sun Oct 4", with the year when it is not `now`'s. */
function weekdayDate(date: Date, now: Date): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return [part("weekday"), part("month"), part("day"), part("year")]
    .filter(Boolean)
    .join(" ");
}

type DayWord = "Today" | "Tmrw" | "Yesterday" | "weekday" | "date";

function dayOf(date: Date, now: Date): DayWord {
  const days = Math.round((startOfLocalDay(date) - startOfLocalDay(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tmrw";
  if (days === -1) return "Yesterday";
  // Later this week a weekday is unambiguous; anything else carries its date.
  return days > 1 && days < 7 ? "weekday" : "date";
}

/**
 * The one format for an automation time in a list, a run's or an upcoming
 * occurrence's, always with its clock time, in the viewer's time zone:
 * "Today 3:17 AM", "Tmrw 9:00 AM", "Yesterday 2:00 AM", "Mon 9:00 AM" later
 * this week, otherwise "Sun Oct 4 2:00 AM" (with the year when it is not
 * this one). No item has a comma, so a list joined by commas reads clearly.
 * Single upcoming labels (the sidebar, a next run) use `futureTimeLabel`.
 */
export function dayTimeLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = dayOf(date, now);
  switch (day) {
    case "Today":
    case "Tmrw":
    case "Yesterday":
      return `${day} ${localClock(date)}`;
    case "weekday":
      return `${date.toLocaleDateString([], { weekday: "short" })} ${localClock(date)}`;
    case "date":
      return `${weekdayDate(date, now)} ${localClock(date)}`;
  }
}

/**
 * `dayTimeLabel` inside a sentence: "today at 6:00 PM", "tomorrow at 9:00
 * AM", "yesterday at 2:00 AM", "Mon at 9:00 AM", "Sun Oct 4 at 2:00 AM".
 */
export function dayTimePhrase(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const clock = localClock(date);
  switch (dayOf(date, now)) {
    case "Today":
      return `today at ${clock}`;
    case "Tmrw":
      return `tomorrow at ${clock}`;
    case "Yesterday":
      return `yesterday at ${clock}`;
    case "weekday":
      return `${date.toLocaleDateString([], { weekday: "short" })} at ${clock}`;
    case "date":
      return `${weekdayDate(date, now)} at ${clock}`;
  }
}

/**
 * How long ago the last run ended, its agent turn's end when known (or when
 * it was due): "21h ago", "just now".
 */
export function lastRunAge(lastRun: SummaryAutomationRun, now: number): string {
  const age = shortRelativeTime(lastRunAt(lastRun), now);
  return age === "now" ? "just now" : `${age} ago`;
}

/**
 * A thread's live turn as a hint beside an automation's state, in the
 * sidebar's colours: "Running" (starting, running or stopping) in info-blue,
 * or "Waiting for you" (an approval or a question) in amber; undefined while
 * no turn is in flight. A hint only: it never changes the automation's
 * health or attention.
 */
export function threadLiveState(
  runState: ThreadRunState,
):
  | { readonly label: "Running"; readonly tone: "info" }
  | { readonly label: "Waiting for you"; readonly tone: "warning" }
  | undefined {
  if (threadRunPhase(runState) !== "busy") return undefined;
  return runState === "waiting_for_approval" || runState === "waiting_for_input"
    ? { label: "Waiting for you", tone: "warning" }
    : { label: "Running", tone: "info" };
}

/**
 * The automation's state in a few words for a status line or tooltip
 * ("Automation · <this>"): "next Tmrw 2:00 AM" while active, "Failed 21h ago",
 * otherwise the health label ("Outcome unknown", "Paused", "Not started").
 */
export function automationStatusText(
  automation: SummaryAutomation,
  health: AutomationHealth,
  now: Date,
): string {
  if (health.kind === "failed" && automation.lastRun) {
    return `Failed ${lastRunAge(automation.lastRun, now.getTime())}`;
  }
  if (health.kind === "active" && automation.nextRunAt !== undefined) {
    return `next ${futureTimeLabel(automation.nextRunAt, now)}`;
  }
  return health.label;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  automation_dispatch_uncertain:
    "Sedes can't tell whether the last run reached the agent.",
  automation_dispatch_failed: "The prompt could not be delivered to the agent.",
  automation_dispatch_cancelled: "The queued prompt was cancelled.",
  automation_dispatch_rejected: "The agent didn't accept the prompt.",
  automation_uncertain_resolved: "Marked as failed after an unknown outcome.",
  automation_snoozed: "Skipped because the thread was snoozed.",
  automation_misfire_skipped: "Skipped because Sedes was down when it was due.",
  automation_precheck_nonzero:
    "The precheck exited non-zero, so the agent was not run.",
  automation_precheck_execution_failed: "The precheck could not be run.",
  automation_precheck_unavailable: "The precheck could not be started.",
  automation_precheck_interrupted:
    "Sedes stopped while the precheck was running.",
  automation_precheck_timed_out: "The precheck timed out.",
  automation_precheck_cancelled: "The precheck was cancelled.",
  automation_precheck_signalled: "The precheck ended from a signal.",
  automation_precheck_stdout_too_large: "The precheck output exceeded 16 KiB.",
  automation_precheck_stdout_invalid_utf8:
    "The precheck output was not valid UTF-8.",
  automation_precheck_stdout_nul: "The precheck output contained a NUL byte.",
  automation_precheck_prompt_too_large:
    "The prompt and precheck output exceeded 64 KiB.",
  automation_backend_unavailable: "The backend was unavailable.",
  automation_backend_permission_denied: "The backend denied permission.",
  automation_backend_incompatible: "The backend is incompatible with Sedes.",
  automation_checkpoint_unavailable:
    "The checkpoint to fork from was unavailable.",
  automation_anchor_archived: "The thread was archived.",
  automation_anchor_materializing: "The thread was still being set up.",
  automation_anchor_unavailable: "The thread's environment was unavailable.",
  automation_anchor_needs_input: "The thread was waiting for input.",
  automation_run_conflict: "Another run was already in progress.",
  force_reset: "The run was ended by a force reset.",
};

/**
 * A run's error code as a sentence, for surfaces that have the code but not
 * the diagnostic (the thread summary carries only the code), worded like the
 * automation page and the thread notice. Unknown codes, such as the agent
 * runtime's or execution environment's own failure codes, get a generic
 * line.
 */
export function automationErrorText(errorCode: string): string {
  return (
    ERROR_TEXT[errorCode] ??
    (errorCode.startsWith("automation_precheck_")
      ? "The precheck failed."
      : "The agent runtime didn't accept the prompt.")
  );
}
