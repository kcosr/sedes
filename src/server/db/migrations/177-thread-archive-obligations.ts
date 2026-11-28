import type { DatabaseMigration } from "../migrate.js";

export const threadArchiveObligationsMigration: DatabaseMigration = {
  version: 177,
  name: "thread_archive_obligations",
  sql: `
CREATE TABLE thread_archive_obligations (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  evidence_token TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  retained_owner TEXT CHECK (retained_owner IS NULL OR length(retained_owner) BETWEEN 1 AND 4096),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
`,
};
