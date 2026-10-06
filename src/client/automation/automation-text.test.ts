import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadAutomationRun } from "../../shared/index.js";
import {
  automationErrorText,
  describeSchedule,
  lastRunAge,
  runMeta,
  runSkipReason,
  runStateLabel,
} from "./automation-text.js";

afterEach(() => {
  vi.useRealTimers();
});

function cron(expression: string, timeZone = "UTC") {
  return describeSchedule({ kind: "cron", expression, timeZone });
}

/** The viewer-locale clock the describer prints for a wall-clock time. */
function clock(hour: number, minute: number): string {
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

describe("describeSchedule: cron", () => {
  it("describes a fixed time every day, weekday and day-of-week list", () => {
    expect(cron("0 2 * * *")).toBe(`Every day at ${clock(2, 0)} UTC`);
    expect(cron("30 6 * * 1-5")).toBe(`Every weekday at ${clock(6, 30)} UTC`);
    expect(cron("0 9 * * 1")).toBe(`Every Monday at ${clock(9, 0)} UTC`);
    expect(cron("0 9 * * MON,thu")).toBe(`Every Monday and Thursday at ${clock(9, 0)} UTC`);
    expect(cron("15 17 * * 5,1,3")).toBe(
      `Every Monday, Wednesday and Friday at ${clock(17, 15)} UTC`,
    );
    expect(cron("0 10 * * 0,6")).toBe(`Every Saturday and Sunday at ${clock(10, 0)} UTC`);
  });

  it("reads Sunday as 0 or 7, names and ranges, and folds full weeks", () => {
    expect(cron("0 8 * * 7")).toBe(`Every Sunday at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 7-7")).toBe(`Every Sunday at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 07-07")).toBe(`Every Sunday at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 06-07")).toBe(`Every Saturday and Sunday at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 0-7")).toBe(`Every day at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 5-7")).toBe(
      `Every Friday, Saturday and Sunday at ${clock(8, 0)} UTC`,
    );
    expect(cron("0 8 * * MON-FRI")).toBe(`Every weekday at ${clock(8, 0)} UTC`);
    expect(cron("0 8 * * 0-6")).toBe(`Every day at ${clock(8, 0)} UTC`);
    expect(cron("0 8 ? * *")).toBe(`Every day at ${clock(8, 0)} UTC`);
    expect(cron("00 08 * * 1-3,4,5")).toBe(`Every weekday at ${clock(8, 0)} UTC`);
  });

  it("names the schedule's own zone and prints its wall-clock time as written", () => {
    expect(cron("0 9 * * 1-5", "Europe/Berlin")).toBe(
      `Every weekday at ${clock(9, 0)} Europe/Berlin`,
    );
    expect(cron("0 2 * * *", "Etc/UTC")).toBe(`Every day at ${clock(2, 0)} UTC`);
  });

  it("is DST-safe: the sentence does not depend on the date or the clock change", () => {
    // 2:30 AM does not exist in New York on the spring-forward day; the
    // schedule's wall-clock time is still what the user wrote.
    const expected = `Every day at ${clock(2, 30)} America/New_York`;
    for (const day of ["2026-03-08T07:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-07-01T12:00:00.000Z"]) {
      vi.useFakeTimers({ now: new Date(day) });
      expect(cron("30 2 * * *", "America/New_York")).toBe(expected);
    }
  });

  it("describes minute and hour steps that divide evenly, and fixed minutes past every hour", () => {
    expect(cron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(cron("*/5 * * * ?")).toBe("Every 5 minutes");
    expect(cron("0 */4 * * *")).toBe("Every 4 hours");
    expect(cron("15 */6 * * *")).toBe("Every 6 hours at :15");
    expect(cron("0 * * * *")).toBe("Every hour");
    expect(cron("5 * * * *")).toBe("Every hour at :05");
    expect(cron("0 */1 * * *")).toBe("Every hour");
  });

  it("collapses whitespace in the fallback", () => {
    expect(cron("  0   9 1 * *  ")).toBe("Cron 0 9 1 * * (UTC)");
  });

  it.each([
    ["0 9 1 * *", "a day of month"],
    ["0 9 * 1 *", "a month"],
    ["*/7 * * * *", "an uneven minute step"],
    ["0 */5 * * *", "an uneven hour step"],
    ["*/15 9 * * *", "a minute step inside one hour"],
    ["0 */4 * * 1-5", "an hour step on some days"],
    ["5,35 * * * *", "a minute list"],
    ["0 9,17 * * *", "an hour list"],
    ["0 9-17 * * *", "an hour range"],
    ["0 9 * * 1-5/2", "a day-of-week step"],
    ["0 9 * * 5L", "a last-weekday token"],
    ["0 9 * * 1#2", "an nth-weekday token"],
    ["0 9 * * 5-1", "a reversed range"],
    ["60 9 * * *", "an out-of-range minute"],
    ["0 24 * * *", "an out-of-range hour"],
    ["0 9 * *", "four fields"],
  ])("falls back for %s (%s)", (expression) => {
    expect(cron(expression, "Europe/Berlin")).toBe(
      `Cron ${expression} (Europe/Berlin)`,
    );
  });
});

describe("describeSchedule: interval", () => {
  const interval = (everySeconds: number, anchorAt = "2026-10-06T04:00:00.000Z") =>
    describeSchedule({ kind: "interval", everySeconds, anchorAt });

  it("describes minutes, hours and odd seconds", () => {
    expect(interval(300)).toBe("Every 5 minutes");
    expect(interval(5_400)).toBe("Every 90 minutes");
    expect(interval(3_600)).toBe("Every hour");
    expect(interval(4 * 3_600)).toBe("Every 4 hours");
    expect(interval(301)).toBe("Every 301 seconds");
  });

  it("gives whole-day intervals their time of day in UTC, where it is stable", () => {
    expect(interval(86_400)).toBe(`Every day at ${clock(4, 0)} UTC`);
    expect(interval(7 * 86_400, "2026-10-06T21:45:00.000Z")).toBe(
      `Every 7 days at ${clock(21, 45)} UTC`,
    );
  });
});

describe("describeSchedule: date_time", () => {
  it("prints a one-shot in local time, adding the year only when it differs", () => {
    const runAt = "2026-10-09T21:00:00.000Z";
    const now = new Date("2026-10-06T03:40:00.000Z");
    const local = new Date(runAt);
    expect(describeSchedule({ kind: "date_time", runAt }, now)).toBe(
      `Once · ${local.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    );
    const nextYear = "2027-10-09T21:00:00.000Z";
    expect(describeSchedule({ kind: "date_time", runAt: nextYear }, now)).toBe(
      `Once · ${new Date(nextYear).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`,
    );
  });
});

function makeRun(overrides: Partial<ThreadAutomationRun> = {}): ThreadAutomationRun {
  return {
    id: "6f0f8f9e-3c55-4c55-9a55-0c7f0a1b2c3d",
    occurrence: "scheduled",
    scheduledFor: "2026-10-06T02:00:00.000Z",
    state: "completed",
    runMode: "same_thread",
    coalescedCount: 0,
    definitionRevision: 1,
    ...overrides,
  };
}

function precheck(
  overrides: Partial<NonNullable<ThreadAutomationRun["precheck"]>> = {},
): NonNullable<ThreadAutomationRun["precheck"]> {
  return {
    status: "passed",
    command: "test -f package-lock.json",
    timeoutSeconds: 30,
    durationMilliseconds: 20,
    stdoutBytes: 0,
    stdoutIncluded: false,
    exitCode: 0,
    ...overrides,
  };
}

describe("runStateLabel", () => {
  it.each([
    ["claimed", "Starting"],
    ["dispatching", "Starting"],
    ["queued", "Waiting for turn"],
    ["running", "Sending"],
    ["completed", "Delivered"],
    ["failed", "Failed"],
    ["skipped", "Skipped"],
    ["uncertain", "Outcome unknown"],
  ] as const)("labels %s as %s", (state, label) => {
    expect(runStateLabel({ state })).toBe(label);
  });

  it("says Checking while the precheck runs", () => {
    expect(runStateLabel(makeRun({ state: "claimed", precheck: precheck({ status: "checking" }) }))).toBe("Checking");
    expect(runStateLabel(makeRun({ state: "claimed", precheck: precheck({ status: "pending" }) }))).toBe("Starting");
  });
});

describe("runSkipReason", () => {
  it("explains each skip", () => {
    expect(
      runSkipReason(makeRun({ state: "skipped", errorCode: "automation_precheck_nonzero", precheck: precheck({ status: "skipped", exitCode: 1 }) })),
    ).toBe("precheck exit 1");
    expect(
      runSkipReason(makeRun({ state: "skipped", errorCode: "automation_precheck_nonzero" })),
    ).toBe("precheck said skip");
    expect(runSkipReason(makeRun({ state: "skipped", errorCode: "automation_misfire_skipped" }))).toBe(
      "missed while Sedes was down",
    );
    expect(runSkipReason(makeRun({ state: "skipped", errorCode: "automation_snoozed" }))).toBe(
      "thread was snoozed",
    );
  });

  it("is undefined for runs that were not skipped or have no known reason", () => {
    expect(runSkipReason(makeRun({ state: "failed", errorCode: "automation_snoozed" }))).toBeUndefined();
    expect(runSkipReason(makeRun({ state: "skipped" }))).toBeUndefined();
    expect(runSkipReason({ state: "skipped", errorCode: "something_else" })).toBeUndefined();
  });
});

describe("runMeta", () => {
  it("leads with the kind and adds merged misses and the precheck", () => {
    expect(runMeta(makeRun({ occurrence: "manual" }))).toBe("Manual");
    expect(
      runMeta(makeRun({ coalescedCount: 2, precheck: precheck({ durationMilliseconds: 210 }) })),
    ).toBe("Scheduled · missed ×2 merged · precheck passed · 210 ms");
  });

  it("names a precheck skip once, with its duration", () => {
    expect(
      runMeta(
        makeRun({
          occurrence: "manual",
          state: "skipped",
          errorCode: "automation_precheck_nonzero",
          precheck: precheck({ status: "skipped", exitCode: 1, durationMilliseconds: 18 }),
        }),
      ),
    ).toBe("Manual · precheck exit 1 · 18 ms");
    expect(
      runMeta(makeRun({ state: "skipped", precheck: precheck({ status: "skipped", durationMilliseconds: 18 }) })),
    ).toBe("Scheduled · precheck skipped the run · 18 ms");
  });

  it("leaves out a precheck that never ran", () => {
    expect(
      runMeta(
        makeRun({
          state: "skipped",
          errorCode: "automation_snoozed",
          precheck: precheck({ status: "pending", durationMilliseconds: 0 }),
        }),
      ),
    ).toBe("Scheduled · thread was snoozed");
    expect(
      runMeta(makeRun({ state: "claimed", precheck: precheck({ status: "checking" }) })),
    ).toBe("Scheduled");
  });

  it("describes precheck failures with their duration", () => {
    expect(
      runMeta(
        makeRun({
          occurrence: "manual",
          state: "failed",
          errorCode: "automation_precheck_timed_out",
          precheck: precheck({ status: "failed", durationMilliseconds: 1_000 }),
        }),
      ),
    ).toBe("Manual · precheck timed out after 1 s");
    expect(
      runMeta(
        makeRun({
          state: "failed",
          errorCode: "automation_precheck_stdout_nul",
          precheck: precheck({ status: "failed", durationMilliseconds: 1_540 }),
        }),
      ),
    ).toBe("Scheduled · precheck failed after 1.5 s");
    expect(
      runMeta(
        makeRun({
          state: "failed",
          errorCode: "automation_precheck_timed_out",
          precheck: precheck({ status: "failed", durationMilliseconds: 30_400 }),
        }),
      ),
    ).toBe("Scheduled · precheck timed out after 30 s");
  });
});

describe("lastRunAge", () => {
  const now = Date.parse("2026-10-06T03:40:00.000Z");
  it("measures from the finish time, else the due time", () => {
    expect(
      lastRunAge(
        { id: "r", state: "failed", occurrence: "scheduled", scheduledFor: "2026-10-05T06:30:00.000Z", finishedAt: "2026-10-05T06:40:00.000Z" },
        now,
      ),
    ).toBe("21h ago");
    expect(
      lastRunAge({ id: "r", state: "uncertain", occurrence: "manual", scheduledFor: "2026-10-06T03:39:30.000Z" }, now),
    ).toBe("just now");
  });
});

describe("automationErrorText", () => {
  it.each([
    "automation_dispatch_uncertain",
    "automation_dispatch_failed",
    "automation_dispatch_cancelled",
    "automation_dispatch_rejected",
    "automation_uncertain_resolved",
    "automation_snoozed",
    "automation_misfire_skipped",
    "automation_precheck_nonzero",
    "automation_precheck_execution_failed",
    "automation_precheck_unavailable",
    "automation_precheck_interrupted",
    "automation_precheck_timed_out",
    "automation_precheck_cancelled",
    "automation_precheck_signalled",
    "automation_precheck_stdout_too_large",
    "automation_precheck_stdout_invalid_utf8",
    "automation_precheck_stdout_nul",
    "automation_precheck_prompt_too_large",
    "automation_backend_unavailable",
    "automation_backend_permission_denied",
    "automation_backend_incompatible",
    "automation_checkpoint_unavailable",
    "automation_anchor_archived",
    "automation_anchor_materializing",
    "automation_anchor_unavailable",
    "automation_anchor_needs_input",
    "automation_run_conflict",
    "force_reset",
  ])("maps the server code %s to its own sentence", (code) => {
    const text = automationErrorText(code);
    expect(text).toMatch(/^[A-Z].*\.$/u);
    expect(text).not.toContain("_");
    expect(text).not.toBe(automationErrorText("unmapped_code"));
    expect(text).not.toBe(automationErrorText("automation_precheck_unmapped"));
  });

  it("gives specific copy for the codes users meet most", () => {
    expect(automationErrorText("automation_dispatch_uncertain")).toBe(
      "Sedes can't tell whether the prompt reached the agent.",
    );
    expect(automationErrorText("automation_precheck_nonzero")).toBe(
      "The precheck exited non-zero, so the agent was not run.",
    );
  });

  it("falls back generically for backend and runtime failure codes", () => {
    expect(automationErrorText("runtime_unavailable")).toBe("The run failed in the backend.");
    expect(automationErrorText("automation_backend_something_new")).toBe(
      "The run failed in the backend.",
    );
    expect(automationErrorText("automation_precheck_something_new")).toBe(
      "The precheck failed.",
    );
  });
});
