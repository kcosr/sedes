import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTEND_ORDER,
  DEFAULT_PLACEMENT,
  DEFAULT_SHOWN,
  MAX_PANEL_SHARE,
  MAX_TERMINAL_TABS,
  MIN_PANEL_SHARE,
  activateTerminalTab,
  chooseForegroundPanel,
  closePanel,
  closeTerminalTab,
  defaultRegionLayout,
  defaultRegionView,
  effectiveMaximized,
  hidePanel,
  isExtended,
  isLoaded,
  isShown,
  isVisible,
  kindForPanelId,
  loadedPanels,
  maximizePanel,
  movePanel,
  notePanelUsed,
  openPanel,
  openTerminalTab,
  panelIdForKind,
  panelLoadState,
  regionAxis,
  regionPanel,
  resetRegionView,
  restoreMaximized,
  setExtend,
  setPanelSize,
  tenantIdForKind,
  togglePanel,
  visiblePanels,
  type EdgeRegion,
  type PanelKind,
  type RegionView,
} from "./regions.js";

function producerIds() {
  let sequence = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}

function open(view: RegionView, ...kinds: PanelKind[]): RegionView {
  return kinds.reduce((current, kind) => openPanel(current, kind), view);
}

function withTerminal(view: RegionView, terminalId = "terminal-1"): RegionView {
  return openTerminalTab(view, terminalId, producerIds())!;
}

describe("region defaults", () => {
  it("starts with Chat alone in the Middle and default placements", () => {
    const view = defaultRegionView();
    expect(view.layout.placement).toEqual({
      chat: "middle",
      files: "right",
      workpads: "right",
      tasks: "right",
      terminals: "bottom",
    });
    expect(view.layout.shown).toEqual({
      middle: "chat",
      left: null,
      right: null,
      top: null,
      bottom: "terminals",
    });
    expect(view.layout.loaded).toEqual([]);
    expect(view.layout.extendOrder).toEqual(["left", "right", "top", "bottom"]);
    expect(view.layout.maximized).toBeNull();
    expect(view.terminals).toBeNull();
    expect(loadedPanels(view)).toEqual(["chat"]);
    expect(visiblePanels(view)).toEqual(["chat"]);
    // Terminals are the Bottom's pick but not loaded here: the Bottom is empty.
    expect(regionPanel(view, "bottom")).toBeNull();
    expect(regionPanel(view, "middle")).toBe("chat");
  });

  it("freezes the default layout", () => {
    const layout = defaultRegionLayout();
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.placement)).toBe(true);
    expect(Object.isFrozen(layout.shown)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PLACEMENT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SHOWN)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EXTEND_ORDER)).toBe(true);
  });

  it("maps kinds to legacy panel IDs and tenant IDs", () => {
    expect(panelIdForKind("files")).toBe("workspace-files");
    expect(panelIdForKind("chat")).toBe("chat");
    expect(kindForPanelId("workspace-files")).toBe("files");
    expect(kindForPanelId("terminals")).toBe("terminals");
    expect(kindForPanelId("files")).toBeUndefined();
    expect(kindForPanelId("unknown")).toBeUndefined();
    expect(tenantIdForKind("files")).toBe("workspace-files");
    expect(tenantIdForKind("tasks")).toBe("tasks");
    expect(regionAxis("left")).toBe("width");
    expect(regionAxis("bottom")).toBe("height");
  });
});

describe("openPanel", () => {
  it("replaces Workpads with Tasks beside Chat, keeping Workpads loaded and Terminals untouched", () => {
    let view = withTerminal(open(defaultRegionView(), "workpads"));
    expect(visiblePanels(view)).toEqual(["chat", "workpads", "terminals"]);
    view = openPanel(view, "tasks");
    expect(view.layout.shown).toEqual({
      middle: "chat",
      left: null,
      right: "tasks",
      top: null,
      bottom: "terminals",
    });
    expect(loadedPanels(view)).toEqual(["chat", "workpads", "tasks", "terminals"]);
    expect(visiblePanels(view)).toEqual(["chat", "tasks", "terminals"]);
    expect(panelLoadState(view, "workpads")).toBe("hidden");
    expect(panelLoadState(view, "files")).toBe("closed");
    expect(panelLoadState(view, "tasks")).toBe("visible");
  });

  it("keeps loaded kinds in their fixed order", () => {
    const view = open(defaultRegionView(), "tasks", "files", "workpads");
    expect(view.layout.loaded).toEqual(["files", "workpads", "tasks"]);
  });

  it("opens in a given region, which becomes the placement, and empties the old region", () => {
    let view = open(defaultRegionView(), "files", "workpads");
    expect(view.layout.shown.right).toBe("workpads");
    view = openPanel(view, "workpads", "left");
    expect(view.layout.placement.workpads).toBe("left");
    expect(view.layout.shown.left).toBe("workpads");
    // No auto-restore: Files stays hidden and the Right is empty.
    expect(view.layout.shown.right).toBeNull();
    expect(isShown(view, "files")).toBe(false);
    view = openPanel(view, "files");
    expect(visiblePanels(view)).toEqual(["chat", "files", "workpads"]);
  });

  it("replaces whatever the target region shows, Chat included", () => {
    let view = openPanel(defaultRegionView(), "files", "middle");
    expect(view.layout.shown.middle).toBe("files");
    expect(isShown(view, "chat")).toBe(false);
    expect(isLoaded(view, "chat")).toBe(true);
    view = openPanel(view, "chat");
    expect(view.layout.shown.middle).toBe("chat");
    expect(isShown(view, "files")).toBe(false);
  });

  it("leaves another region alone when the panel was not shown in its old one", () => {
    let view = open(defaultRegionView(), "files", "tasks");
    // Files is loaded but hidden behind Tasks on the Right.
    view = openPanel(view, "files", "left");
    expect(view.layout.shown.right).toBe("tasks");
    expect(view.layout.shown.left).toBe("files");
  });

  it("loads an empty Terminals panel", () => {
    const view = openPanel(defaultRegionView(), "terminals");
    expect(view.terminals).toEqual({ tabs: [], activeTerminalId: null });
    expect(visiblePanels(view)).toEqual(["chat", "terminals"]);
  });

  it("ends Maximize and records the panel as the most recently shown", () => {
    let view = open(defaultRegionView(), "files", "workpads");
    view = maximizePanel(view, "workpads");
    view = openPanel(view, "files", "left");
    expect(view.layout.maximized).toBeNull();
    expect(view.layout.recency).toEqual(["workpads", "files"]);
  });

  it("returns the same view when nothing changes", () => {
    const view = openPanel(defaultRegionView(), "chat");
    expect(openPanel(view, "chat")).toBe(view);
    const frozen = openPanel(view, "tasks");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.layout.shown)).toBe(true);
  });

  it("does not mutate its input", () => {
    const view = defaultRegionView();
    const snapshot = JSON.stringify(view);
    openPanel(view, "tasks", "left");
    expect(JSON.stringify(view)).toBe(snapshot);
  });
});

describe("togglePanel", () => {
  it("hides a visible panel, keeping it loaded, and shows it again in its region", () => {
    let view = open(defaultRegionView(), "tasks");
    view = togglePanel(view, "tasks");
    expect(isLoaded(view, "tasks")).toBe(true);
    expect(view.layout.shown.right).toBeNull();
    expect(panelLoadState(view, "tasks")).toBe("hidden");
    view = togglePanel(view, "tasks");
    expect(isVisible(view, "tasks")).toBe(true);
  });

  it("shows a replaced panel, replacing what its region shows", () => {
    let view = open(defaultRegionView(), "workpads", "tasks");
    view = togglePanel(view, "workpads");
    expect(view.layout.shown.right).toBe("workpads");
    expect(panelLoadState(view, "tasks")).toBe("hidden");
  });

  it("opens a closed panel", () => {
    const view = togglePanel(defaultRegionView(), "files");
    expect(isVisible(view, "files")).toBe(true);
  });

  it("shows a panel make-room hid by marking it the most recently shown", () => {
    let view = open(defaultRegionView(), "files", "tasks");
    view = openPanel(openPanel(view, "files", "left"), "tasks");
    expect(view.layout.recency).toEqual(["files", "tasks"]);
    expect(isVisible(view, "files", ["files"])).toBe(false);
    const next = togglePanel(view, "files", ["files"]);
    expect(next.layout.shown).toEqual(view.layout.shown);
    expect(next.layout.recency).toEqual(["tasks", "files"]);
  });

  it("hiding the maximized panel ends Maximize", () => {
    let view = maximizePanel(open(defaultRegionView(), "tasks"), "tasks");
    view = togglePanel(view, "tasks");
    expect(view.layout.maximized).toBeNull();
    expect(view.layout.shown.right).toBeNull();
    expect(visiblePanels(view)).toEqual(["chat"]);
  });

  it("showing a panel while another is maximized ends Maximize", () => {
    let view = maximizePanel(open(defaultRegionView(), "tasks"), "tasks");
    expect(isVisible(view, "chat")).toBe(false);
    view = togglePanel(view, "chat");
    expect(view.layout.maximized).toBeNull();
    expect(visiblePanels(view)).toEqual(["chat", "tasks"]);
  });

  it("hides and shows Chat", () => {
    let view = togglePanel(defaultRegionView(), "chat");
    expect(view.layout.shown.middle).toBeNull();
    expect(isLoaded(view, "chat")).toBe(true);
    view = togglePanel(view, "chat");
    expect(view.layout.shown.middle).toBe("chat");
  });

  it("hiding a maximized panel its region no longer shows leaves that region alone", () => {
    let view = open(defaultRegionView(), "files", "tasks");
    view = maximizePanel(view, "files");
    expect(isVisible(view, "files")).toBe(true);
    view = togglePanel(view, "files");
    expect(view.layout.maximized).toBeNull();
    expect(view.layout.shown.right).toBe("tasks");
  });
});

describe("closePanel", () => {
  it("only hides Chat", () => {
    const view = closePanel(defaultRegionView(), "chat");
    expect(isLoaded(view, "chat")).toBe(true);
    expect(view.layout.shown.middle).toBeNull();
    expect(visiblePanels(view)).toEqual([]);
  });

  it("unloads a device-wide panel and leaves its region empty", () => {
    let view = open(defaultRegionView(), "workpads", "tasks");
    view = closePanel(view, "tasks");
    expect(isLoaded(view, "tasks")).toBe(false);
    expect(view.layout.loaded).toEqual(["workpads"]);
    // No auto-restore: Workpads stays hidden.
    expect(view.layout.shown.right).toBeNull();
    expect(panelLoadState(view, "workpads")).toBe("hidden");
    expect(view.layout.recency).not.toContain("tasks");
  });

  it("unloading a hidden panel leaves its region's panel shown", () => {
    let view = open(defaultRegionView(), "workpads", "tasks");
    view = closePanel(view, "workpads");
    expect(view.layout.shown.right).toBe("tasks");
    expect(view.layout.loaded).toEqual(["tasks"]);
  });

  it("unloads this thread's Terminals with their tabs and empties the Bottom", () => {
    let view = withTerminal(defaultRegionView());
    view = closePanel(view, "terminals");
    expect(view.terminals).toBeNull();
    expect(view.layout.shown.bottom).toBeNull();
  });

  it("ends Maximize when the maximized panel closes", () => {
    let view = maximizePanel(open(defaultRegionView(), "files"), "files");
    view = closePanel(view, "files");
    expect(view.layout.maximized).toBeNull();
    let other = maximizePanel(open(defaultRegionView(), "files", "workpads"), "workpads");
    other = closePanel(other, "files");
    expect(other.layout.maximized).toBe("workpads");
  });

  it("returns the same view for a panel that is not loaded", () => {
    const view = defaultRegionView();
    expect(closePanel(view, "tasks")).toBe(view);
    expect(closePanel(view, "terminals")).toBe(view);
  });
});

describe("movePanel", () => {
  it("shows a loaded panel in its new region and empties the old one", () => {
    let view = open(defaultRegionView(), "files", "workpads");
    view = movePanel(view, "workpads", "left");
    expect(view.layout.placement.workpads).toBe("left");
    expect(view.layout.shown).toMatchObject({ left: "workpads", right: null });
    expect(panelLoadState(view, "files")).toBe("hidden");
  });

  it("replaces the panel the new region shows", () => {
    let view = withTerminal(open(defaultRegionView(), "tasks"));
    view = movePanel(view, "tasks", "bottom");
    expect(view.layout.shown.bottom).toBe("tasks");
    expect(panelLoadState(view, "terminals")).toBe("hidden");
    expect(view.layout.recency.at(-1)).toBe("tasks");
  });

  it("only changes the placement of a closed panel", () => {
    const view = movePanel(defaultRegionView(), "tasks", "left");
    expect(view.layout.placement.tasks).toBe("left");
    expect(view.layout.shown).toEqual(DEFAULT_SHOWN);
    expect(openPanel(view, "tasks").layout.shown.left).toBe("tasks");
  });

  it("carries the region's pick for Terminals that this thread has not loaded", () => {
    const view = movePanel(defaultRegionView(), "terminals", "right");
    expect(view.layout.shown).toMatchObject({ bottom: null, right: "terminals" });
    expect(regionPanel(view, "right")).toBeNull();
  });

  it("moves Chat out of the Middle", () => {
    const view = movePanel(defaultRegionView(), "chat", "left");
    expect(view.layout.shown).toMatchObject({ middle: null, left: "chat" });
  });

  it("shows a hidden panel when moved to its own region, and ends Maximize", () => {
    let view = open(defaultRegionView(), "files", "tasks");
    view = maximizePanel(view, "tasks");
    view = movePanel(view, "files", "right");
    expect(view.layout.shown.right).toBe("files");
    expect(view.layout.maximized).toBeNull();
    expect(movePanel(view, "files", "right")).toBe(view);
  });
});

describe("maximizePanel and restoreMaximized", () => {
  it("fills the stage with one loaded panel and restores the layout exactly", () => {
    const before = withTerminal(open(defaultRegionView(), "tasks"));
    const maximized = maximizePanel(before, "terminals");
    expect(visiblePanels(maximized)).toEqual(["terminals"]);
    expect(maximized.layout.shown).toBe(before.layout.shown);
    const restored = restoreMaximized(maximized);
    expect(restored.layout.shown).toEqual(before.layout.shown);
    expect(visiblePanels(restored)).toEqual(visiblePanels(before));
  });

  it("does nothing for a closed panel", () => {
    const view = defaultRegionView();
    expect(maximizePanel(view, "files")).toBe(view);
    expect(restoreMaximized(view)).toBe(view);
  });

  it("ignores a maximized Terminals panel this thread has not loaded", () => {
    const maximized = maximizePanel(withTerminal(defaultRegionView()), "terminals");
    const otherThread: RegionView = { layout: maximized.layout, terminals: null };
    expect(effectiveMaximized(otherThread)).toBeNull();
    expect(visiblePanels(otherThread)).toEqual(["chat"]);
  });
});

describe("extend order", () => {
  const extended = (order: readonly EdgeRegion[]) =>
    (["left", "right", "top", "bottom"] as const).filter((region) =>
      isExtended(order, region),
    );

  it("extends the sides by default", () => {
    expect(extended(defaultRegionLayout().extendOrder)).toEqual(["left", "right"]);
  });

  it("moves an extended region outermost and an un-extended one innermost", () => {
    let layout = setExtend(defaultRegionLayout(), "bottom", true);
    expect(layout.extendOrder).toEqual(["bottom", "left", "right", "top"]);
    expect(extended(layout.extendOrder)).toEqual(["bottom"]);
    layout = setExtend(layout, "left", true);
    // The most recent wins the shared corner.
    expect(layout.extendOrder).toEqual(["left", "bottom", "right", "top"]);
    expect(extended(layout.extendOrder)).toEqual(["left"]);
    layout = setExtend(layout, "left", false);
    expect(layout.extendOrder).toEqual(["bottom", "right", "top", "left"]);
    expect(extended(layout.extendOrder)).toEqual(["bottom"]);
  });

  it("un-extending a side gives its corners to Top and Bottom", () => {
    const layout = setExtend(defaultRegionLayout(), "left", false);
    expect(layout.extendOrder).toEqual(["right", "top", "bottom", "left"]);
    expect(extended(layout.extendOrder)).toEqual(["right"]);
  });

  it("returns the same layout when the order does not change", () => {
    const layout = defaultRegionLayout();
    expect(setExtend(layout, "left", true)).toBe(layout);
    expect(setExtend(layout, "bottom", false)).toBe(layout);
  });
});

describe("setPanelSize", () => {
  it("remembers a share per kind and axis, clamped to the share bounds", () => {
    let layout = setPanelSize(defaultRegionLayout(), "files", "width", 0.3);
    layout = setPanelSize(layout, "files", "height", 2);
    layout = setPanelSize(layout, "chat", "width", 0);
    expect(layout.sizes).toEqual({
      files: { width: 0.3, height: MAX_PANEL_SHARE },
      chat: { width: MIN_PANEL_SHARE },
    });
    expect(setPanelSize(layout, "files", "width", 0.3)).toBe(layout);
    expect(setPanelSize(layout, "files", "width", Number.NaN)).toBe(layout);
  });
});

describe("notePanelUsed", () => {
  it("moves a kind to the most recent end", () => {
    let layout = notePanelUsed(defaultRegionLayout(), "files");
    layout = notePanelUsed(layout, "tasks");
    layout = notePanelUsed(layout, "files");
    expect(layout.recency).toEqual(["tasks", "files"]);
    expect(notePanelUsed(layout, "files")).toBe(layout);
  });
});

describe("resetRegionView", () => {
  it("restores defaults, unloads this thread's Terminals and keeps sizes", () => {
    let view = withTerminal(open(defaultRegionView(), "tasks", "files"));
    view = movePanel(view, "chat", "left");
    view = { ...view, layout: setExtend(view.layout, "top", true) };
    view = { ...view, layout: setPanelSize(view.layout, "files", "width", 0.4) };
    view = maximizePanel(view, "files");
    const reset = resetRegionView(view);
    expect(reset.terminals).toBeNull();
    expect(reset.layout).toEqual({
      ...defaultRegionLayout(),
      sizes: { files: { width: 0.4 } },
    });
  });
});

describe("terminal tabs", () => {
  it("loads Terminals with a tab and shows it in its place", () => {
    const view = openTerminalTab(defaultRegionView(), "terminal-1", producerIds())!;
    expect(view.terminals).toEqual({
      tabs: [{ terminalId: "terminal-1", producerId: "00000000-0000-4000-8000-000000000001" }],
      activeTerminalId: "terminal-1",
    });
    expect(isVisible(view, "terminals")).toBe(true);
  });

  it("adds tabs with stable producers and selects an existing tab without a new producer", () => {
    const createProducerId = producerIds();
    let view = openTerminalTab(defaultRegionView(), "terminal-1", createProducerId)!;
    view = openTerminalTab(view, "terminal-2", createProducerId)!;
    view = openTerminalTab(view, "terminal-1", createProducerId)!;
    expect(view.terminals?.tabs.map((tab) => tab.producerId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(view.terminals?.activeTerminalId).toBe("terminal-1");
  });

  it("opens Terminals in a chosen region", () => {
    const view = openTerminalTab(defaultRegionView(), "terminal-1", producerIds(), "right")!;
    expect(view.layout.placement.terminals).toBe("right");
    expect(view.layout.shown).toMatchObject({ right: "terminals", bottom: null });
  });

  it("refuses invalid IDs and tabs past the limit", () => {
    const createProducerId = producerIds();
    expect(openTerminalTab(defaultRegionView(), "", createProducerId)).toBeUndefined();
    expect(
      openTerminalTab(defaultRegionView(), "x".repeat(161), createProducerId),
    ).toBeUndefined();
    let view = defaultRegionView();
    for (let index = 0; index < MAX_TERMINAL_TABS; index += 1)
      view = openTerminalTab(view, `terminal-${index}`, createProducerId)!;
    expect(openTerminalTab(view, "one-more", createProducerId)).toBeUndefined();
    expect(openTerminalTab(view, "terminal-0", createProducerId)).toBeDefined();
  });

  it("activates an existing tab and shows the hidden panel", () => {
    const createProducerId = producerIds();
    let view = openTerminalTab(defaultRegionView(), "terminal-1", createProducerId)!;
    view = openTerminalTab(view, "terminal-2", createProducerId)!;
    view = hidePanel(view, "terminals");
    expect(activateTerminalTab(view, "missing")).toBeUndefined();
    view = activateTerminalTab(view, "terminal-1")!;
    expect(view.terminals?.activeTerminalId).toBe("terminal-1");
    expect(isVisible(view, "terminals")).toBe(true);
  });

  it("closing the active tab activates its left neighbour and keeps the panel loaded", () => {
    const createProducerId = producerIds();
    let view = defaultRegionView();
    for (const id of ["a", "b", "c"])
      view = openTerminalTab(view, id, createProducerId)!;
    view = activateTerminalTab(view, "b")!;
    view = closeTerminalTab(view, "b")!;
    expect(view.terminals?.activeTerminalId).toBe("a");
    view = closeTerminalTab(view, "c")!;
    expect(view.terminals?.activeTerminalId).toBe("a");
    view = closeTerminalTab(view, "a")!;
    expect(view.terminals).toEqual({ tabs: [], activeTerminalId: null });
    expect(isLoaded(view, "terminals")).toBe(true);
    expect(closeTerminalTab(view, "a")).toBeUndefined();
    expect(closeTerminalTab(defaultRegionView(), "a")).toBeUndefined();
  });

  it("closing the first active tab activates the new first tab", () => {
    const createProducerId = producerIds();
    let view = openTerminalTab(defaultRegionView(), "a", createProducerId)!;
    view = openTerminalTab(view, "b", createProducerId)!;
    view = activateTerminalTab(view, "a")!;
    view = closeTerminalTab(view, "a")!;
    expect(view.terminals?.activeTerminalId).toBe("b");
  });
});

describe("chooseForegroundPanel", () => {
  it("prefers the requested, then the selected panel, then the first shown one", () => {
    const view = withTerminal(open(defaultRegionView(), "files"));
    expect(chooseForegroundPanel(view)).toBe("chat");
    expect(chooseForegroundPanel(view, { selected: "files" })).toBe("files");
    expect(
      chooseForegroundPanel(view, { selected: "files", requested: "terminals" }),
    ).toBe("terminals");
  });

  it("skips Tasks, hidden and closed panels", () => {
    let view = open(defaultRegionView(), "files", "tasks");
    expect(chooseForegroundPanel(view, { requested: "tasks" })).toBe("chat");
    expect(chooseForegroundPanel(view, { selected: "files" })).toBe("chat");
    expect(chooseForegroundPanel(view, { selected: "workpads" })).toBe("chat");
    view = closePanel(view, "chat");
    expect(chooseForegroundPanel(view)).toBeUndefined();
    expect(chooseForegroundPanel(view, { exclude: [] })).toBe("tasks");
  });

  it("ignores make-room and Maximize, which do not apply on phones", () => {
    const view = maximizePanel(open(defaultRegionView(), "files"), "files");
    expect(chooseForegroundPanel(view)).toBe("chat");
  });
});
