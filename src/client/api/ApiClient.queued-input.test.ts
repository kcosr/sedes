// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/protocol/application.js";
import { SEDES_VERSION } from "../../shared/version.js";

const threadId = "88b72554-a697-4ebc-9d96-b2ab09343f13";
const input = {
  threadId,
  threadRevision: 8,
  queuedInputId: "input/1",
  deliveryOperationId: "operation-1",
  createdAt: "2026-10-03T12:00:00.000Z",
  state: "accepted",
  resolvedDeliveryMode: "submit",
  origin: "user",
  content: [{ kind: "text", text: { text: "Full spoken input" } }],
};

afterEach(() => vi.unstubAllGlobals());

describe("queued input presentation API", () => {
  it("reads the exact retained input without a mutation and forwards cancellation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(input));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(new ApiClient().readQueuedInput(threadId, "input/1", { signal: controller.signal })).resolves.toEqual(input);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/threads/${threadId}/queued-inputs/input%2F1`);
    expect(options).toMatchObject({ signal: controller.signal });
    expect(options.body).toBeUndefined();
    expect(options.method ?? "GET").toBe("GET");
  });

  it("rejects an invalid response instead of treating it as accepted delivery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...input, state: "gone" })));
    await expect(new ApiClient().readQueuedInput(threadId, "input/1")).rejects.toThrow();
  });

  it("preserves a missing-input error for presentation reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: { code: "not_found", message: "The queued input was not found.", retryable: false },
    }, { status: 404 })));
    await expect(new ApiClient().readQueuedInput(threadId, "input/1")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("abandoned input operation lookup API", () => {
  const id = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  function mockLookup(result: unknown) {
    const fetch = vi.fn(async (url: string | URL | Request, _options?: RequestInit) => Response.json(
      String(url) === "/api/application/session"
        ? { clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: SEDES_VERSION, csrfToken: "a".repeat(32), providerPulseEnabled: false, experimentalUsageEnabled: false }
        : result,
    ));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("posts only bounded operation identities with CSRF and cancellation", async () => {
    const questionId = `question:${id(7)}:2`;
    const result = { threadId, abandonedOperationIds: [id(1), questionId] };
    const fetch = mockLookup(result);
    const controller = new AbortController();
    await expect(new ApiClient().readAbandonedInputOperations(threadId, [id(2), id(1), questionId], controller.signal)).resolves.toEqual(result);
    const [url, options] = fetch.mock.calls[1]!;
    expect(url).toBe(`/api/threads/${threadId}/abandoned-input-operations`);
    expect(options).toMatchObject({ method: "POST", signal: controller.signal });
    expect(JSON.parse(String(options?.body))).toEqual({ operationIds: [id(2), id(1), questionId] });
    expect(new Headers(options?.headers).get("X-CSRF-Token")).toBe("a".repeat(32));
  });

  it.each([
    { threadId: "88b72554-a697-4ebc-9d96-b2ab09343f14", abandonedOperationIds: [id(3)] },
    { threadId, abandonedOperationIds: [id(4)] },
    { threadId, abandonedOperationIds: [id(3), id(3)] },
    { threadId, abandonedOperationIds: [id(3)], acceptedOperationIds: [] },
  ])("rejects unrelated or malformed abandonment authority: %j", async result => {
    mockLookup(result);
    await expect(new ApiClient().readAbandonedInputOperations(threadId, [id(3)])).rejects.toThrow();
  });

  it.each([[], [""], ["x".repeat(161)], [id(5), id(5)], Array.from({ length: 101 }, (_, index) => id(index))].map(operationIds => ({ operationIds })))(
    "rejects invalid batches before sending", async ({ operationIds }) => {
      const fetch = mockLookup({ threadId, abandonedOperationIds: [] });
      await expect(new ApiClient().readAbandonedInputOperations(threadId, operationIds)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not interpret omitted operation IDs as acceptance or rejection", async () => {
    mockLookup({ threadId, abandonedOperationIds: [] });
    await expect(new ApiClient().readAbandonedInputOperations(threadId, [id(6)])).resolves.toEqual({ threadId, abandonedOperationIds: [] });
  });
});
