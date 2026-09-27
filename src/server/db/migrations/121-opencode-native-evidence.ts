import type { DatabaseMigration } from "../migrate.js";

export const openCodeNativeEvidenceMigration: DatabaseMigration = {
  version: 121,
  name: "opencode_native_evidence",
  sql: `
CREATE TABLE opencode_binding_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  native_namespace_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL CHECK (json_valid(opaque_binding_detail)),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  UNIQUE (tenant_id, owner_principal_id, native_namespace_key, native_session_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES conversation_bindings (tenant_id, owner_principal_id, application_thread_id,
      backend_instance_id, connection_profile_id, execution_environment_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE opencode_operation_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  native_namespace_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','submit','steer','fork','interrupt')),
  native_input_id TEXT,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  deadline_at INTEGER,
  disposition TEXT NOT NULL CHECK (disposition IN ('prepared','dispatched','accepted','not_applied','unknown')),
  native_evidence_fingerprint TEXT CHECK (native_evidence_fingerprint IS NULL OR length(native_evidence_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (operation_kind <> 'interrupt' OR deadline_at IS NOT NULL),
  CHECK (disposition <> 'accepted' OR native_evidence_fingerprint IS NOT NULL),
  PRIMARY KEY (tenant_id, owner_principal_id, application_operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads (tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX opencode_operation_created_session
  ON opencode_operation_receipts (tenant_id, owner_principal_id, native_namespace_key, native_session_id)
  WHERE operation_kind IN ('create','fork');
CREATE UNIQUE INDEX opencode_operation_native_input
  ON opencode_operation_receipts (tenant_id, owner_principal_id, native_namespace_key, native_session_id, native_input_id)
  WHERE native_input_id IS NOT NULL;
CREATE INDEX opencode_operation_receipts_thread
  ON opencode_operation_receipts (tenant_id, owner_principal_id, application_thread_id, created_at);
`,
};
