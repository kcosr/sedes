import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationEventEnvelopeSchema,
  normalizedApplicationEventSchema,
  type NormalizedApplicationSnapshot,
  type ApplicationEventEnvelope,
} from "../../src/shared/protocol/application.js";
import type { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import { ApplicationEventHub } from "../../src/server/events/application-event-hub.js";
import { SseResponseWriter } from "../../src/server/events/sse-response-writer.js";
import { ClientResponseCompression } from "../../src/server/http/response-compression.js";
import {
  DEFAULT_APPLICATION_SSE_DRAIN_TIMEOUT_MILLISECONDS,
  DEFAULT_APPLICATION_SSE_PENDING_BYTE_LIMIT,
  DEFAULT_APPLICATION_SSE_PENDING_EVENT_LIMIT,
  serveApplicationEventStream as serveApplicationEventStreamWithWriter,
} from "../../src/server/events/application-sse.js";

function serveApplicationEventStream(request: Request, response: Response, hub: ApplicationEventHub,
  checkpoint: Parameters<typeof serveApplicationEventStreamWithWriter>[3],
  options?: Parameters<typeof serveApplicationEventStreamWithWriter>[4]) {
  return serveApplicationEventStreamWithWriter(request,
    new SseResponseWriter(request, response, new ClientResponseCompression(false)), hub, checkpoint, options);
}

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
  readonly destroy = vi.fn();
  readonly vary = vi.fn();
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

function renamedEnvironment(revision: number) {
  return {
    id: "environment-1",
    kind: "local" as const,
    label: { text: `Environment ${revision}` },
    available: true as const,
    directoryBrowsing: "available" as const,
  };
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
  projects: [{ id: "project-1", name: "Project", revision: 0 }],
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
      associatedProjectId: null,
      title: "Multibyte replay",
      details: "",
      pinned: false,
      backlog: false,
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
  it("closes both lanes when a transient frame cannot be written", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const unsubscribe = vi.fn();
    let transient!: (frame: string) => void;
    await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => ({ envelope: baseline }), {
        subscribeTransient: listener => { transient = listener; return unsubscribe; },
      });
    response.writeResult = () => { throw new Error("socket unavailable"); };
    expect(() => transient('event: notification\ndata: {}\n\n')).not.toThrow();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const writes = response.writes.length;
    hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(0) });
    expect(response.writes).toHaveLength(writes);
  });

  it.each(["subscription", "policy read"] as const)(
    "keeps inventory live without a transient lane when its %s fails",
    async (failure) => {
      const hub = new ApplicationEventHub();
      const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
      const request = new FakeRequest();
      const response = new FakeResponse();
      const onError = vi.fn();
      const repository = { readDispatch: () => { throw new Error("stored policy invalid"); } } as unknown as NotificationRepository;
      const notifications = new NotificationService({ repository, onError });
      const scope = { tenantId: "tenant", principalId: "owner" };
      await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
        async () => ({ envelope: baseline }), {
          subscribeTransient: failure === "subscription"
            ? () => { throw new Error("transient lane unavailable"); }
            : listener => notifications.subscribe(scope, listener),
        });
      expect(envelopes(response)).toEqual([baseline]);
      expect(response.writes.at(-1)).toBe("event: application-live\ndata: {}\n\n");
      const update = hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(1) });
      expect(envelopes(response)).toEqual([baseline, update]);
      expect(response.writes.join("")).not.toContain("event: notification");
      expect(response.end).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(failure === "policy read" ? 1 : 0);
      request.emit("close");
      await notifications.close();
      hub.close();
    },
  );

  it("closes both lanes when transient frames overflow the shared handshake buffer", async () => {
    const hub = new ApplicationEventHub();
    hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    let release!: (value: { envelope: ApplicationEventEnvelope }) => void;
    const checkpoint = new Promise<{ envelope: ApplicationEventEnvelope }>(resolve => { release = resolve; });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const unsubscribe = vi.fn();
    let transient!: (frame: string) => void;
    const serving = serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub, () => checkpoint, {
      pendingEventLimit: 2,
      subscribeTransient: listener => { transient = listener; return unsubscribe; },
    });
    hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(1) });
    transient('event: notification\ndata: {"sourceEventId":"1"}\n\n');
    expect(response.end).not.toHaveBeenCalled();
    transient('event: notification\ndata: {"sourceEventId":"2"}\n\n');
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    release({ envelope: hub.currentCheckpoint()! });
    await serving;
    hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(2) });
    expect(response.writes).toEqual([]);
    hub.close();
  });

  it("queues transient frames behind a live drain and closes both lanes when they overflow", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const unsubscribe = vi.fn();
    let transient!: (frame: string) => void;
    const frame = (id: number) => `event: notification\ndata: {"sourceEventId":"${id}"}\n\n`;
    await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => ({ envelope: baseline }), {
        pendingByteLimit: Buffer.byteLength(frame(1), "utf8") * 2,
        subscribeTransient: listener => { transient = listener; return unsubscribe; },
      });
    response.writeResult = () => false;
    transient(frame(1));
    transient(frame(2));
    expect(response.writes.at(-1)).toBe(frame(1));
    expect(response.listenerCount("drain")).toBe(1);
    response.writeResult = () => true;
    response.emit("drain");
    expect(response.writes.slice(-2)).toEqual([frame(1), frame(2)]);
    response.writeResult = () => false;
    transient(frame(3));
    transient(frame(4));
    transient(frame(5));
    expect(response.end).not.toHaveBeenCalled();
    transient(frame(6));
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.writes.at(-1)).toBe(frame(3));
    hub.close();
  });

  it("keeps transient policy and notifications outside inventory replay and snapshot supersession", async () => {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    let release!: (value: { envelope: ApplicationEventEnvelope }) => void;
    const checkpoint = new Promise<{ envelope: ApplicationEventEnvelope }>(resolve => { release = resolve; });
    const request = new FakeRequest();
    const response = new FakeResponse();
    let transient!: (frame: string) => void;
    const unsubscribe = vi.fn();
    const serving = serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub, () => checkpoint, {
      subscribeTransient: listener => { transient = listener; listener('event: notification_policy\ndata: {"generation":1}\n\n'); return unsubscribe; },
    });
    transient('event: notification\ndata: {"sourceEventId":"one"}\n\n');
    const replacement = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    release({ envelope: replacement });
    await serving;
    const special = response.writes.filter(frame => frame.startsWith("event: notification"));
    expect(special).toHaveLength(2);
    expect(special[0]).toContain("notification_policy");
    expect(special.join("")).not.toMatch(/^id:/m);
    expect(hub.watermark).toBe(2);
    expect(hub.subscribe(() => {}, baseline.eventId).replay).toEqual([]);
    response.emit("close");
    expect(unsubscribe).toHaveBeenCalledOnce();
    hub.close();
  });
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
          type: "environment_upsert",
          generation: hub.generation,
          environment: renamedEnvironment(index + 1),
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
          expect(current.event.snapshot.environments[0]!.label.text).toBe(`Environment ${gap}`);
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
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
        type: "environment_upsert",
        generation: hub.generation,
        environment: renamedEnvironment(3),
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(2),
    });
    resolveCapture({
      ...emptySnapshot,
      environments: [renamedEnvironment(2)],
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
            environments: [renamedEnvironment(2)],
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
              projects: [{ id: "project-1", name: "Project", revision: 0 }],
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
    });
    const secondUpdate = hub.publish({
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(2),
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const replacement = vi.fn(async () => ({
      envelope: hub.publish({
        type: "snapshot",
        generation: hub.generation,
        snapshot: {
          ...emptySnapshot,
          environments: [renamedEnvironment(2)],
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
      snapshot: { environments: [renamedEnvironment(2)] },
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
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
    for (const revision of [1, 2]) {
      hub.publish({
        type: "environment_upsert",
        generation: hub.generation,
        environment: renamedEnvironment(revision),
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
    for (let revision = 1; revision <= 5000; revision++)
      hub.publish({
        type: "environment_upsert",
        generation: hub.generation,
        environment: renamedEnvironment(revision),
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
        snapshot: { environments: [renamedEnvironment(5000)] },
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

  it("bounds only changes queued behind an oversized live replacement", async () => {
    const hub = new ApplicationEventHub();
    const initial = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: emptySnapshot,
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    await serveApplicationEventStream(
      request as unknown as Request,
      response as unknown as Response,
      hub,
      async () => ({ envelope: hub.currentCheckpoint()! }),
      { pendingByteLimit: hub.encoded(initial).bytes },
    );
    expect(envelopes(response)).toEqual([initial]);
    response.writeResult = () => false;
    const blocked = hub.publish({
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
    });
    const replacement = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: { ...emptySnapshot, environments: [renamedEnvironment(2)] },
    });
    expect(hub.encoded(replacement).bytes).toBeGreaterThan(hub.encoded(initial).bytes);
    const later = hub.publish({
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(3),
    });
    response.writeResult = () => true;
    response.emit("drain");
    expect(envelopes(response)).toEqual([initial, blocked, replacement, later]);
    expect(response.end).not.toHaveBeenCalled();
    request.emit("close");
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
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(1),
    });
    const replacement = hub.publish({
      type: "snapshot",
      generation: hub.generation,
      snapshot: {
        ...emptySnapshot,
        environments: [renamedEnvironment(2)],
      },
    });
    const later = hub.publish({
      type: "environment_upsert",
      generation: hub.generation,
      environment: renamedEnvironment(3),
    });
    response.writeResult = () => true;
    response.emit("drain");
    await serving;
    expect(envelopes(response).slice(1)).toEqual([replacement, later]);
    hub.close();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.listenerCount("drain")).toBe(0);
  });
});

describe("application stream close diagnostics", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  function captureDiagnostics() {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => log.mock.calls.map(([line]) => JSON.parse(String(line).slice("[delivery-voice] ".length)));
  }

  function fixture() {
    const hub = new ApplicationEventHub();
    const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: emptySnapshot });
    return { hub, baseline, request: new FakeRequest(), response: new FakeResponse() };
  }

  it.each(["request", "response", "hub"] as const)("records one close when the %s closes", async (source) => {
    const records = captureDiagnostics();
    const { hub, baseline, request, response } = fixture();
    await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => ({ envelope: baseline }));
    if (source === "hub") hub.close();
    else if (source === "request") request.emit("close");
    else response.emit("close");
    request.emit("close");
    response.emit("close");
    hub.close();
    expect(records()).toEqual([{
      event: "application_stream_closed", timestamp: expect.any(String),
      reason: source === "hub" ? "hub_closed" : "client_closed", live: true,
      pendingEventCount: 0, pendingBytes: 0, transientEventCount: 0, transientBytes: 0,
      durationMs: expect.any(Number),
    }]);
    expect(request.listenerCount("close")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("captures both queue sizes before transient overflow clears the stream", async () => {
    const records = captureDiagnostics();
    const { hub, baseline, request, response } = fixture();
    let release!: () => void;
    const capture = new Promise<void>(resolve => { release = resolve; });
    let transient!: (frame: string) => void;
    const serving = serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => { await capture; return { envelope: baseline }; }, {
        pendingEventLimit: 2,
        subscribeTransient: listener => { transient = listener; return () => {}; },
      });
    const event = hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(0) });
    const frame = 'event: notification\ndata: {"message":"private speech 😀"}\n\n';
    transient(frame);
    transient(frame);
    release();
    await serving;
    expect(records()).toEqual([{
      event: "application_stream_closed", timestamp: expect.any(String), reason: "transient_overflow", live: false,
      pendingEventCount: 1, pendingBytes: hub.encoded(event).bytes,
      transientEventCount: 1, transientBytes: Buffer.byteLength(frame, "utf8"), durationMs: expect.any(Number),
    }]);
    expect(JSON.stringify(records())).not.toContain("private speech");
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it("identifies inventory overflow without logging queued content", async () => {
    const records = captureDiagnostics();
    const { hub, baseline, request, response } = fixture();
    let release!: () => void;
    const capture = new Promise<void>(resolve => { release = resolve; });
    const serving = serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => { await capture; return { envelope: baseline }; }, { pendingEventLimit: 1 });
    const event = hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(0) });
    hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(0) });
    release();
    await serving;
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ reason: "overflow", live: false, pendingEventCount: 1, pendingBytes: hub.encoded(event).bytes });
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it("records drain timeout and clears the existing drain owner", async () => {
    const records = captureDiagnostics();
    vi.useFakeTimers();
    const { hub, baseline, request, response } = fixture();
    let transient!: (frame: string) => void;
    await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => ({ envelope: baseline }), {
        drainTimeoutMilliseconds: 100,
        subscribeTransient: listener => { transient = listener; return () => {}; },
      });
    response.writeResult = () => false;
    transient("event: notification\ndata: {}\n\n");
    transient("event: notification\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(100);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ reason: "drain_timeout", live: true, transientEventCount: 1, transientBytes: 30 });
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it.each(["write", "handshake"] as const)("does not log raw %s errors", async (source) => {
    const records = captureDiagnostics();
    const { hub, baseline, request, response } = fixture();
    await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
      async () => {
        if (source === "handshake") throw new Error("private checkpoint failure");
        return { envelope: baseline };
      });
    if (source === "write") {
      response.writeResult = () => { throw new Error("private socket failure"); };
      hub.publish({ type: "environment_upsert", generation: hub.generation, environment: renamedEnvironment(0) });
    }
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ reason: source === "write" ? "stream_error" : "handshake_error", live: source === "write" });
    expect(JSON.stringify(records())).not.toContain("private");
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it("stays silent while disabled and still closes when stderr throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("stderr unavailable"); });
    for (const gate of ["", "1"]) {
      vi.stubEnv("SEDES_DEBUG_DELIVERY", gate);
      const { hub, baseline, request, response } = fixture();
      await serveApplicationEventStream(request as unknown as Request, response as unknown as Response, hub,
        async () => ({ envelope: baseline }));
      expect(() => hub.close()).not.toThrow();
      expect(response.destroy).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledTimes(gate ? 1 : 0);
    }
  });
});
