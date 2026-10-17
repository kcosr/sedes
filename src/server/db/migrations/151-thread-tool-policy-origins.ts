import type { DatabaseMigration } from "../migrate.js";

/** Historical references deliberately survive deletion of a reusable policy set. */
export const threadToolPolicyOriginsMigration: DatabaseMigration = {
  version: 151,
  name: "thread_tool_policy_origins",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_tool_policy_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('default','account','environment','backend','agent','thread')),
  policy_set_id TEXT,
  policy_set_name TEXT,
  policy_set_revision INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(tenant_id,owner_principal_id,thread_id),
  FOREIGN KEY(tenant_id,owner_principal_id,thread_id)
    REFERENCES application_threads(tenant_id,owner_principal_id,id) ON DELETE CASCADE,
  CHECK((policy_set_id IS NULL AND policy_set_name IS NULL AND policy_set_revision IS NULL)
    OR (policy_set_id IS NOT NULL AND policy_set_name IS NOT NULL AND policy_set_revision IS NOT NULL
      AND length(policy_set_id)=36 AND substr(policy_set_id,9,1)='-'
      AND substr(policy_set_id,14,1)='-' AND substr(policy_set_id,19,1)='-'
      AND substr(policy_set_id,24,1)='-' AND length(replace(policy_set_id,'-',''))=32
      AND policy_set_id NOT GLOB '*[^0-9a-f-]*'
      AND length(policy_set_name) BETWEEN 1 AND 160
      AND policy_set_revision BETWEEN 0 AND 9007199254740991))
) STRICT;
CREATE TRIGGER thread_tool_policy_origins_immutable_update
BEFORE UPDATE ON thread_tool_policy_origins
BEGIN SELECT RAISE(ABORT, 'Thread tool policy origins are immutable'); END;
CREATE TRIGGER thread_tool_policy_origins_immutable_delete
BEFORE DELETE ON thread_tool_policy_origins
WHEN EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id=OLD.tenant_id AND thread.owner_principal_id=OLD.owner_principal_id
    AND thread.id=OLD.thread_id
)
BEGIN SELECT RAISE(ABORT, 'Thread tool policy origins are immutable'); END;
`,
};
