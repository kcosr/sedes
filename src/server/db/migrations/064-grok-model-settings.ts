export const grokModelSettingsMigration = {
  version: 64,
  name: "grok_model_settings",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE grok_thread_settings (
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
  effective_model TEXT CHECK (
    effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 240
  ),
  effective_effort TEXT CHECK (
    effective_effort IS NULL OR length(effective_effort) BETWEEN 1 AND 120
  ),
  effective_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (effective_state IN ('unknown', 'confirmed')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (desired_model IS NULL AND desired_effort IS NULL)
    OR (desired_model IS NOT NULL AND desired_effort IS NOT NULL)
  ),
  CHECK (
    (effective_state = 'unknown' AND effective_model IS NULL AND effective_effort IS NULL)
    OR (effective_state = 'confirmed' AND effective_model IS NOT NULL AND effective_effort IS NOT NULL)
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

INSERT INTO grok_thread_settings(
  tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id,
  desired_model, desired_effort, revision, created_at, updated_at
)
SELECT
  thread.tenant_id, thread.owner_principal_id, thread.id,
  thread.backend_instance_id, thread.connection_profile_id,
  thread.environment_id, NULL, NULL, 0,
  thread.created_at, thread.updated_at
FROM application_threads AS thread
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = thread.tenant_id
  AND backend.id = thread.backend_instance_id
WHERE backend.kind = 'grok_build';

-- Grok Saved Agent schema v1 had no configurable fields, so its only valid
-- canonical override payload was the empty array. Advance exactly those
-- envelopes now that v2 adds model and reasoning-effort overrides. Invalid
-- v1 payloads and every other backend remain untouched and fail closed.
UPDATE saved_agents
SET backend_overrides_schema_version = 2
WHERE backend_type_id = 'grok'
  AND backend_overrides_schema_version = 1
  AND json_array_length(backend_overrides_json) = 0;
`,
} as const;
