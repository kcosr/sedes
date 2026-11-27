// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { formatInlineThreadReferenceText, type ThreadReferencePart } from "../../../shared/thread-references.js";
import { ComposerReferenceEditor, type ComposerReferenceEditorHandle } from "./ComposerReferenceEditor.js";
import { composerText } from "./composer-test-dom.js";

afterEach(cleanup);
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
