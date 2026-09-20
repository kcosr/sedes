import type { DatabaseMigration } from "../migrate.js";

/**
 * Makes Claude effort a genuine optional model axis and records the SDK's
 * authoritative successful result boundary. Existing tuples and failure /
 * interruption receipts remain unchanged.
 */
export const claudeEffortlessModelsMigration: DatabaseMigration = {
  version: 73,
  name: "claude_effortless_models_and_result_receipts",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER claude_skill_invocations_immutable_update;
DROP TRIGGER claude_skill_invocations_immutable_delete;
DROP TRIGGER claude_operation_settings_snapshots_immutable_update;
DROP TRIGGER claude_operation_settings_snapshots_immutable_delete;

ALTER TABLE claude_skill_invocations RENAME TO claude_skill_invocations_v72;
ALTER TABLE claude_operation_settings_snapshots
  RENAME TO claude_operation_settings_snapshots_v54;
ALTER TABLE claude_thread_settings RENAME TO claude_thread_settings_v54;
ALTER TABLE claude_turn_terminal_receipts
  RENAME TO claude_turn_terminal_receipts_v49;

CREATE TABLE claude_turn_terminal_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  backend_turn_id TEXT NOT NULL CHECK (
    length(backend_turn_id) BETWEEN 1 AND 512
  ),
  status TEXT NOT NULL CHECK (
    status IN ('completed', 'interrupted', 'failed')
  ),
  provider_terminal_reason TEXT CHECK (
    provider_terminal_reason IS NULL OR (
      length(CAST(provider_terminal_reason AS BLOB)) BETWEEN 1 AND 2048
    )
  ),
  provider_result_uuid TEXT CHECK (
    provider_result_uuid IS NULL OR (
      length(CAST(provider_result_uuid AS BLOB)) BETWEEN 1 AND 2048
    )
  ),
  terminal_at INTEGER NOT NULL CHECK (terminal_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, backend_turn_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO claude_turn_terminal_receipts
SELECT * FROM claude_turn_terminal_receipts_v49;

CREATE TABLE claude_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  backend_instance_id TEXT NOT NULL CHECK (
    length(backend_instance_id) BETWEEN 1 AND 128
  ),
  connection_profile_id TEXT NOT NULL CHECK (
    length(connection_profile_id) BETWEEN 1 AND 128
  ),
  execution_environment_id TEXT NOT NULL,
  desired_model TEXT CHECK (
    desired_model IS NULL OR length(desired_model) BETWEEN 1 AND 240
  ),
  desired_effort TEXT CHECK (
    desired_effort IS NULL OR length(desired_effort) BETWEEN 1 AND 120
  ),
  desired_permission_mode TEXT CHECK (
    desired_permission_mode IS NULL OR desired_permission_mode IN (
      'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
    )
  ),
  effective_model TEXT CHECK (
    effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 240
  ),
  effective_model_state TEXT NOT NULL CHECK (
    effective_model_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_model_generation INTEGER CHECK (effective_model_generation > 0),
  effective_effort TEXT CHECK (
    effective_effort IS NULL OR length(effective_effort) BETWEEN 1 AND 120
  ),
  effective_effort_state TEXT NOT NULL CHECK (
    effective_effort_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_effort_generation INTEGER CHECK (effective_effort_generation > 0),
  effective_permission_mode TEXT CHECK (
    effective_permission_mode IS NULL OR effective_permission_mode IN (
      'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
    )
  ),
  effective_permission_classification TEXT CHECK (
    effective_permission_classification IS NULL
    OR effective_permission_classification IN ('recognized', 'external_custom')
  ),
  effective_permission_state TEXT NOT NULL CHECK (
    effective_permission_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_permission_generation INTEGER CHECK (
    effective_permission_generation > 0
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (desired_model IS NULL AND desired_effort IS NULL)
    OR desired_model IS NOT NULL
  ),
  CHECK (
    (effective_model_state = 'unconfirmed'
      AND effective_model IS NULL AND effective_model_generation IS NULL)
    OR (effective_model_state = 'confirmed'
      AND effective_model IS NOT NULL AND effective_model_generation IS NOT NULL)
    OR (effective_model_state = 'unknown' AND effective_model_generation IS NULL)
  ),
  CHECK (
    (effective_effort_state = 'unconfirmed'
      AND effective_effort IS NULL AND effective_effort_generation IS NULL)
    OR (effective_effort_state = 'confirmed'
      AND effective_effort_generation IS NOT NULL)
    OR (effective_effort_state = 'unknown' AND effective_effort_generation IS NULL)
  ),
  CHECK (
    (effective_permission_state = 'unconfirmed'
      AND effective_permission_mode IS NULL
      AND effective_permission_classification IS NULL
      AND effective_permission_generation IS NULL)
    OR (effective_permission_state = 'confirmed'
      AND effective_permission_classification IS NOT NULL
      AND effective_permission_generation IS NOT NULL
      AND ((effective_permission_classification = 'recognized'
          AND effective_permission_mode IS NOT NULL)
        OR (effective_permission_classification = 'external_custom'
          AND effective_permission_mode IS NULL)))
    OR (effective_permission_state = 'unknown'
      AND effective_permission_generation IS NULL)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id,
    backend_instance_id, connection_profile_id, environment_id
  ) ON DELETE CASCADE
) STRICT;

INSERT INTO claude_thread_settings
SELECT * FROM claude_thread_settings_v54;

CREATE TABLE claude_operation_settings_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 128
  ),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 240),
  effort TEXT CHECK (effort IS NULL OR length(effort) BETWEEN 1 AND 120),
  permission_mode TEXT NOT NULL CHECK (permission_mode IN (
    'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
  )),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    application_operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_thread_settings(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

INSERT INTO claude_operation_settings_snapshots
SELECT * FROM claude_operation_settings_snapshots_v54;

CREATE TABLE claude_skill_invocations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  native_user_message_uuid TEXT NOT NULL CHECK (
    length(native_user_message_uuid) BETWEEN 1 AND 128
  ),
  skill_name TEXT NOT NULL CHECK (
    length(skill_name) BETWEEN 1 AND 160
    AND substr(skill_name, 1, 1) GLOB '[A-Za-z]'
    AND skill_name NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    native_user_message_uuid
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_thread_settings(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

INSERT INTO claude_skill_invocations
SELECT * FROM claude_skill_invocations_v72;

DROP TABLE claude_skill_invocations_v72;
DROP TABLE claude_operation_settings_snapshots_v54;
DROP TABLE claude_thread_settings_v54;
DROP TABLE claude_turn_terminal_receipts_v49;

CREATE TRIGGER claude_operation_settings_snapshots_immutable_update
BEFORE UPDATE ON claude_operation_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
END;

CREATE TRIGGER claude_operation_settings_snapshots_immutable_delete
BEFORE DELETE ON claude_operation_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
END;

CREATE TRIGGER claude_skill_invocations_immutable_update
BEFORE UPDATE ON claude_skill_invocations
BEGIN
  SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
END;

CREATE TRIGGER claude_skill_invocations_immutable_delete
BEFORE DELETE ON claude_skill_invocations
BEGIN
  SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
END;
`,
};
