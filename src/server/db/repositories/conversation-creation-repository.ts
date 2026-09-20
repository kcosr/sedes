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
import { hasDeliverableComposerInput } from "../../../shared/protocol/conversation.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import type {
  ComposerTaskReference,
  MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";
import {
  assertMaterializedComposerBytes,
  materializeTaskReferences,
  parseStoredTaskContexts,
  serializeTaskContexts,
  serializeTaskReferences,
  taskReferencesFromContexts,
} from "../composer-tasks-json.js";
import { activateSettledThreadForAcceptedInput } from "./accepted-input-inventory.js";
import { ThreadCompletionCallbackRepository } from "./thread-completion-callback-repository.js";

export type CreationAttemptPhase =
  | "prepared"
  | "external_call_started"
  | "conversation_identified"
  | "first_submission_started"
  | "accepted_unpersisted"
  | "bound"
  | "aborted_unpersisted"
  | "recovery_required";

export type ConversationCreationAttemptRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly attemptId: string;
  readonly mutationId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly creationKind: "first_input" | "fork";
  readonly forkChildIdentity:
    "application_reserved" | "provider_assigned" | null;
  readonly forkCreationRecovery:
    "idempotent" | "exactly_reconcilable" | "potentially_unknown" | null;
  readonly forkUncertaintyKind: "fork_unknown" | null;
  readonly sourceKind:
    | "composer"
    | "automation"
    | "user_fork"
    | "agent_control"
    | "principal_client";
  readonly sourceAutomationId: string | null;
  readonly sourceAutomationRunId: string | null;
  readonly initiatingAgentThreadId: string | null;
  readonly initiatingToolClientId: string | null;
  readonly initialInputText: string | null;
  readonly initialSkillId: string | null;
  readonly initialContextExcerpts: ContextExcerpt[];
  readonly initialAttachments: ComposerAttachmentDescriptor[];
  readonly initialTaskContexts: MaterializedTaskContext[];
  readonly consumedDraftRevision: number | null;
  readonly backendCreationCorrelation: string;
  readonly phase: CreationAttemptPhase;
  readonly provisionalBackendConversationId: string | null;
  readonly provisionalOpaqueBindingDetail: string | null;
  readonly reconciliationToken: string | null;
  readonly retryAnchor: string | null;
  readonly retryAuthorizedAt: number | null;
  readonly retryMutationId: string | null;
  readonly retryStartedAt: number | null;
  readonly retryReconciliationToken: string | null;
  readonly backendCorrelation: string | null;
  readonly completionIdentity: string | null;
  readonly diagnostic: string | null;
  readonly preparedAt: number;
  readonly externalCallStartedAt: number | null;
  readonly acceptedAt: number | null;
  readonly reconciledAt: number | null;
  readonly forceResetAt: number | null;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  attempt_id AS attemptId,
  mutation_id AS mutationId,
  backend_instance_id AS backendInstanceId,
  connection_profile_id AS connectionProfileId,
  execution_environment_id AS executionEnvironmentId,
  creation_kind AS creationKind,
  fork_child_identity AS forkChildIdentity,
  fork_creation_recovery AS forkCreationRecovery,
  fork_uncertainty_kind AS forkUncertaintyKind,
  source_kind AS sourceKind,
  source_automation_id AS sourceAutomationId,
  source_automation_run_id AS sourceAutomationRunId,
  initiating_agent_thread_id AS initiatingAgentThreadId,
  initiating_tool_client_id AS initiatingToolClientId,
  initial_input_text AS initialInputText,
  initial_skill_id AS initialSkillId,
  initial_context_excerpts_json AS initialContextExcerptsJson,
  initial_task_contexts_json AS initialTaskContextsJson,
  consumed_draft_revision AS consumedDraftRevision,
  backend_creation_correlation AS backendCreationCorrelation,
  phase,
  provisional_backend_conversation_id AS provisionalBackendConversationId,
  provisional_opaque_binding_detail AS provisionalOpaqueBindingDetail,
  reconciliation_token AS reconciliationToken,
  retry_anchor AS retryAnchor,
  retry_authorized_at AS retryAuthorizedAt,
  retry_mutation_id AS retryMutationId,
  retry_started_at AS retryStartedAt,
  retry_reconciliation_token AS retryReconciliationToken,
  backend_correlation AS backendCorrelation,
  completion_identity AS completionIdentity,
  diagnostic,
  prepared_at AS preparedAt,
  external_call_started_at AS externalCallStartedAt,
  accepted_at AS acceptedAt,
  reconciled_at AS reconciledAt,
  force_reset_at AS forceResetAt
`;

type ConversationCreationAttemptRow = Omit<
  ConversationCreationAttemptRecord,
  "initialContextExcerpts" | "initialAttachments" | "initialTaskContexts"
> & {
  readonly initialContextExcerptsJson: string;
  readonly initialTaskContextsJson: string;
};

function hydrateAttempt(
  row: ConversationCreationAttemptRow,
  attachments: ComposerAttachmentDescriptor[],
): ConversationCreationAttemptRecord {
  if (row.forceResetAt !== null) {
    throw new DomainError(
      "conflict",
      "The creation attempt was explicitly abandoned by force reset.",
    );
  }
  return {
    ...row,
    initialContextExcerpts: parseStoredContextExcerpts(
      row.initialContextExcerptsJson,
    ),
    initialAttachments: attachments,
    initialTaskContexts: parseStoredTaskContexts(row.initialTaskContextsJson),
  };
}

type ThreadTargetRow = {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly revision: number;
};

export type PrepareCreationAttemptInput =
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "first_input";
      readonly sourceKind: "composer";
      readonly initialInputText: string;
      readonly initialSkillId?: string;
      readonly initialContextExcerpts: readonly ContextExcerpt[];
      readonly initialAttachmentIds: readonly string[];
      readonly initialTaskReferences: readonly ComposerTaskReference[];
      readonly expectedDraftRevision: number;
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "first_input";
      readonly sourceKind: "principal_client";
      readonly initiatingToolClientId: string;
      readonly initialInputText: string;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "first_input";
      readonly sourceKind: "agent_control";
      readonly initiatingAgentThreadId: string;
      readonly completionCallback?: {
        readonly id: string;
        readonly callerThreadId: string;
      };
      readonly initialInputText: string;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "first_input";
      readonly sourceKind: "automation";
      readonly sourceAutomationId: string;
      readonly sourceAutomationRunId: string;
      readonly initialInputText: string;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "fork";
      readonly forkChildIdentity: "application_reserved" | "provider_assigned";
      readonly forkCreationRecovery:
        "idempotent" | "exactly_reconcilable" | "potentially_unknown";
      readonly sourceKind: "automation";
      readonly sourceAutomationId: string;
      readonly sourceAutomationRunId: string;
      readonly initialInputText: null;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "fork";
      readonly forkChildIdentity: "application_reserved" | "provider_assigned";
      readonly forkCreationRecovery:
        "idempotent" | "exactly_reconcilable" | "potentially_unknown";
      readonly sourceKind: "user_fork";
      readonly initialInputText: null;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "fork";
      readonly forkChildIdentity: "application_reserved" | "provider_assigned";
      readonly forkCreationRecovery:
        "idempotent" | "exactly_reconcilable" | "potentially_unknown";
      readonly sourceKind: "agent_control";
      readonly initiatingAgentThreadId: string;
      readonly initialInputText: null;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    }
  | {
      readonly attemptId: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly creationKind: "fork";
      readonly forkChildIdentity: "application_reserved" | "provider_assigned";
      readonly forkCreationRecovery:
        "idempotent" | "exactly_reconcilable" | "potentially_unknown";
      readonly sourceKind: "principal_client";
      readonly initiatingToolClientId: string;
      readonly initialInputText: null;
      readonly initialAttachmentIds: readonly [];
      readonly backendCreationCorrelation: string;
      readonly now: number;
    };

const phaseTransitions: Readonly<
  Record<CreationAttemptPhase, readonly CreationAttemptPhase[]>
> = {
  prepared: ["external_call_started", "aborted_unpersisted"],
  external_call_started: [
    "conversation_identified",
    "aborted_unpersisted",
    "recovery_required",
  ],
  conversation_identified: [
    "first_submission_started",
    "aborted_unpersisted",
    "recovery_required",
  ],
  first_submission_started: [
    "accepted_unpersisted",
    "aborted_unpersisted",
    "recovery_required",
  ],
  accepted_unpersisted: ["recovery_required"],
  recovery_required: [
    "conversation_identified",
    "accepted_unpersisted",
    "aborted_unpersisted",
  ],
  bound: [],
  aborted_unpersisted: [],
};

const ABORTED_FIRST_SEND_CALLBACK_REASON =
  "The target send aborted before authoritative acceptance.";

function abortedFirstSendCallbackMutationId(callbackId: string): string {
  return `${callbackId}:target_send_aborted`;
}

export class ConversationCreationRepository {
  readonly #attachments: ComposerAttachmentRepository;
  readonly #callbacks: ThreadCompletionCallbackRepository;

  constructor(readonly database: Database.Database) {
    this.#attachments = new ComposerAttachmentRepository(database);
    this.#callbacks = new ThreadCompletionCallbackRepository(database);
  }

  prepare(
    scope: RequestScope,
    applicationThreadId: string,
    input: PrepareCreationAttemptInput,
  ): ConversationCreationAttemptRecord {
    if (
      input.creationKind === "first_input" &&
      !hasDeliverableComposerInput({
        text: input.initialInputText,
        selectedSkillId:
          input.sourceKind === "composer" ? input.initialSkillId : undefined,
        contextExcerpts:
          input.sourceKind === "composer" ? input.initialContextExcerpts : [],
        attachments: input.initialAttachmentIds,
        taskReferences:
          input.sourceKind === "composer" ? input.initialTaskReferences : [],
      })
    ) {
      throw new DomainError("invalid_transition", "Initial input is empty.");
    }
    return this.database.transaction(() => {
      const requestedCallback =
        input.creationKind === "first_input" &&
        input.sourceKind === "agent_control"
          ? input.completionCallback
          : undefined;
      const replay = this.findByMutationId(scope, input.mutationId);
      if (replay) {
        const completionCallback = this.#callbacks.findForTargetOperation(
          scope,
          applicationThreadId,
          input.mutationId,
        );
        if (
          replay.applicationThreadId !== applicationThreadId ||
          replay.attemptId !== input.attemptId ||
          replay.creationKind !== input.creationKind ||
          replay.forkChildIdentity !==
            (input.creationKind === "fork" ? input.forkChildIdentity : null) ||
          replay.forkCreationRecovery !==
            (input.creationKind === "fork"
              ? input.forkCreationRecovery
              : null) ||
          replay.sourceKind !== input.sourceKind ||
          replay.sourceAutomationId !==
            (input.sourceKind === "automation"
              ? input.sourceAutomationId
              : null) ||
          replay.sourceAutomationRunId !==
            (input.sourceKind === "automation"
              ? input.sourceAutomationRunId
              : null) ||
          replay.initiatingAgentThreadId !==
            (input.sourceKind === "agent_control"
              ? input.initiatingAgentThreadId
              : null) ||
          replay.initiatingToolClientId !==
            (input.sourceKind === "principal_client"
              ? input.initiatingToolClientId
              : null) ||
          replay.initialInputText !== input.initialInputText ||
          replay.initialSkillId !==
            (input.sourceKind === "composer"
              ? (input.initialSkillId ?? null)
              : null) ||
          !sameContextExcerpts(
            replay.initialContextExcerpts,
            input.sourceKind === "composer" ? input.initialContextExcerpts : [],
          ) ||
          replay.initialAttachments.map(({ id }) => id).join("\0") !==
            input.initialAttachmentIds.join("\0") ||
          replay.initialTaskContexts.map(({ id }) => id).join("\0") !==
            (input.sourceKind === "composer"
              ? input.initialTaskReferences
                  .map(({ taskId }) => taskId)
                  .join("\0")
              : "") ||
          replay.consumedDraftRevision !==
            (input.sourceKind === "composer"
              ? input.expectedDraftRevision + 1
              : null) ||
          replay.backendCreationCorrelation !==
            input.backendCreationCorrelation ||
          (completionCallback?.callerThreadId ?? null) !==
            (requestedCallback?.callerThreadId ?? null) ||
          (requestedCallback !== undefined &&
            completionCallback?.id !== requestedCallback.id)
        ) {
          throw new DomainError(
            "conflict",
            "The creation mutation ID was reused with different input.",
          );
        }
        return replay;
      }

      const target = this.#getThreadTarget(scope, applicationThreadId);
      if (
        target.backingState !== "unbound" ||
        target.revision !== input.expectedThreadRevision
      ) {
        throw new DomainError(
          "invalid_transition",
          "The thread is no longer an unchanged unbound draft.",
        );
      }
      let initialTaskContexts: MaterializedTaskContext[] = [];
      if (input.sourceKind === "composer") {
        initialTaskContexts = materializeTaskReferences(
          this.database,
          scope,
          input.initialTaskReferences,
        );
        assertMaterializedComposerBytes({
          text: input.initialInputText,
          contextExcerpts: input.initialContextExcerpts,
          taskContexts: initialTaskContexts,
        });
        const draftAttachmentIds = this.#attachments
          .descriptorsForOwner(scope, {
            kind: "draft",
            threadId: applicationThreadId,
          })
          .map(({ id }) => id);
        if (
          draftAttachmentIds.join("\0") !==
            input.initialAttachmentIds.join("\0") ||
          (
            this.database
              .prepare(
                `SELECT task_references_json AS taskReferencesJson
                 FROM thread_drafts
                 WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
              )
              .get(scope.tenantId, scope.principalId, applicationThreadId) as
              { readonly taskReferencesJson: string } | undefined
          )?.taskReferencesJson !==
            serializeTaskReferences(input.initialTaskReferences)
        ) {
          throw new DomainError(
            "draft_revision_conflict",
            "The draft attachments changed while creation was being prepared.",
          );
        }
        this.#attachments.replaceOwnerLinks(
          scope,
          {
            kind: "creation",
            threadId: applicationThreadId,
            attemptId: input.attemptId,
          },
          input.initialAttachmentIds,
        );
        this.#attachments.replaceOwnerLinks(
          scope,
          { kind: "draft", threadId: applicationThreadId },
          [],
        );
        const consumed = this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = '', selected_skill_id = NULL,
                context_excerpts_json = '[]', task_references_json = '[]',
                updated_at = ?,
                revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND revision = ? AND text = ?
                AND selected_skill_id IS ?
                AND context_excerpts_json = ?
                AND task_references_json = ?
            `,
          )
          .run(
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.expectedDraftRevision,
            input.initialInputText,
            input.initialSkillId ?? null,
            serializeContextExcerpts(input.initialContextExcerpts),
            serializeTaskReferences(input.initialTaskReferences),
          );
        if (consumed.changes !== 1) {
          throw new DomainError(
            "draft_revision_conflict",
            "The draft changed while creation was being prepared.",
          );
        }
      }

      this.database
        .prepare(
          `
            INSERT INTO conversation_creation_attempts(
              tenant_id, owner_principal_id, application_thread_id,
              attempt_id, mutation_id, backend_instance_id,
              connection_profile_id, execution_environment_id, creation_kind,
              fork_child_identity, fork_creation_recovery,
              source_kind, source_automation_id, source_automation_run_id,
              initiating_agent_thread_id, initiating_tool_client_id,
              initial_input_text, initial_skill_id, consumed_draft_revision,
              initial_context_excerpts_json, initial_task_contexts_json,
              backend_creation_correlation,
              phase, prepared_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
          input.mutationId,
          target.backendInstanceId,
          target.connectionProfileId,
          target.executionEnvironmentId,
          input.creationKind,
          input.creationKind === "fork" ? input.forkChildIdentity : null,
          input.creationKind === "fork" ? input.forkCreationRecovery : null,
          input.sourceKind,
          input.sourceKind === "automation" ? input.sourceAutomationId : null,
          input.sourceKind === "automation"
            ? input.sourceAutomationRunId
            : null,
          input.sourceKind === "agent_control"
            ? input.initiatingAgentThreadId
            : null,
          input.sourceKind === "principal_client"
            ? input.initiatingToolClientId
            : null,
          input.initialInputText,
          input.sourceKind === "composer"
            ? (input.initialSkillId ?? null)
            : null,
          input.sourceKind === "composer"
            ? input.expectedDraftRevision + 1
            : null,
          serializeContextExcerpts(
            input.sourceKind === "composer" ? input.initialContextExcerpts : [],
          ),
          serializeTaskContexts(initialTaskContexts),
          input.backendCreationCorrelation,
          input.now,
        );
      const changed = this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = 'creating', revision = revision + 1,
              updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'unbound' AND revision = ?
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The thread changed while creation was being prepared.",
        );
      }
      if (requestedCallback !== undefined) {
        this.#callbacks.register(scope, {
          id: requestedCallback.id,
          callerThreadId: requestedCallback.callerThreadId,
          targetThreadId: applicationThreadId,
          targetOperationId: input.mutationId,
          registeredAt: input.now,
        });
      }
      return this.get(scope, applicationThreadId, input.attemptId);
    })();
  }

  get(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): ConversationCreationAttemptRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND attempt_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
      ) as ConversationCreationAttemptRow | undefined;
    if (!row) {
      throw new DomainError("not_found", "The creation attempt was not found.");
    }
    return this.#hydrate(scope, row);
  }

  findByMutationId(
    scope: RequestScope,
    mutationId: string,
  ): ConversationCreationAttemptRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      ConversationCreationAttemptRow | undefined;
    return row ? this.#hydrate(scope, row) : undefined;
  }

  findActiveForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): ConversationCreationAttemptRecord | undefined {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
            AND force_reset_at IS NULL
            AND phase NOT IN ('bound', 'aborted_unpersisted')
          ORDER BY prepared_at DESC, attempt_id
          LIMIT 2
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      ) as ConversationCreationAttemptRow[];
    if (rows.length > 1) {
      throw new DomainError(
        "conflict",
        "The thread has more than one active creation attempt.",
      );
    }
    return rows[0] ? this.#hydrate(scope, rows[0]) : undefined;
  }

  listActiveForks(
    scope: RequestScope,
    limit = 256,
    after?: {
      readonly preparedAt: number;
      readonly attemptId: string;
      readonly applicationThreadId: string;
    },
  ): readonly ConversationCreationAttemptRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError("conversation_creation_recovery_limit_invalid");
    }
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND creation_kind = 'fork'
            AND force_reset_at IS NULL
            AND phase NOT IN ('bound', 'aborted_unpersisted')
            AND (
              ? IS NULL OR prepared_at > ?
              OR (prepared_at = ? AND attempt_id > ?)
              OR (prepared_at = ? AND attempt_id = ?
                AND application_thread_id > ?)
            )
          ORDER BY prepared_at, attempt_id, application_thread_id
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        after?.preparedAt ?? null,
        after?.preparedAt ?? null,
        after?.preparedAt ?? null,
        after?.attemptId ?? null,
        after?.preparedAt ?? null,
        after?.attemptId ?? null,
        after?.applicationThreadId ?? null,
        limit,
      ) as ConversationCreationAttemptRow[];
    return rows.map((row) => this.#hydrate(scope, row));
  }

  markExternalCallStarted(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    now: number,
  ): ConversationCreationAttemptRecord {
    return this.#transition(scope, applicationThreadId, attemptId, {
      expected: "prepared",
      next: "external_call_started",
      now,
      externalCallStartedAt: now,
    });
  }

  recordConversationIdentified(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expected?: "external_call_started" | "recovery_required";
      readonly backendConversationId: string;
      readonly opaqueBindingDetail: string;
      readonly reconciliationToken?: string;
      /** Only authoritative provider evidence may resolve a durable fork_unknown. */
      readonly clearForkUncertainty?: boolean;
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    return this.#transition(scope, applicationThreadId, attemptId, {
      expected: input.expected ?? "external_call_started",
      next: "conversation_identified",
      provisionalBackendConversationId: input.backendConversationId,
      provisionalOpaqueBindingDetail: input.opaqueBindingDetail,
      reconciliationToken: input.reconciliationToken ?? null,
      clearForkUncertainty: input.clearForkUncertainty,
      now: input.now,
    });
  }

  markFirstSubmissionStarted(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly reconciliationToken: string;
      readonly retryAnchor: string;
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    return this.#transition(scope, applicationThreadId, attemptId, {
      expected: "conversation_identified",
      next: "first_submission_started",
      reconciliationToken: input.reconciliationToken,
      retryAnchor: input.retryAnchor,
      replaceReconciliationToken: true,
      now: input.now,
    });
  }

  markAcceptedUnpersisted(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expected: "first_submission_started" | "recovery_required";
      readonly acceptedAt: number;
      readonly reconciliationToken?: string;
      readonly backendCorrelation?: string;
      readonly completionIdentity?: string;
    },
  ): ConversationCreationAttemptRecord {
    return this.database.transaction(() => {
      const accepted = this.#transition(scope, applicationThreadId, attemptId, {
        expected: input.expected,
        next: "accepted_unpersisted",
        acceptedAt: input.acceptedAt,
        reconciliationToken: input.reconciliationToken,
        backendCorrelation: input.backendCorrelation,
        completionIdentity: input.completionIdentity,
        now: input.acceptedAt,
      });
      if (accepted.creationKind === "first_input") {
        activateSettledThreadForAcceptedInput(
          this.database,
          scope,
          applicationThreadId,
          input.acceptedAt,
        );
      }
      return accepted;
    })();
  }

  authorizeRetry(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expectedRetryMutationId: string | null;
      readonly now: number;
      readonly diagnostic: string;
    },
  ): ConversationCreationAttemptRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET retry_authorized_at = ?, retry_mutation_id = NULL,
              retry_started_at = NULL, retry_reconciliation_token = NULL,
              retry_anchor = NULL,
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND force_reset_at IS NULL
              AND phase = 'recovery_required'
              AND (
                (? IS NULL AND retry_mutation_id IS NULL)
                OR retry_mutation_id = ?
              )
          `,
        )
        .run(
          input.now,
          input.diagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          attemptId,
          input.expectedRetryMutationId,
          input.expectedRetryMutationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt cannot authorize this retry.",
        );
      }
      this.#touchRecoveryThread(scope, applicationThreadId, input.now);
      return this.get(scope, applicationThreadId, attemptId);
    })();
  }

  claimRetry(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly retryMutationId: string;
      readonly reconciliationToken: string;
      readonly retryAnchor: string;
      readonly now: number;
    },
  ): {
    readonly attempt: ConversationCreationAttemptRecord;
    readonly newlyClaimed: boolean;
  } {
    return this.database.transaction(() => {
      const current = this.get(scope, applicationThreadId, attemptId);
      if (current.retryMutationId !== null) {
        if (current.retryMutationId !== input.retryMutationId) {
          throw new DomainError(
            "conflict",
            "A different first-submission retry is already in flight.",
          );
        }
        return { attempt: current, newlyClaimed: false };
      }
      const changed = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET retry_authorized_at = NULL, retry_mutation_id = ?,
              retry_started_at = ?, retry_reconciliation_token = ?,
              retry_anchor = ?,
              diagnostic = 'An explicit first-submission retry is in flight.'
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND force_reset_at IS NULL
              AND phase = 'recovery_required'
              AND retry_authorized_at IS NOT NULL
              AND retry_mutation_id IS NULL
          `,
        )
        .run(
          input.retryMutationId,
          input.now,
          input.reconciliationToken,
          input.retryAnchor,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          attemptId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The retry is not durably authorized.",
        );
      }
      this.#touchRecoveryThread(scope, applicationThreadId, input.now);
      return {
        attempt: this.get(scope, applicationThreadId, attemptId),
        newlyClaimed: true,
      };
    })();
  }

  markRecoveryRequired(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expected:
        | "external_call_started"
        | "conversation_identified"
        | "first_submission_started"
        | "accepted_unpersisted";
      readonly reconciliationToken?: string;
      readonly provisionalBackendConversationId?: string;
      readonly provisionalOpaqueBindingDetail?: string;
      readonly diagnostic: string;
      readonly forkUncertaintyKind?: "fork_unknown";
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    return this.#transition(scope, applicationThreadId, attemptId, {
      expected: input.expected,
      next: "recovery_required",
      reconciliationToken: input.reconciliationToken,
      provisionalBackendConversationId: input.provisionalBackendConversationId,
      provisionalOpaqueBindingDetail: input.provisionalOpaqueBindingDetail,
      diagnostic: input.diagnostic,
      forkUncertaintyKind: input.forkUncertaintyKind,
      now: input.now,
    });
  }

  abortProvenUnpersisted(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expected:
        | "prepared"
        | "external_call_started"
        | "conversation_identified"
        | "first_submission_started"
        | "recovery_required";
      readonly diagnostic?: string;
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    return this.database.transaction(() => {
      const attempt = this.get(scope, applicationThreadId, attemptId);
      const aborted = this.#transition(scope, applicationThreadId, attemptId, {
        expected: input.expected,
        next: "aborted_unpersisted",
        diagnostic: input.diagnostic,
        reconciledAt: input.now,
        now: input.now,
      });
      this.#cancelAbortedFirstSendCallback(scope, attempt, input.now);
      if (
        attempt.creationKind === "first_input" &&
        attempt.sourceKind === "composer" &&
        attempt.initialInputText !== null &&
        attempt.consumedDraftRevision !== null
      ) {
        const restored = this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = ?, selected_skill_id = ?,
                context_excerpts_json = ?, task_references_json = ?,
                updated_at = ?,
                revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND text = '' AND selected_skill_id IS NULL
                AND context_excerpts_json = '[]' AND revision = ?
                AND task_references_json = '[]'
            `,
          )
          .run(
            attempt.initialInputText,
            attempt.initialSkillId,
            serializeContextExcerpts(attempt.initialContextExcerpts),
            serializeTaskReferences(
              taskReferencesFromContexts(attempt.initialTaskContexts),
            ),
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            attempt.consumedDraftRevision,
          );
        if (restored.changes === 1) {
          this.#attachments.replaceOwnerLinks(
            scope,
            { kind: "draft", threadId: applicationThreadId },
            attempt.initialAttachments.map(({ id }) => id),
          );
        }
      }
      return aborted;
    })();
  }

  ensureAbortedCompletionCallbackCancelled(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    now: number,
  ): ConversationCreationAttemptRecord {
    return this.database.transaction(() => {
      const attempt = this.get(scope, applicationThreadId, attemptId);
      if (attempt.phase !== "aborted_unpersisted") {
        throw new DomainError(
          "invalid_transition",
          "Only an aborted creation attempt can finalize callback cancellation.",
        );
      }
      this.#cancelAbortedFirstSendCallback(scope, attempt, now);
      return attempt;
    })();
  }

  refreshRecoveryRequired(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly reconciliationToken?: string;
      readonly diagnostic: string;
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET reconciliation_token =
                  coalesce(?, reconciliation_token),
              diagnostic = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND force_reset_at IS NULL
              AND phase = 'recovery_required'
          `,
        )
        .run(
          input.reconciliationToken ?? null,
          input.diagnostic,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          attemptId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt is not awaiting recovery.",
        );
      }
      const thread = this.database
        .prepare(
          `
            UPDATE application_threads
            SET revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'creation_unknown'
          `,
        )
        .run(input.now, scope.tenantId, scope.principalId, applicationThreadId);
      if (thread.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The thread is not awaiting creation recovery.",
        );
      }
      return this.get(scope, applicationThreadId, attemptId);
    })();
  }

  #cancelAbortedFirstSendCallback(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
    now: number,
  ): void {
    if (
      attempt.creationKind !== "first_input" ||
      attempt.sourceKind !== "agent_control"
    ) {
      return;
    }
    const callback = this.#callbacks.findForTargetOperation(
      scope,
      attempt.applicationThreadId,
      attempt.mutationId,
    );
    if (!callback) return;
    this.#callbacks.cancelRegistered(scope, callback.id, {
      cancelledAt: now,
      reason: ABORTED_FIRST_SEND_CALLBACK_REASON,
      cancellationMutationId: abortedFirstSendCallbackMutationId(callback.id),
    });
  }

  #transition(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly expected: CreationAttemptPhase;
      readonly next: CreationAttemptPhase;
      readonly now: number;
      readonly externalCallStartedAt?: number;
      readonly provisionalBackendConversationId?: string;
      readonly provisionalOpaqueBindingDetail?: string;
      readonly reconciliationToken?: string | null;
      readonly retryAnchor?: string;
      readonly diagnostic?: string;
      readonly acceptedAt?: number;
      readonly reconciledAt?: number;
      readonly replaceReconciliationToken?: boolean;
      readonly backendCorrelation?: string;
      readonly completionIdentity?: string;
      readonly forkUncertaintyKind?: "fork_unknown";
      readonly clearForkUncertainty?: boolean;
    },
  ): ConversationCreationAttemptRecord {
    if (!phaseTransitions[input.expected].includes(input.next)) {
      throw new DomainError(
        "invalid_transition",
        `Creation cannot transition from ${input.expected} to ${input.next}.`,
      );
    }
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET phase = ?,
              external_call_started_at =
                coalesce(?, external_call_started_at),
              provisional_backend_conversation_id =
                coalesce(?, provisional_backend_conversation_id),
              provisional_opaque_binding_detail =
                coalesce(?, provisional_opaque_binding_detail),
              reconciliation_token = CASE
                WHEN ? = 1 THEN ?
                ELSE coalesce(?, reconciliation_token)
              END,
              retry_anchor = CASE
                WHEN ? IN (
                  'accepted_unpersisted', 'bound', 'aborted_unpersisted',
                  'conversation_identified'
                ) THEN NULL
                ELSE coalesce(?, retry_anchor)
              END,
              backend_correlation = coalesce(?, backend_correlation),
              completion_identity = coalesce(?, completion_identity),
              diagnostic = coalesce(?, diagnostic),
              fork_uncertainty_kind = CASE
                WHEN ? = 1 THEN NULL
                ELSE coalesce(?, fork_uncertainty_kind)
              END,
              accepted_at = coalesce(?, accepted_at),
              reconciled_at = coalesce(?, reconciled_at),
              retry_authorized_at = CASE
                WHEN ? = 'recovery_required' THEN retry_authorized_at
                ELSE NULL
              END,
              retry_mutation_id = CASE
                WHEN ? = 'recovery_required' THEN retry_mutation_id
                ELSE NULL
              END,
              retry_started_at = CASE
                WHEN ? = 'recovery_required' THEN retry_started_at
                ELSE NULL
              END,
              retry_reconciliation_token = CASE
                WHEN ? = 'recovery_required' THEN retry_reconciliation_token
                ELSE NULL
              END
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ? AND phase = ?
              AND force_reset_at IS NULL
          `,
        )
        .run(
          input.next,
          input.externalCallStartedAt ?? null,
          input.provisionalBackendConversationId ?? null,
          input.provisionalOpaqueBindingDetail ?? null,
          input.replaceReconciliationToken ? 1 : 0,
          input.reconciliationToken ?? null,
          input.reconciliationToken ?? null,
          input.next,
          input.retryAnchor ?? null,
          input.backendCorrelation ?? null,
          input.completionIdentity ?? null,
          input.diagnostic ?? null,
          input.clearForkUncertainty ? 1 : 0,
          input.forkUncertaintyKind ?? null,
          input.acceptedAt ?? null,
          input.reconciledAt ?? null,
          input.next,
          input.next,
          input.next,
          input.next,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          attemptId,
          input.expected,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt is not in the expected phase.",
        );
      }
      const backingState =
        input.next === "aborted_unpersisted"
          ? "unbound"
          : input.next === "accepted_unpersisted" ||
              input.next === "recovery_required"
            ? "creation_unknown"
            : "creating";
      const thread = this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = ?, revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state IN ('creating', 'creation_unknown')
          `,
        )
        .run(
          backingState,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
        );
      if (thread.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The thread is not in a creation state.",
        );
      }
      return this.get(scope, applicationThreadId, attemptId);
    })();
  }

  #getThreadTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadTargetRow {
    const row = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId,
            backing_state AS backingState,
            revision
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadTargetRow | undefined;
    if (!row) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    return row;
  }

  #touchRecoveryThread(
    scope: RequestScope,
    applicationThreadId: string,
    now: number,
  ): void {
    const changed = this.database
      .prepare(
        `
          UPDATE application_threads
          SET revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND backing_state = 'creation_unknown'
        `,
      )
      .run(now, scope.tenantId, scope.principalId, applicationThreadId);
    if (changed.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "The thread is not awaiting creation recovery.",
      );
    }
  }

  #hydrate(
    scope: RequestScope,
    row: ConversationCreationAttemptRow,
  ): ConversationCreationAttemptRecord {
    return hydrateAttempt(
      row,
      this.#attachments.descriptorsForOwner(scope, {
        kind: "creation",
        threadId: row.applicationThreadId,
        attemptId: row.attemptId,
      }),
    );
  }
}
