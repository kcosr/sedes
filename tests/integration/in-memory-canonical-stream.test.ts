import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  type AgentBackendInstance,
  type AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { InMemoryConformanceDriver } from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
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
import { threadAgentToolPolicyRepository } from "../support/thread-agent-tool-policy.js";
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
import type {
  NormalizedThreadEvent,
  ThreadRunState,
  ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";

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
        usageAccounting: "supported" as const, usageSections: [],
        effectiveSettings: {},
      },
      settings: { revision: 0, values: [] },
      settingDescriptors: [],
      composerCommands: [],
      skills: [],
    };
  },
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("in-memory canonical thread stream", () => {
  it("streams one bound send from a current checkpoint as an exact replayable incremental suffix", async () => {
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
            readonly backendTurnId: string;
          },
        ) => void)
      | undefined;
    let observeCompletion: AuthoritativeCompletionObserver | undefined;
    const actors = new ConversationActorManager({
      environments,
      attachmentDelivery: {} as never,
      retentionMilliseconds: 0,
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
      retentionMilliseconds: 0,
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
      inventory: inventoryRepository,
      lifecycle,
      forks: { recoverActive: () => undefined },
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

    try {
      await queueDispatcher.recover(scope);
      const controller = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Agent controller",
        initialText: "",
      });
      const agentCreated = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Agent-created background thread",
        initialText: "",
      });

      // No thread hub or browser SSE subscriber is attached here. The direct
      // first-send gateway must still establish runtime observation so the
      // application-wide sidebar projection sees both active and settled run
      // states for the newly bound thread.
      await expect(
        mutations.sendDirect(scope, {
          initiator: {
            kind: "thread_agent",
            sourceThreadId: controller.applicationThreadId,
            sourceWorkspaceId: workspaceRecord.id,
          },
          targetThreadId: agentCreated.applicationThreadId,
          message: "Work without being opened in the browser.",
          mutationId: randomUUID(),
        }),
      ).resolves.toMatchObject({ status: "delivery_accepted" });
      await vi.waitFor(
        () =>
          expect(
            applicationRunStates.get(agentCreated.applicationThreadId),
          ).toContain("running"),
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () =>
          expect(
            applicationRunStates.get(agentCreated.applicationThreadId),
          ).toContain("idle"),
        { timeout: 15_000 },
      );

      const backgroundUsage = usage.read(scope, agentCreated.applicationThreadId);
      expect(backgroundUsage.summary.reasons).not.toContain("capture_failed");
      expect(backgroundUsage.state).toBe("complete");
      expect(backgroundUsage.summary.metrics.input.value).toBe("11");
      expect(backgroundUsage.summary.metrics.output.value).toBe("7");

      const created = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Send lifecycle",
        initialText: "hello first turn",
      });
      const threadId = created.applicationThreadId;

      // Subscribe like a browser SSE attach before any send so every hub
      // frame of both send lifecycles is observed.
      const hubHandle = runtimes.quiet(scope, threadId);
      const envelopes: ThreadEventEnvelope[] = [];
      const subscription = hubHandle.hub.subscribe((envelope) => {
        envelopes.push(envelope);
      });
      await threadSnapshots.publishAuthoritativeReplacement(scope, threadId);
      const eventsOf = (frames: readonly ThreadEventEnvelope[]) =>
        frames.map(({ event }) => event as NormalizedThreadEvent);

      try {
        const backendEmit = vi.spyOn(driver, "emit");
        const boundThread = inventoryRepository.getThread(scope, threadId);
        const first = await mutations.mutate(scope, threadId, {
          kind: "deliver",
          mode: "submit",
          mutationId: randomUUID(),
          expectedThreadRevision: boundThread.thread.revision,
          expectedDraftRevision: created.draft.revision,
        });
        expect(first.status).toBe("delivery_accepted");
        await vi.waitFor(
          () => {
            const events = eventsOf(envelopes);
            expect(
              events.some(
                (event) =>
                  event.type === "turn_upsert" &&
                  event.turn.status === "completed",
              ),
            ).toBe(true);
            expect(events.at(-1)).toBeDefined();
            expect(
              events.some(
                (event) => event.type === "run_state" && event.state === "idle",
              ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        await Promise.all(completionFollowUps.splice(0));
        await sleep(200);

        const firstPhase = eventsOf(envelopes);
        // First send is the load-bearing unbound-to-bound boundary: it retires
        // the quiet application generation and publishes the bound runtime's
        // one imported projection baseline.
        const firstSnapshots = firstPhase.filter(
          ({ type }) => type === "snapshot",
        );
        expect(firstSnapshots).toHaveLength(2);
        expect(
          new Set(firstSnapshots.map(({ generation }) => generation)).size,
        ).toBe(firstSnapshots.length);
        const firstGeneration = firstSnapshots.at(-1)!.generation;

        // The browser attached while the thread was still unbound. That same
        // open subscription must pin the newly established backend observer
        // after the idle threshold, including events initiated outside Sedes.
        const externalStart = envelopes.length;
        const backendRecord = backendEmit.mock.calls[0]![0];
        driver.emit(backendRecord, {
          type: "notice",
          notice: {
            id: "external-after-idle",
            tone: "info",
            message: { text: "External backend event after idle" },
            createdAt: new Date().toISOString(),
          },
        });
        await vi.waitFor(() => {
          expect(
            eventsOf(envelopes.slice(externalStart)).some(
              (event) =>
                event.type === "notice" &&
                event.notice.id === "external-after-idle",
            ),
          ).toBe(true);
        });

        // Borrowing the already-pinned runtime must not establish another
        // generation or publish another baseline.
        const boundRuntime = await runtimes.acquire(scope, threadId);
        const canonicalFrames: ThreadEventEnvelope[] = [];
        const liveListener = vi.fn((envelope: ThreadEventEnvelope) => {
          canonicalFrames.push(envelope);
        });
        const canonicalSubscription =
          hubHandle.hub.subscribeFromCurrentSnapshot(liveListener);
        const checkpoint = canonicalSubscription.checkpoint!;
        expect(checkpoint.projectionGeneration).toBe(
          firstGeneration,
        );
        expect(checkpoint.snapshot).toEqual(hubHandle.hub.snapshot);
        expect(canonicalSubscription.replay).toEqual([]);
        const anchorLength = canonicalFrames.length;
        expect(
          canonicalFrames.filter(({ event }) => event.type === "snapshot"),
        ).toHaveLength(0);
        const draftBefore = inventoryRepository.getDraft(scope, threadId);
        const savedDraft = inventoryRepository.saveDraft(scope, threadId, {
          text: "second turn over the queue",
          contextExcerpts: [],
          taskReferenceIds: [],
          attachmentIds: [],
          expectedRevision: draftBefore.revision,
          now: Date.now(),
        });
        const threadBefore = inventoryRepository.getThread(scope, threadId);
        const secondPhaseStart = envelopes.length;
        const second = await mutations.mutate(scope, threadId, {
          kind: "deliver",
          mode: "submit",
          mutationId: randomUUID(),
          expectedThreadRevision: threadBefore.thread.revision,
          expectedDraftRevision: savedDraft.revision,
        });
        expect(second.status).toBe("delivery_queued");

        await vi.waitFor(
          () => {
            const events = eventsOf(envelopes.slice(secondPhaseStart));
            expect(
              events.filter(
                (event) =>
                  event.type === "turn_upsert" &&
                  event.turn.status === "completed",
              ).length,
            ).toBeGreaterThanOrEqual(1);
            expect(
              events.some(
                (event) => event.type === "run_state" && event.state === "idle",
              ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        await Promise.all(completionFollowUps.splice(0));
        await sleep(300);
        expect(queueRepository.list(scope, threadId)).toEqual(
          expect.arrayContaining([]),
        );

        const secondPhase = eventsOf(envelopes.slice(secondPhaseStart));
        const observedTypes = new Set(secondPhase.map(({ type }) => type));
        expect(observedTypes.has("queue_changed")).toBe(true);
        expect(observedTypes.has("run_state")).toBe(true);
        expect(observedTypes.has("turn_upsert")).toBe(true);
        expect(observedTypes.has("item_upsert")).toBe(true);
        expect(observedTypes.has("capabilities_changed")).toBe(true);
        // The checkpoint is the only transcript replacement. Queue/application
        // overlays and the complete backend lifecycle remain incremental.
        expect(
          canonicalFrames.filter(({ event }) => event.type === "snapshot"),
        ).toHaveLength(0);
        expect(
          canonicalFrames
            .slice(anchorLength)
            .some(({ event }) =>
              event.type === "item_upsert" && event.item.kind === "user_message"
                ? event.item.content.some(
                    (part) =>
                      part.kind === "text" &&
                      part.text.text === "second turn over the queue",
                  )
                : false,
            ),
        ).toBe(true);
        expect(
          backendEmit.mock.calls.some(
            ([, event]) =>
              event.type === "item_completed" &&
              event.item.semanticKind === "user_message" &&
              event.item.content.some(
                (part) =>
                  part.kind === "text" &&
                  part.text.text === "second turn over the queue",
              ),
          ),
        ).toBe(true);
        const backendUserCall = backendEmit.mock.calls.findIndex(
          ([, event]) =>
            event.type === "item_completed" &&
            event.item.semanticKind === "user_message" &&
            event.item.content.some(
              (part) =>
                part.kind === "text" &&
                part.text.text === "second turn over the queue",
            ),
        );
        const normalizedUserCall = liveListener.mock.calls.findIndex(
          ([{ event }]) =>
            event.type === "item_upsert" &&
            event.item.kind === "user_message" &&
            event.item.content.some(
              (part) =>
                part.kind === "text" &&
                part.text.text === "second turn over the queue",
            ),
        );
        expect(backendUserCall).toBeGreaterThanOrEqual(0);
        expect(normalizedUserCall).toBeGreaterThanOrEqual(0);
        expect(
          backendEmit.mock.invocationCallOrder[backendUserCall],
        ).toBeLessThan(
          liveListener.mock.invocationCallOrder[normalizedUserCall]!,
        );

        const incrementalItems = canonicalFrames
          .slice(anchorLength)
          .filter(({ event }) => event.type === "item_upsert")
          .map(({ event }) =>
            event.type === "item_upsert" ? event.item : undefined,
          )
          .filter((item) => item !== undefined);
        expect(incrementalItems.some(({ kind }) => kind === "tool")).toBe(true);
        expect(
          incrementalItems.some(({ kind }) => kind === "assistant_message"),
        ).toBe(true);

        // Every envelope applies to the real browser store without repair.
        const browserStore = new NormalizedThreadStore();
        expect(browserStore.applyCheckpoint(checkpoint).kind).toBe("applied");
        for (const envelope of canonicalFrames) {
          const result = browserStore.apply(envelope);
          expect(
            result.kind,
            `browser store rejected ${envelope.event.type}: ${JSON.stringify(result)}`,
          ).not.toBe("resnapshot_required");
        }
        browserStore.confirmReplayCaughtUp();
        expect(browserStore.state.authoritative).toBe(true);

        const finalSnapshot = browserStore.state.snapshot!;
        const finalTurn =
          finalSnapshot.turnsById[finalSnapshot.orderedTurnIds.at(-1)!]!;
        const finalUsage = usage.read(scope, threadId, finalTurn.id);
        expect(finalUsage).toMatchObject({state:"complete",turnState:"completed",measurementScope:"whole_turn",summary:{reasons:[],metrics:{input:{value:"11"},output:{value:"7"}},costs:[{amount:"0.0002",currency:"USD"}]}});
        expect(usage.read(scope,threadId).summary.metrics.input.value).toBe("22");
        const finalItems = finalTurn.orderedItemIds.map(
          (itemId) => finalSnapshot.itemsById[itemId]!,
        );
        expect(
          finalItems.filter(({ kind }) => kind === "user_message"),
        ).toHaveLength(1);
        expect(
          finalItems.filter(({ kind }) => kind === "assistant_message"),
        ).toHaveLength(1);
        expect(finalItems.filter(({ kind }) => kind === "tool")).toHaveLength(
          1,
        );
        expect(new Set(finalItems.map(({ id }) => id)).size).toBe(
          finalItems.length,
        );

        // A reconnect from a cursor inside the send receives the strict suffix
        // only: no anchor replay and no already-applied identity.
        const midIndex = canonicalFrames.findIndex(
          ({ event }, index) =>
            index >= anchorLength &&
            event.type === "item_upsert" &&
            event.item.kind === "user_message",
        );
        expect(midIndex).toBeGreaterThanOrEqual(anchorLength);
        const reconnect = hubHandle.hub.subscribe(
          () => undefined,
          canonicalFrames[midIndex]!.eventId,
        );
        expect(reconnect.replay.map(({ eventId }) => eventId)).toEqual(
          canonicalFrames.slice(midIndex + 1).map(({ eventId }) => eventId),
        );
        expect(
          reconnect.replay.some(({ event }) => event.type === "snapshot"),
        ).toBe(false);
        reconnect.close();
        canonicalSubscription.close();
        boundRuntime.release();
      } finally {
        subscription.close();
        hubHandle.release();
      }
    } finally {
      unsubscribeUsage();
      await mutations.close();
      await queueDispatcher.close();
      await runtimes.close();
      await actors.close();
      await interactions.close();
      database.close();
    }
  }, 60_000);
});
