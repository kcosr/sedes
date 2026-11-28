import type { BackendConversationSnapshot, BackendTurn } from "../../shared/protocol/backend.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { QuestionRequestRepository } from "../db/repositories/question-request-repository.js";
import type { SubmissionCompletionObservationRecord, SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { UsageService } from "../usage/usage-service.js";
import { projectedCompletion } from "./completion-result-projection.js";
import { ConversationProjector } from "./conversation-projector.js";

/** Apply retained facts under the owning archive fence without starting a runtime or delivering work. */
export function settleArchiveSnapshot(
  dependencies: {
    bindings: ConversationBindingRepository;
    completion: SubmissionCompletionRepository;
    questions: QuestionRequestRepository;
    usage: Pick<UsageService, "registerVisibleTurns">;
    recordSubmission(correlation: string): void;
    settleAutomation(record: SubmissionCompletionObservationRecord, turn: BackendTurn): void;
  },
  scope: RequestScope,
  threadId: string,
  snapshot: BackendConversationSnapshot,
  recoveredCompletionTurnIds: readonly string[],
): void {
  const binding = dependencies.bindings.getBinding(scope, threadId);
  if (!binding) throw new Error("archive_settlement_binding_missing");
  const projector = new ConversationProjector({ backendInstanceId: binding.backendInstanceId, bindingIdentity: threadId });
  const timeline = projector.replace(snapshot, 0);
  const now = Date.now();
  dependencies.completion.database.transaction(() => {
    for (const turnId of new Set(recoveredCompletionTurnIds)) {
      const turn = snapshot.turnsById[turnId];
      if (!turn || turn.status === "in_progress") throw new Error("archive_terminal_turn_unconfirmed");
      const correlations = turn.completionCorrelations ?? [];
      if (correlations.length) {
        const projected = projectedCompletion(projector, turnId, timeline);
        for (const correlation of correlations) {
          dependencies.recordSubmission(correlation);
          const observed = dependencies.completion.observeBackendCompletion(scope, threadId, {
            backendCorrelation: correlation,
            completionIdentity: `${turnId}:${turn.status}`,
            observedAt: now,
            outcome: turn.status,
            ...projected,
          }, "archive");
          if (observed) dependencies.settleAutomation(observed.record, turn);
        }
      }
      const projectedTurn = timeline.turnsById[projector.durableTurnId(turnId)];
      if (!projectedTurn) throw new Error("archive_terminal_turn_unconfirmed");
      for (const itemId of projectedTurn.orderedItemIds) {
        const item = timeline.itemsById[itemId];
        if (item?.kind === "assistant_message" && item.nonblockingQuestions) {
          const { sourceItemId, questions } = item.nonblockingQuestions;
          dependencies.questions.admit(scope, threadId, sourceItemId, { questions }, now);
        }
      }
    }
    dependencies.usage.registerVisibleTurns(scope, threadId, Object.values(timeline.turnsById), "archive");
  }).immediate();
}
