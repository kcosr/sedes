import { terminalProducerIdSchema } from "../../shared/index.js";
import {
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
  type TerminalTab,
  type TerminalsPanelState,
} from "./regions.js";
import { isRecord } from "../../shared/json-guards.js";

/**
 * Saved panel regions.
 *
 * - `sedes-panel-regions@1` holds the device layout: placements, each
 *   region's shown panel, the loaded Files/Workpads/Pages/Tasks, the extend order
 *   and remembered sizes. Maximize and recency are never saved.
 * - `sedes-thread-panel-regions@1:<threadId>` holds one thread's Terminals
 *   panel (its tabs and active tab), or null while it is not loaded.
 *
 * Parsing is strict: an envelope or field that is not exactly what the
 * serializer writes is rejected as a whole, and the caller falls back to
 * defaults. Only a remembered size outside the share bounds is dropped on
 * its own. Storage that throws is treated as empty.
 *
 * Device layouts use envelope version 2 under the existing key. Earlier
 * versions reset in place, and obsolete pre-region device and thread collapse
 * keys are removed so they cannot restore an outdated arrangement. Thread
 * Terminals retain their independent version 1 contract and pre-region migration.
 */

export const PANEL_REGIONS_STORAGE_KEY = "sedes-panel-regions@1";
export const THREAD_PANEL_REGIONS_STORAGE_PREFIX = "sedes-thread-panel-regions@1:";
const LAYOUT_STORAGE_VERSION = 2 as const;
const TERMINALS_STORAGE_VERSION = 1 as const;

export function threadPanelRegionsStorageKey(threadId: string): string {
  return `${THREAD_PANEL_REGIONS_STORAGE_PREFIX}${encodeURIComponent(threadId)}`;
}

/** Obsolete device layout keys, removed rather than migrated. */
export const LEGACY_PANEL_STORAGE_KEYS = Object.freeze({
  files: "sedes-workspace-files-panel-state@1",
  workpads: "sedes-workpads-panel-state@1",
  tasks: "sedes-tasks-panel-state@1",
  sizesV4: "sedes-panel-instance-sizes@4",
  sizes: "sedes-panel-instance-sizes@5",
  companions: "sedes-panel-companions@1",
  presentation: "sedes-panel-presentation",
  singletonLayout: "sedes-singleton-panel-layout@1",
  singletonSizes: "sedes-singleton-panel-sizes@1",
  singletonCollapsed: "sedes-singleton-panel-collapsed@1",
  taskCardWidth: "sedes.tasks.panel.width",
});
const LEGACY_THREAD_COLLAPSED_STORAGE_PREFIX = "sedes-thread-panel-instance-collapsed@4:";

export function legacyThreadLayoutStorageKey(threadId: string): string {
  return `sedes-thread-panel-instance-layout@4:${encodeURIComponent(threadId)}`;
}

export interface RegionStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where a loaded value came from. */
export type RegionLoadSource = "stored" | "invalid" | "migrated" | "default";

export interface LoadedRegionLayout {
  readonly layout: RegionLayout;
  readonly source: Exclude<RegionLoadSource, "migrated">;
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
    version: LAYOUT_STORAGE_VERSION,
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
    parsed.version !== LAYOUT_STORAGE_VERSION
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
 * Read only the current device layout contract. Outdated or invalid layouts
 * reset in place; obsolete device and thread collapse keys are removed even
 * when the current layout is valid. Terminal records and content preferences
 * are separate.
 */
export function loadRegionLayout(
  storage: RegionStorage | undefined,
): LoadedRegionLayout {
  const obsoleteKeys = new Set<string>(
    Object.values(LEGACY_PANEL_STORAGE_KEYS).filter((key) => readItem(storage, key) !== null),
  );
  // Snapshot indexed keys before deleting anything: removal shifts later keys.
  try {
    const length = storage?.length ?? 0;
    for (let index = 0; index < length; index += 1) {
      try {
        const key = storage?.key(index);
        if (key?.startsWith(LEGACY_THREAD_COLLAPSED_STORAGE_PREFIX)) obsoleteKeys.add(key);
      } catch {
        // Other keys can still be inspected when one entry is unavailable.
      }
    }
  } catch {
    // Fixed device keys can still be removed when enumeration is unavailable.
  }
  for (const key of obsoleteKeys) {
    try {
      storage?.removeItem(key);
    } catch {
      // Layout still starts fresh if this browser denies storage writes.
    }
  }
  const serialized = readItem(storage, PANEL_REGIONS_STORAGE_KEY);
  if (serialized !== null) {
    const parsed = parseRegionLayout(serialized);
    return parsed
      ? { layout: regionLayoutFromPersisted(parsed), source: "stored" }
      : { layout: defaultRegionLayout(), source: "invalid" };
  }
  return { layout: defaultRegionLayout(), source: obsoleteKeys.size > 0 ? "invalid" : "default" };
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
    version: TERMINALS_STORAGE_VERSION,
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
    parsed.version !== TERMINALS_STORAGE_VERSION ||
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
// Thread Terminals migration from the pre-region tree

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
