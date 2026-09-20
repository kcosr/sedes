export const connectionSettingPreferencesMigration = {
  version: 11,
  name: "connection_setting_preferences",
  sql: `
CREATE TABLE agent_connection_setting_preferences (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL
    CHECK (length(connection_profile_id) BETWEEN 1 AND 128),
  setting_id TEXT NOT NULL CHECK (
    setting_id IN ('model', 'thinking_level', 'tool_access')
  ),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (
    tenant_id, owner_principal_id, connection_profile_id, setting_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
} as const;
