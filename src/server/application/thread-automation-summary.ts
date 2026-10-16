import type Database from "better-sqlite3";
import type { NormalizedThreadSummary } from "../../shared/protocol/conversation.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  exhaustedSql,
  inFlightSql,
  needsAttentionSql,
  nextActionAtSql,
} from "../db/repositories/automation-read-sql.js";

export type ThreadAutomationSummaryRow = {
  readonly automationTotalCount: number;
  readonly automationEnabledCount: number;
  readonly automationPausedCount: number;
  readonly automationExhaustedCount: number;
  readonly automationInFlightCount: number;
  readonly automationAttentionCount: number;
  readonly automationNextRunAt: number | null;
  readonly automationRevision: number;
};

/**
 * Aggregate before joining inventory: an arbitrary number of definitions must
 * still produce one thread row. Include tombstones in the revision so removal
 * changes freshness without bringing deleted definitions back into the counts.
 */
export function threadAutomationAggregateColumns(definition: string): string {
  const live = `${definition}.deleted_at IS NULL`;
  const exhausted = exhaustedSql(definition);
  return `
    count(CASE WHEN ${live} THEN 1 END) AS automationTotalCount,
    coalesce(sum(CASE WHEN ${live} AND NOT ${exhausted} AND ${definition}.enabled = 1 THEN 1 ELSE 0 END), 0) AS automationEnabledCount,
    coalesce(sum(CASE WHEN ${live} AND NOT ${exhausted} AND ${definition}.enabled = 0 THEN 1 ELSE 0 END), 0) AS automationPausedCount,
    coalesce(sum(CASE WHEN ${live} AND ${exhausted} THEN 1 ELSE 0 END), 0) AS automationExhaustedCount,
    coalesce(sum(CASE WHEN ${live} AND ${inFlightSql(definition)} THEN 1 ELSE 0 END), 0) AS automationInFlightCount,
    coalesce(sum(CASE WHEN ${live} AND ${needsAttentionSql(definition)} THEN 1 ELSE 0 END), 0) AS automationAttentionCount,
    min(${nextActionAtSql(definition)}) AS automationNextRunAt,
    coalesce(sum(1 + ${definition}.revision + ${definition}.runs_revision), 0) AS automationRevision`;
}

export function threadAutomationSummaryColumns(
  aggregate: string,
  principal: string,
  workspace: string,
): string {
  return `
    coalesce(${aggregate}.automationTotalCount, 0) AS automationTotalCount,
    coalesce(${aggregate}.automationEnabledCount, 0) AS automationEnabledCount,
    coalesce(${aggregate}.automationPausedCount, 0) AS automationPausedCount,
    coalesce(${aggregate}.automationExhaustedCount, 0) AS automationExhaustedCount,
    coalesce(${aggregate}.automationInFlightCount, 0) AS automationInFlightCount,
    coalesce(${aggregate}.automationAttentionCount, 0) AS automationAttentionCount,
    CASE
      WHEN ${principal}.inventory_state = 'archived'
        OR ${workspace}.removed_at IS NOT NULL THEN NULL
      WHEN ${principal}.inventory_state = 'snoozed' THEN
        CASE WHEN ${principal}.snoozed_until IS NULL THEN NULL
          ELSE max(${aggregate}.automationNextRunAt, ${principal}.snoozed_until) END
      ELSE ${aggregate}.automationNextRunAt
    END AS automationNextRunAt,
    coalesce(${aggregate}.automationRevision, 0) AS automationRevision`;
}

export function projectThreadAutomationSummary(
  row: ThreadAutomationSummaryRow,
): NormalizedThreadSummary["automations"] {
  return {
    totalCount: row.automationTotalCount,
    enabledCount: row.automationEnabledCount,
    pausedCount: row.automationPausedCount,
    exhaustedCount: row.automationExhaustedCount,
    inFlightCount: row.automationInFlightCount,
    attentionCount: row.automationAttentionCount,
    ...(row.automationNextRunAt === null
      ? {}
      : { nextRunAt: new Date(row.automationNextRunAt).toISOString() }),
    revision: row.automationRevision,
  };
}

export function readThreadAutomationSummary(
  database: Database.Database,
  scope: RequestScope,
  threadId: string,
): NormalizedThreadSummary["automations"] {
  const row = database.prepare(`
    WITH automations AS (
      SELECT ${threadAutomationAggregateColumns("definition")}
      FROM automation_definitions AS definition
      WHERE definition.tenant_id = ? AND definition.owner_principal_id = ?
        AND definition.anchor_thread_id = ?
    )
    SELECT ${threadAutomationSummaryColumns("automations", "principal", "workspace")}
    FROM automations
    INNER JOIN thread_principal_state AS principal
      ON principal.tenant_id = ? AND principal.principal_id = ?
      AND principal.thread_id = ?
    INNER JOIN application_threads AS thread
      ON thread.tenant_id = principal.tenant_id
      AND thread.owner_principal_id = principal.principal_id
      AND thread.id = principal.thread_id
    INNER JOIN workspaces AS workspace
      ON workspace.tenant_id = thread.tenant_id
      AND workspace.owner_principal_id = thread.owner_principal_id
      AND workspace.id = thread.workspace_id
  `).get(scope.tenantId, scope.principalId, threadId,
    scope.tenantId, scope.principalId, threadId) as ThreadAutomationSummaryRow;
  return projectThreadAutomationSummary(row);
}
