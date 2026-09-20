import {
  ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
  type ThreadArchiveImpact,
  type ThreadExecutionWorkspaceResource,
} from "../../shared/protocol/api.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import type { OpenTaskDisposition } from "../../shared/protocol/tasks.js";
import type { DatabaseApplicationThreadSummaryReader } from "../application/database-application-summary-reader.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { TaskRepository } from "../db/repositories/task-repository.js";
import type { ThreadLineageRepository } from "../db/repositories/thread-lineage-repository.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { InventoryService } from "./inventory-service.js";
import type { TaskChangePublisher } from "./task-service.js";
import { DomainError } from "./errors.js";
import {
  runWithArchivedThreadRuntimesRetired,
  type ArchivedThreadRuntimeRetirement,
} from "./thread-runtime-archive-retirement.js";

const MAXIMUM_APPLICATION_THREADS = 10_000;
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

type BlockReason = "running" | "active";

type ImpactFacts = {
  readonly blocked: ReadonlyMap<string, BlockReason>;
  readonly pendingQuestionCounts: ReadonlyMap<string, number>;
  readonly stashedPromptCounts: ReadonlyMap<string, number>;
};

function runState(
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

function unavailableReason(reason: BlockReason, descendant: boolean): string {
  const subject = descendant ? "A descendant" : "This thread";
  if (reason === "running")
    return `${subject} is running and cannot be archived.`;
  return `${subject} is active and cannot be archived.`;
}

/**
 * Application-owned archive boundary. Providers are deliberately absent:
 * family membership, inventory, runtime state, and mutation receipts are all
 * normalized Sedes concerns shared by every backend.
 */
export class ThreadArchiveService {
  constructor(
    readonly input: {
      readonly inventory: InventoryRepository;
      readonly lineage: Pick<ThreadLineageRepository, "listFamilyThreadIds">;
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
      readonly executionWorkspaces: {
        status(
          scope: RequestScope,
          threadId: string,
        ): Promise<ThreadExecutionWorkspaceResource>;
        delete(
          scope: RequestScope,
          threadId: string,
          input: {
            readonly expectedRevision: number;
            readonly operationId: string;
          },
        ): Promise<unknown>;
      };
      readonly now?: () => number;
    },
  ) {}

  async impact(
    scope: RequestScope,
    threadId: string,
  ): Promise<ThreadArchiveImpact> {
    const familyThreadIds = this.#familyThreadIds(scope, threadId);
    const threadIds = [
      threadId,
      ...familyThreadIds
        .slice(1)
        .filter(
          (candidate) =>
            this.input.inventory.getInventory(scope, candidate)
              .inventoryState !== "archived",
        ),
    ];
    const [facts, executionWorkspace] = await Promise.all([
      this.#impactFacts(scope, threadIds),
      this.input.executionWorkspaces.status(scope, threadId),
    ]);
    const blocked = facts.blocked;
    const rootReason = blocked.get(threadId);
    const firstBlockedDescendant = threadIds
      .slice(1)
      .map((candidate) => blocked.get(candidate))
      .find((reason): reason is BlockReason => reason !== undefined);
    const rootOpenTasks = this.input.tasks.listOpenThreadTaskSummaries(
      scope,
      [threadId],
      ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
    );
    const descendantOpenTasks = this.input.tasks.listOpenThreadTaskSummaries(
      scope,
      threadIds.slice(1),
      ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
    );
    return {
      descendantCount: threadIds.length - 1,
      pendingQuestions: {
        root: facts.pendingQuestionCounts.get(threadId) ?? 0,
        descendants: threadIds.slice(1).reduce(
          (total, candidate) =>
            total + (facts.pendingQuestionCounts.get(candidate) ?? 0),
          0,
        ),
      },
      stashedPrompts: {
        root: facts.stashedPromptCounts.get(threadId) ?? 0,
        descendants: threadIds
          .slice(1)
          .reduce(
            (total, candidate) =>
              total + (facts.stashedPromptCounts.get(candidate) ?? 0),
            0,
          ),
      },
      openTasks: {
        root: { ...rootOpenTasks, items: [...rootOpenTasks.items] },
        descendants: {
          ...descendantOpenTasks,
          items: [...descendantOpenTasks.items],
        },
      },
      executionWorkspace,
      archiveOnly: rootReason
        ? {
            available: false,
            unavailableReason: unavailableReason(rootReason, false),
          }
        : { available: true },
      archiveAll: rootReason
        ? {
            available: false,
            unavailableReason: unavailableReason(rootReason, false),
          }
        : firstBlockedDescendant
          ? {
              available: false,
              unavailableReason: unavailableReason(
                firstBlockedDescendant,
                true,
              ),
            }
          : { available: true },
    };
  }

  async archive(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly includeDescendants: boolean;
      readonly expectedRevision: number;
      readonly mutationId: string;
      /**
       * Optional server-captured family fence used by agent-tool admission.
       * The domain recomputes the family immediately before mutation and
       * rejects any changed ancestry instead of silently expanding authority.
       */
      readonly expectedThreadIds?: readonly string[];
      readonly expectedStashedPromptCount?: number;
      readonly openTaskDisposition?: OpenTaskDisposition;
      readonly executionWorkspaceDisposition:
        | { readonly kind: "keep" }
        | {
            readonly kind: "delete";
            readonly expectedRevision: number;
            readonly operationId: string;
          };
    },
  ): Promise<readonly string[]> {
    const now = this.input.now?.() ?? Date.now();
    const disposition = input.openTaskDisposition ?? "keep";
    const replay = this.input.inventory.findArchiveThreadsReplay(
      scope,
      threadId,
      input,
    );
    if (replay) {
      await runWithArchivedThreadRuntimesRetired({
        scope,
        threadIds: replay.states
          .filter(({ inventoryState }) => inventoryState === "archived")
          .map(({ threadId: replayThreadId }) => replayThreadId),
        runtimes: this.input.runtimes,
        operation: async () => undefined,
      });
      await this.input.publications.publishCommitted(scope, replay.states, now);
      // Re-publishing the receipted moved tasks lets a retry recover task
      // events the original request failed to emit after its commit.
      for (const movedTaskId of replay.movedTaskIds) {
        await this.input.taskPublications.publishTaskChange(scope, movedTaskId);
      }
      await this.#applyExecutionWorkspaceDisposition(
        scope,
        threadId,
        input.executionWorkspaceDisposition,
      );
      return replay.threadIds;
    }
    let threadIds: readonly string[];
    if (input.includeDescendants) {
      threadIds = this.#familyThreadIds(scope, threadId);
    } else {
      this.input.inventory.getThread(scope, threadId);
      threadIds = [threadId];
    }
    if (
      input.expectedThreadIds &&
      (input.expectedThreadIds.length !== threadIds.length ||
        input.expectedThreadIds.some(
          (expectedThreadId, index) => expectedThreadId !== threadIds[index],
        ))
    ) {
      throw new DomainError(
        "conflict",
        "The thread family changed after the archive operation was admitted.",
      );
    }
    const blocked = await this.#blockedThreads(scope, threadIds);
    const result = await runWithArchivedThreadRuntimesRetired({
      scope,
      threadIds,
      runtimes: this.input.runtimes,
      operation: async () =>
        this.input.inventory.archiveThreads(scope, threadId, {
          ...input,
          expectedThreadIds: threadIds,
          blockedThreadIds: new Set(blocked.keys()),
          now,
          moveOpenTasks:
            disposition === "keep"
              ? undefined
              : (archivedThreadIds) =>
                  this.input.tasks.moveOpenThreadTasks(
                    scope,
                    archivedThreadIds,
                    disposition,
                    now,
                  ),
        }),
    });
    await this.input.publications.publishCommitted(scope, result.states, now);
    for (const movedTaskId of result.movedTaskIds) {
      await this.input.taskPublications.publishTaskChange(scope, movedTaskId);
    }
    await this.#applyExecutionWorkspaceDisposition(
      scope,
      threadId,
      input.executionWorkspaceDisposition,
    );
    return result.states.map(
      ({ threadId: changedThreadId }) => changedThreadId,
    );
  }

  async settle(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly expectedStashedPromptCount?: number;
      readonly openTaskDisposition?: OpenTaskDisposition;
    },
  ): Promise<void> {
    const now = this.input.now?.() ?? Date.now();
    const disposition = input.openTaskDisposition ?? "keep";
    const result = this.input.inventory.settleThread(scope, threadId, {
      ...input,
      now,
      moveOpenTasks:
        disposition === "keep"
          ? undefined
          : () =>
              this.input.tasks.moveOpenThreadTasks(
                scope,
                [threadId],
                disposition,
                now,
              ),
    });
    await this.input.publications.publishCommitted(scope, [result.state], now);
    for (const movedTaskId of result.movedTaskIds) {
      await this.input.taskPublications.publishTaskChange(scope, movedTaskId);
    }
  }

  assertExecutionWorkspaceDeletionAllowed(
    scope: RequestScope,
    threadId: string,
  ): void {
    const inventory = this.input.inventory.getInventory(scope, threadId);
    if (inventory.inventoryState !== "archived") {
      throw new DomainError(
        "invalid_transition",
        "Archive the thread before deleting its isolated workspace.",
      );
    }
  }

  #familyThreadIds(scope: RequestScope, threadId: string): readonly string[] {
    return this.input.lineage.listFamilyThreadIds(
      scope,
      threadId,
      MAXIMUM_APPLICATION_THREADS,
    );
  }

  async #blockedThreads(
    scope: RequestScope,
    threadIds: readonly string[],
  ): Promise<ReadonlyMap<string, BlockReason>> {
    return (await this.#impactFacts(scope, threadIds)).blocked;
  }

  async #applyExecutionWorkspaceDisposition(
    scope: RequestScope,
    threadId: string,
    disposition:
      | { readonly kind: "keep" }
      | {
          readonly kind: "delete";
          readonly expectedRevision: number;
          readonly operationId: string;
        },
  ): Promise<void> {
    if (disposition.kind !== "delete") return;
    await this.input.executionWorkspaces.delete(scope, threadId, disposition);
  }

  async #impactFacts(
    scope: RequestScope,
    threadIds: readonly string[],
  ): Promise<ImpactFacts> {
    const blocked = new Map<string, BlockReason>();
    const pendingQuestionCounts = new Map<string, number>();
    const stashedPromptCounts = new Map<string, number>();
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
          if (!summary) throw new Error("archive_thread_summary_missing");
          stashedPromptCounts.set(threadId, summary.stashedPromptCount);
          pendingQuestionCounts.set(threadId, summary.pendingQuestionCount);
          const loaded = await this.input.runtimes.captureLoadedState(
            scope,
            threadId,
          );
          const state = runState(
            this.input.inventory.isThreadCreationForceReset(scope, threadId) &&
              summary.backingState === "creating"
              ? "creation_unknown"
              : summary.backingState,
            summary.available,
            loaded?.runState,
          );
          if (!BLOCKED_RUN_STATES.has(state)) return;
          blocked.set(threadId, state === "running" ? "running" : "active");
        }),
      );
    }
    for (const threadId of this.input.inventory.findArchiveDurablyBlockedThreadIds(
      scope,
      threadIds,
    )) {
      if (!blocked.has(threadId)) blocked.set(threadId, "active");
    }
    return { blocked, stashedPromptCounts, pendingQuestionCounts };
  }
}
