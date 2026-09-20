import type { DatabaseMigration } from "../migrate.js";

/**
 * Immutable creation provenance for threads configured from a Saved Agent.
 * The Agent reference is intentionally not a foreign key: deleting an Agent
 * must not erase or invalidate the thread's captured origin.
 */
export const threadSavedAgentOriginsMigration: DatabaseMigration = {
  version: 75,
  name: "thread_saved_agent_origins",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_saved_agent_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (
    length(agent_id) = 36
    AND substr(agent_id, 9, 1) = '-'
    AND substr(agent_id, 14, 1) = '-'
    AND substr(agent_id, 19, 1) = '-'
    AND substr(agent_id, 24, 1) = '-'
    AND length(replace(agent_id, '-', '')) = 32
    AND agent_id NOT GLOB '*[^0-9a-f-]*'
  ),
  agent_revision INTEGER NOT NULL CHECK (
    agent_revision BETWEEN 0 AND 9007199254740991
  ),
  agent_name TEXT NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX thread_saved_agent_origins_by_agent
  ON thread_saved_agent_origins(
    tenant_id, owner_principal_id, agent_id, thread_id
  );

CREATE TRIGGER thread_saved_agent_origins_immutable_update
BEFORE UPDATE ON thread_saved_agent_origins
BEGIN
  SELECT RAISE(ABORT, 'Thread Saved Agent origins are immutable');
END;

CREATE TRIGGER thread_saved_agent_origins_immutable_delete
BEFORE DELETE ON thread_saved_agent_origins
WHEN EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id = OLD.tenant_id
    AND thread.owner_principal_id = OLD.owner_principal_id
    AND thread.id = OLD.thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Thread Saved Agent origins are immutable');
END;
`,
};
