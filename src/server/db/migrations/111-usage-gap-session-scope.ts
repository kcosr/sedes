import type { DatabaseMigration } from "../migrate.js";

export const usageGapSessionScopeMigration: DatabaseMigration = {
  version: 111,
  name: "usage_gap_session_scope",
  sql: `
ALTER TABLE usage_gaps ADD COLUMN affects_session INTEGER NOT NULL DEFAULT 1
  CHECK (affects_session IN (0, 1));
`,
};
