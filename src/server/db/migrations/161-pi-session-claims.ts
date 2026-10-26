import type { DatabaseMigration } from "../migrate.js";

/** SDK and native Pi share physical stores without duplicating application ownership. */
export const piSessionClaimsMigration: DatabaseMigration = {
  version: 161,
  name: "pi_session_claims",
  sql: `
CREATE TABLE pi_session_claims (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  storage_host TEXT NOT NULL CHECK (storage_host IN ('main', 'execution_environment')),
  session_directory TEXT NOT NULL CHECK (length(session_directory) BETWEEN 1 AND 8192),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 512),
  backend_instance_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  creation_operation_id TEXT,
  session_file TEXT CHECK (session_file IS NULL OR length(session_file) BETWEEN 1 AND 8192),
  PRIMARY KEY (tenant_id, owner_principal_id, execution_environment_id,
    storage_host, session_directory, native_session_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
    ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX pi_session_claims_file ON pi_session_claims
  (tenant_id, owner_principal_id, execution_environment_id, storage_host, session_file)
  WHERE session_file IS NOT NULL;
CREATE UNIQUE INDEX pi_session_claims_operation ON pi_session_claims
  (tenant_id, owner_principal_id, application_thread_id, creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;
`,
};
