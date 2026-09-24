import type { UsageService } from "../usage/usage-service.js";
import { randomUUID } from "node:crypto";
import type {
  ConversationHistoryWindow,
  HistoryPage,
  NormalizedThreadSnapshot,
  ThreadHistorySeekResult,
  ThreadEventEnvelope,
} from "../../shared/protocol/conversation.js";
import type { LoadThreadHistoryRequest } from "../../shared/protocol/api.js";
import {
  historyPageSchema,
  MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  MAXIMUM_NORMALIZED_TIMELINE_TURNS,
  safeParseHistoryPageStructure,
  threadHistorySeekResultSchema,
} from "../../shared/protocol/conversation.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../shared/protocol/payload.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { ConversationActorSnapshotState } from "./conversation-actor.js";
import { MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES } from "./conversation-actor.js";
import type { ThreadApplicationInventoryReader } from "./thread-application-service.js";
import {
  projectedThreadForkSourceCapability,
  projectedTurnForkCapability,
} from "./conversation-projector.js";

const DEFAULT_MAXIMUM_CURSORS = 2_048;
const DEFAULT_CURSOR_LIFETIME_MILLISECONDS = 30 * 60 * 1_000;

interface HistoryCursorEntry {
  readonly tenantId: string;
  readonly principalId: string;
  readonly applicationThreadId: string;
  readonly projectionGeneration: string;
  readonly backendCursor: string;
  readonly expiresAt: number;
  readonly remainingTurns: number;
  readonly remainingItems: number;
  readonly currentSerializedBytes: number;
  readonly currentHistoryBytes: number;
  readonly orderedTurnCount: number;
  readonly turnRecordCount: number;
  readonly forkRecordCount: number;
  readonly itemRecordCount: number;
  acceptedLimit?: LoadThreadHistoryRequest["limit"];
  result?: ThreadEventEnvelope;
  pending?: Promise<ThreadEventEnvelope>;
}

function cursorKey(
  scope: RequestScope,
  applicationThreadId: string,
  projectionGeneration: string,
  backendCursor: string,
  remainingTurns: string,
  remainingItems: string,
  currentSerializedBytes: string,
): string {
  return [
    scope.tenantId,
    scope.principalId,
    applicationThreadId,
    projectionGeneration,
    backendCursor,
    remainingTurns,
    remainingItems,
    currentSerializedBytes,
  ].join("\0");
}

const historyCursorPlaceholder = "history_00000000-0000-4000-8000-000000000000";

function collectionContentBytes(value: readonly unknown[] | object): number {
  return serializedUtf8Bytes(value) - 2;
}

function appendedCollectionBytes(
  value: readonly unknown[] | object,
  currentEntries: number,
  addedEntries: number,
): number {
  if (addedEntries === 0) return 0;
  return collectionContentBytes(value) + (currentEntries > 0 ? 1 : 0);
}

function serializedBytesAfterPage(
  entry: HistoryCursorEntry,
  page: HistoryPage,
  nextHistory: ConversationHistoryWindow,
): number {
  return (
    entry.currentSerializedBytes +
    appendedCollectionBytes(
      page.orderedTurnIds,
      entry.orderedTurnCount,
      page.orderedTurnIds.length,
    ) +
    appendedCollectionBytes(
      page.turnsById,
      entry.turnRecordCount,
      Object.keys(page.turnsById).length,
    ) +
    appendedCollectionBytes(
      page.forksByTurnId,
      entry.forkRecordCount,
      Object.keys(page.forksByTurnId).length,
    ) +
    appendedCollectionBytes(
      page.itemsById,
      entry.itemRecordCount,
      Object.keys(page.itemsById).length,
    ) +
    serializedUtf8Bytes(nextHistory) -
    entry.currentHistoryBytes
  );
}

/**
 * Application-owned history boundary and cursor registry.
 *
 * Driver cursors never cross this boundary. Browsers receive random,
 * short-lived application cursors that are scoped to one owner, thread, and
 * projection generation. The bounded registry also makes stale cursors fail
 * closed after a process restart instead of leaking backend-native details.
 */
export class ThreadHistoryService {
  readonly #inventory: ThreadApplicationInventoryReader;
  readonly #maximumCursors: number;
  readonly #cursorLifetimeMilliseconds: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, HistoryCursorEntry>();
  readonly #tokensByBoundary = new Map<string, string>();
  #runtimes?: ThreadRuntimeCoordinator;

  readonly #usage: Pick<UsageService, "registerVisibleTurns">;
  constructor(input: {
    readonly usage: Pick<UsageService, "registerVisibleTurns">;
    readonly inventory: ThreadApplicationInventoryReader;
    readonly maximumCursors?: number;
    readonly cursorLifetimeMilliseconds?: number;
    readonly now?: () => number;
  }) {
    this.#usage = input.usage;
    this.#inventory = input.inventory;
    this.#maximumCursors = input.maximumCursors ?? DEFAULT_MAXIMUM_CURSORS;
    this.#cursorLifetimeMilliseconds =
      input.cursorLifetimeMilliseconds ?? DEFAULT_CURSOR_LIFETIME_MILLISECONDS;
    this.#now = input.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#maximumCursors) ||
      this.#maximumCursors <= 0 ||
      !Number.isSafeInteger(this.#cursorLifetimeMilliseconds) ||
      this.#cursorLifetimeMilliseconds <= 0
    ) {
      throw new Error("thread_history_configuration_invalid");
    }
  }

  bindRuntimes(runtimes: ThreadRuntimeCoordinator): void {
    if (this.#runtimes) {
      throw new Error("thread_history_runtimes_already_bound");
    }
    this.#runtimes = runtimes;
  }

  window(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState | undefined,
    snapshot: NormalizedThreadSnapshot,
  ): ConversationHistoryWindow {
    if (
      !this.#runtimes ||
      !state?.history?.operational ||
      !state.history.previousCursor ||
      state.timeline.orderedTurnIds.length >=
        MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      Object.keys(state.timeline.itemsById).length >=
        MAXIMUM_NORMALIZED_TIMELINE_ITEMS
    ) {
      return { hasOlder: false };
    }
    const history = {
      hasOlder: true as const,
      olderCursor: historyCursorPlaceholder,
    };
    const currentSerializedBytes = serializedUtf8Bytes({
      ...snapshot,
      history,
    });
    if (currentSerializedBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) {
      return { hasOlder: false };
    }
    return {
      hasOlder: true,
      olderCursor: this.#register(
        scope,
        applicationThreadId,
        state.timeline.generation,
        state.history.previousCursor,
        MAXIMUM_NORMALIZED_TIMELINE_TURNS -
          state.timeline.orderedTurnIds.length,
        MAXIMUM_NORMALIZED_TIMELINE_ITEMS -
          Object.keys(state.timeline.itemsById).length,
        currentSerializedBytes,
        serializedUtf8Bytes(history),
        state.timeline.orderedTurnIds.length,
        Object.keys(state.timeline.turnsById).length,
        Object.keys(snapshot.forksByTurnId).length,
        Object.keys(state.timeline.itemsById).length,
      ),
    };
  }

  operational(state: ConversationActorSnapshotState | undefined): boolean {
    return (
      state?.history?.operational === true &&
      Boolean(this.#runtimes) &&
      state.timeline.orderedTurnIds.length <
        MAXIMUM_NORMALIZED_TIMELINE_TURNS &&
      Object.keys(state.timeline.itemsById).length <
        MAXIMUM_NORMALIZED_TIMELINE_ITEMS
    );
  }

  async loadOlder(
    scope: RequestScope,
    applicationThreadId: string,
    applicationCursor: string,
    limit: LoadThreadHistoryRequest["limit"],
  ): Promise<ThreadEventEnvelope> {
    const authorized = await this.#inventory.getAuthorized(
      scope,
      applicationThreadId,
    );
    if (
      authorized.tenantId !== scope.tenantId ||
      authorized.ownerPrincipalId !== scope.principalId ||
      authorized.thread.id !== applicationThreadId
    ) {
      throw new Error("thread_history_scope_mismatch");
    }
    const runtimes = this.#runtimes;
    if (!runtimes) {
      throw new DomainError(
        "runtime_unavailable",
        "Conversation history is not available.",
        true,
      );
    }
    this.#prune();
    const entry = this.#entries.get(applicationCursor);
    if (
      !entry ||
      entry.expiresAt <= this.#now() ||
      entry.tenantId !== scope.tenantId ||
      entry.principalId !== scope.principalId ||
      entry.applicationThreadId !== applicationThreadId
    ) {
      throw new DomainError(
        "cursor_invalid",
        "The conversation history cursor is stale or invalid.",
      );
    }
    if (entry.acceptedLimit !== undefined && entry.acceptedLimit !== limit) {
      throw new DomainError(
        "cursor_invalid",
        "The conversation history cursor was already used with another page size.",
      );
    }
    entry.acceptedLimit = limit;
    if (entry.result) {
      return entry.result;
    }
    if (!entry.pending) {
      entry.pending = this.#fetch(
        runtimes,
        scope,
        applicationThreadId,
        entry,
        limit,
      ).finally(() => {
        entry.pending = undefined;
        if (!entry.result) {
          entry.acceptedLimit = undefined;
        }
      });
    }
    return entry.pending;
  }

  /**
   * Resolves one normalized turn without extending the browser's bounded live
   * timeline window. The scan remains behind the actor/projector boundary, so
   * backend cursors and turn identities never cross into the shared protocol.
   */
  async seekTurn(
    scope: RequestScope,
    applicationThreadId: string,
    targetTurnId: string,
  ): Promise<ThreadHistorySeekResult> {
    const authorized = await this.#inventory.getAuthorized(
      scope,
      applicationThreadId,
    );
    if (
      authorized.tenantId !== scope.tenantId ||
      authorized.ownerPrincipalId !== scope.principalId ||
      authorized.thread.id !== applicationThreadId
    ) {
      throw new Error("thread_history_scope_mismatch");
    }
    const runtimes = this.#runtimes;
    if (!runtimes) {
      throw new DomainError(
        "runtime_unavailable",
        "Conversation history is not available.",
        true,
      );
    }
    const runtime = await runtimes.acquire(scope, applicationThreadId);
    try {
      const state = await runtime.actor.captureSnapshotState();
      const currentTurn = state.timeline.turnsById[targetTurnId];
      if (currentTurn) {
        this.#usage.registerVisibleTurns(scope, applicationThreadId, [currentTurn]);
        const forkSource = projectedThreadForkSourceCapability({
          branching: state.backendCapabilities.branching,
          sourceRunState: state.timeline.runState,
        });
        return threadHistorySeekResultSchema.parse({
          status: "found",
          targetTurnId,
          page: {
            orderedTurnIds: [targetTurnId],
            turnsById: { [targetTurnId]: currentTurn },
            forkSource,
            forksByTurnId: {
              [targetTurnId]: projectedTurnForkCapability({
                turn: currentTurn,
                branching: state.backendCapabilities.branching,
                sourceRunState: state.timeline.runState,
              }),
            },
            itemsById: Object.fromEntries(
              currentTurn.orderedItemIds.map((itemId) => [
                itemId,
                state.timeline.itemsById[itemId]!,
              ]),
            ),
          },
        });
      }
      if (!state.history?.operational) {
        return threadHistorySeekResultSchema.parse({
          status: "unavailable",
          targetTurnId,
          reason: {
            text: "This backend does not expose older normalized history for message lookup.",
          },
          retryable: false,
        });
      }
      const located = await runtime.actor.locateTurn({
        targetTurnId,
        maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES,
      });
      if (located.status === "found") {
        this.#usage.registerVisibleTurns(scope, applicationThreadId, Object.values(located.page.turnsById));
        return threadHistorySeekResultSchema.parse({
          status: "found",
          targetTurnId,
          page: located.page,
        });
      }
      if (located.status === "search_limit_reached") {
        return threadHistorySeekResultSchema.parse({
          status: "unavailable",
          targetTurnId,
          reason: {
            text: "The selected message is deeper than the bounded source search.",
          },
          retryable: false,
        });
      }
      return threadHistorySeekResultSchema.parse({
        status: "not_found",
        targetTurnId,
      });
    } finally {
      runtime.release();
    }
  }

  async #fetch(
    runtimes: ThreadRuntimeCoordinator,
    scope: RequestScope,
    applicationThreadId: string,
    entry: HistoryCursorEntry,
    limit: LoadThreadHistoryRequest["limit"],
  ): Promise<ThreadEventEnvelope> {
    const runtime = await runtimes.acquire(scope, applicationThreadId);
    try {
      let requestedLimit = Math.min(limit, entry.remainingTurns);
      let page: HistoryPage | undefined;
      while (!page) {
        const capture = await runtime.actor.history({
          cursor: entry.backendCursor,
          limit: requestedLimit,
        });
        if (capture.generation !== entry.projectionGeneration) {
          throw new DomainError(
            "cursor_invalid",
            "The conversation changed while earlier history was loading.",
          );
        }
        if (
          capture.page.previousCursor &&
          (capture.page.previousCursor === entry.backendCursor ||
            capture.page.orderedTurnIds.length === 0)
        ) {
          throw new DomainError(
            "runtime_unavailable",
            "The backend history cursor did not make forward progress.",
          );
        }
        const pageTurns = capture.page.orderedTurnIds.length;
        const pageItems = Object.keys(capture.page.itemsById).length;
        const remainingTurns = entry.remainingTurns - pageTurns;
        const remainingItems = entry.remainingItems - pageItems;
        const withinCountBudget = remainingTurns >= 0 && remainingItems >= 0;
        const mayContinue =
          withinCountBudget &&
          Boolean(capture.page.previousCursor) &&
          remainingTurns > 0 &&
          remainingItems > 0;
        const desiredHistory: ConversationHistoryWindow = mayContinue
          ? {
              hasOlder: true,
              olderCursor: historyCursorPlaceholder,
            }
          : { hasOlder: false };
        const parsedCandidate = safeParseHistoryPageStructure({
          ...capture.page,
          previousCursor: undefined,
        });
        if (!parsedCandidate.success || pageTurns > requestedLimit) {
          throw new DomainError(
            "runtime_unavailable",
            "The backend returned an invalid history page for the requested page size.",
          );
        }
        const candidateBytes = withinCountBudget
          ? serializedBytesAfterPage(
              entry,
              parsedCandidate.data,
              desiredHistory,
            )
          : Number.POSITIVE_INFINITY;
        if (
          withinCountBudget &&
          candidateBytes <= MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
        ) {
          const continueHistory = mayContinue;
          const nextCursor = continueHistory
            ? this.#register(
                scope,
                applicationThreadId,
                capture.generation,
                capture.page.previousCursor!,
                remainingTurns,
                remainingItems,
                candidateBytes,
                serializedUtf8Bytes(desiredHistory),
                entry.orderedTurnCount + pageTurns,
                entry.turnRecordCount +
                  Object.keys(capture.page.turnsById).length,
                entry.forkRecordCount +
                  Object.keys(capture.page.forksByTurnId).length,
                entry.itemRecordCount + pageItems,
              )
            : undefined;
          page = historyPageSchema.parse({
            ...parsedCandidate.data,
            ...(nextCursor ? { previousCursor: nextCursor } : {}),
          });
          break;
        }
        if (requestedLimit === 1) {
          throw new DomainError(
            "runtime_unavailable",
            "One earlier conversation turn is too large to transfer within the normalized history window.",
            true,
          );
        }
        requestedLimit = Math.max(1, Math.floor(requestedLimit / 2));
      }
      this.#usage.registerVisibleTurns(scope, applicationThreadId, Object.values(page.turnsById));
      const envelope = runtime.hub.publish({
        type: "history_prepend",
        generation: entry.projectionGeneration,
        page,
      });
      entry.result = envelope;
      return envelope;
    } finally {
      runtime.release();
    }
  }

  #register(
    scope: RequestScope,
    applicationThreadId: string,
    projectionGeneration: string,
    backendCursor: string,
    remainingTurns: number,
    remainingItems: number,
    currentSerializedBytes: number,
    currentHistoryBytes: number,
    orderedTurnCount: number,
    turnRecordCount: number,
    forkRecordCount: number,
    itemRecordCount: number,
  ): string {
    if (remainingTurns <= 0 || remainingItems < 0) {
      throw new Error("thread_history_window_capacity_exhausted");
    }
    this.#prune();
    const boundary = cursorKey(
      scope,
      applicationThreadId,
      projectionGeneration,
      backendCursor,
      String(remainingTurns),
      String(remainingItems),
      String(currentSerializedBytes),
    );
    const existing = this.#tokensByBoundary.get(boundary);
    if (existing && this.#entries.has(existing)) return existing;
    while (this.#entries.size >= this.#maximumCursors) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#remove(oldest);
    }
    const token = `history_${randomUUID()}`;
    this.#entries.set(token, {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      applicationThreadId,
      projectionGeneration,
      backendCursor,
      expiresAt: this.#now() + this.#cursorLifetimeMilliseconds,
      remainingTurns,
      remainingItems,
      currentSerializedBytes,
      currentHistoryBytes,
      orderedTurnCount,
      turnRecordCount,
      forkRecordCount,
      itemRecordCount,
    });
    this.#tokensByBoundary.set(boundary, token);
    return token;
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(token);
    }
  }

  #remove(token: string): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    this.#tokensByBoundary.delete(
      cursorKey(
        {
          tenantId: entry.tenantId,
          principalId: entry.principalId,
        },
        entry.applicationThreadId,
        entry.projectionGeneration,
        entry.backendCursor,
        String(entry.remainingTurns),
        String(entry.remainingItems),
        String(entry.currentSerializedBytes),
      ),
    );
  }
}
