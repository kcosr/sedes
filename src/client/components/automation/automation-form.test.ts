import { describe, expect, it } from "vitest";
import { localDateTimeValue } from "../../lib/time.js";
import {
  defaultAutomationForm,
  formFromDefinition,
  nextWholeHour,
  precheckFromForm,
  sameAutomationForm,
  scheduleFromForm,
} from "./automation-form.js";
import { definition } from "./automation-test-fixture.js";

const NOW = new Date(2026, 9, 6, 3, 40, 12);

describe("automation form", () => {
  it("starts a new automation every day from the next whole hour", () => {
    const form = defaultAutomationForm(NOW);
    expect(nextWholeHour(NOW)).toBe(localDateTimeValue(new Date(2026, 9, 6, 4, 0)));
    expect(form).toMatchObject({
      prompt: "",
      runMode: "same_thread",
      scheduleKind: "interval",
      intervalAmount: 1,
      intervalUnit: "days",
      intervalStart: nextWholeHour(NOW),
      misfirePolicy: "coalesce",
      precheckEnabled: false,
    });
    expect(scheduleFromForm(form)).toEqual({
      kind: "interval",
      anchorAt: new Date(2026, 9, 6, 4, 0).toISOString(),
      everySeconds: 86_400,
    });
  });

  it("reads a saved interval in its largest even unit", () => {
    const anchorAt = "2026-10-06T02:00:30.000Z";
    for (const [everySeconds, amount, unit] of [
      [172_800, 2, "days"],
      [7_200, 2, "hours"],
      [5_400, 90, "minutes"],
    ] as const) {
      const form = formFromDefinition(
        definition({ schedule: { kind: "interval", anchorAt, everySeconds } }),
        NOW,
      );
      expect(form).toMatchObject({ scheduleKind: "interval", intervalAmount: amount, intervalUnit: unit });
    }
  });

  it("keeps a saved instant to the second until its field is edited", () => {
    const saved = { kind: "interval", anchorAt: "2026-10-06T02:00:30.000Z", everySeconds: 3_600 } as const;
    const form = formFromDefinition(definition({ schedule: saved }), NOW);
    expect(scheduleFromForm(form, saved)).toEqual(saved);

    const moved = { ...form, intervalStart: localDateTimeValue(new Date(2026, 9, 7, 9, 0)) };
    expect(scheduleFromForm(moved, saved)).toEqual({
      ...saved,
      anchorAt: new Date(2026, 9, 7, 9, 0).toISOString(),
    });
  });

  it("describes nothing while a schedule field is incomplete", () => {
    const form = defaultAutomationForm(NOW);
    expect(scheduleFromForm({ ...form, intervalAmount: Number.NaN })).toBeUndefined();
    expect(scheduleFromForm({ ...form, scheduleKind: "date_time", dateTime: "" })).toBeUndefined();
    expect(scheduleFromForm({ ...form, scheduleKind: "cron", cronExpression: "  " })).toBeUndefined();
    expect(scheduleFromForm({ ...form, scheduleKind: "cron", cronExpression: " 0 3 * * * " })).toEqual({
      kind: "cron",
      expression: "0 3 * * *",
      timeZone: form.timeZone,
    });
  });

  it("reads a cron definition with its zone and precheck", () => {
    const form = formFromDefinition(
      definition({
        schedule: { kind: "cron", expression: "0 3 * * 1-5", timeZone: "Europe/Berlin" },
        misfirePolicy: "skip",
        precheck: { command: "test -f .ready", timeoutSeconds: 12, includeStdout: true },
      }),
      NOW,
    );
    expect(form).toMatchObject({
      scheduleKind: "cron",
      cronExpression: "0 3 * * 1-5",
      timeZone: "Europe/Berlin",
      misfirePolicy: "skip",
      precheckEnabled: true,
      precheckCommand: "test -f .ready",
      precheckTimeout: 12,
      precheckIncludeStdout: true,
    });
  });

  it("checks an enabled precheck before it describes one", () => {
    const form = { ...defaultAutomationForm(NOW), precheckEnabled: true };
    expect(precheckFromForm({ ...form, precheckEnabled: false })).toEqual({ precheck: null, valid: true });
    expect(precheckFromForm({ ...form, precheckCommand: "  " })).toEqual({ precheck: null, valid: false });
    expect(precheckFromForm({ ...form, precheckCommand: "true", precheckTimeout: 61 })).toEqual({
      precheck: null,
      valid: false,
    });
    expect(precheckFromForm({ ...form, precheckCommand: "x".repeat(4_097) }).valid).toBe(false);
    expect(precheckFromForm({ ...form, precheckCommand: " true ", precheckTimeout: 5 })).toEqual({
      precheck: { command: "true", timeoutSeconds: 5, includeStdout: false },
      valid: true,
    });
  });

  it("calls two forms the same when they would save the same automation", () => {
    const form = defaultAutomationForm(NOW);
    // Fields of another schedule kind, a one-shot's misfire policy and an
    // off precheck's command do not count; the prompt counts trimmed.
    expect(sameAutomationForm(form, { ...form, cronExpression: "5 5 * * *" })).toBe(true);
    expect(sameAutomationForm(form, { ...form, prompt: "  " })).toBe(true);
    expect(sameAutomationForm(form, { ...form, precheckCommand: "true" })).toBe(true);
    const once = { ...form, scheduleKind: "date_time" as const };
    expect(sameAutomationForm(once, { ...once, misfirePolicy: "skip" })).toBe(true);

    expect(sameAutomationForm(form, { ...form, misfirePolicy: "skip" })).toBe(false);
    expect(sameAutomationForm(form, { ...form, intervalUnit: "hours" })).toBe(false);
    expect(sameAutomationForm(form, { ...form, prompt: "Check" })).toBe(false);
    expect(sameAutomationForm(form, { ...form, precheckEnabled: true })).toBe(false);
    expect(sameAutomationForm(form, { ...form, intervalAmount: Number.NaN })).toBe(false);
  });
});
