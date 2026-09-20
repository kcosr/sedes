import { describe, expect, it } from "vitest";
import {
  MAX_LAYOUT_DEPTH,
  MAX_TERMINAL_TABS,
  activatePanel,
  chatPanelInstance,
  closePanel,
  defaultPanelLayout,
  deserializePanelLayout,
  dockPanel,
  findPanel,
  findStackForPanel,
  normalizePanelLayout,
  openPanel,
  panelInstances,
  resizeSplit,
  serializePanelLayout,
  validatePanelLayout,
  type LayoutNode,
  type PanelInstance,
  type PanelLayoutTree,
  type SplitNode,
  type TabStackNode,
  type TerminalTab,
} from "./layout-tree.js";

const THREAD_ID = "thread-1";
const OTHER_THREAD_ID = "thread-2";
const files: PanelInstance = {
  panelInstanceId: "workspace-files",
  kind: "files",
};

function terminalTab(id: string): TerminalTab {
  return { terminalId: id, producerId: producerIdFor(id) };
}

function terminals(
  tabs: readonly TerminalTab[] = [terminalTab("terminal-1")],
  activeTerminalId: string | null = tabs.at(-1)?.terminalId ?? null,
  threadId = THREAD_ID,
): PanelInstance {
  return {
    panelInstanceId: "terminals",
    kind: "terminals",
    threadId,
    tabs,
    activeTerminalId,
  };
}

function producerIdFor(id: string): string {
  const suffix = [...id]
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 0xffffffffffff, 0)
    .toString(16)
    .padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

function stack(id: string, ...tabs: PanelInstance[]): TabStackNode {
  return {
    kind: "tabs",
    id,
    tabs,
    activePanelInstanceId: tabs.at(-1)!.panelInstanceId,
  };
}

function split(left: LayoutNode, right: LayoutNode, id = "root"): SplitNode {
  return {
    kind: "split",
    id,
    orientation: "row",
    children: [left, right],
    sizes: [0.7, 0.3],
  };
}

describe("panel-instance layout tree", () => {
  it("starts with Chat in a tab stack", () => {
    expect(defaultPanelLayout).toEqual({
      kind: "tabs",
      id: "main-panel-stack",
      tabs: [chatPanelInstance],
      activePanelInstanceId: "chat",
    });
  });

  it("builds a generic layout around one nested terminal container", () => {
    let tree: PanelLayoutTree = openPanel(defaultPanelLayout, files, {
      edge: "right",
      splitId: "split-1",
      stackId: "files-stack",
    });
    tree = openPanel(tree, terminals(), {
      edge: "bottom",
      splitId: "unused",
      stackId: "unused-stack",
      mode: "tab",
      targetNodeId: "files-stack",
    });
    expect(validatePanelLayout(tree)).toEqual([]);
    expect(panelInstances(tree).map((panel) => panel.panelInstanceId)).toEqual([
      "chat",
      "workspace-files",
      "terminals",
    ]);
    expect(findStackForPanel(tree, "terminals")?.activePanelInstanceId).toBe(
      "terminals",
    );
  });

  it("enforces canonical singleton terminal-container identity", () => {
    const one = openPanel(defaultPanelLayout, terminals(), {
      edge: "bottom",
      splitId: "s1",
      stackId: "t1",
    });
    expect(
      openPanel(one, terminals([terminalTab("terminal-2")]), {
        edge: "bottom",
        splitId: "s2",
        stackId: "t2",
      }),
    ).toBe(one);
    expect(
      validatePanelLayout(
        stack("bad", { ...terminals(), panelInstanceId: "wrong" } as never),
      ),
    ).toContain("canonical_terminals_panel_id");
  });

  it("requires unique bounded terminal tabs and a present active terminal", () => {
    const duplicateId = terminals([
      terminalTab("same"),
      { ...terminalTab("other"), terminalId: "same" },
    ]);
    const duplicateProducer = terminals([
      terminalTab("one"),
      { ...terminalTab("two"), producerId: producerIdFor("one") },
    ]);
    expect(validatePanelLayout(stack("terminal-stack", duplicateId))).toContain(
      "unique_valid_terminal_ids",
    );
    expect(
      validatePanelLayout(stack("terminal-stack", duplicateProducer)),
    ).toContain("unique_valid_terminal_producer_ids");
    expect(
      validatePanelLayout(
        stack("terminal-stack", terminals([terminalTab("one")], "missing")),
      ),
    ).toContain("active_terminal_tab_present");
    expect(
      validatePanelLayout(
        stack(
          "terminal-stack",
          terminals(
            Array.from({ length: MAX_TERMINAL_TABS + 1 }, (_, index) =>
              terminalTab(`terminal-${index}`),
            ),
          ),
        ),
      ),
    ).toContain("bounded_terminal_tabs");
  });

  it("activates, closes, docks, and resizes the terminal container as one panel", () => {
    const tree = split(
      stack("left", chatPanelInstance, terminals()),
      stack("right", files),
    );
    expect(activatePanel(tree, "terminals")).toMatchObject({
      children: [{ activePanelInstanceId: "terminals" }, expect.anything()],
    });
    expect(closePanel(tree, "terminals")).toMatchObject({
      children: [
        { tabs: [{ panelInstanceId: "chat" }] },
        { tabs: [{ panelInstanceId: "workspace-files" }] },
      ],
    });
    const docked = dockPanel(tree, "terminals", "bottom", {
      splitId: "dock",
      stackId: "dock-tabs",
    });
    expect(docked).toMatchObject({
      id: "dock",
      orientation: "column",
      children: [
        { kind: "split" },
        { kind: "tabs", tabs: [{ panelInstanceId: "terminals" }] },
      ],
    });
    expect((resizeSplit(docked, "dock", [2, 3]) as SplitNode).sizes).toEqual([
      0.4, 0.6,
    ]);
  });

  it("rejects excessive depth and deeply freezes nested terminal tabs", () => {
    let deep: LayoutNode = stack("depth-0", chatPanelInstance);
    for (let index = 1; index <= MAX_LAYOUT_DEPTH + 1; index += 1) {
      deep = split(
        deep,
        stack(`depth-${index}`, index === 1 ? terminals() : files),
        `split-${index}`,
      );
    }
    expect(validatePanelLayout(deep)).toContain("bounded_depth");
    expect(normalizePanelLayout(deep)).toBe(defaultPanelLayout);

    const panel = findPanel(
      normalizePanelLayout(
        stack(
          "terminal-stack",
          terminals([terminalTab("terminal-a"), terminalTab("terminal-b")]),
        ),
      ),
      "terminals",
    ) as Extract<PanelInstance, { kind: "terminals" }>;
    expect(Object.isFrozen(panel)).toBe(true);
    expect(Object.isFrozen(panel.tabs)).toBe(true);
    expect(Object.isFrozen(panel.tabs[0])).toBe(true);
  });
});

describe("panel-instance layout v4 persistence", () => {
  it("round-trips topology, thread scope, and intentional empty state", () => {
    const tree = split(
      stack("left", chatPanelInstance, terminals()),
      stack("right", files),
    );
    expect(
      deserializePanelLayout(THREAD_ID, serializePanelLayout(THREAD_ID, tree)),
    ).toEqual(tree);
    expect(
      deserializePanelLayout(THREAD_ID, serializePanelLayout(THREAD_ID, null)),
    ).toBeNull();
  });

  it("round-trips an empty terminal panel with no active terminal", () => {
    const tree = stack("empty-terminals", terminals([]));
    expect(validatePanelLayout(tree)).toEqual([]);
    expect(deserializePanelLayout(THREAD_ID, serializePanelLayout(THREAD_ID, tree))).toEqual(tree);
  });

  it("rejects a mismatched envelope or terminal-container thread", () => {
    const serialized = serializePanelLayout(
      THREAD_ID,
      stack("terminals", terminals()),
    );
    expect(deserializePanelLayout(OTHER_THREAD_ID, serialized)).toBe(
      defaultPanelLayout,
    );
    expect(() =>
      serializePanelLayout(
        THREAD_ID,
        stack(
          "terminals",
          terminals([terminalTab("terminal-1")], "terminal-1", OTHER_THREAD_ID),
        ),
      ),
    ).toThrow("panel_layout_thread_mismatch");
  });

  it("does not read v3 or the removed single-terminal panel shape", () => {
    expect(
      deserializePanelLayout(
        THREAD_ID,
        JSON.stringify({ version: 3, threadId: THREAD_ID, tree: defaultPanelLayout }),
      ),
    ).toBe(defaultPanelLayout);
    expect(
      deserializePanelLayout(
        THREAD_ID,
        JSON.stringify({
          version: 4,
          threadId: THREAD_ID,
          tree: stack("old-terminal", {
            panelInstanceId: "old-terminal",
            kind: "terminal",
            threadId: THREAD_ID,
            terminalId: "terminal-1",
            producerId: producerIdFor("terminal-1"),
          } as never),
        }),
      ),
    ).toBe(defaultPanelLayout);
  });

  it("rejects duplicate nested identities and malformed active state", () => {
    const invalidPanels = [
      terminals([terminalTab("same"), terminalTab("same")]),
      terminals([terminalTab("one")], "missing"),
      terminals([terminalTab("one")], null),
      terminals([], "missing"),
      { ...terminals(), panelInstanceId: "terminal-panel" },
    ];
    for (const panel of invalidPanels) {
      expect(
        deserializePanelLayout(
          THREAD_ID,
          JSON.stringify({
            version: 4,
            threadId: THREAD_ID,
            tree: stack("terminals", panel as PanelInstance),
          }),
        ),
      ).toBe(defaultPanelLayout);
    }
  });
});
