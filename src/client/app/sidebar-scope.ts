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
  "environments" | "executionTargets" | "projects" | "workspaces" | "groups"
>;

export interface SidebarInventoryScope {
  /** Repaired explicit selections. Null retains the corresponding All state. */
  readonly environmentId: string | null;
  readonly targetId: string | null;
  readonly projectId: string | null;
  readonly groupId: string | null;
  readonly ungrouped: boolean;
  /** The most-specific selected location, used to constrain dependent options. */
  readonly effectiveEnvironmentId: string | null;
  readonly environmentOptions: NormalizedApplicationSnapshot["environments"];
  readonly targetOptions: NormalizedApplicationSnapshot["executionTargets"];
  /** Projects with a location on the scoped environment, or every project. */
  readonly projectOptions: NormalizedApplicationSnapshot["projects"];
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
 * A lagging tab must not clear a project selection published by a stream
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
  if (next.projectFilterId !== undefined && publication !== null) {
    const local = replayCursor ? applicationCursor(replayCursor) : undefined;
    const causal = applicationCursor(publication.eventId);
    const reached = local
      ? local.generation === causal.generation
        ? local.sequence >= causal.sequence
        : connected
      : false;
    if (!reached) delete next.projectFilterId;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * A project-name filter saved before projects had identity names the project
 * it can only mean: the one project with that name, or the one project every
 * location with that folder name belongs to. Anything else is ambiguous.
 */
export function resolveLegacyProjectFilterName(
  catalog: Pick<SidebarScopeCatalog, "projects" | "workspaces">,
  name: string,
): string | null {
  const matches = new Set(
    catalog.projects
      .filter((project) => project.name === name)
      .map(({ id }) => id),
  );
  const locationProjects = new Set(
    catalog.workspaces
      .filter((workspace) => workspace.label.text === name)
      .map(({ projectId }) => projectId),
  );
  if (locationProjects.size === 1) matches.add([...locationProjects][0]!);
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * Resolve opaque preferences only against complete normalized catalogs. Missing
 * IDs clear when absent from the complete catalog. Targets must fit the
 * selected environment; the project remains independent so an empty
 * intersection never broadens silently to All projects. A legacy project-name
 * hint resolves into the project facet's repair, so it is applied only where
 * the caller applies repairs: against an authoritative snapshot.
 */
export function deriveSidebarInventoryScope(
  catalog: SidebarScopeCatalog,
  preferences: Pick<
    SidebarViewPreferences,
    | "environmentFilterId"
    | "targetFilterId"
    | "projectFilterId"
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
  const projectIds = new Set(catalog.projects.map(({ id }) => id));
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
  const projectId = projectIds.has(preferences.projectFilterId ?? "")
    ? preferences.projectFilterId
    : null;
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
  const scopedProjectIds =
    effectiveEnvironmentId === null
      ? undefined
      : new Set(
          catalog.workspaces
            .filter(
              (workspace) => workspace.environmentId === effectiveEnvironmentId,
            )
            .map((workspace) => workspace.projectId),
        );
  const projectOptions =
    scopedProjectIds === undefined
      ? catalog.projects
      : catalog.projects.filter(({ id }) => scopedProjectIds.has(id));

  const repair: {
    environmentFilterId?: string | null;
    targetFilterId?: string | null;
    projectFilterId?: string | null;
    groupFilterId?: string | null;
    ungroupedFilter?: boolean;
  } = {};
  if (environmentId !== preferences.environmentFilterId) {
    repair.environmentFilterId = environmentId;
  }
  if (targetId !== preferences.targetFilterId) {
    repair.targetFilterId = targetId;
  }
  if (preferences.projectFilterName !== undefined) {
    // Writing the facet retires the hint, even when nothing matched.
    repair.projectFilterId =
      projectId ??
      resolveLegacyProjectFilterName(catalog, preferences.projectFilterName);
  } else if (projectId !== preferences.projectFilterId) {
    repair.projectFilterId = projectId;
  }
  if (groupId !== preferences.groupFilterId) repair.groupFilterId = groupId;
  if (ungrouped !== preferences.ungroupedFilter) {
    repair.ungroupedFilter = ungrouped;
  }

  return {
    environmentId,
    targetId,
    projectId,
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
      Number(projectId !== null) +
      Number(groupId !== null || ungrouped),
  };
}

/**
 * Compute a user-driven cascade transition before persisting it. A changed
 * environment clears incompatible targets atomically. A known project
 * persists across environment and target changes.
 */
export function transitionSidebarInventoryScope(
  catalog: SidebarScopeCatalog,
  current: Pick<
    SidebarViewPreferences,
    | "environmentFilterId"
    | "targetFilterId"
    | "projectFilterId"
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
    projectFilterId:
      "projectFilterId" in patch
        ? (patch.projectFilterId ?? null)
        : current.projectFilterId,
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
    projectFilterId: resolved.projectId,
    groupFilterId: resolved.groupId,
    ungroupedFilter: resolved.ungrouped,
  };
}

/**
 * Exact inventory intersection; availability never hides historical rows.
 * Accepts any row that carries a thread's location identity, so pre-indexed
 * row models (the archive page) share the sidebar's scope rules.
 */
export function filterThreadsBySidebarScope<
  Thread extends Pick<
    NormalizedApplicationThreadSummary,
    "targetId" | "groupId" | "workspaceId"
  >,
>(
  threads: readonly Thread[],
  workspaces: SidebarScopeCatalog["workspaces"],
  scope: Pick<
    SidebarInventoryScope,
    "environmentId" | "targetId" | "projectId" | "groupId" | "ungrouped"
  >,
): readonly Thread[] {
  if (
    scope.environmentId === null &&
    scope.targetId === null &&
    scope.projectId === null &&
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
      scope.projectId !== null &&
      workspaceById.get(thread.workspaceId)?.projectId !== scope.projectId
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
    "effectiveEnvironmentId" | "targetId" | "projectId"
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
  const projectImplied = scope.projectId !== null || options.projectGrouped;
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
