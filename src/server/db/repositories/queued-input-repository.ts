import { steerTargetSchema, type SteerTarget } from "../../../shared/protocol/conversation.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import {
  parseStoredContextExcerpts,
  sameContextExcerpts,
  serializeContextExcerpts,
} from "../context-excerpts-json.js";
import { SubmissionCompletionRepository } from "./submission-completion-repository.js";
import {
  deliveryInputOriginSchema,
  hasDeliverableComposerInput,
} from "../../../shared/protocol/conversation.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import type {
  ComposerTaskReference,
  MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";
import {
  materializeTaskReferences,
  assertMaterializedComposerBytes,
  parseStoredTaskReferences,
  parseStoredTaskContexts,
  serializeTaskContexts,
  serializeTaskReferences,
  taskReferencesFromContexts,
} from "../composer-tasks-json.js";
import { activateSettledThreadForAcceptedInput } from "./accepted-input-inventory.js";
import type { DeliveryInputOrigin } from "../../../shared/protocol/conversation.js";
import type { BoundedDisplayText } from "../../../shared/protocol/payload.js";
import { ThreadCompletionCallbackRepository } from "./thread-completion-callback-repository.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

export type QueuedInputState =
  | "pending"
  | "retry_wait"
  | "dispatching"
  | "accepted"
  | "uncertain"
  | "failed"
  | "cancelled";

export type QueuedInputRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly applicationThreadId: string;
  readonly sequence: number;
  readonly mutationId: string;
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskContexts: MaterializedTaskContext[];
  readonly requestedDeliveryMode: "submit" | "queue" | "steer" | null;
  readonly requestedSteerTarget: SteerTarget | null;
  readonly steerFallbackAt: number | null;
  readonly resolvedDeliveryMode: "submit" | "queue" | "steer";
  readonly resolvedSteerTarget: SteerTarget | null;
  readonly requestedThreadRevision: number | null;
  readonly requestedDraftRevision: number | null;
  readonly triggerKind: "user" | "automation";
  readonly sourceAutomationId: string | null;
  readonly sourceAutomationRunId: string | null;
  /** Trusted application thread whose canonical tool initiated this input. */
  readonly initiatingAgentThreadId: string | null;
  /** Principal-scoped durable client whose canonical tool initiated this input. */
  readonly initiatingToolClientId: string | null;
  readonly completionCallbackId: string | null;
  readonly inputOrigin: DeliveryInputOrigin | null;
  readonly state: QueuedInputState;
  readonly deliveryMode: "submit" | "steer" | null;
  readonly retryOfId: string | null;
  readonly createdAt: number;
  readonly dispatchStartedAt: number | null;
  readonly acceptedAt: number | null;
  readonly resolvedAt: number | null;
  readonly reconciliationToken: string | null;
  readonly retryAnchor: string | null;
  readonly backendCorrelation: string | null;
  readonly retryCount: number;
  readonly invalidStateRequeues: 0 | 1;
  readonly nextAttemptAt: number | null;
  readonly diagnostic: string | null;
  readonly failureAcknowledgedAt: number | null;
  readonly cancellationMutationId: string | null;
  readonly cancellationRequestFingerprint: string | null;
};

export type QueueRetryPolicy = {
  readonly maximumRetries: number;
  readonly baseDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
};

export const MAXIMUM_ACTIVE_QUEUED_INPUTS = 500;

export function isResolvedSteer(
  item: Pick<QueuedInputRecord, "resolvedDeliveryMode">,
): boolean {
  return item.resolvedDeliveryMode === "steer";
}

export type QueueFailureAttention = {
  readonly queuedInputId: string;
  readonly failedAt: number;
  readonly diagnostic: string;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  application_thread_id AS applicationThreadId,
  sequence,
  mutation_id AS mutationId,
  text,
  selected_skill_id AS selectedSkillId,
  context_excerpts_json AS contextExcerptsJson,
  task_contexts_json AS taskContextsJson,
  CASE
    WHEN requested_steer_target_json IS NOT NULL THEN 'steer'
    ELSE requested_delivery_mode
  END AS requestedDeliveryMode,
  requested_steer_target_json AS requestedSteerTargetJson,
  steer_fallback_at AS steerFallbackAt,
  resolved_delivery_mode AS resolvedDeliveryMode,
  resolved_steer_target_json AS resolvedSteerTargetJson,
  requested_thread_revision AS requestedThreadRevision,
  requested_draft_revision AS requestedDraftRevision,
  trigger_kind AS triggerKind,
  source_automation_id AS sourceAutomationId,
  source_automation_run_id AS sourceAutomationRunId,
  initiating_agent_thread_id AS initiatingAgentThreadId,
  initiating_tool_client_id AS initiatingToolClientId,
  completion_callback_id AS completionCallbackId,
  question_response_origin_json AS questionResponseOriginJson,
  state,
  delivery_mode AS deliveryMode,
  retry_of_id AS retryOfId,
  created_at AS createdAt,
  dispatch_started_at AS dispatchStartedAt,
  accepted_at AS acceptedAt,
  resolved_at AS resolvedAt,
  reconciliation_token AS reconciliationToken,
  retry_anchor AS retryAnchor,
  backend_correlation AS backendCorrelation,
  retry_count AS retryCount,
  invalid_state_requeues AS invalidStateRequeues,
  next_attempt_at AS nextAttemptAt,
  diagnostic,
  failure_acknowledged_at AS failureAcknowledgedAt,
  cancellation_mutation_id AS cancellationMutationId,
  cancellation_request_fingerprint AS cancellationRequestFingerprint
`;

const qualifiedColumns = `
  q.tenant_id AS tenantId,
  q.owner_principal_id AS ownerPrincipalId,
  q.id,
  q.application_thread_id AS applicationThreadId,
  q.sequence,
  q.mutation_id AS mutationId,
  q.text,
  q.selected_skill_id AS selectedSkillId,
  q.context_excerpts_json AS contextExcerptsJson,
  q.task_contexts_json AS taskContextsJson,
  CASE
    WHEN q.requested_steer_target_json IS NOT NULL THEN 'steer'
    ELSE q.requested_delivery_mode
  END AS requestedDeliveryMode,
  q.requested_steer_target_json AS requestedSteerTargetJson,
  q.steer_fallback_at AS steerFallbackAt,
  q.resolved_delivery_mode AS resolvedDeliveryMode,
  q.resolved_steer_target_json AS resolvedSteerTargetJson,
  q.requested_thread_revision AS requestedThreadRevision,
  q.requested_draft_revision AS requestedDraftRevision,
  q.trigger_kind AS triggerKind,
  q.source_automation_id AS sourceAutomationId,
  q.source_automation_run_id AS sourceAutomationRunId,
  q.initiating_agent_thread_id AS initiatingAgentThreadId,
  q.initiating_tool_client_id AS initiatingToolClientId,
  q.completion_callback_id AS completionCallbackId,
  q.question_response_origin_json AS questionResponseOriginJson,
  q.state,
  q.delivery_mode AS deliveryMode,
  q.retry_of_id AS retryOfId,
  q.created_at AS createdAt,
  q.dispatch_started_at AS dispatchStartedAt,
  q.accepted_at AS acceptedAt,
  q.resolved_at AS resolvedAt,
  q.reconciliation_token AS reconciliationToken,
  q.retry_anchor AS retryAnchor,
  q.backend_correlation AS backendCorrelation,
  q.retry_count AS retryCount,
  q.invalid_state_requeues AS invalidStateRequeues,
  q.next_attempt_at AS nextAttemptAt,
  q.diagnostic,
  q.failure_acknowledged_at AS failureAcknowledgedAt,
  q.cancellation_mutation_id AS cancellationMutationId,
  q.cancellation_request_fingerprint AS cancellationRequestFingerprint
`;

export type QueueSteerReservation = {
  readonly item: QueuedInputRecord;
  readonly priorState: "pending" | "retry_wait";
  readonly priorNextAttemptAt: number | null;
  readonly priorDiagnostic: string | null;
};

function cancellationFingerprint(
  applicationThreadId: string,
  queuedInputId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "cancel_queued_input",
        applicationThreadId,
        queuedInputId,
      ]),
    )
    .digest("hex");
}

function restorationFingerprint(
  applicationThreadId: string,
  queuedInputId: string,
  expectedThreadRevision: number,
  expectedDraftRevision: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "restore_queued_input",
        applicationThreadId,
        queuedInputId,
        expectedThreadRevision,
        expectedDraftRevision,
      ]),
    )
    .digest("hex");
}

type RestoredDraft = {
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskReferences: ComposerTaskReference[];
  readonly revision: number;
  readonly updatedAt: number;
};

type QueuedInputRow = Omit<
  QueuedInputRecord,
  "contextExcerpts" | "attachments" | "taskContexts" | "inputOrigin" | "requestedSteerTarget" | "resolvedSteerTarget"
> & {
  readonly requestedSteerTargetJson: string | null;
  readonly resolvedSteerTargetJson: string | null;
  readonly questionResponseOriginJson: string | null;
  readonly contextExcerptsJson: string;
  readonly taskContextsJson: string;
};

function hydrateQueuedInput(
  row: QueuedInputRow,
  attachments: ComposerAttachmentDescriptor[],
  inputOrigin: DeliveryInputOrigin | null,
): QueuedInputRecord {
  return {
    ...row,
    requestedSteerTarget: row.requestedSteerTargetJson === null ? null : steerTargetSchema.parse(JSON.parse(row.requestedSteerTargetJson)),
    resolvedSteerTarget: row.resolvedSteerTargetJson === null ? null : steerTargetSchema.parse(JSON.parse(row.resolvedSteerTargetJson)),
    contextExcerpts: parseStoredContextExcerpts(row.contextExcerptsJson),
    taskContexts: parseStoredTaskContexts(row.taskContextsJson),
    attachments,
    inputOrigin,
  };
}

export class QueuedInputRepository {
  readonly #completion: SubmissionCompletionRepository;
  readonly #attachments: ComposerAttachmentRepository;
  readonly #callbacks: ThreadCompletionCallbackRepository;

  constructor(readonly database: Database.Database) {
    this.#completion = new SubmissionCompletionRepository(database);
    this.#attachments = new ComposerAttachmentRepository(database);
    this.#callbacks = new ThreadCompletionCallbackRepository(database);
  }

  enqueue(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly id?: string;
      readonly mutationId: string;
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskReferences: readonly ComposerTaskReference[];
      readonly source:
        | ({
            readonly kind: "composer";
            readonly expectedThreadRevision: number;
            readonly expectedDraftRevision: number;
          } & (
            | {
                readonly requestedDeliveryMode: "submit" | "queue";
                readonly resolvedDeliveryMode: "submit" | "queue";
              }
            | {
                readonly requestedDeliveryMode: "submit" | "steer";
                readonly requestedSteerTarget?: SteerTarget;
                readonly resolvedDeliveryMode: "steer";
                readonly resolvedSteerTarget: SteerTarget;
              }
            | {
                readonly requestedDeliveryMode: "steer";
                readonly requestedSteerTarget: SteerTarget;
                readonly resolvedDeliveryMode: "submit" | "queue";
              }
          ))
        | {
            /** Ordinary user input admitted independently of the composer. */
            readonly kind: "question_response";
            // Question replies have server-resolved delivery intent but no
            // composer mutation or draft revision to consume.
            readonly inputOrigin: Extract<
              DeliveryInputOrigin,
              { kind: "question_response" }
            >;
            readonly resolvedDeliveryMode: "submit" | "queue" | "steer";
            readonly resolvedSteerTarget?: SteerTarget;
            readonly expectedThreadRevision: number;
          }
        | {
            readonly kind: "automation";
            readonly expectedThreadRevision: number;
            readonly automationId: string;
            readonly automationRunId: string;
          }
        | {
            readonly kind: "agent_control";
            readonly expectedThreadRevision: number;
            readonly initiatingAgentThreadId: string;
            readonly completionCallback?: {
              readonly id: string;
              readonly callerThreadId: string;
            };
          }
        | {
            readonly kind: "principal_client_control";
            readonly expectedThreadRevision: number;
            readonly initiatingToolClientId: string;
          }
        | {
            readonly kind: "completion_callback";
            readonly expectedThreadRevision: number;
            readonly callbackId: string;
            readonly completionIdentity: string;
            readonly sourceThreadLabel: BoundedDisplayText;
            readonly requestedDeliveryMode: "submit" | "queue" | "steer";
            readonly requestedSteerTarget?: SteerTarget;
            readonly resolvedDeliveryMode: "submit" | "queue" | "steer";
            readonly resolvedSteerTarget?: SteerTarget;
          };
      readonly now: number;
    },
  ): { readonly item: QueuedInputRecord; readonly replayed: boolean } {
    if (
      input.source.kind !== "composer" &&
      (input.contextExcerpts.length > 0 ||
        input.attachmentIds.length > 0 ||
        input.taskReferences.length > 0)
    ) {
      throw new DomainError(
        "invalid_transition",
        input.source.kind === "automation"
          ? "Automation queue inputs cannot contain interactive composer context."
          : "Non-composer queue inputs cannot contain interactive composer context.",
      );
    }
    if (
      !hasDeliverableComposerInput({
        ...input,
        attachments: input.attachmentIds,
        taskReferences: input.taskReferences,
      })
    ) {
      throw new DomainError("invalid_transition", "Queued input is empty.");
    }
    return this.database.transaction(() => {
      const replay = this.findByMutationId(
        scope,
        applicationThreadId,
        input.mutationId,
      );
      if (replay) {
        const registeredCallback = this.#callbacks.findForTargetOperation(
          scope,
          applicationThreadId,
          input.mutationId,
        );
        if (
          replay.text !== input.text ||
          JSON.stringify(
            replay.inputOrigin?.kind === "question_response"
              ? replay.inputOrigin
              : null,
          ) !==
            JSON.stringify(
              input.source.kind === "question_response"
                ? deliveryInputOriginSchema.parse(input.source.inputOrigin)
                : null,
            ) ||
          replay.selectedSkillId !== (input.selectedSkillId ?? null) ||
          !sameContextExcerpts(replay.contextExcerpts, input.contextExcerpts) ||
          replay.attachments.map(({ id }) => id).join("\0") !==
            input.attachmentIds.join("\0") ||
          replay.taskContexts.map(({ id }) => id).join("\0") !==
            input.taskReferences.map(({ taskId }) => taskId).join("\0") ||
          replay.retryOfId !== null ||
          replay.triggerKind !==
            (input.source.kind === "automation" ? "automation" : "user") ||
          replay.sourceAutomationId !==
            (input.source.kind === "automation"
              ? input.source.automationId
              : null) ||
          replay.sourceAutomationRunId !==
            (input.source.kind === "automation"
              ? input.source.automationRunId
              : null) ||
          replay.initiatingAgentThreadId !==
            (input.source.kind === "agent_control"
              ? input.source.initiatingAgentThreadId
              : null) ||
          replay.initiatingToolClientId !==
            (input.source.kind === "principal_client_control"
              ? input.source.initiatingToolClientId
              : null) ||
          replay.completionCallbackId !==
            (input.source.kind === "completion_callback"
              ? input.source.callbackId
              : null) ||
          replay.requestedDeliveryMode !==
            (input.source.kind === "composer" ||
            input.source.kind === "completion_callback"
              ? input.source.requestedDeliveryMode
              : null) ||
          JSON.stringify(replay.requestedSteerTarget) !== JSON.stringify(
            ((input.source.kind === "composer" ||
              input.source.kind === "completion_callback") &&
            input.source.requestedDeliveryMode === "steer"
              ? (input.source.requestedSteerTarget ?? null)
              : null)) ||
          replay.requestedThreadRevision !==
            (input.source.kind === "composer"
              ? input.source.expectedThreadRevision
              : null) ||
          replay.requestedDraftRevision !==
            (input.source.kind === "composer"
              ? input.source.expectedDraftRevision
              : null) ||
          (input.source.kind === "agent_control" &&
          input.source.completionCallback !== undefined
            ? registeredCallback?.id !== input.source.completionCallback.id ||
              registeredCallback.callerThreadId !==
                input.source.completionCallback.callerThreadId
            : registeredCallback !== undefined) ||
          (input.source.kind === "completion_callback" &&
            (JSON.stringify(
              replay.inputOrigin?.kind === "agent_result"
                ? replay.inputOrigin.sourceThreadLabel
                : undefined,
            ) !== JSON.stringify(input.source.sourceThreadLabel) ||
              this.#callbacks.get(scope, input.source.callbackId)
                .completionIdentity !== input.source.completionIdentity))
        ) {
          throw new DomainError(
            "conflict",
            "The queue mutation ID was reused with different input.",
          );
        }
        return { item: replay, replayed: true };
      }
      const threadRevision = this.#boundThreadRevision(
        scope,
        applicationThreadId,
      );
      if (threadRevision !== input.source.expectedThreadRevision) {
        throw new DomainError(
          "conflict",
          "The thread changed before the input could be queued.",
        );
      }
      if (
        input.source.kind === "agent_control" &&
        input.source.completionCallback !== undefined
      ) {
        if (
          input.source.completionCallback.callerThreadId !==
          input.source.initiatingAgentThreadId
        ) {
          throw new DomainError(
            "conflict",
            "The callback caller does not match the initiating agent thread.",
          );
        }
        this.#callbacks.register(scope, {
          id: input.source.completionCallback.id,
          callerThreadId: input.source.completionCallback.callerThreadId,
          targetThreadId: applicationThreadId,
          targetOperationId: input.mutationId,
          registeredAt: input.now,
        });
      }
      if (input.source.kind === "completion_callback") {
        const callback = this.#callbacks.get(scope, input.source.callbackId);
        if (
          callback.state !== "registered" ||
          callback.callerThreadId !== applicationThreadId ||
          callback.completionIdentity !== null
        ) {
          throw new DomainError(
            "invalid_transition",
            "The completion callback is not available for queue materialization.",
          );
        }
      }
      if (input.source.kind === "composer") {
        const draft = this.database
          .prepare(
            `
              SELECT text, selected_skill_id AS selectedSkillId,
                context_excerpts_json AS contextExcerptsJson,
                task_references_json AS taskReferencesJson, revision
              FROM thread_drafts
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) as
          | {
              text: string;
              selectedSkillId: string | null;
              contextExcerptsJson: string;
              taskReferencesJson: string;
              revision: number;
            }
          | undefined;
        if (
          !draft ||
          draft.revision !== input.source.expectedDraftRevision ||
          draft.text !== input.text ||
          draft.selectedSkillId !== (input.selectedSkillId ?? null) ||
          !sameContextExcerpts(
            parseStoredContextExcerpts(draft.contextExcerptsJson),
            input.contextExcerpts,
          ) ||
          draft.taskReferencesJson !==
            serializeTaskReferences(input.taskReferences) ||
          this.#attachments
            .descriptorsForOwner(scope, {
              kind: "draft",
              threadId: applicationThreadId,
            })
            .map(({ id }) => id)
            .join("\0") !== input.attachmentIds.join("\0")
        ) {
          throw new DomainError(
            "draft_revision_conflict",
            "The composer draft changed before it could be queued.",
          );
        }
      }
      const taskContexts = materializeTaskReferences(
        this.database,
        scope,
        input.taskReferences,
      );
      assertMaterializedComposerBytes({
        text: input.text,
        contextExcerpts: input.contextExcerpts,
        taskContexts,
      });
      this.#assertActiveCapacity(scope, applicationThreadId);
      if (
        (input.source.kind === "composer" ||
          input.source.kind === "question_response" ||
          input.source.kind === "completion_callback") &&
        input.source.resolvedDeliveryMode === "steer"
      ) {
        const blockingInput = this.database
          .prepare(
            `
              SELECT 1
              FROM queued_inputs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ?
                AND (
                  state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
                  OR (state = 'failed' AND failure_acknowledged_at IS NULL)
                )
                AND (
                  (state = 'failed' AND failure_acknowledged_at IS NULL)
                  OR (
                    resolved_delivery_mode <> 'steer'
                    AND coalesce(delivery_mode, '') <> 'steer'
                  )
                )
              LIMIT 1
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId);
        if (blockingInput) {
          throw new DomainError(
            "invalid_transition",
            "Deliver, steer, or clear the existing queued input before adding another Steer.",
          );
        }
      }
      const sequence = (
        this.database
          .prepare(
            `
              SELECT coalesce(max(sequence), 0) + 1 AS sequence
              FROM queued_inputs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) as {
          sequence: number;
        }
      ).sequence;
      const id = input.id ?? randomUUID();
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "queue", threadId: applicationThreadId, queuedInputId: id },
        input.attachmentIds,
      );
      this.database
        .prepare(
          `
            INSERT INTO queued_inputs(
              tenant_id, owner_principal_id, id, application_thread_id,
              sequence, mutation_id, text, selected_skill_id,
              context_excerpts_json, task_contexts_json, trigger_kind,
              source_automation_id, source_automation_run_id,
              initiating_agent_thread_id, initiating_tool_client_id,
              completion_callback_id, question_response_origin_json,
              requested_delivery_mode,
              requested_steer_target_json,
              resolved_delivery_mode, resolved_steer_target_json,
              requested_thread_revision, requested_draft_revision,
              state, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          applicationThreadId,
          sequence,
          input.mutationId,
          input.text,
          input.selectedSkillId ?? null,
          serializeContextExcerpts(input.contextExcerpts),
          serializeTaskContexts(taskContexts),
          input.source.kind === "automation" ? "automation" : "user",
          input.source.kind === "automation" ? input.source.automationId : null,
          input.source.kind === "automation"
            ? input.source.automationRunId
            : null,
          input.source.kind === "agent_control"
            ? input.source.initiatingAgentThreadId
            : null,
          input.source.kind === "principal_client_control"
            ? input.source.initiatingToolClientId
            : null,
          input.source.kind === "completion_callback"
            ? input.source.callbackId
            : null,
          input.source.kind === "question_response"
            ? JSON.stringify(
                deliveryInputOriginSchema.parse(input.source.inputOrigin),
              )
            : null,
          input.source.kind === "composer" ||
            input.source.kind === "completion_callback"
            ? input.source.requestedDeliveryMode === "steer"
              ? "queue"
              : input.source.requestedDeliveryMode
            : null,
          (input.source.kind === "composer" ||
            input.source.kind === "completion_callback") &&
            input.source.requestedDeliveryMode === "steer"
            ? JSON.stringify(steerTargetSchema.parse(input.source.requestedSteerTarget))
            : null,
          input.source.kind === "composer" ||
            input.source.kind === "question_response" ||
            input.source.kind === "completion_callback"
            ? input.source.resolvedDeliveryMode
            : "queue",
          (input.source.kind === "composer" ||
            input.source.kind === "question_response" ||
            input.source.kind === "completion_callback") &&
            input.source.resolvedDeliveryMode === "steer"
            ? JSON.stringify(steerTargetSchema.parse(input.source.resolvedSteerTarget))
            : null,
          input.source.kind === "composer"
            ? input.source.expectedThreadRevision
            : null,
          input.source.kind === "composer"
            ? input.source.expectedDraftRevision
            : null,
          input.now,
        );
      if (input.source.kind === "completion_callback") {
        this.#callbacks.markMaterialized(scope, input.source.callbackId, {
          queuedInputId: id,
          completionIdentity: input.source.completionIdentity,
          sourceThreadLabel: input.source.sourceThreadLabel,
          materializedAt: input.now,
        });
      }
      const advanced = this.database
        .prepare(
          `
            UPDATE application_threads
            SET revision = revision + 1, last_activity_at = ?, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'bound' AND revision = ?
          `,
        )
        .run(
          input.now,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.source.expectedThreadRevision,
        );
      if (advanced.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The thread changed while the input was being queued.",
        );
      }
      if (input.source.kind === "composer") {
        this.#attachments.replaceOwnerLinks(
          scope,
          { kind: "draft", threadId: applicationThreadId },
          [],
        );
        const cleared = this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = '', selected_skill_id = NULL,
                context_excerpts_json = '[]', task_references_json = '[]',
                updated_at = ?,
                revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND revision = ? AND text = ? AND selected_skill_id IS ?
                AND context_excerpts_json = ? AND task_references_json = ?
            `,
          )
          .run(
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.source.expectedDraftRevision,
            input.text,
            input.selectedSkillId ?? null,
            serializeContextExcerpts(input.contextExcerpts),
            serializeTaskReferences(input.taskReferences),
          );
        if (cleared.changes !== 1) {
          throw new DomainError(
            "draft_revision_conflict",
            "The composer draft changed while the input was being queued.",
          );
        }
      }
      activateSettledThreadForAcceptedInput(
        this.database,
        scope,
        applicationThreadId,
        input.now,
      );
      return {
        item: this.get(scope, applicationThreadId, id),
        replayed: false,
      };
    })();
  }

  claimHead(
    scope: RequestScope,
    applicationThreadId: string,
    retryAnchor: string,
    now: number,
  ): QueuedInputRecord | undefined {
    return this.database.transaction(() => {
      const headRow = this.database
        .prepare(
          `
            SELECT ${columns}
            FROM queued_inputs
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
              AND (
                state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
                OR (state = 'failed' AND failure_acknowledged_at IS NULL)
              )
            ORDER BY sequence
            LIMIT 1
          `,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId) as
        QueuedInputRow | undefined;
      const head = headRow ? this.#hydrate(scope, headRow) : undefined;
      if (
        !head ||
        (head.state !== "pending" && head.state !== "retry_wait") ||
        head.resolvedDeliveryMode === "steer" ||
        (head.state === "retry_wait" &&
          (head.nextAttemptAt === null || head.nextAttemptAt > now))
      ) {
        return undefined;
      }
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'dispatching', dispatch_started_at = ?,
              next_attempt_at = NULL, diagnostic = NULL,
              reconciliation_token = mutation_id, retry_anchor = ?,
              delivery_mode = 'submit'
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ? AND state = ?
              AND (
                resolved_delivery_mode <> 'steer'
              )
              AND EXISTS (
                SELECT 1
                FROM thread_principal_state AS inventory
                WHERE inventory.tenant_id = queued_inputs.tenant_id
                  AND inventory.principal_id = queued_inputs.owner_principal_id
                  AND inventory.thread_id = queued_inputs.application_thread_id
                  AND inventory.inventory_state <> 'archived'
              )
          `,
        )
        .run(
          now,
          retryAnchor,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          head.id,
          head.state,
        );
      if (changed.changes !== 1) return undefined;
      this.#touchThread(scope, applicationThreadId, now, false);
      return this.get(scope, applicationThreadId, head.id);
    })();
  }

  markAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly expectedState: "dispatching" | "uncertain";
      readonly acceptedAt: number;
      readonly backendCorrelation?: string;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const item = this.get(scope, applicationThreadId, id);
      if (item.state !== input.expectedState) {
        throw new DomainError(
          "invalid_transition",
          "The queued input is not awaiting acceptance.",
        );
      }
      this.#completion.recordAccepted(scope, applicationThreadId, {
        operationId: item.mutationId,
        acceptedAt: input.acceptedAt,
        backendCorrelation: input.backendCorrelation,
        attachmentIds: item.attachments.map(({ id }) => id),
      });
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'accepted', accepted_at = ?, resolved_at = ?,
              reconciliation_token = NULL,
              retry_anchor = NULL,
              delivery_mode = NULL,
              backend_correlation = coalesce(?, backend_correlation),
              diagnostic = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ? AND state = ?
              AND delivery_mode = 'submit'
          `,
        )
        .run(
          input.acceptedAt,
          input.acceptedAt,
          input.backendCorrelation ?? null,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
          input.expectedState,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The queued input changed while acceptance was recorded.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.acceptedAt, true);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  markUncertain(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly now: number;
      readonly reconciliationToken?: string;
      readonly backendCorrelation?: string;
      readonly diagnostic: string;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'uncertain',
              reconciliation_token = coalesce(?, reconciliation_token),
              backend_correlation = coalesce(?, backend_correlation),
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state = 'dispatching' AND delivery_mode = 'submit'
          `,
        )
        .run(
          input.reconciliationToken ?? null,
          input.backendCorrelation ?? null,
          input.diagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "Only a dispatching queued input can become uncertain.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  handleInvalidState(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly now: number;
      readonly diagnostic: string;
      readonly retryPolicy: QueueRetryPolicy;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const item = this.get(scope, applicationThreadId, id);
      if (item.state !== "dispatching" || item.deliveryMode !== "submit") {
        throw new DomainError(
          "invalid_transition",
          "Only a dispatching queued input can be requeued.",
        );
      }
      if (item.invalidStateRequeues === 0) {
        this.database
          .prepare(
            `
              UPDATE queued_inputs
              SET state = 'pending', dispatch_started_at = NULL,
                reconciliation_token = NULL,
                retry_anchor = NULL,
                delivery_mode = NULL,
                invalid_state_requeues = 1, diagnostic = ?
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ? AND id = ?
                AND state = 'dispatching' AND delivery_mode = 'submit'
                AND invalid_state_requeues = 0
            `,
          )
          .run(
            input.diagnostic,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            id,
          );
        this.#touchThread(scope, applicationThreadId, input.now, false);
        return this.get(scope, applicationThreadId, id);
      }
      return this.#scheduleRetryOrFail(
        scope,
        applicationThreadId,
        item,
        input.now,
        input.diagnostic,
        input.retryPolicy,
        "dispatching",
      );
    })();
  }

  handleCleanFailure(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly expectedState: "dispatching" | "uncertain";
      readonly retryable: boolean;
      readonly diagnostic: string;
      readonly now: number;
      readonly retryPolicy: QueueRetryPolicy;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const item = this.get(scope, applicationThreadId, id);
      if (
        item.state !== input.expectedState ||
        item.deliveryMode !== "submit"
      ) {
        throw new DomainError(
          "invalid_transition",
          "The queued input is not in the expected delivery state.",
        );
      }
      if (!input.retryable) {
        return this.#markFailed(
          scope,
          applicationThreadId,
          item,
          input.expectedState,
          input.diagnostic,
          input.now,
        );
      }
      return this.#scheduleRetryOrFail(
        scope,
        applicationThreadId,
        item,
        input.now,
        input.diagnostic,
        input.retryPolicy,
        input.expectedState,
      );
    })();
  }

  cancelIdempotently(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly now: number;
    },
  ): { readonly item: QueuedInputRecord; readonly replayed: boolean } {
    const requestFingerprint = cancellationFingerprint(applicationThreadId, id);
    return this.database.transaction(() => {
      const replayRow = this.database
        .prepare(
          `
            SELECT ${columns}
            FROM queued_inputs
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
              AND cancellation_mutation_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.mutationId,
        ) as QueuedInputRow | undefined;
      if (replayRow) {
        const replay = this.#hydrate(scope, replayRow);
        if (
          replay.id !== id ||
          replay.cancellationRequestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The cancellation mutation ID is already used for another queued input.",
          );
        }
        return { item: replay, replayed: true };
      }
      if (
        this.#boundThreadRevision(scope, applicationThreadId) !==
        input.expectedThreadRevision
      ) {
        throw new DomainError(
          "conflict",
          "The thread changed before the queued input could be cancelled.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'cancelled', resolved_at = ?, next_attempt_at = NULL,
              diagnostic = NULL, cancellation_mutation_id = ?,
              cancellation_request_fingerprint = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND trigger_kind = 'user'
              AND state IN ('pending', 'retry_wait', 'failed')
              AND (state <> 'failed' OR failure_acknowledged_at IS NULL)
          `,
        )
        .run(
          input.now,
          input.mutationId,
          requestFingerprint,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
        );
      if (changed.changes !== 1) {
        const current = this.get(scope, applicationThreadId, id);
        if (current.triggerKind !== "user") {
          throw new DomainError(
            "invalid_transition",
            "Automation queued input cannot be cancelled by a user.",
          );
        }
        throw new DomainError(
          "invalid_transition",
          "Only pending, retry-scheduled, or unacknowledged failed queued input can be cancelled.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return {
        item: this.get(scope, applicationThreadId, id),
        replayed: false,
      };
    })();
  }

  restoreIdempotently(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly expectedDraftRevision: number;
      readonly now: number;
    },
  ): {
    readonly item: QueuedInputRecord;
    readonly draft: RestoredDraft;
    readonly replayed: boolean;
  } {
    const requestFingerprint = restorationFingerprint(
      applicationThreadId,
      id,
      input.expectedThreadRevision,
      input.expectedDraftRevision,
    );
    return this.database
      .transaction(() => {
        const existingReceipt = this.database
          .prepare(
            `
            SELECT thread_id AS threadId, operation_kind AS operationKind,
              request_fingerprint AS requestFingerprint,
              result_json AS resultJson
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          `,
          )
          .get(scope.tenantId, scope.principalId, input.mutationId) as
          | {
              threadId: string;
              operationKind: string;
              requestFingerprint: string;
              resultJson: string;
            }
          | undefined;
        if (existingReceipt) {
          if (
            existingReceipt.threadId !== applicationThreadId ||
            existingReceipt.operationKind !== "restore_queued_input" ||
            existingReceipt.requestFingerprint !== requestFingerprint
          ) {
            throw new DomainError(
              "conflict",
              "The mutation ID is already used by another operation.",
            );
          }
          let result: unknown;
          try {
            result = JSON.parse(existingReceipt.resultJson);
          } catch {
            throw new DomainError(
              "conflict",
              "The queued-input restoration receipt is invalid.",
            );
          }
          if (
            typeof result !== "object" ||
            result === null ||
            (result as { version?: unknown }).version !== 1 ||
            (result as { queuedInputId?: unknown }).queuedInputId !== id
          ) {
            throw new DomainError(
              "conflict",
              "The queued-input restoration receipt is invalid.",
            );
          }
          return {
            item: this.get(scope, applicationThreadId, id),
            draft: this.#getDraft(scope, applicationThreadId),
            replayed: true,
          };
        }
        const cancellationReuse = this.database
          .prepare(
            `
            SELECT 1
            FROM queued_inputs
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND cancellation_mutation_id = ?
          `,
          )
          .get(scope.tenantId, scope.principalId, input.mutationId);
        if (cancellationReuse) {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        if (
          this.#boundThreadRevision(scope, applicationThreadId) !==
          input.expectedThreadRevision
        ) {
          throw new DomainError(
            "conflict",
            "The thread changed before the queued input could be restored.",
          );
        }
        const item = this.get(scope, applicationThreadId, id);
        if (
          item.triggerKind !== "user" ||
          item.initiatingAgentThreadId !== null ||
          item.initiatingToolClientId !== null ||
          item.completionCallbackId !== null
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only browser-origin user queued input can be restored.",
          );
        }
        if (
          item.state !== "pending" &&
          item.state !== "retry_wait" &&
          (item.state !== "failed" || item.failureAcknowledgedAt !== null)
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only pending, retry-scheduled, or unacknowledged failed queued input can be restored.",
          );
        }
        const draft = this.#getDraft(scope, applicationThreadId);
        if (draft.revision !== input.expectedDraftRevision) {
          throw new DomainError(
            "draft_revision_conflict",
            "The composer draft changed before the queued input could be restored.",
          );
        }
        if (
          draft.text.length !== 0 ||
          draft.selectedSkillId !== null ||
          draft.contextExcerpts.length !== 0 ||
          draft.attachments.length !== 0 ||
          draft.taskReferences.length !== 0
        ) {
          throw new DomainError(
            "invalid_transition",
            "The composer must be empty before a queued input can be restored.",
          );
        }
        this.#attachments.replaceOwnerLinks(
          scope,
          { kind: "draft", threadId: applicationThreadId },
          item.attachments.map(({ id: attachmentId }) => attachmentId),
        );
        const taskReferences = taskReferencesFromContexts(item.taskContexts);
        const draftChanged = this.database
          .prepare(
            `
            UPDATE thread_drafts
            SET text = ?, selected_skill_id = ?, context_excerpts_json = ?,
              task_references_json = ?,
              updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ? AND length(text) = 0
              AND selected_skill_id IS NULL AND context_excerpts_json = '[]'
              AND task_references_json = '[]'
          `,
          )
          .run(
            item.text,
            item.selectedSkillId,
            serializeContextExcerpts(item.contextExcerpts),
            serializeTaskReferences(taskReferences),
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.expectedDraftRevision,
          );
        if (draftChanged.changes !== 1) {
          throw new DomainError(
            "draft_revision_conflict",
            "The composer draft changed while the queued input was restored.",
          );
        }
        const queueChanged = this.database
          .prepare(
            `
            UPDATE queued_inputs
            SET state = 'cancelled', resolved_at = ?, next_attempt_at = NULL,
              diagnostic = 'Restored to composer.'
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND trigger_kind = 'user'
              AND initiating_agent_thread_id IS NULL
              AND state IN ('pending', 'retry_wait', 'failed')
              AND (state <> 'failed' OR failure_acknowledged_at IS NULL)
          `,
          )
          .run(
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            id,
          );
        if (queueChanged.changes !== 1) {
          throw new DomainError(
            "invalid_transition",
            "The queued input changed while it was restored.",
          );
        }
        const threadChanged = this.database
          .prepare(
            `
            UPDATE application_threads
            SET revision = revision + 1, last_activity_at = ?, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'bound' AND revision = ?
          `,
          )
          .run(
            input.now,
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.expectedThreadRevision,
          );
        if (threadChanged.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The thread changed while the queued input was restored.",
          );
        }
        const generationChanged = this.database
          .prepare(
            `
            UPDATE principal_generations
            SET inventory_generation = inventory_generation + 1
            WHERE tenant_id = ? AND principal_id = ?
          `,
          )
          .run(scope.tenantId, scope.principalId);
        if (generationChanged.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The principal inventory generation is missing.",
          );
        }
        this.database
          .prepare(
            `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (?, ?, ?, ?, 'restore_queued_input', ?, 'restored', ?, 1, ?)
          `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.mutationId,
            requestFingerprint,
            JSON.stringify({ version: 1, queuedInputId: id }),
            input.now,
          );
        return {
          item: this.get(scope, applicationThreadId, id),
          draft: this.#getDraft(scope, applicationThreadId),
          replayed: false,
        };
      })
      .immediate();
  }

  reserveHeadForSteer(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly steerOperationId: string;
      readonly expectedThreadRevision: number;
      readonly now: number;
    },
  ): QueueSteerReservation {
    return this.database.transaction(() => {
      if (
        this.#boundThreadRevision(scope, applicationThreadId) !==
        input.expectedThreadRevision
      ) {
        throw new DomainError(
          "conflict",
          "The thread changed before the queued input could be steered.",
        );
      }
      const current = this.get(scope, applicationThreadId, id);
      if (
        current.triggerKind !== "user" ||
        (current.state !== "pending" && current.state !== "retry_wait")
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only pending user queued input can be steered.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'dispatching', delivery_mode = 'steer',
              dispatch_started_at = ?, reconciliation_token = ?,
              retry_anchor = ?, next_attempt_at = NULL, diagnostic = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ? AND state = ?
              AND trigger_kind = 'user'
              AND NOT EXISTS (
                SELECT 1 FROM queued_inputs AS earlier
                WHERE earlier.tenant_id = queued_inputs.tenant_id
                  AND earlier.owner_principal_id = queued_inputs.owner_principal_id
                  AND earlier.application_thread_id = queued_inputs.application_thread_id
                  AND earlier.sequence < queued_inputs.sequence
                  AND (
                    earlier.state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
                    OR (earlier.state = 'failed'
                      AND earlier.failure_acknowledged_at IS NULL)
                  )
              )
          `,
        )
        .run(
          input.now,
          input.steerOperationId,
          input.steerOperationId,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
          current.state,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "Only the current queued-input head can be steered.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return {
        item: this.get(scope, applicationThreadId, id),
        priorState: current.state,
        priorNextAttemptAt: current.nextAttemptAt,
        priorDiagnostic: current.diagnostic,
      };
    })();
  }

  markSteerUncertain(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly steerOperationId: string;
      readonly backendCorrelation?: string;
      readonly diagnostic: string;
      readonly now: number;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'uncertain',
              backend_correlation = coalesce(?, backend_correlation),
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state = 'dispatching' AND delivery_mode = 'steer'
              AND reconciliation_token = ?
          `,
        )
        .run(
          input.backendCorrelation ?? null,
          input.diagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
          input.steerOperationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The queued input is not awaiting Steer reconciliation.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  failPendingRequestedSteer(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly diagnostic: string;
      readonly now: number;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'failed', resolved_at = ?, next_attempt_at = NULL,
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state IN ('pending', 'retry_wait')
              AND resolved_delivery_mode = 'steer'
          `,
        )
        .run(
          input.now,
          input.diagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The pending Steer intent changed before failure was recorded.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  demotePendingRequestedSteer(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: { readonly now: number },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'pending', steer_fallback_at = CASE
              WHEN requested_steer_target_json IS NOT NULL THEN ? ELSE NULL END,
              resolved_delivery_mode = 'queue', resolved_steer_target_json = NULL,
              next_attempt_at = NULL, diagnostic = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state IN ('pending', 'retry_wait')
              AND resolved_delivery_mode = 'steer'
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The pending Steer intent changed before fallback was recorded.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  failSteerUnknown(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly steerOperationId: string;
      readonly expectedState: "dispatching" | "uncertain";
      readonly diagnostic: string;
      readonly now: number;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE queued_inputs
        SET state = 'failed', resolved_at = ?, next_attempt_at = NULL,
          reconciliation_token = NULL, retry_anchor = NULL,
          delivery_mode = NULL, backend_correlation = NULL, diagnostic = ?
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND id = ? AND state = ?
          AND delivery_mode = 'steer' AND reconciliation_token = ?
      `).run(input.now, input.diagnostic, scope.tenantId, scope.principalId,
        applicationThreadId, id, input.expectedState, input.steerOperationId);
      if (changed.changes !== 1) {
        throw new DomainError("invalid_transition", "The queued Steer changed before its unknown outcome was recorded.");
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  restoreSteerReservation(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly steerOperationId: string;
      readonly expectedState: "dispatching" | "uncertain";
      readonly priorState: "pending" | "retry_wait";
      readonly priorNextAttemptAt: number | null;
      readonly priorDiagnostic: string | null;
      readonly now: number;
    },
  ): QueuedInputRecord {
    if (
      (input.priorState === "pending" && input.priorNextAttemptAt !== null) ||
      (input.priorState === "retry_wait" && input.priorNextAttemptAt === null)
    ) {
      throw new DomainError(
        "conflict",
        "The queued-input Steer restoration boundary is invalid.",
      );
    }
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = ?, delivery_mode = NULL,
              dispatch_started_at = NULL, reconciliation_token = NULL,
              retry_anchor = NULL, backend_correlation = NULL,
              next_attempt_at = ?, diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ? AND state = ?
              AND delivery_mode = 'steer' AND reconciliation_token = ?
          `,
        )
        .run(
          input.priorState,
          input.priorNextAttemptAt,
          input.priorDiagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
          input.expectedState,
          input.steerOperationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The queued-input Steer reservation changed before restoration.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  acceptSteered(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: {
      readonly steerOperationId: string;
      readonly expectedState: "dispatching" | "uncertain" | "failed";
      readonly acceptedAt: number;
      readonly backendCorrelation?: string;
    },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'accepted', delivery_mode = NULL,
              accepted_at = ?, resolved_at = ?,
              reconciliation_token = NULL, retry_anchor = NULL,
              backend_correlation = coalesce(?, backend_correlation),
              diagnostic = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ? AND state = ?
              AND ((delivery_mode = 'steer' AND reconciliation_token = ?)
                OR (state = 'failed' AND delivery_mode IS NULL AND failure_acknowledged_at IS NULL))
          `,
        )
        .run(
          input.acceptedAt,
          input.acceptedAt,
          input.backendCorrelation ?? null,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
          input.expectedState,
          input.steerOperationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The queued-input Steer reservation changed before acceptance.",
        );
      }
      // The dispatcher records the sole completion anchor under the Steer
      // operation ID. Deliberately do not call #completion here.
      this.#touchThread(scope, applicationThreadId, input.acceptedAt, true);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  cancel(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    input: { readonly diagnostic?: string; readonly now: number },
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE queued_inputs
            SET state = 'cancelled', resolved_at = ?, next_attempt_at = NULL,
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state IN ('pending', 'retry_wait')
          `,
        )
        .run(
          input.now,
          input.diagnostic ?? null,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "Only a pending queued input can be cancelled.",
        );
      }
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  acknowledgeFailure(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    now: number,
  ): QueuedInputRecord {
    return this.database.transaction(() => {
      const current = this.get(scope, applicationThreadId, id);
      if (current.state !== "failed") {
        throw new DomainError(
          "invalid_transition",
          "Only a failed queued input can be acknowledged.",
        );
      }
      if (current.failureAcknowledgedAt !== null) return current;
      const changed = this.#acknowledgeFailure(
        scope,
        applicationThreadId,
        id,
        now,
      );
      if (changed !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The failed queued input changed before it could be acknowledged.",
        );
      }
      this.#touchThread(scope, applicationThreadId, now, false);
      return this.get(scope, applicationThreadId, id);
    })();
  }

  retryFailed(
    scope: RequestScope,
    applicationThreadId: string,
    failedId: string,
    input: {
      readonly id?: string;
      readonly mutationId: string;
      readonly now: number;
    },
  ): { readonly item: QueuedInputRecord; readonly replayed: boolean } {
    return this.database.transaction(() => {
      const replay = this.findByMutationId(
        scope,
        applicationThreadId,
        input.mutationId,
      );
      if (replay) {
        if (replay.retryOfId !== failedId) {
          throw new DomainError(
            "conflict",
            "The retry mutation ID was reused for another queued input.",
          );
        }
        return { item: replay, replayed: true };
      }
      const failed = this.get(scope, applicationThreadId, failedId);
      if (failed.state !== "failed" || failed.failureAcknowledgedAt !== null) {
        throw new DomainError(
          "invalid_transition",
          "Only an unacknowledged failed queued input can be retried explicitly.",
        );
      }
      if (failed.completionCallbackId !== null) {
        throw new DomainError(
          "invalid_transition",
          "Completion callback inputs cannot be explicitly retried as new queue items.",
        );
      }
      if (
        this.#acknowledgeFailure(
          scope,
          applicationThreadId,
          failedId,
          input.now,
        ) !== 1
      ) {
        throw new DomainError(
          "invalid_transition",
          "The failed queued input changed before it could be retried.",
        );
      }
      const sequence = (
        this.database
          .prepare(
            `
              SELECT coalesce(max(sequence), 0) + 1 AS sequence
              FROM queued_inputs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) as {
          sequence: number;
        }
      ).sequence;
      const id = input.id ?? randomUUID();
      this.#attachments.copyOwnerLinks(
        scope,
        {
          kind: "queue",
          threadId: applicationThreadId,
          queuedInputId: failedId,
        },
        {
          kind: "queue",
          threadId: applicationThreadId,
          queuedInputId: id,
        },
      );
      this.database
        .prepare(
          `
            INSERT INTO queued_inputs(
              tenant_id, owner_principal_id, id, application_thread_id,
              sequence, mutation_id, text, selected_skill_id,
              context_excerpts_json, task_contexts_json, trigger_kind,
              source_automation_id, source_automation_run_id,
              initiating_agent_thread_id, initiating_tool_client_id,
              question_response_origin_json,
              resolved_delivery_mode, state, retry_of_id, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queue', 'pending', ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          applicationThreadId,
          sequence,
          input.mutationId,
          failed.text,
          failed.selectedSkillId,
          serializeContextExcerpts(failed.contextExcerpts),
          serializeTaskContexts(failed.taskContexts),
          failed.triggerKind,
          failed.sourceAutomationId,
          failed.sourceAutomationRunId,
          failed.initiatingAgentThreadId,
          failed.initiatingToolClientId,
          failed.inputOrigin?.kind === "question_response"
            ? JSON.stringify(failed.inputOrigin)
            : null,
          failed.id,
          input.now,
        );
      this.#touchThread(scope, applicationThreadId, input.now, false);
      return {
        item: this.get(scope, applicationThreadId, id),
        replayed: false,
      };
    })();
  }

  list(scope: RequestScope, applicationThreadId: string): QueuedInputRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
          ORDER BY sequence
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      ) as QueuedInputRow[];
    return rows.map((row) => this.#hydrate(scope, row));
  }

  readProjectionState(
    scope: RequestScope,
    applicationThreadId: string,
  ): {
    readonly threadRevision: number;
    readonly records: QueuedInputRecord[];
  } {
    return this.database.transaction(() => ({
      threadRevision: this.#threadRevision(scope, applicationThreadId),
      records: this.list(scope, applicationThreadId),
    }))();
  }

  #getDraft(scope: RequestScope, applicationThreadId: string): RestoredDraft {
    const row = this.database
      .prepare(
        `
          SELECT text, selected_skill_id AS selectedSkillId,
            context_excerpts_json AS contextExcerptsJson,
            task_references_json AS taskReferencesJson,
            revision, updated_at AS updatedAt
          FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | {
          text: string;
          selectedSkillId: string | null;
          contextExcerptsJson: string;
          taskReferencesJson: string;
          revision: number;
          updatedAt: number;
        }
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The thread draft was not found.");
    }
    return {
      text: row.text,
      selectedSkillId: row.selectedSkillId,
      contextExcerpts: parseStoredContextExcerpts(row.contextExcerptsJson),
      taskReferences: parseStoredTaskReferences(row.taskReferencesJson),
      attachments: this.#attachments.descriptorsForOwner(scope, {
        kind: "draft",
        threadId: applicationThreadId,
      }),
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }

  listRecoveryRequired(scope: RequestScope): QueuedInputRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND state IN ('dispatching', 'uncertain')
          ORDER BY application_thread_id, sequence
        `,
      )
      .all(scope.tenantId, scope.principalId) as QueuedInputRow[];
    return rows.map((row) => this.#hydrate(scope, row));
  }

  getFailureAttention(
    scope: RequestScope,
    applicationThreadId: string,
  ): QueueFailureAttention | undefined {
    const row = this.database
      .prepare(
        `
          SELECT id AS queuedInputId, resolved_at AS failedAt, diagnostic
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND state = 'failed'
            AND failure_acknowledged_at IS NULL
          ORDER BY sequence
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      QueueFailureAttention | undefined;
    return row;
  }

  /**
   * Returns the one ordering-relevant active head for every thread in scope.
   * Accepted, cancelled, and acknowledged failures no longer block ordering.
   */
  listActiveHeads(scope: RequestScope): QueuedInputRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${qualifiedColumns}
          FROM queued_inputs AS q
          WHERE q.tenant_id = ? AND q.owner_principal_id = ?
            AND (
              q.state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
              OR (
                q.state = 'failed'
                AND q.failure_acknowledged_at IS NULL
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM queued_inputs AS earlier
              WHERE earlier.tenant_id = q.tenant_id
                AND earlier.owner_principal_id = q.owner_principal_id
                AND earlier.application_thread_id =
                  q.application_thread_id
                AND earlier.sequence < q.sequence
                AND (
                  earlier.state IN (
                    'pending', 'retry_wait', 'dispatching', 'uncertain'
                  )
                  OR (
                    earlier.state = 'failed'
                    AND earlier.failure_acknowledged_at IS NULL
                  )
                )
            )
          ORDER BY q.application_thread_id, q.sequence
        `,
      )
      .all(scope.tenantId, scope.principalId) as QueuedInputRow[];
    return rows.map((row) => this.#hydrate(scope, row));
  }

  get(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
  ): QueuedInputRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId, id) as
      QueuedInputRow | undefined;
    if (!row)
      throw new DomainError("not_found", "The queued input was not found.");
    return this.#hydrate(scope, row);
  }

  findByMutationId(
    scope: RequestScope,
    applicationThreadId: string,
    mutationId: string,
  ): QueuedInputRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND mutation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        mutationId,
      ) as QueuedInputRow | undefined;
    return row ? this.#hydrate(scope, row) : undefined;
  }

  findComposerDeliveryReplay(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly requestedDeliveryMode: "submit" | "queue" | "steer";
      readonly requestedSteerTarget?: SteerTarget;
      readonly expectedThreadRevision: number;
      readonly expectedDraftRevision: number;
    },
  ): QueuedInputRecord | undefined {
    const item = this.findByMutationId(
      scope,
      applicationThreadId,
      input.mutationId,
    );
    if (!item) return undefined;
    if (
      item.triggerKind !== "user" ||
      item.initiatingAgentThreadId !== null ||
      item.initiatingToolClientId !== null ||
      item.retryOfId !== null ||
      item.requestedDeliveryMode !== input.requestedDeliveryMode ||
      JSON.stringify(item.requestedSteerTarget) !== JSON.stringify(input.requestedSteerTarget ?? null) ||
      item.requestedThreadRevision !== input.expectedThreadRevision ||
      item.requestedDraftRevision !== input.expectedDraftRevision
    ) {
      throw new DomainError(
        "conflict",
        "The delivery mutation ID was reused with different input.",
      );
    }
    return item;
  }

  #scheduleRetryOrFail(
    scope: RequestScope,
    applicationThreadId: string,
    item: QueuedInputRecord,
    now: number,
    diagnostic: string,
    policy: QueueRetryPolicy,
    expectedState: "dispatching" | "uncertain",
  ): QueuedInputRecord {
    this.#assertRetryPolicy(policy);
    if (item.retryCount >= policy.maximumRetries) {
      return this.#markFailed(
        scope,
        applicationThreadId,
        item,
        expectedState,
        diagnostic,
        now,
      );
    }
    const exponent = Math.min(item.retryCount, 30);
    const delay = Math.min(
      policy.maximumDelayMilliseconds,
      policy.baseDelayMilliseconds * 2 ** exponent,
    );
    const changed = this.database
      .prepare(
        `
          UPDATE queued_inputs
          SET state = 'retry_wait', dispatch_started_at = NULL,
            reconciliation_token = NULL, retry_anchor = NULL,
            delivery_mode = NULL,
            backend_correlation = NULL,
            retry_count = retry_count + 1, next_attempt_at = ?, diagnostic = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND id = ? AND state = ?
            AND delivery_mode = 'submit' AND retry_count = ?
        `,
      )
      .run(
        now + delay,
        diagnostic,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        item.id,
        expectedState,
        item.retryCount,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "The queued input changed while retry was scheduled.",
      );
    }
    this.#touchThread(scope, applicationThreadId, now, false);
    return this.get(scope, applicationThreadId, item.id);
  }

  #acknowledgeFailure(
    scope: RequestScope,
    applicationThreadId: string,
    id: string,
    now: number,
  ): number {
    return this.database
      .prepare(
        `
          UPDATE queued_inputs
          SET failure_acknowledged_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND id = ? AND state = 'failed'
            AND failure_acknowledged_at IS NULL
        `,
      )
      .run(now, scope.tenantId, scope.principalId, applicationThreadId, id)
      .changes;
  }

  #assertActiveCapacity(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    const active = this.database
      .prepare(
        `
          SELECT count(*) AS count
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
            AND (
              state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
              OR (state = 'failed' AND failure_acknowledged_at IS NULL)
            )
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as {
      count: number;
    };
    if (active.count >= MAXIMUM_ACTIVE_QUEUED_INPUTS) {
      throw new DomainError(
        "conflict",
        "The thread queue has reached its active-item limit.",
      );
    }
  }

  #touchThread(
    scope: RequestScope,
    applicationThreadId: string,
    now: number,
    acceptedActivity: boolean,
  ): void {
    const changed = this.database
      .prepare(
        `
          UPDATE application_threads
          SET revision = revision + 1, updated_at = ?,
            last_activity_at = CASE
              WHEN ? = 1 THEN max(last_activity_at, ?)
              ELSE last_activity_at
            END
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND backing_state = 'bound'
        `,
      )
      .run(
        now,
        acceptedActivity ? 1 : 0,
        now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "The bound thread changed while its queue state was updated.",
      );
    }
  }

  #markFailed(
    scope: RequestScope,
    applicationThreadId: string,
    item: QueuedInputRecord,
    expectedState: "dispatching" | "uncertain",
    diagnostic: string,
    now: number,
  ): QueuedInputRecord {
    const changed = this.database
      .prepare(
        `
          UPDATE queued_inputs
          SET state = 'failed', resolved_at = ?, next_attempt_at = NULL,
            reconciliation_token = NULL, retry_anchor = NULL,
            delivery_mode = NULL,
            backend_correlation = NULL,
            diagnostic = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND id = ? AND state = ?
            AND delivery_mode = 'submit'
        `,
      )
      .run(
        now,
        diagnostic,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        item.id,
        expectedState,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "The queued input changed while failure was recorded.",
      );
    }
    this.#touchThread(scope, applicationThreadId, now, false);
    return this.get(scope, applicationThreadId, item.id);
  }

  #assertRetryPolicy(policy: QueueRetryPolicy): void {
    if (
      !Number.isSafeInteger(policy.maximumRetries) ||
      policy.maximumRetries < 0 ||
      !Number.isSafeInteger(policy.baseDelayMilliseconds) ||
      policy.baseDelayMilliseconds < 1 ||
      !Number.isSafeInteger(policy.maximumDelayMilliseconds) ||
      policy.maximumDelayMilliseconds < policy.baseDelayMilliseconds
    ) {
      throw new DomainError("conflict", "The queue retry policy is invalid.");
    }
  }

  #hydrate(scope: RequestScope, row: QueuedInputRow): QueuedInputRecord {
    let inputOrigin: DeliveryInputOrigin | null = null;
    if (row.questionResponseOriginJson !== null) {
      const parsed = deliveryInputOriginSchema.parse(
        JSON.parse(row.questionResponseOriginJson),
      );
      if (
        parsed.kind !== "question_response" ||
        row.initiatingAgentThreadId !== null ||
        row.completionCallbackId !== null ||
        row.initiatingToolClientId !== null ||
        row.triggerKind !== "user"
      ) {
        throw new DomainError(
          "conflict",
          "The queued question-response provenance is invalid.",
        );
      }
      inputOrigin = parsed;
    } else if (row.initiatingAgentThreadId !== null) {
      const source = this.database
        .prepare(
          `
            SELECT title
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, row.initiatingAgentThreadId) as
        { readonly title: string } | undefined;
      if (!source) {
        throw new DomainError(
          "conflict",
          "The queued agent-message source thread is unavailable.",
        );
      }
      inputOrigin = {
        kind: "agent_message",
        sourceThreadId: row.initiatingAgentThreadId,
        sourceThreadLabel: boundDisplayText(source.title),
      };
    } else if (row.completionCallbackId !== null) {
      const callback = this.#callbacks.get(scope, row.completionCallbackId);
      if (
        callback.state !== "materialized" ||
        callback.sourceThreadLabel === null
      ) {
        throw new DomainError(
          "conflict",
          "The queued completion callback provenance is incomplete.",
        );
      }
      inputOrigin = {
        kind: "agent_result",
        callbackId: callback.id,
        sourceThreadId: callback.targetThreadId,
        sourceThreadLabel: callback.sourceThreadLabel,
      };
    }
    return hydrateQueuedInput(
      row,
      this.#attachments.descriptorsForOwner(scope, {
        kind: "queue",
        threadId: row.applicationThreadId,
        queuedInputId: row.id,
      }),
      inputOrigin,
    );
  }

  #boundThreadRevision(
    scope: RequestScope,
    applicationThreadId: string,
  ): number {
    const row = this.database
      .prepare(
        `
          SELECT thread.backing_state AS backingState, thread.revision,
            inventory.inventory_state AS inventoryState
          FROM application_threads AS thread
          INNER JOIN thread_principal_state AS inventory
            ON inventory.tenant_id = thread.tenant_id
            AND inventory.principal_id = thread.owner_principal_id
            AND inventory.thread_id = thread.id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
            AND thread.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | {
          backingState: string;
          revision: number;
          inventoryState: string;
        }
      | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    if (row.inventoryState === "archived") {
      throw new DomainError(
        "archived_thread",
        "An archived thread cannot accept queued input.",
      );
    }
    if (row.backingState !== "bound") {
      throw new DomainError(
        "invalid_transition",
        "Only a bound thread can accept queued input.",
      );
    }
    return row.revision;
  }

  #threadRevision(scope: RequestScope, applicationThreadId: string): number {
    const row = this.database
      .prepare(
        `
          SELECT revision
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly revision: number } | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row.revision;
  }

  getThreadRevision(scope: RequestScope, applicationThreadId: string): number {
    return this.#boundThreadRevision(scope, applicationThreadId);
  }
}
