import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_SIZE_HINTS,
  REGION_HANDLE_SIZE,
  computeRegionGeometry,
  hiddenByMakeRoom,
  panelSizeHints,
  regionMinimums,
  shareForHandleSize,
  type RegionGeometry,
  type RegionLayoutNode,
} from "./region-geometry.js";
import {
  MIN_PANEL_SHARE,
  closePanel,
  defaultRegionView,
  maximizePanel,
  movePanel,
  openPanel,
  openTerminalTab,
  setExtend,
  setPanelSize,
  type PanelKind,
  type RegionView,
} from "./regions.js";
import { WorkspacePanelTenantRegistry, type WorkspacePanelTenant } from "./registry.js";

const STAGE = { width: 1600, height: 1000 };

function withTerminal(view: RegionView): RegionView {
  return openTerminalTab(
    view,
    "terminal-1",
    () => "00000000-0000-4000-8000-000000000001",
  )!;
}

function boxes(geometry: RegionGeometry) {
  return Object.fromEntries(
    geometry.panels.map(({ region, kind, box }) => [region, { kind, ...box }]),
  );
}

function sizeShare(view: RegionView, kind: PanelKind, axis: "width" | "height", share: number) {
  return { ...view, layout: setPanelSize(view.layout, kind, axis, share) };
}

describe("computeRegionGeometry", () => {
  it("gives Chat the whole stage by default", () => {
    const geometry = computeRegionGeometry(defaultRegionView(), STAGE);
    expect(geometry.root).toEqual({
      type: "panel",
      box: { x: 0, y: 0, width: 1600, height: 1000 },
      panel: { region: "middle", kind: "chat", box: { x: 0, y: 0, width: 1600, height: 1000 } },
    });
    expect(geometry.handles).toEqual([]);
    expect(geometry.hiddenByMakeRoom).toEqual([]);
    expect(geometry.maximized).toBeNull();
    expect(geometry.overflow).toBe(false);
  });

  it("peels a right region at its preferred width, with a divider, and the Middle takes the rest", () => {
    const geometry = computeRegionGeometry(openPanel(defaultRegionView(), "files"), STAGE);
    const root = geometry.root as Extract<RegionLayoutNode, { type: "split" }>;
    expect(root).toMatchObject({
      type: "split",
      region: "right",
      direction: "row",
      edgeFirst: false,
    });
    expect(boxes(geometry)).toEqual({
      right: { kind: "files", x: 1080, y: 0, width: 520, height: 1000 },
      middle: { kind: "chat", x: 0, y: 0, width: 1075, height: 1000 },
    });
    expect(geometry.handles).toEqual([
      {
        region: "right",
        kind: "files",
        axis: "width",
        box: { x: 1075, y: 0, width: REGION_HANDLE_SIZE, height: 1000 },
        size: 520,
        min: 320,
        max: 1600 - REGION_HANDLE_SIZE - 360,
        stageLength: 1600,
      },
    ]);
    expect(root.rest).toEqual({
      type: "panel",
      box: { x: 0, y: 0, width: 1075, height: 1000 },
      panel: geometry.panels[1],
    });
  });

  it("sizes a region from its remembered share of the stage", () => {
    const view = sizeShare(openPanel(defaultRegionView(), "files"), "files", "width", 0.25);
    expect(boxes(computeRegionGeometry(view, STAGE)).right).toMatchObject({ width: 400 });
  });

  it("uses a tenant's preferred share between its minimum and preferred size", () => {
    const view = openPanel(defaultRegionView(), "tasks");
    expect(boxes(computeRegionGeometry(view, STAGE)).right).toMatchObject({ width: 380 });
    expect(
      boxes(computeRegionGeometry(view, { width: 800, height: 600 })).right,
    ).toMatchObject({ width: 300 });
  });

  it("keeps a region within its minimum and the inner regions' minimums", () => {
    const view = openPanel(defaultRegionView(), "files");
    expect(
      boxes(computeRegionGeometry(sizeShare(view, "files", "width", 0.9), STAGE)).right,
    ).toMatchObject({ width: 1600 - REGION_HANDLE_SIZE - 360 });
    expect(
      boxes(computeRegionGeometry(sizeShare(view, "files", "width", 0.05), STAGE)).right,
    ).toMatchObject({ width: 320 });
  });

  it("runs the sides full height and the Bottom under the Middle by default", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = withTerminal(openPanel(view, "files"));
    const geometry = computeRegionGeometry(view, STAGE);
    expect(boxes(geometry)).toEqual({
      left: { kind: "workpads", x: 0, y: 0, width: 480, height: 1000 },
      right: { kind: "files", x: 1080, y: 0, width: 520, height: 1000 },
      bottom: { kind: "terminals", x: 485, y: 700, width: 590, height: 300 },
      middle: { kind: "chat", x: 485, y: 0, width: 590, height: 695 },
    });
    expect(geometry.panels.map(({ region }) => region)).toEqual([
      "left",
      "right",
      "bottom",
      "middle",
    ]);
    expect(geometry.handles.map(({ region, box }) => [region, box])).toEqual([
      ["left", { x: 480, y: 0, width: 5, height: 1000 }],
      ["right", { x: 1075, y: 0, width: 5, height: 1000 }],
      ["bottom", { x: 485, y: 695, width: 590, height: 5 }],
    ]);
  });

  it("gives an extended Bottom the full width, between the sides' feet", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = withTerminal(openPanel(view, "files"));
    view = { ...view, layout: setExtend(view.layout, "bottom", true) };
    expect(boxes(computeRegionGeometry(view, STAGE))).toEqual({
      bottom: { kind: "terminals", x: 0, y: 700, width: 1600, height: 300 },
      left: { kind: "workpads", x: 0, y: 0, width: 480, height: 695 },
      right: { kind: "files", x: 1080, y: 0, width: 520, height: 695 },
      middle: { kind: "chat", x: 485, y: 0, width: 590, height: 695 },
    });
  });

  it("lets the most recently extended region win a shared corner", () => {
    let view = openPanel(defaultRegionView(), "tasks", "top");
    view = openPanel(view, "files", "left");
    view = { ...view, layout: setExtend(view.layout, "top", true) };
    let geometry = computeRegionGeometry(view, STAGE);
    expect(boxes(geometry).top).toMatchObject({ x: 0, y: 0, width: 1600, height: 350 });
    expect(boxes(geometry).left).toMatchObject({ y: 355, height: 645 });
    view = { ...view, layout: setExtend(view.layout, "left", true) };
    geometry = computeRegionGeometry(view, STAGE);
    expect(boxes(geometry).left).toMatchObject({ x: 0, y: 0, height: 1000 });
    expect(boxes(geometry).top).toMatchObject({ x: 525, y: 0, width: 1075 });
  });

  it("lets the innermost region fill the stage when the Middle shows nothing", () => {
    const filesOnly = closePanel(openPanel(defaultRegionView(), "files"), "chat");
    expect(computeRegionGeometry(filesOnly, STAGE).root).toMatchObject({
      type: "panel",
      panel: { region: "right", kind: "files", box: { x: 0, y: 0, width: 1600, height: 1000 } },
    });
    const sides = openPanel(filesOnly, "workpads", "left");
    const geometry = computeRegionGeometry(sides, STAGE);
    expect(boxes(geometry)).toEqual({
      left: { kind: "workpads", x: 0, y: 0, width: 480, height: 1000 },
      right: { kind: "files", x: 485, y: 0, width: 1115, height: 1000 },
    });
    expect(geometry.handles.map(({ region }) => region)).toEqual(["left"]);
  });

  it("describes an empty stage when nothing is visible", () => {
    const geometry = computeRegionGeometry(closePanel(defaultRegionView(), "chat"), STAGE);
    expect(geometry.root).toEqual({ type: "empty", box: { x: 0, y: 0, ...STAGE } });
    expect(geometry.panels).toEqual([]);
  });

  it("leaves a region empty when its pick is not loaded in this thread", () => {
    const geometry = computeRegionGeometry(openPanel(defaultRegionView(), "files"), STAGE);
    expect(geometry.panels.map(({ region }) => region)).toEqual(["right", "middle"]);
  });

  it("fills the stage with a maximized panel", () => {
    const view = maximizePanel(withTerminal(openPanel(defaultRegionView(), "files")), "terminals");
    const geometry = computeRegionGeometry(view, { width: 400, height: 300 });
    expect(geometry.maximized).toBe("terminals");
    expect(geometry.root).toEqual({
      type: "panel",
      box: { x: 0, y: 0, width: 400, height: 300 },
      panel: { region: "bottom", kind: "terminals", box: { x: 0, y: 0, width: 400, height: 300 } },
    });
    expect(geometry.handles).toEqual([]);
    expect(hiddenByMakeRoom(view, { width: 400, height: 300 })).toEqual([]);
  });
});

describe("make-room", () => {
  const NARROW = { width: 900, height: 800 };

  it("hides the least recently shown edge region until the minimums fit", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    // 320 + 5 + 300 + 5 + 360 = 990 > 900
    const geometry = computeRegionGeometry(view, NARROW);
    expect(geometry.hiddenByMakeRoom).toEqual(["workpads"]);
    expect(geometry.panels.map(({ kind }) => kind)).toEqual(["tasks", "chat"]);
    expect(geometry.overflow).toBe(false);
    expect(hiddenByMakeRoom(view, NARROW)).toEqual(["workpads"]);
    // Showing Workpads again makes it the most recent: Tasks goes instead.
    const shown = openPanel(view, "workpads");
    expect(hiddenByMakeRoom(shown, NARROW)).toEqual(["tasks"]);
  });

  it("does not hide anything when the stage is wide enough", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    expect(hiddenByMakeRoom(view, { width: 990, height: 800 })).toEqual([]);
    expect(hiddenByMakeRoom(view, { width: 989, height: 800 })).toEqual(["workpads"]);
  });

  it("only hides a region that makes room", () => {
    let view = withTerminal(defaultRegionView());
    view = openPanel(view, "workpads", "left");
    view = openPanel(view, "tasks");
    expect(view.layout.recency).toEqual(["terminals", "workpads", "tasks"]);
    // Terminals is least recent, but hiding the Bottom gains no width.
    expect(hiddenByMakeRoom(view, NARROW)).toEqual(["workpads"]);
  });

  it("hides along the height too", () => {
    let view = withTerminal(defaultRegionView());
    view = openPanel(view, "tasks", "top");
    // 240 + 5 + 160 + 5 + 160 = 570 > 500
    const geometry = computeRegionGeometry(view, { width: 1200, height: 500 });
    expect(geometry.hiddenByMakeRoom).toEqual(["terminals"]);
    expect(geometry.panels.map(({ kind }) => kind)).toEqual(["tasks", "chat"]);
  });

  it("never hides Chat, the Middle, or the most recently shown panel; minimums then shrink together", () => {
    let view = movePanel(defaultRegionView(), "chat", "left");
    view = openPanel(view, "files", "middle");
    view = openPanel(view, "workpads");
    // 360 + 5 + 320 + 5 + 320 = 1010 > 900, and nothing may hide.
    const geometry = computeRegionGeometry(view, NARROW);
    expect(geometry.hiddenByMakeRoom).toEqual([]);
    expect(geometry.overflow).toBe(true);
    const placed = boxes(geometry);
    expect(placed.left!.width).toBeCloseTo((360 * 895) / 1005);
    expect(placed.left!.width + placed.right!.width + placed.middle!.width + 10).toBeCloseTo(900);
    expect(placed.right!.width).toBeCloseTo(placed.middle!.width);
  });

  it("protects the most recently shown panel other than Chat", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    view = openPanel(view, "chat");
    expect(view.layout.recency).toEqual(["workpads", "tasks", "chat"]);
    expect(hiddenByMakeRoom(view, NARROW)).toEqual(["workpads"]);
  });

  it("protects the latest edge panel even when a Middle panel was opened after it", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    view = openPanel(view, "files", "middle");
    expect(view.layout.recency).toEqual(["workpads", "tasks", "files"]);
    // 320 + 5 + 300 + 5 + 320 = 950; without Workpads, 625 still exceeds 600.
    const geometry = computeRegionGeometry(view, { width: 600, height: 800 });
    expect(geometry.hiddenByMakeRoom).toEqual(["workpads"]);
    expect(geometry.overflow).toBe(true);
    expect(geometry.panels.map(({ kind }) => kind)).toEqual(["tasks", "files"]);
  });

  it("breaks recency ties in the fixed kind order", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    view = { ...view, layout: { ...view.layout, recency: [] } };
    expect(hiddenByMakeRoom(view, NARROW)).toEqual(["workpads"]);
  });

  it("makes no room on an unmeasured stage", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = openPanel(view, "tasks");
    const geometry = computeRegionGeometry(view, { width: 0, height: 0 });
    expect(geometry.hiddenByMakeRoom).toEqual([]);
    expect(geometry.panels.every(({ box }) => box.width >= 0 && box.height >= 0)).toBe(true);
  });
});

describe("geometry helpers", () => {
  it("converts a dragged divider size to a bounded share", () => {
    const [handle] = computeRegionGeometry(openPanel(defaultRegionView(), "files"), STAGE).handles;
    expect(shareForHandleSize(handle!, 800)).toBe(0.5);
    expect(shareForHandleSize(handle!, 5000)).toBeCloseTo(1235 / 1600);
    expect(shareForHandleSize(handle!, 10)).toBe(0.2);
    expect(shareForHandleSize({ ...handle!, stageLength: 0 }, 10)).toBe(MIN_PANEL_SHARE);
  });

  it("measures the visible layout's minimum size", () => {
    let view = openPanel(defaultRegionView(), "workpads", "left");
    view = withTerminal(openPanel(view, "tasks"));
    expect(regionMinimums(view)).toEqual({
      width: 320 + 5 + 300 + 5 + 360,
      height: Math.max(240, 240, 160 + 5 + 160),
    });
    expect(regionMinimums(closePanel(defaultRegionView(), "chat"))).toEqual({
      width: 0,
      height: 0,
    });
  });

  it("reads Files, Workpads and Tasks minimums from the tenant registry", () => {
    const tenant = (id: string, minWidth: number): WorkspacePanelTenant => ({
      id,
      title: id,
      icon: () => null,
      scope: "global",
      size: { minWidth, minHeight: 200, preferredWidth: 400, preferredHeight: 300 },
      preferredPlacement: { edge: "right" },
      availability: () => ({ available: true }),
      render: () => null,
    });
    const hints = panelSizeHints(
      new WorkspacePanelTenantRegistry([tenant("workspace-files", 333), tenant("tasks", 310)]),
    );
    expect(hints.files).toEqual({
      minWidth: 333,
      minHeight: 200,
      preferredWidth: 400,
      preferredHeight: 300,
    });
    expect(hints.tasks.minWidth).toBe(310);
    expect(hints.workpads).toBe(DEFAULT_PANEL_SIZE_HINTS.workpads);
    expect(hints.chat.minWidth).toBe(360);
    expect(hints.terminals.minHeight).toBe(160);
  });
});
