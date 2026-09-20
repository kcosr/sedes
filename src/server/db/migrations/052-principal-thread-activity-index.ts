import type { DatabaseMigration } from "../migrate.js";

/** Supports principal-global thread discovery in fixed recency order. */
export const principalThreadActivityIndexMigration: DatabaseMigration = {
  version: 52,
  name: "principal-thread-activity-index",
  sql: `
CREATE INDEX application_threads_principal_activity
  ON application_threads(
    tenant_id, owner_principal_id, last_activity_at DESC, id
  );
CREATE INDEX workspaces_principal_last_opened
  ON workspaces(
    tenant_id, owner_principal_id, last_opened_at DESC, id
  );
`,
};
