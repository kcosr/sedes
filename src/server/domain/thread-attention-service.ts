import type { DismissThreadAttentionRequest } from "../../shared/protocol/api.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { QueuedInputDispatcher } from "../conversations/queued-input-dispatcher.js";

export class ThreadAttentionService {
  constructor(
    readonly input: {
      readonly inventory: InventoryRepository;
      readonly completions: SubmissionCompletionRepository;
      readonly queue: QueuedInputDispatcher;
      readonly now?: () => number;
      readonly publish: (
        scope: RequestScope,
        applicationThreadId: string,
      ) => void | Promise<void>;
    },
  ) {
    if (input.inventory.database !== input.completions.database) {
      throw new Error("thread_attention_database_mismatch");
    }
  }

  async dismiss(
    scope: RequestScope,
    applicationThreadId: string,
    request: DismissThreadAttentionRequest,
  ): Promise<void> {
    // Authorization is deliberately established before selecting the
    // attention-specific transition.
    this.input.inventory.getThread(scope, applicationThreadId);
    if (request.kind === "wake") {
      this.input.inventory.acknowledgeWake(
        scope,
        applicationThreadId,
        Date.parse(request.wokeAt),
        this.#now(),
      );
    } else if (request.kind === "automation_context") {
      this.input.inventory.dismissAutomationContext(
        scope,
        applicationThreadId,
        request.runId,
      );
    } else if (request.kind === "unseen_completion") {
      this.input.completions.acknowledgeThrough(
        scope,
        applicationThreadId,
        request.operationId,
        this.#now(),
      );
    } else {
      await this.input.queue.acknowledgeFailure(
        scope,
        applicationThreadId,
        request.queuedInputId,
        this.#now(),
      );
    }
    await this.input.publish(scope, applicationThreadId);
  }

  #now(): number {
    return (this.input.now ?? Date.now)();
  }
}
