import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EVENT_HUB_REPLAY_BYTE_LIMIT,
  DEFAULT_EVENT_HUB_REPLAY_LIMIT,
  EventHub,
} from "../../src/server/events/event-hub.js";

describe("EventHub", () => {
  it("uses the warm thread replay defaults", () => {
    expect(DEFAULT_EVENT_HUB_REPLAY_LIMIT).toBe(4_096);
    expect(DEFAULT_EVENT_HUB_REPLAY_BYTE_LIMIT).toBe(32 * 1_024 * 1_024);
  });

  it("uses generation-scoped monotonic IDs and bounded replay", () => {
    const hub = new EventHub<{ value: number }>({ replayLimit: 2 });
    const first = hub.publish("change", { value: 1 });
    const second = hub.publish("change", { value: 2 });
    const third = hub.publish("change", { value: 3 });

    expect(first.sequence).toBe(1);
    expect(third.id).toBe(`${hub.generation}.3`);
    expect(hub.canReplay(first.id)).toBe(true);

    const listener = vi.fn();
    const subscription = hub.subscribe(listener, first.id);
    expect(subscription.replay).toEqual([second, third]);
    subscription.close();
  });

  it("rejects stale generations and removes closed subscribers", () => {
    const hub = new EventHub<string>();
    const listener = vi.fn();
    const subscription = hub.subscribe(listener, "another-generation.1");

    expect(subscription.replay).toEqual([]);
    hub.publish("notice", "before-close");
    expect(listener).toHaveBeenCalledTimes(1);
    subscription.close();
    hub.publish("notice", "after-close");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates and removes a subscriber that throws", () => {
    const hub = new EventHub<string>();
    const failed = vi.fn(() => {
      throw new Error("transport failed");
    });
    const healthy = vi.fn();
    hub.subscribe(failed);
    hub.subscribe(healthy);

    expect(() => hub.publish("notice", "first")).not.toThrow();
    hub.publish("notice", "second");

    expect(failed).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("bounds replay by serialized bytes and drops superseded history", () => {
    const hub = new EventHub<{ value: string }>({
      replayLimit: 10,
      replayByteLimit: 220,
      supersedesReplay: (type) => type === "snapshot",
    });
    const first = hub.publish("change", { value: "a".repeat(80) });
    const second = hub.publish("change", { value: "b".repeat(80) });

    expect(hub.retainedBytes).toBeLessThanOrEqual(220);
    expect(hub.retainedEventCount).toBe(1);
    expect(hub.canReplay(first.id)).toBe(true);

    const replacement = hub.publish("snapshot", { value: "current" });
    expect(hub.retainedEventCount).toBe(1);
    expect(hub.subscribe(vi.fn(), second.id).replay).toEqual([replacement]);
    expect(second.sequence).toBe(2);
  });

  it("keeps exact UTF-8 replay accounting through repeated eviction and replacement", () => {
    const hub = new EventHub<{ value: string }>({
      replayLimit: 3,
      replayByteLimit: 650,
      supersedesReplay: (type) => type === "snapshot",
    });
    let retained: ReturnType<typeof hub.publish>[] = [];
    const bytes = (event: ReturnType<typeof hub.publish>) =>
      Buffer.byteLength(JSON.stringify(event), "utf8");
    for (let index = 0; index < 30; index += 1) {
      const type = index % 7 === 0 ? "snapshot" : "change";
      const event = hub.publish(type, {
        value: "界🙂".repeat(index === 15 ? 200 : 10 + index),
      });
      if (type === "snapshot" || bytes(event) > 650) retained = [];
      if (bytes(event) <= 650) retained.push(event);
      while (
        retained.length > 3 ||
        retained.reduce((total, entry) => total + bytes(entry), 0) > 650
      ) {
        retained.shift();
      }
      expect(hub.retainedEventCount).toBe(retained.length);
      expect(hub.retainedBytes).toBe(
        retained.reduce((total, entry) => total + bytes(entry), 0),
      );
      const cursor = `${hub.generation}.${retained[0] ? retained[0].sequence - 1 : event.sequence}`;
      const subscription = hub.subscribe(vi.fn(), cursor);
      expect(subscription.replay).toEqual(retained);
      subscription.close();
    }
  });

  it("invalidates cursors before an individually oversized event", () => {
    const hub = new EventHub<{ value: string }>({
      replayByteLimit: 200,
    });
    const first = hub.publish("change", { value: "first" });
    hub.publish("change", { value: "x".repeat(500) });

    expect(hub.canReplay(first.id)).toBe(false);
    expect(hub.subscribe(vi.fn(), first.id).replay).toEqual([]);

    const third = hub.publish("change", { value: "third" });
    expect(hub.canReplay(third.id)).toBe(true);
  });
});
