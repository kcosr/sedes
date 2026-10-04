// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

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
