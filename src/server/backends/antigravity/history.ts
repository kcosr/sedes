import { backendHistoryPageSchema, backendItemSchema, backendTurnSchema, type BackendConversationSnapshot, type BackendItem, type BackendTurn } from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import { boundDisplayText, boundText, boundValue, preserveMessageText } from "../../conversations/payload-policy.js";
import type { BackendHistoryPage, HistoryPageInput, LocateTurnInput, LocateTurnResult } from "../contracts.js";
import type { AntigravityNativeHistory, AntigravityNativeStep } from "./native-schema.js";
import { inspectAntigravityInput, type AntigravitySubmissionScope } from "./submission.js";
import { antigravityNativeActivity } from "./host/native-activity.js";
import { MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES, serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import { antigravityCancelledExecutionHeads, antigravityNativeTerminalOutcome } from "./native-execution.js";

export const antigravityTurnId = (index: number): string => `input:${index}`;
export function antigravitySteerConsumed(native: AntigravityNativeHistory, index: number): boolean {
  const position = native.steps.findIndex(step => step.index === index);
  const step = native.steps[position];
  if (!step?.user) return false;
  if (step.isInterruptingStep && step.startedAt && step.completedAt) return true;
  if (!step.executionId) return false;
  for (const following of native.steps.slice(position + 1)) {
    if (following.response && following.executionId === step.executionId) return true;
  }
  return false;
}
export function antigravityStepStatus(status: number): BackendItem["status"] {
  if (status === 3 || status === 4 || status === 5) return "completed";
  if (status === 6 || status === 12) return "interrupted";
  if (status === 7) return "failed";
  return "streaming";
}
export interface AntigravityProjection { snapshot: BackendConversationSnapshot; usage: UsageSnapshot; stepTurns: ReadonlyMap<number, string> }
// A native step can acquire optional reasoning/text after later items have
// appeared. Reserve immutable slots so that growth never renumbers an item.
const itemSlots = { continuation: 0, user: 1, thinking: 2, assistant: 3, command: 4, tool: 4, error: 5 } as const;
export function projectAntigravityHistory(native: AntigravityNativeHistory, scope: AntigravitySubmissionScope): AntigravityProjection {
  const snapshot: BackendConversationSnapshot = { orderedBackendTurnIds: [], turnsById: {}, itemsById: {}, runState: "idle" };
  const stepTurns = new Map<number, string>();
  let turn: BackendTurn | undefined;
  let lastResponse: AntigravityNativeStep | undefined;
  let lastStep: AntigravityNativeStep | undefined;
  let executionId: string | undefined;
  const cancelled = antigravityCancelledExecutionHeads(native);
  const settle = () => {
    if (!turn) return;
    const last = lastResponse;
    const outcome = antigravityNativeTerminalOutcome(last);
    if (outcome === "failed") {
      turn.status = "failed"; turn.endedBy = "failed";
      if (last?.error) turn.failure = { message: boundDisplayText(last.error) };
    } else if (outcome === "interrupted") {
      turn.status = "interrupted"; turn.endedBy = "interrupted";
    } else if (outcome === "completed") {
      turn.status = "completed"; turn.endedBy = "agent_settled";
    }
    if (turn.status !== "in_progress" && last?.completedAt) turn.completedAt = last.completedAt;
    else if (turn.status === "in_progress" && executionId && lastStep?.executionId === executionId &&
        cancelled.get(executionId) === lastStep.index) {
      turn.status = "interrupted"; turn.endedBy = "interrupted";
      if (lastStep.completedAt) turn.completedAt = lastStep.completedAt;
    }
  };
  const add = (step: AntigravityNativeStep, suffix: keyof typeof itemSlots, part: Omit<BackendItem, "backendItemId" | "backendTurnId" | "status" | "sourceOrder">, status = antigravityStepStatus(step.status)) => {
    if (!turn) return;
    const sourceOrder = step.index * 8 + itemSlots[suffix];
    if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0) throw new Error("antigravity_item_order_invalid");
    const item = { ...part, backendItemId: `step:${step.index}:${suffix}`, backendTurnId: turn.backendTurnId, status,
      sourceOrder, ...(step.createdAt ? { startedAt: step.createdAt } : {}), ...(step.completedAt ? { completedAt: step.completedAt } : {}) } as BackendItem;
    snapshot.itemsById[item.backendItemId] = item; turn.orderedBackendItemIds.push(item.backendItemId);
  };
  for (const step of native.steps) {
    if (step.continuation) {
      if (step.continuation.recipient !== scope.binding.sessionId) throw new Error("antigravity_continuation_scope_mismatch");
      settle();
      if (!turn || turn.status !== "in_progress") {
        turn = { backendTurnId: `continuation:${step.index}`, status: "in_progress", orderedBackendItemIds: [],
          ...(step.createdAt ? { startedAt: step.createdAt } : {}) };
        snapshot.orderedBackendTurnIds.push(turn.backendTurnId); snapshot.turnsById[turn.backendTurnId] = turn;
        lastResponse = undefined;
        executionId = step.executionId;
      }
      add(step, "continuation", { semanticKind: "collaboration", action: "message", agentLabel: boundDisplayText(
        step.continuation.kind === "agent_message" ? "Subagent" : "Background task"), summary: boundText(step.continuation.content) } as BackendItem, "completed");
    }
    if (step.user) {
      const input = inspectAntigravityInput(scope, step.user.text);
      // ACP can persist an enqueued steer, then cancel it without consuming it.
      // Publication requires native start/execution evidence, not row existence.
      if (input.delivery === "steer" && !antigravitySteerConsumed(native, step.index)) continue;
      settle();
      // Several consumed steers can share one native response. Preserve every
      // operation correlation on that response's turn rather than leaving an
      // earlier steer forever in progress without its own planner step.
      if (input.delivery === "steer" && turn?.status === "in_progress" && step.executionId && step.executionId === executionId) {
        if (input.operationId) turn.completionCorrelations = [...(turn.completionCorrelations ?? []), input.operationId];
      } else {
        turn = { backendTurnId: antigravityTurnId(step.index), status: "in_progress", orderedBackendItemIds: [],
          ...(step.createdAt ? { startedAt: step.createdAt } : {}), ...(input.operationId ? { completionCorrelations: [input.operationId] } : {}) };
        snapshot.orderedBackendTurnIds.push(turn.backendTurnId); snapshot.turnsById[turn.backendTurnId] = turn;
      }
      executionId = step.executionId;
      add(step, "user", { semanticKind: "user_message", content: input.content, ...(input.operationId ? { deliveryOperationId: input.operationId } : {}) } as BackendItem, "completed");
      lastResponse = undefined;
    }
    if (!turn) continue;
    stepTurns.set(step.index, turn.backendTurnId);
    if (step.response) {
      lastResponse = step;
      if (step.response.thinking) add(step, "thinking", { semanticKind: "reasoning", markdown: boundText(step.response.thinking) } as BackendItem);
      if (step.response.text) add(step, "assistant", { semanticKind: "assistant_message", markdown: preserveMessageText(step.response.text),
        responsePhase: step.response.toolCalls.length ? "partial" : step.response.stopReason === 2 ? "final" : "unclassified" } as BackendItem);
    }
    const status = antigravityStepStatus(step.status);
    const phase = status === "streaming" ? "preflight_or_executing" : status;
    if (step.command) add(step, "command", { semanticKind: "command", phase, command: boundDisplayText(step.command.command),
      cwd: boundDisplayText(step.command.cwd), output: boundText(step.command.output), ...(status === "completed" ? { exitCode: step.command.exitCode ?? 0 } : {}) } as BackendItem);
    else if (step.tool) {
      let args: unknown;
      try { args = JSON.parse(step.tool.argumentsJson); } catch { args = step.tool.argumentsJson; }
      add(step, "tool", { semanticKind: "tool", phase, toolName: boundDisplayText(step.tool.name), title: boundDisplayText(step.tool.summary || step.tool.name), category: "other",
        arguments: boundValue(args), ...(step.tool.result !== undefined ? { result: { content: [{ kind: "text", value: boundText(step.tool.result) }], isError: status === "failed" } } : {}) } as BackendItem);
    }
    if (step.error) { lastResponse = step; add(step, "error", { semanticKind: "notice", tone: "error", text: boundText(step.error) } as BackendItem, "failed"); }
    lastStep = step;
  }
  settle();
  const active = Object.values(snapshot.turnsById).filter(value => value.status === "in_progress");
  if (active.length) { snapshot.runState = "reconciling"; snapshot.activeBackendTurnId = active.at(-1)!.backendTurnId; }
  const activity = antigravityNativeActivity(native);
  snapshot.backgroundActivity = { state: activity.unknown ? "unknown" : "known", agents: activity.agents, commands: activity.commands, other: activity.other };
  const values = Object.values(snapshot.itemsById);
  const usage: UsageSnapshot = { counters: { userMessages: values.filter(item => item.semanticKind === "user_message").length,
    assistantMessages: values.filter(item => item.semanticKind === "assistant_message").length,
    toolCalls: values.filter(item => item.semanticKind === "tool" || item.semanticKind === "command").length,
    toolResults: values.filter(item => (item.semanticKind === "tool" || item.semanticKind === "command") && item.status !== "streaming").length,
    totalMessages: values.filter(item => item.semanticKind === "user_message" || item.semanticKind === "assistant_message").length } };
  // The in-memory native acquisition may contain many bounded pages. Validate
  // each entity here; enforce the aggregate boundary on the requested page.
  for (const [id, item] of Object.entries(snapshot.itemsById)) snapshot.itemsById[id] = backendItemSchema.parse(item);
  for (const [id, value] of Object.entries(snapshot.turnsById)) snapshot.turnsById[id] = backendTurnSchema.parse(value);
  return { snapshot, usage, stepTurns };
}

/** Cursors identify a native turn boundary and are private to one acquisition. */
export function antigravityHistoryPage(snapshot: BackendConversationSnapshot, input: HistoryPageInput): BackendHistoryPage {
  input.signal?.throwIfAborted();
  const limit = Math.min(100, Math.max(1, input.limit));
  const end = input.cursor === undefined ? snapshot.orderedBackendTurnIds.length : snapshot.orderedBackendTurnIds.indexOf(input.cursor);
  if (end < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("antigravity_history_cursor_invalid");
  let start = Math.max(0, end - limit);
  for (;;) {
    const ids = snapshot.orderedBackendTurnIds.slice(start, end);
    const turnsById = Object.fromEntries(ids.map(id => [id, snapshot.turnsById[id]!]));
    const itemIds = ids.flatMap(id => turnsById[id]!.orderedBackendItemIds);
    const page = { orderedBackendTurnIds: ids, turnsById, itemsById: Object.fromEntries(itemIds.map(id => [id, snapshot.itemsById[id]!])),
      ...(start > 0 && ids[0] ? { previousCursor: ids[0] } : {}) };
    // Keep complete turns and exact message bytes; reduce the page rather than
    // rejecting a large conversation whose individual turns remain readable.
    if (ids.length <= 1 || serializedUtf8Bytes(page) <= MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - 4096)
      return backendHistoryPageSchema.parse(page);
    start += Math.max(1, Math.floor(ids.length / 2));
  }
}
/** Keep the loaded page self-contained while preserving independent activity. */
export function antigravityWindowSnapshot(snapshot: BackendConversationSnapshot, page: BackendHistoryPage): BackendConversationSnapshot {
  const { activeBackendTurnId, ...state } = snapshot;
  const { previousCursor: _previousCursor, ...timeline } = page;
  return { ...state, ...timeline, orderedBackendTurnIds: [...timeline.orderedBackendTurnIds],
    ...(activeBackendTurnId && timeline.turnsById[activeBackendTurnId] ? { activeBackendTurnId } : {}) };
}
export function locateAntigravityTurn(snapshot: BackendConversationSnapshot, input: LocateTurnInput): LocateTurnResult {
  input.signal?.throwIfAborted();
  if (!Number.isSafeInteger(input.maximumTurnCandidates) || input.maximumTurnCandidates < 1) throw new Error("antigravity_history_limit_invalid");
  const ids = [...snapshot.orderedBackendTurnIds].reverse();
  for (const id of ids.slice(0, input.maximumTurnCandidates)) if (input.matchesBackendTurnId(id)) {
    const turn = snapshot.turnsById[id]!;
    return { status: "found", page: { orderedBackendTurnIds: [id], turnsById: { [id]: turn },
      itemsById: Object.fromEntries(turn.orderedBackendItemIds.map(itemId => [itemId, snapshot.itemsById[itemId]!])) } };
  }
  return { status: ids.length > input.maximumTurnCandidates ? "search_limit_reached" : "not_found" };
}
