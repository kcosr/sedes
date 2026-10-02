import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
  NormalizedThreadForkOrigin,
  NormalizedThreadLineagePlacement,
} from "../../shared/index.js";
import { describeProjectLocations } from "../app/project-locations.js";
import {
  filterThreadsBySidebarScope,
  type SidebarInventoryScope,
  type SidebarScopeCatalog,
} from "../app/sidebar-scope.js";
import { targetDisplayLabel } from "../app/sidebar-scope-presentation.js";
import { resolveTimeBucket } from "../lineage/sidebar-flat-projections.js";
import {
  indexThreadSearchValues,
  normalizeThreadSearchQuery,
  threadSearchValuesMatch,
} from "../lineage/sidebar-search.js";

/**
 * The archive page's data pipeline, in two stages:
 *
 * 1. `selectArchiveBase` turns an application snapshot into display-ready
 *    rows for every archived thread. It runs on every application event, so
 *    it shares structure with its previous result: an unchanged row keeps its
 *    object, and an unchanged base is returned as-is, letting the page skip
 *    rendering entirely for events that do not touch the archive.
 * 2. `projectArchivedThreads` applies the sidebar Scope, the search, the sort,
 *    and the grouping; `pageArchivedThreads` bounds how many rows render.
 *
 * Sidebar Show toggles (snoozed, settled, drafts) and pinned-only never apply:
 * they describe live inventory, and every row here is archived.
 */

export type ArchiveSort = "archived" | "activity" | "title";
export type ArchiveGroupBy = "date" | "project" | "none";

export const ARCHIVE_SORTS: readonly ArchiveSort[] = [
  "archived",
  "activity",
  "title",
];
export const ARCHIVE_GROUPINGS: readonly ArchiveGroupBy[] = [
  "date",
  "project",
  "none",
];
/** Rows rendered per page; "Show more" appends another page. */
export const ARCHIVE_PAGE_SIZE = 100;

export interface ArchivedThreadRow {
  readonly id: string;
  /** The current summary; restore and the context menu need its revisions. */
  readonly thread: NormalizedApplicationThreadSummary;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly groupId: string | null;
  /** Display title with the shared untitled fallback. */
  readonly title: string;
  readonly brand: NormalizedApplicationThreadSummary["backend"]["brand"];
  readonly backendLabel: string;
  /** The location's project: the Scope's project facet and the grouping key. */
  readonly projectId: string | null;
  /**
   * The project and, when it has several folders on one environment, the
   * folder ("sedes › sedes-context"); adds a remote environment when several
   * exist.
   */
  readonly projectLabel: string;
  /**
   * What tells this location apart within a project of several locations,
   * shown when the grouping or the Scope already names the project.
   */
  readonly locationTag: string | null;
  readonly locationAvailable: boolean;
  readonly environmentAvailable: boolean;
  /** The Target's label (qualified only on collision); null when it is the backend's name. */
  readonly targetLabel: string | null;
  readonly targetAvailable: boolean;
  /** The thread's preferred linked worktree, by branch when it has one. */
  readonly worktreeLabel: string | null;
  readonly worktreeAvailable: boolean;
  readonly origin?: NormalizedThreadForkOrigin;
  readonly placement?: NormalizedThreadLineagePlacement;
  readonly forkSourceTitle?: string;
  readonly configurationCopyPending: boolean;
  /** The context menu reads the target's execution kind and project label from the store. */
  readonly targetWorkspaceExecution?: string;
  /** Epoch milliseconds of `stateChangedAt`: when the thread was archived. */
  readonly archivedAt: number;
  readonly lastActiveAt: number;
  /** Lower-cased search texts, matched with the sidebar's rules. */
  readonly searchValues: readonly string[];
}

export interface ArchiveBase {
  readonly catalog: SidebarScopeCatalog;
  readonly rows: readonly ArchivedThreadRow[];
}

const EMPTY_CATALOG: SidebarScopeCatalog = {
  environments: [],
  executionTargets: [],
  projects: [],
  workspaces: [],
  groups: [],
};
export const EMPTY_ARCHIVE_BASE: ArchiveBase = {
  catalog: EMPTY_CATALOG,
  rows: [],
};

/** Structural equality for JSON-shaped protocol values. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  for (const key of keys) {
    const value = leftRecord[key];
    if (!jsonEqual(value, rightRecord[key])) return false;
    // Equal key counts, so a key missing on the right only hides behind undefined.
    if (value === undefined && !Object.hasOwn(rightRecord, key)) return false;
  }
  return true;
}

function shareArray<Values extends readonly unknown[]>(
  previous: Values | undefined,
  next: Values,
): Values {
  return previous !== undefined && jsonEqual(previous, next) ? previous : next;
}

function shareCatalog(
  previous: SidebarScopeCatalog | undefined,
  snapshot: NormalizedApplicationSnapshot,
): SidebarScopeCatalog {
  const environments = shareArray(
    previous?.environments,
    snapshot.environments,
  );
  const executionTargets = shareArray(
    previous?.executionTargets,
    snapshot.executionTargets,
  );
  const projects = shareArray(previous?.projects, snapshot.projects);
  const workspaces = shareArray(previous?.workspaces, snapshot.workspaces);
  const groups = shareArray(previous?.groups, snapshot.groups);
  if (
    previous &&
    environments === previous.environments &&
    executionTargets === previous.executionTargets &&
    projects === previous.projects &&
    workspaces === previous.workspaces &&
    groups === previous.groups
  ) {
    return previous;
  }
  return { environments, executionTargets, projects, workspaces, groups };
}

const ROW_SCALAR_FIELDS = [
  "title",
  "brand",
  "backendLabel",
  "projectId",
  "projectLabel",
  "locationTag",
  "locationAvailable",
  "environmentAvailable",
  "targetLabel",
  "targetAvailable",
  "worktreeLabel",
  "worktreeAvailable",
  "forkSourceTitle",
  "configurationCopyPending",
  "targetWorkspaceExecution",
] as const satisfies readonly (keyof ArchivedThreadRow)[];

/** Whether two rows render identically (and carry equal protocol values). */
export function archivedRowsEqual(
  left: ArchivedThreadRow,
  right: ArchivedThreadRow,
): boolean {
  if (left === right) return true;
  if (left.id !== right.id) return false;
  for (const field of ROW_SCALAR_FIELDS) {
    if (left[field] !== right[field]) return false;
  }
  return (
    jsonEqual(left.searchValues, right.searchValues) &&
    jsonEqual(left.origin, right.origin) &&
    jsonEqual(left.placement, right.placement) &&
    jsonEqual(left.thread, right.thread)
  );
}

interface CatalogIndex {
  readonly projects: ReadonlyMap<
    string,
    NormalizedApplicationSnapshot["projects"][number]
  >;
  readonly workspaces: ReadonlyMap<
    string,
    NormalizedApplicationSnapshot["workspaces"][number]
  >;
  readonly environments: ReadonlyMap<
    string,
    NormalizedApplicationSnapshot["environments"][number]
  >;
  readonly targets: ReadonlyMap<
    string,
    NormalizedApplicationSnapshot["executionTargets"][number]
  >;
  /** Row labels by workspace ID: the project, and the folder where needed. */
  readonly projectLabels: ReadonlyMap<string, string>;
  readonly locationTags: ReadonlyMap<string, string>;
  /** Group headers by project ID, qualified among same-named projects. */
  readonly projectGroupLabels: ReadonlyMap<string, string>;
  readonly targetLabels: ReadonlyMap<string, string>;
}

/** Labels are resolved once per catalog, never once per row. */
function indexCatalog(catalog: SidebarScopeCatalog): CatalogIndex {
  const { environments, executionTargets, projects, workspaces } = catalog;
  const environmentById = new Map(
    environments.map((environment) => [environment.id, environment]),
  );
  const locations = describeProjectLocations({
    projects,
    workspaces,
    environments,
  });
  const projectLabels = new Map<string, string>();
  const locationTags = new Map<string, string>();
  for (const workspace of workspaces) {
    const label = locations.projectFolderLabel(workspace.id, {
      includeEnvironment: environments.length > 1,
    });
    if (label !== undefined) projectLabels.set(workspace.id, label);
    const tag = locations.locationTag(workspace.id);
    if (tag !== undefined) locationTags.set(workspace.id, tag);
  }
  const projectGroupLabels = new Map<string, string>();
  for (const project of projects) {
    projectGroupLabels.set(
      project.id,
      locations.projectLabel(project.id) ?? project.name,
    );
  }
  // The brand mark already names the backend, so a Target shows its own
  // label; only colliding labels take the qualified display label.
  const labelCounts = new Map<string, number>();
  for (const target of executionTargets) {
    labelCounts.set(
      target.label.text,
      (labelCounts.get(target.label.text) ?? 0) + 1,
    );
  }
  const targetLabels = new Map<string, string>();
  for (const target of executionTargets) {
    targetLabels.set(
      target.id,
      labelCounts.get(target.label.text) === 1
        ? target.label.text
        : targetDisplayLabel({
            target,
            targets: executionTargets,
            environments,
            includeEnvironment: false,
          }),
    );
  }
  return {
    projects: new Map(projects.map((project) => [project.id, project])),
    workspaces: new Map(
      workspaces.map((workspace) => [workspace.id, workspace]),
    ),
    environments: environmentById,
    targets: new Map(executionTargets.map((target) => [target.id, target])),
    projectLabels,
    locationTags,
    projectGroupLabels,
    targetLabels,
  };
}

function epoch(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

let cachedIndex:
  | { readonly catalog: SidebarScopeCatalog; readonly index: CatalogIndex }
  | undefined;

function catalogIndexFor(catalog: SidebarScopeCatalog): CatalogIndex {
  if (cachedIndex?.catalog !== catalog) {
    cachedIndex = { catalog, index: indexCatalog(catalog) };
  }
  return cachedIndex.index;
}

/** The inputs each base was last built or confirmed from. */
const baseInputs = new WeakMap<
  ArchiveBase,
  {
    readonly snapshot: NormalizedApplicationSnapshot;
    readonly pending: readonly string[];
  }
>();

/**
 * Build the archive base from a snapshot, reusing every unchanged row and,
 * when nothing the page renders changed, the previous base itself. The same
 * inputs return the previous base without any work.
 */
export function selectArchiveBase(
  snapshot: NormalizedApplicationSnapshot | undefined,
  pendingConfigurationCopySourceIds: readonly string[],
  previous?: ArchiveBase,
): ArchiveBase {
  if (!snapshot) {
    return previous?.rows.length === 0 ? previous : EMPTY_ARCHIVE_BASE;
  }
  const inputs = previous ? baseInputs.get(previous) : undefined;
  if (
    inputs?.snapshot === snapshot &&
    inputs.pending === pendingConfigurationCopySourceIds
  ) {
    return previous!;
  }
  const next = buildArchiveBase(
    snapshot,
    pendingConfigurationCopySourceIds,
    previous,
  );
  baseInputs.set(next, {
    snapshot,
    pending: pendingConfigurationCopySourceIds,
  });
  return next;
}

function buildArchiveBase(
  snapshot: NormalizedApplicationSnapshot,
  pendingConfigurationCopySourceIds: readonly string[],
  previous: ArchiveBase | undefined,
): ArchiveBase {
  const catalog = shareCatalog(previous?.catalog, snapshot);
  const catalogUnchanged = previous?.catalog === catalog;
  const index = catalogIndexFor(catalog);
  const previousRows = new Map(previous?.rows.map((row) => [row.id, row]));
  const pendingCopies = new Set(pendingConfigurationCopySourceIds);
  // Lineage indexes are built lazily: most snapshots have few archived forks.
  let origins: Map<string, NormalizedThreadForkOrigin> | undefined;
  let placements: Map<string, NormalizedThreadLineagePlacement> | undefined;
  let titles: Map<string, string> | undefined;
  const rows: ArchivedThreadRow[] = [];
  let changed = previous === undefined;
  for (const thread of snapshot.threads) {
    if (thread.inventoryState !== "archived") continue;
    origins ??= new Map(
      snapshot.forkOrigins.map((origin) => [origin.childThreadId, origin]),
    );
    placements ??= new Map(
      snapshot.lineagePlacements.map((placement) => [
        placement.childThreadId,
        placement,
      ]),
    );
    const origin = origins.get(thread.id);
    const placement = placements.get(thread.id);
    let forkSourceTitle: string | undefined;
    if (origin?.sourceThreadId) {
      titles ??= new Map(
        snapshot.threads.map(({ id, title }) => [id, title.text]),
      );
      forkSourceTitle = titles.get(origin.sourceThreadId);
    }
    const configurationCopyPending = pendingCopies.has(thread.id);
    const prior = previousRows.get(thread.id);
    // Fast path: catalog-derived labels cannot have changed, so an equal
    // summary with equal lineage keeps the previous row without rebuilding.
    const reused =
      prior !== undefined &&
      catalogUnchanged &&
      prior.forkSourceTitle === forkSourceTitle &&
      prior.configurationCopyPending === configurationCopyPending &&
      jsonEqual(prior.origin, origin) &&
      jsonEqual(prior.placement, placement) &&
      jsonEqual(prior.thread, thread)
        ? prior
        : undefined;
    if (reused) {
      if (previous!.rows[rows.length] !== reused) changed = true;
      rows.push(reused);
      continue;
    }
    const row = buildArchivedRow(thread, index, {
      origin,
      placement,
      forkSourceTitle,
      configurationCopyPending,
    });
    if (prior && archivedRowsEqual(prior, row)) {
      if (previous!.rows[rows.length] !== prior) changed = true;
      rows.push(prior);
    } else {
      rows.push(row);
      changed = true;
    }
  }
  if (previous && previous.rows.length !== rows.length) changed = true;
  if (!changed && catalogUnchanged) return previous!;
  return { catalog, rows: changed ? rows : previous!.rows };
}

function buildArchivedRow(
  thread: NormalizedApplicationThreadSummary,
  index: CatalogIndex,
  lineage: Pick<
    ArchivedThreadRow,
    "origin" | "placement" | "forkSourceTitle" | "configurationCopyPending"
  >,
): ArchivedThreadRow {
  const workspace = index.workspaces.get(thread.workspaceId);
  const project = workspace
    ? index.projects.get(workspace.projectId)
    : undefined;
  const environment = workspace
    ? index.environments.get(workspace.environmentId)
    : undefined;
  const target = index.targets.get(thread.targetId);
  const targetLabel = target
    ? (index.targetLabels.get(target.id) ?? target.label.text)
    : null;
  const worktree = thread.preferredWorktree;
  return {
    id: thread.id,
    thread,
    workspaceId: thread.workspaceId,
    targetId: thread.targetId,
    groupId: thread.groupId,
    title: thread.title.text || "Untitled thread",
    brand: thread.backend.brand,
    backendLabel: thread.backend.label.text,
    projectId: workspace?.projectId ?? null,
    projectLabel: index.projectLabels.get(thread.workspaceId) ?? "Project",
    locationTag: index.locationTags.get(thread.workspaceId) ?? null,
    locationAvailable: workspace?.available !== false,
    environmentAvailable: environment?.available !== false,
    targetLabel:
      targetLabel === null || targetLabel === thread.backend.label.text
        ? null
        : targetLabel,
    targetAvailable: target?.available !== false,
    worktreeLabel: worktree ? (worktree.branch ?? worktree.displayLabel) : null,
    worktreeAvailable: worktree?.availability !== "unavailable",
    ...lineage,
    targetWorkspaceExecution: target?.workspaceExecution.kind,
    archivedAt: epoch(thread.stateChangedAt),
    lastActiveAt: epoch(thread.lastActivityAt),
    searchValues: indexThreadSearchValues(thread, {
      project,
      workspace,
      environment,
      target,
    }),
  };
}

export interface ArchiveProjectionOptions {
  readonly scope: Pick<
    SidebarInventoryScope,
    "environmentId" | "targetId" | "projectId" | "groupId" | "ungrouped"
  >;
  readonly search: string;
  readonly sort: ArchiveSort;
  readonly groupBy: ArchiveGroupBy;
  /** Wall-clock reference for date buckets. */
  readonly now: number;
}

export interface ArchiveGroup {
  readonly key: string;
  /** Null when the list is not grouped. */
  readonly label: string | null;
  readonly rows: readonly ArchivedThreadRow[];
}

export interface ArchiveProjection {
  /** Every archived thread. */
  readonly total: number;
  /** Archived threads inside the sidebar Scope. */
  readonly scopedCount: number;
  /** Archived threads inside the Scope that match the search. */
  readonly matchCount: number;
  readonly groupBy: ArchiveGroupBy;
  readonly groups: readonly ArchiveGroup[];
}

/** Title order has no meaningful date grouping; project grouping still applies. */
export function effectiveArchiveGroupBy(
  sort: ArchiveSort,
  groupBy: ArchiveGroupBy,
): ArchiveGroupBy {
  return sort === "title" && groupBy === "date" ? "none" : groupBy;
}

/** The timestamp a row sorts, buckets, and shows its age by. */
export function archiveRowTimestamp(
  row: ArchivedThreadRow,
  sort: ArchiveSort,
): number {
  return sort === "activity" ? row.lastActiveAt : row.archivedAt;
}

const titleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function compareIds(left: ArchivedThreadRow, right: ArchivedThreadRow): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function rowComparator(
  sort: ArchiveSort,
): (left: ArchivedThreadRow, right: ArchivedThreadRow) => number {
  if (sort === "title") {
    return (left, right) =>
      titleCollator.compare(left.title, right.title) ||
      right.archivedAt - left.archivedAt ||
      compareIds(left, right);
  }
  const field = sort === "activity" ? "lastActiveAt" : "archivedAt";
  return (left, right) => right[field] - left[field] || compareIds(left, right);
}

export function projectArchivedThreads(
  base: ArchiveBase,
  { scope, search, sort, groupBy, now }: ArchiveProjectionOptions,
): ArchiveProjection {
  const scoped = filterThreadsBySidebarScope(
    base.rows,
    base.catalog.workspaces,
    scope,
  );
  const query = normalizeThreadSearchQuery(search);
  const matching = query
    ? scoped.filter((row) => threadSearchValuesMatch(row.searchValues, query))
    : [...scoped];
  matching.sort(rowComparator(sort));
  const effective = effectiveArchiveGroupBy(sort, groupBy);
  let groups: ArchiveGroup[];
  if (effective === "none") {
    groups =
      matching.length > 0 ? [{ key: "all", label: null, rows: matching }] : [];
  } else if (effective === "date") {
    const buckets = new Map<
      string,
      { order: number; label: string; rows: ArchivedThreadRow[] }
    >();
    for (const row of matching) {
      const bucket = resolveTimeBucket(archiveRowTimestamp(row, sort), now);
      const entry = buckets.get(bucket.key);
      if (entry) entry.rows.push(row);
      else
        buckets.set(bucket.key, {
          order: bucket.order,
          label: bucket.label,
          rows: [row],
        });
    }
    groups = [...buckets]
      .sort(([, left], [, right]) => left.order - right.order)
      .map(([key, { label, rows }]) => ({ key: `date:${key}`, label, rows }));
  } else {
    const groupLabels = catalogIndexFor(base.catalog).projectGroupLabels;
    const projects = new Map<
      string,
      { label: string; rows: ArchivedThreadRow[] }
    >();
    for (const row of matching) {
      // A row whose location the catalog lacks keeps a group of its own.
      const key =
        row.projectId === null
          ? `location:${row.workspaceId}`
          : `project:${row.projectId}`;
      const entry = projects.get(key);
      if (entry) entry.rows.push(row);
      else
        projects.set(key, {
          label: groupLabels.get(row.projectId ?? "") ?? row.projectLabel,
          rows: [row],
        });
    }
    groups = [...projects]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          titleCollator.compare(left.label, right.label) ||
          (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
      )
      .map(([key, { label, rows }]) => ({ key, label, rows }));
  }
  return {
    total: base.rows.length,
    scopedCount: scoped.length,
    matchCount: matching.length,
    groupBy: effective,
    groups,
  };
}

export interface ArchivePageGroup {
  readonly key: string;
  readonly label: string | null;
  /** The group's full size, including rows beyond the current page. */
  readonly count: number;
  readonly rows: readonly ArchivedThreadRow[];
}

export interface ArchivePage {
  readonly groups: readonly ArchivePageGroup[];
  /** Rendered rows, in list order. */
  readonly rows: readonly ArchivedThreadRow[];
  readonly remaining: number;
}

/** The first `limit` rows of a projection, keeping group headers and counts. */
export function pageArchivedThreads(
  projection: ArchiveProjection,
  limit: number,
): ArchivePage {
  const groups: ArchivePageGroup[] = [];
  const rows: ArchivedThreadRow[] = [];
  for (const group of projection.groups) {
    const room = limit - rows.length;
    if (room <= 0) break;
    const visible =
      group.rows.length <= room ? group.rows : group.rows.slice(0, room);
    rows.push(...visible);
    groups.push({
      key: group.key,
      label: group.label,
      count: group.rows.length,
      rows: visible,
    });
  }
  return {
    groups,
    rows,
    remaining: projection.matchCount - rows.length,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const monthDayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const monthYearFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * Compact age: "now", "5m", "2h", "3d" within 30 days, then a short date
 * ("Aug 12", or "Aug 2025" in an earlier year).
 */
export function archiveAgeLabel(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  const date = new Date(timestamp);
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDayFormat.format(date)
    : monthYearFormat.format(date);
}

const timesTitles = new WeakMap<ArchivedThreadRow, string>();

/** Tooltip for a row's age: both lifecycle moments, absolute. */
export function archiveTimesTitle(row: ArchivedThreadRow): string {
  let title = timesTitles.get(row);
  if (title === undefined) {
    title = `Archived ${dateTimeFormat.format(row.archivedAt)} · Last active ${dateFormat.format(row.lastActiveAt)}`;
    timesTitles.set(row, title);
  }
  return title;
}
