import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AutomationDefinitionRecord,
  AutomationMisfirePolicy,
  AutomationPrecheck,
  AutomationPrecheckStatus,
  AutomationRunMode,
  AutomationRunRecord,
  AutomationRunState,
  AutomationSchedule,
} from "../../domain/automation-models.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

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
  created_at AS createdAt,
  updated_at AS updatedAt
`;

type DefinitionRow = Omit<
  AutomationDefinitionRecord,
  "enabled" | "schedule" | "precheck"
> & {
  enabled: 0 | 1;
  precheckCommand: string | null;
  precheckTimeoutSeconds: number | null;
  precheckIncludeStdout: 0 | 1 | null;
  scheduleKind: AutomationSchedule["kind"];
  runAt: number | null;
  intervalAnchorAt: number | null;
  intervalSeconds: number | null;
  cronExpression: string | null;
  timeZone: string | null;
};

type RunRow = Omit<
  AutomationRunRecord,
  "precheckIncludeStdout" | "precheckStdoutIncluded"
> & {
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
  readonly misfirePolicy: AutomationMisfirePolicy;
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
        input.misfirePolicy,
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

  findDefinitionForThread(
    scope: RequestScope,
    threadId: string,
  ): AutomationDefinitionRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${definitionColumns}
          FROM automation_definitions
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND anchor_thread_id = ? AND deleted_at IS NULL
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      DefinitionRow | undefined;
    return row ? definitionFromRow(row) : undefined;
  }

  listDefinitions(
    scope: RequestScope,
    input: {
      readonly includeDeleted?: boolean;
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
      this.assertNoNonterminalRun(scope, automationId);
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
          input.misfirePolicy,
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
              AND NOT EXISTS (
                SELECT 1
                FROM automation_runs AS run
                WHERE run.tenant_id = automation_definitions.tenant_id
                  AND run.owner_principal_id =
                    automation_definitions.owner_principal_id
                  AND run.automation_id = automation_definitions.id
                  AND run.state IN (
                    'claimed', 'dispatching', 'queued', 'running', 'uncertain'
                  )
              )
            ORDER BY next_run_at, tenant_id, owner_principal_id, id
            LIMIT ?
          `,
        )
        .all(now, limit) as DefinitionRow[]
    ).map(definitionFromRow);
  }

  suppressScheduledOccurrenceForSnooze(
    scope: RequestScope,
    automationId: string,
    input: {
      readonly expectedRevision: number;
      readonly scheduledFor: number;
      readonly lastScheduledAt: number;
      readonly nextRunAt: number | null;
      readonly now: number;
    },
  ): { definition: AutomationDefinitionRecord; detached: boolean } {
    return this.database.transaction(() => {
      const definition = this.getDefinition(scope, automationId);
      const state = this.database
        .prepare(
          `
            SELECT inventory_state AS inventoryState,
              snoozed_until AS snoozedUntil
            FROM thread_principal_state
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, definition.anchorThreadId) as
        { inventoryState: string; snoozedUntil: number | null } | undefined;
      if (
        !state ||
        state.inventoryState !== "snoozed" ||
        state.snoozedUntil === null ||
        input.scheduledFor > state.snoozedUntil ||
        definition.revision !== input.expectedRevision ||
        definition.nextRunAt !== input.scheduledFor
      ) {
        throw new DomainError(
          "conflict",
          "The scheduled occurrence is no longer suppressed by snooze.",
          true,
        );
      }
      const detached = definition.schedule.kind === "date_time";
      const result = this.database
        .prepare(
          `
            UPDATE automation_definitions
            SET enabled = ?,
              deleted_at = ?,
              next_run_at = ?,
              last_scheduled_at = ?,
              revision = revision + 1,
              updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ? AND next_run_at = ? AND deleted_at IS NULL
          `,
        )
        .run(
          detached ? 0 : 1,
          detached ? input.now : null,
          detached ? null : input.nextRunAt,
          input.lastScheduledAt,
          input.now,
          scope.tenantId,
          scope.principalId,
          automationId,
          input.expectedRevision,
          input.scheduledFor,
        );
      if (result.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The automation schedule changed while applying snooze.",
          true,
        );
      }
      return {
        definition: this.getDefinition(scope, automationId),
        detached,
      };
    })();
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
              AND NOT EXISTS (
                SELECT 1
                FROM automation_runs AS run
                WHERE run.tenant_id = automation_definitions.tenant_id
                  AND run.owner_principal_id =
                    automation_definitions.owner_principal_id
                  AND run.automation_id = automation_definitions.id
                  AND run.state IN (
                    'claimed', 'dispatching', 'queued', 'running', 'uncertain'
                  )
              )
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
            'claimed', 'dispatching', 'queued', 'running', 'uncertain'
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
            prompt_snapshot = ?, updated_at = ?
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
          inventory.snoozedUntil >= input.now
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
      if (input.completeDefinition) {
        if (!["completed", "failed", "skipped"].includes(input.state)) {
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
              SET enabled = 0, completed_at = NULL, next_run_at = NULL,
                deleted_at = ?, revision = revision + 1, updated_at = ?
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
            "The one-shot automation could not be detached.",
          );
        }
      }
      if (
        current.occurrenceKind === "scheduled" &&
        (input.state === "completed" || input.state === "failed")
      ) {
        const context = this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET
                automation_context_run_id = ?,
                automation_context_source_thread_id = ?,
                automation_context_at = ?,
                automation_context_outcome = ?,
                automation_context_diagnostic = ?,
                inventory_revision = inventory_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND inventory_state <> 'archived'
            `,
          )
          .run(
            runId,
            current.anchorThreadId,
            input.now,
            input.state === "completed" ? "triggered" : "failed",
            input.state === "failed"
              ? (input.errorDiagnostic ?? "The scheduled automation failed.")
              : null,
            scope.tenantId,
            scope.principalId,
            current.childThreadId ?? current.anchorThreadId,
          );
        if (context.changes === 1) {
          this.database
            .prepare(
              `
                UPDATE principal_generations
                SET inventory_generation = inventory_generation + 1
                WHERE tenant_id = ? AND principal_id = ?
              `,
            )
            .run(scope.tenantId, scope.principalId);
        }
      }
      return this.getRun(scope, automationId, runId);
    })();
  }

  bindForkChild(
    scope: RequestScope,
    automationId: string,
    runId: string,
    input: {
      readonly childThreadId: string;
      readonly now: number;
    },
  ): AutomationRunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(scope, automationId, runId);
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
      if (
        !lineage ||
        lineage.childBackendInstanceId !== lineage.anchorBackendInstanceId
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
    return (
      this.database
        .prepare(
          `
          SELECT ${runColumns}
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ?
            ${input.after ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          automationId,
          ...(input.after
            ? [input.after.createdAt, input.after.createdAt, input.after.id]
            : []),
          input.limit,
        ) as RunRow[]
    ).map(runFromRow);
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
            created_at, updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?
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
  ): void {
    const existing = this.database
      .prepare(
        `
          SELECT 1
          FROM automation_runs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND automation_id = ?
            AND state IN (
              'claimed', 'dispatching', 'queued', 'running', 'uncertain'
            )
        `,
      )
      .get(scope.tenantId, scope.principalId, automationId);
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

function definitionFromRow(row: DefinitionRow): AutomationDefinitionRecord {
  let schedule: AutomationSchedule;
  switch (row.scheduleKind) {
    case "date_time":
      schedule = { kind: row.scheduleKind, runAt: row.runAt! };
      break;
    case "interval":
      schedule = {
        kind: row.scheduleKind,
        anchorAt: row.intervalAnchorAt!,
        everySeconds: row.intervalSeconds!,
      };
      break;
    case "cron":
      schedule = {
        kind: row.scheduleKind,
        expression: row.cronExpression!,
        timeZone: row.timeZone!,
      };
      break;
  }
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
    schedule,
    misfirePolicy: row.misfirePolicy,
    nextRunAt: row.nextRunAt,
    lastScheduledAt: row.lastScheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runFromRow(row: RunRow): AutomationRunRecord {
  return {
    ...row,
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
      return to === "dispatching" || to === "failed" || to === "skipped";
    case "dispatching":
      return (
        to === "queued" ||
        to === "running" ||
        to === "completed" ||
        to === "failed" ||
        to === "skipped" ||
        to === "uncertain"
      );
    case "queued":
      return (
        to === "running" ||
        to === "completed" ||
        to === "failed" ||
        to === "uncertain"
      );
    case "running":
      return to === "completed" || to === "failed" || to === "uncertain";
    case "completed":
    case "failed":
    case "skipped":
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
