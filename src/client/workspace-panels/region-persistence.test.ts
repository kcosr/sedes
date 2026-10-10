import { describe, expect, it } from "vitest";
import {
  LEGACY_PANEL_STORAGE_KEYS,
  PANEL_REGIONS_STORAGE_KEY,
  legacyThreadLayoutStorageKey,
  loadRegionLayout,
  loadThreadTerminals,
  migrateLegacyRegionLayout,
  migrateLegacyThreadTerminals,
  parseRegionLayout,
  parseThreadTerminals,
  serializeRegionLayout,
  serializeThreadTerminals,
  threadIdForPanelRegionsStorageKey,
  threadPanelRegionsStorageKey,
  type RegionStorage,
} from "./region-persistence.js";
import {
  DEFAULT_SHOWN,
  defaultRegionLayout,
  maximizePanel,
  movePanel,
  openPanel,
  setExtend,
  setPanelSize,
  type RegionLayout,
} from "./regions.js";

const PRODUCER_1 = "00000000-0000-4000-8000-000000000001";
const PRODUCER_2 = "00000000-0000-4000-8000-000000000002";

function storageWith(values: Readonly<Record<string, string>> = {}): RegionStorage {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

function customLayout(): RegionLayout {
  let view = openPanel({ layout: defaultRegionLayout(), terminals: null }, "files");
  view = openPanel(view, "tasks", "left");
  view = movePanel(view, "chat", "top");
  view = openPanel(view, "workpads", "middle");
  view = maximizePanel(view, "tasks");
  let layout = setExtend(view.layout, "top", true);
  layout = setPanelSize(layout, "files", "width", 0.3);
  layout = setPanelSize(layout, "chat", "height", 0.4);
  return layout;
}

function validLayoutJson(): Record<string, unknown> {
  return JSON.parse(serializeRegionLayout(customLayout())) as Record<string, unknown>;
}

describe("device layout serialization", () => {
  it("round-trips the saved parts and drops Maximize and recency", () => {
    const layout = customLayout();
    const serialized = serializeRegionLayout(layout);
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      placement: {
        chat: "top",
        files: "right",
        workpads: "middle",
        tasks: "left",
        terminals: "bottom",
      },
      shown: { middle: "workpads", left: "tasks", right: "files", top: "chat", bottom: "terminals" },
      loaded: ["files", "workpads", "tasks"],
      extendOrder: ["top", "left", "right", "bottom"],
      sizes: { chat: { height: 0.4 }, files: { width: 0.3 } },
    });
    const parsed = parseRegionLayout(serialized)!;
    expect(parsed).toEqual({
      placement: layout.placement,
      shown: layout.shown,
      loaded: layout.loaded,
      extendOrder: layout.extendOrder,
      sizes: layout.sizes,
    });
    expect("maximized" in parsed).toBe(false);
  });

  it("serializes the default layout", () => {
    expect(parseRegionLayout(serializeRegionLayout(defaultRegionLayout()))).toEqual({
      placement: defaultRegionLayout().placement,
      shown: DEFAULT_SHOWN,
      loaded: [],
      extendOrder: ["left", "right", "top", "bottom"],
      sizes: {},
    });
  });

  it.each<[string, (json: Record<string, unknown>) => unknown]>([
    ["non-JSON", () => "{"],
    ["an array", () => []],
    ["another version", (json) => ({ ...json, version: 2 })],
    ["an unknown key", (json) => ({ ...json, extra: true })],
    ["a missing key", ({ sizes: _sizes, ...json }) => json],
    ["a placement missing a kind", (json) => ({ ...json, placement: { chat: "middle" } })],
    [
      "an unknown region",
      (json) => ({ ...json, placement: { ...(json.placement as object), files: "center" } }),
    ],
    [
      "a placement with an extra kind",
      (json) => ({ ...json, placement: { ...(json.placement as object), notes: "left" } }),
    ],
    ["a shown map missing a region", (json) => ({ ...json, shown: { middle: "workpads" } })],
    [
      "a region showing a kind placed elsewhere",
      (json) => ({ ...json, shown: { ...(json.shown as object), bottom: "files" } }),
    ],
    [
      "an unknown shown kind",
      (json) => ({ ...json, shown: { ...(json.shown as object), bottom: "notes" } }),
    ],
    [
      "a shown device-wide kind that is not loaded",
      (json) => ({ ...json, loaded: ["files", "workpads"] }),
    ],
    ["loaded Chat", (json) => ({ ...json, loaded: ["chat"] })],
    ["a duplicate loaded kind", (json) => ({ ...json, loaded: ["files", "files", "workpads", "tasks"] })],
    ["loaded that is not an array", (json) => ({ ...json, loaded: "files" })],
    ["a short extend order", (json) => ({ ...json, extendOrder: ["left", "right", "top"] })],
    [
      "a repeated extend region",
      (json) => ({ ...json, extendOrder: ["left", "left", "top", "bottom"] }),
    ],
    [
      "the Middle in the extend order",
      (json) => ({ ...json, extendOrder: ["middle", "right", "top", "bottom"] }),
    ],
    ["sizes that are not an object", (json) => ({ ...json, sizes: [] })],
    ["a size for an unknown kind", (json) => ({ ...json, sizes: { notes: { width: 0.3 } } })],
    ["an unknown size axis", (json) => ({ ...json, sizes: { files: { depth: 0.3 } } })],
    ["a non-numeric size", (json) => ({ ...json, sizes: { files: { width: "0.3" } } })],
    ["a size that is not an object", (json) => ({ ...json, sizes: { files: 0.3 } })],
  ])("rejects %s", (_name, mutate) => {
    const value = mutate(validLayoutJson());
    expect(
      parseRegionLayout(typeof value === "string" ? value : JSON.stringify(value)),
    ).toBeUndefined();
  });

  it("drops a remembered share outside the bounds on its own", () => {
    const parsed = parseRegionLayout(
      JSON.stringify({
        ...validLayoutJson(),
        sizes: { files: { width: 0.01, height: 0.5 }, tasks: { width: 1.5 } },
      }),
    );
    expect(parsed?.sizes).toEqual({ files: { height: 0.5 } });
  });
});

describe("loadRegionLayout", () => {
  it("loads a saved layout", () => {
    const storage = storageWith({
      [PANEL_REGIONS_STORAGE_KEY]: serializeRegionLayout(customLayout()),
    });
    const { layout, source } = loadRegionLayout(storage);
    expect(source).toBe("stored");
    expect(layout.shown.middle).toBe("workpads");
    expect(layout.maximized).toBeNull();
    expect(layout.recency).toEqual([]);
    expect(Object.isFrozen(layout)).toBe(true);
  });

  it("falls back to defaults for an invalid saved layout without migrating", () => {
    const storage = storageWith({
      [PANEL_REGIONS_STORAGE_KEY]: "{}",
      [LEGACY_PANEL_STORAGE_KEYS.tasks]: JSON.stringify({ version: 1, open: true, collapsed: false }),
    });
    expect(loadRegionLayout(storage)).toEqual({
      layout: defaultRegionLayout(),
      source: "invalid",
    });
  });

  it("migrates when the saved layout is absent and old keys exist", () => {
    const storage = storageWith({
      [LEGACY_PANEL_STORAGE_KEYS.tasks]: JSON.stringify({ version: 1, open: true, collapsed: false }),
    });
    const { layout, source } = loadRegionLayout(storage);
    expect(source).toBe("migrated");
    expect(layout.loaded).toEqual(["tasks"]);
  });

  it("uses defaults when nothing is saved", () => {
    expect(loadRegionLayout(storageWith())).toEqual({
      layout: defaultRegionLayout(),
      source: "default",
    });
    expect(loadRegionLayout(undefined).source).toBe("default");
  });

  it("treats storage that throws as empty", () => {
    const storage: RegionStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(loadRegionLayout(storage).source).toBe("default");
    expect(loadThreadTerminals(storage, "thread-1").source).toBe("default");
  });
});

describe("migrateLegacyRegionLayout", () => {
  const visibility = (open: boolean, collapsed = false) =>
    JSON.stringify({ version: 1, open, collapsed });
  const companions = (arrangement: readonly { kind: string; edge: string }[]) =>
    JSON.stringify({ version: 1, arrangement });

  it("returns undefined without any old key", () => {
    expect(migrateLegacyRegionLayout(storageWith())).toBeUndefined();
  });

  it("loads open panels and shows the uncollapsed ones in their regions", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.files]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.workpads]: visibility(true, true),
        [LEGACY_PANEL_STORAGE_KEYS.tasks]: visibility(false, true),
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([{ kind: "workpads", edge: "left" }]),
      }),
    )!;
    expect(layout.loaded).toEqual(["files", "workpads"]);
    expect(layout.placement).toMatchObject({ workpads: "left", files: "right", tasks: "right" });
    // Collapsed Workpads is loaded but hidden.
    expect(layout.shown).toEqual({
      middle: "chat",
      left: null,
      right: "files",
      top: null,
      bottom: "terminals",
    });
    expect(layout.extendOrder).toEqual(["left", "right", "top", "bottom"]);
    expect(layout.maximized).toBeNull();
  });

  it("shows the companion opened most recently (outermost) when several share a region", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.files]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.workpads]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.tasks]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([
          { kind: "workpads", edge: "right" },
          { kind: "tasks", edge: "right" },
        ]),
      }),
    )!;
    expect(layout.shown.right).toBe("workpads");
    expect(layout.loaded).toEqual(["files", "workpads", "tasks"]);
    expect(layout.recency).toEqual(["workpads"]);
  });

  it("falls back to Tasks, Workpads, Files order without an arrangement", () => {
    const all = {
      [LEGACY_PANEL_STORAGE_KEYS.files]: visibility(true),
      [LEGACY_PANEL_STORAGE_KEYS.workpads]: visibility(true),
      [LEGACY_PANEL_STORAGE_KEYS.tasks]: visibility(true),
    };
    expect(migrateLegacyRegionLayout(storageWith(all))!.shown.right).toBe("tasks");
    expect(
      migrateLegacyRegionLayout(
        storageWith({ ...all, [LEGACY_PANEL_STORAGE_KEYS.tasks]: visibility(false) }),
      )!.shown.right,
    ).toBe("workpads");
  });

  it("gives each region its own winner, most recent last in recency", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.files]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.workpads]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.tasks]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([
          { kind: "tasks", edge: "bottom" },
          { kind: "workpads", edge: "left" },
        ]),
      }),
    )!;
    // A companion docked at the Bottom replaces the Terminals pick there.
    expect(layout.shown).toEqual({
      middle: "chat",
      left: "workpads",
      right: "files",
      top: null,
      bottom: "tasks",
    });
    expect(layout.recency).toEqual(["files", "workpads", "tasks"]);
  });

  it("carries remembered sizes over, dropping invalid ones", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.sizes]: JSON.stringify({
          version: 5,
          sizes: {
            files: { width: 0.3, height: 2 },
            terminals: { height: 0.25 },
            tasks: "wide",
            chat: { width: 0.5 },
          },
        }),
      }),
    )!;
    expect(layout.sizes).toEqual({ files: { width: 0.3 }, terminals: { height: 0.25 } });
    expect(layout.loaded).toEqual([]);
    expect(layout.shown).toEqual(DEFAULT_SHOWN);
  });

  it("treats unreadable old values as absent panels", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.files]: "{",
        [LEGACY_PANEL_STORAGE_KEYS.tasks]: JSON.stringify({ version: 2, open: true, collapsed: false }),
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([{ kind: "tasks", edge: "middle" }]),
        [LEGACY_PANEL_STORAGE_KEYS.sizes]: JSON.stringify({ version: 4, sizes: {} }),
      }),
    )!;
    expect(layout).toEqual(defaultRegionLayout());
  });

  it("ignores an arrangement with a repeated companion", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([
          { kind: "tasks", edge: "left" },
          { kind: "tasks", edge: "top" },
        ]),
      }),
    )!;
    expect(layout.placement.tasks).toBe("right");
  });

  it("produces a layout that serializes and parses back", () => {
    const layout = migrateLegacyRegionLayout(
      storageWith({
        [LEGACY_PANEL_STORAGE_KEYS.workpads]: visibility(true),
        [LEGACY_PANEL_STORAGE_KEYS.companions]: companions([{ kind: "workpads", edge: "top" }]),
      }),
    )!;
    expect(parseRegionLayout(serializeRegionLayout(layout))).toMatchObject({
      shown: { top: "workpads" },
    });
  });
});

describe("thread Terminals serialization", () => {
  const terminals = {
    tabs: [
      { terminalId: "terminal-1", producerId: PRODUCER_1 },
      { terminalId: "terminal-2", producerId: PRODUCER_2 },
    ],
    activeTerminalId: "terminal-2",
  };

  it("round-trips loaded and unloaded Terminals", () => {
    expect(
      parseThreadTerminals("thread-1", serializeThreadTerminals("thread-1", terminals)),
    ).toEqual({ terminals });
    expect(
      parseThreadTerminals("thread-1", serializeThreadTerminals("thread-1", null)),
    ).toEqual({ terminals: null });
    expect(
      parseThreadTerminals(
        "thread-1",
        serializeThreadTerminals("thread-1", { tabs: [], activeTerminalId: null }),
      ),
    ).toEqual({ terminals: { tabs: [], activeTerminalId: null } });
  });

  const valid = () =>
    JSON.parse(serializeThreadTerminals("thread-1", terminals)) as {
      terminals: { tabs: Record<string, unknown>[]; activeTerminalId: unknown };
    } & Record<string, unknown>;

  it.each<[string, () => unknown]>([
    ["non-JSON", () => "nope"],
    ["another version", () => ({ ...valid(), version: 2 })],
    ["another thread", () => ({ ...valid(), threadId: "thread-2" })],
    ["an unknown key", () => ({ ...valid(), extra: 1 })],
    ["Terminals with an unknown key", () => ({ ...valid(), terminals: { ...valid().terminals, x: 1 } })],
    [
      "a tab with an unknown key",
      () => {
        const json = valid();
        json.terminals.tabs[0] = { ...json.terminals.tabs[0], label: "x" };
        return json;
      },
    ],
    [
      "duplicate terminal IDs",
      () => {
        const json = valid();
        json.terminals.tabs[1]!.terminalId = "terminal-1";
        return json;
      },
    ],
    [
      "duplicate producers",
      () => {
        const json = valid();
        json.terminals.tabs[1]!.producerId = PRODUCER_1;
        return json;
      },
    ],
    [
      "an invalid producer",
      () => {
        const json = valid();
        json.terminals.tabs[0]!.producerId = "producer";
        return json;
      },
    ],
    [
      "an active tab that is missing",
      () => ({ ...valid(), terminals: { ...valid().terminals, activeTerminalId: "terminal-9" } }),
    ],
    [
      "no active tab among tabs",
      () => ({ ...valid(), terminals: { ...valid().terminals, activeTerminalId: null } }),
    ],
    [
      "an active tab without tabs",
      () => ({ ...valid(), terminals: { tabs: [], activeTerminalId: "terminal-1" } }),
    ],
    [
      "too many tabs",
      () => ({
        ...valid(),
        terminals: {
          tabs: Array.from({ length: 25 }, (_, index) => ({
            terminalId: `terminal-${index}`,
            producerId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          })),
          activeTerminalId: "terminal-0",
        },
      }),
    ],
  ])("rejects %s", (_name, build) => {
    const value = build();
    expect(
      parseThreadTerminals("thread-1", typeof value === "string" ? value : JSON.stringify(value)),
    ).toBeUndefined();
  });
});

describe("loadThreadTerminals", () => {
  const legacy = (threadId: string, tree: unknown, version = 4) =>
    JSON.stringify({ version, threadId, tree });
  const legacyTerminals = (threadId = "thread-1") => ({
    panelInstanceId: "terminals",
    kind: "terminals",
    threadId,
    tabs: [{ terminalId: "terminal-1", producerId: PRODUCER_1 }],
    activeTerminalId: "terminal-1",
  });
  const legacyTree = (terminals: unknown) => ({
    kind: "split",
    id: "split-1",
    orientation: "column",
    sizes: [0.7, 0.3],
    children: [
      {
        kind: "split",
        id: "split-2",
        orientation: "row",
        sizes: [0.6, 0.4],
        children: [
          { kind: "tabs", id: "stack-chat", tabs: [{ panelInstanceId: "chat", kind: "chat" }], activePanelInstanceId: "chat" },
          { kind: "tabs", id: "stack-files", tabs: [{ panelInstanceId: "workspace-files", kind: "files" }], activePanelInstanceId: "workspace-files" },
        ],
      },
      { kind: "tabs", id: "stack-terminals", tabs: [terminals], activePanelInstanceId: "terminals" },
    ],
  });

  it("loads saved Terminals, and treats invalid ones as not loaded", () => {
    const key = threadPanelRegionsStorageKey("thread-1");
    expect(
      loadThreadTerminals(
        storageWith({ [key]: serializeThreadTerminals("thread-1", null) }),
        "thread-1",
      ),
    ).toEqual({ terminals: null, source: "stored" });
    expect(
      loadThreadTerminals(
        storageWith({
          [key]: "{",
          [legacyThreadLayoutStorageKey("thread-1")]: legacy("thread-1", legacyTree(legacyTerminals())),
        }),
        "thread-1",
      ),
    ).toEqual({ terminals: null, source: "invalid" });
    expect(loadThreadTerminals(storageWith(), "thread-1")).toEqual({
      terminals: null,
      source: "default",
    });
  });

  it("migrates Terminals from the thread's old layout tree", () => {
    const storage = storageWith({
      [legacyThreadLayoutStorageKey("thread-1")]: legacy("thread-1", legacyTree(legacyTerminals())),
    });
    expect(loadThreadTerminals(storage, "thread-1")).toEqual({
      terminals: {
        tabs: [{ terminalId: "terminal-1", producerId: PRODUCER_1 }],
        activeTerminalId: "terminal-1",
      },
      source: "migrated",
    });
  });

  it("migrates an old layout without valid Terminals as not loaded", () => {
    const migrate = (value: string) =>
      migrateLegacyThreadTerminals(
        storageWith({ [legacyThreadLayoutStorageKey("thread-1")]: value }),
        "thread-1",
      );
    expect(migrate("{")).toEqual({ terminals: null });
    expect(migrate(legacy("thread-1", legacyTree(legacyTerminals()), 3))).toEqual({ terminals: null });
    expect(migrate(legacy("thread-2", legacyTree(legacyTerminals())))).toEqual({ terminals: null });
    expect(migrate(legacy("thread-1", legacyTree(legacyTerminals("thread-2"))))).toEqual({
      terminals: null,
    });
    expect(
      migrate(
        legacy("thread-1", legacyTree({ ...legacyTerminals(), activeTerminalId: "missing" })),
      ),
    ).toEqual({ terminals: null });
    expect(
      migrate(
        legacy("thread-1", {
          kind: "tabs",
          id: "main",
          tabs: [{ panelInstanceId: "chat", kind: "chat" }],
          activePanelInstanceId: "chat",
        }),
      ),
    ).toEqual({ terminals: null });
    expect(migrate(legacy("thread-1", null))).toEqual({ terminals: null });
    expect(
      migrate(legacy("thread-1", legacyTree({ ...legacyTerminals(), tabs: [], activeTerminalId: null }))),
    ).toEqual({ terminals: { tabs: [], activeTerminalId: null } });
  });

  it("returns undefined when the thread has no old layout", () => {
    expect(migrateLegacyThreadTerminals(storageWith(), "thread-1")).toBeUndefined();
  });
});

describe("storage keys", () => {
  it("encodes and decodes thread IDs", () => {
    const key = threadPanelRegionsStorageKey("thread/1 ü");
    expect(key).toBe("sedes-thread-panel-regions@1:thread%2F1%20%C3%BC");
    expect(threadIdForPanelRegionsStorageKey(key)).toBe("thread/1 ü");
    expect(threadIdForPanelRegionsStorageKey(PANEL_REGIONS_STORAGE_KEY)).toBeUndefined();
    expect(threadIdForPanelRegionsStorageKey("sedes-thread-panel-regions@1:%E0")).toBeUndefined();
    expect(legacyThreadLayoutStorageKey("a b")).toBe("sedes-thread-panel-instance-layout@4:a%20b");
  });
});
