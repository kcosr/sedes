import type { NormalizedThreadSummary } from "../../shared/protocol/conversation.js";
import type {
  AutomationRunState,
  AutomationTurnOutcome,
} from "../domain/automation-models.js";
import { automationScheduleFromColumns } from "../db/repositories/automation-repository.js";
import {
  AUTOMATION_PROMPT_PREVIEW_SOURCE_BYTES,
  automationPromptPreview,
  decodeAutomationPromptHead,
  presentAutomationLastRunTurn,
  presentAutomationSchedule,
} from "../domain/automation-presentation.js";

/**
 * Columns selected by {@link threadAutomationSummaryColumns}. Every column is
 * nullable because the application reader left-joins threads that have no
 * live automation definition.
 */
export type ThreadAutomationSummaryRow = {
  readonly automationStatus: "enabled" | "paused" | null;
  readonly automationRunMode: "same_thread" | "clone" | null;
  readonly automationScheduleKind: "date_time" | "interval" | "cron" | null;
  readonly automationRunAt: number | null;
  readonly automationIntervalAnchorAt: number | null;
  readonly automationIntervalSeconds: number | null;
  readonly automationCronExpression: string | null;
  readonly automationTimeZone: string | null;
  readonly automationMisfirePolicy: "coalesce" | "skip" | null;
  readonly automationPromptHead: Uint8Array | null;
  readonly automationPromptTruncated: 0 | 1 | null;
  readonly automationNextRunAt: number | null;
  readonly automationRevision: number | null;
  readonly automationRunsRevision: number | null;
  readonly automationHasPrecheck: 0 | 1 | null;
  readonly automationRunId: string | null;
  readonly automationRunState: AutomationRunState | null;
  readonly automationOccurrence: "scheduled" | "manual" | null;
  readonly automationScheduledFor: number | null;
  readonly automationFinishedAt: number | null;
  readonly automationResultThreadId: string | null;
  readonly automationErrorCode: string | null;
  readonly automationTurnOutcome: AutomationTurnOutcome | null;
  readonly automationTurnEndedAt: number | null;
};

/** Select list for a live definition and the run joined by {@link latestAutomationRunJoin}. */
export function threadAutomationSummaryColumns(
  definition: string,
  run: string,
): string {
  return `
    CASE
      WHEN ${definition}.id IS NULL THEN NULL
      WHEN ${definition}.enabled = 1 THEN 'enabled'
      ELSE 'paused'
    END AS automationStatus,
    ${definition}.run_mode AS automationRunMode,
    ${definition}.schedule_kind AS automationScheduleKind,
    ${definition}.run_at AS automationRunAt,
    ${definition}.interval_anchor_at AS automationIntervalAnchorAt,
    ${definition}.interval_seconds AS automationIntervalSeconds,
    ${definition}.cron_expression AS automationCronExpression,
    ${definition}.time_zone AS automationTimeZone,
    ${definition}.misfire_policy AS automationMisfirePolicy,
    substr(CAST(${definition}.prompt AS BLOB), 1, ${AUTOMATION_PROMPT_PREVIEW_SOURCE_BYTES})
      AS automationPromptHead,
    CASE
      WHEN ${definition}.id IS NULL THEN NULL
      WHEN length(CAST(${definition}.prompt AS BLOB)) > ${AUTOMATION_PROMPT_PREVIEW_SOURCE_BYTES}
      THEN 1 ELSE 0
    END AS automationPromptTruncated,
    ${definition}.next_run_at AS automationNextRunAt,
    ${definition}.revision AS automationRevision,
    ${definition}.runs_revision AS automationRunsRevision,
    CASE
      WHEN ${definition}.id IS NULL THEN NULL
      WHEN ${definition}.precheck_command IS NULL THEN 0
      ELSE 1
    END AS automationHasPrecheck,
    ${run}.id AS automationRunId,
    ${run}.state AS automationRunState,
    ${run}.occurrence_kind AS automationOccurrence,
    ${run}.scheduled_for AS automationScheduledFor,
    ${run}.finished_at AS automationFinishedAt,
    coalesce(${run}.child_thread_id, ${run}.anchor_thread_id)
      AS automationResultThreadId,
    ${run}.error_code AS automationErrorCode,
    ${run}.turn_outcome AS automationTurnOutcome,
    ${run}.turn_ended_at AS automationTurnEndedAt`;
}

/**
 * Joins a definition's latest run with a correlated `LIMIT 1` on the run
 * history order (`created_at DESC, id DESC`), which `GET …/automation/runs`,
 * the REST summary and the `automation_runs_history` index all share.
 */
export function latestAutomationRunJoin(definition: string, run: string): string {
  return `
    LEFT JOIN automation_runs AS ${run}
      ON ${run}.tenant_id = ${definition}.tenant_id
      AND ${run}.owner_principal_id = ${definition}.owner_principal_id
      AND ${run}.automation_id = ${definition}.id
      AND ${run}.id = (
        SELECT candidate.id
        FROM automation_runs AS candidate
        WHERE candidate.tenant_id = ${definition}.tenant_id
          AND candidate.owner_principal_id = ${definition}.owner_principal_id
          AND candidate.automation_id = ${definition}.id
        ORDER BY candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      )`;
}

export function projectThreadAutomationSummary(
  row: ThreadAutomationSummaryRow,
): NormalizedThreadSummary["automation"] {
  if (
    row.automationStatus === null ||
    row.automationRunMode === null ||
    row.automationScheduleKind === null ||
    row.automationMisfirePolicy === null ||
    row.automationPromptHead === null ||
    row.automationRevision === null ||
    row.automationRunsRevision === null ||
    row.automationHasPrecheck === null
  ) {
    return null;
  }
  const lastRunTurn = presentAutomationLastRunTurn({
    turnOutcome: row.automationTurnOutcome,
    turnEndedAt: row.automationTurnEndedAt,
  });
  return {
    status: row.automationStatus,
    runMode: row.automationRunMode,
    scheduleKind: row.automationScheduleKind,
    schedule: presentAutomationSchedule(
      automationScheduleFromColumns({
        scheduleKind: row.automationScheduleKind,
        runAt: row.automationRunAt,
        intervalAnchorAt: row.automationIntervalAnchorAt,
        intervalSeconds: row.automationIntervalSeconds,
        cronExpression: row.automationCronExpression,
        timeZone: row.automationTimeZone,
      }),
    ),
    misfirePolicy: row.automationMisfirePolicy,
    promptPreview: automationPromptPreview(
      decodeAutomationPromptHead(
        row.automationPromptHead,
        row.automationPromptTruncated === 1,
      ),
      row.automationPromptTruncated === 1,
    ),
    ...(row.automationNextRunAt === null
      ? {}
      : { nextRunAt: iso(row.automationNextRunAt) }),
    revision: row.automationRevision,
    runsRevision: row.automationRunsRevision,
    hasPrecheck: row.automationHasPrecheck === 1,
    ...(row.automationRunId === null ||
    row.automationRunState === null ||
    row.automationOccurrence === null ||
    row.automationScheduledFor === null
      ? {}
      : {
          lastRun: {
            id: row.automationRunId,
            state: row.automationRunState,
            occurrence: row.automationOccurrence,
            scheduledFor: iso(row.automationScheduledFor),
            ...(row.automationFinishedAt === null
              ? {}
              : { finishedAt: iso(row.automationFinishedAt) }),
            ...(row.automationResultThreadId === null
              ? {}
              : { resultThreadId: row.automationResultThreadId }),
            ...(row.automationErrorCode === null
              ? {}
              : { errorCode: row.automationErrorCode }),
            ...(lastRunTurn ? { turn: lastRunTurn } : {}),
          },
        }),
  };
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
