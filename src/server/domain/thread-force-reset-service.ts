import type {
  ThreadForceResetImpact,
  ThreadForceResetRequest,
  ThreadForceResetResult,
} from "../../shared/protocol/api.js";
import type {
  ThreadForceResetConversationRuntimeBlocker,
  ThreadForceResetPendingInteractionBlocker,
  ThreadForceResetRepository,
} from "../db/repositories/thread-force-reset-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface ThreadForceResetInteractionState {
  listPending(
    scope: RequestScope,
    applicationThreadId: string,
  ): readonly { readonly id: string }[];
  /**
   * Abandon the exact pending interactions in Sedes and send each
   * provider-owned one the backend-neutral cancel response. The returned
   * promise never rejects; it settles once those cancellations are delivered
   * or have failed.
   */
  abandonPending(
    scope: RequestScope,
    applicationThreadId: string,
    interactionIds: readonly string[],
  ): Promise<void>;
}

/**
 * Bound on waiting for provider cancellations of abandoned interactions before
 * the runtime is replaced. The durable reset has already committed.
 */
const PROVIDER_DENIAL_WAIT_MILLISECONDS = 10_000;

export interface ThreadForceResetRuntimeState {
  captureLoadedRuntime(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadForceResetConversationRuntimeBlocker | undefined>;
  forceResetLoadedRuntime(
    scope: RequestScope,
    applicationThreadId: string,
    expected: ThreadForceResetConversationRuntimeBlocker,
  ): Promise<boolean>;
}

/**
 * User-authoritative abandonment of unresolved Sedes state plus exact loaded
 * runtime replacement. Provider reconciliation is not an admission condition.
 */
export class ThreadForceResetService {
  constructor(
    readonly input: {
      readonly repository: ThreadForceResetRepository;
      readonly interactions: ThreadForceResetInteractionState;
      readonly scheduleThreadPublications?: (
        scope: RequestScope,
        threadIds: readonly string[],
      ) => void;
      readonly runtimes: ThreadForceResetRuntimeState;
      readonly publishTaskChange?: (
        scope: RequestScope,
        taskId: string,
      ) => Promise<void>;
      readonly onPostCommitError?: (error: unknown) => void;
      readonly now?: () => number;
    },
  ) {}

  async impact(
    scope: RequestScope,
    threadId: string,
  ): Promise<ThreadForceResetImpact> {
    const repositoryImpact = this.input.repository.impact(scope, threadId);
    const affectedThreadIds = repositoryImpact.affectedThreads.map(
      ({ threadId: affectedThreadId }) => affectedThreadId,
    );
    const pendingInteractions = this.#pendingInteractions(
      scope,
      affectedThreadIds,
    );
    const conversationRuntimes = await this.#conversationRuntimes(
      scope,
      affectedThreadIds,
    );
    return pendingInteractions.length === 0 && conversationRuntimes.length === 0
      ? repositoryImpact
      : this.input.repository.impact(
          scope,
          threadId,
          pendingInteractions,
          conversationRuntimes,
        );
  }

  async forceReset(
    scope: RequestScope,
    threadId: string,
    input: ThreadForceResetRequest,
  ): Promise<ThreadForceResetResult> {
    const repositoryImpact = this.input.repository.impact(scope, threadId);
    const affectedThreadIds = repositoryImpact.affectedThreads.map(
      ({ threadId: affectedThreadId }) => affectedThreadId,
    );
    const pendingInteractions = this.#pendingInteractions(
      scope,
      affectedThreadIds,
    );
    const conversationRuntimes = await this.#conversationRuntimes(
      scope,
      affectedThreadIds,
    );
    const committed = this.input.repository.forceReset(scope, threadId, {
      ...input,
      now: this.input.now?.() ?? Date.now(),
      pendingInteractions,
      conversationRuntimes,
    });
    if (!committed.replayed && pendingInteractions.length > 0) {
      const denials: Promise<void>[] = [];
      try {
        for (const affectedThreadId of committed.affectedThreadIds) {
          const interactionIds = pendingInteractions
            .filter(
              ({ threadId: pendingThreadId }) =>
                pendingThreadId === affectedThreadId,
            )
            .map(({ id }) => id);
          if (interactionIds.length > 0) {
            denials.push(
              this.input.interactions.abandonPending(
                scope,
                affectedThreadId,
                interactionIds,
              ),
            );
          }
        }
      } catch (error) {
        this.#reportPostCommitError(error);
      }
      // A replaced remote runtime would otherwise leave the provider waiting
      // on a prompt that nobody can answer. Cancel it first, within a bound;
      // a backend that cannot cancel a kind releases it with the runtime.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(denials),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PROVIDER_DENIAL_WAIT_MILLISECONDS);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    // A receipt replay is observational: it must never retire a newer runtime
    // generation that appeared after the original commit.
    if (!committed.replayed) {
      for (const runtime of committed.resetConversationRuntimes) {
        try {
          const reset = await this.input.runtimes.forceResetLoadedRuntime(
            scope,
            runtime.threadId,
            runtime,
          );
          if (!reset) {
            this.#reportPostCommitError(
              new Error("thread_force_reset_runtime_evidence_changed"),
            );
          }
        } catch (error) {
          // The durable reset already committed. Retaining a runtime whose
          // close was not proved is safer than creating a competing owner.
          this.#reportPostCommitError(error);
        }
      }
    }
    try {
      this.input.scheduleThreadPublications?.(
        scope,
        committed.affectedThreadIds,
      );
    } catch (error) {
      this.#reportPostCommitError(error);
    }
    for (const taskId of committed.promotedTaskIds) {
      void this.input
        .publishTaskChange?.(scope, taskId)
        .catch((error: unknown) => this.#reportPostCommitError(error));
    }
    return {
      resetAt: committed.resetAt,
      blockerFingerprint: committed.blockerFingerprint,
      resetBlockers: [...committed.resetBlockers],
      affectedThreadIds: [...committed.affectedThreadIds],
    };
  }

  #reportPostCommitError(error: unknown): void {
    try {
      this.input.onPostCommitError?.(error);
    } catch {
      // Diagnostic observers cannot undo the already-committed reset.
    }
  }

  #pendingInteractions(
    scope: RequestScope,
    threadIds: readonly string[],
  ): readonly ThreadForceResetPendingInteractionBlocker[] {
    return threadIds
      .flatMap((affectedThreadId) =>
        this.input.interactions
          .listPending(scope, affectedThreadId)
          .map(({ id }) => ({
            kind: "pending_interaction" as const,
            id,
            threadId: affectedThreadId,
          })),
      )
      .sort(
        (left, right) =>
          left.threadId.localeCompare(right.threadId) ||
          left.id.localeCompare(right.id),
      );
  }

  async #conversationRuntimes(
    scope: RequestScope,
    threadIds: readonly string[],
  ): Promise<readonly ThreadForceResetConversationRuntimeBlocker[]> {
    const captured = await Promise.all(
      threadIds.map((threadId) =>
        this.input.runtimes.captureLoadedRuntime(scope, threadId),
      ),
    );
    return captured
      .filter(
        (
          runtime,
        ): runtime is ThreadForceResetConversationRuntimeBlocker =>
          runtime !== undefined,
      )
      .sort((left, right) => left.threadId.localeCompare(right.threadId));
  }
}
