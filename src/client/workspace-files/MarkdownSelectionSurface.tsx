import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MAXIMUM_CONTEXT_EXCERPT_BYTES,
  MAXIMUM_CONTEXT_HEADING_BYTES,
  MAXIMUM_CONTEXT_HEADING_ENTRIES,
  MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
  type ContextExcerpt,
  type ContextExcerptSource,
} from "../../shared/index.js";
import { MarkdownContent } from "../components/conversation/MarkdownContent.js";
import {
  useContextExcerptStaging,
  type ContextExcerptStagingSnapshot,
  type ContextExcerptStagingTarget,
} from "../context-excerpts/coordinator.js";
import { PierreSelectionAction } from "../context-excerpts/PierreSelectionAction.js";
import { observeSettledSelection } from "../context-excerpts/settled-selection-capture.js";
import { captureMarkdownContextSelection } from "./markdown-context-selection.js";
import { findMarkdownSourceSeekTarget } from "./markdown-source-seek.js";
import type { WorkspaceFileSourceLineSeek } from "./open-intent.js";

const DEFAULT_SELECTION_DEBOUNCE_MILLISECONDS = 350;
const encoder = new TextEncoder();
const UNAVAILABLE: ContextExcerptStagingSnapshot = Object.freeze({
  available: false,
  reason: "The message composer is unavailable.",
});

type WorkspaceFileContextSource = Extract<
  ContextExcerptSource,
  { kind: "workspace_file" }
>;

interface PendingMarkdownSelection {
  readonly excerpt: string;
  readonly locator: Extract<ContextExcerpt["locator"], { kind: "text_quote" }>;
  readonly anchor: { readonly left: number; readonly bottom: number };
}

export function MarkdownSelectionSurface({
  markdown,
  source,
  workspaceId,
  enabled = true,
  visible = true,
  truncated = false,
  seek,
  onSeekHandled,
  stagingTarget,
  selectionDebounceMilliseconds = DEFAULT_SELECTION_DEBOUNCE_MILLISECONDS,
}: {
  readonly markdown: string;
  readonly source: WorkspaceFileContextSource;
  readonly workspaceId: string;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly truncated?: boolean;
  readonly seek?: WorkspaceFileSourceLineSeek;
  readonly onSeekHandled?: (sequence: number) => void;
  readonly stagingTarget?: ContextExcerptStagingTarget;
  /** Exposed for deterministic tests; product callers should use the default. */
  readonly selectionDebounceMilliseconds?: number;
}): React.JSX.Element {
  const contextTarget = useContextExcerptStaging();
  const target = stagingTarget ?? contextTarget;
  const targetSnapshot = useSyncExternalStore(
    target?.subscribe ?? emptySubscribe,
    target?.getSnapshot ?? getUnavailable,
    target?.getSnapshot ?? getUnavailable,
  );
  const workspaceMatches = target?.workspaceId === workspaceId;
  const available =
    enabled && visible && workspaceMatches && targetSnapshot.available;
  const unavailableReason = !enabled
    ? "Context selection is unavailable in this view."
    : !visible
      ? "Open this panel before attaching context."
      : !target
        ? UNAVAILABLE.reason
        : !workspaceMatches
          ? "This file is not in the active thread workspace."
          : targetSnapshot.reason;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<PendingMarkdownSelection>();
  const [noteMode, setNoteMode] = useState(false);
  const noteModeRef = useRef(noteMode);
  noteModeRef.current = noteMode;
  const [actionError, setActionError] = useState<string>();
  const [copyConfirmation, setCopyConfirmation] = useState<string>();
  const handledSeekSequenceRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (
      !root ||
      !seek ||
      handledSeekSequenceRef.current === seek.sequence
    ) {
      return;
    }
    handledSeekSequenceRef.current = seek.sequence;
    const displayedLineCount = countLines(markdown);
    const target =
      truncated && seek.lineNumber > displayedLineCount
        ? undefined
        : findMarkdownSourceSeekTarget(root, seek.lineNumber);
    if (!target) {
      onSeekHandled?.(seek.sequence);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const targetRect = target.element.getBoundingClientRect();
    const top = Math.max(
      0,
      root.scrollTop + targetRect.top - rootRect.top - 12,
    );
    if (typeof root.scrollTo === "function") {
      root.scrollTo({ top, behavior: "auto" });
    } else {
      root.scrollTop = top;
    }
    root.focus({ preventScroll: true });
    onSeekHandled?.(seek.sequence);
  }, [markdown, onSeekHandled, root, seek, truncated]);

  const clearPending = useCallback(() => {
    setPending(undefined);
    setNoteMode(false);
    setActionError(undefined);
  }, []);

  useEffect(clearPending, [
    clearPending,
    markdown,
    source.path,
    source.revision,
  ]);
  useEffect(
    () => setCopyConfirmation(undefined),
    [markdown, source.path, source.revision],
  );
  useEffect(() => {
    if (!enabled || !visible) clearPending();
  }, [clearPending, enabled, visible]);
  useEffect(() => {
    if (!copyConfirmation) return;
    const timeout = globalThis.setTimeout(
      () => setCopyConfirmation(undefined),
      8_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [copyConfirmation]);

  useEffect(() => {
    if (!root || !enabled || !visible) return;
    const captureSelection = () => {
      if (noteModeRef.current) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        clearPending();
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      setCopyConfirmation(undefined);
      const captured = captureMarkdownContextSelection(root, range, {
        maximumAffixBytes: MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
        maximumHeadingEntries: MAXIMUM_CONTEXT_HEADING_ENTRIES,
        maximumHeadingBytes: MAXIMUM_CONTEXT_HEADING_BYTES,
      });
      if (!captured) {
        clearPending();
        return;
      }
      if (
        encoder.encode(captured.excerpt).byteLength >
        MAXIMUM_CONTEXT_EXCERPT_BYTES
      ) {
        setPending(undefined);
        setActionError("The selected text is too large to attach.");
        return;
      }
      const rect = safeRangeRect(range);
      setPending({
        ...captured,
        anchor: { left: rect.left + rect.width / 2, bottom: rect.bottom },
      });
      setActionError(undefined);
    };
    return observeSettledSelection({
      root,
      debounceMilliseconds: selectionDebounceMilliseconds,
      capture: captureSelection,
      onGestureStart: clearPending,
    });
  }, [
    clearPending,
    enabled,
    root,
    selectionDebounceMilliseconds,
    visible,
  ]);

  const stage = useCallback(
    (annotation?: string, sendImmediately?: boolean) => {
      if (!pending || !target || !available) {
        return {
          ok: false as const,
          reason:
            unavailableReason ??
            UNAVAILABLE.reason ??
            "The message composer is unavailable.",
        };
      }
      const normalizedNote = annotation?.trim();
      const excerpt: ContextExcerpt = {
        id: globalThis.crypto.randomUUID(),
        excerpt: pending.excerpt,
        ...(normalizedNote ? { note: normalizedNote } : {}),
        source,
        locator: pending.locator,
      };
      const result = sendImmediately
        ? target.attachAndSubmit(excerpt)
        : target.stage(excerpt);
      if (!result.ok) {
        return result;
      }
      document.getSelection()?.removeAllRanges();
      clearPending();
      root?.focus({ preventScroll: true });
      return result;
    },
    [available, clearPending, pending, root, source, target, unavailableReason],
  );

  return (
    <>
      <div
        aria-label={`Markdown preview for ${source.path}`}
        className="workspace-files-markdown-preview markdown-selection-surface"
        ref={setRoot}
        tabIndex={-1}
      >
        <MarkdownContent fileLinkSource={source} sourcePositionMetadata>
          {markdown}
        </MarkdownContent>
        {actionError && !pending && (
          <p className="markdown-selection-surface-error" role="alert">
            {actionError}
          </p>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {copyConfirmation ?? ""}
        </span>
        {copyConfirmation && (
          <div className="context-selection-confirmation">
            <span aria-hidden="true">{copyConfirmation}</span>
          </div>
        )}
      </div>
      {pending && (
        <PierreSelectionAction
          stagingTarget={target}
          ariaLabel="Selected text actions"
          anchor={{
            left: pending.anchor.left,
            right: pending.anchor.left,
            top: pending.anchor.bottom,
            bottom: pending.anchor.bottom,
          }}
          copyText={pending.excerpt}
          initialError={actionError}
          label="selected text"
          noteInputLabel="Note about selected text"
          onCancel={() => {
            document.getSelection()?.removeAllRanges();
            clearPending();
          }}
          onCopySuccess={() => {
            const selection = document.getSelection();
            const copiedRange =
              selection?.rangeCount === 1
                ? selection.getRangeAt(0).cloneRange()
                : undefined;
            clearPending();
            setCopyConfirmation("Copied selected text.");
            globalThis.setTimeout(() => {
              if (copiedRange && selectionMatchesRange(copiedRange)) {
                document.getSelection()?.removeAllRanges();
              }
            }, 1_200);
          }}
          onNoteModeChange={setNoteMode}
          onStage={stage}
          owner={root}
          stageWithNoteLabel="Add note"
          unavailableReason={!available ? unavailableReason : undefined}
        />
      )}
    </>
  );
}

function countLines(content: string): number {
  let count = 1;
  for (const character of content) {
    if (character === "\n") count += 1;
  }
  return count;
}

function safeRangeRect(range: Range): DOMRect {
  if (typeof range.getBoundingClientRect === "function") {
    return range.getBoundingClientRect();
  }
  return new DOMRect();
}

function selectionMatchesRange(expected: Range): boolean {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return false;
  }
  const current = selection.getRangeAt(0);
  return (
    current.compareBoundaryPoints(Range.START_TO_START, expected) === 0 &&
    current.compareBoundaryPoints(Range.END_TO_END, expected) === 0
  );
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function getUnavailable(): ContextExcerptStagingSnapshot {
  return UNAVAILABLE;
}
