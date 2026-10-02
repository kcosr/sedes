import { randomBytes } from "node:crypto";
import type { BackendCapabilityDocument, BackendConversationSnapshot } from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import {
  BackendError,
  type BackendHistoryPage,
  type ConversationHistoryReader,
  type EstablishProjectionInput,
  type HistoryPageInput,
  type LocateTurnInput,
  type LocateTurnResult,
} from "../contracts.js";
import type { GrokSessionLifecycle } from "./grok-session-lifecycle.js";
import type { GrokHistoryRecord } from "./grok-history-projector.js";
import type { GrokNativeHistoryReadResult } from "./grok-native-history-reader.js";
import {
  GrokNativeHistoryProjectionError,
  decodeGrokNativeHistoryCursor,
  latestGrokNativeHistoryCursor,
  latestGrokNativeHistoryCursorsByPromptId,
  previousGrokNativeHistoryCursor,
  projectGrokNativeHistory,
  validateGrokNativeHistoryBoundary,
  validateGrokNativeHistoryFrontier,
  validateGrokNativeHistoryPage,
} from "./grok-native-history-projection.js";
import {
  locateGrokHistoryTurnWithGeneratedImages,
  projectSelectedGrokHistoryPageWithGeneratedImages,
  projectSelectedGrokLatestHistoryWithGeneratedImages,
  type GrokGeneratedImageProjectionContext,
  type GrokProviderHistoryCursorSelection,
} from "./grok-normalized-history.js";
import type { GrokSubmissionCorrelationScope } from "./grok-submission-correlation.js";

interface NativePage extends GrokProviderHistoryCursorSelection {
  readonly records: readonly GrokHistoryRecord[];
  readonly retainedCandidateCount: number;
}

interface CapturedHead {
  readonly native: NativePage;
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
}

interface GrokHistoryReaderInput {
  readonly lifecycle: GrokSessionLifecycle;
  readonly sessionId: string;
  readonly nativeNamespaceKey: string;
  readonly workspace: string;
  readonly correlation: GrokSubmissionCorrelationScope;
  readonly generatedImages: GrokGeneratedImageProjectionContext;
  readonly mapError: (error: unknown, safeMessage: string) => BackendError;
  readonly onClosed: () => void;
}

/** Reads persisted native updates through an unbound ACP process. No native
 * session is loaded, resumed, repaired, or granted agent-tool authority. */
export class GrokHistoryReader implements ConversationHistoryReader {
  readonly #input: GrokHistoryReaderInput;
  readonly #epoch = randomBytes(32).toString("base64url");
  readonly #lifetime = new AbortController();
  #head: Promise<CapturedHead> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(input: GrokHistoryReaderInput) {
    this.#input = input;
  }

  async readSnapshot(input: EstablishProjectionInput) {
    return await this.#run(input.signal, async signal => {
      const head = await this.#capture(signal);
      return {
        snapshot: structuredClone(head.snapshot),
        history: { operational: true, ...(head.previousCursor ? { previousCursor: head.previousCursor } : {}) },
      };
    });
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    return await this.#run(input.signal, async signal => {
      this.#validateLimit(input.limit);
      const head = await this.#capture(signal);
      const page = input.cursor
        ? await this.#older(input.cursor, input.limit, signal)
        : head.native;
      const projected = await projectSelectedGrokHistoryPageWithGeneratedImages(
        page.records, { ...page, limit: input.limit },
        this.#input.correlation, this.#input.generatedImages, signal,
      );
      return projected.orderedBackendTurnIds.length === 0 && page.previousCursor
        ? { ...projected, previousCursor: page.previousCursor }
        : projected;
    });
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    return await this.#run(input.signal, async signal => {
      if (!Number.isSafeInteger(input.maximumTurnCandidates) || input.maximumTurnCandidates < 1) {
        throw new BackendError({ crossedSubmissionBoundary: false, category: "rejected", safeMessage: "The Grok turn search limit is invalid.", backendCode: "grok_locate_turn_limit_invalid", retryable: false });
      }
      let remaining = input.maximumTurnCandidates;
      let page = (await this.#capture(signal)).native;
      for (;;) {
        const located = await locateGrokHistoryTurnWithGeneratedImages(
          page.records,
          { matchesBackendTurnId: input.matchesBackendTurnId, maximumTurnCandidates: remaining },
          this.#input.correlation, this.#input.generatedImages, signal,
        );
        if (located.page) return { status: "found", page: located.page };
        remaining -= Math.min(remaining, Math.max(located.inspectedTurnCount, page.retainedCandidateCount));
        if (located.inspectedTurnCount < located.retainedTurnCount) return { status: "search_limit_reached" };
        if (!page.previousCursor) return { status: "not_found" };
        if (remaining === 0) return { status: "search_limit_reached" };
        page = await this.#older(page.previousCursor, Math.min(remaining, 100), signal);
      }
    });
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#lifetime.signal.throwIfAborted();
    return {
      revision: "grok-passive-history:v1", actions: [], deliveryModes: [], steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false, providerOutputArtifacts: { nativeImage: true }, supportsHistory: true,
      branching: { availability: "unavailable", reason: boundDisplayText("Historical readers do not support branching.") },
      interactionKinds: [], usageAccounting: "unsupported", turnThroughput: "unsupported", usageSections: [], effectiveSettings: {},
    };
  }

  async usage(): Promise<UsageSnapshot> {
    this.#lifetime.signal.throwIfAborted();
    return {};
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#lifetime.abort(new BackendError({ crossedSubmissionBoundary: false, category: "invalid_state", safeMessage: "The Grok history reader is closed.", backendCode: "grok_history_reader_closed", retryable: false }));
      this.#closePromise = this.#input.lifecycle.close("grok_history_reader_closed").finally(this.#input.onClosed);
    }
    await this.#closePromise;
  }

  async #run<T>(caller: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#lifetime.signal.throwIfAborted();
    caller?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new BackendError({
      category: "unavailable", safeMessage: "Grok history loading exceeded its deadline.",
      backendCode: "grok_history_deadline", retryable: true, crossedSubmissionBoundary: false,
    })), 60_000);
    const signal = AbortSignal.any([this.#lifetime.signal, deadline.signal, ...(caller ? [caller] : [])]);
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
      throw this.#input.mapError(error, "Grok history is unavailable.");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  #validateLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GrokNativeHistoryProjectionError("grok_native_history_cursor_invalid");
    }
  }

  #capture(signal: AbortSignal): Promise<CapturedHead> {
    return this.#head ??= this.#readHead(signal);
  }

  async #readHead(signal: AbortSignal): Promise<CapturedHead> {
    // The native updates extension falls back across workspaces and treats a
    // missing file as empty. Exact native list admission distinguishes both.
    const sessions = await this.#input.lifecycle.listSessions({ signal });
    if (!sessions.some(session => session.sessionId === this.#input.sessionId && session.workspace === this.#input.workspace && session.nativeNamespaceKey === this.#input.nativeNamespaceKey)) {
      throw new BackendError({ crossedSubmissionBoundary: false, category: "not_found", safeMessage: "The Grok conversation is unavailable in this workspace.", backendCode: "grok_history_session_not_found", retryable: false });
    }
    const history = await this.#read({ turnIndex: 11 }, signal);
    const native = this.#project(history, 10);
    const projected = await projectSelectedGrokLatestHistoryWithGeneratedImages(
      native.records, native, this.#input.correlation, this.#input.generatedImages, signal,
    );
    // Pin the persisted tail that was normalized. Appends are harmless; a
    // rewrite or rewind during hydration must not become a successful cut.
    if (history.totalCount > 0) {
      const frontier = await this.#read({ offset: history.totalCount - 1, limit: 1 }, signal);
      if (JSON.stringify(frontier.updates[0]) !== JSON.stringify(history.updates.at(-1)) ||
          JSON.stringify(frontier.promptStarts.filter(offset => offset < history.totalCount)) !== JSON.stringify(history.promptStarts)) {
        throw new GrokNativeHistoryProjectionError("grok_native_history_cursor_invalid");
      }
    }
    return {
      native, ...projected,
      ...(projected.snapshot.orderedBackendTurnIds.length === 0 && native.previousCursor ? { previousCursor: native.previousCursor } : {}),
    };
  }

  #project(history: GrokNativeHistoryReadResult, retainedCompletedPromptWindow: number): NativePage {
    const projector = projectGrokNativeHistory(history, {
      nativeNamespaceKey: this.#input.nativeNamespaceKey, sessionId: this.#input.sessionId, retainedCompletedPromptWindow,
    });
    const previousCursorByPromptId = latestGrokNativeHistoryCursorsByPromptId(history, this.#epoch);
    const records = projector.records();
    const firstPrompt = records.find(record => record.identity.promptId !== undefined)?.identity.promptId;
    const previousCursor = firstPrompt
      ? previousCursorByPromptId[firstPrompt]
      : latestGrokNativeHistoryCursor(history, { epoch: this.#epoch, retainedTurns: 11 });
    const firstOffset = previousCursor
      ? decodeGrokNativeHistoryCursor(previousCursor, this.#epoch).beforeOffset
      : history.totalCount - history.updates.length;
    return {
      records, previousCursorByPromptId,
      retainedCandidateCount: history.promptStarts.filter(offset => offset >= firstOffset).length,
      ...(previousCursor ? { previousCursor } : {}),
    };
  }

  async #older(encodedCursor: string, limit: number, signal: AbortSignal): Promise<NativePage> {
    const cursor = decodeGrokNativeHistoryCursor(encodedCursor, this.#epoch);
    const overlap = await this.#read({ offset: cursor.beforeOffset, limit: 1 }, signal);
    const priorStarts = validateGrokNativeHistoryBoundary(overlap, cursor);
    if (priorStarts.length === 0) throw new GrokNativeHistoryProjectionError("grok_native_history_cursor_invalid");
    const startOffset = priorStarts[Math.max(0, priorStarts.length - limit)]!;
    const history = await this.#read({ offset: startOffset, limit: cursor.beforeOffset - startOffset }, signal);
    validateGrokNativeHistoryPage(history, { startOffset, endOffset: cursor.beforeOffset, expectedPrefixHash: cursor.promptStartsPrefixHash });
    const projector = projectGrokNativeHistory(history, {
      nativeNamespaceKey: this.#input.nativeNamespaceKey, sessionId: this.#input.sessionId, retainedCompletedPromptWindow: limit,
    });
    const previousCursor = previousGrokNativeHistoryCursor(history, {
      epoch: this.#epoch, startOffset, issuedFrontierOffset: cursor.issuedFrontierOffset, issuedFrontierDigest: cursor.issuedFrontierDigest,
    });
    const previousCursorByPromptId = latestGrokNativeHistoryCursorsByPromptId(history, this.#epoch, {
      offset: cursor.issuedFrontierOffset, digest: cursor.issuedFrontierDigest,
    }, startOffset);
    const frontier = await this.#read({ offset: cursor.issuedFrontierOffset, limit: 1 }, signal);
    validateGrokNativeHistoryFrontier(frontier, cursor);
    return {
      records: projector.records(), previousCursorByPromptId,
      retainedCandidateCount: priorStarts.filter(offset => offset >= startOffset).length,
      ...(previousCursor ? { previousCursor } : {}),
    };
  }

  async #read(selection: { readonly turnIndex?: number; readonly offset?: number; readonly limit?: number }, signal: AbortSignal): Promise<GrokNativeHistoryReadResult> {
    return await this.#input.lifecycle.connection.readNativeHistory({
      sessionId: this.#input.sessionId, cwd: this.#input.workspace, ...selection, signal,
    });
  }
}
