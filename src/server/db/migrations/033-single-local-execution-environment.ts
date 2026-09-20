import type { DatabaseMigration } from "../migrate.js";

/**
 * Enforces the local execution-environment singleton at the persisted
 * principal boundary while continuing to permit multiple SSH environments.
 */
export const singleLocalExecutionEnvironmentMigration: DatabaseMigration = {
  version: 33,
  name: "single-local-execution-environment",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE UNIQUE INDEX execution_environments_single_local_owner
ON execution_environments(tenant_id, owner_principal_id)
WHERE kind = 'local';
`,
};
