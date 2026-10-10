/**
 * Panel regions: the desktop stage's pure layout model.
 *
 * The stage has five regions: Middle, and the edge regions Left, Right, Top
 * and Bottom around it. Every panel kind is a singleton with one placement,
 * the region it opens in, kept for this device across every thread. Each
 * region shows at most one panel; opening a panel shows it in its region and
 * hides, without unloading, whatever that region showed. Nothing returns on
 * its own: hiding, closing or moving a panel away leaves its region empty.
 *
 * Chat is always loaded (its ✕ only hides it). Files, Workpads and Tasks are
 * loaded for the whole device. Terminals belong to a thread, so a thread's
 * view combines the device layout with that thread's terminals; a region
 * whose shown panel is not loaded in the current thread renders empty.
 *
 * Every operation is pure and returns the next state, or the same object
 * when nothing changed. Make-room (see region-geometry.ts) is derived from
 * the stage size, never stored.
 */

export type PanelKind = "chat" | "files" | "workpads" | "tasks" | "terminals";
/** Kinds loaded for the whole device, in their fixed order. */
export type SharedPanelKind = "files" | "workpads" | "tasks";
export type RegionId = "middle" | "left" | "right" | "top" | "bottom";
export type EdgeRegion = Exclude<RegionId, "middle">;
export type SizeAxis = "width" | "height";

/** Every panel kind, in the toolbar's fixed order. */
export const PANEL_KINDS: readonly PanelKind[] = Object.freeze([
  "chat",
  "files",
  "workpads",
  "tasks",
  "terminals",
]);
export const SHARED_PANEL_KINDS: readonly SharedPanelKind[] = Object.freeze([
  "files",
  "workpads",
  "tasks",
]);
export const REGION_IDS: readonly RegionId[] = Object.freeze([
  "middle",
  "left",
  "right",
  "top",
  "bottom",
]);
export const EDGE_REGIONS: readonly EdgeRegion[] = Object.freeze([
  "left",
  "right",
  "top",
  "bottom",
]);

export const MAX_TERMINAL_TABS = 24;
/** Bounds for a remembered size, as a share of the stage along its axis. */
export const MIN_PANEL_SHARE = 0.05;
export const MAX_PANEL_SHARE = 0.95;
const MAX_ID_LENGTH = 160;

export interface TerminalTab {
  readonly terminalId: string;
  /** Stable per tab so reconnects retain one input sequence space. */
  readonly producerId: string;
}

/** A thread's loaded Terminals panel. */
export interface TerminalsPanelState {
  readonly tabs: readonly TerminalTab[];
  readonly activeTerminalId: string | null;
}

/** A remembered size per axis: a share of the stage's width or height. */
export type PanelSize = Readonly<Partial<Record<SizeAxis, number>>>;
export type PanelSizes = Readonly<Partial<Record<PanelKind, PanelSize>>>;
export type RegionPlacement = Readonly<Record<PanelKind, RegionId>>;
export type RegionShown = Readonly<Record<RegionId, PanelKind | null>>;

/** The parts of the device layout that are saved. */
export interface PersistedRegionLayout {
  /** Where each kind opens. */
  readonly placement: RegionPlacement;
  /**
   * The kind each region shows. A region only shows a kind placed there;
   * Files, Workpads and Tasks only while loaded. Chat and Terminals may be
   * shown while not loaded in a thread: Chat is always loaded, and the
   * region then renders empty in a thread without Terminals.
   */
  readonly shown: RegionShown;
  /** Loaded device-wide kinds, in `SHARED_PANEL_KINDS` order. */
  readonly loaded: readonly SharedPanelKind[];
  /** The edge regions, outermost first: see `isExtended`. */
  readonly extendOrder: readonly EdgeRegion[];
  /** Remembered sizes: a width for Left/Right, a height for Top/Bottom. */
  readonly sizes: PanelSizes;
}

/** The device layout: shared by every thread on this device. */
export interface RegionLayout extends PersistedRegionLayout {
  /** The panel filling the stage, if any. Never saved. */
  readonly maximized: PanelKind | null;
  /** Kinds from least to most recently shown or used. Never saved. */
  readonly recency: readonly PanelKind[];
}

/** One thread's view: the device layout plus the thread's own Terminals. */
export interface RegionView {
  readonly layout: RegionLayout;
  /** The thread's Terminals panel, or null while it is not loaded. */
  readonly terminals: TerminalsPanelState | null;
}

export type PanelLoadState = "visible" | "hidden" | "closed";

export const DEFAULT_PLACEMENT: RegionPlacement = Object.freeze({
  chat: "middle",
  files: "right",
  workpads: "right",
  tasks: "right",
  terminals: "bottom",
});

/**
 * Chat in the Middle; the Bottom's pick is Terminals, which shows only in a
 * thread whose Terminals panel is loaded. Every other region is empty.
 */
export const DEFAULT_SHOWN: RegionShown = Object.freeze({
  middle: "chat",
  left: null,
  right: null,
  top: null,
  bottom: "terminals",
});

/** Sides outermost: they run full height and Top/Bottom span the Middle. */
export const DEFAULT_EXTEND_ORDER: readonly EdgeRegion[] = EDGE_REGIONS;

const NO_SIZES: PanelSizes = Object.freeze({});
const NO_KINDS: readonly PanelKind[] = Object.freeze([]);
const NO_SHARED: readonly SharedPanelKind[] = Object.freeze([]);

export const EMPTY_TERMINALS: TerminalsPanelState = Object.freeze({
  tabs: Object.freeze([]) as readonly TerminalTab[],
  activeTerminalId: null,
});

export function defaultRegionLayout(sizes: PanelSizes = NO_SIZES): RegionLayout {
  return freezeLayout({
    placement: DEFAULT_PLACEMENT,
    shown: DEFAULT_SHOWN,
    loaded: NO_SHARED,
    extendOrder: DEFAULT_EXTEND_ORDER,
    sizes,
    maximized: null,
    recency: NO_KINDS,
  });
}

export function defaultRegionView(): RegionView {
  return Object.freeze({ layout: defaultRegionLayout(), terminals: null });
}

export function isPanelKind(value: unknown): value is PanelKind {
  return (PANEL_KINDS as readonly unknown[]).includes(value);
}

export function isSharedPanelKind(value: unknown): value is SharedPanelKind {
  return (SHARED_PANEL_KINDS as readonly unknown[]).includes(value);
}

export function isRegionId(value: unknown): value is RegionId {
  return (REGION_IDS as readonly unknown[]).includes(value);
}

export function isEdgeRegion(value: unknown): value is EdgeRegion {
  return (EDGE_REGIONS as readonly unknown[]).includes(value);
}

/** The axis an edge region's size runs along. */
export function regionAxis(region: EdgeRegion): SizeAxis {
  return region === "left" || region === "right" ? "width" : "height";
}

/** The workspace panel tenant that renders a device-wide kind. */
export function tenantIdForKind(kind: SharedPanelKind): string {
  return kind === "files" ? "workspace-files" : kind;
}

/** The legacy panel instance ID, still used for DOM IDs and tenant hosts. */
export function panelIdForKind(kind: PanelKind): string {
  return kind === "files" ? "workspace-files" : kind;
}

export function kindForPanelId(panelId: string): PanelKind | undefined {
  if (panelId === "workspace-files") return "files";
  return panelId !== "files" && isPanelKind(panelId) ? panelId : undefined;
}

export function clampPanelShare(share: number): number {
  return Math.min(MAX_PANEL_SHARE, Math.max(MIN_PANEL_SHARE, share));
}

export function isValidPanelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

// ---------------------------------------------------------------------------
// Queries

export function isLoaded(view: RegionView, kind: PanelKind): boolean {
  if (kind === "chat") return true;
  if (kind === "terminals") return view.terminals !== null;
  return view.layout.loaded.includes(kind);
}

/** Loaded and picked by its region, before make-room and Maximize. */
export function isShown(view: RegionView, kind: PanelKind): boolean {
  return (
    isLoaded(view, kind) &&
    view.layout.shown[view.layout.placement[kind]] === kind
  );
}

/** The kind a region renders in this view, or null when it renders empty. */
export function regionPanel(view: RegionView, region: RegionId): PanelKind | null {
  const kind = view.layout.shown[region];
  return kind !== null && isLoaded(view, kind) ? kind : null;
}

/** The maximized panel when it is loaded in this view. */
export function effectiveMaximized(view: RegionView): PanelKind | null {
  const kind = view.layout.maximized;
  return kind !== null && isLoaded(view, kind) ? kind : null;
}

/**
 * Whether a panel is on stage: loaded, its region shows it, make-room has not
 * hidden it, and no other panel is maximized. A maximized panel is visible
 * whatever its region shows.
 */
export function isVisible(
  view: RegionView,
  kind: PanelKind,
  hiddenByMakeRoom: Iterable<PanelKind> = NO_KINDS,
): boolean {
  if (!isLoaded(view, kind)) return false;
  const maximized = effectiveMaximized(view);
  if (maximized !== null) return maximized === kind;
  return isShown(view, kind) && !new Set(hiddenByMakeRoom).has(kind);
}

export function loadedPanels(view: RegionView): readonly PanelKind[] {
  return PANEL_KINDS.filter((kind) => isLoaded(view, kind));
}

export function visiblePanels(
  view: RegionView,
  hiddenByMakeRoom: Iterable<PanelKind> = NO_KINDS,
): readonly PanelKind[] {
  const hidden = new Set(hiddenByMakeRoom);
  return PANEL_KINDS.filter((kind) => isVisible(view, kind, hidden));
}

/** A launcher row's state: visible, loaded but hidden, or closed. */
export function panelLoadState(
  view: RegionView,
  kind: PanelKind,
  hiddenByMakeRoom: Iterable<PanelKind> = NO_KINDS,
): PanelLoadState {
  if (!isLoaded(view, kind)) return "closed";
  return isVisible(view, kind, hiddenByMakeRoom) ? "visible" : "hidden";
}

/**
 * Whether an edge region takes the corners it shares with its perpendicular
 * neighbours: it is outside each of them in the extend order. Left and Right
 * share corners with Top and Bottom, and the reverse.
 */
export function isExtended(
  extendOrder: readonly EdgeRegion[],
  region: EdgeRegion,
): boolean {
  const index = extendOrder.indexOf(region);
  const neighbours: readonly EdgeRegion[] =
    regionAxis(region) === "width" ? ["top", "bottom"] : ["left", "right"];
  return (
    index >= 0 &&
    neighbours.every((neighbour) => index < extendOrder.indexOf(neighbour))
  );
}

/**
 * The phone's foreground panel: the requested one (a focus request), else
 * the selected one, when it is shown; otherwise the first shown panel in the
 * fixed order. Regions, make-room and Maximize do not apply on phones.
 */
export function chooseForegroundPanel(
  view: RegionView,
  options: {
    readonly selected?: PanelKind;
    readonly requested?: PanelKind;
  } = {},
): PanelKind | undefined {
  const candidates = PANEL_KINDS.filter((kind) => isShown(view, kind));
  const preferred = options.requested ?? options.selected;
  return preferred !== undefined && candidates.includes(preferred)
    ? preferred
    : candidates[0];
}

// ---------------------------------------------------------------------------
// Operations

/**
 * Loads a panel if needed and shows it in its region, replacing (hiding, not
 * unloading) what the region showed. With `region`, the panel first moves
 * there: that becomes its placement, and its old region, if it showed the
 * panel, becomes empty. Opening another panel (or moving the maximized one)
 * ends Maximize; opening the maximized panel in place keeps it, so a new
 * terminal tab or a file link inside it does not restore the layout.
 * Opening marks the panel the most recently shown.
 */
export function openPanel(
  view: RegionView,
  kind: PanelKind,
  region?: RegionId,
): RegionView {
  const { layout } = view;
  const target = region ?? layout.placement[kind];
  const from = layout.placement[kind];
  const keepsMaximized =
    layout.maximized === kind && from === target && isLoaded(view, kind);
  const shown: Record<RegionId, PanelKind | null> = { ...layout.shown };
  if (from !== target && shown[from] === kind) shown[from] = null;
  shown[target] = kind;
  return withView(view, {
    layout: {
      placement:
        from === target ? layout.placement : { ...layout.placement, [kind]: target },
      shown,
      loaded:
        isSharedPanelKind(kind) ? withLoaded(layout.loaded, kind) : layout.loaded,
      maximized: keepsMaximized ? kind : null,
      recency: withRecent(layout.recency, kind),
    },
    terminals:
      kind === "terminals" ? (view.terminals ?? EMPTY_TERMINALS) : view.terminals,
  });
}

/**
 * The quick button: a visible panel hides (its region shows nothing and it
 * stays loaded); a loaded panel that is not visible shows in its region; a
 * closed panel opens. Hiding the maximized panel also ends Maximize.
 */
export function togglePanel(
  view: RegionView,
  kind: PanelKind,
  hiddenByMakeRoom: Iterable<PanelKind> = NO_KINDS,
): RegionView {
  if (!isVisible(view, kind, hiddenByMakeRoom)) return openPanel(view, kind);
  return hidePanel(view, kind);
}

/** Hides a panel without unloading it: its region, if it showed it, empties. */
export function hidePanel(view: RegionView, kind: PanelKind): RegionView {
  const { layout } = view;
  const region = layout.placement[kind];
  return withView(view, {
    layout: {
      shown:
        layout.shown[region] === kind
          ? { ...layout.shown, [region]: null }
          : layout.shown,
      maximized: layout.maximized === kind ? null : layout.maximized,
    },
  });
}

/**
 * The header's ✕. Chat only hides. Any other panel unloads: Files, Workpads
 * and Tasks for the device, Terminals (with its tabs) for this thread, and
 * its region, if it showed it, empties. Nothing takes its place.
 */
export function closePanel(view: RegionView, kind: PanelKind): RegionView {
  if (kind === "chat") return hidePanel(view, kind);
  if (!isLoaded(view, kind)) return view;
  const hidden = hidePanel(view, kind);
  const { layout } = hidden;
  return withView(hidden, {
    layout: {
      loaded: layout.loaded.filter((loaded) => loaded !== kind),
      recency: layout.recency.filter((recent) => recent !== kind),
    },
    terminals: kind === "terminals" ? null : hidden.terminals,
  });
}

/**
 * ⋯ → Move to: sets the panel's placement. A loaded panel (or one its old
 * region still shows) shows in the new region, replacing what it showed,
 * and its old region empties. Moving ends Maximize.
 */
export function movePanel(
  view: RegionView,
  kind: PanelKind,
  region: RegionId,
): RegionView {
  const { layout } = view;
  const from = layout.placement[kind];
  const loaded = isLoaded(view, kind);
  const wasShown = layout.shown[from] === kind;
  let shown = layout.shown;
  if (loaded || wasShown) {
    const next: Record<RegionId, PanelKind | null> = { ...layout.shown };
    if (next[from] === kind) next[from] = null;
    next[region] = kind;
    shown = next;
  }
  return withView(view, {
    layout: {
      placement:
        from === region ? layout.placement : { ...layout.placement, [kind]: region },
      shown,
      maximized: null,
      recency: loaded ? withRecent(layout.recency, kind) : layout.recency,
    },
  });
}

/**
 * Fills the stage with a loaded panel; every other panel stays loaded behind
 * it. The layout itself is unchanged, so Restore returns it exactly.
 */
export function maximizePanel(view: RegionView, kind: PanelKind): RegionView {
  if (!isLoaded(view, kind)) return view;
  return withView(view, { layout: { maximized: kind } });
}

/** Restore, Escape: ends Maximize. */
export function restoreMaximized(view: RegionView): RegionView {
  return withView(view, { layout: { maximized: null } });
}

/** Records that a panel was used (focused or pressed), for make-room. */
export function notePanelUsed(layout: RegionLayout, kind: PanelKind): RegionLayout {
  return withLayout(layout, { recency: withRecent(layout.recency, kind) });
}

/**
 * ⋯ → Full height / Full width. Extending moves the region outermost, so it
 * takes the corners it shares; un-extending moves it innermost.
 */
export function setExtend(
  layout: RegionLayout,
  region: EdgeRegion,
  on: boolean,
): RegionLayout {
  const rest = layout.extendOrder.filter((edge) => edge !== region);
  return withLayout(layout, {
    extendOrder: on ? [region, ...rest] : [...rest, region],
  });
}

/** Remembers a kind's size along an axis, as a share of the stage. */
export function setPanelSize(
  layout: RegionLayout,
  kind: PanelKind,
  axis: SizeAxis,
  share: number,
): RegionLayout {
  if (!Number.isFinite(share)) return layout;
  const clamped = clampPanelShare(share);
  if (layout.sizes[kind]?.[axis] === clamped) return layout;
  return withLayout(layout, {
    sizes: { ...layout.sizes, [kind]: { ...layout.sizes[kind], [axis]: clamped } },
  });
}

/**
 * Reset layout: Chat alone in the Middle, every other panel unloaded (this
 * thread's Terminals included), default placements and extend order.
 * Remembered sizes are kept.
 */
export function resetRegionView(view: RegionView): RegionView {
  return withView(view, {
    layout: { ...defaultRegionLayout(view.layout.sizes) },
    terminals: null,
  });
}

// ---------------------------------------------------------------------------
// Terminal tabs (this thread)

/**
 * Adds a terminal tab (or selects an existing one), loading the Terminals
 * panel if needed, and shows it in its place. Undefined when the tab cannot
 * be added: an invalid ID, or the tab limit is reached.
 */
export function openTerminalTab(
  view: RegionView,
  terminalId: string,
  createProducerId: () => string,
  region?: RegionId,
): RegionView | undefined {
  if (!isValidPanelId(terminalId)) return undefined;
  const current = view.terminals ?? EMPTY_TERMINALS;
  const existing = current.tabs.some((tab) => tab.terminalId === terminalId);
  if (!existing && current.tabs.length >= MAX_TERMINAL_TABS) return undefined;
  const terminals = freezeTerminals({
    tabs: existing
      ? current.tabs
      : [...current.tabs, { terminalId, producerId: createProducerId() }],
    activeTerminalId: terminalId,
  });
  return openPanel(withView(view, { terminals }), "terminals", region);
}

/** Selects an existing tab and shows Terminals in its place. */
export function activateTerminalTab(
  view: RegionView,
  terminalId: string,
): RegionView | undefined {
  const current = view.terminals;
  if (!current?.tabs.some((tab) => tab.terminalId === terminalId))
    return undefined;
  const terminals =
    current.activeTerminalId === terminalId
      ? current
      : freezeTerminals({ ...current, activeTerminalId: terminalId });
  return openPanel(withView(view, { terminals }), "terminals");
}

/**
 * Removes a tab. Its left neighbour (or the new first tab) becomes active.
 * The panel stays loaded, even with no tabs left.
 */
export function closeTerminalTab(
  view: RegionView,
  terminalId: string,
): RegionView | undefined {
  const current = view.terminals;
  const index =
    current?.tabs.findIndex((tab) => tab.terminalId === terminalId) ?? -1;
  if (!current || index < 0) return undefined;
  const tabs = current.tabs.filter((tab) => tab.terminalId !== terminalId);
  return withView(view, {
    terminals: freezeTerminals({
      tabs,
      activeTerminalId:
        current.activeTerminalId === terminalId
          ? (tabs[Math.max(0, index - 1)]?.terminalId ?? null)
          : current.activeTerminalId,
    }),
  });
}

// ---------------------------------------------------------------------------
// Construction helpers

type LayoutPatch = { -readonly [K in keyof RegionLayout]?: RegionLayout[K] };

/** The layout with `patch` applied, or `layout` itself when nothing changes. */
export function withLayout(layout: RegionLayout, patch: LayoutPatch): RegionLayout {
  const next = { ...layout, ...patch };
  return sameLayout(layout, next) ? layout : freezeLayout(next);
}

function withView(
  view: RegionView,
  patch: {
    readonly layout?: LayoutPatch;
    readonly terminals?: TerminalsPanelState | null;
  },
): RegionView {
  const layout = patch.layout ? withLayout(view.layout, patch.layout) : view.layout;
  const terminals =
    patch.terminals === undefined ? view.terminals : patch.terminals;
  if (layout === view.layout && sameTerminals(terminals, view.terminals))
    return view;
  return Object.freeze({ layout, terminals });
}

function withLoaded(
  loaded: readonly SharedPanelKind[],
  kind: SharedPanelKind,
): readonly SharedPanelKind[] {
  return loaded.includes(kind)
    ? loaded
    : SHARED_PANEL_KINDS.filter((shared) => shared === kind || loaded.includes(shared));
}

function withRecent(
  recency: readonly PanelKind[],
  kind: PanelKind,
): readonly PanelKind[] {
  return recency.at(-1) === kind
    ? recency
    : [...recency.filter((recent) => recent !== kind), kind];
}

export function freezeLayout(layout: RegionLayout): RegionLayout {
  return Object.freeze({
    placement: Object.isFrozen(layout.placement)
      ? layout.placement
      : Object.freeze({ ...layout.placement }),
    shown: Object.isFrozen(layout.shown)
      ? layout.shown
      : Object.freeze({ ...layout.shown }),
    loaded: Object.isFrozen(layout.loaded)
      ? layout.loaded
      : Object.freeze([...layout.loaded]),
    extendOrder: Object.isFrozen(layout.extendOrder)
      ? layout.extendOrder
      : Object.freeze([...layout.extendOrder]),
    sizes: Object.isFrozen(layout.sizes) ? layout.sizes : freezeSizes(layout.sizes),
    maximized: layout.maximized,
    recency: Object.isFrozen(layout.recency)
      ? layout.recency
      : Object.freeze([...layout.recency]),
  });
}

function freezeSizes(sizes: PanelSizes): PanelSizes {
  const frozen: Partial<Record<PanelKind, PanelSize>> = {};
  for (const kind of PANEL_KINDS) {
    const size = sizes[kind];
    if (size) frozen[kind] = Object.freeze({ ...size });
  }
  return Object.freeze(frozen);
}

export function freezeTerminals(terminals: TerminalsPanelState): TerminalsPanelState {
  return Object.freeze({
    tabs: Object.freeze(terminals.tabs.map((tab) => Object.freeze({ ...tab }))),
    activeTerminalId: terminals.activeTerminalId,
  });
}

function sameLayout(left: RegionLayout, right: RegionLayout): boolean {
  return (
    sameRecord(left.placement, right.placement) &&
    sameRecord(left.shown, right.shown) &&
    sameList(left.loaded, right.loaded) &&
    sameList(left.extendOrder, right.extendOrder) &&
    sameSizes(left.sizes, right.sizes) &&
    left.maximized === right.maximized &&
    sameList(left.recency, right.recency)
  );
}

function sameRecord<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys)
    if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key])
      return false;
  return true;
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((value, index) => value === right[index]))
  );
}

function sameSizes(left: PanelSizes, right: PanelSizes): boolean {
  if (left === right) return true;
  return PANEL_KINDS.every((kind) => {
    const a = left[kind];
    const b = right[kind];
    return a === b || (a !== undefined && b !== undefined && sameRecord(a, b));
  });
}

export function sameTerminals(
  left: TerminalsPanelState | null,
  right: TerminalsPanelState | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.activeTerminalId === right.activeTerminalId &&
    left.tabs.length === right.tabs.length &&
    left.tabs.every(
      (tab, index) =>
        tab.terminalId === right.tabs[index]!.terminalId &&
        tab.producerId === right.tabs[index]!.producerId,
    )
  );
}
