import {
  ThreadProviderOutputUndeliveredError,
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

export interface ArchivedThreadRuntimeRetirement {
  runWithRuntimeRetired<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
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
  readonly operation: () => Promise<Result>;
}): Promise<Result> {
  const threadIds = [...new Set(input.threadIds)].sort();
  const retire = async (index: number): Promise<Result> => {
    const threadId = threadIds[index];
    if (threadId === undefined) return input.operation();
    try {
      return await input.runtimes.runWithRuntimeRetired(
        input.scope,
        threadId,
        async () => {
          // An archived thread must not keep a remote query resident, or
          // keep its background work running unseen.
          await input.runtimes.releaseProviderResidency(input.scope, threadId);
          return retire(index + 1);
        },
      );
    } catch (error) {
      if (error instanceof ThreadRuntimeNotIdleError) {
        throw new DomainError(
          "invalid_transition",
          "A thread became active before the inventory change could commit. Wait for it to finish, then try again.",
          false,
          { cause: error },
        );
      }
      if (error instanceof ThreadProviderOutputUndeliveredError) {
        throw new DomainError(
          "invalid_transition",
          "A thread has agent output that Sedes could not apply yet. Open the thread so its output is applied, then try again.",
          false,
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
    }
  };
  return retire(0);
}
