import { randomUUID } from "node:crypto";
import {
  ConversationActorRetirementBusyError,
  ConversationActorRetirementStaleError,
  type ConversationActorRetirementDisposition,
  ConversationActorRetirementUnprovenError,
  ConversationRuntimeReclamationRaceError,
  type ConversationRuntimePressureRequest,
  type ConversationActorManager,
  type ConversationRuntimePressureReclamation,
} from "../conversations/conversation-actor-manager.js";
import type {
  ConversationActor,
  ConversationActorSnapshotState,
} from "../conversations/conversation-actor.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
} from "../../shared/protocol/conversation.js";
import type { ThreadApplicationActorTargetResolver } from "../conversations/thread-application-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ConversationEventBridge,
  ConversationEventBridgeBinding,
} from "./conversation-event-bridge.js";
import type {
  InteractionBroker,
  InteractionBrokerBinding,
} from "../conversations/interaction-broker.js";
import { assertConversationRetentionMilliseconds } from "../conversations/conversation-retention-policy.js";
import { ThreadEventHub } from "./thread-event-hub.js";
import type { ThreadForceResetConversationRuntimeBlocker } from "../db/repositories/thread-force-reset-repository.js";

function scopedKey(scope: RequestScope, applicationThreadId: string): string {
  return [scope.tenantId, scope.principalId, applicationThreadId].join("\0");
}

export class ScopedThreadEventHubRegistry {
  readonly #hubs = new Map<string, ThreadEventHub>();
  readonly #maximumRetainedHubs: number;
  readonly #owners = new Map<ThreadEventHub, number>();

  constructor(maximumRetainedHubs = 128) {
    if (
      !Number.isSafeInteger(maximumRetainedHubs) ||
      maximumRetainedHubs <= 0
    ) {
      throw new Error("thread_event_hub_registry_limit_invalid");
    }
    this.#maximumRetainedHubs = maximumRetainedHubs;
  }

  thread(scope: RequestScope, applicationThreadId: string): ThreadEventHub {
    const hub = this.#lookup(scope, applicationThreadId);
    this.#evictInactive();
    return hub;
  }

  /** Publication ownership survives browser disconnects and registry pressure. */
  acquire(scope: RequestScope, applicationThreadId: string): {
    readonly hub: ThreadEventHub;
    release(): void;
  } {
    const hub = this.#lookup(scope, applicationThreadId);
    this.#owners.set(hub, (this.#owners.get(hub) ?? 0) + 1);
    this.#evictInactive();
    let released = false;
    return {
      hub,
      release: () => {
        if (released) return;
        released = true;
        const owners = this.#owners.get(hub)! - 1;
        if (owners > 0) this.#owners.set(hub, owners);
        else this.#owners.delete(hub);
        this.release(hub);
      },
    };
  }

  #lookup(scope: RequestScope, applicationThreadId: string): ThreadEventHub {
    const key = scopedKey(scope, applicationThreadId);
    let hub = this.#hubs.get(key);
    if (!hub) {
      hub = new ThreadEventHub();
      this.#hubs.set(key, hub);
    } else {
      this.#hubs.delete(key);
      this.#hubs.set(key, hub);
    }
    return hub;
  }

  release(hub: ThreadEventHub): void {
    if (hub.subscriberCount > 0 || this.#owners.has(hub)) return;
    for (const [key, candidate] of this.#hubs) {
      if (candidate !== hub) continue;
      this.#hubs.delete(key);
      return;
    }
  }

  get size(): number {
    return this.#hubs.size;
  }

  #evictInactive(): void {
    if (this.#hubs.size <= this.#maximumRetainedHubs) return;
    for (const [key, hub] of this.#hubs) {
      if (this.#hubs.size <= this.#maximumRetainedHubs) return;
      if (hub.subscriberCount === 0 && !this.#owners.has(hub)) {
        this.#hubs.delete(key);
      }
    }
  }
}

interface RuntimeEntry {
  promise: Promise<EstablishedRuntime>;
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly generation: string;
  readonly establishmentAbort: AbortController;
  runtime?: EstablishedRuntime;
  applicationOverlayReady: boolean;
  pendingApplicationPublication?: (runtime: EstablishedRuntime) => Promise<boolean>;
  references: number;
  evictionTimer?: NodeJS.Timeout;
  eviction?: Promise<void>;
  idleSince?: number;
}

interface EstablishedRuntime {
  readonly actor: ConversationActor;
  readonly executionEnvironmentId: string;
  readonly actorRelease: () => void;
  readonly bridge: ConversationEventBridgeBinding;
  readonly interaction: InteractionBrokerBinding;
  readonly hub: ThreadEventHub;
  readonly releaseHub: () => void;
  readonly unsubscribeApplicationSummary: () => void;
  readonly unsubscribeSubscriberCount: () => void;
  readonly unsubscribeActorClosed: () => void;
}

export interface AcquiredThreadRuntime {
  readonly actor: ConversationActor;
  readonly hub: ThreadEventHub;
  publishAuthoritativeReplacement: ConversationEventBridgeBinding["publishAuthoritativeReplacement"];
  release(): void;
}

export interface AgentToolApprovalAuthorityLease {
  readonly generation: string;
  /** Aborts when this application runtime generation is replaced or shuts down. */
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

/**
 * Exclusive maintenance boundary for state that is owned by a thread's
 * backend runtime. Implementations must keep concurrent runtime acquisition
 * fenced until the supplied operation settles.
 */
export interface ThreadRuntimeRetirement {
  runWithRuntimeRetired<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result>;
}

export class ThreadRuntimeNotIdleError extends Error {
  constructor() {
    super("The thread runtime is not idle.");
    this.name = "ThreadRuntimeNotIdleError";
  }
}

export class ThreadRuntimeMaintenanceStaleError extends Error {
  constructor() {
    super("The thread runtime changed after maintenance preview.");
    this.name = "ThreadRuntimeMaintenanceStaleError";
  }
}

export class ThreadRuntimeRetirementUnprovenError extends Error {
  constructor(cause: unknown) {
    super("The thread runtime could not be proven closed.", { cause });
    this.name = "ThreadRuntimeRetirementUnprovenError";
  }
}

/**
 * Owns exactly one bridge and interaction binding for each process-wide actor.
 * Browser subscribers and mutations borrow that owner. When the actor becomes
 * idle and no borrower remains, the complete binding is released so the actor
 * manager can evict the backend handle and workspace lease.
 */
export class ThreadRuntimeCoordinator {
  readonly #actors: Pick<
    ConversationActorManager,
    "acquire" | "runWithRuntimeRetired" | "runWithRuntimesStopped"
  >;
  readonly #targets: ThreadApplicationActorTargetResolver;
  readonly #bridge: ConversationEventBridge;
  readonly #interactions: InteractionBroker;
  readonly #hubs: ScopedThreadEventHubRegistry;
  readonly #retentionMilliseconds: number;
  readonly #onThreadChanged?: (
    scope: RequestScope,
    applicationThreadId: string,
  ) => void | Promise<void>;
  readonly #onAuthoritativeSettled?: (
    scope: RequestScope,
    applicationThreadId: string,
  ) => void | Promise<void>;
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #maintenance = new Map<string, Promise<unknown>>();
  readonly #shutdownController = new AbortController();
  readonly #detached = new WeakSet<object>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly actors: Pick<
      ConversationActorManager,
      "acquire" | "runWithRuntimeRetired" | "runWithRuntimesStopped"
    >;
    readonly targets: ThreadApplicationActorTargetResolver;
    readonly bridge: ConversationEventBridge;
    readonly interactions: InteractionBroker;
    readonly hubs: ScopedThreadEventHubRegistry;
    readonly retentionMilliseconds: number;
    readonly onThreadChanged?: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => void | Promise<void>;
    readonly onAuthoritativeSettled?: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => void | Promise<void>;
  }) {
    this.#actors = input.actors;
    this.#targets = input.targets;
    this.#bridge = input.bridge;
    this.#interactions = input.interactions;
    this.#hubs = input.hubs;
    this.#onThreadChanged = input.onThreadChanged;
    this.#onAuthoritativeSettled = input.onAuthoritativeSettled;
    assertConversationRetentionMilliseconds(input.retentionMilliseconds);
    this.#retentionMilliseconds = input.retentionMilliseconds;
  }

  async acquire(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AcquiredThreadRuntime> {
    const key = scopedKey(scope, applicationThreadId);
    while (true) {
      if (this.#closed) throw new Error("thread_runtime_coordinator_closed");
      const maintenance = this.#maintenance.get(key);
      if (maintenance) {
        await maintenance;
        continue;
      }
      let entry = this.#entries.get(key);
      if (!entry) {
        const establishmentAbort = new AbortController();
        const created = {
          scope: Object.freeze({ ...scope }),
          applicationThreadId,
          generation: randomUUID(),
          establishmentAbort,
          applicationOverlayReady: false,
          references: 0,
        } as RuntimeEntry;
        created.promise = this.#establish(
          scope,
          applicationThreadId,
          AbortSignal.any([
            this.#shutdownController.signal,
            establishmentAbort.signal,
          ]),
        ).then(async (runtime) => {
          created.runtime = runtime;
          if (runtime.actor.closed) {
            created.eviction ??= this.#dispose(runtime);
            await created.eviction;
            throw new Error("conversation_actor_closed");
          }
          if (this.#closed) {
            this.#detach(runtime);
            throw this.#shutdownController.signal.reason;
          }
          try {
            // An overlay can change after the bridge starts composing its
            // initial snapshot. Drain coalesced local captures before acquire
            // exposes that baseline, without making the mutation wait on the
            // provider or re-entering the publisher's per-thread mailbox.
            while (created.pendingApplicationPublication) {
              const publish = created.pendingApplicationPublication;
              created.pendingApplicationPublication = undefined;
              if (!(await publish(runtime))) {
                throw new Error("thread_runtime_initial_overlay_unavailable");
              }
            }
            if (this.#closed) throw this.#shutdownController.signal.reason;
            if (
              created.eviction ||
              this.#detached.has(runtime) ||
              runtime.actor.closed
            ) {
              throw new Error("thread_runtime_initial_overlay_unavailable");
            }
            created.applicationOverlayReady = true;
          } catch (error) {
            await this.#dispose(runtime);
            throw error;
          }
          // Establishment callbacks can observe the initial hub snapshot before
          // this entry becomes loaded. Publish once more at the ready boundary
          // so the application summary reads the accurate actor run state
          // without awaiting the establishment promise itself.
          try {
            const publication = this.#onThreadChanged?.(
              scope,
              applicationThreadId,
            );
            if (publication) void publication.catch(() => undefined);
          } catch {
            // Bootstrap remains authoritative if this observer fails.
          }
          return runtime;
        });
        entry = created;
        this.#entries.set(key, created);
        void created.promise.catch(() => {
          if (this.#entries.get(key) === created && !created.eviction) {
            this.#entries.delete(key);
          }
        });
      }
      if (entry.eviction) {
        await entry.eviction;
        continue;
      }
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      // A demand-driven acquire is a real reopen. Passive `IfLoaded` reads use
      // their dedicated methods below and deliberately preserve this stamp.
      entry.idleSince = undefined;
      entry.references += 1;
      let runtime: EstablishedRuntime | undefined;
      try {
        runtime = await entry.promise;
        await runtime.actor.ensureProjectionCurrent();
      } catch (error) {
        this.#release(key, entry);
        if (runtime?.actor.replacementRequired) {
          await this.#retireForReplacement(key, entry, runtime);
          continue;
        }
        throw error;
      }
      let released = false;
      return {
        actor: runtime.actor,
        hub: runtime.hub,
        publishAuthoritativeReplacement: () =>
          runtime.bridge.publishAuthoritativeReplacement(),
        release: () => {
          if (released) return;
          released = true;
          this.#release(key, entry!);
        },
      };
    }
  }

  /**
   * Retires an idle loaded runtime and holds an exclusive per-thread fence
   * through an external maintenance operation. Pending establishment is
   * cancelled and fully cleaned up. A close whose completion cannot be proved
   * leaves the rejected fence installed so a competing runtime cannot start.
   */
  async runWithRuntimeRetired<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.#runWithRuntimeMaintenance(
      scope, applicationThreadId, { kind: "idle" }, operation,
    );
  }

  /** Detaches exactly the previewed actor and keeps admission fenced through the operation. */
  async runWithRuntimeDetached<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    expected: ThreadForceResetConversationRuntimeBlocker | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.#runWithRuntimeMaintenance(
      scope, applicationThreadId, { kind: "explicit_detach", expected }, operation,
    );
  }

  /** Stop loaded actors and retire their local modules, including after a refused host command. */
  async runWithRuntimesStopped<Result>(
    scope: RequestScope,
    applicationThreadIds: readonly string[],
    stopOwnedResources: () => Promise<void>,
    retireLocalRuntime: () => Promise<Result>,
  ): Promise<Result> {
    const ids = [...new Set(applicationThreadIds)].sort();
    const keys = ids.map(id => scopedKey(scope, id));
    while (true) {
      if (this.#closed) throw new Error("thread_runtime_coordinator_closed");
      const existing = keys.flatMap(key => this.#maintenance.get(key) ?? []);
      if (existing.length) { await Promise.all(existing); continue; }
      let begin!: () => void;
      const gate = new Promise<void>(resolve => { begin = resolve; });
      let retirementProven = false;
      const entries = keys.flatMap(key => {
        const entry = this.#entries.get(key);
        if (!entry) return [];
        if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
        entry.establishmentAbort.abort(new Error("thread_runtime_explicit_stop"));
        return [{ key, entry }];
      });
      const result = (async () => {
        await gate;
        try {
          return await this.#actors.runWithRuntimesStopped({
            scope, applicationThreadIds: ids, stopOwnedResources,
            detachCoordinatorRuntimes: async () => {
              const results = await Promise.allSettled(entries.map(async ({ key, entry }) => {
                let runtime = entry.runtime;
                if (!runtime) {
                  try { runtime = await entry.promise; }
                  catch (error) { if (error !== entry.establishmentAbort.signal.reason) throw error; }
                }
                if (runtime) await this.#dispose(runtime);
                if (this.#entries.get(key) === entry) this.#entries.delete(key);
              }));
              const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
              if (failures.length) throw new AggregateError(failures, "Explicit runtime bindings did not close cleanly.");
              retirementProven = true;
            },
            retireLocalRuntime,
          });
        } catch (error) {
          if (error instanceof ConversationActorRetirementUnprovenError) {
            retirementProven = false;
            throw new ThreadRuntimeRetirementUnprovenError(error.cause);
          }
          throw error;
        }
      })();
      const maintenance = result.then(() => undefined, error => { if (!retirementProven) throw error; });
      void maintenance.then(() => {
        for (const key of keys) if (this.#maintenance.get(key) === maintenance) this.#maintenance.delete(key);
      }, () => undefined);
      for (const key of keys) this.#maintenance.set(key, maintenance);
      begin();
      return await result;
    }
  }

  async #runWithRuntimeMaintenance<Result>(
    scope: RequestScope,
    applicationThreadId: string,
    disposition:
      | { readonly kind: "idle" }
      | {
          readonly kind: "explicit_detach";
          readonly expected: ThreadForceResetConversationRuntimeBlocker | undefined;
        },
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const key = scopedKey(scope, applicationThreadId);
    while (true) {
      if (this.#closed) throw new Error("thread_runtime_coordinator_closed");
      const existing = this.#maintenance.get(key);
      if (existing) {
        await existing;
        continue;
      }

      let begin!: () => void;
      const gate = new Promise<void>((resolve) => {
        begin = resolve;
      });
      let retirementProven = false;
      let runtimeWasBusy = false;
      const result = (async () => {
        await gate;
        try {
          const actorDisposition: ConversationActorRetirementDisposition =
            disposition.kind === "explicit_detach" &&
            disposition.expected &&
            this.#entries.get(key)?.runtime
              ? { kind: "explicit_detach", expected: disposition.expected }
              : { kind: "idle" };
          return await this.#actors.runWithRuntimeRetired({
            scope,
            applicationThreadId,
            disposition: actorDisposition,
            detachCoordinatorRuntime: async () => {
              try {
                if (disposition.kind === "explicit_detach") {
                  await this.#releasePreviewedRuntime(key, disposition.expected);
                } else {
                  await this.#releaseIdleRuntime(key);
                }
              } catch (error) {
                if (error instanceof ConversationActorRetirementStaleError) {
                  throw error;
                }
                if (error instanceof ThreadRuntimeNotIdleError) {
                  throw new ConversationActorRetirementBusyError();
                }
                throw new ConversationActorRetirementUnprovenError(error);
              }
            },
            operation: async () => {
              retirementProven = true;
              return operation();
            },
          });
        } catch (error) {
          if (retirementProven) throw error;
          if (error instanceof ConversationActorRetirementBusyError) {
            error = new ThreadRuntimeNotIdleError();
          } else if (error instanceof ConversationActorRetirementStaleError) {
            error = new ThreadRuntimeMaintenanceStaleError();
          } else if (
            error instanceof ConversationActorRetirementUnprovenError
          ) {
            error = new ThreadRuntimeRetirementUnprovenError(error.cause);
          }
          runtimeWasBusy =
            error instanceof ThreadRuntimeNotIdleError ||
            error instanceof ThreadRuntimeMaintenanceStaleError;
          if (
            runtimeWasBusy ||
            error instanceof ThreadRuntimeRetirementUnprovenError
          ) {
            throw error;
          }
          throw new ThreadRuntimeRetirementUnprovenError(error);
        }
      })();
      const maintenance = result.then(
        () => undefined,
        (error) => {
          if (retirementProven || runtimeWasBusy) return;
          throw error;
        },
      );
      // Successful completion includes a proven retirement followed by an
      // operation failure. Remove the fence before any queued waiter resumes;
      // only unproven retirement leaves a rejected fence installed.
      void maintenance.then(
        () => {
          if (this.#maintenance.get(key) === maintenance) {
            this.#maintenance.delete(key);
          }
        },
        () => undefined,
      );
      this.#maintenance.set(key, maintenance);
      begin();
      return await result;
    }
  }

  /**
   * Synchronously claims the oldest unobserved reclaimable runtime, if any.
   * The returned fence is installed before this method returns so actor-level
   * admission can reserve the released slot without a concurrent double pick.
   */
  tryReclaimOldestIdleRuntime(
    request: ConversationRuntimePressureRequest,
  ): ConversationRuntimePressureReclamation | undefined {
    let oldest:
      | {
          readonly key: string;
          readonly entry: RuntimeEntry;
          readonly idleSince: number;
        }
      | undefined;
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      const runtime = entry.runtime;
      if (
        !runtime ||
        entry.scope.tenantId !== request.budgetScope.tenantId ||
        entry.scope.principalId !== request.budgetScope.principalId ||
        runtime.executionEnvironmentId !==
          request.budgetScope.executionEnvironmentId ||
        entry.references > 0 ||
        entry.eviction ||
        this.#maintenance.has(key) ||
        runtime.hub.subscriberCount > 0
      ) {
        continue;
      }
      if (!runtime.actor.canEvict) continue;
      entry.idleSince ??= now;
      const candidate = {
        key,
        entry,
        idleSince: entry.idleSince,
      };
      if (
        !oldest ||
        candidate.idleSince < oldest.idleSince ||
        (candidate.idleSince === oldest.idleSince && candidate.key < oldest.key)
      ) {
        oldest = candidate;
      }
    }
    if (!oldest) return undefined;
    if (
      request.olderThan &&
      (request.olderThan.idleSince < oldest.idleSince ||
        (request.olderThan.idleSince === oldest.idleSince &&
          request.olderThan.actorKey <= oldest.key))
    ) {
      return undefined;
    }
    const completion = this.#tryStartPressureRetirement(
      oldest.key,
      oldest.entry,
    );
    if (!completion) return undefined;
    return { actorKey: oldest.key, completion };
  }

  /** Borrows the application runtime only when a cross-environment decision is needed. */
  async acquireAgentToolApprovalAuthority(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AgentToolApprovalAuthorityLease> {
    const acquired = await this.acquire(scope, applicationThreadId);
    let unsubscribe: (() => void) | undefined;
    let unsubscribeClosed: (() => void) | undefined;
    try {
      const generation = acquired.actor.timeline.generation;
      const changed = new AbortController();
      const isCurrent = () =>
        !acquired.actor.closed &&
        acquired.actor.timeline.generation === generation;
      let initializing = true;
      unsubscribe = acquired.actor.subscribe(() => {
        if (!initializing && !isCurrent() && !changed.signal.aborted) {
          changed.abort(new Error("agent_tool_approval_runtime_changed"));
        }
      });
      unsubscribeClosed =
        acquired.actor.onClosed?.(() => {
          if (!changed.signal.aborted) {
            changed.abort(new Error("agent_tool_runtime_closed"));
          }
        }) ?? (() => undefined);
      initializing = false;
      if (!isCurrent()) {
        throw new Error("agent_tool_approval_runtime_changed");
      }
      let released = false;
      return {
        generation,
        signal: AbortSignal.any([
          changed.signal,
          this.#shutdownController.signal,
        ]),
        isCurrent,
        release: () => {
          if (released) return;
          released = true;
          unsubscribeClosed?.();
          unsubscribe?.();
          acquired.release();
        },
      };
    } catch (error) {
      unsubscribeClosed?.();
      unsubscribe?.();
      acquired.release();
      throw error;
    }
  }

  /**
   * Publishes an application-owned thread change only when this process
   * already owns the backend runtime. Dormant bound conversations are never
   * attached merely to project overlay inventory state.
   */
  publishUsageRevisionIfLoaded(scope: RequestScope, applicationThreadId: string, revision: string): boolean {
    const entry = this.#entries.get(scopedKey(scope, applicationThreadId));
    const runtime = entry?.runtime;
    if (this.#closed || !entry || entry.eviction || !runtime || this.#detached.has(runtime) || runtime.actor.closed) return false;
    const generation = runtime.hub.projectionGeneration;
    if (!generation || !runtime.hub.snapshot || runtime.actor.peekSnapshotState()?.timeline.generation !== generation) return false;
    runtime.hub.publish({type: "usage_revision_changed", generation, revision});
    return true;
  }

  async publishApplicationIncrementalsIfLoaded(
    scope: RequestScope,
    applicationThreadId: string,
    capture: (
      actor: ConversationActorSnapshotState,
    ) => Promise<
      Extract<
        NormalizedThreadEvent,
        { readonly type: "application_state_changed" }
      >["state"]
    >,
    createEvents: (
      generation: string,
      current: NormalizedThreadSnapshot,
      captured: Extract<
        NormalizedThreadEvent,
        { readonly type: "application_state_changed" }
      >["state"],
    ) => readonly Exclude<
      NormalizedThreadEvent,
      { readonly type: "snapshot" }
    >[],
  ): Promise<boolean> {
    const key = scopedKey(scope, applicationThreadId);
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction) return false;
    const publish = async (runtime: EstablishedRuntime): Promise<boolean> => {
      // One cache-only capture is enough. Merge against the latest hub after
      // the await, without actor recovery or waiting for a quiet provider.
      const actorState = runtime.actor.peekSnapshotState();
      if (!actorState) return false;
      const captureStart = Date.now();
      const captured = await abortable(
        capture(actorState),
        AbortSignal.any([
          this.#shutdownController.signal,
          entry.establishmentAbort.signal,
        ]),
      );
      if (
        this.#closed ||
        this.#entries.get(key) !== entry ||
        entry.eviction ||
        this.#detached.has(runtime) ||
        runtime.actor.closed
      ) {
        return false;
      }
      // A newer mutation during initial composition needs another capture.
      // Do not publish the already superseded intermediate state.
      if (!entry.applicationOverlayReady && entry.pendingApplicationPublication) {
        return true;
      }
      const generation = runtime.hub.projectionGeneration;
      const current = runtime.hub.snapshot;
      if (!generation || !current) return false;
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-capture] thread=${applicationThreadId} ms=${Date.now() - captureStart}`,
        );
      }
      for (const event of createEvents(generation, current, captured)) {
        runtime.hub.publish(event);
      }
      return true;
    };
    if (entry.evictionTimer) {
      clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
    }
    entry.references += 1;
    try {
      const runtime = entry.runtime;
      if (!runtime || !entry.applicationOverlayReady) {
        // Keep only the latest full-state capture, not a mutation payload.
        // The caller returns immediately even if the provider is still loading.
        entry.pendingApplicationPublication = publish;
        return false;
      }
      return await publish(runtime);
    } finally {
      this.#release(key, entry);
    }
  }

  quiet(
    scope: RequestScope,
    applicationThreadId: string,
  ): {
    readonly hub: ThreadEventHub;
    readonly generation: string;
    publishIfUnowned(
      snapshot: NormalizedThreadSnapshot,
    ): ThreadEventEnvelope | undefined;
    release(): void;
  } {
    const key = scopedKey(scope, applicationThreadId);
    const hubLease = this.#hubs.acquire(scope, applicationThreadId);
    const hub = hubLease.hub;
    const generation = `application-${hub.transportGeneration}`;
    return {
      hub,
      generation,
      publishIfUnowned: (snapshot) => {
        if (this.#entries.has(key)) return undefined;
        return hub.publish({
          type: "snapshot",
          generation,
          snapshot,
        });
      },
      release: hubLease.release,
    };
  }

  async captureLoadedState(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<{ readonly runState: ThreadRunState } | undefined> {
    const key = scopedKey(scope, applicationThreadId);
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction) return undefined;
    if (entry.evictionTimer) {
      clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
    }
    entry.references += 1;
    try {
      // Application summaries are local observers. A runtime entry that is
      // still establishing remotely is not loaded yet; its ready transition
      // will publish the accurate run state later.
      const runtime = entry.runtime;
      if (!runtime) return undefined;
      return { runState: runtime.actor.timeline.runState };
    } finally {
      this.#release(key, entry);
    }
  }

  /** Captures the exact loaded runtime generation used as force-reset CAS evidence. */
  async captureLoadedRuntime(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadForceResetConversationRuntimeBlocker | undefined> {
    const key = scopedKey(scope, applicationThreadId);
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction) return undefined;
    if (entry.evictionTimer) {
      clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
    }
    entry.references += 1;
    try {
      const runtime = entry.runtime;
      if (!runtime) {
        return {
          kind: "conversation_runtime",
          threadId: applicationThreadId,
          generation: entry.generation,
          runState: "starting",
        };
      }
      if (runtime.actor.closed) return undefined;
      const timeline = runtime.actor.timeline;
      return {
        kind: "conversation_runtime",
        threadId: applicationThreadId,
        generation: timeline.generation,
        runState: timeline.runState,
        ...(timeline.activeTurnId
          ? { activeTurnId: timeline.activeTurnId }
          : {}),
        ...(timeline.backgroundActivity
          ? { backgroundActivity: timeline.backgroundActivity }
          : {}),
      };
    } finally {
      this.#release(key, entry);
    }
  }

  /**
   * Retires exactly the runtime generation admitted by force-reset commit,
   * then attaches its replacement to the retained thread hub. A failed close
   * leaves the entry fenced so no competing runtime can be established.
   */
  async forceResetLoadedRuntime(
    scope: RequestScope,
    applicationThreadId: string,
    expected: ThreadForceResetConversationRuntimeBlocker,
  ): Promise<boolean> {
    const key = scopedKey(scope, applicationThreadId);
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction) return false;
    const runtime = entry.runtime;
    if (
      runtime
        ? !runtimeMatches(runtime, expected)
        : expected.generation !== entry.generation ||
          expected.runState !== "starting" ||
          expected.activeTurnId !== undefined
    ) {
      return false;
    }
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    entry.evictionTimer = undefined;

    // Install the fence before awaiting close so concurrent acquisition waits
    // for this exact retirement instead of borrowing the closing actor.
    let beginRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      beginRetirement = resolve;
    });
    const retirement = (async () => {
      await retirementGate;
      if (!runtime) {
        entry.establishmentAbort.abort(new Error("thread_runtime_force_reset"));
        try {
          await entry.promise;
        } catch (error) {
          // Establishment owns abort cleanup. Its expected rejection proves
          // that cleanup completed before this entry can be replaced.
          if (error !== entry.establishmentAbort.signal.reason) throw error;
        }
      } else {
        runtime.unsubscribeActorClosed();
        await runtime.actor.close();
        if (!runtime.actor.replacementSafe) {
          throw new Error("conversation_actor_close_unproven");
        }
        await this.#dispose(runtime);
      }
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    })();
    entry.eviction = retirement;
    beginRetirement();
    await retirement;

    // Reattachment deliberately uses acquire: it resolves the same
    // application thread and binds the new actor into the existing retained
    // hub. The explicit replacement closes any gap left by provider startup.
    const replacement = await this.acquire(scope, applicationThreadId);
    try {
      await replacement.publishAuthoritativeReplacement();
    } finally {
      replacement.release();
    }
    return true;
  }

  /**
   * Re-baselines the retained thread hub from the already-loaded actor without
   * attaching a dormant backend or asking the provider for fresh state.
   * Maintenance mutations use this when an application-only incremental could
   * otherwise preserve a stale provider-owned run state in the hub.
   */
  async publishAuthoritativeReplacementIfLoaded(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<boolean> {
    const key = scopedKey(scope, applicationThreadId);
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction) return false;
    if (entry.evictionTimer) {
      clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
    }
    entry.references += 1;
    try {
      // `IfLoaded` is literal. A pending establishment may still be performing
      // provider work, so force-reset publication must not wait for or own it.
      const runtime = entry.runtime;
      if (!runtime) return false;
      await runtime.bridge.publishAuthoritativeReplacement();
      return true;
    } finally {
      this.#release(key, entry);
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  /** Bounded-shutdown local phase; actor/backend owners close in later phases. */
  closeForShutdown(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#shutdownController.abort(new Error("thread_runtime_shutdown"));
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
      entry.establishmentAbort.abort(new Error("thread_runtime_shutdown"));
      if (entry.runtime) this.#detach(entry.runtime);
      else {
        void entry.promise.then(
          (runtime) => this.#detach(runtime),
          () => undefined,
        );
      }
    }
    this.#entries.clear();
    this.#closePromise = Promise.resolve();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdownController.abort(new Error("thread_runtime_close"));
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
      entry.establishmentAbort.abort(new Error("thread_runtime_close"));
    }
    const results = await Promise.allSettled(
      entries.map(
        async ({ promise, eviction }) =>
          eviction ?? this.#dispose(await promise),
      ),
    );
    this.#entries.clear();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more thread runtimes did not close cleanly.",
      );
    }
  }

  async #establish(
    scope: RequestScope,
    applicationThreadId: string,
    signal: AbortSignal,
  ): Promise<EstablishedRuntime> {
    throwIfAborted(signal);
    const target = await abortable(
      this.#targets.resolve(scope, applicationThreadId),
      signal,
    );
    throwIfAborted(signal);
    const actorAcquisition = this.#actors.acquire(target, {
      idleRelease: "evict",
    });
    void actorAcquisition.then(
      (acquired) => {
        if (signal.aborted) acquired.release();
      },
      () => undefined,
    );
    const acquired = await abortable(actorAcquisition, signal);
    if (signal.aborted) {
      acquired.release();
      throw signal.reason;
    }
    const hubLease = this.#hubs.acquire(scope, applicationThreadId);
    const hub = hubLease.hub;
    let bridge: ConversationEventBridgeBinding | undefined;
    let bridgeReady = false;
    let bridgeRecovery: Promise<void> | undefined;
    let interaction: InteractionBrokerBinding | undefined;
    let unsubscribeApplicationSummary: () => void = () => undefined;
    let unsubscribeSubscriberCount: () => void = () => undefined;
    let unsubscribeActorClosed: () => void = () => undefined;
    try {
      bridge = this.#bridge.bind({
        scope,
        applicationThreadId,
        actor: acquired.actor,
        hub,
        captureAuthoritativeState: () => acquired.actor.captureSnapshotState(),
        onFailure: () => {
          if (!bridgeReady || !bridge || bridgeRecovery) {
            return bridgeRecovery;
          }
          const recovery = bridge
            .publishAuthoritativeReplacement()
            .then(() => undefined);
          const tracked = recovery.finally(() => {
            if (bridgeRecovery === tracked) bridgeRecovery = undefined;
          });
          bridgeRecovery = tracked;
          return bridgeRecovery;
        },
      });
      interaction = this.#interactions.bind(
        scope,
        applicationThreadId,
        acquired.actor,
        bridge,
      );
      const summarySubscription = hub.subscribeInternal(({ event }) => {
        if (event.type === "snapshot" || event.type === "run_state") {
          this.#runtimeStateChanged(scopedKey(scope, applicationThreadId), hub);
        }
        if (
          event.type === "run_state" &&
          (event.state === "idle" || event.state === "failed")
        ) {
          try {
            const dispatch = this.#onAuthoritativeSettled?.(
              scope,
              applicationThreadId,
            );
            if (dispatch) void dispatch.catch(() => undefined);
          } catch {
            // The durable queue remains authoritative and startup recovery
            // replays it if this live idle observer cannot dispatch.
          }
        }
        if (
          event.type === "snapshot" ||
          event.type === "run_state" ||
          event.type === "queue_changed" ||
          event.type === "thread_changed" ||
          event.type === "attention_changed"
        ) {
          try {
            const publication = this.#onThreadChanged?.(
              scope,
              applicationThreadId,
            );
            if (publication) void publication.catch(() => undefined);
          } catch {
            // Application summary publication is an observer; bootstrap is
            // authoritative if its live update fails.
          }
        }
      });
      unsubscribeApplicationSummary = summarySubscription.close;
      const key = scopedKey(scope, applicationThreadId);
      unsubscribeSubscriberCount = hub.onSubscriberCountChanged(() =>
        this.#subscriberCountChanged(key, hub),
      );
      let runtime: EstablishedRuntime | undefined;
      unsubscribeActorClosed =
        acquired.actor.onClosed?.(() => {
          if (runtime) this.#runtimeActorClosed(key, runtime);
        }) ?? (() => undefined);
      await abortable(bridge.ready, signal);
      bridgeReady = true;
      interaction.publishPending();
      runtime = {
        actor: acquired.actor,
        executionEnvironmentId: target.binding.executionEnvironmentId,
        actorRelease: acquired.release,
        bridge,
        interaction,
        hub,
        releaseHub: hubLease.release,
        unsubscribeApplicationSummary,
        unsubscribeSubscriberCount,
        unsubscribeActorClosed,
      };
      if (acquired.actor.closed) this.#runtimeActorClosed(key, runtime);
      return runtime;
    } catch (error) {
      const failures: unknown[] = [error];
      if (interaction) {
        try {
          if (signal.aborted) interaction.detach();
          else await interaction.release();
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
      unsubscribeSubscriberCount();
      unsubscribeApplicationSummary();
      unsubscribeActorClosed();
      if (bridge) {
        try {
          if (signal.aborted) bridge.detach();
          else await bridge.release();
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
      acquired.release();
      hubLease.release();
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        "Thread runtime establishment cleanup failed.",
        { cause: error },
      );
    }
  }

  #release(key: string, entry: RuntimeEntry): void {
    if (this.#entries.get(key) !== entry || entry.references === 0) return;
    entry.references -= 1;
    if (
      entry.references > 0 ||
      this.#closed ||
      (entry.runtime?.hub.subscriberCount ?? 0) > 0
    ) {
      return;
    }
    this.#reconcileEviction(key, entry);
  }

  #subscriberCountChanged(key: string, hub: ThreadEventHub): void {
    if (this.#closed) return;
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction || entry.runtime?.hub !== hub) return;
    this.#reconcileEviction(key, entry);
  }

  #runtimeStateChanged(key: string, hub: ThreadEventHub): void {
    if (this.#closed) return;
    const entry = this.#entries.get(key);
    if (!entry || entry.eviction || entry.runtime?.hub !== hub) return;
    this.#reconcileEviction(key, entry);
  }

  #runtimeActorClosed(key: string, runtime: EstablishedRuntime): void {
    const entry = this.#entries.get(key);
    if (!entry || entry.runtime !== runtime) return;
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    entry.evictionTimer = undefined;
    entry.eviction ??= this.#dispose(runtime).finally(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    void entry.eviction.catch(() => undefined);
  }

  async #retireForReplacement(
    key: string,
    entry: RuntimeEntry,
    runtime: EstablishedRuntime,
  ): Promise<void> {
    if (this.#entries.get(key) !== entry) {
      await entry.eviction;
      return;
    }
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    entry.evictionTimer = undefined;
    entry.eviction ??= this.#dispose(runtime).finally(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    await entry.eviction;
  }

  #reconcileEviction(key: string, entry: RuntimeEntry): void {
    if (this.#closed || this.#entries.get(key) !== entry) {
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      return;
    }
    if (
      (entry.runtime?.hub.subscriberCount ?? 0) > 0 ||
      !entry.runtime?.actor.canEvict
    ) {
      entry.idleSince = undefined;
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      return;
    }
    if (entry.references > 0) {
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      return;
    }
    if (entry.evictionTimer || this.#closed) return;
    entry.idleSince ??= Date.now();
    entry.evictionTimer = setTimeout(
      () => {
        entry.evictionTimer = undefined;
        void this.#evictIfIdle(key, entry).catch(() => undefined);
      },
      Math.max(0, entry.idleSince + this.#retentionMilliseconds - Date.now()),
    );
    entry.evictionTimer.unref();
  }

  async #evictIfIdle(key: string, entry: RuntimeEntry): Promise<void> {
    if (
      this.#closed ||
      this.#entries.get(key) !== entry ||
      entry.references > 0 ||
      (entry.runtime?.hub.subscriberCount ?? 0) > 0
    ) {
      return;
    }
    const runtime = await entry.promise;
    if (
      this.#closed ||
      this.#entries.get(key) !== entry ||
      entry.references > 0 ||
      runtime.hub.subscriberCount > 0
    ) {
      return;
    }
    if (!runtime.actor.canEvict) {
      return;
    }
    const eviction = this.#dispose(runtime);
    entry.eviction = eviction;
    try {
      await eviction;
    } finally {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    }
  }

  #tryStartPressureRetirement(
    key: string,
    expectedEntry: RuntimeEntry,
  ): Promise<void> | undefined {
    if (
      this.#closed ||
      this.#maintenance.has(key) ||
      this.#entries.get(key) !== expectedEntry ||
      expectedEntry.eviction ||
      expectedEntry.references > 0 ||
      !expectedEntry.runtime ||
      expectedEntry.runtime.hub.subscriberCount > 0 ||
      !expectedEntry.runtime.actor.canEvict
    ) {
      return undefined;
    }
    if (expectedEntry.evictionTimer) {
      clearTimeout(expectedEntry.evictionTimer);
      expectedEntry.evictionTimer = undefined;
    }
    let begin!: () => void;
    const gate = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let retirementProven = false;
    let runtimeWasBusy = false;
    let maintenance!: Promise<void>;
    maintenance = (async () => {
      await gate;
      try {
        await this.#retireClaimedRuntime(key, expectedEntry);
      } catch (error) {
        runtimeWasBusy = error instanceof ThreadRuntimeNotIdleError;
        if (runtimeWasBusy) {
          throw new ConversationRuntimeReclamationRaceError();
        }
        if (error instanceof ThreadRuntimeRetirementUnprovenError) {
          throw error;
        }
        throw new ThreadRuntimeRetirementUnprovenError(error);
      }
      retirementProven = true;
    })();
    this.#maintenance.set(key, maintenance);
    expectedEntry.eviction = maintenance;
    begin();
    void maintenance
      .finally(() => {
        if (
          (retirementProven || runtimeWasBusy) &&
          this.#maintenance.get(key) === maintenance
        ) {
          this.#maintenance.delete(key);
        }
        if (
          runtimeWasBusy &&
          this.#entries.get(key) === expectedEntry &&
          expectedEntry.eviction === maintenance
        ) {
          expectedEntry.eviction = undefined;
          this.#reconcileEviction(key, expectedEntry);
        }
      })
      .catch(() => undefined);
    return maintenance;
  }

  async #retireClaimedRuntime(key: string, entry: RuntimeEntry): Promise<void> {
    if (this.#entries.get(key) !== entry) {
      if (this.#closed) return;
      throw new ThreadRuntimeNotIdleError();
    }
    if (
      entry.references > 0 ||
      !entry.runtime ||
      entry.runtime.hub.subscriberCount > 0
    ) {
      throw new ThreadRuntimeNotIdleError();
    }
    const runtime = entry.runtime;
    if (!runtime.actor.canEvict) throw new ThreadRuntimeNotIdleError();
    await this.#dispose(runtime);
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }

  async #releaseIdleRuntime(key: string): Promise<void> {
    while (true) {
      const entry = this.#entries.get(key);
      if (!entry) return;
      if (entry.eviction) {
        await entry.eviction;
        continue;
      }
      if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
      const runtime = entry.runtime;
      if (!runtime) {
        const reason = new Error("thread_runtime_maintenance");
        entry.establishmentAbort.abort(reason);
        try {
          await entry.promise;
          // Establishment may have crossed its last abort boundary. Its then
          // handler publishes `entry.runtime`; loop so that exact runtime is
          // closed instead of dropping the map entry and leaking its lease.
          continue;
        } catch (error) {
          if (error !== reason) throw error;
        }
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        continue;
      }
      if (!runtime.actor.canEvict) throw new ThreadRuntimeNotIdleError();
      await this.#dispose(runtime);
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    }
  }

  async #releasePreviewedRuntime(
    key: string,
    expected: ThreadForceResetConversationRuntimeBlocker | undefined,
  ): Promise<void> {
    const entry = this.#entries.get(key);
    if (!entry) {
      if (expected) throw new ConversationActorRetirementStaleError();
      return;
    }
    if (!expected || entry.eviction) throw new ConversationActorRetirementStaleError();
    if (entry.references > 0) throw new ThreadRuntimeNotIdleError();
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    entry.evictionTimer = undefined;
    if (!entry.runtime) {
      if (expected.generation !== entry.generation || expected.runState !== "starting") {
        throw new ConversationActorRetirementStaleError();
      }
      const reason = new Error("thread_runtime_maintenance");
      entry.establishmentAbort.abort(reason);
      try {
        await entry.promise;
      } catch (error) {
        if (error !== reason) throw error;
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        return;
      }
      // A runtime that crossed the final establishment boundary has different
      // actor evidence and needs a fresh preview before an active close.
      throw new ConversationActorRetirementStaleError();
    }
    if (!runtimeMatches(entry.runtime, expected)) {
      throw new ConversationActorRetirementStaleError();
    }
    await this.#dispose(entry.runtime);
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }

  async #dispose(runtime: EstablishedRuntime): Promise<void> {
    if (this.#detached.has(runtime)) return;
    this.#detached.add(runtime);
    const failures: unknown[] = [];
    try {
      runtime.unsubscribeActorClosed();
    } catch (error) {
      failures.push(error);
    }
    try {
      runtime.unsubscribeSubscriberCount();
    } catch (error) {
      failures.push(error);
    }
    try {
      runtime.unsubscribeApplicationSummary();
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.interaction.release();
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.bridge.release();
    } catch (error) {
      failures.push(error);
    }
    runtime.actorRelease();
    runtime.releaseHub();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Thread runtime bindings did not close cleanly.",
      );
    }
  }

  #detach(runtime: EstablishedRuntime): void {
    if (this.#detached.has(runtime)) return;
    this.#detached.add(runtime);
    try {
      runtime.unsubscribeActorClosed();
    } catch {
      // Local detachment continues; later owners retain their safety gates.
    }
    try {
      runtime.unsubscribeSubscriberCount();
    } catch {
      // Local detachment continues; later owners retain their safety gates.
    }
    try {
      runtime.unsubscribeApplicationSummary();
    } catch {
      // Local detachment continues; later owners retain their safety gates.
    }
    runtime.interaction.detach();
    runtime.bridge.detach();
    runtime.actorRelease();
    runtime.releaseHub();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function runtimeMatches(
  runtime: EstablishedRuntime,
  expected: ThreadForceResetConversationRuntimeBlocker,
): boolean {
  if (runtime.actor.closed) return false;
  const timeline = runtime.actor.timeline;
  return (
    timeline.generation === expected.generation &&
    timeline.runState === expected.runState &&
    timeline.activeTurnId === expected.activeTurnId
  );
}

async function abortable<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
