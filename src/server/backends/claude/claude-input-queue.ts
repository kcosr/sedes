/**
 * Bounded single-consumer async iterable used as Claude's streaming input.
 * Closing wakes a pending reader and prevents later writes. The queue does not
 * claim provider acceptance; the conversation handle waits for an SDK-observed
 * user message before returning an accepted mutation result.
 */
export class ClaudeInputQueue<T> implements AsyncIterable<T> {
  readonly #capacity: number;
  readonly #queued: T[] = [];
  #waiting:
    | {
        readonly resolve: (result: IteratorResult<T>) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  #closed = false;
  #failure: unknown;
  #iteratorCreated = false;

  constructor(capacity = 16) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000) {
      throw new Error("claude_input_queue_capacity_invalid");
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#queued.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(value: T): void {
    if (this.#closed) throw new Error("claude_input_queue_closed");
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting.resolve({ done: false, value });
      return;
    }
    if (this.#queued.length >= this.#capacity) {
      throw new Error("claude_input_queue_full");
    }
    this.#queued.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iteratorCreated) {
      throw new Error("claude_input_queue_multiple_consumers");
    }
    this.#iteratorCreated = true;
    return {
      next: () => this.#next(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  #next(): Promise<IteratorResult<T>> {
    const value = this.#queued.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiting) {
      return Promise.reject(new Error("claude_input_queue_concurrent_read"));
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }
}
