import type { EarlyReplySource } from "../conversations/early-reply-observation.js";
import type { ThreadActivityService } from "../conversations/thread-activity-service.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { UserInputRevisionRepository } from "../db/repositories/user-input-revision-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { NotificationService } from "./notification-service.js";

const titleGraphemes = new Intl.Segmenter(undefined, {granularity: "grapheme"});

function earlyThreadTitle(title: string): string {
  if (title.length <= 512) return title;
  const cluster = titleGraphemes.segment(title).containing(511)!;
  return title.slice(0, cluster.index + cluster.segment.length > 512 ? cluster.index : 512);
}

/** Capture scope and user intent on the live source rail, before the asynchronous admission check. */
export function captureTurnEarlyReply(notifications: NotificationService, inventory: InventoryRepository,
  completions: SubmissionCompletionRepository, inputs: UserInputRevisionRepository, activity: ThreadActivityService | undefined,
  scope: RequestScope, threadId: string, source: EarlyReplySource) {
  return notifications.captureEarlyReply(scope, threadId, source, () => {
    if (!activity) return;
    const read = () => inputs.capture(scope, threadId, source.backendCorrelations);
    const initial = read();
    if (initial.superseded) return;
    const origin = activity.originForTurn(scope, threadId, source.applicationTurnId);
    return {
      threadTitle: earlyThreadTitle(inventory.getThread(scope, threadId).thread.title),
      userInputRevision: initial.userInputRevision,
      ...(origin ? {origin} : {}),
      admitted: () => completions.hasActiveAcceptedCorrelation(scope, threadId, source.backendCorrelations),
      fresh: () => {
        const current = read();
        return !current.superseded && current.userInputRevision === initial.userInputRevision;
      },
    };
  });
}
