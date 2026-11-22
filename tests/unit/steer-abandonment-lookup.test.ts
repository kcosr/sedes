import { afterEach, describe, expect, it, vi } from "vitest";
import { SteerAbandonmentLookup } from "../../src/client/stores/SteerAbandonmentLookup.js";
import { ApiError } from "../../src/client/api/ApiClient.js";

afterEach(() => vi.useRealTimers());

describe("Steer abandonment lookup", () => {
  it("does not infer retirement from omitted IDs or reread for streaming at the same durable revision", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ abandonedOperationIds: [] }));
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["accepted"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 500; i++) lookup.observe(["accepted"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    lookup.observe(["accepted"], "reset-revision-2", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });

  it("reads bounded batches serially and rechecks changes received during a read", async () => {
    vi.useFakeTimers();
    let resolve!: (result: { abandonedOperationIds: string[] }) => void;
    const read = vi.fn(async (_ids: readonly string[]) => ({ abandonedOperationIds: [] as string[] }));
    read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    const ids = Array.from({ length: 205 }, (_, i) => `operation-${i}`);
    lookup.observe(ids, "before-reset", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    lookup.observe(ids, "after-reset", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledOnce();
    resolve({ abandonedOperationIds: [ids[0]!] });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5, 100, 100, 5]);
    expect(retire).toHaveBeenCalledExactlyOnceWith(new Set([ids[0]]));
    lookup.dispose();
  });

  it("retries failed reads with backoff while keeping client state", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new TypeError("carrier lost"))
      .mockResolvedValue({ abandonedOperationIds: ["reset"] });
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledWith(new Set(["reset"]));
    lookup.dispose();
  });

  it.each([new ApiError(403, "forbidden", "Forbidden", false), new Error("invalid_response")])("waits for a new observation after a terminal lookup error", async (error) => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(error);
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(300_000);
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    lookup.observe(["reset"], "revision-2", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });

  it("bounds transient retries per observation", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new TypeError("carrier lost"));
    const lookup = new SteerAbandonmentLookup({ read, retire: vi.fn() });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(8);
    lookup.observe(["reset"], "revision-2", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(9);
    lookup.dispose();
  });

  it("aborts a stalled request and retries without retiring uncertain state", async () => {
    vi.useFakeTimers();
    const read = vi.fn((_ids: readonly string[], signal: AbortSignal) => new Promise<{ abandonedOperationIds: string[] }>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    expect(retire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });

  it("does not let an older terminal failure suppress a newer observation", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ abandonedOperationIds: ["reset"] });
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(0);
    lookup.observe(["reset"], "revision-2", true);
    reject(new ApiError(403, "forbidden", "Forbidden", false));
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledWith(new Set(["reset"]));
    lookup.dispose();
  });

  it.each(["suspend", "dispose"] as const)("aborts on %s and ignores a late response", async (action) => {
    vi.useFakeTimers();
    let resolve!: (result: { abandonedOperationIds: string[] }) => void;
    const read = vi.fn((_ids: readonly string[], _signal: AbortSignal) => new Promise<{ abandonedOperationIds: string[] }>(done => { resolve = done; }));
    const retire = vi.fn();
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["reset"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(0);
    lookup[action]();
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    resolve({ abandonedOperationIds: ["reset"] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retire).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    lookup.dispose();
  });

  it.each([{ abandonedOperationIds: ["unrequested"] }, { abandonedOperationIds: ["requested", "requested"] }])("rejects mismatched abandonment evidence %j", async ({ abandonedOperationIds }) => {
    vi.useFakeTimers();
    const retire = vi.fn();
    const read = vi.fn(async () => ({ abandonedOperationIds }));
    const lookup = new SteerAbandonmentLookup({ read, retire });
    lookup.observe(["requested"], "revision-1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(retire).not.toHaveBeenCalled();
    lookup.dispose();
  });
});
