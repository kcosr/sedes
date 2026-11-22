import { ApiError } from "../api/ApiClient.js";
import { MAX_ABANDONED_INPUT_OPERATION_LOOKUP } from "../../shared/protocol/thread-input.js";

const MAX_READ_ATTEMPTS = 8;
const READ_TIMEOUT_MS = 10_000;

/** Bounded application-receipt reads, independent of provider history/streaming. */
export class SteerAbandonmentLookup {
  #key?: string;
  #operationIds: readonly string[] = [];
  #active = false;
  #disposed = false;
  #pending = false;
  #attempts = 0;
  #lastReadAt = -Infinity;
  #timer?: ReturnType<typeof setTimeout>;
  #request?: AbortController;

  constructor(readonly input: {
    readonly read: (operationIds: readonly string[], signal: AbortSignal) => Promise<{
      readonly abandonedOperationIds: readonly string[];
    }>;
    readonly retire: (operationIds: ReadonlySet<string>) => void;
  }) {}

  observe(operationIds: readonly string[], revisionKey: string, active: boolean): void {
    if (this.#disposed) return;
    if (!active || operationIds.length === 0) {
      this.suspend();
      return;
    }
    const ids = [...new Set(operationIds)];
    const key = JSON.stringify([revisionKey, ids]);
    if (this.#active && this.#key === key) return;
    this.#active = true;
    this.#key = key;
    this.#operationIds = ids;
    this.#pending = true;
    this.#attempts = 0;
    this.#clearTimer();
    this.#schedule();
  }

  suspend(): void {
    this.#active = false;
    this.#key = undefined;
    this.#operationIds = [];
    this.#pending = false;
    this.#clearTimer();
    this.#request?.abort();
  }

  dispose(): void {
    this.#disposed = true;
    this.suspend();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay = 0): void {
    if (!this.#active || this.#disposed || !this.#pending || this.#request || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#read();
    }, Math.max(delay, 250 - (Date.now() - this.#lastReadAt)));
  }

  async #read(): Promise<void> {
    if (!this.#active || this.#disposed) return;
    const controller = new AbortController();
    this.#request = controller;
    this.#pending = false;
    this.#lastReadAt = Date.now();
    const ids = this.#operationIds;
    const key = this.#key;
    let timedOut = false;
    let retryDelay = 0;
    try {
      for (let offset = 0; offset < ids.length; offset += MAX_ABANDONED_INPUT_OPERATION_LOOKUP) {
        if (controller.signal.aborted || !this.#active || this.#disposed) return;
        const batch = ids.slice(offset, offset + MAX_ABANDONED_INPUT_OPERATION_LOOKUP);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
        let result: Awaited<ReturnType<typeof this.input.read>>;
        try {
          result = await this.input.read(batch, controller.signal);
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted || !this.#active || this.#disposed) return;
        if (new Set(result.abandonedOperationIds).size !== result.abandonedOperationIds.length ||
            result.abandonedOperationIds.some(id => !batch.includes(id))) {
          throw new Error("abandoned_input_operation_identity_mismatch");
        }
        // Explicit abandonment is monotonic. Omitted IDs prove nothing, and
        // neither queue absence nor a newer projection may retire an input.
        if (result.abandonedOperationIds.length) this.input.retire(new Set(result.abandonedOperationIds));
      }
      this.#attempts = 0;
    } catch (error) {
      if (this.#key === key && this.#active && !this.#disposed &&
          (!controller.signal.aborted || timedOut)) {
        // Protocol/validation and explicit non-retryable failures wait for a
        // new authoritative observation. Transport retries are bounded too.
        const retryable = timedOut || (error instanceof ApiError ? error.retryable : error instanceof TypeError);
        this.#pending = retryable && ++this.#attempts < MAX_READ_ATTEMPTS;
        if (this.#pending) retryDelay = Math.min(1_000 * 2 ** Math.min(this.#attempts - 1, 5), 30_000);
      }
    } finally {
      if (this.#request === controller) this.#request = undefined;
      this.#schedule(retryDelay);
    }
  }
}
