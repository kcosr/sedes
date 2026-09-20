import type {
  LayoutNode,
  PanelInstanceId,
  PanelLayoutTree,
  SplitNode,
  TabStackNode,
} from "./layout-tree.js";

/**
 * Removes locally collapsed instances without changing the persisted topology.
 * Empty tab stacks disappear and a surviving split child occupies the stage.
 */
export function projectPanelLayout(
  tree: PanelLayoutTree,
  collapsed: ReadonlySet<PanelInstanceId>,
): PanelLayoutTree {
  if (tree === null) return null;
  return projectNode(tree, collapsed);
}

function projectNode(
  node: LayoutNode,
  collapsed: ReadonlySet<PanelInstanceId>,
): LayoutNode | null {
  if (node.kind === "tabs") return projectStack(node, collapsed);
  const left = projectNode(node.children[0], collapsed);
  const right = projectNode(node.children[1], collapsed);
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return projectedSplit(node, left, right);
}

function projectStack(
  stack: TabStackNode,
  collapsed: ReadonlySet<PanelInstanceId>,
): TabStackNode | null {
  const tabs = stack.tabs.filter(
    ({ panelInstanceId }) => !collapsed.has(panelInstanceId),
  );
  if (tabs.length === 0) return null;
  if (tabs.length === stack.tabs.length) return stack;
  const activePanelInstanceId = tabs.some(
    (tab) => tab.panelInstanceId === stack.activePanelInstanceId,
  )
    ? stack.activePanelInstanceId
    : tabs[0]!.panelInstanceId;
  return { ...stack, tabs, activePanelInstanceId };
}

function projectedSplit(
  split: SplitNode,
  left: LayoutNode,
  right: LayoutNode,
): SplitNode {
  return {
    ...split,
    children: [left, right],
  };
}
