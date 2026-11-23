/** Current drivers serve new requests. Existing handles and in-flight calls retain
 * their originating drivers, which the module must still close on shutdown. */
export class ConnectionDriverCache<T extends object> {
  readonly #current = new Map<string, T>();
  readonly #superseded = new Set<WeakRef<T>>();

  get(connectionId: string): T | undefined {
    return this.#current.get(connectionId);
  }

  set(connectionId: string, driver: T): void {
    const previous = this.#current.get(connectionId);
    if (previous && previous !== driver) {
      for (const reference of this.#superseded) {
        if (!reference.deref()) this.#superseded.delete(reference);
      }
      this.#superseded.add(new WeakRef(previous));
    }
    this.#current.set(connectionId, driver);
  }

  *values(): IterableIterator<T> {
    yield* this.#current.values();
    for (const reference of this.#superseded) {
      const driver = reference.deref();
      if (driver) yield driver;
    }
  }

  clear(): void {
    this.#current.clear();
    this.#superseded.clear();
  }
}
