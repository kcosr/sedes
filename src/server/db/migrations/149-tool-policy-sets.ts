import type { DatabaseMigration } from "../migrate.js";

/** Policies and their selections are principal application state, not runtime configuration. */
export const toolPolicySetsMigration: DatabaseMigration = {
  version: 149,
  name: "tool_policy_sets",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE tool_policy_sets (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  enabled_tool_ids_json TEXT NOT NULL CHECK(json_valid(enabled_tool_ids_json) AND json_type(enabled_tool_ids_json) = 'array' AND json_array_length(enabled_tool_ids_json) <= 512 AND length(CAST(enabled_tool_ids_json AS BLOB)) <= 131072),
  resource_scope_json TEXT NOT NULL CHECK(json_valid(resource_scope_json) AND length(CAST(resource_scope_json AS BLOB)) <= 256),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY(tenant_id, owner_principal_id, id),
  FOREIGN KEY(tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tool_policy_selections (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('account','environment','backend')),
  target_id TEXT NOT NULL CHECK(length(target_id) <= 160),
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND length(CAST(selection_json AS BLOB)) <= 512),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(tenant_id, owner_principal_id, target_kind, target_id),
  FOREIGN KEY(tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE CASCADE,
  CHECK(target_kind != 'account' OR target_id = '')
) STRICT;
ALTER TABLE saved_agents ADD COLUMN tool_policy_selection_json TEXT NOT NULL DEFAULT '{"kind":"inherit"}' CHECK(json_valid(tool_policy_selection_json));
ALTER TABLE saved_agents ADD COLUMN tool_presentation_json TEXT CHECK(tool_presentation_json IS NULL OR json_valid(tool_presentation_json));
INSERT INTO tool_policy_sets(tenant_id,owner_principal_id,id,name,enabled_tool_ids_json,resource_scope_json,revision,created_at,updated_at)
SELECT tenant_id,owner_principal_id,id,name,json_extract(sedes_tools_json,'$.enabledToolIds'),json_extract(sedes_tools_json,'$.resourceScope'),0,created_at,updated_at
FROM saved_agents WHERE sedes_tools_json IS NOT NULL;
UPDATE saved_agents SET tool_policy_selection_json = CASE
 WHEN json_extract(sedes_tools_json,'$.enabled') = 1 THEN json_object('kind','policy_set','policySetId',id)
 ELSE '{"kind":"disabled"}' END,
 tool_presentation_json = json_extract(sedes_tools_json,'$.presentation')
WHERE sedes_tools_json IS NOT NULL;
ALTER TABLE saved_agents DROP COLUMN sedes_tools_json;
`,
};
