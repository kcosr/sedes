// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageQueryCache } from "./UsageQueryCache.js";
import { usageReport } from "./usage-test-fixture.js";
import { ApiError } from "../api/ApiClient.js";
import type { UsageReport } from "../../shared/protocol/usage-accounting.js";
const caches: UsageQueryCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(getUsage = vi.fn().mockResolvedValue(usageReport())) {
  const cache = new UsageQueryCache("thread-1", { getUsage, getUsageAvailability: vi.fn().mockResolvedValue({threadId:"thread-1",revision:"1",turns:[]}) }); cache.setEnabled(true);caches.push(cache); return { cache, getUsage };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("visible durable usage cache", () => {
  it("defaults off, aborts and clears on disable, and fences late responses across re-enable", async () => {
    vi.useFakeTimers();
    let resolve!: (report: UsageReport) => void;
    const getUsage = vi.fn().mockImplementationOnce(() => new Promise<UsageReport>(done => { resolve = done; })).mockResolvedValue(usageReport({ revision: "2" }));
    const getUsageAvailability = vi.fn().mockResolvedValue({threadId:"thread-1",revision:"2",turns:[{turnId:"turn-1",available:true}]});
    const cache = new UsageQueryCache("thread-1", {getUsage, getUsageAvailability});
    caches.push(cache);
    cache.activate("turn-1"); cache.activateAvailability("turn-1");
    cache.invalidate(); window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getUsage).not.toHaveBeenCalled(); expect(getUsageAvailability).not.toHaveBeenCalled();
    cache.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.getSnapshot("turn-1").available).toBe(true);
    const signal = getUsage.mock.calls[0]![2] as AbortSignal;
    cache.setEnabled(false);
    expect(signal.aborted).toBe(true);
    expect(cache.getSnapshot("turn-1")).toEqual({loading:false,missing:false});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getUsage).toHaveBeenCalledOnce(); expect(getUsageAvailability).toHaveBeenCalledOnce();
    cache.setEnabled(true);
    await settle();
    resolve(usageReport({revision:"99"})); await settle();
    expect(cache.getSnapshot("turn-1").report?.revision).toBe("2");
  });
  it("batches ended-turn availability without fetching full reports, and retries revision hints", async () => {
    vi.useFakeTimers();
    const getUsage=vi.fn();
    const getUsageAvailability=vi.fn(async (_thread:string,ids:readonly string[])=>({threadId:"thread-1",revision:"1",turns:ids.map(turnId=>({turnId,available:turnId!=="empty"}))}));
    const cache=new UsageQueryCache("thread-1",{getUsage,getUsageAvailability});cache.setEnabled(true);caches.push(cache);
    const stop1=cache.activateAvailability("turn-1"), stop2=cache.activateAvailability("empty");
    await vi.advanceTimersByTimeAsync(1);
    expect(getUsageAvailability).toHaveBeenCalledOnce();expect(getUsage).not.toHaveBeenCalled();
    expect(getUsageAvailability.mock.calls[0]?.[1]).toEqual(["turn-1","empty"]);
    expect(cache.getSnapshot("turn-1").available).toBe(true);expect(cache.getSnapshot("empty").available).toBe(false);
    cache.invalidate("2");await vi.advanceTimersByTimeAsync(1);
    expect(cache.getSnapshot("turn-1").available).toBe(true);
    stop1();stop2();await vi.advanceTimersByTimeAsync(6000);
    expect(getUsageAvailability).toHaveBeenCalledTimes(2);
  });
  it("ignores availability responses after disposal and mismatched turn batches", async () => {
    vi.useFakeTimers();let resolve!:(value:any)=>void;
    const getUsageAvailability=vi.fn(()=>new Promise<any>(r=>{resolve=r;}));
    const cache=new UsageQueryCache("thread-1",{getUsage:vi.fn(),getUsageAvailability});cache.setEnabled(true);caches.push(cache);
    cache.activateAvailability("turn-1");await vi.advanceTimersByTimeAsync(1);
    resolve({threadId:"thread-1",revision:"1",turns:[{turnId:"foreign",available:true}]});await settle();
    expect(cache.getSnapshot("turn-1").available).toBeUndefined();
    cache.invalidate();await vi.advanceTimersByTimeAsync(1);cache.dispose();
    resolve({threadId:"thread-1",revision:"2",turns:[{turnId:"turn-1",available:true}]});await settle();
    expect(cache.getSnapshot("turn-1").available).toBeUndefined();
  });
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
