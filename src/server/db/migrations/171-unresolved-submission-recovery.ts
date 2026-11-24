import type { DatabaseMigration } from "../migrate.js";

/**
 * Startup recovery looks for accepted submissions whose terminal outcome was
 * never observed. Index only those rows so the scan stays proportional to
 * unresolved work rather than to every submission ever accepted.
 */
export const unresolvedSubmissionRecoveryMigration: DatabaseMigration = {
  version: 171,
  name: "unresolved_submission_recovery",
  sql: `
CREATE INDEX submission_completion_observations_unresolved
  ON submission_completion_observations(
    tenant_id, owner_principal_id, accepted_at
  )
  WHERE completion_observed_at IS NULL AND backend_correlation IS NOT NULL;
`,
};
