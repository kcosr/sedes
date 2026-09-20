import type { NotificationSettingsStore } from "../stores/NotificationSettingsStore.js";
import { createContext } from "react";
import type { ConnectionState } from "../api/EventStreamTransport.js";

/**
 * Sidebar/drawer navigation control. The ApplicationShell owns both the
 * mobile drawer dialog and the desktop sidebar's collapsed state; views
 * render SidebarNavTrigger (in the global workbench bar, and in the slim pane
 * header on full-pane routes) and the trigger uses this context to act and
 * to register itself as the return-focus target for flows that pass through
 * the drawer (settings). Null outside the shell, so standalone-mounted views
 * render no trigger.
 */
/** Stable id wiring the drawer trigger's aria-controls to the content. */
export const MOBILE_DRAWER_CONTENT_ID = "mobile-navigation-drawer";

export interface NavigationControls {
  readonly notifications?: NotificationSettingsStore;
  /** Opens the mobile drawer for flows that must return to navigation. */
  readonly openDrawer: () => void;
  /** Toggles the mobile navigation drawer from the persistent workbench bar. */
  readonly toggleDrawer: () => void;
  /** Toggles the desktop sidebar's persisted collapsed state. */
  readonly toggleSidebar: () => void;
  readonly sidebarCollapsed: boolean;
  readonly drawerOpen: boolean;
  /** Installation-level application event stream status shown by the trigger. */
  readonly connection: ConnectionState;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export const NavigationControlsContext =
  createContext<NavigationControls | null>(null);
