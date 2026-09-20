export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #maximumItems: number;
  readonly #maximumBytes: number;
  readonly #sizeOf: (value: T) => number;
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #queuedBytes = 0;
  #closed = false;
  #error: Error | undefined;
  #claimed = false;

  constructor(input: {
    readonly maximumItems: number;
    readonly maximumBytes: number;
    readonly sizeOf: (value: T) => number;
  }) {
    this.#maximumItems = input.maximumItems;
    this.#maximumBytes = input.maximumBytes;
    this.#sizeOf = input.sizeOf;
  }

  push(value: T): void {
    if (this.#closed) throw new Error("sidecar_queue_closed");
    const size = this.#sizeOf(value);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("sidecar_queue_item_size_invalid");
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (
      this.#values.length >= this.#maximumItems ||
      this.#queuedBytes + size > this.#maximumBytes
    ) {
      throw new Error("sidecar_queue_limit_exceeded");
    }
    this.#values.push(value);
    this.#queuedBytes += size;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (error) {
      this.#values.splice(0);
      this.#queuedBytes = 0;
    }
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#claimed) throw new Error("sidecar_queue_already_consumed");
    this.#claimed = true;
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          this.#queuedBytes -= this.#sizeOf(value);
          return { value, done: false };
        }
        if (this.#closed) {
          if (this.#error) throw this.#error;
          return { value: undefined, done: true };
        }
        return await new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
