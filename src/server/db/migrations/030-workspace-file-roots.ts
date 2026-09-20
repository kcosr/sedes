import type { DatabaseMigration } from "../migrate.js";

/** Durable, principal-owned supplemental roots for one workspace's Files panel. */
export const workspaceFileRootsMigration: DatabaseMigration = {
  version: 30,
  name: "workspace-file-roots",
  sql: `
CREATE UNIQUE INDEX workspaces_by_owner_and_id
  ON workspaces(tenant_id, owner_principal_id, id);

CREATE TABLE workspace_file_roots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL CHECK (
    length(root_id) BETWEEN 1 AND 128 AND root_id <> 'primary'
  ),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 4096),
  display_label TEXT NOT NULL COLLATE NOCASE
    CHECK (length(display_label) BETWEEN 1 AND 240),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  availability TEXT NOT NULL
    CHECK (availability IN ('available', 'unavailable')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, workspace_id, root_id),
  UNIQUE (tenant_id, owner_principal_id, workspace_id, root_id),
  UNIQUE (tenant_id, workspace_id, canonical_path),
  UNIQUE (tenant_id, workspace_id, display_label),
  FOREIGN KEY (tenant_id, owner_principal_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_file_roots_ordered
  ON workspace_file_roots(
    tenant_id, owner_principal_id, workspace_id, sort_order, root_id
  );

CREATE TABLE workspace_file_root_mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 32768
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_file_root_mutation_receipts_created
  ON workspace_file_root_mutation_receipts(
    tenant_id, principal_id, created_at
  );
`,
};
