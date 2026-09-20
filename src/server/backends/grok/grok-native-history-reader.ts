import type {
  AcpRequestOptions,
  AcpRequestSettlement,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import {
  AcpBindingError,
  AcpDeliveryError,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";
import type {
  GrokSessionUpdatesChunk,
  GrokSessionUpdatesRequest,
  GrokSessionUpdatesResponse,
  GrokStoredSessionUpdate,
} from "./grok-acp-dialect.js";

export const GROK_NATIVE_HISTORY_ACQUISITION_DEADLINE_MILLISECONDS = 30_000;
export const GROK_NATIVE_HISTORY_ABANDONED_DRAIN_DEADLINE_MILLISECONDS = 30_000;

export type GrokNativeHistoryReadFailureCode =
  | "grok_native_history_busy"
  | "grok_native_history_aborted"
  | "grok_native_history_capacity_exceeded"
  | "grok_native_history_stream_invalid";

export class GrokNativeHistoryReadError extends Error {
  readonly code: GrokNativeHistoryReadFailureCode;
  readonly retryable: boolean;

  constructor(code: GrokNativeHistoryReadFailureCode) {
    super(code);
    this.name = "GrokNativeHistoryReadError";
    this.code = code;
    this.retryable = code !== "grok_native_history_stream_invalid";
  }
}

export interface GrokNativeHistoryReadInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly turnIndex?: number;
  readonly signal?: AbortSignal;
}

export interface GrokNativeHistoryReadResult {
  readonly updates: readonly GrokStoredSessionUpdate[];
  readonly totalCount: number;
  readonly lastEventId?: string;
  readonly promptStarts: readonly number[];
}

interface ActiveAcquisition {
  readonly sessionId: string;
  readonly updates: GrokStoredSessionUpdate[];
  retainedBytes: number;
  nextIndex: number;
  sawDone: boolean;
  failure: GrokNativeHistoryReadError | undefined;
  drainingAbandoned: boolean;
  abandonedSettlementObserved: boolean;
  abandonedDrainTimer: ReturnType<typeof setTimeout> | undefined;
  readonly progressWaiters: Set<() => void>;
}

type SessionUpdatesRequester = (
  request: GrokSessionUpdatesRequest,
  options: AcpRequestOptions,
) => Promise<AcpRequestSettlement<GrokSessionUpdatesResponse>>;

/**
 * Collects one source-ordered `_x.ai/session/updates` acquisition at a time.
 * Stream faults are latched onto that request instead of escaping a reverse
 * notification handler and fencing the provider process.
 */
export class GrokNativeHistoryReader {
  readonly #request: SessionUpdatesRequester;
  readonly #maximumRetainedBytes: number;
  readonly #abandonedDrainDeadlineMilliseconds: number;
  readonly #onAbandonedDrainTimeout: () => void;
  #active: ActiveAcquisition | undefined;
  #poisoned: GrokNativeHistoryReadError | undefined;

  constructor(input: {
    readonly request: SessionUpdatesRequester;
    readonly maximumRetainedBytes?: number;
    readonly abandonedDrainDeadlineMilliseconds?: number;
    readonly onAbandonedDrainTimeout?: () => void;
  }) {
    const maximumRetainedBytes =
      input.maximumRetainedBytes ?? MAXIMUM_PROVIDER_FRAME_BYTES;
    if (
      !Number.isSafeInteger(maximumRetainedBytes) ||
      maximumRetainedBytes <= 0
    ) {
      throw new Error("grok_native_history_capacity_invalid");
    }
    const abandonedDrainDeadlineMilliseconds =
      input.abandonedDrainDeadlineMilliseconds ??
      GROK_NATIVE_HISTORY_ABANDONED_DRAIN_DEADLINE_MILLISECONDS;
    if (
      !Number.isSafeInteger(abandonedDrainDeadlineMilliseconds) ||
      abandonedDrainDeadlineMilliseconds <= 0
    ) {
      throw new Error("grok_native_history_drain_deadline_invalid");
    }
    this.#request = input.request;
    this.#maximumRetainedBytes = maximumRetainedBytes;
    this.#abandonedDrainDeadlineMilliseconds =
      abandonedDrainDeadlineMilliseconds;
    this.#onAbandonedDrainTimeout =
      input.onAbandonedDrainTimeout ?? (() => undefined);
  }

  get acquiring(): boolean {
    return this.#active !== undefined;
  }

  async read(
    input: GrokNativeHistoryReadInput,
  ): Promise<GrokNativeHistoryReadResult> {
    if (this.#poisoned) throw this.#poisoned;
    if (this.#active) {
      throw new GrokNativeHistoryReadError("grok_native_history_busy");
    }
    if (input.signal?.aborted) {
      throw new GrokNativeHistoryReadError("grok_native_history_aborted");
    }
    const active: ActiveAcquisition = {
      sessionId: input.sessionId,
      updates: [],
      retainedBytes: 2,
      nextIndex: 0,
      sawDone: false,
      failure: undefined,
      drainingAbandoned: false,
      abandonedSettlementObserved: false,
      abandonedDrainTimer: undefined,
      progressWaiters: new Set(),
    };
    this.#active = active;
    const acquisitionDeadline = AbortSignal.timeout(
      GROK_NATIVE_HISTORY_ACQUISITION_DEADLINE_MILLISECONDS,
    );
    const cancellationSignal = input.signal
      ? AbortSignal.any([input.signal, acquisitionDeadline])
      : acquisitionDeadline;
    try {
      let response: GrokSessionUpdatesResponse;
      try {
        const settlement = await this.#request(
          {
            sessionId: input.sessionId,
            cwd: input.cwd,
            ...(input.offset !== undefined ? { offset: input.offset } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.turnIndex !== undefined
              ? { turnIndex: input.turnIndex }
              : {}),
            stream: true,
            chunkSize: 1,
          },
          {
            cancellationSignal,
            abandonOnCancellation: true,
            onAbandonedSettlement: () => {
              active.abandonedSettlementObserved = true;
              if (this.#active === active && active.drainingAbandoned) {
                this.#releaseActive(active);
              }
            },
            deadlineMilliseconds: null,
          },
        );
        // The reviewed source queues every chunk before the response, but its
        // fire-and-forget forwarding can deliver those chunks afterward. Keep
        // this acquisition active through the same-key cutover and the exact
        // advertised stream end so a late tail cannot enter a successor read.
        response = await settlement.commitNotificationCutover(() => {
          if (settlement.kind === "remote_error") throw settlement.error;
          return settlement.response;
        });
        if (cancellationSignal.aborted) {
          this.#beginAbandonedDrain(active, true);
          throw new GrokNativeHistoryReadError("grok_native_history_aborted");
        }
      } catch (error) {
        if (
          error instanceof AcpDeliveryError &&
          error.code === "acp_binding_request_cancelled"
        ) {
          this.#beginAbandonedDrain(
            active,
            error.delivery === "sent_outcome_unknown",
          );
          throw new GrokNativeHistoryReadError("grok_native_history_aborted");
        }
        if (
          error instanceof AcpBindingError &&
          error.code === "acp_binding_overloaded"
        ) {
          throw new GrokNativeHistoryReadError("grok_native_history_busy");
        }
        throw error;
      }
      try {
        await this.#awaitStreamCompletion(
          active,
          response.chunkCount,
          cancellationSignal,
        );
      } catch (error) {
        if (
          error instanceof GrokNativeHistoryReadError &&
          error.code === "grok_native_history_aborted"
        ) {
          this.#beginAbandonedDrain(active, true);
        }
        throw error;
      }
      if (active.failure) throw active.failure;
      return Object.freeze({
        updates: Object.freeze([...active.updates]),
        totalCount: response.totalCount,
        ...(response.lastEventId !== undefined
          ? { lastEventId: response.lastEventId }
          : {}),
        promptStarts: Object.freeze([...response.promptStarts]),
      });
    } finally {
      if (this.#active === active && !active.drainingAbandoned) {
        this.#releaseActive(active);
      }
    }
  }

  acceptChunk(chunk: GrokSessionUpdatesChunk): void {
    const active = this.#active;
    if (!active) return;
    if (active.drainingAbandoned) {
      if (
        chunk.sessionId !== active.sessionId ||
        chunk.index !== active.nextIndex
      )
        return;
      active.nextIndex += 1;
      if (chunk.done) this.#releaseActive(active);
      return;
    }
    const [update] = chunk.updates;
    if (
      chunk.updates.length !== 1 ||
      chunk.sessionId !== active.sessionId ||
      chunk.index !== active.nextIndex ||
      active.sawDone ||
      (update !== undefined && update.params.sessionId !== active.sessionId)
    ) {
      this.#latchFailure(active, "grok_native_history_stream_invalid");
    }
    active.nextIndex += 1;
    if (chunk.done) active.sawDone = true;
    if (active.failure) return;
    if (!update) {
      this.#latchFailure(active, "grok_native_history_stream_invalid");
      return;
    }
    const retainedBytes =
      Buffer.byteLength(JSON.stringify(update), "utf8") +
      (active.updates.length === 0 ? 0 : 1);
    if (active.retainedBytes + retainedBytes > this.#maximumRetainedBytes) {
      this.#latchFailure(active, "grok_native_history_capacity_exceeded");
      return;
    }
    active.retainedBytes += retainedBytes;
    active.updates.push(update);
    this.#signalProgress(active);
  }

  #latchFailure(
    active: ActiveAcquisition,
    code: GrokNativeHistoryReadFailureCode,
  ): void {
    active.failure ??= new GrokNativeHistoryReadError(code);
    active.updates.length = 0;
    active.retainedBytes = 2;
    this.#signalProgress(active);
  }

  #beginAbandonedDrain(active: ActiveAcquisition, crossed: boolean): void {
    active.updates.length = 0;
    active.retainedBytes = 2;
    active.failure = undefined;
    active.drainingAbandoned = crossed && !active.sawDone;
    if (active.abandonedSettlementObserved) {
      active.drainingAbandoned = false;
    }
    if (active.drainingAbandoned && active.abandonedDrainTimer === undefined) {
      active.abandonedDrainTimer = setTimeout(() => {
        active.abandonedDrainTimer = undefined;
        if (this.#active !== active || !active.drainingAbandoned) return;
        this.#poisoned = new GrokNativeHistoryReadError(
          "grok_native_history_stream_invalid",
        );
        this.#releaseActive(active);
        this.#onAbandonedDrainTimeout();
      }, this.#abandonedDrainDeadlineMilliseconds);
    }
  }

  #releaseActive(active: ActiveAcquisition): void {
    if (active.abandonedDrainTimer !== undefined) {
      clearTimeout(active.abandonedDrainTimer);
      active.abandonedDrainTimer = undefined;
    }
    this.#signalProgress(active);
    if (this.#active === active) this.#active = undefined;
  }

  async #awaitStreamCompletion(
    active: ActiveAcquisition,
    expectedChunkCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (active.failure) throw active.failure;
      if (
        active.nextIndex > expectedChunkCount ||
        (active.sawDone && active.nextIndex !== expectedChunkCount) ||
        (expectedChunkCount === 0 && active.sawDone) ||
        (expectedChunkCount > 0 &&
          active.nextIndex === expectedChunkCount &&
          !active.sawDone)
      ) {
        this.#latchFailure(active, "grok_native_history_stream_invalid");
        throw active.failure!;
      }
      if (active.nextIndex === expectedChunkCount) return;
      await this.#awaitProgress(active, signal);
    }
  }

  async #awaitProgress(
    active: ActiveAcquisition,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new GrokNativeHistoryReadError("grok_native_history_aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        active.progressWaiters.delete(onProgress);
        signal.removeEventListener("abort", onAbort);
      };
      const onProgress = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new GrokNativeHistoryReadError("grok_native_history_aborted"));
      };
      active.progressWaiters.add(onProgress);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #signalProgress(active: ActiveAcquisition): void {
    for (const resolve of active.progressWaiters) resolve();
    active.progressWaiters.clear();
  }
}
