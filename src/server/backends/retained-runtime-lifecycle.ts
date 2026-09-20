/** Backend-scoped residency, independent of operator enable/stop state. A
 * retained conversation holds a lease through cleanup; short operations hold
 * leases for their entire semantic operation, including paginated reads. */
export class RetainedRuntimeLifecycle {
  #users = 0;
  #idleRequested = false;
  #retiring: Promise<void> | undefined;
  #failure: unknown;
  #waking: Promise<void> | undefined;

  constructor(readonly input: {
    wake(): void | Promise<void>;
    retire(): Promise<void>;
    onRetirementError?(error: unknown): void;
  }) {}

  retain(): { release(evicted?: boolean): Promise<void> } {
    this.#users++;
    let released: Promise<void> | undefined;
    return { release: (evicted = false) => {
      if (released) return released;
      this.#users--;
      this.#idleRequested ||= evicted;
      released = this.#retireIfUnused();
      return released;
    } };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const lease = this.retain();
    try {
      if (this.#retiring) await this.#retiring;
      if (this.#failure !== undefined) throw this.#failure;
      const waking = this.#waking ?? this.input.wake();
      if (waking) {
        this.#waking = waking;
        try { await waking; }
        finally { if (this.#waking === waking) this.#waking = undefined; }
      }
      return await operation();
    } finally {
      // Retirement must not replace an authoritative operation result with
      // an unrelated cleanup error. The failed owner remains fenced.
      await lease.release().catch(error => {
        try { this.input.onRetirementError?.(error); }
        catch { /* Diagnostics cannot change the authoritative result. */ }
      });
    }
  }

  async #retireIfUnused(): Promise<void> {
    if (this.#users || !this.#idleRequested) return;
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#retiring) return await this.#retiring;
    const retiring = Promise.resolve().then(async () => {
      if (this.#users) return;
      // Once eviction has emptied this runtime, subsequent short operations
      // also release it when done. A new conversation keeps it resident.
      try { await this.input.retire(); }
      catch (error) { this.#failure = error; throw error; }
    });
    this.#retiring = retiring;
    try { await retiring; }
    finally { if (this.#retiring === retiring) this.#retiring = undefined; }
  }
}
