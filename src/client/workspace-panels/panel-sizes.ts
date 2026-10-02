import type { PanelAxis } from "./layout-fit.js";
import { projectPanelLayout } from "./layout-presentation.js";
import {
  resizeSplit,
  type LayoutNode,
  type PanelInstanceId,
  type PanelKind,
  type PanelLayoutTree,
  type PanelPlacementEdge,
  type SplitNode,
} from "./layout-tree.js";

/**
 * Side panel sizes shared by every thread layout.
 *
 * A side panel (any kind but Chat) keeps one size per axis: its share of the
 * stage width when it sits beside other panels, or of the stage height when
 * it sits above or below them. Each thread keeps its own layout topology, and
 * the splits on stage are fitted to these shares, so a panel is as wide in
 * every thread whatever else is open there; Chat takes the remaining space.
 * Shares are fractions, so when the stage is too small for every panel's
 * minimum, the panes shrink together by layout-fit's rules instead.
 *
 * Fitting works on the stage as rendered, without collapsed panels. A split is
 * fitted when exactly one side shows a single side panel that is also on its
 * own beside that split in the layout, not standing in for a collapsed sibling.
 * Any other split, such as two side panels split against each other, keeps its
 * thread-local size.
 */

export type SidePanelKind = Exclude<PanelKind, "chat">;
export type PanelSize = Readonly<Partial<Record<PanelAxis, number>>>;
export type PanelSizes = ReadonlyMap<SidePanelKind, PanelSize>;

export const SIDE_PANEL_KINDS: readonly SidePanelKind[] = [
  "files",
  "workpads",
  "tasks",
  "terminals",
];
export const MIN_PANEL_SHARE = 0.05;
export const MAX_PANEL_SHARE = 0.95;

export interface MeasuredPanelSize {
  /** The fitted split that sizes the panel. */
  readonly splitId: string;
  readonly kind: SidePanelKind;
  readonly axis: PanelAxis;
  readonly share: number;
}

interface StageShares {
  readonly width: number;
  readonly height: number;
}

export function edgeAxis(edge: PanelPlacementEdge): PanelAxis {
  return edge === "left" || edge === "right" ? "width" : "height";
}

function clampPanelShare(share: number): number {
  return Math.min(MAX_PANEL_SHARE, Math.max(MIN_PANEL_SHARE, share));
}

function splitAxis(split: SplitNode): PanelAxis {
  return split.orientation === "row" ? "width" : "height";
}

function loneSidePanel(node: LayoutNode): SidePanelKind | undefined {
  if (node.kind !== "tabs" || node.tabs.length !== 1) return undefined;
  const kind = node.tabs[0]!.kind;
  return kind === "chat" ? undefined : kind;
}

/**
 * The side of a rendered split that shows a single side panel, when only one
 * side does and the layout split holds that same stack. Projection keeps
 * unchanged nodes, so a stack standing in for collapsed panels differs.
 */
function sizedSide(
  split: SplitNode,
  layout: ReadonlyMap<string, SplitNode>,
): { readonly index: 0 | 1; readonly kind: SidePanelKind } | undefined {
  const first = loneSidePanel(split.children[0]);
  const second = loneSidePanel(split.children[1]);
  const index = first && !second ? 0 : second && !first ? 1 : undefined;
  if (
    index === undefined ||
    split.children[index] !== layout.get(split.id)?.children[index]
  )
    return undefined;
  return { index, kind: (first ?? second)! };
}

function layoutSplits(
  node: LayoutNode,
  splits = new Map<string, SplitNode>(),
): Map<string, SplitNode> {
  if (node.kind === "split") {
    splits.set(node.id, node);
    layoutSplits(node.children[0], splits);
    layoutSplits(node.children[1], splits);
  }
  return splits;
}

/**
 * Visits every split of the rendered stage with its share of the stage.
 * `visit` returns the sizes to lay the split's children out with.
 */
function visitStageSplits(
  node: LayoutNode,
  shares: StageShares,
  visit: (split: SplitNode, shares: StageShares) => readonly [number, number],
): void {
  if (node.kind === "tabs") return;
  const sizes = visit(node, shares);
  const axis = splitAxis(node);
  for (const index of [0, 1] as const) {
    visitStageSplits(
      node.children[index],
      { ...shares, [axis]: shares[axis] * sizes[index] },
      visit,
    );
  }
}

/** Fits a layout's splits so each side panel on stage takes its shared size. */
export function fitPanelSizes(
  tree: PanelLayoutTree,
  collapsed: ReadonlySet<PanelInstanceId>,
  sizes: PanelSizes,
): PanelLayoutTree {
  const stage = projectPanelLayout(tree, collapsed);
  if (tree === null || stage === null || sizes.size === 0) return tree;
  const layout = layoutSplits(tree);
  const fitted = new Map<string, readonly [number, number]>();
  visitStageSplits(stage, { width: 1, height: 1 }, (split, shares) => {
    const side = sizedSide(split, layout);
    const axis = splitAxis(split);
    const share = side ? sizes.get(side.kind)?.[axis] : undefined;
    if (!side || share === undefined) return split.sizes;
    const fraction = clampPanelShare(share / shares[axis]);
    const next =
      side.index === 0
        ? ([fraction, 1 - fraction] as const)
        : ([1 - fraction, fraction] as const);
    fitted.set(split.id, next);
    return next;
  });
  // Rendered splits keep their layout IDs, so the fit applies to the layout.
  let result: PanelLayoutTree = tree;
  for (const [splitId, next] of fitted)
    result = resizeSplit(result, splitId, next);
  return result;
}

/** The stage share of every side panel a fitted split sizes. */
export function measurePanelSizes(
  tree: PanelLayoutTree,
  collapsed: ReadonlySet<PanelInstanceId>,
): readonly MeasuredPanelSize[] {
  const stage = projectPanelLayout(tree, collapsed);
  if (tree === null || stage === null) return [];
  const layout = layoutSplits(tree);
  const measured: MeasuredPanelSize[] = [];
  visitStageSplits(stage, { width: 1, height: 1 }, (split, shares) => {
    const side = sizedSide(split, layout);
    if (side) {
      const axis = splitAxis(split);
      measured.push({
        splitId: split.id,
        kind: side.kind,
        axis,
        share: clampPanelShare(shares[axis] * split.sizes[side.index]),
      });
    }
    return split.sizes;
  });
  return measured;
}

/** `sizes` with the measured shares in place of their kinds' current ones. */
export function withPanelSizes(
  sizes: PanelSizes,
  measured: readonly MeasuredPanelSize[],
): Map<SidePanelKind, PanelSize> {
  const next = new Map(sizes);
  for (const { kind, axis, share } of measured)
    next.set(kind, { ...next.get(kind), [axis]: share });
  return next;
}

/** Every split's sizes, by split ID. */
export function splitSizes(
  tree: PanelLayoutTree,
): Map<string, readonly [number, number]> {
  const sizes = new Map<string, readonly [number, number]>();
  const visit = (node: LayoutNode): void => {
    if (node.kind === "tabs") return;
    sizes.set(node.id, node.sizes);
    visit(node.children[0]);
    visit(node.children[1]);
  };
  if (tree) visit(tree);
  return sizes;
}
