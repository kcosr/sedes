import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendAccountUsage } from "../../src/shared/protocol/account-usage.js";
import { ClaudeAccountUsageSource } from "../../src/server/backends/claude/claude-account-usage-source.js";

const interval = 5 * 60_000;
const sample: BackendAccountUsage = {
  capturedAt: 1_800_000_000_000, accountId: null, includedUsageAllowed: null, plan: "Max",
  windows: [{ scope: { kind: "account" }, durationMinutes: 10_080, remainingPercent: 47, resetsAt: null }],
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Claude account usage polling", () => {
  it("keeps a single backend cache and cadence while any admitted conversation is present", async () => {
    const readAccountUsage = vi.fn(async () => sample);
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const notify = vi.fn();
    source.subscribe(notify);
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).not.toHaveBeenCalled();

    const releaseA = source.retain();
    const releaseB = source.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    expect(source.snapshot()).toEqual({ ...sample, capturedAt: Date.now() });
    expect(notify).toHaveBeenCalledTimes(1);
    releaseA();
    releaseA();
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(2);

    releaseB();
    await vi.advanceTimersByTimeAsync(interval / 2);
    const releaseC = source.retain();
    await vi.advanceTimersByTimeAsync(interval / 2 - 1);
    expect(readAccountUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(readAccountUsage).toHaveBeenCalledTimes(3);
    releaseC();
    await vi.advanceTimersByTimeAsync(2 * interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(3);
    source.close();
  });

  it("fences an outstanding read across detach and reattach without overlapping calls", async () => {
    let complete!: (usage: BackendAccountUsage) => void;
    const readAccountUsage = vi.fn(async (_signal: AbortSignal) => sample)
      .mockImplementationOnce(() => new Promise<BackendAccountUsage>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const release = source.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    release();
    expect(readAccountUsage.mock.calls[0]![0].aborted).toBe(true);
    source.retain();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    complete(sample);
    await Promise.resolve();
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readAccountUsage).toHaveBeenCalledTimes(2);
    expect(source.snapshot()).toEqual({ ...sample, capturedAt: Date.now() });
    source.close();
  });

  it("does not issue another measurement when a long read spans the polling interval", async () => {
    let complete!: (usage: BackendAccountUsage) => void;
    const readAccountUsage = vi.fn(() => new Promise<BackendAccountUsage>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain();
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    source.close();
    complete(sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toBeNull();
  });

  it("removes failed observations, retries, and permanently fences a read after Stop", async () => {
    let complete!: (usage: BackendAccountUsage) => void;
    const readAccountUsage = vi.fn(async (_signal: AbortSignal) => sample)
      .mockResolvedValueOnce(sample)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(sample)
      .mockImplementationOnce(() => new Promise<BackendAccountUsage>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toEqual({ ...sample, capturedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toEqual({ ...sample, capturedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(interval);
    source.close();
    source.close();
    source.retain();
    expect(readAccountUsage.mock.calls[3]![0].aborted).toBe(true);
    complete(sample);
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(4);
    expect(source.snapshot()).toBeNull();
  });
});
