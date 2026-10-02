import { randomUUID } from "node:crypto";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendCapabilityDocument } from "../../../shared/protocol/backend.js";
import { BackendError,
  type ConversationHistoryReader, type EstablishProjectionInput, type HistoryPageInput, type LocateTurnInput,
} from "../contracts.js";
import {
  ClaudeHistoryProjectionError, locateClaudeHistoryTurn, projectClaudeHistory,
  projectClaudeHistoryPageAtIndex, type ClaudeHistoryAuthentication,
} from "./claude-history-projector.js";
import type { ClaudeTerminalReceiptOverride } from "./claude-history-projector.js";
import { CLAUDE_VIEWED_IMAGE_INLINE_BUDGET, type ClaudeViewedImagePublications } from "./claude-viewed-images.js";

/** One immutable native transcript acquisition; never creates a Claude query. */
export class ClaudeHistoryReader implements ConversationHistoryReader {
  readonly #controller = new AbortController();
  readonly #nonce = randomUUID();
  #messages?: Promise<readonly SessionMessage[]>;

  constructor(readonly input: {
    load(): Promise<SessionMessage[]>;
    readonly terminalReceipts: readonly ClaudeTerminalReceiptOverride[];
    readonly authentication: ClaudeHistoryAuthentication;
    readonly viewedImages: ClaudeViewedImagePublications;
    mapError(error: unknown): Error;
    onClosed(): void;
  }) {}

  async readSnapshot(input: EstablishProjectionInput) {
    return this.#run(input.signal, async signal => {
      const messages = await this.#load(signal);
      const project = () => projectClaudeHistory(messages, this.input.terminalReceipts, this.input.authentication);
      let projection = project();
      if (await this.input.viewedImages.publish(projection.pendingViewedImages, CLAUDE_VIEWED_IMAGE_INLINE_BUDGET, signal)) {
        projection = project();
      }
      const before = projection.window.latestStartTurnIndex;
      return { snapshot: projection.snapshot, history: { operational: true,
        ...(before > 0 ? { previousCursor: this.#cursor(before) } : {}) } };
    });
  }

  async history(input: HistoryPageInput) {
    return this.#run(input.signal, async signal => {
      const before = input.cursor === undefined ? undefined : this.#parseCursor(input.cursor);
      const messages = await this.#load(signal);
      const select = () => projectClaudeHistoryPageAtIndex(messages, {
        before, limit: input.limit, terminalReceipts: this.input.terminalReceipts,
        authentication: this.input.authentication,
      });
      let selected = select();
      if (await this.input.viewedImages.publish(selected.pendingViewedImages, CLAUDE_VIEWED_IMAGE_INLINE_BUDGET, signal)) {
        selected = select();
      }
      return { ...selected.page, ...(selected.previousTurnIndex === undefined
        ? {} : { previousCursor: this.#cursor(selected.previousTurnIndex) }) };
    });
  }

  async locateTurn(input: LocateTurnInput) {
    return this.#run(input.signal, async signal => {
      const messages = await this.#load(signal);
      const select = () => locateClaudeHistoryTurn(messages, {
        ...input, terminalReceipts: this.input.terminalReceipts, authentication: this.input.authentication,
      });
      let result = select();
      if (result.status === "found" && await this.input.viewedImages.publish(
        result.pendingViewedImages, CLAUDE_VIEWED_IMAGE_INLINE_BUDGET, signal,
      )) result = select();
      return result.status === "found" ? { status: "found" as const, page: result.page } : result;
    });
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#controller.signal.throwIfAborted();
    return {
      revision: "claude-history-1", actions: [], deliveryModes: [], steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false }, nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
      branching: { availability: "unavailable", reason: { text: "This acquisition provides conversation history only." } },
      interactionKinds: [], usageSections: ["context", "counters"], usageAccounting: "supported",
      turnThroughput: "unsupported", effectiveSettings: {},
    };
  }

  async usage() {
    return this.#run(undefined, async signal => projectClaudeHistory(
      await this.#load(signal), this.input.terminalReceipts, this.input.authentication,
    ).usage ?? {});
  }

  async close(): Promise<void> {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(new DOMException("Conversation history was closed.", "AbortError"));
    this.#messages = undefined;
    this.input.viewedImages.close();
    this.input.onClosed();
  }

  #cursor(before: number): string { return `${this.#nonce}:${before}`; }
  #parseCursor(cursor: string): number {
    const [nonce, offset, extra] = cursor.split(":");
    if (nonce !== this.#nonce || extra !== undefined || !/^[0-9]+$/.test(offset ?? "") || !Number.isSafeInteger(Number(offset))) {
      throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
    }
    return Number(offset);
  }

  #load(signal: AbortSignal): Promise<readonly SessionMessage[]> {
    signal.throwIfAborted();
    // Failed reads can be retried, but a successful cut never changes beneath
    // an older-page cursor or targeted lookup.
    this.#messages ??= this.input.load().catch(error => { this.#messages = undefined; throw error; });
    return waitForHistory(this.#messages, signal);
  }

  async #run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(60_000);
    const cancellation = AbortSignal.any([this.#controller.signal, timeout, ...(signal ? [signal] : [])]);
    try {
      cancellation.throwIfAborted();
      const result = await waitForHistory(operation(cancellation), cancellation);
      cancellation.throwIfAborted();
      return result;
    } catch (error) {
      if (cancellation.reason === timeout.reason && timeout.aborted) {
        throw new BackendError({ category: "unavailable", retryable: true,
          crossedSubmissionBoundary: false, backendCode: "claude_history_timeout",
          safeMessage: "Claude history did not respond in time. Retry the read." }, { cause: error });
      }
      if (cancellation.aborted) throw cancellation.reason;
      throw this.input.mapError(error);
    }
  }
}

async function waitForHistory<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
