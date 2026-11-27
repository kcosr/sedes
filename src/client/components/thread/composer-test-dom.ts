import { act, fireEvent } from "@testing-library/react";

/** Read the editor the way a user sees it, including hard line breaks. */
export function composerText(editor: HTMLElement): string {
  return Array.from(editor.childNodes, (node) => {
    if (node instanceof HTMLBRElement)
      return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
    return node.textContent ?? "";
  }).join("");
}

/** Apply a browser's contenteditable DOM change, then let MutationObserver deliver it. */
export async function replaceComposerText(
  editor: HTMLElement,
  text: string,
  input: InputEventInit = { inputType: "insertText" },
): Promise<void> {
  await act(async () => {
    const nodes: Node[] = [];
    for (const line of text.split("\n")) {
      if (nodes.length) nodes.push(document.createElement("br"));
      nodes.push(document.createTextNode(line));
    }
    editor.replaceChildren(...nodes);
    if (document.activeElement === editor) {
      const last = editor.lastChild!;
      document.getSelection()?.collapse(last, last.textContent?.length ?? 0);
    }
    fireEvent.input(editor, input);
  });
}

/** Place the caret as if the user tapped an inline position. Breaks and chips take one position. */
export function setComposerCaret(editor: HTMLElement, offset: number): void {
  fireEvent.touchStart(editor);
  editor.focus();
  let target: Node = editor;
  let targetOffset = editor.childNodes.length;
  for (const [index, node] of Array.from(editor.childNodes).entries()) {
    const isText = node.nodeType === Node.TEXT_NODE;
    const length = isText ? node.textContent!.length : 1;
    if (isText ? offset <= length : offset === 0) {
      target = isText ? node : editor;
      targetOffset = isText ? offset : index;
      break;
    }
    offset -= length;
  }
  document.getSelection()!.collapse(target, targetOffset);
  fireEvent(document, new Event("selectionchange"));
}
