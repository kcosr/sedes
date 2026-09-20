// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileDiffCaptures = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const multiFileDiffCaptures = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const stagingCaptures = vi.hoisted(() => ({
  available: true,
  stage: vi.fn((): { readonly ok: true } => ({ ok: true })),
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: Record<string, unknown>) => {
    fileDiffCaptures.props.push(props);
    return <div data-testid="mock-file-diff" />;
  },
  MultiFileDiff: (props: Record<string, unknown>) => {
    multiFileDiffCaptures.props.push(props);
    return <div data-testid="mock-multi-file-diff" />;
  },
}));

vi.mock("../../context-excerpts/coordinator.js", () => ({
  useContextExcerptStaging: () => ({ stage: stagingCaptures.stage }),
  useContextExcerptStagingSnapshot: () => ({
    available: stagingCaptures.available,
  }),
}));

import { PierreFileChangeDiff } from "./pierre-file-change-diff.js";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  fileDiffCaptures.props.length = 0;
  multiFileDiffCaptures.props.length = 0;
  stagingCaptures.available = true;
  stagingCaptures.stage.mockClear();
});

describe("PierreFileChangeDiff", () => {
  it("passes prepared metadata to FileDiff for a synthesizable bare hunk", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-1"
        itemRevision={1}
        itemStatus="completed"
        path="src/example.ts"
        source={{
          kind: "unified_patch",
          text: "@@ -1 +1 @@\n-old\n+new",
        }}
        wrap
      />,
    );

    expect(screen.getByTestId("pierre-file-change-diff")).toBeInTheDocument();
    expect(screen.getByTestId("mock-file-diff")).toBeInTheDocument();
    expect(fileDiffCaptures.props).toHaveLength(1);
    const fileDiff = fileDiffCaptures.props[0]!.fileDiff as {
      lang?: string;
      hunks: unknown[];
    };
    expect(fileDiff.lang).toBe("typescript");
    expect(fileDiff.hunks.length).toBeGreaterThan(0);
    expect(fileDiffCaptures.props[0]!.options).toMatchObject({
      diffStyle: "unified",
      disableFileHeader: true,
      overflow: "wrap",
      hunkSeparators: "simple",
      enableLineSelection: true,
    });
  });

  it("stages a committed settled cross-side selection with its item revision", () => {
    stagingCaptures.stage.mockReturnValueOnce({ ok: true });
    render(
      <PierreFileChangeDiff
        destinationPath="src/renamed.ts"
        itemId="item-7"
        itemRevision={4}
        itemStatus="completed"
        path="src/example.ts"
        source={{
          kind: "unified_patch",
          text: "@@ -1 +1 @@\n-old\n+new",
        }}
      />,
    );
    const options = fileDiffCaptures.props[0]!.options as {
      onLineSelectionChange(range: unknown): void;
      onLineSelected(range: unknown): void;
    };
    const range = {
      start: 1,
      end: 1,
      side: "deletions",
      endSide: "additions",
    };
    act(() => {
      options.onLineSelectionChange(range);
      options.onLineSelected(range);
    });
    expect(
      screen.getByRole("toolbar", {
        name: "Actions for selected old 1 → new 1",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("selected old 1 → new 1"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note for agent" }), {
      target: { value: "Check this rename" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(stagingCaptures.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        excerpt: "old\nnew",
        note: "Check this rename",
        source: {
          kind: "conversation_diff",
          itemId: "item-7",
          itemRevision: 4,
          path: "src/example.ts",
          destinationPath: "src/renamed.ts",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "old", line: 1 },
          end: { side: "new", line: 1 },
        },
      }),
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByTestId("pierre-file-change-diff")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("disables selection while the item is streaming", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-1"
        itemRevision={2}
        itemStatus="streaming"
        path="src/example.ts"
        source={{
          kind: "unified_patch",
          text: "@@ -1 +1 @@\n-old\n+new",
        }}
      />,
    );
    expect(fileDiffCaptures.props[0]!.options).toMatchObject({
      enableLineSelection: false,
    });
  });

  it("reports invalid serialized provenance before calling the staging target", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-1"
        itemRevision={1}
        itemStatus="completed"
        path={`${"x".repeat(4_096)}.ts`}
        source={{
          kind: "unified_patch",
          text: "@@ -1 +1 @@\n-old\n+new",
        }}
      />,
    );
    const options = fileDiffCaptures.props[0]!.options as {
      onLineSelectionChange(range: unknown): void;
      onLineSelected(range: unknown): void;
    };
    const range = { start: 1, end: 1, side: "additions" };
    act(() => {
      options.onLineSelectionChange(range);
      options.onLineSelected(range);
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Context provenance path exceeds the UTF-8 byte limit.",
    );
    expect(stagingCaptures.stage).not.toHaveBeenCalled();
  });

  it("falls back to legacy content when prepare rejects a multi-file patch", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-1"
        itemRevision={1}
        itemStatus="completed"
        path="a.ts"
        source={{
          kind: "unified_patch",
          text: [
            "--- a.ts",
            "+++ a.ts",
            "@@ -1 +1 @@",
            "-a",
            "+A",
            "--- b.ts",
            "+++ b.ts",
            "@@ -1 +1 @@",
            "-b",
            "+B",
          ].join("\n"),
        }}
      />,
    );

    expect(screen.queryByTestId("pierre-file-change-diff")).toBeNull();
    expect(screen.queryByTestId("mock-file-diff")).toBeNull();
    expect(screen.getByTestId("diff-block")).toBeInTheDocument();
  });

  it("maps wrap=false to scroll overflow", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-1"
        itemRevision={1}
        itemStatus="completed"
        path="src/example.ts"
        source={{
          kind: "unified_patch",
          text: "@@ -1 +1 @@\n-old\n+new",
        }}
        wrap={false}
      />,
    );
    expect(fileDiffCaptures.props[0]!.options).toMatchObject({
      overflow: "scroll",
    });
  });

  it("renders a whole-file write as a typed new-file diff", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-write"
        itemRevision={3}
        itemStatus="completed"
        path="src/新しい.ts"
        source={{
          kind: "whole_file_write",
          content: "const π = 3.14;\r\nexport { π };\r\n",
        }}
      />,
    );

    const fileDiff = fileDiffCaptures.props[0]!.fileDiff as {
      name: string;
      type: string;
      lang: string;
      additionLines: string[];
      deletionLines: string[];
    };
    expect(fileDiff).toMatchObject({
      name: "src/新しい.ts",
      type: "new",
      lang: "typescript",
      additionLines: ["const π = 3.14;\r\n", "export { π };\r\n"],
      deletionLines: [],
    });
  });

  it("renders a replacement preview from both snippets without line provenance", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-edit"
        itemRevision={5}
        itemStatus="completed"
        path="src/example.ts"
        source={{
          kind: "replacement_preview",
          oldContent: "const before = true;\n",
          newContent: "const after = true;\n",
        }}
      />,
    );

    expect(screen.getByTestId("mock-multi-file-diff")).toBeInTheDocument();
    expect(fileDiffCaptures.props).toHaveLength(0);
    expect(multiFileDiffCaptures.props).toHaveLength(1);
    expect(multiFileDiffCaptures.props[0]).toMatchObject({
      oldFile: {
        name: "src/example.ts",
        contents: "const before = true;\n",
        lang: "typescript",
      },
      newFile: {
        name: "src/example.ts",
        contents: "const after = true;\n",
        lang: "typescript",
      },
      options: {
        diffStyle: "unified",
        disableFileHeader: true,
        disableLineNumbers: true,
        enableLineSelection: false,
      },
    });
    const options = multiFileDiffCaptures.props[0]!.options as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty("onLineSelectionChange");
    expect(options).not.toHaveProperty("onLineSelected");
  });

  it("bounds replacement syntax highlighting to the curated language set", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-unknown-language"
        itemRevision={1}
        itemStatus="completed"
        path="Sources/example.swift"
        source={{
          kind: "replacement_preview",
          oldContent: "let value = 1",
          newContent: "let value = 2",
        }}
      />,
    );

    expect(multiFileDiffCaptures.props[0]).toMatchObject({
      oldFile: { lang: "text" },
      newFile: { lang: "text" },
    });
  });

  it("stages whole-file additions with only new-side provenance", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-write"
        itemRevision={3}
        itemStatus="completed"
        path="notes.md"
        source={{
          kind: "whole_file_write",
          content: "first\r\nsecond",
        }}
      />,
    );
    const options = fileDiffCaptures.props[0]!.options as {
      onLineSelectionChange(range: unknown): void;
      onLineSelected(range: unknown): void;
    };
    const range = { start: 1, end: 2, side: "additions" };
    act(() => {
      options.onLineSelectionChange(range);
      options.onLineSelected(range);
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));

    expect(stagingCaptures.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        excerpt: "first\r\nsecond",
        source: {
          kind: "conversation_diff",
          itemId: "item-write",
          itemRevision: 3,
          path: "notes.md",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "new", line: 1 },
          end: { side: "new", line: 2 },
        },
      }),
    );
  });

  it("presents an explicit empty file without invoking FileDiff", () => {
    render(
      <PierreFileChangeDiff
        itemId="item-empty"
        itemRevision={1}
        itemStatus="completed"
        path="empty.txt"
        source={{ kind: "whole_file_write", content: "" }}
      />,
    );

    expect(screen.getByTestId("pierre-file-change-diff")).toHaveAccessibleName(
      "Diff for empty.txt",
    );
    expect(screen.getByTestId("diff-empty-file")).toHaveTextContent(
      "Empty file.",
    );
    expect(fileDiffCaptures.props).toHaveLength(0);
  });
});
