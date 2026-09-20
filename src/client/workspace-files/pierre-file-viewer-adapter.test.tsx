// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pierreCaptures = vi.hoisted(() => ({
  codeViewProps: [] as Array<Record<string, unknown>>,
  providerProps: [] as Array<Record<string, unknown>>,
  scrollTo: vi.fn(),
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    CodeView: React.forwardRef<unknown, Record<string, unknown>>(
      function MockCodeView(props, ref) {
        React.useImperativeHandle(ref, () => ({
          scrollTo: pierreCaptures.scrollTo,
        }), []);
        pierreCaptures.codeViewProps.push(props);
        return <div data-testid="code-view" />;
      },
    ),
    EditProvider: (
      props: Record<string, unknown> & { children: React.ReactNode },
    ) => {
      pierreCaptures.providerProps.push(props);
      return props.children;
    },
  };
});

vi.mock("@pierre/diffs/edit", () => ({
  Editor: class MockEditor {
    constructor(readonly options: unknown) {}
  },
}));

import { PierreFileViewer } from "./pierre-file-viewer.js";

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  pierreCaptures.codeViewProps.length = 0;
  pierreCaptures.providerProps.length = 0;
  pierreCaptures.scrollTo.mockReset();
});

describe("PierreFileViewer edit adapter", () => {
  it("seeks a source line through Pierre and handles each intent once", () => {
    const onSeekHandled = vi.fn();
    const view = render(
      <PierreFileViewer
        path="src/index.ts"
        content={"one\ntwo\nthree"}
        revision="revision-1"
        editing={false}
        onSeekHandled={onSeekHandled}
        onChange={vi.fn()}
        seek={{ sequence: 4, lineNumber: 2 }}
      />,
    );

    expect(pierreCaptures.scrollTo).toHaveBeenCalledExactlyOnceWith({
      type: "line",
      id: "src/index.ts",
      lineNumber: 2,
      align: "center",
      behavior: "smooth-auto",
    });
    expect(screen.getByText("Opened line 2.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByTestId("code-view").parentElement).toHaveFocus();
    expect(onSeekHandled).toHaveBeenCalledExactlyOnceWith(4);

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content={"one\ntwo\nthree"}
        revision="revision-1"
        editing={false}
        onSeekHandled={onSeekHandled}
        onChange={vi.fn()}
        seek={{ sequence: 4, lineNumber: 2 }}
      />,
    );
    expect(pierreCaptures.scrollTo).toHaveBeenCalledOnce();
    expect(onSeekHandled).toHaveBeenCalledOnce();
  });

  it("reports a line outside a truncated Pierre preview", () => {
    const onSeekHandled = vi.fn();
    render(
      <PierreFileViewer
        path="src/index.ts"
        content={"one\ntwo"}
        revision="revision-1"
        editing={false}
        onSeekHandled={onSeekHandled}
        onChange={vi.fn()}
        seek={{ sequence: 5, lineNumber: 20 }}
        truncated
      />,
    );

    expect(pierreCaptures.scrollTo).not.toHaveBeenCalled();
    expect(
      screen.getByText("Line 20 is outside this truncated preview."),
    ).toHaveAttribute("role", "status");
    expect(onSeekHandled).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("offers a committed read-only line selection and snapshots current bytes", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onAttachSelection = vi.fn(() => ({ ok: true as const }));
    render(
      <PierreFileViewer
        path="src/index.ts"
        content={"one\r\ntwo\r\nthree"}
        revision="revision-1"
        editing={false}
        onAttachSelection={onAttachSelection}
        onChange={vi.fn()}
      />,
    );
    const props = pierreCaptures.codeViewProps.at(-1)!;
    expect(props.options).toMatchObject({ enableLineSelection: true });
    const select = props.onSelectedLinesChange as (selection: unknown) => void;
    const committed = (
      props.options as {
        onLineSelected(range: unknown): void;
      }
    ).onLineSelected;
    const selection = { id: "src/index.ts", range: { start: 2, end: 3 } };
    act(() => {
      select(selection);
      committed(selection.range);
    });
    expect(
      screen.getByRole("toolbar", {
        name: "Actions for selected lines 2–3",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("selected lines 2–3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
    expect(onAttachSelection).toHaveBeenCalledWith({
      excerpt: "two\r\nthree",
      startLine: 2,
      endLine: 3,
    });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByTestId("code-view").parentElement).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("announces an oversized selection immediately without staging", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onAttachSelection = vi.fn(() => ({ ok: true as const }));
    render(
      <PierreFileViewer
        path="src/large.ts"
        content={"x".repeat(16 * 1_024 + 1)}
        revision="revision-1"
        editing={false}
        onAttachSelection={onAttachSelection}
        onChange={vi.fn()}
      />,
    );
    const props = pierreCaptures.codeViewProps.at(-1)!;
    act(() => {
      (
        props.options as { onLineSelected(range: unknown): void }
      ).onLineSelected({ start: 1, end: 1 });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The selected lines are too large to attach.",
    );
    expect(onAttachSelection).not.toHaveBeenCalled();
  });

  it("rejects an oversized note before calling the staging target", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onAttachSelection = vi.fn(() => ({ ok: true as const }));
    render(
      <PierreFileViewer
        path="src/index.ts"
        content="one"
        revision="revision-1"
        editing={false}
        onAttachSelection={onAttachSelection}
        onChange={vi.fn()}
      />,
    );
    const props = pierreCaptures.codeViewProps.at(-1)!;
    act(() => {
      (
        props.options as { onLineSelected(range: unknown): void }
      ).onLineSelected({ start: 1, end: 1 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note for agent" }), {
      target: { value: "x".repeat(4 * 1_024 + 1) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The note is too large to attach.",
    );
    expect(onAttachSelection).not.toHaveBeenCalled();
  });

  it("does not enable line attachment while editing", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    render(
      <PierreFileViewer
        path="src/index.ts"
        content="one"
        revision="revision-1"
        editing
        onAttachSelection={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(pierreCaptures.codeViewProps.at(-1)!.options).toMatchObject({
      enableLineSelection: false,
    });
  });

  it("uses distinct cache namespaces for separate viewer instances", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onChange = vi.fn();
    render(
      <>
        <PierreFileViewer
          path="README.md"
          content="workspace one"
          revision="revision-1"
          editing={false}
          onChange={onChange}
        />
        <PierreFileViewer
          path="README.md"
          content="workspace two"
          revision="revision-1"
          editing={false}
          onChange={onChange}
        />
      </>,
    );

    const cacheKeys = pierreCaptures.codeViewProps.map(
      (props) =>
        (props.items as Array<{ file: { cacheKey: string } }>)[0]!.file
          .cacheKey,
    );
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it("keeps Pierre's active editor record across live echoes and refreshes authoritative transitions", () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onChange = vi.fn();
    const view = render(
      <PierreFileViewer
        path="src/index.ts"
        content="one"
        revision="revision-1"
        editing={false}
        onChange={onChange}
      />,
    );
    const firstProvider = pierreCaptures.providerProps.at(-1)!;
    const firstCodeView = pierreCaptures.codeViewProps.at(-1)!;
    const firstItem = (
      firstCodeView.items as Array<{
        file: { cacheKey: string };
        version: number;
      }>
    )[0]!;

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content="two"
        revision="revision-1"
        editing
        onChange={onChange}
      />,
    );
    const secondProvider = pierreCaptures.providerProps.at(-1)!;
    const secondCodeView = pierreCaptures.codeViewProps.at(-1)!;
    const secondItem = (
      secondCodeView.items as Array<{
        file: { cacheKey: string };
        version: number;
      }>
    )[0]!;

    expect(secondProvider.createEditor).toBe(firstProvider.createEditor);
    expect(secondCodeView.editorOptions).toBe(firstCodeView.editorOptions);
    expect(secondItem.version).toBeGreaterThan(firstItem.version);
    expect(secondItem.file.cacheKey).not.toBe(firstItem.file.cacheKey);

    const publish = secondCodeView.onItemEditChange as (
      item: unknown,
      file: { contents: string },
    ) => void;
    publish({}, { contents: "" });
    expect(onChange).toHaveBeenCalledWith("");

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content=""
        revision="revision-1"
        editing
        onChange={onChange}
      />,
    );
    const liveEchoCodeView = pierreCaptures.codeViewProps.at(-1)!;
    const liveEchoItem = (
      liveEchoCodeView.items as Array<{
        file: { cacheKey: string; contents: string };
        version: number;
      }>
    )[0]!;
    expect(liveEchoItem.version).toBe(secondItem.version);
    expect(liveEchoItem.file.cacheKey).toBe(secondItem.file.cacheKey);
    expect(liveEchoItem.file.contents).toBe("");

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content=""
        revision="revision-2"
        editing
        onChange={onChange}
      />,
    );
    const savedWhileEditingItem = (
      pierreCaptures.codeViewProps.at(-1)!.items as Array<{
        file: { cacheKey: string; contents: string };
        version: number;
      }>
    )[0]!;
    expect(savedWhileEditingItem.version).toBe(liveEchoItem.version);
    expect(savedWhileEditingItem.file.cacheKey).toBe(
      liveEchoItem.file.cacheKey,
    );
    expect(savedWhileEditingItem.file.contents).toBe("");

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content="authoritative divergence"
        revision="revision-3"
        editing
        onChange={onChange}
      />,
    );
    const divergentItem = (
      pierreCaptures.codeViewProps.at(-1)!.items as Array<{
        file: { cacheKey: string; contents: string };
        version: number;
      }>
    )[0]!;
    expect(divergentItem.version).toBeGreaterThan(
      savedWhileEditingItem.version,
    );
    expect(divergentItem.file.cacheKey).not.toBe(
      savedWhileEditingItem.file.cacheKey,
    );
    expect(divergentItem.file.contents).toBe("authoritative divergence");

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content="authoritative divergence"
        revision="revision-3"
        editing={false}
        onChange={onChange}
      />,
    );
    const doneItem = (
      pierreCaptures.codeViewProps.at(-1)!.items as Array<{
        file: { cacheKey: string; contents: string };
        version: number;
      }>
    )[0]!;
    expect(doneItem.version).toBeGreaterThan(divergentItem.version);
    expect(doneItem.file.contents).toBe("authoritative divergence");

    view.rerender(
      <PierreFileViewer
        path="src/index.ts"
        content="authoritative reload"
        revision="revision-4"
        editing={false}
        onChange={onChange}
      />,
    );
    const reloadedItem = (
      pierreCaptures.codeViewProps.at(-1)!.items as Array<{
        file: { cacheKey: string; contents: string };
        version: number;
      }>
    )[0]!;
    expect(reloadedItem.version).toBeGreaterThan(doneItem.version);
    expect(reloadedItem.file.contents).toBe("authoritative reload");
  });
});
