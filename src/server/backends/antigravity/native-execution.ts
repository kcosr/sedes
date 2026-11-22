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
  for (const step of native.steps) if (step.executionId) {
    heads.set(step.executionId, step);
    if (![3, 4, 5, 6, 7, 12].includes(step.status)) unsettled.add(step.executionId);
  }
  const receipts = new Map<string, AntigravityNativeHistory["executions"][number] | null>();
  for (const receipt of native.executions) receipts.set(receipt.executionId, receipts.has(receipt.executionId) ? null : receipt);
  const cancelled = new Map<string, number>();
  for (const [id, receipt] of receipts) {
    // USER_CANCELED is an executor outcome. A cancelled tool or a quiet native
    // activity inventory alone cannot terminate the enclosing execution.
    if (receipt?.terminationReason === 2 && !receipt.proceededWithAutoContinue &&
        heads.get(id)?.index === receipt.lastStepIndex && !unsettled.has(id)) cancelled.set(id, receipt.lastStepIndex);
  }
  return cancelled;
}
