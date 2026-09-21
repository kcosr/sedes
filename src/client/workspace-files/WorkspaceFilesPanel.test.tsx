// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/ApiClient.js";
import {
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  workspaceFileLinkedWorktreeRootIdSchema,
} from "../../shared/index.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import type { WorkspaceFilesApi } from "./WorkspaceFilesPanel.js";

let selectPaths: (paths: readonly string[]) => void = () => undefined;
let fileTreeUnsafeCss: string | undefined;
let latestCompareProps: Record<string, unknown> | undefined;
const resetPaths = vi.fn();
const setGitStatus = vi.fn();
const getItem = vi.fn<
  (_path: string) => { isDirectory(): boolean; isExpanded(): boolean } | null
>(() => null);
const chromeActionTargets = new Set<HTMLElement>();

vi.mock("@pierre/trees", () => ({
  prepareFileTreeInput: (paths: readonly string[]) => ({ paths }),
}));

vi.mock("../components/conversation/MarkdownContent.js", () => ({
  MarkdownContent: ({ children }: { children: string }) => (
    <div data-testid="markdown-preview">{children}</div>
  ),
}));

vi.mock("@pierre/trees/react", () => ({
  useFileTree: (options: {
    onSelectionChange(paths: readonly string[]): void;
    unsafeCSS?: string;
  }) => {
    selectPaths = (paths) => options.onSelectionChange(paths);
    fileTreeUnsafeCss = options.unsafeCSS;
    return {
      model: {
        resetPaths,
        setGitStatus,
        getItem,
        subscribe: () => () => undefined,
      },
    };
  },
  FileTree: () => <div data-testid="file-tree" />,
}));

vi.mock("./WorkspaceCompareView.js", () => ({
  WorkspaceCompareView: (props: Record<string, unknown>) => {
    latestCompareProps = props;
    return (
      <div data-testid="compare-view">
        {props.reviewControls as ReactNode}
        <label>
          Retained compare filter
          <input aria-label="Retained compare filter" />
        </label>
      </div>
    );
  },
}));

import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel.js";
import { NavigationScopeContext } from "../authentication/AuthenticationGate.js";
import { workspaceCompareStorage } from "./workspace-compare-storage.js";
import { TREE_TRUNCATION_CSS } from "./tree-truncation-css.js";
import {
  createWorkspaceFilesUiStateCache,
  WORKSPACE_FILES_UI_STATE_VERSION,
  workspaceFilesUiStateCache,
} from "./workspace-files-ui-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function openFileTabs(): HTMLElement[] {
  const tabList = screen.queryByRole("tablist", { name: "Open files" });
  return tabList ? within(tabList).queryAllByRole("tab") : [];
}

afterEach(() => {
  cleanup();
  for (const frame of document.querySelectorAll(
    ".workspace-file-download-frame",
  )) {
    frame.remove();
  }
  for (const target of chromeActionTargets) target.remove();
  chromeActionTargets.clear();
  workspaceFilesUiStateCache.clear();
  fileTreeUnsafeCss = undefined;
  latestCompareProps = undefined;
  vi.clearAllMocks();
});

function setupApi(overrides: Partial<WorkspaceFilesApi> = {}) {
  return {
    browseExecutionEnvironmentDirectories: vi.fn(async () => ({
      location: { kind: "roots" as const },
      entries: [],
      truncated: false,
    })),
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
    attachWorkspaceFileRoot: vi.fn(),
    removeWorkspaceFileRoot: vi.fn(),
    listWorkspaceFiles: vi.fn(async (_workspaceId: string, input) => ({
      availability: "available" as const,
      rootId: input.rootId,
      entries: ["README.md", "src/index.ts"],
      scanTruncated: false,
    })),
    listWorkspaceFileDirectory: vi.fn(async (_workspaceId: string, input) => ({
      availability: "available" as const,
      rootId: input.rootId,
      directory: input.directory ?? "",
      entries:
        input.directory === "src"
          ? [{ path: "src/index.ts", kind: "file" as const }]
          : [
              { path: "README.md", kind: "file" as const },
              { path: "src", kind: "directory" as const },
            ],
      scanTruncated: false,
    })),
    readWorkspaceFile: vi.fn(
      async (_workspaceId: string, rootId, path: string) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "text" as const,
        content: "export const answer = 42;",
        sizeBytes: 25,
        revision: "revision-1",
        editable: true,
      }),
    ),
    prepareWorkspaceFileDownload: vi.fn(async () => ({
      url: "/api/workspaces/workspace-1/files/download?prepared=1",
      serverOrigin: "http://localhost",
      contentDisposition: 'attachment; filename="index.ts"',
      contentLength: 25,
      revision: "revision-1",
    })),
    saveWorkspaceFile: vi.fn(async (_workspaceId: string, request) => ({
      availability: "available" as const,
      rootId: request.rootId,
      path: request.path,
      sizeBytes: new TextEncoder().encode(request.content).byteLength,
      revision: "revision-2",
    })),
    listWorkspaceDiffRepositories: vi.fn(async () => ({
      status: "available" as const,
      repositories: [],
    })),
    listWorkspaceDiffRefs: vi.fn(),
    createWorkspaceDiffComparison: vi.fn(),
    listWorkspaceDiffChangedFiles: vi.fn(),
    readWorkspaceDiffPatch: vi.fn(),
    readWorkspaceDiffFileContent: vi.fn(),
    listWorkspaceDiffReviews: vi.fn(async () => ({ reviews: [] })),
    listWorkspaceDiffReviewHistory: vi.fn(async () => ({ reviews: [] })),
    openWorkspaceDiffReview: vi.fn(
      async (
        workspaceId: string,
        rootId: string,
        request: {
          title?: string;
          summary?: string;
        },
      ) => ({
        id: "00000000-0000-4000-8000-000000000001",
        workspaceId,
        rootId,
        title: request.title ?? "",
        summary: request.summary ?? "",
        state: "open" as const,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    updateWorkspaceDiffReview: vi.fn(
      async (
        reviewId: string,
        request: {
          title: string;
          summary: string;
          state: "open" | "archived";
        },
      ) => ({
        id: reviewId,
        workspaceId: "workspace-1",
        rootId: "primary" as const,
        title: request.title,
        summary: request.summary,
        state: request.state,
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      }),
    ),
    listWorkspaceDiffReviewComments: vi.fn(async () => ({ comments: [] })),
    createWorkspaceDiffReviewComment: vi.fn(
      async (
        _workspaceId: string,
        _rootId: string,
        reviewId: string,
        request: {
          side: "old" | "new";
          startLine: number;
          endLine: number;
          body: string;
          state?: "draft" | "published";
        },
      ) => ({
        review: {
          id: reviewId,
          workspaceId: "workspace-1",
          rootId: "primary" as const,
          title: "",
          summary: "",
          state: "open" as const,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        comment: {
          id: "00000000-0000-4000-8000-000000000002",
          reviewId,
          fileIdentity: "src/file.ts\0src/file.ts",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          side: request.side,
          startLine: request.startLine,
          endLine: request.endLine,
          selectedText: request.body,
          body: request.body,
          state: request.state ?? "published",
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
        },
      }),
    ),
    updateWorkspaceDiffReviewComment: vi.fn(
      async (
        reviewId: string,
        commentId: string,
        request: {
          body: string;
          state: "draft" | "published" | "resolved" | "outdated" | "unplaced";
        },
      ) => ({
        review: {
          id: reviewId,
          workspaceId: "workspace-1",
          rootId: "primary" as const,
          title: "",
          summary: "",
          state: "open" as const,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        comment: {
          id: commentId,
          reviewId,
          fileIdentity: "src/file.ts\0src/file.ts",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          side: "new" as const,
          startLine: 4,
          endLine: 4,
          selectedText: request.body,
          body: request.body,
          state: request.state,
          revision: 2,
          createdAt: 2,
          updatedAt: 3,
        },
      }),
    ),
    deleteWorkspaceDiffReviewComment: vi.fn(
      async (reviewId: string, commentId: string) => ({
        review: {
          id: reviewId,
          workspaceId: "workspace-1",
          rootId: "primary" as const,
          title: "",
          summary: "",
          state: "open" as const,
          revision: 3,
          createdAt: 1,
          updatedAt: 3,
        },
        comment: {
          id: commentId,
          reviewId,
          fileIdentity: "src/file.ts\0src/file.ts",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          side: "new" as const,
          startLine: 1,
          endLine: 1,
          selectedText: "",
          body: "",
          state: "resolved" as const,
          revision: 2,
          createdAt: 2,
          updatedAt: 3,
        },
      }),
    ),
    listWorkspaceDiffReviewedFiles: vi.fn(async () => ({ files: [] })),
    setWorkspaceDiffReviewedFile: vi.fn(
      async (
        _workspaceId: string,
        _rootId: string,
        reviewId: string,
        request: { fileId: string; reviewed: boolean },
      ) => ({
        review: {
          id: reviewId,
          workspaceId: "workspace-1",
          rootId: "primary" as const,
          title: "",
          summary: "",
          state: "open" as const,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        file: {
          reviewId,
          fileIdentity: request.fileId,
          filePath: request.fileId,
          contentFingerprint: "fingerprint_1234567890abcdef",
          reviewed: request.reviewed,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
        },
      }),
    ),
    ...overrides,
  } as WorkspaceFilesApi;
}

function setupContext(
  options: {
    readonly threadId?: string;
    readonly preferredRootId?: ReturnType<
      typeof workspaceFileLinkedWorktreeRootIdSchema.parse
    > | null;
    readonly preferredRootRevision?: number;
  } = {},
) {
  const closeWorkspaceFiles = vi.fn();
  const subscribeWorkspaceFiles = vi.fn(
    (_workspaceId: string, _input: { readonly onInvalidate: () => void }) => {
      return { close: closeWorkspaceFiles };
    },
  );
  const host = {
    close: vi.fn(),
    consumeIntent: vi.fn(),
    setBusy: vi.fn(),
    setDirty: vi.fn(),
    setSubtitle: vi.fn(),
  };
  const chromeActionsTarget = document.createElement("div");
  document.body.append(chromeActionsTarget);
  chromeActionTargets.add(chromeActionsTarget);
  const applicationState = {
    snapshot: {
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "environment-1",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace" },
          available: true,
        },
      ],
      environments: [
        {
          id: "environment-1",
          kind: "local",
          label: { text: "Local" },
          available: true,
          directoryBrowsing: "available",
        },
      ],
      threads: options.threadId
        ? [
            {
              id: options.threadId,
              preferredWorktreeRevision: options.preferredRootRevision ?? 0,
              preferredWorktree: options.preferredRootId
                ? {
                    rootId: options.preferredRootId,
                    displayLabel: "Preferred worktree",
                    branch: null,
                    availability: "available",
                  }
                : null,
            },
          ]
        : [],
    },
  };
  const context = {
    ...(options.threadId ? { threadId: options.threadId } : {}),
    workspaceId: "workspace-1",
    workspaceLabel: "Sedes",
    applicationStore: {
      api: {},
      transport: { subscribeWorkspaceFiles },
      subscribe: () => () => undefined,
      getSnapshot: () => applicationState,
    },
    threadRegistry: {},
    host,
    presentation: "dock",
    chromeActionsTarget,
    visible: true,
  } as unknown as WorkspacePanelContext;
  return {
    context,
    host,
    subscribeWorkspaceFiles,
    closeWorkspaceFiles,
  };
}

function fileBrowser(): HTMLElement {
  return screen.getByRole("complementary", { name: "File browser" });
}

async function waitForListing(api: WorkspaceFilesApi): Promise<void> {
  await waitFor(() =>
    expect(api.listWorkspaceFileDirectory).toHaveBeenCalled(),
  );
  const loadFullTree = screen.queryByRole("button", {
    name: "Load full tree to search",
  });
  const previousFullScans = vi.mocked(api.listWorkspaceFiles).mock.calls.length;
  if (loadFullTree) {
    fireEvent.click(loadFullTree);
    await waitFor(() =>
      expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(
        previousFullScans + 1,
      ),
    );
  } else {
    await waitFor(() => expect(api.listWorkspaceFiles).toHaveBeenCalled());
  }
  // Wait until the panel leaves the loading state so deferred restore/prune has
  // run before tests open files through the tree selection mock.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled(),
  );
  await act(async () => {
    await Promise.resolve();
  });
}

describe("WorkspaceFilesPanel", () => {
  it("explains when a saved root is missing and keeps available roots usable", async () => {
    const scope = "missing-root-recovery";
    workspaceCompareStorage.set(scope, "workspace-1", "removed-root", { mode: "compare" });
    const api = setupApi();
    const { context } = setupContext();
    render(
      <NavigationScopeContext.Provider value={scope}>
        <WorkspaceFilesPanel context={context} api={api} />
      </NavigationScopeContext.Provider>,
    );

    expect(await screen.findByText("The previously selected Files root is unavailable. Choose an available root.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh workspace files" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss root recovery notice" }));
    expect(screen.queryByText("The previously selected Files root is unavailable. Choose an available root.")).not.toBeInTheDocument();
  });

  it("can regain a workspace after initially rendering without one", async () => {
    const api = setupApi();
    const first = setupContext();
    const withoutWorkspace = {
      ...first.context,
      workspaceId: undefined,
    } as WorkspacePanelContext;
    const { rerender } = render(
      <WorkspaceFilesPanel context={withoutWorkspace} api={api} />,
    );

    expect(screen.getByText("No workspace is available.")).toBeVisible();

    rerender(<WorkspaceFilesPanel context={first.context} api={api} />);

    await waitForListing(api);
    expect(first.subscribeWorkspaceFiles).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled();
  });

  it("always normalizes Pierre file-name truncation", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);

    await waitForListing(api);
    expect(fileTreeUnsafeCss).toBe(TREE_TRUNCATION_CSS);
  });

  it("loads paths on explicit request without requesting Git status", async () => {
    const api = setupApi();
    const { context, host } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path, content, revision }) => (
          <div data-testid="file-viewer">
            {path}|{content}|{revision}
          </div>
        )}
      />,
    );

    await waitForListing(api);
    const toolbarActions = screen
      .getByRole("button", { name: "Refresh workspace files" })
      .closest(".workspace-files-toolbar-actions");
    expect(
      [...(toolbarActions?.querySelectorAll("button") ?? [])].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      null,
      null,
      "Toggle file browser",
      "Add folder to Files",
      "Refresh workspace files",
    ]);
    const addFolder = screen.getByRole("button", {
      name: "Add folder to Files",
    });
    expect(addFolder).toHaveTextContent("");
    expect(addFolder.querySelector("svg")).not.toBeNull();
    expect(document.querySelector(".workspace-files-toolbar")).toBeNull();
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith({
        preparedInput: { paths: ["README.md", "src/index.ts"] },
      }),
    );

    act(() => selectPaths(["src/", "src/index.ts"]));
    await waitFor(() =>
      expect(api.readWorkspaceFile).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        "src/index.ts",
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/index.ts|export const answer = 42;|revision-1",
    );
    expect(host.setSubtitle).toHaveBeenCalledWith("Sedes");
  });

  it("preflights the displayed revision before starting a browser download", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => <div>{content}</div>}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    const download = await screen.findByRole("button", {
      name: "Download saved file src/index.ts",
    });
    const edit = screen.getByRole("button", { name: "Edit" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(download).toHaveTextContent("");
    expect(download).toHaveAttribute("title", "Download saved file");
    expect(edit).toHaveTextContent("");
    expect(edit).toHaveAttribute("title", "Edit file");
    expect(save).toHaveTextContent("");
    expect(save).toHaveAttribute("title", "Save file");
    fireEvent.click(download);

    await waitFor(() =>
      expect(api.prepareWorkspaceFileDownload).toHaveBeenCalledWith(
        "workspace-1",
        {
          rootId: "primary",
          path: "src/index.ts",
          expectedRevision: "revision-1",
          signal: expect.any(AbortSignal),
        },
      ),
    );
    await waitFor(() =>
      expect(
        document.querySelector<HTMLIFrameElement>(
          ".workspace-file-download-frame",
        )?.src,
      ).toContain("prepared=1"),
    );
  });

  it("announces download phases and surfaces a same-origin GET error", async () => {
    const prepared =
      deferred<
        Awaited<ReturnType<WorkspaceFilesApi["prepareWorkspaceFileDownload"]>>
      >();
    const api = setupApi({
      prepareWorkspaceFileDownload: vi.fn(() => prepared.promise),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => <div>{content}</div>}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Download saved file src/index.ts",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Preparing download for saved file src/index.ts",
      }),
    ).toHaveAttribute("aria-busy", "true");

    prepared.resolve({
      url: "/api/workspaces/workspace-1/files/download?prepared=error",
      serverOrigin: "http://localhost",
      contentDisposition: 'attachment; filename="index.ts"',
      contentLength: 25,
      revision: "revision-1",
    });
    expect(
      await screen.findByRole("button", {
        name: "Downloading saved file src/index.ts",
      }),
    ).toHaveAttribute("aria-busy", "true");

    const frame = document.querySelector<HTMLIFrameElement>(
      ".workspace-file-download-frame",
    );
    expect(frame).not.toBeNull();
    const frameDocument = frame!.contentDocument!;
    const frameBody = frameDocument.createElement("body");
    frameBody.textContent = JSON.stringify({
      error: {
        code: "workspace_file_revision_conflict",
        message: "The file changed on disk. Refresh it before downloading.",
        retryable: false,
      },
    });
    const frameRoot =
      frameDocument.documentElement ??
      frameDocument.appendChild(frameDocument.createElement("html"));
    frameRoot.append(frameBody);
    frame!.dispatchEvent(new Event("load"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file changed on disk. Refresh it before downloading.",
    );
    expect(
      screen.getByRole("button", {
        name: "Download saved file src/index.ts",
      }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("confirms that a dirty editor downloads the saved version", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ onChange }) => (
          <button type="button" onClick={() => onChange("unsaved draft")}>
            Change draft
          </button>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change draft" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Download saved file src/index.ts",
      }),
    );

    expect(api.prepareWorkspaceFileDownload).not.toHaveBeenCalled();
    expect(screen.getByText("Download saved version?")).toBeVisible();
    expect(
      screen.getByText(/download will contain the version currently saved/i),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Download saved version" }),
    );

    await waitFor(() =>
      expect(api.prepareWorkspaceFileDownload).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({ expectedRevision: "revision-1" }),
      ),
    );
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("keeps the viewer available when download preflight fails", async () => {
    const prepareWorkspaceFileDownload = vi.fn(async () => {
      throw new Error(
        "The file changed on disk. Refresh it before downloading.",
      );
    });
    const api = setupApi({ prepareWorkspaceFileDownload });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => <div>{content}</div>}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    const download = await screen.findByRole("button", {
      name: "Download saved file src/index.ts",
    });
    fireEvent.click(download);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file changed on disk. Refresh it before downloading.",
    );
    expect(download).toBeEnabled();
  });

  it("does not download while the saved version is being replaced", async () => {
    const saving =
      deferred<Awaited<ReturnType<WorkspaceFilesApi["saveWorkspaceFile"]>>>();
    const api = setupApi({ saveWorkspaceFile: vi.fn(() => saving.promise) });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ onChange }) => (
          <button type="button" onClick={() => onChange("new content")}>
            Change draft
          </button>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change draft" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(
      screen.getByRole("button", {
        name: "Download saved file src/index.ts",
      }),
    ).toBeDisabled();
    saving.resolve({
      availability: "available",
      rootId: "primary",
      path: "src/index.ts",
      sizeBytes: 11,
      revision: "revision-2",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Download saved file src/index.ts",
        }),
      ).toBeEnabled(),
    );
  });

  it.each([
    {
      label: "binary",
      file: {
        availability: "available" as const,
        rootId: "primary" as const,
        path: "src/index.ts",
        contentKind: "binary" as const,
        content: "" as const,
        sizeBytes: 7,
        revision: "revision-1",
        editable: false as const,
      },
    },
    {
      label: "oversized image",
      file: {
        availability: "available" as const,
        rootId: "primary" as const,
        path: "src/index.ts",
        contentKind: "image" as const,
        previewState: "too_large" as const,
        mediaType: "image/png" as const,
        sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
        revision: "revision-1",
        editable: false as const,
      },
    },
  ])("offers exact download for a $label file", async ({ file }) => {
    const api = setupApi({ readWorkspaceFile: vi.fn(async () => file) });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);

    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));

    expect(
      await screen.findByRole("button", {
        name: "Download saved file src/index.ts",
      }),
    ).toBeEnabled();
  });

  it("keeps Browse and Compare state mounted while switching modes", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    await screen.findByTestId("file-viewer");

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const compare = screen.getByTestId("compare-view");
    fireEvent.change(screen.getByLabelText("Retained compare filter"), {
      target: { value: "src/" },
    });
    expect(
      compare.closest(".workspace-files-compare-surface"),
    ).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("file-viewer").closest("main")).toHaveAttribute(
      "hidden",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
    expect(
      screen.getByTestId("file-viewer").closest("main"),
    ).not.toHaveAttribute("hidden");
    expect(compare.closest(".workspace-files-compare-surface")).toHaveAttribute(
      "hidden",
    );
    expect(screen.getByLabelText("Retained compare filter")).toHaveValue(
      "src/",
    );
    expect(
      screen.getByRole("button", { name: "Toggle file browser" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the file tree when Browse has no open document", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);

    const treeToggle = screen.getByRole("button", {
      name: "Toggle file browser",
    });
    expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(treeToggle);
    expect(treeToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }));

    expect(treeToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("discloses that dirty Browse drafts are excluded without saving them", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ onChange }) => (
          <button type="button" onClick={() => onChange("unsaved draft")}>
            Change draft
          </button>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/", "src/index.ts"]));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change draft" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    expect(
      screen.getByText(
        "Unsaved Browse drafts are excluded from this comparison.",
      ),
    ).toBeVisible();
    expect(api.saveWorkspaceFile).not.toHaveBeenCalled();
  });

  it("binds Compare requests to the panel workspace and active Files root", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    const dataSource = latestCompareProps?.dataSource as {
      listRepositories(rootId: string, signal?: AbortSignal): Promise<unknown>;
      listRevisions(
        repositoryId: string,
        signal?: AbortSignal,
      ): Promise<unknown>;
    };
    const controller = new AbortController();
    await dataSource.listRepositories("primary", controller.signal);
    expect(api.listWorkspaceDiffRepositories).toHaveBeenCalledWith(
      "workspace-1",
      "primary",
      controller.signal,
    );
    await dataSource.listRevisions("repository-1", controller.signal);
    expect(api.listWorkspaceDiffRefs).toHaveBeenCalledWith(
      "workspace-1",
      "primary",
      { repositoryId: "repository-1", pageSize: 200 },
      controller.signal,
    );
  });

  it("stages exact Compare line context through the active workspace composer", async () => {
    const api = setupApi();
    const { context } = setupContext();
    const workspaceId = "10000000-0000-4000-8000-000000000001";
    const stage = vi.fn(() => ({ ok: true as const }));
    const scopedContext = {
      ...context,
      workspaceId,
      contextExcerpts: {
        threadId: "thread-1",
        workspaceId,
        getSnapshot: () => ({ available: true }),
        subscribe: () => () => undefined,
        stage,
        attachAndSubmit: vi.fn(() => ({ ok: true as const })),
        stageTaskReference: vi.fn(() => ({ ok: true as const })),
      },
    } as WorkspacePanelContext;
    render(<WorkspaceFilesPanel context={scopedContext} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
    });
    const result = (
      latestCompareProps?.onAttachSelection as (value: unknown) => unknown
    )({
      comparison,
      file: {
        fileId: "file_1234567890abcdef",
        changeKind: "modified",
        oldPath: "src/file.ts",
        newPath: "src/file.ts",
        binary: false,
      },
      range: { start: 4, end: 5, side: "additions" },
      captured: {
        excerpt: "+first\n+second\n",
        start: { side: "new", line: 4 },
        end: { side: "new", line: 5 },
      },
      note: "Review this",
    });

    expect(result).toEqual({ ok: true });
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        excerpt: "+first\n+second\n",
        note: "Review this",
        source: expect.objectContaining({
          kind: "workspace_diff",
          workspaceId,
          rootId: "primary",
          comparisonId: comparison.comparisonId,
          fileId: "file_1234567890abcdef",
        }),
        locator: {
          kind: "diff_line_range",
          start: { side: "new", line: 4 },
          end: { side: "new", line: 5 },
        },
      }),
    );
  });

  it.each([["opening", false], ["marking", false], ["opening", true], ["marking", true]] as const)("fences reviewed-file mutations while %s across comparison changes (return=%s)", async (phase, returnToOriginal) => {
    const pending = deferred<void>();
    const api = setupApi();
    const open = api.openWorkspaceDiffReview;
    const mark = api.setWorkspaceDiffReviewedFile;
    if (phase === "opening") api.openWorkspaceDiffReview = vi.fn(async (...args: Parameters<WorkspaceFilesApi["openWorkspaceDiffReview"]>) => { const value = await open(...args); await pending.promise; return value; });
    else api.setWorkspaceDiffReviewedFile = vi.fn(async (...args: Parameters<WorkspaceFilesApi["setWorkspaceDiffReviewedFile"]>) => { const value = await mark(...args); await pending.promise; return value; });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const comparison = { comparisonId: "comparison-first", repositoryId: "repository-one", mode: "direct", base: { kind: "revision", revisionId: "revision-main", commitHash: "a".repeat(40), label: "main" }, head: { kind: "working_tree" }, fingerprint: "fingerprint-first" };
    const file = { fileId: "file-first", changeKind: "modified", oldPath: "same.ts", newPath: "same.ts", binary: false };
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(comparison);
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([file]);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled());
    act(() => { (latestCompareProps?.onReviewedChange as (fileId: string, value: boolean) => void)(file.fileId, true); });
    await waitFor(() => expect(phase === "opening" ? api.openWorkspaceDiffReview : api.setWorkspaceDiffReviewedFile).toHaveBeenCalledOnce());
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)({ ...comparison, comparisonId: "comparison-second", fingerprint: "fingerprint-second" });
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([{ ...file, fileId: "file-second" }]);
    });
    if (returnToOriginal) act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(comparison);
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([file]);
    });
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(latestCompareProps?.reviewedFileIds).toEqual(new Set());
    expect(latestCompareProps?.annotations).toEqual([]);
    if (phase === "opening") expect(api.setWorkspaceDiffReviewedFile).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Start review" })).toBeEnabled();
  });

  it("locks comment edits during save and retains the draft if its comparison changes", async () => {
    const pending = deferred<void>();
    const api = setupApi();
    const create = api.createWorkspaceDiffReviewComment;
    api.createWorkspaceDiffReviewComment = vi.fn(async (...args: Parameters<WorkspaceFilesApi["createWorkspaceDiffReviewComment"]>) => { const value = await create(...args); await pending.promise; return value; });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const comparison = { comparisonId: "comparison-first", repositoryId: "repository-one", mode: "direct", base: { kind: "revision", revisionId: "revision-main", commitHash: "a".repeat(40), label: "main" }, head: { kind: "working_tree" }, fingerprint: "fingerprint-first" };
    const file = { fileId: "file-first", changeKind: "modified", oldPath: "same.ts", newPath: "same.ts", binary: false };
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(comparison);
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([file]);
      (latestCompareProps?.onCreateAnnotation as (value: unknown) => void)({ comparison, file, range: { start: 1, end: 1, side: "additions" } });
    });
    const input = await screen.findByLabelText("Workspace diff review comment");
    fireEvent.change(input, { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(api.createWorkspaceDiffReviewComment).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(screen.getByLabelText("Workspace diff review comment state")).toBeDisabled();
    act(() => { (latestCompareProps?.onComparisonChange as (value: unknown) => void)({ ...comparison, comparisonId: "comparison-second", fingerprint: "fingerprint-second" }); });
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(screen.getByLabelText("Workspace diff review comment")).toHaveValue("Keep my draft");
    expect(screen.getByLabelText("Workspace diff review comment")).toBeEnabled();
    expect(latestCompareProps?.annotations).toEqual([]);
  });

  it("starts a compare review, saves a comment, and marks a file reviewed", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const file = {
      fileId: "file_1234567890abcdef",
      changeKind: "modified",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      binary: false,
    } as const;
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([file]);
    });

    await waitFor(() =>
      expect(api.listWorkspaceDiffReviews).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        {
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review/i })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /review/i })).toBeVisible();

    act(() => {
      (
        latestCompareProps?.onCreateAnnotation as (value: {
          comparison: typeof comparison;
          file: typeof file;
          range: { start: number; end: number; side: "additions" };
        }) => void
      )({
        comparison,
        file,
        range: { start: 3, end: 4, side: "additions" },
      });
    });
    const reviewComment = screen.getByRole("textbox", {
      name: "Workspace diff review comment",
    });
    fireEvent.change(reviewComment, { target: { value: "Flag this hunk" } });
    expect(reviewComment).toHaveValue("Flag this hunk");
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    await waitFor(() =>
      expect(api.openWorkspaceDiffReview).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        expect.objectContaining({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          title: "Review src/file.ts",
        }),
      ),
    );

    await waitFor(() =>
      expect(api.createWorkspaceDiffReviewComment).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        "00000000-0000-4000-8000-000000000001",
        expect.objectContaining({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          fileId: file.fileId,
          side: "new",
          startLine: 3,
          endLine: 4,
          body: "Flag this hunk",
        }),
      ),
    );

    await act(async () => {
      await (
        latestCompareProps?.onReviewedChange as (
          fileId: string,
          reviewed: boolean,
        ) => Promise<void>
      )(file.fileId, true);
    });
    expect(api.setWorkspaceDiffReviewedFile).toHaveBeenCalledWith(
      "workspace-1",
      "primary",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        comparisonId: comparison.comparisonId,
        fingerprint: comparison.fingerprint,
        fileId: file.fileId,
        reviewed: true,
      }),
    );
  });

  it("hydrates exact review annotations and reviewed files into Compare", async () => {
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const review = {
      id: "00000000-0000-4000-8000-000000000011",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Workspace review",
      summary: "",
      state: "open" as const,
      revision: 3,
      createdAt: 1,
      updatedAt: 3,
    };
    const api = setupApi({
      listWorkspaceDiffReviews: vi.fn(async () => ({ reviews: [review] })),
      listWorkspaceDiffReviewHistory: vi.fn(async () => ({
        reviews: [review],
      })),
      listWorkspaceDiffReviewComments: vi.fn(async () => ({
        comments: [
          {
            id: "00000000-0000-4000-8000-000000000012",
            reviewId: review.id,
            fileIdentity: "src/file.ts\0src/file.ts",
            oldPath: "src/file.ts",
            newPath: "src/file.ts",
            side: "new" as const,
            startLine: 4,
            endLine: 4,
            selectedText: "+new\n",
            body: "Looks good",
            state: "published" as const,
            revision: 2,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      })),
      listWorkspaceDiffReviewedFiles: vi.fn(async () => ({
        files: [
          {
            reviewId: review.id,
            fileIdentity: "src/file.ts\0src/file.ts",
            filePath: "src/file.ts",
            contentFingerprint: "fingerprint_1234567890abcdef",
            reviewed: true,
            revision: 1,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      })),
    });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          binary: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(api.listWorkspaceDiffReviews).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        {
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
        },
      ),
    );
    await waitFor(() =>
      expect(latestCompareProps?.annotations).toEqual([
        expect.objectContaining({
          annotationId: "00000000-0000-4000-8000-000000000012",
          fileId: "file_1234567890abcdef",
          body: "Looks good",
        }),
      ]),
    );
    await waitFor(() =>
      expect(
        (latestCompareProps?.reviewedFileIds as ReadonlySet<string>).has(
          "file_1234567890abcdef",
        ),
      ).toBe(true),
    );

    // Same paths in a new comparison must not inherit this historical review.
    vi.mocked(api.listWorkspaceDiffReviews).mockResolvedValue({ reviews: [] });
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)({
        ...comparison, comparisonId: "comparison_new1234567890", fingerprint: "fingerprint_new1234567890",
      });
    });
    await waitFor(() => expect(screen.getByText("No active review")).toBeVisible());
    expect(latestCompareProps?.annotations).toEqual([]);
    expect((latestCompareProps?.reviewedFileIds as ReadonlySet<string>).size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const historyDialog = await screen.findByRole("dialog", { name: "Review" });
    await waitFor(() => expect(within(historyDialog).getByText("Looks good")).toBeVisible());
    fireEvent.click(within(historyDialog).getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Workspace diff review comment"), { target: { value: "Historical edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(api.updateWorkspaceDiffReviewComment).toHaveBeenCalledWith(
      review.id, "00000000-0000-4000-8000-000000000012", expect.objectContaining({ body: "Historical edit" }),
    ));
    expect(api.openWorkspaceDiffReview).not.toHaveBeenCalled();
  });

  it("keeps inline annotation actions bound to the current review while viewing history details", async () => {
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const currentReview = {
      id: "00000000-0000-4000-8000-000000000101",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Current review",
      summary: "",
      state: "open" as const,
      revision: 7,
      createdAt: 1,
      updatedAt: 7,
    };
    const historyReview = {
      id: "00000000-0000-4000-8000-000000000102",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Archived review",
      summary: "",
      state: "archived" as const,
      revision: 4,
      createdAt: 1,
      updatedAt: 4,
    };
    const currentComment = {
      id: "00000000-0000-4000-8000-000000000103",
      reviewId: currentReview.id,
      fileIdentity: "src/file.ts\0src/file.ts",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      side: "new" as const,
      startLine: 4,
      endLine: 4,
      selectedText: "+new\n",
      body: "Current body",
      state: "published" as const,
      revision: 3,
      createdAt: 2,
      updatedAt: 2,
    };
    const historyComment = {
      ...currentComment,
      id: "00000000-0000-4000-8000-000000000104",
      reviewId: historyReview.id,
      body: "History body",
      revision: 2,
    };
    const api = setupApi({
      listWorkspaceDiffReviews: vi.fn(async () => ({
        reviews: [currentReview],
      })),
      listWorkspaceDiffReviewHistory: vi.fn(async () => ({
        reviews: [historyReview, currentReview],
      })),
      listWorkspaceDiffReviewComments: vi.fn(async (reviewId: string) => ({
        comments:
          reviewId === currentReview.id ? [currentComment] : [historyComment],
      })),
      listWorkspaceDiffReviewedFiles: vi.fn(async () => ({ files: [] })),
      updateWorkspaceDiffReviewComment: vi.fn(
        async (reviewId: string, commentId: string, request) => ({
          review: {
            ...(reviewId === currentReview.id ? currentReview : historyReview),
            revision:
              (reviewId === currentReview.id
                ? currentReview.revision
                : historyReview.revision) + 1,
            updatedAt: 9,
          },
          comment: {
            ...(commentId === currentComment.id
              ? currentComment
              : historyComment),
            reviewId,
            body: request.body,
            state: request.state,
            revision:
              (commentId === currentComment.id
                ? currentComment.revision
                : historyComment.revision) + 1,
            updatedAt: 9,
          },
        }),
      ),
      deleteWorkspaceDiffReviewComment: vi.fn(
        async (reviewId: string, commentId: string) => ({
          review: {
            ...(reviewId === currentReview.id ? currentReview : historyReview),
            revision:
              (reviewId === currentReview.id
                ? currentReview.revision
                : historyReview.revision) + 2,
            updatedAt: 10,
          },
          comment: {
            ...(commentId === currentComment.id
              ? currentComment
              : historyComment),
            reviewId,
            state: "resolved" as const,
            revision:
              (commentId === currentComment.id
                ? currentComment.revision
                : historyComment.revision) + 1,
            updatedAt: 10,
          },
        }),
      ),
    });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          binary: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(latestCompareProps?.annotations).toEqual([
        expect.objectContaining({
          annotationId: currentComment.id,
          body: currentComment.body,
        }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.change(
      await screen.findByLabelText("Historical workspace diff review"),
      {
        target: { value: historyReview.id },
      },
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          /Historical comments belong to their original comparison/,
        ),
      ).toBeVisible(),
    );

    act(() => {
      (
        latestCompareProps?.onSelectAnnotation as (value: {
          annotationId: string;
        }) => void
      )({ annotationId: currentComment.id });
    });

    const editInput = await screen.findByLabelText(
      "Workspace diff review comment",
    );
    expect(editInput).toHaveValue("Current body");
    fireEvent.change(editInput, { target: { value: "Current body updated" } });
    fireEvent.click(screen.getByText("Save comment"));

    await waitFor(() =>
      expect(api.updateWorkspaceDiffReviewComment).toHaveBeenCalledWith(
        currentReview.id,
        currentComment.id,
        expect.objectContaining({
          body: "Current body updated",
          expectedReviewRevision: currentReview.revision,
          expectedCommentRevision: currentComment.revision,
        }),
      ),
    );

    await act(async () => {
      await (
        latestCompareProps?.onDeleteAnnotation as (value: {
          annotationId: string;
        }) => Promise<void>
      )({ annotationId: currentComment.id });
    });

    expect(api.deleteWorkspaceDiffReviewComment).toHaveBeenCalledWith(
      currentReview.id,
      currentComment.id,
      expect.objectContaining({
        expectedReviewRevision: currentReview.revision + 1,
        expectedCommentRevision: currentComment.revision + 1,
      }),
    );
  });

  it("uses the current review CAS when marking reviewed from a history view", async () => {
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const currentReview = {
      id: "00000000-0000-4000-8000-000000000201",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Current review",
      summary: "",
      state: "open" as const,
      revision: 6,
      createdAt: 1,
      updatedAt: 6,
    };
    const historyReview = {
      id: "00000000-0000-4000-8000-000000000202",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "History review",
      summary: "",
      state: "archived" as const,
      revision: 3,
      createdAt: 1,
      updatedAt: 3,
    };
    const api = setupApi({
      listWorkspaceDiffReviews: vi.fn(async () => ({
        reviews: [currentReview],
      })),
      listWorkspaceDiffReviewHistory: vi.fn(async () => ({
        reviews: [historyReview, currentReview],
      })),
      listWorkspaceDiffReviewComments: vi.fn(async () => ({ comments: [] })),
      listWorkspaceDiffReviewedFiles: vi.fn(async (reviewId: string) => ({
        files:
          reviewId === currentReview.id
            ? [
                {
                  reviewId: currentReview.id,
                  fileIdentity: "src/file.ts\0src/file.ts",
                  filePath: "src/file.ts",
                  contentFingerprint: "fingerprint-current",
                  reviewed: false,
                  revision: 7,
                  createdAt: 2,
                  updatedAt: 2,
                },
              ]
            : [
                {
                  reviewId: historyReview.id,
                  fileIdentity: "src/file.ts\0src/file.ts",
                  filePath: "src/file.ts",
                  contentFingerprint: "fingerprint-history",
                  reviewed: true,
                  revision: 2,
                  createdAt: 2,
                  updatedAt: 2,
                },
              ],
      })),
    });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    const file = {
      fileId: "file_1234567890abcdef",
      changeKind: "modified",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      binary: false,
    } as const;
    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([file]);
    });

    await waitFor(() =>
      expect(
        (latestCompareProps?.reviewedFileIds as ReadonlySet<string>).has(
          file.fileId,
        ),
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.change(
      await screen.findByLabelText("Historical workspace diff review"),
      { target: { value: historyReview.id } },
    );

    await waitFor(() =>
      expect(api.listWorkspaceDiffReviewedFiles).toHaveBeenCalledWith(
        currentReview.id,
      ),
    );

    await act(async () => {
      await (
        latestCompareProps?.onReviewedChange as (
          fileId: string,
          reviewed: boolean,
        ) => Promise<void>
      )(file.fileId, true);
    });

    expect(api.setWorkspaceDiffReviewedFile).toHaveBeenCalledWith(
      "workspace-1",
      "primary",
      currentReview.id,
      expect.objectContaining({
        fileId: file.fileId,
        reviewed: true,
        expectedReviewRevision: currentReview.revision,
        expectedFileRevision: 7,
      }),
    );
  });

  it("deletes history comments from the details dialog against the active history review", async () => {
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const currentReview = {
      id: "00000000-0000-4000-8000-000000000301",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Current review",
      summary: "",
      state: "open" as const,
      revision: 7,
      createdAt: 1,
      updatedAt: 7,
    };
    const historyReview = {
      id: "00000000-0000-4000-8000-000000000302",
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      title: "Archived review",
      summary: "",
      state: "archived" as const,
      revision: 4,
      createdAt: 1,
      updatedAt: 4,
    };
    const currentComment = {
      id: "00000000-0000-4000-8000-000000000303",
      reviewId: currentReview.id,
      fileIdentity: "src/file.ts\0src/file.ts",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      side: "new" as const,
      startLine: 4,
      endLine: 4,
      selectedText: "+new\n",
      body: "Current body",
      state: "published" as const,
      revision: 3,
      createdAt: 2,
      updatedAt: 2,
    };
    const historyComment = {
      ...currentComment,
      id: "00000000-0000-4000-8000-000000000304",
      reviewId: historyReview.id,
      body: "History body",
      revision: 2,
    };
    const api = setupApi({
      listWorkspaceDiffReviews: vi.fn(async () => ({
        reviews: [currentReview],
      })),
      listWorkspaceDiffReviewHistory: vi.fn(async () => ({
        reviews: [historyReview, currentReview],
      })),
      listWorkspaceDiffReviewComments: vi.fn(async (reviewId: string) => ({
        comments:
          reviewId === currentReview.id ? [currentComment] : [historyComment],
      })),
      listWorkspaceDiffReviewedFiles: vi.fn(async () => ({ files: [] })),
      deleteWorkspaceDiffReviewComment: vi.fn(
        async (reviewId: string, commentId: string, request) => ({
          review: {
            ...(reviewId === currentReview.id ? currentReview : historyReview),
            revision:
              (reviewId === currentReview.id
                ? currentReview.revision
                : historyReview.revision) + 1,
            updatedAt: 10,
          },
          comment: {
            ...(commentId === currentComment.id
              ? currentComment
              : historyComment),
            reviewId,
            state: "resolved" as const,
            revision:
              (commentId === currentComment.id
                ? currentComment.revision
                : historyComment.revision) + 1,
            updatedAt: 10,
          },
          request,
        }),
      ),
    });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          binary: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(latestCompareProps?.annotations).toEqual([
        expect.objectContaining({
          annotationId: currentComment.id,
          body: currentComment.body,
        }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.change(
      await screen.findByLabelText("Historical workspace diff review"),
      { target: { value: historyReview.id } },
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Historical comments belong to their original comparison/),
      ).toBeVisible(),
    );


    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("History body")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.deleteWorkspaceDiffReviewComment).toHaveBeenCalledWith(
        historyReview.id,
        historyComment.id,
        expect.objectContaining({
          expectedReviewRevision: historyReview.revision,
          expectedCommentRevision: historyComment.revision,
        }),
      ),
    );

    await waitFor(() =>
      expect(
        within(dialog).queryByText("History body"),
      ).not.toBeInTheDocument(),
    );
    expect(latestCompareProps?.annotations).toEqual([
      expect.objectContaining({
        annotationId: currentComment.id,
        body: currentComment.body,
      }),
    ]);
  });

  it("ignores a stale open-review response after switching comparisons", async () => {
    const firstComparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const secondComparison = {
      ...firstComparison,
      comparisonId: "comparison_abcdef1234567890",
      fingerprint: "fingerprint_abcdef1234567890",
    } as const;
    const opening = deferred<{
      id: string;
      workspaceId: string;
      rootId: "primary";
      title: string;
      summary: string;
      state: "open";
      revision: number;
      createdAt: number;
      updatedAt: number;
    }>();
    const api = setupApi({
      openWorkspaceDiffReview: vi
        .fn()
        .mockImplementationOnce(() => opening.promise)
        .mockImplementationOnce(
          async (
            workspaceId: string,
            rootId: "primary",
            request: { title?: string },
          ) => ({
            id: "00000000-0000-4000-8000-000000000302",
            workspaceId,
            rootId,
            title: request.title ?? "Second review",
            summary: "",
            state: "open" as const,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
    });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        firstComparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/first.ts",
          newPath: "src/first.ts",
          binary: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /review/i }));

    await waitFor(() =>
      expect(api.openWorkspaceDiffReview).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        expect.objectContaining({
          comparisonId: firstComparison.comparisonId,
          fingerprint: firstComparison.fingerprint,
        }),
      ),
    );

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        secondComparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_abcdef1234567890",
          changeKind: "modified",
          oldPath: "src/second.ts",
          newPath: "src/second.ts",
          binary: false,
        },
      ]);
    });

    await act(async () => {
      opening.resolve({
        id: "00000000-0000-4000-8000-000000000301",
        workspaceId: "workspace-1",
        rootId: "primary",
        title: "First review",
        summary: "",
        state: "open",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await opening.promise;
    });

    await waitFor(() =>
      expect(screen.getByText("No active review")).toBeVisible(),
    );
    expect(screen.queryByText("First review")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() =>
      expect(api.openWorkspaceDiffReview).toHaveBeenNthCalledWith(
        2,
        "workspace-1",
        "primary",
        expect.objectContaining({
          comparisonId: secondComparison.comparisonId,
          fingerprint: secondComparison.fingerprint,
        }),
      ),
    );
  });

  it("opens a compare review and saves a gutter comment through the review API", async () => {
    const comparison = {
      comparisonId: "comparison_1234567890abcdef",
      repositoryId: "repository_1234567890abcdef",
      mode: "direct",
      base: {
        kind: "revision",
        revisionId: "revision_1234567890abcdef",
        commitHash: "a".repeat(40),
        label: "main",
      },
      head: { kind: "working_tree" },
      fingerprint: "fingerprint_1234567890abcdef",
    } as const;
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    act(() => {
      (latestCompareProps?.onComparisonChange as (value: unknown) => void)(
        comparison,
      );
      (latestCompareProps?.onFilesChange as (value: unknown) => void)([
        {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          binary: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    await waitFor(() =>
      expect(api.openWorkspaceDiffReview).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        expect.objectContaining({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
        }),
      ),
    );

    act(() => {
      (latestCompareProps?.onCreateAnnotation as (value: unknown) => void)({
        comparison,
        file: {
          fileId: "file_1234567890abcdef",
          changeKind: "modified",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          binary: false,
        },
        range: { start: 2, end: 3, side: "additions" },
      });
    });

    fireEvent.change(
      await screen.findByLabelText("Workspace diff review comment"),
      {
        target: { value: "Please double-check this branch." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    await waitFor(() =>
      expect(api.createWorkspaceDiffReviewComment).toHaveBeenCalledWith(
        "workspace-1",
        "primary",
        "00000000-0000-4000-8000-000000000001",
        expect.objectContaining({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          fileId: "file_1234567890abcdef",
          side: "new",
          startLine: 2,
          endLine: 3,
          body: "Please double-check this branch.",
        }),
      ),
    );
  });

  it("keeps identical paths in tabbed roots as independent tabs and documents", async () => {
    const supplementalRootId = "context-root" as never;
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "supplemental" as const,
            rootId: supplementalRootId,
            displayLabel: "Agent context",
            displayPath: { text: "/agent-context" },
            sortOrder: 1,
            revision: 3,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })),
      listWorkspaceFiles: vi.fn(async (_workspaceId, input) => ({
        availability: "available" as const,
        rootId: input.rootId,
        // Explicit open intents may target valid gitignored files that do not
        // appear in the bounded tree listing.
        entries: input.rootId === "primary" ? ["shared.ts"] : [],
        scanTruncated: false,
      })),
      readWorkspaceFile: vi.fn(async (_workspaceId, rootId, path) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "text" as const,
        content:
          rootId === "primary" ? "primary contents" : "supplemental contents",
        sizeBytes: 20,
        revision:
          rootId === "primary" ? "primary-revision" : "supplemental-revision",
        editable: true,
      })),
    });
    const { context, host } = setupContext();
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [{ rootId: "primary", path: "shared.ts" }],
        active: { rootId: "primary", path: "shared.ts" },
      },
      treeOpen: true,
      expandedPathsByRoot: {},
    });
    const primaryIntent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "shared.ts",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 11,
    };
    const view = render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="root-content">{content}</span>
            <button type="button" onClick={() => onChange("primary draft")}>
              Change root file
            </button>
          </div>
        )}
      />,
    );

    expect(await screen.findByTestId("root-content")).toHaveTextContent(
      "primary contents",
    );
    view.rerender(
      <WorkspaceFilesPanel
        context={{
          ...context,
          intent: {
            ...primaryIntent,
            rootId: supplementalRootId,
            sequence: 12,
          },
        }}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="root-content">{content}</span>
            <button type="button" onClick={() => onChange("primary draft")}>
              Change root file
            </button>
          </div>
        )}
      />,
    );
    expect(await screen.findByTestId("root-content")).toHaveTextContent(
      "supplemental contents",
    );
    expect(host.consumeIntent).toHaveBeenCalledWith(12);
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    expect(screen.getAllByRole("tab", { name: /^shared\.ts/ })).toHaveLength(2);
    expect(screen.getAllByTestId("file-tree")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Agent context" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const activeRootTab = screen.getByRole("tab", { name: "Agent context" });
    const activeRootPanel = screen.getByRole("tabpanel", {
      name: "Agent context",
    });
    expect(activeRootTab).toHaveAttribute("aria-controls", activeRootPanel.id);
    expect(activeRootPanel).toHaveAttribute(
      "aria-labelledby",
      activeRootTab.id,
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledWith(
      "workspace-1",
      "primary",
      "shared.ts",
      expect.any(AbortSignal),
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledWith(
      "workspace-1",
      supplementalRootId,
      "shared.ts",
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getAllByRole("tab", { name: /^shared\.ts/ })[0]!);
    expect(screen.getByTestId("root-content")).toHaveTextContent(
      "primary contents",
    );
    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change root file" }));
    expect(screen.getByTestId("root-content")).toHaveTextContent(
      "primary draft",
    );
    fireEvent.click(screen.getAllByRole("tab", { name: /^shared\.ts/ })[1]!);
    expect(screen.getByTestId("root-content")).toHaveTextContent(
      "supplemental contents",
    );
    expect(screen.getByRole("tab", { name: "Agent context" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getAllByRole("img", { name: "Unsaved changes" }),
    ).toHaveLength(1);

    host.consumeIntent.mockImplementationOnce((sequence: number) => {
      if (sequence !== 13) return;
      queueMicrotask(() =>
        view.rerender(
          <WorkspaceFilesPanel
            context={context}
            api={api}
            uiStateCache={uiStateCache}
            renderFile={({ content, onChange }) => (
              <div>
                <span data-testid="root-content">{content}</span>
                <button type="button" onClick={() => onChange("primary draft")}>
                  Change root file
                </button>
              </div>
            )}
          />,
        ),
      );
    });
    view.rerender(
      <WorkspaceFilesPanel
        context={{
          ...context,
          intent: { ...primaryIntent, sequence: 13 },
        }}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="root-content">{content}</span>
            <button type="button" onClick={() => onChange("primary draft")}>
              Change root file
            </button>
          </div>
        )}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("root-content")).toHaveTextContent(
        "primary draft",
      ),
    );
    expect(host.consumeIntent).toHaveBeenCalledWith(13);
  });

  it("keeps an unavailable supplemental root visible without disabling the primary root", async () => {
    const unavailableRootId = "missing-root" as never;
    const listWorkspaceFiles = vi.fn(async (_workspaceId, input) => ({
      availability: "available" as const,
      rootId: input.rootId,
      entries: ["README.md"],
      scanTruncated: false,
    }));
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "supplemental" as const,
            rootId: unavailableRootId,
            displayLabel: "Missing context",
            displayPath: { text: "/missing-context" },
            sortOrder: 1,
            revision: 4,
            availability: "unavailable" as const,
            watchable: false as const,
            diagnosticCode: "workspace_file_root_missing",
          },
        ],
      })),
      listWorkspaceFiles,
    });
    const { context, subscribeWorkspaceFiles } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    await waitForListing(api);
    expect(
      screen.queryByText("Folder unavailable (workspace_file_root_missing)."),
    ).not.toBeInTheDocument();
    const unavailableTab = screen.getByRole("tab", {
      name: /Missing context.*unavailable/iu,
    });
    fireEvent.click(unavailableTab);
    expect(
      await screen.findByText(
        "Folder unavailable (workspace_file_root_missing).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tabpanel", {
        name: /Missing context.*unavailable/iu,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("file-tree")).not.toBeInTheDocument();
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(listWorkspaceFiles).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ rootId: "primary" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getAllByTestId("file-tree")).toHaveLength(1);
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("uses the thread worktree without crowding the root tabs", async () => {
    const linkedRootIds = ["linked-a", "linked-b", "linked-c"].map((id) =>
      workspaceFileLinkedWorktreeRootIdSchema.parse(id),
    );
    const supplementalRootId = "supplemental-notes" as never;
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          ...linkedRootIds.map((rootId, index) => ({
            kind: "linked_worktree" as const,
            rootId,
            displayLabel: `branch-${index + 1}`,
            displayPath: { text: `/worktrees/branch-${index + 1}` },
            branch: `branch-${index + 1}`,
            head: String(index + 1).repeat(40),
            provenance: {
              kind: "unmerged" as const,
              ahead: 1,
              behind: 0,
            },
            removal: { status: "unavailable" as const },
            sortOrder: index + 1,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          })),
          {
            kind: "supplemental" as const,
            rootId: supplementalRootId,
            displayLabel: "Agent notes",
            displayPath: { text: "/agent-notes" },
            sortOrder: 4,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })),
    });
    const { context } = setupContext({
      threadId: "thread-1",
      preferredRootId: linkedRootIds[1],
      preferredRootRevision: 2,
    });
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    expect(
      screen.queryByRole("combobox", { name: /worktree/i }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "branch-2" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(
      screen.queryByRole("tab", { name: "Workspace" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Agent notes" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("tablist", { name: "File roots" }))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["branch-2", "Agent notes"]);
    expect(
      screen.queryByRole("tab", { name: "branch-1" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "branch-3" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "branch-2" }), {
      key: "ArrowRight",
    });
    const supplementalTab = screen.getByRole("tab", { name: "Agent notes" });
    expect(supplementalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      supplementalTab.id,
    );
  });

  it("restores each thread's preferred worktree when switching within one workspace", async () => {
    const firstRootId =
      workspaceFileLinkedWorktreeRootIdSchema.parse("linked-worktree-a");
    const secondRootId =
      workspaceFileLinkedWorktreeRootIdSchema.parse("linked-worktree-b");
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "linked_worktree" as const,
            rootId: firstRootId,
            displayLabel: "branch-a",
            displayPath: { text: "/worktrees/branch-a" },
            branch: "branch-a",
            head: "a".repeat(40),
            provenance: { kind: "unmerged" as const, ahead: 1, behind: 0 },
            removal: { status: "unavailable" as const },
            sortOrder: 1,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "linked_worktree" as const,
            rootId: secondRootId,
            displayLabel: "branch-b",
            displayPath: { text: "/worktrees/branch-b" },
            branch: "branch-b",
            head: "b".repeat(40),
            provenance: { kind: "unmerged" as const, ahead: 1, behind: 0 },
            removal: { status: "unavailable" as const },
            sortOrder: 2,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })),
    });
    const first = setupContext({
      threadId: "thread-a",
      preferredRootId: firstRootId,
      preferredRootRevision: 2,
    });
    const second = setupContext({
      threadId: "thread-b",
      preferredRootId: secondRootId,
      preferredRootRevision: 7,
    });
    const view = render(
      <WorkspaceFilesPanel
        context={first.context}
        api={api}
        renderFile={() => null}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "branch-a" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    view.rerender(
      <WorkspaceFilesPanel
        context={second.context}
        api={api}
        renderFile={() => null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "branch-b" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("keeps the thread preference authoritative over a cached active root", async () => {
    const linkedRootId =
      workspaceFileLinkedWorktreeRootIdSchema.parse("linked-worktree-a");
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: { files: [] },
      treeOpen: true,
      expandedPathsByRoot: {},
    });
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "linked_worktree" as const,
            rootId: linkedRootId,
            displayLabel: "branch-a",
            displayPath: { text: "/worktrees/branch-a" },
            branch: "branch-a",
            head: "a".repeat(40),
            provenance: {
              kind: "unmerged" as const,
              ahead: 1,
              behind: 0,
            },
            removal: { status: "unavailable" as const },
            sortOrder: 1,
            revision: 1,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })),
    });
    const { context } = setupContext({
      threadId: "thread-a",
      preferredRootId: linkedRootId,
      preferredRootRevision: 2,
    });

    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
        uiStateCache={uiStateCache}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "branch-a" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("falls back to Primary when a preferred linked worktree disappears", async () => {
    const linkedRootId = workspaceFileLinkedWorktreeRootIdSchema.parse(
      "linked-worktree-removed",
    );
    const primary = {
      kind: "primary" as const,
      rootId: "primary" as const,
      displayLabel: "Workspace",
      sortOrder: 0,
      revision: 0,
      availability: "available" as const,
      watchable: true,
    };
    const listWorkspaceFileRoots = vi
      .fn()
      .mockResolvedValueOnce({
        roots: [
          primary,
          {
            kind: "linked_worktree" as const,
            rootId: linkedRootId,
            displayLabel: "branch-removed",
            displayPath: { text: "/worktrees/branch-removed" },
            branch: "branch-removed",
            head: "c".repeat(40),
            provenance: {
              kind: "unmerged" as const,
              ahead: 1,
              behind: 0,
            },
            removal: { status: "unavailable" as const },
            sortOrder: 1,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })
      .mockResolvedValue({ roots: [primary] });
    const api = setupApi({ listWorkspaceFileRoots });
    const { context } = setupContext({
      threadId: "thread-1",
      preferredRootId: linkedRootId,
      preferredRootRevision: 3,
    });
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "branch-removed" }),
      ).toHaveAttribute("aria-selected", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(
      screen.queryByRole("combobox", { name: /worktree/i }),
    ).not.toBeInTheDocument();
  });

  it("attaches and removes supplemental roots through root-scoped mutations", async () => {
    const supplementalRootId = "context-root" as never;
    const removeWorkspaceFileRoot = vi.fn(async () => ({
      rootId: supplementalRootId,
    }));
    const attachWorkspaceFileRoot = vi.fn(async () => ({
      root: {
        kind: "supplemental" as const,
        rootId: supplementalRootId,
        displayLabel: "Agent context",
        displayPath: { text: "/agent-context" },
        sortOrder: 1,
        revision: 2,
        availability: "available" as const,
        watchable: true,
      },
    }));
    const api = setupApi({
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary" as const,
            rootId: "primary" as const,
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available" as const,
            watchable: true,
          },
          {
            kind: "supplemental" as const,
            rootId: supplementalRootId,
            displayLabel: "Agent context",
            displayPath: { text: "/agent-context" },
            sortOrder: 1,
            revision: 2,
            availability: "available" as const,
            watchable: true,
          },
        ],
      })),
      attachWorkspaceFileRoot,
      removeWorkspaceFileRoot,
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );
    await waitForListing(api);

    fireEvent.click(
      screen.getByRole("button", { name: "Add folder to Files" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Absolute folder path" }),
      {
        target: { value: "  /home/operator/projects/example/  " },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Folder display label" }),
      {
        target: { value: "Agent context" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() =>
      expect(attachWorkspaceFileRoot).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          mutationId: expect.any(String),
          path: "/home/operator/projects/example",
          displayLabel: "Agent context",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add folder to Files" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Agent context" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add folder to Files" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Absolute folder path" }),
      { target: { value: "/home/operator//invalid" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter an absolute normalized POSIX path",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent('"code"');
    expect(attachWorkspaceFileRoot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Remove folder Agent context" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove folder" }));
    await waitFor(() =>
      expect(removeWorkspaceFileRoot).toHaveBeenCalledWith(
        "workspace-1",
        supplementalRootId,
        expect.objectContaining({
          mutationId: expect.any(String),
          expectedRevision: 2,
        }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Remove folder Workspace" }),
    ).not.toBeInTheDocument();
  });

  it("browses the workspace environment when choosing a supplemental folder", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" as const },
        entries: [{ name: "projects", path: "/home/operator/projects" }],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory" as const,
          path: "/home/operator/projects",
          parentPath: "/home/operator",
        },
        entries: [],
        truncated: false,
      });
    const api = setupApi({ browseExecutionEnvironmentDirectories });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);

    fireEvent.click(
      screen.getByRole("button", { name: "Add folder to Files" }),
    );
    expect(screen.getByRole("textbox", { name: "Environment" })).toHaveValue(
      "Local",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /projects/ }),
    );

    expect(
      screen.getByRole("textbox", { name: "Absolute folder path" }),
    ).toHaveValue("/home/operator/projects");
    expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledWith(
      "environment-1",
      expect.objectContaining({ location: { kind: "roots" } }),
      expect.any(AbortSignal),
    );
  });

  it("refreshes topology when Files becomes visible without subscribing to filesystem events", async () => {
    const api = setupApi();
    const { context, subscribeWorkspaceFiles } = setupContext();
    const panel = (visible: boolean) => (
      <WorkspaceFilesPanel context={{ ...context, visible }} api={api} renderFile={() => null} />
    );
    const view = render(panel(false));
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
    expect(api.listWorkspaceFileRoots).not.toHaveBeenCalled();
    expect(api.listWorkspaceFileDirectory).not.toHaveBeenCalled();

    view.rerender(panel(true));
    await waitForListing(api);
    expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(1);
    view.rerender(panel(false));
    expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(1);

    view.rerender(panel(true));
    await waitFor(() => expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(2));
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not watch Files in a background document and refreshes on foreground", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const api = setupApi();
    const { context, subscribeWorkspaceFiles } = setupContext();
    try {
      render(<WorkspaceFilesPanel context={context} api={api} renderFile={() => null} />);
      expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
      expect(api.listWorkspaceFileRoots).not.toHaveBeenCalled();
      visibility.mockReturnValue("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitForListing(api);
      expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
      visibility.mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(2));
      expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it("preserves open tabs and dirty edits while Files is hidden", async () => {
    const api = setupApi();
    const { context, host } = setupContext();
    const panel = (visible: boolean) => (
      <WorkspaceFilesPanel context={{ ...context, visible }} api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <div data-testid="retained-draft">{content}</div>
            <button type="button" onClick={() => onChange("unsaved while hidden")}>Make dirty</button>
          </div>
        )} />
    );
    const view = render(panel(true));
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("retained-draft");
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    await waitFor(() => expect(host.setDirty).toHaveBeenCalledWith(true));
    view.rerender(panel(false));
    expect(screen.getByTestId("retained-draft")).toHaveTextContent("unsaved while hidden");
    view.rerender(panel(true));
    await waitFor(() => expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("retained-draft")).toHaveTextContent("unsaved while hidden");
    expect(openFileTabs()).toHaveLength(1);
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(host.setDirty).toHaveBeenLastCalledWith(true);
  });

  it("resumes an interrupted file read when Files becomes visible without applying stale content", async () => {
    type FileResult = Awaited<ReturnType<WorkspaceFilesApi["readWorkspaceFile"]>>;
    const pendingRead = deferred<FileResult>();
    const api = setupApi();
    const freshFile = await api.readWorkspaceFile(
      "workspace-1", "primary", "src/index.ts",
    );
    const readWorkspaceFile = vi.fn()
      .mockReturnValueOnce(pendingRead.promise)
      .mockResolvedValue(freshFile);
    const filesApi = { ...api, readWorkspaceFile };
    const { context } = setupContext();
    const panel = (visible: boolean) => (
      <WorkspaceFilesPanel context={{ ...context, visible }} api={filesApi}
        renderFile={({ content }) => <div data-testid="resumed-file">{content}</div>} />
    );
    const view = render(panel(true));
    await waitForListing(filesApi);
    act(() => selectPaths(["src/index.ts"]));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(1));
    const signal = readWorkspaceFile.mock.calls[0]![3] as AbortSignal;

    view.rerender(panel(false));
    expect(signal.aborted).toBe(true);
    await act(async () => pendingRead.resolve({ ...freshFile, content: "stale" } as FileResult));
    expect(screen.queryByTestId("resumed-file")).not.toBeInTheDocument();

    view.rerender(panel(true));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("resumed-file")).toHaveTextContent("export const answer = 42;");
    expect(openFileTabs()).toHaveLength(1);
  });

  it("refreshes root topology explicitly without subscribing to filesystem events", async () => {
    const supplementalRootId = "context-root" as never;
    const listWorkspaceFileRoots = vi
      .fn()
      .mockResolvedValueOnce({
        roots: [
          {
            kind: "primary",
            rootId: "primary",
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 0,
            availability: "available",
            watchable: false,
          },
        ],
      })
      .mockResolvedValue({
        roots: [
          {
            kind: "primary",
            rootId: "primary",
            displayLabel: "Workspace",
            sortOrder: 0,
            revision: 0,
            availability: "available",
            watchable: true,
          },
          {
            kind: "supplemental",
            rootId: supplementalRootId,
            displayLabel: "Agent context",
            sortOrder: 1,
            revision: 1,
            availability: "available",
            watchable: true,
          },
        ],
      });
    const api = setupApi({ listWorkspaceFileRoots });
    const { context, subscribeWorkspaceFiles } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );
    await waitForListing(api);
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    await waitFor(() =>
      expect(listWorkspaceFileRoots).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByRole("tab", { name: "Agent context" })).toBeInTheDocument();
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("silently prunes a directory removed while the user expands it", async () => {
    const listWorkspaceFileDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        directory: "",
        entries: [{ path: "src", kind: "directory" }],
        scanTruncated: false,
      })
      .mockRejectedValueOnce(
        new ApiError(404, "not_found", "Directory removed.", false),
      );
    getItem.mockImplementation((path: string) =>
      path === "src/"
        ? { isDirectory: () => true, isExpanded: () => true }
        : null,
    );
    const api = setupApi({ listWorkspaceFileDirectory });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);

    await waitFor(() =>
      expect(listWorkspaceFileDirectory).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith(
        expect.objectContaining({ preparedInput: { paths: [] } }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("silently prunes a loaded directory that disappears during refresh", async () => {
    const listWorkspaceFileDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        directory: "",
        entries: [{ path: "src", kind: "directory" }],
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        directory: "src",
        entries: [{ path: "src/index.ts", kind: "file" }],
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        directory: "",
        entries: [],
        scanTruncated: false,
      })
      .mockRejectedValueOnce(
        new ApiError(404, "not_found", "Directory removed.", false),
      );
    getItem.mockImplementation((path: string) =>
      path === "src/"
        ? { isDirectory: () => true, isExpanded: () => true }
        : null,
    );
    const api = setupApi({ listWorkspaceFileDirectory });
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);

    await waitFor(() =>
      expect(listWorkspaceFileDirectory).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preparedInput: { paths: ["src/", "src/index.ts"] },
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    await waitFor(() =>
      expect(listWorkspaceFileDirectory).toHaveBeenCalledTimes(4),
    );
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preparedInput: { paths: [] },
        }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("paginates listings and surfaces bounded result metadata", async () => {
    const listWorkspaceFiles = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["a.ts"],
        nextCursor: "a.ts",
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["b.ts"],
        scanTruncated: true,
      });
    const api = setupApi({ listWorkspaceFiles });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Load full tree to search" }),
    );

    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(listWorkspaceFiles).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({ cursor: "a.ts", pageSize: 5_000 }),
    );
    expect(
      await screen.findByText(
        "Full scan reached its path limit; some files aren't shown.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Partial tree loaded" }),
    ).toBeDisabled();
  });

  it("fails safely when listing pagination repeats a cursor", async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      availability: "available" as const,
      rootId: "primary" as const,
      entries: ["a.ts"],
      nextCursor: "a.ts",
      scanTruncated: false,
    }));
    const api = setupApi({ listWorkspaceFiles });
    const { context, subscribeWorkspaceFiles } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Load full tree to search" }),
    );

    expect(
      await screen.findByText(
        "Workspace file listing returned a repeated cursor.",
      ),
    ).toBeInTheDocument();
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(2);
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it.each([
    [
      "workspace_files_unsupported",
      "File browsing is unavailable for this workspace.",
    ],
    [
      "workspace_files_sidecar_unavailable",
      "Remote file browsing is temporarily unavailable.",
    ],
    ["workspace_file_root_unavailable", "This folder is no longer available."],
  ])(
    "reports %s without attempting a read",
    async (diagnosticCode, message) => {
      const api = setupApi({
        listWorkspaceFiles: vi.fn(async () => ({
          availability: "unavailable" as const,
          rootId: "primary" as const,
          diagnosticCode,
        })),
        listWorkspaceFileDirectory: vi.fn(async () => ({
          availability: "unavailable" as const,
          rootId: "primary" as const,
          diagnosticCode,
        })),
      });
      const { context } = setupContext();
      render(
        <WorkspaceFilesPanel
          context={context}
          api={api}
          renderFile={() => null}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Load full tree to search",
        }),
      );

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(api.readWorkspaceFile).not.toHaveBeenCalled();
    },
  );

  it("refuses to send binary contents to the Pierre viewer", async () => {
    const renderFile = vi.fn(() => null);
    const api = setupApi({
      readWorkspaceFile: vi.fn(
        async (_workspaceId: string, rootId, path: string) => ({
          availability: "available" as const,
          rootId,
          path,
          contentKind: "binary" as const,
          content: "" as const,
          sizeBytes: 32,
          revision: "revision-binary",
          editable: false as const,
        }),
      ),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderFile}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["asset.bin"]));
    expect(
      await screen.findByText("Binary files cannot be displayed."),
    ).toBeInTheDocument();
    expect(renderFile).not.toHaveBeenCalled();
  });

  it.each([
    ["preview.png", "image/png"],
    ["preview.jpeg", "image/jpeg"],
    ["preview.gif", "image/gif"],
    ["preview.webp", "image/webp"],
  ] as const)(
    "renders a validated %s data URL without edit controls",
    async (path, mediaType) => {
      const renderFile = vi.fn(() => null);
      const readWorkspaceFile = vi.fn(async (_workspaceId: string, rootId) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "image" as const,
        previewState: "available" as const,
        mediaType,
        contentEncoding: "base64" as const,
        content: "AA==",
        sizeBytes: 1,
        revision: `revision-${path}`,
        editable: false as const,
      }));
      const api = setupApi({ readWorkspaceFile });
      const { context } = setupContext();
      render(
        <WorkspaceFilesPanel
          context={context}
          api={api}
          renderFile={renderFile}
        />,
      );

      await waitForListing(api);
      act(() => selectPaths([path]));
      const image = await screen.findByRole("img", { name: path });
      expect(image).toHaveAttribute("src", `data:${mediaType};base64,AA==`);
      const imageShell = image.closest(".zoomable-preview-shell");
      expect(imageShell).not.toBeNull();
      expect(
        within(imageShell as HTMLElement).getByTitle(path),
      ).toHaveTextContent(path);
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(renderFile).not.toHaveBeenCalled();
    },
  );

  it("zooms, pans by keyboard, resets, and retains each image tab view", async () => {
    const readWorkspaceFile = vi.fn(
      async (_workspaceId: string, rootId, path: string) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "image" as const,
        previewState: "available" as const,
        mediaType: "image/png" as const,
        contentEncoding: "base64" as const,
        content: "AA==",
        sizeBytes: 1,
        revision: `revision-${path}`,
        editable: false as const,
      }),
    );
    const api = setupApi({ readWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["first.png"]));
    const firstViewport = await screen.findByRole("region", {
      name: "Image preview for first.png",
    });
    const firstCanvas = firstViewport.querySelector(
      ".zoomable-preview-canvas",
    ) as HTMLElement;
    Object.defineProperties(firstViewport, {
      clientHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 300 },
      scrollHeight: {
        configurable: true,
        get: () =>
          (200 * Number.parseFloat(firstCanvas.style.height || "100%")) / 100,
      },
      scrollWidth: {
        configurable: true,
        get: () =>
          (300 * Number.parseFloat(firstCanvas.style.width || "100%")) / 100,
      },
    });

    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reset image view" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");
    expect(firstCanvas).toHaveStyle({ height: "125%", width: "125%" });
    expect(firstViewport.scrollLeft).toBe(37.5);
    expect(firstViewport.scrollTop).toBe(25);

    fireEvent.keyDown(firstViewport, { key: "ArrowRight" });
    expect(firstViewport.scrollLeft).toBe(77.5);
    expect(fireEvent.keyDown(firstViewport, { ctrlKey: true, key: "+" })).toBe(
      true,
    );
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");

    act(() => selectPaths(["second.png"]));
    expect(
      await screen.findByRole("region", {
        name: "Image preview for second.png",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");

    fireEvent.click(screen.getByRole("tab", { name: /^first\.png/ }));
    expect(
      await screen.findByRole("region", {
        name: "Image preview for first.png",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");

    fireEvent.click(screen.getByRole("button", { name: "Reset image view" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    for (let step = 0; step < 12; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("400%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close first.png" }));
    act(() => selectPaths(["first.png"]));
    expect(
      await screen.findByRole("region", {
        name: "Image preview for first.png",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
  });

  it("shows a payload-free oversized image refusal without creating an image", async () => {
    const renderFile = vi.fn(() => null);
    const path = "oversized.png";
    const api = setupApi({
      readWorkspaceFile: vi.fn(async (_workspaceId: string, rootId) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "image" as const,
        previewState: "too_large" as const,
        mediaType: "image/png" as const,
        sizeBytes: 16 * 1_024 * 1_024 + 1,
        revision: "revision-oversized",
        editable: false as const,
      })),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderFile}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths([path]));
    expect(
      await screen.findByText(
        "Image is larger than the preview limit (16 MiB).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Image zoom controls" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(renderFile).not.toHaveBeenCalled();
  });

  it("opens the tree as an overlay and closes it after choosing a file", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    await waitForListing(api);
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    const treeToggle = screen.getByRole("button", {
      name: "Toggle file browser",
    });
    expect(treeToggle).toBeEnabled();
    const filesBody = document.querySelector<HTMLElement>(
      ".workspace-files-body",
    )!;
    vi.spyOn(filesBody, "getBoundingClientRect").mockReturnValue({
      left: 100,
    } as DOMRect);
    vi.spyOn(treeToggle, "getBoundingClientRect").mockReturnValue({
      left: 148,
    } as DOMRect);
    fireEvent(window, new Event("resize"));
    expect(
      fileBrowser().style.getPropertyValue(
        "--workspace-files-tree-anchor-left",
      ),
    ).toBe("48px");
    fireEvent.click(treeToggle);
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    expect(treeToggle).toBeEnabled();
    fireEvent.click(treeToggle);
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    fireEvent(window, new Event("resize"));
    expect(
      fileBrowser().style.getPropertyValue(
        "--workspace-files-tree-anchor-left",
      ),
    ).toBe("48px");

    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("file-viewer");
    expect(screen.getByRole("tab", { name: "Browse" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");

    act(() => selectPaths(["src/index.ts"]));
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);

    fireEvent.click(treeToggle);
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize file browser" }),
    ).not.toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
  });

  it("previews markdown files and only shows the source editor while editing", async () => {
    const renderFile = vi.fn(({ editing }: { editing: boolean }) => (
      <div data-testid="source-editor">{String(editing)}</div>
    ));
    const api = setupApi({
      readWorkspaceFile: vi.fn(
        async (_workspaceId: string, rootId, path: string) => ({
          availability: "available" as const,
          rootId,
          path,
          contentKind: "text" as const,
          content: "# Title\n\nBody copy.",
          sizeBytes: 18,
          revision: "revision-md",
          editable: true,
        }),
      ),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderFile}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["README.md"]));
    expect(await screen.findByTestId("markdown-preview")).toHaveTextContent(
      "# Title",
    );
    expect(renderFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByTestId("source-editor")).toHaveTextContent("true");
    expect(screen.queryByTestId("markdown-preview")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument();

    act(() => selectPaths(["notes.txt"]));
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-preview")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("source-editor")).toBeInTheDocument();
  });

  it("overlays the tree without hiding the file in the sheet presentation", async () => {
    const api = setupApi();
    const { context } = setupContext();
    const sheetContext = {
      ...context,
      presentation: "sheet",
    } as WorkspacePanelContext;
    render(
      <WorkspaceFilesPanel
        context={sheetContext}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    await waitForListing(api);
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");

    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("file-viewer");
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle file browser" }),
    );
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^index\.ts/ })).toHaveAttribute(
      "aria-controls",
    );
    expect(
      screen.queryByRole("separator", { name: "Resize file browser" }),
    ).not.toBeInTheDocument();
  });

  it.each(["dock", "sheet"] as const)(
    "does not flash the %s tree when an intent opens a cached file",
    async (presentation) => {
      const uiStateCache = createWorkspaceFilesUiStateCache();
      uiStateCache.set("workspace-1", {
        version: WORKSPACE_FILES_UI_STATE_VERSION,
        linkOnlyRootIds: [],
        activeRootId: "primary",
        tabs: {
          files: [
            { rootId: "primary", path: "README.md" },
            { rootId: "primary", path: "src/index.ts" },
          ],
          active: { rootId: "primary", path: "README.md" },
        },
        treeOpen: true,
        expandedPathsByRoot: { primary: ["src/"] },
      });
      const api = setupApi();
      const { context } = setupContext();
      const intentContext = {
        ...context,
        presentation,
        intent: {
          kind: "open-workspace-file",
          workspaceId: "workspace-1",
          rootId: "primary",
          path: "src/index.ts",
          rootVisibility: "listed",
          target: { kind: "file" },
          sequence: 21,
        },
      } as WorkspacePanelContext;
      const fileRead =
        deferred<Awaited<ReturnType<WorkspaceFilesApi["readWorkspaceFile"]>>>();
      api.readWorkspaceFile = vi.fn(async () => fileRead.promise);

      render(
        <WorkspaceFilesPanel
          context={intentContext}
          api={api}
          uiStateCache={uiStateCache}
          renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
        />,
      );

      // Before listing resolves, stay on the file surface — not the tree.
      expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
      expect(screen.getByText("Loading src/index.ts…")).toBeInTheDocument();
      expect(screen.getByRole("tabpanel")).toBeInTheDocument();
      expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
      expect(api.listWorkspaceFileDirectory).not.toHaveBeenCalled();

      await act(async () => {
        fileRead.resolve({
          availability: "available",
          rootId: "primary",
          path: "src/index.ts",
          contentKind: "text",
          content: "export {};",
          sizeBytes: 10,
          revision: "revision-1",
          editable: true,
        });
        await fileRead.promise;
      });
      await screen.findByTestId("file-viewer");
      expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
      expect(screen.getByTestId("file-viewer")).toHaveTextContent(
        "src/index.ts",
      );
      expect(
        screen.queryByText("Loading src/index.ts…"),
      ).not.toBeInTheDocument();
      expect(context.host.consumeIntent).toHaveBeenCalledWith(21);
    },
  );

  it("retains a cold-open file after the host consumes its one-shot intent", async () => {
    const api = setupApi();
    const { context, host } = setupContext();
    const intent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "src/index.ts",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 22,
    } as const;
    const view = render(
      <WorkspaceFilesPanel
        context={{ ...context, intent }}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    await waitFor(() => expect(host.consumeIntent).toHaveBeenCalledWith(22));
    view.rerender(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/index.ts",
    );
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    expect(api.listWorkspaceFileDirectory).not.toHaveBeenCalled();
  });

  it("keeps a restored tree closed after the host consumes a cold-open intent", async () => {
    const api = setupApi();
    const { context, host } = setupContext();
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [{ rootId: "primary", path: "README.md" }],
        active: { rootId: "primary", path: "README.md" },
      },
      treeOpen: true,
      expandedPathsByRoot: { primary: ["src/"] },
    });
    const roots =
      deferred<
        Awaited<ReturnType<WorkspaceFilesApi["listWorkspaceFileRoots"]>>
      >();
    api.listWorkspaceFileRoots = vi.fn(async () => roots.promise);
    const intent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "src/index.ts",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 23,
    } as const;
    const view = render(
      <WorkspaceFilesPanel
        context={{ ...context, intent }}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    await waitFor(() => expect(host.consumeIntent).toHaveBeenCalledWith(23));
    view.rerender(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );
    await act(async () => {
      roots.resolve({
        roots: [
          {
            kind: "primary",
            availability: "available",
            rootId: "primary",
            displayLabel: "Workspace",
            displayPath: { text: "/workspace" },
            sortOrder: 0,
            revision: 1,
            watchable: true,
          },
        ],
      });
      await roots.promise;
    });

    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/index.ts",
    );
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    expect(api.listWorkspaceFileDirectory).not.toHaveBeenCalled();
  });

  it("re-seeks an already active file for each source-line intent", async () => {
    const api = setupApi();
    const { context, host } = setupContext();
    const firstIntent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "src/index.ts",
      rootVisibility: "listed",
      target: { kind: "source_line", lineNumber: 12 },
      sequence: 51,
    } as const;
    const renderFile = ({
      seek,
      onSeekHandled,
    }: {
      seek?: { readonly sequence: number; readonly lineNumber: number };
      onSeekHandled?: (sequence: number) => void;
    }) => (
      <div data-testid="seek-viewer">
        <span>{seek?.lineNumber ?? "none"}</span>
        {seek && (
          <button onClick={() => onSeekHandled?.(seek.sequence)} type="button">
            Handle seek {seek.sequence}
          </button>
        )}
      </div>
    );
    const view = render(
      <WorkspaceFilesPanel
        context={{ ...context, intent: firstIntent }}
        api={api}
        renderFile={renderFile}
      />,
    );

    expect(await screen.findByTestId("seek-viewer")).toHaveTextContent("12");
    fireEvent.click(screen.getByRole("button", { name: "Handle seek 51" }));
    await waitFor(() =>
      expect(screen.getByTestId("seek-viewer")).toHaveTextContent("none"),
    );

    view.rerender(
      <WorkspaceFilesPanel
        context={{
          ...context,
          intent: {
            ...firstIntent,
            target: { kind: "source_line", lineNumber: 7 },
            sequence: 52,
          },
        }}
        api={api}
        renderFile={renderFile}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("seek-viewer")).toHaveTextContent("7"),
    );
    expect(host.consumeIntent).toHaveBeenCalledWith(51);
    expect(host.consumeIntent).toHaveBeenCalledWith(52);
  });

  it("opens and restores a link-only worktree file without exposing its root in the tree", async () => {
    const linkRootId = "link-sibling" as never;
    const api = setupApi({
      readWorkspaceFile: vi.fn(async (_workspaceId, rootId, path) => ({
        availability: "available" as const,
        rootId,
        path,
        contentKind: "text" as const,
        content: "sibling contents",
        sizeBytes: 16,
        revision: "link-revision",
        editable: true,
      })),
    });
    const uiStateCache = createWorkspaceFilesUiStateCache();
    const { context } = setupContext();
    const intentContext = {
      ...context,
      intent: {
        kind: "open-workspace-file",
        workspaceId: "workspace-1",
        rootId: linkRootId,
        path: "src/sibling.ts",
        rootVisibility: "link_only",
        target: { kind: "file" },
        sequence: 31,
      },
    } as WorkspacePanelContext;
    const renderViewer = ({ path }: { path: string }) => (
      <div data-testid="file-viewer">{path}</div>
    );
    const view = render(
      <WorkspaceFilesPanel
        context={intentContext}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={renderViewer}
      />,
    );

    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/sibling.ts",
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledWith(
      "workspace-1",
      linkRootId,
      "src/sibling.ts",
      expect.any(AbortSignal),
    );
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    expect(screen.getAllByRole("tab", { name: "Workspace" })).toHaveLength(1);
    expect(screen.queryByRole("tab", { name: /link-sibling/ })).toBeNull();
    expect(
      screen.getByTitle("src/sibling.ts (linked file)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Close src/sibling.ts (linked file)",
      }),
    ).toBeInTheDocument();
    expect(context.host.consumeIntent).toHaveBeenCalledWith(31);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toHaveTextContent(
        "src/sibling.ts",
      ),
    );

    view.unmount();
    expect(uiStateCache.get("workspace-1")?.linkOnlyRootIds).toEqual([
      linkRootId,
    ]);
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={renderViewer}
      />,
    );
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/sibling.ts",
    );
    expect(screen.getAllByRole("tab", { name: "Workspace" })).toHaveLength(1);
    expect(screen.queryByRole("tab", { name: /link-sibling/ })).toBeNull();
  });

  it("keeps per-file drafts in tabs and switches without refetching", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path, content, onChange }) => (
          <div>
            <span data-testid="draft">
              {path}:{content}
            </span>
            <button type="button" onClick={() => onChange(`${content} draft`)}>
              Change
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["notes.ts"]));
    await screen.findByTestId("draft");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    act(() => selectPaths(["src/index.ts"]));
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(openFileTabs()).toHaveLength(2);
    await waitFor(() =>
      expect(screen.getByTestId("draft")).toHaveTextContent(
        "src/index.ts:export const answer = 42;",
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: /notes\.ts/ }));
    expect(screen.getByTestId("draft")).toHaveTextContent(
      "notes.ts:export const answer = 42; draft",
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it("parks pending file confirmations while Settings owns the foreground", async () => {
    const api = setupApi();
    const { context } = setupContext();
    const content = (visible: boolean) => <WorkspaceFilesPanel context={{ ...context, visible }} api={api}
      renderFile={({ content, onChange }) => <button onClick={() => onChange(`${content} changed`)}>Change</button>} />;
    const view = render(content(true));
    await waitForListing(api);
    act(() => selectPaths(["notes.ts"]));
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Close notes.ts" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    view.rerender(content(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(openFileTabs()).toHaveLength(1);
    view.rerender(content(true));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openFileTabs()).toHaveLength(1);
  });

  it("asks before closing a dirty tab and reopens the tree after the last close", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <button type="button" onClick={() => onChange(`${content} changed`)}>
            Change
          </button>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["notes.ts"]));
    await screen.findByRole("button", { name: "Change" });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    fireEvent.click(screen.getByRole("button", { name: "Close notes.ts" }));
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openFileTabs()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close notes.ts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and close" }),
    );
    await waitFor(() => expect(openFileTabs()).toHaveLength(0));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Toggle file browser" }),
      ).toHaveFocus(),
    );
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    expect(
      screen.queryByRole("tabpanel", { name: /^notes\.ts/ }),
    ).not.toBeInTheDocument();
  });

  it("activates the neighboring tab when the active tab closes", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["a.md"]));
    act(() => selectPaths(["b.md"]));
    act(() => selectPaths(["c.md"]));
    fireEvent.click(screen.getByRole("tab", { name: /^b\.md/ }));
    expect(screen.getByRole("tab", { name: /^b\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const tabs = openFileTabs();
    const viewer = screen.getByRole("tabpanel", { name: /^b\.md/ });
    expect(tabs[1]).toHaveAttribute("aria-controls", viewer.id);
    expect(viewer).toHaveAttribute("aria-labelledby", tabs[1]?.id);
    tabs[1]?.focus();
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^c\.md/ })).toHaveFocus(),
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /^c\.md/ }), {
      key: "Home",
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^a\.md/ })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^b\.md/ }));

    fireEvent.click(screen.getByRole("button", { name: "Close b.md" }));
    expect(
      screen.queryByRole("tab", { name: /^b\.md/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^c\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^c\.md/ })).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close c.md" }));
    expect(screen.getByRole("tab", { name: /^a\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^a\.md/ })).toHaveFocus(),
    );
  });

  it("removes every open tab owned by a deleted supplemental root", async () => {
    const supplementalRootId = "context-root" as never;
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: supplementalRootId,
      tabs: {
        files: [
          { rootId: "primary", path: "README.md" },
          { rootId: supplementalRootId, path: "a.md" },
          { rootId: supplementalRootId, path: "b.md" },
        ],
        active: { rootId: supplementalRootId, path: "b.md" },
      },
      treeOpen: false,
      expandedPathsByRoot: {},
    });
    const listWorkspaceFileRoots = vi.fn(async () => ({
      roots: [
        {
          kind: "primary" as const,
          rootId: "primary" as const,
          displayLabel: "Workspace",
          displayPath: { text: "/workspace" },
          sortOrder: 0,
          revision: 0,
          availability: "available" as const,
          watchable: true,
        },
        {
          kind: "supplemental" as const,
          rootId: supplementalRootId,
          displayLabel: "Context",
          displayPath: { text: "/context" },
          sortOrder: 1,
          revision: 2,
          availability: "available" as const,
          watchable: true,
        },
      ],
    }));
    const listWorkspaceFiles = vi.fn(async (_workspaceId, input) => ({
      availability: "available" as const,
      rootId: input.rootId,
      entries: input.rootId === "primary" ? ["README.md"] : ["a.md", "b.md"],
      scanTruncated: false,
    }));
    const api = setupApi({
      listWorkspaceFileRoots,
      listWorkspaceFiles,
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={() => null}
      />,
    );

    await waitFor(() => expect(openFileTabs()).toHaveLength(3));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove folder Context" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove folder" }));

    await waitFor(() => expect(openFileTabs()).toHaveLength(1));
    await waitFor(() =>
      expect(listWorkspaceFileRoots).toHaveBeenCalledTimes(2),
    );
    expect(
      listWorkspaceFiles.mock.calls.filter(
        ([, input]) => input.rootId === supplementalRootId,
      ),
    ).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /^README\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("tab", { name: /^a\.md/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /^b\.md/ }),
    ).not.toBeInTheDocument();
  });

  it("starts a new workspace cold and restores tabs when returning", async () => {
    const api = setupApi({
      listWorkspaceFiles: vi.fn(async (workspaceId: string) => ({
        availability: "available" as const,
        rootId: "primary" as const,
        entries:
          workspaceId === "workspace-1"
            ? ["README.md", "src/index.ts"]
            : ["other.ts"],
        scanTruncated: false,
      })),
    });
    const uiStateCache = createWorkspaceFilesUiStateCache();
    const { context, host } = setupContext();
    const renderViewer = ({ path }: { path: string }) => (
      <div data-testid="file-viewer">{path}</div>
    );
    const view = render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderViewer}
        uiStateCache={uiStateCache}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("file-viewer");
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    getItem.mockImplementation((path: string) =>
      path === "src/"
        ? { isDirectory: () => true, isExpanded: () => true }
        : null,
    );

    const nextContext = {
      ...context,
      workspaceId: "workspace-2",
      workspaceLabel: "Other",
    } as WorkspacePanelContext;
    view.rerender(
      <WorkspaceFilesPanel
        context={nextContext}
        api={api}
        renderFile={renderViewer}
        uiStateCache={uiStateCache}
      />,
    );
    await waitFor(() =>
      expect(api.listWorkspaceFileDirectory).toHaveBeenLastCalledWith(
        "workspace-2",
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId("file-viewer")).not.toBeInTheDocument();
    expect(openFileTabs()).toHaveLength(0);
    expect(fileBrowser()).toHaveClass("workspace-files-tree-open");
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(host.setSubtitle).toHaveBeenLastCalledWith("Other"),
    );

    view.rerender(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderViewer}
        uiStateCache={uiStateCache}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^index\.ts/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /^index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(fileBrowser()).not.toHaveClass("workspace-files-tree-open");
    await screen.findByTestId("file-viewer");
    expect(resetPaths).toHaveBeenCalledWith(
      expect.objectContaining({ initialExpandedPaths: ["src/"] }),
    );
    expect(api.readWorkspaceFile).toHaveBeenLastCalledWith(
      "workspace-1",
      "primary",
      "src/index.ts",
      expect.anything(),
    );
  });

  it("restores cached UI state across unmount and remount", async () => {
    const api = setupApi();
    const uiStateCache = createWorkspaceFilesUiStateCache();
    const { context } = setupContext();
    const renderViewer = ({ path }: { path: string }) => (
      <div data-testid="file-viewer">{path}</div>
    );
    const view = render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderViewer}
        uiStateCache={uiStateCache}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("file-viewer");
    view.unmount();

    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={renderViewer}
        uiStateCache={uiStateCache}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^index\.ts/ }),
      ).toBeInTheDocument(),
    );
    await screen.findByTestId("file-viewer");
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("src/index.ts");
  });

  it("prunes restored tabs after an explicit full-tree listing", async () => {
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [
          { rootId: "primary", path: "src/index.ts" },
          { rootId: "primary", path: "deleted.ts" },
        ],
        active: { rootId: "primary", path: "deleted.ts" },
      },
      treeOpen: false,
      expandedPathsByRoot: { primary: ["src/", "gone/"] },
    });
    const api = setupApi();
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
        uiStateCache={uiStateCache}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^deleted\.ts/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Load full tree to search" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: /^deleted\.ts/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /^index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(resetPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          initialExpandedPaths: ["src/"],
        }),
      ),
    );
  });

  it("finishes cached-tab restoration when the listing settles with an error", async () => {
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [{ rootId: "primary", path: "cached.ts" }],
        active: { rootId: "primary", path: "cached.ts" },
      },
      treeOpen: false,
      expandedPathsByRoot: { primary: ["cached/"] },
    });
    const api = setupApi({
      listWorkspaceFiles: vi.fn(async () => {
        throw new Error("Listing unavailable");
      }),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
        uiStateCache={uiStateCache}
      />,
    );

    expect(
      await screen.findByRole("tab", { name: /^cached\.ts/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Load full tree to search" }),
    );
    expect(await screen.findByText("Listing unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled();
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "cached.ts",
    );
  });

  it("preserves a pending cached snapshot across an unknown topology failure", async () => {
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [{ rootId: "primary", path: "src/index.ts" }],
        active: { rootId: "primary", path: "src/index.ts" },
      },
      treeOpen: false,
      expandedPathsByRoot: { primary: ["src/"] },
    });
    const roots = {
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
    };
    const listWorkspaceFileRoots = vi
      .fn()
      .mockRejectedValueOnce(new Error("Topology unavailable"))
      .mockResolvedValueOnce(roots);
    const api = setupApi({ listWorkspaceFileRoots });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
        uiStateCache={uiStateCache}
      />,
    );

    expect(await screen.findByText("Topology unavailable")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /^index\.ts/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    expect(
      await screen.findByRole("tab", { name: /^index\.ts/ }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "src/index.ts",
    );
    await waitFor(() =>
      expect(resetPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          initialExpandedPaths: ["src/"],
        }),
      ),
    );
  });

  it("merges cached tabs with replacement Markdown intents while restore is pending", async () => {
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [{ rootId: "primary", path: "cached.md" }],
        active: { rootId: "primary", path: "cached.md" },
      },
      treeOpen: false,
      expandedPathsByRoot: {},
    });
    const api = setupApi();
    const { context, host } = setupContext();
    const firstIntent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "first.md",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 41,
    };
    const view = render(
      <WorkspaceFilesPanel
        context={{ ...context, intent: firstIntent }}
        api={api}
        uiStateCache={uiStateCache}
      />,
    );
    view.rerender(
      <WorkspaceFilesPanel
        context={{
          ...context,
          intent: {
            ...firstIntent,
            path: "second.md",
            sequence: 42,
          },
        }}
        api={api}
        uiStateCache={uiStateCache}
      />,
    );
    await waitFor(() => expect(openFileTabs()).toHaveLength(3));
    expect(screen.getByRole("tab", { name: /^second\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(host.consumeIntent).toHaveBeenCalledWith(42);
  });

  it("restores tabs without carrying dirty drafts across workspace switches", async () => {
    const api = setupApi();
    const uiStateCache = createWorkspaceFilesUiStateCache();
    const { context, host } = setupContext();
    let draft = "export const answer = 42;";
    const view = render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content, onChange }) => (
          <div>
            <div data-testid="draft">{content}</div>
            <button type="button" onClick={() => onChange("dirty draft")}>
              Dirty
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("draft");
    fireEvent.click(screen.getByRole("button", { name: "Dirty" }));
    await waitFor(() => expect(host.setDirty).toHaveBeenCalledWith(true));
    expect(screen.getByTestId("draft")).toHaveTextContent("dirty draft");

    const otherContext = {
      ...context,
      workspaceId: "workspace-2",
    } as WorkspacePanelContext;
    view.rerender(
      <WorkspaceFilesPanel
        context={otherContext}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content }) => <div data-testid="draft">{content}</div>}
      />,
    );
    await waitFor(() =>
      expect(api.listWorkspaceFileDirectory).toHaveBeenLastCalledWith(
        "workspace-2",
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh workspace files" }),
      ).toBeEnabled(),
    );

    view.rerender(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ content, onChange }) => {
          draft = content;
          return (
            <div>
              <div data-testid="draft">{content}</div>
              <button type="button" onClick={() => onChange("x")}>
                Dirty
              </button>
            </div>
          );
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^index\.ts/ }),
      ).toBeInTheDocument(),
    );
    await screen.findByTestId("draft");
    expect(screen.getByTestId("draft")).toHaveTextContent(
      "export const answer = 42;",
    );
    expect(draft).toBe("export const answer = 42;");
    await waitFor(() => expect(host.setDirty).toHaveBeenLastCalledWith(false));
  });

  it("keeps restored tabs when the listing is truncated", async () => {
    const uiStateCache = createWorkspaceFilesUiStateCache();
    uiStateCache.set("workspace-1", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      activeRootId: "primary",
      tabs: {
        files: [
          { rootId: "primary", path: "src/index.ts" },
          { rootId: "primary", path: "outside-window.ts" },
        ],
        active: { rootId: "primary", path: "outside-window.ts" },
      },
      treeOpen: false,
      expandedPathsByRoot: { primary: ["src/"] },
    });
    const api = setupApi({
      listWorkspaceFiles: vi.fn(async () => ({
        availability: "available" as const,
        rootId: "primary" as const,
        entries: ["src/index.ts"],
        scanTruncated: true,
      })),
      readWorkspaceFile: vi.fn(
        async (_workspaceId: string, rootId, path: string) => ({
          availability: "available" as const,
          rootId,
          path,
          contentKind: "text" as const,
          content: `contents of ${path}`,
          sizeBytes: 12,
          revision: "revision-1",
          editable: true,
        }),
      ),
    });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        uiStateCache={uiStateCache}
        renderFile={({ path }) => <div data-testid="file-viewer">{path}</div>}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^outside-window\.ts/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /^index\.ts/ })).toBeInTheDocument();
    await screen.findByTestId("file-viewer");
    expect(screen.getByTestId("file-viewer")).toHaveTextContent(
      "outside-window.ts",
    );
  });

  it("settles a failed roots refresh and can recover on the next refresh", async () => {
    const roots = {
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
    };
    const listWorkspaceFileRoots = vi
      .fn()
      .mockResolvedValueOnce(roots)
      .mockRejectedValueOnce(new Error("Topology unavailable"))
      .mockResolvedValueOnce(roots);
    const api = setupApi({ listWorkspaceFileRoots });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={() => null}
      />,
    );
    await waitForListing(api);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Topology unavailable",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh workspace files" }),
      ).toBeEnabled(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() =>
      expect(listWorkspaceFileRoots).toHaveBeenCalledTimes(3),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh workspace files" }),
      ).toBeEnabled(),
    );
    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(3);
  });

  it("reloads a clean active file and refreshes the tree listing", async () => {
    const listWorkspaceFiles = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["src/index.ts"],
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["new.ts", "src/index.ts"],
        scanTruncated: false,
      });
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "new",
        sizeBytes: 3,
        revision: "revision-2",
        editable: true,
      });
    const api = setupApi({ listWorkspaceFiles, readWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, editing }) => (
          <div>
            <div data-testid="file-viewer">{content}</div>
            <div data-testid="editing-state">{String(editing)}</div>
          </div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("old");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByTestId("editing-state")).toHaveTextContent("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("new");
    expect(screen.getByTestId("editing-state")).toHaveTextContent("true");
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preparedInput: { paths: ["new.ts", "src/index.ts"] },
        }),
      ),
    );
  });

  it("shows the existing binary state when a refreshed text file becomes binary", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "binary",
        content: "",
        sizeBytes: 4,
        revision: "revision-2",
        editable: false,
      });
    const api = setupApi({ readWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => (
          <div data-testid="file-viewer">{content}</div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("old");

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    expect(
      await screen.findByText("Binary files cannot be displayed."),
    ).toBeVisible();
    expect(screen.queryByTestId("file-viewer")).not.toBeInTheDocument();
  });

  it("requires confirmation before a refresh discards a dirty file", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "latest",
        sizeBytes: 6,
        revision: "revision-2",
        editable: true,
      });
    const api = setupApi({ readWorkspaceFile });
    const { context, host } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <div data-testid="file-viewer">{content}</div>
            <button type="button" onClick={() => onChange("dirty draft")}>
              Change
            </button>
          </div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("old");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(host.setDirty).toHaveBeenCalledWith(true));

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    const firstDialog = await screen.findByRole("dialog");
    expect(firstDialog).toHaveTextContent("Reload file from disk?");
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("dirty draft");
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh workspace files" }),
      ).toBeEnabled(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    const secondDialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(secondDialog).getByRole("button", {
        name: "Discard and reload",
      }),
    );

    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent(
      "latest",
    );
    await waitFor(() => expect(host.setDirty).toHaveBeenLastCalledWith(false));
  });

  it("refreshes only the tree when no file is open", async () => {
    const api = setupApi();
    const { context } = setupContext();
    render(<WorkspaceFilesPanel context={context} api={api} />);
    await waitForListing(api);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    await waitFor(() =>
      expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2),
    );
    expect(api.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("does not reload the hidden Browse file while Compare is active", async () => {
    const api = setupApi();
    const { context, subscribeWorkspaceFiles } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => (
          <div data-testid="file-viewer">{content}</div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("file-viewer");
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );

    await waitFor(() =>
      expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2),
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(subscribeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("does not overwrite edits made while a manual file reload is in flight", async () => {
    type FileResult = Awaited<
      ReturnType<WorkspaceFilesApi["readWorkspaceFile"]>
    >;
    const reload = deferred<FileResult>();
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockImplementationOnce(() => reload.promise);
    const api = setupApi({ readWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <div data-testid="file-viewer">{content}</div>
            <button type="button" onClick={() => onChange("new draft")}>
              Change
            </button>
          </div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("old");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    reload.resolve({
      availability: "available",
      rootId: "primary",
      path: "src/index.ts",
      contentKind: "text",
      content: "latest",
      sizeBytes: 6,
      revision: "revision-2",
      editable: true,
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh workspace files" }),
      ).toBeEnabled(),
    );
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("new draft");
  });

  it("evicts pruned document caches so a reappearing file is read again", async () => {
    const listWorkspaceFiles = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["gone.ts"],
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: [],
        scanTruncated: false,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        entries: ["gone.ts"],
        scanTruncated: false,
      });
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "gone.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "gone.ts",
        contentKind: "text",
        content: "new",
        sizeBytes: 3,
        revision: "revision-2",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "gone.ts",
        contentKind: "text",
        content: "new",
        sizeBytes: 3,
        revision: "revision-2",
        editable: true,
      });
    const api = setupApi({ listWorkspaceFiles, readWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content }) => (
          <div data-testid="file-viewer">{content}</div>
        )}
      />,
    );
    await waitForListing(api);
    act(() => selectPaths(["gone.ts"]));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("old");

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: /^gone\.ts/ }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(resetPaths).toHaveBeenLastCalledWith({
        preparedInput: { paths: ["gone.ts"] },
      }),
    );
    act(() => selectPaths(["gone.ts"]));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId("file-viewer")).toHaveTextContent("new");
  });

  it("tracks a live draft and saves it with the opened revision", async () => {
    let resolveSave!: (value: {
      availability: "available";
      rootId: "primary";
      path: string;
      sizeBytes: number;
      revision: string;
    }) => void;
    const saveWorkspaceFile = vi.fn(
      () =>
        new Promise<Parameters<typeof resolveSave>[0]>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const api = setupApi({ saveWorkspaceFile });
    const { context, host } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, editing, onChange }) => (
          <div>
            <span data-testid="draft">{content}</span>
            <span data-testid="editing">{String(editing)}</span>
            <button
              type="button"
              onClick={() =>
                onChange(
                  content.includes("43")
                    ? "export const answer = 44;"
                    : "export const answer = 43;",
                )
              }
            >
              Change
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByTestId("draft");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByTestId("editing")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(host.setDirty).toHaveBeenCalledWith(true));

    fireEvent.keyDown(screen.getByRole("region", { name: "Workspace files" }), {
      key: "s",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(saveWorkspaceFile).toHaveBeenCalledWith("workspace-1", {
        rootId: "primary",
        path: "src/index.ts",
        content: "export const answer = 43;",
        expectedRevision: "revision-1",
      }),
    );
    await waitFor(() => expect(host.setBusy).toHaveBeenCalledWith(true));
    expect(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh workspace files" }),
    );
    await waitFor(() =>
      expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2),
    );
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("region", { name: "Workspace files" }), {
      key: "s",
      ctrlKey: true,
    });
    expect(saveWorkspaceFile).toHaveBeenCalledTimes(1);
    resolveSave({
      availability: "available",
      rootId: "primary",
      path: "src/index.ts",
      sizeBytes: 25,
      revision: "revision-2",
    });
    await waitFor(() => expect(host.setDirty).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(host.setBusy).toHaveBeenLastCalledWith(false));
  });

  it("reconciles an outcome-unknown save without automatically resending it", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "draft",
        sizeBytes: 5,
        revision: "revision-2",
        editable: true,
      });
    const saveWorkspaceFile = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          "workspace_file_write_outcome_unknown",
          "Save outcome unknown.",
          false,
        ),
      );
    const api = setupApi({ readWorkspaceFile, saveWorkspaceFile });
    const { context, host } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="draft">{content}</span>
            <button type="button" onClick={() => onChange("draft")}>
              Change
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(saveWorkspaceFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(host.setDirty).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains an outcome-unknown draft when reconciliation cannot read a revision", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockRejectedValueOnce(new Error("sidecar unavailable"));
    const saveWorkspaceFile = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          "workspace_file_write_outcome_unknown",
          "Save outcome unknown.",
          false,
        ),
      );
    const api = setupApi({ readWorkspaceFile, saveWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="draft">{content}</span>
            <button type="button" onClick={() => onChange("draft")}>
              Change
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The save outcome could not be confirmed",
    );
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");
    expect(
      screen.queryByRole("button", { name: "Overwrite" }),
    ).not.toBeInTheDocument();
    expect(saveWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it("retains the draft on conflict and overwrites only after reading the latest revision", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "old",
        sizeBytes: 3,
        revision: "revision-1",
        editable: true,
      })
      .mockResolvedValueOnce({
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "external",
        sizeBytes: 8,
        revision: "revision-2",
        editable: true,
      });
    const saveWorkspaceFile = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "workspace_file_revision_conflict",
          "File changed on disk.",
          false,
        ),
      )
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "workspace_file_revision_conflict",
          "File changed on disk again.",
          false,
        ),
      );
    const api = setupApi({ readWorkspaceFile, saveWorkspaceFile });
    const { context } = setupContext();
    render(
      <WorkspaceFilesPanel
        context={context}
        api={api}
        renderFile={({ content, onChange }) => (
          <div>
            <span data-testid="draft">{content}</span>
            <button type="button" onClick={() => onChange("draft")}>
              Change
            </button>
          </div>
        )}
      />,
    );

    await waitForListing(api);
    act(() => selectPaths(["src/index.ts"]));
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("File changed on disk")).toBeInTheDocument();
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() =>
      expect(saveWorkspaceFile).toHaveBeenLastCalledWith("workspace-1", {
        rootId: "primary",
        path: "src/index.ts",
        content: "draft",
        expectedRevision: "revision-2",
      }),
    );
    expect(saveWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("File changed on disk")).toBeInTheDocument();
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");
  });

  it.each([
    [
      "Overwrite",
      "binary",
      {
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "binary",
        content: "",
        sizeBytes: 4,
        revision: "revision-2",
        editable: false,
      },
      "The latest file contents are binary.",
    ],
    [
      "Overwrite",
      "truncated",
      {
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "external",
        sizeBytes: 999,
        revision: "revision-2",
        editable: false,
        truncation: { truncated: true, retainedBytes: 8, reason: "byte_limit" },
      },
      "The latest file contents exceed the editable size limit.",
    ],
    [
      "Reload",
      "binary",
      {
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "binary",
        content: "",
        sizeBytes: 4,
        revision: "revision-2",
        editable: false,
      },
      "The latest file contents are binary.",
    ],
    [
      "Reload",
      "truncated",
      {
        availability: "available",
        rootId: "primary",
        path: "src/index.ts",
        contentKind: "text",
        content: "external",
        sizeBytes: 999,
        revision: "revision-2",
        editable: false,
        truncation: { truncated: true, retainedBytes: 8, reason: "byte_limit" },
      },
      "The latest file contents exceed the editable size limit.",
    ],
  ])(
    "refuses to %s a %s latest file and retains the draft",
    async (action, _kind, latest, message) => {
      const readWorkspaceFile = vi
        .fn()
        .mockResolvedValueOnce({
          availability: "available",
          rootId: "primary",
          path: "src/index.ts",
          contentKind: "text",
          content: "old",
          sizeBytes: 3,
          revision: "revision-1",
          editable: true,
        })
        .mockResolvedValueOnce(latest);
      const saveWorkspaceFile = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(
            409,
            "workspace_file_revision_conflict",
            "File changed on disk.",
            false,
          ),
        );
      const api = setupApi({ readWorkspaceFile, saveWorkspaceFile });
      const { context } = setupContext();
      render(
        <WorkspaceFilesPanel
          context={context}
          api={api}
          renderFile={({ content, onChange }) => (
            <div>
              <span data-testid="draft">{content}</span>
              <button type="button" onClick={() => onChange("draft")}>
                Change
              </button>
            </div>
          )}
        />,
      );
      await waitForListing(api);
      act(() => selectPaths(["src/index.ts"]));
      await screen.findByText("old");
      fireEvent.click(screen.getByRole("button", { name: "Change" }));
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText("File changed on disk");
      fireEvent.click(screen.getByRole("button", { name: action }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByTestId("draft")).toHaveTextContent("draft");
      expect(saveWorkspaceFile).toHaveBeenCalledTimes(1);
    },
  );
});
