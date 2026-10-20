/**
 * Single-producer, single-consumer queue whose bounds apply backpressure: the
 * producer waits for capacity instead of failing, so a burst of values that
 * arrive together never exceeds the item or byte bound.
 */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #maximumItems: number;
  readonly #maximumBytes: number;
  readonly #sizeOf: (value: T) => number;
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #capacityWaiter: (() => void) | undefined;
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

  /** Enqueues once the value fits within both bounds; rejects after close. */
  async push(value: T): Promise<void> {
    const size = this.#sizeOf(value);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("sidecar_queue_item_size_invalid");
    }
    if (size > this.#maximumBytes) {
      throw new Error("sidecar_queue_item_too_large");
    }
    if (this.#capacityWaiter) throw new Error("sidecar_queue_push_concurrent");
    while (
      !this.#closed &&
      this.#waiters.length === 0 &&
      (this.#values.length >= this.#maximumItems ||
        this.#queuedBytes + size > this.#maximumBytes)
    ) {
      await new Promise<void>((resolve) => {
        this.#capacityWaiter = resolve;
      });
    }
    if (this.#closed) throw new Error("sidecar_queue_closed");
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
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
    this.#releaseCapacityWaiter();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#claimed) throw new Error("sidecar_queue_already_consumed");
    this.#claimed = true;
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          this.#queuedBytes -= this.#sizeOf(value);
          this.#releaseCapacityWaiter();
          return { value, done: false };
        }
        if (this.#closed) {
          if (this.#error) throw this.#error;
          return { value: undefined, done: true };
        }
        return await new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
          this.#releaseCapacityWaiter();
        });
      },
    };
  }

  #releaseCapacityWaiter(): void {
    const waiter = this.#capacityWaiter;
    this.#capacityWaiter = undefined;
    waiter?.();
  }
}
