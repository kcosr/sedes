// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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
    const quote = "Should I run the browser suite?\nThe build is ready.";
    render(
      <ContextExcerptCard
        excerpt={{
          ...excerpt,
          excerpt: quote,
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
        }}
      />,
    );

    const preview = screen.getByRole("button", {
      name: "Should I run the browser suite? The build is ready.",
    });
    expect(preview).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Run it first.")).toBeVisible();
    expect(screen.queryByText("Conversation message")).not.toBeInTheDocument();
    expect(screen.queryByText("line 13")).not.toBeInTheDocument();
    expect(screen.queryByText("normalized-item-1")).not.toBeInTheDocument();

    fireEvent.click(preview);
    const expanded = screen.getByRole("blockquote");
    expect(expanded.textContent).toBe(quote);
    expect(expanded.closest("button")).toBeNull();
    const collapse = screen.getByRole("button", { name: "Collapse quote" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(screen.queryByRole("blockquote")).not.toBeInTheDocument();
    expect(preview).toHaveAttribute("aria-expanded", "false");
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
