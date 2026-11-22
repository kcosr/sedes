import type { AntigravityNativeHistory, AntigravityNativeStep } from "./native-schema.js";

/** Terminal response/error evidence, never an ordinary tool's own status. */
export function antigravityNativeTerminalOutcome(step: AntigravityNativeStep | undefined): "completed" | "interrupted" | "failed" | undefined {
  if (!step) return undefined;
  if (step.error) return "failed";
  const response = step.response;
  if (!response) return undefined;
  if (step.status === 7 || [11, 13, 17, 18, 19, 20].includes(response.stopReason)) return "failed";
  if ([6, 12].includes(step.status) || response.stopReason === 16) return "interrupted";
  if (step.status === 3 && [2, 3].includes(response.stopReason) && response.toolCalls.length === 0) return "completed";
  return undefined;
}

export function antigravityCancelledExecutionHeads(native: Pick<AntigravityNativeHistory, "steps" | "executions">): ReadonlyMap<string, number> {
  const heads = new Map<string, AntigravityNativeStep>(), unsettled = new Set<string>();
  const unconsumed = antigravityUnstartedInputs(native);
  const steps = new Map(native.steps.map(step => [step.index, step]));
  for (const step of native.steps) if (step.executionId) {
    if (!unconsumed.has(step.index)) heads.set(step.executionId, step);
    if (![3, 4, 5, 6, 7, 12].includes(step.status)) unsettled.add(step.executionId);
  }
  const receipts = new Map<string, AntigravityNativeHistory["executions"][number] | null>();
  for (const receipt of native.executions) receipts.set(receipt.executionId, receipts.has(receipt.executionId) ? null : receipt);
  const cancelled = new Map<string, number>();
  for (const [id, receipt] of receipts) {
    // USER_CANCELED is an executor outcome. A cancelled tool or a quiet native
    // activity inventory alone cannot terminate the enclosing execution.
    const head = heads.get(id) ?? (receipt ? steps.get(receipt.lastStepIndex) : undefined);
    // A queued input may be written after the executor has stopped, or may be
    // included in last_step_idx without ever starting. It is not execution
    // progress. Keep the receipt's exact native index/identity check, then
    // expose the last executed step to history and activity consumers.
    if (receipt?.terminationReason === 2 && !receipt.proceededWithAutoContinue && head &&
        steps.get(receipt.lastStepIndex)?.executionId === id && head.index <= receipt.lastStepIndex &&
        !unsettled.has(id)) cancelled.set(id, head.index);
  }
  return cancelled;
}

/** Native non-consumption evidence only; this never authorizes retrying input. */
export function antigravityUnstartedInputs(native: Pick<AntigravityNativeHistory, "steps">): ReadonlySet<number> {
  const responses = new Set<string>(), candidates = new Set<number>(), unstarted = new Set<number>();
  for (let index = native.steps.length - 1; index >= 0; index--) {
    const step = native.steps[index]!;
    if (step.response && step.executionId) responses.add(step.executionId);
    if (step.user && !step.startedAt && step.executionId && !responses.has(step.executionId)) candidates.add(step.index);
  }
  const executions = new Set<string>();
  for (const step of native.steps) if (step.executionId) {
    // The first input is the execution's own progress boundary even if it was
    // cancelled before the first planner response. Only a later queued input
    // in an already present execution may be omitted from its executed head.
    if (executions.has(step.executionId) && candidates.has(step.index)) unstarted.add(step.index);
    executions.add(step.executionId);
  }
  return unstarted;
}
