import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import {
  SIDEBAR_VIEW_DEFAULTS,
  type SidebarFlatGroup,
  type SidebarViewPreferences,
} from "../app/sidebar-view-model.js";
import {
  filterSidebarThreads,
  isUpcomingThread,
  projectSidebarFlatGroups,
  resolveStateBucket,
  resolveTimeBucket,
  sidebarWakeTimestamp,
  type SidebarFlatMode,
} from "./sidebar-flat-projections.js";

/** Wednesday, August 12, 2026 at 15:00 local time (weeks start Monday Aug 10). */
const NOW = new Date(2026, 7, 12, 15, 0, 0).getTime();

/** ISO instant from local calendar components, so bucket edges are TZ-stable. */
function at(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
  minute = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute).toISOString();
}

const TODAY_MORNING = at(2026, 7, 12, 9);

type ThreadAutomation = NonNullable<
  NormalizedApplicationThreadSummary["automation"]
>;

function thread(
  id: string,
  input: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: `Thread ${id}` },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: TODAY_MORNING,
    stateChangedAt: TODAY_MORNING,
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...input,
    preferredWorktreeRevision: input.preferredWorktreeRevision ?? 0,
    preferredWorktree: input.preferredWorktree ?? null,
  };
}

function automation(input: Partial<ThreadAutomation> = {}): ThreadAutomation {
  return {
    status: "enabled",
    runMode: "clone",
    scheduleKind: "interval",
    revision: 1,
    hasPrecheck: false,
    ...input,
  };
}

function preferences(
  input: Partial<SidebarViewPreferences> = {},
): SidebarViewPreferences {
  return { ...SIDEBAR_VIEW_DEFAULTS, ...input };
}

function project(
  mode: SidebarFlatMode,
  threads: readonly NormalizedApplicationThreadSummary[],
  overrides: Partial<SidebarViewPreferences> = {},
): SidebarFlatGroup[] {
  return projectSidebarFlatGroups(mode, threads, preferences(overrides), NOW);
}

const keysOf = (groups: readonly SidebarFlatGroup[]): string[] =>
  groups.map(({ key }) => key);
const idsOf = (group: SidebarFlatGroup | undefined): string[] =>
  group?.threads.map(({ id }) => id) ?? [];
const groupFor = (
  groups: readonly SidebarFlatGroup[],
  key: string,
): SidebarFlatGroup | undefined => groups.find((group) => group.key === key);

describe("filterSidebarThreads", () => {
  it("always excludes archived threads", () => {
    const threads = [thread("a"), thread("b", { inventoryState: "archived" })];
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: true,
        drafts: true,
      }).map(({ id }) => id),
    ).toEqual(["a"]);
    for (const mode of ["time", "state", "none"] as const) {
      const grouped = project(mode, threads);
      expect(grouped.flatMap(idsOf)).toEqual(["a"]);
    }
  });

  it("excludes settled threads only when the settled filter is off", () => {
    const threads = [thread("a"), thread("b", { inventoryState: "settled" })];
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: true,
        drafts: true,
      }),
    ).toHaveLength(2);
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: false,
        drafts: true,
      }).map(({ id }) => id),
    ).toEqual(["a"]);
  });

  it("excludes unbound drafts only when the drafts filter is off", () => {
    const threads = [thread("a"), thread("b", { backingState: "unbound" })];
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: true,
        drafts: true,
      }),
    ).toHaveLength(2);
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: true,
        drafts: false,
      }).map(({ id }) => id),
    ).toEqual(["a"]);
    const groups = project("none", threads, {
      show: { snoozed: true, settled: true, drafts: false },
    });
    expect(groups.flatMap(idsOf)).toEqual(["a"]);
  });

  it("excludes snoozed threads only when the snoozed filter is off", () => {
    const threads = [thread("a"), thread("b", { inventoryState: "snoozed" })];
    expect(
      filterSidebarThreads(threads, {
        snoozed: true,
        settled: true,
        drafts: true,
      }),
    ).toHaveLength(2);
    expect(
      filterSidebarThreads(threads, {
        snoozed: false,
        settled: true,
        drafts: true,
      }).map(({ id }) => id),
    ).toEqual(["a"]);
  });
});

describe("pinned projection", () => {
  it("extracts pinned threads into one top shelf without duplicates", () => {
    const groups = project(
      "time",
      [
        thread("plain"),
        thread("pinned-b", { pinned: true, title: { text: "Beta" } }),
        thread("pinned-a", { pinned: true, title: { text: "Alpha" } }),
      ],
      { modes: { time: { sortBy: "alpha", direction: "asc" } } },
    );
    expect(keysOf(groups)[0]).toBe("pinned");
    expect(idsOf(groups[0])).toEqual(["pinned-a", "pinned-b"]);
    expect(groups.flatMap(idsOf)).toEqual(["pinned-a", "pinned-b", "plain"]);
  });

  it("honors pinned-only after the existing Show filters", () => {
    const groups = project(
      "state",
      [
        thread("plain"),
        thread("pinned", { pinned: true }),
        thread("hidden-pinned", {
          pinned: true,
          inventoryState: "settled",
        }),
      ],
      {
        modes: { state: { pinnedOnly: true } },
        show: { snoozed: true, settled: false, drafts: true },
      },
    );
    expect(keysOf(groups)).toEqual(["pinned"]);
    expect(idsOf(groups[0])).toEqual(["pinned"]);
  });

  it("omits an empty pinned shelf", () => {
    expect(keysOf(project("none", [thread("plain")]))).toEqual(["all"]);
  });
});

describe("timeline Upcoming membership", () => {
  it("collects snoozed threads and dormant enabled automations, ascending by wake", () => {
    const groups = project("time", [
      thread("snoozed-late", {
        inventoryState: "snoozed",
        snoozedUntil: at(2026, 7, 14, 9),
      }),
      thread("snoozed-no-wake", { inventoryState: "snoozed" }),
      thread("automation-soon", {
        automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
      }),
      thread("plain"),
    ]);
    const upcoming = groups[0]!;
    expect(upcoming.key).toBe("upcoming");
    expect(upcoming.kind).toBe("upcoming");
    expect(upcoming.futureTimes).toBe(true);
    expect(idsOf(upcoming)).toEqual([
      "automation-soon",
      "snoozed-late",
      "snoozed-no-wake",
    ]);
    expect(idsOf(groupFor(groups, "today"))).toEqual(["plain"]);
  });

  it("keeps a running automation out of Upcoming — it belongs to Today", () => {
    const runningAutomation = thread("running-automation", {
      runState: "running",
      automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
    });
    expect(isUpcomingThread(runningAutomation)).toBe(false);
    for (const runState of ["starting", "stopping", "reconciling"] as const) {
      expect(
        isUpcomingThread(
          thread("t", {
            runState,
            automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
          }),
        ),
      ).toBe(false);
    }
    const groups = project("time", [runningAutomation]);
    expect(keysOf(groups)).toEqual(["today"]);
  });

  it("clamps a running automation with stale timestamps into Today", () => {
    const twoDaysAgo = at(2026, 7, 10);
    const staleRunningAutomation = thread("stale-running-automation", {
      runState: "running",
      automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
      lastActivityAt: twoDaysAgo,
      stateChangedAt: twoDaysAgo,
    });
    expect(isUpcomingThread(staleRunningAutomation)).toBe(false);
    const groups = project("time", [staleRunningAutomation]);
    expect(keysOf(groups)).toEqual(["today"]);
    expect(idsOf(groupFor(groups, "today"))).toEqual([
      "stale-running-automation",
    ]);
  });

  it("leaves a plain running thread bucketed by its effective timestamp", () => {
    // The Timeline contract pins only running automations to Today; a plain
    // thread keeps the effective-timestamp rule even while running.
    const twoDaysAgo = at(2026, 7, 10);
    const groups = project("time", [
      thread("stale-running-plain", {
        runState: "running",
        lastActivityAt: twoDaysAgo,
        stateChangedAt: twoDaysAgo,
      }),
    ]);
    expect(keysOf(groups)).toEqual(["this-week"]);
  });

  it("routes paused and next-run-less automations into time buckets", () => {
    const groups = project("time", [
      thread("paused", {
        automation: automation({
          status: "paused",
          nextRunAt: at(2026, 7, 20, 9),
        }),
        lastActivityAt: at(2026, 6, 15),
        stateChangedAt: at(2026, 6, 15),
      }),
      thread("no-next-run", { automation: automation() }),
    ]);
    expect(keysOf(groups)).toEqual(["today", "month-6"]);
    expect(idsOf(groupFor(groups, "month-6"))).toEqual(["paused"]);
    expect(idsOf(groupFor(groups, "today"))).toEqual(["no-next-run"]);
  });

  it("clamps past-due wakes to the top and never caps the group", () => {
    const threads = [
      thread("past-due", {
        inventoryState: "snoozed",
        snoozedUntil: at(2026, 7, 11, 8),
      }),
      ...Array.from({ length: 6 }, (_, index) =>
        thread(`future-${index}`, {
          inventoryState: "snoozed",
          snoozedUntil: at(2026, 7, 13 + index, 9),
        }),
      ),
    ];
    const upcoming = project("time", threads)[0]!;
    expect(upcoming.threads).toHaveLength(7);
    expect(idsOf(upcoming)[0]).toBe("past-due");
  });

  it("derives wake instants with snoozes ahead of automation next runs", () => {
    expect(
      sidebarWakeTimestamp(thread("t", { inventoryState: "snoozed" })),
    ).toBeUndefined();
    expect(
      sidebarWakeTimestamp(
        thread("t", {
          inventoryState: "snoozed",
          snoozedUntil: at(2026, 7, 14, 9),
        }),
      ),
    ).toBe(Date.parse(at(2026, 7, 14, 9)));
    expect(
      sidebarWakeTimestamp(
        thread("t", {
          automation: automation({ nextRunAt: at(2026, 7, 13, 6) }),
        }),
      ),
    ).toBe(Date.parse(at(2026, 7, 13, 6)));
    expect(
      sidebarWakeTimestamp(
        thread("t", {
          automation: automation({
            status: "paused",
            nextRunAt: at(2026, 7, 13, 6),
          }),
        }),
      ),
    ).toBeUndefined();
  });
});

describe("timeline and flat settled shelf", () => {
  it("extracts unpinned settled threads below time buckets", () => {
    const groups = project("time", [
      thread("active-today"),
      thread("settled-today", {
        inventoryState: "settled",
        lastActivityAt: at(2026, 6, 1),
        stateChangedAt: TODAY_MORNING,
      }),
      thread("settled-yesterday", {
        inventoryState: "settled",
        lastActivityAt: at(2026, 7, 11, 10),
        stateChangedAt: at(2026, 7, 11, 10),
      }),
    ]);
    expect(keysOf(groups)).toEqual(["today", "settled"]);
    expect(idsOf(groupFor(groups, "today"))).toEqual(["active-today"]);
    expect(idsOf(groupFor(groups, "settled"))).toEqual([
      "settled-today",
      "settled-yesterday",
    ]);
    expect(groupFor(groups, "settled")).toMatchObject({
      label: "Settled",
      kind: "settled",
      futureTimes: false,
    });
  });

  it("keeps a settled automation out of Upcoming", () => {
    const groups = project("time", [
      thread("settled-automation", {
        inventoryState: "settled",
        automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
      }),
      thread("upcoming-automation", {
        automation: automation({ nextRunAt: at(2026, 7, 12, 18) }),
      }),
    ]);
    expect(keysOf(groups)).toEqual(["upcoming", "settled"]);
    expect(idsOf(groupFor(groups, "upcoming"))).toEqual([
      "upcoming-automation",
    ]);
    expect(idsOf(groupFor(groups, "settled"))).toEqual(["settled-automation"]);
  });

  it("leaves snoozed threads in Upcoming rather than the settled shelf", () => {
    const groups = project("time", [
      thread("snoozed", {
        inventoryState: "snoozed",
        snoozedUntil: at(2026, 7, 14, 9),
      }),
      thread("settled", { inventoryState: "settled" }),
    ]);
    expect(keysOf(groups)).toEqual(["upcoming", "settled"]);
    expect(idsOf(groupFor(groups, "upcoming"))).toEqual(["snoozed"]);
    expect(idsOf(groupFor(groups, "settled"))).toEqual(["settled"]);
  });

  it("keeps pinned settled threads in Pinned and omits an empty shelf", () => {
    const groups = project("time", [
      thread("pinned-settled", { pinned: true, inventoryState: "settled" }),
      thread("plain"),
    ]);
    expect(keysOf(groups)).toEqual(["pinned", "today"]);
    expect(idsOf(groupFor(groups, "pinned"))).toEqual(["pinned-settled"]);
  });

  it("extracts settled threads below the flat working list", () => {
    const groups = project("none", [
      thread("older", {
        lastActivityAt: at(2026, 7, 11, 9),
        stateChangedAt: at(2026, 7, 11, 9),
      }),
      thread("settled-older", {
        inventoryState: "settled",
        lastActivityAt: at(2026, 7, 10, 9),
        stateChangedAt: at(2026, 7, 10, 9),
      }),
      thread("newer"),
      thread("settled-newer", { inventoryState: "settled" }),
      thread("snoozed", { inventoryState: "snoozed" }),
    ]);
    expect(keysOf(groups)).toEqual(["all", "settled"]);
    expect(idsOf(groupFor(groups, "all"))).toEqual([
      "newer",
      "snoozed",
      "older",
    ]);
    expect(idsOf(groupFor(groups, "settled"))).toEqual([
      "settled-newer",
      "settled-older",
    ]);
    expect(groupFor(groups, "all")?.kind).toBe("all");
    expect(groupFor(groups, "settled")?.kind).toBe("settled");
  });

  it("sorts the settled shelf by the resolved axis", () => {
    const threads = [
      thread("settled-b", {
        inventoryState: "settled",
        title: { text: "Beta" },
        lastActivityAt: at(2026, 7, 12, 8),
        stateChangedAt: at(2026, 7, 12, 8),
      }),
      thread("settled-a", {
        inventoryState: "settled",
        title: { text: "Alpha" },
        lastActivityAt: at(2026, 7, 12, 14),
        stateChangedAt: at(2026, 7, 12, 14),
      }),
    ];
    expect(idsOf(groupFor(project("time", threads), "settled"))).toEqual([
      "settled-a",
      "settled-b",
    ]);
    const alphabetical = project("none", threads, {
      modes: { none: { sortBy: "alpha", direction: "asc" } },
    });
    expect(idsOf(groupFor(alphabetical, "settled"))).toEqual([
      "settled-a",
      "settled-b",
    ]);
  });

  it("does not extract settled out of State buckets", () => {
    const groups = project("state", [
      thread("idle-1"),
      thread("settled-1", { inventoryState: "settled" }),
      thread("failed-settled", {
        inventoryState: "settled",
        runState: "failed",
      }),
    ]);
    expect(keysOf(groups)).toEqual(["needs-attention", "idle", "settled"]);
    expect(idsOf(groupFor(groups, "needs-attention"))).toEqual([
      "failed-settled",
    ]);
    expect(idsOf(groupFor(groups, "settled"))).toEqual(["settled-1"]);
    expect(groupFor(groups, "settled")?.kind).toBe("state");
  });
});

describe("timeline buckets", () => {
  it("starts weeks on Monday, local time", () => {
    expect(resolveTimeBucket(Date.parse(at(2026, 7, 10, 0, 0)), NOW).key).toBe(
      "this-week",
    );
    expect(resolveTimeBucket(Date.parse(at(2026, 7, 9, 23, 59)), NOW).key).toBe(
      "last-week",
    );
    expect(resolveTimeBucket(Date.parse(at(2026, 7, 3, 0, 0)), NOW).key).toBe(
      "last-week",
    );
    expect(resolveTimeBucket(Date.parse(at(2026, 7, 2, 23, 59)), NOW).key).toBe(
      "earlier-this-month",
    );
  });

  it("buckets top-down into day, week, month, and year groups in order", () => {
    const groups = project("time", [
      thread("earlier-month", {
        lastActivityAt: at(2026, 7, 1, 10),
        stateChangedAt: at(2026, 7, 1, 10),
      }),
      thread("year-2024", {
        lastActivityAt: at(2024, 3, 5),
        stateChangedAt: at(2024, 3, 5),
      }),
      thread("june", {
        lastActivityAt: at(2026, 5, 3),
        stateChangedAt: at(2026, 5, 3),
      }),
      thread("today"),
      thread("last-week", {
        lastActivityAt: at(2026, 7, 5),
        stateChangedAt: at(2026, 7, 5),
      }),
      thread("july", {
        lastActivityAt: at(2026, 6, 15),
        stateChangedAt: at(2026, 6, 15),
      }),
      thread("yesterday", {
        lastActivityAt: at(2026, 7, 11, 22),
        stateChangedAt: at(2026, 7, 11, 22),
      }),
      thread("year-2025", {
        lastActivityAt: at(2025, 10, 20),
        stateChangedAt: at(2025, 10, 20),
      }),
      thread("this-week", {
        lastActivityAt: at(2026, 7, 10, 8),
        stateChangedAt: at(2026, 7, 10, 8),
      }),
    ]);
    expect(keysOf(groups)).toEqual([
      "today",
      "yesterday",
      "this-week",
      "last-week",
      "earlier-this-month",
      "month-6",
      "month-5",
      "year-2025",
      "year-2024",
    ]);
    expect(groupFor(groups, "month-6")?.label).toBe(
      new Date(2026, 6, 1).toLocaleDateString(undefined, { month: "long" }),
    );
    expect(groupFor(groups, "year-2025")?.label).toBe("2025");
    expect(groups.every((group) => group.kind === "time")).toBe(true);
    expect(groups.every((group) => !group.futureTimes)).toBe(true);
  });

  it("omits empty buckets", () => {
    expect(keysOf(project("time", [thread("only-today")]))).toEqual(["today"]);
  });

  it("sorts within a bucket by the resolved axis, honoring direction, ties by id", () => {
    const threads = [
      thread("older", {
        lastActivityAt: at(2026, 7, 12, 8),
        stateChangedAt: at(2026, 7, 12, 8),
      }),
      thread("newer", {
        lastActivityAt: at(2026, 7, 12, 14),
        stateChangedAt: at(2026, 7, 12, 14),
      }),
      thread("tie-b", {
        lastActivityAt: at(2026, 7, 12, 10),
        stateChangedAt: at(2026, 7, 12, 10),
      }),
      thread("tie-a", {
        lastActivityAt: at(2026, 7, 12, 10),
        stateChangedAt: at(2026, 7, 12, 10),
      }),
    ];
    expect(idsOf(project("time", threads)[0])).toEqual([
      "newer",
      "tie-a",
      "tie-b",
      "older",
    ]);
    const ascending = project("time", threads, {
      modes: { time: { sortBy: "activity", direction: "asc" } },
    });
    expect(idsOf(ascending[0])).toEqual(["older", "tie-a", "tie-b", "newer"]);
    const byStateChanged = project(
      "time",
      [
        thread("changed-late", {
          lastActivityAt: at(2026, 7, 12, 6),
          stateChangedAt: at(2026, 7, 12, 13),
        }),
        thread("changed-early", {
          lastActivityAt: at(2026, 7, 12, 14),
          stateChangedAt: at(2026, 7, 12, 7),
        }),
      ],
      { modes: { time: { sortBy: "stateChanged", direction: "asc" } } },
    );
    expect(idsOf(byStateChanged[0])).toEqual(["changed-early", "changed-late"]);
  });

  it("uses last activity before id when effective activity ties", () => {
    const threads = [
      thread("a-state-change", {
        lastActivityAt: at(2026, 7, 12, 8),
        stateChangedAt: at(2026, 7, 12, 14),
      }),
      thread("z-later-activity", {
        lastActivityAt: at(2026, 7, 12, 14),
        stateChangedAt: at(2026, 7, 12, 8),
      }),
    ];

    expect(idsOf(project("time", threads)[0])).toEqual([
      "z-later-activity",
      "a-state-change",
    ]);
    expect(
      idsOf(
        project("time", threads, {
          modes: { time: { sortBy: "activity", direction: "asc" } },
        })[0],
      ),
    ).toEqual(["a-state-change", "z-later-activity"]);
  });
});

describe("state buckets", () => {
  it("keeps pending questions in Needs attention until all are resolved", () => {
    for (const pendingQuestionCount of [3, 1]) {
      const groups = project("state", [
        thread("running", { runState: "running", pendingQuestionCount }),
        thread("settled", { inventoryState: "settled", pendingQuestionCount }),
        thread("idle"),
      ]);
      expect(keysOf(groups)).toEqual(["needs-attention", "idle"]);
      expect(idsOf(groupFor(groups, "needs-attention"))).toEqual([
        "running",
        "settled",
      ]);
    }

    const resolved = project("state", [
      thread("running", { runState: "running", pendingQuestionCount: 0 }),
      thread("settled", { inventoryState: "settled", pendingQuestionCount: 0 }),
      thread("idle"),
    ]);
    expect(keysOf(resolved)).toEqual(["running", "idle", "settled"]);
    expect(
      resolveStateBucket(thread("failed", { runState: "failed", pendingQuestionCount: 0 })),
    ).toBe("needs-attention");
  });

  it("resolves Needs attention for every attention signal", () => {
    expect(resolveStateBucket(thread("t", { runState: "failed" }))).toBe(
      "needs-attention",
    );
    expect(
      resolveStateBucket(thread("t", { runState: "waiting_for_input" })),
    ).toBe("needs-attention");
    expect(
      resolveStateBucket(thread("t", { runState: "waiting_for_approval" })),
    ).toBe("needs-attention");
    expect(
      resolveStateBucket(
        thread("t", {
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: true,
          },
        }),
      ),
    ).toBe("needs-attention");
    expect(
      resolveStateBucket(
        thread("t", {
          inventoryState: "snoozed",
          attention: {
            wake: true,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        }),
      ),
    ).toBe("needs-attention");
    expect(
      resolveStateBucket(
        thread("t", {
          attention: {
            wake: false,
            automationContext: "failed",
            unseenCompletion: false,
            queueFailure: false,
          },
        }),
      ),
    ).toBe("needs-attention");
    expect(
      resolveStateBucket(
        thread("t", {
          automation: automation({
            nextRunAt: at(2026, 7, 13, 6),
            lastRun: {
              id: "run-1",
              state: "failed",
              occurrence: "scheduled",
              scheduledFor: at(2026, 7, 12, 6),
            },
          }),
        }),
      ),
    ).toBe("needs-attention");
  });

  it("applies first-match precedence across the remaining buckets", () => {
    for (const runState of [
      "running",
      "starting",
      "stopping",
      "reconciling",
    ] as const) {
      expect(
        resolveStateBucket(
          thread("t", {
            runState,
            automation: automation({ nextRunAt: at(2026, 7, 13, 6) }),
          }),
        ),
      ).toBe("running");
    }
    expect(
      resolveStateBucket(
        thread("t", {
          inventoryState: "snoozed",
          snoozedUntil: at(2026, 7, 14, 9),
          automation: automation({ nextRunAt: at(2026, 7, 13, 6) }),
        }),
      ),
    ).toBe("scheduled");
    expect(
      resolveStateBucket(
        thread("t", {
          inventoryState: "snoozed",
          automation: automation({ status: "paused" }),
        }),
      ),
    ).toBe("snoozed");
    expect(resolveStateBucket(thread("t", { inventoryState: "settled" }))).toBe(
      "settled",
    );
    expect(resolveStateBucket(thread("t", { runState: "disconnected" }))).toBe(
      "idle",
    );
    expect(resolveStateBucket(thread("t"))).toBe("idle");
  });

  it("emits groups in precedence order and omits empty ones", () => {
    const groups = project("state", [
      thread("idle-1"),
      thread("snoozed-1", { inventoryState: "snoozed" }),
      thread("settled-1", { inventoryState: "settled" }),
      thread("scheduled-1", {
        automation: automation({ nextRunAt: at(2026, 7, 13, 6) }),
      }),
      thread("failed-1", { runState: "failed" }),
      thread("running-1", { runState: "running" }),
    ]);
    expect(keysOf(groups)).toEqual([
      "needs-attention",
      "running",
      "scheduled",
      "idle",
      "snoozed",
      "settled",
    ]);
    expect(groups.map(({ label }) => label)).toEqual([
      "Needs attention",
      "Running",
      "Scheduled",
      "Idle",
      "Snoozed",
      "Settled",
    ]);
    expect(groups.every((group) => group.kind === "state")).toBe(true);
  });

  it("sorts Scheduled and Snoozed ascending by wake regardless of the sort axis", () => {
    const groups = project(
      "state",
      [
        thread("sched-late", {
          title: { text: "AAA" },
          automation: automation({ nextRunAt: at(2026, 7, 15, 6) }),
        }),
        thread("sched-soon", {
          title: { text: "ZZZ" },
          automation: automation({ nextRunAt: at(2026, 7, 13, 6) }),
        }),
        thread("snooze-late", {
          title: { text: "AAA" },
          inventoryState: "snoozed",
          snoozedUntil: at(2026, 7, 20, 9),
        }),
        thread("snooze-soon", {
          title: { text: "ZZZ" },
          inventoryState: "snoozed",
          snoozedUntil: at(2026, 7, 14, 9),
        }),
        thread("snooze-no-wake", {
          title: { text: "AAA" },
          inventoryState: "snoozed",
        }),
      ],
      { modes: { state: { sortBy: "alpha", direction: "desc" } } },
    );
    const scheduled = groupFor(groups, "scheduled")!;
    const snoozed = groupFor(groups, "snoozed")!;
    expect(scheduled.futureTimes).toBe(true);
    expect(snoozed.futureTimes).toBe(true);
    expect(idsOf(scheduled)).toEqual(["sched-soon", "sched-late"]);
    expect(idsOf(snoozed)).toEqual([
      "snooze-soon",
      "snooze-late",
      "snooze-no-wake",
    ]);
  });

  it("sorts non-future buckets by the resolved axis (stateChanged desc default)", () => {
    const groups = project("state", [
      thread("idle-early", { stateChangedAt: at(2026, 7, 12, 7) }),
      thread("idle-late", { stateChangedAt: at(2026, 7, 12, 13) }),
    ]);
    expect(idsOf(groupFor(groups, "idle"))).toEqual([
      "idle-late",
      "idle-early",
    ]);
    expect(groupFor(groups, "idle")?.futureTimes).toBe(false);
  });
});

describe("flat (none) projection", () => {
  it("returns a single headerless group sorted by the axis", () => {
    const groups = project("none", [
      thread("older", {
        lastActivityAt: at(2026, 7, 11, 9),
        stateChangedAt: at(2026, 7, 11, 9),
      }),
      thread("newer"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("all");
    expect(groups[0]!.kind).toBe("all");
    expect(groups[0]!.futureTimes).toBe(false);
    expect(idsOf(groups[0])).toEqual(["newer", "older"]);
  });

  it("sorts alphabetically case-insensitive with untitled last in both directions", () => {
    const threads = [
      thread("untitled", { title: { text: "  " } }),
      thread("bravo", { title: { text: "bravo" } }),
      thread("alpha", { title: { text: "Alpha" } }),
      thread("tie-2", { title: { text: "Same" } }),
      thread("tie-1", { title: { text: "same" } }),
    ];
    const ascending = project("none", threads, {
      modes: { none: { sortBy: "alpha", direction: "asc" } },
    });
    expect(idsOf(ascending[0])).toEqual([
      "alpha",
      "bravo",
      "tie-1",
      "tie-2",
      "untitled",
    ]);
    const descending = project("none", threads, {
      modes: { none: { sortBy: "alpha", direction: "desc" } },
    });
    expect(idsOf(descending[0])).toEqual([
      "tie-1",
      "tie-2",
      "bravo",
      "alpha",
      "untitled",
    ]);
  });

  it("returns no groups when every thread is filtered out", () => {
    expect(
      project("none", [thread("archived", { inventoryState: "archived" })]),
    ).toEqual([]);
  });
});
