import {
  ThreadProviderOutputUndeliveredError,
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";
import { withAbort } from "../runtime/with-abort.js";

export interface ArchivedThreadRuntimeRetirement {
  runWithRuntimeRetired<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
    options?: { readonly purpose: "archive"; readonly signal?: AbortSignal; readonly shouldRetire?: () => boolean },
  ): Promise<Result>;
  /**
   * Within the retired fence, release provider residency that outlives the
   * runtime, such as a remote query; throws ThreadRuntimeNotIdleError while
   * provider work is outstanding, and ThreadProviderOutputUndeliveredError
   * when provider output that could not be applied holds it.
   */
  releaseProviderResidency(
    scope: RequestScope,
    applicationThreadId: string,
    options?: { readonly purpose: "archive"; readonly signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * Holds deterministic per-thread maintenance fences across an archive commit.
 * This makes the idle check and inventory transition one operation: a turn
 * cannot be admitted between them, and overlapping family archives cannot
 * deadlock by taking their thread fences in different orders.
 */
export async function runWithArchivedThreadRuntimesRetired<Result>(input: {
  readonly scope: RequestScope;
  readonly threadIds: readonly string[];
  readonly runtimes: ArchivedThreadRuntimeRetirement;
  /** Only inventory archival may relax incomplete-history retirement. */
  readonly purpose?: "archive";
  readonly startedAt?: number;
  /** Another copy of this mutation can commit while this request waits for admission. */
  readonly replay?: {
    readThreadIds(): readonly string[] | undefined;
    isArchived(threadId: string): boolean;
  };
  readonly operation: (beginCommit: () => void) => Promise<Result>;
}): Promise<Result> {
  const startedAt = input.startedAt ?? performance.now();
  const threadIds = [...new Set(input.threadIds)].sort();
  const deadline = startedAt + (threadIds.length === 1 ? 15_000 : 45_000);
  const archive = input.purpose === "archive";
  const controller = new AbortController();
  const timeout = () => controller.abort(new DomainError("invalid_transition",
    "Sedes could not finish checking the thread and applying pending agent output in time. Try archiving again.", true));
  const aggregateTimer = archive ? setTimeout(timeout, Math.max(0, deadline - performance.now())) : undefined;
  let replayIds: Set<string> | undefined;
  const committedIds = () => {
    if (!replayIds) {
      try {
        const ids = input.replay?.readThreadIds();
        if (ids) replayIds = new Set(ids);
      } catch (cause) {
        if (cause instanceof DomainError) throw cause;
        throw new DomainError("invalid_transition", "Sedes could not verify the archive receipt. Try again.", true, { cause });
      }
    }
    return replayIds;
  };
  const shouldPrepare = (id: string) => {
    if (!input.replay) return true;
    const ids = committedIds();
    return !ids || (ids.has(id) && input.replay.isArchived(id));
  };
  const check = (expires = deadline) => {
    if (!archive) return;
    if (performance.now() >= expires) timeout();
    controller.signal.throwIfAborted();
  };
  // Native synchronization and publication have their own post-commit policies.
  const beginCommit = () => { check(); clearTimeout(aggregateTimer); };
  const retire = async (index: number): Promise<Result> => {
    const threadId = threadIds[index];
    check();
    if (threadId === undefined) return input.operation(beginCommit);
    const expires = Math.min(deadline, performance.now() + 15_000);
    const timer = archive ? setTimeout(timeout, 15_000) : undefined;
    const options = archive ? { purpose: "archive" as const, signal: controller.signal } : undefined;
    try {
      return await input.runtimes.runWithRuntimeRetired(
        input.scope,
        threadId,
        async () => {
          // An archived thread must not keep a remote query resident, or
          // keep its background work running unseen.
          check(expires);
          if (shouldPrepare(threadId)) {
            await input.runtimes.releaseProviderResidency(input.scope, threadId, options);
          }
          check(expires);
          clearTimeout(timer);
          return retire(index + 1);
        },
        options && input.replay
          ? { ...options, shouldRetire: () => shouldPrepare(threadId) } : options,
      );
    } catch (error) {
      if (error instanceof ThreadRuntimeNotIdleError) {
        throw new DomainError(
          "invalid_transition",
          "The inventory change is blocked by active work or an open agent terminal. Wait for the work to finish and close the affected thread's agent terminal, then try again.",
          false,
          { cause: error },
        );
      }
      if (error instanceof ThreadProviderOutputUndeliveredError) {
        throw new DomainError(
          "invalid_transition",
          "Sedes could not finish applying pending agent output. Try again.",
          true,
          { cause: error },
        );
      }
      if (error instanceof ThreadRuntimeRetirementUnprovenError) {
        throw new DomainError(
          "operation_outcome_uncertain",
          "Sedes could not prove that a thread runtime stopped. Restart Sedes before retrying the inventory operation.",
          false,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    // A noncooperative read/cleanup may outlive the request. Its original
    // fences remain held until it settles. The checks forbid a late commit.
    return await withAbort(retire(0), controller.signal);
  } catch (error) {
    if (committedIds()) throw savedArchiveError(error);
    throw error;
  } finally { clearTimeout(aggregateTimer); }
}

/** The inventory receipt already exists. Only that exact request can replay
 * publications, native synchronization or authorized workspace cleanup. */
export async function finishCommittedArchive<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) { throw savedArchiveError(cause); }
}

function savedArchiveError(cause: unknown): DomainError {
  return new DomainError("operation_outcome_uncertain",
    "The archive was saved. Retry the same archive to finish its remaining steps.", true, { cause });
}
