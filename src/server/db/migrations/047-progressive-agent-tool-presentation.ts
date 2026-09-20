import type { DatabaseMigration } from "../migrate.js";

/**
 * Preserves existing Pi policies as individual native tools while making the
 * progressively disclosed native surface the latent default for new Pi
 * threads. The old `native` value is migrated once and is not accepted by the
 * current repository or protocol.
 */
export const progressiveAgentToolPresentationMigration: DatabaseMigration = {
  version: 47,
  name: "progressive-agent-tool-presentation",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER application_threads_agent_tool_policy_insert;

ALTER TABLE thread_agent_tool_policies
  RENAME TO thread_agent_tool_policies_v45;
ALTER TABLE thread_agent_tool_policy_entries
  RENAME TO thread_agent_tool_policy_entries_v45;

CREATE TABLE thread_agent_tool_policies (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  presentation_mode TEXT NOT NULL CHECK (
    presentation_mode IN ('cli', 'native_progressive', 'native_individual')
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

INSERT INTO thread_agent_tool_policies(
  tenant_id, owner_principal_id, application_thread_id,
  enabled, presentation_mode, revision, updated_at
)
SELECT
  tenant_id,
  owner_principal_id,
  application_thread_id,
  enabled,
  CASE presentation_mode
    WHEN 'native' THEN 'native_individual'
    ELSE 'cli'
  END,
  revision,
  updated_at
FROM thread_agent_tool_policies_v45;

INSERT INTO thread_agent_tool_policy_entries(
  tenant_id, owner_principal_id, application_thread_id, tool_id
)
SELECT tenant_id, owner_principal_id, application_thread_id, tool_id
FROM thread_agent_tool_policy_entries_v45;

DROP TABLE thread_agent_tool_policy_entries_v45;
DROP TABLE thread_agent_tool_policies_v45;

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
    CASE
      WHEN backend.kind = 'pi' THEN 'native_progressive'
      ELSE 'cli'
    END,
    0,
    NEW.updated_at
  FROM agent_backend_instances AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.id = NEW.backend_instance_id;
END;
`,
};
