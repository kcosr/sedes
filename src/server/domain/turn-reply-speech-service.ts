import type { TurnReplySpeech } from "../../shared/protocol/turn-reply-speech.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { selectAssistantResult } from "./assistant-result-selection.js";
import type { NotificationService } from "./notification-service.js";

/**
 * Reply text for replaying one ended turn through native voice: the turn's
 * stored completion classification, selected and fitted exactly as a
 * `turn.completed` notification would be under the principal's current
 * `assistantResultPhases`. Read-only; it never attaches a runtime or consumes
 * notification events.
 */
export class TurnReplySpeechService {
  constructor(
    private readonly input: {
      readonly inventory: Pick<InventoryRepository, "getThread">;
      readonly completions: Pick<SubmissionCompletionRepository, "latestClassifiedResult">;
      readonly notifications: Pick<NotificationService, "read">;
    },
  ) {}

  read(scope: RequestScope, threadId: string, turnId: string): TurnReplySpeech {
    // An unknown or wrong-scope thread is not found; it never falls back.
    this.input.inventory.getThread(scope, threadId);
    const stored = this.input.completions.latestClassifiedResult(scope, threadId, turnId);
    if (stored === null) return { assistantResult: null };
    const { assistantResultPhases } = this.input.notifications.read(scope);
    // Alone in its envelope, even empty sections always fit the budget.
    return { assistantResult: selectAssistantResult(stored, assistantResultPhases) ?? null };
  }
}
