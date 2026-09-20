import { describe, expect, it, vi } from "vitest";
import type { ConversationTurnBookmarkRepository } from "../../src/server/db/repositories/conversation-turn-bookmark-repository.js";
import { ConversationTurnBookmarkService } from "../../src/server/domain/conversation-turn-bookmark-service.js";

describe("ConversationTurnBookmarkService", () => {
  it("hands off publication for both a commit and its replay", () => {
    const committed = { revision: 1, bookmark: null, replayed: false } as const;
    const replay = { ...committed, replayed: true } as const;
    const repository = {
      set: vi.fn().mockReturnValueOnce(committed).mockReturnValueOnce(replay),
    } as unknown as ConversationTurnBookmarkRepository;
    const handoffThreadChange = vi.fn();
    const service = new ConversationTurnBookmarkService(repository, {
      handoffThreadChange,
    });
    const scope = { tenantId: "tenant", principalId: "principal" };
    const input = {
      bookmarked: false,
      expectedRevision: 1,
      mutationId: "11111111-1111-4111-8111-111111111176",
    } as const;

    expect(service.set(scope, "thread", "turn", input, 100)).toBe(committed);
    expect(service.set(scope, "thread", "turn", input, 200)).toBe(replay);
    expect(repository.set).toHaveBeenCalledTimes(2);
    expect(handoffThreadChange).toHaveBeenCalledTimes(2);
  });
});
