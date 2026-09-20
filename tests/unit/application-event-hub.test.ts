import { describe, expect, it, vi } from "vitest";
import {
  ApplicationEventHub,
  DEFAULT_APPLICATION_EVENT_HUB_IDLE_RETENTION_MILLISECONDS,
  DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT,
  DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT,
  ScopedApplicationEventHubs,
} from "../../src/server/events/application-event-hub.js";
import { EventHub } from "../../src/server/events/event-hub.js";
import {
  normalizedApplicationEventSchema,
  type ApplicationEventEnvelope,
} from "../../src/shared/protocol/application.js";

const emptySnapshot = {
  environments: [
    {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Local" },
      available: true as const,
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
      backend: { label: { text: "Pi" }, brand: "pi" as const },
      workspaceExecution: { kind: "direct_only" as const },
      available: true as const,
    },
  ],
  advisories: [],
  defaultNewThreadTargetId: "target-1",
  counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
  tasks: [],
};

function seed(hub: ApplicationEventHub) {
  return hub.publish({
    type: "snapshot",
    generation: hub.generation,
    snapshot: emptySnapshot,
  });
}
function count(hub: ApplicationEventHub, active: number) {
  return hub.publish({
    type: "inventory_counts_changed",
    generation: hub.generation,
    counts: { ...emptySnapshot.counts, active },
  });
}
const scope = { tenantId: "tenant", principalId: "owner" };

/** Two individually admissible frames whose combined UTF-8 size is exact. */
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
  const second = hub.publish(event);
  return [first, second] as const;
}

describe("ApplicationEventHub", () => {
  it.each([31, 32, 33])(
    "admits exactly %i missed events according to the 32-event boundary",
    (gap) => {
      const hub = new ApplicationEventHub();
      const baseline = seed(hub);
      const events = Array.from({ length: gap }, (_, index) =>
        count(hub, index + 1),
      );
      const allowed = gap <= 32;
      expect(hub.canReplay(baseline.eventId)).toBe(allowed);
      expect(hub.retainedEventCount).toBe(Math.min(gap, 32));
      const subscription = hub.subscribe(vi.fn(), baseline.eventId);
      expect(subscription.replay).toEqual(allowed ? events : []);
      expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(gap);
      expect(hub.watermark).toBe(gap + 1);
      subscription.close();
      hub.close();
    },
  );

  it.each([65_535, 65_536, 65_537])(
    "accounts for exactly %i encoded suffix bytes including multibyte data and framing",
    (totalBytes) => {
      const hub = new ApplicationEventHub();
      const baseline = seed(hub);
      const events = publishByteBoundarySuffix(hub, totalBytes);
      const frames = events.map((event) => hub.encoded(event));
      expect(frames.reduce((sum, frame) => sum + frame.bytes, 0)).toBe(
        totalBytes,
      );
      for (const frame of frames)
        expect(frame.bytes).toBe(Buffer.byteLength(frame.frame, "utf8"));
      expect(frames[1]!.bytes).toBeGreaterThan(frames[1]!.frame.length);
      expect(frames[1]!.bytes).toBeLessThan(65_536);
      // Payload-only accounting would incorrectly admit the one-byte-over case.
      expect(
        events.reduce(
          (sum, event) =>
            sum + Buffer.byteLength(JSON.stringify(event.event), "utf8"),
          0,
        ),
      ).toBeLessThan(65_536);
      const allowed = totalBytes <= 65_536;
      expect(hub.canReplay(baseline.eventId)).toBe(allowed);
      expect(hub.retainedEventCount).toBe(allowed ? 2 : 1);
      expect(hub.retainedBytes).toBe(allowed ? totalBytes : frames[1]!.bytes);
      const subscription = hub.subscribe(vi.fn(), baseline.eventId);
      expect(subscription.replay).toEqual(allowed ? events : []);
      expect(hub.canReplay(events[0].eventId)).toBe(true);
      expect(hub.currentCheckpoint()?.event.snapshot.tasks).toHaveLength(1);
      subscription.close();
      hub.close();
    },
  );

  it("keeps explicit count and byte admission guards independent of replay retention", () => {
    const hub = new ApplicationEventHub();
    const baseline = seed(hub);
    for (let index = 1; index <= 32; index++) count(hub, index);
    // Simulate a future wider retention policy. Admission must still enforce
    // its own exact limits rather than rely solely on retained-suffix presence.
    const retained = vi
      .spyOn(EventHub.prototype, "canReplay")
      .mockReturnValue(true);
    const retainedBytes = vi.spyOn(EventHub.prototype, "replayBytesAfter");
    try {
      for (const size of [65_535, 65_536, 65_537]) {
        retainedBytes.mockReturnValue(size);
        expect(hub.canReplay(baseline.eventId)).toBe(size <= 65_536);
      }
      count(hub, 33);
      retainedBytes.mockClear().mockReturnValue(0);
      expect(hub.canReplay(baseline.eventId)).toBe(false);
      expect(retainedBytes).not.toHaveBeenCalled();
    } finally {
      retained.mockRestore();
      retainedBytes.mockRestore();
      hub.close();
    }
  });

  it("retains only a small count/byte bounded suffix", () => {
    expect(DEFAULT_APPLICATION_EVENT_HUB_IDLE_RETENTION_MILLISECONDS).toBe(
      3_600_000,
    );
    expect(DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT).toBe(32);
    expect(DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT).toBe(65_536);
    const hub = new ApplicationEventHub({
      replayLimit: 8192,
      replayByteLimit: 64 * 1024 * 1024,
    });
    const baseline = seed(hub);
    for (let i = 1; i <= 5000; i++) count(hub, i);
    expect(hub.retainedEventCount).toBe(32);
    expect(hub.retainedBytes).toBeLessThanOrEqual(65_536);
    expect(hub.canReplay(baseline.eventId)).toBe(false);
    expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(5000);
  });

  it("requires a validated seed before incremental publication", () => {
    const hub = new ApplicationEventHub();
    expect(() => count(hub, 1)).toThrow(
      "application_projection_snapshot_required",
    );
    expect(hub.watermark).toBe(0);
    expect(() =>
      hub.publish({
        type: "snapshot",
        generation: "foreign",
        snapshot: emptySnapshot,
      }),
    ).toThrow("application_event_generation_mismatch");
  });

  it("keeps snapshots out of replay and establishes a new replay floor", () => {
    const hub = new ApplicationEventHub();
    const first = seed(hub);
    count(hub, 1);
    const next = seed(hub);
    expect(hub.retainedEventCount).toBe(0);
    expect(hub.retainedBytes).toBe(0);
    expect(hub.canReplay(first.eventId)).toBe(false);
    expect(hub.canReplay(next.eventId)).toBe(true);
    const update = count(hub, 2);
    expect(hub.subscribe(vi.fn(), next.eventId).replay).toEqual([update]);
  });

  it("commits state, replay and sequence before synchronous subscriber reentry", () => {
    const hub = new ApplicationEventHub();
    const baseline = seed(hub);
    const observations: unknown[] = [];
    hub.subscribe((event) => {
      observations.push({
        count: hub.currentCheckpoint()?.event.snapshot.counts.active,
        eventId: hub.currentCheckpoint()?.eventId,
        expectedId: event.eventId,
        replay: hub.subscribe(vi.fn(), baseline.eventId).replay,
      });
    });
    const event = count(hub, 1);
    expect(observations).toEqual([
      {
        count: 1,
        eventId: event.eventId,
        expectedId: event.eventId,
        replay: [event],
      },
    ]);
  });

  it("reuses the encoded checkpoint without advancing or broadcasting", () => {
    const hub = new ApplicationEventHub();
    seed(hub);
    count(hub, 1);
    const listener = vi.fn();
    hub.subscribe(listener);
    const checkpoint = hub.currentCheckpoint()!;
    expect(hub.currentCheckpoint()).toBe(checkpoint);
    expect(hub.encoded(checkpoint)).toBe(hub.encoded(hub.currentCheckpoint()!));
    expect(hub.encoded(checkpoint).bytes).toBe(
      Buffer.byteLength(hub.encoded(checkpoint).frame),
    );
    expect(hub.watermark).toBe(2);
    expect(listener).not.toHaveBeenCalled();
    count(hub, 2);
    expect(checkpoint.event.snapshot.counts.active).toBe(1);
    expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(2);
  });

  it("counts actual encoded SSE bytes and drops individually oversized deltas", () => {
    const hub = new ApplicationEventHub({ replayByteLimit: 1 });
    const initial = seed(hub);
    const update = count(hub, 1);
    expect(hub.retainedEventCount).toBe(0);
    expect(hub.canReplay(initial.eventId)).toBe(false);
    expect(hub.canReplay(update.eventId)).toBe(true);
    const normal = new ApplicationEventHub();
    seed(normal);
    const event = count(normal, 1);
    expect(normal.retainedBytes).toBe(normal.encoded(event).bytes);
  });

  it("does not consume sequence or invoke listeners when fold preparation fails", () => {
    const hub = new ApplicationEventHub();
    seed(hub);
    const listener = vi.fn();
    hub.subscribe(listener);
    expect(() =>
      hub.publish({
        type: "environment_remove",
        generation: hub.generation,
        environmentId: "environment-1",
      }),
    ).toThrow();
    expect(hub.watermark).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    expect(
      hub.currentCheckpoint()?.event.snapshot.defaultNewThreadTargetId,
    ).toBe("target-1");
  });

  it("advances workpad invalidations without changing checkpoint contents", () => {
    const hub = new ApplicationEventHub();
    seed(hub);
    const before = hub.currentCheckpoint()!.event.snapshot;
    hub.publish({
      type: "workpad_changed",
      generation: hub.generation,
      workpadId: "20000000-0000-4000-8000-000000000006",
      revision: 1,
      change: "document",
    });
    expect(hub.currentCheckpoint()!.event.snapshot).toEqual(before);
    expect(hub.currentCheckpoint()!.eventId).toBe(hub.eventIdAt(2));
  });

  it("isolates scope generations and co-evicts closed projections", () => {
    const hubs = new ScopedApplicationEventHubs();
    const owner = hubs.application(scope);
    seed(owner);
    const foreign = hubs.application({ ...scope, principalId: "foreign" });
    expect(foreign.canReplay(owner.eventIdAt(1))).toBe(false);
    owner.close();
    expect(hubs.peek(scope)).toBeUndefined();
    expect(owner.projection).toBeUndefined();
    expect(hubs.application(scope).generation).not.toBe(owner.generation);
    hubs.close();
  });

  it("does not renew an idle deadline on producer updates", async () => {
    vi.useFakeTimers();
    try {
      const hubs = new ScopedApplicationEventHubs({
        idleRetentionMilliseconds: 1000,
      });
      const hub = hubs.application(scope);
      seed(hub);
      const sub = hub.subscribe(vi.fn());
      sub.close();
      await vi.advanceTimersByTimeAsync(900);
      count(hub, 1);
      hubs.release(scope);
      await vi.advanceTimersByTimeAsync(100);
      expect(hubs.peek(scope)).toBeUndefined();
      expect(hub.state).toBe("closed");
      hubs.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest idle scopes while preserving subscribers", () => {
    const hubs = new ScopedApplicationEventHubs({ maximumRetainedHubs: 2 });
    const active = hubs.application(scope);
    const sub = active.subscribe(vi.fn());
    const b = hubs.application({ ...scope, principalId: "b" });
    const c = hubs.application({ ...scope, principalId: "c" });
    hubs.application({ ...scope, principalId: "d" });
    expect(b.state).toBe("closed");
    expect(c.state).toBe("unseeded");
    expect(hubs.peek(scope)).toBe(active);
    sub.close();
    hubs.close();
  });

  it("accounts projection, checkpoint and wire storage in the idle byte budget", () => {
    const hubs = new ScopedApplicationEventHubs({ idleByteLimit: 1000 });
    const hub = hubs.application(scope);
    const sub = hub.subscribe(vi.fn());
    seed(hub);
    expect(hub.accountedBytes).toBeGreaterThan(1000);
    expect(hubs.peek(scope)).toBe(hub);
    sub.close();
    expect(hubs.peek(scope)).toBeUndefined();
    expect(hub.projection).toBeUndefined();
    hubs.close();
  });
});
