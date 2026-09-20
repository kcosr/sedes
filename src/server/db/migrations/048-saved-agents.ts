import type { DatabaseMigration } from "../migrate.js";

/** Principal-owned reusable SavedAgent definitions. */
export const savedAgentsMigration: DatabaseMigration = {
  version: 48,
  name: "saved_agents",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE saved_agents (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4096),
  backend_type_id TEXT NOT NULL CHECK (
    length(backend_type_id) BETWEEN 1 AND 128
    AND backend_type_id GLOB '[a-z]*'
    AND backend_type_id NOT GLOB '*[^a-z0-9_.-]*'
  ),
  backend_overrides_schema_version INTEGER NOT NULL CHECK (
    backend_overrides_schema_version BETWEEN 1 AND 9007199254740991
  ),
  backend_overrides_json TEXT NOT NULL CHECK (
    json_valid(backend_overrides_json)
    AND json_type(backend_overrides_json) = 'array'
    AND json_array_length(backend_overrides_json) <= 32
    AND length(CAST(backend_overrides_json AS BLOB)) <= 32768
  ),
  harness_tools_json TEXT CHECK (
    harness_tools_json IS NULL
    OR (
      json_valid(harness_tools_json)
      AND json_type(harness_tools_json) = 'object'
      AND length(CAST(harness_tools_json AS BLOB)) <= 131072
    )
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (
    revision BETWEEN 0 AND 9007199254740991
  ),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 8640000000000000
  ),
  updated_at INTEGER NOT NULL CHECK (
    updated_at BETWEEN created_at AND 8640000000000000
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX saved_agents_by_name
  ON saved_agents(
    tenant_id, owner_principal_id, lower(name), name, id
  );
CREATE INDEX saved_agents_by_backend
  ON saved_agents(
    tenant_id, owner_principal_id, backend_type_id, lower(name), name, id
  );
`,
};
