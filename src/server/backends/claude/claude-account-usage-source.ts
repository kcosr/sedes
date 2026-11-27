import { MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS, type BackendAccountUsage, type BackendAccountUsageReport } from "../../../shared/protocol/account-usage.js";
import type { BackendAccountUsageSource } from "../backend-account-usage.js";
import type { ClaudeRuntimeClient } from "./claude-runtime-client.js";
import { CLAUDE_ACCOUNT_USAGE_REFRESH_INTERVAL_MS } from "./worker/claude-runtime-v4.js";

const REATTACH_RETRY_MS = 5_000;

interface AttachedClaudeQuery {
  readonly applicationThreadId: string;
  readonly sessionId: string;
  readonly startupProbeUuid: string;
}

interface CachedObservation {
  readonly id: string;
  readonly usage: BackendAccountUsageReport;
}

type VerifiedAccountUsage = BackendAccountUsage & { eligibleThreadIds: string[] };

/** One subscription observation per backend. Only admitted conversations drive reads. */
export class ClaudeAccountUsageSource implements BackendAccountUsageSource {
  readonly supported = true;
  readonly #listeners = new Set<() => void>();
  #snapshot: VerifiedAccountUsage | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #request: { controller: AbortController; membershipOnly: boolean } | undefined;
  #cached: CachedObservation | undefined;
  #needsMembership = false;
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
    this.#needsMembership = true;
    queueMicrotask(() => this.#schedule());
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
    this.#cached = undefined;
    this.#cancel();
    this.#publish(null);
    this.#listeners.clear();
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const request = this.#request;
    if (request && !request.controller.signal.aborted) {
      if (request.membershipOnly) {
        this.#request = undefined;
      } else {
        // Reopening after an interrupted provider read may retry shortly after cleanup.
        this.#nextReadAt = Math.min(this.#nextReadAt, performance.now() + REATTACH_RETRY_MS);
      }
      request.controller.abort();
    }
  }

  #schedule(): void {
    if (this.#closed || !this.#attachments.size || (this.#request && !this.#request.membershipOnly)) return;
    const remaining = this.#nextReadAt - performance.now();
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        // A slow membership-only RPC must never postpone the next provider read.
        this.#request?.controller.abort();
        void this.#read();
      }, Math.max(0, remaining));
      this.#timer.unref();
    }
    if (remaining > 0 && this.#needsMembership && this.#cached && !this.#request) {
      void this.#read(this.#cached);
    }
  }

  async #read(cached?: CachedObservation): Promise<void> {
    const request = { controller: new AbortController(), membershipOnly: cached !== undefined };
    this.#request = request;
    this.#needsMembership = false;
    if (!cached) {
      this.#cached = undefined;
      this.#nextReadAt = performance.now() + CLAUDE_ACCOUNT_USAGE_REFRESH_INTERVAL_MS;
    }
    const attachments = [...this.#attachments.values()];
    let usage: VerifiedAccountUsage | null = null;
    try {
      const observation = await this.runtime.readAccountUsage(request.controller.signal, cached?.id);
      if (request.controller.signal.aborted) return;
      if (!cached) {
        // Main observed the fresh reply now. Remote worker clocks can differ.
        this.#cached = observation ? {
          id: observation.observationId, usage: { ...observation.usage, capturedAt: Date.now() },
        } : undefined;
      }
      if (this.#cached && observation?.observationId === this.#cached.id) {
        const verified = new Map(observation.verifiedSessions.map(session => [session.sessionId, session.startupProbeUuid]));
        const eligibleThreadIds = attachments.filter(query =>
          this.#attachments.get(query.applicationThreadId) === query && verified.get(query.sessionId) === query.startupProbeUuid,
        ).map(query => query.applicationThreadId);
        if (eligibleThreadIds.length > 0 && eligibleThreadIds.length <= MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS) {
          usage = { ...this.#cached.usage, eligibleThreadIds, reportedBy: "Claude Code" };
        }
      }
    } catch {
      // Optional provider and membership reads may fail independently of the conversation.
    } finally {
      if (this.#request === request) {
        this.#request = undefined;
        if (!request.controller.signal.aborted) this.#publish(usage);
        this.#schedule();
      }
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
