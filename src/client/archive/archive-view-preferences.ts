import { useSyncExternalStore } from "react";
import {
  ARCHIVE_GROUPINGS,
  ARCHIVE_SORTS,
  type ArchiveGroupBy,
  type ArchiveSort,
} from "./archived-threads.js";

/**
 * Viewer-local archive page view: its sort and grouping. Kept apart from the
 * sidebar view blob because the archive page has its own axes; the sidebar
 * Scope and search are shared with the sidebar instead.
 */
export const ARCHIVE_VIEW_STORAGE_KEY = "sedes.archive.view";

export interface ArchiveViewPreferences {
  readonly version: 1;
  readonly sort: ArchiveSort;
  readonly groupBy: ArchiveGroupBy;
}

export const ARCHIVE_VIEW_DEFAULTS: ArchiveViewPreferences = {
  version: 1,
  sort: "archived",
  groupBy: "date",
};

const changedEvent = "sedes-archive-view-changed";

/** Stable snapshot for useSyncExternalStore until a write or a storage event. */
let cachedSnapshot: ArchiveViewPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === ARCHIVE_VIEW_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

function pick<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : fallback;
}

export function parseArchiveViewPreferences(
  raw: string | null,
): ArchiveViewPreferences {
  if (raw === null) return ARCHIVE_VIEW_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ARCHIVE_VIEW_DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return ARCHIVE_VIEW_DEFAULTS;
  }
  const blob = parsed as Record<string, unknown>;
  if (blob.version !== ARCHIVE_VIEW_DEFAULTS.version) {
    return ARCHIVE_VIEW_DEFAULTS;
  }
  return {
    version: ARCHIVE_VIEW_DEFAULTS.version,
    sort: pick(blob.sort, ARCHIVE_SORTS, ARCHIVE_VIEW_DEFAULTS.sort),
    groupBy: pick(
      blob.groupBy,
      ARCHIVE_GROUPINGS,
      ARCHIVE_VIEW_DEFAULTS.groupBy,
    ),
  };
}

export function getArchiveViewPreferences(): ArchiveViewPreferences {
  if (typeof window === "undefined") return ARCHIVE_VIEW_DEFAULTS;
  if (cachedSnapshot === null) {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(ARCHIVE_VIEW_STORAGE_KEY);
    } catch {
      raw = null;
    }
    cachedSnapshot = parseArchiveViewPreferences(raw);
  }
  return cachedSnapshot;
}

function persist(next: ArchiveViewPreferences): void {
  if (typeof window === "undefined") return;
  cachedSnapshot = next;
  try {
    window.localStorage.setItem(ARCHIVE_VIEW_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the choice for this session.
  }
  window.dispatchEvent(new Event(changedEvent));
}

export function setArchiveSort(sort: ArchiveSort): void {
  const current = getArchiveViewPreferences();
  if (current.sort !== sort) persist({ ...current, sort });
}

export function setArchiveGroupBy(groupBy: ArchiveGroupBy): void {
  const current = getArchiveViewPreferences();
  if (current.groupBy !== groupBy) persist({ ...current, groupBy });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ARCHIVE_VIEW_STORAGE_KEY) {
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

export function useArchiveViewPreferences(): ArchiveViewPreferences {
  return useSyncExternalStore(
    subscribe,
    getArchiveViewPreferences,
    () => ARCHIVE_VIEW_DEFAULTS,
  );
}
