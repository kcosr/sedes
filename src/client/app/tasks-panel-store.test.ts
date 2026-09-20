import { beforeEach, describe, expect, it } from "vitest";
// @vitest-environment jsdom

import {
  TASKS_PANEL_DEFAULTS,
  TASKS_PANEL_STORAGE_KEY,
  getTasksPanelPreferences,
  setTasksPanelDefaultView,
  setTasksPanelIncludeNestedScopes,
  setTasksPanelOpen,
  setTasksPanelPinned,
  setTasksPanelSearchContent,
} from "./tasks-panel-store.js";

function seed(raw: string): void {
  window.localStorage.setItem(TASKS_PANEL_STORAGE_KEY, raw);
  // Invalidate the module's cached snapshot the same way another tab would.
  window.dispatchEvent(
    new StorageEvent("storage", { key: TASKS_PANEL_STORAGE_KEY }),
  );
}

describe("tasks panel preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: TASKS_PANEL_STORAGE_KEY }),
    );
  });

  it("returns defaults when nothing is stored", () => {
    expect(getTasksPanelPreferences()).toEqual(TASKS_PANEL_DEFAULTS);
  });

  it("round-trips writes", () => {
    setTasksPanelOpen(true);
    setTasksPanelPinned(false);
    setTasksPanelDefaultView("project");
    setTasksPanelSearchContent(true);
    setTasksPanelIncludeNestedScopes(true);
    expect(getTasksPanelPreferences()).toEqual({
      version: 1,
      open: true,
      pinned: false,
      defaultView: "project",
      searchContent: true,
      includeNestedScopes: true,
    });
  });

  it("never throws on malformed blobs", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"version":99,"open":true}',
      '{"version":1,"open":"yes","defaultView":42,"addTo":{}}',
    ]) {
      seed(raw);
      const parsed = getTasksPanelPreferences();
      expect(parsed.version).toBe(1);
      expect(typeof parsed.open).toBe("boolean");
      expect(typeof parsed.pinned).toBe("boolean");
      expect(["global", "project", "thread"]).toContain(parsed.defaultView);
      expect(typeof parsed.searchContent).toBe("boolean");
      expect(typeof parsed.includeNestedScopes).toBe("boolean");
    }
  });

  it("keeps valid fields and drops the retired addTo key", () => {
    seed('{"version":1,"open":true,"defaultView":"bogus","addTo":"project"}');
    expect(getTasksPanelPreferences()).toEqual({
      version: 1,
      open: true,
      pinned: TASKS_PANEL_DEFAULTS.pinned,
      defaultView: TASKS_PANEL_DEFAULTS.defaultView,
      searchContent: TASKS_PANEL_DEFAULTS.searchContent,
      includeNestedScopes: TASKS_PANEL_DEFAULTS.includeNestedScopes,
    });
  });

  it("defaults existing stored preferences to title-only search", () => {
    seed('{"version":1,"open":true,"defaultView":"global"}');
    expect(getTasksPanelPreferences()).toEqual({
      version: 1,
      open: true,
      pinned: true,
      defaultView: "global",
      searchContent: false,
      includeNestedScopes: false,
    });
  });
});
