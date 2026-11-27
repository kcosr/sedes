import type { BackendAccountUsage } from "../../../shared/protocol/account-usage.js";
import type { BackendAccountUsageSource } from "../backend-account-usage.js";
import type { ClaudeRuntimeClient } from "./claude-runtime-client.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const REATTACH_RETRY_MS = 5_000;

/** One subscription observation per backend. Only admitted conversations drive reads. */
export class ClaudeAccountUsageSource implements BackendAccountUsageSource {
  readonly supported = true;
  readonly #listeners = new Set<() => void>();
  #snapshot: BackendAccountUsage | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #request: AbortController | undefined;
  #nextReadAt = 0;
  #attachments = 0;
  #closed = false;

  constructor(private readonly runtime: Pick<ClaudeRuntimeClient, "readAccountUsage">) {}

  snapshot(): BackendAccountUsage | null { return this.#snapshot; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  retain(): () => void {
    if (this.#closed) return () => undefined;
    this.#attachments++;
    this.#schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#attachments--;
      if (this.#attachments === 0) this.#cancel();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancel();
    this.#publish(null);
    this.#listeners.clear();
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#request && !this.#request.signal.aborted) {
      // A detach interrupted this observation. A new attachment can retry
      // shortly after cleanup without a new quota query per transient attach.
      this.#nextReadAt = Math.min(this.#nextReadAt, performance.now() + REATTACH_RETRY_MS);
      this.#request.abort();
    }
  }

  #schedule(): void {
    if (this.#closed || !this.#attachments || this.#timer || this.#request) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#refresh();
    }, Math.max(0, this.#nextReadAt - performance.now()));
    this.#timer.unref();
  }

  async #refresh(): Promise<void> {
    const request = new AbortController();
    this.#request = request;
    this.#nextReadAt = performance.now() + REFRESH_INTERVAL_MS;
    let usage: BackendAccountUsage | null = null;
    try {
      usage = await this.runtime.readAccountUsage(request.signal);
    } catch {
      // Optional provider observations may fail independently of the conversation.
    } finally {
      if (!request.signal.aborted) {
        // Main observed the reply now. Remote worker clocks can differ.
        this.#publish(usage ? { ...usage, capturedAt: Date.now() } : null);
      }
      this.#request = undefined;
      this.#schedule();
    }
  }

  #publish(usage: BackendAccountUsage | null): void {
    if (usage === null && this.#snapshot === null) return;
    this.#snapshot = usage;
    for (const listener of [...this.#listeners]) {
      try { listener(); }
      catch { /* Presentation listeners cannot change provider lifecycle. */ }
    }
  }
}
