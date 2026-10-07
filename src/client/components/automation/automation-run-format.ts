import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import {
  dayTimeLabel,
  runRunningFor,
  runStateLabel,
  runTurnDuration,
} from "../../automation/automation-text.js";

/**
 * Words and times for one run on the automation page: the detail timeline,
 * durations and the precheck facts (a run's time with its day is
 * `dayTimeLabel`). Pure.
 */

/**
 * A run's state as the page draws it: its glyph and the tone of its words.
 * A settled agent turn decides it (a failed turn is "failed"); before that,
 * a delivered run is "running" while `running` (see `runTurnRunning`).
 */
export type RunHealth =
  | "sending"
  | "running"
  | "delivered"
  | "finished"
  | "interrupted"
  | "failed"
  | "uncertain"
  | "skipped";

export function runHealth(
  run: Pick<ThreadAutomationRun, "state" | "turn">,
  running = false,
): RunHealth {
  switch (run.turn?.outcome) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case undefined:
      break;
  }
  switch (run.state) {
    case "completed":
      return running ? "running" : "delivered";
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

function clock(date: Date, seconds = false): string {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
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
  else if (run.finishedAt) {
    // The run's own ending, never its turn's (the Turn fact has that).
    moments.push({
      label: runStateLabel({ state: run.state, precheck: run.precheck }),
      at: run.finishedAt,
    });
  }
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

/**
 * A run row's accessible name, its outcome with the turn's duration when
 * known: "Today 3:17 AM Finished in 2m 14s, Scheduled", "Today 3:17 AM
 * Failed after 40s, Manual", "Today 3:17 AM Running for 4m, Scheduled",
 * "Today 3:17 AM Delivered, Manual".
 */
export function runAccessibleName(
  run: ThreadAutomationRun,
  now: Date = new Date(),
  running = false,
): string {
  const time = dayTimeLabel(run.scheduledFor, now);
  const kind = runKind(run);
  if (runHealth(run, running) === "running") {
    const elapsed = runRunningFor(run, now);
    return `${time} Running${elapsed === undefined ? "" : ` for ${elapsed}`}, ${kind}`;
  }
  const duration = runTurnDuration(run.turn);
  const outcome = runStateLabel(run);
  return duration === undefined
    ? `${time} ${outcome}, ${kind}`
    : `${time} ${outcome} ${run.turn?.outcome === "completed" ? "in" : "after"} ${duration}, ${kind}`;
}

/** The phone sheet's title: "Finished run", "Failed run", "Run in progress". */
export function runDetailTitle(
  run: Pick<ThreadAutomationRun, "state" | "turn">,
  running = false,
): string {
  switch (runHealth(run, running)) {
    case "delivered":
      return "Delivered run";
    case "finished":
      return "Finished run";
    case "interrupted":
      return "Interrupted run";
    case "failed":
      return "Failed run";
    case "skipped":
      return "Skipped run";
    case "uncertain":
      return "Run with an unknown outcome";
    case "sending":
    case "running":
      return "Run in progress";
  }
}

/**
 * A settled turn's facts for the run detail: its ending with its duration
 * ("Finished · 2m 14s") and, as far as the backend reported them, its times
 * ("Started 3:17:02 AM · ended 3:19:16 AM").
 */
export function runTurnSummary(turn: NonNullable<ThreadAutomationRun["turn"]>): {
  readonly outcome: string;
  readonly times?: string;
} {
  const duration = runTurnDuration(turn);
  const outcome = runStateLabel({ state: "completed", turn });
  const times = [
    turn.startedAt === undefined ? undefined : `started ${clock(new Date(turn.startedAt), true)}`,
    turn.endedAt === undefined ? undefined : `ended ${clock(new Date(turn.endedAt), true)}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return {
    outcome: duration === undefined ? outcome : `${outcome} · ${duration}`,
    ...(times === "" ? {} : { times: `${times.charAt(0).toUpperCase()}${times.slice(1)}` }),
  };
}
