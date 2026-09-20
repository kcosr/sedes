import type { DatabaseMigration } from "../migrate.js";

/** Provider-private observed task bookends, never a source of live activity. */
export const claudeTaskLifecycleMigration: DatabaseMigration = {
  version: 100,
  name: "claude_task_lifecycle",
  sql: `CREATE TABLE claude_task_lifecycle_receipts (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    application_thread_id TEXT NOT NULL,
    native_session_id TEXT NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 512),
    native_task_id TEXT NOT NULL CHECK(length(native_task_id) BETWEEN 1 AND 512),
    native_tool_use_id TEXT NOT NULL CHECK(length(native_tool_use_id) BETWEEN 1 AND 512),
    description TEXT NOT NULL CHECK(length(description) <= 1024),
    started_at INTEGER NOT NULL CHECK(started_at >= 0),
    terminal_status TEXT CHECK(terminal_status IN ('completed', 'failed', 'stopped')),
    terminal_at INTEGER CHECK(terminal_at >= 0),
    PRIMARY KEY(tenant_id, owner_principal_id, application_thread_id, native_session_id, native_task_id, native_tool_use_id),
    FOREIGN KEY(tenant_id, owner_principal_id, application_thread_id)
      REFERENCES claude_thread_settings(tenant_id, owner_principal_id, application_thread_id) ON DELETE CASCADE
  ) STRICT;`,
};
