import { describe, expect, it } from "vitest";
import { PiNativeEventCheckpoint } from "../../src/server/backends/pi/native/driver/event-checkpoint.js";
import type { PiNativeEvent } from "../../src/server/backends/pi/native/port.js";
import type { PiManagedState } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";

function fixture() {
  const checkpoint = new PiNativeEventCheckpoint(0);
  let sequence = 0;
  const state: { entries: Record<string, unknown>[]; toolCalls: PiManagedState["toolCalls"]; toolResults: PiManagedState["toolResults"] } = { entries: [], toolCalls: [], toolResults: [] };
  const observe = (kind: PiNativeEvent["kind"], payload: Record<string, unknown>) => {
    checkpoint.observe({ sequence: ++sequence, kind, payload }); return sequence;
  };
  const snapshot = () => { const sequence = observe("companion", { type: "state_changed" }); checkpoint.applied(sequence, state); return sequence; };
  return { checkpoint, state, observe, snapshot, sequence: () => sequence };
}

describe("native Pi durable event checkpoints", () => {
  it("bounds more than 16,384 events across tool steps, rejected nested calls, and extension notices", () => {
    const f = fixture();
    for (let step = 0; step < 700; step++) {
      const notice = f.observe("rpc", { type: "extension_error", error: `Extension warning ${step}` });
      expect(f.checkpoint.through(() => false, false)).toBe(f.checkpoint.acknowledged);
      f.checkpoint.noticeApplied(notice);
      expect(f.checkpoint.through(() => false, false)).toBe(notice);
      f.checkpoint.acknowledge(notice);
      const before = f.checkpoint.acknowledged;
      const message = { role: "assistant", content: [{ type: "text", text: `Step ${step}` }], timestamp: step };
      f.observe("rpc", { type: "message_start", message: { role: "assistant" } });
      for (let chunk = 0; chunk < 12; chunk++) f.observe("stream", { type: "message_snapshot", streamId: String(step), contentIndex: 0, semanticKind: "assistant_message", text: `Step ${step} chunk ${chunk}` });
      const end = f.observe("rpc", { type: "message_end", message });
      f.checkpoint.applied(end, f.state);
      expect(f.checkpoint.through(() => false, false)).toBe(before);
      f.state.entries.push({ id: `assistant:${step}`, type: "message", message });
      const assistantCheckpoint = f.snapshot();
      expect(f.checkpoint.through(() => false, false)).toBe(assistantCheckpoint);
      f.checkpoint.acknowledge(assistantCheckpoint);
      const toolCallId = `tool:${step}`;
      f.observe("rpc", { type: "tool_execution_start", toolCallId });
      for (let chunk = 0; chunk < 12; chunk++) f.observe("rpc", { type: "tool_execution_update", toolCallId, partialResult: { content: [{ type: "text", text: String(chunk) }] } });
      for (const rejection of ["unknown_tool", "inactive_tool", "invalid_arguments"]) {
        const child = `${toolCallId}/${rejection}`;
        f.observe("rpc", { type: "tool_execution_start", toolCallId: child, parentToolCallId: toolCallId });
        const end = f.observe("rpc", { type: "tool_execution_end", toolCallId: child, parentToolCallId: toolCallId,
          result: { content: [{ type: "text", text: rejection }] }, isError: true });
        f.checkpoint.applied(end, f.state);
        expect(f.checkpoint.through(() => false, false)).toBe(assistantCheckpoint);
      }
      const content = [{ type: "text", text: `Result ${step}` }];
      const toolEnd = f.observe("rpc", { type: "tool_execution_end", toolCallId, result: { content }, isError: false });
      f.checkpoint.applied(toolEnd, f.state);
      expect(f.checkpoint.through(() => false, false)).toBe(assistantCheckpoint);
      f.state.entries.push({ id: `result:${step}`, type: "message", message: { role: "toolResult", toolCallId, content, isError: false } });
      const toolCheckpoint = f.snapshot();
      expect(f.checkpoint.through(() => false, false)).toBe(toolCheckpoint);
      expect(f.sequence() - f.checkpoint.acknowledged).toBeLessThan(32);
      f.checkpoint.acknowledge(toolCheckpoint);
    }
    expect(f.sequence()).toBeGreaterThan(16_384);
    expect(f.checkpoint.acknowledged).toBe(f.sequence());
    f.observe("rpc", { type: "message_start", message: { role: "assistant" } });
    const stream = f.observe("stream", { type: "message_snapshot", streamId: "trailing", contentIndex: 0, semanticKind: "assistant_message", text: "Not persisted" });
    f.snapshot();
    expect(f.checkpoint.through(() => false, false)).toBe(stream - 2);
  });

  it("never treats an unrelated appended entry as proof that streamed text was persisted", () => {
    const f = fixture();
    f.observe("stream", { type: "message_snapshot", streamId: "current", contentIndex: 0, semanticKind: "assistant_message", text: "Pending text" });
    const message = { role: "assistant", content: [{ type: "text", text: "Pending text" }] };
    f.observe("rpc", { type: "message_end", message });
    const entry = { id: "other", type: "custom", customType: "marker", data: {} };
    f.state.entries.push(entry);
    const appended = f.observe("rpc", { type: "entry_appended", entry }); f.checkpoint.applied(appended, f.state);
    expect(f.checkpoint.through(() => false, false)).toBe(0);
    f.state.entries.push({ id: "message", type: "message", message });
    const persisted = f.snapshot();
    expect(f.checkpoint.through(() => false, false)).toBe(persisted);
  });

  it("keeps unresolved UI and agent-tool requests before later durable entries", () => {
    const f = fixture();
    f.observe("rpc", { type: "extension_ui_request", id: "ui", method: "input" });
    f.observe("companion", { type: "agent_tool_call", id: "agent" });
    const through = f.snapshot();
    expect(f.checkpoint.through(id => id === "ui", true)).toBe(0);
    expect(f.checkpoint.through(() => false, true)).toBe(1);
    expect(f.checkpoint.through(() => false, undefined)).toBe(1);
    expect(f.checkpoint.through(() => false, false)).toBe(through);
  });

  it("does not create another retention barrier when a failed snapshot causes event replay", () => {
    const f = fixture();
    const event: PiNativeEvent = { sequence: 1, kind: "rpc", payload: { type: "message_start", message: { role: "assistant" } } };
    f.checkpoint.observe(event); f.checkpoint.observe(event);
    const message = { role: "assistant", content: [{ type: "text", text: "Completed" }] };
    f.checkpoint.observe({ sequence: 2, kind: "rpc", payload: { type: "message_end", message } });
    f.state.entries.push({ id: "completed", type: "message", message });
    f.checkpoint.applied(2, f.state);
    expect(f.checkpoint.through(() => false, false)).toBe(2);
  });

  it("keeps an unfinished or attested nested call until its own completion is known", () => {
    const f = fixture();
    const content = [{ type: "text" as const, text: "child result" }];
    f.observe("rpc", { type: "tool_execution_start", toolCallId: "parent/1", parentToolCallId: "parent" });
    f.state.entries.push({ id: "parent-result", type: "message", message: { role: "toolResult", toolCallId: "parent", content, isError: false } });
    f.snapshot();
    expect(f.checkpoint.through(() => false, false)).toBe(0);
    f.state.toolCalls = [{ toolCallId: "parent/1", parentToolCallId: "parent", toolName: "read", assistantEntryId: "assistant", userEntryId: "user",
      sourceInfo: { source: "builtin", path: "builtin:read" }, arguments: { path: "file" } }];
    f.observe("rpc", { type: "tool_execution_end", toolCallId: "parent/1", parentToolCallId: "parent", result: { content }, isError: false });
    f.snapshot();
    expect(f.checkpoint.through(() => false, false)).toBe(0);
    f.state.toolResults = [{ toolCallId: "parent/1", assistantEntryId: "assistant", userEntryId: "user", content, isError: false }];
    const through = f.snapshot();
    expect(f.checkpoint.through(() => false, false)).toBe(through);
  });
});
