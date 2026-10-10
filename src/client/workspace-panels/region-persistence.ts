import { terminalProducerIdSchema } from "../../shared/index.js";
import {
  DEFAULT_PLACEMENT,
  DEFAULT_SHOWN,
  EDGE_REGIONS,
  MAX_PANEL_SHARE,
  MAX_TERMINAL_TABS,
  MIN_PANEL_SHARE,
  PANEL_KINDS,
  REGION_IDS,
  SHARED_PANEL_KINDS,
  defaultRegionLayout,
  freezeLayout,
  freezeTerminals,
  isEdgeRegion,
  isPanelKind,
  isRegionId,
  isSharedPanelKind,
  isValidPanelId,
  type EdgeRegion,
  type PanelKind,
  type PanelSize,
  type PanelSizes,
  type PersistedRegionLayout,
  type RegionId,
  type RegionLayout,
  type SharedPanelKind,
  type SizeAxis,
  type TerminalTab,
  type TerminalsPanelState,
} from "./regions.js";

/**
 * Saved panel regions.
 *
 * - `sedes-panel-regions@1` holds the device layout: placements, each
 *   region's shown panel, the loaded Files/Workpads/Tasks, the extend order
 *   and remembered sizes. Maximize and recency are never saved.
 * - `sedes-thread-panel-regions@1:<threadId>` holds one thread's Terminals
 *   panel (its tabs and active tab), or null while it is not loaded.
 *
 * Parsing is strict: an envelope or field that is not exactly what the
 * serializer writes is rejected as a whole, and the caller falls back to
 * defaults. Only a remembered size outside the share bounds is dropped on
 * its own. Storage that throws is treated as empty.
 *
 * When the device key is absent, the layout is migrated once from the
 * pre-region keys; when a thread's key is absent, its Terminals are migrated
 * from that thread's old layout tree. The old keys are only read.
 */

export const PANEL_REGIONS_STORAGE_KEY = "sedes-panel-regions@1";
export const THREAD_PANEL_REGIONS_STORAGE_PREFIX = "sedes-thread-panel-regions@1:";
const STORAGE_VERSION = 1 as const;

export function threadPanelRegionsStorageKey(threadId: string): string {
  return `${THREAD_PANEL_REGIONS_STORAGE_PREFIX}${encodeURIComponent(threadId)}`;
}

/** The thread a per-thread key belongs to, or undefined for any other key. */
export function threadIdForPanelRegionsStorageKey(key: string): string | undefined {
  if (!key.startsWith(THREAD_PANEL_REGIONS_STORAGE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(key.slice(THREAD_PANEL_REGIONS_STORAGE_PREFIX.length));
  } catch {
    return undefined;
  }
}

/** Pre-region keys, read once by migration. */
export const LEGACY_PANEL_STORAGE_KEYS = Object.freeze({
  files: "sedes-workspace-files-panel-state@1",
  workpads: "sedes-workpads-panel-state@1",
  tasks: "sedes-tasks-panel-state@1",
  sizes: "sedes-panel-instance-sizes@5",
  companions: "sedes-panel-companions@1",
});

export function legacyThreadLayoutStorageKey(threadId: string): string {
  return `sedes-thread-panel-instance-layout@4:${encodeURIComponent(threadId)}`;
}

export interface RegionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where a loaded value came from. */
export type RegionLoadSource = "stored" | "invalid" | "migrated" | "default";

export interface LoadedRegionLayout {
  readonly layout: RegionLayout;
  readonly source: RegionLoadSource;
}

export interface LoadedThreadTerminals {
  readonly terminals: TerminalsPanelState | null;
  readonly source: RegionLoadSource;
}

function readItem(storage: RegionStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Device layout

export function serializeRegionLayout(layout: PersistedRegionLayout): string {
  const sizes: Record<string, PanelSize> = {};
  for (const kind of PANEL_KINDS) {
    const size = layout.sizes[kind];
    if (!size) continue;
    const ordered: { width?: number; height?: number } = {};
    if (size.width !== undefined) ordered.width = size.width;
    if (size.height !== undefined) ordered.height = size.height;
    if (ordered.width !== undefined || ordered.height !== undefined)
      sizes[kind] = ordered;
  }
  return JSON.stringify({
    version: STORAGE_VERSION,
    placement: Object.fromEntries(
      PANEL_KINDS.map((kind) => [kind, layout.placement[kind]]),
    ),
    shown: Object.fromEntries(
      REGION_IDS.map((region) => [region, layout.shown[region]]),
    ),
    loaded: SHARED_PANEL_KINDS.filter((kind) => layout.loaded.includes(kind)),
    extendOrder: [...layout.extendOrder],
    sizes,
  });
}

const LAYOUT_KEYS = [
  "version",
  "placement",
  "shown",
  "loaded",
  "extendOrder",
  "sizes",
] as const;

/** The saved device layout, or undefined when it is not exactly valid. */
export function parseRegionLayout(
  serialized: string,
): PersistedRegionLayout | undefined {
  const parsed = parseJson(serialized);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, LAYOUT_KEYS) ||
    parsed.version !== STORAGE_VERSION
  )
    return undefined;
  const placement = parsePlacement(parsed.placement);
  const loaded = parseLoaded(parsed.loaded);
  const extendOrder = parseExtendOrder(parsed.extendOrder);
  const sizes = parseSizes(parsed.sizes);
  if (!placement || !loaded || !extendOrder || !sizes) return undefined;
  const shown = parseShown(parsed.shown, placement, loaded);
  if (!shown) return undefined;
  return { placement, shown, loaded, extendOrder, sizes };
}

function parsePlacement(value: unknown): Record<PanelKind, RegionId> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, PANEL_KINDS)) return undefined;
  const placement = {} as Record<PanelKind, RegionId>;
  for (const kind of PANEL_KINDS) {
    const region = value[kind];
    if (!isRegionId(region)) return undefined;
    placement[kind] = region;
  }
  return placement;
}

function parseShown(
  value: unknown,
  placement: Readonly<Record<PanelKind, RegionId>>,
  loaded: readonly SharedPanelKind[],
): Record<RegionId, PanelKind | null> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, REGION_IDS)) return undefined;
  const shown = {} as Record<RegionId, PanelKind | null>;
  for (const region of REGION_IDS) {
    const kind = value[region];
    if (kind === null) {
      shown[region] = null;
      continue;
    }
    if (
      !isPanelKind(kind) ||
      placement[kind] !== region ||
      (isSharedPanelKind(kind) && !loaded.includes(kind))
    )
      return undefined;
    shown[region] = kind;
  }
  return shown;
}

function parseLoaded(value: unknown): SharedPanelKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(isSharedPanelKind) ||
    new Set(value).size !== value.length
  )
    return undefined;
  return SHARED_PANEL_KINDS.filter((kind) => value.includes(kind));
}

function parseExtendOrder(value: unknown): EdgeRegion[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== EDGE_REGIONS.length ||
    !value.every(isEdgeRegion) ||
    new Set(value).size !== value.length
  )
    return undefined;
  return [...value];
}

/**
 * Remembered sizes: an object of panel kinds, each an object of axes. An
 * unknown kind or axis, or a non-number, rejects the layout; a share
 * outside the bounds is dropped.
 */
function parseSizes(value: unknown): PanelSizes | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, PANEL_KINDS)) return undefined;
  const sizes: Partial<Record<PanelKind, PanelSize>> = {};
  for (const kind of PANEL_KINDS) {
    if (!Object.hasOwn(value, kind)) continue;
    const raw = value[kind];
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["width", "height"])) return undefined;
    const size: { width?: number; height?: number } = {};
    for (const axis of ["width", "height"] as const) {
      if (!Object.hasOwn(raw, axis)) continue;
      const share = raw[axis];
      if (typeof share !== "number") return undefined;
      if (validShare(share)) size[axis] = share;
    }
    if (size.width !== undefined || size.height !== undefined) sizes[kind] = size;
  }
  return sizes;
}

function validShare(share: number): boolean {
  return (
    Number.isFinite(share) && share >= MIN_PANEL_SHARE && share <= MAX_PANEL_SHARE
  );
}

/**
 * The device layout to start with: the saved one; defaults when it is
 * invalid; a migration from the pre-region keys when it is absent and any
 * of them exist; defaults otherwise.
 */
export function loadRegionLayout(
  storage: RegionStorage | undefined,
): LoadedRegionLayout {
  const serialized = readItem(storage, PANEL_REGIONS_STORAGE_KEY);
  if (serialized !== null) {
    const parsed = parseRegionLayout(serialized);
    return parsed
      ? { layout: regionLayoutFromPersisted(parsed), source: "stored" }
      : { layout: defaultRegionLayout(), source: "invalid" };
  }
  const migrated = migrateLegacyRegionLayout(storage);
  return migrated
    ? { layout: migrated, source: "migrated" }
    : { layout: defaultRegionLayout(), source: "default" };
}

export function regionLayoutFromPersisted(
  persisted: PersistedRegionLayout,
  transient: Pick<RegionLayout, "maximized" | "recency"> = {
    maximized: null,
    recency: [],
  },
): RegionLayout {
  return freezeLayout({ ...persisted, ...transient });
}

// ---------------------------------------------------------------------------
// Thread Terminals

export function serializeThreadTerminals(
  threadId: string,
  terminals: TerminalsPanelState | null,
): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    threadId,
    terminals:
      terminals === null
        ? null
        : {
            tabs: terminals.tabs.map(({ terminalId, producerId }) => ({
              terminalId,
              producerId,
            })),
            activeTerminalId: terminals.activeTerminalId,
          },
  });
}

/**
 * A thread's saved Terminals (null: not loaded), or undefined when the value
 * is not exactly valid or belongs to another thread.
 */
export function parseThreadTerminals(
  threadId: string,
  serialized: string,
): { readonly terminals: TerminalsPanelState | null } | undefined {
  const parsed = parseJson(serialized);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["version", "threadId", "terminals"]) ||
    parsed.version !== STORAGE_VERSION ||
    parsed.threadId !== threadId
  )
    return undefined;
  if (parsed.terminals === null) return { terminals: null };
  if (
    !isRecord(parsed.terminals) ||
    !hasExactKeys(parsed.terminals, ["tabs", "activeTerminalId"])
  )
    return undefined;
  const terminals = decodeTerminals(parsed.terminals, true);
  return terminals ? { terminals } : undefined;
}

function decodeTerminals(
  input: Record<string, unknown>,
  exactTabs: boolean,
): TerminalsPanelState | undefined {
  const { tabs: rawTabs, activeTerminalId } = input;
  if (
    !Array.isArray(rawTabs) ||
    rawTabs.length > MAX_TERMINAL_TABS ||
    (activeTerminalId !== null && !isValidPanelId(activeTerminalId))
  )
    return undefined;
  const terminalIds = new Set<string>();
  const producerIds = new Set<string>();
  const tabs: TerminalTab[] = [];
  for (const rawTab of rawTabs) {
    if (
      !isRecord(rawTab) ||
      (exactTabs && !hasExactKeys(rawTab, ["terminalId", "producerId"])) ||
      !isValidPanelId(rawTab.terminalId)
    )
      return undefined;
    const producerId = terminalProducerIdSchema.safeParse(rawTab.producerId);
    if (
      !producerId.success ||
      terminalIds.has(rawTab.terminalId) ||
      producerIds.has(producerId.data)
    )
      return undefined;
    terminalIds.add(rawTab.terminalId);
    producerIds.add(producerId.data);
    tabs.push({ terminalId: rawTab.terminalId, producerId: producerId.data });
  }
  if (
    tabs.length === 0
      ? activeTerminalId !== null
      : activeTerminalId === null || !terminalIds.has(activeTerminalId as string)
  )
    return undefined;
  return freezeTerminals({
    tabs,
    activeTerminalId: activeTerminalId as string | null,
  });
}

/**
 * A thread's Terminals to start with: the saved value; not loaded when it is
 * invalid; a migration from the thread's old layout when it is absent and the
 * old layout exists; not loaded otherwise.
 */
export function loadThreadTerminals(
  storage: RegionStorage | undefined,
  threadId: string,
): LoadedThreadTerminals {
  const serialized = readItem(storage, threadPanelRegionsStorageKey(threadId));
  if (serialized !== null) {
    const parsed = parseThreadTerminals(threadId, serialized);
    return parsed
      ? { terminals: parsed.terminals, source: "stored" }
      : { terminals: null, source: "invalid" };
  }
  const migrated = migrateLegacyThreadTerminals(storage, threadId);
  return migrated
    ? { terminals: migrated.terminals, source: "migrated" }
    : { terminals: null, source: "default" };
}

// ---------------------------------------------------------------------------
// Migration from the pre-region keys

interface LegacyVisibility {
  readonly open: boolean;
  readonly collapsed: boolean;
}

interface LegacyCompanionPlacement {
  readonly kind: "workpads" | "tasks";
  readonly edge: EdgeRegion;
}

/** Most recently opened first, when the old keys cannot tell. */
const LEGACY_SHOWN_PRIORITY: readonly SharedPanelKind[] = [
  "tasks",
  "workpads",
  "files",
];

function readLegacyVisibility(
  storage: RegionStorage | undefined,
  key: string,
): LegacyVisibility | undefined {
  const serialized = readItem(storage, key);
  if (serialized === null) return undefined;
  const parsed = parseJson(serialized);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.open !== "boolean" ||
    typeof parsed.collapsed !== "boolean"
  )
    return undefined;
  return { open: parsed.open, collapsed: parsed.open && parsed.collapsed };
}

/** Tasks and Workpads edges, outermost (most recently opened) first. */
function readLegacyCompanions(
  storage: RegionStorage | undefined,
): readonly LegacyCompanionPlacement[] | undefined {
  const serialized = readItem(storage, LEGACY_PANEL_STORAGE_KEYS.companions);
  if (serialized === null) return undefined;
  const parsed = parseJson(serialized);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.arrangement))
    return undefined;
  const arrangement: LegacyCompanionPlacement[] = [];
  for (const entry of parsed.arrangement) {
    if (!isRecord(entry)) return undefined;
    const { kind, edge } = entry;
    if (
      (kind !== "workpads" && kind !== "tasks") ||
      !isEdgeRegion(edge) ||
      arrangement.some((placement) => placement.kind === kind)
    )
      return undefined;
    arrangement.push({ kind, edge });
  }
  return arrangement;
}

function readLegacySizes(
  storage: RegionStorage | undefined,
): PanelSizes | undefined {
  const serialized = readItem(storage, LEGACY_PANEL_STORAGE_KEYS.sizes);
  if (serialized === null) return undefined;
  const parsed = parseJson(serialized);
  if (!isRecord(parsed) || parsed.version !== 5 || !isRecord(parsed.sizes))
    return undefined;
  const sizes: Partial<Record<PanelKind, PanelSize>> = {};
  for (const kind of ["files", "workpads", "tasks", "terminals"] as const) {
    const raw = parsed.sizes[kind];
    if (!isRecord(raw)) continue;
    const size: Partial<Record<SizeAxis, number>> = {};
    for (const axis of ["width", "height"] as const) {
      const share = raw[axis];
      if (typeof share === "number" && validShare(share)) size[axis] = share;
    }
    if (size.width !== undefined || size.height !== undefined) sizes[kind] = size;
  }
  return sizes;
}

/**
 * The device layout from the pre-region keys, or undefined when none of
 * them exists:
 *
 * - Tasks and Workpads keep the edge their companion arrangement docked them
 *   at; every other kind takes its default placement (Chat, Files and
 *   Terminals placements were per thread and do not carry over).
 * - An open panel is loaded. An open, uncollapsed one is shown in its region;
 *   when several share a region, the most recently opened wins: the
 *   companion arrangement's outermost first, then Tasks, Workpads, Files.
 * - Remembered sizes carry over (Chat had none).
 * - Unreadable old values count as absent panels.
 */
export function migrateLegacyRegionLayout(
  storage: RegionStorage | undefined,
): RegionLayout | undefined {
  const visibility: Partial<Record<SharedPanelKind, LegacyVisibility>> = {};
  let found = false;
  for (const kind of SHARED_PANEL_KINDS) {
    if (readItem(storage, LEGACY_PANEL_STORAGE_KEYS[kind]) !== null) found = true;
    const state = readLegacyVisibility(storage, LEGACY_PANEL_STORAGE_KEYS[kind]);
    if (state) visibility[kind] = state;
  }
  for (const key of [LEGACY_PANEL_STORAGE_KEYS.sizes, LEGACY_PANEL_STORAGE_KEYS.companions])
    if (readItem(storage, key) !== null) found = true;
  if (!found) return undefined;
  const companions = readLegacyCompanions(storage) ?? [];
  const sizes = readLegacySizes(storage) ?? {};
  const placement: Record<PanelKind, RegionId> = { ...DEFAULT_PLACEMENT };
  for (const { kind, edge } of companions) placement[kind] = edge;
  const loaded = SHARED_PANEL_KINDS.filter((kind) => visibility[kind]?.open);
  const priority: SharedPanelKind[] = [
    ...companions.map(({ kind }) => kind),
    ...LEGACY_SHOWN_PRIORITY.filter(
      (kind) => !companions.some((placement) => placement.kind === kind),
    ),
  ];
  const shown: Record<RegionId, PanelKind | null> = { ...DEFAULT_SHOWN };
  const claimed = new Set<RegionId>();
  const winners: SharedPanelKind[] = [];
  for (const kind of priority) {
    const state = visibility[kind];
    const region = placement[kind];
    if (!state?.open || state.collapsed || claimed.has(region)) continue;
    claimed.add(region);
    shown[region] = kind;
    winners.push(kind);
  }
  return freezeLayout({
    placement,
    shown,
    loaded,
    extendOrder: EDGE_REGIONS,
    sizes,
    maximized: null,
    // Least recently shown first.
    recency: winners.reverse(),
  });
}

const LEGACY_MAX_DEPTH = 4;
const LEGACY_MAX_NODES = 31;

/**
 * A thread's Terminals from its pre-region layout tree, or undefined when
 * the thread has no old layout. A layout that cannot be read, or has no
 * valid Terminals panel for this thread, migrates as not loaded.
 */
export function migrateLegacyThreadTerminals(
  storage: RegionStorage | undefined,
  threadId: string,
): { readonly terminals: TerminalsPanelState | null } | undefined {
  const serialized = readItem(storage, legacyThreadLayoutStorageKey(threadId));
  if (serialized === null) return undefined;
  const parsed = parseJson(serialized);
  if (!isRecord(parsed) || parsed.version !== 4 || parsed.threadId !== threadId)
    return { terminals: null };
  const panel = findLegacyTerminals(parsed.tree);
  if (!panel || panel.panelInstanceId !== "terminals" || panel.threadId !== threadId)
    return { terminals: null };
  return { terminals: decodeTerminals(panel, false) ?? null };
}

function findLegacyTerminals(tree: unknown): Record<string, unknown> | undefined {
  let nodes = 0;
  const visit = (node: unknown, depth: number): Record<string, unknown> | undefined => {
    nodes += 1;
    if (!isRecord(node) || depth > LEGACY_MAX_DEPTH || nodes > LEGACY_MAX_NODES)
      return undefined;
    if (node.kind === "tabs" && Array.isArray(node.tabs))
      return node.tabs.find(
        (panel): panel is Record<string, unknown> =>
          isRecord(panel) && panel.kind === "terminals",
      );
    if (node.kind === "split" && Array.isArray(node.children))
      for (const child of node.children.slice(0, 2)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
    return undefined;
  };
  return visit(tree, 0);
}
