import type {
  ProjectLocation,
  ProjectRemovalBlocker,
  ProjectRemovalBlockerKind,
  ProjectSummary,
} from "../../../shared/index.js";

export type ProjectStatusFilter = "all" | "active" | "removed";

export interface ProjectFilters {
  /** An environment ID, or empty for every environment. */
  readonly environmentId: string;
  readonly status: ProjectStatusFilter;
  readonly search: string;
}

export interface VisibleProject {
  readonly project: ProjectSummary;
  /** The project's locations that match the filters. */
  readonly locations: readonly ProjectLocation[];
}

/**
 * Two-level filtering: a location matches the environment, its own status,
 * and the search (its project's name included); a project is shown when any
 * of its locations matches. Without an environment filter a project with no
 * matching location still shows when its own status and name match, so
 * empty projects stay visible under "All".
 */
export function filterProjects(
  projects: readonly ProjectSummary[],
  filters: ProjectFilters,
): VisibleProject[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const includes = (...values: readonly string[]) =>
    !query || values.join(" ").toLocaleLowerCase().includes(query);
  const statusMatches = (removed: boolean) =>
    filters.status === "all" || (filters.status === "removed") === removed;
  return projects.flatMap((project) => {
    const locations = project.locations.filter((location) =>
      (!filters.environmentId || location.environmentId === filters.environmentId)
      && statusMatches(location.removed)
      && includes(project.name, location.label, location.path, location.environmentLabel));
    const shown = locations.length > 0
      || (!filters.environmentId && statusMatches(project.removed) && includes(project.name));
    return shown ? [{ project, locations }] : [];
  });
}

/** Names that more than one active project carries, with those projects. */
export function duplicateProjectNames(
  projects: readonly ProjectSummary[],
): ReadonlyMap<string, readonly ProjectSummary[]> {
  const byName = new Map<string, ProjectSummary[]>();
  for (const project of projects) {
    if (project.removed) continue;
    const named = byName.get(project.name) ?? [];
    named.push(project);
    byName.set(project.name, named);
  }
  return new Map([...byName].filter(([, named]) => named.length > 1));
}

/** What a removal blocker asks of the user, in plain words. */
export const BLOCKER_ACTIONS: Readonly<Record<ProjectRemovalBlockerKind, string>> = {
  durable_work: "Stop running work",
  enabled_schedule: "Pause enabled schedules",
  live_terminal: "End terminals",
  busy_runtime: "Wait for busy agents",
};

export interface BlockerGroup {
  readonly locationId: string;
  readonly blockers: readonly ProjectRemovalBlocker[];
}

/** Blockers grouped by location, in the order the server reported them. */
export function groupBlockersByLocation(
  blockers: readonly ProjectRemovalBlocker[],
): BlockerGroup[] {
  const groups = new Map<string, ProjectRemovalBlocker[]>();
  for (const blocker of blockers) {
    const group = groups.get(blocker.locationId) ?? [];
    group.push(blocker);
    groups.set(blocker.locationId, group);
  }
  return [...groups].map(([locationId, grouped]) => ({ locationId, blockers: grouped }));
}

/** "“Fix login”, “Refactor” and 1 other thread", or "2 threads" when none is known. */
export function describeBlockedThreads(
  threadIds: readonly string[],
  titleFor: (threadId: string) => string | undefined,
): string {
  const titles = threadIds.flatMap((id) => {
    const title = titleFor(id);
    return title ? [`“${title}”`] : [];
  });
  const unknown = threadIds.length - titles.length;
  if (titles.length === 0) return threadCount(unknown);
  return unknown > 0
    ? `${titles.join(", ")} and ${unknown} other ${unknown === 1 ? "thread" : "threads"}`
    : titles.join(", ");
}

function threadCount(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"}`;
}
