import type { DatabaseMigration } from "../migrate.js";

/** Renames the Saved Agent policy column without rewriting its canonical JSON. */
export const renameSavedAgentToolsMigration: DatabaseMigration = {
  version: 79,
  name: "rename_saved_agent_tools",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE saved_agents
  RENAME COLUMN harness_tools_json TO sedes_tools_json;
`,
};
