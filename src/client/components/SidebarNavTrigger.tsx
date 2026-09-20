import { NotificationSilenceButton } from "./NotificationSilenceButton.js";
import { useCallback, useContext, useRef } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  MOBILE_DRAWER_CONTENT_ID,
  NavigationControlsContext,
} from "../app/navigation-controls.js";
import { useMediaQuery } from "../app/use-media-query.js";
import type { ConnectionState } from "../api/EventStreamTransport.js";
import { useDelayedUnavailableConnection } from "../app/use-delayed-connection-status.js";

/** Matches the CSS breakpoint that swaps the sidebar for the drawer. */
export const SIDEBAR_NAV_MEDIA_QUERY = "(max-width: 819px)";

const connectionLabels: Record<ConnectionState, string> = {
  connected: "Application connected",
  reconnecting: "Application reconnecting",
  disconnected: "Application disconnected",
};

export function ApplicationConnectionStatus({
  connection,
  className,
}: {
  readonly connection: ConnectionState;
  readonly className?: string;
}): React.JSX.Element | null {
  const showUnavailable = useDelayedUnavailableConnection(connection);

  if (!showUnavailable) return null;
  const connectionLabel = connectionLabels[connection];
  return (
    <span
      role="img"
      className={`sidebar-connection-status${className ? ` ${className}` : ""}`}
      data-connection={connection}
      aria-label={connectionLabel}
      title={connectionLabel}
    />
  );
}

/**
 * Global workbench navigation trigger (and slim pane-header trigger on
 * full-pane routes). On narrow layouts it opens the navigation drawer; on
 * desktop it collapses or restores the always-visible sidebar. Renders
 * nothing outside the ApplicationShell.
 */
export function SidebarNavTrigger(): React.JSX.Element | null {
  const controls = useContext(NavigationControlsContext);
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const setTriggerRef = useCallback(
    (element: HTMLButtonElement | null) => {
      // Settings and the retained workspace share the return-focus ref.
      // A departing trigger may detach after its replacement has registered.
      if (
        controls &&
        (element || controls.triggerRef.current === ownTrigger.current)
      ) {
        controls.triggerRef.current = element;
      }
      ownTrigger.current = element;
    },
    [controls],
  );
  if (!controls) return null;
  const label = mobileLayout
    ? controls.drawerOpen
      ? "Close thread navigation"
      : "Open thread navigation"
    : controls.sidebarCollapsed
      ? "Show sidebar"
      : "Hide sidebar";
  // Radix's Dialog.Trigger used to supply the popup semantics; with the
  // trigger living outside the dialog they are spelled out explicitly.
  const dialogProps = mobileLayout
    ? {
        "aria-haspopup": "dialog" as const,
        "aria-expanded": controls.drawerOpen,
        "aria-controls": MOBILE_DRAWER_CONTENT_ID,
      }
    : {
        "aria-expanded": !controls.sidebarCollapsed,
        "aria-controls": "desktop-sidebar",
      };
  return (
    <span className="sidebar-nav-control">
      <Button
        ref={setTriggerRef}
        variant="ghost"
        size="icon"
        className="sidebar-nav-trigger"
        aria-label={label}
        title={label}
        {...dialogProps}
        onClick={mobileLayout ? controls.toggleDrawer : controls.toggleSidebar}
      >
        {mobileLayout && controls.drawerOpen ? (
          <X size={20} strokeWidth={1.8} />
        ) : (
          <Menu size={20} strokeWidth={1.8} />
        )}
      </Button>
      <ApplicationConnectionStatus connection={controls.connection} />
      {controls.notifications ? (
        <NotificationSilenceButton store={controls.notifications} />
      ) : null}
    </span>
  );
}
