import type { DatabaseMigration } from "../migrate.js";

export const terminalResourcesMigration: DatabaseMigration = {
  version: 80,
  name: "terminal_resources",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE terminals (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL CHECK (length(terminal_id) = 36),
  thread_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_label TEXT NOT NULL CHECK (length(environment_label) BETWEEN 1 AND 160),
  incarnation_id TEXT CHECK (incarnation_id IS NULL OR length(incarnation_id) = 36),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  shell_profile TEXT CHECK (shell_profile IS NULL OR length(shell_profile) BETWEEN 1 AND 80),
  initial_cwd TEXT NOT NULL CHECK (length(initial_cwd) BETWEEN 1 AND 4096),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'reserved', 'starting', 'running', 'stopping', 'exited', 'failed', 'interrupted'
  )),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision >= 1),
  rows INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 256),
  columns INTEGER NOT NULL CHECK (columns BETWEEN 2 AND 512),
  initial_rows INTEGER NOT NULL CHECK (initial_rows BETWEEN 1 AND 256),
  initial_columns INTEGER NOT NULL CHECK (initial_columns BETWEEN 2 AND 512),
  history_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (history_floor_seq >= 0),
  head_seq INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= history_floor_seq),
  exit_code INTEGER,
  exit_signal TEXT CHECK (exit_signal IS NULL OR length(exit_signal) BETWEEN 1 AND 80),
  public_reason TEXT CHECK (public_reason IS NULL OR length(public_reason) BETWEEN 1 AND 240),
  delete_mutation_id TEXT CHECK (delete_mutation_id IS NULL OR length(delete_mutation_id) = 36),
  delete_operation_kind TEXT CHECK (
    delete_operation_kind IS NULL OR length(delete_operation_kind) BETWEEN 1 AND 80
  ),
  delete_request_fingerprint TEXT CHECK (
    delete_request_fingerprint IS NULL OR length(delete_request_fingerprint) = 64
  ),
  delete_requested_at INTEGER CHECK (delete_requested_at IS NULL OR delete_requested_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= created_at),
  exited_at INTEGER CHECK (exited_at IS NULL OR exited_at >= created_at),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (delete_mutation_id IS NULL AND delete_operation_kind IS NULL
      AND delete_request_fingerprint IS NULL AND delete_requested_at IS NULL)
    OR
    (delete_mutation_id IS NOT NULL AND delete_operation_kind IS NOT NULL
      AND delete_request_fingerprint IS NOT NULL AND delete_requested_at IS NOT NULL)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, terminal_id),
  UNIQUE (tenant_id, owner_principal_id, terminal_id, incarnation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, environment_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX terminals_thread_lifecycle
  ON terminals(tenant_id, owner_principal_id, thread_id, lifecycle, created_at);

CREATE INDEX terminals_pending_deletion
  ON terminals(tenant_id, owner_principal_id, delete_requested_at)
  WHERE delete_mutation_id IS NOT NULL;

CREATE TABLE terminal_mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) = 36),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 65536
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
};
