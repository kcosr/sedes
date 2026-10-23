import { describe, expect, it } from "vitest";
import { AsyncCodecBudget } from "../../src/internal/compression/async-codec-budget.js";

describe("finite asynchronous codec budget", () => {
  it("bounds active work and serves waiting decoders in order before opportunistic encoders", async () => {
    const budget = new AsyncCodecBudget();
    const first = budget.tryAcquire()!;
    const second = budget.tryAcquire()!;
    expect(budget.tryAcquire()).toBeUndefined();
    const waitingFirst = budget.acquire();
    const waitingSecond = budget.acquire();
    expect(budget.waitingCount).toBe(2);
    first.release();
    first.release();
    expect(budget.activeCount).toBe(2);
    expect(budget.waitingCount).toBe(1);
    expect(budget.tryAcquire()).toBeUndefined();
    const third = await waitingFirst;
    third.release();
    const fourth = await waitingSecond;
    expect(budget.waitingCount).toBe(0);
    second.release();
    fourth.release();
    expect(budget.activeCount).toBe(0);
  });

  it("removes aborted waiters and releases their queue capacity without claiming a slot", async () => {
    const budget = new AsyncCodecBudget({ slots: 1, maximumWaiters: 1 });
    const active = budget.tryAcquire()!;
    const controller = new AbortController();
    const pending = budget.acquire(controller.signal);
    await expect(budget.acquire()).rejects.toThrow("async_codec_waiter_limit_exceeded");
    const reason = new Error("carrier_closed");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(budget.acquire(controller.signal)).rejects.toBe(reason);
    expect(budget.waitingCount).toBe(0);
    const next = budget.acquire();
    active.release();
    (await next).release();
    expect(budget.activeCount).toBe(0);
  });

  it("does not revoke admitted codec work when its prior wait signal aborts", async () => {
    const budget = new AsyncCodecBudget({ slots: 1 });
    const active = budget.tryAcquire()!;
    const controller = new AbortController();
    const pending = budget.acquire(controller.signal);
    active.release();
    controller.abort();
    const admitted = await pending;
    expect(budget.activeCount).toBe(1);
    admitted.release();
    expect(budget.activeCount).toBe(0);
  });

  it.each([{ slots: 0 }, { slots: 1.5 }, { maximumWaiters: -1 }])("rejects invalid limits %j", options => {
    expect(() => new AsyncCodecBudget(options)).toThrow("async_codec_budget_invalid");
  });
});
