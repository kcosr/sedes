// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/protocol/application.js";

afterEach(() => vi.unstubAllGlobals());

it("dismisses the exact notice occurrence with CSRF and no persisted mutation receipt", async () => {
  const fetch = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(
    url.endsWith("/api/application/session")
      ? Response.json({ clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: "0.2.0", csrfToken: "a".repeat(32), providerPulseEnabled: false, experimentalUsageEnabled: false })
      : new Response(null, { status: 204 }),
  ));
  vi.stubGlobal("fetch", fetch);
  const api = new ApiClient();
  await api.session();
  await api.dismissRuntimeNotice("thread/1", { generation: "runtime-1", noticeId: "occurrence-1" });
  const request = fetch.mock.calls.find(([url]) => url.endsWith("/notices/dismiss"))!;
  expect(request[0]).toBe("/api/threads/thread%2F1/notices/dismiss");
  expect(request[1]!.method).toBe("POST");
  expect(JSON.parse(request[1]!.body as string)).toEqual({ generation: "runtime-1", noticeId: "occurrence-1" });
  expect(new Headers(request[1]!.headers).get("X-CSRF-Token")).toBe("a".repeat(32));
});
