import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Copy, MessageSquareText, Paperclip, Send } from "lucide-react";
import { MAXIMUM_CONTEXT_EXCERPT_NOTE_BYTES } from "../../shared/index.js";
import { OPEN_OVERLAY_SELECTOR } from "../app/android-back.js";
import { Button } from "../components/ui/button.js";

import { useContextExcerptStagingSnapshot, type ContextExcerptStagingTarget } from "./coordinator.js";

const VIEWPORT_GUTTER = 12;
const SELECTION_GAP = 8;

export interface SelectionActionAnchor {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width?: number;
  readonly height?: number;
}

export type PierreSelectionStageResult =
  | void
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function PierreSelectionAction({
  label,
  ariaLabel,
  initialError,
  anchor,
  owner,
  copyText,
  unavailableReason,
  onStage,
  onCancel,
  onCopySuccess,
  onNoteModeChange,
  noteInputLabel = "Note for agent",
  stageWithNoteLabel = "Add note",
  stagingTarget,
}: {
  readonly stagingTarget?: ContextExcerptStagingTarget;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly initialError?: string;
  readonly anchor?: SelectionActionAnchor;
  readonly owner?: HTMLElement | null;
  readonly copyText?: string;
  readonly unavailableReason?: string;
  readonly onStage: (
    note?: string,
    sendImmediately?: boolean,
  ) => PierreSelectionStageResult;
  readonly onCancel: () => void;
  readonly onCopySuccess?: () => void;
  readonly onNoteModeChange?: (active: boolean) => void;
  readonly noteInputLabel?: string;
  readonly stageWithNoteLabel?: string;
}): React.JSX.Element {
  const sendHintId = useId();
  const { deliveryMode = "submit" } = useContextExcerptStagingSnapshot(stagingTarget);
  const sendLabel = deliveryMode === "submit" ? "send" : deliveryMode;
  const markerRef = useRef<HTMLSpanElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const placementRef = useRef<"above" | "below" | undefined>(undefined);
  const [resolvedOwner, setResolvedOwner] = useState<HTMLElement | null>(
    owner ?? null,
  );
  const [addingNote, setAddingNote] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState(initialError);
  const [position, setPosition] = useState<CSSProperties>();

  useLayoutEffect(() => {
    setResolvedOwner(owner ?? markerRef.current?.parentElement ?? null);
  }, [owner]);

  const portalTarget = useMemo(
    () =>
      resolvedOwner?.closest<HTMLElement>('[data-slot="dialog-content"]') ??
      document.body,
    [resolvedOwner],
  );

  useEffect(() => {
    onNoteModeChange?.(addingNote);
    return () => onNoteModeChange?.(false);
  }, [addingNote, onNoteModeChange]);

  useLayoutEffect(() => {
    placementRef.current = undefined;
  }, [anchor]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const update = () => {
      const target =
        anchor ??
        selectedLineBounds(resolvedOwner) ??
        resolvedOwner?.getBoundingClientRect();
      if (!target) return;
      const bounds = overlay.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const targetWidth = target.width ?? target.right - target.left;
      const centeredLeft = target.left + targetWidth / 2 - bounds.width / 2;
      const left = clamp(
        centeredLeft,
        VIEWPORT_GUTTER,
        Math.max(
          VIEWPORT_GUTTER,
          viewportWidth - bounds.width - VIEWPORT_GUTTER,
        ),
      );
      const below = target.bottom + SELECTION_GAP;
      const above = target.top - bounds.height - SELECTION_GAP;
      const spaceBelow =
        viewportHeight - VIEWPORT_GUTTER - target.bottom - SELECTION_GAP;
      const spaceAbove = target.top - VIEWPORT_GUTTER - SELECTION_GAP;
      const placement =
        placementRef.current ??
        (spaceBelow >= spaceAbove ? "below" : "above");
      placementRef.current = placement;
      const top = clamp(
        placement === "below" ? below : above,
        VIEWPORT_GUTTER,
        Math.max(
          VIEWPORT_GUTTER,
          viewportHeight - bounds.height - VIEWPORT_GUTTER,
        ),
      );
      const portalOffset =
        portalTarget === document.body
          ? { left: 0, top: 0 }
          : portalTarget.getBoundingClientRect();
      setPosition({
        left: `${left - portalOffset.left}px`,
        position: portalTarget === document.body ? "fixed" : "absolute",
        top: `${top - portalOffset.top}px`,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, addingNote, portalTarget, resolvedOwner]);

  const dismiss = () => {
    onCancel();
    queueMicrotask(() => resolvedOwner?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
      if (overlays.item(overlays.length - 1) !== overlayRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (addingNote) {
        setAddingNote(false);
        queueMicrotask(() =>
          overlayRef.current
            ?.querySelector<HTMLButtonElement>("[data-add-note-trigger]")
            ?.focus(),
        );
        return;
      }
      dismiss();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [addingNote, onCancel, resolvedOwner]);

  const stage = (sendImmediately = false) => {
    const normalizedNote = note.trim();
    if (
      normalizedNote &&
      new TextEncoder().encode(normalizedNote).byteLength >
        MAXIMUM_CONTEXT_EXCERPT_NOTE_BYTES
    ) {
      setError("The note is too large to attach.");
      return;
    }
    const result = sendImmediately
      ? onStage(normalizedNote || undefined, true)
      : onStage(normalizedNote || undefined);
    if (result && !result.ok) setError(result.reason);
  };

  const copy = async () => {
    if (copyText === undefined) return;
    setError(undefined);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(copyText);
    } catch {
      setError("Copy failed. The selection is still available.");
      return;
    }
    onCopySuccess?.();
  };

  const overlay = (
    <div
      aria-label={ariaLabel ?? `Actions for ${label}`}
      className="pierre-selection-action"
      data-presentation="responsive"
      data-selection-action-overlay
      onPointerDown={(event) => {
        // Focusing an action must not collapse the selection it acts on.
        if (!(event.target instanceof HTMLTextAreaElement)) {
          event.preventDefault();
        }
      }}
      ref={overlayRef}
      role="toolbar"
      style={position}
    >
      <div className="pierre-selection-card-heading">
        <strong>{sentenceCase(label)}</strong>
        <span>{addingNote ? "Add an optional note" : "Selection actions"}</span>
      </div>
      {addingNote && (
        <>
          <label className="pierre-selection-note-field">
            <span>Note about selected text</span>
            <textarea
              aria-label={noteInputLabel}
              autoFocus
              className="pierre-selection-note"
              onChange={(event) => {
                setNote(event.currentTarget.value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  stage();
                }
              }}
              placeholder="Note for the agent (optional)"
              rows={4}
              value={note}
            />
          </label>
        </>
      )}
      {error && (
        <span className="pierre-selection-error" role="alert">
          {error}
        </span>
      )}
      {addingNote && !initialError && (
        <span id={sendHintId} className="pierre-selection-send-hint">
          Includes this selection, note, and any existing composer content.
        </span>
      )}
      <div className="pierre-selection-buttons">
        {!addingNote && !initialError && (
          <Button
            data-add-note-trigger
            disabled={Boolean(unavailableReason)}
            onClick={() => {
              setError(undefined);
              setAddingNote(true);
            }}
            size="sm"
            title={unavailableReason}
            type="button"
          >
            <MessageSquareText aria-hidden="true" />
            Add note…
          </Button>
        )}
        {!initialError && (
          <Button
            disabled={Boolean(unavailableReason)}
            onClick={() => stage()}
            size="sm"
            title={unavailableReason}
            type="button"
            variant={addingNote ? "default" : "outline"}
          >
            {addingNote ? (
              <MessageSquareText aria-hidden="true" />
            ) : (
              <Paperclip aria-hidden="true" />
            )}
            {addingNote ? stageWithNoteLabel : "Add to message"}
          </Button>
        )}
        {addingNote && !initialError && (
          <Button
            disabled={Boolean(unavailableReason)}
            aria-describedby={sendHintId}
            onClick={() => stage(true)}
            size="sm"
            title={unavailableReason}
            type="button"
            variant="outline"
          >
            <Send aria-hidden="true" />
            {stageWithNoteLabel} &amp; {sendLabel}
          </Button>
        )}
        {copyText !== undefined && (
          <Button
            onClick={() => void copy()}
            size="sm"
            type="button"
            variant="outline"
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        )}
        <Button onClick={dismiss} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      {unavailableReason && (
        <span className="pierre-selection-hint">{unavailableReason}</span>
      )}
    </div>
  );

  return (
    <>
      <span
        aria-hidden="true"
        className="pierre-selection-anchor"
        ref={markerRef}
      />
      {createPortal(overlay, portalTarget)}
    </>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function selectedLineBounds(
  owner: HTMLElement | null,
): SelectionActionAnchor | undefined {
  const selected = owner?.querySelectorAll<HTMLElement>("[data-selected-line]");
  if (!selected?.length) return undefined;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  for (const element of selected) {
    const rect = element.getBoundingClientRect();
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
  }
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
  };
}
