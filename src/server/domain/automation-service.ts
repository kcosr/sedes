import { createHash, randomUUID } from "node:crypto";
import type {
  ThreadAutomationDefinition,
  ThreadAutomationRun,
  ThreadAutomationSummary,
} from "../../shared/protocol/automation-presentation.js";
import type {
  AutomationPrecheck,
  AutomationSchedule as ProtocolAutomationSchedule,
} from "../../shared/protocol/automation.js";
import type { AutomationRepository } from "../db/repositories/automation-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  AutomationDefinitionRecord,
  AutomationMisfirePolicy,
  AutomationRunMode,
  AutomationRunRecord,
  AutomationSchedule,
} from "./automation-models.js";
import {
  AutomationScheduleEvaluator,
  AutomationScheduleValidationError,
  coalesceIntervalOccurrences,
} from "./automation-schedule.js";
import { DomainError } from "./errors.js";
import type { DurableDeadlineSource } from "./durable-scheduler.js";
import type { AutomationDispatcher } from "../runtime/automation-dispatcher.js";
import type { AutomationExecutionPolicy } from "../runtime/automation-execution-policy.js";

const CLAIM_LEASE_MS = 5 * 60_000;
const MISFIRE_GRACE_MS = 60_000;
const MAX_DUE_BATCH = 100;
const MAX_HISTORY_PAGE = 100;
const MAX_CRON_MISFIRE_SCAN = 1_000;
const DISPATCH_BACKPRESSURE_MS = 250;
const RECONCILE_FAILURE_BACKOFF_MS = 1_000;

export interface AutomationDefinitionFields {
  readonly prompt: string;
  readonly runMode: AutomationRunMode;
  readonly schedule: ProtocolAutomationSchedule;
  readonly misfirePolicy: AutomationMisfirePolicy;
  readonly precheck: AutomationPrecheck | null;
}

export interface AutomationChangePublisher {
  publish(
    scope: RequestScope,
    applicationThreadId: string,
  ): void | Promise<void>;
}

/** A passive observer of backend acceptance or a definitive pre-start failure. */
export interface AutomationRunLifecycleEvent {
  readonly event: "automation.started" | "automation.failed";
  readonly run: AutomationRunRecord;
  readonly definition: AutomationDefinitionRecord;
}

export type AutomationRunLifecycleObserver = (
  scope: RequestScope,
  input: AutomationRunLifecycleEvent,
) => void | Promise<void>;

export class AutomationService implements DurableDeadlineSource {
  readonly #repository: AutomationRepository;
  readonly #inventory: Pick<InventoryRepository, "getThread">;
  readonly #publisher: AutomationChangePublisher;
  readonly #evaluator: AutomationScheduleEvaluator;
  readonly #onChanged: () => void;
  readonly #onReconcileError: (error: unknown) => void;
  readonly #executionPolicy: AutomationExecutionPolicy;
  readonly #onRunLifecycle: AutomationRunLifecycleObserver | undefined;
  #dispatcher?: AutomationDispatcher;
  #dispatchDeferredUntil: number | null = null;
  #reconcileFailureDeferredUntil: number | null = null;

  constructor(input: {
    repository: AutomationRepository;
    inventory: Pick<InventoryRepository, "getThread">;
    publisher: AutomationChangePublisher;
    evaluator?: AutomationScheduleEvaluator;
    onChanged?: () => void;
    onReconcileError?: (error: unknown) => void;
    executionPolicy: AutomationExecutionPolicy;
    onRunLifecycle?: AutomationRunLifecycleObserver;
  }) {
    this.#repository = input.repository;
    this.#inventory = input.inventory;
    this.#publisher = input.publisher;
    this.#evaluator = input.evaluator ?? new AutomationScheduleEvaluator();
    this.#onChanged = input.onChanged ?? (() => undefined);
    this.#onReconcileError = input.onReconcileError ?? (() => undefined);
    this.#executionPolicy = input.executionPolicy;
    this.#onRunLifecycle = input.onRunLifecycle;
  }

  bindDispatcher(dispatcher: AutomationDispatcher): void {
    if (this.#dispatcher && this.#dispatcher !== dispatcher) {
      throw new Error("automation_dispatcher_already_bound");
    }
    this.#dispatcher = dispatcher;
  }

  create(
    scope: RequestScope,
    threadId: string,
    input: AutomationDefinitionFields & { mutationId: string },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    this.#assertThread(scope, threadId);
    assertPromptBytes(input.prompt);
    const precheck = normalizePrecheck(input.precheck);
    const schedule = this.#toDomainSchedule(input.schedule);
    const fingerprint = requestFingerprint({
      threadId,
      prompt: input.prompt.trim(),
      runMode: input.runMode,
      schedule,
      misfirePolicy: input.misfirePolicy,
      precheck,
    });
    const definition = this.#repository.database.transaction(() => {
      const receipt = this.#repository.getMutationReceipt(
        scope,
        input.mutationId,
      );
      if (receipt) {
        const replay = this.#repository.getDefinition(
          scope,
          receipt.automationId,
        );
        if (
          receipt.mutationKind !== "create" ||
          receipt.requestFingerprint !== fingerprint ||
          replay.anchorThreadId !== threadId ||
          replay.revision !== receipt.resultRevision ||
          replay.deletedAt !== null
        ) {
          throw mutationReuseConflict();
        }
        return replay;
      }
      if (this.#repository.findDefinitionForThread(scope, threadId)) {
        throw new DomainError(
          "conflict",
          "This thread already has an automation.",
        );
      }
      const anchor = this.#assertAnchor(scope, threadId);
      const created = this.#repository.createDefinition(scope, {
        id: input.mutationId,
        anchorThreadId: threadId,
        name: anchor.thread.title,
        prompt: input.prompt.trim(),
        precheck,
        runMode: input.runMode,
        enabled: false,
        schedule,
        misfirePolicy: input.misfirePolicy,
        nextRunAt: null,
        now,
      });
      this.#repository.recordMutationReceipt(scope, {
        mutationId: input.mutationId,
        automationId: created.id,
        mutationKind: "create",
        requestFingerprint: fingerprint,
        resultRevision: created.revision,
        now,
      });
      return created;
    })();
    this.#publishDefinition(scope, definition);
    this.#changed();
    return this.presentDefinition(scope, definition);
  }

  get(scope: RequestScope, threadId: string): ThreadAutomationDefinition {
    this.#assertThread(scope, threadId);
    const definition = this.#definitionForThread(scope, threadId);
    return this.presentDefinition(scope, definition);
  }

  findSummaryForThread(
    scope: RequestScope,
    threadId: string,
  ): ThreadAutomationSummary | null {
    const definition = this.#repository.findDefinitionForThread(
      scope,
      threadId,
    );
    return definition ? this.presentSummary(scope, definition) : null;
  }

  update(
    scope: RequestScope,
    threadId: string,
    input: AutomationDefinitionFields & {
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    assertPromptBytes(input.prompt);
    const precheck = normalizePrecheck(input.precheck);
    const schedule = this.#toDomainSchedule(input.schedule);
    const mutation = this.#mutateDefinition(
      scope,
      threadId,
      input.mutationId,
      "update",
      {
        ...input,
        precheck,
        schedule,
      },
      (automationId) => {
        const anchor = this.#assertAnchor(scope, threadId);
        const current = this.#repository.getDefinition(scope, automationId);
        const enabled = current.enabled;
        if (enabled) {
          this.#executionPolicy.assertCanAutomate(scope, threadId);
        }
        return this.#repository.updateDefinition(scope, automationId, {
          anchorThreadId: threadId,
          name: anchor.thread.title,
          prompt: input.prompt.trim(),
          precheck,
          runMode: input.runMode,
          enabled,
          schedule,
          misfirePolicy: input.misfirePolicy,
          nextRunAt: enabled ? this.#firstOccurrence(schedule, now) : null,
          completedAt: null,
          expectedRevision: input.expectedRevision,
          now,
        });
      },
      now,
    );
    const updated = mutation.definition;
    if (!mutation.replayed) this.#publishDefinition(scope, updated);
    this.#changed();
    return this.presentDefinition(scope, updated);
  }

  setState(
    scope: RequestScope,
    threadId: string,
    input: {
      action: "enable" | "pause";
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    const mutation = this.#mutateDefinition(
      scope,
      threadId,
      input.mutationId,
      "state",
      input,
      (automationId) => {
        if (input.action === "enable") {
          this.#executionPolicy.assertCanAutomate(scope, threadId);
        }
        const current = this.#repository.getDefinition(scope, automationId);
        return input.action === "pause"
          ? this.#repository.pauseDefinition(scope, automationId, {
              expectedRevision: input.expectedRevision,
              now,
            })
          : this.#repository.enableDefinition(scope, automationId, {
              expectedRevision: input.expectedRevision,
              nextRunAt: this.#firstOccurrence(current.schedule, now),
              now,
            });
      },
      now,
    );
    const updated = mutation.definition;
    if (!mutation.replayed) this.#publishDefinition(scope, updated);
    this.#changed();
    return this.presentDefinition(scope, updated);
  }

  delete(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ): void {
    const mutation = this.#mutateDefinition(
      scope,
      threadId,
      input.mutationId,
      "delete",
      input,
      (automationId) =>
        this.#repository.softDeleteDefinition(scope, automationId, {
          expectedRevision: input.expectedRevision,
          now,
        }),
      now,
    );
    if (!mutation.replayed) {
      this.#publishThread(scope, threadId);
    }
    this.#changed();
  }

  preview(
    schedule: ProtocolAutomationSchedule,
    count: number,
    now = Date.now(),
  ): string[] {
    return this.#evaluator
      .preview(this.#toDomainSchedule(schedule), now, count)
      .map(iso);
  }

  listRuns(
    scope: RequestScope,
    threadId: string,
    input: {
      cursor?: string;
      pageSize: number;
      environmentAuthority?: {
        readonly sourceEnvironmentId: string;
        readonly targetEnvironmentIds: readonly string[];
        readonly policyRevision: number;
      };
    },
  ): { items: ThreadAutomationRun[]; nextCursor: string | null } {
    const automationId = this.#definitionForThread(scope, threadId).id;
    const pageSize = Math.min(input.pageSize, MAX_HISTORY_PAGE);
    const fingerprint = requestFingerprint([
      "automation.runs",
      scope.tenantId,
      scope.principalId,
      automationId,
      pageSize,
      input.environmentAuthority ?? null,
    ]);
    const after = input.cursor
      ? decodeRunCursor(input.cursor, fingerprint)
      : undefined;
    const rows = this.#repository.listRuns(scope, automationId, {
      limit: pageSize + 1,
      ...(after ? { after } : {}),
    });
    const retained = rows.slice(0, pageSize);
    const last = retained.at(-1);
    return {
      items: retained.map(presentRun),
      nextCursor:
        rows.length > pageSize && last
          ? encodeRunCursor(fingerprint, {
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  }

  resolveUncertainRun(
    scope: RequestScope,
    threadId: string,
    runId: string,
    now = Date.now(),
  ): ThreadAutomationRun {
    this.#assertThread(scope, threadId);
    const current = this.#repository.findRunByScopedId(scope, runId);
    if (!current || current.anchorThreadId !== threadId) {
      throw new DomainError("not_found", "The automation run was not found.");
    }
    if (
      current.state === "failed" &&
      current.errorCode === "automation_uncertain_resolved"
    ) {
      return presentRun(current);
    }
    const resolved = this.#repository.resolveUncertainRun(
      scope,
      current.automationId,
      runId,
      now,
    );
    this.publishRun(scope, resolved);
    return presentRun(resolved);
  }

  async runNow(
    scope: RequestScope,
    threadId: string,
    mutationId: string,
    now = Date.now(),
  ): Promise<ThreadAutomationRun> {
    const runId = mutationId;
    let claimed: ReturnType<AutomationRepository["createManualRun"]>;
    const replay = this.#repository.findRunByScopedId(scope, runId);
    if (replay) {
      if (
        replay.anchorThreadId !== threadId ||
        replay.occurrenceKind !== "manual" ||
        replay.occurrenceKey !== `manual:${mutationId}` ||
        replay.dispatchMutationId !== mutationId
      ) {
        throw new DomainError(
          "conflict",
          "The run mutation ID belongs to different work.",
        );
      }
      claimed = { run: replay, replayed: true };
    } else {
      if (
        this.#inventory.getThread(scope, threadId).inventory.inventoryState ===
        "snoozed"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Wake this thread before running its automation manually.",
        );
      }
      this.#executionPolicy.assertCanAutomate(scope, threadId);
      const automationId = this.#definitionForThread(scope, threadId).id;
      claimed = this.#repository.createManualRun(scope, automationId, {
        runId,
        occurrenceKey: `manual:${mutationId}`,
        scheduledFor: now,
        claimToken: randomUUID(),
        leaseExpiresAt: now + CLAIM_LEASE_MS,
        dispatchMutationId: runId,
        now,
      });
    }
    const currentDefinition = this.#repository.findDefinitionForThread(
      scope,
      threadId,
    );
    const belongsToCurrentDefinition =
      currentDefinition?.id === claimed.run.automationId;
    if (!claimed.replayed || belongsToCurrentDefinition) {
      this.#publishRun(scope, claimed.run);
      this.#changed();
    }
    try {
      await this.#requiredDispatcher().dispatch(claimed.run);
      return presentRun(
        this.#repository.getRun(
          scope,
          claimed.run.automationId,
          claimed.run.id,
        ),
      );
    } finally {
      // A due scheduled occurrence is deliberately hidden while the manual
      // run is nonterminal. Rearm as soon as dispatch reaches an outcome.
      this.#changed();
    }
  }

  getNearestDeadline(): number | null {
    const deadline = this.#repository.getNearestDeadline();
    if (deadline === null) return null;
    return Math.max(
      deadline,
      this.#dispatchDeferredUntil ?? deadline,
      this.#reconcileFailureDeferredUntil ?? deadline,
    );
  }

  async reconcileDue(now: number): Promise<void> {
    const dispatcher = this.#requiredDispatcher();
    let hadItemError = false;
    for (const expired of this.#repository.listExpiredLeasedRuns(
      now,
      MAX_DUE_BATCH,
    )) {
      try {
        this.#reconcileExpiredRun(dispatcher, expired, now);
      } catch (error) {
        hadItemError = true;
        this.#onReconcileError(error);
      }
    }

    const dueDefinitions = this.#repository.listDueDefinitions(
      now,
      MAX_DUE_BATCH,
    );
    for (const definition of dueDefinitions) {
      try {
        this.#reconcileDefinition(dispatcher, definition, now);
      } catch (error) {
        hadItemError = true;
        this.#onReconcileError(error);
      }
    }
    this.#reconcileFailureDeferredUntil = hadItemError
      ? now + RECONCILE_FAILURE_BACKOFF_MS
      : null;
    this.#changed();
  }

  #reconcileExpiredRun(
    dispatcher: AutomationDispatcher,
    expired: AutomationRunRecord,
    now: number,
  ): void {
    const scope = runScope(expired);
    if (expired.state === "claimed") {
      if (expired.precheckStatus === "checking") {
        const failed = this.#repository.failInterruptedPrecheck(
          scope,
          expired.automationId,
          expired.id,
          now,
        );
        this.publishRun(scope, failed);
        return;
      }
      if (dispatcher.availableCapacity() === 0) {
        this.#deferDispatch(now);
        return;
      }
      const reclaimed = this.#repository.reclaimExpiredRun(
        scope,
        expired.automationId,
        expired.id,
        {
          claimToken: randomUUID(),
          leaseExpiresAt: now + CLAIM_LEASE_MS,
          now,
        },
      );
      this.#launchScheduledDispatch(dispatcher, reclaimed);
    } else if (expired.runMode === "clone") {
      // Clone dispatch is a replayable two-step application operation: the
      // general fork service first commits child binding and provenance, then
      // the gateway idempotently enqueues the canned prompt. Re-entering that
      // gateway is therefore required after restart so a crash between those
      // commits cannot strand the prompt or misclassify an existing queue
      // receipt as uncertain.
      if (dispatcher.availableCapacity() === 0) {
        this.#deferDispatch(now);
        return;
      }
      this.#launchScheduledDispatch(dispatcher, expired);
    } else {
      const uncertain = this.#repository.markRunUncertainAndPause(
        scope,
        expired.automationId,
        expired.id,
        {
          expectedState: "dispatching",
          claimToken: expired.claimToken!,
          errorCode: "automation_dispatch_uncertain",
          errorDiagnostic:
            "The server restarted after dispatch began; the run was not repeated.",
          now,
        },
      );
      this.#publishRun(scope, uncertain);
      this.#publishDefinition(
        scope,
        this.#repository.getDefinition(scope, expired.automationId),
      );
    }
  }

  #reconcileDefinition(
    dispatcher: AutomationDispatcher,
    definition: AutomationDefinitionRecord,
    now: number,
  ): void {
    const scope = definitionScope(definition);
    const dueAt = definition.nextRunAt;
    if (dueAt === null) return;
    const anchor = this.#inventory.getThread(scope, definition.anchorThreadId);
    if (
      anchor.inventory.inventoryState === "snoozed" &&
      anchor.inventory.snoozedUntil !== null &&
      dueAt <= anchor.inventory.snoozedUntil
    ) {
      const advance = this.#advance(
        definition,
        dueAt,
        Math.max(now, anchor.inventory.snoozedUntil),
      );
      const suppressed = this.#repository.suppressScheduledOccurrenceForSnooze(
        scope,
        definition.id,
        {
          expectedRevision: definition.revision,
          scheduledFor: dueAt,
          lastScheduledAt: advance.lastScheduledAt,
          nextRunAt: advance.nextRunAt,
          now,
        },
      );
      if (suppressed.detached) {
        this.#publishThread(scope, definition.anchorThreadId);
      } else {
        this.#publishDefinition(scope, suppressed.definition);
      }
      return;
    }
    if (dispatcher.availableCapacity() === 0) {
      this.#deferDispatch(now);
      return;
    }

    const advance = this.#advance(definition, dueAt, now);
    const runId = randomUUID();
    const claimed = this.#repository.claimScheduledOccurrence(
      scope,
      definition.id,
      {
        runId,
        occurrenceKey: `scheduled:${dueAt}`,
        scheduledFor: dueAt,
        lastScheduledAt: advance.lastScheduledAt,
        nextRunAt: advance.nextRunAt,
        coalescedCount: advance.coalescedCount,
        claimToken: randomUUID(),
        leaseExpiresAt: now + CLAIM_LEASE_MS,
        dispatchMutationId: scheduledDispatchMutationId(definition, dueAt),
        now,
      },
    );
    this.#publishDefinition(
      scope,
      this.#repository.getDefinition(scope, definition.id),
    );
    this.#publishRun(scope, claimed.run);
    if (definition.misfirePolicy === "skip" && now - dueAt > MISFIRE_GRACE_MS) {
      const skipped = this.#repository.updateRunState(
        scope,
        definition.id,
        claimed.run.id,
        {
          expectedState: "claimed",
          state: "skipped",
          claimToken: claimed.run.claimToken ?? undefined,
          errorCode: "automation_misfire_skipped",
          errorDiagnostic: "The missed occurrence was skipped.",
          now,
          completeDefinition: definition.schedule.kind === "date_time",
        },
      );
      this.publishRun(scope, skipped);
    } else {
      this.#launchScheduledDispatch(dispatcher, claimed.run);
    }
  }

  dispatchCapacityChanged(): void {
    this.#dispatchDeferredUntil = null;
    this.#changed();
  }

  #launchScheduledDispatch(
    dispatcher: AutomationDispatcher,
    run: AutomationRunRecord,
  ): void {
    void dispatcher.dispatch(run).catch(() => undefined);
  }

  #deferDispatch(now: number): void {
    this.#dispatchDeferredUntil = Math.max(
      this.#dispatchDeferredUntil ?? 0,
      now + DISPATCH_BACKPRESSURE_MS,
    );
  }

  presentDefinition(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): ThreadAutomationDefinition {
    return {
      ...this.presentSummary(scope, definition),
      prompt: definition.prompt,
      schedule: toBrowserSchedule(definition.schedule),
      misfirePolicy: definition.misfirePolicy,
      precheck: definition.precheck,
    };
  }

  presentSummary(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): ThreadAutomationSummary {
    this.#inventory.getThread(scope, definition.anchorThreadId);
    const lastRun = this.#repository
      .listRuns(scope, definition.id, { limit: 1 })
      .at(0);
    return {
      status: definitionStatus(definition),
      runMode: definition.runMode,
      scheduleKind: definition.schedule.kind,
      ...(definition.nextRunAt === null
        ? {}
        : { nextRunAt: iso(definition.nextRunAt) }),
      ...(lastRun
        ? {
            lastRun: {
              id: lastRun.id,
              state: lastRun.state,
              occurrence: lastRun.occurrenceKind,
              scheduledFor: iso(lastRun.scheduledFor),
              ...(lastRun.finishedAt === null
                ? {}
                : { finishedAt: iso(lastRun.finishedAt) }),
              ...((lastRun.childThreadId ?? lastRun.anchorThreadId)
                ? {
                    resultThreadId:
                      lastRun.childThreadId ?? lastRun.anchorThreadId,
                  }
                : {}),
              ...(lastRun.errorCode ? { errorCode: lastRun.errorCode } : {}),
            },
          }
        : {}),
      revision: definition.revision,
      createdAt: iso(definition.createdAt),
      updatedAt: iso(definition.updatedAt),
      hasPrecheck: definition.precheck !== null,
    };
  }

  publishRun(scope: RequestScope, run: AutomationRunRecord): void {
    this.#publishRun(scope, run);
    const definition = this.#repository.getDefinition(scope, run.automationId);
    // Run completion records backend acceptance, not the eventual end of its
    // agent turn. The queue observer publishes here only after actual acceptance.
    // A user's resolution of uncertainty does not establish a backend failure.
    if (
      this.#onRunLifecycle &&
      (run.state === "completed" ||
        (run.state === "failed" &&
          run.errorCode !== "automation_uncertain_resolved"))
    ) {
      try {
        const observation = this.#onRunLifecycle(scope, {
          event:
            run.state === "completed" ? "automation.started" : "automation.failed",
          run,
          definition,
        });
        if (observation) void observation.catch(() => undefined);
      } catch {
        // Passive notifications must never affect automation execution.
      }
    }
    if (definition.deletedAt === null) {
      this.#publishDefinition(scope, definition);
    } else {
      const replacement = this.#repository.findDefinitionForThread(
        scope,
        definition.anchorThreadId,
      );
      if (replacement) {
        this.#publishDefinition(scope, replacement);
      } else {
        this.#publishThread(scope, definition.anchorThreadId);
      }
    }
    if (
      run.occurrenceKind === "scheduled" &&
      (run.state === "completed" || run.state === "failed")
    ) {
      this.#publishThread(scope, run.childThreadId ?? run.anchorThreadId);
    }
    this.#changed();
  }

  #publishDefinition(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): void {
    if (definition.deletedAt !== null) return;
    this.#publishThread(scope, definition.anchorThreadId);
  }

  #publishRun(scope: RequestScope, run: AutomationRunRecord): void {
    this.#publishThread(scope, run.anchorThreadId);
    if (run.childThreadId && run.childThreadId !== run.anchorThreadId) {
      this.#publishThread(scope, run.childThreadId);
    }
  }

  #publishThread(scope: RequestScope, applicationThreadId: string): void {
    try {
      const publication = this.#publisher.publish(scope, applicationThreadId);
      if (publication) void publication.catch(() => undefined);
    } catch {
      // Live application publication is an observer. The next bootstrap is
      // authoritative and automation durability must not depend on a socket.
    }
  }

  #assertThread(scope: RequestScope, threadId: string) {
    return this.#inventory.getThread(scope, threadId);
  }

  #definitionForThread(
    scope: RequestScope,
    threadId: string,
  ): AutomationDefinitionRecord {
    this.#assertThread(scope, threadId);
    const definition = this.#repository.findDefinitionForThread(
      scope,
      threadId,
    );
    if (!definition) {
      throw new DomainError("not_found", "This thread has no automation.");
    }
    return definition;
  }

  #assertAnchor(scope: RequestScope, threadId: string) {
    const anchor = this.#inventory.getThread(scope, threadId);
    if (anchor.inventory.inventoryState === "archived") {
      throw new DomainError(
        "archived_thread",
        "An archived thread cannot anchor an automation.",
      );
    }
    return anchor;
  }

  #toDomainSchedule(schedule: ProtocolAutomationSchedule): AutomationSchedule {
    try {
      switch (schedule.kind) {
        case "date_time":
          return this.#evaluator.validate({
            kind: schedule.kind,
            runAt: Date.parse(schedule.runAt),
          });
        case "interval":
          return this.#evaluator.validate({
            kind: schedule.kind,
            anchorAt: Date.parse(schedule.anchorAt),
            everySeconds: schedule.everySeconds,
          });
        case "cron":
          return this.#evaluator.validate(schedule);
      }
    } catch (error) {
      if (error instanceof AutomationScheduleValidationError) {
        throw new DomainError(
          "invalid_transition",
          `The automation schedule is invalid: ${error.message}.`,
        );
      }
      throw error;
    }
  }

  #firstOccurrence(schedule: AutomationSchedule, now: number): number {
    const next = this.#evaluator.nextOccurrence(schedule, now);
    if (next === null) {
      throw new DomainError(
        "invalid_transition",
        "The schedule has no future occurrence.",
      );
    }
    return next;
  }

  #advance(
    definition: AutomationDefinitionRecord,
    dueAt: number,
    now: number,
  ): {
    nextRunAt: number | null;
    lastScheduledAt: number;
    coalescedCount: number;
  } {
    if (definition.schedule.kind === "date_time") {
      return {
        nextRunAt: null,
        lastScheduledAt: dueAt,
        coalescedCount: 0,
      };
    }
    if (definition.schedule.kind === "interval") {
      const coalesced = coalesceIntervalOccurrences(
        definition.schedule,
        dueAt - 1,
        now,
      );
      return {
        nextRunAt:
          coalesced?.nextRunAt ??
          this.#evaluator.nextOccurrence(definition.schedule, now),
        lastScheduledAt: coalesced?.scheduledAt ?? dueAt,
        coalescedCount: coalesced?.coalescedCount ?? 0,
      };
    }
    let count = 0;
    let cursor = dueAt;
    while (cursor <= now && count < MAX_CRON_MISFIRE_SCAN) {
      const next = this.#evaluator.nextOccurrence(definition.schedule, cursor);
      if (next === null || next > now) break;
      cursor = next;
      count += 1;
    }
    return {
      nextRunAt: this.#evaluator.nextOccurrence(definition.schedule, now),
      lastScheduledAt: cursor,
      coalescedCount: count === MAX_CRON_MISFIRE_SCAN ? 1_000_000 : count,
    };
  }

  #requiredDispatcher(): AutomationDispatcher {
    if (!this.#dispatcher) {
      throw new Error("automation_dispatcher_not_bound");
    }
    return this.#dispatcher;
  }

  #mutateDefinition(
    scope: RequestScope,
    threadId: string,
    mutationId: string,
    mutationKind: "update" | "state" | "delete",
    request: unknown,
    action: (automationId: string) => AutomationDefinitionRecord,
    now: number,
  ): {
    definition: AutomationDefinitionRecord;
    replayed: boolean;
  } {
    const fingerprint = requestFingerprint(request);
    return this.#repository.database.transaction(() => {
      const receipt = this.#repository.getMutationReceipt(scope, mutationId);
      if (receipt) {
        const replay = this.#repository.getDefinition(
          scope,
          receipt.automationId,
        );
        if (
          receipt.mutationKind !== mutationKind ||
          receipt.requestFingerprint !== fingerprint ||
          replay.anchorThreadId !== threadId ||
          replay.revision !== receipt.resultRevision ||
          (mutationKind !== "delete" && replay.deletedAt !== null)
        ) {
          throw mutationReuseConflict();
        }
        return { definition: replay, replayed: true };
      }
      const automationId = this.#definitionForThread(scope, threadId).id;
      const definition = action(automationId);
      this.#repository.recordMutationReceipt(scope, {
        mutationId,
        automationId,
        mutationKind,
        requestFingerprint: fingerprint,
        resultRevision: definition.revision,
        now,
      });
      return { definition, replayed: false };
    })();
  }

  #changed(): void {
    this.#onChanged();
  }
}

function presentRun(run: AutomationRunRecord): ThreadAutomationRun {
  return {
    id: run.id,
    occurrence: run.occurrenceKind,
    scheduledFor: iso(run.scheduledFor),
    state: run.state,
    runMode: run.runMode,
    ...((run.childThreadId ?? run.anchorThreadId)
      ? { resultThreadId: run.childThreadId ?? run.anchorThreadId }
      : {}),
    coalescedCount: run.coalescedCount,
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.errorDiagnostic ? { diagnostic: run.errorDiagnostic } : {}),
    ...(run.claimedAt ? { claimedAt: iso(run.claimedAt) } : {}),
    ...(run.startedAt === null ? {} : { startedAt: iso(run.startedAt) }),
    ...(run.acceptedAt === null ? {} : { acceptedAt: iso(run.acceptedAt) }),
    ...(run.finishedAt === null ? {} : { finishedAt: iso(run.finishedAt) }),
    ...(run.precheckStatus === "not_configured"
      ? {}
      : {
          precheck: {
            status: run.precheckStatus,
            durationMilliseconds: run.precheckDurationMs ?? 0,
            stdoutBytes: run.precheckStdoutBytes ?? 0,
            stdoutIncluded: run.precheckStdoutIncluded ?? false,
            ...(run.precheckExitCode === null
              ? {}
              : { exitCode: run.precheckExitCode }),
          },
        }),
  };
}

function toBrowserSchedule(
  schedule: AutomationSchedule,
): ProtocolAutomationSchedule {
  switch (schedule.kind) {
    case "date_time":
      return { kind: schedule.kind, runAt: iso(schedule.runAt) };
    case "interval":
      return {
        kind: schedule.kind,
        anchorAt: iso(schedule.anchorAt),
        everySeconds: schedule.everySeconds,
      };
    case "cron":
      return schedule;
  }
}

function definitionStatus(
  definition: AutomationDefinitionRecord,
): "enabled" | "paused" {
  return definition.enabled ? "enabled" : "paused";
}

function definitionScope(definition: AutomationDefinitionRecord): RequestScope {
  return {
    tenantId: definition.tenantId,
    principalId: definition.ownerPrincipalId,
  };
}

function runScope(run: AutomationRunRecord): RequestScope {
  return {
    tenantId: run.tenantId,
    principalId: run.ownerPrincipalId,
  };
}

type AutomationRunCursor = {
  readonly createdAt: number;
  readonly id: string;
};

function encodeRunCursor(
  fingerprint: string,
  cursor: AutomationRunCursor,
): string {
  return Buffer.from(
    JSON.stringify({ fingerprint, ...cursor }),
    "utf8",
  ).toString("base64url");
}

function decodeRunCursor(
  cursor: string,
  expectedFingerprint: string,
): AutomationRunCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Object.keys(decoded).length !== 3 ||
      !("fingerprint" in decoded) ||
      decoded.fingerprint !== expectedFingerprint ||
      !("createdAt" in decoded) ||
      !Number.isSafeInteger(decoded.createdAt) ||
      (decoded.createdAt as number) < 0 ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      decoded.id.length < 1 ||
      decoded.id.length > 128
    ) {
      throw new Error("automation_cursor_invalid");
    }
    return {
      createdAt: decoded.createdAt as number,
      id: decoded.id,
    };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The automation cursor is invalid.",
      false,
      { cause },
    );
  }
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function requestFingerprint(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function mutationReuseConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The mutation ID was already used for different automation work.",
  );
}

function assertPromptBytes(prompt: string): void {
  const normalized = prompt.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 65_536) {
    throw new DomainError(
      "invalid_transition",
      "The automation prompt must be non-empty and at most 65,536 bytes.",
    );
  }
}

function normalizePrecheck(
  precheck: AutomationPrecheck | null,
): AutomationPrecheck | null {
  if (precheck === null) return null;
  const command = precheck.command.trim();
  if (
    !command ||
    Buffer.byteLength(command, "utf8") > 4_096 ||
    !Number.isInteger(precheck.timeoutSeconds) ||
    precheck.timeoutSeconds < 1 ||
    precheck.timeoutSeconds > 60 ||
    typeof precheck.includeStdout !== "boolean"
  ) {
    throw new DomainError(
      "invalid_transition",
      "The automation pre-check configuration is invalid.",
    );
  }
  return { ...precheck, command };
}

function scheduledDispatchMutationId(
  definition: AutomationDefinitionRecord,
  scheduledFor: number,
): string {
  const bytes = createHash("sha256")
    .update("automation-scheduled-dispatch")
    .update("\0")
    .update(definition.tenantId)
    .update("\0")
    .update(definition.ownerPrincipalId)
    .update("\0")
    .update(definition.id)
    .update("\0")
    .update(String(scheduledFor))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
