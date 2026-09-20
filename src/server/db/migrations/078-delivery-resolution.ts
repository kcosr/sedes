import type { DatabaseMigration } from "../migrate.js";

/**
 * Preserve the browser's requested delivery intent separately from the
 * authoritative disposition chosen at server admission. The resolved Steer
 * target is server-observed authority and may therefore differ from the
 * client's requested target (notably when Send arrives during an active turn).
 */
export const deliveryResolutionMigration: DatabaseMigration = {
  version: 78,
  name: "delivery_resolution",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE queued_inputs
  ADD COLUMN resolved_delivery_mode TEXT NOT NULL DEFAULT 'queue'
  CHECK (
    resolved_delivery_mode IS NULL
    OR resolved_delivery_mode IN ('submit', 'steer', 'queue')
  );

ALTER TABLE queued_inputs
  ADD COLUMN resolved_steer_turn_id TEXT
  CHECK (
    (resolved_steer_turn_id IS NULL
      OR length(resolved_steer_turn_id) BETWEEN 1 AND 160)
    AND ((resolved_delivery_mode = 'steer') =
      (resolved_steer_turn_id IS NOT NULL))
  );

UPDATE queued_inputs
SET resolved_delivery_mode = CASE
  WHEN requested_steer_turn_id IS NOT NULL AND steer_fallback_at IS NULL
    THEN 'steer'
  WHEN requested_steer_turn_id IS NOT NULL
    THEN 'queue'
  WHEN requested_delivery_mode = 'submit'
    THEN 'submit'
  ELSE 'queue'
END,
resolved_steer_turn_id = CASE
  WHEN requested_steer_turn_id IS NOT NULL AND steer_fallback_at IS NULL
    THEN requested_steer_turn_id
  ELSE NULL
END;
`,
};
