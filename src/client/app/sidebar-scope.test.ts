import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import {
  deriveSidebarInventoryScope,
  deriveSidebarLocationSuppression,
  filterThreadsBySidebarScope,
  resolveLegacyProjectFilterName,
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
  projects: [
    { id: "project-1", name: "Sedes", revision: 0 },
    { id: "project-2", name: "Notes", revision: 0 },
  ],
  workspaces: [
    {
      id: "workspace-a",
      environmentId: "env-a",
      projectId: "project-1",
      label: { text: "Sedes" },
      displayPath: { text: "/work/sedes" },
      available: true,
    },
    {
      id: "workspace-b",
      environmentId: "env-b",
      projectId: "project-1",
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
      projectId: "project-new",
      eventId: `${applicationGeneration}.5`,
    },
  };

  it("preserves a project selected by an application event this tab has not reached", () => {
    expect(
      sidebarScopeRepairAtCursor(
        { environmentFilterId: null, projectFilterId: null },
        preferences,
        `${applicationGeneration}.4`,
        true,
      ),
    ).toEqual({ environmentFilterId: null });
  });

  it("repairs a project once the causal application event has been reached", () => {
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterId: null },
        preferences,
        `${applicationGeneration}.5`,
        true,
      ),
    ).toEqual({ projectFilterId: null });
  });

  it("requires a connected replacement before trusting a different generation", () => {
    const nextGeneration = "00000000-0000-4000-8000-000000000002";
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterId: null },
        preferences,
        `${nextGeneration}.0`,
        false,
      ),
    ).toBeNull();
    expect(
      sidebarScopeRepairAtCursor(
        { projectFilterId: null },
        preferences,
        `${nextGeneration}.0`,
        true,
      ),
    ).toEqual({ projectFilterId: null });
  });
});

function preferences(
  overrides: Partial<{
    environmentFilterId: string | null;
    targetFilterId: string | null;
    projectFilterId: string | null;
    projectFilterName: string;
    groupFilterId: string | null;
    ungroupedFilter: boolean;
  }> = {},
) {
  return {
    environmentFilterId: null,
    targetFilterId: null,
    projectFilterId: null,
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
      projectId: null,
      effectiveEnvironmentId: "env-b",
      repair: null,
      activeFilterCount: 1,
    });
    expect(scope.targetOptions.map(({ id }) => id)).toEqual(["target-b"]);
    expect(scope.projectOptions.map(({ id }) => id)).toEqual(["project-1"]);
  });

  it("offers every active project, including empty ones, without a location in scope", () => {
    const scope = deriveSidebarInventoryScope(catalog, preferences());
    expect(scope.projectOptions.map(({ id }) => id)).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  it("repairs stale IDs and incompatible descendants without substitution", () => {
    const stale = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "env-a",
        targetFilterId: "target-b",
        projectFilterId: "project-1",
      }),
    );
    expect(stale).toMatchObject({
      environmentId: "env-a",
      targetId: null,
      projectId: "project-1",
      repair: {
        targetFilterId: null,
      },
    });

    const missing = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "gone",
        targetFilterId: "target-gone",
        projectFilterId: "project-gone",
      }),
    );
    expect(missing.repair).toEqual({
      environmentFilterId: null,
      targetFilterId: null,
      projectFilterId: null,
    });
  });

  it("retains unavailable catalog identities for historical filtering", () => {
    const scope = deriveSidebarInventoryScope(
      catalog,
      preferences({
        environmentFilterId: "env-b",
        targetFilterId: "target-b",
        projectFilterId: "project-1",
      }),
    );
    expect(scope.repair).toBeNull();
    expect(scope.activeFilterCount).toBe(3);
  });
});

describe("legacy project-name filters", () => {
  const legacyCatalog: SidebarScopeCatalog = {
    ...catalog,
    projects: [
      ...catalog.projects,
      { id: "project-3", name: "Renamed", revision: 1 },
      { id: "project-4", name: "Twin", revision: 0 },
      { id: "project-5", name: "Twin", revision: 0 },
    ],
    workspaces: [
      ...catalog.workspaces,
      { ...catalog.workspaces[0]!, id: "renamed-folder", projectId: "project-3", label: { text: "old-name" } },
      { ...catalog.workspaces[0]!, id: "split-a", projectId: "project-4", label: { text: "split" } },
      { ...catalog.workspaces[0]!, id: "split-b", projectId: "project-5", label: { text: "split" } },
    ],
  };

  it("maps a name that exactly one project carries", () => {
    expect(resolveLegacyProjectFilterName(legacyCatalog, "Sedes")).toBe("project-1");
  });

  it("maps a folder name whose locations all belong to one project", () => {
    expect(resolveLegacyProjectFilterName(legacyCatalog, "old-name")).toBe("project-3");
  });

  it("clears an ambiguous name", () => {
    expect(resolveLegacyProjectFilterName(legacyCatalog, "Twin")).toBeNull();
    expect(resolveLegacyProjectFilterName(legacyCatalog, "split")).toBeNull();
  });

  it("clears a name nothing matches", () => {
    expect(resolveLegacyProjectFilterName(legacyCatalog, "Gone")).toBeNull();
  });

  it("clears a name that a project and another project's folders both claim", () => {
    const contested = {
      ...legacyCatalog,
      workspaces: [
        ...legacyCatalog.workspaces,
        { ...catalog.workspaces[0]!, id: "notes-folder", projectId: "project-3", label: { text: "Notes" } },
      ],
    };
    expect(resolveLegacyProjectFilterName(contested, "Notes")).toBeNull();
  });

  it("resolves the hint only as a repair, which retires it either way", () => {
    const matched = deriveSidebarInventoryScope(
      legacyCatalog,
      preferences({ projectFilterName: "Renamed" }),
    );
    // The hint filters nothing until the repair is applied.
    expect(matched.projectId).toBeNull();
    expect(matched.activeFilterCount).toBe(0);
    expect(matched.repair).toEqual({ projectFilterId: "project-3" });

    const unmatched = deriveSidebarInventoryScope(
      legacyCatalog,
      preferences({ projectFilterName: "Twin" }),
    );
    expect(unmatched.repair).toEqual({ projectFilterId: null });

    const superseded = deriveSidebarInventoryScope(
      legacyCatalog,
      preferences({ projectFilterId: "project-2", projectFilterName: "Sedes" }),
    );
    expect(superseded.projectId).toBe("project-2");
    expect(superseded.repair).toEqual({ projectFilterId: "project-2" });
  });
});

describe("project scope", () => {
  it("matches every location of the project without implying a location", () => {
    const scope = deriveSidebarInventoryScope(catalog, preferences({ projectFilterId: "project-1" }));
    expect(scope.projectId).toBe("project-1");
    expect(scope.effectiveEnvironmentId).toBeNull();
    expect(scope.targetOptions).toEqual(catalog.executionTargets);
    expect(filterThreadsBySidebarScope([
      thread("local", "workspace-a", "target-a1"),
      thread("offline", "workspace-b", "target-b"),
    ], catalog.workspaces, scope).map(({ id }) => id)).toEqual(["local", "offline"]);
    expect(deriveSidebarLocationSuppression(scope, [], { projectGrouped: false, environmentCount: 2 }))
      .toMatchObject({ showEnvironment: true, showProject: false });
  });

  it("preserves a project across explicit environment changes without broadening results", () => {
    const splitCatalog = { ...catalog, workspaces: catalog.workspaces.map((workspace) =>
      workspace.id === "workspace-b" ? { ...workspace, projectId: "project-2" } : workspace) };
    const next = transitionSidebarInventoryScope(splitCatalog,
      preferences({ projectFilterId: "project-2" }), { environmentFilterId: "env-a" });
    expect(next.projectFilterId).toBe("project-2");
    const scope = deriveSidebarInventoryScope(splitCatalog, preferences(next));
    expect(scope.repair).toBeNull();
    expect(scope.projectOptions.map(({ id }) => id)).toEqual(["project-1"]);
    expect(filterThreadsBySidebarScope([
      thread("local", "workspace-a", "target-a1"), thread("remote", "workspace-b", "target-b"),
    ], splitCatalog.workspaces, scope)).toEqual([]);
  });

  it("filters by project identity, never by a shared folder name", () => {
    const namedCatalog = { ...catalog, workspaces: [
      ...catalog.workspaces,
      { ...catalog.workspaces[0]!, id: "same-name-other-project", projectId: "project-2" },
      { ...catalog.workspaces[0]!, id: "other-folder", label: { text: "Sedes-worktree" } },
    ] };
    const scope = deriveSidebarInventoryScope(namedCatalog, preferences({ projectFilterId: "project-1" }));
    expect(filterThreadsBySidebarScope(namedCatalog.workspaces.map((workspace) =>
      thread(workspace.id, workspace.id, "target-a1")), namedCatalog.workspaces, scope)
      .map(({ id }) => id)).toEqual(["workspace-a", "workspace-b", "other-folder"]);
  });
});

describe("transitionSidebarInventoryScope", () => {
  it("clears incompatible target and preserves the project name across environments", () => {
    expect(
      transitionSidebarInventoryScope(
        catalog,
        preferences({
          targetFilterId: "target-b",
          projectFilterId: "project-1",
        }),
        { environmentFilterId: "env-a" },
      ),
    ).toEqual({
      environmentFilterId: "env-a",
      targetFilterId: null,
      projectFilterId: "project-1",
      groupFilterId: null,
      ungroupedFilter: false,
    });
  });

  it("keeps an independent compatible project when Target changes", () => {
    expect(
      transitionSidebarInventoryScope(
        catalog,
        preferences({ projectFilterId: "project-1" }),
        { targetFilterId: "target-a2" },
      ),
    ).toEqual({
      environmentFilterId: null,
      targetFilterId: "target-a2",
      projectFilterId: "project-1",
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

  it("intersects exact Environment, Target, and Project IDs", () => {
    expect(
      filterThreadsBySidebarScope(threads, catalog.workspaces, {
        environmentId: "env-a",
        targetId: "target-a2",
        projectId: "project-1",
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
        projectId: null,
        groupId,
        ungrouped: false,
      }).map(({ id }) => id),
    ).toEqual(["grouped"]);
    expect(
      filterThreadsBySidebarScope([...threads, grouped], catalog.workspaces, {
        environmentId: null,
        targetId: null,
        projectId: null,
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
          projectId: null,
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
