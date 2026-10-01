import type { DatabaseMigration } from "../migrate.js";

export const openCodeRecoveryRetirementMigration: DatabaseMigration = {
  version: 124,
  name: "opencode_recovery_retirement",
  sql: `
ALTER TABLE opencode_input_evidence ADD COLUMN terminal_lost_at INTEGER
  CHECK (terminal_lost_at IS NULL OR terminal_lost_at >= 0);
CREATE INDEX opencode_input_evidence_unresolved
  ON opencode_input_evidence (tenant_id, owner_principal_id, application_operation_id, operation_kind)
  WHERE consumed_fingerprint IS NULL AND withdrawn_fingerprint IS NULL
    AND payload_conflict=0 AND terminal_lost_at IS NULL;
DROP INDEX opencode_operation_native_input;
CREATE UNIQUE INDEX opencode_operation_native_input
  ON opencode_operation_receipts (tenant_id, owner_principal_id, native_namespace_key, native_session_id, native_input_id)
  WHERE native_input_id IS NOT NULL AND
    (operation_kind <> 'interaction' OR disposition IN ('dispatched','unknown','accepted'));
`,
};
