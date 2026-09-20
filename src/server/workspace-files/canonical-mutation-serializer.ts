/**
 * Serializes filesystem mutations by their canonical destination.  One
 * instance must be shared by every capability that can publish a file in the
 * same execution environment (currently Files and workspace tools).
 */
export class CanonicalMutationSerializer {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(
    canonicalDestination: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!canonicalDestination)
      throw new Error("canonical_mutation_destination_invalid");
    const previous = this.#tails.get(canonicalDestination) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(canonicalDestination, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(canonicalDestination) === tail) {
        this.#tails.delete(canonicalDestination);
      }
    }
  }
}
