export const piToolAccessAskMigration = {
  version: 19,
  name: "pi_tool_access_ask",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE pi_thread_settings RENAME TO pi_thread_settings_v18;

CREATE TABLE pi_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT CHECK (
    thinking_level IS NULL OR thinking_level IN (
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )
  ),
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('read_only', 'ask', 'full')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
) STRICT;

INSERT INTO pi_thread_settings(
  tenant_id, owner_principal_id, application_thread_id, model_provider,
  model_id, thinking_level, tool_mode, revision
)
SELECT
  tenant_id,
  owner_principal_id,
  application_thread_id,
  model_provider,
  model_id,
  thinking_level,
  tool_mode,
  revision
FROM pi_thread_settings_v18;

DROP TABLE pi_thread_settings_v18;
`,
} as const;
