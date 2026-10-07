import { describe, expect, it } from "vitest";
import type { NormalizedApplicationSnapshot } from "../../shared/index.js";
import { futureTimeLabel } from "../lib/time.js";
import { automationHealth, type SummaryAutomation, type SummaryAutomationRun } from "./automation-health.js";
import {
  EMPTY_AUTOMATIONS_BASE,
  automationGroupCollapsedByDefault,
  automationRowPresentation,
  projectAutomations,
  selectAutomationsBase,
  type AutomationListEntry,
  type AutomationsProjectionOptions,
} from "./automation-list.js";

type Thread = NormalizedApplicationSnapshot["threads"][number];

const NOW = Date.parse("2026-10-06T03:40:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const hoursFromNow = (hours: number) =>
  new Date(NOW + hours * 3_600_000).toISOString();

function run(
  state: SummaryAutomationRun["state"],
  overrides: Partial<SummaryAutomationRun> = {},
): SummaryAutomationRun {
  return {
    id: `run-${state}`,
    state,
    occurrence: "scheduled",
    scheduledFor: minutesAgo(30),
    finishedAt: minutesAgo(23),
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
    promptPreview: "Check dependencies for advisories",
    nextRunAt: hoursFromNow(22),
    revision: 1,
    runsRevision: 0,
    hasPrecheck: false,
    ...overrides,
  };
}

function makeThread(
  id: string,
  title: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id,
    workspaceId: "ws-acme",
    targetId: "t-pi",
    title: { text: title },
    backend: { label: { text: "Pi SDK" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    nonArchivedWorkpadCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
    available: true,
    lastActivityAt: minutesAgo(60),
    stateChangedAt: minutesAgo(60),
    automation: automation(),
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
  } as Thread;
}

function makeSnapshot(
  threads: readonly Thread[],
  overrides: Partial<NormalizedApplicationSnapshot> = {},
): NormalizedApplicationSnapshot {
  return {
    advisories: [],
    environments: [
      {
        id: "env-local",
        kind: "local",
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "available",
      },
    ],
    projects: [
      { id: "project-acme", name: "acme-web", revision: 1 },
      { id: "project-billing", name: "billing-service", revision: 1 },
    ],
    workspaces: [
      {
        id: "ws-acme",
        environmentId: "env-local",
        projectId: "project-acme",
        label: { text: "acme-web" },
        displayPath: { text: "/src/acme-web" },
        available: true,
      },
      {
        id: "ws-billing",
        environmentId: "env-local",
        projectId: "project-billing",
        label: { text: "billing-service" },
        displayPath: { text: "/src/billing-service" },
        available: true,
      },
    ],
    executionTargets: [],
    threads: [...threads],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
    defaultNewThreadTargetId: null,
    counts: { active: threads.length, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
    ...overrides,
  } as NormalizedApplicationSnapshot;
}

const ALL: AutomationsProjectionOptions["scope"] = {
  environmentId: null,
  targetId: null,
  projectId: null,
  groupId: null,
  ungrouped: false,
};

function project(
  threads: readonly Thread[],
  options: Partial<AutomationsProjectionOptions> = {},
) {
  return projectAutomations(selectAutomationsBase(makeSnapshot(threads)), {
    scope: ALL,
    search: "",
    groupBy: "status",
    now: NOW,
    ...options,
  });
}

const groupTitles = (projection: ReturnType<typeof project>) =>
  projection.groups.map((group) => [
    group.label,
    group.entries.map(({ row }) => row.displayTitle),
  ]);

/** One thread for every list state. */
const world = [
  makeThread("triage", "Triage new billing issues", {
    workspaceId: "ws-billing",
    automation: automation({
      schedule: {
        kind: "interval",
        everySeconds: 14_400,
        anchorAt: "2026-10-01T00:00:00.000Z",
      },
      nextRunAt: hoursFromNow(4),
      lastRun: run("completed", { finishedAt: minutesAgo(25) }),
    }),
  }),
  makeThread("nightly", "Nightly dependency audit", {
    automation: automation({ lastRun: run("completed") }),
  }),
  makeThread("invoice", "Invoice reconciliation report", {
    workspaceId: "ws-billing",
    automation: automation({
      nextRunAt: hoursFromNow(3),
      lastRun: run("failed", {
        finishedAt: minutesAgo(21 * 60),
        errorCode: "automation_dispatch_failed",
      }),
    }),
  }),
  makeThread("sync", "Sync staging fixtures", {
    automation: automation({
      status: "paused",
      nextRunAt: undefined,
      lastRun: run("uncertain", {
        finishedAt: undefined,
        scheduledFor: minutesAgo(3 * 60),
        errorCode: "automation_dispatch_uncertain",
      }),
    }),
  }),
  makeThread("weekly", "Weekly release notes draft", {
    automation: automation({ status: "paused", nextRunAt: undefined }),
  }),
  makeThread("spike", "Spike: GraphQL gateway", {
    inventoryState: "archived",
    automation: automation({ lastRun: run("completed") }),
  }),
  makeThread("plain", "Plain thread", { automation: null }),
];

describe("selectAutomationsBase", () => {
  it("lists every thread with an automation, archived anchors included", () => {
    const base = selectAutomationsBase(
      makeSnapshot([
        ...world,
        makeThread("untitled", "", { workspaceId: "ws-gone" }),
      ]),
    );
    expect(base.rows.map(({ id }) => id)).toEqual([
      "triage",
      "nightly",
      "invoice",
      "sync",
      "weekly",
      "spike",
      "untitled",
    ]);
    expect(base.rows[0]).toMatchObject({
      displayTitle: "Triage new billing issues",
      backendLabel: "Pi SDK",
      projectId: "project-billing",
      projectLabel: "billing-service",
      locationTag: null,
      searchValues: [
        "triage new billing issues",
        "check dependencies for advisories",
      ],
    });
    // A location the catalog lacks keeps the generic project label.
    expect(base.rows.at(-1)).toMatchObject({
      displayTitle: "Untitled thread",
      projectId: null,
      projectLabel: "Project",
    });
  });

  it("keeps the base and its rows while nothing the list shows changes", () => {
    const snapshot = makeSnapshot(world);
    const base = selectAutomationsBase(snapshot);
    // A re-parsed, equal snapshot.
    expect(selectAutomationsBase(structuredClone(snapshot), base)).toBe(base);
    // Activity on an anchor whose automation has no run to follow.
    const busy = structuredClone(snapshot);
    busy.threads[4] = {
      ...busy.threads[4]!,
      runState: "running",
      lastActivityAt: minutesAgo(0),
      threadRevision: 7,
    };
    expect(selectAutomationsBase(busy, base)).toBe(base);
    // A thread without an automation never matters.
    const plain = structuredClone(snapshot);
    plain.threads[6] = { ...plain.threads[6]!, title: { text: "Renamed" } };
    expect(selectAutomationsBase(plain, base)).toBe(base);
  });

  it("follows only whether the latest run's turn is still going", () => {
    const snapshot = makeSnapshot(world);
    const base = selectAutomationsBase(snapshot);
    expect(base.rows[0]!.latestRunTurnRunning).toBe(false);

    const running = structuredClone(snapshot);
    running.threads[0] = { ...running.threads[0]!, runState: "running" };
    const started = selectAutomationsBase(running, base);
    expect(started).not.toBe(base);
    expect(started.rows[0]!.latestRunTurnRunning).toBe(true);
    expect(started.rows.slice(1)).toEqual(base.rows.slice(1));
    started.rows.slice(1).forEach((row, index) => expect(row).toBe(base.rows[index + 1]));

    // Moving between busy phases is not a change the row shows.
    const waiting = structuredClone(running);
    waiting.threads[0] = { ...waiting.threads[0]!, runState: "waiting_for_approval" };
    expect(selectAutomationsBase(waiting, started)).toBe(started);

    // Once the turn settles the run's own ending takes over.
    const settled = structuredClone(running);
    const triage = settled.threads[0]!.automation!;
    settled.threads[0] = {
      ...settled.threads[0]!,
      automation: { ...triage, lastRun: { ...triage.lastRun!, turn: { outcome: "completed" } } },
    };
    expect(selectAutomationsBase(settled, started).rows[0]!.latestRunTurnRunning).toBe(false);
  });

  it("follows a fork run's own thread", () => {
    const anchor = makeThread("anchor", "Triage", {
      automation: automation({
        runMode: "clone",
        lastRun: run("completed", { resultThreadId: "fork" }),
      }),
    });
    const fork = makeThread("fork", "Triage · Oct 6, 3:15 AM", {
      automation: null,
      runState: "running",
    });
    const [anchorRow] = selectAutomationsBase(makeSnapshot([{ ...anchor, runState: "idle" }, fork])).rows;
    expect(anchorRow!.latestRunTurnRunning).toBe(true);
    // The anchor being busy says nothing about the fork's turn.
    const [idleFork] = selectAutomationsBase(
      makeSnapshot([{ ...anchor, runState: "running" }, { ...fork, runState: "idle" }]),
    ).rows;
    expect(idleFork!.latestRunTurnRunning).toBe(false);
    // A fork loaded beyond the bootstrap counts too.
    const [loaded] = selectAutomationsBase(makeSnapshot([anchor]), undefined, [fork]).rows;
    expect(loaded!.latestRunTurnRunning).toBe(true);
  });

  it("rebuilds only the rows that changed", () => {
    const snapshot = makeSnapshot(world);
    const base = selectAutomationsBase(snapshot);
    const paused = structuredClone(snapshot);
    paused.threads[1] = {
      ...paused.threads[1]!,
      automation: automation({ status: "paused", revision: 2 }),
    };
    const next = selectAutomationsBase(paused, base);
    expect(next).not.toBe(base);
    expect(next.catalog).toBe(base.catalog);
    expect(next.rows[0]).toBe(base.rows[0]);
    expect(next.rows[1]).not.toBe(base.rows[1]);
    expect(next.rows[1]!.automation.status).toBe("paused");
    expect(next.rows.slice(2)).toEqual(base.rows.slice(2));
    expect(next.rows[2]).toBe(base.rows[2]);
  });

  it("relabels rows when the catalog changes and drops removed automations", () => {
    const snapshot = makeSnapshot(world);
    const base = selectAutomationsBase(snapshot);
    const renamed = makeSnapshot(
      world.filter(({ id }) => id !== "weekly"),
      {
        projects: [
          { id: "project-acme", name: "acme-storefront", revision: 2 },
          { id: "project-billing", name: "billing-service", revision: 1 },
        ],
      },
    );
    const next = selectAutomationsBase(renamed, base);
    expect(next.catalog).not.toBe(base.catalog);
    expect(next.rows.map(({ id }) => id)).not.toContain("weekly");
    expect(next.rows.find(({ id }) => id === "nightly")?.projectLabel).toBe(
      "acme-storefront",
    );
  });

  it("lists loaded forks beyond the bootstrap after the snapshot's threads, once each", () => {
    const snapshot = makeSnapshot(world);
    const fork = makeThread("loaded-fork", "Nightly audit fork", {
      workspaceId: "ws-acme",
    });
    // A loaded copy of a thread the snapshot holds is ignored: the
    // snapshot's copy is the live one.
    const staleNightly = { ...snapshot.threads[1]!, title: { text: "Stale" } };
    const base = selectAutomationsBase(snapshot, undefined, [fork, staleNightly]);
    expect(base.rows.map(({ id }) => id)).toEqual([
      ...selectAutomationsBase(snapshot).rows.map(({ id }) => id),
      "loaded-fork",
    ]);
    expect(base.rows.find(({ id }) => id === "nightly")?.displayTitle).not.toBe("Stale");
    expect(base.rows.at(-1)).toMatchObject({ displayTitle: "Nightly audit fork", projectLabel: "acme-web" });
    // Loading more forks without automations leaves the base alone.
    const plainFork = makeThread("plain-fork", "Plain", { automation: null });
    expect(selectAutomationsBase(structuredClone(snapshot), base, [fork, plainFork])).toBe(base);
    // A fork that leaves the loaded pages leaves the list.
    expect(selectAutomationsBase(snapshot, base, []).rows.map(({ id }) => id)).not.toContain("loaded-fork");
  });

  it("keeps the previous base without a snapshot", () => {
    const base = selectAutomationsBase(makeSnapshot(world));
    expect(selectAutomationsBase(undefined, base)).toBe(base);
    expect(selectAutomationsBase(undefined)).toBe(EMPTY_AUTOMATIONS_BASE);
  });
});

describe("projectAutomations", () => {
  it("puts every automation in exactly one status group, in list order", () => {
    const projection = project(world);
    expect(groupTitles(projection)).toEqual([
      [
        "Needs attention",
        ["Sync staging fixtures", "Invoice reconciliation report"],
      ],
      ["Upcoming", ["Triage new billing issues", "Nightly dependency audit"]],
      ["Paused", ["Weekly release notes draft"]],
      ["Suspended", ["Spike: GraphQL gateway"]],
    ]);
    expect(projection.groups.map(({ key }) => key)).toEqual([
      "status:needs_attention",
      "status:upcoming",
      "status:paused",
      "status:suspended",
    ]);
    expect(projection).toMatchObject({
      total: 6,
      scopedCount: 6,
      matchCount: 6,
    });
    const listed = projection.groups.flatMap(({ entries }) =>
      entries.map(({ row }) => row.id),
    );
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("omits empty groups and sorts each group by its own rule", () => {
    const projection = project([
      makeThread("later", "A later run", {
        automation: automation({ nextRunAt: hoursFromNow(9) }),
      }),
      makeThread("undated", "An undated run", {
        automation: automation({ nextRunAt: undefined }),
      }),
      makeThread("sooner", "Z sooner run", {
        automation: automation({ nextRunAt: hoursFromNow(1) }),
      }),
      makeThread("zeta", "Zeta", {
        automation: automation({ status: "paused", nextRunAt: undefined }),
      }),
      makeThread("alpha", "alpha", {
        automation: automation({
          status: "paused",
          nextRunAt: undefined,
          lastRun: run("completed"),
        }),
      }),
    ]);
    expect(groupTitles(projection)).toEqual([
      ["Upcoming", ["Z sooner run", "A later run", "An undated run"]],
      ["Paused", ["alpha", "Zeta"]],
    ]);
  });

  it("suspends a snoozed anchor only until it wakes", () => {
    const projection = project([
      makeThread("asleep", "Asleep", {
        inventoryState: "snoozed",
        snoozedUntil: hoursFromNow(2),
      }),
      makeThread("woken", "Woken", {
        inventoryState: "snoozed",
        snoozedUntil: minutesAgo(5),
      }),
    ]);
    expect(groupTitles(projection)).toEqual([
      ["Upcoming", ["Woken"]],
      ["Suspended", ["Asleep"]],
    ]);
  });

  it("searches titles and prompt previews, not projects", () => {
    expect(
      groupTitles(project(world, { search: "  NIGHTLY " })).flatMap(
        ([, titles]) => titles,
      ),
    ).toEqual(["Nightly dependency audit"]);
    const byPrompt = project(
      [
        makeThread("prompted", "Release", {
          automation: automation({ promptPreview: "Summarize merged PRs" }),
        }),
        ...world,
      ],
      { search: "merged prs" },
    );
    expect(byPrompt.groups.flatMap(({ entries }) => entries.map(({ row }) => row.id))).toEqual([
      "prompted",
    ]);
    expect(byPrompt).toMatchObject({ total: 7, scopedCount: 7, matchCount: 1 });
    expect(project(world, { search: "billing-service" }).matchCount).toBe(0);
  });

  it("honors the sidebar Scope", () => {
    const projection = project(world, {
      scope: { ...ALL, projectId: "project-billing" },
    });
    expect(groupTitles(projection)).toEqual([
      ["Needs attention", ["Invoice reconciliation report"]],
      ["Upcoming", ["Triage new billing issues"]],
    ]);
    expect(projection).toMatchObject({
      total: 6,
      scopedCount: 2,
      matchCount: 2,
    });
  });

  it("groups by project name, then status order within each project", () => {
    const projection = project(
      [...world, makeThread("orphan", "Orphan", { workspaceId: "ws-gone" })],
      { groupBy: "project" },
    );
    expect(groupTitles(projection)).toEqual([
      [
        "acme-web",
        [
          "Sync staging fixtures",
          "Nightly dependency audit",
          "Weekly release notes draft",
          "Spike: GraphQL gateway",
        ],
      ],
      [
        "billing-service",
        ["Invoice reconciliation report", "Triage new billing issues"],
      ],
      ["Project", ["Orphan"]],
    ]);
    expect(projection.groups.map(({ key }) => key)).toEqual([
      "project:project-acme",
      "project:project-billing",
      "location:ws-gone",
    ]);
  });

  it("collapses only Suspended by default", () => {
    expect(automationGroupCollapsedByDefault("status:suspended")).toBe(true);
    for (const key of [
      "status:needs_attention",
      "status:upcoming",
      "status:paused",
      "project:project-acme",
    ]) {
      expect(automationGroupCollapsedByDefault(key)).toBe(false);
    }
  });
});

function entryFor(thread: Thread): AutomationListEntry {
  const row = selectAutomationsBase(makeSnapshot([thread])).rows[0]!;
  return { row, health: automationHealth(row, NOW) };
}

describe("automationRowPresentation", () => {
  const next = (hours: number) => futureTimeLabel(hoursFromNow(hours), new Date(NOW));
  const presentationOf = (id: string) =>
    automationRowPresentation(entryFor(world.find((thread) => thread.id === id)!), NOW);

  it("shows an active automation's next run over its last outcome", () => {
    expect(presentationOf("nightly")).toEqual({
      primary: { text: next(22) },
      secondary: { text: "Delivered 23m ago", check: true },
      detail: "Every day at 2:00 AM UTC",
      outcome: { text: "Delivered 23m ago", check: true },
      nextRun: next(22),
    });
    expect(presentationOf("triage").detail).toBe("Every 4 hours");
  });

  it("reads the last turn's ending, and keeps the row in its group whatever it was", () => {
    const withTurn = (
      turn: NonNullable<SummaryAutomationRun["turn"]>,
      overrides: Partial<SummaryAutomation> = {},
    ) =>
      entryFor(
        makeThread("x", "X", {
          automation: automation({
            lastRun: run("completed", { finishedAt: minutesAgo(150), turn }),
            ...overrides,
          }),
        }),
      );
    const finished = withTurn({ outcome: "completed", endedAt: minutesAgo(23) });
    expect(finished.health.group).toBe("upcoming");
    expect(automationRowPresentation(finished, NOW)).toEqual({
      primary: { text: next(22) },
      secondary: { text: "Finished 23m ago", check: true },
      detail: "Every day at 2:00 AM UTC",
      outcome: { text: "Finished 23m ago", check: true },
      nextRun: next(22),
    });

    // A failed turn is danger text only: no attention, no problem detail.
    const failed = withTurn({ outcome: "failed", endedAt: minutesAgo(120) });
    expect(failed.health).toMatchObject({ kind: "active", group: "upcoming" });
    expect(automationRowPresentation(failed, NOW)).toEqual({
      primary: { text: next(22) },
      secondary: { text: "Failed 2h ago", check: false, tone: "danger" },
      detail: "Every day at 2:00 AM UTC",
      outcome: { text: "Failed 2h ago", check: false, tone: "danger" },
      nextRun: next(22),
    });

    // Without the turn's end, the age counts from the delivery.
    expect(automationRowPresentation(withTurn({ outcome: "interrupted" }), NOW)).toMatchObject({
      secondary: { text: "Interrupted 2h ago", check: false },
    });

    const paused = withTurn({ outcome: "failed", endedAt: minutesAgo(60) }, { status: "paused", nextRunAt: undefined });
    expect(paused.health.group).toBe("paused");
    expect(automationRowPresentation(paused, NOW)).toMatchObject({
      primary: { text: "Paused" },
      secondary: { text: "Failed 1h ago", tone: "danger" },
    });
  });

  it("puts a failure first, its error text on line 2, and says whether scheduling continues", () => {
    const failed = presentationOf("invoice");
    expect(failed).toEqual({
      primary: { text: "Failed 21h ago", tone: "danger" },
      secondary: { text: `next ${next(3)}` },
      detail: "The prompt could not be delivered to the agent.",
      outcome: { text: "Failed 21h ago", tone: "danger" },
      nextRun: next(3),
    });
    expect(presentationOf("sync")).toEqual({
      primary: { text: "Outcome unknown", tone: "warning" },
      secondary: { text: "Scheduling paused" },
      detail: "Sedes can't tell whether the last run reached the agent.",
      outcome: { text: "Outcome unknown", tone: "warning" },
      nextRun: null,
    });
  });

  it("falls back to the schedule when a problem has no error code", () => {
    const entry = entryFor(
      makeThread("x", "X", {
        automation: automation({ lastRun: run("failed") }),
      }),
    );
    expect(automationRowPresentation(entry, NOW).detail).toBe(
      "Every day at 2:00 AM UTC",
    );
  });

  it("reads a delivered run whose turn is still going as Running, paused or not", () => {
    const delivered = run("completed", { finishedAt: minutesAgo(4) });
    const active = entryFor(
      makeThread("x", "X", {
        runState: "running",
        automation: automation({ lastRun: delivered }),
      }),
    );
    expect(automationRowPresentation(active, NOW)).toMatchObject({
      primary: { text: next(22) },
      secondary: { text: "Running · 4m", tone: "info", running: true },
      outcome: { text: "Running · 4m", tone: "info", running: true },
    });
    // Run now on a paused automation: the row stays Paused, its run is Running.
    const paused = entryFor(
      makeThread("x", "X", {
        runState: "waiting_for_input",
        automation: automation({ status: "paused", nextRunAt: undefined, lastRun: delivered }),
      }),
    );
    expect(paused.health.group).toBe("paused");
    expect(automationRowPresentation(paused, NOW)).toMatchObject({
      primary: { text: "Paused" },
      secondary: { text: "Running · 4m", tone: "info", running: true },
      outcome: { text: "Running · 4m", tone: "info", running: true },
    });
    // An idle thread: the run was delivered and nothing says it is still going.
    const idle = entryFor(
      makeThread("x", "X", {
        automation: automation({ status: "paused", nextRunAt: undefined, lastRun: delivered }),
      }),
    );
    expect(automationRowPresentation(idle, NOW)).toMatchObject({
      secondary: { text: "Delivered 4m ago", check: true },
      outcome: { text: "Paused" },
    });
  });

  it("names a run in flight in the info tone", () => {
    const entry = entryFor(
      makeThread("x", "X", {
        automation: automation({
          lastRun: run("queued", { finishedAt: undefined }),
        }),
      }),
    );
    expect(automationRowPresentation(entry, NOW)).toMatchObject({
      primary: { text: "Waiting for turn", tone: "info" },
      secondary: { text: `next ${next(22)}` },
      outcome: { text: "Waiting for turn", tone: "info" },
    });
  });

  it("uses the status word for paused, never-started and suspended automations", () => {
    expect(presentationOf("weekly")).toEqual({
      primary: { text: "Not started" },
      secondary: null,
      detail: "Every day at 2:00 AM UTC",
      outcome: { text: "Not started" },
      nextRun: null,
    });
    expect(presentationOf("spike")).toMatchObject({
      primary: { text: "Thread archived" },
      secondary: { text: "Delivered 23m ago", check: true },
      outcome: { text: "Thread archived" },
    });
    const skipped = entryFor(
      makeThread("x", "X", {
        automation: automation({
          status: "paused",
          nextRunAt: undefined,
          lastRun: run("skipped", { finishedAt: minutesAgo(120) }),
        }),
      }),
    );
    expect(automationRowPresentation(skipped, NOW)).toMatchObject({
      primary: { text: "Paused" },
      secondary: { text: "Skipped 2h ago", check: false },
    });
  });
});
