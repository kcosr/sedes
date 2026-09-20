import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  applicationEventEnvelopeSchema,
  normalizedApplicationEventSchema,
  type NormalizedApplicationSnapshot,
  type ApplicationEventEnvelope,
} from "../../src/shared/protocol/application.js";
import { ApplicationEventHub } from "../../src/server/events/application-event-hub.js";
import {
  DEFAULT_APPLICATION_SSE_DRAIN_TIMEOUT_MILLISECONDS,
  DEFAULT_APPLICATION_SSE_PENDING_BYTE_LIMIT,
  DEFAULT_APPLICATION_SSE_PENDING_EVENT_LIMIT,
  serveApplicationEventStream,
} from "../../src/server/events/application-sse.js";

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
  write(value: string): boolean {
    this.writes.push(value);
    return this.writeResult(value);
  }
}

function envelopes(response: FakeResponse): ApplicationEventEnvelope[] {
  return response.writes.flatMap((write) =>
    write
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .flatMap((line) => {
        const value = JSON.parse(line.slice(6)) as Record<string, unknown>;
        return typeof value.eventId === "string"
          ? [applicationEventEnvelopeSchema.parse(value)]
          : [];
      }),
  );
}

const emptySnapshot: NormalizedApplicationSnapshot = {
  environments: [
    {
      id: "environment-1",
      kind: "local",
      label: { text: "Local" },
      available: true,
      directoryBrowsing: "available",
    },
  ],
  workspaces: [],
  threads: [],
  forkOrigins: [],
  lineagePlacements: [],
  groups: [],
  lineageFamilies: [],
  executionTargets: [
    {
      id: "target-1",
      environmentId: "environment-1",
      label: { text: "Local SDK" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      workspaceExecution: { kind: "direct_only" },
      available: true,
    },
  ],
  advisories: [],
  defaultNewThreadTargetId: "target-1",
  counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
  tasks: [],
};

function publishByteBoundarySuffix(
  hub: ApplicationEventHub,
  totalBytes: number,
) {
  const first = hub.publish({
    type: "workpad_changed",
    generation: hub.generation,
    workpadId: "workpad",
    revision: 1,
    change: "draft",
  });
  const event = normalizedApplicationEventSchema.parse({
    type: "task_upsert",
    generation: hub.generation,
    task: {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" },
      associatedWorkspaceId: null,
      title: "Multibyte replay",
      details: "",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 1,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    },
  });
  if (event.type !== "task_upsert") throw new Error("fixture_event_invalid");
  const envelope: ApplicationEventEnvelope = {
    eventId: hub.eventIdAt(hub.watermark + 1),
    applicationGeneration: hub.generation,
    event,
  };
  const emptyFrame = `id: ${envelope.eventId}\nevent: application\ndata: ${JSON.stringify(envelope)}\n\n`;
  const detailsBytes =
    totalBytes -
    hub.encoded(first).bytes -
    Buffer.byteLength(emptyFrame, "utf8");
  event.task.details =
    "😀".repeat(Math.floor(detailsBytes / 4)) + "a".repeat(detailsBytes % 4);
  return [first, hub.publish(event)] as const;
}

describe("serveApplicationEventStream", () => {
  it.each([31, 32, 33])(
    "selects replay or one current checkpoint for a %i-event gap without constructing rejected replay",
    async (gap) => {
      const hub = new ApplicationEventHub();
      const baseline = hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot: emptySnapshot,
      });
      const events = Array.from({ length: gap }, (_, index) =>
        hub.publish({
          type: "inventory_counts_changed",
          generation: hub.generation,
          counts: { ...emptySnapshot.counts, active: index + 1 },
        }),
      );
      const request = new FakeRequest(baseline.eventId);
      const response = new FakeResponse();
      const checkpoint = vi.fn(async () => ({
        envelope: hub.currentCheckpoint()!,
      }));
      const subscribe = vi.spyOn(hub, "subscribe");
      const encode = vi.spyOn(hub, "encoded");
      try {
        await serveApplicationEventStream(
          request as unknown as Request,
          response as unknown as Response,
          hub,
          checkpoint,
        );
        const allowed = gap <= 32;
        expect(subscribe).toHaveBeenCalledExactlyOnceWith(
          expect.any(Function),
          allowed ? baseline.eventId : undefined,
        );
        expect(subscribe.mock.results[0]!.value.replay).toEqual(
          allowed ? events : [],
        );
        if (allowed) {
          expect(checkpoint).not.toHaveBeenCalled();
          expect(envelopes(response)).toEqual(events);
        } else {
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith(false);
          const current = hub.currentCheckpoint()!;
          expect(envelopes(response)).toEqual([current]);
          expect(current.event.snapshot.counts.active).toBe(gap);
          expect(encode.mock.calls.map(([event]) => event)).toEqual([current]);
        }
        expect(hub.watermark).toBe(gap + 1);
        expect(response.writes.at(-1)).toBe(
          "event: application-live\ndata: {}\n\n",
        );
      } finally {
        request.emit("close");
        subscribe.mockRestore();
        encode.mockRestore();
        hub.close();
      }
    },
  );

  it.each([65_535, 65_536, 65_537])(
    "selects replay or one current checkpoint at %i encoded UTF-8 bytes",
    async (totalBytes) => {
      const hub = new ApplicationEventHub();
      const baseline = hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot: emptySnapshot,
      });
      const events = publishByteBoundarySuffix(hub, totalBytes);
      expect(
        events.reduce((sum, event) => sum + hub.encoded(event).bytes, 0),
      ).toBe(totalBytes);
      expect(hub.encoded(events[1]).bytes).toBeGreaterThan(
        hub.encoded(events[1]).frame.length,
      );
      const request = new FakeRequest(baseline.eventId);
      const response = new FakeResponse();
      const checkpoint = vi.fn(async () => ({
        envelope: hub.currentCheckpoint()!,
      }));
      const subscribe = vi.spyOn(hub, "subscribe");
      const encode = vi.spyOn(hub, "encoded");
      try {
        await serveApplicationEventStream(
          request as unknown as Request,
          response as unknown as Response,
          hub,
          checkpoint,
        );
        const allowed = totalBytes <= 65_536;
        expect(subscribe).toHaveBeenCalledExactlyOnceWith(
          expect.any(Function),
          allowed ? baseline.eventId : undefined,
        );
        expect(subscribe.mock.results[0]!.value.replay).toEqual(
          allowed ? events : [],
        );
        if (allowed) {
          expect(checkpoint).not.toHaveBeenCalled();
          expect(envelopes(response)).toEqual(events);
          expect(
            response.writes
              .slice(0, -1)
              .reduce(
                (sum, frame) => sum + Buffer.byteLength(frame, "utf8"),
                0,
              ),
          ).toBe(totalBytes);
        } else {
          const current = hub.currentCheckpoint()!;
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith(false);
          expect(envelopes(response)).toEqual([current]);
          expect(current.event.snapshot.tasks).toHaveLength(1);
          expect(current.event.snapshot.tasks[0]?.details).toContain("😀");
          expect(encode.mock.calls.map(([event]) => event)).toEqual([current]);
        }
        expect(hub.watermark).toBe(3);
        expect(response.writes.at(-1)).toBe(
          "event: application-live\ndata: {}\n\n",
        );
      } finally {
        request.emit("close");
        subscribe.mockRestore();
        encode.mockRestore();
        hub.close();
      }
    },
  );

  it("uses the slow-client handshake defaults", () => {
    expect(DEFAULT_APPLICATION_SSE_PENDING_EVENT_LIMIT).toBe(2_048);
    expect(DEFAULT_APPLICATION_SSE_PENDING_BYTE_LIMIT).toBe(16 * 1_024 * 1_024);
    expect(DEFAULT_APPLICATION_SSE_DRAIN_TIMEOUT_MILLISECONDS).toBe(30_000);
  });

  it("publishes a real snapshot that supersedes crossing changes", async () => {
    const hub = new ApplicationEventHub();
    const retained = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const historical = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    let resolveCapture!: (value: NormalizedApplicationSnapshot) => void;
    let postSnapshot!: ApplicationEventEnvelope;
    const captured = new Promise<NormalizedApplicationSnapshot>((resolve) => {
      resolveCapture = resolve;
    });
    const publishAuthoritativeReplacement = vi.fn(async () => {
      const snapshot = await captured;
      const envelope = hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot,
      });
      postSnapshot = hub.publish({
        type: "inventory_counts_changed",
        generation: hub.generation,
        counts: { active: 3, snoozed: 0, settled: 0, archived: 0 },
      });
      if (envelope.event.type !== "snapshot") throw new Error("unreachable");
      return {
        envelope,
        snapshot,
      };
    });
    const serving = serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      publishAuthoritativeReplacement,
    );
    const crossing = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
    });
    resolveCapture({
      ...emptySnapshot,
      counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
    });
    await serving;

    expect(publishAuthoritativeReplacement).toHaveBeenCalledOnce();
    expect(retained.eventId).toBe(hub.eventIdAt(1));
    expect(historical.eventId).toBe(hub.eventIdAt(2));
    expect(crossing.eventId).toBe(hub.eventIdAt(3));
    expect(envelopes(response)).toEqual([
      expect.objectContaining({
        eventId: hub.eventIdAt(4),
        event: expect.objectContaining({
          type: "snapshot",
          snapshot: expect.objectContaining({
            counts: expect.objectContaining({ active: 2 }),
          }),
        }),
      }),
      postSnapshot,
    ]);
    request.emit("close");
  });

  it("does not let heartbeats compete for drain authority during the handshake", async () => {
    vi.useFakeTimers();
    try {
      const hub = new ApplicationEventHub();
      const request = new FakeRequest();
      const response = new FakeResponse();
      response.writeResult = () => false;
      const serving = serveApplicationEventStream(
        request as unknown as Request,
        response as unknown as Response,
        hub,
        async () => ({
          envelope: hub.publish({
            type: "snapshot",
            generation: hub.generation,
            snapshot: {
              environments: [
                {
                  id: "environment-1",
                  kind: "local" as const,
                  label: { text: "Local" },
                  available: true,
                  directoryBrowsing: "available" as const,
                },
              ],
              workspaces: [],
              threads: [],
              forkOrigins: [],
              lineagePlacements: [],
              groups: [],
              lineageFamilies: [],
              executionTargets: [
                {
                  id: "target-1",
                  environmentId: "environment-1",
                  label: { text: "Local SDK" },
                  backend: { label: { text: "Pi" }, brand: "pi" },
                  workspaceExecution: { kind: "direct_only" },
                  available: true,
                },
              ],
              defaultNewThreadTargetId: "target-1",
              counts: {
                active: 0,
                snoozed: 0,
                settled: 0,
                archived: 0,
              },
              advisories: [],
              tasks: [],
            },
          }),
        }),
        {
          heartbeatMilliseconds: 10,
          drainTimeoutMilliseconds: 1_000,
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(envelopes(response)).toHaveLength(1);
      expect(response.listenerCount("drain")).toBe(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(response.writes).toHaveLength(1);
      expect(response.listenerCount("drain")).toBe(1);

      response.writeResult = () => true;
      response.emit("drain");
      await serving;
      expect(response.writes.at(-1)).toBe(
        "event: application-live\ndata: {}\n\n",
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(response.writes.at(-1)).toBe(": heartbeat\n\n");
      request.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays only events after an explicit native resume cursor", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const update = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const replacement = vi.fn();

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { explicitReplayCursor: baseline.eventId },
    );

    expect(replacement).not.toHaveBeenCalled();
    expect(envelopes(response)).toEqual([update]);
    request.emit("close");
  });

  it("uses Last-Event-ID before the original query cursor on automatic retry", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const firstUpdate = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const secondUpdate = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
    });
    const request = new FakeRequest(firstUpdate.eventId);
    const response = new FakeResponse();
    const replacement = vi.fn();

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { explicitReplayCursor: baseline.eventId },
    );

    expect(replacement).not.toHaveBeenCalled();
    expect(envelopes(response)).toEqual([secondUpdate]);
    request.emit("close");
  });

  it("uses a current checkpoint for a generation-mismatched explicit cursor", async () => {
    const hub = new ApplicationEventHub();
    hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const staleHub = new ApplicationEventHub();
    const request = new FakeRequest();
    const response = new FakeResponse();
    const replacement = vi.fn(async () => ({
      envelope: hub.currentCheckpoint()!,
    }));

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { explicitReplayCursor: staleHub.eventIdAt(0) },
    );

    expect(replacement).toHaveBeenCalledWith(false);
    expect(envelopes(response)).toEqual([hub.currentCheckpoint()]);
    expect(hub.watermark).toBe(2);
    request.emit("close");
  });

  it("bypasses the current checkpoint for an explicit authoritative replacement", async () => {
    const hub = new ApplicationEventHub();
    hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const replacement = vi.fn(async () => ({
      envelope: hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot: {
          ...emptySnapshot,
          counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
        },
      }),
    }));

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { initialHandshake: "authoritative_replacement" },
    );

    expect(replacement).toHaveBeenCalledOnce();
    expect(envelopes(response)).toHaveLength(1);
    expect(envelopes(response)[0]?.event).toMatchObject({
      type: "snapshot",
      snapshot: { counts: { active: 2 } },
    });
    request.emit("close");
  });

  it("lets Last-Event-ID resume an automatic retry of a replacement handshake", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const update = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    });
    const request = new FakeRequest(baseline.eventId);
    const response = new FakeResponse();
    const replacement = vi.fn();

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { initialHandshake: "authoritative_replacement" },
    );

    expect(replacement).not.toHaveBeenCalled();
    expect(envelopes(response)).toEqual([update]);
    request.emit("close");
  });

  it("emits one snapshot fallback when a same-generation cursor expired", async () => {
    const hub = new ApplicationEventHub({ replayLimit: 1 });
    const baseline = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    for (const active of [1, 2]) {
      hub.publish({
        type: "inventory_counts_changed",
        generation: hub.generation,
        counts: { active, snoozed: 0, settled: 0, archived: 0 },
      });
    }
    expect(hub.canReplay(baseline.eventId)).toBe(false);
    const request = new FakeRequest();
    const response = new FakeResponse();
    const replacement = vi.fn(async () => ({
      envelope: hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot: emptySnapshot,
      }),
    }));

    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      replacement,
      { explicitReplayCursor: baseline.eventId },
    );

    expect(replacement).toHaveBeenCalledOnce();
    expect(envelopes(response)).toHaveLength(1);
    expect(envelopes(response)[0]?.event.type).toBe("snapshot");
    request.emit("close");
  });
  it("replaces thousands of missed changes with one current checkpoint", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    for (let active = 1; active <= 5000; active++)
      hub.publish({
        type: "inventory_counts_changed",
        generation: hub.generation,
        counts: { ...emptySnapshot.counts, active },
      });
    const listener = vi.fn();
    const existing = hub.subscribe(listener);
    const checkpoint = vi.fn(async () => ({
      envelope: hub.currentCheckpoint()!,
    }));
    const requests = [new FakeRequest(baseline.eventId), new FakeRequest()];
    const responses = [new FakeResponse(), new FakeResponse()];
    await Promise.all(
      requests.map((request, i) =>
        serveApplicationEventStream(
          request as unknown as Request,
          responses[i] as unknown as Response,
          hub,
          checkpoint,
        ),
      ),
    );
    for (const response of responses) {
      expect(envelopes(response)).toEqual([hub.currentCheckpoint()]);
      expect(envelopes(response)[0]?.event).toMatchObject({
        type: "snapshot",
        snapshot: { counts: { active: 5000 } },
      });
    }
    expect(hub.watermark).toBe(5001);
    expect(listener).not.toHaveBeenCalled();
    expect(responses[0]!.writes).toEqual(responses[1]!.writes);
    requests.forEach((request) => request.emit("close"));
    existing.close();
  });

  it("keeps a delayed pre-live capture alive with one heartbeat drain owner", async () => {
    vi.useFakeTimers();
    try {
      const hub = new ApplicationEventHub();
      const request = new FakeRequest();
      const response = new FakeResponse();
      response.writeResult = () => false;
      let finish!: () => void;
      const capture = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const serving = serveApplicationEventStream(
        request as unknown as Request,
        response as unknown as Response,
        hub,
        async () => {
          await capture;
          return {
            envelope: hub.publish({
              type: "snapshot",
              generation: hub.generation,
              snapshot: emptySnapshot,
            }),
          };
        },
        { heartbeatMilliseconds: 10, drainTimeoutMilliseconds: 1000 },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(response.writes).toEqual([": heartbeat\n\n"]);
      finish();
      await vi.advanceTimersByTimeAsync(50);
      expect(response.writes).toHaveLength(1);
      expect(response.listenerCount("drain")).toBe(1);
      response.writeResult = () => true;
      response.emit("drain");
      await serving;
      expect(envelopes(response)).toHaveLength(1);
      expect(response.writes.at(-1)).toContain("application-live");
      expect(response.listenerCount("drain")).toBe(0);
      request.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes pending changes during backpressure and closes on hub retirement", async () => {
    const hub = new ApplicationEventHub();
    hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    response.writeResult = () => false;
    const serving = serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      async () => ({ envelope: hub.currentCheckpoint()! }),
    );
    await vi.waitFor(() => expect(envelopes(response)).toHaveLength(1));
    hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { ...emptySnapshot.counts, active: 1 },
    });
    const replacement = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: {
        ...emptySnapshot,
        counts: { ...emptySnapshot.counts, active: 2 },
      },
    });
    const later = hub.publish({
      type: "inventory_counts_changed",
      generation: hub.generation,
      counts: { ...emptySnapshot.counts, active: 3 },
    });
    response.writeResult = () => true;
    response.emit("drain");
    await serving;
    expect(envelopes(response).slice(1)).toEqual([replacement, later]);
    hub.close();
    expect(response.end).toHaveBeenCalledOnce();
    expect(response.listenerCount("drain")).toBe(0);
  });
});
