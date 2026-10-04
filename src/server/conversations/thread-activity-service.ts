import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClientOrigin, ThreadInputContext } from "../../shared/protocol/thread-input.js";
import { DirectInputRepository } from "../db/repositories/direct-input-repository.js";
import { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConversationInputRuntimeObservation, ConversationActorManager } from "./conversation-actor-manager.js";
import type { ThreadApplicationPresentationReader } from "./thread-application-service.js";
import { initialThreadSettingsReady } from "./thread-input-readiness.js";
import { DomainError } from "../domain/errors.js";

type RecognitionTarget = { readonly threadId: string; readonly activityToken: string; readonly sourceTurnId?: string };
type ActivityRecord = {
  scope: RequestScope;
  token: string;
  durable: string;
  runtime: string;
  observation?: ConversationInputRuntimeObservation;
};
type DurableObservation = {
  backingState: string;
  availability: string;
  activityRevision: number;
  inventoryState: string;
  workspaceAvailable: string;
  workspaceRemovedAt: number | null;
  projectRemovedAt: number | null;
  pending: number;
  recovery: number;
};
type Captured = {
  readonly context: ThreadInputContext;
  readonly observation?: ConversationInputRuntimeObservation;
  /** A bound owner is replacing its retained snapshot; authority is neither current nor lost. */
  readonly pending: boolean;
};
type Waiter = {
  scope: RequestScope;
  target: RecognitionTarget;
  deadline: number;
  resolve: (target: RecognitionTarget | undefined) => void;
};
type ReplacementWaiter = { scope: RequestScope; threadId: string; deadline: number; resolve: () => void };
const MAX_ACTIVITY_CONTEXTS = 4_096;
const MAX_SETTLEMENT_WAITERS = 256;
const SETTLEMENT_TIMEOUT_MILLISECONDS = 5_000;

function key(scope: Pick<RequestScope, "tenantId" | "principalId">, threadId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${threadId}`;
}
function terminal(observation?: ConversationInputRuntimeObservation): boolean {
  return observation?.sourceTurnStatus === "completed" || observation?.sourceTurnStatus === "failed" || observation?.sourceTurnStatus === "interrupted";
}
function settling(observation?: ConversationInputRuntimeObservation): boolean {
  return observation?.authoritative === true || observation?.reestablishing === true;
}
// Semantic facts only. The owner generation fences eviction, restart, and owner
// replacement; projection generation is excluded so an equivalent replacement
// snapshot, and the retained facts observed while it is installed, keep the token.
function runtimeKey(observation?: ConversationInputRuntimeObservation): string {
  return JSON.stringify(observation ? [
    observation.ownerGeneration, settling(observation), observation.runState, observation.settled,
    observation.sourceTurnId, observation.sourceTurnStatus, observation.blockingInteractionIds,
  ] : null);
}

/** Local, non-attaching activity authority. Tokens are never reused after eviction or restart. */
export class ThreadActivityService {
  readonly #states = new Map<string, ActivityRecord>();
  readonly #waiters = new Set<Waiter>();
  readonly #replacements = new Set<ReplacementWaiter>();
  readonly #origins: DirectInputRepository;
  readonly #queue: QueuedInputRepository;
  readonly #unsubscribe: () => void;
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(readonly input: {
    readonly database: Database.Database;
    readonly actors: Pick<ConversationActorManager, "observeInputRuntime" | "subscribeInputActivity">;
    readonly presentation: Pick<ThreadApplicationPresentationReader, "readCached">;
    readonly now?: () => number;
  }) {
    this.#origins = new DirectInputRepository(input.database);
    this.#queue = new QueuedInputRepository(input.database);
    this.#unsubscribe = input.actors.subscribeInputActivity((scope, threadId) => {
      const stateKey = key(scope, threadId);
      const before = this.#states.get(stateKey);
      if (!before) return;
      // Text deltas do not change input authority. Avoid querying durable state
      // for every streamed token while still observing every readiness edge,
      // including the end of an equivalent in-place replacement.
      const observation = input.actors.observeInputRuntime(scope, threadId);
      if (before.runtime === runtimeKey(observation) &&
          (observation?.reestablishing ?? false) === (before.observation?.reestablishing ?? false)) return;
      try { this.#capture(before.scope, threadId); } catch { this.#states.delete(stateKey); }
      this.#drainWaiters();
    });
  }

  async capture(scope: RequestScope, threadId: string): Promise<ThreadInputContext> {
    // Authorize before waiting or reading presentation, then capture current
    // authority again after the cached (non-attaching) policy read. An in-place
    // replacement is pending, not lost: answer from its outcome within the
    // settlement bound, since a caller re-checks only once. No provider call.
    const deadline = this.#now() + SETTLEMENT_TIMEOUT_MILLISECONDS;
    let observed = this.#capture(scope, threadId);
    if (observed.pending) observed = await this.#afterReplacement(observed, scope, threadId, deadline);
    const before = observed.context;
    if (before.authority !== "current" || this.#closed) return before;
    const presentation = await this.input.presentation.readCached(scope, threadId);
    observed = this.#capture(scope, threadId);
    if (observed.pending) observed = await this.#afterReplacement(observed, scope, threadId, deadline);
    const current = observed.context;
    if (before.activityToken !== current.activityToken) {
      return { ...current, automaticListenEligible: false, steer: { availability: "unavailable" } };
    }
    const interactive = presentation.interactionMode === "interactive";
    return { ...current,
      automaticListenEligible: current.automaticListenEligible && interactive && initialThreadSettingsReady(presentation),
      steer: interactive ? current.steer : { availability: "unsupported" },
    };
  }

  async #afterReplacement(captured: Captured, scope: RequestScope, threadId: string, deadline: number): Promise<Captured> {
    while (captured.pending && !this.#closed && this.#now() < deadline && this.#replacements.size < MAX_SETTLEMENT_WAITERS) {
      await new Promise<void>(resolve => {
        this.#replacements.add({ scope: { ...scope }, threadId, deadline, resolve });
        this.#startTimer();
      });
      captured = this.#capture(scope, threadId);
    }
    return captured;
  }

  #capture(scope: RequestScope, threadId: string): Captured {
    const stored = this.input.database.prepare(`SELECT
      thread.backing_state AS backingState, thread.availability,
      thread.input_activity_revision AS activityRevision, inventory.inventory_state AS inventoryState,
      workspace.availability AS workspaceAvailable, workspace.removed_at AS workspaceRemovedAt,
      project.removed_at AS projectRemovedAt,
      EXISTS (SELECT 1 FROM queued_inputs q WHERE q.tenant_id = thread.tenant_id
        AND q.owner_principal_id = thread.owner_principal_id AND q.application_thread_id = thread.id
        AND (q.state IN ('pending','retry_wait','dispatching','uncertain')
          OR (q.state = 'failed' AND q.failure_acknowledged_at IS NULL))) AS pending,
      (EXISTS (SELECT 1 FROM mutation_receipts receipt WHERE receipt.tenant_id = thread.tenant_id
        AND receipt.principal_id = thread.owner_principal_id AND receipt.thread_id = thread.id
        AND receipt.result_code IN ('prepared','uncertain','pending_materialization'))
        OR EXISTS (SELECT 1 FROM conversation_creation_attempts attempt WHERE attempt.tenant_id = thread.tenant_id
          AND attempt.owner_principal_id = thread.owner_principal_id AND attempt.application_thread_id = thread.id
          AND attempt.force_reset_at IS NULL AND attempt.phase NOT IN ('bound','aborted_unpersisted'))) AS recovery
      FROM application_threads thread
      JOIN thread_principal_state inventory ON inventory.tenant_id = thread.tenant_id
        AND inventory.principal_id = thread.owner_principal_id AND inventory.thread_id = thread.id
      JOIN workspaces workspace ON workspace.tenant_id = thread.tenant_id
        AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
      JOIN projects project ON project.tenant_id = workspace.tenant_id
        AND project.owner_principal_id = workspace.owner_principal_id AND project.id = workspace.project_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?
    `).get(scope.tenantId, scope.principalId, threadId) as DurableObservation | undefined;
    if (!stored) throw new DomainError("not_found", "The input target is unavailable.");
    const observation = this.input.actors.observeInputRuntime(scope, threadId);
    const durable = JSON.stringify([
      stored.activityRevision, stored.backingState, stored.availability,
      stored.inventoryState, stored.workspaceAvailable, stored.workspaceRemovedAt, stored.projectRemovedAt,
    ]);
    const runtime = runtimeKey(observation);
    const stateKey = key(scope, threadId);
    const before = this.#states.get(stateKey);
    // A terminal bookend and its matching idle are one boundary, including when
    // either side is observed through an equivalent replacement snapshot. Every
    // other transition, including running again after idle, creates a fresh token.
    const matchingSettlement = before?.durable === durable && terminal(before.observation) && terminal(observation) &&
      before.observation?.ownerGeneration === observation?.ownerGeneration &&
      before.observation?.sourceTurnId === observation?.sourceTurnId &&
      settling(before.observation) && settling(observation) &&
      !before.observation?.settled && observation?.settled &&
      JSON.stringify(before.observation?.blockingInteractionIds) === JSON.stringify(observation?.blockingInteractionIds);
    const token = before && (before.durable === durable && before.runtime === runtime || matchingSettlement)
      ? before.token : randomUUID();
    this.#states.delete(stateKey);
    this.#states.set(stateKey, { scope: { ...scope }, token, durable, runtime, ...(observation ? { observation } : {}) });
    while (this.#states.size > MAX_ACTIVITY_CONTEXTS) this.#states.delete(this.#states.keys().next().value!);
    const targetAvailable = stored.availability === "available" && stored.workspaceAvailable === "available" &&
      stored.workspaceRemovedAt === null && stored.projectRemovedAt === null &&
      stored.inventoryState !== "archived" && stored.inventoryState !== "snoozed";
    const authority = stored.backingState === "unbound" ? "unbound"
      : stored.backingState === "bound" && observation?.authoritative ? "current" : "unavailable";
    const steerSupported = observation?.backendCapabilities.deliveryModes.includes("steer") === true;
    const steerKind = observation?.backendCapabilities.steerTarget;
    // Admission queues a Steer behind this same predicate, so never advertise one it would not admit.
    const steerTarget = authority === "current" && targetAvailable && stored.recovery === 0 &&
      observation?.runState === "running" && steerSupported && !this.#queue.hasSteerBlockingInput(scope, threadId)
      ? steerKind === "conversation" ? { kind: "conversation" as const }
        : steerKind === "turn" && observation.activeTurnId ? { kind: "turn" as const, turnId: observation.activeTurnId } : undefined
      : undefined;
    return {
      observation,
      pending: stored.backingState === "bound" && observation?.reestablishing === true,
      context: {
        threadId, activityToken: token, authority,
        runState: observation?.runState ?? null,
        ...(observation?.sourceTurnId ? { sourceTurnId: observation.sourceTurnId } : {}),
        automaticListenEligible: !this.#closed && targetAvailable && authority === "current" &&
          observation!.settled && observation!.backendCapabilities.deliveryModes.includes("submit") && observation!.blockingInteractionIds.length === 0 &&
          stored.pending === 0 && stored.recovery === 0,
        steer: authority !== "current" ? { availability: "unavailable" }
          : steerTarget ? { availability: "available", target: steerTarget }
          : steerSupported ? { availability: "unavailable" } : { availability: "unsupported" },
      },
    };
  }

  originForTurn(scope: RequestScope, threadId: string, turnId: string): ClientOrigin | undefined {
    const observed = this.input.actors.observeInputRuntime(scope, threadId, turnId);
    return this.#origins.turnOrigin(scope, threadId, turnId,
      observed?.sourceTurnId === turnId ? observed.firstInput : undefined);
  }

  /** Total: voice context failures degrade to announce-only and never block the notification itself. */
  notificationContext(scope: RequestScope, threadId: string, sourceTurnId?: string): {
    readonly origin?: ClientOrigin;
    readonly recognitionTarget?: RecognitionTarget;
    readonly settlement?: Promise<RecognitionTarget | undefined>;
  } {
    let provenance: { readonly origin?: ClientOrigin } = {};
    try {
      const origin = sourceTurnId ? this.originForTurn(scope, threadId, sourceTurnId) : undefined;
      if (origin) provenance = { origin };
    } catch { /* Advisory attribution is optional; announce without it. */ }
    try {
      const { context: current, observation, pending } = this.#capture(scope, threadId);
      if (this.#closed || current.authority !== "current" && !pending ||
          sourceTurnId && current.sourceTurnId !== sourceTurnId) return provenance;
      const target: RecognitionTarget = { threadId, activityToken: current.activityToken,
        ...(sourceTurnId ? { sourceTurnId } : {}) };
      if (!sourceTurnId || !terminal(observation) || observation?.authoritative && observation.settled) {
        return { ...provenance, recognitionTarget: target };
      }
      // A terminal turn awaits its matching settlement, including one observed
      // through an equivalent replacement snapshot that is still being installed.
      if (this.#waiters.size >= MAX_SETTLEMENT_WAITERS) return provenance;
      const settlement = new Promise<RecognitionTarget | undefined>(resolve => {
        this.#waiters.add({ scope: { ...scope }, target, deadline: this.#now() + SETTLEMENT_TIMEOUT_MILLISECONDS, resolve });
      });
      this.#startTimer();
      return { ...provenance, recognitionTarget: target, settlement };
    } catch { return provenance; }
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const waiter of this.#waiters) waiter.resolve(undefined);
    this.#waiters.clear();
    for (const waiter of this.#replacements) waiter.resolve();
    this.#replacements.clear();
    this.#states.clear();
  }

  #now(): number { return (this.input.now ?? Date.now)(); }

  #startTimer(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#drainWaiters(), 25);
    this.#timer.unref?.();
  }

  #drainWaiters(): void {
    for (const waiter of this.#waiters) {
      let captured: Captured | undefined;
      try { captured = this.#capture(waiter.scope, waiter.target.threadId); } catch { /* Target disappeared. */ }
      let done = true;
      let result: RecognitionTarget | undefined;
      // Loss of authority or the deadline releases announce-only speech; newer
      // activity releases the original, now stale, target; replacement keeps waiting.
      if (!captured || this.#now() >= waiter.deadline || captured.context.authority !== "current" && !captured.pending) result = undefined;
      else if (captured.context.activityToken !== waiter.target.activityToken) result = waiter.target;
      else if (captured.pending || !captured.observation?.settled) done = false;
      else result = waiter.target;
      if (done) { this.#waiters.delete(waiter); waiter.resolve(result); }
    }
    for (const waiter of this.#replacements) {
      let pending = false;
      try { pending = this.#capture(waiter.scope, waiter.threadId).pending; } catch { /* Answered by the re-capture. */ }
      if (!pending || this.#now() >= waiter.deadline) { this.#replacements.delete(waiter); waiter.resolve(); }
    }
    if (this.#waiters.size === 0 && this.#replacements.size === 0) { clearInterval(this.#timer); this.#timer = undefined; }
  }
}
