import type { DatabaseMigration } from "../migrate.js";

/**
 * Makes each Pi sandbox's workspace authority explicit. Existing allocations
 * are writable Git clones; new read-only allocations mount the source while
 * retaining their own private writable home.
 */
export const piSandboxWorkspaceAccessMigration: DatabaseMigration = {
  version: 68,
  name: "pi-sandbox-workspace-access",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE pi_sandbox_allocations
ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'writable_clone'
  CHECK (workspace_access IN ('writable_clone', 'read_only'));
`,
};
