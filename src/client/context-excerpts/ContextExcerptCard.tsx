import { useState } from "react";
import {
  Check,
  ExternalLink,
  FileText,
  GitCompare,
  MessageSquareText,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { ContextExcerpt } from "../../shared/index.js";

export function ContextExcerptCard({
  excerpt,
  editable = false,
  onNoteChange,
  onRemove,
  onOpen,
}: {
  readonly excerpt: ContextExcerpt;
  readonly editable?: boolean;
  readonly onNoteChange?: (note?: string) => boolean | void;
  readonly onRemove?: () => void;
  readonly onOpen?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(excerpt.note ?? "");
  const [noteError, setNoteError] = useState<string>();
  const path = sourcePath(excerpt);
  const label = path.split("/").at(-1) ?? path;
  const SourceIcon =
    excerpt.source.kind === "conversation_diff" ||
    excerpt.source.kind === "workspace_diff"
      ? GitCompare
      : excerpt.source.kind === "conversation_message"
        ? MessageSquareText
        : FileText;

  const saveNote = () => {
    const normalized = note.trim();
    const accepted = onNoteChange?.(normalized || undefined);
    if (accepted === false) {
      setNoteError("This note would make the draft too large.");
      return;
    }
    setNoteError(undefined);
    setEditingNote(false);
  };

  return (
    <article
      className="context-excerpt-card"
      data-context-excerpt-id={excerpt.id}
    >
      <div className="context-excerpt-card-heading">
        <button
          type="button"
          className="context-excerpt-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <SourceIcon size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>
            <strong>{label}</strong>
            <small>{locatorLabel(excerpt)}</small>
          </span>
        </button>
        <div className="context-excerpt-card-actions">
          {onOpen && (
            <button type="button" aria-label={`Open ${path}`} onClick={onOpen}>
              <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {editable && onNoteChange && (
            <button
              type="button"
              aria-label={`Edit note for ${label}`}
              onClick={() => {
                setNote(excerpt.note ?? "");
                setNoteError(undefined);
                setEditingNote(true);
                setExpanded(true);
              }}
            >
              <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {editable && onRemove && (
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={onRemove}
            >
              <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {!expanded && (
        <p className="context-excerpt-preview">
          {(excerpt.note ?? excerpt.excerpt).replace(/\s+/g, " ").trim()}
        </p>
      )}
      {expanded && (
        <div className="context-excerpt-details">
          <small className="context-excerpt-path">{path}</small>
          <pre>{excerpt.excerpt}</pre>
          {editingNote ? (
            <div className="context-excerpt-note-editor">
              <label>
                <span>Note</span>
                <textarea
                  rows={3}
                  value={note}
                  placeholder="What should the agent do with this excerpt?"
                  onChange={(event) => setNote(event.target.value)}
                  aria-invalid={noteError ? true : undefined}
                  aria-describedby={
                    noteError ? `context-note-error-${excerpt.id}` : undefined
                  }
                />
              </label>
              {noteError && (
                <small id={`context-note-error-${excerpt.id}`} role="alert">
                  {noteError}
                </small>
              )}
              <div>
                <button
                  type="button"
                  onClick={saveNote}
                  aria-label="Save excerpt note"
                >
                  <Check size={13} aria-hidden="true" /> Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingNote(false)}
                  aria-label="Cancel editing excerpt note"
                >
                  <X size={13} aria-hidden="true" /> Cancel
                </button>
              </div>
            </div>
          ) : excerpt.note ? (
            <p className="context-excerpt-note">
              <strong>Note:</strong> {excerpt.note}
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}

export function ContextExcerptList({
  excerpts,
  editable = false,
  onNoteChange,
  onRemove,
}: {
  readonly excerpts: readonly ContextExcerpt[];
  readonly editable?: boolean;
  readonly onNoteChange?: (id: string, note?: string) => boolean | void;
  readonly onRemove?: (id: string) => void;
}): React.JSX.Element | null {
  if (excerpts.length === 0) return null;
  return (
    <div
      className="context-excerpt-list"
      aria-label="Context excerpts"
      role="group"
    >
      {excerpts.map((excerpt) => (
        <ContextExcerptCard
          key={excerpt.id}
          excerpt={excerpt}
          editable={editable}
          onNoteChange={
            onNoteChange ? (note) => onNoteChange(excerpt.id, note) : undefined
          }
          onRemove={onRemove ? () => onRemove(excerpt.id) : undefined}
        />
      ))}
    </div>
  );
}

export function contextExcerptArraysEqual(
  left: readonly ContextExcerpt[],
  right: readonly ContextExcerpt[],
): boolean {
  return (
    left.length === right.length &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

function sourcePath(excerpt: ContextExcerpt): string {
  switch (excerpt.source.kind) {
    case "conversation_diff":
      return excerpt.source.destinationPath ?? excerpt.source.path;
    case "workspace_diff":
      return excerpt.source.newPath ?? excerpt.source.oldPath ?? "Changed file";
    case "workspace_file":
      return excerpt.source.path;
    case "conversation_message":
      return "Conversation message";
  }
}

function locatorLabel(excerpt: ContextExcerpt): string {
  const locator = excerpt.locator;
  if (locator.kind === "line_range") {
    return locator.startLine === locator.endLine
      ? `line ${locator.startLine}`
      : `lines ${locator.startLine}–${locator.endLine}`;
  }
  if (locator.kind === "diff_line_range") {
    const start = `${locator.start.side} ${locator.start.line}`;
    const end = `${locator.end.side} ${locator.end.line}`;
    return start === end ? start : `${start} → ${end}`;
  }
  if (locator.headingTrail?.length) return locator.headingTrail.join(" › ");
  if (
    locator.sourceStartLine !== undefined &&
    locator.sourceEndLine !== undefined
  ) {
    return locator.sourceStartLine === locator.sourceEndLine
      ? `line ${locator.sourceStartLine}`
      : `lines ${locator.sourceStartLine}–${locator.sourceEndLine}`;
  }
  return "selected text";
}
