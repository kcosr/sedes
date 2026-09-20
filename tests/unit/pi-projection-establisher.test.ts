import { describe, expect, it } from "vitest";
import {
  sequencedBackendEventSchema,
  type BackendConversationSnapshot,
  type BackendItem,
  type SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import { PiProjectionEstablisher } from "../../src/server/backends/pi/pi-projection-establisher.js";

function emptySnapshot(): BackendConversationSnapshot {
  return {
    orderedBackendTurnIds: [],
    turnsById: {},
    itemsById: {},
    runState: "idle",
  };
}

function refreshEmptyProjection() {
  return {
    snapshot: emptySnapshot(),
    history: { operational: true as const },
  };
}

function assistantItem(
  markdown: string,
  status: BackendItem["status"] = "streaming",
): BackendItem {
  return {
    backendItemId: "assistant-live",
    backendTurnId: "turn-1",
    semanticKind: "assistant_message",
    status,
    sourceOrder: 1,
    startedAt: "2026-08-03T12:00:00.000Z",
    ...(status === "completed"
      ? { completedAt: "2026-08-03T12:00:01.000Z" }
      : {}),
    markdown: { text: markdown },
  } as BackendItem;
}

function toolItem(status: "streaming" | "completed"): BackendItem {
  return {
    backendItemId: "tool-live",
    backendTurnId: "turn-1",
    semanticKind: "tool",
    status,
    phase: status === "completed" ? "completed" : "preflight_or_executing",
    sourceOrder: 1,
    startedAt: "2026-08-03T12:00:00.000Z",
    ...(status === "completed"
      ? { completedAt: "2026-08-03T12:00:01.000Z" }
      : {}),
    toolName: { text: "read" },
    title: { text: "Read a file" },
    category: "filesystem",
  } as BackendItem;
}

function startTurn(establisher: PiProjectionEstablisher): void {
  establisher.publish({ type: "run_state_changed", state: "running" });
  establisher.publish({
    type: "turn_started",
    turn: {
      backendTurnId: "turn-1",
      completionCorrelations: ["submission-1"],
      status: "in_progress",
      startedAt: "2026-08-03T11:59:59.000Z",
      orderedBackendItemIds: [],
    },
  });
  establisher.publish({
    type: "run_state_changed",
    state: "running",
    activeBackendTurnId: "turn-1",
  });
}

function expectCanonical(events: readonly SequencedBackendEvent[]): void {
  for (const event of events) {
    expect(() => sequencedBackendEventSchema.parse(event)).not.toThrow();
  }
}

describe("Pi in-memory projection generation", () => {
  it("captures pre-establishment deltas atomically in the initial snapshot", async () => {
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: {
        operational: true,
        previousCursor: "pi-private-older-page",
      },
      refreshProjection: refreshEmptyProjection,
    });
    startTurn(establisher);
    establisher.publish({ type: "item_started", item: assistantItem("hel") });

    const projection = await establisher.establishProjection({
      signal: new AbortController().signal,
    });

    expect(projection.handleSequence).toBe(3);
    expect(projection.snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: "turn-1",
      orderedBackendTurnIds: ["turn-1"],
      itemsById: {
        "assistant-live": {
          status: "streaming",
          markdown: { text: "hel" },
        },
      },
    });
    expect(projection.history).toEqual({
      operational: true,
      previousCursor: "pi-private-older-page",
    });
  });

  it("buffers post-capture deltas and streams from exactly the next sequence", async () => {
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: refreshEmptyProjection,
    });
    startTurn(establisher);
    const projection = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    establisher.publish({ type: "item_started", item: assistantItem("a") });
    establisher.publish({ type: "item_updated", item: assistantItem("ab") });

    const received: SequencedBackendEvent[] = [];
    projection.subscribeFromNext((event) => received.push(event));
    establisher.publish({
      type: "item_completed",
      item: assistantItem("abc", "completed"),
    });

    expect(received.map(({ handleSequence }) => handleSequence)).toEqual([
      projection.handleSequence + 1,
      projection.handleSequence + 2,
      projection.handleSequence + 3,
    ]);
    expectCanonical(received);
  });

  it("preserves one item identity and order through terminal settlement", async () => {
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: refreshEmptyProjection,
    });
    startTurn(establisher);
    establisher.publish({ type: "item_started", item: assistantItem("a") });
    establisher.publish({
      type: "item_completed",
      item: assistantItem("answer", "completed"),
    });
    establisher.publish({
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["submission-1"],
        status: "completed",
        endedBy: "agent_settled",
        startedAt: "2026-08-03T11:59:59.000Z",
        completedAt: "2026-08-03T12:00:02.000Z",
        orderedBackendItemIds: ["assistant-live"],
      },
    });
    establisher.publish({ type: "run_state_changed", state: "idle" });

    const projection = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    expect(projection.snapshot.turnsById["turn-1"]).toMatchObject({
      status: "completed",
      orderedBackendItemIds: ["assistant-live"],
    });
    expect(projection.snapshot.itemsById["assistant-live"]).toMatchObject({
      status: "completed",
      markdown: { text: "answer" },
    });
  });

  it("retires one subscriber and captures a gap-free replacement", async () => {
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: refreshEmptyProjection,
    });
    const first = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    const firstEvents: SequencedBackendEvent[] = [];
    const unsubscribe = first.subscribeFromNext((event) =>
      firstEvents.push(event),
    );
    establisher.publish({ type: "run_state_changed", state: "starting" });
    unsubscribe();
    establisher.publish({ type: "run_state_changed", state: "running" });

    const replacement = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    expect(firstEvents).toHaveLength(1);
    expect(replacement.handleSequence).toBe(1);
    expect(replacement.snapshot.runState).toBe("running");
  });

  it("discards post-contradiction deltas and rebuilds from persisted authority", async () => {
    let refreshCalls = 0;
    const persisted: BackendConversationSnapshot = {
      runState: "idle",
      orderedBackendTurnIds: ["turn-persisted"],
      turnsById: {
        "turn-persisted": {
          backendTurnId: "turn-persisted",
          status: "completed",
          endedBy: "agent_settled",
          startedAt: "2026-08-03T12:00:00.000Z",
          completedAt: "2026-08-03T12:00:02.000Z",
          orderedBackendItemIds: [],
        },
      },
      itemsById: {},
    };
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: () => {
        refreshCalls += 1;
        return {
          snapshot: persisted,
          history: {
            operational: true,
            previousCursor: "pi-private-refreshed-boundary",
          },
        };
      },
    });
    startTurn(establisher);
    establisher.publish({ type: "item_started", item: toolItem("streaming") });
    const first = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    const received: SequencedBackendEvent[] = [];
    const unsubscribe = first.subscribeFromNext((event) =>
      received.push(event),
    );

    establisher.publish({
      type: "item_completed",
      item: {
        ...toolItem("completed"),
        backendTurnId: "missing-turn",
      },
    });
    establisher.publish({
      type: "item_completed",
      item: toolItem("completed"),
    });
    establisher.publish({
      type: "turn_completed",
      turn: {
        backendTurnId: "turn-1",
        completionCorrelations: ["submission-1"],
        status: "completed",
        endedBy: "agent_settled",
        startedAt: "2026-08-03T11:59:59.000Z",
        completedAt: "2026-08-03T12:00:02.000Z",
        orderedBackendItemIds: ["tool-live"],
      },
    });
    establisher.publish({ type: "run_state_changed", state: "idle" });
    unsubscribe();

    const replacement = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    expect(received[0]?.event).toEqual({
      type: "resnapshot_required",
      reason: "contradictory_state",
    });
    expect(refreshCalls).toBe(1);
    expect(replacement.snapshot).toEqual(persisted);
    expect(replacement.history).toEqual({
      operational: true,
      previousCursor: "pi-private-refreshed-boundary",
    });
  });

  it("emits an in-sequence resnapshot request when the post-capture buffer overflows", async () => {
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: refreshEmptyProjection,
      maximumBufferedEvents: 2,
    });
    const projection = await establisher.establishProjection({
      signal: new AbortController().signal,
    });
    establisher.publish({ type: "run_state_changed", state: "starting" });
    establisher.publish({ type: "run_state_changed", state: "running" });
    establisher.publish({ type: "run_state_changed", state: "stopping" });
    const received: SequencedBackendEvent[] = [];
    projection.subscribeFromNext((event) => received.push(event));
    expect(received).toEqual([
      {
        handleSequence: 0,
        event: { type: "resnapshot_required", reason: "buffer_overflow" },
      },
    ]);
  });

  it("rejects an already-aborted establishment without changing the snapshot", async () => {
    const controller = new AbortController();
    controller.abort();
    const establisher = new PiProjectionEstablisher({
      initialSnapshot: emptySnapshot(),
      initialHistory: { operational: true },
      refreshProjection: refreshEmptyProjection,
    });
    await expect(
      establisher.establishProjection({ signal: controller.signal }),
    ).rejects.toMatchObject({ backendCode: "pi_projection_cancelled" });
    expect(establisher.snapshot()).toEqual(emptySnapshot());
  });
});
