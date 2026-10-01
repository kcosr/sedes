import type { TurnThroughput } from "../../shared/protocol/turn-throughput.js";

/** A request may report zero output; only a positive turn total is displayed. */
export interface RequestThroughput {
  readonly outputTokens: number;
  readonly requestDurationMs: number;
}

export const MAXIMUM_RETAINED_TURN_THROUGHPUT = 100;

/** Owned by one conversation handle, never a durable accounting source. */
export class TurnThroughputRecorder {
  readonly #completed = new Map<string, TurnThroughput>();
  #active?: { id: string; outputTokens: number; requestDurationMs: number; complete: boolean };

  start(turnId: string): void {
    if (this.#active?.id === turnId) return;
    this.#completed.delete(turnId);
    this.#active = { id: turnId, outputTokens: 0, requestDurationMs: 0, complete: true };
  }

  record(turnId: string, request: RequestThroughput | undefined): void {
    const active = this.#active;
    // A handle attached during a turn has no complete observation of it.
    if (!active || active.id !== turnId || !active.complete) return;
    if (!request || !Number.isSafeInteger(request.outputTokens) || request.outputTokens < 0 ||
      !Number.isFinite(request.requestDurationMs) || request.requestDurationMs <= 0) {
      active.complete = false;
      return;
    }
    active.outputTokens += request.outputTokens;
    active.requestDurationMs += request.requestDurationMs;
    if (!Number.isSafeInteger(active.outputTokens) || active.requestDurationMs > Number.MAX_SAFE_INTEGER) {
      active.complete = false;
    }
  }

  invalidate(): void {
    if (this.#active) this.#active.complete = false;
  }

  finish(turnId: string, completed: boolean): void {
    const active = this.#active;
    if (!active || active.id !== turnId) return;
    this.#active = undefined;
    if (!completed || !active.complete || active.outputTokens <= 0 || active.requestDurationMs <= 0) return;
    if (!Number.isFinite(active.outputTokens / (active.requestDurationMs / 1000))) return;
    this.#completed.set(turnId, { outputTokens: active.outputTokens, requestDurationMs: active.requestDurationMs });
    if (this.#completed.size > MAXIMUM_RETAINED_TURN_THROUGHPUT) {
      this.#completed.delete(this.#completed.keys().next().value!);
    }
  }

  get(turnId: string): TurnThroughput | undefined {
    return this.#completed.get(turnId);
  }

  clear(): void {
    this.#active = undefined;
    this.#completed.clear();
  }
}
