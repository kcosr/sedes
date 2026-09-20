import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  MAXIMUM_CONTEXT_EXCERPT_BYTES,
  MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
  MAXIMUM_CONTEXT_HEADING_BYTES,
  MAXIMUM_CONTEXT_HEADING_ENTRIES,
  type ContextExcerpt,
} from "../../shared/index.js";
import { captureMarkdownContextSelection } from "../workspace-files/markdown-context-selection.js";
import {
  useContextExcerptStaging,
  type ContextExcerptStagingSnapshot,
  type ContextExcerptStagingTarget,
} from "./coordinator.js";
import { PierreSelectionAction } from "./PierreSelectionAction.js";
import { observeSettledSelection } from "./settled-selection-capture.js";

const DEFAULT_SELECTION_DEBOUNCE_MILLISECONDS = 350;
const encoder = new TextEncoder();
const SELECTABLE_TEXT_ATTRIBUTE = "data-conversation-message-text";
const SELECTABLE_TEXT_SELECTOR = `[${SELECTABLE_TEXT_ATTRIBUTE}]`;
const UNAVAILABLE: ContextExcerptStagingSnapshot = Object.freeze({
  available: false,
  reason: "The message composer is unavailable.",
});

interface PendingConversationSelection {
  readonly excerpt: string;
  readonly locator: Extract<ContextExcerpt["locator"], { kind: "text_quote" }>;
  readonly anchor: DOMRect;
  readonly itemId: string;
  readonly itemRevision: number;
  readonly targetThreadId?: string;
  readonly targetWorkspaceId?: string;
}

export function ConversationMessageSelectionSurface({
  itemId,
  itemRevision,
  selectionKind,
  enabled,
  className,
  children,
  stagingTarget,
  selectionDebounceMilliseconds = DEFAULT_SELECTION_DEBOUNCE_MILLISECONDS,
}: {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly selectionKind: "plain_text" | "markdown";
  readonly enabled: boolean;
  readonly className?: string;
  readonly children: ReactNode;
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
  const available = enabled && targetSnapshot.available;
  const unavailableReason = !enabled
    ? "Only settled message text can be added to a message."
    : targetSnapshot.reason;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<PendingConversationSelection>();
  const [noteMode, setNoteMode] = useState(false);
  const noteModeRef = useRef(noteMode);
  noteModeRef.current = noteMode;
  const [actionError, setActionError] = useState<string>();
  const [copyConfirmation, setCopyConfirmation] = useState<string>();

  const clearPending = useCallback(() => {
    setPending(undefined);
    setNoteMode(false);
    setActionError(undefined);
  }, []);

  useEffect(clearPending, [
    clearPending,
    enabled,
    itemId,
    itemRevision,
    target?.threadId,
    target?.workspaceId,
  ]);
  useEffect(
    () => setCopyConfirmation(undefined),
    [enabled, itemId, itemRevision],
  );
  useEffect(() => {
    if (!copyConfirmation) return;
    const timeout = globalThis.setTimeout(
      () => setCopyConfirmation(undefined),
      8_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [copyConfirmation]);

  useEffect(() => {
    if (!root || !enabled) return;
    const captureSelection = () => {
      if (noteModeRef.current) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        clearPending();
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const captured =
        selectionKind === "markdown"
          ? captureMarkdownContextSelection(root, range, {
              maximumAffixBytes: MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
              maximumHeadingEntries: MAXIMUM_CONTEXT_HEADING_ENTRIES,
              maximumHeadingBytes: MAXIMUM_CONTEXT_HEADING_BYTES,
            })
          : capturePlainConversationSelection(root, range);
      if (!captured) {
        clearPending();
        return;
      }
      setCopyConfirmation(undefined);
      if (
        encoder.encode(captured.excerpt).byteLength >
        MAXIMUM_CONTEXT_EXCERPT_BYTES
      ) {
        setPending(undefined);
        setActionError("The selected text is too large to attach.");
        return;
      }
      setPending({
        ...captured,
        anchor: safeRangeRect(range),
        itemId,
        itemRevision,
        targetThreadId: target?.threadId,
        targetWorkspaceId: target?.workspaceId,
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
    itemId,
    itemRevision,
    root,
    selectionDebounceMilliseconds,
    selectionKind,
    target?.threadId,
    target?.workspaceId,
  ]);

  const stage = useCallback(
    (note?: string, sendImmediately?: boolean) => {
      if (
        !pending ||
        !target ||
        !available ||
        pending.itemId !== itemId ||
        pending.itemRevision !== itemRevision ||
        pending.targetThreadId !== target.threadId ||
        pending.targetWorkspaceId !== target.workspaceId
      ) {
        return {
          ok: false as const,
          reason: unavailableReason ?? UNAVAILABLE.reason!,
        };
      }
      const normalizedNote = note?.trim();
      const excerpt: ContextExcerpt = {
        id: globalThis.crypto.randomUUID(),
        excerpt: pending.excerpt,
        ...(normalizedNote ? { note: normalizedNote } : {}),
        source: {
          kind: "conversation_message",
          itemId,
          itemRevision,
        },
        locator: pending.locator,
      };
      const result = sendImmediately
        ? target.attachAndSubmit(excerpt)
        : target.stage(excerpt);
      if (!result.ok) return result;
      document.getSelection()?.removeAllRanges();
      clearPending();
      root?.focus({ preventScroll: true });
      return result;
    },
    [
      available,
      clearPending,
      itemId,
      itemRevision,
      pending,
      root,
      target,
      unavailableReason,
    ],
  );

  return (
    <div
      aria-label="Selectable conversation message"
      className={className}
      data-selection-enabled={enabled ? "true" : "false"}
      ref={setRoot}
      tabIndex={-1}
    >
      {children}
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
      {pending && (
        <PierreSelectionAction
          stagingTarget={target}
          ariaLabel="Selected message text actions"
          anchor={pending.anchor}
          copyText={pending.excerpt}
          initialError={actionError}
          label="selected message text"
          noteInputLabel="Note about selected message text"
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
            setCopyConfirmation("Copied selected message text.");
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
    </div>
  );
}

/** Marks the only plain user-message DOM whose visible text can be captured. */
export const conversationMessageSelectableTextProps = {
  [SELECTABLE_TEXT_ATTRIBUTE]: "true",
} as const;

export function capturePlainConversationSelection(
  root: HTMLElement,
  range: Range,
):
  | {
      readonly excerpt: string;
      readonly locator: Extract<
        ContextExcerpt["locator"],
        { kind: "text_quote" }
      >;
    }
  | undefined {
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer) ||
    !(range.startContainer instanceof Text) ||
    !(range.endContainer instanceof Text)
  ) {
    return undefined;
  }
  const startBlock = closestSelectableText(range.startContainer, root);
  const endBlock = closestSelectableText(range.endContainer, root);
  if (!startBlock || !endBlock) return undefined;

  let selectedOrdinaryText = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !rangeIntersectsNode(range, node)) continue;
    const selected = selectedTextFromNode(range, node);
    if (!selected) continue;
    if (!closestSelectableText(node, root)) return undefined;
    selectedOrdinaryText = true;
  }
  const excerpt = range.toString();
  if (!selectedOrdinaryText || !excerpt.trim()) return undefined;

  const prefix = capturePrefix(
    startBlock,
    range,
    MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
  );
  const suffix = captureSuffix(
    endBlock,
    range,
    MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
  );
  return {
    excerpt,
    locator: {
      kind: "text_quote",
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    },
  };
}

function closestSelectableText(
  node: Node,
  root: HTMLElement,
): HTMLElement | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  const selectable = element?.closest<HTMLElement>(SELECTABLE_TEXT_SELECTOR);
  return selectable && root.contains(selectable) ? selectable : undefined;
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function selectedTextFromNode(range: Range, node: Text): string {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.length;
  return node.data.slice(start, end);
}

function capturePrefix(
  block: HTMLElement,
  selected: Range,
  maximumBytes: number,
): string | undefined {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(selected.startContainer, selected.startOffset);
    return takeUtf8Tail(range.toString(), maximumBytes) || undefined;
  } catch {
    return undefined;
  }
}

function captureSuffix(
  block: HTMLElement,
  selected: Range,
  maximumBytes: number,
): string | undefined {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setStart(selected.endContainer, selected.endOffset);
    return takeUtf8Head(range.toString(), maximumBytes) || undefined;
  } catch {
    return undefined;
  }
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = encoder.encode(character).byteLength;
    if (bytes + next > maximumBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function takeUtf8Tail(value: string, maximumBytes: number): string {
  const characters = Array.from(value);
  let result = "";
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const next = encoder.encode(character).byteLength;
    if (bytes + next > maximumBytes) break;
    result = character + result;
    bytes += next;
  }
  return result;
}

function safeRangeRect(range: Range): DOMRect {
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : new DOMRect();
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
