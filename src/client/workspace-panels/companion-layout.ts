import {
  closePanel,
  openPanel,
  panelInstances,
  type LayoutNode,
  type PanelInstance,
  type PanelKind,
  type PanelLayoutTree,
  type PanelPlacementEdge,
  type SplitNode,
} from "./layout-tree.js";

/**
 * Tasks and Workpads are companions: open in every thread, they follow the
 * current chat from their workbench toggles. So that switching threads never
 * moves them, every thread's layout wraps its own panels (Chat, Files,
 * Terminals) in the same companion arrangement: each companion docked on its
 * edge across the whole stage, in one shared order. The arrangement the user
 * last set up, by opening, closing, or docking a companion, applies to every
 * thread.
 */
export const COMPANION_KINDS = ["workpads", "tasks"] as const;
export type CompanionKind = (typeof COMPANION_KINDS)[number];

export interface CompanionPlacement {
  readonly kind: CompanionKind;
  readonly edge: PanelPlacementEdge;
}

/** Companion placements, outermost first. */
export type CompanionArrangement = readonly CompanionPlacement[];

export interface ArrangeCompanionsOptions {
  readonly createId: (kind: "split" | "stack") => string;
  /** Where a companion goes when the arrangement does not place it yet. */
  readonly preferredEdge: (kind: CompanionKind) => PanelPlacementEdge;
}

export function isCompanionKind(kind: PanelKind): kind is CompanionKind {
  return (COMPANION_KINDS as readonly PanelKind[]).includes(kind);
}

function loneCompanion(node: LayoutNode): PanelInstance | undefined {
  if (node.kind !== "tabs" || node.tabs.length !== 1) return undefined;
  const panel = node.tabs[0]!;
  return isCompanionKind(panel.kind) ? panel : undefined;
}

function sideEdge(split: SplitNode, index: 0 | 1): PanelPlacementEdge {
  if (split.orientation === "row") return index === 0 ? "left" : "right";
  return index === 0 ? "top" : "bottom";
}

/** A lone Files or Terminals panel, which an older layout may wrap outside. */
function loneOtherSidePanel(node: LayoutNode): boolean {
  if (node.kind !== "tabs" || node.tabs.length !== 1) return false;
  const { kind } = node.tabs[0]!;
  return kind !== "chat" && !isCompanionKind(kind);
}

function walkCompanions(
  tree: PanelLayoutTree,
  throughOtherPanels: boolean,
): CompanionArrangement | undefined {
  const arrangement: CompanionPlacement[] = [];
  let node: LayoutNode | null = tree;
  while (node?.kind === "split") {
    const first = loneCompanion(node.children[0]);
    const second = loneCompanion(node.children[1]);
    if (first && second) {
      // Nothing else is open: the second side counts as the outer one.
      arrangement.push(
        { kind: second.kind as CompanionKind, edge: sideEdge(node, 1) },
        { kind: first.kind as CompanionKind, edge: sideEdge(node, 0) },
      );
      node = null;
      break;
    }
    const index = second ? 1 : first ? 0 : undefined;
    if (index !== undefined) {
      arrangement.push({
        kind: (second ?? first)!.kind as CompanionKind,
        edge: sideEdge(node, index),
      });
      node = node.children[index === 1 ? 0 : 1];
      continue;
    }
    const other = !throughOtherPanels
      ? undefined
      : loneOtherSidePanel(node.children[1])
        ? 1
        : loneOtherSidePanel(node.children[0])
          ? 0
          : undefined;
    if (other === undefined) break;
    node = node.children[other === 1 ? 0 : 1];
  }
  const inside =
    node !== null &&
    panelInstances(node).some((panel) => isCompanionKind(panel.kind));
  return inside ? undefined : arrangement;
}

/**
 * The companions wrapped around a layout, outermost first, or undefined when
 * a companion sits anywhere else, such as tabbed with another panel.
 */
export function readCompanionArrangement(
  tree: PanelLayoutTree,
): CompanionArrangement | undefined {
  return walkCompanions(tree, false);
}

/**
 * The companions' order and edges in a layout, outermost first, stepping
 * over a lone Files or Terminals panel wrapped outside them, as layouts
 * saved before the companions were kept outermost may have. With nothing
 * but companions open, the innermost one has no edge of its own, so it
 * keeps `previous`'s edge, or its preferred one.
 */
export function recordCompanionArrangement(
  tree: PanelLayoutTree,
  previous: CompanionArrangement | undefined,
  preferredEdge: (kind: CompanionKind) => PanelPlacementEdge,
): CompanionArrangement | undefined {
  const arrangement = walkCompanions(tree, true);
  if (!arrangement?.length || !onlyCompanions(tree)) return arrangement;
  const innermost = arrangement.at(-1)!;
  const edge =
    previous?.find(({ kind }) => kind === innermost.kind)?.edge ??
    preferredEdge(innermost.kind);
  return [...arrangement.slice(0, -1), { kind: innermost.kind, edge }];
}

function onlyCompanions(tree: PanelLayoutTree): boolean {
  return panelInstances(tree).every((panel) => isCompanionKind(panel.kind));
}

/**
 * Whether two arrangements match. With nothing but companions open, the
 * innermost companion fills the rest of the stage, so its edge is moot.
 */
function sameArrangement(
  left: CompanionArrangement,
  right: CompanionArrangement,
  innermostEdgeMoot: boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (placement, index) =>
        placement.kind === right[index]!.kind &&
        (placement.edge === right[index]!.edge ||
          (innermostEdgeMoot && index === left.length - 1)),
    )
  );
}

/** Where each lone companion sits: its stack, wrapping split, and share. */
function loneCompanionSlots(
  tree: PanelLayoutTree,
): Map<CompanionKind, { stackId: string; splitId: string; fraction: number }> {
  const slots = new Map<
    CompanionKind,
    { stackId: string; splitId: string; fraction: number }
  >();
  const visit = (node: LayoutNode): void => {
    if (node.kind === "tabs") return;
    for (const index of [0, 1] as const) {
      const panel = loneCompanion(node.children[index]);
      if (panel)
        slots.set(panel.kind as CompanionKind, {
          stackId: node.children[index].id,
          splitId: node.id,
          fraction: node.sizes[index],
        });
    }
    visit(node.children[0]);
    visit(node.children[1]);
  };
  if (tree) visit(tree);
  return slots;
}

/**
 * The layout with its companions wrapped around everything else in
 * `arrangement`'s order and edges. Membership is not changed: a companion
 * missing from the layout stays missing, and one the arrangement does not
 * place yet goes outermost on its preferred edge. A layout already arranged
 * is returned unchanged.
 */
export function arrangeCompanions(
  tree: PanelLayoutTree,
  arrangement: CompanionArrangement,
  options: ArrangeCompanionsOptions,
): PanelLayoutTree {
  const present = panelInstances(tree).filter((panel) =>
    isCompanionKind(panel.kind),
  );
  if (tree === null || present.length === 0) return tree;
  const kinds = new Set(present.map((panel) => panel.kind));
  const placed = arrangement.filter((placement) => kinds.has(placement.kind));
  const unplaced = present
    .filter((panel) => !placed.some((placement) => placement.kind === panel.kind))
    .map((panel) => ({
      kind: panel.kind as CompanionKind,
      edge: options.preferredEdge(panel.kind as CompanionKind),
    }));
  const target = [...unplaced, ...placed];
  const current = readCompanionArrangement(tree);
  if (current && sameArrangement(current, target, onlyCompanions(tree)))
    return tree;

  // A lone companion keeps its stack and split IDs and its share; both leave
  // the layout with it, so reusing them cannot collide.
  const slots = loneCompanionSlots(tree);
  const usedSplitIds = new Set<string>();
  let result: PanelLayoutTree = tree;
  for (const panel of present) result = closePanel(result, panel.panelInstanceId);
  for (const placement of [...target].reverse()) {
    const panel = present.find(({ kind }) => kind === placement.kind)!;
    const slot = slots.get(placement.kind);
    // Two companions split against each other shared one split.
    const splitId =
      slot && !usedSplitIds.has(slot.splitId)
        ? slot.splitId
        : options.createId("split");
    usedSplitIds.add(splitId);
    result = openPanel(result, panel, {
      edge: placement.edge,
      splitId,
      stackId: slot?.stackId ?? options.createId("stack"),
      ...(slot ? { preferredPanelFraction: slot.fraction } : {}),
    });
  }
  // A layout the rebuild could not hold (its limits) stays as it was.
  const kept = new Set(panelInstances(result).map((panel) => panel.panelInstanceId));
  return present.every((panel) => kept.has(panel.panelInstanceId))
    ? result
    : tree;
}
