// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ContextExcerpt,
  WorkspaceDiffContextSource,
} from "../../shared/index.js";
import {
  ContextExcerptCard,
  ContextExcerptList,
} from "./ContextExcerptCard.js";

const excerpt: ContextExcerpt = {
  id: "b18128b2-4571-420e-8f26-056eec23d443",
  excerpt: "const answer = 42;",
  source: {
    kind: "workspace_file",
    rootId: "primary",
    path: "src/answer.ts",
    revision: "revision-1",
  },
  locator: { kind: "line_range", startLine: 7, endLine: 7 },
};

const conversationExcerpt: ContextExcerpt = {
  ...excerpt,
  excerpt: "Should I run the browser suite?\nThe build is ready.",
  note: "Run it first.",
  source: {
    kind: "conversation_message",
    itemId: "normalized-item-1",
    itemRevision: 4,
  },
  locator: {
    kind: "text_quote",
    prefix: "Before ",
    suffix: " after",
    sourceStartLine: 13,
    sourceEndLine: 13,
  },
};

describe("ContextExcerptCard", () => {
  it("keeps note editing open when the composer rejects the aggregate", () => {
    const onNoteChange = vi.fn(() => false);
    render(
      <ContextExcerptCard
        excerpt={excerpt}
        editable
        onNoteChange={onNoteChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit note for answer.ts" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Explain this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save excerpt note" }));

    expect(onNoteChange).toHaveBeenCalledWith("Explain this");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This note would make the draft too large.",
    );
    expect(screen.getByRole("textbox", { name: "Note" })).toBeInTheDocument();
  });

  it("leads with the conversation quote and expands it as selectable text", () => {
    render(<ContextExcerptCard excerpt={conversationExcerpt} />);

    const name = "Quote “Should I run the browser suite? The build is ready.”";
    const preview = screen.getByRole("button", {
      name,
    });
    expect(preview).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Run it first.")).toBeVisible();
    expect(screen.queryByText("Conversation message")).not.toBeInTheDocument();
    expect(screen.queryByText("line 13")).not.toBeInTheDocument();
    expect(screen.queryByText("normalized-item-1")).not.toBeInTheDocument();

    fireEvent.click(preview);
    const expanded = screen.getByRole("blockquote");
    expect(expanded.textContent).toBe(conversationExcerpt.excerpt);
    expect(expanded.closest("button")).toBeNull();
    const collapse = screen.getByRole("button", { name });
    expect(collapse).toHaveAttribute("aria-controls", expanded.id);
    expect(collapse.compareDocumentPosition(expanded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(screen.queryByRole("blockquote")).not.toBeInTheDocument();
    expect(preview).toHaveAttribute("aria-expanded", "false");
  });

  it("bounds accessible labels and supports editing and removing a conversation quote", () => {
    const quotedText = "This long conversation quote ".repeat(8).trim();
    const name = `“${quotedText.slice(0, 80)}…”`;
    const longExcerpt = { ...conversationExcerpt, excerpt: quotedText };
    const onNoteChange = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const onRemove = vi.fn();
    const renderCard = (current: ContextExcerpt) => (
      <ContextExcerptCard excerpt={current} editable onNoteChange={onNoteChange} onRemove={onRemove} />
    );
    const view = render(renderCard(longExcerpt));
    const card = within(view.container);
    const toggle = card.getByRole("button", { name: `Quote ${name}` });
    const edit = card.getByRole("button", { name: `Edit note for ${name}` });
    const save = () => fireEvent.click(card.getByRole("button", { name: "Save excerpt note" }));

    fireEvent.click(edit);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(card.getByRole("blockquote").textContent).toBe(quotedText);
    expect(card.queryByText("Run it first.", { selector: "p" })).not.toBeInTheDocument();
    const field = card.getByRole("textbox", { name: "Note" });
    expect(field).toHaveAttribute("rows", "2");
    fireEvent.change(field, { target: { value: "  Check the build.  " } });
    save();
    expect(onNoteChange).toHaveBeenLastCalledWith("Check the build.");
    expect(card.getByRole("alert")).toBeVisible();
    expect(field).toBeVisible();

    fireEvent.click(card.getByRole("button", { name: "Cancel editing excerpt note" }));
    expect(card.getByText("Run it first.")).toBeVisible();
    fireEvent.click(edit);
    fireEvent.change(card.getByRole("textbox", { name: "Note" }), {
      target: { value: "Check the build." },
    });
    save();
    view.rerender(renderCard({ ...longExcerpt, note: "Check the build." }));
    expect(card.getByText("Check the build.")).toBeVisible();
    expect(card.queryByRole("textbox", { name: "Note" })).not.toBeInTheDocument();
    fireEvent.click(card.getByRole("button", { name: `Remove quote ${name}` }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("renders workspace comparison provenance without exposing opaque handles", () => {
    render(
      <ContextExcerptCard
        excerpt={{
          ...excerpt,
          source: {
            kind: "workspace_diff",
            workspaceId: "10000000-0000-4000-8000-000000000001",
            rootId: "primary",
            comparisonId: "comparison-1",
            comparisonFingerprint: "fingerprint-1234567890",
            fileId: "changed-file-1",
            oldPath: "src/old.ts",
            newPath: "src/new.ts",
          } as WorkspaceDiffContextSource,
          locator: {
            kind: "diff_line_range",
            start: { side: "old", line: 7 },
            end: { side: "new", line: 8 },
          },
        }}
      />,
    );

    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByText("old 7 → new 8")).toBeInTheDocument();
    expect(screen.queryByText("comparison-1")).not.toBeInTheDocument();
  });

  it("labels the excerpt collection as an accessible group", () => {
    render(<ContextExcerptList excerpts={[excerpt]} />);
    expect(
      screen.getByRole("group", { name: "Context excerpts" }),
    ).toBeInTheDocument();
  });
});
