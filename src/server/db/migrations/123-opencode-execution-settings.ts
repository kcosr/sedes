import type { DatabaseMigration } from "../migrate.js";

/** Preserve checksummed M1 evidence while separating create and first submit. */
export const openCodeExecutionSettingsMigration: DatabaseMigration = {
  version: 123,
  name: "opencode_execution_settings",
  sql: `
CREATE TABLE opencode_operation_receipts_v123 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  native_namespace_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','submit','steer','fork','interrupt','action','interaction')),
  native_input_id TEXT,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  request_source_json TEXT CHECK (request_source_json IS NULL OR (json_valid(request_source_json) AND length(CAST(request_source_json AS BLOB)) <= 2048)),
  deadline_at INTEGER,
  disposition TEXT NOT NULL CHECK (disposition IN ('prepared','dispatched','accepted','not_applied','unknown')),
  native_evidence_fingerprint TEXT CHECK (native_evidence_fingerprint IS NULL OR length(native_evidence_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (operation_kind <> 'interrupt' OR deadline_at IS NOT NULL),
  CHECK (disposition <> 'accepted' OR native_evidence_fingerprint IS NOT NULL),
  PRIMARY KEY (tenant_id, owner_principal_id, application_operation_id, operation_kind),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads (tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;
INSERT INTO opencode_operation_receipts_v123 (
  tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
  connection_profile_id, execution_environment_id, native_namespace_key,
  native_session_id, application_operation_id, operation_kind, native_input_id,
  request_fingerprint, deadline_at, disposition, native_evidence_fingerprint,
  created_at, updated_at
) SELECT tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
  connection_profile_id, execution_environment_id, native_namespace_key,
  native_session_id, application_operation_id, operation_kind, native_input_id,
  request_fingerprint, deadline_at, disposition, native_evidence_fingerprint,
  created_at, updated_at FROM opencode_operation_receipts;
DROP TABLE opencode_operation_receipts;
ALTER TABLE opencode_operation_receipts_v123 RENAME TO opencode_operation_receipts;
CREATE UNIQUE INDEX opencode_operation_created_session
  ON opencode_operation_receipts (tenant_id, owner_principal_id, native_namespace_key, native_session_id)
  WHERE operation_kind IN ('create','fork');
CREATE UNIQUE INDEX opencode_operation_native_input
  ON opencode_operation_receipts (tenant_id, owner_principal_id, native_namespace_key, native_session_id, native_input_id)
  WHERE native_input_id IS NOT NULL;
CREATE INDEX opencode_operation_receipts_thread
  ON opencode_operation_receipts (tenant_id, owner_principal_id, application_thread_id, created_at);

CREATE TABLE opencode_input_evidence (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('submit','steer')),
  tracker_id TEXT NOT NULL,
  requested_delivery TEXT NOT NULL CHECK (requested_delivery IN ('queue','steer')),
  admitted_delivery TEXT CHECK (admitted_delivery IN ('queue','steer')),
  prepared_payload_fingerprint TEXT CHECK (prepared_payload_fingerprint IS NULL OR length(prepared_payload_fingerprint)=64),
  enqueue_sequence INTEGER CHECK (enqueue_sequence IS NULL OR enqueue_sequence>=0),
  consumed_fingerprint TEXT CHECK (consumed_fingerprint IS NULL OR length(consumed_fingerprint)=64),
  withdrawn_fingerprint TEXT CHECK (withdrawn_fingerprint IS NULL OR length(withdrawn_fingerprint)=64),
  withdrawal_kind TEXT CHECK (withdrawal_kind IN ('cancelled','reverted')),
  payload_conflict INTEGER NOT NULL DEFAULT 0 CHECK (payload_conflict IN (0,1)),
  updated_at INTEGER NOT NULL CHECK (updated_at>=0),
  CHECK ((withdrawn_fingerprint IS NULL)=(withdrawal_kind IS NULL)),
  PRIMARY KEY (tenant_id,owner_principal_id,application_operation_id,operation_kind),
  FOREIGN KEY (tenant_id,owner_principal_id,application_operation_id,operation_kind)
    REFERENCES opencode_operation_receipts (tenant_id,owner_principal_id,application_operation_id,operation_kind) ON DELETE RESTRICT
) STRICT;

CREATE TABLE opencode_mutation_evidence (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('action','interaction')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=1048576),
  PRIMARY KEY (tenant_id,owner_principal_id,application_operation_id,operation_kind),
  FOREIGN KEY (tenant_id,owner_principal_id,application_operation_id,operation_kind)
    REFERENCES opencode_operation_receipts (tenant_id,owner_principal_id,application_operation_id,operation_kind) ON DELETE RESTRICT
) STRICT;

CREATE TABLE opencode_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  desired_selection_json TEXT CHECK (desired_selection_json IS NULL OR (json_valid(desired_selection_json) AND length(CAST(desired_selection_json AS BLOB)) <= 4096)),
  observed_selection_json TEXT CHECK (observed_selection_json IS NULL OR (json_valid(observed_selection_json) AND length(CAST(observed_selection_json AS BLOB)) <= 8192)),
  observation_state TEXT NOT NULL DEFAULT 'unknown' CHECK (observation_state IN ('unknown','confirmed')),
  observation_generation TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (observation_state <> 'confirmed' OR (observed_selection_json IS NOT NULL AND observation_generation IS NOT NULL)),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id, backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES application_threads (tenant_id, owner_principal_id, id, backend_instance_id, connection_profile_id, environment_id) ON DELETE CASCADE
) STRICT;
INSERT INTO opencode_thread_settings (
  tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
  connection_profile_id, execution_environment_id, created_at, updated_at
) SELECT thread.tenant_id, thread.owner_principal_id, thread.id, thread.backend_instance_id,
  thread.connection_profile_id, thread.environment_id, 0, 0
  FROM application_threads AS thread JOIN agent_backend_instances AS backend
    ON backend.tenant_id = thread.tenant_id AND backend.id = thread.backend_instance_id
  WHERE backend.kind = 'opencode';

CREATE TABLE opencode_operation_settings_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','submit','steer')),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json) AND length(CAST(selection_json AS BLOB)) <= 4096),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_operation_id, operation_kind),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES opencode_thread_settings (tenant_id, owner_principal_id, application_thread_id) ON DELETE RESTRICT
) STRICT;
`,
};
