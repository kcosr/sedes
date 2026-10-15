import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AutomationDefinitionRecord,
  AutomationDeferredReason,
  AutomationMisfirePolicy,
  AutomationPrecheck,
  AutomationPrecheckStatus,
  AutomationRunCounts,
  AutomationRunFilter,
  AutomationRunMode,
  AutomationRunRecord,
  AutomationRunState,
  AutomationSchedule,
  AutomationTurnOutcome,
} from "../../domain/automation-models.js";
import {
  consumedOnceSql,
  exhaustedSql,
  latestDecisiveRunIdSql,
  nextActionAtSql,
} from "./automation-read-sql.js";
import { MAXIMUM_ACTIVE_QUEUED_INPUTS } from "./queued-input-repository.js";
import { ConversationOperationRepository } from "./conversation-operation-repository.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { activateSettledThread } from "./settled-thread-activation.js";

const definitionColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  anchor_thread_id AS anchorThreadId,
  name,
  prompt,
  precheck_command AS precheckCommand,
  precheck_timeout_seconds AS precheckTimeoutSeconds,
  precheck_include_stdout AS precheckIncludeStdout,
  run_mode AS runMode,
  enabled,
  completed_at AS completedAt,
  deleted_at AS deletedAt,
  revision,
  runs_revision AS runsRevision,
  schedule_kind AS scheduleKind,
  run_at AS runAt,
  interval_anchor_at AS intervalAnchorAt,
  interval_seconds AS intervalSeconds,
  cron_expression AS cronExpression,
  time_zone AS timeZone,
  misfire_policy AS misfirePolicy,
  next_run_at AS nextRunAt,
  last_scheduled_at AS lastScheduledAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const runColumns = `
  deferred_reason AS deferredReason,
  eligible_at AS eligibleAt,
  initial_eligible_at AS initialEligibleAt,
  suppressed_at AS suppressedAt,
  suppression_pending AS suppressionPending,
  precheck_stdout AS precheckStdout,
  acknowledged_at AS acknowledgedAt,
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  automation_id AS automationId,
  id,
  occurrence_kind AS occurrenceKind,
  scheduled_for AS scheduledFor,
  occurrence_key AS occurrenceKey,
  definition_revision AS definitionRevision,
  coalesced_count AS coalescedCount,
  run_mode AS runMode,
  state,
  claim_token AS claimToken,
  lease_expires_at AS leaseExpiresAt,
  claim_attempt_count AS claimAttemptCount,
  prompt_snapshot AS promptSnapshot,
  precheck_command_snapshot AS precheckCommandSnapshot,
  precheck_timeout_seconds AS precheckTimeoutSeconds,
  precheck_include_stdout AS precheckIncludeStdout,
  precheck_status AS precheckStatus,
  precheck_started_at AS precheckStartedAt,
  precheck_finished_at AS precheckFinishedAt,
  precheck_exit_code AS precheckExitCode,
  precheck_duration_ms AS precheckDurationMs,
  precheck_stdout_bytes AS precheckStdoutBytes,
  precheck_stdout_included AS precheckStdoutIncluded,
  dispatch_mutation_id AS dispatchMutationId,
  anchor_thread_id AS anchorThreadId,
  child_thread_id AS childThreadId,
  error_code AS errorCode,
  error_diagnostic AS errorDiagnostic,
  claimed_at AS claimedAt,
  started_at AS startedAt,
  accepted_at AS acceptedAt,
  finished_at AS finishedAt,
  force_reset_at AS forceResetAt,
  turn_id AS turnId,
  turn_outcome AS turnOutcome,
  turn_settled_at AS turnSettledAt,
  turn_started_at AS turnStartedAt,
  turn_ended_at AS turnEndedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

type DefinitionRow = Omit<
  AutomationDefinitionRecord,
  "enabled" | "schedule" | "precheck"
> &
  AutomationScheduleColumns & {
    enabled: 0 | 1;
    precheckCommand: string | null;
    precheckTimeoutSeconds: number | null;
    precheckIncludeStdout: 0 | 1 | null;
  };

type RunRow = Omit<
  AutomationRunRecord,
  "precheckIncludeStdout" | "precheckStdoutIncluded" | "suppressionPending"
> & {
  suppressionPending: 0 | 1;
  precheckIncludeStdout: 0 | 1 | null;
  precheckStdoutIncluded: 0 | 1 | null;
};

type DefinitionValues = {
  readonly anchorThreadId: string;
  readonly name: string;
  readonly prompt: string;
  readonly precheck: AutomationPrecheck | null;
  readonly runMode: AutomationRunMode;
  readonly enabled: boolean;
  readonly schedule: AutomationSchedule;
  readonly misfirePolicy: AutomationMisfirePolicy | null;
  readonly nextRunAt: number | null;
};

export type CreateAutomationDefinitionInput = DefinitionValues & {
  readonly id?: string;
  readonly now: number;
};

export type UpdateAutomationDefinitionInput = DefinitionValues & {
  readonly expectedRevision: number;
  readonly completedAt: number | null;
  readonly now: number;
};

export type ScheduledOccurrenceClaimInput = {
  readonly runId?: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: number;
  readonly lastScheduledAt: number;
  readonly nextRunAt: number | null;
  readonly coalescedCount: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: number;
  readonly dispatchMutationId: string;
  readonly now: number;
};

export type ManualOccurrenceClaimInput = {
  readonly runId?: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: number;
  readonly dispatchMutationId: string;
  readonly now: number;
};

export type AutomationRunStateUpdate = {
  readonly expectedState: AutomationRunState;
  readonly state: Exclude<AutomationRunState, "claimed">;
  readonly claimToken?: string;
  readonly retainPromptSnapshot?: boolean;
  readonly errorCode?: string | null;
  readonly errorDiagnostic?: string | null;
  readonly now: number;
  readonly completeDefinition?: boolean;
};

export type AutomationPrecheckCompletion = {
  readonly durationMilliseconds: number;
  readonly stdoutBytes: number;
  readonly exitCode?: number;
  readonly now: number;
};

export type AutomationClaimResult = {
  readonly run: AutomationRunRecord;
  readonly replayed: boolean;
};

export type AutomationMutationReceipt = {
  readonly automationId: string;
  readonly mutationKind: "create" | "update" | "state" | "delete";
  readonly requestFingerprint: string;
  readonly resultRevision: number;
};

export type AutomationTurnSettlementInput = {
  readonly turnId: string;
  readonly outcome: AutomationTurnOutcome;
  readonly settledAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
};

/**
 * Disjoint conditions behind each run-history filter; `null` reads every run.
 * A failed turn is a problem however its delivery ended, so its branch leaves
 * out the states the other problem branches already list.
 */
const RUN_FILTER_BRANCHES: Readonly<
  Record<AutomationRunFilter, readonly string[] | null>
> = {
  all: null,
  problems: [
    "AND state = 'failed'",
    "AND state = 'uncertain'",
    "AND turn_outcome = 'failed' AND state NOT IN ('failed', 'uncertain')",
  ],
  skipped: ["AND state = 'skipped'"],
};

export class AutomationRepository {
  constructor(readonly database: Database.Database) {}

  getMutationReceipt(
    scope: RequestScope,
    mutationId: string,
  ): AutomationMutationReceipt | undefined {
    return this.database
      .prepare(
        `
          SELECT automation_id AS automationId,
            mutation_kind AS mutationKind,
            request_fingerprint AS requestFingerprint,
            result_revision AS resultRevision
          FROM automation_mutation_receipts
          WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      AutomationMutationReceipt | undefined;
  }

  recordMutationReceipt(
    scope: RequestScope,
    input: AutomationMutationReceipt & {
      readonly mutationId: string;
      readonly now: number;
    },
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO automation_mutation_receipts(
            tenant_id, owner_principal_id, mutation_id, automation_id,
            mutation_kind, request_fingerprint, result_revision, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        input.mutationId,
        input.automationId,
        input.mutationKind,
        input.requestFingerprint,
        input.resultRevision,
        input.now,
      );
  }

  sourcePresentation(
    scope: RequestScope,
    threadId: string,
  ): { groupId: string | null; backendLabel: string; available: boolean } {
    const row = this.database
      .prepare(
        `SELECT membership.group_id AS groupId, backend.label AS backendLabel,
      thread.availability = 'available' AND workspace.availability = 'available' AND workspace.removed_at IS NULL
        AND (environment.availability = 'available' OR environment.diagnostic_code = 'ssh_environment_not_validated') AS available
      FROM application_threads AS thread JOIN workspaces AS workspace ON workspace.tenant_id=thread.tenant_id
        AND workspace.owner_principal_id=thread.owner_principal_id AND workspace.id=thread.workspace_id
      JOIN execution_environments AS environment ON environment.tenant_id=thread.tenant_id
        AND environment.owner_principal_id=thread.owner_principal_id AND environment.id=thread.environment_id
      JOIN agent_backend_instances AS backend ON backend.tenant_id=thread.tenant_id AND backend.id=thread.backend_instance_id
      LEFT JOIN thread_group_memberships AS membership ON membership.tenant_id=thread.tenant_id
        AND membership.principal_id=thread.owner_principal_id AND membership.thread_id=thread.id
      WHERE thread.tenant_id=? AND thread.owner_principal_id=? AND thread.id=?`,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | { groupId: string | null; backendLabel: string; available: number }
      | undefined;
    if (!row)
      throw new DomainError(
        "not_found",
        "The automation source was not found.",
      );
    return { ...row, available: row.available === 1 };
  }

  nextActionAt(scope: RequestScope, automationId: string): number | null {
    const row = this.database
      .prepare(
        `SELECT ${nextActionAtSql("definition")} AS nextActionAt
      FROM automation_definitions AS definition WHERE tenant_id=? AND owner_principal_id=? AND id=?`,
      )
      .get(scope.tenantId, scope.principalId, automationId) as
      { nextActionAt: number | null } | undefined;
    return row?.nextActionAt ?? null;
  }

  listDefinitionPage(
    scope: RequestScope,
    input: {
      threadId?: string;
      status?: "enabled" | "paused" | "exhausted";
      limit: number;
      after?: { createdAt: number; id: string };
    },
  ): AutomationDefinitionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT ${definitionColumns} FROM automation_definitions AS definition
      WHERE tenant_id=? AND owner_principal_id=? AND deleted_at IS NULL
      AND (? IS NULL OR anchor_thread_id=?)
      AND (? IS NULL OR (? = 'exhausted' AND ${exhaustedSql("definition")})
        OR (? = 'enabled' AND enabled=1 AND NOT ${exhaustedSql("definition")})
        OR (? = 'paused' AND enabled=0 AND NOT ${exhaustedSql("definition")}))
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        input.threadId ?? null,
        input.threadId ?? null,
        input.status ?? null,
        input.status ?? null,
        input.status ?? null,
        input.status ?? null,
        input.after?.createdAt ?? null,
        input.after?.createdAt ?? null,
        input.after?.createdAt ?? null,
        input.after?.id ?? null,
        input.limit,
      ) as DefinitionRow[];
    return rows.map(definitionFromRow);
  }

  /** Consumed schedule identity, including a pending invocation: prevents rearming. */
  isExhausted(scope: RequestScope, automationId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM automation_definitions AS definition
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND ${consumedOnceSql("definition")}`,
        )
        .get(scope.tenantId, scope.principalId, automationId),
    );
  }

  isDefinitionExhausted(scope: RequestScope, automationId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM automation_definitions AS definition
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND ${exhaustedSql("definition")}`,
        )
        .get(scope.tenantId, scope.principalId, automationId),
    );
  }

  hasScheduledOccurrence(
    scope: RequestScope,
    automationId: string,
    scheduledFor: number,
  ): boolean {
    return (
      this.findOccurrence(scope, automationId, `scheduled:${scheduledFor}`) !==
      undefined
    );
  }

  attentionRun(
    scope: RequestScope,
    automationId: string,
  ): AutomationRunRecord | undefined {
    const uncertain = this.database
      .prepare(
        `SELECT ${runColumns} FROM automation_runs
      WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND state = 'uncertain' AND force_reset_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(scope.tenantId, scope.principalId, automationId) as
      RunRow | undefined;
    if (uncertain) return runFromRow(uncertain);
    const row = this.database
      .prepare(
        `SELECT ${runColumns} FROM automation_runs WHERE tenant_id = ?
      AND owner_principal_id = ? AND automation_id = ? AND id = (
        SELECT ${latestDecisiveRunIdSql("definition")} FROM automation_definitions AS definition
        WHERE definition.tenant_id = ? AND definition.owner_principal_id = ? AND definition.id = ?
      ) AND state = 'failed' AND acknowledged_at IS NULL`,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        automationId,
        scope.tenantId,
        scope.principalId,
        automationId,
      ) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  acknowledgeRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    now: number,
  ): AutomationRunRecord {
    const run = this.getRun(scope, automationId, runId);
    if (run.forceResetAt !== null)
      throw new DomainError(
        "invalid_transition",
        "A force-reset run is an immutable abandoned result.",
      );
    if (run.state === "uncertain")
      throw new DomainError(
        "invalid_transition",
        "Resolve the uncertain run before acknowledging it.",
      );
    if (run.state !== "completed" && run.state !== "failed")
      throw new DomainError(
        "invalid_transition",
        "Only a delivered or failed run can be acknowledged.",
      );
    if (run.acknowledgedAt === null && run.forceResetAt === null)
      this.database
        .prepare(
          `UPDATE automation_runs
      SET acknowledged_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ?
      AND acknowledged_at IS NULL`,
        )
        .run(now, scope.tenantId, scope.principalId, automationId, runId);
    return this.getRun(scope, automationId, runId);
  }

  cancelDeferredRuns(
    scope: RequestScope,
    automationId: string,
    code: string,
    now: number,
  ): void {
    this.database
      .prepare(
        `UPDATE automation_runs SET state = 'cancelled', prompt_snapshot = NULL,
      eligible_at = NULL, error_code = ?, finished_at = ?, updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND state = 'deferred'`,
      )
      .run(code, now, now, scope.tenantId, scope.principalId, automationId);
  }

  deferRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly expectedState: "claimed" | "dispatching";
      readonly claimToken: string;
      readonly reason: AutomationDeferredReason;
      readonly eligibleAt: number | null;
      readonly now: number;
    },
  ): AutomationRunRecord {
    const changed = this.database
      .prepare(
        `UPDATE automation_runs SET state = 'deferred', claim_token = NULL,
      lease_expires_at = NULL, started_at = NULL, accepted_at = NULL, deferred_reason = ?, eligible_at = ?,
      initial_eligible_at = CASE WHEN deferred_reason IS NULL THEN coalesce(?, initial_eligible_at) ELSE initial_eligible_at END,
      suppressed_at = CASE WHEN ? IN ('snoozed','archived','project_removed') THEN coalesce(suppressed_at, ?) ELSE suppressed_at END,
      suppression_pending = CASE WHEN ? IN ('snoozed','archived','project_removed') THEN 1 ELSE suppression_pending END,
      updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ?
      AND state = ? AND claim_token = ? AND force_reset_at IS NULL`,
      )
      .run(
        input.reason,
        input.eligibleAt,
        input.eligibleAt,
        input.reason,
        input.now,
        input.reason,
        input.now,
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
        input.expectedState,
        input.claimToken,
      );
    if (changed.changes !== 1)
      throw new DomainError(
        "conflict",
        "The automation claim changed before deferral.",
      );
    return this.getRun(scope, automationId, runId);
  }

  checkRunAdmission(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly claimToken: string;
      readonly now: number;
      readonly dispatch: boolean;
    },
  ): AutomationRunRecord {
    return this.database
      .transaction(() => {
        const run = this.getRun(scope, automationId, runId);
        if (
          run.state !== "claimed" ||
          run.claimToken !== input.claimToken ||
          run.forceResetAt !== null
        )
          throw new DomainError(
            "conflict",
            "The automation no longer owns its admission claim.",
          );
        const block = this.runAdmissionBlock(scope, run, input.now);
        if (block)
          return this.deferRun(scope, automationId, runId, {
            expectedState: "claimed",
            claimToken: input.claimToken,
            ...block,
            now: input.now,
          });
        return input.dispatch
          ? this.updateRunState(scope, automationId, runId, {
              expectedState: "claimed",
              state: "dispatching",
              claimToken: input.claimToken,
              retainPromptSnapshot: true,
              now: input.now,
            })
          : run;
      })
      .immediate();
  }

  runAdmissionBlock(
    scope: RequestScope,
    run: AutomationRunRecord,
    now: number,
  ):
    | {
        reason: AutomationDeferredReason;
        eligibleAt: number | null;
      }
    | undefined {
    const source = this.database
      .prepare(
        `SELECT inventory.inventory_state AS inventoryState,
      inventory.snoozed_until AS snoozedUntil, thread.backing_state AS backingState,
      workspace.removed_at AS removedAt FROM application_threads AS thread
      JOIN thread_principal_state AS inventory ON inventory.tenant_id = thread.tenant_id
        AND inventory.principal_id = thread.owner_principal_id AND inventory.thread_id = thread.id
      JOIN workspaces AS workspace ON workspace.tenant_id = thread.tenant_id
        AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?`,
      )
      .get(scope.tenantId, scope.principalId, run.anchorThreadId) as
      | {
          inventoryState: string;
          snoozedUntil: number | null;
          backingState: string;
          removedAt: number | null;
        }
      | undefined;
    if (!source)
      throw new DomainError(
        "not_found",
        "The automation source thread was not found.",
      );
    if (source.removedAt !== null)
      return { reason: "project_removed", eligibleAt: null };
    if (source.inventoryState === "archived")
      return { reason: "archived", eligibleAt: null };
    if (
      run.occurrenceKind === "scheduled" &&
      source.inventoryState === "snoozed" &&
      source.snoozedUntil !== null &&
      source.snoozedUntil > now
    )
      return { reason: "snoozed", eligibleAt: source.snoozedUntil };
    if (
      this.database
        .prepare(
          `SELECT 1 FROM automation_runs WHERE tenant_id = ? AND owner_principal_id = ?
      AND anchor_thread_id = ? AND id <> ? AND state = 'dispatching' LIMIT 1`,
        )
        .get(scope.tenantId, scope.principalId, run.anchorThreadId, run.id)
    )
      return { reason: "sibling", eligibleAt: null };
    if (source.backingState === "creating")
      return { reason: "source_materializing", eligibleAt: null };
    if (source.backingState === "creation_unknown")
      return { reason: "source_recovery", eligibleAt: null };
    const targetThreadId = run.childThreadId ?? run.anchorThreadId;
    const pending = this.database
      .prepare(
        `SELECT count(*) AS count FROM queued_inputs
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?
      AND (state IN ('pending','retry_wait','dispatching','uncertain') OR (state='failed' AND failure_acknowledged_at IS NULL))`,
      )
      .get(scope.tenantId, scope.principalId, targetThreadId) as {
      count: number;
    };
    if (pending.count >= MAXIMUM_ACTIVE_QUEUED_INPUTS)
      return { reason: "queue_capacity", eligibleAt: null };
    if (run.runMode === "clone" && run.childThreadId === null) {
      if (
        new ConversationOperationRepository(
          this.database,
        ).hasBlockingThreadOperation(scope, run.anchorThreadId)
      )
        return { reason: "source_recovery", eligibleAt: null };
      const blocked = this.database
        .prepare(
          `SELECT state FROM queued_inputs WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?
        AND (state IN ('pending','retry_wait','dispatching','uncertain') OR (state='failed' AND failure_acknowledged_at IS NULL))
        ORDER BY CASE WHEN state IN ('uncertain','failed') THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(scope.tenantId, scope.principalId, run.anchorThreadId) as
        { state: string } | undefined;
      if (blocked)
        return {
          reason:
            blocked.state === "uncertain" || blocked.state === "failed"
              ? "source_recovery"
              : "source_busy",
          eligibleAt: null,
        };
    }
    return undefined;
  }

  listDeferredRuns(now: number, limit: number): AutomationRunRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${runColumns} FROM automation_runs WHERE state = 'deferred'
      AND (eligible_at IS NULL OR eligible_at <= ? OR (deferred_reason = 'snoozed' AND EXISTS (SELECT 1 FROM thread_principal_state AS inventory WHERE inventory.tenant_id = automation_runs.tenant_id AND inventory.principal_id = automation_runs.owner_principal_id AND inventory.thread_id = automation_runs.anchor_thread_id AND inventory.inventory_state <> 'snoozed'))) ORDER BY updated_at, created_at, id LIMIT ?`,
        )
        .all(now, limit) as RunRow[]
    ).map(runFromRow);
  }

  hasDeferredRuns(): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM automation_runs WHERE state = 'deferred' LIMIT 1`,
        )
        .get(),
    );
  }

  refreshDeferredBlock(
    scope: RequestScope,
    run: AutomationRunRecord,
    now: number,
  ): boolean {
    const block = this.runAdmissionBlock(scope, run, now);
    if (!block) return false;
    this.database
      .prepare(
        `UPDATE automation_runs SET deferred_reason = ?, eligible_at = ?,
      initial_eligible_at = CASE WHEN deferred_reason IS NULL THEN coalesce(?, initial_eligible_at) ELSE initial_eligible_at END,
      suppressed_at = CASE WHEN ? IN ('snoozed','archived','project_removed') THEN coalesce(suppressed_at, ?) ELSE suppressed_at END,
      suppression_pending = CASE WHEN ? IN ('snoozed','archived','project_removed') THEN 1 ELSE suppression_pending END,
      updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ? AND state = 'deferred'`,
      )
      .run(
        block.reason,
        block.eligibleAt,
        block.eligibleAt,
        block.reason,
        now,
        block.reason,
        now,
        scope.tenantId,
        scope.principalId,
        run.automationId,
        run.id,
      );
    return true;
  }

  reclaimDeferredRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly claimToken: string;
      readonly leaseExpiresAt: number;
      readonly now: number;
    },
  ): AutomationRunRecord {
    const changed = this.database
      .prepare(
        `UPDATE automation_runs SET state = 'claimed', claim_token = ?, lease_expires_at = ?,
      claim_attempt_count = claim_attempt_count + 1, eligible_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ? AND state = 'deferred'`,
      )
      .run(
        input.claimToken,
        input.leaseExpiresAt,
        input.now,
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
      );
    if (changed.changes !== 1)
      throw new DomainError(
        "conflict",
        "The deferred run changed before admission.",
      );
    return this.getRun(scope, automationId, runId);
  }

  foldDeferredOccurrence(
    scope: RequestScope,
    run: AutomationRunRecord,
    input: {
      readonly nextRunAt: number | null;
      readonly lastScheduledAt: number;
      readonly coalescedCount: number;
      readonly expectedRevision: number;
      readonly now: number;
    },
  ): void {
    const advanced = this.database
      .prepare(
        `UPDATE automation_definitions SET next_run_at = ?, last_scheduled_at = ?,
      revision = revision + 1, updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .run(
        input.nextRunAt,
        input.lastScheduledAt,
        input.now,
        scope.tenantId,
        scope.principalId,
        run.automationId,
        input.expectedRevision,
      );
    if (advanced.changes !== 1)
      throw new DomainError(
        "conflict",
        "The automation changed during deferred schedule advancement.",
      );
    this.database
      .prepare(
        `UPDATE automation_runs SET coalesced_count = ?, suppression_pending = 0,
      updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ? AND state = 'deferred'`,
      )
      .run(
        input.coalescedCount,
        input.now,
        scope.tenantId,
        scope.principalId,
        run.automationId,
        run.id,
      );
  }

  createDefinition(
    scope: RequestScope,
    input: CreateAutomationDefinitionInput,
  ): AutomationDefinitionRecord {
    const id = input.id ?? randomUUID();
    const schedule = flattenSchedule(input.schedule);
    this.database
      .prepare(
        `
          INSERT INTO automation_definitions(
            tenant_id, owner_principal_id, id, anchor_thread_id, name, prompt,
            precheck_command, precheck_timeout_seconds,
            precheck_include_stdout,
            run_mode, enabled, completed_at, deleted_at, revision,
            schedule_kind, run_at, interval_anchor_at, interval_seconds,
            cron_expression, time_zone, misfire_policy, next_run_at,
            last_scheduled_at, created_at, updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?,
            NULL, ?, ?
          )
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        id,
        input.anchorThreadId,
        input.name,
        input.prompt,
        input.precheck?.command ?? null,
        input.precheck?.timeoutSeconds ?? null,
        input.precheck ? (input.precheck.includeStdout ? 1 : 0) : null,
        input.runMode,
        input.enabled ? 1 : 0,
        schedule.kind,
        schedule.runAt,
        schedule.intervalAnchorAt,
        schedule.intervalSeconds,
        schedule.cronExpression,
        schedule.timeZone,
        input.misfirePolicy ?? "coalesce",
        input.nextRunAt,
        input.now,
        input.now,
      );
    return this.getDefinition(scope, id);
  }

  getDefinition(
    scope: RequestScope,
    automationId: string,
  ): AutomationDefinitionRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${definitionColumns}
          FROM automation_definitions
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, automationId) as
      DefinitionRow | undefined;
    if (!row) {
      throw new DomainError("not_found", "The automation was not found.");
    }
    return definitionFromRow(row);
  }

  findRunByScopedId(
    scope: RequestScope,
    runId: string,
  ): AutomationRunRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, runId) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  findRunByDispatchMutation(
    scope: RequestScope,
    applicationThreadId: string,
    mutationId: string,
  ): AutomationRunRecord | undefined {
    const rows = this.database
      .prepare(
        `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND dispatch_mutation_id = ?
            AND coalesce(child_thread_id, anchor_thread_id) = ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        mutationId,
        applicationThreadId,
      ) as RunRow[];
    if (rows.length > 1) {
      throw new DomainError(
        "conflict",
        "The automation dispatch mutation is not unique in this thread.",
      );
    }
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  /**
   * Records how the turn a run's prompt started ended, from the completion
   * rail's observation of `operationId` (the run's dispatch mutation) on its
   * result thread, and fills in turn times the settlement still lacks.
   * Replays are frequent, so this returns the run only when it changed it.
   * Force-reset runs are immutable and never settle.
   */
  settleRunTurn(
    scope: RequestScope,
    resultThreadId: string,
    operationId: string,
    input: AutomationTurnSettlementInput,
  ): AutomationRunRecord | undefined {
    return this.database.transaction(() => {
      const run = this.findRunByDispatchMutation(
        scope,
        resultThreadId,
        operationId,
      );
      if (!run || run.forceResetAt !== null) return undefined;
      if (run.turnId !== null && run.turnId !== input.turnId) {
        throw new DomainError(
          "conflict",
          "The automation run already settled a different turn.",
        );
      }
      let startedAt = run.turnStartedAt ?? input.startedAt;
      let endedAt = run.turnEndedAt ?? input.endedAt;
      if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
        startedAt = run.turnStartedAt;
        endedAt = run.turnEndedAt;
      }
      if (
        run.turnId !== null &&
        startedAt === run.turnStartedAt &&
        endedAt === run.turnEndedAt
      ) {
        return undefined;
      }
      this.database
        .prepare(
          `
            UPDATE automation_runs
            SET turn_id = ?, turn_outcome = ?, turn_settled_at = ?,
              turn_started_at = ?, turn_ended_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND automation_id = ? AND id = ?
          `,
        )
        .run(
          input.turnId,
          run.turnOutcome ?? input.outcome,
          run.turnSettledAt ?? input.settledAt,
          startedAt,
          endedAt,
          scope.tenantId,
          scope.principalId,
          run.automationId,
          run.id,
        );
      return this.getRun(scope, run.automationId, run.id);
    })();
  }

  /**
   * Settles every unsettled run whose turn the completion rail already
   * recorded: observations that arrived before the observer was bound or
   * across a crash. The rail keeps no turn times, so a later replay adds
   * them. Returns the runs it settled.
   */
  settleRunTurnsFromCompletions(): AutomationRunRecord[] {
    return (
      this.database
        .prepare(
          `
            UPDATE automation_runs AS run
            SET turn_id = observation.application_turn_id,
              turn_outcome = observation.completion_outcome,
              turn_settled_at = observation.completion_observed_at
            FROM submission_completion_observations AS observation
            WHERE observation.tenant_id = run.tenant_id
              AND observation.owner_principal_id = run.owner_principal_id
              AND observation.application_thread_id =
                coalesce(run.child_thread_id, run.anchor_thread_id)
              AND observation.operation_id = run.dispatch_mutation_id
              AND observation.application_turn_id IS NOT NULL
              AND run.turn_id IS NULL
              AND run.force_reset_at IS NULL
            RETURNING ${runColumns}
          `,
        )
        .all() as RunRow[]
    ).map(runFromRow);
  }

  listDefinitions(
    scope: RequestScope,
    input: {
      readonly includeDeleted?: boolean;
      readonly threadId?: string;
      readonly status?: "enabled" | "paused" | "completed";
      readonly limit: number;
      readonly offset?: number;
    },
  ): AutomationDefinitionRecord[] {
    assertPage(input.limit, input.offset ?? 0, 101);
    return (
      this.database
        .prepare(
          `
            SELECT ${definitionColumns}
            FROM automation_definitions
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND (? = 1 OR deleted_at IS NULL)
              AND (? IS NULL OR anchor_thread_id = ?)
              AND (
                ? IS NULL
                OR (? = 'enabled' AND completed_at IS NULL AND enabled = 1)
                OR (? = 'paused' AND completed_at IS NULL AND enabled = 0)
                OR (? = 'completed' AND completed_at IS NOT NULL)
              )
            ORDER BY updated_at DESC, id
            LIMIT ? OFFSET ?
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          input.includeDeleted ? 1 : 0,
          input.threadId ?? null,
          input.threadId ?? null,
          input.status ?? null,
          input.status ?? null,
          input.status ?? null,
          input.status ?? null,
          input.limit,
          input.offset ?? 0,
        ) as DefinitionRow[]
    ).map(definitionFromRow);
  }

  updateDefinition(
    scope: RequestScope,
    automationId: string,
    input: UpdateAutomationDefinitionInput,
  ): AutomationDefinitionRecord {
    return this.database.transaction(() => {
      const current = this.getDefinition(scope, automationId);
      if (
        JSON.stringify(current.schedule) !== JSON.stringify(input.schedule) ||
        current.runMode !== input.runMode ||
        current.misfirePolicy !== input.misfirePolicy
      ) {
        this.cancelDeferredRuns(
          scope,
          automationId,
          "automation_superseded",
          input.now,
        );
      }
      this.assertNoNonterminalRun(scope, automationId, true);
      const schedule = flattenSchedule(input.schedule);
      const result = this.database
        .prepare(
          `
          UPDATE automation_definitions
          SET
            anchor_thread_id = ?,
            name = ?,
            prompt = ?,
            precheck_command = ?,
            precheck_timeout_seconds = ?,
            precheck_include_stdout = ?,
            run_mode = ?,
            enabled = ?,
            completed_at = ?,
            schedule_kind = ?,
            run_at = ?,
            interval_anchor_at = ?,
            interval_seconds = ?,
            cron_expression = ?,
            time_zone = ?,
            misfire_policy = ?,
            next_run_at = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND revision = ? AND deleted_at IS NULL
        `,
        )
        .run(
          input.anchorThreadId,
          input.name,
          input.prompt,
          input.precheck?.command ?? null,
          input.precheck?.timeoutSeconds ?? null,
          input.precheck ? (input.precheck.includeStdout ? 1 : 0) : null,
          input.runMode,
          input.enabled ? 1 : 0,
          input.completedAt,
          schedule.kind,
          schedule.runAt,
          schedule.intervalAnchorAt,
          schedule.intervalSeconds,
          schedule.cronExpression,
          schedule.timeZone,
          input.misfirePolicy ?? "coalesce",
          input.nextRunAt,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        this.throwDefinitionConflictOrNotFound(scope, automationId);
      }
      return this.getDefinition(scope, automationId);
    })();
  }

  pauseDefinition(
    scope: RequestScope,
    automationId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): AutomationDefinitionRecord {
    return this.database.transaction(() => {
      this.cancelDeferredRuns(
        scope,
        automationId,
        "automation_paused",
        input.now,
      );
      const result = this.database
        .prepare(
          `
          UPDATE automation_definitions
          SET enabled = 0, next_run_at = NULL, revision = revision + 1,
            updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND revision = ? AND deleted_at IS NULL
        `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        this.throwDefinitionConflictOrNotFound(scope, automationId);
      }
      return this.getDefinition(scope, automationId);
    })();
  }

  pauseDefinitionAfterUncertain(
    scope: RequestScope,
    automationId: string,
    now: number,
  ): AutomationDefinitionRecord {
    this.database
      .prepare(
        `
          UPDATE automation_definitions
          SET enabled = 0, next_run_at = NULL, revision = revision + 1,
            updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND enabled = 1 AND deleted_at IS NULL
        `,
      )
      .run(now, scope.tenantId, scope.principalId, automationId);
    return this.getDefinition(scope, automationId);
  }

  resolveUncertainRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    now: number,
  ): AutomationRunRecord {
    const current = this.getRun(scope, automationId, runId);
    if (current.state !== "uncertain") {
      throw new DomainError(
        "conflict",
        "Only an uncertain automation run can be resolved.",
      );
    }
    return this.updateRunState(scope, automationId, runId, {
      expectedState: "uncertain",
      state: "failed",
      errorCode: "automation_uncertain_resolved",
      errorDiagnostic: "The uncertain run was manually resolved.",
      now,
      completeDefinition:
        current.occurrenceKind === "scheduled" &&
        this.getDefinition(scope, automationId).schedule.kind === "date_time",
    });
  }

  markRunUncertainAndPause(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly expectedState: "dispatching" | "queued" | "running";
      readonly claimToken?: string;
      readonly errorCode: string;
      readonly errorDiagnostic: string;
      readonly now: number;
    },
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const run = this.updateRunState(scope, automationId, runId, {
        expectedState: input.expectedState,
        state: "uncertain",
        ...(input.claimToken ? { claimToken: input.claimToken } : {}),
        retainPromptSnapshot: true,
        errorCode: input.errorCode,
        errorDiagnostic: input.errorDiagnostic,
        now: input.now,
      });
      this.pauseDefinitionAfterUncertain(scope, automationId, input.now);
      return run;
    })();
  }

  enableDefinition(
    scope: RequestScope,
    automationId: string,
    input: {
      readonly expectedRevision: number;
      readonly nextRunAt: number;
      readonly now: number;
    },
  ): AutomationDefinitionRecord {
    return this.database.transaction(() => {
      this.assertNoNonterminalRun(scope, automationId);
      const result = this.database
        .prepare(
          `
            UPDATE automation_definitions
            SET enabled = 1, completed_at = NULL, next_run_at = ?,
              revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ? AND deleted_at IS NULL
          `,
        )
        .run(
          input.nextRunAt,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        this.throwDefinitionConflictOrNotFound(scope, automationId);
      }
      return this.getDefinition(scope, automationId);
    })();
  }

  softDeleteDefinition(
    scope: RequestScope,
    automationId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): AutomationDefinitionRecord {
    return this.database.transaction(() => {
      this.cancelDeferredRuns(
        scope,
        automationId,
        "automation_deleted",
        input.now,
      );
      this.assertNoNonterminalRun(scope, automationId);
      const result = this.database
        .prepare(
          `
            UPDATE automation_definitions
            SET enabled = 0, next_run_at = NULL, deleted_at = ?,
              revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ? AND deleted_at IS NULL
          `,
        )
        .run(
          input.now,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        this.throwDefinitionConflictOrNotFound(scope, automationId);
      }
      return this.getDefinition(scope, automationId);
    })();
  }

  listDueDefinitions(now: number, limit: number): AutomationDefinitionRecord[] {
    assertPage(limit, 0);
    return (
      this.database
        .prepare(
          `
            SELECT ${definitionColumns}
            FROM automation_definitions
            WHERE enabled = 1
              AND completed_at IS NULL
              AND deleted_at IS NULL
              AND next_run_at IS NOT NULL
              AND next_run_at <= ?
              AND EXISTS (
                SELECT 1
                FROM thread_principal_state AS inventory
                WHERE inventory.tenant_id = automation_definitions.tenant_id
                  AND inventory.principal_id =
                    automation_definitions.owner_principal_id
                  AND inventory.thread_id =
                    automation_definitions.anchor_thread_id
                  AND inventory.inventory_state <> 'archived'
              )
              AND EXISTS (SELECT 1 FROM application_threads AS source
                JOIN workspaces AS workspace ON workspace.tenant_id=source.tenant_id
                  AND workspace.owner_principal_id=source.owner_principal_id AND workspace.id=source.workspace_id
                WHERE source.tenant_id=automation_definitions.tenant_id
                  AND source.owner_principal_id=automation_definitions.owner_principal_id
                  AND source.id=automation_definitions.anchor_thread_id AND workspace.removed_at IS NULL)
              AND NOT EXISTS (
                SELECT 1
                FROM automation_runs AS run
                WHERE run.tenant_id = automation_definitions.tenant_id
                  AND run.owner_principal_id =
                    automation_definitions.owner_principal_id
                  AND run.automation_id = automation_definitions.id
                  AND run.state IN (
                    'claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred'
                  )
              )
            ORDER BY next_run_at, tenant_id, owner_principal_id, id
            LIMIT ?
          `,
        )
        .all(now, limit) as DefinitionRow[]
    ).map(definitionFromRow);
  }

  getNearestDeadline(): number | null {
    const row = this.database
      .prepare(
        `
          SELECT min(deadline) AS deadline
          FROM (
            SELECT next_run_at AS deadline
            FROM automation_definitions
            WHERE enabled = 1 AND completed_at IS NULL AND deleted_at IS NULL
              AND next_run_at IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM thread_principal_state AS inventory
                WHERE inventory.tenant_id = automation_definitions.tenant_id
                  AND inventory.principal_id =
                    automation_definitions.owner_principal_id
                  AND inventory.thread_id =
                    automation_definitions.anchor_thread_id
                  AND inventory.inventory_state <> 'archived'
              )
              AND EXISTS (SELECT 1 FROM application_threads AS source
                JOIN workspaces AS workspace ON workspace.tenant_id=source.tenant_id
                  AND workspace.owner_principal_id=source.owner_principal_id AND workspace.id=source.workspace_id
                WHERE source.tenant_id=automation_definitions.tenant_id
                  AND source.owner_principal_id=automation_definitions.owner_principal_id
                  AND source.id=automation_definitions.anchor_thread_id AND workspace.removed_at IS NULL)
              AND NOT EXISTS (
                SELECT 1
                FROM automation_runs AS run
                WHERE run.tenant_id = automation_definitions.tenant_id
                  AND run.owner_principal_id =
                    automation_definitions.owner_principal_id
                  AND run.automation_id = automation_definitions.id
                  AND run.state IN (
                    'claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred'
                  )
              )
            UNION ALL
            SELECT eligible_at AS deadline FROM automation_runs WHERE state = 'deferred' AND eligible_at IS NOT NULL
            UNION ALL
            SELECT lease_expires_at AS deadline
            FROM automation_runs
            WHERE state IN ('claimed', 'dispatching')
              AND lease_expires_at IS NOT NULL
          )
        `,
      )
      .get() as { deadline: number | null };
    return row.deadline;
  }

  listExpiredLeasedRuns(now: number, limit: number): AutomationRunRecord[] {
    assertPage(limit, 0);
    return (
      this.database
        .prepare(
          `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE state IN ('claimed', 'dispatching')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY lease_expires_at, tenant_id, owner_principal_id,
            automation_id, id
          LIMIT ?
        `,
        )
        .all(now, limit) as RunRow[]
    ).map(runFromRow);
  }

  listNonterminalRuns(limit: number): AutomationRunRecord[] {
    assertPage(limit, 0);
    return (
      this.database
        .prepare(
          `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE state IN (
            'claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred'
          )
          ORDER BY updated_at, tenant_id, owner_principal_id, automation_id, id
          LIMIT ?
        `,
        )
        .all(limit) as RunRow[]
    ).map(runFromRow);
  }

  listQueueObservedRuns(): AutomationRunRecord[] {
    return (
      this.database
        .prepare(
          `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE state IN ('queued', 'running')
          ORDER BY updated_at, tenant_id, owner_principal_id, automation_id, id
        `,
        )
        .all() as RunRow[]
    ).map(runFromRow);
  }

  claimScheduledOccurrence(
    scope: RequestScope,
    automationId: string,
    input: ScheduledOccurrenceClaimInput,
  ): AutomationClaimResult {
    return this.database.transaction(() => {
      const definition = this.getDefinition(scope, automationId);
      const replay = this.findOccurrence(
        scope,
        automationId,
        input.occurrenceKey,
      );
      if (replay) {
        this.assertOccurrenceReplay(replay, "scheduled", input);
        return { run: replay, replayed: true };
      }
      if (
        definition.deletedAt !== null ||
        definition.completedAt !== null ||
        !definition.enabled ||
        definition.nextRunAt !== input.scheduledFor ||
        input.scheduledFor > input.now
      ) {
        throw new DomainError(
          "conflict",
          "The scheduled occurrence is no longer due.",
        );
      }
      this.assertNoNonterminalRun(scope, automationId);
      const runId = input.runId ?? randomUUID();
      this.insertClaimedRun(scope, definition, {
        runId,
        occurrenceKind: "scheduled",
        occurrenceKey: input.occurrenceKey,
        scheduledFor: input.scheduledFor,
        coalescedCount: input.coalescedCount,
        claimToken: input.claimToken,
        leaseExpiresAt: input.leaseExpiresAt,
        dispatchMutationId: input.dispatchMutationId,
        now: input.now,
      });
      const advanced = this.database
        .prepare(
          `
            UPDATE automation_definitions
            SET next_run_at = ?, last_scheduled_at = ?,
              revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ? AND next_run_at = ?
          `,
        )
        .run(
          input.nextRunAt,
          input.lastScheduledAt,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          definition.revision,
          input.scheduledFor,
        );
      if (advanced.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The automation schedule changed while claiming the occurrence.",
        );
      }
      return {
        run: this.getRun(scope, automationId, runId),
        replayed: false,
      };
    })();
  }

  createManualRun(
    scope: RequestScope,
    automationId: string,
    input: ManualOccurrenceClaimInput,
  ): AutomationClaimResult {
    return this.database.transaction(() => {
      const definition = this.getDefinition(scope, automationId);
      const replay = this.findOccurrence(
        scope,
        automationId,
        input.occurrenceKey,
      );
      if (replay) {
        this.assertOccurrenceReplay(replay, "manual", input);
        return { run: replay, replayed: true };
      }
      if (definition.deletedAt !== null) {
        throw new DomainError("conflict", "A deleted automation cannot run.");
      }
      this.assertNoNonterminalRun(scope, automationId);
      const runId = input.runId ?? randomUUID();
      this.insertClaimedRun(scope, definition, {
        runId,
        occurrenceKind: "manual",
        occurrenceKey: input.occurrenceKey,
        scheduledFor: input.scheduledFor,
        coalescedCount: 0,
        claimToken: input.claimToken,
        leaseExpiresAt: input.leaseExpiresAt,
        dispatchMutationId: input.dispatchMutationId,
        now: input.now,
      });
      return {
        run: this.getRun(scope, automationId, runId),
        replayed: false,
      };
    })();
  }

  reclaimExpiredRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly claimToken: string;
      readonly leaseExpiresAt: number;
      readonly now: number;
    },
  ): AutomationRunRecord {
    const result = this.database
      .prepare(
        `
          UPDATE automation_runs
          SET claim_token = ?, lease_expires_at = ?,
            claim_attempt_count = claim_attempt_count + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ? AND id = ?
            AND state = 'claimed' AND precheck_status <> 'checking'
            AND lease_expires_at <= ?
        `,
      )
      .run(
        input.claimToken,
        input.leaseExpiresAt,
        input.now,
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
        input.now,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The automation run claim is not reclaimable.",
      );
    }
    return this.getRun(scope, automationId, runId);
  }

  beginPrecheck(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly claimToken: string;
      readonly now: number;
    },
  ): AutomationRunRecord {
    const result = this.database
      .prepare(
        `
          UPDATE automation_runs
          SET precheck_status = 'checking', precheck_started_at = ?,
            updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ? AND id = ?
            AND state = 'claimed' AND precheck_status = 'pending'
            AND claim_token = ?
        `,
      )
      .run(
        input.now,
        input.now,
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
        input.claimToken,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The automation pre-check changed in another operation.",
      );
    }
    return this.getRun(scope, automationId, runId);
  }

  passPrecheck(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: AutomationPrecheckCompletion & {
      readonly claimToken: string;
      readonly effectivePrompt: string;
      readonly stdoutAppendix?: string | null;
      readonly stdoutIncluded: boolean;
    },
  ): AutomationRunRecord {
    const result = this.database
      .prepare(
        `
          UPDATE automation_runs
          SET precheck_status = 'passed', precheck_finished_at = ?,
            precheck_exit_code = 0, precheck_duration_ms = ?,
            precheck_stdout_bytes = ?, precheck_stdout_included = ?,
            prompt_snapshot = ?, precheck_stdout = ?, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ? AND id = ?
            AND state = 'claimed' AND precheck_status = 'checking'
            AND claim_token = ?
        `,
      )
      .run(
        input.now,
        input.durationMilliseconds,
        input.stdoutBytes,
        input.stdoutIncluded ? 1 : 0,
        input.effectivePrompt,
        input.stdoutAppendix ?? null,
        input.now,
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
        input.claimToken,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The automation pre-check changed in another operation.",
      );
    }
    return this.getRun(scope, automationId, runId);
  }

  finishPrecheckWithoutDispatch(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: AutomationPrecheckCompletion & {
      readonly claimToken: string;
      readonly decision: "skipped" | "failed";
      readonly errorCode: string;
      readonly errorDiagnostic: string;
      readonly detachDefinition: boolean;
    },
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
            UPDATE automation_runs
            SET precheck_status = ?, precheck_finished_at = ?,
              precheck_exit_code = ?, precheck_duration_ms = ?,
              precheck_stdout_bytes = ?, precheck_stdout_included = 0,
              updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND automation_id = ? AND id = ?
              AND state = 'claimed' AND precheck_status = 'checking'
              AND claim_token = ?
          `,
        )
        .run(
          input.decision,
          input.now,
          input.exitCode ?? null,
          input.durationMilliseconds,
          input.stdoutBytes,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          runId,
          input.claimToken,
        );
      if (result.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The automation pre-check changed in another operation.",
        );
      }
      return this.updateRunState(scope, automationId, runId, {
        expectedState: "claimed",
        state: input.decision === "skipped" ? "skipped" : "failed",
        claimToken: input.claimToken,
        errorCode: input.errorCode,
        errorDiagnostic: input.errorDiagnostic,
        now: input.now,
        completeDefinition: input.detachDefinition,
      });
    })();
  }

  failInterruptedPrecheck(
    scope: RequestScope,
    automationId: string,
    runId: string,
    now: number,
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(scope, automationId, runId);
      if (
        current.state !== "claimed" ||
        current.precheckStatus !== "checking" ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt > now
      ) {
        throw new DomainError(
          "conflict",
          "The automation pre-check is not interrupted.",
        );
      }
      return this.finishPrecheckWithoutDispatch(scope, automationId, runId, {
        claimToken: current.claimToken!,
        decision: "failed",
        errorCode: "automation_precheck_interrupted",
        errorDiagnostic:
          "The server stopped while the pre-check command was running.",
        durationMilliseconds: Math.max(
          0,
          now - (current.precheckStartedAt ?? current.claimedAt),
        ),
        stdoutBytes: current.precheckStdoutBytes ?? 0,
        now,
        detachDefinition:
          current.occurrenceKind === "scheduled" &&
          this.getDefinition(scope, automationId).schedule.kind === "date_time",
      });
    })();
  }

  updateRunState(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: AutomationRunStateUpdate,
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(scope, automationId, runId);
      if (current.state !== input.expectedState) {
        throw new DomainError(
          "conflict",
          "The automation run changed in another operation.",
        );
      }
      if (!isAllowedRunTransition(current.state, input.state)) {
        throw new DomainError(
          "invalid_transition",
          `Automation runs cannot move from ${current.state} to ${input.state}.`,
        );
      }
      if (
        current.claimToken !== null &&
        current.claimToken !== input.claimToken
      ) {
        throw new DomainError(
          "conflict",
          "The automation run claim token changed.",
        );
      }
      if (
        input.state === "dispatching" &&
        current.occurrenceKind === "scheduled"
      ) {
        const inventory = this.database
          .prepare(
            `
              SELECT inventory_state AS inventoryState,
                snoozed_until AS snoozedUntil
              FROM thread_principal_state
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, current.anchorThreadId) as
          { inventoryState: string; snoozedUntil: number | null } | undefined;
        if (!inventory || inventory.inventoryState === "archived") {
          throw new DomainError(
            "archived_thread",
            "An archived thread cannot dispatch a scheduled automation.",
          );
        }
        if (
          inventory.inventoryState === "snoozed" &&
          inventory.snoozedUntil !== null &&
          inventory.snoozedUntil > input.now
        ) {
          throw new DomainError(
            "invalid_transition",
            "The scheduled automation was suppressed because its thread is snoozed.",
            true,
          );
        }
      }
      const timestamps = nextRunTimestamps(current, input.state, input.now);
      const keepsClaim = input.state === "dispatching";
      const promptSnapshot = input.retainPromptSnapshot
        ? current.promptSnapshot
        : null;
      const updated = this.database
        .prepare(
          `
            UPDATE automation_runs
            SET state = ?, claim_token = ?, lease_expires_at = ?,
              prompt_snapshot = ?, error_code = ?, error_diagnostic = ?,
              started_at = ?, accepted_at = ?, finished_at = ?, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND automation_id = ? AND id = ? AND state = ?
          `,
        )
        .run(
          input.state,
          keepsClaim ? current.claimToken : null,
          keepsClaim ? current.leaseExpiresAt : null,
          promptSnapshot,
          input.state === "completed"
            ? null
            : (input.errorCode ?? current.errorCode),
          input.state === "completed"
            ? null
            : (input.errorDiagnostic ?? current.errorDiagnostic),
          timestamps.startedAt,
          timestamps.acceptedAt,
          timestamps.finishedAt,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          runId,
          input.expectedState,
        );
      if (updated.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The automation run changed in another operation.",
        );
      }
      // A failed or uncertain run returns a parked (stored as settled) anchor
      // to Active, as accepted input does, so a parked thread cannot hide its
      // own failure. Clone runs return the anchor too. Resolving an uncertain
      // run records the user's decision, not a new failure; that uncertainty
      // already returned the anchor, and a later Park stays authoritative.
      if (
        input.state === "uncertain" ||
        (input.state === "failed" && current.state !== "uncertain")
      ) {
        activateSettledThread(
          this.database,
          scope,
          current.anchorThreadId,
          input.now,
        );
      }
      if (input.completeDefinition) {
        if (
          !["completed", "failed", "skipped", "cancelled"].includes(input.state)
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only a terminal run can complete its definition.",
          );
        }
        const definition = this.getDefinition(scope, automationId);
        if (definition.schedule.kind !== "date_time") {
          throw new DomainError(
            "invalid_transition",
            "Only a Date & time automation can become completed.",
          );
        }
        const detached = this.database
          .prepare(
            `
              UPDATE automation_definitions
              SET enabled = 0, completed_at = ?, next_run_at = NULL,
                revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND deleted_at IS NULL
            `,
          )
          .run(
            input.now,
            input.now,
            scope.tenantId,
            scope.principalId,
            automationId,
          );
        if (detached.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The one-shot automation could not be exhausted.",
          );
        }
      }
      return this.getRun(scope, automationId, runId);
    })();
  }

  bindResultChild(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly childThreadId: string;
      readonly claimToken?: string;
      readonly now: number;
    },
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(scope, automationId, runId);
      if (
        current.forceResetAt !== null ||
        (input.claimToken !== undefined &&
          current.claimToken !== input.claimToken)
      ) {
        throw new DomainError(
          "conflict",
          "The automation claim is no longer active.",
        );
      }
      if (current.runMode !== "clone") {
        throw new DomainError(
          "invalid_transition",
          "Only a clone run can bind a fork child.",
        );
      }
      if (current.childThreadId !== null) {
        if (current.childThreadId !== input.childThreadId) {
          throw new DomainError(
            "conflict",
            "The clone run is already bound to different branch lineage.",
          );
        }
      }
      const lineage = this.database
        .prepare(
          `
            SELECT
              child.backend_instance_id AS childBackendInstanceId,
              anchor.backend_instance_id AS anchorBackendInstanceId
            FROM application_threads AS child
            JOIN conversation_bindings AS binding
              ON binding.tenant_id = child.tenant_id
              AND binding.owner_principal_id = child.owner_principal_id
              AND binding.application_thread_id = child.id
            JOIN application_threads AS anchor
              ON anchor.tenant_id = child.tenant_id
              AND anchor.owner_principal_id = child.owner_principal_id
              AND anchor.id = ?
            JOIN thread_fork_origins AS origin
              ON origin.tenant_id = child.tenant_id
              AND origin.owner_principal_id = child.owner_principal_id
              AND origin.child_thread_id = child.id
            WHERE child.tenant_id = ? AND child.owner_principal_id = ?
              AND child.id = ? AND child.backing_state = 'bound'
              AND origin.source_thread_state = 'resolved'
              AND origin.source_thread_id = anchor.id
              AND origin.origin_kind = 'automation_fork'
              AND origin.origin_state = 'committed'
              AND origin.source_automation_id = ?
              AND origin.source_automation_run_id = ?
          `,
        )
        .get(
          current.anchorThreadId,
          scope.tenantId,
          scope.principalId,
          input.childThreadId,
          automationId,
          runId,
        ) as
        | {
            childBackendInstanceId: string;
            anchorBackendInstanceId: string;
          }
        | undefined;
      const copied = this.database
        .prepare(
          `
        SELECT 1 FROM mutation_receipts AS receipt
        JOIN application_threads AS child ON child.tenant_id = receipt.tenant_id
          AND child.owner_principal_id = receipt.principal_id AND child.id = ?
        JOIN application_threads AS anchor ON anchor.tenant_id = child.tenant_id
          AND anchor.owner_principal_id = child.owner_principal_id AND anchor.id = ?
        WHERE receipt.tenant_id = ? AND receipt.principal_id = ?
          AND receipt.mutation_id = ? AND receipt.operation_kind = 'automation_thread_copy'
          AND json_extract(receipt.result_json, '$.applicationThreadId') = child.id
          AND json_extract(receipt.result_json, '$.sourceApplicationThreadId') = anchor.id
          AND json_extract(receipt.result_json, '$.automationId') = ?
          AND json_extract(receipt.result_json, '$.automationRunId') = ?
          AND child.workspace_id = anchor.workspace_id
          AND child.backend_instance_id = anchor.backend_instance_id
          AND child.force_reset_at IS NULL
      `,
        )
        .get(
          input.childThreadId,
          current.anchorThreadId,
          scope.tenantId,
          scope.principalId,
          current.dispatchMutationId,
          automationId,
          runId,
        );
      if (
        !copied &&
        (!lineage ||
          lineage.childBackendInstanceId !== lineage.anchorBackendInstanceId)
      ) {
        throw new DomainError(
          "conflict",
          "The fork child does not match the automation anchor.",
        );
      }
      if (current.childThreadId === input.childThreadId) {
        return current;
      }
      const updated = this.database
        .prepare(
          `
            UPDATE automation_runs
            SET child_thread_id = ?, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND automation_id = ? AND id = ? AND run_mode = 'clone'
              AND child_thread_id IS NULL
              AND force_reset_at IS NULL
          `,
        )
        .run(
          input.childThreadId,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          runId,
        );
      if (updated.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The automation branch lineage changed in another operation.",
        );
      }
      return this.getRun(scope, automationId, runId);
    })();
  }

  getRun(
    scope: RequestScope,
    automationId: string,
    runId: string,
  ): AutomationRunRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, automationId, runId) as
      RunRow | undefined;
    if (!row) {
      throw new DomainError("not_found", "The automation run was not found.");
    }
    return runFromRow(row);
  }

  listRuns(
    scope: RequestScope,
    automationId: string,
    input: {
      readonly limit: number;
      readonly after?: { readonly createdAt: number; readonly id: string };
      readonly filter?: AutomationRunFilter;
    },
  ): AutomationRunRecord[] {
    assertPage(input.limit, 0, 101);
    if (
      input.after !== undefined &&
      (!Number.isSafeInteger(input.after.createdAt) ||
        input.after.createdAt < 0 ||
        input.after.id.length < 1 ||
        input.after.id.length > 128)
    ) {
      throw new DomainError(
        "cursor_invalid",
        "The automation cursor is invalid.",
      );
    }
    const page = (condition: string) => `
      SELECT ${runColumns}
      FROM automation_runs
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND automation_id = ?
        ${condition}
        ${input.after ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    const pageParameters = [
      scope.tenantId,
      scope.principalId,
      automationId,
      ...(input.after
        ? [input.after.createdAt, input.after.createdAt, input.after.id]
        : []),
      input.limit,
    ];
    const branches = RUN_FILTER_BRANCHES[input.filter ?? "all"];
    if (branches === null) {
      return (
        this.database.prepare(page("")).all(...pageParameters) as RunRow[]
      ).map(runFromRow);
    }
    // One ordered, limited branch per condition, each over its own index
    // (automation_runs_state_history per state, and
    // automation_runs_failed_turn_history for failed turns), keeps a page
    // bounded by its size, however sparse the matching runs are.
    return (
      this.database
        .prepare(
          `
            ${branches.map((condition) => `SELECT * FROM (${page(condition)})`).join(" UNION ALL ")}
            ORDER BY createdAt DESC, id DESC
            LIMIT ?
          `,
        )
        .all(...branches.flatMap(() => pageParameters), input.limit) as RunRow[]
    ).map(runFromRow);
  }

  countRuns(scope: RequestScope, automationId: string): AutomationRunCounts {
    const parameters = [scope.tenantId, scope.principalId, automationId];
    const row = this.database
      .prepare(
        `
          SELECT count(*) AS total,
            coalesce(sum(state IN ('failed', 'uncertain')), 0) + (
              SELECT count(*)
              FROM automation_runs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND automation_id = ?
                AND turn_outcome = 'failed'
                AND state NOT IN ('failed', 'uncertain')
            ) AS problems,
            coalesce(sum(state = 'skipped'), 0) AS skipped
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ?
        `,
      )
      .get(...parameters, ...parameters) as {
      total: number;
      problems: number;
      skipped: number;
    };
    return { all: row.total, problems: row.problems, skipped: row.skipped };
  }

  private insertClaimedRun(
    scope: RequestScope,
    definition: AutomationDefinitionRecord,
    input: {
      readonly runId: string;
      readonly occurrenceKind: "scheduled" | "manual";
      readonly occurrenceKey: string;
      readonly scheduledFor: number;
      readonly coalescedCount: number;
      readonly claimToken: string;
      readonly leaseExpiresAt: number;
      readonly dispatchMutationId: string;
      readonly now: number;
    },
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO automation_runs(
            tenant_id, owner_principal_id, automation_id, id,
            occurrence_kind, scheduled_for, occurrence_key,
            definition_revision, coalesced_count, run_mode, state,
            claim_token, lease_expires_at, claim_attempt_count,
            prompt_snapshot, precheck_command_snapshot,
            precheck_timeout_seconds, precheck_include_stdout,
            precheck_status, dispatch_mutation_id, anchor_thread_id,
            child_thread_id,
            error_code, error_diagnostic,
            claimed_at, started_at, accepted_at, finished_at,
            created_at, updated_at, initial_eligible_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?
          )
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        definition.id,
        input.runId,
        input.occurrenceKind,
        input.scheduledFor,
        input.occurrenceKey,
        definition.revision,
        input.coalescedCount,
        definition.runMode,
        input.claimToken,
        input.leaseExpiresAt,
        definition.prompt,
        definition.precheck?.command ?? null,
        definition.precheck?.timeoutSeconds ?? null,
        definition.precheck
          ? definition.precheck.includeStdout
            ? 1
            : 0
          : null,
        definition.precheck ? "pending" : "not_configured",
        input.dispatchMutationId,
        definition.anchorThreadId,
        input.now,
        input.now,
        input.now,
        input.scheduledFor,
      );
  }

  private findOccurrence(
    scope: RequestScope,
    automationId: string,
    occurrenceKey: string,
  ): AutomationRunRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ? AND occurrence_key = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, automationId, occurrenceKey) as
      RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  private assertOccurrenceReplay(
    run: AutomationRunRecord,
    occurrenceKind: "scheduled" | "manual",
    input: {
      readonly scheduledFor: number;
      readonly dispatchMutationId: string;
    },
  ): void {
    if (
      run.occurrenceKind !== occurrenceKind ||
      run.scheduledFor !== input.scheduledFor ||
      run.dispatchMutationId !== input.dispatchMutationId
    ) {
      throw new DomainError(
        "conflict",
        "The occurrence key was already used for different work.",
      );
    }
  }

  private assertNoNonterminalRun(
    scope: RequestScope,
    automationId: string,
    allowDeferred = false,
  ): void {
    const existing = this.database
      .prepare(
        `
          SELECT 1
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ?
            AND (? = 0 OR state <> 'deferred')
            AND state IN (
              'claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred'
            )
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        automationId,
        allowDeferred ? 1 : 0,
      );
    if (existing) {
      throw new DomainError(
        "conflict",
        "The automation already has a nonterminal run.",
      );
    }
  }

  private throwDefinitionConflictOrNotFound(
    scope: RequestScope,
    automationId: string,
  ): never {
    const exists = this.database
      .prepare(
        `
          SELECT 1
          FROM automation_definitions
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, automationId);
    if (!exists) {
      throw new DomainError("not_found", "The automation was not found.");
    }
    throw new DomainError(
      "conflict",
      "The automation changed in another operation.",
    );
  }
}

function flattenSchedule(schedule: AutomationSchedule): {
  readonly kind: AutomationSchedule["kind"];
  readonly runAt: number | null;
  readonly intervalAnchorAt: number | null;
  readonly intervalSeconds: number | null;
  readonly cronExpression: string | null;
  readonly timeZone: string | null;
} {
  switch (schedule.kind) {
    case "date_time":
      return {
        kind: schedule.kind,
        runAt: schedule.runAt,
        intervalAnchorAt: null,
        intervalSeconds: null,
        cronExpression: null,
        timeZone: null,
      };
    case "interval":
      return {
        kind: schedule.kind,
        runAt: null,
        intervalAnchorAt: schedule.anchorAt,
        intervalSeconds: schedule.everySeconds,
        cronExpression: null,
        timeZone: null,
      };
    case "cron":
      return {
        kind: schedule.kind,
        runAt: null,
        intervalAnchorAt: null,
        intervalSeconds: null,
        cronExpression: schedule.expression,
        timeZone: schedule.timeZone,
      };
  }
}

/** Flat definition schedule columns, as selected by every automation reader. */
export type AutomationScheduleColumns = {
  readonly scheduleKind: AutomationSchedule["kind"];
  readonly runAt: number | null;
  readonly intervalAnchorAt: number | null;
  readonly intervalSeconds: number | null;
  readonly cronExpression: string | null;
  readonly timeZone: string | null;
};

/** Inverse of {@link flattenSchedule}; the table CHECKs guarantee the kind's columns. */
export function automationScheduleFromColumns(
  row: AutomationScheduleColumns,
): AutomationSchedule {
  switch (row.scheduleKind) {
    case "date_time":
      return { kind: row.scheduleKind, runAt: row.runAt! };
    case "interval":
      return {
        kind: row.scheduleKind,
        anchorAt: row.intervalAnchorAt!,
        everySeconds: row.intervalSeconds!,
      };
    case "cron":
      return {
        kind: row.scheduleKind,
        expression: row.cronExpression!,
        timeZone: row.timeZone!,
      };
  }
}

function definitionFromRow(row: DefinitionRow): AutomationDefinitionRecord {
  const schedule = automationScheduleFromColumns(row);
  return {
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    id: row.id,
    anchorThreadId: row.anchorThreadId,
    name: row.name,
    prompt: row.prompt,
    precheck:
      row.precheckCommand === null
        ? null
        : {
            command: row.precheckCommand,
            timeoutSeconds: row.precheckTimeoutSeconds!,
            includeStdout: row.precheckIncludeStdout === 1,
          },
    runMode: row.runMode,
    enabled: row.enabled === 1,
    completedAt: row.completedAt,
    deletedAt: row.deletedAt,
    revision: row.revision,
    runsRevision: row.runsRevision,
    schedule,
    misfirePolicy: schedule.kind === "date_time" ? null : row.misfirePolicy,
    nextRunAt: row.nextRunAt,
    lastScheduledAt: row.lastScheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runFromRow(row: RunRow): AutomationRunRecord {
  return {
    ...row,
    suppressionPending: row.suppressionPending === 1,
    precheckIncludeStdout:
      row.precheckIncludeStdout === null
        ? null
        : row.precheckIncludeStdout === 1,
    precheckStdoutIncluded:
      row.precheckStdoutIncluded === null
        ? null
        : row.precheckStdoutIncluded === 1,
  };
}

function nextRunTimestamps(
  current: AutomationRunRecord,
  state: Exclude<AutomationRunState, "claimed">,
  now: number,
): {
  readonly startedAt: number | null;
  readonly acceptedAt: number | null;
  readonly finishedAt: number | null;
} {
  switch (state) {
    case "deferred":
      return { startedAt: null, acceptedAt: null, finishedAt: null };
    case "dispatching":
      return {
        startedAt: current.startedAt ?? now,
        acceptedAt: null,
        finishedAt: null,
      };
    case "queued":
    case "running":
      return {
        startedAt: current.startedAt ?? now,
        acceptedAt: current.acceptedAt ?? now,
        finishedAt: null,
      };
    case "uncertain":
      return {
        startedAt: current.startedAt ?? now,
        acceptedAt: current.acceptedAt,
        finishedAt: null,
      };
    case "completed":
    case "failed":
    case "skipped":
    case "cancelled":
      return {
        startedAt: current.startedAt,
        acceptedAt: current.acceptedAt,
        finishedAt: now,
      };
  }
}

function isAllowedRunTransition(
  from: AutomationRunState,
  to: Exclude<AutomationRunState, "claimed">,
): boolean {
  switch (from) {
    case "claimed":
      return (
        to === "dispatching" ||
        to === "deferred" ||
        to === "cancelled" ||
        to === "failed" ||
        to === "skipped"
      );
    case "dispatching":
      return (
        to === "queued" ||
        to === "running" ||
        to === "cancelled" ||
        to === "completed" ||
        to === "failed" ||
        to === "skipped" ||
        to === "uncertain"
      );
    case "queued":
      return (
        to === "running" ||
        to === "cancelled" ||
        to === "completed" ||
        to === "failed" ||
        to === "uncertain"
      );
    case "running":
      return (
        to === "completed" ||
        to === "failed" ||
        to === "uncertain" ||
        to === "cancelled"
      );
    case "deferred":
      return to === "cancelled" || to === "failed" || to === "skipped";
    case "completed":
    case "failed":
    case "skipped":
    case "cancelled":
      return false;
    case "uncertain":
      return to === "failed";
  }
}

function assertPage(limit: number, offset: number, maximum = 100): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximum ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new DomainError(
      "invalid_transition",
      "The requested automation page is outside the supported bounds.",
    );
  }
}
