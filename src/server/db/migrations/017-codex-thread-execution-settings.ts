export const codexThreadExecutionSettingsMigration = {
  version: 17,
  name: "codex_thread_execution_settings",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE codex_thread_execution_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  desired_model TEXT CHECK (
    desired_model IS NULL OR length(desired_model) BETWEEN 1 AND 120
  ),
  desired_reasoning_effort TEXT CHECK (
    desired_reasoning_effort IS NULL
    OR length(desired_reasoning_effort) BETWEEN 1 AND 120
  ),
  desired_permission_profile TEXT CHECK (
    desired_permission_profile IS NULL
    OR desired_permission_profile IN ('read_only', 'workspace', 'unrestricted')
  ),
  effective_model TEXT CHECK (
    effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 120
  ),
  effective_reasoning_effort TEXT CHECK (
    effective_reasoning_effort IS NULL
    OR length(effective_reasoning_effort) BETWEEN 1 AND 120
  ),
  effective_permission_profile TEXT CHECK (
    effective_permission_profile IS NULL
    OR effective_permission_profile IN ('read_only', 'workspace', 'unrestricted')
  ),
  effective_permission_classification TEXT CHECK (
    effective_permission_classification IS NULL
    OR effective_permission_classification IN ('recognized', 'external_custom')
  ),
  effective_daemon_generation INTEGER CHECK (effective_daemon_generation > 0),
  effective_confirmation_state TEXT NOT NULL CHECK (
    effective_confirmation_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (desired_model IS NULL
      AND desired_reasoning_effort IS NULL
      AND desired_permission_profile IS NULL)
    OR
    (desired_model IS NOT NULL
      AND desired_reasoning_effort IS NOT NULL
      AND desired_permission_profile IS NOT NULL)
  ),
  CHECK (
    (effective_model IS NULL
      AND effective_reasoning_effort IS NULL
      AND effective_permission_profile IS NULL
      AND effective_permission_classification IS NULL)
    OR
    (effective_model IS NOT NULL
      AND effective_reasoning_effort IS NOT NULL
      AND (
        (effective_permission_classification = 'recognized'
          AND effective_permission_profile IS NOT NULL)
        OR
        (effective_permission_classification = 'external_custom'
          AND effective_permission_profile IS NULL)
      ))
  ),
  CHECK (
    (effective_confirmation_state = 'unconfirmed'
      AND effective_model IS NULL
      AND effective_daemon_generation IS NULL)
    OR
    (effective_confirmation_state = 'confirmed'
      AND effective_model IS NOT NULL
      AND effective_daemon_generation IS NOT NULL)
    OR
    (effective_confirmation_state = 'unknown'
      AND effective_daemon_generation IS NULL)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO codex_thread_execution_settings(
  tenant_id, owner_principal_id, application_thread_id,
  desired_model, desired_reasoning_effort, desired_permission_profile,
  effective_confirmation_state, revision, created_at, updated_at
)
SELECT thread.tenant_id, thread.owner_principal_id, thread.id,
  NULL, NULL, NULL, 'unconfirmed', 0, thread.created_at, thread.updated_at
FROM application_threads AS thread
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = thread.tenant_id
  AND backend.id = thread.backend_instance_id
WHERE backend.kind = 'codex_app_server';

CREATE TABLE codex_execution_settings_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 128
  ),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort TEXT NOT NULL CHECK (
    length(reasoning_effort) BETWEEN 1 AND 120
  ),
  permission_profile TEXT NOT NULL CHECK (
    permission_profile IN ('read_only', 'workspace', 'unrestricted')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    application_operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES codex_thread_execution_settings(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER codex_execution_settings_snapshots_immutable_update
BEFORE UPDATE ON codex_execution_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
END;

CREATE TRIGGER codex_execution_settings_snapshots_immutable_delete
BEFORE DELETE ON codex_execution_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
END;

CREATE TABLE provider_feature_mutation_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  feature_id TEXT NOT NULL CHECK (length(feature_id) BETWEEN 1 AND 128),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  expected_thread_revision INTEGER NOT NULL CHECK (
    expected_thread_revision >= 0
  ),
  expected_feature_revision INTEGER NOT NULL CHECK (
    expected_feature_revision >= 0
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'uncertain')),
  desired_postcondition_json TEXT NOT NULL CHECK (
    length(CAST(desired_postcondition_json AS BLOB)) BETWEEN 2 AND 8192
    AND json_valid(desired_postcondition_json)
    AND json_type(desired_postcondition_json) = 'object'
  ),
  result_json TEXT CHECK (
    result_json IS NULL
    OR (
      length(CAST(result_json AS BLOB)) BETWEEN 2 AND 8192
      AND json_valid(result_json)
      AND json_type(result_json) = 'object'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX provider_feature_receipts_by_thread
  ON provider_feature_mutation_receipts(
    tenant_id, owner_principal_id, application_thread_id, created_at
  );
`,
} as const;
