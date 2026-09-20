import type { DatabaseMigration } from "../migrate.js";

/**
 * Durable ownership and filesystem-effect state for thread-private Pi
 * sandboxes. The generated clone is deliberately not a normal workspace:
 * application_threads.workspace_id continues to identify the source workspace.
 */
export const piSandboxAllocationsMigration: DatabaseMigration = {
  version: 67,
  name: "pi-sandbox-allocations",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE pi_sandbox_allocations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL CHECK (length(allocation_id) = 36),
  execution_environment_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  source_canonical_path TEXT NOT NULL CHECK (
    length(source_canonical_path) BETWEEN 1 AND 4096
  ),
  allocation_root_path TEXT NOT NULL CHECK (
    length(allocation_root_path) BETWEEN 1 AND 4096
  ),
  home_path TEXT NOT NULL CHECK (length(home_path) BETWEEN 1 AND 4096),
  workspace_path TEXT NOT NULL CHECK (
    length(workspace_path) BETWEEN 1 AND 4096
  ),
  network_profile TEXT NOT NULL CHECK (
    network_profile IN ('isolated', 'execution_host')
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'reserved', 'materializing', 'ready', 'materialization_failed',
      'deleting', 'delete_failed', 'deleted'
    )
  ),
  retention TEXT NOT NULL CHECK (
    retention IN ('active', 'retained', 'delete_requested')
  ),
  operation_id TEXT,
  completed_delete_operation_id TEXT CHECK (
    completed_delete_operation_id IS NULL
    OR length(completed_delete_operation_id) = 36
  ),
  operation_kind TEXT CHECK (
    operation_kind IS NULL OR operation_kind IN ('materialize', 'delete')
  ),
  diagnostic_code TEXT CHECK (
    diagnostic_code IS NULL OR length(diagnostic_code) BETWEEN 1 AND 120
  ),
  source_head_oid TEXT CHECK (
    source_head_oid IS NULL OR (
      length(source_head_oid) IN (40, 64)
      AND source_head_oid = lower(source_head_oid)
      AND source_head_oid NOT GLOB '*[^0-9a-f]*'
    )
  ),
  sandbox_branch TEXT CHECK (
    sandbox_branch IS NULL OR length(sandbox_branch) BETWEEN 1 AND 1024
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  ready_at INTEGER CHECK (ready_at IS NULL OR ready_at >= 0),
  retained_at INTEGER CHECK (retained_at IS NULL OR retained_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  UNIQUE (tenant_id, owner_principal_id, allocation_id),
  UNIQUE (tenant_id, owner_principal_id, allocation_root_path),
  UNIQUE (tenant_id, owner_principal_id, workspace_path),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, execution_environment_id)
    REFERENCES execution_environments(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_environment_id,
    source_workspace_id
  ) REFERENCES workspaces(
    tenant_id, owner_principal_id, environment_id, id
  ) ON DELETE RESTRICT,
  CHECK (
    (operation_id IS NULL AND operation_kind IS NULL)
    OR
    (length(operation_id) = 36 AND operation_kind IS NOT NULL)
  ),
  CHECK (
    (state IN ('materializing', 'deleting') AND operation_id IS NOT NULL)
    OR
    (state NOT IN ('materializing', 'deleting') AND operation_id IS NULL)
  ),
  CHECK (
    (state = 'ready' AND ready_at IS NOT NULL AND deleted_at IS NULL)
    OR state <> 'ready'
  ),
  CHECK (
    (state = 'deleted' AND deleted_at IS NOT NULL
      AND retention = 'delete_requested'
      AND completed_delete_operation_id IS NOT NULL)
    OR (state <> 'deleted' AND deleted_at IS NULL
      AND completed_delete_operation_id IS NULL)
  ),
  CHECK (
    (retention = 'retained' AND retained_at IS NOT NULL)
    OR (retention <> 'retained' AND retained_at IS NULL)
  )
) STRICT;

CREATE INDEX pi_sandbox_allocations_recovery
  ON pi_sandbox_allocations(
    tenant_id, owner_principal_id, state, updated_at, application_thread_id
  )
  WHERE state IN (
    'materializing', 'materialization_failed', 'deleting', 'delete_failed'
  );
`,
};
