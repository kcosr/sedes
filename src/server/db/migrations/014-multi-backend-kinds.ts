export const multiBackendKindsMigration = {
  version: 14,
  name: "multi_backend_kinds",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE agent_backend_instances_v14 (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('pi', 'codex_app_server')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  protocol_release TEXT NOT NULL CHECK (
    length(protocol_release) BETWEEN 1 AND 120
    AND (kind <> 'pi' OR protocol_release = '0.83.0')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, kind),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_backend_instances_v14(
  tenant_id, id, kind, label, enabled, configuration_revision,
  protocol_release, created_at, updated_at
)
SELECT
  tenant_id, id, kind, label, enabled, configuration_revision,
  protocol_release, created_at, updated_at
FROM agent_backend_instances;

CREATE TABLE agent_connection_profiles_v14 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  template_id TEXT NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (
    backend_kind IN ('pi', 'codex_app_server')
  ),
  execution_environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pi_sdk', 'codex_app_server')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (backend_kind = 'pi' AND kind = 'pi_sdk')
    OR
    (backend_kind = 'codex_app_server' AND kind = 'codex_app_server')
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
    REFERENCES agent_backend_instances_v14(tenant_id, id, kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, execution_environment_id)
    REFERENCES execution_environments(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_connection_profiles_v14(
  tenant_id, owner_principal_id, id, template_id, backend_instance_id,
  backend_kind, execution_environment_id, kind, label, enabled,
  configuration_revision,
  created_at, updated_at
)
SELECT
  profile.tenant_id, profile.owner_principal_id, profile.id,
  profile.template_id, profile.backend_instance_id, backend.kind,
  profile.execution_environment_id, profile.kind, profile.label,
  profile.enabled, profile.configuration_revision,
  profile.created_at, profile.updated_at
FROM agent_connection_profiles AS profile
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = profile.tenant_id
  AND backend.id = profile.backend_instance_id;

CREATE TABLE agent_connection_setting_preferences_v14 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL
    CHECK (length(connection_profile_id) BETWEEN 1 AND 128),
  setting_id TEXT NOT NULL CHECK (
    setting_id IN ('model', 'thinking_level', 'tool_access')
  ),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (
    tenant_id, owner_principal_id, connection_profile_id, setting_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, connection_profile_id
  ) REFERENCES agent_connection_profiles_v14(
    tenant_id, owner_principal_id, id
  ) ON DELETE CASCADE
) STRICT;

INSERT INTO agent_connection_setting_preferences_v14(
  tenant_id, owner_principal_id, connection_profile_id, setting_id, value,
  revision, created_at, updated_at
)
SELECT
  preference.tenant_id, preference.owner_principal_id,
  preference.connection_profile_id, preference.setting_id, preference.value,
  preference.revision, preference.created_at, preference.updated_at
FROM agent_connection_setting_preferences AS preference
JOIN agent_connection_profiles AS profile
  ON profile.tenant_id = preference.tenant_id
  AND profile.owner_principal_id = preference.owner_principal_id
  AND profile.id = preference.connection_profile_id;

DROP TABLE agent_connection_setting_preferences;
DROP TABLE agent_connection_profiles;
DROP TABLE agent_backend_instances;
ALTER TABLE agent_backend_instances_v14 RENAME TO agent_backend_instances;
ALTER TABLE agent_connection_profiles_v14 RENAME TO agent_connection_profiles;
ALTER TABLE agent_connection_setting_preferences_v14
  RENAME TO agent_connection_setting_preferences;
`,
} as const;
