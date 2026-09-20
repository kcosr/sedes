import type { DatabaseMigration } from "../migrate.js";

/**
 * Principal-owned persistent thread groups. Membership is singular per thread
 * while the group entity survives with zero members until explicitly deleted.
 */
export const threadGroupsMigration: DatabaseMigration = {
  version: 71,
  name: "thread_groups",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_groups (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (
    revision BETWEEN 0 AND 9007199254740991
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, id),
  UNIQUE (tenant_id, principal_id, name_key),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE thread_group_memberships (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, principal_id, group_id)
    REFERENCES thread_groups(tenant_id, principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX thread_group_memberships_group
  ON thread_group_memberships(tenant_id, principal_id, group_id, thread_id);

ALTER TABLE thread_principal_state
ADD COLUMN group_assignment_revision INTEGER NOT NULL DEFAULT 0 CHECK (
  group_assignment_revision BETWEEN 0 AND 9007199254740991
);

CREATE TABLE thread_group_mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 1048576
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX thread_group_mutation_receipts_created
  ON thread_group_mutation_receipts(tenant_id, principal_id, created_at);
`,
};
