import { describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom

import {
  CLOSE_TASK_DETAIL_EVENT,
  OPEN_OVERLAY_SELECTOR,
  closeExposedTaskDetail,
  hasOpenOverlayAboveDrawer,
  resolveAndroidBackAction,
} from "./android-back.js";

const backInput = (
  overrides: Partial<Parameters<typeof resolveAndroidBackAction>[0]> = {},
): Parameters<typeof resolveAndroidBackAction>[0] => ({
  overlayOpen: false,
  drawerOpen: false,
  sidebarSearchActive: false,
  sidebarFiltersActive: false,
  drawerReturnsToThread: false,
  onDrawerRoute: false,
  canGoBack: false,
  ...overrides,
});

describe("closeExposedTaskDetail", () => {
  it("closes an exposed task detail without dismissing its sheet", () => {
    const sheet = document.createElement("div");
    sheet.className = "tasks-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.dataset.state = "open";
    const panel = document.createElement("div");
    panel.dataset.taskDetailOpen = "true";
    sheet.append(panel);
    document.body.append(sheet);
    const closed = vi.fn();
    window.addEventListener(CLOSE_TASK_DETAIL_EVENT, closed);

    expect(closeExposedTaskDetail()).toBe(true);
    expect(closed).toHaveBeenCalledOnce();

    window.removeEventListener(CLOSE_TASK_DETAIL_EVENT, closed);
    sheet.remove();
  });

  it("leaves Back to a higher overlay opened from the task detail", () => {
    const sheet = document.createElement("div");
    sheet.className = "tasks-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.dataset.state = "open";
    const panel = document.createElement("div");
    panel.dataset.taskDetailOpen = "true";
    sheet.append(panel);
    document.body.append(sheet);
    const popover = document.createElement("div");
    popover.dataset.slot = "popover-content";
    popover.dataset.state = "open";
    document.body.append(popover);

    expect(closeExposedTaskDetail()).toBe(false);

    popover.remove();
    sheet.remove();
  });
});

describe("resolveAndroidBackAction", () => {
  it("recognizes raw Radix dialogs and context menus as open overlays", () => {
    const rawDialog = document.createElement("div");
    rawDialog.setAttribute("role", "dialog");
    rawDialog.dataset.state = "open";
    document.body.append(rawDialog);
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(rawDialog);

    rawDialog.remove();
    const contextMenu = document.createElement("div");
    contextMenu.setAttribute("role", "menu");
    contextMenu.dataset.state = "open";
    contextMenu.dataset.slot = "context-menu-content";
    document.body.append(contextMenu);
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(contextMenu);
    contextMenu.remove();
  });

  it("recognizes the open desktop Tasks panel as an overlay", () => {
    const tasksPanel = document.createElement("section");
    tasksPanel.dataset.slot = "tasks-panel";
    tasksPanel.dataset.state = "open";
    document.body.append(tasksPanel);
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(tasksPanel);
    tasksPanel.remove();
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
  });

  it("recognizes selection actions as an overlay", () => {
    const selectionActions = document.createElement("div");
    selectionActions.dataset.selectionActionOverlay = "";
    document.body.append(selectionActions);
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(selectionActions);
    selectionActions.remove();
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
  });

  it("recognizes thread find only while it is open", () => {
    const threadFind = document.createElement("div");
    threadFind.className = "thread-find-bar";
    threadFind.dataset.open = "true";
    document.body.append(threadFind);

    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(threadFind);
    expect(hasOpenOverlayAboveDrawer(false)).toBe(true);

    threadFind.dataset.open = "false";
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
    expect(hasOpenOverlayAboveDrawer(false)).toBe(false);
    threadFind.remove();
  });

  it("closes an open overlay before anything else", () => {
    expect(
      resolveAndroidBackAction(
        backInput({
          overlayOpen: true,
          drawerOpen: true,
          sidebarSearchActive: true,
          sidebarFiltersActive: true,
          onDrawerRoute: true,
          canGoBack: true,
        }),
      ),
    ).toBe("close-overlay");
    expect(
      resolveAndroidBackAction(backInput({ overlayOpen: true })),
    ).toBe("close-overlay");
  });

  it("unwinds drawer search, filters, and the drawer in order", () => {
    expect(
      resolveAndroidBackAction(
        backInput({
          drawerOpen: true,
          sidebarSearchActive: true,
          sidebarFiltersActive: true,
        }),
      ),
    ).toBe("clear-sidebar-search");
    expect(
      resolveAndroidBackAction(
        backInput({ drawerOpen: true, sidebarFiltersActive: true }),
      ),
    ).toBe("clear-sidebar-filters");
    expect(
      resolveAndroidBackAction(
        backInput({ drawerOpen: true, drawerReturnsToThread: true }),
      ),
    ).toBe("close-overlay");
    expect(
      resolveAndroidBackAction(backInput({ drawerOpen: true })),
    ).toBe("ignore");
  });

  it("distinguishes the drawer from an overlay opened above it", () => {
    const drawer = document.createElement("div");
    drawer.className = "mobile-drawer";
    drawer.setAttribute("role", "dialog");
    drawer.dataset.state = "open";
    document.body.append(drawer);
    expect(hasOpenOverlayAboveDrawer(true)).toBe(false);

    const popover = document.createElement("div");
    popover.dataset.slot = "popover-content";
    popover.dataset.state = "open";
    document.body.append(popover);
    expect(hasOpenOverlayAboveDrawer(true)).toBe(true);

    popover.remove();
    drawer.remove();
  });

  it("opens the drawer on a drawer route when nothing is open", () => {
    expect(
      resolveAndroidBackAction(
        backInput({ onDrawerRoute: true, canGoBack: true }),
      ),
    ).toBe("open-drawer");
  });

  it("preserves the WebView history default elsewhere", () => {
    expect(
      resolveAndroidBackAction(backInput({ canGoBack: true })),
    ).toBe("history-back");
    expect(
      resolveAndroidBackAction(backInput()),
    ).toBe("ignore");
  });
});
