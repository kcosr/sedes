import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BackendConversationSnapshot } from "../../src/shared/protocol/backend.js";
import { settleArchiveSnapshot } from "../../src/server/conversations/archive-snapshot-settlement.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { ThreadArchiveObligationRepository } from "../../src/server/db/repositories/thread-archive-obligation-repository.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

describe("archive settlement", () => {
  it("persists a retained terminal result and question once without creating attention, and rolls back unconfirmed evidence", () => {
    const { database, bindings, inventory, completion, scope, ids } = applicationSummaryFixture(1);
    try {
      const threadId = ids[0]!;
      bindings.bindDiscoveredConversation(scope, threadId, { backendConversationId: "conversation", now: 400 });
      const questions = new QuestionRequestRepository(database, inventory);
      const deps = {
        bindings, completion, questions, usage: { registerVisibleTurns: vi.fn() },
        recordSubmission: vi.fn(), settleAutomation: vi.fn(),
      };
      completion.recordAccepted(scope, threadId, { operationId: "op", backendCorrelation: "op", acceptedAt: 410 });
      const snapshot: BackendConversationSnapshot = {
        runState: "idle", orderedBackendTurnIds: ["turn"],
        turnsById: {
          turn: { backendTurnId: "turn", status: "completed", completionCorrelations: ["op"], orderedBackendItemIds: ["reply"] },
        },
        itemsById: {
          reply: {
            backendTurnId: "turn", backendItemId: "reply", semanticKind: "assistant_message", status: "completed",
            markdown: { text: "Ready to review." }, responsePhase: "final", sourceOrder: 0,
            nonblockingQuestions: { questions: [{ title: "Publish?", options: null }] },
          },
        },
      };
      const settle = (...turns: string[]) => settleArchiveSnapshot(deps, scope, threadId, snapshot, turns);
      expect(() => settle("turn", "missing")).toThrow("archive_terminal_turn_unconfirmed");
      expect(completion.get(scope, threadId, "op").completionObservedAt).toBeNull();
      expect(questions.list(scope, threadId).requests).toHaveLength(0);

      settle("turn");
      const first = completion.get(scope, threadId, "op");
      expect(first).toMatchObject({ lastCompletionIdentity: "turn:completed", completionOutcome: "completed",
        assistantResult: { text: "Ready to review." }, attentionCreatedAt: null });
      const pending = questions.list(scope, threadId);
      expect(pending.requests).toHaveLength(1);
      settle("turn");
      expect(completion.get(scope, threadId, "op")).toEqual(first);
      expect(questions.list(scope, threadId)).toEqual(pending);

    } finally { database.close(); }
  });

  it("records the exact rejected control separately from retryable operation IDs", () => {
    const { database, ids, scope } = applicationSummaryFixture(2);
    try {
      const operations = new ConversationOperationRepository(database);
      const thread = ids[0]!;
      const id = randomUUID();
      const input = { operationId: id, interactionId: "question", now: 320,
        response: { kind: "cancel" } as const,
        backendResponse: { applicationOperationId: id, interactionId: "native-question", kind: "cancel" as const } };
      operations.prepareRecoverableInteractionResponse(scope, thread, input);
      const sent = operations.markInteractionResponseStarted(scope, id);
      operations.rejectInteractionResponseProvenNotApplied(scope, id);
      const reopened = new ConversationOperationRepository(database);
      expect(reopened.findInteractionResponse(scope, id)).toBeUndefined();
      expect(reopened.findRejectedInteractionResponse(scope, thread, id)).toEqual(sent);
      expect(reopened.findRejectedInteractionResponse(scope, ids[1]!, id)).toBeUndefined();
      expect(reopened.findRejectedInteractionResponse({ ...scope, principalId: "other" }, thread, id)).toBeUndefined();
      expect(reopened.findRejectedInterrupt(scope, thread, id)).toBeUndefined();
      expect(reopened.prepareRecoverableInteractionResponse(scope, thread, input).state).toBe("prepared");
      const stop = randomUUID();
      operations.prepareInterrupt(scope, thread, { operationId: stop, now: 321 });
      const interrupt = operations.markInterruptStarted(scope, stop);
      operations.rejectInterruptProvenNotApplied(scope, stop);
      expect(reopened.findRejectedInterrupt(scope, thread, stop)).toEqual(interrupt);
      const mutationId = randomUUID();
      const setting = operations.prepareBackendAction(scope, thread, { mutationId, expectedThreadRevision: 0,
        operation: { action: "rename", title: "new title" }, now: 322 });
      operations.rejectBackendActionProvenNotApplied(scope, mutationId);
      expect(reopened.findRejectedBackendAction(scope, thread, mutationId)).toEqual(setting);
    } finally { database.close(); }
  });

  it("retains per-principal evidence until the exact generation proves settlement", () => {
    const { database, ids, scope } = applicationSummaryFixture(2);
    const threadId = ids[0]!;
    try {
      const obligations = new ThreadArchiveObligationRepository(database);
      obligations.remember(scope, threadId);
      obligations.remember(scope, threadId);
      const reopened = new ThreadArchiveObligationRepository(database);
      obligations.markRetained(scope, threadId, "generation-1");
      expect(reopened.read(scope, threadId)?.retainedOwner).toBe("generation-1");
      expect(() => reopened.markRetained(scope, threadId, "replacement")).toThrow();
      expect(() => reopened.markSettled(scope, threadId, "replacement")).toThrow();
      reopened.clear(scope, threadId);
      expect(reopened.read(scope, threadId)?.retainedOwner).toBe("generation-1");
      expect(reopened.read(scope, ids[1]!)).toBeUndefined();
      const other = { ...scope, principalId: "different-principal" };
      expect(reopened.read(other, threadId)).toBeUndefined();
      reopened.clear(other, threadId);
      expect(() => reopened.remember(other, threadId)).toThrow();
      expect(obligations.read(scope, threadId)).toBeDefined();
      reopened.markSettled(scope, threadId, "generation-1");
      reopened.clear(scope, threadId);
      expect(obligations.read(scope, threadId)).toBeUndefined();
    } finally { database.close(); }
  });
});
