import { useContext } from "react";
import { NavigationControlsContext } from "../../app/navigation-controls.js";
import type { SettingsPage } from "../../app/settings-route.js";
import { settingsPageSlugs } from "../../app/settings-route.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "../SidebarNavTrigger.js";

/**
 * The settings nav lives in the desktop sidebar slot, so it is visible only
 * where that slot is: at the desktop breakpoint with the sidebar expanded.
 */
export function settingsNavInSidebar({
  mobileLayout,
  sidebarCollapsed,
}: {
  readonly mobileLayout: boolean;
  readonly sidebarCollapsed: boolean;
}): boolean {
  return !mobileLayout && !sidebarCollapsed;
}

/** Whether the settings nav is in the sidebar right now. False outside the shell. */
export function useSettingsNavInSidebar(): boolean {
  const controls = useContext(NavigationControlsContext);
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  if (!controls) return false;
  return settingsNavInSidebar({
    mobileLayout,
    sidebarCollapsed: controls.sidebarCollapsed,
  });
}

const lastPageKey = "sedes-settings-last-page";

function isSettingsPage(value: string | null): value is SettingsPage {
  return value !== null && Object.hasOwn(settingsPageSlugs, value);
}

/** The settings page last shown in this browser tab. */
export function readLastSettingsPage(): SettingsPage | undefined {
  try {
    const value = sessionStorage.getItem(lastPageKey);
    return isSettingsPage(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberSettingsPage(page: SettingsPage): void {
  try {
    sessionStorage.setItem(lastPageKey, page);
  } catch {
    // Storage can be unavailable (private modes); the landing falls back to General.
  }
}

/**
 * Where `/settings` goes. With the nav in the sidebar the list would repeat
 * it, so the landing opens the last page shown (if still available) or
 * General; without the sidebar nav, `/settings` is the grouped list.
 */
export function settingsLandingRedirect({
  navInSidebar,
  lastPage,
  available,
}: {
  readonly navInSidebar: boolean;
  readonly lastPage: SettingsPage | undefined;
  readonly available: readonly SettingsPage[];
}): SettingsPage | undefined {
  if (!navInSidebar) return undefined;
  if (lastPage && available.includes(lastPage)) return lastPage;
  return available.includes("general") ? "general" : available[0];
}

const reselectEvent = "sedes-settings-page-reselect";

/** Asks the settings view to return the page already shown to its start. */
export function requestSettingsPageReselect(page: SettingsPage): void {
  window.dispatchEvent(new CustomEvent<SettingsPage>(reselectEvent, { detail: page }));
}

export function installSettingsPageReselectListener(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  onReselect: (page: SettingsPage) => void,
): () => void {
  const listener = (event: Event) => {
    const page = (event as CustomEvent<unknown>).detail;
    if (typeof page === "string" && isSettingsPage(page)) onReselect(page);
  };
  target.addEventListener(reselectEvent, listener);
  return () => target.removeEventListener(reselectEvent, listener);
}
