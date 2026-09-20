import type { DatabaseMigration } from "../migrate.js";

/**
 * Composer Steer is admitted into the application queue before any provider
 * effect. The normalized active turn ID is durable application authority: a
 * pending Steer must never drift into a later turn or silently become Submit.
 *
 * Version 55's requested_delivery_mode constraint predates durable Steer and
 * admits only submit/queue. A Steer row therefore uses the queue storage value
 * plus this exact target; repositories project the end-state steer intent.
 */
export const durableSteerIntentsMigration: DatabaseMigration = {
  version: 58,
  name: "durable_steer_intents",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE queued_inputs
  ADD COLUMN requested_steer_turn_id TEXT
  CHECK (
    requested_steer_turn_id IS NULL
    OR length(requested_steer_turn_id) BETWEEN 1 AND 160
  )
  CHECK (
    requested_steer_turn_id IS NULL
    OR (
      requested_delivery_mode = 'queue'
      AND requested_thread_revision IS NOT NULL
      AND requested_draft_revision IS NOT NULL
      AND trigger_kind = 'user'
      AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND retry_of_id IS NULL
    )
  );
`,
};
