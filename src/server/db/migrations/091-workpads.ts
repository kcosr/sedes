import type { DatabaseMigration } from "../migrate.js";

/** Workpads and drafts belong to the authenticated tenant/principal. */
export const workpadsMigration: DatabaseMigration = {
  version: 91,
  name: "workpads",
  sql: `
CREATE TABLE workpads (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','workspace','thread')),
  workspace_id TEXT, thread_id TEXT, title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  PRIMARY KEY(tenant_id, owner_principal_id, id),
  FOREIGN KEY(tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id) ON DELETE CASCADE,
  CHECK((scope_kind='global' AND workspace_id IS NULL AND thread_id IS NULL) OR
    (scope_kind='workspace' AND workspace_id IS NOT NULL AND thread_id IS NULL) OR
    (scope_kind='thread' AND workspace_id IS NULL AND thread_id IS NOT NULL))
);
CREATE INDEX workpads_scope ON workpads(tenant_id, owner_principal_id, scope_kind, workspace_id, thread_id, archived_at, updated_at DESC, id);
CREATE TABLE workpad_revisions (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, workpad_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  PRIMARY KEY(tenant_id, owner_principal_id, workpad_id, revision),
  FOREIGN KEY(tenant_id, owner_principal_id, workpad_id) REFERENCES workpads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
);
CREATE TABLE workpad_drafts (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, workpad_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  content TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, owner_principal_id, workpad_id),
  FOREIGN KEY(tenant_id, owner_principal_id, workpad_id) REFERENCES workpads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
);
`,
};
