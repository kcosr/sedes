import { useSyncExternalStore } from "react";

/**
 * Viewer-local Tasks panel preferences. Task data itself is server-owned
 * application state; only presentation choices live here (AGENTS.md
 * "Ownership and tenancy").
 */
export type TasksPanelScopePreference = "global" | "project" | "thread";

export type TasksPanelPreferences = {
  readonly version: 1;
  readonly open: boolean;
  readonly pinned: boolean;
  readonly defaultView: TasksPanelScopePreference;
  readonly searchContent: boolean;
  readonly includeNestedScopes: boolean;
};

export const TASKS_PANEL_STORAGE_KEY = "sedes.tasks.panel";

export const TASKS_PANEL_DEFAULTS: TasksPanelPreferences = {
  version: 1,
  open: false,
  pinned: true,
  defaultView: "thread",
  searchContent: false,
  includeNestedScopes: false,
};

const changedEvent = "sedes-tasks-panel-changed";

const scopeValues: readonly TasksPanelScopePreference[] = [
  "global",
  "project",
  "thread",
];
let cachedSnapshot: TasksPanelPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === TASKS_PANEL_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

function pickScope(
  value: unknown,
  fallback: TasksPanelScopePreference,
): TasksPanelScopePreference {
  return typeof value === "string" &&
    (scopeValues as readonly string[]).includes(value)
    ? (value as TasksPanelScopePreference)
    : fallback;
}

function parsePreferences(raw: string): TasksPanelPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return TASKS_PANEL_DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return TASKS_PANEL_DEFAULTS;
  }
  const blob = parsed as Record<string, unknown>;
  if (blob.version !== TASKS_PANEL_DEFAULTS.version) {
    return TASKS_PANEL_DEFAULTS;
  }
  // A stale `addTo` key from earlier builds is ignored: the composer now
  // always adds to the scope in view.
  return {
    version: TASKS_PANEL_DEFAULTS.version,
    open:
      typeof blob.open === "boolean" ? blob.open : TASKS_PANEL_DEFAULTS.open,
    pinned:
      typeof blob.pinned === "boolean"
        ? blob.pinned
        : TASKS_PANEL_DEFAULTS.pinned,
    defaultView: pickScope(blob.defaultView, TASKS_PANEL_DEFAULTS.defaultView),
    searchContent:
      typeof blob.searchContent === "boolean"
        ? blob.searchContent
        : TASKS_PANEL_DEFAULTS.searchContent,
    includeNestedScopes:
      typeof blob.includeNestedScopes === "boolean"
        ? blob.includeNestedScopes
        : TASKS_PANEL_DEFAULTS.includeNestedScopes,
  };
}

function readPreferences(): TasksPanelPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TASKS_PANEL_STORAGE_KEY);
  } catch {
    return TASKS_PANEL_DEFAULTS;
  }
  if (raw === null) return TASKS_PANEL_DEFAULTS;
  return parsePreferences(raw);
}

export function getTasksPanelPreferences(): TasksPanelPreferences {
  if (typeof window === "undefined") return TASKS_PANEL_DEFAULTS;
  if (cachedSnapshot === null) cachedSnapshot = readPreferences();
  return cachedSnapshot;
}

function persist(next: TasksPanelPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TASKS_PANEL_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the value for this session only.
  }
  cachedSnapshot = next;
  window.dispatchEvent(new Event(changedEvent));
}

export function setTasksPanelOpen(open: boolean): void {
  persist({ ...getTasksPanelPreferences(), open });
}

export function setTasksPanelPinned(pinned: boolean): void {
  persist({ ...getTasksPanelPreferences(), pinned });
}

export function setTasksPanelDefaultView(
  defaultView: TasksPanelScopePreference,
): void {
  persist({ ...getTasksPanelPreferences(), defaultView });
}

export function setTasksPanelSearchContent(searchContent: boolean): void {
  persist({ ...getTasksPanelPreferences(), searchContent });
}

export function setTasksPanelIncludeNestedScopes(
  includeNestedScopes: boolean,
): void {
  persist({ ...getTasksPanelPreferences(), includeNestedScopes });
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
