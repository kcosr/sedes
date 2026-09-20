export const PANEL_LAYOUT_VERSION = 4 as const;

export function panelLayoutStorageKey(threadId: string): string {
  return `sedes-thread-panel-instance-layout@4:${encodeURIComponent(threadId)}`;
}

export const MAX_LAYOUT_DEPTH = 4;
export const MAX_LAYOUT_NODES = 31;
export const MAX_PANEL_INSTANCES = 24;
export const MAX_TABS_PER_STACK = 8;
export const MAX_TERMINAL_TABS = 24;

const MAX_PERSISTED_ID_LENGTH = 160;
const DEFAULT_PANEL_FRACTION = 0.3;
const MIN_POSITIVE_FRACTION = 1e-6;
const FRACTION_EPSILON = 1e-9;

export type PanelKind = "chat" | "files" | "workpads" | "terminals";
export type PanelInstanceId = string;
export type PanelId = PanelInstanceId;
export type SplitOrientation = "row" | "column";
export type PanelPlacementEdge = "left" | "right" | "top" | "bottom";

export type PanelInstance =
  | { readonly panelInstanceId: PanelInstanceId; readonly kind: "chat" }
  | { readonly panelInstanceId: PanelInstanceId; readonly kind: "files" }
  | { readonly panelInstanceId: PanelInstanceId; readonly kind: "workpads" }
  | {
      readonly panelInstanceId: "terminals";
      readonly kind: "terminals";
      readonly threadId: string;
      readonly tabs: readonly TerminalTab[];
      readonly activeTerminalId: string | null;
    };

export interface TerminalTab {
  readonly terminalId: string;
  /** Stable per tab so reconnects retain one input sequence space. */
  readonly producerId: string;
}

export interface TabStackNode {
  readonly kind: "tabs";
  readonly id: string;
  readonly tabs: readonly PanelInstance[];
  readonly activePanelInstanceId: PanelInstanceId;
}

export interface SplitNode {
  readonly kind: "split";
  readonly id: string;
  readonly orientation: SplitOrientation;
  readonly children: readonly [LayoutNode, LayoutNode];
  readonly sizes: readonly [number, number];
}

export type LayoutNode = TabStackNode | SplitNode;
export type PanelLayoutTree = LayoutNode | null;

export interface PanelLayoutEnvelope {
  readonly version: typeof PANEL_LAYOUT_VERSION;
  readonly threadId: string;
  readonly tree: PanelLayoutTree;
}

export interface OpenPanelOptions {
  readonly edge: PanelPlacementEdge;
  readonly preferredPanelFraction?: number;
  readonly splitId?: string;
  readonly stackId?: string;
  readonly targetNodeId?: string;
  readonly mode?: "split" | "tab";
}

export interface DockPanelOptions {
  readonly splitId?: string;
  readonly stackId?: string;
}

export type PanelLayoutAction =
  | {
      readonly type: "openPanel";
      readonly panel: PanelInstance;
      readonly options: OpenPanelOptions;
    }
  | { readonly type: "closePanel"; readonly panelInstanceId: PanelInstanceId }
  | {
      readonly type: "activatePanel";
      readonly panelInstanceId: PanelInstanceId;
    }
  | {
      readonly type: "dockPanel";
      readonly panelInstanceId: PanelInstanceId;
      readonly edge: PanelPlacementEdge;
      readonly options?: DockPanelOptions;
    }
  | {
      readonly type: "resizeSplit";
      readonly splitId: string;
      readonly sizes: readonly number[];
    };

export const chatPanelInstance: PanelInstance = Object.freeze({
  panelInstanceId: "chat",
  kind: "chat",
});

export const defaultPanelLayout: TabStackNode = Object.freeze({
  kind: "tabs",
  id: "main-panel-stack",
  tabs: Object.freeze([chatPanelInstance]),
  activePanelInstanceId: chatPanelInstance.panelInstanceId,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PERSISTED_ID_LENGTH
  );
}

function normalizedSizes(
  values: readonly number[],
): readonly [number, number] | null {
  if (
    values.length !== 2 ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    return null;
  }
  const sum = values[0]! + values[1]!;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  if (Math.abs(sum - 1) <= FRACTION_EPSILON) {
    return Object.freeze([values[0]!, values[1]!]);
  }
  return Object.freeze([values[0]! / sum, values[1]! / sum]);
}

function freezePanel(panel: PanelInstance): PanelInstance {
  if (panel.kind === "chat" && panel.panelInstanceId === "chat") {
    return chatPanelInstance;
  }
  if (panel.kind === "terminals") {
    return Object.freeze({
      ...panel,
      tabs: Object.freeze(panel.tabs.map((tab) => Object.freeze({ ...tab }))),
    });
  }
  return Object.freeze({ ...panel });
}

function freezeStack(input: {
  readonly id: string;
  readonly tabs: readonly PanelInstance[];
  readonly activePanelInstanceId: PanelInstanceId;
}): TabStackNode {
  return Object.freeze({
    kind: "tabs",
    id: input.id,
    tabs: Object.freeze(input.tabs.map(freezePanel)),
    activePanelInstanceId: input.activePanelInstanceId,
  });
}

function freezeSplit(input: {
  readonly id: string;
  readonly orientation: SplitOrientation;
  readonly children: readonly [LayoutNode, LayoutNode];
  readonly sizes: readonly [number, number];
}): SplitNode {
  return Object.freeze({
    kind: "split",
    id: input.id,
    orientation: input.orientation,
    children: Object.freeze([
      input.children[0],
      input.children[1],
    ]) as readonly [LayoutNode, LayoutNode],
    sizes: Object.freeze([input.sizes[0], input.sizes[1]]) as readonly [
      number,
      number,
    ],
  });
}

interface LayoutStats {
  nodes: number;
  panels: number;
  readonly nodeIds: Set<string>;
  readonly panelIds: Set<string>;
  chatCount: number;
  filesCount: number;
  workpadsCount: number;
  terminalsCount: number;
}

function validateTerminalContainer(
  panel: Extract<PanelInstance, { kind: "terminals" }>,
  errors: Set<string>,
): void {
  if (panel.panelInstanceId !== "terminals")
    errors.add("canonical_terminals_panel_id");
  if (!validId(panel.threadId)) errors.add("valid_terminal_thread_id");
  if (panel.tabs.length > MAX_TERMINAL_TABS)
    errors.add("bounded_terminal_tabs");
  const terminalIds = new Set<string>();
  const producerIds = new Set<string>();
  for (const tab of panel.tabs) {
    if (!validId(tab.terminalId) || terminalIds.has(tab.terminalId))
      errors.add("unique_valid_terminal_ids");
    else terminalIds.add(tab.terminalId);
    if (
      !terminalProducerIdSchema.safeParse(tab.producerId).success ||
      producerIds.has(tab.producerId)
    ) errors.add("unique_valid_terminal_producer_ids");
    else producerIds.add(tab.producerId);
  }
  if (
    panel.tabs.length === 0
      ? panel.activeTerminalId !== null
      : panel.activeTerminalId === null || !terminalIds.has(panel.activeTerminalId)
  )
    errors.add("active_terminal_tab_present");
}

function collectValidation(
  node: LayoutNode,
  depth: number,
  stats: LayoutStats,
  errors: Set<string>,
): void {
  stats.nodes += 1;
  if (depth > MAX_LAYOUT_DEPTH) errors.add("bounded_depth");
  if (stats.nodes > MAX_LAYOUT_NODES) errors.add("bounded_nodes");
  if (!validId(node.id) || stats.nodeIds.has(node.id)) {
    errors.add("unique_valid_node_ids");
  } else {
    stats.nodeIds.add(node.id);
  }
  if (node.kind === "split") {
    if (node.orientation !== "row" && node.orientation !== "column") {
      errors.add("valid_orientation");
    }
    if (node.children.length !== 2) errors.add("binary_splits");
    if (!normalizedSizes(node.sizes)) errors.add("positive_finite_sizes");
    else if (Math.abs(node.sizes[0] + node.sizes[1] - 1) > FRACTION_EPSILON) {
      errors.add("normalized_sizes");
    }
    for (const child of node.children)
      collectValidation(child, depth + 1, stats, errors);
    return;
  }
  if (node.kind !== "tabs") {
    errors.add("known_layout_node_kinds");
    return;
  }
  if (node.tabs.length === 0 || node.tabs.length > MAX_TABS_PER_STACK) {
    errors.add("bounded_nonempty_tab_stacks");
  }
  if (
    !node.tabs.some((tab) => tab.panelInstanceId === node.activePanelInstanceId)
  ) {
    errors.add("active_tab_present");
  }
  for (const panel of node.tabs) {
    stats.panels += 1;
    if (stats.panels > MAX_PANEL_INSTANCES) errors.add("bounded_panels");
    if (
      !validId(panel.panelInstanceId) ||
      stats.panelIds.has(panel.panelInstanceId) ||
      stats.nodeIds.has(panel.panelInstanceId)
    ) {
      errors.add("unique_valid_panel_instance_ids");
    } else {
      stats.panelIds.add(panel.panelInstanceId);
    }
    if (panel.kind === "chat") stats.chatCount += 1;
    else if (panel.kind === "files") stats.filesCount += 1;
    else if (panel.kind === "workpads") stats.workpadsCount += 1;
    else if (panel.kind === "terminals") {
      stats.terminalsCount += 1;
      validateTerminalContainer(panel, errors);
    } else errors.add("known_panel_kinds");
  }
}

export function validatePanelLayout(tree: PanelLayoutTree): readonly string[] {
  if (tree === null) return [];
  const errors = new Set<string>();
  const stats: LayoutStats = {
    nodes: 0,
    panels: 0,
    nodeIds: new Set(),
    panelIds: new Set(),
    chatCount: 0,
    filesCount: 0,
    workpadsCount: 0,
    terminalsCount: 0,
  };
  collectValidation(tree, 0, stats, errors);
  if (stats.chatCount > 1 || stats.filesCount > 1 || stats.workpadsCount > 1 || stats.terminalsCount > 1)
    errors.add("singleton_panel_kinds");
  for (const nodeId of stats.nodeIds) {
    if (stats.panelIds.has(nodeId)) errors.add("unique_layout_ids");
  }
  return [...errors];
}

function normalizeNode(node: LayoutNode): LayoutNode {
  if (node.kind === "tabs") {
    return freezeStack({
      id: node.id,
      tabs: node.tabs,
      activePanelInstanceId: node.activePanelInstanceId,
    });
  }
  return freezeSplit({
    id: node.id,
    orientation: node.orientation,
    children: [
      normalizeNode(node.children[0]),
      normalizeNode(node.children[1]),
    ],
    sizes: normalizedSizes(node.sizes)!,
  });
}

export function normalizePanelLayout(tree: PanelLayoutTree): PanelLayoutTree {
  if (tree === null) return null;
  return validatePanelLayout(tree).length === 0
    ? normalizeNode(tree)
    : defaultPanelLayout;
}

function canonicalCurrent(tree: PanelLayoutTree): PanelLayoutTree {
  return validatePanelLayout(tree).length === 0
    ? tree
    : normalizePanelLayout(tree);
}

export function panelInstances(
  tree: PanelLayoutTree,
): readonly PanelInstance[] {
  if (tree === null) return [];
  if (tree.kind === "tabs") return tree.tabs;
  return [
    ...panelInstances(tree.children[0]),
    ...panelInstances(tree.children[1]),
  ];
}

export function panelIds(tree: PanelLayoutTree): readonly PanelInstanceId[] {
  return panelInstances(tree).map((panel) => panel.panelInstanceId);
}

export function findPanel(
  tree: PanelLayoutTree,
  panelInstanceId: PanelInstanceId,
): PanelInstance | undefined {
  return panelInstances(tree).find(
    (panel) => panel.panelInstanceId === panelInstanceId,
  );
}

export function findPanelByKind<K extends PanelKind>(
  tree: PanelLayoutTree,
  kind: K,
): Extract<PanelInstance, { kind: K }> | undefined {
  return panelInstances(tree).find(
    (panel): panel is Extract<PanelInstance, { kind: K }> =>
      panel.kind === kind,
  );
}

export function findStackForPanel(
  tree: PanelLayoutTree,
  panelInstanceId: PanelInstanceId,
): TabStackNode | undefined {
  if (tree === null) return undefined;
  if (tree.kind === "tabs") {
    return tree.tabs.some((panel) => panel.panelInstanceId === panelInstanceId)
      ? tree
      : undefined;
  }
  return (
    findStackForPanel(tree.children[0], panelInstanceId) ??
    findStackForPanel(tree.children[1], panelInstanceId)
  );
}

/** Replaces one panel's client-local state without changing layout topology. */
export function replacePanel(
  tree: PanelLayoutTree,
  replacement: PanelInstance,
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  const existing = findPanel(current, replacement.panelInstanceId);
  if (!current || !existing || existing.kind !== replacement.kind)
    return current;
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === "split") {
      const left = visit(node.children[0]);
      const right = visit(node.children[1]);
      return left === node.children[0] && right === node.children[1]
        ? node
        : freezeSplit({ ...node, children: [left, right] });
    }
    const index = node.tabs.findIndex(
      ({ panelInstanceId }) =>
        panelInstanceId === replacement.panelInstanceId,
    );
    if (index < 0) return node;
    const tabs = [...node.tabs];
    tabs[index] = replacement;
    return freezeStack({
      id: node.id,
      tabs,
      activePanelInstanceId: node.activePanelInstanceId,
    });
  };
  const result = visit(current);
  return validatePanelLayout(result).length === 0 ? result : current;
}

export function findNode(
  tree: PanelLayoutTree,
  nodeId: string,
): LayoutNode | undefined {
  if (tree === null) return undefined;
  if (tree.id === nodeId) return tree;
  if (tree.kind === "tabs") return undefined;
  return (
    findNode(tree.children[0], nodeId) ?? findNode(tree.children[1], nodeId)
  );
}

function firstStack(tree: LayoutNode): TabStackNode {
  return tree.kind === "tabs" ? tree : firstStack(tree.children[0]);
}

function panelFraction(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_PANEL_FRACTION;
  return Math.min(
    1 - MIN_POSITIVE_FRACTION,
    Math.max(MIN_POSITIVE_FRACTION, value),
  );
}

function splitAround(
  existing: LayoutNode,
  added: TabStackNode,
  splitId: string,
  edge: PanelPlacementEdge,
  preferredPanelFraction?: number,
): SplitNode {
  const addedSize = panelFraction(preferredPanelFraction);
  const addedFirst = edge === "left" || edge === "top";
  return freezeSplit({
    id: splitId,
    orientation: edge === "left" || edge === "right" ? "row" : "column",
    children: addedFirst ? [added, existing] : [existing, added],
    sizes: addedFirst ? [addedSize, 1 - addedSize] : [1 - addedSize, addedSize],
  });
}

function replaceNode(
  tree: LayoutNode,
  targetNodeId: string,
  replacement: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  if (tree.id === targetNodeId) return replacement(tree);
  if (tree.kind === "tabs") return tree;
  const left = replaceNode(tree.children[0], targetNodeId, replacement);
  const right = replaceNode(tree.children[1], targetNodeId, replacement);
  if (left === tree.children[0] && right === tree.children[1]) return tree;
  return freezeSplit({ ...tree, children: [left, right] });
}

function canAddPanel(tree: PanelLayoutTree, panel: PanelInstance): boolean {
  if (!validId(panel.panelInstanceId) || findPanel(tree, panel.panelInstanceId))
    return false;
  if (panel.kind === "terminals") {
    const errors = new Set<string>();
    validateTerminalContainer(panel, errors);
    if (errors.size > 0) return false;
  }
  return !(
    (panel.kind === "chat" || panel.kind === "files" || panel.kind === "workpads" || panel.kind === "terminals") &&
    findPanelByKind(tree, panel.kind)
  );
}

export function openPanel(
  tree: PanelLayoutTree,
  panel: PanelInstance,
  options: OpenPanelOptions,
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  if (!canAddPanel(current, panel)) return current;
  if (options.mode === "tab") {
    if (current === null) {
      if (!validId(options.stackId)) return current;
      return freezeStack({
        id: options.stackId,
        tabs: [panel],
        activePanelInstanceId: panel.panelInstanceId,
      });
    }
    const target = options.targetNodeId
      ? findNode(current, options.targetNodeId)
      : firstStack(current);
    if (target?.kind !== "tabs" || target.tabs.length >= MAX_TABS_PER_STACK)
      return current;
    const result = replaceNode(current, target.id, () =>
      freezeStack({
        id: target.id,
        tabs: [...target.tabs, panel],
        activePanelInstanceId: panel.panelInstanceId,
      }),
    );
    return validatePanelLayout(result).length === 0 ? result : current;
  }
  if (!validId(options.stackId)) return current;
  const added = freezeStack({
    id: options.stackId,
    tabs: [panel],
    activePanelInstanceId: panel.panelInstanceId,
  });
  if (current === null) return added;
  if (!validId(options.splitId)) return current;
  const targetId = options.targetNodeId ?? current.id;
  if (!findNode(current, targetId)) return current;
  const result = replaceNode(current, targetId, (target) =>
    splitAround(
      target,
      added,
      options.splitId!,
      options.edge,
      options.preferredPanelFraction,
    ),
  );
  return validatePanelLayout(result).length === 0 ? result : current;
}

function removePanel(
  node: LayoutNode,
  panelInstanceId: PanelInstanceId,
): LayoutNode | null {
  if (node.kind === "tabs") {
    const index = node.tabs.findIndex(
      (panel) => panel.panelInstanceId === panelInstanceId,
    );
    if (index < 0) return node;
    const tabs = node.tabs.filter((_, tabIndex) => tabIndex !== index);
    if (tabs.length === 0) return null;
    return freezeStack({
      id: node.id,
      tabs,
      activePanelInstanceId:
        node.activePanelInstanceId === panelInstanceId
          ? tabs[Math.min(index, tabs.length - 1)]!.panelInstanceId
          : node.activePanelInstanceId,
    });
  }
  const left = removePanel(node.children[0], panelInstanceId);
  const right = removePanel(node.children[1], panelInstanceId);
  if (left === node.children[0] && right === node.children[1]) return node;
  if (!left) return right;
  if (!right) return left;
  return freezeSplit({ ...node, children: [left, right] });
}

export function closePanel(
  tree: PanelLayoutTree,
  panelInstanceId: PanelInstanceId,
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  return current === null ? null : removePanel(current, panelInstanceId);
}

export function activatePanel(
  tree: PanelLayoutTree,
  panelInstanceId: PanelInstanceId,
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  const stack = findStackForPanel(current, panelInstanceId);
  if (!current || !stack || stack.activePanelInstanceId === panelInstanceId)
    return current;
  return replaceNode(current, stack.id, () =>
    freezeStack({
      id: stack.id,
      tabs: stack.tabs,
      activePanelInstanceId: panelInstanceId,
    }),
  );
}

export function dockPanel(
  tree: PanelLayoutTree,
  panelInstanceId: PanelInstanceId,
  edge: PanelPlacementEdge,
  options: DockPanelOptions = {},
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  const selected = findPanel(current, panelInstanceId);
  if (!current || !selected || panelInstances(current).length === 1)
    return current;
  if (!validId(options.splitId) || !validId(options.stackId)) return current;
  const without = closePanel(current, panelInstanceId);
  if (!without) return current;
  return openPanel(without, selected, {
    edge,
    splitId: options.splitId,
    stackId: options.stackId,
  });
}

export function resizeSplit(
  tree: PanelLayoutTree,
  splitId: string,
  sizes: readonly number[],
): PanelLayoutTree {
  const current = canonicalCurrent(tree);
  const target = findNode(current, splitId);
  if (!current || target?.kind !== "split") return current;
  const normalized = normalizedSizes(sizes);
  if (!normalized) return current;
  if (
    Math.abs(target.sizes[0] - normalized[0]) <= FRACTION_EPSILON &&
    Math.abs(target.sizes[1] - normalized[1]) <= FRACTION_EPSILON
  )
    return current;
  return replaceNode(current, splitId, () =>
    freezeSplit({ ...target, sizes: normalized }),
  );
}

export function reducePanelLayout(
  tree: PanelLayoutTree,
  action: PanelLayoutAction,
): PanelLayoutTree {
  switch (action.type) {
    case "openPanel":
      return openPanel(tree, action.panel, action.options);
    case "closePanel":
      return closePanel(tree, action.panelInstanceId);
    case "activatePanel":
      return activatePanel(tree, action.panelInstanceId);
    case "dockPanel":
      return dockPanel(
        tree,
        action.panelInstanceId,
        action.edge,
        action.options,
      );
    case "resizeSplit":
      return resizeSplit(tree, action.splitId, action.sizes);
  }
}

interface DecodeBudget extends LayoutStats {}

function decodePanel(
  input: unknown,
  budget: DecodeBudget,
): PanelInstance | null {
  if (!isRecord(input) || !validId(input.panelInstanceId)) return null;
  if (
    budget.panelIds.has(input.panelInstanceId) ||
    budget.nodeIds.has(input.panelInstanceId)
  )
    return null;
  budget.panels += 1;
  if (budget.panels > MAX_PANEL_INSTANCES) return null;
  budget.panelIds.add(input.panelInstanceId);
  if (input.kind === "chat") {
    budget.chatCount += 1;
    return budget.chatCount > 1
      ? null
      : freezePanel({ panelInstanceId: input.panelInstanceId, kind: "chat" });
  }
  if (input.kind === "files") {
    budget.filesCount += 1;
    return budget.filesCount > 1
      ? null
      : freezePanel({ panelInstanceId: input.panelInstanceId, kind: "files" });
  }
  if (input.kind === "workpads") {
    budget.workpadsCount += 1;
    return budget.workpadsCount > 1
      ? null
      : freezePanel({ panelInstanceId: input.panelInstanceId, kind: "workpads" });
  }
  if (
    input.kind === "terminals" &&
    input.panelInstanceId === "terminals" &&
    validId(input.threadId) &&
    Array.isArray(input.tabs) &&
    input.tabs.length <= MAX_TERMINAL_TABS &&
    (input.activeTerminalId === null || validId(input.activeTerminalId))
  ) {
    const terminalIds = new Set<string>();
    const producerIds = new Set<string>();
    const tabs: TerminalTab[] = [];
    for (const rawTab of input.tabs) {
      if (!isRecord(rawTab) || !validId(rawTab.terminalId)) return null;
      const producerId = terminalProducerIdSchema.safeParse(rawTab.producerId);
      if (
        !producerId.success ||
        terminalIds.has(rawTab.terminalId) ||
        producerIds.has(producerId.data)
      ) return null;
      terminalIds.add(rawTab.terminalId);
      producerIds.add(producerId.data);
      tabs.push({ terminalId: rawTab.terminalId, producerId: producerId.data });
    }
    if (
      tabs.length === 0
        ? input.activeTerminalId !== null
        : input.activeTerminalId === null || !terminalIds.has(input.activeTerminalId)
    ) return null;
    budget.terminalsCount += 1;
    if (budget.terminalsCount > 1) return null;
    return freezePanel({
      panelInstanceId: "terminals",
      kind: "terminals",
      threadId: input.threadId,
      tabs,
      activeTerminalId: input.activeTerminalId,
    });
  }
  return null;
}

function decodeNode(
  input: unknown,
  depth: number,
  budget: DecodeBudget,
): LayoutNode | null {
  if (!isRecord(input) || depth > MAX_LAYOUT_DEPTH || !validId(input.id))
    return null;
  budget.nodes += 1;
  if (
    budget.nodes > MAX_LAYOUT_NODES ||
    budget.nodeIds.has(input.id) ||
    budget.panelIds.has(input.id)
  )
    return null;
  budget.nodeIds.add(input.id);
  if (input.kind === "tabs") {
    if (
      !Array.isArray(input.tabs) ||
      input.tabs.length === 0 ||
      input.tabs.length > MAX_TABS_PER_STACK ||
      !validId(input.activePanelInstanceId)
    )
      return null;
    const tabs: PanelInstance[] = [];
    for (const rawPanel of input.tabs) {
      const panel = decodePanel(rawPanel, budget);
      if (!panel) return null;
      tabs.push(panel);
    }
    if (
      !tabs.some(
        (panel) => panel.panelInstanceId === input.activePanelInstanceId,
      )
    )
      return null;
    return freezeStack({
      id: input.id,
      tabs,
      activePanelInstanceId: input.activePanelInstanceId,
    });
  }
  if (
    input.kind !== "split" ||
    (input.orientation !== "row" && input.orientation !== "column") ||
    !Array.isArray(input.children) ||
    input.children.length !== 2 ||
    !Array.isArray(input.sizes) ||
    input.sizes.some((value) => typeof value !== "number")
  )
    return null;
  const sizes = normalizedSizes(input.sizes as number[]);
  if (!sizes) return null;
  const left = decodeNode(input.children[0], depth + 1, budget);
  const right = decodeNode(input.children[1], depth + 1, budget);
  return left && right
    ? freezeSplit({
        id: input.id,
        orientation: input.orientation,
        children: [left, right],
        sizes,
      })
    : null;
}

export function serializePanelLayout(
  threadId: string,
  tree: PanelLayoutTree,
): string {
  if (!validId(threadId)) throw new Error("invalid_panel_layout_thread_id");
  const terminalContainer = findPanelByKind(tree, "terminals");
  if (terminalContainer && terminalContainer.threadId !== threadId)
    throw new Error("panel_layout_thread_mismatch");
  const envelope: PanelLayoutEnvelope = {
    version: PANEL_LAYOUT_VERSION,
    threadId,
    tree: normalizePanelLayout(tree),
  };
  return JSON.stringify(envelope);
}

/** Loads only the current panel-instance format. Older layout keys are not read. */
export function deserializePanelLayout(
  threadId: string,
  serialized: string | null,
): PanelLayoutTree {
  if (!validId(threadId)) return defaultPanelLayout;
  if (serialized === null) return defaultPanelLayout;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      parsed.version !== PANEL_LAYOUT_VERSION ||
      parsed.threadId !== threadId
    )
      return defaultPanelLayout;
    if (parsed.tree === null) return null;
    const decoded = (
      decodeNode(parsed.tree, 0, {
        nodes: 0,
        panels: 0,
        nodeIds: new Set(),
        panelIds: new Set(),
        chatCount: 0,
        filesCount: 0,
        workpadsCount: 0,
        terminalsCount: 0,
      }) ?? defaultPanelLayout
    );
    const terminalContainer = findPanelByKind(decoded, "terminals");
    return terminalContainer && terminalContainer.threadId !== threadId
      ? defaultPanelLayout
      : decoded;
  } catch {
    return defaultPanelLayout;
  }
}
import { terminalProducerIdSchema } from "../../shared/index.js";
