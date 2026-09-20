import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { PiBackendThreadPersistenceAdapter } from "../../src/server/backends/pi/pi-backend-thread-persistence-adapter.js";
import { PiSavedAgentAdapter } from "../../src/server/backends/pi/pi-saved-agent-adapter.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";
import {
  extractPiNativeSessionPath,
  parsePiBindingDetail,
  serializePiBindingDetail,
} from "../../src/server/backends/pi/pi-session-store.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConnectionSettingPreferenceRepository } from "../../src/server/db/repositories/connection-setting-preference-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { PiThreadActionPersistence } from "../../src/server/backends/pi/pi-thread-action-persistence.js";
import {
  encodePiModelSetting,
  PiThreadPresentationProvider,
} from "../../src/server/backends/pi/pi-thread-presentation-provider.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const catalogPiModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "provider_model_effort",
);

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
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary local Pi SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

type Fixture = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly workspaceId: string;
  readonly connection: AgentConnectionProfile;
  readonly bindings: ConversationBindingRepository;
  readonly creation: ConversationCreationRepository;
  readonly drafts: ConversationDraftRepository;
  readonly pi: PiConversationRepository;
  readonly preferences: ConnectionSettingPreferenceRepository;
  readonly adapter: PiBackendThreadPersistenceAdapter;
};

const openDatabases: Database.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): Fixture {
  const database = openOverlayDatabase(":memory:");
  openDatabases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/pi-persistence-adapter",
      displayName: "Pi persistence adapter",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 200,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const profile = new BackendConfigurationRepository(database).listProfiles(
    scope,
  )[0]!;
  const connection: AgentConnectionProfile = {
    id: profile.id,
    tenantId: profile.tenantId,
    ownerPrincipalId: profile.ownerPrincipalId,
    templateId: profile.templateId,
    kind: profile.kind,
    backendInstanceId: profile.backendInstanceId,
    executionEnvironmentId: profile.executionEnvironmentId,
    label: profile.label,
    enabled: profile.enabled === 1,
    configurationRevision: profile.configurationRevision,
  };
  const pi = new PiConversationRepository(database);
  const preferences = new ConnectionSettingPreferenceRepository(database);
  return {
    database,
    scope,
    workspaceId: workspace.id,
    connection,
    bindings: new ConversationBindingRepository(database),
    creation: new ConversationCreationRepository(database),
    drafts: new ConversationDraftRepository(database),
    pi,
    preferences,
    adapter: new PiBackendThreadPersistenceAdapter(pi, preferences),
  };
}

function createPrepared(
  target: Fixture,
  suffix: string,
): {
  readonly threadId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly backendConversationId: string;
} {
  const threadId = `thread-${suffix}`;
  target.bindings.createUnboundThread(target.scope, {
    id: threadId,
    workspaceId: target.workspaceId,
    connectionProfileId: target.connection.id,
    title: `Thread ${suffix}`,
    now: 300,
  });
  target.adapter.initializeThread(target.scope, threadId, target.connection);
  target.drafts.save(target.scope, threadId, {
    text: `Prompt ${suffix}`,
    contextExcerpts: [],
    attachmentIds: [],
    taskReferenceIds: [],
    expectedRevision: 0,
    now: 310,
  });
  const attemptId = `attempt-${suffix}`;
  const operationId = `operation-${suffix}`;
  const backendConversationId = `conversation-${suffix}`;
  target.creation.prepare(target.scope, threadId, {
    attemptId,
    mutationId: operationId,
    expectedThreadRevision: 0,
    creationKind: "first_input",
    sourceKind: "composer",
    initialInputText: `Prompt ${suffix}`,
    initialContextExcerpts: [],
    initialAttachmentIds: [],
    initialTaskReferences: [],
    expectedDraftRevision: 1,
    backendCreationCorrelation: backendConversationId,
    now: 320,
  });
  return {
    threadId,
    attemptId,
    operationId,
    backendConversationId,
  };
}

describe("Pi backend thread persistence adapter", () => {
  it("declares provider-feature mutations quiet-thread even though Pi advertises none", () => {
    const target = fixture();
    const persistence = new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    );

    expect(
      persistence.providerFeatureConcurrency(
        { featureId: "codex.tui", schemaVersion: 1 },
        "start",
      ),
    ).toEqual({ kind: "quiet_thread" });
  });

  it("copies only an available saved model into a new draft", () => {
    const target = fixture();
    const preferredValue = encodePiModelSetting("anthropic", "claude-sonnet");
    target.preferences.save(
      target.scope,
      target.connection.id,
      "model",
      preferredValue,
      250,
    );

    const firstThreadId = "thread-preferred-model";
    target.bindings.createUnboundThread(target.scope, {
      id: firstThreadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Preferred model",
      now: 300,
    });
    target.adapter.initializeNewThread(
      target.scope,
      firstThreadId,
      target.connection,
      {
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet",
            label: "Claude Sonnet",
            inputModalities: ["text"] as const,
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    );
    expect(target.pi.getSettings(target.scope, firstThreadId)).toMatchObject({
      modelProvider: "anthropic",
      modelId: "claude-sonnet",
    });

    const unavailableThreadId = "thread-unavailable-model";
    target.bindings.createUnboundThread(target.scope, {
      id: unavailableThreadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Unavailable model",
      now: 310,
    });
    target.adapter.initializeNewThread(
      target.scope,
      unavailableThreadId,
      target.connection,
      { models: [], commands: [], skills: [], notices: [] },
    );
    expect(
      target.pi.getSettings(target.scope, unavailableThreadId),
    ).toMatchObject({
      modelProvider: null,
      modelId: null,
    });
    expect(() =>
      target.adapter.validateInitialization(target.scope, unavailableThreadId, {
        models: [],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).toThrow("Choose an available model");
  });

  it("copies only a supported saved thinking level into a new draft", () => {
    const target = fixture();
    target.preferences.save(
      target.scope,
      target.connection.id,
      "thinking_level",
      "high",
      250,
    );
    const preferredThreadId = "thread-preferred-thinking";
    target.bindings.createUnboundThread(target.scope, {
      id: preferredThreadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Preferred thinking",
      now: 300,
    });
    target.adapter.initializeNewThread(
      target.scope,
      preferredThreadId,
      target.connection,
      { models: [], commands: [], skills: [], notices: [] },
    );
    expect(
      target.pi.getSettings(target.scope, preferredThreadId),
    ).toMatchObject({
      thinkingLevel: "high",
    });

    target.preferences.save(
      target.scope,
      target.connection.id,
      "thinking_level",
      "future-unsupported-level",
      310,
    );
    const unavailableThreadId = "thread-unavailable-thinking";
    target.bindings.createUnboundThread(target.scope, {
      id: unavailableThreadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Unavailable thinking",
      now: 320,
    });
    target.adapter.initializeNewThread(
      target.scope,
      unavailableThreadId,
      target.connection,
      { models: [], commands: [], skills: [], notices: [] },
    );
    expect(
      target.pi.getSettings(target.scope, unavailableThreadId),
    ).toMatchObject({
      thinkingLevel: null,
    });
  });

  it("initializes an exact resolved tuple without changing connection preferences", () => {
    const target = fixture();
    target.preferences.save(
      target.scope,
      target.connection.id,
      "model",
      encodePiModelSetting("preferred-provider", "preferred-model"),
      250,
    );
    target.preferences.save(
      target.scope,
      target.connection.id,
      "thinking_level",
      "low",
      251,
    );
    const threadId = "thread-resolved-agent";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Resolved Agent",
      now: 300,
    });

    target.adapter.initializeResolvedNewThread(
      target.scope,
      threadId,
      target.connection,
      {
        modelProvider: "agent-provider",
        modelId: "agent-model",
        thinkingLevel: "high",
        toolAccess: "ask",
      },
    );

    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "agent-provider",
      modelId: "agent-model",
      thinkingLevel: "high",
      toolMode: "ask",
      revision: 0,
    });
    expect(
      target.preferences.find(target.scope, target.connection.id, "model"),
    ).toMatchObject({
      value: encodePiModelSetting("preferred-provider", "preferred-model"),
      revision: 0,
    });
    expect(
      target.preferences.find(
        target.scope,
        target.connection.id,
        "thinking_level",
      ),
    ).toMatchObject({ value: "low", revision: 0 });
  });

  it("projects and transactionally initializes the normalized Pi SavedAgent adapter", () => {
    const target = fixture();
    const preferredModel = encodePiModelSetting("xai", "grok-4.5");
    target.preferences.save(
      target.scope,
      target.connection.id,
      "model",
      preferredModel,
      250,
    );
    target.preferences.save(
      target.scope,
      target.connection.id,
      "thinking_level",
      "low",
      251,
    );
    const adapter = new PiSavedAgentAdapter({
      preferences: target.preferences,
      persistence: target.adapter,
    });
    const context = {
      scope: target.scope,
      workspace: {
        summary: {
          environmentId: target.connection.executionEnvironmentId,
        },
      } as never,
      connection: target.connection,
      catalog: {
        models: [
          {
            provider: "xai",
            id: "grok-4.5",
            label: "xAI / Grok 4.5",
            inputModalities: ["text"] as const,
            supportedReasoningEfforts: ["off", "low", "high"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    };
    const prepared = adapter.prepareResolutionContext(context);
    const overrides = adapter.validateOverrides({
      overrides: [
        { id: "thinking_level", value: "high" },
        { id: "tool_access", value: "ask" },
      ],
    });
    const descriptor = adapter.describeEditor({
      ...context,
      prepared,
      overrides,
    });
    expect(descriptor).toMatchObject({
      backendTypeId: "pi",
      canonicalOverrides: [
        { id: "thinking_level", value: "high" },
        { id: "tool_access", value: "ask" },
      ],
      fields: [
        {
          id: "model",
          currentDefaultValue: preferredModel,
          resolvedValue: preferredModel,
        },
        {
          id: "thinking_level",
          currentDefaultValue: "low",
          resolvedValue: "high",
        },
        {
          id: "tool_access",
          currentDefaultValue: "full",
          resolvedValue: "ask",
        },
      ],
    });
    const resolved = adapter.resolve({
      ...context,
      prepared,
      overrides,
    });
    expect(resolved.normalizedValues).toEqual([
      { id: "model", value: preferredModel },
      { id: "thinking_level", value: "high" },
      { id: "tool_access", value: "ask" },
    ]);
    expect(() =>
      adapter.resolve({
        ...context,
        prepared: { ...prepared, schemaVersion: 2 },
        overrides,
      }),
    ).toThrow("configuration version is invalid");

    const threadId = "thread-common-pi-saved-agent";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Common Pi SavedAgent",
      now: 300,
    });
    target.database.transaction(() =>
      adapter.initializeNewThread({
        transaction: ConversationCreationTransaction.fromActiveDatabase(
          target.database,
        ),
        scope: target.scope,
        applicationThreadId: threadId,
        connection: target.connection,
        resolved,
      }),
    )();
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.5",
      thinkingLevel: "high",
      toolMode: "ask",
      revision: 0,
    });
    const capture = adapter.captureThreadConfiguration({
      scope: target.scope,
      applicationThreadId: threadId,
      connection: target.connection,
    });
    expect(capture).toEqual({
      backendTypeId: "pi",
      schemaVersion: 1,
      settingsRevision: 0,
      overrides: [
        { id: "model", value: preferredModel },
        { id: "thinking_level", value: "high" },
        { id: "tool_access", value: "ask" },
      ],
    });

    target.preferences.save(
      target.scope,
      target.connection.id,
      "model",
      encodePiModelSetting("xai", "another-model"),
      400,
    );
    const driftedThreadId = "thread-drifted-pi-saved-agent";
    target.bindings.createUnboundThread(target.scope, {
      id: driftedThreadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Drifted Pi SavedAgent",
      now: 410,
    });
    expect(() =>
      target.database.transaction(() =>
        adapter.initializeNewThread({
          transaction: ConversationCreationTransaction.fromActiveDatabase(
            target.database,
          ),
          scope: target.scope,
          applicationThreadId: driftedThreadId,
          connection: target.connection,
          resolved,
        }),
      )(),
    ).toThrow("target defaults changed");
    expect(
      target.database
        .prepare(
          `
            SELECT 1
            FROM pi_thread_settings
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
          `,
        )
        .get(target.scope.tenantId, target.scope.principalId, driftedThreadId),
    ).toBeUndefined();

    target.pi.updateSettings(target.scope, threadId, {
      expectedRevision: 0,
      modelProvider: "xai",
      modelId: "grok-4.5",
      thinkingLevel: "low",
      toolMode: "ask",
    });
    expect(() =>
      target.database.transaction(() =>
        adapter.assertThreadConfigurationCapture({
          transaction: ConversationCreationTransaction.fromActiveDatabase(
            target.database,
          ),
          scope: target.scope,
          applicationThreadId: threadId,
          connection: target.connection,
          capture,
        }),
      )(),
    ).toThrow("source Pi settings changed");

    target.pi.updateSettings(target.scope, threadId, {
      expectedRevision: 1,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      toolMode: "ask",
    });
    expect(() =>
      adapter.captureThreadConfiguration({
        scope: target.scope,
        applicationThreadId: threadId,
        connection: target.connection,
      }),
    ).toThrow("Choose complete Pi settings");

    expect(() =>
      adapter.prepareResolutionContext({
        ...context,
        workspace: {
          summary: { environmentId: "another-environment" },
        } as never,
      }),
    ).toThrow("target is unavailable");
  });

  it("projects an editable Pi model field before the required model is selected", () => {
    const target = fixture();
    const adapter = new PiSavedAgentAdapter({
      preferences: target.preferences,
      persistence: target.adapter,
    });
    const context = {
      scope: target.scope,
      workspace: {
        summary: {
          environmentId: target.connection.executionEnvironmentId,
        },
      } as never,
      connection: target.connection,
      catalog: {
        models: [
          {
            provider: "xai",
            id: "grok-4.5",
            label: "xAI / Grok 4.5",
            inputModalities: ["text"] as const,
            supportedReasoningEfforts: ["off", "low", "high"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    };
    const prepared = adapter.prepareResolutionContext(context);
    const overrides = adapter.validateOverrides({ overrides: [] });

    const descriptor = adapter.describeEditor({
      ...context,
      prepared,
      overrides,
    });
    expect(descriptor).toMatchObject({
      backendTypeId: "pi",
      canonicalOverrides: [],
    });
    expect(descriptor.fields[0]).toMatchObject({
      id: "model",
      currentDefaultValue: null,
      resolvedValue: null,
      options: [{ available: true }],
    });
    expect(() => adapter.resolve({ ...context, prepared, overrides })).toThrow(
      "Choose a Pi model",
    );
  });

  it("revalidates the selected model and thinking pair before first submission", () => {
    const target = fixture();
    const threadId = "thread-stale-thinking-support";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Stale thinking support",
      now: 300,
    });
    target.pi.initializeSettings(target.scope, threadId, {
      modelProvider: "provider-a",
      modelId: "model-a",
      thinkingLevel: "high",
      toolMode: "read_only",
    });

    expect(() =>
      target.adapter.validateInitialization(target.scope, threadId, {
        models: [
          {
            provider: "provider-a",
            id: "model-a",
            label: "Model A",
            inputModalities: ["text"] as const,
            supportedReasoningEfforts: ["off", "low"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).toThrow("thinking level is not available");

    expect(() =>
      target.adapter.validateInitialization(target.scope, threadId, {
        models: [
          {
            provider: "provider-a",
            id: "model-a",
            label: "Model A",
            inputModalities: ["text"] as const,
            supportedReasoningEfforts: ["off", "low", "high"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).not.toThrow();
  });

  it("saves an accepted model as the connection preference", () => {
    const target = fixture();
    const threadId = "thread-save-preference";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Save preference",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    const value = encodePiModelSetting("openai", "gpt-test");
    new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    ).persistAccepted(target.scope, threadId, {
      mutationId: "save-model",
      expectedThreadRevision: 0,
      settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
      operation: {
        action: "set_setting",
        settingId: "model",
        value,
      },
      now: 400,
    });

    expect(
      target.preferences.find(target.scope, target.connection.id, "model"),
    ).toMatchObject({ value, revision: 0 });
  });

  it("clears a model-dependent thinking default when the model changes", () => {
    const target = fixture();
    const threadId = "thread-model-clears-thinking";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Change model",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    target.preferences.save(
      target.scope,
      target.connection.id,
      "thinking_level",
      "max",
      310,
    );
    target.pi.updateSettings(target.scope, threadId, {
      expectedRevision: 0,
      modelProvider: null,
      modelId: null,
      thinkingLevel: "max",
      toolMode: "full",
    });
    const value = encodePiModelSetting("provider-b", "model-b");

    new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    ).persistAccepted(target.scope, threadId, {
      mutationId: "change-model-clears-thinking",
      expectedThreadRevision: 0,
      settingsGuard: { kind: "staged" as const, expectedRevision: 1 },
      operation: {
        action: "set_setting",
        settingId: "model",
        value,
      },
      now: 400,
    });

    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: null,
      revision: 2,
    });
    expect(
      target.preferences.find(
        target.scope,
        target.connection.id,
        "thinking_level",
      ),
    ).toBeUndefined();
  });

  it("persists a proven-applied accept at the current revision after observed adoption advanced it", () => {
    const target = fixture();
    const threadId = "thread-proven-applied-settings";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Proven applied settings",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    const persistence = new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    );

    // Staged model change clears the thinking axis (settings rev 0 → 1).
    persistence.persistAccepted(target.scope, threadId, {
      mutationId: "model-change",
      expectedThreadRevision: 0,
      settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: encodePiModelSetting("provider-b", "model-b"),
      },
      now: 400,
    });
    // The attached session is authoritative for the axes it owns: its
    // observed thinking level is re-adopted (settings rev 1 → 2) while the
    // follow-up thinking action is in flight.
    target.pi.syncObservedSettings(target.scope, threadId, {
      expectedRevision: 1,
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: "low",
    });

    // A staged fence with the pre-adoption revision must keep failing
    // closed; reusing it after proven application is what wedged receipts.
    expect(() =>
      persistence.persistAccepted(target.scope, threadId, {
        mutationId: "thinking-stale-staged",
        expectedThreadRevision: 1,
        settingsGuard: { kind: "staged" as const, expectedRevision: 1 },
        operation: {
          action: "set_setting",
          settingId: "thinking_level",
          value: "high",
        },
        now: 500,
      }),
    ).toThrow("Pi settings changed or were not found.");
    expect(target.pi.getSettings(target.scope, threadId).revision).toBe(2);

    // The proven-applied fence persists against the current revision.
    persistence.persistAccepted(target.scope, threadId, {
      mutationId: "thinking-proven",
      expectedThreadRevision: 1,
      settingsGuard: { kind: "proven_applied" as const },
      operation: {
        action: "set_setting",
        settingId: "thinking_level",
        value: "high",
      },
      now: 500,
    });
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      thinkingLevel: "high",
      revision: 3,
    });
    expect(
      target.preferences.find(
        target.scope,
        target.connection.id,
        "thinking_level",
      ),
    ).toMatchObject({ value: "high" });
  });

  it("withholds observed session settings until the thread is bound", () => {
    const target = fixture();
    const threadId = "thread-observed-settings-binding-gate";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Observed settings binding gate",
      now: 300,
    });
    target.pi.initializeSettings(target.scope, threadId, {
      modelProvider: "provider-a",
      modelId: "model-a",
      thinkingLevel: "low",
      toolMode: "full",
    });
    const observed = {
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: "high",
    };

    expect(
      target.pi.syncObservedSettingsForBoundThread(
        target.scope,
        threadId,
        observed,
      ),
    ).toBe(false);
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "provider-a",
      modelId: "model-a",
      thinkingLevel: "low",
      revision: 0,
    });

    target.drafts.save(target.scope, threadId, {
      text: "Prompt binding gate",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: 0,
      now: 310,
    });
    target.creation.prepare(target.scope, threadId, {
      attemptId: "attempt-observed-settings-binding-gate",
      mutationId: "operation-observed-settings-binding-gate",
      expectedThreadRevision: 0,
      creationKind: "first_input",
      sourceKind: "composer",
      initialInputText: "Prompt binding gate",
      initialContextExcerpts: [],
      initialAttachmentIds: [],
      initialTaskReferences: [],
      expectedDraftRevision: 1,
      backendCreationCorrelation: "conversation-observed-settings-binding-gate",
      now: 320,
    });
    expect(
      target.pi.syncObservedSettingsForBoundThread(
        target.scope,
        threadId,
        observed,
      ),
    ).toBe(false);
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "provider-a",
      modelId: "model-a",
      thinkingLevel: "low",
      revision: 0,
    });

    target.database
      .prepare(
        `
          UPDATE application_threads
          SET backing_state = 'bound'
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .run(target.scope.tenantId, target.scope.principalId, threadId);
    expect(
      target.pi.syncObservedSettingsForBoundThread(
        target.scope,
        threadId,
        observed,
      ),
    ).toBe(true);
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: "high",
      revision: 1,
    });

    target.pi.updateSettings(target.scope, threadId, {
      expectedRevision: 1,
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: null,
      toolMode: "full",
    });
    expect(
      target.pi.syncObservedSettingsForBoundThread(
        target.scope,
        threadId,
        observed,
      ),
    ).toBe(false);
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      modelProvider: "provider-b",
      modelId: "model-b",
      thinkingLevel: null,
      revision: 2,
    });
  });

  it("saves an accepted thinking level as the connection preference", () => {
    const target = fixture();
    const threadId = "thread-save-thinking-preference";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Save thinking preference",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    ).persistAccepted(target.scope, threadId, {
      mutationId: "save-thinking",
      expectedThreadRevision: 0,
      settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
      operation: {
        action: "set_setting",
        settingId: "thinking_level",
        value: "xhigh",
      },
      now: 400,
    });

    expect(
      target.preferences.find(
        target.scope,
        target.connection.id,
        "thinking_level",
      ),
    ).toMatchObject({ value: "xhigh", revision: 0 });
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      thinkingLevel: "xhigh",
      revision: 1,
    });
  });

  it("rejects an unsupported thinking level before applying or saving it", () => {
    const target = fixture();
    const threadId = "thread-invalid-thinking-preference";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Invalid thinking preference",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    const persistence = new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    );
    const operation = {
      action: "set_setting" as const,
      settingId: "thinking_level" as const,
      value: "future-unsupported-level",
    };

    expect(() =>
      persistence.driverAction(operation, "invalid-thinking"),
    ).toThrow("pi_thinking_level_invalid");
    expect(() =>
      persistence.persistAccepted(target.scope, threadId, {
        mutationId: "invalid-thinking",
        expectedThreadRevision: 0,
        settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
        operation,
        now: 400,
      }),
    ).toThrow("pi_thinking_level_invalid");
    expect(target.pi.getSettings(target.scope, threadId)).toMatchObject({
      thinkingLevel: null,
      revision: 0,
    });
    expect(
      target.preferences.find(
        target.scope,
        target.connection.id,
        "thinking_level",
      ),
    ).toBeUndefined();
  });

  it("presents the effective Pi model instead of an unset overlay value", async () => {
    const target = fixture();
    const threadId = "thread-effective-model";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Effective model",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    const presentation = await new PiThreadPresentationProvider(
      target.pi,
      catalogPiModelPolicy,
    ).read({
      scope: target.scope,
      applicationThreadId: threadId,
      backend: {
        id: "pi-primary",
        tenantId: target.scope.tenantId,
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.86.0",
      },
      connection: target.connection,
      workspace: {} as never,
      catalog: {
        models: [
          {
            provider: "openai",
            id: "gpt-effective",
            label: "OpenAI / GPT Effective",
            inputModalities: ["text"] as const,
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
      effectiveSettings: {
        model: { provider: "openai", id: "gpt-effective" },
      },
    });

    expect(presentation.settings.values).toContainEqual({
      id: "model",
      desiredValue: encodePiModelSetting("openai", "gpt-effective"),
      effectiveValue: null,
      applicationState: "draft",
    });
    expect(presentation.backend.modelLabel).toEqual({
      text: "OpenAI / GPT Effective",
    });
    expect(presentation.automationAllowed).toBe(false);
    expect(
      presentation.settingDescriptors
        .find(({ id }) => id === "model")
        ?.options.find(
          ({ value }) =>
            value === encodePiModelSetting("openai", "gpt-effective"),
        ),
    ).toEqual({
      value: encodePiModelSetting("openai", "gpt-effective"),
      label: { text: "OpenAI / GPT Effective" },
      available: true,
    });
    expect(presentation.providerFeatureCapabilities).toEqual([]);
    expect(presentation.providerFeatureStates).toEqual([]);
  });

  it("gates thinking options by the selected model's advertised support", async () => {
    const target = fixture();
    const threadId = "thread-gated-thinking";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Gated thinking",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    new PiThreadActionPersistence(
      target.pi,
      target.preferences,
    ).persistAccepted(target.scope, threadId, {
      mutationId: "select-clamped-model",
      expectedThreadRevision: 0,
      settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: encodePiModelSetting("fireworks", "kimi-k3-fast"),
      },
      now: 400,
    });
    const read = (
      models: readonly object[],
      effectiveSettings?: {
        readonly model: { readonly provider: string; readonly id: string };
        readonly thinkingLevel: string;
      },
    ) =>
      new PiThreadPresentationProvider(target.pi, catalogPiModelPolicy).read({
        scope: target.scope,
        applicationThreadId: threadId,
        backend: {
          id: "pi-primary",
          tenantId: target.scope.tenantId,
          kind: "pi",
          label: "Primary Pi",
          enabled: true,
          configurationRevision: 0,
          protocolRelease: "0.86.0",
        },
        connection: target.connection,
        workspace: {} as never,
        catalog: { models, commands: [], skills: [], notices: [] } as never,
        effectiveSettings,
      });

    const gated = await read([
      {
        provider: "fireworks",
        id: "kimi-k3-fast",
        label: "Kimi K3 Fast",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    ]);
    const thinking = gated.settingDescriptors.find(
      ({ id }) => id === "thinking_level",
    );
    expect(thinking?.available).toBe(true);
    expect(
      thinking?.options.map(({ value, available }) => [value, available]),
    ).toEqual([
      ["off", false],
      ["minimal", false],
      ["low", true],
      ["medium", true],
      ["high", true],
      ["xhigh", false],
      ["max", false],
    ]);
    expect(
      thinking?.options
        .filter(({ value }) => value === "xhigh" || value === "max")
        .map(({ value, label }) => [value, label.text]),
    ).toEqual([
      ["xhigh", "Extra High"],
      ["max", "Maximum"],
    ]);

    target.database
      .prepare(
        `UPDATE application_threads SET backing_state = 'bound'
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .run(target.scope.tenantId, target.scope.principalId, threadId);
    const clamped = await read(
      [
        {
          provider: "fireworks",
          id: "kimi-k3-fast",
          label: "Kimi K3 Fast",
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      ],
      {
        model: { provider: "fireworks", id: "kimi-k3-fast" },
        thinkingLevel: "high",
      },
    );
    expect(
      clamped.settings.values.find(({ id }) => id === "thinking_level"),
    ).toEqual({
      id: "thinking_level",
      desiredValue: null,
      effectiveValue: "high",
      applicationState: "pending_next_turn",
    });
    expect(
      clamped.settingDescriptors
        .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
        .every((descriptor) => {
          const desiredValue = clamped.settings.values.find(
            ({ id }) => id === descriptor.id,
          )?.desiredValue;
          return descriptor.options.some(
            (option) => option.available && option.value === desiredValue,
          );
        }),
    ).toBe(false);

    // Without a known selected model no support claim exists, so every
    // canonical level stays available.
    const ungated = await read([]);
    expect(
      ungated.settingDescriptors
        .find(({ id }) => id === "thinking_level")
        ?.options.every(({ available }) => available),
    ).toBe(true);

    const conservative = await new PiThreadPresentationProvider(
      target.pi,
      catalogPiModelPolicy,
    ).read({
      scope: target.scope,
      applicationThreadId: threadId,
      backend: {
        id: "pi-primary",
        tenantId: target.scope.tenantId,
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.86.0",
      },
      connection: target.connection,
      workspace: {} as never,
    });
    // Thinking is now independently required before model invocation. A
    // stale draft without an explicit effort remains visibly repairable but
    // cannot satisfy first-send readiness.
    expect(
      conservative.settingDescriptors
        .find(({ id }) => id === "model")
        ?.options.find(
          ({ value }) =>
            value === encodePiModelSetting("fireworks", "kimi-k3-fast"),
        ),
    ).toMatchObject({ available: true });
    expect(
      conservative.settingDescriptors
        .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
        .every((descriptor) => {
          const desiredValue = conservative.settings.values.find(
            ({ id }) => id === descriptor.id,
          )?.desiredValue;
          return descriptor.options.some(
            (option) =>
              option.available === true && option.value === desiredValue,
          );
        }),
    ).toBe(false);
  });

  it("labels a selected tuple rejected by backend policy as not allowed", async () => {
    const target = fixture();
    const threadId = "thread-policy-rejected-selection";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Policy-rejected selection",
      now: 300,
    });
    target.adapter.initializeThread(target.scope, threadId, target.connection);
    target.pi.updateSettings(target.scope, threadId, {
      expectedRevision: 0,
      modelProvider: "fireworks",
      modelId: "kimi-k3-fast",
      thinkingLevel: "high",
      toolMode: "full",
    });
    const presentation = await new PiThreadPresentationProvider(
      target.pi,
      compileBackendModelPolicy(
        {
          type: "denylist",
          denied: [{ providerIds: ["fireworks"], modelIds: ["kimi-k3-fast"] }],
        },
        "provider_model_effort",
      ),
    ).read({
      scope: target.scope,
      applicationThreadId: threadId,
      backend: {
        id: "pi-primary",
        tenantId: target.scope.tenantId,
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.86.0",
      },
      connection: target.connection,
      workspace: {} as never,
      catalog: {
        models: [
          {
            provider: "fireworks",
            id: "kimi-k3-fast",
            label: "Kimi K3 Fast",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    });

    expect(
      presentation.settingDescriptors
        .find(({ id }) => id === "model")
        ?.options.find(
          ({ value }) =>
            value === encodePiModelSetting("fireworks", "kimi-k3-fast"),
        )?.label.text,
    ).toContain("not allowed by backend policy");
    expect(
      presentation.settingDescriptors
        .find(({ id }) => id === "thinking_level")
        ?.options.find(({ value }) => value === "high")?.label.text,
    ).toContain("not allowed by backend policy");
  });

  it("builds a deterministic initialization plan from durable staged settings", () => {
    const target = fixture();
    const prepared = createPrepared(target, "settings-plan");

    expect(
      target.adapter.initializationActions(
        target.scope,
        prepared.threadId,
        prepared.attemptId,
      ),
    ).toEqual([
      {
        applicationOperationId:
          "attempt-settings-plan:initial-setting:0:tool_access",
        action: "set_tool_access",
        mode: "full",
      },
    ]);

    target.pi.updateSettings(target.scope, prepared.threadId, {
      expectedRevision: 0,
      modelProvider: "anthropic",
      modelId: "claude-sonnet",
      thinkingLevel: "high",
      toolMode: "read_only",
    });

    const expected = [
      {
        applicationOperationId: "attempt-settings-plan:initial-setting:1:model",
        action: "set_model",
        provider: "anthropic",
        modelId: "claude-sonnet",
      },
      {
        applicationOperationId:
          "attempt-settings-plan:initial-setting:1:thinking_level",
        action: "set_thinking_level",
        level: "high",
      },
      {
        applicationOperationId:
          "attempt-settings-plan:initial-setting:1:tool_access",
        action: "set_tool_access",
        mode: "read_only",
      },
    ];
    expect(
      target.adapter.initializationActions(
        target.scope,
        prepared.threadId,
        prepared.attemptId,
      ),
    ).toEqual(expected);
    expect(
      target.adapter.initializationActions(
        target.scope,
        prepared.threadId,
        prepared.attemptId,
      ),
    ).toEqual(expected);
  });

  it("persists the creation-attempt-owned detail after binding", () => {
    const target = fixture();
    const prepared = createPrepared(target, "promotion");
    target.adapter.initializeThread(
      target.scope,
      prepared.threadId,
      target.connection,
    );
    expect(
      target.adapter.getSettings(target.scope, prepared.threadId),
    ).toMatchObject({ toolMode: "full", revision: 0 });

    const nativeSessionPath = "/tmp/pi-persistence-adapter/promotion.jsonl";
    const opaqueBindingDetail = `{
      "version": 1,
      "backendConversationId": "${prepared.backendConversationId}",
      "creationOperationId": "${prepared.operationId}",
      "sessionFile": "${nativeSessionPath}"
    }`;
    target.adapter.recordSubmissionIntent(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        applicationOperationId: prepared.operationId,
        mutationId: prepared.operationId,
        reconciliationToken: prepared.operationId,
      },
    );
    target.adapter.recordSubmissionIntent(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        applicationOperationId: prepared.operationId,
        mutationId: "retry-promotion",
        reconciliationToken: "retry-promotion",
      },
    );

    target.creation.markExternalCallStarted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      330,
    );
    target.creation.recordConversationIdentified(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        backendConversationId: prepared.backendConversationId,
        opaqueBindingDetail,
        reconciliationToken: "create-promotion",
        now: 340,
      },
    );
    target.creation.markFirstSubmissionStarted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        reconciliationToken: prepared.operationId,
        retryAnchor: '{"version":1,"entryCount":0}',
        now: 350,
      },
    );
    target.creation.markAcceptedUnpersisted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        expected: "first_submission_started",
        acceptedAt: 360,
        reconciliationToken: prepared.operationId,
      },
    );
    target.database.transaction(() => {
      target.bindings.bindCreatedConversation(target.scope, prepared.threadId, {
        attemptId: prepared.attemptId,
        backendConversationId: prepared.backendConversationId,
        acceptedAt: 360,
      });
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        opaqueBindingDetail,
      );
    })();

    expect(
      target.adapter.getBindingDetail(target.scope, prepared.threadId),
    ).toBe(opaqueBindingDetail);
    expect(
      target.pi.getBindingDetails(target.scope, prepared.threadId),
    ).toMatchObject({
      backendConversationId: prepared.backendConversationId,
      nativeSessionPath,
      opaqueBindingDetail,
    });
    expect(
      target.pi.getSubmissionDetails(
        target.scope,
        prepared.threadId,
        prepared.operationId,
      ),
    ).toMatchObject({
      creationAttemptId: prepared.attemptId,
      acceptedUserEntryId: null,
    });
    expect(target.database.pragma("foreign_key_check")).toEqual([]);
  });

  it("enforces one canonical Pi path across bound ownership", () => {
    const target = fixture();
    const first = createPrepared(target, "first");
    const second = createPrepared(target, "second");
    const sharedPath = "/tmp/pi-persistence-adapter/shared.jsonl";
    const firstDetail = serializePiBindingDetail(
      first.backendConversationId,
      sharedPath,
    );
    target.creation.abortProvenUnpersisted(
      target.scope,
      first.threadId,
      first.attemptId,
      { expected: "prepared", now: 390 },
    );
    target.creation.abortProvenUnpersisted(
      target.scope,
      second.threadId,
      second.attemptId,
      { expected: "prepared", now: 390 },
    );
    target.bindings.bindDiscoveredConversation(target.scope, second.threadId, {
      backendConversationId: second.backendConversationId,
      now: 400,
    });
    target.bindings.bindDiscoveredConversation(target.scope, first.threadId, {
      backendConversationId: first.backendConversationId,
      now: 400,
    });
    target.adapter.saveBoundBindingDetail(
      target.scope,
      first.threadId,
      firstDetail,
    );
    expect(() =>
      target.adapter.saveBoundBindingDetail(
        target.scope,
        second.threadId,
        serializePiBindingDetail(second.backendConversationId, sharedPath),
      ),
    ).toThrow("already attached");
  });

  const bindPrepared = (
    target: Fixture,
    prepared: ReturnType<typeof createPrepared>,
    opaqueBindingDetail: string,
  ): void => {
    target.creation.markExternalCallStarted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      330,
    );
    target.creation.recordConversationIdentified(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        backendConversationId: prepared.backendConversationId,
        opaqueBindingDetail,
        reconciliationToken: prepared.operationId,
        now: 340,
      },
    );
    target.creation.markFirstSubmissionStarted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        reconciliationToken: prepared.operationId,
        retryAnchor: '{"version":1,"entryCount":0}',
        now: 350,
      },
    );
    target.creation.markAcceptedUnpersisted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      {
        expected: "first_submission_started",
        acceptedAt: 360,
        reconciliationToken: prepared.operationId,
      },
    );
    target.database.transaction(() => {
      target.bindings.bindCreatedConversation(target.scope, prepared.threadId, {
        attemptId: prepared.attemptId,
        backendConversationId: prepared.backendConversationId,
        acceptedAt: 360,
      });
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        opaqueBindingDetail,
      );
    })();
  };

  it("accepts a discovery refresh of the canonical detail without conflict", () => {
    const target = fixture();
    const prepared = createPrepared(target, "refresh");
    const nativeSessionPath = "/tmp/pi-persistence-adapter/refresh.jsonl";
    const canonicalDetail = serializePiBindingDetail(
      prepared.backendConversationId,
      nativeSessionPath,
    );
    bindPrepared(target, prepared, canonicalDetail);

    // Discovery recomputes the identical canonical detail for a conversation
    // that was created or branched with a title, so the immutability guard
    // accepts the refresh instead of reporting a false conflict.
    const refreshed = target.adapter.saveBoundBindingDetail(
      target.scope,
      prepared.threadId,
      canonicalDetail,
    );
    expect(refreshed).toMatchObject({
      backendConversationId: prepared.backendConversationId,
      nativeSessionPath,
      opaqueBindingDetail: canonicalDetail,
    });
    expect(() =>
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        serializePiBindingDetail(
          prepared.backendConversationId,
          "/tmp/pi-persistence-adapter/moved.jsonl",
        ),
      ),
    ).toThrow("different opaque binding details");
  });

  it("still reads stored details that carry legacy creation metadata", () => {
    const target = fixture();
    const prepared = createPrepared(target, "legacy");
    const legacyDetail = JSON.stringify({
      version: 1,
      backendConversationId: prepared.backendConversationId,
      reservedTitle: "Fireworks",
      creationOperationId: prepared.operationId,
      sessionFile: "/tmp/pi-persistence-adapter/legacy.jsonl",
    });
    bindPrepared(target, prepared, legacyDetail);

    // Rows persisted before the canonical-detail cutover stay readable until
    // the one-time repair normalizes them.
    expect(
      target.adapter.getBindingDetail(target.scope, prepared.threadId),
    ).toBe(legacyDetail);
    expect(
      extractPiNativeSessionPath(legacyDetail, prepared.backendConversationId),
    ).toBe("/tmp/pi-persistence-adapter/legacy.jsonl");
  });

  it("reconciles a legacy row to the canonical detail instead of conflicting", () => {
    const target = fixture();
    const prepared = createPrepared(target, "legacy-reconcile");
    const nativeSessionPath =
      "/tmp/pi-persistence-adapter/legacy-reconcile.jsonl";
    const legacyDetail = JSON.stringify({
      version: 1,
      backendConversationId: prepared.backendConversationId,
      reservedTitle: "Fireworks",
      creationOperationId: prepared.operationId,
      sessionFile: nativeSessionPath,
    });
    bindPrepared(target, prepared, legacyDetail);

    // Discovery recomputes the canonical detail (no legacy creation
    // metadata) for a pre-cutover row: identity matches, so the refresh
    // heals the stored row to canonical form instead of throwing the
    // false conflict that wedged startup reconciliation.
    const canonicalDetail = serializePiBindingDetail(
      prepared.backendConversationId,
      nativeSessionPath,
    );
    const refreshed = target.adapter.saveBoundBindingDetail(
      target.scope,
      prepared.threadId,
      canonicalDetail,
    );
    expect(refreshed.opaqueBindingDetail).toBe(canonicalDetail);
    expect(
      target.adapter.getBindingDetail(target.scope, prepared.threadId),
    ).toBe(canonicalDetail);

    // A genuinely different identity still fails closed.
    expect(() =>
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        serializePiBindingDetail(
          prepared.backendConversationId,
          "/tmp/pi-persistence-adapter/elsewhere.jsonl",
        ),
      ),
    ).toThrow("different opaque binding details");
  });

  it("rejects malformed, oversized, mismatched, and non-normalized details", () => {
    const target = fixture();
    const prepared = createPrepared(target, "invalid");
    expect(() => parsePiBindingDetail('{"version":1}')).toThrow(
      "binding is invalid",
    );
    expect(() =>
      parsePiBindingDetail(
        JSON.stringify({
          version: 1,
          backendConversationId: prepared.backendConversationId,
          reservedTitle: "x".repeat(4_096),
          sessionFile: "/tmp/valid.jsonl",
        }),
      ),
    ).toThrow("binding is invalid");
    expect(() =>
      extractPiNativeSessionPath(
        serializePiBindingDetail(prepared.backendConversationId),
      ),
    ).toThrow("no session path");
    target.creation.abortProvenUnpersisted(
      target.scope,
      prepared.threadId,
      prepared.attemptId,
      { expected: "prepared", now: 390 },
    );
    target.bindings.bindDiscoveredConversation(
      target.scope,
      prepared.threadId,
      {
        backendConversationId: prepared.backendConversationId,
        now: 400,
      },
    );
    expect(() =>
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        serializePiBindingDetail(
          "a-different-conversation",
          "/tmp/different.jsonl",
        ),
      ),
    ).toThrow("does not match the conversation binding");
    expect(() =>
      target.adapter.saveBoundBindingDetail(
        target.scope,
        prepared.threadId,
        JSON.stringify({
          version: 1,
          backendConversationId: prepared.backendConversationId,
          sessionFile: "/tmp/parent/../not-normalized.jsonl",
        }),
      ),
    ).toThrow("binding is invalid");
    expect(() =>
      target.pi.saveBindingDetails(target.scope, prepared.threadId, {
        backendConversationId: prepared.backendConversationId,
        opaqueBindingDetail: "x".repeat(4_097),
        nativeSessionPath: "/tmp/oversized-opaque-detail.jsonl",
      }),
    ).toThrow("CHECK constraint failed");
  });
});
