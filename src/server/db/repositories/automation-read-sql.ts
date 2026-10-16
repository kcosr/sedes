/** Shared durable automation predicates used by collections and thread projections. */
export function consumedOnceSql(definition: string): string {
  return `(${definition}.schedule_kind = 'date_time' AND EXISTS (
    SELECT 1 FROM automation_runs AS consumed
    WHERE consumed.tenant_id = ${definition}.tenant_id
      AND consumed.owner_principal_id = ${definition}.owner_principal_id
      AND consumed.automation_id = ${definition}.id
      AND consumed.occurrence_kind = 'scheduled'
      AND consumed.occurrence_key = 'scheduled:' || ${definition}.run_at
  ))`;
}

/** A consumed one-shot stays actionable while its scheduled delivery is pending. */
export function exhaustedSql(definition: string): string {
  return `(${consumedOnceSql(definition)} AND NOT EXISTS (
    SELECT 1 FROM automation_runs AS pending
    WHERE pending.tenant_id = ${definition}.tenant_id
      AND pending.owner_principal_id = ${definition}.owner_principal_id
      AND pending.automation_id = ${definition}.id
      AND pending.occurrence_kind = 'scheduled'
      AND pending.occurrence_key = 'scheduled:' || ${definition}.run_at
      AND pending.state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred')
  ))`;
}

/** Skips, cancellations, resolved uncertainty and force resets do not settle attention. */
export function latestDecisiveRunIdSql(definition: string): string {
  return `(SELECT decisive.id FROM automation_runs AS decisive
    WHERE decisive.tenant_id = ${definition}.tenant_id
      AND decisive.owner_principal_id = ${definition}.owner_principal_id
      AND decisive.automation_id = ${definition}.id
      AND decisive.force_reset_at IS NULL
      AND (decisive.state = 'completed' OR (
        decisive.state = 'failed'
        AND coalesce(decisive.error_code, '') != 'automation_uncertain_resolved'
      ))
    ORDER BY decisive.created_at DESC, decisive.id DESC LIMIT 1)`;
}

/** Delivery failure or an unsuccessful agent turn, excluding abandoned work. */
export function runFailureSql(run: string): string {
  return `(${run}.force_reset_at IS NULL AND (
    (${run}.state = 'failed'
      AND coalesce(${run}.error_code, '') != 'automation_uncertain_resolved')
    OR (${run}.state = 'completed' AND ${run}.turn_outcome IN ('failed', 'interrupted'))
  ))`;
}

export function needsAttentionSql(definition: string): string {
  return `(EXISTS (
    SELECT 1 FROM automation_runs AS unresolved
    WHERE unresolved.tenant_id = ${definition}.tenant_id
      AND unresolved.owner_principal_id = ${definition}.owner_principal_id
      AND unresolved.automation_id = ${definition}.id
      AND unresolved.state = 'uncertain'
      AND unresolved.force_reset_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM automation_runs AS failure
    WHERE failure.tenant_id = ${definition}.tenant_id
      AND failure.owner_principal_id = ${definition}.owner_principal_id
      AND failure.automation_id = ${definition}.id
      AND failure.id = ${latestDecisiveRunIdSql(definition)}
      AND ${runFailureSql("failure")}
      AND failure.acknowledged_at IS NULL
  ))`;
}

/** Delivery admission only; accepted agent work has already released this slot. */
export function pendingDeliverySql(definition: string): string {
  return `EXISTS (
    SELECT 1 FROM automation_runs AS active
    WHERE active.tenant_id = ${definition}.tenant_id
      AND active.owner_principal_id = ${definition}.owner_principal_id
      AND active.automation_id = ${definition}.id
      AND active.state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred')
  )`;
}

/** UI activity includes the latest accepted turn without reviving incomplete historical records. */
export function inFlightSql(definition: string): string {
  return `(${pendingDeliverySql(definition)} OR EXISTS (
    SELECT 1 FROM automation_runs AS accepted
    WHERE accepted.tenant_id = ${definition}.tenant_id
      AND accepted.owner_principal_id = ${definition}.owner_principal_id
      AND accepted.automation_id = ${definition}.id
      AND accepted.force_reset_at IS NULL
      AND accepted.state = 'completed' AND accepted.turn_outcome IS NULL
      AND accepted.id = (
        SELECT latest.id FROM automation_runs AS latest
        WHERE latest.tenant_id = ${definition}.tenant_id
          AND latest.owner_principal_id = ${definition}.owner_principal_id
          AND latest.automation_id = ${definition}.id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
      )
  ))`;
}

/** Earliest potentially actionable delivery, before source inventory suppression. */
export function nextActionAtSql(definition: string): string {
  return `(CASE WHEN ${definition}.deleted_at IS NULL THEN
    CASE WHEN ${pendingDeliverySql(definition)} THEN (
      SELECT waiting.eligible_at FROM automation_runs AS waiting
      WHERE waiting.tenant_id = ${definition}.tenant_id
        AND waiting.owner_principal_id = ${definition}.owner_principal_id
        AND waiting.automation_id = ${definition}.id
        AND waiting.state = 'deferred'
    ) WHEN ${definition}.enabled = 1 AND NOT ${exhaustedSql(definition)}
      THEN ${definition}.next_run_at END
  END)`;
}
