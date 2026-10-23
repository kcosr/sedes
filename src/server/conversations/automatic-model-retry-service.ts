import { createHash } from "node:crypto";
import {
  MODEL_FAILURE_RETRY_DELAY_MS,
  type ModelFailureRetryPolicy,
} from "../backends/model-failure-retry.js";
import type { QueuedInputRecord } from "../db/repositories/queued-input-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { reportBackgroundError } from "../report-background-error.js";

export const AUTOMATIC_MODEL_RETRY_TEXT = "Please continue from where you left off.";

export interface AutomaticModelRetryCompletion {
  readonly completionIdentity: string;
  readonly backendTurnId: string;
  readonly outcome: "completed" | "interrupted" | "failed";
  readonly provenance: "live" | "recovered";
  readonly nativeRecovery?: true;
}

export interface AutomaticModelRetryInput {
  readonly mutationId: string;
  readonly text: string;
  readonly sourceFailureIdentity: string;
  readonly backendTurnId: string;
  readonly nativeRecovery?: true;
  /** Recheck after every asynchronous admission step, immediately before commit. */
  readonly isCurrent: () => boolean;
  /** Retire the delay immediately after durable recovery admission. */
  readonly onAdmitted: () => void;
}

export interface AutomaticModelRetryScheduler {
  schedule(delayMilliseconds: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

interface PendingRetry {
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly completion: AutomaticModelRetryCompletion;
  readonly policy: ModelFailureRetryPolicy;
  timer?: unknown;
}

const defaultScheduler: AutomaticModelRetryScheduler = {
  schedule(delay, callback) {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  },
  cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

function threadKey(scope: RequestScope, threadId: string): string {
  return JSON.stringify([scope.tenantId, scope.principalId, threadId]);
}

/**
 * Adds one follow-up or native recovery after a newly observed failed turn.
 * Durable policy owns the allowance; this service owns only the cancellable
 * delay. Restart and historical replay never resurrect a delayed follow-up.
 */
export class AutomaticModelRetryService {
  readonly #resolvePolicy: (scope: RequestScope, threadId: string) => ModelFailureRetryPolicy | undefined;
  readonly #enqueue: (scope: RequestScope, threadId: string, input: AutomaticModelRetryInput) => Promise<void>;
  readonly #onPendingChanged: (scope: RequestScope, threadId: string, pending: boolean) => void;
  readonly #onError: (error: unknown) => void;
  readonly #scheduler: AutomaticModelRetryScheduler;
  readonly #pending = new Map<string, PendingRetry>();
  readonly #observedAcceptedInputs = new Map<string, { sequence: number; id: string }>();
  readonly #inflight = new Set<Promise<void>>();
  #closed = false;

  constructor(input: {
    readonly resolvePolicy: (scope: RequestScope, threadId: string) => ModelFailureRetryPolicy | undefined;
    /**
     * Owns ordinary Send admission: exact failed head, no newer/pending input,
     * no interactions or recovery, writable binding, and current revision.
     * Commit queue admission synchronously after the final isCurrent check.
     */
    readonly enqueue: (scope: RequestScope, threadId: string, input: AutomaticModelRetryInput) => Promise<void>;
    readonly onPendingChanged?: (scope: RequestScope, threadId: string, pending: boolean) => void;
    readonly onError?: (error: unknown) => void;
    readonly scheduler?: AutomaticModelRetryScheduler;
  }) {
    this.#resolvePolicy = input.resolvePolicy;
    this.#enqueue = input.enqueue;
    this.#onPendingChanged = input.onPendingChanged ?? (() => undefined);
    this.#onError = input.onError ?? reportBackgroundError("Automatic model retry");
    this.#scheduler = input.scheduler ?? defaultScheduler;
  }

  onCompletion(scope: RequestScope, threadId: string, completion: AutomaticModelRetryCompletion): void {
    if (this.#closed || completion.provenance !== "live") return;
    if (completion.outcome === "completed") {
      this.#resetAfterSuccess(scope, threadId, completion.completionIdentity);
      return;
    }
    if (completion.outcome === "interrupted") {
      this.cancel(scope, threadId);
      return;
    }
    const key = threadKey(scope, threadId);
    const previous = this.#pending.get(key);
    if (previous?.completion.completionIdentity === completion.completionIdentity) return;
    this.cancel(scope, threadId);
    const policy = this.#resolvePolicy(scope, threadId);
    if (!policy?.enabled() || !policy.claim(completion.completionIdentity)) return;
    const pending: PendingRetry = { scope, threadId, completion, policy };
    this.#pending.set(key, pending);
    pending.timer = this.#scheduler.schedule(MODEL_FAILURE_RETRY_DELAY_MS, () => {
      pending.timer = undefined;
      const operation = this.#dispatch(key, pending).catch(this.#onError);
      this.#inflight.add(operation);
      void operation.then(() => this.#inflight.delete(operation), () => this.#inflight.delete(operation));
    });
    this.#publishPending(pending, true);
  }

  /** Only a completed successful response qualifies; streaming tokens do not. */
  onModelFeedback(scope: RequestScope, threadId: string, successIdentity: string, automaticRetry: boolean): void {
    if (this.#closed || automaticRetry) return;
    this.#resetAfterSuccess(scope, threadId, successIdentity);
  }

  #resetAfterSuccess(scope: RequestScope, threadId: string, successIdentity: string): void {
    this.cancel(scope, threadId);
    this.#resolvePolicy(scope, threadId)?.reset(successIdentity);
  }

  onInputChanged(scope: RequestScope, threadId: string, item: QueuedInputRecord): void {
    if (this.#closed || item.tenantId !== scope.tenantId || item.ownerPrincipalId !== scope.principalId ||
        item.applicationThreadId !== threadId || item.inputOrigin?.kind === "automatic_retry") return;
    if (item.state === "accepted") {
      // Queue publications replay retained rows. Sequences increase within a
      // scoped thread, so one high-water mark skips an arbitrarily long replay.
      const key = threadKey(scope, threadId);
      const observed = this.#observedAcceptedInputs.get(key);
      if (observed && (item.sequence < observed.sequence ||
          (item.sequence === observed.sequence && item.id === observed.id))) return;
      const policy = this.#resolvePolicy(scope, threadId);
      if (!policy) return;
      if (policy.resetForInput(item.sequence)) this.cancel(scope, threadId);
      this.#observedAcceptedInputs.set(key, { sequence: item.sequence, id: item.id });
      if (this.#observedAcceptedInputs.size > 4_096) {
        this.#observedAcceptedInputs.delete(this.#observedAcceptedInputs.keys().next().value!);
      }
    } else if (item.state === "pending" || item.state === "retry_wait" ||
        item.state === "dispatching" || item.state === "uncertain") {
      this.cancel(scope, threadId);
    }
  }

  isPending(scope: RequestScope, threadId: string): boolean {
    return this.#pending.has(threadKey(scope, threadId));
  }

  /** Goal controls cancel native recovery without cancelling ordinary retries. */
  cancelNativeRecovery(scope: RequestScope, threadId: string): boolean {
    if (this.#pending.get(threadKey(scope, threadId))?.completion.nativeRecovery !== true) return false;
    this.cancel(scope, threadId);
    return true;
  }

  cancel(scope: RequestScope, threadId: string): void {
    const key = threadKey(scope, threadId);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    if (pending.timer !== undefined) this.#scheduler.cancel(pending.timer);
    this.#publishPending(pending, false);
  }

  /** Called after preferences or thread availability change. */
  cancelDisabled(): void {
    for (const pending of this.#pending.values()) {
      if (!pending.policy.enabled()) this.cancel(pending.scope, pending.threadId);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#pending.values()) this.cancel(pending.scope, pending.threadId);
    await Promise.allSettled([...this.#inflight]);
  }

  async #dispatch(key: string, pending: PendingRetry): Promise<void> {
    const isCurrent = () => !this.#closed && this.#pending.get(key) === pending && pending.policy.enabled();
    try {
      if (!isCurrent()) return;
      await this.#enqueue(pending.scope, pending.threadId, {
        mutationId: automaticRetryMutationId(pending.scope, pending.threadId, pending.completion.completionIdentity),
        text: AUTOMATIC_MODEL_RETRY_TEXT,
        sourceFailureIdentity: pending.completion.completionIdentity,
        backendTurnId: pending.completion.backendTurnId,
        ...(pending.completion.nativeRecovery ? { nativeRecovery: true as const } : {}),
        isCurrent,
        onAdmitted: () => {
          if (this.#pending.get(key) === pending) this.cancel(pending.scope, pending.threadId);
        },
      });
    } finally {
      if (this.#pending.get(key) === pending) this.cancel(pending.scope, pending.threadId);
    }
  }

  #publishPending(pending: PendingRetry, value: boolean): void {
    try { this.#onPendingChanged(pending.scope, pending.threadId, value); }
    catch (error) { this.#onError(error); }
  }
}

function automaticRetryMutationId(scope: RequestScope, threadId: string, failureIdentity: string): string {
  const bytes = createHash("sha256").update(JSON.stringify([
    "automatic-model-retry", scope.tenantId, scope.principalId, threadId, failureIdentity,
  ])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
