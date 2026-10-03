import { describe, expect, it } from "vitest";
import {
  defaultPanelLayout,
  openPanel,
  panelInstances,
  type LayoutNode,
  type PanelInstance,
  type PanelLayoutTree,
  type PanelPlacementEdge,
} from "./layout-tree.js";
import {
  arrangeCompanions,
  readCompanionArrangement,
  recordCompanionArrangement,
  type CompanionArrangement,
} from "./companion-layout.js";

const files: PanelInstance = { panelInstanceId: "workspace-files", kind: "files" };
const tasks: PanelInstance = { panelInstanceId: "tasks", kind: "tasks" };
const workpads: PanelInstance = { panelInstanceId: "workpads", kind: "workpads" };

function open(
  tree: PanelLayoutTree,
  panel: PanelInstance,
  edge: PanelPlacementEdge,
  options: { readonly targetNodeId?: string; readonly mode?: "tab" } = {},
): PanelLayoutTree {
  return openPanel(tree, panel, {
    edge,
    splitId: `split-${panel.panelInstanceId}`,
    stackId: `stack-${panel.panelInstanceId}`,
    ...options,
  });
}

let sequence = 0;
const options = {
  createId: (kind: "split" | "stack") => `${kind}-new-${++sequence}`,
  preferredEdge: () => "right" as const,
};

function rowOrder(tree: PanelLayoutTree): string[] {
  const visit = (node: LayoutNode): string[] =>
    node.kind === "tabs"
      ? [node.activePanelInstanceId]
      : [...visit(node.children[0]), ...visit(node.children[1])];
  return tree ? visit(tree) : [];
}

describe("readCompanionArrangement", () => {
  it("reads companions wrapped around the layout, outermost first", () => {
    let tree = open(defaultPanelLayout, files, "right");
    tree = open(tree, tasks, "right");
    tree = open(tree, workpads, "left");
    expect(readCompanionArrangement(tree)).toEqual([
      { kind: "workpads", edge: "left" },
      { kind: "tasks", edge: "right" },
    ]);
  });

  it("reads nothing when a companion sits inside the layout", () => {
    const inside = open(open(defaultPanelLayout, tasks, "right"), files, "right");
    expect(readCompanionArrangement(inside)).toBeUndefined();
    const tabbed = open(open(defaultPanelLayout, files, "right"), tasks, "right", {
      targetNodeId: "stack-workspace-files",
      mode: "tab",
    });
    expect(readCompanionArrangement(tabbed)).toBeUndefined();
  });
});

describe("recordCompanionArrangement", () => {
  const preferredEdge = () => "right" as const;

  it("reads the companions' order through Files wrapped outside them", () => {
    let tree = open(defaultPanelLayout, tasks, "right");
    tree = open(tree, workpads, "right");
    tree = open(tree, files, "right");
    expect(readCompanionArrangement(tree)).toBeUndefined();
    expect(recordCompanionArrangement(tree, undefined, preferredEdge)).toEqual([
      { kind: "workpads", edge: "right" },
      { kind: "tasks", edge: "right" },
    ]);
  });

  it("keeps the innermost edge when only companions are open", () => {
    const companions = open(open(null, workpads, "right"), tasks, "right");
    expect(readCompanionArrangement(companions)).toEqual([
      { kind: "tasks", edge: "right" },
      { kind: "workpads", edge: "left" },
    ]);
    expect(
      recordCompanionArrangement(
        companions,
        [{ kind: "workpads", edge: "bottom" }],
        preferredEdge,
      ),
    ).toEqual([
      { kind: "tasks", edge: "right" },
      { kind: "workpads", edge: "bottom" },
    ]);
  });
});

describe("arrangeCompanions", () => {
  const arrangement: CompanionArrangement = [
    { kind: "workpads", edge: "right" },
    { kind: "tasks", edge: "right" },
  ];

  it("leaves an arranged layout unchanged", () => {
    let tree = open(defaultPanelLayout, tasks, "right");
    tree = open(tree, workpads, "right");
    expect(arrangeCompanions(tree, arrangement, options)).toBe(tree);
  });

  it("reorders companions and moves other panels inside them", () => {
    let tree = open(defaultPanelLayout, workpads, "right");
    tree = open(tree, tasks, "right");
    tree = open(tree, files, "right");
    const arranged = arrangeCompanions(tree, arrangement, options);
    expect(rowOrder(arranged)).toEqual(["chat", "workspace-files", "tasks", "workpads"]);
    expect(readCompanionArrangement(arranged)).toEqual(arrangement);
  });

  it("places only the companions in the layout, and unplaced ones outermost", () => {
    const onlyTasks = open(open(defaultPanelLayout, files, "right"), tasks, "left");
    expect(rowOrder(arrangeCompanions(onlyTasks, arrangement, options))).toEqual([
      "chat",
      "workspace-files",
      "tasks",
    ]);
    const unplaced = arrangeCompanions(
      open(open(defaultPanelLayout, tasks, "right"), workpads, "right"),
      [{ kind: "tasks", edge: "left" }],
      options,
    );
    expect(readCompanionArrangement(unplaced)).toEqual([
      { kind: "workpads", edge: "right" },
      { kind: "tasks", edge: "left" },
    ]);
  });

  it("leaves a layout of only companions unchanged whatever the innermost edge", () => {
    const companions = open(open(null, workpads, "right"), tasks, "right");
    expect(
      arrangeCompanions(
        companions,
        [
          { kind: "tasks", edge: "right" },
          { kind: "workpads", edge: "bottom" },
        ],
        options,
      ),
    ).toBe(companions);
  });

  it("rebuilds two companions split against each other without losing either", () => {
    let tree = open(defaultPanelLayout, tasks, "right");
    tree = open(tree, workpads, "bottom", { targetNodeId: "stack-tasks" });
    const arranged = arrangeCompanions(tree, arrangement, options);
    expect(panelInstances(arranged).map((panel) => panel.panelInstanceId).sort()).toEqual([
      "chat",
      "tasks",
      "workpads",
    ]);
    expect(readCompanionArrangement(arranged)).toEqual(arrangement);
  });
});
