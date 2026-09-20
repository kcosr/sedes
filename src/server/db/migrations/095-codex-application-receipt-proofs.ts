import type { DatabaseMigration } from "../migrate.js";

// Final application operations own bounded handoff proof, without a second
// lifetime ledger or expiry that would permit a native mutation to be replayed.
export const codexApplicationReceiptProofsMigration: DatabaseMigration = {
  version: 95,
  name: "codex_application_receipt_proofs",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE submission_completion_observations ADD COLUMN codex_runtime_receipts_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(codex_runtime_receipts_json)
    AND json_type(codex_runtime_receipts_json) = 'object'
    AND length(CAST(codex_runtime_receipts_json AS BLOB)) <= 32768);
CREATE INDEX submission_completion_observations_codex_start_receipt ON submission_completion_observations(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.start.operationId')
);
CREATE INDEX submission_completion_observations_codex_steer_receipt ON submission_completion_observations(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.steer.operationId')
);
ALTER TABLE conversation_creation_attempts ADD COLUMN codex_runtime_receipts_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(codex_runtime_receipts_json)
    AND json_type(codex_runtime_receipts_json) = 'object'
    AND length(CAST(codex_runtime_receipts_json AS BLOB)) <= 32768);
CREATE INDEX conversation_creation_attempts_codex_create_receipt ON conversation_creation_attempts(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.create.operationId')
);
CREATE INDEX conversation_creation_attempts_codex_fork_receipt ON conversation_creation_attempts(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.fork.operationId')
);
`,
};
