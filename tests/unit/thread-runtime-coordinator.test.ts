import { describe, expect, it, vi } from "vitest";
import type { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import type { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { runWithArchivedThreadRuntimesRetired } from "../../src/server/domain/thread-runtime-archive-retirement.js";
import {
  ConversationActorRetirementBusyError,
  ConversationActorRetirementUnprovenError,
  type AcquireConversationActorInput,
  type ConversationActorManager,
} from "../../src/server/conversations/conversation-actor-manager.js";
import type { NormalizedThreadSnapshot } from "../../src/shared/protocol/conversation.js";
import { DomainError } from "../../src/server/domain/errors.js";

const scope = { tenantId: "tenant", principalId: "principal" };

const passThroughActorRetirement: ConversationActorManager["runWithRuntimeRetired"] =
  async (input) => {
    await input.detachCoordinatorRuntime();
    return input.operation();
  };

function runtimeTarget(
  threadId: string,
  executionEnvironmentId = "environment-1",
): AcquireConversationActorInput {
  return {
    scope,
    binding: {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: threadId,
      backendConversationId: `backend-${threadId}`,
      backendInstanceId: "backend-1",
      connectionProfileId: "connection-1",
      executionEnvironmentId,
      createdAt: "2026-08-16T00:00:00.000Z",
    },
    workspace: {
      canonicalPath: "/workspace",
      summary: {
        id: "workspace-1",
        environmentId: executionEnvironmentId,
        displayName: "Workspace",
        displayPath: "/workspace",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
    execution: {
      scope,
      environmentId: executionEnvironmentId,
      workspaceId: "workspace-1",
    },
    driver: {},
    opaqueBindingDetail: "opaque",
  } as unknown as AcquireConversationActorInput;
}

function resettableActor(input: {
  generation: string;
  runState?: "idle" | "running";
  activeTurnId?: string;
  closeFailure?: Error;
  canEvict?: boolean;
}) {
  let closed = false;
  let generation = input.generation;
  const close = vi.fn(async () => {
    closed = true;
    if (input.closeFailure) throw input.closeFailure;
  });
  const closeIfIdle = vi.fn(async () => {
    if (!(input.canEvict ?? false)) return false;
    await close();
    return true;
  });
  const actor = {
    get timeline() {
      return {
        generation,
        runState: input.runState ?? "idle",
        ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
      };
    },
    get closed() {
      return closed;
    },
    get replacementSafe() {
      return closed && !input.closeFailure;
    },
    canEvict: input.canEvict ?? false,
    close,
    closeIfIdle,
    ensureProjectionCurrent: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    onClosed: vi.fn(() => () => undefined),
    setGeneration(next: string) {
      generation = next;
    },
  } as unknown as ConversationActor & { setGeneration(next: string): void };
  return { actor, close, closeIfIdle };
}

function resetCoordinator(
  actors: readonly ConversationActor[],
  retentionMilliseconds = 60_000,
  resolveTarget: (
    threadId: string,
  ) => AcquireConversationActorInput = runtimeTarget,
  hubs = new ScopedThreadEventHubRegistry(),
  bridgeReady = Promise.resolve(),
) {
  const actorRelease = actors.map(() => vi.fn());
  let actorIndex = 0;
  const actorsByThreadId = new Map<string, ConversationActor>();
  const replacementPublications: ReturnType<typeof vi.fn>[] = [];
  const coordinator = new ThreadRuntimeCoordinator({
    actors: {
      acquire: vi.fn(async (input: AcquireConversationActorInput) => {
        const index = actorIndex++;
        const actor = actors[index]!;
        actorsByThreadId.set(input.binding.applicationThreadId, actor);
        return { actor, release: actorRelease[index]! };
      }),
      runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
      runWithRuntimeRetired: vi.fn(async (input) => {
        await input.detachCoordinatorRuntime();
        const actor = actorsByThreadId.get(input.applicationThreadId);
        if (actor) {
          if (!actor.canEvict) throw new ConversationActorRetirementBusyError();
          try {
            const closed = await actor.closeIfIdle();
            if (!closed) throw new ConversationActorRetirementBusyError();
            if (!actor.replacementSafe) {
              throw new ConversationActorRetirementUnprovenError(
                new Error("conversation_actor_close_unproven"),
              );
            }
          } catch (error) {
            if (
              error instanceof ConversationActorRetirementBusyError ||
              error instanceof ConversationActorRetirementUnprovenError
            ) {
              throw error;
            }
            throw new ConversationActorRetirementUnprovenError(error);
          }
        }
        return input.operation();
      }),
    },
    targets: {
      resolve: vi.fn(async (_scope, threadId) => resolveTarget(threadId)),
    },
    bridge: {
      bind: () => {
        const publishAuthoritativeReplacement = vi.fn(async () => ({
          eventId: "hub.1",
        }));
        replacementPublications.push(publishAuthoritativeReplacement);
        return {
          ready: bridgeReady,
          publishAuthoritativeReplacement,
          release: vi.fn(async () => undefined),
        };
      },
    } as unknown as ConversationEventBridge,
    interactions: {
      bind: () => ({
        publishPending: vi.fn(),
        release: vi.fn(async () => undefined),
      }),
    } as never,
    hubs,
    retentionMilliseconds,
  });
  return { coordinator, actorRelease, replacementPublications };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

type ApplicationOverlay = Awaited<ReturnType<Parameters<
  ThreadRuntimeCoordinator["publishApplicationIncrementalsIfLoaded"]
>[2]>>;

function overlayRevision(revision: number): ApplicationOverlay {
  return { thread: { threadRevision: revision } } as ApplicationOverlay;
}

function pendingOverlayFixture() {
  const threadId = "thread-pending-overlay";
  const bound = deferred<void>();
  const bridgeReady = deferred<void>();
  const actorRelease = vi.fn();
  const hubRelease = vi.fn();
  const bridgeRelease = vi.fn(async () => undefined);
  const bridgeDetach = vi.fn();
  const interactionRelease = vi.fn(async () => undefined);
  const interactionDetach = vi.fn();
  const ensureProjectionCurrent = vi.fn(async () => undefined);
  const actorState = { marker: "actor", timeline: { generation: "generation-1", runState: "idle" } };
  const actor = {
    timeline: actorState.timeline,
    canEvict: true,
    closed: false,
    ensureProjectionCurrent,
    peekSnapshotState: vi.fn(() => actorState),
  } as unknown as ConversationActor;
  const hub = {
    projectionGeneration: "generation-1",
    snapshot: overlayRevision(1) as NormalizedThreadSnapshot,
    subscriberCount: 0,
    subscribeInternal: vi.fn(() => ({ close: vi.fn() })),
    onSubscriberCountChanged: vi.fn(() => vi.fn()),
    publish: vi.fn(),
  };
  const coordinator = new ThreadRuntimeCoordinator({
    actors: {
      acquire: vi.fn(async () => ({ actor, release: actorRelease })),
      runWithRuntimesStopped: async () => {
        throw new Error("unexpected_explicit_runtime_stop");
      },
      runWithRuntimeRetired: passThroughActorRetirement,
    },
    targets: {
      resolve: vi.fn(async (_scope, id) => runtimeTarget(id)),
    },
    bridge: {
      bind: () => {
        bound.resolve();
        return {
          ready: bridgeReady.promise,
          publishAuthoritativeReplacement: vi.fn(),
          release: bridgeRelease,
          detach: bridgeDetach,
        };
      },
    } as unknown as ConversationEventBridge,
    interactions: {
      bind: () => ({
        publishPending: vi.fn(),
        release: interactionRelease,
        detach: interactionDetach,
      }),
    } as never,
    hubs: {
      acquire: () => ({ hub, release: hubRelease }),
    } as never,
    retentionMilliseconds: 60_000,
  });
  const acquisition = coordinator.acquire(scope, threadId);
  void acquisition.catch(() => undefined);
  const createEvents = vi.fn((
    generation: string,
    _current: NormalizedThreadSnapshot,
    state: ApplicationOverlay,
  ) => [{ type: "application_state_changed" as const, generation, state }]);
  return {
    coordinator, threadId, acquisition, bound, bridgeReady, actorState, actor, hub,
    createEvents, ensureProjectionCurrent, actorRelease, hubRelease,
    bridgeRelease, bridgeDetach, interactionRelease, interactionDetach,
    publish: (capture: () => Promise<ApplicationOverlay>, events = createEvents) =>
      coordinator.publishApplicationIncrementalsIfLoaded(
        scope, threadId, capture, events,
      ),
  };
}

describe("ThreadRuntimeCoordinator", () => {
  it("publishes usage hints only for an admitted loaded actor and matching projection generation", async () => {
    const fixture=pendingOverlayFixture();
    expect(fixture.coordinator.publishUsageRevisionIfLoaded(scope,"dormant-thread","1")).toBe(false);
    await fixture.bound.promise;fixture.bridgeReady.resolve();const lease=await fixture.acquisition;
    expect(fixture.coordinator.publishUsageRevisionIfLoaded({...scope,principalId:"other"},fixture.threadId,"1")).toBe(false);
    expect(fixture.coordinator.publishUsageRevisionIfLoaded(scope,fixture.threadId,"1")).toBe(true);
    expect(fixture.hub.publish).toHaveBeenLastCalledWith({type:"usage_revision_changed",generation:"generation-1",revision:"1"});
    const actor=fixture.actor as unknown as {timeline:{generation:string};closed:boolean};
    actor.timeline.generation="generation-2";fixture.hub.publish.mockClear();
    expect(fixture.coordinator.publishUsageRevisionIfLoaded(scope,fixture.threadId,"2")).toBe(false);
    expect(fixture.hub.publish).not.toHaveBeenCalled();
    fixture.hub.projectionGeneration="generation-2";
    expect(fixture.coordinator.publishUsageRevisionIfLoaded(scope,fixture.threadId,"2")).toBe(true);
    actor.closed=true;
    expect(fixture.coordinator.publishUsageRevisionIfLoaded(scope,fixture.threadId,"3")).toBe(false);
    actor.closed=false;lease.release();await fixture.coordinator.close();
  });

  it("accepts zero retention and rejects values beyond the timer ceiling", () => {
    const input = {
      actors: {
        acquire: vi.fn(),
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
      },
      targets: { resolve: vi.fn() } as never,
      bridge: {} as never,
      interactions: {} as never,
      hubs: new ScopedThreadEventHubRegistry(),
    };
    expect(
      () =>
        new ThreadRuntimeCoordinator({
          ...input,
          retentionMilliseconds: 0,
        }),
    ).not.toThrow();
    expect(
      () =>
        new ThreadRuntimeCoordinator({
          ...input,
          retentionMilliseconds: 2_147_483_647,
        }),
    ).not.toThrow();
    expect(
      () =>
        new ThreadRuntimeCoordinator({
          ...input,
          retentionMilliseconds: 2_147_483_648,
        }),
    ).toThrow("conversation_retention_milliseconds_invalid");
  });

  it("preserves the original idle deadline across passive loaded-state reads", async () => {
    vi.useFakeTimers();
    try {
      const current = resettableActor({
        generation: "generation-1",
        canEvict: true,
      });
      const { coordinator, actorRelease } = resetCoordinator(
        [current.actor],
        10,
      );
      const runtime = await coordinator.acquire(scope, "thread-1");
      runtime.release();
      await vi.advanceTimersByTimeAsync(9);

      await expect(
        coordinator.captureLoadedState(scope, "thread-1"),
      ).resolves.toEqual({ runState: "idle" });
      await vi.advanceTimersByTimeAsync(1);

      expect(actorRelease[0]).toHaveBeenCalledOnce();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts inactive thread hubs and never evicts a subscribed hub", () => {
    const registry = new ScopedThreadEventHubRegistry(2);
    const first = registry.thread(scope, "thread-1");
    const subscription = first.subscribe(() => undefined);
    registry.thread(scope, "thread-2");
    registry.thread(scope, "thread-3");

    expect(registry.size).toBe(2);
    expect(registry.thread(scope, "thread-1")).toBe(first);

    subscription.close();
    registry.release(first);
    expect(registry.size).toBe(1);
  });

  it.each([
    { phase: "establishing", cause: "quiet release" },
    { phase: "establishing", cause: "registry pressure" },
    { phase: "established", cause: "quiet release" },
    { phase: "established", cause: "registry pressure" },
  ])(
    "keeps an $phase runtime's publication hub through $cause",
    async ({ phase, cause }) => {
      const registry = new ScopedThreadEventHubRegistry(1);
      const ready = deferred<void>();
      const { actor } = resettableActor({ generation: "generation-1" });
      const { coordinator } = resetCoordinator(
        [actor],
        60_000,
        runtimeTarget,
        registry,
        ready.promise,
      );
      const acquisition = coordinator.acquire(scope, "thread-1");
      try {
        if (phase === "established") {
          ready.resolve();
          await acquisition;
        }
        await vi.waitFor(() => expect(registry.size).toBe(1));
        const originalHub = registry.thread(scope, "thread-1");
        expect(originalHub.subscriberCount).toBe(0);
        if (cause === "quiet release") {
          // Overlay publication can probe this hub while bridge setup awaits.
          const quiet = coordinator.quiet(scope, "thread-1");
          quiet.release();
        } else {
          registry.thread(scope, "thread-2");
        }
        ready.resolve();
        const runtime = await acquisition;
        const subscription = runtime.hub.subscribe(() => undefined);
        try {
          // The browser streams from the coordinator; questions publish by
          // registry lookup. These must remain the very same event stream.
          expect(runtime.hub).toBe(originalHub);
          expect(registry.thread(scope, "thread-1")).toBe(runtime.hub);
        } finally {
          subscription.close();
          runtime.release();
        }
      } finally {
        ready.resolve();
        await coordinator.close();
      }
      expect(registry.size).toBe(0);
    },
  );

  it("retains a quiet publication hub when every older hub is runtime-owned", async () => {
    const registry = new ScopedThreadEventHubRegistry(1);
    const { actor } = resettableActor({ generation: "generation-1" });
    const { coordinator } = resetCoordinator(
      [actor],
      60_000,
      runtimeTarget,
      registry,
    );
    const runtime = await coordinator.acquire(scope, "thread-1");
    const quiet = coordinator.quiet(scope, "pending-thread");
    try {
      expect(registry.size).toBe(2);
      expect(registry.thread(scope, "pending-thread")).toBe(quiet.hub);
      expect(registry.thread(scope, "thread-1")).toBe(runtime.hub);
      // A pending-thread SSE subscriber may attach after asynchronous snapshot
      // composition. The publication lease must protect that gap too.
      const subscription = quiet.hub.subscribe(() => undefined);
      expect(registry.thread(scope, "pending-thread")).toBe(quiet.hub);
      subscription.close();
      quiet.release();
      expect(registry.size).toBe(1);
    } finally {
      quiet.release();
      runtime.release();
      await coordinator.close();
    }
    expect(registry.size).toBe(0);
  });

  it("releases the owned hub when bridge establishment fails", async () => {
    const registry = new ScopedThreadEventHubRegistry();
    const ready = deferred<void>();
    const { actor } = resettableActor({ generation: "generation-1" });
    const { coordinator } = resetCoordinator(
      [actor],
      60_000,
      runtimeTarget,
      registry,
      ready.promise.then(() => {
        throw new Error("bridge_setup_failed");
      }),
    );
    const acquisition = coordinator.acquire(scope, "thread-1");
    await vi.waitFor(() => expect(registry.size).toBe(1));
    ready.resolve();
    await expect(acquisition).rejects.toThrow("bridge_setup_failed");
    expect(registry.size).toBe(0);
    await coordinator.close();
  });

  it("retains runtime hub ownership until the final lease is released", () => {
    const registry = new ScopedThreadEventHubRegistry(1);
    const first = registry.acquire(scope, "thread-1");
    const second = registry.acquire(scope, "thread-1");
    first.release();
    first.release();
    registry.release(second.hub);
    registry.thread(scope, "thread-2");
    expect(registry.thread(scope, "thread-1")).toBe(second.hub);
    second.release();
    expect(registry.size).toBe(0);
  });

  it("does not deadlock when its initial summary observer reads loaded state", async () => {
    const ensureProjectionCurrent = vi.fn(async () => undefined);
    const actor = {
      timeline: { runState: "idle" },
      canEvict: true,
      subscribe: () => () => undefined,
      ensureProjectionCurrent,
    } as unknown as ConversationActor;
    const actorRelease = vi.fn();
    const bridgeRelease = vi.fn(async () => undefined);
    const publishAuthoritativeReplacement = vi.fn(async () => ({
      eventId: "hub.2",
    }));
    const interactionRelease = vi.fn(async () => undefined);
    const publishPending = vi.fn();
    const bridgeBinding = {
      ready: Promise.resolve(),
      opened: vi.fn(),
      resolved: vi.fn(),
      publishAuthoritativeReplacement,
      release: bridgeRelease,
    };
    const bindInteraction = vi.fn(() => ({
      publishPending,
      release: interactionRelease,
    }));
    const onThreadChanged = vi.fn();
    const observedLoadedStates: unknown[] = [];
    let coordinator!: ThreadRuntimeCoordinator;

    coordinator = new ThreadRuntimeCoordinator({
      actors: {
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
        acquire: vi.fn(async () => ({
          actor,
          release: actorRelease,
        })),
      },
      targets: {
        resolve: vi.fn(
          async () =>
            ({
              scope,
              binding: {
                tenantId: scope.tenantId,
                ownerPrincipalId: scope.principalId,
                applicationThreadId: "thread-1",
                backendConversationId: "backend-thread-1",
                backendInstanceId: "backend-1",
                connectionProfileId: "connection-1",
                executionEnvironmentId: "environment-1",
                createdAt: "2026-07-30T12:00:00.000Z",
              },
              workspace: {
                canonicalPath: "/workspace",
                summary: {
                  id: "workspace-1",
                  environmentId: "environment-1",
                  displayName: "Workspace",
                  displayPath: "/workspace",
                  availability: "available",
                  trustState: "trusted",
                  revision: 0,
                },
              },
              execution: {
                scope,
                environmentId: "environment-1",
                workspaceId: "workspace-1",
              },
              driver: {},
              opaqueBindingDetail: "opaque",
            }) as unknown as AcquireConversationActorInput,
        ),
      },
      bridge: {
        bind: () => bridgeBinding,
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: bindInteraction,
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 0,
      onThreadChanged: async (eventScope, threadId) => {
        onThreadChanged(eventScope, threadId);
        observedLoadedStates.push(
          await coordinator.captureLoadedState(eventScope, threadId),
        );
      },
    });

    const runtime = await coordinator.acquire(scope, "thread-1");
    expect(publishPending).toHaveBeenCalledOnce();
    expect(bindInteraction).toHaveBeenCalledWith(
      scope,
      "thread-1",
      actor,
      bridgeBinding,
    );
    await expect(
      coordinator.publishAuthoritativeReplacementIfLoaded(scope, "thread-1"),
    ).resolves.toBe(true);
    expect(publishAuthoritativeReplacement).toHaveBeenCalledOnce();
    runtime.release();
    const reopened = await coordinator.acquire(scope, "thread-1");
    reopened.release();
    await vi.waitFor(() => expect(onThreadChanged).toHaveBeenCalledOnce());
    expect(observedLoadedStates).toEqual([{ runState: "idle" }]);
    await expect(
      coordinator.captureLoadedState(scope, "thread-1"),
    ).resolves.toEqual({ runState: "idle" });
    expect(ensureProjectionCurrent).toHaveBeenCalledTimes(2);
    await coordinator.close();

    expect(actorRelease).toHaveBeenCalledOnce();
    expect(bridgeRelease).toHaveBeenCalledOnce();
    expect(interactionRelease).toHaveBeenCalledOnce();
  });

  it("does not attach a dormant runtime for an authoritative replacement", async () => {
    const acquire = vi.fn();
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire,
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
      },
      targets: { resolve: vi.fn() } as never,
      bridge: {} as never,
      interactions: {} as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 0,
    });

    await expect(
      coordinator.publishAuthoritativeReplacementIfLoaded(
        scope,
        "thread-dormant",
      ),
    ).resolves.toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("force-resets an exact running subscribed runtime and reattaches into its retained hub", async () => {
    const first = resettableActor({
      generation: "generation-1",
      runState: "running",
      activeTurnId: "turn-1",
    });
    const second = resettableActor({ generation: "generation-2" });
    const { coordinator, actorRelease, replacementPublications } =
      resetCoordinator([first.actor, second.actor]);
    const acquired = await coordinator.acquire(scope, "thread-reset-running");
    const subscriber = acquired.hub.subscribe(() => undefined);
    const evidence = await coordinator.captureLoadedRuntime(
      scope,
      "thread-reset-running",
    );

    await expect(
      coordinator.forceResetLoadedRuntime(
        scope,
        "thread-reset-running",
        evidence!,
      ),
    ).resolves.toBe(true);

    expect(first.close).toHaveBeenCalledOnce();
    expect(actorRelease[0]).toHaveBeenCalledOnce();
    expect(replacementPublications[1]).toHaveBeenCalledOnce();
    const replacement = await coordinator.acquire(
      scope,
      "thread-reset-running",
    );
    expect(replacement.hub).toBe(acquired.hub);
    replacement.release();
    acquired.release();
    subscriber.close();
    await coordinator.close();
  });

  it("force-resets a pending establishment only after its cancellation cleanup settles", async () => {
    const firstTarget = deferred<AcquireConversationActorInput>();
    const actor = resettableActor({ generation: "generation-2" });
    const acquireActor = vi.fn(async () => ({
      actor: actor.actor,
      release: vi.fn(),
    }));
    const resolve = vi
      .fn()
      .mockImplementationOnce(() => firstTarget.promise)
      .mockImplementation(async (_scope, threadId) => runtimeTarget(threadId));
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: acquireActor,
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
      },
      targets: { resolve } as never,
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(async () => ({
            eventId: "hub.1",
          })),
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
    const initial = coordinator.acquire(scope, "thread-reset-starting");
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const evidence = await coordinator.captureLoadedRuntime(
      scope,
      "thread-reset-starting",
    );
    expect(evidence).toMatchObject({ runState: "starting" });

    await expect(
      coordinator.forceResetLoadedRuntime(
        scope,
        "thread-reset-starting",
        evidence!,
      ),
    ).resolves.toBe(true);
    await expect(initial).rejects.toThrow("thread_runtime_force_reset");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(acquireActor).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("does not retire a runtime whose generation changed after preview", async () => {
    const current = resettableActor({
      generation: "generation-1",
      runState: "running",
      activeTurnId: "turn-1",
    });
    const { coordinator } = resetCoordinator([current.actor]);
    const acquired = await coordinator.acquire(scope, "thread-reset-stale");
    const evidence = await coordinator.captureLoadedRuntime(
      scope,
      "thread-reset-stale",
    );
    current.actor.setGeneration("generation-2");

    await expect(
      coordinator.forceResetLoadedRuntime(
        scope,
        "thread-reset-stale",
        evidence!,
      ),
    ).resolves.toBe(false);
    expect(current.close).not.toHaveBeenCalled();
    acquired.release();
    await coordinator.close();
  });

  it("fences the old entry when close is unproved and never creates a competing runtime", async () => {
    const failure = new Error("close failed");
    const current = resettableActor({
      generation: "generation-1",
      runState: "running",
      activeTurnId: "turn-1",
      closeFailure: failure,
    });
    const replacement = resettableActor({ generation: "generation-2" });
    const { coordinator } = resetCoordinator([
      current.actor,
      replacement.actor,
    ]);
    const acquired = await coordinator.acquire(scope, "thread-reset-poison");
    const evidence = await coordinator.captureLoadedRuntime(
      scope,
      "thread-reset-poison",
    );

    await expect(
      coordinator.forceResetLoadedRuntime(
        scope,
        "thread-reset-poison",
        evidence!,
      ),
    ).rejects.toThrow("close failed");
    await expect(
      coordinator.acquire(scope, "thread-reset-poison"),
    ).rejects.toThrow("close failed");
    expect(replacement.close).not.toHaveBeenCalled();
    acquired.release();
    await expect(coordinator.close()).rejects.toThrow(
      "One or more thread runtimes did not close cleanly",
    );
  });

  it("retires an idle loaded runtime before maintenance and fences reattachment through the operation", async () => {
    const first = resettableActor({
      generation: "generation-1",
      canEvict: true,
    });
    const second = resettableActor({ generation: "generation-2" });
    const { coordinator, actorRelease } = resetCoordinator([
      first.actor,
      second.actor,
    ]);
    const acquired = await coordinator.acquire(scope, "thread-maintenance");
    const operationGate = deferred<void>();
    let operationStarted = false;
    const maintenance = coordinator.runWithRuntimeRetired(
      scope,
      "thread-maintenance",
      async () => {
        operationStarted = true;
        await operationGate.promise;
        return "done";
      },
    );
    await vi.waitFor(() => expect(operationStarted).toBe(true));
    expect(first.close).toHaveBeenCalledOnce();
    expect(actorRelease[0]).toHaveBeenCalledOnce();

    let reacquired = false;
    const concurrent = coordinator
      .acquire(scope, "thread-maintenance")
      .then((value) => {
        reacquired = true;
        return value;
      });
    await Promise.resolve();
    expect(reacquired).toBe(false);

    operationGate.resolve();
    await expect(maintenance).resolves.toBe("done");
    const replacement = await concurrent;
    expect(reacquired).toBe(true);
    replacement.release();
    acquired.release();
    await coordinator.close();
  });

  it("propagates operation failures after runtime retirement is proven", async () => {
    const first = resettableActor({
      generation: "generation-1",
      canEvict: true,
    });
    const second = resettableActor({ generation: "generation-2" });
    const { coordinator } = resetCoordinator([first.actor, second.actor]);
    const current = await coordinator.acquire(
      scope,
      "thread-maintenance-operation-failure",
    );
    const failure = new Error("archive_commit_failed");
    const operationGate = deferred<void>();
    let operationStarted = false;

    const maintenance = coordinator.runWithRuntimeRetired(
      scope,
      "thread-maintenance-operation-failure",
      async () => {
        operationStarted = true;
        await operationGate.promise;
        throw failure;
      },
    );
    await vi.waitFor(() => expect(operationStarted).toBe(true));
    let concurrentSettled = false;
    const concurrent = coordinator
      .acquire(scope, "thread-maintenance-operation-failure")
      .finally(() => {
        concurrentSettled = true;
      });
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);

    operationGate.resolve();
    await expect(maintenance).rejects.toBe(failure);
    const replacement = await concurrent;
    replacement.release();
    current.release();
    await coordinator.close();
  });

  it("preserves a nested busy-runtime result through an outer retirement fence", async () => {
    const outer = resettableActor({
      generation: "generation-outer",
      canEvict: true,
    });
    const busy = resettableActor({
      generation: "generation-busy",
      runState: "running",
    });
    const { coordinator } = resetCoordinator([outer.actor, busy.actor]);
    const outerRuntime = await coordinator.acquire(
      scope,
      "thread-family-a-outer",
    );
    const busyRuntime = await coordinator.acquire(
      scope,
      "thread-family-b-busy",
    );

    await expect(
      runWithArchivedThreadRuntimesRetired({
        scope,
        threadIds: ["thread-family-a-outer", "thread-family-b-busy"],
        runtimes: coordinator,
        operation: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-family-a-outer",
        async () => "retried",
      ),
    ).resolves.toBe("retried");

    busyRuntime.release();
    outerRuntime.release();
    await coordinator.close();
  });

  it("releases provider residency of an unloaded thread and treats outstanding provider work as busy", async () => {
    const outcomes = new Map<string, "released" | "busy" | Error>([
      ["thread-released", "released"],
      ["thread-busy", "busy"],
      ["thread-unreachable", new Error("sidecar_unreachable")],
    ]);
    const release = vi.fn(async (input: { binding: { applicationThreadId: string } }) => {
      const outcome = outcomes.get(input.binding.applicationThreadId)!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const { coordinator } = resetCoordinator([], 60_000, (threadId) => {
      if (threadId === "thread-unbound") {
        throw new DomainError("not_found", "Thread has no backend conversation.");
      }
      const target = runtimeTarget(threadId);
      return {
        ...target,
        driver: threadId === "thread-no-residency" ? {} : { releaseConversationResidency: release },
      } as unknown as AcquireConversationActorInput;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(coordinator.releaseProviderResidency(scope, "thread-released")).resolves.toBeUndefined();
      expect(release).toHaveBeenLastCalledWith(expect.objectContaining({
        binding: expect.objectContaining({ backendConversationId: "backend-thread-released" }),
        workspace: expect.objectContaining({ canonicalPath: "/workspace" }),
        opaqueBindingDetail: "opaque",
      }));
      await expect(coordinator.releaseProviderResidency(scope, "thread-busy"))
        .rejects.toBeInstanceOf(ThreadRuntimeNotIdleError);
      await expect(coordinator.releaseProviderResidency(scope, "thread-unreachable")).resolves.toBeUndefined();
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(
        "Release of thread thread-unreachable provider residency failed: sidecar_unreachable",
      );
      await expect(coordinator.releaseProviderResidency(scope, "thread-unbound")).resolves.toBeUndefined();
      await expect(coordinator.releaseProviderResidency(scope, "thread-no-residency")).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(3);
    } finally {
      stderr.mockRestore();
      await coordinator.close();
    }
  });

  it("refuses an archive fence whose provider work is outstanding and leaves later retirement usable", async () => {
    const release = vi.fn(async (input: { binding: { applicationThreadId: string } }) =>
      input.binding.applicationThreadId === "thread-remote-busy" ? "busy" as const : "released" as const);
    const { coordinator } = resetCoordinator([], 60_000, (threadId) => ({
      ...runtimeTarget(threadId),
      driver: { releaseConversationResidency: release },
    }) as unknown as AcquireConversationActorInput);
    const operation = vi.fn(async () => undefined);
    await expect(
      runWithArchivedThreadRuntimesRetired({
        scope,
        threadIds: ["thread-remote-idle", "thread-remote-busy"],
        runtimes: coordinator,
        operation,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(operation).not.toHaveBeenCalled();
    await expect(
      runWithArchivedThreadRuntimesRetired({
        scope,
        threadIds: ["thread-remote-idle"],
        runtimes: coordinator,
        operation,
      }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("classifies a non-idle runtime without poisoning later acquisition", async () => {
    const actor = resettableActor({
      generation: "generation-1",
      runState: "running",
    });
    const { coordinator } = resetCoordinator([actor.actor]);
    const acquired = await coordinator.acquire(
      scope,
      "thread-maintenance-busy",
    );
    const operation = vi.fn(async () => undefined);

    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-maintenance-busy",
        operation,
      ),
    ).rejects.toBeInstanceOf(ThreadRuntimeNotIdleError);
    expect(operation).not.toHaveBeenCalled();
    expect(actor.close).not.toHaveBeenCalled();

    const concurrent = await coordinator.acquire(
      scope,
      "thread-maintenance-busy",
    );
    concurrent.release();
    acquired.release();
    await coordinator.close();
  });

  it("pressure retirement releases only the coordinator owner", async () => {
    let canEvict = true;
    const close = vi.fn(async () => undefined);
    const closeIfIdle = vi.fn(async () => {
      canEvict = false;
      return false;
    });
    const actor = {
      timeline: { runState: "idle" },
      get canEvict() {
        return canEvict;
      },
      closed: false,
      replacementSafe: false,
      close,
      closeIfIdle,
      ensureProjectionCurrent: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      onClosed: vi.fn(() => () => undefined),
    } as unknown as ConversationActor;
    const { coordinator, actorRelease } = resetCoordinator([actor]);
    const acquired = await coordinator.acquire(scope, "thread-pressure-race");
    acquired.release();

    const reclamation = coordinator.tryReclaimOldestIdleRuntime({
      budgetScope: {
        ...scope,
        executionEnvironmentId: "environment-1",
      },
    });
    expect(reclamation).toBeDefined();
    await expect(reclamation!.completion).resolves.toBeUndefined();
    expect(closeIfIdle).not.toHaveBeenCalled();
    expect(actorRelease[0]).toHaveBeenCalledOnce();
    await coordinator.close();
    expect(close).not.toHaveBeenCalled();
  });

  it("selects pressure victims only from the requested execution environment", async () => {
    const environmentBActor = resettableActor({
      generation: "generation-b",
      canEvict: true,
    });
    const environmentAActor = resettableActor({
      generation: "generation-a",
      canEvict: true,
    });
    const { coordinator, actorRelease } = resetCoordinator(
      [environmentBActor.actor, environmentAActor.actor],
      60_000,
      (threadId) =>
        runtimeTarget(
          threadId,
          threadId === "thread-0-environment-b"
            ? "environment-b"
            : "environment-a",
        ),
    );
    const environmentB = await coordinator.acquire(
      scope,
      "thread-0-environment-b",
    );
    environmentB.release();
    const environmentA = await coordinator.acquire(
      scope,
      "thread-z-environment-a",
    );
    environmentA.release();

    const reclamation = coordinator.tryReclaimOldestIdleRuntime({
      budgetScope: {
        ...scope,
        executionEnvironmentId: "environment-a",
      },
    });
    expect(reclamation).toBeDefined();
    await expect(reclamation!.completion).resolves.toBeUndefined();
    expect(actorRelease[0]).not.toHaveBeenCalled();
    expect(actorRelease[1]).toHaveBeenCalledOnce();

    await coordinator.close();
  });

  it("lets a claimed pressure owner release finish during coordinator close", async () => {
    let closed = false;
    const close = vi.fn(async () => {
      closed = true;
    });
    const closeIfIdle = vi.fn(async () => {
      closed = true;
      return true;
    });
    const actor = {
      timeline: { runState: "idle" },
      canEvict: true,
      get closed() {
        return closed;
      },
      get replacementSafe() {
        return closed;
      },
      close,
      closeIfIdle,
      ensureProjectionCurrent: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      onClosed: vi.fn(() => () => undefined),
    } as unknown as ConversationActor;
    const { coordinator, actorRelease } = resetCoordinator([actor]);
    const acquired = await coordinator.acquire(scope, "thread-pressure-close");
    acquired.release();
    const reclamation = coordinator.tryReclaimOldestIdleRuntime({
      budgetScope: {
        ...scope,
        executionEnvironmentId: "environment-1",
      },
    });
    expect(reclamation).toBeDefined();
    const closing = coordinator.close();
    await expect(reclamation!.completion).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(actorRelease[0]).toHaveBeenCalledOnce();
    expect(closeIfIdle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("fences acquisition when maintenance begins without a loaded runtime", async () => {
    const actor = resettableActor({ generation: "generation-1" });
    const { coordinator } = resetCoordinator([actor.actor]);
    const operationGate = deferred<void>();
    let operationStarted = false;
    const maintenance = coordinator.runWithRuntimeRetired(
      scope,
      "thread-empty-maintenance",
      async () => {
        operationStarted = true;
        await operationGate.promise;
      },
    );
    await vi.waitFor(() => expect(operationStarted).toBe(true));

    let acquired = false;
    const concurrent = coordinator
      .acquire(scope, "thread-empty-maintenance")
      .then((value) => {
        acquired = true;
        return value;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);

    operationGate.resolve();
    await maintenance;
    const runtime = await concurrent;
    expect(acquired).toBe(true);
    runtime.release();
    await coordinator.close();
  });

  it("cancels pending establishment before maintenance begins", async () => {
    const firstTarget = deferred<AcquireConversationActorInput>();
    const resolve = vi.fn(() => firstTarget.promise);
    const acquireActor = vi.fn();
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: acquireActor,
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: async (input) => {
          await input.detachCoordinatorRuntime();
          return input.operation();
        },
      },
      targets: { resolve } as never,
      bridge: {} as never,
      interactions: {} as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    const initial = coordinator.acquire(scope, "thread-maintenance-starting");
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const operation = vi.fn(async () => undefined);

    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-maintenance-starting",
        operation,
      ),
    ).resolves.toBeUndefined();
    await expect(initial).rejects.toThrow("thread_runtime_maintenance");
    expect(operation).toHaveBeenCalledOnce();
    expect(acquireActor).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("retires an establishment that resolves across the maintenance abort boundary", async () => {
    const actor = resettableActor({
      generation: "generation-1",
      canEvict: true,
    });
    const actorRelease = vi.fn();
    const bridgeReady = deferred<void>();
    const bind = vi.fn(() => ({
      ready: bridgeReady.promise,
      publishAuthoritativeReplacement: vi.fn(),
      release: vi.fn(async () => undefined),
    }));
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: vi.fn(async () => ({
          actor: actor.actor,
          release: actorRelease,
        })),
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: async (input) => {
          await input.detachCoordinatorRuntime();
          await actor.actor.closeIfIdle();
          return input.operation();
        },
      },
      targets: {
        resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
      },
      bridge: { bind } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });
    const initial = coordinator.acquire(scope, "thread-maintenance-abort-race");
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce());

    // Resolve the final establishment dependency and install maintenance in
    // the same turn. The entry promise can now win Promise.race even though
    // maintenance has already aborted its establishment signal.
    bridgeReady.resolve();
    const operation = vi.fn(async () => undefined);
    await expect(
      coordinator.runWithRuntimeRetired(
        scope,
        "thread-maintenance-abort-race",
        operation,
      ),
    ).resolves.toBeUndefined();

    const initialRuntime = await initial;
    expect(actor.close).toHaveBeenCalledOnce();
    expect(actorRelease).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    initialRuntime.release();
    await coordinator.close();
  });

  it("keeps maintenance poisoned when idle runtime close is unproved", async () => {
    const failure = new Error("maintenance close failed");
    const first = resettableActor({
      generation: "generation-1",
      canEvict: true,
      closeFailure: failure,
    });
    const second = resettableActor({ generation: "generation-2" });
    const { coordinator } = resetCoordinator([first.actor, second.actor]);
    const acquired = await coordinator.acquire(
      scope,
      "thread-maintenance-poison",
    );
    const operation = vi.fn(async () => undefined);

    const retirement = coordinator.runWithRuntimeRetired(
      scope,
      "thread-maintenance-poison",
      operation,
    );
    await expect(retirement).rejects.toMatchObject({
      name: "ThreadRuntimeRetirementUnprovenError",
      cause: failure,
    });
    expect(operation).not.toHaveBeenCalled();
    const poisonedAcquisition = coordinator.acquire(
      scope,
      "thread-maintenance-poison",
    );
    await expect(poisonedAcquisition).rejects.toBeInstanceOf(
      ThreadRuntimeRetirementUnprovenError,
    );
    expect(second.close).not.toHaveBeenCalled();
    acquired.release();
    await coordinator.close();
  });

  it("keeps the backend runtime attached while an external hub subscriber is open", async () => {
    vi.useFakeTimers();
    try {
      const actor = {
        timeline: { runState: "idle" },
        canEvict: true,
        ensureProjectionCurrent: vi.fn(async () => undefined),
      } as unknown as ConversationActor;
      const actorRelease = vi.fn();
      const bridgeRelease = vi.fn(async () => undefined);
      const interactionRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({ actor, release: actorRelease })),
        },
        targets: {
          resolve: vi.fn(
            async () =>
              ({
                scope,
                binding: {
                  tenantId: scope.tenantId,
                  ownerPrincipalId: scope.principalId,
                  applicationThreadId: "thread-subscriber-pin",
                  backendConversationId: "backend-thread-subscriber-pin",
                  backendInstanceId: "backend-1",
                  connectionProfileId: "connection-1",
                  executionEnvironmentId: "environment-1",
                  createdAt: "2026-07-30T12:00:00.000Z",
                },
                workspace: {
                  canonicalPath: "/workspace",
                  summary: {
                    id: "workspace-1",
                    environmentId: "environment-1",
                    displayName: "Workspace",
                    displayPath: "/workspace",
                    availability: "available",
                    trustState: "trusted",
                    revision: 0,
                  },
                },
                driver: {},
                opaqueBindingDetail: "opaque",
              }) as unknown as AcquireConversationActorInput,
          ),
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
            release: interactionRelease,
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 10,
      });

      const runtime = await coordinator.acquire(scope, "thread-subscriber-pin");
      const external = runtime.hub.subscribe(() => undefined);
      runtime.release();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(actorRelease).not.toHaveBeenCalled();
      expect(bridgeRelease).not.toHaveBeenCalled();
      expect(interactionRelease).not.toHaveBeenCalled();

      external.close();
      await vi.advanceTimersByTimeAsync(9);
      expect(actorRelease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(actorRelease).toHaveBeenCalledOnce();
      expect(bridgeRelease).toHaveBeenCalledOnce();
      expect(interactionRelease).toHaveBeenCalledOnce();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns pending overlay publication immediately and refreshes it before acquisition resolves", async () => {
    const current = pendingOverlayFixture();
    const captured = deferred<ApplicationOverlay>();
    const captureStarted = deferred<void>();
    const capture = vi.fn(() => {
      captureStarted.resolve();
      return captured.promise;
    });
    const acquired = vi.fn();
    void current.acquisition.then(acquired, () => undefined);
    try {
      await current.bound.promise;
      await expect(current.publish(capture)).resolves.toBe(false);
      expect(capture).not.toHaveBeenCalled();
      current.bridgeReady.resolve();
      await captureStarted.promise;
      expect(acquired).not.toHaveBeenCalled();
      expect(current.ensureProjectionCurrent).not.toHaveBeenCalled();

      const fresh = overlayRevision(2);
      current.hub.projectionGeneration = "generation-2";
      current.hub.snapshot = overlayRevision(1) as NormalizedThreadSnapshot;
      captured.resolve(fresh);
      const runtime = await current.acquisition;
      expect(capture).toHaveBeenCalledExactlyOnceWith(current.actorState);
      expect(current.createEvents).toHaveBeenCalledExactlyOnceWith(
        "generation-2", current.hub.snapshot, fresh,
      );
      expect(current.createEvents.mock.calls[0]![1]).toBe(current.hub.snapshot);
      expect(current.hub.publish).toHaveBeenCalledExactlyOnceWith({
        type: "application_state_changed", generation: "generation-2", state: fresh,
      });
      expect(current.hub.publish.mock.invocationCallOrder[0]).toBeLessThan(
        current.ensureProjectionCurrent.mock.invocationCallOrder[0]!,
      );
      runtime.release();
    } finally {
      await current.coordinator.close();
    }
  });

  it("coalesces full overlay captures before and during initial synchronization", async () => {
    const current = pendingOverlayFixture();
    const obsolete = vi.fn(async () => overlayRevision(2));
    const firstResult = deferred<ApplicationOverlay>();
    const firstStarted = deferred<void>();
    const first = vi.fn(() => {
      firstStarted.resolve();
      return firstResult.promise;
    });
    const superseded = vi.fn(async () => overlayRevision(4));
    const latestResult = deferred<ApplicationOverlay>();
    const latestStarted = deferred<void>();
    const latest = vi.fn(() => {
      latestStarted.resolve();
      return latestResult.promise;
    });
    const acquired = vi.fn();
    void current.acquisition.then(acquired, () => undefined);
    try {
      await current.bound.promise;
      await expect(current.publish(obsolete)).resolves.toBe(false);
      await expect(current.publish(first)).resolves.toBe(false);
      current.bridgeReady.resolve();
      await firstStarted.promise;
      expect(obsolete).not.toHaveBeenCalled();
      await expect(current.publish(superseded)).resolves.toBe(false);
      await expect(current.publish(latest)).resolves.toBe(false);
      firstResult.resolve(overlayRevision(3));
      await latestStarted.promise;
      expect(superseded).not.toHaveBeenCalled();
      expect(current.createEvents).not.toHaveBeenCalled();
      expect(current.hub.publish).not.toHaveBeenCalled();
      expect(acquired).not.toHaveBeenCalled();

      const fresh = overlayRevision(5);
      latestResult.resolve(fresh);
      const runtime = await current.acquisition;
      expect(first).toHaveBeenCalledOnce();
      expect(latest).toHaveBeenCalledOnce();
      expect(current.hub.publish).toHaveBeenCalledExactlyOnceWith({
        type: "application_state_changed", generation: "generation-1", state: fresh,
      });
      const loadedCapture = vi.fn(async () => overlayRevision(6));
      await expect(current.publish(loadedCapture)).resolves.toBe(true);
      expect(loadedCapture).toHaveBeenCalledOnce();
      expect(current.hub.publish).toHaveBeenCalledTimes(2);
      runtime.release();
    } finally {
      await current.coordinator.close();
    }
  });

  it("releases established resources when pending overlay capture fails", async () => {
    const current = pendingOverlayFixture();
    const failure = new Error("application overlay capture failed");
    try {
      await current.bound.promise;
      await expect(current.publish(async () => { throw failure; })).resolves.toBe(false);
      current.bridgeReady.resolve();
      await expect(current.acquisition).rejects.toBe(failure);
      expect(current.createEvents).not.toHaveBeenCalled();
      expect(current.hub.publish).not.toHaveBeenCalled();
      expect(current.ensureProjectionCurrent).not.toHaveBeenCalled();
      expect(current.bridgeRelease).toHaveBeenCalledOnce();
      expect(current.interactionRelease).toHaveBeenCalledOnce();
      expect(current.actorRelease).toHaveBeenCalledOnce();
      expect(current.hubRelease).toHaveBeenCalledOnce();
      await expect(current.publish(async () => overlayRevision(2))).resolves.toBe(false);
    } finally {
      await current.coordinator.close();
    }
  });

  it("aborts initial overlay capture on shutdown without publishing its late result", async () => {
    const current = pendingOverlayFixture();
    const captured = deferred<ApplicationOverlay>();
    const captureStarted = deferred<void>();
    await current.bound.promise;
    await expect(current.publish(() => {
      captureStarted.resolve();
      return captured.promise;
    })).resolves.toBe(false);
    current.bridgeReady.resolve();
    await captureStarted.promise;
    await current.coordinator.closeForShutdown();
    await expect(current.acquisition).rejects.toThrow("thread_runtime_shutdown");
    expect(current.bridgeDetach).toHaveBeenCalledOnce();
    expect(current.interactionDetach).toHaveBeenCalledOnce();
    expect(current.actorRelease).toHaveBeenCalledOnce();
    expect(current.hubRelease).toHaveBeenCalledOnce();

    captured.resolve(overlayRevision(2));
    await captured.promise;
    await Promise.resolve();
    expect(current.createEvents).not.toHaveBeenCalled();
    expect(current.hub.publish).not.toHaveBeenCalled();
    expect(current.ensureProjectionCurrent).not.toHaveBeenCalled();
    expect(current.bridgeRelease).not.toHaveBeenCalled();
    expect(current.interactionRelease).not.toHaveBeenCalled();
  });

  it("rejects an initial overlay result after maintenance retires its runtime", async () => {
    const current = pendingOverlayFixture();
    const captured = deferred<ApplicationOverlay>();
    const captureStarted = deferred<void>();
    try {
      await current.bound.promise;
      await expect(current.publish(() => {
        captureStarted.resolve();
        return captured.promise;
      })).resolves.toBe(false);
      current.bridgeReady.resolve();
      await captureStarted.promise;
      const maintenance = vi.fn(async () => undefined);
      await current.coordinator.runWithRuntimeRetired(
        scope, current.threadId, maintenance,
      );
      expect(maintenance).toHaveBeenCalledOnce();
      expect(current.bridgeRelease).toHaveBeenCalledOnce();
      expect(current.interactionRelease).toHaveBeenCalledOnce();
      expect(current.actorRelease).toHaveBeenCalledOnce();
      expect(current.hubRelease).toHaveBeenCalledOnce();

      captured.resolve(overlayRevision(2));
      await expect(current.acquisition).rejects.toThrow("thread_runtime_initial_overlay_unavailable");
      expect(current.createEvents).not.toHaveBeenCalled();
      expect(current.hub.publish).not.toHaveBeenCalled();
      expect(current.ensureProjectionCurrent).not.toHaveBeenCalled();
      expect(current.actorRelease).toHaveBeenCalledOnce();
    } finally {
      await current.coordinator.close();
    }
  });

  it("captures once and merges against the latest hub state without actor recovery", async () => {
    const ensureProjectionCurrent = vi.fn(async () => undefined);
    const peekSnapshotState = vi.fn(() => ({ marker: "actor" }));
    const actor = {
      timeline: { runState: "running" },
      canEvict: false,
      ensureProjectionCurrent,
      peekSnapshotState,
    } as unknown as ConversationActor;
    const baseline = {
      marker: "baseline",
    } as unknown as NormalizedThreadSnapshot;
    const bridgeAdvanced = {
      marker: "bridge-advanced",
    } as unknown as NormalizedThreadSnapshot;
    const staleCapture = {
      marker: "stale-capture",
    } as unknown as NormalizedThreadSnapshot;
    let watermark = 1;
    let current = baseline;
    const hub = {
      get projectionGeneration() {
        return "generation-1";
      },
      get snapshot() {
        return current;
      },
      get watermark() {
        return watermark;
      },
      subscriberCount: 0,
      subscribeInternal: vi.fn(() => ({ close: vi.fn() })),
      onSubscriberCountChanged: vi.fn(() => vi.fn()),
      publish: vi.fn(),
      validateCurrentSnapshot: vi.fn(),
    };
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
        acquire: vi.fn(async () => ({ actor, release: vi.fn() })),
      },
      targets: {
        resolve: vi.fn(
          async () =>
            ({
              scope,
              binding: {
                tenantId: scope.tenantId,
                ownerPrincipalId: scope.principalId,
                applicationThreadId: "thread-capture-fence",
                backendConversationId: "backend-thread-capture-fence",
                backendInstanceId: "backend-1",
                connectionProfileId: "connection-1",
                executionEnvironmentId: "environment-1",
                createdAt: "2026-07-30T12:00:00.000Z",
              },
              workspace: {
                canonicalPath: "/workspace",
                summary: {
                  id: "workspace-1",
                  environmentId: "environment-1",
                  displayName: "Workspace",
                  displayPath: "/workspace",
                  availability: "available",
                  trustState: "trusted",
                  revision: 0,
                },
              },
              driver: {},
              opaqueBindingDetail: "opaque",
            }) as unknown as AcquireConversationActorInput,
        ),
      },
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
      hubs: {
        acquire: () => ({ hub, release: vi.fn() }),
        release: vi.fn(),
      } as never,
      retentionMilliseconds: 60_000,
    });
    const runtime = await coordinator.acquire(scope, "thread-capture-fence");
    ensureProjectionCurrent.mockClear();
    const firstCapture = deferred<NormalizedThreadSnapshot>();
    const capture = vi.fn<() => Promise<NormalizedThreadSnapshot>>(
      () => firstCapture.promise,
    );
    const createEvents = vi.fn(() => []);

    const publication = coordinator.publishApplicationIncrementalsIfLoaded(
      scope,
      "thread-capture-fence",
      capture as never,
      createEvents as never,
    );
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    current = bridgeAdvanced;
    watermark += 1;
    firstCapture.resolve(staleCapture);
    await publication;

    expect(capture).toHaveBeenCalledOnce();
    expect(createEvents).toHaveBeenCalledOnce();
    expect(createEvents).toHaveBeenCalledWith(
      "generation-1",
      bridgeAdvanced,
      staleCapture,
    );
    expect(ensureProjectionCurrent).not.toHaveBeenCalled();
    expect(peekSnapshotState).toHaveBeenCalledOnce();
    expect(hub.publish).not.toHaveBeenCalled();
    runtime.release();
    await coordinator.close();
  });

  it("evicts an established runtime after projection recovery rejects during acquire", async () => {
    vi.useFakeTimers();
    try {
      const actor = {
        timeline: { runState: "idle" },
        canEvict: true,
        subscribe: () => () => undefined,
        ensureProjectionCurrent: vi.fn(async () => {
          throw new Error("projection recovery failed");
        }),
      } as unknown as ConversationActor;
      const actorRelease = vi.fn();
      const bridgeRelease = vi.fn(async () => undefined);
      const interactionRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({
            actor,
            release: actorRelease,
          })),
        },
        targets: {
          resolve: vi.fn(
            async () =>
              ({
                scope,
                binding: {
                  tenantId: scope.tenantId,
                  ownerPrincipalId: scope.principalId,
                  applicationThreadId: "thread-recovery-failure",
                  backendConversationId: "backend-thread-recovery-failure",
                  backendInstanceId: "backend-1",
                  connectionProfileId: "connection-1",
                  executionEnvironmentId: "environment-1",
                  createdAt: "2026-07-30T12:00:00.000Z",
                },
                workspace: {
                  canonicalPath: "/workspace",
                  summary: {
                    id: "workspace-1",
                    environmentId: "environment-1",
                    displayName: "Workspace",
                    displayPath: "/workspace",
                    availability: "available",
                    trustState: "trusted",
                    revision: 0,
                  },
                },
                driver: {},
                opaqueBindingDetail: "opaque",
              }) as unknown as AcquireConversationActorInput,
          ),
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
            release: interactionRelease,
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 0,
      });

      await expect(
        coordinator.acquire(scope, "thread-recovery-failure"),
      ).rejects.toThrow("projection recovery failed");
      await vi.advanceTimersByTimeAsync(0);

      expect(actorRelease).toHaveBeenCalledOnce();
      expect(bridgeRelease).toHaveBeenCalledOnce();
      expect(interactionRelease).toHaveBeenCalledOnce();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not evict a runtime reacquired while idle eviction awaits establishment", async () => {
    vi.useFakeTimers();
    try {
      const actor = {
        timeline: { runState: "idle" },
        canEvict: true,
        subscribe: () => () => undefined,
        ensureProjectionCurrent: vi.fn(async () => undefined),
      } as unknown as ConversationActor;
      const actorRelease = vi.fn();
      const bridgeRelease = vi.fn(async () => undefined);
      const interactionRelease = vi.fn(async () => undefined);
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({
            actor,
            release: actorRelease,
          })),
        },
        targets: {
          resolve: vi.fn(
            async () =>
              ({
                scope,
                binding: {
                  tenantId: scope.tenantId,
                  ownerPrincipalId: scope.principalId,
                  applicationThreadId: "thread-race",
                  backendConversationId: "backend-thread-race",
                  backendInstanceId: "backend-1",
                  connectionProfileId: "connection-1",
                  executionEnvironmentId: "environment-1",
                  createdAt: "2026-07-30T12:00:00.000Z",
                },
                workspace: {
                  canonicalPath: "/workspace",
                  summary: {
                    id: "workspace-1",
                    environmentId: "environment-1",
                    displayName: "Workspace",
                    displayPath: "/workspace",
                    availability: "available",
                    trustState: "trusted",
                    revision: 0,
                  },
                },
                driver: {},
                opaqueBindingDetail: "opaque",
              }) as unknown as AcquireConversationActorInput,
          ),
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
            release: interactionRelease,
          }),
        } as never,
        hubs: new ScopedThreadEventHubRegistry(),
        retentionMilliseconds: 0,
      });

      const first = await coordinator.acquire(scope, "thread-race");
      first.release();
      vi.advanceTimersByTime(0);
      const reacquiring = coordinator.acquire(scope, "thread-race");
      const second = await reacquiring;

      expect(actorRelease).not.toHaveBeenCalled();
      expect(bridgeRelease).not.toHaveBeenCalled();
      expect(interactionRelease).not.toHaveBeenCalled();

      second.release();
      await coordinator.close();
      expect(actorRelease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes an authoritative replacement after an established bridge reports a failure", async () => {
    const actor = {
      timeline: { runState: "idle" },
      canEvict: true,
      subscribe: () => () => undefined,
      ensureProjectionCurrent: vi.fn(async () => undefined),
    } as unknown as ConversationActor;
    const publishAuthoritativeReplacement = vi.fn(async () => ({
      eventId: "hub.2",
    }));
    let reportFailure: ((error: unknown) => void | Promise<void>) | undefined;
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
        acquire: vi.fn(async () => ({
          actor,
          release: vi.fn(),
        })),
      },
      targets: {
        resolve: vi.fn(
          async () =>
            ({
              scope,
              binding: {
                tenantId: scope.tenantId,
                ownerPrincipalId: scope.principalId,
                applicationThreadId: "thread-1",
                backendConversationId: "backend-thread-1",
                backendInstanceId: "backend-1",
                connectionProfileId: "connection-1",
                executionEnvironmentId: "environment-1",
                createdAt: "2026-07-30T12:00:00.000Z",
              },
              workspace: {
                canonicalPath: "/workspace",
                summary: {
                  id: "workspace-1",
                  environmentId: "environment-1",
                  displayName: "Workspace",
                  displayPath: "/workspace",
                  availability: "available",
                  trustState: "trusted",
                  revision: 0,
                },
              },
              execution: {
                scope,
                environmentId: "environment-1",
                workspaceId: "workspace-1",
              },
              driver: {},
              opaqueBindingDetail: "opaque",
            }) as unknown as AcquireConversationActorInput,
        ),
      },
      bridge: {
        bind: (input: {
          onFailure?: (error: unknown) => void | Promise<void>;
        }) => {
          reportFailure = input.onFailure;
          return {
            ready: Promise.resolve(),
            publishAuthoritativeReplacement,
            release: vi.fn(async () => undefined),
          };
        },
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

    const runtime = await coordinator.acquire(scope, "thread-1");
    await reportFailure?.(new Error("incremental projection failed"));

    expect(publishAuthoritativeReplacement).toHaveBeenCalledOnce();
    runtime.release();
    await coordinator.close();
  });

  it("starts retention only when an unowned runtime settles as failed", async () => {
    vi.useFakeTimers();
    try {
      let canEvict = false;
      const actorRelease = vi.fn();
      const actor = {
        timeline: { runState: "running" },
        get canEvict() {
          return canEvict;
        },
        subscribe: () => () => undefined,
        ensureProjectionCurrent: vi.fn(async () => undefined),
      } as unknown as ConversationActor;
      let summaryListener:
        | ((input: { event: { type: string; state?: string } }) => void)
        | undefined;
      const hub = {
        subscribeInternal: vi.fn(
          (
            listener: (input: {
              event: { type: string; state?: string };
            }) => void,
          ) => {
            summaryListener = listener;
            return { close: vi.fn() };
          },
        ),
        onSubscriberCountChanged: vi.fn(() => vi.fn()),
        subscriberCount: 0,
      };
      const onAuthoritativeSettled = vi.fn();
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({
            actor,
            release: actorRelease,
          })),
        },
        targets: {
          resolve: vi.fn(
            async () =>
              ({
                scope,
                binding: {
                  tenantId: scope.tenantId,
                  ownerPrincipalId: scope.principalId,
                  applicationThreadId: "thread-1",
                  backendConversationId: "backend-thread-1",
                  backendInstanceId: "backend-1",
                  connectionProfileId: "connection-1",
                  executionEnvironmentId: "environment-1",
                  createdAt: "2026-07-30T12:00:00.000Z",
                },
                workspace: {
                  canonicalPath: "/workspace",
                  summary: {
                    id: "workspace-1",
                    environmentId: "environment-1",
                    displayName: "Workspace",
                    displayPath: "/workspace",
                    availability: "available",
                    trustState: "trusted",
                    revision: 0,
                  },
                },
                execution: {
                  scope,
                  environmentId: "environment-1",
                  workspaceId: "workspace-1",
                },
                driver: {},
                opaqueBindingDetail: "opaque",
              }) as unknown as AcquireConversationActorInput,
          ),
        },
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
        hubs: {
          acquire: () => ({ hub, release: vi.fn() }),
          release: vi.fn(),
        } as never,
        retentionMilliseconds: 10,
        onAuthoritativeSettled,
      });

      const runtime = await coordinator.acquire(scope, "thread-1");
      expect(summaryListener).toBeDefined();
      runtime.release();
      await vi.advanceTimersByTimeAsync(100);
      expect(actorRelease).not.toHaveBeenCalled();

      canEvict = true;
      summaryListener!({
        event: { type: "run_state", state: "failed" },
      });
      expect(onAuthoritativeSettled).toHaveBeenCalledWith(scope, "thread-1");
      await vi.advanceTimersByTimeAsync(9);
      expect(actorRelease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(actorRelease).toHaveBeenCalledOnce();

      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts pending establishment and shares prompt shutdown detachment", async () => {
    const target = new Promise<AcquireConversationActorInput>(() => undefined);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: vi.fn(),
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
      },
      targets: { resolve: vi.fn(() => target) },
      bridge: {} as ConversationEventBridge,
      interactions: {} as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 0,
    });
    const acquisition = coordinator.acquire(scope, "thread-pending");
    await Promise.resolve();
    await expect(
      coordinator.publishApplicationIncrementalsIfLoaded(
        scope,
        "thread-pending",
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toBe(false);

    const firstClose = coordinator.closeForShutdown();
    expect(coordinator.closeForShutdown()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(acquisition).rejects.toThrow("thread_runtime_shutdown");
  });

  it("unsubscribes a bridge-ready establishment before shutdown publications can escape", async () => {
    const bridgeReady = deferred<void>();
    const actorRelease = vi.fn();
    const bridgeDetach = vi.fn();
    const interactionDetach = vi.fn();
    const onThreadChanged = vi.fn(async () => undefined);
    let summaryListener:
      | ((input: { event: { type: "run_state"; state: "idle" } }) => void)
      | undefined;
    const summaryClose = vi.fn(() => {
      summaryListener = undefined;
    });
    const hub = {
      subscribeInternal: vi.fn((listener) => {
        summaryListener = listener;
        return { close: summaryClose };
      }),
      onSubscriberCountChanged: vi.fn(() => vi.fn()),
      subscriberCount: 0,
    };
    const bind = vi.fn(() => ({
      ready: bridgeReady.promise,
      publishAuthoritativeReplacement: vi.fn(),
      release: vi.fn(async () => undefined),
      detach: bridgeDetach,
    }));
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
        acquire: vi.fn(async () => ({
          actor: {
            timeline: { runState: "idle" },
            subscribe: () => () => undefined,
          } as unknown as ConversationActor,
          release: actorRelease,
        })),
      },
      targets: {
        resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
      },
      bridge: { bind } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          release: vi.fn(async () => undefined),
          detach: interactionDetach,
        }),
      } as never,
      hubs: {
        acquire: () => ({ hub, release: vi.fn() }),
        release: vi.fn(),
      } as never,
      retentionMilliseconds: 0,
      onThreadChanged,
    });

    const acquisition = coordinator.acquire(scope, "thread-pending-ready");
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce());
    await coordinator.closeForShutdown();
    await expect(acquisition).rejects.toThrow("thread_runtime_shutdown");

    summaryListener?.({ event: { type: "run_state", state: "idle" } });
    await Promise.resolve();

    expect(onThreadChanged).not.toHaveBeenCalled();
    expect(summaryClose).toHaveBeenCalledOnce();
    expect(bridgeDetach).toHaveBeenCalledOnce();
    expect(interactionDetach).toHaveBeenCalledOnce();
    expect(actorRelease).toHaveBeenCalledOnce();
  });

  it("releases the runtime borrow when the actor subscription throws", async () => {
    vi.useFakeTimers();
    try {
      const actorRelease = vi.fn();
      const actor = {
        timeline: { generation: "generation-1", runState: "running" },
        canEvict: true,
        closed: false,
        ensureProjectionCurrent: vi.fn(async () => undefined),
        subscribe: vi.fn(() => {
          throw new Error("subscribe failed");
        }),
        onClosed: vi.fn(() => () => undefined),
      } as unknown as ConversationActor;
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({ actor, release: actorRelease })),
        },
        targets: {
          resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
        },
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
        retentionMilliseconds: 0,
      });

      await expect(
        coordinator.acquireAgentToolApprovalAuthority(scope, "thread-failure"),
      ).rejects.toThrow("subscribe failed");
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(actorRelease).toHaveBeenCalledOnce());
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes and releases when the runtime changes during subscription", async () => {
    vi.useFakeTimers();
    try {
      const actorRelease = vi.fn();
      const unsubscribe = vi.fn();
      let generation = "generation-1";
      const actor = {
        get timeline() {
          return { generation, runState: "running" as const };
        },
        canEvict: true,
        closed: false,
        ensureProjectionCurrent: vi.fn(async () => undefined),
        subscribe: vi.fn(() => {
          generation = "generation-2";
          return unsubscribe;
        }),
        onClosed: vi.fn(() => vi.fn()),
      } as unknown as ConversationActor;
      const coordinator = new ThreadRuntimeCoordinator({
        actors: {
          runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
          runWithRuntimeRetired: passThroughActorRetirement,
          acquire: vi.fn(async () => ({ actor, release: actorRelease })),
        },
        targets: {
          resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
        },
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
        retentionMilliseconds: 0,
      });

      await expect(
        coordinator.acquireAgentToolApprovalAuthority(scope, "thread-recheck"),
      ).rejects.toThrow("agent_tool_approval_runtime_changed");
      expect(unsubscribe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(actorRelease).toHaveBeenCalledOnce());
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false from a captured authority and aborts it when the actor closes", async () => {
    let closed = false;
    const closeListeners: Array<() => void> = [];
    const unsubscribe = vi.fn();
    const actorRelease = vi.fn();
    const replacementRelease = vi.fn();
    const actor = {
      timeline: { generation: "generation-1", runState: "running" },
      canEvict: false,
      get closed() {
        return closed;
      },
      ensureProjectionCurrent: vi.fn(async () => undefined),
      subscribe: vi.fn(() => unsubscribe),
      onClosed: vi.fn((listener: () => void) => {
        closeListeners.push(listener);
        return vi.fn();
      }),
    } as unknown as ConversationActor;
    const replacementActor = {
      timeline: { generation: "generation-2", runState: "idle" },
      canEvict: true,
      closed: false,
      ensureProjectionCurrent: vi.fn(async () => undefined),
      onClosed: vi.fn(() => () => undefined),
    } as unknown as ConversationActor;
    const acquireActor = vi
      .fn()
      .mockResolvedValueOnce({ actor, release: actorRelease })
      .mockResolvedValueOnce({
        actor: replacementActor,
        release: replacementRelease,
      });
    const bridgeRelease = vi.fn(async () => undefined);
    const interactionRelease = vi.fn(async () => undefined);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
        acquire: acquireActor,
      },
      targets: {
        resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
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
          release: interactionRelease,
        }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });

    const lease = await coordinator.acquireAgentToolApprovalAuthority(
      scope,
      "thread-closed-authority",
    );
    expect(lease).toBeDefined();
    closed = true;
    for (const listener of closeListeners) listener();

    expect(lease!.isCurrent()).toBe(false);
    expect(lease!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(actorRelease).toHaveBeenCalledOnce());
    expect(bridgeRelease).toHaveBeenCalledOnce();
    expect(interactionRelease).toHaveBeenCalledOnce();
    lease!.release();
    const replacement = await coordinator.acquire(
      scope,
      "thread-closed-authority",
    );
    expect(replacement.actor).toBe(replacementActor);
    expect(acquireActor).toHaveBeenCalledTimes(2);
    replacement.release();
    await coordinator.close();
    expect(replacementRelease).toHaveBeenCalledOnce();
  });

  it("replaces a fenced running actor even while the thread hub remains subscribed", async () => {
    let replacementRequired = false;
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const firstActor = {
      timeline: { generation: "generation-1", runState: "running" },
      canEvict: false,
      closed: false,
      get replacementRequired() {
        return replacementRequired;
      },
      ensureProjectionCurrent: vi.fn(async () => {
        if (replacementRequired) {
          throw new Error("conversation_actor_handle_replacement_required");
        }
      }),
      onClosed: vi.fn(() => () => undefined),
    } as unknown as ConversationActor;
    const secondActor = {
      timeline: { generation: "generation-2", runState: "idle" },
      canEvict: true,
      closed: false,
      replacementRequired: false,
      ensureProjectionCurrent: vi.fn(async () => undefined),
      onClosed: vi.fn(() => () => undefined),
    } as unknown as ConversationActor;
    const acquireActor = vi
      .fn()
      .mockResolvedValueOnce({ actor: firstActor, release: firstRelease })
      .mockResolvedValueOnce({ actor: secondActor, release: secondRelease });
    const firstBridgeRelease = vi.fn(async () => undefined);
    const secondBridgeRelease = vi.fn(async () => undefined);
    const firstInteractionRelease = vi.fn(async () => undefined);
    const secondInteractionRelease = vi.fn(async () => undefined);
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: acquireActor,
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: passThroughActorRetirement,
      },
      targets: {
        resolve: vi.fn(async (_scope, threadId) => runtimeTarget(threadId)),
      },
      bridge: {
        bind: vi
          .fn()
          .mockReturnValueOnce({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: firstBridgeRelease,
          })
          .mockReturnValueOnce({
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: secondBridgeRelease,
          }),
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: vi
          .fn()
          .mockReturnValueOnce({
            publishPending: vi.fn(),
            release: firstInteractionRelease,
          })
          .mockReturnValueOnce({
            publishPending: vi.fn(),
            release: secondInteractionRelease,
          }),
      } as never,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 60_000,
    });

    const first = await coordinator.acquire(scope, "thread-fenced-running");
    const subscribedHub = first.hub;
    const subscription = subscribedHub.subscribe(() => undefined);
    first.release();
    replacementRequired = true;

    const reopened = await coordinator.acquire(scope, "thread-fenced-running");

    expect(reopened.actor).toBe(secondActor);
    expect(reopened.hub).toBe(subscribedHub);
    expect(acquireActor).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(firstBridgeRelease).toHaveBeenCalledOnce();
    expect(firstInteractionRelease).toHaveBeenCalledOnce();

    subscription.close();
    reopened.release();
    await coordinator.close();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(secondBridgeRelease).toHaveBeenCalledOnce();
    expect(secondInteractionRelease).toHaveBeenCalledOnce();
  });
});
