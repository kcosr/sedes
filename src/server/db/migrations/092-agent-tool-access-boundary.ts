import type Database from "better-sqlite3";
import { z } from "zod";
import type { DatabaseMigration } from "../migrate.js";

// This schema is intentionally frozen to the version-91 durable contract.
const legacyPolicySchema = z.strictObject({
  enabled: z.boolean(),
  enabledToolIds: z.array(z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(128)).max(512),
  presentation: z.strictObject({
    surface: z.enum(["native", "cli"]),
    mode: z.enum(["progressive", "individual"]),
  }),
  environmentAccess: z.strictObject({ otherEnvironments: z.enum(["ask", "allow"]) }),
});

function migrateSavedAgentPolicies(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT tenant_id AS tenantId, owner_principal_id AS principalId,
      id, sedes_tools_json AS policyJson FROM saved_agents
    WHERE sedes_tools_json IS NOT NULL
  `).all() as { tenantId: string; principalId: string; id: string; policyJson: string }[];
  const update = database.prepare(`UPDATE saved_agents SET sedes_tools_json = ?
    WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`);
  for (const row of rows) {
    const parsed = legacyPolicySchema.parse(JSON.parse(row.policyJson));
    const canonical = {
      enabled: parsed.enabled,
      enabledToolIds: [...parsed.enabledToolIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      presentation: parsed.presentation,
      environmentAccess: parsed.environmentAccess,
    };
    if (new Set(parsed.enabledToolIds).size !== parsed.enabledToolIds.length ||
        JSON.stringify(canonical) !== row.policyJson) {
      throw new Error("saved_agent_durable_state_invalid");
    }
    const migrated = {
      enabled: canonical.enabled,
      enabledToolIds: canonical.enabledToolIds,
      presentation: canonical.presentation,
      accessBoundary: canonical.environmentAccess.otherEnvironments === "ask" ? "environment" : "unrestricted",
    };
    if (update.run(JSON.stringify(migrated), row.tenantId, row.principalId, row.id).changes !== 1) {
      throw new Error("saved_agent_policy_migration_write_failed");
    }
  }
}

export const agentToolAccessBoundaryMigration: DatabaseMigration = {
  version: 92,
  name: "agent_tool_access_boundary",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  preflight: migrateSavedAgentPolicies,
  sql: `
DROP TRIGGER application_threads_agent_tool_policy_insert;

ALTER TABLE thread_agent_tool_policies
  RENAME TO thread_agent_tool_policies_v91;
ALTER TABLE thread_agent_tool_policy_entries
  RENAME TO thread_agent_tool_policy_entries_v91;

CREATE TABLE thread_agent_tool_policies (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  presentation_surface TEXT NOT NULL CHECK (
    presentation_surface IN ('native', 'cli')
  ),
  presentation_mode TEXT NOT NULL CHECK (
    presentation_mode IN ('progressive', 'individual')
  ),
  access_boundary TEXT NOT NULL CHECK (
    access_boundary IN ('thread', 'environment', 'unrestricted')
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
  tenant_id, owner_principal_id, application_thread_id, enabled,
  presentation_surface, presentation_mode, access_boundary,
  revision, updated_at
)
SELECT tenant_id, owner_principal_id, application_thread_id, enabled,
  presentation_surface, presentation_mode,
  CASE other_environment_access WHEN 'ask' THEN 'environment' ELSE 'unrestricted' END,
  revision, updated_at
FROM thread_agent_tool_policies_v91;

INSERT INTO thread_agent_tool_policy_entries(
  tenant_id, owner_principal_id, application_thread_id, tool_id
)
SELECT tenant_id, owner_principal_id, application_thread_id, tool_id
FROM thread_agent_tool_policy_entries_v91;

DROP TABLE thread_agent_tool_policy_entries_v91;
DROP TABLE thread_agent_tool_policies_v91;

CREATE TRIGGER application_threads_agent_tool_policy_insert
AFTER INSERT ON application_threads
BEGIN
  INSERT INTO thread_agent_tool_policies(
    tenant_id, owner_principal_id, application_thread_id, enabled,
    presentation_surface, presentation_mode, access_boundary,
    revision, updated_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id, NEW.id, 0,
    CASE WHEN backend.kind = 'pi' THEN 'native' ELSE 'cli' END,
    'progressive', 'environment', 0, NEW.updated_at
  FROM agent_backend_instances AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.id = NEW.backend_instance_id;
END;
`,
};
