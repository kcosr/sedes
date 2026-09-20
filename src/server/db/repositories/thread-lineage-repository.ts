import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AbortedThreadForkRecord,
  ForkBoundaryKind,
  ForkBranchMethod,
  ForkOriginKind,
  ForkSourceThreadState,
  ForkSourceTurnState,
  ThreadDescendantCursor,
  ThreadDescendantPage,
  ThreadForkOriginRecord,
  ThreadLineagePlacementMode,
  ThreadLineagePlacementRecord,
} from "../../domain/thread-lineage-models.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

const originColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  child_thread_id AS childThreadId,
  provider_parent_backend_conversation_id AS providerParentBackendConversationId,
  source_thread_state AS sourceThreadState,
  source_thread_id AS sourceThreadId,
  source_turn_state AS sourceTurnState,
  source_turn_id AS sourceTurnId,
  source_turn_revision AS sourceTurnRevision,
  source_turn_completed_at AS sourceTurnCompletedAt,
  source_checkpoint_id AS sourceCheckpointId,
  boundary_kind AS boundaryKind,
  origin_kind AS originKind,
  initiating_principal_id AS initiatingPrincipalId,
  initiating_agent_thread_id AS initiatingAgentThreadId,
  initiating_tool_client_id AS initiatingToolClientId,
  source_automation_id AS sourceAutomationId,
  source_automation_run_id AS sourceAutomationRunId,
  branch_method AS branchMethod,
  creation_operation_id AS creationOperationId,
  origin_state AS originState,
  created_at AS createdAt,
  committed_at AS committedAt
`;

const abortedColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  creation_operation_id AS creationOperationId,
  reserved_child_thread_id AS reservedChildThreadId,
  source_thread_id AS sourceThreadId,
  source_turn_id AS sourceTurnId,
  source_turn_revision AS sourceTurnRevision,
  boundary_kind AS boundaryKind,
  source_kind AS sourceKind,
  initiating_agent_thread_id AS initiatingAgentThreadId,
  initiating_tool_client_id AS initiatingToolClientId,
  source_automation_id AS sourceAutomationId,
  source_automation_run_id AS sourceAutomationRunId,
  diagnostic,
  aborted_at AS abortedAt
`;

const placementColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  child_thread_id AS childThreadId,
  placement_mode AS placementMode,
  placement_state AS placementState,
  revision,
  updated_at AS updatedAt
`;

type TargetRow = {
  readonly environmentId: string;
  readonly workspaceId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly backendConversationId: string | null;
};

type PrepareThreadForkOriginCommon = {
  readonly childThreadId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string;
  readonly sourceTurnCompletedAt: number | null;
  readonly sourceCheckpointId: string;
  readonly initiatingPrincipalId: string;
  readonly branchMethod: ForkBranchMethod;
  readonly creationOperationId: string;
  readonly now: number;
  readonly initiatingAgentThreadId?: string;
  readonly initiatingToolClientId?: string;
};

export type PrepareThreadForkOriginInput = PrepareThreadForkOriginCommon &
  (
    | {
        readonly originKind: "user_fork";
        readonly sourceTurnRevision: number;
        readonly initiatingAgentThreadId?: never;
        readonly sourceAutomationId?: never;
        readonly sourceAutomationRunId?: never;
      }
    | {
        readonly originKind: "agent_fork";
        readonly sourceTurnRevision: number;
        readonly initiatingAgentThreadId: string;
        readonly sourceAutomationId?: never;
        readonly sourceAutomationRunId?: never;
      }
    | {
        readonly originKind: "principal_client_fork";
        readonly sourceTurnRevision: number;
        readonly initiatingToolClientId: string;
        readonly initiatingAgentThreadId?: never;
        readonly sourceAutomationId?: never;
        readonly sourceAutomationRunId?: never;
      }
    | {
        readonly originKind: "automation_fork";
        readonly sourceTurnRevision?: never;
        readonly initiatingAgentThreadId?: never;
        readonly sourceAutomationId: string;
        readonly sourceAutomationRunId: string;
      }
  );

export type PrepareProviderSnapshotForkOriginInput = {
  readonly childThreadId: string;
  readonly sourceThreadId: string;
  readonly sourceCheckpointId: string;
  readonly initiatingPrincipalId: string;
  readonly branchMethod: ForkBranchMethod;
  readonly creationOperationId: string;
  readonly now: number;
};

export type RecordImportedNativeOriginInput = {
  readonly childThreadId: string;
  readonly providerParentBackendConversationId: string;
  readonly sourceThreadId?: string;
  readonly sourceTurnState: ForkSourceTurnState;
  readonly sourceTurnId?: string;
  readonly sourceCheckpointId?: string;
  readonly branchMethod: ForkBranchMethod;
  readonly now: number;
};

export type ReconcileImportedNativeSourceInput = {
  readonly providerParentBackendConversationId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnState: ForkSourceTurnState;
  readonly sourceTurnId?: string;
  readonly sourceCheckpointId?: string;
  readonly now: number;
};

export class ThreadLineageRepository {
  constructor(readonly database: Database.Database) {}

  prepareOrigin(
    scope: RequestScope,
    input: PrepareThreadForkOriginInput,
  ): ThreadForkOriginRecord {
    return this.database.transaction(() => {
      const replay = this.findByCreationOperation(
        scope,
        input.creationOperationId,
      );
      if (replay) {
        this.#assertPrepareReplay(replay, input);
        return replay;
      }
      const target = this.#matchingTargets(
        scope,
        input.sourceThreadId,
        input.childThreadId,
      );
      if (target.source.backingState !== "bound") {
        throw new DomainError(
          "invalid_transition",
          "Only a bound thread can be a fork source.",
        );
      }
      if (!new Set(["unbound", "creating"]).has(target.child.backingState)) {
        throw new DomainError(
          "invalid_transition",
          "The fork child is not in a creation state.",
        );
      }
      this.#assertNoCycle(scope, input.sourceThreadId, input.childThreadId);
      this.#assertCheckpoint(scope, input.sourceCheckpointId, {
        boundaryKind: "completed_turn_inclusive",
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: input.sourceTurnId,
        backendInstanceId: target.source.backendInstanceId,
      });
      this.#assertAutomationSource(scope, input);
      this.#insertOrigin(scope, target.source, {
        ...input,
        providerParentBackendConversationId: null,
        sourceThreadState: "resolved",
        sourceAutomationId: input.sourceAutomationId ?? null,
        sourceAutomationRunId: input.sourceAutomationRunId ?? null,
        initiatingAgentThreadId: input.initiatingAgentThreadId ?? null,
        initiatingToolClientId: input.initiatingToolClientId ?? null,
        sourceTurnState: "resolved",
        sourceTurnRevision: input.sourceTurnRevision ?? null,
        boundaryKind: "completed_turn_inclusive",
        originState: "prepared",
        committedAt: null,
      });
      this.#insertDefaultPlacement(
        scope,
        input.childThreadId,
        "nested_under_source",
        input.now,
      );
      return this.getOrigin(scope, input.childThreadId);
    })();
  }

  prepareProviderSnapshotOrigin(
    scope: RequestScope,
    input: PrepareProviderSnapshotForkOriginInput,
  ): ThreadForkOriginRecord & {
    readonly boundaryKind: "provider_snapshot_at_acceptance";
  } {
    const origin = this.database.transaction(() => {
      const replay = this.findByCreationOperation(
        scope,
        input.creationOperationId,
      );
      if (replay) {
        this.#assertProviderSnapshotPrepareReplay(replay, input);
        return replay;
      }
      const target = this.#matchingTargets(
        scope,
        input.sourceThreadId,
        input.childThreadId,
      );
      if (target.source.backingState !== "bound") {
        throw new DomainError(
          "invalid_transition",
          "Only a bound thread can be a fork source.",
        );
      }
      if (!new Set(["unbound", "creating"]).has(target.child.backingState)) {
        throw new DomainError(
          "invalid_transition",
          "The fork child is not in a creation state.",
        );
      }
      this.#assertNoCycle(scope, input.sourceThreadId, input.childThreadId);
      this.#assertCheckpoint(scope, input.sourceCheckpointId, {
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: null,
        backendInstanceId: target.source.backendInstanceId,
      });
      this.#insertOrigin(scope, target.source, {
        ...input,
        providerParentBackendConversationId: null,
        sourceThreadState: "resolved",
        sourceTurnState: "unresolved",
        sourceTurnId: null,
        sourceTurnRevision: null,
        sourceTurnCompletedAt: null,
        boundaryKind: "provider_snapshot_at_acceptance",
        originKind: "user_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        sourceAutomationId: null,
        sourceAutomationRunId: null,
        originState: "prepared",
        committedAt: null,
      });
      this.#insertDefaultPlacement(
        scope,
        input.childThreadId,
        "nested_under_source",
        input.now,
      );
      return this.getOrigin(scope, input.childThreadId);
    })();
    if (origin.boundaryKind !== "provider_snapshot_at_acceptance") {
      throw new DomainError("conflict", "The fork boundary is corrupt.");
    }
    return origin;
  }

  recordImportedNativeOrigin(
    scope: RequestScope,
    input: RecordImportedNativeOriginInput,
  ): ThreadForkOriginRecord {
    if (
      (input.sourceTurnState === "resolved") !==
      (input.sourceTurnId !== undefined)
    ) {
      throw new DomainError(
        "conflict",
        "Imported source-turn resolution is inconsistent.",
      );
    }
    if (
      !input.sourceThreadId &&
      (input.sourceTurnState !== "unresolved" ||
        input.sourceTurnId !== undefined ||
        input.sourceCheckpointId !== undefined)
    ) {
      throw new DomainError(
        "conflict",
        "An unresolved imported source cannot claim source-turn evidence.",
      );
    }
    return this.database.transaction(() => {
      const existing = this.findOrigin(scope, input.childThreadId);
      if (existing) {
        if (
          existing.originKind !== "imported_native_fork" ||
          existing.providerParentBackendConversationId !==
            input.providerParentBackendConversationId ||
          existing.sourceThreadState !==
            (input.sourceThreadId ? "resolved" : "unresolved") ||
          existing.sourceThreadId !== (input.sourceThreadId ?? null) ||
          existing.sourceTurnState !== input.sourceTurnState ||
          existing.sourceTurnId !== (input.sourceTurnId ?? null) ||
          existing.sourceCheckpointId !== (input.sourceCheckpointId ?? null) ||
          existing.branchMethod !== input.branchMethod
        ) {
          throw new DomainError(
            "conflict",
            "The imported native origin changed for this child.",
          );
        }
        return existing;
      }
      const child = this.#getTarget(scope, input.childThreadId);
      if (!child) {
        throw new DomainError(
          "not_found",
          "The imported fork child was not found.",
        );
      }
      if (child.backingState !== "bound") {
        throw new DomainError(
          "invalid_transition",
          "Imported native ancestry requires a bound child thread.",
        );
      }
      let target: TargetRow = child;
      if (input.sourceThreadId) {
        const matched = this.#matchingTargets(
          scope,
          input.sourceThreadId,
          input.childThreadId,
        );
        if (matched.source.backingState !== "bound") {
          throw new DomainError(
            "invalid_transition",
            "An imported native source must be bound when it is known.",
          );
        }
        this.#assertProviderParent(
          matched.source,
          input.providerParentBackendConversationId,
        );
        target = matched.source;
        this.#assertNoCycle(scope, input.sourceThreadId, input.childThreadId);
      }
      if (input.sourceCheckpointId && input.sourceThreadId) {
        this.#assertCheckpoint(scope, input.sourceCheckpointId, {
          boundaryKind: "completed_turn_inclusive",
          sourceThreadId: input.sourceThreadId,
          sourceTurnId: input.sourceTurnId ?? null,
          backendInstanceId: target.backendInstanceId,
        });
      }
      this.#insertOrigin(scope, target, {
        ...input,
        sourceThreadState: input.sourceThreadId ? "resolved" : "unresolved",
        sourceThreadId: input.sourceThreadId ?? null,
        sourceTurnId: input.sourceTurnId ?? null,
        sourceTurnRevision: null,
        sourceTurnCompletedAt: null,
        sourceCheckpointId: input.sourceCheckpointId ?? null,
        boundaryKind: "completed_turn_inclusive",
        originKind: "imported_native_fork",
        initiatingPrincipalId: null,
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        sourceAutomationId: null,
        sourceAutomationRunId: null,
        creationOperationId: null,
        originState: "committed",
        committedAt: input.now,
      });
      this.#insertDefaultPlacement(
        scope,
        input.childThreadId,
        input.sourceThreadId ? "nested_under_source" : "top_level",
        input.now,
      );
      return this.getOrigin(scope, input.childThreadId);
    })();
  }

  reconcileImportedNativeSource(
    scope: RequestScope,
    childThreadId: string,
    input: ReconcileImportedNativeSourceInput,
  ): ThreadForkOriginRecord {
    if (
      (input.sourceTurnState === "resolved") !==
      (input.sourceTurnId !== undefined)
    ) {
      throw new DomainError(
        "conflict",
        "Imported source-turn resolution is inconsistent.",
      );
    }
    return this.database.transaction(() => {
      const current = this.getOrigin(scope, childThreadId);
      if (
        current.originKind !== "imported_native_fork" ||
        current.originState !== "committed"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only committed imported ancestry can resolve a native source.",
        );
      }
      if (
        current.providerParentBackendConversationId !==
        input.providerParentBackendConversationId
      ) {
        throw new DomainError(
          "conflict",
          "Imported provider parent evidence changed.",
        );
      }
      if (current.sourceThreadState === "resolved") {
        if (current.sourceThreadId !== input.sourceThreadId) {
          throw new DomainError(
            "conflict",
            "Imported source resolution changed.",
          );
        }
        if (
          current.sourceTurnState === input.sourceTurnState &&
          current.sourceTurnId === (input.sourceTurnId ?? null) &&
          current.sourceCheckpointId === (input.sourceCheckpointId ?? null)
        ) {
          return current;
        }
        if (
          current.sourceTurnState !== "unresolved" ||
          input.sourceTurnState !== "resolved"
        ) {
          throw new DomainError(
            "conflict",
            "Imported source resolution changed.",
          );
        }
        const target = this.#matchingTargets(
          scope,
          input.sourceThreadId,
          childThreadId,
        );
        this.#assertProviderParent(
          target.source,
          input.providerParentBackendConversationId,
        );
        if (input.sourceCheckpointId) {
          this.#assertCheckpoint(scope, input.sourceCheckpointId, {
            boundaryKind: "completed_turn_inclusive",
            sourceThreadId: input.sourceThreadId,
            sourceTurnId: input.sourceTurnId ?? null,
            backendInstanceId: target.source.backendInstanceId,
          });
        }
        const turnChanged = this.database
          .prepare(
            `
          UPDATE thread_fork_origins
          SET source_turn_state = 'resolved', source_turn_id = ?,
            source_checkpoint_id = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?
            AND source_thread_state = 'resolved' AND source_thread_id = ?
            AND provider_parent_backend_conversation_id = ?
            AND source_turn_state = 'unresolved' AND source_turn_id IS NULL
        `,
          )
          .run(
            input.sourceTurnId ?? null,
            input.sourceCheckpointId ?? null,
            scope.tenantId,
            scope.principalId,
            childThreadId,
            input.sourceThreadId,
            input.providerParentBackendConversationId,
          );
        if (turnChanged.changes !== 1) {
          throw new DomainError(
            "conflict",
            "Imported source resolution changed concurrently.",
          );
        }
        return this.getOrigin(scope, childThreadId);
      }
      const target = this.#matchingTargets(
        scope,
        input.sourceThreadId,
        childThreadId,
      );
      if (
        target.source.backingState !== "bound" ||
        target.child.backingState !== "bound"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Imported native ancestry requires two bound threads when resolving its source.",
        );
      }
      this.#assertProviderParent(
        target.source,
        input.providerParentBackendConversationId,
      );
      this.#assertNoCycle(scope, input.sourceThreadId, childThreadId);
      if (input.sourceCheckpointId) {
        this.#assertCheckpoint(scope, input.sourceCheckpointId, {
          boundaryKind: "completed_turn_inclusive",
          sourceThreadId: input.sourceThreadId,
          sourceTurnId: input.sourceTurnId ?? null,
          backendInstanceId: target.source.backendInstanceId,
        });
      }
      const changed = this.database
        .prepare(
          `
        UPDATE thread_fork_origins
        SET source_thread_state = 'resolved', source_thread_id = ?,
          source_turn_state = ?, source_turn_id = ?, source_checkpoint_id = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?
          AND source_thread_state = 'unresolved' AND source_thread_id IS NULL
          AND provider_parent_backend_conversation_id = ?
      `,
        )
        .run(
          input.sourceThreadId,
          input.sourceTurnState,
          input.sourceTurnId ?? null,
          input.sourceCheckpointId ?? null,
          scope.tenantId,
          scope.principalId,
          childThreadId,
          input.providerParentBackendConversationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "Imported source resolution changed concurrently.",
        );
      }
      this.database
        .prepare(
          `
        UPDATE thread_lineage_placement
        SET placement_mode = 'nested_under_source', revision = revision + 1,
          updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?
          AND placement_state = 'default' AND placement_mode = 'top_level'
      `,
        )
        .run(input.now, scope.tenantId, scope.principalId, childThreadId);
      return this.getOrigin(scope, childThreadId);
    })();
  }

  findAbortedOperation(
    scope: RequestScope,
    creationOperationId: string,
  ): AbortedThreadForkRecord | undefined {
    return this.database
      .prepare(
        `
      SELECT ${abortedColumns}
      FROM aborted_thread_forks
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND creation_operation_id = ?
    `,
      )
      .get(scope.tenantId, scope.principalId, creationOperationId) as
      AbortedThreadForkRecord | undefined;
  }

  abortPreparedFork(
    scope: RequestScope,
    childThreadId: string,
    input: {
      readonly creationOperationId: string;
      readonly diagnostic: string;
      readonly now: number;
      readonly onThreadTasksPromoted?: (taskIds: readonly string[]) => void;
    },
  ): AbortedThreadForkRecord {
    return this.#abortPreparedFork(
      scope,
      childThreadId,
      input,
      "completed_turn_inclusive",
    );
  }

  abortPreparedProviderSnapshotFork(
    scope: RequestScope,
    childThreadId: string,
    input: {
      readonly creationOperationId: string;
      readonly diagnostic: string;
      readonly now: number;
      readonly onThreadTasksPromoted?: (taskIds: readonly string[]) => void;
    },
  ): AbortedThreadForkRecord {
    return this.#abortPreparedFork(
      scope,
      childThreadId,
      input,
      "provider_snapshot_at_acceptance",
    );
  }

  #abortPreparedFork(
    scope: RequestScope,
    childThreadId: string,
    input: {
      readonly creationOperationId: string;
      readonly diagnostic: string;
      readonly now: number;
      /**
       * Receives task ids promoted off the deleted child (still inside this
       * transaction) so the caller can publish them after commit.
       */
      readonly onThreadTasksPromoted?: (taskIds: readonly string[]) => void;
    },
    boundaryKind: ForkBoundaryKind,
  ): AbortedThreadForkRecord {
    return this.database.transaction(() => {
      const replay = this.findAbortedOperation(
        scope,
        input.creationOperationId,
      );
      if (replay) {
        if (
          replay.reservedChildThreadId !== childThreadId ||
          replay.boundaryKind !== boundaryKind ||
          replay.diagnostic !== input.diagnostic
        ) {
          throw new DomainError(
            "conflict",
            "The aborted fork operation changed during replay.",
          );
        }
        return replay;
      }
      const origin = this.getOrigin(scope, childThreadId);
      const attempt = this.database
        .prepare(
          `
        SELECT mutation_id AS mutationId, creation_kind AS creationKind,
          source_kind AS sourceKind,
          environment_variables_fingerprint AS environmentVariablesFingerprint,
          initiating_agent_thread_id AS initiatingAgentThreadId,
          initiating_tool_client_id AS initiatingToolClientId,
          source_automation_id AS sourceAutomationId,
          source_automation_run_id AS sourceAutomationRunId,
          phase, provisional_backend_conversation_id AS provisionalId
        FROM conversation_creation_attempts
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND mutation_id = ?
      `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          childThreadId,
          input.creationOperationId,
        ) as
        | {
            mutationId: string;
            environmentVariablesFingerprint: string;
            creationKind: string;
            sourceKind:
              | "automation"
              | "user_fork"
              | "agent_control"
              | "principal_client";
            initiatingAgentThreadId: string | null;
            initiatingToolClientId: string | null;
            sourceAutomationId: string | null;
            sourceAutomationRunId: string | null;
            phase: string;
            provisionalId: string | null;
          }
        | undefined;
      if (
        origin.originState !== "prepared" ||
        origin.boundaryKind !== boundaryKind ||
        origin.creationOperationId !== input.creationOperationId ||
        !origin.sourceThreadId ||
        !origin.sourceCheckpointId ||
        !attempt ||
        attempt.creationKind !== "fork" ||
        !new Set(["external_call_started", "recovery_required"]).has(
          attempt.phase,
        ) ||
        attempt.provisionalId !== null ||
        this.database
          .prepare(
            `
          SELECT 1 FROM conversation_bindings
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, childThreadId)
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only a proven-uncreated prepared fork can be removed.",
        );
      }
      this.database
        .prepare(
          `
        INSERT INTO aborted_thread_forks(
          tenant_id, owner_principal_id, creation_operation_id,
          reserved_child_thread_id, source_thread_id, source_turn_id,
          source_turn_revision, boundary_kind, source_kind, source_automation_id,
          source_automation_run_id, initiating_agent_thread_id,
          initiating_tool_client_id, diagnostic, aborted_at, environment_variables_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.creationOperationId,
          childThreadId,
          origin.sourceThreadId,
          origin.sourceTurnId,
          origin.sourceTurnRevision,
          origin.boundaryKind,
          attempt.sourceKind,
          attempt.sourceAutomationId,
          attempt.sourceAutomationRunId,
          attempt.initiatingAgentThreadId,
          attempt.initiatingToolClientId,
          input.diagnostic,
          input.now,
          attempt.environmentVariablesFingerprint,
        );
      const scopedDelete = (table: string, threadColumn: string): void => {
        this.database
          .prepare(
            `
          DELETE FROM ${table}
          WHERE tenant_id = ? AND ${threadColumn} = ?
            AND ${
              table === "thread_drafts" ||
              table === "prompt_stashes" ||
              table === "thread_principal_state"
                ? "principal_id"
                : "owner_principal_id"
            } = ?
        `,
          )
          .run(scope.tenantId, childThreadId, scope.principalId);
      };
      scopedDelete("thread_lineage_placement", "child_thread_id");
      scopedDelete("thread_fork_origins", "child_thread_id");
      scopedDelete("conversation_creation_attempts", "application_thread_id");
      this.database
        .prepare(
          `
        DELETE FROM backend_checkpoints
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
        )
        .run(scope.tenantId, scope.principalId, origin.sourceCheckpointId);
      scopedDelete("pi_thread_settings", "application_thread_id");
      scopedDelete("codex_thread_execution_settings", "application_thread_id");
      scopedDelete("prompt_stashes", "thread_id");
      scopedDelete("thread_drafts", "thread_id");
      scopedDelete("thread_principal_state", "thread_id");
      // Tasks are user data, not per-thread machinery: a hard delete promotes
      // them (open and completed) to the child's workspace instead of losing
      // them or tripping the schema-24 RESTRICT foreign key.
      const promotedTasks = this.database
        .prepare(
          `
        UPDATE tasks
        SET scope_kind = 'workspace',
          environment_id = (
            SELECT thread.environment_id FROM application_threads AS thread
            WHERE thread.tenant_id = tasks.tenant_id
              AND thread.owner_principal_id = tasks.owner_principal_id
              AND thread.id = tasks.thread_id
          ),
          workspace_id = (
            SELECT thread.workspace_id FROM application_threads AS thread
            WHERE thread.tenant_id = tasks.tenant_id
              AND thread.owner_principal_id = tasks.owner_principal_id
              AND thread.id = tasks.thread_id
          ),
          thread_id = NULL,
          revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?
        RETURNING id
      `,
        )
        .all(
          input.now,
          scope.tenantId,
          scope.principalId,
          childThreadId,
        ) as readonly { readonly id: string }[];
      if (promotedTasks.length > 0) {
        input.onThreadTasksPromoted?.(promotedTasks.map(({ id }) => id));
      }
      const removed = this.database
        .prepare(
          `
        DELETE FROM application_threads
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          AND backing_state = 'creating'
      `,
        )
        .run(scope.tenantId, scope.principalId, childThreadId);
      if (removed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The aborted fork child could not be removed.",
        );
      }
      return this.findAbortedOperation(scope, input.creationOperationId)!;
    })();
  }

  commitOrigin(
    scope: RequestScope,
    childThreadId: string,
    creationOperationId: string,
    committedAt: number,
  ): ThreadForkOriginRecord {
    return this.database.transaction(() => {
      const current = this.getOrigin(scope, childThreadId);
      if (current.creationOperationId !== creationOperationId) {
        throw new DomainError(
          "conflict",
          "The fork operation does not match its durable origin.",
        );
      }
      if (current.originState === "committed") return current;
      const durable = this.database
        .prepare(
          `
            SELECT 1
            FROM conversation_bindings AS binding
            JOIN conversation_creation_attempts AS attempt
              ON attempt.tenant_id = binding.tenant_id
              AND attempt.owner_principal_id = binding.owner_principal_id
              AND attempt.application_thread_id = binding.application_thread_id
            WHERE binding.tenant_id = ? AND binding.owner_principal_id = ?
              AND binding.application_thread_id = ?
              AND attempt.mutation_id = ? AND attempt.phase = 'bound'
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          childThreadId,
          creationOperationId,
        );
      if (!durable) {
        throw new DomainError(
          "invalid_transition",
          "Fork provenance cannot commit before the child binding.",
        );
      }
      const changed = this.database
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
          childThreadId,
          creationOperationId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The fork origin changed concurrently.",
        );
      }
      return this.getOrigin(scope, childThreadId);
    })();
  }

  getOrigin(
    scope: RequestScope,
    childThreadId: string,
  ): ThreadForkOriginRecord {
    const row = this.findOrigin(scope, childThreadId);
    if (!row)
      throw new DomainError("not_found", "The fork origin was not found.");
    return row;
  }

  findOrigin(
    scope: RequestScope,
    childThreadId: string,
  ): ThreadForkOriginRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${originColumns} FROM thread_fork_origins
         WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, childThreadId) as
      ThreadForkOriginRecord | undefined;
    return row ? assertOriginRecord(row) : undefined;
  }

  findByCreationOperation(
    scope: RequestScope,
    creationOperationId: string,
  ): ThreadForkOriginRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${originColumns} FROM thread_fork_origins
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND creation_operation_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, creationOperationId) as
      ThreadForkOriginRecord | undefined;
    return row ? assertOriginRecord(row) : undefined;
  }

  listOrigins(
    scope: RequestScope,
    childThreadIds: readonly string[],
  ): readonly ThreadForkOriginRecord[] {
    if (childThreadIds.length === 0) return [];
    if (childThreadIds.length > 10_000) {
      throw new DomainError(
        "invalid_transition",
        "Too many lineage rows were requested.",
      );
    }
    const placeholders = childThreadIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT ${originColumns} FROM thread_fork_origins
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND child_thread_id IN (${placeholders})
         ORDER BY created_at DESC, child_thread_id DESC`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...childThreadIds,
      ) as ThreadForkOriginRecord[];
    return rows.map(assertOriginRecord);
  }

  listPlacements(
    scope: RequestScope,
    childThreadIds: readonly string[],
  ): readonly ThreadLineagePlacementRecord[] {
    if (childThreadIds.length === 0) return [];
    if (childThreadIds.length > 10_000) {
      throw new DomainError(
        "invalid_transition",
        "Too many placements were requested.",
      );
    }
    const placeholders = childThreadIds.map(() => "?").join(",");
    return this.database
      .prepare(
        `SELECT ${placementColumns} FROM thread_lineage_placement
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND child_thread_id IN (${placeholders})
         ORDER BY child_thread_id`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...childThreadIds,
      ) as ThreadLineagePlacementRecord[];
  }

  updatePlacement(
    scope: RequestScope,
    childThreadId: string,
    input: {
      readonly placementMode: ThreadLineagePlacementMode;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): ThreadLineagePlacementRecord {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "lineage_placement",
          childThreadId,
          input.placementMode,
          input.expectedRevision,
        ]),
      )
      .digest("hex");
    return this.database.transaction(() => {
      const origin = this.getOrigin(scope, childThreadId);
      if (
        origin.sourceThreadState === "unresolved" &&
        input.placementMode === "nested_under_source"
      ) {
        throw new DomainError(
          "invalid_transition",
          "A thread cannot nest under an unresolved source.",
        );
      }
      const receipt = this.database
        .prepare(
          `SELECT thread_id AS threadId, request_fingerprint AS fingerprint,
             result_json AS resultJson
           FROM mutation_receipts
           WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
        )
        .get(scope.tenantId, scope.principalId, input.mutationId) as
        | {
            readonly threadId: string;
            readonly fingerprint: string;
            readonly resultJson: string;
          }
        | undefined;
      if (receipt) {
        if (
          receipt.threadId !== childThreadId ||
          receipt.fingerprint !== fingerprint
        ) {
          throw new DomainError("conflict", "The mutation ID was reused.");
        }
        return parsePlacementReceipt(receipt.resultJson, scope, childThreadId);
      }
      const changed = this.database
        .prepare(
          `UPDATE thread_lineage_placement
           SET placement_mode = ?, placement_state = 'explicit',
             revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND child_thread_id = ? AND revision = ?`,
        )
        .run(
          input.placementMode,
          input.now,
          scope.tenantId,
          scope.principalId,
          childThreadId,
          input.expectedRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The lineage placement changed in another client.",
        );
      }
      const result = this.getPlacement(scope, childThreadId);
      this.database
        .prepare(
          `INSERT INTO mutation_receipts(
             tenant_id, principal_id, thread_id, mutation_id, operation_kind,
             request_fingerprint, result_code, result_json, replayable, created_at
           ) VALUES (?, ?, ?, ?, 'lineage_placement', ?, 'completed', ?, 1, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          childThreadId,
          input.mutationId,
          fingerprint,
          JSON.stringify(result),
          input.now,
        );
      return result;
    })();
  }

  getPlacement(
    scope: RequestScope,
    childThreadId: string,
  ): ThreadLineagePlacementRecord {
    const row = this.database
      .prepare(
        `SELECT ${placementColumns} FROM thread_lineage_placement
         WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, childThreadId) as
      ThreadLineagePlacementRecord | undefined;
    if (!row)
      throw new DomainError(
        "not_found",
        "The lineage placement was not found.",
      );
    return row;
  }

  listDescendants(
    scope: RequestScope,
    sourceThreadId: string,
    input: { readonly limit: number; readonly cursor?: ThreadDescendantCursor },
  ): ThreadDescendantPage {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new DomainError(
        "invalid_transition",
        "The descendant page is outside supported bounds.",
      );
    }
    if (!this.#getTarget(scope, sourceThreadId)) {
      throw new DomainError(
        "not_found",
        "The lineage root thread was not found.",
      );
    }
    const cursorPredicate = input.cursor
      ? `AND (closure.descendant_created_at, closure.descendant_thread_id)
           < (?, ?)`
      : "";
    const rows = this.database
      .prepare(
        `
          SELECT
            origin.tenant_id AS tenantId,
            origin.owner_principal_id AS ownerPrincipalId,
            origin.child_thread_id AS childThreadId,
            origin.provider_parent_backend_conversation_id AS providerParentBackendConversationId,
            origin.source_thread_state AS sourceThreadState,
            origin.source_thread_id AS sourceThreadId,
            origin.source_turn_state AS sourceTurnState,
            origin.source_turn_id AS sourceTurnId,
            origin.source_turn_revision AS sourceTurnRevision,
            origin.source_turn_completed_at AS sourceTurnCompletedAt,
            origin.source_checkpoint_id AS sourceCheckpointId,
            origin.boundary_kind AS boundaryKind,
            origin.origin_kind AS originKind,
            origin.initiating_principal_id AS initiatingPrincipalId,
            origin.initiating_agent_thread_id AS initiatingAgentThreadId,
            origin.source_automation_id AS sourceAutomationId,
            origin.source_automation_run_id AS sourceAutomationRunId,
            origin.branch_method AS branchMethod,
            origin.creation_operation_id AS creationOperationId,
            origin.origin_state AS originState,
            origin.created_at AS createdAt,
            origin.committed_at AS committedAt
          FROM thread_lineage_closure AS closure
          JOIN thread_fork_origins AS origin
            ON origin.tenant_id = closure.tenant_id
            AND origin.owner_principal_id = closure.owner_principal_id
            AND origin.child_thread_id = closure.descendant_thread_id
          WHERE closure.tenant_id = ? AND closure.owner_principal_id = ?
            AND closure.ancestor_thread_id = ?
            AND origin.origin_state = 'committed'
            ${cursorPredicate}
          ORDER BY closure.descendant_created_at DESC,
            closure.descendant_thread_id DESC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        sourceThreadId,
        ...(input.cursor
          ? [input.cursor.createdAt, input.cursor.childThreadId]
          : []),
        input.limit + 1,
      ) as ThreadForkOriginRecord[];
    const page = rows.slice(0, input.limit).map(assertOriginRecord);
    const last = page.at(-1);
    return {
      descendants: page,
      nextCursor:
        rows.length > input.limit && last
          ? { createdAt: last.createdAt, childThreadId: last.childThreadId }
          : null,
    };
  }

  countDescendants(
    scope: RequestScope,
    sourceThreadIds: readonly string[],
  ): readonly {
    readonly sourceThreadId: string;
    readonly descendantCount: number;
  }[] {
    if (sourceThreadIds.length === 0) return [];
    if (sourceThreadIds.length > 100) {
      throw new DomainError(
        "invalid_transition",
        "The lineage family count request is outside supported bounds.",
      );
    }
    return this.database
      .prepare(
        `WITH requested_sources(id) AS (
           VALUES ${sourceThreadIds.map(() => "(?)").join(",")}
         )
         SELECT
           closure.ancestor_thread_id AS sourceThreadId,
           count(*) AS descendantCount
         FROM thread_lineage_closure AS closure
         INNER JOIN requested_sources AS requested
           ON requested.id = closure.ancestor_thread_id
         INNER JOIN thread_fork_origins AS origin
           ON origin.tenant_id = closure.tenant_id
           AND origin.owner_principal_id = closure.owner_principal_id
           AND origin.child_thread_id = closure.descendant_thread_id
           AND origin.origin_state = 'committed'
         WHERE closure.tenant_id = ? AND closure.owner_principal_id = ?
         GROUP BY closure.ancestor_thread_id`,
      )
      .all(...sourceThreadIds, scope.tenantId, scope.principalId) as readonly {
      readonly sourceThreadId: string;
      readonly descendantCount: number;
    }[];
  }

  listFamilyThreadIds(
    scope: RequestScope,
    sourceThreadId: string,
    maximum: number,
  ): readonly string[] {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) {
      throw new Error("thread_lineage_family_bound_invalid");
    }
    const rows = this.database
      .prepare(
        `SELECT family.threadId
         FROM (
           SELECT root.id AS threadId, 0 AS familyOrder
           FROM application_threads AS root
           WHERE root.tenant_id = ? AND root.owner_principal_id = ?
             AND root.id = ?
           UNION ALL
           SELECT closure.descendant_thread_id AS threadId, 1 AS familyOrder
           FROM thread_lineage_closure AS closure
           INNER JOIN thread_fork_origins AS origin
             ON origin.tenant_id = closure.tenant_id
             AND origin.owner_principal_id = closure.owner_principal_id
             AND origin.child_thread_id = closure.descendant_thread_id
             AND origin.origin_state = 'committed'
           WHERE closure.tenant_id = ? AND closure.owner_principal_id = ?
             AND closure.ancestor_thread_id = ?
         ) AS family
         ORDER BY family.familyOrder, family.threadId
         LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        sourceThreadId,
        scope.tenantId,
        scope.principalId,
        sourceThreadId,
        maximum + 1,
      ) as readonly { readonly threadId: string }[];
    if (rows.length === 0) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    if (rows.length > maximum) {
      throw new DomainError(
        "invalid_transition",
        "The thread family is outside the supported application bounds.",
      );
    }
    return rows.map(({ threadId }) => threadId);
  }

  #insertOrigin(
    scope: RequestScope,
    target: TargetRow,
    input: {
      readonly childThreadId: string;
      readonly providerParentBackendConversationId: string | null;
      readonly sourceThreadState: ForkSourceThreadState;
      readonly sourceThreadId: string | null;
      readonly sourceTurnState: ForkSourceTurnState;
      readonly sourceTurnId: string | null;
      readonly sourceTurnRevision: number | null;
      readonly sourceTurnCompletedAt: number | null;
      readonly sourceCheckpointId: string | null;
      readonly boundaryKind: ForkBoundaryKind;
      readonly originKind: ForkOriginKind;
      readonly initiatingPrincipalId: string | null;
      readonly initiatingAgentThreadId: string | null;
      readonly initiatingToolClientId: string | null;
      readonly sourceAutomationId: string | null | undefined;
      readonly sourceAutomationRunId: string | null | undefined;
      readonly branchMethod: ForkBranchMethod;
      readonly creationOperationId: string | null;
      readonly originState: "prepared" | "committed";
      readonly now: number;
      readonly committedAt: number | null;
    },
  ): void {
    this.database
      .prepare(
        `
      INSERT INTO thread_fork_origins(
        tenant_id, owner_principal_id, child_thread_id,
        provider_parent_backend_conversation_id,
        source_thread_state, source_thread_id,
        environment_id, workspace_id, backend_instance_id, connection_profile_id,
        source_turn_state, source_turn_id, source_checkpoint_id, boundary_kind,
        source_turn_revision, source_turn_completed_at,
        origin_kind, initiating_principal_id, initiating_agent_thread_id,
        initiating_tool_client_id,
        source_automation_id,
        source_automation_run_id, branch_method, creation_operation_id,
        origin_state, created_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        input.childThreadId,
        input.providerParentBackendConversationId,
        input.sourceThreadState,
        input.sourceThreadId,
        target.environmentId,
        target.workspaceId,
        target.backendInstanceId,
        target.connectionProfileId,
        input.sourceTurnState,
        input.sourceTurnId,
        input.sourceCheckpointId,
        input.boundaryKind,
        input.sourceTurnRevision,
        input.sourceTurnCompletedAt,
        input.originKind,
        input.initiatingPrincipalId,
        input.initiatingAgentThreadId,
        input.initiatingToolClientId,
        input.sourceAutomationId ?? null,
        input.sourceAutomationRunId ?? null,
        input.branchMethod,
        input.creationOperationId,
        input.originState,
        input.now,
        input.committedAt,
      );
  }

  #insertDefaultPlacement(
    scope: RequestScope,
    childThreadId: string,
    placementMode: ThreadLineagePlacementMode,
    now: number,
  ): void {
    this.database
      .prepare(
        `
      INSERT INTO thread_lineage_placement(
        tenant_id, owner_principal_id, child_thread_id,
        placement_mode, placement_state, revision, updated_at
      ) VALUES (?, ?, ?, ?, 'default', 0, ?)
    `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        childThreadId,
        placementMode,
        now,
      );
  }

  #getTarget(scope: RequestScope, threadId: string): TargetRow | undefined {
    return this.database
      .prepare(
        `
      SELECT thread.environment_id AS environmentId,
        thread.workspace_id AS workspaceId,
        thread.backend_instance_id AS backendInstanceId,
        thread.connection_profile_id AS connectionProfileId,
        thread.backing_state AS backingState,
        binding.backend_conversation_id AS backendConversationId
      FROM application_threads AS thread
      LEFT JOIN conversation_bindings AS binding
        ON binding.tenant_id = thread.tenant_id
        AND binding.owner_principal_id = thread.owner_principal_id
        AND binding.application_thread_id = thread.id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
        AND thread.id = ?
    `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      TargetRow | undefined;
  }

  #assertProviderParent(
    source: TargetRow,
    providerParentBackendConversationId: string,
  ): void {
    if (source.backendConversationId !== providerParentBackendConversationId) {
      throw new DomainError(
        "conflict",
        "The resolved source does not match the imported provider parent evidence.",
      );
    }
  }

  #matchingTargets(
    scope: RequestScope,
    sourceThreadId: string,
    childThreadId: string,
  ) {
    const source = this.#getTarget(scope, sourceThreadId);
    const child = this.#getTarget(scope, childThreadId);
    if (!source || !child)
      throw new DomainError(
        "not_found",
        "The fork source or child was not found.",
      );
    if (
      sourceThreadId === childThreadId ||
      source.environmentId !== child.environmentId ||
      source.workspaceId !== child.workspaceId ||
      source.backendInstanceId !== child.backendInstanceId ||
      source.connectionProfileId !== child.connectionProfileId
    ) {
      throw new DomainError(
        "conflict",
        "Fork source and child targets do not match.",
      );
    }
    return { source, child };
  }

  #assertCheckpoint(
    scope: RequestScope,
    checkpointId: string,
    expected:
      | {
          readonly boundaryKind: "completed_turn_inclusive";
          readonly sourceThreadId: string;
          readonly sourceTurnId: string | null;
          readonly backendInstanceId: string;
        }
      | {
          readonly boundaryKind: "provider_snapshot_at_acceptance";
          readonly sourceThreadId: string;
          readonly sourceTurnId: null;
          readonly backendInstanceId: string;
        },
  ): void {
    const row = this.database
      .prepare(
        `
      SELECT application_thread_id AS sourceThreadId,
        application_turn_id AS sourceTurnId,
        backend_instance_id AS backendInstanceId,
        boundary_kind AS boundaryKind
      FROM backend_checkpoints
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `,
      )
      .get(scope.tenantId, scope.principalId, checkpointId) as
      | {
          sourceThreadId: string;
          sourceTurnId: string | null;
          backendInstanceId: string;
          boundaryKind: string;
        }
      | undefined;
    if (
      !row ||
      row.sourceThreadId !== expected.sourceThreadId ||
      row.sourceTurnId !== expected.sourceTurnId ||
      row.backendInstanceId !== expected.backendInstanceId ||
      row.boundaryKind !== expected.boundaryKind
    ) {
      throw new DomainError(
        "conflict",
        "The fork checkpoint does not match its source turn.",
      );
    }
  }

  #assertAutomationSource(
    scope: RequestScope,
    input: PrepareThreadForkOriginInput,
  ): void {
    if (input.originKind !== "automation_fork") {
      if (input.sourceAutomationId || input.sourceAutomationRunId) {
        throw new DomainError(
          "conflict",
          "A user fork cannot claim automation provenance.",
        );
      }
      return;
    }
    if (!input.sourceAutomationId || !input.sourceAutomationRunId) {
      throw new DomainError(
        "conflict",
        "Automation fork provenance is incomplete.",
      );
    }
    const run = this.database
      .prepare(
        `
      SELECT anchor_thread_id AS anchorThreadId, child_thread_id AS childThreadId,
        dispatch_mutation_id AS dispatchMutationId, run_mode AS runMode
      FROM automation_runs
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND automation_id = ? AND id = ?
    `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        input.sourceAutomationId,
        input.sourceAutomationRunId,
      ) as
      | {
          anchorThreadId: string;
          childThreadId: string | null;
          dispatchMutationId: string;
          runMode: string;
        }
      | undefined;
    if (
      !run ||
      run.runMode !== "clone" ||
      run.anchorThreadId !== input.sourceThreadId ||
      (run.childThreadId !== null &&
        run.childThreadId !== input.childThreadId) ||
      run.dispatchMutationId !== input.creationOperationId
    ) {
      throw new DomainError(
        "conflict",
        "The automation run does not match the fork origin.",
      );
    }
  }

  #assertNoCycle(
    scope: RequestScope,
    sourceThreadId: string,
    childThreadId: string,
  ): void {
    const cycle = this.database
      .prepare(
        `
      WITH RECURSIVE ancestors(thread_id) AS (
        SELECT source_thread_id FROM thread_fork_origins
        WHERE tenant_id = ? AND owner_principal_id = ? AND child_thread_id = ?
        UNION ALL
        SELECT parent.source_thread_id FROM thread_fork_origins AS parent
        JOIN ancestors ON ancestors.thread_id = parent.child_thread_id
        WHERE parent.tenant_id = ? AND parent.owner_principal_id = ?
      ) SELECT 1 FROM ancestors WHERE thread_id = ? LIMIT 1
    `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        sourceThreadId,
        scope.tenantId,
        scope.principalId,
        childThreadId,
      );
    if (cycle)
      throw new DomainError("conflict", "Fork ancestry would form a cycle.");
  }

  #assertPrepareReplay(
    origin: ThreadForkOriginRecord,
    input: PrepareThreadForkOriginInput,
  ): void {
    if (
      origin.childThreadId !== input.childThreadId ||
      origin.sourceThreadId !== input.sourceThreadId ||
      origin.sourceTurnState !== "resolved" ||
      origin.sourceTurnId !== input.sourceTurnId ||
      origin.sourceTurnRevision !== (input.sourceTurnRevision ?? null) ||
      origin.sourceTurnCompletedAt !== input.sourceTurnCompletedAt ||
      origin.sourceCheckpointId !== input.sourceCheckpointId ||
      origin.originKind !== input.originKind ||
      origin.initiatingPrincipalId !== input.initiatingPrincipalId ||
      origin.initiatingAgentThreadId !==
        (input.initiatingAgentThreadId ?? null) ||
      origin.initiatingToolClientId !==
        (input.initiatingToolClientId ?? null) ||
      origin.sourceAutomationId !== (input.sourceAutomationId ?? null) ||
      origin.sourceAutomationRunId !== (input.sourceAutomationRunId ?? null) ||
      origin.branchMethod !== input.branchMethod
    ) {
      throw new DomainError(
        "conflict",
        "The fork operation ID was reused with different input.",
      );
    }
  }

  #assertProviderSnapshotPrepareReplay(
    origin: ThreadForkOriginRecord,
    input: PrepareProviderSnapshotForkOriginInput,
  ): void {
    if (
      origin.boundaryKind !== "provider_snapshot_at_acceptance" ||
      origin.childThreadId !== input.childThreadId ||
      origin.sourceThreadId !== input.sourceThreadId ||
      origin.sourceTurnState !== "unresolved" ||
      origin.sourceTurnId !== null ||
      origin.sourceTurnRevision !== null ||
      origin.sourceTurnCompletedAt !== null ||
      origin.sourceCheckpointId !== input.sourceCheckpointId ||
      origin.originKind !== "user_fork" ||
      origin.initiatingPrincipalId !== input.initiatingPrincipalId ||
      origin.initiatingAgentThreadId !== null ||
      origin.initiatingToolClientId !== null ||
      origin.sourceAutomationId !== null ||
      origin.sourceAutomationRunId !== null ||
      origin.branchMethod !== input.branchMethod
    ) {
      throw new DomainError(
        "conflict",
        "The fork operation ID was reused with different input.",
      );
    }
  }
}

function assertOriginRecord(
  origin: ThreadForkOriginRecord,
): ThreadForkOriginRecord {
  if (origin.boundaryKind === "completed_turn_inclusive") return origin;
  if (
    origin.boundaryKind !== "provider_snapshot_at_acceptance" ||
    origin.sourceThreadState !== "resolved" ||
    origin.sourceThreadId === null ||
    origin.sourceTurnState !== "unresolved" ||
    origin.sourceTurnId !== null ||
    origin.sourceTurnRevision !== null ||
    origin.sourceTurnCompletedAt !== null ||
    origin.sourceCheckpointId === null ||
    origin.originKind !== "user_fork" ||
    origin.initiatingPrincipalId === null ||
    origin.initiatingAgentThreadId !== null ||
    origin.initiatingToolClientId !== null ||
    origin.sourceAutomationId !== null ||
    origin.sourceAutomationRunId !== null ||
    origin.creationOperationId === null
  ) {
    throw new DomainError("conflict", "The fork boundary is corrupt.");
  }
  return origin;
}

function parsePlacementReceipt(
  json: string,
  scope: RequestScope,
  childThreadId: string,
): ThreadLineagePlacementRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new DomainError(
      "conflict",
      "The lineage placement receipt is corrupt.",
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new DomainError(
      "conflict",
      "The lineage placement receipt is corrupt.",
    );
  }
  const record = value as Partial<ThreadLineagePlacementRecord>;
  if (
    record.tenantId !== scope.tenantId ||
    record.ownerPrincipalId !== scope.principalId ||
    record.childThreadId !== childThreadId ||
    !new Set(["nested_under_source", "top_level"]).has(
      record.placementMode ?? "",
    ) ||
    record.placementState !== "explicit" ||
    !Number.isSafeInteger(record.revision) ||
    !Number.isSafeInteger(record.updatedAt)
  ) {
    throw new DomainError(
      "conflict",
      "The lineage placement receipt is corrupt.",
    );
  }
  return record as ThreadLineagePlacementRecord;
}
