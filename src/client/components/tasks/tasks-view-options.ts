import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_TASKS_VIEW_OPTIONS,
  TASKS_VIEWS,
  type TasksView,
  type TasksViewOptions,
} from "./task-view-model.js";

/**
 * The Tasks panel's remembered view and per-view View options.
 *
 * Integration adapter: the viewer-local `app/tasks-panel-store.ts` owns
 * this preference (its new shape carries the last view and the View
 * options per view). Until that lands, the two hooks below keep the same
 * shape over a small localStorage-backed module; point them at the store
 * and delete the rest of this file when integrating.
 */

const STORAGE_KEY = "sedes.tasks.view";
const CHANGED_EVENT = "sedes-tasks-view-changed";

interface StoredViewPreferences {
  readonly view: TasksView;
  readonly options: Readonly<Partial<Record<TasksView, TasksViewOptions>>>;
}

const DEFAULTS: StoredViewPreferences = { view: "thread", options: {} };
let cached: StoredViewPreferences | null = null;

function isView(value: unknown): value is TasksView {
  return (
    typeof value === "string" && (TASKS_VIEWS as readonly string[]).includes(value)
  );
}

function parseOptions(value: unknown): TasksViewOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const blob = value as Record<string, unknown>;
  const flag = (key: keyof TasksViewOptions) =>
    typeof blob[key] === "boolean"
      ? (blob[key] as boolean)
      : (DEFAULT_TASKS_VIEW_OPTIONS[key] as boolean);
  return {
    sort:
      blob.sort === "updated" || blob.sort === "title" ? blob.sort : "pinned",
    show: blob.show === "completed" ? "completed" : "open",
    onlyPinned: flag("onlyPinned"),
    onlyNotes: flag("onlyNotes"),
    onlyFiles: flag("onlyFiles"),
    groupByProject: flag("groupByProject"),
    includeThreadTasks: flag("includeThreadTasks"),
    searchNotes: flag("searchNotes"),
  };
}

function read(): StoredViewPreferences {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULTS;
  }
  if (raw === null) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const options: Partial<Record<TasksView, TasksViewOptions>> = {};
    const stored = (parsed.options ?? {}) as Record<string, unknown>;
    for (const view of TASKS_VIEWS) {
      const parsedOptions = parseOptions(stored[view]);
      if (parsedOptions) options[view] = parsedOptions;
    }
    return { view: isView(parsed.view) ? parsed.view : DEFAULTS.view, options };
  } catch {
    return DEFAULTS;
  }
}

function snapshot(): StoredViewPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  cached ??= read();
  return cached;
}

function persist(next: StoredViewPreferences): void {
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the value for this session only.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(listener: () => void): () => void {
  // The module-level storage listener below has already dropped the cache.
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

function usePreferences(): StoredViewPreferences {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}

/** The last chosen view (Thread, Project, Global or All). */
export function useTasksLastView(): readonly [
  TasksView,
  (view: TasksView) => void,
] {
  const preferences = usePreferences();
  const setView = useCallback((view: TasksView) => {
    const current = snapshot();
    if (current.view !== view) persist({ ...current, view });
  }, []);
  return [preferences.view, setView];
}

/** One view's View options and a setter that merges a change into them. */
export function useTasksViewOptions(
  view: TasksView,
): readonly [TasksViewOptions, (change: Partial<TasksViewOptions>) => void] {
  const preferences = usePreferences();
  const options = preferences.options[view] ?? DEFAULT_TASKS_VIEW_OPTIONS;
  const update = useCallback(
    (change: Partial<TasksViewOptions>) => {
      const current = snapshot();
      persist({
        ...current,
        options: {
          ...current.options,
          [view]: {
            ...(current.options[view] ?? DEFAULT_TASKS_VIEW_OPTIONS),
            ...change,
          },
        },
      });
    },
    [view],
  );
  return [options, update];
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === STORAGE_KEY) cached = null;
  });
}
