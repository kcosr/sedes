import type { DatabaseMigration } from "../migrate.js";

export const blockingRequestObservationsMigration: DatabaseMigration = {
  version: 176,
  name: "blocking_request_observations",
  sql: `
-- Receipts contain only an opaque digest. Keep them until thread deletion because
-- retained provider requests can replay after arbitrarily long disconnects.
CREATE TABLE blocking_request_observations (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_identity TEXT NOT NULL CHECK (length(request_identity) = 43),
  PRIMARY KEY (tenant_id, principal_id, thread_id, request_identity),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
`,
};
