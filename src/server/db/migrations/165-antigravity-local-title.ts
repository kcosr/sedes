import type { DatabaseMigration } from "../migrate.js";

export const antigravityLocalTitleMigration: DatabaseMigration = {
  version: 165,
  name: "antigravity_local_title",
  sql: `
ALTER TABLE antigravity_thread_settings
  ADD COLUMN local_title_override INTEGER NOT NULL DEFAULT 0 CHECK (local_title_override IN (0, 1));
`,
};
