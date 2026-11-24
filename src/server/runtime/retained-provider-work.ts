import { BackendError } from "../backends/contracts.js";

export interface RetainedThreadAttachmentResult {
  /** False when the pass stopped early and should be retried later. */
  readonly complete: boolean;
  readonly attachedThreadIds: readonly string[];
  /** Acquisitions that failed for a reason other than the budget or abort. */
  readonly failures: readonly { readonly threadId: string; readonly error: unknown }[];
}

/**
 * Opens the runtime of each thread whose provider work may have outlived main:
 * work a service-owned runtime reports retaining, so the thread applies and
 * acknowledges it rather than leaving it to accumulate until the owner's
 * retention bound fails the query, or a Sedes-accepted submission whose
 * terminal outcome main never observed. Threads open one at a time and are
 * released at once: a running thread stays resident until it settles, then
 * idles out as usual. The pass stops at the shared runtime budget and reports
 * itself incomplete.
 */
export async function attachRetainedThreads(input: {
  readonly threadIds: readonly string[];
  readonly signal: AbortSignal;
  acquire(applicationThreadId: string): Promise<{ release(): void }>;
  report(context: string, error: unknown): void;
}): Promise<RetainedThreadAttachmentResult> {
  const attachedThreadIds: string[] = [];
  const failures: { readonly threadId: string; readonly error: unknown }[] = [];
  for (const threadId of new Set(input.threadIds)) {
    if (input.signal.aborted) return { complete: false, attachedThreadIds, failures };
    try {
      const acquired = await input.acquire(threadId);
      acquired.release();
      attachedThreadIds.push(threadId);
    } catch (error) {
      if (error instanceof BackendError && error.backendCode === "conversation_runtime_budget_reached") {
        input.report("Retained provider work attachment deferred at the runtime budget", error);
        return { complete: false, attachedThreadIds, failures };
      }
      if (input.signal.aborted) return { complete: false, attachedThreadIds, failures };
      // One unusable thread must not strand the others.
      input.report(`Thread ${threadId} retained work attachment`, error);
      failures.push({ threadId, error });
    }
  }
  return { complete: true, attachedThreadIds, failures };
}
