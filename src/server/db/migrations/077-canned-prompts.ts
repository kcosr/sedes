import type { DatabaseMigration } from "../migrate.js";

/** One ordered, principal-owned canned-prompt library shared by all clients. */
export const cannedPromptsMigration: DatabaseMigration = {
  version: 77,
  name: "canned_prompts",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE canned_prompt_collections (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (
    revision BETWEEN 0 AND 9007199254740991
  ),
  updated_at INTEGER NOT NULL CHECK (
    updated_at BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE canned_prompts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND lower(id) NOT GLOB '*[^0-9a-f-]*'
    AND (
      lower(id) = '00000000-0000-0000-0000-000000000000'
      OR (
        substr(lower(id), 15, 1) GLOB '[1-8]'
        AND substr(lower(id), 20, 1) GLOB '[89ab]'
      )
    )
  ),
  title TEXT NOT NULL CHECK (
    length(title) BETWEEN 1 AND 120
    AND length(replace(replace(replace(replace(
      title, ' ', ''), char(9), ''), char(10), ''), char(13), '')) >= 1
    AND length(CAST(title AS BLOB)) <= 480
  ),
  prompt_text TEXT NOT NULL CHECK (
    length(prompt_text) >= 1
    AND length(replace(replace(replace(replace(
      prompt_text, ' ', ''), char(9), ''), char(10), ''), char(13), '')) >= 1
    AND length(CAST(prompt_text AS BLOB)) <= 8192
  ),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 31),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 9007199254740991
  ),
  updated_at INTEGER NOT NULL CHECK (
    updated_at BETWEEN created_at AND 9007199254740991
  ),
  PRIMARY KEY (tenant_id, principal_id, id),
  UNIQUE (tenant_id, principal_id, position),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES canned_prompt_collections(tenant_id, principal_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX canned_prompts_in_order
  ON canned_prompts(tenant_id, principal_id, position, id);

CREATE TRIGGER canned_prompts_capacity
BEFORE INSERT ON canned_prompts
WHEN NOT EXISTS (
  SELECT 1 FROM canned_prompts AS same_prompt
  WHERE same_prompt.tenant_id = NEW.tenant_id
    AND same_prompt.principal_id = NEW.principal_id
    AND same_prompt.id = NEW.id
) AND (
  SELECT count(*) FROM canned_prompts AS existing
  WHERE existing.tenant_id = NEW.tenant_id
    AND existing.principal_id = NEW.principal_id
) >= 32
BEGIN
  SELECT RAISE(ABORT, 'canned_prompt_limit_reached');
END;

CREATE TABLE canned_prompt_mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (
    length(mutation_id) = 36
    AND substr(mutation_id, 9, 1) = '-'
    AND substr(mutation_id, 14, 1) = '-'
    AND substr(mutation_id, 19, 1) = '-'
    AND substr(mutation_id, 24, 1) = '-'
    AND length(replace(mutation_id, '-', '')) = 32
    AND lower(mutation_id) NOT GLOB '*[^0-9a-f-]*'
    AND (
      lower(mutation_id) = '00000000-0000-0000-0000-000000000000'
      OR (
        substr(lower(mutation_id), 15, 1) GLOB '[1-8]'
        AND substr(lower(mutation_id), 20, 1) GLOB '[89ab]'
      )
    )
  ),
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN ('create', 'update', 'delete', 'reorder')
  ),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND json_type(result_json) = 'object'
    AND length(CAST(result_json AS BLOB)) <= 2097152
  ),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES canned_prompt_collections(tenant_id, principal_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX canned_prompt_mutation_receipts_created
  ON canned_prompt_mutation_receipts(
    tenant_id, principal_id, created_at, mutation_id
  );
`,
};
