import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../shared/index.js";
import { describeProjectLocations } from "../app/project-locations.js";
import {
  filterThreadsBySidebarScope,
  type SidebarInventoryScope,
  type SidebarScopeCatalog,
} from "../app/sidebar-scope.js";
import { jsonEqual } from "../archive/archived-threads.js";
import { normalizeThreadSearchQuery } from "../lineage/sidebar-search.js";
import { futureTimeLabel } from "../lib/time.js";
import {
  AUTOMATION_HEALTH_GROUPS,
  AUTOMATION_HEALTH_GROUP_LABELS,
  automationHealth,
  compareAutomationsInGroup,
  type AutomationHealth,
  type AutomationHealthThread,
  type AutomationSortSubject,
  type SummaryAutomation,
  type SummaryAutomationRun,
} from "./automation-health.js";
import {
  automationErrorText,
  describeSchedule,
  lastRunAge,
  runStateLabel,
  runTurnRunning,
} from "./automation-text.js";

/**
 * The Automations page's data pipeline (`/automations`), in two stages like
 * the archive page's:
 *
 * 1. `selectAutomationsBase` turns an application snapshot, and the fork
 *    summaries loaded beyond it, into one row per thread with an
 *    automation, archived anchors included. It runs on every application
 *    event, so it keeps an unchanged row's object and returns an unchanged
 *    base as-is: activity on an anchor that leaves its automation, title and
 *    location alone does not re-render the page. The one piece of thread
 *    activity a row shows is whether its latest run's turn is still going.
 * 2. `projectAutomations` applies the sidebar Scope and the search (title and
 *    prompt preview), computes each automation's health at `now`, and groups
 *    by status or by project.
 *
 * Every automation lands in exactly one group, so the groups double as the
 * page's filter.
 */

export type AutomationsGroupBy = "status" | "project";

export const AUTOMATIONS_GROUPINGS: readonly AutomationsGroupBy[] = [
  "status",
  "project",
];

export interface AutomationListRow
  extends AutomationSortSubject,
    AutomationHealthThread {
  readonly id: string;
  /** The live thread title with the shared untitled fallback. */
  readonly displayTitle: string;
  readonly automation: SummaryAutomation;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly groupId: string | null;
  readonly backendLabel: string;
  /** The location's project: the Scope's project facet and the grouping key. */
  readonly projectId: string | null;
  /** The project and, when it has several folders on one host, the folder. */
  readonly projectLabel: string;
  /** What tells the location apart once the Scope or grouping names the project. */
  readonly locationTag: string | null;
  /** Lower-cased title and prompt preview: what the page's search matches. */
  readonly searchValues: readonly string[];
  /**
   * The latest run was delivered and the thread running it (the anchor, or
   * a fork run's own thread) is still busy with that turn.
   */
  readonly latestRunTurnRunning: boolean;
}

export interface AutomationsBase {
  readonly catalog: SidebarScopeCatalog;
  readonly rows: readonly AutomationListRow[];
}

const EMPTY_CATALOG: SidebarScopeCatalog = {
  environments: [],
  executionTargets: [],
  projects: [],
  workspaces: [],
  groups: [],
};

export const EMPTY_AUTOMATIONS_BASE: AutomationsBase = {
  catalog: EMPTY_CATALOG,
  rows: [],
};

const CATALOG_KEYS = [
  "environments",
  "executionTargets",
  "projects",
  "workspaces",
  "groups",
] as const satisfies readonly (keyof SidebarScopeCatalog)[];

/** The previous catalog when every collection is still equal. */
function shareCatalog(
  previous: SidebarScopeCatalog | undefined,
  snapshot: NormalizedApplicationSnapshot,
): SidebarScopeCatalog {
  if (
    previous &&
    CATALOG_KEYS.every((key) => jsonEqual(previous[key], snapshot[key]))
  ) {
    return previous;
  }
  return {
    environments: snapshot.environments,
    executionTargets: snapshot.executionTargets,
    projects: snapshot.projects,
    workspaces: snapshot.workspaces,
    groups: snapshot.groups,
  };
}

interface CatalogIndex {
  /** Row labels by workspace ID: the project, and the folder where needed. */
  readonly projectLabels: ReadonlyMap<string, string>;
  readonly locationTags: ReadonlyMap<string, string>;
  readonly projectIds: ReadonlyMap<string, string>;
  /** Group headers by project ID, with a single remote host named. */
  readonly projectGroupLabels: ReadonlyMap<string, string>;
  /** Group headers when the Scope already implies the environment. */
  readonly scopedProjectGroupLabels: ReadonlyMap<string, string>;
}

let cachedIndex:
  | { readonly catalog: SidebarScopeCatalog; readonly index: CatalogIndex }
  | undefined;

/** Labels are resolved once per catalog, never once per row. */
function catalogIndexFor(catalog: SidebarScopeCatalog): CatalogIndex {
  if (cachedIndex?.catalog === catalog) return cachedIndex.index;
  const { environments, projects, workspaces } = catalog;
  const locations = describeProjectLocations({
    projects,
    workspaces,
    environments,
  });
  const includeEnvironment = environments.length > 1;
  const projectLabels = new Map<string, string>();
  const locationTags = new Map<string, string>();
  const projectIds = new Map<string, string>();
  for (const workspace of workspaces) {
    projectIds.set(workspace.id, workspace.projectId);
    const label = locations.projectFolderLabel(workspace.id, {
      includeEnvironment,
    });
    if (label !== undefined) projectLabels.set(workspace.id, label);
    const tag = locations.locationTag(workspace.id);
    if (tag !== undefined) locationTags.set(workspace.id, tag);
  }
  const projectGroupLabels = new Map<string, string>();
  const scopedProjectGroupLabels = new Map<string, string>();
  for (const project of projects) {
    projectGroupLabels.set(
      project.id,
      locations.projectHeaderLabel(project.id, { includeEnvironment }) ??
        project.name,
    );
    scopedProjectGroupLabels.set(
      project.id,
      locations.projectHeaderLabel(project.id) ?? project.name,
    );
  }
  const index = {
    projectLabels,
    locationTags,
    projectIds,
    projectGroupLabels,
    scopedProjectGroupLabels,
  };
  cachedIndex = { catalog, index };
  return index;
}

/** The summary fields a row is built from; anything else never re-renders it. */
function rowSource(
  thread: NormalizedApplicationThreadSummary,
  automation: SummaryAutomation,
  resultRunState: NormalizedApplicationThreadSummary["runState"] | undefined,
) {
  return {
    id: thread.id,
    title: thread.title,
    automation,
    inventoryState: thread.inventoryState,
    snoozedUntil: thread.snoozedUntil,
    workspaceId: thread.workspaceId,
    targetId: thread.targetId,
    groupId: thread.groupId,
    backendLabel: thread.backend.label.text,
    latestRunTurnRunning:
      automation.lastRun !== undefined &&
      runTurnRunning(automation.lastRun, resultRunState),
  };
}

function buildRow(
  source: ReturnType<typeof rowSource>,
  index: CatalogIndex,
): AutomationListRow {
  const displayTitle = source.title.text || "Untitled thread";
  return {
    ...source,
    displayTitle,
    projectId: index.projectIds.get(source.workspaceId) ?? null,
    projectLabel: index.projectLabels.get(source.workspaceId) ?? "Project",
    locationTag: index.locationTags.get(source.workspaceId) ?? null,
    searchValues: [
      displayTitle.toLocaleLowerCase(),
      source.automation.promptPreview.toLocaleLowerCase(),
    ],
  };
}

function rowMatchesSource(
  row: AutomationListRow,
  source: ReturnType<typeof rowSource>,
): boolean {
  return (Object.keys(source) as (keyof typeof source)[]).every((key) =>
    jsonEqual(row[key], source[key]),
  );
}

/**
 * Rows for every thread with an automation, reusing each unchanged row and,
 * when nothing the page renders changed, the previous base itself.
 *
 * The threads are the snapshot's, then the loaded forks it does not hold
 * (`loadedDescendantThreads`). The snapshot is a bootstrap that bounds fork
 * summaries, so an automation on a fork outside it that the sidebar has not
 * loaded is missing from the list until a thread update brings the fork in.
 * That is a v1 limitation: an exhaustive list would need a server-side
 * automations endpoint.
 */
export function selectAutomationsBase(
  snapshot: NormalizedApplicationSnapshot | undefined,
  previous?: AutomationsBase,
  loadedForks: readonly NormalizedApplicationThreadSummary[] = [],
): AutomationsBase {
  if (!snapshot) return previous ?? EMPTY_AUTOMATIONS_BASE;
  const catalog = shareCatalog(previous?.catalog, snapshot);
  const catalogUnchanged = previous?.catalog === catalog;
  const index = catalogIndexFor(catalog);
  const previousRows = new Map(previous?.rows.map((row) => [row.id, row]));
  const rows: AutomationListRow[] = [];
  const listed = new Set<string>();
  let changed = previous === undefined;
  const threads = [...snapshot.threads, ...loadedForks];
  // A run's turn runs on its result thread: the anchor, or a fork run's own
  // thread. The snapshot's copy comes first and is the live one.
  const runStates = new Map<string, NormalizedApplicationThreadSummary["runState"]>();
  for (const thread of threads) {
    if (!runStates.has(thread.id)) runStates.set(thread.id, thread.runState);
  }
  for (const thread of threads) {
    if (thread.automation === null || listed.has(thread.id)) continue;
    listed.add(thread.id);
    const resultThreadId = thread.automation.lastRun?.resultThreadId ?? thread.id;
    const source = rowSource(
      thread,
      thread.automation,
      runStates.get(resultThreadId),
    );
    const prior = previousRows.get(thread.id);
    const row =
      prior !== undefined && catalogUnchanged && rowMatchesSource(prior, source)
        ? prior
        : buildRow(source, index);
    if (previous?.rows[rows.length] !== row) changed = true;
    rows.push(row);
  }
  if (previous && previous.rows.length !== rows.length) changed = true;
  if (!changed && catalogUnchanged) return previous!;
  return { catalog, rows };
}

export interface AutomationListEntry {
  readonly row: AutomationListRow;
  readonly health: AutomationHealth;
}

export interface AutomationListGroup {
  /** `status:<group>`, `project:<id>`, or `location:<workspace>` without a project. */
  readonly key: string;
  readonly label: string;
  readonly entries: readonly AutomationListEntry[];
}

export interface AutomationsProjectionOptions {
  readonly scope: Pick<
    SidebarInventoryScope,
    "environmentId" | "targetId" | "projectId" | "groupId" | "ungrouped"
  >;
  readonly search: string;
  readonly groupBy: AutomationsGroupBy;
  /** Wall-clock reference for health (a snooze ends at its wake time). */
  readonly now: number;
}

export interface AutomationsProjection {
  /** Every automation. */
  readonly total: number;
  /** Automations inside the sidebar Scope. */
  readonly scopedCount: number;
  /** Automations inside the Scope that match the search. */
  readonly matchCount: number;
  readonly groups: readonly AutomationListGroup[];
}

/** Suspended automations cannot run; their group starts collapsed. */
export function automationGroupCollapsedByDefault(key: string): boolean {
  return key === "status:suspended";
}

const titleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

const STATUS_ORDER = new Map(
  AUTOMATION_HEALTH_GROUPS.map((group, position) => [group, position]),
);

/** Status order, then the status group's own order. */
function compareEntries(
  left: AutomationListEntry,
  right: AutomationListEntry,
): number {
  if (left.health.group !== right.health.group) {
    return (
      STATUS_ORDER.get(left.health.group)! -
      STATUS_ORDER.get(right.health.group)!
    );
  }
  return compareAutomationsInGroup(left.health.group, left.row, right.row);
}

export function projectAutomations(
  base: AutomationsBase,
  { scope, search, groupBy, now }: AutomationsProjectionOptions,
): AutomationsProjection {
  const scoped = filterThreadsBySidebarScope(
    base.rows,
    base.catalog.workspaces,
    scope,
  );
  const query = normalizeThreadSearchQuery(search);
  const entries = (
    query
      ? scoped.filter((row) =>
          row.searchValues.some((value) => value.includes(query)),
        )
      : scoped
  ).map((row) => ({ row, health: automationHealth(row, now) }));
  entries.sort(compareEntries);
  let groups: AutomationListGroup[];
  if (groupBy === "status") {
    groups = AUTOMATION_HEALTH_GROUPS.flatMap((group) => {
      const members = entries.filter((entry) => entry.health.group === group);
      return members.length === 0
        ? []
        : [
            {
              key: `status:${group}`,
              label: AUTOMATION_HEALTH_GROUP_LABELS[group],
              entries: members,
            },
          ];
    });
  } else {
    const index = catalogIndexFor(base.catalog);
    // A scoped Environment or Target already names the environment.
    const labels =
      scope.environmentId !== null || scope.targetId !== null
        ? index.scopedProjectGroupLabels
        : index.projectGroupLabels;
    const projects = new Map<
      string,
      { label: string; entries: AutomationListEntry[] }
    >();
    for (const entry of entries) {
      const { projectId, workspaceId } = entry.row;
      // A row whose location the catalog lacks keeps a group of its own.
      const key =
        projectId === null ? `location:${workspaceId}` : `project:${projectId}`;
      const group = projects.get(key);
      if (group) group.entries.push(entry);
      else
        projects.set(key, {
          label: labels.get(projectId ?? "") ?? entry.row.projectLabel,
          entries: [entry],
        });
    }
    groups = [...projects]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          titleCollator.compare(left.label, right.label) ||
          (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
      )
      .map(([key, group]) => ({ key, ...group }));
  }
  return {
    total: base.rows.length,
    scopedCount: scoped.length,
    matchCount: entries.length,
    groups,
  };
}

export type AutomationTextTone = "danger" | "warning" | "info";

export interface AutomationRowText {
  readonly text: string;
  readonly tone?: AutomationTextTone;
  /** A delivered last run, or its finished turn; the row marks it with a check. */
  readonly check?: boolean;
  /** The last run's turn is still going; the row marks it with a spinner. */
  readonly running?: boolean;
}

/**
 * The words of one list row. Desktop rows read
 * `title … primary` over `detail · project · backend … secondary`; phone rows
 * read `title … nextRun` over `outcome · detail`.
 */
export interface AutomationRowPresentation {
  /**
   * Trailing line 1: the next run, the problem ("Failed 21h ago", "Outcome
   * unknown"), the run in flight, or the status word ("Paused").
   */
  readonly primary: AutomationRowText;
  /**
   * Trailing line 2: the last outcome ("Finished 23m ago", "Delivered 23m
   * ago"), or for problem and in-flight rows whether scheduling continues
   * ("next 6:30 AM", "Scheduling paused").
   */
  readonly secondary: AutomationRowText | null;
  /** Line 2's lead: the schedule sentence, or a problem row's error text. */
  readonly detail: string;
  /** Phone line 2's lead: the state, or an active row's last outcome. */
  readonly outcome: AutomationRowText | null;
  /** The next run while scheduling is on; the phone row's trailing time. */
  readonly nextRun: string | null;
}

/**
 * The last run's outcome with its age: once its agent turn settled, how the
 * turn ended ("Finished 23m ago" with a check, "Failed 2h ago" in danger,
 * "Interrupted 1h ago"); while its turn is still going, "Running · 4m" with a
 * spinner; before that, the run's state ("Delivered 23m ago" with a check,
 * "Skipped 2h ago"). A failed turn is history only: it never moves the row
 * out of its group.
 */
function lastRunOutcome(
  lastRun: SummaryAutomationRun,
  turnRunning: boolean,
  now: number,
): AutomationRowText {
  if (turnRunning) {
    return {
      text: runStateLabel(lastRun, { running: true, now }),
      tone: "info",
      running: true,
    };
  }
  const text = `${runStateLabel(lastRun)} ${lastRunAge(lastRun, now)}`;
  const outcome = lastRun.turn?.outcome;
  if (outcome === "failed") return { text, check: false, tone: "danger" };
  return {
    text,
    check: outcome === undefined ? lastRun.state === "completed" : outcome === "completed",
  };
}

export function automationRowPresentation(
  { row, health }: AutomationListEntry,
  now: number,
): AutomationRowPresentation {
  const { automation } = row;
  const { lastRun } = automation;
  const nowDate = new Date(now);
  const nextRun =
    automation.status === "enabled" && automation.nextRunAt !== undefined
      ? futureTimeLabel(automation.nextRunAt, nowDate)
      : null;
  const schedule = describeSchedule(automation.schedule, nowDate);
  const scheduling: AutomationRowText = {
    text: nextRun === null ? "Scheduling paused" : `next ${nextRun}`,
  };
  const lastOutcome = lastRun
    ? lastRunOutcome(lastRun, row.latestRunTurnRunning, now)
    : null;
  switch (health.kind) {
    case "failed":
    case "unknown": {
      const problem: AutomationRowText = {
        text:
          health.kind === "failed" && lastRun
            ? `Failed ${lastRunAge(lastRun, now)}`
            : health.label,
        tone: health.kind === "failed" ? "danger" : "warning",
      };
      return {
        primary: problem,
        secondary: scheduling,
        detail: lastRun?.errorCode
          ? automationErrorText(lastRun.errorCode)
          : schedule,
        outcome: problem,
        nextRun,
      };
    }
    case "sending": {
      const state: AutomationRowText = {
        text: lastRun ? runStateLabel(lastRun) : health.label,
        tone: "info",
      };
      return {
        primary: state,
        secondary: scheduling,
        detail: schedule,
        outcome: state,
        nextRun,
      };
    }
    case "active":
      return {
        primary: { text: nextRun ?? health.label },
        secondary: lastOutcome,
        detail: schedule,
        outcome: lastOutcome,
        nextRun,
      };
    case "paused":
    case "not_started":
    case "archived":
    case "snoozed":
      return {
        primary: { text: health.label },
        secondary: lastOutcome,
        detail: schedule,
        // A turn still going outranks the status word on the phone row.
        outcome: lastOutcome?.running ? lastOutcome : { text: health.label },
        nextRun,
      };
  }
}
