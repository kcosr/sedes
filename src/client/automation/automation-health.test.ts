import { describe, expect, it } from "vitest";
import { definition } from "../components/automation/automation-test-fixture.js";
import {
  AUTOMATION_HEALTH_GROUPS,
  AUTOMATION_HEALTH_GROUP_LABELS,
  automationHealth,
  automationDefinitionGlyph,
  automationIdentityGlyph,
  automationIdentityLabel,
  automationNeedsAttention,
  compareAutomationsInGroup,
  lastRunAt,
  threadRunPhase,
  threadAutomationHealth,
  type AutomationHealthThread,
  type AutomationSortSubject,
  type SummaryAutomation,
  type SummaryAutomationRun,
} from "./automation-health.js";

const NOW = Date.parse("2026-10-06T03:40:00.000Z");

function run(
  state: SummaryAutomationRun["state"],
  overrides: Partial<SummaryAutomationRun> = {},
): SummaryAutomationRun {
  return {
    id: `run-${state}`,
    state,
    occurrence: "scheduled",
    scheduledFor: "2026-10-06T02:00:00.000Z",
    ...overrides,
  };
}

function automation(
  overrides: Partial<SummaryAutomation> = {},
): SummaryAutomation {
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

function thread(
  overrides: Partial<AutomationHealthThread> = {},
): AutomationHealthThread {
  return {
    automation: automation(),
    inventoryState: "active",
    ...overrides,
  };
}

describe("automationHealth", () => {
  it("is undefined without an automation", () => {
    expect(automationHealth(thread({ automation: null }), NOW)).toBeUndefined();
  });

  it.each(["claimed", "dispatching", "running"] as const)(
    "a %s run is sending, ahead of every other state",
    (state) => {
      expect(
        automationHealth(
          thread({
            inventoryState: "archived",
            automation: automation({ status: "paused", lastRun: run(state) }),
          }),
          NOW,
        ),
      ).toEqual({
        kind: "sending",
        group: "upcoming",
        glyph: "spinner",
        tone: "info",
        label: "Sending",
      });
    },
  );

  it("a queued run is waiting for its turn", () => {
    expect(
      automationHealth(
        thread({ automation: automation({ lastRun: run("queued") }) }),
        NOW,
      ),
    ).toMatchObject({ kind: "sending", label: "Waiting for turn" });
  });

  it("a failed last run needs attention in the danger tone", () => {
    expect(
      automationHealth(
        thread({
          inventoryState: "archived",
          automation: automation({ lastRun: run("failed") }),
        }),
        NOW,
      ),
    ).toEqual({
      kind: "failed",
      group: "needs_attention",
      glyph: "triangle",
      tone: "danger",
      label: "Failed",
    });
  });

  it("a delivered run whose turn failed or was interrupted stays active, without attention", () => {
    for (const outcome of ["failed", "interrupted", "completed"] as const) {
      const delivered = automation({
        lastRun: run("completed", { turn: { outcome, endedAt: "2026-10-06T02:05:00.000Z" } }),
      });
      expect(automationHealth(thread({ automation: delivered }), NOW)).toMatchObject({
        kind: "active",
        group: "upcoming",
        tone: "success",
      });
      expect(automationNeedsAttention(delivered)).toBe(false);
    }
  });

  it("an uncertain last run needs attention even though it paused scheduling", () => {
    expect(
      automationHealth(
        thread({
          automation: automation({ status: "paused", lastRun: run("uncertain") }),
        }),
        NOW,
      ),
    ).toEqual({
      kind: "unknown",
      group: "needs_attention",
      glyph: "triangle",
      tone: "warning",
      label: "Outcome unknown",
    });
  });

  it("an archived anchor suspends the automation", () => {
    expect(
      automationHealth(
        thread({
          inventoryState: "archived",
          automation: automation({ lastRun: run("completed") }),
        }),
        NOW,
      ),
    ).toEqual({
      kind: "archived",
      group: "suspended",
      glyph: "archive",
      tone: "neutral",
      label: "Thread archived",
    });
  });

  it("a snooze with a future wake suspends the automation", () => {
    expect(
      automationHealth(
        thread({
          inventoryState: "snoozed",
          snoozedUntil: "2026-10-06T09:00:00.000Z",
        }),
        NOW,
      ),
    ).toEqual({
      kind: "snoozed",
      group: "suspended",
      glyph: "snoozed",
      tone: "neutral",
      label: "Snoozed",
    });
  });

  it("suspends an open-ended snooze and resumes after a dated snooze lapses", () => {
    expect(
      automationHealth(thread({ inventoryState: "snoozed" }), NOW)?.kind,
    ).toBe("snoozed");
    expect(
      automationHealth(
        thread({
          inventoryState: "snoozed",
          snoozedUntil: "2026-10-06T03:00:00.000Z",
        }),
        new Date(NOW),
      )?.kind,
    ).toBe("active");
    expect(
      automationHealth(
        thread({
          inventoryState: "snoozed",
          snoozedUntil: new Date(NOW).toISOString(),
        }),
        NOW,
      )?.kind,
    ).toBe("snoozed");
  });

  it("an enabled automation is active: a success chip", () => {
    expect(
      automationHealth(
        thread({ automation: automation({ lastRun: run("completed") }) }),
        NOW,
      ),
    ).toEqual({
      kind: "active",
      group: "upcoming",
      glyph: "repeat",
      tone: "success",
      label: "Active",
    });
    expect(
      automationHealth(
        thread({ automation: automation({ lastRun: run("skipped") }) }),
        NOW,
      )?.kind,
    ).toBe("active");
  });

  it("paused is neutral, never a warning, and tells a never-run automation apart", () => {
    expect(
      automationHealth(
        thread({
          automation: automation({ status: "paused", lastRun: run("completed") }),
        }),
        NOW,
      ),
    ).toEqual({
      kind: "paused",
      group: "paused",
      glyph: "pause",
      tone: "neutral",
      label: "Paused",
    });
    expect(
      automationHealth(
        thread({ automation: automation({ status: "paused" }) }),
        NOW,
      ),
    ).toEqual({
      kind: "not_started",
      group: "paused",
      glyph: "pause",
      tone: "neutral",
      label: "Not started",
    });
  });

  it("puts every automation in exactly one list group, in list order", () => {
    expect(AUTOMATION_HEALTH_GROUPS).toEqual([
      "needs_attention",
      "upcoming",
      "paused",
      "suspended",
      "finished",
    ]);
    expect(AUTOMATION_HEALTH_GROUPS.map((group) => AUTOMATION_HEALTH_GROUP_LABELS[group]))
      .toEqual(["Needs attention", "Upcoming", "Paused", "Suspended", "Finished"]);
  });
});

describe("automationNeedsAttention", () => {
  it("uses explicit unresolved delivery attention instead of guessing from the latest run", () => {
    expect(automationNeedsAttention(null)).toBe(false);
    expect(automationNeedsAttention(automation())).toBe(false);
    expect(automationNeedsAttention(automation({ lastRun: run("failed"), attention: undefined }))).toBe(false);
    expect(automationNeedsAttention(automation({ lastRun: run("skipped"), attention: { runId: "older-failure", kind: "failed" } }))).toBe(true);
    for (const state of ["failed", "uncertain"] as const) {
      expect(automationNeedsAttention(automation({ lastRun: run(state) }))).toBe(true);
    }
    for (const state of ["claimed", "queued", "completed", "skipped"] as const) {
      expect(automationNeedsAttention(automation({ lastRun: run(state) }))).toBe(false);
    }
  });
});

describe("automationIdentityGlyph", () => {
  it("keeps Repeat for attention states and pauses suspended ones", () => {
    const glyphFor = (subject: AutomationHealthThread) =>
      automationIdentityGlyph(automationHealth(subject, NOW)!);
    expect(glyphFor(thread())).toBe("repeat");
    expect(glyphFor(thread({ automation: automation({ lastRun: run("failed") }) }))).toBe("repeat");
    expect(
      glyphFor(thread({ automation: automation({ status: "paused", lastRun: run("uncertain") }) })),
    ).toBe("repeat");
    expect(glyphFor(thread({ automation: automation({ lastRun: run("running") }) }))).toBe("spinner");
    expect(glyphFor(thread({ automation: automation({ status: "paused" }) }))).toBe("pause");
    expect(
      glyphFor(thread({ automation: automation({ status: "paused", lastRun: run("completed") }) })),
    ).toBe("pause");
    expect(glyphFor(thread({ inventoryState: "archived" }))).toBe("pause");
    expect(glyphFor(thread({ automation: automation({ status: "exhausted", nextRunAt: undefined }) }))).toBe("finished");
    expect(
      glyphFor(thread({ inventoryState: "snoozed", snoozedUntil: "2026-10-07T00:00:00.000Z" })),
    ).toBe("pause");
  });
});

describe("automationDefinitionGlyph", () => {
  it.each([
    ["enabled", "repeat"],
    ["paused", "pause"],
    ["exhausted", "finished"],
  ] as const)("keeps %s schedule identity independent of live work", (status, glyph) => {
    expect(automationDefinitionGlyph(status)).toBe(glyph);
  });
});

describe("automationIdentityLabel", () => {
  it("names Repeat plainly and a drawn state with its label", () => {
    const labelFor = (subject: AutomationHealthThread) =>
      automationIdentityLabel(automationHealth(subject, NOW)!);
    expect(labelFor(thread())).toBe("Automation");
    expect(labelFor(thread({ automation: automation({ lastRun: run("failed") }) }))).toBe("Automation");
    expect(labelFor(thread({ automation: automation({ status: "paused", lastRun: run("completed") }) }))).toBe(
      "Automation paused",
    );
    expect(labelFor(thread({ automation: automation({ status: "paused" }) }))).toBe("Automation not started");
    expect(labelFor(thread({ automation: automation({ lastRun: run("queued") }) }))).toBe(
      "Automation waiting for turn",
    );
  });
});

describe("lastRunAt", () => {
  it("prefers the finish time over the due time", () => {
    expect(lastRunAt(run("failed"))).toBe("2026-10-06T02:00:00.000Z");
    expect(
      lastRunAt(run("failed", { finishedAt: "2026-10-06T02:00:25.000Z" })),
    ).toBe("2026-10-06T02:00:25.000Z");
  });

  it("prefers the turn's end, when the backend reported it, over the delivery", () => {
    const delivered = { finishedAt: "2026-10-06T02:00:25.000Z" };
    expect(
      lastRunAt(
        run("completed", {
          ...delivered,
          turn: { outcome: "completed", endedAt: "2026-10-06T02:14:00.000Z" },
        }),
      ),
    ).toBe("2026-10-06T02:14:00.000Z");
    expect(
      lastRunAt(run("completed", { ...delivered, turn: { outcome: "interrupted" } })),
    ).toBe("2026-10-06T02:00:25.000Z");
  });
});

describe("threadRunPhase", () => {
  it.each([
    ["idle", "settled"],
    ["failed", "settled"],
    ["starting", "busy"],
    ["running", "busy"],
    ["waiting_for_approval", "busy"],
    ["waiting_for_input", "busy"],
    ["stopping", "busy"],
    ["disconnected", "transitioning"],
    ["reconciling", "transitioning"],
  ] as const)("reads %s as %s", (runState, phase) => {
    expect(threadRunPhase(runState)).toBe(phase);
  });
});

describe("compareAutomationsInGroup", () => {
  function subject(
    id: string,
    title: string,
    overrides: Partial<SummaryAutomation> = {},
  ): AutomationSortSubject {
    return { id, title: { text: title }, automation: automation(overrides) };
  }
  const sorted = (
    group: Parameters<typeof compareAutomationsInGroup>[0],
    subjects: readonly AutomationSortSubject[],
  ) =>
    [...subjects]
      .sort((left, right) => compareAutomationsInGroup(group, left, right))
      .map(({ id }) => id);

  it("orders Upcoming by next run, undated last", () => {
    expect(
      sorted("upcoming", [
        subject("undated", "A", { nextRunAt: undefined }),
        subject("later", "B", { nextRunAt: "2026-10-07T02:00:00.000Z" }),
        subject("sooner", "C", { nextRunAt: "2026-10-06T06:30:00.000Z" }),
      ]),
    ).toEqual(["sooner", "later", "undated"]);
  });

  it("orders Needs attention by the last run, newest first", () => {
    expect(
      sorted("needs_attention", [
        subject("older", "A", { lastRun: run("failed", { scheduledFor: "2026-10-05T06:30:00.000Z" }) }),
        subject("none", "B"),
        subject("newer", "C", {
          lastRun: run("uncertain", {
            scheduledFor: "2026-10-05T00:00:00.000Z",
            finishedAt: "2026-10-06T00:30:00.000Z",
          }),
        }),
      ]),
    ).toEqual(["newer", "older", "none"]);
  });

  it("orders the other groups by title, case-insensitively and numerically, then id", () => {
    expect(
      sorted("paused", [
        subject("b", "report 10"),
        subject("a", "Report 9"),
        subject("c", ""),
        subject("d", "report 10"),
      ]),
    ).toEqual(["a", "b", "d", "c"]);
  });

  it("falls back to title when the group key ties", () => {
    const at = "2026-10-07T02:00:00.000Z";
    expect(
      sorted("upcoming", [subject("z", "Zeta", { nextRunAt: at }), subject("a", "Alpha", { nextRunAt: at })]),
    ).toEqual(["a", "z"]);
  });
});

describe("independent automation attention", () => {
  const finishedSummary = {
    totalCount: 2, enabledCount: 0, pausedCount: 0, exhaustedCount: 2,
    inFlightCount: 0, attentionCount: 0, revision: 10,
  };

  it.each(["active", "snoozed", "archived"] as const)(
    "omits thread status for finished history on a %s source",
    (inventoryState) => {
      expect(threadAutomationHealth({ inventoryState, automations: finishedSummary }, NOW)).toBeUndefined();
    },
  );

  it("keeps ongoing work and unresolved problems visible after a one-shot schedule is exhausted", () => {
    expect(threadAutomationHealth({ inventoryState: "active", automations: { ...finishedSummary, inFlightCount: 1 } }, NOW)).toMatchObject({ kind: "sending", glyph: "spinner" });
    expect(threadAutomationHealth({ inventoryState: "active", automations: { ...finishedSummary, inFlightCount: 1, attentionCount: 1 } }, NOW)).toMatchObject({ kind: "attention", glyph: "triangle" });
  });

  it("keeps active and paused siblings visible beside finished history", () => {
    expect(threadAutomationHealth({ inventoryState: "active", automations: { ...finishedSummary, totalCount: 3, enabledCount: 1 } }, NOW)).toMatchObject({ kind: "active", label: "1 active" });
    expect(threadAutomationHealth({ inventoryState: "active", automations: { ...finishedSummary, totalCount: 3, pausedCount: 1 } }, NOW)).toMatchObject({ kind: "paused", label: "1 paused" });
  });

  it("keeps an older failure visible while its next run waits", () => {
    const subject = automation({
      lastRun: run("deferred"),
      attention: { runId: "older-failed-run", kind: "failed" },
    });
    expect(automationHealth(thread({ automation: subject }), NOW)).toMatchObject({ kind: "failed", group: "needs_attention" });
  });

  it("presents deferred delivery as waiting and retains exhausted schedules", () => {
    expect(automationHealth(thread({ automation: automation({ lastRun: run("deferred") }) }), NOW)).toMatchObject({ label: "Waiting on source" });
    expect(automationHealth(thread({ automation: automation({ status: "exhausted", nextRunAt: undefined }) }), NOW)).toMatchObject({ kind: "exhausted", group: "finished", glyph: "finished", label: "Finished" });
  });

  it("does not hide sibling failures behind another automation's active run", () => {
    const summary = {
      totalCount: 3, enabledCount: 2, pausedCount: 0, exhaustedCount: 1,
      inFlightCount: 1, attentionCount: 1, revision: 10,
    };
    expect(threadAutomationHealth({ inventoryState: "active", automations: summary }, NOW)).toMatchObject({ kind: "attention", label: "1 needs attention" });
    expect(threadAutomationHealth({ inventoryState: "active", automations: { ...summary, attentionCount: 0 } }, NOW)).toMatchObject({ kind: "sending" });
    expect(threadAutomationHealth({ inventoryState: "snoozed", automations: { ...summary, attentionCount: 0, inFlightCount: 0 } }, NOW)).toMatchObject({ kind: "snoozed" });
  });
});
