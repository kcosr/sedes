import { createPaneSize } from "./pane-size";

export const sidebarWidthMin = 220;
export const sidebarWidthMax = 420;
export const sidebarWidthDefault = 260;

const sidebarWidth = createPaneSize({
  storageKey: "sedes-sidebar-width",
  cssVariable: "--sidebar-width",
  min: sidebarWidthMin,
  max: sidebarWidthMax,
  default: sidebarWidthDefault,
});

export function clampSidebarWidth(width: number): number {
  return sidebarWidth.clamp(width);
}

export function getSidebarWidth(): number {
  return sidebarWidth.get();
}

/** Applies the width to the shell grid without persisting (drag frames). */
export function applySidebarWidth(width: number): void {
  sidebarWidth.apply(width);
}

/** Clamps, applies, and persists; returns the effective width. */
export function setSidebarWidth(width: number): number {
  return sidebarWidth.set(width);
}

/** Restores the persisted width before first paint (mirrors appearance.ts). */
export function installSidebarWidth(): void {
  sidebarWidth.install();
}
