import type Database from "better-sqlite3";
import { DeliveryInputSnapshotRepository } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  type AgentBackendInstance,
  type AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { InMemoryConformanceDriver } from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import { parseResolvedBackendConfiguration } from "./resolved-backend-configuration.js";
import { importLegacyDatabaseConfigurationFixture } from "./database-configuration-fixture.js";
import {
  ConversationActorManager,
  type AuthoritativeCompletionObserver,
} from "../../src/server/conversations/conversation-actor-manager.js";
import {
  ConversationLifecycleService,
  type BackendThreadPersistenceAdapter,
} from "../../src/server/conversations/conversation-lifecycle-service.js";
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
  type ThreadBackendPresentationProvider,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import { boundDisplayText } from "../../src/server/conversations/payload-policy.js";
import { RuntimeBackedQueuedInputConversationGateway } from "../../src/server/conversations/queued-input-conversation-gateway.js";
import { QueuedInputDispatcher } from "../../src/server/conversations/queued-input-dispatcher.js";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
} from "../../src/server/conversations/thread-application-service.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import {
  threadAgentToolPolicyReaderDependencies,
  threadAgentToolPolicyRepository,
} from "./thread-agent-tool-policy.js";
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
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "../../src/server/events/thread-event-presentation.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";
import type { ExecutionEnvironmentProvider } from "../../src/server/execution/contracts.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY } from "../../src/server/provider-features/contracts.js";
import type { ThreadRunState } from "../../src/shared/protocol/conversation.js";
import { OverlayRepository } from "./schema9/overlay-repository.js";
import { ThreadInventoryService } from "./schema9/thread-inventory-service.js";

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
      id: "memory-backend",
      kind: "pi",
      label: "Memory backend",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "memory-connection",
      kind: "pi_sdk",
      label: "Memory connection",
      backendInstanceId: "memory-backend",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "memory-connection",
});

class MemoryBackendPersistence implements BackendThreadPersistenceAdapter {
  readonly #submissionIntents = new Set<string>();
  readonly #bindingDetails = new Map<string, string>();

  constructor(readonly database: Database.Database) {}

  initializeThread(): void {}
  initializeNewThread(): void {}
  initializeForkThread(): void {}
  readForkSettings() {
    return { toolAccess: "full" as const };
  }
  validateInitialization(): void {}
  initializationActions(): readonly [] {
    return [];
  }

  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: { readonly applicationOperationId: string },
  ): void {
    this.#submissionIntents.add(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        input.applicationOperationId,
      ]),
    );
  }

  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean {
    return this.#submissionIntents.has(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        applicationOperationId,
      ]),
    );
  }

  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): void {
    this.#bindingDetails.set(applicationThreadId, opaqueBindingDetail);
  }

  getBindingDetail(
    _scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    return this.#bindingDetails.get(applicationThreadId);
  }
}

const presentationProvider: ThreadBackendPresentationProvider = {
  async read(input) {
    return {
      revision: `memory-${input.backend.configurationRevision}`,
      backend: { label: boundDisplayText("Conformance agent") },
      interactionMode: "interactive",
      providerFeatureCapabilities: [],
      providerFeatureStates: [],
      backendCapabilities: {
        revision: "memory-presentation-1",
        actions: ["rename"],
        deliveryModes: ["submit", "steer"],
        steerTarget: "turn",
        forceReimport: {
          availability: "unavailable",
          reason: { text: "Force re-import is unavailable in this fixture." },
        },
        branching: {
          availability: "unavailable",
          reason: { text: "Branching is unavailable in this fixture." },
        },
        interactionKinds: [],
        usageAccounting: "supported" as const, turnThroughput: "unsupported" as const, usageSections: [],
        effectiveSettings: {},
      },
      settings: { revision: 0, values: [] },
      settingDescriptors: [],
      composerCommands: [],
      skills: [],
    };
  },
};

/**
 * A real in-memory application stack: SQLite overlay state, the conformance
 * driver, actors, the runtime coordinator, thread publication, the durable
 * queue, and thread mutations. Nothing is attached until a test acts.
 */
export async function createInMemoryThreadRuntimeHarness(options: {
  readonly retentionMilliseconds?: number;
  readonly persistDeliveryInputSnapshots?: boolean;
  readonly onCompletion?: (scope: RequestScope, threadId: string, turnId: string) => void;
} = {}) {
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
      canonicalPath: "/tmp/send-lifecycle",
      displayName: "Send lifecycle",
      availability: "available",
      trustState: "trusted",
    },
    10,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 20,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);

  const backendConfiguration = new BackendConfigurationRepository(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "in-memory-canonical-stream" }, 30);
  new InventoryRepository(database).updateEnvironmentAvailability(scope, environmentRecord.id, { available: true, now: 30 });
  const backend = backendConfiguration.getBackend(scope, "memory-backend");
  const profile = backendConfiguration.listProfiles(scope)[0]!;
  const instance: AgentBackendInstance = {
    id: "memory-backend",
    tenantId: scope.tenantId,
    kind: "pi",
    label: "Memory backend",
    enabled: true,
    configurationRevision: backend.configurationRevision,
    protocolRelease: "0.86.0",
  };
  const connection: AgentConnectionProfile = {
    ...profile,
    enabled: profile.enabled === 1,
  };
  const usage = new UsageService(database, {enabled: true});
  const driver = new InMemoryConformanceDriver({
    usage,
    instance,
    connection,
    scriptedResponses: { stepDelayMilliseconds: 10 },
  });
  const registry = new AgentBackendRegistry();
  registry.register({
    scope,
    instance,
    connectionKinds: [connection.kind],
    supportsConversationCreation: true,
    creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
    create: () => driver,
  });

  const workspace = {
    canonicalPath: "/tmp/send-lifecycle",
    authorityRevision: 0,
    summary: {
      id: workspaceRecord.id,
      environmentId: environmentRecord.id,
      displayName: "Send lifecycle",
      displayPath: "/tmp/send-lifecycle",
      availability: "available" as const,
      trustState: "trusted" as const,
      revision: 0,
    },
  };
  const environments: ExecutionEnvironmentProvider = {
    listEnvironments: async () => [],
    directoryBrowsingAvailability: () => "unavailable",
    browseDirectories: async () => {
      throw new Error("not used");
    },
    validateWorkspace: async () => workspace,
    revalidateWorkspace: async () => workspace,
    acquireLease: async () => ({
      scope,
      environment: {
        id: environmentRecord.id,
        label: "Local",
        availability: "available",
        diagnosticCode: null,
        revision: 0,
      },
      workspace,
      release: async () => undefined,
    }),
    executeCommand: async () => {
      throw new Error("not used");
    },
  };

  const inventoryRepository = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  const creation = new ConversationCreationRepository(database);
  const drafts = new ConversationDraftRepository(database);
  const completion = new SubmissionCompletionRepository(database);
  const queueRepository = new QueuedInputRepository(database);
  const operationRepository = new ConversationOperationRepository(database);
  const backendPersistence = new MemoryBackendPersistence(database);
  const persistenceByInstance = new Map([[instance.id, backendPersistence]]);
  const targets = new DatabaseConversationTargetStore({
    database,
    bindings,
    bindingDetails: persistenceByInstance,
    registry,
    environments,
  });
  targets.bindWorkspacePublications({
    handoffAuthoritativeReplacement: () => undefined,
  });
  const actorTargets = new DatabaseActorTargetResolver(targets);
  const lifecycleTargets = new DatabaseLifecycleTargetResolver(targets);

  let observeSubmission:
    | ((
        eventScope: RequestScope,
        applicationThreadId: string,
        input: {
          readonly backendCorrelation: string;
        },
      ) => void)
    | undefined;
  let observeCompletion: AuthoritativeCompletionObserver | undefined;
  const actors = new ConversationActorManager({
    environments,
    ...(options.persistDeliveryInputSnapshots ? { deliveryInputSnapshots: new DeliveryInputSnapshotRepository(database) } : {}),
    attachmentDelivery: {} as never,
    retentionMilliseconds: options.retentionMilliseconds ?? 0,
    runtimeBudget: 8,
    onAuthoritativeSubmission: (eventScope, applicationThreadId, input) =>
      observeSubmission?.(eventScope, applicationThreadId, input),
    onAuthoritativeCompletion: (eventScope, applicationThreadId, input) =>
      observeCompletion?.(eventScope, applicationThreadId, input),
  });
  const lifecycle = new ConversationLifecycleService({
    registry,
    targets: lifecycleTargets,
    backendPersistence: persistenceByInstance,
    bindings,
    creation,
    drafts,
    completion,
    actors,
  });

  const threadHubs = new ScopedThreadEventHubRegistry();
  let threadSnapshots!: ThreadSnapshotPublisher;
  const interactions = new InteractionBroker();
  const threadPresentation = new DatabaseThreadApplicationPresentationReader({
    targets,
    providers: new Map([[instance.id, presentationProvider]]),
  });
  const actionPersistence = new Map([
    [
      instance.id,
      {
        providerFeatureConcurrency: () =>
          QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
      } as never,
    ],
  ]);
  let runtimes!: ThreadRuntimeCoordinator;
  const applicationRunStates = new Map<string, ThreadRunState[]>();
  const publishApplicationThread = async (
    eventScope: RequestScope,
    applicationThreadId: string,
  ) => {
    const loaded = await runtimes.captureLoadedState(
      eventScope,
      applicationThreadId,
    );
    if (!loaded) return;
    const states = applicationRunStates.get(applicationThreadId) ?? [];
    states.push(loaded.runState);
    applicationRunStates.set(applicationThreadId, states);
  };
  const threads = new ThreadApplicationService({
    usage,
    inventory: new DatabaseThreadApplicationInventoryReader({
      inventory: inventoryRepository,
      queue: queueRepository,
      completion,
      ...threadAgentToolPolicyReaderDependencies(database),
      directoryBrowsingAvailability: () => "unavailable",
      executionWorkspaces: directThreadExecutionWorkspaceReader,
    }),
    conversations: new ActorBackedThreadApplicationConversationReader({
      actors,
      targets: actorTargets,
    }),
    queue: new DatabaseThreadApplicationQueueReader(queueRepository),
    presentation: threadPresentation,
    recovery: new DatabaseThreadApplicationRecoveryReader({
      creation,
      operations: operationRepository,
      targets: lifecycleTargets,
      registry,
      forks: {
        readRecovery: async () => ({ recoverable: false }),
      },
    }),
    interactions,
    actionPersistence,
    attachmentDelivery: { supports: () => false },
  });
  let queueDispatcher!: QueuedInputDispatcher;
  runtimes = new ThreadRuntimeCoordinator({
    actors,
    targets: actorTargets,
    bridge: new ConversationEventBridge(new ThreadEventPresentation(threads), (eventScope, threadId, turns) => usage.registerVisibleTurns(eventScope, threadId, turns)),
    interactions,
    hubs: threadHubs,
    retentionMilliseconds: options.retentionMilliseconds ?? 0,
    onThreadChanged: publishApplicationThread,
    onAuthoritativeSettled: (eventScope, applicationThreadId) =>
      queueDispatcher.onAuthoritativeSettled(eventScope, applicationThreadId),
  });
  const unsubscribeUsage = usage.subscribe((eventScope, threadId, revision) => runtimes.publishUsageRevisionIfLoaded(eventScope, threadId, revision));
  const queueGateway = new RuntimeBackedQueuedInputConversationGateway({
    runtimes,
    targets: actorTargets,
  });
  queueDispatcher = new QueuedInputDispatcher({
    repository: queueRepository,
    gateway: queueGateway,
    publisher: {
      publish(eventScope, applicationThreadId, event) {
        threadHubs.thread(eventScope, applicationThreadId).publish(event);
      },
    },
    retryPolicy: {
      maximumRetries: 2,
      baseDelayMilliseconds: 25,
      maximumDelayMilliseconds: 100,
    },
    isDispatchBlocked: (eventScope, applicationThreadId) =>
      operationRepository.hasUncertainThreadOperation(
        eventScope,
        applicationThreadId,
      ),
  });
  threadSnapshots = new ThreadSnapshotPublisher(bindings, threads, runtimes);
  const inventory = new InventoryService(inventoryRepository, {
    publishMany: async (eventScope, states) => {
      await threadSnapshots.publishMany(
        eventScope,
        states.map(({ threadId }) => threadId),
      );
    },
    publishApplicationThread,
  });
  const mutations = new ThreadMutationGateway({
    bindings,
    actors,
    inventory: inventoryRepository,
    lifecycle,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: queueDispatcher,
    operations: operationRepository,
    completions: completion,
    queueGateway,
    runtimes,
    interactions,
    presentation: threadPresentation,
    agentToolPolicies: threadAgentToolPolicyRepository(database),
    actionPersistence,
    publishThreadSnapshot: (eventScope, applicationThreadId) =>
      threadSnapshots.publish(eventScope, applicationThreadId),
    onThreadChanged: publishApplicationThread,
  });
  threads.bindMutations(mutations);

  const completionFollowUps: Promise<void>[] = [];
  observeCompletion = async (eventScope, applicationThreadId, input) => {
    const observed = await queueDispatcher.onAuthoritativeCompletion(
      eventScope,
      applicationThreadId,
      input,
    );
    if (!observed) return;
    if (observed.applicationTurnId) options.onCompletion?.(eventScope, applicationThreadId, observed.applicationTurnId);
    // Match the production observer boundary: recovery and inventory wake
    // re-enter the loaded actor and must not be awaited from the actor's
    // own authoritative observer chain.
    completionFollowUps.push(
      (async () => {
        await mutations.recoverThread(eventScope, applicationThreadId);
        await inventory.wakeForRuntimeSignal(
          eventScope,
          applicationThreadId,
          "completion",
        );
      })(),
    );
  };
  observeSubmission = (eventScope, applicationThreadId, input) => {
    mutations.observeAuthoritativeSubmission(
      eventScope,
      applicationThreadId,
      input.backendCorrelation,
    );
  };

  await queueDispatcher.recover(scope);
  return {
    database,
    scope,
    workspaceRecord,
    connection,
    driver,
    usage,
    inventoryRepository,
    bindings,
    queueRepository,
    lifecycle,
    actors,
    threads,
    runtimes,
    threadSnapshots,
    queueDispatcher,
    inventory,
    mutations,
    interactions,
    applicationRunStates,
    completionFollowUps,
    async close(): Promise<void> {
      unsubscribeUsage();
      await mutations.close();
      await queueDispatcher.close();
      await runtimes.close();
      await actors.close();
      await interactions.close();
      database.close();
    },
  };
}
