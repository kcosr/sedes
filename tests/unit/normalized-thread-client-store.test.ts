// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../../src/client/api/ApiClient.js";
import type {
  ConnectionState,
  EventStreamTransport,
  ThreadLoadStreamDiagnostics,
} from "../../src/client/api/EventStreamTransport.js";
import { BrowserEventStreamTransport } from "../../src/client/api/EventStreamTransport.js";
import {
  DeliveryRecoveryRequiredError,
  ThreadClientStore,
} from "../../src/client/stores/ThreadClientStore.js";
import type {
  ActivityDetailMode,
  NormalizedDraft,
  NormalizedThreadSnapshot,
  ThreadApplicationMutationResult,
  ThreadApplicationOperation,
  ThreadEventEnvelope,
  ThreadCheckpoint,
  ThreadHistorySeekResult,
  ThreadLoadError,
  RespondToQuestionResult,
  QueuedInputSummary,
} from "../../src/shared/index.js";
import {
  clearDiagnostics,
  readDiagnostics,
} from "../../src/client/app/diagnostics.js";
import { setDiagnosticCategoryEnabled } from "../../src/client/app/settings.js";
import {
  beginThreadLoadAttempt,
  resetThreadLoadAttemptsForTests,
} from "../../src/client/app/thread-load-diagnostics.js";

const hubId = "10000000-0000-4000-8000-000000000001";

afterEach(() => {
  clearDiagnostics();
  resetThreadLoadAttemptsForTests();
  localStorage.clear();
});

class FakeTransport implements EventStreamTransport {
  readonly closes: Array<ReturnType<typeof vi.fn>> = [];
  readonly threads: Array<{
    activityDetail: ActivityDetailMode;
    onEnvelope: (envelope: ThreadEventEnvelope) => void;
    onCheckpoint?: (checkpoint: ThreadCheckpoint) => void;
    onConnection: (state: ConnectionState) => void;
    onLive?: () => boolean | void;
    onLoadError?: (error: ThreadLoadError) => void;
    onProtocolError?: (error: Error) => void;
    onTerminalProtocolError?: (error: Error) => void;
    getReplayCursor?: () => string | undefined;
    loadDiagnostics?: ThreadLoadStreamDiagnostics;
  }> = [];
  thread?: {
    activityDetail: ActivityDetailMode;
    onEnvelope: (envelope: ThreadEventEnvelope) => void;
    onCheckpoint?: (checkpoint: ThreadCheckpoint) => void;
    onConnection: (state: ConnectionState) => void;
    onLive?: () => boolean | void;
    onLoadError?: (error: ThreadLoadError) => void;
    onProtocolError?: (error: Error) => void;
    onTerminalProtocolError?: (error: Error) => void;
    getReplayCursor?: () => string | undefined;
    loadDiagnostics?: ThreadLoadStreamDiagnostics;
  };

  subscribeApplication(): { close(): void } {
    throw new Error("not used");
  }

  subscribeWorkspaceFiles(): { close(): void } {
    return { close: () => undefined };
  }

  subscribeThread(
    _threadId: string,
    input: {
      activityDetail: ActivityDetailMode;
      onEnvelope: (envelope: ThreadEventEnvelope) => void;
      onCheckpoint?: (checkpoint: ThreadCheckpoint) => void;
      onConnection: (state: ConnectionState) => void;
      onLive?: () => boolean | void;
      onLoadError?: (error: ThreadLoadError) => void;
      onProtocolError?: (error: Error) => void;
      onTerminalProtocolError?: (error: Error) => void;
      getReplayCursor?: () => string | undefined;
      loadDiagnostics?: ThreadLoadStreamDiagnostics;
    },
  ): { close(): void } {
    this.thread = input;
    this.threads.push(input);
    const close = vi.fn();
    this.closes.push(close);
    return { close };
  }

  reconnectAll(): void {}
  markAllNativeSuspended(): void {}
  closeAll(): void {}
}

class FakeBrowserEventSource {
  static instances: FakeBrowserEventSource[] = [];
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror?: () => void;
  closed = false;

  constructor() {
    FakeBrowserEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(
      name,
      listener as unknown as (event: { data: string }) => void,
    );
  }

  close(): void {
    this.closed = true;
  }

  emit(name: string, value: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(value) });
  }
}

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
    forksByTurnId: {
      "turn-1": {
        sourceTurnId: "turn-1",
        expectedTurnRevision: 0,
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 7,
      runState: "running",
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
      text: "Continue",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "cli", mode: "progressive" },
      presentationOptions: [
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: ["turn-1"],
    turnsById: {
      "turn-1": {
        id: "turn-1",
        revision: 0,
        status: "in_progress",
        orderedItemIds: [],
      },
    },
    itemsById: {},
    history: { hasOlder: false },
    runState: "running",
    activeTurnId: "turn-1",
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
      revision: "cap-1",
      backend: { label: { text: "Assistant" } },
      interactionMode: "interactive",
      runState: "running",
      operations: [
        {
          id: "interrupt",
          label: { text: "Interrupt" },
          destructive: false,
          available: true,
          parameters: { kind: "none" },
        },
      ],
      deliveryModes: [
        {
          id: "steer",
          steerTarget: "turn",
          label: { text: "Steer" },
          available: true,
        },
      ],
      settings: [
        {
          id: "model",
          label: { text: "Model" },
          requiredForFirstSubmission: true,
          available: true,
          options: [
            {
              value: "model-option-2",
              label: { text: "Model 2" },
              available: true,
            },
          ],
        },
      ],
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
    settings: {
      revision: 3,
      values: [
        {
          id: "model",
          desiredValue: "model-option-1",
          effectiveValue: "model-option-1",
          applicationState: "effective",
        },
      ],
    },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}

function snapshotWithDeliveryModes(
  runState: NormalizedThreadSnapshot["runState"] = "idle",
): NormalizedThreadSnapshot {
  const current = snapshot();
  const configured = {
    ...current,
    thread: {
      ...current.thread,
      runState,
      queuedInputCount: 0,
    },
    runState,
    capabilities: {
      ...current.capabilities,
      runState,
      deliveryModes: (["submit", "steer", "queue"] as const).map((id) => ({
        id,
        steerTarget: id === "steer" ? "turn" as const : null,
        label: { text: id },
        available: true,
      })),
    },
  };
  if (runState === "running") return configured;
  const { activeTurnId: _activeTurnId, ...settled } = configured;
  return settled;
}

function composerDraft(text = "Continue"): NormalizedDraft {
  return {
    text,
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    revision: 4,
  };
}

function interactionSnapshot(): NormalizedThreadSnapshot {
  const current = snapshot();
  current.capabilities = {
    ...current.capabilities,
    interactions: [{ kind: "confirmation", available: true }],
  };
  current.interactions = [
    {
      id: "interaction-1",
      threadId: "thread-1",
      kind: "confirmation",
      sourceLabel: { text: "Agent" },
      title: { text: "Approval" },
      message: { text: "Continue?" },
      openedAt: "2026-08-10T12:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
    },
  ];
  return current;
}

function installSnapshot(
  transport: FakeTransport,
  current: NormalizedThreadSnapshot = snapshot(),
): void {
  transport.thread?.onConnection("connected");
  transport.thread?.onEnvelope({
    eventId: `${hubId}.0`,
    projectionGeneration: "projection-1",
    event: {
      type: "snapshot",
      generation: "projection-1",
      snapshot: current,
    },
  });
}

function deliverPreparedSteer(
  store: ThreadClientStore,
  draft: NormalizedDraft,
  operationId = "delivery-1",
): Promise<NormalizedDraft> {
  store.stageComposerTransfer(operationId, "steer", draft);
  return store.deliver("steer", draft, operationId);
}

function emitMaterializedSteer(
  transport: FakeTransport,
  operationId: string,
  sequence = 1,
): void {
  transport.thread?.onEnvelope({
    eventId: `${hubId}.${sequence}`,
    projectionGeneration: "projection-1",
    event: {
      type: "item_upsert",
      generation: "projection-1",
      item: {
        id: `user-${sequence}`,
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 0,
        content: [{ kind: "text", text: { text: "Continue" } }],
        deliveryOperationId: operationId,
      },
    },
  });
}

describe("ThreadClientStore normalized operations", () => {
  it("retains explicit question opening intent until the thread panel can consume it", () => {
    const store = new ThreadClientStore("thread-1", {} as ApiClient, new FakeTransport());
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot().questionInboxOpenRevision).toBe(0);
    store.requestQuestionInboxOpen();
    expect(store.getSnapshot().questionInboxOpenRevision).toBe(1);
    expect(store.getSnapshot().questionRequests).toEqual([]);
    store.requestQuestionInboxOpen();
    expect(store.getSnapshot().questionInboxOpenRevision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("hard-resets and reconnects without a replay cursor when activity detail changes", async () => {
    let releaseHistory!: (envelope: ThreadEventEnvelope) => void;
    const loadOlderHistory = vi.fn(
      () =>
        new Promise<ThreadEventEnvelope>((resolve) => {
          releaseHistory = resolve;
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { loadOlderHistory } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const initial = snapshot();
    initial.history = { hasOlder: true, olderCursor: "older-1" };
    installSnapshot(transport, initial);
    store.stageComposerTransfer("pending-steer", "steer", initial.draft);
    const staleLoad = store.loadOlderHistory();

    expect(transport.threads[0]?.activityDetail).toBe("full");
    expect(transport.threads[0]?.getReplayCursor?.()).toBe(`${hubId}.0`);
    expect(store.snapshotSerializedBytes).toBeGreaterThan(0);

    store.setActivityDetail("summary");

    expect(transport.closes[0]).toHaveBeenCalledOnce();
    expect(transport.threads).toHaveLength(2);
    expect(transport.threads[1]?.activityDetail).toBe("summary");
    expect(transport.threads[1]?.getReplayCursor?.()).toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      status: "loading",
      connection: "reconnecting",
      authoritative: false,
      historyLoading: false,
      pendingComposerTransfers: [{ operationId: "pending-steer" }],
    });
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(store.normalized.state.generation).toBeUndefined();
    expect(store.snapshotSerializedBytes).toBe(0);

    releaseHistory({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: [],
          turnsById: {},
          forkSource: initial.forkSource,
          forksByTurnId: {},
          itemsById: {},
        },
      },
    });
    await expect(staleLoad).rejects.toThrow(
      "Activity detail changed while history was loading",
    );
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(loadOlderHistory).toHaveBeenCalledWith(
      "thread-1",
      "older-1",
      10,
      "full",
    );
  });

  it("clears a cached inactive projection without reconnecting it", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport);
    expect(store.snapshotSerializedBytes).toBeGreaterThan(0);
    expect(store.normalized.replayCursor).toBe(`${hubId}.0`);
    store.pause("inactive");

    store.setActivityDetail("summary");

    expect(transport.threads).toHaveLength(1);
    expect(store.activityDetail).toBe("summary");
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(store.normalized.state.generation).toBeUndefined();
    expect(store.normalized.replayCursor).toBeUndefined();
    expect(store.snapshotSerializedBytes).toBe(0);
  });

  it("rolls back a staged Steer when projection reset wins before delivery starts", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread: vi.fn() } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const initial = snapshot();
    installSnapshot(transport, initial);
    store.stageComposerTransfer("steer-before-reset", "steer", initial.draft);

    const delivery = store.deliver(
      "steer",
      initial.draft,
      "steer-before-reset",
    );
    store.setActivityDetail("summary");

    await expect(delivery).rejects.toThrow(
      "Wait for the thread to reconnect and receive an authoritative snapshot.",
    );
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "steer-before-reset",
        requestState: "request_failed",
        authorityState: "rolled_back_tombstone",
        rollbackRequired: true,
        steerPhase: "sending",
      },
    ]);
    store.dispose();
  });

  it("rejects a targeted history result that resolves after an activity switch", async () => {
    let releaseSeek!: (result: ThreadHistorySeekResult) => void;
    const seekHistoryTurn = vi.fn(
      () =>
        new Promise<ThreadHistorySeekResult>((resolve) => {
          releaseSeek = resolve;
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { seekHistoryTurn } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);
    const staleSeek = store.seekHistoryTurn("turn-old");

    store.setActivityDetail("summary");
    releaseSeek({
      status: "found",
      targetTurnId: "turn-old",
      page: {
        orderedTurnIds: ["turn-old"],
        turnsById: {
          "turn-old": {
            id: "turn-old",
            revision: 0,
            status: "completed",
            endedBy: "agent_settled",
            orderedItemIds: [],
          },
        },
        forkSource: snapshot().forkSource,
        forksByTurnId: {
          "turn-old": {
            sourceTurnId: "turn-old",
            expectedTurnRevision: 0,
            available: false,
            unavailableReason: { text: "Unavailable." },
          },
        },
        itemsById: {},
      },
    });

    await expect(staleSeek).rejects.toThrow(
      "Activity detail changed while history was loading",
    );
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(store.snapshotSerializedBytes).toBe(0);
    expect(seekHistoryTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-old",
      "full",
    );
  });

  it("fails closed when a stream sends activity from the other projection", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      {} as ApiClient,
      transport,
      "summary",
    );
    await store.start();
    const leaked = snapshot();
    leaked.turnsById["turn-1"] = {
      ...leaked.turnsById["turn-1"]!,
      orderedItemIds: ["reasoning-1"],
    };
    leaked.itemsById["reasoning-1"] = {
      id: "reasoning-1",
      turnId: "turn-1",
      kind: "reasoning",
      status: "completed",
      revision: 0,
      markdown: { text: "must not cross the summary boundary" },
    };

    expect(() => installSnapshot(transport, leaked)).toThrow(
      "wrong activity detail projection",
    );
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(store.snapshotSerializedBytes).toBe(0);

    const fullTransport = new FakeTransport();
    const fullStore = new ThreadClientStore(
      "thread-1",
      {} as ApiClient,
      fullTransport,
      "full",
    );
    await fullStore.start();
    const improperlySummarized = snapshot();
    improperlySummarized.turnsById["turn-1"] = {
      ...improperlySummarized.turnsById["turn-1"]!,
      orderedItemIds: ["summary-1"],
    };
    improperlySummarized.itemsById["summary-1"] = {
      id: "summary-1",
      turnId: "turn-1",
      kind: "activity_summary",
      activityKind: "tool",
      status: "completed",
      revision: 0,
    };
    expect(() => installSnapshot(fullTransport, improperlySummarized)).toThrow(
      "wrong activity detail projection",
    );
    expect(fullStore.getSnapshot().snapshot).toBeUndefined();
  });

  it("includes task identity in a selected-skill pending-Steer preview", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport);

    store.stageComposerTransfer("skill-task-steer", "steer", {
      text: "",
      selectedSkillId: "skill-review",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [
        {
          taskId: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
          titleSnapshot: "Resolve exact task",
        },
      ],
      revision: 1,
    });

    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "skill-task-steer",
        mode: "steer",
        presentation: "pending_steer",
        steerPhase: "sending",
        captured: {
          text: "",
          selectedSkillId: "skill-review",
          taskReferences: [
            {
              taskId: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
              titleSnapshot: "Resolve exact task",
            },
          ],
        },
      },
    ]);
  });

  it("surfaces why a recovered fork was discarded", async () => {
    const operateThread = vi.fn(async () => ({
      status: "aborted" as const,
      diagnostic: "An earlier attempt of this fork already created its Claude session, but that history does not match the selected turn.",
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", { operateThread } as unknown as ApiClient, transport);
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes("idle"));
    await expect(store.recoverUncertain()).rejects.toThrow(
      "The fork was discarded. An earlier attempt of this fork already created its Claude session",
    );
    expect(operateThread).toHaveBeenCalledWith("thread-1", { kind: "recover_uncertain" });
    expect(store.getSnapshot().actionError).toContain("The fork was discarded.");
    store.dispose();
  });

  it("captures conversation targeting without binding delivery to the observed turn", async () => {
    const draft = composerDraft("Use the revised approach");
    const cleared = { ...composerDraft(""), revision: draft.revision + 1 };
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "steer" as const,
      queuedInputId: "queued-conversation-steer",
      threadRevision: 9,
      draft: cleared,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", { operateThread } as unknown as ApiClient, transport);
    await store.start();
    const current = snapshotWithDeliveryModes("running");
    current.capabilities.deliveryModes = current.capabilities.deliveryModes.map(mode => ({
      ...mode, steerTarget: mode.id === "steer" ? "conversation" : null,
    }));
    installSnapshot(transport, current);
    store.stageComposerTransfer("conversation-steer", "steer", draft);
    await store.deliver("steer", draft, "conversation-steer");
    expect(operateThread).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      mode: "steer", steerTarget: { kind: "conversation" }, mutationId: "conversation-steer",
    }));

    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      steerTarget: { kind: "conversation" }, authorityState: "client_only",
    });
    store.dispose();
  });

  it("submits the observed Steer target when capability settles before the request", async () => {
    const draft = composerDraft("Capability changed");
    const cleared = {
      ...composerDraft(""),
      revision: draft.revision + 1,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "submit" as const,
      queuedInputId: "queued-capability-steer",
      threadRevision: 9,
      draft: cleared,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes("running"));
    store.stageComposerTransfer("capability-steer", "steer", draft);
    const current = store.getSnapshot().snapshot!;
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "capabilities_changed",
        generation: "projection-1",
        threadRevision: 8,
        capabilities: {
          ...current.capabilities,
          revision: "capability-steer-unavailable",
          deliveryModes: current.capabilities.deliveryModes.map((mode) =>
            mode.id === "steer"
              ? {
                  ...mode,
                  available: false,
                  unavailableReason: { text: "Steer is no longer available." },
                }
              : mode,
          ),
        },
        providerFeatures: current.providerFeatures,
      },
    });
    await vi.waitFor(() =>
      expect(
        store
          .getSnapshot()
          .snapshot?.capabilities.deliveryModes.find(({ id }) => id === "steer")
          ?.available,
      ).toBe(false),
    );

    await expect(
      store.deliver("steer", draft, "capability-steer"),
    ).resolves.toEqual(cleared);
    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "deliver",
      mode: "steer",
      mutationId: "capability-steer",
      expectedThreadRevision: 8,
      expectedDraftRevision: draft.revision,
      steerTarget: { kind: "turn", turnId: "turn-1" },
    });
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      operationId: "capability-steer",
      requestState: "receipt_received",
      authorityState: "client_only",
      queuedInputId: "queued-capability-steer",
    });
  });

  it("uses the caller-prepared operation ID for an optimistic submit", async () => {
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "submit" as const,
      queuedInputId: "queued-submit",
      threadRevision: 8,
      draft: {
        ...composerDraft(""),
        revision: 5,
        updatedAt: "2026-08-13T22:00:00.000Z",
      },
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft();

    store.stageComposerTransfer("prepared-submit", "submit", draft, {
      selectedSkillLabel: "Review",
    });
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      operationId: "prepared-submit",
      mode: "submit",
      presentation: "transcript",
      requestState: "saving",
      authorityState: "client_only",
      capturedPresentation: { selectedSkillLabel: "Review" },
    });

    await expect(
      store.deliver("submit", draft, "prepared-submit"),
    ).resolves.toMatchObject({ revision: 5 });
    expect(operateThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ mutationId: "prepared-submit" }),
    );
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      requestState: "receipt_received",
      acceptanceEvidence: "durably_queued",
      queuedInputId: "queued-submit",
    });
  });

  it("keeps an accepted submit bridged when its queue row retires before exact materialization", async () => {
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "submit" as const,
      queuedInputId: "accepted-submit-row",
      threadRevision: 8,
      draft: {
        ...composerDraft(""),
        revision: 5,
        updatedAt: "2026-08-13T22:00:00.000Z",
      },
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft("Accepted before projection");

    store.stageComposerTransfer("accepted-submit", "submit", draft);
    await store.deliver("submit", draft, "accepted-submit");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [],
      },
    });

    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
        {
          operationId: "accepted-submit",
          requestState: "receipt_received",
          acceptanceEvidence: "durably_queued",
          authorityState: "client_only",
        },
      ]),
    );
    expect(store.getSnapshot().actionError).toBeUndefined();

    emitMaterializedSteer(transport, "accepted-submit", 2);
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toEqual([]),
    );
    expect(store.getSnapshot().actionError).toBeUndefined();
  });

  it("rejects mode-incompatible and identity-mismatched delivery receipts", async () => {
    const cleared = {
      text: "" as const,
      contextExcerpts: [] as [],
      attachments: [] as [],
      taskReferences: [] as [],
      revision: 5,
      updatedAt: "2026-08-13T22:00:00.000Z",
    };
    const retained = {
      ...composerDraft("Retained"),
      updatedAt: "2026-08-13T22:00:00.000Z",
    };
    const cases = [
      {
        label: "submit accepted for another operation",
        mode: "submit" as const,
        result: {
          status: "delivery_accepted" as const,
          resolvedDeliveryMode: "steer" as const,
          operationId: "another-operation",
          threadRevision: 8,
          draft: cleared,
        },
        error: "invalid authoritative draft receipt",
      },
      {
        label: "submit reported pending materialization",
        mode: "submit" as const,
        result: {
          status: "delivery_pending_materialization" as const,
          operationId: "tested-operation",
          threadRevision: 8,
          draft: retained,
        },
        error: "invalid pending-materialization receipt",
      },
    ];

    for (const testCase of cases) {
      const operateThread = vi.fn(async () => testCase.result);
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { operateThread } as unknown as ApiClient,
        transport,
      );
      await store.start();
      const current = snapshotWithDeliveryModes("idle");
      installSnapshot(
        transport,
        testCase.label === "submit accepted for another operation"
          ? {
              ...current,
              thread: { ...current.thread, backingState: "unbound" },
            }
          : current,
      );
      const draft = composerDraft(testCase.label);
      store.stageComposerTransfer("tested-operation", testCase.mode, draft);

      await expect(
        store.deliver(testCase.mode, draft, "tested-operation"),
      ).rejects.toThrow(testCase.error);
      const transfer = store.getSnapshot().pendingComposerTransfers[0];
      expect(transfer).toMatchObject({
        mode: testCase.mode,
        requestState: "request_failed",
        authorityState: "rolled_back_tombstone",
        rollbackRequired: true,
      });
      store.dispose();
    }
  });

  it("accepts the queued receipt required by explicit Queue delivery", async () => {
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "submit" as const,
      queuedInputId: "explicit-queue-row",
      threadRevision: 8,
      draft: {
        text: "" as const,
        contextExcerpts: [] as [],
        attachments: [] as [],
        taskReferences: [] as [],
        revision: 5,
        updatedAt: "2026-08-13T22:00:00.000Z",
      },
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft("Queue this");
    store.stageComposerTransfer("explicit-queue-operation", "queue", draft);

    await expect(
      store.deliver("queue", draft, "explicit-queue-operation"),
    ).resolves.toMatchObject({ revision: 5 });
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      mode: "queue",
      resolvedDeliveryMode: "submit",
      presentation: "transcript",
      requestState: "receipt_received",
      acceptanceEvidence: "durably_queued",
      queuedInputId: "explicit-queue-row",
    });
  });

  it.each([
    {
      requested: "submit" as const,
      resolved: "steer" as const,
      presentation: "pending_steer" as const,
    },
    {
      requested: "submit" as const,
      resolved: "queue" as const,
      presentation: "pending_queue" as const,
    },
    {
      requested: "steer" as const,
      resolved: "submit" as const,
      presentation: "transcript" as const,
    },
  ])(
    "remaps $requested presentation to authoritative $resolved",
    async ({ requested, resolved, presentation }) => {
      const operateThread = vi.fn(async () => ({
        status: "delivery_queued" as const,
        resolvedDeliveryMode: resolved,
        queuedInputId: "resolved-row",
        threadRevision: 8,
        draft: {
          ...composerDraft(""),
          revision: 5,
          updatedAt: "2026-08-13T22:00:00.000Z",
        },
      }));
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { operateThread } as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport, snapshotWithDeliveryModes("running"));
      const draft = composerDraft("Resolve this");
      store.stageComposerTransfer("resolved-operation", requested, draft);

      await store.deliver(requested, draft, "resolved-operation");

      expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
        mode: requested,
        resolvedDeliveryMode: resolved,
        presentation,
        ...(resolved === "steer" ? { steerPhase: "steering" } : {}),
      });
      store.dispose();
    },
  );

  it("revision-fences a second real delivery until the first receipt reaches SSE", async () => {
    const operateThread = vi
      .fn()
      .mockResolvedValueOnce({
        status: "delivery_queued" as const,
        resolvedDeliveryMode: "submit" as const,
        queuedInputId: "queued-first",
        threadRevision: 8,
        draft: {
          ...composerDraft(""),
          revision: 5,
          updatedAt: "2026-08-13T22:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        status: "delivery_accepted" as const,
        resolvedDeliveryMode: "submit" as const,
        operationId: "second-receipt",
        threadRevision: 9,
        draft: {
          ...composerDraft(""),
          revision: 6,
          updatedAt: "2026-08-13T22:00:01.000Z",
        },
      });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const first = composerDraft("First");
    store.stageComposerTransfer("first-receipt", "submit", first);
    await store.deliver("submit", first, "first-receipt");
    expect(store.getSnapshot().pendingDeliveryThreadRevision).toBe(8);
    expect(() =>
      store.stageComposerTransfer("second-receipt", "submit", {
        ...composerDraft("Second"),
        revision: 5,
      }),
    ).toThrow("Wait for the pending delivery to resolve");

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "queued-first",
            deliveryOperationId: "first-receipt",
            resolvedDeliveryMode: "submit" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "pending",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "First" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingDeliveryThreadRevision).toBeUndefined(),
    );

    const second = { ...composerDraft("Second"), revision: 5 };
    store.stageComposerTransfer("second-receipt", "submit", second);
    await store.deliver("submit", second, "second-receipt");
    expect(operateThread).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({
        mutationId: "second-receipt",
        expectedThreadRevision: 8,
        expectedDraftRevision: 5,
      }),
    );
    expect(store.getSnapshot().pendingDeliveryThreadRevision).toBe(9);
  });

  it("admits a second Steer after the first durable receipt reaches SSE without waiting for materialization", async () => {
    const operateThread = vi
      .fn()
      .mockResolvedValueOnce({
        status: "delivery_queued" as const,
        resolvedDeliveryMode: "steer" as const,
        queuedInputId: "queued-steer-first",
        threadRevision: 8,
        draft: {
          ...composerDraft(""),
          revision: 5,
          updatedAt: "2026-08-13T22:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        status: "delivery_queued" as const,
        resolvedDeliveryMode: "steer" as const,
        queuedInputId: "queued-steer-second",
        threadRevision: 9,
        draft: {
          ...composerDraft(""),
          revision: 6,
          updatedAt: "2026-08-13T22:00:01.000Z",
        },
      });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes("running"));
    const first = composerDraft("First steer");
    store.stageComposerTransfer("first-steer", "steer", first);
    await store.deliver("steer", first, "first-steer");

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "queued-steer-first",
            deliveryOperationId: "first-steer",
            resolvedDeliveryMode: "steer" as const,
            requestedDeliveryMode: "steer",
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "dispatching",
            deliveryMode: "steer",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "First steer" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingDeliveryThreadRevision).toBeUndefined(),
    );

    const second = { ...composerDraft("Second steer"), revision: 5 };
    store.stageComposerTransfer("second-steer", "steer", second);
    await store.deliver("steer", second, "second-steer");

    expect(operateThread).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({
        mode: "steer",
        mutationId: "second-steer",
        expectedThreadRevision: 8,
        expectedDraftRevision: 5,
      }),
    );
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "first-steer",
        authorityState: "queue_owned",
      },
      {
        operationId: "second-steer",
        requestState: "receipt_received",
        acceptanceEvidence: "durably_queued",
      },
    ]);
  });

  it("keeps submit demotion sticky across retry-to-dispatching events in one flush", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    store.stageComposerTransfer(
      "sticky-demotion",
      "submit",
      composerDraft("Sticky"),
    );
    const base = {
      id: "sticky-row",
      deliveryOperationId: "sticky-demotion",
      resolvedDeliveryMode: "queue" as const,
      sequence: 1,
      origin: "user" as const,
      isHead: true,
      attachmentCount: 0,
      taskCount: 0,
      preview: { text: "Sticky" },
      createdAt: "2026-08-13T22:00:00.000Z",
    };
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            ...base,
            state: "retry_wait",
            nextAttemptAt: "2026-08-13T22:01:00.000Z",
          },
        ],
      },
    });
    transport.thread?.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 9,
        items: [{ ...base, state: "dispatching", deliveryMode: "submit" }],
      },
    });
    transport.thread?.onLive?.();

    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
    expect(store.getSnapshot().snapshot?.queue[0]).toMatchObject({
      state: "dispatching",
      deliveryOperationId: "sticky-demotion",
      resolvedDeliveryMode: "queue" as const,
    });
  });

  it("hands explicit Queue and unhealthy submit presentation to exact authoritative rows", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes("running"));
    store.stageComposerTransfer("queue-operation", "queue", composerDraft("Q"));

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "queue-row",
            deliveryOperationId: "queue-operation",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "pending",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "Q" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toEqual([]),
    );

    store.stageComposerTransfer(
      "submit-operation",
      "submit",
      composerDraft("S"),
    );
    transport.thread?.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 9,
        items: [
          {
            id: "submit-row",
            deliveryOperationId: "submit-operation",
            resolvedDeliveryMode: "queue" as const,
            sequence: 2,
            origin: "user",
            isHead: true,
            state: "retry_wait",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "S" },
            createdAt: "2026-08-13T22:00:01.000Z",
            nextAttemptAt: "2026-08-13T22:01:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toEqual([]),
    );
  });

  it("lets an exact healthy submit queue row own recovery after the HTTP response is lost", async () => {
    let rejectRequest!: (error: unknown) => void;
    const operateThread = vi.fn(
      () =>
        new Promise<ThreadApplicationMutationResult>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft("Durably queued");
    store.stageComposerTransfer("durable-operation", "submit", draft);
    const delivery = store.deliver("submit", draft, "durable-operation");
    await vi.waitFor(() => expect(operateThread).toHaveBeenCalledOnce());

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "durable-row",
            deliveryOperationId: "durable-operation",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "dispatching",
            deliveryMode: "submit",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "Durably queued" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().snapshot?.queue[0]).toMatchObject({
        id: "durable-row",
        deliveryOperationId: "durable-operation",
        resolvedDeliveryMode: "queue" as const,
      }),
    );
    rejectRequest(new TypeError("response lost"));
    await expect(delivery).rejects.toThrow("response lost");
    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
    expect(store.getSnapshot().snapshot?.queue[0]).toMatchObject({
      id: "durable-row",
      deliveryOperationId: "durable-operation",
      resolvedDeliveryMode: "queue" as const,
    });
  });

  it("signals inverse composer reconciliation when a durable queue row follows rollback", async () => {
    const operateThread = vi.fn(async () => {
      throw new TypeError("response lost first");
    });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft("Restore, then reconcile");
    store.stageComposerTransfer("late-queue-operation", "submit", draft);
    await expect(
      store.deliver("submit", draft, "late-queue-operation"),
    ).rejects.toThrow("response lost first");
    store.acknowledgeComposerTransferRollback("late-queue-operation");

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "late-durable-row",
            deliveryOperationId: "late-queue-operation",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "dispatching",
            deliveryMode: "submit",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "Restore, then reconcile" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
        authorityState: "queue_owned",
        rollbackApplied: true,
        lateMaterializationRequiresComposerReconciliation: true,
      }),
    );
    // The retained ThreadClientStore continues reconciling while no Composer
    // subscriber is mounted and therefore cannot acknowledge the inverse yet.
    const unsubscribeUnmountedComposer = store.subscribe(() => undefined);
    unsubscribeUnmountedComposer();
    transport.thread?.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 9,
        items: [
          {
            id: "late-durable-row",
            deliveryOperationId: "late-queue-operation",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "retry_wait",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "Restore, then reconcile" },
            createdAt: "2026-08-13T22:00:00.000Z",
            nextAttemptAt: "2026-08-13T22:01:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
        authorityState: "queue_owned",
        queuedInputId: "late-durable-row",
        lateMaterializationRequiresComposerReconciliation: true,
      }),
    );

    emitMaterializedSteer(transport, "late-queue-operation", 3);
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
        authorityState: "materialized",
        materializedItemId: "user-3",
        lateMaterializationRequiresComposerReconciliation: true,
      }),
    );
    store.acknowledgeLateComposerTransferReconciliation("late-queue-operation");
    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
  });

  it("retains an ambiguous rollback tombstone for late exact materialization", async () => {
    const operateThread = vi.fn(async () => {
      throw new TypeError("lost response");
    });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const draft = composerDraft("Late exact input");
    store.stageComposerTransfer("late-operation", "submit", draft);

    await expect(
      store.deliver("submit", draft, "late-operation"),
    ).rejects.toThrow("lost response");
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      authorityState: "rolled_back_tombstone",
      rollbackRequired: true,
      retainTombstoneAfterRollback: true,
    });
    store.acknowledgeComposerTransferRollback("late-operation");
    expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
      rollbackRequired: false,
      rollbackApplied: true,
    });

    emitMaterializedSteer(transport, "late-operation");
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers[0]).toMatchObject({
        authorityState: "materialized",
        lateMaterializationRequiresComposerReconciliation: true,
      }),
    );
    store.acknowledgeLateComposerTransferReconciliation("late-operation");
    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
  });

  it("reanchors later same-tail submits when the earlier operation materializes", async () => {
    const operateThread = vi.fn(async () => ({
      status: "delivery_queued" as const,
      resolvedDeliveryMode: "submit" as const,
      queuedInputId: "first-queue-row",
      threadRevision: 8,
      draft: {
        ...composerDraft(""),
        revision: 5,
        updatedAt: "2026-08-13T22:00:00.000Z",
      },
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes());
    const firstDraft = composerDraft("A");
    store.stageComposerTransfer("first-operation", "submit", firstDraft);
    await store.deliver("submit", firstDraft, "first-operation");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [
          {
            id: "first-queue-row",
            deliveryOperationId: "first-operation",
            resolvedDeliveryMode: "submit" as const,
            sequence: 1,
            origin: "user",
            isHead: true,
            state: "pending",
            attachmentCount: 0,
            taskCount: 0,
            preview: { text: "A" },
            createdAt: "2026-08-13T22:00:00.000Z",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingDeliveryThreadRevision).toBeUndefined(),
    );
    store.stageComposerTransfer(
      "second-operation",
      "submit",
      composerDraft("B"),
    );

    emitMaterializedSteer(transport, "first-operation", 2);
    await vi.waitFor(() =>
      expect(
        store
          .getSnapshot()
          .pendingComposerTransfers.find(
            ({ operationId }) => operationId === "second-operation",
          )?.baselineTailItemId,
      ).toBe("user-2"),
    );
  });

  it("settles an unconfirmed Steer against an already-received target-settled snapshot", async () => {
    let rejectRequest!: (error: unknown) => void;
    const operateThread = vi.fn(
      () =>
        new Promise<ThreadApplicationMutationResult>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, snapshotWithDeliveryModes("running"));
    const draft = composerDraft("Steer once");
    store.stageComposerTransfer("settled-steer", "steer", draft);
    const delivery = store.deliver("steer", draft, "settled-steer");
    await vi.waitFor(() => expect(operateThread).toHaveBeenCalledOnce());

    store.prepareForReconnect();
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-2",
      event: {
        type: "snapshot",
        generation: "projection-2",
        snapshot: snapshotWithDeliveryModes("idle"),
      },
    });
    transport.thread?.onConnection("connected");
    rejectRequest(new TypeError("response lost after settlement"));
    await expect(delivery).rejects.toThrow("response lost after settlement");

    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "settled-steer",
        mode: "steer",
        presentation: "pending_steer",
        steerPhase: "unconfirmed",
        authorityState: "rolled_back_tombstone",
        rollbackRequired: true,
        retainTombstoneAfterRollback: false,
      },
    ]);
  });

  it("records snapshot parsing, server summary, and normalized-store apply milestones", async () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "private-thread-id",
      {} as ApiClient,
      transport,
    );
    const attempt = beginThreadLoadAttempt("private-thread-id", "navigation");
    await store.start(attempt);
    const envelope: ThreadEventEnvelope = {
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      },
    };
    transport.thread?.loadDiagnostics?.onEventSourceCreated({
      cursorAvailable: false,
    });
    transport.thread?.loadDiagnostics?.onEnvelopeParsed({
      envelope,
      eventDataCharacters: 4_096,
      durationMilliseconds: 6.5,
    });
    transport.thread?.loadDiagnostics?.onServerDiagnostic({
      format: "sedes-thread-load-server-v1",
      handshake: "current_checkpoint",
      routeSetupMilliseconds: 1,
      runtimeAcquireMilliseconds: 2,
      requestToSnapshotWriteMilliseconds: 3,
      snapshotCaptureMilliseconds: 0,
      snapshotEncodeMilliseconds: 4,
      snapshotSummaryMilliseconds: 0.5,
      snapshotWriteMilliseconds: 5,
      snapshotFrameBytes: 6_000,
      turnCount: 1,
      itemCount: 1,
      largestTurnItemCount: 1,
    });
    transport.thread?.loadDiagnostics?.onHandshakeDiagnostic({
      format: "sedes-thread-handshake-server-v1",
      requestId: "00000000-0000-4000-8000-000000000001",
      routeSetupMilliseconds: 4,
      runtimeAcquireMilliseconds: 6300,
      requestToHeadersMilliseconds: 6400,
    });
    transport.thread?.loadDiagnostics?.onReplayDiagnostic({
      format: "sedes-thread-replay-server-v1",
      cursorSource: "explicit_query",
      outcome: "caught_up",
      replayedEventCount: 0,
    });
    transport.thread?.onEnvelope(envelope);

    expect(readDiagnostics().map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        "thread_open_requested",
        "store_start_requested",
        "event_source_created",
        "snapshot_received",
        "snapshot_json_parsed",
        "server_snapshot_timing_received",
        "server_replay_outcome_received",
        "server_handshake_timing_received",
        "snapshot_store_applied",
      ]),
    );
    expect(
      readDiagnostics().find(
        ({ event }) => event === "server_snapshot_timing_received",
      )?.details,
    ).toMatchObject({
      runtimeAcquireMilliseconds: 2,
      bytes: 6_000,
      largestTurnItemCount: 1,
    });
    expect(
      readDiagnostics().find(
        ({ event }) => event === "server_handshake_timing_received",
      )?.details,
    ).toMatchObject({
      requestId: "00000000-0000-4000-8000-000000000001",
      runtimeAcquireMilliseconds: 6300,
      requestToHeadersMilliseconds: 6400,
    });
    expect(JSON.stringify(readDiagnostics())).not.toContain(
      "private-thread-id",
    );
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-2",
      event: {
        type: "snapshot",
        generation: "projection-2",
        snapshot: {
          ...snapshot(),
          orderedTurnIds: ["missing-turn"],
        },
      },
    });
    expect(
      readDiagnostics().find(({ event }) => event === "snapshot_store_rejected")
        ?.details.status,
    ).toBe("rejected");
    store.dispose();
  });

  it("removes an interaction from a completed response receipt without waiting for SSE", async () => {
    const operateThread = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, interactionSnapshot());

    await expect(
      store.respond("interaction-1", {
        kind: "confirmation",
        confirmed: true,
      }),
    ).resolves.toBeUndefined();

    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
      snapshot: { interactions: [] },
    });
    expect(operateThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        kind: "respond",
        interactionId: "interaction-1",
      }),
    );
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "interaction_resolved",
        generation: "projection-1",
        interactionId: "interaction-1",
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().snapshot?.interactions).toEqual([]),
    );
  });

  it("accepts interaction resolution over SSE before the completed response receipt", async () => {
    let completeResponse!: (result: ThreadApplicationMutationResult) => void;
    const operateThread = vi.fn(
      () =>
        new Promise<ThreadApplicationMutationResult>((resolve) => {
          completeResponse = resolve;
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, interactionSnapshot());

    const response = store.respond("interaction-1", {
      kind: "confirmation",
      confirmed: true,
    });
    await vi.waitFor(() => expect(operateThread).toHaveBeenCalledOnce());
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "interaction_resolved",
        generation: "projection-1",
        interactionId: "interaction-1",
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().snapshot?.interactions).toEqual([]),
    );

    completeResponse({ status: "completed" });
    await expect(response).resolves.toBeUndefined();
    expect(store.getSnapshot().snapshot?.interactions).toEqual([]);
  });

  it("surfaces recovery-required interaction receipts and leaves the request open", async () => {
    const operateThread = vi.fn(async () => ({
      status: "recovery_required" as const,
      retryable: true,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, interactionSnapshot());

    await expect(
      store.respond("interaction-1", {
        kind: "confirmation",
        confirmed: true,
      }),
    ).rejects.toThrow("response outcome is uncertain");
    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
      actionError: expect.stringContaining("response outcome is uncertain"),
      snapshot: {
        interactions: [expect.objectContaining({ id: "interaction-1" })],
      },
    });
  });

  it("closes a non-retryable uncertain interaction without waiting for SSE", async () => {
    const operateThread = vi.fn(async () => ({
      status: "recovery_required" as const,
      retryable: false,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport, interactionSnapshot());

    await expect(
      store.respond("interaction-1", {
        kind: "confirmation",
        confirmed: true,
      }),
    ).rejects.toThrow("cannot be retried safely");
    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
      actionError: expect.stringContaining("cannot be retried safely"),
      snapshot: { interactions: [] },
    });
  });

  it("dismisses a queue failure without setting global action state", async () => {
    const dismissThreadAttention = vi.fn(async () => undefined);
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { dismissThreadAttention } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      store.dismissQueueFailure("queued-1"),
    ).resolves.toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
    });
    expect(store.getSnapshot().actionError).toBeUndefined();
    expect(dismissThreadAttention).toHaveBeenCalledWith(
      "thread-1",
      { kind: "queue_failure", queuedInputId: "queued-1" },
      expect.any(String),
    );
  });

  it("applies an authoritative restored queue projection returned by recovery", async () => {
    const operateThread = vi.fn(async () => ({
      status: "queue_steer_restored" as const,
      queuedInputId: "queued-1",
      operationId: "20000000-0000-4000-8000-000000000001",
      threadRevision: 8,
      queue: [
        {
          id: "queued-1",
          deliveryOperationId: "20000000-0000-4000-8000-000000000001",
          resolvedDeliveryMode: "queue" as const,
          sequence: 1,
          origin: "user" as const,
          isHead: true,
          state: "pending" as const,
          preview: { text: "Steered input" },
          attachmentCount: 0,
          taskCount: 0,
          createdAt: "2026-08-07T07:00:00.000Z",
        },
      ],
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(store.recoverUncertain()).resolves.toBeUndefined();
    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "recover_uncertain",
    });
    expect(store.getSnapshot().snapshot).toMatchObject({
      thread: { threadRevision: 8, queuedInputCount: 1 },
      queue: [{ id: "queued-1", state: "pending" }],
    });
  });

  it("keeps delivery gated when recovery returns a pending queued Steer", async () => {
    const operateThread = vi.fn(async () => ({
      status: "queue_steer_pending_materialization" as const,
      queuedInputId: "queued-1",
      operationId: "20000000-0000-4000-8000-000000000001",
      threadRevision: 8,
      queue: [
        {
          id: "queued-1",
          deliveryOperationId: "20000000-0000-4000-8000-000000000001",
          resolvedDeliveryMode: "queue" as const,
          sequence: 1,
          origin: "user" as const,
          isHead: true,
          state: "dispatching" as const,
          deliveryMode: "steer" as const,
          preview: { text: "Steered input" },
          attachmentCount: 0,
          taskCount: 0,
          createdAt: "2026-08-07T07:00:00.000Z",
        },
      ],
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(store.recoverUncertain()).resolves.toBeUndefined();

    expect(store.getSnapshot()).toMatchObject({
      pendingDeliveryThreadRevision: 8,
      snapshot: {
        thread: { threadRevision: 8, queuedInputCount: 1 },
        queue: [
          {
            id: "queued-1",
            state: "dispatching",
            deliveryMode: "steer",
          },
        ],
      },
    });
  });

  it("applies an authoritative queued-input cancellation receipt", async () => {
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => {
        if (operation.kind !== "cancel_queued_input") {
          throw new Error("unexpected operation");
        }
        return {
          status: "queue_cancelled" as const,
          queuedInputId: operation.queuedInputId,
          mutationId: operation.mutationId,
          threadRevision: 8,
          queue: [
            {
              id: "queued-2",
              deliveryOperationId: "20000000-0000-4000-8000-000000000002",
              resolvedDeliveryMode: "queue" as const,
              sequence: 2,
              origin: "user" as const,
              isHead: true,
              state: "pending" as const,
              preview: { text: "Next input" },
              attachmentCount: 0,
              taskCount: 0,
              createdAt: "2026-08-07T07:00:00.000Z",
            },
          ],
        };
      },
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(store.cancelQueuedInput("queued-1")).resolves.toBeUndefined();
    expect(operateThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        kind: "cancel_queued_input",
        queuedInputId: "queued-1",
        expectedThreadRevision: 7,
      }),
    );
    expect(store.getSnapshot().snapshot).toMatchObject({
      thread: { threadRevision: 8, queuedInputCount: 1 },
      queue: [{ id: "queued-2", isHead: true }],
    });
  });

  it("returns and projects the authoritative structured draft from queue restoration", async () => {
    const restored: NormalizedDraft = {
      text: "Restored input",
      selectedSkillId: "skill-review",
      contextExcerpts: [],
      attachments: [
        {
          id: "d0739b85-4f1b-4c40-b364-51e5093f128b",
          fileName: "diagram.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: 128,
        },
      ],
      taskReferences: [],
      revision: 5,
    };
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => {
        if (operation.kind !== "restore_queued_input") {
          throw new Error("unexpected operation");
        }
        return {
          status: "queue_restored" as const,
          queuedInputId: operation.queuedInputId,
          mutationId: operation.mutationId,
          threadRevision: 8,
          queue: [],
          draft: restored,
        };
      },
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    const empty: NormalizedDraft = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    };
    await expect(store.restoreQueuedInput("queued-1", empty)).resolves.toEqual(
      restored,
    );
    expect(operateThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        kind: "restore_queued_input",
        queuedInputId: "queued-1",
        expectedThreadRevision: 7,
        expectedDraftRevision: 4,
      }),
    );
    expect(store.getSnapshot().snapshot).toMatchObject({
      thread: { threadRevision: 8, queuedInputCount: 0 },
      queue: [],
      draft: restored,
    });
  });

  it("reuses a queued-input mutation ID after response loss", async () => {
    const operations: Extract<
      ThreadApplicationOperation,
      { kind: "cancel_queued_input" }
    >[] = [];
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => {
        if (operation.kind !== "cancel_queued_input") {
          throw new Error("unexpected operation");
        }
        operations.push(operation);
        if (operations.length === 1) throw new TypeError("response lost");
        return {
          status: "queue_cancelled" as const,
          queuedInputId: operation.queuedInputId,
          mutationId: operation.mutationId,
          threadRevision: 8,
          queue: [],
        };
      },
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(store.cancelQueuedInput("queued-1")).rejects.toThrow(
      "response lost",
    );
    await expect(store.cancelQueuedInput("queued-1")).resolves.toBeUndefined();
    expect(operations).toHaveLength(2);
    expect(operations[1]?.mutationId).toBe(operations[0]?.mutationId);
  });

  it("returns the authoritative cleared draft from a delivery receipt", async () => {
    const cleared = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 5,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    const operateThread = vi.fn(async () => ({
      status: "delivery_accepted" as const,
      resolvedDeliveryMode: "steer" as const,
      operationId: "delivery-1",
      threadRevision: 8,
      draft: cleared,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      deliverPreparedSteer(store, {
        text: "Continue",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      }),
    ).resolves.toEqual(cleared);
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-1",
        mode: "steer",
        presentation: "pending_steer",
        steerPhase: "steering",
      },
    ]);
    emitMaterializedSteer(transport, "delivery-1");
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toEqual([]),
    );
  });

  it("does not recreate a pending steer when exact materialization beats its receipt", async () => {
    const cleared = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 5,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    let release!: () => void;
    const operateThread = vi.fn(
      () =>
        new Promise<{
          status: "delivery_accepted";
          resolvedDeliveryMode: "steer";
          operationId: string;
          threadRevision: number;
          draft: typeof cleared;
        }>((resolve) => {
          release = () =>
            resolve({
              status: "delivery_accepted",
              resolvedDeliveryMode: "steer",
              operationId: "delivery-race",
              threadRevision: 8,
              draft: cleared,
            });
        }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);
    const draft = {
      text: "Continue",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    };
    store.stageComposerTransfer("delivery-race", "steer", draft);
    const delivery = store.deliver("steer", draft, "delivery-race");

    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-race",
        mode: "steer",
        steerPhase: "sending",
      },
    ]);
    await vi.waitFor(() => expect(operateThread).toHaveBeenCalledOnce());
    emitMaterializedSteer(transport, "delivery-race");
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
        {
          operationId: "delivery-race",
          mode: "steer",
          requestState: "requesting",
          authorityState: "materialized",
          materializedItemId: "user-1",
        },
      ]),
    );
    release();
    await expect(delivery).resolves.toEqual(cleared);
    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
  });

  it("retains a pending-materialization draft until its revisioned snapshot arrives", async () => {
    const retained = {
      text: "Continue",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => ({
        status: "delivery_pending_materialization" as const,
        resolvedDeliveryMode: "steer" as const,
        operationId:
          operation.kind === "deliver" ? operation.mutationId : "wrong",
        threadRevision: 8,
        draft: retained,
      }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      deliverPreparedSteer(store, {
        text: "Continue",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      }),
    ).resolves.toEqual(retained);
    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
      pendingDeliveryThreadRevision: 8,
    });
    expect(() =>
      store.stageComposerTransfer("queue-blocked", "queue", retained),
    ).toThrow("Wait for the pending delivery to resolve");
    expect(operateThread).toHaveBeenCalledOnce();
    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [],
      },
    });
    expect(store.getSnapshot().pendingDeliveryThreadRevision).toBe(8);
    transport.thread?.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 9,
        items: [],
      },
    });
    await vi.waitFor(() => {
      expect(store.getSnapshot().snapshot?.thread.threadRevision).toBe(9);
    });
    expect(store.getSnapshot().pendingDeliveryThreadRevision).toBe(8);
    const current = store.getSnapshot().snapshot!;
    transport.thread?.onEnvelope({
      eventId: `${hubId}.3`,
      projectionGeneration: "projection-1",
      event: {
        type: "capabilities_changed",
        generation: "projection-1",
        threadRevision: 9,
        capabilities: {
          ...current.capabilities,
          revision: "cap-pending",
          deliveryModes: current.capabilities.deliveryModes.map((mode) => ({
            ...mode,
            available: false,
            unavailableReason: { text: "Waiting for Pi materialization." },
          })),
        },
        providerFeatures: current.providerFeatures,
      },
    });
    await vi.waitFor(() => {
      expect(store.getSnapshot().pendingDeliveryThreadRevision).toBeUndefined();
    });
  });

  it("keeps a Queue-to-Steer notification until exact materialization", async () => {
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => ({
        status: "queue_steer_pending_materialization" as const,
        queuedInputId:
          operation.kind === "steer_queued_input"
            ? operation.queuedInputId
            : "wrong",
        operationId:
          operation.kind === "steer_queued_input"
            ? operation.mutationId
            : "wrong",
        threadRevision: 8,
        queue: [
          {
            id: "queued-1",
            deliveryOperationId:
              operation.kind === "steer_queued_input"
                ? operation.mutationId
                : "wrong",
            sequence: 1,
            origin: "user" as const,
            isHead: true,
            preview: { text: "Follow up" },
            attachmentCount: 0,
            taskCount: 0,
            state: "dispatching" as const,
            deliveryMode: "steer" as const,
            createdAt: "2026-08-07T07:00:00.000Z",
          },
        ],
      }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const active = snapshot();
    active.thread = { ...active.thread, queuedInputCount: 1 };
    active.queue = [
      {
        id: "queued-1",
        deliveryOperationId: "original-queue-operation",
        resolvedDeliveryMode: "queue" as const,
        requestedDeliveryMode: "queue",
        sequence: 1,
        origin: "user",
        isHead: true,
        preview: { text: "Follow up" },
        attachmentCount: 0,
        taskCount: 0,
        state: "pending",
        createdAt: "2026-08-07T07:00:00.000Z",
      },
    ];
    installSnapshot(transport, active);

    await expect(store.steerQueuedInput("queued-1")).resolves.toBeUndefined();
    const pendingOperationId =
      store.getSnapshot().pendingQueuedSteers[0]!.operationId;
    expect(store.getSnapshot()).toMatchObject({
      actionPending: false,
      pendingDeliveryThreadRevision: 8,
      pendingQueuedSteers: [
        {
          queuedInputId: "queued-1",
          phase: "steering",
          requestState: "receipt_received",
        },
      ],
      snapshot: {
        thread: { threadRevision: 8 },
        queue: [
          {
            id: "queued-1",
            state: "dispatching",
            deliveryMode: "steer",
          },
        ],
      },
    });

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 9,
        items: [],
      },
    });
    await vi.waitFor(() => {
      expect(store.getSnapshot().snapshot?.thread.threadRevision).toBe(9);
    });
    expect(store.getSnapshot().pendingDeliveryThreadRevision).toBe(8);
    const current = store.getSnapshot().snapshot!;
    transport.thread?.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "capabilities_changed",
        generation: "projection-1",
        threadRevision: 9,
        capabilities: {
          ...current.capabilities,
          revision: "cap-pending",
          deliveryModes: current.capabilities.deliveryModes.map((mode) => ({
            ...mode,
            available: false,
            unavailableReason: { text: "Waiting for Pi materialization." },
          })),
        },
        providerFeatures: current.providerFeatures,
      },
    });
    await vi.waitFor(() => {
      expect(store.getSnapshot().pendingDeliveryThreadRevision).toBeUndefined();
    });
    emitMaterializedSteer(transport, pendingOperationId, 3);
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingQueuedSteers).toEqual([]),
    );
  });

  it("removes a staged Queue-to-Steer notification when authority is lost before the request starts", async () => {
    const operateThread = vi.fn();
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const active = snapshot();
    active.thread = { ...active.thread, queuedInputCount: 1 };
    active.queue = [
      {
        id: "queued-1",
        deliveryOperationId: "original-queue-operation",
        resolvedDeliveryMode: "queue" as const,
        requestedDeliveryMode: "queue",
        sequence: 1,
        origin: "user",
        isHead: true,
        preview: { text: "Follow up" },
        attachmentCount: 0,
        taskCount: 0,
        state: "pending",
        createdAt: "2026-08-07T07:00:00.000Z",
      },
    ];
    installSnapshot(transport, active);

    const steering = store.steerQueuedInput("queued-1");
    expect(store.getSnapshot().pendingQueuedSteers).toHaveLength(1);
    store.prepareForReconnect();

    await expect(steering).rejects.toThrow("receive an authoritative snapshot");
    expect(operateThread).not.toHaveBeenCalled();
    expect(store.getSnapshot().pendingQueuedSteers).toEqual([]);
  });

  it("retains an unconfirmed Queue-to-Steer notification for an invalid post-request receipt", async () => {
    const operateThread = vi.fn(async () => ({
      status: "queue_steer_accepted" as const,
      queuedInputId: "queued-1",
      operationId: "wrong-operation",
      threadRevision: 8,
      queue: [],
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const active = snapshot();
    active.thread = { ...active.thread, queuedInputCount: 1 };
    active.queue = [
      {
        id: "queued-1",
        deliveryOperationId: "original-queue-operation",
        resolvedDeliveryMode: "queue" as const,
        requestedDeliveryMode: "queue",
        sequence: 1,
        origin: "user",
        isHead: true,
        preview: { text: "Follow up" },
        attachmentCount: 0,
        taskCount: 0,
        state: "pending",
        createdAt: "2026-08-07T07:00:00.000Z",
      },
    ];
    installSnapshot(transport, active);

    await expect(store.steerQueuedInput("queued-1")).rejects.toThrow(
      "invalid receipt",
    );
    expect(store.getSnapshot().pendingQueuedSteers).toMatchObject([
      {
        queuedInputId: "queued-1",
        phase: "unconfirmed",
        requestState: "request_failed",
      },
    ]);

    transport.thread?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "queue_changed",
        generation: "projection-1",
        threadRevision: 8,
        items: [],
      },
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingQueuedSteers).toEqual([]),
    );
  });

  it.each(["cancel", "restore"] as const)(
    "clears a retained Queue-to-Steer notification after successful %s",
    async (action) => {
      const restoredDraft: NormalizedDraft = {
        text: "Follow up",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 5,
      };
      const operateThread = vi.fn(
        async (
          _threadId: string,
          operation: ThreadApplicationOperation,
        ): Promise<ThreadApplicationMutationResult> => {
          if (operation.kind === "steer_queued_input") {
            return {
              status: "queue_steer_accepted",
              queuedInputId: operation.queuedInputId,
              operationId: "wrong-operation",
              threadRevision: 8,
              queue: [],
            };
          }
          if (operation.kind === "cancel_queued_input" && action === "cancel") {
            return {
              status: "queue_cancelled",
              queuedInputId: operation.queuedInputId,
              mutationId: operation.mutationId,
              threadRevision: 8,
              queue: [],
            };
          }
          if (
            operation.kind === "restore_queued_input" &&
            action === "restore"
          ) {
            return {
              status: "queue_restored",
              queuedInputId: operation.queuedInputId,
              mutationId: operation.mutationId,
              threadRevision: 8,
              queue: [],
              draft: restoredDraft,
            };
          }
          throw new Error("unexpected operation");
        },
      );
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { operateThread } as unknown as ApiClient,
        transport,
      );
      await store.start();
      const active = snapshot();
      active.thread = { ...active.thread, queuedInputCount: 1 };
      active.queue = [
        {
          id: "queued-1",
          deliveryOperationId: "original-queue-operation",
          resolvedDeliveryMode: "queue" as const,
          requestedDeliveryMode: "queue",
          sequence: 1,
          origin: "user",
          isHead: true,
          preview: { text: "Follow up" },
          attachmentCount: 0,
          taskCount: 0,
          state: "pending",
          createdAt: "2026-08-07T07:00:00.000Z",
        },
      ];
      installSnapshot(transport, active);

      await expect(store.steerQueuedInput("queued-1")).rejects.toThrow(
        "invalid receipt",
      );
      expect(store.getSnapshot().pendingQueuedSteers).toHaveLength(1);

      if (action === "cancel") {
        await expect(
          store.cancelQueuedInput("queued-1"),
        ).resolves.toBeUndefined();
      } else {
        await expect(
          store.restoreQueuedInput("queued-1", active.draft),
        ).resolves.toEqual(restoredDraft);
      }
      expect(store.getSnapshot().pendingQueuedSteers).toEqual([]);
    },
  );

  it("delivers a selected skill without prompt text", async () => {
    const cleared = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 5,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    const operateThread = vi.fn(async () => ({
      status: "delivery_accepted" as const,
      resolvedDeliveryMode: "steer" as const,
      operationId: "delivery-1",
      threadRevision: 8,
      draft: cleared,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      deliverPreparedSteer(store, {
        text: "",
        selectedSkillId: "skill-review",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      }),
    ).resolves.toEqual(cleared);
    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "deliver",
      mode: "steer",
      mutationId: expect.any(String),
      expectedThreadRevision: 7,
      expectedDraftRevision: 4,
      steerTarget: { kind: "turn", turnId: "turn-1" },
    });
  });

  it("requires every delivery to have a caller-prepared operation ID", async () => {
    const operateThread = vi.fn();
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);
    const draft = {
      text: "  ",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    };

    await expect(store.deliver("steer", draft, "not-prepared")).rejects.toThrow(
      "Delivery was not prepared by the composer",
    );
    expect(operateThread).not.toHaveBeenCalled();
  });

  it("rejects a delivery receipt that does not prove a newer cleared draft", async () => {
    const operateThread = vi.fn(async () => ({
      status: "delivery_accepted" as const,
      resolvedDeliveryMode: "steer" as const,
      operationId: "delivery-1",
      threadRevision: 8,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
        updatedAt: "2026-08-07T07:00:00.000Z",
      },
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      deliverPreparedSteer(store, {
        text: "Continue",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      }),
    ).rejects.toThrow("invalid authoritative draft receipt");
  });

  it("throws typed delivery recovery with the authoritative retained draft", async () => {
    const retained = {
      text: "Continue",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    const operateThread = vi.fn(
      async (): Promise<ThreadApplicationMutationResult> => ({
        status: "recovery_required",
        retryable: false,
        draft: retained,
      }),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    store.stageComposerTransfer("delivery-1", "steer", {
      text: "Continue",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    });
    const recovery = await store
      .deliver(
        "steer",
        {
          text: "Continue",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 4,
        },
        "delivery-1",
      )
      .catch((error: unknown) => error);
    expect(recovery).toBeInstanceOf(DeliveryRecoveryRequiredError);
    expect(recovery).toMatchObject({
      retryable: false,
      draft: retained,
    });
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-1",
        mode: "steer",
        steerPhase: "unconfirmed",
      },
    ]);
    operateThread.mockResolvedValueOnce({
      status: "delivery_accepted" as const,
      resolvedDeliveryMode: "steer",
      operationId: "delivery-1",
      threadRevision: 8,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 5,
        updatedAt: "2026-08-07T07:01:00.000Z",
      },
    });
    await expect(store.recoverUncertain()).resolves.toBeUndefined();
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-1",
        mode: "steer",
        steerPhase: "steering",
      },
    ]);
    operateThread.mockResolvedValueOnce({
      status: "recovery_required",
      retryable: true,
      draft: retained,
    });
    await expect(store.recoverUncertain()).resolves.toBeUndefined();
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-1",
        mode: "steer",
        steerPhase: "unconfirmed",
      },
    ]);
    operateThread.mockResolvedValueOnce({
      status: "delivery_pending_materialization",
      resolvedDeliveryMode: "steer",
      operationId: "delivery-1",
      threadRevision: 8,
      draft: retained,
    });
    await expect(store.recoverUncertain()).resolves.toBeUndefined();
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([
      {
        operationId: "delivery-1",
        mode: "steer",
        steerPhase: "steering",
      },
    ]);

    emitMaterializedSteer(transport, "delivery-1");
    await vi.waitFor(() =>
      expect(store.getSnapshot().pendingComposerTransfers).toEqual([]),
    );
    operateThread.mockResolvedValueOnce({
      status: "delivery_accepted",
      resolvedDeliveryMode: "submit",
      operationId: "delivery-1",
      threadRevision: 8,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 5,
        updatedAt: "2026-08-07T07:02:00.000Z",
      },
    });
    await expect(store.recoverUncertain()).resolves.toBeUndefined();
    expect(store.getSnapshot().pendingComposerTransfers).toEqual([]);
  });

  it("rejects delivery recovery without a current draft receipt", async () => {
    const operateThread = vi.fn(async () => ({
      status: "recovery_required" as const,
      retryable: true,
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      deliverPreparedSteer(store, {
        text: "Continue",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      }),
    ).rejects.toThrow("invalid authoritative recovery draft receipt");
  });

  it("submits an idle agent-tool policy with its exact projected revision", async () => {
    const operateThread = vi.fn().mockResolvedValue({ status: "accepted" });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const ready = snapshot();
    ready.runState = "idle";
    ready.thread = { ...ready.thread, runState: "idle" };
    ready.capabilities = { ...ready.capabilities, runState: "idle" };
    delete ready.activeTurnId;
    ready.agentTools = {
      enabled: true,
      accessBoundary: "environment",
      groups: [
        {
          id: "context",
          label: { text: "Context" },
          description: { text: "Inspect source context." },
          order: 10,
          tools: [
            {
              id: "agent.context",
              label: { text: "Agent context" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: true,
              available: true,
            },
          ],
        },
        {
          id: "threads",
          label: { text: "Threads" },
          description: { text: "Inspect threads." },
          order: 20,
          tools: [
            {
              id: "thread.status",
              label: { text: "Thread status" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: false,
              available: true,
            },
          ],
        },
      ],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 6,
    };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: { type: "snapshot", generation: "projection-1", snapshot: ready },
    });

    await store.setAgentToolPolicy({
      expectedPolicyRevision: 6,
      enabled: true,
      enabledToolIds: ["agent.context", "thread.status"],
      presentation: { surface: "native", mode: "individual" },
      accessBoundary: "environment",
    });

    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "set_agent_tool_policy",
      mutationId: expect.any(String),
      expectedPolicyRevision: 6,
      enabled: true,
      enabledToolIds: ["agent.context", "thread.status"],
      presentation: { surface: "native", mode: "individual" },
      accessBoundary: "environment",
    });
  });

  it.each(["progressive", "individual"] as const)(
    "submits running CLI %s enablement and disablement without changing presentation",
    async (mode) => {
      const operateThread = vi.fn().mockResolvedValue({ status: "accepted" });
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { operateThread } as unknown as ApiClient,
        transport,
      );
      await store.start();
      const ready = snapshot();
      ready.agentTools = {
        ...ready.agentTools,
        presentation: { surface: "cli", mode },
      };
      transport.thread?.onConnection("connected");
      transport.thread?.onEnvelope({
        eventId: `${hubId}.0`,
        projectionGeneration: "projection-1",
        event: {
          type: "snapshot",
          generation: "projection-1",
          snapshot: ready,
        },
      });
      for (const enabled of [true, false]) {
        const input = {
          expectedPolicyRevision: 0,
          enabled,
          enabledToolIds: [],
          presentation: { surface: "cli" as const, mode },
          accessBoundary: "unrestricted" as const,
        };
        await store.setAgentToolPolicy(input);
        expect(operateThread).toHaveBeenLastCalledWith("thread-1", {
          kind: "set_agent_tool_policy",
          mutationId: expect.any(String),
          ...input,
        });
      }
    },
  );

  it.each([
    ["native", "native", "progressive"],
    ["native", "cli", "progressive"],
    ["cli", "native", "progressive"],
    ["cli", "cli", "individual"],
  ] as const)(
    "rejects running policy change from %s to %s %s",
    async (surface, nextSurface, mode) => {
      const operateThread = vi.fn();
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { operateThread } as unknown as ApiClient,
        transport,
      );
      await store.start();
      const ready = snapshot();
      ready.agentTools = {
        ...ready.agentTools,
        presentation: { surface, mode: "progressive" },
        presentationOptions: [
          { surface: "native", modes: ["progressive", "individual"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      };
      transport.thread?.onConnection("connected");
      transport.thread?.onEnvelope({
        eventId: `${hubId}.0`,
        projectionGeneration: "projection-1",
        event: {
          type: "snapshot",
          generation: "projection-1",
          snapshot: ready,
        },
      });
      await expect(
        store.setAgentToolPolicy({
          expectedPolicyRevision: 0,
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: nextSurface, mode },
          accessBoundary: "environment",
        }),
      ).rejects.toThrow("require an idle thread");
      expect(operateThread).not.toHaveBeenCalled();
    },
  );

  it("rejects agent-tool policy edits against a stale local revision", async () => {
    const operateThread = vi.fn();
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { operateThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const ready = snapshot();
    ready.agentTools = { ...ready.agentTools, revision: 3 };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: { type: "snapshot", generation: "projection-1", snapshot: ready },
    });

    await expect(
      store.setAgentToolPolicy({
        expectedPolicyRevision: 2,
        enabled: false,
        enabledToolIds: [],
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
      }),
    ).rejects.toThrow("changed in another client");
    expect(operateThread).not.toHaveBeenCalled();
  });
  it("coalesces concurrent normalized source-turn seeks", async () => {
    let release!: (value: {
      status: "not_found";
      targetTurnId: string;
    }) => void;
    const seekHistoryTurn = vi.fn(
      () =>
        new Promise<{ status: "not_found"; targetTurnId: string }>(
          (resolve) => {
            release = resolve;
          },
        ),
    );
    const store = new ThreadClientStore(
      "thread-1",
      { seekHistoryTurn } as unknown as ApiClient,
      new FakeTransport(),
    );

    const first = store.seekHistoryTurn("turn-old");
    const joined = store.seekHistoryTurn("turn-old");
    expect(joined).toBe(first);
    expect(seekHistoryTurn).toHaveBeenCalledOnce();
    release({ status: "not_found", targetTurnId: "turn-old" });
    await expect(first).resolves.toMatchObject({ status: "not_found" });
  });

  it("coalesces fork activation and replays the exact request after a transport error", async () => {
    let release!: (value: { status: "created"; childThreadId: string }) => void;
    const forkThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementationOnce(
        () =>
          new Promise<{ status: "created"; childThreadId: string }>(
            (resolve) => {
              release = resolve;
            },
          ),
      )
      .mockResolvedValueOnce({
        status: "recovery_required",
        childThreadId: "child-unknown",
        retryable: false,
        diagnostic: "Provider creation outcome is unknown.",
      });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { forkThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const ready = snapshot();
    ready.turnsById["turn-1"] = {
      ...ready.turnsById["turn-1"]!,
      status: "completed",
      completedAt: "2026-07-30T15:02:00.000Z",
    };
    ready.runState = "idle";
    ready.thread = { ...ready.thread, runState: "idle" };
    ready.capabilities = { ...ready.capabilities, runState: "idle" };
    delete ready.activeTurnId;
    ready.forkSource = {
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    };
    ready.forksByTurnId["turn-1"] = {
      sourceTurnId: "turn-1",
      expectedTurnRevision: 0,
      available: true,
    };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: ready,
      },
    });

    const capability = ready.forksByTurnId["turn-1"]!;
    await expect(store.forkTurn(capability)).rejects.toThrow("connection lost");
    const firstRequest = forkThread.mock.calls[0]![1];
    expect(store.getSnapshot().forkAttempts["turn-1"]).toEqual({
      phase: "request_failed",
      retryable: true,
      diagnostic: "connection lost",
    });

    const retry = store.forkTurn(capability);
    const duplicate = store.forkTurn(capability);
    expect(retry).toBe(duplicate);
    expect(forkThread.mock.calls[1]![1]).toEqual(firstRequest);
    expect(store.getSnapshot().forkAttempts["turn-1"]).toEqual({
      phase: "pending",
    });
    release({ status: "created", childThreadId: "child-1" });
    await expect(retry).resolves.toEqual({
      status: "created",
      childThreadId: "child-1",
    });
    expect(store.getSnapshot().forkAttempts["turn-1"]).toBeUndefined();

    await expect(store.forkTurn(capability)).resolves.toMatchObject({
      status: "recovery_required",
      retryable: false,
    });
    await expect(store.forkTurn(capability)).rejects.toThrow(
      "unresolved provider work",
    );
    store.clearForkAttempt("turn-1");
    expect(store.getSnapshot().forkAttempts["turn-1"]).toMatchObject({
      phase: "recovery_required",
      childThreadId: "child-unknown",
    });
    expect(forkThread).toHaveBeenCalledTimes(3);
  });

  it("locks a deterministic nonretryable fork refusal until it is dismissed", async () => {
    const forkThread = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "Fork prerequisites changed.", false),
      )
      .mockResolvedValueOnce({
        status: "created",
        childThreadId: "child-after-dismiss",
      });
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { forkThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const ready = snapshot();
    ready.turnsById["turn-1"] = {
      ...ready.turnsById["turn-1"]!,
      status: "completed",
      completedAt: "2026-07-30T15:02:00.000Z",
    };
    ready.runState = "idle";
    ready.thread = { ...ready.thread, runState: "idle" };
    ready.capabilities = { ...ready.capabilities, runState: "idle" };
    delete ready.activeTurnId;
    ready.forkSource = {
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    };
    const capability = {
      sourceTurnId: "turn-1",
      expectedTurnRevision: 0,
      available: true,
    } as const;
    ready.forksByTurnId["turn-1"] = capability;
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: ready,
      },
    });

    await expect(store.forkTurn(capability)).rejects.toThrow(
      "Fork prerequisites changed.",
    );
    const rejectedRequest = forkThread.mock.calls[0]![1];
    expect(store.getSnapshot().forkAttempts["turn-1"]).toEqual({
      phase: "request_failed",
      retryable: false,
      diagnostic: "Fork prerequisites changed.",
    });
    await expect(store.forkTurn(capability)).rejects.toThrow(
      "Fork prerequisites changed.",
    );
    expect(forkThread).toHaveBeenCalledOnce();

    store.clearForkAttempt("turn-1");
    await expect(store.forkTurn(capability)).resolves.toEqual({
      status: "created",
      childThreadId: "child-after-dismiss",
    });
    expect(forkThread.mock.calls[1]![1].mutationId).not.toBe(
      rejectedRequest.mutationId,
    );
  });

  it("uses a presented seek-page capability that is outside the live snapshot", async () => {
    const forkThread = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-deep",
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { forkThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    installSnapshot(transport);

    await expect(
      store.forkTurn({
        sourceTurnId: "turn-outside-live-window",
        expectedTurnRevision: 17,
        available: true,
      }),
    ).resolves.toEqual({
      status: "created",
      childThreadId: "child-deep",
    });
    expect(forkThread).toHaveBeenCalledWith("thread-1", {
      boundary: "selected_completed_turn",
      sourceTurnId: "turn-outside-live-window",
      expectedTurnRevision: 17,
      mutationId: expect.any(String),
    });
  });

  it("forks the latest provider snapshot with its distinct request and attempt key", async () => {
    const forkThread = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-snapshot",
    }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { forkThread } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const ready = snapshot();
    ready.forkSource = {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "No completed turn is available." },
      },
      latestProviderSnapshot: { available: true },
    };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: ready,
      },
    });

    await expect(store.forkLatestProviderSnapshot()).resolves.toEqual({
      status: "created",
      childThreadId: "child-snapshot",
    });
    expect(forkThread).toHaveBeenCalledWith("thread-1", {
      boundary: "latest_provider_snapshot",
      mutationId: expect.any(String),
    });
    expect(
      store.getSnapshot().forkAttempts["$latest_provider_snapshot"],
    ).toBeUndefined();
  });

  it("surfaces a terminal cold-load failure and retries only on request", async () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start(beginThreadLoadAttempt("thread-1", "navigation"));
    const failed = transport.thread!;

    failed.onLoadError?.({
      format: "sedes-thread-load-error-v1",
      requestId: "request-missing-workspace",
      error: {
        code: "workspace_missing",
        message: "The workspace directory was moved or removed.",
        retryable: false,
      },
    });

    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      connection: "disconnected",
      authoritative: false,
      error: "The workspace directory was moved or removed.",
      loadFailure: {
        requestId: "request-missing-workspace",
        error: { code: "workspace_missing", retryable: false },
      },
    });
    expect(store.getSnapshot().snapshot).toBeUndefined();
    expect(readDiagnostics().at(-1)).toMatchObject({
      event: "thread_load_failed",
      details: {
        code: "workspace_missing",
        requestId: "request-missing-workspace",
        retryable: false,
      },
    });
    expect(transport.threads).toHaveLength(1);

    store.retryLoad();
    expect(failed.getReplayCursor?.()).toBeUndefined();
    expect(transport.threads).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({
      status: "loading",
      connection: "reconnecting",
      authoritative: false,
    });
    expect(store.getSnapshot().loadFailure).toBeUndefined();
    store.dispose();
  });

  it("retains cached history read-only when a refresh load fails", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport);
    const retained = store.getSnapshot().snapshot;
    const failedSubscription = transport.thread!;
    expect(failedSubscription.getReplayCursor?.()).toBe(`${hubId}.0`);

    failedSubscription.onLoadError?.({
      format: "sedes-thread-load-error-v1",
      requestId: "request-too-large",
      error: {
        code: "backend_unavailable",
        message: "This thread is too large to display safely.",
        retryable: false,
      },
    });

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      connection: "disconnected",
      authoritative: false,
      loadFailure: { requestId: "request-too-large" },
    });
    expect(store.getSnapshot().snapshot).toBe(retained);
    expect(failedSubscription.getReplayCursor?.()).toBe(`${hubId}.0`);
    await expect(store.stopActiveTurn()).rejects.toThrow(
      "Wait for the thread to reconnect and receive an authoritative snapshot.",
    );
    store.retryLoad();
    expect(transport.threads).toHaveLength(2);
    expect(transport.thread?.getReplayCursor?.()).toBe(`${hubId}.0`);
    store.dispose();
  });

  it("bounds load retries and restores the budget on paused re-entry", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as ApiClient,
        transport,
      );
      await store.start();

      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-timeout",
        error: {
          code: "backend_unavailable",
          message: "The backend timed out while loading this thread.",
          retryable: true,
        },
      });

      expect(store.getSnapshot()).toMatchObject({
        status: "error",
        connection: "reconnecting",
        loadFailure: {
          requestId: "request-timeout",
          error: { retryable: true },
        },
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(transport.threads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.threads).toHaveLength(2);

      // Time spent in a slow failed acquisition is not healthy evidence and
      // must not reset the exponential backoff.
      await vi.advanceTimersByTimeAsync(15_000);
      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-timeout-2",
        error: {
          code: "backend_unavailable",
          message: "The backend timed out while loading this thread.",
          retryable: true,
        },
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(transport.threads).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.threads).toHaveLength(3);

      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-timeout-3",
        error: {
          code: "backend_unavailable",
          message: "The backend timed out while loading this thread.",
          retryable: true,
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(transport.threads).toHaveLength(4);

      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-timeout-4",
        error: {
          code: "backend_unavailable",
          message: "The backend timed out while loading this thread.",
          retryable: true,
        },
      });
      expect(store.getSnapshot().connection).toBe("disconnected");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(transport.threads).toHaveLength(4);

      store.pause("inactive");
      await store.start();

      expect(transport.threads).toHaveLength(5);
      expect(store.getSnapshot()).toMatchObject({
        status: "loading",
        connection: "reconnecting",
        authoritative: false,
      });
      expect(store.getSnapshot().error).toBeUndefined();
      expect(store.getSnapshot().loadFailure).toBeUndefined();

      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-timeout-after-re-entry",
        error: {
          code: "backend_unavailable",
          message: "The backend timed out while loading this thread.",
          retryable: true,
        },
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(transport.threads).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.threads).toHaveLength(6);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores authority when a scheduled load retry reaches live", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as ApiClient,
        transport,
      );
      await store.start();
      transport.thread?.onLoadError?.({
        format: "sedes-thread-load-error-v1",
        requestId: "request-transient",
        error: {
          code: "backend_overloaded",
          message: "The backend is temporarily overloaded.",
          retryable: true,
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      installSnapshot(transport);
      transport.thread?.onLive?.();
      transport.thread?.onConnection("connected");

      expect(store.getSnapshot()).toMatchObject({
        status: "ready",
        connection: "connected",
        authoritative: true,
      });
      expect(store.getSnapshot().loadFailure).toBeUndefined();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes authority during reconnect and restores it when replay is caught up", async () => {
    const api = {} as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    installSnapshot(transport);

    expect(store.getSnapshot().authoritative).toBe(true);
    transport.thread?.onConnection("reconnecting");

    expect(store.getSnapshot()).toMatchObject({
      connection: "reconnecting",
      authoritative: false,
    });
    transport.thread?.onConnection("connected");
    expect(store.getSnapshot().authoritative).toBe(true);
  });

  it("consumes a real checkpoint handshake, preserves retained history and notices, and refreshes questions", async () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    FakeBrowserEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeBrowserEventSource);
    const transport = new BrowserEventStreamTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    const refreshQuestions = vi
      .spyOn(store, "loadQuestionRequests")
      .mockResolvedValue();
    try {
      await store.start(beginThreadLoadAttempt("thread-1", "navigation"));
      const source = FakeBrowserEventSource.instances[0]!;
      const current = snapshot();
      current.history = { hasOlder: true, olderCursor: "history-retained" };
      const notices: ThreadCheckpoint["notices"] = [{
        id: "retained-notice",
        tone: "info",
        message: { text: "Still working" },
        createdAt: "2026-07-30T15:00:00.000Z",
      }];
      const beforeRefresh = refreshQuestions.mock.calls.length;
      source.emit("thread-checkpoint", {
        eventId: `${hubId}.1000`,
        projectionGeneration: "projection-1",
        snapshot: current,
        notices,
        capabilityThreadRevision: current.thread.threadRevision,
        capabilityRunState: "running",
      });
      expect(store.getSnapshot()).toMatchObject({
        status: "ready", authoritative: false, snapshot: current,
      });
      expect(store.normalized.state.notices).toEqual(notices);
      expect(refreshQuestions).toHaveBeenCalledTimes(beforeRefresh + 1);
      source.emit("thread", {
        eventId: `${hubId}.1001`,
        projectionGeneration: "projection-1",
        event: { type: "run_state", generation: "projection-1", state: "idle" },
      });
      expect(store.getSnapshot().authoritative).toBe(false);
      source.emit("thread-live", {});
      expect(store.getSnapshot()).toMatchObject({
        authoritative: false,
        connection: "connected",
        snapshot: { runState: "idle", history: current.history },
      });
      expect(store.normalized.replayCursor).toBe(`${hubId}.1001`);
      source.emit("thread", {
        eventId: `${hubId}.1002`,
        projectionGeneration: "projection-1",
        event: {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 7,
          capabilities: { ...current.capabilities, runState: "idle" },
          providerFeatures: current.providerFeatures,
        },
      });
      source.emit("thread-live", {});
      expect(store.getSnapshot().authoritative).toBe(true);
      source.emit("thread-checkpoint", {
        eventId: `${hubId}.999`,
        projectionGeneration: "projection-1",
        snapshot: snapshot(),
        notices: [],
        capabilityThreadRevision: 7,
        capabilityRunState: "running",
      });
      expect(store.getSnapshot().snapshot?.history).toEqual(current.history);
      expect(store.normalized.state.notices).toEqual(notices);
      expect(refreshQuestions).toHaveBeenCalledTimes(beforeRefresh + 1);
      expect(readDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "snapshot_store_ignored", details: expect.objectContaining({ status: "ignored" }) }),
      ]));
      expect(readDiagnostics().some(entry => entry.event === "snapshot_store_rejected")).toBe(false);
    } finally {
      store.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("rejects a live transition when a checkpoint's newer suffix has a sequence gap", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    const subscription = transport.thread!;
    subscription.onCheckpoint?.({
      eventId: `${hubId}.100`,
      projectionGeneration: "projection-1",
      snapshot: snapshot(),
      notices: [],
      capabilityThreadRevision: 7,
      capabilityRunState: "running",
    });
    subscription.onEnvelope({
      eventId: `${hubId}.102`,
      projectionGeneration: "projection-1",
      event: { type: "usage_changed", generation: "projection-1", usage: {} },
    });
    expect(subscription.onLive?.()).toBe(false);
    expect(store.getSnapshot().authoritative).toBe(false);
    store.dispose();
  });

  it("reconciles checkpoint materialization with an existing optimistic delivery without recreating it", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    installSnapshot(transport);
    store.stageComposerTransfer("checkpoint-delivery", "submit", snapshot().draft);
    transport.thread?.onConnection("reconnecting");
    const current = snapshot();
    current.itemsById["materialized"] = {
      id: "materialized",
      turnId: "turn-1",
      kind: "user_message",
      revision: 0,
      status: "completed",
      deliveryOperationId: "checkpoint-delivery",
      content: [{ kind: "text", text: { text: "Continue" } }],
    };
    current.turnsById["turn-1"] = {
      ...current.turnsById["turn-1"]!, orderedItemIds: ["materialized"],
    };
    transport.thread?.onCheckpoint?.({
      eventId: `${hubId}.100`,
      projectionGeneration: "projection-1",
      snapshot: current,
      notices: [],
      capabilityThreadRevision: 7,
      capabilityRunState: "running",
    });
    expect(store.getSnapshot().pendingComposerTransfers).toMatchObject([{
      operationId: "checkpoint-delivery",
      authorityState: "materialized",
      materializedItemId: "materialized",
    }]);
    expect(store.getSnapshot().authoritative).toBe(false);
    transport.thread?.onLive?.();
    transport.thread?.onConnection("connected");
    expect(store.getSnapshot().authoritative).toBe(true);
    expect(Object.keys(store.getSnapshot().snapshot!.itemsById)).toEqual(["materialized"]);
    store.dispose();
  });

  it("applies a contiguous replay suffix while withholding authority until caught up", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    const subscription = transport.thread!;
    installSnapshot(transport);

    subscription.onConnection("reconnecting");
    subscription.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "usage_changed",
        generation: "projection-1",
        usage: {},
      },
    });

    expect(store.getSnapshot()).toMatchObject({
      connection: "reconnecting",
      authoritative: false,
    });
    expect(transport.threads).toHaveLength(1);

    subscription.onLive?.();
    subscription.onConnection("connected");
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      authoritative: true,
    });
    expect(transport.threads).toHaveLength(1);
    store.dispose();
  });

  it("rejects the live transition when a buffered replay suffix is invalid", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    const subscription = transport.thread!;
    installSnapshot(transport);

    subscription.onConnection("reconnecting");
    subscription.onEnvelope({
      eventId: `${hubId}.2`,
      projectionGeneration: "projection-1",
      event: {
        type: "usage_changed",
        generation: "projection-1",
        usage: {},
      },
    });

    expect(subscription.onLive?.()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      connection: "reconnecting",
      authoritative: false,
      error: "Thread stream needs a new snapshot: transport_sequence_gap",
    });
    store.dispose();
  });

  it("recovers authority after a real transport receives a zero-loss replay handshake", async () => {
    FakeBrowserEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeBrowserEventSource);
    const transport = new BrowserEventStreamTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    const source = FakeBrowserEventSource.instances[0]!;
    source.emit("thread", {
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      },
    });
    source.emit("thread-live", {});
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      authoritative: true,
    });

    source.onerror?.();
    expect(store.getSnapshot()).toMatchObject({
      connection: "reconnecting",
      authoritative: false,
    });

    // The browser reconnects this EventSource with Last-Event-ID. With no
    // lost events, the server has no normalized envelope to replay.
    source.emit("thread-live", {});
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      authoritative: true,
    });
    store.dispose();
  });

  it("requires a replacement snapshot after a transport protocol error", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();
    const subscription = transport.thread;
    installSnapshot(transport);

    subscription?.onProtocolError?.(new Error("Malformed event envelope."));
    expect(subscription?.getReplayCursor?.()).toBeUndefined();
    subscription?.onConnection("reconnecting");
    expect(store.getSnapshot()).toMatchObject({
      connection: "reconnecting",
      authoritative: false,
      error: "Malformed event envelope.",
    });
    expect(transport.thread).toBe(subscription);

    subscription?.onConnection("connected");
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      authoritative: false,
    });

    subscription?.onEnvelope({
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      },
    });
    expect(store.getSnapshot().authoritative).toBe(true);
    expect(transport.thread).toBe(subscription);
  });

  it("shows a cold protocol failure instead of retaining the loading state", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {} as ApiClient, transport);
    await store.start();

    transport.thread?.onTerminalProtocolError?.(
      new Error("Invalid normalized thread load error."),
    );

    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      connection: "disconnected",
      authoritative: false,
      error: "Invalid normalized thread load error.",
      terminalLoadError: "Invalid normalized thread load error.",
    });
    store.dispose();
  });

  it("ignores callbacks from a superseded store-owned subscription", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      const superseded = transport.thread!;

      superseded.onEnvelope({
        eventId: `${hubId}.2`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        },
      });
      // Envelopes apply at the next frame flush; the invalidation's
      // resubscribe backoff starts from that flush.
      await vi.advanceTimersByTimeAsync(160);
      expect(transport.threads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);

      expect(transport.threads).toHaveLength(2);
      expect(store.getSnapshot()).toMatchObject({
        connection: "reconnecting",
        authoritative: false,
      });
      superseded.onConnection("connected");
      superseded.onEnvelope({
        eventId: `${hubId}.3`,
        projectionGeneration: "projection-stale",
        event: {
          type: "snapshot",
          generation: "projection-stale",
          snapshot: snapshot(),
        },
      });
      expect(store.getSnapshot()).toMatchObject({
        connection: "reconnecting",
        authoritative: false,
      });

      const current = transport.thread!;
      current.onEnvelope({
        eventId: `${hubId}.3`,
        projectionGeneration: "projection-2",
        event: {
          type: "snapshot",
          generation: "projection-2",
          snapshot: snapshot(),
        },
      });
      current.onConnection("connected");
      expect(store.getSnapshot()).toMatchObject({
        connection: "connected",
        authoritative: true,
      });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the HTTP history envelope once and ignores its SSE retry", async () => {
    const historyEnvelope: ThreadEventEnvelope = {
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: ["turn-older"],
          forkSource: {
            selectedCompletedTurn: {
              available: false,
              unavailableReason: {
                text: "Forking is unavailable in this fixture.",
              },
            },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: {
                text: "Forking is unavailable in this fixture.",
              },
            },
          },
          forksByTurnId: {
            "turn-older": {
              sourceTurnId: "turn-older",
              expectedTurnRevision: 0,
              available: false,
              unavailableReason: {
                text: "Forking is unavailable in this fixture.",
              },
            },
          },
          turnsById: {
            "turn-older": {
              id: "turn-older",
              revision: 0,
              status: "completed",
              orderedItemIds: [],
            },
          },
          itemsById: {},
        },
      },
    };
    const loadOlderHistory = vi.fn(async () => historyEnvelope);
    const api = { loadOlderHistory } as unknown as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    const initial = snapshot();
    initial.history = {
      hasOlder: true,
      olderCursor: "history_application_cursor",
    };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      },
    });

    await store.loadOlderHistory();
    transport.thread?.onEnvelope(historyEnvelope);

    expect(loadOlderHistory).toHaveBeenCalledWith(
      "thread-1",
      "history_application_cursor",
      10,
      "full",
    );
    expect(store.getSnapshot().snapshot?.orderedTurnIds).toEqual([
      "turn-older",
      "turn-1",
    ]);
    expect(store.getSnapshot().snapshot?.history).toEqual({
      hasOlder: false,
    });
    expect(store.getSnapshot().authoritative).toBe(true);
  });

  it("joins concurrent older-history loads instead of skipping a caller", async () => {
    let release!: (value: ThreadEventEnvelope) => void;
    const historyEnvelope: ThreadEventEnvelope = {
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: [],
          forkSource: {
            selectedCompletedTurn: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
          },
          forksByTurnId: {},
          turnsById: {},
          itemsById: {},
        },
      },
    };
    const loadOlderHistory = vi.fn(
      () => new Promise<ThreadEventEnvelope>((resolve) => (release = resolve)),
    );
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { loadOlderHistory } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const initial = snapshot();
    initial.history = { hasOlder: true, olderCursor: "cursor-1" };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      },
    });

    const first = store.loadOlderHistory();
    const second = store.loadOlderHistory();
    expect(first).toBe(second);
    expect(loadOlderHistory).toHaveBeenCalledOnce();
    release(historyEnvelope);
    await Promise.all([first, second]);
  });

  it("loads every bounded history page sequentially with the browser preference", async () => {
    localStorage.setItem("sedes-history-page-size", "25");
    const historyEnvelope = (
      sequence: number,
      turnId: string,
      previousCursor?: string,
    ): ThreadEventEnvelope => ({
      eventId: `${hubId}.${sequence}`,
      projectionGeneration: "projection-1",
      event: {
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: [turnId],
          forkSource: {
            selectedCompletedTurn: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
          },
          forksByTurnId: {
            [turnId]: {
              sourceTurnId: turnId,
              expectedTurnRevision: 0,
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
          },
          turnsById: {
            [turnId]: {
              id: turnId,
              revision: 0,
              status: "completed",
              orderedItemIds: [],
            },
          },
          itemsById: {},
          ...(previousCursor ? { previousCursor } : {}),
        },
      },
    });
    const loadOlderHistory = vi
      .fn()
      .mockResolvedValueOnce(historyEnvelope(1, "turn-older-2", "cursor-2"))
      .mockResolvedValueOnce(historyEnvelope(2, "turn-older-1"));
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { loadOlderHistory } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const initial = snapshot();
    initial.history = { hasOlder: true, olderCursor: "cursor-1" };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      },
    });

    await store.loadAllOlderHistory();

    expect(loadOlderHistory.mock.calls).toEqual([
      ["thread-1", "cursor-1", 25, "full"],
      ["thread-1", "cursor-2", 25, "full"],
    ]);
    expect(store.getSnapshot().snapshot?.orderedTurnIds).toEqual([
      "turn-older-1",
      "turn-older-2",
      "turn-1",
    ]);
    expect(store.getSnapshot().snapshot?.history).toEqual({ hasOlder: false });
  });

  it("stops load-all after disposal without requesting or applying another page", async () => {
    const firstPage: ThreadEventEnvelope = {
      eventId: `${hubId}.1`,
      projectionGeneration: "projection-1",
      event: {
        type: "history_prepend",
        generation: "projection-1",
        page: {
          orderedTurnIds: ["turn-older"],
          forkSource: {
            selectedCompletedTurn: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
          },
          forksByTurnId: {
            "turn-older": {
              sourceTurnId: "turn-older",
              expectedTurnRevision: 0,
              available: false,
              unavailableReason: { text: "Unavailable." },
            },
          },
          turnsById: {
            "turn-older": {
              id: "turn-older",
              revision: 0,
              status: "completed",
              orderedItemIds: [],
            },
          },
          itemsById: {},
          previousCursor: "cursor-2",
        },
      },
    };
    const loadOlderHistory = vi.fn(async () => firstPage);
    const transport = new FakeTransport();
    const store = new ThreadClientStore(
      "thread-1",
      { loadOlderHistory } as unknown as ApiClient,
      transport,
    );
    await store.start();
    const initial = snapshot();
    initial.history = { hasOlder: true, olderCursor: "cursor-1" };
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      },
    });
    let stateAtDispose:
      ReturnType<ThreadClientStore["getSnapshot"]> | undefined;
    store.subscribe(() => {
      const current = store.getSnapshot();
      if (
        current.snapshot?.history.hasOlder &&
        current.snapshot.history.olderCursor === "cursor-2"
      ) {
        stateAtDispose = current;
        store.dispose();
      }
    });

    await store.loadAllOlderHistory();

    expect(loadOlderHistory).toHaveBeenCalledOnce();
    expect(stateAtDispose).toBeDefined();
    expect(store.getSnapshot()).toBe(stateAtDispose);
    expect(store.getSnapshot().snapshot?.orderedTurnIds).toEqual([
      "turn-older",
      "turn-1",
    ]);
  });

  it("sends opaque setting values without parsing backend model identifiers", async () => {
    const operations: ThreadApplicationOperation[] = [];
    const api = {
      operateThread: vi.fn(
        async (_threadId: string, operation: ThreadApplicationOperation) => {
          operations.push(operation);
          return { status: "completed" as const };
        },
      ),
    } as unknown as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    installSnapshot(transport);

    await store.perform({
      action: "set_setting",
      settingId: "model",
      value: "model-option-2",
    });

    expect(operations).toEqual([
      {
        kind: "perform",
        mutationId: expect.any(String),
        expectedThreadRevision: 7,
        expectedSettingsRevision: 3,
        operation: {
          action: "set_setting",
          settingId: "model",
          value: "model-option-2",
        },
      },
    ]);
  });

  it("flushes the registered composer draft before moving an unbound draft through the normalized operation", async () => {
    const calls: string[] = [];
    const saveDraft = vi.fn(
      async (
        _threadId: string,
        _draft: {
          text: string;
          contextExcerpts: [];
          attachments: [];
          taskReferences: [];
          revision: number;
        },
      ) => {
        calls.push("draft");
        return {
          text: "Preserve this idea",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 5,
          updatedAt: "2026-07-30T15:01:00.000Z",
        };
      },
    );
    const operateThread = vi.fn(
      async (_threadId: string, operation: ThreadApplicationOperation) => {
        calls.push("move");
        return { status: "completed" as const, operation };
      },
    );
    const api = { saveDraft, operateThread } as unknown as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    const draftSnapshot = snapshot();
    draftSnapshot.thread = {
      ...draftSnapshot.thread,
      backingState: "unbound",
      runState: "idle",
    };
    draftSnapshot.runState = "idle";
    draftSnapshot.capabilities.runState = "idle";
    delete draftSnapshot.activeTurnId;
    draftSnapshot.orderedTurnIds = [];
    draftSnapshot.turnsById = {};
    draftSnapshot.forksByTurnId = {};
    draftSnapshot.draft = {
      text: "Original",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    };
    draftSnapshot.capabilities.operations.push({
      id: "move_draft",
      label: { text: "Move draft" },
      destructive: false,
      available: true,
      parameters: { kind: "workspace" },
    });
    transport.thread?.onConnection("connected");
    transport.thread?.onEnvelope({
      eventId: `${hubId}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: draftSnapshot,
      },
    });
    // The composer owns draft text locally; it registers this flush so a
    // workspace move cannot strand unsaved text.
    const unregister = store.registerDraftFlush(async () => {
      const saved = await saveDraft("thread-1", {
        text: "Preserve this idea",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 4,
      });
      return saved;
    });

    await store.moveDraft("workspace-2");
    unregister();

    expect(calls).toEqual(["draft", "move"]);
    expect(saveDraft).toHaveBeenCalledWith("thread-1", {
      text: "Preserve this idea",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
    });
    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "move_draft",
      workspaceId: "workspace-2",
      expectedThreadRevision: 7,
      mutationId: expect.any(String),
    });
  });

  it("exposes Stop as a capability-gated interrupt operation", async () => {
    const operateThread = vi.fn(async () => ({
      status: "accepted" as const,
      operationId: "operation-1",
    }));
    const api = { operateThread } as unknown as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    installSnapshot(transport);

    await store.stopActiveTurn();

    expect(operateThread).toHaveBeenCalledWith("thread-1", {
      kind: "interrupt",
      operationId: expect.any(String),
    });
  });

  it("acknowledges a visible completion once without dismissing special attention", async () => {
    const dismissThreadAttention = vi.fn(async () => undefined);
    const api = { dismissThreadAttention } as unknown as ApiClient;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", api, transport);
    await store.start();
    installSnapshot(transport);

    await Promise.all([
      store.acknowledgeVisibleCompletion("operation-1"),
      store.acknowledgeVisibleCompletion("operation-1"),
    ]);
    await store.acknowledgeVisibleCompletion("operation-1");

    expect(dismissThreadAttention).toHaveBeenCalledOnce();
    expect(dismissThreadAttention).toHaveBeenCalledWith(
      "thread-1",
      {
        kind: "unseen_completion",
        operationId: "operation-1",
      },
      expect.any(String),
    );
  });

  it("retries a transient visible-completion acknowledgement failure", async () => {
    vi.useFakeTimers();
    try {
      const dismissThreadAttention = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary network failure"))
        .mockResolvedValueOnce(undefined);
      const api = { dismissThreadAttention } as unknown as ApiClient;
      const transport = new FakeTransport();
      const store = new ThreadClientStore("thread-1", api, transport);
      await store.start();
      installSnapshot(transport);

      const acknowledgement = store.acknowledgeVisibleCompletion("operation-1");
      await vi.advanceTimersByTimeAsync(250);
      await acknowledgement;

      expect(dismissThreadAttention).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a hidden document to become visible before acknowledging completion", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const dismissThreadAttention = vi.fn(async () => undefined);
    const api = { dismissThreadAttention } as unknown as ApiClient;
    const store = new ThreadClientStore("thread-1", api, new FakeTransport());

    const acknowledgement =
      store.acknowledgeVisibleCompletion("operation-hidden");
    await Promise.resolve();
    expect(dismissThreadAttention).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await acknowledgement;

    expect(dismissThreadAttention).toHaveBeenCalledWith(
      "thread-1",
      {
        kind: "unseen_completion",
        operationId: "operation-hidden",
      },
      expect.any(String),
    );
    store.dispose();
  });

  it("backs off between resubscribes and resets only after an applied incremental", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      expect(store.getSnapshot().authoritative).toBe(true);
      expect(transport.threads).toHaveLength(1);

      const poison = () =>
        transport.thread?.onEnvelope({
          eventId: `${hubId}.5`,
          projectionGeneration: "projection-1",
          event: {
            type: "usage_changed",
            generation: "projection-1",
            usage: {},
          },
        });

      // First invalidation: the poisoned envelope applies at the next
      // frame flush, and the resubscribe is scheduled from there.
      poison();
      expect(store.getSnapshot().authoritative).toBe(true);
      await vi.advanceTimersByTimeAsync(160);
      expect(store.getSnapshot().authoritative).toBe(false);
      expect(transport.threads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(2);

      // A server that keeps failing the same way gets exponential backoff.
      poison();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(3);

      // An anchor snapshot alone does not reset the backoff: the poison
      // loop delivers a clean snapshot before its regressing suffix every
      // cycle. Resetting requires genuine progress — an applied incremental.
      installSnapshot(transport);
      expect(store.getSnapshot().authoritative).toBe(true);
      poison();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(750);
      expect(transport.threads).toHaveLength(4);

      // A successfully applied incremental proves a healthy stream and
      // resets the backoff to the floor.
      installSnapshot(transport);
      transport.thread?.onEnvelope({
        eventId: `${hubId}.1`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        },
      });
      await vi.advanceTimersByTimeAsync(160);
      expect(store.getSnapshot().authoritative).toBe(true);
      transport.thread?.onEnvelope({
        eventId: `${hubId}.6`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        },
      });
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(5);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("decays resubscribe backoff after a subscription stays healthy", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);

      const poison = () =>
        transport.thread?.onEnvelope({
          eventId: `${hubId}.5`,
          projectionGeneration: "projection-1",
          event: {
            type: "usage_changed",
            generation: "projection-1",
            usage: {},
          },
        });

      // Escalate the backoff twice.
      poison();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(2);
      poison();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.threads).toHaveLength(3);

      // The new subscription stays healthy (no invalidation, and no
      // incremental arrives to reset the backoff the fast way): after the
      // healthy window the backoff decays back to the floor.
      installSnapshot(transport);
      transport.thread?.onLive?.();
      await vi.advanceTimersByTimeAsync(15_000);
      poison();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(4);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches streaming envelopes into one notification per frame, in order", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      const notify = vi.fn();
      store.subscribe(notify);

      const usageDelta = (sequence: number) => ({
        eventId: `${hubId}.${sequence}`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed" as const,
          generation: "projection-1",
          usage: {
            context: { usedTokens: sequence, windowTokens: 100 },
          },
        },
      });
      transport.thread?.onEnvelope(usageDelta(1));
      transport.thread?.onEnvelope(usageDelta(2));
      transport.thread?.onEnvelope(usageDelta(3));

      // Nothing applies synchronously: one render per frame, not per delta.
      expect(notify).not.toHaveBeenCalled();
      expect(store.getSnapshot().snapshot?.usage).toEqual({});

      await vi.advanceTimersByTimeAsync(160);

      expect(notify).toHaveBeenCalledOnce();
      // All three deltas applied, in arrival order (the cursor enforcement
      // would invalidate any reordering), ending on the last one.
      expect(store.getSnapshot().snapshot?.usage).toEqual({
        context: { usedTokens: 3, windowTokens: 100 },
      });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles envelope flushes to the streaming interval while a turn runs", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      const notify = vi.fn();
      store.subscribe(notify);

      // The fixture snapshot has runState "running": deltas must NOT flush
      // on the next frame, only on the streaming interval.
      transport.thread?.onEnvelope({
        eventId: `${hubId}.1`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: { context: { usedTokens: 1, windowTokens: 100 } },
        },
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(notify).not.toHaveBeenCalled();
      expect(store.getSnapshot().snapshot?.usage).toEqual({});

      await vi.advanceTimersByTimeAsync(150);
      expect(notify).toHaveBeenCalledOnce();
      expect(store.getSnapshot().snapshot?.usage).toEqual({
        context: { usedTokens: 1, windowTokens: 100 },
      });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the scheduled, actual, and applied streaming batch timing", async () => {
    vi.useFakeTimers();
    try {
      setDiagnosticCategoryEnabled("streaming", true);
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);

      emitMaterializedSteer(transport, "diagnostic-operation");
      await vi.advanceTimersByTimeAsync(150);

      expect(readDiagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "streaming",
            event: "stream_batch_scheduled",
            details: expect.objectContaining({
              batchSize: 1,
              scheduledDelayMilliseconds: 150,
            }),
          }),
          expect.objectContaining({
            category: "streaming",
            event: "stream_batch_timer_fired",
            details: expect.objectContaining({
              batchSize: 1,
              durationMilliseconds: 150,
            }),
          }),
          expect.objectContaining({
            category: "streaming",
            event: "stream_batch_applied",
            details: expect.objectContaining({ applied: 1, batchSize: 1 }),
          }),
        ]),
      );
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the buffered batch immediately when a snapshot arrives", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);

      transport.thread?.onEnvelope({
        eventId: `${hubId}.1`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: { context: { usedTokens: 7, windowTokens: 100 } },
        },
      });
      expect(store.getSnapshot().snapshot?.usage).toEqual({});

      // A snapshot flushes synchronously (first-paint latency), applying
      // the buffered incremental ahead of itself in order.
      transport.thread?.onEnvelope({
        eventId: `${hubId}.0`,
        projectionGeneration: "projection-1",
        event: {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        },
      });
      expect(store.getSnapshot().snapshot?.usage).toEqual({
        context: { usedTokens: 7, windowTokens: 100 },
      });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resubscribes once when a batch invalidates mid-flush and keeps the backoff escalated", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      expect(transport.threads).toHaveLength(1);

      const usage = (sequence: number) => ({
        eventId: `${hubId}.${sequence}`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed" as const,
          generation: "projection-1",
          usage: {},
        },
      });

      // One batch: a valid incremental, then a sequence gap (poison), then
      // a third envelope that must be dropped with the dead projection.
      transport.thread?.onEnvelope(usage(1));
      transport.thread?.onEnvelope(usage(5));
      transport.thread?.onEnvelope(usage(6));
      await vi.advanceTimersByTimeAsync(160);

      expect(store.getSnapshot().authoritative).toBe(false);
      expect(store.getSnapshot().error).toContain(
        "Thread stream needs a new snapshot",
      );
      expect(transport.threads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      // Exactly one resubscribe for the whole poisoned batch.
      expect(transport.threads).toHaveLength(2);

      // The valid incremental inside the invalidated batch must NOT reset
      // the backoff: the next poison cycle waits 500ms, not the 250ms floor.
      installSnapshot(transport);
      transport.thread?.onEnvelope(usage(5));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(transport.threads).toHaveLength(3);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose cancels a pending envelope flush", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        {} as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);

      transport.thread?.onEnvelope({
        eventId: `${hubId}.1`,
        projectionGeneration: "projection-1",
        event: {
          type: "usage_changed",
          generation: "projection-1",
          usage: { context: { usedTokens: 9, windowTokens: 100 } },
        },
      });
      store.dispose();
      await vi.advanceTimersByTimeAsync(100);

      expect(store.normalized.state.snapshot?.usage).toEqual({});
      expect(store.getSnapshot().snapshot?.usage).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads bookmarks and sends explicit completed-turn preview authority", async () => {
    const listTurnBookmarks = vi.fn(async () => ({
      revision: 2,
      bookmarks: [],
    }));
    const setTurnBookmark = vi.fn(async () => ({
      revision: 3,
      bookmark: {
        turnId: "turn-1",
        userPreview: "Question",
        assistantPreview: "Answer",
        responseState: "responded" as const,
        createdAt: 10,
      },
      replayed: false,
    }));
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );

    await store.loadBookmarks();
    await store.setTurnBookmarked({
      turnId: "turn-1",
      bookmarked: true,
      preview: {
        userPreview: "Question",
        assistantPreview: "Answer",
        responseState: "responded",
      },
    });

    expect(setTurnBookmark).toHaveBeenCalledWith("thread-1", "turn-1", {
      bookmarked: true,
      expectedRevision: 2,
      mutationId: expect.any(String),
      userPreview: "Question",
      assistantPreview: "Answer",
      responseState: "responded",
    });
    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 3,
      bookmarkStatus: "ready",
      bookmarks: [{ turnId: "turn-1" }],
    });
  });

  it("reloads authoritative bookmarks after a revision conflict without retaining the stale error", async () => {
    const listTurnBookmarks = vi
      .fn()
      .mockResolvedValueOnce({ revision: 1, bookmarks: [] })
      .mockResolvedValueOnce({
        revision: 2,
        bookmarks: [
          {
            turnId: "turn-other",
            userPreview: "Elsewhere",
            assistantPreview: null,
            responseState: "no_response",
            createdAt: 11,
          },
        ],
      });
    const setTurnBookmark = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          "bookmark_revision_conflict",
          "Bookmark revision changed.",
          true,
        ),
      );
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();

    await expect(
      store.setTurnBookmarked({ turnId: "turn-1", bookmarked: false }),
    ).rejects.toMatchObject({ code: "bookmark_revision_conflict" });
    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 2,
      bookmarkError: undefined,
      bookmarks: [{ turnId: "turn-other" }],
    });
  });

  it("refreshes bookmarks when the application summary publishes a new revision", async () => {
    const listTurnBookmarks = vi
      .fn()
      .mockResolvedValueOnce({ revision: 0, bookmarks: [] })
      .mockResolvedValueOnce({ revision: 1, bookmarks: [] });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    store.observePublishedBookmarkRevision(1);

    await vi.waitFor(() => expect(listTurnBookmarks).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot().bookmarkRevision).toBe(1);
  });
});

describe("ThreadClientStore bookmark preview reconciliation", () => {
  const pendingBookmark = {
    turnId: "turn-1",
    userPreview: "Question",
    assistantPreview: "Final",
    responseState: "responded" as const,
    createdAt: 10,
  };
  const preview = {
    userPreview: "Question",
    assistantPreview: "Final answer",
    responseState: "responded" as const,
  };
  const refresh = { turnId: "turn-1", preview };

  it.each([
    ["See [the docs](https://example.invalid/long-partial-url", "See the docs for details"],
    ["See ![the diagram](https://example.invalid/image", "See the diagram"],
    ["See [the do", "See the docs for details"],
  ])("repairs a finished Markdown preview without requiring raw prefix extension: %s", async (saved, completed) => {
    const bookmark = { ...pendingBookmark, assistantPreview: saved };
    const next = { ...preview, assistantPreview: completed };
    const listTurnBookmarks = vi.fn().mockResolvedValue({ revision: 2, bookmarks: [bookmark] });
    const setTurnBookmark = vi.fn().mockResolvedValue({ revision: 3, bookmark: { ...bookmark, ...next }, replayed: false });
    const store = new ThreadClientStore("thread-1", { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient, new FakeTransport());
    await store.loadBookmarks();
    await store.refreshTurnBookmarkPreview({ turnId: "turn-1", preview: next });
    await store.refreshTurnBookmarkPreview({ turnId: "turn-1", preview: next });
    expect(setTurnBookmark).toHaveBeenCalledExactlyOnceWith("thread-1", "turn-1", {
      bookmarked: true, expectedRevision: 2, mutationId: expect.any(String), ...next,
    });
  });

  it("does not replace an unfinished Markdown preview with an unrelated retained suffix", async () => {
    const bookmark = { ...pendingBookmark, assistantPreview: "See [the docs](https://example.invalid/partial" };
    const listTurnBookmarks = vi.fn().mockResolvedValue({ revision: 2, bookmarks: [bookmark] });
    const setTurnBookmark = vi.fn();
    const store = new ThreadClientStore("thread-1", { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient, new FakeTransport());
    await store.loadBookmarks();
    await store.refreshTurnBookmarkPreview({ turnId: "turn-1", preview });
    expect(setTurnBookmark).not.toHaveBeenCalled();
  });

  it.each([
    { assistantPreview: "Fin", responseState: "responded" as const },
    { assistantPreview: "Final", responseState: "responded" as const },
    { assistantPreview: "Unrelated retained response suffix", responseState: "responded" as const },
    { assistantPreview: null, responseState: "no_response" as const },
  ])("retains the saved preview when history cannot extend it: $assistantPreview", async (response) => {
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark],
    });
    const setTurnBookmark = vi.fn();
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    await store.refreshTurnBookmarkPreview({
      turnId: "turn-1",
      preview: { userPreview: "Different retained prompt", ...response },
    });

    expect(setTurnBookmark).not.toHaveBeenCalled();
    expect(store.getSnapshot().bookmarks).toEqual([pendingBookmark]);
  });

  it("preserves the saved user preview while extending the assistant preview", async () => {
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark],
    });
    const setTurnBookmark = vi.fn().mockResolvedValue({
      revision: 3,
      bookmark: { ...pendingBookmark, ...preview },
      replayed: false,
    });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    await store.refreshTurnBookmarkPreview({
      turnId: "turn-1",
      preview: { ...preview, userPreview: "Different retained prompt" },
    });

    expect(setTurnBookmark).toHaveBeenCalledWith("thread-1", "turn-1", {
      bookmarked: true,
      expectedRevision: 2,
      mutationId: expect.any(String),
      ...preview,
    });
    expect(store.getSnapshot().bookmarks).toEqual([{ ...pendingBookmark, ...preview }]);
  });

  it("reconciles a loaded bookmark on revisit and persists its final preview only once", async () => {
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark],
    });
    const setTurnBookmark = vi.fn().mockResolvedValue({
      revision: 3,
      bookmark: { ...pendingBookmark, ...preview },
      replayed: false,
    });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    await Promise.all([
      store.refreshTurnBookmarkPreview(refresh),
      store.refreshTurnBookmarkPreview(refresh),
    ]);
    await store.refreshTurnBookmarkPreview(refresh);

    expect(setTurnBookmark).toHaveBeenCalledTimes(1);
    expect(setTurnBookmark).toHaveBeenCalledWith("thread-1", "turn-1", {
      bookmarked: true,
      expectedRevision: 2,
      mutationId: expect.any(String),
      ...preview,
    });
    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 3,
      bookmarks: [{ ...pendingBookmark, ...preview }],
      pendingBookmarkTurnIds: [],
    });
  });

  it("does not recreate a bookmark when a local removal precedes its queued refresh", async () => {
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark],
    });
    const setTurnBookmark = vi.fn().mockResolvedValue({
      revision: 3,
      bookmark: null,
      replayed: false,
    });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    const removal = store.setTurnBookmarked({ turnId: "turn-1", bookmarked: false });
    const reconciliation = store.refreshTurnBookmarkPreview(refresh);
    await Promise.all([removal, reconciliation]);

    expect(setTurnBookmark).toHaveBeenCalledTimes(1);
    expect(setTurnBookmark).toHaveBeenCalledWith("thread-1", "turn-1", {
      bookmarked: false,
      expectedRevision: 2,
      mutationId: expect.any(String),
    });
    expect(store.getSnapshot().bookmarks).toEqual([]);
  });

  it("reloads a remote removal on revision conflict without retrying as an add", async () => {
    const listTurnBookmarks = vi.fn()
      .mockResolvedValueOnce({ revision: 2, bookmarks: [pendingBookmark] })
      .mockResolvedValueOnce({ revision: 3, bookmarks: [] });
    const setTurnBookmark = vi.fn().mockRejectedValue(
      new ApiError(409, "bookmark_revision_conflict", "Bookmark removed elsewhere.", true),
    );
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    await expect(store.refreshTurnBookmarkPreview(refresh)).rejects.toMatchObject({
      code: "bookmark_revision_conflict",
    });
    await store.refreshTurnBookmarkPreview(refresh);

    expect(setTurnBookmark).toHaveBeenCalledTimes(1);
    expect(listTurnBookmarks).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 3,
      bookmarkError: undefined,
      bookmarks: [],
    });
  });

  it("keeps a newer loaded removal when an older refresh response arrives", async () => {
    const listTurnBookmarks = vi.fn()
      .mockResolvedValueOnce({ revision: 2, bookmarks: [pendingBookmark] })
      .mockResolvedValueOnce({ revision: 4, bookmarks: [] });
    let finishRefresh!: (value: unknown) => void;
    const setTurnBookmark = vi.fn(() => new Promise((resolve) => {
      finishRefresh = resolve;
    }));
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    const reconciliation = store.refreshTurnBookmarkPreview(refresh);
    await vi.waitFor(() => expect(setTurnBookmark).toHaveBeenCalledTimes(1));
    await store.loadBookmarks();
    finishRefresh({
      revision: 3,
      bookmark: { ...pendingBookmark, ...preview },
      replayed: false,
    });
    await reconciliation;

    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 4,
      bookmarks: [],
      pendingBookmarkTurnIds: [],
    });
  });

  it("deduplicates failed background refreshes until an explicit reload permits retry", async () => {
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark],
    });
    const setTurnBookmark = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        revision: 3,
        bookmark: { ...pendingBookmark, ...preview },
        replayed: false,
      });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    await expect(store.refreshTurnBookmarkPreview(refresh)).rejects.toThrow("Network unavailable");
    await store.refreshTurnBookmarkPreview(refresh);
    await store.refreshTurnBookmarkPreview(refresh);
    expect(setTurnBookmark).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().bookmarks).toEqual([pendingBookmark]);
    expect(store.getSnapshot()).toMatchObject({ bookmarkError: undefined, bookmarkStatus: "ready", pendingBookmarkTurnIds: [] });

    await store.loadBookmarks();
    await store.refreshTurnBookmarkPreview(refresh);
    expect(setTurnBookmark).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      bookmarkRevision: 3,
      bookmarkError: undefined,
      bookmarks: [{ ...pendingBookmark, ...preview }],
    });
  });

  it("keeps an in-flight background refresh and a failed conflict reload out of mutation UI", async () => {
    const listTurnBookmarks = vi.fn()
      .mockResolvedValueOnce({ revision: 2, bookmarks: [pendingBookmark] })
      .mockRejectedValueOnce(new Error("Network unavailable"));
    let rejectRefresh!: (error: Error) => void;
    const setTurnBookmark = vi.fn(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    const store = new ThreadClientStore("thread-1", { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient, new FakeTransport());
    await store.loadBookmarks();
    const published: unknown[] = [];
    const unsubscribe = store.subscribe(() => published.push(store.getSnapshot()));
    const operation = store.refreshTurnBookmarkPreview(refresh);
    await vi.waitFor(() => expect(setTurnBookmark).toHaveBeenCalledTimes(1));
    expect(store.getSnapshot()).toMatchObject({ pendingBookmarkTurnIds: [], bookmarkStatus: "ready", bookmarkError: undefined });
    rejectRefresh(new ApiError(409, "bookmark_revision_conflict", "Changed elsewhere.", true));
    await expect(operation).rejects.toMatchObject({ code: "bookmark_revision_conflict" });
    for (const state of published) {
      expect(state).toMatchObject({ pendingBookmarkTurnIds: [], bookmarkStatus: "ready", bookmarkError: undefined });
    }
    expect(store.getSnapshot().bookmarks).toEqual([pendingBookmark]);
    unsubscribe();
  });

  it("does not supersede a foreground bookmark reload with a background conflict check", async () => {
    let finishLoad!: (value: unknown) => void;
    const listTurnBookmarks = vi.fn()
      .mockResolvedValueOnce({ revision: 2, bookmarks: [pendingBookmark] })
      .mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    let rejectRefresh!: (error: Error) => void;
    const setTurnBookmark = vi.fn(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    const store = new ThreadClientStore("thread-1", { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient, new FakeTransport());
    await store.loadBookmarks();
    const refreshOperation = store.refreshTurnBookmarkPreview(refresh);
    await vi.waitFor(() => expect(setTurnBookmark).toHaveBeenCalledTimes(1));
    const foregroundLoad = store.loadBookmarks();
    rejectRefresh(new ApiError(409, "bookmark_revision_conflict", "Changed elsewhere.", true));
    await expect(refreshOperation).rejects.toMatchObject({ code: "bookmark_revision_conflict" });
    expect(listTurnBookmarks).toHaveBeenCalledTimes(2);
    finishLoad({ revision: 3, bookmarks: [] });
    await foregroundLoad;
    expect(store.getSnapshot()).toMatchObject({ bookmarkStatus: "ready", bookmarkRevision: 3, bookmarks: [], bookmarkError: undefined });
  });

  it("reconciles another queued bookmark against the revision from the first refresh", async () => {
    const otherBookmark = { ...pendingBookmark, turnId: "turn-2" };
    const listTurnBookmarks = vi.fn().mockResolvedValue({
      revision: 2,
      bookmarks: [pendingBookmark, otherBookmark],
    });
    const setTurnBookmark = vi.fn()
      .mockResolvedValueOnce({ revision: 3, bookmark: { ...pendingBookmark, ...preview }, replayed: false })
      .mockResolvedValueOnce({ revision: 4, bookmark: { ...otherBookmark, ...preview }, replayed: false });
    const store = new ThreadClientStore(
      "thread-1",
      { listTurnBookmarks, setTurnBookmark } as unknown as ApiClient,
      new FakeTransport(),
    );
    await store.loadBookmarks();
    const otherRefresh = { turnId: "turn-2", preview };
    await Promise.all([
      store.refreshTurnBookmarkPreview(refresh),
      store.refreshTurnBookmarkPreview(otherRefresh),
    ]);
    // A render after the first revision changes re-admits the skipped refresh.
    await store.refreshTurnBookmarkPreview(otherRefresh);

    expect(setTurnBookmark).toHaveBeenCalledTimes(2);
    expect(setTurnBookmark).toHaveBeenLastCalledWith("thread-1", "turn-2", {
      bookmarked: true,
      expectedRevision: 3,
      mutationId: expect.any(String),
      ...preview,
    });
    expect(store.getSnapshot().bookmarks).toEqual([
      { ...pendingBookmark, ...preview },
      { ...otherBookmark, ...preview },
    ]);
  });
});

describe("ThreadClientStore question inbox authority", () => {
  const request = {
    id: "question-1", threadId: "thread-1", sourceItemId: "stable-source", revision: 1 as const,
    createdAt: "2026-09-07T12:00:00Z", questions: [{ index: 0, title: "Which region?", options: ["east", "west"] }],
  };

  it("retains closure and consumed opening intent while pruning resolved question keys", async () => {
    const listQuestionRequests = vi.fn()
      .mockResolvedValueOnce({ revision: 1, requests: [request] })
      .mockResolvedValueOnce({ revision: 2, requests: [] });
    const store = new ThreadClientStore(
      "thread-1", { listQuestionRequests } as unknown as ApiClient, new FakeTransport(),
    );
    await store.loadQuestionRequests();
    store.requestQuestionInboxOpen();
    store.closeQuestionInbox();
    expect(store.getSnapshot()).toMatchObject({
      questionInboxClosedQuestionKeys: ["question-1:0"],
      questionInboxConsumedOpenRevision: 1,
    });
    store.requestQuestionInboxOpen();
    expect(store.getSnapshot().questionInboxConsumedOpenRevision).toBe(1);
    store.acknowledgeQuestionInboxOpen();
    expect(store.getSnapshot()).toMatchObject({
      questionInboxClosedQuestionKeys: [],
      questionInboxConsumedOpenRevision: 2,
    });
    store.closeQuestionInbox();
    await store.loadQuestionRequests();
    expect(store.getSnapshot().questionInboxClosedQuestionKeys).toEqual([]);
    store.dispose();
  });

  it("does not resurrect dismissed questions when an older list response arrives", async () => {
    let finishLoad!: (value: { revision: number; requests: typeof request[] }) => void;
    const listQuestionRequests = vi.fn(() => new Promise<{ revision: number; requests: typeof request[] }>((resolve) => { finishLoad = resolve; }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", { listQuestionRequests } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    transport.thread!.onEnvelope({ eventId: `${hubId}.1`, projectionGeneration: "projection-1", event: { type: "questions_changed", generation: "projection-1", revision: 2, requests: [] } });
    await vi.waitFor(() => expect(store.getSnapshot().questionRevision).toBe(2));
    finishLoad({ revision: 1, requests: [request] });
    await Promise.resolve();
    expect(store.getSnapshot().questionRequests).toEqual([]);
    expect(store.normalized.replayCursor).toBe(`${hubId}.1`);
    store.dispose();
  });

  it.each([true, false])(
    "surfaces reload failures only without a fresher live update (updated: %s)",
    async (updated) => {
      const listQuestionRequests = vi.fn(async () => ({
        revision: 1,
        requests: [] as (typeof request)[],
      }));
      const transport = new FakeTransport();
      const store = new ThreadClientStore(
        "thread-1",
        { listQuestionRequests } as unknown as ApiClient,
        transport,
      );
      await store.start();
      installSnapshot(transport);
      await vi.waitFor(() =>
        expect(store.getSnapshot().questionRevision).toBe(1),
      );
      let failLoad!: (error: Error) => void;
      listQuestionRequests.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failLoad = reject;
          }),
      );
      const load = store.loadQuestionRequests();
      if (updated) {
        transport.thread!.onEnvelope({
          eventId: `${hubId}.1`,
          projectionGeneration: "projection-1",
          event: {
            type: "questions_changed",
            generation: "projection-1",
            revision: 2,
            requests: [request],
          },
        });
        await vi.waitFor(() =>
          expect(store.getSnapshot().questionRevision).toBe(2),
        );
      }
      failLoad(new Error("Reload failed"));
      await load;
      expect(store.getSnapshot()).toMatchObject({
        questionStatus: updated ? "ready" : "error",
        questionError: updated ? undefined : "Reload failed",
        questionRequests: updated ? [request] : [],
      });
      store.dispose();
    },
  );

  it("uses the question API without changing the durable composer and prevents duplicate clicks", async () => {
    let finishReply!: (value: RespondToQuestionResult) => void;
    const respondToQuestion = vi.fn(() => new Promise<RespondToQuestionResult>((resolve) => { finishReply = resolve; }));
    const listQuestionRequests = vi.fn(async () => ({ revision: 1, requests: [request] }));
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", { listQuestionRequests, respondToQuestion } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    const draft = store.getSnapshot().snapshot!.draft;
    store.setQuestionDraft(request.id, ["west"]);
    const first = store.respondToQuestion(request, [{questionIndex: 0, answer: "west"}]);
    await store.respondToQuestion(request, [{questionIndex: 0, answer: "west"}]);
    expect(respondToQuestion).toHaveBeenCalledExactlyOnceWith("thread-1", request.id, { revision: 1, answers: [{questionIndex: 0, answer: "west"}] });
    expect(store.getSnapshot().pendingQuestionIds).toEqual([request.id]);
    expect(store.getSnapshot().pendingQuestionReplies).toMatchObject([{requestId:request.id, answers:[{answer:"west"}]}]);
    finishReply({ revision: 2, requests: [], deliveryState: "cancelled", deliveryOperationId: "reply-operation", queuedInput: null }); await first;
    expect(store.getSnapshot().pendingQuestionReplies).toEqual([]);
    expect(store.getSnapshot().snapshot!.draft).toEqual(draft);
    expect(store.getSnapshot().questionDrafts).toEqual({});
    expect(store.getSnapshot().pendingQuestionIds).toEqual([]);
    store.dispose();
  });

  it.each(["receipt-first", "event-first"])("hands answer feedback to exact queue authority (%s)", async (order) => {
    let finish!: (result: RespondToQuestionResult) => void;
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {
      listQuestionRequests: async () => ({revision:1, requests:[request]}),
      respondToQuestion: () => new Promise<RespondToQuestionResult>((resolve) => { finish = resolve; }),
    } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    const pending = store.respondToQuestion(request, [{questionIndex:0, answer:"west"}]);
    expect(store.getSnapshot().pendingQuestionReplies).toHaveLength(1);
    const queuedInput: QueuedInputSummary = {
      id:"queue-answer", deliveryOperationId:"operation-answer", resolvedDeliveryMode:"steer",
      requestedDeliveryMode:"steer", sequence:1, state:"pending", origin:"user", isHead:true,
      preview:{text:"User responded to a question:"}, attachmentCount:0, taskCount:0, createdAt:request.createdAt,
      inputOrigin:{kind:"question_response", requestId:request.id, sourceItemId:request.sourceItemId,
        answers:[{questionIndex:0, question:request.questions[0]!.title, answer:"west"}]},
    };
    const publish = async () => {
      transport.thread!.onEnvelope({eventId:`${hubId}.1`, projectionGeneration:"projection-1", event:{type:"queue_changed", generation:"projection-1", threadRevision:8, items:[queuedInput]}});
      await vi.waitFor(() => expect(store.getSnapshot().snapshot!.queue).toHaveLength(1));
    };
    if (order === "event-first") await publish();
    finish({revision:2, requests:[], deliveryState:"pending", deliveryOperationId:queuedInput.deliveryOperationId, queuedInput});
    await pending;
    if (order === "receipt-first") {
      expect(store.getSnapshot().pendingQuestionReplies[0]?.queuedInput).toEqual(queuedInput);
      await publish();
    }
    expect(store.getSnapshot().pendingQuestionReplies).toEqual([]);
    expect(store.getSnapshot().snapshot!.queue).toEqual([queuedInput]);
    store.dispose();
  });

  it("keeps an accepted reply visible until its exact user message materializes", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {
      listQuestionRequests: async () => ({revision:1, requests:[request]}),
      respondToQuestion: async () => ({revision:2, requests:[], deliveryState:"accepted", deliveryOperationId:"accepted-answer", queuedInput:null}),
    } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    await store.respondToQuestion(request, [{questionIndex:0, answer:"west"}]);
    expect(store.getSnapshot().pendingQuestionReplies).toMatchObject([{deliveryOperationId:"accepted-answer"}]);
    emitMaterializedSteer(transport, "unrelated-answer", 1);
    await vi.waitFor(() => expect(store.getSnapshot().snapshot!.itemsById["user-1"]).toBeDefined());
    expect(store.getSnapshot().pendingQuestionReplies).toHaveLength(1);
    emitMaterializedSteer(transport, "accepted-answer", 2);
    await vi.waitFor(() => expect(store.getSnapshot().pendingQuestionReplies).toEqual([]));
    store.dispose();
  });

  it("removes Sending feedback on failed answer while retaining the question and custom draft", async () => {
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {
      listQuestionRequests: async () => ({revision:1, requests:[request]}),
      respondToQuestion: async () => { throw new Error("Not admitted"); },
    } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    store.setQuestionDraft(request.id, ["custom west"]);
    await expect(store.respondToQuestion(request, [{questionIndex:0, answer:"custom west"}])).rejects.toThrow("Not admitted");
    expect(store.getSnapshot().pendingQuestionReplies).toEqual([]);
    expect(store.getSnapshot().questionRequests).toEqual([request]);
    expect(store.getSnapshot().questionDrafts[request.id]).toEqual(["custom west"]);
    store.dispose();
  });

  it("preserves sibling draft indices after a partial response and ignores stale events", async () => {
    const batch = {...request, questions: [...request.questions, {index:1, title:"Anything else?", options:null}]};
    const listQuestionRequests = vi.fn(async () => ({revision:1, requests:[batch]}));
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {listQuestionRequests} as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    store.setQuestionDraft(batch.id, ["east", "Keep sibling"]);
    const remaining = {...batch, revision:2, questions:[batch.questions[1]!]};
    transport.thread!.onEnvelope({eventId:`${hubId}.1`, projectionGeneration:"projection-1", event:{type:"questions_changed", generation:"projection-1", revision:2, requests:[remaining]}});
    await vi.waitFor(() => expect(store.getSnapshot().questionRequests).toEqual([remaining]));
    expect(store.getSnapshot().questionDrafts[batch.id]).toEqual(["", "Keep sibling"]);
    transport.thread!.onEnvelope({eventId:`${hubId}.2`, projectionGeneration:"projection-1", event:{type:"questions_changed", generation:"projection-1", revision:1, requests:[batch]}});
    await Promise.resolve();
    expect(store.getSnapshot().questionRequests).toEqual([remaining]);
    expect(store.getSnapshot().questionDrafts[batch.id]).toEqual(["", "Keep sibling"]);
    store.dispose();
  });

  it("retains pending question drafts after failed dismissal and reconciles remote resolution", async () => {
    const listQuestionRequests = vi.fn(async () => ({ revision: 1, requests: [request] }));
    const dismissQuestion = vi.fn(async () => { throw new Error("Temporary failure"); });
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", { listQuestionRequests, dismissQuestion } as unknown as ApiClient, transport);
    await store.start(); installSnapshot(transport);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatus).toBe("ready"));
    store.setQuestionDraft(request.id, ["east"]);
    await expect(store.dismissQuestion(request)).rejects.toThrow("Temporary failure");
    expect(store.getSnapshot().questionRequests).toEqual([request]);
    expect(store.getSnapshot().questionDrafts[request.id]).toEqual(["east"]);
    transport.thread!.onEnvelope({ eventId: `${hubId}.1`, projectionGeneration: "projection-1", event: { type: "questions_changed", generation: "projection-1", revision: 2, requests: [] } });
    await vi.waitFor(() => expect(store.getSnapshot().questionRequests).toEqual([]));
    expect(store.getSnapshot().questionDrafts).toEqual({});
    store.dispose();
  });
});

describe("ThreadClientStore projected question resolution", () => {
  function questionSnapshot(sourceIds: string[]): NormalizedThreadSnapshot {
    const current = snapshot();
    current.itemsById = Object.fromEntries(sourceIds.map((sourceItemId) => [sourceItemId, {
      id: sourceItemId, turnId: "turn-1", kind: "assistant_message" as const,
      status: "completed" as const, revision: 0, markdown: { text: "" },
      nonblockingQuestions: { sourceItemId, questions: [{ title: "Which finish?", options: null }] },
    }]));
    current.turnsById["turn-1"]!.orderedItemIds = sourceIds;
    return current;
  }

  function hydrate(store: ThreadClientStore, sourceIds: string[], sequence = 0): void {
    store.normalized.apply({
      eventId: `${hubId}.${sequence}`, projectionGeneration: "projection-1",
      event: { type: "snapshot", generation: "projection-1", snapshot: questionSnapshot(sourceIds) },
    });
  }

  it("hydrates durable answers and dismissals without inferring unknown history", async () => {
    const listQuestionStatuses = vi.fn(async () => ({ revision: 4, statuses: [
      { sourceItemId: "answered", questions: [{ index: 0, status: "answered" }] },
      { sourceItemId: "dismissed", questions: [{ index: 0, status: "dismissed" }] },
    ] }));
    const store = new ThreadClientStore("thread-1", { listQuestionStatuses } as unknown as ApiClient, new FakeTransport());
    hydrate(store, ["answered", "dismissed", "unknown"]);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.answered?.questions[0]?.status).toBe("answered"));
    expect(store.getSnapshot().questionStatuses.dismissed?.questions[0]?.status).toBe("dismissed");
    expect(store.getSnapshot().questionStatuses.unknown).toBeUndefined();
    store.requestQuestionInboxOpen();
    store.closeQuestionInbox();
    await Promise.resolve();
    expect(listQuestionStatuses).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("rejects an older pending read after a resolution revision arrives", async () => {
    let finishOld!: (value: unknown) => void;
    const listQuestionStatuses = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ revision: 2, statuses: [{ sourceItemId: "q", questions: [{ index: 0, status: "answered" }] }] });
    const store = new ThreadClientStore("thread-1", {
      listQuestionStatuses, listQuestionRequests: async () => ({ revision: 2, requests: [] }),
    } as unknown as ApiClient, new FakeTransport());
    hydrate(store, ["q"]);
    await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(1));
    await store.loadQuestionRequests();
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered"));
    finishOld({ revision: 1, statuses: [{ sourceItemId: "q", questions: [{ index: 0, status: "pending" }] }] });
    await Promise.resolve();
    expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered");
    store.dispose();
  });

  it("retains resolved evidence across failed refreshes and prunes only evicted sources", async () => {
    const listQuestionStatuses = vi.fn()
      .mockResolvedValueOnce({ revision: 1, statuses: [
        { sourceItemId: "answered", questions: [{ index: 0, status: "answered" }] },
        { sourceItemId: "dismissed", questions: [{ index: 0, status: "dismissed" }] },
      ] })
      .mockRejectedValue(new Error("offline"));
    const store = new ThreadClientStore("thread-1", {
      listQuestionStatuses, listQuestionRequests: async () => ({ revision: 2, requests: [] }),
    } as unknown as ApiClient, new FakeTransport());
    hydrate(store, ["answered", "dismissed"]);
    await vi.waitFor(() => expect(Object.keys(store.getSnapshot().questionStatuses)).toHaveLength(2));
    await store.loadQuestionRequests();
    expect(store.getSnapshot().questionStatuses.answered?.questions[0]?.status).toBe("answered");
    await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot().questionStatuses.dismissed?.questions[0]?.status).toBe("dismissed");
    hydrate(store, ["answered", "unknown"], 1);
    expect(Object.keys(store.getSnapshot().questionStatuses)).toEqual(["answered"]);
    await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(3));
    expect(store.getSnapshot().questionStatuses.answered?.questions[0]?.status).toBe("answered");
    expect(store.getSnapshot().questionStatuses.unknown).toBeUndefined();
    store.dispose();
  });

  it("does not refetch when inbox hydration catches up to accepted status evidence", async () => {
    const listQuestionStatuses = vi.fn(async () => ({ revision: 4, statuses: [
      { sourceItemId: "q", questions: [{ index: 0, status: "answered" }] },
    ] }));
    const store = new ThreadClientStore("thread-1", {
      listQuestionStatuses, listQuestionRequests: async () => ({ revision: 4, requests: [] }),
    } as unknown as ApiClient, new FakeTransport());
    hydrate(store, ["q"]);
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered"));
    await store.loadQuestionRequests();
    expect(listQuestionStatuses).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered");
    hydrate(store, [], 1);
    expect(store.getSnapshot().questionStatuses).toEqual({});
    hydrate(store, ["q"], 2);
    await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered"));
    store.dispose();
  });

  it("revalidates on a new snapshot even when the inbox revision is unchanged", async () => {
    const listQuestionStatuses = vi.fn()
      .mockResolvedValueOnce({ revision: 1, statuses: [
        { sourceItemId: "q", questions: [{ index: 0, status: "answered" }] },
      ] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ revision: 1, statuses: [
        { sourceItemId: "q", questions: [{ index: 0, status: "answered" }] },
      ] });
    const transport = new FakeTransport();
    const store = new ThreadClientStore("thread-1", {
      listQuestionStatuses, listQuestionRequests: async () => ({ revision: 1, requests: [] }),
    } as unknown as ApiClient, transport);
    await store.start();
    installSnapshot(transport, questionSnapshot(["q"]));
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered"));
    for (const sequence of [1, 2]) {
      transport.thread!.onEnvelope({
        eventId: `${hubId}.${sequence}`, projectionGeneration: "projection-1",
        event: { type: "snapshot", generation: "projection-1", snapshot: questionSnapshot(["q"]) },
      });
      await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(sequence + 1));
      expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("answered");
    }
    store.dispose();
  });

  it("batches projected history and evicts sources when the projection is replaced", async () => {
    const listQuestionStatuses = vi.fn(async (_threadId: string, sourceItemIds: string[]) => ({
      revision: 1, statuses: sourceItemIds.map((sourceItemId) => ({ sourceItemId, questions: [{ index: 0, status: "dismissed" }] })),
    }));
    const store = new ThreadClientStore("thread-1", { listQuestionStatuses } as unknown as ApiClient, new FakeTransport());
    hydrate(store, Array.from({ length: 101 }, (_, index) => `question-${index}`));
    await vi.waitFor(() => expect(Object.keys(store.getSnapshot().questionStatuses)).toHaveLength(101));
    expect(listQuestionStatuses.mock.calls.map((call) => call[1].length)).toEqual([100, 1]);
    hydrate(store, ["new-page"], 1);
    expect(store.getSnapshot().questionStatuses).toEqual({});
    await vi.waitFor(() => expect(Object.keys(store.getSnapshot().questionStatuses)).toEqual(["new-page"]));
    store.dispose();
  });

  it("leaves failed lookup neutral and retries when the question revision changes", async () => {
    const listQuestionStatuses = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ revision: 2, statuses: [{ sourceItemId: "q", questions: [{ index: 0, status: "pending" }] }] });
    const store = new ThreadClientStore("thread-1", {
      listQuestionStatuses, listQuestionRequests: async () => ({ revision: 2, requests: [] }),
    } as unknown as ApiClient, new FakeTransport());
    hydrate(store, ["q"]);
    await vi.waitFor(() => expect(listQuestionStatuses).toHaveBeenCalledTimes(1));
    expect(store.getSnapshot().questionStatuses).toEqual({});
    await store.loadQuestionRequests();
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses.q?.questions[0]?.status).toBe("pending"));
    store.dispose();
  });

  it("looks up question facets added by an older history page", async () => {
    const listQuestionStatuses = vi.fn(async (_threadId: string, sourceItemIds: string[]) => ({
      revision: 1, statuses: sourceItemIds.map((sourceItemId) => ({ sourceItemId, questions: [{ index: 0, status: "answered" }] })),
    }));
    const store = new ThreadClientStore("thread-1", { listQuestionStatuses } as unknown as ApiClient, new FakeTransport());
    hydrate(store, []);
    const older = questionSnapshot(["older-question"]);
    const item = { ...older.itemsById["older-question"]!, turnId: "older-turn" };
    expect(store.normalized.apply({
      eventId: `${hubId}.1`, projectionGeneration: "projection-1",
      event: {
        type: "history_prepend", generation: "projection-1", page: {
          orderedTurnIds: ["older-turn"],
          turnsById: { "older-turn": { id: "older-turn", revision: 0, status: "completed", orderedItemIds: [item.id] } },
          itemsById: { [item.id]: item },
          forkSource: older.forkSource,
          forksByTurnId: {
            "older-turn": { ...older.forksByTurnId["turn-1"]!, sourceTurnId: "older-turn" },
          },
        },
      },
    })).toEqual({ kind: "applied" });
    await vi.waitFor(() => expect(store.getSnapshot().questionStatuses["older-question"]?.questions[0]?.status).toBe("answered"));
    expect(listQuestionStatuses).toHaveBeenCalledExactlyOnceWith("thread-1", ["older-question"]);
    store.dispose();
  });
});
