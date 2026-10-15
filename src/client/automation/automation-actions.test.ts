import { describe, expect, it } from "vitest";
import { definition } from "../components/automation/automation-test-fixture.js";
import type { NormalizedThreadSummary } from "../../shared/index.js";
import { automationActionAvailability, uncertainRunResolution } from "./automation-actions.js";
import { automationHealth, type SummaryAutomation, type SummaryAutomationRun } from "./automation-health.js";

const NOW = Date.parse("2026-10-06T03:40:00.000Z");

function automation(overrides: Partial<SummaryAutomation> = {}): SummaryAutomation {
  return definition({
    revision: 1, runsRevision: 0,
    prompt: "Check dependencies",
    nextRunAt: "2026-10-07T02:00:00.000Z",
    ...(overrides.lastRun?.state === "failed" || overrides.lastRun?.state === "uncertain"
      ? { attention: { runId: overrides.lastRun.id, kind: overrides.lastRun.state } }
      : {}),
    ...overrides,
  });
}

function lastRun(state: SummaryAutomationRun["state"]): SummaryAutomationRun {
  return { id: "run-1", state, occurrence: "scheduled", scheduledFor: "2026-10-06T02:00:00.000Z" };
}

function actions(
  summary: SummaryAutomation,
  inventory: Partial<Pick<NormalizedThreadSummary, "inventoryState" | "snoozedUntil">> = {},
  capability?: { available: boolean; unavailableReason?: string },
) {
  const thread = { inventoryState: "active" as const, automation: summary, ...inventory };
  return automationActionAvailability(thread, automationHealth(thread, NOW), capability);
}

const allowed = { available: true };

describe("automationActionAvailability", () => {
  it("allows everything on an active, failed or paused automation", () => {
    for (const summary of [automation(), automation({ lastRun: lastRun("failed") })]) {
      expect(actions(summary)).toEqual({
        runNow: allowed,
        toggle: { action: "pause", available: true },
        edit: allowed,
        remove: allowed,
      });
    }
    expect(actions(automation({ status: "paused" })).toggle).toEqual({ action: "enable", available: true });
  });

  it("blocks running, the schedule switch, editing and deleting while the outcome is unknown", () => {
    const blocked = { available: false, reason: "Resolve the unknown run first", hint: "Outcome unknown" };
    expect(actions(automation({ status: "paused", lastRun: lastRun("uncertain") }))).toEqual({
      runNow: blocked,
      toggle: { action: "enable", ...blocked },
      edit: blocked,
      remove: blocked,
    });
  });

  it("blocks running, the schedule switch and deleting while a run is in flight, not editing", () => {
    const blocked = { available: false, reason: "Wait for the current run to finish", hint: "Sending" };
    expect(actions(automation({ lastRun: lastRun("running") }))).toEqual({
      runNow: blocked,
      toggle: { action: "pause", ...blocked },
      edit: allowed,
      remove: blocked,
    });
    expect(actions(automation({ lastRun: lastRun("queued") })).runNow.hint).toBe("Waiting for turn");
  });

  it("lets an archived anchor's schedule be paused, but not run, enabled or edited", () => {
    const blocked = { available: false, reason: "Restore the thread first", hint: "Thread archived" };
    expect(actions(automation(), { inventoryState: "archived" })).toEqual({
      runNow: blocked,
      toggle: { action: "pause", available: true },
      edit: blocked,
      remove: allowed,
    });
    expect(actions(automation({ status: "paused" }), { inventoryState: "archived" }).toggle).toEqual({
      action: "enable",
      ...blocked,
    });
    // Archived with a failed last run is still archived.
    expect(actions(automation({ lastRun: lastRun("failed") }), { inventoryState: "archived" }).runNow).toEqual(blocked);
  });

  it("blocks only Run now on a snoozed anchor", () => {
    expect(
      actions(automation(), { inventoryState: "snoozed", snoozedUntil: "2026-10-08T00:00:00.000Z" }),
    ).toEqual({
      runNow: { available: false, reason: "Unsnooze the thread first", hint: "Snoozed" },
      toggle: { action: "pause", available: true },
      edit: allowed,
      remove: allowed,
    });
  });

  it("adds the capability's verdict where the surface has read it", () => {
    const blocked = { available: false, reason: "The backend is disconnected.", hint: "Unavailable" };
    const result = actions(automation({ status: "paused" }), {}, {
      available: false,
      unavailableReason: "The backend is disconnected.",
    });
    expect(result).toEqual({
      runNow: blocked,
      toggle: { action: "enable", ...blocked },
      edit: blocked,
      remove: allowed,
    });
    expect(actions(automation(), {}, { available: false }).toggle).toEqual({ action: "pause", available: true });
  });
});

describe("uncertainRunResolution", () => {
  const once = (runAt: string) => ({ kind: "date_time" as const, runAt });
  const uncertain = (occurrence: "scheduled" | "manual"): SummaryAutomationRun => ({
    ...lastRun("uncertain"),
    occurrence,
  });

  it("ends a one-time automation whose scheduled run is resolved", () => {
    expect(
      uncertainRunResolution({ schedule: once("2026-10-06T02:00:00.000Z"), lastRun: uncertain("scheduled") }, NOW),
    ).toBe("ends");
  });

  it("keeps a one-time automation after a manual run, resumable while its time is ahead", () => {
    expect(
      uncertainRunResolution({ schedule: once("2026-10-09T09:00:00.000Z"), lastRun: uncertain("manual") }, NOW),
    ).toBe("choose");
    // Its time has passed: enabling has no future run to schedule.
    expect(
      uncertainRunResolution({ schedule: once("2026-10-06T02:00:00.000Z"), lastRun: uncertain("manual") }, NOW),
    ).toBe("stays_paused");
  });

  it("lets a recurring automation resume or stay paused, and says nothing without an uncertain run", () => {
    const cron = automation().schedule;
    expect(uncertainRunResolution({ schedule: cron, lastRun: uncertain("scheduled") }, NOW)).toBe("choose");
    expect(uncertainRunResolution({ schedule: cron, lastRun: uncertain("manual") }, NOW)).toBe("choose");
    expect(uncertainRunResolution({ schedule: cron, lastRun: lastRun("failed") }, NOW)).toBeUndefined();
  });
});

describe("deferred and exhausted controls", () => {
  it("allows pausing a pending one-time reminder while its scheduled invocation is deferred", () => {
    const pending = automation({ status: "enabled", scheduleKind: "date_time", schedule: { kind: "date_time", runAt: "2026-10-06T02:00:00.000Z" }, misfirePolicy: null, lastRun: lastRun("deferred") });
    const result = actions(pending);
    expect(result.toggle).toEqual({ action: "pause", available: true });
    expect(result.remove.available).toBe(true);
    expect(result.runNow.available).toBe(false);
  });

  it("allows changing or removing waiting work without admitting a second run", () => {
    const result = actions(automation({ lastRun: lastRun("deferred") }));
    expect(result.runNow.available).toBe(false);
    expect(result.edit).toEqual(allowed);
    expect(result.remove).toEqual(allowed);
    expect(result.toggle).toEqual({ action: "pause", available: true });
  });

  it("keeps active-run controls blocked when older failure attention takes precedence", () => {
    const result = actions(automation({
      lastRun: lastRun("queued"),
      attention: { runId: "older-failure", kind: "failed" },
    }));
    expect(result.runNow.available).toBe(false);
    expect(result.remove.available).toBe(false);
  });

  it("permits manual invocation and editing of an exhausted one-shot, without blindly enabling it", () => {
    const result = actions(automation({ status: "exhausted", nextRunAt: undefined }));
    expect(result.runNow).toEqual(allowed);
    expect(result.edit).toEqual(allowed);
    expect(result.toggle.available).toBe(false);
  });
});
