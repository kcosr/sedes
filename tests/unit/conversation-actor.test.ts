import { describe, expect, it, vi } from "vitest";
import {
  type BackendCapabilityDocument,
  type BackendConversationEvent,
  type BackendConversationSnapshot,
  type SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import {
  BackendError,
  type BackendHistoryPage,
  type ConversationBackendDriver,
  type ConversationBinding,
  type ConversationHandle,
  type EstablishedBackendProjection,
  type SteerTurnInput,
  type SteerTurnResult,
  type SubmitTurnInput,
} from "../../src/server/backends/contracts.js";
import {
  ConversationActorManager,
  ConversationRuntimeReclamationRaceError,
  type AcquireConversationActorInput,
  type AcquireConversationActorOptions,
} from "../../src/server/conversations/conversation-actor-manager.js";
import type { ComposerAttachmentDeliveryService } from "../../src/server/composer-attachments/composer-attachment-delivery-service.js";
import type {
  AuthoritativeCompletionObserver,
  AuthoritativeSubmissionObserver,
} from "../../src/server/conversations/conversation-actor-manager.js";
import type { ConversationActorEvent } from "../../src/server/conversations/conversation-actor.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import type { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeNotIdleError,
  ThreadRuntimeMaintenanceStaleError,
  ThreadRuntimeRetirementUnprovenError,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import type {
  ExecutionEnvironmentLease,
  ExecutionEnvironmentProvider,
  ValidatedWorkspace,
} from "../../src/server/execution/contracts.js";
import { DeferredProductionOperations } from "../../src/server/production-application.js";
import type { DeliveryInputSnapshotRepository } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";

const scope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

const workspace: ValidatedWorkspace = {
  canonicalPath: "/workspace",
  authorityRevision: 3,
  summary: {
    id: "ba11a564-8ef6-4d99-8bc1-680a05a87f00",
    environmentId: "a3bc9398-a451-4305-a543-5e230254242d",
    displayName: "workspace",
    displayPath: "/workspace",
    availability: "available",
    trustState: "trusted",
    revision: 0,
  },
};

const binding: ConversationBinding = {
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  applicationThreadId: "78cbf267-a526-43b0-8262-8ec2c23dce4c",
  backendInstanceId: "local-pi",
  connectionProfileId: "connection-1",
  executionEnvironmentId: workspace.summary.environmentId,
  backendConversationId: "native-1",
  createdAt: "2026-07-30T12:00:00.000Z",
};
const projectedTurnId = applicationTurnIdForBackendTurn({
  backendInstanceId: binding.backendInstanceId,
  sourceApplicationThreadId: binding.applicationThreadId,
  backendTurnId: "turn-1",
});

function snapshot(
  runState: BackendConversationSnapshot["runState"] = "idle",
  text = "hello",
): BackendConversationSnapshot {
  return {
    orderedBackendTurnIds: ["turn-1"],
    turnsById: {
      "turn-1": {
        backendTurnId: "turn-1",
        status: runState === "idle" ? "completed" : "in_progress",
        ...(runState === "idle" ? { endedBy: "agent_settled" as const } : {}),
        orderedBackendItemIds: ["item-1"],
      },
    },
    itemsById: {
      "item-1": {
        backendItemId: "item-1",
        backendTurnId: "turn-1",
        semanticKind: "assistant_message",
        status: runState === "idle" ? "completed" : "streaming",
        sourceOrder: 0,
        markdown: { text },
      },
    },
    runState,
    ...(runState === "idle" ? {} : { activeBackendTurnId: "turn-1" }),
  };
}

function selectedBranchingCapabilities(
  boundaries: (
    "latest_completed" | "latest_provider_snapshot" | "selected_completed_turn"
  )[] = ["selected_completed_turn"],
  sourceMustBeIdle = true,
): BackendCapabilityDocument {
  return {
    revision: "branching-selected",
    actions: [],
    deliveryModes: ["submit"],
    steerTarget: null,
    composerAttachments: { fileStaging: false, nativeImage: false },
    nonblockingQuestions: false,
    providerOutputArtifacts: { nativeImage: false },
    supportsHistory: true,
    branching: {
      availability: "available",
      boundaries,
      method: "provider_native",
      sourceMustBeIdle,
      settingsInheritance: "application_applied",
      fidelity: {
        instructions: false,
        messages: true,
        toolCalls: true,
        toolResults: true,
        compaction: true,
        attachments: true,
        settings: true,
        limitations: [],
      },
      childIdentity: "application_reserved",
      creationRecovery: "idempotent",
    },
    interactionKinds: [],
    usageSections: [],
    effectiveSettings: { toolAccess: "read_only" },
  };
}

class FakeHandle {
  readonly binding = binding;
  retirementBlocked = false;
  readonly close = vi.fn(async () => undefined);
  readonly submit = vi.fn(async (_input: SubmitTurnInput) => ({
    accepted: true as const,
    reconciliationToken: "receipt",
  }));
  readonly steer = vi.fn(async (input: SteerTurnInput): Promise<SteerTurnResult> => ({
    status: "accepted" as const,
    reconciliationToken: input.reconciliationToken,
    completionCorrelation: input.applicationOperationId,
    backendTurnId: input.target.kind === "turn" ? input.target.turnId : "conversation-turn",
  }));
  readonly interrupt = vi.fn(async () => undefined);
  readonly reconcileInterrupt = vi.fn(async () => ({
    outcome: "not_applied" as const,
  }));
  readonly perform = vi.fn(async () => ({ accepted: true as const }));
  readonly reconcileAction = vi.fn(async () => ({
    outcome: "not_applied" as const,
  }));
  readonly respond = vi.fn(async () => undefined);
  readonly history = vi.fn(
    async (
      _input: Parameters<ConversationHandle["history"]>[0],
    ): Promise<BackendHistoryPage> => ({
      orderedBackendTurnIds: [],
      turnsById: {},
      itemsById: {},
    }),
  );
  readonly locateTurn = vi.fn(
    async (
      _input: Parameters<ConversationHandle["locateTurn"]>[0],
    ): Promise<Awaited<ReturnType<ConversationHandle["locateTurn"]>>> => ({
      status: "not_found",
    }),
  );
  readonly backendCapabilities = vi.fn(
    async (): Promise<BackendCapabilityDocument> => ({
      revision: "1",
      actions: [],
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "unavailable",
        reason: { text: "Branching is unavailable in this fixture." },
      },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: {},
    }),
  );
  readonly usage = vi.fn(async () => ({}));
  readonly rawListeners = new Set<(event: BackendConversationEvent) => void>();
  readonly subscribe = vi.fn(
    (listener: (event: BackendConversationEvent) => void) => {
      this.rawListeners.add(listener);
      return () => this.rawListeners.delete(listener);
    },
  );
  readonly establishmentSnapshots: BackendConversationSnapshot[] = [snapshot()];
  readonly establishmentHistories: EstablishedBackendProjection["history"][] = [
    { operational: true },
  ];
  readonly establishmentListeners: Array<
    (event: SequencedBackendEvent) => void
  > = [];
  readonly closeOrder: string[];
  establishCount = 0;
  throwOnUnsubscribe = false;

  constructor(closeOrder: string[]) {
    this.closeOrder = closeOrder;
    this.close.mockImplementation(async () => {
      this.rawListeners.clear();
      this.establishmentListeners.length = 0;
      this.closeOrder.push("handle-close");
    });
  }

  async establishProjection(_input: {
    readonly signal: AbortSignal;
  }): Promise<EstablishedBackendProjection> {
    if (this.establishmentListeners.some(Boolean)) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage:
          "The active backend projection must be detached before replacement.",
        backendCode: "fake_projection_subscriber_active",
      });
    }
    const index = this.establishCount;
    this.establishCount += 1;
    const selected =
      this.establishmentSnapshots[index] ?? this.establishmentSnapshots.at(-1);
    if (!selected) throw new Error("missing_fake_snapshot");
    return {
      handleSequence: -1,
      snapshot: selected,
      history:
        this.establishmentHistories[index] ??
        this.establishmentHistories.at(-1)!,
      subscribeFromNext: (listener) => {
        if (this.establishmentListeners.some(Boolean)) {
          throw new Error("fake_projection_subscriber_active");
        }
        this.establishmentListeners[index] = listener;
        return () => {
          this.closeOrder.push(`unsubscribe-${index}`);
          delete this.establishmentListeners[index];
          if (this.throwOnUnsubscribe) {
            throw new Error("unsubscribe_failed");
          }
        };
      },
    };
  }

  emit(
    index: number,
    event: BackendConversationEvent,
    handleSequence = 0,
  ): void {
    for (const listener of [...this.rawListeners]) listener(event);
    this.establishmentListeners[index]?.({
      handleSequence,
      event,
    });
  }
}

function fixture(
  onAuthoritativeCompletion?: AuthoritativeCompletionObserver,
  onAuthoritativeSubmission?: AuthoritativeSubmissionObserver,
  retentionMilliseconds = 10,
  deliveryInputSnapshots?: DeliveryInputSnapshotRepository,
  runtimeBudget = 8,
) {
  const closeOrder: string[] = [];
  const handle = new FakeHandle(closeOrder);
  const lease: ExecutionEnvironmentLease = {
    scope,
    environment: {
      id: workspace.summary.environmentId,
      label: "Local",
      availability: "available",
      diagnosticCode: null,
      revision: 0,
    },
    workspace,
    release: vi.fn(async () => {
      closeOrder.push("lease-release");
    }),
  };
  const environments = {
    acquireLease: vi.fn(
      async (
        requestedScope: typeof scope,
        request: {
          readonly environmentId: string;
          readonly workspace: ValidatedWorkspace;
        },
      ) => ({
        ...lease,
        scope: requestedScope,
        environment: {
          ...lease.environment,
          id: request.environmentId,
        },
        workspace: request.workspace,
      }),
    ),
  } as unknown as ExecutionEnvironmentProvider;
  const driver = {
    instance: { kind: "pi" },
    attach: vi.fn(async () => handle as unknown as ConversationHandle),
    resolveBranchCheckpoint: vi.fn(async () => ({
      backendInstanceId: binding.backendInstanceId,
      kind: "conversation_leaf" as const,
      opaqueReference: "selected-checkpoint",
    })),
  } as unknown as ConversationBackendDriver;
  const actorManager = new ConversationActorManager({
    environments,
    attachmentDelivery: {
      materialize: vi.fn(async () => ({
        attachments: [],
        canonicalBytes: {
          read: async () => {
            throw new Error("unexpected_canonical_attachment_read");
          },
        },
        canonicalEvidence: { resolve: () => [] },
      })),
    } as unknown as ComposerAttachmentDeliveryService,
    retentionMilliseconds,
    runtimeBudget,
    ...(deliveryInputSnapshots ? { deliveryInputSnapshots } : {}),
    ...(onAuthoritativeCompletion ? { onAuthoritativeCompletion } : {}),
    ...(onAuthoritativeSubmission ? { onAuthoritativeSubmission } : {}),
  });
  const manager = {
    acquire: (
      input: AcquireConversationActorInput,
      options: AcquireConversationActorOptions = { idleRelease: "retain" },
    ) => actorManager.acquire(input, options),
    runWithRuntimeRetired:
      actorManager.runWithRuntimeRetired.bind(actorManager),
    runWithRuntimesStopped: actorManager.runWithRuntimesStopped.bind(actorManager),
    close: () => actorManager.close(),
  };
  return {
    actorManager,
    closeOrder,
    driver,
    environments,
    handle,
    lease,
    manager,
  };
}

describe("ConversationActorManager", () => {
  it("keeps idle-input conversations alive until authoritative background work clears", async () => {
    const { manager, handle, driver } = fixture();
    const acquired = await manager.acquire({ scope, binding, workspace, opaqueBindingDetail: "opaque", driver });
    expect(acquired.actor.canEvict).toBe(true);
    const activity = { state: "known" as const, agents: 1, commands: 0, other: 0 };
    handle.emit(0, { type: "background_activity_changed", activity }, 0);
    await acquired.actor.captureSnapshotState();
    expect(acquired.actor.timeline.runState).toBe("idle");
    expect(acquired.actor.authoritativelySettled).toBe(true);
    expect(acquired.actor.canEvict).toBe(false);
    expect(await acquired.actor.closeIfIdle()).toBe(false);
    handle.emit(0, { type: "background_activity_changed", activity: { ...activity, agents: 0, state: "unknown" } }, 1);
    await acquired.actor.captureSnapshotState();
    expect(acquired.actor.canEvict).toBe(false);
    handle.emit(0, { type: "background_activity_changed", activity: { ...activity, agents: 0 } }, 2);
    await acquired.actor.captureSnapshotState();
    handle.retirementBlocked = true;
    expect(acquired.actor.authoritativelySettled).toBe(true);
    expect(acquired.actor.canEvict).toBe(false);
    expect(await acquired.actor.closeIfIdle()).toBe(false);
    handle.retirementBlocked = false;
    expect(acquired.actor.canEvict).toBe(true);
    acquired.release();
    await manager.close();
  });

  function detachFixture(onBridgeRelease = async () => undefined) {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    current.handle.establishmentSnapshots[0] = snapshot("running");
    const target: AcquireConversationActorInput = {
      scope, binding, workspace, opaqueBindingDetail: "opaque", driver: current.driver,
    };
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async () => target) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: onBridgeRelease,
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({ publishPending: vi.fn(), release: vi.fn(async () => undefined) }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    return { ...current, coordinator, target };
  }

  it("detaches an active presentation without interrupting or reattaching and fences direct admission", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    runtime.release();
    const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const operation = vi.fn(async () => gate);
    const maintenance = current.coordinator.runWithRuntimeDetached(
      scope, binding.applicationThreadId, expected, operation,
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    expect(current.handle.close).toHaveBeenCalledOnce();
    expect(current.handle.interrupt).not.toHaveBeenCalled();
    expect(current.driver.attach).toHaveBeenCalledOnce();
    let settled = false;
    const reopen = current.manager.acquire(current.target).finally(() => { settled = true; });
    const rejected = expect(reopen).rejects.toMatchObject({ backendCode: "conversation_actor_admission_invalidated" });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await maintenance;
    await rejected;
    expect(current.driver.attach).toHaveBeenCalledOnce();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("explicitly stops an active actor with live execution borrowers and keeps both admission paths fenced", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    const direct = await current.manager.acquire(current.target);
    let releaseHost!: () => void;
    const hostStopped = new Promise<void>(resolve => { releaseHost = resolve; });
    const originalClose = current.handle.close.getMockImplementation()!;
    current.handle.close.mockImplementation(async () => { await hostStopped; await originalClose(); });
    const stopOwnedResources = vi.fn(async () => {
      expect(current.handle.close).not.toHaveBeenCalled();
      await expect(runtime.actor.usage()).rejects.toThrow("conversation_actor_operation_unavailable");
      releaseHost();
    });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const operation = vi.fn(async () => gate);
    const stopping = current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId], stopOwnedResources, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    expect(runtime.actor.closed).toBe(true);
    expect(current.handle.close).toHaveBeenCalledOnce();
    expect(stopOwnedResources).toHaveBeenCalledOnce();
    expect(current.driver.attach).toHaveBeenCalledOnce();
    const reopen = current.manager.acquire(current.target);
    const rejected = expect(reopen).rejects.toMatchObject({ backendCode: "conversation_actor_admission_invalidated" });
    let coordinatorSettled = false;
    const coordinatorReopen = current.coordinator.acquire(scope, binding.applicationThreadId).finally(() => { coordinatorSettled = true; });
    await Promise.resolve();
    expect(coordinatorSettled).toBe(false);
    finish();
    await stopping;
    await rejected;
    const replacement = await coordinatorReopen;
    expect(replacement.actor).not.toBe(runtime.actor);
    replacement.release();
    runtime.release();
    direct.release();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("keeps explicit Stop fenced when actor cleanup fails even after the host effect succeeds", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    current.handle.close.mockRejectedValue(new Error("owned lease cleanup unproved"));
    const stopOwnedResources = vi.fn(async () => undefined);
    const operation = vi.fn(async () => undefined);
    await expect(current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId], stopOwnedResources, operation))
      .rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    expect(stopOwnedResources).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    await expect(current.coordinator.acquire(scope, binding.applicationThreadId)).rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    await expect(current.manager.acquire(current.target)).rejects.toThrow("Conversation actor retirement could not be proven.");
    runtime.release();
    await current.coordinator.close();
    await expect(current.manager.close()).rejects.toThrow();
  });

  it("rejects queued actor operations that have not reached the provider when explicit Stop begins", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    let releaseRead!: () => void;
    const pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
    current.handle.usage.mockClear();
    current.handle.usage.mockImplementationOnce(async () => { await pendingRead; return {}; });
    const active = runtime.actor.usage();
    await vi.waitFor(() => expect(current.handle.usage).toHaveBeenCalledOnce());
    const queued = runtime.actor.usage();
    const rejected = expect(queued).rejects.toThrow("conversation_actor_operation_unavailable");
    await current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId], async () => { releaseRead(); }, async () => undefined);
    await active;
    await rejected;
    expect(current.handle.usage).toHaveBeenCalledOnce();
    runtime.release();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("retires the closed local owner after a refused host Stop so a fresh actor can attach without replaying work", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    const failure = new Error("host ownership unknown");
    const freshHandle = new FakeHandle([]);
    const retireLocalRuntime = vi.fn(async () => {
      expect(runtime.actor.closed).toBe(true);
      vi.mocked(current.driver.attach).mockResolvedValue(freshHandle as unknown as ConversationHandle);
    });
    await expect(current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId], async () => { throw failure; }, retireLocalRuntime)).rejects.toBe(failure);
    expect(runtime.actor.closed).toBe(true);
    expect(retireLocalRuntime).toHaveBeenCalledOnce();
    expect(current.driver.attach).toHaveBeenCalledOnce();
    const replacement = await current.coordinator.acquire(scope, binding.applicationThreadId);
    expect(replacement.actor).not.toBe(runtime.actor);
    expect(current.driver.attach).toHaveBeenCalledTimes(2);
    expect(current.handle.submit).not.toHaveBeenCalled();
    expect(freshHandle.submit).not.toHaveBeenCalled();
    replacement.release();
    runtime.release();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("retains cleanup fences if local module retirement fails after a refused host Stop", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    await expect(current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId],
      async () => { throw new Error("host command rejected"); }, async () => { throw new Error("local module still owns resources"); }))
      .rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    await expect(current.coordinator.acquire(scope, binding.applicationThreadId)).rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    await expect(current.manager.acquire(current.target)).rejects.toThrow("Conversation actor retirement could not be proven.");
    runtime.release();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("lets host Stop release an in-flight actor establishment before removing the backend", async () => {
    const current = detachFixture();
    let releaseAttachment!: () => void;
    const attachment = new Promise<void>(resolve => { releaseAttachment = resolve; });
    vi.mocked(current.driver.attach).mockImplementation(async () => {
      await attachment;
      return current.handle as unknown as ConversationHandle;
    });
    const acquiring = current.coordinator.acquire(scope, binding.applicationThreadId);
    const rejected = expect(acquiring).rejects.toThrow();
    await vi.waitFor(() => expect(current.driver.attach).toHaveBeenCalledOnce());
    const stopOwnedResources = vi.fn(async () => { releaseAttachment(); });
    const operation = vi.fn(async () => undefined);
    await current.coordinator.runWithRuntimesStopped(scope, [binding.applicationThreadId], stopOwnedResources, operation);
    await rejected;
    expect(current.handle.close).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    expect(await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId)).toBeUndefined();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("checks active turn evidence after coordinator cleanup at the actual actor close", async () => {
    const current = detachFixture(async () => {
      current.handle.emit(0, {
        type: "turn_started",
        turn: { backendTurnId: "new-turn", status: "in_progress", orderedBackendItemIds: [] },
      });
      current.handle.emit(0, {
        type: "run_state_changed", state: "running", activeBackendTurnId: "new-turn",
      }, 1);
    });
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    runtime.release();
    const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
    const operation = vi.fn(async () => undefined);
    await expect(current.coordinator.runWithRuntimeDetached(
      scope, binding.applicationThreadId, expected, operation,
    )).rejects.toBeInstanceOf(ThreadRuntimeMaintenanceStaleError);
    expect(operation).not.toHaveBeenCalled();
    expect(current.handle.close).not.toHaveBeenCalled();
    await current.coordinator.close();
    await current.manager.close();
  });

  it.each(["generation", "activeTurnId"] as const)("rejects stale %s evidence before detaching coordinator bindings", async (field) => {
    const cleanup = vi.fn(async () => undefined);
    const current = detachFixture(cleanup);
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    runtime.release();
    const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
    const operation = vi.fn(async () => undefined);
    await expect(current.coordinator.runWithRuntimeDetached(
      scope, binding.applicationThreadId, { ...expected!, [field]: "stale" }, operation,
    )).rejects.toBeInstanceOf(ThreadRuntimeMaintenanceStaleError);
    expect(operation).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(current.handle.close).not.toHaveBeenCalled();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("keeps a subscribed presentation resident without borrowing execution or blocking explicit detach", async () => {
    vi.useFakeTimers();
    const current = detachFixture();
    current.handle.establishmentSnapshots[0] = snapshot("idle");
    try {
      const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
      const stream = runtime.hub.subscribe(() => undefined);
      runtime.release();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(current.handle.close).not.toHaveBeenCalled();
      expect(runtime.hub.subscriberCount).toBe(1);
      const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
      const operation = vi.fn(async () => undefined);
      await current.coordinator.runWithRuntimeDetached(scope, binding.applicationThreadId, expected, operation);
      expect(operation).toHaveBeenCalledOnce();
      expect(current.handle.close).toHaveBeenCalledOnce();
      stream.close();
    } finally {
      await current.coordinator.close();
      await current.manager.close();
      vi.useRealTimers();
    }
  });

  it.each(["coordinator", "direct"] as const)("refuses explicit detach while a %s borrower holds the actor", async (borrower) => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    const direct = borrower === "direct" ? await current.manager.acquire(current.target) : undefined;
    if (direct) runtime.release();
    const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
    const operation = vi.fn(async () => undefined);
    await expect(current.coordinator.runWithRuntimeDetached(
      scope, binding.applicationThreadId, expected, operation,
    )).rejects.toBeInstanceOf(ThreadRuntimeNotIdleError);
    expect(operation).not.toHaveBeenCalled();
    expect(current.handle.close).not.toHaveBeenCalled();
    direct?.release();
    runtime.release();
    await current.coordinator.close();
    await current.manager.close();
  });

  it("retains both rejected fences when explicit detach cannot prove handle cleanup", async () => {
    const current = detachFixture();
    const runtime = await current.coordinator.acquire(scope, binding.applicationThreadId);
    runtime.release();
    const expected = await current.coordinator.captureLoadedRuntime(scope, binding.applicationThreadId);
    current.handle.close.mockRejectedValue(new Error("remote_detach_unproven"));
    const operation = vi.fn(async () => undefined);
    await expect(current.coordinator.runWithRuntimeDetached(
      scope, binding.applicationThreadId, expected, operation,
    )).rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    expect(operation).not.toHaveBeenCalled();
    await expect(current.coordinator.acquire(scope, binding.applicationThreadId))
      .rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    await expect(current.manager.acquire(current.target))
      .rejects.toMatchObject({ name: "ConversationActorRetirementUnprovenError" });
    expect(current.driver.attach).toHaveBeenCalledOnce();
    await current.coordinator.close();
    await expect(current.manager.close()).rejects.toBeInstanceOf(AggregateError);
  });

  it("persists original structured input before submitting one common Task text block", async () => {
    const prepare = vi.fn();
    const deliveryInputSnapshots = {
      prepare,
      find: vi.fn(() => undefined),
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const task = {
      id: "8af900ae-8495-48f7-9d3f-9e322892ada1",
      scope: { kind: "global" as const },
      title: "Fix history",
      details: "Keep the submitted image visible.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 3,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T11:00:00.000Z",
    };

    await acquired.actor.submit({
      applicationOperationId: "operation-common-task",
      mutationId: "mutation-common-task",
      source: { kind: "user" },
      reconciliationToken: "reconciliation-common-task",
      text: "Please do this",
      contextExcerpts: [],
      taskContexts: [task],
      attachments: [],
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      expect.objectContaining({
        applicationOperationId: "operation-common-task",
        text: "Please do this",
        selectedSkillId: null,
        taskContexts: [task],
        attachments: [],
      }),
    );
    const submitted = handle.submit.mock.calls[0]?.[0];
    expect(submitted?.taskContexts).toEqual([]);
    expect(submitted?.text).toContain("Sedes Tasks selected for this message:");
    expect(submitted?.text).toMatch(/\n\nPlease do this$/u);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      handle.submit.mock.invocationCallOrder[0]!,
    );

    acquired.release();
    await manager.close();
  });

  it("persists callback origin but never exposes it to the backend", async () => {
    const prepare = vi.fn();
    const deliveryInputSnapshots = {
      prepare,
      find: vi.fn(() => undefined),
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const inputOrigin = {
      kind: "agent_result" as const,
      callbackId: "54aa581b-1ca0-4bc9-9249-a528dfe0118b",
      sourceThreadId: "worker-thread",
      sourceThreadLabel: { text: "Worker" },
    };

    await acquired.actor.submit({
      applicationOperationId: "callback-operation",
      mutationId: "callback-operation",
      source: { kind: "user" },
      reconciliationToken: "callback-operation",
      text: "Agent result from Worker (completed):\n\nDone",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
      inputOrigin,
    });

    expect(prepare).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      expect.objectContaining({ origin: inputOrigin }),
    );
    expect(handle.submit).toHaveBeenCalledWith(
      expect.not.objectContaining({ inputOrigin: expect.anything() }),
    );

    acquired.release();
    await manager.close();
  });

  it("persists and commonly renders structured Task input before Steer", async () => {
    const prepare = vi.fn();
    const deliveryInputSnapshots = {
      prepare,
      find: vi.fn(() => undefined),
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    handle.establishmentSnapshots[0] = snapshot("running");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const task = {
      id: "8af900ae-8495-48f7-9d3f-9e322892ada1",
      scope: { kind: "global" as const },
      title: "Steer work",
      details: "Apply while running.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 1,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T11:00:00.000Z",
    };

    await acquired.actor.steer({
      applicationOperationId: "operation-common-steer",
      mutationId: "mutation-common-steer",
      reconciliationToken: "reconciliation-common-steer",
      target: { kind: "turn", turnId: acquired.actor.timeline.activeTurnId! },
      text: "Continue with this",
      contextExcerpts: [],
      taskContexts: [task],
      attachments: [],
    });

    expect(prepare).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      expect.objectContaining({
        applicationOperationId: "operation-common-steer",
        text: "Continue with this",
        taskContexts: [task],
      }),
    );
    const steered = handle.steer.mock.calls[0]?.[0];
    expect(steered?.taskContexts).toEqual([]);
    expect(steered?.text).toContain("Sedes Tasks selected for this message:");
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      handle.steer.mock.invocationCallOrder[0]!,
    );

    acquired.release();
    await manager.close();
  });

  it("fails snapshot preparation before crossing the provider boundary", async () => {
    const remove = vi.fn(() => true);
    const deliveryInputSnapshots = {
      prepare: vi.fn(() => {
        throw new Error("database unavailable");
      }),
      find: vi.fn(() => undefined),
      remove,
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    const failure = await acquired.actor
      .submit({
        applicationOperationId: "operation-prepare-failure",
        mutationId: "mutation-prepare-failure",
        source: { kind: "user" },
        reconciliationToken: "reconciliation-prepare-failure",
        text: "Hello",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackendError);
    expect(failure).toMatchObject({
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage: "The application delivery input could not be prepared.",
    });
    expect(handle.submit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("removes a prepared snapshot after a pre-boundary backend rejection", async () => {
    const remove = vi.fn(() => true);
    const deliveryInputSnapshots = {
      prepare: vi.fn(),
      find: vi.fn(() => undefined),
      remove,
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    handle.submit.mockRejectedValueOnce(
      new BackendError({
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "The provider rejected the input before delivery.",
      }),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.submit({
        applicationOperationId: "pre-boundary-rejection",
        mutationId: "pre-boundary-rejection",
        source: { kind: "user" },
        reconciliationToken: "pre-boundary-rejection",
        text: "Hello",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      }),
    ).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      "pre-boundary-rejection",
    );

    acquired.release();
    await manager.close();
  });

  it("preserves a Steer rejection when snapshot cleanup fails", async () => {
    const remove = vi.fn(() => {
      throw new Error("snapshot delete failed");
    });
    const deliveryInputSnapshots = {
      prepare: vi.fn(),
      find: vi.fn(() => undefined),
      remove,
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const rejection = new BackendError({
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage: "The targeted turn is no longer active.",
      backendCode: "test_steer_target_unavailable",
      steerRejectionReason: "target_no_longer_active",
    });
    handle.steer.mockRejectedValueOnce(rejection);
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const activeTurnId = acquired.actor.timeline.activeTurnId;
    if (!activeTurnId) throw new Error("missing active turn");

    const failure = await acquired.actor
      .steer({
        applicationOperationId: "cleanup-failed-steer",
        mutationId: "cleanup-failed-steer",
        reconciliationToken: "cleanup-failed-steer",
        target: { kind: "turn", turnId: activeTurnId },
        text: "Continue",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      })
      .catch((error: unknown) => error);

    expect(failure).toBe(rejection);
    expect(failure).toMatchObject({
      retryable: false,
      steerRejectionReason: "target_no_longer_active",
    });
    expect(remove).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      "cleanup-failed-steer",
    );

    acquired.release();
    await manager.close();
  });

  it("replaces an actor that was closed outside manager eviction", async () => {
    const { driver, manager } = fixture();
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    };
    const first = await manager.acquire(input, { idleRelease: "evict" });
    const closed = vi.fn();
    first.actor.onClosed(closed);

    await first.actor.close();
    expect(closed).toHaveBeenCalledOnce();
    first.release();
    const second = await manager.acquire(input, { idleRelease: "evict" });

    expect(second.actor).not.toBe(first.actor);
    expect(driver.attach).toHaveBeenCalledTimes(2);
    second.release();
    await manager.close();
  });

  it("replaces a provider-fenced handle instead of returning it from the actor cache", async () => {
    const { closeOrder, driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    };
    const first = await manager.acquire(input, { idleRelease: "retain" });
    const replacementHandle = new FakeHandle(closeOrder);
    vi.mocked(driver.attach).mockResolvedValueOnce(
      replacementHandle as unknown as ConversationHandle,
    );

    handle.emit(0, {
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    await vi.waitFor(() => expect(first.actor.replacementRequired).toBe(true));
    expect(first.actor.canEvict).toBe(true);

    const reopened = await manager.acquire(input, { idleRelease: "retain" });
    expect(reopened.actor).not.toBe(first.actor);
    expect(driver.attach).toHaveBeenCalledTimes(2);
    expect(handle.establishCount).toBe(1);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(replacementHandle.establishCount).toBe(1);

    first.release();
    reopened.release();
    await manager.close();
  });

  it("aborts deferred projection capture and replaces a closed provider handle", async () => {
    const { closeOrder, driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    };
    const first = await manager.acquire(input, { idleRelease: "retain" });
    let replacementStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    let replacementSignal: AbortSignal | undefined;
    vi.spyOn(handle, "establishProjection").mockImplementationOnce(
      async (establishmentInput) => {
        replacementSignal = establishmentInput.signal;
        replacementStarted();
        return await new Promise<EstablishedBackendProjection>(
          (_resolve, reject) => {
            const abort = () => reject(establishmentInput.signal.reason);
            if (establishmentInput.signal.aborted) abort();
            else {
              establishmentInput.signal.addEventListener("abort", abort, {
                once: true,
              });
            }
          },
        );
      },
    );

    handle.emit(0, {
      type: "resnapshot_required",
      reason: "contradictory_state",
    });
    await started;
    expect(handle.establishmentListeners[0]).toBeUndefined();
    expect(handle.rawListeners.size).toBe(1);

    handle.emit(0, {
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    expect(first.actor.replacementRequired).toBe(true);
    expect(replacementSignal?.aborted).toBe(true);

    const replacementHandle = new FakeHandle(closeOrder);
    vi.mocked(driver.attach).mockResolvedValueOnce(
      replacementHandle as unknown as ConversationHandle,
    );
    const reopened = await manager.acquire(input, { idleRelease: "retain" });

    expect(reopened.actor).not.toBe(first.actor);
    expect(driver.attach).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(replacementHandle.establishCount).toBe(1);

    first.release();
    reopened.release();
    await manager.close();
  });

  it("accepts zero retention and rejects values beyond the timer ceiling", () => {
    expect(() => fixture(undefined, undefined, 0)).not.toThrow();
    expect(() => fixture(undefined, undefined, 2_147_483_647)).not.toThrow();
    expect(() => fixture(undefined, undefined, 2_147_483_648)).toThrow(
      "conversation_retention_milliseconds_invalid",
    );
  });

  it("accepts the runtime budget bounds and rejects values outside them", () => {
    expect(() => fixture(undefined, undefined, 10, undefined, 2)).not.toThrow();
    expect(() =>
      fixture(undefined, undefined, 10, undefined, 64),
    ).not.toThrow();
    expect(() => fixture(undefined, undefined, 10, undefined, 1)).toThrow(
      "conversation_runtime_budget_invalid",
    );
    expect(() => fixture(undefined, undefined, 10, undefined, 65)).toThrow(
      "conversation_runtime_budget_invalid",
    );
  });

  it("applies the runtime budget independently to each execution environment", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const handles = [
      current.handle,
      new FakeHandle([]),
      new FakeHandle([]),
      new FakeHandle([]),
      new FakeHandle([]),
      new FakeHandle([]),
    ];
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(handles[0] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[1] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[2] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[3] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[4] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[5] as unknown as ConversationHandle);
    const target = (
      threadId: string,
      executionEnvironmentId: string,
    ): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        executionEnvironmentId,
        backendConversationId: `native-${threadId}`,
      },
      workspace: {
        ...workspace,
        canonicalPath: `/workspace-${executionEnvironmentId}`,
        summary: {
          ...workspace.summary,
          id: `workspace-${executionEnvironmentId}`,
          environmentId: executionEnvironmentId,
        },
      },
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });

    const local = await Promise.all([
      current.manager.acquire(target("thread-local-1", "environment-local")),
      current.manager.acquire(target("thread-local-2", "environment-local")),
    ]);
    const remoteOne = await Promise.all([
      current.manager.acquire(target("thread-remote-1-1", "environment-ssh-1")),
      current.manager.acquire(target("thread-remote-1-2", "environment-ssh-1")),
    ]);
    const remoteTwo = await Promise.all([
      current.manager.acquire(target("thread-remote-2-1", "environment-ssh-2")),
      current.manager.acquire(target("thread-remote-2-2", "environment-ssh-2")),
    ]);

    await expect(
      current.manager.acquire(target("thread-local-3", "environment-local")),
    ).rejects.toMatchObject({
      category: "overloaded",
      backendCode: "conversation_runtime_budget_reached",
    });
    expect(current.driver.attach).toHaveBeenCalledTimes(6);
    for (const acquired of [...local, ...remoteOne, ...remoteTwo]) {
      acquired.release();
    }
    await current.manager.close();
  });

  it("keeps equal environment IDs isolated across principal ownership scopes", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const handles = [current.handle, new FakeHandle([]), new FakeHandle([])];
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(handles[0] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[1] as unknown as ConversationHandle)
      .mockResolvedValueOnce(handles[2] as unknown as ConversationHandle);
    const target = (
      threadId: string,
      principalId: string,
    ): AcquireConversationActorInput => {
      const targetScope = { ...scope, principalId };
      return {
        scope: targetScope,
        binding: {
          ...binding,
          ownerPrincipalId: principalId,
          applicationThreadId: threadId,
          executionEnvironmentId: "shared-environment-id",
          backendConversationId: `native-${threadId}`,
        },
        workspace: {
          ...workspace,
          summary: {
            ...workspace.summary,
            id: "shared-workspace-id",
            environmentId: "shared-environment-id",
          },
        },
        opaqueBindingDetail: `opaque-${threadId}`,
        driver: current.driver,
      };
    };

    const firstPrincipal = await Promise.all([
      current.manager.acquire(target("thread-principal-a-1", "principal-a")),
      current.manager.acquire(target("thread-principal-a-2", "principal-a")),
    ]);
    const otherPrincipal = await current.manager.acquire(
      target("thread-principal-b-1", "principal-b"),
    );

    await expect(
      current.manager.acquire(target("thread-principal-a-3", "principal-a")),
    ).rejects.toMatchObject({
      category: "overloaded",
      backendCode: "conversation_runtime_budget_reached",
    });
    expect(current.driver.attach).toHaveBeenCalledTimes(3);

    for (const acquired of firstPrincipal) acquired.release();
    otherPrincipal.release();
    await current.manager.close();
  });

  it("never evicts an older idle runtime from another execution environment", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture(undefined, undefined, 60_000, undefined, 2);
      const environmentBOldest = current.handle;
      const environmentAOldest = new FakeHandle([]);
      const environmentANewer = new FakeHandle([]);
      const environmentAAdmitted = new FakeHandle([]);
      vi.mocked(current.driver.attach)
        .mockResolvedValueOnce(
          environmentBOldest as unknown as ConversationHandle,
        )
        .mockResolvedValueOnce(
          environmentAOldest as unknown as ConversationHandle,
        )
        .mockResolvedValueOnce(
          environmentANewer as unknown as ConversationHandle,
        )
        .mockResolvedValueOnce(
          environmentAAdmitted as unknown as ConversationHandle,
        );
      const target = (
        threadId: string,
        executionEnvironmentId: string,
      ): AcquireConversationActorInput => ({
        scope,
        binding: {
          ...binding,
          applicationThreadId: threadId,
          executionEnvironmentId,
          backendConversationId: `native-${threadId}`,
        },
        workspace: {
          ...workspace,
          canonicalPath: `/workspace-${executionEnvironmentId}`,
          summary: {
            ...workspace.summary,
            id: `workspace-${executionEnvironmentId}`,
            environmentId: executionEnvironmentId,
          },
        },
        opaqueBindingDetail: `opaque-${threadId}`,
        driver: current.driver,
      });

      const oldestElsewhere = await current.manager.acquire(
        target("thread-b-oldest", "environment-b"),
      );
      oldestElsewhere.release();
      await vi.advanceTimersByTimeAsync(1);
      const oldestEligible = await current.manager.acquire(
        target("thread-a-oldest", "environment-a"),
      );
      oldestEligible.release();
      await vi.advanceTimersByTimeAsync(1);
      const newerEligible = await current.manager.acquire(
        target("thread-a-newer", "environment-a"),
      );
      newerEligible.release();

      const admitted = await current.manager.acquire(
        target("thread-a-admitted", "environment-a"),
      );
      expect(environmentBOldest.close).not.toHaveBeenCalled();
      expect(environmentAOldest.close).toHaveBeenCalledOnce();
      expect(environmentANewer.close).not.toHaveBeenCalled();

      admitted.release();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest retained idle actor before admitting another runtime", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture(undefined, undefined, 60_000, undefined, 2);
      const secondHandle = new FakeHandle([]);
      const thirdHandle = new FakeHandle([]);
      vi.mocked(current.driver.attach)
        .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
        .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
        .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
      const input = (threadId: string): AcquireConversationActorInput => ({
        scope,
        binding: {
          ...binding,
          applicationThreadId: threadId,
          backendConversationId: `native-${threadId}`,
        },
        workspace,
        opaqueBindingDetail: `opaque-${threadId}`,
        driver: current.driver,
      });

      const first = await current.manager.acquire(input("thread-1"));
      first.release();
      await vi.advanceTimersByTimeAsync(1);
      const second = await current.manager.acquire(input("thread-2"));
      second.release();

      const third = await current.manager.acquire(input("thread-3"));
      expect(current.handle.close).toHaveBeenCalledOnce();
      expect(secondHandle.close).not.toHaveBeenCalled();
      expect(current.driver.attach).toHaveBeenCalledTimes(3);

      third.release();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects generically only when every runtime slot is borrowed", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const secondHandle = new FakeHandle([]);
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
      .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle);
    const input = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const first = await current.manager.acquire(input("thread-1"));
    const second = await current.manager.acquire(input("thread-2"));

    await expect(
      current.manager.acquire(input("thread-3")),
    ).rejects.toMatchObject({
      category: "overloaded",
      retryable: true,
      backendCode: "conversation_runtime_budget_reached",
    });
    expect(current.driver.attach).toHaveBeenCalledTimes(2);

    first.release();
    second.release();
    await current.manager.close();
  });

  it("reclaims the oldest idle coordinator-owned runtime under pressure", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture(undefined, undefined, 60_000, undefined, 2);
      const secondHandle = new FakeHandle([]);
      const thirdHandle = new FakeHandle([]);
      vi.mocked(current.driver.attach)
        .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
        .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
        .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
      const bridgeReleases = [
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ];
      let bridgeIndex = 0;
      const coordinator = new ThreadRuntimeCoordinator({
        actors: current.actorManager,
        targets: {
          resolve: vi.fn(async (_scope, threadId) => ({
            scope,
            binding: {
              ...binding,
              applicationThreadId: threadId,
              backendConversationId: `native-${threadId}`,
            },
            workspace,
            opaqueBindingDetail: `opaque-${threadId}`,
            driver: current.driver,
          })),
        },
        bridge: {
          bind: () => ({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: bridgeReleases[bridgeIndex++]!,
          }),
        } as unknown as ConversationEventBridge,
        interactions: {
          bind: () => ({
            publishPending: vi.fn(),
            release: vi.fn(async () => undefined),
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 60_000,
      });
      current.actorManager.bindPressureReclaimer((request) =>
        coordinator.tryReclaimOldestIdleRuntime(request),
      );

      const first = await coordinator.acquire(scope, "thread-1");
      first.release();
      await vi.advanceTimersByTimeAsync(1);
      const second = await coordinator.acquire(scope, "thread-2");
      second.release();
      const third = await coordinator.acquire(scope, "thread-3");

      expect(current.handle.close).toHaveBeenCalledOnce();
      expect(secondHandle.close).not.toHaveBeenCalled();
      expect(bridgeReleases[0]).toHaveBeenCalledOnce();
      expect(current.driver.attach).toHaveBeenCalledTimes(3);

      third.release();
      await coordinator.close();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pressure-close a coordinator actor held by a direct borrower", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const secondHandle = new FakeHandle([]);
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
      .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle);
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const bridgeRelease = vi.fn(async () => undefined);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async (_scope, threadId) => target(threadId)) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: bridgeRelease,
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    current.actorManager.bindPressureReclaimer((request) =>
      coordinator.tryReclaimOldestIdleRuntime(request),
    );

    const coordinatorOwner = await coordinator.acquire(scope, "thread-shared");
    coordinatorOwner.release();
    const directBorrower = await current.manager.acquire(
      target("thread-shared"),
    );
    const otherBorrower = await current.manager.acquire(target("thread-other"));

    await expect(
      current.manager.acquire(target("thread-blocked")),
    ).rejects.toMatchObject({
      category: "overloaded",
      backendCode: "conversation_runtime_budget_reached",
    });
    expect(bridgeRelease).toHaveBeenCalledOnce();
    expect(current.handle.close).not.toHaveBeenCalled();
    await expect(
      directBorrower.actor.ensureProjectionCurrent(),
    ).resolves.toBeUndefined();

    directBorrower.release();
    otherBorrower.release();
    await coordinator.close();
    await current.manager.close();
  });

  it("does not poison actor shutdown while a pressure owner release is in flight", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const secondHandle = new FakeHandle([]);
    const thirdHandle = new FakeHandle([]);
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
      .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
      .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    let releaseBridge!: () => void;
    const bridgeGate = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    const bridgeRelease = vi.fn(async () => bridgeGate);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async (_scope, threadId) => target(threadId)) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: bridgeRelease,
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    current.actorManager.bindPressureReclaimer((request) =>
      coordinator.tryReclaimOldestIdleRuntime(request),
    );
    const retained = await coordinator.acquire(scope, "thread-shutdown-old");
    retained.release();
    const borrowed = await current.manager.acquire(
      target("thread-shutdown-other"),
    );
    const admitting = current.manager.acquire(target("thread-shutdown-new"));
    await vi.waitFor(() => expect(bridgeRelease).toHaveBeenCalledOnce());

    await coordinator.closeForShutdown();
    releaseBridge();
    const admitted = await admitting;
    expect(current.handle.close).toHaveBeenCalledOnce();

    admitted.release();
    borrowed.release();
    await expect(current.manager.close()).resolves.toBeUndefined();
  });

  it("invalidates a direct actor admission that waited across retired maintenance", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    vi.mocked(current.driver.attach).mockResolvedValueOnce(
      current.handle as unknown as ConversationHandle,
    );
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const bridgeRelease = vi.fn(async () => undefined);
    const interactionRelease = vi.fn(async () => undefined);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async (_scope, threadId) => target(threadId)) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: bridgeRelease,
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: interactionRelease,
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    const runtime = await coordinator.acquire(scope, "thread-archive-fence");
    runtime.release();
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let operationStarted = false;
    const maintenance = coordinator.runWithRuntimeRetired(
      scope,
      "thread-archive-fence",
      async () => {
        operationStarted = true;
        await operationGate;
      },
    );
    await vi.waitFor(() => expect(operationStarted).toBe(true));

    let completed = false;
    const directReopen = current.manager
      .acquire(target("thread-archive-fence"))
      .finally(() => {
        completed = true;
      });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(current.driver.attach).toHaveBeenCalledOnce();

    releaseOperation();
    await maintenance;
    expect(bridgeRelease).toHaveBeenCalledOnce();
    expect(interactionRelease).toHaveBeenCalledOnce();
    await expect(directReopen).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "conversation_actor_admission_invalidated",
    });
    expect(completed).toBe(true);
    expect(current.driver.attach).toHaveBeenCalledOnce();

    await coordinator.close();
    await current.manager.close();
  });

  it("rejects archive retirement while a direct actor borrower is held", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async (_scope, threadId) => target(threadId)) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    const runtime = await coordinator.acquire(scope, "thread-archive-borrowed");
    runtime.release();
    const directBorrower = await current.manager.acquire(
      target("thread-archive-borrowed"),
    );
    const operation = vi.fn(async () => undefined);

    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-archive-borrowed",
        operation,
      ),
    ).rejects.toBeInstanceOf(ThreadRuntimeNotIdleError);
    expect(operation).not.toHaveBeenCalled();
    expect(current.handle.close).not.toHaveBeenCalled();
    await expect(
      directBorrower.actor.ensureProjectionCurrent(),
    ).resolves.toBeUndefined();

    directBorrower.release();
    await coordinator.close();
    await current.manager.close();
  });

  it("keeps coordinator and direct admission fenced after owner cleanup is unproven", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const cleanupFailure = new Error("bridge_cleanup_unproven");
    const coordinator = new ThreadRuntimeCoordinator({
      actors: current.actorManager,
      targets: { resolve: vi.fn(async (_scope, threadId) => target(threadId)) },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: vi.fn(async () => {
            throw cleanupFailure;
          }),
        }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    const runtime = await coordinator.acquire(scope, "thread-cleanup-unproven");
    runtime.release();
    const operation = vi.fn(async () => undefined);

    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-cleanup-unproven",
        operation,
      ),
    ).rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    expect(operation).not.toHaveBeenCalled();
    await expect(
      coordinator.acquire(scope, "thread-cleanup-unproven"),
    ).rejects.toBeInstanceOf(ThreadRuntimeRetirementUnprovenError);
    await expect(
      current.manager.acquire(target("thread-cleanup-unproven")),
    ).rejects.toMatchObject({
      name: "ConversationActorRetirementUnprovenError",
      cause: expect.any(AggregateError),
    });
    expect(current.driver.attach).toHaveBeenCalledOnce();

    await coordinator.close();
    await current.manager.close();
  });

  it("reclaims the globally oldest idle runtime across direct and coordinator ownership", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture(undefined, undefined, 60_000, undefined, 2);
      const secondHandle = new FakeHandle([]);
      const thirdHandle = new FakeHandle([]);
      vi.mocked(current.driver.attach)
        .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
        .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
        .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
      const target = (threadId: string): AcquireConversationActorInput => ({
        scope,
        binding: {
          ...binding,
          applicationThreadId: threadId,
          backendConversationId: `native-${threadId}`,
        },
        workspace,
        opaqueBindingDetail: `opaque-${threadId}`,
        driver: current.driver,
      });
      const bridgeRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: current.actorManager,
        targets: {
          resolve: vi.fn(async (_scope, threadId) => target(threadId)),
        },
        bridge: {
          bind: () => ({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: bridgeRelease,
          }),
        } as unknown as ConversationEventBridge,
        interactions: {
          bind: () => ({
            publishPending: vi.fn(),
            release: vi.fn(async () => undefined),
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 60_000,
      });
      current.actorManager.bindPressureReclaimer((request) =>
        coordinator.tryReclaimOldestIdleRuntime(request),
      );

      const oldest = await current.manager.acquire(target("thread-direct-old"));
      oldest.release();
      await vi.advanceTimersByTimeAsync(1);
      const newer = await coordinator.acquire(scope, "thread-coordinator-new");
      newer.release();
      const admitted = await current.manager.acquire(target("thread-third"));

      expect(current.handle.close).toHaveBeenCalledOnce();
      expect(secondHandle.close).not.toHaveBeenCalled();
      expect(bridgeRelease).not.toHaveBeenCalled();

      admitted.release();
      await coordinator.close();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims an older coordinator runtime before a newer direct actor", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture(undefined, undefined, 60_000, undefined, 2);
      const secondHandle = new FakeHandle([]);
      const thirdHandle = new FakeHandle([]);
      vi.mocked(current.driver.attach)
        .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
        .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
        .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
      const target = (threadId: string): AcquireConversationActorInput => ({
        scope,
        binding: {
          ...binding,
          applicationThreadId: threadId,
          backendConversationId: `native-${threadId}`,
        },
        workspace,
        opaqueBindingDetail: `opaque-${threadId}`,
        driver: current.driver,
      });
      const bridgeRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: current.actorManager,
        targets: {
          resolve: vi.fn(async (_scope, threadId) => target(threadId)),
        },
        bridge: {
          bind: () => ({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: bridgeRelease,
          }),
        } as unknown as ConversationEventBridge,
        interactions: {
          bind: () => ({
            publishPending: vi.fn(),
            release: vi.fn(async () => undefined),
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 60_000,
      });
      current.actorManager.bindPressureReclaimer((request) =>
        coordinator.tryReclaimOldestIdleRuntime(request),
      );

      const oldest = await coordinator.acquire(scope, "thread-coordinator-old");
      oldest.release();
      await vi.advanceTimersByTimeAsync(1);
      const newer = await current.manager.acquire(target("thread-direct-new"));
      newer.release();
      const admitted = await current.manager.acquire(
        target("thread-third-new"),
      );

      expect(current.handle.close).toHaveBeenCalledOnce();
      expect(secondHandle.close).not.toHaveBeenCalled();
      expect(bridgeRelease).toHaveBeenCalledOnce();

      admitted.release();
      await coordinator.close();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries admission after a pressure victim becomes busy without poisoning it", async () => {
    const current = fixture(undefined, undefined, 60_000, undefined, 2);
    const secondHandle = new FakeHandle([]);
    const thirdHandle = new FakeHandle([]);
    vi.mocked(current.driver.attach)
      .mockResolvedValueOnce(current.handle as unknown as ConversationHandle)
      .mockResolvedValueOnce(secondHandle as unknown as ConversationHandle)
      .mockResolvedValueOnce(thirdHandle as unknown as ConversationHandle);
    const target = (threadId: string): AcquireConversationActorInput => ({
      scope,
      binding: {
        ...binding,
        applicationThreadId: threadId,
        backendConversationId: `native-${threadId}`,
      },
      workspace,
      opaqueBindingDetail: `opaque-${threadId}`,
      driver: current.driver,
    });
    const first = await current.manager.acquire(target("thread-race-first"));
    first.release();
    const second = await current.manager.acquire(target("thread-race-second"));
    second.release();
    let reclaimCalls = 0;
    current.actorManager.bindPressureReclaimer(({ olderThan }) => {
      reclaimCalls += 1;
      if (reclaimCalls !== 1 || !olderThan) return undefined;
      return {
        actorKey: olderThan.actorKey,
        completion: Promise.reject(
          new ConversationRuntimeReclamationRaceError(),
        ),
      };
    });

    const third = await current.manager.acquire(target("thread-race-third"));
    expect(reclaimCalls).toBe(2);
    expect(current.handle.close).toHaveBeenCalledOnce();
    expect(current.driver.attach).toHaveBeenCalledTimes(3);

    third.release();
    await current.manager.close();
  });

  it("starts retained eviction only after an unowned actor becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const { driver, handle, manager } = fixture();
      handle.establishmentSnapshots[0] = snapshot("running", "a");
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      acquired.release();

      await vi.advanceTimersByTimeAsync(100);
      expect(handle.close).not.toHaveBeenCalled();

      const terminalItem = snapshot("running", "a").itemsById["item-1"]!;
      handle.emit(0, {
        type: "item_completed",
        item: { ...terminalItem, status: "completed" },
      });
      handle.emit(
        0,
        {
          type: "turn_completed",
          turn: {
            backendTurnId: "turn-1",
            completionCorrelations: [],
            status: "completed",
            endedBy: "agent_settled",
            completedAt: "2026-07-30T12:00:00.000Z",
            orderedBackendItemIds: ["item-1"],
          },
        },
        1,
      );
      handle.emit(0, { type: "run_state_changed", state: "idle" }, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(acquired.actor.canEvict).toBe(true);
      await vi.advanceTimersByTimeAsync(9);
      expect(handle.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(handle.close).toHaveBeenCalledOnce();
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh an idle deadline for a passive retained borrow", async () => {
    vi.useFakeTimers();
    try {
      const { driver, handle, manager } = fixture();
      const input = {
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      };
      const first = await manager.acquire(input);
      first.release();
      await vi.advanceTimersByTimeAsync(9);

      const passive = await manager.acquire(input);
      passive.release();
      await vi.advanceTimersByTimeAsync(1);

      expect(handle.close).toHaveBeenCalledOnce();
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one coordinator retention deadline without a second actor grace", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const target: AcquireConversationActorInput = {
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver: current.driver,
      };
      const bridgeRelease = vi.fn(async () => undefined);
      const interactionRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: current.manager,
        targets: { resolve: vi.fn(async () => target) },
        bridge: {
          bind: () => ({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: bridgeRelease,
          }),
        } as unknown as ConversationEventBridge,
        interactions: {
          bind: () => ({
            publishPending: vi.fn(),
            release: interactionRelease,
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 10,
      });

      const first = await coordinator.acquire(
        scope,
        binding.applicationThreadId,
      );
      const retainedHub = first.hub;
      first.release();
      await vi.advanceTimersByTimeAsync(9);
      expect(current.handle.close).not.toHaveBeenCalled();

      const resumed = await coordinator.acquire(
        scope,
        binding.applicationThreadId,
      );
      expect(resumed.hub).toBe(retainedHub);
      expect(current.driver.attach).toHaveBeenCalledOnce();
      resumed.release();
      await vi.advanceTimersByTimeAsync(9);
      expect(current.handle.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(current.handle.close).toHaveBeenCalledOnce(),
      );

      expect(bridgeRelease).toHaveBeenCalledOnce();
      expect(interactionRelease).toHaveBeenCalledOnce();
      expect(current.lease.release).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(current.handle.close).toHaveBeenCalledOnce();
      await coordinator.close();
      await current.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches and resolves branches with the lease-returned workspace authority", async () => {
    const current = fixture();
    const leasedWorkspace: ValidatedWorkspace = {
      ...workspace,
      authorityRevision: 4,
    };
    vi.mocked(current.environments.acquireLease).mockResolvedValueOnce({
      ...current.lease,
      workspace: leasedWorkspace,
    });
    current.handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["latest_completed"]),
    );
    const acquired = await current.manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver: current.driver,
    });

    expect(current.driver.attach).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: leasedWorkspace }),
    );
    await acquired.actor.resolveBranchCheckpoint({
      kind: "latest_completed",
    });
    expect(current.driver.resolveBranchCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: leasedWorkspace }),
    );
    acquired.release();
    await current.manager.close();
  });

  it("holds turn starts behind an idle application critical section", async () => {
    const { driver, handle, manager } = fixture();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    let finish!: () => void;
    const section = acquired.actor.runIfIdle(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("updated");
        }),
    );
    const submitting = acquired.actor.submit({
      applicationOperationId: "submit-after-policy",
      source: { kind: "user" },
      mutationId: "submit-after-policy",
      reconciliationToken: "submit-after-policy",
      text: "Start after the policy write",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });

    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(handle.submit).not.toHaveBeenCalled();
    finish();
    await expect(section).resolves.toEqual({
      executed: true,
      value: "updated",
    });
    await expect(submitting).resolves.toMatchObject({ accepted: true });
    expect(handle.submit).toHaveBeenCalledOnce();

    acquired.release();
    await manager.close();
  });

  it("does not enter an application critical section during an active turn", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const operation = vi.fn(() => "updated");

    await expect(acquired.actor.runIfIdle(operation)).resolves.toEqual({
      executed: false,
    });
    expect(operation).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("resolves a normalized completed turn to a selected backend checkpoint", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce({
      revision: "branching",
      actions: [],
      deliveryModes: ["submit"],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "available",
        boundaries: ["selected_completed_turn"],
        method: "provider_native",
        sourceMustBeIdle: true,
        settingsInheritance: "application_applied",
        fidelity: {
          instructions: false,
          messages: true,
          toolCalls: true,
          toolResults: true,
          compaction: true,
          attachments: true,
          settings: true,
          limitations: [],
        },
        childIdentity: "application_reserved",
        creationRecovery: "idempotent",
      },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "low",
        toolAccess: "read_only",
      },
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const sourceTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: sourceTurnId,
        expectedTurnRevision: 0,
      }),
    ).resolves.toMatchObject({
      sourceTurnId,
      backendTurnId: "turn-1",
      effectiveSettings: {
        model: { provider: "test", id: "model" },
        toolAccess: "read_only",
      },
    });
    expect(driver.resolveBranchCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: "turn-1",
          boundary: "completed_turn_inclusive",
        },
      }),
    );
    acquired.release();
    await manager.close();
  });

  it("resolves an explicit latest-completed checkpoint selection", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities([
        "latest_completed",
        "selected_completed_turn",
      ]),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const sourceTurnId = acquired.actor.timeline.orderedTurnIds[0]!;

    await expect(
      acquired.actor.resolveBranchCheckpoint({ kind: "latest_completed" }),
    ).resolves.toMatchObject({
      sourceTurnId,
      backendTurnId: "turn-1",
    });
    expect(driver.resolveBranchCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { kind: "latest_completed" } }),
    );

    acquired.release();
    await manager.close();
  });

  it("resolves the latest provider snapshot while active without changing selected-turn semantics", async () => {
    const activeSnapshot: BackendConversationSnapshot = {
      orderedBackendTurnIds: ["turn-1", "turn-2"],
      turnsById: {
        "turn-1": snapshot().turnsById["turn-1"]!,
        "turn-2": {
          backendTurnId: "turn-2",
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      },
      itemsById: { "item-1": snapshot().itemsById["item-1"]! },
      runState: "running",
      activeBackendTurnId: "turn-2",
    };
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = activeSnapshot;
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(
        ["latest_provider_snapshot", "selected_completed_turn"],
        false,
      ),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "latest_provider_snapshot",
      }),
    ).resolves.toMatchObject({
      boundaryKind: "provider_snapshot_at_acceptance",
      sourceTurnId: null,
      sourceTurnCompletedAt: null,
      backendTurnId: null,
    });
    expect(driver.resolveBranchCheckpoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        selection: { kind: "latest_provider_snapshot" },
      }),
    );

    const completedTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
    const completedTurn = acquired.actor.timeline.turnsById[completedTurnId]!;
    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: completedTurnId,
        expectedTurnRevision: completedTurn.revision,
      }),
    ).resolves.toMatchObject({
      boundaryKind: "completed_turn_inclusive",
      sourceTurnId: completedTurnId,
      backendTurnId: "turn-1",
    });
    expect(driver.resolveBranchCheckpoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: "turn-1",
          boundary: "completed_turn_inclusive",
        },
      }),
    );

    acquired.release();
    await manager.close();
  });

  it("rejects the latest provider snapshot when the backend does not advertise it", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["selected_completed_turn"], false),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "latest_provider_snapshot",
      }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: false });
    expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it.each(["reconciling", "disconnected", "failed"] as const)(
    "rejects the latest provider snapshot while the source is %s",
    async (runState) => {
      const { driver, handle, manager } = fixture();
      handle.establishmentSnapshots[0] = {
        ...snapshot(),
        runState,
      };
      handle.backendCapabilities.mockResolvedValueOnce(
        selectedBranchingCapabilities(["latest_provider_snapshot"], false),
      );
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });

      await expect(
        acquired.actor.resolveBranchCheckpoint({
          kind: "latest_provider_snapshot",
        }),
      ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
      expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

      acquired.release();
      await manager.close();
    },
  );

  it("rejects an active latest provider snapshot for an idle-only backend", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running");
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["latest_provider_snapshot"], true),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "latest_provider_snapshot",
      }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
    expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it.each(["accepted", "sent_unknown"] as const)(
    "rejects the latest provider snapshot while a source submission is %s",
    async (submissionState) => {
      const { driver, handle, manager } = fixture();
      handle.backendCapabilities.mockResolvedValueOnce(
        selectedBranchingCapabilities(["latest_provider_snapshot"], false),
      );
      if (submissionState === "sent_unknown") {
        handle.submit.mockRejectedValueOnce(
          new BackendError({
            category: "overloaded",
            retryable: true,
            crossedSubmissionBoundary: true,
            safeMessage: "Submission outcome is unknown.",
          }),
        );
      }
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });

      const submission = acquired.actor.submit({
        applicationOperationId: `snapshot-${submissionState}`,
        source: { kind: "user" },
        mutationId: `snapshot-${submissionState}`,
        reconciliationToken: `snapshot-${submissionState}`,
        text: "Start source work",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
      if (submissionState === "sent_unknown") {
        await expect(submission).rejects.toMatchObject({
          crossedSubmissionBoundary: true,
        });
      } else {
        await expect(submission).resolves.toMatchObject({ accepted: true });
      }

      await expect(
        acquired.actor.resolveBranchCheckpoint({
          kind: "latest_provider_snapshot",
        }),
      ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
      expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

      acquired.release();
      await manager.close();
    },
  );

  it("allows a latest provider snapshot after accepted source work becomes authoritatively active", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["latest_provider_snapshot"], false),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await acquired.actor.submit({
      applicationOperationId: "snapshot-authoritative-active",
      source: { kind: "user" },
      mutationId: "snapshot-authoritative-active",
      reconciliationToken: "snapshot-authoritative-active",
      text: "Start source work",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    handle.emit(0, {
      type: "turn_started",
      turn: {
        backendTurnId: "turn-2",
        completionCorrelations: ["snapshot-authoritative-active"],
        status: "in_progress",
        orderedBackendItemIds: [],
      },
    });
    handle.emit(0, { type: "run_state_changed", state: "running" }, 1);
    await vi.waitFor(() =>
      expect(acquired.actor.timeline.runState).toBe("running"),
    );

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "latest_provider_snapshot",
      }),
    ).resolves.toMatchObject({
      boundaryKind: "provider_snapshot_at_acceptance",
      sourceTurnId: null,
    });

    acquired.release();
    await manager.close();
  });

  it("allows only an explicit earlier completed turn while an active-source backend supports it", async () => {
    const activeSnapshot: BackendConversationSnapshot = {
      orderedBackendTurnIds: ["turn-1", "turn-2"],
      turnsById: {
        "turn-1": snapshot().turnsById["turn-1"]!,
        "turn-2": {
          backendTurnId: "turn-2",
          status: "in_progress",
          orderedBackendItemIds: ["item-2"],
        },
      },
      itemsById: {
        "item-1": snapshot().itemsById["item-1"]!,
        "item-2": {
          backendItemId: "item-2",
          backendTurnId: "turn-2",
          semanticKind: "assistant_message",
          status: "streaming",
          sourceOrder: 0,
          markdown: { text: "still working" },
        },
      },
      runState: "running",
      activeBackendTurnId: "turn-2",
    };
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = activeSnapshot;
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(
        ["latest_completed", "selected_completed_turn"],
        false,
      ),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const earlierTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
    const earlierTurn = acquired.actor.timeline.turnsById[earlierTurnId]!;

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: earlierTurnId,
        expectedTurnRevision: earlierTurn.revision,
      }),
    ).resolves.toMatchObject({
      sourceTurnId: earlierTurnId,
      backendTurnId: "turn-1",
    });
    await expect(
      acquired.actor.resolveBranchCheckpoint({ kind: "latest_completed" }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
    expect(driver.resolveBranchCheckpoint).toHaveBeenCalledTimes(1);

    acquired.release();
    await manager.close();
  });

  it("allows an explicit historical fork after Sedes accepts later source work", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(
        ["latest_completed", "selected_completed_turn"],
        false,
      ),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const earlierTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
    const earlierTurn = acquired.actor.timeline.turnsById[earlierTurnId]!;
    await acquired.actor.submit({
      applicationOperationId: "later-source-submit",
      source: { kind: "user" },
      mutationId: "later-source-submit",
      reconciliationToken: "later-source-submit",
      text: "Start later work",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: earlierTurnId,
        expectedTurnRevision: earlierTurn.revision,
      }),
    ).resolves.toMatchObject({ backendTurnId: "turn-1" });
    await expect(
      acquired.actor.resolveBranchCheckpoint({ kind: "latest_completed" }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: true });

    acquired.release();
    await manager.close();
  });

  it("keeps active-source forking fail-closed for an idle-only backend", async () => {
    const activeSnapshot: BackendConversationSnapshot = {
      orderedBackendTurnIds: ["turn-1", "turn-2"],
      turnsById: {
        "turn-1": snapshot().turnsById["turn-1"]!,
        "turn-2": {
          backendTurnId: "turn-2",
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      },
      itemsById: { "item-1": snapshot().itemsById["item-1"]! },
      runState: "running",
      activeBackendTurnId: "turn-2",
    };
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = activeSnapshot;
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["selected_completed_turn"], true),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const earlierTurnId = acquired.actor.timeline.orderedTurnIds[0]!;

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: earlierTurnId,
        expectedTurnRevision:
          acquired.actor.timeline.turnsById[earlierTurnId]!.revision,
      }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
    expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("keeps a reconciling source fail-closed even when active historical forking is supported", async () => {
    const reconcilingSnapshot: BackendConversationSnapshot = {
      orderedBackendTurnIds: ["turn-1", "turn-2"],
      turnsById: {
        "turn-1": snapshot().turnsById["turn-1"]!,
        "turn-2": {
          backendTurnId: "turn-2",
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      },
      itemsById: { "item-1": snapshot().itemsById["item-1"]! },
      runState: "reconciling",
      activeBackendTurnId: "turn-2",
    };
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = reconcilingSnapshot;
    handle.backendCapabilities.mockResolvedValueOnce(
      selectedBranchingCapabilities(["selected_completed_turn"], false),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const earlierTurnId = acquired.actor.timeline.orderedTurnIds[0]!;

    await expect(
      acquired.actor.resolveBranchCheckpoint({
        kind: "selected_completed_turn",
        turnId: earlierTurnId,
        expectedTurnRevision:
          acquired.actor.timeline.turnsById[earlierTurnId]!.revision,
      }),
    ).rejects.toMatchObject({ category: "invalid_state", retryable: true });
    expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("holds source mutation exclusivity through the provider branch call", async () => {
    const { driver, handle, manager } = fixture();
    handle.backendCapabilities.mockResolvedValueOnce({
      revision: "branching-exclusive",
      actions: [],
      deliveryModes: ["submit"],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "available",
        boundaries: ["selected_completed_turn"],
        method: "provider_native",
        sourceMustBeIdle: true,
        settingsInheritance: "application_applied",
        fidelity: {
          instructions: false,
          messages: true,
          toolCalls: true,
          toolResults: true,
          compaction: true,
          attachments: true,
          settings: true,
          limitations: [],
        },
        childIdentity: "application_reserved",
        creationRecovery: "idempotent",
      },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: { toolAccess: "read_only" },
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const sourceTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
    let releaseBranch!: () => void;
    let branchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      branchStarted = resolve;
    });
    const providerBranch = new Promise<void>((resolve) => {
      releaseBranch = resolve;
    });
    const forking = acquired.actor.withBranchCheckpoint(
      {
        kind: "selected_completed_turn",
        turnId: sourceTurnId,
        expectedTurnRevision: 0,
      },
      async () => {
        branchStarted();
        await providerBranch;
        return "branched";
      },
    );
    await started;
    const submitting = acquired.actor.submit({
      applicationOperationId: "submit-after-fork",
      source: { kind: "user" },
      mutationId: "submit-after-fork",
      reconciliationToken: "submit-after-fork",
      text: "later source activity",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await Promise.resolve();
    expect(handle.submit).not.toHaveBeenCalled();

    releaseBranch();
    await expect(forking).resolves.toBe("branched");
    await expect(submitting).resolves.toMatchObject({ accepted: true });
    expect(handle.submit).toHaveBeenCalledOnce();

    acquired.release();
    await manager.close();
  });

  it("rejects steer-ended, interrupted, and in-progress selected turns", async () => {
    for (const sourceSnapshot of [
      {
        ...snapshot(),
        turnsById: {
          "turn-1": {
            ...snapshot().turnsById["turn-1"]!,
            endedBy: "steer" as const,
          },
        },
      },
      {
        ...snapshot(),
        turnsById: {
          "turn-1": {
            ...snapshot().turnsById["turn-1"]!,
            status: "interrupted" as const,
            endedBy: "interrupted" as const,
          },
        },
      },
      snapshot("running"),
    ]) {
      const { driver, handle, manager } = fixture();
      handle.establishmentSnapshots[0] = sourceSnapshot;
      handle.backendCapabilities.mockResolvedValueOnce(
        selectedBranchingCapabilities(),
      );
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      const sourceTurnId = acquired.actor.timeline.orderedTurnIds[0]!;
      await expect(
        acquired.actor.resolveBranchCheckpoint({
          kind: "selected_completed_turn",
          turnId: sourceTurnId,
          expectedTurnRevision: 0,
        }),
      ).rejects.toMatchObject({ category: "invalid_state" });
      expect(driver.resolveBranchCheckpoint).not.toHaveBeenCalled();
      acquired.release();
      await manager.close();
    }
  });

  it("resolves the same paginated turn after actor reconstruction", async () => {
    const resolvedIds: string[] = [];
    for (let reconstruction = 0; reconstruction < 2; reconstruction += 1) {
      const { driver, handle, manager } = fixture();
      handle.backendCapabilities.mockResolvedValueOnce({
        revision: "branching-paged",
        actions: [],
        deliveryModes: ["submit"],
        steerTarget: null,
        composerAttachments: { fileStaging: false, nativeImage: false },
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: false },
        supportsHistory: true,
        branching: {
          availability: "available",
          boundaries: ["selected_completed_turn"],
          method: "provider_native",
          sourceMustBeIdle: true,
          settingsInheritance: "application_applied",
          fidelity: {
            instructions: false,
            messages: true,
            toolCalls: true,
            toolResults: true,
            compaction: true,
            attachments: true,
            settings: true,
            limitations: [],
          },
          childIdentity: "application_reserved",
          creationRecovery: "idempotent",
        },
        interactionKinds: [],
        usageSections: [],
        effectiveSettings: { toolAccess: "read_only" },
      });
      handle.establishmentHistories[0] = {
        operational: true,
        previousCursor: "older-page",
      };
      handle.history.mockImplementation(async (input) =>
        input.cursor === "older-page"
          ? {
              orderedBackendTurnIds: ["old-turn"],
              turnsById: {
                "old-turn": {
                  backendTurnId: "old-turn",
                  status: "completed",
                  endedBy: "agent_settled",
                  orderedBackendItemIds: ["old-item"],
                },
              },
              itemsById: {
                "old-item": {
                  backendItemId: "old-item",
                  backendTurnId: "old-turn",
                  semanticKind: "assistant_message",
                  status: "completed",
                  sourceOrder: 0,
                  markdown: { text: "old" },
                },
              },
            }
          : {
              orderedBackendTurnIds: ["turn-1"],
              turnsById: snapshot().turnsById,
              itemsById: snapshot().itemsById,
              previousCursor: "older-page",
            },
      );
      handle.locateTurn.mockImplementation(async (input) => {
        if (!input.matchesBackendTurnId("old-turn")) {
          return { status: "not_found" };
        }
        return {
          status: "found",
          page: {
            orderedBackendTurnIds: ["old-turn"],
            turnsById: {
              "old-turn": {
                backendTurnId: "old-turn",
                status: "completed",
                endedBy: "agent_settled",
                orderedBackendItemIds: ["old-item"],
              },
            },
            itemsById: {
              "old-item": {
                backendItemId: "old-item",
                backendTurnId: "old-turn",
                semanticKind: "assistant_message",
                status: "completed",
                sourceOrder: 0,
                markdown: { text: "old" },
              },
            },
          },
        };
      });
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      const history = await acquired.actor.history({
        cursor: "older-page",
        limit: 100,
      });
      const sourceTurnId = history.page.orderedTurnIds[0]!;
      resolvedIds.push(sourceTurnId);
      await expect(
        acquired.actor.resolveBranchCheckpoint({
          kind: "selected_completed_turn",
          turnId: sourceTurnId,
          expectedTurnRevision: 0,
        }),
      ).resolves.toMatchObject({
        sourceTurnId,
        backendTurnId: "old-turn",
      });
      expect(driver.resolveBranchCheckpoint).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selection: {
            kind: "selected_completed_turn",
            backendTurnId: "old-turn",
            boundary: "completed_turn_inclusive",
          },
        }),
      );
      acquired.release();
      await manager.close();
    }
    expect(resolvedIds[1]).toBe(resolvedIds[0]);
  });

  it("resolves a paginated selected turn beyond 1000 turns after reconstruction", async () => {
    const resolvedIds: string[] = [];
    const historyPage = (index: number): BackendHistoryPage => {
      const count = index < 10 ? 100 : 1;
      const backendTurnIds = Array.from(
        { length: count },
        (_, offset) => `deep-turn-${index * 100 + offset}`,
      );
      return {
        orderedBackendTurnIds: backendTurnIds,
        turnsById: Object.fromEntries(
          backendTurnIds.map((backendTurnId) => [
            backendTurnId,
            {
              backendTurnId,
              status: "completed" as const,
              endedBy: "agent_settled" as const,
              orderedBackendItemIds: [],
            },
          ]),
        ),
        itemsById: {},
        ...(index < 10 ? { previousCursor: `deep-page-${index + 1}` } : {}),
      };
    };

    for (let reconstruction = 0; reconstruction < 2; reconstruction += 1) {
      const { driver, handle, manager } = fixture();
      handle.backendCapabilities.mockResolvedValueOnce(
        selectedBranchingCapabilities(),
      );
      handle.establishmentHistories[0] = {
        operational: true,
        previousCursor: "deep-page-0",
      };
      handle.history.mockImplementation(async ({ cursor, limit }) => {
        expect(limit).toBeLessThanOrEqual(100);
        if (!cursor) {
          return {
            orderedBackendTurnIds: ["turn-1"],
            turnsById: snapshot().turnsById,
            itemsById: snapshot().itemsById,
            previousCursor: "deep-page-0",
          };
        }
        const match = /^deep-page-(\d+)$/.exec(cursor ?? "");
        if (!match) throw new Error("unexpected deep-history cursor");
        return historyPage(Number(match[1]));
      });
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      const loaded = await acquired.actor.history({
        cursor: "deep-page-10",
        limit: 100,
      });
      const sourceTurnId = loaded.page.orderedTurnIds[0]!;
      expect(loaded.page.forksByTurnId[sourceTurnId]).toMatchObject({
        available: true,
        expectedTurnRevision: 0,
      });
      resolvedIds.push(sourceTurnId);
      handle.history.mockClear();
      handle.locateTurn.mockImplementationOnce(async (input) => {
        expect(input.maximumTurnCandidates).toBe(12_800);
        return input.matchesBackendTurnId("deep-turn-1000")
          ? { status: "found", page: historyPage(10) }
          : { status: "not_found" };
      });

      await expect(
        acquired.actor.resolveBranchCheckpoint({
          kind: "selected_completed_turn",
          turnId: sourceTurnId,
          expectedTurnRevision: 0,
        }),
      ).resolves.toMatchObject({
        sourceTurnId,
        backendTurnId: "deep-turn-1000",
      });
      expect(handle.history).not.toHaveBeenCalled();
      expect(handle.locateTurn).toHaveBeenCalledOnce();

      acquired.release();
      await manager.close();
    }
    expect(resolvedIds[1]).toBe(resolvedIds[0]);
  });

  it("rejects a steer when the active turn changed before the actor mailbox executes it", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.steer({
        applicationOperationId: "stale-steer",
        mutationId: "stale-steer",
        reconciliationToken: "stale-steer",
        target: { kind: "turn", turnId: "older-turn" },
        text: "Change direction",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      crossedSubmissionBoundary: false,
    });
    expect(handle.steer).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("admits conversation steering after the observed turn ends without inventing a turn identity", async () => {
    const { driver, handle, manager } = fixture();
    const capabilities = await handle.backendCapabilities();
    handle.backendCapabilities.mockResolvedValue({ ...capabilities, steerTarget: "conversation" });
    handle.steer.mockResolvedValueOnce({ status: "pending_materialization", reconciliationToken: "conversation-steer",
      completionCorrelation: "conversation-steer" });
    const acquired = await manager.acquire({ scope, binding, workspace, opaqueBindingDetail: "opaque", driver });
    expect(acquired.actor.timeline.activeTurnId).toBeUndefined();
    await expect(acquired.actor.steer({ applicationOperationId: "conversation-steer", mutationId: "conversation-steer",
      reconciliationToken: "conversation-steer", target: { kind: "conversation" }, text: "Apply next",
      contextExcerpts: [], attachments: [], taskContexts: [] })).resolves.toEqual({
        status: "pending_materialization", reconciliationToken: "conversation-steer", completionCorrelation: "conversation-steer",
      });
    expect(handle.steer).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "conversation" } }));
    acquired.release();
    await manager.close();
  });

  it("refuses a conversation target for a backend that requires an exact turn", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const acquired = await manager.acquire({ scope, binding, workspace, opaqueBindingDetail: "opaque", driver });
    await expect(acquired.actor.steer({ applicationOperationId: "wrong-target", mutationId: "wrong-target",
      reconciliationToken: "wrong-target", target: { kind: "conversation" }, text: "Apply next",
      contextExcerpts: [], attachments: [], taskContexts: [] })).rejects.toMatchObject({ category: "invalid_state", crossedSubmissionBoundary: false });
    expect(handle.steer).not.toHaveBeenCalled();
    acquired.release();
    await manager.close();
  });

  it("translates an application steering target to its backend identity", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const activeTurnId = acquired.actor.timeline.activeTurnId;
    if (!activeTurnId) throw new Error("missing active turn");

    await acquired.actor.steer({
      applicationOperationId: "translated-steer",
      mutationId: "translated-steer",
      reconciliationToken: "translated-steer",
      target: { kind: "turn", turnId: activeTurnId },
      text: "Continue safely",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    expect(handle.steer).toHaveBeenCalledWith({
      applicationOperationId: "translated-steer",
      mutationId: "translated-steer",
      reconciliationToken: "translated-steer",
      target: { kind: "turn", turnId: "turn-1" },
      text: "Continue safely",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });

    acquired.release();
    await manager.close();
  });

  it("rejects a backend acknowledgement for a different native turn", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    handle.steer.mockResolvedValueOnce({
      status: "accepted",
      reconciliationToken: "wrong-target-steer",
      completionCorrelation: "wrong-target-steer",
      backendTurnId: "another-native-turn",
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const activeTurnId = acquired.actor.timeline.activeTurnId;
    if (!activeTurnId) throw new Error("missing active turn");

    await expect(
      acquired.actor.steer({
        applicationOperationId: "wrong-target-steer",
        mutationId: "wrong-target-steer",
        reconciliationToken: "wrong-target-steer",
        target: { kind: "turn", turnId: activeTurnId },
        text: "Continue elsewhere",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      category: "internal",
      crossedSubmissionBoundary: true,
    });

    acquired.release();
    await manager.close();
  });

  it("rejects an interrupt when the active turn changed before the actor mailbox executes it", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.interrupt({
        applicationOperationId: "stale-interrupt",
        expectedActiveTurnId: "older-turn",
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      crossedSubmissionBoundary: false,
    });
    expect(handle.interrupt).not.toHaveBeenCalled();

    acquired.release();
    await manager.close();
  });

  it("translates the exact application turn target to its backend identity", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const activeTurnId = acquired.actor.timeline.activeTurnId;
    if (!activeTurnId) throw new Error("missing active turn");

    await acquired.actor.interrupt({
      applicationOperationId: "translated-interrupt",
      expectedActiveTurnId: activeTurnId,
    });
    expect(handle.interrupt).toHaveBeenCalledWith({
      applicationOperationId: "translated-interrupt",
      expectedBackendTurnId: "turn-1",
    });

    acquired.release();
    await manager.close();
  });

  it("closes runtime resources when an interaction-failure interrupt cannot be delivered", async () => {
    const { driver, handle, lease, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    handle.interrupt.mockRejectedValueOnce(
      new BackendError({
        category: "unavailable",
        retryable: true,
        crossedSubmissionBoundary: true,
        safeMessage: "The interrupt outcome is unknown.",
      }),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await acquired.actor.interruptForInteractionFailure(
      "capacity:interaction-failure",
    );

    expect(handle.interrupt).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(acquired.actor.closed).toBe(true);
    acquired.release();
    await manager.close();
  });

  it("shares one actor, lease, handle, and projection across concurrent clients", async () => {
    const { driver, environments, handle, manager } = fixture();
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    };
    const [first, second] = await Promise.all([
      manager.acquire(input),
      manager.acquire(input),
    ]);

    expect(first.actor).toBe(second.actor);
    expect(environments.acquireLease).toHaveBeenCalledOnce();
    expect(driver.attach).toHaveBeenCalledOnce();
    expect(handle.establishCount).toBe(1);
    const initialGeneration = first.actor.timeline.generation;
    const received: string[] = [];
    const unsubscribeFirst = first.actor.subscribe((event) => {
      received.push(event.type);
    });
    const unsubscribeSecond = second.actor.subscribe(() => undefined);
    expect(second.actor.timeline.generation).toBe(initialGeneration);
    expect(handle.establishCount).toBe(1);

    unsubscribeFirst();
    unsubscribeSecond();
    first.release();
    second.release();
    await manager.close();
    expect(received).toEqual(["projection_replaced"]);
  });

  it("captures the actor-maintained state without rereading the backend", async () => {
    const { driver, handle, manager } = fixture();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    handle.backendCapabilities.mockClear();
    handle.usage.mockClear();
    handle.history.mockClear();

    const captured = await acquired.actor.captureSnapshotState();
    const capturedItem =
      captured.timeline.itemsById[Object.keys(captured.timeline.itemsById)[0]!];
    expect(captured.backendCapabilities.revision).toBe("1");
    expect(captured.usage).toEqual({});
    expect(capturedItem).toMatchObject({ markdown: { text: "hello" } });
    expect(handle.backendCapabilities).not.toHaveBeenCalled();
    expect(handle.usage).not.toHaveBeenCalled();
    expect(handle.history).not.toHaveBeenCalled();
    acquired.release();
    await manager.close();
  });

  it("establishes a safe history boundary and normalizes older pages in the actor mailbox", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentHistories[0] = {
      operational: true,
      previousCursor: "native-boundary",
    };
    handle.history.mockResolvedValueOnce({
      orderedBackendTurnIds: ["turn-older"],
      turnsById: {
        "turn-older": {
          backendTurnId: "turn-older",
          status: "completed",
          orderedBackendItemIds: [],
        },
      },
      itemsById: {},
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    const captured = await acquired.actor.captureSnapshotState();
    expect(captured.history).toEqual({
      operational: true,
      previousCursor: "native-boundary",
    });
    expect(handle.history).not.toHaveBeenCalled();
    const older = await acquired.actor.history({
      cursor: "native-boundary",
      limit: 100,
    });
    expect(older.generation).toBe(captured.timeline.generation);
    expect(older.page.orderedTurnIds).toHaveLength(1);
    expect(JSON.stringify(older.page)).not.toContain("turn-older");
    expect(handle.history).toHaveBeenCalledOnce();

    acquired.release();
    await manager.close();
  });

  it("locates and normalizes one historical turn while the active head is running", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.splice(0, 1, snapshot("running"));
    handle.establishmentHistories[0] = {
      operational: true,
      previousCursor: "native-boundary",
    };
    const targetTurnId = applicationTurnIdForBackendTurn({
      backendInstanceId: binding.backendInstanceId,
      sourceApplicationThreadId: binding.applicationThreadId,
      backendTurnId: "turn-older",
    });
    handle.locateTurn.mockImplementationOnce(async (input) => {
      expect(input.maximumTurnCandidates).toBe(12_800);
      expect(input.matchesBackendTurnId("turn-older")).toBe(true);
      expect(input.matchesBackendTurnId("turn-other")).toBe(false);
      return {
        status: "found",
        page: {
          orderedBackendTurnIds: ["turn-older"],
          turnsById: {
            "turn-older": {
              backendTurnId: "turn-older",
              status: "completed",
              endedBy: "agent_settled",
              orderedBackendItemIds: ["item-older"],
            },
          },
          itemsById: {
            "item-older": {
              backendItemId: "item-older",
              backendTurnId: "turn-older",
              semanticKind: "assistant_message",
              status: "completed",
              sourceOrder: 0,
              markdown: { text: "older answer" },
            },
          },
        },
      };
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    const result = await acquired.actor.locateTurn({ targetTurnId });

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected located turn");
    expect(result.page.orderedTurnIds).toEqual([targetTurnId]);
    expect(result.page.turnsById[targetTurnId]).toMatchObject({
      id: targetTurnId,
      status: "completed",
    });
    expect(JSON.stringify(result)).not.toContain("turn-older");

    acquired.release();
    await manager.close();
  });

  it("rejects a malformed targeted backend page", async () => {
    const { driver, handle, manager } = fixture();
    const targetTurnId = applicationTurnIdForBackendTurn({
      backendInstanceId: binding.backendInstanceId,
      sourceApplicationThreadId: binding.applicationThreadId,
      backendTurnId: "turn-older",
    });
    handle.locateTurn.mockResolvedValueOnce({
      status: "found",
      page: {
        orderedBackendTurnIds: ["turn-older"],
        turnsById: {
          "turn-older": {
            backendTurnId: "turn-older",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [],
          },
        },
        itemsById: {},
        previousCursor: "native-secret",
      },
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.locateTurn({ targetTurnId }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      retryable: false,
    });

    acquired.release();
    await manager.close();
  });

  it("aborts queued and in-flight history before preserving Submit mailbox order", async () => {
    const { driver, handle, manager } = fixture();
    const order: string[] = [];
    let historyStarted!: () => void;
    const historyStart = new Promise<void>((resolve) => {
      historyStarted = resolve;
    });
    handle.history.mockImplementation(async (input) => {
      order.push("history-start");
      historyStarted();
      return await new Promise<BackendHistoryPage>((_resolve, reject) => {
        expect(input.signal).toBeDefined();
        input.signal!.addEventListener(
          "abort",
          () => {
            order.push("history-abort");
            reject(input.signal!.reason);
          },
          { once: true },
        );
      });
    });
    handle.submit.mockImplementation(async (input) => {
      order.push(input.applicationOperationId);
      return {
        accepted: true as const,
        reconciliationToken: input.reconciliationToken,
      };
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    const inFlightHistoryFailure = acquired.actor
      .history({ limit: 100 })
      .catch((error: unknown) => error);
    await historyStart;
    const queuedHistoryFailure = acquired.actor
      .history({ cursor: "queued", limit: 100 })
      .catch((error: unknown) => error);
    const submit = (applicationOperationId: string) =>
      acquired.actor.submit({
        applicationOperationId,
        mutationId: `mutation-${applicationOperationId}`,
        source: { kind: "user" },
        reconciliationToken: `receipt-${applicationOperationId}`,
        text: applicationOperationId,
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      });
    const firstSubmit = submit("submit-one");
    const secondSubmit = submit("submit-two");

    await expect(inFlightHistoryFailure).resolves.toMatchObject({
      message: "conversation_actor_history_preempted_by_mutation",
    });
    await expect(queuedHistoryFailure).resolves.toMatchObject({
      message: "conversation_actor_history_preempted_by_mutation",
    });
    await expect(firstSubmit).resolves.toMatchObject({ accepted: true });
    await expect(secondSubmit).resolves.toMatchObject({ accepted: true });
    expect(handle.history).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "history-start",
      "history-abort",
      "submit-one",
      "submit-two",
    ]);

    acquired.release();
    await manager.close();
  });

  it("fails closed when an atomic history boundary contradicts backend capabilities", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentHistories[0] = {
      operational: true,
      previousCursor: "must-not-be-used",
    };
    handle.backendCapabilities.mockResolvedValueOnce({
      ...(await handle.backendCapabilities()),
      supportsHistory: false,
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    expect((await acquired.actor.captureSnapshotState()).history).toEqual({
      operational: false,
    });
    expect(handle.history).not.toHaveBeenCalled();
    acquired.release();
    await manager.close();
  });

  it.each([false, true])(
    "gates nonblocking question workflow on advertised support (%s)",
    async (supported) => {
      const { driver, handle, manager } = fixture();
      handle.establishmentSnapshots[0] = snapshot("running");
      const capabilities = await handle.backendCapabilities();
      handle.backendCapabilities.mockResolvedValue({
        ...capabilities,
        nonblockingQuestions: supported,
      });
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      const events: ConversationActorEvent[] = [];
      acquired.actor.subscribe((event) => events.push(event));
      handle.emit(0, {
        type: "item_updated",
        item: {
          ...snapshot("running").itemsById["item-1"]!,
          semanticKind: "assistant_message",
          markdown: { text: "Question" },
          nonblockingQuestions: {
            questions: [{ title: "Continue?", options: null }],
          },
        },
      });
      await vi.waitFor(() =>
        expect(
          Object.values(acquired.actor.timeline.itemsById)[0],
        ).toMatchObject({
          nonblockingQuestions: {
            questions: [{ title: "Continue?", options: null }],
          },
        }),
      );
      expect(
        events.filter((event) => event.type === "nonblocking_questions"),
      ).toHaveLength(supported ? 1 : 0);
      acquired.release();
      await manager.close();
    },
  );

  it("serializes mutations with driver events and replaces atomically after invalidation", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.push(snapshot("idle", "authoritative"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    let releaseSubmit!: () => void;
    handle.submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubmit = () =>
            resolve({
              accepted: true,
              reconciliationToken: "receipt",
            });
        }),
    );
    const events: string[] = [];
    acquired.actor.subscribe((event) => events.push(event.type));
    const submitting = acquired.actor.submit({
      applicationOperationId: "operation-1",
      source: { kind: "user" },
      mutationId: "mutation-1",
      reconciliationToken: "mutation-1",
      text: "hello",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    handle.emit(0, {
      type: "resnapshot_required",
      reason: "ambiguous_correlation",
    });
    await Promise.resolve();
    expect(handle.establishCount).toBe(1);

    releaseSubmit();
    await submitting;
    await vi.waitFor(() => expect(handle.establishCount).toBe(2));
    expect(handle.history).not.toHaveBeenCalled();
    expect(events).toEqual(["projection_replaced", "projection_replaced"]);
    expect(acquired.actor.timeline.itemsById).toEqual(
      expect.objectContaining({
        [Object.keys(acquired.actor.timeline.itemsById)[0]!]:
          expect.objectContaining({ markdown: { text: "authoritative" } }),
      }),
    );
    acquired.release();
    await manager.close();
  });

  it("retries projection replacement and surfaces a terminal recovery failure", async () => {
    const { driver, handle, manager } = fixture();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const establishment = vi
      .spyOn(handle, "establishProjection")
      .mockRejectedValueOnce(new Error("replacement-failed-1"))
      .mockRejectedValueOnce(new Error("replacement-failed-2"))
      .mockRejectedValueOnce(new Error("replacement-failed-3"));
    const received: ConversationActorEvent[] = [];
    acquired.actor.subscribe((event) => received.push(event));

    handle.emit(0, {
      type: "resnapshot_required",
      reason: "contradictory_state",
    });

    await vi.waitFor(() => expect(establishment).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "backend_event",
          event: expect.objectContaining({
            type: "notice",
            notice: expect.objectContaining({
              tone: "error",
              message: {
                text: "Conversation synchronization failed. Reopen the thread to retry.",
              },
            }),
          }),
        }),
      ),
    );
    const failedGeneration = acquired.actor.timeline.generation;
    handle.establishmentSnapshots[1] = snapshot("idle", "recovered");
    const reopened = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    expect(establishment).toHaveBeenCalledTimes(4);
    expect(handle.establishCount).toBe(2);
    expect(reopened.actor.timeline.generation).not.toBe(failedGeneration);
    reopened.release();
    acquired.release();
    await manager.close();
  });

  it("clears a boundary-crossing submission latch after non-acceptance is proven", async () => {
    const remove = vi.fn(() => true);
    const deliveryInputSnapshots = {
      prepare: vi.fn(),
      find: vi.fn(() => undefined),
      remove,
    } as unknown as DeliveryInputSnapshotRepository;
    const { driver, handle, manager } = fixture(
      undefined,
      undefined,
      10,
      deliveryInputSnapshots,
    );
    handle.submit.mockRejectedValueOnce(
      new BackendError({
        category: "overloaded",
        retryable: true,
        crossedSubmissionBoundary: true,
        safeMessage: "Submission outcome is unknown.",
      }),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    await expect(
      acquired.actor.submit({
        applicationOperationId: "uncertain-submit",
        source: { kind: "user" },
        mutationId: "uncertain-submit",
        reconciliationToken: "uncertain-submit",
        text: "hello",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(acquired.actor.canEvict).toBe(false);
    expect(remove).not.toHaveBeenCalled();

    await acquired.actor.reconcileSubmissionNotAccepted("uncertain-submit");
    expect(acquired.actor.canEvict).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(
      scope,
      binding.applicationThreadId,
      "uncertain-submit",
    );
    acquired.release();
    await manager.close();
  });

  it("closes in reverse ownership order exactly once", async () => {
    const { closeOrder, driver, handle, lease, manager } = fixture();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    acquired.release();
    expect(driver.attach).toHaveBeenCalledOnce();
    await manager.close();
    await manager.close();

    expect(closeOrder).toEqual([
      "unsubscribe-0",
      "handle-close",
      "lease-release",
    ]);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("releases the environment lease when backend attach fails", async () => {
    const { driver, lease, manager } = fixture();
    vi.mocked(driver.attach).mockRejectedValueOnce(new Error("attach failed"));

    await expect(
      manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      }),
    ).rejects.toThrow("attach failed");

    expect(lease.release).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("coalesces growing item replacements and flushes terminal state", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const events: string[] = [];
    acquired.actor.subscribe((event) => {
      if (event.type === "projection_replaced") {
        events.push("snapshot");
        return;
      }
      if (event.type === "projection_events") {
        const item = event.events.find(
          (candidate) => candidate.type === "item_upsert",
        );
        if (item?.type === "item_upsert" && "markdown" in item.item) {
          events.push(`${item.item.status}:${item.item.markdown.text}`);
        }
      }
    });
    const initial = snapshot("running", "a").itemsById["item-1"]!;
    if (initial.semanticKind !== "assistant_message") {
      throw new Error("expected_assistant_message");
    }
    handle.emit(0, {
      type: "item_updated",
      item: { ...initial, markdown: { text: "ab" } },
    });
    handle.emit(
      0,
      {
        type: "item_updated",
        item: { ...initial, markdown: { text: "abc" } },
      },
      1,
    );
    handle.emit(
      0,
      {
        type: "item_completed",
        item: {
          ...initial,
          status: "completed",
          markdown: { text: "final" },
        },
      },
      2,
    );

    await vi.waitFor(() =>
      expect(events).toEqual(["snapshot", "streaming:ab", "completed:final"]),
    );
    acquired.release();
    await manager.close();
  });

  it("keeps the closing actor registered until idle eviction finishes", async () => {
    vi.useFakeTimers();
    try {
      const first = fixture();
      let releaseClose!: () => void;
      first.handle.close.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseClose = () => {
              first.closeOrder.push("handle-close");
              resolve(undefined);
            };
          }),
      );
      const secondHandle = new FakeHandle(first.closeOrder);
      first.driver.attach = vi
        .fn()
        .mockResolvedValueOnce(first.handle as unknown as ConversationHandle)
        .mockImplementationOnce(async () => {
          first.closeOrder.push("second-attach");
          return secondHandle as unknown as ConversationHandle;
        });
      const input = {
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver: first.driver,
      };
      const acquired = await first.manager.acquire(input);
      acquired.release();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.handle.close).toHaveBeenCalledOnce();

      const reacquiring = first.manager.acquire(input);
      await Promise.resolve();
      expect(first.driver.attach).toHaveBeenCalledOnce();
      releaseClose();
      const reacquired = await reacquiring;
      expect(first.driver.attach).toHaveBeenCalledTimes(2);
      expect(first.closeOrder.indexOf("handle-close")).toBeLessThan(
        first.closeOrder.indexOf("second-attach"),
      );
      reacquired.release();
      await first.manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not evict behind an accepted mutation awaiting authoritative idle", async () => {
    vi.useFakeTimers();
    try {
      const { driver, handle, manager } = fixture();
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      let releaseSubmit!: () => void;
      handle.submit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSubmit = () =>
              resolve({
                accepted: true,
                reconciliationToken: "accepted",
              });
          }),
      );
      const submitting = acquired.actor.submit({
        applicationOperationId: "operation",
        source: { kind: "user" },
        mutationId: "mutation",
        reconciliationToken: "mutation",
        text: "work",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
      acquired.release();
      await vi.advanceTimersByTimeAsync(10);
      expect(handle.close).not.toHaveBeenCalled();
      releaseSubmit();
      await submitting;
      await vi.advanceTimersByTimeAsync(100);
      expect(handle.close).not.toHaveBeenCalled();
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops callbacks already queued from an obsolete establishment", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots.push(snapshot("idle", "replacement"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const stale = handle.establishmentListeners[0]!;
    const types: string[] = [];
    acquired.actor.subscribe((event) => types.push(event.type));
    handle.emit(0, {
      type: "resnapshot_required",
      reason: "ambiguous_correlation",
    });
    await vi.waitFor(() => expect(handle.establishCount).toBe(2));
    stale({
      handleSequence: 1,
      event: {
        type: "notice",
        notice: {
          id: "stale-notice",
          tone: "info",
          message: { text: "stale" },
          createdAt: "2026-07-30T12:00:00.000Z",
        },
      },
    });
    await Promise.resolve();
    expect(handle.establishCount).toBe(2);
    expect(types).toEqual(["projection_replaced", "projection_replaced"]);
    acquired.release();
    await manager.close();
  });

  it("publishes projected and ancillary events in driver sequence order", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const types: string[] = [];
    acquired.actor.subscribe((event) => types.push(event.type));
    const item = snapshot("running", "a").itemsById["item-1"]!;
    handle.emit(0, {
      type: "item_updated",
      item,
    });
    handle.emit(
      0,
      {
        type: "notice",
        notice: {
          id: "ordered-notice",
          tone: "info",
          message: { text: "after item" },
          createdAt: "2026-07-30T12:00:00.000Z",
        },
      },
      1,
    );
    await vi.waitFor(() =>
      expect(types).toEqual([
        "projection_replaced",
        "projection_events",
        "backend_event",
      ]),
    );
    acquired.release();
    await manager.close();
  });

  it("publishes a backend capability refresh after a run-state transition", async () => {
    const { driver, handle, manager } = fixture();
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const types: string[] = [];
    const projectionTypes: string[] = [];
    acquired.actor.subscribe((event) => {
      types.push(event.type);
      if (event.type === "projection_events") {
        projectionTypes.push(...event.events.map(({ type }) => type));
      }
    });

    handle.emit(0, {
      type: "run_state_changed",
      state: "idle",
    });
    await vi.waitFor(() =>
      expect(types).toEqual([
        "projection_replaced",
        "projection_events",
        "projection_events",
        "backend_event",
      ]),
    );
    expect(projectionTypes).toEqual(["run_state", "fork_source_state_changed"]);

    acquired.release();
    await manager.close();
  });

  it.each([
    ["completed", "agent_settled"],
    ["interrupted", "interrupted"],
    ["failed", "failed"],
  ] as const)(
    "publishes a stable backend completion identity after %s projection",
    async (status, endedBy) => {
      const { driver, handle, manager } = fixture();
      handle.establishmentSnapshots[0] = snapshot("running", "a");
      const acquired = await manager.acquire({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      });
      const completions: Array<{
        backendCorrelation: string;
        backendTurnId: string;
        applicationTurnId: string;
        completionIdentity: string;
        outcome: "completed" | "interrupted" | "failed";
        result: { readonly text: string };
      }> = [];
      acquired.actor.subscribe((event) => {
        if (event.type === "authoritative_completion") {
          completions.push({
            backendCorrelation: event.backendCorrelation,
            backendTurnId: event.backendTurnId,
            applicationTurnId: event.applicationTurnId,
            completionIdentity: event.completionIdentity,
            outcome: event.outcome,
            result: event.result,
          });
        }
      });
      handle.emit(0, {
        type: "turn_completed",
        turn: {
          backendTurnId: "turn-1",
          status,
          endedBy,
          completedAt: "2026-07-30T12:00:00.000Z",
          orderedBackendItemIds: ["item-1"],
        },
      });
      await vi.waitFor(() =>
        expect(completions).toEqual([
          {
            backendCorrelation: "turn-1",
            backendTurnId: "turn-1",
            applicationTurnId: projectedTurnId,
            completionIdentity: `turn-1:${status}`,
            outcome: status,
            result: { text: "a" },
          },
        ]),
      );
      acquired.release();
      await manager.close();
    },
  );

  it("does not publish completion from a sequence-gap event rejected by resnapshot", async () => {
    const observed = vi.fn<AuthoritativeCompletionObserver>();
    const { driver, handle, manager } = fixture(observed);
    handle.establishmentSnapshots[0] = snapshot("running", "initial");
    handle.establishmentSnapshots.push(snapshot("running", "replacement"));
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const actorCompletions: ConversationActorEvent[] = [];
    acquired.actor.subscribe((event) => {
      if (event.type === "authoritative_completion") {
        actorCompletions.push(event);
      }
    });

    handle.emit(
      0,
      {
        type: "turn_completed",
        turn: {
          backendTurnId: "turn-1",
          completionCorrelations: ["rejected-operation"],
          status: "completed",
          endedBy: "agent_settled",
          completedAt: "2026-07-30T12:00:00.000Z",
          orderedBackendItemIds: ["item-1"],
        },
      },
      1,
    );

    await vi.waitFor(() => expect(handle.establishCount).toBe(2));
    expect(actorCompletions).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    expect(acquired.actor.timeline.runState).toBe("running");
    acquired.release();
    await manager.close();
  });

  it("observes live and restart-replayed accepted completions without a runtime", async () => {
    const observed = vi.fn<AuthoritativeCompletionObserver>();
    const live = fixture(observed);
    live.handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await live.manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver: live.driver,
    });
    live.handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: [
          "accepted-operation",
          "accepted-steer-operation",
        ],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledWith(
        scope,
        binding.applicationThreadId,
        {
          backendCorrelation: "accepted-operation",
          backendTurnId: "turn-1",
          applicationTurnId: projectedTurnId,
          completionIdentity: "turn-1:completed",
          outcome: "completed",
          result: { text: "a" },
          classifiedResult: { provisional: null, final: null, unclassified: { text: "a" } },
        },
      ),
    );
    expect(observed).toHaveBeenCalledWith(scope, binding.applicationThreadId, {
      backendCorrelation: "accepted-steer-operation",
      backendTurnId: "turn-1",
      applicationTurnId: projectedTurnId,
      completionIdentity: "turn-1:completed",
      outcome: "completed",
      result: { text: "a" },
      classifiedResult: { provisional: null, final: null, unclassified: { text: "a" } },
    });
    acquired.release();
    await live.manager.close();

    observed.mockClear();
    const reopened = fixture(observed);
    reopened.handle.establishmentSnapshots[0] = {
      ...snapshot(),
      turnsById: {
        "turn-1": {
          ...snapshot().turnsById["turn-1"]!,
          completionCorrelations: [
            "accepted-operation",
            "accepted-steer-operation",
          ],
        },
      },
    };
    const replayed = await reopened.manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver: reopened.driver,
    });
    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledWith(
        scope,
        binding.applicationThreadId,
        {
          backendCorrelation: "accepted-operation",
          backendTurnId: "turn-1",
          applicationTurnId: projectedTurnId,
          completionIdentity: "turn-1:completed",
          outcome: "completed",
          result: { text: "hello" },
          classifiedResult: { provisional: null, final: null, unclassified: { text: "hello" } },
        },
      ),
    );
    expect(observed).toHaveBeenCalledWith(scope, binding.applicationThreadId, {
      backendCorrelation: "accepted-steer-operation",
      backendTurnId: "turn-1",
      applicationTurnId: projectedTurnId,
      completionIdentity: "turn-1:completed",
      outcome: "completed",
      result: { text: "hello" },
      classifiedResult: { provisional: null, final: null, unclassified: { text: "hello" } },
    });
    replayed.release();
    await reopened.manager.close();
  });

  it("serializes newly observed terminal submissions before their completions", async () => {
    const order: string[] = [];
    let releaseSubmission!: () => void;
    const submissionMayFinish = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    const completion = vi.fn<AuthoritativeCompletionObserver>(() => {
      order.push("completion");
    });
    const submission = vi.fn<AuthoritativeSubmissionObserver>(async () => {
      order.push("submission-started");
      await submissionMayFinish;
      order.push("submission-finished");
    });
    const { driver, handle, manager } = fixture(completion, submission);
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["uncertain-steer"],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["submission-started"]));
    expect(completion).not.toHaveBeenCalled();

    releaseSubmission();
    await vi.waitFor(() =>
      expect(order).toEqual([
        "submission-started",
        "submission-finished",
        "completion",
      ]),
    );

    acquired.release();
    await manager.close();
  });

  it("drains delayed durable completion before closing resources", async () => {
    let runState: "preparing" | "active" | "completed" | "interrupted" =
      "preparing";
    let releaseSubmission!: () => void;
    const submissionMayFinish = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    const submission = vi.fn<AuthoritativeSubmissionObserver>(async () => {
      runState = "active";
      await submissionMayFinish;
    });
    const completion = vi.fn<AuthoritativeCompletionObserver>(() => {
      runState = "completed";
    });
    const { driver, handle, manager } = fixture(completion, submission);
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["delayed-completion-operation"],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() => expect(submission).toHaveBeenCalledOnce());

    const closing = manager.close();
    await Promise.resolve();
    expect(handle.close).not.toHaveBeenCalled();
    releaseSubmission();
    await closing;

    expect(completion).toHaveBeenCalledOnce();
    expect(runState).toBe("completed");
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("waits for a non-resolving authoritative observer before closing resources", async () => {
    let releaseObserver!: () => void;
    const observerMayFinish = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const completion = vi.fn<AuthoritativeCompletionObserver>(
      () => observerMayFinish,
    );
    const { driver, handle, manager } = fixture(completion);
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["blocked-observer-operation"],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() => expect(completion).toHaveBeenCalledOnce());

    const closing = manager.close();
    await Promise.resolve();
    expect(handle.close).not.toHaveBeenCalled();

    releaseObserver();
    await closing;
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("drains delayed authoritative completion before idle eviction", async () => {
    let runState: "preparing" | "active" | "completed" | "interrupted" =
      "preparing";
    let releaseSubmission!: () => void;
    const submissionMayFinish = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    const submission = vi.fn<AuthoritativeSubmissionObserver>(async () => {
      runState = "active";
      await submissionMayFinish;
    });
    const completion = vi.fn<AuthoritativeCompletionObserver>(() => {
      runState = "completed";
    });
    const { driver, handle, manager } = fixture(completion, submission);
    handle.establishmentSnapshots[0] = snapshot();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["delayed-eviction-operation"],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() => expect(submission).toHaveBeenCalledOnce());
    expect(acquired.actor.canEvict).toBe(true);
    acquired.release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(handle.close).not.toHaveBeenCalled();

    releaseSubmission();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());
    expect(completion).toHaveBeenCalledOnce();
    expect(runState).toBe("completed");
    await manager.close();
  });

  it("defers production-shaped uncertain recovery beyond idle eviction observer drain", async () => {
    const backgroundErrors: unknown[] = [];
    const followUp = new DeferredProductionOperations((error) =>
      backgroundErrors.push(error),
    );
    let manager!: ReturnType<typeof fixture>["manager"];
    let recoveryCompleted = false;
    let releaseRecovery!: () => void;
    const evictionStarted = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver: undefined as unknown as ConversationBackendDriver,
    };
    const completion = vi.fn<AuthoritativeCompletionObserver>(() => {
      // Production durably observes completion in this awaited callback, then
      // owns uncertain runtime recovery in a deferred, shutdown-tracked task.
      followUp.defer(async () => {
        await evictionStarted;
        const recovered = await manager.acquire(input);
        recovered.release();
        recoveryCompleted = true;
      });
    });
    const current = fixture(completion);
    manager = current.manager;
    input.driver = current.driver;
    current.handle.close.mockImplementationOnce(async () => {
      current.closeOrder.push("handle-close");
      releaseRecovery();
    });
    current.handle.establishmentSnapshots[0] = snapshot();
    const acquired = await manager.acquire(input);

    current.handle.emit(0, {
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["uncertain-operation"],
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T12:00:00.000Z",
        orderedBackendItemIds: ["item-1"],
      },
    });
    await vi.waitFor(() => expect(completion).toHaveBeenCalledOnce());
    acquired.release();

    await vi.waitFor(() => expect(current.handle.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(recoveryCompleted).toBe(true));
    expect(backgroundErrors).toEqual([]);
    expect(current.driver.attach).toHaveBeenCalledTimes(2);

    await followUp.close();
    await manager.close();
  });

  it("publishes newly correlated active turn updates as submissions", async () => {
    const submission = vi.fn<AuthoritativeSubmissionObserver>();
    const { driver, handle, manager } = fixture(undefined, submission);
    handle.establishmentSnapshots[0] = snapshot("running", "a");
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });

    handle.emit(0, {
      type: "turn_updated",
      turn: {
        ...snapshot("running", "a").turnsById["turn-1"]!,
        completionCorrelations: ["uncertain-steer"],
      },
    });
    await vi.waitFor(() =>
      expect(submission).toHaveBeenCalledWith(
        scope,
        binding.applicationThreadId,
        {
          backendCorrelation: "uncertain-steer",
          backendTurnId: "turn-1",
        },
      ),
    );

    acquired.release();
    await manager.close();
  });

  it("continues reverse-order cleanup when unsubscribe and handle close fail", async () => {
    const { closeOrder, driver, handle, lease, manager } = fixture();
    handle.throwOnUnsubscribe = true;
    handle.close.mockImplementationOnce(async () => {
      closeOrder.push("handle-close");
      throw new Error("handle_close_failed");
    });
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    acquired.release();
    await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
    expect(closeOrder).toEqual([
      "unsubscribe-0",
      "handle-close",
      "lease-release",
    ]);
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("removes a subscriber whose initial snapshot callback throws", async () => {
    const { driver, handle, manager } = fixture();
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const listener = vi.fn(() => {
      throw new Error("subscriber_failed");
    });
    expect(() => acquired.actor.subscribe(listener)).toThrow(
      "subscriber_failed",
    );
    handle.emit(0, {
      type: "notice",
      notice: {
        id: "undelivered-notice",
        tone: "info",
        message: { text: "not delivered" },
        createdAt: "2026-07-30T12:00:00.000Z",
      },
    });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    acquired.release();
    const firstClose = manager.close();
    const secondClose = manager.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
  });

  it("aborts a blocked initial establishment during manager shutdown", async () => {
    const { closeOrder, driver, handle, lease, manager } = fixture();
    vi.spyOn(handle, "establishProjection").mockImplementationOnce(
      ({ signal }) =>
        new Promise<EstablishedBackendProjection>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("establishment_aborted")),
            { once: true },
          );
        }),
    );
    const acquiring = manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    await vi.waitFor(() => expect(driver.attach).toHaveBeenCalledOnce());

    const closing = manager.close();
    await expect(acquiring).rejects.toThrow(
      "Conversation actor creation was cancelled",
    );
    await expect(closing).resolves.toBeUndefined();
    expect(closeOrder).toEqual(["handle-close", "lease-release"]);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("quarantines an entry when idle eviction cannot prove handle closure", async () => {
    vi.useFakeTimers();
    try {
      const { driver, handle, manager } = fixture();
      handle.close.mockRejectedValueOnce(new Error("handle_close_failed"));
      const input = {
        scope,
        binding,
        workspace,
        opaqueBindingDetail: "opaque",
        driver,
      };
      const acquired = await manager.acquire(input);
      acquired.release();
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());

      await expect(manager.acquire(input)).rejects.toThrow(
        "conversation_actor_close_unproven",
      );
      expect(driver.attach).toHaveBeenCalledOnce();
      await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one resource-closure transition between idle and forced close", async () => {
    const { driver, handle, manager } = fixture();
    let releaseClose!: () => void;
    handle.close.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseClose = () => resolve(undefined);
        }),
    );
    const acquired = await manager.acquire({
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    });
    const idleClose = acquired.actor.closeIfIdle();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());
    expect(handle.close).toHaveBeenCalledWith({ reason: "evicted" });
    const forcedClose = acquired.actor.close();
    releaseClose();

    await expect(idleClose).resolves.toBe(true);
    await expect(forcedClose).resolves.toBeUndefined();
    expect(handle.close).toHaveBeenCalledOnce();
    acquired.release();
    await manager.close();
  });

  it("quarantines a failed creation whose attached handle did not close", async () => {
    const { driver, handle, manager } = fixture();
    vi.spyOn(handle, "establishProjection").mockRejectedValueOnce(
      new Error("establishment_failed"),
    );
    handle.close.mockRejectedValueOnce(new Error("handle_close_failed"));
    const input = {
      scope,
      binding,
      workspace,
      opaqueBindingDetail: "opaque",
      driver,
    };

    await expect(manager.acquire(input)).rejects.toBeInstanceOf(AggregateError);
    await expect(manager.acquire(input)).rejects.toThrow(
      "conversation_actor_close_unproven",
    );
    expect(driver.attach).toHaveBeenCalledOnce();
    await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("authoritative pending interaction subscription replay", () => {
  const opened: Extract<BackendConversationEvent, { type: "interaction_opened" }> = {
    type: "interaction_opened", interaction: {
      backendInteractionId: "permission-before-broker", kind: "confirmation",
      sourceLabel: { text: "Provider" }, title: { text: "Allow command?" },
      message: { text: "Run the requested command." }, openedAt: "2026-09-12T12:00:00.000Z",
      secret: false, destructive: false, cancellable: true,
    },
  };
  it("replays an early pending interaction to a late broker and never replays its settled result", async () => {
    const { manager, handle, driver } = fixture();
    const acquired = await manager.acquire({ scope, binding, workspace, opaqueBindingDetail: "opaque", driver });
    handle.emit(0, opened, 0);
    await acquired.actor.captureSnapshotState();
    const pendingEvents: ConversationActorEvent[] = [];
    const unsubscribe = acquired.actor.subscribe(event => pendingEvents.push(event));
    expect(pendingEvents[0]?.type).toBe("projection_replaced");
    expect(pendingEvents.filter(event => event.type === "backend_event" && event.event.type === "interaction_opened"))
      .toEqual([{ type: "backend_event", generation: acquired.actor.timeline.generation, event: opened }]);
    handle.emit(0, { type: "interaction_resolved", backendInteractionId: opened.interaction.backendInteractionId }, 1);
    await acquired.actor.captureSnapshotState();
    const settledEvents: ConversationActorEvent[] = [];
    const unsubscribeSettled = acquired.actor.subscribe(event => settledEvents.push(event));
    expect(settledEvents.some(event => event.type === "backend_event" && event.event.type === "interaction_opened")).toBe(false);
    unsubscribe(); unsubscribeSettled(); acquired.release(); await manager.close();
  });
  it("discards pending interactions from an obsolete projection when the authoritative replacement does not replay them", async () => {
    const { manager, handle, driver } = fixture();
    const acquired = await manager.acquire({ scope, binding, workspace, opaqueBindingDetail: "opaque", driver });
    handle.emit(0, opened, 0);
    await acquired.actor.captureSnapshotState();
    handle.emit(0, { type: "resnapshot_required", reason: "buffer_overflow" }, 1);
    await vi.waitFor(() => expect(handle.establishCount).toBe(2));
    await acquired.actor.captureSnapshotState();
    const events: ConversationActorEvent[] = [];
    const unsubscribe = acquired.actor.subscribe(event => events.push(event));
    expect(events.some(event => event.type === "backend_event" && event.event.type === "interaction_opened")).toBe(false);
    unsubscribe(); acquired.release(); await manager.close();
  });
});
