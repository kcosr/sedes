import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import { runStateLabel } from "../../automation/automation-text.js";

/**
 * Words and times for one run on the automation page: the row's time with
 * its day, the detail timeline, durations and the precheck facts. Pure.
 */

/** A run's state as the page draws it: its glyph and the tone of its words. */
export type RunHealth = "sending" | "delivered" | "failed" | "uncertain" | "skipped";

export function runHealth(run: Pick<ThreadAutomationRun, "state">): RunHealth {
  switch (run.state) {
    case "completed":
      return "delivered";
    case "failed":
      return "failed";
    case "uncertain":
      return "uncertain";
    case "skipped":
      return "skipped";
    case "claimed":
    case "dispatching":
    case "queued":
    case "running":
      return "sending";
  }
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function clock(date: Date, seconds = false): string {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

/**
 * When a run was due, with its day: "Today 3:17 AM", "Yesterday 2:00 AM",
 * "Sun Oct 4 2:00 AM", and the year when it is not this one.
 */
export function runDayTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today ${clock(date)}`;
  if (days === 1) return `Yesterday ${clock(date)}`;
  const parts = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const day = [part("weekday"), part("month"), part("day"), part("year")]
    .filter(Boolean)
    .join(" ");
  return `${day} ${clock(date)}`;
}

/** The run's date and time in full, for the phone sheet: "Thu, Oct 1, 2:00 AM". */
export function runDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "150 ms", "1.4 s", "24 s", "2 min 5 s", "1 h 3 min". */
export function durationLabel(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${Math.round(value / 100) / 10} s`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

export interface RunTimelineStep {
  readonly label: string;
  /** The clock time, with seconds. */
  readonly time: string;
  /** Time since the step before, as "+1.4 s"; absent on the first step. */
  readonly delta?: string;
}

/**
 * The run's moments in order, each with the time since the one before:
 * scheduled, claimed, started, then accepted by the backend or, without an
 * acceptance, finished in its final state. A force reset closes it.
 */
export function runTimeline(run: ThreadAutomationRun): readonly RunTimelineStep[] {
  const moments: { readonly label: string; readonly at: string }[] = [
    { label: "Scheduled for", at: run.scheduledFor },
  ];
  if (run.claimedAt) moments.push({ label: "Claimed", at: run.claimedAt });
  if (run.startedAt) moments.push({ label: "Started", at: run.startedAt });
  if (run.acceptedAt) moments.push({ label: "Accepted", at: run.acceptedAt });
  else if (run.finishedAt) moments.push({ label: runStateLabel(run), at: run.finishedAt });
  if (run.forceResetAt) moments.push({ label: "Force reset", at: run.forceResetAt });
  return moments.map((moment, index) => {
    const previous = moments[index - 1];
    return {
      label: moment.label,
      time: clock(new Date(moment.at), true),
      ...(previous
        ? { delta: `+${durationLabel(Date.parse(moment.at) - Date.parse(previous.at))}` }
        : {}),
    };
  });
}

/**
 * The precheck's outcome in one line: "Passed · exit 0 · 150 ms · 46 bytes
 * of output added to the prompt".
 */
export function runPrecheckSummary(
  precheck: NonNullable<ThreadAutomationRun["precheck"]>,
): string {
  const status = {
    pending: "Not run yet",
    checking: "Running",
    passed: "Passed",
    skipped: "Skipped the run",
    failed: "Failed",
  }[precheck.status];
  const parts = [status];
  if (precheck.exitCode !== undefined) parts.push(`exit ${precheck.exitCode}`);
  if (precheck.status !== "pending" && precheck.status !== "checking") {
    parts.push(durationLabel(precheck.durationMilliseconds));
    const bytes = `${precheck.stdoutBytes.toLocaleString()} ${precheck.stdoutBytes === 1 ? "byte" : "bytes"} of output`;
    parts.push(precheck.stdoutIncluded ? `${bytes} added to the prompt` : bytes);
  }
  return parts.join(" · ");
}

/** The run's kind: "Scheduled" or "Manual". */
export function runKind(run: Pick<ThreadAutomationRun, "occurrence">): string {
  return run.occurrence === "manual" ? "Manual" : "Scheduled";
}

/** A run row's accessible name: "Today 3:17 AM Delivered, Manual". */
export function runAccessibleName(run: ThreadAutomationRun, now: Date = new Date()): string {
  return `${runDayTime(run.scheduledFor, now)} ${runStateLabel(run)}, ${runKind(run)}`;
}

/** The phone sheet's title: "Failed run", "Run in progress". */
export function runDetailTitle(run: Pick<ThreadAutomationRun, "state">): string {
  switch (runHealth(run)) {
    case "delivered":
      return "Delivered run";
    case "failed":
      return "Failed run";
    case "skipped":
      return "Skipped run";
    case "uncertain":
      return "Run with an unknown outcome";
    case "sending":
      return "Run in progress";
  }
}
