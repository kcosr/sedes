import { describe, expect, it, vi } from "vitest";
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import {
  queuedInputSummarySchema,
  type ConversationItem,
  type NormalizedThreadSnapshot,
  type ThreadEventEnvelope,
  type ThreadCheckpoint,
} from "../../src/shared/index.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../src/shared/protocol/payload.js";

const hub = "00000000-0000-4000-8000-000000000001";

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
      threadRevision: 0,
      runState: "running",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      projectId: "project-1",
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

function snapshotNearByteLimit(
  remainingBytes: number,
): NormalizedThreadSnapshot {
  const base = snapshot();
  const createdAt = "2026-07-30T15:00:00.000Z";
  const stashes = Array.from({ length: 133 }, (_, index) => ({
    id: `padding-${index}`,
    text: "x".repeat(251_500),
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    createdAt,
  }));
  const withEmptyTail = {
    ...base,
    stashes: [
      ...stashes,
      {
        id: "padding-tail",
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt,
      },
    ],
  };
  const target = MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - remainingBytes;
  const tailLength = target - serializedUtf8Bytes(withEmptyTail);
  if (tailLength < 0 || tailLength > 262_144) {
    throw new Error("test_snapshot_padding_invalid");
  }
  return {
    ...withEmptyTail,
    stashes: [
      ...stashes,
      {
        id: "padding-tail",
        text: "x".repeat(tailLength),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt,
      },
    ],
  };
}

function envelope(
  sequence: number,
  event: ThreadEventEnvelope["event"],
): ThreadEventEnvelope {
  return {
    eventId: `${hub}.${sequence}`,
    projectionGeneration: event.generation,
    event,
  };
}

function applicationState(
  value: NormalizedThreadSnapshot,
): Extract<
  ThreadEventEnvelope["event"],
  { readonly type: "application_state_changed" }
>["state"] {
  return {
    thread: value.thread,
    workspace: value.workspace,
    environment: value.environment,
    executionWorkspace: value.executionWorkspace,
    draft: value.draft,
    stashes: value.stashes,
    composerCommands: value.composerCommands,
    agentTools: value.agentTools,
    forkSource: value.forkSource,
    queue: value.queue,
    capabilities: value.capabilities,
    settings: value.settings,
    providerFeatures: value.providerFeatures,
    interactions: value.interactions,
    ...(value.recovery ? { recovery: value.recovery } : {}),
    attention: value.attention,
  };
}

function queuedInput(
  id: string,
  sequence: number,
  isHead: boolean,
): NormalizedThreadSnapshot["queue"][number] {
  return queuedInputSummarySchema.parse({
    id,
    deliveryOperationId: `delivery-${id}`,
    resolvedDeliveryMode: "queue",
    sequence,
    origin: "user",
    isHead,
    state: "pending",
    preview: { text: `Queued ${id}` },
    attachmentCount: 0,
    taskCount: 0,
    createdAt: "2026-07-30T15:00:00.000Z",
  });
}

describe("NormalizedThreadStore", () => {
  it("applies accounting invalidations without rebuilding transcript state and rejects stale generations", () => {
    const store=new NormalizedThreadStore();
    store.apply(envelope(0,{type:"snapshot",generation:"one",snapshot:snapshot()}));
    const original=store.state.snapshot,bytes=store.snapshotSerializedBytes;
    expect(store.apply(envelope(1,{type:"usage_revision_changed",generation:"one",revision:"9007199254740993"}))).toEqual({kind:"applied"});
    expect(store.state.snapshot).toBe(original);expect(store.snapshotSerializedBytes).toBe(bytes);
    store.apply(envelope(2,{type:"snapshot",generation:"two",snapshot:snapshot()}));
    expect(store.apply(envelope(3,{type:"usage_revision_changed",generation:"one",revision:"2"})).kind).not.toBe("applied");
  });

  it("tracks background work independently of main run state and replaces it with checkpoints", () => {
    const store = new NormalizedThreadStore();
    store.apply(envelope(0, { type: "snapshot", generation: "projection-1", snapshot: snapshot() }));
    const activity = { state: "known", agents: 1, commands: 0, other: 0, description: { text: "Inspect tests" } } as const;
    expect(store.apply(envelope(1, { type: "background_activity_changed", generation: "projection-1", activity }))).toEqual({ kind: "applied" });
    store.apply(envelope(2, { type: "run_state", generation: "projection-1", state: "idle" }));
    expect(store.state.snapshot?.backgroundActivity).toEqual(activity);
    expect(store.state.snapshot?.runState).toBe("idle");
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
    const uncertain = { ...activity, state: "unknown" } as const;
    store.apply(envelope(3, { type: "background_activity_changed", generation: "projection-1", activity: uncertain }));
    expect(store.state.snapshot?.backgroundActivity).toEqual(uncertain);
    const empty = { state: "known", agents: 0, commands: 0, other: 0 } as const;
    store.apply(envelope(4, { type: "background_activity_changed", generation: "projection-1", activity: empty }));
    expect(store.state.snapshot?.backgroundActivity).toEqual(empty);
    store.apply(envelope(5, { type: "snapshot", generation: "projection-2", snapshot: snapshot() }));
    expect(store.state.snapshot?.backgroundActivity).toBeUndefined();
  });

  it("installs complete checkpoint history and notices, then waits for live after newer events", () => {
    const store = new NormalizedThreadStore();
    const current = snapshot();
    current.history = { hasOlder: true, olderCursor: "history-retained" };
    const checkpoint: ThreadCheckpoint = {
      eventId: `${hub}.1000`,
      projectionGeneration: "projection-1",
      snapshot: current,
      capabilityThreadRevision: 0,
      capabilityRunState: "running",
      notices: [{
        id: "notice-checkpoint",
        tone: "info",
        message: { text: "Retained notice" },
        createdAt: "2026-07-30T15:00:00.000Z",
      }],
    };
    expect(store.applyCheckpoint(checkpoint)).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(false);
    expect(store.state.snapshot).toEqual(current);
    expect(store.state.notices).toEqual(checkpoint.notices);
    expect(store.replayCursor).toBe(checkpoint.eventId);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(current));
    expect(store.applyCheckpoint(checkpoint)).toEqual({ kind: "ignored" });
    expect(store.apply(envelope(1001, {
      type: "usage_changed", generation: "projection-1", usage: {},
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(false);
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.history).toEqual(current.history);
    expect(store.state.notices).toEqual(checkpoint.notices);
    expect(store.applyCheckpoint(checkpoint)).toEqual({ kind: "ignored" });
  });

  it("fences live actions while matching run-state capabilities are pending", () => {
    const store = new NormalizedThreadStore();
    const current = snapshot();
    store.apply(envelope(0, { type: "snapshot", generation: "projection-1", snapshot: current }));
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
    expect(store.awaitingRunStateCapabilities).toBe(false);
    store.apply(envelope(1, { type: "run_state", generation: "projection-1", state: "idle" }));
    expect(store.state.authoritative).toBe(false);
    expect(store.awaitingRunStateCapabilities).toBe(true);
    store.apply(envelope(2, { type: "capabilities_changed", generation: "projection-1", threadRevision: 0,
      capabilities: { ...current.capabilities, runState: "idle" }, providerFeatures: current.providerFeatures }));
    expect(store.state.authoritative).toBe(true);
    expect(store.awaitingRunStateCapabilities).toBe(false);
    store.prepareForReconnect();
    store.apply(envelope(3, { type: "run_state", generation: "projection-1", state: "running" }));
    expect(store.awaitingRunStateCapabilities).toBe(false);
    expect(store.state.authoritative).toBe(false);
  });

  it("keeps capability authority separate from a newer checkpoint thread revision", () => {
    const store = new NormalizedThreadStore();
    const current = snapshot();
    current.thread.threadRevision = 10;
    expect(store.applyCheckpoint({
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: current,
      notices: [],
      capabilityThreadRevision: 3,
      capabilityRunState: "running",
    })).toEqual({ kind: "applied" });
    expect(store.apply(envelope(11, {
      type: "capabilities_changed",
      generation: "projection-1",
      threadRevision: 4,
      capabilities: current.capabilities,
      providerFeatures: current.providerFeatures,
    }))).toEqual({ kind: "applied" });
    expect(store.capabilityThreadRevision).toBe(4);
    expect(store.state.snapshot?.thread.threadRevision).toBe(10);
    expect(store.state.authoritative).toBe(false);
    expect(store.apply(envelope(12, {
      type: "run_state", generation: "projection-1", state: "idle",
    }))).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.capabilities.runState).toBe("idle");
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(false);
    expect(store.apply(envelope(13, {
      type: "capabilities_changed",
      generation: "projection-1",
      threadRevision: 4,
      capabilities: { ...current.capabilities, runState: "idle" },
      providerFeatures: current.providerFeatures,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
  });

  it("replaces removed history exactly and fences delayed pages from the previous generation", () => {
    const store = new NormalizedThreadStore();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: snapshot(),
    }));
    const replacement = snapshot();
    replacement.orderedTurnIds = [];
    replacement.turnsById = {};
    replacement.forksByTurnId = {};
    replacement.itemsById = {};
    delete replacement.activeTurnId;
    expect(store.applyCheckpoint({
      eventId: `${hub}.20`,
      projectionGeneration: "projection-2",
      snapshot: replacement,
      notices: [],
      capabilityThreadRevision: 0,
      capabilityRunState: "running",
    })).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.orderedTurnIds).toEqual([]);
    expect(store.apply(envelope(19, {
      type: "history_prepend",
      generation: "projection-1",
      page: {
        orderedTurnIds: [], turnsById: {}, itemsById: {}, forksByTurnId: {},
        forkSource: replacement.forkSource,
      },
    }))).toEqual({ kind: "ignored" });
    expect(store.apply(envelope(21, {
      type: "snapshot", generation: "projection-3", snapshot: snapshot(),
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(false);
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
    expect(store.state.generation).toBe("projection-3");
  });

  it("rejects invalid checkpoint state and cannot restore authority at live", () => {
    const store = new NormalizedThreadStore();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: snapshot(),
    }));
    expect(store.applyCheckpoint({
      eventId: `${hub}.50`,
      projectionGeneration: "projection-1",
      snapshot: snapshot(),
      notices: [],
      capabilityThreadRevision: 99,
      capabilityRunState: "running",
    })).toEqual({ kind: "resnapshot_required", reason: "invalid_thread_checkpoint" });
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(false);
    expect(store.replayCursor).toBeUndefined();
  });

  it.each(["receipt-first", "checkpoint-first"])("retains HTTP queue receipt freshness across checkpoints (%s)", (order) => {
    const store = new NormalizedThreadStore();
    const original = snapshot();
    const checkpoint: ThreadCheckpoint = {
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: original,
      notices: [],
      capabilityThreadRevision: 0,
      capabilityRunState: "running",
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    if (order === "checkpoint-first") store.applyCheckpoint(checkpoint);
    expect(store.applyQueueMutationProjection({
      generation: "projection-1",
      threadRevision: 2,
      queue: [],
      draft: { ...original.draft, revision: 2, text: "receipt draft" },
    })).toEqual({ kind: "applied" });
    if (order === "receipt-first") store.applyCheckpoint(checkpoint);
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(order === "checkpoint-first");
    // Even a receipt that updated local state must remain fenced when the next
    // connection materializes an older published state at a newer watermark.
    store.applyCheckpoint({ ...checkpoint, eventId: `${hub}.11` });
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(false);
    expect(store.state.snapshot).toEqual(original);
    expect(store.apply(envelope(12, {
      type: "capabilities_changed",
      generation: "projection-1",
      threadRevision: 3,
      capabilities: original.capabilities,
      providerFeatures: original.providerFeatures,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(false);
    expect(store.apply(envelope(13, {
      type: "application_state_changed",
      generation: "projection-1",
      state: {
        ...applicationState(original),
        thread: { ...original.thread, threadRevision: 3 },
        draft: { ...original.draft, revision: 2, text: "receipt draft" },
      },
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft.text).toBe("receipt draft");
  });

  it("accepts queue catchup at a checkpoint revision already advanced by capabilities", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const original = {
      ...base,
      thread: { ...base.thread, threadRevision: 22, queuedInputCount: 2 },
      queue: [queuedInput("removed", 1, true), queuedInput("retained", 2, false)],
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    const checkpointSnapshot = {
      ...original,
      thread: { ...original.thread, threadRevision: 23 },
    };
    expect(store.applyCheckpoint({
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: checkpointSnapshot,
      notices: [],
      capabilityThreadRevision: 23,
      capabilityRunState: "running",
    })).toEqual({ kind: "applied" });
    const remaining = [queuedInput("retained", 2, true)];
    expect(store.apply(envelope(11, {
      type: "application_state_changed", generation: "projection-1",
      state: {
        ...applicationState(checkpointSnapshot),
        thread: { ...checkpointSnapshot.thread, queuedInputCount: 1 },
        queue: remaining,
      },
    }))).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.queue).toEqual(remaining);
    expect(store.state.authoritative).toBe(false);
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
  });

  it("does not lower restored-draft freshness when an older receipt arrives between checkpoints", () => {
    const store = new NormalizedThreadStore();
    const original = snapshot();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    const restored = { ...original.draft, revision: 6, text: "Newest restored draft" };
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 23, queue: [], draft: restored,
    });
    const checkpoint: ThreadCheckpoint = {
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: {
        ...original,
        thread: { ...original.thread, threadRevision: 21 },
        draft: { ...original.draft, revision: 4, text: "Older checkpoint draft" },
      },
      notices: [],
      capabilityThreadRevision: 21,
      capabilityRunState: "running",
    };
    store.applyCheckpoint(checkpoint);
    const olderReceiptDraft = { ...original.draft, revision: 5, text: "Older receipt draft" };
    expect(store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 22, queue: [], draft: olderReceiptDraft,
    })).toEqual({ kind: "applied" });
    store.applyCheckpoint({
      ...checkpoint,
      eventId: `${hub}.11`,
      snapshot: {
        ...original,
        thread: { ...original.thread, threadRevision: 23 },
        draft: olderReceiptDraft,
      },
      capabilityThreadRevision: 23,
    });
    store.confirmReplayCaughtUp();
    expect(store.state.snapshot?.draft).toEqual(olderReceiptDraft);
    expect(store.state.authoritative).toBe(false);
    expect(store.apply(envelope(12, {
      type: "draft_changed", generation: "projection-1", draft: restored,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft).toEqual(restored);
  });

  it("retains restored-draft freshness across a checkpoint after its queue receipt is confirmed", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const original = {
      ...base,
      thread: { ...base.thread, threadRevision: 21 },
      draft: { ...base.draft, revision: 4 },
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    const restored = { ...original.draft, revision: 6, text: "Restored queued input" };
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 23, queue: [], draft: restored,
    });
    store.apply(envelope(2, {
      type: "queue_changed", generation: "projection-1", threadRevision: 23, items: [],
    }));
    const checkpointSnapshot = {
      ...original,
      thread: { ...original.thread, threadRevision: 23 },
      draft: { ...original.draft, revision: 5, text: "Before restore" },
    };
    expect(store.applyCheckpoint({
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: checkpointSnapshot,
      notices: [],
      capabilityThreadRevision: 23,
      capabilityRunState: "running",
    })).toEqual({ kind: "applied" });
    store.confirmReplayCaughtUp();
    expect(store.state.snapshot?.draft).toEqual(checkpointSnapshot.draft);
    expect(store.state.authoritative).toBe(false);

    expect(store.apply(envelope(11, {
      type: "draft_changed", generation: "projection-1", draft: restored,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft).toEqual(restored);
  });

  it.each(["receipt-first", "checkpoint-first"])("does not reopen HTTP-resolved interactions through a checkpoint (%s)", (order) => {
    const store = new NormalizedThreadStore();
    const original = snapshot();
    original.interactions = [{
      id: "confirmed",
      threadId: "thread-1",
      kind: "confirmation",
      sourceLabel: { text: "Backend" },
      title: { text: "Confirm" },
      message: { text: "Continue?" },
      openedAt: "2026-07-30T15:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
    }];
    const checkpoint: ThreadCheckpoint = {
      eventId: `${hub}.10`,
      projectionGeneration: "projection-1",
      snapshot: original,
      notices: [],
      capabilityThreadRevision: 0,
      capabilityRunState: "running",
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    if (order === "checkpoint-first") store.applyCheckpoint(checkpoint);
    store.applyInteractionResolution("confirmed", "projection-1");
    if (order === "receipt-first") store.applyCheckpoint(checkpoint);
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(order === "checkpoint-first");
    store.applyCheckpoint({ ...checkpoint, eventId: `${hub}.11` });
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(false);
    expect(store.apply(envelope(12, {
      type: "interaction_resolved",
      generation: "projection-1",
      interactionId: "confirmed",
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.interactions).toEqual([]);
    store.applyCheckpoint({
      ...checkpoint, eventId: `${hub}.13`, projectionGeneration: "projection-2",
    });
    store.applyInteractionResolution("confirmed", "projection-1");
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.interactions).toHaveLength(1);
  });

  it("clears receipt freshness fences on a real generation replacement", () => {
    const store = new NormalizedThreadStore();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: snapshot(),
    }));
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 9, queue: [],
      draft: { ...snapshot().draft, revision: 9, text: "Restored in old generation" },
    });
    store.applyCheckpoint({
      eventId: `${hub}.10`,
      projectionGeneration: "projection-2",
      snapshot: snapshot(),
      notices: [],
      capabilityThreadRevision: 0,
      capabilityRunState: "running",
    });
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft).toEqual(snapshot().draft);
  });

  it("clears restored-draft freshness when the projection is reset", () => {
    const store = new NormalizedThreadStore();
    const original = snapshot();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 23, queue: [],
      draft: { ...original.draft, revision: 6, text: "Restored before reset" },
    });
    store.apply(envelope(2, {
      type: "queue_changed", generation: "projection-1", threadRevision: 23, items: [],
    }));
    store.resetProjection();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: original,
    }));
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft).toEqual(original.draft);
  });

  it("bounds unconfirmed interaction receipts and permits a fresh replacement", () => {
    const store = new NormalizedThreadStore();
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: snapshot(),
    }));
    for (let index = 0; index <= 32; index++) {
      const id = `receipt-${index}`;
      expect(store.apply(envelope(index + 2, {
        type: "interaction_opened",
        generation: "projection-1",
        interaction: {
          id, threadId: "thread-1", kind: "confirmation",
          sourceLabel: { text: "Backend" }, title: { text: "Confirm" },
          message: { text: "Continue?" }, openedAt: "2026-07-30T15:00:00.000Z",
          secret: false, destructive: false, cancellable: true,
        },
      }))).toEqual({ kind: "applied" });
      expect(store.applyInteractionResolution(id)).toEqual(index === 32
        ? { kind: "resnapshot_required", reason: "interaction_receipt_limit_exceeded" }
        : { kind: "applied" });
    }
    expect(store.state.authoritative).toBe(false);
    store.applyCheckpoint({
      eventId: `${hub}.40`, projectionGeneration: "projection-2",
      snapshot: snapshot(), notices: [], capabilityThreadRevision: 0,
      capabilityRunState: "running",
    });
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
  });

  it("requires a resnapshot before a thirty-third open interaction", () => {
    const store = new NormalizedThreadStore();
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });

    for (let index = 0; index < 32; index += 1) {
      expect(
        store.apply(
          envelope(index + 2, {
            type: "interaction_opened",
            generation: "projection-1",
            interaction: {
              id: `interaction-${index}`,
              threadId: "thread-1",
              kind: "confirmation",
              sourceLabel: { text: "Pi" },
              title: { text: "Confirm" },
              message: { text: "Continue?" },
              openedAt: "2026-07-30T15:00:00.000Z",
              secret: false,
              destructive: false,
              cancellable: true,
            },
          }),
        ),
      ).toEqual({ kind: "applied" });
    }

    expect(
      store.apply(
        envelope(34, {
          type: "interaction_opened",
          generation: "projection-1",
          interaction: {
            id: "interaction-32",
            threadId: "thread-1",
            kind: "confirmation",
            sourceLabel: { text: "Pi" },
            title: { text: "Confirm" },
            message: { text: "Continue?" },
            openedAt: "2026-07-30T15:00:00.000Z",
            secret: false,
            destructive: false,
            cancellable: true,
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "interaction_limit_exceeded",
    });
    expect(store.state.snapshot?.interactions).toHaveLength(32);
  });

  it("accepts an equal-watermark handshake snapshot after reconnect invalidation", () => {
    const store = new NormalizedThreadStore();
    const currentSnapshot = snapshot();
    const handshake = {
      eventId: `${hub}.0`,
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot" as const,
        generation: "projection-1",
        snapshot: currentSnapshot,
      },
    };
    expect(store.apply(handshake)).toEqual({ kind: "applied" });
    store.prepareForReconnect();
    expect(store.state.authoritative).toBe(false);

    expect(store.apply(handshake)).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
  });

  it("applies contiguous reconnect replay without granting authority early", () => {
    const store = new NormalizedThreadStore();
    expect(
      store.apply(
        envelope(0, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.replayCursor).toBe(`${hub}.0`);
    expect(store.snapshotSerializedBytes).toBe(
      serializedUtf8Bytes(store.state.snapshot),
    );

    store.prepareForReconnect();
    expect(
      store.apply(
        envelope(1, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.replayCursor).toBe(`${hub}.1`);
    expect(store.state.authoritative).toBe(false);

    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(true);
  });

  it("does not let a caught-up marker repair hard protocol invalidation", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(0, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );

    store.requireReplacement();
    expect(store.replayCursor).toBeUndefined();
    store.prepareForReconnect();
    store.confirmReplayCaughtUp();
    expect(store.state.authoritative).toBe(false);
    expect(
      store.apply(
        envelope(1, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "initial_snapshot_missing",
    });

    expect(
      store.apply(
        envelope(2, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
  });

  it("notifies React-compatible subscribers only when observable state changes", () => {
    const store = new NormalizedThreadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = envelope(1, {
      type: "snapshot",
      generation: "projection-1",
      snapshot: snapshot(),
    });

    store.apply(initial);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(store.state);

    store.apply(initial);
    expect(listener).toHaveBeenCalledTimes(1);

    store.apply(
      envelope(2, {
        type: "notice",
        generation: "projection-1",
        notice: {
          id: "notice-1",
          tone: "info",
          message: { text: "Still working" },
          createdAt: "2026-07-30T15:00:00.000Z",
        },
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.apply(
      envelope(3, {
        type: "notice",
        generation: "projection-1",
        notice: {
          id: "notice-2",
          tone: "success",
          message: { text: "Done" },
          createdAt: "2026-07-30T15:01:00.000Z",
        },
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("installs a snapshot then applies full item and turn upserts", () => {
    const store = new NormalizedThreadStore();
    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    const item = {
      id: "item-1",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "streaming",
      revision: 0,
      markdown: { text: "Hel" },
    } as const;
    expect(
      store.apply(
        envelope(5, {
          type: "item_upsert",
          generation: "projection-1",
          item,
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(
      store.apply(
        envelope(6, {
          type: "turn_upsert",
          generation: "projection-1",
          turn: {
            ...snapshot().turnsById["turn-1"]!,
            revision: 1,
            orderedItemIds: ["item-1"],
          },
          fork: {
            sourceTurnId: "turn-1",
            expectedTurnRevision: 1,
            available: false,
            unavailableReason: {
              text: "Forking is unavailable in this fixture.",
            },
          },
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.itemsById["item-1"]).toEqual(item);
  });

  it.each([false, true])(
    "keeps exact turn byte accounting when adding to an empty timeline: %s",
    (empty) => {
      const store = new NormalizedThreadStore();
      const base = snapshot();
      const initial = empty
        ? {
            ...base,
            orderedTurnIds: [],
            turnsById: {},
            forksByTurnId: {},
            activeTurnId: undefined,
          }
        : base;
      expect(
        store.apply(
          envelope(0, {
            type: "snapshot",
            generation: "projection-1",
            snapshot: initial,
          }),
        ),
      ).toEqual({ kind: "applied" });
      const id = 'turn-雪-"-\\';
      let previousBytes = store.snapshotSerializedBytes;
      for (const [index, revision] of [0, 9, 10, 100].entries()) {
        expect(
          store.apply(
            envelope(index + 1, {
              type: "turn_upsert",
              generation: "projection-1",
              turn: {
                id,
                revision,
                status: "in_progress",
                orderedItemIds: [],
                ...(revision < 100
                  ? { startedAt: "2026-01-01T00:00:00.000Z" }
                  : {}),
              },
              fork: {
                sourceTurnId: id,
                expectedTurnRevision: revision,
                available: false,
                unavailableReason: {
                  text:
                    revision < 100
                      ? "Forking is unavailable in this fixture."
                      : "Unavailable.",
                },
              },
            }),
          ),
        ).toEqual({ kind: "applied" });
        expect(store.snapshotSerializedBytes).toBe(
          serializedUtf8Bytes(store.state.snapshot),
        );
        if (revision === 100)
          expect(store.snapshotSerializedBytes).toBeLessThan(previousBytes);
        previousBytes = store.snapshotSerializedBytes;
      }
    },
  );

  it("rejects turn revision growth beyond the aggregate byte limit without replacing the snapshot", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshotNearByteLimit(1);
    expect(
      store.apply(
        envelope(0, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: initial,
        }),
      ),
    ).toEqual({ kind: "applied" });
    const accepted = store.state.snapshot;
    const acceptedBytes = store.snapshotSerializedBytes;
    expect(
      store.apply(
        envelope(1, {
          type: "turn_upsert",
          generation: "projection-1",
          turn: { ...initial.turnsById["turn-1"]!, revision: 10 },
          fork: {
            ...initial.forksByTurnId["turn-1"]!,
            expectedTurnRevision: 10,
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "timeline_window_limit_exceeded",
    });
    expect(store.state.snapshot).toBe(accepted);
    expect(store.snapshotSerializedBytes).toBe(acceptedBytes);
    expect(store.state.authoritative).toBe(false);
  });

  it("preserves user-before-assistant order across live item and turn upserts", () => {
    const store = new NormalizedThreadStore();
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    const user: ConversationItem = {
      id: "user-live",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 0,
      content: [{ kind: "text", text: { text: "Question" } }],
    };
    const assistant: ConversationItem = {
      id: "assistant-live",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "streaming",
      revision: 0,
      markdown: { text: "Partial" },
    };
    const events = [
      {
        type: "item_upsert" as const,
        generation: "projection-1",
        item: user,
      },
      {
        type: "turn_upsert" as const,
        generation: "projection-1",
        turn: {
          ...snapshot().turnsById["turn-1"]!,
          revision: 1,
          orderedItemIds: [user.id],
        },
        fork: {
          sourceTurnId: "turn-1",
          expectedTurnRevision: 1,
          available: false,
          unavailableReason: {
            text: "Forking is unavailable in this fixture.",
          },
        },
      },
      {
        type: "item_upsert" as const,
        generation: "projection-1",
        item: assistant,
      },
      {
        type: "turn_upsert" as const,
        generation: "projection-1",
        turn: {
          ...snapshot().turnsById["turn-1"]!,
          revision: 2,
          orderedItemIds: [user.id, assistant.id],
        },
        fork: {
          sourceTurnId: "turn-1",
          expectedTurnRevision: 2,
          available: false,
          unavailableReason: {
            text: "Forking is unavailable in this fixture.",
          },
        },
      },
    ];
    events.forEach((event, index) => {
      expect(store.apply(envelope(index + 2, event))).toEqual({
        kind: "applied",
      });
    });

    const current = store.state.snapshot!;
    expect(
      current.turnsById["turn-1"]?.orderedItemIds.map(
        (itemId) => current.itemsById[itemId]?.kind,
      ),
    ).toEqual(["user_message", "assistant_message"]);
  });

  it("fails closed before a history prepend can exceed the cumulative browser byte budget", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshotNearByteLimit(20_000);
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: initial,
        }),
      ),
    ).toEqual({ kind: "applied" });

    expect(
      store.apply(
        envelope(2, {
          type: "history_prepend",
          generation: "projection-1",
          page: {
            orderedTurnIds: ["older-turn"],
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
              "older-turn": {
                sourceTurnId: "older-turn",
                expectedTurnRevision: 0,
                available: false,
                unavailableReason: {
                  text: "Forking is unavailable in this fixture.",
                },
              },
            },
            turnsById: {
              "older-turn": {
                id: "older-turn",
                revision: 0,
                status: "completed",
                orderedItemIds: ["older-item"],
              },
            },
            itemsById: {
              "older-item": {
                id: "older-item",
                turnId: "older-turn",
                kind: "assistant_message",
                status: "completed",
                revision: 0,
                markdown: { text: "x".repeat(40_000) },
              },
            },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "history_window_limit_exceeded",
    });
    expect(store.state.authoritative).toBe(false);
    expect(store.state.snapshot?.orderedTurnIds).toEqual(
      initial.orderedTurnIds,
    );
  });

  it("counts non-timeline snapshot state when bounding an incremental item", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshotNearByteLimit(20_000);
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: initial,
        }),
      ),
    ).toEqual({ kind: "applied" });

    expect(
      store.apply(
        envelope(2, {
          type: "item_upsert",
          generation: "projection-1",
          item: {
            id: "oversized-increment",
            turnId: "turn-1",
            kind: "assistant_message",
            status: "streaming",
            revision: 0,
            markdown: { text: "x".repeat(30_000) },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "timeline_window_limit_exceeded",
    });
    expect(store.state.authoritative).toBe(false);
    expect(store.state.snapshot?.itemsById).toEqual({});
  });

  it("refreshes the cumulative byte baseline after non-timeline updates", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshotNearByteLimit(50_000);
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: initial,
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(
      store.apply(
        envelope(2, {
          type: "draft_changed",
          generation: "projection-1",
          draft: {
            text: "d".repeat(30_000),
            contextExcerpts: [],
            attachments: [],
            taskReferences: [],
            revision: 1,
          },
        }),
      ),
    ).toEqual({ kind: "applied" });

    expect(
      store.apply(
        envelope(3, {
          type: "item_upsert",
          generation: "projection-1",
          item: {
            id: "cumulative-overflow",
            turnId: "turn-1",
            kind: "assistant_message",
            status: "streaming",
            revision: 0,
            markdown: { text: "x".repeat(30_000) },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "timeline_window_limit_exceeded",
    });
    expect(store.state.authoritative).toBe(false);
    expect(store.state.snapshot?.itemsById).toEqual({});
  });

  it("counts history additions without reserializing retained message text", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshot();
    const retained = {
      id: "retained", turnId: "turn-1", kind: "assistant_message" as const,
      status: "streaming" as const, revision: 0,
      markdown: { text: "retained text ".repeat(160_000) },
    };
    initial.itemsById = { retained };
    initial.turnsById = { "turn-1": { ...initial.turnsById["turn-1"]!, orderedItemIds: [retained.id] } };
    store.apply(envelope(0, { type: "snapshot", generation: "projection-1", snapshot: initial }));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(store.apply(envelope(1, { type: "history_prepend", generation: "projection-1", page: {
        orderedTurnIds: ["older"], forkSource: initial.forkSource,
        forksByTurnId: { older: { sourceTurnId: "older", expectedTurnRevision: 0, available: false,
          unavailableReason: { text: "Unavailable" } } },
        turnsById: { older: { id: "older", revision: 0, status: "completed", orderedItemIds: ["older-item"] } },
        itemsById: { "older-item": { id: "older-item", turnId: "older", kind: "assistant_message", status: "completed",
          revision: 0, markdown: { text: 'Older 雪🙂"\\\n' } } },
      } }))).toEqual({ kind: "applied" });
      const serializedCharacters = stringify.mock.results.reduce((sum, result) =>
        sum + (result.type === "return" && typeof result.value === "string" ? result.value.length : 0), 0);
      expect(serializedCharacters).toBeLessThan(20_000);
    } finally { stringify.mockRestore(); }
    expect(store.state.snapshot?.orderedTurnIds).toEqual(["older", "turn-1"]);
    expect(store.state.snapshot?.itemsById.retained).toEqual(retained);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
    store.apply(envelope(2, { type: "fork_source_state_changed", generation: "projection-1", forkSource: {
      selectedCompletedTurn: { available: true }, latestProviderSnapshot: { available: true },
    } }));
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
  });

  it("keeps a backend's per-turn fork unavailability when fork availability changes", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshot();
    const reason = { text: "Claude cannot fork exactly after this turn." };
    initial.turnsById = {
      "turn-1": { ...initial.turnsById["turn-1"]!, status: "completed", endedBy: "agent_settled" },
      "turn-2": { id: "turn-2", revision: 0, status: "completed", endedBy: "agent_settled", forkUnavailableReason: reason, orderedItemIds: [] },
    };
    initial.orderedTurnIds = ["turn-1", "turn-2"];
    initial.forksByTurnId = {
      ...initial.forksByTurnId,
      "turn-2": { sourceTurnId: "turn-2", expectedTurnRevision: 0, available: false, unavailableReason: reason },
    };
    store.apply(envelope(0, { type: "snapshot", generation: "projection-1", snapshot: initial }));
    store.apply(envelope(1, { type: "fork_source_state_changed", generation: "projection-1", forkSource: {
      selectedCompletedTurn: { available: true }, latestProviderSnapshot: { available: true },
    } }));
    const forks = store.state.snapshot!.forksByTurnId;
    expect(forks["turn-1"]).toMatchObject({ available: true });
    expect(forks["turn-2"]).toEqual({ sourceTurnId: "turn-2", expectedTurnRevision: 0, available: false, unavailableReason: reason });
  });

  it("keeps exact metadata byte counts across growth, shrinkage and optional fields", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const initial = {
      ...base,
      turnsById: {
        "turn-1": { ...base.turnsById["turn-1"]!, orderedItemIds: ["item-1"] },
      },
      itemsById: {
        "item-1": {
          id: "item-1",
          turnId: "turn-1",
          kind: "assistant_message" as const,
          status: "streaming" as const,
          revision: 0,
          markdown: { text: "Retained history. ".repeat(1_000) },
        },
      },
    };
    expect(store.apply(envelope(0, {
      type: "snapshot", generation: "projection-1", snapshot: initial,
    }))).toEqual({ kind: "applied" });
    let sequence = 0;
    const applyMetadata = (event: ThreadEventEnvelope["event"]): void => {
      const previous = store.state.snapshot!;
      const previousJson = JSON.stringify(previous);
      expect(store.apply(envelope(++sequence, event))).toEqual({ kind: "applied" });
      expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
      expect(JSON.stringify(previous)).toBe(previousJson);
      expect(store.state.snapshot?.itemsById).toBe(previous.itemsById);
      expect(store.state.snapshot?.turnsById).toBe(previous.turnsById);
    };
    const escapedText = '雪🙂"\\\n\u0000\ud800';
    applyMetadata({
      type: "draft_changed", generation: "projection-1",
      draft: { ...base.draft, text: escapedText, revision: 1 },
    });
    const grownBytes = store.snapshotSerializedBytes;
    applyMetadata({
      type: "draft_changed", generation: "projection-1",
      draft: { ...base.draft, text: "", revision: 2 },
    });
    expect(store.snapshotSerializedBytes).toBeLessThan(grownBytes);
    applyMetadata({ type: "run_state", generation: "projection-1", state: "idle" });
    expect(store.state.snapshot?.activeTurnId).toBeUndefined();
    applyMetadata({
      type: "run_state", generation: "projection-1", state: "running", activeTurnId: "turn-1",
    });
    applyMetadata({
      type: "usage_changed", generation: "projection-1",
      usage: { context: { usedTokens: 99, windowTokens: 100_000 }, counters: { assistantMessages: 999 } },
    });
    applyMetadata({ type: "usage_changed", generation: "projection-1", usage: {} });
    applyMetadata({
      type: "application_state_changed", generation: "projection-1",
      state: {
        ...applicationState(store.state.snapshot!),
        recovery: {
          kind: "operation_uncertain", operationCategory: "delivery",
          diagnostic: { text: escapedText }, submissionMayHaveBeenAccepted: true, recoverable: true,
        },
        workspace: { ...base.workspace, displayPath: { text: escapedText } },
      },
    });
    expect(store.state.snapshot?.recovery).toBeDefined();
    const { recovery: _recovery, ...withoutRecovery } = applicationState(store.state.snapshot!);
    applyMetadata({
      type: "application_state_changed", generation: "projection-1", state: withoutRecovery,
    });
    expect(store.state.snapshot?.recovery).toBeUndefined();
  });

  it("keeps exact bytes when an interaction receipt removes open metadata", () => {
    const store = new NormalizedThreadStore();
    expect(store.apply(envelope(0, {
      type: "snapshot", generation: "projection-1", snapshot: snapshot(),
    }))).toEqual({ kind: "applied" });
    const initialBytes = store.snapshotSerializedBytes;
    expect(store.apply(envelope(1, {
      type: "interaction_opened", generation: "projection-1",
      interaction: {
        id: "interaction-1", threadId: "thread-1", kind: "confirmation",
        sourceLabel: { text: "Backend" }, title: { text: "Confirm 雪" },
        message: { text: 'Continue "operation"?' }, openedAt: "2026-07-30T15:00:00.000Z",
        secret: false, destructive: false, cancellable: true,
      },
    }))).toEqual({ kind: "applied" });
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
    const prior = store.state.snapshot!;
    store.applyInteractionResolution("interaction-1");
    expect(store.state.snapshot?.interactions).toEqual([]);
    expect(prior.interactions).toHaveLength(1);
    expect(store.snapshotSerializedBytes).toBe(initialBytes);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
    expect(store.replayCursor).toBe(`${hub}.1`);
  });

  it("accepts metadata exactly at the byte limit and rejects one extra UTF-8 byte", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshotNearByteLimit(3);
    expect(store.apply(envelope(0, {
      type: "snapshot", generation: "projection-1", snapshot: initial,
    }))).toEqual({ kind: "applied" });
    expect(store.apply(envelope(1, {
      type: "draft_changed", generation: "projection-1",
      draft: { ...initial.draft, text: "雪", revision: 1 },
    }))).toEqual({ kind: "applied" });
    expect(store.snapshotSerializedBytes).toBe(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
    expect(store.apply(envelope(2, {
      type: "draft_changed", generation: "projection-1",
      draft: { ...initial.draft, text: "", revision: 2 },
    }))).toEqual({ kind: "applied" });
    const accepted = store.state.snapshot;
    const acceptedBytes = store.snapshotSerializedBytes;
    expect(acceptedBytes).toBe(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - 3);
    expect(store.apply(envelope(3, {
      type: "draft_changed", generation: "projection-1",
      draft: { ...initial.draft, text: "🙂", revision: 3 },
    }))).toEqual({ kind: "resnapshot_required", reason: "snapshot_window_limit_exceeded" });
    expect(store.state.snapshot).toBe(accepted);
    expect(store.snapshotSerializedBytes).toBe(acceptedBytes);
    expect(store.state.authoritative).toBe(false);
    expect(store.replayCursor).toBeUndefined();
  });

  it("applies a complete application-state delta including workspace moves and removals", () => {
    const store = new NormalizedThreadStore();
    const initial = {
      ...snapshot(),
      recovery: {
        kind: "operation_uncertain" as const,
        operationCategory: "delivery" as const,
        diagnostic: { text: "Delivery may have completed." },
        submissionMayHaveBeenAccepted: true,
        recoverable: true,
      },
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      }),
    );
    const { recovery: _removedRecovery, ...withoutRecovery } = initial;
    const moved = {
      ...withoutRecovery,
      thread: {
        ...initial.thread,
        workspaceId: "workspace-2",
        threadRevision: initial.thread.threadRevision + 1,
      },
      workspace: {
        ...initial.workspace,
        id: "workspace-2",
        displayPath: { text: "/workspace/src" },
      },
      composerCommands: [],
      providerFeatures: [],
    };

    expect(
      store.apply(
        envelope(2, {
          type: "application_state_changed",
          generation: "projection-1",
          state: applicationState(moved),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.workspace.displayPath.text).toBe(
      "/workspace/src",
    );
    expect(store.state.snapshot?.thread.workspaceId).toBe("workspace-2");
    expect(store.state.snapshot?.recovery).toBeUndefined();
    expect(store.state.snapshot?.orderedTurnIds).toEqual(["turn-1"]);
  });

  it("rejects application state with contradictory provider feature revisions", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: base,
      }),
    );
    const ref = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const state = applicationState(base);

    expect(
      store.apply(
        envelope(2, {
          type: "application_state_changed",
          generation: "projection-1",
          state: {
            ...state,
            capabilities: {
              ...state.capabilities,
              providerFeatures: [
                {
                  ref,
                  revision: 2,
                  label: { text: "Goal" },
                  availability: "available",
                  operations: [],
                  presentationSlots: ["composer_action"],
                },
              ],
            },
            providerFeatures: [{ ref, revision: 1, state: null }],
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "invalid_thread_event",
    });
  });

  it("requires monotonic agent-tool policy revisions in application state", () => {
    const store = new NormalizedThreadStore();
    const base = {
      ...snapshot(),
      agentTools: {
        ...snapshot().agentTools,
        revision: 4,
      },
    };
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: base,
        }),
      ),
    ).toEqual({ kind: "applied" });

    expect(
      store.apply(
        envelope(2, {
          type: "application_state_changed",
          generation: "projection-1",
          state: {
            ...applicationState(base),
            agentTools: { ...base.agentTools, revision: 3 },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "agent_tool_policy_revision_regressed",
    });
  });

  it("rejects a conflicting agent-tool policy at the same revision", () => {
    const store = new NormalizedThreadStore();
    const base = {
      ...snapshot(),
      agentTools: {
        ...snapshot().agentTools,
        revision: 4,
      },
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: base,
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "application_state_changed",
          generation: "projection-1",
          state: {
            ...applicationState(base),
            agentTools: { ...base.agentTools, enabled: true },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "agent_tool_policy_revision_conflict",
    });
  });

  it.each([
    {
      label: "thread revision regression",
      change: (base: NormalizedThreadSnapshot) => ({
        thread: { ...base.thread, threadRevision: 1 },
      }),
      reason: "thread_revision_regressed",
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
      reason: "draft_revision_regressed",
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
      reason: "draft_revision_conflict",
    },
    {
      label: "settings revision regression",
      change: () => ({ settings: { revision: 1, values: [] } }),
      reason: "settings_revision_regressed",
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
      reason: "settings_revision_conflict",
    },
  ])("requires monotonic $label in application state", ({ change, reason }) => {
    const store = new NormalizedThreadStore();
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
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: base,
      }),
    );
    expect(
      store.apply(
        envelope(2, {
          type: "application_state_changed",
          generation: "projection-1",
          state: { ...applicationState(base), ...change(base) } as never,
        }),
      ),
    ).toEqual({ kind: "resnapshot_required", reason });
  });

  it("applies provider feature capability and state transitions atomically", () => {
    const goalRef = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const goalCapability = (revision: number) => ({
      ref: goalRef,
      revision,
      label: { text: "Goal" },
      availability: "available" as const,
      operations: [],
      presentationSlots: ["composer_action" as const],
    });
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
    const store = new NormalizedThreadStore();
    const base = snapshot();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: {
          ...base,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [goalCapability(1)],
          },
          providerFeatures: [goalEnvelope(1, "active")],
        },
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 0,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [goalCapability(2)],
          },
          providerFeatures: [goalEnvelope(2, "complete")],
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.providerFeatures).toEqual([
      goalEnvelope(2, "complete"),
    ]);

    expect(
      store.apply(
        envelope(3, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 0,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [
              {
                ...goalCapability(2),
                availability: "read_only",
                unavailableReason: { text: "The thread is currently busy." },
              },
            ],
          },
          providerFeatures: [goalEnvelope(2, "complete")],
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(
      store.state.snapshot?.capabilities.providerFeatures[0],
    ).toMatchObject({ availability: "read_only", revision: 2 });
    expect(
      store.apply(
        envelope(4, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 0,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [goalCapability(2)],
          },
          providerFeatures: [goalEnvelope(2, "complete")],
        }),
      ),
    ).toEqual({ kind: "applied" });

    // A regressed feature revision fails closed into a resnapshot.
    expect(
      store.apply(
        envelope(5, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 0,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [goalCapability(1)],
          },
          providerFeatures: [goalEnvelope(1, "active")],
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "provider_feature_revision_regressed",
    });
  });

  it("advances the application thread revision with capability changes", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: {
          ...base,
          thread: { ...base.thread, threadRevision: 2 },
        },
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 4,
          capabilities: base.capabilities,
          providerFeatures: base.providerFeatures,
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.thread.threadRevision).toBe(4);

    const afterCapabilities = store.state.snapshot!;
    expect(
      store.apply(
        envelope(3, {
          type: "application_state_changed",
          generation: "projection-1",
          state: {
            ...applicationState(afterCapabilities),
            draft: {
              text: "saved",
              contextExcerpts: [],
              attachments: [],
              taskReferences: [],
              revision: 1,
            },
          },
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.thread.threadRevision).toBe(4);
    expect(store.state.snapshot?.draft).toEqual({
      text: "saved",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    });

    expect(
      store.apply(
        envelope(4, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 3,
          capabilities: base.capabilities,
          providerFeatures: base.providerFeatures,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "thread_revision_regressed",
    });
  });

  it("accepts application-owned operation narrowing at one feature revision", () => {
    const ref = { featureId: "test.mixed", schemaVersion: 1 } as const;
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
    const capability = (actionIds: readonly string[]) => ({
      ref,
      revision: 3,
      label: { text: "Mixed feature" },
      availability: "available" as const,
      operations: actionIds.map(operation),
      presentationSlots: ["composer_action" as const],
    });
    const featureState = {
      ref,
      revision: 3,
      state: { kind: "object" as const, entries: [] },
    };
    const base = snapshot();
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: {
          ...base,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [capability(["observe", "reconfigure"])],
          },
          providerFeatures: [featureState],
        },
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 1,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [capability(["observe"])],
          },
          providerFeatures: [featureState],
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(
      store.state.snapshot?.capabilities.providerFeatures[0]?.operations,
    ).toEqual([expect.objectContaining({ actionId: "observe" })]);

    expect(
      store.apply(
        envelope(3, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 2,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [capability(["observe", "reconfigure"])],
          },
          providerFeatures: [featureState],
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(
      store.apply(
        envelope(4, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 3,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [capability(["reconfigure", "observe"])],
          },
          providerFeatures: [featureState],
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "provider_feature_revision_conflict",
    });
  });

  it("rejects provider-owned feature changes that reuse a revision", () => {
    const ref = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const capability: NormalizedThreadSnapshot["capabilities"]["providerFeatures"][number] =
      {
        ref,
        revision: 2,
        label: { text: "Goal" },
        availability: "available" as const,
        operations: [],
        presentationSlots: ["composer_action" as const],
      };
    const state: NormalizedThreadSnapshot["providerFeatures"][number] = {
      ref,
      revision: 2,
      state: {
        kind: "object" as const,
        entries: [{ key: { text: "state" }, value: { text: "active" } }],
      },
    };
    const base = snapshot();
    const applyConflict = (
      nextCapability: typeof capability,
      nextState: typeof state = state,
    ) => {
      const store = new NormalizedThreadStore();
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: {
            ...base,
            capabilities: {
              ...base.capabilities,
              providerFeatures: [capability],
            },
            providerFeatures: [state],
          },
        }),
      );
      return store.apply(
        envelope(2, {
          type: "capabilities_changed",
          generation: "projection-1",
          threadRevision: 0,
          capabilities: {
            ...base.capabilities,
            providerFeatures: [nextCapability],
          },
          providerFeatures: [nextState],
        }),
      );
    };
    const conflict = {
      kind: "resnapshot_required",
      reason: "provider_feature_revision_conflict",
    } as const;

    expect(
      applyConflict({ ...capability, label: { text: "Changed goal" } }),
    ).toEqual(conflict);
    expect(
      applyConflict({
        ...capability,
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
      }),
    ).toEqual(conflict);
    expect(
      applyConflict({
        ...capability,
        availability: "unavailable",
        unavailableReason: { text: "The provider removed the feature." },
      }),
    ).toEqual(conflict);
    expect(
      applyConflict(capability, {
        ...state,
        state: {
          kind: "object",
          entries: [{ key: { text: "state" }, value: { text: "complete" } }],
        },
      }),
    ).toEqual(conflict);
  });

  it("keeps duplicated thread run and queue summaries consistent", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "run_state",
          generation: "projection-1",
          state: "stopping",
          activeTurnId: "turn-1",
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot).toMatchObject({
      runState: "stopping",
      thread: { runState: "stopping" },
    });

    const queued = {
      id: "queued-1",
      deliveryOperationId: "queued-operation-1",
      resolvedDeliveryMode: "queue" as const,
      sequence: 1,
      origin: "user",
      isHead: true,
      state: "pending",
      preview: { text: "Queued input" },
      attachmentCount: 0,
      taskCount: 0,
      createdAt: "2026-07-30T15:00:00.000Z",
    } as const;
    expect(
      store.apply(
        envelope(3, {
          type: "queue_changed",
          generation: "projection-1",
          threadRevision: 1,
          items: [queued],
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot).toMatchObject({
      queue: [queued],
      thread: { queuedInputCount: 1 },
    });

    expect(
      store.apply(
        envelope(4, {
          type: "thread_changed",
          generation: "projection-1",
          thread: {
            ...snapshot().thread,
            threadRevision: 1,
            runState: "idle",
            queuedInputCount: 0,
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "thread_derived_state_conflict",
    });
  });

  it("orders queue results and events by thread revision", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );
    const queued = [
      {
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
        createdAt: "2026-07-30T15:00:00.000Z",
      },
    ];
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
      }),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.thread.threadRevision).toBe(2);
    expect(store.snapshotSerializedBytes).toBe(
      serializedUtf8Bytes(store.state.snapshot),
    );
    expect(
      store.apply(
        envelope(2, {
          type: "queue_changed",
          generation: "projection-1",
          threadRevision: 1,
          items: [],
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(store.state.snapshot?.queue).toEqual(queued);
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
      }),
    ).toEqual({ kind: "ignored" });
    const priorDraft = store.state.snapshot!.draft;
    const restoredDraft = {
      ...priorDraft,
      text: "Restored queued input",
      revision: priorDraft.revision + 1,
    };
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
        draft: restoredDraft,
      }),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.draft).toEqual(restoredDraft);
    expect(store.snapshotSerializedBytes).toBe(
      serializedUtf8Bytes(store.state.snapshot),
    );
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
        draft: priorDraft,
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
        draft: { ...restoredDraft, text: "Conflicting restored input" },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "draft_revision_conflict",
    });
  });

  it("merges delayed application metadata after two newer queue receipts without reviving deleted inputs", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const initial = {
      ...base,
      thread: { ...base.thread, threadRevision: 21, queuedInputCount: 3 },
      queue: [
        queuedInput("alpha", 1, true),
        queuedInput("bravo", 2, false),
        queuedInput("charlie", 3, false),
      ],
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: initial,
    }));
    const queue22 = [queuedInput("bravo", 2, true), initial.queue[2]!];
    const queue23 = [queuedInput("charlie", 3, true)];
    for (const [threadRevision, queue] of [
      [22, queue22],
      [23, queue23],
    ] as const) {
      expect(store.applyQueueMutationProjection({
        generation: "projection-1", threadRevision, queue,
      })).toEqual({ kind: "applied" });
    }
    expect(store.apply(envelope(2, {
      type: "queue_changed", generation: "projection-1",
      threadRevision: 22, items: queue22,
    }))).toEqual({ kind: "ignored" });

    const state22 = {
      ...applicationState(initial),
      thread: {
        ...initial.thread,
        threadRevision: 22,
        queuedInputCount: 2,
        inventoryRevision: 1,
        title: { text: "Updated while cancelling" },
      },
      workspace: { ...initial.workspace, label: { text: "Renamed workspace" } },
      settings: { ...initial.settings, revision: 1 },
      agentTools: { ...initial.agentTools, revision: 1, enabled: true },
      capabilities: { ...initial.capabilities, revision: "cap-2" },
      queue: queue22,
    };
    expect(store.apply(envelope(3, {
      type: "application_state_changed", generation: "projection-1", state: state22,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot).toMatchObject({
      thread: {
        threadRevision: 23,
        queuedInputCount: 1,
        inventoryRevision: 1,
        title: state22.thread.title,
      },
      workspace: state22.workspace,
      settings: state22.settings,
      agentTools: state22.agentTools,
      capabilities: state22.capabilities,
      queue: queue23,
    });
    expect(store.replayCursor).toBe(`${hub}.3`);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));

    expect(store.apply(envelope(4, {
      type: "queue_changed", generation: "projection-1",
      threadRevision: 23, items: queue23,
    }))).toEqual({ kind: "ignored" });
    expect(store.apply(envelope(5, {
      type: "application_state_changed", generation: "projection-1",
      state: {
        ...state22,
        thread: { ...state22.thread, threadRevision: 23, queuedInputCount: 1 },
        queue: queue23,
      },
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.queue).toEqual(queue23);
    expect(store.state.snapshot?.settings).toEqual(state22.settings);
  });

  it("retains a restored draft through delayed application and draft events after the queue receipt is confirmed", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const initial = {
      ...base,
      thread: { ...base.thread, threadRevision: 21, queuedInputCount: 1 },
      draft: { ...base.draft, revision: 4, text: "Before restore" },
      queue: [queuedInput("restore", 1, true)],
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: initial,
    }));
    const restored = { ...initial.draft, revision: 6, text: "Restored queued input" };
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 23, queue: [], draft: restored,
    });
    const olderDraft = { ...initial.draft, revision: 5, text: "Before restore completed" };
    const state22 = {
      ...applicationState(initial),
      thread: { ...initial.thread, threadRevision: 22 },
      draft: olderDraft,
    };
    expect(store.apply(envelope(2, {
      type: "application_state_changed", generation: "projection-1", state: state22,
    }))).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.draft).toEqual(restored);
    expect(store.state.snapshot?.queue).toEqual([]);

    store.apply(envelope(3, {
      type: "queue_changed", generation: "projection-1", threadRevision: 23, items: [],
    }));
    expect(store.apply(envelope(4, {
      type: "draft_changed", generation: "projection-1", draft: olderDraft,
    })).kind).not.toBe("resnapshot_required");
    expect(store.state.snapshot?.draft).toEqual(restored);
    expect(store.state.authoritative).toBe(true);

    expect(store.apply(envelope(5, {
      type: "draft_changed", generation: "projection-1", draft: restored,
    })).kind).not.toBe("resnapshot_required");
    expect(store.apply(envelope(6, {
      type: "application_state_changed", generation: "projection-1",
      state: {
        ...state22,
        thread: { ...state22.thread, threadRevision: 23, queuedInputCount: 0 },
        draft: restored,
        queue: [],
      },
    }))).toEqual({ kind: "applied" });
    const edited = { ...restored, revision: 7, text: "Edited after restore" };
    expect(store.apply(envelope(7, {
      type: "draft_changed", generation: "projection-1", draft: edited,
    }))).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft).toEqual(edited);
    expect(store.snapshotSerializedBytes).toBe(serializedUtf8Bytes(store.state.snapshot));
  });

  it.each(["thread_changed", "application_state_changed"] as const)(
    "rejects actual %s revision regression while a newer queue receipt is outstanding",
    (type) => {
      const store = new NormalizedThreadStore();
      const base = snapshot();
      const initial = { ...base, thread: { ...base.thread, threadRevision: 20 } };
      store.apply(envelope(1, {
        type: "snapshot", generation: "projection-1", snapshot: initial,
      }));
      store.applyQueueMutationProjection({
        generation: "projection-1", threadRevision: 25, queue: [],
      });
      const update = (sequence: number, threadRevision: number) => {
        const thread = { ...initial.thread, threadRevision };
        return store.apply(envelope(sequence, type === "thread_changed"
          ? { type, generation: "projection-1", thread }
          : {
              type, generation: "projection-1",
              state: { ...applicationState(initial), thread },
            }));
      };
      expect(update(2, 22)).toEqual({ kind: "applied" });
      expect(store.state.snapshot?.thread.threadRevision).toBe(25);
      expect(update(3, 21)).toEqual({
        kind: "resnapshot_required", reason: "thread_revision_regressed",
      });
      expect(store.state.authoritative).toBe(false);
    },
  );

  it.each(["draft_changed", "application_state_changed"] as const)(
    "rejects actual %s draft regression while a newer restored draft receipt is outstanding",
    (type) => {
      const store = new NormalizedThreadStore();
      const base = snapshot();
      const initial = {
        ...base,
        thread: { ...base.thread, threadRevision: 20 },
        draft: { ...base.draft, revision: 2 },
      };
      store.apply(envelope(1, {
        type: "snapshot", generation: "projection-1", snapshot: initial,
      }));
      store.applyQueueMutationProjection({
        generation: "projection-1", threadRevision: 25, queue: [],
        draft: { ...initial.draft, revision: 6, text: "Restored" },
      });
      const update = (sequence: number, draftRevision: number) => {
        const draft = { ...initial.draft, revision: draftRevision };
        return store.apply(envelope(sequence, type === "draft_changed"
          ? { type, generation: "projection-1", draft }
          : {
              type, generation: "projection-1",
              state: {
                ...applicationState(initial),
                thread: { ...initial.thread, threadRevision: 20 + sequence },
                draft,
              },
            }));
      };
      expect(update(2, 4).kind).not.toBe("resnapshot_required");
      expect(store.state.snapshot?.draft.revision).toBe(6);
      expect(update(3, 3)).toEqual({
        kind: "resnapshot_required", reason: "draft_revision_regressed",
      });
      expect(store.state.authoritative).toBe(false);
    },
  );

  it("confirms a queue receipt after capabilities reach its revision and still rejects a contradictory stream queue", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const initial = {
      ...base,
      thread: { ...base.thread, threadRevision: 21, queuedInputCount: 2 },
      queue: [queuedInput("removed", 1, true), queuedInput("retained", 2, false)],
    };
    store.apply(envelope(1, {
      type: "snapshot", generation: "projection-1", snapshot: initial,
    }));
    const remaining = [queuedInput("retained", 2, true)];
    store.applyQueueMutationProjection({
      generation: "projection-1", threadRevision: 23, queue: remaining,
    });
    expect(store.apply(envelope(2, {
      type: "capabilities_changed", generation: "projection-1", threadRevision: 23,
      capabilities: initial.capabilities, providerFeatures: initial.providerFeatures,
    }))).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.queue).toEqual(remaining);
    expect(store.apply(envelope(3, {
      type: "queue_changed", generation: "projection-1", threadRevision: 23, items: remaining,
    }))).toEqual({ kind: "ignored" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.queue).toEqual(remaining);
    expect(store.apply(envelope(4, {
      type: "application_state_changed", generation: "projection-1",
      state: {
        ...applicationState(initial),
        thread: { ...initial.thread, threadRevision: 23, queuedInputCount: 0 },
        queue: [],
      },
    }))).toEqual({ kind: "resnapshot_required", reason: "queue_revision_conflict" });
  });

  it.each(["queue_changed", "application_state_changed"] as const)(
    "rejects %s contradicting a queue receipt at the same revision",
    (type) => {
      const store = new NormalizedThreadStore();
      const initial = snapshot();
      store.apply(envelope(1, {
        type: "snapshot", generation: "projection-1", snapshot: initial,
      }));
      store.applyQueueMutationProjection({
        generation: "projection-1", threadRevision: 23,
        queue: [queuedInput("retained", 1, true)],
      });
      store.apply(envelope(2, {
        type: "capabilities_changed", generation: "projection-1", threadRevision: 23,
        capabilities: initial.capabilities, providerFeatures: initial.providerFeatures,
      }));
      expect(store.apply(envelope(3, type === "queue_changed"
        ? { type, generation: "projection-1", threadRevision: 23, items: [] }
        : {
            type, generation: "projection-1",
            state: {
              ...applicationState(initial),
              thread: { ...initial.thread, threadRevision: 23 },
            },
          }))).toEqual({
        kind: "resnapshot_required", reason: "queue_revision_conflict",
      });
    },
  );

  it.each(["draft_changed", "application_state_changed"] as const)(
    "rejects %s contradicting a restored draft receipt at the same revision",
    (type) => {
      const store = new NormalizedThreadStore();
      const initial = snapshot();
      store.apply(envelope(1, {
        type: "snapshot", generation: "projection-1", snapshot: initial,
      }));
      store.applyQueueMutationProjection({
        generation: "projection-1", threadRevision: 23, queue: [],
        draft: { ...initial.draft, revision: 6, text: "Restored" },
      });
      const contradictoryDraft = { ...initial.draft, revision: 6, text: "Conflicting" };
      expect(store.apply(envelope(2, type === "draft_changed"
        ? { type, generation: "projection-1", draft: contradictoryDraft }
        : {
            type, generation: "projection-1",
            state: {
              ...applicationState(initial),
              thread: { ...initial.thread, threadRevision: 23 },
              draft: contradictoryDraft,
            },
          }))).toEqual({
        kind: "resnapshot_required", reason: "draft_revision_conflict",
      });
    },
  );

  it("rejects a contradictory queue receipt at the same thread revision", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );
    const queued = [
      {
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
        createdAt: "2026-07-30T15:00:00.000Z",
      },
    ];
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: queued,
      }),
    ).toEqual({ kind: "applied" });
    expect(
      store.applyQueueMutationProjection({
        generation: "projection-1",
        threadRevision: 2,
        queue: [],
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "queue_revision_conflict",
    });
  });

  it("rejects snapshots with contradictory duplicated thread state", () => {
    const store = new NormalizedThreadStore();
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: {
            ...snapshot(),
            thread: { ...snapshot().thread, queuedInputCount: 1 },
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "invalid_thread_event",
    });
  });

  it("rejects non-canonical and unsafe transport sequences", () => {
    const store = new NormalizedThreadStore();
    const event = {
      projectionGeneration: "projection-1",
      event: {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      },
    } as const;
    expect(store.apply({ ...event, eventId: `${hub}.01` })).toMatchObject({
      kind: "resnapshot_required",
      reason: "invalid_thread_event",
    });
    expect(
      store.apply({
        ...event,
        eventId: `${hub}.999999999999999999999`,
      }),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "invalid_thread_event",
    });
  });

  it("rejects thread summary revision regression", () => {
    const store = new NormalizedThreadStore();
    const base = snapshot();
    const initial: NormalizedThreadSnapshot = {
      ...base,
      thread: {
        ...base.thread,
        inventoryRevision: 2,
        threadRevision: 3,
      },
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      }),
    );
    expect(
      store.apply(
        envelope(2, {
          type: "thread_changed",
          generation: "projection-1",
          thread: {
            ...initial.thread,
            inventoryRevision: 1,
          },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "thread_revision_regressed",
    });
  });

  it("accepts a reused anchor snapshot after invalidation resets the cursor", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      expect(
        store.apply(
          envelope(sequence, {
            type: "usage_changed",
            generation: "projection-1",
            usage: {},
          }),
        ),
      ).toEqual({ kind: "applied" });
    }
    expect(
      store.apply(
        envelope(10, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "transport_sequence_gap",
    });
    expect(store.state.authoritative).toBe(false);

    // The resubscribed stream reuses the retained authoritative anchor at an
    // OLDER transport sequence than the discarded projection's cursor. The
    // replacement is a new baseline and must apply anyway.
    expect(
      store.apply(
        envelope(1, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(
      store.apply(
        envelope(2, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toEqual({ kind: "applied" });
  });

  it("requires resnapshot on transport gaps, generation mismatch, and conflicts", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );
    expect(
      store.apply(
        envelope(3, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "transport_sequence_gap",
    });

    const replacement = envelope(10, {
      type: "snapshot",
      generation: "projection-2",
      snapshot: snapshot(),
    });
    expect(store.apply(replacement)).toEqual({ kind: "applied" });
    expect(
      store.apply(
        envelope(11, {
          type: "turn_upsert",
          generation: "projection-1",
          turn: snapshot().turnsById["turn-1"]!,
          fork: snapshot().forksByTurnId["turn-1"]!,
        }),
      ),
    ).toMatchObject({ kind: "resnapshot_required" });
  });

  it("applies application-authoritative positive fork-source transitions", () => {
    const store = new NormalizedThreadStore();
    const { activeTurnId: _activeTurnId, ...base } = snapshot();
    const initial: NormalizedThreadSnapshot = {
      ...base,
      thread: { ...base.thread, runState: "idle" },
      runState: "idle",
      capabilities: { ...base.capabilities, runState: "idle" },
      turnsById: {
        "turn-1": {
          id: "turn-1",
          revision: 0,
          status: "completed",
          endedBy: "agent_settled",
          orderedItemIds: [],
        },
      },
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      }),
    );

    expect(
      store.apply(
        envelope(2, {
          type: "turn_upsert",
          generation: "projection-1",
          turn: { ...initial.turnsById["turn-1"]!, revision: 1 },
          fork: {
            sourceTurnId: "turn-1",
            expectedTurnRevision: 1,
            available: true,
          },
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.forksByTurnId["turn-1"]).toEqual({
      sourceTurnId: "turn-1",
      expectedTurnRevision: 1,
      available: false,
      unavailableReason: {
        text: "Forking is unavailable in this fixture.",
      },
    });

    expect(
      store.apply(
        envelope(3, {
          type: "fork_source_state_changed",
          generation: "projection-1",
          forkSource: {
            selectedCompletedTurn: { available: true },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: {
                text: "Provider snapshots are unavailable.",
              },
            },
          },
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.snapshot?.forkSource).toEqual({
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    });
    expect(store.state.snapshot?.forksByTurnId["turn-1"]).toEqual({
      sourceTurnId: "turn-1",
      expectedTurnRevision: 1,
      available: true,
    });
    expect(store.state.snapshot?.orderedTurnIds).toEqual(["turn-1"]);
    expect(store.state.snapshot?.history).toEqual(initial.history);
  });

  it("reapplies a reconnect snapshot at the invalidated cursor while ignoring ordinary duplicates and lower cursors", () => {
    const store = new NormalizedThreadStore();
    store.apply(
      envelope(4, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: snapshot(),
      }),
    );
    expect(
      store.apply(
        envelope(6, {
          type: "usage_changed",
          generation: "projection-1",
          usage: {},
        }),
      ),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "transport_sequence_gap",
    });
    expect(store.state.authoritative).toBe(false);

    const repaired = snapshot();
    repaired.draft = {
      text: "restored",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    };
    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "projection-1",
          snapshot: repaired,
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);
    expect(store.state.snapshot?.draft.text).toBe("restored");

    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "projection-stale",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(store.state.generation).toBe("projection-1");
    expect(store.state.snapshot?.draft.text).toBe("restored");

    expect(
      store.apply(
        envelope(4, {
          type: "usage_changed",
          generation: "projection-1",
          usage: { counters: { totalMessages: 10 } },
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(
      store.apply(
        envelope(3, {
          type: "snapshot",
          generation: "projection-old",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(store.state.generation).toBe("projection-1");
  });

  it("preserves usage until a newer usage event and rejects stale revisions", () => {
    const store = new NormalizedThreadStore();
    const initial = snapshot();
    initial.usage = {
      context: { usedTokens: 50, windowTokens: 100, percent: 50 },
    };
    store.apply(
      envelope(1, {
        type: "snapshot",
        generation: "projection-1",
        snapshot: initial,
      }),
    );
    store.apply(
      envelope(2, {
        type: "run_state",
        generation: "projection-1",
        state: "running",
        activeTurnId: "turn-1",
      }),
    );
    expect(store.state.snapshot?.usage).toEqual(initial.usage);

    store.apply(
      envelope(3, {
        type: "draft_changed",
        generation: "projection-1",
        draft: {
          text: "new",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 2,
        },
      }),
    );
    expect(
      store.apply(
        envelope(4, {
          type: "draft_changed",
          generation: "projection-1",
          draft: {
            text: "old",
            contextExcerpts: [],
            attachments: [],
            taskReferences: [],
            revision: 1,
          },
        }),
      ),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "draft_revision_regressed",
    });
  });
});
