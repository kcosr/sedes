import { claudeTurnFailureDetailsMigration } from "./migrations/109-claude-turn-failure-details.js";
import { forkEnvironmentFingerprintsMigration } from "./migrations/108-fork-environment-fingerprints.js";
import { scopedEnvironmentVariablesMigration } from "./migrations/107-scoped-environment-variables.js";
import { classifiedCompletionResultMigration } from "./migrations/104-classified-completion-result.js";
import { notificationAssistantResultPhasesMigration } from "./migrations/105-notification-assistant-result-phases.js";
import { notificationPhaseSelectionMigration } from "./migrations/106-notification-phase-selection.js";
import { notificationAssistantResultMigration } from "./migrations/103-notification-assistant-result.js";
import { claudeSteerOperationsMigration } from "./migrations/102-claude-steer-operations.js";
import { steerTargetsMigration } from "./migrations/101-steer-targets.js";
import { claudeTaskLifecycleMigration } from "./migrations/100-claude-task-lifecycle.js";
import { outboundHostPairingMigration } from "./migrations/097-outbound-host-pairing.js";
import { projectRemovalMigration } from "./migrations/099-project-removal.js";
import { applicationSummaryActiveIndexesMigration } from "./migrations/098-application-summary-active-indexes.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { databaseOwnedConfigurationMigration } from "./migrations/093-database-owned-configuration.js";
import { codexApplicationReceiptProofsMigration } from "./migrations/095-codex-application-receipt-proofs.js";
import { codexRuntimeReceiptsMigration } from "./migrations/094-codex-runtime-receipts.js";
import { codexConfigurationStoreIdentityMigration } from "./migrations/096-codex-configuration-store-identity.js";
import type { ResolvedBackendConfigurationFile } from "../config/backend-configuration.js";
import { deriveConnectionProfileId } from "./connection-profile-id.js";
import { initialMigration } from "./migrations/001-initial.js";
import { seedSingleUserMigration } from "./migrations/002-seed-single-user.js";
import { automationFoundationMigration } from "./migrations/003-automation-foundation.js";
import { automationDispatchMigration } from "./migrations/004-automation-dispatch.js";
import { threadAutomationMigration } from "./migrations/005-thread-automation.js";
import { threadAutomationIdempotencyMigration } from "./migrations/006-thread-automation-idempotency.js";
import { automationPrechecksAttentionMigration } from "./migrations/007-automation-prechecks-attention.js";
import { threadCompletionAttentionMigration } from "./migrations/008-thread-completion-attention.js";
import { threadCompletionAttentionConstraintsMigration } from "./migrations/009-thread-completion-attention-constraints.js";
import { backendNormalizationMigration } from "./migrations/010-backend-normalization.js";
import { connectionSettingPreferencesMigration } from "./migrations/011-connection-setting-preferences.js";
import { normalizedSchemaCorrectionsMigration } from "./migrations/012-normalized-schema-corrections.js";
import { applicationSummaryIndexMigration } from "./migrations/013-application-summary-index.js";
import { multiBackendKindsMigration } from "./migrations/014-multi-backend-kinds.js";
import { configurationFingerprintsMigration } from "./migrations/015-configuration-fingerprints.js";
import { agentToolCoreMigration } from "./migrations/016-agent-tool-core.js";
import { codexThreadExecutionSettingsMigration } from "./migrations/017-codex-thread-execution-settings.js";
import { codexExecutionPolicyAxesMigration } from "./migrations/018-codex-execution-policy-axes.js";
import { piToolAccessAskMigration } from "./migrations/019-pi-tool-access-ask.js";
import { threadLineageMigration } from "./migrations/020-thread-lineage.js";
import { codexNativeForkMigration } from "./migrations/021-codex-native-fork.js";
import { lineageForkPointContextMigration } from "./migrations/022-lineage-fork-point-context.js";
import { forkContextBoundaryMigration } from "./migrations/023-fork-context-boundary.js";
import { tasksMigration } from "./migrations/024-tasks.js";
import { largeTaskDetailsMigration } from "./migrations/025-large-task-details.js";
import { composerSkillsMigration } from "./migrations/026-composer-skills.js";
import { sshExecutionEnvironmentsMigration } from "./migrations/027-ssh-execution-environments.js";
import { threadAgentToolPolicyMigration } from "./migrations/028-thread-agent-tool-policy.js";
import { removeAgentExecutionLifecycleMigration } from "./migrations/029-remove-agent-execution-lifecycle.js";
import { workspaceFileRootsMigration } from "./migrations/030-workspace-file-roots.js";
import { multipleSshExecutionEnvironmentsMigration } from "./migrations/031-multiple-ssh-execution-environments.js";
import { workspaceEnvironmentAuthorityMigration } from "./migrations/032-workspace-environment-authority.js";
import { singleLocalExecutionEnvironmentMigration } from "./migrations/033-single-local-execution-environment.js";
import { taskFilesPinsMigration } from "./migrations/034-task-files-pins.js";
import { workspaceFileLinkRootsMigration } from "./migrations/035-workspace-file-link-roots.js";
import { removeWorkspaceFileLinkRootRecencyMigration } from "./migrations/036-remove-workspace-file-link-root-recency.js";
import { skillOnlyInputMigration } from "./migrations/037-skill-only-input.js";
import { contextExcerptsMigration } from "./migrations/038-context-excerpts.js";
import { codexFastModeMigration } from "./migrations/039-codex-fast-mode.js";
import { contextExcerptSkillUpdateGuardsMigration } from "./migrations/040-context-excerpt-skill-update-guards.js";
import { removeInteractionTimersMigration } from "./migrations/041-remove-interaction-timers.js";
import { pendingInputActionsMigration } from "./migrations/042-pending-input-actions.js";
import { threadForceResetMigration } from "./migrations/043-thread-force-reset.js";
import { taskCreateFingerprintsMigration } from "./migrations/044-task-create-fingerprints.js";
import { executionEnvironmentOperationsConfigurationMigration } from "./migrations/045-execution-environment-operations-configuration.js";
import { principalApplicationPreferencesMigration } from "./migrations/046-principal-application-preferences.js";
import { progressiveAgentToolPresentationMigration } from "./migrations/047-progressive-agent-tool-presentation.js";
import { savedAgentsMigration } from "./migrations/048-saved-agents.js";
import { claudeAgentSdkBackendMigration } from "./migrations/049-claude-agent-sdk-backend.js";
import { agentControlProvenanceMigration } from "./migrations/050-agent-control-provenance.js";
import { composerAttachmentsMigration } from "./migrations/051-composer-attachments.js";
import { principalThreadActivityIndexMigration } from "./migrations/052-principal-thread-activity-index.js";
import { workspaceDiffReviewsMigration } from "./migrations/053-workspace-diff-reviews.js";
import { claudePermissionSettingsMigration } from "./migrations/054-claude-permission-settings.js";
import { composerTaskReferencesMigration } from "./migrations/055-composer-task-references.js";
import { agentToolEnvironmentAccessMigration } from "./migrations/056-agent-tool-environment-access.js";
import { providerSnapshotForkLineageMigration } from "./migrations/057-provider-snapshot-fork-lineage.js";
import { durableSteerIntentsMigration } from "./migrations/058-durable-steer-intents.js";
import { steerFallbackMigration } from "./migrations/059-steer-fallback.js";
import { principalAgentToolClientsMigration } from "./migrations/060-principal-agent-tool-clients.js";
import { principalToolClientProvenanceMigration } from "./migrations/061-principal-tool-client-provenance.js";
import { threadPinningMigration } from "./migrations/062-thread-pinning.js";
import { grokBuildBackendMigration } from "./migrations/063-grok-build-backend.js";
import { grokModelSettingsMigration } from "./migrations/064-grok-model-settings.js";
import { deliveryInputSnapshotsMigration } from "./migrations/065-delivery-input-snapshots.js";
import { outputImageArtifactsMigration } from "./migrations/066-output-image-artifacts.js";
import { piSandboxAllocationsMigration } from "./migrations/067-pi-sandbox-allocations.js";
import { piSandboxWorkspaceAccessMigration } from "./migrations/068-pi-sandbox-workspace-access.js";
import { mutableBackendProtocolReleaseMigration } from "./migrations/069-mutable-backend-protocol-release.js";
import { nativeForkLineageMigration } from "./migrations/070-native-fork-lineage.js";
import { threadGroupsMigration } from "./migrations/071-thread-groups.js";
import { claudeSkillInvocationsMigration } from "./migrations/072-claude-skill-invocations.js";
import { claudeEffortlessModelsMigration } from "./migrations/073-claude-effortless-models.js";
import { threadTemplatesMigration } from "./migrations/074-thread-templates.js";
import { threadSavedAgentOriginsMigration } from "./migrations/075-thread-saved-agent-origins.js";
import { conversationTurnBookmarksMigration } from "./migrations/076-conversation-turn-bookmarks.js";
import { cannedPromptsMigration } from "./migrations/077-canned-prompts.js";
import { deliveryResolutionMigration } from "./migrations/078-delivery-resolution.js";
import { renameSavedAgentToolsMigration } from "./migrations/079-rename-saved-agent-tools.js";
import { terminalResourcesMigration } from "./migrations/080-terminal-resources.js";
import { terminalEndCleanupPhaseMigration } from "./migrations/081-terminal-end-cleanup-phase.js";
import { agentCompletionCallbacksMigration } from "./migrations/082-agent-completion-callbacks.js";
import { linkedWorktreeFilesRootsMigration } from "./migrations/083-linked-worktree-files-roots.js";
import { threadWorktreePreferenceMigration } from "./migrations/084-thread-worktree-preference.js";
import { agentToolPresentationAxesMigration } from "./migrations/085-agent-tool-presentation-axes.js";
import { terminalTerminationEffectMigration } from "./migrations/086-terminal-termination-effect.js";
import { notificationSettingsMigration } from "./migrations/087-notification-settings.js";
import { questionRequestsMigration } from "./migrations/088-question-requests.js";
import { questionResponseStateMigration } from "./migrations/089-question-response-state.js";

import { questionResolutionStatusMigration } from "./migrations/090-question-resolution-status.js";
import { workpadsMigration } from "./migrations/091-workpads.js";

import { agentToolAccessBoundaryMigration } from "./migrations/092-agent-tool-access-boundary.js";

export const deployedMigrations = [
  initialMigration,
  seedSingleUserMigration,
  automationFoundationMigration,
  automationDispatchMigration,
  threadAutomationMigration,
  threadAutomationIdempotencyMigration,
  automationPrechecksAttentionMigration,
  threadCompletionAttentionMigration,
  threadCompletionAttentionConstraintsMigration,
] as const;

export const backendNormalizationCutoverMigrations = [
  ...deployedMigrations,
  backendNormalizationMigration,
  connectionSettingPreferencesMigration,
  normalizedSchemaCorrectionsMigration,
  applicationSummaryIndexMigration,
] as const;

export const backendNormalizedMigrations = [
  ...backendNormalizationCutoverMigrations,
  multiBackendKindsMigration,
  configurationFingerprintsMigration,
  agentToolCoreMigration,
  codexThreadExecutionSettingsMigration,
  codexExecutionPolicyAxesMigration,
  piToolAccessAskMigration,
  threadLineageMigration,
  codexNativeForkMigration,
  lineageForkPointContextMigration,
  forkContextBoundaryMigration,
  tasksMigration,
  largeTaskDetailsMigration,
  composerSkillsMigration,
  sshExecutionEnvironmentsMigration,
  threadAgentToolPolicyMigration,
  removeAgentExecutionLifecycleMigration,
  workspaceFileRootsMigration,
  multipleSshExecutionEnvironmentsMigration,
  workspaceEnvironmentAuthorityMigration,
  singleLocalExecutionEnvironmentMigration,
  taskFilesPinsMigration,
  workspaceFileLinkRootsMigration,
  removeWorkspaceFileLinkRootRecencyMigration,
  skillOnlyInputMigration,
  contextExcerptsMigration,
  codexFastModeMigration,
  contextExcerptSkillUpdateGuardsMigration,
  removeInteractionTimersMigration,
  pendingInputActionsMigration,
  threadForceResetMigration,
  taskCreateFingerprintsMigration,
  executionEnvironmentOperationsConfigurationMigration,
  principalApplicationPreferencesMigration,
  progressiveAgentToolPresentationMigration,
  savedAgentsMigration,
  claudeAgentSdkBackendMigration,
  agentControlProvenanceMigration,
  composerAttachmentsMigration,
  principalThreadActivityIndexMigration,
  workspaceDiffReviewsMigration,
  claudePermissionSettingsMigration,
  composerTaskReferencesMigration,
  agentToolEnvironmentAccessMigration,
  providerSnapshotForkLineageMigration,
  durableSteerIntentsMigration,
  steerFallbackMigration,
  principalAgentToolClientsMigration,
  principalToolClientProvenanceMigration,
  threadPinningMigration,
  grokBuildBackendMigration,
  grokModelSettingsMigration,
  deliveryInputSnapshotsMigration,
  outputImageArtifactsMigration,
  piSandboxAllocationsMigration,
  piSandboxWorkspaceAccessMigration,
  mutableBackendProtocolReleaseMigration,
  nativeForkLineageMigration,
  threadGroupsMigration,
  claudeSkillInvocationsMigration,
  claudeEffortlessModelsMigration,
  threadTemplatesMigration,
  threadSavedAgentOriginsMigration,
  conversationTurnBookmarksMigration,
  cannedPromptsMigration,
  deliveryResolutionMigration,
  renameSavedAgentToolsMigration,
  terminalResourcesMigration,
  terminalEndCleanupPhaseMigration,
  agentCompletionCallbacksMigration,
  linkedWorktreeFilesRootsMigration,
  threadWorktreePreferenceMigration,
  agentToolPresentationAxesMigration,
  terminalTerminationEffectMigration,
  notificationSettingsMigration,
  questionRequestsMigration,
  questionResponseStateMigration,
  questionResolutionStatusMigration,
  workpadsMigration,
  agentToolAccessBoundaryMigration,
  databaseOwnedConfigurationMigration,
  codexRuntimeReceiptsMigration,
  codexApplicationReceiptProofsMigration,
  codexConfigurationStoreIdentityMigration,
  outboundHostPairingMigration,
  applicationSummaryActiveIndexesMigration,
  projectRemovalMigration,
  claudeTaskLifecycleMigration,
  steerTargetsMigration,
  claudeSteerOperationsMigration,
  notificationAssistantResultMigration,
  classifiedCompletionResultMigration,
  notificationAssistantResultPhasesMigration,
  notificationPhaseSelectionMigration,
  scopedEnvironmentVariablesMigration,
  forkEnvironmentFingerprintsMigration,
  claudeTurnFailureDetailsMigration,
] as const;

export type DatabaseMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly requiresForeignKeysDisabled?: true;
  readonly requiresLegacyAlterTable?: true;
  readonly verifyDatabaseIntegrity?: true;
  readonly preflight?: (database: Database.Database) => void;
};

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function taskCreateReceiptFingerprint(resultJson: string): string {
  const parsed = JSON.parse(resultJson) as {
    readonly record: {
      readonly title: string;
      readonly details: string;
      readonly pinned: boolean;
      readonly files: readonly string[];
      readonly scopeKind: "global" | "workspace" | "thread";
      readonly workspaceId: string | null;
      readonly threadId: string | null;
    };
  };
  const record = parsed.record;
  const scope =
    record.scopeKind === "workspace"
      ? ["workspace", record.workspaceId]
      : record.scopeKind === "thread"
        ? ["thread", record.threadId]
        : ["global"];
  return createHash("sha256")
    .update(
      JSON.stringify([
        "create_task",
        record.title,
        record.details,
        record.pinned,
        record.files,
        ...scope,
      ]),
    )
    .digest("hex");
}

function verifyDatabaseIntegrity(
  database: Database.Database,
  migration: DatabaseMigration,
): void {
  const violations = database.pragma("foreign_key_check") as Array<unknown>;
  if (violations.length > 0) {
    throw new Error(
      `Database migration ${migration.version} produced foreign-key violations.`,
    );
  }
  const integrity = database.pragma("integrity_check") as Array<{
    readonly integrity_check: string;
  }>;
  if (
    integrity.length !== 1 ||
    integrity[0]?.integrity_check.toLocaleLowerCase() !== "ok"
  ) {
    throw new Error(
      `Database migration ${migration.version} failed SQLite integrity verification.`,
    );
  }
}

function assertMigrationPlan(
  migrationsToApply: readonly DatabaseMigration[],
): void {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of migrationsToApply) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previousVersion
    ) {
      throw new Error(
        "Database migrations must have strictly increasing positive integer versions.",
      );
    }
    if (!migration.name || names.has(migration.name)) {
      throw new Error("Database migration names must be non-empty and unique.");
    }
    if (
      migration.requiresLegacyAlterTable &&
      !migration.requiresForeignKeysDisabled
    ) {
      throw new Error(
        "Legacy ALTER TABLE migrations must disable foreign-key enforcement.",
      );
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

export function applyDatabaseMigrations(
  database: Database.Database,
  migrationsToApply: readonly DatabaseMigration[],
  options: {
    readonly verifyBeforeCommit?: (
      database: Database.Database,
      migration: DatabaseMigration,
    ) => void;
  } = {},
): void {
  database.function(
    "harness_task_create_receipt_fingerprint",
    { deterministic: true },
    taskCreateReceiptFingerprint,
  );
  assertMigrationPlan(migrationsToApply);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as AppliedMigration[];
  const latestKnown = migrationsToApply.at(-1)?.version ?? 0;
  const future = applied.find((entry) => entry.version > latestKnown);
  if (future) {
    throw new Error(
      `Database schema version ${future.version} is newer than supported version ${latestKnown}.`,
    );
  }

  for (const entry of applied) {
    const migration = migrationsToApply.find(
      (candidate) => candidate.version === entry.version,
    );
    if (!migration) {
      throw new Error(
        `Database contains unknown migration version ${entry.version}.`,
      );
    }
    if (
      migration.name !== entry.name ||
      checksum(migration.sql) !== entry.checksum
    ) {
      throw new Error(
        `Database migration ${entry.version} does not match this build.`,
      );
    }
  }

  const insert = database.prepare(`
    INSERT INTO schema_migrations(version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const migration of migrationsToApply) {
    if (applied.some((entry) => entry.version === migration.version)) {
      continue;
    }
    const apply = database.transaction(() => {
      migration.preflight?.(database);
      database.exec(migration.sql);
      if (migration.verifyDatabaseIntegrity) {
        verifyDatabaseIntegrity(database, migration);
      }
      options.verifyBeforeCommit?.(database, migration);
      insert.run(
        migration.version,
        migration.name,
        checksum(migration.sql),
        Date.now(),
      );
    });
    if (!migration.requiresForeignKeysDisabled) {
      apply();
      continue;
    }
    if (database.inTransaction) {
      throw new Error(
        `Database migration ${migration.version} must run outside an existing transaction.`,
      );
    }
    const foreignKeysEnabled =
      (database.pragma("foreign_keys", { simple: true }) as number) === 1;
    const legacyAlterTableEnabled =
      (database.pragma("legacy_alter_table", { simple: true }) as number) === 1;
    if (foreignKeysEnabled) database.pragma("foreign_keys = OFF");
    if (migration.requiresLegacyAlterTable && !legacyAlterTableEnabled) {
      database.pragma("legacy_alter_table = ON");
    }
    try {
      apply();
    } finally {
      try {
        if (migration.requiresLegacyAlterTable && !legacyAlterTableEnabled) {
          database.pragma("legacy_alter_table = OFF");
        }
        if (
          migration.requiresLegacyAlterTable &&
          ((database.pragma("legacy_alter_table", {
            simple: true,
          }) as number) ===
            1) !==
            legacyAlterTableEnabled
        ) {
          throw new Error(
            `Database migration ${migration.version} did not restore legacy ALTER TABLE policy.`,
          );
        }
      } finally {
        if (foreignKeysEnabled) {
          database.pragma("foreign_keys = ON");
          if (
            (database.pragma("foreign_keys", { simple: true }) as number) !== 1
          ) {
            throw new Error(
              `Database migration ${migration.version} did not restore foreign-key enforcement.`,
            );
          }
        }
      }
    }
  }
}

export function migrateDatabase(database: Database.Database): void {
  applyDatabaseMigrations(database, deployedMigrations);
}

export interface BackendNormalizationMigrationInput {
  /** Omitted only after the fresh-database boundary has removed seed identity. */
  readonly configuration?: ResolvedBackendConfigurationFile;
  readonly quiescentCutoverConfirmed: true;
  readonly appliedAt?: number;
}

type PrincipalRow = {
  readonly tenantId: string;
  readonly principalId: string;
};

type PreservedDraftRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly text: string;
  readonly updatedAt: number;
  readonly revision: number;
};

// Migration 010 is checksum-locked to the historical Pi-only 0.83.0 cutover.
// Normal reconciliation replaces this seed with the current compiled profile
// after later migrations relax the column to code-owned release evidence.
const LEGACY_PI_NORMALIZATION_PROTOCOL_RELEASE = "0.83.0";

function legacyPiCutoverTarget(
  configuration: ResolvedBackendConfigurationFile,
) {
  const backends = new Map(
    configuration.backends.map((backend) => [backend.id, backend]),
  );
  const candidates = configuration.targets
    .filter((target) => {
      const backend = backends.get(target.backendInstanceId);
      return (
        target.enabled &&
        target.kind === "pi_sdk" &&
        backend?.enabled === true &&
        backend.kind === "pi"
      );
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  const target =
    candidates.find(({ id }) => id === configuration.defaultTargetId) ??
    candidates[0];
  const backend = target ? backends.get(target.backendInstanceId) : undefined;
  if (!target || !backend || backend.kind !== "pi") {
    throw new Error(
      "Legacy backend normalization requires an enabled Pi SDK cutover target.",
    );
  }
  return { backend, target } as const;
}

function latestAppliedVersion(database: Database.Database): number {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!exists) return 0;
  return (
    database
      .prepare(
        "SELECT coalesce(max(version), 0) AS version FROM schema_migrations",
      )
      .get() as { version: number }
  ).version;
}

/**
 * Applies the inactive atomic-cutover schema to a database already at the
 * deployed schema. Production startup intentionally does not call this until
 * the runtime and browser cut over in the same release.
 */
export function applyBackendNormalizationMigration(
  database: Database.Database,
  input: BackendNormalizationMigrationInput,
): void {
  const currentVersion = latestAppliedVersion(database);
  const deployedVersion = deployedMigrations.at(-1)!.version;
  if (currentVersion !== deployedVersion) {
    throw new Error(
      `Backend normalization requires schema version ${deployedVersion}; found ${currentVersion}.`,
    );
  }
  if (input.quiescentCutoverConfirmed !== true) {
    throw new Error(
      "Backend normalization requires a quiescent old server with an empty in-memory Pi queue.",
    );
  }

  const unrecoverableLegacyOperation = database
    .prepare(
      `
        SELECT mutation_kind AS mutationKind, mutation_id AS mutationId
        FROM mutation_receipts
        WHERE result_code = 'submitting'
          AND mutation_kind IN (
            'native_send', 'automation_send', 'native_abort',
            'native_compact', 'native_rename', 'config',
            'materialization_retry'
          )
        ORDER BY created_at, mutation_id
        LIMIT 1
      `,
    )
    .get() as
    { readonly mutationKind: string; readonly mutationId: string } | undefined;
  if (unrecoverableLegacyOperation) {
    throw new Error(
      `Backend normalization cannot safely migrate unresolved legacy operation ${unrecoverableLegacyOperation.mutationId} (${unrecoverableLegacyOperation.mutationKind}); reconcile or remove it with the old runtime before cutover.`,
    );
  }

  database.transaction(() => {
    const preservedDrafts = database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            principal_id AS principalId,
            thread_id AS threadId,
            text,
            updated_at AS updatedAt,
            revision
          FROM thread_drafts
          WHERE text <> ''
          ORDER BY tenant_id, principal_id, thread_id
        `,
      )
      .all() as PreservedDraftRow[];
    if (!input.configuration && database.prepare("SELECT 1 FROM principals LIMIT 1").get()) {
      throw new Error("Existing state requires an explicit legacy configuration import before backend normalization.");
    }
    // The checksum-locked SQL requires one context row, even with zero tenants.
    // These values cannot become provider configuration: an empty tenant table
    // means its INSERT ... SELECT statements produce no backend/profile rows.
    const { backend, target } = input.configuration ? legacyPiCutoverTarget(input.configuration) : {
      backend: { id: "empty-migration-context", label: "Empty migration", enabled: false },
      target: { id: "empty-migration-context", label: "Empty migration", enabled: false },
    };
    const appliedAt = input.appliedAt ?? Date.now();
    const principals = database
      .prepare(
        `
          SELECT tenant_id AS tenantId, id AS principalId
          FROM principals
          ORDER BY tenant_id, id
        `,
      )
      .all() as PrincipalRow[];

    database.exec(`
      DROP TABLE IF EXISTS temp.backend_normalization_context;
      DROP TABLE IF EXISTS temp.backend_normalization_profiles;
      CREATE TEMP TABLE backend_normalization_context (
      backend_instance_id TEXT NOT NULL,
      backend_label TEXT NOT NULL,
      backend_enabled INTEGER NOT NULL CHECK (backend_enabled IN (0, 1)),
      protocol_release TEXT NOT NULL,
      connection_template_id TEXT NOT NULL,
      connection_label TEXT NOT NULL,
      connection_enabled INTEGER NOT NULL CHECK (connection_enabled IN (0, 1)),
      applied_at INTEGER NOT NULL,
      quiescent_cutover_confirmed INTEGER NOT NULL
        CHECK (quiescent_cutover_confirmed = 1)
      ) STRICT;
      CREATE TEMP TABLE backend_normalization_profiles (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      execution_environment_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, owner_principal_id)
      ) WITHOUT ROWID, STRICT;
    `);
    try {
      database
        .prepare(
          `
          INSERT INTO temp.backend_normalization_context(
            backend_instance_id, backend_label, backend_enabled,
            protocol_release, connection_template_id, connection_label,
            connection_enabled, applied_at, quiescent_cutover_confirmed
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
          `,
        )
        .run(
          backend.id,
          backend.label,
          backend.enabled ? 1 : 0,
          LEGACY_PI_NORMALIZATION_PROTOCOL_RELEASE,
          target.id,
          target.label,
          target.enabled ? 1 : 0,
          appliedAt,
        );

      const insertProfile = database.prepare(
        `
        INSERT INTO temp.backend_normalization_profiles(
          tenant_id, owner_principal_id, profile_id,
          execution_environment_id
        )
        SELECT ?, ?, ?, id
        FROM execution_environments
        WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'
        `,
      );
      for (const principal of principals) {
        const inserted = insertProfile.run(
          principal.tenantId,
          principal.principalId,
          deriveConnectionProfileId(
            principal.tenantId,
            principal.principalId,
            target.id,
          ),
          principal.tenantId,
          principal.principalId,
        );
        if (inserted.changes !== 1) {
          throw new Error(
            `Principal ${principal.principalId} does not have exactly one Local execution environment.`,
          );
        }
      }

      applyDatabaseMigrations(database, backendNormalizationCutoverMigrations, {
        verifyBeforeCommit(databaseToVerify, migration) {
          if (migration.version !== backendNormalizationMigration.version) {
            return;
          }
          const violations = databaseToVerify.pragma(
            "foreign_key_check",
          ) as Array<unknown>;
          if (violations.length > 0) {
            throw new Error(
              "Backend normalization produced foreign-key violations.",
            );
          }
          const integrity = databaseToVerify.pragma(
            "integrity_check",
          ) as Array<{
            readonly integrity_check: string;
          }>;
          if (
            integrity.length !== 1 ||
            integrity[0]?.integrity_check.toLocaleLowerCase() !== "ok"
          ) {
            throw new Error(
              "Backend normalization failed SQLite integrity verification.",
            );
          }
        },
      });

      const restoreDraft = database.prepare(`
        UPDATE thread_drafts
        SET text = ?, updated_at = ?, revision = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `);
      for (const draft of preservedDrafts) {
        const restored = restoreDraft.run(
          draft.text,
          draft.updatedAt,
          draft.revision,
          draft.tenantId,
          draft.principalId,
          draft.threadId,
        );
        if (restored.changes !== 1) {
          throw new Error(
            `Backend normalization could not restore draft for thread ${draft.threadId}.`,
          );
        }
      }
    } finally {
      database.exec(`
        DROP TABLE IF EXISTS temp.backend_normalization_profiles;
        DROP TABLE IF EXISTS temp.backend_normalization_context;
      `);
    }
  })();
}

/** Creates current schema with local identity but no execution configuration. */
export function initializeEmptyBackendNormalizedDatabase(database: Database.Database): void {
  if (latestAppliedVersion(database) !== 0) throw new Error("Empty initialization requires a new database.");
  // Migration 002's historical local environment is not current configuration.
  // Keep its checksum intact, remove its pristine seed inside this transaction,
  // and restore only installation identity after the legacy cutover runs.
  database.transaction(() => {
    migrateDatabase(database);
    const tenant = database.prepare("SELECT id, created_at FROM tenants").get() as { id: string; created_at: number };
    const principal = database.prepare("SELECT id, kind, created_at FROM principals").get() as { id: string; kind: string; created_at: number };
    database.exec("DELETE FROM principal_generations; DELETE FROM execution_environments; DELETE FROM principals; DELETE FROM tenants;");
    applyBackendNormalizationMigration(database, { quiescentCutoverConfirmed: true });
    database.prepare("INSERT INTO tenants(id,created_at) VALUES (?,?)").run(tenant.id, tenant.created_at);
    database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,?,?)").run(tenant.id, principal.id, principal.kind, principal.created_at);
    database.prepare("INSERT INTO principal_generations(tenant_id,principal_id,inventory_generation) VALUES (?,?,0)").run(tenant.id, principal.id);
  })();
  applyDatabaseMigrations(database, backendNormalizedMigrations);
}
