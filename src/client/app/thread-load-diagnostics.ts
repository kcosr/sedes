import {
  recordThreadLoadCategoryDiagnostic,
  type DiagnosticDetails,
  type ThreadLoadDiagnosticEvent,
} from "./diagnostics.js";
import { getDiagnosticCategoryEnabled } from "./settings.js";

export type ThreadLoadAttemptSource =
  | "navigation"
  | "history"
  | "initial_route"
  | "reconnect";

export interface ThreadLoadAttempt {
  readonly id: string;
  readonly startedAt: number;
  readonly source: ThreadLoadAttemptSource;
}

const attempts = new Map<string, ThreadLoadAttempt>();
let nextAttempt = 0;

export function beginThreadLoadAttempt(
  threadId: string,
  source: ThreadLoadAttemptSource,
): ThreadLoadAttempt | undefined {
  try {
    if (!getDiagnosticCategoryEnabled("thread_load")) return undefined;
  } catch {
    return undefined;
  }
  const attempt = Object.freeze({
    id: `load-${++nextAttempt}`,
    startedAt: performance.now(),
    source,
  });
  attempts.delete(threadId);
  attempts.set(threadId, attempt);
  while (attempts.size > 64) attempts.delete(attempts.keys().next().value!);
  recordThreadLoadDiagnostic(attempt, "thread_open_requested", { source });
  return attempt;
}

export function currentThreadLoadAttempt(
  threadId: string,
): ThreadLoadAttempt | undefined {
  return attempts.get(threadId);
}

export function recordThreadLoadDiagnostic(
  attempt: ThreadLoadAttempt | undefined,
  event: ThreadLoadDiagnosticEvent,
  details: DiagnosticDetails = {},
): void {
  recordThreadLoadDiagnosticAt(attempt, event, performance.now(), details);
}

export function recordThreadLoadDiagnosticAt(
  attempt: ThreadLoadAttempt | undefined,
  event: ThreadLoadDiagnosticEvent,
  observedAt: number,
  details: DiagnosticDetails = {},
): void {
  if (!attempt) return;
  recordThreadLoadCategoryDiagnostic(event, {
    ...details,
    attemptId: attempt.id,
    attemptElapsedMilliseconds:
      Math.round((observedAt - attempt.startedAt) * 10) / 10,
  });
}

export function resetThreadLoadAttemptsForTests(): void {
  attempts.clear();
  nextAttempt = 0;
}
