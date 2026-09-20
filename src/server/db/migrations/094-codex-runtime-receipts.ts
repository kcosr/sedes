import type { DatabaseMigration } from "../migrate.js";

export const codexRuntimeReceiptsMigration: DatabaseMigration = {
  version: 94,
  name: "codex_runtime_receipts",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE codex_runtime_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'fork', 'start', 'steer')),
  method TEXT NOT NULL CHECK (method IN ('thread/start', 'thread/fork', 'turn/start', 'turn/steer')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'recorded', 'reconciled')),
  outcome_json TEXT CHECK (outcome_json IS NULL OR
    (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 4096)),
  outcome_fingerprint TEXT CHECK (outcome_fingerprint IS NULL OR length(outcome_fingerprint) = 64),
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
CREATE TABLE codex_retired_runtime_receipt_fences (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  retirement_operation_id TEXT NOT NULL CHECK (length(retirement_operation_id) BETWEEN 1 AND 256),
  retired_at INTEGER NOT NULL CHECK (retired_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id)
) STRICT;
`,
};
