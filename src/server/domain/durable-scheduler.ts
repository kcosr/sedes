import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

const MAX_TIMEOUT_MS = 2_147_000_000;
const RECONCILE_ERROR_BACKOFF_MS = 1_000;

export interface DurableDeadlineSource {
  getNearestDeadline(): number | null;
  reconcileDue(now: number): void | Promise<void>;
}

/**
 * Owns the process's single durable-deadline alarm.
 *
 * Sources are reconciled in declaration order, which makes equal-deadline
 * ordering explicit without combining their persistence or state machines.
 */
export class DurableScheduler {
  readonly #sources: readonly DurableDeadlineSource[];
  readonly #clock: Clock;
  readonly #onError: (error: unknown) => void;
  #handle: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #generation = 0;
  #reconcilePromise: Promise<void> | null = null;
  #reconcileRequested = false;
  #reconcileHadError = false;

  constructor(
    sources: readonly DurableDeadlineSource[],
    options: {
      clock?: Clock;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    if (sources.length === 0) {
      throw new Error("DurableScheduler requires at least one deadline source.");
    }
    this.#sources = sources;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#requestReconcile();
  }

  rearm(): void {
    if (!this.#running) return;
    this.#clear();
    if (this.#reconcilePromise) {
      this.#reconcileRequested = true;
      return;
    }
    this.#arm();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#reconcileRequested = false;
    this.#clear();
    await this.#reconcilePromise;
  }

  #requestReconcile(): void {
    if (!this.#running) return;
    this.#clear();
    if (this.#reconcilePromise) {
      this.#reconcileRequested = true;
      return;
    }
    this.#reconcilePromise = this.#reconcile()
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#reconcilePromise = null;
        if (!this.#running) return;
        if (this.#reconcileRequested) {
          this.#reconcileRequested = false;
          this.#requestReconcile();
          return;
        }
        this.#arm();
      });
  }

  async #reconcile(): Promise<void> {
    const now = this.#clock.now();
    this.#reconcileHadError = false;
    for (const source of this.#sources) {
      try {
        await source.reconcileDue(now);
      } catch (error) {
        this.#reconcileHadError = true;
        this.#onError(error);
      }
    }
  }

  #arm(): void {
    let deadline: number | null = null;
    for (const source of this.#sources) {
      const candidate = source.getNearestDeadline();
      if (candidate !== null && (deadline === null || candidate < deadline)) {
        deadline = candidate;
      }
    }
    if (deadline === null) return;
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        this.#reconcileHadError ? RECONCILE_ERROR_BACKOFF_MS : 0,
        deadline - this.#clock.now(),
      ),
    );
    const generation = ++this.#generation;
    this.#handle = this.#clock.setTimeout(() => {
      if (!this.#running || generation !== this.#generation) return;
      this.#handle = null;
      this.#requestReconcile();
    }, delay);
  }

  #clear(): void {
    this.#generation += 1;
    if (this.#handle !== null) {
      this.#clock.clearTimeout(this.#handle);
      this.#handle = null;
    }
  }
}
