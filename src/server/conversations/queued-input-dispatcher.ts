import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type { SteerTarget } from "../../shared/protocol/conversation.js";
import type { NormalizedThreadEvent } from "../../shared/protocol/conversation.js";
import type { QueuedInputSummary } from "../../shared/protocol/conversation.js";
import type { BoundedText } from "../../shared/protocol/payload.js";
import { BackendError, type SubmitTurnResult } from "../backends/contracts.js";
import {
  ConversationOperationRepository,
  type QueuedInputSteerOperationRecord,
} from "../db/repositories/conversation-operation-repository.js";
import {
  isResolvedSteer,
  MAXIMUM_ACTIVE_QUEUED_INPUTS,
  type QueuedInputRecord,
  type QueuedInputRepository,
  type QueueRetryPolicy,
} from "../db/repositories/queued-input-repository.js";
import {
  SubmissionCompletionRepository,
  type SubmissionCompletionObservationRecord,
} from "../db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "../domain/errors.js";
import { projectQueuedInputSummaries } from "./queued-input-projection.js";
import type {
  QueuedInputConversation,
  QueuedInputConversationGateway,
} from "./queued-input-conversation-gateway.js";

/*
 * Keep provider-private target diagnostics at the adapter boundary. The
 * dispatcher consumes only normalized proof that this exact Steer was unsent.
 */
function isSteerTargetUnavailable(error: unknown): boolean {
  return (
    (error instanceof DomainError &&
      error.code === "steer_target_unavailable") ||
    (error instanceof BackendError &&
      !error.crossedSubmissionBoundary &&
      error.steerRejectionReason === "target_no_longer_active")
  );
}

type QueueChangedEvent = Extract<
  NormalizedThreadEvent,
  { readonly type: "queue_changed" }
>;

export interface QueueEventPublisher {
  publish(
    scope: RequestScope,
    applicationThreadId: string,
    event: QueueChangedEvent,
  ): void;
}

export interface QueueDispatchClock {
  now(): number;
}

export interface QueueDispatchScheduler {
  schedule(delayMilliseconds: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

const defaultClock: QueueDispatchClock = { now: Date.now };
const MAXIMUM_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const defaultScheduler: QueueDispatchScheduler = {
  schedule(delayMilliseconds, callback) {
    const timer = setTimeout(callback, delayMilliseconds);
    timer.unref?.();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

class QueuedInputConversationAcquisitionError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Queued conversation acquisition failed.",
      { cause },
    );
    this.name = "QueuedInputConversationAcquisitionError";
  }
}

function scopeKey(scope: RequestScope): string {
  return `${scope.tenantId}\0${scope.principalId}`;
}

function threadKey(scope: RequestScope, applicationThreadId: string): string {
  return `${scopeKey(scope)}\0${applicationThreadId}`;
}

function safeDiagnostic(value: string): string {
  const characters = [...value.trim()];
  return characters.length === 0
    ? "The backend operation failed."
    : characters.slice(0, 500).join("");
}

/**
 * Owns the durable application queue and is its sole normalized-event source.
 *
 * Calls for one scoped thread are serialized independently. Each dispatch
 * invocation claims and attempts at most one head, so a retry or invalid-state
 * transition cannot form an in-memory busy loop.
 */
export class QueuedInputDispatcher {
  readonly #repository: QueuedInputRepository;
  readonly #completion: SubmissionCompletionRepository;
  readonly #operations: ConversationOperationRepository;
  readonly #gateway: QueuedInputConversationGateway;
  readonly #publisher: QueueEventPublisher;
  readonly #retryPolicy: QueueRetryPolicy;
  readonly #clock: QueueDispatchClock;
  readonly #scheduler: QueueDispatchScheduler;
  readonly #isDispatchBlocked: (
    scope: RequestScope,
    applicationThreadId: string,
  ) => boolean;
  readonly #threadTails = new Map<string, Promise<void>>();
  readonly #recoveryByScope = new Map<string, Promise<void>>();
  readonly #retryTimers = new Map<string, unknown>();
  readonly #scheduledSteerIntents = new Set<string>();
  readonly #inflightOperations = new Set<Promise<void>>();
  #closing = false;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(input: {
    readonly repository: QueuedInputRepository;
    readonly gateway: QueuedInputConversationGateway;
    readonly publisher: QueueEventPublisher;
    readonly retryPolicy: QueueRetryPolicy;
    readonly isDispatchBlocked: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => boolean;
    readonly clock?: QueueDispatchClock;
    readonly scheduler?: QueueDispatchScheduler;
  }) {
    this.#repository = input.repository;
    this.#completion = new SubmissionCompletionRepository(
      input.repository.database,
    );
    this.#operations = new ConversationOperationRepository(
      input.repository.database,
    );
    this.#gateway = input.gateway;
    this.#publisher = input.publisher;
    this.#retryPolicy = input.retryPolicy;
    this.#isDispatchBlocked = input.isDispatchBlocked;
    this.#clock = input.clock ?? defaultClock;
    this.#scheduler = input.scheduler ?? defaultScheduler;
    this.#assertRetryPolicy();
  }

  /**
   * Startup boundary for one owner scope. Existing uncertain/dispatching rows
   * are reconciled before any pending row in the scope may be dispatched.
   */
  recover(scope: RequestScope): Promise<void> {
    this.#assertOpen();
    const key = scopeKey(scope);
    const existing = this.#recoveryByScope.get(key);
    if (existing) return existing;
    const recovery = this.#recoverScope(scope);
    this.#recoveryByScope.set(key, recovery);
    void recovery
      .then(() => {
        for (const head of this.#repository.listActiveHeads(scope)) {
          if (head.state === "pending" && isResolvedSteer(head)) {
            this.#scheduleRequestedSteer(scope, head);
          }
        }
      })
      .catch(() => undefined);
    void recovery.catch(() => {
      if (this.#recoveryByScope.get(key) === recovery) {
        this.#recoveryByScope.delete(key);
      }
    });
    return recovery;
  }

  async enqueue(
    scope: RequestScope,
    applicationThreadId: string,
    input: Parameters<QueuedInputRepository["enqueue"]>[2],
  ): Promise<ReturnType<QueuedInputRepository["enqueue"]>> {
    if (
      "resolvedDeliveryMode" in input.source &&
      input.source.resolvedDeliveryMode === "steer"
    ) {
      return this.#track(async () => {
        await this.#requireRecovery(scope);
        const result = this.#repository.enqueue(
          scope,
          applicationThreadId,
          input,
        );
        void this.#track(() =>
          this.#emitQueueChanged(scope, applicationThreadId),
        ).catch(() => undefined);
        this.#scheduleRequestedSteerHead(scope, applicationThreadId);
        return result;
      });
    }
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const result = this.#repository.enqueue(
          scope,
          applicationThreadId,
          input,
        );
        await this.#emitQueueChanged(scope, applicationThreadId);
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
        return {
          ...result,
          // Dispatch can synchronously advance this row beyond the state
          // returned by repository.enqueue(). Callers need the authoritative
          // post-dispatch receipt or a fast acceptance can be mistaken for a
          // still-pending automation run.
          item: this.#repository.get(
            scope,
            applicationThreadId,
            result.item.id,
          ),
        };
      });
    });
  }

  /** Publish and schedule an input admitted by another durable transaction. */
  async dispatchAdmitted(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      await this.#serialize(scope, applicationThreadId, async () => {
        await this.#emitQueueChanged(scope, applicationThreadId);
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
      });
    });
  }

  findComposerDeliveryReplay(
    scope: RequestScope,
    applicationThreadId: string,
    input: Parameters<QueuedInputRepository["findComposerDeliveryReplay"]>[2],
  ): QueuedInputRecord | undefined {
    return this.#repository.findComposerDeliveryReplay(
      scope,
      applicationThreadId,
      input,
    );
  }

  /**
   * Called from an authoritative actor settled event. It attempts one durable
   * head; callers may safely repeat it because claim and per-thread mailbox
   * serialization make the operation idempotent.
   */
  async onAuthoritativeSettled(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      await this.#serialize(scope, applicationThreadId, async () => {
        const pending = this.#operations.findPendingMaterializationSteer(
          scope,
          applicationThreadId,
        );
        if (pending?.source === "queued_input") {
          await this.#reconcileQueuedSteer(scope, pending);
        }
        await this.#dispatchThread(scope, applicationThreadId);
        this.#scheduleRequestedSteerHead(scope, applicationThreadId);
      });
    });
  }

  async reconcileUncertain(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
  ): Promise<QueuedInputRecord> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const item = this.#repository.get(scope, applicationThreadId, id);
        if (item.state !== "uncertain") {
          throw new Error("queued_input_is_not_uncertain");
        }
        await this.#reconcile(scope, item);
        if (this.#repository.get(scope, applicationThreadId, id).state !== "uncertain") {
          await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
        }
        return this.#repository.get(scope, applicationThreadId, id);
      });
    });
  }

  async cancel(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: Parameters<QueuedInputRepository["cancel"]>[3],
  ): Promise<QueuedInputRecord> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const item = this.#repository.database
          .transaction(() => {
            const cancelled = this.#repository.cancel(
              scope,
              applicationThreadId,
              id,
              input,
            );
            return cancelled;
          })
          .immediate();
        await this.#emitQueueChanged(scope, applicationThreadId);
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
        return item;
      });
    });
  }

  async cancelUserInput(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: Parameters<QueuedInputRepository["cancelIdempotently"]>[3],
  ): Promise<
    ReturnType<QueuedInputRepository["cancelIdempotently"]> & {
      readonly threadRevision: number;
      readonly queue: readonly QueuedInputSummary[];
    }
  > {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const result = this.#repository.cancelIdempotently(
          scope,
          applicationThreadId,
          id,
          input,
        );
        if (!result.replayed) {
          await this.#emitQueueChanged(scope, applicationThreadId);
          await this.#dispatchAfterDurableTransition(
            scope,
            applicationThreadId,
          );
        }
        return {
          ...result,
          ...this.#captureQueueProjection(scope, applicationThreadId),
        };
      });
    });
  }

  async restoreUserInput(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: Parameters<QueuedInputRepository["restoreIdempotently"]>[3],
  ): Promise<
    ReturnType<QueuedInputRepository["restoreIdempotently"]> & {
      readonly threadRevision: number;
      readonly queue: readonly QueuedInputSummary[];
    }
  > {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const result = this.#repository.restoreIdempotently(
          scope,
          applicationThreadId,
          id,
          input,
        );
        if (!result.replayed) {
          await this.#emitQueueChanged(scope, applicationThreadId);
          await this.#dispatchAfterDurableTransition(
            scope,
            applicationThreadId,
          );
        }
        return {
          ...result,
          ...this.#captureQueueProjection(scope, applicationThreadId),
        };
      });
    });
  }

  async steerUserInput(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision?: number;
      readonly target?: SteerTarget;
    },
  ): Promise<
    (
      | { readonly status: "accepted" }
      | { readonly status: "pending_materialization" }
      | { readonly status: "restored" }
      | { readonly status: "recovery_required"; readonly retryable: boolean }
    ) & {
      readonly threadRevision: number;
      readonly queue: readonly QueuedInputSummary[];
    }
  > {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const replay = this.#operations.findSteer(scope, input.mutationId);
        if (replay) {
          if (
            replay.source !== "queued_input" ||
            replay.threadId !== applicationThreadId ||
            replay.queuedInputId !== id ||
            (input.expectedThreadRevision !== undefined &&
              replay.expectedThreadRevision !== input.expectedThreadRevision)
          ) {
            throw new DomainError(
              "conflict",
              "The mutation ID is already used by another operation.",
            );
          }
          if (replay.state === "accepted") {
            return {
              status: "accepted" as const,
              ...this.#captureQueueProjection(scope, applicationThreadId),
            };
          }
          if (replay.state === "failed_unknown") {
            throw new DomainError("invalid_transition", replay.failureDiagnostic!);
          }
          if (replay.state === "prepared") {
            this.#restoreQueuedSteer(scope, replay, "dispatching");
            await this.#emitQueueChanged(scope, applicationThreadId);
            await this.#dispatchAfterDurableTransition(
              scope,
              applicationThreadId,
            );
            return {
              status: "restored" as const,
              ...this.#captureQueueProjection(scope, applicationThreadId),
            };
          }
          if (replay.state === "uncertain") {
            const outcome = await this.#reconcileQueuedSteer(scope, replay);
            if (outcome === "failed_unknown") {
              throw new DomainError("invalid_transition",
                this.#operations.getSteer(scope, input.mutationId).failureDiagnostic!);
            }
            if (outcome === "not_sent") {
              throw new DomainError("invalid_transition",
                this.#repository.get(scope, applicationThreadId, id).diagnostic ??
                  "This steering message was not sent.");
            }
            if (outcome === "not_accepted") {
              return {
                status: "restored" as const,
                ...this.#captureQueueProjection(scope, applicationThreadId),
              };
            }
            const current = this.#operations.findSteer(scope, input.mutationId);
            if (current?.state === "accepted") {
              return {
                status: "accepted" as const,
                ...this.#captureQueueProjection(scope, applicationThreadId),
              };
            }
            return {
              status: "recovery_required" as const,
              retryable: true,
              ...this.#captureQueueProjection(scope, applicationThreadId),
            };
          }
          if (replay.state === "pending_materialization") {
            return {
              status: "pending_materialization" as const,
              ...this.#captureQueueProjection(scope, applicationThreadId),
            };
          }
        }
        if (this.#isDispatchBlocked(scope, applicationThreadId)) {
          throw new DomainError(
            "operation_outcome_uncertain",
            "A prior operation must be reconciled before queued input can be steered.",
          );
        }
        return this.#withConversationForSteer(
          scope,
          applicationThreadId,
          async (conversation) => {
            if (!conversation.steerTarget || !conversation.steer) {
              throw new DomainError(
                "invalid_transition",
                "The active backend turn cannot be steered.",
              );
            }
            // A durably admitted conversation target survives turn completion,
            // but must still satisfy current backend steering capabilities.
            const targetOptions = {
              allowSettledConversation: input.target?.kind === "conversation",
            };
            const target = await conversation.steerTarget(targetOptions);
            if (!target) {
              throw new DomainError(
                "steer_target_unavailable",
                "The active backend turn cannot be steered.",
              );
            }
            if (
              input.target !== undefined &&
              JSON.stringify(target) !== JSON.stringify(input.target)
            ) {
              throw new DomainError(
                "steer_target_unavailable",
                "The targeted turn is no longer active.",
              );
            }
            const now = this.#clock.now();
            const expectedThreadRevision =
              input.expectedThreadRevision ??
              this.#repository.readProjectionState(scope, applicationThreadId)
                .threadRevision;
            const prepared = this.#repository.database
              .transaction(() => {
                const reservation = this.#repository.reserveHeadForSteer(
                  scope,
                  applicationThreadId,
                  id,
                  {
                    steerOperationId: input.mutationId,
                    expectedThreadRevision,
                    now,
                  },
                );
                const receipt = this.#operations.prepareQueuedInputSteer(
                  scope,
                  applicationThreadId,
                  {
                    mutationId: input.mutationId,
                    queuedInputId: id,
                    text: reservation.item.text,
                    ...(reservation.item.selectedSkillId === null
                      ? {}
                      : {
                          selectedSkillId: reservation.item.selectedSkillId,
                        }),
                    contextExcerpts: reservation.item.contextExcerpts,
                    attachmentIds: reservation.item.attachments.map(
                      ({ id }) => id,
                    ),
                    taskContexts: reservation.item.taskContexts,
                    expectedThreadRevision,
                    priorQueueState: reservation.priorState,
                    priorNextAttemptAt: reservation.priorNextAttemptAt,
                    priorDiagnostic: reservation.priorDiagnostic,
                    now,
                  },
                );
                return { reservation, receipt };
              })
              .immediate();
            let started: QueuedInputSteerOperationRecord;
            let attachmentDelivery;
            try {
              this.#cancelRetryTimer(scope, applicationThreadId);
              this.#publishQueueChanged(
                scope,
                applicationThreadId,
                conversation.generation,
              );
              const currentTarget = await conversation.steerTarget(targetOptions);
              if (JSON.stringify(currentTarget) !== JSON.stringify(target)) {
                throw new DomainError(
                  "steer_target_unavailable",
                  "The targeted turn is no longer active.",
                );
              }
              attachmentDelivery = await conversation.materializeAttachments(
                prepared.reservation.item.attachments,
              );
              const startedRecord = this.#operations.markSteerSubmissionStarted(
                scope,
                input.mutationId,
                target,
              );
              if (startedRecord.source !== "queued_input") {
                throw new Error("queued_input_steer_receipt_source_mismatch");
              }
              started = startedRecord;
            } catch (error) {
              this.#restoreQueuedSteer(scope, prepared.receipt, "dispatching");
              this.#publishQueueChanged(
                scope,
                applicationThreadId,
                conversation.generation,
              );
              await this.#dispatchAfterDurableTransition(
                scope,
                applicationThreadId,
              );
              throw error;
            }
            try {
              const accepted = await conversation.steer({
                applicationOperationId: started.applicationOperationId,
                mutationId: started.mutationId,
                reconciliationToken: started.reconciliationToken,
                target,
                text: prepared.reservation.item.text,
                ...(started.selectedSkillId === null
                  ? {}
                  : { selectedSkillId: started.selectedSkillId }),
                contextExcerpts: started.contextExcerpts,
                attachments: attachmentDelivery.attachments,
                ...(attachmentDelivery.attachments.length > 0
                  ? {
                      attachmentBytes: attachmentDelivery.canonicalBytes,
                      attachmentEvidence: attachmentDelivery.canonicalEvidence,
                    }
                  : {}),
                taskContexts: started.taskContexts,
                ...(prepared.reservation.item.inputOrigin === null
                  ? {}
                  : { inputOrigin: prepared.reservation.item.inputOrigin }),
              });
              if (
                accepted.reconciliationToken !== started.reconciliationToken ||
                accepted.completionCorrelation !==
                  started.applicationOperationId
              ) {
                this.#markQueuedSteerUncertain(
                  scope,
                  started,
                  accepted.completionCorrelation,
                  "The backend accepted Steer with an invalid reconciliation identity.",
                );
                this.#publishQueueChanged(
                  scope,
                  applicationThreadId,
                  conversation.generation,
                );
                return {
                  status: "recovery_required" as const,
                  retryable: false,
                  ...this.#captureQueueProjection(scope, applicationThreadId),
                };
              }
              const acceptedAt = this.#clock.now();
              if (accepted.status === "pending_materialization") {
                this.#operations.markSteerPendingMaterialization(
                  scope,
                  input.mutationId,
                  acceptedAt,
                );
                this.#publishQueueChanged(
                  scope,
                  applicationThreadId,
                  conversation.generation,
                );
                return {
                  status: "pending_materialization" as const,
                  ...this.#captureQueueProjection(scope, applicationThreadId),
                };
              }
              this.#repository.database
                .transaction(() => {
                  this.#operations.acceptSteer(
                    scope,
                    input.mutationId,
                    acceptedAt,
                  );
                  this.#completion.recordAccepted(scope, applicationThreadId, {
                    operationId: started.applicationOperationId,
                    acceptedAt,
                    backendCorrelation: accepted.completionCorrelation,
                    attachmentIds: started.attachments.map(({ id }) => id),
                  });
                  this.#repository.acceptSteered(
                    scope,
                    applicationThreadId,
                    id,
                    {
                      steerOperationId: input.mutationId,
                      expectedState: "dispatching",
                      acceptedAt,
                      backendCorrelation: accepted.completionCorrelation,
                    },
                  );
                })
                .immediate();
              try {
                await conversation.replayAuthoritativeCompletions();
              } catch {
                // Durable acceptance remains authoritative.
              }
              this.#publishQueueChanged(
                scope,
                applicationThreadId,
                conversation.generation,
              );
              this.#scheduleCurrentHead(scope, applicationThreadId);
              return {
                status: "accepted" as const,
                ...this.#captureQueueProjection(scope, applicationThreadId),
              };
            } catch (error) {
              if (
                error instanceof BackendError &&
                !error.crossedSubmissionBoundary
              ) {
                this.#restoreQueuedSteer(
                  scope,
                  prepared.receipt,
                  "dispatching",
                );
                this.#publishQueueChanged(
                  scope,
                  applicationThreadId,
                  conversation.generation,
                );
                await this.#dispatchAfterDurableTransition(
                  scope,
                  applicationThreadId,
                );
                throw error;
              }
              this.#markQueuedSteerUncertain(
                scope,
                started,
                undefined,
                error instanceof BackendError
                  ? safeDiagnostic(error.safeMessage)
                  : "Steer acceptance could not be proven.",
              );
              this.#publishQueueChanged(
                scope,
                applicationThreadId,
                conversation.generation,
              );
              return {
                status: "recovery_required" as const,
                retryable: false,
                ...this.#captureQueueProjection(scope, applicationThreadId),
              };
            }
          },
        );
      });
    });
  }

  async #withConversationForSteer<T>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: (conversation: QueuedInputConversation) => T | Promise<T>,
  ): Promise<T> {
    let conversationAcquired = false;
    try {
      return await this.#gateway.withConversation(
        scope,
        applicationThreadId,
        async (conversation) => {
          conversationAcquired = true;
          return operation(conversation);
        },
      );
    } catch (error) {
      if (!conversationAcquired) {
        throw new QueuedInputConversationAcquisitionError(error);
      }
      throw error;
    }
  }

  #captureQueueProjection(
    scope: RequestScope,
    applicationThreadId: string,
  ): {
    readonly threadRevision: number;
    readonly queue: readonly QueuedInputSummary[];
  } {
    const state = this.#repository.readProjectionState(
      scope,
      applicationThreadId,
    );
    return {
      threadRevision: state.threadRevision,
      queue: projectQueuedInputSummaries(state.records),
    };
  }

  #restoreQueuedSteer(
    scope: RequestScope,
    receipt: QueuedInputSteerOperationRecord,
    expectedState: "dispatching" | "uncertain",
  ): QueuedInputRecord {
    const now = this.#clock.now();
    const restored = this.#repository.database
      .transaction(() => {
        this.#operations.rejectSteerBeforeAcceptance(scope, receipt.mutationId);
        return this.#repository.restoreSteerReservation(
          scope,
          receipt.threadId,
          receipt.queuedInputId,
          {
            steerOperationId: receipt.mutationId,
            expectedState,
            priorState: receipt.priorQueueState,
            priorNextAttemptAt: receipt.priorNextAttemptAt,
            priorDiagnostic: receipt.priorDiagnostic,
            now,
          },
        );
      })
      .immediate();
    this.#scheduleCurrentHead(scope, receipt.threadId);
    return restored;
  }

  #markQueuedSteerUncertain(
    scope: RequestScope,
    receipt: QueuedInputSteerOperationRecord,
    backendCorrelation: string | undefined,
    diagnostic: string,
  ): QueuedInputRecord {
    return this.#repository.markSteerUncertain(
      scope,
      receipt.threadId,
      receipt.queuedInputId,
      {
        steerOperationId: receipt.mutationId,
        ...(backendCorrelation ? { backendCorrelation } : {}),
        diagnostic: safeDiagnostic(diagnostic),
        now: this.#clock.now(),
      },
    );
  }

  async #reconcileQueuedSteer(
    scope: RequestScope,
    receipt: QueuedInputSteerOperationRecord,
  ): Promise<"accepted" | "not_accepted" | "not_sent" | "failed_unknown" | "unresolved"> {
    let reconciliation;
    try {
      reconciliation = await this.#gateway.reconcileSubmission(
        scope,
        receipt.threadId,
        {
          applicationOperationId: receipt.applicationOperationId,
          reconciliationToken: receipt.reconciliationToken,
          ...(receipt.attachments.length > 0
            ? { attachments: receipt.attachments }
            : {}),
          ...(receipt.target ? { steerTarget: receipt.target } : {}),
        },
      );
    } catch {
      return "unresolved";
    }
    if (reconciliation.status === "unresolved") return "unresolved";
    if (reconciliation.status === "failed_unknown") {
      if (receipt.target?.kind !== "conversation") return "unresolved";
      const diagnostic = safeDiagnostic(
        `Delivery outcome is unknown; the backend may already have received this input. Nothing was resent. Restore to review it before sending again. ${reconciliation.diagnostic.text}`,
      );
      const now = this.#clock.now();
      this.#repository.database.transaction(() => {
        this.#operations.failSteerUnknown(scope, receipt.mutationId, diagnostic, now);
        this.#repository.failSteerUnknown(scope, receipt.threadId, receipt.queuedInputId, {
          steerOperationId: receipt.mutationId,
          expectedState: receipt.state === "pending_materialization" ? "dispatching" : "uncertain",
          diagnostic, now,
        });
      }).immediate();
      await this.#emitQueueChanged(scope, receipt.threadId);
      return "failed_unknown";
    }
    if (reconciliation.status === "not_accepted" && !reconciliation.retryable) {
      // Proven never sent, but not to be resent automatically (a provider
      // withdrew it on Stop). Return it to the user as a failed item they can
      // restore or dismiss; later entries wait for that decision.
      const diagnostic = safeDiagnostic(reconciliation.diagnostic?.text ??
        "The backend proved this steering message was not sent. Nothing was resent. Restore it to send it again, or dismiss it.");
      const now = this.#clock.now();
      this.#repository.database.transaction(() => {
        this.#operations.rejectSteerBeforeAcceptance(scope, receipt.mutationId);
        this.#repository.failSteerNotSent(scope, receipt.threadId, receipt.queuedInputId, {
          steerOperationId: receipt.mutationId,
          expectedState: receipt.state === "pending_materialization" ? "dispatching" : "uncertain",
          diagnostic, now,
        });
      }).immediate();
      await this.#emitQueueChanged(scope, receipt.threadId);
      return "not_sent";
    }
    if (reconciliation.status === "not_accepted") {
      this.#restoreQueuedSteer(
        scope,
        receipt,
        receipt.state === "pending_materialization"
          ? "dispatching"
          : "uncertain",
      );
      await this.#emitQueueChanged(scope, receipt.threadId);
      await this.#dispatchAfterDurableTransition(scope, receipt.threadId);
      return "not_accepted";
    }
    const acceptedAt = this.#clock.now();
    this.#repository.database
      .transaction(() => {
        this.#operations.acceptSteer(scope, receipt.mutationId, acceptedAt);
        this.#completion.recordAccepted(scope, receipt.threadId, {
          operationId: receipt.applicationOperationId,
          acceptedAt,
          backendCorrelation: receipt.applicationOperationId,
          attachmentIds: receipt.attachments.map(({ id }) => id),
        });
        this.#repository.acceptSteered(
          scope,
          receipt.threadId,
          receipt.queuedInputId,
          {
            steerOperationId: receipt.mutationId,
            expectedState:
              receipt.state === "pending_materialization"
                ? "dispatching"
                : "uncertain",
            acceptedAt,
            backendCorrelation: receipt.applicationOperationId,
          },
        );
        if (reconciliation.completionIdentity) {
          this.#completion.observeCompletion(
            scope,
            receipt.threadId,
            receipt.applicationOperationId,
            {
              completionIdentity: reconciliation.completionIdentity,
              observedAt: acceptedAt,
              createAttention: true,
            },
          );
        }
      })
      .immediate();
    await this.#emitQueueChanged(scope, receipt.threadId);
    this.#scheduleCurrentHead(scope, receipt.threadId);
    return "accepted";
  }

  async acknowledgeFailure(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    now = this.#clock.now(),
  ): Promise<QueuedInputRecord> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const item = this.#repository.acknowledgeFailure(
          scope,
          applicationThreadId,
          id,
          now,
        );
        await this.#emitQueueChanged(scope, applicationThreadId);
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
        return item;
      });
    });
  }

  async retryFailed(
    scope: RequestScope,
    applicationThreadId: string,
    failedId: string,
    input: Parameters<QueuedInputRepository["retryFailed"]>[3],
  ): Promise<ReturnType<QueuedInputRepository["retryFailed"]>> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const result = this.#repository.retryFailed(
          scope,
          applicationThreadId,
          failedId,
          input,
        );
        await this.#emitQueueChanged(scope, applicationThreadId);
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
        return result;
      });
    });
  }

  /**
   * Called by production event wiring only after a backend turn is
   * authoritatively terminal. Historical turns without a Sedes acceptance
   * anchor are ignored rather than being presented as unseen work.
   */
  async onAuthoritativeCompletion(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly backendCorrelation: string;
      readonly backendTurnId: string;
      readonly applicationTurnId: string;
      readonly completionIdentity: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly result: BoundedText;
      readonly classifiedResult: ClassifiedAssistantResult | null;
      readonly observedAt?: number;
    },
  ): Promise<SubmissionCompletionObservationRecord | undefined> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const observed = this.#completion.observeBackendCompletion(
          scope,
          applicationThreadId,
          {
            backendCorrelation: input.backendCorrelation,
            applicationTurnId: input.applicationTurnId,
            completionIdentity: input.completionIdentity,
            outcome: input.outcome,
            result: input.result,
            classifiedResult: input.classifiedResult,
            observedAt: input.observedAt ?? this.#clock.now(),
          },
        );
        if (observed) {
          // Completion observation is an execution-close authority boundary.
          // Defer runtime acquisition until after the actor's authoritative
          // observer chain has drained, otherwise idle eviction can wait on an
          // observer that is itself waiting for that eviction.
          this.#schedulePendingDispatch(scope, applicationThreadId);
        }
        return observed;
      });
    });
  }

  async observeAuthoritativeSubmission(
    scope: RequestScope,
    applicationThreadId: string,
    backendCorrelation: string,
  ): Promise<boolean> {
    return this.#track(async () => {
      await this.#requireRecovery(scope);
      return this.#serialize(scope, applicationThreadId, async () => {
        const receipt = this.#operations.findAwaitingSteerSubmission(
          scope,
          applicationThreadId,
          backendCorrelation,
        );
        if (!receipt) return false;
        if (
          receipt.source !== "queued_input" ||
          receipt.applicationOperationId !== backendCorrelation
        ) {
          return false;
        }
        const acceptedAt = this.#clock.now();
        this.#repository.database
          .transaction(() => {
            this.#operations.acceptSteer(scope, receipt.mutationId, acceptedAt);
            this.#completion.recordAccepted(scope, applicationThreadId, {
              operationId: receipt.applicationOperationId,
              acceptedAt,
              backendCorrelation,
              attachmentIds: receipt.attachments.map(({ id }) => id),
            });
            this.#repository.acceptSteered(
              scope,
              applicationThreadId,
              receipt.queuedInputId,
              {
                steerOperationId: receipt.mutationId,
                expectedState:
                  receipt.state === "failed_unknown"
                    ? "failed"
                    : receipt.state === "pending_materialization"
                      ? "dispatching"
                      : "uncertain",
                acceptedAt,
                backendCorrelation,
              },
            );
          })
          .immediate();
        await this.#emitQueueChanged(scope, applicationThreadId);
        this.#scheduleCurrentHead(scope, applicationThreadId);
        return true;
      });
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    for (const handle of this.#retryTimers.values()) {
      this.#scheduler.cancel(handle);
    }
    this.#retryTimers.clear();
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#recoveryByScope.values()]);
      await Promise.allSettled([...this.#inflightOperations]);
      while (this.#threadTails.size > 0) {
        await Promise.allSettled([...this.#threadTails.values()]);
      }
      for (const handle of this.#retryTimers.values()) {
        this.#scheduler.cancel(handle);
      }
      this.#retryTimers.clear();
      this.#closed = true;
    })();
    return this.#closePromise;
  }

  async #recoverScope(scope: RequestScope): Promise<void> {
    const recoveryRows = this.#repository.listRecoveryRequired(scope);
    const recoveries = recoveryRows.map((item) =>
      this.#serialize(scope, item.applicationThreadId, async () => {
        let current = item;
        if (current.deliveryMode === "steer") {
          if (!current.reconciliationToken) {
            throw new Error("queued_input_steer_receipt_missing");
          }
          const receipt = this.#operations.getSteer(
            scope,
            current.reconciliationToken,
          );
          if (
            receipt.source !== "queued_input" ||
            receipt.threadId !== current.applicationThreadId ||
            receipt.queuedInputId !== current.id
          ) {
            throw new Error("queued_input_steer_receipt_mismatch");
          }
          if (receipt.state === "prepared") {
            if (current.state !== "dispatching") {
              throw new Error("queued_input_prepared_steer_state_mismatch");
            }
            this.#restoreQueuedSteer(scope, receipt, "dispatching");
            await this.#emitQueueChanged(scope, current.applicationThreadId);
            await this.#dispatchAfterDurableTransition(
              scope,
              current.applicationThreadId,
            );
            return;
          }
          if (
            receipt.state !== "uncertain" &&
            receipt.state !== "pending_materialization"
          ) {
            throw new Error("queued_input_steer_recovery_state_mismatch");
          }
          if (receipt.state === "pending_materialization") {
            if (current.state !== "dispatching") {
              throw new Error("queued_input_pending_steer_state_mismatch");
            }
            const outcome = await this.#reconcileQueuedSteer(scope, receipt);
            if (outcome === "unresolved" && receipt.target?.kind === "conversation") {
              // Admission before restart does not prove native consumption.
              // Preserve the exact operation for explicit recovery or a late
              // authoritative echo; never automatically resend it.
              this.#repository.database.transaction(() => {
                this.#operations.markSteerMaterializationUncertain(
                  scope, receipt.mutationId, this.#clock.now(),
                );
                this.#markQueuedSteerUncertain(
                  scope, receipt, undefined,
                  "The server restarted before Steer materialization was proven.",
                );
              }).immediate();
              await this.#emitQueueChanged(scope, current.applicationThreadId);
            }
            return;
          }
          if (current.state === "dispatching") {
            current = this.#repository.markSteerUncertain(
              scope,
              current.applicationThreadId,
              current.id,
              {
                steerOperationId: receipt.mutationId,
                diagnostic:
                  "The server restarted before Steer acceptance was proven.",
                now: this.#clock.now(),
              },
            );
            await this.#emitQueueChanged(scope, current.applicationThreadId);
          }
          await this.#reconcileQueuedSteer(scope, receipt);
          return;
        }
        if (current.state === "dispatching") {
          current = this.#repository.markUncertain(
            scope,
            current.applicationThreadId,
            current.id,
            {
              now: this.#clock.now(),
              diagnostic:
                "The server restarted before submission acceptance was proven.",
            },
          );
          await this.#emitQueueChanged(scope, current.applicationThreadId);
        }
        await this.#reconcile(scope, current);
      }),
    );
    await Promise.all(recoveries);

    const activeHeads = this.#repository.listActiveHeads(scope);
    await Promise.all(
      activeHeads.map((head) =>
        this.#serialize(scope, head.applicationThreadId, async () => {
          const current = this.#repository.get(
            scope,
            head.applicationThreadId,
            head.id,
          );
          if (current.state === "retry_wait") {
            this.#scheduleRetry(scope, current);
            return;
          }
          if (current.state === "pending") {
            await this.#dispatchAfterDurableTransition(scope, current.applicationThreadId);
          }
        }),
      ),
    );
  }

  async #dispatchThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    if (this.#isDispatchBlocked(scope, applicationThreadId)) {
      this.#cancelRetryTimer(scope, applicationThreadId);
      return;
    }
    let activeHead = this.#repository
      .listActiveHeads(scope)
      .find(
        (candidate) => candidate.applicationThreadId === applicationThreadId,
      );
    if (activeHead?.state === "uncertain" && activeHead.deliveryMode === "submit") {
      // A late native acknowledgment/history entry can resolve a timed-out
      // ordinary send. This automatic check only recognizes acceptance; it
      // never turns missing evidence into permission to resend the input.
      await this.#reconcile(scope, activeHead, { acceptanceOnly: true });
      activeHead = this.#repository.listActiveHeads(scope).find(
        candidate => candidate.applicationThreadId === applicationThreadId,
      );
      if (activeHead?.state === "uncertain") return;
    }
    if (activeHead?.state === "pending" && isResolvedSteer(activeHead)) {
      this.#cancelRetryTimer(scope, applicationThreadId);
      this.#scheduleRequestedSteer(scope, activeHead);
      return;
    }
    // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): dispatch timings.
    const debugDispatch = process.env.SEDES_DEBUG_DELIVERY
      ? (step: string, since: number) =>
          console.error(
            `[delivery-dispatch] thread=${applicationThreadId} step=${step} ms=${Date.now() - since}`,
          )
      : undefined;
    const dispatchStart = Date.now();
    let conversationAcquired = false;
    try {
      await this.#gateway.withConversation(
        scope,
        applicationThreadId,
        async (conversation) => {
          conversationAcquired = true;
          debugDispatch?.("withConversation acquire", dispatchStart);
          if (!conversation.authoritativelySettled) {
            this.#schedulePendingDispatch(scope, applicationThreadId);
            return;
          }
          const anchorStart = Date.now();
          const retryAnchor = await conversation.captureSubmissionRetryAnchor();
          debugDispatch?.("captureSubmissionRetryAnchor", anchorStart);
          const claimed = this.#repository.database
            .transaction(() =>
              this.#repository.claimHead(
                scope,
                applicationThreadId,
                retryAnchor,
                this.#clock.now(),
              ),
            )
            .immediate();
          if (!claimed) {
            this.#scheduleCurrentHead(scope, applicationThreadId);
            return;
          }
          this.#cancelRetryTimer(scope, applicationThreadId);
          this.#publishQueueChanged(
            scope,
            applicationThreadId,
            conversation.generation,
          );
          let accepted: SubmitTurnResult | undefined;
          const submitStart = Date.now();
          try {
            const attachmentDelivery =
              await conversation.materializeAttachments(claimed.attachments);
            accepted = await conversation.submit({
              applicationOperationId: claimed.mutationId,
              mutationId: claimed.mutationId,
              source:
                claimed.triggerKind === "user"
                  ? { kind: "user" }
                  : {
                      kind: "automation",
                      automationId: claimed.sourceAutomationId!,
                      automationRunId: claimed.sourceAutomationRunId!,
                    },
              reconciliationToken: claimed.reconciliationToken!,
              text: claimed.text,
              ...(claimed.selectedSkillId === null
                ? {}
                : { selectedSkillId: claimed.selectedSkillId }),
              contextExcerpts: claimed.contextExcerpts,
              attachments: attachmentDelivery.attachments,
              ...(attachmentDelivery.attachments.length > 0
                ? {
                    attachmentBytes: attachmentDelivery.canonicalBytes,
                    attachmentEvidence: attachmentDelivery.canonicalEvidence,
                  }
                : {}),
              taskContexts: claimed.taskContexts,
              ...(claimed.inputOrigin === null
                ? {}
                : { inputOrigin: claimed.inputOrigin }),
            });
          } catch (error) {
            this.#classifySubmissionFailure(
              scope,
              applicationThreadId,
              claimed,
              error,
            );
          }
          debugDispatch?.("conversation.submit", submitStart);
          if (accepted) {
            if (
              accepted.reconciliationToken !== claimed.reconciliationToken ||
              accepted.completionCorrelation !== claimed.mutationId
            ) {
              this.#repository.database
                .transaction(() => {
                  this.#repository.markUncertain(
                    scope,
                    applicationThreadId,
                    claimed.id,
                    {
                      now: this.#clock.now(),
                      reconciliationToken: claimed.reconciliationToken!,
                      backendCorrelation: accepted.completionCorrelation,
                      diagnostic:
                        "The backend accepted the submission with an invalid reconciliation identity.",
                    },
                  );
                })
                .immediate();
              this.#publishQueueChanged(
                scope,
                applicationThreadId,
                conversation.generation,
              );
              return;
            }
            try {
              this.#repository.database
                .transaction(() => {
                  this.#repository.markAccepted(
                    scope,
                    applicationThreadId,
                    claimed.id,
                    {
                      expectedState: "dispatching",
                      acceptedAt: this.#clock.now(),
                      backendCorrelation: accepted.completionCorrelation,
                    },
                  );
                })
                .immediate();
            } catch (persistenceError) {
              try {
                this.#repository.database
                  .transaction(() => {
                    this.#repository.markUncertain(
                      scope,
                      applicationThreadId,
                      claimed.id,
                      {
                        now: this.#clock.now(),
                        reconciliationToken: accepted.reconciliationToken,
                        backendCorrelation: accepted.completionCorrelation,
                        diagnostic:
                          "The backend accepted the submission, but its durable acceptance record could not be completed.",
                      },
                    );
                  })
                  .immediate();
              } catch (uncertaintyPersistenceError) {
                throw new AggregateError(
                  [persistenceError, uncertaintyPersistenceError],
                  "Accepted submission could not be durably recorded.",
                );
              }
            }
            try {
              const replayStart = Date.now();
              await conversation.replayAuthoritativeCompletions();
              debugDispatch?.("replayAuthoritativeCompletions", replayStart);
            } catch {
              // Durable acceptance is authoritative. Snapshot establishment
              // and the process-wide completion observer replay terminal turns.
            }
          }
          this.#publishQueueChanged(
            scope,
            applicationThreadId,
            conversation.generation,
          );
          this.#scheduleCurrentHead(scope, applicationThreadId);
        },
      );
      debugDispatch?.("withConversation total", dispatchStart);
    } catch (error) {
      if (conversationAcquired) throw error;
      throw new QueuedInputConversationAcquisitionError(error);
    }
  }

  async #dispatchAfterDurableTransition(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    try {
      await this.#dispatchThread(scope, applicationThreadId);
    } catch (error) {
      if (!(error instanceof QueuedInputConversationAcquisitionError)) {
        throw error;
      }
      this.#schedulePendingDispatch(scope, applicationThreadId);
    }
    this.#scheduleRequestedSteerHead(scope, applicationThreadId);
  }

  #classifySubmissionFailure(
    scope: RequestScope,
    applicationThreadId: string,
    claimed: QueuedInputRecord,
    error: unknown,
  ): void {
    const transition = this.#repository.database.transaction(() => {
      if (
        !(error instanceof BackendError) ||
        error.crossedSubmissionBoundary ||
        error.category === "submission_unknown"
      ) {
        this.#repository.markUncertain(scope, applicationThreadId, claimed.id, {
          now: this.#clock.now(),
          diagnostic:
            error instanceof BackendError
              ? safeDiagnostic(error.safeMessage)
              : "Submission acceptance could not be proven.",
        });
        return undefined;
      }
      let result: QueuedInputRecord;
      if (error.category === "invalid_state") {
        result = this.#repository.handleInvalidState(
          scope,
          applicationThreadId,
          claimed.id,
          {
            now: this.#clock.now(),
            diagnostic: safeDiagnostic(error.safeMessage),
            retryPolicy: this.#retryPolicy,
          },
        );
      } else {
        result = this.#repository.handleCleanFailure(
          scope,
          applicationThreadId,
          claimed.id,
          {
            expectedState: "dispatching",
            retryable: error.retryable,
            diagnostic: safeDiagnostic(error.safeMessage),
            now: this.#clock.now(),
            retryPolicy: this.#retryPolicy,
          },
        );
      }
      return result;
    });
    transition.immediate();
  }

  async #reconcile(
    scope: RequestScope,
    item: QueuedInputRecord,
    options?: { readonly acceptanceOnly: true },
  ): Promise<void> {
    if (item.state !== "uncertain") return;
    if (item.deliveryMode === "steer") {
      if (!item.reconciliationToken) {
        throw new Error("queued_input_steer_receipt_missing");
      }
      const receipt = this.#operations.getSteer(
        scope,
        item.reconciliationToken,
      );
      if (
        receipt.source !== "queued_input" ||
        receipt.queuedInputId !== item.id ||
        receipt.threadId !== item.applicationThreadId
      ) {
        throw new Error("queued_input_steer_receipt_mismatch");
      }
      await this.#reconcileQueuedSteer(scope, receipt);
      return;
    }
    let reconciliation;
    try {
      reconciliation = await this.#gateway.reconcileSubmission(
        scope,
        item.applicationThreadId,
        {
          applicationOperationId: item.mutationId,
          ...(item.reconciliationToken
            ? { reconciliationToken: item.reconciliationToken }
            : {}),
          ...(item.retryAnchor ? { retryAnchor: item.retryAnchor } : {}),
          ...(item.attachments.length > 0
            ? { attachments: item.attachments }
            : {}),
        },
      );
    } catch {
      // Reconciliation transport/backend failures cannot prove non-acceptance.
      // The row remains uncertain and continues to block later queue entries.
      return;
    }
    if (options?.acceptanceOnly && reconciliation.status !== "accepted") return;
    if (reconciliation.status === "unresolved") return;
    if (reconciliation.status === "failed_unknown") {
      // Tracking is terminal, so the head must not stay uncertain forever.
      // As with a terminal Steer, the user drops it or restores it for an
      // explicit resend; later entries wait for that decision.
      this.#repository.database.transaction(() => {
        this.#repository.failSubmitUnknown(scope, item.applicationThreadId, item.id, {
          diagnostic: safeDiagnostic(
            `Delivery outcome is unknown; the backend may already have received this input. Nothing was resent. Review the conversation, then dismiss it or restore it to send again. ${reconciliation.diagnostic.text}`,
          ),
          now: this.#clock.now(),
        });
      }).immediate();
      await this.#emitQueueChanged(scope, item.applicationThreadId);
      return;
    }
    if (reconciliation.status === "accepted") {
      const completionIdentity = reconciliation.completionIdentity;
      this.#repository.database.transaction(() => {
        this.#repository.markAccepted(
          scope,
          item.applicationThreadId,
          item.id,
          {
            expectedState: "uncertain",
            acceptedAt: this.#clock.now(),
            backendCorrelation: item.mutationId,
          },
        );
        if (completionIdentity) {
          this.#completion.observeCompletion(
            scope,
            item.applicationThreadId,
            item.mutationId,
            {
              completionIdentity,
              observedAt: this.#clock.now(),
              createAttention: true,
            },
          );
        }
      })();
    } else {
      this.#repository.database
        .transaction(() => {
          this.#repository.handleCleanFailure(
            scope,
            item.applicationThreadId,
            item.id,
            {
              expectedState: "uncertain",
              retryable: reconciliation.retryable,
              diagnostic:
                "The backend proved that submission was not accepted.",
              now: this.#clock.now(),
              retryPolicy: this.#retryPolicy,
            },
          );
        })
        .immediate();
    }
    await this.#emitQueueChanged(scope, item.applicationThreadId);
    this.#scheduleCurrentHead(scope, item.applicationThreadId);
  }

  #scheduleCurrentHead(scope: RequestScope, applicationThreadId: string): void {
    if (this.#closing || this.#closed) return;
    const head = this.#repository
      .listActiveHeads(scope)
      .find(
        (candidate) => candidate.applicationThreadId === applicationThreadId,
      );
    if (head?.state === "retry_wait") {
      this.#scheduleRetry(scope, head);
    } else if (head?.state === "pending" && isResolvedSteer(head)) {
      this.#cancelRetryTimer(scope, applicationThreadId);
      this.#scheduleRequestedSteer(scope, head);
    } else {
      this.#cancelRetryTimer(scope, applicationThreadId);
    }
  }

  #scheduleRequestedSteerHead(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    if (this.#closing || this.#closed) return;
    const head = this.#repository
      .listActiveHeads(scope)
      .find(
        (candidate) => candidate.applicationThreadId === applicationThreadId,
      );
    if (head?.state === "pending" && isResolvedSteer(head)) {
      this.#scheduleRequestedSteer(scope, head);
    }
  }

  #scheduleRequestedSteer(scope: RequestScope, item: QueuedInputRecord): void {
    if (
      this.#closing ||
      this.#closed ||
      item.state !== "pending" ||
      !isResolvedSteer(item) ||
      item.resolvedSteerTarget === null
    ) {
      return;
    }
    if (this.#isDispatchBlocked(scope, item.applicationThreadId)) {
      this.#schedulePendingDispatch(scope, item.applicationThreadId);
      return;
    }
    const key = threadKey(scope, item.applicationThreadId);
    if (this.#scheduledSteerIntents.has(key)) return;
    this.#scheduledSteerIntents.add(key);
    let deferredRetryScheduled = false;
    void this.steerUserInput(scope, item.applicationThreadId, item.id, {
      mutationId: item.mutationId,
      target: item.resolvedSteerTarget,
    })
      .then((result) => {
        if (result.status !== "restored") return;
        this.#failRequestedSteer(
          scope,
          item.applicationThreadId,
          item.id,
          "The targeted turn no longer accepts Steer input.",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof QueuedInputConversationAcquisitionError) {
          deferredRetryScheduled = true;
          this.#schedulePendingDispatch(scope, item.applicationThreadId);
          return;
        }
        if (
          error instanceof DomainError &&
          error.code === "operation_outcome_uncertain"
        ) {
          deferredRetryScheduled = true;
          this.#schedulePendingDispatch(scope, item.applicationThreadId);
          return;
        }
        if (isSteerTargetUnavailable(error)) {
          this.#fallbackRequestedSteer(
            scope,
            item.applicationThreadId,
            item.id,
          );
          return;
        }
        this.#failRequestedSteer(
          scope,
          item.applicationThreadId,
          item.id,
          error instanceof DomainError
            ? safeDiagnostic(error.message)
            : error instanceof BackendError
              ? safeDiagnostic(error.safeMessage)
              : "Steer could not be delivered before the provider boundary.",
        );
      })
      .finally(() => {
        this.#scheduledSteerIntents.delete(key);
        if (!deferredRetryScheduled && !this.#closing && !this.#closed) {
          const head = this.#repository
            .listActiveHeads(scope)
            .find(
              (candidate) =>
                candidate.applicationThreadId === item.applicationThreadId,
            );
          // A failed durable transition can leave the same intent pending.
          // Yield through the retry scheduler instead of recursively filling
          // the microtask queue and starving every HTTP request.
          if (
            head?.id === item.id &&
            head.state === "pending" &&
            isResolvedSteer(head)
          ) {
            this.#schedulePendingDispatch(scope, item.applicationThreadId);
          } else {
            this.#scheduleRequestedSteerHead(scope, item.applicationThreadId);
          }
        }
      });
  }

  #failRequestedSteer(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    diagnostic: string,
  ): void {
    try {
      const current = this.#repository.get(scope, applicationThreadId, id);
      if (
        !isResolvedSteer(current) ||
        (current.state !== "pending" && current.state !== "retry_wait")
      ) {
        return;
      }
      this.#repository.failPendingRequestedSteer(
        scope,
        applicationThreadId,
        id,
        { diagnostic: safeDiagnostic(diagnostic), now: this.#clock.now() },
      );
      void this.#track(() =>
        this.#emitQueueChanged(scope, applicationThreadId),
      ).catch(() => undefined);
    } catch {
      // A concurrent cancellation, restoration, or authoritative transition
      // owns the final durable state.
    }
  }

  #fallbackRequestedSteer(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
  ): void {
    try {
      const current = this.#repository.get(scope, applicationThreadId, id);
      if (
        !isResolvedSteer(current) ||
        (current.state !== "pending" && current.state !== "retry_wait")
      ) {
        return;
      }
      this.#repository.demotePendingRequestedSteer(
        scope,
        applicationThreadId,
        id,
        { now: this.#clock.now() },
      );
      void this.#track(async () => {
        await this.#emitQueueChanged(scope, applicationThreadId).catch(
          () => undefined,
        );
        await this.#dispatchAfterDurableTransition(scope, applicationThreadId);
      }).catch(() => undefined);
    } catch {
      // A concurrent cancellation, restoration, or authoritative transition
      // owns the final durable state.
    }
  }

  #schedulePendingDispatch(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    if (this.#closing || this.#closed) return;
    const pending = this.#repository
      .listActiveHeads(scope)
      .find(
        (candidate) =>
          candidate.applicationThreadId === applicationThreadId &&
          candidate.state === "pending",
      );
    if (!pending) return;
    const key = threadKey(scope, applicationThreadId);
    this.#cancelRetryTimer(scope, applicationThreadId);
    const handle = this.#scheduler.schedule(
      this.#retryPolicy.baseDelayMilliseconds,
      () => {
        if (this.#retryTimers.get(key) !== handle) return;
        this.#retryTimers.delete(key);
        void this.onAuthoritativeSettled(scope, applicationThreadId).catch(
          (error) => {
            if (error instanceof QueuedInputConversationAcquisitionError) {
              this.#schedulePendingDispatch(scope, applicationThreadId);
            }
          },
        );
      },
    );
    this.#retryTimers.set(key, handle);
  }

  #scheduleRetry(
    scope: RequestScope,
    item: QueuedInputRecord,
    minimumDelayMilliseconds = 0,
  ): void {
    if (
      this.#closing ||
      this.#closed ||
      item.state !== "retry_wait" ||
      item.nextAttemptAt === null
    ) {
      return;
    }
    const key = threadKey(scope, item.applicationThreadId);
    this.#cancelRetryTimer(scope, item.applicationThreadId);
    const delay = Math.max(
      minimumDelayMilliseconds,
      item.nextAttemptAt - this.#clock.now(),
      0,
    );
    const handle = this.#scheduler.schedule(delay, () => {
      if (this.#retryTimers.get(key) !== handle) return;
      this.#retryTimers.delete(key);
      void this.onAuthoritativeSettled(scope, item.applicationThreadId).catch(
        () => {
          if (this.#closing || this.#closed) return;
          try {
            const current = this.#repository
              .listActiveHeads(scope)
              .find(
                (candidate) =>
                  candidate.applicationThreadId === item.applicationThreadId,
              );
            if (current?.state === "retry_wait") {
              this.#scheduleRetry(
                scope,
                current,
                this.#retryPolicy.baseDelayMilliseconds,
              );
            }
          } catch {
            // Durable state remains authoritative. Repository unavailability is
            // retried by startup recovery rather than surfacing an unhandled task.
          }
        },
      );
    });
    this.#retryTimers.set(key, handle);
  }

  #cancelRetryTimer(scope: RequestScope, applicationThreadId: string): void {
    const key = threadKey(scope, applicationThreadId);
    const handle = this.#retryTimers.get(key);
    if (handle === undefined) return;
    this.#scheduler.cancel(handle);
    this.#retryTimers.delete(key);
  }

  async #emitQueueChanged(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    try {
      await this.#gateway.withConversation(
        scope,
        applicationThreadId,
        (conversation) => {
          this.#publishQueueChanged(
            scope,
            applicationThreadId,
            conversation.generation,
          );
        },
      );
    } catch {
      // The durable queue is included in the next snapshot. Event delivery
      // cannot change a committed queue transition into an operation failure.
    }
  }

  #publishQueueChanged(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
  ): void {
    const state = this.#repository.readProjectionState(
      scope,
      applicationThreadId,
    );
    const items = projectQueuedInputSummaries(state.records).slice(
      0,
      MAXIMUM_ACTIVE_QUEUED_INPUTS,
    );
    try {
      this.#publisher.publish(scope, applicationThreadId, {
        type: "queue_changed",
        generation,
        threadRevision: state.threadRevision,
        items,
      });
    } catch {
      // One transport subscriber cannot poison durable queue progression.
    }
  }

  #serialize<T>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = threadKey(scope, applicationThreadId);
    const predecessor = this.#threadTails.get(key) ?? Promise.resolve();
    const result = predecessor.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#threadTails.set(key, tail);
    void tail.then(() => {
      if (this.#threadTails.get(key) === tail) {
        this.#threadTails.delete(key);
      }
    });
    return result;
  }

  async #requireRecovery(scope: RequestScope): Promise<void> {
    const recovery = this.#recoveryByScope.get(scopeKey(scope));
    if (!recovery) {
      throw new Error("queued_input_scope_not_recovered");
    }
    await recovery;
  }

  #track<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const result = operation();
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.#inflightOperations.add(completion);
    void completion.then(() => this.#inflightOperations.delete(completion));
    return result;
  }

  #assertRetryPolicy(): void {
    if (
      !Number.isSafeInteger(this.#retryPolicy.maximumRetries) ||
      this.#retryPolicy.maximumRetries < 0 ||
      !Number.isSafeInteger(this.#retryPolicy.baseDelayMilliseconds) ||
      this.#retryPolicy.baseDelayMilliseconds < 1 ||
      !Number.isSafeInteger(this.#retryPolicy.maximumDelayMilliseconds) ||
      this.#retryPolicy.maximumDelayMilliseconds <
        this.#retryPolicy.baseDelayMilliseconds ||
      this.#retryPolicy.maximumDelayMilliseconds >
        MAXIMUM_TIMER_DELAY_MILLISECONDS
    ) {
      throw new Error("queued_input_retry_policy_invalid");
    }
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) {
      throw new Error("queued_input_dispatcher_closed");
    }
  }
}
