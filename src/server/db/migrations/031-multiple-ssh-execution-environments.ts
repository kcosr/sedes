import type { DatabaseMigration } from "../migrate.js";

/**
 * Drops the singleton kind uniqueness on execution environments so a principal
 * may own multiple SSH environments. Local remains enforced as a singleton in
 * configuration validation and reconcile.
 */
export const multipleSshExecutionEnvironmentsMigration: DatabaseMigration = {
  version: 31,
  name: "multiple-ssh-execution-environments",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE execution_environments_v31 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  diagnostic_code TEXT CHECK (
    diagnostic_code IS NULL OR length(diagnostic_code) <= 120
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  configuration_fingerprint TEXT NOT NULL CHECK (
    length(configuration_fingerprint) = 64
    AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO execution_environments_v31(
  tenant_id, owner_principal_id, id, kind, label, availability,
  diagnostic_code, revision, configuration_revision,
  configuration_fingerprint, created_at, updated_at
)
SELECT
  tenant_id, owner_principal_id, id, kind, label, availability,
  diagnostic_code, revision, configuration_revision,
  configuration_fingerprint, created_at, updated_at
FROM execution_environments;

DROP TABLE execution_environments;
ALTER TABLE execution_environments_v31 RENAME TO execution_environments;
`,
};
