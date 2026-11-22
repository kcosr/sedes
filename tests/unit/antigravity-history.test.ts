import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { backendConversationSnapshotSchema } from "../../src/shared/protocol/backend.js";
import type { AntigravityBinding } from "../../src/server/backends/antigravity/binding.js";
import { buildAntigravityPrompt, inspectAntigravityInput } from "../../src/server/backends/antigravity/submission.js";
import { antigravityHistoryPage, antigravitySteerConsumed, locateAntigravityTurn, projectAntigravityHistory } from "../../src/server/backends/antigravity/history.js";
import type { AntigravityNativeHistory } from "../../src/server/backends/antigravity/native-schema.js";
import type { SubmitTurnInput } from "../../src/server/backends/contracts.js";

const binding: AntigravityBinding = { version: 1, sessionId: "4c8ece79-6741-451f-8aa5-e01d576ed055", tenantId: "tenant", principalId: "principal",
  backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", canonicalWorkspacePath: "/workspace", nativeNamespaceKey: "namespace" };
const scope = { binding, key: Buffer.alloc(32, 9) };
const input: SubmitTurnInput = { applicationOperationId: "operation", mutationId: "mutation", source: { kind: "user" }, reconciliationToken: "private-token",
  text: "  original user text\n\n", contextExcerpts: [], taskContexts: [], attachments: [] };
const base = { type: 15, status: 3, hasSubtrajectory: false };
function native(text: string, stopReason = 2): AntigravityNativeHistory {
  return { revision: "a".repeat(64), executions: [], steps: [{ ...base, index: 0, type: 14, user: { text } },
    { ...base, index: 1, response: { text: "Answer", thinking: "Reasoning", stopReason, toolCalls: [] } }] };
}
describe("Antigravity native projection and exact delivery evidence", () => {
  it("authenticates input while preserving exact user whitespace and keeping the retry token private", async () => {
    const prompt = await buildAntigravityPrompt(scope, input);
    const text = prompt[0]!.type === "text" ? prompt[0]!.text : "";
    expect(text).not.toContain(input.reconciliationToken);
    expect(inspectAntigravityInput(scope, text)).toMatchObject({ operationId: "operation", content: [{ kind: "text", text: { text: input.text } }] });
    const projection = projectAntigravityHistory(native(text), scope);
    expect(backendConversationSnapshotSchema.safeParse(projection.snapshot).success).toBe(true);
    expect(projection.snapshot.turnsById["input:0"]).toMatchObject({ status: "completed", completionCorrelations: ["operation"] });
    expect(projection.snapshot.itemsById["step:0:user"]).toMatchObject({ deliveryOperationId: "operation", content: [{ kind: "text", text: { text: input.text } }] });
  });
  it.each(["tenantId", "principalId", "sessionId", "canonicalWorkspacePath", "nativeNamespaceKey", "backendInstanceId", "connectionProfileId", "executionEnvironmentId"] as const)("does not adopt copied evidence from another %s", async field => {
    const prompt = await buildAntigravityPrompt(scope, input);
    const text = prompt[0]!.type === "text" ? prompt[0]!.text : "";
    const actual = inspectAntigravityInput({ ...scope, binding: { ...binding, [field]: "different" } }, text);
    expect(actual.operationId).toBeUndefined();
    expect(actual.content).toEqual([{ kind: "text", text: { text } }]);
  });
  it("does not hide tampered text or correlate identical user requests", async () => {
    const first = await buildAntigravityPrompt(scope, input);
    const second = await buildAntigravityPrompt(scope, { ...input, applicationOperationId: "second" });
    if (first[0]!.type !== "text" || second[0]!.type !== "text") throw new Error();
    expect(inspectAntigravityInput(scope, `${first[0]!.text}changed`).operationId).toBeUndefined();
    expect(inspectAntigravityInput(scope, second[0]!.text).operationId).toBe("second");
    expect(inspectAntigravityInput(scope, input.text).operationId).toBeUndefined();
  });
  it("requires matching immutable attachment bytes before image delivery", async () => {
    const bytes = Buffer.from("fixture image");
    const attachment = { id: "993a001d-42ea-4a85-9dc9-7a63c1a295db", kind: "image" as const, fileName: "image.png", mediaType: "image/png" as const,
      byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), agentPath: "/workspace/image.png" };
    await expect(buildAntigravityPrompt(scope, { ...input, attachments: [attachment], attachmentBytes: { read: async () => Buffer.from("wrong") } })).rejects.toThrow("integrity");
  });
  it("requires native terminal evidence, retaining incomplete and tool-continuation turns", () => {
    expect(projectAntigravityHistory(native("user", 1), scope).snapshot.runState).toBe("reconciling");
    expect(projectAntigravityHistory(native("user", 10), scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    expect(projectAntigravityHistory(native("user", 16), scope).snapshot.turnsById["input:0"]?.status).toBe("interrupted");
    expect(projectAntigravityHistory(native("user", 13), scope).snapshot.turnsById["input:0"]?.status).toBe("failed");
  });
  it("keeps existing item order identities when earlier optional native content appears", () => {
    const history = native("user", 0);
    history.steps[1]!.status = 2;
    history.steps[1]!.response!.thinking = "";
    history.steps.push({ ...base, index: 2, type: 132, status: 2,
      command: { command: "git status", cwd: "/workspace", output: "", persistent: false } });
    const before = projectAntigravityHistory(history, scope).snapshot;
    history.steps[1]!.response!.thinking = "Reasoning arrived after the first text chunk.";
    const after = projectAntigravityHistory(history, scope).snapshot;
    for (const [id, item] of Object.entries(before.itemsById)) {
      expect(after.itemsById[id]?.sourceOrder).toBe(item.sourceOrder);
    }
    expect(after.itemsById["step:1:thinking"]!.sourceOrder).toBeLessThan(after.itemsById["step:1:assistant"]!.sourceOrder);
    expect(after.itemsById["step:1:assistant"]!.sourceOrder).toBeLessThan(after.itemsById["step:2:command"]!.sourceOrder);
  });
  it("rejects a native item order that cannot be represented as a safe integer", () => {
    const history = native("user");
    history.steps[1]!.index = Number.MAX_SAFE_INTEGER;
    expect(() => projectAntigravityHistory(history, scope)).toThrow("antigravity_item_order_invalid");
  });
  function cancelledCommandHistory(): AntigravityNativeHistory {
    const history = native("Read the repository");
    history.steps[0]!.executionId = "cancelled-execution";
    history.steps[1]!.executionId = "cancelled-execution";
    history.steps[1]!.response = { text: "", thinking: "", stopReason: 2,
      toolCalls: [{ id: "command", name: "run_command", argumentsJson: "{}" }] };
    history.steps.push({ ...base, index: 2, type: 132, status: 6, executionId: "cancelled-execution",
      completedAt: "2026-11-22T13:28:42.334Z", command: { command: "git status", cwd: "/workspace", output: "", persistent: false } });
    history.executions = [{ executionId: "cancelled-execution", lastStepIndex: 2, terminationReason: 2, proceededWithAutoContinue: false }];
    return history;
  }
  it("settles a cancelled command turn only from its exact durable executor cancellation receipt", () => {
    const { snapshot } = projectAntigravityHistory(cancelledCommandHistory(), scope);
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "interrupted", endedBy: "interrupted", completedAt: "2026-11-22T13:28:42.334Z" });
    expect(snapshot.itemsById["step:2:command"]).toMatchObject({ semanticKind: "command", status: "interrupted", phase: "interrupted" });
  });
  it.each(["missing", "wrong_execution", "wrong_head", "auto_continue", "early_continue", "later_step", "active_step", "conflicting_receipt"] as const)(
    "does not infer whole-turn cancellation from a cancelled tool with %s executor evidence", evidence => {
      const history = cancelledCommandHistory(), receipt = history.executions[0]!;
      if (evidence === "missing") history.executions = [];
      if (evidence === "wrong_execution") receipt.executionId = "another-execution";
      if (evidence === "wrong_head") receipt.lastStepIndex = 1;
      if (evidence === "auto_continue") receipt.proceededWithAutoContinue = true;
      if (evidence === "early_continue") receipt.terminationReason = 7;
      if (evidence === "later_step") history.steps.push({ ...base, index: 3, executionId: receipt.executionId });
      if (evidence === "active_step") history.steps[1]!.status = 2;
      if (evidence === "conflicting_receipt") history.executions.push({ ...receipt, terminationReason: 12 });
      expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    },
  );
  async function steerText(operation: string): Promise<string> {
    const prompt = await buildAntigravityPrompt(scope, { ...input, applicationOperationId: operation }, "", "steer");
    if (prompt[0]?.type !== "text") throw new Error();
    return prompt[0].text;
  }
  it("does not publish a persisted steer that Stop cancelled before consumption", async () => {
    const history = native("original", 16);
    history.steps.push({ ...base, type: 14, index: 2, executionId: "queued", user: { text: await steerText("queued") } });
    expect(antigravitySteerConsumed(history, 2)).toBe(false);
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0"]);
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.itemsById["step:2:user"]).toBeUndefined();
  });
  it.each([true, false])("correlates several consumed steers to their one shared response (native start stamps: %s)", async stamped => {
    const history = native("original");
    for (const index of [2, 3]) history.steps.push({ ...base, type: 14, index, executionId: "shared",
      ...(stamped ? { isInterruptingStep: true as const, startedAt: "2026-11-22T01:00:00Z", completedAt: "2026-11-22T01:00:01Z" } : {}), user: { text: await steerText(`steer-${index}`) } });
    history.steps.push({ ...base, index: 4, executionId: "shared", response: { text: "Both requests answered", thinking: "", stopReason: 2, toolCalls: [] } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0", "input:2"]);
    expect(snapshot.turnsById["input:2"]).toMatchObject({ status: "completed", completionCorrelations: ["steer-2", "steer-3"] });
    expect(snapshot.itemsById["step:3:user"]).toMatchObject({ backendTurnId: "input:2", deliveryOperationId: "steer-3" });
    expect(snapshot.runState).toBe("idle");
  });
  it("applies executor cancellation only at its terminal head after grouping consumed steers", async () => {
    const history = native("original");
    for (const index of [2, 3]) history.steps.push({ ...base, type: 14, index, executionId: "shared",
      user: { text: await steerText(`steer-${index}`) } });
    history.steps.push({ ...base, index: 4, executionId: "shared", response: { text: "", thinking: "", stopReason: 2,
      toolCalls: [{ id: "command", name: "run_command", argumentsJson: "{}" }] } },
      { ...base, index: 5, type: 132, status: 6, executionId: "shared", command: { command: "git status", cwd: "/workspace", output: "", persistent: false } });
    history.executions.push({ executionId: "shared", lastStepIndex: 5, terminationReason: 2, proceededWithAutoContinue: false });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0", "input:2"]);
    expect(snapshot.turnsById["input:2"]).toMatchObject({ status: "interrupted", completionCorrelations: ["steer-2", "steer-3"] });
    expect(snapshot.runState).toBe("idle");
  });
  it("recognizes exact native execution evidence when a steer starts after cancellation", async () => {
    const history = native("original", 16);
    history.steps.push({ ...base, type: 14, index: 2, executionId: "withdrawn", user: { text: await steerText("withdrawn") } },
      { ...base, type: 14, index: 3, executionId: "escaped", user: { text: await steerText("escaped") } },
      { ...base, index: 4, executionId: "escaped", response: { text: "started", thinking: "", stopReason: 16, toolCalls: [] } });
    expect(antigravitySteerConsumed(history, 2)).toBe(false);
    expect(antigravitySteerConsumed(history, 3)).toBe(true);
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.turnsById["input:3"]).toMatchObject({ status: "interrupted", completionCorrelations: ["escaped"] });
    expect(snapshot.itemsById["step:2:user"]).toBeUndefined();
  });
  it("does not let an autonomous background continuation consume a queued steer", async () => {
    const history = native("original");
    history.steps.push({ ...base, type: 14, index: 2, executionId: "queued", user: { text: await steerText("queued") } },
      { ...base, type: 101, index: 3, continuation: { id: "receipt", recipient: binding.sessionId, sender: `${binding.sessionId}/task-2`, kind: "task_notification", content: "Done" } },
      { ...base, index: 4, executionId: "background", response: { text: "Background result", thinking: "", stopReason: 2, toolCalls: [] } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0", "continuation:3"]);
    expect(snapshot.turnsById["continuation:3"]?.completionCorrelations).toBeUndefined();
  });
  it("normalizes bounded tools and commands with truthful operation phases", () => {
    const history = native("user");
    history.steps.splice(1, 0, { ...base, index: 2, status: 2, tool: { id: "t", name: "read_file", argumentsJson: '{"path":"/workspace/a"}' } });
    const projection = projectAntigravityHistory(history, scope);
    expect(projection.snapshot.itemsById["step:2:tool"]).toMatchObject({ semanticKind: "tool", phase: "preflight_or_executing", status: "streaming" });
  });
  it.each([{ nativeStatus: 3, status: "completed", isError: false }, { nativeStatus: 7, status: "failed", isError: true }])(
    "preserves a $status native MCP result in readable settled history", ({ nativeStatus, status, isError }) => {
      const history = native("Read this thread status");
      const result = JSON.stringify({ threadId: "fixture-thread", backend: "antigravity" });
      history.steps.splice(1, 0, { ...base, type: 132, index: 2, status: nativeStatus,
        tool: { id: "mcp-tool", name: "mcp_sedes_sedes_read", argumentsJson: '{"toolId":"thread.status"}', result } });
      const { snapshot, usage } = projectAntigravityHistory(history, scope);
      expect(backendConversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.itemsById["step:2:tool"]).toMatchObject({ semanticKind: "tool", phase: status, status,
        arguments: { kind: "object", entries: [{ key: { text: "toolId" }, value: { text: "thread.status" } }] },
        result: { content: [{ kind: "text", value: { text: result } }], isError } });
      expect(snapshot.runState).toBe("idle");
      expect(usage.counters).toMatchObject({ toolCalls: 1, toolResults: 1 });
      expect(antigravityHistoryPage(snapshot, { limit: 1 }).itemsById["step:2:tool"]).toEqual(snapshot.itemsById["step:2:tool"]);
    },
  );
  it("preserves native command output and exit status in settled history", () => {
    const history = native("Read this thread status");
    history.steps.splice(1, 0, { ...base, index: 2, command: { command: "sedes tool invoke thread.status", cwd: "/workspace",
      output: '{"backend":"antigravity"}', exitCode: 0, persistent: false } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(backendConversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.itemsById["step:2:command"]).toMatchObject({ semanticKind: "command", phase: "completed", status: "completed",
      command: { text: "sedes tool invoke thread.status" }, cwd: { text: "/workspace" }, output: { text: '{"backend":"antigravity"}' }, exitCode: 0 });
  });
  it("pages whole turns and targets old turns within a bounded search", () => {
    const history = native("old");
    history.steps.push({ ...base, index: 2, type: 14, user: { text: "new" } }, { ...base, index: 3, response: { text: "New response", thinking: "", stopReason: 2, toolCalls: [] } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    const first = antigravityHistoryPage(snapshot, { limit: 1 });
    expect(first.orderedBackendTurnIds).toEqual(["input:2"]);
    expect(antigravityHistoryPage(snapshot, { limit: 1, cursor: first.previousCursor }).orderedBackendTurnIds).toEqual(["input:0"]);
    expect(locateAntigravityTurn(snapshot, { maximumTurnCandidates: 1, matchesBackendTurnId: id => id === "input:0" }).status).toBe("search_limit_reached");
    expect(locateAntigravityTurn(snapshot, { maximumTurnCandidates: 2, matchesBackendTurnId: id => id === "input:0" })).toMatchObject({ status: "found", page: { orderedBackendTurnIds: ["input:0"] } });
  });
  it("reduces a page at whole-turn boundaries without shortening large messages", () => {
    const history = native("first");
    const text = "x".repeat(9 * 1024 * 1024);
    history.steps[1]!.response!.text = text;
    history.steps.push({ ...base, index: 2, type: 14, user: { text: "second" } },
      { ...base, index: 3, response: { text, thinking: "", stopReason: 2, toolCalls: [] } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    const page = antigravityHistoryPage(snapshot, { limit: 50 });
    expect(page.orderedBackendTurnIds).toEqual(["input:2"]);
    expect(page.itemsById["step:3:assistant"]).toMatchObject({ markdown: { text } });
    expect(antigravityHistoryPage(snapshot, { limit: 50, cursor: page.previousCursor }).orderedBackendTurnIds).toEqual(["input:0"]);
  });
});
