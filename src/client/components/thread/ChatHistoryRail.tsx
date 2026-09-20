import { useEffect, useId, useRef, useState } from "react";
import type {
  ConversationItem,
  ConversationTurn,
  UserMessageItem,
} from "../../../shared/index.js";

const userPreviewLimit = 220;
const assistantPreviewLimit = 480;

export type ChatHistoryEntry = {
  readonly itemId: string;
  readonly turnId: string;
  readonly userPreview: string;
  readonly userLabel?: string;
  readonly assistantPreview: string;
  readonly responseState: "available" | "pending" | "empty";
  readonly bookmarked?: boolean;
};

const userPreviewCache = new WeakMap<UserMessageItem, string>();
const assistantPreviewCache = new WeakMap<
  Extract<ConversationItem, { kind: "assistant_message" }>,
  string
>();

function collapsePreview(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function markdownPreview(value: string): string {
  return value
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "");
}

function userMessagePreview(item: UserMessageItem): string {
  const cached = userPreviewCache.get(item);
  if (cached !== undefined) return cached;
  const preview = collapsePreview(
    item.origin?.kind === "question_response"
      ? item.origin.answers
          .map(({ question, answer }) => `${question}: ${answer}`)
          .join(" · ")
      : item.content
      .map((part) => {
        if (part.kind === "text") return part.text.text;
        if (part.kind === "skill") return `/${part.name.text}`;
        if (part.kind === "context_excerpt") {
          const source = part.excerpt.source;
          const path =
            source.kind === "conversation_diff"
              ? (source.destinationPath ?? source.path)
              : source.kind === "workspace_diff"
                ? (source.newPath ?? source.oldPath ?? "Changed file")
                : source.kind === "workspace_file"
                  ? source.path
                  : "Conversation message";
          const label = path.split("/").at(-1) ?? path;
          return `Context from ${label}: ${part.excerpt.note ?? part.excerpt.excerpt}`;
        }
        if (part.kind === "attachment") return part.attachment.fileName;
        if (part.kind === "task_context") return `Task: ${part.task.title}`;
        return part.alt?.text ?? part.fileName?.text ?? "Image attachment";
      })
      .join(" "),
    userPreviewLimit,
  );
  const resolved = preview || "Message";
  userPreviewCache.set(item, resolved);
  return resolved;
}

function assistantMessagePreview(
  item: Extract<ConversationItem, { kind: "assistant_message" }>,
): string {
  const cached = assistantPreviewCache.get(item);
  if (cached !== undefined) return cached;
  const preview = collapsePreview(
    markdownPreview(item.markdown.text),
    assistantPreviewLimit,
  );
  assistantPreviewCache.set(item, preview);
  return preview;
}

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
    let userMessageIndex = 0;
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
        turnId,
        userPreview: userMessagePreview(item),
        ...(item.origin
          ? {
              userLabel:
                item.origin.kind === "question_response"
                  ? "Question answered"
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
        ...(userMessageIndex === 0 && bookmarkedTurnIds.has(turnId)
          ? { bookmarked: true }
          : {}),
      });
      userMessageIndex += 1;
    }
  }

  return entries;
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
