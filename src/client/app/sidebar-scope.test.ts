import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import {
  deriveSidebarInventoryScope,
  deriveSidebarLocationSuppression,
  filterThreadsBySidebarScope,
  sidebarScopeRepairAtCursor,
  transitionSidebarInventoryScope,
  type SidebarScopeCatalog,
} from "./sidebar-scope.js";

const applicationGeneration = "00000000-0000-4000-8000-000000000001";

const catalog: SidebarScopeCatalog = {
  environments: [
    {
      id: "env-a",
      kind: "local" as const,
      label: { text: "Host A" },
      available: true,
      directoryBrowsing: "unavailable",
    },
    {
      id: "env-b",
      kind: "ssh" as const,
      label: { text: "Host B" },
      available: false,
      directoryBrowsing: "unavailable",
    },
  ],
  executionTargets: [
    {
      id: "target-a1",
      environmentId: "env-a",
      label: { text: "Socket A" },
      backend: { label: { text: "Codex" }, brand: "codex" },
      workspaceExecution: { kind: "direct_only" },
      available: true,
    },
    {
      id: "target-a2",
      environmentId: "env-a",
      label: { text: "Pi A" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      workspaceExecution: { kind: "direct_only" },
      available: true,
    },
    {
      id: "target-b",
      environmentId: "env-b",
      label: { text: "Socket B" },
      backend: { label: { text: "Codex" }, brand: "codex" },
      workspaceExecution: { kind: "direct_only" },
      available: false,
      unavailableReason: { text: "Host is offline" },
    },
  ],
  workspaces: [
    {
      id: "workspace-a",
      environmentId: "env-a",
      label: { text: "Sedes" },
      displayPath: { text: "/work/sedes" },
      available: true,
    },
    {
      id: "workspace-b",
      environmentId: "env-b",
      label: { text: "Sedes" },
      displayPath: { text: "/work/sedes" },
      available: false,
    },
  ],
  groups: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Design",
      revision: 0,
      memberCount: 1,
      activeMemberCount: 1,
    },
  ],
};

describe("sidebar causal scope repair", () => {
  const preferences = {
    projectFilterPublication: {
      projectName: "New project",
      eventId: `${applicationGeneration}.5`,
    },
  };

  it("preserves a project selected by an application event this tab has not reached", () => {
    expect(
      sidebarScopeRepairAtCursor(
        { environmentFilterId: null, projectFilterName: null },
        preferences,
        `${applicationGeneration}.4`,
        true,
      ),
    ).toEqual({ environmentFilterId: null });
  });

  it("repairs a project once the causal application event has been reached", () => {
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterName: null },
        preferences,
        `${applicationGeneration}.5`,
        true,
      ),
    ).toEqual({ projectFilterName: null });
  });

  it("requires a connected replacement before trusting a different generation", () => {
    const nextGeneration = "00000000-0000-4000-8000-000000000002";
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterName: null },
        preferences,
        `${nextGeneration}.0`,
        false,
      ),
    ).toBeNull();
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterName: null },
        preferences,
        `${nextGeneration}.0`,
        true,
      ),
    ).toEqual({ projectFilterName: null });
  });
});

function preferences(
  overrides: Partial<{
    environmentFilterId: string | null;
    targetFilterId: string | null;
    projectFilterName: string | null;
    groupFilterId: string | null;
    ungroupedFilter: boolean;
  }> = {},
) {
  return {
    environmentFilterId: null,
    targetFilterId: null,
    projectFilterName: null,
    groupFilterId: null,
    ungroupedFilter: false,
    ...overrides,
  };
}

function thread(
  id: string,
  workspaceId: string,
  targetId: string,
  groupId: string | null = null,
): NormalizedApplicationThreadSummary {
  return {
    id,
    workspaceId,
    targetId,
    title: { text: id },
    backend: { label: { text: "Codex" }, brand: "codex" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: false,
    pinRevision: 0,
    groupId,
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
    lastActivityAt: "2026-08-01T12:00:00.000Z",
    stateChangedAt: "2026-08-01T12:00:00.000Z",
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
  };
}

describe("deriveSidebarInventoryScope", () => {
  it("uses a selected target as the effective environment for project options", () => {
    const scope = deriveSidebarInventoryScope(
      catalog,
      preferences({ targetFilterId: "target-b" }),
    );
    expect(scope).toMatchObject({
      environmentId: null,
      targetId: "target-b",
      projectName: null,
      effectiveEnvironmentId: "env-b",
      repair: null,
      activeFilterCount: 1,
    });
    expect(scope.targetOptions.map(({ id }) => id)).toEqual(["target-b"]);
    expect(scope.projectOptions.map(({ id }) => id)).toEqual(["workspace-b"]);
  });

  it("repairs stale IDs and incompatible descendants without substitution", () => {
    const stale = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "env-a",
        targetFilterId: "target-b",
        projectFilterName: "Sedes",
      }),
    );
    expect(stale).toMatchObject({
      environmentId: "env-a",
      targetId: null,
      projectName: "Sedes",
      repair: {
        targetFilterId: null,
      },
    });

    const missing = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "gone",
        targetFilterId: "target-gone",
        projectFilterName: "workspace-gone",
      }),
    );
    expect(missing.repair).toEqual({
      environmentFilterId: null,
      targetFilterId: null,
      projectFilterName: null,
    });
  });

  it("retains unavailable catalog identities for historical filtering", () => {
    const scope = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "env-b",
        targetFilterId: "target-b",
        projectFilterName: "Sedes",
      }),
    );
    expect(scope.repair).toBeNull();
    expect(scope.activeFilterCount).toBe(3);
  });
});

describe("project-name scope", () => {
  it("matches same-name workspaces across environments without implying a location", () => {
    const scope = deriveSidebarInventoryScope(catalog, preferences({ projectFilterName: "Sedes" }));
    expect(scope.projectName).toBe("Sedes");
    expect(scope.effectiveEnvironmentId).toBeNull();
    expect(scope.targetOptions).toEqual(catalog.executionTargets);
    expect(filterThreadsBySidebarScope([
      thread("local", "workspace-a", "target-a1"),
      thread("offline", "workspace-b", "target-b"),
    ], catalog.workspaces, scope).map(({ id }) => id)).toEqual(["local", "offline"]);
    expect(deriveSidebarLocationSuppression(scope, [], { projectGrouped: false, environmentCount: 2 }))
      .toMatchObject({ showEnvironment: true, showProject: false });
  });

  it("preserves an unmatched name across explicit environment changes without broadening results", () => {
    const namedCatalog = { ...catalog, workspaces: catalog.workspaces.map((workspace) =>
      workspace.id === "workspace-b" ? { ...workspace, label: { text: "Remote only" } } : workspace) };
    const next = transitionSidebarInventoryScope(namedCatalog,
      preferences({ projectFilterName: "Remote only" }), { environmentFilterId: "env-a" });
    expect(next.projectFilterName).toBe("Remote only");
    const scope = deriveSidebarInventoryScope(namedCatalog, preferences(next));
    expect(scope.repair).toBeNull();
    expect(filterThreadsBySidebarScope([
      thread("local", "workspace-a", "target-a1"), thread("remote", "workspace-b", "target-b"),
    ], namedCatalog.workspaces, scope)).toEqual([]);
  });

  it("uses exact names including case and punctuation", () => {
    const namedCatalog = { ...catalog, workspaces: [
      ...catalog.workspaces,
      { ...catalog.workspaces[0]!, id: "lower", label: { text: "sedes" } },
      { ...catalog.workspaces[0]!, id: "suffix", label: { text: "Sedes-worktree" } },
      { ...catalog.workspaces[0]!, id: "second-local" },
    ] };
    const scope = deriveSidebarInventoryScope(namedCatalog, preferences({ projectFilterName: "Sedes" }));
    expect(filterThreadsBySidebarScope(namedCatalog.workspaces.map((workspace) =>
      thread(workspace.id, workspace.id, "target-a1")), namedCatalog.workspaces, scope)
      .map(({ id }) => id)).toEqual(["workspace-a", "workspace-b", "second-local"]);
  });
});

describe("transitionSidebarInventoryScope", () => {
  it("clears incompatible target and preserves the project name across environments", () => {
    expect(
      transitionSidebarInventoryScope(
        catalog,
        preferences({
          targetFilterId: "target-b",
          projectFilterName: "Sedes",
        }),
        { environmentFilterId: "env-a" },
      ),
    ).toEqual({
      environmentFilterId: "env-a",
      targetFilterId: null,
      projectFilterName: "Sedes",
      groupFilterId: null,
      ungroupedFilter: false,
    });
  });

  it("keeps an independent compatible project when Target changes", () => {
    expect(
      transitionSidebarInventoryScope(
        catalog,
        preferences({ projectFilterName: "Sedes" }),
        { targetFilterId: "target-a2" },
      ),
    ).toEqual({
      environmentFilterId: null,
      targetFilterId: "target-a2",
      projectFilterName: "Sedes",
      groupFilterId: null,
      ungroupedFilter: false,
    });
  });
});

describe("sidebar scope projection and suppression", () => {
  const threads = [
    thread("a1", "workspace-a", "target-a1"),
    thread("a2", "workspace-a", "target-a2"),
    thread("b", "workspace-b", "target-b"),
  ];

  it("intersects exact Environment and Target IDs with Project name", () => {
    expect(
      filterThreadsBySidebarScope(threads, catalog.workspaces, {
        environmentId: "env-a",
        targetId: "target-a2",
        projectName: "Sedes",
        groupId: null,
        ungrouped: false,
      }).map(({ id }) => id),
    ).toEqual(["a2"]);
  });

  it("intersects a persistent group or the ungrouped selection", () => {
    const groupId = catalog.groups[0]!.id;
    const grouped = thread("grouped", "workspace-a", "target-a1", groupId);
    expect(
      filterThreadsBySidebarScope([...threads, grouped], catalog.workspaces, {
        environmentId: "env-a",
        targetId: null,
        projectName: null,
        groupId,
        ungrouped: false,
      }).map(({ id }) => id),
    ).toEqual(["grouped"]);
    expect(
      filterThreadsBySidebarScope([...threads, grouped], catalog.workspaces, {
        environmentId: null,
        targetId: null,
        projectName: null,
        groupId: null,
        ungrouped: true,
      }).map(({ id }) => id),
    ).toEqual(["a1", "a2", "b"]);
  });

  it("suppresses only dimensions already implied by scope or grouping", () => {
    expect(
      deriveSidebarLocationSuppression(
        {
          effectiveEnvironmentId: "env-a",
          targetId: null,
          projectName: null,
        },
        threads.slice(0, 2),
        { projectGrouped: true, environmentCount: 2 },
      ),
    ).toEqual({
      environmentImplied: true,
      projectImplied: true,
      targetImplied: false,
      showEnvironment: false,
      showProject: false,
      showTarget: true,
    });
  });
});
