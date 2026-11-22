import type { DatabaseMigration } from "../migrate.js";

export const antigravityPersistenceMigration: DatabaseMigration = {
  version: 164,
  name: "antigravity_persistence",
  sql: `
CREATE TABLE antigravity_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  desired_model_id TEXT CHECK (
    desired_model_id IS NULL OR length(desired_model_id) BETWEEN 1 AND 240
  ),
  desired_thinking_level TEXT CHECK (
    desired_thinking_level IS NULL OR length(desired_thinking_level) BETWEEN 1 AND 120
  ),
  desired_mode_id TEXT CHECK (
    desired_mode_id IS NULL OR length(desired_mode_id) BETWEEN 1 AND 120
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id,
    backend_instance_id, connection_profile_id, environment_id
  ) ON DELETE CASCADE
) STRICT;

CREATE TABLE antigravity_binding_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL CHECK (
    length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 16384
    AND json_valid(opaque_binding_detail)
    AND json_type(opaque_binding_detail) = 'object'
    AND json_extract(opaque_binding_detail, '$.version') IS 1
    AND json_type(opaque_binding_detail, '$.sessionId') IS 'text'
    AND length(json_extract(opaque_binding_detail, '$.sessionId')) BETWEEN 1 AND 240
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES conversation_bindings(
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER antigravity_settings_target_insert
BEFORE INSERT ON antigravity_thread_settings
WHEN NOT EXISTS (
  SELECT 1 FROM agent_backend_instances
  WHERE tenant_id = NEW.tenant_id
    AND owner_principal_id = NEW.owner_principal_id
    AND id = NEW.backend_instance_id
    AND kind = 'antigravity'
)
BEGIN SELECT RAISE(ABORT, 'Antigravity settings target mismatch'); END;

CREATE TRIGGER antigravity_settings_target_update
BEFORE UPDATE OF tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id ON antigravity_thread_settings
BEGIN SELECT RAISE(ABORT, 'Antigravity settings target is immutable'); END;

CREATE TRIGGER antigravity_binding_target_insert
BEFORE INSERT ON antigravity_binding_details
WHEN NOT EXISTS (
  SELECT 1 FROM agent_backend_instances
  WHERE tenant_id = NEW.tenant_id
    AND owner_principal_id = NEW.owner_principal_id
    AND id = NEW.backend_instance_id
    AND kind = 'antigravity'
)
BEGIN SELECT RAISE(ABORT, 'Antigravity binding target mismatch'); END;

CREATE TRIGGER antigravity_binding_target_update
BEFORE UPDATE OF tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id ON antigravity_binding_details
BEGIN SELECT RAISE(ABORT, 'Antigravity binding target is immutable'); END;
`,
};
