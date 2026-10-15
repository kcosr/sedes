import { AutomationDeferredError } from "../domain/automation-deferred.js";
import type { AutomationForkTargetResolver } from "./automation-fork-target.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  QueuedInputRecord,
  QueuedInputRepository,
} from "../db/repositories/queued-input-repository.js";
import type { AutomationRepository } from "../db/repositories/automation-repository.js";
import type { SubmissionCompletionObservationRecord } from "../db/repositories/submission-completion-repository.js";
import type { AutomationService } from "../domain/automation-service.js";
import type { QueuedInputDispatcher } from "../conversations/queued-input-dispatcher.js";
import { DomainError } from "../domain/errors.js";
import type { AutomationExecutionPolicy } from "./automation-execution-policy.js";
import type { ThreadForkService } from "../conversations/thread-fork-service.js";

export type AutomationConversationDispatchResult =
  | { readonly status: "deferred"; readonly reason: AutomationDeferredError["reason"]; readonly eligibleAt: number | null }
  | {
      readonly status: "accepted";
      readonly targetThreadId: string;
    }
  | {
      readonly status: "queued" | "running";
      readonly targetThreadId: string;
    }
  | {
      readonly status: "uncertain";
      readonly targetThreadId: string;
      readonly diagnostic: string;
    };

/**
 * Backend-neutral automation execution boundary.
 *
 * The production implementation composes the conversation lifecycle service,
 * the single-writer actor manager, the durable queued-input dispatcher, the
 * backend checkpoint store, and branch creation. The dispatcher supplies only
 * application IDs and never sees provider conversation IDs or native paths.
 *
 * Implementations must replay `dispatchMutationId` idempotently. A clone
 * result is not accepted until both the branch child binding and its source
 * checkpoint are durably persisted.
 */
export type AutomationConversationDispatchInput = {
  readonly scope: RequestScope;
  readonly automationId: string;
  readonly automationRunId: string;
  readonly anchorThreadId: string;
  readonly prompt: string;
  readonly dispatchMutationId: string;
  readonly claimToken: string;
} & (
  | { readonly runMode: "same_thread" }
  | {
      readonly runMode: "clone";
      /** Appended to the anchor title when the run's result thread is created. */
      readonly resultTitleSuffix: string;
    }
);

export interface AutomationConversationGateway {
  dispatch(
    input: AutomationConversationDispatchInput,
  ): Promise<AutomationConversationDispatchResult>;
}

export interface AutomationThreadExecutionStateReader {
  read(
    scope: RequestScope,
    applicationThreadId: string,
  ): {
    readonly backingState:
      "unbound" | "creating" | "bound" | "creation_unknown";
    readonly revision: number;
  };
}

export interface AutomationFirstInputLifecycle {
  hasMutation(scope: RequestScope, mutationId: string): boolean;
  submit(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly automationId: string;
    readonly automationRunId: string;
    readonly prompt: string;
    /** Automation input never inherits interactive composer context. */
    readonly contextExcerpts: readonly [];
    readonly attachmentIds: readonly [];
    readonly taskReferences: readonly [];
    readonly mutationId: string;
    readonly claimToken: string;
  }): Promise<
    | { readonly status: "accepted" }
    | { readonly status: "uncertain"; readonly diagnostic: string }
  >;
}

/**
 * Concrete orchestration adapter for the existing lifecycle components.
 *
 * Bound same-thread work enters the durable queue, whose dispatcher owns the
 * actor submission and reconciliation boundary. Unbound work enters the
 * conversation-creation lifecycle. Clone work uses the checkpoint-aware branch
 * lifecycle as one idempotent operation.
 */
export class LifecycleAutomationConversationGateway implements AutomationConversationGateway {
  readonly #threads: AutomationThreadExecutionStateReader;
  readonly #queue: Pick<QueuedInputDispatcher, "enqueue">;
  readonly #queueRepository: Pick<QueuedInputRepository, "findByMutationId">;
  readonly #firstInput: AutomationFirstInputLifecycle;
  readonly #branches: Pick<ThreadForkService, "forkAutomation">;
  readonly #forkTargets: Pick<AutomationForkTargetResolver, "resolve">;
  readonly #now: () => number;
  readonly #executionPolicy: AutomationExecutionPolicy;

  constructor(input: {
    readonly threads: AutomationThreadExecutionStateReader;
    readonly queue: Pick<QueuedInputDispatcher, "enqueue">;
    readonly queueRepository: Pick<QueuedInputRepository, "findByMutationId">;
    readonly firstInput: AutomationFirstInputLifecycle;
    readonly branches: Pick<ThreadForkService, "forkAutomation">;
    readonly executionPolicy: AutomationExecutionPolicy;
    readonly forkTargets: Pick<AutomationForkTargetResolver, "resolve">;
    readonly now?: () => number;
  }) {
    this.#forkTargets = input.forkTargets;
    this.#threads = input.threads;
    this.#queue = input.queue;
    this.#queueRepository = input.queueRepository;
    this.#firstInput = input.firstInput;
    this.#branches = input.branches;
    this.#executionPolicy = input.executionPolicy;
    this.#now = input.now ?? Date.now;
  }

  async dispatch(
    input: AutomationConversationDispatchInput,
  ): Promise<AutomationConversationDispatchResult> {
    try {
      let targetThreadId = input.anchorThreadId;
      if (input.runMode === "clone") {
        const resolved = await this.#forkTargets.resolve(input);
        if (resolved.kind === "child") {
          targetThreadId = resolved.childThreadId;
        } else {
          const fork = await this.#branches.forkAutomation({
            scope: input.scope,
            anchorThreadId: input.anchorThreadId,
            automationId: input.automationId,
            automationRunId: input.automationRunId,
            mutationId: input.dispatchMutationId,
            claimToken: input.claimToken,
            titleSuffix: input.resultTitleSuffix,
          });
          if (fork.status === "recovery_required") return {
            status: "uncertain", targetThreadId: fork.childThreadId, diagnostic: fork.diagnostic,
          };
          if (fork.status === "aborted") throw new DomainError("runtime_unavailable", fork.diagnostic);
          targetThreadId = fork.childThreadId;
        }
      }
      return await this.#submit(input, targetThreadId);
    } catch (error) {
      if (error instanceof AutomationDeferredError) return {
        status: "deferred", reason: error.reason, eligibleAt: error.eligibleAt,
      };
      throw error;
    }
  }

  async #submit(input: AutomationConversationDispatchInput, targetThreadId: string): Promise<AutomationConversationDispatchResult> {
    // Evidence from a previous submission wins over current policy/configuration.
    const existing = this.#queueRepository.findByMutationId(input.scope, targetThreadId, input.dispatchMutationId);
    if (existing) {
      if (existing.sourceAutomationId !== input.automationId || existing.sourceAutomationRunId !== input.automationRunId || existing.text !== input.prompt) {
        throw new DomainError("conflict", "The automation queue receipt belongs to different input.");
      }
      return queueResult(targetThreadId, existing);
    }
    if (this.#firstInput.hasMutation(input.scope, input.dispatchMutationId)) {
      const result = await this.#firstInput.submit({
        scope: input.scope, applicationThreadId: targetThreadId,
        automationId: input.automationId, automationRunId: input.automationRunId,
        prompt: input.prompt, contextExcerpts: [], attachmentIds: [], taskReferences: [],
        mutationId: input.dispatchMutationId, claimToken: input.claimToken,
      });
      return { ...result, targetThreadId };
    }
    this.#executionPolicy.assertCanAutomate(input.scope, input.anchorThreadId);
    this.#executionPolicy.assertCanAutomate(input.scope, targetThreadId);
    const thread = this.#threads.read(input.scope, targetThreadId);
    if (thread.backingState === "bound") {
      await this.#queue.enqueue(input.scope, targetThreadId, {
        mutationId: input.dispatchMutationId, text: input.prompt,
        contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "automation", claimToken: input.claimToken, automationId: input.automationId, automationRunId: input.automationRunId },
        now: this.#now(),
      });
      const item = this.#queueRepository.findByMutationId(input.scope, targetThreadId, input.dispatchMutationId);
      if (!item) throw new Error("automation_queue_receipt_missing");
      return queueResult(targetThreadId, item);
    }
    if (thread.backingState === "unbound") {
      try {
        const result = await this.#firstInput.submit({
          scope: input.scope, applicationThreadId: targetThreadId,
          automationId: input.automationId, automationRunId: input.automationRunId,
          prompt: input.prompt, contextExcerpts: [], attachmentIds: [], taskReferences: [],
          mutationId: input.dispatchMutationId, claimToken: input.claimToken,
        });
        return { ...result, targetThreadId };
      } catch (error) {
        if (error instanceof AutomationDeferredError) throw error;
        // Another first-send can win while async configuration is being validated.
        // Only a proven absent attempt can be retried as queue admission.
        if (!this.#firstInput.hasMutation(input.scope, input.dispatchMutationId) &&
            error instanceof DomainError && (error.code === "conflict" || error.code === "materialization_unresolved")) {
          throw new AutomationDeferredError("source_materializing", "The automation target changed before its first input was reserved.");
        }
        throw error;
      }
    }
    throw new AutomationDeferredError(thread.backingState === "creating" ? "source_materializing" : "source_recovery", "The automation target is waiting for conversation creation to settle.");
  }

}

function queueResult(
  targetThreadId: string,
  item: QueuedInputRecord,
): AutomationConversationDispatchResult {
  switch (item.state) {
    case "accepted":
      return { status: "accepted", targetThreadId };
    case "pending":
    case "retry_wait":
    case "dispatching":
      return { status: "queued", targetThreadId };
    case "uncertain":
      return {
        status: "uncertain",
        targetThreadId,
        diagnostic:
          item.diagnostic ?? "Automation submission acceptance is uncertain.",
      };
    case "failed":
      throw new DomainError(
        "runtime_unavailable",
        item.diagnostic ?? "The queued automation input failed.",
      );
    case "cancelled":
      throw new DomainError(
        "conflict",
        "The queued automation input was cancelled.",
      );
  }
}

/**
 * Completion hook for the durable queue publisher. Production queue event
 * wiring calls this after each durable state change, before broadcasting the
 * normalized queue snapshot.
 */
export class AutomationQueueRunObserver {
  readonly #repository: Pick<
    AutomationRepository,
    | "listQueueObservedRuns"
    | "findRunByDispatchMutation"
    | "getDefinition"
    | "markRunUncertainAndPause"
    | "updateRunState"
  >;
  readonly #queue: Pick<QueuedInputRepository, "findByMutationId">;
  readonly #publisher: Pick<AutomationService, "publishRun">;
  readonly #now: () => number;

  constructor(input: {
    readonly repository: Pick<
      AutomationRepository,
      | "listQueueObservedRuns"
      | "findRunByDispatchMutation"
      | "getDefinition"
      | "markRunUncertainAndPause"
      | "updateRunState"
    >;
    readonly queue: Pick<QueuedInputRepository, "findByMutationId">;
    readonly publisher: Pick<AutomationService, "publishRun">;
    readonly now?: () => number;
  }) {
    this.#repository = input.repository;
    this.#queue = input.queue;
    this.#publisher = input.publisher;
    this.#now = input.now ?? Date.now;
  }

  recover(): void {
    for (const run of this.#repository.listQueueObservedRuns()) {
      const scope: RequestScope = {
        tenantId: run.tenantId,
        principalId: run.ownerPrincipalId,
      };
      const targetThreadId = run.childThreadId ?? run.anchorThreadId;
      const item = this.#queue.findByMutationId(
        scope,
        targetThreadId,
        run.dispatchMutationId,
      );
      if (item) this.observe(scope, targetThreadId, item);
    }
  }

  observe(
    scope: RequestScope,
    applicationThreadId: string,
    item: QueuedInputRecord,
  ): void {
    const run = this.#repository.findRunByDispatchMutation(
      scope,
      applicationThreadId,
      item.mutationId,
    );
    if (!run || (run.state !== "queued" && run.state !== "running")) return;
    if (
      item.state === "pending" ||
      item.state === "retry_wait" ||
      item.state === "dispatching"
    ) {
      return;
    }
    const now = this.#now();
    if (item.state === "uncertain") {
      this.#publisher.publishRun(
        scope,
        this.#repository.markRunUncertainAndPause(
          scope,
          run.automationId,
          run.id,
          {
            expectedState: run.state,
            errorCode: "automation_dispatch_uncertain",
            errorDiagnostic:
              item.diagnostic ??
              "Automation submission acceptance is uncertain.",
            now,
          },
        ),
      );
      return;
    }
    const successful = item.state === "accepted";
    const definition = this.#repository.getDefinition(scope, run.automationId);
    this.#publisher.publishRun(
      scope,
      this.#repository.updateRunState(scope, run.automationId, run.id, {
        expectedState: run.state,
        state: successful ? "completed" : item.state === "cancelled" ? "cancelled" : "failed",
        ...(successful
          ? {}
          : {
              errorCode:
                item.state === "cancelled"
                  ? "automation_dispatch_cancelled"
                  : "automation_dispatch_failed",
              errorDiagnostic:
                item.diagnostic ??
                (item.state === "cancelled"
                  ? "The queued automation input was cancelled."
                  : "The queued automation input failed."),
            }),
        now,
        completeDefinition:
          run.occurrenceKind === "scheduled" &&
          definition.schedule.kind === "date_time",
      }),
    );
  }
}

/**
 * Completion-rail hook for automation run history. Production calls it after
 * an authoritative completion observation commits, both live and on every
 * snapshot replay, so a run's turn settlement is written once and published
 * only when this changed the run. It never touches run state or scheduling.
 */
export class AutomationTurnSettlementObserver {
  readonly #repository: Pick<
    AutomationRepository,
    "settleRunTurn" | "settleRunTurnsFromCompletions"
  >;
  readonly #publisher: Pick<AutomationService, "publishRunSettlement">;

  constructor(input: {
    readonly repository: Pick<
      AutomationRepository,
      "settleRunTurn" | "settleRunTurnsFromCompletions"
    >;
    readonly publisher: Pick<AutomationService, "publishRunSettlement">;
  }) {
    this.#repository = input.repository;
    this.#publisher = input.publisher;
  }

  /** Settles runs whose turn the rail recorded while no observer was bound. */
  recover(): void {
    const published = new Set<string>();
    for (const run of this.#repository.settleRunTurnsFromCompletions()) {
      const key = JSON.stringify([
        run.tenantId,
        run.ownerPrincipalId,
        run.automationId,
        run.anchorThreadId,
        run.childThreadId,
      ]);
      if (published.has(key)) continue;
      published.add(key);
      this.#publisher.publishRunSettlement(
        { tenantId: run.tenantId, principalId: run.ownerPrincipalId },
        run,
      );
    }
  }

  /**
   * `observation` is the rail record for one accepted operation on
   * `applicationThreadId`; `turn` carries the backend turn's own times.
   */
  observe(
    scope: RequestScope,
    applicationThreadId: string,
    observation: Pick<
      SubmissionCompletionObservationRecord,
      | "operationId"
      | "applicationTurnId"
      | "completionOutcome"
      | "completionObservedAt"
    >,
    turn: { readonly startedAt?: string; readonly completedAt?: string } = {},
  ): void {
    if (
      observation.applicationTurnId === null ||
      observation.completionOutcome === null ||
      observation.completionObservedAt === null
    ) {
      return;
    }
    const run = this.#repository.settleRunTurn(
      scope,
      applicationThreadId,
      observation.operationId,
      {
        turnId: observation.applicationTurnId,
        outcome: observation.completionOutcome,
        settledAt: observation.completionObservedAt,
        ...turnTimes(turn),
      },
    );
    if (run) this.#publisher.publishRunSettlement(scope, run);
  }
}

/**
 * Backend turn times in milliseconds. Times that end before they start are
 * dropped together, so no false duration is recorded.
 */
function turnTimes(turn: {
  readonly startedAt?: string;
  readonly completedAt?: string;
}): { readonly startedAt: number | null; readonly endedAt: number | null } {
  const startedAt = turnTime(turn.startedAt);
  const endedAt = turnTime(turn.completedAt);
  return startedAt !== null && endedAt !== null && endedAt < startedAt
    ? { startedAt: null, endedAt: null }
    : { startedAt, endedAt };
}

function turnTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? milliseconds
    : null;
}
