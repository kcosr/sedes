import type { ConversationItem, ConversationTurn, TurnBookmark } from "../../../shared/index.js";
import { assistantMessagePreview, assistantPreviewLimit, collapsePreview, userMessagePreview } from "./message-previews.js";
import { derivedPerTurn } from "./turn-derivation.js";

export type TurnBookmarkPreview = Pick<TurnBookmark, "userPreview" | "assistantPreview" | "responseState">;

/** One bookmark describes the whole turn, including replies after steering. */
export const turnBookmarkPreview = derivedPerTurn(function turnBookmarkPreview(
  turn: ConversationTurn,
  itemsById: Readonly<Record<string, ConversationItem>>,
): TurnBookmarkPreview | undefined {
  const items = turn.orderedItemIds.map(id => itemsById[id]);
  const userIndex = items.findIndex(item => item?.kind === "user_message");
  const user = items[userIndex];
  if (user?.kind !== "user_message") return undefined;
  const assistantPreview = collapsePreview(items.slice(userIndex + 1).flatMap(item =>
    item?.kind === "assistant_message" ? [assistantMessagePreview(item)] : [],
  ).filter(Boolean).join(" "), assistantPreviewLimit);
  return {
    userPreview: userMessagePreview(user),
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
  const response = items.slice(items.findIndex(item => item?.kind === "user_message") + 1);
  return response.find(item => item?.kind === "assistant_message" && item.markdown.text.trim())?.id
    ?? response.find(item => item && item.kind !== "user_message" && item.kind !== "assistant_message")?.id;
});
