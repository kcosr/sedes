import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { threadLoadErrorSchema } from "../../src/shared/protocol/api.js";
import {
  threadEventEnvelopeSchema,
  threadCheckpointSchema,
  type NormalizedThreadSnapshot,
  type ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import {
  MAXIMUM_THREAD_REPLAY_DIAGNOSTIC_EVENTS,
  threadLoadServerDiagnosticSchema,
  threadHandshakeServerDiagnosticSchema,
  threadReplayServerDiagnosticSchema,
} from "../../src/shared/protocol/diagnostics.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { DomainError } from "../../src/server/domain/errors.js";
import {
  DEFAULT_THREAD_SSE_DRAIN_TIMEOUT_MILLISECONDS,
  DEFAULT_THREAD_SSE_PENDING_BYTE_LIMIT,
  DEFAULT_THREAD_SSE_PENDING_EVENT_LIMIT,
  serveThreadEventStream,
  type ThreadSnapshotCapture,
} from "../../src/server/events/thread-sse.js";

class FakeRequest extends EventEmitter {
  constructor(private readonly lastEventId?: string) {
    super();
  }

  header(name: string): string | undefined {
    return name === "Last-Event-ID" ? this.lastEventId : undefined;
  }
}

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly end = vi.fn();
  readonly setHeader = vi.fn();
  readonly flushHeaders = vi.fn();
  readonly status = vi.fn(() => this);
  writeResult: (value: string) => boolean = () => true;
  writableLength = 0;
  writableHighWaterMark = 16_384;

  write(value: string): boolean {
    this.writes.push(value);
    return this.writeResult(value);
  }
}

function asRequest(request: FakeRequest): Request {
  return request as unknown as Request;
}

function asResponse(response: FakeResponse): Response {
  return response as unknown as Response;
}

function snapshot(title = "Thread"): NormalizedThreadSnapshot {
  return {
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
    forksByTurnId: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: title },
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

function publishedSnapshot(
  hub: ThreadEventHub,
  generation: string,
  title = generation,
): ThreadEventEnvelope {
  return hub.publish({
    type: "snapshot",
    generation,
    snapshot: snapshot(title),
  });
}

const activitySecret = "SSE_ACTIVITY_DETAIL_MUST_BE_REDACTED";

function snapshotWithDetailedActivity(): NormalizedThreadSnapshot {
  const base = snapshot();
  return {
    ...base,
    orderedTurnIds: ["turn-activity"],
    turnsById: {
      "turn-activity": {
        id: "turn-activity",
        revision: 1,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds: ["reasoning-activity", "reasoning-without-summary"],
      },
    },
    forksByTurnId: {
      "turn-activity": {
        sourceTurnId: "turn-activity",
        expectedTurnRevision: 1,
        available: false,
        unavailableReason: { text: "Forking is unavailable." },
      },
    },
    itemsById: {
      "reasoning-activity": {
        id: "reasoning-activity",
        turnId: "turn-activity",
        kind: "reasoning",
        status: "completed",
        revision: 3,
        startedAt: "2026-08-14T12:00:00.000Z",
        completedAt: "2026-08-14T12:00:01.000Z",
        summaryParts: [
          { text: "Preparing SSE projection" },
          { text: "Checking retained summary delivery" },
        ],
        markdown: { text: activitySecret },
      },
      "reasoning-without-summary": {
        id: "reasoning-without-summary",
        turnId: "turn-activity",
        kind: "reasoning",
        status: "completed",
        revision: 1,
        markdown: { text: `${activitySecret}:without-summary` },
      },
    },
  };
}

function snapshotWithMessage(text: string): NormalizedThreadSnapshot {
  const base = snapshotWithDetailedActivity();
  const turn = base.turnsById["turn-activity"]!;
  return {
    ...base,
    turnsById: {
      "turn-activity": {
        ...turn,
        orderedItemIds: [...turn.orderedItemIds, "assistant-1"],
      },
    },
    itemsById: {
      ...base.itemsById,
      "assistant-1": {
        id: "assistant-1",
        turnId: turn.id,
        revision: 1,
        kind: "assistant_message",
        status: "completed",
        markdown: { text },
      },
    },
  };
}

function envelopes(response: FakeResponse): ThreadEventEnvelope[] {
  return response.writes.flatMap((write) =>
    write
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .flatMap((line) => {
        const value = JSON.parse(line.slice(6)) as Record<string, unknown>;
        return typeof value.eventId === "string" && "event" in value
          ? [threadEventEnvelopeSchema.parse(value)]
          : [];
      }),
  );
}

function checkpoints(response: FakeResponse) {
  return response.writes.flatMap((write) => {
    if (!write.includes("\nevent: thread-checkpoint\n")) return [];
    const data = write.split("\n").find((line) => line.startsWith("data: "));
    return data
      ? [threadCheckpointSchema.parse(JSON.parse(data.slice(6)))]
      : [];
  });
}

function publishNotices(hub: ThreadEventHub, ids: readonly string[]) {
  for (const id of ids)
    hub.publish({
      type: "notice",
      generation: "projection-1",
      notice: {
        id,
        tone: "info",
        message: { text: id },
        createdAt: "2026-07-30T15:00:00.000Z",
      },
    });
}

function replayDiagnostics(response: FakeResponse) {
  return response.writes.flatMap((write) => {
    if (!write.startsWith("event: thread-replay-diagnostic\n")) return [];
    const data = write.split("\n").find((line) => line.startsWith("data: "));
    return data
      ? [threadReplayServerDiagnosticSchema.parse(JSON.parse(data.slice(6)))]
      : [];
  });
}

function loadErrors(response: FakeResponse) {
  return response.writes.flatMap((write) => {
    if (!write.startsWith("event: thread-load-error\n")) return [];
    const data = write.split("\n").find((line) => line.startsWith("data: "));
    return data ? [threadLoadErrorSchema.parse(JSON.parse(data.slice(6)))] : [];
  });
}

function source(
  hub: ThreadEventHub,
  input: {
    capture: () => Promise<{
      generation: string;
      snapshot: NormalizedThreadSnapshot;
    }>;
    replace?: ThreadSnapshotCapture["publishAuthoritativeReplacement"];
  },
): ThreadSnapshotCapture {
  return {
    publishAuthoritativeReplacement: async () => {
      const captured = await input.capture();
      return (
        input.replace?.() ??
        hub.publish({
          type: "snapshot",
          generation: captured.generation,
          snapshot: captured.snapshot,
        })
      );
    },
  };
}

describe("serveThreadEventStream", () => {
  it("replays a small suffix without constructing a checkpoint", async () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: snapshotWithMessage("history".repeat(10_000)),
    });
    const update = hub.publish({
      type: "usage_changed",
      generation: "projection-1",
      usage: { counters: { userMessages: 1 } },
    });
    const checkpoint = vi.spyOn(hub, "currentCheckpoint");
    const capture = vi.fn();
    const response = new FakeResponse();
    const request = new FakeRequest(anchor.eventId);
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );
    expect(envelopes(response)).toEqual([update]);
    expect(checkpoints(response)).toEqual([]);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    request.emit("close");
  });

  it("replaces a large repeated-message suffix with its smaller current checkpoint", async () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: snapshotWithMessage("initial"),
    });
    let latest: ThreadEventEnvelope | undefined;
    const assistant = hub.snapshot!.itemsById["assistant-1"]!;
    if (assistant.kind !== "assistant_message")
      throw new Error("fixture_assistant_required");
    for (let revision = 2; revision <= 30; revision += 1)
      latest = hub.publish({
        type: "item_upsert",
        generation: "projection-1",
        item: {
          ...assistant,
          revision,
          markdown: { text: "Accumulated output ".repeat(300) + revision },
        },
      });
    expect(hub.replayBytesAfter(anchor.eventId)).toBeGreaterThan(65_536);
    const capture = vi.fn();
    const response = new FakeResponse();
    const request = new FakeRequest(anchor.eventId);
    const currentWatermark = hub.watermark;
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );
    expect(envelopes(response)).toEqual([]);
    expect(checkpoints(response)).toMatchObject([
      {
        eventId: latest!.eventId,
        snapshot: {
          itemsById: {
            "assistant-1": {
              revision: 30,
              markdown: { text: "Accumulated output ".repeat(300) + 30 },
            },
          },
        },
      },
    ]);
    expect(capture).not.toHaveBeenCalled();
    expect(hub.watermark).toBe(currentWatermark);
    const after = hub.publish({
      type: "usage_changed",
      generation: "projection-1",
      usage: { counters: { userMessages: 1 } },
    });
    expect(envelopes(response)).toEqual([after]);
    request.emit("close");
  });

  it("compares projected summary bytes so large detailed activity does not resend old messages", async () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: snapshotWithMessage("older complete answer ".repeat(50_000)),
    });
    const updates: ThreadEventEnvelope[] = [];
    const reasoning = hub.snapshot!.itemsById["reasoning-activity"]!;
    if (reasoning.kind !== "reasoning")
      throw new Error("fixture_reasoning_required");
    for (let revision = 4; revision <= 11; revision += 1)
      updates.push(
        hub.publish({
          type: "item_upsert",
          generation: "projection-1",
          item: {
            ...reasoning,
            revision,
            markdown: { text: "x".repeat(16_000) },
          },
        }),
      );
    expect(hub.replayBytesAfter(anchor.eventId)).toBeGreaterThan(65_536);
    const capture = vi.fn();
    for (const activityDetail of ["summary", "full"] as const) {
      const response = new FakeResponse();
      const request = new FakeRequest(anchor.eventId);
      await serveThreadEventStream(
        asRequest(request),
        asResponse(response),
        hub,
        source(hub, { capture }),
        { activityDetail },
      );
      expect(checkpoints(response)).toEqual([]);
      expect(envelopes(response).map(({ eventId }) => eventId)).toEqual(
        updates.map(({ eventId }) => eventId),
      );
      expect(response.writes.join("")).not.toContain("older complete answer");
      if (activityDetail === "summary") {
        expect(
          Buffer.byteLength(response.writes.join(""), "utf8"),
        ).toBeLessThan(10_000);
        expect(envelopes(response)[0]).toMatchObject({
          event: { item: { kind: "activity_summary" } },
        });
      }
      request.emit("close");
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("recovers overflow while live and resumes strictly after the checkpoint watermark", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1");
    const response = new FakeResponse();
    const request = new FakeRequest();
    const capture = vi.fn();
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
      { pendingEventLimit: 1 },
    );
    response.writeResult = () => false;
    const written = hub.publish({
      type: "usage_changed",
      generation: "projection-1",
      usage: { counters: { userMessages: 1 } },
    });
    publishNotices(hub, ["one", "two"]);
    response.writeResult = () => true;
    response.emit("drain");
    await vi.waitFor(() => expect(checkpoints(response)).toHaveLength(2));
    const after = hub.publish({
      type: "usage_changed",
      generation: "projection-1",
      usage: { counters: { userMessages: 2 } },
    });
    await vi.waitFor(() =>
      expect(envelopes(response)).toEqual([written, after]),
    );
    expect(checkpoints(response)[1]).toMatchObject({
      eventId: hub.eventIdAt(4),
      notices: [{ id: "one" }, { id: "two" }],
    });
    expect(response.end).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    request.emit("close");
    expect(hub.subscriberCount).toBe(0);
  });

  it.each(["live frame", "heartbeat"] as const)(
    "retains post-checkpoint events after a partial flush, overflow and backpressured %s",
    async (backpressuredFrame) => {
      vi.useFakeTimers();
      const hub = new ThreadEventHub();
      publishedSnapshot(hub, "projection-1");
      const request = new FakeRequest();
      const response = new FakeResponse();
      const publishUsage = (userMessages: number) =>
        hub.publish({
          type: "usage_changed",
          generation: "projection-1",
          usage: { counters: { userMessages } },
        });
      try {
        await serveThreadEventStream(
          asRequest(request),
          asResponse(response),
          hub,
          source(hub, { capture: vi.fn() }),
          { pendingEventLimit: 2, heartbeatMilliseconds: 1_000 },
        );
        response.writeResult = () => false;
        const first = publishUsage(1);
        const second = publishUsage(2);
        const third = publishUsage(3);
        let flushedWrites = 0;
        response.writeResult = () => ++flushedWrites === 1;
        response.emit("drain");
        expect(envelopes(response)).toEqual([first, second, third]);

        const checkpointHead = publishUsage(4);
        response.writeResult = (frame) =>
          backpressuredFrame === "live frame"
            ? !frame.startsWith("event: thread-live")
            : !frame.startsWith(": heartbeat");
        response.emit("drain");
        await vi.waitFor(() =>
          expect(
            response.writes.filter((frame) =>
              frame.startsWith("event: thread-live"),
            ),
          ).toHaveLength(2),
        );
        expect(checkpoints(response).at(-1)?.eventId).toBe(
          checkpointHead.eventId,
        );
        if (backpressuredFrame === "heartbeat") {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(response.listenerCount("drain")).toBe(1);
        const fourth = publishUsage(5);
        const fifth = publishUsage(6);
        response.writeResult = () => true;
        response.emit("drain");
        expect(envelopes(response)).toEqual([
          first,
          second,
          third,
          fourth,
          fifth,
        ]);
        expect(response.end).not.toHaveBeenCalled();
        expect(response.listenerCount("drain")).toBe(0);
      } finally {
        request.emit("close");
        vi.useRealTimers();
      }
      expect(hub.subscriberCount).toBe(0);
    },
  );

  it("releases a subscription if its initial synchronous callback fails", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1");
    const subscribe = hub.subscribe.bind(hub);
    vi.spyOn(hub, "subscribe").mockImplementation((listener, cursor) => {
      const subscription = subscribe(listener, cursor);
      listener({ invalid: true } as unknown as ThreadEventEnvelope);
      return subscription;
    });
    const response = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, { capture: vi.fn() }),
    );
    expect(response.end).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    expect(response.writes).toEqual([]);
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("reports pre-header server timing on a caught-up resume without capturing a snapshot", async () => {
    const hub = new ThreadEventHub();
    const anchor = publishedSnapshot(hub, "projection-1", "PRIVATE_PAYLOAD");
    const request = new FakeRequest();
    const response = new FakeResponse();
    const capture = vi.fn();
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    try {
      await serveThreadEventStream(
        asRequest(request),
        asResponse(response),
        hub,
        source(hub, { capture }),
        {
          requestId: "00000000-0000-4000-8000-000000000001",
          explicitReplayCursor: anchor.eventId,
          loadDiagnostics: {
            requestStartedAt: performance.now() - 6400,
            routeSetupMilliseconds: 40,
            runtimeAcquireMilliseconds: 6300,
          },
        },
      );
      expect(capture).not.toHaveBeenCalled();
      expect(envelopes(response)).toEqual([]);
      const frames = response.writes.filter((write) =>
        write.startsWith("event: thread-handshake-diagnostic\n"),
      );
      expect(frames).toHaveLength(1);
      const diagnostic = threadHandshakeServerDiagnosticSchema.parse(
        JSON.parse(frames[0]!.split("\n")[1]!.slice(6)),
      );
      expect(diagnostic).toMatchObject({
        requestId: "00000000-0000-4000-8000-000000000001",
        routeSetupMilliseconds: 40,
        runtimeAcquireMilliseconds: 6300,
      });
      expect(diagnostic.requestToHeadersMilliseconds).toBeGreaterThanOrEqual(
        6400,
      );
      expect(frames[0]).not.toContain("PRIVATE_PAYLOAD");
      expect(frames[0]).not.toContain(anchor.eventId);
      expect(
        logger.mock.calls
          .map(([line]) => line)
          .filter((line) =>
            String(line).startsWith("[delivery-thread-handshake]"),
          ),
      ).toEqual([`[delivery-thread-handshake] ${JSON.stringify(diagnostic)}`]);
      expect(replayDiagnostics(response)[0]?.outcome).toBe("caught_up");
      expect(response.writes.at(-1)).toBe("event: thread-live\ndata: {}\n\n");
    } finally {
      request.emit("close");
      vi.unstubAllEnvs();
      logger.mockRestore();
    }
  });

  it.each(["disabled", "no_headroom"])(
    "omits handshake telemetry with %s without changing replay",
    async (mode) => {
      const hub = new ThreadEventHub();
      const anchor = publishedSnapshot(hub, "projection-1");
      const request = new FakeRequest();
      const response = new FakeResponse();
      if (mode === "no_headroom")
        response.writableLength = response.writableHighWaterMark;
      const logger = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
      try {
        await serveThreadEventStream(
          asRequest(request),
          asResponse(response),
          hub,
          source(hub, { capture: vi.fn() }),
          {
            explicitReplayCursor: anchor.eventId,
            requestId: "PRIVATE_TOKEN",
            ...(mode === "disabled"
              ? {}
              : {
                  loadDiagnostics: {
                    requestStartedAt: performance.now(),
                    routeSetupMilliseconds: 0,
                    runtimeAcquireMilliseconds: 0,
                  },
                }),
          },
        );
        expect(
          response.writes.some((write) =>
            write.startsWith("event: thread-handshake-diagnostic"),
          ),
        ).toBe(false);
        expect(response.writes.join("")).not.toContain("PRIVATE_TOKEN");
        expect(logger).not.toHaveBeenCalled();
        expect(response.writes.at(-1)).toBe("event: thread-live\ndata: {}\n\n");
      } finally {
        request.emit("close");
        vi.unstubAllEnvs();
        logger.mockRestore();
      }
    },
  );

  it("uses the slow-client handshake and replay diagnostic defaults", () => {
    expect(DEFAULT_THREAD_SSE_PENDING_EVENT_LIMIT).toBe(2_048);
    expect(DEFAULT_THREAD_SSE_PENDING_BYTE_LIMIT).toBe(16 * 1_024 * 1_024);
    expect(DEFAULT_THREAD_SSE_DRAIN_TIMEOUT_MILLISECONDS).toBe(30_000);
    expect(MAXIMUM_THREAD_REPLAY_DIAGNOSTIC_EVENTS).toBe(4_096);
    expect(
      threadReplayServerDiagnosticSchema.parse({
        format: "sedes-thread-replay-server-v1",
        cursorSource: "explicit_query",
        outcome: "replayed",
        replayedEventCount: 4_096,
      }).replayedEventCount,
    ).toBe(4_096);
  });

  it("emits one classified load error when initial snapshot capture fails", async () => {
    const hub = new ThreadEventHub();
    const response = new FakeResponse();

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      {
        publishAuthoritativeReplacement: async () => {
          throw new DomainError(
            "workspace_missing",
            "The workspace directory was moved or removed.",
          );
        },
      },
      { requestId: "request-1" },
    );

    expect(loadErrors(response)).toEqual([
      {
        format: "sedes-thread-load-error-v1",
        requestId: "request-1",
        error: {
          code: "workspace_missing",
          message: "The workspace directory was moved or removed.",
          retryable: false,
        },
      },
    ]);
    expect(response.writes).not.toContain("event: thread-live\ndata: {}\n\n");
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("classifies an invalid post-header replacement as terminal", async () => {
    const hub = new ThreadEventHub();
    const response = new FakeResponse();

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      {
        publishAuthoritativeReplacement: async () =>
          ({ invalid: true }) as unknown as ThreadEventEnvelope,
      },
      { requestId: "request-invalid-history" },
    );

    expect(loadErrors(response)).toEqual([
      {
        format: "sedes-thread-load-error-v1",
        requestId: "request-invalid-history",
        error: {
          code: "backend_incompatible_protocol",
          message: "The backend returned incomplete or invalid thread history.",
          retryable: false,
        },
      },
    ]);
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("redacts retained snapshots and replayed item events without changing hub continuity", async () => {
    const hub = new ThreadEventHub();
    const anchor = hub.publish({
      type: "snapshot",
      generation: "projection-activity",
      snapshot: snapshotWithDetailedActivity(),
    });
    const summaryResponse = new FakeResponse();

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(summaryResponse),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-activity",
          snapshot: snapshotWithDetailedActivity(),
        }),
      }),
      { activityDetail: "summary" },
    );

    expect(summaryResponse.writes.join("\n")).not.toContain(activitySecret);
    expect(checkpoints(summaryResponse)[0]).toMatchObject({
      eventId: anchor.eventId,
      snapshot: {
        itemsById: {
          "reasoning-activity": {
            kind: "activity_summary",
            activityKind: "reasoning",
            revision: 3,
            summaryParts: [
              { text: "Preparing SSE projection" },
              { text: "Checking retained summary delivery" },
            ],
          },
          "reasoning-without-summary": {
            kind: "activity_summary",
            activityKind: "reasoning",
            revision: 1,
          },
        },
      },
    });
    expect(
      checkpoints(summaryResponse)[0]!.snapshot.itemsById[
        "reasoning-without-summary"
      ],
    ).not.toHaveProperty("summaryParts");
    expect(
      JSON.stringify(hub.snapshot?.itemsById["reasoning-activity"]),
    ).toContain(activitySecret);

    const upsert = hub.publish({
      type: "item_upsert",
      generation: "projection-activity",
      item: {
        id: "command-activity",
        turnId: "turn-activity",
        kind: "command",
        status: "completed",
        revision: 1,
        phase: "completed",
        command: { text: activitySecret },
        output: { text: activitySecret },
      },
    });
    const replayResponse = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest(anchor.eventId)),
      asResponse(replayResponse),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-activity",
          snapshot: snapshotWithDetailedActivity(),
        }),
      }),
      { activityDetail: "summary" },
    );

    expect(replayResponse.writes.join("\n")).not.toContain(activitySecret);
    expect(envelopes(replayResponse)).toMatchObject([
      {
        eventId: upsert.eventId,
        event: {
          type: "item_upsert",
          item: {
            kind: "activity_summary",
            activityKind: "command",
            revision: 1,
          },
        },
      },
    ]);

    const completedTurn = hub.snapshot!.turnsById["turn-activity"]!;
    hub.publish({
      type: "turn_upsert",
      generation: "projection-activity",
      turn: {
        ...completedTurn,
        revision: 2,
        orderedItemIds: [...completedTurn.orderedItemIds, "command-activity"],
      },
      fork: {
        ...hub.snapshot!.forksByTurnId["turn-activity"]!,
        expectedTurnRevision: 2,
      },
    });
    const fullResponse = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(fullResponse),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-activity",
          snapshot: snapshotWithDetailedActivity(),
        }),
      }),
      { activityDetail: "full" },
    );
    const fullWrites = fullResponse.writes.join("\n");
    expect(fullWrites).toContain(activitySecret);
    expect(fullWrites).toContain("Preparing SSE projection");
    expect(checkpoints(fullResponse)[0]).toMatchObject({
      snapshot: {
        itemsById: {
          "reasoning-activity": {
            kind: "reasoning",
            markdown: { text: activitySecret },
            summaryParts: [
              { text: "Preparing SSE projection" },
              { text: "Checking retained summary delivery" },
            ],
          },
        },
      },
    });
  });

  it("emits a content-free snapshot timing event only when requested", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1", "Sensitive title");
    const response = new FakeResponse();
    const requestStartedAt = performance.now();

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-1",
          snapshot: snapshot("unused"),
        }),
      }),
      {
        loadDiagnostics: {
          requestStartedAt,
          routeSetupMilliseconds: 4.2,
          runtimeAcquireMilliseconds: 8.4,
        },
      },
    );

    const frame = response.writes.find((write) =>
      write.startsWith("event: thread-load-diagnostic\n"),
    );
    expect(frame).toBeDefined();
    const diagnostic = threadLoadServerDiagnosticSchema.parse(
      JSON.parse(frame!.split("\n")[1]!.slice(6)),
    );
    expect(diagnostic).toMatchObject({
      format: "sedes-thread-load-server-v1",
      handshake: "current_checkpoint",
      routeSetupMilliseconds: 4.2,
      runtimeAcquireMilliseconds: 8.4,
      turnCount: 0,
      itemCount: 0,
      largestTurnItemCount: 0,
    });
    expect(frame).not.toContain("Sensitive title");
    expect(replayDiagnostics(response)).toEqual([]);

    const ordinaryResponse = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(ordinaryResponse),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-1",
          snapshot: snapshot("unused"),
        }),
      }),
    );
    expect(
      ordinaryResponse.writes.some((write) =>
        write.startsWith("event: thread-load-diagnostic\n"),
      ),
    ).toBe(false);
  });

  it("drops an optional diagnostic frame rather than consuming handshake backpressure", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1");
    const response = new FakeResponse();
    response.writableLength = response.writableHighWaterMark - 1;

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-1",
          snapshot: snapshot("unused"),
        }),
      }),
      {
        loadDiagnostics: {
          requestStartedAt: performance.now(),
          routeSetupMilliseconds: 1,
          runtimeAcquireMilliseconds: 2,
        },
      },
    );

    expect(
      response.writes.some((write) =>
        write.startsWith("event: thread-load-diagnostic\n"),
      ),
    ).toBe(false);
    expect(response.writes.at(-1)).toBe("event: thread-live\ndata: {}\n\n");
    expect(response.end).not.toHaveBeenCalled();
  });

  it("sends the current snapshot at its published watermark without replay or recapture", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1", "Established runtime");
    const update = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const capture = vi.fn();
    const otherViewer = vi.fn();
    const otherSubscription = hub.subscribe(otherViewer);
    const request = new FakeRequest();
    const response = new FakeResponse();
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );

    expect(capture).not.toHaveBeenCalled();
    expect(envelopes(response)).toEqual([]);
    expect(checkpoints(response)).toMatchObject([
      {
        eventId: update.eventId,
        projectionGeneration: "projection-1",
        capabilityThreadRevision: 0,
        capabilityRunState: "idle",
        snapshot: {
          thread: {
            title: { text: "Established runtime" },
            runState: "running",
          },
          runState: "running",
          capabilities: { runState: "running" },
        },
      },
    ]);
    expect(hub.watermark).toBe(2);
    expect(otherViewer).not.toHaveBeenCalled();
    request.emit("close");
    otherSubscription.close();
  });

  it("preserves events crossing an initial checkpoint without publishing a replacement", async () => {
    const hub = new ThreadEventHub();
    const anchor = publishedSnapshot(hub, "projection-1");
    const request = new FakeRequest("invalid-cursor");
    const response = new FakeResponse();
    response.writeResult = () => false;
    const capture = vi.fn();
    const serving = serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );
    const update = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    response.writeResult = () => true;
    response.emit("drain");
    await serving;
    expect(checkpoints(response)).toMatchObject([
      { eventId: anchor.eventId, snapshot: { runState: "idle" } },
    ]);
    expect(envelopes(response)).toEqual([update]);
    expect(capture).not.toHaveBeenCalled();
    expect(hub.watermark).toBe(2);
    expect(response.writes.at(-1)).toBe("event: thread-live\ndata: {}\n\n");
    request.emit("close");
  });

  it("uses a real published sequence for a quiet unbound generation", async () => {
    const hub = new ThreadEventHub();
    const response = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "application-draft-1",
          snapshot: snapshot("Draft"),
        }),
      }),
    );

    expect(checkpoints(response)[0]?.eventId).toBe(hub.eventIdAt(1));
    const update = hub.publish({
      type: "draft_changed",
      generation: "application-draft-1",
      draft: {
        text: "later",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 1,
      },
    });
    expect(update.eventId).toBe(hub.eventIdAt(2));
    expect(envelopes(response).at(-1)?.event).toMatchObject({
      type: "draft_changed",
    });
  });

  it("allows one bounded replacement larger than the incremental buffer", async () => {
    const hub = new ThreadEventHub();
    const response = new FakeResponse();
    const largeSnapshot = {
      ...snapshot("Large but valid"),
      draft: {
        text: "x".repeat(2_000),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 0,
      },
    };
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "application-large",
          snapshot: largeSnapshot,
        }),
      }),
      { pendingByteLimit: 128 },
    );

    expect(checkpoints(response)).toHaveLength(1);
    expect(checkpoints(response)[0]?.snapshot).toEqual(largeSnapshot);
    expect(response.end).not.toHaveBeenCalled();
  });

  it("delivers the newest genuine replacement and its suffix after a checkpoint", async () => {
    const hub = new ThreadEventHub();
    const anchor = publishedSnapshot(hub, "projection-1");
    const response = new FakeResponse();
    response.writeResult = () => false;
    const request = new FakeRequest("invalid-cursor");
    const capture = vi.fn();
    const serving = serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );
    publishedSnapshot(hub, "projection-2");
    const latest = publishedSnapshot(hub, "projection-3", "Latest");
    const after = hub.publish({
      type: "usage_changed",
      generation: "projection-3",
      usage: { counters: { totalMessages: 42 } },
    });
    response.writeResult = () => true;
    response.emit("drain");
    await serving;
    expect(checkpoints(response).map(({ eventId }) => eventId)).toEqual([
      anchor.eventId,
    ]);
    expect(envelopes(response)).toEqual([latest, after]);
    expect(capture).not.toHaveBeenCalled();
    expect(hub.watermark).toBe(4);
    request.emit("close");
  });

  it("recovers handshake overflow with one private current checkpoint including lost notices", async () => {
    const hub = new ThreadEventHub();
    const anchor = publishedSnapshot(hub, "projection-1");
    const response = new FakeResponse();
    response.writeResult = () => false;
    const request = new FakeRequest("invalid-cursor");
    const capture = vi.fn();
    const otherViewer = vi.fn();
    const otherSubscription = hub.subscribe(otherViewer);
    const serving = serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
      { pendingEventLimit: 1, pendingByteLimit: 100_000 },
    );
    publishNotices(hub, ["one", "two"]);
    response.writeResult = () => true;
    response.emit("drain");
    await serving;

    expect(checkpoints(response)).toMatchObject([
      { eventId: anchor.eventId, notices: [] },
      { eventId: hub.eventIdAt(3), notices: [{ id: "one" }, { id: "two" }] },
    ]);
    expect(envelopes(response)).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
    expect(hub.watermark).toBe(3);
    expect(otherViewer).toHaveBeenCalledTimes(2);
    expect(response.end).not.toHaveBeenCalled();
    request.emit("close");
    otherSubscription.close();
  });

  it("logs the replacement handshake after a retained snapshot overflows", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const hub = new ThreadEventHub();
      publishedSnapshot(hub, "projection-1");
      const response = new FakeResponse();
      response.writeResult = () => false;
      const replacement = vi.fn(async () =>
        publishedSnapshot(hub, "projection-2", "Recovered"),
      );
      const serving = serveThreadEventStream(
        asRequest(new FakeRequest()),
        asResponse(response),
        hub,
        source(hub, {
          capture: async () => ({
            generation: "projection-2",
            snapshot: snapshot("Recovered"),
          }),
          replace: replacement,
        }),
        {
          threadId: "thread-1",
          pendingEventLimit: 1,
          pendingByteLimit: 100_000,
        },
      );
      for (const id of ["one", "two"]) {
        hub.publish({
          type: "notice",
          generation: "projection-1",
          notice: {
            id,
            tone: "info",
            message: { text: id },
            createdAt: "2026-07-30T15:00:00.000Z",
          },
        });
      }
      response.writeResult = () => true;
      response.emit("drain");
      await serving;

      expect(replacement).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[delivery-stream\] thread=thread-1 open handshake=overflow_checkpoint ms=\d+ snapshotBytes=\d+$/,
        ),
      );
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("uses current state after replay eviction and loses no event published by retention callbacks", async () => {
    const hub = new ThreadEventHub({ replayLimit: 2 });
    publishedSnapshot(hub, "projection-1", "Retained history");
    for (let userMessages = 1; userMessages <= 3; userMessages += 1)
      hub.publish({
        type: "usage_changed",
        generation: "projection-1",
        usage: { counters: { userMessages } },
      });
    const capture = vi.fn();
    let crossing: ThreadEventEnvelope | undefined;
    const stop = hub.onSubscriberCountChanged((count) => {
      if (count !== 1 || crossing) return;
      crossing = hub.publish({
        type: "run_state",
        generation: "projection-1",
        state: "running",
      });
    });
    const response = new FakeResponse();
    const request = new FakeRequest();
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
    );
    expect(capture).not.toHaveBeenCalled();
    expect(checkpoints(response)).toMatchObject([
      {
        eventId: hub.eventIdAt(4),
        snapshot: { usage: { counters: { userMessages: 3 } }, runState: "idle" },
      },
    ]);
    expect(envelopes(response)).toEqual([crossing]);
    expect(hub.watermark).toBe(5);
    stop();
    request.emit("close");
  });

  it("closes after a second overflow instead of repeatedly generating checkpoints", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1");
    const response = new FakeResponse();
    response.writeResult = () => false;
    const capture = vi.fn();
    const request = new FakeRequest();
    const serving = serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, { capture }),
      { pendingEventLimit: 1, pendingByteLimit: 100_000 },
    );
    publishNotices(hub, ["one", "two"]);
    response.emit("drain");
    await vi.waitFor(() => expect(checkpoints(response)).toHaveLength(2));
    publishNotices(hub, ["three", "four"]);
    response.writeResult = () => true;
    response.emit("drain");
    await serving;
    expect(capture).not.toHaveBeenCalled();
    expect(checkpoints(response)).toHaveLength(2);
    expect(envelopes(response)).toEqual([]);
    expect(response.writes).not.toContain("event: thread-live\ndata: {}\n\n");
    expect(response.end).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
    request.emit("close");
  });

  it("flushes a replacement queued while an earlier pending write is backpressured", async () => {
    const hub = new ThreadEventHub();
    publishedSnapshot(hub, "projection-1");
    const request = new FakeRequest();
    const response = new FakeResponse();
    await serveThreadEventStream(
      asRequest(request),
      asResponse(response),
      hub,
      source(hub, {
        capture: async () => ({
          generation: "projection-1",
          snapshot: snapshot("Initial"),
        }),
      }),
    );

    let writesBeforeDrain = 0;
    response.writeResult = () => {
      writesBeforeDrain += 1;
      return writesBeforeDrain > 2;
    };
    hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    hub.publish({
      type: "usage_changed",
      generation: "projection-1",
      usage: { counters: { userMessages: 1 } },
    });
    response.emit("drain");
    const replacement = publishedSnapshot(hub, "projection-2", "Replacement");
    response.emit("drain");

    expect(envelopes(response).at(-1)).toMatchObject({
      eventId: replacement.eventId,
      event: {
        type: "snapshot",
        generation: "projection-2",
        snapshot: { thread: { title: { text: "Replacement" } } },
      },
    });
    request.emit("close");
  });

  it("replays a valid Last-Event-ID without capturing and snapshots invalid, stale, or future cursors", async () => {
    const hub = new ThreadEventHub({ replayLimit: 2 });
    publishedSnapshot(hub, "projection-1");
    hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const latest = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });

    const replayResponse = new FakeResponse();
    const replayCapture = vi.fn(async () => ({
      generation: "projection-1",
      snapshot: snapshot(),
    }));
    await serveThreadEventStream(
      asRequest(new FakeRequest(hub.eventIdAt(1))),
      asResponse(replayResponse),
      hub,
      source(hub, { capture: replayCapture }),
    );
    expect(replayCapture).not.toHaveBeenCalled();
    expect(envelopes(replayResponse).map(({ eventId }) => eventId)).toEqual([
      hub.eventIdAt(2),
      latest.eventId,
    ]);

    for (const lastEventId of [
      hub.eventIdAt(0),
      "not-an-event-id",
      "00000000-0000-4000-8000-000000000099.3",
      hub.eventIdAt(999),
    ]) {
      const response = new FakeResponse();
      const capture = vi.fn(async () => ({
        generation: "projection-1",
        snapshot: snapshot("Resnapshot"),
      }));
      await serveThreadEventStream(
        asRequest(new FakeRequest(lastEventId)),
        asResponse(response),
        hub,
        source(hub, { capture }),
      );
      expect(capture).not.toHaveBeenCalled();
      expect(checkpoints(response)).toHaveLength(1);
      expect(checkpoints(response)[0]?.eventId).toBe(
        hub.eventIdAt(hub.watermark),
      );
    }
  });

  it("replays an explicit browser cursor and reports only content-free replay diagnostics", async () => {
    const hub = new ThreadEventHub({ replayLimit: 3 });
    const anchor = publishedSnapshot(hub, "projection-1");
    const running = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const idle = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });
    const response = new FakeResponse();
    const capture = vi.fn(async () => ({
      generation: "projection-1",
      snapshot: snapshot(),
    }));

    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      source(hub, { capture }),
      {
        explicitReplayCursor: anchor.eventId,
        loadDiagnostics: {
          requestStartedAt: performance.now(),
          routeSetupMilliseconds: 1,
          runtimeAcquireMilliseconds: 2,
        },
      },
    );

    expect(capture).not.toHaveBeenCalled();
    expect(envelopes(response).map(({ eventId }) => eventId)).toEqual([
      running.eventId,
      idle.eventId,
    ]);
    expect(replayDiagnostics(response)).toEqual([
      {
        format: "sedes-thread-replay-server-v1",
        cursorSource: "explicit_query",
        outcome: "replayed",
        replayedEventCount: 2,
      },
    ]);
    const diagnosticFrame = response.writes.find((write) =>
      write.startsWith("event: thread-replay-diagnostic\n"),
    );
    expect(diagnosticFrame).not.toContain(anchor.eventId);
    expect(diagnosticFrame).not.toContain("projection-1");
    expect(diagnosticFrame).not.toContain("thread-1");
  });

  it("uses Last-Event-ID ahead of an older query cursor and never falls back from an invalid header", async () => {
    const hub = new ThreadEventHub({ replayLimit: 3 });
    const anchor = publishedSnapshot(hub, "projection-1");
    const middle = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const latest = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });
    const replayResponse = new FakeResponse();
    const replayCapture = vi.fn(async () => ({
      generation: "projection-1",
      snapshot: snapshot(),
    }));

    await serveThreadEventStream(
      asRequest(new FakeRequest(middle.eventId)),
      asResponse(replayResponse),
      hub,
      source(hub, { capture: replayCapture }),
      { explicitReplayCursor: anchor.eventId },
    );
    expect(replayCapture).not.toHaveBeenCalled();
    expect(envelopes(replayResponse).map(({ eventId }) => eventId)).toEqual([
      latest.eventId,
    ]);
    expect(replayDiagnostics(replayResponse)).toEqual([]);

    const fallbackResponse = new FakeResponse();
    const fallbackCapture = vi.fn(async () => ({
      generation: "projection-1",
      snapshot: snapshot("Header fallback"),
    }));
    await serveThreadEventStream(
      asRequest(new FakeRequest("invalid-header-cursor")),
      asResponse(fallbackResponse),
      hub,
      source(hub, { capture: fallbackCapture }),
      { explicitReplayCursor: middle.eventId },
    );
    expect(fallbackCapture).not.toHaveBeenCalled();
    expect(checkpoints(fallbackResponse)[0]).toMatchObject({
      eventId: latest.eventId,
      snapshot: { thread: { title: { text: "projection-1" } } },
    });
  });

  it("catches up without a snapshot at the current explicit cursor and snapshots unavailable cursors", async () => {
    const hub = new ThreadEventHub({ replayLimit: 2 });
    publishedSnapshot(hub, "projection-1");
    hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "running",
    });
    const latest = hub.publish({
      type: "run_state",
      generation: "projection-1",
      state: "idle",
    });
    const caughtUp = new FakeResponse();
    const caughtUpCapture = vi.fn(async () => ({
      generation: "projection-1",
      snapshot: snapshot(),
    }));
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(caughtUp),
      hub,
      source(hub, { capture: caughtUpCapture }),
      {
        explicitReplayCursor: latest.eventId,
        loadDiagnostics: {
          requestStartedAt: performance.now(),
          routeSetupMilliseconds: 0,
          runtimeAcquireMilliseconds: 0,
        },
      },
    );
    expect(caughtUpCapture).not.toHaveBeenCalled();
    expect(envelopes(caughtUp)).toEqual([]);
    expect(replayDiagnostics(caughtUp)[0]).toMatchObject({
      cursorSource: "explicit_query",
      outcome: "caught_up",
      replayedEventCount: 0,
    });

    for (const unavailableCursor of [
      hub.eventIdAt(0),
      hub.eventIdAt(999),
      "00000000-0000-4000-8000-000000000099.1",
    ]) {
      const response = new FakeResponse();
      const capture = vi.fn(async () => ({
        generation: "projection-1",
        snapshot: snapshot("Explicit fallback"),
      }));
      await serveThreadEventStream(
        asRequest(new FakeRequest()),
        asResponse(response),
        hub,
        source(hub, { capture }),
        {
          explicitReplayCursor: unavailableCursor,
          loadDiagnostics: {
            requestStartedAt: performance.now(),
            routeSetupMilliseconds: 0,
            runtimeAcquireMilliseconds: 0,
          },
        },
      );
      expect(capture).not.toHaveBeenCalled();
      expect(checkpoints(response)).toHaveLength(1);
      expect(replayDiagnostics(response)[0]).toMatchObject({
        cursorSource: "explicit_query",
        outcome: "snapshot_fallback",
        replayedEventCount: 0,
      });
    }
  });

  it("does not let heartbeats compete for drain authority during the handshake", async () => {
    vi.useFakeTimers();
    try {
      const hub = new ThreadEventHub();
      const request = new FakeRequest();
      const response = new FakeResponse();
      response.writeResult = () => false;
      const serving = serveThreadEventStream(
        asRequest(request),
        asResponse(response),
        hub,
        source(hub, {
          capture: async () => ({
            generation: "projection-1",
            snapshot: snapshot("Backpressured"),
          }),
        }),
        {
          heartbeatMilliseconds: 10,
          drainTimeoutMilliseconds: 1_000,
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(checkpoints(response)).toHaveLength(1);
      expect(response.listenerCount("drain")).toBe(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(response.writes).toHaveLength(1);
      expect(response.listenerCount("drain")).toBe(1);

      response.writeResult = () => true;
      response.emit("drain");
      await serving;
      expect(response.writes.at(-1)).toBe("event: thread-live\ndata: {}\n\n");

      await vi.advanceTimersByTimeAsync(10);
      expect(response.writes.at(-1)).toBe(": heartbeat\n\n");
      request.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an empty-hub source claiming a snapshot it never published", async () => {
    const hub = new ThreadEventHub();
    const response = new FakeResponse();
    await serveThreadEventStream(
      asRequest(new FakeRequest()),
      asResponse(response),
      hub,
      {
        publishAuthoritativeReplacement: async () => ({
          eventId: hub.eventIdAt(1),
          projectionGeneration: "projection-1",
          event: {
            type: "snapshot",
            generation: "projection-1",
            snapshot: snapshot(),
          },
        }),
      },
    );
    expect(response.end).toHaveBeenCalledOnce();
    expect(checkpoints(response)).toEqual([]);
    expect(envelopes(response)).toEqual([]);
    expect(loadErrors(response)).toHaveLength(1);
    expect(hub.watermark).toBe(0);
    expect(hub.subscriberCount).toBe(0);
  });
});
