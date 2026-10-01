import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeContextUsageTracker, projectClaudeContextUsage } from "../../src/server/backends/claude/claude-context-usage.js";

const sample = { usedTokens: 200, windowTokens: 1_000, percent: 20 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("Claude current context", () => {
  it("uses the effective native window and derives percent from the displayed counts", () => {
    expect(projectClaudeContextUsage({ totalTokens: 200, rawMaxTokens: 1_000,
      maxTokens: 1_200, percentage: 17 } as SDKControlGetContextUsageResponse)).toEqual(sample);
  });

  it.each([
    { totalTokens: -1, rawMaxTokens: 100 }, { totalTokens: 1, rawMaxTokens: 0 },
    { totalTokens: NaN, rawMaxTokens: 100 }, { totalTokens: 1.1, rawMaxTokens: 100 },
    { totalTokens: 1, rawMaxTokens: Infinity }, { totalTokens: Number.MAX_SAFE_INTEGER + 1, rawMaxTokens: 100 },
  ])("rejects invalid native counts %j", value => {
    expect(() => projectClaudeContextUsage(value as SDKControlGetContextUsageResponse)).toThrow();
  });

  it("coalesces bursts and suppresses samples superseded by a newer observation", async () => {
    const first = deferred<typeof sample>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(sample);
    const publish = vi.fn();
    const tracker = new ClaudeContextUsageTracker({ read, publish });
    try {
      tracker.refresh(); tracker.refresh(); tracker.refresh();
      await Promise.resolve();
      expect(read).toHaveBeenCalledOnce();
      tracker.refresh(); tracker.refresh();
      first.resolve({ ...sample, usedTokens: 900, percent: 90 });
      await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(sample));
      expect(read).toHaveBeenCalledTimes(2);
      tracker.refresh();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      expect(publish).toHaveBeenCalledOnce();
    } finally { tracker.close(); }
  });

  it("clears a prior sample when telemetry fails and recovers on the next boundary", async () => {
    const publish = vi.fn();
    const read = vi.fn().mockResolvedValueOnce(sample).mockRejectedValueOnce(new Error("transport_lost")).mockResolvedValue(sample);
    const tracker = new ClaudeContextUsageTracker({ read, publish });
    try {
      tracker.refresh(); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(sample));
      tracker.refresh(); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(undefined));
      tracker.refresh(); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(sample));
    } finally { tracker.close(); }
  });

  it("invalidates a pending read without waiting for the native request, then rejects its late result", async () => {
    const pending = deferred<typeof sample>();
    const read = vi.fn().mockResolvedValueOnce(sample).mockReturnValueOnce(pending.promise).mockResolvedValue({ ...sample, usedTokens: 100, percent: 10 });
    const publish = vi.fn();
    const tracker = new ClaudeContextUsageTracker({ read, publish });
    try {
      tracker.refresh(); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(sample));
      tracker.refresh(); await Promise.resolve();
      tracker.invalidate();
      expect(read.mock.calls[1]![0].aborted).toBe(true);
      expect(publish).toHaveBeenLastCalledWith(undefined);
      tracker.refresh();
      await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ ...sample, usedTokens: 100, percent: 10 }));
      pending.resolve(sample); await Promise.resolve();
      expect(publish).toHaveBeenCalledTimes(3);
    } finally { tracker.close(); }
  });

  it("times out stuck telemetry, accepts later reads, and never publishes after close", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof sample>();
    const read = vi.fn().mockResolvedValueOnce(sample).mockReturnValueOnce(pending.promise).mockResolvedValue(sample);
    const publish = vi.fn();
    const tracker = new ClaudeContextUsageTracker({ read, publish, timeoutMilliseconds: 50 });
    tracker.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenLastCalledWith(sample);
    tracker.refresh(); await vi.advanceTimersByTimeAsync(50);
    expect(publish).toHaveBeenLastCalledWith(undefined);
    expect(read.mock.calls[1]![0].aborted).toBe(true);
    tracker.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenLastCalledWith(sample);
    tracker.close(); publish.mockClear();
    pending.resolve(sample); tracker.refresh(); await vi.advanceTimersByTimeAsync(100);
    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
