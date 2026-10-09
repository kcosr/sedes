import { useSyncExternalStore } from "react";
import {
  SCOPE_LIST_SORTS,
  SCOPE_VIEWS,
  type ScopeListSort,
  type ScopeView,
} from "../components/scope-view/scope-views.js";

/**
 * Viewer-local Workpads preferences, mirroring Tasks'. Workpads are
 * server-owned application state; only presentation choices live here
 * (AGENTS.md "Ownership and tenancy"). Whether the panel is open is the
 * panel layout's.
 */
export type WorkpadsView = ScopeView;

export const WORKPADS_VIEWS: readonly WorkpadsView[] = SCOPE_VIEWS;

export type WorkpadsSort = ScopeListSort;

/** The View options of one view, remembered per view. */
export interface WorkpadsViewOptions {
  /** Newest created, most recently updated (the default) or by title. */
  readonly sort: WorkpadsSort;
  /** Applies to All. */
  readonly groupByProject: boolean;
  /** Applies to Project: its threads' workpads join the project's own. */
  readonly includeThreadWorkpads: boolean;
}

export interface WorkpadsPanelPreferences {
  readonly version: 1;
  /** The view Workpads opens on: the one last chosen. */
  readonly lastView: WorkpadsView;
  readonly views: Readonly<Record<WorkpadsView, WorkpadsViewOptions>>;
}

export const WORKPADS_PANEL_STORAGE_KEY = "sedes.workpads.panel";

const BASE_VIEW_OPTIONS: WorkpadsViewOptions = Object.freeze({
  sort: "updated",
  groupByProject: true,
  includeThreadWorkpads: false,
});

export const WORKPADS_VIEW_OPTIONS_DEFAULTS: Readonly<
  Record<WorkpadsView, WorkpadsViewOptions>
> = Object.freeze({
  thread: BASE_VIEW_OPTIONS,
  project: BASE_VIEW_OPTIONS,
  global: BASE_VIEW_OPTIONS,
  all: BASE_VIEW_OPTIONS,
});

export const WORKPADS_PANEL_DEFAULTS: WorkpadsPanelPreferences = Object.freeze({
  version: 1,
  lastView: "thread",
  views: WORKPADS_VIEW_OPTIONS_DEFAULTS,
});

const changedEvent = "sedes-workpads-panel-changed";
let cachedSnapshot: WorkpadsPanelPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === WORKPADS_PANEL_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseViewOptions(value: unknown, fallback: WorkpadsViewOptions): WorkpadsViewOptions {
  if (!isRecord(value)) return fallback;
  return {
    sort: pick(value.sort, SCOPE_LIST_SORTS, fallback.sort),
    groupByProject: flag(value.groupByProject, fallback.groupByProject),
    includeThreadWorkpads: flag(value.includeThreadWorkpads, fallback.includeThreadWorkpads),
  };
}

function readPreferences(): WorkpadsPanelPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WORKPADS_PANEL_STORAGE_KEY);
  } catch {
    return WORKPADS_PANEL_DEFAULTS;
  }
  if (raw === null) return WORKPADS_PANEL_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return WORKPADS_PANEL_DEFAULTS;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return WORKPADS_PANEL_DEFAULTS;
  const views = isRecord(parsed.views) ? parsed.views : {};
  return {
    version: 1,
    lastView: pick(parsed.lastView, WORKPADS_VIEWS, WORKPADS_PANEL_DEFAULTS.lastView),
    views: {
      thread: parseViewOptions(views.thread, WORKPADS_VIEW_OPTIONS_DEFAULTS.thread),
      project: parseViewOptions(views.project, WORKPADS_VIEW_OPTIONS_DEFAULTS.project),
      global: parseViewOptions(views.global, WORKPADS_VIEW_OPTIONS_DEFAULTS.global),
      all: parseViewOptions(views.all, WORKPADS_VIEW_OPTIONS_DEFAULTS.all),
    },
  };
}

export function getWorkpadsPanelPreferences(): WorkpadsPanelPreferences {
  if (typeof window === "undefined") return WORKPADS_PANEL_DEFAULTS;
  if (cachedSnapshot === null) cachedSnapshot = readPreferences();
  return cachedSnapshot;
}

function persist(next: WorkpadsPanelPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKPADS_PANEL_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the value for this session only.
  }
  cachedSnapshot = next;
  window.dispatchEvent(new Event(changedEvent));
}

/** Remembers the view Workpads opens on next time. */
export function setWorkpadsLastView(lastView: WorkpadsView): void {
  const current = getWorkpadsPanelPreferences();
  if (current.lastView === lastView) return;
  persist({ ...current, lastView });
}

export function getWorkpadsViewOptions(view: WorkpadsView): WorkpadsViewOptions {
  return getWorkpadsPanelPreferences().views[view];
}

/** Changes some of one view's options; the other views keep theirs. */
export function setWorkpadsViewOptions(
  view: WorkpadsView,
  patch: Partial<WorkpadsViewOptions>,
): void {
  const current = getWorkpadsPanelPreferences();
  const options = { ...current.views[view], ...patch };
  persist({ ...current, views: { ...current.views, [view]: options } });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === WORKPADS_PANEL_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changedEvent, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changedEvent, listener);
  };
}

/** The preferences, live: other tabs' changes arrive through storage events. */
export function useWorkpadsPanelPreferences(): WorkpadsPanelPreferences {
  return useSyncExternalStore(subscribe, getWorkpadsPanelPreferences, () => WORKPADS_PANEL_DEFAULTS);
}

/** One view's options, live. */
export function useWorkpadsViewOptions(view: WorkpadsView): WorkpadsViewOptions {
  return useWorkpadsPanelPreferences().views[view];
}
