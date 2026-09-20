import { describe, expect, it } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";

describe("ClaudeInputQueue", () => {
  it("delivers queued and awaited values in order, then closes", async () => {
    const queue = new ClaudeInputQueue<number>(2);
    const iterator = queue[Symbol.asyncIterator]();

    queue.push(1);
    expect(await iterator.next()).toEqual({ done: false, value: 1 });

    const waiting = iterator.next();
    queue.push(2);
    expect(await waiting).toEqual({ done: false, value: 2 });

    queue.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(() => queue.push(3)).toThrow("claude_input_queue_closed");
  });

  it("fails closed on overflow and a second consumer", async () => {
    const queue = new ClaudeInputQueue<number>(1);
    queue.push(1);
    expect(() => queue.push(2)).toThrow("claude_input_queue_full");

    const iterator = queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(
      "claude_input_queue_multiple_consumers",
    );
    await iterator.return?.();
  });

  it("rejects a pending read when the producer fails", async () => {
    const queue = new ClaudeInputQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.fail(new Error("provider_lost"));
    await expect(waiting).rejects.toThrow("provider_lost");
    await expect(iterator.next()).rejects.toThrow("provider_lost");
  });
});
