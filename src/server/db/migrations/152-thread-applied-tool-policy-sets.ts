import type { DatabaseMigration } from "../migrate.js";

/** An association describes the current policy; historical creation labels do not. */
export const threadAppliedToolPolicySetsMigration: DatabaseMigration = {
  version: 152,
  name: "thread_applied_tool_policy_sets",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_applied_tool_policy_sets (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  policy_set_id TEXT NOT NULL CHECK(length(policy_set_id)=36
    AND substr(policy_set_id,9,1)='-' AND substr(policy_set_id,14,1)='-'
    AND substr(policy_set_id,19,1)='-' AND substr(policy_set_id,24,1)='-'
    AND length(replace(policy_set_id,'-',''))=32
    AND policy_set_id NOT GLOB '*[^0-9a-f-]*'),
  policy_set_name TEXT NOT NULL CHECK(length(policy_set_name) BETWEEN 1 AND 160),
  policy_set_revision INTEGER NOT NULL CHECK(policy_set_revision BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(tenant_id,owner_principal_id,thread_id),
  FOREIGN KEY(tenant_id,owner_principal_id,thread_id)
    REFERENCES application_threads(tenant_id,owner_principal_id,id) ON DELETE CASCADE
) STRICT;

-- Creation provenance can be retained only when the current policy is still
-- provably the same snapshot. Any update, unavailable definition, or mismatch
-- becomes Custom (no association), even if its old label looks plausible.
INSERT INTO thread_applied_tool_policy_sets(
  tenant_id,owner_principal_id,thread_id,
  policy_set_id,policy_set_name,policy_set_revision,updated_at
)
SELECT origin.tenant_id,origin.owner_principal_id,origin.thread_id,
  origin.policy_set_id,origin.policy_set_name,origin.policy_set_revision,origin.created_at
FROM thread_tool_policy_origins AS origin
JOIN thread_agent_tool_policies AS policy
  ON policy.tenant_id=origin.tenant_id AND policy.owner_principal_id=origin.owner_principal_id
  AND policy.application_thread_id=origin.thread_id
JOIN tool_policy_sets AS definition
  ON definition.tenant_id=origin.tenant_id AND definition.owner_principal_id=origin.owner_principal_id
  AND definition.id=origin.policy_set_id
  AND definition.name=origin.policy_set_name AND definition.revision=origin.policy_set_revision
WHERE policy.revision=0 AND policy.enabled=1
  AND json_extract(definition.resource_scope_json,'$.allowOtherEnvironments')=policy.allow_other_environments
  AND json_extract(definition.resource_scope_json,'$.allowOtherProjects')=policy.allow_other_projects
  AND json_array_length(definition.enabled_tool_ids_json)=(
    SELECT count(*) FROM thread_agent_tool_policy_entries AS entry
    WHERE entry.tenant_id=policy.tenant_id AND entry.owner_principal_id=policy.owner_principal_id
      AND entry.application_thread_id=policy.application_thread_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(definition.enabled_tool_ids_json) AS tool
    WHERE tool.type!='text' OR NOT EXISTS (
      SELECT 1 FROM thread_agent_tool_policy_entries AS entry
      WHERE entry.tenant_id=policy.tenant_id AND entry.owner_principal_id=policy.owner_principal_id
        AND entry.application_thread_id=policy.application_thread_id AND entry.tool_id=tool.value
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM thread_agent_tool_policy_entries AS entry
    WHERE entry.tenant_id=policy.tenant_id AND entry.owner_principal_id=policy.owner_principal_id
      AND entry.application_thread_id=policy.application_thread_id
      AND NOT EXISTS (
        SELECT 1 FROM json_each(definition.enabled_tool_ids_json) AS tool
        WHERE tool.type='text' AND tool.value=entry.tool_id
      )
  );

DROP TRIGGER thread_tool_policy_origins_immutable_update;
DROP TRIGGER thread_tool_policy_origins_immutable_delete;
DROP TABLE thread_tool_policy_origins;
`,
};
