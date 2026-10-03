import { describe, expect, it } from "vitest";
import {
  defaultPanelLayout,
  openPanel,
  type PanelInstance,
  type PanelLayoutTree,
  type PanelPlacementEdge,
  type SplitNode,
} from "./layout-tree.js";
import { fitPanelSizes, measurePanelSizes, type PanelSizes } from "./panel-sizes.js";

const NONE = new Set<string>();

function open(
  tree: PanelLayoutTree,
  panel: PanelInstance,
  edge: PanelPlacementEdge,
  fraction: number,
  options: { readonly targetNodeId?: string; readonly mode?: "tab" } = {},
): PanelLayoutTree {
  return openPanel(tree, panel, {
    edge,
    preferredPanelFraction: fraction,
    splitId: `split-${panel.panelInstanceId}`,
    stackId: `stack-${panel.panelInstanceId}`,
    ...options,
  });
}

const files: PanelInstance = { panelInstanceId: "workspace-files", kind: "files" };
const tasks: PanelInstance = { panelInstanceId: "tasks", kind: "tasks" };
const terminals: PanelInstance = {
  panelInstanceId: "terminals",
  kind: "terminals",
  threadId: "thread-1",
  tabs: [{ terminalId: "terminal-1", producerId: "00000000-0000-4000-8000-000000000001" }],
  activeTerminalId: "terminal-1",
};

describe("fitPanelSizes", () => {
  it("fits nested side panels to their stage shares and Terminals to its height", () => {
    let tree = open(defaultPanelLayout, files, "right", 0.3);
    tree = open(tree, tasks, "right", 0.25);
    tree = open(tree, terminals, "bottom", 0.3);
    const sizes: PanelSizes = new Map([
      ["files", { width: 0.2 }],
      ["tasks", { width: 0.3 }],
      ["terminals", { height: 0.4 }],
    ]);
    const fitted = fitPanelSizes(tree, NONE, sizes);
    expect(measurePanelSizes(fitted, NONE)).toEqual([
      { splitId: "split-terminals", kind: "terminals", axis: "height", share: expect.closeTo(0.4) },
      { splitId: "split-tasks", kind: "tasks", axis: "width", share: expect.closeTo(0.3) },
      { splitId: "split-workspace-files", kind: "files", axis: "width", share: expect.closeTo(0.2) },
    ]);
    expect(fitPanelSizes(fitted, NONE, sizes)).toBe(fitted);
  });

  it("gives a split's sole visible side its parent's share", () => {
    let tree = open(defaultPanelLayout, files, "right", 0.3);
    tree = open(tree, tasks, "right", 0.3);
    const sizes: PanelSizes = new Map([["files", { width: 0.2 }]]);
    const fitted = fitPanelSizes(tree, new Set(["tasks"]), sizes) as SplitNode;
    expect((fitted.children[0] as SplitNode).sizes[1]).toBeCloseTo(0.2);
  });

  it("fits only side panels that are on their own in the layout and on stage", () => {
    let tree = open(defaultPanelLayout, files, "right", 0.3);
    tree = open(tree, tasks, "right", 0.3);
    const sizes: PanelSizes = new Map([
      ["files", { width: 0.4 }],
      ["tasks", { width: 0.4 }],
    ]);
    // With Chat collapsed, Files and Tasks split against each other.
    expect(fitPanelSizes(tree, new Set(["chat"]), sizes)).toBe(tree);
    // With Tasks collapsed, Files stands in for the stack or column it shares.
    const tabbed = open(
      open(defaultPanelLayout, files, "right", 0.3),
      tasks,
      "right",
      0.3,
      { targetNodeId: "stack-workspace-files", mode: "tab" },
    );
    expect(fitPanelSizes(tabbed, new Set(["tasks"]), sizes)).toBe(tabbed);
    const stacked = open(
      open(defaultPanelLayout, files, "right", 0.3),
      tasks,
      "bottom",
      0.5,
      { targetNodeId: "stack-workspace-files" },
    );
    expect(fitPanelSizes(stacked, new Set(["tasks"]), sizes)).toBe(stacked);
  });

  it("leaves splits between two side panels or tabbed panels alone", () => {
    const beside = open(
      open(defaultPanelLayout, files, "right", 0.3),
      tasks,
      "bottom",
      0.3,
      { targetNodeId: "stack-workspace-files" },
    );
    const tabbed = open(
      open(defaultPanelLayout, files, "right", 0.3),
      tasks,
      "right",
      0.3,
      { targetNodeId: "stack-workspace-files", mode: "tab" },
    );
    const sizes: PanelSizes = new Map([
      ["files", { width: 0.5, height: 0.5 }],
      ["tasks", { width: 0.5, height: 0.5 }],
    ]);
    expect(fitPanelSizes(beside, NONE, sizes)).toBe(beside);
    expect(fitPanelSizes(tabbed, NONE, sizes)).toBe(tabbed);
  });

  it("keeps a fitted side within the split's bounds", () => {
    let tree = open(defaultPanelLayout, files, "right", 0.3);
    tree = open(tree, tasks, "right", 0.5);
    const fitted = fitPanelSizes(
      tree,
      NONE,
      new Map([["files", { width: 0.6 }]]),
    ) as SplitNode;
    expect((fitted.children[0] as SplitNode).sizes[1]).toBeCloseTo(0.95);
  });
});

describe("measurePanelSizes", () => {
  it("measures nested side panels against the whole stage", () => {
    let tree = open(defaultPanelLayout, files, "right", 0.3);
    tree = open(tree, tasks, "right", 0.25);
    expect(measurePanelSizes(tree, NONE)).toEqual([
      { splitId: "split-tasks", kind: "tasks", axis: "width", share: expect.closeTo(0.25) },
      { splitId: "split-workspace-files", kind: "files", axis: "width", share: expect.closeTo(0.225) },
    ]);
  });
});
