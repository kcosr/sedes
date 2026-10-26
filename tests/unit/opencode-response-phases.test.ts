import { describe, expect, it } from "vitest";
import { OpenCodeHistoryProjection, openCodeHistoryItemId } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { openCodeHistoryFingerprint } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { parseOpenCodeNativeMessage, type OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
import { projectClassifiedAssistantResult } from "../../src/server/conversations/completion-result-projection.js";
import { selectAssistantResult } from "../../src/server/domain/assistant-result-selection.js";

const identity = { bindingScope: ["tenant", "principal", "thread"], generation: "owner", activity: "idle" as const };
const user = (id = "msg_user") => parseOpenCodeNativeMessage({ id, type: "user", text: "Question", time: { created: 100 } });
const idle = (outcome = "succeeded") => parseOpenCodeNativeMessage({ id: "msg_idle", type: "idle", outcome, time: { created: 400 } });
const text = (value: string) => ({ type: "text" as const, text: value });
const assistant = (id: string, extra: Record<string, unknown> = {}) => parseOpenCodeNativeMessage(JSON.parse(JSON.stringify({
  id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, finish: "stop",
  content: [text("Final reply")], time: { created: 200, completed: 300 }, ...extra,
})));
const tool = (extra: Record<string, unknown> = {}) => ({
  type: "tool", id: "tool_read", name: "read", time: { created: 200, completed: 250 },
  state: { status: "completed", input: {}, content: [text("Tool result")] }, ...extra,
});
function project(messages: readonly OpenCodeNativeMessage[], previous?: OpenCodeHistoryProjection) {
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  return new OpenCodeHistoryProjection({ sessionId: "ses_phases", messages, headId: messages.at(-1)?.id,
    frontier: openCodeHistoryFingerprint(messages), decodedBytes: bytes, retainedDecodedBytes: bytes, records: messages.length },
  { ...identity, ...(previous ? { previous } : {}) });
}
function result(projection: OpenCodeHistoryProjection) {
  return projectClassifiedAssistantResult(Object.values(projection.itemsById).filter(item => item.semanticKind === "assistant_message"));
}

describe("OpenCode completion response phases", () => {
  it("selects all final message text without tool commentary or reasoning for Final-only speech", () => {
    const projection = project([user(), assistant("msg_tools", { finish: "tool-calls", content: [text("Inspecting files"), tool()] }),
      assistant("msg_answer", { content: [text("Answer one"), { type: "reasoning", text: "Private reasoning" }, text("Answer two")] }), idle()]);
    expect(result(projection)).toEqual({ provisional: { text: "Inspecting files" }, partial: null,
      final: { text: "Answer one\n\nAnswer two" }, unclassified: null });
    expect(selectAssistantResult(result(projection), ["final"])).toEqual({ final: { text: "Answer one\n\nAnswer two" } });
    expect(projection.itemsById[openCodeHistoryItemId("msg_answer", 1)]).not.toHaveProperty("responsePhase");
  });

  it.each(["failed", "interrupted"])("does not promote a stopped response on a %s turn", outcome => {
    expect(result(project([user(), assistant("msg_answer"), idle(outcome)])).final).toBeNull();
  });

  it("waits for native turn settlement even after a stopped assistant step", () => {
    const messages = [user(), assistant("msg_answer")];
    const running = project(messages);
    expect(result(running)).toMatchObject({ final: null, unclassified: { text: "Final reply" } });
    expect(result(project([...messages, idle()], running))).toMatchObject({ final: { text: "Final reply" }, unclassified: null });
  });

  it("classifies a completed tool-call step while the turn continues without promoting a stopped answer", () => {
    const messages = [user(), assistant("msg_tools", { finish: "tool-calls", content: [text("Inspecting files"), tool()] }),
      assistant("msg_answer")];
    const retained = { sessionId: "ses_phases", messages, headId: messages.at(-1)!.id,
      frontier: openCodeHistoryFingerprint(messages), decodedBytes: Buffer.byteLength(JSON.stringify(messages)), records: messages.length };
    const running = new OpenCodeHistoryProjection({ ...retained, retainedDecodedBytes: retained.decodedBytes }, { ...identity, activity: "running" });
    expect(running.runState).toBe("running");
    expect(result(running)).toEqual({ provisional: { text: "Inspecting files" }, partial: null,
      final: null, unclassified: { text: "Final reply" } });
    expect(result(project([...messages, idle()], running))).toEqual({ provisional: { text: "Inspecting files" }, partial: null,
      final: { text: "Final reply" }, unclassified: null });
  });

  it.each([
    { finish: undefined }, { finish: "length" }, { finish: "unknown" }, { finish: "error" }, { finish: "content-filter" },
    { time: { created: 200, streamed: 250 } },
    { error: { type: "ProviderError", message: "Provider failed" } },
    { retry: { attempt: 1, at: 300, error: { type: "ProviderError", message: "Retrying" } } },
    { rawFinish: "pause_turn", content: [text("Research in progress"), tool({ executed: true })] },
    { content: [text("Working"), tool()] },
    { content: [text("Working"), tool({ executed: true, state: { status: "running", input: {}, metadata: {} } })] },
  ])("does not search backward past an ambiguous final native response: %j", extra => {
    const projection = project([user(), assistant("msg_earlier"), assistant("msg_ambiguous", extra), idle()]);
    expect(result(projection).final).toBeNull();
  });

  it("allows a stopped response containing completed provider-hosted tools", () => {
    const projection = project([user(), assistant("msg_answer", { content: [tool({ executed: true }), text("Hosted search answer")] }), idle()]);
    expect(result(projection).final).toEqual({ text: "Hosted search answer" });
  });

  it("keeps completed tool commentary provisional even when a tool failed and the turn was interrupted", () => {
    const projection = project([user(), assistant("msg_tools", { finish: "tool-calls", content: [text("Checking"),
      tool({ state: { status: "error", input: {}, error: { type: "ToolError", message: "Read failed" } } })] }), idle("interrupted")]);
    expect(result(projection)).toMatchObject({ provisional: { text: "Checking" }, final: null });
  });

  it.each([
    { type: "user", text: "Steer" }, { type: "synthetic", text: "Continue after output limit" },
    { type: "system", text: "New instructions" },
    { type: "location-switched", location: { directory: "/other" } },
  ])("does not promote an answer before a later input or control boundary: %j", boundary => {
    const projection = project([user(), assistant("msg_answer"),
      parseOpenCodeNativeMessage({ id: "msg_boundary", time: { created: 350 }, ...boundary }), idle()]);
    expect(result(projection).final).toBeNull();
  });

  it("ignores pure model and agent selection notices after the response", () => {
    const projection = project([user(), assistant("msg_answer"),
      parseOpenCodeNativeMessage({ id: "msg_model", type: "model-switched", model: { providerID: "fixture", id: "other" }, time: { created: 350 } }),
      parseOpenCodeNativeMessage({ id: "msg_agent", type: "agent-switched", agent: "plan", time: { created: 360 } }), idle()]);
    expect(result(projection).final).toEqual({ text: "Final reply" });
  });

  it("reclassifies cached messages when final selection changes within an already settled period", () => {
    const firstAnswer = assistant("msg_first");
    const opening = user(), terminal = idle();
    const before = project([opening, firstAnswer, terminal]);
    const messages = [opening, firstAnswer, assistant("msg_last", { content: [text("New final reply")] }), terminal];
    const cached = project(messages, before), fresh = project(messages);
    expect(cached.snapshot()).toEqual(fresh.snapshot());
    expect(result(cached)).toMatchObject({ final: { text: "New final reply" }, unclassified: { text: "Final reply" } });
    const shortened = [opening, firstAnswer, terminal];
    expect(project(shortened, cached).snapshot()).toEqual(project(shortened).snapshot());
    expect(result(before).final).toEqual({ text: "Final reply" });
  });

  it("retains an authoritative empty final message instead of promoting earlier text", () => {
    const projection = project([user(), assistant("msg_earlier"), assistant("msg_empty", { content: [text("")] }), idle()]);
    expect(result(projection)).toMatchObject({ final: { text: "" }, unclassified: { text: "Final reply" } });
  });
});
