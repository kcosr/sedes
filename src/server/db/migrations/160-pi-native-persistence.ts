import type { DatabaseMigration } from "../migrate.js";

/** Native Pi shares provider files with Pi SDK, never application overlays. */
export const piNativePersistenceMigration: DatabaseMigration = {
  version: 160,
  name: "pi_native_persistence",
  sql: `
CREATE TABLE pi_native_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT CHECK (thinking_level IS NULL OR thinking_level IN
    ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('read_only', 'ask', 'full')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
) STRICT;

CREATE TRIGGER pi_native_settings_target_insert
BEFORE INSERT ON pi_native_thread_settings
WHEN NOT EXISTS (
  SELECT 1 FROM application_threads AS thread
  JOIN agent_backend_instances AS backend
    ON backend.tenant_id = thread.tenant_id
    AND backend.id = thread.backend_instance_id
  WHERE thread.tenant_id = NEW.tenant_id
    AND thread.owner_principal_id = NEW.owner_principal_id
    AND thread.id = NEW.application_thread_id AND backend.kind = 'pi_native'
)
BEGIN SELECT RAISE(ABORT, 'Pi native settings target mismatch'); END;

CREATE TABLE pi_native_binding_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL
    CHECK (length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096),
  native_session_path TEXT NOT NULL CHECK (length(native_session_path) BETWEEN 1 AND 4096),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  UNIQUE (tenant_id, backend_instance_id, execution_environment_id, native_session_path),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, execution_environment_id)
    REFERENCES conversation_bindings(tenant_id, owner_principal_id,
      application_thread_id, backend_instance_id, execution_environment_id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE pi_native_submission_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  creation_attempt_id TEXT,
  accepted_user_entry_id TEXT CHECK
    (accepted_user_entry_id IS NULL OR length(accepted_user_entry_id) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id, creation_attempt_id)
    REFERENCES conversation_creation_attempts(tenant_id, owner_principal_id,
      application_thread_id, attempt_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE pi_native_operations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 240),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('submission', 'action', 'interrupt')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'sent', 'completed', 'unknown')),
  prepare_attempt INTEGER NOT NULL DEFAULT 0 CHECK (prepare_attempt BETWEEN 0 AND 9007199254740991),
  dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_started IN (0, 1)
    AND (dispatch_started = 0 OR (operation_kind = 'submission' AND state <> 'prepared'))),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER pi_native_dispatch_monotonic
BEFORE UPDATE OF dispatch_started ON pi_native_operations
WHEN OLD.dispatch_started = 1 AND NEW.dispatch_started = 0
BEGIN SELECT RAISE(ABORT, 'Pi submission dispatch cannot be cleared'); END;
`,
};
