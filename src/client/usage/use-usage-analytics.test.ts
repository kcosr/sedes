// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import type { UsageAnalyticsRequest, UsageAnalyticsResponse, UsageFacetRequest, UsageFacetResponse } from "../../shared/protocol/usage-analytics.js";
import { USAGE_REFRESH_MILLISECONDS, useUsageAnalytics, useUsageFacets } from "./use-usage-analytics.js";

type AnalyticsApi = Pick<ApiClient, "getUsageAnalytics">;
function deferred() {
  let resolve!: (data: UsageAnalyticsResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<UsageAnalyticsResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(): UsageAnalyticsRequest {
  return { from: null, to: new Date().toISOString(), timeZone: "UTC", bucket: "auto", filters: {},
    groupBy: "model", matrix: null, breakdownLimit: 8, breakdownDimensions: ["model"], includeHeatmap: false, includeCoverage: false };
}
// The hook stores an opaque response; rendering and schema validation have separate tests.
const first = { generatedAt: "2026-10-23T10:00:00.000Z" } as UsageAnalyticsResponse;
const second = { generatedAt: "2026-10-23T10:01:00.000Z" } as UsageAnalyticsResponse;
const wake = (event: "focus" | "online" | "visibilitychange") => {
  (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T10:00:00.000Z"));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("useUsageAnalytics", () => {
  it("shares a recent pending read across manual and wake refreshes without rebuilding its range", async () => {
    const pending = deferred();
    const api = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => pending.promise) };
    const build = vi.fn(request);
    const { result } = renderHook(() => useUsageAnalytics(api, "30d", build, { poll: true }));
    const signal = api.getUsageAnalytics.mock.calls[0]![1]!;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS - 1);
      wake("focus"); wake("online"); wake("visibilitychange");
      result.current.refresh(); result.current.refresh();
    });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    expect(result.current.loading).toBe(true);

    await act(async () => { pending.resolve(first); });
    expect(result.current).toMatchObject({ data: first, loading: false, stale: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getUsageAnalytics.mock.calls[1]![0].to).toBe("2026-10-23T10:01:00.000Z");
  });

  it("shares a recent manually started read when the polling interval fires", async () => {
    const pending = deferred();
    const api = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => pending.promise)
      .mockResolvedValueOnce(first) };
    const { result } = renderHook(() => useUsageAnalytics(api, "30d", request, { poll: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); result.current.refresh(); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getUsageAnalytics.mock.calls[1]![1]!.aborted).toBe(false);
  });

  it.each(["manual", "automatic"])("replaces a read that has hung for one minute on the next %s trigger", async (trigger) => {
    const hung = deferred(), replacement = deferred();
    const api = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => replacement.promise)
      .mockImplementationOnce(() => hung.promise) };
    const { result } = renderHook(() => useUsageAnalytics(api, "30d", request, { poll: trigger === "automatic" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS);
      if (trigger === "manual") result.current.refresh();
    });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getUsageAnalytics.mock.calls[0]![1]!.aborted).toBe(true);
    expect(api.getUsageAnalytics.mock.calls[1]![0].to).toBe("2026-10-23T10:01:00.000Z");
    await act(async () => { hung.resolve(first); result.current.refresh(); });
    expect(result.current).toMatchObject({ data: undefined, loading: true });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    await act(async () => { replacement.resolve(second); });
    expect(result.current).toMatchObject({ data: second, loading: false });
  });

  it("coalesces automatic event bursts even when each response completes between events", async () => {
    const api = { getUsageAnalytics: vi.fn(async () => first) };
    renderHook(() => useUsageAnalytics(api, "30d", request, { poll: true }));
    await act(async () => {});

    await act(async () => { wake("focus"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); wake("online"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); wake("visibilitychange"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    await act(async () => { wake("focus"); });
    await act(async () => { wake("online"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS - 5_000); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(3);
    await act(async () => { wake("focus"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(3);
  });

  it("refreshes manually during the cooldown using the latest builder and current time", async () => {
    const api = { getUsageAnalytics: vi.fn(async (_request: UsageAnalyticsRequest) => first) };
    const { result, rerender } = renderHook(({ build }) => useUsageAnalytics(api, "30d", build, { poll: true }),
      { initialProps: { build: request } });
    await act(async () => {});
    rerender({ build: () => ({ ...request(), bucket: "day" }) });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); result.current.refresh(); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getUsageAnalytics.mock.calls[1]![0]).toMatchObject({ bucket: "day", to: "2026-10-23T10:00:01.000Z" });
  });

  it("starts changed keys immediately and fences old responses without releasing the new pending read", async () => {
    const old = deferred(), current = deferred();
    const api = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => old.promise)
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise) };
    const { result, rerender } = renderHook(({ queryKey }) => useUsageAnalytics(api, queryKey, request, { poll: true }),
      { initialProps: { queryKey: "30d" } });
    const oldSignal = api.getUsageAnalytics.mock.calls[0]![1]!;
    rerender({ queryKey: "7d" });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(oldSignal.aborted).toBe(true);

    await act(async () => { old.resolve(first); result.current.refresh(); });
    expect(result.current).toMatchObject({ data: undefined, loading: true });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getUsageAnalytics.mock.calls[1]![1]!.aborted).toBe(false);
    await act(async () => { current.resolve(second); });
    expect(result.current).toMatchObject({ data: second, loading: false, stale: false });
  });

  it("cancels changed API identities and ignores their late rejection", async () => {
    const old = deferred(), current = deferred();
    const oldApi = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => old.promise) };
    const newApi = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => current.promise) };
    const { result, rerender, unmount } = renderHook(({ api }: { api: AnalyticsApi }) => useUsageAnalytics(api, "30d", request, { poll: true }),
      { initialProps: { api: oldApi } });
    rerender({ api: newApi });
    expect(oldApi.getUsageAnalytics.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => { old.reject(new Error("old server")); result.current.refresh(); });
    expect(result.current).toMatchObject({ data: undefined, error: undefined, loading: true });
    expect(newApi.getUsageAnalytics).toHaveBeenCalledTimes(1);
    unmount();
    expect(newApi.getUsageAnalytics.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => { current.resolve(second); await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS); wake("focus"); });
    expect(newApi.getUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  it("does not retain another API's successful report while its replacement loads or fails", async () => {
    const pending = deferred();
    const oldApi = { getUsageAnalytics: vi.fn(async () => first) };
    const newApi = { getUsageAnalytics: vi.fn(() => pending.promise) };
    const { result, rerender } = renderHook(({ api }: { api: AnalyticsApi }) => useUsageAnalytics(api, "30d", request),
      { initialProps: { api: oldApi } });
    await act(async () => {});
    expect(result.current.data).toBe(first);
    rerender({ api: newApi });
    expect(result.current).toMatchObject({ data: undefined, loading: true, error: undefined });
    await act(async () => { pending.reject(new Error("new server unavailable")); });
    expect(result.current).toMatchObject({ data: undefined, loading: false, error: "new server unavailable" });
  });

  it("does not retain another API's filter choices when the connection changes", async () => {
    const data: UsageFacetResponse = { generatedAt: first.generatedAt, from: first.generatedAt, to: first.generatedAt,
      dimension: "model", choices: [{ key: "old-server-model", tokens: "1" }], labels: {} };
    const build = (): UsageFacetRequest => ({ from: null, to: first.generatedAt, timeZone: "UTC", bucket: "auto", filters: {}, dimension: "model", search: "" });
    const oldApi = { getUsageFacets: vi.fn(async () => data) };
    const newApi = { getUsageFacets: vi.fn(() => new Promise<UsageFacetResponse>(() => {})) };
    const { result, rerender } = renderHook(({ api }: { api: Pick<ApiClient, "getUsageFacets"> }) => useUsageFacets(api, "models", build),
      { initialProps: { api: oldApi } });
    await act(async () => {});
    expect(result.current.data).toBe(data);
    rerender({ api: newApi });
    expect(result.current).toMatchObject({ data: undefined, loading: true, error: undefined });
  });

  it.each(["key", "api"] as const)("cancels and stops automatic work when disabled by %s, then reads immediately on re-enable", async (disabledBy) => {
    const pending = deferred();
    const api = { getUsageAnalytics: vi.fn((_request: UsageAnalyticsRequest, _signal?: AbortSignal) => pending.promise) };
    const { result, rerender } = renderHook(({ activeApi, queryKey }: { activeApi: AnalyticsApi | undefined; queryKey: string | null }) =>
      useUsageAnalytics(activeApi, queryKey, request, { poll: true }),
      { initialProps: { activeApi: api as AnalyticsApi | undefined, queryKey: "30d" as string | null } });
    rerender({ activeApi: disabledBy === "api" ? undefined : api, queryKey: disabledBy === "key" ? null : "30d" });
    expect(api.getUsageAnalytics.mock.calls[0]![1]!.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      pending.resolve(first);
      await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS);
      wake("online"); result.current.refresh();
    });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeUndefined();
    await act(async () => { rerender({ activeApi: api, queryKey: "30d" }); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(first);
  });

  it("retains the previous key's data through a failed read and lets an automatic retry bypass the cooldown", async () => {
    const failure = deferred();
    const api = { getUsageAnalytics: vi.fn(async () => first).mockImplementationOnce(async () => first)
      .mockImplementationOnce(() => failure.promise).mockImplementationOnce(async () => second) };
    const { result, rerender } = renderHook(({ queryKey }) => useUsageAnalytics(api, queryKey, request, { poll: true }),
      { initialProps: { queryKey: "30d" } });
    await act(async () => {});
    rerender({ queryKey: "7d" });
    expect(result.current).toMatchObject({ data: first, stale: true, loading: true });
    await act(async () => { failure.reject(new Error("database_unavailable")); });
    expect(result.current).toMatchObject({ data: first, stale: true, loading: false, error: "database_unavailable" });
    await act(async () => { wake("online"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ data: second, stale: false, loading: false, error: undefined });
  });

  it.each(["builder", "api"] as const)("releases a read after a synchronous %s failure so a manual retry can succeed", async (source) => {
    let fail = true;
    const build = () => { if (source === "builder" && fail) throw new Error("invalid query"); return request(); };
    const api = { getUsageAnalytics: vi.fn(() => { if (source === "api" && fail) throw new Error("invalid query"); return Promise.resolve(first); }) };
    const { result } = renderHook(() => useUsageAnalytics(api, "30d", build));
    expect(result.current).toMatchObject({ data: undefined, loading: false, error: "invalid query" });
    fail = false;
    await act(async () => { result.current.refresh(); });
    expect(result.current).toMatchObject({ data: first, loading: false, error: undefined });
  });

  it("pauses automatic reads while hidden and stops polling when poll is disabled", async () => {
    const api = { getUsageAnalytics: vi.fn(async () => first) };
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { rerender } = renderHook(({ poll }) => useUsageAnalytics(api, "30d", request, { poll }), { initialProps: { poll: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS); wake("focus"); wake("online"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { wake("visibilitychange"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
    rerender({ poll: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MILLISECONDS); wake("focus"); wake("online"); });
    expect(api.getUsageAnalytics).toHaveBeenCalledTimes(2);
  });
});
