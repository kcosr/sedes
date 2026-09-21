// @vitest-environment jsdom

import React, { useImperativeHandle } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffComparisonDescriptor,
  WorkspaceDiffPatchResult,
  WorkspaceDiffRepositoryDescriptor,
  WorkspaceDiffRevisionDescriptor,
} from "../../shared/protocol/workspace-diffs.js";
import type { WorkspaceFileRootId } from "../../shared/protocol/workspace-files.js";
import { WORKSPACE_DIFF_MAX_PATCH_BYTES } from "../../shared/workspace-diff-limits.js";

let viewportViewer: Record<string, unknown> | undefined;
let capturedCodeViewProps: Record<string, unknown> | undefined;
const scrollTo = vi.fn();
const resizeObservers: Array<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}> = [];

vi.mock("@pierre/diffs/react", () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: Record<string, unknown>,
    ref: React.ForwardedRef<CodeViewHandle<unknown>>,
  ) {
    capturedCodeViewProps = props;
    useImperativeHandle(
      ref,
      () =>
        ({
          scrollTo,
          getInstance: () => viewportViewer,
        }) as unknown as CodeViewHandle<unknown>,
    );
    const items = props.items as readonly { id: string; type: string }[];
    const renderHeader = props.renderCustomHeader as
      | ((item: (typeof items)[number]) => React.ReactNode)
      | undefined;
    return (
      <div data-testid="code-view">
        {items.map((item) => (
          <div key={item.id}>
            {item.id}
            {renderHeader?.(item)}
          </div>
        ))}
      </div>
    );
  }),
}));

vi.mock("../app/appearance.js", () => ({
  getResolvedAppearance: () => "light",
  subscribeResolvedAppearance: () => () => undefined,
}));

import {
  WorkspaceCompareView,
  type WorkspaceCompareDataSource,
} from "./WorkspaceCompareView.js";

let measuredWidth = 900;
let notifyResize: () => void = () => undefined;

class TestResizeObserver {
  readonly entry: (typeof resizeObservers)[number];

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set() };
    resizeObservers.push(this.entry);
    notifyResize = () => {
      for (const observer of resizeObservers) {
        const entries = [...observer.targets].map(
          (target) =>
            ({
              target,
              contentRect: { width: measuredWidth },
            }) as unknown as ResizeObserverEntry,
        );
        observer.callback(entries, {} as ResizeObserver);
      }
    };
  }
  observe(target: Element): void {
    this.entry.targets.add(target);
    notifyResize();
  }
  unobserve(target: Element): void {
    this.entry.targets.delete(target);
  }
  disconnect(): void {
    this.entry.targets.clear();
  }
}

describe("WorkspaceCompareView", () => {
  beforeEach(() => {
    measuredWidth = 900;
    capturedCodeViewProps = undefined;
    viewportViewer = undefined;
    resizeObservers.length = 0;
    scrollTo.mockReset();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => measuredWidth,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates a comparison from catalogued opaque selections and lazily loads patches", async () => {
    const dataSource = createDataSource(10);
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        reviewControls={<div>Review controls</div>}
      />,
    );

    const settings = screen.getByRole("button", {
      name: /Comparison and review/,
    });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Review controls")).toBeVisible();
    expect(screen.queryByLabelText("Repository")).toBeNull();
    fireEvent.click(settings);
    expect(settings).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Review controls")).toBeVisible();
    fireEvent.click(settings);

    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);

    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: "repository-1",
          base: { kind: "revision", revisionId: "revision-main" },
          head: { kind: "working_tree" },
          mode: "direct",
        }),
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(8));
    expect(screen.queryByText("Sedes")).toBeNull();
    expect(screen.queryByText(/Load more diffs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /file-9.ts/ }));
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(10));
  });

  it("loads an exact navigator target before scrolling to its opaque item id", async () => {
    const dataSource = createDataSource(10);
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("treeitem", { name: /file-10\.ts/ }));
    await waitFor(() =>
      expect(dataSource.loadPatch).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: "file-10" }),
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ id: "file-10", type: "item" }),
      ),
    );
  });

  it("falls back to unified rendering when its panel becomes narrow", async () => {
    const dataSource = createDataSource(1);
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.items as readonly unknown[] | undefined)
          ?.length,
      ).toBe(1),
    );

    const unified = screen.getByRole("button", { name: "Unified" });
    const split = screen.getByRole("button", { name: "Split" });
    const wrap = screen.getByRole("button", { name: "Wrap" });
    expect(unified).toHaveAttribute("aria-pressed", "false");
    expect(split).toHaveAttribute("aria-pressed", "true");
    expect(wrap).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(split);
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.options as { diffStyle: string }).diffStyle,
      ).toBe("split"),
    );
    expect(unified).toHaveAttribute("aria-pressed", "false");
    expect(split).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(wrap);
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.options as { overflow: string }).overflow,
      ).toBe("wrap"),
    );
    expect(wrap).toHaveAttribute("aria-pressed", "true");

    const baseRevision = screen.getByLabelText("Base revision");
    baseRevision.focus();
    expect(baseRevision).toHaveFocus();
    measuredWidth = 600;
    notifyResize();
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.options as { diffStyle: string }).diffStyle,
      ).toBe("unified"),
    );
    expect(unified).toHaveAttribute("aria-pressed", "true");
    expect(split).toHaveAttribute("aria-pressed", "false");
    expect(split).toBeDisabled();
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    const settings = screen.getByRole("button", {
      name: /Comparison and review/,
    });
    await waitFor(() =>
      expect(settings).toHaveAttribute("aria-expanded", "false"),
    );
    expect(settings).toHaveFocus();
    expect(screen.getByLabelText("Base revision")).not.toBeVisible();
    fireEvent.click(settings);
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Base revision")).toBeVisible();
  });

  it("defaults to merge-base only when both endpoints are revisions", async () => {
    const dataSource = createDataSource(1);
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const strategy = (await screen.findByLabelText(
      "Comparison strategy",
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(screen.getByLabelText("Base revision")).toHaveTextContent("main"),
    );
    expect(screen.getByLabelText("Compare revision")).toHaveTextContent(
      "Working tree",
    );
    expect(strategy).toHaveValue("direct");
    expect(
      screen.getByRole("option", {
        name: "Changes introduced by compare branch",
      }),
    ).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Compare revision"));
    fireEvent.click(
      within(
        screen.getByRole("listbox", { name: "Compare sources" }),
      ).getByRole("option", { name: /main/ }),
    );
    await waitFor(() => expect(strategy).toHaveValue("merge_base"));
    expect(
      screen.getByRole("option", {
        name: "Changes introduced by compare branch",
      }),
    ).toBeEnabled();

    fireEvent.click(screen.getByLabelText("Base revision"));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Choose base revision" }),
      ).getByRole("option", { name: /Staged changes/ }),
    );
    await waitFor(() => expect(strategy).toHaveValue("direct"));
    expect(
      screen.getByRole("option", {
        name: "Changes introduced by compare branch",
      }),
    ).toBeDisabled();
  });

  it("captures exact displayed diff lines for the shared selection action", async () => {
    const dataSource = createDataSource(1);
    const onAttachSelection = vi.fn(() => ({ ok: true as const }));
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        onAttachSelection={onAttachSelection}
      />,
    );
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.items as readonly unknown[] | undefined)
          ?.length,
      ).toBe(1),
    );
    await waitFor(() =>
      expect(
        (capturedCodeViewProps?.items as readonly { type: string }[])[0]?.type,
      ).toBe("diff"),
    );
    const options = capturedCodeViewProps?.options as {
      onLineSelectionEnd(
        range: {
          start: number;
          end: number;
          side: "additions" | "deletions";
        },
        context: { item: unknown },
      ): void;
    };
    const item = (capturedCodeViewProps?.items as readonly unknown[])[0]!;
    act(() =>
      options.onLineSelectionEnd(
        { start: 1, end: 1, side: "additions" },
        { item },
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Add to message" }),
    );

    expect(onAttachSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        captured: {
          excerpt: "new\n",
          start: { side: "new", line: 1 },
          end: { side: "new", line: 1 },
        },
      }),
    );
  });

  it("does not refetch terminal patch states unless the user explicitly retries", async () => {
    const dataSource = createDataSource(1, {
      loadPatch: async () => ({
        status: "unavailable",
        diagnosticCode: "workspace_diff_patch_unavailable",
      }),
    });
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);

    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);

    await screen.findByText("Diff unavailable");
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dataSource.loadPatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("treeitem", { name: /file-1\.ts/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dataSource.loadPatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(2));
  });

  it("keeps terminal files ordered and loads the region around a jump", async () => {
    const dataSource = createDataSource(10, {
      loadPatch: async (file) =>
        file.fileId === "file-9"
          ? {
              status: "too_large",
              maximumBytes: WORKSPACE_DIFF_MAX_PATCH_BYTES,
            }
          : availablePatch(file),
    });
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);

    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);

    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(8));
    fireEvent.click(screen.getByRole("treeitem", { name: /file-9.ts/ }));
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(10));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Load more diffs/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Diff exceeds the size limit")).toBeInTheDocument();
  });

  it("bounds concurrent patch requests and fences old comparison results", async () => {
    const completions: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const dataSource = createDataSource(20, {
      loadPatch: (file) =>
        new Promise((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          completions.push(() => {
            active--;
            resolve(availablePatch(file));
          });
        }),
    });
    const { unmount } = render(
      <WorkspaceCompareView rootId="primary" dataSource={dataSource} />,
    );
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(3));
    expect(maximum).toBe(3);
    fireEvent.click(screen.getByRole("treeitem", { name: /file-20.ts/ }));
    await act(async () => {
      completions.shift()?.();
    });
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(4));
    expect(vi.mocked(dataSource.loadPatch).mock.calls[3]?.[0].fileId).toBe(
      "file-20",
    );
    expect(maximum).toBe(3);
    unmount();
    await act(async () => {
      for (const finish of completions.splice(0)) finish();
    });
    expect(dataSource.loadPatch).toHaveBeenCalledTimes(4);
  });

  it("restores a distant path first with fresh IDs and preserves direct strategy", async () => {
    const dataSource = createDataSource(420);
    const onNavigationChange = vi.fn();
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        onNavigationChange={onNavigationChange}
        initialNavigation={{
          repository: {
            repositoryKey: "repository-key-sedes",
            displayName: "Sedes",
          },
          base: { kind: "ref", refKind: "local_branch", label: "main" },
          head: { kind: "working_tree" },
          mode: "direct",
          fingerprint: "fingerprint_123456789",
          file: {
            oldPath: "src/file-400.ts",
            newPath: "src/file-400.ts",
            changeKind: "modified",
            line: 1,
            side: "additions",
            offset: 0,
          },
          filter: "",
          navigatorWidth: 280,
          collapsedDirectories: [],
          preferences: { diffStyle: "split", overflow: "wrap" },
        }}
      />,
    );
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalled());
    expect(vi.mocked(dataSource.loadPatch).mock.calls[0]?.[0].fileId).toBe(
      "file-400",
    );
    expect(dataSource.loadPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-1" }),
      expect.anything(),
    );
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "file-400",
          type: "line",
          lineNumber: 1,
        }),
      ),
    );
    await waitFor(() =>
      expect(onNavigationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: expect.objectContaining({
            repositoryKey: "repository-key-sedes",
          }),
          file: expect.objectContaining({ newPath: "src/file-400.ts" }),
        }),
      ),
    );
    const emitted = onNavigationChange.mock.calls.at(-1)?.[0];
    expect(emitted.file).not.toHaveProperty("fileId");
    expect(emitted.file).not.toHaveProperty("binary");
    expect(Object.keys(emitted.file).sort()).toEqual([
      "changeKind",
      "line",
      "newPath",
      "offset",
      "oldPath",
      "side",
    ]);
  });

  it("reports history failures without replacing the active comparison", async () => {
    const dataSource = createDataSource(1);
    const original = dataSource.listRevisions;
    vi.mocked(dataSource.listRevisions).mockImplementation(
      async (repository, signal, query) => {
        if (query?.history) throw new Error("Offline");
        return originalResult;
      },
    );
    const originalResult = await createDataSource(1).listRevisions(
      "repository-1" as Parameters<typeof original>[0],
    );
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Base revision")).toHaveTextContent("main"),
    );
    fireEvent.click(screen.getByLabelText("Base revision"));
    fireEvent.change(screen.getByLabelText("Base commit history"), {
      target: { value: "all" },
    });
    await screen.findByText("Commit history could not be loaded: Offline.");
    expect(screen.getByLabelText("Base revision")).toHaveTextContent("main");
  });

  it("keeps the latest requested history when responses arrive out of order", async () => {
    const dataSource = createDataSource(1);
    const original = await dataSource.listRevisions(
      "repository-1" as Parameters<typeof dataSource.listRevisions>[0],
    );
    if (original.status !== "available") throw new Error("Fixture");
    let finishOld: ((value: typeof original) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(dataSource.listRevisions).mockImplementation(
      async (_repository, signal, query) => {
        if (query?.history === "all") {
          oldSignal = signal;
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        }
        return original;
      },
    );
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Base revision")).toHaveTextContent("main"),
    );
    fireEvent.click(screen.getByLabelText("Base revision"));
    fireEvent.change(screen.getByLabelText("Base commit history"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Base commit history"), {
      target: { value: "head" },
    });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () =>
      finishOld?.({
        ...original,
        revisions: [
          ...original.revisions,
          {
            ...original.revisions[0]!,
            kind: "commit",
            revisionId:
              "late-commit" as WorkspaceDiffRevisionDescriptor["revisionId"],
            label: "late",
            summary: "Obsolete history response",
          },
        ],
      }),
    );
    expect(screen.queryByText("Obsolete history response")).toBeNull();
    expect(screen.getByLabelText("Base commit history")).toHaveValue("head");
  });

  it("re-resolves a moving named branch before refreshing", async () => {
    const dataSource = createDataSource(1);
    const initial = await dataSource.listRevisions(
      "repository-1" as Parameters<typeof dataSource.listRevisions>[0],
    );
    if (initial.status !== "available") throw new Error("Fixture");
    vi.mocked(dataSource.listRevisions).mockImplementation(
      async (_repository, _signal, query) =>
        query?.resolveRef
          ? {
              ...initial,
              revisions: [
                {
                  ...initial.revisions[0]!,
                  revisionId:
                    "advanced-main" as WorkspaceDiffRevisionDescriptor["revisionId"],
                  commitHash: "b".repeat(40),
                },
              ],
            }
          : initial,
    );
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledWith(
        expect.objectContaining({
          base: { kind: "revision", revisionId: "advanced-main" },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(dataSource.listRevisions).toHaveBeenCalledWith(
      "repository-1",
      expect.any(AbortSignal),
      { resolveRef: "refs/heads/main" },
    );
  });

  it("renders file headers with review and Browse actions for loaded diffs", async () => {
    const dataSource = createDataSource(1);
    const onOpenFile = vi.fn();
    const onReviewedChange = vi.fn();
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        onOpenFile={onOpenFile}
        onReviewedChange={onReviewedChange}
      />,
    );
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    const reviewed = await screen.findByRole("button", {
      name: "Mark reviewed",
    });
    expect(
      within(screen.getByTestId("code-view")).getByText("src/file-1.ts"),
    ).toBeVisible();
    fireEvent.click(reviewed);
    expect(onReviewedChange).toHaveBeenCalledWith("file-1", true);
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/file-1.ts");
  });

  it("loads every visible short-file entry without requiring a scroll event", async () => {
    const dataSource = createDataSource(20);
    viewportViewer = {
      getScrollTop: () => 0,
      getHeight: () => 1200,
      getRenderedItems: () => capturedCodeViewProps?.items ?? [],
      getTopForItem: (id: string) =>
        (capturedCodeViewProps?.items as readonly { id: string }[]).findIndex(
          (item) => item.id === id,
        ) * 44,
    };
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(20));
    expect(dataSource.loadPatch).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-20" }),
      expect.any(AbortSignal),
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("refreshes mounted comparisons with fresh repository and pinned-commit handles after restart", async () => {
    const dataSource = createDataSource(1);
    const discovery = await dataSource.listRepositories("primary");
    const catalog = await dataSource.listRevisions(
      "repository-1" as Parameters<typeof dataSource.listRevisions>[0],
    );
    if (discovery.status !== "available" || catalog.status !== "available")
      throw new Error("Fixture");
    let restarted = false;
    const oldBranch = catalog.revisions[0]!;
    const pin = {
      ...oldBranch,
      kind: "commit" as const,
      revisionId: "pin-old" as WorkspaceDiffRevisionDescriptor["revisionId"],
      summary: "Pinned original commit",
    };
    const newBranch = {
      ...oldBranch,
      revisionId: "branch-new" as WorkspaceDiffRevisionDescriptor["revisionId"],
      commitHash: "b".repeat(40),
    };
    const newPin = {
      ...pin,
      revisionId: "pin-new" as WorkspaceDiffRevisionDescriptor["revisionId"],
    };
    vi.mocked(dataSource.listRepositories).mockImplementation(async () => ({
      ...discovery,
      repositories: [
        {
          ...discovery.repositories[0]!,
          repositoryId: (restarted
            ? "repository-new"
            : "repository-1") as WorkspaceDiffRepositoryDescriptor["repositoryId"],
        },
      ],
    }));
    vi.mocked(dataSource.listRevisions).mockImplementation(
      async (repository, _signal, query) => {
        if (!restarted) return { ...catalog, revisions: [oldBranch, pin] };
        if (repository !== "repository-new")
          throw new Error("Expired repository handle");
        return {
          ...catalog,
          repositoryId: repository,
          revisions: query?.resolveCommit ? [newBranch, newPin] : [newBranch],
        };
      },
    );
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Base revision")).toHaveTextContent("main"),
    );
    fireEvent.click(screen.getByLabelText("Base revision"));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Base sources" })).getByRole(
        "option",
        { name: /Pinned original commit/ },
      ),
    );
    fireEvent.click(screen.getByLabelText("Compare revision"));
    fireEvent.click(
      within(
        screen.getByRole("listbox", { name: "Compare sources" }),
      ).getByRole("option", { name: /main/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh comparison" }),
      ).toBeEnabled(),
    );
    restarted = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenLastCalledWith(
        expect.objectContaining({
          repositoryId: "repository-new",
          base: { kind: "revision", revisionId: "pin-new" },
          head: { kind: "revision", revisionId: "branch-new" },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(dataSource.listRevisions).toHaveBeenCalledWith(
      "repository-new",
      expect.any(AbortSignal),
      { resolveCommit: "a".repeat(40) },
    );
    fireEvent.click(screen.getByLabelText("Base revision"));
    expect(
      within(
        screen.getByRole("listbox", { name: "Base sources" }),
      ).getAllByRole("option", { name: /main/ }),
    ).toHaveLength(1);
  });

  it("does not substitute a different repository on refresh", async () => {
    const dataSource = createDataSource(1);
    const discovery = await dataSource.listRepositories("primary");
    if (discovery.status !== "available") throw new Error("Fixture");
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh comparison" }),
      ).toBeEnabled(),
    );
    vi.mocked(dataSource.listRepositories).mockResolvedValue({
      ...discovery,
      repositories: [
        {
          ...discovery.repositories[0]!,
          repositoryKey: "different-repository-key",
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await screen.findByText(/selected repository is no longer available/);
    expect(dataSource.createComparison).toHaveBeenCalledTimes(1);
  });

  it("persists the recovered current file instead of a missing old anchor", async () => {
    const dataSource = createDataSource(1);
    const onNavigationChange = vi.fn();
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        onNavigationChange={onNavigationChange}
        initialNavigation={{
          repository: {
            repositoryKey: "repository-key-sedes",
            displayName: "Sedes",
          },
          base: { kind: "ref", refKind: "local_branch", label: "main" },
          head: { kind: "working_tree" },
          mode: "direct",
          fingerprint: "old-fingerprint",
          file: {
            oldPath: "gone.ts",
            newPath: "gone.ts",
            changeKind: "modified",
            line: 100,
          },
          filter: "",
          navigatorWidth: 260,
          collapsedDirectories: [],
          preferences: { diffStyle: "split", overflow: "scroll" },
        }}
      />,
    );
    await screen.findByText(
      "The previously viewed file is no longer in this comparison.",
    );
    await waitFor(() =>
      expect(onNavigationChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          file: {
            oldPath: "src/file-1.ts",
            newPath: "src/file-1.ts",
            changeKind: "modified",
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledTimes(2),
    );
    expect(
      screen.queryByText(
        "The previously viewed file is no longer in this comparison.",
      ),
    ).toBeNull();
  });

  it("resolves namespace-like branch names using their declared ref kind on restore and refresh", async () => {
    const dataSource = createDataSource(1);
    const initial = await dataSource.listRevisions(
      "repository-1" as Parameters<typeof dataSource.listRevisions>[0],
    );
    if (initial.status !== "available") throw new Error("Fixture");
    const branch = {
      ...initial.revisions[0]!,
      revisionId:
        "revision-refs-topic" as WorkspaceDiffRevisionDescriptor["revisionId"],
      label: "refs/topic",
    };
    vi.mocked(dataSource.listRevisions).mockImplementation(
      async (_repository, _signal, query) => {
        if (!query?.resolveRef) return initial;
        return query.resolveRef === "refs/heads/refs/topic"
          ? { ...initial, revisions: [...initial.revisions, branch] }
          : {
              status: "unavailable",
              diagnosticCode: "workspace_diff_ref_unavailable",
            };
      },
    );
    render(
      <WorkspaceCompareView
        rootId="primary"
        dataSource={dataSource}
        initialNavigation={{
          repository: {
            repositoryKey: "repository-key-sedes",
            displayName: "Sedes",
          },
          base: { kind: "ref", refKind: "local_branch", label: "refs/topic" },
          head: { kind: "working_tree" },
          mode: "direct",
          filter: "",
          navigatorWidth: 260,
          collapsedDirectories: [],
          preferences: { diffStyle: "split", overflow: "scroll" },
        }}
      />,
    );
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledTimes(1),
    );
    expect(dataSource.createComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        base: { kind: "revision", revisionId: "revision-refs-topic" },
      }),
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh comparison" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() =>
      expect(dataSource.createComparison).toHaveBeenCalledTimes(2),
    );
    const resolutions = vi
      .mocked(dataSource.listRevisions)
      .mock.calls.map((call) => call[2]?.resolveRef)
      .filter(Boolean);
    expect(resolutions).toEqual([
      "refs/heads/refs/topic",
      "refs/heads/refs/topic",
      "refs/heads/refs/topic",
    ]);
  });

  it("clears the truncated warning when the root changes", async () => {
    const dataSource = createDataSource(1, { truncated: true });
    const { rerender } = render(
      <WorkspaceCompareView rootId="primary" dataSource={dataSource} />,
    );

    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);

    expect(await screen.findByText("Result truncated")).toBeInTheDocument();

    rerender(
      <WorkspaceCompareView
        rootId={"secondary-root" as WorkspaceFileRootId}
        dataSource={dataSource}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("Result truncated")).not.toBeInTheDocument(),
    );
  });
});

function createDataSource(
  fileCount: number,
  options: {
    readonly loadPatch?: (
      file: WorkspaceDiffChangedFileSummary,
    ) => Promise<WorkspaceDiffPatchResult>;
    readonly truncated?: boolean;
  } = {},
): WorkspaceCompareDataSource {
  const repository = {
    repositoryId: "repository-1",
    repositoryKey: "repository-key-sedes",
    rootId: "primary",
    displayName: "Sedes",
  } as WorkspaceDiffRepositoryDescriptor;
  const revision = {
    revisionId: "revision-main",
    kind: "local_branch",
    label: "main",
    commitHash: "a".repeat(40),
    shortHash: "aaaaaaa",
  } as WorkspaceDiffRevisionDescriptor;
  const comparison = {
    comparisonId: "comparison-1",
    repositoryId: repository.repositoryId,
    mode: "direct",
    base: {
      kind: "revision",
      revisionId: revision.revisionId,
      commitHash: revision.commitHash,
      label: "main",
    },
    head: { kind: "working_tree" },
    fingerprint: "fingerprint_123456789",
  } as WorkspaceDiffComparisonDescriptor;
  const files = Array.from({ length: fileCount }, (_, index) => ({
    fileId: `file-${index + 1}`,
    changeKind: "modified",
    oldPath: `src/file-${index + 1}.ts`,
    newPath: `src/file-${index + 1}.ts`,
    additions: 1,
    deletions: 1,
    binary: false,
  })) as WorkspaceDiffChangedFileSummary[];
  const createComparison = vi.fn(async () => ({
    status: "available" as const,
    comparison,
  }));
  const loadPatch = vi.fn(async ({ fileId }: { fileId: string }) => {
    const file = files.find((candidate) => candidate.fileId === fileId)!;
    return options.loadPatch?.(file) ?? availablePatch(file, comparison);
  });
  return {
    listRepositories: vi.fn(async () => ({
      status: "available",
      repositories: [repository],
    })),
    listRevisions: vi.fn(async () => ({
      status: "available",
      repositoryId: repository.repositoryId,
      revisions: [revision],
      truncated: false,
    })),
    createComparison,
    listChangedFiles: vi.fn(async () => ({
      status: "available",
      comparisonId: comparison.comparisonId,
      fingerprint: comparison.fingerprint,
      files,
      totalFiles: files.length,
      truncated: options.truncated ?? false,
    })),
    loadPatch,
    loadFileContent: vi.fn(async () => ({ status: "absent" })),
  } as WorkspaceCompareDataSource;
}

function availablePatch(
  file: WorkspaceDiffChangedFileSummary,
  comparison: WorkspaceDiffComparisonDescriptor = {
    comparisonId: "comparison-1",
    repositoryId: "repository-1",
    mode: "direct",
    base: {
      kind: "revision",
      revisionId: "revision-main",
      commitHash: "a".repeat(40),
      label: "main",
    },
    head: { kind: "working_tree" },
    fingerprint: "fingerprint_123456789",
  } as WorkspaceDiffComparisonDescriptor,
): WorkspaceDiffPatchResult {
  return {
    status: "available",
    comparisonId: comparison.comparisonId,
    fingerprint: comparison.fingerprint,
    fileId: file.fileId,
    patch: `diff --git a/${file.oldPath} b/${file.newPath}\n--- a/${file.oldPath}\n+++ b/${file.newPath}\n@@ -1 +1 @@\n-old\n+new\n`,
  };
}
