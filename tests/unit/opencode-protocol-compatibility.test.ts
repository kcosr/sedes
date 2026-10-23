import { describe, expect, it } from "vitest";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { Schema } from "effect";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { parseForm, parseModels, parseOpenCodeNativeEvent, parseOpenCodeNativeMessage, parseSession } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import { openCodeStackSafeEncodedSchema } from "../../src/server/backends/opencode/opencode-native-base64.js";
import { OpenCodeHistoryProjection } from "../../src/server/backends/opencode/opencode-history-projection.js";

describe("OpenCode runtime protocol compatibility", () => {
  const error = { type: "ProviderError", message: "Bearer fixture-secret failed", status: 503,
    response: { body: "untrusted provider response body" } };
  const model = { providerID: "fixture", id: "fixture" };
  const tokens = { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } };
  const native = { fixture: { replay: "private-provider-state" } };
  const event = (type: string, data: Record<string, unknown>, version = 1) => ({ id: "evt_native", type, created: 2,
    durable: { aggregateID: "ses_protocol", seq: 1, version }, data: { sessionID: "ses_protocol", ...data } });

  it("accepts only the 2.1 native replay fields and keeps them private in normalized history", () => {
    const assistant = { id: "msg_assistant", type: "assistant", time: { created: 1, completed: 2 }, agent: "build", model, native,
      content: [{ type: "text", text: "Answer", native }, { type: "reasoning", text: "Reasoning", native },
        { type: "tool", id: "call_read", name: "read", native, time: { created: 1, completed: 2 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: "Result" }] } }] };
    const parsed = parseOpenCodeNativeMessage(assistant);
    expect(parsed).toEqual(assistant);
    expect(() => parseOpenCodeNativeMessage({ ...assistant, providerState: native })).toThrow("opencode_native_protocol_invalid");
    for (const [index, field] of [[0, "state"], [1, "state"], [2, "providerState"], [2, "providerResultState"]] as const) {
      const content = assistant.content.map((part, position) => position === index ? { ...part, [field]: native } : part);
      expect(() => parseOpenCodeNativeMessage({ ...assistant, content })).toThrow("opencode_native_protocol_invalid");
    }
    const idle = parseOpenCodeNativeMessage({ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 3 } });
    const messages = [parsed, idle];
    const projection = new OpenCodeHistoryProjection({ sessionId: "ses_protocol", messages, frontier: "fixture", decodedBytes: 0, retainedDecodedBytes: 0, records: 2 },
      { bindingScope: ["tenant", "principal", "thread"], generation: "fixture", activity: "idle" });
    expect(JSON.stringify(projection.snapshot())).not.toContain("private-provider-state");
  });

  it("uses 2.1 compaction messages and events without obsolete recent/providerContext fields", () => {
    const completed = { id: "msg_compaction", type: "compaction", status: "completed", reason: "manual", summary: "Summary", model,
      native: { ...native, messages: [] }, cost: 0.01, tokens, time: { created: 1 } };
    expect(parseOpenCodeNativeMessage(completed)).toEqual(completed);
    for (const field of ["recent", "providerContext", "providerState"]) {
      expect(() => parseOpenCodeNativeMessage({ ...completed, [field]: field === "recent" ? "Recent" : native }))
        .toThrow("opencode_native_protocol_invalid");
    }
    const started = event("session.compaction.started", { reason: "manual", inputID: "msg_compaction" });
    const ended = event("session.compaction.ended", { reason: "manual", text: "Summary", model, native: completed.native, cost: completed.cost, tokens });
    expect(parseOpenCodeNativeEvent(started)).toEqual(started);
    expect(parseOpenCodeNativeEvent(ended)).toEqual(ended);
    expect(() => parseOpenCodeNativeEvent({ ...started, data: { ...started.data, recent: "Recent" } })).toThrow("opencode_native_protocol_invalid");
    expect(() => parseOpenCodeNativeEvent({ ...ended, data: { ...ended.data, providerContext: native } })).toThrow("opencode_native_protocol_invalid");
  });

  it("uses native replay metadata consistently across streamed completion events", () => {
    const cases = [
      { type: "session.step.ended", data: { assistantMessageID: "msg_assistant", finish: "stop", cost: 0, tokens }, old: "providerState" },
      { type: "session.step.failed", data: { assistantMessageID: "msg_assistant", error }, old: "providerState" },
      { type: "session.text.ended", data: { assistantMessageID: "msg_assistant", ordinal: 0, text: "Answer" }, old: "state" },
      { type: "session.reasoning.started", data: { assistantMessageID: "msg_assistant", ordinal: 0 }, old: "state" },
      { type: "session.reasoning.ended", data: { assistantMessageID: "msg_assistant", ordinal: 0, text: "Reasoning" }, old: "state" },
      { type: "session.tool.called", data: { assistantMessageID: "msg_assistant", id: "call_read", input: {}, executed: false }, old: "state" },
      { type: "session.tool.success", data: { assistantMessageID: "msg_assistant", id: "call_read", content: [{ type: "text", text: "Result" }], executed: false }, old: "resultState", version: 2 },
      { type: "session.tool.failed", data: { assistantMessageID: "msg_assistant", id: "call_read", error, executed: false }, old: "resultState", version: 2 },
    ];
    for (const entry of cases) {
      const value = event(entry.type, { ...entry.data, native }, entry.version);
      expect(parseOpenCodeNativeEvent(value)).toEqual(value);
      expect(() => parseOpenCodeNativeEvent({ ...value, data: { ...value.data, [entry.old]: native } })).toThrow("opencode_native_protocol_invalid");
    }
  });

  it("accepts exact native archive metadata and events without granting Sedes archive authority", () => {
    const session = { id: "ses_protocol", projectID: "prj_fixture", location: { directory: "/fixture" }, cost: 0, tokens,
      time: { created: 1, updated: 2, archived: 3 } };
    expect(parseSession(session)).toEqual(session);
    for (const type of ["session.archived", "session.unarchived"]) {
      const value = event(type, {});
      expect(parseOpenCodeNativeEvent(value)).toEqual(value);
      expect(() => parseOpenCodeNativeEvent({ ...value, data: { ...value.data, archived: true } })).toThrow("opencode_native_protocol_invalid");
    }
  });

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
      settings: { encoding: "gzip" }, compatibility: { cacheFormat: "alibaba", supportsThinkingBlockBinding: true, supportsEffortUpdates: false, streamUsage: false },
    }] };
    expect(parseModels(models)).toEqual(models);
    expect(() => parseModels({ ...models, data: [{ ...models.data[0], compatibility: { streamUsage: "false" } }] }))
      .toThrow("opencode_native_protocol_invalid");
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
    const info = { version: "2.1.1", pid: 123, urls: [], paths: { tmp: "/tmp/fixture" }, capabilities: { persistentPty: true } };
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
