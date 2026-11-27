// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { EditorView } from "prosemirror-view";
import { formatInlineThreadReferenceText, type ThreadReferencePart } from "../../../shared/thread-references.js";
import { ComposerReferenceEditor, type ComposerReferenceEditorHandle } from "./ComposerReferenceEditor.js";
import { composerText, setComposerCaret } from "./composer-test-dom.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const thread = { threadId: "da790f73-7c2c-4da7-b31b-ebf86a26223d", title: "Parked speech" };

function renderEditor(initial: ThreadReferencePart[]) {
  const editor = createRef<ComposerReferenceEditorHandle>();
  function Fixture() {
    const [parts, setParts] = useState(initial);
    return <ComposerReferenceEditor inputRef={useRef(null)} editorRef={editor} parts={parts} disabled={false}
      dragActive={false} placeholder="Message" onReset={() => undefined} rejectComposition={() => false} onCaret={() => undefined}
      onEdit={(next) => { setParts(next); return true; }} />;
  }
  render(<Fixture />);
  return { input: screen.getByRole("textbox"), editor };
}

it("replaces the selected range with a single cursor unit and round-trips the edit through undo and redo", () => {
  const { input, editor } = renderEditor(["🙂 compare @Parked\nnext"]);
  const at = "🙂 compare ".length;
  act(() => { editor.current!.replace(at, at + "@Parked".length, [thread]); });
  expect(composerText(input)).toBe("🙂 compare Parked speech\nnext");
  expect(editor.current!.selection().from).toBe(at + 1);
  expect(screen.getByRole("img", { name: thread.title })).toBeVisible();
  fireEvent.keyDown(input, { key: "z", ctrlKey: true });
  expect(composerText(input)).toBe("🙂 compare @Parked\nnext");
  fireEvent.keyDown(input, { key: "y", ctrlKey: true });
  expect(composerText(input)).toBe("🙂 compare Parked speech\nnext");
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(composerText(input)).toBe("🙂 compare \nnext");
  expect(input.querySelector("[data-thread-reference-id]")).toBeNull();
});

it("pastes multiline text and literal reference-shaped input without activating it", () => {
  const { input } = renderEditor(["literal "]);
  const plain = formatInlineThreadReferenceText([thread]) + "\r\n\uFFFC";
  fireEvent.paste(input, { clipboardData: {
    getData: (type: string) => type === "text/plain" ? plain : '<span data-thread-reference-id="fake">fake</span>',
  } });
  expect(composerText(input)).toBe("literal " + plain.replace(/\r\n/g, "\n"));
  expect(input.querySelector("[data-thread-reference-id]")).toBeNull();
});

it("preserves hard breaks and indentation in a native multiline text replacement beside an atom", () => {
  const { input, editor } = renderEditor([thread, " old"]);
  const textNode = input.lastChild!;
  const event = new InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "insertText", data: "start\n    body\n\nend\n",
  });
  Object.defineProperty(event, "getTargetRanges", {
    value: () => [{ startContainer: textNode, startOffset: 1, endContainer: textNode, endOffset: 4 }],
  });
  fireEvent(input, event);
  expect(event.defaultPrevented).toBe(true);
  expect(composerText(input)).toBe("Parked speech start\n    body\n\nend\n");
  expect(editor.current!.selection().from).toBe(2 + event.data!.length);
});

it("continues typing after pasting over a selected range", async () => {
  const { input, editor } = renderEditor(["Hello world."]);
  setComposerCaret(input, 6);
  const text = input.firstChild!;
  document.getSelection()!.setBaseAndExtent(text, 6, text, 11);
  fireEvent(document, new Event("selectionchange"));
  expect(editor.current!.selection()).toMatchObject({ from: 6, to: 11 });

  fireEvent.paste(input, { clipboardData: { getData: () => "a\r\nfriend" } });
  expect(editor.current!.selection()).toMatchObject({ from: 14, to: 14 });
  await userEvent.keyboard("!");
  expect(composerText(input)).toBe("Hello a\nfriend!.");
});

it("drops external plain text at the pointer and preserves line breaks beside a reference", () => {
  const { input, editor } = renderEditor(["Before ", thread, " after"]);
  const at = "Before ".length;
  const hit = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue({ pos: at, inside: -1, affinity: 0 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 15, clientY: 32, dataTransfer: {
    types: ["text/html", "text/plain"], files: [],
    getData: (type: string) => type === "text/plain" ? "two\r\nlines " : '<p>spoof</p><p><span data-thread-reference-id="fake">reference</span></p>',
  } });
  fireEvent(input, event);
  expect(hit).toHaveBeenCalledWith({ left: 15, top: 32 });
  expect(event.defaultPrevented).toBe(true);
  expect(composerText(input)).toBe("Before two\nlines Parked speech after");
  expect(input.querySelectorAll("[data-thread-reference-id]")).toHaveLength(1);
  expect(editor.current!.selection()).toMatchObject({ from: at + 10, to: at + 10 });
});

it("moves a selected reference inside the editor as an atom", () => {
  const { input, editor } = renderEditor(["A", thread, "B"]);
  setComposerCaret(input, 1);
  document.getSelection()!.setBaseAndExtent(input, 1, input, 2);
  fireEvent(document, new Event("selectionchange"));
  expect(editor.current!.selection()).toMatchObject({ from: 1, to: 2 });
  vi.spyOn(EditorView.prototype, "posAtCoords")
    .mockReturnValueOnce({ pos: 1, inside: -1, affinity: 0 })
    .mockReturnValue({ pos: 3, inside: -1, affinity: 0 });
  const values = new Map<string, string>();
  const dataTransfer = {
    get types() { return [...values.keys()]; },
    files: [], clearData: () => values.clear(),
    setData: (type: string, text: string) => values.set(type, text),
    getData: (type: string) => values.get(type) ?? "",
  };
  fireEvent.dragStart(input, { dataTransfer });
  fireEvent.drop(input, { dataTransfer });
  expect(composerText(input)).toBe("ABParked speech");
  expect(input.querySelectorAll(`[data-thread-reference-id="${thread.threadId}"]`)).toHaveLength(1);
});
