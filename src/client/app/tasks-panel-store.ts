import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  SCOPE_LIST_SORTS,
  SCOPE_VIEWS,
  type ScopeListSort,
  type ScopeView,
} from "../components/scope-view/scope-views.js";

/**
 * Viewer-local Tasks preferences. Task data itself is server-owned
 * application state; only presentation choices live here (AGENTS.md
 * "Ownership and tenancy").
 *
 * Whether Tasks is open is not a preference: the panel layout store owns the
 * docked panel, and the phone sheet keeps a local open state in its host.
 */
export type TasksView = ScopeView;

export const TASKS_VIEWS: readonly TasksView[] = SCOPE_VIEWS;

/**
 * The order within each section: newest (the default), most recently
 * updated, or by title. Pinned tasks lead every section in every sort.
 */
export type TasksSort = ScopeListSort;

/**
 * The View options of one view, remembered per view. The list always ends
 * with the collapsed Backlog and Completed sections; the Only options
 * combine. All is one flat list; a retired `groupByProject` is dropped as
 * it is read.
 */
export interface TasksViewOptions {
  readonly sort: TasksSort;
  readonly onlyPinned: boolean;
  /** The backlog tasks become the list, without the Backlog section. */
  readonly onlyBacklog: boolean;
  readonly onlyWithNotes: boolean;
  readonly onlyWithFiles: boolean;
  /** Applies to Project: its threads' tasks join the project's own. */
  readonly includeThreadTasks: boolean;
  /** Search matches notes as well as titles. */
  readonly searchNotes: boolean;
}

export interface TasksPanelPreferences {
  readonly version: 2;
  /** The view Tasks opens on: the one last chosen. */
  readonly lastView: TasksView;
  readonly views: Readonly<Record<TasksView, TasksViewOptions>>;
}

export const TASKS_PANEL_STORAGE_KEY = "sedes.tasks.panel";

/** The retired floating card's width; deleted by the version 1 migration. */
const RETIRED_WIDTH_STORAGE_KEY = "sedes.tasks.panel.width";

// A retired sort ("pinned-newest", from when pins were a sort) reads as the
// default, and a retired `show` choice is dropped: Completed is always the
// collapsed section now. So is a retired `groupByProject`: All is flat.
const TASKS_SORTS: readonly TasksSort[] = SCOPE_LIST_SORTS;

const BASE_VIEW_OPTIONS: TasksViewOptions = Object.freeze({
  sort: "newest",
  onlyPinned: false,
  onlyBacklog: false,
  onlyWithNotes: false,
  onlyWithFiles: false,
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

export const TASKS_PANEL_DEFAULTS: TasksPanelPreferences = Object.freeze({
  version: 2,
  lastView: "thread",
  views: TASKS_VIEW_OPTIONS_DEFAULTS,
});

const changedEvent = "sedes-tasks-panel-changed";
let cachedSnapshot: TasksPanelPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === TASKS_PANEL_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseViewOptions(
  value: unknown,
  fallback: TasksViewOptions,
): TasksViewOptions {
  if (!isRecord(value)) return fallback;
  return {
    sort: pick(value.sort, TASKS_SORTS, fallback.sort),
    onlyPinned: flag(value.onlyPinned, fallback.onlyPinned),
    onlyBacklog: flag(value.onlyBacklog, fallback.onlyBacklog),
    onlyWithNotes: flag(value.onlyWithNotes, fallback.onlyWithNotes),
    onlyWithFiles: flag(value.onlyWithFiles, fallback.onlyWithFiles),
    includeThreadTasks: flag(
      value.includeThreadTasks,
      fallback.includeThreadTasks,
    ),
    searchNotes: flag(value.searchNotes, fallback.searchNotes),
  };
}

function parseVersion2(blob: Record<string, unknown>): TasksPanelPreferences {
  const views = isRecord(blob.views) ? blob.views : {};
  return {
    version: 2,
    lastView: pick(blob.lastView, TASKS_VIEWS, TASKS_PANEL_DEFAULTS.lastView),
    views: {
      thread: parseViewOptions(views.thread, TASKS_VIEW_OPTIONS_DEFAULTS.thread),
      project: parseViewOptions(
        views.project,
        TASKS_VIEW_OPTIONS_DEFAULTS.project,
      ),
      global: parseViewOptions(views.global, TASKS_VIEW_OPTIONS_DEFAULTS.global),
      all: parseViewOptions(views.all, TASKS_VIEW_OPTIONS_DEFAULTS.all),
    },
  };
}

/**
 * Version 1 kept `open` and `pinned` for the floating card, a `defaultView`
 * every opening reset to, one `searchContent` switch and one
 * `includeNestedScopes` switch. Open state now belongs to the panel layout
 * and the card's pin is gone, so both are dropped. The default view becomes
 * the remembered view; Global with nested scopes was every task, which is
 * now All. Search content applies to every view; nested scopes become
 * Project's "Include thread tasks".
 */
function migrateTasksPanelPreferencesV1(
  blob: Record<string, unknown>,
): TasksPanelPreferences {
  const defaultView = pick(
    blob.defaultView,
    ["thread", "project", "global"] as const,
    "thread",
  );
  const includeNestedScopes = flag(blob.includeNestedScopes, false);
  const searchNotes = flag(blob.searchContent, false);
  const withSearch = (options: TasksViewOptions): TasksViewOptions => ({
    ...options,
    searchNotes,
  });
  return {
    version: 2,
    lastView:
      defaultView === "global" && includeNestedScopes ? "all" : defaultView,
    views: {
      thread: withSearch(TASKS_VIEW_OPTIONS_DEFAULTS.thread),
      project: {
        ...withSearch(TASKS_VIEW_OPTIONS_DEFAULTS.project),
        includeThreadTasks: includeNestedScopes,
      },
      global: withSearch(TASKS_VIEW_OPTIONS_DEFAULTS.global),
      all: withSearch(TASKS_VIEW_OPTIONS_DEFAULTS.all),
    },
  };
}

function writeStorage(next: TasksPanelPreferences): void {
  try {
    window.localStorage.setItem(TASKS_PANEL_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the value for this session only.
  }
}

function readPreferences(): TasksPanelPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TASKS_PANEL_STORAGE_KEY);
  } catch {
    return TASKS_PANEL_DEFAULTS;
  }
  if (raw === null) return TASKS_PANEL_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return TASKS_PANEL_DEFAULTS;
  }
  if (!isRecord(parsed)) return TASKS_PANEL_DEFAULTS;
  if (parsed.version === 2) return parseVersion2(parsed);
  if (parsed.version !== 1) return TASKS_PANEL_DEFAULTS;
  // Rewrite the stored blob once, so no version 1 shape outlives this read,
  // and drop the retired card width with it.
  const migrated = migrateTasksPanelPreferencesV1(parsed);
  writeStorage(migrated);
  try {
    window.localStorage.removeItem(RETIRED_WIDTH_STORAGE_KEY);
  } catch {
    // Best effort, like every write here.
  }
  return migrated;
}

export function getTasksPanelPreferences(): TasksPanelPreferences {
  if (typeof window === "undefined") return TASKS_PANEL_DEFAULTS;
  if (cachedSnapshot === null) cachedSnapshot = readPreferences();
  return cachedSnapshot;
}

function persist(next: TasksPanelPreferences): void {
  if (typeof window === "undefined") return;
  writeStorage(next);
  cachedSnapshot = next;
  window.dispatchEvent(new Event(changedEvent));
}

/** Remembers the view Tasks opens on next time. */
export function setTasksLastView(lastView: TasksView): void {
  const current = getTasksPanelPreferences();
  if (current.lastView === lastView) return;
  persist({ ...current, lastView });
}

export function getTasksViewOptions(view: TasksView): TasksViewOptions {
  return getTasksPanelPreferences().views[view];
}

/** Changes some of one view's options; the other views keep theirs. */
export function setTasksViewOptions(
  view: TasksView,
  patch: Partial<TasksViewOptions>,
): void {
  const current = getTasksPanelPreferences();
  const options = { ...current.views[view], ...patch };
  persist({ ...current, views: { ...current.views, [view]: options } });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TASKS_PANEL_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changedEvent, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changedEvent, listener);
  };
}

export function useTasksPanelPreferences(): TasksPanelPreferences {
  return useSyncExternalStore(
    subscribe,
    getTasksPanelPreferences,
    () => TASKS_PANEL_DEFAULTS,
  );
}

/** One view's options, live. */
export function useTasksViewOptions(view: TasksView): TasksViewOptions {
  return useTasksPanelPreferences().views[view];
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export interface TasksRevealRequest {
  readonly taskId: string;
  /** Distinguishes repeated reveals of one task. */
  readonly sequence: number;
}

let revealSequence = 0;
let pendingReveal: TasksRevealRequest | undefined;
const revealListeners = new Set<(request: TasksRevealRequest) => void>();

/**
 * Opens the Tasks panel beside the current thread (in front on phones), then
 * has the content switch to a view containing the task and expand it. Pages
 * without a thread have no Tasks to open.
 *
 * The request stays pending until the content consumes it, so content that
 * mounts because of this reveal still receives it.
 */
export function revealTask(taskId: string): void {
  revealSequence += 1;
  const request: TasksRevealRequest = { taskId, sequence: revealSequence };
  pendingReveal = request;
  for (const listener of [...revealListeners]) listener(request);
}

/** Live reveal requests; a pending one is not replayed. */
export function subscribeReveal(
  listener: (request: TasksRevealRequest) => void,
): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

export function getPendingReveal(): TasksRevealRequest | undefined {
  return pendingReveal;
}

/** Marks a reveal handled; a newer request stays pending. */
export function consumeReveal(sequence: number): void {
  if (pendingReveal?.sequence === sequence) pendingReveal = undefined;
}

/**
 * For the Tasks content: calls `onReveal` with the pending request on mount
 * and with every later one, consuming each after the call.
 */
export function useTaskReveal(
  onReveal: (request: TasksRevealRequest) => void,
): void {
  const handler = useRef(onReveal);
  handler.current = onReveal;
  const handle = useCallback((request: TasksRevealRequest) => {
    consumeReveal(request.sequence);
    handler.current(request);
  }, []);
  useEffect(() => {
    const pending = getPendingReveal();
    if (pending) handle(pending);
    return subscribeReveal(handle);
  }, [handle]);
}
