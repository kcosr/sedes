import type { AntigravityNativeHistory } from "../native-schema.js";
import { antigravityCancelledExecutionHeads, antigravityNativeTerminalOutcome, antigravityUnstartedInputs } from "../native-execution.js";

const activeStatuses = new Set([1, 2, 8, 9, 11]);
const terminalStatuses = new Set([3, 4, 5, 6, 7, 12]);
/** Inventory and terminal receipts are independent. No quiet-period idle guess. */
export function antigravityNativeActivity(history: AntigravityNativeHistory): { readonly active: boolean; readonly unknown: boolean; readonly foregroundActive: boolean; readonly pendingContinuations: boolean; readonly agents: number; readonly commands: number; readonly other: number } {
  let active = false, unknown = false, foregroundActive = false, pendingContinuations = false;
  const agents = new Set<string>(), commands = new Set<string>(), other = new Set<string>();
  const commandTerminals = new Set(history.steps.flatMap(step => step.commandStatus && terminalStatuses.has(step.commandStatus.status) ? [step.commandStatus.commandId] : []));
  const cancelled = antigravityCancelledExecutionHeads(history), unstarted = antigravityUnstartedInputs(history);
  const executionSettledAfter = (index: number) => {
    let executionId: string | undefined, cancellationEligible = true;
    for (const step of history.steps) {
      if (step.index < index) continue;
      // A terminal planner response still consumes the preceding continuation,
      // including when steering changed its execution. Only cancellation proof
      // is fenced: an unrelated input cannot lend its executor receipt to the
      // earlier continuation. Same-execution input and a natively consumed
      // interrupting input remain part of the work already in progress.
      if (step.index > index && step.response && antigravityNativeTerminalOutcome(step) !== undefined) return true;
      if (step.index > index && step.user && !unstarted.has(step.index) &&
          (!step.executionId || step.executionId !== executionId) &&
          !(step.isInterruptingStep && step.startedAt && step.completedAt)) cancellationEligible = false;
      if (cancellationEligible && step.executionId && cancelled.get(step.executionId) === step.index) return true;
      if (step.executionId && !unstarted.has(step.index)) executionId = step.executionId;
    }
    return false;
  };
  const receiptConsumed = (sender: string, afterIndex: number) => history.steps.some(step => step.index > afterIndex && step.continuation?.sender === sender && executionSettledAfter(step.index));
  for (const step of history.steps) {
    if (activeStatuses.has(step.status)) active = true;
    else if (!terminalStatuses.has(step.status)) unknown = true;
    if (step.response && activeStatuses.has(step.status)) foregroundActive = true;
    if (step.hasSubtrajectory && step.subtrajectoryState !== "terminal") {
      if (step.subtrajectoryState === "active") active = true; else unknown = true;
    }
    for (const child of step.subagents ?? []) {
      if (child.state === "active") { active = true; agents.add(child.sessionId); }
      else if (child.state === "unknown") { unknown = true; agents.add(child.sessionId); }
      else if (child.state === "terminal" && !receiptConsumed(child.sessionId, step.index)) { pendingContinuations = true; agents.add(child.sessionId); }
    }
    let pendingTask = false;
    if (step.task) {
      if (step.task.daemon && activeStatuses.has(step.status) && !commandTerminals.has(step.task.id)) { active = true; pendingTask = true; }
      if (step.status === 3 && step.schedule?.outcome !== "cancelled" && !receiptConsumed(step.task.id, step.index)) { pendingContinuations = true; pendingTask = true; }
      if (activeStatuses.has(step.status)) pendingTask = true;
      if (pendingTask) (step.command ? commands : other).add(step.task.id);
    }
    if (step.continuation && !executionSettledAfter(step.index)) { pendingContinuations = true; foregroundActive = true; }
    if (step.command?.commandId && !commandTerminals.has(step.command.commandId) &&
        activeStatuses.has(step.status)) { active = true; commands.add(step.command.commandId); }
    if (activeStatuses.has(step.status) && !step.response && !step.task && !step.subagents?.length) {
      if (step.command) commands.add(step.command.commandId ?? `step:${step.index}`);
      else if (step.tool) other.add(step.tool.id);
    }
  }
  return { active: active || pendingContinuations, unknown, foregroundActive, pendingContinuations,
    agents: agents.size, commands: commands.size, other: other.size };
}
