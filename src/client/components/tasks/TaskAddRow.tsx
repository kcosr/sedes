import { useRef, type Ref } from "react";
import { AlignLeft, Plus } from "lucide-react";
import { TASK_DETAILS_MAX_CHARACTERS } from "../../../shared/index.js";
import { Button } from "../ui/button.js";
import {
  parsePastedTitles,
  TASK_TITLE_MAX_CHARACTERS,
} from "./task-view-model.js";

export interface TaskAddDraft {
  readonly title: string;
  readonly notes: string;
  readonly notesOpen: boolean;
}

export const EMPTY_TASK_ADD_DRAFT: TaskAddDraft = {
  title: "",
  notes: "",
  notesOpen: false,
};

/**
 * The dedicated add row: it never filters the list and is never disabled.
 * Enter adds and keeps focus for the next task; Shift+Enter (or Add
 * details) opens a notes field; pasting several lines asks to create one
 * task per line. `row` sits under the scope control; `bar` is the phone
 * sheet's bottom bar with its own add button.
 */
export function TaskAddRow({
  variant,
  placeholder,
  draft,
  inputRef,
  onDraftChange,
  onAdd,
  onPasteMany,
}: {
  readonly variant: "row" | "bar";
  readonly placeholder: string;
  readonly draft: TaskAddDraft;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly onDraftChange: (draft: TaskAddDraft) => void;
  readonly onAdd: (title: string, notes: string) => void;
  readonly onPasteMany: (titles: readonly string[]) => void;
}): React.JSX.Element {
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const hasTitle = draft.title.trim().length > 0;

  const submit = () => {
    const title = draft.title.trim();
    if (title.length === 0) return;
    onAdd(title, draft.notesOpen ? draft.notes.trim() : "");
    onDraftChange(EMPTY_TASK_ADD_DRAFT);
    titleRef.current?.focus();
  };
  const openNotes = () => {
    onDraftChange({ ...draft, notesOpen: true });
    requestAnimationFrame(() => notesRef.current?.focus());
  };

  const setInput = (node: HTMLInputElement | null) => {
    titleRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  };

  return (
    <div
      className="tasks-add"
      data-variant={variant}
      data-notes={draft.notesOpen || undefined}
    >
      <div className="tasks-add-field">
        {variant === "row" && <Plus className="tasks-add-icon" aria-hidden="true" />}
        <input
          ref={setInput}
          type="text"
          className="tasks-add-input"
          // The docked panel focuses the add row on open.
          data-panel-autofocus=""
          aria-label="Add a task"
          placeholder={placeholder}
          autoComplete="off"
          enterKeyHint="done"
          maxLength={TASK_TITLE_MAX_CHARACTERS}
          value={draft.title}
          onChange={(event) =>
            onDraftChange({ ...draft, title: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              openNotes();
            } else if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && (draft.title || draft.notesOpen)) {
              event.preventDefault();
              event.stopPropagation();
              onDraftChange(EMPTY_TASK_ADD_DRAFT);
            }
          }}
          onPaste={(event) => {
            const titles = parsePastedTitles(
              event.clipboardData.getData("text/plain"),
            );
            if (titles.length < 2) return;
            event.preventDefault();
            onPasteMany(titles);
          }}
        />
        {variant === "row" && hasTitle && !draft.notesOpen && (
          <span className="tasks-add-hint" aria-hidden="true">
            ↵ add · ⇧↵ notes
          </span>
        )}
        {hasTitle && !draft.notesOpen && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="tasks-add-details"
            aria-label="Add details"
            title="Add details (Shift+Enter)"
            onClick={openNotes}
          >
            <AlignLeft aria-hidden="true" />
          </Button>
        )}
        {variant === "bar" && (
          <Button
            type="button"
            size="icon"
            className="tasks-add-submit"
            aria-label="Add task"
            onClick={submit}
            disabled={!hasTitle}
          >
            <Plus aria-hidden="true" />
          </Button>
        )}
      </div>
      {draft.notesOpen && (
        <div className="tasks-add-notes">
          <textarea
            ref={notesRef}
            className="tasks-add-notes-input"
            aria-label="New task notes"
            placeholder="Notes"
            rows={3}
            maxLength={TASK_DETAILS_MAX_CHARACTERS}
            value={draft.notes}
            onChange={(event) =>
              onDraftChange({ ...draft, notes: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onDraftChange({ ...draft, notes: "", notesOpen: false });
                titleRef.current?.focus();
              }
            }}
          />
          <div className="tasks-add-notes-actions">
            <span className="tasks-add-hint" aria-hidden="true">
              Ctrl/⌘↵ add
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onDraftChange({ ...draft, notes: "", notesOpen: false });
                titleRef.current?.focus();
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!hasTitle}
              onClick={submit}
            >
              Add task
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
