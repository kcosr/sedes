import { useSyncExternalStore } from "react";
import {
  AUTOMATIONS_GROUPINGS,
  automationGroupCollapsedByDefault,
  type AutomationsGroupBy,
} from "./automation-list.js";

/**
 * Viewer-local Automations page view: its grouping and which groups are
 * collapsed. The groups are the page's filter, so a collapsed group stays
 * collapsed across visits. The sidebar Scope is shared with the sidebar
 * instead.
 */
export const AUTOMATIONS_VIEW_STORAGE_KEY = "sedes.automations.view";

export interface AutomationsViewPreferences {
  readonly version: 1;
  readonly groupBy: AutomationsGroupBy;
  /** Explicit choices by group key; other groups use their default. */
  readonly collapsed: Readonly<Record<string, boolean>>;
}

export const AUTOMATIONS_VIEW_DEFAULTS: AutomationsViewPreferences = {
  version: 1,
  groupBy: "status",
  collapsed: {},
};

const changedEvent = "sedes-automations-view-changed";

/** Stable snapshot for useSyncExternalStore until a write or a storage event. */
let cachedSnapshot: AutomationsViewPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === AUTOMATIONS_VIEW_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

export function parseAutomationsViewPreferences(
  raw: string | null,
): AutomationsViewPreferences {
  if (raw === null) return AUTOMATIONS_VIEW_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return AUTOMATIONS_VIEW_DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return AUTOMATIONS_VIEW_DEFAULTS;
  }
  const blob = parsed as Record<string, unknown>;
  if (blob.version !== AUTOMATIONS_VIEW_DEFAULTS.version) {
    return AUTOMATIONS_VIEW_DEFAULTS;
  }
  const collapsed =
    typeof blob.collapsed === "object" &&
    blob.collapsed !== null &&
    !Array.isArray(blob.collapsed)
      ? Object.fromEntries(
          Object.entries(blob.collapsed).filter(
            (entry): entry is [string, boolean] =>
              typeof entry[1] === "boolean",
          ),
        )
      : {};
  return {
    version: AUTOMATIONS_VIEW_DEFAULTS.version,
    groupBy:
      typeof blob.groupBy === "string" &&
      (AUTOMATIONS_GROUPINGS as readonly string[]).includes(blob.groupBy)
        ? (blob.groupBy as AutomationsGroupBy)
        : AUTOMATIONS_VIEW_DEFAULTS.groupBy,
    collapsed,
  };
}

export function getAutomationsViewPreferences(): AutomationsViewPreferences {
  if (typeof window === "undefined") return AUTOMATIONS_VIEW_DEFAULTS;
  if (cachedSnapshot === null) {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(AUTOMATIONS_VIEW_STORAGE_KEY);
    } catch {
      raw = null;
    }
    cachedSnapshot = parseAutomationsViewPreferences(raw);
  }
  return cachedSnapshot;
}

function persist(next: AutomationsViewPreferences): void {
  if (typeof window === "undefined") return;
  cachedSnapshot = next;
  try {
    window.localStorage.setItem(
      AUTOMATIONS_VIEW_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Storage unavailable: keep the choice for this session.
  }
  window.dispatchEvent(new Event(changedEvent));
}

export function setAutomationsGroupBy(groupBy: AutomationsGroupBy): void {
  const current = getAutomationsViewPreferences();
  if (current.groupBy !== groupBy) persist({ ...current, groupBy });
}

/** Whether a group is collapsed: the viewer's choice, else its default. */
export function automationGroupCollapsed(
  preferences: AutomationsViewPreferences,
  key: string,
): boolean {
  return preferences.collapsed[key] ?? automationGroupCollapsedByDefault(key);
}

export function setAutomationGroupCollapsed(
  key: string,
  collapsed: boolean,
): void {
  const current = getAutomationsViewPreferences();
  if (automationGroupCollapsed(current, key) === collapsed) return;
  persist({ ...current, collapsed: { ...current.collapsed, [key]: collapsed } });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === AUTOMATIONS_VIEW_STORAGE_KEY) {
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

export function useAutomationsViewPreferences(): AutomationsViewPreferences {
  return useSyncExternalStore(
    subscribe,
    getAutomationsViewPreferences,
    () => AUTOMATIONS_VIEW_DEFAULTS,
  );
}
