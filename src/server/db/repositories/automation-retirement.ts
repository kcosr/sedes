import { needsAttentionSql, runFailureSql } from "./automation-read-sql.js";

/**
 * A dismissed, successful scheduled occurrence may retire only its current
 * one-shot definition. Retain every record; queued input and thread lineage
 * still refer to the definition and run after it leaves normal views.
 */
export function retirableOneShotSql(definition: string): string {
  return `(${definition}.deleted_at IS NULL
    AND ${definition}.schedule_kind = 'date_time'
    AND NOT ${needsAttentionSql(definition)}
    AND EXISTS (
      SELECT 1 FROM automation_runs AS finished
      WHERE finished.tenant_id = ${definition}.tenant_id
        AND finished.owner_principal_id = ${definition}.owner_principal_id
        AND finished.automation_id = ${definition}.id
        AND finished.occurrence_kind = 'scheduled'
        AND finished.occurrence_key = 'scheduled:' || ${definition}.run_at
        AND finished.state = 'completed' AND finished.turn_outcome = 'completed'
        AND finished.force_reset_at IS NULL AND finished.acknowledged_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM automation_runs AS outstanding
      WHERE outstanding.tenant_id = ${definition}.tenant_id
        AND outstanding.owner_principal_id = ${definition}.owner_principal_id
        AND outstanding.automation_id = ${definition}.id
        AND outstanding.force_reset_at IS NULL
        AND (
          outstanding.state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred')
          OR (outstanding.state = 'completed' AND outstanding.turn_outcome IS NULL)
          OR (outstanding.child_thread_id IS NOT NULL AND outstanding.acknowledged_at IS NULL AND (
            ${runFailureSql("outstanding")}
            OR (outstanding.state = 'completed' AND outstanding.occurrence_kind = 'scheduled')
          ))
        )
    ))`;
}
