import { useSyncExternalStore } from "react";
import type { WorkspacePanelTenantRegistry } from "./registry.js";
import {
  computeRegionGeometry,
  hiddenByMakeRoom,
  panelSizeHints,
  type PanelSizeHints,
  type RegionGeometry,
  type RegionStage,
} from "./region-geometry.js";
import {
  PANEL_REGIONS_STORAGE_KEY,
  loadRegionLayout,
  loadThreadTerminals,
  parseRegionLayout,
  parseThreadTerminals,
  regionLayoutFromPersisted,
  serializeRegionLayout,
  serializeThreadTerminals,
  threadIdForPanelRegionsStorageKey,
  threadPanelRegionsStorageKey,
  type RegionStorage,
} from "./region-persistence.js";
import {
  SHARED_PANEL_KINDS,
  activateTerminalTab as activateTerminalTabIn,
  closePanel,
  closeTerminalTab as closeTerminalTabIn,
  defaultRegionLayout,
  effectiveMaximized,
  isEdgeRegion,
  isExtended,
  isLoaded,
  isPanelKind,
  isRegionId,
  isSharedPanelKind,
  isShown,
  loadedPanels,
  maximizePanel,
  movePanel,
  notePanelUsed,
  openPanel,
  openTerminalTab as openTerminalTabIn,
  panelLoadState,
  regionPanel,
  resetRegionView,
  restoreMaximized,
  setExtend,
  setPanelSize,
  tenantIdForKind,
  togglePanel,
  visiblePanels,
  type EdgeRegion,
  type PanelKind,
  type PanelLoadState,
  type RegionId,
  type RegionLayout,
  type RegionView,
  type SharedPanelKind,
  type SizeAxis,
  type TerminalTab,
  type TerminalsPanelState,
} from "./regions.js";

/**
 * The panel region store: the device layout shared by every thread, plus each
 * thread's Terminals, with `forThread` views like the panel layout store it
 * replaces. Layout rules live in regions.ts and region-geometry.ts; this
 * class adds persistence, the stage size, intents, focus requests and the
 * workspace dirty registry.
 *
 * The root store (no thread) never loads Terminals. Every store created by
 * `forThread` shares the device layout: a change made through one notifies
 * them all.
 */

export interface PanelFocusRequest {
  readonly kind: PanelKind;
  readonly terminalId?: string;
  readonly sequence: number;
  readonly scope?: {
    readonly kind: "thread";
    readonly threadId: string;
  };
}

export interface PanelRegionFocusInput {
  /** Request focus for the panel (the default) or leave focus alone. */
  readonly focus?: boolean;
  readonly focusScope?: PanelFocusRequest["scope"];
}

export interface PanelRegionOpenInput extends PanelRegionFocusInput {
  /** Open there and make it the panel's placement (the place menu). */
  readonly region?: RegionId;
  /** Delivered to the panel; it consumes it with `consumeIntent`. */
  readonly intent?: unknown;
}

/** This thread's loaded Terminals panel. */
export interface ThreadTerminalPanel extends TerminalsPanelState {
  readonly threadId: string;
}

export interface PanelRegionSnapshot {
  readonly threadId: string;
  /** The device layout with this thread's Terminals. */
  readonly view: RegionView;
  /** Loaded panels, in the fixed order. */
  readonly loaded: readonly PanelKind[];
  /** Visible panels, in the fixed order: after make-room and Maximize. */
  readonly visible: readonly PanelKind[];
  readonly hiddenByMakeRoom: readonly PanelKind[];
  readonly maximized: PanelKind | null;
  /** The desktop stage; undefined until measured, and on phones. */
  readonly stage?: RegionStage;
  readonly geometry?: RegionGeometry;
  readonly terminals?: ThreadTerminalPanel;
  readonly focusRequest?: PanelFocusRequest;
  readonly revision: number;
}

export interface PanelRegionStoreOptions {
  readonly threadId?: string;
  readonly storage?: RegionStorage;
  readonly createProducerId?: () => string;
  /** Minimum and default sizes; by default from the tenant registry. */
  readonly sizeHints?: PanelSizeHints;
}

interface SharedRegionState {
  layout: RegionLayout;
  stage: RegionStage | undefined;
  revision: number;
  focusSequence: number;
  /** The device layout as last read or written, to skip redundant writes. */
  persistedLayout: string | undefined;
  readonly storage: RegionStorage | undefined;
  readonly hints: PanelSizeHints;
  readonly available: readonly SharedPanelKind[];
  readonly createProducerId: () => string;
  readonly stores: Set<PanelRegionStore>;
  readonly threadStores: Map<string, PanelRegionStore>;
  readonly dirtyListeners: Set<() => void>;
  readonly workspaceDirty: Map<string, Map<string, Set<string>>>;
}

const UNSCOPED_THREAD_ID = "unscoped";
const KEEP = Symbol("keep focus request");
type FocusChange = PanelFocusRequest | undefined | typeof KEEP;

function browserStorage(): RegionStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export class PanelRegionStore {
  readonly registry: WorkspacePanelTenantRegistry;
  readonly threadId: string;
  readonly #scoped: boolean;
  readonly #shared: SharedRegionState;
  readonly #listeners = new Set<() => void>();
  readonly #intents = new Map<PanelKind, unknown>();
  #terminals: TerminalsPanelState | null = null;
  #persistedTerminals: string | undefined;
  #focusRequest: PanelFocusRequest | undefined;
  #revision = 0;
  #snapshotCount = 0;
  #view: RegionView | undefined;
  #terminalPanel:
    | { readonly source: TerminalsPanelState; readonly value: ThreadTerminalPanel }
    | undefined;
  #snapshot:
    | {
        readonly shared: number;
        readonly own: number;
        readonly value: PanelRegionSnapshot;
      }
    | undefined;

  constructor(
    registry: WorkspacePanelTenantRegistry,
    options: PanelRegionStoreOptions & { readonly shared?: SharedRegionState } = {},
  ) {
    this.registry = registry;
    this.#scoped = options.threadId !== undefined;
    this.threadId = options.threadId ?? UNSCOPED_THREAD_ID;
    this.#shared = options.shared ?? createSharedState(registry, options);
    this.#shared.stores.add(this);
    if (!this.#scoped) return;
    this.#shared.threadStores.set(this.threadId, this);
    const { terminals, source } = loadThreadTerminals(
      this.#shared.storage,
      this.threadId,
    );
    this.#terminals = terminals;
    if (source === "stored")
      this.#persistedTerminals = serializeThreadTerminals(this.threadId, terminals);
    // Migration happens once: its result is saved under the new key.
    if (source === "migrated") this.#persistTerminals();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): PanelRegionSnapshot => {
    const cached = this.#snapshot;
    if (
      cached?.shared === this.#shared.revision &&
      cached.own === this.#revision
    )
      return cached.value;
    const value = this.#buildSnapshot();
    this.#snapshot = {
      shared: this.#shared.revision,
      own: this.#revision,
      value,
    };
    return value;
  };

  subscribeWorkspaceDirty = (listener: () => void): (() => void) => {
    this.#shared.dirtyListeners.add(listener);
    return () => this.#shared.dirtyListeners.delete(listener);
  };

  /** The store for one thread, sharing this store's device layout. */
  forThread(threadId: string): PanelRegionStore {
    return (
      this.#shared.threadStores.get(threadId) ??
      new PanelRegionStore(this.registry, {
        threadId,
        shared: this.#shared,
      })
    );
  }

  // -------------------------------------------------------------------------
  // Queries

  isLoaded(kind: PanelKind): boolean {
    return isLoaded(this.#currentView(), kind);
  }
  /** Loaded: the panel is mounted, visible or not. */
  hasPanel(kind: PanelKind): boolean {
    return this.isLoaded(kind);
  }
  /** Loaded and its region's pick, before make-room and Maximize. */
  isShown(kind: PanelKind): boolean {
    return isShown(this.#currentView(), kind);
  }
  /** On stage: after make-room and Maximize. */
  isVisible(kind: PanelKind): boolean {
    return this.getSnapshot().visible.includes(kind);
  }
  isHiddenByMakeRoom(kind: PanelKind): boolean {
    return this.getSnapshot().hiddenByMakeRoom.includes(kind);
  }
  /** A launcher row's state: visible, loaded but hidden, or closed. */
  loadState(kind: PanelKind): PanelLoadState {
    const { view, hiddenByMakeRoom } = this.getSnapshot();
    return panelLoadState(view, kind, hiddenByMakeRoom);
  }
  placementOf(kind: PanelKind): RegionId {
    return this.#shared.layout.placement[kind];
  }
  /** The panel a region renders in this thread, or null when it is empty. */
  regionPanel(region: RegionId): PanelKind | null {
    return regionPanel(this.#currentView(), region);
  }
  isExtended(region: EdgeRegion): boolean {
    return isExtended(this.#shared.layout.extendOrder, region);
  }
  maximized(): PanelKind | null {
    return effectiveMaximized(this.#currentView());
  }
  terminalPanel(): ThreadTerminalPanel | undefined {
    return this.getSnapshot().terminals;
  }
  terminalTab(terminalId: string): TerminalTab | undefined {
    return this.terminalPanel()?.tabs.find((tab) => tab.terminalId === terminalId);
  }
  intent(kind: PanelKind): unknown {
    return this.#intents.get(kind);
  }

  // -------------------------------------------------------------------------
  // Layout operations

  /**
   * Opens a panel in its place (or `region`, which becomes its place),
   * replacing what that region showed, and requests focus unless `focus` is
   * false. False when the panel cannot open here: an unregistered tenant,
   * or Terminals without a thread.
   */
  open(kind: PanelKind, input: PanelRegionOpenInput = {}): boolean {
    if (!this.#canLoad(kind)) return false;
    if (input.region !== undefined && !isRegionId(input.region)) return false;
    const next = openPanel(this.#currentView(), kind, input.region);
    const deliversIntent = input.intent !== undefined;
    if (deliversIntent) this.#intents.set(kind, input.intent);
    this.#commit(next, {
      focusRequest:
        input.focus === false ? KEEP : this.#requestFocus(kind, input.focusScope),
      publish: deliversIntent,
    });
    return true;
  }

  /**
   * The quick button: hides a visible panel, shows a loaded hidden one in its
   * region (requesting focus unless `focus` is false), and opens a closed one.
   */
  toggle(kind: PanelKind, input: PanelRegionFocusInput = {}): boolean {
    if (!this.#canLoad(kind)) return false;
    const view = this.#currentView();
    const hidden = this.#hiddenByMakeRoom(view);
    const next = togglePanel(view, kind, hidden);
    const shows = !visiblePanels(view, hidden).includes(kind);
    this.#commit(next, {
      focusRequest: shows
        ? input.focus === false
          ? KEEP
          : this.#requestFocus(kind, input.focusScope)
        : this.#withoutFocusFor(kind),
    });
    return true;
  }

  /**
   * The header's ✕: Chat hides; any other panel unloads (Terminals for this
   * thread, with its tabs) and its region empties. The caller asks first
   * when unsaved changes would be lost. False when the panel is not loaded.
   */
  close(kind: PanelKind): boolean {
    if (!isPanelKind(kind)) return false;
    const view = this.#currentView();
    if (!isLoaded(view, kind)) return false;
    if (kind !== "chat") this.#intents.delete(kind);
    this.#commit(closePanel(view, kind), {
      focusRequest: this.#withoutFocusFor(kind),
      publish: true,
    });
    return true;
  }

  /** ⋯ → Move to. False when nothing changed. */
  move(kind: PanelKind, region: RegionId): boolean {
    if (!isPanelKind(kind) || !isRegionId(region)) return false;
    const view = this.#currentView();
    const next = movePanel(view, kind, region);
    if (next === view) return false;
    this.#commit(next);
    return true;
  }

  /** Fills the stage with a loaded panel until Restore. Never saved. */
  maximize(kind: PanelKind): boolean {
    const view = this.#currentView();
    if (!isPanelKind(kind) || !isLoaded(view, kind)) return false;
    const next = maximizePanel(view, kind);
    if (next === view) return false;
    this.#commit(next);
    return true;
  }

  /** Restore, Escape: ends Maximize. False when nothing was maximized. */
  restore(): boolean {
    const view = this.#currentView();
    const next = restoreMaximized(view);
    if (next === view) return false;
    this.#commit(next);
    return true;
  }

  /** ⋯ → Full height / Full width. */
  setExtend(region: EdgeRegion, on: boolean): boolean {
    if (!isEdgeRegion(region)) return false;
    const view = this.#currentView();
    const layout = setExtend(view.layout, region, on);
    if (layout === view.layout) return false;
    this.#commit({ ...view, layout });
    return true;
  }

  /**
   * Remembers a kind's size along an axis, as a share of the stage (see
   * `shareForHandleSize`). Shares are kept within the share bounds.
   */
  resize(kind: PanelKind, axis: SizeAxis, share: number): boolean {
    if (!isPanelKind(kind) || (axis !== "width" && axis !== "height"))
      return false;
    const view = this.#currentView();
    const layout = setPanelSize(view.layout, kind, axis, share);
    if (layout === view.layout) return false;
    this.#commit({ ...view, layout });
    return true;
  }

  /** The stage as a divider drag would leave it, for a live preview. */
  previewResize(
    kind: PanelKind,
    axis: SizeAxis,
    share: number,
  ): RegionGeometry | undefined {
    const stage = this.#shared.stage;
    if (!stage) return undefined;
    const view = this.#currentView();
    return computeRegionGeometry(
      { ...view, layout: setPanelSize(view.layout, kind, axis, share) },
      stage,
      this.#shared.hints,
    );
  }

  /**
   * Records that a panel was used (focused or pressed). Make-room hides the
   * least recently used edge region first. Recency is shared by every
   * thread, so a change publishes to every thread view; using the panel
   * already used last changes nothing.
   */
  touch(kind: PanelKind): void {
    if (!isPanelKind(kind)) return;
    const view = this.#currentView();
    const next = notePanelUsed(view.layout, kind);
    if (next === view.layout) return;
    this.#commit({ ...view, layout: next });
  }

  /**
   * The desktop stage's size, from the region shell's measurement. Undefined
   * (phones, or not yet measured) turns geometry and make-room off.
   */
  setStageSize(stage: RegionStage | undefined): void {
    const current = this.#shared.stage;
    if (
      current === stage ||
      (current &&
        stage &&
        current.width === stage.width &&
        current.height === stage.height)
    )
      return;
    this.#shared.stage = stage && { width: stage.width, height: stage.height };
    this.#publishShared();
  }

  /**
   * Reset layout: Chat alone in the Middle with focus, every other panel
   * unloaded (this thread's Terminals included), default placements and
   * extend order. Remembered sizes are kept.
   */
  resetLayout(): void {
    this.#intents.clear();
    this.#commit(resetRegionView(this.#currentView()), {
      focusRequest: this.#requestFocus("chat"),
      publish: true,
    });
  }

  // -------------------------------------------------------------------------
  // Terminal tabs

  /**
   * Adds (or selects) a terminal tab, loading this thread's Terminals panel
   * if needed, and shows it in its place. False without a thread, for an
   * invalid ID, or at the tab limit.
   */
  openTerminalTab(
    terminalId: string,
    input: PanelRegionFocusInput & { readonly region?: RegionId } = {},
  ): boolean {
    if (!this.#scoped) return false;
    if (input.region !== undefined && !isRegionId(input.region)) return false;
    const next = openTerminalTabIn(
      this.#currentView(),
      terminalId,
      this.#shared.createProducerId,
      input.region,
    );
    if (!next) return false;
    this.#commit(next, {
      focusRequest:
        input.focus === false
          ? KEEP
          : this.#requestFocus("terminals", input.focusScope, terminalId),
    });
    return true;
  }

  /** Selects an existing tab and shows Terminals in its place. */
  activateTerminalTab(terminalId: string, input: PanelRegionFocusInput = {}): boolean {
    const next = activateTerminalTabIn(this.#currentView(), terminalId);
    if (!next) return false;
    this.#commit(next, {
      focusRequest:
        input.focus === false
          ? KEEP
          : this.#requestFocus("terminals", input.focusScope, terminalId),
    });
    return true;
  }

  /**
   * Removes a tab; the panel stays loaded. Closing the active tab moves
   * focus to the tab that becomes active.
   */
  closeTerminalTab(terminalId: string): boolean {
    const view = this.#currentView();
    const next = closeTerminalTabIn(view, terminalId);
    if (!next) return false;
    const closedActive = view.terminals?.activeTerminalId === terminalId;
    this.#commit(next, {
      focusRequest: closedActive
        ? this.#requestFocus(
            "terminals",
            undefined,
            next.terminals?.activeTerminalId ?? undefined,
          )
        : KEEP,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Intents and focus requests

  consumeIntent(kind: PanelKind, sequence: number): void {
    const current = this.#intents.get(kind);
    if (
      typeof current !== "object" ||
      current === null ||
      (current as { sequence?: unknown }).sequence !== sequence
    )
      return;
    this.#intents.delete(kind);
    this.#publishOwn();
  }

  consumeFocusRequest(sequence: number): void {
    if (this.#focusRequest?.sequence !== sequence) return;
    this.#focusRequest = undefined;
    this.#publishOwn();
  }

  // -------------------------------------------------------------------------
  // Workspace dirty registry, for close and navigation guards

  setWorkspaceTenantDirty(workspaceId: string, tenantId: string, dirty: boolean): void {
    const wasDirty = this.hasAnyDirtyWorkspacePanels();
    const workspace = this.#shared.workspaceDirty.get(workspaceId);
    const owners = workspace?.get(tenantId);
    if (dirty) {
      const nextWorkspace = workspace ?? new Map<string, Set<string>>();
      const nextOwners = owners ?? new Set<string>();
      nextOwners.add(this.threadId);
      if (!owners) nextWorkspace.set(tenantId, nextOwners);
      if (!workspace) this.#shared.workspaceDirty.set(workspaceId, nextWorkspace);
      if (!wasDirty) this.#publishWorkspaceDirty();
      return;
    }
    owners?.delete(this.threadId);
    if (owners?.size === 0) workspace?.delete(tenantId);
    if (workspace?.size === 0) this.#shared.workspaceDirty.delete(workspaceId);
    if (wasDirty && !this.hasAnyDirtyWorkspacePanels()) this.#publishWorkspaceDirty();
  }
  hasDirtyWorkspacePanels(workspaceId: string): boolean {
    return Boolean(this.#shared.workspaceDirty.get(workspaceId)?.size);
  }
  hasAnyDirtyWorkspacePanels(): boolean {
    return this.#shared.workspaceDirty.size > 0;
  }
  discardWorkspacePanelChanges(workspaceId: string): void {
    const wasDirty = this.hasAnyDirtyWorkspacePanels();
    if (!this.#shared.workspaceDirty.delete(workspaceId)) return;
    if (wasDirty && !this.hasAnyDirtyWorkspacePanels()) this.#publishWorkspaceDirty();
  }

  // -------------------------------------------------------------------------
  // Cross-tab sync

  /**
   * Applies another browser tab's write (a `storage` event). The device
   * layout replaces this one's saved parts; a thread's Terminals replace that
   * thread's, when its store exists. Invalid values are ignored. Nothing is
   * written back.
   */
  applyStorageEvent(key: string | null, newValue: string | null): boolean {
    if (key === null) return false;
    const shared = this.#shared;
    if (key === PANEL_REGIONS_STORAGE_KEY) {
      const persisted =
        newValue === null ? defaultRegionLayout() : parseRegionLayout(newValue);
      if (!persisted) return false;
      const layout = restrictToAvailable(
        regionLayoutFromPersisted(persisted, {
          maximized:
            shared.layout.maximized !== null &&
            isSharedPanelKind(shared.layout.maximized) &&
            !persisted.loaded.includes(shared.layout.maximized)
              ? null
              : shared.layout.maximized,
          recency: shared.layout.recency,
        }),
        shared.available,
      );
      shared.persistedLayout = newValue ?? undefined;
      shared.layout = layout;
      this.#publishShared();
      return true;
    }
    const threadId = threadIdForPanelRegionsStorageKey(key);
    const store = threadId === undefined ? undefined : shared.threadStores.get(threadId);
    if (!store) return false;
    const parsed =
      newValue === null ? { terminals: null } : parseThreadTerminals(store.threadId, newValue);
    if (!parsed) return false;
    store.#persistedTerminals = newValue ?? undefined;
    store.#terminals = parsed.terminals;
    if (
      store.#focusRequest?.kind === "terminals" &&
      parsed.terminals === null
    )
      store.#focusRequest = undefined;
    store.#publishOwn();
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals

  #canLoad(kind: PanelKind): boolean {
    if (!isPanelKind(kind)) return false;
    if (kind === "terminals") return this.#scoped;
    return kind === "chat" || this.#shared.available.includes(kind);
  }

  #currentView(): RegionView {
    const view = this.#view;
    if (view?.layout === this.#shared.layout && view.terminals === this.#terminals)
      return view;
    const next = Object.freeze({ layout: this.#shared.layout, terminals: this.#terminals });
    this.#view = next;
    return next;
  }

  #hiddenByMakeRoom(view: RegionView): readonly PanelKind[] {
    const stage = this.#shared.stage;
    return stage ? hiddenByMakeRoom(view, stage, this.#shared.hints) : [];
  }

  #buildSnapshot(): PanelRegionSnapshot {
    const view = this.#currentView();
    const stage = this.#shared.stage;
    const geometry = stage
      ? computeRegionGeometry(view, stage, this.#shared.hints)
      : undefined;
    const hidden = geometry?.hiddenByMakeRoom ?? [];
    const terminals = this.#threadTerminalPanel(view.terminals);
    return Object.freeze({
      threadId: this.threadId,
      view,
      loaded: loadedPanels(view),
      visible: visiblePanels(view, hidden),
      hiddenByMakeRoom: hidden,
      maximized: effectiveMaximized(view),
      ...(stage ? { stage } : {}),
      ...(geometry ? { geometry } : {}),
      ...(terminals ? { terminals } : {}),
      ...(this.#focusRequest ? { focusRequest: this.#focusRequest } : {}),
      revision: ++this.#snapshotCount,
    });
  }

  /** This thread's Terminals, as the same object until they change. */
  #threadTerminalPanel(
    terminals: TerminalsPanelState | null,
  ): ThreadTerminalPanel | undefined {
    if (!this.#scoped || terminals === null) return undefined;
    if (this.#terminalPanel?.source !== terminals)
      this.#terminalPanel = {
        source: terminals,
        value: Object.freeze({ threadId: this.threadId, ...terminals }),
      };
    return this.#terminalPanel.value;
  }

  #requestFocus(
    kind: PanelKind,
    scope?: PanelFocusRequest["scope"],
    terminalId?: string,
  ): PanelFocusRequest {
    this.#shared.focusSequence += 1;
    return Object.freeze({
      kind,
      sequence: this.#shared.focusSequence,
      ...(terminalId ? { terminalId } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  #withoutFocusFor(kind: PanelKind): FocusChange {
    return this.#focusRequest?.kind === kind ? undefined : KEEP;
  }

  #commit(
    next: RegionView,
    options: { readonly focusRequest?: FocusChange; readonly publish?: boolean } = {},
  ): void {
    const shared = this.#shared;
    const layoutChanged = next.layout !== shared.layout;
    const terminalsChanged = next.terminals !== this.#terminals;
    // An explicit undefined clears the request; leaving it out keeps it.
    const change: FocusChange =
      "focusRequest" in options ? options.focusRequest : KEEP;
    const focusRequest = change === KEEP ? this.#focusRequest : change;
    const focusChanged = focusRequest !== this.#focusRequest;
    if (layoutChanged) {
      shared.layout = next.layout;
      this.#persistLayout();
    }
    if (terminalsChanged && this.#scoped) {
      this.#terminals = next.terminals;
      this.#persistTerminals();
    }
    this.#focusRequest = focusRequest;
    if (layoutChanged) {
      if (terminalsChanged || focusChanged || options.publish) this.#revision += 1;
      this.#publishShared();
    } else if (terminalsChanged || focusChanged || options.publish) {
      this.#publishOwn();
    }
  }

  #persistLayout(): void {
    const shared = this.#shared;
    const serialized = serializeRegionLayout(shared.layout);
    if (serialized === shared.persistedLayout) return;
    try {
      shared.storage?.setItem(PANEL_REGIONS_STORAGE_KEY, serialized);
      shared.persistedLayout = serialized;
    } catch {
      // Persistence is best effort.
    }
  }

  #persistTerminals(): void {
    if (!this.#scoped) return;
    const serialized = serializeThreadTerminals(this.threadId, this.#terminals);
    if (serialized === this.#persistedTerminals) return;
    try {
      this.#shared.storage?.setItem(
        threadPanelRegionsStorageKey(this.threadId),
        serialized,
      );
      this.#persistedTerminals = serialized;
    } catch {
      // Persistence is best effort.
    }
  }

  #publishOwn(): void {
    this.#revision += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  #publishShared(): void {
    this.#shared.revision += 1;
    const listeners = new Set<() => void>();
    for (const store of this.#shared.stores)
      for (const listener of store.#listeners) listeners.add(listener);
    for (const listener of listeners) listener();
  }

  #publishWorkspaceDirty(): void {
    for (const listener of [...this.#shared.dirtyListeners]) listener();
  }
}

function createSharedState(
  registry: WorkspacePanelTenantRegistry,
  options: PanelRegionStoreOptions,
): SharedRegionState {
  const storage = options.storage ?? browserStorage();
  const available = SHARED_PANEL_KINDS.filter((kind) =>
    registry.has(tenantIdForKind(kind)),
  );
  const { layout: loaded, source } = loadRegionLayout(storage);
  const layout = restrictToAvailable(loaded, available);
  const shared: SharedRegionState = {
    layout,
    stage: undefined,
    revision: 0,
    focusSequence: 0,
    // What storage holds, or would hold: only a real change is written.
    // A layout narrowed to the registered tenants is written on its next change.
    persistedLayout:
      source !== "migrated" && layout === loaded
        ? serializeRegionLayout(layout)
        : undefined,
    storage,
    hints: options.sizeHints ?? panelSizeHints(registry),
    available,
    createProducerId: options.createProducerId ?? (() => crypto.randomUUID()),
    stores: new Set(),
    threadStores: new Map(),
    dirtyListeners: new Set(),
    workspaceDirty: new Map(),
  };
  // Migration happens once: its result is saved under the new key.
  if (source === "migrated") {
    const serialized = serializeRegionLayout(layout);
    try {
      storage?.setItem(PANEL_REGIONS_STORAGE_KEY, serialized);
      shared.persistedLayout = serialized;
    } catch {
      // Persistence is best effort.
    }
  }
  return shared;
}

/** The layout without device-wide kinds whose tenant is not registered. */
function restrictToAvailable(
  layout: RegionLayout,
  available: readonly SharedPanelKind[],
): RegionLayout {
  let view: RegionView = { layout, terminals: null };
  for (const kind of SHARED_PANEL_KINDS)
    if (!available.includes(kind)) view = closePanel(view, kind);
  return view.layout;
}

export function usePanelRegions(store: PanelRegionStore): PanelRegionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Keeps a store in step with other browser tabs' panel region writes. */
export function installPanelRegionStorageSync(
  store: Pick<PanelRegionStore, "applyStorageEvent">,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const listener = (event: StorageEvent) => {
    store.applyStorageEvent(event.key, event.newValue);
  };
  target.addEventListener("storage", listener);
  return () => target.removeEventListener("storage", listener);
}
