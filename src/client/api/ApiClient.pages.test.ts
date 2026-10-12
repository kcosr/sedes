// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { configuredSedesServer } from "../app/server-endpoint.js";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());

const page = {
  pageId: "30000000-0000-4000-8000-000000000001",
  threadId: "thread/one",
  revision: 1,
  title: "Phone",
  viewport: { width: 390, height: 844 },
  createdAt: "2026-10-11T10:00:00.000Z",
  sha256: "a".repeat(64),
  byteSize: 320,
};
function session() {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "a".repeat(32),
    providerPulseEnabled: false,
    experimentalUsageEnabled: false,
  };
}

describe("page API", () => {
  it("validates scoped metadata and preserves pagination options", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ items: [page], nextCursor: "next" }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient();
    await expect(
      api.listThreadPages(page.threadId, { cursor: "before&after", limit: 20 }),
    ).resolves.toEqual({ items: [page], nextCursor: "next" });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/api/threads/thread%2Fone/pages?cursor=before%26after&limit=20",
    );
    await api.listPageRevisions(page.threadId, page.pageId, { limit: 1 });
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      `/pages/${page.pageId}/revisions?limit=1`,
    );
  });

  it("mints document-only URLs through authenticated CSRF requests at the configured server", async () => {
    const requests: { input: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        requests.push({ input, init });
        return Response.json(
          input.endsWith("/session")
            ? session()
            : {
                url: "/page-render/document_token",
                expiresAt: "2026-10-11T10:10:00.000Z",
              },
        );
      }),
    );
    const api = new ApiClient(
      configuredSedesServer("https://sedes.example"),
      "secret-pairing-credential",
    );
    await expect(
      api.createPageRenderAdmission(page.threadId, page.pageId, 1),
    ).resolves.toEqual({
      url: "https://sedes.example/page-render/document_token",
      expiresAt: "2026-10-11T10:10:00.000Z",
    });
    expect(requests[1]?.init?.method).toBe("POST");
    expect(new Headers(requests[1]?.init?.headers).get("X-CSRF-Token")).toBe(
      "a".repeat(32),
    );
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe(
      "Bearer secret-pairing-credential",
    );
    expect(requests[1]?.input).not.toContain("secret-pairing-credential");
  });

  it("rejects off-server or credential-bearing render URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        Response.json(
          input.endsWith("/session")
            ? session()
            : {
                url: "https://hostile.example/page-render/token",
                expiresAt: "2026-10-11T10:10:00.000Z",
              },
        ),
      ),
    );
    await expect(
      new ApiClient().createPageRenderAdmission(page.threadId, page.pageId, 1),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
