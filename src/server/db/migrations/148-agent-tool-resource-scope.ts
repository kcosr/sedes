import type Database from "better-sqlite3";
import { z } from "zod";
import type { DatabaseMigration } from "../migrate.js";

// Frozen v147 bootstrap contract; old thread-only grants cannot safely expand
// to project scope, so they are retained disabled for explicit user review.
const legacyPolicy = z.strictObject({ enabled: z.boolean(), enabledToolIds: z.array(z.string()),
  presentation: z.strictObject({surface: z.enum(["native", "cli"]), mode: z.enum(["progressive", "individual"])}),
  accessBoundary: z.enum(["thread", "environment", "unrestricted"]),
});
function migrateSavedAgents(database: Database.Database): void {
  const rows = database.prepare("SELECT tenant_id, owner_principal_id, id, sedes_tools_json FROM saved_agents WHERE sedes_tools_json IS NOT NULL").all() as {tenant_id:string;owner_principal_id:string;id:string;sedes_tools_json:string}[];
  const update = database.prepare("UPDATE saved_agents SET sedes_tools_json=? WHERE tenant_id=? AND owner_principal_id=? AND id=?");
  for (const row of rows) {
    const {accessBoundary, ...policy} = legacyPolicy.parse(JSON.parse(row.sedes_tools_json));
    const migrated = {...policy, enabled: policy.enabled && accessBoundary !== "thread", resourceScope: {
      allowOtherEnvironments: accessBoundary === "unrestricted", allowOtherProjects: accessBoundary !== "thread",
    }};
    update.run(JSON.stringify(migrated), row.tenant_id, row.owner_principal_id, row.id);
  }
}
export const agentToolResourceScopeMigration: DatabaseMigration = {
  version: 148, name: "agent_tool_resource_scope", preflight: migrateSavedAgents,
  sql: `
DROP TRIGGER application_threads_agent_tool_policy_insert;
ALTER TABLE thread_agent_tool_policies ADD COLUMN allow_other_environments INTEGER NOT NULL DEFAULT 0 CHECK(allow_other_environments IN (0,1));
ALTER TABLE thread_agent_tool_policies ADD COLUMN allow_other_projects INTEGER NOT NULL DEFAULT 0 CHECK(allow_other_projects IN (0,1));
UPDATE thread_agent_tool_policies SET
  enabled = CASE WHEN access_boundary='thread' THEN 0 ELSE enabled END,
  allow_other_environments = CASE WHEN access_boundary='unrestricted' THEN 1 ELSE 0 END,
  allow_other_projects = CASE WHEN access_boundary='thread' THEN 0 ELSE 1 END;
ALTER TABLE thread_agent_tool_policies DROP COLUMN access_boundary;
CREATE TRIGGER application_threads_agent_tool_policy_insert AFTER INSERT ON application_threads BEGIN
  INSERT INTO thread_agent_tool_policies(tenant_id,owner_principal_id,application_thread_id,enabled,
    presentation_surface,presentation_mode,allow_other_environments,allow_other_projects,revision,updated_at)
  SELECT NEW.tenant_id,NEW.owner_principal_id,NEW.id,0,
    CASE WHEN backend.kind IN ('pi','codex_app_server','claude_agent_sdk','opencode') THEN 'native' ELSE 'cli' END,
    CASE WHEN backend.kind IN ('codex_app_server','claude_agent_sdk') THEN 'individual' ELSE 'progressive' END,
    0,0,0,NEW.updated_at
  FROM agent_backend_instances AS backend WHERE backend.tenant_id=NEW.tenant_id AND backend.id=NEW.backend_instance_id;
END;
`,
};
