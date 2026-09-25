import type { DatabaseMigration } from "../migrate.js";

/**
 * New Codex and Claude threads default to Native/Individual agent-tool
 * presentation through the `sedes mcp` server. Pi keeps Native/Progressive and
 * Grok keeps CLI/Progressive. Existing thread policies are unchanged.
 */
export const nativeMcpAgentToolDefaultsMigration: DatabaseMigration = {
  version: 115,
  name: "native_mcp_agent_tool_defaults",
  sql: `
DROP TRIGGER application_threads_agent_tool_policy_insert;

CREATE TRIGGER application_threads_agent_tool_policy_insert
AFTER INSERT ON application_threads
BEGIN
  INSERT INTO thread_agent_tool_policies(
    tenant_id, owner_principal_id, application_thread_id, enabled,
    presentation_surface, presentation_mode, access_boundary,
    revision, updated_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id, NEW.id, 0,
    CASE WHEN backend.kind IN ('pi', 'codex_app_server', 'claude_agent_sdk')
      THEN 'native' ELSE 'cli' END,
    CASE WHEN backend.kind IN ('codex_app_server', 'claude_agent_sdk')
      THEN 'individual' ELSE 'progressive' END,
    'environment', 0, NEW.updated_at
  FROM agent_backend_instances AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.id = NEW.backend_instance_id;
END;
`,
};
