import { describe, expect, it } from "vitest";
import { Base64 } from "@opencode/schema/prompt";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { PublicSessionMessage } from "@opencode/protocol/groups/message";
import { Schema } from "effect";
import { openCodeNativeParser, parseOpenCodeNativeMessage, parseOpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-api.js";
import { openCodeStackSafeEncodedSchema, validOpenCodeBase64 } from "../../src/server/backends/opencode/opencode-native-base64.js";
const file = (data: string) => ({ data, mime: "image/png", source: { type: "inline" } });
describe("stack-safe official OpenCode Base64 refinement", () => {
  it("matches the official lexical language, including empty input and noncanonical padding bits", () => {
    const official = Schema.decodeUnknownSync(Base64);
    const candidates = ["", "AA==", "AB==", "AAA=", "AAB=", "AAAA", "A", "AA", "AAA", "A===", "====", "AA=A", "AAAA=", "AA-_", "AAAA\n", "éAAA"];
    const alphabet = ["A", "/", "+", "=", "\n"];
    for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) for (const d of alphabet) candidates.push(a + b + c + d);
    for (const value of candidates) {
      let valid = true; try { official(value); } catch { valid = false; }
      expect(validOpenCodeBase64(value), JSON.stringify(value)).toBe(valid);
    }
  });
  it("validates large user history and admission payloads while preserving official shapes", () => {
    const data = "A".repeat(6 * 1_024 * 1_024);
    const message = { id: "msg_large", type: "user", text: "image", time: { created: 1 }, files: [file(data)] };
    expect(parseOpenCodeNativeMessage(message)).toEqual(message);
    const admission = { id: "msg_large", sessionID: "ses_images", type: "user", payload: { text: "image", files: [file(data)] }, delivery: "queue", time: { created: 1 } };
    expect(openCodeNativeParser(SessionInbox.User)(admission)).toEqual(admission);
    const event = { id: "evt_large", type: "session.inbox.enqueued", created: 1, durable: { aggregateID: "ses_images", seq: 1, version: 1 },
      data: { sessionID: "ses_images", inboxID: "msg_large", item: { type: "user", delivery: "queue", payload: admission.payload } } };
    expect(parseOpenCodeNativeEvent(event)).toEqual(event);
    expect(() => parseOpenCodeNativeMessage({ ...message, extra: true })).toThrow("opencode_native_protocol_invalid");
    expect(() => parseOpenCodeNativeMessage({ ...message, files: [{ ...file(data), extra: true }] })).toThrow("opencode_native_protocol_invalid");
    expect(() => parseOpenCodeNativeMessage({ ...message, files: [file(data.slice(1))] })).toThrow("opencode_native_protocol_invalid");
  });
  it("allows a 16MiB decoded image's base64 expansion within the 32MiB native bound", () => {
    const data = Buffer.alloc(16 * 1_024 * 1_024).toString("base64");
    const message = { id: "msg_maximum_image", type: "user", text: "image", time: { created: 1 }, files: [file(data)] };
    expect(parseOpenCodeNativeMessage(message)).toEqual(message);
  });
  it("retains nested optional fields, unions and ordinary native message constraints", () => {
    const parse = Schema.decodeUnknownSync(openCodeStackSafeEncodedSchema(PublicSessionMessage, true), { onExcessProperty: "error" });
    const valid = { id: "msg_user", type: "user", text: "", time: { created: 1 }, files: [{ ...file("AAAA"), name: "image.png" }] };
    expect(parse(valid)).toEqual(valid);
    expect(() => parse({ ...valid, files: [{ ...file("AAAA"), source: { type: "other" } }] })).toThrow();
    expect(() => parse({ ...valid, time: { created: "yesterday" } })).toThrow();
    expect(() => parse({ ...valid, type: "unknown" })).toThrow();
  });
  it("fails closed if an identified Base64 schema adds or substitutes constraints", () => {
    const replaced = Schema.String.check(Schema.isMinLength(4)).annotate({ identifier: "Prompt.Base64" });
    expect(() => openCodeStackSafeEncodedSchema(replaced, true)).toThrow("opencode_base64_schema_changed");
    const augmented = Base64.check(Schema.isMinLength(4)).annotate({ identifier: "Prompt.Base64" });
    expect(() => openCodeStackSafeEncodedSchema(augmented, true)).toThrow("opencode_base64_schema_changed");
  });
});
