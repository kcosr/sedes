import type { DatabaseMigration } from "../migrate.js";

// Commit-time invariants fence stale async admissions as well as direct repository writes.
// The service layer supplies user-facing eligibility errors before these final guards.
function threadProjectGuard(table: string, threadColumn: string): string {
  return `CREATE TRIGGER ${table}_project_admission BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
      ON workspace.tenant_id = thread.tenant_id AND workspace.owner_principal_id = thread.owner_principal_id
      AND workspace.id = thread.workspace_id
      WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.owner_principal_id
        AND thread.id = NEW.${threadColumn} AND workspace.removed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before starting new work.'); END;`;
}

function metadataProjectGuards(table: "tasks" | "workpads"): string {
  const removed = `EXISTS (SELECT 1 FROM workspaces AS workspace
    WHERE workspace.tenant_id = NEW.tenant_id AND workspace.owner_principal_id = NEW.owner_principal_id
      AND workspace.removed_at IS NOT NULL AND (
        (NEW.scope_kind = 'workspace' AND workspace.id = NEW.workspace_id)
        OR (NEW.scope_kind = 'thread' AND workspace.id = (
          SELECT workspace_id FROM application_threads WHERE tenant_id = NEW.tenant_id
            AND owner_principal_id = NEW.owner_principal_id AND id = NEW.thread_id))))`;
  return `CREATE TRIGGER ${table}_project_create BEFORE INSERT ON ${table}
    WHEN ${removed}
    BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before adding saved work.'); END;
    CREATE TRIGGER ${table}_project_move BEFORE UPDATE OF scope_kind, workspace_id, thread_id ON ${table}
    WHEN (NEW.scope_kind IS NOT OLD.scope_kind OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.thread_id IS NOT OLD.thread_id)
      AND ${removed}
    BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before moving saved work into it.'); END;`;
}

export const projectRemovalMigration: DatabaseMigration = {
  version: 99,
  name: "project_removal",
  sql: `
ALTER TABLE workspaces ADD COLUMN removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0);
CREATE TRIGGER application_threads_project_admission BEFORE INSERT ON application_threads
WHEN EXISTS (SELECT 1 FROM workspaces WHERE tenant_id = NEW.tenant_id
  AND owner_principal_id = NEW.owner_principal_id AND id = NEW.workspace_id AND removed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before starting new work.'); END;
CREATE TRIGGER application_threads_project_move BEFORE UPDATE OF workspace_id ON application_threads
WHEN EXISTS (SELECT 1 FROM workspaces WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
  AND id IN (OLD.workspace_id, NEW.workspace_id) AND removed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before moving a thread.'); END;
${metadataProjectGuards("tasks")}
${metadataProjectGuards("workpads")}
${threadProjectGuard("conversation_bindings", "application_thread_id")}
${threadProjectGuard("conversation_creation_attempts", "application_thread_id")}
${threadProjectGuard("queued_inputs", "application_thread_id")}
${threadProjectGuard("automation_definitions", "anchor_thread_id")}
${threadProjectGuard("automation_runs", "anchor_thread_id")}
${threadProjectGuard("provider_feature_mutation_receipts", "application_thread_id")}
CREATE TRIGGER automation_definitions_project_enable BEFORE UPDATE OF enabled, anchor_thread_id ON automation_definitions
WHEN (NEW.enabled = 1 OR NEW.anchor_thread_id <> OLD.anchor_thread_id)
  AND EXISTS (SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
    ON workspace.tenant_id = thread.tenant_id AND workspace.owner_principal_id = thread.owner_principal_id
    AND workspace.id = thread.workspace_id
    WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.owner_principal_id
      AND thread.id = NEW.anchor_thread_id AND workspace.removed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before enabling scheduled work.'); END;
`,
};
