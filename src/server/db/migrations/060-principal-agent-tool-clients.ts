import type { DatabaseMigration } from "../migrate.js";

/**
 * Durable, principal-owned agent-tool clients. Plaintext credentials are never
 * persisted: the client row contains only a generation-bound keyed verifier.
 * The tables are intentionally unreachable until the protocol-48 cutover.
 */
export const principalAgentToolClientsMigration: DatabaseMigration = {
  version: 60,
  name: "principal_agent_tool_clients",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE UNIQUE INDEX application_threads_principal_hierarchy
  ON application_threads(
    tenant_id, owner_principal_id, environment_id, workspace_id, id
  );

CREATE TABLE principal_agent_tool_clients (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND lower(id) = id
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  creation_request_id TEXT NOT NULL CHECK (
    length(creation_request_id) = 36
    AND lower(creation_request_id) = creation_request_id
    AND substr(creation_request_id, 9, 1) = '-'
    AND substr(creation_request_id, 14, 1) = '-'
    AND substr(creation_request_id, 19, 1) = '-'
    AND substr(creation_request_id, 24, 1) = '-'
    AND replace(creation_request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  name TEXT NOT NULL CHECK (
    name = trim(name)
    AND instr(name, char(0)) = 0
    AND length(CAST(name AS BLOB)) BETWEEN 1 AND 240
  ),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  default_environment_id TEXT,
  default_workspace_id TEXT,
  default_thread_id TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (
    policy_revision BETWEEN 0 AND 9007199254740991
  ),
  credential_generation INTEGER NOT NULL DEFAULT 1 CHECK (
    credential_generation BETWEEN 1 AND 4294967295
  ),
  credential_verifier BLOB CHECK (
    credential_verifier IS NULL
    OR (typeof(credential_verifier) = 'blob' AND length(credential_verifier) = 32)
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, creation_request_id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, id, default_environment_id)
    REFERENCES principal_agent_tool_client_environments(
      tenant_id, owner_principal_id, client_id, environment_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, owner_principal_id, default_environment_id,
    default_workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, environment_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, default_environment_id,
    default_workspace_id, default_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id,
      environment_id, workspace_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (revoked_at IS NULL
      AND credential_verifier IS NOT NULL
      AND default_environment_id IS NOT NULL)
    OR
    (revoked_at IS NOT NULL
      AND enabled = 0
      AND credential_verifier IS NULL
      AND default_environment_id IS NULL
      AND default_workspace_id IS NULL
      AND default_thread_id IS NULL)
  ),
  CHECK (default_thread_id IS NULL OR default_workspace_id IS NOT NULL)
) STRICT;

CREATE TABLE principal_agent_tool_client_entries (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  tool_id TEXT NOT NULL CHECK (
    length(CAST(tool_id AS BLOB)) BETWEEN 1 AND 128
    AND substr(tool_id, 1, 1) GLOB '[a-z]'
    AND tool_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, client_id, tool_id),
  FOREIGN KEY (tenant_id, owner_principal_id, client_id)
    REFERENCES principal_agent_tool_clients(
      tenant_id, owner_principal_id, id
    ) ON DELETE CASCADE
) STRICT;

CREATE TABLE principal_agent_tool_client_environments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal_id, client_id, environment_id),
  FOREIGN KEY (tenant_id, owner_principal_id, client_id)
    REFERENCES principal_agent_tool_clients(
      tenant_id, owner_principal_id, id
    ) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id)
    REFERENCES execution_environments(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX principal_agent_tool_clients_by_creation
  ON principal_agent_tool_clients(
    tenant_id, owner_principal_id, created_at DESC, id DESC
  );

CREATE INDEX principal_agent_tool_clients_by_last_used
  ON principal_agent_tool_clients(
    tenant_id, owner_principal_id, last_used_at DESC, id
  );

CREATE INDEX principal_agent_tool_client_environments_by_environment
  ON principal_agent_tool_client_environments(
    tenant_id, owner_principal_id, environment_id, client_id
  );

CREATE TRIGGER principal_agent_tool_clients_insert_bound
BEFORE INSERT ON principal_agent_tool_clients
WHEN (
  SELECT count(*) FROM principal_agent_tool_clients AS client
  WHERE client.tenant_id = NEW.tenant_id
    AND client.owner_principal_id = NEW.owner_principal_id
) >= 1024
OR (NEW.revoked_at IS NULL AND (
  SELECT count(*) FROM principal_agent_tool_clients AS client
  WHERE client.tenant_id = NEW.tenant_id
    AND client.owner_principal_id = NEW.owner_principal_id
    AND client.revoked_at IS NULL
) >= 64)
BEGIN
  SELECT RAISE(ABORT, 'Principal agent-tool client limit exceeded');
END;

CREATE TRIGGER principal_agent_tool_clients_restore_bound
BEFORE UPDATE OF revoked_at ON principal_agent_tool_clients
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Revoked principal agent-tool clients are terminal');
END;

CREATE TRIGGER principal_agent_tool_clients_revoke_empty
BEFORE UPDATE OF credential_verifier ON principal_agent_tool_clients
WHEN OLD.credential_verifier IS NOT NULL AND NEW.credential_verifier IS NULL
  AND (EXISTS (
    SELECT 1 FROM principal_agent_tool_client_entries AS entry
    WHERE entry.tenant_id = OLD.tenant_id
      AND entry.owner_principal_id = OLD.owner_principal_id
      AND entry.client_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM principal_agent_tool_client_environments AS environment
    WHERE environment.tenant_id = OLD.tenant_id
      AND environment.owner_principal_id = OLD.owner_principal_id
      AND environment.client_id = OLD.id
  ))
BEGIN
  SELECT RAISE(ABORT, 'Revocation must clear principal agent-tool policy');
END;

CREATE TRIGGER principal_agent_tool_client_entries_insert_bound
BEFORE INSERT ON principal_agent_tool_client_entries
WHEN EXISTS (
  SELECT 1 FROM principal_agent_tool_clients AS client
  WHERE client.tenant_id = NEW.tenant_id
    AND client.owner_principal_id = NEW.owner_principal_id
    AND client.id = NEW.client_id
    AND client.revoked_at IS NOT NULL
)
OR (
  SELECT count(*) FROM principal_agent_tool_client_entries AS entry
  WHERE entry.tenant_id = NEW.tenant_id
    AND entry.owner_principal_id = NEW.owner_principal_id
    AND entry.client_id = NEW.client_id
) >= 256
BEGIN
  SELECT RAISE(ABORT, 'Principal agent-tool client tool policy is invalid');
END;

CREATE TRIGGER principal_agent_tool_client_environments_insert_bound
BEFORE INSERT ON principal_agent_tool_client_environments
WHEN EXISTS (
  SELECT 1 FROM principal_agent_tool_clients AS client
  WHERE client.tenant_id = NEW.tenant_id
    AND client.owner_principal_id = NEW.owner_principal_id
    AND client.id = NEW.client_id
    AND client.revoked_at IS NOT NULL
)
OR (
  SELECT count(*) FROM principal_agent_tool_client_environments AS environment
  WHERE environment.tenant_id = NEW.tenant_id
    AND environment.owner_principal_id = NEW.owner_principal_id
    AND environment.client_id = NEW.client_id
) >= 16
BEGIN
  SELECT RAISE(ABORT, 'Principal agent-tool client environment policy is invalid');
END;
`,
};
