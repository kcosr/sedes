import type { DatabaseMigration } from "../migrate.js";

export const scopedEnvironmentVariablesMigration: DatabaseMigration = {
  version: 107,
  name: "scoped_environment_variables",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE environment_variable_fork_requests (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;

ALTER TABLE saved_agents ADD COLUMN environment_variables_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(environment_variables_json));
ALTER TABLE application_threads ADD COLUMN environment_variables_json TEXT NOT NULL
  DEFAULT '{"version":1,"layers":{"environment":{},"backend":{},"agent":{},"thread":{}}}'
  CHECK (json_valid(environment_variables_json));
ALTER TABLE thread_templates ADD COLUMN environment_variables_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(environment_variables_json));
`,
};
