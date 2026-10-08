import type { DatabaseMigration } from "../migrate.js";

/**
 * Turn reply speech reads one ended turn's stored completion classification
 * by application turn id. Steers give a turn several observations, so the
 * index also orders them for the latest-accepted lookup.
 */
export const submissionCompletionTurnIndexMigration: DatabaseMigration = {
  version: 137,
  name: "submission_completion_turn_index",
  sql: `
CREATE INDEX submission_completion_turn
  ON submission_completion_observations(
    tenant_id, owner_principal_id, application_thread_id,
    application_turn_id, accepted_at, operation_id
  )
  WHERE application_turn_id IS NOT NULL;
`,
};
