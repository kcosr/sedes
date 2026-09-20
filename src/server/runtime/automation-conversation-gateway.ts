import type { RequestScope } from "../identity/identity-provider.js";
import type {
  QueuedInputRecord,
  QueuedInputRepository,
} from "../db/repositories/queued-input-repository.js";
import type { AutomationRepository } from "../db/repositories/automation-repository.js";
import type { AutomationService } from "../domain/automation-service.js";
import type { QueuedInputDispatcher } from "../conversations/queued-input-dispatcher.js";
import { DomainError } from "../domain/errors.js";
import type { AutomationExecutionPolicy } from "./automation-execution-policy.js";
import type { ThreadForkService } from "../conversations/thread-fork-service.js";

export type AutomationConversationDispatchResult =
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
export interface AutomationConversationGateway {
  dispatch(input: {
    readonly scope: RequestScope;
    readonly automationId: string;
    readonly automationRunId: string;
    readonly anchorThreadId: string;
    readonly runMode: "same_thread" | "clone";
    readonly prompt: string;
    readonly dispatchMutationId: string;
  }): Promise<AutomationConversationDispatchResult>;
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
    readonly expectedThreadRevision: number;
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
  readonly #now: () => number;
  readonly #executionPolicy: AutomationExecutionPolicy;

  constructor(input: {
    readonly threads: AutomationThreadExecutionStateReader;
    readonly queue: Pick<QueuedInputDispatcher, "enqueue">;
    readonly queueRepository: Pick<QueuedInputRepository, "findByMutationId">;
    readonly firstInput: AutomationFirstInputLifecycle;
    readonly branches: Pick<ThreadForkService, "forkAutomation">;
    readonly executionPolicy: AutomationExecutionPolicy;
    readonly now?: () => number;
  }) {
    this.#threads = input.threads;
    this.#queue = input.queue;
    this.#queueRepository = input.queueRepository;
    this.#firstInput = input.firstInput;
    this.#branches = input.branches;
    this.#executionPolicy = input.executionPolicy;
    this.#now = input.now ?? Date.now;
  }

  async dispatch(input: {
    readonly scope: RequestScope;
    readonly automationId: string;
    readonly automationRunId: string;
    readonly anchorThreadId: string;
    readonly runMode: "same_thread" | "clone";
    readonly prompt: string;
    readonly dispatchMutationId: string;
  }): Promise<AutomationConversationDispatchResult> {
    if (input.runMode === "clone") {
      const fork = await this.#branches.forkAutomation({
        scope: input.scope,
        anchorThreadId: input.anchorThreadId,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
        mutationId: input.dispatchMutationId,
      });
      if (fork.status === "recovery_required") {
        return {
          status: "uncertain",
          targetThreadId: fork.childThreadId,
          diagnostic: fork.diagnostic,
        };
      }
      if (fork.status === "aborted") {
        throw new DomainError("runtime_unavailable", fork.diagnostic);
      }
      const child = this.#threads.read(input.scope, fork.childThreadId);
      if (child.backingState !== "bound") {
        throw new DomainError(
          "materialization_unresolved",
          "The automation fork child is not durably bound.",
        );
      }
      await this.#queue.enqueue(input.scope, fork.childThreadId, {
        mutationId: input.dispatchMutationId,
        text: input.prompt,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: child.revision,
          automationId: input.automationId,
          automationRunId: input.automationRunId,
        },
        now: this.#now(),
      });
      const item = this.#queueRepository.findByMutationId(
        input.scope,
        fork.childThreadId,
        input.dispatchMutationId,
      );
      if (!item) throw new Error("automation_queue_receipt_missing");
      return queueResult(fork.childThreadId, item);
    }

    this.#executionPolicy.assertCanAutomate(input.scope, input.anchorThreadId);

    if (this.#firstInput.hasMutation(input.scope, input.dispatchMutationId)) {
      const result = await this.#firstInput.submit({
        scope: input.scope,
        applicationThreadId: input.anchorThreadId,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
        prompt: input.prompt,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        mutationId: input.dispatchMutationId,
        expectedThreadRevision: 0,
      });
      return { ...result, targetThreadId: input.anchorThreadId };
    }

    const thread = this.#threads.read(input.scope, input.anchorThreadId);
    if (thread.backingState === "bound") {
      await this.#queue.enqueue(input.scope, input.anchorThreadId, {
        mutationId: input.dispatchMutationId,
        text: input.prompt,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: thread.revision,
          automationId: input.automationId,
          automationRunId: input.automationRunId,
        },
        now: this.#now(),
      });
      const item = this.#queueRepository.findByMutationId(
        input.scope,
        input.anchorThreadId,
        input.dispatchMutationId,
      );
      if (!item) {
        throw new Error("automation_queue_receipt_missing");
      }
      return queueResult(input.anchorThreadId, item);
    }
    if (thread.backingState === "unbound") {
      const result = await this.#firstInput.submit({
        scope: input.scope,
        applicationThreadId: input.anchorThreadId,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
        prompt: input.prompt,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        mutationId: input.dispatchMutationId,
        expectedThreadRevision: thread.revision,
      });
      return { ...result, targetThreadId: input.anchorThreadId };
    }
    throw new DomainError(
      "materialization_unresolved",
      "The automation thread has unresolved conversation creation state.",
    );
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
        state: successful ? "completed" : "failed",
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
