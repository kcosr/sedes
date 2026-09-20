// @vitest-environment jsdom

import React, { useImperativeHandle } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
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
      () => ({ scrollTo }) as unknown as CodeViewHandle<unknown>,
    );
    const items = props.items as readonly { id: string }[];
    return (
      <div data-testid="code-view">
        {items.map((item) => (
          <span key={item.id}>{item.id}</span>
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
    expect(screen.getByText("Review controls")).not.toBeVisible();
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
    expect(
      await screen.findByText("Load more diffs (8 of 10)"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Load more diffs (8 of 10)"));
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(10));
    await waitFor(() =>
      expect(screen.queryByText(/Load more diffs/)).not.toBeInTheDocument(),
    );
  });

  it("loads an exact navigator target before scrolling to its opaque item id", async () => {
    const dataSource = createDataSource(10);
    render(<WorkspaceCompareView rootId="primary" dataSource={dataSource} />);
    const compare = await screen.findByRole("button", { name: "Compare" });
    await waitFor(() => expect(compare).toBeEnabled());
    fireEvent.click(compare);
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    fireEvent.click(screen.getByRole("button", { name: /src\/file-10\.ts/ }));
    await waitFor(() =>
      expect(dataSource.loadPatch).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: "file-10" }),
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ id: "file-10", type: "line" }),
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
    expect(unified).toHaveAttribute("aria-pressed", "true");
    expect(split).toHaveAttribute("aria-pressed", "false");
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
      expect(screen.getByLabelText("Base revision")).toHaveValue(
        "revision:revision-main",
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Compare revision")).toHaveValue(
        "working_tree",
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Base revision")).toHaveValue(
        "revision:revision-main",
      ),
    );
    expect(strategy).toHaveValue("direct");
    expect(screen.getByRole("option", { name: "Merge base" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Compare revision"), {
      target: { value: "revision:revision-main" },
    });
    await waitFor(() => expect(strategy).toHaveValue("merge_base"));
    expect(screen.getByRole("option", { name: "Merge base" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Base revision"), {
      target: { value: "index" },
    });
    await waitFor(() => expect(strategy).toHaveValue("direct"));
    expect(screen.getByRole("option", { name: "Merge base" })).toBeDisabled();
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

    await screen.findByText("Patch is unavailable");
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dataSource.loadPatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    fireEvent.click(screen.getByRole("button", { name: /src\/file-1\.ts/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dataSource.loadPatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(2));
  });

  it("hides Load more once every changed file has been attempted", async () => {
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

    const loadMore = await screen.findByRole("button", {
      name: "Load more diffs (8 of 10)",
    });
    fireEvent.click(loadMore);

    await waitFor(() => expect(dataSource.loadPatch).toHaveBeenCalledTimes(10));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Load more diffs/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Patch is too large")).toBeInTheDocument();
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
