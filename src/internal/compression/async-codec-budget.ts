/** Process-wide admission for finite native codec jobs; streaming HTTP has its own limit. */
export interface AsyncCodecLease {
  release(): void;
}

interface Waiter {
  readonly resolve: (lease: AsyncCodecLease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

export class AsyncCodecBudget {
  readonly #slots: number;
  readonly #maximumWaiters: number;
  readonly #waiters = new Set<Waiter>();
  #active = 0;

  constructor(options: { readonly slots?: number; readonly maximumWaiters?: number } = {}) {
    this.#slots = options.slots ?? 2;
    this.#maximumWaiters = options.maximumWaiters ?? 128;
    if (!Number.isSafeInteger(this.#slots) || this.#slots <= 0 ||
        !Number.isSafeInteger(this.#maximumWaiters) || this.#maximumWaiters < 0) {
      throw new Error("async_codec_budget_invalid");
    }
  }

  get activeCount(): number { return this.#active; }
  get waitingCount(): number { return this.#waiters.size; }

  tryAcquire(): AsyncCodecLease | undefined {
    if (this.#active >= this.#slots || this.#waiters.size > 0) return undefined;
    return this.#lease();
  }

  acquire(signal?: AbortSignal): Promise<AsyncCodecLease> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const lease = this.tryAcquire();
    if (lease) return Promise.resolve(lease);
    if (this.#waiters.size >= this.#maximumWaiters) {
      return Promise.reject(new Error("async_codec_waiter_limit_exceeded"));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          if (!this.#waiters.delete(waiter)) return;
          signal?.removeEventListener("abort", waiter.abort);
          reject(signal?.reason);
        },
      };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  #lease(): AsyncCodecLease {
    this.#active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        const waiter = this.#waiters.values().next().value as Waiter | undefined;
        if (!waiter) return;
        this.#waiters.delete(waiter);
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.resolve(this.#lease());
      },
    };
  }
}

export const asyncCodecBudget = new AsyncCodecBudget();
