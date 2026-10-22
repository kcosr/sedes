import type { DatabaseMigration } from "../migrate.js";

export const codexActiveSpeedMigration: DatabaseMigration = {
  version: 154,
  name: "codex_active_speed",
  verifyDatabaseIntegrity: true,
  sql: `
DROP INDEX codex_runtime_receipts_pending;
ALTER TABLE codex_runtime_receipts RENAME TO codex_runtime_receipts_previous;
CREATE TABLE codex_runtime_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  native_generation INTEGER CHECK (native_generation IS NULL OR native_generation BETWEEN 1 AND 9007199254740991),
  application_operation_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'fork', 'start', 'steer', 'speed')),
  method TEXT NOT NULL CHECK (method IN ('thread/start', 'thread/fork', 'turn/start', 'turn/steer', 'turn/settings/update')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'recorded', 'reconciled')),
  outcome_json TEXT CHECK (outcome_json IS NULL OR
    (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 4096)),
  outcome_fingerprint TEXT CHECK (outcome_fingerprint IS NULL OR length(outcome_fingerprint) = 64),
  CHECK (kind != 'speed' OR native_generation IS NOT NULL),
  CHECK ((state = 'reserved' AND outcome_json IS NULL AND outcome_fingerprint IS NULL)
    OR (state = 'recorded' AND outcome_json IS NOT NULL AND outcome_fingerprint IS NOT NULL)
    OR (state = 'reconciled' AND outcome_json IS NULL AND outcome_fingerprint IS NOT NULL)),
  PRIMARY KEY (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id, operation_id),
  UNIQUE (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id,
    application_operation_id, application_thread_id, kind)
) STRICT;
CREATE INDEX codex_runtime_receipts_pending ON codex_runtime_receipts(
  tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id, state
) WHERE state != 'reconciled';

INSERT INTO codex_runtime_receipts (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id, operation_id, application_operation_id, application_thread_id, kind, method, request_fingerprint, state, outcome_json, outcome_fingerprint) SELECT tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id, operation_id, application_operation_id, application_thread_id, kind, method, request_fingerprint, state, outcome_json, outcome_fingerprint FROM codex_runtime_receipts_previous;
DROP TABLE codex_runtime_receipts_previous;
ALTER TABLE provider_feature_mutation_receipts
  RENAME COLUMN expected_feature_revision TO expected_mutation_revision;
ALTER TABLE codex_thread_execution_settings ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 0
  CHECK (desired_revision BETWEEN 0 AND 9007199254740991);
UPDATE codex_thread_execution_settings SET desired_revision = revision;
CREATE TRIGGER codex_desired_revision AFTER UPDATE OF
  desired_model, desired_reasoning_effort, desired_service_tier, desired_sandbox_mode,
  desired_network_access, desired_approval_policy, desired_approval_reviewer
ON codex_thread_execution_settings
WHEN OLD.desired_model IS NOT NEW.desired_model
  OR OLD.desired_reasoning_effort IS NOT NEW.desired_reasoning_effort
  OR OLD.desired_service_tier IS NOT NEW.desired_service_tier
  OR OLD.desired_sandbox_mode IS NOT NEW.desired_sandbox_mode
  OR OLD.desired_network_access IS NOT NEW.desired_network_access
  OR OLD.desired_approval_policy IS NOT NEW.desired_approval_policy
  OR OLD.desired_approval_reviewer IS NOT NEW.desired_approval_reviewer
BEGIN
  UPDATE codex_thread_execution_settings SET desired_revision = OLD.desired_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
    AND application_thread_id = NEW.application_thread_id;
END;

CREATE TABLE codex_speed_publications (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('ready', 'dispatching', 'settled', 'uncertain')),
  receipt_revision INTEGER NOT NULL CHECK (receipt_revision BETWEEN 1 AND 9007199254740991),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)
    AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 8192),
  continuity_json TEXT CHECK (continuity_json IS NULL OR (json_valid(continuity_json)
    AND length(CAST(continuity_json AS BLOB)) BETWEEN 2 AND 4096)),
  runtime_correlation_json TEXT CHECK (runtime_correlation_json IS NULL OR (json_valid(runtime_correlation_json) AND length(CAST(runtime_correlation_json AS BLOB)) <= 4096)),
  codex_runtime_receipts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(codex_runtime_receipts_json) AND json_type(codex_runtime_receipts_json) = 'object' AND length(CAST(codex_runtime_receipts_json AS BLOB)) <= 16384),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, mutation_id)
    REFERENCES provider_feature_mutation_receipts(tenant_id, owner_principal_id, mutation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX codex_speed_publications_thread ON codex_speed_publications(
  tenant_id, owner_principal_id, application_thread_id, created_at
);
`,
};
