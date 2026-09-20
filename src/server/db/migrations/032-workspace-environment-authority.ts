import type { DatabaseMigration } from "../migrate.js";

/**
 * Fences each admitted workspace to the execution-environment configuration
 * generation that validated its canonical path.
 */
export const workspaceEnvironmentAuthorityMigration: DatabaseMigration = {
  version: 32,
  name: "workspace-environment-authority",
  sql: `
ALTER TABLE workspaces
  ADD COLUMN environment_configuration_revision INTEGER NOT NULL DEFAULT 0
  CHECK (environment_configuration_revision >= 0);

UPDATE workspaces
SET environment_configuration_revision = (
  SELECT environment.configuration_revision
  FROM execution_environments AS environment
  WHERE environment.tenant_id = workspaces.tenant_id
    AND environment.owner_principal_id = workspaces.owner_principal_id
    AND environment.id = workspaces.environment_id
);
`,
};
