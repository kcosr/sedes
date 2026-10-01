import { describe, expect, it } from "vitest";
import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../shared/index.js";
import { deriveSidebarInventoryScope } from "../app/sidebar-scope.js";
import { SIDEBAR_VIEW_DEFAULTS } from "../app/sidebar-view-model.js";
import { createThreadSearchMatcher } from "../lineage/sidebar-search.js";
import {
  archiveAgeLabel,
  archivedRowsEqual,
  effectiveArchiveGroupBy,
  jsonEqual,
  pageArchivedThreads,
  projectArchivedThreads,
  selectArchiveBase,
  type ArchiveProjectionOptions,
} from "./archived-threads.js";

type Thread = NormalizedApplicationThreadSummary;

// Local noon keeps the date buckets independent of the host time zone.
const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();
const hoursAgo = (hours: number) =>
  new Date(NOW - hours * 3_600_000).toISOString();

function thread(
  id: string,
  overrides: Partial<Thread> & { readonly title?: string } = {},
): Thread {
  const { title, ...rest } = overrides;
  return {
    id,
    workspaceId: "ws-sedes",
    targetId: "t-codex",
    title: { text: title ?? `Thread ${id}` },
    backend: { label: { text: "Codex" }, brand: "codex" },
    backingState: "bound",
    inventoryState: "archived",
    inventoryRevision: 1,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
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
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
    available: true,
    lastActivityAt: hoursAgo(10),
    stateChangedAt: hoursAgo(1),
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...rest,
  } as Thread;
}

function snapshot(
  threads: readonly Thread[],
  overrides: Partial<NormalizedApplicationSnapshot> = {},
): NormalizedApplicationSnapshot {
  return {
    advisories: [],
    environments: [
      {
        id: "env-local",
        kind: "local",
        label: { text: "This machine" },
        available: true,
        directoryBrowsing: "available",
      },
      {
        id: "env-ssh",
        kind: "ssh",
        label: { text: "build-box" },
        available: false,
        directoryBrowsing: "unavailable",
      },
    ],
    workspaces: [
      {
        id: "ws-sedes",
        environmentId: "env-local",
        label: { text: "sedes" },
        displayPath: { text: "~/src/sedes" },
        available: true,
      },
      {
        id: "ws-acme",
        environmentId: "env-local",
        label: { text: "acme-web" },
        displayPath: { text: "~/src/acme-web" },
        available: true,
      },
      {
        id: "ws-infra",
        environmentId: "env-ssh",
        label: { text: "infra" },
        displayPath: { text: "/srv/infra" },
        available: false,
      },
    ],
    executionTargets: [
      {
        id: "t-codex",
        environmentId: "env-local",
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
      {
        id: "t-claude",
        environmentId: "env-local",
        label: { text: "Claude Code" },
        backend: { label: { text: "Claude" }, brand: "claude" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
      {
        id: "t-ssh",
        environmentId: "env-ssh",
        label: { text: "Codex on build-box" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        workspaceExecution: { kind: "direct_only" },
        available: false,
        unavailableReason: { text: "Offline" },
      },
    ],
    threads: [...threads],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [
      { id: "group-1", name: "Launch", revision: 1, memberCount: 1, activeMemberCount: 0 },
    ],
    lineageFamilies: [],
    defaultNewThreadTargetId: null,
    counts: { active: 0, snoozed: 0, settled: 0, archived: threads.length },
    tasks: [],
    ...overrides,
  } as NormalizedApplicationSnapshot;
}

const clone = <Value>(value: Value): Value => structuredClone(value);

function project(
  snap: NormalizedApplicationSnapshot,
  options: Partial<ArchiveProjectionOptions> & {
    readonly preferences?: Partial<typeof SIDEBAR_VIEW_DEFAULTS>;
  } = {},
) {
  const base = selectArchiveBase(snap, []);
  const scope = deriveSidebarInventoryScope(snap, {
    ...SIDEBAR_VIEW_DEFAULTS,
    ...options.preferences,
  });
  return projectArchivedThreads(base, {
    scope,
    search: "",
    sort: "archived",
    groupBy: "none",
    now: NOW,
    ...options,
  });
}

const ids = (projection: ReturnType<typeof project>) =>
  projection.groups.flatMap(({ rows }) => rows.map(({ id }) => id));

describe("selectArchiveBase", () => {
  it("keeps only archived threads and resolves display fields", () => {
    const snap = snapshot(
      [
        thread("active", { inventoryState: "active" }),
        thread("settled", { inventoryState: "settled" }),
        thread("a", {
          targetId: "t-claude",
          backend: { label: { text: "Claude" }, brand: "claude" },
        }),
        thread("b", { workspaceId: "ws-infra", targetId: "t-ssh", title: "" }),
        thread("c", {
          preferredWorktree: {
            rootId: "root-1",
            displayLabel: "sedes-wt",
            branch: "feat/archive",
            availability: "unavailable",
          },
        } as Partial<Thread>),
      ],
      {
        forkOrigins: [
          {
            childThreadId: "a",
            sourceThreadId: "active",
            sourceTurnId: null,
            sourceTurnCompletedAt: null,
            boundaryKind: "completed_turn_inclusive",
            originKind: "user_fork",
            initiatingAgentThreadId: null,
            initiatingToolClientId: null,
            branchMethod: "provider_native",
            createdAt: hoursAgo(5),
          },
        ],
      },
    );
    const base = selectArchiveBase(snap, ["c"]);
    expect(base.rows.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    const [a, b, c] = base.rows;
    expect(a).toMatchObject({
      title: "Thread a",
      brand: "claude",
      projectLabel: "sedes",
      targetLabel: "Claude Code · Claude",
      forkSourceTitle: "Thread active",
      configurationCopyPending: false,
    });
    // The remote project is qualified by its environment; the Target that
    // only repeats its backend label adds nothing.
    expect(b).toMatchObject({
      title: "Untitled thread",
      projectLabel: "infra · build-box",
      projectAvailable: false,
      environmentAvailable: false,
      targetLabel: "Codex on build-box · Codex",
      targetAvailable: false,
    });
    expect(c).toMatchObject({
      targetLabel: null,
      worktreeLabel: "feat/archive",
      worktreeAvailable: false,
      configurationCopyPending: true,
    });
  });

  it("returns the previous base when an event changes nothing it renders", () => {
    const snap = snapshot([thread("a"), thread("b"), thread("live", { inventoryState: "active" })]);
    const first = selectArchiveBase(snap, []);
    // The normalized store re-parses every snapshot: equal values, new objects.
    const reparsed = clone(snap);
    expect(selectArchiveBase(reparsed, [], first)).toBe(first);
    // An active thread's run state is not archive state.
    const running = clone(snap);
    running.threads[2] = { ...running.threads[2]!, runState: "running" };
    expect(selectArchiveBase(running, [], first)).toBe(first);
  });

  it("replaces only changed rows and keeps unchanged row objects", () => {
    const snap = snapshot([thread("a"), thread("b")]);
    const first = selectArchiveBase(snap, []);
    const renamed = clone(snap);
    renamed.threads[1] = { ...renamed.threads[1]!, title: { text: "Renamed" } };
    const second = selectArchiveBase(renamed, [], first);
    expect(second).not.toBe(first);
    expect(second.catalog).toBe(first.catalog);
    expect(second.rows[0]).toBe(first.rows[0]);
    expect(second.rows[1]).not.toBe(first.rows[1]);
    expect(second.rows[1]!.title).toBe("Renamed");
  });

  it("rebuilds labels when the catalog changes and drops restored threads", () => {
    const snap = snapshot([thread("a"), thread("b")]);
    const first = selectArchiveBase(snap, []);
    const relabelled = clone(snap);
    relabelled.workspaces[0] = {
      ...relabelled.workspaces[0]!,
      label: { text: "sedes-renamed" },
    };
    const second = selectArchiveBase(relabelled, [], first);
    expect(second.catalog).not.toBe(first.catalog);
    expect(second.rows.map(({ projectLabel }) => projectLabel)).toEqual([
      "sedes-renamed",
      "sedes-renamed",
    ]);
    const restored = clone(relabelled);
    restored.threads[0] = { ...restored.threads[0]!, inventoryState: "active" };
    const third = selectArchiveBase(restored, [], second);
    expect(third.rows.map(({ id }) => id)).toEqual(["b"]);
    expect(third.rows[0]).toBe(second.rows[1]);
  });

  it("compares rows and protocol values structurally", () => {
    const base = selectArchiveBase(snapshot([thread("a")]), []);
    const row = base.rows[0]!;
    expect(archivedRowsEqual(row, { ...row, thread: clone(row.thread) })).toBe(true);
    expect(archivedRowsEqual(row, { ...row, targetLabel: "Other" })).toBe(false);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
  });
});

describe("projectArchivedThreads scope", () => {
  const snap = snapshot([
    thread("sedes-codex"),
    thread("sedes-claude", {
      targetId: "t-claude",
      backend: { label: { text: "Claude" }, brand: "claude" },
      groupId: "group-1",
    }),
    thread("acme-codex", { workspaceId: "ws-acme" }),
    thread("infra-ssh", { workspaceId: "ws-infra", targetId: "t-ssh" }),
  ]);

  it("lists every archived thread without a scope", () => {
    const projection = project(snap);
    expect(projection).toMatchObject({ total: 4, scopedCount: 4, matchCount: 4 });
  });

  it.each([
    [{ projectFilterName: "sedes" }, ["sedes-codex", "sedes-claude"]],
    [{ targetFilterId: "t-claude" }, ["sedes-claude"]],
    [{ environmentFilterId: "env-ssh" }, ["infra-ssh"]],
    [{ groupFilterId: "group-1" }, ["sedes-claude"]],
    [{ ungroupedFilter: true }, ["sedes-codex", "acme-codex", "infra-ssh"]],
    [
      { environmentFilterId: "env-local", projectFilterName: "acme-web" },
      ["acme-codex"],
    ],
  ])("applies the sidebar scope %j", (preferences, expected) => {
    const projection = project(snap, { preferences });
    expect(new Set(ids(projection))).toEqual(new Set(expected));
    expect(projection.total).toBe(4);
    expect(projection.scopedCount).toBe(expected.length);
  });

  it("ignores the sidebar Show toggles and pinned-only", () => {
    const projection = project(snap, {
      preferences: {
        show: { snoozed: false, settled: false, drafts: false },
        modes: { time: { pinnedOnly: true } },
      },
    });
    expect(projection.matchCount).toBe(4);
  });
});

describe("projectArchivedThreads search", () => {
  it("matches with the sidebar's rules and never lists ancestors as context", () => {
    const parent = thread("parent", { title: "Parent planning" });
    const child = thread("child", { title: "Refactor archive page" });
    const snap = snapshot(
      [
        parent,
        child,
        thread("remote", { workspaceId: "ws-infra", targetId: "t-ssh", title: "Ops" }),
      ],
      {
        forkOrigins: [
          {
            childThreadId: "child",
            sourceThreadId: "parent",
            sourceTurnId: null,
            sourceTurnCompletedAt: null,
            boundaryKind: "completed_turn_inclusive",
            originKind: "user_fork",
            initiatingAgentThreadId: null,
            initiatingToolClientId: null,
            branchMethod: "provider_native",
            createdAt: hoursAgo(2),
          },
        ],
        lineagePlacements: [
          {
            childThreadId: "child",
            mode: "nested_under_source",
            revision: 0,
            updatedAt: hoursAgo(2),
          },
        ],
      },
    );
    expect(ids(project(snap, { search: "  REFACTOR " }))).toEqual(["child"]);
    // Every field the sidebar matcher reads: path, environment, and target.
    for (const query of ["/srv/infra", "build-box", "codex on", "codex"]) {
      const sidebarMatches = snap.threads
        .filter(createThreadSearchMatcher(query, snap))
        .map(({ id }) => id);
      expect(new Set(ids(project(snap, { search: query })))).toEqual(
        new Set(sidebarMatches),
      );
    }
    const projection = project(snap, { search: "nothing like this" });
    expect(projection).toMatchObject({ total: 3, scopedCount: 3, matchCount: 0, groups: [] });
  });
});

describe("projectArchivedThreads order and grouping", () => {
  const snap = snapshot([
    thread("b", { title: "beta", stateChangedAt: hoursAgo(2), lastActivityAt: hoursAgo(400) }),
    thread("a", { title: "Alpha 10", stateChangedAt: hoursAgo(30), lastActivityAt: hoursAgo(1) }),
    thread("c", {
      title: "alpha 9",
      workspaceId: "ws-acme",
      stateChangedAt: hoursAgo(24 * 40),
      lastActivityAt: hoursAgo(24 * 41),
    }),
    thread("d", { title: "Delta", stateChangedAt: hoursAgo(2), lastActivityAt: hoursAgo(3) }),
  ]);

  it("sorts by archive time, last activity, or title", () => {
    expect(ids(project(snap, { sort: "archived" }))).toEqual(["b", "d", "a", "c"]);
    expect(ids(project(snap, { sort: "activity" }))).toEqual(["a", "d", "b", "c"]);
    expect(ids(project(snap, { sort: "title" }))).toEqual(["c", "a", "b", "d"]);
  });

  it("groups by the sort's date bucket", () => {
    const byArchive = project(snap, { groupBy: "date" });
    expect(byArchive.groups.map(({ label, rows }) => [label, rows.map(({ id }) => id)])).toEqual([
      ["Today", ["b", "d"]],
      ["Yesterday", ["a"]],
      [expect.any(String), ["c"]],
    ]);
    const byActivity = project(snap, { groupBy: "date", sort: "activity" });
    expect(byActivity.groups[0]).toMatchObject({ label: "Today", rows: [{ id: "a" }, { id: "d" }] });
  });

  it("groups by project label, and title order never groups by date", () => {
    const byProject = project(snap, { groupBy: "project", sort: "title" });
    expect(byProject.groupBy).toBe("project");
    expect(byProject.groups.map(({ label, rows }) => [label, rows.map(({ id }) => id)])).toEqual([
      ["acme-web", ["c"]],
      ["sedes", ["a", "b", "d"]],
    ]);
    const titleByDate = project(snap, { groupBy: "date", sort: "title" });
    expect(titleByDate.groupBy).toBe("none");
    expect(titleByDate.groups).toHaveLength(1);
    expect(titleByDate.groups[0]!.label).toBeNull();
    expect(effectiveArchiveGroupBy("activity", "date")).toBe("date");
  });
});

describe("pageArchivedThreads", () => {
  const snap = snapshot(
    Array.from({ length: 7 }, (_, index) =>
      thread(`t${index}`, { stateChangedAt: hoursAgo(index < 3 ? 1 + index : 30 + index) }),
    ),
  );

  it("renders the first rows with each group's full count", () => {
    const projection = project(snap, { groupBy: "date" });
    const page = pageArchivedThreads(projection, 4);
    expect(page.rows.map(({ id }) => id)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(page.groups.map(({ label, count, rows }) => [label, count, rows.length])).toEqual([
      ["Today", 3, 3],
      ["Yesterday", 4, 1],
    ]);
    expect(page.remaining).toBe(3);
    const next = pageArchivedThreads(projection, 8);
    expect(next.rows).toHaveLength(7);
    expect(next.remaining).toBe(0);
  });
});

describe("archiveAgeLabel", () => {
  it.each([
    [0, "now"],
    [5 * 60_000, "5m"],
    [2 * 3_600_000, "2h"],
    [3 * 86_400_000, "3d"],
    [29 * 86_400_000, "29d"],
  ])("labels %d ms ago as %s", (elapsed, label) => {
    expect(archiveAgeLabel(NOW - elapsed, NOW)).toBe(label);
  });

  it("falls back to a short date after about a month", () => {
    const sameYear = new Date(2026, 7, 12, 12).getTime();
    expect(archiveAgeLabel(sameYear, NOW)).toBe(
      new Date(sameYear).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    const earlier = new Date(2025, 2, 4, 12).getTime();
    expect(archiveAgeLabel(earlier, NOW)).toBe(
      new Date(earlier).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
    );
  });
});
