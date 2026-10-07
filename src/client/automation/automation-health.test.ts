import { describe, expect, it } from "vitest";
import {
  AUTOMATION_HEALTH_GROUPS,
  AUTOMATION_HEALTH_GROUP_LABELS,
  automationHealth,
  automationIdentityGlyph,
  automationIdentityLabel,
  automationNeedsAttention,
  compareAutomationsInGroup,
  lastRunAt,
  threadRunPhase,
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
  return {
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    schedule: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
    misfirePolicy: "coalesce",
    promptPreview: "Check dependencies",
    nextRunAt: "2026-10-07T02:00:00.000Z",
    revision: 1,
    runsRevision: 0,
    hasPrecheck: false,
    ...overrides,
  };
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

  it("follows the dispatcher: an open-ended or lapsed snooze does not skip runs", () => {
    expect(
      automationHealth(thread({ inventoryState: "snoozed" }), NOW)?.kind,
    ).toBe("active");
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
    ]);
    expect(AUTOMATION_HEALTH_GROUPS.map((group) => AUTOMATION_HEALTH_GROUP_LABELS[group]))
      .toEqual(["Needs attention", "Upcoming", "Paused", "Suspended"]);
  });
});

describe("automationNeedsAttention", () => {
  it("is true only for failed and uncertain last runs", () => {
    expect(automationNeedsAttention(null)).toBe(false);
    expect(automationNeedsAttention(automation())).toBe(false);
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
    expect(
      glyphFor(thread({ inventoryState: "snoozed", snoozedUntil: "2026-10-07T00:00:00.000Z" })),
    ).toBe("pause");
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
