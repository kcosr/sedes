import { useCallback, useMemo } from "react";
import {
  deriveSidebarInventoryScope,
  type SidebarInventoryScope,
  type SidebarScopeCatalog,
} from "./sidebar-scope.js";
import { scopeSummaryPresentation } from "./sidebar-scope-presentation.js";
import {
  setSidebarInventoryScope,
  useSidebarViewPreferences,
} from "./sidebar-view-store.js";
import type { SidebarViewPreferences } from "./sidebar-view-model.js";

export interface SidebarInventoryScopeSummary {
  /** Every active facet, for titles and accessible names. */
  readonly fullLabel: string;
  /** The collapsed sidebar summary: at most two location facets, then +N. */
  readonly visibleLabel: string;
}

/**
 * The human summary of an active scope, shared by the sidebar Scope header and
 * the archive page status line. Facet order: environment, target, project,
 * then the group (or Ungrouped). With no facet active the visible label reads
 * "All threads".
 */
export function sidebarScopeSummary(
  catalog: SidebarScopeCatalog,
  scope: Pick<
    SidebarInventoryScope,
    "environmentId" | "targetId" | "projectName" | "groupId" | "ungrouped"
  >,
): SidebarInventoryScopeSummary {
  const environment = catalog.environments.find(
    ({ id }) => id === scope.environmentId,
  );
  const target = catalog.executionTargets.find(
    ({ id }) => id === scope.targetId,
  );
  const group = catalog.groups.find(({ id }) => id === scope.groupId);
  const location = scopeSummaryPresentation({
    environment,
    target,
    projectName: scope.projectName,
    environments: catalog.environments,
    targets: catalog.executionTargets,
    workspaces: catalog.workspaces,
  });
  const groupLabel = scope.ungrouped ? "Ungrouped" : group?.name;
  return {
    fullLabel: [location.fullLabel, groupLabel].filter(Boolean).join(" · "),
    visibleLabel: groupLabel
      ? [location.visibleLabel, groupLabel].filter(Boolean).join(" · ")
      : location.visibleLabel || "All threads",
  };
}

/** Reset every scope facet in one write; search and Show toggles are kept. */
export function clearSidebarInventoryScope(): void {
  setSidebarInventoryScope({
    environmentFilterId: null,
    targetFilterId: null,
    projectFilterName: null,
    groupFilterId: null,
    ungroupedFilter: false,
  });
}

export interface SidebarInventoryScopeView {
  readonly preferences: SidebarViewPreferences;
  readonly scope: SidebarInventoryScope;
  /** True while any scope facet narrows the inventory. */
  readonly active: boolean;
  readonly summary: SidebarInventoryScopeSummary;
  readonly clearScope: () => void;
}

/**
 * The viewer-local sidebar Scope (environment, target, project, group) as it
 * applies to the current catalogs. Shared by every inventory surface so the
 * sidebar and the archive page always narrow by the same selection. Stale
 * persisted selections resolve to All here; the sidebar owns their repair.
 */
export function useSidebarInventoryScope(
  catalog: SidebarScopeCatalog,
): SidebarInventoryScopeView {
  const preferences = useSidebarViewPreferences();
  const { environments, executionTargets, workspaces, groups } = catalog;
  const scope = useMemo(
    () =>
      deriveSidebarInventoryScope(
        { environments, executionTargets, workspaces, groups },
        preferences,
      ),
    [environments, executionTargets, groups, preferences, workspaces],
  );
  const summary = useMemo(
    () =>
      sidebarScopeSummary(
        { environments, executionTargets, workspaces, groups },
        scope,
      ),
    [environments, executionTargets, groups, scope, workspaces],
  );
  const clearScope = useCallback(() => clearSidebarInventoryScope(), []);
  return {
    preferences,
    scope,
    active: scope.activeFilterCount > 0,
    summary,
    clearScope,
  };
}
