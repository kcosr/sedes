import type { DatabaseMigration } from "../migrate.js";

/** Extend environment identity without changing existing keys or retained history. */
export const outboundHostPairingMigration: DatabaseMigration = {
  version: 97,
  name: "outbound-host-pairing",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE execution_environments_v97 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh', 'outbound')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  diagnostic_code TEXT CHECK (diagnostic_code IS NULL OR length(diagnostic_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  configuration_revision INTEGER NOT NULL DEFAULT 0 CHECK (configuration_revision >= 0),
  configuration_fingerprint TEXT NOT NULL CHECK (length(configuration_fingerprint) = 64 AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  operations_configuration_revision INTEGER NOT NULL DEFAULT 0 CHECK (operations_configuration_revision >= 0),
  operations_configuration_fingerprint TEXT NOT NULL DEFAULT 'c7fe75f8261071c4c1bc7a9219514e59501c1102c43ba064f2d062d975409a68'
    CHECK (length(operations_configuration_fingerprint) = 64 AND operations_configuration_fingerprint NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
INSERT INTO execution_environments_v97
  (tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
   configuration_revision, configuration_fingerprint, created_at, updated_at,
   operations_configuration_revision, operations_configuration_fingerprint)
SELECT tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
   configuration_revision, configuration_fingerprint, created_at, updated_at,
   operations_configuration_revision, operations_configuration_fingerprint
FROM execution_environments;
DROP TABLE execution_environments;
ALTER TABLE execution_environments_v97 RENAME TO execution_environments;
CREATE UNIQUE INDEX execution_environments_single_local_owner
  ON execution_environments(tenant_id, owner_principal_id) WHERE kind = 'local';

CREATE TABLE host_pairings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linux', 'darwin', 'win32')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, connector_id),
  UNIQUE (tenant_id, owner_principal_id, environment_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id)
    REFERENCES execution_environments(tenant_id, owner_principal_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE host_registration_requests (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  correlation_code TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'denied', 'expired')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  pairing_id TEXT,
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, connector_id, attempt_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, pairing_id) REFERENCES host_pairings(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX host_registration_pending_connector
  ON host_registration_requests(tenant_id, owner_principal_id, connector_id) WHERE state = 'pending';
CREATE TABLE host_pairing_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('accept', 'deny', 'revoke', 'reapprove')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
};
