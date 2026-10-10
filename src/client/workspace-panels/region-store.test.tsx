// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_PANEL_STORAGE_KEYS,
  PANEL_REGIONS_STORAGE_KEY,
  legacyThreadLayoutStorageKey,
  serializeRegionLayout,
  serializeThreadTerminals,
  threadPanelRegionsStorageKey,
  type RegionStorage,
} from "./region-persistence.js";
import {
  PanelRegionStore,
  installPanelRegionStorageSync,
  usePanelRegions,
} from "./region-store.js";
import { defaultRegionLayout, MAX_TERMINAL_TABS } from "./regions.js";
import { WorkspacePanelTenantRegistry, type WorkspacePanelTenant } from "./registry.js";

function tenant(id: string, minWidth = 320): WorkspacePanelTenant {
  return {
    id,
    title: id,
    icon: () => null,
    scope: "global",
    size: { minWidth, minHeight: 240, preferredWidth: 480, preferredHeight: 480 },
    availability: () => ({ available: true }),
    render: () => null,
  };
}

const ALL_TENANTS = [tenant("workspace-files"), tenant("workpads"), tenant("tasks", 300)];

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    },
  };
}

function createStore(
  storage: RegionStorage = memoryStorage().storage,
  options: { readonly threadId?: string | null; readonly tenants?: WorkspacePanelTenant[] } = {},
) {
  let producer = 0;
  const threadId = options.threadId === undefined ? "thread-1" : options.threadId;
  return new PanelRegionStore(new WorkspacePanelTenantRegistry(options.tenants ?? ALL_TENANTS), {
    ...(threadId === null ? {} : { threadId }),
    storage,
    createProducerId: () =>
      `00000000-0000-4000-8000-${String(++producer).padStart(12, "0")}`,
  });
}

function savedLayout(values: Map<string, string>) {
  return JSON.parse(values.get(PANEL_REGIONS_STORAGE_KEY)!) as Record<string, unknown>;
}

describe("PanelRegionStore layout", () => {
  it("opens in place, replaces the region's panel and persists the device layout", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    expect(store.getSnapshot().visible).toEqual(["chat"]);
    expect(store.open("workpads")).toBe(true);
    expect(store.open("tasks")).toBe(true);
    expect(store.getSnapshot().visible).toEqual(["chat", "tasks"]);
    expect(store.getSnapshot().loaded).toEqual(["chat", "workpads", "tasks"]);
    expect(store.isLoaded("workpads")).toBe(true);
    expect(store.hasPanel("workpads")).toBe(true);
    expect(store.isShown("workpads")).toBe(false);
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.regionPanel("right")).toBe("tasks");
    expect(savedLayout(values)).toMatchObject({
      shown: { right: "tasks" },
      loaded: ["workpads", "tasks"],
    });
    const reloaded = createStore(storage);
    expect(reloaded.getSnapshot().visible).toEqual(["chat", "tasks"]);
    expect(reloaded.isLoaded("workpads")).toBe(true);
  });

  it("toggles, closes, moves and extends", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    expect(store.toggle("files")).toBe(true);
    expect(store.isVisible("files")).toBe(true);
    expect(store.toggle("files")).toBe(true);
    expect(store.isLoaded("files")).toBe(true);
    expect(store.isVisible("files")).toBe(false);
    expect(store.move("files", "left")).toBe(true);
    expect(store.move("files", "left")).toBe(false);
    expect(store.placementOf("files")).toBe("left");
    expect(store.isVisible("files")).toBe(true);
    expect(store.close("files")).toBe(true);
    expect(store.close("files")).toBe(false);
    expect(store.isLoaded("files")).toBe(false);
    expect(store.regionPanel("left")).toBeNull();
    expect(store.close("chat")).toBe(true);
    expect(store.isLoaded("chat")).toBe(true);
    expect(store.getSnapshot().visible).toEqual([]);
    expect(store.isExtended("bottom")).toBe(false);
    expect(store.setExtend("bottom", true)).toBe(true);
    expect(store.setExtend("bottom", true)).toBe(false);
    expect(store.isExtended("bottom")).toBe(true);
    expect(store.isExtended("left")).toBe(false);
    expect(savedLayout(values)).toMatchObject({
      placement: { files: "left" },
      shown: { middle: null, left: null },
      loaded: [],
      extendOrder: ["bottom", "left", "right", "top"],
    });
  });

  it("maximizes and restores without saving", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    store.open("files");
    const saved = values.get(PANEL_REGIONS_STORAGE_KEY);
    expect(store.maximize("tasks")).toBe(false);
    expect(store.maximize("files")).toBe(true);
    expect(store.maximize("files")).toBe(false);
    expect(store.maximized()).toBe("files");
    expect(store.getSnapshot().visible).toEqual(["files"]);
    expect(values.get(PANEL_REGIONS_STORAGE_KEY)).toBe(saved);
    expect(createStore(storage).maximized()).toBeNull();
    expect(store.restore()).toBe(true);
    expect(store.restore()).toBe(false);
    expect(store.getSnapshot().visible).toEqual(["chat", "files"]);
    store.maximize("files");
    store.open("chat");
    expect(store.maximized()).toBeNull();
  });

  it("remembers sizes, clamped, and previews a drag", () => {
    const { storage, values } = memoryStorage();
    const store = createStore(storage);
    store.open("files");
    expect(store.resize("files", "width", 0.25)).toBe(true);
    expect(store.resize("files", "width", 0.25)).toBe(false);
    expect(store.resize("files", "height", 3)).toBe(true);
    expect(savedLayout(values).sizes).toEqual({ files: { width: 0.25, height: 0.95 } });
    expect(store.previewResize("files", "width", 0.5)).toBeUndefined();
    store.setStageSize({ width: 1600, height: 1000 });
    expect(store.getSnapshot().geometry?.panels[0]).toMatchObject({
      kind: "files",
      box: { width: 400 },
    });
    expect(store.previewResize("files", "width", 0.5)?.panels[0]).toMatchObject({
      box: { width: 800 },
    });
    // A preview does not change the layout.
    expect(store.getSnapshot().view.layout.sizes.files?.width).toBe(0.25);
  });

  it("resets to Chat alone, keeping sizes and other threads' Terminals", () => {
    const { storage } = memoryStorage();
    const root = createStore(storage, { threadId: null });
    const one = root.forThread("thread-1");
    const two = root.forThread("thread-2");
    one.openTerminalTab("terminal-1");
    two.openTerminalTab("terminal-2");
    one.open("files", { intent: { sequence: 1 } });
    one.move("chat", "left");
    one.resize("files", "width", 0.3);
    one.setExtend("top", true);
    one.maximize("files");
    one.resetLayout();
    expect(one.getSnapshot().visible).toEqual(["chat"]);
    expect(one.getSnapshot().loaded).toEqual(["chat"]);
    expect(one.terminalPanel()).toBeUndefined();
    expect(one.intent("files")).toBeUndefined();
    expect(one.getSnapshot().focusRequest).toMatchObject({ kind: "chat" });
    expect(one.getSnapshot().view.layout).toEqual({
      ...defaultRegionLayout(),
      sizes: { files: { width: 0.3 } },
    });
    expect(two.terminalPanel()?.tabs).toHaveLength(1);
    expect(two.isVisible("terminals")).toBe(true);
  });

  it("returns a stable snapshot until something changes", () => {
    const store = createStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.open("chat", { focus: false });
    // Opening Chat again changes nothing but its recency.
    const second = store.getSnapshot();
    store.open("chat", { focus: false });
    expect(store.getSnapshot()).toBe(second);
    store.open("files");
    expect(store.getSnapshot()).not.toBe(second);
    expect(store.getSnapshot().revision).toBeGreaterThan(second.revision);
  });

  it("rejects unknown kinds and regions", () => {
    const store = createStore();
    expect(store.open("notes" as never)).toBe(false);
    expect(store.open("files", { region: "center" as never })).toBe(false);
    expect(store.move("files", "center" as never)).toBe(false);
    expect(store.setExtend("middle" as never, true)).toBe(false);
    expect(store.resize("files", "depth" as never, 0.3)).toBe(false);
    expect(store.close("notes" as never)).toBe(false);
    expect(store.maximize("notes" as never)).toBe(false);
  });
});

describe("PanelRegionStore threads", () => {
  it("shares the device layout across threads and keeps Terminals per thread", () => {
    const { storage, values } = memoryStorage();
    const root = createStore(storage, { threadId: null });
    const one = root.forThread("thread-1");
    const two = root.forThread("thread-2");
    expect(root.forThread("thread-1")).toBe(one);
    const listener = vi.fn();
    two.subscribe(listener);
    one.open("tasks");
    expect(listener).toHaveBeenCalled();
    expect(two.isVisible("tasks")).toBe(true);
    expect(one.openTerminalTab("terminal-1")).toBe(true);
    expect(one.isVisible("terminals")).toBe(true);
    // The Bottom picks Terminals, but thread 2 has none: its Bottom is empty.
    expect(two.isLoaded("terminals")).toBe(false);
    expect(two.regionPanel("bottom")).toBeNull();
    expect(one.terminalPanel()).toBe(one.terminalPanel());
    two.open("files");
    const panel = one.terminalPanel();
    expect(one.getSnapshot().terminals).toBe(panel);
    expect(one.terminalPanel()).toEqual({
      threadId: "thread-1",
      tabs: [{ terminalId: "terminal-1", producerId: "00000000-0000-4000-8000-000000000001" }],
      activeTerminalId: "terminal-1",
    });
    expect(JSON.parse(values.get(threadPanelRegionsStorageKey("thread-1"))!)).toMatchObject({
      threadId: "thread-1",
      terminals: { activeTerminalId: "terminal-1" },
    });
    expect(values.has(threadPanelRegionsStorageKey("thread-2"))).toBe(false);
    const reloaded = createStore(storage, { threadId: null }).forThread("thread-1");
    expect(reloaded.terminalTab("terminal-1")).toBeDefined();
  });

  it("closing Terminals in one thread empties the Bottom for every thread", () => {
    const root = createStore(memoryStorage().storage, { threadId: null });
    const one = root.forThread("thread-1");
    const two = root.forThread("thread-2");
    one.openTerminalTab("terminal-1");
    two.openTerminalTab("terminal-2");
    expect(one.close("terminals")).toBe(true);
    expect(one.terminalPanel()).toBeUndefined();
    expect(two.terminalPanel()).toBeDefined();
    expect(two.isVisible("terminals")).toBe(false);
    expect(two.toggle("terminals")).toBe(true);
    expect(two.isVisible("terminals")).toBe(true);
  });

  it("never loads Terminals without a thread", () => {
    const root = createStore(memoryStorage().storage, { threadId: null });
    expect(root.threadId).toBe("unscoped");
    expect(root.open("terminals")).toBe(false);
    expect(root.toggle("terminals")).toBe(false);
    expect(root.openTerminalTab("terminal-1")).toBe(false);
    expect(root.terminalPanel()).toBeUndefined();
    expect(root.open("files")).toBe(true);
  });
});

describe("PanelRegionStore terminal tabs", () => {
  it("adds, activates and closes tabs with focus requests", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    expect(store.openTerminalTab("a", { focusScope: { kind: "thread", threadId: "thread-1" } })).toBe(true);
    expect(store.getSnapshot().focusRequest).toMatchObject({
      kind: "terminals",
      terminalId: "a",
      scope: { kind: "thread", threadId: "thread-1" },
    });
    expect(store.openTerminalTab("b", { focus: false })).toBe(true);
    expect(store.getSnapshot().focusRequest?.terminalId).toBe("a");
    expect(store.activateTerminalTab("a")).toBe(true);
    expect(store.activateTerminalTab("missing")).toBe(false);
    expect(store.terminalPanel()?.activeTerminalId).toBe("a");
    store.toggle("terminals");
    expect(store.isVisible("terminals")).toBe(false);
    expect(store.activateTerminalTab("b")).toBe(true);
    expect(store.isVisible("terminals")).toBe(true);
    const sequence = store.getSnapshot().focusRequest!.sequence;
    expect(store.closeTerminalTab("a")).toBe(true);
    expect(store.getSnapshot().focusRequest?.sequence).toBe(sequence);
    expect(store.closeTerminalTab("b")).toBe(true);
    expect(store.getSnapshot().focusRequest).toMatchObject({ kind: "terminals" });
    expect(store.getSnapshot().focusRequest?.terminalId).toBeUndefined();
    expect(store.terminalPanel()).toEqual({ threadId: "thread-1", tabs: [], activeTerminalId: null });
    expect(store.closeTerminalTab("b")).toBe(false);
  });

  it("refuses tabs past the limit", () => {
    const store = createStore();
    for (let index = 0; index < MAX_TERMINAL_TABS; index += 1)
      expect(store.openTerminalTab(`terminal-${index}`)).toBe(true);
    expect(store.openTerminalTab("one-more")).toBe(false);
    expect(store.openTerminalTab("terminal-3")).toBe(true);
  });

  it("opens Terminals in a chosen region", () => {
    const store = createStore();
    expect(store.openTerminalTab("a", { region: "right" })).toBe(true);
    expect(store.placementOf("terminals")).toBe("right");
    expect(store.regionPanel("right")).toBe("terminals");
    expect(store.openTerminalTab("b", { region: "center" as never })).toBe(false);
  });
});

describe("PanelRegionStore intents and focus", () => {
  it("delivers an intent and consumes it by sequence", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open("files", { intent: { sequence: 3, path: "README.md" } });
    expect(store.intent("files")).toEqual({ sequence: 3, path: "README.md" });
    listener.mockClear();
    // Re-delivering to an open panel still publishes.
    store.open("files", { intent: { sequence: 4 }, focus: false });
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    store.consumeIntent("files", 3);
    expect(store.intent("files")).toEqual({ sequence: 4 });
    expect(listener).not.toHaveBeenCalled();
    store.consumeIntent("files", 4);
    expect(store.intent("files")).toBeUndefined();
    expect(listener).toHaveBeenCalled();
    store.open("files", { intent: { sequence: 5 } });
    store.close("files");
    expect(store.intent("files")).toBeUndefined();
  });

  it("requests focus on open and show, and drops it when the panel hides", () => {
    const store = createStore();
    store.open("chat", { focusScope: { kind: "thread", threadId: "thread-1" } });
    const chatRequest = store.getSnapshot().focusRequest!;
    expect(chatRequest).toMatchObject({ kind: "chat", scope: { kind: "thread", threadId: "thread-1" } });
    store.open("files", { focus: false });
    expect(store.getSnapshot().focusRequest).toBe(chatRequest);
    store.consumeFocusRequest(chatRequest.sequence + 100);
    expect(store.getSnapshot().focusRequest).toBe(chatRequest);
    store.consumeFocusRequest(chatRequest.sequence);
    expect(store.getSnapshot().focusRequest).toBeUndefined();
    store.toggle("tasks");
    expect(store.getSnapshot().focusRequest).toMatchObject({ kind: "tasks" });
    store.toggle("tasks");
    expect(store.getSnapshot().focusRequest).toBeUndefined();
    store.toggle("tasks", { focus: false });
    expect(store.getSnapshot().focusRequest).toBeUndefined();
    store.open("workpads");
    store.close("tasks");
    expect(store.getSnapshot().focusRequest).toMatchObject({ kind: "workpads" });
    store.close("workpads");
    expect(store.getSnapshot().focusRequest).toBeUndefined();
  });
});

describe("PanelRegionStore make-room", () => {
  it("derives make-room from the stage size and shows a hidden panel on toggle", () => {
    const store = createStore();
    store.open("workpads", { region: "left" });
    store.open("tasks");
    expect(store.getSnapshot().geometry).toBeUndefined();
    expect(store.getSnapshot().visible).toEqual(["chat", "workpads", "tasks"]);
    store.setStageSize({ width: 900, height: 800 });
    expect(store.getSnapshot().stage).toEqual({ width: 900, height: 800 });
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual(["workpads"]);
    expect(store.isHiddenByMakeRoom("workpads")).toBe(true);
    expect(store.isVisible("workpads")).toBe(false);
    expect(store.loadState("workpads")).toBe("hidden");
    expect(store.loadState("tasks")).toBe("visible");
    expect(store.loadState("files")).toBe("closed");
    expect(store.isShown("workpads")).toBe(true);
    store.toggle("workpads");
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual(["tasks"]);
    expect(store.isVisible("workpads")).toBe(true);
    store.setStageSize({ width: 1200, height: 800 });
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual([]);
    store.setStageSize(undefined);
    expect(store.getSnapshot().geometry).toBeUndefined();
  });

  it("publishes a stage size only when it changes", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setStageSize({ width: 900, height: 800 });
    store.setStageSize({ width: 900, height: 800 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("records use, publishing each recency change", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    store.open("workpads", { region: "left" });
    store.open("files", { region: "top" });
    store.open("tasks");
    store.setStageSize({ width: 900, height: 2000 });
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual(["workpads"]);
    storage.setItem.mockClear();
    const listener = vi.fn();
    store.subscribe(listener);
    // Using visible panels leaves Workpads the least recently used.
    store.touch("files");
    store.touch("tasks");
    store.touch("chat");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().view.layout.recency).toEqual([
      "workpads",
      "files",
      "tasks",
      "chat",
    ]);
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual(["workpads"]);
    // Using the panel used last changes nothing.
    store.touch("chat");
    expect(listener).toHaveBeenCalledTimes(3);
    store.touch("workpads");
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot().hiddenByMakeRoom).toEqual(["tasks"]);
    // Recency is never saved.
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not save a fresh layout when only recency changes", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    store.touch("chat");
    store.touch("files");
    expect(store.getSnapshot().view.layout.recency).toEqual(["chat", "files"]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("updates every thread's make-room when another thread records use", () => {
    const root = createStore(memoryStorage().storage, { threadId: null });
    const one = root.forThread("thread-1");
    const two = root.forThread("thread-2");
    one.open("workpads");
    two.openTerminalTab("terminal-1", { region: "left" });
    root.setStageSize({ width: 800, height: 800 });
    // Thread 2: 160 + 5 + 320 + 5 + 360 = 850 > 800.
    expect(two.getSnapshot().hiddenByMakeRoom).toEqual(["workpads"]);
    expect(one.getSnapshot().hiddenByMakeRoom).toEqual([]);
    const listener = vi.fn();
    two.subscribe(listener);
    one.touch("workpads");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(two.getSnapshot().hiddenByMakeRoom).toEqual(["terminals"]);
    expect(two.getSnapshot().visible).toEqual(["chat", "workpads"]);
    expect(two.getSnapshot().view.layout.recency).toEqual(["terminals", "workpads"]);
  });
});

describe("PanelRegionStore persistence", () => {
  it("migrates the old keys once and saves the result", () => {
    const { storage, values } = memoryStorage({
      [LEGACY_PANEL_STORAGE_KEYS.tasks]: JSON.stringify({ version: 1, open: true, collapsed: false }),
      [LEGACY_PANEL_STORAGE_KEYS.companions]: JSON.stringify({
        version: 1,
        arrangement: [{ kind: "tasks", edge: "left" }],
      }),
      [legacyThreadLayoutStorageKey("thread-1")]: JSON.stringify({
        version: 4,
        threadId: "thread-1",
        tree: {
          kind: "tabs",
          id: "stack",
          tabs: [
            {
              panelInstanceId: "terminals",
              kind: "terminals",
              threadId: "thread-1",
              tabs: [{ terminalId: "t-1", producerId: "00000000-0000-4000-8000-000000000009" }],
              activeTerminalId: "t-1",
            },
          ],
          activePanelInstanceId: "terminals",
        },
      }),
    });
    const store = createStore(storage);
    expect(store.getSnapshot().visible).toEqual(["chat", "tasks", "terminals"]);
    expect(store.placementOf("tasks")).toBe("left");
    expect(savedLayout(values)).toMatchObject({ shown: { left: "tasks" } });
    expect(JSON.parse(values.get(threadPanelRegionsStorageKey("thread-1"))!)).toMatchObject({
      terminals: { activeTerminalId: "t-1" },
    });
    // The old keys are only read.
    expect(values.has(LEGACY_PANEL_STORAGE_KEYS.tasks)).toBe(true);
    // A later change to the old keys no longer applies.
    values.set(
      LEGACY_PANEL_STORAGE_KEYS.tasks,
      JSON.stringify({ version: 1, open: false, collapsed: false }),
    );
    expect(createStore(storage).isLoaded("tasks")).toBe(true);
  });

  it("does not write a stored layout back on load", () => {
    const { storage } = memoryStorage({
      [PANEL_REGIONS_STORAGE_KEY]: serializeRegionLayout(defaultRegionLayout()),
      [threadPanelRegionsStorageKey("thread-1")]: serializeThreadTerminals("thread-1", null),
    });
    const store = createStore(storage);
    store.open("chat");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("starts from defaults for invalid saved values and overwrites them on change", () => {
    const { storage, values } = memoryStorage({
      [PANEL_REGIONS_STORAGE_KEY]: "{",
      [threadPanelRegionsStorageKey("thread-1")]: "{",
    });
    const store = createStore(storage);
    expect(store.getSnapshot().view.layout).toEqual(defaultRegionLayout());
    expect(store.terminalPanel()).toBeUndefined();
    expect(storage.setItem).not.toHaveBeenCalled();
    store.open("files");
    store.openTerminalTab("a");
    expect(savedLayout(values)).toMatchObject({ loaded: ["files"] });
    expect(JSON.parse(values.get(threadPanelRegionsStorageKey("thread-1"))!)).toMatchObject({
      terminals: { activeTerminalId: "a" },
    });
  });

  it("keeps working when storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const store = createStore(storage);
    expect(store.open("files")).toBe(true);
    expect(store.openTerminalTab("a")).toBe(true);
    expect(store.getSnapshot().visible).toEqual(["chat", "files", "terminals"]);
  });

  it("drops device-wide panels whose tenant is not registered", () => {
    const { storage } = memoryStorage();
    createStore(storage).open("files");
    const store = createStore(storage, { tenants: [tenant("tasks")] });
    expect(store.isLoaded("files")).toBe(false);
    expect(store.regionPanel("right")).toBeNull();
    expect(store.open("files")).toBe(false);
    expect(store.toggle("workpads")).toBe(false);
    expect(store.open("tasks")).toBe(true);
  });
});

describe("PanelRegionStore cross-tab sync", () => {
  it("applies another tab's device layout without writing it back", () => {
    const { storage } = memoryStorage();
    const store = createStore(storage);
    store.open("files");
    store.maximize("files");
    storage.setItem.mockClear();
    const listener = vi.fn();
    store.subscribe(listener);
    const other = defaultRegionLayout();
    expect(
      store.applyStorageEvent(
        PANEL_REGIONS_STORAGE_KEY,
        serializeRegionLayout({ ...other, loaded: ["tasks"], shown: { ...other.shown, right: "tasks" } }),
      ),
    ).toBe(true);
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot().visible).toEqual(["chat", "tasks"]);
    // Files is gone in the other tab, so its Maximize ends here.
    expect(store.maximized()).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    store.open("tasks", { focus: false });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("ignores invalid values and unrelated keys, and resets for a removed key", () => {
    const store = createStore();
    store.open("files");
    expect(store.applyStorageEvent(PANEL_REGIONS_STORAGE_KEY, "{")).toBe(false);
    expect(store.applyStorageEvent("unrelated", "{}")).toBe(false);
    expect(store.applyStorageEvent(null, null)).toBe(false);
    expect(store.isLoaded("files")).toBe(true);
    expect(store.applyStorageEvent(PANEL_REGIONS_STORAGE_KEY, null)).toBe(true);
    expect(store.isLoaded("files")).toBe(false);
  });

  it("applies another tab's Terminals to an existing thread store", () => {
    const root = createStore(memoryStorage().storage, { threadId: null });
    const one = root.forThread("thread-1");
    const key = threadPanelRegionsStorageKey("thread-1");
    const terminals = {
      tabs: [{ terminalId: "x", producerId: "00000000-0000-4000-8000-000000000042" }],
      activeTerminalId: "x",
    };
    expect(root.applyStorageEvent(key, serializeThreadTerminals("thread-1", terminals))).toBe(true);
    expect(one.terminalPanel()).toEqual({ threadId: "thread-1", ...terminals });
    expect(root.applyStorageEvent(key, serializeThreadTerminals("thread-2", null))).toBe(false);
    expect(
      root.applyStorageEvent(threadPanelRegionsStorageKey("thread-9"), serializeThreadTerminals("thread-9", null)),
    ).toBe(false);
    one.openTerminalTab("x");
    expect(root.applyStorageEvent(key, null)).toBe(true);
    expect(one.terminalPanel()).toBeUndefined();
    expect(one.getSnapshot().focusRequest).toBeUndefined();
  });

  it("installs a storage listener", () => {
    const store = createStore();
    const target = new EventTarget();
    const dispose = installPanelRegionStorageSync(store, target as unknown as Window);
    const layout = defaultRegionLayout();
    const event = Object.assign(new Event("storage"), {
      key: PANEL_REGIONS_STORAGE_KEY,
      newValue: serializeRegionLayout({ ...layout, loaded: ["files"], shown: { ...layout.shown, right: "files" } }),
    });
    target.dispatchEvent(event);
    expect(store.isVisible("files")).toBe(true);
    dispose();
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: PANEL_REGIONS_STORAGE_KEY, newValue: null }),
    );
    expect(store.isVisible("files")).toBe(true);
  });
});

describe("PanelRegionStore workspace dirty registry", () => {
  it("tracks dirty tenants per workspace across threads", () => {
    const root = createStore(memoryStorage().storage, { threadId: null });
    const one = root.forThread("thread-1");
    const two = root.forThread("thread-2");
    const listener = vi.fn();
    root.subscribeWorkspaceDirty(listener);
    one.setWorkspaceTenantDirty("workspace-1", "workspace-files", true);
    two.setWorkspaceTenantDirty("workspace-1", "workspace-files", true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(root.hasDirtyWorkspacePanels("workspace-1")).toBe(true);
    expect(root.hasAnyDirtyWorkspacePanels()).toBe(true);
    one.setWorkspaceTenantDirty("workspace-1", "workspace-files", false);
    expect(root.hasDirtyWorkspacePanels("workspace-1")).toBe(true);
    two.setWorkspaceTenantDirty("workspace-1", "workspace-files", false);
    expect(root.hasAnyDirtyWorkspacePanels()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    one.setWorkspaceTenantDirty("workspace-2", "workpads", true);
    root.discardWorkspacePanelChanges("workspace-2");
    expect(root.hasAnyDirtyWorkspacePanels()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    root.discardWorkspacePanelChanges("workspace-2");
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe("usePanelRegions", () => {
  it("re-renders on store changes", () => {
    const store = createStore();
    const { result } = renderHook(() => usePanelRegions(store));
    expect(result.current.visible).toEqual(["chat"]);
    act(() => {
      store.open("tasks");
    });
    expect(result.current.visible).toEqual(["chat", "tasks"]);
    act(() => {
      store.forThread("thread-2").toggle("tasks");
    });
    expect(result.current.visible).toEqual(["chat"]);
  });
});
