// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { usageReport } from "../stores/usage-test-fixture.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/protocol/application.js";
import type { UsageAnalyticsRequest, UsageFacetRequest, UsageFacetResponse } from "../../shared/protocol/usage-analytics.js";
afterEach(() => vi.unstubAllGlobals());
it("uses a completed CSRF refresh for retry while a newer reconnect refresh is pending", async () => {
  let resolveRetry!: (response: Response) => void;
  let resolveReconnect!: (response: Response) => void;
  let sessions = 0, mutations = 0;
  const session = (csrfToken: string) => ({clientProtocolVersion:SEDES_CLIENT_PROTOCOL_VERSION,version:"0.1.1",csrfToken,providerPulseEnabled:false,experimentalUsageEnabled:false});
  const fetch = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/api/application/session")) {
      sessions++;
      if (sessions === 1) return Promise.resolve(Response.json(session("stale")));
      return new Promise(done => { if (sessions === 2) resolveRetry = done; else resolveReconnect = done; });
    }
    if (++mutations === 1) return Promise.resolve(Response.json({error:{code:"csrf_token_invalid",message:"Expired token",retryable:false}}, {status:403}));
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("fresh");
    return Promise.resolve(Response.json({threadId:"thread",revision:"0",turns:[{turnId:"turn",available:false}]}));
  });
  vi.stubGlobal("fetch",fetch);
  const api = new ApiClient(); await api.session();
  const mutation = api.getUsageAvailability("thread",["turn"]);
  await vi.waitFor(() => expect(sessions).toBe(2));
  const reconnect = api.session({refresh:true});
  resolveRetry(Response.json(session("fresh")));
  await expect(mutation).resolves.toMatchObject({threadId:"thread"});
  expect(mutations).toBe(2);
  resolveReconnect(Response.json(session("fresh"))); await reconnect;
});
it("retains the newest session CSRF token when reconnect refreshes finish out of order", async () => {
  let resolveOld!: (response: Response) => void;
  const session = (csrfToken: string) => ({clientProtocolVersion:SEDES_CLIENT_PROTOCOL_VERSION,version:"0.1.1",csrfToken,providerPulseEnabled:false,experimentalUsageEnabled:false});
  const fetch = vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolveOld=done;}))
    .mockResolvedValueOnce(Response.json(session("new-token")))
    .mockResolvedValueOnce(Response.json({threadId:"thread",revision:"0",turns:[{turnId:"turn",available:false}]}));
  vi.stubGlobal("fetch",fetch);
  const api = new ApiClient();
  const old = api.session(); await api.session({refresh:true});
  resolveOld(Response.json(session("old-token"))); await old;
  await api.getUsageAvailability("thread",["turn"]);
  expect(new Headers(fetch.mock.calls[2]![1].headers).get("X-CSRF-Token")).toBe("new-token");
});
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
it("reads one usage filter through its own endpoint with cancellation and exact counters", async () => {
  const request: UsageFacetRequest = { from: null, to: "2026-10-23T10:00:00.000Z", timeZone: "UTC", bucket: "auto",
    filters: { backend: ["backend-1"] }, dimension: "model", search: " opus " };
  const response: UsageFacetResponse = { generatedAt: request.to, from: request.to, to: request.to, dimension: "model",
    choices: [{ key: "opus", tokens: "9007199254740993" }], labels: {} };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: "0.2.0",
    csrfToken: "csrf-token", providerPulseEnabled: false, experimentalUsageEnabled: true })).mockResolvedValueOnce(Response.json(response));
  vi.stubGlobal("fetch", fetch);
  const api = new ApiClient();
  const abort = new AbortController();
  await expect(api.getUsageFacets(request, abort.signal)).resolves.toEqual(response);
  expect(fetch.mock.calls[1]![0]).toBe("/api/usage/facets");
  expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "POST", signal: abort.signal });
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ ...request, search: "opus" });
  expect(new Headers(fetch.mock.calls[1]![1].headers).get("X-CSRF-Token")).toBe("csrf-token");
});
it("rejects the retired combined report and facets request before sending it", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const legacy = { from: null, to: "2026-10-23T10:00:00.000Z", timeZone: "UTC", bucket: "auto", filters: {},
    groupBy: "model", crossBy: null, breakdownLimit: 8, facets: true };
  expect(() => new ApiClient().getUsageAnalytics(legacy as unknown as UsageAnalyticsRequest)).toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
