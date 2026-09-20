import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import { MAXIMUM_NORMALIZED_TIMELINE_TURNS } from "../../src/shared/protocol/conversation.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";

function snapshot(): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
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
      revision: "capabilities-1",
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

function replacement(
  generation: string,
): Extract<NormalizedThreadEvent, { readonly type: "snapshot" }> {
  return {
    type: "snapshot",
    generation,
    snapshot: snapshot(),
  };
}

function applicationState(
  value: NormalizedThreadSnapshot,
): Extract<
  NormalizedThreadEvent,
  { readonly type: "application_state_changed" }
>["state"] {
  const {
    backendSessionId: _backendSessionId,
    orderedTurnIds: _orderedTurnIds,
    turnsById: _turnsById,
    itemsById: _itemsById,
    forksByTurnId: _forksByTurnId,
    history: _history,
    runState: _runState,
    activeTurnId: _activeTurnId,
    usage: _usage,
    ...state
  } = value;
  return state;
}

describe("ThreadEventHub", () => {
  it("retains background work in checkpoints while ordinary turn state stays idle", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("generation-1"));
    const activity = { state: "known" as const, agents: 1, commands: 0, other: 0 };
    hub.publish({ type: "background_activity_changed", generation: "generation-1", activity });
    expect(hub.snapshot?.backgroundActivity).toEqual(activity);
    expect(hub.snapshot?.runState).toBe("idle");
    hub.publish({ type: "background_activity_changed", generation: "generation-1",
      activity: { ...activity, state: "unknown" } });
    expect(hub.snapshot?.backgroundActivity?.state).toBe("unknown");
    hub.publish(replacement("generation-2"));
    expect(hub.snapshot).not.toHaveProperty("backgroundActivity");
  });

  it("replaces an updated interaction in place without changing queue order", () => {
    const first = {
      id: "interaction-1",
      threadId: "thread-1",
      sourceLabel: { text: "Agent" },
      title: { text: "First" },
      openedAt: "2026-07-30T15:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: false,
      kind: "questionnaire" as const,
      questions: [
        {
          id: "question-1",
          header: { text: "Question" },
          prompt: { text: "Answer?" },
          secret: false,
          input: { kind: "text" as const, multiline: false },
        },
      ],
    };
    const second = {
      id: "interaction-2",
      threadId: "thread-1",
      sourceLabel: { text: "Agent" },
      title: { text: "Second" },
      openedAt: "2026-07-30T15:00:01.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      kind: "confirmation" as const,
      message: { text: "Continue?" },
    };
    const hub = new ThreadEventHub();
    const initial = snapshot();
    hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: { ...initial, interactions: [first, second] },
    });
    hub.publish({
      type: "interaction_opened",
      generation: "projection-1",
      interaction: {
        ...first,
        message: { text: "Updated context" },
      },
    });

    expect(hub.snapshot?.interactions.map(({ id }) => id)).toEqual([
      "interaction-1",
      "interaction-2",
    ]);
    expect(hub.snapshot?.interactions[0]).toMatchObject({
      message: { text: "Updated context" },
    });
  });

  it.each([
    {
      label: "inventory revision regression",
      change: (base: NormalizedThreadSnapshot) => ({
        thread: { ...base.thread, inventoryRevision: 1 },
      }),
      code: "thread_projection_thread_revision_regressed",
    },
    {
      label: "thread revision regression",
      change: (base: NormalizedThreadSnapshot) => ({
        thread: { ...base.thread, threadRevision: 1 },
      }),
      code: "thread_projection_thread_revision_regressed",
    },
    {
      label: "draft revision regression",
      change: () => ({
        draft: {
          text: "old",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 1,
        },
      }),
      code: "thread_projection_draft_revision_regressed",
    },
    {
      label: "same-revision draft conflict",
      change: () => ({
        draft: {
          text: "conflict",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 2,
        },
      }),
      code: "thread_projection_draft_revision_conflict",
    },
    {
      label: "settings revision regression",
      change: () => ({ settings: { revision: 1, values: [] } }),
      code: "thread_projection_settings_revision_regressed",
    },
    {
      label: "same-revision settings conflict",
      change: () => ({
        settings: {
          revision: 2,
          values: [
            {
              id: "model" as const,
              desiredValue: null,
              effectiveValue: null,
              applicationState: "confirmation_unknown" as const,
            },
          ],
        },
      }),
      code: "thread_projection_settings_revision_conflict",
    },
    {
      label: "agent-tool revision regression",
      change: () => ({
        agentTools: {
          ...snapshot().agentTools,
          enabled: true,
          revision: 1,
        },
      }),
      code: "thread_projection_agent_tool_revision_regressed",
    },
    {
      label: "same-revision agent-tool conflict",
      change: () => ({
        agentTools: {
          ...snapshot().agentTools,
          enabled: true,
          revision: 2,
        },
      }),
      code: "thread_projection_agent_tool_revision_conflict",
    },
  ])("rejects $label in application state", ({ change, code }) => {
    const hub = new ThreadEventHub();
    const original = snapshot();
    const base = {
      ...original,
      thread: {
        ...original.thread,
        inventoryRevision: 2,
        threadRevision: 2,
      },
      draft: { ...original.draft, revision: 2 },
      settings: { ...original.settings, revision: 2 },
      agentTools: { ...original.agentTools, revision: 2 },
    };
    hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: base,
    });
    expect(() =>
      hub.publish({
        type: "application_state_changed",
        generation: "projection-1",
        state: { ...applicationState(base), ...change(base) } as never,
      }),
    ).toThrow(code);
  });

  it("accepts an application summary at the thread revision already advanced by capabilities", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    hub.publish({
      type: "capabilities_changed",
      generation: "projection-1",
      threadRevision: 1,
      capabilities: {
        ...snapshot().capabilities,
        revision: "capabilities-2",
      },
      providerFeatures: [],
    });

    const current = hub.snapshot!;
    const nextAgentTools = {
      ...current.agentTools,
      enabled: true,
      revision: 1,
    };
    expect(() =>
      hub.publish({
        type: "application_state_changed",
        generation: "projection-1",
        state: {
          ...applicationState(current),
          agentTools: nextAgentTools,
        },
      }),
    ).not.toThrow();
    expect(hub.snapshot?.thread.threadRevision).toBe(1);
    expect(hub.snapshot?.capabilities.revision).toBe("capabilities-2");
    expect(hub.snapshot?.agentTools).toEqual(nextAgentTools);
  });

  it("rejects conflicting queue projections at one thread revision", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    const item = {
      id: "queued-1",
      deliveryOperationId: "queued-operation-1",
      resolvedDeliveryMode: "queue" as const,
      sequence: 1,
      origin: "user" as const,
      isHead: true,
      state: "pending" as const,
      preview: { text: "Queued input" },
      attachmentCount: 0,
      taskCount: 0,
      createdAt: "2026-08-07T07:00:00.000Z",
    };
    hub.publish({
      type: "queue_changed",
      generation: "projection-1",
      threadRevision: 1,
      items: [item],
    });
    expect(hub.snapshot).toMatchObject({
      thread: { threadRevision: 1, queuedInputCount: 1 },
      queue: [item],
    });
    expect(() =>
      hub.publish({
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 1,
        items: [],
      }),
    ).toThrow("thread_projection_queue_revision_conflict");
    expect(() =>
      hub.publish({
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 0,
        items: [],
      }),
    ).toThrow("thread_projection_thread_revision_regressed");
  });

  it("requires a replacement before incrementals in each generation", () => {
    const hub = new ThreadEventHub();
    expect(() =>
      hub.publish({
        type: "run_state",
        generation: "generation-1",
        state: "running",
      }),
    ).toThrow("thread_projection_snapshot_required");

    hub.publish(replacement("generation-1"));
    expect(() =>
      hub.publish({
        type: "run_state",
        generation: "generation-1",
        state: "running",
      }),
    ).not.toThrow();
    expect(() =>
      hub.publish({
        type: "run_state",
        generation: "generation-2",
        state: "running",
      }),
    ).toThrow("thread_projection_snapshot_required");
    expect(() => hub.publish(replacement("generation-2"))).not.toThrow();
  });

  it("embeds transport IDs without conflating projection generations", () => {
    const hub = new ThreadEventHub();
    const first = hub.publish(replacement("projection-1"));
    const second = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });

    expect(first.eventId).toBe(`${hub.transportGeneration}.1`);
    expect(first.projectionGeneration).toBe("projection-1");
    expect(second.eventId).toBe(`${hub.transportGeneration}.2`);
    expect(second.event.type).toBe("run_state");
  });

  it("retains the current snapshot and derived summary across incrementals", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    hub.publish({
      type: "draft_changed",
      generation: "projection-1",
      draft: {
        text: "saved",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 1,
      },
    });
    hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });

    expect(hub.projectionGeneration).toBe("projection-1");
    expect(hub.snapshot?.draft).toEqual({
      text: "saved",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    });
    expect(hub.snapshot?.runState).toBe("running");
    expect(hub.threadSummary?.runState).toBe("running");
  });

  it("clamps turn forks against the canonical application fork source", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    hub.publish({
      type: "turn_upsert",
      generation: "projection-1",
      turn: {
        id: "turn-1",
        revision: 0,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds: [],
      },
      fork: {
        sourceTurnId: "turn-1",
        expectedTurnRevision: 0,
        available: true,
      },
    });

    expect(hub.snapshot?.forksByTurnId["turn-1"]).toEqual({
      sourceTurnId: "turn-1",
      expectedTurnRevision: 0,
      available: false,
      unavailableReason: {
        text: "Forking is unavailable in this fixture.",
      },
    });
  });

  it("rejects history that would make the retained canonical window unbounded", () => {
    const hub = new ThreadEventHub();
    const ids = Array.from(
      { length: MAXIMUM_NORMALIZED_TIMELINE_TURNS },
      (_, index) => `turn-${index}`,
    );
    const turnsById = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          revision: 0,
          status: "completed" as const,
          orderedItemIds: [],
        },
      ]),
    );
    const forksByTurnId = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          sourceTurnId: id,
          expectedTurnRevision: 0,
          available: false as const,
          unavailableReason: { text: "Forking is unavailable." },
        },
      ]),
    );
    hub.publish({
      ...replacement("projection-1"),
      snapshot: {
        ...snapshot(),
        orderedTurnIds: ids,
        turnsById,
        forksByTurnId,
      },
    });

    expect(() =>
      hub.publish({
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: ["older-turn"],
          turnsById: {
            "older-turn": {
              id: "older-turn",
              revision: 0,
              status: "completed",
              orderedItemIds: [],
            },
          },
          forkSource: snapshot().forkSource,
          forksByTurnId: {
            "older-turn": {
              sourceTurnId: "older-turn",
              expectedTurnRevision: 0,
              available: false,
              unavailableReason: { text: "Forking is unavailable." },
            },
          },
          itemsById: {},
        },
      }),
    ).toThrow("thread_projection_history_limit_exceeded");
    expect(hub.snapshot?.orderedTurnIds).toHaveLength(
      MAXIMUM_NORMALIZED_TIMELINE_TURNS,
    );
  });

  it("validates and replays complete envelopes", () => {
    const hub = new ThreadEventHub({ replayLimit: 4 });
    const first = hub.publish(replacement("projection-1"));
    const second = hub.publish({
      type: "notice",
      generation: "projection-1",
      notice: {
        id: "notice-1",
        tone: "info",
        message: { text: "Updated" },
        createdAt: "2026-07-30T15:00:00.000Z",
      },
    });
    const listener = vi.fn();
    const subscription = hub.subscribe(listener, first.eventId);

    expect(subscription.replay).toEqual([second]);
    hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });
    expect(listener).toHaveBeenCalledOnce();
    subscription.close();
  });

  it("drops superseded replay when a replacement is published", () => {
    const hub = new ThreadEventHub();
    const first = hub.publish(replacement("application-1"));
    const changed = hub.publish({
      type: "draft_changed",
      generation: "application-1",
      draft: {
        text: "saved",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 1,
      },
    });
    const current = hub.publish(replacement("application-2"));

    expect(hub.retainedEventCount).toBe(1);
    expect(hub.canReplay(first.eventId)).toBe(false);
    expect(hub.subscribe(vi.fn(), changed.eventId).replay).toEqual([current]);
  });

  it("captures a large current snapshot without replaying its already-applied suffix", () => {
    const hub = new ThreadEventHub({ replayByteLimit: 2_000 });
    const anchor = hub.publish({
      ...replacement("projection-1"),
      snapshot: {
        ...snapshot(),
        draft: {
          text: "x".repeat(4_000),
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 0,
        },
      },
    });
    const update = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const listener = vi.fn();
    const subscription = hub.subscribeFromCurrentSnapshot(listener);

    expect(subscription.checkpoint).toMatchObject({
      eventId: update.eventId,
      projectionGeneration: "projection-1",
      snapshot: { draft: { text: "x".repeat(4_000) }, runState: "running" },
      capabilityRunState: "idle",
    });
    expect(subscription.checkpoint?.eventId).not.toBe(anchor.eventId);
    expect(subscription.watermark).toBe(2);
    expect(subscription.replay).toEqual([]);
    const live = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });
    expect(listener).toHaveBeenCalledWith(live);
    expect(subscription.checkpoint?.snapshot.runState).toBe("running");
    subscription.close();
  });

  it("retains exact current state after its event suffix is evicted", () => {
    const hub = new ThreadEventHub({ replayLimit: 2 });
    const anchor = hub.publish(replacement("projection-1"));
    for (let requests = 1; requests <= 3; requests += 1) {
      hub.publish({
        type: "usage_changed",
        generation: "projection-1",
        usage: { counters: { requests } },
      });
    }

    expect(hub.canReplay(anchor.eventId)).toBe(false);
    const subscription = hub.subscribeFromCurrentSnapshot(vi.fn());
    expect(subscription.checkpoint).toMatchObject({
      eventId: hub.eventIdAt(4),
      snapshot: { usage: { counters: { requests: 3 } } },
    });
    expect(subscription.replay).toEqual([]);
    subscription.close();
  });

  it.each(["incremental", "replacement"] as const)(
    "pairs the checkpoint with its exact watermark before a retention callback publishes a crossing %s",
    (kind) => {
      const hub = new ThreadEventHub();
      const anchor = hub.publish(replacement("projection-1"));
      const listener = vi.fn();
      const remove = hub.onSubscriberCountChanged((count) => {
        if (count !== 1) return;
        hub.publish(kind === "replacement" ? replacement("projection-2") : {
          type: "usage_changed",
          generation: "projection-1",
          usage: { counters: { requests: 7 } },
        });
      });
      const subscription = hub.subscribeFromCurrentSnapshot(listener);
      expect(subscription.watermark).toBe(1);
      expect(subscription.checkpoint).toMatchObject({
        eventId: anchor.eventId,
        projectionGeneration: "projection-1",
        snapshot: { usage: {} },
      });
      expect(subscription.replay).toEqual([]);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]?.[0]).toMatchObject({ eventId: hub.eventIdAt(2) });
      expect(hub.currentCheckpoint()?.eventId).toBe(hub.eventIdAt(2));
      remove();
      subscription.close();
    },
  );

  it("keeps expanded history and other viewers intact when a new viewer obtains a checkpoint", () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish(replacement("projection-1"));
    const existingViewer = vi.fn();
    const existing = hub.subscribe(existingViewer, anchor.eventId);
    const text = 'Older exact text: 界 🌍 \\"\n'.repeat(8_192);
    const page = hub.publish({
      type: "history_prepend",
      generation: "projection-1",
      page: {
        orderedTurnIds: ["older-turn"],
        turnsById: {
          "older-turn": { id: "older-turn", revision: 1, status: "completed",
            endedBy: "agent_settled", orderedItemIds: ["older-item"] },
        },
        itemsById: {
          "older-item": { id: "older-item", turnId: "older-turn", revision: 1,
            kind: "assistant_message", status: "completed", markdown: { text } },
        },
        forkSource: snapshot().forkSource,
        forksByTurnId: {
          "older-turn": { sourceTurnId: "older-turn", expectedTurnRevision: 1,
            available: false, unavailableReason: { text: "Unavailable." } },
        },
        previousCursor: "remaining-older-history",
      },
    });
    const retainedBytes = hub.retainedBytes;
    const newcomer = hub.subscribeFromCurrentSnapshot(vi.fn());
    const checkpoint = newcomer.checkpoint!;
    expect(checkpoint.snapshot).toEqual(hub.snapshot);
    expect(checkpoint.snapshot.orderedTurnIds).toEqual(["older-turn"]);
    expect(checkpoint.snapshot.history).toEqual({ hasOlder: true, olderCursor: "remaining-older-history" });
    expect(checkpoint.snapshot.itemsById["older-item"]).toMatchObject({ markdown: { text } });
    expect(checkpoint.snapshot.forksByTurnId["older-turn"]).toEqual(hub.snapshot?.forksByTurnId["older-turn"]);
    expect(checkpoint.eventId).toBe(page.eventId);
    expect(hub.watermark).toBe(2);
    expect(hub.retainedBytes).toBe(retainedBytes);
    expect(existingViewer.mock.calls.map(([event]) => event)).toEqual([page]);
    expect(hub.canReplay(anchor.eventId)).toBe(true);
    expect(hub.currentCheckpoint()).toBe(checkpoint);
    newcomer.close();
    existing.close();
  });

  it("bounds checkpoint notices independently of replay and resets them only on published replacement", () => {
    const hub = new ThreadEventHub({ replayLimit: 2 });
    expect(hub.currentCheckpoint()).toBeUndefined();
    hub.publish(replacement("projection-1"));
    for (let index = 0; index < 105; index += 1) {
      hub.publish({
        type: "notice", generation: "projection-1",
        notice: { id: `notice-${index}`, tone: "info", message: { text: `Notice ${index}` },
          createdAt: "2026-09-15T00:00:00.000Z" },
      });
    }
    const checkpoint = hub.currentCheckpoint()!;
    expect(checkpoint.notices.map(({ id }) => id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `notice-${index + 5}`),
    );
    const subscriber = hub.subscribeFromCurrentSnapshot(vi.fn());
    expect(subscriber.checkpoint?.notices).toEqual(checkpoint.notices);
    expect(hub.retainedEventCount).toBe(2);
    hub.publish(replacement("projection-2"));
    expect(hub.currentCheckpoint()).toMatchObject({ projectionGeneration: "projection-2", notices: [] });
    expect(checkpoint.notices).toHaveLength(100);
    subscriber.close();
  });

  it("retains provider capability authority separately from current display state and queue revision", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    hub.publish({ type: "run_state", generation: "projection-1", state: "running" });
    hub.publish({ type: "queue_changed", generation: "projection-1", threadRevision: 5, items: [] });
    expect(hub.currentCheckpoint()).toMatchObject({
      capabilityThreadRevision: 0, capabilityRunState: "idle",
      snapshot: { thread: { threadRevision: 5, runState: "running" },
        runState: "running", capabilities: { runState: "running" } },
    });
    hub.publish({ type: "capabilities_changed", generation: "projection-1", threadRevision: 3,
      capabilities: { ...snapshot().capabilities, runState: "running" }, providerFeatures: [] });
    const checkpoint = hub.currentCheckpoint()!;
    expect(checkpoint).toMatchObject({ capabilityThreadRevision: 3, capabilityRunState: "running",
      snapshot: { thread: { threadRevision: 5 } } });
    expect(() => hub.publish({ type: "capabilities_changed", generation: "projection-1", threadRevision: 2,
      capabilities: snapshot().capabilities, providerFeatures: [] })).toThrow("thread_projection_thread_revision_regressed");
    expect(hub.currentCheckpoint()).toBe(checkpoint);
    hub.publish({ type: "application_state_changed", generation: "projection-1",
      state: { ...applicationState(hub.snapshot!), thread: { ...hub.snapshot!.thread, threadRevision: 6 } } });
    expect(hub.currentCheckpoint()).toMatchObject({ capabilityThreadRevision: 6, capabilityRunState: "running" });
    hub.publish(replacement("projection-2"));
    expect(hub.currentCheckpoint()).toMatchObject({ capabilityThreadRevision: 0, capabilityRunState: "idle" });
  });

  it("stops projected replay cost measurement as soon as the budget is exceeded", () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish(replacement("projection-1"));
    for (let requests = 1; requests <= 10; requests += 1) {
      hub.publish({ type: "usage_changed", generation: "projection-1", usage: { counters: { requests } } });
    }
    const cost = vi.fn((_event: ThreadEventEnvelope) => 100);
    expect(hub.replayCostExceeds(anchor.eventId, 250, cost)).toBe(true);
    expect(cost).toHaveBeenCalledTimes(3);
    expect(cost.mock.calls[0]?.[0]).toMatchObject({ eventId: hub.eventIdAt(2) });
    expect(hub.replayCostExceeds(anchor.eventId, 1_000, () => 100)).toBe(false);
    cost.mockClear();
    expect(hub.replayCostExceeds("invalid-cursor", 250, cost)).toBeUndefined();
    expect(cost).not.toHaveBeenCalled();
  });

  it("fails closed on turn revision regression and same-revision conflict", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    const upsert = (revision: number, status: "in_progress" | "completed") =>
      hub.publish({
        type: "turn_upsert",
        generation: "projection-1",
        turn: {
          id: "turn-1",
          revision,
          status,
          orderedItemIds: [],
        },
        fork: {
          sourceTurnId: "turn-1",
          expectedTurnRevision: revision,
          available: false,
          unavailableReason: {
            text: "Forking is unavailable in this fixture.",
          },
        },
      });

    upsert(1, "in_progress");
    expect(() => upsert(0, "in_progress")).toThrow(
      "thread_projection_turn_revision_regressed",
    );
    expect(() => upsert(1, "completed")).toThrow(
      "thread_projection_turn_revision_conflict",
    );
    // Identical republication is a harmless duplicate, not an inversion.
    expect(() => upsert(1, "in_progress")).not.toThrow();
    expect(() => upsert(2, "completed")).not.toThrow();
    // The rejected publications never reached the retained mirror or stream.
    expect(hub.snapshot?.turnsById["turn-1"]).toMatchObject({
      revision: 2,
      status: "completed",
    });
    expect(hub.retainedEventCount).toBe(4);
  });

  it("fails closed on item revision regression and same-revision conflict", () => {
    const hub = new ThreadEventHub();
    hub.publish({
      ...replacement("projection-1"),
      snapshot: {
        ...snapshot(),
        orderedTurnIds: ["turn-1"],
        turnsById: {
          "turn-1": {
            id: "turn-1",
            revision: 0,
            status: "in_progress",
            orderedItemIds: ["item-1"],
          },
        },
        forksByTurnId: {
          "turn-1": {
            sourceTurnId: "turn-1",
            expectedTurnRevision: 0,
            available: false,
            unavailableReason: {
              text: "Forking is unavailable in this fixture.",
            },
          },
        },
        itemsById: {
          "item-1": {
            id: "item-1",
            turnId: "turn-1",
            revision: 0,
            kind: "assistant_message",
            status: "streaming",
            markdown: { text: "seed" },
          },
        },
      },
    });
    const upsert = (revision: number, text: string) =>
      hub.publish({
        type: "item_upsert",
        generation: "projection-1",
        item: {
          id: "item-1",
          turnId: "turn-1",
          revision,
          kind: "assistant_message",
          status: "streaming",
          markdown: { text },
        },
      });

    upsert(3, "latest");
    expect(() => upsert(2, "stale")).toThrow(
      "thread_projection_item_revision_regressed",
    );
    expect(() => upsert(3, "divergent")).toThrow(
      "thread_projection_item_revision_conflict",
    );
    expect(() => upsert(3, "latest")).not.toThrow();
    expect(() => upsert(4, "newer")).not.toThrow();
    expect(hub.snapshot?.itemsById["item-1"]).toMatchObject({ revision: 4 });
  });

  it("applies provider feature projections atomically and fails closed on stale revisions", () => {
    const hub = new ThreadEventHub();
    hub.publish(replacement("projection-1"));
    const feature = (
      revision: number,
      status = "unset",
      threadRevision = 0,
    ): Extract<
      NormalizedThreadEvent,
      { readonly type: "capabilities_changed" }
    > => ({
      type: "capabilities_changed" as const,
      generation: "projection-1",
      threadRevision,
      capabilities: {
        ...snapshot().capabilities,
        providerFeatures: [
          {
            ref: { featureId: "codex.goal", schemaVersion: 1 },
            revision,
            label: { text: "Goal" },
            availability: "available" as const,
            operations: [],
            presentationSlots: ["composer_action" as const],
          },
        ],
      },
      providerFeatures: [
        {
          ref: { featureId: "codex.goal", schemaVersion: 1 },
          revision,
          state: {
            kind: "object" as const,
            entries: [{ key: { text: "state" }, value: { text: status } }],
          },
        },
      ],
    });

    hub.publish(feature(2));
    expect(hub.snapshot?.providerFeatures).toHaveLength(1);
    expect(() => hub.publish(feature(1))).toThrow(
      "thread_projection_provider_feature_revision_regressed",
    );
    expect(() => hub.publish(feature(2))).not.toThrow();
    const readOnly = feature(2);
    readOnly.capabilities.providerFeatures[0] = {
      ...readOnly.capabilities.providerFeatures[0]!,
      availability: "read_only",
      unavailableReason: { text: "The thread is currently busy." },
    };
    expect(() => hub.publish(readOnly)).not.toThrow();
    expect(hub.snapshot?.capabilities.providerFeatures[0]).toMatchObject({
      availability: "read_only",
      revision: 2,
    });
    expect(() => hub.publish(feature(2))).not.toThrow();
    expect(() => hub.publish(feature(2, "complete"))).toThrow(
      "thread_projection_provider_feature_revision_conflict",
    );
    const relabeled = feature(2);
    relabeled.capabilities.providerFeatures[0] = {
      ...relabeled.capabilities.providerFeatures[0]!,
      label: { text: "Changed goal" },
    };
    expect(() => hub.publish(relabeled)).toThrow(
      "thread_projection_provider_feature_revision_conflict",
    );
    const changedOperations = feature(2);
    changedOperations.capabilities.providerFeatures[0] = {
      ...changedOperations.capabilities.providerFeatures[0]!,
      operations: [
        {
          actionId: "clear",
          label: { text: "Clear" },
          effects: {
            application: "write",
            modelUsage: "none",
            external: "none",
          },
          confirmation: "none",
          execution: "inline",
        },
      ],
    };
    expect(() => hub.publish(changedOperations)).toThrow(
      "thread_projection_provider_feature_revision_conflict",
    );
    const unavailable = feature(2);
    unavailable.capabilities.providerFeatures[0] = {
      ...unavailable.capabilities.providerFeatures[0]!,
      availability: "unavailable",
      unavailableReason: { text: "The provider removed the feature." },
    };
    expect(() => hub.publish(unavailable)).toThrow(
      "thread_projection_provider_feature_revision_conflict",
    );
    expect(() => hub.publish(feature(3, "unset", 4))).not.toThrow();
    expect(hub.snapshot?.providerFeatures[0]).toMatchObject({ revision: 3 });
    expect(hub.snapshot?.thread.threadRevision).toBe(4);
    expect(() => hub.publish(feature(4, "unset", 3))).toThrow(
      "thread_projection_thread_revision_regressed",
    );

    const operation = (actionId: string) => ({
      actionId,
      label: { text: actionId },
      effects: {
        application: "write" as const,
        modelUsage: "none" as const,
        external: "none" as const,
      },
      confirmation: "none" as const,
      execution: "inline" as const,
    });
    const withOperations = (actionIds: readonly string[]) => {
      const projection = feature(4, "unset", 4);
      projection.capabilities.providerFeatures[0] = {
        ...projection.capabilities.providerFeatures[0]!,
        operations: actionIds.map(operation),
      };
      return projection;
    };
    expect(() =>
      hub.publish(withOperations(["observe", "reconfigure"])),
    ).not.toThrow();
    expect(() => hub.publish(withOperations(["observe"]))).not.toThrow();
    expect(hub.snapshot?.capabilities.providerFeatures[0]?.operations).toEqual([
      expect.objectContaining({ actionId: "observe" }),
    ]);
    expect(() =>
      hub.publish(withOperations(["observe", "reconfigure"])),
    ).not.toThrow();
    expect(() =>
      hub.publish(withOperations(["reconfigure", "observe"])),
    ).toThrow("thread_projection_provider_feature_revision_conflict");
  });
});
