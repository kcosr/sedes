import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS, type BackendAccountUsageReport } from "../../src/shared/protocol/account-usage.js";
import { ClaudeAccountUsageSource } from "../../src/server/backends/claude/claude-account-usage-source.js";

const interval = 5 * 60_000;
const sample: BackendAccountUsageReport = {
  capturedAt: 1_800_000_000_000, accountId: null, includedUsageAllowed: null, plan: "Max",
  windows: [{ scope: { kind: "account" }, durationMinutes: 10_080, remainingPercent: 47, resetsAt: null }],
};

const queryA = { applicationThreadId: "thread-a", sessionId: "session-a", startupProbeUuid: "query-a" };
const queryB = { applicationThreadId: "thread-b", sessionId: "session-b", startupProbeUuid: "query-b" };
const proofA = { sessionId: queryA.sessionId, startupProbeUuid: queryA.startupProbeUuid };
const proofB = { sessionId: queryB.sessionId, startupProbeUuid: queryB.startupProbeUuid };
const observationId = "bc65667f-11e4-4a22-9651-e9ef6c596845";
const observation = { observationId, usage: sample, verifiedSessions: [proofA, proofB] };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Claude account usage polling", () => {
  it("keeps a single backend cache and cadence while any admitted conversation is present", async () => {
    const readAccountUsage = vi.fn(async (_signal: AbortSignal, _id?: string) => observation);
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const notify = vi.fn();
    source.subscribe(notify);
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).not.toHaveBeenCalled();

    const releaseA = source.retain(queryA);
    const releaseB = source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    expect(source.snapshot()).toEqual({ ...sample, reportedBy: "Claude Code", capturedAt: Date.now(), eligibleThreadIds: ["thread-a", "thread-b"] });
    expect(notify).toHaveBeenCalledTimes(1);
    releaseA();
    releaseA();
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-b"]);
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(2);

    releaseB();
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(interval / 2);
    const releaseC = source.retain(queryA);
    await vi.advanceTimersByTimeAsync(interval / 2 - 1);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, undefined, observationId]);
    await vi.advanceTimersByTimeAsync(1);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, undefined, observationId, undefined]);
    releaseC();
    await vi.advanceTimersByTimeAsync(2 * interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(4);
    source.close();
  });

  it("coalesces new matching attachments into one membership check and retains the original quota and capture time", async () => {
    const readAccountUsage = vi.fn(async (_signal: AbortSignal, id?: string) => id
      ? { ...observation, usage: { ...sample, plan: null }, verifiedSessions: [proofA, proofB] }
      : { ...observation, verifiedSessions: [proofA] });
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain(queryA);
    await vi.advanceTimersByTimeAsync(0);
    const original = source.snapshot()!;
    await vi.advanceTimersByTimeAsync(60_000);
    source.retain(queryB);
    source.retain({ ...queryB, applicationThreadId: "also-b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId]);
    expect(source.snapshot()).toEqual({ ...original, eligibleThreadIds: ["thread-a", "thread-b", "also-b"] });
    await vi.advanceTimersByTimeAsync(interval - 60_000);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId, undefined]);
    expect(source.snapshot()?.capturedAt).toBe(Date.now());
    source.close();
  });

  it("keeps a private sample even without eligible threads and verifies a reopened query incarnation", async () => {
    const replacement = { ...queryB, startupProbeUuid: "fresh-query" };
    const readAccountUsage = vi.fn(async (_signal: AbortSignal, _id?: string) => observation)
      .mockResolvedValueOnce({ ...observation, verifiedSessions: [] })
      .mockResolvedValueOnce({ ...observation, verifiedSessions: [proofB] })
      .mockResolvedValueOnce({ ...observation, verifiedSessions: [{ ...proofB, startupProbeUuid: replacement.startupProbeUuid }] });
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const releaseA = source.retain(queryA);
    await vi.advanceTimersByTimeAsync(0);
    const capturedAt = Date.now();
    expect(source.snapshot()).toBeNull();
    releaseA();
    await vi.advanceTimersByTimeAsync(30_000);
    const releaseB = source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toMatchObject({ capturedAt, eligibleThreadIds: ["thread-b"] });
    releaseB();
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    source.retain(replacement);
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toMatchObject({ capturedAt, eligibleThreadIds: ["thread-b"] });
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId, observationId]);
    source.close();
  });

  it("ignores a late membership reply after the last handle detaches and another query reopens", async () => {
    let complete!: (reply: typeof observation) => void;
    const reopened = { ...queryB, startupProbeUuid: "reopened-query" };
    const readAccountUsage = vi.fn(async (_signal: AbortSignal, _id?: string) => observation)
      .mockResolvedValueOnce(observation)
      .mockImplementationOnce(() => new Promise<typeof observation>(resolve => { complete = resolve; }))
      .mockResolvedValueOnce({ ...observation, verifiedSessions: [{ ...proofB, startupProbeUuid: reopened.startupProbeUuid }] });
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const releaseA = source.retain(queryA);
    await vi.advanceTimersByTimeAsync(0);
    const capturedAt = source.snapshot()!.capturedAt;
    releaseA();
    const releaseB = source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    releaseB();
    expect(readAccountUsage.mock.calls[1]![0].aborted).toBe(true);
    source.retain(reopened);
    await vi.advanceTimersByTimeAsync(0);
    const expected = { capturedAt, eligibleThreadIds: [queryB.applicationThreadId] };
    expect(source.snapshot()).toMatchObject(expected);
    complete(observation);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toMatchObject(expected);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId, observationId]);
    source.close();
  });

  it.each([null, { ...observation, observationId: "foreign-worker-sample" }])(
    "withholds cached quota when the current worker cannot confirm the original observation", async reply => {
      const readAccountUsage = vi.fn(async (_signal: AbortSignal, id?: string) => id ? reply : observation);
      const source = new ClaudeAccountUsageSource({ readAccountUsage });
      source.retain(queryA);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-a"]);
      await vi.advanceTimersByTimeAsync(10_000);
      source.retain(queryB);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.snapshot()).toBeNull();
      expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId]);
      await vi.advanceTimersByTimeAsync(interval - 10_000);
      expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-a", "thread-b"]);
      source.close();
    },
  );

  it("preempts a slow cache check at the provider deadline and ignores its late reply", async () => {
    let complete!: (reply: typeof observation) => void;
    const readAccountUsage = vi.fn(async (_signal: AbortSignal, id?: string) => id
      ? new Promise<typeof observation>(resolve => { complete = resolve; })
      : { ...observation, verifiedSessions: [proofA] });
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain(queryA);
    await vi.advanceTimersByTimeAsync(interval - 1_000);
    source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readAccountUsage.mock.calls[1]![0].aborted).toBe(true);
    expect(readAccountUsage.mock.calls.map(([, id]) => id)).toEqual([undefined, observationId, undefined]);
    complete(observation);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toMatchObject({ capturedAt: Date.now(), eligibleThreadIds: ["thread-a"] });
    source.close();
  });

  it("only shares a reading with live queries proven to use the observed account", async () => {
    const readAccountUsage = vi.fn(async () => ({ observationId, usage: sample, verifiedSessions: [proofA] }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain(queryA);
    source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-a"]);
    readAccountUsage.mockResolvedValueOnce({ observationId, usage: sample, verifiedSessions: [] });
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toBeNull();
    source.close();
  });

  it("withholds the observation if the application thread mapping exceeds its bound", async () => {
    const source = new ClaudeAccountUsageSource({ readAccountUsage: async () => observation });
    for (let index = 0; index < MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS; index++) {
      source.retain({ ...queryA, applicationThreadId: `thread-${index}` });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()?.eligibleThreadIds).toHaveLength(MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS);
    const release = source.retain({ ...queryA, applicationThreadId: "additional-thread" });
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()?.eligibleThreadIds).toHaveLength(MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS);
    source.close();
  });

  it("cannot transfer eligibility to a replaced attachment during or after an in-flight read", async () => {
    let complete!: (reply: typeof observation) => void;
    const readAccountUsage = vi.fn(async () => observation).mockResolvedValueOnce(observation)
      .mockImplementationOnce(() => new Promise<typeof observation>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const releaseA = source.retain(queryA);
    source.retain(queryB);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-a", "thread-b"]);
    await vi.advanceTimersByTimeAsync(interval);
    source.retain({ ...queryA, startupProbeUuid: "replacement-query" });
    releaseA();
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-b"]);
    complete(observation);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-b"]);

    // An old worker reply for the same native session cannot verify its replacement.
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-b"]);
    readAccountUsage.mockResolvedValueOnce({ observationId, usage: sample, verifiedSessions: [
      { ...proofA, startupProbeUuid: "replacement-query" }, proofB,
    ] });
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()?.eligibleThreadIds).toEqual(["thread-a", "thread-b"]);
    source.close();
  });

  it("fences an outstanding read across detach and reattach without overlapping calls", async () => {
    let complete!: (reply: typeof observation) => void;
    const readAccountUsage = vi.fn(async (_signal: AbortSignal) => observation)
      .mockImplementationOnce(() => new Promise<typeof observation>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    const release = source.retain(queryA);
    await vi.advanceTimersByTimeAsync(0);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    release();
    expect(readAccountUsage.mock.calls[0]![0].aborted).toBe(true);
    source.retain(queryA);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    complete(observation);
    await Promise.resolve();
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readAccountUsage).toHaveBeenCalledTimes(2);
    expect(source.snapshot()).toEqual({ ...sample, reportedBy: "Claude Code", capturedAt: Date.now(), eligibleThreadIds: ["thread-a"] });
    source.close();
  });

  it("does not issue another measurement when a long read spans the polling interval", async () => {
    let complete!: (reply: typeof observation) => void;
    const readAccountUsage = vi.fn(() => new Promise<typeof observation>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain(queryA);
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(readAccountUsage).toHaveBeenCalledTimes(1);
    source.close();
    complete(observation);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toBeNull();
  });

  it("removes failed observations, retries, and permanently fences a read after Stop", async () => {
    let complete!: (reply: typeof observation) => void;
    const readAccountUsage = vi.fn(async (_signal: AbortSignal) => observation)
      .mockResolvedValueOnce(observation)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(observation)
      .mockImplementationOnce(() => new Promise<typeof observation>(resolve => { complete = resolve; }));
    const source = new ClaudeAccountUsageSource({ readAccountUsage });
    source.retain(queryA);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.snapshot()).toEqual({ ...sample, reportedBy: "Claude Code", capturedAt: Date.now(), eligibleThreadIds: ["thread-a"] });
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(interval);
    expect(source.snapshot()).toEqual({ ...sample, reportedBy: "Claude Code", capturedAt: Date.now(), eligibleThreadIds: ["thread-a"] });
    await vi.advanceTimersByTimeAsync(interval);
    source.close();
    source.close();
    source.retain(queryA);
    expect(readAccountUsage.mock.calls[3]![0].aborted).toBe(true);
    complete(observation);
    await vi.advanceTimersByTimeAsync(interval);
    expect(readAccountUsage).toHaveBeenCalledTimes(4);
    expect(source.snapshot()).toBeNull();
  });
});
