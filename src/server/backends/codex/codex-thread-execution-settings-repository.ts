import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  assertCodexExecutionPolicySelection,
  isCodexApprovalPolicy,
  isCodexApprovalReviewer,
  isCodexNetworkAccess,
  isCodexSandboxMode,
  type CodexApprovalPolicy,
  type CodexApprovalReviewer,
  type CodexExecutionPolicySelection,
  type CodexNetworkAccess,
  type CodexSandboxMode,
} from "./codex-execution-policy.js";
import {
  codexServiceTierSelectionSchema,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export type { CodexServiceTierSelection } from "./codex-service-tier.js";

export interface CodexExecutionSettingsTuple
  extends CodexExecutionPolicySelection {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier: CodexServiceTierSelection;
}

export type CodexEffectiveConfirmationState =
  | "unconfirmed"
  | "confirmed"
  | "unknown";
export type CodexEffectiveAxisClassification =
  | "recognized"
  | "external_custom";

export interface CodexEffectiveSettingsObservation {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier: CodexServiceTierSelection | null;
  readonly serviceTierClassification: CodexEffectiveAxisClassification;
  readonly sandboxMode: CodexSandboxMode | null;
  readonly sandboxClassification: CodexEffectiveAxisClassification;
  readonly networkAccess: CodexNetworkAccess | null;
  readonly networkClassification: CodexEffectiveAxisClassification;
  readonly approvalPolicy: CodexApprovalPolicy | null;
  readonly approvalPolicyClassification: CodexEffectiveAxisClassification;
  readonly approvalReviewer: CodexApprovalReviewer | null;
  readonly approvalReviewerClassification: CodexEffectiveAxisClassification;
}

export interface CodexThreadExecutionSettingsRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly desired: CodexExecutionSettingsTuple | null;
  readonly effective: CodexEffectiveSettingsObservation | null;
  readonly effectiveDaemonGeneration: number | null;
  readonly effectiveConfirmationState: CodexEffectiveConfirmationState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodexExecutionSettingsSnapshotRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly applicationOperationId: string;
  readonly settingsRevision: number;
  readonly settings: CodexExecutionSettingsTuple;
  readonly createdAt: number;
}

type SettingsRow = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly desiredModel: string | null;
  readonly desiredReasoningEffort: string | null;
  readonly desiredServiceTier: string | null;
  readonly desiredSandboxMode: string | null;
  readonly desiredNetworkAccess: string | null;
  readonly desiredApprovalPolicy: string | null;
  readonly desiredApprovalReviewer: string | null;
  readonly effectiveModel: string | null;
  readonly effectiveReasoningEffort: string | null;
  readonly effectiveServiceTier: string | null;
  readonly effectiveServiceTierClassification:
    | CodexEffectiveAxisClassification
    | null;
  readonly effectiveSandboxMode: string | null;
  readonly effectiveSandboxClassification: CodexEffectiveAxisClassification | null;
  readonly effectiveNetworkAccess: string | null;
  readonly effectiveNetworkClassification: CodexEffectiveAxisClassification | null;
  readonly effectiveApprovalPolicy: string | null;
  readonly effectiveApprovalPolicyClassification: CodexEffectiveAxisClassification | null;
  readonly effectiveApprovalReviewer: string | null;
  readonly effectiveApprovalReviewerClassification: CodexEffectiveAxisClassification | null;
  readonly effectiveDaemonGeneration: number | null;
  readonly effectiveConfirmationState: CodexEffectiveConfirmationState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type SnapshotRow = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly applicationOperationId: string;
  readonly settingsRevision: number;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier: string;
  readonly sandboxMode: string;
  readonly networkAccess: string;
  readonly approvalPolicy: string;
  readonly approvalReviewer: string;
  readonly createdAt: number;
};

const settingsColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  desired_model AS desiredModel,
  desired_reasoning_effort AS desiredReasoningEffort,
  desired_service_tier AS desiredServiceTier,
  desired_sandbox_mode AS desiredSandboxMode,
  desired_network_access AS desiredNetworkAccess,
  desired_approval_policy AS desiredApprovalPolicy,
  desired_approval_reviewer AS desiredApprovalReviewer,
  effective_model AS effectiveModel,
  effective_reasoning_effort AS effectiveReasoningEffort,
  effective_service_tier AS effectiveServiceTier,
  effective_service_tier_classification AS effectiveServiceTierClassification,
  effective_sandbox_mode AS effectiveSandboxMode,
  effective_sandbox_classification AS effectiveSandboxClassification,
  effective_network_access AS effectiveNetworkAccess,
  effective_network_classification AS effectiveNetworkClassification,
  effective_approval_policy AS effectiveApprovalPolicy,
  effective_approval_policy_classification AS effectiveApprovalPolicyClassification,
  effective_approval_reviewer AS effectiveApprovalReviewer,
  effective_approval_reviewer_classification AS effectiveApprovalReviewerClassification,
  effective_daemon_generation AS effectiveDaemonGeneration,
  effective_confirmation_state AS effectiveConfirmationState,
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
  reasoning_effort AS reasoningEffort,
  service_tier AS serviceTier,
  sandbox_mode AS sandboxMode,
  network_access AS networkAccess,
  approval_policy AS approvalPolicy,
  approval_reviewer AS approvalReviewer,
  created_at AS createdAt
`;

export class CodexThreadExecutionSettingsRepository {
  constructor(readonly database: Database.Database) {}

  find(
    scope: RequestScope,
    applicationThreadId: string,
  ): CodexThreadExecutionSettingsRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${settingsColumns}
      FROM codex_thread_execution_settings
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ?
    `).get(
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
    ) as SettingsRow | undefined;
    return row ? parseSettings(row) : undefined;
  }

  initialize(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly desired: CodexExecutionSettingsTuple | null;
      readonly now: number;
    },
  ): CodexThreadExecutionSettingsRecord {
    if (input.desired !== null) assertTuple(input.desired);
    assertNow(input.now);
    const target = this.database.prepare(`
      SELECT backend.kind AS backendKind
      FROM application_threads AS thread
      JOIN agent_backend_instances AS backend
        ON backend.tenant_id = thread.tenant_id
        AND backend.id = thread.backend_instance_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
        AND thread.id = ?
    `).get(
      scope.tenantId,
      scope.principalId,
      input.applicationThreadId,
    ) as { readonly backendKind: string } | undefined;
    if (target?.backendKind !== "codex_app_server") {
      throw new DomainError("not_found", "The Codex thread was not found.");
    }
    this.database.prepare(`
      INSERT INTO codex_thread_execution_settings(
        tenant_id, owner_principal_id, application_thread_id,
        desired_model, desired_reasoning_effort, desired_service_tier,
        desired_sandbox_mode, desired_network_access, desired_approval_policy,
        desired_approval_reviewer, effective_confirmation_state,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', 0, ?, ?)
      ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
      DO NOTHING
    `).run(
      scope.tenantId,
      scope.principalId,
      input.applicationThreadId,
      input.desired?.model ?? null,
      input.desired?.reasoningEffort ?? null,
      input.desired?.serviceTier ?? null,
      input.desired?.sandboxMode ?? null,
      input.desired?.networkAccess ?? null,
      input.desired?.approvalPolicy ?? null,
      input.desired?.approvalReviewer ?? null,
      input.now,
      input.now,
    );
    return this.find(scope, input.applicationThreadId)!;
  }

  updateDesired(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly desired: CodexExecutionSettingsTuple;
      readonly now: number;
    },
  ): CodexThreadExecutionSettingsRecord {
    assertTuple(input.desired);
    assertRevision(input.expectedRevision);
    assertNow(input.now);
    const result = this.database.prepare(`
      UPDATE codex_thread_execution_settings
      SET desired_model = ?, desired_reasoning_effort = ?,
        desired_service_tier = ?, desired_sandbox_mode = ?,
        desired_network_access = ?,
        desired_approval_policy = ?, desired_approval_reviewer = ?,
        revision = revision + 1, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `).run(
      input.desired.model,
      input.desired.reasoningEffort,
      input.desired.serviceTier,
      input.desired.sandboxMode,
      input.desired.networkAccess,
      input.desired.approvalPolicy,
      input.desired.approvalReviewer,
      input.now,
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
      input.expectedRevision,
    );
    if (result.changes !== 1) throw revisionConflict();
    return this.find(scope, applicationThreadId)!;
  }

  /**
   * Adopt a complete, recognized, policy-allowed backend-observed tuple as
   * desired intent. The backend is authoritative: this overwrites any
   * existing desired tuple under the revision compare-and-set, unlike a
   * browser selection which is validated and applied through the ordinary
   * desired-update path.
   */
  adoptImportedObservation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly desired: CodexExecutionSettingsTuple;
      readonly effective: CodexEffectiveSettingsObservation | null;
      readonly daemonGeneration: number;
      readonly now: number;
    },
  ): CodexThreadExecutionSettingsRecord {
    assertTuple(input.desired);
    if (input.effective !== null) assertEffective(input.effective);
    assertRevision(input.expectedRevision);
    assertPositiveInteger(input.daemonGeneration, "daemon generation");
    assertNow(input.now);
    const result = input.effective
      ? this.database.prepare(`
          UPDATE codex_thread_execution_settings
          SET desired_model = ?, desired_reasoning_effort = ?,
            desired_service_tier = ?, desired_sandbox_mode = ?,
            desired_network_access = ?,
            desired_approval_policy = ?, desired_approval_reviewer = ?,
            effective_model = ?, effective_reasoning_effort = ?,
            effective_service_tier = ?,
            effective_service_tier_classification = ?,
            effective_sandbox_mode = ?, effective_sandbox_classification = ?,
            effective_network_access = ?, effective_network_classification = ?,
            effective_approval_policy = ?,
            effective_approval_policy_classification = ?,
            effective_approval_reviewer = ?,
            effective_approval_reviewer_classification = ?,
            effective_daemon_generation = ?,
            effective_confirmation_state = 'confirmed', revision = revision + 1,
            updated_at = max(updated_at, ?)
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = ?
        `).run(
          input.desired.model,
          input.desired.reasoningEffort,
          input.desired.serviceTier,
          input.desired.sandboxMode,
          input.desired.networkAccess,
          input.desired.approvalPolicy,
          input.desired.approvalReviewer,
          input.effective.model,
          input.effective.reasoningEffort,
          input.effective.serviceTier,
          input.effective.serviceTierClassification,
          input.effective.sandboxMode,
          input.effective.sandboxClassification,
          input.effective.networkAccess,
          input.effective.networkClassification,
          input.effective.approvalPolicy,
          input.effective.approvalPolicyClassification,
          input.effective.approvalReviewer,
          input.effective.approvalReviewerClassification,
          input.daemonGeneration,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedRevision,
        )
      : this.database.prepare(`
          UPDATE codex_thread_execution_settings
          SET desired_model = ?, desired_reasoning_effort = ?,
            desired_service_tier = ?, desired_sandbox_mode = ?,
            desired_network_access = ?,
            desired_approval_policy = ?, desired_approval_reviewer = ?,
            revision = revision + 1, updated_at = max(updated_at, ?)
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = ?
        `).run(
          input.desired.model,
          input.desired.reasoningEffort,
          input.desired.serviceTier,
          input.desired.sandboxMode,
          input.desired.networkAccess,
          input.desired.approvalPolicy,
          input.desired.approvalReviewer,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedRevision,
        );
    if (result.changes !== 1) throw revisionConflict();
    return this.find(scope, applicationThreadId)!;
  }

  confirmEffective(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly effective: CodexEffectiveSettingsObservation;
      readonly daemonGeneration: number;
      readonly now: number;
    },
  ): CodexThreadExecutionSettingsRecord {
    assertEffective(input.effective);
    assertRevision(input.expectedRevision);
    assertPositiveInteger(input.daemonGeneration, "daemon generation");
    assertNow(input.now);
    const result = this.database.prepare(`
      UPDATE codex_thread_execution_settings
      SET effective_model = ?, effective_reasoning_effort = ?,
        effective_service_tier = ?, effective_service_tier_classification = ?,
        effective_sandbox_mode = ?, effective_sandbox_classification = ?,
        effective_network_access = ?, effective_network_classification = ?,
        effective_approval_policy = ?,
        effective_approval_policy_classification = ?,
        effective_approval_reviewer = ?,
        effective_approval_reviewer_classification = ?,
        effective_daemon_generation = ?,
        effective_confirmation_state = 'confirmed', revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `).run(
      input.effective.model,
      input.effective.reasoningEffort,
      input.effective.serviceTier,
      input.effective.serviceTierClassification,
      input.effective.sandboxMode,
      input.effective.sandboxClassification,
      input.effective.networkAccess,
      input.effective.networkClassification,
      input.effective.approvalPolicy,
      input.effective.approvalPolicyClassification,
      input.effective.approvalReviewer,
      input.effective.approvalReviewerClassification,
      input.daemonGeneration,
      input.now,
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
      input.expectedRevision,
    );
    if (result.changes !== 1) throw revisionConflict();
    return this.find(scope, applicationThreadId)!;
  }

  markConfirmationUnknown(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): CodexThreadExecutionSettingsRecord {
    assertRevision(input.expectedRevision);
    assertNow(input.now);
    const result = this.database.prepare(`
      UPDATE codex_thread_execution_settings
      SET effective_daemon_generation = NULL,
        effective_confirmation_state = 'unknown', revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND revision = ?
    `).run(
      input.now,
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
      input.expectedRevision,
    );
    if (result.changes !== 1) throw revisionConflict();
    return this.find(scope, applicationThreadId)!;
  }

  invalidateConfirmedForBackend(
    scope: RequestScope,
    backendInstanceId: string,
    now: number,
  ): number {
    if (!bounded(backendInstanceId, 128)) {
      throw new Error("codex_backend_instance_id_invalid");
    }
    assertNow(now);
    const result = this.database.prepare(`
      UPDATE codex_thread_execution_settings
      SET effective_daemon_generation = NULL,
        effective_confirmation_state = 'unknown', revision = revision + 1,
        updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND effective_confirmation_state = 'confirmed'
        AND application_thread_id IN (
          SELECT id FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND backend_instance_id = ?
        )
    `).run(
      now,
      scope.tenantId,
      scope.principalId,
      scope.tenantId,
      scope.principalId,
      backendInstanceId,
    );
    return result.changes;
  }

  freezeOperationSnapshot(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
      readonly now: number;
    },
  ): CodexExecutionSettingsSnapshotRecord {
    if (!bounded(input.applicationOperationId, 128)) {
      throw new Error("codex_settings_operation_id_invalid");
    }
    assertNow(input.now);
    return this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO codex_execution_settings_snapshots(
          tenant_id, owner_principal_id, application_thread_id,
          application_operation_id, settings_revision, model,
          reasoning_effort, service_tier, sandbox_mode, network_access,
          approval_policy, approval_reviewer, created_at
        )
        SELECT tenant_id, owner_principal_id, application_thread_id,
          ?, revision, desired_model, desired_reasoning_effort,
          desired_service_tier,
          desired_sandbox_mode, desired_network_access,
          desired_approval_policy, desired_approval_reviewer, ?
        FROM codex_thread_execution_settings
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND desired_model IS NOT NULL
        ON CONFLICT DO NOTHING
      `).run(
        input.applicationOperationId,
        input.now,
        scope.tenantId,
        scope.principalId,
        input.applicationThreadId,
      );
      const snapshot = this.findOperationSnapshot(
        scope,
        input.applicationThreadId,
        input.applicationOperationId,
      );
      if (!snapshot) {
        throw new DomainError(
          "conflict",
          "The desired Codex settings are not resolved.",
        );
      }
      return snapshot;
    })();
  }

  findOperationSnapshot(
    scope: RequestScope,
    applicationThreadId: string,
    applicationOperationId: string,
  ): CodexExecutionSettingsSnapshotRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${snapshotColumns}
      FROM codex_execution_settings_snapshots
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_operation_id = ?
    `).get(
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
      applicationOperationId,
    ) as SnapshotRow | undefined;
    return row ? parseSnapshot(row) : undefined;
  }
}

function parseSettings(row: SettingsRow): CodexThreadExecutionSettingsRecord {
  const desired = row.desiredModel === null
    ? null
    : tuple(
        row.desiredModel,
        row.desiredReasoningEffort!,
        row.desiredServiceTier!,
        row.desiredSandboxMode!,
        row.desiredNetworkAccess!,
        row.desiredApprovalPolicy!,
        row.desiredApprovalReviewer!,
      );
  const effective = row.effectiveModel === null
    ? null
    : effectiveObservation(row);
  return {
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    applicationThreadId: row.applicationThreadId,
    desired,
    effective,
    effectiveDaemonGeneration: row.effectiveDaemonGeneration,
    effectiveConfirmationState: row.effectiveConfirmationState,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseSnapshot(row: SnapshotRow): CodexExecutionSettingsSnapshotRecord {
  return {
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    applicationThreadId: row.applicationThreadId,
    applicationOperationId: row.applicationOperationId,
    settingsRevision: row.settingsRevision,
    settings: tuple(
      row.model,
      row.reasoningEffort,
      row.serviceTier,
      row.sandboxMode,
      row.networkAccess,
      row.approvalPolicy,
      row.approvalReviewer,
    ),
    createdAt: row.createdAt,
  };
}

function tuple(
  model: string,
  reasoningEffort: string,
  serviceTier: string,
  sandboxMode: string,
  networkAccess: string,
  approvalPolicy: string,
  approvalReviewer: string,
): CodexExecutionSettingsTuple {
  const value = {
    model,
    reasoningEffort,
    serviceTier,
    sandboxMode,
    networkAccess,
    approvalPolicy,
    approvalReviewer,
  };
  assertTuple(value);
  return value;
}

function assertTuple(value: {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier: unknown;
  readonly sandboxMode: unknown;
  readonly networkAccess: unknown;
  readonly approvalPolicy: unknown;
  readonly approvalReviewer: unknown;
}): asserts value is CodexExecutionSettingsTuple {
  if (
    !bounded(value.model, 120) ||
    !bounded(value.reasoningEffort, 120) ||
    !isCodexServiceTierSelection(value.serviceTier)
  ) {
    throw new Error("codex_execution_settings_invalid");
  }
  try {
    assertCodexExecutionPolicySelection(value as CodexExecutionPolicySelection);
  } catch {
    throw new Error("codex_execution_settings_invalid");
  }
}

function effectiveObservation(row: SettingsRow): CodexEffectiveSettingsObservation {
  const value: CodexEffectiveSettingsObservation = {
    model: row.effectiveModel!,
    reasoningEffort: row.effectiveReasoningEffort!,
    serviceTier: isCodexServiceTierSelection(row.effectiveServiceTier)
      ? row.effectiveServiceTier
      : null,
    serviceTierClassification: row.effectiveServiceTierClassification!,
    sandboxMode: isCodexSandboxMode(row.effectiveSandboxMode)
      ? row.effectiveSandboxMode
      : null,
    sandboxClassification: row.effectiveSandboxClassification!,
    networkAccess: isCodexNetworkAccess(row.effectiveNetworkAccess)
      ? row.effectiveNetworkAccess
      : null,
    networkClassification: row.effectiveNetworkClassification!,
    approvalPolicy: isCodexApprovalPolicy(row.effectiveApprovalPolicy)
      ? row.effectiveApprovalPolicy
      : null,
    approvalPolicyClassification: row.effectiveApprovalPolicyClassification!,
    approvalReviewer: isCodexApprovalReviewer(row.effectiveApprovalReviewer)
      ? row.effectiveApprovalReviewer
      : null,
    approvalReviewerClassification:
      row.effectiveApprovalReviewerClassification!,
  };
  assertEffective(value);
  return value;
}

function assertEffective(value: CodexEffectiveSettingsObservation): void {
  if (
    !bounded(value.model, 120) ||
    !bounded(value.reasoningEffort, 120) ||
    !validAxis(
      value.serviceTier,
      value.serviceTierClassification,
      isCodexServiceTierSelection,
    ) ||
    !validAxis(value.sandboxMode, value.sandboxClassification, isCodexSandboxMode) ||
    !validAxis(value.networkAccess, value.networkClassification, isCodexNetworkAccess) ||
    !validAxis(value.approvalPolicy, value.approvalPolicyClassification, isCodexApprovalPolicy) ||
    !validAxis(value.approvalReviewer, value.approvalReviewerClassification, isCodexApprovalReviewer) ||
    (value.sandboxMode === "danger-full-access" &&
      value.networkClassification === "recognized" &&
      value.networkAccess !== "enabled")
  ) {
    throw new Error("codex_effective_execution_settings_invalid");
  }
}

export function isCodexServiceTierSelection(
  value: unknown,
): value is CodexServiceTierSelection {
  return codexServiceTierSelectionSchema.safeParse(value).success;
}

function validAxis<T extends string>(
  value: unknown,
  classification: unknown,
  guard: (input: unknown) => input is T,
): boolean {
  return classification === "recognized"
    ? guard(value)
    : classification === "external_custom" && value === null;
}

function bounded(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("codex_settings_revision_invalid");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`codex_settings_${label.replaceAll(" ", "_")}_invalid`);
  }
}

function assertNow(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("codex_settings_timestamp_invalid");
  }
}

function revisionConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The Codex execution settings changed before this operation completed.",
  );
}
