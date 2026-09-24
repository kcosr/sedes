import type { DatabaseMigration } from "../migrate.js";

export const usageSubagentsMigration: DatabaseMigration = {
  version: 112,
  name: "usage_subagents",
  sql: `
CREATE TABLE usage_subagents (
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  backend_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  native_namespace TEXT NOT NULL, native_session TEXT NOT NULL, native_parent_session TEXT NOT NULL,
  root_native_session TEXT NOT NULL,
  CHECK(native_session <> native_parent_session AND native_session <> root_native_session),
  PRIMARY KEY(tenant_id, principal_id, backend_id, environment_id, native_namespace, native_session),
  FOREIGN KEY(tenant_id, principal_id, thread_id)
    REFERENCES usage_thread_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX usage_subagents_root ON usage_subagents(tenant_id, principal_id, thread_id);
CREATE UNIQUE INDEX usage_subagents_native_owner ON usage_subagents(tenant_id, backend_id, environment_id, native_namespace, native_session);
ALTER TABLE usage_sources ADD COLUMN agent_role TEXT NOT NULL DEFAULT 'main'
  CHECK(agent_role IN ('main', 'subagent'));
UPDATE usage_thread_state SET report_json=NULL;
UPDATE usage_turn_state SET report_json=NULL;
`,
};
