import type { DatabaseMigration } from "../migrate.js";

/**
 * Keeps backend protocol releases as validated, reconciled configuration rather
 * than baking each deployed provider release into durable database identity.
 */
export const mutableBackendProtocolReleaseMigration: DatabaseMigration = {
  version: 69,
  name: "mutable-backend-protocol-release",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE agent_connection_profiles
  RENAME TO agent_connection_profiles_v68;
ALTER TABLE agent_backend_instances
  RENAME TO agent_backend_instances_v68;

CREATE TABLE agent_backend_instances (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (
    kind IN ('pi', 'codex_app_server', 'claude_agent_sdk', 'grok_build')
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  protocol_release TEXT NOT NULL
    CHECK (length(protocol_release) BETWEEN 1 AND 120),
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
FROM agent_backend_instances_v68;

CREATE TABLE agent_connection_profiles (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  template_id TEXT NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (
    backend_kind IN ('pi', 'codex_app_server', 'claude_agent_sdk', 'grok_build')
  ),
  execution_environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('pi_sdk', 'codex_app_server', 'claude_agent_sdk', 'grok_acp')
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
    OR (backend_kind = 'codex_app_server' AND kind = 'codex_app_server')
    OR (backend_kind = 'claude_agent_sdk' AND kind = 'claude_agent_sdk')
    OR (backend_kind = 'grok_build' AND kind = 'grok_acp')
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
FROM agent_connection_profiles_v68;

DROP TABLE agent_connection_profiles_v68;
DROP TABLE agent_backend_instances_v68;
`,
};
