import { describe, expect, it } from "vitest";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { Schema } from "effect";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { parseForm, parseModels, parseOpenCodeNativeEvent, parseOpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import { openCodeStackSafeEncodedSchema } from "../../src/server/backends/opencode/opencode-native-base64.js";
import { OpenCodeHistoryProjection } from "../../src/server/backends/opencode/opencode-history-projection.js";

describe("OpenCode runtime protocol compatibility", () => {
  const error = { type: "ProviderError", message: "Bearer fixture-secret failed", status: 503,
    response: { body: "untrusted provider response body" } };

  it("retains terminal errors in native history and events while normalizing only the safe diagnostic", () => {
    const idle = { id: "msg_end", type: "idle", time: { created: 2 }, outcome: "failed", error };
    expect(parseOpenCodeNativeMessage(idle)).toEqual(idle);
    const event = { id: "evt_error", type: "session.execution.failed", created: 2,
      durable: { aggregateID: "ses_protocol", seq: 1, version: 1 }, data: { sessionID: "ses_protocol", error } };
    expect(parseOpenCodeNativeEvent(event)).toEqual(event);
    const messages = [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }, idle].map(parseOpenCodeNativeMessage);
    const projection = new OpenCodeHistoryProjection({ sessionId: "ses_protocol", messages, headId: "msg_end", frontier: "fixture",
      decodedBytes: Buffer.byteLength(JSON.stringify(messages)), retainedDecodedBytes: Buffer.byteLength(JSON.stringify(messages)), records: messages.length },
    { bindingScope: ["tenant", "principal", "thread"], generation: "fixture", activity: "idle" });
    expect(projection.turnsById[projection.orderedBackendTurnIds[0]!]!.failure)
      .toEqual({ message: { text: "Bearer [redacted] failed" } });
    expect(JSON.stringify(projection.turnsById)).not.toContain(error.response.body);
    expect(() => parseOpenCodeNativeMessage({ ...idle, error: { ...error, response: { body: 42 } } }))
      .toThrow("opencode_native_protocol_invalid");
  });

  it("accepts the optional cancellation message and model compatibility settings", () => {
    const form = { id: "frm_cancelled", sessionID: "ses_protocol", title: "Question", fields: [{ type: "string", key: "answer" }],
      state: { status: "cancelled", message: "This client cannot answer the form." } };
    expect(parseForm(form)).toEqual(form);
    const models = { location: { directory: "/fixture" }, data: [{
      ...Model.Info.default(Provider.ID.make("fixture"), Model.ID.make("fixture")),
      settings: { encoding: "gzip" }, compatibility: { cacheFormat: "alibaba", supportsThinkingBlockBinding: true, supportsEffortUpdates: false },
    }] };
    expect(parseModels(models)).toEqual(models);
    expect(() => parseForm({ ...form, state: { ...form.state, unexpected: true } })).toThrow("opencode_native_protocol_invalid");
  });

  it("accepts the optional 2.0.32 sampling-temperature capability without requiring it", () => {
    const model = Model.Info.default(Provider.ID.make("fixture"), Model.ID.make("fixture"));
    const models = { location: { directory: "/fixture" }, data: [model] };
    expect(parseModels(models)).toEqual(models);
    for (const temperature of [true, false]) {
      const response = { ...models, data: [{ ...model, capabilities: { ...model.capabilities, temperature } }] };
      expect(parseModels(response)).toEqual(response);
    }
    expect(() => parseModels({ ...models, data: [{ ...model, capabilities: { ...model.capabilities, temperature: "yes" } }] }))
      .toThrow("opencode_native_protocol_invalid");
  });

  it("accepts the optional server capabilities and still rejects malformed capability values", async () => {
    const info = { version: "2.0.29", pid: 123, urls: [], paths: { tmp: "/tmp/fixture" }, capabilities: { persistentPty: true } };
    const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async () => Response.json(info) });
    try {
      await expect(client.info()).resolves.toEqual(info);
    } finally { client.close(); }
    const invalid = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture",
      fetch: async () => Response.json({ ...info, capabilities: { persistentPty: "yes" } }) });
    try {
      await expect(invalid.info()).rejects.toThrow("opencode_request_failed");
    } finally { invalid.close(); }
  });

  it("preserves Effect union matching options when replacing the native Base64 validator", () => {
    const one = Schema.Union([Schema.String, Schema.String], { mode: "oneOf" });
    const parse = Schema.decodeUnknownSync(openCodeStackSafeEncodedSchema(one, false));
    expect(() => parse("ambiguous")).toThrow();
  });
});
