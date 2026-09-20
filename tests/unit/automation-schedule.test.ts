import { describe, expect, it } from "vitest";
import {
  AutomationScheduleEvaluator,
  AutomationScheduleValidationError,
  CronScheduleEvaluator,
  MAX_AUTOMATION_INTERVAL_SECONDS,
  MIN_AUTOMATION_INTERVAL_SECONDS,
  automationScheduleSchema,
  coalesceIntervalOccurrences,
} from "../../src/server/domain/automation-schedule.js";

const evaluator = new AutomationScheduleEvaluator();

describe("automation schedule schema", () => {
  it("accepts only the three strict canonical shapes", () => {
    expect(
      automationScheduleSchema.parse({
        kind: "date_time",
        runAt: 1_000,
      }),
    ).toEqual({ kind: "date_time", runAt: 1_000 });
    expect(
      automationScheduleSchema.parse({
        kind: "interval",
        anchorAt: 1_000,
        everySeconds: MIN_AUTOMATION_INTERVAL_SECONDS,
      }),
    ).toEqual({
      kind: "interval",
      anchorAt: 1_000,
      everySeconds: MIN_AUTOMATION_INTERVAL_SECONDS,
    });
    expect(
      automationScheduleSchema.parse({
        kind: "cron",
        expression: "  0   9  * * MON-FRI ",
        timeZone: "America/Chicago",
      }),
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * MON-FRI",
      timeZone: "America/Chicago",
    });

    for (const invalid of [
      { kind: "once", runAt: 1_000 },
      { kind: "date_time", runAt: 1_000, timeZone: "UTC" },
      {
        kind: "interval",
        anchorAt: 1_000,
        everySeconds: MIN_AUTOMATION_INTERVAL_SECONDS,
        unit: "minutes",
      },
      { kind: "cron", expression: "@hourly", timeZone: "UTC" },
      { kind: "cron", expression: "0 0 0 * * *", timeZone: "UTC" },
      { kind: "cron", expression: "0 0 * *", timeZone: "UTC" },
      { kind: "cron", expression: "0 0 * * *", timeZone: "UTC+2" },
    ]) {
      expect(automationScheduleSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("enforces finite safe epoch milliseconds and interval bounds", () => {
    for (const runAt of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        automationScheduleSchema.safeParse({ kind: "date_time", runAt })
          .success,
      ).toBe(false);
    }
    for (const everySeconds of [
      0,
      299,
      300.5,
      MAX_AUTOMATION_INTERVAL_SECONDS + 1,
    ]) {
      expect(
        automationScheduleSchema.safeParse({
          kind: "interval",
          anchorAt: 0,
          everySeconds,
        }).success,
      ).toBe(false);
    }
  });
});

describe("AutomationScheduleEvaluator", () => {
  it("treats Date & time as a single strict-future occurrence", () => {
    const schedule = { kind: "date_time" as const, runAt: 5_000 };
    expect(evaluator.nextOccurrence(schedule, 4_999)).toBe(5_000);
    expect(evaluator.nextOccurrence(schedule, 5_000)).toBeNull();
    expect(evaluator.preview(schedule, 0)).toEqual([5_000]);
  });

  it("calculates interval occurrences arithmetically without drift", () => {
    const schedule = {
      kind: "interval" as const,
      anchorAt: 1_234,
      everySeconds: 300,
    };
    expect(evaluator.nextOccurrence(schedule, 0)).toBe(1_234);
    expect(evaluator.nextOccurrence(schedule, 1_234)).toBe(301_234);
    expect(evaluator.nextOccurrence(schedule, 901_233)).toBe(901_234);
    expect(evaluator.nextOccurrence(schedule, 901_234)).toBe(1_201_234);
    expect(evaluator.preview(schedule, 1_234)).toEqual([
      301_234, 601_234, 901_234, 1_201_234, 1_501_234,
    ]);
  });

  it("coalesces missed intervals in constant arithmetic work", () => {
    const schedule = {
      kind: "interval" as const,
      anchorAt: 1_000,
      everySeconds: 300,
    };
    expect(coalesceIntervalOccurrences(schedule, 1_000, 900_999)).toEqual({
      scheduledAt: 601_000,
      coalescedCount: 1,
      nextRunAt: 901_000,
    });
    expect(coalesceIntervalOccurrences(schedule, 900_999, 901_000)).toEqual({
      scheduledAt: 901_000,
      coalescedCount: 0,
      nextRunAt: 1_201_000,
    });
    expect(coalesceIntervalOccurrences(schedule, 901_000, 901_000)).toBeNull();
  });

  it("bounds preview count and timestamp inputs", () => {
    expect(() =>
      evaluator.preview({ kind: "date_time", runAt: 1_000 }, 0, 33),
    ).toThrow(AutomationScheduleValidationError);
    expect(() =>
      evaluator.nextOccurrence({ kind: "date_time", runAt: 1_000 }, -1),
    ).toThrow(AutomationScheduleValidationError);
  });
});

describe("CronScheduleEvaluator", () => {
  const cron = new CronScheduleEvaluator();

  it("validates grammar, IANA zones, and normalizes whitespace", () => {
    expect(cron.validate(" 0  9 * * MON-FRI ", "America/New_York")).toBe(
      "0 9 * * MON-FRI",
    );
    for (const [expression, timeZone] of [
      ["@daily", "UTC"],
      ["0 0 0 * * *", "UTC"],
      ["H 9 * * *", "UTC"],
      ["0 24 * * *", "UTC"],
      ["0 0 31 2 *", "UTC"],
      ["0 0 * * *", "Not/AZone"],
    ] as const) {
      expect(() => cron.validate(expression, timeZone)).toThrow(
        AutomationScheduleValidationError,
      );
    }
  });

  it("rejects evaluated frequencies below five minutes", () => {
    expect(() => cron.validate("*/4 * * * *", "UTC")).toThrowError(
      expect.objectContaining({ code: "cron_too_frequent" }),
    );
    expect(cron.validate("*/5 * * * *", "UTC")).toBe("*/5 * * * *");
  });

  it("returns the next five UTC occurrences in the stored IANA zone", () => {
    const after = Date.parse("2026-01-05T14:00:00.000Z");
    expect(cron.preview("30 9 * * MON-FRI", "America/New_York", after)).toEqual([
      Date.parse("2026-01-05T14:30:00.000Z"),
      Date.parse("2026-01-06T14:30:00.000Z"),
      Date.parse("2026-01-07T14:30:00.000Z"),
      Date.parse("2026-01-08T14:30:00.000Z"),
      Date.parse("2026-01-09T14:30:00.000Z"),
    ]);
  });

  it("skips a nonexistent spring-forward wall time", () => {
    const after = Date.parse("2026-03-07T08:00:00.000Z");
    expect(cron.preview("30 2 * * *", "America/New_York", after, 3)).toEqual([
      Date.parse("2026-03-09T06:30:00.000Z"),
      Date.parse("2026-03-10T06:30:00.000Z"),
      Date.parse("2026-03-11T06:30:00.000Z"),
    ]);
  });

  it("does not lose valid post-transition wall times", () => {
    const after = Date.parse("2026-03-08T06:30:00.000Z");
    expect(cron.nextOccurrence("1 3 * * *", "America/New_York", after)).toBe(
      Date.parse("2026-03-08T07:01:00.000Z"),
    );
  });

  it("runs a repeated fall-back wall time once at the earlier instant", () => {
    const beforeOverlap = Date.parse("2026-11-01T04:00:00.000Z");
    const first = cron.nextOccurrence(
      "30 1 * * *",
      "America/New_York",
      beforeOverlap,
    );
    expect(first).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
    expect(
      cron.nextOccurrence("30 1 * * *", "America/New_York", first!),
    ).toBe(Date.parse("2026-11-02T06:30:00.000Z"));
  });

  it("rejects a schedule compressed below five minutes by spring DST", () => {
    expect(() =>
      cron.validate("1,58 1,3 * * *", "America/New_York"),
    ).toThrowError(expect.objectContaining({ code: "cron_too_frequent" }));
  });
});
