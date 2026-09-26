import { BackendError } from "../backends/contracts.js";

export interface RetainedThreadAttachmentResult {
  /** False when the pass stopped early and should be retried later. */
  readonly complete: boolean;
  readonly attachedThreadIds: readonly string[];
}

/**
 * Opens the runtime of each thread whose provider work outlived main in a
 * service-owned runtime, so the thread applies and acknowledges it rather than
 * leaving it to accumulate until the owner's retention bound fails the query.
 * Threads open one at a time and are released at once: a running thread stays
 * resident until it settles, then idles out as usual. The pass stops at the
 * shared runtime budget and reports itself incomplete.
 */
export async function attachRetainedThreads(input: {
  readonly threadIds: readonly string[];
  readonly signal: AbortSignal;
  acquire(applicationThreadId: string): Promise<{ release(): void }>;
  report(context: string, error: unknown): void;
}): Promise<RetainedThreadAttachmentResult> {
  const attachedThreadIds: string[] = [];
  for (const threadId of new Set(input.threadIds)) {
    if (input.signal.aborted) return { complete: false, attachedThreadIds };
    try {
      const acquired = await input.acquire(threadId);
      acquired.release();
      attachedThreadIds.push(threadId);
    } catch (error) {
      if (error instanceof BackendError && error.backendCode === "conversation_runtime_budget_reached") {
        input.report("Retained provider work attachment deferred at the runtime budget", error);
        return { complete: false, attachedThreadIds };
      }
      if (input.signal.aborted) return { complete: false, attachedThreadIds };
      // One unusable thread must not strand the others.
      input.report(`Thread ${threadId} retained work attachment`, error);
    }
  }
  return { complete: true, attachedThreadIds };
}
