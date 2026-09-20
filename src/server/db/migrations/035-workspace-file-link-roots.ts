import type { DatabaseMigration } from "../migrate.js";

/** Durable, hidden roots admitted only by an explicit absolute-file open. */
export const workspaceFileLinkRootsMigration: DatabaseMigration = {
  version: 35,
  name: "workspace-file-link-roots",
  sql: `
CREATE TABLE workspace_file_link_roots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL CHECK (
    length(root_id) BETWEEN 1 AND 128 AND root_id <> 'primary'
  ),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_used_at INTEGER NOT NULL CHECK (last_used_at >= created_at),
  PRIMARY KEY (tenant_id, workspace_id, root_id),
  UNIQUE (tenant_id, owner_principal_id, workspace_id, root_id),
  UNIQUE (tenant_id, owner_principal_id, workspace_id, canonical_path),
  FOREIGN KEY (tenant_id, owner_principal_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_file_link_roots_recent
  ON workspace_file_link_roots(
    tenant_id, owner_principal_id, workspace_id, last_used_at DESC
  );
`,
};
