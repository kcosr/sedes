// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { attachmentContentDisposition, SEDES_DOWNLOAD_REVISION_HEADER } from "../../shared/downloads.js";
import { pageDownloadFileName } from "../../shared/page-download.js";
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

describe("page download preflight", () => {
  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentContentDisposition("attachment", pageDownloadFileName(page.title, page.revision)),
      "Content-Length": String(page.byteSize + 3),
      [SEDES_DOWNLOAD_REVISION_HEADER]: page.sha256,
    };
  }

  it.each([false, true])("authenticates an exact saved revision without reading its body (configured=%s)", async (configured) => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { headers: headers() }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const client = configured
      ? new ApiClient(configuredSedesServer("https://sedes.example"), "paired-credential")
      : new ApiClient();
    const prepared = await client.preparePageDownload(page.threadId, page, controller.signal);
    const path = `/api/threads/thread%2Fone/pages/${page.pageId}/revisions/1/download`;
    expect(prepared).toEqual({
      url: configured ? `https://sedes.example${path}` : path,
      serverOrigin: configured ? "https://sedes.example" : window.location.origin,
      suggestedFileName: pageDownloadFileName(page.title, 1),
      contentDisposition: headers()["Content-Disposition"],
      contentLength: page.byteSize + 3,
      revision: page.sha256,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD", redirect: "error", credentials: configured ? "omit" : "same-origin", signal: controller.signal });
    const sentHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(sentHeaders.get("Accept")).toBe("application/octet-stream");
    expect(sentHeaders.get("Authorization")).toBe(configured ? "Bearer paired-credential" : null);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("credential");
  });

  it.each([
    { "Content-Type": "text/html" },
    { "Content-Length": String(page.byteSize) },
    { "Content-Length": "3.23e2" },
    { "Content-Length": "" },
    { "Content-Disposition": 'inline; filename="page.html"' },
    { "Content-Disposition": attachmentContentDisposition("attachment", "wrong.html") },
    { [SEDES_DOWNLOAD_REVISION_HEADER]: "b".repeat(64) },
    { [SEDES_DOWNLOAD_REVISION_HEADER]: "" },
  ])("rejects inconsistent preflight metadata %j", async (invalidHeaders) => {
    const responseHeaders = new Headers(headers());
    for (const [name, value] of Object.entries(invalidHeaders))
      if (value !== undefined) responseHeaders.set(name, value);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { headers: responseHeaders })));
    await expect(new ApiClient().preparePageDownload(page.threadId, page)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects partial responses, HTTP failure, and a descriptor from another thread", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 206, headers: headers() }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient();
    await expect(client.preparePageDownload(page.threadId, page)).rejects.toMatchObject({ code: "invalid_response" });
    fetch.mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(client.preparePageDownload(page.threadId, page)).rejects.toMatchObject({ code: "page_download_unavailable", retryable: false });
    fetch.mockClear();
    await expect(client.preparePageDownload("wrong-thread", page)).rejects.toThrow("selected thread");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("submits page responses through registered input authority and validates receipt identities", async () => {
  const threadId = "10000000-0000-4000-8000-000000000001";
  const request = {
    mutationId: "20000000-0000-4000-8000-000000000001",
    text: "  untouched\ntext  ",
    pageResponse: { pageId: page.pageId, revision: 1 },
    runningPolicy: { mode: "queue" as const },
  };
  const receipt = {
    mutationId: request.mutationId, operationId: request.mutationId, threadId: threadId,
    admittedMode: "queue", currentMode: "queue", status: "queued", queuedInputId: "queued-page",
  };
  const requests: { input: string; init?: RequestInit }[] = [];
  let wrongIdentity = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push({ input, init });
    if (input.endsWith("/session")) return Response.json(session());
    const result = wrongIdentity ? { ...receipt, threadId: "10000000-0000-4000-8000-000000000002" } : receipt;
    return Response.json(input.includes("/input-receipts/") ? { status: "found", receipt: result } : result);
  }));
  const api = new ApiClient(undefined, undefined, () => ({
    clientId: "30000000-0000-4000-8000-000000000009", connectionToken: "registered-token",
  }));
  await expect(api.submitDirectInput(threadId, request)).resolves.toEqual(receipt);
  const sent = requests.find(({ input }) => input.endsWith("/inputs"))!;
  expect(sent.input).toBe(`/api/threads/${threadId}/inputs`);
  expect(JSON.parse(String(sent.init?.body))).toEqual(request);
  expect(new Headers(sent.init?.headers).get("X-Sedes-Client")).toBe("registered-token");
  expect(new Headers(sent.init?.headers).get("X-CSRF-Token")).toBe("a".repeat(32));
  await expect(api.readDirectInputReceipt(threadId, request.mutationId)).resolves.toEqual({ status: "found", receipt });
  expect(requests.at(-1)?.input).toBe(`/api/input-receipts/${request.mutationId}`);
  wrongIdentity = true;
  await expect(api.submitDirectInput(threadId, request)).rejects.toMatchObject({ code: "invalid_response" });
  await expect(api.readDirectInputReceipt(threadId, request.mutationId)).rejects.toMatchObject({ code: "invalid_response" });
  await expect(api.submitDirectInput(threadId, { ...request, origin: { clientId: "30000000-0000-4000-8000-000000000009" } } as never)).rejects.toThrow();
});
