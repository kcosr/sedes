export const modelFailureRetryStateMigration = {
  version: 156,
  name: "model_failure_retry_state",
  sql: `
CREATE TABLE model_failure_retry_state (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  binding_fingerprint TEXT NOT NULL CHECK (length(binding_fingerprint) = 64),
  retry_used INTEGER NOT NULL CHECK (retry_used IN (0, 1)),
  last_failure_identity TEXT,
  last_success_identity TEXT,
  last_input_sequence INTEGER NOT NULL CHECK (last_input_sequence >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
`,
} as const;
