import type { ConversationTurnBookmarkService } from "../../src/server/domain/conversation-turn-bookmark-service.js";

export function unavailableTurnBookmarks(): Pick<
  ConversationTurnBookmarkService,
  "list" | "set"
> {
  const unavailable = () => {
    throw new Error("turn_bookmark_route_not_configured_for_test");
  };
  return { list: unavailable, set: unavailable };
}
