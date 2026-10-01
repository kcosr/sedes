import { useSyncExternalStore } from "react";

/**
 * The Tasks panel's remembered view and per-view View options.
 *
 * Integration adapter: these names, types and defaults mirror the version 2
 * viewer-local store in `app/tasks-panel-store.ts` (track H). When
 * integrating, import them from the store instead (`useTasksLastView()`
 * becomes `useTasksPanelPreferences().lastView`) and delete this file.
 */

export type TasksView = "thread" | "project" | "global" | "all";

export const TASKS_VIEWS: readonly TasksView[] = [
  "thread",
  "project",
  "global",
  "all",
];

/** Pinned then newest (the default), most recently updated, or by title. */
export type TasksSort = "pinned-newest" | "updated" | "title";

/** Open tasks (Completed collapsed at the end) or completed tasks only. */
export type TasksShow = "open" | "completed";

/** The View options of one view, remembered per view. */
export interface TasksViewOptions {
  readonly sort: TasksSort;
  readonly show: TasksShow;
  readonly onlyPinned: boolean;
  readonly onlyWithNotes: boolean;
  readonly onlyWithFiles: boolean;
  /** Applies to All. */
  readonly groupByProject: boolean;
  /** Applies to Project: its threads' tasks join the project's own. */
  readonly includeThreadTasks: boolean;
  /** Search matches notes as well as titles. */
  readonly searchNotes: boolean;
}

const BASE_VIEW_OPTIONS: TasksViewOptions = Object.freeze({
  sort: "pinned-newest",
  show: "open",
  onlyPinned: false,
  onlyWithNotes: false,
  onlyWithFiles: false,
  groupByProject: true,
  includeThreadTasks: false,
  searchNotes: false,
});

export const TASKS_VIEW_OPTIONS_DEFAULTS: Readonly<
  Record<TasksView, TasksViewOptions>
> = Object.freeze({
  thread: BASE_VIEW_OPTIONS,
  project: BASE_VIEW_OPTIONS,
  global: BASE_VIEW_OPTIONS,
  all: BASE_VIEW_OPTIONS,
});

interface ViewPreferences {
  readonly lastView: TasksView;
  readonly views: Readonly<Record<TasksView, TasksViewOptions>>;
}

const DEFAULTS: ViewPreferences = Object.freeze({
  lastView: "thread",
  views: TASKS_VIEW_OPTIONS_DEFAULTS,
});

const STORAGE_KEY = "sedes.tasks.view";
const CHANGED_EVENT = "sedes-tasks-view-changed";
const SORTS: readonly TasksSort[] = ["pinned-newest", "updated", "title"];
let cached: ViewPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === STORAGE_KEY) cached = null;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptions(value: unknown): TasksViewOptions {
  if (!isRecord(value)) return BASE_VIEW_OPTIONS;
  const flag = (key: keyof TasksViewOptions) =>
    typeof value[key] === "boolean"
      ? (value[key] as boolean)
      : (BASE_VIEW_OPTIONS[key] as boolean);
  return {
    sort: SORTS.find((sort) => sort === value.sort) ?? BASE_VIEW_OPTIONS.sort,
    show: value.show === "completed" ? "completed" : "open",
    onlyPinned: flag("onlyPinned"),
    onlyWithNotes: flag("onlyWithNotes"),
    onlyWithFiles: flag("onlyWithFiles"),
    groupByProject: flag("groupByProject"),
    includeThreadTasks: flag("includeThreadTasks"),
    searchNotes: flag("searchNotes"),
  };
}

function read(): ViewPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULTS;
  }
  if (raw === null) return DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (!isRecord(parsed)) return DEFAULTS;
  const views = isRecord(parsed.views) ? parsed.views : {};
  return {
    lastView:
      TASKS_VIEWS.find((view) => view === parsed.lastView) ?? DEFAULTS.lastView,
    views: {
      thread: parseOptions(views.thread),
      project: parseOptions(views.project),
      global: parseOptions(views.global),
      all: parseOptions(views.all),
    },
  };
}

function snapshot(): ViewPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  cached ??= read();
  return cached;
}

function persist(next: ViewPreferences): void {
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the value for this session only.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(listener: () => void): () => void {
  // The module-level storage listener has already dropped the cache.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGED_EVENT, listener);
  };
}

function usePreferences(): ViewPreferences {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}

/** The view Tasks opens on: the one last chosen. */
export function useTasksLastView(): TasksView {
  return usePreferences().lastView;
}

/** Remembers the view Tasks opens on next time. */
export function setTasksLastView(lastView: TasksView): void {
  const current = snapshot();
  if (current.lastView !== lastView) persist({ ...current, lastView });
}

export function getTasksViewOptions(view: TasksView): TasksViewOptions {
  return snapshot().views[view];
}

/** One view's options, live. */
export function useTasksViewOptions(view: TasksView): TasksViewOptions {
  return usePreferences().views[view];
}

/** Changes some of one view's options; the other views keep theirs. */
export function setTasksViewOptions(
  view: TasksView,
  patch: Partial<TasksViewOptions>,
): void {
  const current = snapshot();
  persist({
    ...current,
    views: { ...current.views, [view]: { ...current.views[view], ...patch } },
  });
}
