export const agentToolCoreMigration = {
  version: 16,
  name: "agent_tool_core",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE queued_inputs
ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (trigger_kind IN ('user', 'automation'));

ALTER TABLE queued_inputs
ADD COLUMN source_automation_id TEXT CHECK (
  source_automation_id IS NULL
  OR length(source_automation_id) BETWEEN 1 AND 128
);

ALTER TABLE queued_inputs
ADD COLUMN source_automation_run_id TEXT CHECK (
  source_automation_run_id IS NULL
  OR length(source_automation_run_id) BETWEEN 1 AND 128
);

CREATE TABLE migration_016_queue_provenance_guard (
  ambiguous_rows INTEGER NOT NULL CHECK (ambiguous_rows = 0)
) STRICT;

INSERT INTO migration_016_queue_provenance_guard(ambiguous_rows)
SELECT count(*)
FROM queued_inputs AS queued
WHERE 1 < (
  SELECT count(*)
  FROM automation_runs AS run
  WHERE run.tenant_id = queued.tenant_id
    AND run.owner_principal_id = queued.owner_principal_id
    AND run.dispatch_mutation_id = queued.mutation_id
    AND coalesce(run.child_thread_id, run.anchor_thread_id) =
      queued.application_thread_id
)
AND queued.retry_of_id IS NULL;

UPDATE queued_inputs
SET trigger_kind = 'automation',
  source_automation_id = (
    SELECT run.automation_id
    FROM automation_runs AS run
    WHERE run.tenant_id = queued_inputs.tenant_id
      AND run.owner_principal_id = queued_inputs.owner_principal_id
      AND run.dispatch_mutation_id = queued_inputs.mutation_id
      AND coalesce(run.child_thread_id, run.anchor_thread_id) =
        queued_inputs.application_thread_id
    ORDER BY run.created_at, run.id
    LIMIT 1
  ),
  source_automation_run_id = (
    SELECT run.id
    FROM automation_runs AS run
    WHERE run.tenant_id = queued_inputs.tenant_id
      AND run.owner_principal_id = queued_inputs.owner_principal_id
      AND run.dispatch_mutation_id = queued_inputs.mutation_id
      AND coalesce(run.child_thread_id, run.anchor_thread_id) =
        queued_inputs.application_thread_id
    ORDER BY run.created_at, run.id
    LIMIT 1
  )
WHERE queued_inputs.retry_of_id IS NULL
AND EXISTS (
  SELECT 1
  FROM automation_runs AS run
  WHERE run.tenant_id = queued_inputs.tenant_id
    AND run.owner_principal_id = queued_inputs.owner_principal_id
    AND run.dispatch_mutation_id = queued_inputs.mutation_id
    AND coalesce(run.child_thread_id, run.anchor_thread_id) =
      queued_inputs.application_thread_id
);

WITH RECURSIVE automation_retry_lineage(
  tenant_id, owner_principal_id, application_thread_id, id,
  source_automation_id, source_automation_run_id
) AS (
  SELECT tenant_id, owner_principal_id, application_thread_id, id,
    source_automation_id, source_automation_run_id
  FROM queued_inputs
  WHERE trigger_kind = 'automation' AND retry_of_id IS NULL
  UNION
  SELECT child.tenant_id, child.owner_principal_id,
    child.application_thread_id, child.id,
    parent.source_automation_id, parent.source_automation_run_id
  FROM queued_inputs AS child
  JOIN automation_retry_lineage AS parent
    ON parent.tenant_id = child.tenant_id
    AND parent.owner_principal_id = child.owner_principal_id
    AND parent.application_thread_id = child.application_thread_id
    AND parent.id = child.retry_of_id
)
UPDATE queued_inputs
SET trigger_kind = 'automation',
  source_automation_id = (
    SELECT lineage.source_automation_id
    FROM automation_retry_lineage AS lineage
    WHERE lineage.tenant_id = queued_inputs.tenant_id
      AND lineage.owner_principal_id = queued_inputs.owner_principal_id
      AND lineage.application_thread_id = queued_inputs.application_thread_id
      AND lineage.id = queued_inputs.id
  ),
  source_automation_run_id = (
    SELECT lineage.source_automation_run_id
    FROM automation_retry_lineage AS lineage
    WHERE lineage.tenant_id = queued_inputs.tenant_id
      AND lineage.owner_principal_id = queued_inputs.owner_principal_id
      AND lineage.application_thread_id = queued_inputs.application_thread_id
      AND lineage.id = queued_inputs.id
  )
WHERE retry_of_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM automation_retry_lineage AS lineage
    WHERE lineage.tenant_id = queued_inputs.tenant_id
      AND lineage.owner_principal_id = queued_inputs.owner_principal_id
      AND lineage.application_thread_id = queued_inputs.application_thread_id
      AND lineage.id = queued_inputs.id
  );

DROP TABLE migration_016_queue_provenance_guard;

CREATE TRIGGER queued_inputs_trigger_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (
  (NEW.trigger_kind = 'user'
    AND NEW.source_automation_id IS NULL
    AND NEW.source_automation_run_id IS NULL
    AND (
      NEW.retry_of_id IS NULL
      OR EXISTS (
        SELECT 1 FROM queued_inputs AS parent
        WHERE parent.tenant_id = NEW.tenant_id
          AND parent.owner_principal_id = NEW.owner_principal_id
          AND parent.application_thread_id = NEW.application_thread_id
          AND parent.id = NEW.retry_of_id
          AND parent.trigger_kind = 'user'
          AND parent.source_automation_id IS NULL
          AND parent.source_automation_run_id IS NULL
      )
    ))
  OR
  (NEW.trigger_kind = 'automation'
    AND NEW.source_automation_id IS NOT NULL
    AND NEW.source_automation_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM automation_runs AS run
      WHERE run.tenant_id = NEW.tenant_id
        AND run.owner_principal_id = NEW.owner_principal_id
        AND run.automation_id = NEW.source_automation_id
        AND run.id = NEW.source_automation_run_id
        AND coalesce(run.child_thread_id, run.anchor_thread_id) =
          NEW.application_thread_id
        AND (
          (NEW.retry_of_id IS NULL
            AND run.dispatch_mutation_id = NEW.mutation_id)
          OR
          (NEW.retry_of_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM queued_inputs AS parent
            WHERE parent.tenant_id = NEW.tenant_id
              AND parent.owner_principal_id = NEW.owner_principal_id
              AND parent.application_thread_id = NEW.application_thread_id
              AND parent.id = NEW.retry_of_id
              AND parent.trigger_kind = 'automation'
              AND parent.source_automation_id = NEW.source_automation_id
              AND parent.source_automation_run_id =
                NEW.source_automation_run_id
          ))
        )
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input trigger provenance is invalid');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_update
BEFORE UPDATE OF
  tenant_id, owner_principal_id, id, application_thread_id,
  mutation_id, retry_of_id, trigger_kind,
  source_automation_id, source_automation_run_id
ON queued_inputs
WHEN NOT (
  (NEW.trigger_kind = 'user'
    AND NEW.source_automation_id IS NULL
    AND NEW.source_automation_run_id IS NULL
    AND (
      NEW.retry_of_id IS NULL
      OR EXISTS (
        SELECT 1 FROM queued_inputs AS parent
        WHERE parent.tenant_id = NEW.tenant_id
          AND parent.owner_principal_id = NEW.owner_principal_id
          AND parent.application_thread_id = NEW.application_thread_id
          AND parent.id = NEW.retry_of_id
          AND parent.trigger_kind = 'user'
          AND parent.source_automation_id IS NULL
          AND parent.source_automation_run_id IS NULL
      )
    ))
  OR
  (NEW.trigger_kind = 'automation'
    AND NEW.source_automation_id IS NOT NULL
    AND NEW.source_automation_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM automation_runs AS run
      WHERE run.tenant_id = NEW.tenant_id
        AND run.owner_principal_id = NEW.owner_principal_id
        AND run.automation_id = NEW.source_automation_id
        AND run.id = NEW.source_automation_run_id
        AND coalesce(run.child_thread_id, run.anchor_thread_id) =
          NEW.application_thread_id
        AND (
          (NEW.retry_of_id IS NULL
            AND run.dispatch_mutation_id = NEW.mutation_id)
          OR
          (NEW.retry_of_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM queued_inputs AS parent
            WHERE parent.tenant_id = NEW.tenant_id
              AND parent.owner_principal_id = NEW.owner_principal_id
              AND parent.application_thread_id = NEW.application_thread_id
              AND parent.id = NEW.retry_of_id
              AND parent.trigger_kind = 'automation'
              AND parent.source_automation_id = NEW.source_automation_id
              AND parent.source_automation_run_id =
                NEW.source_automation_run_id
          ))
        )
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input trigger provenance is invalid');
END;

CREATE TRIGGER queued_inputs_retry_provenance_parent_update
BEFORE UPDATE OF
  tenant_id, owner_principal_id, id, application_thread_id,
  trigger_kind, source_automation_id, source_automation_run_id
ON queued_inputs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS child
  WHERE child.tenant_id = OLD.tenant_id
    AND child.owner_principal_id = OLD.owner_principal_id
    AND child.application_thread_id = OLD.application_thread_id
    AND child.retry_of_id = OLD.id
    AND NOT (
      NEW.tenant_id = child.tenant_id
      AND NEW.owner_principal_id = child.owner_principal_id
      AND NEW.id = child.retry_of_id
      AND NEW.application_thread_id = child.application_thread_id
      AND NEW.trigger_kind = child.trigger_kind
      AND NEW.source_automation_id IS child.source_automation_id
      AND NEW.source_automation_run_id IS child.source_automation_run_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input retry provenance parent is referenced');
END;

CREATE TRIGGER automation_runs_queued_provenance_delete
BEFORE DELETE ON automation_runs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS queued
  WHERE queued.tenant_id = OLD.tenant_id
    AND queued.owner_principal_id = OLD.owner_principal_id
    AND queued.source_automation_id = OLD.automation_id
    AND queued.source_automation_run_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run is referenced by queued input provenance');
END;

CREATE TRIGGER automation_runs_queued_provenance_update
BEFORE UPDATE OF
  tenant_id, owner_principal_id, automation_id, id,
  dispatch_mutation_id, anchor_thread_id, child_thread_id
ON automation_runs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS queued
  WHERE queued.tenant_id = OLD.tenant_id
    AND queued.owner_principal_id = OLD.owner_principal_id
    AND queued.source_automation_id = OLD.automation_id
    AND queued.source_automation_run_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run is referenced by queued input provenance');
END;

CREATE UNIQUE INDEX application_threads_agent_execution_target
  ON application_threads(
    tenant_id, owner_principal_id, id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id
  );

CREATE TABLE agent_executions (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  provider_runtime_correlation TEXT NOT NULL CHECK (
    length(provider_runtime_correlation) BETWEEN 1 AND 512
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'starting', 'active', 'detached', 'reconciling',
      'stopping', 'stopped', 'failed'
    )
  ),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= started_at),
  terminal_at INTEGER CHECK (
    terminal_at IS NULL OR terminal_at >= started_at
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id, generation
  ),
  UNIQUE (
    tenant_id, owner_principal_id, id, generation, application_thread_id
  ),
  UNIQUE (
    tenant_id, owner_principal_id, id, generation, application_thread_id,
    source_workspace_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    source_workspace_id, backend_instance_id, connection_profile_id,
    execution_environment_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_environment_id,
    source_workspace_id
  ) REFERENCES workspaces(
    tenant_id, owner_principal_id, environment_id, id
  ) ON DELETE RESTRICT,
  CHECK (
    (state IN ('stopped', 'failed') AND terminal_at IS NOT NULL)
    OR
    (state NOT IN ('stopped', 'failed') AND terminal_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX agent_executions_one_current_generation
  ON agent_executions(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE state IN (
    'starting', 'active', 'detached', 'reconciling', 'stopping'
  );

CREATE INDEX agent_executions_recovery
  ON agent_executions(
    tenant_id, owner_principal_id, state, last_seen_at
  );

CREATE TABLE agent_runs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  execution_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
  source_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 128
  ),
  provider_turn_correlation TEXT CHECK (
    provider_turn_correlation IS NULL
    OR length(provider_turn_correlation) BETWEEN 1 AND 512
  ),
  trigger TEXT NOT NULL CHECK (
    trigger IN ('user', 'automation', 'agent_call')
  ),
  triggering_automation_id TEXT CHECK (
    triggering_automation_id IS NULL
    OR length(triggering_automation_id) BETWEEN 1 AND 128
  ),
  triggering_automation_run_id TEXT CHECK (
    triggering_automation_run_id IS NULL
    OR length(triggering_automation_run_id) BETWEEN 1 AND 128
  ),
  parent_invocation_id TEXT CHECK (
    parent_invocation_id IS NULL
    OR length(parent_invocation_id) BETWEEN 1 AND 128
  ),
  scheduler_occurrence_id TEXT CHECK (
    scheduler_occurrence_id IS NULL
    OR length(scheduler_occurrence_id) BETWEEN 1 AND 240
  ),
  trigger_policy_revision INTEGER NOT NULL CHECK (
    trigger_policy_revision >= 0
  ),
  policy_restrictions_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(policy_restrictions_json)
      AND json_type(policy_restrictions_json) = 'object'
      AND length(CAST(policy_restrictions_json AS BLOB)) <= 16384
    ),
  state TEXT NOT NULL CHECK (
    state IN (
      'preparing', 'active', 'reconciling', 'completed',
      'interrupted', 'failed', 'abandoned'
    )
  ),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  terminal_at INTEGER CHECK (
    terminal_at IS NULL OR terminal_at >= started_at
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, id, execution_id,
    execution_generation, source_thread_id, provider_turn_correlation
  ),
  UNIQUE (
    tenant_id, owner_principal_id, execution_id,
    application_operation_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_id,
    execution_generation, source_thread_id
  ) REFERENCES agent_executions(
    tenant_id, owner_principal_id, id, generation, application_thread_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id,
    triggering_automation_id, triggering_automation_run_id
  ) REFERENCES automation_runs(
    tenant_id, owner_principal_id, automation_id, id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, parent_invocation_id)
    REFERENCES agent_tool_invocations(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    state <> 'active' OR provider_turn_correlation IS NOT NULL
  ),
  CHECK (
    (state IN ('preparing', 'active', 'reconciling') AND terminal_at IS NULL)
    OR
    (state NOT IN ('preparing', 'active', 'reconciling')
      AND terminal_at IS NOT NULL)
  ),
  CHECK (
    (trigger = 'user'
      AND triggering_automation_id IS NULL
      AND triggering_automation_run_id IS NULL
      AND parent_invocation_id IS NULL
      AND scheduler_occurrence_id IS NULL)
    OR
    (trigger = 'automation'
      AND triggering_automation_id IS NOT NULL
      AND triggering_automation_run_id IS NOT NULL
      AND parent_invocation_id IS NULL)
    OR
    (trigger = 'agent_call'
      AND triggering_automation_id IS NULL
      AND triggering_automation_run_id IS NULL
      AND parent_invocation_id IS NOT NULL
      AND scheduler_occurrence_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX agent_runs_one_current_per_execution
  ON agent_runs(tenant_id, owner_principal_id, execution_id)
  WHERE state IN ('preparing', 'active', 'reconciling');

CREATE INDEX agent_runs_provider_turn
  ON agent_runs(
    tenant_id, owner_principal_id, execution_id,
    provider_turn_correlation
  );

CREATE TABLE agent_capability_grants (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  execution_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
  source_thread_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  grant_source_kind TEXT NOT NULL CHECK (
    grant_source_kind IN ('system_reference', 'tool_profile', 'delegated_run')
  ),
  grant_source_id TEXT NOT NULL CHECK (
    length(grant_source_id) BETWEEN 1 AND 160
  ),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER CHECK (
    revoked_at IS NULL OR revoked_at >= issued_at
  ),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL
    OR length(revocation_reason) BETWEEN 1 AND 240
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, id, execution_id,
    execution_generation, source_thread_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_id, execution_generation,
    source_thread_id, source_workspace_id
  ) REFERENCES agent_executions(
    tenant_id, owner_principal_id, id, generation,
    application_thread_id, source_workspace_id
  ) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
) STRICT;

CREATE UNIQUE INDEX agent_capability_grants_one_current
  ON agent_capability_grants(
    tenant_id, owner_principal_id, execution_id, execution_generation
  )
  WHERE revoked_at IS NULL;

CREATE INDEX agent_capability_grants_expiry
  ON agent_capability_grants(
    tenant_id, owner_principal_id, expires_at
  )
  WHERE revoked_at IS NULL;

CREATE TABLE agent_capability_entries (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    length(capability) BETWEEN 1 AND 160
  ),
  resource_constraint_json TEXT CHECK (
    resource_constraint_json IS NULL
    OR (
      json_valid(resource_constraint_json)
      AND json_type(resource_constraint_json) = 'object'
      AND length(CAST(resource_constraint_json AS BLOB)) <= 16384
    )
  ),
  PRIMARY KEY (
    tenant_id, owner_principal_id, grant_id, capability
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, grant_id)
    REFERENCES agent_capability_grants(
      tenant_id, owner_principal_id, id
    ) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX agent_capability_entries_capability
  ON agent_capability_entries(
    tenant_id, owner_principal_id, capability, grant_id
  );

CREATE TABLE agent_tool_invocations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  execution_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
  run_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision >= 0),
  source_thread_id TEXT NOT NULL,
  provider_turn_correlation TEXT NOT NULL CHECK (
    length(provider_turn_correlation) BETWEEN 1 AND 512
  ),
  tool_id TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 160),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  execution_form TEXT NOT NULL CHECK (
    execution_form IN ('inline', 'operation', 'hybrid')
  ),
  application_effect TEXT NOT NULL CHECK (
    application_effect IN ('read', 'write', 'destructive')
  ),
  model_usage_effect TEXT NOT NULL CHECK (
    model_usage_effect IN ('none', 'agent_execution')
  ),
  external_effect TEXT NOT NULL CHECK (
    external_effect IN ('none', 'durable_side_effect')
  ),
  effect_boundary TEXT NOT NULL CHECK (
    effect_boundary IN ('none', 'not_crossed', 'crossed', 'unknown')
  ),
  adapter TEXT NOT NULL CHECK (
    adapter IN ('pi_sdk', 'mcp', 'http', 'cli', 'internal')
  ),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  input_summary TEXT CHECK (
    input_summary IS NULL
    OR length(CAST(input_summary AS BLOB)) BETWEEN 1 AND 2048
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'prepared', 'accepted', 'running', 'waiting_for_input',
      'completed', 'failed', 'uncertain',
      'cancel_requested', 'cancelled'
    )
  ),
  domain_operation_id TEXT CHECK (
    domain_operation_id IS NULL
    OR length(domain_operation_id) BETWEEN 1 AND 128
  ),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
  terminal_at INTEGER CHECK (
    terminal_at IS NULL OR terminal_at >= started_at
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'invalid_input', 'unauthenticated', 'permission_denied',
      'not_found', 'conflict', 'rate_limited', 'unavailable',
      'timed_out', 'cancelled', 'uncertain_outcome', 'internal_error',
      'server_restarted_before_completion'
    )
  ),
  diagnostic TEXT CHECK (
    diagnostic IS NULL
    OR length(CAST(diagnostic AS BLOB)) BETWEEN 1 AND 2048
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, execution_id, execution_generation, run_id,
    tool_id, schema_version, request_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_id,
    execution_generation, source_thread_id
  ) REFERENCES agent_executions(
    tenant_id, owner_principal_id, id, generation, application_thread_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, run_id, execution_id,
    execution_generation, source_thread_id, provider_turn_correlation
  ) REFERENCES agent_runs(
    tenant_id, owner_principal_id, id, execution_id,
    execution_generation, source_thread_id, provider_turn_correlation
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, grant_id,
    execution_id, execution_generation, source_thread_id
  ) REFERENCES agent_capability_grants(
    tenant_id, owner_principal_id, id,
    execution_id, execution_generation, source_thread_id
  ) ON DELETE RESTRICT,
  CHECK (
    (state IN ('completed', 'failed', 'uncertain', 'cancelled')
      AND terminal_at IS NOT NULL)
    OR
    (state NOT IN ('completed', 'failed', 'uncertain', 'cancelled')
      AND terminal_at IS NULL)
  ),
  CHECK (
    (external_effect = 'none' AND effect_boundary = 'none')
    OR
    (external_effect = 'durable_side_effect'
      AND effect_boundary <> 'none')
  )
) STRICT;

CREATE INDEX agent_tool_invocations_audit
  ON agent_tool_invocations(
    tenant_id, owner_principal_id, tool_id, state, started_at
  );

CREATE INDEX agent_tool_invocations_run
  ON agent_tool_invocations(
    tenant_id, owner_principal_id, execution_id, run_id, started_at
  );
`,
} as const;
