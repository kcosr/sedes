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
    expect(projectAntigravityHistory(native("user", 1), scope).snapshot).toMatchObject({ runState: "reconciling",
      activeBackendTurnId: "input:0", turnsById: { "input:0": { status: "in_progress" } } });
    expect(projectAntigravityHistory(native("user", 10), scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    expect(projectAntigravityHistory(native("user", 16), scope).snapshot.turnsById["input:0"]?.status).toBe("interrupted");
    expect(projectAntigravityHistory(native("user", 13), scope).snapshot.turnsById["input:0"]?.status).toBe("failed");
  });
  it.each(["tool", "command", "notice"] as const)("keeps a recoverable %s error visible without completing its turn", kind => {
    const history = native("Read the repository");
    history.steps[1]!.response = { text: "", thinking: "", stopReason: 2,
      toolCalls: [{ id: "read", name: "read_file", argumentsJson: "{}" }] };
    history.steps.push({ ...base, index: 2, type: kind === "notice" ? 17 : 132, status: 7,
      error: "file does not exist",
      ...(kind === "tool" ? { tool: { id: "read", name: "read_file", argumentsJson: "{}" } } : {}),
      ...(kind === "command" ? { command: { command: "cat missing", cwd: "/workspace", output: "", persistent: false } } : {}) });
    const failedTool = projectAntigravityHistory(history, scope).snapshot;
    expect(failedTool.turnsById["input:0"]?.status).toBe("in_progress");
    expect(failedTool.runState).toBe("reconciling");
    expect(failedTool.itemsById["step:2:error"]).toMatchObject({ semanticKind: "notice", status: "failed", text: { text: "file does not exist" } });
    if (kind !== "notice") expect(failedTool.itemsById[`step:2:${kind}`]?.status).toBe("failed");
    history.steps.push({ ...base, index: 3, status: 2, response: { text: "Still working", thinking: "", stopReason: 0, toolCalls: [] } });
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    history.steps[3]!.status = 3;
    history.steps[3]!.response!.stopReason = 2;
    history.steps[3]!.response!.text = "Review complete";
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("completed");
  });
  it("requires planner failure evidence even when a planner carries error text", () => {
    const history = native("Read the repository", 0);
    const response = history.steps[1]!;
    response.status = 2; response.error = "temporary model error";
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    response.status = 7;
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]).toMatchObject({ status: "failed", failure: { message: { text: "temporary model error" } } });
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
  const quota = "Individual quota reached. Resets in 8m18s.";
  const diagnostic = { ...base, index: 3, type: 17, standaloneSystemDiagnostic: true as const, error: quota };
  it("preserves turn and run states with standalone diagnostics at every position in the history fixtures", () => {
    const histories = [0, 2, 10, 13, 16].map(reason => native("user", reason));
    histories.push(cancelledCommandHistory());
    for (const history of histories) {
      // Reserve gaps so inserting a notice preserves native turn IDs and receipt indices.
      for (const step of history.steps) step.index = step.index * 2 + 1;
      for (const receipt of history.executions) receipt.lastStepIndex = receipt.lastStepIndex * 2 + 1;
      const states = (steps: AntigravityNativeHistory["steps"]) => {
        const { snapshot } = projectAntigravityHistory({ ...history, steps }, scope);
        return { runState: snapshot.runState, active: snapshot.activeBackendTurnId,
          turns: snapshot.orderedBackendTurnIds.map(id => [id, snapshot.turnsById[id]?.status]) };
      };
      const expected = states(history.steps);
      for (let slot = 0; slot <= history.steps.length; slot++) {
        const steps = history.steps.toSpliced(slot, 0, { ...diagnostic, index: slot * 2 });
        expect(states(steps)).toEqual(expected);
      }
    }
  });
  it("keeps the exact failure when its system notice arrives and after a successful follow-up", () => {
    const history = cancelledCommandHistory();
    history.executions[0]!.terminationReason = 1;
    const snapshot = () => projectAntigravityHistory(history, scope).snapshot;
    expect(snapshot().turnsById["input:0"]?.status).toBe("failed");
    history.steps.push(diagnostic);
    const failed = snapshot();
    expect(failed.turnsById["input:0"]).toMatchObject({ status: "failed", failure: { message: { text: quota } } });
    expect(failed.itemsById["step:3:error"]).toMatchObject({ semanticKind: "notice", text: { text: quota } });
    expect(failed.runState).toBe("idle");
    history.steps.push({ ...base, index: 4, type: 14, executionId: "next", user: { text: "Continue" } },
      { ...base, index: 5, executionId: "next", response: { text: "Done", thinking: "", stopReason: 2, toolCalls: [] } });
    const after = snapshot();
    expect(after.turnsById["input:0"]).toEqual(failed.turnsById["input:0"]);
    expect(after.turnsById["input:4"]?.status).toBe("completed");
    expect(after.runState).toBe("idle");
  });
  it.each([quota, "file does not exist"])("does not treat a system notice as execution proof: %s", error => {
    const history = cancelledCommandHistory();
    history.executions = [];
    history.steps.push({ ...diagnostic, error });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    expect(snapshot.runState).toBe("reconciling");
  });
  it.each(["tool", "command status", "new execution", "continuation", "consumed Steer", "queued Steer"] as const)(
    "preserves the turn and run state across a system notice followed by a %s", async kind => {
      const history = cancelledCommandHistory();
      history.executions[0]!.terminationReason = 1;
      const next = { ...base, index: 4, executionId: "new" };
      switch (kind) {
        case "tool":
          history.steps.push({ ...next, type: 132, tool: { id: "call", name: "read_file", argumentsJson: "{}" } }); break;
        case "command status":
          history.steps.push({ ...next, type: 37, commandStatus: { commandId: "command", status: 3, output: "done" } }); break;
        case "new execution":
          history.steps.push({ ...next, status: 2, response: { text: "", thinking: "", stopReason: 0, toolCalls: [] } }); break;
        case "continuation":
          history.steps.push({ ...next, type: 101, continuation: { id: "receipt", kind: "task_notification", recipient: binding.sessionId, sender: "task", content: "done" } }); break;
        case "consumed Steer":
        case "queued Steer":
          history.steps.push({ ...next, type: 14, user: { text: await steerText("steer") },
            ...(kind === "consumed Steer" ? { isInterruptingStep: true as const, startedAt: "2026-11-22T00:01:00Z", completedAt: "2026-11-22T00:01:01Z" } : {}) }); break;
      }
      const statuses = () => {
        const { snapshot } = projectAntigravityHistory(history, scope);
        return { runState: snapshot.runState, active: snapshot.activeBackendTurnId,
          turns: Object.entries(snapshot.turnsById).map(([id, turn]) => [id, turn.status]) };
      };
      const before = statuses();
      history.steps.splice(3, 0, diagnostic);
      expect(statuses()).toEqual(before);
      if (kind === "new execution") expect(before.runState).toBe("reconciling");
    });
  it.each(["exact", "missing", "wrong_execution", "wrong_head", "auto_continue", "conflict", "active"] as const)("requires exact fatal executor proof with %s evidence", evidence => {
    const history = cancelledCommandHistory();
    const head = history.steps[2]!;
    head.status = evidence === "active" ? 2 : 7;
    head.error = "native executor failed";
    history.executions[0]!.terminationReason = 1;
    if (evidence === "missing") history.executions = [];
    if (evidence === "wrong_execution") history.executions[0]!.executionId = "unrelated";
    if (evidence === "wrong_head") history.executions[0]!.lastStepIndex = 1;
    if (evidence === "auto_continue") history.executions[0]!.proceededWithAutoContinue = true;
    if (evidence === "conflict") history.executions.push({ ...history.executions[0]!, terminationReason: 2 });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.turnsById["input:0"]?.status).toBe(evidence === "exact" ? "failed" : "in_progress");
    expect(snapshot.turnsById["input:0"]?.failure).toBeUndefined();
    history.steps.push(diagnostic);
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe(snapshot.turnsById["input:0"]?.status);
  });
  it.each([
    [0, "in_progress"], [1, "failed"], [2, "interrupted"], [3, "failed"], [4, "in_progress"],
    [5, "in_progress"], [6, "failed"], [7, "in_progress"], [8, "in_progress"], [9, "in_progress"],
    [10, "in_progress"], [11, "failed"], [12, "in_progress"], [999, "in_progress"],
  ] as const)("gives executor reason %s an explicit disposition of %s without a final response", (reason, status) => {
    const history = cancelledCommandHistory();
    history.steps[2]!.status = 7;
    history.steps[2]!.error = "file does not exist";
    history.executions[0]!.terminationReason = reason;
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe(status);
    history.steps.push(diagnostic);
    const withDiagnostic = projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"];
    expect(withDiagnostic?.status).toBe(status);
    if (status === "failed") expect(withDiagnostic?.failure?.message.text).toBe(reason === 1 ? quota : "Antigravity execution stopped before completing.");
    // No supported termination reason may settle a turn that auto-continues.
    history.executions[0]!.proceededWithAutoContinue = true;
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
  });
  it.each(["standalone", "planner"] as const)("retains the %s executor diagnostic only after its exact fatal receipt", kind => {
    const history = cancelledCommandHistory();
    history.steps[2] = { ...base, index: 2, type: kind === "standalone" ? 17 : 15,
      executionId: "cancelled-execution", error: "Executor could not continue",
      ...(kind === "planner" ? { response: { text: "", thinking: "", stopReason: 10, toolCalls: [] } } : {}) };
    history.executions = [];
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    history.executions.push({ executionId: "cancelled-execution", lastStepIndex: 2, terminationReason: 1, proceededWithAutoContinue: false });
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]).toMatchObject({
      status: "failed", failure: { message: { text: "Executor could not continue" } },
    });
    history.steps.push(diagnostic);
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.failure?.message.text).toBe("Executor could not continue");
  });
  it("settles a cancelled command turn only from its exact durable executor cancellation receipt", () => {
    const { snapshot } = projectAntigravityHistory(cancelledCommandHistory(), scope);
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "interrupted", endedBy: "interrupted", completedAt: "2026-11-22T13:28:42.334Z" });
    expect(snapshot.itemsById["step:2:command"]).toMatchObject({ semanticKind: "command", status: "interrupted", phase: "interrupted" });
  });
  it.each(["initial_without_execution", "auto_continued_execution"] as const)("settles the final execution of a cancelled turn with %s", mode => {
    const history = cancelledCommandHistory();
    if (mode === "initial_without_execution") delete history.steps[0]!.executionId;
    else {
      history.steps[0]!.executionId = "initial-execution";
      history.steps[1]!.executionId = "initial-execution";
      history.executions.unshift({ executionId: "initial-execution", lastStepIndex: 1, terminationReason: 7, proceededWithAutoContinue: true });
    }
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("interrupted");
  });
  it.each([2, 3])("preserves cancellation proof when an unconsumed Steer follows the command and the receipt head is %s", async lastStepIndex => {
    const history = cancelledCommandHistory();
    history.steps.push({ ...base, index: 3, type: 14, executionId: "cancelled-execution", user: { text: await steerText("queued") } });
    history.executions[0]!.lastStepIndex = lastStepIndex;
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.turnsById["input:0"]?.status).toBe("interrupted");
    expect(snapshot.itemsById["step:3:user"]).toBeUndefined();
    expect(snapshot.turnsById["input:0"]?.completionCorrelations ?? []).not.toContain("queued");
  });
  it("settles a submitted input cancelled before its first planner step", () => {
    const history: AntigravityNativeHistory = { revision: "a".repeat(64), steps: [
      { ...base, index: 0, type: 14, executionId: "cancelled-execution", user: { text: "User input" } },
    ], executions: [{ executionId: "cancelled-execution", lastStepIndex: 0, terminationReason: 2, proceededWithAutoContinue: false }] };
    expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("interrupted");
  });
  it.each([0, 1])("settles the original input before its first planner despite an unconsumed Steer at receipt head %s", async lastStepIndex => {
    const history: AntigravityNativeHistory = { revision: "a".repeat(64), steps: [
      { ...base, index: 0, type: 14, executionId: "cancelled-execution", user: { text: "User input" } },
      { ...base, index: 1, type: 14, executionId: "cancelled-execution", user: { text: await steerText("queued") } },
    ], executions: [{ executionId: "cancelled-execution", lastStepIndex, terminationReason: 2, proceededWithAutoContinue: false }] };
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0"]);
    expect(snapshot.turnsById["input:0"]?.status).toBe("interrupted");
    expect(snapshot.itemsById["step:1:user"]).toBeUndefined();
  });
  it("does not ignore a started or active later input when proving an execution cancelled", async () => {
    for (const extra of [{ startedAt: "2026-11-22T13:28:42.335Z" }, { status: 1 }]) {
      const history = cancelledCommandHistory();
      history.steps.push({ ...base, index: 3, type: 14, executionId: "cancelled-execution", user: { text: await steerText("queued") }, ...extra });
      expect(projectAntigravityHistory(history, scope).snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    }
  });
  it.each(["interrupting", "started", "completed"] as const)("does not merge a different-execution Steer without its native %s proof", async missing => {
    const history = native("Original input");
    history.steps[0]!.executionId = "original";
    history.steps[1]!.executionId = "original";
    history.steps[1]!.response!.toolCalls = [{ id: "tool", name: "run_command", argumentsJson: "{}" }];
    history.steps.push({ ...base, index: 2, type: 14, executionId: "different", user: { text: await steerText("steer") },
      ...(missing === "interrupting" ? {} : { isInterruptingStep: true as const }),
      ...(missing === "started" ? {} : { startedAt: "2026-11-22T00:00:01.000Z" }),
      ...(missing === "completed" ? {} : { completedAt: "2026-11-22T00:00:01.001Z" }) },
    { ...base, index: 3, executionId: "different", response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } });
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0", "input:2"]);
    expect(snapshot.turnsById["input:0"]?.completionCorrelations ?? []).not.toContain("steer");
    expect(snapshot.turnsById["input:0"]?.status).toBe("in_progress");
    expect(snapshot.turnsById["input:2"]?.status).toBe("completed");
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
  it.each(["continuation", "tool"] as const)("keeps a consumed Steer in its own turn after a foreign-execution %s", async foreign => {
    const original = await buildAntigravityPrompt(scope, { ...input, applicationOperationId: "original" });
    if (original[0]?.type !== "text") throw new Error("missing_original_text");
    const history = native(original[0].text);
    history.steps[0]!.executionId = "original-execution";
    history.steps[1]!.executionId = "original-execution";
    history.steps[1]!.response!.toolCalls = [{ id: "original-tool", name: "run_command", argumentsJson: "{}" }];
    history.steps.push(
      { ...base, index: 2, type: 132, executionId: "original-execution", tool: { id: "original-tool", name: "run_command", argumentsJson: "{}" } },
      foreign === "continuation"
        ? { ...base, index: 3, type: 101, executionId: "foreign-execution", continuation: {
          id: "foreign-receipt", recipient: binding.sessionId, sender: "foreign-task", kind: "task_notification", content: "Background result" } }
        : { ...base, index: 3, type: 132, executionId: "foreign-execution", tool: { id: "foreign-tool", name: "run_command", argumentsJson: "{}" } },
      { ...base, index: 4, type: 14, executionId: "original-execution", user: { text: await steerText("steer") } },
      { ...base, index: 5, executionId: "original-execution", response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    expect(antigravitySteerConsumed(history, 4)).toBe(true);
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0"]);
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "completed", completionCorrelations: ["original", "steer"] });
    expect(snapshot.itemsById["step:4:user"]).toMatchObject({ backendTurnId: "input:0", deliveryOperationId: "steer" });
    expect(snapshot.runState).toBe("idle");
  });
  it.each(["metadata", "unconsumed_steer"] as const)("keeps the last executed identity across %s before a consumed Steer", async gap => {
    const history = native("Original input");
    history.steps[0]!.executionId = "original-execution";
    history.steps[1]!.executionId = "original-execution";
    history.steps[1]!.response!.toolCalls = [{ id: "tool", name: "run_command", argumentsJson: "{}" }];
    history.steps.push(
      { ...base, index: 2, type: 132, executionId: "continued-execution", tool: { id: "tool", name: "run_command", argumentsJson: "{}" } },
      gap === "metadata" ? { ...base, index: 3, type: 0 }
        : { ...base, index: 3, type: 14, executionId: "unconsumed-execution", user: { text: await steerText("unconsumed") } },
      { ...base, index: 4, type: 14, executionId: "continued-execution", user: { text: await steerText("steer") } },
      { ...base, index: 5, executionId: "continued-execution", response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0"]);
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "completed", completionCorrelations: ["steer"] });
    expect(snapshot.itemsById["step:3:user"]).toBeUndefined();
    expect(snapshot.itemsById["step:4:user"]).toMatchObject({ backendTurnId: "input:0", deliveryOperationId: "steer" });
    expect(snapshot.runState).toBe("idle");
  });
  it("merges an exactly consumed interrupting Steer even when its execution ID is omitted", async () => {
    const history = native("Original input");
    history.steps[0]!.executionId = "original-execution";
    history.steps[1]!.executionId = "original-execution";
    history.steps[1]!.response!.toolCalls = [{ id: "tool", name: "run_command", argumentsJson: "{}" }];
    history.steps.push(
      { ...base, index: 2, type: 14, user: { text: await steerText("steer") }, isInterruptingStep: true,
        startedAt: "2026-11-22T00:00:01.000Z", completedAt: "2026-11-22T00:00:01.001Z" },
      { ...base, index: 3, response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    expect(antigravitySteerConsumed(history, 2)).toBe(true);
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0"]);
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "completed", completionCorrelations: ["steer"] });
    expect(snapshot.itemsById["step:2:user"]).toMatchObject({ backendTurnId: "input:0", deliveryOperationId: "steer" });
    expect(snapshot.runState).toBe("idle");
  });
  it.each(["interrupting", "started", "completed"] as const)("does not publish an ID-less Steer without native %s proof", async missing => {
    const history = native("Original input");
    history.steps[1]!.response!.toolCalls = [{ id: "tool", name: "run_command", argumentsJson: "{}" }];
    history.steps.push(
      { ...base, index: 2, type: 14, user: { text: await steerText("steer") },
        ...(missing === "interrupting" ? {} : { isInterruptingStep: true as const }),
        ...(missing === "started" ? {} : { startedAt: "2026-11-22T00:00:01.000Z" }),
        ...(missing === "completed" ? {} : { completedAt: "2026-11-22T00:00:01.001Z" }) },
      { ...base, index: 3, response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    expect(antigravitySteerConsumed(history, 2)).toBe(false);
    const { snapshot } = projectAntigravityHistory(history, scope);
    expect(snapshot.itemsById["step:2:user"]).toBeUndefined();
    expect(snapshot.turnsById["input:0"]?.completionCorrelations ?? []).not.toContain("steer");
  });
  it.each(["user", "continuation"] as const)("does not carry execution identity from a completed turn into a new %s turn", async kind => {
    const history = native("Completed original input");
    history.steps[0]!.executionId = "old-execution";
    history.steps[1]!.executionId = "old-execution";
    history.steps.push(
      kind === "user" ? { ...base, index: 2, type: 14, user: { text: "Independent input" } }
        : { ...base, index: 2, type: 101, continuation: { id: "receipt", recipient: binding.sessionId,
          sender: "task", kind: "task_notification", content: "Background result" } },
      { ...base, index: 3, response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "tool", name: "run_command", argumentsJson: "{}" }] } },
      { ...base, index: 4, type: 14, executionId: "old-execution", user: { text: await steerText("steer") } },
      { ...base, index: 5, executionId: "old-execution", response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    const { snapshot } = projectAntigravityHistory(history, scope);
    const current = `${kind === "user" ? "input" : "continuation"}:2`;
    expect(snapshot.orderedBackendTurnIds).toEqual(["input:0", current, "input:4"]);
    expect(snapshot.turnsById[current]?.status).toBe("in_progress");
    expect(snapshot.turnsById[current]?.completionCorrelations ?? []).not.toContain("steer");
    expect(snapshot.turnsById["input:4"]).toMatchObject({ status: "completed", completionCorrelations: ["steer"] });
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
