import type { DatabaseMigration } from "../migrate.js";

/** Removes the superseded T0 execution/run/grant/invocation authority only. */
export const removeAgentExecutionLifecycleMigration: DatabaseMigration = {
  version: 29,
  name: "remove-agent-execution-lifecycle",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
DROP TABLE IF EXISTS agent_tool_invocations;
DROP TABLE IF EXISTS agent_capability_entries;
DROP TABLE IF EXISTS agent_capability_grants;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agent_executions;
`,
};
