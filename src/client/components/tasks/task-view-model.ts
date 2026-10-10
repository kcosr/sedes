import type { AssociatedTask, TaskScope } from "../../../shared/index.js";
import type {
  TasksSort,
  TasksView,
  TasksViewOptions,
} from "../../app/tasks-panel-store.js";
import { SCOPE_VIEW_LABEL } from "../scope-view/scope-views.js";

/**
 * Pure presentation logic for the Tasks panel: which tasks a view shows, in
 * what order, and how many are open. Task data is server-owned
 * and the application snapshot carries every task the principal owns, so
 * filtering, ordering and counting happen here on the client.
 */

export const TASKS_VIEW_LABEL: Readonly<Record<TasksView, string>> = SCOPE_VIEW_LABEL;

export const TASK_TITLE_MAX_CHARACTERS = 240;
/** A multi-line paste creates at most this many tasks at once. */
export const TASK_PASTE_MAX_TITLES = 50;

/** A View option in effect beyond the view's default, shown as a removable chip. */
export interface TasksViewFilter {
  readonly key: "pinned" | "backlog" | "notes" | "files" | "threads";
  readonly label: string;
  /** The change that removes it. */
  readonly clear: Partial<TasksViewOptions>;
  /**
   * Whether it hides tasks (the Only options). Project's thread tasks add
   * tasks instead, so the list never offers to reset them when empty.
   */
  readonly narrows: boolean;
}

/**
 * The View options in effect beyond the view's default, in menu order: the
 * Only options, which narrow the list, and Project's Include thread tasks.
 */
export function viewFilters(
  options: TasksViewOptions,
  view: TasksView,
): readonly TasksViewFilter[] {
  const filters: TasksViewFilter[] = [];
  if (options.onlyPinned)
    filters.push({ key: "pinned", label: "Pinned only", clear: { onlyPinned: false }, narrows: true });
  if (options.onlyBacklog)
    filters.push({ key: "backlog", label: "Backlog only", clear: { onlyBacklog: false }, narrows: true });
  if (options.onlyWithNotes)
    filters.push({ key: "notes", label: "With notes", clear: { onlyWithNotes: false }, narrows: true });
  if (options.onlyWithFiles)
    filters.push({ key: "files", label: "With files", clear: { onlyWithFiles: false }, narrows: true });
  if (view === "project" && options.includeThreadTasks)
    filters.push({ key: "threads", label: "Thread tasks", clear: { includeThreadTasks: false }, narrows: false });
  return filters;
}

/** The chat the panel follows. */
export interface TasksContext {
  /** Absent for an archived thread, or one the snapshot does not hold. */
  readonly thread?: {
    readonly id: string;
    readonly title: string;
    readonly workspaceId: string;
  };
  /** The followed thread is archived, so it has no Thread view. */
  readonly threadArchived?: true;
  readonly project?: { readonly id: string; readonly label: string };
}

/** Why a view does not apply to the chat the panel follows; `items` names what it lists. */
export function viewUnavailableReason(
  view: TasksView,
  context: TasksContext,
  items = "tasks",
): string | undefined {
  if (view === "thread" && !context.thread) {
    return context.threadArchived
      ? `This thread is archived. Restore it to see its ${items}.`
      : "This thread isn't available.";
  }
  if (view === "project" && !context.project) {
    return "This thread's project isn't available.";
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
  if (scope.kind === "project") return `project:${scope.projectId}`;
  return `thread:${scope.threadId}`;
}

export function parseScopeKey(key: string): TaskScope | undefined {
  if (key === "global") return { kind: "global" };
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 0 || id.length === 0) return undefined;
  if (kind === "project") return { kind: "project", projectId: id };
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
      ? { kind: "project", projectId: context.project.id }
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
  if (task.scope.kind === "project") {
    return task.scope.projectId === context.project.id;
  }
  return (
    includeThreadTasks &&
    task.scope.kind === "thread" &&
    task.associatedProjectId === context.project.id
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
    (!options.onlyBacklog || task.backlog) &&
    (!options.onlyWithNotes || task.details.trim().length > 0) &&
    (!options.onlyWithFiles || task.files.length > 0)
  );
}

const time = (value: string | null): number =>
  value === null ? 0 : Date.parse(value);

type TaskComparator = (left: AssociatedTask, right: AssociatedTask) => number;

/** The chosen sort alone. Newest is by creation, so editing never reorders it. */
function compareBySort(sort: TasksSort): TaskComparator {
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
      time(right.createdAt) - time(left.createdAt) ||
      left.id.localeCompare(right.id)
    );
  };
}

/** An open section's order (the list, and Backlog): pinned tasks first in every sort. */
export function compareOpen(sort: TasksSort): TaskComparator {
  const bySort = compareBySort(sort);
  return (left, right) =>
    Number(right.pinned) - Number(left.pinned) || bySort(left, right);
}

/**
 * Completed tasks, which are never pinned: by default the most recently
 * completed first.
 */
export function compareCompleted(sort: TasksSort): TaskComparator {
  if (sort !== "newest") return compareBySort(sort);
  return (left, right) =>
    time(right.completedAt) - time(left.completedAt) ||
    time(right.createdAt) - time(left.createdAt) ||
    left.id.localeCompare(right.id);
}

/** What one view lists: the main list, then the collapsed sections. */
export interface TaskSections {
  /** Open tasks that are current work; under Only › Backlog, the backlog tasks. */
  readonly main: readonly AssociatedTask[];
  /** Open tasks that are not current work; none under Only › Backlog. */
  readonly backlog: readonly AssociatedTask[];
  readonly completed: readonly AssociatedTask[];
}

/**
 * Splits the tasks a view shows (already searched and filtered) into its
 * sections, each in the chosen order. Under Only › Backlog the backlog
 * tasks are the main list, so there is no Backlog section. Only › Pinned
 * and Only › Backlog leave Completed empty: a completed task is never
 * pinned or in the backlog.
 */
export function taskSections(
  tasks: readonly AssociatedTask[],
  options: TasksViewOptions,
): TaskSections {
  const main: AssociatedTask[] = [];
  const backlog: AssociatedTask[] = [];
  const completed: AssociatedTask[] = [];
  for (const task of tasks) {
    if (task.completedAt !== null) completed.push(task);
    else if (task.backlog && !options.onlyBacklog) backlog.push(task);
    else main.push(task);
  }
  return {
    main: main.sort(compareOpen(options.sort)),
    backlog: backlog.sort(compareOpen(options.sort)),
    completed: completed.sort(compareCompleted(options.sort)),
  };
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
    task.scope.kind === "project" &&
    context.project?.id === task.scope.projectId
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
