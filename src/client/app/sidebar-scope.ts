import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../shared/index.js";
import type {
  SidebarInventoryScopePatch,
  SidebarViewPreferences,
} from "./sidebar-view-model.js";

/** The complete catalogs needed to resolve viewer-local sidebar scope. */
export type SidebarScopeCatalog = Pick<
  NormalizedApplicationSnapshot,
  "environments" | "executionTargets" | "workspaces" | "groups"
>;

export interface SidebarInventoryScope {
  /** Repaired explicit selections. Null retains the corresponding All state. */
  readonly environmentId: string | null;
  readonly targetId: string | null;
  readonly projectName: string | null;
  readonly groupId: string | null;
  readonly ungrouped: boolean;
  /** The most-specific selected location, used to constrain dependent options. */
  readonly effectiveEnvironmentId: string | null;
  readonly environmentOptions: NormalizedApplicationSnapshot["environments"];
  readonly targetOptions: NormalizedApplicationSnapshot["executionTargets"];
  readonly projectOptions: NormalizedApplicationSnapshot["workspaces"];
  readonly groupOptions: NormalizedApplicationSnapshot["groups"];
  /** One atomic store patch when persisted selections became stale/incompatible. */
  readonly repair: SidebarInventoryScopePatch | null;
  readonly activeFilterCount: number;
}

function applicationCursor(eventId: string): {
  readonly generation: string;
  readonly sequence: number;
} {
  const separator = eventId.lastIndexOf(".");
  return {
    generation: eventId.slice(0, separator),
    sequence: Number(eventId.slice(separator + 1)),
  };
}

/**
 * A lagging tab must not clear a project-name selection published by a stream
 * event it has not applied yet. Other stale scope facets remain repairable.
 */
export function sidebarScopeRepairAtCursor(
  repair: SidebarInventoryScopePatch,
  preferences: Pick<SidebarViewPreferences, "projectFilterPublication">,
  replayCursor: string | undefined,
  connected: boolean,
): SidebarInventoryScopePatch | null {
  const next = { ...repair };
  const publication = preferences.projectFilterPublication;
  if (next.projectFilterName !== undefined && publication !== null) {
    const local = replayCursor ? applicationCursor(replayCursor) : undefined;
    const causal = applicationCursor(publication.eventId);
    const reached = local
      ? local.generation === causal.generation
        ? local.sequence >= causal.sequence
        : connected
      : false;
    if (!reached) delete next.projectFilterName;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Resolve opaque preferences only against complete normalized catalogs. Missing
 * IDs and names clear when absent from the complete catalog. Targets must fit
 * the selected environment; project names remain independent so an empty
 * intersection never broadens silently to All projects.
 */
export function deriveSidebarInventoryScope(
  catalog: SidebarScopeCatalog,
  preferences: Pick<
    SidebarViewPreferences,
    | "environmentFilterId"
    | "targetFilterId"
    | "projectFilterName"
    | "groupFilterId"
    | "ungroupedFilter"
  >,
): SidebarInventoryScope {
  const environmentById = new Map(
    catalog.environments.map((environment) => [environment.id, environment]),
  );
  const targetById = new Map(
    catalog.executionTargets.map((target) => [target.id, target]),
  );
  const groupById = new Map(catalog.groups.map((group) => [group.id, group]));

  const environmentId = environmentById.has(
    preferences.environmentFilterId ?? "",
  )
    ? preferences.environmentFilterId
    : null;
  const requestedTarget = targetById.get(preferences.targetFilterId ?? "");
  const target =
    requestedTarget !== undefined &&
    (environmentId === null || requestedTarget.environmentId === environmentId)
      ? requestedTarget
      : undefined;
  const targetId = target?.id ?? null;
  const effectiveEnvironmentId = environmentId ?? target?.environmentId ?? null;
  const projectName = catalog.workspaces.some(
    (workspace) => workspace.label.text === preferences.projectFilterName,
  ) ? preferences.projectFilterName : null;
  const groupId = groupById.has(preferences.groupFilterId ?? "")
    ? preferences.groupFilterId
    : null;
  const ungrouped = groupId === null && preferences.ungroupedFilter;

  const targetOptions =
    effectiveEnvironmentId === null
      ? catalog.executionTargets
      : catalog.executionTargets.filter(
          (candidate) => candidate.environmentId === effectiveEnvironmentId,
        );
  const projectOptions =
    effectiveEnvironmentId === null
      ? catalog.workspaces
      : catalog.workspaces.filter(
          (candidate) => candidate.environmentId === effectiveEnvironmentId,
        );

  const repair: {
    environmentFilterId?: string | null;
    targetFilterId?: string | null;
    projectFilterName?: string | null;
    groupFilterId?: string | null;
    ungroupedFilter?: boolean;
  } = {};
  if (environmentId !== preferences.environmentFilterId) {
    repair.environmentFilterId = environmentId;
  }
  if (targetId !== preferences.targetFilterId) {
    repair.targetFilterId = targetId;
  }
  if (projectName !== preferences.projectFilterName) {
    repair.projectFilterName = projectName;
  }
  if (groupId !== preferences.groupFilterId) repair.groupFilterId = groupId;
  if (ungrouped !== preferences.ungroupedFilter) {
    repair.ungroupedFilter = ungrouped;
  }

  return {
    environmentId,
    targetId,
    projectName,
    groupId,
    ungrouped,
    effectiveEnvironmentId,
    environmentOptions: catalog.environments,
    targetOptions,
    projectOptions,
    groupOptions: catalog.groups,
    repair: Object.keys(repair).length > 0 ? repair : null,
    activeFilterCount:
      Number(environmentId !== null) +
      Number(targetId !== null) +
      Number(projectName !== null) +
      Number(groupId !== null || ungrouped),
  };
}

/**
 * Compute a user-driven cascade transition before persisting it. A changed
 * environment clears incompatible targets atomically. A known project name
 * persists across location changes; no alternate ID or name is inferred.
 */
export function transitionSidebarInventoryScope(
  catalog: SidebarScopeCatalog,
  current: Pick<
    SidebarViewPreferences,
    | "environmentFilterId"
    | "targetFilterId"
    | "projectFilterName"
    | "groupFilterId"
    | "ungroupedFilter"
  >,
  patch: SidebarInventoryScopePatch,
): SidebarInventoryScopePatch {
  const requested = {
    environmentFilterId:
      "environmentFilterId" in patch
        ? (patch.environmentFilterId ?? null)
        : current.environmentFilterId,
    targetFilterId:
      "targetFilterId" in patch
        ? (patch.targetFilterId ?? null)
        : current.targetFilterId,
    projectFilterName:
      "projectFilterName" in patch
        ? (patch.projectFilterName ?? null)
        : current.projectFilterName,
    groupFilterId:
      "groupFilterId" in patch
        ? (patch.groupFilterId ?? null)
        : current.groupFilterId,
    ungroupedFilter:
      "ungroupedFilter" in patch
        ? (patch.ungroupedFilter ?? false)
        : current.ungroupedFilter,
  };
  const resolved = deriveSidebarInventoryScope(catalog, requested);
  return {
    environmentFilterId: resolved.environmentId,
    targetFilterId: resolved.targetId,
    projectFilterName: resolved.projectName,
    groupFilterId: resolved.groupId,
    ungroupedFilter: resolved.ungrouped,
  };
}

/** Exact inventory intersection; availability never hides historical rows. */
export function filterThreadsBySidebarScope(
  threads: readonly NormalizedApplicationThreadSummary[],
  workspaces: SidebarScopeCatalog["workspaces"],
  scope: Pick<
    SidebarInventoryScope,
    "environmentId" | "targetId" | "projectName" | "groupId" | "ungrouped"
  >,
): readonly NormalizedApplicationThreadSummary[] {
  if (
    scope.environmentId === null &&
    scope.targetId === null &&
    scope.projectName === null &&
    scope.groupId === null &&
    !scope.ungrouped
  ) {
    return threads;
  }
  const workspaceById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  return threads.filter((thread) => {
    if (scope.targetId !== null && thread.targetId !== scope.targetId) {
      return false;
    }
    if (scope.groupId !== null && thread.groupId !== scope.groupId)
      return false;
    if (scope.ungrouped && thread.groupId !== null) return false;
    if (
      scope.projectName !== null &&
      workspaceById.get(thread.workspaceId)?.label.text !== scope.projectName
    ) {
      return false;
    }
    if (scope.environmentId !== null) {
      const workspace = workspaceById.get(thread.workspaceId);
      if (workspace?.environmentId !== scope.environmentId) return false;
    }
    return true;
  });
}

export interface SidebarLocationSuppression {
  readonly environmentImplied: boolean;
  readonly projectImplied: boolean;
  readonly targetImplied: boolean;
  readonly showEnvironment: boolean;
  readonly showProject: boolean;
  readonly showTarget: boolean;
}

/** Shared suppress-when-filtered facts for row/header renderers. */
export function deriveSidebarLocationSuppression(
  scope: Pick<
    SidebarInventoryScope,
    "effectiveEnvironmentId" | "targetId" | "projectName"
  >,
  representedThreads: readonly Pick<
    NormalizedApplicationThreadSummary,
    "targetId"
  >[],
  options: {
    readonly projectGrouped: boolean;
    readonly environmentCount: number;
  },
): SidebarLocationSuppression {
  const representedTargetIds = new Set(
    representedThreads.map((thread) => thread.targetId),
  );
  const environmentImplied = scope.effectiveEnvironmentId !== null;
  const projectImplied = scope.projectName !== null || options.projectGrouped;
  const targetImplied =
    scope.targetId !== null || representedTargetIds.size <= 1;
  return {
    environmentImplied,
    projectImplied,
    targetImplied,
    showEnvironment: options.environmentCount > 1 && !environmentImplied,
    showProject: !projectImplied,
    showTarget: !targetImplied,
  };
}
