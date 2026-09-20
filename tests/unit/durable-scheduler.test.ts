import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../../src/server/domain/clock.js";
import {
  DurableScheduler,
  type DurableDeadlineSource,
} from "../../src/server/domain/durable-scheduler.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("DurableScheduler", () => {
  it("reconciles sources in declaration order and arms the nearest deadline", async () => {
    const order: string[] = [];
    const scheduled: number[] = [];
    const clock: Clock = {
      now: () => 1_000,
      setTimeout: (_callback, delay) => {
        scheduled.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    };
    const automation: DurableDeadlineSource = {
      getNearestDeadline: () => 9_000,
      reconcileDue: () => {
        order.push("automation");
      },
    };
    const snooze: DurableDeadlineSource = {
      getNearestDeadline: () => 6_000,
      reconcileDue: () => {
        order.push("snooze");
      },
    };
    const scheduler = new DurableScheduler([automation, snooze], { clock });

    scheduler.start();
    await flush();

    expect(order).toEqual(["automation", "snooze"]);
    expect(scheduled).toEqual([5_000]);
    await scheduler.stop();
  });

  it("coalesces rearm requests while asynchronous reconciliation is running", async () => {
    const gate = deferred();
    const first = vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(undefined);
    const source: DurableDeadlineSource = {
      getNearestDeadline: () => null,
      reconcileDue: first,
    };
    const scheduler = new DurableScheduler([source]);

    scheduler.start();
    await flush();
    scheduler.rearm();
    scheduler.rearm();
    expect(first).toHaveBeenCalledTimes(1);

    gate.resolve();
    await flush();
    expect(first).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("contains source errors, clamps long delays, and drains on stop", async () => {
    const gate = deferred();
    let callback: (() => void) | undefined;
    let delay: number | undefined;
    const onError = vi.fn();
    const clock: Clock = {
      now: () => 0,
      setTimeout: (scheduled, milliseconds) => {
        callback = scheduled;
        delay = milliseconds;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    };
    const source: DurableDeadlineSource = {
      getNearestDeadline: () => 5_000_000_000,
      reconcileDue: vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockImplementationOnce(() => gate.promise),
    };
    const scheduler = new DurableScheduler([source], { clock, onError });

    scheduler.start();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(delay).toBe(2_147_000_000);

    callback?.();
    await flush();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("continues after a source error and backs off a past-due retry", async () => {
    const scheduled: number[] = [];
    const onError = vi.fn();
    const laterSource = vi.fn();
    const clock: Clock = {
      now: () => 10_000,
      setTimeout: (_callback, delay) => {
        scheduled.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    };
    const failing: DurableDeadlineSource = {
      getNearestDeadline: () => 9_000,
      reconcileDue: () => {
        throw new Error("broken definition source");
      },
    };
    const later: DurableDeadlineSource = {
      getNearestDeadline: () => null,
      reconcileDue: laterSource,
    };
    const scheduler = new DurableScheduler([failing, later], {
      clock,
      onError,
    });

    scheduler.start();
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(laterSource).toHaveBeenCalledOnce();
    expect(scheduled).toEqual([1_000]);
    await scheduler.stop();
  });
});
