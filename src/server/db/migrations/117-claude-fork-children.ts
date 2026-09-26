import type { DatabaseMigration } from "../migrate.js";

/**
 * Provider-private evidence recorded when a Claude fork child is verified:
 * which of its turns copy which source turns (for inherited usage and
 * terminal receipts), and which rows Claude appended to report background
 * tasks from before the fork point as unfinished (for the child's notice).
 */
export const claudeForkChildrenMigration: DatabaseMigration = {
  version: 117,
  name: "claude_fork_children",
  sql: `
CREATE TABLE claude_fork_children (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 512),
  fork_operation_id TEXT NOT NULL CHECK (length(fork_operation_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_thread_settings(tenant_id, owner_principal_id, application_thread_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE claude_fork_inherited_turns (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  child_backend_turn_id TEXT NOT NULL CHECK (length(child_backend_turn_id) BETWEEN 1 AND 512),
  source_backend_turn_id TEXT NOT NULL CHECK (length(source_backend_turn_id) BETWEEN 1 AND 512),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, ordinal),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, child_backend_turn_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_fork_children(tenant_id, owner_principal_id, application_thread_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE claude_fork_omitted_tasks (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  native_message_uuid TEXT NOT NULL CHECK (length(native_message_uuid) BETWEEN 1 AND 512),
  native_task_id TEXT NOT NULL CHECK (length(native_task_id) BETWEEN 1 AND 512),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, native_message_uuid),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_fork_children(tenant_id, owner_principal_id, application_thread_id) ON DELETE CASCADE
) STRICT;
`,
};
