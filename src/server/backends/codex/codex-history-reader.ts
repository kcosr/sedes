import { randomUUID } from "node:crypto";
import {
  backendHistoryPageSchema,
  type BackendCapabilityDocument,
  type BackendConversationSnapshot,
} from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import {
  BackendError,
  type BackendHistoryPage,
  type ConversationHistoryReader,
  type EstablishProjectionInput,
  type HistoryPageInput,
  type LocateTurnInput,
  type LocateTurnResult,
} from "../contracts.js";
import { codexThreadReadMethod, type CodexThread } from "./codex-c1-protocol.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  codexBackendTurnId,
  type CodexHistoryItemTimestamps,
  type CodexHistoryProjection,
} from "./codex-history-projector.js";
import {
  CodexPaginatedHistoryAdapter,
  type CodexPaginatedNativePage,
} from "./codex-paginated-history-adapter.js";
import type { CodexSubmissionCorrelationScope } from "./codex-submission-correlation.js";
import { CODEX_HISTORY_TIMEOUT_MILLISECONDS } from "./codex-history-timeouts.js";

type Snapshot = Awaited<ReturnType<ConversationHistoryReader["readSnapshot"]>>;
type Projection = CodexHistoryProjection & { readonly startNativeTurnIndex: number };
type Acquisition = {
  readonly generation: number;
  readonly metadata: CodexThread;
  readonly thread: CodexThread;
  readonly snapshot: Snapshot;
  readonly paginated?: {
    readonly adapter: CodexPaginatedHistoryAdapter;
    readonly head: CodexPaginatedNativePage;
  };
};

interface CodexHistoryReaderInput {
  readonly client: CodexSharedClientFacade;
  readonly threadId: string;
  readonly correlationScope: CodexSubmissionCorrelationScope;
  readonly validateThread: (thread: CodexThread) => void;
  readonly mapError: (error: unknown) => BackendError;
  readonly project: (
    thread: CodexThread,
    beforeNativeTurnIndex: number,
    limit: number,
    signal: AbortSignal,
    itemTimestamps?: CodexHistoryItemTimestamps,
  ) => Promise<Projection>;
}

/** A bounded native-history acquisition, with no session, tool or execution authority. */
export class CodexHistoryReader implements ConversationHistoryReader {
  readonly #input: CodexHistoryReaderInput;
  readonly #lifetime = new AbortController();
  readonly #nonce = randomUUID();
  readonly #runtimeLease: { release(): Promise<void> } | undefined;
  #acquisition: Acquisition | undefined;
  #loading: Promise<Snapshot> | undefined;
  #closing: Promise<void> | undefined;

  constructor(input: CodexHistoryReaderInput) {
    this.#input = input;
    // Keep the transport generation through paging, without retaining or
    // subscribing to any native thread session.
    this.#runtimeLease = input.client.residency?.retain();
  }

  async readSnapshot(input: EstablishProjectionInput): Promise<Snapshot> {
    return await this.#run(input.signal, async (signal) => {
      if (this.#acquisition) {
        this.#assertGeneration(this.#acquisition.generation);
        return structuredClone(this.#acquisition.snapshot);
      }
      if (!this.#loading) {
        const loading = this.#capture(signal);
        this.#loading = loading;
        void loading.finally(() => {
          if (this.#loading === loading) this.#loading = undefined;
        }).catch(() => undefined);
      }
      return structuredClone(await this.#loading);
    });
  }

  async #capture(signal: AbortSignal): Promise<Snapshot> {
    const metadataReceipt = await this.#input.client.requestWithReceipt(
      codexThreadReadMethod,
      { threadId: this.#input.threadId, includeTurns: false },
      { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
    );
    const metadata = metadataReceipt.result.thread;
    this.#input.validateThread(metadata);
    this.#assertGeneration(metadataReceipt.generation);
    let thread: CodexThread;
    let paginated: Acquisition["paginated"];
    if (metadata.historyMode === "legacy") {
      const receipt = await this.#input.client.requestWithReceipt(
        codexThreadReadMethod,
        { threadId: this.#input.threadId, includeTurns: true },
        { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
      );
      this.#assertGeneration(metadataReceipt.generation, receipt.generation);
      this.#assertSource(metadata, receipt.result.thread);
      thread = receipt.result.thread;
    } else if (metadata.historyMode === "paginated") {
      const adapter = new CodexPaginatedHistoryAdapter({
        client: this.#input.client,
        thread: metadata,
        generation: metadataReceipt.generation,
        correlationScope: this.#input.correlationScope,
      });
      const head = await adapter.readDetachedHead(10, signal);
      thread = head.thread;
      paginated = { adapter, head };
    } else {
      throw historyError("incompatible_protocol", "Codex returned an unsupported history mode.", "codex_history_mode_invalid");
    }
    const projection = await this.#input.project(thread, thread.turns.length, 10, signal, paginated?.head.itemTimestamps);
    const previousCursor = paginated
      ? paginated.adapter.cursorAfterProjection(paginated.head, projection.startNativeTurnIndex)
      : this.#legacyCursor(projection.startNativeTurnIndex);
    const snapshot: Snapshot = {
      snapshot: projection.snapshot,
      history: { operational: true, ...(previousCursor ? { previousCursor } : {}) },
    };
    const acquisition: Acquisition = {
      generation: metadataReceipt.generation, metadata, thread, snapshot,
      ...(paginated ? { paginated } : {}),
    };
    if (paginated) await this.#verifySource(acquisition, signal);
    this.#assertGeneration(acquisition.generation);
    signal.throwIfAborted();
    this.#acquisition = acquisition;
    return snapshot;
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    return await this.#run(input.signal, async (signal) => {
      const acquisition = this.#established();
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
        throw historyError("rejected", "The requested Codex history page size is invalid.", "codex_history_page_limit_invalid");
      }
      const { paginated } = acquisition;
      if (!paginated) {
        const before = input.cursor === undefined
          ? acquisition.thread.turns.length
          : this.#parseLegacyCursor(input.cursor, acquisition.thread.turns.length);
        const projection = await this.#input.project(acquisition.thread, before, input.limit, signal);
        this.#assertGeneration(acquisition.generation);
        return historyPage(projection.snapshot, this.#legacyCursor(projection.startNativeTurnIndex));
      }
      let page = paginated.head;
      const cursor = input.cursor ?? (
        input.limit > page.thread.turns.length && paginated.adapter.cursorAfterProjection(page, 0)
          ? paginated.adapter.cursorAfterProjection(page, page.thread.turns.length)
          : undefined
      );
      if (cursor !== undefined) {
        await this.#verifySource(acquisition, signal);
        page = await paginated.adapter.page(cursor, input.limit, signal);
      }
      const projection = await this.#input.project(page.thread, page.thread.turns.length, input.limit, signal, page.itemTimestamps);
      if (cursor !== undefined) await this.#verifySource(acquisition, signal);
      this.#assertGeneration(acquisition.generation);
      return historyPage(projection.snapshot, paginated.adapter.cursorAfterProjection(page, projection.startNativeTurnIndex));
    });
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    return await this.#run(input.signal, async (signal) => {
      const acquisition = this.#established();
      if (!Number.isSafeInteger(input.maximumTurnCandidates) || input.maximumTurnCandidates < 1) {
        throw historyError("rejected", "The requested Codex turn lookup limit is invalid.", "codex_turn_lookup_limit_invalid");
      }
      let turn: CodexThread["turns"][number] | undefined;
      let itemTimestamps: CodexHistoryItemTimestamps | undefined;
      if (acquisition.paginated) {
        const { adapter, head } = acquisition.paginated;
        const headCursor = head.source.segments[0]?.providerCursor;
        if (headCursor === undefined) return { status: "not_found" };
        await this.#verifySource(acquisition, signal);
        const located = await adapter.locateTurn({ ...input, headCursor }, signal);
        await this.#verifySource(acquisition, signal);
        if (located.status !== "found") return located;
        turn = located.turn;
        itemTimestamps = located.itemTimestamps;
      } else {
        let examined = 0;
        for (let index = acquisition.thread.turns.length - 1; index >= 0; index--) {
          if (examined >= input.maximumTurnCandidates) return { status: "search_limit_reached" };
          examined++;
          const candidate = acquisition.thread.turns[index]!;
          if (input.matchesBackendTurnId(codexBackendTurnId(acquisition.thread.id, candidate.id))) {
            turn = candidate;
            break;
          }
        }
        if (!turn) return { status: "not_found" };
      }
      const projection = await this.#input.project({ ...acquisition.thread, turns: [turn] }, 1, 1, signal, itemTimestamps);
      this.#assertGeneration(acquisition.generation);
      const ids = projection.snapshot.orderedBackendTurnIds;
      if (ids.length === 0) return { status: "not_found" };
      if (ids.length !== 1) {
        throw historyError("incompatible_protocol", "Codex projected an invalid targeted history result.", "codex_turn_lookup_projection_invalid");
      }
      return { status: "found", page: historyPage(projection.snapshot) };
    });
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    return {
      revision: "codex-history:1",
      actions: [], deliveryModes: [], steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: true },
      supportsHistory: true,
      branching: { availability: "unavailable", reason: { text: "Branching is unavailable in a history reader." } },
      interactionKinds: [], usageAccounting: "supported", turnThroughput: "unsupported",
      usageSections: [], effectiveSettings: {},
    };
  }

  async usage(): Promise<UsageSnapshot> { this.#assertOpen(); return {}; }

  async close(): Promise<void> {
    if (!this.#closing) {
      this.#lifetime.abort(historyError("invalid_state", "The Codex history reader is closed.", "codex_history_reader_closed"));
      this.#acquisition = undefined;
      this.#closing = this.#runtimeLease?.release() ?? Promise.resolve();
    }
    await this.#closing;
  }

  #established(): Acquisition {
    if (!this.#acquisition) {
      throw historyError("invalid_state", "Codex history is not established.", "codex_history_not_established");
    }
    this.#assertGeneration(this.#acquisition.generation);
    return this.#acquisition;
  }

  #assertOpen(): void { this.#lifetime.signal.throwIfAborted(); }

  #assertGeneration(expected: number, received = expected): void {
    this.#assertOpen();
    const lifecycle = this.#input.client.lifecycleSnapshot();
    if (lifecycle.state !== "ready" || lifecycle.generation !== expected || received !== expected) {
      throw historyError("unavailable", "Codex changed generation while reading history.", "codex_history_reconciliation_required", true);
    }
  }

  #assertSource(expected: CodexThread, received: CodexThread): void {
    this.#input.validateThread(received);
    if (received.sessionId !== expected.sessionId || received.historyMode !== expected.historyMode ||
        received.updatedAt !== expected.updatedAt || JSON.stringify(received.status) !== JSON.stringify(expected.status)) {
      throw historyError("unavailable", "Codex history changed while it was being read. Reload the thread.", "codex_history_reconciliation_required", true);
    }
  }

  async #verifySource(acquisition: Acquisition, signal: AbortSignal): Promise<void> {
    this.#assertGeneration(acquisition.generation);
    const receipt = await this.#input.client.requestWithReceipt(
      codexThreadReadMethod,
      { threadId: this.#input.threadId, includeTurns: false },
      { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
    );
    this.#assertGeneration(acquisition.generation, receipt.generation);
    this.#assertSource(acquisition.metadata, receipt.result.thread);
  }

  #legacyCursor(before: number): string | undefined {
    return before > 0 ? `codex-history:${this.#nonce}:${before}` : undefined;
  }

  #parseLegacyCursor(cursor: string, turnCount: number): number {
    const match = /^codex-history:([0-9a-f-]{36}):(\d+)$/u.exec(cursor);
    const before = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== this.#nonce || !Number.isSafeInteger(before) || before <= 0 || before > turnCount) {
      throw historyError("rejected", "The Codex history cursor is invalid or stale.", "codex_history_cursor_invalid");
    }
    return before;
  }

  async #run<T>(callerSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertOpen();
    callerSignal?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(historyError("unavailable", "Codex history loading exceeded its deadline.", "codex_history_deadline", true)), CODEX_HISTORY_TIMEOUT_MILLISECONDS);
    const signal = AbortSignal.any([this.#lifetime.signal, deadline.signal, ...(callerSignal ? [callerSignal] : [])]);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([operation(signal), aborted]);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw this.#input.mapError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

function historyPage(snapshot: BackendConversationSnapshot, previousCursor?: string): BackendHistoryPage {
  return backendHistoryPageSchema.parse({
    orderedBackendTurnIds: snapshot.orderedBackendTurnIds,
    turnsById: snapshot.turnsById,
    itemsById: snapshot.itemsById,
    ...(previousCursor ? { previousCursor } : {}),
  });
}

function historyError(category: BackendError["category"], safeMessage: string, backendCode: string, retryable = false): BackendError {
  return new BackendError({ category, safeMessage, backendCode, retryable, crossedSubmissionBoundary: false });
}
