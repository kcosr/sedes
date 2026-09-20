import type {
  ListTurnBookmarksResult,
  SetTurnBookmarkRequest,
  SetTurnBookmarkResult,
} from "../../shared/protocol/turn-bookmarks.js";
import type { ConversationTurnBookmarkRepository } from "../db/repositories/conversation-turn-bookmark-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface ConversationTurnBookmarkPublisher {
  handoffThreadChange(scope: RequestScope, threadId: string): void;
}

export class ConversationTurnBookmarkService {
  constructor(
    private readonly repository: ConversationTurnBookmarkRepository,
    private readonly publisher: ConversationTurnBookmarkPublisher,
  ) {}

  list(scope: RequestScope, threadId: string): ListTurnBookmarksResult {
    return this.repository.list(scope, threadId);
  }

  set(
    scope: RequestScope,
    threadId: string,
    turnId: string,
    input: SetTurnBookmarkRequest,
    now = Date.now(),
  ): SetTurnBookmarkResult {
    const result = this.repository.set(scope, threadId, turnId, input, now);
    // Handoff follows the durable commit but never makes the mutation response
    // depend on projection I/O. Replays hand off again so a previously missed
    // projection still has another convergence opportunity.
    this.publisher.handoffThreadChange(scope, threadId);
    return result;
  }
}
