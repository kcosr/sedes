import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClientOrigin, ThreadInputContext } from "../../shared/protocol/thread-input.js";
import { DirectInputRepository } from "../db/repositories/direct-input-repository.js";
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
type Waiter = {
  scope: RequestScope;
  target: RecognitionTarget;
  deadline: number;
  resolve: (target: RecognitionTarget | undefined) => void;
};
const MAX_ACTIVITY_CONTEXTS = 4_096;
const MAX_SETTLEMENT_WAITERS = 256;

function key(scope: Pick<RequestScope, "tenantId" | "principalId">, threadId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${threadId}`;
}
function terminal(observation?: ConversationInputRuntimeObservation): boolean {
  return observation?.sourceTurnStatus === "completed" || observation?.sourceTurnStatus === "failed" || observation?.sourceTurnStatus === "interrupted";
}
function runtimeKey(observation?: ConversationInputRuntimeObservation): string {
  return JSON.stringify(observation ? [
    observation.generation, observation.authoritative, observation.runState, observation.settled,
    observation.sourceTurnId, observation.sourceTurnStatus, observation.blockingInteractionIds,
  ] : null);
}

/** Local, non-attaching activity authority. Tokens are never reused after eviction or restart. */
export class ThreadActivityService {
  readonly #states = new Map<string, ActivityRecord>();
  readonly #waiters = new Set<Waiter>();
  readonly #origins: DirectInputRepository;
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
    this.#unsubscribe = input.actors.subscribeInputActivity((scope, threadId) => {
      const stateKey = key(scope, threadId);
      const before = this.#states.get(stateKey);
      if (!before) return;
      // Text deltas do not change input authority. Avoid querying durable state
      // for every streamed token while still observing every readiness edge.
      if (before.runtime === runtimeKey(input.actors.observeInputRuntime(scope, threadId))) return;
      try { this.#capture(before.scope, threadId); } catch { this.#states.delete(stateKey); }
      this.#drainWaiters();
    });
  }

  async capture(scope: RequestScope, threadId: string): Promise<ThreadInputContext> {
    // Authorize before reading presentation, then capture current authority again
    // after the cached (non-attaching) policy read. No provider call is allowed here.
    const before = this.#capture(scope, threadId);
    if (before.authority !== "current" || this.#closed) return before;
    const presentation = await this.input.presentation.readCached(scope, threadId);
    const current = this.#capture(scope, threadId);
    if (before.activityToken !== current.activityToken) {
      return { ...current, automaticListenEligible: false, steer: { availability: "unavailable" } };
    }
    const interactive = presentation.interactionMode === "interactive";
    return { ...current,
      automaticListenEligible: current.automaticListenEligible && interactive && initialThreadSettingsReady(presentation),
      steer: interactive ? current.steer : { availability: "unsupported" },
    };
  }

  #capture(scope: RequestScope, threadId: string): ThreadInputContext {
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
    // A terminal bookend and its matching idle are one boundary. Every other
    // transition, including running again after idle, creates a fresh token.
    const matchingSettlement = before?.durable === durable && terminal(before.observation) && terminal(observation) &&
      before.observation?.generation === observation?.generation &&
      before.observation?.sourceTurnId === observation?.sourceTurnId &&
      before.observation?.authoritative && observation?.authoritative &&
      !before.observation?.settled && observation?.settled &&
      JSON.stringify(before.observation.blockingInteractionIds) === JSON.stringify(observation.blockingInteractionIds);
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
    const steerTarget = authority === "current" && targetAvailable && stored.recovery === 0 &&
      observation?.runState === "running" && steerSupported
      ? steerKind === "conversation" ? { kind: "conversation" as const }
        : steerKind === "turn" && observation.activeTurnId ? { kind: "turn" as const, turnId: observation.activeTurnId } : undefined
      : undefined;
    return {
      threadId, activityToken: token, authority,
      runState: observation?.runState ?? null,
      ...(observation?.sourceTurnId ? { sourceTurnId: observation.sourceTurnId } : {}),
      automaticListenEligible: !this.#closed && targetAvailable && authority === "current" &&
        observation!.settled && observation!.backendCapabilities.deliveryModes.includes("submit") && observation!.blockingInteractionIds.length === 0 &&
        stored.pending === 0 && stored.recovery === 0,
      steer: authority !== "current" ? { availability: "unavailable" }
        : steerTarget ? { availability: "available", target: steerTarget }
        : steerSupported ? { availability: "unavailable" } : { availability: "unsupported" },
    };
  }

  originForTurn(scope: RequestScope, threadId: string, turnId: string): ClientOrigin | undefined {
    const observed = this.input.actors.observeInputRuntime(scope, threadId, turnId);
    return this.#origins.turnOrigin(scope, threadId, turnId,
      observed?.sourceTurnId === turnId ? observed.firstInput : undefined);
  }

  notificationContext(scope: RequestScope, threadId: string, sourceTurnId?: string): {
    readonly origin?: ClientOrigin;
    readonly recognitionTarget?: RecognitionTarget;
    readonly settlement?: Promise<RecognitionTarget | undefined>;
  } {
    const origin = sourceTurnId ? this.originForTurn(scope, threadId, sourceTurnId) : undefined;
    const provenance = origin ? { origin } : {};
    let current: ThreadInputContext;
    try { current = this.#capture(scope, threadId); } catch { return provenance; }
    if (this.#closed || current.authority !== "current" || sourceTurnId && current.sourceTurnId !== sourceTurnId) return provenance;
    const target: RecognitionTarget = { threadId, activityToken: current.activityToken,
      ...(sourceTurnId ? { sourceTurnId } : {}) };
    const observed = this.input.actors.observeInputRuntime(scope, threadId);
    if (!sourceTurnId || observed?.settled || !terminal(observed)) return { ...provenance, recognitionTarget: target };
    if (this.#waiters.size >= MAX_SETTLEMENT_WAITERS) return provenance;
    const settlement = new Promise<RecognitionTarget | undefined>(resolve => {
      this.#waiters.add({ scope: { ...scope }, target, deadline: this.#now() + 5_000, resolve });
    });
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#drainWaiters(), 25);
      this.#timer.unref?.();
    }
    return { ...provenance, recognitionTarget: target, settlement };
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const waiter of this.#waiters) waiter.resolve(undefined);
    this.#waiters.clear();
    this.#states.clear();
  }

  #now(): number { return (this.input.now ?? Date.now)(); }

  #drainWaiters(): void {
    for (const waiter of this.#waiters) {
      let current: ThreadInputContext | undefined;
      try { current = this.#capture(waiter.scope, waiter.target.threadId); } catch { /* Target disappeared. */ }
      let done = false;
      let result: RecognitionTarget | undefined;
      if (!current || current.authority !== "current" || this.#now() >= waiter.deadline) done = true;
      else if (current.activityToken !== waiter.target.activityToken) { done = true; result = waiter.target; }
      else if (this.input.actors.observeInputRuntime(waiter.scope, waiter.target.threadId)?.settled) {
        done = true; result = waiter.target;
      }
      if (done) { this.#waiters.delete(waiter); waiter.resolve(result); }
    }
    if (this.#waiters.size === 0) { clearInterval(this.#timer); this.#timer = undefined; }
  }
}
