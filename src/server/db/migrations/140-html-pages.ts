import type { DatabaseMigration } from "../migrate.js";

export const htmlPagesMigration: DatabaseMigration = {
  version: 140, name: "html-pages", verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE html_pages (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  id TEXT NOT NULL, current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(tenant_id, owner_principal_id, thread_id, id),
  FOREIGN KEY(tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX html_pages_created ON html_pages(tenant_id, owner_principal_id, thread_id, created_at DESC, id DESC);
CREATE TABLE html_page_revisions (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  page_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
  invocation_id TEXT NOT NULL, anchor_turn_id TEXT,
  anchor_json TEXT CHECK(anchor_json IS NULL OR json_valid(anchor_json)),
  bootstrap_offset INTEGER NOT NULL CHECK(bootstrap_offset BETWEEN 0 AND 33554432),
  source_path TEXT, source_html TEXT NOT NULL, escaped_html TEXT NOT NULL,
  PRIMARY KEY(tenant_id, owner_principal_id, thread_id, page_id, revision),
  UNIQUE(tenant_id, owner_principal_id, thread_id, invocation_id),
  FOREIGN KEY(tenant_id, owner_principal_id, thread_id, page_id)
    REFERENCES html_pages(tenant_id, owner_principal_id, thread_id, id) ON DELETE CASCADE,
  CHECK((anchor_json IS NULL AND anchor_turn_id IS NULL) OR
    (anchor_json IS NOT NULL AND anchor_turn_id IS NOT NULL AND
      json_type(anchor_json, '$.turnId') IS 'text' AND json_extract(anchor_json, '$.turnId') = anchor_turn_id))
) STRICT;
CREATE INDEX html_page_revision_turn ON html_page_revisions(tenant_id, owner_principal_id, thread_id, anchor_turn_id);
CREATE TRIGGER html_page_revisions_immutable BEFORE UPDATE ON html_page_revisions
BEGIN SELECT RAISE(ABORT, 'HTML page revisions are immutable'); END;
`,
};
