import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";

/**
 * Shared presentation contract for sidebar views. The store, projectors,
 * row/peek components, and controls depend on this module and shared protocol
 * types instead of each other. User-visible behavior is documented in
 * docs/user/organize-work.md#choose-a-sidebar-organization.
 */

export type SidebarGroupBy = "project" | "time" | "state" | "none";
export type SidebarStackBy = "none" | "group" | "project";
export type SidebarSortBy = "activity" | "alpha" | "stateChanged";
export type SidebarSortDirection = "asc" | "desc";
export type SidebarDensity = "compact" | "card";

export interface SidebarSortPreferences {
  readonly sortBy: SidebarSortBy;
  readonly direction: SidebarSortDirection;
}

export interface SidebarModePreferences extends SidebarSortPreferences {
  readonly density: SidebarDensity;
  /** Show the hover peek pop-out for rows in this mode. */
  readonly peek: boolean;
  /** Restrict this non-project view to pinned threads. */
  readonly pinnedOnly: boolean;
}

export interface SidebarModePreferencesByGroup {
  readonly project: SidebarSortPreferences;
  readonly time: SidebarModePreferences;
  readonly state: SidebarModePreferences;
  readonly none: SidebarModePreferences;
}

/** Global across group modes: what data the user cares about, not view shape. */
export interface SidebarShowFilters {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly drafts: boolean;
}

export interface SidebarProjectFilterPublication {
  readonly projectName: string;
  readonly eventId: string;
}

export interface SidebarViewPreferences {
  readonly version: 2;
  /** Viewer-local execution-environment scope; `null` means all. */
  readonly environmentFilterId: string | null;
  /** Viewer-local exact execution-target scope; `null` means all. */
  readonly targetFilterId: string | null;
  /**
   * Viewer-local exact project-name filter shared by every sidebar grouping mode.
   * `null` is the explicit "All projects" state.
   */
  readonly projectFilterName: string | null;
  /** Causal application event that first published a newly opened project. */
  readonly projectFilterPublication: SidebarProjectFilterPublication | null;
  /** Viewer-local persistent group filter; mutually exclusive with ungrouped. */
  readonly groupFilterId: string | null;
  readonly ungroupedFilter: boolean;
  /** Collapse the tall Environment / Target / Project scope controls. */
  readonly scopeCollapsed: boolean;
  readonly groupBy: SidebarGroupBy;
  /** Optional row collapsing composed after the selected organization mode. */
  readonly stackBy: SidebarStackBy;
  /** The non-project mode the quick toggle flips back to. */
  readonly lastAltGroupBy: Exclude<SidebarGroupBy, "project">;
  /** Sparse: only modes the user changed from SIDEBAR_MODE_DEFAULTS. */
  readonly modes: {
    readonly [Group in SidebarGroupBy]?: Partial<
      SidebarModePreferencesByGroup[Group]
    >;
  };
  readonly show: SidebarShowFilters;
  /** Nest fork families under their root. Honored only when groupBy is "project". */
  readonly groupForks: boolean;
  /** Render each row's backend brand mark (from the normalized summary). */
  readonly showBackendIcons: boolean;
}

export type SidebarInventoryScopePatch = Partial<
  Pick<
    SidebarViewPreferences,
    | "environmentFilterId"
    | "targetFilterId"
    | "projectFilterName"
    | "groupFilterId"
    | "ungroupedFilter"
  >
>;

export const SIDEBAR_VIEW_STORAGE_KEY = "sedes.sidebar.view";

export const SIDEBAR_MODE_DEFAULTS: SidebarModePreferencesByGroup = {
  project: { sortBy: "activity", direction: "desc" },
  time: {
    sortBy: "activity",
    direction: "desc",
    density: "compact",
    peek: true,
    pinnedOnly: false,
  },
  state: {
    sortBy: "stateChanged",
    direction: "desc",
    density: "compact",
    peek: true,
    pinnedOnly: false,
  },
  none: {
    sortBy: "activity",
    direction: "desc",
    density: "compact",
    peek: true,
    pinnedOnly: false,
  },
};

export const SIDEBAR_VIEW_DEFAULTS: SidebarViewPreferences = {
  version: 2,
  environmentFilterId: null,
  targetFilterId: null,
  projectFilterName: null,
  projectFilterPublication: null,
  groupFilterId: null,
  ungroupedFilter: false,
  scopeCollapsed: false,
  groupBy: "time",
  stackBy: "none",
  lastAltGroupBy: "time",
  modes: {},
  show: { snoozed: true, settled: true, drafts: true },
  groupForks: true,
  showBackendIcons: true,
};

/** Merge a mode's sparse overrides over its defaults. */
export function resolveModePreferences<Group extends SidebarGroupBy>(
  preferences: SidebarViewPreferences,
  groupBy: Group,
): SidebarModePreferencesByGroup[Group] {
  return { ...SIDEBAR_MODE_DEFAULTS[groupBy], ...preferences.modes[groupBy] };
}

/**
 * The timestamp that places a thread in recency ordering and time buckets.
 * Inventory transitions (snooze/settle/archive/restore) bump stateChangedAt
 * only, so lastActivityAt alone would strand freshly transitioned threads.
 */
export function sidebarEffectiveTimestamp(
  thread: NormalizedApplicationThreadSummary,
): number {
  const activity = Date.parse(thread.lastActivityAt);
  const stateChanged = Date.parse(thread.stateChangedAt);
  if (Number.isNaN(activity))
    return Number.isNaN(stateChanged) ? 0 : stateChanged;
  if (Number.isNaN(stateChanged)) return activity;
  return Math.max(activity, stateChanged);
}

/** Output of the flat (time / state / none) projectors. */
export type SidebarFlatGroupKind =
  "pinned" | "upcoming" | "time" | "state" | "settled" | "all";

export interface SidebarFlatGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: SidebarFlatGroupKind;
  /**
   * When true, rows render their trailing timestamp future-absolute (wake /
   * next-run time) instead of past-relative.
   */
  readonly futureTimes: boolean;
  readonly threads: readonly NormalizedApplicationThreadSummary[];
}
