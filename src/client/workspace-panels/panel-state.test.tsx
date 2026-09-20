// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { terminalProducerIdSchema } from "../../shared/index.js";
import {
  PANEL_SIZE_STORAGE_KEY,
  PanelLayoutStore,
  WORKSPACE_FILES_STATE_STORAGE_KEY,
  WORKPADS_STATE_STORAGE_KEY,
  panelCollapsedStorageKey,
  usePanelLayout,
} from "./panel-state.js";
import { panelLayoutStorageKey, type SplitNode } from "./layout-tree.js";
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

function createStore(storage = memoryStorage().storage) {
  let sequence = 0;
  let producerSequence = 0;
  return new PanelLayoutStore(
    new WorkspacePanelTenantRegistry([filesTenant(), { ...filesTenant(), id: "workpads", title: "Workpads", scope: "global" }]),
    {
      threadId: "thread-1",
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
      panelLayoutStorageKey("thread-1"),
      PANEL_SIZE_STORAGE_KEY,
      panelCollapsedStorageKey("thread-1"),
    ]);
  });

  it("retains panel-kind size after closing a split leaf", () => {
    const { storage, values } = memoryStorage();
    const first = createStore(storage);
    first.openPanel("workspace-files", { availableWidth: 1_200, focus: false });
    const root = first.getSnapshot().tree as SplitNode;
    first.resizeSplit(root.id, [0.55, 0.45]);
    first.closePanel("workspace-files");
    expect(JSON.parse(values.get(PANEL_SIZE_STORAGE_KEY)!)).toEqual({
      version: 4,
      sizes: { files: { fraction: 0.45 } },
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
