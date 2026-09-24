// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import type { AcceptHostRegistrationRequest } from "../../shared/protocol/host-pairing.js";
import { configuredSedesServer } from "../app/server-endpoint.js";
import { ApiClient } from "./ApiClient.js";

const id = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-12T12:00:00.000Z";
const metadata = { hostname: "Studio", platform: "darwin", architecture: "arm64", account: "operator", connectorVersion: "1" };
const registration = { id, connectorId: id, registrationAttemptId: id, metadata, correlationCode: "ABCD-1234", state: "accepted", revision: 1,
  createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, expiresAt: timestamp, pairingId: id };
const pairing = { id, connectorId: id, executionEnvironmentId: id, platform: "darwin", metadata, state: "accepted", revision: 1,
  createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp };
const configuration = { revision: 1, configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null }, runtimes: [] };
afterEach(() => vi.unstubAllGlobals());

describe("host pairing API", () => {
  it("downloads from the configured HTTP server rather than the packaged client origin", () => {
    expect(new ApiClient(configuredSedesServer("http://192.168.1.20:4784")).outboundConnectorSetup()).toEqual({
      serverUrl: "http://192.168.1.20:4784", downloadUrl: "http://192.168.1.20:4784/api/outbound/connector/sedes-sidecar.mjs",
    });
  });
  it("uses HTTP endpoint routing, server session CSRF, strict requests and normalized responses for every decision", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/application/session")) return Response.json({ clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: SEDES_VERSION, csrfToken: "a".repeat(32), providerPulseEnabled: false, experimentalUsageEnabled: false });
      if (String(url).endsWith("/api/host-registrations")) return Response.json({ registrations: [{ ...registration, connected: true }], pairings: [{ ...pairing, connected: false }] });
      expect(init).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "a".repeat(32) }) });
      expect(JSON.parse(String(init?.body))).toMatchObject({ mutationId: id });
      if (String(url).endsWith("/accept")) return Response.json({ registration, pairing, configuration });
      if (String(url).endsWith("/deny")) return Response.json({ ...registration, state: "denied", pairingId: null });
      return Response.json({ pairing, configuration });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient();
    await expect(api.listHostRegistrations()).resolves.toMatchObject({ registrations: [{ connected: true }], pairings: [{ connected: false }] });
    const accept: AcceptHostRegistrationRequest = { mutationId: id, registrationId: id, expectedRegistrationRevision: 1, expectedConfigurationRevision: 0,
      label: "Studio", workspaceRoots: ["/Users/operator/Projects"], operations: { kind: "sidecar", enabledCapabilities: ["workspace_files"] } };
    await expect(api.acceptHostRegistration(accept)).resolves.toMatchObject({ pairing, configuration });
    await expect(api.denyHostRegistration({ mutationId: id, registrationId: id, expectedRegistrationRevision: 1 })).resolves.toMatchObject({ state: "denied" });
    const change = { mutationId: id, pairingId: id, expectedPairingRevision: 1, expectedConfigurationRevision: 1 };
    await expect(api.revokeHostPairing(change)).resolves.toMatchObject({ pairing });
    await expect(api.reapproveHostPairing(change)).resolves.toMatchObject({ pairing });
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    for (const path of ["/api/host-registrations", "/api/host-registrations/accept", "/api/host-registrations/deny", "/api/host-pairings/revoke", "/api/host-pairings/reapprove"]) expect(urls.some(url => url.endsWith(path))).toBe(true);
    const count = fetchMock.mock.calls.length;
    expect(() => api.acceptHostRegistration({ ...accept, principalId: "browser-choice" } as AcceptHostRegistrationRequest)).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("rejects missing live presence and unknown fields rather than displaying stale pairing truth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ registrations: [registration], pairings: [] }))
      .mockResolvedValueOnce(Response.json({ registrations: [], pairings: [], authenticationToken: "forbidden" })));
    const api = new ApiClient();
    await expect(api.listHostRegistrations()).rejects.toThrow();
    await expect(api.listHostRegistrations()).rejects.toThrow();
  });
});
