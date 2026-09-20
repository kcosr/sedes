import { createPaneSize } from "./pane-size";

export const tasksPanelWidthMin = 300;
export const tasksPanelWidthMax = 720;
export const tasksPanelWidthDefault = 340;
export const TASKS_PANEL_WIDTH_STORAGE_KEY = "sedes.tasks.panel.width";

const tasksPanelWidth = createPaneSize({
  storageKey: TASKS_PANEL_WIDTH_STORAGE_KEY,
  cssVariable: "--tasks-panel-width",
  min: tasksPanelWidthMin,
  max: tasksPanelWidthMax,
  default: tasksPanelWidthDefault,
});

export function clampTasksPanelWidth(width: number): number {
  return tasksPanelWidth.clamp(width);
}

export function getTasksPanelWidth(): number {
  return tasksPanelWidth.get();
}

/** Applies the width without persisting while a drag is in progress. */
export function applyTasksPanelWidth(width: number): void {
  tasksPanelWidth.apply(width);
}

/** Clamps, applies, and persists the completed drag or keyboard resize. */
export function setTasksPanelWidth(width: number): number {
  return tasksPanelWidth.set(width);
}

/** Restores the viewer-local width before the application paints. */
export function installTasksPanelWidth(): void {
  tasksPanelWidth.install();
}
