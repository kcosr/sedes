import type { DatabaseMigration } from "../migrate.js";

/** Preserve original question positions while resolving individual answers. */
export const questionResponseStateMigration: DatabaseMigration = {
  version: 89,
  name: "question_response_state",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE question_requests_indexed (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  payload_json TEXT CHECK (payload_json IS NULL OR
    (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 49232)),
  PRIMARY KEY (tenant_id, principal_id, thread_id, id),
  UNIQUE (tenant_id, principal_id, thread_id, source_item_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT;
INSERT INTO question_requests_indexed
  (tenant_id, principal_id, thread_id, id, source_item_id, created_at, payload_json)
SELECT tenant_id, principal_id, thread_id, id, source_item_id, created_at,
  CASE WHEN payload_json IS NULL THEN NULL ELSE json_object('questions', json((
    SELECT json_group_array(json_set(value, '$.index', CAST(key AS INTEGER)))
    FROM json_each(question_requests.payload_json, '$.questions')
  ))) END
FROM question_requests ORDER BY rowid;
DROP TABLE question_requests;
ALTER TABLE question_requests_indexed RENAME TO question_requests;
CREATE INDEX question_requests_pending ON question_requests(
  tenant_id, principal_id, thread_id, created_at, id
) WHERE payload_json IS NOT NULL;
ALTER TABLE queued_inputs ADD COLUMN question_response_origin_json TEXT
  CHECK (question_response_origin_json IS NULL OR json_valid(question_response_origin_json));
`,
};
