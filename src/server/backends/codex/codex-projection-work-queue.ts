const MAXIMUM_CODEX_PROJECTION_WORK_ITEMS = 1_000;

/**
 * One synchronous owner for Codex projection state. Work never awaits inside
 * the queue, so a provider notification, timer, or post-RPC install cannot
 * interleave another projection mutation halfway through an invariant update.
 */
export class CodexProjectionWorkQueue {
  readonly #pending: Array<() => void> = [];
  readonly #onOverflow: () => void;
  #draining = false;

  constructor(onOverflow: () => void) {
    this.#onOverflow = onOverflow;
  }

  enqueue(operation: () => void): void {
    if (this.#pending.length >= MAXIMUM_CODEX_PROJECTION_WORK_ITEMS) {
      this.#pending.length = 0;
      this.#onOverflow();
      return;
    }
    this.#pending.push(operation);
    this.#drain();
  }

  execute<Result>(operation: () => Result): Result {
    if (this.#draining) return operation();
    let result: Result | undefined;
    let failure: unknown;
    let completed = false;
    this.enqueue(() => {
      try {
        result = operation();
      } catch (error) {
        failure = error;
      } finally {
        completed = true;
      }
    });
    if (!completed) throw new Error("codex_projection_work_queue_overflow");
    if (failure !== undefined) throw failure;
    return result as Result;
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const operation = this.#pending.shift();
        if (!operation) return;
        operation();
      }
    } finally {
      this.#draining = false;
    }
  }
}
