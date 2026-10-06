// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATIONS_VIEW_DEFAULTS,
  AUTOMATIONS_VIEW_STORAGE_KEY,
  automationGroupCollapsed,
  getAutomationsViewPreferences,
  parseAutomationsViewPreferences,
  setAutomationGroupCollapsed,
  setAutomationsGroupBy,
  useAutomationsViewPreferences,
} from "./automations-view-preferences.js";

function resetStorage() {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

afterEach(() => {
  cleanup();
  resetStorage();
});

describe("automations view preferences", () => {
  it("validates stored values and falls back per field", () => {
    expect(parseAutomationsViewPreferences(null)).toBe(
      AUTOMATIONS_VIEW_DEFAULTS,
    );
    expect(parseAutomationsViewPreferences("{not json")).toBe(
      AUTOMATIONS_VIEW_DEFAULTS,
    );
    expect(
      parseAutomationsViewPreferences(
        JSON.stringify({ version: 2, groupBy: "project" }),
      ),
    ).toBe(AUTOMATIONS_VIEW_DEFAULTS);
    expect(
      parseAutomationsViewPreferences(
        JSON.stringify({
          version: 1,
          groupBy: "weekday",
          collapsed: { "status:paused": true, "status:upcoming": "yes" },
        }),
      ),
    ).toEqual({
      version: 1,
      groupBy: "status",
      collapsed: { "status:paused": true },
    });
    expect(
      parseAutomationsViewPreferences(
        JSON.stringify({ version: 1, groupBy: "project", collapsed: [true] }),
      ),
    ).toEqual({ version: 1, groupBy: "project", collapsed: {} });
  });

  it("collapses Suspended by default until the viewer chooses", () => {
    const defaults = AUTOMATIONS_VIEW_DEFAULTS;
    expect(automationGroupCollapsed(defaults, "status:suspended")).toBe(true);
    expect(automationGroupCollapsed(defaults, "status:upcoming")).toBe(false);
    setAutomationGroupCollapsed("status:suspended", false);
    setAutomationGroupCollapsed("status:upcoming", true);
    const chosen = getAutomationsViewPreferences();
    expect(automationGroupCollapsed(chosen, "status:suspended")).toBe(false);
    expect(automationGroupCollapsed(chosen, "status:upcoming")).toBe(true);
    // Choosing a group's current state stores nothing.
    setAutomationGroupCollapsed("status:paused", false);
    expect(getAutomationsViewPreferences().collapsed).toEqual({
      "status:suspended": false,
      "status:upcoming": true,
    });
  });

  it("persists choices and follows other tabs", () => {
    resetStorage();
    function Probe() {
      const preferences = useAutomationsViewPreferences();
      return (
        <span data-testid="view">
          {`${preferences.groupBy}/${automationGroupCollapsed(preferences, "status:paused")}`}
        </span>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId("view")).toHaveTextContent("status/false");
    act(() => setAutomationsGroupBy("project"));
    act(() => setAutomationGroupCollapsed("status:paused", true));
    expect(screen.getByTestId("view")).toHaveTextContent("project/true");
    expect(
      JSON.parse(localStorage.getItem(AUTOMATIONS_VIEW_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      groupBy: "project",
      collapsed: { "status:paused": true },
    });

    localStorage.setItem(
      AUTOMATIONS_VIEW_STORAGE_KEY,
      JSON.stringify({ version: 1, groupBy: "status", collapsed: {} }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: AUTOMATIONS_VIEW_STORAGE_KEY }),
      );
    });
    expect(screen.getByTestId("view")).toHaveTextContent("status/false");
    expect(getAutomationsViewPreferences().groupBy).toBe("status");
  });
});
