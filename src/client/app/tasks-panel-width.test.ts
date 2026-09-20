// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTasksPanelWidth,
  clampTasksPanelWidth,
  getTasksPanelWidth,
  installTasksPanelWidth,
  setTasksPanelWidth,
  TASKS_PANEL_WIDTH_STORAGE_KEY,
  tasksPanelWidthDefault,
  tasksPanelWidthMax,
  tasksPanelWidthMin,
} from "./tasks-panel-width";

describe("tasks panel width", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--tasks-panel-width");
  });

  it("clamps and persists completed widths", () => {
    expect([
      tasksPanelWidthMin,
      tasksPanelWidthDefault,
      tasksPanelWidthMax,
    ]).toEqual([300, 340, 720]);
    expect(getTasksPanelWidth()).toBe(340);
    expect(clampTasksPanelWidth(299)).toBe(300);
    expect(setTasksPanelWidth(487.6)).toBe(488);
    expect(localStorage.getItem(TASKS_PANEL_WIDTH_STORAGE_KEY)).toBe("488");
    expect(
      document.documentElement.style.getPropertyValue("--tasks-panel-width"),
    ).toBe("488px");
  });

  it("keeps drag previews ephemeral and restores the saved width", () => {
    applyTasksPanelWidth(412.5);
    expect(localStorage.getItem(TASKS_PANEL_WIDTH_STORAGE_KEY)).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--tasks-panel-width"),
    ).toBe("412.5px");

    localStorage.setItem(TASKS_PANEL_WIDTH_STORAGE_KEY, "525");
    installTasksPanelWidth();
    expect(
      document.documentElement.style.getPropertyValue("--tasks-panel-width"),
    ).toBe("525px");
  });
});
