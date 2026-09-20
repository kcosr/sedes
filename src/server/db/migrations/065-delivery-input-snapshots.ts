import type { DatabaseMigration } from "../migrate.js";

/**
 * Immutable, principal-scoped input captured before a provider delivery
 * boundary. Provider-native staging paths and attachment bytes are deliberately
 * absent: the snapshot retains only browser-safe descriptors and blob digests.
 */
export const deliveryInputSnapshotsMigration: DatabaseMigration = {
  version: 65,
  name: "delivery-input-snapshots",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE delivery_input_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 160
  ),
  original_text TEXT NOT NULL CHECK (
    length(CAST(original_text AS BLOB)) <= 262144
  ),
  selected_skill_id TEXT CHECK (
    selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160
  ),
  context_excerpts_json TEXT NOT NULL CHECK (
    json_valid(context_excerpts_json)
    AND json_type(context_excerpts_json) = 'array'
    AND length(CAST(context_excerpts_json AS BLOB)) <= 4194304
  ),
  task_contexts_json TEXT NOT NULL CHECK (
    json_valid(task_contexts_json)
    AND json_type(task_contexts_json) = 'array'
    AND length(CAST(task_contexts_json AS BLOB)) <= 4194304
  ),
  attachments_json TEXT NOT NULL CHECK (
    json_valid(attachments_json)
    AND json_type(attachments_json) = 'array'
    AND length(CAST(attachments_json AS BLOB)) <= 65536
  ),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64
    AND fingerprint = lower(fingerprint)
    AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    application_operation_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id
  ) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER delivery_input_snapshots_immutable
BEFORE UPDATE ON delivery_input_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Delivery input snapshots are immutable');
END;
`,
};
