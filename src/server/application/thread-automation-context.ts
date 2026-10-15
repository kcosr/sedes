import type Database from "better-sqlite3";
import type { NormalizedThreadAttention } from "../../shared/protocol/conversation.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import { latestDecisiveRunIdSql } from "../db/repositories/automation-read-sql.js";

export const MAXIMUM_THREAD_AUTOMATION_CONTEXTS = 20;

function sourceContextRunIdSql(definition: string): string {
  return `coalesce((SELECT unresolved.id FROM automation_runs AS unresolved
    WHERE unresolved.tenant_id = ${definition}.tenant_id
      AND unresolved.owner_principal_id = ${definition}.owner_principal_id
      AND unresolved.automation_id = ${definition}.id
      AND unresolved.state = 'uncertain'
      AND unresolved.force_reset_at IS NULL
    ORDER BY unresolved.created_at DESC, unresolved.id DESC LIMIT 1
  ), ${latestDecisiveRunIdSql(definition)})`;
}

function runHasProblemSql(run: string): string {
  return `(${run}.force_reset_at IS NULL AND (
    ${run}.state = 'uncertain' OR (${run}.state = 'failed'
      AND coalesce(${run}.error_code, '') != 'automation_uncertain_resolved')
  ))`;
}

export function threadAutomationChildProblemSql(thread: string): string {
  return `EXISTS (
    SELECT 1 FROM automation_runs AS child_problem
    INNER JOIN automation_definitions AS child_definition
      ON child_definition.tenant_id = child_problem.tenant_id
      AND child_definition.owner_principal_id = child_problem.owner_principal_id
      AND child_definition.id = child_problem.automation_id
      AND child_definition.deleted_at IS NULL
    WHERE child_problem.tenant_id = ${thread}.tenant_id
      AND child_problem.owner_principal_id = ${thread}.owner_principal_id
      AND child_problem.child_thread_id = ${thread}.id
      AND child_problem.acknowledged_at IS NULL
      AND ${runHasProblemSql("child_problem")}
  )`;
}

/** Successful manual invocations do not create an automatic-trigger notice. */
export function threadAutomationTriggeredSql(thread: string): string {
  return `(EXISTS (
    SELECT 1 FROM automation_definitions AS source_definition
    INNER JOIN automation_runs AS source_run
      ON source_run.tenant_id = source_definition.tenant_id
      AND source_run.owner_principal_id = source_definition.owner_principal_id
      AND source_run.automation_id = source_definition.id
      AND source_run.id = ${latestDecisiveRunIdSql("source_definition")}
    WHERE source_definition.tenant_id = ${thread}.tenant_id
      AND source_definition.owner_principal_id = ${thread}.owner_principal_id
      AND source_definition.anchor_thread_id = ${thread}.id
      AND source_definition.deleted_at IS NULL
      AND source_run.state = 'completed'
      AND source_run.occurrence_kind = 'scheduled'
      AND source_run.child_thread_id IS NULL
      AND source_run.acknowledged_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM automation_runs AS child_run
    INNER JOIN automation_definitions AS child_definition
      ON child_definition.tenant_id = child_run.tenant_id
      AND child_definition.owner_principal_id = child_run.owner_principal_id
      AND child_definition.id = child_run.automation_id
      AND child_definition.deleted_at IS NULL
    WHERE child_run.tenant_id = ${thread}.tenant_id
      AND child_run.owner_principal_id = ${thread}.owner_principal_id
      AND child_run.child_thread_id = ${thread}.id
      AND child_run.state = 'completed'
      AND child_run.occurrence_kind = 'scheduled'
      AND child_run.acknowledged_at IS NULL
  ))`;
}

export function readThreadAutomationContexts(
  database: Database.Database,
  scope: RequestScope,
  threadId: string,
): NormalizedThreadAttention["automationContexts"] {
  const columns = `definition.id AS automationId, definition.name,
    run.id AS runId, run.anchor_thread_id AS sourceThreadId,
    coalesce(run.finished_at, run.updated_at) AS triggeredAt,
    CASE WHEN run.state = 'completed' THEN 'triggered'
      WHEN run.state = 'uncertain' THEN 'uncertain' ELSE 'failed' END AS outcome,
    run.error_diagnostic AS diagnostic`;
  const rows = database.prepare(`
    SELECT * FROM (
      SELECT ${columns}
      FROM automation_definitions AS definition
      INNER JOIN automation_runs AS run
        ON run.tenant_id = definition.tenant_id
        AND run.owner_principal_id = definition.owner_principal_id
        AND run.automation_id = definition.id
        AND run.id = ${sourceContextRunIdSql("definition")}
      WHERE definition.tenant_id = ? AND definition.owner_principal_id = ?
        AND definition.anchor_thread_id = ? AND definition.deleted_at IS NULL
        AND run.acknowledged_at IS NULL
        AND (run.state IN ('failed', 'uncertain') OR (
          run.state = 'completed' AND run.occurrence_kind = 'scheduled'
          AND run.child_thread_id IS NULL
        ))
      UNION ALL
      SELECT ${columns}
      FROM automation_runs AS run
      INNER JOIN automation_definitions AS definition
        ON definition.tenant_id = run.tenant_id
        AND definition.owner_principal_id = run.owner_principal_id
        AND definition.id = run.automation_id
      WHERE run.tenant_id = ? AND run.owner_principal_id = ?
        AND run.child_thread_id = ? AND definition.deleted_at IS NULL
        AND ((run.state = 'completed' AND run.occurrence_kind = 'scheduled')
          OR ${runHasProblemSql("run")})
        AND run.acknowledged_at IS NULL
    ) ORDER BY CASE outcome WHEN 'uncertain' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
      triggeredAt DESC, automationId, runId
    LIMIT ?
  `).all(
    scope.tenantId, scope.principalId, threadId,
    scope.tenantId, scope.principalId, threadId,
    MAXIMUM_THREAD_AUTOMATION_CONTEXTS,
  ) as {
    automationId: string;
    name: string;
    runId: string;
    sourceThreadId: string;
    triggeredAt: number;
    outcome: "triggered" | "failed" | "uncertain";
    diagnostic: string | null;
  }[];
  return rows.map((row) => ({
    automationId: row.automationId,
    name: row.name,
    runId: row.runId,
    sourceThreadId: row.sourceThreadId,
    triggeredAt: new Date(row.triggeredAt).toISOString(),
    outcome: row.outcome,
    ...(row.diagnostic === null ? {} : { diagnostic: boundDisplayText(row.diagnostic) }),
  }));
}
