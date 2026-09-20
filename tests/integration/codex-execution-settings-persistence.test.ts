import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExecutionSettingsRepositoryAdapter } from "../../src/server/backends/codex/codex-backend-module.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { ABSENT_MODULE_CONFIGURATION_FINGERPRINT } from "../../src/server/config/configuration-fingerprint.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-cutover",
      kind: "pi",
      label: "Pi cutover",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
    {
      id: "codex-primary",
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Pi",
      backendInstanceId: "pi-cutover",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "pi-local",
});

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const allExecutionPolicy = {
  allowedSandboxModes: [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} as const;
const readOnlyPolicy = {
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;
const workspacePolicy = {
  sandboxMode: "workspace-write",
  networkAccess: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
} as const;
const unrestrictedPolicy = {
  sandboxMode: "danger-full-access",
  networkAccess: "enabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;

function recognizedEffective(
  settings: Readonly<{
    model: string;
    reasoningEffort: string;
    serviceTier: "standard" | "fast";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    networkAccess: "disabled" | "enabled";
    approvalPolicy: "untrusted" | "on-request" | "never";
    approvalReviewer: "user" | "auto_review";
  }>,
) {
  return {
    ...settings,
    serviceTierClassification: "recognized" as const,
    sandboxClassification: "recognized" as const,
    networkClassification: "recognized" as const,
    approvalPolicyClassification: "recognized" as const,
    approvalReviewerClassification: "recognized" as const,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(
  schemaVersion:
    | 16
    | 17
    | 18
    | 19
    | 36
    | 37
    | 38
    | 39
    | 40
    | 41
    | 42
    | 43 = 43,
  filename = ":memory:",
): {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly connectionProfileId: string;
} {
  const database = openOverlayDatabase(filename);
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: "/tmp/codex-execution-settings",
    displayName: "Codex execution settings",
    availability: "available",
    trustState: "trusted",
  }, 100);
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 200,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= schemaVersion,
    ),
  );
  database
    .prepare(
      `
        INSERT INTO agent_backend_instances(
          tenant_id, id, kind, label, enabled, configuration_revision,
          configuration_fingerprint, protocol_release, created_at, updated_at
        )
        VALUES (?, 'codex-primary', 'codex_app_server', 'Codex', 1, 0, ?,
          '0.153.0', 210, 210)
      `,
    )
    .run(scope.tenantId, ABSENT_MODULE_CONFIGURATION_FINGERPRINT);
  const connectionProfileId = deriveConnectionProfileId(
    scope.tenantId,
    scope.principalId,
    "codex-local",
  );
  database
    .prepare(
      `
        INSERT INTO agent_connection_profiles(
          tenant_id, owner_principal_id, id, template_id,
          backend_instance_id, backend_kind, execution_environment_id,
          kind, label, enabled, configuration_revision,
          configuration_fingerprint, created_at, updated_at
        )
        VALUES (?, ?, ?, 'codex-local', 'codex-primary', 'codex_app_server',
          ?, 'codex_app_server', 'Codex', 1, 0, ?, 210, 210)
      `,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      connectionProfileId,
      environment.id,
      ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
    );
  const threadId = "codex-settings-thread";
  new ConversationBindingRepository(database).createUnboundThread(scope, {
    id: threadId,
    workspaceId: workspace.id,
    connectionProfileId,
    title: "Codex settings",
    now: 220,
  });
  return { database, scope, threadId, connectionProfileId };
}

describe("Codex execution settings persistence", () => {
  it("rolls migration 17 back atomically when verification fails", () => {
    const target = fixture(16);
    expect(() => applyDatabaseMigrations(
      target.database,
      backendNormalizedMigrations,
      {
        verifyBeforeCommit(_database, migration) {
          if (migration.version === 17) {
            throw new Error("injected migration 17 verification failure");
          }
        },
      },
    )).toThrow("injected migration 17 verification failure");
    expect((target.database.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get() as { readonly version: number }).version).toBe(16);
    expect(target.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'codex_thread_execution_settings'
    `).get()).toBeUndefined();
    expect(target.database.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades a populated schema 16 to 17 atomically and preserves existing rows", () => {
    const target = fixture(16);
    const configurations = new BackendConfigurationRepository(target.database);
    const pi = configurations.listProfiles(target.scope).find(
      ({ kind }) => kind === "pi_sdk",
    )!;
    const { workspaceId } = target.database.prepare(`
      SELECT workspace_id AS workspaceId
      FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `).get(
      target.scope.tenantId,
      target.scope.principalId,
      target.threadId,
    ) as { readonly workspaceId: string };
    const piThreadId = "pi-thread-excluded-from-codex-settings";
    new ConversationBindingRepository(target.database).createUnboundThread(
      target.scope,
      {
        id: piThreadId,
        workspaceId,
        connectionProfileId: pi.id,
        title: "Pi thread",
        now: 225,
      },
    );
    target.database.prepare(`
      INSERT INTO agent_connection_setting_preferences(
        tenant_id, owner_principal_id, connection_profile_id,
        setting_id, value, revision, created_at, updated_at
      )
      SELECT tenant_id, owner_principal_id, connection_profile_id,
        'model', 'preserved-model', 0, 230, 230
      FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `).run(target.scope.tenantId, target.scope.principalId, target.threadId);

    applyDatabaseMigrations(
      target.database,
      backendNormalizedMigrations.filter(
        (migration) => migration.version <= 17,
      ),
    );

    expect((target.database.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get() as { readonly version: number }).version).toBe(17);
    expect(target.database.prepare(`
      SELECT value FROM agent_connection_setting_preferences
      WHERE tenant_id = ? AND owner_principal_id = ? AND value = 'preserved-model'
    `).get(target.scope.tenantId, target.scope.principalId)).toEqual({
      value: "preserved-model",
    });
    expect(target.database.prepare(`
      SELECT application_thread_id AS applicationThreadId,
        desired_model AS desiredModel,
        desired_reasoning_effort AS desiredReasoningEffort,
        desired_permission_profile AS desiredPermissionProfile,
        effective_confirmation_state AS effectiveConfirmationState,
        revision
      FROM codex_thread_execution_settings
      WHERE tenant_id = ? AND owner_principal_id = ?
      ORDER BY application_thread_id
    `).all(target.scope.tenantId, target.scope.principalId)).toEqual([
      {
        applicationThreadId: target.threadId,
        desiredModel: null,
        desiredReasoningEffort: null,
        desiredPermissionProfile: null,
        effectiveConfirmationState: "unconfirmed",
        revision: 0,
      },
    ]);
    expect(target.database.prepare(`
      SELECT 1 FROM codex_thread_execution_settings
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ?
    `).get(
      target.scope.tenantId,
      target.scope.principalId,
      piThreadId,
    )).toBeUndefined();
    expect(target.database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls the schema-18 axis rebuild back atomically when verification fails", () => {
    const target = fixture(17);
    expect(() => applyDatabaseMigrations(
      target.database,
      backendNormalizedMigrations,
      {
        verifyBeforeCommit(_database, migration) {
          if (migration.version === 18) {
            throw new Error("injected migration 18 verification failure");
          }
        },
      },
    )).toThrow("injected migration 18 verification failure");
    expect((target.database.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get() as { readonly version: number }).version).toBe(17);
    expect(target.database.prepare(`
      SELECT name FROM pragma_table_info('codex_thread_execution_settings')
      WHERE name = 'desired_permission_profile'
    `).get()).toEqual({ name: "desired_permission_profile" });
    expect(target.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'codex_execution_settings_snapshots_immutable_update'
    `).get()).toEqual({
      name: "codex_execution_settings_snapshots_immutable_update",
    });
    expect(target.database.pragma("foreign_key_check")).toEqual([]);
  });

  it("migrates schema-36 desired settings and snapshots to Standard while clearing effective confirmation", () => {
    const target = fixture(36);
    target.database.prepare(`
      INSERT INTO codex_thread_execution_settings(
        tenant_id, owner_principal_id, application_thread_id,
        desired_model, desired_reasoning_effort, desired_sandbox_mode,
        desired_network_access, desired_approval_policy,
        desired_approval_reviewer, effective_model,
        effective_reasoning_effort, effective_sandbox_mode,
        effective_sandbox_classification, effective_network_access,
        effective_network_classification, effective_approval_policy,
        effective_approval_policy_classification,
        effective_approval_reviewer,
        effective_approval_reviewer_classification,
        effective_daemon_generation, effective_confirmation_state,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'gpt-5.6-codex', 'high', 'workspace-write',
        'disabled', 'on-request', 'user', 'gpt-5.6-codex', 'high',
        'workspace-write', 'recognized', 'disabled', 'recognized',
        'on-request', 'recognized', 'user', 'recognized', 5, 'confirmed',
        4, 220, 298)
    `).run(target.scope.tenantId, target.scope.principalId, target.threadId);
    target.database.prepare(`
      INSERT INTO codex_execution_settings_snapshots(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id, settings_revision, model, reasoning_effort,
        sandbox_mode, network_access, approval_policy, approval_reviewer,
        created_at
      ) VALUES (?, ?, ?, 'before-fast-mode', 4, 'gpt-5.6-codex', 'high',
        'workspace-write', 'disabled', 'on-request', 'user', 299)
    `).run(target.scope.tenantId, target.scope.principalId, target.threadId);

    applyDatabaseMigrations(target.database, backendNormalizedMigrations);

    expect(target.database.prepare(`
      SELECT desired_service_tier AS desiredServiceTier,
        effective_model AS effectiveModel,
        effective_service_tier AS effectiveServiceTier,
        effective_service_tier_classification AS effectiveClassification,
        effective_daemon_generation AS effectiveDaemonGeneration,
        effective_confirmation_state AS confirmationState, revision
      FROM codex_thread_execution_settings
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ?
    `).get(
      target.scope.tenantId,
      target.scope.principalId,
      target.threadId,
    )).toEqual({
      desiredServiceTier: "standard",
      effectiveModel: null,
      effectiveServiceTier: null,
      effectiveClassification: null,
      effectiveDaemonGeneration: null,
      confirmationState: "unconfirmed",
      revision: 5,
    });
    expect(target.database.prepare(`
      SELECT service_tier AS serviceTier
      FROM codex_execution_settings_snapshots
      WHERE application_operation_id = 'before-fast-mode'
    `).get()).toEqual({ serviceTier: "standard" });
    expect(() => target.database.prepare(`
      UPDATE codex_execution_settings_snapshots SET service_tier = 'fast'
    `).run()).toThrow(/immutable/i);
    expect(target.database.pragma("foreign_key_check")).toEqual([]);
    expect(target.database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
  });

  it("rolls the schema-39 Fast-mode rebuild back atomically when verification fails", () => {
    const target = fixture(38);
    expect(() => applyDatabaseMigrations(
      target.database,
      backendNormalizedMigrations,
      {
        verifyBeforeCommit(_database, migration) {
          if (migration.version === 39) {
            throw new Error("injected migration 39 verification failure");
          }
        },
      },
    )).toThrow("injected migration 39 verification failure");
    expect((target.database.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get() as { readonly version: number }).version).toBe(38);
    expect(target.database.prepare(`
      SELECT name FROM pragma_table_info('codex_thread_execution_settings')
      WHERE name = 'desired_service_tier'
    `).get()).toBeUndefined();
    expect(target.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'codex_execution_settings_snapshots_immutable_update'
    `).get()).toEqual({
      name: "codex_execution_settings_snapshots_immutable_update",
    });
  });

  it("persists owner-scoped desired/effective state and immutable operation snapshots", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(target.database);
    let settings = repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      now: 300,
    });
    expect(settings).toMatchObject({
      revision: 0,
      desired: { serviceTier: "standard", ...workspacePolicy },
      effective: null,
      effectiveConfirmationState: "unconfirmed",
    });
    expect(repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: settings.desired,
      now: 301,
    })).toEqual(settings);
    const snapshot = repository.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "turn-operation-one",
      now: 302,
    });
    expect(snapshot).toMatchObject({
      settingsRevision: 0,
      settings: {
        model: "gpt-5.6-codex",
        serviceTier: "standard",
        ...workspacePolicy,
      },
    });
    settings = repository.updateDesired(target.scope, target.threadId, {
      expectedRevision: settings.revision,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
        serviceTier: "fast",
        ...readOnlyPolicy,
      },
      now: 303,
    });
    expect(repository.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "turn-operation-one",
      now: 304,
    })).toEqual(snapshot);
    settings = repository.confirmEffective(target.scope, target.threadId, {
      expectedRevision: settings.revision,
      effective: {
        ...recognizedEffective(settings.desired!),
      },
      daemonGeneration: 7,
      now: 305,
    });
    expect(settings).toMatchObject({
      effective: {
        reasoningEffort: "high",
        serviceTier: "fast",
        serviceTierClassification: "recognized",
        ...readOnlyPolicy,
      },
      effectiveDaemonGeneration: 7,
      effectiveConfirmationState: "confirmed",
    });
    settings = repository.markConfirmationUnknown(target.scope, target.threadId, {
      expectedRevision: settings.revision,
      now: 306,
    });
    expect(settings).toMatchObject({
      effective: { reasoningEffort: "high", serviceTier: "fast" },
      effectiveDaemonGeneration: null,
      effectiveConfirmationState: "unknown",
    });
    expect(repository.find(
      { ...target.scope, principalId: "another-owner" },
      target.threadId,
    )).toBeUndefined();
    expect(() => target.database.prepare(`
      UPDATE codex_execution_settings_snapshots SET model = 'changed'
    `).run()).toThrow(/immutable/i);
    expect(() => repository.updateDesired(target.scope, target.threadId, {
      expectedRevision: 0,
      desired: settings.desired!,
      now: 307,
    })).toThrow(/changed before/i);
  });

  it("replays an immutable operation snapshot after the database is closed and reopened", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "sedes-codex-settings-snapshot-"),
    );
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "overlay.sqlite");
    const target = fixture(39, filename);
    const repository = new CodexThreadExecutionSettingsRepository(target.database);
    let settings = repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      now: 310,
    });
    const snapshot = repository.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "durable-operation-snapshot",
      now: 311,
    });
    settings = repository.updateDesired(target.scope, target.threadId, {
      expectedRevision: settings.revision,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
        serviceTier: "standard",
        ...readOnlyPolicy,
      },
      now: 312,
    });
    expect(settings.revision).toBe(1);
    target.database.close();

    const reopenedDatabase = openOverlayDatabase(filename, { migrate: false });
    databases.push(reopenedDatabase);
    const reopenedRepository = new CodexThreadExecutionSettingsRepository(
      reopenedDatabase,
    );
    expect(reopenedRepository.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "durable-operation-snapshot",
      now: 313,
    })).toEqual(snapshot);
    expect(reopenedRepository.find(target.scope, target.threadId)).toMatchObject({
      revision: 1,
      desired: {
        reasoningEffort: "high",
        serviceTier: "standard",
        ...readOnlyPolicy,
      },
    });
  });

  it("rejects a frozen operation when an execution axis was revoked by policy", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(target.database);
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      now: 314,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      { ...allExecutionPolicy, allowedSandboxModes: ["read-only"] },
      catalogModelPolicy,
    );

    expect(() => adapter.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "revoked-permission-operation",
      source: { kind: "user" },
      now: 315,
    })).toThrowError(expect.objectContaining({
      category: "rejected",
      crossedSubmissionBoundary: false,
      retryable: false,
      backendCode: "codex_execution_policy_rejected",
    }));
  });

  it("invalidates every confirmed thread for one principal and backend without erasing observations", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(target.database);
    const firstDesired = {
      model: "gpt-5.6-codex",
      reasoningEffort: "medium",
      serviceTier: "standard",
      ...readOnlyPolicy,
    } as const;
    let first = repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: firstDesired,
      now: 320,
    });
    first = repository.confirmEffective(target.scope, target.threadId, {
      expectedRevision: first.revision,
      effective: {
        ...recognizedEffective(firstDesired),
      },
      daemonGeneration: 3,
      now: 321,
    });

    const binding = target.database.prepare(`
      SELECT workspace_id AS workspaceId
      FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `).get(
      target.scope.tenantId,
      target.scope.principalId,
      target.threadId,
    ) as { readonly workspaceId: string };
    const secondThreadId = "codex-settings-unopened-thread";
    new ConversationBindingRepository(target.database).createUnboundThread(
      target.scope,
      {
        id: secondThreadId,
        workspaceId: binding.workspaceId,
        connectionProfileId: target.connectionProfileId,
        title: "Unopened Codex settings",
        now: 322,
      },
    );
    const secondDesired = {
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      serviceTier: "standard",
      ...workspacePolicy,
    } as const;
    let second = repository.initialize(target.scope, {
      applicationThreadId: secondThreadId,
      desired: secondDesired,
      now: 323,
    });
    second = repository.confirmEffective(target.scope, secondThreadId, {
      expectedRevision: second.revision,
      effective: {
        ...recognizedEffective(secondDesired),
      },
      daemonGeneration: 3,
      now: 324,
    });

    expect(repository.invalidateConfirmedForBackend(
      { ...target.scope, principalId: "another-owner" },
      "codex-primary",
      325,
    )).toBe(0);
    expect(repository.invalidateConfirmedForBackend(
      target.scope,
      "pi-cutover",
      326,
    )).toBe(0);
    expect(repository.invalidateConfirmedForBackend(
      target.scope,
      "codex-primary",
      327,
    )).toBe(2);

    expect(repository.find(target.scope, target.threadId)).toMatchObject({
      desired: firstDesired,
      effective: {
        ...recognizedEffective(firstDesired),
      },
      effectiveDaemonGeneration: null,
      effectiveConfirmationState: "unknown",
      revision: first.revision + 1,
      updatedAt: 327,
    });
    expect(repository.find(target.scope, secondThreadId)).toMatchObject({
      desired: secondDesired,
      effective: {
        ...recognizedEffective(secondDesired),
      },
      effectiveDaemonGeneration: null,
      effectiveConfirmationState: "unknown",
      revision: second.revision + 1,
      updatedAt: 327,
    });
    expect(repository.invalidateConfirmedForBackend(
      target.scope,
      "codex-primary",
      328,
    )).toBe(0);
  });

  it("keeps imported desired settings unresolved and preserves external native policies", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(target.database);
    let settings = repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: null,
      now: 350,
    });
    expect(settings.desired).toBeNull();
    expect(() => repository.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "unresolved-import-operation",
      now: 351,
    })).toThrow(/not resolved/i);
    settings = repository.confirmEffective(target.scope, target.threadId, {
      expectedRevision: settings.revision,
      effective: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: null,
        sandboxClassification: "external_custom",
        networkAccess: "disabled",
        networkClassification: "recognized",
        approvalPolicy: "on-request",
        approvalPolicyClassification: "recognized",
        approvalReviewer: "user",
        approvalReviewerClassification: "recognized",
      },
      daemonGeneration: 9,
      now: 352,
    });
    expect(settings).toMatchObject({
      desired: null,
      effective: {
        sandboxMode: null,
        sandboxClassification: "external_custom",
        networkAccess: "disabled",
        networkClassification: "recognized",
      },
      effectiveConfirmationState: "confirmed",
    });
  });

  it("defers explicitly incomplete observations but preserves imported custom policy truth", () => {
    const managed = fixture();
    const managedRepository = new CodexThreadExecutionSettingsRepository(
      managed.database,
    );
    managedRepository.initialize(managed.scope, {
      applicationThreadId: managed.threadId,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      now: 370,
    });
    const managedAdapter = new CodexExecutionSettingsRepositoryAdapter(
      managedRepository,
      allExecutionPolicy,
      catalogModelPolicy,
    );
    managedAdapter.observeEffective(managed.scope, {
      applicationThreadId: managed.threadId,
      settings: {
        ...recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...workspacePolicy,
        }),
        policyObservation: "incomplete",
      },
      confirmationGeneration: 4,
      now: 371,
    });
    expect(managedRepository.find(managed.scope, managed.threadId)).toMatchObject({
      effective: null,
      effectiveConfirmationState: "unconfirmed",
    });
    managedAdapter.observeEffective(managed.scope, {
      applicationThreadId: managed.threadId,
      settings: {
        ...recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...workspacePolicy,
        }),
        policyObservation: "complete",
      },
      confirmationGeneration: 4,
      now: 372,
    });
    expect(managedRepository.find(managed.scope, managed.threadId)).toMatchObject({
      effective: {
        ...workspacePolicy,
        sandboxClassification: "recognized",
      },
      effectiveConfirmationState: "confirmed",
    });

    const imported = fixture();
    const importedRepository = new CodexThreadExecutionSettingsRepository(
      imported.database,
    );
    importedRepository.initialize(imported.scope, {
      applicationThreadId: imported.threadId,
      desired: null,
      now: 373,
    });
    const importedAdapter = new CodexExecutionSettingsRepositoryAdapter(
      importedRepository,
      allExecutionPolicy,
      catalogModelPolicy,
    );
    importedAdapter.observeEffective(imported.scope, {
      applicationThreadId: imported.threadId,
      settings: {
        ...recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...workspacePolicy,
        }),
        policyObservation: "incomplete",
      },
      confirmationGeneration: 5,
      now: 374,
    });
    expect(importedRepository.find(imported.scope, imported.threadId)).toMatchObject({
      desired: null,
      effective: null,
      effectiveConfirmationState: "unconfirmed",
    });

    const unrestricted = fixture();
    const unrestrictedRepository = new CodexThreadExecutionSettingsRepository(
      unrestricted.database,
    );
    unrestrictedRepository.initialize(unrestricted.scope, {
      applicationThreadId: unrestricted.threadId,
      desired: null,
      now: 375,
    });
    const unrestrictedAdapter = new CodexExecutionSettingsRepositoryAdapter(
      unrestrictedRepository,
      allExecutionPolicy,
      catalogModelPolicy,
    );
    unrestrictedAdapter.observeEffective(unrestricted.scope, {
      applicationThreadId: unrestricted.threadId,
      settings: {
        ...recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...unrestrictedPolicy,
        }),
        policyObservation: "complete",
      },
      confirmationGeneration: 6,
      now: 376,
    });
    expect(
      unrestrictedRepository.find(unrestricted.scope, unrestricted.threadId),
    ).toMatchObject({
      desired: null,
      effective: {
        ...unrestrictedPolicy,
        sandboxClassification: "recognized",
      },
      effectiveConfirmationState: "confirmed",
    });
  });

  it("rejects a caller that combines custom native policy with application defaults", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(
      target.database,
    );
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: null,
      now: 378,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      allExecutionPolicy,
      catalogModelPolicy,
    );

    adapter.observeEffective(target.scope, {
      applicationThreadId: target.threadId,
      settings: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: null,
        sandboxClassification: "external_custom",
        networkAccess: "enabled",
        networkClassification: "recognized",
        approvalPolicy: "on-request",
        approvalPolicyClassification: "recognized",
        approvalReviewer: "user",
        approvalReviewerClassification: "recognized",
        policyObservation: "complete",
      },
      initializeDesired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...readOnlyPolicy,
      },
      confirmationGeneration: 8,
      now: 379,
    });

    expect(repository.find(target.scope, target.threadId)).toMatchObject({
      desired: null,
      effective: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: null,
        sandboxClassification: "external_custom",
        networkAccess: "enabled",
      },
      effectiveDaemonGeneration: 8,
      effectiveConfirmationState: "confirmed",
      revision: 1,
    });
  });

  it("atomically initializes imported desired settings from the complete recognized native tuple", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(
      target.database,
    );
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: null,
      now: 380,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      allExecutionPolicy,
      catalogModelPolicy,
    );

    adapter.observeEffective(target.scope, {
      applicationThreadId: target.threadId,
      settings: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: "danger-full-access",
        sandboxClassification: "recognized",
        networkAccess: "enabled",
        networkClassification: "recognized",
        approvalPolicy: "never",
        approvalPolicyClassification: "recognized",
        approvalReviewer: "user",
        approvalReviewerClassification: "recognized",
        policyObservation: "complete",
      },
      initializeDesired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...unrestrictedPolicy,
      },
      confirmationGeneration: 8,
      now: 381,
    });

    expect(repository.find(target.scope, target.threadId)).toMatchObject({
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...unrestrictedPolicy,
      },
      effective: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: "danger-full-access",
        sandboxClassification: "recognized",
        networkAccess: "enabled",
        approvalPolicy: "never",
      },
      effectiveDaemonGeneration: 8,
      effectiveConfirmationState: "confirmed",
      revision: 1,
    });
  });

  it("leaves imported desired settings unresolved when the recognized native tuple is disallowed", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(
      target.database,
    );
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: null,
      now: 382,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      {
        allowedSandboxModes: ["read-only", "workspace-write"],
        allowedNetworkAccess: ["disabled", "enabled"],
        allowedApprovalPolicies: ["never"],
        allowedApprovalReviewers: ["user"],
      },
      catalogModelPolicy,
    );
    const observed = {
      ...recognizedEffective({
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...unrestrictedPolicy,
      }),
      policyObservation: "complete" as const,
    };

    adapter.observeEffective(target.scope, {
      applicationThreadId: target.threadId,
      settings: observed,
      initializeDesired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...unrestrictedPolicy,
      },
      confirmationGeneration: 9,
      now: 383,
    });

    expect(repository.find(target.scope, target.threadId)).toMatchObject({
      desired: null,
      effective: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...unrestrictedPolicy,
      },
      effectiveDaemonGeneration: 9,
      effectiveConfirmationState: "confirmed",
      revision: 1,
    });
  });

  it("adopts an imported observation over existing desired settings while stale revisions still conflict", () => {
    const staleTarget = fixture();
    const staleRepository = new CodexThreadExecutionSettingsRepository(
      staleTarget.database,
    );
    const unresolved = staleRepository.initialize(staleTarget.scope, {
      applicationThreadId: staleTarget.threadId,
      desired: null,
      now: 382,
    });
    const advanced = staleRepository.confirmEffective(
      staleTarget.scope,
      staleTarget.threadId,
      {
        expectedRevision: unresolved.revision,
        effective: recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...workspacePolicy,
        }),
        daemonGeneration: 9,
        now: 383,
      },
    );

    expect(() =>
      staleRepository.adoptImportedObservation(
        staleTarget.scope,
        staleTarget.threadId,
        {
          expectedRevision: unresolved.revision,
          desired: {
            model: "gpt-5.6-codex",
            reasoningEffort: "medium",
            serviceTier: "standard",
            ...readOnlyPolicy,
          },
          effective: null,
          daemonGeneration: 9,
          now: 384,
        },
      ),
    ).toThrow(/changed before/i);
    expect(
      staleRepository.find(staleTarget.scope, staleTarget.threadId),
    ).toEqual(advanced);

    const concurrentTarget = fixture();
    const concurrentRepository = new CodexThreadExecutionSettingsRepository(
      concurrentTarget.database,
    );
    const imported = concurrentRepository.initialize(concurrentTarget.scope, {
      applicationThreadId: concurrentTarget.threadId,
      desired: null,
      now: 385,
    });
    const userDesired = {
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      serviceTier: "standard",
      ...workspacePolicy,
    } as const;
    const concurrentlyResolved = concurrentRepository.updateDesired(
      concurrentTarget.scope,
      concurrentTarget.threadId,
      {
        expectedRevision: imported.revision,
        desired: userDesired,
        now: 386,
      },
    );

    // The backend is authoritative: a correct-revision adoption overwrites
    // an existing desired tuple instead of conflicting.
    const adopted = concurrentRepository.adoptImportedObservation(
      concurrentTarget.scope,
      concurrentTarget.threadId,
      {
        expectedRevision: concurrentlyResolved.revision,
        desired: {
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...readOnlyPolicy,
        },
        effective: recognizedEffective({
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...readOnlyPolicy,
        }),
        daemonGeneration: 10,
        now: 387,
      },
    );
    expect(adopted.revision).toBe(concurrentlyResolved.revision + 1);
    expect(adopted.desired).toEqual({
      model: "gpt-5.6-codex",
      reasoningEffort: "medium",
      serviceTier: "standard",
      ...readOnlyPolicy,
    });
    expect(
      concurrentRepository.find(
        concurrentTarget.scope,
        concurrentTarget.threadId,
      ),
    ).toEqual(adopted);
  });

  it("initializes imported next-turn reasoning from the catalog default without fabricating effective reasoning", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(
      target.database,
    );
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: null,
      now: 385,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      allExecutionPolicy,
      catalogModelPolicy,
    );

    adapter.observeEffective(target.scope, {
      applicationThreadId: target.threadId,
      settings: {
        model: "gpt-5.6-codex",
        reasoningEffort: null,
        serviceTier: "standard",
        serviceTierClassification: "recognized",
        sandboxMode: "workspace-write",
        sandboxClassification: "recognized",
        networkAccess: "disabled",
        networkClassification: "recognized",
        approvalPolicy: "on-request",
        approvalPolicyClassification: "recognized",
        approvalReviewer: "user",
        approvalReviewerClassification: "recognized",
        policyObservation: "complete",
      },
      initializeDesired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      confirmationGeneration: 9,
      now: 386,
    });

    expect(repository.find(target.scope, target.threadId)).toMatchObject({
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...workspacePolicy,
      },
      effective: null,
      effectiveDaemonGeneration: null,
      effectiveConfirmationState: "unconfirmed",
      revision: 1,
    });
  });

  it.each([
    ["workspace", workspacePolicy],
    ["unrestricted", unrestrictedPolicy],
  ] as const)(
    "preserves %s snapshots for durable automation submissions",
    (label, executionPolicy) => {
      const target = fixture();
      const repository = new CodexThreadExecutionSettingsRepository(
        target.database,
      );
      repository.initialize(target.scope, {
        applicationThreadId: target.threadId,
        desired: {
          model: "gpt-5.6-codex",
          reasoningEffort: "medium",
          serviceTier: "standard",
          ...executionPolicy,
        },
        now: 390,
      });
      const adapter = new CodexExecutionSettingsRepositoryAdapter(
        repository,
        allExecutionPolicy,
        catalogModelPolicy,
      );

      expect(adapter.freezeOperationSnapshot(target.scope, {
        applicationThreadId: target.threadId,
        applicationOperationId: `automation-${label}`,
        source: {
          kind: "automation",
          automationId: "automation-1",
          automationRunId: "automation-run-1",
        },
        now: 391,
      })).toMatchObject({ settings: executionPolicy });
    },
  );

  it("allows read-only snapshots for durable automation submissions", () => {
    const target = fixture();
    const repository = new CodexThreadExecutionSettingsRepository(
      target.database,
    );
    repository.initialize(target.scope, {
      applicationThreadId: target.threadId,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...readOnlyPolicy,
      },
      now: 395,
    });
    const adapter = new CodexExecutionSettingsRepositoryAdapter(
      repository,
      allExecutionPolicy,
      catalogModelPolicy,
    );

    expect(adapter.freezeOperationSnapshot(target.scope, {
      applicationThreadId: target.threadId,
      applicationOperationId: "automation-read-only",
      source: {
        kind: "automation",
        automationId: "automation-1",
        automationRunId: "automation-run-1",
      },
      now: 396,
    })).toMatchObject({
      settings: readOnlyPolicy,
    });
  });

  it("audits and replays provider feature mutations without cross-owner aliases", () => {
    const target = fixture();
    const receipts = new ProviderFeatureMutationRepository(target.database);
    const prepared = receipts.prepare(target.scope, {
      applicationThreadId: target.threadId,
      mutationId: "execution-mutation-one",
      featureId: "codex.execution",
      schemaVersion: 1,
      actionId: "set_sandbox_unrestricted",
      requestFingerprint: "a".repeat(64),
      expectedThreadRevision: 4,
      expectedFeatureRevision: 2,
      desiredPostcondition: { sandboxMode: "danger-full-access" },
      now: 400,
    });
    expect(prepared).toMatchObject({ state: "prepared", result: null });
    expect(receipts.prepare(target.scope, {
      applicationThreadId: target.threadId,
      mutationId: "execution-mutation-one",
      featureId: "codex.execution",
      schemaVersion: 1,
      actionId: "set_sandbox_unrestricted",
      requestFingerprint: "a".repeat(64),
      expectedThreadRevision: 4,
      expectedFeatureRevision: 2,
      desiredPostcondition: { sandboxMode: "danger-full-access" },
      now: 401,
    })).toEqual(prepared);
    const accepted = receipts.accept(target.scope, prepared.mutationId, {
      requestFingerprint: prepared.requestFingerprint,
      result: { featureRevision: 3 },
      now: 402,
    });
    expect(accepted).toMatchObject({
      state: "accepted",
      result: { featureRevision: 3 },
    });
    expect(receipts.find(
      { ...target.scope, principalId: "another-owner" },
      prepared.mutationId,
    )).toBeUndefined();
    expect(() => receipts.prepare(target.scope, {
      applicationThreadId: target.threadId,
      mutationId: "execution-mutation-one",
      featureId: "codex.execution",
      schemaVersion: 1,
      actionId: "set_sandbox_workspace",
      requestFingerprint: "b".repeat(64),
      expectedThreadRevision: 4,
      expectedFeatureRevision: 2,
      desiredPostcondition: { sandboxMode: "workspace-write" },
      now: 403,
    })).toThrow(/already used/i);
  });
});
