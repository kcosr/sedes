// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import type { SaveConfigurationRequest } from "../../shared/protocol/configuration-admin.js";
import { ApiClient } from "./ApiClient.js";

const configuration = { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null };
const snapshot = { revision: 0, configuration, runtimes: [] };
const mutationId = "30000000-0000-4000-8000-000000000001";
function session() { return { clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: SEDES_VERSION, csrfToken: "a".repeat(32), providerPulseEnabled: false }; }
afterEach(() => vi.unstubAllGlobals());

describe("ApiClient execution configuration", () => {
  it("loads empty configuration without requiring a backend or application inventory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().readConfiguration()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/configuration");
  });

  it("saves one validated principal-derived document using CSRF and a fixed mutation identity", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/application/session")) return Response.json(session());
      expect(String(url)).toContain("/api/configuration");
      expect(init).toMatchObject({ method: "PUT", headers: expect.objectContaining({ "X-CSRF-Token": "a".repeat(32) }) });
      expect(JSON.parse(String(init?.body))).toEqual({ mutationId, expectedRevision: 0, configuration });
      return Response.json({ ...snapshot, revision: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().saveConfiguration({ mutationId, expectedRevision: 0, configuration })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(() => new ApiClient().saveConfiguration({ mutationId, expectedRevision: 0, configuration, principalId: "chosen-by-browser" } as SaveConfigurationRequest)).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves lifecycle impact token and exact runtime incarnation", async () => {
    const runtime = { resourceKind: "environment", resourceId: "env", desiredRevision: 2, effectiveRevision: 2, applyState: "applied", preference: "automatic", connectionState: "reconciling", incarnation: "new-service", softwareVersion: "2", upgradeState: "current", activeResources: 0, supportedActions: ["disconnect"], lastError: null };
    const request = { mutationId, expectedRevision: 2, resourceKind: "environment" as const, resourceId: "env", action: "upgrade" as const, expectedIncarnation: "old-service", impactToken: "confirmed-token" };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/application/session")) return Response.json(session());
      expect(String(url)).toContain("/api/configuration/lifecycle");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json({ mutationId, state: "pending", runtime });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().configurationLifecycle(request)).resolves.toMatchObject({ state: "pending", runtime });
  });

  it("rejects unknown fields in server configuration responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...snapshot, token: "must-not-be-exposed" })));
    await expect(new ApiClient().readConfiguration()).rejects.toThrow();
  });

  it("reads the original lifecycle receipt with an exact response schema and no mutation", async () => {
    const runtime = { resourceKind: "environment", resourceId: "env", desiredRevision: 2, effectiveRevision: 2, applyState: "applied", preference: "automatic", connectionState: "connected", incarnation: "service", softwareVersion: "2", upgradeState: "current", activeResources: 0, supportedActions: ["disconnect"], lastError: null };
    const result = { mutationId, state: "applied", runtime };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(Response.json({ ...result, extra: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient();
    await expect(api.getLifecycleReceipt(mutationId)).resolves.toEqual(result);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`/api/configuration/lifecycle/${mutationId}`);
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined();
    await expect(api.getLifecycleReceipt(mutationId)).rejects.toThrow();
    expect(() => api.getLifecycleReceipt("invalid/id")).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery inspection read-only and acknowledges with its exact server confirmation", async () => {
    const reference = { kind: "shell" as const, receiptId: mutationId };
    const operation = { ...reference, state: "succeeded", summary: "Build", acknowledgeable: true, details: "Exit 0", stdout: "done", stderr: "", omittedBytes: 0 };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/application/session")) return Response.json(session());
      if (String(url).endsWith("/acknowledge")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ confirmationToken: "inspection-token" });
        return Response.json({ acknowledged: true });
      }
      expect(String(url)).toContain(`/api/configuration/environments/host%2Fscope/operations/shell/${mutationId}`);
      expect(init?.method).toBeUndefined();
      return Response.json({ operation, confirmationToken: "inspection-token" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient();
    await expect(api.inspectConfigurationOperation("host/scope", reference)).resolves.toEqual({ operation, confirmationToken: "inspection-token" });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(api.acknowledgeConfigurationOperation("host/scope", reference, { confirmationToken: "inspection-token" })).resolves.toEqual({ acknowledged: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
