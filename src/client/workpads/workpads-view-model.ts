import type {
  ListWorkpadsRequest,
  WorkpadCounts,
  WorkpadSummary,
} from "../../shared/protocol/workpads.js";
import type { WorkpadsView, WorkpadsViewOptions } from "../app/workpads-panel-store.js";
import type { TaskGroupKind } from "../components/tasks/task-view-model.js";

/**
 * Pure presentation logic for the Workpads panel: what each view asks the
 * server for, which counts its segments show, and how All's server-ordered
 * pages read as Tasks-style groups. Workpads are server-paged, so unlike
 * Tasks the filtering, ordering and counting happen on the server.
 */

/** The thread and project the panel's views show. */
export interface WorkpadsTarget {
  /** Absent when the Thread view does not apply. */
  readonly threadId?: string;
  /** Absent when the Project view does not apply. */
  readonly projectId?: string;
}

/** A view's list request, without the search, page size or cursor. */
export type WorkpadListQuery = Omit<ListWorkpadsRequest, "query" | "limit" | "cursor">;

/**
 * The active list of a view: Thread and Global their exact scope, Project
 * its own (and its threads' with Include thread workpads), and All every
 * workpad, grouped by project with the current one leading unless Group by
 * project is off. Undefined when the view has nothing to follow.
 */
export function workpadListRequest(
  view: WorkpadsView,
  target: WorkpadsTarget,
  options: WorkpadsViewOptions,
): WorkpadListQuery | undefined {
  const { sort } = options;
  switch (view) {
    case "thread":
      return target.threadId
        ? { scope: { kind: "thread", threadId: target.threadId }, scopeMode: "exact", sort }
        : undefined;
    case "project":
      return target.projectId
        ? {
            scope: { kind: "project", projectId: target.projectId },
            scopeMode: options.includeThreadWorkpads ? "subtree" : "exact",
            sort,
          }
        : undefined;
    case "global":
      return { scope: { kind: "global" }, scopeMode: "exact", sort };
    case "all":
      return {
        scope: { kind: "global" },
        scopeMode: "subtree",
        sort,
        group: options.groupByProject ? "project" : "none",
        ...(options.groupByProject && target.projectId ? { leadProjectId: target.projectId } : {}),
      };
  }
}

/** The view's Archived section: the same scope and sort, never grouped. */
export function archivedListRequest(
  view: WorkpadsView,
  target: WorkpadsTarget,
  options: WorkpadsViewOptions,
): WorkpadListQuery | undefined {
  const active = workpadListRequest(view, target, options);
  return active && { scope: active.scope, scopeMode: active.scopeMode, sort: active.sort, archived: true };
}

/**
 * A view's count among the server's counts: Project counts its threads'
 * workpads while it includes them. Undefined while counts are not known.
 */
export function viewCount(
  counts: WorkpadCounts["active"] | undefined,
  view: WorkpadsView,
  includeThreadWorkpads: boolean,
): number | undefined {
  if (!counts) return undefined;
  const value =
    view === "thread" ? counts.thread
      : view === "project" ? (includeThreadWorkpads ? counts.projectWithThreads : counts.project)
        : view === "global" ? counts.global
          : counts.all;
  return value ?? undefined;
}

/**
 * Whether rows say where each workpad belongs: in lists that mix scopes
 * without group headings. That is All ungrouped and Project with its
 * threads' workpads, as in Tasks, and All's Archived section, which is
 * never grouped.
 */
export function showsLocation(
  view: WorkpadsView,
  options: WorkpadsViewOptions,
  section: "active" | "archived",
): boolean {
  if (view === "project") return options.includeThreadWorkpads;
  if (view === "all") return section === "archived" || !options.groupByProject;
  return false;
}

export interface WorkpadGroup {
  /** The scope key ("global", "project:…", "thread:…"); collapse state keys on it. */
  readonly key: string;
  readonly kind: TaskGroupKind;
  readonly label: string;
  readonly items: readonly WorkpadSummary[];
  /** A project's thread groups. */
  readonly children: readonly WorkpadGroup[];
  /** Loaded workpads in the group and its children. */
  readonly count: number;
}

export interface WorkpadGroupLabels {
  project(projectId: string): string | undefined;
  thread(threadId: string): string | undefined;
  /** The project of a thread's location. */
  threadProject(threadId: string): string | undefined;
}

const NO_PROJECT = "none";

/**
 * All's groups from the loaded pages: Global, then each project with its
 * own workpads and then each thread's. The server orders the groups (the
 * lead project first, then the others by name, each project's threads by
 * title) and keeps each contiguous across pages, so groups take the order
 * their first workpad arrives in and a later page continues the last one.
 * Nothing is re-sorted here.
 */
export function groupWorkpads(
  items: readonly WorkpadSummary[],
  labels: WorkpadGroupLabels,
): WorkpadGroup[] {
  interface Draft { key: string; kind: TaskGroupKind; label: string; items: WorkpadSummary[]; children: Map<string, Draft> }
  const groups = new Map<string, Draft>();
  const group = (map: Map<string, Draft>, key: string, kind: TaskGroupKind, label: () => string): Draft => {
    let entry = map.get(key);
    if (!entry) {
      entry = { key, kind, label: label(), items: [], children: new Map() };
      map.set(key, entry);
    }
    return entry;
  };
  const project = (projectId: string) =>
    group(groups, `project:${projectId}`, "project", () =>
      projectId === NO_PROJECT ? "No project" : (labels.project(projectId) ?? "Project"));
  for (const item of items) {
    const { scope } = item;
    if (scope.kind === "global") group(groups, "global", "global", () => "Global").items.push(item);
    else if (scope.kind === "project") project(scope.projectId).items.push(item);
    else {
      const owner = project(labels.threadProject(scope.threadId) ?? NO_PROJECT);
      group(owner.children, `thread:${scope.threadId}`, "thread", () => labels.thread(scope.threadId) ?? "Thread").items.push(item);
    }
  }
  const finish = (draft: Draft): WorkpadGroup => {
    const children = [...draft.children.values()].map(finish);
    return {
      key: draft.key,
      kind: draft.kind,
      label: draft.label,
      items: draft.items,
      children,
      count: draft.items.length + children.reduce((total, child) => total + child.count, 0),
    };
  };
  return [...groups.values()].map(finish);
}

/** Every group key, nested ones included, for Collapse all groups. */
export function groupKeys(groups: readonly WorkpadGroup[]): string[] {
  return groups.flatMap(group => [group.key, ...groupKeys(group.children)]);
}
