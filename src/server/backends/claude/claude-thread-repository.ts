import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  isClaudePermissionMode,
  type ClaudePermissionMode,
} from "./claude-permission-policy.js";
import { isClaudeSkillName } from "./claude-skill-name.js";

export interface ClaudeDesiredSettings {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: ClaudePermissionMode | null;
}

export type ClaudeEffectiveState = "unconfirmed" | "confirmed" | "unknown";
export type ClaudeEffectiveClassification = "recognized" | "external_custom";

export interface ClaudeThreadSettingsRecord extends ClaudeDesiredSettings {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly effectiveModel: string | null;
  readonly effectiveModelState: ClaudeEffectiveState;
  readonly effectiveModelGeneration: number | null;
  readonly effectiveEffort: string | null;
  readonly effectiveEffortState: ClaudeEffectiveState;
  readonly effectiveEffortGeneration: number | null;
  readonly effectivePermissionMode: ClaudePermissionMode | null;
  readonly effectivePermissionClassification: ClaudeEffectiveClassification | null;
  readonly effectivePermissionState: ClaudeEffectiveState;
  readonly effectivePermissionGeneration: number | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ClaudeExecutionSettingsTuple {
  readonly model: string;
  readonly effort: string | null;
  readonly permissionMode: ClaudePermissionMode;
}

export interface ClaudeOperationSettingsSnapshotRecord extends ClaudeExecutionSettingsTuple {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly applicationOperationId: string;
  readonly settingsRevision: number;
  readonly createdAt: number;
}

export interface ClaudeThreadTarget {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
}

export type ClaudeTerminalStatus = "completed" | "interrupted" | "failed";

export interface ClaudeTerminalReceipt {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendTurnId: string;
  readonly status: ClaudeTerminalStatus;
  readonly providerTerminalReason: string | null;
  readonly failureMessage: string | null;
  readonly providerResultUuid: string | null;
  readonly terminalAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Bounded provider bookends; these receipts do not imply that a task is still running. */
export interface ClaudeTaskLifecycleReceipt {
  readonly nativeTaskId: string;
  readonly nativeToolUseId: string;
  readonly description: string;
  readonly startedAt: number;
  readonly terminalStatus: "completed" | "failed" | "stopped" | null;
  readonly terminalAt: number | null;
}

export interface ClaudeUsageLedger {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly requestCount: number;
  readonly updatedAt: number;
}

export interface ClaudeSkillInvocationRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly nativeUserMessageUuid: string;
  readonly skillName: string;
  readonly createdAt: number;
}

const settingsColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  backend_instance_id AS backendInstanceId,
  connection_profile_id AS connectionProfileId,
  execution_environment_id AS executionEnvironmentId,
  desired_model AS model,
  desired_effort AS effort,
  desired_permission_mode AS permissionMode,
  effective_model AS effectiveModel,
  effective_model_state AS effectiveModelState,
  effective_model_generation AS effectiveModelGeneration,
  effective_effort AS effectiveEffort,
  effective_effort_state AS effectiveEffortState,
  effective_effort_generation AS effectiveEffortGeneration,
  effective_permission_mode AS effectivePermissionMode,
  effective_permission_classification AS effectivePermissionClassification,
  effective_permission_state AS effectivePermissionState,
  effective_permission_generation AS effectivePermissionGeneration,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const snapshotColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  application_operation_id AS applicationOperationId,
  settings_revision AS settingsRevision,
  model,
  effort,
  permission_mode AS permissionMode,
  created_at AS createdAt
`;

const terminalReceiptColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  backend_turn_id AS backendTurnId,
  status,
  provider_terminal_reason AS providerTerminalReason,
  failure_message AS failureMessage,
  provider_result_uuid AS providerResultUuid,
  terminal_at AS terminalAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const usageLedgerColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cache_read_tokens AS cacheReadTokens,
  cache_write_tokens AS cacheWriteTokens,
  request_count AS requestCount,
  updated_at AS updatedAt
`;

export class ClaudeThreadRepository {
  constructor(readonly database: Database.Database) {}

  recordSteerOperation(scope: RequestScope, applicationThreadId: string, operationId: string): void {
    this.database.prepare(`INSERT INTO claude_steer_operations
      (tenant_id, owner_principal_id, application_thread_id, application_operation_id)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(scope.tenantId, scope.principalId, applicationThreadId, operationId);
  }

  forgetUnconsumedSteerOperation(scope: RequestScope, applicationThreadId: string, operationId: string): void {
    this.database.prepare(`DELETE FROM claude_steer_operations
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
      AND application_operation_id = ? AND native_turn_root_uuid IS NULL`)
      .run(scope.tenantId, scope.principalId, applicationThreadId, operationId);
  }

  associateSteerOperation(scope: RequestScope, applicationThreadId: string, operationId: string, nativeTurnRootUuid: string): boolean {
    return this.database.prepare(`UPDATE claude_steer_operations SET native_turn_root_uuid = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
      AND application_operation_id = ? AND native_turn_root_uuid IS NULL`)
      .run(nativeTurnRootUuid, scope.tenantId, scope.principalId, applicationThreadId, operationId).changes === 1;
  }

  copySteerOperationsForFork(scope: RequestScope, input: {
    readonly sourceApplicationThreadId: string;
    readonly childApplicationThreadId: string;
    readonly nativeUserMessageMappings: readonly { readonly sourceUuid: string; readonly childUuid: string }[];
  }): void {
    const mappings = new Map(input.nativeUserMessageMappings.map(mapping => [mapping.sourceUuid, mapping.childUuid]));
    this.database.transaction(() => {
      for (const [operationId, root] of this.listSteerOperations(scope, input.sourceApplicationThreadId)) {
        const childOperation = mappings.get(operationId); const childRoot = root ? mappings.get(root) : undefined;
        if (!childOperation || !childRoot) continue;
        this.recordSteerOperation(scope, input.childApplicationThreadId, childOperation);
        this.associateSteerOperation(scope, input.childApplicationThreadId, childOperation, childRoot);
      }
    })();
  }

  listSteerOperations(scope: RequestScope, applicationThreadId: string): ReadonlyMap<string, string | null> {
    const rows = this.database.prepare(`SELECT application_operation_id AS operationId,
      native_turn_root_uuid AS root FROM claude_steer_operations
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?`)
      .all(scope.tenantId, scope.principalId, applicationThreadId) as { operationId: string; root: string | null }[];
    return new Map(rows.map(row => [row.operationId, row.root]));
  }


  initialize(
    scope: RequestScope,
    applicationThreadId: string,
    target: ClaudeThreadTarget,
    desired: ClaudeDesiredSettings,
    now: number,
  ): ClaudeThreadSettingsRecord {
    requireDesiredSettings(desired);
    requireSettingsTimestamp(now);
    this.database
      .prepare(
        `
          INSERT INTO claude_thread_settings(
            tenant_id, owner_principal_id, application_thread_id,
            backend_instance_id, connection_profile_id,
            execution_environment_id, desired_model, desired_effort,
            desired_permission_mode, effective_model_state,
            effective_effort_state, effective_permission_state,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed',
            'unconfirmed', 'unconfirmed', 0, ?, ?)
          ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
          DO NOTHING
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        target.backendInstanceId,
        target.connectionProfileId,
        target.executionEnvironmentId,
        desired.model,
        desired.effort,
        desired.permissionMode,
        now,
        now,
      );
    const record = this.get(scope, applicationThreadId);
    if (
      record.backendInstanceId !== target.backendInstanceId ||
      record.connectionProfileId !== target.connectionProfileId ||
      record.executionEnvironmentId !== target.executionEnvironmentId
    ) {
      throw new Error("claude_thread_settings_target_changed");
    }
    return record;
  }

  find(
    scope: RequestScope,
    applicationThreadId: string,
  ): ClaudeThreadSettingsRecord | undefined {
    return this.database
      .prepare(
        `SELECT ${settingsColumns}
         FROM claude_thread_settings
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ClaudeThreadSettingsRecord | undefined;
  }

  get(
    scope: RequestScope,
    applicationThreadId: string,
  ): ClaudeThreadSettingsRecord {
    const record = this.find(scope, applicationThreadId);
    if (!record) throw new Error("claude_thread_settings_missing");
    return record;
  }

  updateDesired(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly desired: ClaudeDesiredSettings;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    requireDesiredSettings(input.desired);
    requireRevision(input.expectedRevision);
    requireSettingsTimestamp(input.now);
    const changed = this.database
      .prepare(
        `
          UPDATE claude_thread_settings
          SET desired_model = ?, desired_effort = ?, desired_permission_mode = ?,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = ?
        `,
      )
      .run(
        input.desired.model,
        input.desired.effort,
        input.desired.permissionMode,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  adoptImportedPermissionMode(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly permissionMode: ClaudePermissionMode;
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    requirePermissionMode(input.permissionMode);
    requireRevision(input.expectedRevision);
    requireGeneration(input.queryGeneration);
    requireSettingsTimestamp(input.now);
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET desired_permission_mode = ?, effective_permission_mode = ?,
        effective_permission_classification = 'recognized',
        effective_permission_state = 'confirmed',
        effective_permission_generation = ?, revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
        AND desired_permission_mode IS NULL
    `,
      )
      .run(
        input.permissionMode,
        input.permissionMode,
        input.queryGeneration,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  confirmEffectiveModel(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly model: string;
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    requireBoundedSetting(input.model, 240, "model");
    return this.#confirmEffectiveAxis(scope, applicationThreadId, {
      expectedRevision: input.expectedRevision,
      column: "model",
      value: input.model,
      queryGeneration: input.queryGeneration,
      now: input.now,
    });
  }

  confirmEffectiveEffort(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly effort: string | null;
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    if (input.effort !== null) {
      requireBoundedSetting(input.effort, 120, "effort");
    }
    return this.#confirmEffectiveAxis(scope, applicationThreadId, {
      expectedRevision: input.expectedRevision,
      column: "effort",
      value: input.effort,
      queryGeneration: input.queryGeneration,
      now: input.now,
    });
  }

  confirmEffectivePermissionMode(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly permissionMode: ClaudePermissionMode | null;
      readonly classification: ClaudeEffectiveClassification;
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    if (
      (input.classification === "recognized" &&
        !isClaudePermissionMode(input.permissionMode)) ||
      (input.classification === "external_custom" &&
        input.permissionMode !== null)
    ) {
      throw new Error("claude_effective_permission_mode_invalid");
    }
    requireRevision(input.expectedRevision);
    requireGeneration(input.queryGeneration);
    requireSettingsTimestamp(input.now);
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET effective_permission_mode = ?,
        effective_permission_classification = ?,
        effective_permission_state = 'confirmed',
        effective_permission_generation = ?, revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `,
      )
      .run(
        input.permissionMode,
        input.classification,
        input.queryGeneration,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  markEffectiveUnknown(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): ClaudeThreadSettingsRecord {
    requireRevision(input.expectedRevision);
    requireSettingsTimestamp(input.now);
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET effective_model_state = 'unknown', effective_model_generation = NULL,
        effective_effort_state = 'unknown', effective_effort_generation = NULL,
        effective_permission_state = 'unknown',
        effective_permission_generation = NULL,
        revision = revision + 1, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `,
      )
      .run(
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  markEffectiveAxisUnknown(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly axis: "model" | "effort" | "permission";
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    requireRevision(input.expectedRevision);
    requireGeneration(input.queryGeneration);
    requireSettingsTimestamp(input.now);
    const prefix =
      input.axis === "permission"
        ? "effective_permission"
        : `effective_${input.axis}`;
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET ${prefix}_state = 'unknown', ${prefix}_generation = NULL,
        revision = revision + 1, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
        AND ${prefix}_generation = ?
    `,
      )
      .run(
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
        input.queryGeneration,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  invalidateConfirmedForBackend(
    scope: RequestScope,
    backendInstanceId: string,
    now: number,
  ): number {
    requireBoundedSetting(backendInstanceId, 128, "backend_instance_id");
    requireSettingsTimestamp(now);
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET effective_model_state = 'unknown', effective_model_generation = NULL,
        effective_effort_state = 'unknown', effective_effort_generation = NULL,
        effective_permission_state = 'unknown',
        effective_permission_generation = NULL,
        revision = revision + 1, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND backend_instance_id = ?
        AND (effective_model_state = 'confirmed'
          OR effective_effort_state = 'confirmed'
          OR effective_permission_state = 'confirmed')
    `,
      )
      .run(now, scope.tenantId, scope.principalId, backendInstanceId);
    return changed.changes;
  }

  freezeOperationSettings(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly applicationOperationId: string; readonly now: number },
  ): ClaudeOperationSettingsSnapshotRecord {
    requireBoundedSetting(input.applicationOperationId, 128, "operation_id");
    requireSettingsTimestamp(input.now);
    const settings = this.get(scope, applicationThreadId);
    if (!settings.model || !settings.permissionMode) {
      throw new Error("claude_thread_settings_unresolved");
    }
    this.database
      .prepare(
        `
      INSERT INTO claude_operation_settings_snapshots(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id, settings_revision, model, effort,
        permission_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id
      ) DO NOTHING
    `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.applicationOperationId,
        settings.revision,
        settings.model,
        settings.effort,
        settings.permissionMode,
        input.now,
      );
    const snapshot = this.findOperationSettingsSnapshot(
      scope,
      applicationThreadId,
      input.applicationOperationId,
    );
    if (!snapshot) throw new Error("claude_operation_settings_snapshot_failed");
    return snapshot;
  }

  freezeOperationSnapshot(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
      readonly now: number;
    },
  ): ClaudeOperationSettingsSnapshotRecord {
    return this.freezeOperationSettings(scope, input.applicationThreadId, {
      applicationOperationId: input.applicationOperationId,
      now: input.now,
    });
  }

  findOperationSettingsSnapshot(
    scope: RequestScope,
    applicationThreadId: string,
    applicationOperationId: string,
  ): ClaudeOperationSettingsSnapshotRecord | undefined {
    return this.database
      .prepare(
        `
      SELECT ${snapshotColumns}
      FROM claude_operation_settings_snapshots
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_operation_id = ?
    `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        applicationOperationId,
      ) as ClaudeOperationSettingsSnapshotRecord | undefined;
  }

  findOperationSnapshot(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
    },
  ): ClaudeOperationSettingsSnapshotRecord | undefined {
    return this.findOperationSettingsSnapshot(
      scope,
      input.applicationThreadId,
      input.applicationOperationId,
    );
  }

  hasOperationSnapshot(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
    },
  ): boolean {
    return (
      this.database
        .prepare(
          `
      SELECT 1
      FROM claude_operation_settings_snapshots
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_operation_id = ?
    `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          input.applicationThreadId,
          input.applicationOperationId,
        ) !== undefined
    );
  }

  copyOperationSnapshotsForFork(
    scope: RequestScope,
    input: {
      readonly sourceApplicationThreadId: string;
      readonly childApplicationThreadId: string;
      readonly applicationOperationIds: Iterable<string>;
    },
  ): void {
    const copy = this.database.prepare(`
      INSERT INTO claude_operation_settings_snapshots(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id, settings_revision, model, effort,
        permission_mode, created_at
      )
      SELECT tenant_id, owner_principal_id, ?, application_operation_id,
        settings_revision, model, effort, permission_mode, created_at
      FROM claude_operation_settings_snapshots
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_operation_id = ?
      ON CONFLICT(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id
      ) DO NOTHING
    `);
    this.database.transaction(() => {
      for (const applicationOperationId of input.applicationOperationIds) {
        requireBoundedSetting(applicationOperationId, 128, "operation_id");
        copy.run(
          input.childApplicationThreadId,
          scope.tenantId,
          scope.principalId,
          input.sourceApplicationThreadId,
          applicationOperationId,
        );
      }
    })();
  }

  recordSkillInvocation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly nativeUserMessageUuid: string;
      readonly skillName: string;
      readonly now: number;
    },
  ): ClaudeSkillInvocationRecord {
    requireBoundedSetting(
      input.nativeUserMessageUuid,
      128,
      "native_user_message_uuid",
    );
    if (!isClaudeSkillName(input.skillName)) {
      throw new Error("claude_skill_invocation_name_invalid");
    }
    requireSettingsTimestamp(input.now);
    this.get(scope, applicationThreadId);
    this.database
      .prepare(
        `INSERT INTO claude_skill_invocations(
          tenant_id, owner_principal_id, application_thread_id,
          native_user_message_uuid, skill_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          tenant_id, owner_principal_id, application_thread_id,
          native_user_message_uuid
        ) DO NOTHING`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.nativeUserMessageUuid,
        input.skillName,
        input.now,
      );
    const record = this.findSkillInvocation(
      scope,
      applicationThreadId,
      input.nativeUserMessageUuid,
    );
    if (!record || record.skillName !== input.skillName) {
      throw new Error("claude_skill_invocation_replay_mismatch");
    }
    return record;
  }

  findSkillInvocation(
    scope: RequestScope,
    applicationThreadId: string,
    nativeUserMessageUuid: string,
  ): ClaudeSkillInvocationRecord | undefined {
    requireBoundedSetting(
      nativeUserMessageUuid,
      128,
      "native_user_message_uuid",
    );
    return this.database
      .prepare(
        `SELECT tenant_id AS tenantId,
          owner_principal_id AS ownerPrincipalId,
          application_thread_id AS applicationThreadId,
          native_user_message_uuid AS nativeUserMessageUuid,
          skill_name AS skillName,
          created_at AS createdAt
        FROM claude_skill_invocations
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND native_user_message_uuid = ?`,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        nativeUserMessageUuid,
      ) as ClaudeSkillInvocationRecord | undefined;
  }

  copySkillInvocationsForFork(
    scope: RequestScope,
    input: {
      readonly sourceApplicationThreadId: string;
      readonly childApplicationThreadId: string;
      readonly nativeUserMessageMappings: Iterable<{
        readonly sourceUuid: string;
        readonly childUuid: string;
      }>;
    },
  ): void {
    this.get(scope, input.sourceApplicationThreadId);
    this.get(scope, input.childApplicationThreadId);
    const copy = this.database.prepare(
      `INSERT INTO claude_skill_invocations(
        tenant_id, owner_principal_id, application_thread_id,
        native_user_message_uuid, skill_name, created_at
      )
      SELECT tenant_id, owner_principal_id, ?, ?, skill_name, created_at
      FROM claude_skill_invocations
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND native_user_message_uuid = ?
      ON CONFLICT(
        tenant_id, owner_principal_id, application_thread_id,
        native_user_message_uuid
      ) DO NOTHING`,
    );
    this.database.transaction(() => {
      for (const mapping of input.nativeUserMessageMappings) {
        requireBoundedSetting(mapping.sourceUuid, 128, "source_uuid");
        requireBoundedSetting(mapping.childUuid, 128, "child_uuid");
        copy.run(
          input.childApplicationThreadId,
          mapping.childUuid,
          scope.tenantId,
          scope.principalId,
          input.sourceApplicationThreadId,
          mapping.sourceUuid,
        );
        const source = this.findSkillInvocation(
          scope,
          input.sourceApplicationThreadId,
          mapping.sourceUuid,
        );
        const child = this.findSkillInvocation(
          scope,
          input.childApplicationThreadId,
          mapping.childUuid,
        );
        if ((child?.skillName ?? null) !== (source?.skillName ?? null)) {
          throw new Error("claude_skill_invocation_fork_mismatch");
        }
      }
    })();
  }

  #confirmEffectiveAxis(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly column: "model" | "effort";
      readonly value: string | null;
      readonly queryGeneration: number;
      readonly now: number;
    },
  ): ClaudeThreadSettingsRecord {
    requireRevision(input.expectedRevision);
    requireGeneration(input.queryGeneration);
    requireSettingsTimestamp(input.now);
    if (input.column === "model" && input.value === null) {
      throw new Error("claude_effective_model_invalid");
    }
    const valueColumn =
      input.column === "model" ? "effective_model" : "effective_effort";
    const stateColumn = `${valueColumn}_state`;
    const generationColumn = `${valueColumn}_generation`;
    const changed = this.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET ${valueColumn} = ?, ${stateColumn} = 'confirmed',
        ${generationColumn} = ?, revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `,
      )
      .run(
        input.value,
        input.queryGeneration,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("claude_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  writeTaskStarted(scope: RequestScope, applicationThreadId: string, nativeSessionId: string, input: {
    nativeTaskId: string; nativeToolUseId: string; description: string; now: number;
  }): void {
    requireBoundedText(nativeSessionId, 512, "native_session_id");
    requireBoundedText(input.nativeTaskId, 512, "native_task_id");
    requireBoundedText(input.nativeToolUseId, 512, "native_tool_use_id");
    requireTimestamp(input.now, "started_at");
    this.database.prepare(`INSERT INTO claude_task_lifecycle_receipts
      (tenant_id, owner_principal_id, application_thread_id, native_session_id, native_task_id, native_tool_use_id, description, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
      scope.tenantId, scope.principalId, applicationThreadId, nativeSessionId, input.nativeTaskId,
      input.nativeToolUseId, input.description.slice(0, 1024), input.now);
  }

  writeTaskTerminal(scope: RequestScope, applicationThreadId: string, nativeSessionId: string, input: {
    nativeTaskId: string; nativeToolUseId?: string; status: "completed" | "failed" | "stopped"; now: number;
  }): boolean {
    requireBoundedText(nativeSessionId, 512, "native_session_id");
    requireBoundedText(input.nativeTaskId, 512, "native_task_id");
    requireTimestamp(input.now, "terminal_at");
    if (!["completed", "failed", "stopped"].includes(input.status)) throw new Error("claude_task_status_invalid");
    // Only the exact observed launch can acquire a terminal receipt. An absent
    // tool id is usable only while exactly one matching launch is outstanding.
    const result = this.database.prepare(`UPDATE claude_task_lifecycle_receipts SET terminal_status = ?, terminal_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
        AND native_session_id = ? AND native_task_id = ? AND terminal_status IS NULL
        AND (? IS NULL OR native_tool_use_id = ?)
        AND (SELECT COUNT(*) FROM claude_task_lifecycle_receipts
          WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
            AND native_session_id = ? AND native_task_id = ? AND terminal_status IS NULL
            AND (? IS NULL OR native_tool_use_id = ?)) = 1`).run(
      input.status, input.now, scope.tenantId, scope.principalId, applicationThreadId, nativeSessionId, input.nativeTaskId,
      input.nativeToolUseId ?? null, input.nativeToolUseId ?? null,
      scope.tenantId, scope.principalId, applicationThreadId, nativeSessionId, input.nativeTaskId,
      input.nativeToolUseId ?? null, input.nativeToolUseId ?? null);
    return result.changes === 1;
  }

  copyTaskLifecycleReceiptsForFork(scope: RequestScope, input: {
    readonly sourceApplicationThreadId: string;
    readonly sourceNativeSessionId: string;
    readonly childApplicationThreadId: string;
    readonly childNativeSessionId: string;
    readonly nativeToolUseIds: Iterable<string>;
  }): void {
    this.get(scope, input.sourceApplicationThreadId);
    this.get(scope, input.childApplicationThreadId);
    requireBoundedText(input.sourceNativeSessionId, 512, "source_native_session_id");
    requireBoundedText(input.childNativeSessionId, 512, "child_native_session_id");
    const copy = this.database.prepare(`INSERT INTO claude_task_lifecycle_receipts
      (tenant_id, owner_principal_id, application_thread_id, native_session_id, native_task_id,
       native_tool_use_id, description, started_at, terminal_status, terminal_at)
      SELECT tenant_id, owner_principal_id, ?, ?, native_task_id,
        native_tool_use_id, description, started_at, terminal_status, terminal_at
      FROM claude_task_lifecycle_receipts WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND native_session_id = ? AND native_tool_use_id = ?
      ON CONFLICT DO NOTHING`);
    this.database.transaction(() => {
      for (const toolUseId of input.nativeToolUseIds) {
        requireBoundedText(toolUseId, 512, "native_tool_use_id");
        copy.run(input.childApplicationThreadId, input.childNativeSessionId,
          scope.tenantId, scope.principalId, input.sourceApplicationThreadId, input.sourceNativeSessionId, toolUseId);
      }
    })();
  }

  listTaskLifecycleReceipts(scope: RequestScope, applicationThreadId: string, nativeSessionId: string): readonly ClaudeTaskLifecycleReceipt[] {
    return this.database.prepare(`SELECT native_task_id AS nativeTaskId, native_tool_use_id AS nativeToolUseId,
      description, started_at AS startedAt, terminal_status AS terminalStatus, terminal_at AS terminalAt
      FROM claude_task_lifecycle_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND native_session_id = ?
      ORDER BY started_at, native_task_id, native_tool_use_id`).all(scope.tenantId, scope.principalId, applicationThreadId, nativeSessionId) as ClaudeTaskLifecycleReceipt[];
  }

  writeTerminalReceipt(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly backendTurnId: string;
      readonly status: ClaudeTerminalStatus;
      readonly providerTerminalReason?: string;
      readonly failureMessage?: string;
      readonly providerResultUuid?: string;
      readonly terminalAt: number;
      readonly now: number;
    },
  ): ClaudeTerminalReceipt {
    requireBoundedText(input.backendTurnId, 512, "backend_turn_id");
    if (
      input.status !== "completed" &&
      input.status !== "interrupted" &&
      input.status !== "failed"
    ) {
      throw new Error("claude_terminal_receipt_status_invalid");
    }
    if (input.providerTerminalReason !== undefined) {
      requireBoundedBytes(
        input.providerTerminalReason,
        2_048,
        "provider_terminal_reason",
      );
    }
    if (input.providerResultUuid !== undefined) {
      requireBoundedBytes(
        input.providerResultUuid,
        2_048,
        "provider_result_uuid",
      );
    }
    if (input.failureMessage !== undefined) {
      if (input.status !== "failed") throw new Error("claude_terminal_failure_status_invalid");
      requireBoundedBytes(input.failureMessage, 1024, "failure_message");
    }
    requireTimestamp(input.terminalAt, "terminal_at");
    requireTimestamp(input.now, "created_at");

    this.database
      .prepare(
        `
          INSERT INTO claude_turn_terminal_receipts(
            tenant_id, owner_principal_id, application_thread_id,
            backend_turn_id, status, provider_terminal_reason,
            provider_result_uuid, terminal_at, created_at, updated_at, failure_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(
            tenant_id, owner_principal_id, application_thread_id,
            backend_turn_id
          ) DO NOTHING
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.backendTurnId,
        input.status,
        input.providerTerminalReason ?? null,
        input.providerResultUuid ?? null,
        input.terminalAt,
        input.now,
        input.now,
        input.failureMessage ?? null,
      );
    const receipt = this.findTerminalReceipt(scope, {
      applicationThreadId,
      backendTurnId: input.backendTurnId,
    });
    if (!receipt) throw new Error("claude_terminal_receipt_write_failed");
    if (receipt.status !== input.status) {
      throw new Error("claude_terminal_receipt_status_conflict");
    }
    return receipt;
  }

  findTerminalReceipt(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly backendTurnId: string;
    },
  ): ClaudeTerminalReceipt | undefined {
    return this.database
      .prepare(
        `SELECT ${terminalReceiptColumns}
         FROM claude_turn_terminal_receipts
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND backend_turn_id = ?`,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        input.applicationThreadId,
        input.backendTurnId,
      ) as ClaudeTerminalReceipt | undefined;
  }

  listTerminalReceipts(
    scope: RequestScope,
    applicationThreadId: string,
  ): readonly ClaudeTerminalReceipt[] {
    return this.database
      .prepare(
        `SELECT ${terminalReceiptColumns}
         FROM claude_turn_terminal_receipts
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?
         ORDER BY terminal_at, backend_turn_id`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      ) as ClaudeTerminalReceipt[];
  }

  findUsageLedger(
    scope: RequestScope,
    applicationThreadId: string,
  ): ClaudeUsageLedger | undefined {
    return this.database
      .prepare(
        `SELECT ${usageLedgerColumns}
         FROM claude_usage_ledgers
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ClaudeUsageLedger | undefined;
  }

  writeUsageLedger(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly requestCount: number;
      readonly now: number;
    },
  ): ClaudeUsageLedger {
    for (const [field, value] of Object.entries({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      requestCount: input.requestCount,
    })) {
      requireUsageInteger(value, field);
    }
    requireTimestamp(input.now, "updated_at");
    this.database
      .prepare(
        `
          INSERT INTO claude_usage_ledgers(
            tenant_id, owner_principal_id, application_thread_id,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, request_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
          DO UPDATE SET
            input_tokens = max(input_tokens, excluded.input_tokens),
            output_tokens = max(output_tokens, excluded.output_tokens),
            cache_read_tokens = max(cache_read_tokens, excluded.cache_read_tokens),
            cache_write_tokens = max(cache_write_tokens, excluded.cache_write_tokens),
            request_count = max(request_count, excluded.request_count),
            updated_at = max(updated_at, excluded.updated_at)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.requestCount,
        input.now,
      );
    const ledger = this.findUsageLedger(scope, applicationThreadId);
    if (!ledger) throw new Error("claude_usage_ledger_write_failed");
    return ledger;
  }
}

function requireBoundedText(
  value: string,
  maximumCharacters: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumCharacters
  ) {
    throw new Error(`claude_terminal_receipt_${field}_invalid`);
  }
}

function requireBoundedBytes(
  value: string,
  maximumBytes: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`claude_terminal_receipt_${field}_invalid`);
  }
}

function requireTimestamp(value: number, field: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new Error(`claude_terminal_receipt_${field}_invalid`);
  }
}

function requireUsageInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`claude_usage_ledger_${field}_invalid`);
  }
}

function requireBoundedSetting(
  value: string,
  maximumCharacters: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumCharacters
  ) {
    throw new Error(`claude_thread_settings_${field}_invalid`);
  }
}

function requirePermissionMode(
  value: unknown,
): asserts value is ClaudePermissionMode {
  if (!isClaudePermissionMode(value)) {
    throw new Error("claude_thread_settings_permission_mode_invalid");
  }
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("claude_thread_settings_revision_invalid");
  }
}

function requireGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("claude_thread_settings_query_generation_invalid");
  }
}

function requireSettingsTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("claude_thread_settings_timestamp_invalid");
  }
}

function requireDesiredSettings(value: ClaudeDesiredSettings): void {
  const hasModel = value.model !== null;
  if (
    (!hasModel && value.effort !== null) ||
    (hasModel && !boundedSetting(value.model, 240)) ||
    (value.effort !== null && !boundedSetting(value.effort, 120)) ||
    (value.permissionMode !== null &&
      !isClaudePermissionMode(value.permissionMode))
  ) {
    throw new Error("claude_thread_desired_settings_invalid");
  }
}

function boundedSetting(
  value: unknown,
  maximumCharacters: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumCharacters
  );
}
