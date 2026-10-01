import type { AssociatedTask, TaskScope } from "../../../shared/index.js";

/**
 * Pure presentation logic for the Tasks panel: which tasks a view shows, in
 * what order and grouping, and how many are open. Task data is server-owned
 * and the application snapshot carries every task the principal owns, so
 * filtering, grouping and counting happen here on the client.
 */

export type TasksView = "thread" | "project" | "global" | "all";

export const TASKS_VIEWS: readonly TasksView[] = [
  "thread",
  "project",
  "global",
  "all",
];

export const TASKS_VIEW_LABEL: Record<TasksView, string> = {
  thread: "Thread",
  project: "Project",
  global: "Global",
  all: "All",
};

export const TASK_TITLE_MAX_CHARACTERS = 240;
/** A multi-line paste creates at most this many tasks at once. */
export const TASK_PASTE_MAX_TITLES = 50;

export type TasksSort = "pinned" | "updated" | "title";
export type TasksShow = "open" | "completed";

/** View options, remembered per view. */
export interface TasksViewOptions {
  readonly sort: TasksSort;
  readonly show: TasksShow;
  readonly onlyPinned: boolean;
  readonly onlyNotes: boolean;
  readonly onlyFiles: boolean;
  /** All only. */
  readonly groupByProject: boolean;
  /** Project only: also show the tasks of the project's threads. */
  readonly includeThreadTasks: boolean;
  readonly searchNotes: boolean;
}

export const DEFAULT_TASKS_VIEW_OPTIONS: TasksViewOptions = {
  sort: "pinned",
  show: "open",
  onlyPinned: false,
  onlyNotes: false,
  onlyFiles: false,
  groupByProject: true,
  includeThreadTasks: false,
  searchNotes: true,
};

/** Whether options narrow the list beyond the view's default (an indicator on the trigger). */
export function viewOptionsFilter(options: TasksViewOptions): boolean {
  return (
    options.show !== "open" ||
    options.onlyPinned ||
    options.onlyNotes ||
    options.onlyFiles
  );
}

/** The chat the panel follows. */
export interface TasksContext {
  readonly thread?: {
    readonly id: string;
    readonly title: string;
    readonly workspaceId: string;
  };
  readonly project?: { readonly id: string; readonly label: string };
}

export function viewUnavailableReason(
  view: TasksView,
  context: TasksContext,
): string | undefined {
  if (view === "thread" && !context.thread) {
    return "Open a thread to see its tasks.";
  }
  if (view === "project" && !context.project) {
    return "Open a thread in a project to see its project tasks.";
  }
  return undefined;
}

/** Narrow an unavailable view along thread → project → global. */
export function clampView(view: TasksView, context: TasksContext): TasksView {
  if (viewUnavailableReason(view, context) === undefined) return view;
  if (view === "thread" && context.project) return "project";
  return "global";
}

export function scopeKey(scope: TaskScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "workspace") return `workspace:${scope.workspaceId}`;
  return `thread:${scope.threadId}`;
}

export function parseScopeKey(key: string): TaskScope | undefined {
  if (key === "global") return { kind: "global" };
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 0 || id.length === 0) return undefined;
  if (kind === "workspace") return { kind: "workspace", workspaceId: id };
  if (kind === "thread") return { kind: "thread", threadId: id };
  return undefined;
}

export function sameScope(left: TaskScope, right: TaskScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

/** Where the add row creates a task: All adds to Global. */
export function destinationScope(
  view: TasksView,
  context: TasksContext,
): TaskScope | undefined {
  if (view === "thread") {
    return context.thread
      ? { kind: "thread", threadId: context.thread.id }
      : undefined;
  }
  if (view === "project") {
    return context.project
      ? { kind: "workspace", workspaceId: context.project.id }
      : undefined;
  }
  return { kind: "global" };
}

/** Whether a task belongs to a view's scope (before search and filters). */
export function inViewScope(
  task: AssociatedTask,
  view: TasksView,
  context: TasksContext,
  includeThreadTasks: boolean,
): boolean {
  if (view === "all") return true;
  if (view === "global") return task.scope.kind === "global";
  if (view === "thread") {
    return (
      context.thread !== undefined &&
      task.scope.kind === "thread" &&
      task.scope.threadId === context.thread.id
    );
  }
  if (!context.project) return false;
  if (task.scope.kind === "workspace") {
    return task.scope.workspaceId === context.project.id;
  }
  return (
    includeThreadTasks &&
    task.scope.kind === "thread" &&
    task.associatedWorkspaceId === context.project.id
  );
}

export function openCount(
  tasks: readonly AssociatedTask[],
  view: TasksView,
  context: TasksContext,
  includeThreadTasks: boolean,
): number {
  if (viewUnavailableReason(view, context) !== undefined) return 0;
  return tasks.filter(
    (task) =>
      task.completedAt === null &&
      inViewScope(task, view, context, includeThreadTasks),
  ).length;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function matchesQuery(
  task: AssociatedTask,
  normalizedQuery: string,
  searchNotes: boolean,
): boolean {
  if (normalizedQuery.length === 0) return true;
  return (
    task.title.toLocaleLowerCase().includes(normalizedQuery) ||
    (searchNotes && task.details.toLocaleLowerCase().includes(normalizedQuery))
  );
}

export function matchesOnly(
  task: AssociatedTask,
  options: TasksViewOptions,
): boolean {
  return (
    (!options.onlyPinned || task.pinned) &&
    (!options.onlyNotes || task.details.trim().length > 0) &&
    (!options.onlyFiles || task.files.length > 0)
  );
}

const time = (value: string | null): number =>
  value === null ? 0 : Date.parse(value);

/**
 * The open list's order. The default puts pinned tasks first, then the
 * newest; editing never reorders it.
 */
export function compareOpen(
  sort: TasksSort,
): (left: AssociatedTask, right: AssociatedTask) => number {
  return (left, right) => {
    if (sort === "title") {
      return (
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
          numeric: true,
        }) || left.id.localeCompare(right.id)
      );
    }
    if (sort === "updated") {
      return (
        time(right.updatedAt) - time(left.updatedAt) ||
        left.id.localeCompare(right.id)
      );
    }
    return (
      Number(right.pinned) - Number(left.pinned) ||
      time(right.createdAt) - time(left.createdAt) ||
      left.id.localeCompare(right.id)
    );
  };
}

/** Completed tasks: most recently completed first; pinning does not lift them. */
export function compareCompleted(
  sort: TasksSort,
): (left: AssociatedTask, right: AssociatedTask) => number {
  if (sort !== "pinned") return compareOpen(sort);
  return (left, right) =>
    time(right.completedAt) - time(left.completedAt) ||
    time(right.createdAt) - time(left.createdAt) ||
    left.id.localeCompare(right.id);
}

export type TaskGroupKind = "global" | "project" | "thread";

export interface TaskGroup {
  /** The scope key ("global", "workspace:…", "thread:…"); collapse state keys on it. */
  readonly key: string;
  readonly kind: TaskGroupKind;
  readonly label: string;
  readonly tasks: readonly AssociatedTask[];
  /** A project's thread groups. */
  readonly children: readonly TaskGroup[];
  /** Tasks in the group and its children. */
  readonly count: number;
}

export interface TaskGroupLabels {
  readonly workspaces: ReadonlyMap<string, string>;
  readonly threads: ReadonlyMap<string, string>;
}

const NO_PROJECT = "none";

/**
 * Groups for All: Global first, then each project (the current one first,
 * then by name) with its threads' groups nested under it. Tasks keep the
 * order they arrive in.
 */
export function groupTasks(
  tasks: readonly AssociatedTask[],
  labels: TaskGroupLabels,
  context: TasksContext,
): TaskGroup[] {
  const global: AssociatedTask[] = [];
  const projects = new Map<
    string,
    { own: AssociatedTask[]; threads: Map<string, AssociatedTask[]> }
  >();
  const project = (workspaceId: string) => {
    let entry = projects.get(workspaceId);
    if (!entry) {
      entry = { own: [], threads: new Map() };
      projects.set(workspaceId, entry);
    }
    return entry;
  };
  for (const task of tasks) {
    if (task.scope.kind === "global") global.push(task);
    else if (task.scope.kind === "workspace") {
      project(task.scope.workspaceId).own.push(task);
    } else {
      const threads = project(task.associatedWorkspaceId ?? NO_PROJECT).threads;
      const list = threads.get(task.scope.threadId) ?? [];
      list.push(task);
      threads.set(task.scope.threadId, list);
    }
  }
  const projectLabel = (id: string) =>
    id === NO_PROJECT ? "No project" : (labels.workspaces.get(id) ?? "Project");
  const threadLabel = (id: string) => labels.threads.get(id) ?? "Thread";
  const byLabel =
    (label: (id: string) => string, current: string | undefined) =>
    (left: string, right: string) =>
      Number(right === current) - Number(left === current) ||
      label(left).localeCompare(label(right), undefined, {
        sensitivity: "base",
        numeric: true,
      }) ||
      left.localeCompare(right);

  const groups: TaskGroup[] = [];
  if (global.length > 0) {
    groups.push({
      key: "global",
      kind: "global",
      label: "Global",
      tasks: global,
      children: [],
      count: global.length,
    });
  }
  for (const workspaceId of [...projects.keys()].sort(
    byLabel(projectLabel, context.project?.id),
  )) {
    const entry = projects.get(workspaceId)!;
    const children = [...entry.threads.keys()]
      .sort(byLabel(threadLabel, context.thread?.id))
      .map((threadId): TaskGroup => {
        const threadTasks = entry.threads.get(threadId)!;
        return {
          key: `thread:${threadId}`,
          kind: "thread",
          label: threadLabel(threadId),
          tasks: threadTasks,
          children: [],
          count: threadTasks.length,
        };
      });
    groups.push({
      key: `workspace:${workspaceId}`,
      kind: "project",
      label: projectLabel(workspaceId),
      tasks: entry.own,
      children,
      count:
        entry.own.length +
        children.reduce((total, child) => total + child.count, 0),
    });
  }
  return groups;
}

/** The view a revealed task opens in: its own scope when the chat follows it, else All. */
export function revealView(
  task: AssociatedTask,
  context: TasksContext,
): TasksView {
  if (task.scope.kind === "global") return "global";
  if (
    task.scope.kind === "thread" &&
    context.thread?.id === task.scope.threadId
  ) {
    return "thread";
  }
  if (
    task.scope.kind === "workspace" &&
    context.project?.id === task.scope.workspaceId
  ) {
    return "project";
  }
  return "all";
}

const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/u;
const CHECKBOX_MARKER = /^\[[ xX]\]\s+/u;

/**
 * The task titles in pasted text: one per non-empty line, without list
 * bullets, numbers or checkboxes, cut to the title limit.
 */
export function parsePastedTitles(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/u)
    .map((line) =>
      line
        .trim()
        .replace(LIST_MARKER, "")
        .replace(CHECKBOX_MARKER, "")
        .trim()
        .slice(0, TASK_TITLE_MAX_CHARACTERS)
        .trim(),
    )
    .filter((line) => line.length > 0);
}

export function taskFileName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.split("/").at(-1) || path;
}

/** The directory part shown before a file name ("src/"), at most one level. */
export function taskFileParent(path: string): string {
  const parts = path.replace(/\/+$/u, "").split("/").filter(Boolean);
  return parts.length > 1 ? `${parts.at(-2)}/` : "";
}
