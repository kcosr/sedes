import { MAXIMUM_AUTOMATION_NAME_LENGTH } from "../../shared/protocol/automation.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  ThreadAutomationDefinition,
  ThreadAutomationRun,
  ThreadAutomationRunPage,
  ThreadAutomationRunResolution,
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
  AutomationRunFilter,
  AutomationRunMode,
  AutomationRunRecord,
  AutomationSchedule,
} from "./automation-models.js";
import {
  presentAutomationLastRunTurn,
  presentAutomationRunTurn,
  presentAutomationSchedule,
} from "./automation-presentation.js";
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
  readonly misfirePolicy: AutomationMisfirePolicy | null;
  readonly precheck: AutomationPrecheck | null;
}

export interface AutomationChangePublisher {
  publishAutomation?(
    scope: RequestScope,
    input: {
      automationId: string;
      threadId: string;
      revision: number;
      runsRevision: number;
      deleted: boolean;
    },
  ): void | Promise<void>;
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
  #lastNow = Date.now();
  #deferredScanAt: number | null = null;
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

  replayCreate(
    scope: RequestScope,
    threadId: string,
    input: AutomationDefinitionFields & {
      name: string;
      initialState: "enabled" | "paused";
      mutationId: string;
    },
  ): ThreadAutomationDefinition | undefined {
    this.#assertThread(scope, threadId);
    const fields = this.#normalizeFields(input),
      name = normalizeName(input.name);
    const fingerprint = requestFingerprint({
      operation: "create",
      threadId,
      ...fields,
      name,
      initialState: input.initialState,
    });
    const receipt = this.#repository.getMutationReceipt(
      scope,
      input.mutationId,
    );
    if (!receipt) return undefined;
    const replay = this.#repository.getDefinition(scope, receipt.automationId);
    if (
      receipt.mutationKind !== "create" ||
      receipt.requestFingerprint !== fingerprint ||
      replay.anchorThreadId !== threadId
    )
      throw mutationReuseConflict();
    return this.presentDefinition(scope, replay);
  }

  create(
    scope: RequestScope,
    threadId: string,
    input: AutomationDefinitionFields & {
      name: string;
      initialState: "enabled" | "paused";
      mutationId: string;
    },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    this.#assertThread(scope, threadId);
    const fields = this.#normalizeFields(input);
    const name = normalizeName(input.name);
    const fingerprint = requestFingerprint({
      operation: "create",
      threadId,
      ...fields,
      name,
      initialState: input.initialState,
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
          replay.anchorThreadId !== threadId
        )
          throw mutationReuseConflict();
        return replay;
      }
      this.#assertAnchor(scope, threadId);
      const enabled = input.initialState === "enabled";
      if (enabled) this.#executionPolicy.assertCanAutomate(scope, threadId);
      const created = this.#repository.createDefinition(scope, {
        id: input.mutationId,
        anchorThreadId: threadId,
        name,
        ...fields,
        enabled,
        nextRunAt: enabled ? this.#firstOccurrence(fields.schedule, now) : null,
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

  get(scope: RequestScope, automationId: string): ThreadAutomationDefinition {
    return this.presentDefinition(scope, this.#definition(scope, automationId));
  }

  list(
    scope: RequestScope,
    input: {
      threadId?: string;
      cursor?: string;
      pageSize: number;
      status?: "enabled" | "paused" | "exhausted";
    },
  ): { items: ThreadAutomationDefinition[]; nextCursor: string | null } {
    if (input.threadId) this.#assertThread(scope, input.threadId);
    const pageSize = Math.min(MAX_HISTORY_PAGE, Math.max(1, input.pageSize));
    const fingerprint = requestFingerprint([
      "automation.list",
      scope.tenantId,
      scope.principalId,
      input.threadId ?? null,
      input.status ?? null,
      pageSize,
    ]);
    const cursor = input.cursor
      ? decodeRunCursor(input.cursor, fingerprint)
      : undefined;
    const rows = this.#repository.listDefinitionPage(scope, {
      threadId: input.threadId,
      status: input.status,
      limit: pageSize + 1,
      after: cursor,
    });
    const retained = rows.slice(0, pageSize),
      last = retained.at(-1);
    return {
      items: retained.map((row) => this.presentDefinition(scope, row)),
      nextCursor:
        rows.length > pageSize && last
          ? encodeRunCursor(fingerprint, {
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  }

  /** Replay before an adapter performs admission checks on a live definition. */
  replayUpdate(
    scope: RequestScope,
    automationId: string,
    input: AutomationDefinitionFields & {
      name: string;
      expectedRevision: number;
      mutationId: string;
    },
  ): ThreadAutomationDefinition | undefined {
    const fields = this.#normalizeFields(input),
      name = normalizeName(input.name);
    const replay = this.#replayDefinition(
      scope, automationId, input.mutationId, "update",
      requestFingerprint({
        operation: "update", automationId,
        request: { ...fields, name, expectedRevision: input.expectedRevision },
      }),
    );
    return replay ? this.presentDefinition(scope, replay) : undefined;
  }

  update(
    scope: RequestScope,
    automationId: string,
    input: AutomationDefinitionFields & {
      name: string;
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    const fields = this.#normalizeFields(input),
      name = normalizeName(input.name);
    const mutation = this.#mutateDefinition(
      scope,
      automationId,
      input.mutationId,
      "update",
      { ...fields, name, expectedRevision: input.expectedRevision },
      (id) => {
        const current = this.#definition(scope, id);
        this.#assertAnchor(scope, current.anchorThreadId);
        if (current.enabled)
          this.#executionPolicy.assertCanAutomate(
            scope,
            current.anchorThreadId,
          );
        const sameSchedule =
          JSON.stringify(current.schedule) ===
            JSON.stringify(fields.schedule) &&
          current.misfirePolicy === fields.misfirePolicy;
        const sameOnce =
          current.schedule.kind === "date_time" &&
          fields.schedule.kind === "date_time" &&
          current.schedule.runAt === fields.schedule.runAt;
        if (
          fields.schedule.kind === "date_time" &&
          !sameOnce &&
          this.#repository.hasScheduledOccurrence(
            scope,
            id,
            fields.schedule.runAt,
          )
        )
          throw new DomainError(
            "invalid_transition",
            "This time has already been consumed. Choose a new future time.",
          );
        const exhausted = sameOnce && this.#repository.isExhausted(scope, id);
        if (fields.schedule.kind === "date_time" && !sameOnce)
          this.#firstOccurrence(fields.schedule, now);
        return this.#repository.updateDefinition(scope, id, {
          anchorThreadId: current.anchorThreadId,
          name,
          ...fields,
          enabled: current.enabled,
          nextRunAt: sameSchedule
            ? current.nextRunAt
            : current.enabled && !exhausted
              ? this.#firstOccurrence(fields.schedule, now)
              : null,
          completedAt: exhausted ? current.completedAt : null,
          expectedRevision: input.expectedRevision,
          now,
        });
      },
      now,
    );
    this.#publishDefinition(scope, mutation.definition);
    this.#changed();
    return this.presentDefinition(scope, mutation.definition);
  }

  setState(
    scope: RequestScope,
    automationId: string,
    input: {
      action: "enable" | "pause";
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ): ThreadAutomationDefinition {
    const mutation = this.#mutateDefinition(
      scope,
      automationId,
      input.mutationId,
      "state",
      input,
      (id) => {
        const current = this.#definition(scope, id);
        if (input.action === "pause")
          return this.#repository.pauseDefinition(scope, id, {
            expectedRevision: input.expectedRevision,
            now,
          });
        this.#executionPolicy.assertCanAutomate(scope, current.anchorThreadId);
        if (this.#repository.isExhausted(scope, id))
          throw new DomainError(
            "invalid_transition",
            "This one-shot has been exhausted. Choose a new future time to rearm it.",
          );
        return this.#repository.enableDefinition(scope, id, {
          expectedRevision: input.expectedRevision,
          nextRunAt: this.#firstOccurrence(current.schedule, now),
          now,
        });
      },
      now,
    );
    this.#publishDefinition(scope, mutation.definition);
    this.#changed();
    return this.presentDefinition(scope, mutation.definition);
  }

  delete(
    scope: RequestScope,
    automationId: string,
    input: { expectedRevision: number; mutationId: string },
    now = Date.now(),
  ): void {
    const mutation = this.#mutateDefinition(
      scope,
      automationId,
      input.mutationId,
      "delete",
      input,
      (id) =>
        this.#repository.softDeleteDefinition(scope, id, {
          expectedRevision: input.expectedRevision,
          now,
        }),
      now,
    );
    this.#publishDefinition(scope, mutation.definition);
    this.#changed();
  }

  #normalizeFields(input: AutomationDefinitionFields) {
    assertPromptBytes(input.prompt);
    const schedule = this.#toDomainSchedule(input.schedule);
    if ((schedule.kind === "date_time") !== (input.misfirePolicy === null))
      throw new DomainError(
        "invalid_transition",
        "One-shots have no missed-occurrence policy; recurring schedules require one.",
      );
    return {
      prompt: input.prompt.trim(),
      runMode: input.runMode,
      schedule,
      misfirePolicy: input.misfirePolicy,
      precheck: normalizePrecheck(input.precheck),
    };
  }

  /**
   * The next `count` occurrences strictly after now, or after `after` when
   * that is later (a snooze's wake time).
   */
  preview(
    schedule: ProtocolAutomationSchedule,
    count: number,
    now = Date.now(),
    after?: string,
  ): string[] {
    const from = after === undefined ? now : Math.max(now, Date.parse(after));
    return this.#evaluator
      .preview(this.#toDomainSchedule(schedule), from, count)
      .map(iso);
  }

  /**
   * Pages run history newest first. The filter is part of the cursor
   * fingerprint; only the first page (no cursor) carries the history counts.
   */
  listRuns(
    scope: RequestScope,
    threadId: string,
    input: {
      cursor?: string;
      pageSize: number;
      filter?: AutomationRunFilter;
      environmentAuthority?: {
        readonly sourceEnvironmentId: string;
        readonly targetEnvironmentIds: readonly string[];
        readonly policyRevision: number;
      };
    },
  ): ThreadAutomationRunPage {
    const automationId = this.#definition(scope, threadId).id;
    const pageSize = Math.min(input.pageSize, MAX_HISTORY_PAGE);
    const filter = input.filter ?? "all";
    const fingerprint = requestFingerprint([
      "automation.runs",
      scope.tenantId,
      scope.principalId,
      automationId,
      pageSize,
      filter,
      input.environmentAuthority ?? null,
    ]);
    const after = input.cursor
      ? decodeRunCursor(input.cursor, fingerprint)
      : undefined;
    const { rows, counts } = this.#repository.database.transaction(() => ({
      rows: this.#repository.listRuns(scope, automationId, {
        limit: pageSize + 1,
        filter,
        ...(after ? { after } : {}),
      }),
      counts: after
        ? undefined
        : this.#repository.countRuns(scope, automationId),
    }))();
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
      ...(counts ? { counts } : {}),
    };
  }

  /**
   * Marks an uncertain run failed. With `resume`, the same transaction then
   * enables its definition, so a rejected enable leaves the run uncertain.
   * Replaying an already-resolved run changes nothing.
   */
  resolveUncertainRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: { readonly resume: boolean },
    now = Date.now(),
  ): ThreadAutomationRunResolution {
    const definition = this.#definition(scope, automationId),
      current = this.#repository.getRun(scope, automationId, runId);
    if (
      current.state === "failed" &&
      current.errorCode === "automation_uncertain_resolved"
    )
      return this.#presentResolution(scope, automationId, current);
    const resolved = this.#repository.database.transaction(() => {
      const run = this.#repository.resolveUncertainRun(
        scope,
        automationId,
        runId,
        now,
      );
      this.#repository.acknowledgeRun(scope, automationId, runId, now);
      if (input.resume) {
        if (this.#repository.isExhausted(scope, automationId))
          throw new DomainError(
            "invalid_transition",
            "This one-shot is exhausted. Choose a new future time to rearm it.",
          );
        this.#executionPolicy.assertCanAutomate(
          scope,
          definition.anchorThreadId,
        );
        const latest = this.#repository.getDefinition(scope, automationId);
        this.#repository.enableDefinition(scope, automationId, {
          expectedRevision: latest.revision,
          nextRunAt: this.#firstOccurrence(latest.schedule, now),
          now,
        });
      }
      return run;
    })();
    this.publishRun(scope, resolved);
    return this.#presentResolution(
      scope,
      automationId,
      this.#repository.getRun(scope, automationId, runId),
    );
  }

  acknowledgeThreadRun(
    scope: RequestScope,
    threadId: string,
    runId: string,
    outcome: "triggered" | "failed",
    now = Date.now(),
  ): ThreadAutomationRunResolution {
    this.#assertThread(scope, threadId);
    const run = this.#repository.findRunByScopedId(scope, runId);
    if (
      !run ||
      (run.anchorThreadId !== threadId && run.childThreadId !== threadId)
    )
      throw new DomainError(
        "not_found",
        "The automation run was not found for this thread.",
      );
    // Dismissing the delivered notice must not acknowledge a failure that
    // arrived after that notice was rendered, including a delayed request.
    const currentOutcome = run.state === "uncertain" ? "uncertain"
      : run.state === "failed" || run.turnOutcome === "failed" || run.turnOutcome === "interrupted"
        ? "failed" : "triggered";
    if (outcome !== currentOutcome)
      return this.#presentResolution(scope, run.automationId, run);
    return this.acknowledgeRun(scope, run.automationId, runId, now);
  }

  acknowledgeRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    now = Date.now(),
  ): ThreadAutomationRunResolution {
    const definition = this.#repository.getDefinition(scope, automationId);
    this.#assertThread(scope, definition.anchorThreadId);
    const run = this.#repository.acknowledgeRun(
      scope,
      automationId,
      runId,
      now,
    );
    this.#publishRun(scope, run);
    return this.#presentResolution(scope, automationId, run);
  }

  async runNow(
    scope: RequestScope,
    automationId: string,
    mutationId: string,
    now = Date.now(),
  ): Promise<ThreadAutomationRun> {
    const definition = this.#repository.getDefinition(scope, automationId);
    this.#assertThread(scope, definition.anchorThreadId);
    const replay = this.#repository.findRunByScopedId(scope, mutationId);
    let claimed: ReturnType<AutomationRepository["createManualRun"]>;
    if (replay) {
      if (
        replay.automationId !== automationId ||
        replay.occurrenceKind !== "manual" ||
        replay.occurrenceKey !== `manual:${mutationId}` ||
        replay.dispatchMutationId !== mutationId
      )
        throw new DomainError(
          "conflict",
          "The run mutation ID belongs to different work.",
        );
      claimed = { run: replay, replayed: true };
    } else {
      this.#definition(scope, automationId);
      const sourceState = this.#inventory.getThread(
        scope,
        definition.anchorThreadId,
      ).inventory.inventoryState;
      if (sourceState === "archived")
        throw new DomainError(
          "archived_thread",
          "Restore this thread before running its automation manually.",
        );
      if (sourceState === "snoozed")
        throw new DomainError(
          "invalid_transition",
          "Wake this thread before running its automation manually.",
        );
      this.#executionPolicy.assertCanAutomate(scope, definition.anchorThreadId);
      claimed = this.#repository.createManualRun(scope, automationId, {
        runId: mutationId,
        occurrenceKey: `manual:${mutationId}`,
        scheduledFor: now,
        claimToken: randomUUID(),
        leaseExpiresAt: now + CLAIM_LEASE_MS,
        dispatchMutationId: mutationId,
        now,
      });
    }
    this.#publishRun(scope, claimed.run);
    this.#changed();
    try {
      await this.#requiredDispatcher().dispatch(claimed.run);
      return presentRun(
        this.#repository.getRun(scope, automationId, claimed.run.id),
      );
    } finally {
      this.#changed();
    }
  }

  getNearestDeadline(): number | null {
    const deadline = this.#repository.getNearestDeadline();
    const safeDeadline = this.#repository.hasDeferredRuns()
      ? (this.#deferredScanAt ?? this.#lastNow + 30_000)
      : null;
    const next =
      deadline === null
        ? safeDeadline
        : safeDeadline === null
          ? deadline
          : Math.min(deadline, safeDeadline);
    if (next === null) return null;
    return Math.max(
      next,
      this.#dispatchDeferredUntil ?? next,
      this.#reconcileFailureDeferredUntil ?? next,
    );
  }

  async reconcileDue(now: number): Promise<void> {
    this.#lastNow = now;
    this.#deferredScanAt = null;
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

    for (const waiting of this.#repository.listDeferredRuns(
      now,
      MAX_DUE_BATCH,
    )) {
      try {
        if (dispatcher.availableCapacity() === 0) {
          this.#deferDispatch(now);
          break;
        }
        const scope = runScope(waiting);
        let skip = false;
        let failedDuringRefresh = false;
        const run = this.#repository.database
          .transaction(() => {
            const current = this.#repository.getRun(
              scope,
              waiting.automationId,
              waiting.id,
            );
            if (current.state !== "deferred") return current;
            if (this.#repository.refreshDeferredBlock(scope, current, now)) {
              const refreshed = this.#repository.getRun(
                scope,
                current.automationId,
                current.id,
              );
              failedDuringRefresh = refreshed.state === "failed";
              return refreshed;
            }
            const definition = this.#repository.getDefinition(
              scope,
              current.automationId,
            );
            if (
              current.occurrenceKind === "scheduled" &&
              current.suppressionPending &&
              definition.schedule.kind !== "date_time"
            ) {
              const advance = this.#advance(
                definition,
                current.scheduledFor,
                now,
              );
              this.#repository.foldDeferredOccurrence(scope, current, {
                ...advance,
                expectedRevision: definition.revision,
                now,
              });
              skip =
                definition.misfirePolicy === "skip" &&
                now - current.scheduledFor > MISFIRE_GRACE_MS;
            }
            return this.#repository.reclaimDeferredRun(
              scope,
              current.automationId,
              current.id,
              {
                claimToken: randomUUID(),
                leaseExpiresAt: now + CLAIM_LEASE_MS,
                now,
              },
            );
          })
          .immediate();
        if (failedDuringRefresh) {
          this.publishRun(scope, run);
          continue;
        }
        if (run.state === "deferred") {
          if (
            run.deferredReason !== waiting.deferredReason ||
            run.eligibleAt !== waiting.eligibleAt ||
            run.suppressionPending !== waiting.suppressionPending
          )
            this.#publishRun(scope, run);
          continue;
        }
        if (run.state !== "claimed") continue;
        if (skip)
          this.publishRun(
            scope,
            this.#repository.updateRunState(scope, run.automationId, run.id, {
              expectedState: "claimed",
              state: "skipped",
              claimToken: run.claimToken!,
              errorCode: "automation_misfire_skipped",
              errorDiagnostic: "The suppressed occurrences were skipped.",
              now,
            }),
          );
        else this.#launchScheduledDispatch(dispatcher, run);
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
    const admitted = this.#repository.checkRunAdmission(
      scope,
      definition.id,
      claimed.run.id,
      { claimToken: claimed.run.claimToken!, now, dispatch: false },
    );
    if (admitted.state !== "claimed") {
      this.publishRun(scope, admitted);
      return;
    }
    if (
      definition.schedule.kind !== "date_time" &&
      definition.misfirePolicy === "skip" &&
      now - dueAt > MISFIRE_GRACE_MS
    ) {
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
          completeDefinition: false,
        },
      );
      this.publishRun(scope, skipped);
    } else {
      this.#launchScheduledDispatch(dispatcher, claimed.run);
    }
  }

  /** A source or queue transition may make event-driven deferred work eligible. */
  requestDeferredReconcile(now = this.#lastNow): void {
    this.#deferredScanAt = now;
    this.#changed();
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
      schedule: presentAutomationSchedule(definition.schedule),
      misfirePolicy: definition.misfirePolicy,
      precheck: definition.precheck,
    };
  }

  presentSummary(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): ThreadAutomationSummary {
    const anchor = this.#inventory.getThread(scope, definition.anchorThreadId);
    const source = this.#repository.sourcePresentation(
      scope,
      definition.anchorThreadId,
    );
    const attention = this.#repository.attentionRun(scope, definition.id);
    const nextRunAt = this.#repository.nextActionAt(scope, definition.id);
    const lastRun = this.#repository
      .listRuns(scope, definition.id, { limit: 1 })
      .at(0);
    const lastRunTurn = lastRun && presentAutomationLastRunTurn(lastRun);
    return {
      id: definition.id,
      threadId: definition.anchorThreadId,
      name: definition.name,
      source: {
        title: anchor.thread.title,
        workspaceId: anchor.thread.workspaceId,
        environmentId: anchor.thread.environmentId,
        targetId: anchor.thread.connectionProfileId,
        groupId: source.groupId,
        backendLabel: source.backendLabel,
        available: source.available,
        backingState: anchor.thread.backingState,
        inventoryState: anchor.inventory.inventoryState,
        inventoryRevision: anchor.inventory.inventoryRevision,
        ...(anchor.inventory.snoozedUntil === null
          ? {}
          : { snoozedUntil: iso(anchor.inventory.snoozedUntil) }),
      },
      ...(attention
        ? {
            attention: {
              runId: attention.id,
              kind:
                attention.state === "uncertain"
                  ? ("uncertain" as const)
                  : ("failed" as const),
              ...(attention.errorDiagnostic
                ? { diagnostic: attention.errorDiagnostic }
                : {}),
            },
          }
        : {}),
      status: this.#repository.isDefinitionExhausted(scope, definition.id)
        ? "exhausted"
        : definitionStatus(definition),
      runMode: definition.runMode,
      scheduleKind: definition.schedule.kind,
      ...(nextRunAt === null ? {} : { nextRunAt: iso(nextRunAt) }),
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
              ...(lastRunTurn ? { turn: lastRunTurn } : {}),
            },
          }
        : {}),
      revision: definition.revision,
      runsRevision: definition.runsRevision,
      createdAt: iso(definition.createdAt),
      updatedAt: iso(definition.updatedAt),
      hasPrecheck: definition.precheck !== null,
    };
  }

  publishRun(scope: RequestScope, run: AutomationRunRecord): void {
    if (
      ["completed", "failed", "cancelled", "skipped", "uncertain"].includes(
        run.state,
      )
    )
      this.#deferredScanAt = this.#lastNow;
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
            run.state === "completed"
              ? "automation.started"
              : "automation.failed",
          run,
          definition,
        });
        if (observation) void observation.catch(() => undefined);
      } catch {
        // Passive notifications must never affect automation execution.
      }
    }
    this.#publishDefinition(scope, definition);
    if (
      run.occurrenceKind === "scheduled" &&
      (run.state === "completed" || run.state === "failed")
    ) {
      this.#publishThread(scope, run.childThreadId ?? run.anchorThreadId);
    }
    this.#changed();
  }

  /**
   * Publishes a run whose agent turn settled. Unlike {@link publishRun} it
   * notifies no lifecycle observer (the thread's own turn notification covers
   * the turn). The repository may retire a dismissed successful one-shot, or
   * restore attention for a failed turn, in the same settlement transaction.
   */
  publishRunSettlement(scope: RequestScope, run: AutomationRunRecord): void {
    this.#publishRun(scope, run);
  }

  reconcileRetirementsForThreads(
    scope: RequestScope,
    threadIds: readonly string[],
    now = Date.now(),
  ): void {
    for (const definition of this.#repository.retireFinishedOneShotsForThreads(scope, threadIds, now)) {
      this.#publishDefinition(scope, definition);
    }
  }

  #presentResolution(
    scope: RequestScope,
    threadId: string,
    run: AutomationRunRecord,
  ): ThreadAutomationRunResolution {
    const definition = this.#repository.getDefinition(scope, threadId);
    return {
      run: presentRun(run),
      automation:
        definition.deletedAt === null
          ? this.presentDefinition(scope, definition)
          : null,
    };
  }

  #publishDefinition(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): void {
    this.#publishEntity(scope, definition);
    this.#publishThread(scope, definition.anchorThreadId);
  }

  #publishRun(scope: RequestScope, run: AutomationRunRecord): void {
    this.#publishEntity(
      scope,
      this.#repository.getDefinition(scope, run.automationId),
    );
    this.#publishThread(scope, run.anchorThreadId);
    if (run.childThreadId && run.childThreadId !== run.anchorThreadId) {
      this.#publishThread(scope, run.childThreadId);
    }
  }

  #publishEntity(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
  ): void {
    try {
      const published = this.#publisher.publishAutomation?.(scope, {
        automationId: definition.id,
        threadId: definition.anchorThreadId,
        revision: definition.revision,
        runsRevision: definition.runsRevision,
        deleted: definition.deletedAt !== null,
      });
      if (published) void published.catch(() => undefined);
    } catch {}
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

  #definition(
    scope: RequestScope,
    automationId: string,
  ): AutomationDefinitionRecord {
    const definition = this.#repository.getDefinition(scope, automationId);
    this.#assertThread(scope, definition.anchorThreadId);
    if (definition.deletedAt !== null)
      throw new DomainError("not_found", "The automation was removed.");
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
    const fingerprint = requestFingerprint({
      operation: mutationKind,
      automationId: threadId,
      request,
    });
    return this.#repository.database.transaction(() => {
      const replay = this.#replayDefinition(scope, threadId, mutationId, mutationKind, fingerprint);
      if (replay) return { definition: replay, replayed: true };
      const automationId = this.#definition(scope, threadId).id;
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

  #replayDefinition(
    scope: RequestScope,
    automationId: string,
    mutationId: string,
    mutationKind: "update" | "state" | "delete",
    fingerprint: string,
  ): AutomationDefinitionRecord | undefined {
    const receipt = this.#repository.getMutationReceipt(scope, mutationId);
    if (!receipt) return undefined;
    const replay = this.#repository.getDefinition(scope, receipt.automationId);
    if (
      receipt.mutationKind !== mutationKind ||
      receipt.requestFingerprint !== fingerprint ||
      replay.id !== automationId ||
      (mutationKind !== "delete" && replay.deletedAt !== null &&
        receipt.resultRevision !== replay.revision)
    ) {
      throw mutationReuseConflict();
    }
    return replay;
  }

  #changed(): void {
    this.#onChanged();
  }
}

function presentRun(run: AutomationRunRecord): ThreadAutomationRun {
  const turn = presentAutomationRunTurn(run);
  return {
    id: run.id,
    automationId: run.automationId,
    ...(run.deferredReason
      ? {
          deferredReason: run.deferredReason,
          eligibleAt: run.eligibleAt === null ? null : iso(run.eligibleAt),
        }
      : {}),
    initialEligibleAt: iso(run.initialEligibleAt),
    ...(run.acknowledgedAt === null
      ? {}
      : { acknowledgedAt: iso(run.acknowledgedAt) }),
    occurrence: run.occurrenceKind,
    scheduledFor: iso(run.scheduledFor),
    state: run.state,
    runMode: run.runMode,
    definitionRevision: run.definitionRevision,
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
    ...(run.forceResetAt === null
      ? {}
      : { forceResetAt: iso(run.forceResetAt) }),
    ...(turn ? { turn } : {}),
    ...(run.precheckStatus === "not_configured"
      ? {}
      : {
          precheck: {
            status: run.precheckStatus,
            // The schema guarantees configured runs keep their snapshots.
            command: run.precheckCommandSnapshot!,
            timeoutSeconds: run.precheckTimeoutSeconds!,
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

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value || value.length > MAXIMUM_AUTOMATION_NAME_LENGTH)
    throw new DomainError(
      "invalid_transition",
      `Automation name must contain 1 to ${MAXIMUM_AUTOMATION_NAME_LENGTH} characters.`,
    );
  return value;
}
