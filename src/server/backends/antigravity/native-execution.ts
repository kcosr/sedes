import type { AntigravityNativeHistory, AntigravityNativeStep } from "./native-schema.js";

/** A standalone system notice is presentational, even when it follows the executor's final step. */
export function isAntigravityStandaloneDiagnostic(step: AntigravityNativeStep): boolean {
  return step.standaloneSystemDiagnostic === true;
}

/** Terminal planner evidence, never an ordinary tool's status or diagnostic. */
export function antigravityNativeTerminalOutcome(step: AntigravityNativeStep | undefined): "completed" | "interrupted" | "failed" | undefined {
  if (!step) return undefined;
  // Native tools can carry non-benign errors (missing files, invalid ranges,
  // command failures) and still return control to the planner. Error text is
  // display evidence, not an execution outcome, even on a failed tool step.
  const response = step.response;
  if (!response) return undefined;
  if (step.status === 7 || [11, 13, 17, 18, 19, 20].includes(response.stopReason)) return "failed";
  if ([6, 12].includes(step.status) || response.stopReason === 16) return "interrupted";
  if (step.status === 3 && [2, 3].includes(response.stopReason) && response.toolCalls.length === 0) return "completed";
  return undefined;
}

type TerminatedExecution = { index: number; outcome: "failed" | "interrupted"; terminationReason: number };
type ExecutionHistory = Pick<AntigravityNativeHistory, "steps" | "executions" | "executorReceiptsOmitted">;
export function antigravityExecutionEvidence(native: ExecutionHistory) {
  const heads = new Map<string, AntigravityNativeStep>(), unsettled = new Set<string>();
  const unconsumed = antigravityUnstartedInputs(native);
  const steps = new Map(native.steps.map(step => [step.index, step]));
  for (const step of native.steps) if (step.executionId) {
    if (!unconsumed.has(step.index)) heads.set(step.executionId, step);
    if (![3, 4, 5, 6, 7, 12].includes(step.status)) unsettled.add(step.executionId);
  }
  const receipts = new Map<string, AntigravityNativeHistory["executions"][number] | null>();
  for (const receipt of native.executions) receipts.set(receipt.executionId, receipts.has(receipt.executionId) ? null : receipt);
  const terminated = new Map<string, TerminatedExecution>();
  const settledHeads = new Map<string, number>();
  for (const [id, head] of heads) {
    const receipt = receipts.get(id);
    // A queued input may be written after the executor has stopped, or may be
    // included in last_step_idx without ever starting. It is not execution
    // progress. Check the receipt's exact native index and execution identity.
    if (unsettled.has(id) || receipt === null || (receipt && (receipt.proceededWithAutoContinue ||
        steps.get(receipt.lastStepIndex)?.executionId !== id || head.index > receipt.lastStepIndex))) continue;
    const outcome = receipt && executorOutcome(receipt.terminationReason);
    if (receipt && outcome) {
      terminated.set(id, { index: head.index, outcome, terminationReason: receipt.terminationReason });
      settledHeads.set(id, head.index);
    } else if (!native.executorReceiptsOmitted && (!receipt || receipt.terminationReason === 4 /* NO_TOOL_CALL */) &&
        antigravityNativeTerminalOutcome(head) === "completed") {
      settledHeads.set(id, head.index);
    }
  }
  return { terminated, settledHeads, unstarted: unconsumed };
}

export function antigravityTerminatedExecutionHeads(native: ExecutionHistory): ReadonlyMap<string, TerminatedExecution> {
  return antigravityExecutionEvidence(native).terminated;
}

function executorOutcome(reason: number): "failed" | "interrupted" | undefined {
  // agy ExecutorTerminationReason, verified against the qualified descriptor.
  switch (reason) {
    case 1: // ERROR
    case 3: // MAX_INVOCATIONS
    case 6: // MAX_FORCED_INVOCATIONS
    case 11: // MAX_TOKEN_BUDGET_EXCEEDED
      return "failed";
    case 2: return "interrupted"; // USER_CANCELED
    // NO_TOOL_CALL requires a terminal planner response. UNSPECIFIED,
    // EARLY_CONTINUE, CHAINED, injected responses and custom terminal hooks
    // cannot establish a turn outcome by themselves; see the backend guide.
    default: return undefined;
  }
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
