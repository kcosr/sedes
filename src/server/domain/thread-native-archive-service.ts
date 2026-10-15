import type { NativeConversationArchiveResult } from "../backends/contracts.js";
import { BackendError } from "../backends/contracts.js";
import type { ThreadApplicationActorTargetResolver } from "../conversations/thread-application-service.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { NativeArchiveOperationRepository } from "../db/repositories/native-archive-operation-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

/**
 * Best-effort provider synchronization after an inventory commit. Callers hold
 * the same thread maintenance fence through the commit and this operation.
 * The durable inventory remains authoritative when a provider is unavailable.
 */
export class ThreadNativeArchiveService {
  constructor(readonly input: {
    readonly inventory: Pick<InventoryRepository, "getInventory">;
    readonly targets: ThreadApplicationActorTargetResolver;
    readonly operations: Pick<NativeArchiveOperationRepository, "hasUncertain" | "begin" | "complete">;
    readonly onError: (threadId: string, error: unknown) => void;
    readonly onResult?: (
      threadId: string,
      action: "archive" | "restore",
      result: NativeConversationArchiveResult,
    ) => void;
  }) {}

  async archive(scope: RequestScope, threadIds: readonly string[]): Promise<void> {
    const signal = AbortSignal.timeout(5_000);
    for (const [index, threadId] of threadIds.entries()) {
      if (signal.aborted) {
        try {
          this.input.onError(threadId, new DomainError(
            "runtime_unavailable",
            `Native archive synchronization timed out; ${threadIds.length - index} remaining threads were not attempted.`,
            true,
          ));
        } catch { /* Observer only. */ }
        break;
      }
      await this.#synchronize(scope, threadId, "archive", signal);
    }
  }

  restore(scope: RequestScope, threadId: string): Promise<void> {
    return this.#synchronize(scope, threadId, "restore", AbortSignal.timeout(5_000));
  }

  async #synchronize(
    scope: RequestScope,
    threadId: string,
    action: "archive" | "restore",
    signal: AbortSignal,
  ): Promise<void> {
    let mutationId: string | undefined;
    try {
      const state = this.input.inventory.getInventory(scope, threadId);
      if ((state.inventoryState === "archived") !== (action === "archive")) return;
      if (this.input.operations.hasUncertain(scope, threadId)) {
        throw new DomainError("operation_outcome_uncertain", "Native archive synchronization still needs recovery before another native change.");
      }
      const target = await this.input.targets.resolve(scope, threadId);
      if (!target.driver.nativeArchive) return;
      signal.throwIfAborted();
      mutationId = this.input.operations.begin(scope, target.binding, action);
      if (!mutationId) return;
      const result = await target.driver.nativeArchive({
        scope: target.scope,
        binding: target.binding,
        workspace: target.workspace,
        action,
        signal,
      });
      this.input.operations.complete(scope, mutationId);
      this.input.onResult?.(threadId, action, result);
    } catch (error) {
      if (mutationId && error instanceof BackendError && !error.crossedSubmissionBoundary) {
        try { this.input.operations.complete(scope, mutationId); }
        catch (completionError) {
          try { this.input.onError(threadId, completionError); } catch { /* Observer only. */ }
        }
      }
      // The local transition has committed. Provider failures must never make
      // its result look rejected or prevent archiving missing native history.
      try { this.input.onError(threadId, error); } catch { /* Observer only. */ }
    }
  }
}
