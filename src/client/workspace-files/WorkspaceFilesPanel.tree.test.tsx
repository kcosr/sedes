// @vitest-environment jsdom

// Exercises the real @pierre/trees model and renderer. Pierre reports only
// selection *changes*, which a mocked tree can't reproduce.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import {
  WorkspaceFilesPanel,
  type WorkspaceFilesApi,
} from "./WorkspaceFilesPanel.js";
import { createWorkspaceFilesUiStateCache } from "./workspace-files-ui-state.js";

const chromeActionTargets = new Set<HTMLElement>();

afterEach(() => {
  cleanup();
  for (const target of chromeActionTargets) target.remove();
  chromeActionTargets.clear();
});

function setupApi(): WorkspaceFilesApi {
  return {
    listWorkspaceFileRoots: vi.fn(async () => ({
      roots: [
        {
          kind: "primary" as const,
          rootId: "primary" as const,
          displayLabel: "Workspace",
          sortOrder: 0,
          revision: 0,
          availability: "available" as const,
          watchable: true,
        },
      ],
    })),
    listWorkspaceFileDirectory: vi.fn(
      async (_workspaceId: string, input: { rootId: string; directory?: string }) => ({
        availability: "available" as const,
        rootId: input.rootId,
        directory: input.directory ?? "",
        entries: ["a.ts", "b.ts", "c.ts"].map((path) => ({
          path,
          kind: "file" as const,
        })),
        scanTruncated: false,
      }),
    ),
    readWorkspaceFile: vi.fn(
      async (_workspaceId: string, rootId: string, path: string) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "text" as const,
        content: `// ${path}`,
        sizeBytes: 10,
        revision: `revision-${path}`,
        editable: true,
      }),
    ),
  } as unknown as WorkspaceFilesApi;
}

function setupContext(): WorkspacePanelContext {
  const chromeActionsTarget = document.createElement("div");
  document.body.append(chromeActionsTarget);
  chromeActionTargets.add(chromeActionsTarget);
  const applicationState = {
    snapshot: {
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "environment-1",
          projectId: "project-1",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace" },
          available: true,
        },
      ],
      environments: [],
      threads: [],
    },
  };
  return {
    workspaceId: "workspace-1",
    workspaceLabel: "Sedes",
    applicationStore: {
      api: {},
      transport: { subscribeWorkspaceFiles: vi.fn() },
      subscribe: () => () => undefined,
      getSnapshot: () => applicationState,
    },
    threadRegistry: {},
    host: {
      close: vi.fn(),
      consumeIntent: vi.fn(),
      setBusy: vi.fn(),
      setDirty: vi.fn(),
      setSubtitle: vi.fn(),
    },
    presentation: "dock",
    chromeActionsTarget,
    visible: true,
  } as unknown as WorkspacePanelContext;
}

function treeRow(path: string): HTMLElement | null {
  return (
    document
      .querySelector(".workspace-files-tree-host")
      ?.shadowRoot?.querySelector<HTMLElement>(
        `[role="treeitem"][data-item-path="${path}"]`,
      ) ?? null
  );
}

async function findTreeRow(path: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = treeRow(path);
    expect(row).not.toBeNull();
    return row!;
  });
}

function treeToggle(): HTMLElement {
  return screen.getByRole("button", { name: "Toggle file browser" });
}

function openTree(): void {
  if (treeToggle().getAttribute("aria-expanded") !== "true")
    fireEvent.click(treeToggle());
  expect(treeToggle()).toHaveAttribute("aria-expanded", "true");
}

function openTabNames(): string[] {
  const tabs = screen.queryByRole("tablist", { name: "Open files" });
  return tabs
    ? within(tabs)
        .queryAllByRole("tab")
        .map((tab) => tab.getAttribute("title") ?? "")
    : [];
}

async function expectOpenDocument(path: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("file-viewer")).toHaveTextContent(path),
  );
}

async function settle(): Promise<void> {
  // Pierre renders through Preact's asynchronous queue.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPanel() {
  return render(
    <WorkspaceFilesPanel
      context={setupContext()}
      api={setupApi()}
      uiStateCache={createWorkspaceFilesUiStateCache()}
      renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
    />,
  );
}

describe("WorkspaceFilesPanel with the real file tree", () => {
  it("keeps the tree selection on the active document so any other file opens", async () => {
    renderPanel();
    fireEvent.click(await findTreeRow("a.ts"));
    await expectOpenDocument("a.ts");
    expect(treeToggle()).toHaveAttribute("aria-expanded", "false");

    openTree();
    fireEvent.click(await findTreeRow("b.ts"));
    await expectOpenDocument("b.ts");

    // Activating a tab moves the tree selection with it. Before, the tree
    // still had b.ts selected, so choosing b.ts again emitted nothing.
    fireEvent.click(screen.getByRole("tab", { name: /^a\.ts/ }));
    await expectOpenDocument("a.ts");
    await settle();
    expect(treeRow("a.ts")).toHaveAttribute("aria-selected", "true");
    expect(treeRow("b.ts")).toHaveAttribute("aria-selected", "false");

    openTree();
    fireEvent.click(await findTreeRow("b.ts"));
    await expectOpenDocument("b.ts");

    // Closing the active tab clears the selection, so b.ts can be reopened.
    fireEvent.click(screen.getByRole("button", { name: "Close b.ts" }));
    await expectOpenDocument("a.ts");
    openTree();
    fireEvent.click(await findTreeRow("b.ts"));
    await expectOpenDocument("b.ts");
    expect(openTabNames()).toEqual(["a.ts", "b.ts"]);

    // Choosing the active document again is a no-op.
    openTree();
    fireEvent.click(await findTreeRow("b.ts"));
    await settle();
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("b.ts");
    expect(openTabNames()).toEqual(["a.ts", "b.ts"]);
  });

  it("never opens a file from a Ctrl, Cmd, or Shift multi-selection", async () => {
    renderPanel();
    fireEvent.click(await findTreeRow("a.ts"));
    await expectOpenDocument("a.ts");

    openTree();
    fireEvent.click(await findTreeRow("c.ts"), { ctrlKey: true });
    await settle();
    // Deselecting the active file leaves c.ts as the only selection; that
    // must not open it either.
    fireEvent.click(await findTreeRow("a.ts"), { metaKey: true });
    await settle();
    fireEvent.click(await findTreeRow("b.ts"), { shiftKey: true });
    await settle();
    expect(openTabNames()).toEqual(["a.ts"]);
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("a.ts");

    // A plain click still opens the file it selects.
    fireEvent.click(await findTreeRow("c.ts"));
    await expectOpenDocument("c.ts");
    expect(openTabNames()).toEqual(["a.ts", "c.ts"]);
  });
});
