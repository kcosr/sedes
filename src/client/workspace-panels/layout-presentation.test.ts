import { describe, expect, it } from "vitest";
import type { PanelInstanceId, SplitNode, TabStackNode } from "./layout-tree.js";
import { projectPanelLayout } from "./layout-presentation.js";

const chat: TabStackNode = {
  kind: "tabs",
  id: "chat-stack",
  tabs: [{ kind: "chat", panelInstanceId: "chat" }],
  activePanelInstanceId: "chat",
};
const tools: TabStackNode = {
  kind: "tabs",
  id: "tools-stack",
  tabs: [
    { kind: "files", panelInstanceId: "workspace-files" },
    {
      kind: "terminals",
      threadId: "thread-1",
      panelInstanceId: "terminals",
      tabs: [
        {
          terminalId: "terminal-1",
          producerId: "00000000-0000-4000-8000-000000000001",
        },
        {
          terminalId: "terminal-2",
          producerId: "00000000-0000-4000-8000-000000000002",
        },
      ],
      activeTerminalId: "terminal-2",
    },
  ],
  activePanelInstanceId: "workspace-files",
};
const tree: SplitNode = {
  kind: "split",
  id: "root",
  orientation: "row",
  children: [chat, tools],
  sizes: [0.63, 0.37],
};

function collapsed(...ids: PanelInstanceId[]): ReadonlySet<PanelInstanceId> {
  return new Set(ids);
}

describe("panel instance layout presentation", () => {
  it("returns the canonical tree by identity when nothing is collapsed", () => {
    expect(projectPanelLayout(tree, collapsed())).toBe(tree);
  });

  it("removes an empty stack while preserving the canonical tree", () => {
    const serialized = JSON.stringify(tree);
    expect(projectPanelLayout(tree, collapsed("chat"))).toBe(tools);
    expect(JSON.stringify(tree)).toBe(serialized);
  });

  it("selects a surviving tab when the canonical active tab is collapsed", () => {
    expect(projectPanelLayout(tools, collapsed("workspace-files"))).toEqual({
      ...tools,
      tabs: [tools.tabs[1]],
      activePanelInstanceId: "terminals",
    });
  });

  it("projects null when every instance is collapsed", () => {
    expect(
      projectPanelLayout(
        tree,
        collapsed("chat", "workspace-files", "terminals"),
      ),
    ).toBeNull();
  });
});
