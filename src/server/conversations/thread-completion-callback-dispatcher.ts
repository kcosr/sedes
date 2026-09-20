import type { SteerTarget } from "../../shared/protocol/conversation.js";
import type { BoundedDisplayText } from "../../shared/protocol/payload.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type {
  ReadyThreadCompletionCallback,
  ThreadCompletionCallbackRepository,
} from "../db/repositories/thread-completion-callback-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "../domain/errors.js";
import { boundDisplayText, boundText } from "./payload-policy.js";
import type {
  QueueDispatchScheduler,
  QueuedInputDispatcher,
} from "./queued-input-dispatcher.js";
import type { QueuedInputConversationGateway } from "./queued-input-conversation-gateway.js";

type CallbackQueue = Pick<QueuedInputDispatcher, "enqueue">;

const retryScheduler: QueueDispatchScheduler = {
  schedule(delayMilliseconds, callback) {
    const handle = setTimeout(callback, delayMilliseconds);
    handle.unref?.();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type CallbackDeliveryPlan = {
  readonly expectedThreadRevision: number;
  readonly sourceThreadLabel: BoundedDisplayText;
  readonly requestedDeliveryMode: "submit" | "queue" | "steer";
  readonly requestedSteerTarget?: SteerTarget;
  readonly resolvedDeliveryMode: "submit" | "queue" | "steer";
  readonly resolvedSteerTarget?: SteerTarget;
};

function callbackText(
  label: BoundedDisplayText,
  ready: ReadyThreadCompletionCallback,
): string {
  const result = ready.result.text.trim();
  const body = result.length > 0 ? result : "No assistant text was produced.";
  return boundText(
    `Agent result from ${label.text} (${ready.outcome}):\n\n${body}`,
  ).text;
}

/**
 * Converts finalized completion obligations into the existing durable input
 * queue. The queue remains the only owner of provider delivery and recovery.
 */
export class ThreadCompletionCallbackDispatcher {
  readonly #callbacks: ThreadCompletionCallbackRepository;
  readonly #inventory: InventoryRepository;
  readonly #repository: QueuedInputRepository;
  readonly #gateway: QueuedInputConversationGateway;
  readonly #queue: CallbackQueue;
  readonly #now: () => number;
  readonly #retryScheduler: QueueDispatchScheduler;
  readonly #retryDelayMilliseconds: number;
  readonly #onRetryError: (error: unknown) => void;
  readonly #scopeTails = new Map<string, Promise<void>>();
  readonly #retryTimers = new Map<string, unknown>();
  #closed = false;

  constructor(input: {
    readonly callbacks: ThreadCompletionCallbackRepository;
    readonly inventory: InventoryRepository;
    readonly repository: QueuedInputRepository;
    readonly gateway: QueuedInputConversationGateway;
    readonly queue: CallbackQueue;
    readonly now?: () => number;
    readonly retryScheduler?: QueueDispatchScheduler;
    readonly retryDelayMilliseconds?: number;
    readonly onRetryError?: (error: unknown) => void;
  }) {
    if (
      input.callbacks.database !== input.inventory.database ||
      input.callbacks.database !== input.repository.database
    ) {
      throw new Error("completion_callback_dispatcher_database_mismatch");
    }
    this.#callbacks = input.callbacks;
    this.#inventory = input.inventory;
    this.#repository = input.repository;
    this.#gateway = input.gateway;
    this.#queue = input.queue;
    this.#now = input.now ?? Date.now;
    this.#retryScheduler = input.retryScheduler ?? retryScheduler;
    this.#retryDelayMilliseconds = input.retryDelayMilliseconds ?? 1_000;
    this.#onRetryError = input.onRetryError ?? (() => undefined);
    if (
      !Number.isSafeInteger(this.#retryDelayMilliseconds) ||
      this.#retryDelayMilliseconds < 1
    ) {
      throw new Error("completion_callback_retry_delay_invalid");
    }
  }

  /** Materializes and immediately lets the normal queue attempt delivery. */
  async deliverReady(scope: RequestScope): Promise<void> {
    if (this.#closed) throw new Error("completion_callback_dispatcher_closed");
    await this.#serializeScope(scope, () => this.#materializeReady(scope));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const handle of this.#retryTimers.values()) {
      this.#retryScheduler.cancel(handle);
    }
    this.#retryTimers.clear();
    await Promise.allSettled(this.#scopeTails.values());
  }

  async #materializeReady(scope: RequestScope): Promise<void> {
    const permanentFailures: unknown[] = [];
    for (const ready of this.#callbacks.listReadyForMaterialization(scope)) {
      let plan: CallbackDeliveryPlan | undefined;
      try {
        plan = await this.#plan(scope, ready);
      } catch (error) {
        permanentFailures.push(error);
        continue;
      }
      if (!plan) continue;
      const enqueue = {
        id: ready.callback.id,
        mutationId: ready.callback.id,
        text: callbackText(plan.sourceThreadLabel, ready),
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "completion_callback" as const,
          expectedThreadRevision: plan.expectedThreadRevision,
          callbackId: ready.callback.id,
          completionIdentity: ready.completionIdentity,
          sourceThreadLabel: plan.sourceThreadLabel,
          requestedDeliveryMode: plan.requestedDeliveryMode,
          ...(plan.requestedSteerTarget === undefined
            ? {}
            : { requestedSteerTarget: plan.requestedSteerTarget }),
          resolvedDeliveryMode: plan.resolvedDeliveryMode,
          ...(plan.resolvedSteerTarget === undefined
            ? {}
            : { resolvedSteerTarget: plan.resolvedSteerTarget }),
        },
        now: this.#now(),
      };
      try {
        await this.#queue.enqueue(
          scope,
          ready.callback.callerThreadId,
          enqueue,
        );
      } catch (error) {
        if (this.#isRetryableMaterializationRace(scope, ready, plan, error)) {
          this.#scheduleRetry(scope);
          continue;
        }
        permanentFailures.push(error);
      }
    }
    if (permanentFailures.length > 0) {
      throw new AggregateError(
        permanentFailures,
        "One or more completion callbacks could not be materialized.",
      );
    }
  }

  #isRetryableMaterializationRace(
    scope: RequestScope,
    ready: ReadyThreadCompletionCallback,
    plan: CallbackDeliveryPlan,
    error: unknown,
  ): boolean {
    if (!(error instanceof DomainError)) return false;
    const current = this.#callbacks.find(scope, ready.callback.id);
    if (current?.state !== "registered") return false;
    if (error.code === "conflict") return true;
    if (
      error.code !== "invalid_transition" ||
      plan.resolvedDeliveryMode !== "steer"
    ) {
      return false;
    }
    return this.#repository
      .listActiveHeads(scope)
      .some(
        (candidate) =>
          candidate.applicationThreadId === ready.callback.callerThreadId,
      );
  }

  async #plan(
    scope: RequestScope,
    ready: ReadyThreadCompletionCallback,
  ): Promise<CallbackDeliveryPlan | undefined> {
    const caller = this.#inventory.getThread(
      scope,
      ready.callback.callerThreadId,
    );
    if (caller.inventory.inventoryState === "archived") {
      this.#callbacks.cancelRegisteredForThread(
        scope,
        ready.callback.callerThreadId,
        {
          cancelledAt: this.#now(),
          reason: "The calling thread was archived before callback delivery.",
          cancellationMutationId: ready.callback.id,
        },
      );
      return undefined;
    }
    // Snooze is principal intent. Leave the obligation registered so a later
    // wake or startup recovery may deliver it without waking the thread here.
    if (caller.inventory.inventoryState === "snoozed") return undefined;
    if (caller.thread.backingState !== "bound") return undefined;
    const source = this.#inventory.getThread(
      scope,
      ready.callback.targetThreadId,
    );
    const sourceThreadLabel = boundDisplayText(source.thread.title);
    let requestedDeliveryMode: "submit" | "queue" | "steer" = "queue";
    let requestedSteerTarget: SteerTarget | undefined;
    let resolvedDeliveryMode: "submit" | "queue" | "steer" = "queue";
    let resolvedSteerTarget: SteerTarget | undefined;
    if (caller.thread.availability !== "available") {
      return {
        expectedThreadRevision: caller.thread.revision,
        sourceThreadLabel,
        requestedDeliveryMode,
        resolvedDeliveryMode,
      };
    }
    const existingHead = this.#repository
      .listActiveHeads(scope)
      .find(
        (candidate) =>
          candidate.applicationThreadId === ready.callback.callerThreadId,
      );
    if (existingHead) {
      return {
        expectedThreadRevision: caller.thread.revision,
        sourceThreadLabel,
        requestedDeliveryMode,
        resolvedDeliveryMode,
      };
    }
    try {
      await this.#gateway.withConversation(
        scope,
        ready.callback.callerThreadId,
        async (conversation) => {
          const steerTarget = await conversation.steerTarget?.();
          if (steerTarget) {
            requestedDeliveryMode = "steer";
            requestedSteerTarget = steerTarget;
            resolvedDeliveryMode = "steer";
            resolvedSteerTarget = steerTarget;
            return;
          }
          if (conversation.authoritativelySettled) {
            requestedDeliveryMode = "submit";
            resolvedDeliveryMode = "submit";
          }
        },
      );
    } catch {
      // Runtime acquisition is not an acceptance boundary. Materialize as a
      // queued result and let durable queue recovery retry it later.
    }
    const current = this.#inventory.getThread(
      scope,
      ready.callback.callerThreadId,
    );
    if (
      current.inventory.inventoryState === "archived" ||
      current.inventory.inventoryState === "snoozed"
    ) {
      return undefined;
    }
    return {
      expectedThreadRevision: current.thread.revision,
      sourceThreadLabel,
      requestedDeliveryMode,
      ...(requestedSteerTarget === undefined ? {} : { requestedSteerTarget }),
      resolvedDeliveryMode,
      ...(resolvedSteerTarget === undefined ? {} : { resolvedSteerTarget }),
    };
  }

  #serializeScope<T>(
    scope: RequestScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${scope.tenantId}\0${scope.principalId}`;
    const prior = this.#scopeTails.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#scopeTails.set(key, tail);
    void tail.then(() => {
      if (this.#scopeTails.get(key) === tail) this.#scopeTails.delete(key);
    });
    return result;
  }

  #scheduleRetry(scope: RequestScope): void {
    if (this.#closed) return;
    const key = `${scope.tenantId}\0${scope.principalId}`;
    if (this.#retryTimers.has(key)) return;
    const handle = this.#retryScheduler.schedule(
      this.#retryDelayMilliseconds,
      () => {
        if (this.#closed) return;
        this.#retryTimers.delete(key);
        void this.deliverReady(scope).catch(this.#onRetryError);
      },
    );
    this.#retryTimers.set(key, handle);
  }
}
