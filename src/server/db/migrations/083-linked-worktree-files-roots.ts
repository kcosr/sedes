import type { DatabaseMigration } from "../migrate.js";

/** Durable discovered Git worktrees and principal-owned thread Files preferences. */
export const linkedWorktreeFilesRootsMigration: DatabaseMigration = {
  version: 83,
  name: "linked-worktree-files-roots",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE workspace_file_linked_worktree_roots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL CHECK (length(root_id) BETWEEN 1 AND 128),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 4096),
  canonical_git_dir TEXT NOT NULL CHECK (
    length(canonical_git_dir) BETWEEN 1 AND 4096
  ),
  identity_token TEXT NOT NULL CHECK (
    length(identity_token) = 64
    AND identity_token NOT GLOB '*[^0-9a-f]*'
  ),
  display_label TEXT NOT NULL CHECK (length(display_label) BETWEEN 1 AND 240),
  branch_ref TEXT CHECK (
    branch_ref IS NULL OR length(branch_ref) BETWEEN 1 AND 4096
  ),
  head_oid TEXT NOT NULL CHECK (
    length(head_oid) BETWEEN 40 AND 64
    AND head_oid NOT GLOB '*[^0-9a-f]*'
  ),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  unavailable_at INTEGER CHECK (
    unavailable_at IS NULL OR unavailable_at >= first_seen_at
  ),
  PRIMARY KEY (tenant_id, workspace_id, root_id),
  UNIQUE (tenant_id, owner_principal_id, workspace_id, root_id),
  FOREIGN KEY (tenant_id, owner_principal_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (availability = 'available' AND unavailable_at IS NULL)
    OR (availability = 'unavailable' AND unavailable_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX workspace_file_linked_worktrees_active_git_dir
  ON workspace_file_linked_worktree_roots(
    tenant_id, owner_principal_id, workspace_id, canonical_git_dir
  ) WHERE availability = 'available';

CREATE UNIQUE INDEX workspace_file_linked_worktrees_active_identity
  ON workspace_file_linked_worktree_roots(
    tenant_id, owner_principal_id, workspace_id, identity_token
  ) WHERE availability = 'available';

CREATE INDEX workspace_file_linked_worktrees_ordered
  ON workspace_file_linked_worktree_roots(
    tenant_id, owner_principal_id, workspace_id, availability,
    display_label COLLATE NOCASE, root_id
  );

ALTER TABLE thread_principal_state
ADD COLUMN preferred_files_root_id TEXT CHECK (
  preferred_files_root_id IS NULL
  OR length(preferred_files_root_id) BETWEEN 1 AND 128
);

ALTER TABLE thread_principal_state
ADD COLUMN preferred_files_root_revision INTEGER NOT NULL DEFAULT 0 CHECK (
  preferred_files_root_revision BETWEEN 0 AND 9007199254740991
);

CREATE TRIGGER thread_preferred_files_root_insert_guard
BEFORE INSERT ON thread_principal_state
WHEN NEW.preferred_files_root_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM application_threads AS thread
    JOIN workspace_file_linked_worktree_roots AS root
      ON root.tenant_id = thread.tenant_id
      AND root.owner_principal_id = thread.owner_principal_id
      AND root.workspace_id = thread.workspace_id
      AND root.root_id = NEW.preferred_files_root_id
      AND root.availability = 'available'
    WHERE thread.tenant_id = NEW.tenant_id
      AND thread.owner_principal_id = NEW.principal_id
      AND thread.id = NEW.thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'preferred Files root is not an available linked worktree for the thread workspace');
END;

CREATE TRIGGER thread_preferred_files_root_update_guard
BEFORE UPDATE OF preferred_files_root_id ON thread_principal_state
WHEN NEW.preferred_files_root_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM application_threads AS thread
    JOIN workspace_file_linked_worktree_roots AS root
      ON root.tenant_id = thread.tenant_id
      AND root.owner_principal_id = thread.owner_principal_id
      AND root.workspace_id = thread.workspace_id
      AND root.root_id = NEW.preferred_files_root_id
      AND root.availability = 'available'
    WHERE thread.tenant_id = NEW.tenant_id
      AND thread.owner_principal_id = NEW.principal_id
      AND thread.id = NEW.thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'preferred Files root is not an available linked worktree for the thread workspace');
END;
`,
};
