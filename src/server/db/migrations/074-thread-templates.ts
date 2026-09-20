import type { DatabaseMigration } from "../migrate.js";

/** Principal-owned named recipes for creating threads from Saved Agents. */
export const threadTemplatesMigration: DatabaseMigration = {
  version: 74,
  name: "thread_templates",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_templates (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  workspace_id TEXT NOT NULL CHECK (
    length(workspace_id) = 36
    AND substr(workspace_id, 9, 1) = '-'
    AND substr(workspace_id, 14, 1) = '-'
    AND substr(workspace_id, 19, 1) = '-'
    AND substr(workspace_id, 24, 1) = '-'
    AND length(replace(workspace_id, '-', '')) = 32
    AND workspace_id NOT GLOB '*[^0-9a-f-]*'
  ),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 160),
  execution_workspace_json TEXT NOT NULL CHECK (
    json_valid(execution_workspace_json)
    AND json_type(execution_workspace_json) = 'object'
    AND length(CAST(execution_workspace_json AS BLOB)) <= 1024
  ),
  agent_id TEXT NOT NULL CHECK (
    length(agent_id) = 36
    AND substr(agent_id, 9, 1) = '-'
    AND substr(agent_id, 14, 1) = '-'
    AND substr(agent_id, 19, 1) = '-'
    AND substr(agent_id, 24, 1) = '-'
    AND length(replace(agent_id, '-', '')) = 32
    AND agent_id NOT GLOB '*[^0-9a-f-]*'
  ),
  captured_agent_name TEXT NOT NULL CHECK (
    length(captured_agent_name) BETWEEN 1 AND 160
  ),
  captured_workspace_name TEXT NOT NULL CHECK (
    length(captured_workspace_name) BETWEEN 1 AND 240
  ),
  captured_target_name TEXT NOT NULL CHECK (
    length(captured_target_name) BETWEEN 1 AND 120
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (
    revision BETWEEN 0 AND 9007199254740991
  ),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 8640000000000000
  ),
  updated_at INTEGER NOT NULL CHECK (
    updated_at BETWEEN created_at AND 8640000000000000
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX thread_templates_by_name
  ON thread_templates(
    tenant_id, owner_principal_id, lower(name), name, id
  );
`,
};
