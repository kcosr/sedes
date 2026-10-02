import type {
  LayoutNode,
  PanelInstance,
  PanelInstanceId,
  PanelLayoutTree,
  SplitNode,
  TabStackNode,
} from "./layout-tree.js";
import { projectPanelLayout } from "./layout-presentation.js";

/**
 * Panel minimums on the desktop stage.
 *
 * Every panel has a minimum width and height: Chat's is its own, a tenant
 * declares its `size`, and Terminals use the divider's floor. A split's
 * panes keep their minimums while the split can hold them; when it cannot,
 * the minimums shrink together, in proportion, so nothing is clipped.
 *
 * When a panel arrives on stage (opened or restored) and the visible panels'
 * minimum width no longer fits, the least recently used side panels are
 * collapsed until it does, like a person would to make room. Chat and the
 * arriving panel stay; a collapsed panel is restored from the panel menu or
 * its shortcut, as usual. Resizing the window or switching threads never
 * collapses a panel: the minimums then shrink together instead.
 */

/** The width (row) or height (column) of the divider between split panes. */
export const SPLIT_HANDLE_SIZE = 5;

export type PanelAxis = "width" | "height";

/** A panel's minimum along an axis, in pixels. */
export type PanelMinimum = (panel: PanelInstance, axis: PanelAxis) => number;

function splitAxis(split: SplitNode): PanelAxis {
  return split.orientation === "row" ? "width" : "height";
}

function activePanel(stack: TabStackNode): PanelInstance {
  return (
    stack.tabs.find(
      ({ panelInstanceId }) => panelInstanceId === stack.activePanelInstanceId,
    ) ?? stack.tabs[0]!
  );
}

/** The smallest size a node takes along an axis with every panel at its minimum. */
export function layoutMinimum(
  node: LayoutNode,
  axis: PanelAxis,
  minimum: PanelMinimum,
): number {
  if (node.kind === "tabs") return minimum(activePanel(node), axis);
  const first = layoutMinimum(node.children[0], axis, minimum);
  const second = layoutMinimum(node.children[1], axis, minimum);
  return splitAxis(node) === axis
    ? first + SPLIT_HANDLE_SIZE + second
    : Math.max(first, second);
}

export interface ResolvedSplit {
  /** The space the two panes share: the split's size less the divider. */
  readonly free: number;
  /** The panes' minimums, shrunk together when the split cannot hold them. */
  readonly minimums: readonly [number, number];
  /** The panes' sizes, as the grid lays them out. */
  readonly sizes: readonly [number, number];
}

/**
 * Lays out a split's panes along its axis: each gets its fraction of the
 * free space, but never less than its minimum.
 */
export function resolveSplit(
  split: SplitNode,
  fractions: readonly [number, number],
  size: number,
  minimum: PanelMinimum,
): ResolvedSplit {
  const axis = splitAxis(split);
  const free = Math.max(0, size - SPLIT_HANDLE_SIZE);
  const wanted = [
    layoutMinimum(split.children[0], axis, minimum),
    layoutMinimum(split.children[1], axis, minimum),
  ] as const;
  const total = wanted[0] + wanted[1];
  const scale = total > free && total > 0 ? free / total : 1;
  const minimums = [wanted[0] * scale, wanted[1] * scale] as const;
  const share = fractions[0] / (fractions[0] + fractions[1]);
  const first = Math.min(
    free - minimums[1],
    Math.max(minimums[0], share * free),
  );
  return { free, minimums, sizes: [first, free - first] };
}

function stagePanels(tree: PanelLayoutTree): PanelInstanceId[] {
  const ids: PanelInstanceId[] = [];
  const visit = (node: LayoutNode): void => {
    if (node.kind === "tabs") {
      ids.push(node.activePanelInstanceId);
      return;
    }
    visit(node.children[0]);
    visit(node.children[1]);
  };
  if (tree) visit(tree);
  return ids;
}

/**
 * The side panels to collapse, least recently used first, so the visible
 * layout's minimum width fits `width`. Panels in `keep` stay, and a panel is
 * only collapsed when that makes room. When even the kept panels do not fit,
 * collapsing stops there and their minimums shrink together.
 *
 * `recency` lists panels from least to most recently used; panels it does not
 * list count as least recent.
 */
export function panelsToMakeRoom(input: {
  readonly tree: PanelLayoutTree;
  readonly collapsed: ReadonlySet<PanelInstanceId>;
  readonly width: number;
  readonly minimum: PanelMinimum;
  readonly recency: readonly PanelInstanceId[];
  readonly keep: ReadonlySet<PanelInstanceId>;
}): PanelInstanceId[] {
  const { tree, width, minimum, recency, keep } = input;
  let hidden = new Set(input.collapsed);
  const neededWidth = (collapsed: ReadonlySet<PanelInstanceId>) => {
    const visible = projectPanelLayout(tree, collapsed);
    return visible ? layoutMinimum(visible, "width", minimum) : 0;
  };
  let needed = neededWidth(hidden);
  if (needed <= width) return [];
  const used = (id: PanelInstanceId) => recency.indexOf(id);
  const candidates = stagePanels(projectPanelLayout(tree, hidden))
    .filter((id) => !keep.has(id))
    .sort((left, right) => used(left) - used(right));
  const collapse: PanelInstanceId[] = [];
  for (const id of candidates) {
    if (needed <= width) break;
    const next = new Set(hidden).add(id);
    const after = neededWidth(next);
    if (after >= needed) continue;
    hidden = next;
    needed = after;
    collapse.push(id);
  }
  return collapse;
}
