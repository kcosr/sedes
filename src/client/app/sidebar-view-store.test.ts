// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveModePreferences,
  SIDEBAR_VIEW_DEFAULTS,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "./sidebar-view-model.js";
import {
  clearActiveSidebarFilters,
  getSidebarViewPreferences,
  hasActiveSidebarFilters,
  resetSidebarMode,
  setSidebarEnvironmentFilterId,
  setSidebarGroupBy,
  setSidebarGroupForks,
  setSidebarInventoryScope,
  setSidebarProjectFilterName,
  setSidebarScopeCollapsed,
  setSidebarShowBackendIcons,
  setSidebarShowFilter,
  setSidebarStackBy,
  setSidebarTargetFilterId,
  updateSidebarModePreferences,
} from "./sidebar-view-store.js";

const legacyKey = "sedes.sidebar.groupForks";
const changedEvent = "sedes-sidebar-view-changed";

// localStorage.clear() does not fire a storage event in the same window, so
// tests drop the cached snapshot by simulating the cross-tab event.
function invalidateSnapshot(): void {
  window.dispatchEvent(
    new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
  );
}

function readBlob(): unknown {
  const raw = localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  localStorage.clear();
  invalidateSnapshot();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sidebar view preferences read path", () => {
  it("returns defaults when nothing is stored, without writing a blob", () => {
    expect(getSidebarViewPreferences()).toEqual(SIDEBAR_VIEW_DEFAULTS);
    expect(getSidebarViewPreferences().groupBy).toBe("time");
    expect(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("returns defaults for malformed JSON", () => {
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, "{not json");
    invalidateSnapshot();
    expect(getSidebarViewPreferences()).toEqual(SIDEBAR_VIEW_DEFAULTS);
  });

  it("returns defaults for non-object blobs and unknown versions", () => {
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify("time"));
    invalidateSnapshot();
    expect(getSidebarViewPreferences()).toEqual(SIDEBAR_VIEW_DEFAULTS);

    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        version: 999,
        groupBy: "time",
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences()).toEqual(SIDEBAR_VIEW_DEFAULTS);
  });

  it("falls back per field on unknown enum values", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        groupBy: "galaxy",
        lastAltGroupBy: "state",
        modes: {
          time: { sortBy: "magic", density: "card", peek: false },
          bogus: { sortBy: "alpha" },
        },
        show: { snoozed: false, settled: false, drafts: "yes" },
        groupForks: "flat",
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences()).toEqual({
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
      lastAltGroupBy: "state",
      modes: { time: { density: "card", peek: false } },
      show: { snoozed: false, settled: false, drafts: true },
      groupForks: true,
      showBackendIcons: true,
    });
  });

  it("preserves pre-pinned-filter preferences and defaults pinned-only off", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        environmentFilterId: "environment-1",
        targetFilterId: "target-1",
        projectFilterName: "workspace-1",
        groupBy: "time",
        modes: {
          time: {
            sortBy: "alpha",
            direction: "asc",
            density: "card",
            peek: false,
          },
        },
        show: { snoozed: false, settled: false, drafts: false },
      }),
    );
    invalidateSnapshot();
    const preferences = getSidebarViewPreferences();
    expect(preferences).toMatchObject({
      version: 2,
      environmentFilterId: "environment-1",
      targetFilterId: "target-1",
      projectFilterName: "workspace-1",
      groupBy: "time",
      modes: {
        time: {
          sortBy: "alpha",
          direction: "asc",
          density: "card",
          peek: false,
        },
      },
      show: { snoozed: false, settled: false, drafts: false },
    });
    expect(resolveModePreferences(preferences, "time").pinnedOnly).toBe(false);
  });

  it("keeps persisted mode entries sparse", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        modes: { state: { density: "card" } },
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences().modes).toEqual({
      state: { density: "card" },
    });
  });

  it("restores Timeline with independent thread-group stacking", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        groupBy: "time",
        stackBy: "group",
        lastAltGroupBy: "time",
        modes: {
          time: {
            sortBy: "alpha",
            direction: "asc",
            density: "card",
            peek: false,
            pinnedOnly: true,
          },
        },
      }),
    );
    invalidateSnapshot();

    const preferences = getSidebarViewPreferences();
    expect(preferences).toMatchObject({
      groupBy: "time",
      stackBy: "group",
      lastAltGroupBy: "time",
      modes: {
        time: {
          sortBy: "alpha",
          direction: "asc",
          density: "card",
          peek: false,
          pinnedOnly: true,
        },
      },
    });
    expect(resolveModePreferences(preferences, "time")).toEqual({
      sortBy: "alpha",
      direction: "asc",
      density: "card",
      peek: false,
      pinnedOnly: true,
    });
  });

  it("drops flat-only fields from the Projects mode contract", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        modes: {
          project: {
            sortBy: "alpha",
            direction: "asc",
            density: "card",
            peek: false,
          },
        },
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences().modes.project).toEqual({
      sortBy: "alpha",
      direction: "asc",
    });
  });
});

describe("sidebar view preferences snapshot caching", () => {
  it("returns the identical reference across calls with no writes", () => {
    const first = getSidebarViewPreferences();
    expect(getSidebarViewPreferences()).toBe(first);
    expect(getSidebarViewPreferences()).toBe(first);
  });

  it("replaces the snapshot after a local write, then stays stable", () => {
    const before = getSidebarViewPreferences();
    setSidebarGroupBy("time");
    const after = getSidebarViewPreferences();
    expect(after).not.toBe(before);
    expect(getSidebarViewPreferences()).toBe(after);
  });

  it("ignores storage events for other keys", () => {
    const before = getSidebarViewPreferences();
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, groupBy: "state" }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(getSidebarViewPreferences()).toBe(before);
  });

  it("re-reads after a storage event for the blob key", () => {
    const before = getSidebarViewPreferences();
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, groupBy: "state" }),
    );
    invalidateSnapshot();
    const after = getSidebarViewPreferences();
    expect(after).not.toBe(before);
    expect(after.groupBy).toBe("state");
  });
});

describe("legacy groupForks migration", () => {
  it("seeds groupForks from a false legacy value and removes the key", () => {
    localStorage.setItem(legacyKey, "false");
    invalidateSnapshot();
    expect(getSidebarViewPreferences().groupForks).toBe(false);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(readBlob()).toEqual({ ...SIDEBAR_VIEW_DEFAULTS, groupForks: false });
  });

  it("seeds groupForks from a true legacy value and removes the key", () => {
    localStorage.setItem(legacyKey, "true");
    invalidateSnapshot();
    expect(getSidebarViewPreferences().groupForks).toBe(true);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(readBlob()).toEqual({ ...SIDEBAR_VIEW_DEFAULTS, groupForks: true });
  });

  it("does not migrate when the legacy key is absent", () => {
    expect(getSidebarViewPreferences()).toEqual(SIDEBAR_VIEW_DEFAULTS);
    expect(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("leaves the legacy key alone once a blob exists", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify(SIDEBAR_VIEW_DEFAULTS),
    );
    localStorage.setItem(legacyKey, "false");
    invalidateSnapshot();
    expect(getSidebarViewPreferences().groupForks).toBe(true);
    expect(localStorage.getItem(legacyKey)).toBe("false");
  });
});

describe("sidebar view preference mutations", () => {
  it("persists all three inventory facets atomically", () => {
    const listener = vi.fn();
    window.addEventListener(changedEvent, listener);
    setSidebarInventoryScope({
      environmentFilterId: "environment-2",
      targetFilterId: "target-2",
      projectFilterName: "workspace-2",
    });
    expect(getSidebarViewPreferences()).toMatchObject({
      environmentFilterId: "environment-2",
      targetFilterId: "target-2",
      projectFilterName: "workspace-2",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(changedEvent, listener);
  });

  it("persists a causal project publication and clears it on direct selection", () => {
    const publication = {
      projectName: "workspace-2",
      eventId: "00000000-0000-4000-8000-000000000001.7",
    };
    setSidebarInventoryScope(
      { projectFilterName: "workspace-2" },
      { projectFilterPublication: publication },
    );

    expect(getSidebarViewPreferences()).toMatchObject({
      projectFilterName: "workspace-2",
      projectFilterPublication: publication,
    });
    expect(readBlob()).toMatchObject({
      projectFilterName: "workspace-2",
      projectFilterPublication: publication,
    });

    setSidebarProjectFilterName("workspace-3");
    expect(getSidebarViewPreferences()).toMatchObject({
      projectFilterName: "workspace-3",
      projectFilterPublication: null,
    });
  });

  it("discards malformed or mismatched causal project publications", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        projectFilterName: "workspace-2",
        projectFilterPublication: {
          projectName: "another-workspace",
          eventId: "not-an-application-event",
        },
      }),
    );
    invalidateSnapshot();

    expect(getSidebarViewPreferences()).toMatchObject({
      projectFilterName: "workspace-2",
      projectFilterPublication: null,
    });
  });

  it("persists individual Environment and Target filter changes", () => {
    setSidebarEnvironmentFilterId("environment-2");
    setSidebarTargetFilterId("target-2");
    expect(getSidebarViewPreferences()).toMatchObject({
      environmentFilterId: "environment-2",
      targetFilterId: "target-2",
    });
    setSidebarEnvironmentFilterId(null);
    setSidebarTargetFilterId(null);
    expect(getSidebarViewPreferences()).toMatchObject({
      environmentFilterId: null,
      targetFilterId: null,
    });
  });

  it("persists whether the inventory scope controls are collapsed", () => {
    setSidebarScopeCollapsed(true);
    expect(getSidebarViewPreferences().scopeCollapsed).toBe(true);
    expect(readBlob()).toMatchObject({ scopeCollapsed: true });
    setSidebarScopeCollapsed(false);
    expect(getSidebarViewPreferences().scopeCollapsed).toBe(false);
  });

  it("persists and clears the project filter independently of the view mode", () => {
    setSidebarProjectFilterName("workspace-2");
    setSidebarGroupBy("time");

    expect(getSidebarViewPreferences()).toMatchObject({
      projectFilterName: "workspace-2",
      groupBy: "time",
    });
    expect(readBlob()).toMatchObject({
      projectFilterName: "workspace-2",
    });

    setSidebarProjectFilterName(null);
    expect(getSidebarViewPreferences().projectFilterName).toBeNull();
  });

  it("normalizes invalid project filter values to All projects", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        projectFilterName: 42,
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences().projectFilterName).toBeNull();

    setSidebarProjectFilterName("");
    expect(getSidebarViewPreferences().projectFilterName).toBeNull();
  });

  it("normalizes invalid environment and target IDs and defaults omitted fields", () => {
    const {
      environmentFilterId: _environment,
      targetFilterId: _target,
      scopeCollapsed: _collapsed,
      ...olderPreferences
    } = SIDEBAR_VIEW_DEFAULTS;
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...olderPreferences,
        environmentFilterId: 42,
        targetFilterId: "",
      }),
    );
    invalidateSnapshot();
    expect(getSidebarViewPreferences()).toMatchObject({
      environmentFilterId: null,
      targetFilterId: null,
      scopeCollapsed: false,
    });
  });

  it("setSidebarGroupBy tracks lastAltGroupBy for non-project modes only", () => {
    setSidebarGroupBy("state");
    expect(getSidebarViewPreferences().groupBy).toBe("state");
    expect(getSidebarViewPreferences().lastAltGroupBy).toBe("state");

    setSidebarGroupBy("project");
    expect(getSidebarViewPreferences().groupBy).toBe("project");
    expect(getSidebarViewPreferences().lastAltGroupBy).toBe("state");
    expect(readBlob()).toMatchObject({
      groupBy: "project",
      lastAltGroupBy: "state",
    });
  });

  it("defaults showBackendIcons on, including for blobs written before the field existed", () => {
    expect(getSidebarViewPreferences().showBackendIcons).toBe(true);

    const { showBackendIcons: _omitted, ...legacyBlob } = SIDEBAR_VIEW_DEFAULTS;
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify(legacyBlob));
    invalidateSnapshot();
    expect(getSidebarViewPreferences().showBackendIcons).toBe(true);
  });

  it("setSidebarShowBackendIcons persists the toggle", () => {
    setSidebarShowBackendIcons(false);
    expect(getSidebarViewPreferences().showBackendIcons).toBe(false);
    expect(readBlob()).toMatchObject({ showBackendIcons: false });

    setSidebarShowBackendIcons(true);
    expect(getSidebarViewPreferences().showBackendIcons).toBe(true);
    expect(readBlob()).toMatchObject({ showBackendIcons: true });
  });

  it("dispatches the same-tab change event on writes", () => {
    const listener = vi.fn();
    window.addEventListener(changedEvent, listener);
    setSidebarGroupForks(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(changedEvent, listener);
  });

  it("updateSidebarModePreferences merges into the sparse entry", () => {
    updateSidebarModePreferences("time", { density: "card" });
    updateSidebarModePreferences("time", { sortBy: "alpha" });
    updateSidebarModePreferences("time", { pinnedOnly: true });
    const preferences = getSidebarViewPreferences();
    expect(preferences.modes.time).toEqual({
      density: "card",
      sortBy: "alpha",
      pinnedOnly: true,
    });
    expect(preferences.modes.state).toBeUndefined();
    expect(readBlob()).toMatchObject({
      modes: {
        time: { density: "card", sortBy: "alpha", pinnedOnly: true },
      },
    });
  });

  it("persists project stacking without changing the organization mode", () => {
    setSidebarGroupBy("time");
    setSidebarStackBy("project");
    expect(getSidebarViewPreferences()).toMatchObject({
      groupBy: "time",
      stackBy: "project",
      lastAltGroupBy: "time",
    });
  });

  it("resetSidebarMode removes only that mode's entry", () => {
    updateSidebarModePreferences("time", { density: "card" });
    updateSidebarModePreferences("state", { peek: false });
    resetSidebarMode("time");
    const preferences = getSidebarViewPreferences();
    expect(preferences.modes.time).toBeUndefined();
    expect(preferences.modes.state).toEqual({ peek: false });
  });

  it("resetSidebarMode without an entry writes nothing", () => {
    const listener = vi.fn();
    window.addEventListener(changedEvent, listener);
    resetSidebarMode("none");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(changedEvent, listener);
  });

  it("setSidebarShowFilter updates one filter and keeps the others", () => {
    setSidebarShowFilter("settled", false);
    expect(getSidebarViewPreferences().show).toEqual({
      snoozed: true,
      settled: false,
      drafts: true,
    });
  });

  it("detects and clears every filter active in the current view", () => {
    expect(hasActiveSidebarFilters()).toBe(false);
    setSidebarInventoryScope({
      environmentFilterId: "environment-2",
      targetFilterId: "target-2",
      projectFilterName: "workspace-2",
      groupFilterId: "group-2",
    });
    setSidebarShowFilter("snoozed", false);
    setSidebarShowFilter("settled", false);
    setSidebarGroupBy("time");
    updateSidebarModePreferences("time", {
      density: "card",
      pinnedOnly: true,
    });
    updateSidebarModePreferences("state", { pinnedOnly: true });
    expect(hasActiveSidebarFilters()).toBe(true);

    clearActiveSidebarFilters();

    const preferences = getSidebarViewPreferences();
    expect(hasActiveSidebarFilters(preferences)).toBe(false);
    expect(preferences).toMatchObject({
      environmentFilterId: null,
      targetFilterId: null,
      projectFilterName: null,
      groupFilterId: null,
      ungroupedFilter: false,
      groupBy: "time",
      show: SIDEBAR_VIEW_DEFAULTS.show,
      modes: {
        time: { density: "card" },
        state: { pinnedOnly: true },
      },
    });
  });

  it("setSidebarGroupForks persists the flag", () => {
    setSidebarGroupForks(false);
    expect(getSidebarViewPreferences().groupForks).toBe(false);
    expect(readBlob()).toMatchObject({ groupForks: false });
  });
});
