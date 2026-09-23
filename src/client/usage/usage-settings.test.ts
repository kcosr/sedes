import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE_SETTINGS, activeFilterCount, readUsageSettings, resolveRange, toggleFilter } from "./usage-settings.js";

describe("usage page settings", () => {
  const now = new Date(2026, 8, 23, 15, 30);

  it("resolves presets in the local calendar", () => {
    expect(resolveRange({ preset: "7d", customFrom: null, customTo: null }, now)).toMatchObject({ from: new Date(2026, 8, 17), to: now });
    expect(resolveRange({ preset: "lastMonth", customFrom: null, customTo: null }, now)).toMatchObject({ from: new Date(2026, 7, 1), to: new Date(2026, 8, 1) });
    expect(resolveRange({ preset: "thisYear", customFrom: null, customTo: null }, now).from).toEqual(new Date(2026, 0, 1));
    expect(resolveRange({ preset: "all", customFrom: null, customTo: null }, now).from).toBeNull();
  });

  it("includes the whole last day of a custom range", () => {
    const range = resolveRange({ preset: "custom", customFrom: "2026-09-01", customTo: "2026-09-10" }, now);
    expect(range.from).toEqual(new Date(2026, 8, 1));
    expect(range.to).toEqual(new Date(2026, 8, 11));
  });

  it("restores valid preferences and ignores corrupt ones", () => {
    const stored = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
    expect(readUsageSettings(stored({ preset: "90d", groupBy: "effort", chart: "lines", tab: "patterns" })))
      .toMatchObject({ preset: "90d", groupBy: "effort", chart: "lines", tab: "patterns" });
    expect(readUsageSettings(stored({ preset: "forever", groupBy: "planet", metric: "joules", customFrom: "yesterday" })))
      .toEqual(DEFAULT_USAGE_SETTINGS);
    expect(readUsageSettings({ getItem: () => "{" })).toEqual(DEFAULT_USAGE_SETTINGS);
    expect(readUsageSettings(stored({ groupBy: null })).groupBy).toBeNull();
  });

  it("toggles filter values, including unknown, and drops empty dimensions", () => {
    let filters = toggleFilter({}, "model", "opus");
    filters = toggleFilter(filters, "model", null);
    expect(filters).toEqual({ model: ["opus", null] });
    expect(activeFilterCount(filters)).toBe(2);
    filters = toggleFilter(toggleFilter(filters, "model", "opus"), "model", null);
    expect(filters).toEqual({});
  });

  it("stops adding values at the request limit but still allows removal", () => {
    let filters = {};
    for (let index = 0; index < 60; index += 1) filters = toggleFilter(filters, "thread", `thread-${index}`);
    expect(activeFilterCount(filters)).toBe(50);
    expect(activeFilterCount(toggleFilter(filters, "thread", "thread-0"))).toBe(49);
  });
});
