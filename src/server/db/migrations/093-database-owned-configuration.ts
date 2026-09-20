import type { DatabaseMigration } from "../migrate.js";

export const databaseOwnedConfigurationMigration: DatabaseMigration = {
  version: 93,
  name: "database_owned_configuration",
  verifyDatabaseIntegrity: true,
  sql: `
-- Existing rows are assigned only by the explicit configuration import, in the
-- same transaction as the imported definitions and completion marker. They are
-- deliberately inaccessible through scoped repositories before that import.
ALTER TABLE agent_backend_instances ADD COLUMN owner_principal_id TEXT;
CREATE UNIQUE INDEX backend_instance_principal_identity
  ON agent_backend_instances(tenant_id, owner_principal_id, id);
CREATE TRIGGER backend_instance_owner_insert BEFORE INSERT ON agent_backend_instances
WHEN NEW.owner_principal_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM principals WHERE tenant_id = NEW.tenant_id AND id = NEW.owner_principal_id
)
BEGIN SELECT RAISE(ABORT, 'backend_principal_required'); END;
CREATE TRIGGER backend_instance_owner_update BEFORE UPDATE OF owner_principal_id, tenant_id ON agent_backend_instances
WHEN NEW.owner_principal_id IS NULL OR
  (OLD.owner_principal_id IS NOT NULL AND NEW.owner_principal_id != OLD.owner_principal_id) OR
  NEW.tenant_id != OLD.tenant_id OR NOT EXISTS (
    SELECT 1 FROM principals WHERE tenant_id = NEW.tenant_id AND id = NEW.owner_principal_id
  )
BEGIN SELECT RAISE(ABORT, 'backend_principal_immutable'); END;
CREATE TRIGGER principal_backend_owner_delete BEFORE DELETE ON principals
WHEN EXISTS (SELECT 1 FROM agent_backend_instances WHERE tenant_id = OLD.tenant_id AND owner_principal_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'backend_principal_still_referenced'); END;
CREATE TRIGGER connection_profile_backend_owner_insert BEFORE INSERT ON agent_connection_profiles
WHEN NOT EXISTS (SELECT 1 FROM agent_backend_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.backend_instance_id
    AND owner_principal_id = NEW.owner_principal_id)
BEGIN SELECT RAISE(ABORT, 'backend_principal_mismatch'); END;
CREATE TRIGGER connection_profile_backend_owner_update BEFORE UPDATE OF tenant_id, owner_principal_id, backend_instance_id ON agent_connection_profiles
WHEN NOT EXISTS (SELECT 1 FROM agent_backend_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.backend_instance_id
    AND owner_principal_id = NEW.owner_principal_id)
BEGIN SELECT RAISE(ABORT, 'backend_principal_mismatch'); END;

CREATE TABLE principal_execution_configuration (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE execution_configuration_imports (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 1024),
  imported_at INTEGER NOT NULL CHECK (imported_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE execution_configuration_identities (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('environment', 'backend', 'target')),
  resource_id TEXT NOT NULL,
  identity_fingerprint TEXT NOT NULL CHECK (length(identity_fingerprint) = 64),
  PRIMARY KEY (tenant_id, owner_principal_id, resource_kind, resource_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE execution_configuration_runtime_state (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('environment', 'backend')),
  resource_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (tenant_id, owner_principal_id, resource_kind, resource_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE execution_configuration_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('save', 'lifecycle')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE execution_configuration_approved_secrets (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  reference_fingerprint TEXT NOT NULL CHECK (length(reference_fingerprint) = 64),
  PRIMARY KEY (tenant_id, owner_principal_id, environment_id, reference_fingerprint),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
};
