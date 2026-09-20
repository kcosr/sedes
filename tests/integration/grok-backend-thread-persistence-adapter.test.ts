import { expectBackendSessionSummary } from "../support/backend-session-summary.js";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { GrokBackendThreadPersistenceAdapter } from "../../src/server/backends/grok/grok-backend-thread-persistence-adapter.js";
import { GrokModelEffortCatalog } from "../../src/server/backends/grok/grok-model-effort-catalog.js";
import { GrokThreadActionPersistence } from "../../src/server/backends/grok/grok-thread-action-persistence.js";
import { GrokThreadPresentationProvider } from "../../src/server/backends/grok/grok-thread-presentation-provider.js";
import { encodeGrokModelSetting } from "../../src/server/backends/grok/grok-setting-values.js";
import { GrokSavedAgentBackendAdapter } from "../../src/server/backends/grok/grok-saved-agent-adapter.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";
import { serializeGrokConversationBindingDetail } from "../../src/server/backends/grok/grok-conversation-binding.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const openDatabases: Database.Database[] = [];
const nativeNamespaceKey = "grok:test-native-namespace";
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
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
    {
      id: "grok-local",
      kind: "grok_build",
      label: "Grok",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
    {
      id: "grok-default",
      kind: "grok_acp",
      label: "Grok",
      backendInstanceId: "grok-local",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
      moduleConfiguration: {
        defaults: {
          model: { type: "catalogDefault" },
          reasoningEffort: { type: "modelDefault" },
        },
      },
    },
  ],
  defaultTargetId: "local-primary",
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe("Grok backend thread persistence adapter", () => {
  it("validates catalog defaults and persists one exact scoped native binding", async () => {
    const { database, scope } = savedAgentDatabase();
    openDatabases.push(database);
    const repository = new BackendConfigurationRepository(database);
    repository.reconcile(scope, configuration, {
      localWorkspaceRoots: [],
      now: 200,
    });
    const row = repository
      .listProfiles(scope)
      .find(({ kind }) => kind === "grok_acp")!;
    const connection: AgentConnectionProfile = {
      ...row,
      enabled: row.enabled === 1,
    };
    const workspace = new InventoryRepository(database).upsertWorkspace(scope, {
      environmentId: connection.executionEnvironmentId,
      canonicalPath: "/tmp/grok-persistence-adapter",
      displayName: "Grok persistence adapter",
      available: true,
      trustState: "trusted",
      environmentConfigurationRevision: 0,
      now: 210,
    });
    const bindings = new ConversationBindingRepository(database);
    const thread = bindings.createUnboundThread(scope, {
      id: "thread-grok-import",
      workspaceId: workspace.id,
      connectionProfileId: connection.id,
      title: "Imported Grok thread",
      now: 220,
    });
    const adapter = new GrokBackendThreadPersistenceAdapter({
      database,
      scope,
      backendInstanceId: connection.backendInstanceId,
      nativeNamespaceKey,
      resolveConnectionDefaults: (candidate) =>
        candidate.id === connection.id
          ? {
              model: { type: "catalogDefault" },
              reasoningEffort: { type: "modelDefault" },
            }
          : undefined,
      modelPolicy: compileBackendModelPolicy(
        { type: "catalog" },
        "model_effort",
      ),
      now: () => 220,
    });
    const catalog = {
      models: [
        {
          provider: connection.id,
          id: "grok-build",
          label: "Grok Build",
          inputModalities: ["text" as const],
          isDefault: true as const,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        },
      ],
      commands: [],
      skills: [],
      notices: [],
    };
    expect(() =>
      adapter.initializeNewThread(scope, thread.id, connection, catalog),
    ).not.toThrow();
    expect(adapter.settings.get(scope, thread.id)).toMatchObject({
      model: "grok-build",
      effort: "low",
      effectiveState: "unknown",
      revision: 0,
    });
    const modelEfforts = new GrokModelEffortCatalog();
    const modelPolicy = compileBackendModelPolicy(
      { type: "catalog" },
      "model_effort",
    );
    const presentationProvider = new GrokThreadPresentationProvider(
      adapter.settings,
      modelEfforts,
      modelPolicy,
    );
    const presentationInput = {
      scope,
      applicationThreadId: thread.id,
      backend: {
        id: "grok-local",
        tenantId: scope.tenantId,
        kind: "grok_build" as const,
        label: "Grok",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "1.x",
      },
      connection,
      workspace: {} as never,
      catalog,
    };
    const draftPresentation =
      await presentationProvider.read(presentationInput);
    expect(draftPresentation.settingDescriptors).toMatchObject([
      { id: "model", available: true },
      { id: "thinking_level", available: true },
    ]);
    expect(draftPresentation.settings.values).toEqual([
      {
        id: "model",
        desiredValue: encodeGrokModelSetting("grok-build", "low"),
        effectiveValue: null,
        applicationState: "draft",
      },
      {
        id: "thinking_level",
        desiredValue: "low",
        effectiveValue: null,
        applicationState: "draft",
      },
    ]);
    modelEfforts.replace(thread.id, connection.id, catalog.models);
    const actions = new GrokThreadActionPersistence(
      database,
      scope,
      connection.backendInstanceId,
      adapter.settings,
      modelEfforts,
      modelPolicy,
    );
    const currentThreadRevision = (
      database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, thread.id) as {
        readonly revision: number;
      }
    ).revision;
    actions.persistAccepted(scope, thread.id, {
      mutationId: "setting-1",
      expectedThreadRevision: currentThreadRevision,
      settingsGuard: { kind: "staged", expectedRevision: 0 },
      operation: {
        action: "set_setting",
        settingId: "thinking_level",
        value: "high",
      },
      now: 225,
    });
    expect(adapter.settings.get(scope, thread.id)).toMatchObject({
      model: "grok-build",
      effort: "high",
      effectiveState: "unknown",
      revision: 1,
    });
    const savedAgents = new GrokSavedAgentBackendAdapter({
      persistence: adapter,
      modelPolicy,
      resolveConnectionDefaults: () => ({
        model: { type: "catalogDefault" },
        reasoningEffort: { type: "modelDefault" },
      }),
    });
    const capture = savedAgents.captureThreadConfiguration({
      scope,
      applicationThreadId: thread.id,
      connection,
    });
    expect(capture).toEqual({
      backendTypeId: "grok",
      schemaVersion: 2,
      settingsRevision: 1,
      overrides: [
        { id: "model", value: "grok-build" },
        { id: "reasoning_effort", value: "high" },
      ],
    });
    const savedThread = bindings.createUnboundThread(scope, {
      id: "thread-grok-saved-agent",
      workspaceId: workspace.id,
      connectionProfileId: connection.id,
      title: "Saved Grok thread",
      now: 226,
    });
    adapter.initializeThread(scope, savedThread.id, connection);
    database.transaction(() => {
      const transaction =
        ConversationCreationTransaction.fromActiveDatabase(database);
      savedAgents.assertThreadConfigurationCapture({
        transaction,
        scope,
        applicationThreadId: thread.id,
        connection,
        capture,
      });
      savedAgents.initializeNewThread({
        transaction,
        scope,
        applicationThreadId: savedThread.id,
        connection,
        resolved: {
          backendTypeId: "grok",
          schemaVersion: 2,
          normalizedValues: [
            { id: "model", value: "grok-build" },
            { id: "reasoning_effort", value: "high" },
          ],
          value: { model: "grok-build", effort: "high" },
        },
      });
    })();
    expect(adapter.settings.get(scope, savedThread.id)).toMatchObject({
      model: "grok-build",
      effort: "high",
      effectiveState: "unknown",
    });
    expect(
      adapter.initializationActions(scope, thread.id, "attempt-1"),
    ).toEqual([
      {
        applicationOperationId: "attempt-1:initial-title",
        action: "rename",
        title: "Imported Grok thread",
      },
    ]);
    expect(() =>
      adapter.initializeNewThread(scope, thread.id, connection, {
        ...catalog,
        models: [],
      }),
    ).toThrow(/available Grok model/i);

    const backendConversationId = "native-session-1";
    bindings.bindDiscoveredConversation(scope, thread.id, {
      backendConversationId,
      now: 230,
    });
    expectBackendSessionSummary(database, scope, thread.id, backendConversationId);
    const detail = serializeGrokConversationBindingDetail({
      version: 1,
      sessionId: backendConversationId,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: connection.backendInstanceId,
      connectionProfileId: connection.id,
      executionEnvironmentId: connection.executionEnvironmentId,
      canonicalWorkspacePath: workspace.canonicalPath,
      nativeNamespaceKey,
    });
    adapter.saveBoundBindingDetail(scope, thread.id, detail);
    const boundThreadRevision = (
      database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, thread.id) as {
        readonly revision: number;
      }
    ).revision;
    expect(() =>
      actions.persistAccepted(scope, thread.id, {
        mutationId: "setting-bound-rejected",
        expectedThreadRevision: boundThreadRevision,
        settingsGuard: { kind: "staged", expectedRevision: 1 },
        operation: {
          action: "set_setting",
          settingId: "thinking_level",
          value: "low",
        },
        now: 235,
      }),
    ).toThrow(/changed in another client/u);
    const preConfirmation = adapter.settings.get(scope, thread.id);
    const confirmedSettings = adapter.settings.confirmEffective(
      scope,
      thread.id,
      {
        model: "grok-build",
        effort: "high",
        now: 240,
      },
    );
    expect(confirmedSettings).toMatchObject({
      effectiveModel: "grok-build",
      effectiveEffort: "high",
      effectiveState: "confirmed",
      revision: preConfirmation.revision + 1,
    });
    expect(
      adapter.settings.confirmEffective(scope, thread.id, {
        model: "grok-build",
        effort: "high",
        now: 241,
      }),
    ).toEqual(confirmedSettings);
    const boundPresentation =
      await presentationProvider.read(presentationInput);
    expect(boundPresentation.settingDescriptors).toMatchObject([
      { id: "model", available: false },
      { id: "thinking_level", available: false },
    ]);
    expect(boundPresentation.settings.values).toEqual([
      {
        id: "model",
        desiredValue: encodeGrokModelSetting("grok-build", "high"),
        effectiveValue: encodeGrokModelSetting("grok-build", "high"),
        applicationState: "effective",
      },
      {
        id: "thinking_level",
        desiredValue: "high",
        effectiveValue: "high",
        applicationState: "effective",
      },
    ]);
    expect(() =>
      adapter.settings.confirmEffective(scope, thread.id, {
        model: "other-model",
        effort: "high",
        now: 250,
      }),
    ).toThrow(/effective_settings_mismatch/u);
    expect(adapter.getBindingDetail(scope, thread.id)).toBe(detail);
    expect(() =>
      adapter.getBindingDetail(
        { tenantId: scope.tenantId, principalId: "other-principal" },
        thread.id,
      ),
    ).toThrow(/does not match/i);

    const renameThreadRevision = (
      database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, thread.id) as {
        readonly revision: number;
      }
    ).revision;
    actions.persistAccepted(scope, thread.id, {
      mutationId: "rename-1",
      expectedThreadRevision: renameThreadRevision,
      settingsGuard: { kind: "proven_applied" },
      operation: { action: "rename", title: "Persisted Grok title" },
      now: 240,
    });
    expect(
      database
        .prepare(
          `SELECT title, revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, thread.id),
    ).toEqual({
      title: "Persisted Grok title",
      revision: renameThreadRevision + 1,
    });
    expect(() =>
      actions.persistAccepted(scope, thread.id, {
        mutationId: "rename-stale",
        expectedThreadRevision: renameThreadRevision,
        settingsGuard: { kind: "proven_applied" },
        operation: { action: "rename", title: "Stale title" },
        now: 250,
      }),
    ).toThrow(/changed/i);
    expect(() =>
      actions.persistAccepted(
        { tenantId: scope.tenantId, principalId: "other-principal" },
        thread.id,
        {
          mutationId: "rename-wrong-scope",
          expectedThreadRevision: renameThreadRevision + 1,
          settingsGuard: { kind: "proven_applied" },
          operation: { action: "rename", title: "Wrong scope" },
          now: 260,
        },
      ),
    ).toThrow(/changed/i);
  });
});
