import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PiRequestThroughput } from "../../src/server/backends/pi/pi-request-throughput.js";
import { piCancellationStream } from "../../src/server/backends/pi/pi-cancellation-stream.js";

const model: Model<"openai-responses"> = {
  id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai", baseUrl: "http://fixture.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};
const context = normalizeContext({ messages: [] });
function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Response" }], stopReason, timestamp: 1,
    usage: { input: 20, output: 100, reasoning: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

describe("Pi request throughput boundary", () => {
  it("includes async request setup, stops at source completion, and snapshots output before extension mutation", async () => {
    let now = 10;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const stream = await collector.wrap(async () => { now += 400; return source; })(model, context);
    const response = message();
    now += 600;
    source.push({ type: "done", reason: "stop", message: response });
    source.end(response);
    expect(await stream.result()).toBe(response);
    now += 9000; // A slow consumer/extension is not model request time.
    response.usage.output = 999;
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toHaveLength(1);
    expect(collector.take(response)).toEqual({ outputTokens: 100, requestDurationMs: 1000 });
    expect(collector.take(response)).toBeUndefined();
  });

  it.each(["error", "aborted", "pending", "deferred"] as const)("does not turn %s results into a complete measurement", async (stopReason) => {
    let now = 0;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const stream = await collector.wrap(() => source)(model, context);
    now = 1000;
    const response = message(stopReason);
    source.end(response);
    await stream.result();
    expect(collector.take(response)).toBeUndefined();
  });

  it.each<AssistantMessage["content"][number]>([
    { type: "text", text: "Response without reported usage" },
    { type: "thinking", thinking: "Reasoning without reported usage" },
    { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
  ])("rejects zero-output usage for a nonempty $type response", async (content) => {
    let now = 0;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const stream = await collector.wrap(() => source)(model, context);
    const response = message(content.type === "toolCall" ? "toolUse" : "stop");
    response.content = [content];
    response.usage.output = 0;
    now = 1000;
    source.end(response);
    await stream.result();
    expect(collector.take(response)).toBeUndefined();
  });

  it("retains request time for a genuinely empty zero-output response", async () => {
    let now = 0;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const stream = await collector.wrap(() => source)(model, context);
    const response = message();
    response.content = [{ type: "text", text: "" }];
    response.usage.output = 0;
    response.usage.reasoning = 0;
    now = 1000;
    source.end(response);
    await stream.result();
    expect(collector.take(response)).toEqual({ outputTokens: 0, requestDurationMs: 1000 });
  });

  it("observes the exact cancellation-normalized object without admitting cancelled output", async () => {
    let now = 0;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const abort = new AbortController();
    const stream = await collector.wrap(piCancellationStream(() => source))(model, context, { signal: abort.signal });
    abort.abort();
    now = 1000;
    const response = message("error");
    source.push({ type: "error", reason: "error", error: response });
    source.end(response);
    const cancelled = await stream.result();
    expect(cancelled).not.toBe(response);
    expect(cancelled.stopReason).toBe("aborted");
    expect(collector.take(cancelled)).toBeUndefined();
  });

  it.each([0, -10, Infinity, NaN])("omits invalid clock duration %s", async (duration) => {
    let now = 0;
    const collector = new PiRequestThroughput(() => now);
    const source = new AssistantMessageEventStream();
    const stream = await collector.wrap(() => source)(model, context);
    now = duration;
    const response = message();
    source.end(response);
    await stream.result();
    expect(collector.take(response)).toBeUndefined();
  });
});
