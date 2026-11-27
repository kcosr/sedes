import { Fragment, Schema, type Node as EditorNode } from "prosemirror-model";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorView } from "prosemirror-view";
import { useImperativeHandle, useLayoutEffect, useReducer, useRef, type HTMLAttributes, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  threadReferenceDisplayText, type ThreadReference, type ThreadReferencePart,
} from "../../../shared/thread-references.js";
import { InlineThreadReference } from "./InlineThreadReference.js";
import "./composer-reference-editor.css";

const schema = new Schema({
  nodes: {
    doc: { content: "inline*" },
    text: { group: "inline" },
    hard_break: {
      inline: true, group: "inline", selectable: false,
      parseDOM: [{ tag: "br" }], toDOM: () => ["br"],
    },
    thread_reference: {
      inline: true, group: "inline", atom: true, selectable: false,
      attrs: { reference: {} },
      // Clipboard HTML contains only readable text. Only an explicit local
      // selection or sidebar drop can create a new reference.
      toDOM: (node) => ["span", threadReferenceDisplayText([node.attrs.reference])],
    },
  },
});

export function editorOffsetText(parts: readonly ThreadReferencePart[]): string {
  return parts.map((part) => typeof part === "string" ? part : "\uFFFC").join("");
}

function content(parts: readonly ThreadReferencePart[]) {
  const nodes: EditorNode[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      nodes.push(schema.nodes.thread_reference!.create({ reference: part }));
      continue;
    }
    part.split("\n").forEach((line, index) => {
      if (index > 0) nodes.push(schema.nodes.hard_break!.create());
      if (line.length) nodes.push(schema.text(line));
    });
  }
  return Fragment.fromArray(nodes);
}

function replaceWithPlainText(tr: Transaction, from: number, to: number, text: string): Transaction {
  tr.replaceWith(from, to, content([text.replace(/\r\n?/g, "\n")]));
  return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(to))).scrollIntoView();
}

function documentParts(fragment: Fragment): ThreadReferencePart[] {
  const parts: ThreadReferencePart[] = [];
  fragment.forEach((node) => {
    if (node.type === schema.nodes.thread_reference) {
      parts.push(node.attrs.reference as ThreadReference);
    } else {
      const text = node.text ?? "\n";
      const last = parts.length - 1;
      if (typeof parts[last] === "string") parts[last] += text;
      else parts.push(text);
    }
  });
  return parts;
}

const insertBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView());
  return true;
};

function deleteReference(backwards: boolean): Command {
  return (state, dispatch) => {
    const { empty, $from } = state.selection;
    if (!empty || (backwards ? $from.nodeBefore : $from.nodeAfter)?.type !== schema.nodes.thread_reference) return false;
    const from = backwards ? $from.pos - 1 : $from.pos;
    dispatch?.(state.tr.delete(from, from + 1).scrollIntoView());
    return true;
  };
}

function editorState(doc: EditorNode) {
  return EditorState.create({
    doc, selection: TextSelection.create(doc, doc.content.size),
    plugins: [
      history(),
      keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo, Enter: insertBreak, "Shift-Enter": insertBreak,
        Backspace: deleteReference(true), Delete: deleteReference(false) }),
    ],
  });
}

export interface ComposerReferenceEditorHandle {
  selection(): { from: number; to: number };
  dropPosition(x: number, y: number): number;
  showDropCaret(x: number, y: number): void;
  replace(from: number, to: number, parts: readonly ThreadReferencePart[], accept?: (next: ThreadReferencePart[]) => boolean): boolean;
  preview(from: number, to: number, parts: readonly ThreadReferencePart[]): ThreadReferencePart[];
}

interface EditorProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "onSelect"> {
  editorRef: RefObject<ComposerReferenceEditorHandle | null>;
  inputRef: RefObject<HTMLDivElement | null>;
  parts: readonly ThreadReferencePart[];
  placeholder: string;
  disabled: boolean;
  dragActive: boolean;
  onEdit: (parts: ThreadReferencePart[], caret: number | undefined, typed: boolean) => boolean;
  onCaret: (caret: number | undefined) => void;
  onReset: () => void;
  rejectComposition: () => boolean;
}

export function ComposerReferenceEditor(props: EditorProps) {
  const {
    editorRef, inputRef, parts, placeholder, disabled, dragActive, onEdit, onCaret, onReset, rejectComposition, autoFocus, ...attributes
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const editor = useRef<EditorView | null>(null);
  const dropCaret = useRef<HTMLDivElement>(null);
  const nodeViews = useRef(new Map<HTMLElement, ThreadReference>());
  const [, refreshChips] = useReducer((value: number) => value + 1, 0);
  const lastInput = useRef<InputEvent | undefined>(undefined);

  useLayoutEffect(() => {
    const root = inputRef.current!;
    let alive = true;
    const doc = schema.topNodeType.create(null, content(latest.current.parts));
    const view = new EditorView({ mount: root }, {
      state: editorState(doc),
      editable: () => !latest.current.disabled,
      nodeViews: {
        thread_reference(node) {
          const reference: ThreadReference = node.attrs.reference;
          const dom = document.createElement("span");
          dom.contentEditable = "false";
          nodeViews.current.set(dom, reference);
          refreshChips();
          return { dom, ignoreMutation: () => true, destroy: () => {
            nodeViews.current.delete(dom);
            if (alive) refreshChips();
          } };
        },
      },
      clipboardTextSerializer: (slice) => threadReferenceDisplayText(documentParts(slice.content)),
      handleDOMEvents: {
        beforeinput: (view, event) => {
          lastInput.current = event;
          if (!view.editable || !event.cancelable || event.isComposing) return false;
          // Virtual keyboards may insert a new paragraph without a keydown.
          if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
            event.preventDefault();
            return insertBreak(view.state, view.dispatch);
          }
          // Chromium inserts a multiline replacement as sibling block elements.
          // Preserve every newline, including a final blank line, as a hard break.
          const text = event.data ?? event.dataTransfer?.getData("text/plain");
          if (text && /[\r\n]/.test(text) &&
            (event.inputType === "insertText" || event.inputType === "insertReplacementText")) {
            const target = event.getTargetRanges?.()[0];
            const from = target ? view.posAtDOM(target.startContainer, target.startOffset) : view.state.selection.from;
            const to = target ? view.posAtDOM(target.endContainer, target.endOffset) : view.state.selection.to;
            event.preventDefault();
            view.dispatch(replaceWithPlainText(view.state.tr, from, to, text));
            return true;
          }
          return false;
        },
        input: (_view, event) => { lastInput.current = event as InputEvent; return false; },
        paste: (view, event) => {
          if (!view.editable || !event.clipboardData) return false;
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          const { from, to } = view.state.selection;
          if (text) view.dispatch(replaceWithPlainText(closeHistory(view.state.tr), from, to, text).setMeta("paste", true));
          return true;
        },
        drop: (view, event) => {
          const transfer = event.dataTransfer;
          // Internal editor moves carry a trusted slice. Sidebar and file
          // drops have already been handled by the composer's capture handler.
          if (!view.editable || view.dragging || !transfer || transfer.files.length) return false;
          if (!transfer.types.includes("text/plain") && !transfer.types.includes("text/html")) return false;
          event.preventDefault();
          const text = transfer.getData("text/plain");
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (text && hit) {
            lastInput.current = undefined;
            view.dispatch(replaceWithPlainText(closeHistory(view.state.tr), hit.pos, hit.pos, text).setMeta("uiEvent", "drop"));
            view.focus();
          }
          return true;
        },
      },
      dispatchTransaction(tr) {
        const input = lastInput.current;
        if (tr.docChanged) {
          lastInput.current = undefined;
          if ((tr.getMeta("composition") || input?.isComposing || /composition/i.test(input?.inputType ?? "")) &&
            latest.current.rejectComposition()) {
            // Non-cancelable IME events can arrive just after Send. Rebuild
            // from accepted state before the late DOM mutation reaches a draft.
            view.updateState(view.state);
            return;
          }
        }
        const selection = tr.selection;
        const caret = selection.empty ? selection.from : undefined;
        if (tr.docChanged) {
          const typed = input?.inputType === "insertText" && !input.isComposing && !tr.getMeta("paste");
          if (!latest.current.onEdit(documentParts(tr.doc.content), caret, typed)) {
            view.updateState(view.state);
            return;
          }
        }
        view.updateState(view.state.apply(tr));
        if (!tr.docChanged && tr.selectionSet) latest.current.onCaret(caret);
      },
    });
    editor.current = view;
    if (latest.current.autoFocus && !latest.current.disabled) view.focus();
    return () => { alive = false; view.destroy(); editor.current = null; };
  }, [inputRef]);

  useLayoutEffect(() => {
    const view = editor.current!;
    const doc = schema.topNodeType.create(null, content(parts));
    // An authoritative restore, remote edit, or Send starts a new history.
    // Local keystroke echoes keep the existing selection and undo stack.
    if (!view.state.doc.eq(doc)) {
      view.updateState(editorState(doc));
      latest.current.onReset();
    }
  }, [parts]);
  useLayoutEffect(() => { editor.current!.setProps({ editable: () => !disabled }); }, [disabled]);
  useLayoutEffect(() => {
    if (!dragActive && dropCaret.current) dropCaret.current.hidden = true;
  }, [dragActive]);

  useImperativeHandle(editorRef, () => {
    const dropPosition = (x: number, y: number) => {
      const view = editor.current!;
      const rect = view.dom.getBoundingClientRect();
      const style = getComputedStyle(view.dom);
      // The card and editor padding keep the remembered insertion point.
      if (rect.width && x >= rect.left + parseFloat(style.paddingLeft) && x <= rect.right - parseFloat(style.paddingRight) &&
        y >= rect.top + parseFloat(style.paddingTop) && y <= rect.bottom - parseFloat(style.paddingBottom)) {
        return view.posAtCoords({ left: x, top: y })?.pos ?? view.state.selection.head;
      }
      return view.state.selection.head;
    };
    return {
      selection: () => editor.current!.state.selection,
      dropPosition,
      showDropCaret(x, y) {
        const view = editor.current!;
        const caret = dropCaret.current!;
        const coords = view.coordsAtPos(dropPosition(x, y));
        const surface = view.dom.parentElement!;
        const bounds = surface.getBoundingClientRect();
        caret.style.left = `${coords.left - bounds.left - surface.clientLeft}px`;
        caret.style.top = `${coords.top - bounds.top - surface.clientTop}px`;
        caret.style.height = `${Math.max(12, coords.bottom - coords.top)}px`;
        caret.hidden = false;
      },
      preview(from, to, parts) {
        return documentParts(editor.current!.state.tr.replaceWith(from, to, content(parts)).doc.content);
      },
      replace(from, to, parts, accept) {
        const view = editor.current!;
        const tr = closeHistory(view.state.tr).replaceWith(from, to, content(parts));
        if (accept && !accept(documentParts(tr.doc.content))) return false;
        tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(to)));
        lastInput.current = undefined;
        view.dispatch(tr);
        view.dispatch(closeHistory(view.state.tr));
        view.focus();
        return true;
      },
    };
  }, []);

  return <>
    <div {...attributes} ref={inputRef} className="composer-editor" role="textbox" aria-multiline="true"
      aria-disabled={disabled} aria-placeholder={placeholder} {...{ placeholder }}
      data-empty={parts.every((part) => part === "") ? "true" : undefined} />
    <div ref={dropCaret} className="composer-drop-caret" hidden aria-hidden="true" />
    {Array.from(nodeViews.current, ([dom, reference]) => createPortal(<InlineThreadReference reference={reference} editing />, dom))}
  </>;
}
