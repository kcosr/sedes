import type {
  AutomationSchedule,
  ThreadAutomationRun,
} from "../../shared/index.js";
import { futureTimeLabel, shortRelativeTime } from "../lib/time.js";
import {
  lastRunAt,
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
 * 6:30 AM Europe/Berlin", "Every 4 hours", "Once · Oct 9, 9:00 PM". Cron
 * expressions outside the common forms fall back to "Cron <expr> (<zone>)".
 */
export function describeSchedule(
  schedule: AutomationSchedule,
  now: Date = new Date(),
): string {
  switch (schedule.kind) {
    case "date_time":
      return `Once · ${onceLabel(schedule.runAt, now)}`;
    case "interval":
      return describeInterval(schedule.everySeconds, schedule.anchorAt);
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

function describeInterval(everySeconds: number, anchorAt: string): string {
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

function cronDay(token: string): number | undefined {
  const named = WEEKDAY_ABBREVIATIONS.indexOf(token.toUpperCase());
  if (named >= 0) return named;
  const value = cronInteger(token, 7);
  return value === undefined ? undefined : value % 7;
}

/** The day set of a day-of-week field built from days, names and ranges. */
function cronDaysOfWeek(field: string): ReadonlySet<number> | undefined {
  if (isWildcard(field)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const item of field.split(",")) {
    const bounds = item.split("-");
    if (bounds.length > 2) return undefined;
    const start = cronDay(bounds[0]!);
    // "7" may close a range ("5-7"); cronDay folds it to Sunday.
    const end =
      bounds.length === 2
        ? bounds[1] === "7"
          ? 7
          : cronDay(bounds[1]!)
        : start;
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

/** Raw run states in words; "Delivered" means the agent received the prompt. */
export function runStateLabel(run: {
  readonly state: AutomationRunState;
  readonly precheck?: Pick<RunPrecheck, "status">;
}): string {
  switch (run.state) {
    case "claimed":
    case "dispatching":
      return run.precheck?.status === "checking" ? "Checking" : "Starting";
    case "queued":
      return "Waiting for turn";
    case "running":
      return "Sending";
    case "completed":
      return "Delivered";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "uncertain":
      return "Outcome unknown";
  }
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
 * One line of run facts: "Scheduled · missed ×2 merged · precheck passed ·
 * 210 ms", "Manual · precheck exit 1 · 18 ms", "Scheduled · thread was
 * snoozed". A precheck that never ran (pending) is left out.
 */
export function runMeta(run: ThreadAutomationRun): string {
  const parts: string[] = [run.occurrence === "manual" ? "Manual" : "Scheduled"];
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

/** How long ago the last run ended (or was due): "21h ago", "just now". */
export function lastRunAge(lastRun: SummaryAutomationRun, now: number): string {
  const age = shortRelativeTime(lastRunAt(lastRun), now);
  return age === "now" ? "just now" : `${age} ago`;
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
    "Sedes can't tell whether the prompt reached the agent.",
  automation_dispatch_failed: "The prompt could not be delivered to the agent.",
  automation_dispatch_cancelled: "The queued prompt was cancelled.",
  automation_dispatch_rejected: "The agent did not accept the prompt.",
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
 * the diagnostic (the thread summary carries only the code). Unknown codes,
 * such as the execution environment's own failure codes, get a generic line.
 */
export function automationErrorText(errorCode: string): string {
  return (
    ERROR_TEXT[errorCode] ??
    (errorCode.startsWith("automation_precheck_")
      ? "The precheck failed."
      : "The run failed in the backend.")
  );
}
