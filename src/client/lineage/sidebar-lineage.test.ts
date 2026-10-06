import { describe, expect, it } from "vitest";
import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
  NormalizedThreadForkOrigin,
  NormalizedThreadLineagePlacement,
} from "../../shared/index.js";
import { deriveSidebarLineage } from "./sidebar-lineage.js";

function thread(
  id: string,
  input: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: id },
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
    nonArchivedWorkpadCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: `2026-07-30T15:00:0${id.length}.000Z`,
    stateChangedAt: "2026-07-30T15:00:00.000Z",
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

function origin(
  childThreadId: string,
  sourceThreadId: string,
): NormalizedThreadForkOrigin {
  return {
    childThreadId,
    sourceThreadId,
    sourceTurnId: `turn-${sourceThreadId}`,
    sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
    boundaryKind: "completed_turn_inclusive",
    originKind: "user_fork",
    initiatingAgentThreadId: null,
    initiatingToolClientId: null,
    branchMethod: "provider_native",
    createdAt: "2026-07-30T15:00:00.000Z",
  };
}

function placement(
  childThreadId: string,
  mode: "nested_under_source" | "top_level" = "nested_under_source",
): NormalizedThreadLineagePlacement {
  return {
    childThreadId,
    mode,
    revision: 1,
    updatedAt: "2026-07-30T15:00:00.000Z",
  };
}

function snapshot(
  threads: NormalizedApplicationThreadSummary[],
  origins: NormalizedThreadForkOrigin[] = [],
  placements: NormalizedThreadLineagePlacement[] = [],
): NormalizedApplicationSnapshot {
  return {
    advisories: [],
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "unavailable",
      },
    ],
    projects: [{ id: "project-1", name: "Project", revision: 0 }],
    workspaces: [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        projectId: "project-1",
        label: { text: "Project" },
        displayPath: { text: "/project" },
        available: true,
      },
    ],
    threads,
    forkOrigins: origins,
    lineagePlacements: placements,
    groups: [],
    lineageFamilies: [],
    executionTargets: [
      {
        id: "target-1",
        environmentId: "environment-1",
        label: { text: "Pi" },
        backend: { label: { text: "Pi" }, brand: "pi" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    defaultNewThreadTargetId: null,
    counts: { active: threads.length, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}

describe("deriveSidebarLineage", () => {
  it("buckets roots by project, so forks in another location nest under their root", () => {
    const threads = [
      thread("root"),
      thread("remote-fork", { workspaceId: "workspace-remote" }),
      thread("other", { workspaceId: "workspace-other" }),
    ];
    const app = snapshot(threads, [origin("remote-fork", "root")], [
      placement("remote-fork"),
    ]);
    const result = deriveSidebarLineage({
      snapshot: {
        ...app,
        projects: [
          ...app.projects,
          { id: "project-2", name: "Other", revision: 0 },
        ],
        workspaces: [
          ...app.workspaces,
          {
            id: "workspace-remote",
            environmentId: "environment-1",
            projectId: "project-1",
            label: { text: "Project copy" },
            displayPath: { text: "/copy" },
            available: true,
          },
          {
            id: "workspace-other",
            environmentId: "environment-1",
            projectId: "project-2",
            label: { text: "Other" },
            displayPath: { text: "/other" },
            available: true,
          },
        ],
      },
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.nodesById.get("remote-fork")?.parentId).toBe("root");
    expect(result.nodesById.get("remote-fork")?.bucket).toBe("project:project-1");
    expect(
      result.rootsByBucket.get("project:project-1")?.map(({ thread: { id } }) => id),
    ).toEqual(["root"]);
    expect(
      result.rootsByBucket.get("project:project-2")?.map(({ thread: { id } }) => id),
    ).toEqual(["other"]);
  });

  it("counts descendants with pending questions as attention until the final question resolves", () => {
    for (const pendingQuestionCount of [2, 1, 0]) {
      const threads = [
        thread("root"),
        thread("child", { pendingQuestionCount }),
      ];
      const result = deriveSidebarLineage({
        snapshot: snapshot(threads, [origin("child", "root")], [placement("child")]),
        visibleThreads: threads,
        grouped: true,
        search: "",
      });
      expect(result.nodesById.get("root")?.aggregate).toMatchObject({
        count: 1,
        attention: pendingQuestionCount > 0 ? 1 : 0,
      });
    }
  });

  it("builds fork-of-fork families and aggregates descendant attention", () => {
    const threads = [
      thread("root"),
      thread("child", { runState: "running" }),
      thread("grandchild", { runState: "waiting_for_input" }),
      thread("done-child", {
        attention: {
          wake: false,
          automationContext: null,
          unseenCompletion: true,
          queueFailure: false,
        },
      }),
      thread("failed-child", {
        runState: "failed",
        attention: {
          wake: false,
          automationContext: null,
          unseenCompletion: false,
          queueFailure: true,
        },
      }),
    ];
    const app = snapshot(
      threads,
      [
        origin("child", "root"),
        origin("grandchild", "child"),
        origin("done-child", "root"),
        origin("failed-child", "root"),
      ],
      [
        placement("child"),
        placement("grandchild"),
        placement("done-child"),
        placement("failed-child"),
      ],
    );
    const result = deriveSidebarLineage({
      snapshot: app,
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.roots.map(({ thread: { id } }) => id)).toEqual(["root"]);
    expect(result.nodesById.get("child")?.parentId).toBe("root");
    expect(result.nodesById.get("grandchild")?.depth).toBe(2);
    expect(result.nodesById.get("root")?.aggregate).toMatchObject({
      count: 4,
      running: 1,
      needsInput: 1,
      done: 1,
      failed: 1,
      attention: 1,
    });
  });

  it("promotes lifecycle-separated and detached children without mutating placement", () => {
    const threads = [
      thread("root", { inventoryState: "snoozed" }),
      thread("active-child"),
      thread("detached"),
    ];
    const app = snapshot(
      threads,
      [origin("active-child", "root"), origin("detached", "active-child")],
      [placement("active-child"), placement("detached", "top_level")],
    );
    const result = deriveSidebarLineage({
      snapshot: app,
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.nodesById.get("active-child")?.parentId).toBeUndefined();
    expect(result.nodesById.get("active-child")?.placement?.mode).toBe(
      "nested_under_source",
    );
    expect(result.nodesById.get("detached")?.parentId).toBeUndefined();
  });

  it("keeps nested forks in the bucket that owns their automation state", () => {
    const automation = {
      status: "paused" as const,
      runMode: "same_thread" as const,
      scheduleKind: "date_time" as const,
      schedule: {
        kind: "date_time" as const,
        runAt: "2026-07-30T00:00:00.000Z",
      },
      misfirePolicy: "coalesce" as const,
      promptPreview: "Review the repository.",
      revision: 0,
      hasPrecheck: false,
    };
    const threads = [
      thread("source"),
      thread("automated-child", { automation }),
    ];
    const result = deriveSidebarLineage({
      snapshot: snapshot(
        threads,
        [origin("automated-child", "source")],
        [placement("automated-child")],
      ),
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.nodesById.get("automated-child")?.parentId).toBeUndefined();
    expect(result.nodesById.get("automated-child")?.bucket).toBe("automations");
    expect(
      result.rootsByBucket.get("automations")?.map(({ thread: { id } }) => id),
    ).toEqual(["automated-child"]);
    expect(
      result.rootsByBucket
        .get("project:project-1")
        ?.map(({ thread: { id } }) => id),
    ).toEqual(["source"]);
  });

  it("keeps non-automated clone results nested under their automated source", () => {
    const automation = {
      status: "enabled" as const,
      runMode: "clone" as const,
      scheduleKind: "interval" as const,
      schedule: {
        kind: "interval" as const,
        anchorAt: "2026-07-30T00:00:00.000Z",
        everySeconds: 3_600,
      },
      misfirePolicy: "coalesce" as const,
      promptPreview: "Review the repository.",
      revision: 2,
      hasPrecheck: false,
    };
    const threads = [
      thread("automated-source", { automation }),
      thread("clone-result", {
        attention: {
          wake: false,
          automationContext: "failed",
          unseenCompletion: false,
          queueFailure: false,
        },
      }),
    ];
    const result = deriveSidebarLineage({
      snapshot: snapshot(
        threads,
        [origin("clone-result", "automated-source")],
        [placement("clone-result")],
      ),
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.nodesById.get("clone-result")?.parentId).toBe(
      "automated-source",
    );
    expect(result.nodesById.get("clone-result")?.bucket).toBe("automations");
    expect(
      result.rootsByBucket.get("automations")?.map(({ thread }) => thread.id),
    ).toEqual(["automated-source"]);
    expect(result.nodesById.get("automated-source")?.aggregate.failed).toBe(1);
  });

  it.each(["snoozed", "settled", "archived"] as const)(
    "keeps an active descendant reachable when its source is %s",
    (inventoryState) => {
      const threads = [
        thread("source", { inventoryState }),
        thread("active-child"),
      ];
      const result = deriveSidebarLineage({
        snapshot: snapshot(
          threads,
          [origin("active-child", "source")],
          [placement("active-child")],
        ),
        visibleThreads: threads,
        grouped: true,
        search: "",
      });

      expect(result.nodesById.get("active-child")?.parentId).toBeUndefined();
      expect(result.nodesById.get("active-child")?.bucket).toBe(
        "project:project-1",
      );
      expect(result.nodesById.get("active-child")?.placement?.mode).toBe(
        "nested_under_source",
      );
    },
  );

  it("projects no archived threads but keeps what they contribute to projected ones", () => {
    const threads = [
      thread("root"),
      thread("archived-child", { inventoryState: "archived" }),
      thread("grandchild"),
      thread("archived-needle", {
        inventoryState: "archived",
        title: { text: "Needle" },
      }),
    ];
    const app = snapshot(
      threads,
      [origin("archived-child", "root"), origin("grandchild", "archived-child")],
      [placement("archived-child"), placement("grandchild")],
    );
    const browse = deriveSidebarLineage({
      snapshot: app,
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect([...browse.nodesById.keys()].sort()).toEqual(["grandchild", "root"]);
    expect([...browse.rootsByBucket.keys()]).toEqual(["project:project-1"]);
    expect(browse.roots.map(({ thread: { id } }) => id)).toEqual([
      "root",
      "grandchild",
    ]);
    // Loaded family counts still reach through the archived fork.
    expect(browse.nodesById.get("root")?.loadedFamilyDescendantCount).toBe(2);
    expect(browse.nodesById.get("root")?.children).toEqual([]);

    const search = deriveSidebarLineage({
      snapshot: app,
      visibleThreads: [threads[3]!],
      grouped: true,
      search: "needle",
    });
    // An archived match still counts as a match, though it is not projected.
    expect([...search.matchingIds]).toEqual(["archived-needle"]);
    expect(search.nodesById.size).toBe(0);
  });

  it("keeps lineage context reached through an archived source during search", () => {
    const threads = [
      thread("ancestor"),
      thread("archived-source", { inventoryState: "archived" }),
      thread("match", { title: { text: "Needle" } }),
    ];
    const result = deriveSidebarLineage({
      snapshot: snapshot(
        threads,
        [
          origin("archived-source", "ancestor"),
          origin("match", "archived-source"),
        ],
        [placement("archived-source"), placement("match")],
      ),
      visibleThreads: [threads[2]!],
      grouped: true,
      search: "needle",
    });

    expect([...result.nodesById.keys()].sort()).toEqual(["ancestor", "match"]);
    expect(result.nodesById.get("ancestor")?.matchesSearch).toBe(false);
    expect(result.nodesById.get("match")?.parentId).toBeUndefined();
  });

  it("derives the same projected forest with or without archived threads", () => {
    const active = [
      thread("a"),
      thread("a-fork", { runState: "running" }),
      thread("a-fork-fork", { pendingQuestionCount: 1 }),
      thread("b", { inventoryState: "settled" }),
      thread("b-fork", { inventoryState: "settled" }),
      thread("c", { inventoryState: "snoozed" }),
    ];
    const archived = [
      thread("x", { inventoryState: "archived" }),
      thread("x-fork", { inventoryState: "archived" }),
      thread("a-archived-fork", { inventoryState: "archived" }),
    ];
    const origins = [
      origin("a-fork", "a"),
      origin("a-fork-fork", "a-fork"),
      origin("b-fork", "b"),
      origin("x-fork", "x"),
      origin("a-archived-fork", "a"),
    ];
    const placements = origins.map(({ childThreadId }) =>
      placement(childThreadId),
    );
    const shape = (threads: NormalizedApplicationThreadSummary[]) => {
      const result = deriveSidebarLineage({
        snapshot: snapshot(threads, origins, placements),
        visibleThreads: threads,
        grouped: true,
        search: "",
      });
      return {
        buckets: [...result.rootsByBucket].map(([bucket, roots]) => [
          bucket,
          roots.map(({ thread: { id } }) => id),
        ]),
        nodes: [...result.nodesById.values()]
          .map((node) => ({
            id: node.thread.id,
            parentId: node.parentId,
            children: node.children.map(({ thread: { id } }) => id),
            bucket: node.bucket,
            depth: node.depth,
            maxActivityAt: node.maxActivityAt,
            aggregate: node.aggregate,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    };

    expect(shape([...archived, ...active])).toEqual(shape(active));
  });

  it("keeps matching descendants and ancestor context during search", () => {
    const threads = [
      thread("root"),
      thread("child", { title: { text: "Needle" } }),
    ];
    const app = snapshot(
      threads,
      [origin("child", "root")],
      [placement("child")],
    );
    const result = deriveSidebarLineage({
      snapshot: app,
      visibleThreads: [threads[1]!],
      grouped: true,
      search: "needle",
    });

    expect(result.nodesById.get("root")?.matchesSearch).toBe(false);
    expect(result.nodesById.get("child")?.matchesSearch).toBe(true);
    expect(result.roots[0]?.children[0]?.thread.id).toBe("child");
  });

  it("renders every thread as a root in flat mode and breaks malformed cycles", () => {
    const threads = [thread("a"), thread("b")];
    const app = snapshot(
      threads,
      [origin("a", "b"), origin("b", "a")],
      [placement("a"), placement("b")],
    );
    for (const grouped of [true, false]) {
      const result = deriveSidebarLineage({
        snapshot: app,
        visibleThreads: threads,
        grouped,
        search: "",
      });
      expect(result.roots).toHaveLength(2);
    }
  });

  it("derives a deep family iteratively without losing identity or aggregates", () => {
    const size = 1_200;
    const threads = Array.from({ length: size }, (_, index) =>
      thread(`deep-${index}`, {
        title: { text: "Duplicate title" },
        lastActivityAt: new Date(1_000 + index).toISOString(),
      }),
    );
    const origins = threads
      .slice(1)
      .map((candidate, index) => origin(candidate.id, threads[index]!.id));
    const placements = threads
      .slice(1)
      .map((candidate) => placement(candidate.id));

    const result = deriveSidebarLineage({
      snapshot: snapshot(threads, origins, placements),
      visibleThreads: threads,
      grouped: true,
      search: "",
    });

    expect(result.roots.map(({ thread: { id } }) => id)).toEqual(["deep-0"]);
    expect(result.nodesById.get(`deep-${size - 1}`)?.depth).toBe(size - 1);
    expect(result.nodesById.get("deep-0")?.aggregate.count).toBe(size - 1);
    expect(result.nodesById.get("deep-0")?.loadedFamilyDescendantCount).toBe(
      size - 1,
    );
    expect(result.nodesById.size).toBe(size);
  });
});
