// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageQueryCache } from "./UsageQueryCache.js";
import { usageReport } from "./usage-test-fixture.js";
import { ApiError } from "../api/ApiClient.js";
import type { UsageReport } from "../../shared/protocol/usage-accounting.js";
const caches: UsageQueryCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(getUsage = vi.fn().mockResolvedValue(usageReport())) {
  const cache = new UsageQueryCache("thread-1", { getUsage }); caches.push(cache); return { cache, getUsage };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("visible durable usage cache", () => {
  it("does no row-render fetching, subscribes before reading and polls only active views", async () => {
    vi.useFakeTimers(); const { cache, getUsage } = fixture();
    const update = vi.fn(); cache.getSnapshot("turn-1"); const unsubscribe = cache.subscribe("turn-1", update);
    expect(getUsage).not.toHaveBeenCalled();
    const deactivate = cache.activate("turn-1"); await settle();
    expect(getUsage).toHaveBeenCalledOnce(); expect(update).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); expect(getUsage).toHaveBeenCalledTimes(2);
    deactivate(); unsubscribe(); await vi.advanceTimersByTimeAsync(10_000); expect(getUsage).toHaveBeenCalledTimes(2);
  });
  it("coalesces invalidations during a request and rejects stale revisions", async () => {
    let resolve!: (report: UsageReport) => void;
    const getUsage = vi.fn().mockImplementationOnce(() => new Promise<UsageReport>(r => { resolve = r; })).mockResolvedValue(usageReport({ revision: "3" }));
    const { cache } = fixture(getUsage); cache.activate("turn-1");
    cache.invalidate("2"); cache.invalidate("3"); expect(getUsage).toHaveBeenCalledOnce();
    resolve(usageReport({ revision: "1" })); await settle(); await settle();
    expect(getUsage).toHaveBeenCalledTimes(2); expect(cache.getSnapshot("turn-1").report?.revision).toBe("3");
    getUsage.mockResolvedValue(usageReport({ revision: "2" })); cache.invalidate(); await settle();
    expect(cache.getSnapshot("turn-1").report?.revision).toBe("3");
  });
  it("preserves committed values on read failure and retries on focus", async () => {
    const { cache, getUsage } = fixture(); cache.activate("turn-1"); await settle();
    getUsage.mockRejectedValue(new Error("offline")); cache.invalidate(); await settle();
    expect(cache.getSnapshot("turn-1")).toMatchObject({ report: { revision: "1" }, error: expect.stringContaining("retained") });
    getUsage.mockResolvedValue(usageReport({ revision: "2" })); window.dispatchEvent(new Event("focus")); await settle();
    expect(cache.getSnapshot("turn-1").report?.revision).toBe("2");
  });
  it("shows missing visible turn as empty without converting forbidden responses", async () => {
    const { cache, getUsage } = fixture(vi.fn().mockRejectedValue(new ApiError(404, "not_found", "Not found", false)));
    cache.activate("turn-1"); await settle(); expect(cache.getSnapshot("turn-1").missing).toBe(true);
    getUsage.mockRejectedValue(new ApiError(403, "forbidden", "Denied", false)); cache.invalidate(); await settle();
    expect(cache.getSnapshot("turn-1").error).toBeTruthy();
  });
  it("pauses hidden reads and fences responses after the authenticated store is disposed", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    let resolve!: (report: UsageReport) => void;
    const { cache, getUsage } = fixture(vi.fn(() => new Promise<UsageReport>(r => { resolve = r; })));
    cache.activate("turn-1"); expect(getUsage).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    expect(getUsage).toHaveBeenCalledOnce(); const signal = getUsage.mock.calls[0]![2];
    cache.dispose(); expect(signal.aborted).toBe(true); resolve(usageReport()); await settle();
    expect(cache.getSnapshot("turn-1").report).toBeUndefined();
  });
});
