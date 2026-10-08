import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type {
  NotificationAssistantResultPhase,
  SelectedAssistantResult,
} from "../../shared/protocol/notification.js";
import type { BoundedText } from "../../shared/protocol/payload.js";
import type { TurnReplySpeech } from "../../shared/protocol/turn-reply-speech.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { selectAssistantResult } from "./assistant-result-selection.js";
import type { NotificationService } from "./notification-service.js";

const hasText = (section: BoundedText | null | undefined) => Boolean(section?.text.trim());
const WHOLE_REPLY_PHASES: readonly NotificationAssistantResultPhase[] = ["unclassified"];

/**
 * Reply text for replaying one ended turn through native voice, shared by the
 * turn footer's speaker (`reply-speech` route) and `client.replay_turn`.
 * Read-only; it never attaches a runtime or consumes notification events.
 */
export class TurnReplySpeechService {
  constructor(
    private readonly input: {
      readonly inventory: Pick<InventoryRepository, "getThread">;
      readonly completions: Pick<SubmissionCompletionRepository, "latestClassifiedResult" | "latestAssistantResult" | "latestReplyTurnId">;
      readonly notifications: Pick<NotificationService, "read">;
    },
  ) {}

  read(scope: RequestScope, threadId: string, turnId: string): TurnReplySpeech {
    return { assistantResult: this.select(scope, threadId, turnId) };
  }

  /**
   * The thread's most recently completed turn with a stored reply, from stored
   * completion observations only. A running turn is never returned. Null when
   * the thread has none.
   */
  latestReplyTurnId(scope: RequestScope, threadId: string): string | null {
    // An unknown or wrong-scope thread is not found; it never falls back.
    this.input.inventory.getThread(scope, threadId);
    return this.input.completions.latestReplyTurnId(scope, threadId);
  }

  /**
   * The turn's stored completion classification, selected by the principal's
   * current `assistantResultPhases` as a `turn.completed` notification would
   * be, when a selected section has non-blank text. Otherwise the turn's
   * stored whole reply as `{ unclassified }`. Either is fitted, as
   * `assistantResult` beside `envelope`'s other fields, into the 64 KiB
   * notification budget. Null when Sedes stored no non-blank reply text for
   * the turn, including an unknown turn ID or one Sedes never submitted.
   */
  select(scope: RequestScope, threadId: string, turnId: string, envelope: object = {}): SelectedAssistantResult | null {
    // An unknown or wrong-scope thread is not found; it never falls back.
    this.input.inventory.getThread(scope, threadId);
    const classified = this.input.completions.latestClassifiedResult(scope, threadId, turnId);
    if (classified !== null) {
      const { assistantResultPhases } = this.input.notifications.read(scope);
      if (assistantResultPhases.some((phase) => hasText(classified[phase]))) {
        return fit(classified, assistantResultPhases, envelope);
      }
    }
    const whole = this.input.completions.latestAssistantResult(scope, threadId, turnId);
    if (!hasText(whole)) return null;
    return fit({ provisional: null, final: null, unclassified: whole }, WHOLE_REPLY_PHASES, envelope);
  }
}

function fit(
  result: ClassifiedAssistantResult,
  phases: readonly NotificationAssistantResultPhase[],
  envelope: object,
): SelectedAssistantResult {
  const selected = selectAssistantResult(result, phases, envelope);
  // Empty sections always fit beside the route's empty envelope and a client command's bounded fields.
  if (!selected) throw new Error("turn_reply_speech_envelope_too_large");
  return selected;
}
