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

/** A location with the project that holds it. */
export interface PlacedLocation {
  readonly project: ProjectSummary;
  readonly location: ProjectLocation;
}

/** Finds a location in whichever project holds it now. */
export function placeLocation(
  projects: readonly ProjectSummary[],
  locationId: string,
): PlacedLocation | undefined {
  for (const project of projects) {
    const location = project.locations.find(({ id }) => id === locationId);
    if (location) return { project, location };
  }
  return undefined;
}

/** Whether removing the location leaves its active project without an active one. */
export function isLastActiveLocation({ project, location }: PlacedLocation): boolean {
  return !project.removed
    && project.locations.every(({ id, removed }) => id === location.id || removed);
}

/** What changed in a project that its dialogs describe, as sentences. */
export function describeProjectChanges(
  before: ProjectSummary,
  after: ProjectSummary,
): string[] {
  const changes: string[] = [];
  if (after.name !== before.name) changes.push(`It was renamed “${after.name}”.`);
  if (after.removed !== before.removed) changes.push(after.removed ? "It was removed." : "It was restored.");
  const active = activeLocations(after);
  if (
    locationIds(after.locations) !== locationIds(before.locations)
    || locationIds(active) !== locationIds(activeLocations(before))
  ) {
    const removed = after.locations.length - active.length;
    changes.push(`It now has ${counted(active.length, "active location")}${
      removed > 0 ? ` and ${counted(removed, "removed location")}` : ""}.`);
  }
  const threads = activeThreadCount(after);
  if (threads !== activeThreadCount(before)) {
    changes.push(`Its active locations now have ${counted(threads, "thread")}.`);
  }
  return changes;
}

/** What changed about a location that its dialogs describe, as sentences. */
export function describeLocationChanges(
  before: PlacedLocation,
  after: PlacedLocation,
): string[] {
  const changes: string[] = [];
  if (after.project.id !== before.project.id) {
    changes.push(`It moved to project “${after.project.name}”.`);
  } else if (after.project.name !== before.project.name) {
    changes.push(`Its project was renamed “${after.project.name}”.`);
  }
  if (after.location.removed !== before.location.removed) {
    changes.push(after.location.removed ? "It was removed." : "It was restored.");
  }
  if (after.location.threadCount !== before.location.threadCount) {
    changes.push(`It now has ${counted(after.location.threadCount, "thread")}.`);
  }
  return changes;
}

/**
 * The removed locations to restore once a project reloads: choices made for
 * locations that are still removed stay, and newly removed ones follow the
 * default.
 */
export function reselectRemovedLocations(
  selected: ReadonlySet<string>,
  before: ProjectSummary,
  after: ProjectSummary,
  preselect: (location: ProjectLocation) => boolean,
): Set<string> {
  const listed = new Set(before.locations.filter(({ removed }) => removed).map(({ id }) => id));
  return new Set(after.locations
    .filter((location) => location.removed
      && (listed.has(location.id) ? selected.has(location.id) : preselect(location)))
    .map(({ id }) => id));
}

function activeLocations(project: ProjectSummary): ProjectLocation[] {
  return project.locations.filter(({ removed }) => !removed);
}

function activeThreadCount(project: ProjectSummary): number {
  return activeLocations(project).reduce((total, { threadCount }) => total + threadCount, 0);
}

function locationIds(locations: readonly ProjectLocation[]): string {
  return locations.map(({ id }) => id).sort().join("\n");
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
  if (titles.length === 0) return counted(unknown, "thread");
  return unknown > 0
    ? `${titles.join(", ")} and ${unknown} other ${unknown === 1 ? "thread" : "threads"}`
    : titles.join(", ");
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
