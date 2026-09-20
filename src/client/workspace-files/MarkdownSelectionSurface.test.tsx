// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextExcerptStagingTarget } from "../context-excerpts/coordinator.js";
import { MarkdownSelectionSurface } from "./MarkdownSelectionSurface.js";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe("MarkdownSelectionSurface", () => {
  it("seeks a source line in rendered Markdown and handles each intent once", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return rectangle(
          this.dataset.markdownSourceStartLine === "7" ? 140 : 20,
        );
      },
    );
    const onSeekHandled = vi.fn();
    const view = render(
      <MarkdownSelectionSurface
        markdown={
          "# Guide\n\nIntro paragraph.\n\n## Destination\n\nDestination paragraph."
        }
        onSeekHandled={onSeekHandled}
        seek={{ sequence: 7, lineNumber: 7 }}
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "revision-1",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 108,
      behavior: "auto",
    });
    expect(
      document.querySelector(".workspace-files-markdown-seek-target"),
    ).toBeNull();
    expect(document.querySelector(".workspace-files-seek-notice")).toBeNull();
    expect(screen.getByLabelText("Markdown preview for README.md")).toHaveFocus();
    expect(onSeekHandled).toHaveBeenCalledExactlyOnceWith(7);

    view.rerender(
      <MarkdownSelectionSurface
        markdown={
          "# Guide\n\nIntro paragraph.\n\n## Destination\n\nDestination paragraph."
        }
        onSeekHandled={onSeekHandled}
        seek={{ sequence: 7, lineNumber: 7 }}
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "revision-1",
        }}
        workspaceId="workspace-1"
      />,
    );
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(onSeekHandled).toHaveBeenCalledOnce();
  });

  it("silently handles a source line outside a truncated Markdown preview", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const onSeekHandled = vi.fn();
    render(
      <MarkdownSelectionSurface
        markdown="# Partial preview"
        onSeekHandled={onSeekHandled}
        seek={{ sequence: 8, lineNumber: 99 }}
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "revision-1",
        }}
        truncated
        workspaceId="workspace-1"
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-files-seek-notice")).toBeNull();
    expect(onSeekHandled).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("stages the exact rendered quote with workspace revision provenance", async () => {
    const target = stagingTarget({
      stage: vi.fn(() => ({ ok: true as const })),
    });
    render(
      <MarkdownSelectionSurface
        markdown={"# Guide\n\nBefore **selected** after"}
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "revision-7",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );

    selectText(screen.getByText("selected").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar", { name: "Selected text actions" });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));

    expect(target.stage).toHaveBeenCalledOnce();
    expect(vi.mocked(target.stage).mock.calls[0]?.[0]).toMatchObject({
      id: expect.any(String),
      excerpt: "selected",
      source: {
        kind: "workspace_file",
        rootId: "primary",
        path: "README.md",
        revision: "revision-7",
      },
      locator: {
        kind: "text_quote",
        prefix: "Before ",
        suffix: " after",
        headingTrail: ["Guide"],
        sourceStartLine: 3,
        sourceEndLine: 3,
      },
    });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(
      screen.getByLabelText("Markdown preview for README.md"),
    ).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("snapshots selection before focusing and attaches a bounded note", async () => {
    const target = stagingTarget();
    render(
      <MarkdownSelectionSurface
        markdown="Choose this phrase."
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "notes.md",
          revision: "revision-note",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );

    const paragraph = screen.getByText("Choose this phrase.");
    selectText(paragraph.firstChild!, 7, 11);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    const textarea = screen.getByRole("textbox", {
      name: "Note about selected text",
    });
    fireEvent.change(textarea, {
      target: { value: "  Explain this choice.  " },
    });
    document.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(target.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        excerpt: "this",
        note: "Explain this choice.",
      }),
    );
  });

  it("keeps the action visible but disables staging for the wrong workspace", async () => {
    const target = stagingTarget({ workspaceId: "workspace-2" });
    render(
      <MarkdownSelectionSurface
        markdown="Selected text"
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "revision-1",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );
    selectText(screen.getByText("Selected text").firstChild!);
    fireEvent(document, new Event("selectionchange"));

    const button = await screen.findByRole("button", {
      name: "Add to message",
    });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("This file is not in the active thread workspace."),
    ).toBeInTheDocument();
    expect(target.stage).not.toHaveBeenCalled();
  });

  it("clears a pending quote when the rendered revision changes", async () => {
    const target = stagingTarget();
    const { rerender } = render(
      <MarkdownSelectionSurface
        markdown="Old selected text"
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "old",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );
    selectText(screen.getByText("Old selected text").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");

    rerender(
      <MarkdownSelectionSurface
        markdown="New selected text"
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "README.md",
          revision: "new",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument(),
    );
  });

  it("copies without staging, dismisses, announces, and briefly keeps the selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const target = stagingTarget();
    render(
      <MarkdownSelectionSurface
        markdown="Copy selected text"
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "copy.md",
          revision: "revision-copy",
        }}
        workspaceId="workspace-1"
        stagingTarget={target}
        selectionDebounceMilliseconds={0}
      />,
    );

    selectText(screen.getByText("Copy selected text").firstChild!, 5, 13);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith("selected");
    expect(target.stage).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copied selected text.",
    );
    expect(document.getSelection()?.toString()).toBe("selected");
  });

  it("keeps the Markdown selection and action visible when clipboard access fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(
      <MarkdownSelectionSurface
        markdown="Keep selected text"
        source={{
          kind: "workspace_file",
          rootId: "primary",
          path: "copy.md",
          revision: "revision-copy",
        }}
        workspaceId="workspace-1"
        stagingTarget={stagingTarget()}
        selectionDebounceMilliseconds={0}
      />,
    );

    selectText(screen.getByText("Keep selected text").firstChild!, 5, 13);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Copy failed");
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(document.getSelection()?.toString()).toBe("selected");
  });
});

function stagingTarget(
  overrides: Partial<ContextExcerptStagingTarget> = {},
): ContextExcerptStagingTarget {
  const available = { available: true } as const;
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    getSnapshot: () => available,
    subscribe: () => () => undefined,
    stage: vi.fn(() => ({ ok: true as const })),
    attachAndSubmit: vi.fn(() => ({ ok: true as const })),
    ...overrides,
  };
}

function selectText(node: Node, start = 0, end?: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end ?? node.textContent?.length ?? 0);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function rectangle(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  };
}
