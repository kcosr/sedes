import type { ConversationItem, ConversationTurn, TurnBookmark } from "../../../shared/index.js";
import { assistantMessagePreview, assistantPreviewLimit, collapsePreview, userMessagePreview } from "./message-previews.js";
import { derivedPerTurn } from "./turn-derivation.js";

export type TurnBookmarkPreview = Pick<TurnBookmark, "userPreview" | "assistantPreview" | "responseState">;

/**
 * The index of the user message that started the turn, or -1. A turn whose
 * reply text comes first, such as a reply continued after background work,
 * has no prompt even if the user steers it later.
 */
function promptIndex(items: readonly (ConversationItem | undefined)[]): number {
  return items.findIndex(item =>
    item?.kind === "user_message" ||
    (item?.kind === "assistant_message" && assistantMessagePreview(item) !== ""),
  );
}

/**
 * One bookmark describes the whole turn, including replies after steering. A
 * turn without a prompt is identified by its reply and needs reply text.
 */
export const turnBookmarkPreview = derivedPerTurn(function turnBookmarkPreview(
  turn: ConversationTurn,
  itemsById: Readonly<Record<string, ConversationItem>>,
): TurnBookmarkPreview | undefined {
  const items = turn.orderedItemIds.map(id => itemsById[id]);
  const first = promptIndex(items);
  const prompt = items[first]?.kind === "user_message" ? items[first] : undefined;
  const assistantPreview = collapsePreview(items.slice(prompt ? first + 1 : 0).flatMap(item =>
    item?.kind === "assistant_message" ? [assistantMessagePreview(item)] : [],
  ).filter(Boolean).join(" "), assistantPreviewLimit);
  if (!prompt && !assistantPreview) return undefined;
  return {
    userPreview: prompt ? userMessagePreview(prompt) : null,
    assistantPreview: assistantPreview || null,
    responseState: assistantPreview ? "responded" : "no_response",
  };
});

/** Prefer readable assistant text; a textless turn starts at its activity. */
export const turnResponseItemId = derivedPerTurn(function turnResponseItemId(
  turn: ConversationTurn,
  itemsById: Readonly<Record<string, ConversationItem>>,
): string | undefined {
  const items = turn.orderedItemIds.map(id => itemsById[id]);
  const first = promptIndex(items);
  const response = items.slice(items[first]?.kind === "user_message" ? first + 1 : 0);
  return response.find(item => item?.kind === "assistant_message" && item.markdown.text.trim())?.id
    ?? response.find(item => item && item.kind !== "user_message" && item.kind !== "assistant_message")?.id;
});
