import type { DatabaseMigration } from "../migrate.js";

export const largeTaskDetailsMigration: DatabaseMigration = {
  version: 25,
  name: "large-task-details",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE tasks_v25 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'thread')),
  environment_id TEXT,
  workspace_id TEXT,
  thread_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 65536),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  CHECK (
    (scope_kind = 'global'
      AND environment_id IS NULL AND workspace_id IS NULL AND thread_id IS NULL)
    OR (scope_kind = 'workspace'
      AND environment_id IS NOT NULL AND workspace_id IS NOT NULL
      AND thread_id IS NULL)
    OR (scope_kind = 'thread'
      AND environment_id IS NULL AND workspace_id IS NULL
      AND thread_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, environment_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO tasks_v25(
  tenant_id, owner_principal_id, id, scope_kind, environment_id, workspace_id,
  thread_id, title, details, completed_at, revision, created_at, updated_at
)
SELECT
  tenant_id, owner_principal_id, id, scope_kind, environment_id, workspace_id,
  thread_id, title, details, completed_at, revision, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_v25 RENAME TO tasks;

CREATE INDEX tasks_by_thread
  ON tasks(tenant_id, owner_principal_id, thread_id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX tasks_by_workspace
  ON tasks(tenant_id, owner_principal_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE task_mutation_receipts_v25 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 524288
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO task_mutation_receipts_v25(
  tenant_id, principal_id, mutation_id, operation_kind, request_fingerprint,
  result_json, created_at
)
SELECT
  tenant_id, principal_id, mutation_id, operation_kind, request_fingerprint,
  result_json, created_at
FROM task_mutation_receipts;

DROP TABLE task_mutation_receipts;
ALTER TABLE task_mutation_receipts_v25 RENAME TO task_mutation_receipts;

CREATE INDEX task_mutation_receipts_created
  ON task_mutation_receipts(tenant_id, principal_id, created_at);
`,
};
