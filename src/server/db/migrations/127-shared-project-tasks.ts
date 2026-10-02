import type Database from "better-sqlite3";
import type { DatabaseMigration } from "../migrate.js";

const taskReceiptKinds = "('create_task', 'update_task', 'move_task')";

/** The project of a workspace; NULL only when no such workspace exists. */
function workspaceProject(tenantId: string, ownerPrincipalId: string, workspaceId: string): string {
  return `(SELECT workspace.project_id FROM workspaces AS workspace
    WHERE workspace.tenant_id = ${tenantId} AND workspace.owner_principal_id = ${ownerPrincipalId}
      AND workspace.id = ${workspaceId})`;
}

/**
 * Stored task contexts rewritten in place: only rows that no provider has
 * received under their own operation yet. See the migration comment.
 */
const rewrittenTaskContexts = [
  {
    table: "queued_inputs",
    column: "task_contexts_json",
    eligible: (row: string) =>
      `${row}.state = 'pending' AND ${row}.retry_count = 0 AND ${row}.invalid_state_requeues = 0`,
  },
  {
    table: "conversation_creation_attempts",
    column: "initial_task_contexts_json",
    eligible: (row: string) =>
      `${row}.phase IN ('prepared', 'external_call_started', 'conversation_identified')
    AND ${row}.force_reset_at IS NULL`,
  },
] as const;

const workspaceElement = "json_extract(item.value, '$.scope.kind') = 'workspace'";

function rewriteTaskContexts({ table, column, eligible }: (typeof rewrittenTaskContexts)[number]): string {
  const project = workspaceProject(`${table}.tenant_id`, `${table}.owner_principal_id`,
    "json_extract(item.value, '$.scope.workspaceId')");
  // `->` returns an untouched element's exact JSON text, so only the
  // workspace-scoped elements change; ORDER BY keeps the array order.
  return `UPDATE ${table}
SET ${column} = (
  SELECT json_group_array(CASE WHEN ${workspaceElement}
      THEN json_set(item.value, '$.scope', json_object('kind', 'project', 'projectId', ${project}))
      ELSE ${table}.${column} -> item.fullkey END
    ORDER BY item.key)
  FROM json_each(${table}.${column}) AS item
)
WHERE ${eligible(table)}
  AND EXISTS (SELECT 1 FROM json_each(${table}.${column}) AS item WHERE ${workspaceElement});`;
}

/**
 * Every workspace this migration maps to a project must still exist. Tasks
 * and Workpads have NOT NULL project CHECKs; receipts, revisions and stored
 * contexts are JSON and would otherwise silently gain a null project.
 */
function assertWorkspaceReferencesResolve(database: Database.Database): void {
  const unresolved = database.prepare(`
SELECT 1 FROM task_mutation_receipts AS receipt
WHERE receipt.operation_kind IN ${taskReceiptKinds}
  AND json_extract(receipt.result_json, '$.record.scopeKind') = 'workspace'
  AND ${workspaceProject("receipt.tenant_id", "receipt.principal_id",
    "json_extract(receipt.result_json, '$.record.workspaceId')")} IS NULL
UNION ALL
SELECT 1 FROM workpads AS workpad
WHERE workpad.scope_kind = 'workspace'
  AND ${workspaceProject("workpad.tenant_id", "workpad.owner_principal_id", "workpad.workspace_id")} IS NULL
UNION ALL
SELECT 1 FROM workpad_revisions AS revision
WHERE json_extract(revision.document_json, '$.scope.kind') = 'workspace'
  AND ${workspaceProject("revision.tenant_id", "revision.owner_principal_id",
    "json_extract(revision.document_json, '$.scope.workspaceId')")} IS NULL
${rewrittenTaskContexts.map(({ table, column, eligible }) => `UNION ALL
SELECT 1 FROM ${table} AS source, json_each(source.${column}) AS item
WHERE ${eligible("source")} AND ${workspaceElement}
  AND ${workspaceProject("source.tenant_id", "source.owner_principal_id",
    "json_extract(item.value, '$.scope.workspaceId')")} IS NULL`).join("\n")}
LIMIT 1`).get();
  if (unresolved) {
    throw new Error(
      "Database migration 127 found saved work whose location no longer exists.",
    );
  }
}

/**
 * Restates migration 99's commit-time guards for project scope: saved work
 * cannot be added to, or moved into, a removed project, nor into a thread
 * whose location was removed.
 */
function savedWorkProjectGuards(table: "tasks" | "workpads"): string {
  const removed = `((NEW.scope_kind = 'project' AND EXISTS (SELECT 1 FROM projects AS project
      WHERE project.tenant_id = NEW.tenant_id AND project.owner_principal_id = NEW.owner_principal_id
        AND project.id = NEW.project_id AND project.removed_at IS NOT NULL))
    OR (NEW.scope_kind = 'thread' AND EXISTS (SELECT 1 FROM application_threads AS thread
      JOIN workspaces AS workspace ON workspace.tenant_id = thread.tenant_id
        AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
      WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.owner_principal_id
        AND thread.id = NEW.thread_id AND workspace.removed_at IS NOT NULL)))`;
  return `CREATE TRIGGER ${table}_project_create BEFORE INSERT ON ${table}
WHEN ${removed}
BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before adding saved work.'); END;
CREATE TRIGGER ${table}_project_move BEFORE UPDATE OF scope_kind, project_id, thread_id ON ${table}
WHEN (NEW.scope_kind IS NOT OLD.scope_kind OR NEW.project_id IS NOT OLD.project_id
    OR NEW.thread_id IS NOT OLD.thread_id)
  AND ${removed}
BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before moving saved work into it.'); END;`;
}

const scopeCheck = `CHECK (
    (scope_kind = 'global' AND project_id IS NULL AND thread_id IS NULL)
    OR (scope_kind = 'project' AND project_id IS NOT NULL AND thread_id IS NULL)
    OR (scope_kind = 'thread' AND project_id IS NULL AND thread_id IS NOT NULL)
  )`;

/**
 * Tasks and Workpads are scoped globally, to a project, or to a thread. A
 * workspace-scoped item becomes scoped to its workspace's project, so every
 * location of the project shares it.
 *
 * Foreign keys must be off. With them on, DROP TABLE tasks aborts once a
 * force reset promoted a task (thread_force_reset_promoted_tasks references
 * tasks ON DELETE RESTRICT), and DROP TABLE workpads would cascade-delete
 * every workpad revision and draft. Legacy ALTER TABLE keeps those references
 * bound by name to the rebuilt tables. The integrity check proves them intact.
 *
 * Task mutation receipts keep replaying the record they committed: their
 * workspace scope becomes the project scope, and a workspace create receipt
 * takes the fingerprint a project create now computes. Update and move
 * receipts cannot be re-fingerprinted because their expected revision was
 * never stored; replaying one written before the upgrade reports a reused
 * mutation ID. That fail-closed outcome is accepted, and receipts are never
 * pruned.
 *
 * Workpad documents and revisions record their scope. Each revision maps its
 * own recorded workspace, which may differ from the workpad's current scope.
 *
 * Stored task contexts hold whole Task snapshots. Only those no provider has
 * received yet are rewritten:
 * - a queued input that is pending, never retried and never requeued after an
 *   invalid-state attempt. Any other queued input may correspond to a signed
 *   carrier or be accepted late, and Pi replay recomputes fingerprints from
 *   its contexts.
 * - a creation attempt before its first submission that was not force reset.
 *   Contexts first reach a provider when an attempt leaves
 *   conversation_identified, which recovery re-enters only before
 *   submission. Force-reset attempts are immutable.
 * Every other stored context, including mutation receipts and delivery input
 * snapshots, stays byte-identical, as does every row without a workspace
 * scope.
 */
export const sharedProjectTasksMigration: DatabaseMigration = {
  version: 127,
  name: "shared_project_tasks",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  preflight: assertWorkspaceReferencesResolve,
  sql: `
CREATE TABLE tasks_v127 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'thread')),
  project_id TEXT,
  thread_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 65536),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  files_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(files_json)
    AND json_type(files_json) = 'array'
    AND length(CAST(files_json AS BLOB)) <= 524288
  ),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  ${scopeCheck},
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, project_id)
    REFERENCES projects(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

-- An unmapped workspace task yields a NULL project and fails the CHECK.
INSERT INTO tasks_v127(
  tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id, title,
  details, pinned, files_json, completed_at, revision, created_at, updated_at
)
SELECT task.tenant_id, task.owner_principal_id, task.id,
  CASE task.scope_kind WHEN 'workspace' THEN 'project' ELSE task.scope_kind END,
  CASE WHEN task.scope_kind = 'workspace'
    THEN ${workspaceProject("task.tenant_id", "task.owner_principal_id", "task.workspace_id")} END,
  task.thread_id, task.title, task.details, task.pinned, task.files_json,
  task.completed_at, task.revision, task.created_at, task.updated_at
FROM tasks AS task;

DROP TABLE tasks;
ALTER TABLE tasks_v127 RENAME TO tasks;

CREATE INDEX tasks_by_thread
  ON tasks(tenant_id, owner_principal_id, thread_id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX tasks_by_project
  ON tasks(tenant_id, owner_principal_id, project_id)
  WHERE project_id IS NOT NULL;
${savedWorkProjectGuards("tasks")}

UPDATE task_mutation_receipts
SET result_json = json_remove(
  json_set(result_json,
    '$.record.scopeKind', CASE json_extract(result_json, '$.record.scopeKind')
      WHEN 'workspace' THEN 'project'
      ELSE json_extract(result_json, '$.record.scopeKind') END,
    '$.record.projectId', CASE WHEN json_extract(result_json, '$.record.scopeKind') = 'workspace'
      THEN ${workspaceProject("task_mutation_receipts.tenant_id", "task_mutation_receipts.principal_id",
        "json_extract(task_mutation_receipts.result_json, '$.record.workspaceId')")} END),
  '$.record.environmentId', '$.record.workspaceId')
WHERE operation_kind IN ${taskReceiptKinds};

-- No receipt had a project scope before this migration.
UPDATE task_mutation_receipts
SET request_fingerprint = sedes_project_task_create_receipt_fingerprint(result_json)
WHERE operation_kind = 'create_task'
  AND json_extract(result_json, '$.record.scopeKind') = 'project';

CREATE TABLE workpads_v127 (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global', 'project', 'thread')),
  project_id TEXT, thread_id TEXT, title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  PRIMARY KEY(tenant_id, owner_principal_id, id),
  FOREIGN KEY(tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id, owner_principal_id, project_id)
    REFERENCES projects(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  ${scopeCheck}
);

INSERT INTO workpads_v127(
  tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id, title,
  revision, archived_at, created_at, updated_at, document_json
)
SELECT source.tenant_id, source.owner_principal_id, source.id,
  CASE source.scope_kind WHEN 'workspace' THEN 'project' ELSE source.scope_kind END,
  source.project_id, source.thread_id, source.title, source.revision,
  source.archived_at, source.created_at, source.updated_at,
  CASE WHEN source.scope_kind = 'workspace'
    THEN json_set(source.document_json, '$.scope',
      json_object('kind', 'project', 'projectId', source.project_id))
    ELSE source.document_json END
FROM (
  SELECT workpad.*, CASE WHEN workpad.scope_kind = 'workspace'
      THEN ${workspaceProject("workpad.tenant_id", "workpad.owner_principal_id", "workpad.workspace_id")}
    END AS project_id
  FROM workpads AS workpad
) AS source;

DROP TABLE workpads;
ALTER TABLE workpads_v127 RENAME TO workpads;

CREATE INDEX workpads_scope ON workpads(tenant_id, owner_principal_id, scope_kind, project_id, thread_id, archived_at, updated_at DESC, id);
${savedWorkProjectGuards("workpads")}

UPDATE workpad_revisions
SET document_json = json_set(document_json, '$.scope', json_object('kind', 'project', 'projectId',
  ${workspaceProject("workpad_revisions.tenant_id", "workpad_revisions.owner_principal_id",
    "json_extract(workpad_revisions.document_json, '$.scope.workspaceId')")}))
WHERE json_extract(document_json, '$.scope.kind') = 'workspace';

${rewrittenTaskContexts.map(rewriteTaskContexts).join("\n\n")}
`,
};
