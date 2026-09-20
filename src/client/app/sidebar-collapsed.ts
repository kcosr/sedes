const storageKey = "sedes-sidebar-collapsed";

export function getSidebarCollapsed(): boolean {
  return localStorage.getItem(storageKey) === "true";
}

/**
 * Applies the collapsed state to the root element so CSS can hide the desktop
 * sidebar both after a toggle and before first paint (mirrors
 * sidebar-width.ts). Mobile layouts already hide the sidebar, so the flag
 * only takes effect through the desktop media query.
 */
export function applySidebarCollapsed(collapsed: boolean): void {
  document.documentElement.dataset.sidebarCollapsed = collapsed
    ? "true"
    : "false";
}

/** Persists and applies; returns the effective state. */
export function setSidebarCollapsed(collapsed: boolean): boolean {
  localStorage.setItem(storageKey, collapsed ? "true" : "false");
  applySidebarCollapsed(collapsed);
  return collapsed;
}

/** Restores the persisted state before first paint. */
export function installSidebarCollapsed(): void {
  applySidebarCollapsed(getSidebarCollapsed());
}
