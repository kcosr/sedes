import {
  ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
  BULK_INVENTORY_BLOCKER_SUMMARY_LIMIT,
  MAXIMUM_BULK_INVENTORY_OPEN_TASKS,
  type BulkInventoryAction,
  type BulkInventoryBlockerReason,
  type BulkInventoryImpact,
  type BulkInventoryImpactRequest,
  type BulkInventoryMutationRequest,
  type BulkInventoryMutationResult,
  type BulkInventoryTarget,
} from "../../shared/protocol/api.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import type { DatabaseApplicationThreadSummaryReader } from "../application/database-application-summary-reader.js";
import type {
  InventoryPrincipalStateRecord,
  InventoryRepository,
} from "../db/repositories/inventory-repository.js";
import type { TaskRepository } from "../db/repositories/task-repository.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";
import type { InventoryService } from "./inventory-service.js";
import type { TaskChangePublisher } from "./task-service.js";
import {
  runWithArchivedThreadRuntimesRetired,
  type ArchivedThreadRuntimeRetirement,
} from "./thread-runtime-archive-retirement.js";

const SUMMARY_PAGE_SIZE = 100;
const BLOCKED_RUN_STATES = new Set<ThreadRunState>([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "stopping",
  "disconnected",
  "reconciling",
]);

function effectiveRunState(
  backingState: "unbound" | "creating" | "bound" | "creation_unknown",
  available: boolean,
  loaded: ThreadRunState | undefined,
): ThreadRunState {
  if (backingState === "creating") return "starting";
  if (backingState === "creation_unknown") return "failed";
  if (backingState === "unbound") return "idle";
  if (!available) return "disconnected";
  return loaded ?? "idle";
}

function isAffected(
  action: BulkInventoryAction,
  state: InventoryPrincipalStateRecord,
): boolean {
  switch (action) {
    case "settle":
      return (
        state.inventoryState === "active" || state.inventoryState === "snoozed"
      );
    case "unsettle":
      return state.inventoryState === "settled";
    case "archive":
      return state.inventoryState !== "archived";
  }
}

/**
 * Principal-scoped, backend-neutral lifecycle boundary for a browser-frozen
 * sidebar stack. The browser selects members; this service re-derives every
 * authoritative fact and the repository commits the complete set atomically.
 */
export class ThreadBulkInventoryService {
  constructor(
    readonly input: {
      readonly inventory: InventoryRepository;
      readonly summaries: Pick<
        DatabaseApplicationThreadSummaryReader,
        "listByIds"
      >;
      readonly runtimes: Pick<ThreadRuntimeCoordinator, "captureLoadedState"> &
        ArchivedThreadRuntimeRetirement;
      readonly publications: Pick<InventoryService, "publishCommitted">;
      readonly tasks: Pick<
        TaskRepository,
        "listOpenThreadTaskSummaries" | "moveOpenThreadTasks"
      >;
      readonly taskPublications: TaskChangePublisher;
      readonly now?: () => number;
    },
  ) {}

  async impact(
    scope: RequestScope,
    input: BulkInventoryImpactRequest,
  ): Promise<BulkInventoryImpact> {
    const states = this.#loadVisibleStates(scope, input.threadIds);
    const affectedStates = states.filter((state) =>
      isAffected(input.action, state),
    );
    const affectedThreadIds = affectedStates.map(({ threadId }) => threadId);
    const inspection = await this.#inspectThreads(
      scope,
      affectedThreadIds,
      input.action !== "unsettle",
    );
    const blocked = inspection.blocked;
    const blockerItems = affectedThreadIds
      .flatMap((threadId) => {
        const reason = blocked.get(threadId);
        return reason ? [{ threadId, reason }] : [];
      })
      .slice(0, BULK_INVENTORY_BLOCKER_SUMMARY_LIMIT);
    const openTasks = this.input.tasks.listOpenThreadTaskSummaries(
      scope,
      affectedThreadIds,
      ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
    );
    return {
      action: input.action,
      targets: states.map(({ threadId, inventoryRevision }) => ({
        threadId,
        expectedRevision: inventoryRevision,
      })),
      targetCount: states.length,
      affectedCount: affectedStates.length,
      unchangedCount: states.length - affectedStates.length,
      blockers: {
        items: blockerItems,
        total: blocked.size,
        omitted: blocked.size - blockerItems.length,
      },
      openTasks: { ...openTasks, items: [...openTasks.items] },
      stashedPromptCount: inspection.stashedPromptCount,
      pendingQuestionCount: inspection.pendingQuestionCount,
      available:
        affectedStates.length > 0 &&
        blocked.size === 0 &&
        openTasks.total <= MAXIMUM_BULK_INVENTORY_OPEN_TASKS,
    };
  }

  async transition(
    scope: RequestScope,
    input: BulkInventoryMutationRequest,
  ): Promise<BulkInventoryMutationResult> {
    const now = this.input.now?.() ?? Date.now();
    const replay = this.input.inventory.findBulkInventoryReplay(scope, input);
    if (replay) {
      if (input.action === "archive") {
        await runWithArchivedThreadRuntimesRetired({
          scope,
          threadIds: replay.states
            .filter(({ inventoryState }) => inventoryState === "archived")
            .map(({ threadId }) => threadId),
          runtimes: this.input.runtimes,
          operation: async () => undefined,
        });
      }
      await this.#publish(scope, replay.states, replay.movedTaskIds, now);
      return { changedThreadIds: [...replay.changedThreadIds] };
    }

    const states = this.#loadMutationStates(scope, input.targets);
    const affectedThreadIds = states
      .filter((state) => isAffected(input.action, state))
      .map(({ threadId }) => threadId);
    if (affectedThreadIds.length === 0) {
      throw new DomainError(
        "invalid_transition",
        "Every thread in the stack already has the requested inventory state.",
      );
    }
    const blocked =
      input.action === "unsettle"
        ? new Map<string, BulkInventoryBlockerReason>()
        : (await this.#inspectThreads(scope, affectedThreadIds, true)).blocked;
    const disposition =
      input.action === "unsettle"
        ? "keep"
        : (input.openTaskDisposition ?? "keep");
    const transition = async () =>
      this.input.inventory.bulkInventoryTransition(scope, {
        ...input,
        blockedThreadIds: new Set(blocked.keys()),
        now,
        ...(input.action === "unsettle"
          ? {}
          : {
              countOpenTasks: (threadIds: readonly string[]) =>
                this.input.tasks.listOpenThreadTaskSummaries(
                  scope,
                  threadIds,
                  0,
                ).total,
            }),
        ...(disposition === "keep"
          ? {}
          : {
              moveOpenTasks: (threadIds: readonly string[]) =>
                this.input.tasks.moveOpenThreadTasks(
                  scope,
                  threadIds,
                  disposition,
                  now,
                ),
            }),
      });
    const result =
      input.action === "archive"
        ? await runWithArchivedThreadRuntimesRetired({
            scope,
            threadIds: affectedThreadIds,
            runtimes: this.input.runtimes,
            operation: transition,
          })
        : await transition();
    await this.#publish(scope, result.states, result.movedTaskIds, now);
    return { changedThreadIds: [...result.changedThreadIds] };
  }

  #loadVisibleStates(
    scope: RequestScope,
    threadIds: readonly string[],
  ): InventoryPrincipalStateRecord[] {
    return threadIds.map((threadId) => {
      const state = this.input.inventory.getInventory(scope, threadId);
      if (state.inventoryState === "archived") {
        throw new DomainError(
          "invalid_transition",
          "An archived thread cannot belong to a visible stack.",
        );
      }
      return state;
    });
  }

  #loadMutationStates(
    scope: RequestScope,
    targets: readonly BulkInventoryTarget[],
  ): InventoryPrincipalStateRecord[] {
    return targets.map(({ threadId, expectedRevision }) => {
      const state = this.input.inventory.getInventory(scope, threadId);
      if (state.inventoryRevision !== expectedRevision) {
        throw new DomainError(
          "inventory_revision_conflict",
          "A thread inventory changed in another client.",
        );
      }
      if (state.inventoryState === "archived") {
        throw new DomainError(
          "invalid_transition",
          "An archived thread cannot belong to a visible stack.",
        );
      }
      return state;
    });
  }

  async #inspectThreads(
    scope: RequestScope,
    threadIds: readonly string[],
    checkBlockers: boolean,
  ): Promise<{
    readonly blocked: ReadonlyMap<string, BulkInventoryBlockerReason>;
    readonly stashedPromptCount: number;
    readonly pendingQuestionCount: number;
  }> {
    const blocked = new Map<string, BulkInventoryBlockerReason>();
    let stashedPromptCount = 0;
    let pendingQuestionCount = 0;
    for (
      let offset = 0;
      offset < threadIds.length;
      offset += SUMMARY_PAGE_SIZE
    ) {
      const page = threadIds.slice(offset, offset + SUMMARY_PAGE_SIZE);
      const summaries = this.input.summaries.listByIds(scope, page);
      const byId = new Map(summaries.map((summary) => [summary.id, summary]));
      await Promise.all(
        page.map(async (threadId) => {
          const summary = byId.get(threadId);
          if (!summary)
            throw new DomainError("not_found", "The thread was not found.");
          stashedPromptCount += summary.stashedPromptCount;
          pendingQuestionCount += summary.pendingQuestionCount;
          if (!checkBlockers) return;
          const loaded = await this.input.runtimes.captureLoadedState(
            scope,
            threadId,
          );
          const state = effectiveRunState(
            this.input.inventory.isThreadCreationForceReset(scope, threadId) &&
              summary.backingState === "creating"
              ? "creation_unknown"
              : summary.backingState,
            summary.available,
            loaded?.runState,
          );
          if (BLOCKED_RUN_STATES.has(state)) {
            blocked.set(threadId, state === "running" ? "running" : "active");
          }
        }),
      );
    }
    if (checkBlockers) {
      for (const threadId of this.input.inventory.findArchiveDurablyBlockedThreadIds(
        scope,
        threadIds,
      )) {
        if (!blocked.has(threadId)) blocked.set(threadId, "active");
      }
    }
    return { blocked, stashedPromptCount, pendingQuestionCount };
  }

  async #publish(
    scope: RequestScope,
    states: readonly InventoryPrincipalStateRecord[],
    movedTaskIds: readonly string[],
    now: number,
  ): Promise<void> {
    if (states.length > 0) {
      await this.input.publications.publishCommitted(scope, states, now);
    }
    for (const taskId of movedTaskIds) {
      await this.input.taskPublications.publishTaskChange(scope, taskId);
    }
  }
}
