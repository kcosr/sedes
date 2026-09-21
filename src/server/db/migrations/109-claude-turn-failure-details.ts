import type { DatabaseMigration } from "../migrate.js";

export const claudeTurnFailureDetailsMigration: DatabaseMigration = {
  version: 109,
  name: "claude_turn_failure_details",
  sql: `ALTER TABLE claude_turn_terminal_receipts ADD COLUMN failure_message TEXT
    CHECK (failure_message IS NULL OR (status = 'failed' AND length(CAST(failure_message AS BLOB)) BETWEEN 1 AND 1024));`,
};
