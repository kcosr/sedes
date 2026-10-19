import { useEffect, useId, useRef, useState } from "react";
import type {
  ConversationItem,
  ConversationTurn,
} from "../../../shared/index.js";
import { assistantMessagePreview, assistantPreviewLimit, collapsePreview, userMessagePreview } from "./message-previews.js";
import { derivedPerTurn } from "./turn-derivation.js";

export type ChatHistoryEntry = {
  readonly itemId: string;
  readonly turnId: string;
  readonly userPreview: string;
  readonly userLabel?: string;
  readonly assistantPreview: string;
  readonly responseState: "available" | "pending" | "empty";
  readonly bookmarked?: boolean;
};

export function createChatHistoryEntries(
  orderedTurnIds: readonly string[],
  turnsById: Readonly<Record<string, ConversationTurn>> | undefined,
  itemsById: Readonly<Record<string, ConversationItem>> | undefined,
  bookmarkedTurnIds: ReadonlySet<string> = new Set(),
): ChatHistoryEntry[] {
  if (!turnsById || !itemsById) return [];
  const entries: ChatHistoryEntry[] = [];

  for (const turnId of orderedTurnIds) {
    const turn = turnsById[turnId];
    if (!turn) continue;
    const [first, ...rest] = turnHistoryEntries(turn, itemsById);
    if (!first) continue;
    entries.push(
      bookmarkedTurnIds.has(turnId) ? { ...first, bookmarked: true } : first,
      ...rest,
    );
  }

  return entries;
}

/** One turn's entries, bookmarks aside; unchanged turns keep their entries. */
const turnHistoryEntries = derivedPerTurn(function turnHistoryEntries(
  turn: ConversationTurn,
  itemsById: Readonly<Record<string, ConversationItem>>,
): readonly ChatHistoryEntry[] {
  const entries: ChatHistoryEntry[] = [];
  for (let index = 0; index < turn.orderedItemIds.length; index += 1) {
    const item = itemsById[turn.orderedItemIds[index]!];
    if (item?.kind !== "user_message") continue;

    const assistantPreviews: string[] = [];
    for (
      let replyIndex = index + 1;
      replyIndex < turn.orderedItemIds.length;
      replyIndex += 1
    ) {
      const reply = itemsById[turn.orderedItemIds[replyIndex]!];
      if (reply?.kind === "user_message") break;
      if (reply?.kind !== "assistant_message") continue;
      const preview = assistantMessagePreview(reply);
      if (preview) assistantPreviews.push(preview);
    }

    const assistantPreview = collapsePreview(
      assistantPreviews.join(" "),
      assistantPreviewLimit,
    );
    const pending = !assistantPreview && turn.status === "in_progress";
    entries.push({
      itemId: item.id,
      turnId: turn.id,
      userPreview: userMessagePreview(item),
      ...(item.origin
        ? {
            userLabel:
              item.origin.kind === "question_response"
                ? "Question answered"
                : item.origin.kind === "page_response"
                  ? `Page response · ${item.origin.title} · Revision ${item.origin.revision}`
                : `${item.origin.kind === "agent_message" ? "Agent message" : "Agent result"} · ${item.origin.sourceThreadLabel.text}`,
          }
        : {}),
      assistantPreview:
        assistantPreview ||
        (pending ? "Waiting for a response…" : "No assistant response."),
      responseState: assistantPreview
        ? "available"
        : pending
          ? "pending"
          : "empty",
    });
  }
  return entries;
});

/**
 * Value equality for rail entries. Streaming flushes rebuild the entries even
 * when no preview changed; consumers keep the previous array in that case.
 */
export function sameChatHistoryEntries(
  left: readonly ChatHistoryEntry[],
  right: readonly ChatHistoryEntry[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index]!;
    return (
      entry === other ||
      (entry.itemId === other.itemId &&
        entry.turnId === other.turnId &&
        entry.userPreview === other.userPreview &&
        entry.userLabel === other.userLabel &&
        entry.assistantPreview === other.assistantPreview &&
        entry.responseState === other.responseState &&
        entry.bookmarked === other.bookmarked)
    );
  });
}

export function ChatHistoryRail({
  entries,
  activeItemId,
  assistantLabel,
  onSelect,
}: {
  entries: readonly ChatHistoryEntry[];
  activeItemId?: string;
  assistantLabel: string;
  onSelect: (itemId: string) => void;
}): React.JSX.Element | null {
  const railId = useId();
  const previewId = `${railId}-preview`;
  const rail = useRef<HTMLElement>(null);
  const activeButton = useRef<HTMLButtonElement>(null);
  const [previewPlacement, setPreviewPlacement] = useState<
    | {
        readonly itemId: string;
        readonly edge: "start" | "center" | "end";
        readonly top: number;
      }
    | undefined
  >();

  useEffect(() => {
    activeButton.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeItemId]);

  if (entries.length === 0) return null;

  const showPreview = (itemId: string, target: HTMLElement) => {
    const railRect = rail.current?.getBoundingClientRect();
    if (!railRect) return;
    const targetRect = target.getBoundingClientRect();
    const top = targetRect.top - railRect.top + targetRect.height / 2;
    setPreviewPlacement({
      itemId,
      top,
      edge: top < 88 ? "start" : top > railRect.height - 88 ? "end" : "center",
    });
  };
  const previewedEntry = entries.find(
    (entry) => entry.itemId === previewPlacement?.itemId,
  );

  return (
    <nav
      ref={rail}
      className="chat-history-rail"
      aria-label="Conversation history"
      data-testid="chat-history-rail"
    >
      <ol>
        {entries.map((entry, index) => {
          const active = entry.itemId === activeItemId;
          return (
            <li
              key={entry.itemId}
              className="chat-history-entry"
              data-active={active ? "true" : "false"}
              data-bookmarked={entry.bookmarked ? "true" : undefined}
            >
              <button
                ref={active ? activeButton : undefined}
                type="button"
                className="chat-history-target"
                aria-current={active ? "location" : undefined}
                aria-describedby={
                  previewPlacement?.itemId === entry.itemId
                    ? previewId
                    : undefined
                }
                aria-label={`Jump to conversation message ${index + 1}${entry.userLabel && entry.userLabel !== "You" ? ` from ${entry.userLabel}` : ""}${entry.bookmarked ? ", bookmarked" : ""}`}
                onClick={() => onSelect(entry.itemId)}
                onMouseEnter={(event) =>
                  showPreview(entry.itemId, event.currentTarget)
                }
                onMouseLeave={() => setPreviewPlacement(undefined)}
                onFocus={(event) =>
                  showPreview(entry.itemId, event.currentTarget)
                }
                onBlur={() => setPreviewPlacement(undefined)}
              >
                <span className="chat-history-tick" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {previewedEntry && previewPlacement && (
        <article
          id={previewId}
          className="chat-history-preview"
          role="tooltip"
          data-edge={previewPlacement.edge}
          data-response-state={previewedEntry.responseState}
          style={
            previewPlacement.edge === "center"
              ? { top: previewPlacement.top }
              : undefined
          }
        >
          <p className="chat-history-user-preview">
            <span className="sr-only">
              {previewedEntry.userLabel ?? "You"}:{" "}
            </span>
            {previewedEntry.userPreview}
          </p>
          <p className="chat-history-assistant-preview">
            <span className="sr-only">{assistantLabel}: </span>
            {previewedEntry.assistantPreview}
          </p>
        </article>
      )}
    </nav>
  );
}
