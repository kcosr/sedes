export type AutomationResourceReadPhase = "active" | "deleting" | "deleted";

/** One selected identity owns all its definition/history reads and deletion. */
export class AutomationResourceReads {
  #phase: AutomationResourceReadPhase = "active";
  readonly #requests = new Set<AbortController>();
  readonly #listeners = new Set<() => void>();

  getSnapshot = (): AutomationResourceReadPhase => this.#phase;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  begin(): AbortController {
    const controller = new AbortController();
    if (this.#phase !== "active") controller.abort();
    else this.#requests.add(controller);
    return controller;
  }

  release(controller: AbortController): void {
    this.#requests.delete(controller);
  }

  #change(phase: AutomationResourceReadPhase): void {
    this.#phase = phase;
    if (phase !== "active") {
      for (const controller of this.#requests) controller.abort();
      this.#requests.clear();
    }
    for (const listener of this.#listeners) listener();
  }

  markDeleted(): void {
    if (this.#phase !== "deleted") this.#change("deleted");
  }

  async remove(work: () => Promise<unknown>): Promise<void> {
    if (this.#phase === "deleted") return;
    if (this.#phase === "deleting") throw new Error("This automation is already being deleted.");
    this.#change("deleting");
    try {
      await work();
    } catch (reason) {
      if (this.getSnapshot() === "deleting") this.#change("active");
      throw reason;
    }
    this.markDeleted();
  }
}
