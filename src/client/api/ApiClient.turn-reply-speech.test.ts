// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());

it("reads one turn's stored reply text by escaped thread and turn and forwards cancellation", async () => {
  const body = { assistantResult: { final: { text: "Stored final answer." }, unclassified: null } };
  const fetch = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await expect(new ApiClient().readTurnReplySpeech("thread/1", "turn:1", controller.signal)).resolves.toEqual(body);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe("/api/threads/thread%2F1/turns/turn%3A1/reply-speech");
  expect(options).toMatchObject({ signal: controller.signal });
  expect(options.method ?? "GET").toBe("GET");
  expect(options.body).toBeUndefined();
});

it("accepts a turn without stored completion text", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assistantResult: null })));
  await expect(new ApiClient().readTurnReplySpeech("thread-1", "turn-1")).resolves.toEqual({ assistantResult: null });
});

it("rejects a response outside the contract and preserves HTTP errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assistantResult: { summary: { text: "Not a phase." } } })));
  await expect(new ApiClient().readTurnReplySpeech("thread-1", "turn-1")).rejects.toThrow();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
  await expect(new ApiClient().readTurnReplySpeech("thread-1", "turn-1")).rejects.toThrow();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    error: { code: "not_found", message: "The thread was not found.", retryable: false },
  }, { status: 404 })));
  await expect(new ApiClient().readTurnReplySpeech("thread-1", "turn-1")).rejects.toMatchObject({ status: 404, code: "not_found" });
});
