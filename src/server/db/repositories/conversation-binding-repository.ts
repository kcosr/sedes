import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type ConversationTarget = {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly workspaceId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
};

export type ConversationBindingRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly createdAt: number;
};

export type ConversationThreadDefinition = ConversationTarget & {
  readonly id: string;
  readonly title: string;
};

type MutationReceipt = {
  readonly threadId: string;
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

export type ThreadConfigurationCopyReceipt = {
  readonly applicationThreadId: string;
  readonly workspaceId: string;
  readonly targetId: string;
};

function moveDraftFingerprint(
  applicationThreadId: string,
  input: {
    readonly workspaceId: string;
    readonly expectedThreadRevision: number;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "move_draft",
        applicationThreadId,
        input.workspaceId,
        input.expectedThreadRevision,
      ]),
    )
    .digest("hex");
}

function threadConfigurationCopyFingerprint(input: {
  readonly sourceApplicationThreadId: string;
  readonly title: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "thread_configuration_copy",
        input.sourceApplicationThreadId,
        input.title,
      ]),
    )
    .digest("hex");
}

const bindingColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  backend_instance_id AS backendInstanceId,
  connection_profile_id AS connectionProfileId,
  execution_environment_id AS executionEnvironmentId,
  backend_conversation_id AS backendConversationId,
  created_at AS createdAt
`;

export class ConversationBindingRepository {
  constructor(readonly database: Database.Database) {}

  createUnboundThread(
    scope: RequestScope,
    input: {
      readonly id?: string;
      readonly workspaceId: string;
      readonly connectionProfileId: string;
      readonly title: string;
      readonly initialText?: string;
      readonly now: number;
    },
  ): { readonly id: string; readonly target: ConversationTarget } {
    return this.database.transaction(() => {
      const profile = this.database
        .prepare(
          `
            SELECT profile.backend_instance_id AS backendInstanceId,
              profile.execution_environment_id AS executionEnvironmentId
            FROM agent_connection_profiles AS profile
            JOIN agent_backend_instances AS backend
              ON backend.tenant_id = profile.tenant_id
              AND backend.id = profile.backend_instance_id
            WHERE profile.tenant_id = ? AND profile.owner_principal_id = ?
              AND profile.id = ? AND profile.enabled = 1
              AND backend.enabled = 1
          `,
        )
        .get(scope.tenantId, scope.principalId, input.connectionProfileId) as
        | {
            backendInstanceId: string;
            executionEnvironmentId: string;
          }
        | undefined;
      if (!profile) {
        throw new DomainError(
          "not_found",
          "The enabled connection profile was not found.",
        );
      }
      const workspace = this.database
        .prepare(
          `
            SELECT 1
            FROM workspaces
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND environment_id = ? AND id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          profile.executionEnvironmentId,
          input.workspaceId,
        );
      if (!workspace) {
        throw new DomainError(
          "not_found",
          "The workspace is not available in the target environment.",
        );
      }
      const id = input.id ?? randomUUID();
      this.database
        .prepare(
          `
            INSERT INTO application_threads(
              tenant_id, id, owner_principal_id, environment_id, workspace_id,
              backend_instance_id, connection_profile_id, backing_state,
              title, availability, last_activity_at, revision, created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'unbound', ?, 'available', ?, 0, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          id,
          scope.principalId,
          profile.executionEnvironmentId,
          input.workspaceId,
          profile.backendInstanceId,
          input.connectionProfileId,
          input.title,
          input.now,
          input.now,
          input.now,
        );
      this.database
        .prepare(
          `
            INSERT INTO thread_principal_state(
              tenant_id, principal_id, thread_id, inventory_state,
              state_changed_at, inventory_revision
            )
            VALUES (?, ?, ?, 'active', ?, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId, id, input.now);
      this.database
        .prepare(
          `
            INSERT INTO thread_drafts(
              tenant_id, principal_id, thread_id, text, updated_at, revision
            )
            VALUES (?, ?, ?, ?, ?, 0)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          input.initialText ?? "",
          input.now,
        );
      return { id, target: this.getTarget(scope, id) };
    })();
  }

  findThreadConfigurationCopyReceipt(
    scope: RequestScope,
    input: {
      readonly sourceApplicationThreadId: string;
      readonly title: string;
      readonly mutationId: string;
    },
  ): ThreadConfigurationCopyReceipt | undefined {
    const receipt = this.#mutationReceipt(scope, input.mutationId);
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== "thread_configuration_copy" ||
      receipt.requestFingerprint !== threadConfigurationCopyFingerprint(input)
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
    let rawResult: unknown;
    try {
      rawResult = JSON.parse(receipt.resultJson);
    } catch {
      throw new Error("thread_configuration_copy_receipt_result_invalid");
    }
    if (
      typeof rawResult !== "object" ||
      rawResult === null ||
      !("threadId" in rawResult) ||
      rawResult.threadId !== receipt.threadId ||
      !("workspaceId" in rawResult) ||
      typeof rawResult.workspaceId !== "string" ||
      !("targetId" in rawResult) ||
      typeof rawResult.targetId !== "string"
    ) {
      throw new Error("thread_configuration_copy_receipt_result_invalid");
    }
    return {
      applicationThreadId: receipt.threadId,
      workspaceId: rawResult.workspaceId,
      targetId: rawResult.targetId,
    };
  }

  recordThreadConfigurationCopyReceipt(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly sourceApplicationThreadId: string;
      readonly workspaceId: string;
      readonly targetId: string;
      readonly title: string;
      readonly mutationId: string;
      readonly now: number;
    },
  ): void {
    if (!this.database.inTransaction) {
      throw new Error("thread_configuration_copy_receipt_outside_transaction");
    }
    this.database
      .prepare(
        `
          INSERT INTO mutation_receipts(
            tenant_id, principal_id, thread_id, mutation_id, operation_kind,
            request_fingerprint, result_code, result_json, replayable,
            created_at
          )
          VALUES (?, ?, ?, ?, 'thread_configuration_copy', ?, 'completed', ?, 1, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.mutationId,
        threadConfigurationCopyFingerprint(input),
        JSON.stringify({
          threadId: applicationThreadId,
          workspaceId: input.workspaceId,
          targetId: input.targetId,
        }),
        input.now,
      );
  }

  moveUnboundThreadWorkspace(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly workspaceId: string;
      readonly expectedThreadRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): ConversationTarget {
    const requestFingerprint = moveDraftFingerprint(applicationThreadId, input);
    return this.database.transaction(() => {
      const receipt = this.#mutationReceipt(scope, input.mutationId);
      if (receipt) {
        if (
          receipt.threadId !== applicationThreadId ||
          receipt.operationKind !== "move_draft" ||
          receipt.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID was reused for a different operation.",
          );
        }
        return this.getTarget(scope, applicationThreadId);
      }
      const current = this.getTarget(scope, applicationThreadId);
      if (current.backingState !== "unbound") {
        throw new DomainError(
          "invalid_transition",
          "Only an unbound draft thread can change workspaces.",
        );
      }
      const workspace = this.database
        .prepare(
          `
            SELECT availability
            FROM workspaces
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND environment_id = ? AND id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          current.executionEnvironmentId,
          input.workspaceId,
        ) as { readonly availability: string } | undefined;
      if (!workspace || workspace.availability !== "available") {
        throw new DomainError(
          "invalid_transition",
          "The destination workspace is unavailable in this execution environment.",
        );
      }
      if (current.workspaceId !== input.workspaceId) {
        const workspaceBoundContext = this.database
          .prepare(
            `
              SELECT EXISTS (
                SELECT 1
                FROM thread_drafts
                WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                  AND json_array_length(context_excerpts_json) > 0
                UNION ALL
                SELECT 1
                FROM prompt_stashes
                WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                  AND json_array_length(context_excerpts_json) > 0
              ) AS present
            `,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
          ) as { readonly present: 0 | 1 };
        if (workspaceBoundContext.present === 1) {
          throw new DomainError(
            "invalid_transition",
            "Remove this draft's context excerpts and context-bearing stashes before changing workspaces.",
          );
        }
        const changed = this.database
          .prepare(
            `
              UPDATE application_threads
              SET workspace_id = ?, revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND backing_state = 'unbound' AND revision = ?
            `,
          )
          .run(
            input.workspaceId,
            input.now,
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.expectedThreadRevision,
          );
        if (changed.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The thread changed in another client.",
          );
        }
        this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET preferred_worktree_root_id = NULL,
                preferred_worktree_revision = preferred_worktree_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND preferred_worktree_root_id IS NOT NULL
            `,
          )
          .run(scope.tenantId, scope.principalId, applicationThreadId);
        this.#bumpGeneration(scope);
      } else {
        const definition = this.findThreadDefinition(
          scope,
          applicationThreadId,
        );
        if (!definition || definition.backingState !== "unbound") {
          throw new DomainError(
            "invalid_transition",
            "Only an unbound draft thread can change workspaces.",
          );
        }
        const revision = this.database
          .prepare(
            `
              SELECT revision
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) as {
          readonly revision: number;
        };
        if (revision.revision !== input.expectedThreadRevision) {
          throw new DomainError(
            "conflict",
            "The thread changed in another client.",
          );
        }
      }
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id, operation_kind,
              request_fingerprint, result_code, result_json, replayable,
              created_at
            )
            VALUES (?, ?, ?, ?, 'move_draft', ?, 'completed', ?, 1, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.mutationId,
          requestFingerprint,
          JSON.stringify({ workspaceId: input.workspaceId }),
          input.now,
        );
      return this.getTarget(scope, applicationThreadId);
    })();
  }

  isUnboundThreadWorkspaceMoveReplay(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly workspaceId: string;
      readonly expectedThreadRevision: number;
      readonly mutationId: string;
    },
  ): boolean {
    const receipt = this.#mutationReceipt(scope, input.mutationId);
    if (!receipt) return false;
    if (
      receipt.threadId !== applicationThreadId ||
      receipt.operationKind !== "move_draft" ||
      receipt.requestFingerprint !==
        moveDraftFingerprint(applicationThreadId, input)
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
    return true;
  }

  getTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): ConversationTarget {
    const row = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId,
            workspace_id AS workspaceId,
            backing_state AS backingState
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ConversationTarget | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row;
  }

  getWorkspaceCanonicalPath(
    scope: RequestScope,
    workspaceId: string,
    executionEnvironmentId: string,
  ): string {
    const row = this.database
      .prepare(
        `
          SELECT canonical_path AS canonicalPath
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND environment_id = ? AND id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        executionEnvironmentId,
        workspaceId,
      ) as { canonicalPath: string } | undefined;
    if (!row) {
      throw new DomainError("not_found", "The workspace was not found.");
    }
    return row.canonicalPath;
  }

  findThreadDefinition(
    scope: RequestScope,
    applicationThreadId: string,
  ): ConversationThreadDefinition | undefined {
    return this.database
      .prepare(
        `
          SELECT id, title, backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId,
            workspace_id AS workspaceId, backing_state AS backingState
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ConversationThreadDefinition | undefined;
  }

  getBinding(
    scope: RequestScope,
    applicationThreadId: string,
  ): ConversationBindingRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${bindingColumns}
          FROM conversation_bindings
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ConversationBindingRecord | undefined;
  }

  findByBackendConversation(
    scope: RequestScope,
    backendInstanceId: string,
    backendConversationId: string,
  ): ConversationBindingRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${bindingColumns}
          FROM conversation_bindings
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND backend_instance_id = ? AND backend_conversation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        backendInstanceId,
        backendConversationId,
      ) as ConversationBindingRecord | undefined;
  }

  /**
   * Provider-assigned create binds the native identity after `thread/start`
   * and before the first submission. The durable binding is intentionally not
   * general mutation readiness: the thread remains `creating` until first-send
   * acceptance completes the creation attempt.
   */
  bindProviderAssignedConversation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId: string;
      readonly backendConversationId: string;
      readonly boundAt: number;
    },
  ): ConversationBindingRecord {
    return this.database.transaction(() => {
      const target = this.getTarget(scope, applicationThreadId);
      const existing = this.getBinding(scope, applicationThreadId);
      if (existing) {
        if (existing.backendConversationId !== input.backendConversationId) {
          throw new DomainError(
            "conflict",
            "The thread is already bound to a different conversation.",
          );
        }
        return existing;
      }
      if (target.backingState !== "creating") {
        throw new DomainError(
          "invalid_transition",
          "Only a thread being created can bind a provider-assigned identity.",
        );
      }
      const attempt = this.database
        .prepare(
          `
            SELECT phase, creation_kind AS creationKind,
              provisional_backend_conversation_id AS provisionalId
            FROM conversation_creation_attempts
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
        ) as
        | {
            phase: string;
            creationKind: "first_input" | "fork";
            provisionalId: string | null;
          }
        | undefined;
      if (
        !attempt ||
        attempt.creationKind !== "first_input" ||
        attempt.phase !== "conversation_identified" ||
        attempt.provisionalId !== input.backendConversationId
      ) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt cannot bind this provider identity yet.",
        );
      }
      try {
        this.#insertBindingRow(scope, applicationThreadId, target, {
          backendConversationId: input.backendConversationId,
          acceptedAt: input.boundAt,
        });
      } catch (error) {
        if (sqliteConstraint(error)) {
          throw new DomainError(
            "conflict",
            "The backend conversation is already owned.",
            false,
            { cause: error },
          );
        }
        throw error;
      }
      return this.getBinding(scope, applicationThreadId)!;
    })();
  }

  /**
   * Completes a first-send attempt after the provider identity was already
   * bound before the first submission.
   */
  completeProviderAssignedFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId: string;
      readonly backendConversationId: string;
      readonly acceptedAt: number;
    },
  ): ConversationBindingRecord {
    return this.database.transaction(() => {
      const binding = this.getBinding(scope, applicationThreadId);
      if (
        !binding ||
        binding.backendConversationId !== input.backendConversationId
      ) {
        throw new DomainError(
          "conflict",
          "The provider-assigned binding does not match this attempt.",
        );
      }
      const attempt = this.database
        .prepare(
          `
            SELECT phase, provisional_backend_conversation_id AS provisionalId,
              accepted_at AS acceptedAt
            FROM conversation_creation_attempts
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
        ) as
        | {
            phase: string;
            provisionalId: string | null;
            acceptedAt: number | null;
          }
        | undefined;
      if (!attempt || attempt.provisionalId !== input.backendConversationId) {
        throw new DomainError(
          "conflict",
          "The completed creation binding does not match this attempt.",
        );
      }
      if (attempt.phase === "bound") {
        return binding;
      }
      if (attempt.phase !== "accepted_unpersisted") {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt cannot complete first-send acceptance.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET phase = 'bound',
              accepted_at = coalesce(accepted_at, ?),
              reconciled_at = ?,
              retry_anchor = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND phase = 'accepted_unpersisted'
              AND provisional_backend_conversation_id = ?
          `,
        )
        .run(
          input.acceptedAt,
          input.acceptedAt,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
          input.backendConversationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt changed while completing first-send acceptance.",
        );
      }
      this.#markThreadBound(scope, applicationThreadId, {
        now: input.acceptedAt,
        lastActivityAt: input.acceptedAt,
      });
      return binding;
    })();
  }

  bindCreatedConversation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId: string;
      readonly backendConversationId: string;
      readonly acceptedAt: number;
    },
  ): ConversationBindingRecord {
    return this.database.transaction(() => {
      const target = this.getTarget(scope, applicationThreadId);
      const replay = this.getBinding(scope, applicationThreadId);
      if (replay) {
        const attempt = this.database
          .prepare(
            `
              SELECT phase, creation_kind AS creationKind,
                mutation_id AS mutationId,
                source_kind AS sourceKind,
                initiating_agent_thread_id AS initiatingAgentThreadId,
                initiating_tool_client_id AS initiatingToolClientId,
                source_automation_id AS sourceAutomationId,
                source_automation_run_id AS sourceAutomationRunId,
                provisional_backend_conversation_id AS provisionalId,
                accepted_at AS acceptedAt
              FROM conversation_creation_attempts
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ? AND attempt_id = ?
            `,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            input.attemptId,
          ) as
          | {
              phase: string;
              creationKind: "first_input" | "fork";
              mutationId: string;
              sourceKind:
                | "composer"
                | "automation"
                | "user_fork"
                | "agent_control"
                | "principal_client";
              initiatingAgentThreadId: string | null;
              initiatingToolClientId: string | null;
              sourceAutomationId: string | null;
              sourceAutomationRunId: string | null;
              provisionalId: string | null;
              acceptedAt: number | null;
            }
          | undefined;
        const mismatch =
          replay.backendConversationId !== input.backendConversationId ||
          !attempt ||
          attempt.provisionalId !== input.backendConversationId ||
          attempt.acceptedAt !== input.acceptedAt;
        if (mismatch) {
          throw new DomainError(
            "conflict",
            "The completed creation binding does not match this attempt.",
          );
        }
        if (attempt.phase === "accepted_unpersisted") {
          if (attempt.creationKind === "fork") {
            this.#assertPreparedForkOrigin(
              scope,
              applicationThreadId,
              attempt.mutationId,
              attempt,
            );
          }
          const changed = this.database
            .prepare(
              `
                UPDATE conversation_creation_attempts
                SET phase = 'bound', reconciled_at = ?, retry_anchor = NULL
                WHERE tenant_id = ? AND owner_principal_id = ?
                  AND application_thread_id = ? AND attempt_id = ?
                  AND phase = 'accepted_unpersisted'
                  AND accepted_at = ?
                  AND provisional_backend_conversation_id = ?
              `,
            )
            .run(
              input.acceptedAt,
              scope.tenantId,
              scope.principalId,
              applicationThreadId,
              input.attemptId,
              input.acceptedAt,
              input.backendConversationId,
            );
          if (changed.changes !== 1) {
            throw new DomainError(
              "invalid_transition",
              "The migrated creation attempt changed while binding.",
            );
          }
          this.#markThreadBound(scope, applicationThreadId, {
            now: input.acceptedAt,
            lastActivityAt: input.acceptedAt,
          });
          if (attempt.creationKind === "fork") {
            this.#commitPreparedForkOrigin(
              scope,
              applicationThreadId,
              attempt.mutationId,
              input.acceptedAt,
            );
          }
          return replay;
        }
        if (attempt.phase !== "bound") {
          throw new DomainError(
            "conflict",
            "The completed creation binding does not match this attempt.",
          );
        }
        if (attempt.creationKind === "fork") {
          this.#assertCommittedForkOrigin(
            scope,
            applicationThreadId,
            attempt.mutationId,
            attempt,
          );
        }
        return replay;
      }
      if (
        target.backingState !== "creating" &&
        target.backingState !== "creation_unknown"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only a thread being created can complete this binding.",
        );
      }
      const attempt = this.database
        .prepare(
          `
            SELECT phase, creation_kind AS creationKind,
              mutation_id AS mutationId,
              source_kind AS sourceKind,
              initiating_agent_thread_id AS initiatingAgentThreadId,
              initiating_tool_client_id AS initiatingToolClientId,
              source_automation_id AS sourceAutomationId,
              source_automation_run_id AS sourceAutomationRunId,
              provisional_backend_conversation_id AS provisionalId
            FROM conversation_creation_attempts
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
        ) as
        | {
            phase: string;
            creationKind: "first_input" | "fork";
            mutationId: string;
            sourceKind:
              | "composer"
              | "automation"
              | "user_fork"
              | "agent_control"
              | "principal_client";
            initiatingAgentThreadId: string | null;
            initiatingToolClientId: string | null;
            sourceAutomationId: string | null;
            sourceAutomationRunId: string | null;
            provisionalId: string | null;
          }
        | undefined;
      if (
        !attempt ||
        !(
          (attempt.creationKind === "fork" &&
            [
              "conversation_identified",
              "accepted_unpersisted",
              "recovery_required",
            ].includes(attempt.phase)) ||
          (attempt.creationKind === "first_input" &&
            attempt.phase === "accepted_unpersisted")
        ) ||
        (attempt.provisionalId !== null &&
          attempt.provisionalId !== input.backendConversationId)
      ) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt cannot be bound to this conversation.",
        );
      }
      if (attempt.creationKind === "fork") {
        this.#assertPreparedForkOrigin(
          scope,
          applicationThreadId,
          attempt.mutationId,
          attempt,
        );
      }

      try {
        this.#insertBindingRow(scope, applicationThreadId, target, input);
      } catch (error) {
        if (sqliteConstraint(error)) {
          throw new DomainError(
            "conflict",
            "The backend conversation is already owned.",
            false,
            { cause: error },
          );
        }
        throw error;
      }
      const attemptChanged = this.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET phase = 'bound',
              provisional_backend_conversation_id =
                coalesce(provisional_backend_conversation_id, ?),
              accepted_at = coalesce(accepted_at, ?),
              reconciled_at = ?,
              retry_anchor = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND phase IN (
                'conversation_identified', 'accepted_unpersisted',
                'recovery_required'
              )
          `,
        )
        .run(
          input.backendConversationId,
          input.acceptedAt,
          input.acceptedAt,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.attemptId,
        );
      if (attemptChanged.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The creation attempt changed while binding.",
        );
      }
      this.#markThreadBound(scope, applicationThreadId, {
        now: input.acceptedAt,
        lastActivityAt: input.acceptedAt,
      });
      if (attempt.creationKind === "fork") {
        this.#commitPreparedForkOrigin(
          scope,
          applicationThreadId,
          attempt.mutationId,
          input.acceptedAt,
        );
      }
      return this.getBinding(scope, applicationThreadId)!;
    })();
  }

  bindDiscoveredConversation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly backendConversationId: string;
      /**
       * Provider activity at import; direct fixture/adoption callers use
       * `now`.
       */
      readonly lastActivityAt?: number;
      readonly now: number;
    },
  ): ConversationBindingRecord {
    return this.database.transaction(() => {
      const target = this.getTarget(scope, applicationThreadId);
      const replay = this.getBinding(scope, applicationThreadId);
      if (replay) {
        if (replay.backendConversationId === input.backendConversationId) {
          return replay;
        }
        throw new DomainError(
          "conflict",
          "The thread is already bound to a different conversation.",
        );
      }
      if (target.backingState !== "unbound") {
        throw new DomainError(
          "invalid_transition",
          "Only an unbound thread can adopt a discovered conversation.",
        );
      }
      try {
        this.#insertBindingRow(scope, applicationThreadId, target, {
          backendConversationId: input.backendConversationId,
          acceptedAt: input.now,
        });
      } catch (error) {
        if (sqliteConstraint(error)) {
          throw new DomainError(
            "conflict",
            "The backend conversation is already owned.",
            false,
            { cause: error },
          );
        }
        throw error;
      }
      this.#markThreadBound(scope, applicationThreadId, {
        now: input.now,
        lastActivityAt: input.lastActivityAt ?? input.now,
      });
      return this.getBinding(scope, applicationThreadId)!;
    })();
  }

  #insertBindingRow(
    scope: RequestScope,
    applicationThreadId: string,
    target: ConversationTarget,
    input: {
      readonly backendConversationId: string;
      readonly acceptedAt: number;
    },
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO conversation_bindings(
            tenant_id, owner_principal_id, application_thread_id,
            backend_instance_id, connection_profile_id,
            execution_environment_id, backend_conversation_id, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        target.backendInstanceId,
        target.connectionProfileId,
        target.executionEnvironmentId,
        input.backendConversationId,
        input.acceptedAt,
      );
  }

  #markThreadBound(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly now: number;
      readonly lastActivityAt: number;
    },
  ): void {
    const changed = this.database
      .prepare(
        `
          UPDATE application_threads
          SET backing_state = 'bound', availability = 'available',
            reconciliation_at = ?, last_activity_at = ?,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND backing_state IN ('unbound', 'creating', 'creation_unknown')
        `,
      )
      .run(
        input.now,
        input.lastActivityAt,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "The thread changed while binding.",
      );
    }
  }

  #assertPreparedForkOrigin(
    scope: RequestScope,
    applicationThreadId: string,
    creationOperationId: string,
    source: {
      readonly sourceKind:
        | "composer"
        | "automation"
        | "user_fork"
        | "agent_control"
        | "principal_client";
      readonly initiatingAgentThreadId: string | null;
      readonly initiatingToolClientId: string | null;
      readonly sourceAutomationId: string | null;
      readonly sourceAutomationRunId: string | null;
    },
  ): void {
    const origin = this.database
      .prepare(
        `
          SELECT 1
          FROM thread_fork_origins
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND child_thread_id = ? AND creation_operation_id = ?
            AND origin_state = 'prepared' AND committed_at IS NULL
            AND initiating_principal_id = ?
            AND ((? = 'user_fork' AND origin_kind = 'user_fork'
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL)
              OR (? = 'automation' AND origin_kind = 'automation_fork'
                AND source_automation_id = ?
                AND source_automation_run_id = ?)
              OR (? = 'agent_control' AND origin_kind = 'agent_fork'
                AND initiating_agent_thread_id = ?
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL)
              OR (? = 'principal_client'
                AND origin_kind = 'principal_client_fork'
                AND initiating_tool_client_id = ?
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL))
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        creationOperationId,
        scope.principalId,
        source.sourceKind,
        source.sourceKind,
        source.sourceAutomationId,
        source.sourceAutomationRunId,
        source.sourceKind,
        source.initiatingAgentThreadId,
        source.sourceKind,
        source.initiatingToolClientId,
      );
    if (!origin) {
      throw new DomainError(
        "invalid_transition",
        "Fork provenance must be prepared before binding the child.",
      );
    }
  }

  #assertCommittedForkOrigin(
    scope: RequestScope,
    applicationThreadId: string,
    creationOperationId: string,
    source: {
      readonly sourceKind:
        | "composer"
        | "automation"
        | "user_fork"
        | "agent_control"
        | "principal_client";
      readonly initiatingAgentThreadId: string | null;
      readonly initiatingToolClientId: string | null;
      readonly sourceAutomationId: string | null;
      readonly sourceAutomationRunId: string | null;
    },
  ): void {
    const origin = this.database
      .prepare(
        `
          SELECT 1
          FROM thread_fork_origins
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND child_thread_id = ? AND creation_operation_id = ?
            AND origin_state = 'committed' AND committed_at IS NOT NULL
            AND initiating_principal_id = ?
            AND ((? = 'user_fork' AND origin_kind = 'user_fork'
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL)
              OR (? = 'automation' AND origin_kind = 'automation_fork'
                AND source_automation_id = ?
                AND source_automation_run_id = ?)
              OR (? = 'agent_control' AND origin_kind = 'agent_fork'
                AND initiating_agent_thread_id = ?
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL)
              OR (? = 'principal_client'
                AND origin_kind = 'principal_client_fork'
                AND initiating_tool_client_id = ?
                AND source_automation_id IS NULL
                AND source_automation_run_id IS NULL))
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        creationOperationId,
        scope.principalId,
        source.sourceKind,
        source.sourceKind,
        source.sourceAutomationId,
        source.sourceAutomationRunId,
        source.sourceKind,
        source.initiatingAgentThreadId,
        source.sourceKind,
        source.initiatingToolClientId,
      );
    if (!origin) {
      throw new DomainError(
        "invalid_transition",
        "The bound fork child is missing committed provenance.",
      );
    }
  }

  #commitPreparedForkOrigin(
    scope: RequestScope,
    applicationThreadId: string,
    creationOperationId: string,
    committedAt: number,
  ): void {
    const originChanged = this.database
      .prepare(
        `
          UPDATE thread_fork_origins
          SET origin_state = 'committed', committed_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND child_thread_id = ? AND creation_operation_id = ?
            AND origin_state = 'prepared' AND committed_at IS NULL
        `,
      )
      .run(
        committedAt,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        creationOperationId,
      );
    if (originChanged.changes !== 1) {
      throw new DomainError(
        "invalid_transition",
        "Fork provenance changed while binding the child.",
      );
    }
  }

  #mutationReceipt(
    scope: RequestScope,
    mutationId: string,
  ): MutationReceipt | undefined {
    return this.database
      .prepare(
        `
          SELECT thread_id AS threadId, operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      MutationReceipt | undefined;
  }

  #bumpGeneration(scope: RequestScope): void {
    const changed = this.database
      .prepare(
        `
          UPDATE principal_generations
          SET inventory_generation = inventory_generation + 1
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .run(scope.tenantId, scope.principalId);
    if (changed.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The principal inventory generation is missing.",
      );
    }
  }
}

function sqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
