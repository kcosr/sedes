import { App as CapacitorApp } from "@capacitor/app";

/**
 * Android hardware-back policy for the Capacitor `backButton` event (which
 * replaces the WebView default once a listener is registered):
 *
 * 1. An exposed task detail inside the mobile Tasks sheet closes without
 *    dismissing the sheet.
 * 2. With no overlay open, a workpad open in the shown Workpads panel closes
 *    back to its list, as the panel's ‹ Workpads does.
 * 3. With no overlay open, a phone thread whose panel in front is not Chat
 *    shows Chat, its home; the other panel stays loaded.
 * 4. Thread find or any overlay above the mobile navigation drawer closes via
 *    a synthetic Escape, the same dismissal path a physical keyboard takes
 *    through Radix dismissable layers. The phone Terminals viewer is such an
 *    overlay: its Escape returns to Chat through its history entry.
 * 5. In the drawer, Back clears search, then all active sidebar filters, then
 *    closes the drawer to reveal the last thread.
 * 6. Otherwise, on a thread or home route the mobile navigation drawer
 *    opens — back from the landing page must not fall into WebView history
 *    (which resurfaces the previously viewed session).
 * 7. Otherwise the WebView history default is preserved.
 */
export const OPEN_OVERLAY_SELECTORS = [
  // Raw Radix primitives do not carry the data-slot markers added by our UI
  // wrappers, but their open content always exposes its semantic role.
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[role="tooltip"][data-state="open"]',
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="select-content"][data-state="open"]',
  '[data-selection-action-overlay]',
  // Thread find is an in-layout control rather than a Radix overlay, but Back
  // must dismiss it before navigating away from the active thread.
  '.thread-find-bar[data-open="true"]',
  '.mobile-drawer[data-state="open"]',
] as const;

export const OPEN_OVERLAY_SELECTOR = OPEN_OVERLAY_SELECTORS.join(", ");
export const CLOSE_TASK_DETAIL_EVENT = "sedes:close-task-detail";
/**
 * Asks a shown Workpads panel to close its open workpad. The panel cancels
 * the event when it has one open, which is how Back knows it was handled.
 */
export const CLOSE_WORKPAD_EVENT = "sedes:close-workpad";
/**
 * Asks a phone thread's layout to show Chat, its home panel. The layout
 * cancels the event when another panel was in front, which is how Back knows
 * it was handled.
 */
export const SHOW_CHAT_EVENT = "sedes:show-chat";

/**
 * Closes a task detail only when its Tasks sheet is the topmost overlay. A
 * popover or dialog opened from that detail keeps normal Back priority.
 */
export function closeExposedTaskDetail(): boolean {
  const detail = document.querySelector(
    '.tasks-sheet[data-state="open"] [data-task-detail-open="true"]',
  );
  const sheet = detail?.closest('.tasks-sheet[data-state="open"]');
  if (sheet === null || sheet === undefined) return false;
  const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
  if (overlays.item(overlays.length - 1) !== sheet) return false;
  window.dispatchEvent(new Event(CLOSE_TASK_DETAIL_EVENT));
  return true;
}

/**
 * Closes the workpad open in the shown Workpads panel when nothing is open
 * above the page: an overlay, a menu from the workpad, or the drawer takes
 * Back first.
 */
export function closeExposedWorkpad(): boolean {
  if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return false;
  const event = new Event(CLOSE_WORKPAD_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Shows Chat on a phone when another panel is in front and nothing is open
 * above the page: an overlay (the Terminals viewer included), a menu, or the
 * drawer takes Back first.
 */
export function showChatInFront(): boolean {
  if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return false;
  const event = new Event(SHOW_CHAT_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Back's steps inside the page, before overlays and the drawer: an exposed
 * task detail, then an open workpad, then the panel in front of Chat. True
 * when one of them took Back.
 */
export function handleExposedBack(): boolean {
  return closeExposedTaskDetail() || closeExposedWorkpad() || showChatInFront();
}

export type AndroidBackAction =
  | "close-overlay"
  | "clear-sidebar-search"
  | "clear-sidebar-filters"
  | "open-drawer"
  | "history-back"
  | "ignore";

export function resolveAndroidBackAction(input: {
  readonly overlayOpen: boolean;
  readonly drawerOpen: boolean;
  readonly sidebarSearchActive: boolean;
  readonly sidebarFiltersActive: boolean;
  readonly drawerReturnsToThread: boolean;
  readonly onDrawerRoute: boolean;
  readonly canGoBack: boolean;
}): AndroidBackAction {
  if (input.overlayOpen) return "close-overlay";
  if (input.drawerOpen && input.sidebarSearchActive) {
    return "clear-sidebar-search";
  }
  if (input.drawerOpen && input.sidebarFiltersActive) {
    return "clear-sidebar-filters";
  }
  if (input.drawerOpen) {
    return input.drawerReturnsToThread ? "close-overlay" : "ignore";
  }
  if (input.onDrawerRoute) return "open-drawer";
  return input.canGoBack ? "history-back" : "ignore";
}

/** Whether the topmost open overlay is something above the drawer itself. */
export function hasOpenOverlayAboveDrawer(drawerOpen: boolean): boolean {
  const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
  const topmost = overlays.item(overlays.length - 1);
  if (topmost === null || !drawerOpen) return topmost !== null;
  const drawer = document.querySelector('.mobile-drawer[data-state="open"]');
  return topmost !== drawer;
}

/** Registers the listener; returns cleanup. Packaged clients only. */
export function installAndroidBackButton(handlers: {
  readonly onOpenDrawer: () => void;
  readonly isOnDrawerRoute: () => boolean;
  readonly isDrawerOpen: () => boolean;
  readonly isSidebarSearchActive: () => boolean;
  readonly onClearSidebarSearch: () => void;
  readonly isSidebarFiltersActive: () => boolean;
  readonly onClearSidebarFilters: () => void;
  readonly drawerReturnsToThread: () => boolean;
}): () => void {
  let remove: (() => void) | undefined;
  let disposed = false;
  void CapacitorApp.addListener("backButton", (event) => {
    if (handleExposedBack()) return;
    const drawerOpen = handlers.isDrawerOpen();
    const action = resolveAndroidBackAction({
      overlayOpen: hasOpenOverlayAboveDrawer(drawerOpen),
      drawerOpen,
      sidebarSearchActive: handlers.isSidebarSearchActive(),
      sidebarFiltersActive: handlers.isSidebarFiltersActive(),
      drawerReturnsToThread: handlers.drawerReturnsToThread(),
      onDrawerRoute: handlers.isOnDrawerRoute(),
      canGoBack: event.canGoBack,
    });
    if (action === "close-overlay") {
      // Cancelable, as a key press is: the layer that takes Escape cancels
      // it, so a layer beneath (such as the Terminals viewer under its menu)
      // leaves it alone.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      return;
    }
    if (action === "clear-sidebar-search") {
      handlers.onClearSidebarSearch();
      return;
    }
    if (action === "clear-sidebar-filters") {
      handlers.onClearSidebarFilters();
      return;
    }
    if (action === "open-drawer") {
      handlers.onOpenDrawer();
      return;
    }
    if (action === "history-back") window.history.back();
  }).then((handle) => {
    const cleanup = () => void handle.remove();
    if (disposed) cleanup();
    else remove = cleanup;
  });
  return () => {
    disposed = true;
    remove?.();
  };
}
