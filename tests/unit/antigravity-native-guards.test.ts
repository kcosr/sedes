import { describe, expect, it } from "vitest";
import { assertAntigravityNativeSemantics } from "../../src/server/backends/antigravity/native-guards.js";
import { decodeAntigravityNativeMessage } from "../../src/server/backends/antigravity/native-protobuf.js";

describe("Antigravity native schema admission", () => {
  it("allows compatible additive fields without admitting moved identity payloads", () => {
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, user_input: { items: [{ text: "input" }] }, future_field: "additive" })).not.toThrow();
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, future_user_input: { items: [{ text: "input" }] } })).toThrow("layout_incompatible");
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, user_input: { future_items: [{ text: "input" }] } })).toThrow("content_unsupported");
  });
  it("does not turn an absent terminal reason into a successful completed response", () => {
    expect(() => assertAntigravityNativeSemantics({ type: 15, status: 8, planner_response: {} })).not.toThrow();
    expect(() => assertAntigravityNativeSemantics({ type: 15, status: 3, planner_response: { response: "output" } })).toThrow("completion_evidence_missing");
    expect(() => assertAntigravityNativeSemantics({ type: 15, status: 3, planner_response: { response: "output", stop_reason: 2 } })).not.toThrow();
  });
  it("accepts empty proto3 text and scope-only user items without accepting a missing user container", () => {
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, user_input: { items: [{}] } })).not.toThrow();
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, user_input: { items: [{ item: {} }] } })).not.toThrow();
    expect(() => assertAntigravityNativeSemantics({ type: 14, status: 3, user_input: { items: ["invalid"] } })).toThrow("content_unsupported");
  });
  it("rejects malformed known protobuf fields, truncation and duplicate scalars", () => {
    expect(() => decodeAntigravityNativeMessage(Uint8Array.of(10, 1, 14), ".gemini_coder.Step")).toThrow("field_type_changed");
    expect(() => decodeAntigravityNativeMessage(Uint8Array.of(8, 14, 8, 15), ".gemini_coder.Step")).toThrow("duplicate_field");
    expect(() => decodeAntigravityNativeMessage(Uint8Array.of(154, 1, 99), ".gemini_coder.Step")).toThrow("length_invalid");
    expect(() => decodeAntigravityNativeMessage(Uint8Array.of(8, 128), ".gemini_coder.Step")).toThrow("varint_invalid");
  });
});
