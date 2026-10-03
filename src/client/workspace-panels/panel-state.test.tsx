// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { terminalProducerIdSchema } from "../../shared/index.js";
import {
  COMPANION_LAYOUT_STORAGE_KEY,
  PANEL_SIZE_STORAGE_KEY,
  PanelLayoutStore,
  TASKS_STATE_STORAGE_KEY,
  WORKSPACE_FILES_STATE_STORAGE_KEY,
  WORKPADS_STATE_STORAGE_KEY,
  panelCollapsedStorageKey,
  usePanelLayout,
} from "./panel-state.js";
import {
  defaultPanelLayout,
  findStackForPanel,
  openPanel as openLayoutPanel,
  panelDockEdge,
  panelLayoutStorageKey,
  serializePanelLayout,
  type PanelLayoutTree,
  type LayoutNode,
  type SplitNode,
} from "./layout-tree.js";
import { projectPanelLayout } from "./layout-presentation.js";
import { splitSizes } from "./panel-sizes.js";
import {
  WorkspacePanelTenantRegistry,
  type WorkspacePanelTenant,
} from "./registry.js";

function filesTenant(): WorkspacePanelTenant {
  return {
    id: "workspace-files",
    title: "Files",
    icon: () => null,
    scope: "workspace",
    size: {
      minWidth: 280,
      minHeight: 160,
      preferredWidth: 360,
      preferredHeight: 240,
    },
    preferredPlacement: { edge: "right" },
    availability: () => ({ available: true }),
    render: () => null,
  };
}

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    },
  };
}

function createStore(
  storage = memoryStorage().storage,
  threadId: string | null = "thread-1",
) {
  let sequence = 0;
  let producerSequence = 0;
  return new PanelLayoutStore(
    new WorkspacePanelTenantRegistry([
      filesTenant(),
      { ...filesTenant(), id: "workpads", title: "Workpads", scope: "global" },
      {
        ...filesTenant(),
        id: "tasks",
        title: "Tasks",
        scope: "thread",
        header: "tenant",
        size: {
          minWidth: 300,
          minHeight: 240,
          preferredWidth: 380,
          preferredHeight: 480,
          preferredShare: 0.35,
        },
      },
    ]),
    {
      ...(threadId === null ? {} : { threadId }),
      storage,
      createId: (kind) => `${kind}-${++sequence}`,
      createProducerId: () =>
        `00000000-0000-4000-8000-${String(++producerSequence).padStart(12, "0")}`,
    },
  );
}

describe("PanelLayoutStore panel instances", () => {
  it("persists Workpads alongside Chat and Files with docking, collapse, and restore", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    expect(store.openPanel("workspace-files", { presentation: "split" })).toBe(true);
    expect(store.openPanel("workpads", { presentation: "split" })).toBe(true);
    expect(store.openPanel("workpads", { presentation: "split" })).toBe(true);
    expect(store.panels().map(panel => panel.kind)).toEqual(["chat", "files", "workpads"]);
    expect(store.dockPanel("workpads", "bottom")).toBe(true);
    expect(store.collapsePanel("workpads")).toBe(true);
    const restored = createStore(storage);
    expect(restored.isCollapsed("workpads")).toBe(true);
    expect(restored.restorePanel("workpads", { presentation: "split" })).toBe(true);
    expect(restored.isVisible("workpads")).toBe(true);
    expect(restored.getSnapshot().tree?.kind).toBe("split");
    expect(restored.closePanel("workpads")).toBe(true);
    expect(restored.hasPanel("workspace-files")).toBe(true);
    expect(restored.hasPanel("chat")).toBe(true);
  });

  it("keeps Workpads open and collapsed state across new and cached thread layouts", () => {
    const { storage } = memoryStorage();
    const root = createStore(storage);
    root.openPanel("workpads");
    const second = root.forThread("another-project-thread");
    expect(second.hasPanel("workpads")).toBe(true);
    second.collapsePanel("workpads");
    expect(root.forThread("thread-1").isCollapsed("workpads")).toBe(true);
    root.activatePanel("workpads");
    expect(root.forThread("another-project-thread").isCollapsed("workpads")).toBe(false);
    second.closePanel("workpads");
    expect(root.forThread("thread-1").hasPanel("workpads")).toBe(false);
    expect(root.forThread("never-visited").hasPanel("workpads")).toBe(false);
    expect(createStore(storage).hasPanel("workpads")).toBe(false);
  });

  it("does not resurrect closed Workpads from a previous thread layout after reload", () => {
    const { storage, values } = memoryStorage();
    const root = createStore(storage);
    root.openPanel("workpads");
    root.collapsePanel("workpads");
    const reopened = createStore(storage).forThread("thread-2");
    expect(reopened.isCollapsed("workpads")).toBe(true);
    reopened.closePanel("workpads");
    expect(values.get(panelLayoutStorageKey("thread-1"))).toContain("workpads");
    expect(createStore(storage).hasPanel("workpads")).toBe(false);
    expect(JSON.parse(values.get(WORKPADS_STATE_STORAGE_KEY)!)).toEqual({ version: 1, open: false, collapsed: false });
  });

  it("shares restore-all and reset Workpads state across threads", () => {
    const root = createStore();
    root.openPanel("workpads");
    root.collapsePanel("workpads");
    const second = root.forThread("thread-2");
    second.restoreAllPanels();
    expect(root.forThread("thread-1").isCollapsed("workpads")).toBe(false);
    root.resetLayout();
    expect(root.forThread("thread-2").hasPanel("workpads")).toBe(false);
  });

  it("opens Tasks at its share of the stage, between its minimum and preferred width", () => {
    const opened = (availableWidth: number) => {
      const store = createStore();
      store.openPanel("tasks", { availableWidth, presentation: "split" });
      return (store.getSnapshot().tree as SplitNode).sizes[1]! * availableWidth;
    };
    // 1024px window: 35% of the stage would be 267px; the minimum holds.
    expect(opened(764)).toBeCloseTo(300);
    expect(opened(1_000)).toBeCloseTo(350);
    // 1440px window: 35% would be 413px; the preferred width caps it.
    expect(opened(1_180)).toBeCloseTo(380);
  });

  it("docks Tasks right of Chat at its preferred share and restores it after reload", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    expect(
      store.openPanel("tasks", { availableWidth: 1_000, presentation: "split" }),
    ).toBe(true);
    const tree = store.getSnapshot().tree as SplitNode;
    expect(store.panels().map((panel) => panel.kind)).toEqual(["chat", "tasks"]);
    expect(panelDockEdge(tree, "tasks")).toBe("right");
    expect(tree.sizes[1]).toBeCloseTo(0.35);
    // A second open reveals the singleton rather than adding another.
    expect(store.openPanel("tasks", { presentation: "split" })).toBe(true);
    expect(store.panels().filter((panel) => panel.kind === "tasks")).toHaveLength(1);

    store.resizeSplit(tree.id, [0.7, 0.3]);
    store.collapsePanel("tasks");
    const reloaded = createStore(storage);
    expect(reloaded.isCollapsed("tasks")).toBe(true);
    expect((reloaded.getSnapshot().tree as SplitNode).sizes).toEqual([0.7, 0.3]);
    expect(JSON.parse(values.get(TASKS_STATE_STORAGE_KEY)!)).toEqual({
      version: 1,
      open: true,
      collapsed: true,
    });
    reloaded.closePanel("tasks");
    expect(JSON.parse(values.get(PANEL_SIZE_STORAGE_KEY)!).sizes.tasks).toEqual({
      width: 0.3,
    });
    const reopened = createStore(storage);
    expect(reopened.hasPanel("tasks")).toBe(false);
    reopened.openPanel("tasks", { availableWidth: 1_000 });
    expect((reopened.getSnapshot().tree as SplitNode).sizes[1]).toBeCloseTo(0.3);
  });

  it("keeps Tasks docked across thread layouts so it follows the current chat", () => {
    const { storage } = memoryStorage();
    const root = createStore(storage);
    root.openPanel("tasks");
    const second = root.forThread("thread-2");
    expect(second.hasPanel("tasks")).toBe(true);
    expect(panelDockEdge(second.getSnapshot().tree, "tasks")).toBe("right");
    second.collapsePanel("tasks");
    expect(root.forThread("thread-1").isCollapsed("tasks")).toBe(true);
    root.restorePanel("tasks");
    expect(root.forThread("thread-2").isVisible("tasks")).toBe(true);
    // Placement is shared too: docking in one layout docks it in every one.
    second.dockPanel("tasks", "left");
    expect(panelDockEdge(root.forThread("thread-1").getSnapshot().tree, "tasks")).toBe("left");
    second.closePanel("tasks");
    expect(root.forThread("thread-1").hasPanel("tasks")).toBe(false);
    expect(root.forThread("never-visited").hasPanel("tasks")).toBe(false);
    // Workpads keeps its own shared state beside Tasks.
    root.openPanel("workpads");
    root.openPanel("tasks");
    root.closePanel("workpads");
    expect(root.forThread("thread-2").hasPanel("tasks")).toBe(true);
    expect(root.forThread("thread-2").hasPanel("workpads")).toBe(false);
    root.resetLayout();
    expect(root.forThread("thread-2").hasPanel("tasks")).toBe(false);
  });

  it("projects a single panel without changing the canonical layout", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    store.openPanel("workspace-files", {
      focus: false,
      presentation: "single",
    });
    expect(store.getSnapshot().soloPanelInstanceId).toBe("workspace-files");
    expect(store.isVisible("workspace-files")).toBe(true);
    expect(store.isVisible("chat")).toBe(false);
    expect(
      store.panels().map(({ panelInstanceId }) => panelInstanceId),
    ).toEqual(["chat", "workspace-files"]);

    store.activatePanel("chat", { focus: false });
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");
    store.activatePanel("workspace-files", {
      focus: false,
      presentation: "split",
    });
    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(store.isVisible("chat")).toBe(true);
    expect(store.isVisible("workspace-files")).toBe(true);

    const persisted = values.get(panelLayoutStorageKey("thread-1"));
    expect(persisted).not.toContain("soloPanelInstanceId");
    expect(
      createStore(storage).getSnapshot().soloPanelInstanceId,
    ).toBeUndefined();
  });

  it("moves a collapsed or closed solo view to a deterministic survivor", () => {
    const store = createStore();
    store.openPanel("workspace-files", { focus: false, mode: "tab" });
    store.activatePanel("workspace-files", {
      focus: false,
      presentation: "single",
    });
    expect(store.collapsePanel("workspace-files")).toBe(true);
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");

    store.restorePanel("workspace-files", {
      focus: false,
      presentation: "single",
    });
    expect(store.closePanel("workspace-files")).toBe(true);
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");
    store.resetLayout();
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");
  });

  it("keeps Chat, Files, and the terminal container singleton", () => {
    const store = createStore();
    expect(store.hasPanel("chat")).toBe(true);
    expect(store.openPanel("workspace-files", { focus: false })).toBe(true);
    expect(store.openPanel("workspace-files", { focus: false })).toBe(true);
    expect(store.openTerminalTab("terminal-1", { focus: false })).toBe(
      "terminals",
    );
    const producerId = store.terminalTab("terminal-1")?.producerId;
    expect(store.openTerminalTab("terminal-1", { focus: false })).toBe(
      "terminals",
    );
    expect(store.terminalPanel()?.tabs).toHaveLength(1);
    expect(store.terminalTab("terminal-1")?.producerId).toBe(producerId);
    expect(store.hasPanelKind("chat")).toBe(true);
    expect(store.hasPanelKind("files")).toBe(true);
    expect(store.hasPanelKind("terminals")).toBe(true);
    expect(terminalProducerIdSchema.safeParse(producerId).success).toBe(true);
  });

  it("adds nested tabs and switches the active terminal in one bottom split", () => {
    const store = createStore();
    store.openTerminalTab("terminal-1", { focus: false });
    const split = store.getSnapshot().tree as SplitNode;
    expect(split.orientation).toBe("column");
    store.openTerminalTab("terminal-2", { focus: false });
    expect(store.panels().filter(({ kind }) => kind === "terminals")).toHaveLength(1);
    expect(store.terminalPanel()).toMatchObject({
      panelInstanceId: "terminals",
      activeTerminalId: "terminal-2",
      tabs: [{ terminalId: "terminal-1" }, { terminalId: "terminal-2" }],
    });
    expect(store.activateTerminalTab("terminal-1", { focus: false })).toBe(true);
    expect(store.terminalPanel()?.activeTerminalId).toBe("terminal-1");
    expect(store.isVisible("terminals")).toBe(true);
  });

  it("closes nested tabs locally and retains the empty container after the last tab", () => {
    const store = createStore();
    store.openTerminalTab("one", { focus: false });
    store.openTerminalTab("two", { focus: false });
    store.openTerminalTab("three", { focus: false });
    expect(store.closeTerminalTab("three")).toBe(true);
    expect(store.terminalPanel()?.activeTerminalId).toBe("two");
    expect(store.getSnapshot().focusRequest).toMatchObject({
      panelInstanceId: "terminals",
      terminalId: "two",
    });
    expect(store.closeTerminalTab("one")).toBe(true);
    expect(store.terminalPanel()?.tabs.map(({ terminalId }) => terminalId)).toEqual(["two"]);
    expect(store.closeTerminalTab("two")).toBe(true);
    expect(store.terminalPanel()).toMatchObject({ tabs: [], activeTerminalId: null });
    expect(store.isVisible("terminals")).toBe(true);
  });

  it("persists an empty terminal panel and activates a new tab in place", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    store.openTerminalTab("one", { focus: false });
    store.closeTerminalTab("one");
    const restored = createStore(storage);
    expect(restored.terminalPanel()).toMatchObject({ tabs: [], activeTerminalId: null });
    expect(restored.openTerminalTab("two", { focus: false })).toBe("terminals");
    expect(restored.terminalPanel()).toMatchObject({ activeTerminalId: "two", tabs: [{ terminalId: "two" }] });
  });

  it("caps nested tabs while allowing an existing tab to be reopened", () => {
    const store = createStore();
    for (let index = 0; index < 24; index += 1) {
      expect(
        store.openTerminalTab(`terminal-${index}`, { focus: false }),
      ).toBe("terminals");
    }
    expect(store.terminalPanel()?.tabs).toHaveLength(24);
    expect(store.openTerminalTab("overflow", { focus: false })).toBeUndefined();
    expect(store.openTerminalTab("terminal-0", { focus: false })).toBe(
      "terminals",
    );
    expect(store.terminalPanel()?.tabs).toHaveLength(24);
    expect(store.terminalPanel()?.activeTerminalId).toBe("terminal-0");
  });

  it("persists collapse by instance without changing canonical topology", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    const terminalPanel = store.openTerminalTab("terminal", {
      focus: false,
    })!;
    const tree = store.getSnapshot().tree;
    expect(store.collapsePanel(terminalPanel)).toBe(true);
    expect(store.getSnapshot().tree).toBe(tree);
    expect(
      JSON.parse(values.get(panelCollapsedStorageKey("thread-1"))!),
    ).toEqual({
      version: 4,
      collapsed: [terminalPanel],
    });
    expect(store.restorePanel(terminalPanel, { focus: false })).toBe(true);
    expect(store.isVisible(terminalPanel)).toBe(true);
  });

  it("issues instance-scoped focus requests and one-shot intents", () => {
    const store = createStore();
    const panel = store.openTerminalTab("terminal", {
      intent: { sequence: 7, private: true },
    })!;
    expect(store.getSnapshot().focusRequest).toEqual({
      panelInstanceId: panel,
      terminalId: "terminal",
      sequence: 1,
    });
    expect(store.intent(panel)).toEqual({ sequence: 7, private: true });
    store.consumeIntent(panel, 6);
    expect(store.intent(panel)).toBeDefined();
    store.consumeIntent(panel, 7);
    expect(store.intent(panel)).toBeUndefined();
    store.consumeFocusRequest(1);
    expect(store.getSnapshot().focusRequest).toBeUndefined();
  });

  it("publishes stable external-store snapshots", () => {
    const store = createStore();
    const { result } = renderHook(() => usePanelLayout(store));
    const initial = result.current;
    act(() => {
      expect(store.collapsePanel("missing")).toBe(false);
    });
    expect(result.current).toBe(initial);
    act(() => {
      store.openTerminalTab("terminal", { focus: false });
    });
    expect(result.current.revision).toBe(1);
  });
});

describe("PanelLayoutStore v4 persistence", () => {
  it("resets to the persisted default layout and clears collapsed panels", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    store.openPanel("workspace-files", { focus: false });
    const terminal = store.openTerminalTab("terminal", { focus: false })!;
    store.collapsePanel("chat");
    store.collapsePanel(terminal);

    store.resetLayout();

    expect(store.panels().map(({ kind }) => kind)).toEqual(["chat"]);
    expect(store.getSnapshot().collapsed.size).toBe(0);
    expect(store.getSnapshot().focusRequest?.panelInstanceId).toBe("chat");
    expect(
      JSON.parse(values.get(panelLayoutStorageKey("thread-1"))!),
    ).toMatchObject({
      version: 4,
      threadId: "thread-1",
      tree: { kind: "tabs", tabs: [{ kind: "chat" }] },
    });
    expect(
      JSON.parse(values.get(panelCollapsedStorageKey("thread-1"))!),
    ).toEqual({
      version: 4,
      collapsed: [],
    });
    expect(
      createStore(storage)
        .panels()
        .map(({ kind }) => kind),
    ).toEqual(["chat"]);
  });

  it("restores recursive layout and terminal references without ephemeral intent/focus", () => {
    const { storage } = memoryStorage();
    const first = createStore(storage);
    first.openPanel("workspace-files", { focus: false });
    const terminal = first.openTerminalTab("terminal", {
      intent: { sequence: 1 },
    })!;
    first.collapsePanel(terminal);
    const restored = createStore(storage);
    expect(restored.terminalPanel()?.tabs).toEqual([
      expect.objectContaining({ terminalId: "terminal" }),
    ]);
    expect(restored.terminalPanel()?.activeTerminalId).toBe("terminal");
    expect(restored.isCollapsed(terminal)).toBe(true);
    expect(restored.intent(terminal)).toBeUndefined();
    expect(restored.getSnapshot().focusRequest).toBeUndefined();
  });

  it("does not read legacy singleton keys or shapes", () => {
    const { storage } = memoryStorage({
      "sedes-singleton-panel-layout@1": JSON.stringify({
        version: 1,
        tree: { kind: "panel", panelId: "workspace-files" },
      }),
      "sedes-singleton-panel-sizes@1": "legacy",
      "sedes-singleton-panel-collapsed@1": "legacy",
    });
    const store = createStore(storage);
    expect(store.panels().map((panel) => panel.kind)).toEqual(["chat"]);
    expect(storage.getItem.mock.calls.map(([key]) => key)).toEqual([
      WORKSPACE_FILES_STATE_STORAGE_KEY,
      WORKPADS_STATE_STORAGE_KEY,
      TASKS_STATE_STORAGE_KEY,
      PANEL_SIZE_STORAGE_KEY,
      COMPANION_LAYOUT_STORAGE_KEY,
      panelLayoutStorageKey("thread-1"),
      panelCollapsedStorageKey("thread-1"),
    ]);
  });

  it("remembers a resized side panel's share of the stage", () => {
    const { storage, values } = memoryStorage();
    const first = createStore(storage);
    first.openPanel("workspace-files", { availableWidth: 1_200, focus: false });
    const root = first.getSnapshot().tree as SplitNode;
    first.resizeSplit(root.id, [0.55, 0.45]);
    first.closePanel("workspace-files");
    expect(JSON.parse(values.get(PANEL_SIZE_STORAGE_KEY)!)).toEqual({
      version: 5,
      sizes: { files: { width: 0.45 } },
    });
  });

  it("fails soft when storage is denied", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new DOMException("denied", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("quota", "QuotaExceededError");
      }),
    };
    const store = createStore(storage);
    expect(() => store.openPanel("workspace-files")).not.toThrow();
    expect(store.hasPanel("workspace-files")).toBe(true);
  });
});

/** A panel's share of the rendered stage width or height. */
function stageShare(
  store: PanelLayoutStore,
  panelInstanceId: string,
  axis: "width" | "height" = "width",
): number | undefined {
  const { tree, collapsed } = store.getSnapshot();
  const visit = (node: LayoutNode, share: number): number | undefined => {
    if (node.kind === "tabs")
      return node.tabs.some((tab) => tab.panelInstanceId === panelInstanceId)
        ? share
        : undefined;
    const along = (node.orientation === "row") === (axis === "width");
    return (
      visit(node.children[0], along ? share * node.sizes[0] : share) ??
      visit(node.children[1], along ? share * node.sizes[1] : share)
    );
  };
  const projected = projectPanelLayout(tree, collapsed);
  return projected ? visit(projected, 1) : undefined;
}

/** The split holding a panel's own stack, and which side it is on. */
function parentSplit(
  store: PanelLayoutStore,
  panelInstanceId: string,
): { readonly split: SplitNode; readonly index: 0 | 1 } {
  const visit = (
    node: LayoutNode,
  ): { readonly split: SplitNode; readonly index: 0 | 1 } | undefined => {
    if (node.kind === "tabs") return undefined;
    for (const index of [0, 1] as const) {
      const child = node.children[index];
      if (
        child.kind === "tabs" &&
        child.tabs.some((tab) => tab.panelInstanceId === panelInstanceId)
      )
        return { split: node, index };
    }
    return visit(node.children[0]) ?? visit(node.children[1]);
  };
  const tree = store.getSnapshot().tree;
  const found = tree ? visit(tree) : undefined;
  if (!found) throw new Error(`${panelInstanceId} has no parent split`);
  return found;
}

function resizePanel(
  store: PanelLayoutStore,
  panelInstanceId: string,
  fraction: number,
): void {
  const { split, index } = parentSplit(store, panelInstanceId);
  store.resizeSplit(
    split.id,
    index === 0 ? [fraction, 1 - fraction] : [1 - fraction, fraction],
  );
}

describe("PanelLayoutStore shared panel sizes", () => {
  it("shows a resized Tasks panel at the same width in every thread and after reload", () => {
    const { storage, values } = memoryStorage();
    const root = createStore(storage);
    root.openPanel("tasks", { availableWidth: 1_000 });
    const cached = root.forThread("thread-2");
    expect(stageShare(cached, "tasks")).toBeCloseTo(0.35);

    resizePanel(root, "tasks", 0.4);
    expect(stageShare(root.forThread("thread-2"), "tasks")).toBeCloseTo(0.4);
    expect(stageShare(root.forThread("never-visited"), "tasks")).toBeCloseTo(0.4);
    expect(
      stageShare(createStore(storage).forThread("thread-3"), "tasks"),
    ).toBeCloseTo(0.4);
    expect(JSON.parse(values.get(PANEL_SIZE_STORAGE_KEY)!)).toEqual({
      version: 5,
      sizes: { tasks: { width: 0.4 } },
    });
  });

  it("keeps side panel widths in every thread's layout", () => {
    const root = createStore();
    root.openPanel("workspace-files", { availableWidth: 1_400 });
    root.openPanel("tasks", { availableWidth: 1_400 });
    const files = 360 / 1_400;
    const tasks = 380 / 1_400;
    expect(stageShare(root, "workspace-files")).toBeCloseTo(files);
    expect(stageShare(root, "tasks")).toBeCloseTo(tasks);

    const second = root.forThread("thread-2");
    expect(stageShare(second, "workspace-files")).toBeCloseTo(files);
    expect(stageShare(second, "tasks")).toBeCloseTo(tasks);

    // Tasks is the outer column, so its divider takes it straight to 40%.
    resizePanel(second, "tasks", 0.4);
    expect(stageShare(second, "tasks")).toBeCloseTo(0.4);
    expect(stageShare(second, "workspace-files")).toBeCloseTo(files);
    const first = root.forThread("thread-1");
    expect(stageShare(first, "tasks")).toBeCloseTo(0.4);
    expect(stageShare(first, "workspace-files")).toBeCloseTo(files);
  });

  it("lets Chat take up a resize while other side panels keep their width", () => {
    const store = createStore();
    // Tasks opens last, so its divider is the outer split around Chat and Files.
    store.openPanel("workspace-files", { availableWidth: 1_400 });
    store.openPanel("tasks", { availableWidth: 1_400 });
    const files = 360 / 1_400;
    const { split } = parentSplit(store, "tasks");
    const preview = store.previewSplitResize(split.id, [0.6, 0.4]);

    resizePanel(store, "tasks", 0.4);
    expect(stageShare(store, "tasks")).toBeCloseTo(0.4);
    expect(stageShare(store, "workspace-files")).toBeCloseTo(files);
    expect(preview).toEqual(splitSizes(store.getSnapshot().tree));
  });

  it("remembers sizes only from panels the user opens, docks, or resizes", () => {
    const { storage, values } = memoryStorage();
    const legacy = createStore(storage);
    legacy.openPanel("tasks");
    resizePanel(legacy, "tasks", 0.45);
    // A layout saved before sizes were shared has no shared size yet.
    values.delete(PANEL_SIZE_STORAGE_KEY);

    // The app's unscoped root store reopens Tasks at the default size.
    const root = createStore(storage, null);
    expect(stageShare(root, "tasks")).toBeCloseTo(0.3);
    expect(values.has(PANEL_SIZE_STORAGE_KEY)).toBe(false);
    expect(stageShare(root.forThread("thread-1"), "tasks")).toBeCloseTo(0.45);
  });

  it("keeps a panel's width when a neighbouring panel collapses, restores, or closes", () => {
    const store = createStore();
    store.openPanel("workspace-files", { availableWidth: 1_400 });
    store.openPanel("tasks", { availableWidth: 1_400 });
    const files = 360 / 1_400;

    store.collapsePanel("tasks");
    expect(stageShare(store, "workspace-files")).toBeCloseTo(files);
    store.restorePanel("tasks");
    expect(stageShare(store, "workspace-files")).toBeCloseTo(files);
    store.closePanel("tasks");
    expect(stageShare(store, "workspace-files")).toBeCloseTo(files);
  });

  it("shares the Terminals height across thread layouts", () => {
    const root = createStore();
    root.openTerminalTab("terminal-1");
    resizePanel(root, "terminals", 0.45);
    const second = root.forThread("thread-2");
    second.openTerminalTab("terminal-2");
    expect(stageShare(second, "terminals", "height")).toBeCloseTo(0.45);
  });

  it("keeps a column of side panels at its thread-local width through collapse and restore", () => {
    const store = createStore();
    store.openPanel("workspace-files", { availableWidth: 1_400 });
    const filesStack = parentSplit(store, "workspace-files").split.children[1];
    store.openTerminalTab("terminal-1", { edge: "bottom", targetNodeId: filesStack.id });
    const root = store.getSnapshot().tree as SplitNode;
    const column = root.children[1] as SplitNode;
    expect(column.orientation).toBe("column");
    expect(parentSplit(store, "workspace-files").split).toBe(column);
    store.resizeSplit(root.id, [0.4, 0.6]);

    // Collapsed Terminals leaves Files alone on the right, standing in for
    // the column, and Files' own shared width must not resize the column.
    store.collapsePanel("terminals");
    expect((store.getSnapshot().tree as SplitNode).sizes[1]).toBeCloseTo(0.6);
    store.restorePanel("terminals");
    expect((store.getSnapshot().tree as SplitNode).sizes[1]).toBeCloseTo(0.6);
  });

  it("leaves tabbed side panels at their thread-local size", () => {
    const { storage, values } = memoryStorage();
    const root = createStore(storage);
    root.openPanel("workspace-files", { availableWidth: 1_400 });
    const filesStack = parentSplit(root, "workspace-files").split.children[1];
    root.openTerminalTab("terminal-1", { mode: "tab", targetNodeId: filesStack.id });
    const remembered = values.get(PANEL_SIZE_STORAGE_KEY);

    resizePanel(root, "workspace-files", 0.5);
    expect(values.get(PANEL_SIZE_STORAGE_KEY)).toBe(remembered);
    const reopened = root.forThread("thread-2").forThread("thread-1");
    expect(stageShare(reopened, "workspace-files")).toBeCloseTo(0.5);
  });
});

/** Panel instance IDs left to right across the rendered row splits. */
function rowOrder(store: PanelLayoutStore): string[] {
  const visit = (node: LayoutNode): string[] =>
    node.kind === "tabs"
      ? [node.activePanelInstanceId]
      : node.orientation === "row"
        ? [...visit(node.children[0]), ...visit(node.children[1])]
        : visit(node.children[0]);
  const tree = store.getSnapshot().tree;
  return tree ? visit(tree) : [];
}

describe("PanelLayoutStore shared Tasks and Workpads arrangement", () => {
  it("shows Tasks and Workpads in the same order in every thread", () => {
    const { storage } = memoryStorage();
    const root = createStore(storage);
    // Opened Tasks first, then Workpads: Workpads is the outer column.
    root.openPanel("tasks");
    root.openPanel("workpads");
    expect(rowOrder(root)).toEqual(["chat", "tasks", "workpads"]);
    // A new layout adds them in its own order, then takes the shared one.
    expect(rowOrder(root.forThread("thread-2"))).toEqual(["chat", "tasks", "workpads"]);
    expect(rowOrder(createStore(storage).forThread("thread-3"))).toEqual([
      "chat",
      "tasks",
      "workpads",
    ]);
  });

  it("takes the arrangement last set up in any thread", () => {
    const root = createStore();
    root.openPanel("tasks");
    root.openPanel("workpads");
    const second = root.forThread("thread-2");
    second.dockPanel("tasks", "left");
    expect(rowOrder(second)).toEqual(["tasks", "chat", "workpads"]);
    expect(rowOrder(root.forThread("thread-1"))).toEqual(["tasks", "chat", "workpads"]);
    // Closing and reopening puts the panel outermost on its edge.
    root.closePanel("workpads");
    root.openPanel("workpads", { edge: "left" });
    expect(rowOrder(root)).toEqual(["workpads", "tasks", "chat"]);
    expect(rowOrder(root.forThread("thread-2"))).toEqual(["workpads", "tasks", "chat"]);
  });

  it("docks within a layout of only Tasks and Workpads and keeps it steady", () => {
    const root = createStore();
    root.openPanel("tasks");
    root.openPanel("workpads");
    root.closePanel("chat");
    root.dockPanel("tasks", "right");
    expect(rowOrder(root)).toEqual(["workpads", "tasks"]);
    const steady = root.getSnapshot().tree;
    expect(root.forThread("thread-1").getSnapshot().tree).toBe(steady);
    // Chat returns inside them, and Workpads keeps its own edge.
    root.openPanel("chat");
    expect(rowOrder(root)).toEqual(["chat", "workpads", "tasks"]);
  });

  it("does not republish a layout of only Tasks or Workpads on a thread switch", () => {
    const root = createStore();
    root.openPanel("tasks");
    root.closePanel("chat");
    const alone = root.getSnapshot();
    expect(root.forThread("thread-1").getSnapshot()).toBe(alone);
    root.openPanel("workpads");
    const pair = root.getSnapshot();
    expect(root.forThread("thread-1").getSnapshot()).toBe(pair);
  });

  it("takes the first restored layout's order, even with Files outside it", () => {
    let saved: PanelLayoutTree = defaultPanelLayout;
    let id = 0;
    for (const panel of [
      { panelInstanceId: "tasks", kind: "tasks" },
      { panelInstanceId: "workpads", kind: "workpads" },
      { panelInstanceId: "workspace-files", kind: "files" },
    ] as const)
      saved = openLayoutPanel(saved, panel, {
        edge: "right",
        splitId: `saved-split-${++id}`,
        stackId: `saved-stack-${id}`,
      });
    const open = JSON.stringify({ version: 1, open: true, collapsed: false });
    const { storage } = memoryStorage({
      [panelLayoutStorageKey("thread-1")]: serializePanelLayout("thread-1", saved),
      [TASKS_STATE_STORAGE_KEY]: open,
      [WORKPADS_STATE_STORAGE_KEY]: open,
      [WORKSPACE_FILES_STATE_STORAGE_KEY]: open,
    });
    // The app's unscoped root store records nothing; the first thread does.
    const root = createStore(storage, null);
    const order = ["chat", "workspace-files", "tasks", "workpads"];
    expect(rowOrder(root.forThread("thread-1"))).toEqual(order);
    expect(rowOrder(root.forThread("thread-2"))).toEqual(order);
    expect(rowOrder(root.forThread("thread-1"))).toEqual(order);
  });

  it("opens Files and Terminals inside Tasks and Workpads", () => {
    const root = createStore();
    root.openPanel("tasks");
    root.openPanel("workspace-files");
    root.openTerminalTab("terminal-1");
    expect(rowOrder(root)).toEqual(["chat", "workspace-files", "tasks"]);
    // Tasks keeps the stage's full height; the Terminals sit under the rest.
    const tree = root.getSnapshot().tree as SplitNode;
    expect(panelDockEdge(tree, "tasks")).toBe("right");
    expect(findStackForPanel(tree.children[0], "terminals")).toBeDefined();
  });
});

describe("PanelLayoutStore workspace dirty authority", () => {
  it("tracks workspace dirty state independently", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribeWorkspaceDirty(listener);
    store.setWorkspaceTenantDirty("workspace-1", "workspace-files", true);
    expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(true);
    store.discardWorkspacePanelChanges("workspace-1");
    expect(store.hasAnyDirtyWorkspacePanels()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("PanelLayoutStore thread scopes", () => {
  it("isolates and strictly restores nested terminal tabs by thread", () => {
    const { storage, values } = memoryStorage();
    const root = createStore(storage);
    const first = root.forThread("thread-a");
    const second = root.forThread("thread-b");

    first.openTerminalTab("terminal-a", { focus: false });
    first.openTerminalTab("terminal-b", { focus: false });
    expect(first.terminalPanel()).toMatchObject({
      threadId: "thread-a",
      activeTerminalId: "terminal-b",
      tabs: [{ terminalId: "terminal-a" }, { terminalId: "terminal-b" }],
    });
    expect(second.terminalPanel()).toBeUndefined();
    expect(second.panels().map(({ kind }) => kind)).toEqual(["chat"]);

    first.openPanel("workspace-files", { focus: false });
    expect(values.get(WORKSPACE_FILES_STATE_STORAGE_KEY)).toBe(
      '{"version":1,"open":true,"collapsed":false}',
    );
    expect(second.hasPanel("workspace-files")).toBe(false);
    expect(root.forThread("thread-b").hasPanel("workspace-files")).toBe(true);
    first.collapsePanel("workspace-files");
    expect(root.forThread("thread-b").isCollapsed("workspace-files")).toBe(
      true,
    );
    second.restorePanel("workspace-files", { focus: false });
    expect(first.isCollapsed("workspace-files")).toBe(true);
    expect(root.forThread("thread-a").isCollapsed("workspace-files")).toBe(
      false,
    );
    first.closePanel("workspace-files");
    expect(second.hasPanel("workspace-files")).toBe(true);
    expect(root.forThread("thread-b").hasPanel("workspace-files")).toBe(false);

    first.openPanel("workspace-files", { focus: false });
    first.collapsePanel("workspace-files");
    const reloadedRoot = createStore(storage);
    const reloadedSecond = reloadedRoot.forThread("thread-b");
    expect(reloadedSecond.hasPanel("workspace-files")).toBe(true);
    expect(reloadedSecond.isCollapsed("workspace-files")).toBe(true);

    values.set(
      panelLayoutStorageKey("thread-b"),
      values.get(panelLayoutStorageKey("thread-a"))!,
    );
    const restoredRoot = createStore(storage);
    expect(
      restoredRoot.forThread("thread-a").terminalPanel(),
    ).toMatchObject({
      threadId: "thread-a",
      activeTerminalId: "terminal-b",
      tabs: [{ terminalId: "terminal-a" }, { terminalId: "terminal-b" }],
    });
    expect(restoredRoot.forThread("thread-b").terminalPanel()).toBeUndefined();
  });

  it("aggregates dirty workspace state across thread stores", () => {
    const root = createStore();
    const first = root.forThread("thread-a");
    const second = root.forThread("thread-b");
    const listener = vi.fn();
    root.subscribeWorkspaceDirty(listener);

    first.setWorkspaceTenantDirty("workspace-a", "files", true);
    second.setWorkspaceTenantDirty("workspace-a", "files", true);
    second.setWorkspaceTenantDirty("workspace-b", "files", true);
    expect(root.hasDirtyWorkspacePanels("workspace-a")).toBe(true);
    expect(root.hasDirtyWorkspacePanels("workspace-b")).toBe(true);
    first.setWorkspaceTenantDirty("workspace-a", "files", false);
    expect(root.hasDirtyWorkspacePanels("workspace-a")).toBe(true);
    second.setWorkspaceTenantDirty("workspace-a", "files", false);
    expect(root.hasAnyDirtyWorkspacePanels()).toBe(true);
    second.discardWorkspacePanelChanges("workspace-b");
    expect(root.hasAnyDirtyWorkspacePanels()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
