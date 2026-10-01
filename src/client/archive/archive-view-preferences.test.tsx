// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_VIEW_DEFAULTS,
  ARCHIVE_VIEW_STORAGE_KEY,
  getArchiveViewPreferences,
  parseArchiveViewPreferences,
  setArchiveGroupBy,
  setArchiveSort,
  useArchiveViewPreferences,
} from "./archive-view-preferences.js";

function resetStorage() {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

afterEach(() => {
  cleanup();
  resetStorage();
});

describe("archive view preferences", () => {
  it("validates stored values and falls back per field", () => {
    expect(parseArchiveViewPreferences(null)).toBe(ARCHIVE_VIEW_DEFAULTS);
    expect(parseArchiveViewPreferences("{not json")).toBe(ARCHIVE_VIEW_DEFAULTS);
    expect(
      parseArchiveViewPreferences(JSON.stringify({ version: 2, sort: "title" })),
    ).toBe(ARCHIVE_VIEW_DEFAULTS);
    expect(
      parseArchiveViewPreferences(
        JSON.stringify({ version: 1, sort: "title", groupBy: "weekday" }),
      ),
    ).toEqual({ version: 1, sort: "title", groupBy: "date" });
  });

  it("persists choices and follows other tabs", () => {
    resetStorage();
    function Probe() {
      const { sort, groupBy } = useArchiveViewPreferences();
      return <span data-testid="view">{`${sort}/${groupBy}`}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("view")).toHaveTextContent("archived/date");
    act(() => setArchiveSort("activity"));
    act(() => setArchiveGroupBy("project"));
    expect(screen.getByTestId("view")).toHaveTextContent("activity/project");
    expect(JSON.parse(localStorage.getItem(ARCHIVE_VIEW_STORAGE_KEY)!)).toEqual({
      version: 1,
      sort: "activity",
      groupBy: "project",
    });

    localStorage.setItem(
      ARCHIVE_VIEW_STORAGE_KEY,
      JSON.stringify({ version: 1, sort: "title", groupBy: "none" }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: ARCHIVE_VIEW_STORAGE_KEY }),
      );
    });
    expect(screen.getByTestId("view")).toHaveTextContent("title/none");
    expect(getArchiveViewPreferences().sort).toBe("title");
  });
});
