import type { DatabaseMigration } from "../migrate.js";

export const openCodeObservationCursorsMigration: DatabaseMigration = {
  version: 125, name: "opencode_observation_cursors", sql: `
CREATE TABLE opencode_observation_cursors (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  native_namespace_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  binding_fingerprint TEXT NOT NULL,
  authority_fingerprint TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  native_generation TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  native_continuity TEXT NOT NULL,
  PRIMARY KEY (tenant_id,owner_principal_id,application_thread_id,native_namespace_key,native_session_id,binding_fingerprint),
  FOREIGN KEY (tenant_id,owner_principal_id,application_thread_id)
    REFERENCES application_threads (tenant_id,owner_principal_id,id) ON DELETE CASCADE
) STRICT;
`,
};
