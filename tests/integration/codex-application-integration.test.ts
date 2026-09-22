import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../../src/server/backends/contracts.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import {
  CodexBackendModule,
  type CodexBackendModuleDependencies,
} from "../../src/server/backends/codex/codex-backend-module.js";
import {
  codexThreadReadMethod,
  type CodexThread,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  CodexSharedClientFacade,
  type CodexReadyClientGeneration,
} from "../../src/server/backends/codex/codex-client-facade.js";
import { CODEX_APP_SERVER_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import { encodeCodexModelSetting } from "../../src/server/backends/codex/codex-setting-values.js";
import type { ResolvedCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import type {
  FramedMessageTransport,
  FramedTransportFactory,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import type {
  CodexRpcMethod,
  CodexRpcRequestOptions,
  CodexRpcRequestReceipt,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { InMemoryConformanceDriver } from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import { ApplicationSnapshotService } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { DatabaseExecutionTargetReader } from "../../src/server/application/execution-target-reader.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { ConversationActorManager } from "../../src/server/conversations/conversation-actor-manager.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
} from "../../src/server/conversations/backend-discovery-service.js";
import {
  DatabaseActorTargetResolver,
  DatabaseConversationTargetStore,
  DatabaseLifecycleTargetResolver,
  DatabaseThreadApplicationQueueReader,
  DatabaseThreadApplicationRecoveryReader,
} from "../../src/server/conversations/database-conversation-adapters.js";
import {
  DatabaseThreadApplicationInventoryReader,
  DatabaseThreadApplicationPresentationReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
} from "../../src/server/conversations/thread-application-service.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "../../src/server/events/thread-event-presentation.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  acquireBackendNativeStores,
  initializeBackendModuleRuntimes,
} from "../../src/server/runtime/backend-module-startup.js";
import { LateBoundBackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { StartupResourceStack } from "../../src/server/runtime/startup-resource-stack.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const filename of temporaryPaths.splice(0).reverse()) {
    await rm(filename, { recursive: true, force: true });
  }
});

async function temporaryDirectory(label: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), `${label}-`));
  temporaryPaths.push(created);
  return await realpath(created);
}

function backendInstance(
  record: ReturnType<BackendConfigurationRepository["getBackend"]>,
): AgentBackendInstance {
  return {
    id: record.id,
    tenantId: record.tenantId,
    kind: record.kind,
    label: record.label,
    enabled: record.enabled === 1,
    configurationRevision: record.configurationRevision,
    protocolRelease: record.protocolRelease,
  };
}

function connectionProfile(
  record: ReturnType<BackendConfigurationRepository["getProfile"]>,
): AgentConnectionProfile {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ownerPrincipalId: record.ownerPrincipalId,
    templateId: record.templateId,
    kind: record.kind,
    backendInstanceId: record.backendInstanceId,
    executionEnvironmentId: record.executionEnvironmentId,
    label: record.label,
    enabled: record.enabled === 1,
    configurationRevision: record.configurationRevision,
  };
}

function nativeThread(canonicalWorkspacePath: string): CodexThread {
  return codexThreadReadMethod.decodeResult({
    thread: {
      id: "codex-native-thread",
      extra: {},
      sessionId: "codex-session",
      forkedFromId: null,
      parentThreadId: null,
      preview: "Imported Codex thread",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "legacy",
      modelProvider: "openai",
      model: null,
      reasoningEffort: null,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      recencyAt: 1_700_000_100,
      status: { type: "idle" },
      path: "/private/provider-rollout.jsonl",
      cwd: canonicalWorkspacePath,
      cliVersion: CODEX_APP_SERVER_RELEASE,
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "Imported Codex thread",
      turns: [
        {
          id: "codex-turn",
          items: [
            {
              type: "userMessage",
              id: "codex-user-item",
              clientId: null,
              content: [
                {
                  type: "text",
                  text: "Existing Codex history",
                  text_elements: [],
                },
              ],
            },
            {
              type: "agentMessage",
              id: "codex-agent-item",
              text: "Read-only response",
              phase: "final_answer",
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_001,
          durationMs: 1_000,
        },
      ],
    },
  }).thread;
}

function fakeCodexDependencies(
  readThread: () => CodexThread,
  events: string[],
  requests: Array<{ readonly method: string; readonly params: unknown }>,
  expectedCodexHome: string,
): CodexBackendModuleDependencies {
  let inboundSequence = 0;
  let facade: CodexSharedClientFacade;
  const execute = <Result>(method: string, params: unknown): Result => {
    const thread = readThread();
    events.push(`rpc:${method}`);
    requests.push({ method, params });
    if (method === "thread/list") {
      return {
        data: [thread],
        nextCursor: null,
        backwardsCursor: null,
      } as Result;
    }
    if (method === "thread/read") {
      const includeTurns = (params as { readonly includeTurns?: unknown })
        .includeTurns;
      return {
        thread: includeTurns === false ? { ...thread, turns: [] } : thread,
      } as Result;
    }
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt-5.6-codex",
            model: "gpt-5.6-codex",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.6 Codex",
            description: "Integration fixture model",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low reasoning" },
            ],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [
              {
                id: "priority",
                name: "Fast",
                description: "About 1.5x faster with higher usage.",
              },
            ],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      } as Result;
    }
    if (method === "skills/list") {
      return {
        data: [{ cwd: thread.cwd, skills: [], errors: [] }],
      } as Result;
    }
    if (method === "experimentalFeature/list") {
      return {
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: "Fast mode",
            description: null,
            announcement: null,
            enabled: true,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      } as Result;
    }
    if (method === "thread/resume") {
      return {
        thread,
        model: "gpt-5.6-codex",
        modelProvider: "openai",
        serviceTier: "default",
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: {
          id: ":read-only",
          extends: null,
        },
        reasoningEffort: "low",
        multiAgentMode: "explicitRequestOnly",
      } as Result;
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" } as Result;
    }
    throw new Error(`unexpected_codex_rpc:${method}`);
  };
  const readyClient: CodexReadyClientGeneration = {
    generation: 1,
    async request<Params, Result>(
      specification: CodexRpcMethod<Params, Result>,
      params: Params,
      _options: CodexRpcRequestOptions,
    ): Promise<Result> {
      return execute<Result>(specification.method, params);
    },
    async requestWithReceipt<Params, Result>(
      specification: CodexRpcMethod<Params, Result>,
      params: Params,
      _options: CodexRpcRequestOptions,
    ): Promise<CodexRpcRequestReceipt<Result>> {
      return {
        result: execute<Result>(specification.method, params),
        generation: 1,
        inboundSequence: ++inboundSequence,
      };
    },
  };
  facade = new CodexSharedClientFacade({
    current: () => readyClient,
    latestGeneration: () => 1,
    retireGeneration: async () => undefined,
  });
  const transport: FramedTransportFactory = {
    open: async () =>
      Promise.reject<FramedMessageTransport>(
        new Error("fake transport must not open"),
      ),
  };
  return {
    resolveRuntimeConfiguration: async (
      input,
    ): Promise<ResolvedCodexRuntimeConfiguration> => {
      if (input.connection.ownership !== "owned") {
        throw new Error("fake_runtime_requires_owned_connection");
      }
      const codexHome = input.connection.channel.codexHome;
      if (!codexHome) {
        throw new Error("fake_runtime_requires_codex_home_override");
      }
      return {
        scope: input.scope,
        instance: input.instance,
        executionEnvironmentId: "local",
        codexHome,
        nativeStoreHome: codexHome,
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            process: {
              kind: "owned_process",
              scope: {
                ...input.scope,
                backendInstanceId: input.instance.id,
                executionEnvironmentId: "local",
              },
              executable: {
                kind: "executable",
                canonicalPath: "/usr/bin/false",
              },
              workingDirectory: {
                kind: "directory",
                canonicalPath: input.connection.channel.workingDirectory,
              },
            },
            executable: {
              path: "/usr/bin/false",
              version: "0.153.0",
              newerThanTested: false,
            },
            workingDirectory: input.connection.channel.workingDirectory,
          },
        },
        childEnvironment: {
          HOME: input.environment.HOME ?? os.homedir(),
          CODEX_HOME: codexHome,
          PATH: "",
        },
      };
    },
    createTransportFactory: (input) => {
      if (input.configuration.connection.ownership !== "owned") {
        throw new Error("fake_transport_requires_owned_connection");
      }
      expect(input.configuration.nativeStoreHome).toBe(expectedCodexHome);
      return transport;
    },
    createSupervisor: (input) => {
      expect(input.expectedCodexHome).toBe(expectedCodexHome);
      return {
        client: facade,
        async start() {
          events.push("supervisor:start");
          input.nativeStoreOwnership!.armLaunch();
          input.serverRequestRouter.activateGeneration(1);
          facade.updateLifecycle({ state: "ready", generation: 1 });
        },
        async close() {
          events.push("supervisor:close");
          input.serverRequestRouter.invalidateGeneration(
            1,
            "fake_supervisor_closed",
          );
          facade.updateLifecycle({ state: "closed", generation: 1 });
          input.nativeStoreOwnership!.proveClosed();
        },
      };
    },
  };
}

describe("Codex production application integration", () => {
  it("imports beside Pi, opens interactively, publishes rediscovery for first-send admission and reconnect, and closes in ownership order", async () => {
    const codexHome = await temporaryDirectory("sedes-codex-home");
    const workspacePath = await temporaryDirectory("sedes-workspace");
    const database = openOverlayDatabase(":memory:");
    const scope = new SingleUserIdentityProvider(database).getScope();
    const legacyInventory = new ThreadInventoryService(
      new OverlayRepository(database),
    );
    const environmentRecord = legacyInventory.getLocalEnvironment(scope);
    const workspaceRecord = legacyInventory.rememberWorkspace(
      scope,
      {
        environmentId: environmentRecord.id,
        canonicalPath: workspacePath,
        displayName: "Shared workspace",
        availability: "available",
        trustState: "trusted",
      },
      100,
    );
    const piDraft = legacyInventory.createThread(
      scope,
      {
        workspaceId: workspaceRecord.id,
        title: "Existing Pi draft",
      },
      200,
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
        {
          id: "codex-primary",
          kind: "codex_app_server",
          label: "Codex",
          enabled: true,
          modelPolicy: { type: "catalog" },
          moduleConfiguration: {
            connection: {
              ownership: "owned",
              channel: {
                type: "process_stdio",
                executablePath: "/usr/bin/false",
                workingDirectory: workspacePath,
                codexHome,
              },
            },
            policy: {
              allowedSandboxModes: ["read-only", "workspace-write"],
              allowedNetworkAccess: ["disabled", "enabled"],
              allowedApprovalPolicies: ["on-request", "never"],
              allowedApprovalReviewers: ["user", "auto_review"],
            },
          },
        },
      ],
      targets: [
        {
          id: "pi-local",
          kind: "pi_sdk",
          label: "Local Pi",
          backendInstanceId: "pi-primary",
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
          moduleConfiguration: {
            defaults: {
              sandboxMode: "read-only",
              networkAccess: "disabled",
              approvalPolicy: "never",
              approvalReviewer: "user",
              model: {
                type: "fixed",
                modelId: "gpt-5.6-codex",
              },
            },
          },
        },
      ],
      defaultTargetId: "pi-local",
    });
    applyBackendNormalizationMigration(database, {
      configuration,
      quiescentCutoverConfirmed: true,
      appliedAt: 300,
    });
    applyDatabaseMigrations(database, backendNormalizedMigrations);

    const backendConfiguration = new BackendConfigurationRepository(database);
    importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: [workspacePath], sourceLabel: "codex-persistence-fixture" }, 400);

    new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 400 });
    const localAuthority = new InventoryRepository(database);
    const reconciledEnvironment = localAuthority.getLocalEnvironment(scope);
    localAuthority.upsertWorkspace(scope, {
      id: workspaceRecord.id,
      environmentId: workspaceRecord.environmentId,
      canonicalPath: workspaceRecord.canonicalPath,
      displayName: workspaceRecord.displayName,
      available: true,
      trustState: "trusted",
      environmentConfigurationRevision:
        reconciledEnvironment.configurationRevision,
      now: 401,
    });
    const codexBackend = backendInstance(
      backendConfiguration.getBackend(scope, "codex-primary"),
    );
    const codexConnection = connectionProfile(
      backendConfiguration.getProfileByTemplate(scope, "codex-local"),
    );
    const piBackend = backendInstance(
      backendConfiguration.getBackend(scope, "pi-primary"),
    );
    const piConnection = connectionProfile(
      backendConfiguration.getProfileByTemplate(scope, "pi-local"),
    );
    const configuredCodexBackend = configuration.backends.find(
      ({ id }) => id === codexBackend.id,
    )!;
    const configuredCodexTargets = configuration.targets.filter(
      ({ backendInstanceId }) => backendInstanceId === codexBackend.id,
    );
    const events: string[] = [];
    const requests: Array<{
      readonly method: string;
      readonly params: unknown;
    }> = [];
    let providerThread = nativeThread(workspacePath);
    const prepared = new CodexBackendModule(
      fakeCodexDependencies(
        () => providerThread,
        events,
        requests,
        codexHome,
      ),
    ).prepare({
      backend: configuredCodexBackend,
      connections: configuredCodexTargets,
      executionEnvironments: [{ id: environmentRecord.id, kind: "local" }],
      environment: {},
    });
    const resources = new StartupResourceStack();
    let actors: ConversationActorManager | undefined;
    const execution = new LocalExecutionEnvironment({
      environmentId: environmentRecord.id,
      scope,
      allowedRoots: [workspacePath],
      workspaceTrusted: () => true,
      configurationRevision: reconciledEnvironment.configurationRevision,
      activeConfigurationRevision: () =>
        reconciledEnvironment.configurationRevision,
    });
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: environmentRecord.id,
    });
    try {
      await acquireBackendNativeStores(prepared.nativeStores, resources);
      const registry = new AgentBackendRegistry();
      const runtimeModules = await initializeBackendModuleRuntimes({
        preparedModules: [prepared],
        database,
        scope,
        instances: [codexBackend],
        connections: [codexConnection],
        environmentChannels: new Map([
          [environmentRecord.id, environmentChannel],
        ]),
        environmentOperations: new Map([
          [
            environmentRecord.id,
            unavailableEnvironmentOperations({
              environmentId: environmentRecord.id,
              environmentKind: "local",
              environmentLabel: environmentRecord.label,
            }),
          ],
        ]),
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: new Map([
          [
            environmentRecord.id,
            {
              availability: "available" as const,
              endpoint: "http://127.0.0.1:4784",
              executableDirectory: "/tmp/sedes-cli",
              inheritedPath: "/usr/bin",
            },
          ],
        ]),
        registry,
        resources,
      });
      const piDriver = new InMemoryConformanceDriver({
        instance: piBackend,
        connection: piConnection,
      });
      registry.register({
        scope,
        instance: piBackend,
        connectionKinds: ["pi_sdk"],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create: () => piDriver,
      });

      const inventory = new InventoryRepository(database);
      const bindings = new ConversationBindingRepository(database);
      const targets = new DatabaseConversationTargetStore({
        database,
        bindings,
        bindingDetails: runtimeModules.bindingDetails,
        registry,
        environments: execution,
      });
      targets.bindWorkspacePublications({
        handoffAuthoritativeReplacement: () => undefined,
      });
      const importTime = 1_800_000_000_000;
      let threadSnapshots: ThreadSnapshotPublisher | undefined;
      const discovery = new BackendDiscoveryService({
        targets,
        inventory,
        bindings,
        lineage: new ThreadLineageRepository(database),
        forks: { reconcileDiscoveredFork: async () => undefined },
        persistence: runtimeModules.discoveryPersistence,
        connectionProfileId: codexConnection.id,
        onAncestryReconciliationConflict: () => undefined,
        onForkReconciliationError: () => undefined,
        onThreadChanged: (eventScope, applicationThreadId) =>
          threadSnapshots?.publish(eventScope, applicationThreadId),
        now: () => importTime,
      });
      await discovery.discoverWorkspace(
        scope,
        workspaceRecord.id,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      const imported = bindings.findByBackendConversation(
        scope,
        codexBackend.id,
        "codex-native-thread",
      );
      expect(imported).toBeDefined();
      expect(imported!.createdAt).toBe(importTime);
      expect(
        inventory.getThread(scope, imported!.applicationThreadId).thread,
      ).toMatchObject({
        reconciliationAt: importTime,
        lastActivityAt: 1_700_000_100_000,
        createdAt: importTime,
      });

      const queue = new QueuedInputRepository(database);
      const completion = new SubmissionCompletionRepository(database);
      const executionTargets = new DatabaseExecutionTargetReader({
        configuration: backendConfiguration,
        registry,
        defaultTargetTemplateId: configuration.defaultTargetId,
      });
      const applicationSnapshot = await new ApplicationSnapshotService(
        inventory,
        new DatabaseApplicationThreadSummaryReader({
          inventory,
          queue,
          completion,
        }),
        {
          captureLoadedState: async () => undefined,
        },
        executionTargets,
        {
          list: () => ({
            forkOrigins: [],
            lineagePlacements: [],
            lineageFamilies: [],
          }),
        },
        {
          listAssociated: () => [],
          listAssociatedByThread: () => [],
          findAssociated: () => undefined,
        },
        { list: () => [] },
        () => "unavailable",
        { summariesByThread: () => new Map() },
      ).capture(scope);
      expect(
        applicationSnapshot.threads.map(({ id, title, targetId, backend }) => ({
          id,
          title: title.text,
          targetId,
          backend: { label: backend.label.text, brand: backend.brand },
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            id: piDraft.thread.id,
            title: "Existing Pi draft",
            targetId: piConnection.id,
            backend: { label: "Primary Pi", brand: "pi" },
          },
          {
            id: imported!.applicationThreadId,
            title: "Imported Codex thread",
            targetId: codexConnection.id,
            backend: { label: "Codex", brand: "codex" },
          },
        ]),
      );
      expect(applicationSnapshot.executionTargets).toEqual([
        expect.objectContaining({
          id: codexConnection.id,
          label: { text: "Local Codex" },
          backend: { label: { text: "Codex" }, brand: "codex" },
          available: true,
        }),
        expect.objectContaining({
          id: piConnection.id,
          label: { text: "Local Pi" },
          backend: { label: { text: "Primary Pi" }, brand: "pi" },
          available: true,
        }),
      ]);
      expect(applicationSnapshot.defaultNewThreadTargetId).toBe(
        piConnection.id,
      );

      actors = new ConversationActorManager({
        environments: execution,
        attachmentDelivery: {} as never,
        retentionMilliseconds: 60_000,
        runtimeBudget: 8,
      });
      resources.defer("conversation actors", () => actors!.close());
      const threads = new ThreadApplicationService({
    usage: { registerVisibleTurns: () => undefined },
        inventory: new DatabaseThreadApplicationInventoryReader({
          inventory,
          queue,
          completion,
          ...threadAgentToolPolicyReaderDependencies(database),
          directoryBrowsingAvailability: () => "unavailable",
          executionWorkspaces: directThreadExecutionWorkspaceReader,
        }),
        conversations: new ActorBackedThreadApplicationConversationReader({
          actors,
          targets: new DatabaseActorTargetResolver(targets),
        }),
        queue: new DatabaseThreadApplicationQueueReader(queue),
        presentation: new DatabaseThreadApplicationPresentationReader({
          targets,
          providers: runtimeModules.presentation,
        }),
        recovery: new DatabaseThreadApplicationRecoveryReader({
          creation: new ConversationCreationRepository(database),
          operations: new ConversationOperationRepository(database),
          targets: new DatabaseLifecycleTargetResolver(targets),
          registry,
          forks: {
            readRecovery: async () => ({ recoverable: false }),
          },
        }),
        interactions: {
          listPending: () => [],
        },
        actionPersistence: runtimeModules.actionPersistence,
        attachmentDelivery: { supports: () => false },
      });
      const threadSnapshot = await threads.snapshot(
        scope,
        imported!.applicationThreadId,
      );
      expect(threadSnapshot).toMatchObject({
        backendSessionId: imported!.backendConversationId,
        thread: {
          id: imported!.applicationThreadId,
          title: { text: "Imported Codex thread" },
          backingState: "bound",
          runState: "idle",
        },
        orderedTurnIds: [expect.any(String)],
        composerCommands: [],
        runState: "idle",
        capabilities: {
          backend: {
            label: { text: "Codex" },
          },
          interactionMode: "interactive",
          deliveryModes: [
            expect.objectContaining({ id: "submit", available: true }),
            expect.objectContaining({ id: "steer", available: false }),
            expect.objectContaining({ id: "queue", available: false }),
          ],
          settings: [
            expect.objectContaining({ id: "model", available: true }),
            expect.objectContaining({
              id: "thinking_level",
              available: true,
            }),
          ],
        },
        settings: {
          revision: expect.any(Number),
          values: [
            expect.objectContaining({
              id: "model",
              desiredValue: encodeCodexModelSetting(
                "gpt-5.6-codex",
                "low",
                true,
                "standard",
              ),
              effectiveValue: encodeCodexModelSetting(
                "gpt-5.6-codex",
                "low",
                true,
                "standard",
              ),
              applicationState: "effective",
            }),
            expect.objectContaining({
              id: "thinking_level",
              desiredValue: "low",
              effectiveValue: "low",
              applicationState: "effective",
            }),
          ],
        },
        providerFeatures: expect.arrayContaining([
          expect.objectContaining({
            ref: { featureId: "codex.execution", schemaVersion: 1 },
          }),
          expect.objectContaining({
            ref: { featureId: "codex.goal", schemaVersion: 1 },
          }),
          expect.objectContaining({
            ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
          }),
        ]),
      });
      const providerActionIds = [
        "rename",
        "compact",
        "interrupt",
        "clone",
        "attach_automation",
        "remove_automation",
        "run_automation",
      ];
      expect(
        threadSnapshot.capabilities.operations
          .map(({ id }) => id)
          .filter((id) => providerActionIds.includes(id)),
      ).toEqual(["rename", "compact", "interrupt", "attach_automation"]);
      expect(
        threadSnapshot.capabilities.operations.map(({ id }) => id),
      ).not.toContain("clone");
      expect(threadSnapshot.capabilities.settings.map(({ id }) => id)).toEqual([
        "model",
        "thinking_level",
      ]);
      expect(
        threadSnapshot.capabilities.providerFeatures.map(
          ({ ref }) => `${ref.featureId}@${ref.schemaVersion}`,
        ),
      ).toEqual([
        "codex.execution@1",
        "codex.goal@1",
        "codex.fast_mode@1",
        "codex.tui@1",
      ]);
      expect(threadSnapshot.composerCommands).toEqual([]);
      expect(events.slice(0, 7)).toEqual([
        "supervisor:start",
        "rpc:thread/list",
        "rpc:thread/read",
        "rpc:thread/resume",
        "rpc:experimentalFeature/list",
        "rpc:model/list",
        "rpc:thread/goal/get",
      ]);
      expect(requests.filter(({ method }) => method === "thread/read")).toEqual(
        [
          {
            method: "thread/read",
            params: {
              threadId: "codex-native-thread",
              includeTurns: false,
            },
          },
        ],
      );
      expect(
        requests.filter(({ method }) => method === "thread/resume"),
      ).toEqual([
        {
          method: "thread/resume",
          params: {
            config: {
              shell_environment_policy: {
                exclude: [
                  "SEDES_AGENT_TOOL_ENDPOINT",
                  "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
                  "SEDES_AGENT_TOOL_CLIENT_TOKEN",
                  "SEDES_AGENT_TOOL_CLI_MODE",
                ],
              },
            },
            threadId: "codex-native-thread",
          },
        },
      ]);

      const interactions = new InteractionBroker();
      resources.defer("interaction broker", () => interactions.close());
      const runtimes = new ThreadRuntimeCoordinator({
        actors,
        targets: new DatabaseActorTargetResolver(targets),
        bridge: new ConversationEventBridge(
          new ThreadEventPresentation(threads), () => undefined
        ),
        interactions,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 60_000,
      });
      resources.defer("thread runtimes", () => runtimes.close());
      threadSnapshots = new ThreadSnapshotPublisher(
        bindings,
        threads,
        runtimes,
      );
      resources.defer("thread snapshots", () => threadSnapshots!.close());

      const threadId = imported!.applicationThreadId;
      const runtime = await runtimes.acquire(scope, threadId);
      const onThreadEvent = vi.fn();
      const attached = runtime.hub.subscribeFromCurrentSnapshot(onThreadEvent);
      const firstRevision = attached.checkpoint!.snapshot.thread.threadRevision;
      expect(firstRevision).toBe(
        inventory.getThread(scope, threadId).thread.revision,
      );

      // Startup discovery may finish after the selected thread has attached.
      // Identical metadata must not invalidate that client's first Send.
      await discovery.discoverWorkspace(
        scope,
        workspaceRecord.id,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      expect(inventory.getThread(scope, threadId).thread.revision).toBe(
        firstRevision,
      );
      expect(runtime.hub.snapshot!.thread.threadRevision).toBe(firstRevision);

      providerThread = {
        ...providerThread,
        name: "Codex title changed while Sedes was stopped",
        updatedAt: providerThread.updatedAt + 100,
        recencyAt: providerThread.updatedAt + 100,
      };
      await discovery.discoverWorkspace(
        scope,
        workspaceRecord.id,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      const discovered = inventory.getThread(scope, threadId).thread;
      expect(discovered.revision).toBeGreaterThan(firstRevision);
      expect(onThreadEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "application_state_changed",
            state: expect.objectContaining({
              thread: expect.objectContaining({
                title: { text: providerThread.name },
                threadRevision: discovered.revision,
                lastActivityAt: new Date(
                  providerThread.updatedAt * 1_000,
                ).toISOString(),
              }),
            }),
          }),
        }),
      );

      attached.close();
      runtime.release();
      const reconnected = await runtimes.acquire(scope, threadId);
      expect(reconnected.hub).toBe(runtime.hub);
      const freshClient = reconnected.hub.subscribeFromCurrentSnapshot(
        () => undefined,
      );
      const freshSnapshot = freshClient.checkpoint!.snapshot;
      expect(freshSnapshot.thread).toMatchObject({
        title: { text: providerThread.name },
        threadRevision: discovered.revision,
      });

      const draft = inventory.saveDraft(scope, threadId, {
        text: "First message after restarting Sedes",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: freshSnapshot.draft.revision,
        now: importTime + 1,
      });
      const admission = queue.enqueue(scope, threadId, {
        mutationId: "restart-first-send",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "submit",
          resolvedDeliveryMode: "submit",
          expectedThreadRevision: freshSnapshot.thread.threadRevision,
          expectedDraftRevision: draft.revision,
        },
        now: importTime + 2,
      });
      expect(admission).toMatchObject({
        replayed: false,
        item: { text: draft.text, requestedThreadRevision: discovered.revision },
      });
      freshClient.close();
      reconnected.release();

      await resources.dispose();
      expect(events.at(-2)).toBe("rpc:thread/unsubscribe");
      expect(events.at(-1)).toBe("supervisor:close");
    } finally {
      await resources.dispose().catch(() => undefined);
      execution.close();
      database.close();
    }
  });
});
