import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@opencode/client";
import { projectOpenCodeCurrentUsage } from "../../src/server/backends/opencode/opencode-current-usage.js";
import type { OpenCodeModelCatalogRead } from "../../src/server/backends/opencode/opencode-model-catalog.js";
import { parseOpenCodeNativeMessage, type OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
import { usageSnapshotSchema } from "../../src/shared/protocol/conversation.js";

const model = { providerID: "provider", id: "model" };
const nativeModel: ModelInfo = { ...model, modelID: "model", name: "Model", enabled: true, status: "active", package: "fixture",
  capabilities: { input: ["text"], output: ["text"], tools: true }, variants: [], time: { released: 0 }, cost: [], limit: { context: 1_000, output: 100 } };
const catalog: OpenCodeModelCatalogRead = { revision: "fixture", modelsById: new Map([["model", nativeModel]]),
  catalog: { models: [{ provider: "fixture", id: "model", label: "Model", inputModalities: ["text"], isDefault: true }], commands: [], skills: [], notices: [] } };
const tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 200, write: 50 } };
const assistant = (id = "msg_assistant", changes: Record<string, unknown> = {}): OpenCodeNativeMessage => parseOpenCodeNativeMessage(JSON.parse(JSON.stringify({
  type: "assistant", id, agent: "build", model, tokens, content: [{ type: "text", text: "Done" }], time: { created: 1, completed: 2 }, ...changes,
})));
const user = (id = "msg_user") => parseOpenCodeNativeMessage({ type: "user", id, text: "Question", time: { created: 1 } });
const compact = (status = "completed") => parseOpenCodeNativeMessage({ type: "compaction", id: "msg_compact", status, reason: "auto",
  time: { created: 3 }, ...(status === "failed" ? { error: { type: "unknown", message: "Failed" } } : { summary: "Summary", recent: "" }),
  ...(status === "running" ? {} : { tokens: { ...tokens, input: 900 } }) });
const project = (messages: OpenCodeNativeMessage[]) => usageSnapshotSchema.parse(projectOpenCodeCurrentUsage({ messages, session: { model }, catalog }));

describe("OpenCode current context and retained transcript counters", () => {
  it("uses one request's five disjoint categories, never cumulative request totals", () => {
    expect(project([user(), assistant("msg_old", { tokens: { ...tokens, input: 500 } }), assistant()])).toEqual({
      context: { usedTokens: 400, windowTokens: 1_000, percent: 40 },
      counters: { userMessages: 1, assistantMessages: 2, totalMessages: 3, toolCalls: 0, toolResults: 0, compactions: 0 },
    });
  });
  it("keeps the latest measured request while the next assistant has no tokens yet", () => {
    expect(project([assistant(), assistant("msg_next", { tokens: undefined, time: { created: 3 } })]).context?.usedTokens).toBe(400);
  });
  it("clears the anchor after completed compaction and restores it after another request", () => {
    expect(project([assistant(), compact()])).toMatchObject({ context: { windowTokens: 1_000 }, counters: { compactions: 1 } });
    expect(project([assistant(), compact()]).context?.usedTokens).toBeUndefined();
    expect(project([assistant(), compact(), assistant("msg_next", { tokens: { ...tokens, input: 10 } })]).context?.usedTokens).toBe(310);
    expect(project([assistant(), compact("running")]).context?.usedTokens).toBe(400);
    expect(project([assistant(), compact("failed")]).context?.usedTokens).toBe(400);
  });
  it("restricts context and counters to the active branch before a staged revert", () => {
    const messages = [user(), assistant(), user("msg_reverted"), compact(), assistant("msg_later")];
    const revert = { messageID: "msg_reverted", snapshot: "snapshot" };
    const usage = projectOpenCodeCurrentUsage({ messages, session: { model, revert }, catalog });
    expect(usage).toMatchObject({ context: { usedTokens: 400 }, counters: { userMessages: 1, assistantMessages: 1, totalMessages: 2, compactions: 0 } });
    expect(projectOpenCodeCurrentUsage({ messages, session: { model, revert: { ...revert, messageID: "msg_missing" } }, catalog })).toEqual({});
  });
  it("invalidates a model switch without pairing old occupancy with the new window", () => {
    const other = { ...nativeModel, id: "other", limit: { context: 2_000, output: 100 } };
    const models = { ...catalog, modelsById: new Map([...catalog.modelsById, ["other", other]]) };
    expect(projectOpenCodeCurrentUsage({ messages: [assistant()], session: { model: other }, catalog: models }).context).toEqual({ windowTokens: 2_000 });
    const switched = parseOpenCodeNativeMessage({ type: "model-switched", id: "msg_switch", time: { created: 4 }, model });
    expect(project([assistant(), switched]).context).toEqual({ windowTokens: 1_000 });
  });
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("omits missing/invalid context windows (%s) without losing counters", context => {
    const models = { ...catalog, modelsById: new Map([["model", { ...nativeModel, limit: { context: context as number, output: 100 } }]]) };
    expect(projectOpenCodeCurrentUsage({ messages: [user(), assistant()], session: { model }, catalog: models })).toEqual({
      counters: { userMessages: 1, assistantMessages: 1, totalMessages: 2, toolCalls: 0, toolResults: 0, compactions: 0 },
    });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])("does not publish invalid/overflowed native usage (%s)", input => {
    expect(project([assistant("msg_bad", { tokens: { ...tokens, input } })]).context).toEqual({ windowTokens: 1_000 });
  });
  it("keeps empty or all-zero usage unknown and permits reported over-limit occupancy", () => {
    expect(project([]).context).toEqual({ windowTokens: 1_000 });
    expect(project([assistant("msg_zero", { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })]).context).toEqual({ windowTokens: 1_000 });
    expect(project([assistant("msg_big", { tokens: { ...tokens, input: 1_000 } })]).context).toEqual({ usedTokens: 1_300, windowTokens: 1_000, percent: 130 });
  });
  it("counts native messages and settled tools, not fragments, image presentation or metadata", () => {
    const content = [{ type: "text", text: "One" }, { type: "text", text: "Two" }, { type: "reasoning", text: "Thinking" },
      { type: "tool", id: "call_pending", name: "read", time: { created: 1 }, state: { status: "streaming", input: "{" } },
      { type: "tool", id: "call_running", name: "read", time: { created: 1 }, state: { status: "running", input: {}, metadata: {} } },
      { type: "tool", id: "call_done", name: "read", time: { created: 1 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "image" }] } },
      { type: "tool", id: "call_error", name: "read", time: { created: 1 }, state: { status: "error", input: {}, error: { type: "unknown", message: "denied" } } }];
    const idle = parseOpenCodeNativeMessage({ type: "idle", id: "msg_idle", outcome: "succeeded", time: { created: 4 } });
    expect(project([user(), assistant("msg_tools", { content }), idle]).counters).toEqual({
      userMessages: 1, assistantMessages: 1, totalMessages: 2, toolCalls: 3, toolResults: 2, compactions: 0,
    });
  });
  it("uses reported model identity without interpreting unsupported names", () => {
    expect(projectOpenCodeCurrentUsage({ messages: [assistant("msg_custom", { model: { providerID: "custom", id: "x".repeat(1_000) } })], session: {}, catalog }).context).toBeUndefined();
  });
});
