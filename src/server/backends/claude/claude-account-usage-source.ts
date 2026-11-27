import { MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS, type BackendAccountUsage } from "../../../shared/protocol/account-usage.js";
import type { BackendAccountUsageSource } from "../backend-account-usage.js";
import type { ClaudeRuntimeClient } from "./claude-runtime-client.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const REATTACH_RETRY_MS = 5_000;

interface AttachedClaudeQuery {
  readonly applicationThreadId: string;
  readonly sessionId: string;
  readonly startupProbeUuid: string;
}

type VerifiedAccountUsage = BackendAccountUsage & { eligibleThreadIds: string[] };

/** One subscription observation per backend. Only admitted conversations drive reads. */
export class ClaudeAccountUsageSource implements BackendAccountUsageSource {
  readonly supported = true;
  readonly #listeners = new Set<() => void>();
  #snapshot: VerifiedAccountUsage | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #request: AbortController | undefined;
  #nextReadAt = 0;
  readonly #attachments = new Map<string, AttachedClaudeQuery>();
  #closed = false;

  constructor(private readonly runtime: Pick<ClaudeRuntimeClient, "readAccountUsage">) {}

  snapshot(): BackendAccountUsage | null { return this.#snapshot; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  retain(query: AttachedClaudeQuery): () => void {
    if (this.#closed) return () => undefined;
    const { applicationThreadId } = query;
    const attachment = { ...query };
    this.#attachments.set(applicationThreadId, attachment);
    this.#removeEligibility(applicationThreadId);
    this.#schedule();
    return () => {
      if (this.#attachments.get(applicationThreadId) !== attachment) return;
      this.#attachments.delete(applicationThreadId);
      this.#removeEligibility(applicationThreadId);
      if (!this.#attachments.size) this.#cancel();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#attachments.clear();
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
    if (this.#closed || !this.#attachments.size || this.#timer || this.#request) return;
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
    const attachments = [...this.#attachments.values()];
    let usage: VerifiedAccountUsage | null = null;
    try {
      const observation = await this.runtime.readAccountUsage(request.signal);
      if (observation) {
        const verified = new Map(observation.verifiedSessions.map(session => [session.sessionId, session.startupProbeUuid]));
        const eligibleThreadIds = attachments.filter(query =>
          this.#attachments.get(query.applicationThreadId) === query && verified.get(query.sessionId) === query.startupProbeUuid,
        ).map(query => query.applicationThreadId);
        if (eligibleThreadIds.length > 0 && eligibleThreadIds.length <= MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS) {
          // Main observed the reply now. Remote worker clocks can differ.
          usage = { ...observation.usage, capturedAt: Date.now(), eligibleThreadIds, reportedBy: "Claude Code" };
        }
      }
    } catch {
      // Optional provider observations may fail independently of the conversation.
    } finally {
      if (!request.signal.aborted) this.#publish(usage);
      this.#request = undefined;
      this.#schedule();
    }
  }

  #removeEligibility(threadId: string): void {
    const usage = this.#snapshot;
    if (!usage?.eligibleThreadIds.includes(threadId)) return;
    const eligibleThreadIds = usage.eligibleThreadIds.filter(id => id !== threadId);
    this.#publish(eligibleThreadIds.length ? { ...usage, eligibleThreadIds } : null);
  }

  #publish(usage: VerifiedAccountUsage | null): void {
    if (usage === null && this.#snapshot === null) return;
    this.#snapshot = usage;
    for (const listener of [...this.#listeners]) {
      try { listener(); }
      catch { /* Presentation listeners cannot change provider lifecycle. */ }
    }
  }
}
