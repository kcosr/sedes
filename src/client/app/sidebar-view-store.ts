import { useSyncExternalStore } from "react";
import { applicationEventIdSchema } from "../../shared/index.js";
import type {
  SidebarDensity,
  SidebarGroupBy,
  SidebarInventoryScopePatch,
  SidebarModePreferences,
  SidebarModePreferencesByGroup,
  SidebarProjectFilterPublication,
  SidebarShowFilters,
  SidebarSortBy,
  SidebarSortDirection,
  SidebarStackBy,
  SidebarViewPreferences,
} from "./sidebar-view-model.js";
import {
  resolveModePreferences,
  SIDEBAR_VIEW_DEFAULTS,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "./sidebar-view-model.js";

const changedEvent = "sedes-sidebar-view-changed";
/** Pre-blob key, migrated on first read. Kept as a literal so retiring sidebar-grouping.ts cannot break the migration. */
const legacyGroupForksKey = "sedes.sidebar.groupForks";

const groupByValues: readonly SidebarGroupBy[] = [
  "project",
  "time",
  "state",
  "none",
];
const altGroupByValues: readonly Exclude<SidebarGroupBy, "project">[] = [
  "time",
  "state",
  "none",
];
const stackByValues: readonly SidebarStackBy[] = ["none", "group", "project"];
const sortByValues: readonly SidebarSortBy[] = [
  "activity",
  "alpha",
  "stateChanged",
];
const directionValues: readonly SidebarSortDirection[] = ["asc", "desc"];
const densityValues: readonly SidebarDensity[] = ["compact", "card"];
type MutableModes = {
  -readonly [Group in SidebarGroupBy]?: Partial<
    SidebarModePreferencesByGroup[Group]
  >;
};

/**
 * useSyncExternalStore compares snapshots by identity, so the object snapshot
 * must keep the same reference until it can actually have changed: a local
 * write, or a storage event from another tab.
 */
let cachedSnapshot: SidebarViewPreferences | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === SIDEBAR_VIEW_STORAGE_KEY) {
      cachedSnapshot = null;
    }
  });
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function parseFlatModeEntry(value: unknown): Partial<SidebarModePreferences> {
  if (typeof value !== "object" || value === null) return {};
  const entry = value as Record<string, unknown>;
  const parsed: {
    sortBy?: SidebarSortBy;
    direction?: SidebarSortDirection;
    density?: SidebarDensity;
    peek?: boolean;
    pinnedOnly?: boolean;
  } = {};
  const sortBy = pickOptionalEnum(entry.sortBy, sortByValues);
  if (sortBy !== undefined) parsed.sortBy = sortBy;
  const direction = pickOptionalEnum(entry.direction, directionValues);
  if (direction !== undefined) parsed.direction = direction;
  const density = pickOptionalEnum(entry.density, densityValues);
  if (density !== undefined) parsed.density = density;
  if (typeof entry.peek === "boolean") parsed.peek = entry.peek;
  if (typeof entry.pinnedOnly === "boolean") {
    parsed.pinnedOnly = entry.pinnedOnly;
  }
  return parsed;
}

function parseProjectModeEntry(
  value: unknown,
): Partial<SidebarModePreferencesByGroup["project"]> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const sortBy = pickOptionalEnum(raw.sortBy, sortByValues);
  const direction = pickOptionalEnum(raw.direction, directionValues);
  return {
    ...(sortBy ? { sortBy } : {}),
    ...(direction ? { direction } : {}),
  };
}

function parseModes(value: unknown): SidebarViewPreferences["modes"] {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const modes: MutableModes = {};
  for (const groupBy of groupByValues) {
    if (groupBy === "project") {
      const entry = parseProjectModeEntry(raw[groupBy]);
      if (Object.keys(entry).length > 0) modes.project = entry;
      continue;
    }
    const entry = parseFlatModeEntry(raw[groupBy]);
    if (Object.keys(entry).length > 0) modes[groupBy] = entry;
  }
  return modes;
}

function parseShow(value: unknown): SidebarShowFilters {
  const raw: Record<string, unknown> =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    snoozed:
      typeof raw.snoozed === "boolean"
        ? raw.snoozed
        : SIDEBAR_VIEW_DEFAULTS.show.snoozed,
    settled:
      typeof raw.settled === "boolean"
        ? raw.settled
        : SIDEBAR_VIEW_DEFAULTS.show.settled,
    drafts:
      typeof raw.drafts === "boolean"
        ? raw.drafts
        : SIDEBAR_VIEW_DEFAULTS.show.drafts,
  };
}

function parseFilterId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    ? value
    : null;
}

function parsePreferences(raw: string): SidebarViewPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return SIDEBAR_VIEW_DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return SIDEBAR_VIEW_DEFAULTS;
  }
  const blob = parsed as Record<string, unknown>;
  if (blob.version !== SIDEBAR_VIEW_DEFAULTS.version) {
    return SIDEBAR_VIEW_DEFAULTS;
  }
  const projectFilterName = parseFilterId(blob.projectFilterName);
  const projectFilterPublication = (() => {
    if (
      projectFilterName === null ||
      typeof blob.projectFilterPublication !== "object" ||
      blob.projectFilterPublication === null
    ) {
      return null;
    }
    const publication = blob.projectFilterPublication as Record<
      string,
      unknown
    >;
    const eventId = applicationEventIdSchema.safeParse(publication.eventId);
    return publication.projectName === projectFilterName &&
      eventId.success
      ? { projectName: projectFilterName, eventId: eventId.data }
      : null;
  })();
  return {
    version: SIDEBAR_VIEW_DEFAULTS.version,
    environmentFilterId: parseFilterId(blob.environmentFilterId),
    targetFilterId: parseFilterId(blob.targetFilterId),
    projectFilterName,
    projectFilterPublication,
    groupFilterId: parseFilterId(blob.groupFilterId),
    ungroupedFilter:
      typeof blob.ungroupedFilter === "boolean" ? blob.ungroupedFilter : false,
    scopeCollapsed:
      typeof blob.scopeCollapsed === "boolean"
        ? blob.scopeCollapsed
        : SIDEBAR_VIEW_DEFAULTS.scopeCollapsed,
    groupBy: pickEnum(
      blob.groupBy,
      groupByValues,
      SIDEBAR_VIEW_DEFAULTS.groupBy,
    ),
    stackBy: pickEnum(
      blob.stackBy,
      stackByValues,
      SIDEBAR_VIEW_DEFAULTS.stackBy,
    ),
    lastAltGroupBy: pickEnum(
      blob.lastAltGroupBy,
      altGroupByValues,
      SIDEBAR_VIEW_DEFAULTS.lastAltGroupBy,
    ),
    modes: parseModes(blob.modes),
    show: parseShow(blob.show),
    groupForks:
      typeof blob.groupForks === "boolean"
        ? blob.groupForks
        : SIDEBAR_VIEW_DEFAULTS.groupForks,
    showBackendIcons:
      typeof blob.showBackendIcons === "boolean"
        ? blob.showBackendIcons
        : SIDEBAR_VIEW_DEFAULTS.showBackendIcons,
  };
}

function migrateLegacyGroupForks(): SidebarViewPreferences {
  let legacy: string | null;
  try {
    legacy = window.localStorage.getItem(legacyGroupForksKey);
  } catch {
    return SIDEBAR_VIEW_DEFAULTS;
  }
  if (legacy === null) return SIDEBAR_VIEW_DEFAULTS;
  const migrated: SidebarViewPreferences = {
    ...SIDEBAR_VIEW_DEFAULTS,
    groupForks: legacy !== "false",
  };
  try {
    window.localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify(migrated),
    );
    window.localStorage.removeItem(legacyGroupForksKey);
  } catch {
    // Storage unavailable: keep the migrated value for this session.
  }
  return migrated;
}

function readPreferences(): SidebarViewPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
  } catch {
    return SIDEBAR_VIEW_DEFAULTS;
  }
  if (raw === null) return migrateLegacyGroupForks();
  return parsePreferences(raw);
}

export function getSidebarViewPreferences(): SidebarViewPreferences {
  if (typeof window === "undefined") return SIDEBAR_VIEW_DEFAULTS;
  if (cachedSnapshot === null) cachedSnapshot = readPreferences();
  return cachedSnapshot;
}

function persist(next: SidebarViewPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  cachedSnapshot = next;
  window.dispatchEvent(new Event(changedEvent));
}

export function setSidebarGroupBy(groupBy: SidebarGroupBy): void {
  const current = getSidebarViewPreferences();
  persist({
    ...current,
    groupBy,
    lastAltGroupBy: groupBy === "project" ? current.lastAltGroupBy : groupBy,
  });
}

export function setSidebarStackBy(stackBy: SidebarStackBy): void {
  const current = getSidebarViewPreferences();
  if (current.stackBy === stackBy) return;
  persist({ ...current, stackBy });
}

export function setSidebarProjectFilterName(
  projectName: string | null,
): void {
  setSidebarInventoryScope({ projectFilterName: projectName });
}

export function setSidebarEnvironmentFilterId(
  environmentId: string | null,
): void {
  setSidebarInventoryScope({ environmentFilterId: environmentId });
}

export function setSidebarTargetFilterId(targetId: string | null): void {
  setSidebarInventoryScope({ targetFilterId: targetId });
}

/** Persist any compatible scope transition in one write and one render. */
export function setSidebarInventoryScope(
  patch: SidebarInventoryScopePatch,
  options: {
    readonly projectFilterPublication?: SidebarProjectFilterPublication;
  } = {},
): void {
  const current = getSidebarViewPreferences();
  const next = {
    environmentFilterId:
      patch.environmentFilterId === undefined
        ? current.environmentFilterId
        : parseFilterId(patch.environmentFilterId),
    targetFilterId:
      patch.targetFilterId === undefined
        ? current.targetFilterId
        : parseFilterId(patch.targetFilterId),
    projectFilterName:
      patch.projectFilterName === undefined
        ? current.projectFilterName
        : parseFilterId(patch.projectFilterName),
    groupFilterId:
      patch.groupFilterId === undefined
        ? current.groupFilterId
        : parseFilterId(patch.groupFilterId),
    ungroupedFilter:
      patch.ungroupedFilter === undefined
        ? current.ungroupedFilter
        : patch.ungroupedFilter,
  };
  if (next.groupFilterId !== null) next.ungroupedFilter = false;
  if (next.ungroupedFilter) next.groupFilterId = null;
  const projectFilterPublication =
    patch.projectFilterName === undefined
      ? current.projectFilterPublication
      : options.projectFilterPublication?.projectName ===
          next.projectFilterName
        ? options.projectFilterPublication
        : null;
  if (
    next.environmentFilterId === current.environmentFilterId &&
    next.targetFilterId === current.targetFilterId &&
    next.projectFilterName === current.projectFilterName &&
    next.groupFilterId === current.groupFilterId &&
    next.ungroupedFilter === current.ungroupedFilter &&
    JSON.stringify(projectFilterPublication) ===
      JSON.stringify(current.projectFilterPublication)
  ) {
    return;
  }
  persist({ ...current, ...next, projectFilterPublication });
}

/** Whether the current sidebar view is narrower than its unfiltered state. */
export function hasActiveSidebarFilters(
  preferences: SidebarViewPreferences = getSidebarViewPreferences(),
): boolean {
  const scopeActive =
    preferences.environmentFilterId !== null ||
    preferences.targetFilterId !== null ||
    preferences.projectFilterName !== null ||
    preferences.groupFilterId !== null ||
    preferences.ungroupedFilter;
  const showActive =
    preferences.show.snoozed !== SIDEBAR_VIEW_DEFAULTS.show.snoozed ||
    preferences.show.settled !== SIDEBAR_VIEW_DEFAULTS.show.settled ||
    preferences.show.drafts !== SIDEBAR_VIEW_DEFAULTS.show.drafts;
  const pinnedOnlyActive =
    preferences.groupBy !== "project" &&
    resolveModePreferences(preferences, preferences.groupBy).pinnedOnly;
  return scopeActive || showActive || pinnedOnlyActive;
}

/** Clear every filter active in the current sidebar view in one write. */
export function clearActiveSidebarFilters(): void {
  const current = getSidebarViewPreferences();
  if (!hasActiveSidebarFilters(current)) return;
  const modes: MutableModes = { ...current.modes };
  if (current.groupBy !== "project") {
    const entry = current.modes[current.groupBy];
    if (entry?.pinnedOnly === true) {
      const { pinnedOnly: _pinnedOnly, ...rest } = entry;
      if (Object.keys(rest).length === 0) delete modes[current.groupBy];
      else modes[current.groupBy] = rest;
    }
  }
  persist({
    ...current,
    environmentFilterId: null,
    targetFilterId: null,
    projectFilterName: null,
    groupFilterId: null,
    ungroupedFilter: false,
    show: SIDEBAR_VIEW_DEFAULTS.show,
    modes,
  });
}

export function setSidebarScopeCollapsed(value: boolean): void {
  const current = getSidebarViewPreferences();
  if (current.scopeCollapsed === value) return;
  persist({ ...current, scopeCollapsed: value });
}

export function updateSidebarModePreferences<Group extends SidebarGroupBy>(
  groupBy: Group,
  patch: Partial<SidebarModePreferencesByGroup[Group]>,
): void {
  const current = getSidebarViewPreferences();
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<SidebarModePreferencesByGroup[Group]>;
  const modes: MutableModes = { ...current.modes };
  if (groupBy === "project") {
    modes.project = {
      ...current.modes.project,
      ...(defined as Partial<SidebarModePreferencesByGroup["project"]>),
    };
  } else {
    modes[groupBy] = {
      ...current.modes[groupBy],
      ...(defined as Partial<SidebarModePreferences>),
    };
  }
  persist({
    ...current,
    modes,
  });
}

export function resetSidebarMode(groupBy: SidebarGroupBy): void {
  const current = getSidebarViewPreferences();
  if (!(groupBy in current.modes)) return;
  const modes = { ...current.modes };
  delete modes[groupBy];
  persist({ ...current, modes });
}

export function setSidebarShowFilter(
  key: keyof SidebarShowFilters,
  value: boolean,
): void {
  const current = getSidebarViewPreferences();
  persist({ ...current, show: { ...current.show, [key]: value } });
}

export function setSidebarGroupForks(value: boolean): void {
  const current = getSidebarViewPreferences();
  persist({ ...current, groupForks: value });
}

export function setSidebarShowBackendIcons(value: boolean): void {
  const current = getSidebarViewPreferences();
  persist({ ...current, showBackendIcons: value });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SIDEBAR_VIEW_STORAGE_KEY) {
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

export function useSidebarViewPreferences(): SidebarViewPreferences {
  return useSyncExternalStore(
    subscribe,
    getSidebarViewPreferences,
    () => SIDEBAR_VIEW_DEFAULTS,
  );
}
