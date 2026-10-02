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
  overrides: Omit<Partial<Thread>, "title"> & { readonly title?: string } = {},
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
    // Project names are independent of folder names: acme-web is the
    // Acme website project.
    projects: [
      { id: "project-sedes", name: "sedes", revision: 1 },
      { id: "project-acme", name: "Acme website", revision: 1 },
      { id: "project-infra", name: "infra", revision: 1 },
    ],
    workspaces: [
      {
        id: "ws-sedes",
        environmentId: "env-local",
        projectId: "project-sedes",
        label: { text: "sedes" },
        displayPath: { text: "~/src/sedes" },
        available: true,
      },
      {
        id: "ws-acme",
        environmentId: "env-local",
        projectId: "project-acme",
        label: { text: "acme-web" },
        displayPath: { text: "~/src/acme-web" },
        available: true,
      },
      {
        id: "ws-infra",
        environmentId: "env-ssh",
        projectId: "project-infra",
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
      {
        id: "group-1",
        name: "Launch",
        revision: 1,
        memberCount: 1,
        activeMemberCount: 0,
      },
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
        } as Omit<Partial<Thread>, "title">),
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
      projectId: "project-sedes",
      projectLabel: "sedes",
      locationTag: null,
      targetLabel: "Claude Code",
      forkSourceTitle: "Thread active",
      configurationCopyPending: false,
    });
    // The remote project is qualified by its environment; the Target that
    // only repeats its backend label adds nothing.
    expect(b).toMatchObject({
      title: "Untitled thread",
      projectLabel: "infra · build-box",
      locationAvailable: false,
      environmentAvailable: false,
      targetLabel: "Codex on build-box",
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
    const snap = snapshot([
      thread("a"),
      thread("b"),
      thread("live", { inventoryState: "active" }),
    ]);
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
    relabelled.projects[0] = {
      ...relabelled.projects[0]!,
      name: "sedes-renamed",
      revision: 2,
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
    expect(archivedRowsEqual(row, { ...row, thread: clone(row.thread) })).toBe(
      true,
    );
    expect(archivedRowsEqual(row, { ...row, targetLabel: "Other" })).toBe(
      false,
    );
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
    expect(projection).toMatchObject({
      total: 4,
      scopedCount: 4,
      matchCount: 4,
    });
  });

  it.each([
    [{ projectFilterId: "project-sedes" }, ["sedes-codex", "sedes-claude"]],
    [{ targetFilterId: "t-claude" }, ["sedes-claude"]],
    [{ environmentFilterId: "env-ssh" }, ["infra-ssh"]],
    [{ groupFilterId: "group-1" }, ["sedes-claude"]],
    [{ ungroupedFilter: true }, ["sedes-codex", "acme-codex", "infra-ssh"]],
    [
      { environmentFilterId: "env-local", projectFilterId: "project-acme" },
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
        thread("remote", {
          workspaceId: "ws-infra",
          targetId: "t-ssh",
          title: "Ops",
        }),
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
    expect(projection).toMatchObject({
      total: 3,
      scopedCount: 3,
      matchCount: 0,
      groups: [],
    });
  });

  it("matches the project name, which no folder or path carries", () => {
    const snap = snapshot([
      thread("site", { workspaceId: "ws-acme", title: "Hero banner" }),
      thread("other", { title: "Release notes" }),
    ]);
    expect(ids(project(snap, { search: "WEBSITE" }))).toEqual(["site"]);
    expect(
      snap.threads
        .filter(createThreadSearchMatcher("website", snap))
        .map(({ id }) => id),
    ).toEqual(["site"]);
  });
});

describe("projectArchivedThreads order and grouping", () => {
  const snap = snapshot([
    thread("b", {
      title: "beta",
      stateChangedAt: hoursAgo(2),
      lastActivityAt: hoursAgo(400),
    }),
    thread("a", {
      title: "Alpha 10",
      stateChangedAt: hoursAgo(30),
      lastActivityAt: hoursAgo(1),
    }),
    thread("c", {
      title: "alpha 9",
      workspaceId: "ws-acme",
      stateChangedAt: hoursAgo(24 * 40),
      lastActivityAt: hoursAgo(24 * 41),
    }),
    thread("d", {
      title: "Delta",
      stateChangedAt: hoursAgo(2),
      lastActivityAt: hoursAgo(3),
    }),
  ]);

  it("sorts by archive time, last activity, or title", () => {
    expect(ids(project(snap, { sort: "archived" }))).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    expect(ids(project(snap, { sort: "activity" }))).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(ids(project(snap, { sort: "title" }))).toEqual(["c", "a", "b", "d"]);
  });

  it("groups by the sort's date bucket", () => {
    const byArchive = project(snap, { groupBy: "date" });
    expect(
      byArchive.groups.map(({ label, rows }) => [
        label,
        rows.map(({ id }) => id),
      ]),
    ).toEqual([
      ["Today", ["b", "d"]],
      ["Yesterday", ["a"]],
      [expect.any(String), ["c"]],
    ]);
    const byActivity = project(snap, { groupBy: "date", sort: "activity" });
    expect(byActivity.groups[0]).toMatchObject({
      label: "Today",
      rows: [{ id: "a" }, { id: "d" }],
    });
  });

  it("groups by project label, and title order never groups by date", () => {
    const byProject = project(snap, { groupBy: "project", sort: "title" });
    expect(byProject.groupBy).toBe("project");
    expect(
      byProject.groups.map(({ label, rows }) => [
        label,
        rows.map(({ id }) => id),
      ]),
    ).toEqual([
      ["Acme website", ["c"]],
      ["sedes", ["a", "b", "d"]],
    ]);
    const titleByDate = project(snap, { groupBy: "date", sort: "title" });
    expect(titleByDate.groupBy).toBe("none");
    expect(titleByDate.groups).toHaveLength(1);
    expect(titleByDate.groups[0]!.label).toBeNull();
    expect(effectiveArchiveGroupBy("activity", "date")).toBe("date");
  });
});

describe("projectArchivedThreads projects", () => {
  // One project in three locations: its checkout and a sibling folder on this
  // machine, and a second checkout on build-box.
  const catalog: Partial<NormalizedApplicationSnapshot> = {
    projects: [
      { id: "project-sedes", name: "sedes", revision: 3 },
      { id: "project-acme", name: "Acme website", revision: 1 },
    ],
    workspaces: [
      {
        id: "ws-sedes",
        environmentId: "env-local",
        projectId: "project-sedes",
        label: { text: "sedes" },
        displayPath: { text: "~/src/sedes" },
        available: true,
      },
      {
        id: "ws-context",
        environmentId: "env-local",
        projectId: "project-sedes",
        label: { text: "sedes-context" },
        displayPath: { text: "~/src/sedes-context" },
        available: true,
      },
      {
        id: "ws-remote",
        environmentId: "env-ssh",
        projectId: "project-sedes",
        label: { text: "sedes" },
        displayPath: { text: "/srv/sedes" },
        available: false,
      },
      {
        id: "ws-acme",
        environmentId: "env-local",
        projectId: "project-acme",
        label: { text: "acme-web" },
        displayPath: { text: "~/src/acme-web" },
        available: true,
      },
    ],
  };
  const snap = snapshot(
    [
      thread("main", { stateChangedAt: hoursAgo(1) }),
      thread("context", {
        workspaceId: "ws-context",
        stateChangedAt: hoursAgo(2),
      }),
      thread("remote", {
        workspaceId: "ws-remote",
        targetId: "t-ssh",
        stateChangedAt: hoursAgo(3),
      }),
      thread("site", { workspaceId: "ws-acme", stateChangedAt: hoursAgo(4) }),
    ],
    catalog,
  );

  it("labels rows by project and folder, and tags where they ran", () => {
    const rows = new Map(
      selectArchiveBase(snap, []).rows.map((row) => [row.id, row]),
    );
    const labels = (id: string) => {
      const { projectId, projectLabel, locationTag } = rows.get(id)!;
      return { projectId, projectLabel, locationTag };
    };
    // The folder that shares the project's name adds nothing; a sibling
    // folder is named, and a remote checkout names its environment.
    expect(labels("main")).toEqual({
      projectId: "project-sedes",
      projectLabel: "sedes",
      locationTag: null,
    });
    expect(labels("context")).toEqual({
      projectId: "project-sedes",
      projectLabel: "sedes › sedes-context",
      locationTag: "sedes-context",
    });
    expect(labels("remote")).toEqual({
      projectId: "project-sedes",
      projectLabel: "sedes · build-box",
      locationTag: "build-box",
    });
    // A single-location project shows its name, never its folder.
    expect(labels("site")).toEqual({
      projectId: "project-acme",
      projectLabel: "Acme website",
      locationTag: null,
    });
  });

  it("groups every location of a project under one header", () => {
    const byProject = project(snap, { groupBy: "project" });
    expect(
      byProject.groups.map(({ key, label, rows }) => [
        key,
        label,
        rows.map(({ id }) => id),
      ]),
    ).toEqual([
      ["project:project-acme", "Acme website", ["site"]],
      ["project:project-sedes", "sedes", ["main", "context", "remote"]],
    ]);
  });

  it("names a single-host project's remote environment in its header", () => {
    const remoteOnly = snapshot(
      [
        thread("remote", { workspaceId: "ws-remote", targetId: "t-ssh" }),
        thread("main", { stateChangedAt: hoursAgo(2) }),
      ],
      {
        projects: [
          { id: "project-sedes", name: "sedes", revision: 1 },
          { id: "project-tools", name: "tools", revision: 1 },
        ],
        workspaces: [
          catalog.workspaces![0]!,
          { ...catalog.workspaces![2]!, projectId: "project-tools", label: { text: "tools" } },
        ],
      },
    );
    const headers = (options: Parameters<typeof project>[1] = {}) =>
      project(remoteOnly, { groupBy: "project", ...options }).groups.map(
        ({ label }) => label,
      );
    // As the per-location header did; a Local-only project names no host.
    expect(headers()).toEqual(["sedes", "tools · build-box"]);
    // Scope already implies the environment.
    expect(
      headers({ preferences: { environmentFilterId: "env-ssh" } }),
    ).toEqual(["tools"]);
    expect(headers({ preferences: { targetFilterId: "t-ssh" } })).toEqual([
      "tools",
    ]);
    // A project on several environments leaves the host to its rows.
    expect(
      project(snap, { groupBy: "project" }).groups.map(({ label }) => label),
    ).toEqual(["Acme website", "sedes"]);
  });

  it("qualifies same-named projects in headers and rows", () => {
    const twins = snapshot(
      [
        thread("original"),
        thread("copy", { workspaceId: "ws-copy", stateChangedAt: hoursAgo(2) }),
      ],
      {
        projects: [
          { id: "project-sedes", name: "sedes", revision: 1 },
          { id: "project-copy", name: "sedes", revision: 1 },
        ],
        workspaces: [
          catalog.workspaces![0]!,
          {
            id: "ws-copy",
            environmentId: "env-local",
            projectId: "project-copy",
            label: { text: "sedes" },
            displayPath: { text: "~/work/sedes" },
            available: true,
          },
        ],
      },
    );
    const byProject = project(twins, { groupBy: "project" });
    expect(
      byProject.groups.map(({ label, rows }) => [
        label,
        rows.map(({ id }) => id),
      ]),
    ).toEqual([
      ["sedes · ~/src/sedes", ["original"]],
      ["sedes · ~/work/sedes", ["copy"]],
    ]);
    expect(
      project(twins).groups[0]!.rows.map(({ projectLabel }) => projectLabel),
    ).toEqual(["sedes · ~/src/sedes", "sedes · ~/work/sedes"]);
  });

  it("scopes to a project by ID across its locations", () => {
    expect(
      ids(project(snap, { preferences: { projectFilterId: "project-sedes" } })),
    ).toEqual(["main", "context", "remote"]);
    expect(
      ids(
        project(snap, {
          preferences: {
            environmentFilterId: "env-ssh",
            projectFilterId: "project-sedes",
          },
        }),
      ),
    ).toEqual(["remote"]);
  });

  it("keeps a stable group for a location the catalog lacks", () => {
    const base = selectArchiveBase(
      snapshot([thread("lost", { workspaceId: "ws-gone" })], catalog),
      [],
    );
    expect(base.rows[0]).toMatchObject({
      projectId: null,
      projectLabel: "Project",
      locationTag: null,
    });
    const scope = deriveSidebarInventoryScope(snap, SIDEBAR_VIEW_DEFAULTS);
    expect(
      projectArchivedThreads(base, {
        scope,
        search: "",
        sort: "archived",
        groupBy: "project",
        now: NOW,
      }).groups.map(({ key, label }) => [key, label]),
    ).toEqual([["location:ws-gone", "Project"]]);
  });

  it("rebuilds rows when a project gains a location", () => {
    const single = snapshot([thread("main")], {
      projects: catalog.projects,
      workspaces: [catalog.workspaces![0]!],
    });
    const first = selectArchiveBase(single, []);
    expect(first.rows[0]!.locationTag).toBeNull();
    const second = selectArchiveBase(
      snapshot([thread("main")], catalog),
      [],
      first,
    );
    expect(second.catalog).not.toBe(first.catalog);
    // The same folder, now one of several: still nothing to tell apart on
    // this machine, so the row object is kept.
    expect(second.rows[0]).toBe(first.rows[0]);
    // Renamed away from its folders, the project names each local folder.
    const renamed = clone(snapshot([thread("main")], catalog));
    renamed.projects[0] = { ...renamed.projects[0]!, name: "Sedes app" };
    const third = selectArchiveBase(renamed, [], second);
    expect(third.rows[0]).toMatchObject({
      projectLabel: "Sedes app › sedes",
      locationTag: "sedes",
    });
  });
});

describe("pageArchivedThreads", () => {
  const snap = snapshot(
    Array.from({ length: 7 }, (_, index) =>
      thread(`t${index}`, {
        stateChangedAt: hoursAgo(index < 3 ? 1 + index : 30 + index),
      }),
    ),
  );

  it("renders the first rows with each group's full count", () => {
    const projection = project(snap, { groupBy: "date" });
    const page = pageArchivedThreads(projection, 4);
    expect(page.rows.map(({ id }) => id)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(
      page.groups.map(({ label, count, rows }) => [label, count, rows.length]),
    ).toEqual([
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
      new Date(sameYear).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    const earlier = new Date(2025, 2, 4, 12).getTime();
    expect(archiveAgeLabel(earlier, NOW)).toBe(
      new Date(earlier).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      }),
    );
  });
});
