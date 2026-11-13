import type { DatabaseMigration } from "../migrate.js";

export const claudeDesiredSettingsRevisionMigration: DatabaseMigration = {
  version: 162,
  name: "claude_desired_settings_revision",
  sql: `
ALTER TABLE claude_thread_settings ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 0
  CHECK (desired_revision BETWEEN 0 AND 9007199254740991);
UPDATE claude_thread_settings SET desired_revision = revision;
`,
};
