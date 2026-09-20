import { describe, expect, it, vi } from "vitest";
import type {
  ConversationActorEvent,
  ConversationActorListener,
} from "../../src/server/conversations/conversation-actor.js";
import {
  ConversationEventBridge,
  type ConversationEventBridgeSource,
} from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import type {
  NormalizedThreadSnapshot,
  ThreadForkSourceCapability,
} from "../../src/shared/protocol/conversation.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

function availableForkSource(): ThreadForkSourceCapability {
  return {
    selectedCompletedTurn: { available: true },
    latestProviderSnapshot: { available: true },
  };
}

function unavailableForkSource(reason: string): ThreadForkSourceCapability {
  return {
    selectedCompletedTurn: {
      available: false,
      unavailableReason: { text: reason },
    },
    latestProviderSnapshot: {
      available: false,
      unavailableReason: { text: reason },
    },
  };
}

function timeline(generation: string) {
  return {
    generation,
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    runState: "idle" as const,
  };
}

function actorState(generation: string) {
  return {
    timeline: timeline(generation),
    backendCapabilities: {
      revision: `backend-${generation}`,
      actions: [],
      deliveryModes: [],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "unavailable" as const,
        reason: { text: "Branching is unavailable in this fixture." },
      },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: {},
    },
    usage: {},
  };
}

function snapshot(
  generation: string,
  forkUnavailableReason = "Forking is unavailable in this fixture.",
): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: unavailableForkSource(forkUnavailableReason),
    forksByTurnId: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: "idle",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Workspace" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Machine" },
      available: true,
      directoryBrowsing: "available" as const,
    },
    draft: {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 0,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    history: { hasOlder: false },
    runState: "idle",
    queue: [],
    capabilities: {
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        nativeImage: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        policy: {
          maximumAttachments: 8,
          maximumImages: 4,
          maximumAggregateBytes: 67_108_864,
          maximumFileBytes: 26_214_400,
          maximumImageBytes: 16_777_216,
          maximumImagePixels: 40_000_000,
          maximumImageDimension: 16_384,
          imageMediaTypes: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ],
        },
      },
      revision: `capabilities-${generation}`,
      backend: { label: { text: "Backend" } },
      interactionMode: "interactive",
      runState: "idle",
      operations: [],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      history: { available: true, paginated: true },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun: true,
      },
    },
    settings: { revision: 0, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}

const targetedProjection = {
  capabilitiesAndProviderFeatures: async (
    _scope: typeof scope,
    _threadId: string,
    current: ReturnType<typeof actorState>,
  ) => {
    const composed = snapshot(current.timeline.generation);
    return {
      threadRevision: composed.thread.threadRevision,
      capabilities: composed.capabilities,
      providerFeatures: composed.providerFeatures,
      interactions: composed.interactions,
    };
  },
  forkSource: async (
    _scope: typeof scope,
    _threadId: string,
    current: ReturnType<typeof actorState>,
  ) => snapshot(current.timeline.generation).forkSource,
};

class Source implements ConversationEventBridgeSource {
  listener?: ConversationActorListener;

  subscribe(listener: ConversationActorListener): () => void {
    this.listener = listener;
    listener({
      type: "projection_replaced",
      state: actorState("generation-1"),
    });
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(event: ConversationActorEvent): void {
    this.listener?.(event);
  }
}

describe("ConversationEventBridge", () => {
  it("publishes the complete snapshot before ordered incrementals", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    source.emit({
      type: "projection_events",
      generation: "generation-1",
      events: [
        {
          type: "run_state",
          generation: "generation-1",
          state: "running",
        },
      ],
    });

    await binding.ready;
    await binding.release();

    expect(listener.mock.calls.map(([event]) => event.event.type)).toEqual([
      "snapshot",
      "run_state",
    ]);
  });

  it("serializes replacement composition ahead of its generation events", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) => {
        if (current.timeline.generation === "generation-2") await second;
        return snapshot(current.timeline.generation);
      },
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    await binding.ready;
    source.emit({
      type: "projection_replaced",
      state: actorState("generation-2"),
    });
    source.emit({
      type: "projection_events",
      generation: "generation-2",
      events: [
        {
          type: "run_state",
          generation: "generation-2",
          state: "running",
        },
      ],
    });
    releaseSecond();
    await binding.release();

    expect(
      listener.mock.calls.map(([event]) => [
        event.projectionGeneration,
        event.event.type,
      ]),
    ).toEqual([
      ["generation-1", "snapshot"],
      ["generation-2", "snapshot"],
      ["generation-2", "run_state"],
    ]);
  });

  it("serializes interaction publication behind an in-flight replacement snapshot", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const interaction = {
      id: "interaction-1",
      threadId: "thread-1",
      kind: "confirmation" as const,
      sourceLabel: { text: "Agent" },
      title: { text: "Approval" },
      message: { text: "Continue?" },
      openedAt: "2026-08-10T12:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
    };
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) => {
        if (current.timeline.generation === "generation-2") await second;
        return snapshot(current.timeline.generation);
      },
      capabilitiesAndProviderFeatures: async () => ({
        threadRevision: 0,
        capabilities: snapshot("generation-2").capabilities,
        providerFeatures: [],
        interactions: [interaction],
      }),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-2"),
    });
    await binding.ready;
    source.emit({
      type: "projection_replaced",
      state: actorState("generation-2"),
    });
    binding.opened(scope, "thread-1", "generation-2", interaction);
    releaseSecond();
    await binding.release();
    expect(
      listener.mock.calls.map(([event]) => [
        event.projectionGeneration,
        event.event.type,
      ]),
    ).toEqual([
      ["generation-1", "snapshot"],
      ["generation-2", "snapshot"],
      ["generation-2", "interaction_opened"],
      ["generation-2", "capabilities_changed"],
    ]);
    expect(hub.snapshot?.interactions).toEqual([interaction]);
  });

  it("reports rejected interaction composition through bridge recovery", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const failures = vi.fn();
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      onFailure: failures,
      captureAuthoritativeState: async () => {
        throw new Error("capture failed");
      },
    });
    await binding.ready;
    binding.resolved(scope, "thread-1", "generation-1", "interaction-1");
    await vi.waitFor(() => expect(failures).toHaveBeenCalledOnce());
    expect(failures.mock.calls[0]?.[0]).toEqual(new Error("capture failed"));
    await binding.release();
  });

  it.each([
    "Archived threads cannot be forked.",
    "Resolve the thread's uncertain operation before forking.",
    "Queued input must settle before forking.",
  ])(
    "preserves the application fork restriction across positive actor events: %s",
    async (forkUnavailableReason) => {
      const source = new Source();
      const hub = new ThreadEventHub();
      const listener = vi.fn();
      hub.subscribe(listener);
      const bridge = new ConversationEventBridge({
        ...targetedProjection,
        snapshot: async (_scope, _threadId, current) =>
          snapshot(current.timeline.generation, forkUnavailableReason),
        forkSource: async () =>
          snapshot("generation-1", forkUnavailableReason).forkSource,
        ancillary: async () => [],
      });
      const binding = bridge.bind({
        scope,
        applicationThreadId: "thread-1",
        actor: source,
        hub,
        captureAuthoritativeState: async () => actorState("generation-1"),
      });
      await binding.ready;

      source.emit({
        type: "projection_events",
        generation: "generation-1",
        events: [
          {
            type: "fork_source_state_changed",
            generation: "generation-1",
            forkSource: availableForkSource(),
          },
          {
            type: "turn_upsert",
            generation: "generation-1",
            turn: {
              id: "turn-1",
              revision: 1,
              status: "completed",
              endedBy: "agent_settled",
              orderedItemIds: [],
            },
            fork: {
              sourceTurnId: "turn-1",
              expectedTurnRevision: 1,
              available: true,
            },
          },
        ],
      });
      await binding.release();

      expect(listener.mock.calls[1]?.[0].event).toMatchObject({
        type: "fork_source_state_changed",
        forkSource: {
          selectedCompletedTurn: {
            available: false,
            unavailableReason: { text: forkUnavailableReason },
          },
          latestProviderSnapshot: {
            available: false,
            unavailableReason: { text: forkUnavailableReason },
          },
        },
      });
      expect(listener.mock.calls[2]?.[0].event).toMatchObject({
        type: "turn_upsert",
        fork: {
          available: false,
          unavailableReason: { text: forkUnavailableReason },
        },
      });
    },
  );

  it("publishes an application-composed event to re-enable forks after idle settlement", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    let sourceAvailable = false;
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) => ({
        ...snapshot(current.timeline.generation),
        forkSource: sourceAvailable
          ? availableForkSource()
          : unavailableForkSource("The source thread must be idle."),
      }),
      forkSource: async () =>
        sourceAvailable
          ? availableForkSource()
          : unavailableForkSource("The source thread must be idle."),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    });
    await binding.ready;

    sourceAvailable = true;
    source.emit({
      type: "projection_events",
      generation: "generation-1",
      events: [
        {
          type: "fork_source_state_changed",
          generation: "generation-1",
          forkSource: availableForkSource(),
        },
      ],
    });
    await binding.release();

    expect(listener.mock.calls.map(([envelope]) => envelope.event)).toEqual([
      expect.objectContaining({
        type: "snapshot",
        snapshot: expect.objectContaining({
          forkSource: expect.objectContaining({
            selectedCompletedTurn: expect.objectContaining({
              available: false,
            }),
          }),
        }),
      }),
      expect.objectContaining({
        type: "fork_source_state_changed",
        forkSource: availableForkSource(),
      }),
    ]);
  });

  it("uses the canonical hub fork source after application recovery resolves", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(
          current.timeline.generation,
          "Resolve the thread's uncertain operation before forking.",
        ),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    await binding.ready;

    // Application recovery is published outside the actor bridge. The next
    // actor turn must clamp against this canonical state, not the bridge's
    // initial snapshot.
    hub.publish({
      type: "fork_source_state_changed",
      generation: "generation-1",
      forkSource: availableForkSource(),
    });
    source.emit({
      type: "projection_events",
      generation: "generation-1",
      events: [
        {
          type: "turn_upsert",
          generation: "generation-1",
          turn: {
            id: "turn-after-recovery",
            revision: 0,
            status: "completed",
            endedBy: "agent_settled",
            orderedItemIds: [],
          },
          fork: {
            sourceTurnId: "turn-after-recovery",
            expectedTurnRevision: 0,
            available: true,
          },
        },
      ],
    });
    await binding.release();

    expect(listener.mock.calls.at(-1)?.[0].event).toMatchObject({
      type: "turn_upsert",
      fork: {
        sourceTurnId: "turn-after-recovery",
        expectedTurnRevision: 0,
        available: true,
      },
    });
  });

  it("publishes an application-composed capability event for the actor generation", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const composed = {
      ...snapshot("generation-1").capabilities,
      revision: "application-capabilities-2",
      runState: "running" as const,
    };
    const composeTargeted = vi.fn(async () => ({
      threadRevision: 1,
      capabilities: composed,
      providerFeatures: [],
      interactions: [],
    }));
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      capabilitiesAndProviderFeatures: composeTargeted,
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "capabilities_changed",
        capabilities: actorState("generation-1").backendCapabilities,
      },
    });
    await binding.release();

    // One targeted-state composition per capabilities_changed event.
    expect(composeTargeted).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls.at(-1)?.[0].event).toEqual({
      type: "capabilities_changed",
      generation: "generation-1",
      threadRevision: 1,
      capabilities: composed,
      providerFeatures: [],
    });
  });

  it("recomposes capabilities when queue revision advances during composition", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const initial = snapshot("generation-1");
    const recomposedCapabilities = {
      ...initial.capabilities,
      revision: "application-capabilities-after-queue",
    };
    let compositionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      compositionStarted = resolve;
    });
    let releaseComposition!: () => void;
    const compositionGate = new Promise<void>((resolve) => {
      releaseComposition = resolve;
    });
    const composeTargeted = vi
      .fn()
      .mockImplementationOnce(async () => {
        compositionStarted();
        await compositionGate;
        return {
          threadRevision: 0,
          capabilities: initial.capabilities,
          providerFeatures: [],
          interactions: [],
        };
      })
      .mockResolvedValue({
        threadRevision: 1,
        capabilities: recomposedCapabilities,
        providerFeatures: [],
        interactions: [],
      });
    const projectSnapshot = vi.fn().mockResolvedValue(initial);
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: projectSnapshot,
      capabilitiesAndProviderFeatures: composeTargeted,
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "capabilities_changed",
        capabilities: actorState("generation-1").backendCapabilities,
      },
    });
    await started;
    hub.publish({
      type: "queue_changed",
      generation: "generation-1",
      threadRevision: 1,
      items: [],
    });
    releaseComposition();
    await binding.release();

    expect(composeTargeted).toHaveBeenCalledTimes(2);
    expect(projectSnapshot).toHaveBeenCalledTimes(1);
    expect(
      listener.mock.calls.map(([envelope]) => envelope.event.type),
    ).toEqual(["snapshot", "queue_changed", "capabilities_changed"]);
    expect(hub.snapshot?.thread.threadRevision).toBe(1);
    expect(hub.snapshot?.capabilities).toEqual(recomposedCapabilities);
  });

  it("publishes provider feature capability and state transitions atomically", async () => {
    const goalRef = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const goalEnvelope = (revision: number, status: string) => ({
      ref: goalRef,
      revision,
      state: {
        kind: "object" as const,
        entries: [
          { key: { text: "state" }, value: { text: "set" } },
          { key: { text: "objective" }, value: { text: "Ship it" } },
          { key: { text: "status" }, value: { text: status } },
        ],
      },
    });
    const goalCapability = (revision: number) => ({
      ref: goalRef,
      revision,
      label: { text: "Goal" },
      availability: "available" as const,
      operations: [],
      presentationSlots: ["composer_action" as const],
    });
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const baseSnapshot = {
      ...snapshot("generation-1"),
      capabilities: {
        ...snapshot("generation-1").capabilities,
        providerFeatures: [goalCapability(1)],
      },
      providerFeatures: [goalEnvelope(1, "active")],
    };
    const composeTargeted = vi.fn(async () => ({
      threadRevision: baseSnapshot.thread.threadRevision,
      capabilities: {
        ...baseSnapshot.capabilities,
        providerFeatures: [goalCapability(2)],
        interactions: [],
      },
      providerFeatures: [goalEnvelope(2, "complete")],
      interactions: [],
    }));
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async () => baseSnapshot,
      capabilitiesAndProviderFeatures: composeTargeted,
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "capabilities_changed",
        capabilities: actorState("generation-1").backendCapabilities,
      },
    });
    await binding.release();

    const types = listener.mock.calls.map(([envelope]) => envelope.event.type);
    expect(types).toEqual(["snapshot", "capabilities_changed"]);
    // One targeted-state composition per capabilities_changed event.
    expect(composeTargeted).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls.at(-1)?.[0].event).toEqual({
      type: "capabilities_changed",
      generation: "generation-1",
      threadRevision: 0,
      capabilities: {
        ...baseSnapshot.capabilities,
        providerFeatures: [goalCapability(2)],
      },
      providerFeatures: [goalEnvelope(2, "complete")],
    });
  });

  it("publishes a coherent full feature projection on every capability refresh", async () => {
    const goalRef = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const goalEnvelope = {
      ref: goalRef,
      revision: 3,
      state: {
        kind: "object" as const,
        entries: [
          { key: { text: "state" }, value: { text: "set" } },
          { key: { text: "objective" }, value: { text: "Ship it" } },
          { key: { text: "status" }, value: { text: "active" } },
        ],
      },
    };
    const goalCapability = {
      ref: goalRef,
      revision: 3,
      label: { text: "Goal" },
      availability: "available" as const,
      operations: [],
      presentationSlots: ["composer_action" as const],
    };
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const baseSnapshot = {
      ...snapshot("generation-1"),
      capabilities: {
        ...snapshot("generation-1").capabilities,
        providerFeatures: [goalCapability],
      },
      providerFeatures: [goalEnvelope],
    };
    const composeTargeted = vi.fn(async () => ({
      threadRevision: baseSnapshot.thread.threadRevision,
      capabilities: baseSnapshot.capabilities,
      providerFeatures: [goalEnvelope],
      interactions: [],
    }));
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async () => baseSnapshot,
      capabilitiesAndProviderFeatures: composeTargeted,
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "capabilities_changed",
        capabilities: actorState("generation-1").backendCapabilities,
      },
    });
    await binding.release();

    const types = listener.mock.calls.map(([envelope]) => envelope.event.type);
    expect(types).toEqual(["snapshot", "capabilities_changed"]);
    expect(composeTargeted).toHaveBeenCalledTimes(1);
  });

  it("drops a capability event whose actor generation is no longer authoritative", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const composeTargeted = vi.fn(async () => ({
      threadRevision: snapshot("generation-2").thread.threadRevision,
      capabilities: snapshot("generation-2").capabilities,
      providerFeatures: [],
      interactions: [],
    }));
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      capabilitiesAndProviderFeatures: composeTargeted,
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-2"),
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "capabilities_changed",
        capabilities: actorState("generation-1").backendCapabilities,
      },
    });
    await binding.release();

    expect(composeTargeted).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].event.type).toBe("snapshot");
  });

  it("routes ancillary events through the application projection", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async (_scope, _threadId, generation, event) =>
        event.type === "usage_changed"
          ? [
              {
                type: "usage_changed",
                generation,
                usage: event.usage,
              },
            ]
          : [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    await binding.ready;
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "usage_changed",
        usage: { counters: { requests: 1 } },
      },
    });
    await binding.release();

    expect(listener.mock.calls.at(-1)?.[0].event).toMatchObject({
      type: "usage_changed",
      usage: { counters: { requests: 1 } },
    });
  });

  it("publishes an authoritative replacement through the bridge mailbox", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-2"),
    });
    await binding.ready;

    const replacement = await binding.publishAuthoritativeReplacement();
    await binding.release();

    expect(replacement).toMatchObject({
      projectionGeneration: "generation-2",
      event: { type: "snapshot", generation: "generation-2" },
    });
  });

  it("drains accepted publication work before idempotent release", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) => {
        await wait;
        return snapshot(current.timeline.generation);
      },
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    const first = binding.release();
    expect(binding.release()).toBe(first);
    let released = false;
    void first.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finish();
    await first;
    await binding.ready;
  });

  it("drains accepted work even when unsubscribe fails", async () => {
    const source = new Source();
    const originalSubscribe = source.subscribe.bind(source);
    source.subscribe = (listener) => {
      const unsubscribe = originalSubscribe(listener);
      return () => {
        unsubscribe();
        throw new Error("unsubscribe failed");
      };
    };
    const hub = new ThreadEventHub();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) => {
        await wait;
        return snapshot(current.timeline.generation);
      },
      ancillary: async () => [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    const release = binding.release();
    let released = false;
    void release.catch(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finish();

    await expect(release).rejects.toThrow("unsubscribe failed");
    expect(hub.watermark).toBe(1);
    await binding.ready;
  });

  it("contains a synchronous subscribe failure without publishing accepted callbacks", async () => {
    const source: ConversationEventBridgeSource = {
      subscribe(listener) {
        listener({
          type: "projection_replaced",
          state: actorState("generation-1"),
        });
        throw new Error("subscribe failed");
      },
    };
    const projection = {
      ...targetedProjection,
      snapshot: vi.fn(async () => snapshot("generation-1")),
      ancillary: vi.fn(async () => []),
    };
    const hub = new ThreadEventHub();
    const bridge = new ConversationEventBridge(projection);

    expect(() =>
      bridge.bind({
        scope,
        applicationThreadId: "thread-1",
        actor: source,
        hub,
      }),
    ).toThrow("subscribe failed");
    await new Promise((resolve) => setImmediate(resolve));
    expect(projection.snapshot).not.toHaveBeenCalled();
    expect(hub.watermark).toBe(0);
  });

  it("rejects mismatched wrapper and projected generations", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const failures = vi.fn();
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async (_scope, _threadId, _generation, event) =>
        event.type === "usage_changed"
          ? [
              {
                type: "usage_changed",
                generation: "wrong-generation",
                usage: event.usage,
              },
            ]
          : [],
    });
    const binding = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      onFailure: failures,
    });
    await binding.ready;
    source.emit({
      type: "projection_events",
      generation: "generation-2",
      events: [
        {
          type: "run_state",
          generation: "generation-1",
          state: "running",
        },
      ],
    });
    source.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "usage_changed",
        usage: { counters: { requests: 1 } },
      },
    });
    await binding.release();

    expect(failures).toHaveBeenCalledTimes(2);
    expect(hub.watermark).toBe(1);
  });

  it("isolates synchronous and asynchronous failure observers", async () => {
    for (const onFailure of [
      () => {
        throw new Error("observer failed");
      },
      async () => {
        throw new Error("async observer failed");
      },
    ]) {
      const source = new Source();
      const hub = new ThreadEventHub();
      const bridge = new ConversationEventBridge({
        ...targetedProjection,
        snapshot: async () => {
          throw new Error("projection failed");
        },
        ancillary: async () => [],
      });
      const binding = bridge.bind({
        scope,
        applicationThreadId: "thread-1",
        actor: source,
        hub,
        onFailure,
      });
      await expect(binding.ready).rejects.toThrow("projection failed");
      await binding.release();
    }
  });

  it("drops a pending gate composition when its binding is replaced", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    let started = false;
    let releaseComposition!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseComposition = resolve;
    });
    const interaction = {
      id: "obsolete-gate",
      threadId: "thread-1",
      kind: "confirmation" as const,
      sourceLabel: { text: "Agent" },
      title: { text: "Approval" },
      message: { text: "Continue?" },
      openedAt: "2026-08-10T12:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
    };
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async () => snapshot("generation-1"),
      capabilitiesAndProviderFeatures: async () => {
        started = true;
        await gate;
        return {
          threadRevision: 0,
          capabilities: snapshot("generation-1").capabilities,
          providerFeatures: [],
          interactions: [interaction],
        };
      },
      ancillary: async () => [],
    });
    const input = {
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
      captureAuthoritativeState: async () => actorState("generation-1"),
    };
    const first = bridge.bind(input);
    await first.ready;
    first.opened(scope, "thread-1", "generation-1", interaction);
    await vi.waitFor(() => expect(started).toBe(true));
    const second = bridge.bind(input);
    await second.ready;
    releaseComposition();
    await first.release();
    await second.release();
    expect(hub.snapshot?.interactions).toEqual([]);
    expect(listener.mock.calls.map(([event]) => event.event.type)).toEqual([
      "snapshot",
      "snapshot",
    ]);
  });

  it("fences the prior binding when the same actor is bound again", async () => {
    const source = new Source();
    const hub = new ThreadEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const bridge = new ConversationEventBridge({
      ...targetedProjection,
      snapshot: async (_scope, _threadId, current) =>
        snapshot(current.timeline.generation),
      ancillary: async () => [],
    });
    const first = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });
    const second = bridge.bind({
      scope,
      applicationThreadId: "thread-1",
      actor: source,
      hub,
    });

    await second.ready;
    source.emit({
      type: "projection_events",
      generation: "generation-1",
      events: [
        {
          type: "run_state",
          generation: "generation-1",
          state: "running",
        },
      ],
    });
    await second.release();

    // The fenced binding cannot publish replacements or drain queued work:
    // every actor event reaches the hub exactly once, through the successor.
    await expect(first.publishAuthoritativeReplacement()).rejects.toThrow(
      /mailbox is closed|replacement_unavailable/,
    );
    await first.release();
    expect(listener.mock.calls.map(([event]) => event.event.type)).toEqual([
      "snapshot",
      "run_state",
    ]);
  });
});
