import type { DatabaseMigration } from "../migrate.js";

/**
 * Task files are principal-owned presentation metadata. Stored absolute paths
 * confer no filesystem authority; the Files surface rechecks its normal
 * workspace and execution-environment policy when a user tries to open one.
 */
export const taskFilesPinsMigration: DatabaseMigration = {
  version: 34,
  name: "task-files-pins",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
  CHECK (pinned IN (0, 1));
ALTER TABLE tasks ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(files_json)
    AND json_type(files_json) = 'array'
    AND length(CAST(files_json AS BLOB)) <= 524288
  );

CREATE TABLE task_mutation_receipts_v34 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 1048576
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO task_mutation_receipts_v34(
  tenant_id, principal_id, mutation_id, operation_kind, request_fingerprint,
  result_json, created_at
)
SELECT
  tenant_id,
  principal_id,
  mutation_id,
  operation_kind,
  request_fingerprint,
  CASE
    WHEN operation_kind IN ('create_task', 'update_task', 'move_task')
      THEN json_set(
        result_json,
        '$.record.pinned', json('false'),
        '$.record.files', json('[]')
      )
    ELSE result_json
  END,
  created_at
FROM task_mutation_receipts;

DROP TABLE task_mutation_receipts;
ALTER TABLE task_mutation_receipts_v34 RENAME TO task_mutation_receipts;

CREATE INDEX task_mutation_receipts_created
  ON task_mutation_receipts(tenant_id, principal_id, created_at);
`,
};
