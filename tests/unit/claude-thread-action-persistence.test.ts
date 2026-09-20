import { claudeSteerOperationsMigration } from "../../src/server/db/migrations/102-claude-steer-operations.js";
import { claudeTaskLifecycleMigration } from "../../src/server/db/migrations/100-claude-task-lifecycle.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeModelEffortCatalog } from "../../src/server/backends/claude/claude-model-effort-catalog.js";
import { ClaudeThreadActionPersistence } from "../../src/server/backends/claude/claude-thread-action-persistence.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { ClaudeThreadPresentationProvider } from "../../src/server/backends/claude/claude-thread-presentation-provider.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const applicationThreadId = "thread-a";
const backendInstanceId = "claude-backend";
const connectionProfileId = "claude-local";
const databases: Database.Database[] = [];
const permissionPolicy = {
  allowedModes: [
    "default",
    "acceptEdits",
    "dontAsk",
    "auto",
    "bypassPermissions",
  ],
} as const;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(
  effort: string,
  policy:
    | typeof permissionPolicy
    | { readonly allowedModes: readonly ["default"] } = permissionPolicy,
) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE application_threads (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      id TEXT NOT NULL,
      backend_instance_id TEXT NOT NULL,
      backing_state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, owner_principal_id, id)
    );
    CREATE TABLE claude_thread_settings (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      backend_instance_id TEXT NOT NULL,
      connection_profile_id TEXT NOT NULL,
      execution_environment_id TEXT NOT NULL,
      desired_model TEXT,
      desired_effort TEXT,
      desired_permission_mode TEXT,
      effective_model TEXT,
      effective_model_state TEXT NOT NULL,
      effective_model_generation INTEGER,
      effective_effort TEXT,
      effective_effort_state TEXT NOT NULL,
      effective_effort_generation INTEGER,
      effective_permission_mode TEXT,
      effective_permission_classification TEXT,
      effective_permission_state TEXT NOT NULL,
      effective_permission_generation INTEGER,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, owner_principal_id, application_thread_id)
    );
    CREATE TABLE provider_feature_mutation_receipts (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      action_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      expected_thread_revision INTEGER NOT NULL,
      expected_feature_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      desired_postcondition_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      force_reset_at INTEGER,
      PRIMARY KEY(tenant_id, owner_principal_id, mutation_id)
    );
    CREATE TABLE principal_generations (
      tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      inventory_generation INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, principal_id)
    );
    INSERT INTO principal_generations VALUES ('tenant-a', 'principal-a', 0)
  `);
  database
    .prepare(
      `INSERT INTO application_threads(
         tenant_id, owner_principal_id, id, backend_instance_id,
         backing_state, revision, updated_at
       ) VALUES (?, ?, ?, ?, 'unbound', 1, 1)`,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
      backendInstanceId,
    );
  database.exec(claudeTaskLifecycleMigration.sql);
  database.exec(claudeSteerOperationsMigration.sql);
  const settings = new ClaudeThreadRepository(database);
  settings.initialize(
    scope,
    applicationThreadId,
    {
      backendInstanceId,
      connectionProfileId,
      executionEnvironmentId: "local",
    },
    { model: "claude-sonnet-5", effort, permissionMode: "default" },
    1,
  );
  const modelEfforts = new ClaudeModelEffortCatalog();
  const persistence = new ClaudeThreadActionPersistence(
    database,
    scope,
    backendInstanceId,
    settings,
    modelEfforts,
    policy,
    compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
  );
  return { database, settings, modelEfforts, persistence };
}

function setModel(
  persistence: ClaudeThreadActionPersistence,
  value: string,
): void {
  persistence.persistAccepted(scope, applicationThreadId, {
    mutationId: "mutation-a",
    expectedThreadRevision: 1,
    settingsGuard: { kind: "staged", expectedRevision: 0 },
    operation: { action: "set_setting", settingId: "model", value },
    now: 2,
  });
}

describe("ClaudeThreadActionPersistence", () => {
  it("preserves a compatible effort when the model changes", () => {
    const { settings, modelEfforts, persistence } = fixture("high");
    modelEfforts.replace(applicationThreadId, connectionProfileId, [
      {
        provider: connectionProfileId,
        id: "claude-opus-5",
        label: "Claude Opus 5",
        inputModalities: ["text"],
        supportedReasoningEfforts: ["low", "high"],
      },
    ]);

    setModel(persistence, "claude-opus-5");

    expect(settings.get(scope, applicationThreadId)).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
      revision: 1,
    });
  });

  it("uses the model default when the prior effort is unsupported", () => {
    const { database, settings, modelEfforts, persistence } = fixture("xhigh");
    modelEfforts.replace(applicationThreadId, connectionProfileId, [
      {
        provider: connectionProfileId,
        id: "claude-opus-5",
        label: "Claude Opus 5",
        inputModalities: ["text"],
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "high",
      },
    ]);

    setModel(persistence, "claude-opus-5");

    expect(settings.get(scope, applicationThreadId)).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
      revision: 1,
    });
    expect(
      database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId),
    ).toEqual({ revision: 2 });
  });

  it("selects a model that advertises no effort axis", () => {
    const { database, settings, modelEfforts, persistence } = fixture("low");
    modelEfforts.replace(applicationThreadId, connectionProfileId, [
      {
        provider: connectionProfileId,
        id: "claude-opus-5",
        label: "Claude Opus 5",
        inputModalities: ["text"],
        supportedReasoningEfforts: [],
      },
    ]);

    setModel(persistence, "claude-opus-5");
    expect(settings.get(scope, applicationThreadId)).toMatchObject({
      model: "claude-opus-5",
      effort: null,
      revision: 1,
    });
    expect(
      database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId),
    ).toEqual({ revision: 2 });
  });

  it("presents model and effort as independent selectors", async () => {
    const { database, settings, modelEfforts } = fixture("low");
    database
      .prepare(
        `UPDATE application_threads SET backing_state = 'bound'
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .run(scope.tenantId, scope.principalId, applicationThreadId);
    const effectiveModel = "m".repeat(240);
    const effectiveEffort = "e".repeat(120);
    settings.confirmEffectiveModel(scope, applicationThreadId, {
      expectedRevision: 0,
      model: effectiveModel,
      queryGeneration: 1,
      now: 2,
    });
    settings.confirmEffectiveEffort(scope, applicationThreadId, {
      expectedRevision: 1,
      effort: effectiveEffort,
      queryGeneration: 1,
      now: 3,
    });
    const presentation = await new ClaudeThreadPresentationProvider(
      settings,
      modelEfforts,
      permissionPolicy,
      compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    ).read({
      scope,
      applicationThreadId,
      backend: {
        id: backendInstanceId,
        tenantId: scope.tenantId,
        kind: "claude_agent_sdk",
        label: "Claude",
        enabled: true,
        configurationRevision: 1,
        protocolRelease: "0.2.27",
      },
      connection: {
        id: connectionProfileId,
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: connectionProfileId,
        kind: "claude_agent_sdk",
        backendInstanceId,
        executionEnvironmentId: "local",
        label: "Claude Local",
        enabled: true,
        configurationRevision: 1,
      },
      workspace: {} as never,
      catalog: {
        models: [
          {
            provider: connectionProfileId,
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    });

    expect(
      presentation.settings.values.find(({ id }) => id === "model"),
    ).toEqual({
      id: "model",
      desiredValue: "claude-sonnet-5",
      effectiveValue: effectiveModel,
      applicationState: "pending_next_turn",
    });
    expect(
      presentation.settingDescriptors.find(({ id }) => id === "model")?.options,
    ).toEqual([
      {
        value: "claude-sonnet-5",
        label: { text: "Claude Sonnet 5" },
        available: true,
      },
    ]);
    expect(
      presentation.settingDescriptors.find(({ id }) => id === "thinking_level")
        ?.options,
    ).toEqual([{ value: "low", label: { text: "Low" }, available: true }]);
  });

  it("mutates the allowlisted permission mode through the durable feature boundary", async () => {
    const { database, settings, persistence } = fixture("low");

    await expect(
      persistence.performProviderFeature(scope, applicationThreadId, {
        mutationId: "permission-mutation",
        expectedThreadRevision: 1,
        operation: {
          action: "perform_provider_feature",
          feature: { featureId: "claude.permissions", schemaVersion: 1 },
          actionId: "set_permission_bypass",
          arguments: null,
          expectedFeatureRevision: 0,
        },
        now: 2,
      }),
    ).resolves.toEqual({ applicationOperationId: "permission-mutation" });

    expect(settings.get(scope, applicationThreadId)).toMatchObject({
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "bypassPermissions",
      revision: 1,
    });
    expect(
      database
        .prepare(
          `SELECT state, desired_postcondition_json AS desired
           FROM provider_feature_mutation_receipts
           WHERE mutation_id = ?`,
        )
        .get("permission-mutation"),
    ).toEqual({
      state: "accepted",
      desired: JSON.stringify({ permissionMode: "bypassPermissions" }),
    });
  });

  it("rejects a registered permission action outside deployment policy", async () => {
    const { persistence } = fixture("low", { allowedModes: ["default"] });

    await expect(
      persistence.performProviderFeature(scope, applicationThreadId, {
        mutationId: "permission-rejected",
        expectedThreadRevision: 1,
        operation: {
          action: "perform_provider_feature",
          feature: { featureId: "claude.permissions", schemaVersion: 1 },
          actionId: "set_permission_auto",
          arguments: null,
          expectedFeatureRevision: 0,
        },
        now: 2,
      }),
    ).rejects.toThrow("not allowed by deployment policy");
  });

  it("replaces a persisted mode after deployment policy revokes it", async () => {
    const { settings, persistence } = fixture("low", {
      allowedModes: ["default"],
    });
    settings.updateDesired(scope, applicationThreadId, {
      expectedRevision: 0,
      desired: {
        model: "claude-sonnet-5",
        effort: "low",
        permissionMode: "bypassPermissions",
      },
      now: 2,
    });

    await expect(
      persistence.performProviderFeature(scope, applicationThreadId, {
        mutationId: "permission-recovery",
        expectedThreadRevision: 1,
        operation: {
          action: "perform_provider_feature",
          feature: { featureId: "claude.permissions", schemaVersion: 1 },
          actionId: "set_permission_default",
          arguments: null,
          expectedFeatureRevision: 1,
        },
        now: 3,
      }),
    ).resolves.toEqual({ applicationOperationId: "permission-recovery" });
    expect(settings.get(scope, applicationThreadId)).toMatchObject({
      permissionMode: "default",
      revision: 2,
    });
  });
});
