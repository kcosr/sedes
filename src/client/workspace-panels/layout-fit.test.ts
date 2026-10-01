import { describe, expect, it } from "vitest";
import {
  SPLIT_HANDLE_SIZE,
  layoutMinimum,
  panelsToMakeRoom,
  resolveSplit,
  type PanelMinimum,
} from "./layout-fit.js";
import type {
  LayoutNode,
  PanelInstance,
  PanelInstanceId,
  SplitNode,
  TabStackNode,
} from "./layout-tree.js";

const WIDTHS: Readonly<Record<string, number>> = {
  chat: 360,
  tasks: 300,
  files: 320,
  workpads: 320,
  terminals: 160,
};

const minimum: PanelMinimum = (panel, axis) =>
  axis === "width" ? WIDTHS[panel.kind]! : 160;

function panel(kind: "chat" | "tasks" | "files" | "workpads"): PanelInstance {
  return {
    panelInstanceId: kind === "files" ? "workspace-files" : kind,
    kind,
  } as PanelInstance;
}

const terminals: PanelInstance = {
  panelInstanceId: "terminals",
  kind: "terminals",
  threadId: "thread-1",
  tabs: [],
  activeTerminalId: null,
};

function stack(...tabs: PanelInstance[]): TabStackNode {
  return {
    kind: "tabs",
    id: `stack-${tabs[0]!.panelInstanceId}`,
    tabs,
    activePanelInstanceId: tabs[0]!.panelInstanceId,
  };
}

function split(
  orientation: "row" | "column",
  first: LayoutNode,
  second: LayoutNode,
  sizes: readonly [number, number] = [0.5, 0.5],
): SplitNode {
  return {
    kind: "split",
    id: `split-${first.id}-${second.id}`,
    orientation,
    children: [first, second],
    sizes,
  };
}

const chat = stack(panel("chat"));
const tasks = stack(panel("tasks"));
const files = stack(panel("files"));
const workpads = stack(panel("workpads"));

describe("layoutMinimum", () => {
  it("adds widths across a row and takes the widest down a column", () => {
    expect(layoutMinimum(chat, "width", minimum)).toBe(360);
    expect(layoutMinimum(split("row", chat, tasks), "width", minimum)).toBe(
      360 + SPLIT_HANDLE_SIZE + 300,
    );
    expect(
      layoutMinimum(split("column", chat, stack(terminals)), "width", minimum),
    ).toBe(360);
    expect(
      layoutMinimum(split("column", chat, stack(terminals)), "height", minimum),
    ).toBe(160 + SPLIT_HANDLE_SIZE + 160);
  });

  it("counts a stack's active tab only", () => {
    expect(layoutMinimum(stack(panel("tasks"), panel("files")), "width", minimum)).toBe(300);
  });
});

describe("resolveSplit", () => {
  it("gives each pane its fraction while both keep their minimums", () => {
    const resolved = resolveSplit(split("row", chat, tasks), [0.6, 0.4], 1_005, minimum);
    expect(resolved.free).toBe(1_000);
    expect(resolved.minimums).toEqual([360, 300]);
    expect(resolved.sizes).toEqual([600, 400]);
  });

  it("holds a pane at its minimum and gives the other the rest", () => {
    // Files took most of the row; Chat and Tasks beside it keep their minimums.
    const nested = split("row", chat, tasks);
    const root = split("row", nested, files, [0.3, 0.7]);
    const resolved = resolveSplit(root, root.sizes, 1_185, minimum);
    expect(resolved.minimums[0]).toBe(665);
    expect(resolved.sizes).toEqual([665, 515]);
    const inner = resolveSplit(nested, [0.5, 0.5], resolved.sizes[0], minimum);
    expect(inner.sizes).toEqual([360, 300]);
  });

  it("shrinks both minimums together when the split cannot hold them", () => {
    const resolved = resolveSplit(split("row", chat, tasks), [0.9, 0.1], 335, minimum);
    expect(resolved.free).toBe(330);
    expect(resolved.minimums[0]).toBeCloseTo(180);
    expect(resolved.minimums[1]).toBeCloseTo(150);
    expect(resolved.sizes[0] + resolved.sizes[1]).toBeCloseTo(330);
    expect(resolved.sizes[1]).toBeCloseTo(150);
  });
});

describe("panelsToMakeRoom", () => {
  const all = split("row", split("row", chat, files), tasks);
  const none = new Set<PanelInstanceId>();

  it("collapses nothing when the visible panels fit", () => {
    expect(
      panelsToMakeRoom({
        tree: all,
        collapsed: none,
        width: 1_200,
        minimum,
        recency: [],
        keep: new Set(["chat", "tasks"]),
      }),
    ).toEqual([]);
  });

  it("collapses the least recently used side panel, never Chat or the arriving panel", () => {
    expect(
      panelsToMakeRoom({
        tree: all,
        collapsed: none,
        width: 764,
        minimum,
        recency: ["chat", "workspace-files", "tasks"],
        keep: new Set(["chat", "tasks"]),
      }),
    ).toEqual(["workspace-files"]);
    // Restoring Files instead makes Tasks the one to go.
    expect(
      panelsToMakeRoom({
        tree: all,
        collapsed: none,
        width: 764,
        minimum,
        recency: ["chat", "tasks", "workspace-files"],
        keep: new Set(["chat", "workspace-files"]),
      }),
    ).toEqual(["tasks"]);
  });

  it("collapses several, least recent first, and skips panels whose collapse makes no room", () => {
    const tree = split(
      "column",
      split("row", split("row", chat, workpads), split("row", files, tasks)),
      stack(terminals),
    );
    expect(
      panelsToMakeRoom({
        tree,
        collapsed: none,
        width: 700,
        minimum,
        // Terminals is least recent, but under the row it adds no width.
        recency: ["terminals", "workpads", "workspace-files", "chat", "tasks"],
        keep: new Set(["chat", "tasks"]),
      }),
    ).toEqual(["workpads", "workspace-files"]);
  });

  it("stops once only kept panels remain, even if they still do not fit", () => {
    expect(
      panelsToMakeRoom({
        tree: all,
        collapsed: none,
        width: 500,
        minimum,
        recency: [],
        keep: new Set(["chat", "tasks"]),
      }),
    ).toEqual(["workspace-files"]);
  });

  it("ignores panels that are already collapsed", () => {
    expect(
      panelsToMakeRoom({
        tree: all,
        collapsed: new Set(["workspace-files"]),
        width: 764,
        minimum,
        recency: [],
        keep: new Set(["chat", "tasks"]),
      }),
    ).toEqual([]);
  });
});
