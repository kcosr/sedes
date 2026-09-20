import type { DatabaseMigration } from "../migrate.js";

/**
 * Adds a durable fork boundary for a provider snapshot accepted while its
 * source turn is still active. The rebuild keeps the boundary and nullable
 * application turn coupled in SQLite rather than relying on callers alone.
 */
export const providerSnapshotForkLineageMigration: DatabaseMigration = {
  version: 57,
  name: "provider_snapshot_fork_lineage",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE aborted_thread_forks_v57 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL CHECK (
    length(creation_operation_id) BETWEEN 1 AND 128
  ),
  reserved_child_thread_id TEXT NOT NULL CHECK (
    length(reserved_child_thread_id) BETWEEN 1 AND 128
  ),
  source_thread_id TEXT NOT NULL,
  source_turn_id TEXT CHECK (
    source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 160
  ),
  source_turn_revision INTEGER CHECK (
    source_turn_revision IS NULL OR source_turn_revision >= 0
  ),
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN (
    'completed_turn_inclusive', 'provider_snapshot_at_acceptance'
  )),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('automation', 'user_fork', 'agent_control')
  ),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  diagnostic TEXT NOT NULL CHECK (
    length(CAST(diagnostic AS BLOB)) BETWEEN 1 AND 500
  ),
  aborted_at INTEGER NOT NULL CHECK (aborted_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, creation_operation_id),
  UNIQUE (tenant_id, owner_principal_id, reserved_child_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, source_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_agent_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id,
    source_automation_run_id)
    REFERENCES automation_runs(tenant_id, owner_principal_id, automation_id, id)
    ON DELETE RESTRICT,
  CHECK ((source_kind = 'user_fork'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND ((boundary_kind = 'completed_turn_inclusive'
          AND source_turn_id IS NOT NULL AND source_turn_revision IS NOT NULL)
        OR (boundary_kind = 'provider_snapshot_at_acceptance'
          AND source_turn_id IS NULL AND source_turn_revision IS NULL)))
    OR (source_kind = 'automation'
      AND boundary_kind = 'completed_turn_inclusive'
      AND source_automation_id IS NOT NULL AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL)
    OR (source_kind = 'agent_control'
      AND boundary_kind = 'completed_turn_inclusive'
      AND source_turn_id IS NOT NULL AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL))
) STRICT;

INSERT INTO aborted_thread_forks_v57(
  tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, boundary_kind, source_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id, diagnostic, aborted_at
)
SELECT tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, 'completed_turn_inclusive', source_kind,
  source_automation_id, source_automation_run_id, initiating_agent_thread_id,
  diagnostic, aborted_at
FROM aborted_thread_forks;

DROP TABLE aborted_thread_forks;
ALTER TABLE aborted_thread_forks_v57 RENAME TO aborted_thread_forks;

CREATE TABLE backend_checkpoints_v57 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  application_turn_id TEXT CHECK (
    application_turn_id IS NULL OR length(application_turn_id) BETWEEN 1 AND 160
  ),
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN (
    'completed_turn_inclusive', 'provider_snapshot_at_acceptance'
  )),
  kind TEXT NOT NULL CHECK (kind = 'conversation_leaf'),
  opaque_reference TEXT NOT NULL CHECK (
    length(CAST(opaque_reference AS BLOB)) BETWEEN 1 AND 512
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, id, application_thread_id,
    backend_instance_id
  ),
  UNIQUE (
    tenant_id, owner_principal_id, id, application_thread_id,
    backend_instance_id, boundary_kind
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, backend_instance_id)
    REFERENCES agent_backend_instances(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    boundary_kind <> 'provider_snapshot_at_acceptance'
    OR application_turn_id IS NULL
  )
) STRICT;

INSERT INTO backend_checkpoints_v57(
  tenant_id, owner_principal_id, id, application_thread_id,
  backend_instance_id, application_turn_id, boundary_kind, kind,
  opaque_reference, created_at
)
SELECT tenant_id, owner_principal_id, id, application_thread_id,
  backend_instance_id, application_turn_id, boundary_kind, kind,
  opaque_reference, created_at
FROM backend_checkpoints;

CREATE TABLE thread_fork_origins_v57 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  provider_parent_backend_conversation_id TEXT CHECK (
    provider_parent_backend_conversation_id IS NULL
    OR length(provider_parent_backend_conversation_id) BETWEEN 1 AND 128
  ),
  source_thread_state TEXT NOT NULL CHECK (
    source_thread_state IN ('resolved', 'unresolved')
  ),
  source_thread_id TEXT,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  source_turn_state TEXT NOT NULL CHECK (
    source_turn_state IN ('resolved', 'unresolved')
  ),
  source_turn_id TEXT CHECK (
    source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 160
  ),
  source_turn_revision INTEGER CHECK (
    source_turn_revision IS NULL OR source_turn_revision >= 0
  ),
  source_checkpoint_id TEXT,
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN (
    'completed_turn_inclusive', 'provider_snapshot_at_acceptance'
  )),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'user_fork', 'automation_fork', 'agent_fork', 'imported_native_fork'
  )),
  initiating_principal_id TEXT,
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  branch_method TEXT NOT NULL CHECK (
    branch_method IN ('provider_native', 'provider_history_import')
  ),
  creation_operation_id TEXT CHECK (
    creation_operation_id IS NULL OR length(creation_operation_id) BETWEEN 1 AND 128
  ),
  origin_state TEXT NOT NULL CHECK (origin_state IN ('prepared', 'committed')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  committed_at INTEGER CHECK (committed_at IS NULL OR committed_at >= created_at),
  source_turn_completed_at INTEGER CHECK (
    source_turn_completed_at IS NULL OR (
      source_turn_state = 'resolved' AND source_turn_id IS NOT NULL
    )
  ),
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, child_thread_id),
  UNIQUE (tenant_id, owner_principal_id, creation_operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id, workspace_id,
      backend_instance_id, connection_profile_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_thread_id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id, workspace_id,
      backend_instance_id, connection_profile_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_checkpoint_id,
    source_thread_id, backend_instance_id, boundary_kind)
    REFERENCES backend_checkpoints(tenant_id, owner_principal_id, id,
      application_thread_id, backend_instance_id, boundary_kind) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, initiating_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id, source_automation_run_id)
    REFERENCES automation_runs(tenant_id, owner_principal_id, automation_id, id) ON DELETE RESTRICT,
  CHECK ((source_thread_state = 'resolved' AND source_thread_id IS NOT NULL)
    OR (source_thread_state = 'unresolved' AND source_thread_id IS NULL)),
  CHECK (source_thread_id IS NULL OR child_thread_id <> source_thread_id),
  CHECK (source_thread_state = 'resolved'
    OR (source_turn_state = 'unresolved' AND source_turn_id IS NULL
      AND source_checkpoint_id IS NULL)),
  CHECK ((source_turn_state = 'resolved' AND source_turn_id IS NOT NULL)
    OR (source_turn_state = 'unresolved' AND source_turn_id IS NULL)),
  CHECK (source_turn_state = 'resolved' OR source_turn_revision IS NULL),
  CHECK (
    boundary_kind = 'provider_snapshot_at_acceptance'
    OR origin_kind <> 'user_fork'
    OR source_turn_revision IS NOT NULL
  ),
  CHECK (
    boundary_kind = 'completed_turn_inclusive'
    OR (
      source_thread_state = 'resolved'
      AND source_thread_id IS NOT NULL
      AND source_turn_state = 'unresolved'
      AND source_turn_id IS NULL
      AND source_turn_revision IS NULL
      AND source_turn_completed_at IS NULL
      AND source_checkpoint_id IS NOT NULL
      AND origin_kind = 'user_fork'
    )
  ),
  CHECK (
    (origin_kind = 'imported_native_fork') =
      (provider_parent_backend_conversation_id IS NOT NULL)
  ),
  CHECK ((origin_state = 'prepared' AND committed_at IS NULL)
    OR (origin_state = 'committed' AND committed_at IS NOT NULL)),
  CHECK (
    (origin_kind = 'user_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR (origin_kind = 'automation_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NOT NULL AND source_automation_run_id IS NOT NULL)
    OR (origin_kind = 'agent_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR (origin_kind = 'imported_native_fork' AND initiating_principal_id IS NULL
      AND creation_operation_id IS NULL AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL AND origin_state = 'committed')
  )
) STRICT;

INSERT INTO thread_fork_origins_v57(
  tenant_id, owner_principal_id, child_thread_id,
  provider_parent_backend_conversation_id, source_thread_state,
  source_thread_id, environment_id, workspace_id, backend_instance_id,
  connection_profile_id, source_turn_state, source_turn_id,
  source_turn_revision, source_checkpoint_id, boundary_kind, origin_kind,
  initiating_principal_id, source_automation_id, source_automation_run_id,
  branch_method, creation_operation_id, origin_state, created_at, committed_at,
  source_turn_completed_at, initiating_agent_thread_id
)
SELECT tenant_id, owner_principal_id, child_thread_id,
  provider_parent_backend_conversation_id, source_thread_state,
  source_thread_id, environment_id, workspace_id, backend_instance_id,
  connection_profile_id, source_turn_state, source_turn_id,
  source_turn_revision, source_checkpoint_id, boundary_kind, origin_kind,
  initiating_principal_id, source_automation_id, source_automation_run_id,
  branch_method, creation_operation_id, origin_state, created_at, committed_at,
  source_turn_completed_at, initiating_agent_thread_id
FROM thread_fork_origins;

DROP TABLE thread_fork_origins;
DROP TABLE backend_checkpoints;
ALTER TABLE backend_checkpoints_v57 RENAME TO backend_checkpoints;
ALTER TABLE thread_fork_origins_v57 RENAME TO thread_fork_origins;

CREATE INDEX thread_fork_origins_by_source
  ON thread_fork_origins(tenant_id, owner_principal_id, source_thread_id,
    created_at DESC, child_thread_id DESC);

CREATE TRIGGER thread_fork_origins_immutable_delete
BEFORE DELETE ON thread_fork_origins
WHEN NOT (
  OLD.origin_state = 'prepared'
  AND EXISTS (
    SELECT 1 FROM aborted_thread_forks AS aborted
    WHERE aborted.tenant_id = OLD.tenant_id
      AND aborted.owner_principal_id = OLD.owner_principal_id
      AND aborted.creation_operation_id = OLD.creation_operation_id
      AND aborted.reserved_child_thread_id = OLD.child_thread_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_origins_immutable_update
BEFORE UPDATE ON thread_fork_origins
WHEN NOT ((
  OLD.origin_state = 'prepared' AND OLD.committed_at IS NULL
  AND NEW.origin_state = 'committed' AND NEW.committed_at IS NOT NULL
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.owner_principal_id = OLD.owner_principal_id
  AND NEW.child_thread_id = OLD.child_thread_id
  AND NEW.provider_parent_backend_conversation_id IS OLD.provider_parent_backend_conversation_id
  AND NEW.source_thread_state = OLD.source_thread_state
  AND NEW.source_thread_id = OLD.source_thread_id
  AND NEW.environment_id = OLD.environment_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.backend_instance_id = OLD.backend_instance_id
  AND NEW.connection_profile_id = OLD.connection_profile_id
  AND NEW.source_turn_state = OLD.source_turn_state
  AND NEW.source_turn_id IS OLD.source_turn_id
  AND NEW.source_turn_revision IS OLD.source_turn_revision
  AND NEW.source_checkpoint_id IS OLD.source_checkpoint_id
  AND NEW.boundary_kind = OLD.boundary_kind
  AND NEW.origin_kind = OLD.origin_kind
  AND NEW.initiating_principal_id IS OLD.initiating_principal_id
  AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at
) OR (
  OLD.origin_kind = 'imported_native_fork'
  AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
  AND OLD.source_thread_state = 'unresolved' AND OLD.source_thread_id IS NULL
  AND NEW.source_thread_state = 'resolved' AND NEW.source_thread_id IS NOT NULL
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.owner_principal_id = OLD.owner_principal_id
  AND NEW.child_thread_id = OLD.child_thread_id
  AND NEW.provider_parent_backend_conversation_id = OLD.provider_parent_backend_conversation_id
  AND NEW.environment_id = OLD.environment_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.backend_instance_id = OLD.backend_instance_id
  AND NEW.connection_profile_id = OLD.connection_profile_id
  AND NEW.source_turn_revision IS OLD.source_turn_revision
  AND NEW.boundary_kind = OLD.boundary_kind
  AND NEW.origin_kind = OLD.origin_kind
  AND NEW.initiating_principal_id IS OLD.initiating_principal_id
  AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.committed_at = OLD.committed_at
  AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at
) OR (
  OLD.origin_kind = 'imported_native_fork'
  AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
  AND OLD.source_thread_state = 'resolved' AND NEW.source_thread_state = 'resolved'
  AND NEW.source_thread_id = OLD.source_thread_id
  AND OLD.source_turn_state = 'unresolved' AND OLD.source_turn_id IS NULL
  AND NEW.source_turn_state = 'resolved' AND NEW.source_turn_id IS NOT NULL
  AND OLD.source_checkpoint_id IS NULL
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.owner_principal_id = OLD.owner_principal_id
  AND NEW.child_thread_id = OLD.child_thread_id
  AND NEW.provider_parent_backend_conversation_id = OLD.provider_parent_backend_conversation_id
  AND NEW.environment_id = OLD.environment_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.backend_instance_id = OLD.backend_instance_id
  AND NEW.connection_profile_id = OLD.connection_profile_id
  AND NEW.source_turn_revision IS OLD.source_turn_revision
  AND NEW.boundary_kind = OLD.boundary_kind
  AND NEW.origin_kind = OLD.origin_kind
  AND NEW.initiating_principal_id IS OLD.initiating_principal_id
  AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.committed_at = OLD.committed_at
  AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at
))
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_origins_fork_point_immutable
BEFORE UPDATE OF source_turn_completed_at ON thread_fork_origins
WHEN NEW.source_turn_completed_at IS NOT OLD.source_turn_completed_at
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_origins_agent_control_insert
BEFORE INSERT ON thread_fork_origins
WHEN (NEW.origin_kind = 'agent_fork') != (NEW.initiating_agent_thread_id IS NOT NULL)
  OR (NEW.initiating_agent_thread_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM application_threads AS source
    WHERE source.tenant_id = NEW.tenant_id
      AND source.owner_principal_id = NEW.owner_principal_id
      AND source.id = NEW.initiating_agent_thread_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is invalid');
END;

CREATE TRIGGER thread_fork_origins_agent_control_update
BEFORE UPDATE OF origin_kind, initiating_agent_thread_id ON thread_fork_origins
WHEN NEW.origin_kind IS NOT OLD.origin_kind
  OR NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is immutable');
END;

CREATE TRIGGER thread_fork_force_reset_automation_insert
BEFORE INSERT ON thread_fork_origins
WHEN NEW.source_automation_run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM automation_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.owner_principal_id = NEW.owner_principal_id
      AND run.automation_id = NEW.source_automation_id
      AND run.id = NEW.source_automation_run_id
      AND run.force_reset_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation cannot create a fork');
END;

CREATE TRIGGER thread_force_reset_abandoned_fork_commit
BEFORE UPDATE OF origin_state ON thread_fork_origins
WHEN OLD.origin_state = 'prepared' AND NEW.origin_state = 'committed'
  AND EXISTS (
    SELECT 1 FROM thread_force_reset_abandoned_forks AS abandoned
    WHERE abandoned.tenant_id = OLD.tenant_id
      AND abandoned.principal_id = OLD.owner_principal_id
      AND abandoned.child_thread_id = OLD.child_thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset fork origin cannot be committed');
END;

CREATE TRIGGER thread_lineage_closure_origin_insert
AFTER INSERT ON thread_fork_origins
WHEN NEW.source_thread_state = 'resolved' AND NEW.origin_state = 'committed'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;

CREATE TRIGGER thread_lineage_closure_origin_commit
AFTER UPDATE OF origin_state ON thread_fork_origins
WHEN OLD.origin_state = 'prepared' AND NEW.origin_state = 'committed'
  AND NEW.source_thread_state = 'resolved'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;

CREATE TRIGGER thread_lineage_closure_source_resolution
AFTER UPDATE OF source_thread_state, source_thread_id ON thread_fork_origins
WHEN OLD.source_thread_state = 'unresolved'
  AND NEW.source_thread_state = 'resolved'
  AND NEW.origin_state = 'committed'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;
`,
};
