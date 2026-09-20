// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "../components/conversation/MarkdownContent.js";
import type { ContextExcerptStagingTarget } from "./coordinator.js";
import {
  ConversationMessageSelectionSurface,
  conversationMessageSelectableTextProps,
} from "./ConversationMessageSelectionSurface.js";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationMessageSelectionSurface", () => {
  it("stages exact settled plain text with normalized item provenance", async () => {
    const target = stagingTarget({
      stage: vi.fn(() => ({ ok: true as const })),
    });
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="normalized-user-item-1"
        itemRevision={7}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>
          Before selected after
        </span>
      </ConversationMessageSelectionSurface>,
    );

    selectText(screen.getByText("Before selected after").firstChild!, 7, 15);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar", {
      name: "Selected message text actions",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));

    expect(target.stage).toHaveBeenCalledWith({
      id: expect.any(String),
      excerpt: "selected",
      source: {
        kind: "conversation_message",
        itemId: "normalized-user-item-1",
        itemRevision: 7,
      },
      locator: {
        kind: "text_quote",
        prefix: "Before ",
        suffix: " after",
      },
    });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("uses existing Markdown source hints for settled assistant text", async () => {
    const target = stagingTarget();
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="normalized-assistant-item-1"
        itemRevision={9}
        selectionKind="markdown"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <MarkdownContent sourcePositionMetadata>
          {"# Guide\n\nBefore **selected** after"}
        </MarkdownContent>
      </ConversationMessageSelectionSurface>,
    );

    selectText(screen.getByText("selected").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));

    expect(target.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        excerpt: "selected",
        source: {
          kind: "conversation_message",
          itemId: "normalized-assistant-item-1",
          itemRevision: 9,
        },
        locator: {
          kind: "text_quote",
          prefix: "Before ",
          suffix: " after",
          headingTrail: ["Guide"],
          sourceStartLine: 3,
          sourceEndLine: 3,
        },
      }),
    );
  });

  it("keeps a failed immediate note selection open and reports the delivery blocker", async () => {
    const attachAndSubmit = vi.fn(() => ({
      ok: false as const,
      reason: "Wait for attachment uploads to finish before sending.",
    }));
    const target = stagingTarget({ attachAndSubmit });
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="normalized-user-item-1"
        itemRevision={7}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Select this text</span>
      </ConversationMessageSelectionSurface>,
    );

    selectText(screen.getByText("Select this text").firstChild!, 0, 6);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Note about/u }), {
      target: { value: "Explain this." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note & send" }));

    expect(attachAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ excerpt: "Select", note: "Explain this." }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wait for attachment uploads to finish before sending.",
    );
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("rejects cross-message and control-spanning selections", async () => {
    const target = stagingTarget();
    const { rerender } = render(
      <>
        <ConversationMessageSelectionSurface
          enabled
          itemId="item-one"
          itemRevision={1}
          selectionKind="plain_text"
          selectionDebounceMilliseconds={0}
          stagingTarget={target}
        >
          <span {...conversationMessageSelectableTextProps}>First message</span>
        </ConversationMessageSelectionSurface>
        <ConversationMessageSelectionSurface
          enabled
          itemId="item-two"
          itemRevision={1}
          selectionKind="plain_text"
          selectionDebounceMilliseconds={0}
          stagingTarget={target}
        >
          <span {...conversationMessageSelectableTextProps}>Second message</span>
        </ConversationMessageSelectionSurface>
      </>,
    );
    selectAcross(
      screen.getByText("First message").firstChild!,
      screen.getByText("Second message").firstChild!,
    );
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());

    rerender(
      <ConversationMessageSelectionSurface
        enabled
        itemId="item-one"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Ordinary text</span>
        <button type="button">Message control</button>
      </ConversationMessageSelectionSurface>,
    );
    selectAcross(
      screen.getByText("Ordinary text").firstChild!,
      screen.getByText("Message control").firstChild!,
    );
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(target.stage).not.toHaveBeenCalled();
  });

  it("rejects streaming, whitespace-only, and oversized text", async () => {
    const target = stagingTarget();
    const { rerender } = render(
      <ConversationMessageSelectionSurface
        enabled={false}
        itemId="streaming-item"
        itemRevision={2}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Streaming text</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText("Streaming text").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());

    rerender(
      <ConversationMessageSelectionSurface
        enabled
        itemId="settled-item"
        itemRevision={3}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>     </span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(
      document.querySelector<HTMLElement>(
        "[data-conversation-message-text]",
      )!.firstChild!,
    );
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());

    const oversized = "x".repeat(16 * 1_024 + 1);
    rerender(
      <ConversationMessageSelectionSurface
        enabled
        itemId="settled-item"
        itemRevision={4}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>{oversized}</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText(oversized).firstChild!);
    fireEvent(document, new Event("selectionchange"));
    expect(
      await screen.findByText("The selected text is too large to attach."),
    ).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("invalidates pending selection when the normalized item revision changes", async () => {
    const target = stagingTarget();
    const view = render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="stable-item"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Selected text</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText("Selected text").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");

    view.rerender(
      <ConversationMessageSelectionSurface
        enabled
        itemId="stable-item"
        itemRevision={2}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Selected text</span>
      </ConversationMessageSelectionSurface>,
    );
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  });

  it("dismisses the pending action when native selection moves outside the message", async () => {
    const target = stagingTarget();
    render(
      <>
        <ConversationMessageSelectionSurface
          enabled
          itemId="stable-item"
          itemRevision={1}
          selectionKind="plain_text"
          selectionDebounceMilliseconds={0}
          stagingTarget={target}
        >
          <span {...conversationMessageSelectableTextProps}>Selected text</span>
        </ConversationMessageSelectionSurface>
        <p>Outside text</p>
      </>,
    );
    selectText(screen.getByText("Selected text").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");

    selectText(screen.getByText("Outside text").firstChild!);
    fireEvent(document, new Event("selectionchange"));

    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(target.stage).not.toHaveBeenCalled();
  });

  it("invalidates pending selection when the active staging thread changes", async () => {
    const firstTarget = stagingTarget();
    const secondTarget = stagingTarget({ threadId: "thread-2" });
    const view = render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="stable-item"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={firstTarget}
      >
        <span {...conversationMessageSelectableTextProps}>Selected text</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText("Selected text").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");

    view.rerender(
      <ConversationMessageSelectionSurface
        enabled
        itemId="stable-item"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={secondTarget}
      >
        <span {...conversationMessageSelectableTextProps}>Selected text</span>
      </ConversationMessageSelectionSurface>,
    );

    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(firstTarget.stage).not.toHaveBeenCalled();
    expect(secondTarget.stage).not.toHaveBeenCalled();
  });

  it("copies without staging and preserves the native selection briefly", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    const target = stagingTarget();
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="copy-item"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Copy exactly</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText("Copy exactly").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Copy exactly"));
    expect(target.stage).not.toHaveBeenCalled();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copied selected message text.",
    );
    expect(document.getSelection()?.toString()).toBe("Copy exactly");
  });

  it("keeps the overlay and selection available when Copy fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    setClipboard(writeText);
    const target = stagingTarget();
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="copy-item"
        itemRevision={1}
        selectionKind="plain_text"
        selectionDebounceMilliseconds={0}
        stagingTarget={target}
      >
        <span {...conversationMessageSelectableTextProps}>Keep selected</span>
      </ConversationMessageSelectionSurface>,
    );
    selectText(screen.getByText("Keep selected").firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Copy failed. The selection is still available."),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(document.getSelection()?.toString()).toBe("Keep selected");
    expect(target.stage).not.toHaveBeenCalled();
  });

  it("waits for mouse release before copying a selection across Markdown lines", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    const target = stagingTarget();
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="multiline-item"
        itemRevision={1}
        selectionKind="markdown"
        selectionDebounceMilliseconds={5}
        stagingTarget={target}
      >
        <MarkdownContent sourcePositionMetadata>
          {"First selected line.\n\nSecond selected line."}
        </MarkdownContent>
      </ConversationMessageSelectionSurface>,
    );
    const first = screen.getByText("First selected line.");
    const second = screen.getByText("Second selected line.");

    fireEvent.pointerDown(first, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    });
    selectAcross(first.firstChild!, second.firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await delay(20);
    expect(screen.queryByRole("toolbar")).toBeNull();

    fireEvent.pointerUp(second, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    });
    const toolbar = await screen.findByRole("toolbar");
    const exactSelection = document.getSelection()?.toString() ?? "";
    expect(exactSelection).toContain("First selected line.");
    expect(exactSelection).toContain("Second selected line.");
    const copyButton = within(toolbar).getByRole("button", { name: "Copy" });
    fireEvent.pointerDown(copyButton, {
      button: 0,
      isPrimary: true,
      pointerId: 2,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(copyButton, {
      button: 0,
      isPrimary: true,
      pointerId: 2,
      pointerType: "mouse",
    });
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(exactSelection));
    await delay(20);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(target.stage).not.toHaveBeenCalled();
  });

  it("waits for Android-style touch release before opening multi-line actions", async () => {
    const target = stagingTarget();
    render(
      <ConversationMessageSelectionSurface
        enabled
        itemId="touch-item"
        itemRevision={1}
        selectionKind="markdown"
        selectionDebounceMilliseconds={5}
        stagingTarget={target}
      >
        <MarkdownContent sourcePositionMetadata>
          {"Touch first line.\n\nTouch second line."}
        </MarkdownContent>
      </ConversationMessageSelectionSurface>,
    );
    const first = screen.getByText("Touch first line.");
    const second = screen.getByText("Touch second line.");

    fireEvent.touchStart(first, {
      touches: [{ identifier: 1, target: first }],
    });
    selectAcross(first.firstChild!, second.firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await delay(20);
    expect(screen.queryByRole("toolbar")).toBeNull();

    fireEvent.touchEnd(second, { touches: [] });
    await screen.findByRole("toolbar", {
      name: "Selected message text actions",
    });

    // Android's native selection handles can target the document rather than
    // the selected text. Beginning that adjustment must hide the old overlay
    // and wait for the handle release before presenting the new snapshot.
    fireEvent.touchStart(document.body, {
      touches: [{ identifier: 2, target: document.body }],
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
    selectAcross(first.firstChild!, second.firstChild!);
    fireEvent(document, new Event("selectionchange"));
    await delay(20);
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.touchEnd(document.body, { touches: [] });
    await screen.findByRole("toolbar", {
      name: "Selected message text actions",
    });
  });
});

function stagingTarget(
  overrides: Partial<ContextExcerptStagingTarget> = {},
): ContextExcerptStagingTarget {
  const snapshot = { available: true } as const;
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    getSnapshot: () => snapshot,
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

function selectAcross(start: Node, end: Node): void {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent?.length ?? 0);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
