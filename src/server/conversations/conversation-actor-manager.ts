import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type { NonblockingQuestionsPayload } from "../../shared/protocol/questions.js";
import {
  BackendError,
  type ConversationBackendDriver,
  type ConversationBinding,
} from "../backends/contracts.js";
import type {
  ExecutionEnvironmentProvider,
  ExecutionScope,
  ValidatedWorkspace,
} from "../execution/contracts.js";
import { callRuntime } from "../runtime/runtime-errors.js";
import type { ComposerAttachmentDeliveryService } from "../composer-attachments/composer-attachment-delivery-service.js";
import { ConversationActor } from "./conversation-actor.js";
import { ConversationProjector } from "./conversation-projector.js";
import { assertConversationRetentionMilliseconds } from "./conversation-retention-policy.js";
import { assertConversationRuntimeBudget } from "./conversation-runtime-budget-policy.js";
import type { DeliveryInputSnapshotRepository } from "../db/repositories/delivery-input-snapshot-repository.js";
import type { BoundedText } from "../../shared/protocol/payload.js";

export interface AcquireConversationActorInput {
  readonly scope: ExecutionScope;
  readonly binding: ConversationBinding;
  readonly workspace: ValidatedWorkspace;
  readonly opaqueBindingDetail: string;
  readonly driver: ConversationBackendDriver;
}

export interface AcquiredConversationActor {
  readonly actor: ConversationActor;
  release(): void;
}

export interface AcquireConversationActorOptions {
  readonly idleRelease: "retain" | "evict";
}

export type ConversationActorRetirementDisposition =
  | { readonly kind: "idle" }
  | {
      readonly kind: "explicit_detach";
      readonly expected: Parameters<ConversationActor["closeIfCurrent"]>[0];
    };

export class ConversationActorRetirementStaleError extends Error {
  constructor() {
    super("The conversation runtime changed after maintenance preview.");
    this.name = "ConversationActorRetirementStaleError";
  }
}

export interface ConversationRuntimePressureReclamation {
  readonly actorKey: string;
  readonly completion: Promise<void>;
}

export interface ConversationRuntimePressureBoundary {
  readonly actorKey: string;
  readonly idleSince: number;
}

export interface ConversationRuntimeBudgetScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly executionEnvironmentId: string;
}

export interface ConversationRuntimePressureRequest {
  readonly budgetScope: ConversationRuntimeBudgetScope;
  readonly olderThan?: ConversationRuntimePressureBoundary;
}

export type ConversationRuntimePressureReclaimer = (
  request: ConversationRuntimePressureRequest,
) => ConversationRuntimePressureReclamation | undefined;

export type AuthoritativeCompletionObserver = (
  scope: ExecutionScope,
  applicationThreadId: string,
  input: {
    readonly backendCorrelation: string;
    readonly backendTurnId: string;
    readonly applicationTurnId: string;
    readonly completionIdentity: string;
    readonly outcome: "completed" | "interrupted" | "failed";
    readonly result: BoundedText;
    readonly classifiedResult: ClassifiedAssistantResult | null;
  },
) => void | Promise<void>;

export type AuthoritativeSubmissionObserver = (
  scope: ExecutionScope,
  applicationThreadId: string,
  input: {
    readonly backendCorrelation: string;
    readonly backendTurnId: string;
  },
) => void | Promise<void>;

interface ActorEntry {
  promise: Promise<ConversationActor>;
  readonly fingerprint: string;
  readonly budgetScope: ConversationRuntimeBudgetScope;
  readonly creationAbort: AbortController;
  references: number;
  evictionTimer?: ReturnType<typeof setTimeout>;
  eviction?: Promise<boolean>;
  poisoned?: unknown;
  actor?: ConversationActor;
  pendingIdleRelease?: AcquireConversationActorOptions["idleRelease"];
  idleSince?: number;
  pressureSlotClaimed?: boolean;
}

interface ActorMaintenance {
  readonly completion: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

class ConversationActorCreationAbortedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Conversation actor creation was cancelled.", options);
    this.name = "ConversationActorCreationAbortedError";
  }
}

class ConversationActorCreationCleanupError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Conversation actor creation and cleanup failed.", {
      cause: errors[0],
    });
    this.name = "ConversationActorCreationCleanupError";
  }
}

export class ConversationRuntimeReclamationRaceError extends Error {
  constructor() {
    super("The selected conversation runtime became active.");
    this.name = "ConversationRuntimeReclamationRaceError";
  }
}

export class ConversationActorRetirementBusyError extends Error {
  constructor() {
    super("The conversation actor is not idle.");
    this.name = "ConversationActorRetirementBusyError";
  }
}

export class ConversationActorRetirementUnprovenError extends Error {
  constructor(cause: unknown) {
    super("Conversation actor retirement could not be proven.", { cause });
    this.name = "ConversationActorRetirementUnprovenError";
  }
}

function actorKey(input: AcquireConversationActorInput): string {
  return [
    input.scope.tenantId,
    input.scope.principalId,
    input.binding.applicationThreadId,
  ].join("\0");
}

function scopedActorKey(
  scope: Pick<ExecutionScope, "tenantId" | "principalId">,
  applicationThreadId: string,
): string {
  return [scope.tenantId, scope.principalId, applicationThreadId].join("\0");
}

function actorFingerprint(input: AcquireConversationActorInput): string {
  return JSON.stringify([
    input.binding.backendInstanceId,
    input.binding.connectionProfileId,
    input.binding.executionEnvironmentId,
    input.binding.backendConversationId,
    input.workspace.summary.id,
    input.workspace.canonicalPath,
    input.workspace.authorityRevision,
    input.opaqueBindingDetail,
  ]);
}

function validateScope(input: AcquireConversationActorInput): void {
  if (
    input.binding.tenantId !== input.scope.tenantId ||
    input.binding.ownerPrincipalId !== input.scope.principalId ||
    input.binding.executionEnvironmentId !==
      input.workspace.summary.environmentId
  ) {
    throw new Error("conversation_actor_scope_mismatch");
  }
}

function sameRuntimeBudgetScope(
  left: ConversationRuntimeBudgetScope,
  right: ConversationRuntimeBudgetScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.executionEnvironmentId === right.executionEnvironmentId
  );
}

type HistoricalQuestionObserver = (
  scope: ExecutionScope,
  threadId: string,
  sourceItemId: string,
) => void;
type NonblockingQuestionObserver = (
  scope: ExecutionScope,
  threadId: string,
  sourceItemId: string,
  payload: NonblockingQuestionsPayload,
) => void;

export class ConversationActorManager {
  readonly #onNonblockingQuestions?: NonblockingQuestionObserver;
  readonly #onHistoricalQuestion?: HistoricalQuestionObserver;
  readonly #environments: ExecutionEnvironmentProvider;
  readonly #attachmentDelivery: ComposerAttachmentDeliveryService;
  readonly #deliveryInputSnapshots?: DeliveryInputSnapshotRepository;
  readonly #retentionMilliseconds: number;
  readonly #runtimeBudget: number;
  readonly #onAuthoritativeCompletion?: AuthoritativeCompletionObserver;
  readonly #onAuthoritativeSubmission?: AuthoritativeSubmissionObserver;
  readonly #entries = new Map<string, ActorEntry>();
  readonly #maintenance = new Map<string, ActorMaintenance>();
  #pressureReclaimer?: ConversationRuntimePressureReclaimer;
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(input: {
    readonly environments: ExecutionEnvironmentProvider;
    readonly attachmentDelivery: ComposerAttachmentDeliveryService;
    readonly deliveryInputSnapshots?: DeliveryInputSnapshotRepository;
    readonly retentionMilliseconds: number;
    readonly runtimeBudget: number;
    readonly onAuthoritativeCompletion?: AuthoritativeCompletionObserver;
    readonly onAuthoritativeSubmission?: AuthoritativeSubmissionObserver;
    readonly onNonblockingQuestions?: NonblockingQuestionObserver;
    readonly onHistoricalQuestion?: HistoricalQuestionObserver;
  }) {
    this.#environments = input.environments;
    this.#attachmentDelivery = input.attachmentDelivery;
    this.#deliveryInputSnapshots = input.deliveryInputSnapshots;
    this.#onAuthoritativeCompletion = input.onAuthoritativeCompletion;
    this.#onAuthoritativeSubmission = input.onAuthoritativeSubmission;
    this.#onNonblockingQuestions = input.onNonblockingQuestions;
    this.#onHistoricalQuestion = input.onHistoricalQuestion;
    assertConversationRetentionMilliseconds(input.retentionMilliseconds);
    this.#retentionMilliseconds = input.retentionMilliseconds;
    assertConversationRuntimeBudget(input.runtimeBudget);
    this.#runtimeBudget = input.runtimeBudget;
  }

  bindPressureReclaimer(reclaimer: ConversationRuntimePressureReclaimer): void {
    if (this.#pressureReclaimer) {
      throw new Error("conversation_runtime_pressure_reclaimer_already_bound");
    }
    this.#pressureReclaimer = reclaimer;
  }

  async acquire(
    input: AcquireConversationActorInput,
    options: AcquireConversationActorOptions,
  ): Promise<AcquiredConversationActor> {
    if (this.#closing) {
      throw new Error("conversation_actor_manager_closing");
    }
    validateScope(input);
    const key = actorKey(input);
    const fingerprint = actorFingerprint(input);
    let replacementAttempted = false;
    while (true) {
      if (this.#closing) {
        throw new Error("conversation_actor_manager_closing");
      }
      const maintenance = this.#maintenance.get(key);
      if (maintenance) {
        await maintenance.completion;
        throw new BackendError({
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage:
            "The thread changed while its conversation runtime was being retired. Resolve the thread again and retry.",
          backendCode: "conversation_actor_admission_invalidated",
        });
      }
      let entry = this.#entries.get(key);
      if (!entry) {
        const budgetScope = Object.freeze({
          tenantId: input.scope.tenantId,
          principalId: input.scope.principalId,
          executionEnvironmentId: input.binding.executionEnvironmentId,
        });
        const admission = this.#reserveRuntimeSlot(budgetScope);
        const creationAbort = new AbortController();
        const createdEntry = {
          fingerprint,
          budgetScope,
          creationAbort,
          references: 0,
        } as ActorEntry;
        createdEntry.promise = (async () => {
          if (admission) await this.#awaitPressureReclamation(admission);
          if (creationAbort.signal.aborted) {
            throw new ConversationActorCreationAbortedError({
              cause: creationAbort.signal.reason,
            });
          }
          return this.#createActor(input, creationAbort.signal, () =>
            this.#reconcileEviction(key, createdEntry),
          );
        })().then((actor) => {
          createdEntry.actor = actor;
          return actor;
        });
        entry = createdEntry;
        this.#entries.set(key, createdEntry);
        void createdEntry.promise.catch((error) => {
          if (this.#entries.get(key) === createdEntry) {
            if (error instanceof ConversationActorCreationCleanupError) {
              createdEntry.poisoned = error;
            } else {
              this.#entries.delete(key);
            }
          }
        });
      } else {
        if (entry.actor?.closed) {
          if (!entry.actor.replacementSafe) {
            entry.poisoned ??= new Error("conversation_actor_close_unproven");
          } else {
            this.#entries.delete(key);
            continue;
          }
        }
        if (entry.fingerprint !== fingerprint) {
          throw new Error("conversation_actor_binding_conflict");
        }
      }
      if (entry.poisoned) {
        throw new Error("conversation_actor_close_unproven", {
          cause: entry.poisoned,
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
      entry.references += 1;
      let actor: ConversationActor | undefined;
      try {
        actor = await entry.promise;
        await actor.ensureProjectionCurrent();
      } catch (error) {
        this.#release(key, entry, options.idleRelease);
        if (error instanceof ConversationRuntimeReclamationRaceError) {
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
          continue;
        }
        if (
          actor !== undefined &&
          actor.replacementRequired &&
          !replacementAttempted &&
          (await this.#retireForReplacement(key, entry, actor))
        ) {
          replacementAttempted = true;
          continue;
        }
        throw error;
      }
      if (this.#closing) {
        this.#release(key, entry, options.idleRelease);
        throw new Error("conversation_actor_manager_closing");
      }
      let released = false;
      return {
        actor,
        release: () => {
          if (released) return;
          released = true;
          this.#release(key, entry!, options.idleRelease);
        },
      };
    }
  }

  /**
   * Blocks every acquisition path for one application thread, detaches its
   * coordinator-owned lease, proves that no direct borrowers remain, and
   * keeps the actor retired through the supplied operation.
   */
  async runWithRuntimeRetired<Result>(input: {
    readonly scope: Pick<ExecutionScope, "tenantId" | "principalId">;
    readonly applicationThreadId: string;
    readonly detachCoordinatorRuntime: () => Promise<void>;
    readonly disposition: ConversationActorRetirementDisposition;
    readonly operation: () => Promise<Result>;
  }): Promise<Result> {
    const key = scopedActorKey(input.scope, input.applicationThreadId);
    while (true) {
      if (this.#closing) throw new Error("conversation_actor_manager_closing");
      const existing = this.#maintenance.get(key);
      if (existing) {
        await existing.completion;
        continue;
      }

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const completion = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      // A retained rejected fence is intentionally observed here and by every
      // later acquisition without becoming an unhandled process rejection.
      void completion.catch(() => undefined);
      const maintenance = { completion, resolve, reject };
      this.#maintenance.set(key, maintenance);
      let retirementUnproven:
        ConversationActorRetirementUnprovenError | undefined;
      try {
        try {
          await input.detachCoordinatorRuntime();
          await this.#retireEntryForMaintenance(key, input.disposition);
        } catch (error) {
          if (
            error instanceof ConversationActorRetirementBusyError ||
            error instanceof ConversationActorRetirementStaleError
          ) {
            throw error;
          }
          retirementUnproven =
            error instanceof ConversationActorRetirementUnprovenError
              ? error
              : new ConversationActorRetirementUnprovenError(error);
          throw retirementUnproven;
        }
        return await input.operation();
      } finally {
        if (this.#maintenance.get(key) === maintenance) {
          if (retirementUnproven) {
            maintenance.reject(retirementUnproven);
          } else {
            this.#maintenance.delete(key);
            maintenance.resolve();
          }
        }
      }
    }
  }

  /** Explicit backend/environment Stop owns interruption even while callers hold leases. */
  async runWithRuntimesStopped<Result>(input: {
    readonly scope: Pick<ExecutionScope, "tenantId" | "principalId">;
    readonly applicationThreadIds: readonly string[];
    readonly stopOwnedResources: () => Promise<void>;
    readonly detachCoordinatorRuntimes: () => Promise<void>;
    /** Retire the closed local owner even when the provider refused its command. */
    readonly retireLocalRuntime: () => Promise<Result>;
  }): Promise<Result> {
    const keys = [...new Set(input.applicationThreadIds.map(id => scopedActorKey(input.scope, id)))].sort();
    while (true) {
      if (this.#closing) throw new Error("conversation_actor_manager_closing");
      const existing = keys.flatMap(key => this.#maintenance.get(key)?.completion ?? []);
      if (existing.length) { await Promise.all(existing); continue; }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const completion = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
      void completion.catch(() => undefined);
      const maintenance = { completion, resolve, reject };
      for (const key of keys) this.#maintenance.set(key, maintenance);
      let retirementUnproven: ConversationActorRetirementUnprovenError | undefined;
      try {
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
        // close() fences each established actor synchronously. Do not wait for
        // its mailbox, or detach before the host uses its confirmed observation.
        const closures = Promise.allSettled(keys.map(async key => {
          const entry = this.#entries.get(key);
          if (!entry) return;
          if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
          entry.evictionTimer = undefined;
          entry.creationAbort.abort(new Error("conversation_actor_explicit_stop"));
          try {
            let actor = entry.actor;
            if (!actor) {
              try { actor = await entry.promise; }
              catch (error) {
                if (error instanceof ConversationActorCreationCleanupError || entry.poisoned) throw entry.poisoned ?? error;
                if (this.#entries.get(key) === entry) this.#entries.delete(key);
                return;
              }
            }
            await actor.close(cleanupGate);
            if (!actor.replacementSafe) throw new Error("conversation_actor_close_unproven");
            if (this.#entries.get(key) === entry) this.#entries.delete(key);
          } catch (error) { entry.poisoned = error; throw error; }
        }));
        let effectFailure: unknown;
        let effectFailed = false;
        try { await input.stopOwnedResources(); }
        catch (error) { effectFailed = true; effectFailure = error; }
        finally { releaseCleanup(); }
        const failures = (await closures).flatMap(result => result.status === "rejected" ? [result.reason] : []);
        try { await input.detachCoordinatorRuntimes(); }
        catch (error) { failures.push(error); }
        if (failures.length) {
          retirementUnproven = new ConversationActorRetirementUnprovenError(new AggregateError(failures, "Explicit runtime stop cleanup failed."));
          throw retirementUnproven;
        }
        let value: Result;
        try { value = await input.retireLocalRuntime(); }
        catch (error) {
          retirementUnproven = new ConversationActorRetirementUnprovenError(effectFailed
            ? new AggregateError([effectFailure, error], "Provider command and local runtime retirement failed.") : error);
          throw retirementUnproven;
        }
        if (effectFailed) throw effectFailure;
        return value;
      } finally {
        if (retirementUnproven) maintenance.reject(retirementUnproven);
        else {
          for (const key of keys) if (this.#maintenance.get(key) === maintenance) this.#maintenance.delete(key);
          maintenance.resolve();
        }
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const entries = [...this.#entries.values()];
      for (const entry of entries) {
        if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
        entry.creationAbort.abort();
      }
      const failures: unknown[] = [];
      failures.push(
        ...entries.flatMap(({ poisoned }) =>
          poisoned === undefined ? [] : [poisoned],
        ),
      );
      const evictions = await Promise.allSettled(
        entries.flatMap(({ eviction }) => (eviction ? [eviction] : [])),
      );
      for (const result of evictions) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      const actors = await Promise.allSettled(
        entries.map(({ promise }) => promise),
      );
      await Promise.all(
        actors.map(async (result) => {
          if (result.status === "rejected") {
            if (
              !(result.reason instanceof ConversationActorCreationAbortedError)
            ) {
              failures.push(result.reason);
            }
            return;
          }
          try {
            await result.value.close();
          } catch (error) {
            failures.push(error);
          }
        }),
      );
      this.#entries.clear();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Conversation actor manager did not close cleanly.",
        );
      }
    })();
    return this.#closePromise;
  }

  #release(
    key: string,
    entry: ActorEntry,
    idleRelease: AcquireConversationActorOptions["idleRelease"],
  ): void {
    if (this.#entries.get(key) !== entry || entry.references === 0) return;
    entry.references -= 1;
    if (entry.references > 0 || this.#closing) return;
    if (entry.actor?.closed) {
      if (entry.actor.replacementSafe) this.#entries.delete(key);
      else entry.poisoned ??= new Error("conversation_actor_close_unproven");
      return;
    }
    entry.pendingIdleRelease = idleRelease;
    this.#reconcileEviction(key, entry);
  }

  #reserveRuntimeSlot(
    budgetScope: ConversationRuntimeBudgetScope,
  ): Promise<void> | undefined {
    this.#pruneReplacementSafeEntries();
    if (this.#residentEntryCount(budgetScope) < this.#runtimeBudget) {
      return undefined;
    }

    const alreadyClosing = this.#oldestEntry((entry, key) =>
      Boolean(
        sameRuntimeBudgetScope(entry.budgetScope, budgetScope) &&
        !this.#maintenance.has(key) &&
        entry.eviction &&
        !entry.pressureSlotClaimed,
      ),
    );
    if (alreadyClosing) {
      const [, entry] = alreadyClosing;
      entry.pressureSlotClaimed = true;
      return entry.eviction!.then((closed) => {
        if (!closed) throw new ConversationRuntimeReclamationRaceError();
      });
    }

    const ownVictim = this.#oldestEntry(
      (entry, key) =>
        sameRuntimeBudgetScope(entry.budgetScope, budgetScope) &&
        !this.#maintenance.has(key) &&
        !entry.eviction &&
        !entry.poisoned &&
        entry.references === 0 &&
        entry.pendingIdleRelease !== undefined &&
        Boolean(entry.actor?.canEvict),
    );
    if (ownVictim) ownVictim[1].idleSince ??= Date.now();
    const reclaimed = this.#pressureReclaimer?.({
      budgetScope,
      ...(ownVictim
        ? {
            olderThan: {
              actorKey: ownVictim[0],
              idleSince: ownVictim[1].idleSince!,
            },
          }
        : {}),
    });
    if (reclaimed) {
      const entry = this.#entries.get(reclaimed.actorKey);
      if (
        !entry ||
        !sameRuntimeBudgetScope(entry.budgetScope, budgetScope) ||
        entry.eviction ||
        entry.poisoned
      ) {
        throw new Error(
          "conversation_runtime_pressure_reclaimer_contract_invalid",
        );
      }
      entry.pressureSlotClaimed = true;
      let tracked!: Promise<boolean>;
      tracked = reclaimed.completion
        .then(() => this.#closePressureEntryIfIdle(reclaimed.actorKey, entry))
        .then((closed) => {
          if (!closed) throw new ConversationRuntimeReclamationRaceError();
          return true;
        })
        .catch((error) => {
          if (!(error instanceof ConversationRuntimeReclamationRaceError)) {
            entry.poisoned = error;
          }
          throw error;
        })
        .finally(() => {
          if (
            this.#entries.get(reclaimed.actorKey) === entry &&
            entry.eviction === tracked
          ) {
            entry.pressureSlotClaimed = false;
            if (entry.actor?.closed && entry.actor.replacementSafe) {
              this.#entries.delete(reclaimed.actorKey);
            } else if (!entry.poisoned) {
              entry.eviction = undefined;
              this.#reconcileEviction(reclaimed.actorKey, entry);
            }
          }
        });
      entry.eviction = tracked;
      return tracked.then(() => undefined);
    }
    if (ownVictim) {
      const [key, entry] = ownVictim;
      entry.pressureSlotClaimed = true;
      const eviction = this.#beginEntryEviction(key, entry);
      if (eviction) {
        return eviction.then((closed) => {
          if (!closed) throw new ConversationRuntimeReclamationRaceError();
        });
      }
      entry.pressureSlotClaimed = false;
    }

    throw new BackendError({
      category: "overloaded",
      retryable: true,
      crossedSubmissionBoundary: false,
      safeMessage:
        "All conversation runtime slots on this execution environment are in use. Close or finish an active thread and try again.",
      backendCode: "conversation_runtime_budget_reached",
    });
  }

  async #awaitPressureReclamation(reclamation: Promise<void>): Promise<void> {
    try {
      await reclamation;
    } catch (error) {
      if (error instanceof ConversationRuntimeReclamationRaceError) throw error;
      throw new BackendError(
        {
          category: "unavailable",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage:
            "A retained conversation runtime could not be proven closed. Restart Sedes before trying again.",
          backendCode: "conversation_runtime_reclamation_unproven",
        },
        { cause: error },
      );
    }
  }

  #residentEntryCount(budgetScope: ConversationRuntimeBudgetScope): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (
        sameRuntimeBudgetScope(entry.budgetScope, budgetScope) &&
        !entry.pressureSlotClaimed
      ) {
        count += 1;
      }
    }
    return count;
  }

  #pruneReplacementSafeEntries(): void {
    for (const [key, entry] of this.#entries) {
      if (entry.actor?.closed && entry.actor.replacementSafe) {
        this.#entries.delete(key);
      }
    }
  }

  #oldestEntry(
    eligible: (entry: ActorEntry, key: string) => boolean,
  ): readonly [string, ActorEntry] | undefined {
    let oldest: readonly [string, ActorEntry] | undefined;
    for (const candidate of this.#entries) {
      if (!eligible(candidate[1], candidate[0])) continue;
      if (
        !oldest ||
        (candidate[1].idleSince ?? Number.MAX_SAFE_INTEGER) <
          (oldest[1].idleSince ?? Number.MAX_SAFE_INTEGER) ||
        ((candidate[1].idleSince ?? Number.MAX_SAFE_INTEGER) ===
          (oldest[1].idleSince ?? Number.MAX_SAFE_INTEGER) &&
          candidate[0] < oldest[0])
      ) {
        oldest = candidate;
      }
    }
    return oldest;
  }

  async #retireEntryForMaintenance(
    key: string,
    disposition: ConversationActorRetirementDisposition,
  ): Promise<void> {
    while (true) {
      const entry = this.#entries.get(key);
      if (!entry) {
        if (disposition.kind === "explicit_detach") {
          throw new ConversationActorRetirementStaleError();
        }
        return;
      }
      if (entry.poisoned) {
        throw new ConversationActorRetirementUnprovenError(entry.poisoned);
      }
      if (entry.eviction) {
        try {
          const closed = await entry.eviction;
          if (!closed && this.#entries.get(key) === entry) continue;
        } catch (error) {
          throw new ConversationActorRetirementUnprovenError(error);
        }
        continue;
      }
      if (entry.references > 0) {
        throw new ConversationActorRetirementBusyError();
      }
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      if (!entry.actor) {
        entry.creationAbort.abort(new Error("conversation_actor_maintenance"));
        try {
          await entry.promise;
        } catch (error) {
          if (
            error instanceof ConversationActorCreationCleanupError ||
            entry.poisoned
          ) {
            throw new ConversationActorRetirementUnprovenError(
              entry.poisoned ?? error,
            );
          }
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
          return;
        }
        continue;
      }
      if (disposition.kind === "explicit_detach") {
        try {
          const closed = await entry.actor.closeIfCurrent(disposition.expected);
          if (!closed) throw new ConversationActorRetirementStaleError();
          if (!entry.actor.replacementSafe) {
            throw new Error("conversation_actor_close_unproven");
          }
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
          return;
        } catch (error) {
          if (error instanceof ConversationActorRetirementStaleError) throw error;
          entry.poisoned = error;
          throw new ConversationActorRetirementUnprovenError(error);
        }
      }
      if (!entry.actor.canEvict) {
        throw new ConversationActorRetirementBusyError();
      }
      const eviction = this.#beginEntryEviction(key, entry);
      if (!eviction) {
        if (this.#closing)
          throw new Error("conversation_actor_manager_closing");
        continue;
      }
      let closed: boolean;
      try {
        closed = await eviction;
      } catch (error) {
        throw new ConversationActorRetirementUnprovenError(error);
      }
      if (!closed) throw new ConversationActorRetirementBusyError();
      if (!entry.actor.replacementSafe) {
        throw new ConversationActorRetirementUnprovenError(
          new Error("conversation_actor_close_unproven"),
        );
      }
      return;
    }
  }

  async #closePressureEntryIfIdle(
    key: string,
    entry: ActorEntry,
  ): Promise<boolean> {
    if (this.#entries.get(key) !== entry) return true;
    if (entry.references > 0 || !entry.actor?.canEvict) return false;
    let closed = false;
    try {
      closed = await entry.actor.closeIfIdle();
    } catch (error) {
      entry.poisoned = error;
      throw error;
    }
    if (!closed) return false;
    if (!entry.actor.replacementSafe) {
      const error = new Error("conversation_actor_close_unproven");
      entry.poisoned = error;
      throw error;
    }
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    return true;
  }

  async #retireForReplacement(
    key: string,
    entry: ActorEntry,
    actor: ConversationActor,
  ): Promise<boolean> {
    if (this.#entries.get(key) !== entry) return true;
    let failure: unknown;
    try {
      await actor.close();
    } catch (error) {
      failure = error;
    }
    if (this.#entries.get(key) !== entry) return true;
    if (actor.closed && actor.replacementSafe) {
      this.#entries.delete(key);
      return true;
    }
    entry.poisoned = failure ?? new Error("conversation_actor_close_unproven");
    return false;
  }

  #reconcileEviction(key: string, entry: ActorEntry): void {
    if (
      this.#closing ||
      this.#entries.get(key) !== entry ||
      this.#maintenance.has(key)
    ) {
      if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
      return;
    }
    if (!entry.actor?.canEvict || entry.pendingIdleRelease === undefined) {
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
    if (entry.evictionTimer || entry.eviction || this.#closing) return;
    entry.idleSince ??= Date.now();
    const delay =
      entry.pendingIdleRelease === "retain"
        ? Math.max(
            0,
            entry.idleSince + this.#retentionMilliseconds - Date.now(),
          )
        : 0;
    entry.evictionTimer = setTimeout(() => {
      entry.evictionTimer = undefined;
      void this.#evictIfIdle(key, entry).catch(() => undefined);
    }, delay);
    entry.evictionTimer.unref();
  }

  async #evictIfIdle(key: string, entry: ActorEntry): Promise<void> {
    const eviction = this.#beginEntryEviction(key, entry);
    if (!eviction) return;
    await eviction;
  }

  #beginEntryEviction(
    key: string,
    entry: ActorEntry,
  ): Promise<boolean> | undefined {
    const actor = entry.actor;
    if (
      !actor ||
      this.#closing ||
      this.#entries.get(key) !== entry ||
      entry.references > 0 ||
      entry.eviction ||
      !actor.canEvict
    ) {
      return undefined;
    }
    let closed = false;
    let failure: unknown;
    let eviction!: Promise<boolean>;
    eviction = (async () => {
      try {
        closed = await actor.closeIfIdle();
        return closed;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (this.#entries.get(key) === entry) {
          entry.eviction = undefined;
          entry.pressureSlotClaimed = false;
          if ((closed || actor.closed) && actor.replacementSafe) {
            this.#entries.delete(key);
          } else if (failure || actor.closed) {
            entry.poisoned =
              failure ?? new Error("conversation_actor_close_unproven");
          } else if (!this.#closing && entry.references === 0) {
            this.#reconcileEviction(key, entry);
          }
        }
      }
    })();
    entry.eviction = eviction;
    return eviction;
  }

  async #createActor(
    input: AcquireConversationActorInput,
    signal: AbortSignal,
    onStateChanged: () => void,
  ): Promise<ConversationActor> {
    const lease = await callRuntime(() =>
      this.#environments.acquireLease(input.scope, {
        environmentId: input.binding.executionEnvironmentId,
        workspace: input.workspace,
      }),
    );
    let actor: ConversationActor | undefined;
    let observationChain = Promise.resolve();
    try {
      const handle = await input.driver.attach({
        scope: input.scope,
        binding: input.binding,
        workspace: lease.workspace,
        opaqueBindingDetail: input.opaqueBindingDetail,
      });
      actor = new ConversationActor({
        handle,
        environmentLease: lease,
        attachmentDelivery: this.#attachmentDelivery,
        ...(this.#deliveryInputSnapshots
          ? {
              persistDeliveryInputSnapshot: (snapshot) => {
                this.#deliveryInputSnapshots!.prepare(
                  input.scope,
                  input.binding.applicationThreadId,
                  snapshot,
                );
              },
              removeDeliveryInputSnapshot: (operationId: string) => {
                this.#deliveryInputSnapshots!.remove(
                  input.scope,
                  input.binding.applicationThreadId,
                  operationId,
                );
              },
            }
          : {}),
        initialObserver: (event) => {
          const historyItems =
            event.type === "projection_replaced"
              ? Object.values(event.state.timeline.itemsById)
              : event.type === "projection_events"
                ? event.events.flatMap((entry) =>
                    entry.type === "history_prepend"
                      ? Object.values(entry.page.itemsById)
                      : [],
                  )
                : [];
          for (const item of historyItems) {
            if (
              item.kind === "assistant_message" &&
              item.nonblockingQuestions
            ) {
              this.#onHistoricalQuestion?.(
                input.scope,
                input.binding.applicationThreadId,
                item.nonblockingQuestions.sourceItemId,
              );
            }
          }
          if (event.type === "nonblocking_questions") {
            this.#onNonblockingQuestions?.(
              input.scope,
              input.binding.applicationThreadId,
              event.sourceItemId,
              event.payload,
            );
          }
        },
        drainAuthoritativeObservers: () => observationChain,
        projector: new ConversationProjector({
          backendInstanceId: input.binding.backendInstanceId,
          bindingIdentity: input.binding.applicationThreadId,
          ...(this.#deliveryInputSnapshots
            ? {
                resolveDeliveryInputSnapshot: (operationId: string) =>
                  this.#deliveryInputSnapshots!.find(
                    input.scope,
                    input.binding.applicationThreadId,
                    operationId,
                  ),
              }
            : {}),
        }),
        resolveBranchCheckpoint: (selection) =>
          input.driver.resolveBranchCheckpoint({
            scope: input.scope,
            binding: input.binding,
            workspace: lease.workspace,
            opaqueBindingDetail: input.opaqueBindingDetail,
            selection,
          }),
      });
      await actor.start({ signal });
      // A terminal projection can prove a previously uncertain submission and
      // its completion in the same actor turn. Preserve publication order
      // across asynchronous durable observers. The same subscription drives
      // retention eligibility so active actors are never polled for idleness.
      actor.subscribe((event) => {
        onStateChanged();
        if (
          this.#onAuthoritativeCompletion ||
          this.#onAuthoritativeSubmission
        ) {
          if (
            event.type !== "authoritative_completion" &&
            event.type !== "authoritative_submission"
          ) {
            return;
          }
          observationChain = observationChain
            .then(async () => {
              const observation =
                event.type === "authoritative_submission"
                  ? this.#onAuthoritativeSubmission?.(
                      input.scope,
                      input.binding.applicationThreadId,
                      {
                        backendCorrelation: event.backendCorrelation,
                        backendTurnId: event.backendTurnId,
                      },
                    )
                  : this.#onAuthoritativeCompletion?.(
                      input.scope,
                      input.binding.applicationThreadId,
                      {
                        backendCorrelation: event.backendCorrelation,
                        backendTurnId: event.backendTurnId,
                        applicationTurnId: event.applicationTurnId,
                        completionIdentity: event.completionIdentity,
                        outcome: event.outcome,
                        result: event.result,
                        classifiedResult: event.classifiedResult,
                      },
                    );
              await observation;
            })
            .catch(() => undefined);
        }
      });
      return actor;
    } catch (error) {
      let cleanupError: unknown;
      if (actor) {
        try {
          await actor.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
      } else {
        try {
          await lease.release();
        } catch (releaseError) {
          cleanupError = releaseError;
        }
      }
      if (cleanupError) {
        throw new ConversationActorCreationCleanupError([error, cleanupError]);
      }
      if (signal.aborted) {
        throw new ConversationActorCreationAbortedError({ cause: error });
      }
      throw error;
    }
  }
}
