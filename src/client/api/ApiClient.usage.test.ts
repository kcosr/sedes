// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { usageReport } from "../stores/usage-test-fixture.js";
afterEach(() => vi.unstubAllGlobals());
it("reads scoped session and turn accounting without a provider endpoint", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(usageReport())); vi.stubGlobal("fetch", fetch);
  const api = new ApiClient(); await api.getUsage("thread/1", "turn:1");
  expect(String(fetch.mock.calls[0]![0])).toBe("/api/threads/thread%2F1/usage/turns/turn%3A1");
  fetch.mockResolvedValue(Response.json(usageReport({ turnId: null })));
  await api.getUsage("thread/1"); expect(String(fetch.mock.calls[1]![0])).toBe("/api/threads/thread%2F1/usage");
});
it("rejects legacy number-shaped counters", async () => {
  const report = usageReport(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...report,
    summary: { ...report.summary, metrics: { ...report.summary.metrics, input: { ...report.summary.metrics.input, value: 123 } } } })));
  await expect(new ApiClient().getUsage("thread-1", "turn-1")).rejects.toThrow();
});
