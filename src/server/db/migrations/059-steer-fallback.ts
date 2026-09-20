import type { DatabaseMigration } from "../migrate.js";

/**
 * A target-bound Steer may be proven unsent only after durable admission. Keep
 * its immutable target for mutation replay while recording that subsequent
 * delivery is ordinary next-turn queue work.
 */
export const steerFallbackMigration: DatabaseMigration = {
  version: 59,
  name: "steer_fallback",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE queued_inputs
  ADD COLUMN steer_fallback_at INTEGER
  CHECK (
    steer_fallback_at IS NULL
    OR (
      steer_fallback_at >= 0
      AND requested_steer_turn_id IS NOT NULL
      AND requested_delivery_mode = 'queue'
    )
  );
`,
};
