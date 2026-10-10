import type { WorkspacePanelTenantRegistry } from "./registry.js";
import {
  PANEL_KINDS,
  SHARED_PANEL_KINDS,
  clampPanelShare,
  effectiveMaximized,
  regionAxis,
  regionPanel,
  tenantIdForKind,
  type EdgeRegion,
  type PanelKind,
  type RegionId,
  type RegionView,
  type SizeAxis,
} from "./regions.js";

/**
 * Region geometry: where each visible region sits on the desktop stage.
 *
 * The edge regions wrap the Middle in the layout's extend order, outermost
 * first: each visible edge region is peeled off the space left by the ones
 * outside it, along its own axis, and the Middle takes the rest. An edge
 * region is as wide (Left/Right) or as tall (Top/Bottom) as its panel's
 * remembered share of the stage, or its default size, but never below its
 * minimum and never so large that the regions inside it lose theirs. When
 * the Middle shows nothing, the innermost visible edge region takes the rest
 * instead, so the stage never has a hole.
 *
 * Make-room: when the visible panels' minimums do not fit the stage, edge
 * regions are hidden, least recently shown or used first. Every edge region
 * but Chat's may go, the one just opened included when nothing else makes
 * room; the Middle and Chat, wherever it lives, never do. Of the sets of
 * regions whose hiding makes the layout fit, make-room hides the one whose
 * most recently used region is least recent, then the smallest: so it hides
 * older regions together before a newer one, and never a region the fit
 * does not need. Hiding is derived from the stage size and never stored: the
 * panels stay loaded and their regions keep showing them, so they return
 * when the stage has room. When no set fits, it hides the set that leaves
 * the least overflow, by the same preferences, and the remaining minimums
 * shrink together in proportion.
 *
 * Maximize fills the whole stage with one panel and skips all of this.
 */

/** The divider between an edge region and the space inside it. */
export const REGION_HANDLE_SIZE = 5;
export const CHAT_MIN_WIDTH = 360;
/** Chat's height floor, Terminals' floor, and any unknown panel's. */
export const MIN_PANEL_SIZE = 160;
/** A panel without a remembered or preferred size takes this share. */
export const DEFAULT_PANEL_SHARE = 0.3;

/** A panel kind's minimum and default size, in pixels. */
export interface PanelSizeHint {
  readonly minWidth: number;
  readonly minHeight: number;
  readonly preferredWidth?: number;
  readonly preferredHeight?: number;
  /**
   * The default share of the stage along the region's axis, kept between
   * the minimum and the preferred size (tenant semantics). Without a
   * preferred size, the share applies above the minimum.
   */
  readonly preferredShare?: number;
}

export type PanelSizeHints = Readonly<Record<PanelKind, PanelSizeHint>>;

export const DEFAULT_PANEL_SIZE_HINTS: PanelSizeHints = Object.freeze({
  chat: Object.freeze({
    minWidth: CHAT_MIN_WIDTH,
    minHeight: MIN_PANEL_SIZE,
    preferredShare: 0.4,
  }),
  files: Object.freeze({
    minWidth: 320,
    minHeight: 240,
    preferredWidth: 520,
    preferredHeight: 560,
  }),
  workpads: Object.freeze({
    minWidth: 320,
    minHeight: 240,
    preferredWidth: 480,
    preferredHeight: 560,
    preferredShare: 0.4,
  }),
  tasks: Object.freeze({
    minWidth: 300,
    minHeight: 240,
    preferredWidth: 380,
    preferredHeight: 480,
    preferredShare: 0.35,
  }),
  terminals: Object.freeze({
    minWidth: MIN_PANEL_SIZE,
    minHeight: MIN_PANEL_SIZE,
  }),
});

/** Size hints with Files, Workpads and Tasks from their tenants' `size`. */
export function panelSizeHints(
  registry: Pick<WorkspacePanelTenantRegistry, "tenant">,
): PanelSizeHints {
  const hints: Record<PanelKind, PanelSizeHint> = { ...DEFAULT_PANEL_SIZE_HINTS };
  for (const kind of SHARED_PANEL_KINDS) {
    const size = registry.tenant(tenantIdForKind(kind))?.size;
    if (!size) continue;
    hints[kind] = Object.freeze({
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      preferredWidth: size.preferredWidth,
      preferredHeight: size.preferredHeight,
      ...(size.preferredShare === undefined
        ? {}
        : { preferredShare: size.preferredShare }),
    });
  }
  return Object.freeze(hints);
}

export interface RegionStage {
  readonly width: number;
  readonly height: number;
}

export interface RegionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A visible panel and the box its region takes. */
export interface RegionPanelBox {
  readonly region: RegionId;
  readonly kind: PanelKind;
  readonly box: RegionBox;
}

/** The divider on an edge region's inner side, which resizes its panel. */
export interface RegionResizeHandle {
  readonly region: EdgeRegion;
  /** The kind whose remembered size the divider changes. */
  readonly kind: PanelKind;
  readonly axis: SizeAxis;
  /** The divider's own box. */
  readonly box: RegionBox;
  /** The panel's current size along `axis`, in pixels. */
  readonly size: number;
  /** Bounds for dragging, in pixels. */
  readonly min: number;
  readonly max: number;
  /** The stage's length along `axis`: a remembered share is `size / stageLength`. */
  readonly stageLength: number;
}

/**
 * A nested description of the stage. A split peels one edge region off its
 * box: a row for Left/Right, a column for Top/Bottom, with the edge panel
 * first for Left/Top. `rest` lays out what is inside it.
 */
export type RegionLayoutNode =
  | { readonly type: "panel"; readonly box: RegionBox; readonly panel: RegionPanelBox }
  | { readonly type: "empty"; readonly box: RegionBox }
  | {
      readonly type: "split";
      readonly box: RegionBox;
      readonly region: EdgeRegion;
      readonly direction: "row" | "column";
      readonly edgeFirst: boolean;
      readonly edge: RegionPanelBox;
      readonly handle: RegionResizeHandle;
      readonly rest: RegionLayoutNode;
    };

export interface RegionGeometry {
  readonly stage: RegionStage;
  readonly root: RegionLayoutNode;
  /** Visible panels, outermost first; the Middle (or the filler) last. */
  readonly panels: readonly RegionPanelBox[];
  readonly handles: readonly RegionResizeHandle[];
  /** Panels make-room hid, least recently shown or used first. */
  readonly hiddenByMakeRoom: readonly PanelKind[];
  readonly maximized: PanelKind | null;
  /** The kept panels' minimums did not fit and were shrunk together. */
  readonly overflow: boolean;
}

export interface RegionGeometryOptions {
  readonly handleSize?: number;
}

interface PlacedEdge {
  readonly region: EdgeRegion;
  readonly kind: PanelKind;
}

interface Arrangement {
  readonly edges: readonly PlacedEdge[];
  readonly middle: PanelKind | null;
}

const EPSILON = 1e-6;
const NO_KINDS: readonly PanelKind[] = Object.freeze([]);

export function computeRegionGeometry(
  view: RegionView,
  stage: RegionStage,
  hints: PanelSizeHints = DEFAULT_PANEL_SIZE_HINTS,
  options: RegionGeometryOptions = {},
): RegionGeometry {
  const handleSize = options.handleSize ?? REGION_HANDLE_SIZE;
  const size = {
    width: Math.max(0, stage.width),
    height: Math.max(0, stage.height),
  };
  const full: RegionBox = { x: 0, y: 0, ...size };
  const maximized = effectiveMaximized(view);
  if (maximized !== null) {
    const panel: RegionPanelBox = {
      region: view.layout.placement[maximized],
      kind: maximized,
      box: full,
    };
    return {
      stage: size,
      root: { type: "panel", box: full, panel },
      panels: [panel],
      handles: [],
      hiddenByMakeRoom: NO_KINDS,
      maximized,
      overflow: false,
    };
  }
  const shown = shownArrangement(view);
  const hidden = makeRoom(view, shown, size, hints, handleSize);
  const arrangement: Arrangement = hidden.length
    ? { ...shown, edges: shown.edges.filter(({ kind }) => !hidden.includes(kind)) }
    : shown;
  const panels: RegionPanelBox[] = [];
  const handles: RegionResizeHandle[] = [];
  const context: BuildContext = {
    view,
    stage: size,
    hints,
    handleSize,
    arrangement,
    panels,
    handles,
  };
  const root = build(context, 0, full);
  return {
    stage: size,
    root,
    panels,
    handles,
    hiddenByMakeRoom: hidden.length ? hidden : NO_KINDS,
    maximized: null,
    overflow:
      overflowOf(arrangement, size, hints, handleSize) > EPSILON,
  };
}

/** The panels make-room hides on a stage of this size, in hiding order. */
export function hiddenByMakeRoom(
  view: RegionView,
  stage: RegionStage,
  hints: PanelSizeHints = DEFAULT_PANEL_SIZE_HINTS,
  options: RegionGeometryOptions = {},
): readonly PanelKind[] {
  if (effectiveMaximized(view) !== null) return NO_KINDS;
  return makeRoom(
    view,
    shownArrangement(view),
    stage,
    hints,
    options.handleSize ?? REGION_HANDLE_SIZE,
  );
}

/**
 * The share to remember when a divider is dragged to `size` pixels: kept
 * within the divider's bounds and the share bounds.
 */
export function shareForHandleSize(
  handle: RegionResizeHandle,
  size: number,
): number {
  const clamped = Math.min(handle.max, Math.max(handle.min, size));
  return handle.stageLength > 0
    ? clampPanelShare(clamped / handle.stageLength)
    : clampPanelShare(0);
}

/** The minimum width and height of the visible layout. */
export function regionMinimums(
  view: RegionView,
  hints: PanelSizeHints = DEFAULT_PANEL_SIZE_HINTS,
  options: RegionGeometryOptions = {},
): RegionStage {
  const arrangement = shownArrangement(view);
  const handleSize = options.handleSize ?? REGION_HANDLE_SIZE;
  return {
    width: need(arrangement, 0, "width", hints, handleSize),
    height: need(arrangement, 0, "height", hints, handleSize),
  };
}

function shownArrangement(view: RegionView): Arrangement {
  const edges: PlacedEdge[] = [];
  for (const region of view.layout.extendOrder) {
    const kind = regionPanel(view, region);
    if (kind !== null) edges.push({ region, kind });
  }
  return { edges, middle: regionPanel(view, "middle") };
}

function minimum(hints: PanelSizeHints, kind: PanelKind, axis: SizeAxis): number {
  const hint = hints[kind];
  return Math.max(0, axis === "width" ? hint.minWidth : hint.minHeight);
}

/** The minimum length, along `axis`, of the layout from edge `index` inward. */
function need(
  arrangement: Arrangement,
  index: number,
  axis: SizeAxis,
  hints: PanelSizeHints,
  handleSize: number,
): number {
  const edge = arrangement.edges[index];
  if (!edge)
    return arrangement.middle === null
      ? 0
      : minimum(hints, arrangement.middle, axis);
  const own = minimum(hints, edge.kind, axis);
  const hasInner =
    index + 1 < arrangement.edges.length || arrangement.middle !== null;
  if (!hasInner) return own;
  const inner = need(arrangement, index + 1, axis, hints, handleSize);
  return regionAxis(edge.region) === axis
    ? own + handleSize + inner
    : Math.max(own, inner);
}

function overflowOf(
  arrangement: Arrangement,
  stage: RegionStage,
  hints: PanelSizeHints,
  handleSize: number,
): number {
  return (
    Math.max(0, need(arrangement, 0, "width", hints, handleSize) - stage.width) +
    Math.max(0, need(arrangement, 0, "height", hints, handleSize) - stage.height)
  );
}

function makeRoom(
  view: RegionView,
  arrangement: Arrangement,
  stage: RegionStage,
  hints: PanelSizeHints,
  handleSize: number,
): PanelKind[] {
  // An unmeasured stage has no room to make.
  if (stage.width <= 0 || stage.height <= 0) return [];
  if (overflowOf(arrangement, stage, hints, handleSize) <= EPSILON) return [];
  const { recency } = view.layout;
  const used = (kind: PanelKind) => recency.indexOf(kind);
  // Every edge region but Chat's, least recently shown or used first.
  const candidates = arrangement.edges
    .filter(({ kind }) => kind !== "chat")
    .sort(
      (left, right) =>
        used(left.kind) - used(right.kind) ||
        PANEL_KINDS.indexOf(left.kind) - PANEL_KINDS.indexOf(right.kind),
    );
  // At most four candidates: every subset can be weighed.
  let best: HidingChoice | undefined;
  for (let mask = 0; mask < 1 << candidates.length; mask += 1) {
    const ranks = candidates
      .map((_, rank) => rank)
      .filter((rank) => mask & (1 << rank));
    const hidden = new Set(ranks.map((rank) => candidates[rank]!));
    const choice: HidingChoice = {
      ranks,
      overflow: overflowOf(
        { ...arrangement, edges: arrangement.edges.filter((edge) => !hidden.has(edge)) },
        stage,
        hints,
        handleSize,
      ),
    };
    if (!best || betterHiding(choice, best)) best = choice;
  }
  return best!.ranks.map((rank) => candidates[rank]!.kind);
}

interface HidingChoice {
  /** Hidden candidates' recency ranks, least recent first. */
  readonly ranks: readonly number[];
  readonly overflow: number;
}

/**
 * Least overflow (a fit is none); then the least recent most recently used
 * region, so older regions go together before a newer one; then the fewest
 * regions; then the older ones.
 */
function betterHiding(choice: HidingChoice, best: HidingChoice): boolean {
  const fit = (overflow: number) => (overflow <= EPSILON ? 0 : overflow);
  const overflow = fit(choice.overflow) - fit(best.overflow);
  if (Math.abs(overflow) > EPSILON) return overflow < 0;
  const latest = (ranks: readonly number[]) => ranks.at(-1) ?? -1;
  if (latest(choice.ranks) !== latest(best.ranks))
    return latest(choice.ranks) < latest(best.ranks);
  if (choice.ranks.length !== best.ranks.length)
    return choice.ranks.length < best.ranks.length;
  for (let index = choice.ranks.length - 1; index >= 0; index -= 1)
    if (choice.ranks[index] !== best.ranks[index])
      return choice.ranks[index]! < best.ranks[index]!;
  return false;
}

interface BuildContext {
  readonly view: RegionView;
  readonly stage: RegionStage;
  readonly hints: PanelSizeHints;
  readonly handleSize: number;
  readonly arrangement: Arrangement;
  readonly panels: RegionPanelBox[];
  readonly handles: RegionResizeHandle[];
}

function preferredSize(
  context: BuildContext,
  kind: PanelKind,
  axis: SizeAxis,
): number {
  const stageLength = context.stage[axis];
  const share = context.view.layout.sizes[kind]?.[axis];
  if (share !== undefined) return share * stageLength;
  const hint = context.hints[kind];
  const min = minimum(context.hints, kind, axis);
  const preferred =
    axis === "width" ? hint.preferredWidth : hint.preferredHeight;
  if (preferred === undefined)
    return Math.max(min, (hint.preferredShare ?? DEFAULT_PANEL_SHARE) * stageLength);
  if (hint.preferredShare === undefined) return preferred;
  return Math.min(preferred, Math.max(min, hint.preferredShare * stageLength));
}

function build(context: BuildContext, index: number, box: RegionBox): RegionLayoutNode {
  const { arrangement, handleSize, hints } = context;
  const edge = arrangement.edges[index];
  if (!edge) {
    if (arrangement.middle === null) return { type: "empty", box };
    const panel: RegionPanelBox = { region: "middle", kind: arrangement.middle, box };
    context.panels.push(panel);
    return { type: "panel", box, panel };
  }
  const hasInner =
    index + 1 < arrangement.edges.length || arrangement.middle !== null;
  if (!hasInner) {
    // The innermost region fills the space the empty Middle leaves.
    const panel: RegionPanelBox = { region: edge.region, kind: edge.kind, box };
    context.panels.push(panel);
    return { type: "panel", box, panel };
  }
  const axis = regionAxis(edge.region);
  const length = box[axis];
  const available = Math.max(0, length - handleSize);
  const own = minimum(hints, edge.kind, axis);
  const inner = need(arrangement, index + 1, axis, hints, handleSize);
  const scale =
    own + inner > available && own + inner > 0 ? available / (own + inner) : 1;
  const min = own * scale;
  const max = Math.max(min, available - inner * scale);
  const size = Math.min(max, Math.max(min, preferredSize(context, edge.kind, axis)));
  const restLength = Math.max(0, available - size);
  const edgeFirst = edge.region === "left" || edge.region === "top";
  let edgeBox: RegionBox;
  let handleBox: RegionBox;
  let restBox: RegionBox;
  if (axis === "width") {
    const edgeX = edgeFirst ? box.x : box.x + box.width - size;
    const handleX = edgeFirst ? box.x + size : edgeX - handleSize;
    const restX = edgeFirst ? handleX + handleSize : box.x;
    edgeBox = { x: edgeX, y: box.y, width: size, height: box.height };
    handleBox = { x: handleX, y: box.y, width: handleSize, height: box.height };
    restBox = { x: restX, y: box.y, width: restLength, height: box.height };
  } else {
    const edgeY = edgeFirst ? box.y : box.y + box.height - size;
    const handleY = edgeFirst ? box.y + size : edgeY - handleSize;
    const restY = edgeFirst ? handleY + handleSize : box.y;
    edgeBox = { x: box.x, y: edgeY, width: box.width, height: size };
    handleBox = { x: box.x, y: handleY, width: box.width, height: handleSize };
    restBox = { x: box.x, y: restY, width: box.width, height: restLength };
  }
  const panel: RegionPanelBox = { region: edge.region, kind: edge.kind, box: edgeBox };
  const handle: RegionResizeHandle = {
    region: edge.region,
    kind: edge.kind,
    axis,
    box: handleBox,
    size,
    min,
    max,
    stageLength: context.stage[axis],
  };
  context.panels.push(panel);
  context.handles.push(handle);
  return {
    type: "split",
    box,
    region: edge.region,
    direction: axis === "width" ? "row" : "column",
    edgeFirst,
    edge: panel,
    handle,
    rest: build(context, index + 1, restBox),
  };
}
