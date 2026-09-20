import { expectBackendSessionSummary } from "../support/backend-session-summary.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { CodexExecutionSettingsRepositoryAdapter } from "../../src/server/backends/codex/codex-backend-module.js";
import { CodexBackendThreadPersistenceAdapter } from "../../src/server/backends/codex/codex-backend-thread-persistence-adapter.js";
import { CodexSavedAgentBackendAdapter } from "../../src/server/backends/codex/codex-saved-agent-adapter.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "../../src/server/backends/codex/codex-binding-codec.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import type { CodexExecutionPolicySelection } from "../../src/server/backends/codex/codex-execution-policy.js";
import { codexObservedThreadExecutionSettings } from "../../src/server/backends/codex/codex-conversation-handle.js";
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
import { DomainError } from "../../src/server/domain/errors.js";
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
      label: "Primary Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
      moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/usr/bin/false", workingDirectory: "/tmp", codexHome: "/tmp/codex-fixture-home" } },
        policy: { allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"], allowedNetworkAccess: ["disabled", "enabled"], allowedApprovalPolicies: ["untrusted", "on-request", "never"], allowedApprovalReviewers: ["user", "auto_review"] },
      },
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-cutover",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Local Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } } },
    },
  ],
  defaultTargetId: "pi-local",
});

type Fixture = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly workspaceId: string;
  readonly connection: AgentConnectionProfile;
  readonly bindings: ConversationBindingRepository;
  readonly settings: CodexThreadExecutionSettingsRepository;
  readonly persistence: CodexBackendThreadPersistenceAdapter;
};

const openDatabases: Database.Database[] = [];
const readOnlyDefaults = {
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;
const executionPolicy = {
  allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} as const;
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(
  defaults: CodexExecutionPolicySelection = readOnlyDefaults,
): Fixture {
  const database = openOverlayDatabase(":memory:");
  openDatabases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/codex-persistence-adapter",
      displayName: "Codex persistence adapter",
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
  const configurationRepository = new BackendConfigurationRepository(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "codex-persistence-fixture" }, 210);

  new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 210 });
  const profile = configurationRepository
    .listProfiles(scope)
    .find(({ kind }) => kind === "codex_app_server")!;
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
  const settings = new CodexThreadExecutionSettingsRepository(database);
  return {
    database,
    scope,
    workspaceId: workspace.id,
    connection,
    bindings: new ConversationBindingRepository(database),
    settings,
    persistence: new CodexBackendThreadPersistenceAdapter({
      database,
      scope,
      backendInstanceId: connection.backendInstanceId,
      executionSettings: settings,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      resolveConnectionDefaults: (candidate) =>
        candidate.templateId === connection.templateId
          ? {
              ...defaults,
              model: { type: "catalogDefault" },
            }
          : undefined,
      now: () => 250,
    }),
  };
}

describe("Codex backend thread persistence adapter", () => {
  it("validates discovery initialization and reconstructs bound detail without provider storage", () => {
    const target = fixture();
    const threadId = "thread-imported";
    const backendConversationId = "0198f42e-bb19-7de0-91ac-44e3e77bd533";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Imported Codex thread",
      now: 300,
    });

    target.persistence.initializeThread(
      target.scope,
      threadId,
      target.connection,
    );
    expect(() =>
      target.persistence.validateInitialization(target.scope, threadId, {
        models: [],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).not.toThrow();
    target.bindings.bindDiscoveredConversation(target.scope, threadId, {
      backendConversationId,
      now: 310,
    });
    expectBackendSessionSummary(target.database, target.scope, threadId, backendConversationId);
    const expectedDetail = serializeCodexBindingDetail({
      threadId: backendConversationId,
      sessionId: null,
      nativeAncestry: null,
      correlationAncestorThreadIds: [],
    });
    expect(
      target.persistence.saveBoundBindingDetail(
        target.scope,
        threadId,
        expectedDetail,
      ),
    ).toMatchObject({
      backendConversationId,
      opaqueBindingDetail: expectedDetail,
    });
    expect(target.persistence.getBindingDetail(target.scope, threadId)).toBe(
      expectedDetail,
    );
    expect(
      new CodexBackendThreadPersistenceAdapter({
        database: target.database,
        scope: target.scope,
        backendInstanceId: target.connection.backendInstanceId,
        executionSettings: target.settings,
        executionPolicy,
        modelPolicy: catalogModelPolicy,
        resolveConnectionDefaults: () => ({
          ...readOnlyDefaults,
          model: { type: "catalogDefault" },
        }),
      }).getBindingDetail(target.scope, threadId),
    ).toBe(expectedDetail);
    expect(target.settings.find(target.scope, threadId)).toMatchObject({
      desired: null,
      effective: null,
      effectiveConfirmationState: "unconfirmed",
    });
  });

  it("enriches stable discovered native ancestry into an ordered correlation chain", () => {
    const target = fixture();
    const importBound = (
      applicationThreadId: string,
      backendConversationId: string,
      opaqueBindingDetail: string,
    ) => {
      target.bindings.createUnboundThread(target.scope, {
        id: applicationThreadId,
        workspaceId: target.workspaceId,
        connectionProfileId: target.connection.id,
        title: applicationThreadId,
        now: 300,
      });
      target.persistence.initializeThread(
        target.scope,
        applicationThreadId,
        target.connection,
      );
      target.bindings.bindDiscoveredConversation(
        target.scope,
        applicationThreadId,
        { backendConversationId, now: 310 },
      );
      return target.persistence.saveBoundBindingDetail(
        target.scope,
        applicationThreadId,
        opaqueBindingDetail,
      );
    };
    importBound(
      "native-root-app",
      "native-root",
      serializeCodexBindingDetail({
        threadId: "native-root",
        sessionId: "root-session",
        correlationAncestorThreadIds: [],
        nativeAncestry: null,
      }),
    );
    importBound(
      "native-child-app",
      "native-child",
      serializeCodexBindingDetail({
        threadId: "native-child",
        sessionId: "child-session",
        correlationAncestorThreadIds: ["native-root"],
        nativeAncestry: {
          forkedFromThreadId: "native-root",
          sourceTurnId: null,
        },
      }),
    );
    const grandchild = importBound(
      "native-grandchild-app",
      "native-grandchild",
      serializeCodexBindingDetail({
        threadId: "native-grandchild",
        sessionId: "grandchild-session",
        correlationAncestorThreadIds: ["native-child"],
        nativeAncestry: {
          forkedFromThreadId: "native-child",
          sourceTurnId: null,
        },
      }),
    );

    expect(parseCodexBindingDetail(grandchild.opaqueBindingDetail)).toEqual({
      version: 2,
      threadId: "native-grandchild",
      sessionId: "grandchild-session",
      correlationAncestorThreadIds: ["native-root", "native-child"],
      nativeAncestry: {
        forkedFromThreadId: "native-child",
        sourceTurnId: null,
      },
    });
  });

  it.each([
    readOnlyDefaults,
    {
      sandboxMode: "danger-full-access",
      networkAccess: "enabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    } as const,
  ])("seeds new drafts with $sandboxMode target defaults", (defaults) => {
    const target = fixture(defaults);
    const threadId = "thread-new-defaults";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "New Codex thread",
      now: 300,
    });
    expect(() =>
      target.persistence.validateInitialization(target.scope, threadId, {
        models: [],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).toThrow(/not initialized/i);

    target.persistence.initializeNewThread(
      target.scope,
      threadId,
      target.connection,
      {
        models: [
          {
            provider: target.connection.id,
            id: "gpt-secondary",
            label: "Secondary",
            supportedReasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
          },
          {
            provider: target.connection.id,
            id: "gpt-default",
            label: "Default",
            isDefault: true,
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    );

    expect(target.settings.find(target.scope, threadId)).toMatchObject({
      desired: {
        model: "gpt-default",
        reasoningEffort: "medium",
        ...defaults,
      },
      effective: null,
    });
    expect(() =>
      target.persistence.validateInitialization(target.scope, threadId, {
        models: [],
        commands: [],
        skills: [],
        notices: [],
      }),
    ).not.toThrow();
    expect(
      target.persistence.initializationActions(
        target.scope,
        threadId,
        "attempt-new-defaults",
      ),
    ).toEqual([
      {
        applicationOperationId: "attempt-new-defaults:initial-title",
        action: "rename",
        title: "New Codex thread",
      },
    ]);
  });

  it("initializes an exact pre-resolved SavedAgent tuple without changing connection defaults", () => {
    const target = fixture();
    const threadId = "thread-new-saved-agent";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Saved Agent Codex thread",
      now: 300,
    });
    const resolved = {
      model: "gpt-saved-agent",
      reasoningEffort: "high",
      serviceTier: "fast",
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
      approvalReviewer: "auto_review",
    } as const;

    target.persistence.initializeResolvedNewThread(
      target.scope,
      threadId,
      target.connection,
      resolved,
    );

    expect(target.settings.find(target.scope, threadId)).toMatchObject({
      desired: resolved,
      effective: null,
      effectiveConfirmationState: "unconfirmed",
      revision: 0,
    });
  });

  it("resolves and transactionally initializes the compiled Codex SavedAgent adapter", () => {
    const target = fixture();
    const adapter = new CodexSavedAgentBackendAdapter({
      executionPolicy,
      modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
      backendInstanceId: target.connection.backendInstanceId,
      resolveConnectionDefaults: () => ({
        ...readOnlyDefaults,
        model: { type: "catalogDefault" },
      }),
      persistence: target.persistence,
    });
    expect(adapter.presentation).toEqual({
      typeId: "codex",
      label: { text: "Codex" },
      brand: "codex",
    });
    const workspace = {
      summary: {
        id: target.workspaceId,
        environmentId: target.connection.executionEnvironmentId,
        displayName: "Codex SavedAgent",
        displayPath: "/tmp/codex-persistence-adapter",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
      canonicalPath: "/tmp/codex-persistence-adapter",
      authorityRevision: 0,
    } as const;
    const catalog = {
      models: [
        {
          provider: target.connection.id,
          id: "gpt-default",
          label: "Default",
          isDefault: true,
          supportedReasoningEfforts: ["medium", "high"],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          fastMode: { supported: true, defaultSelection: "standard" },
        },
      ],
      commands: [],
      skills: [],
      notices: [],
    } as const;
    const context = {
      scope: target.scope,
      workspace,
      connection: target.connection,
      catalog,
    };
    expect(() =>
      adapter.prepareResolutionContext({
        ...context,
        connection: {
          ...target.connection,
          backendInstanceId: "another-codex-backend",
        },
      }),
    ).toThrow(/unavailable/i);
    const prepared = adapter.prepareResolutionContext(context);
    const overrides = adapter.validateOverrides({
      overrides: [
        { id: "reasoning_effort", value: "high" },
        { id: "service_tier", value: "fast" },
        { id: "sandbox_mode", value: "workspace-write" },
        { id: "network_access", value: "enabled" },
        { id: "approval_policy", value: "on-request" },
        { id: "approval_reviewer", value: "auto_review" },
      ],
    });
    const descriptor = adapter.describeEditor({
      ...context,
      prepared,
      overrides,
    });
    expect(descriptor).toMatchObject({
      backendTypeId: "codex",
      canonicalOverrides: overrides.overrides,
    });
    expect(descriptor.fields[0]).toMatchObject({
      id: "model",
      label: { text: "Model" },
      currentDefaultValue: "gpt-default",
      resolvedValue: "gpt-default",
    });
    const resolved = adapter.resolve({ ...context, prepared, overrides });
    expect(resolved.normalizedValues).toEqual([
      { id: "approval_policy", value: "on-request" },
      { id: "approval_reviewer", value: "auto_review" },
      { id: "model", value: "gpt-default" },
      { id: "network_access", value: "enabled" },
      { id: "reasoning_effort", value: "high" },
      { id: "sandbox_mode", value: "workspace-write" },
      { id: "service_tier", value: "fast" },
    ]);

    const threadId = "thread-new-saved-agent-adapter";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Saved Agent adapter",
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
    expect(target.settings.find(target.scope, threadId)?.desired).toEqual({
      model: "gpt-default",
      reasoningEffort: "high",
      serviceTier: "fast",
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
      approvalReviewer: "auto_review",
    });
    const capture = adapter.captureThreadConfiguration({
      scope: target.scope,
      applicationThreadId: threadId,
      connection: target.connection,
    });
    expect(capture).toEqual({
      backendTypeId: "codex",
      schemaVersion: 1,
      settingsRevision: 0,
      overrides: [
        { id: "approval_policy", value: "on-request" },
        { id: "approval_reviewer", value: "auto_review" },
        { id: "model", value: "gpt-default" },
        { id: "network_access", value: "enabled" },
        { id: "reasoning_effort", value: "high" },
        { id: "sandbox_mode", value: "workspace-write" },
        { id: "service_tier", value: "fast" },
      ],
    });

    expect(() =>
      adapter.resolve({
        ...context,
        prepared: {
          ...prepared,
          value: { ...(prepared.value as object), extra: true },
        },
        overrides,
      }),
    ).toThrow(/unavailable/i);
    expect(() =>
      target.database.transaction(() =>
        adapter.initializeNewThread({
          transaction: ConversationCreationTransaction.fromActiveDatabase(
            target.database,
          ),
          scope: target.scope,
          applicationThreadId: threadId,
          connection: target.connection,
          resolved: {
            ...resolved,
            value: { ...(resolved.value as object), extra: true },
          },
        }),
      )(),
    ).toThrow(/unavailable/i);
    target.settings.updateDesired(target.scope, threadId, {
      expectedRevision: 0,
      desired: {
        model: "gpt-default",
        reasoningEffort: "medium",
        serviceTier: "standard",
        ...readOnlyDefaults,
      },
      now: 400,
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
    ).toThrow("source Codex settings changed");

    target.database
      .prepare(
        `
          UPDATE codex_thread_execution_settings
          SET desired_model = NULL, desired_reasoning_effort = NULL,
            desired_service_tier = NULL, desired_sandbox_mode = NULL,
            desired_network_access = NULL, desired_approval_policy = NULL,
            desired_approval_reviewer = NULL, revision = revision + 1
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
      )
      .run(target.scope.tenantId, target.scope.principalId, threadId);
    expect(() =>
      adapter.captureThreadConfiguration({
        scope: target.scope,
        applicationThreadId: threadId,
        connection: target.connection,
      }),
    ).toThrow("Choose complete Codex execution settings");
  });

  it("fails closed on missing, ambiguous, or malformed catalog defaults", () => {
    const target = fixture();
    const model = {
      provider: target.connection.id,
      id: "gpt-default",
      label: "Default",
      isDefault: true as const,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      inputModalities: ["text"] as const,
    };
    for (const [suffix, models, message] of [
      [
        "missing",
        [{ ...model, isDefault: undefined }],
        /unavailable or ambiguous/i,
      ],
      [
        "ambiguous",
        [model, { ...model, id: "gpt-other" }],
        /unavailable or ambiguous/i,
      ],
      [
        "reasoning",
        [{ ...model, defaultReasoningEffort: "medium" }],
        /reasoning defaults/i,
      ],
    ] as const) {
      const threadId = `thread-invalid-${suffix}`;
      target.bindings.createUnboundThread(target.scope, {
        id: threadId,
        workspaceId: target.workspaceId,
        connectionProfileId: target.connection.id,
        title: "Invalid Codex defaults",
        now: 320,
      });
      const initialize = () =>
        target.persistence.initializeNewThread(
          target.scope,
          threadId,
          target.connection,
          { models, commands: [], skills: [], notices: [] },
        );
      if (message.source === "reasoning defaults") {
        expect(initialize).toThrow(message);
        expect(target.settings.find(target.scope, threadId)).toBeUndefined();
      } else {
        expect(initialize).not.toThrow();
        expect(target.settings.find(target.scope, threadId)?.desired).toBeNull();
      }
    }
  });

  it("resolves fixed configured models and rejects another profile's catalog", () => {
    const target = fixture();
    const persistence = new CodexBackendThreadPersistenceAdapter({
      database: target.database,
      scope: target.scope,
      backendInstanceId: target.connection.backendInstanceId,
      executionSettings: target.settings,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      resolveConnectionDefaults: () => ({
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        model: { type: "fixed", modelId: "gpt-fixed" },
      }),
      now: () => 330,
    });
    for (const [threadId, provider, succeeds] of [
      ["thread-fixed", target.connection.id, true],
      ["thread-provider-mismatch", "another-profile", false],
    ] as const) {
      target.bindings.createUnboundThread(target.scope, {
        id: threadId,
        workspaceId: target.workspaceId,
        connectionProfileId: target.connection.id,
        title: "Fixed Codex model",
        now: 325,
      });
      const initialize = () =>
        persistence.initializeNewThread(
          target.scope,
          threadId,
          target.connection,
          {
            models: [
              {
                provider,
                id: "gpt-fixed",
                label: "Fixed",
                supportedReasoningEfforts: ["high"],
                defaultReasoningEffort: "high",
                inputModalities: ["text"],
              },
            ],
            commands: [],
            skills: [],
            notices: [],
          },
        );
      if (succeeds) {
        expect(initialize).not.toThrow();
        expect(target.settings.find(target.scope, threadId)?.desired).toEqual({
          model: "gpt-fixed",
          reasoningEffort: "high",
          serviceTier: "standard",
          sandboxMode: "workspace-write",
          networkAccess: "disabled",
          approvalPolicy: "on-request",
          approvalReviewer: "user",
        });
      } else {
        expect(initialize).toThrow(/reasoning defaults/i);
      }
    }
  });

  it("initializes a new thread from the model's normalized Fast default", () => {
    const target = fixture();
    const threadId = "thread-fast-default";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Fast default",
      now: 340,
    });

    target.persistence.initializeNewThread(
      target.scope,
      threadId,
      target.connection,
      {
        models: [
          {
            provider: target.connection.id,
            id: "gpt-default",
            label: "Default",
            isDefault: true,
            supportedReasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            fastMode: {
              supported: true,
              defaultSelection: "fast",
            },
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
    );

    expect(
      target.settings.find(target.scope, threadId)?.desired?.serviceTier,
    ).toBe("fast");
  });

  it("freezes the complete confirmed source effective tuple into a fork child", () => {
    const target = fixture();
    const sourceThreadId = "thread-fork-source";
    const childThreadId = "thread-fork-child";
    for (const [id, title] of [
      [sourceThreadId, "Fork source"],
      [childThreadId, "Fork child"],
    ] as const) {
      target.bindings.createUnboundThread(target.scope, {
        id,
        workspaceId: target.workspaceId,
        connectionProfileId: target.connection.id,
        title,
        now: 340,
      });
    }
    target.bindings.bindDiscoveredConversation(target.scope, sourceThreadId, {
      backendConversationId: "native-fork-source",
      now: 341,
    });
    target.settings.initialize(target.scope, {
      applicationThreadId: sourceThreadId,
      desired: {
        model: "desired-model",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...readOnlyDefaults,
      },
      now: 342,
    });
    const initializeFork = () =>
      target.persistence.initializeForkThread(
        target.scope,
        sourceThreadId,
        childThreadId,
        target.connection,
        {
          model: { provider: target.connection.id, id: "effective-model" },
          thinkingLevel: "high",
        },
      );
    expect(initializeFork).toThrow(/not authoritatively confirmed/i);

    const settingsAdapter = new CodexExecutionSettingsRepositoryAdapter(
      target.settings,
      executionPolicy,
      catalogModelPolicy,
    );
    settingsAdapter.observeEffective(target.scope, {
      applicationThreadId: sourceThreadId,
      settings: codexObservedThreadExecutionSettings(
        "effective-model",
        "high",
        null,
        "on-request",
        "auto_review",
        {
          type: "workspaceWrite",
          writableRoots: ["/additional-root"],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      ),
      confirmationGeneration: 7,
      now: 343,
    });
    expect(
      settingsAdapter.forkSettingsEligibility(target.scope, sourceThreadId),
    ).toMatchObject({ availability: "unavailable", reason: "external_custom" });
    expect(initializeFork).toThrow(/not authoritatively confirmed/i);

    settingsAdapter.observeEffective(target.scope, {
      applicationThreadId: sourceThreadId,
      settings: codexObservedThreadExecutionSettings(
        "effective-model",
        "high",
        "default",
        "on-request",
        "auto_review",
        {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      ),
      confirmationGeneration: 7,
      now: 344,
    });
    expect(
      settingsAdapter.forkSettingsEligibility(target.scope, sourceThreadId),
    ).toMatchObject({ availability: "available" });

    initializeFork();

    expect(target.settings.find(target.scope, childThreadId)?.desired).toEqual({
      model: "effective-model",
      reasoningEffort: "high",
      serviceTier: "standard",
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
      approvalReviewer: "auto_review",
    });
    expect(
      target.persistence.readForkSettings(target.scope, childThreadId),
    ).toEqual({
      model: { provider: target.connection.id, id: "effective-model" },
      thinkingLevel: "high",
    });
    expect(
      target.settings.find(target.scope, sourceThreadId)
        ?.effectiveConfirmationState,
    ).toBe("confirmed");

    expect(() =>
      target.persistence.initializeForkThread(
        target.scope,
        sourceThreadId,
        "missing-child",
        target.connection,
        {
          model: { provider: target.connection.id, id: "effective-model" },
          thinkingLevel: "high",
        },
      ),
    ).toThrow(/thread was not found/i);
  });

  it("rejects mismatched native, target, principal, and creation paths", () => {
    const target = fixture();
    const threadId = "thread-mismatch";
    const backendConversationId = "0198f42e-bb19-7de0-91ac-44e3e77bd533";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Mismatched Codex thread",
      now: 300,
    });
    expect(() =>
      target.persistence.initializeThread(target.scope, threadId, {
        ...target.connection,
        id: "wrong-profile",
      }),
    ).toThrow("Codex connection does not match");
    target.bindings.bindDiscoveredConversation(target.scope, threadId, {
      backendConversationId,
      now: 310,
    });
    expect(() =>
      target.persistence.saveBoundBindingDetail(
        target.scope,
        threadId,
        serializeCodexBindingDetail({
          threadId: "0198f42e-bb19-7de0-91ac-44e3e77bd534",
          sessionId: null,
          nativeAncestry: null,
          correlationAncestorThreadIds: [],
        }),
      ),
    ).toThrow("does not match the native thread");
    expect(() =>
      target.persistence.saveBoundBindingDetail(
        target.scope,
        threadId,
        '{"version":1,"threadId":"bad","unexpected":true}',
      ),
    ).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        code: "conflict",
        message: "The Codex binding detail is invalid.",
      }),
    );
    expect(() =>
      target.persistence.getBindingDetail(
        { ...target.scope, principalId: "another-principal" },
        threadId,
      ),
    ).toThrow("Codex thread was not found");
    expect(() =>
      target.persistence.initializeNewThread(
        target.scope,
        threadId,
        {
          ...target.connection,
          backendInstanceId: "another-backend",
        },
        { models: [], commands: [], skills: [], notices: [] },
      ),
    ).toThrow("The Codex connection does not match the thread target.");
    expect(() =>
      target.persistence.recordSubmissionIntent(
        target.scope,
        threadId,
        "attempt-one",
        {
          applicationOperationId: "",
          mutationId: "mutation-one",
          reconciliationToken: "token-one",
        },
      ),
    ).toThrow("Codex submission identities must not be empty.");
  });

  it("uses the common first-submission phase as durable Codex intent", () => {
    const target = fixture();
    const threadId = "thread-submission-intent";
    target.bindings.createUnboundThread(target.scope, {
      id: threadId,
      workspaceId: target.workspaceId,
      connectionProfileId: target.connection.id,
      title: "Codex submission intent",
      initialText: "first prompt",
      now: 300,
    });
    const creation = new ConversationCreationRepository(target.database);
    creation.prepare(target.scope, threadId, {
      attemptId: "attempt-intent",
      mutationId: "operation-intent",
      expectedThreadRevision: 0,
      creationKind: "first_input",
      sourceKind: "composer",
      initialInputText: "first prompt",
      initialContextExcerpts: [],
      initialTaskReferences: [],
      initialAttachmentIds: [],
      expectedDraftRevision: 0,
      backendCreationCorrelation: "create-correlation-intent",
      now: 310,
    });
    creation.markExternalCallStarted(
      target.scope,
      threadId,
      "attempt-intent",
      320,
    );
    creation.recordConversationIdentified(
      target.scope,
      threadId,
      "attempt-intent",
      {
        backendConversationId: "provider-thread-intent",
        opaqueBindingDetail: JSON.stringify({
          version: 1,
          threadId: "provider-thread-intent",
        }),
        reconciliationToken: "provider-create-token",
        now: 330,
      },
    );

    expect(
      target.persistence.hasSubmissionIntent(
        target.scope,
        threadId,
        "attempt-intent",
        "operation-intent",
      ),
    ).toBe(false);

    target.database.transaction(() => {
      target.persistence.recordSubmissionIntent(
        target.scope,
        threadId,
        "attempt-intent",
        {
          applicationOperationId: "operation-intent",
          mutationId: "operation-intent",
          reconciliationToken: "operation-intent",
        },
      );
      creation.markFirstSubmissionStarted(
        target.scope,
        threadId,
        "attempt-intent",
        {
          reconciliationToken: "operation-intent",
          retryAnchor: '{"version":1,"position":"idle"}',
          now: 340,
        },
      );
    })();

    expect(
      target.persistence.hasSubmissionIntent(
        target.scope,
        threadId,
        "attempt-intent",
        "operation-intent",
      ),
    ).toBe(true);
    creation.markRecoveryRequired(target.scope, threadId, "attempt-intent", {
      expected: "first_submission_started",
      diagnostic: "turn/start outcome unknown",
      now: 350,
    });
    expect(
      target.persistence.hasSubmissionIntent(
        target.scope,
        threadId,
        "attempt-intent",
        "operation-intent",
      ),
    ).toBe(true);
  });
});
