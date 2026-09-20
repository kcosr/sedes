import { describe, expect, it, vi } from "vitest";
import { CodexProjectionWorkQueue } from "../../src/server/backends/codex/codex-projection-work-queue.js";

describe("CodexProjectionWorkQueue", () => {
  it("drains reentrant work in synchronous FIFO order", () => {
    const order: number[] = [];
    const queue = new CodexProjectionWorkQueue(vi.fn());

    queue.enqueue(() => {
      order.push(1);
      queue.enqueue(() => order.push(3));
      order.push(2);
    });

    expect(order).toEqual([1, 2, 3]);
    expect(queue.execute(() => 42)).toBe(42);
  });

  it("fails closed and drops pending work when its bound is exceeded", () => {
    const onOverflow = vi.fn();
    const queue = new CodexProjectionWorkQueue(onOverflow);
    const work = vi.fn();

    queue.enqueue(() => {
      for (let index = 0; index < 1_002; index += 1) {
        queue.enqueue(work);
      }
    });

    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
