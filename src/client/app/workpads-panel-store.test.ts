// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKPADS_PANEL_DEFAULTS,
  WORKPADS_PANEL_STORAGE_KEY,
  getWorkpadsPanelPreferences,
  getWorkpadsViewOptions,
  setWorkpadsLastView,
  setWorkpadsViewOptions,
  useWorkpadsPanelPreferences,
  useWorkpadsViewOptions,
} from "./workpads-panel-store.js";

function resetStorage() {
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

beforeEach(resetStorage);
afterEach(resetStorage);

describe("workpads panel preferences", () => {
  it("opens on Thread, most recently updated first, and Project without its threads", () => {
    expect(getWorkpadsPanelPreferences()).toEqual(WORKPADS_PANEL_DEFAULTS);
    expect(WORKPADS_PANEL_DEFAULTS.lastView).toBe("thread");
    for (const view of ["thread", "project", "global", "all"] as const) {
      expect(getWorkpadsViewOptions(view)).toEqual({ sort: "updated", includeThreadWorkpads: false });
    }
  });

  it("remembers the last view and each view's own options on this device", () => {
    setWorkpadsLastView("all");
    setWorkpadsViewOptions("all", { sort: "title" });
    setWorkpadsViewOptions("project", { includeThreadWorkpads: true });
    expect(JSON.parse(window.localStorage.getItem(WORKPADS_PANEL_STORAGE_KEY)!)).toEqual({
      version: 1,
      lastView: "all",
      views: {
        thread: { sort: "updated", includeThreadWorkpads: false },
        project: { sort: "updated", includeThreadWorkpads: true },
        global: { sort: "updated", includeThreadWorkpads: false },
        all: { sort: "title", includeThreadWorkpads: false },
      },
    });
    // A fresh read (another tab, the next visit) sees the same.
    window.dispatchEvent(new StorageEvent("storage", { key: WORKPADS_PANEL_STORAGE_KEY }));
    expect(getWorkpadsPanelPreferences().lastView).toBe("all");
    expect(getWorkpadsViewOptions("thread").sort).toBe("updated");
  });

  it("reads damaged or unknown values as the defaults", () => {
    const read = (raw: string) => {
      window.localStorage.setItem(WORKPADS_PANEL_STORAGE_KEY, raw);
      window.dispatchEvent(new StorageEvent("storage", { key: WORKPADS_PANEL_STORAGE_KEY }));
      return getWorkpadsPanelPreferences();
    };
    expect(read("not json")).toEqual(WORKPADS_PANEL_DEFAULTS);
    expect(read(JSON.stringify({ version: 2, lastView: "all" }))).toEqual(WORKPADS_PANEL_DEFAULTS);
    expect(read(JSON.stringify({
      version: 1, lastView: "everything", views: { all: { sort: "oldest" }, project: { includeThreadWorkpads: true } },
    }))).toEqual({
      ...WORKPADS_PANEL_DEFAULTS,
      views: { ...WORKPADS_PANEL_DEFAULTS.views, project: { ...WORKPADS_PANEL_DEFAULTS.views.project, includeThreadWorkpads: true } },
    });
  });

  it("reads options saved while All could be grouped, dropping only Group by project", () => {
    window.localStorage.setItem(WORKPADS_PANEL_STORAGE_KEY, JSON.stringify({
      version: 1,
      lastView: "all",
      views: {
        all: { sort: "title", groupByProject: false },
        project: { sort: "newest", groupByProject: true, includeThreadWorkpads: true },
      },
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(getWorkpadsPanelPreferences()).toEqual({
      version: 1,
      lastView: "all",
      views: {
        ...WORKPADS_PANEL_DEFAULTS.views,
        all: { sort: "title", includeThreadWorkpads: false },
        project: { sort: "newest", includeThreadWorkpads: true },
      },
    });
    // The next change writes the options back without it.
    setWorkpadsViewOptions("global", { sort: "newest" });
    expect(window.localStorage.getItem(WORKPADS_PANEL_STORAGE_KEY)).not.toContain("groupByProject");
    expect(getWorkpadsViewOptions("all").sort).toBe("title");
  });

  it("follows changes from this tab and from other tabs", () => {
    const { result } = renderHook(() => ({ preferences: useWorkpadsPanelPreferences(), all: useWorkpadsViewOptions("all") }));
    act(() => setWorkpadsViewOptions("all", { sort: "newest" }));
    expect(result.current.all.sort).toBe("newest");
    // Another tab writes the same key; its storage event reaches this one.
    act(() => {
      window.localStorage.setItem(WORKPADS_PANEL_STORAGE_KEY, JSON.stringify({ ...getWorkpadsPanelPreferences(), lastView: "global" }));
      window.dispatchEvent(new StorageEvent("storage", { key: WORKPADS_PANEL_STORAGE_KEY }));
    });
    expect(result.current.preferences.lastView).toBe("global");
    expect(result.current.all.sort).toBe("newest");
  });
});
