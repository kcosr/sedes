import type { DatabaseMigration } from "../migrate.js";

/** Native input identities and observed receiving turns, scoped to their owner. */
export const claudeSteerOperationsMigration: DatabaseMigration = {
  version: 102,
  name: "claude_steer_operations",
  sql: `CREATE TABLE claude_steer_operations (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    application_thread_id TEXT NOT NULL,
    application_operation_id TEXT NOT NULL,
    native_turn_root_uuid TEXT,
    PRIMARY KEY(tenant_id, owner_principal_id, application_thread_id, application_operation_id),
    FOREIGN KEY(tenant_id, owner_principal_id, application_thread_id)
      REFERENCES claude_thread_settings(tenant_id, owner_principal_id, application_thread_id) ON DELETE CASCADE
  ) STRICT;`,
};
