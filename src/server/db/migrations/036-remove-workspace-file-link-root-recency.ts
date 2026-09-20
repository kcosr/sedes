import type { DatabaseMigration } from "../migrate.js";

/** Removes recency state from durable, fail-closed hidden file-link roots. */
export const removeWorkspaceFileLinkRootRecencyMigration: DatabaseMigration = {
  version: 36,
  name: "remove-workspace-file-link-root-recency",
  sql: `
DROP INDEX workspace_file_link_roots_recent;

ALTER TABLE workspace_file_link_roots DROP COLUMN last_used_at;
`,
};
