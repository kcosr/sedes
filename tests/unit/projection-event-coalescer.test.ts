import { describe, expect, it } from "vitest";
import {
  ProjectionEventCoalescer,
  type ProjectionCoalescerOutput,
  type ProjectionEventClock,
  type ProjectionEventScheduledTask,
  type ProjectionEventScheduler,
} from "../../src/server/conversations/projection-event-coalescer.js";
import {
  DEFAULT_MAXIMUM_PENDING_PROJECTION_BYTES,
  DEFAULT_MAXIMUM_PENDING_PROJECTION_ITEMS,
} from "../../src/server/conversations/conversation-actor.js";
import type {
  ConversationItem,
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
} from "../../src/shared/protocol/conversation.js";

class FakeTime implements ProjectionEventClock, ProjectionEventScheduler {
  #now = 0;
  #nextId = 0;
  #tasks = new Map<
    number,
    { dueAt: number; callback: () => void; cancelled: boolean }
  >();

  now(): number {
    return this.#now;
  }

  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): ProjectionEventScheduledTask {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, {
      dueAt: this.#now + delayMilliseconds,
      callback,
      cancelled: false,
    });
    return {
      cancel: () => {
        const task = this.#tasks.get(id);
        if (task) task.cancelled = true;
      },
    };
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => !task.cancelled && task.dueAt <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (!next) break;
      const [id, task] = next;
      this.#tasks.delete(id);
      this.#now = task.dueAt;
      task.callback();
    }
    this.#now = target;
  }
}

const generation = "generation-1";

function assistant(
  id: string,
  revision: number,
  text: string,
  status: ConversationItem["status"] = "streaming",
): ConversationItem {
  return {
    id,
    turnId: "turn-1",
    kind: "assistant_message",
    status,
    revision,
    markdown: { text },
  };
}

function itemEvent(item: ConversationItem): NormalizedThreadEvent {
  return { type: "item_upsert", generation, item };
}

function turnEvent(
  orderedItemIds: readonly string[],
  revision = 1,
): NormalizedThreadEvent {
  return {
    type: "turn_upsert",
    generation,
    turn: {
      id: "turn-1",
      revision,
      status: "in_progress",
      orderedItemIds: [...orderedItemIds],
    },
    fork: {
      sourceTurnId: "turn-1",
      expectedTurnRevision: revision,
      available: false,
      unavailableReason: { text: "Forking is unavailable in this fixture." },
    },
  };
}

function snapshot(
  items: readonly ConversationItem[] = [],
): Extract<NormalizedThreadEvent, { type: "snapshot" }> {
  const value = {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Latest provider snapshot forking is unavailable in this fixture.",
        },
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
      label: { text: "Local" },
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
        orderedItemIds: items.map(({ id }) => id),
      },
    },
    itemsById: Object.fromEntries(items.map((item) => [item.id, item])),
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
      revision: "1",
      backend: { label: { text: "Agent" } },
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
  } satisfies NormalizedThreadSnapshot;
  return { type: "snapshot", generation, snapshot: value };
}

function harness(
  options: {
    maximumPendingItems?: number;
    maximumPendingBytes?: number;
  } = {},
) {
  const time = new FakeTime();
  const outputs: ProjectionCoalescerOutput[] = [];
  const coalescer = new ProjectionEventCoalescer({
    intervalMilliseconds: 100,
    maximumPendingItems: options.maximumPendingItems ?? 8,
    maximumPendingBytes: options.maximumPendingBytes ?? 100_000,
    emit: (output) => outputs.push(output),
    clock: time,
    scheduler: time,
  });
  return { time, outputs, coalescer };
}

function events(outputs: readonly ProjectionCoalescerOutput[]) {
  return outputs.flatMap((output) =>
    output.kind === "event" ? [output.event] : [],
  );
}

describe("ProjectionEventCoalescer", () => {
  it("uses the burst-tolerant actor defaults", () => {
    expect(DEFAULT_MAXIMUM_PENDING_PROJECTION_ITEMS).toBe(512);
    expect(DEFAULT_MAXIMUM_PENDING_PROJECTION_BYTES).toBe(16 * 1_024 * 1_024);
  });

  it("emits the first update immediately and retains only the latest full replacement", () => {
    const { coalescer, outputs, time } = harness();
    coalescer.accept(itemEvent(assistant("assistant-1", 0, "a")));
    coalescer.accept(itemEvent(assistant("assistant-1", 1, "ab")));
    coalescer.accept(itemEvent(assistant("assistant-1", 2, "abc")));

    expect(events(outputs)).toHaveLength(1);
    expect(coalescer.pendingCount).toBe(1);
    const retainedBytes = coalescer.pendingBytes;
    expect(retainedBytes).toBeGreaterThan(0);

    time.advance(99);
    expect(events(outputs)).toHaveLength(1);
    time.advance(1);
    expect(events(outputs)).toHaveLength(2);
    expect(events(outputs)[1]).toMatchObject({
      type: "item_upsert",
      item: { revision: 2, markdown: { text: "abc" } },
    });
    expect(coalescer.pendingCount).toBe(0);
    expect(coalescer.pendingBytes).toBe(0);
  });

  it("flushes a terminal replacement immediately and never emits the superseded pending update", () => {
    const { coalescer, outputs, time } = harness();
    coalescer.accept(itemEvent(assistant("assistant-1", 0, "a")));
    coalescer.accept(itemEvent(assistant("assistant-1", 1, "partial")));
    coalescer.accept(
      itemEvent(assistant("assistant-1", 2, "final", "completed")),
    );

    expect(events(outputs)).toHaveLength(2);
    expect(events(outputs)[1]).toMatchObject({
      item: { status: "completed", revision: 2, markdown: { text: "final" } },
    });
    time.advance(500);
    expect(events(outputs)).toHaveLength(2);
  });

  it("paces items independently and preserves pending-item insertion order on an explicit flush", () => {
    const { coalescer, outputs } = harness();
    coalescer.accept(itemEvent(assistant("one", 0, "one")));
    coalescer.accept(itemEvent(assistant("two", 0, "two")));
    coalescer.accept(itemEvent(assistant("two", 1, "two next")));
    coalescer.accept(itemEvent(assistant("one", 1, "one next")));
    coalescer.flush();

    expect(
      events(outputs)
        .filter((event) => event.type === "item_upsert")
        .map((event) => event.item.id),
    ).toEqual(["one", "two", "two", "one"]);
  });

  it("drops exact turn duplicates but emits ordering and revision changes", () => {
    const { coalescer, outputs } = harness();
    coalescer.accept(snapshot());
    coalescer.accept(turnEvent([], 0));
    coalescer.accept(turnEvent(["assistant-1"]));
    coalescer.accept(turnEvent(["assistant-1"]));
    coalescer.accept(turnEvent(["assistant-1"], 2));

    expect(events(outputs).map(({ type }) => type)).toEqual([
      "snapshot",
      "turn_upsert",
      "turn_upsert",
    ]);
    expect(events(outputs).at(-1)).toMatchObject({
      turn: { revision: 2 },
      fork: { expectedTurnRevision: 2 },
    });
  });

  it("invalidates regressed or conflicting turn revisions", () => {
    const regressed = harness();
    regressed.coalescer.accept(turnEvent([], 2));
    regressed.coalescer.accept(turnEvent(["assistant-1"], 1));
    expect(regressed.outputs.at(-1)).toMatchObject({
      kind: "resnapshot_required",
      reason: "turn_revision_regression",
    });

    const conflicting = harness();
    conflicting.coalescer.accept(turnEvent([], 2));
    conflicting.coalescer.accept(turnEvent(["assistant-1"], 2));
    expect(conflicting.outputs.at(-1)).toMatchObject({
      kind: "resnapshot_required",
      reason: "turn_revision_conflict",
    });
  });

  it("latches overflow, clears pending work, and emits one explicit resnapshot signal", () => {
    const { coalescer, outputs, time } = harness({
      maximumPendingItems: 1,
    });
    coalescer.accept(itemEvent(assistant("one", 0, "a")));
    coalescer.accept(itemEvent(assistant("two", 0, "b")));
    coalescer.accept(itemEvent(assistant("one", 1, "aa")));
    coalescer.accept(itemEvent(assistant("two", 1, "bb")));

    expect(outputs.at(-1)).toEqual({
      kind: "resnapshot_required",
      generation,
      reason: "coalescer_overflow",
    });
    expect(coalescer.invalidated).toBe(true);
    expect(coalescer.pendingCount).toBe(0);
    time.advance(500);
    expect(
      outputs.filter(({ kind }) => kind === "resnapshot_required"),
    ).toHaveLength(1);

    coalescer.accept(snapshot());
    expect(coalescer.invalidated).toBe(false);
    expect(events(outputs).at(-1)?.type).toBe("snapshot");
  });

  it("enforces the pending-byte limit when replacing retained state", () => {
    const { coalescer, outputs } = harness({ maximumPendingBytes: 200 });
    coalescer.accept(itemEvent(assistant("one", 0, "a")));
    coalescer.accept(itemEvent(assistant("one", 1, "x".repeat(1_000))));

    expect(outputs.at(-1)).toEqual({
      kind: "resnapshot_required",
      generation,
      reason: "coalescer_overflow",
    });
  });

  it("rejects generation changes, revision regression, and updates after terminal settlement", () => {
    const generationMismatch = harness();
    generationMismatch.coalescer.accept(itemEvent(assistant("one", 0, "a")));
    generationMismatch.coalescer.accept({
      ...itemEvent(assistant("one", 1, "b")),
      generation: "generation-2",
    });
    expect(generationMismatch.outputs.at(-1)).toMatchObject({
      kind: "resnapshot_required",
      reason: "projection_generation_mismatch",
    });

    const revision = harness();
    revision.coalescer.accept(itemEvent(assistant("one", 2, "a")));
    revision.coalescer.accept(itemEvent(assistant("one", 1, "b")));
    expect(revision.outputs.at(-1)).toMatchObject({
      kind: "resnapshot_required",
      reason: "item_revision_regression",
    });

    const terminal = harness();
    terminal.coalescer.accept(
      itemEvent(assistant("one", 0, "done", "completed")),
    );
    terminal.coalescer.accept(itemEvent(assistant("one", 1, "again")));
    expect(terminal.outputs.at(-1)).toMatchObject({
      kind: "resnapshot_required",
      reason: "item_updated_after_terminal",
    });
  });

  it("authoritative snapshots cancel stale timers and seed revision and turn deduplication", () => {
    const { coalescer, outputs, time } = harness();
    coalescer.accept(itemEvent(assistant("one", 0, "a")));
    coalescer.accept(itemEvent(assistant("one", 1, "pending")));
    coalescer.accept(snapshot([assistant("one", 8, "authoritative")]));
    coalescer.accept(turnEvent(["one"], 0));

    time.advance(500);
    expect(events(outputs).map(({ type }) => type)).toEqual([
      "item_upsert",
      "snapshot",
    ]);
    expect(coalescer.pendingCount).toBe(0);
  });

  it("validates limits and cancels scheduled work on disposal", () => {
    expect(
      () =>
        new ProjectionEventCoalescer({
          intervalMilliseconds: 0,
          maximumPendingItems: 1,
          maximumPendingBytes: 1,
          emit() {},
        }),
    ).toThrow("intervalMilliseconds");

    const { coalescer, outputs, time } = harness();
    coalescer.accept(itemEvent(assistant("one", 0, "a")));
    coalescer.accept(itemEvent(assistant("one", 1, "pending")));
    coalescer.dispose();
    time.advance(500);
    expect(events(outputs)).toHaveLength(1);
  });
});
