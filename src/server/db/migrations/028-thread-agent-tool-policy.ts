import type { DatabaseMigration } from "../migrate.js";

/**
 * Principal/thread-owned exposure policy for Sedes agent tools. Tool
 * definitions remain code-owned; the entry table stores only the explicitly
 * enabled IDs, so adding a definition never exposes it to an existing thread.
 */
export const threadAgentToolPolicyMigration: DatabaseMigration = {
  version: 28,
  name: "thread-agent-tool-policy",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_agent_tool_policies (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  presentation_mode TEXT NOT NULL CHECK (
    presentation_mode IN ('cli', 'native')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE thread_agent_tool_policy_entries (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  tool_id TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 128),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, tool_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES thread_agent_tool_policies(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER application_threads_agent_tool_policy_insert
AFTER INSERT ON application_threads
BEGIN
  INSERT INTO thread_agent_tool_policies(
    tenant_id, owner_principal_id, application_thread_id,
    enabled, presentation_mode, revision, updated_at
  )
  SELECT
    NEW.tenant_id,
    NEW.owner_principal_id,
    NEW.id,
    0,
    CASE WHEN backend.kind = 'pi' THEN 'native' ELSE 'cli' END,
    0,
    NEW.updated_at
  FROM agent_backend_instances AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.id = NEW.backend_instance_id;
END;

INSERT INTO thread_agent_tool_policies(
  tenant_id, owner_principal_id, application_thread_id,
  enabled, presentation_mode, revision, updated_at
)
SELECT
  thread.tenant_id,
  thread.owner_principal_id,
  thread.id,
  0,
  CASE WHEN backend.kind = 'pi' THEN 'native' ELSE 'cli' END,
  0,
  thread.updated_at
FROM application_threads AS thread
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = thread.tenant_id
  AND backend.id = thread.backend_instance_id;
`,
};
