import type { DatabaseMigration } from "../migrate.js";

/** Sidebar reads scale with actionable state, not retained delivery history. */
export const applicationSummaryActiveIndexesMigration: DatabaseMigration = {
  version: 98,
  name: "application_summary_active_indexes",
  sql: `
CREATE INDEX queued_inputs_application_summary
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id,
    state, failure_acknowledged_at
  )
  WHERE state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
    OR (state = 'failed' AND failure_acknowledged_at IS NULL);
CREATE INDEX submission_completion_application_summary
  ON submission_completion_observations(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE attention_created_at IS NOT NULL AND acknowledged_at IS NULL;
`,
};
