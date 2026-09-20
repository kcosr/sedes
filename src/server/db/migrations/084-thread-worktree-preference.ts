import type { DatabaseMigration } from "../migrate.js";

/** Reframes the Files-specific preference as thread-owned worktree context. */
export const threadWorktreePreferenceMigration: DatabaseMigration = {
  version: 84,
  name: "thread-worktree-preference",
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER thread_preferred_files_root_insert_guard;
DROP TRIGGER thread_preferred_files_root_update_guard;

ALTER TABLE thread_principal_state
RENAME COLUMN preferred_files_root_id TO preferred_worktree_root_id;

ALTER TABLE thread_principal_state
RENAME COLUMN preferred_files_root_revision TO preferred_worktree_revision;

ALTER TABLE workspace_file_linked_worktree_roots
ADD COLUMN canonical_checkout_path TEXT CHECK (
  canonical_checkout_path IS NULL
  OR length(canonical_checkout_path) BETWEEN 1 AND 4096
);

ALTER TABLE workspace_file_linked_worktree_roots
ADD COLUMN provenance_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (
  provenance_kind IN ('same', 'contained', 'unmerged', 'unknown')
);

ALTER TABLE workspace_file_linked_worktree_roots
ADD COLUMN ahead_count INTEGER CHECK (
  ahead_count IS NULL OR ahead_count BETWEEN 0 AND 9007199254740991
);

ALTER TABLE workspace_file_linked_worktree_roots
ADD COLUMN behind_count INTEGER CHECK (
  behind_count IS NULL OR behind_count BETWEEN 0 AND 9007199254740991
);

DELETE FROM mutation_receipts
WHERE operation_kind = 'set_preferred_files_root';

DELETE FROM thread_agent_tool_policy_entries AS legacy
WHERE legacy.tool_id IN (
  'files.worktree_list', 'files.worktree_set', 'files.worktree_clear'
)
AND EXISTS (
  SELECT 1 FROM thread_agent_tool_policy_entries AS current
  WHERE current.tenant_id = legacy.tenant_id
    AND current.owner_principal_id = legacy.owner_principal_id
    AND current.application_thread_id = legacy.application_thread_id
    AND current.tool_id = CASE legacy.tool_id
      WHEN 'files.worktree_list' THEN 'thread.worktree_list'
      WHEN 'files.worktree_set' THEN 'thread.worktree_set'
      ELSE 'thread.worktree_clear'
    END
);

UPDATE thread_agent_tool_policy_entries
SET tool_id = CASE tool_id
  WHEN 'files.worktree_list' THEN 'thread.worktree_list'
  WHEN 'files.worktree_set' THEN 'thread.worktree_set'
  WHEN 'files.worktree_clear' THEN 'thread.worktree_clear'
END
WHERE tool_id IN (
  'files.worktree_list', 'files.worktree_set', 'files.worktree_clear'
);

UPDATE saved_agents
SET sedes_tools_json = replace(
  replace(
    replace(sedes_tools_json,
      '"files.worktree_list"', '"thread.worktree_list"'),
    '"files.worktree_set"', '"thread.worktree_set"'),
  '"files.worktree_clear"', '"thread.worktree_clear"')
WHERE sedes_tools_json IS NOT NULL
  AND (
    instr(sedes_tools_json, '"files.worktree_list"') > 0
    OR instr(sedes_tools_json, '"files.worktree_set"') > 0
    OR instr(sedes_tools_json, '"files.worktree_clear"') > 0
  );

CREATE TRIGGER thread_preferred_worktree_insert_guard
BEFORE INSERT ON thread_principal_state
WHEN NEW.preferred_worktree_root_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM application_threads AS thread
    JOIN workspace_file_linked_worktree_roots AS root
      ON root.tenant_id = thread.tenant_id
      AND root.owner_principal_id = thread.owner_principal_id
      AND root.workspace_id = thread.workspace_id
      AND root.root_id = NEW.preferred_worktree_root_id
      AND root.availability = 'available'
    WHERE thread.tenant_id = NEW.tenant_id
      AND thread.owner_principal_id = NEW.principal_id
      AND thread.id = NEW.thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'preferred worktree is not available for the thread workspace');
END;

CREATE TRIGGER thread_preferred_worktree_update_guard
BEFORE UPDATE OF preferred_worktree_root_id ON thread_principal_state
WHEN NEW.preferred_worktree_root_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM application_threads AS thread
    JOIN workspace_file_linked_worktree_roots AS root
      ON root.tenant_id = thread.tenant_id
      AND root.owner_principal_id = thread.owner_principal_id
      AND root.workspace_id = thread.workspace_id
      AND root.root_id = NEW.preferred_worktree_root_id
      AND root.availability = 'available'
    WHERE thread.tenant_id = NEW.tenant_id
      AND thread.owner_principal_id = NEW.principal_id
      AND thread.id = NEW.thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'preferred worktree is not available for the thread workspace');
END;
`,
};
