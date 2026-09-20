export const claudeAgentSdkBackendMigration = {
  version: 49,
  name: "claude_agent_sdk_backend",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE agent_connection_profiles
  RENAME TO agent_connection_profiles_v48;
ALTER TABLE agent_backend_instances
  RENAME TO agent_backend_instances_v48;

CREATE TABLE agent_backend_instances (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (
    kind IN ('pi', 'codex_app_server', 'claude_agent_sdk')
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  protocol_release TEXT NOT NULL CHECK (
    length(protocol_release) BETWEEN 1 AND 120
    AND (kind <> 'pi' OR protocol_release = '0.83.0')
    AND (kind <> 'claude_agent_sdk' OR protocol_release = '0.3.226')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  configuration_fingerprint TEXT NOT NULL
    DEFAULT 'f471c5e060149174c084464b55b3b5d9165e7569b2b0df609df732ced3cd06c7'
    CHECK (
    length(configuration_fingerprint) = 64
    AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, kind),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_backend_instances(
  tenant_id, id, kind, label, enabled, configuration_revision,
  protocol_release, created_at, updated_at, configuration_fingerprint
)
SELECT
  tenant_id, id, kind, label, enabled, configuration_revision,
  protocol_release, created_at, updated_at, configuration_fingerprint
FROM agent_backend_instances_v48;

CREATE TABLE agent_connection_profiles (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  template_id TEXT NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (
    backend_kind IN ('pi', 'codex_app_server', 'claude_agent_sdk')
  ),
  execution_environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('pi_sdk', 'codex_app_server', 'claude_agent_sdk')
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  configuration_fingerprint TEXT NOT NULL
    DEFAULT 'f471c5e060149174c084464b55b3b5d9165e7569b2b0df609df732ced3cd06c7'
    CHECK (
    length(configuration_fingerprint) = 64
    AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (backend_kind = 'pi' AND kind = 'pi_sdk')
    OR
    (backend_kind = 'codex_app_server' AND kind = 'codex_app_server')
    OR
    (backend_kind = 'claude_agent_sdk' AND kind = 'claude_agent_sdk')
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, template_id),
  UNIQUE (
    tenant_id, owner_principal_id, id, backend_instance_id,
    execution_environment_id
  ),
  UNIQUE (tenant_id, owner_principal_id, id, backend_instance_id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, backend_instance_id, backend_kind)
    REFERENCES agent_backend_instances(tenant_id, id, kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, execution_environment_id)
    REFERENCES execution_environments(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_connection_profiles(
  tenant_id, owner_principal_id, id, template_id, backend_instance_id,
  backend_kind, execution_environment_id, kind, label, enabled,
  configuration_revision, created_at, updated_at, configuration_fingerprint
)
SELECT
  tenant_id, owner_principal_id, id, template_id, backend_instance_id,
  backend_kind, execution_environment_id, kind, label, enabled,
  configuration_revision, created_at, updated_at, configuration_fingerprint
FROM agent_connection_profiles_v48;

DROP TABLE agent_connection_profiles_v48;
DROP TABLE agent_backend_instances_v48;

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
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
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

CREATE TABLE claude_binding_details (
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
  opaque_binding_detail TEXT NOT NULL CHECK (
    length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
    AND json_valid(opaque_binding_detail)
    AND json_type(opaque_binding_detail) = 'object'
    AND json_extract(opaque_binding_detail, '$.version') = 1
    AND json_type(opaque_binding_detail, '$.sessionId') = 'text'
    AND length(json_extract(opaque_binding_detail, '$.sessionId')) = 36
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

CREATE TABLE claude_turn_terminal_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  backend_turn_id TEXT NOT NULL CHECK (
    length(backend_turn_id) BETWEEN 1 AND 512
  ),
  status TEXT NOT NULL CHECK (status IN ('interrupted', 'failed')),
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

CREATE TABLE claude_usage_ledgers (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;
`,
} as const;
