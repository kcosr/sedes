import { describe, expect, it } from "vitest";
import { antigravityFailedSubagentSessionId, assertAntigravityNativeSemantics } from "../../src/server/backends/antigravity/native-guards.js";
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

describe("Antigravity system subagent failure messages", () => {
  const parentId = "8a54e222-1000-4000-8000-000000000001", childId = "8a54e222-1000-4000-8000-000000000002";
  const otherId = "8a54e222-1000-4000-8000-000000000003", messageId = "8a54e222-1000-4000-8000-000000000004";
  const body = (name: string, id: string, error = "Execution failed") =>
    `The subagent ${name} with id "${id}" encountered an error and has either stopped or failed to start execution: ${error}`;
  const agentMessage = (name = "Reviewer") => ({ id: messageId, sender: "system", recipient: parentId,
    render_details: { message_title: `Error from ${name}` }, content: body(name, childId) });
  const incoming = agentMessage();
  const system = { agent_message: incoming };
  const step = { type: 101, status: 3, metadata: { source: 5 }, system_message: system };

  it("correlates the UUID after the entire display name independently of error details", () => {
    const name = body("Reviewer", otherId);
    const agent = { ...agentMessage(name), content: body(name, childId, body("Other", otherId)) };
    expect(antigravityFailedSubagentSessionId({ ...step, system_message: { agent_message: agent } }, parentId)).toBe(childId);
  });
  it.each([
    { ...step, type: 17 }, { ...step, status: 8 }, { ...step, metadata: { source: 2 } },
    { ...step, metadata: { source: 5, tool_call: {} } },
    { ...step, system_message: { ...system, event_type: "agent_message" } },
    { ...step, system_message: { ...system, event_type: "" } },
  ])("requires the completed native system step and an untyped provider message", bad => {
    expect(antigravityFailedSubagentSessionId(bad, parentId)).toBeUndefined();
  });
  it.each([
    { ...incoming, sender: childId }, { ...incoming, recipient: otherId }, { ...incoming, id: "unknown" },
    { ...incoming, render_details: {} }, { ...incoming, render_details: { message_title: "Error from " } },
    { ...incoming, render_details: { message_title: "Error from Other" } },
    { ...incoming, content: body("Reviewer", "invalid") }, { ...incoming, content: body("Reviewer", parentId) },
    { ...incoming, content: `Arbitrary text: ${incoming.content}` },
    { ...incoming, content: incoming.content.replace("encountered an error", "sent an update") },
    { ...incoming, content: body("Reviewer", childId, "") },
  ])("requires a bound system sender, valid IDs and matching provider title and body", agent => {
    expect(antigravityFailedSubagentSessionId({ ...step, system_message: { agent_message: agent } }, parentId)).toBeUndefined();
  });
});
