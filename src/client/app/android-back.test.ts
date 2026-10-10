import { describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom

import {
  CLOSE_TASK_DETAIL_EVENT,
  CLOSE_WORKPAD_EVENT,
  OPEN_OVERLAY_SELECTOR,
  SHOW_CHAT_EVENT,
  closeExposedTaskDetail,
  closeExposedWorkpad,
  handleExposedBack,
  hasOpenOverlayAboveDrawer,
  installAndroidBackButton,
  resolveAndroidBackAction,
  showChatInFront,
} from "./android-back.js";

const androidBack = vi.hoisted(() => ({
  press: undefined as ((event: { canGoBack: boolean }) => void) | undefined,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (_event: string, listener: (event: { canGoBack: boolean }) => void) => {
        androidBack.press = listener;
        return { remove: vi.fn(async () => undefined) };
      },
    ),
  },
}));

/** Listens for `type` on window while `run` runs. */
function withListener(type: string, listener: (event: Event) => void, run: () => void): void {
  window.addEventListener(type, listener);
  try {
    run();
  } finally {
    window.removeEventListener(type, listener);
  }
}

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
  it("lets the Tasks panel in front close its open task detail", () => {
    const close = vi.fn((event: Event) => event.preventDefault());
    withListener(CLOSE_TASK_DETAIL_EVENT, close, () => {
      expect(closeExposedTaskDetail()).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("leaves Back alone when no task detail is open", () => {
    const ignore = vi.fn();
    withListener(CLOSE_TASK_DETAIL_EVENT, ignore, () => {
      expect(closeExposedTaskDetail()).toBe(false);
      expect(ignore).toHaveBeenCalledOnce();
    });
  });

  it("leaves Back to an overlay above the detail, such as its editor, menu or the drawer", () => {
    const close = vi.fn((event: Event) => event.preventDefault());
    for (const role of ["dialog", "menu"]) {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", role);
      overlay.dataset.state = "open";
      document.body.append(overlay);
      withListener(CLOSE_TASK_DETAIL_EVENT, close, () => {
        expect(closeExposedTaskDetail()).toBe(false);
      });
      overlay.remove();
    }
    expect(close).not.toHaveBeenCalled();
  });
});

describe("closeExposedWorkpad", () => {
  it("lets a shown Workpads panel close its open workpad", () => {
    const close = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(CLOSE_WORKPAD_EVENT, close);
    try {
      expect(closeExposedWorkpad()).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(CLOSE_WORKPAD_EVENT, close);
    }
  });

  it("leaves Back alone when no panel has a workpad open", () => {
    const ignore = vi.fn();
    window.addEventListener(CLOSE_WORKPAD_EVENT, ignore);
    try {
      expect(closeExposedWorkpad()).toBe(false);
      expect(ignore).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(CLOSE_WORKPAD_EVENT, ignore);
    }
  });

  it("leaves Back to an overlay above the workpad, such as its menu or the drawer", () => {
    const close = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(CLOSE_WORKPAD_EVENT, close);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.dataset.state = "open";
    document.body.append(menu);
    try {
      expect(closeExposedWorkpad()).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      menu.remove();
      window.removeEventListener(CLOSE_WORKPAD_EVENT, close);
    }
  });
});

describe("showChatInFront", () => {
  it("lets a phone layout with another panel in front show Chat", () => {
    const show = vi.fn((event: Event) => event.preventDefault());
    withListener(SHOW_CHAT_EVENT, show, () => {
      expect(showChatInFront()).toBe(true);
      expect(show).toHaveBeenCalledOnce();
    });
  });

  it("leaves Back alone when Chat is in front", () => {
    const ignore = vi.fn();
    withListener(SHOW_CHAT_EVENT, ignore, () => {
      expect(showChatInFront()).toBe(false);
      expect(ignore).toHaveBeenCalledOnce();
    });
  });

  it("leaves Back to an overlay, such as the Terminals viewer or the drawer", () => {
    const show = vi.fn((event: Event) => event.preventDefault());
    for (const className of ["", "mobile-drawer"]) {
      const overlay = document.createElement("section");
      overlay.className = className;
      overlay.setAttribute("role", "dialog");
      overlay.dataset.state = "open";
      document.body.append(overlay);
      withListener(SHOW_CHAT_EVENT, show, () => {
        expect(showChatInFront()).toBe(false);
      });
      overlay.remove();
    }
    expect(show).not.toHaveBeenCalled();
  });
});

describe("handleExposedBack", () => {
  it("closes an open task detail before showing Chat", () => {
    const steps: string[] = [];
    let detailOpen = true;
    const closeDetail = (event: Event) => {
      if (!detailOpen) return;
      detailOpen = false;
      steps.push("detail");
      event.preventDefault();
    };
    let chatInFront = false;
    const showChat = (event: Event) => {
      if (chatInFront) return;
      chatInFront = true;
      steps.push("chat");
      event.preventDefault();
    };
    withListener(CLOSE_TASK_DETAIL_EVENT, closeDetail, () =>
      withListener(SHOW_CHAT_EVENT, showChat, () => {
        expect(handleExposedBack()).toBe(true);
        expect(steps).toEqual(["detail"]);
        expect(handleExposedBack()).toBe(true);
        expect(steps).toEqual(["detail", "chat"]);
        // Chat in front: the drawer is next.
        expect(handleExposedBack()).toBe(false);
      }),
    );
  });

  it("closes an open workpad before showing Chat", () => {
    const steps: string[] = [];
    let workpadOpen = true;
    const closeWorkpad = (event: Event) => {
      if (!workpadOpen) return;
      workpadOpen = false;
      steps.push("workpad");
      event.preventDefault();
    };
    let chatInFront = false;
    const showChat = (event: Event) => {
      if (chatInFront) return;
      chatInFront = true;
      steps.push("chat");
      event.preventDefault();
    };
    withListener(CLOSE_WORKPAD_EVENT, closeWorkpad, () =>
      withListener(SHOW_CHAT_EVENT, showChat, () => {
        expect(handleExposedBack()).toBe(true);
        expect(steps).toEqual(["workpad"]);
        expect(handleExposedBack()).toBe(true);
        expect(steps).toEqual(["workpad", "chat"]);
        // Chat in front: the drawer is next.
        expect(handleExposedBack()).toBe(false);
      }),
    );
  });
});

describe("installAndroidBackButton", () => {
  it("dismisses an overlay with a cancelable Escape, so only the topmost layer takes it", async () => {
    const remove = installAndroidBackButton({
      onOpenDrawer: vi.fn(),
      isOnDrawerRoute: () => true,
      isDrawerOpen: () => false,
      isSidebarSearchActive: () => false,
      onClearSidebarSearch: vi.fn(),
      isSidebarFiltersActive: () => false,
      onClearSidebarFilters: vi.fn(),
      drawerReturnsToThread: () => true,
    });
    await vi.waitFor(() => expect(androidBack.press).toBeDefined());
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.dataset.state = "open";
    document.body.append(menu);
    // The menu's dismissable layer takes Escape first (Radix listens in the
    // capture phase); a layer beneath, like the Terminals viewer, checks.
    const topmost = (event: KeyboardEvent) => event.preventDefault();
    const beneath = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener("keydown", topmost, true);
    document.addEventListener("keydown", beneath);
    try {
      androidBack.press!({ canGoBack: false });
      expect(beneath).toHaveBeenCalledOnce();
      expect(beneath.mock.results[0]!.value).toBe(true);
    } finally {
      document.removeEventListener("keydown", topmost, true);
      document.removeEventListener("keydown", beneath);
      menu.remove();
      remove();
    }
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

  it("does not treat the Tasks panel as an overlay, docked or on a phone", () => {
    for (const presentation of ["panel", "sheet"]) {
      const surface = document.createElement("section");
      surface.dataset.slot = "tasks-panel";
      surface.dataset.presentation = presentation;
      document.body.append(surface);
      expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
      surface.remove();
    }
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
