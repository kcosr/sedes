/** This queue belongs to one principal. A removal reserves all affected hosts
 * atomically, before any asynchronous proof runs. Unrelated hosts stay free. */
export class ExecutionHostQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(hosts: readonly string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(hosts)].sort();
    const previous = keys.flatMap(key => this.#tails.get(key) ?? []);
    const result = Promise.all(previous).then(operation);
    const settled = result.then(() => {}, () => {});
    for (const key of keys) this.#tails.set(key, settled);
    void settled.then(() => {
      for (const key of keys) {
        if (this.#tails.get(key) === settled) this.#tails.delete(key);
      }
    });
    return result;
  }

  async drain(): Promise<void> {
    while (this.#tails.size) await Promise.all(this.#tails.values());
  }
}
