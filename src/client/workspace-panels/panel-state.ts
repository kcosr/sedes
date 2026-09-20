import { useSyncExternalStore } from "react";
import {
  panelLayoutStorageKey,
  MAX_TERMINAL_TABS,
  activatePanel as activateLayoutPanel,
  closePanel as closeLayoutPanel,
  defaultPanelLayout,
  deserializePanelLayout,
  dockPanel as dockLayoutPanel,
  findPanel,
  findPanelByKind,
  findStackForPanel,
  openPanel as openLayoutPanel,
  panelInstances,
  resizeSplit as resizeLayoutSplit,
  replacePanel as replaceLayoutPanel,
  serializePanelLayout,
  type PanelInstance,
  type PanelInstanceId,
  type PanelKind,
  type PanelLayoutTree,
  type PanelPlacementEdge,
  type TerminalTab,
} from "./layout-tree.js";
import type { WorkspacePanelTenantRegistry } from "./registry.js";
import type { PanelPresentation } from "./panel-presentation.js";
import { projectPanelLayout } from "./layout-presentation.js";

export const PANEL_SIZE_STORAGE_KEY = "sedes-panel-instance-sizes@4";
export const WORKSPACE_FILES_STATE_STORAGE_KEY =
  "sedes-workspace-files-panel-state@1";
export const WORKPADS_STATE_STORAGE_KEY = "sedes-workpads-panel-state@1";
const PANEL_SIZE_STORAGE_VERSION = 4 as const;
const PANEL_COLLAPSED_STORAGE_VERSION = 4 as const;
export function panelCollapsedStorageKey(threadId: string): string {
  return `sedes-thread-panel-instance-collapsed@4:${encodeURIComponent(threadId)}`;
}
const MIN_RETAINED_PANEL_FRACTION = 0.05;
const MAX_RETAINED_PANEL_FRACTION = 0.95;

interface RetainedPanelSize {
  readonly fraction: number;
}

export interface PanelFocusRequest {
  readonly panelInstanceId: PanelInstanceId;
  readonly terminalId?: string;
  readonly sequence: number;
  readonly scope?: {
    readonly kind: "thread";
    readonly threadId: string;
  };
}

export interface PanelLayoutSnapshot {
  readonly tree: PanelLayoutTree;
  readonly collapsed: ReadonlySet<PanelInstanceId>;
  /** Ephemeral foreground projection; canonical layout persistence is unchanged. */
  readonly soloPanelInstanceId?: PanelInstanceId;
  readonly focusRequest?: PanelFocusRequest;
  readonly revision: number;
}

export interface PanelOpenInput {
  readonly intent?: unknown;
  readonly availableWidth?: number;
  readonly availableHeight?: number;
  readonly focus?: boolean;
  readonly mode?: "split" | "tab";
  readonly targetNodeId?: string;
  readonly edge?: PanelPlacementEdge;
  readonly focusScope?: PanelFocusRequest["scope"];
  readonly focusTerminalId?: string;
  readonly presentation?: PanelPresentation;
}

export interface PanelRestoreInput {
  readonly focus?: boolean;
  readonly presentation?: PanelPresentation;
}

export interface PanelLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PanelLayoutStoreOptions {
  readonly threadId?: string;
  readonly storage?: PanelLayoutStorage;
  readonly createId?: (kind: "split" | "stack" | "panel") => string;
  readonly createProducerId?: () => string;
}

interface SharedPanelState {
  readonly dirtyListeners: Set<() => void>;
  readonly workspaceDirty: Map<string, Map<string, Set<string>>>;
  readonly threadStores: Map<string, PanelLayoutStore>;
  workpadsState: { readonly open: boolean; readonly collapsed: boolean };
  workspaceFilesState?: {
    readonly open: boolean;
    readonly collapsed: boolean;
  };
}

function browserStorage(): PanelLayoutStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readSharedPanelState(
  storage: PanelLayoutStorage | undefined,
  key: string,
): SharedPanelState["workspaceFilesState"] {
  try {
    const serialized = storage?.getItem(key);
    if (!serialized) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 1 ||
      typeof (parsed as Record<string, unknown>).open !== "boolean" ||
      typeof (parsed as Record<string, unknown>).collapsed !== "boolean"
    )
      return undefined;
    const state = parsed as {
      readonly open: boolean;
      readonly collapsed: boolean;
    };
    return {
      open: state.open,
      collapsed: state.open && state.collapsed,
    };
  } catch {
    return undefined;
  }
}

function defaultId(kind: "split" | "stack" | "panel"): string {
  return `panel-${kind}-${crypto.randomUUID()}`;
}

class SnapshotReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;
  constructor(values: Iterable<T> = []) {
    this.#values = new Set(values);
  }
  get size(): number {
    return this.#values.size;
  }
  has(value: T): boolean {
    return this.#values.has(value);
  }
  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }
  keys(): SetIterator<T> {
    return this.#values.keys();
  }
  values(): SetIterator<T> {
    return this.#values.values();
  }
  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values)
      callbackfn.call(thisArg, value, value, this);
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }
}

const EMPTY_COLLAPSED: ReadonlySet<PanelInstanceId> = new SnapshotReadonlySet();

export class PanelLayoutStore {
  readonly registry: WorkspacePanelTenantRegistry;
  readonly #storage?: PanelLayoutStorage;
  readonly #createId: (kind: "split" | "stack" | "panel") => string;
  readonly #createProducerId: () => string;
  readonly #threadId: string;
  readonly #shared: SharedPanelState;
  readonly #retainedPanelSizes: Map<PanelKind, RetainedPanelSize>;
  readonly #listeners = new Set<() => void>();
  readonly #intents = new Map<PanelInstanceId, unknown>();
  #focusSequence = 0;
  #snapshot: PanelLayoutSnapshot;

  constructor(
    registry: WorkspacePanelTenantRegistry,
    options: PanelLayoutStoreOptions & {
      readonly shared?: SharedPanelState;
    } = {},
  ) {
    this.registry = registry;
    this.#storage = options.storage ?? browserStorage();
    this.#createId = options.createId ?? defaultId;
    this.#createProducerId =
      options.createProducerId ?? (() => crypto.randomUUID());
    this.#threadId = options.threadId ?? "unscoped";
    this.#shared = options.shared ?? {
      dirtyListeners: new Set(),
      workspaceDirty: new Map(),
      threadStores: new Map(),
      workspaceFilesState: readSharedPanelState(this.#storage, WORKSPACE_FILES_STATE_STORAGE_KEY),
      workpadsState: readSharedPanelState(this.#storage, WORKPADS_STATE_STORAGE_KEY) ?? { open: false, collapsed: false },
    };
    let stored: string | null = null;
    let storedSizes: string | null = null;
    let storedCollapsed: string | null = null;
    try {
      stored =
        this.#storage?.getItem(panelLayoutStorageKey(this.#threadId)) ?? null;
      storedSizes = this.#storage?.getItem(PANEL_SIZE_STORAGE_KEY) ?? null;
      storedCollapsed =
        this.#storage?.getItem(panelCollapsedStorageKey(this.#threadId)) ??
        null;
    } catch {
      // Denied storage must not prevent the workbench from loading.
    }
    this.#retainedPanelSizes = deserializeRetainedPanelSizes(storedSizes);
    const tree = deserializePanelLayout(this.#threadId, stored);
    this.#snapshot = {
      tree,
      collapsed: deserializeCollapsedPanels(storedCollapsed, tree),
      revision: 0,
    };
    this.#reconcileWorkpads();
    if (options.threadId) this.#shared.threadStores.set(options.threadId, this);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): PanelLayoutSnapshot => this.#snapshot;
  subscribeWorkspaceDirty = (listener: () => void): (() => void) => {
    this.#shared.dirtyListeners.add(listener);
    return () => this.#shared.dirtyListeners.delete(listener);
  };

  forThread(threadId: string): PanelLayoutStore {
    const existing = this.#shared.threadStores.get(threadId);
    if (existing) {
      existing.#reconcileWorkspaceFiles();
      existing.#reconcileWorkpads();
      return existing;
    }
    const store = new PanelLayoutStore(this.registry, {
      storage: this.#storage,
      createId: this.#createId,
      createProducerId: this.#createProducerId,
      threadId,
      shared: this.#shared,
    });
    this.#shared.threadStores.set(threadId, store);
    if (this.#shared.workspaceFilesState === undefined) {
      store.#setWorkspaceFilesState({
        open: store.hasPanel("workspace-files"),
        collapsed: store.isCollapsed("workspace-files"),
      });
    } else store.#reconcileWorkspaceFiles();
    return store;
  }

  panels(): readonly PanelInstance[] {
    return panelInstances(this.#snapshot.tree);
  }
  panel(panelInstanceId: string): PanelInstance | undefined {
    return findPanel(this.#snapshot.tree, panelInstanceId);
  }
  terminalPanel(): Extract<PanelInstance, { kind: "terminals" }> | undefined {
    return findPanelByKind(this.#snapshot.tree, "terminals");
  }
  terminalTab(terminalId: string): TerminalTab | undefined {
    return this.terminalPanel()?.tabs.find(
      (tab) => tab.terminalId === terminalId,
    );
  }
  hasPanel(panelInstanceId: string): boolean {
    return Boolean(this.panel(panelInstanceId));
  }
  hasPanelKind(kind: PanelKind): boolean {
    return Boolean(findPanelByKind(this.#snapshot.tree, kind));
  }
  isVisible(panelInstanceId: string): boolean {
    if (
      this.#snapshot.soloPanelInstanceId !== undefined &&
      this.#snapshot.soloPanelInstanceId !== panelInstanceId
    )
      return false;
    const stack = findStackForPanel(this.#snapshot.tree, panelInstanceId);
    return Boolean(
      stack?.activePanelInstanceId === panelInstanceId &&
      !this.#snapshot.collapsed.has(panelInstanceId),
    );
  }
  isCollapsed(panelInstanceId: string): boolean {
    return (
      this.hasPanel(panelInstanceId) &&
      this.#snapshot.collapsed.has(panelInstanceId)
    );
  }
  intent(panelInstanceId: string): unknown {
    return this.#intents.get(panelInstanceId);
  }

  consumeIntent(panelInstanceId: string, sequence: number): void {
    const current = this.#intents.get(panelInstanceId);
    if (
      typeof current !== "object" ||
      current === null ||
      (current as { sequence?: unknown }).sequence !== sequence
    )
      return;
    this.#intents.delete(panelInstanceId);
    this.#publish({});
  }

  consumeFocusRequest(sequence: number): void {
    if (this.#snapshot.focusRequest?.sequence !== sequence) return;
    this.#publish({ focusRequest: undefined });
  }

  /** Restores the canonical Chat-only layout and persists the empty collapse set. */
  resetLayout(): void {
    const hadWorkspaceFiles = this.hasPanel("workspace-files");
    this.#intents.clear();
    this.#publish({
      tree: defaultPanelLayout,
      collapsed: EMPTY_COLLAPSED,
      soloPanelInstanceId: "chat",
      focusRequest: this.#requestFocus("chat"),
      persistTree: true,
      persistCollapsed: true,
    });
    if (hadWorkspaceFiles) {
      this.#setWorkspaceFilesState({ open: false, collapsed: false });
    }
  }

  openPanel(panelId: string, input: PanelOpenInput = {}): boolean {
    const kind =
      panelId === "chat"
        ? "chat"
        : panelId === "workspace-files"
          ? "files"
          : panelId === "workpads" ? "workpads" : undefined;
    if (!kind || (kind !== "chat" && !this.registry.has(panelId)))
      return false;
    const existing = findPanelByKind(this.#snapshot.tree, kind);
    const opened = existing
      ? this.#showExisting(existing.panelInstanceId, input)
      : this.openPanelInstance({ panelInstanceId: panelId, kind }, input);
    if (opened && kind === "files") {
      this.#setWorkspaceFilesState({ open: true, collapsed: false });
    }
    return opened;
  }

  openTerminalTab(
    terminalId: string,
    input: PanelOpenInput = {},
  ): PanelInstanceId | undefined {
    const existing = this.terminalPanel();
    if (!existing) {
      return this.openPanelInstance(
        {
          panelInstanceId: "terminals",
          kind: "terminals",
          threadId: this.#threadId,
          tabs: [{ terminalId, producerId: this.#createProducerId() }],
          activeTerminalId: terminalId,
        },
        {
          ...input,
          mode: input.mode ?? "split",
          edge: input.edge ?? "bottom",
          focusTerminalId: terminalId,
        },
      )
        ? "terminals"
        : undefined;
    }
    const currentTab = existing.tabs.find(
      (tab) => tab.terminalId === terminalId,
    );
    if (!currentTab && existing.tabs.length >= MAX_TERMINAL_TABS)
      return undefined;
    const nextPanel: typeof existing = {
      ...existing,
      tabs: currentTab
        ? existing.tabs
        : [
            ...existing.tabs,
            { terminalId, producerId: this.#createProducerId() },
          ],
      activeTerminalId: terminalId,
    };
    const tree = activateLayoutPanel(
      replaceLayoutPanel(this.#snapshot.tree, nextPanel),
      existing.panelInstanceId,
    );
    const collapsed = new Set(this.#snapshot.collapsed);
    const restored = collapsed.delete(existing.panelInstanceId);
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId: this.#presentationTarget(
        existing.panelInstanceId,
        input.presentation,
      ),
      focusRequest:
        input.focus === false
          ? this.#snapshot.focusRequest
          : this.#requestFocus(
              existing.panelInstanceId,
              input.focusScope,
              terminalId,
            ),
      persistTree: tree !== this.#snapshot.tree,
      persistCollapsed: restored,
    });
    return existing.panelInstanceId;
  }

  activateTerminalTab(
    terminalId: string,
    input: PanelRestoreInput = {},
  ): boolean {
    const panel = this.terminalPanel();
    if (!panel?.tabs.some((tab) => tab.terminalId === terminalId)) return false;
    const updated =
      panel.activeTerminalId === terminalId
        ? panel
        : { ...panel, activeTerminalId: terminalId };
    const tree = activateLayoutPanel(
      replaceLayoutPanel(this.#snapshot.tree, updated),
      panel.panelInstanceId,
    );
    const collapsed = new Set(this.#snapshot.collapsed);
    const restored = collapsed.delete(panel.panelInstanceId);
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId: this.#presentationTarget(
        panel.panelInstanceId,
        input.presentation,
      ),
      focusRequest:
        input.focus === false
          ? this.#snapshot.focusRequest
          : this.#requestFocus(panel.panelInstanceId, undefined, terminalId),
      persistTree: tree !== this.#snapshot.tree,
      persistCollapsed: restored,
    });
    return true;
  }

  closeTerminalTab(terminalId: string): boolean {
    const panel = this.terminalPanel();
    if (!panel) return false;
    const index = panel.tabs.findIndex((tab) => tab.terminalId === terminalId);
    if (index < 0) return false;
    const tabs = panel.tabs.filter((tab) => tab.terminalId !== terminalId);
    const activeTerminalId =
      panel.activeTerminalId === terminalId
        ? tabs[Math.max(0, index - 1)]?.terminalId ?? null
        : panel.activeTerminalId;
    const tree = replaceLayoutPanel(this.#snapshot.tree, {
      ...panel,
      tabs,
      activeTerminalId,
    });
    this.#publish({
      tree,
      focusRequest:
        panel.activeTerminalId === terminalId
          ? this.#requestFocus(panel.panelInstanceId, undefined, activeTerminalId ?? undefined)
          : this.#snapshot.focusRequest,
      persistTree: true,
    });
    return true;
  }

  openPanelInstance(panel: PanelInstance, input: PanelOpenInput = {}): boolean {
    if (this.hasPanel(panel.panelInstanceId)) return false;
    const tree = openLayoutPanel(this.#snapshot.tree, panel, {
      edge: input.edge ?? this.#preferredEdge(panel.kind),
      preferredPanelFraction:
        this.#retainedPanelSizes.get(panel.kind)?.fraction ??
        this.#preferredFraction(panel.kind, input),
      splitId: this.#createId("split"),
      stackId: this.#createId("stack"),
      targetNodeId: input.targetNodeId,
      mode: input.mode,
    });
    if (tree === this.#snapshot.tree) return false;
    if (input.intent !== undefined)
      this.#intents.set(panel.panelInstanceId, input.intent);
    this.#publish({
      tree,
      soloPanelInstanceId: this.#presentationTarget(
        panel.panelInstanceId,
        input.presentation,
      ),
      focusRequest:
        input.focus === false
          ? this.#snapshot.focusRequest
          : this.#requestFocus(
              panel.panelInstanceId,
              input.focusScope,
              input.focusTerminalId,
            ),
      persistTree: true,
    });
    return true;
  }

  #showExisting(
    panelInstanceId: PanelInstanceId,
    input: PanelOpenInput,
  ): boolean {
    const tree = activateLayoutPanel(this.#snapshot.tree, panelInstanceId);
    const collapsed = new Set(this.#snapshot.collapsed);
    const restored = collapsed.delete(panelInstanceId);
    const deliversIntent = input.intent !== undefined;
    if (deliversIntent) this.#intents.set(panelInstanceId, input.intent);
    const requestsFocus = input.focus !== false;
    const soloPanelInstanceId = this.#presentationTarget(
      panelInstanceId,
      input.presentation,
    );
    if (
      tree === this.#snapshot.tree &&
      !restored &&
      !deliversIntent &&
      !requestsFocus &&
      soloPanelInstanceId === this.#snapshot.soloPanelInstanceId
    )
      return true;
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId,
      focusRequest: requestsFocus
        ? this.#requestFocus(panelInstanceId, input.focusScope)
        : this.#snapshot.focusRequest,
      persistTree: tree !== this.#snapshot.tree,
      persistCollapsed: restored,
    });
    return true;
  }

  activatePanel(
    panelInstanceId: string,
    input: PanelRestoreInput = {},
  ): boolean {
    if (!this.hasPanel(panelInstanceId)) return false;
    const tree = activateLayoutPanel(this.#snapshot.tree, panelInstanceId);
    const collapsed = new Set(this.#snapshot.collapsed);
    const restored = collapsed.delete(panelInstanceId);
    const soloPanelInstanceId = this.#presentationTarget(
      panelInstanceId,
      input.presentation,
    );
    if (
      tree === this.#snapshot.tree &&
      !restored &&
      input.focus === false &&
      soloPanelInstanceId === this.#snapshot.soloPanelInstanceId
    )
      return false;
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId,
      focusRequest:
        input.focus === false
          ? this.#snapshot.focusRequest
          : this.#requestFocus(panelInstanceId),
      persistTree: tree !== this.#snapshot.tree,
      persistCollapsed: restored,
    });
    return true;
  }

  collapsePanel(panelInstanceId: string): boolean {
    if (!this.hasPanel(panelInstanceId) || this.isCollapsed(panelInstanceId))
      return false;
    const collapsed = new Set(this.#snapshot.collapsed);
    collapsed.add(panelInstanceId);
    this.#publish({
      collapsed,
      soloPanelInstanceId:
        this.#snapshot.soloPanelInstanceId === panelInstanceId
          ? this.#firstVisiblePanel(this.#snapshot.tree, collapsed)
          : this.#snapshot.soloPanelInstanceId,
      focusRequest:
        this.#snapshot.focusRequest?.panelInstanceId === panelInstanceId
          ? undefined
          : this.#snapshot.focusRequest,
      persistCollapsed: true,
    });
    if (panelInstanceId === "workspace-files") {
      this.#setWorkspaceFilesState({ open: true, collapsed: true });
    }
    return true;
  }

  restorePanel(
    panelInstanceId: string,
    input: PanelRestoreInput = {},
  ): boolean {
    if (!this.isCollapsed(panelInstanceId)) return false;
    const collapsed = new Set(this.#snapshot.collapsed);
    collapsed.delete(panelInstanceId);
    const tree = activateLayoutPanel(this.#snapshot.tree, panelInstanceId);
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId: this.#presentationTarget(
        panelInstanceId,
        input.presentation,
      ),
      focusRequest:
        input.focus === false
          ? this.#snapshot.focusRequest
          : this.#requestFocus(panelInstanceId),
      persistTree: tree !== this.#snapshot.tree,
      persistCollapsed: true,
    });
    if (panelInstanceId === "workspace-files") {
      this.#setWorkspaceFilesState({ open: true, collapsed: false });
    }
    return true;
  }

  restoreAllPanels(): boolean {
    if (this.#snapshot.collapsed.size === 0) return false;
    const restoresWorkspaceFiles = this.isCollapsed("workspace-files");
    this.#publish({ collapsed: new Set(), persistCollapsed: true });
    if (restoresWorkspaceFiles) {
      this.#setWorkspaceFilesState({ open: true, collapsed: false });
    }
    return true;
  }

  closePanel(panelInstanceId: string): boolean {
    const panel = this.panel(panelInstanceId);
    if (!panel) return false;
    this.#rememberPanelSize(panelInstanceId, panel.kind);
    const tree = closeLayoutPanel(this.#snapshot.tree, panelInstanceId);
    const collapsed = new Set(this.#snapshot.collapsed);
    collapsed.delete(panelInstanceId);
    this.#intents.delete(panelInstanceId);
    this.#publish({
      tree,
      collapsed,
      soloPanelInstanceId:
        this.#snapshot.soloPanelInstanceId === panelInstanceId
          ? this.#firstVisiblePanel(tree, collapsed)
          : this.#snapshot.soloPanelInstanceId,
      focusRequest:
        this.#snapshot.focusRequest?.panelInstanceId === panelInstanceId
          ? undefined
          : this.#snapshot.focusRequest,
      persistTree: true,
      persistCollapsed: this.#snapshot.collapsed.has(panelInstanceId),
    });
    if (panel.kind === "files") {
      this.#setWorkspaceFilesState({ open: false, collapsed: false });
    }
    return true;
  }

  dockPanel(panelInstanceId: string, edge: PanelPlacementEdge): boolean {
    if (!this.hasPanel(panelInstanceId)) return false;
    const tree = dockLayoutPanel(this.#snapshot.tree, panelInstanceId, edge, {
      splitId: this.#createId("split"),
      stackId: this.#createId("stack"),
    });
    if (tree === this.#snapshot.tree) return false;
    this.#publish({ tree, persistTree: true });
    return true;
  }

  resizeSplit(splitId: string, sizes: readonly number[]): boolean {
    const tree = resizeLayoutSplit(this.#snapshot.tree, splitId, sizes);
    if (tree === this.#snapshot.tree) return false;
    this.#publish({ tree, persistTree: true });
    return true;
  }

  setWorkspaceTenantDirty(
    workspaceId: string,
    tenantId: string,
    dirty: boolean,
  ): void {
    const wasDirty = this.hasAnyDirtyWorkspacePanels();
    const workspace = this.#shared.workspaceDirty.get(workspaceId);
    const owners = workspace?.get(tenantId);
    if (dirty) {
      const nextWorkspace = workspace ?? new Map<string, Set<string>>();
      const nextOwners = owners ?? new Set<string>();
      nextOwners.add(this.#threadId);
      if (!owners) nextWorkspace.set(tenantId, nextOwners);
      if (!workspace)
        this.#shared.workspaceDirty.set(workspaceId, nextWorkspace);
      if (!wasDirty) this.#publishWorkspaceDirty();
      return;
    }
    owners?.delete(this.#threadId);
    if (owners?.size === 0) workspace?.delete(tenantId);
    if (workspace?.size === 0) this.#shared.workspaceDirty.delete(workspaceId);
    if (wasDirty && !this.hasAnyDirtyWorkspacePanels())
      this.#publishWorkspaceDirty();
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
    if (wasDirty && !this.hasAnyDirtyWorkspacePanels())
      this.#publishWorkspaceDirty();
  }

  #preferredEdge(kind: PanelKind): PanelPlacementEdge {
    if (kind === "chat") return "left";
    if (kind === "terminals") return "bottom";
    return (
      this.registry.tenant(kind === "files" ? "workspace-files" : "workpads")?.preferredPlacement.edge ??
      "right"
    );
  }

  #preferredFraction(
    kind: PanelKind,
    input: PanelOpenInput,
  ): number | undefined {
    if (kind !== "files" && kind !== "workpads") return undefined;
    const tenant = this.registry.tenant(kind === "files" ? "workspace-files" : "workpads");
    if (!tenant) return undefined;
    const edge = tenant.preferredPlacement.edge;
    const available =
      edge === "right" ? input.availableWidth : input.availableHeight;
    const preferred =
      edge === "right"
        ? tenant.size.preferredWidth
        : tenant.size.preferredHeight;
    if (!available || !Number.isFinite(available) || available <= 0)
      return undefined;
    return Math.min(0.7, Math.max(0.1, preferred / available));
  }

  #requestFocus(
    panelInstanceId: PanelInstanceId,
    scope?: PanelFocusRequest["scope"],
    terminalId?: string,
  ): PanelFocusRequest {
    this.#focusSequence += 1;
    return Object.freeze({
      panelInstanceId,
      sequence: this.#focusSequence,
      ...(terminalId ? { terminalId } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  #rememberPanelSize(panelInstanceId: PanelInstanceId, kind: PanelKind): void {
    const fraction = panelFractionInParent(
      this.#snapshot.tree,
      panelInstanceId,
    );
    if (
      fraction === undefined ||
      fraction < MIN_RETAINED_PANEL_FRACTION ||
      fraction > MAX_RETAINED_PANEL_FRACTION
    )
      return;
    this.#retainedPanelSizes.set(kind, { fraction });
    try {
      this.#storage?.setItem(
        PANEL_SIZE_STORAGE_KEY,
        serializeRetainedPanelSizes(this.#retainedPanelSizes),
      );
    } catch {
      // Persistence is best effort.
    }
  }

  #publishWorkspaceDirty(): void {
    for (const listener of this.#shared.dirtyListeners) listener();
  }

  #setWorkspaceFilesState(state: {
    readonly open: boolean;
    readonly collapsed: boolean;
  }): void {
    this.#shared.workspaceFilesState = state;
    try {
      this.#storage?.setItem(
        WORKSPACE_FILES_STATE_STORAGE_KEY,
        JSON.stringify({ version: 1, ...state }),
      );
    } catch {
      // Persistence is best effort.
    }
  }

  #reconcileWorkpads(): void {
    if (!this.registry.has("workpads")) return;
    const state = this.#shared.workpadsState;
    const panel = findPanelByKind(this.#snapshot.tree, "workpads");
    let tree = this.#snapshot.tree;
    if (!state.open && panel) tree = closeLayoutPanel(tree, panel.panelInstanceId);
    if (state.open && !panel) {
      tree = openLayoutPanel(tree, { panelInstanceId: "workpads", kind: "workpads" }, {
        edge: this.#preferredEdge("workpads"),
        preferredPanelFraction: this.#retainedPanelSizes.get("workpads")?.fraction,
        splitId: this.#createId("split"),
        stackId: this.#createId("stack"),
      });
    }
    const collapsed = new Set(this.#snapshot.collapsed);
    if (state.open && state.collapsed) collapsed.add("workpads");
    else collapsed.delete("workpads");
    if (tree !== this.#snapshot.tree || state.collapsed !== this.#snapshot.collapsed.has("workpads")) {
      this.#publish({ tree, collapsed });
    }
  }

  #reconcileWorkspaceFiles(): void {
    const state = this.#shared.workspaceFilesState;
    if (!state || !this.registry.has("workspace-files")) return;
    const panel = findPanelByKind(this.#snapshot.tree, "files");
    if (!state.open) {
      if (!panel) return;
      const collapsed = new Set(this.#snapshot.collapsed);
      collapsed.delete(panel.panelInstanceId);
      this.#publish({
        tree: closeLayoutPanel(this.#snapshot.tree, panel.panelInstanceId),
        collapsed,
      });
      return;
    }
    let tree = this.#snapshot.tree;
    if (!panel) {
      tree = openLayoutPanel(
        tree,
        { panelInstanceId: "workspace-files", kind: "files" },
        {
          edge: this.#preferredEdge("files"),
          preferredPanelFraction:
            this.#retainedPanelSizes.get("files")?.fraction,
          splitId: this.#createId("split"),
          stackId: this.#createId("stack"),
        },
      );
    }
    const collapsed = new Set(this.#snapshot.collapsed);
    if (state.collapsed) collapsed.add("workspace-files");
    else collapsed.delete("workspace-files");
    if (
      tree !== this.#snapshot.tree ||
      state.collapsed !== this.#snapshot.collapsed.has("workspace-files")
    ) {
      this.#publish({ tree, collapsed });
    }
  }

  #publish(input: {
    readonly tree?: PanelLayoutTree;
    readonly collapsed?: Iterable<PanelInstanceId>;
    readonly soloPanelInstanceId?: PanelInstanceId;
    readonly focusRequest?: PanelFocusRequest;
    readonly persistTree?: boolean;
    readonly persistCollapsed?: boolean;
  }): void {
    const previousWorkpadsOpen = this.hasPanelKind("workpads");
    const previousWorkpadsCollapsed = this.isCollapsed("workpads");
    const tree = "tree" in input ? input.tree! : this.#snapshot.tree;
    const collapsed =
      input.collapsed === undefined
        ? this.#snapshot.collapsed
        : new SnapshotReadonlySet(input.collapsed);
    const focusRequest =
      "focusRequest" in input
        ? input.focusRequest
        : this.#snapshot.focusRequest;
    const requestedSoloPanelInstanceId =
      "soloPanelInstanceId" in input
        ? input.soloPanelInstanceId
        : this.#snapshot.soloPanelInstanceId;
    const soloPanelInstanceId = requestedSoloPanelInstanceId
      ? this.#isVisibleIn(tree, collapsed, requestedSoloPanelInstanceId)
        ? requestedSoloPanelInstanceId
        : this.#firstVisiblePanel(tree, collapsed)
      : undefined;
    this.#snapshot = {
      tree,
      collapsed,
      ...(soloPanelInstanceId ? { soloPanelInstanceId } : {}),
      ...(focusRequest ? { focusRequest } : {}),
      revision: this.#snapshot.revision + 1,
    };
    // Layout placement stays thread-local; Workpads membership and collapse
    // belong to this browser client's panel state, across all threads.
    if ((input.persistTree || input.persistCollapsed) && (
      previousWorkpadsOpen !== this.hasPanelKind("workpads") ||
      previousWorkpadsCollapsed !== this.isCollapsed("workpads")
    )) {
      const state = { open: this.hasPanelKind("workpads"), collapsed: this.isCollapsed("workpads") };
      this.#shared.workpadsState = state;
      try {
        this.#storage?.setItem(WORKPADS_STATE_STORAGE_KEY, JSON.stringify({ version: 1, ...state }));
      } catch {
        // Persistence is best effort.
      }
    }
    if (input.persistTree) {
      try {
        this.#storage?.setItem(
          panelLayoutStorageKey(this.#threadId),
          serializePanelLayout(this.#threadId, tree),
        );
      } catch {}
    }
    if (input.persistCollapsed) {
      try {
        this.#storage?.setItem(
          panelCollapsedStorageKey(this.#threadId),
          serializeCollapsedPanels(collapsed),
        );
      } catch {}
    }
    for (const listener of this.#listeners) listener();
  }

  #presentationTarget(
    panelInstanceId: PanelInstanceId,
    presentation: PanelPresentation | undefined,
  ): PanelInstanceId | undefined {
    if (presentation === "split") return undefined;
    if (presentation === "single") return panelInstanceId;
    return this.#snapshot.soloPanelInstanceId === undefined
      ? undefined
      : panelInstanceId;
  }

  #firstVisiblePanel(
    tree: PanelLayoutTree,
    collapsed: ReadonlySet<PanelInstanceId>,
  ): PanelInstanceId | undefined {
    const projected = projectPanelLayout(tree, collapsed);
    return panelInstances(projected).find((panel) => {
      const stack = findStackForPanel(projected, panel.panelInstanceId);
      return stack?.activePanelInstanceId === panel.panelInstanceId;
    })?.panelInstanceId;
  }

  #isVisibleIn(
    tree: PanelLayoutTree,
    collapsed: ReadonlySet<PanelInstanceId>,
    panelInstanceId: PanelInstanceId,
  ): boolean {
    const projected = projectPanelLayout(tree, collapsed);
    const stack = findStackForPanel(projected, panelInstanceId);
    return stack?.activePanelInstanceId === panelInstanceId;
  }
}

function panelFractionInParent(
  tree: PanelLayoutTree,
  panelInstanceId: string,
): number | undefined {
  if (!tree || tree.kind === "tabs") return undefined;
  for (const index of [0, 1] as const) {
    if (findPanel(tree.children[index], panelInstanceId)) {
      return (
        panelFractionInParent(tree.children[index], panelInstanceId) ??
        tree.sizes[index]
      );
    }
  }
  return undefined;
}

function deserializeCollapsedPanels(
  serialized: string | null,
  tree: PanelLayoutTree,
): ReadonlySet<PanelInstanceId> {
  if (serialized === null) return EMPTY_COLLAPSED;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !==
        PANEL_COLLAPSED_STORAGE_VERSION ||
      !Array.isArray((parsed as Record<string, unknown>).collapsed)
    )
      return EMPTY_COLLAPSED;
    const collapsed = (parsed as { collapsed: unknown[] }).collapsed.filter(
      (id): id is string =>
        typeof id === "string" && Boolean(findPanel(tree, id)),
    );
    return collapsed.length === 0
      ? EMPTY_COLLAPSED
      : new SnapshotReadonlySet(collapsed);
  } catch {
    return EMPTY_COLLAPSED;
  }
}

function serializeCollapsedPanels(
  collapsed: ReadonlySet<PanelInstanceId>,
): string {
  return JSON.stringify({
    version: PANEL_COLLAPSED_STORAGE_VERSION,
    collapsed: [...collapsed].sort(),
  });
}

function deserializeRetainedPanelSizes(
  serialized: string | null,
): Map<PanelKind, RetainedPanelSize> {
  const retained = new Map<PanelKind, RetainedPanelSize>();
  if (serialized === null) return retained;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== PANEL_SIZE_STORAGE_VERSION
    )
      return retained;
    const sizes = (parsed as Record<string, unknown>).sizes;
    if (typeof sizes !== "object" || sizes === null || Array.isArray(sizes))
      return retained;
    for (const kind of ["chat", "files", "workpads", "terminals"] as const) {
      const raw = (sizes as Record<string, unknown>)[kind];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        continue;
      const fraction = (raw as Record<string, unknown>).fraction;
      if (
        typeof fraction === "number" &&
        Number.isFinite(fraction) &&
        fraction >= MIN_RETAINED_PANEL_FRACTION &&
        fraction <= MAX_RETAINED_PANEL_FRACTION
      )
        retained.set(kind, { fraction });
    }
  } catch {}
  return retained;
}

function serializeRetainedPanelSizes(
  sizes: ReadonlyMap<PanelKind, RetainedPanelSize>,
): string {
  return JSON.stringify({
    version: PANEL_SIZE_STORAGE_VERSION,
    sizes: Object.fromEntries(
      [...sizes].sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}

export function usePanelLayout(store: PanelLayoutStore): PanelLayoutSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
