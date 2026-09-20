import type { DatabaseMigration } from "../migrate.js";

/** Principal/thread-owned pending questions; resolved rows retain only identity. */
export const questionRequestsMigration: DatabaseMigration = {
  version: 88,
  name: "question_requests",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE question_request_heads (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE question_requests (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  payload_json TEXT CHECK (payload_json IS NULL OR
    (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 49152)),
  PRIMARY KEY (tenant_id, principal_id, thread_id, id),
  UNIQUE (tenant_id, principal_id, thread_id, source_item_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX question_requests_pending ON question_requests(
  tenant_id, principal_id, thread_id, created_at, id
) WHERE payload_json IS NOT NULL;
`,
};
