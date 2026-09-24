import type { DatabaseMigration } from "../migrate.js";

export const usageSubagentRecoveryIndexesMigration: DatabaseMigration = {
  version: 114,
  name: "usage_subagent_recovery_indexes",
  sql: `
CREATE INDEX usage_sources_subagent_recovery
  ON usage_sources(tenant_id, principal_id, backend_id, environment_id, native_namespace, thread_id, native_session)
  WHERE agent_role='subagent' AND capture_state IN ('active','disconnected','failed');
CREATE INDEX usage_sources_subagent_identity
  ON usage_sources(tenant_id, principal_id, backend_id, environment_id, native_namespace, native_session, thread_id)
  WHERE agent_role='subagent';
`,
};
