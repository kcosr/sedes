export const principalApplicationPreferencesMigration = {
  version: 46,
  name: "principal_application_preferences",
  sql: `
CREATE TABLE principal_application_preferences (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  show_openai_composer_skills INTEGER NOT NULL CHECK (
    show_openai_composer_skills IN (0, 1)
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
} as const;
