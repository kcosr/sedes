import type { DatabaseMigration } from "../migrate.js";

/**
 * A failed queued input may record a normalized reason. `not_sent` marks a
 * Steer the provider accepted but proved it never used (for example, one
 * withdrawn by Stop), so clients can present it neutrally instead of as a
 * delivery failure. Older failures recorded no reason.
 */
export const queuedInputFailureReasonMigration: DatabaseMigration = {
  version: 118,
  name: "queued_input_failure_reason",
  sql: `
ALTER TABLE queued_inputs ADD COLUMN failure_reason TEXT CHECK (
  failure_reason IS NULL OR failure_reason = 'not_sent'
);
`,
};
