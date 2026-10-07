import type { DatabaseMigration } from "../migrate.js";

/**
 * Indexes the per-thread automation checks and the run-history filters, and
 * removes indexes no query uses any more:
 * - archive, snooze and lifecycle-blocker checks look runs up by anchor thread;
 * - run-history filters and counts read one automation's runs by state;
 * - the latest-run rule follows `automation_runs_history`, so the
 *   `scheduled_for` ordering index is unused;
 * - migration 10's table swap left `automation_definitions_v10_one_per_thread`
 *   on the live table beside the identical `automation_definitions_one_per_thread`.
 */
export const automationRunIndexesMigration: DatabaseMigration = {
  version: 135,
  name: "automation_run_indexes",
  sql: `
CREATE INDEX automation_runs_anchor_state
  ON automation_runs(tenant_id, owner_principal_id, anchor_thread_id, state);
CREATE INDEX automation_runs_state_history
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id, state,
    created_at DESC, id DESC
  );
DROP INDEX automation_runs_application_summary_latest;
DROP INDEX automation_definitions_v10_one_per_thread;
`,
};
