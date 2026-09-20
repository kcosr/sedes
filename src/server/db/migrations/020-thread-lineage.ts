export const threadLineageMigration = {
  version: 20,
  name: "thread_lineage",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE migration_020_fork_candidates (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_checkpoint_id TEXT NOT NULL,
  source_automation_id TEXT NOT NULL,
  source_automation_run_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  PRIMARY KEY (tenant_id, owner_principal_id, child_thread_id)
) STRICT;

CREATE TABLE migration_020_aborted_forks (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL,
  reserved_child_thread_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_automation_id TEXT NOT NULL,
  source_automation_run_id TEXT NOT NULL,
  diagnostic TEXT NOT NULL,
  aborted_at INTEGER NOT NULL,
  child_reused INTEGER NOT NULL CHECK (child_reused IN (0, 1)),
  PRIMARY KEY (tenant_id, owner_principal_id, creation_operation_id),
  UNIQUE (tenant_id, owner_principal_id, reserved_child_thread_id)
) STRICT;

INSERT INTO migration_020_aborted_forks
SELECT attempt.tenant_id, attempt.owner_principal_id, attempt.mutation_id,
  attempt.application_thread_id, run.anchor_thread_id,
  attempt.source_automation_id, attempt.source_automation_run_id,
  coalesce(nullif(attempt.diagnostic, ''),
    'The legacy automation fork was not created.'),
  coalesce(attempt.reconciled_at, attempt.accepted_at,
    attempt.external_call_started_at, attempt.prepared_at),
  CASE WHEN EXISTS (
    SELECT 1
    FROM conversation_creation_attempts AS owner_attempt
    WHERE owner_attempt.tenant_id = attempt.tenant_id
      AND owner_attempt.owner_principal_id = attempt.owner_principal_id
      AND owner_attempt.application_thread_id =
        attempt.application_thread_id
      AND owner_attempt.attempt_id <> attempt.attempt_id
      AND owner_attempt.creation_kind = 'first_input'
      -- Every first-input attempt, including a proven-uncreated terminal
      -- attempt, is retained below and owns the application thread it names.
      -- Its presence is therefore authoritative reuse, not a clone artifact.
  ) THEN 1 ELSE 0 END
FROM conversation_creation_attempts AS attempt
JOIN automation_runs AS run
  ON run.tenant_id = attempt.tenant_id
  AND run.owner_principal_id = attempt.owner_principal_id
  AND run.automation_id = attempt.source_automation_id
  AND run.id = attempt.source_automation_run_id
WHERE attempt.creation_kind = 'automation_clone'
  AND attempt.phase = 'aborted_unpersisted';

CREATE TABLE migration_020_candidate_conflicts (
  conflict_count INTEGER NOT NULL CHECK (conflict_count = 0)
) STRICT;

INSERT INTO migration_020_candidate_conflicts
SELECT count(*) FROM (
  SELECT tenant_id, owner_principal_id, child_thread_id
  FROM (
    SELECT attempt.tenant_id, attempt.owner_principal_id,
      attempt.application_thread_id AS child_thread_id,
      run.anchor_thread_id AS source_thread_id,
      checkpoint.id AS source_checkpoint_id,
      attempt.source_automation_id, attempt.source_automation_run_id,
      attempt.mutation_id AS creation_operation_id
    FROM conversation_creation_attempts AS attempt
    JOIN automation_runs AS run
      ON run.tenant_id = attempt.tenant_id
      AND run.owner_principal_id = attempt.owner_principal_id
      AND run.automation_id = attempt.source_automation_id
      AND run.id = attempt.source_automation_run_id
    JOIN backend_checkpoints AS checkpoint
      ON checkpoint.tenant_id = attempt.tenant_id
      AND checkpoint.owner_principal_id = attempt.owner_principal_id
      AND checkpoint.id = attempt.mutation_id
    WHERE attempt.creation_kind = 'automation_clone'
      AND attempt.phase <> 'aborted_unpersisted'
    UNION ALL
    SELECT run.tenant_id, run.owner_principal_id, run.child_thread_id,
      run.anchor_thread_id, run.source_checkpoint_id,
      run.automation_id, run.id, run.dispatch_mutation_id
    FROM automation_runs AS run
    WHERE run.lineage_kind = 'automation_clone'
      AND run.child_thread_id IS NOT NULL
      AND run.source_checkpoint_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM migration_020_aborted_forks AS aborted
        WHERE aborted.tenant_id = run.tenant_id
          AND aborted.owner_principal_id = run.owner_principal_id
          AND aborted.reserved_child_thread_id = run.child_thread_id
          AND aborted.source_automation_id = run.automation_id
          AND aborted.source_automation_run_id = run.id
      )
  )
  GROUP BY tenant_id, owner_principal_id, child_thread_id
  HAVING count(DISTINCT source_thread_id || char(0) || source_checkpoint_id
    || char(0) || source_automation_id || char(0) || source_automation_run_id
    || char(0) || creation_operation_id) > 1
);

INSERT INTO migration_020_fork_candidates
SELECT attempt.tenant_id, attempt.owner_principal_id,
  attempt.application_thread_id, run.anchor_thread_id, checkpoint.id,
  attempt.source_automation_id, attempt.source_automation_run_id,
  attempt.mutation_id, attempt.prepared_at,
  CASE WHEN attempt.phase = 'bound' THEN attempt.reconciled_at ELSE NULL END
FROM conversation_creation_attempts AS attempt
JOIN automation_runs AS run
  ON run.tenant_id = attempt.tenant_id
  AND run.owner_principal_id = attempt.owner_principal_id
  AND run.automation_id = attempt.source_automation_id
  AND run.id = attempt.source_automation_run_id
JOIN backend_checkpoints AS checkpoint
  ON checkpoint.tenant_id = attempt.tenant_id
  AND checkpoint.owner_principal_id = attempt.owner_principal_id
  AND checkpoint.id = attempt.mutation_id
WHERE attempt.creation_kind = 'automation_clone'
  AND attempt.phase <> 'aborted_unpersisted';

INSERT OR IGNORE INTO migration_020_fork_candidates
SELECT run.tenant_id, run.owner_principal_id, run.child_thread_id,
  run.anchor_thread_id, run.source_checkpoint_id, run.automation_id, run.id,
  run.dispatch_mutation_id, run.created_at, run.updated_at
FROM automation_runs AS run
WHERE run.lineage_kind = 'automation_clone'
  AND run.child_thread_id IS NOT NULL
  AND run.source_checkpoint_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM migration_020_aborted_forks AS aborted
    WHERE aborted.tenant_id = run.tenant_id
      AND aborted.owner_principal_id = run.owner_principal_id
      AND aborted.reserved_child_thread_id = run.child_thread_id
      AND aborted.source_automation_id = run.automation_id
      AND aborted.source_automation_run_id = run.id
  );

CREATE TABLE migration_020_target_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;
INSERT INTO migration_020_target_guard
SELECT count(*)
FROM migration_020_fork_candidates AS candidate
LEFT JOIN application_threads AS source
  ON source.tenant_id = candidate.tenant_id
  AND source.owner_principal_id = candidate.owner_principal_id
  AND source.id = candidate.source_thread_id
LEFT JOIN application_threads AS child
  ON child.tenant_id = candidate.tenant_id
  AND child.owner_principal_id = candidate.owner_principal_id
  AND child.id = candidate.child_thread_id
LEFT JOIN backend_checkpoints AS checkpoint
  ON checkpoint.tenant_id = candidate.tenant_id
  AND checkpoint.owner_principal_id = candidate.owner_principal_id
  AND checkpoint.id = candidate.source_checkpoint_id
LEFT JOIN agent_backend_instances AS backend
  ON backend.tenant_id = source.tenant_id
  AND backend.id = source.backend_instance_id
WHERE source.id IS NULL OR child.id IS NULL OR checkpoint.id IS NULL OR backend.id IS NULL
  OR source.id = child.id
  OR source.environment_id <> child.environment_id
  OR source.workspace_id <> child.workspace_id
  OR source.backend_instance_id <> child.backend_instance_id
  OR source.connection_profile_id <> child.connection_profile_id
  OR checkpoint.application_thread_id <> source.id
  OR checkpoint.backend_instance_id <> source.backend_instance_id
  OR backend.kind <> 'pi';

CREATE TABLE backend_checkpoints_v20 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  application_turn_id TEXT CHECK (
    application_turn_id IS NULL OR length(application_turn_id) BETWEEN 1 AND 160
  ),
  boundary_kind TEXT NOT NULL CHECK (
    boundary_kind = 'completed_turn_inclusive'
  ),
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
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, backend_instance_id)
    REFERENCES agent_backend_instances(tenant_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO backend_checkpoints_v20
SELECT tenant_id, owner_principal_id, id, application_thread_id,
  backend_instance_id, NULL, 'completed_turn_inclusive', kind,
  opaque_reference, created_at
FROM backend_checkpoints;

CREATE TABLE automation_runs_v20 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  occurrence_kind TEXT NOT NULL CHECK (occurrence_kind IN ('scheduled', 'manual')),
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 240),
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 0),
  coalesced_count INTEGER NOT NULL DEFAULT 0 CHECK (coalesced_count >= 0),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('same_thread', 'clone')),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'dispatching', 'queued', 'running', 'completed', 'failed',
    'skipped', 'uncertain'
  )),
  claim_token TEXT,
  lease_expires_at INTEGER,
  claim_attempt_count INTEGER NOT NULL CHECK (claim_attempt_count >= 1),
  prompt_snapshot TEXT CHECK (
    prompt_snapshot IS NULL OR length(CAST(prompt_snapshot AS BLOB)) BETWEEN 1 AND 65536
  ),
  dispatch_mutation_id TEXT NOT NULL CHECK (length(dispatch_mutation_id) BETWEEN 1 AND 128),
  anchor_thread_id TEXT NOT NULL,
  child_thread_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  error_diagnostic TEXT CHECK (error_diagnostic IS NULL OR length(error_diagnostic) BETWEEN 1 AND 500),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= claimed_at),
  accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= claimed_at),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= claimed_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  precheck_command_snapshot TEXT CHECK (
    precheck_command_snapshot IS NULL OR length(CAST(precheck_command_snapshot AS BLOB)) BETWEEN 1 AND 4096
  ),
  precheck_timeout_seconds INTEGER CHECK (
    precheck_timeout_seconds IS NULL OR precheck_timeout_seconds BETWEEN 1 AND 60
  ),
  precheck_include_stdout INTEGER CHECK (precheck_include_stdout IS NULL OR precheck_include_stdout IN (0, 1)),
  precheck_status TEXT NOT NULL CHECK (precheck_status IN (
    'not_configured', 'pending', 'checking', 'passed', 'skipped', 'failed'
  )),
  precheck_started_at INTEGER CHECK (precheck_started_at IS NULL OR precheck_started_at >= claimed_at),
  precheck_finished_at INTEGER CHECK (
    precheck_finished_at IS NULL OR (precheck_started_at IS NOT NULL AND precheck_finished_at >= precheck_started_at)
  ),
  precheck_exit_code INTEGER,
  precheck_duration_ms INTEGER CHECK (precheck_duration_ms IS NULL OR precheck_duration_ms >= 0),
  precheck_stdout_bytes INTEGER CHECK (precheck_stdout_bytes IS NULL OR precheck_stdout_bytes >= 0),
  precheck_stdout_included INTEGER CHECK (precheck_stdout_included IS NULL OR precheck_stdout_included IN (0, 1)),
  PRIMARY KEY (tenant_id, owner_principal_id, automation_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  CHECK ((run_mode = 'same_thread' AND child_thread_id IS NULL) OR run_mode = 'clone'),
  CHECK (
    (state IN ('claimed', 'dispatching') AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('claimed', 'dispatching') AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('claimed', 'dispatching', 'uncertain') AND prompt_snapshot IS NOT NULL)
    OR (state IN ('completed', 'failed', 'skipped') AND prompt_snapshot IS NULL)
    OR state IN ('queued', 'running')
  ),
  CHECK (
    (state = 'claimed' AND started_at IS NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR (state = 'dispatching' AND started_at IS NOT NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR (state IN ('queued', 'running') AND started_at IS NOT NULL AND accepted_at IS NOT NULL AND finished_at IS NULL)
    OR (state = 'uncertain' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('completed', 'failed', 'skipped') AND finished_at IS NOT NULL)
  ),
  CHECK (
    (precheck_command_snapshot IS NULL) = (precheck_timeout_seconds IS NULL)
    AND (precheck_command_snapshot IS NULL) = (precheck_include_stdout IS NULL)
    AND ((precheck_command_snapshot IS NULL AND precheck_status = 'not_configured')
      OR (precheck_command_snapshot IS NOT NULL AND precheck_status <> 'not_configured'))
  )
) STRICT;

INSERT INTO automation_runs_v20(
  tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
  scheduled_for, occurrence_key, definition_revision, coalesced_count,
  run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
  prompt_snapshot, dispatch_mutation_id, anchor_thread_id, child_thread_id,
  error_code, error_diagnostic, claimed_at, started_at, accepted_at, finished_at,
  created_at, updated_at, precheck_command_snapshot, precheck_timeout_seconds,
  precheck_include_stdout, precheck_status, precheck_started_at,
  precheck_finished_at, precheck_exit_code, precheck_duration_ms,
  precheck_stdout_bytes, precheck_stdout_included
)
SELECT tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
  scheduled_for, occurrence_key, definition_revision, coalesced_count,
  run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
  prompt_snapshot, dispatch_mutation_id, anchor_thread_id,
  CASE WHEN EXISTS (
    SELECT 1 FROM migration_020_aborted_forks AS aborted
    WHERE aborted.tenant_id = automation_runs.tenant_id
      AND aborted.owner_principal_id = automation_runs.owner_principal_id
      AND aborted.reserved_child_thread_id = automation_runs.child_thread_id
      AND aborted.source_automation_id = automation_runs.automation_id
      AND aborted.source_automation_run_id = automation_runs.id
  ) THEN NULL ELSE child_thread_id END,
  error_code, error_diagnostic, claimed_at, started_at, accepted_at, finished_at,
  created_at, updated_at, precheck_command_snapshot, precheck_timeout_seconds,
  precheck_include_stdout, precheck_status, precheck_started_at,
  precheck_finished_at, precheck_exit_code, precheck_duration_ms,
  precheck_stdout_bytes, precheck_stdout_included
FROM automation_runs;

CREATE TABLE conversation_creation_attempts_v20 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('first_input', 'fork')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('composer', 'automation', 'user_fork')),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initial_input_text TEXT CHECK (
    initial_input_text IS NULL OR length(CAST(initial_input_text AS BLOB)) BETWEEN 1 AND 65536
  ),
  consumed_draft_revision INTEGER CHECK (consumed_draft_revision IS NULL OR consumed_draft_revision >= 1),
  backend_creation_correlation TEXT NOT NULL CHECK (length(backend_creation_correlation) BETWEEN 1 AND 128),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'external_call_started', 'conversation_identified',
    'first_submission_started', 'accepted_unpersisted', 'bound',
    'aborted_unpersisted', 'recovery_required'
  )),
  provisional_backend_conversation_id TEXT CHECK (
    provisional_backend_conversation_id IS NULL OR length(provisional_backend_conversation_id) BETWEEN 1 AND 128
  ),
  provisional_opaque_binding_detail TEXT CHECK (
    provisional_opaque_binding_detail IS NULL
    OR length(CAST(provisional_opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
  ),
  reconciliation_token TEXT CHECK (reconciliation_token IS NULL OR length(reconciliation_token) BETWEEN 1 AND 512),
  retry_anchor TEXT CHECK (retry_anchor IS NULL OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096),
  retry_authorized_at INTEGER,
  retry_mutation_id TEXT CHECK (retry_mutation_id IS NULL OR length(retry_mutation_id) BETWEEN 1 AND 128),
  retry_started_at INTEGER,
  retry_reconciliation_token TEXT CHECK (retry_reconciliation_token IS NULL OR length(retry_reconciliation_token) BETWEEN 1 AND 512),
  backend_correlation TEXT CHECK (backend_correlation IS NULL OR length(backend_correlation) BETWEEN 1 AND 512),
  completion_identity TEXT CHECK (completion_identity IS NULL OR length(completion_identity) BETWEEN 1 AND 512),
  diagnostic TEXT CHECK (diagnostic IS NULL OR length(diagnostic) BETWEEN 1 AND 500),
  prepared_at INTEGER NOT NULL,
  external_call_started_at INTEGER,
  accepted_at INTEGER,
  reconciled_at INTEGER,
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, attempt_id),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, attempt_id, backend_instance_id, execution_environment_id),
  UNIQUE (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id,
      backend_instance_id, connection_profile_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id, source_automation_run_id)
    REFERENCES automation_runs_v20(tenant_id, owner_principal_id, automation_id, id) ON DELETE RESTRICT,
  CHECK (
    (creation_kind = 'first_input' AND initial_input_text IS NOT NULL)
    OR (creation_kind = 'fork' AND initial_input_text IS NULL)
  ),
  CHECK (
    (source_kind = 'composer' AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR (source_kind = 'user_fork' AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL AND source_automation_run_id IS NOT NULL)
  ),
  CHECK (
    (creation_kind = 'first_input' AND source_kind IN ('composer', 'automation'))
    OR (creation_kind = 'fork' AND source_kind IN ('user_fork', 'automation'))
  ),
  CHECK (creation_kind <> 'fork' OR phase NOT IN ('first_submission_started', 'accepted_unpersisted')),
  CHECK (
    (source_kind = 'composer' AND (consumed_draft_revision IS NOT NULL OR phase = 'aborted_unpersisted'))
    OR (source_kind <> 'composer' AND consumed_draft_revision IS NULL)
  ),
  CHECK (
    (retry_mutation_id IS NULL AND retry_started_at IS NULL AND retry_reconciliation_token IS NULL)
    OR (retry_mutation_id IS NOT NULL AND retry_started_at IS NOT NULL
      AND retry_reconciliation_token IS NOT NULL AND retry_anchor IS NOT NULL)
  ),
  CHECK (retry_anchor IS NULL OR phase IN ('first_submission_started', 'recovery_required')),
  CHECK (phase <> 'first_submission_started' OR retry_anchor IS NOT NULL),
  CHECK (retry_authorized_at IS NULL OR retry_mutation_id IS NULL),
  CHECK (phase NOT IN ('conversation_identified', 'first_submission_started', 'accepted_unpersisted', 'bound')
    OR provisional_backend_conversation_id IS NOT NULL),
  CHECK (phase NOT IN ('conversation_identified', 'first_submission_started', 'accepted_unpersisted', 'bound')
    OR provisional_opaque_binding_detail IS NOT NULL),
  CHECK (phase NOT IN ('external_call_started', 'conversation_identified', 'first_submission_started', 'accepted_unpersisted', 'bound')
    OR external_call_started_at IS NOT NULL),
  CHECK (phase NOT IN ('accepted_unpersisted', 'bound') OR accepted_at IS NOT NULL),
  CHECK (phase <> 'bound' OR reconciled_at IS NOT NULL),
  CHECK (accepted_at IS NOT NULL OR (backend_correlation IS NULL AND completion_identity IS NULL)),
  CHECK ((retry_authorized_at IS NULL AND retry_mutation_id IS NULL) OR phase = 'recovery_required'),
  CHECK (external_call_started_at IS NULL OR external_call_started_at >= prepared_at),
  CHECK (accepted_at IS NULL OR accepted_at >= prepared_at),
  CHECK (reconciled_at IS NULL OR reconciled_at >= prepared_at),
  CHECK (retry_authorized_at IS NULL OR retry_authorized_at >= prepared_at),
  CHECK (retry_started_at IS NULL OR retry_started_at >= prepared_at)
) STRICT;

INSERT INTO conversation_creation_attempts_v20
SELECT attempt.tenant_id, attempt.owner_principal_id,
  attempt.application_thread_id, attempt.attempt_id,
  attempt.mutation_id, attempt.backend_instance_id,
  attempt.connection_profile_id, attempt.execution_environment_id,
  CASE attempt.creation_kind
    WHEN 'automation_clone' THEN 'fork' ELSE attempt.creation_kind
  END,
  attempt.source_kind, attempt.source_automation_id,
  attempt.source_automation_run_id, attempt.initial_input_text,
  attempt.consumed_draft_revision,
  attempt.requested_backend_conversation_id,
  CASE
    WHEN attempt.creation_kind = 'automation_clone'
      AND attempt.phase IN ('first_submission_started', 'accepted_unpersisted')
    THEN 'recovery_required'
    ELSE attempt.phase
  END,
  attempt.provisional_backend_conversation_id,
  CASE
    WHEN attempt.provisional_backend_conversation_id IS NULL THEN NULL
    WHEN backend.kind = 'codex_app_server' THEN json_object(
      'version', 1, 'threadId', attempt.provisional_backend_conversation_id
    )
    ELSE coalesce(
      (
        SELECT detail.opaque_binding_detail
        FROM pi_creation_details AS detail
        WHERE detail.tenant_id = attempt.tenant_id
          AND detail.owner_principal_id = attempt.owner_principal_id
          AND detail.application_thread_id = attempt.application_thread_id
          AND detail.attempt_id = attempt.attempt_id
      ),
      CASE WHEN attempt.phase = 'bound' THEN (
        SELECT detail.opaque_binding_detail
        FROM pi_binding_details AS detail
        JOIN conversation_bindings AS binding
          ON binding.tenant_id = detail.tenant_id
          AND binding.owner_principal_id = detail.owner_principal_id
          AND binding.application_thread_id = detail.application_thread_id
          AND binding.backend_instance_id = detail.backend_instance_id
          AND binding.execution_environment_id = detail.execution_environment_id
        WHERE detail.tenant_id = attempt.tenant_id
          AND detail.owner_principal_id = attempt.owner_principal_id
          AND detail.application_thread_id = attempt.application_thread_id
          AND detail.backend_instance_id = attempt.backend_instance_id
          AND detail.execution_environment_id =
            attempt.execution_environment_id
          AND binding.connection_profile_id = attempt.connection_profile_id
          AND binding.backend_conversation_id =
            attempt.provisional_backend_conversation_id
      ) END
    )
  END,
  attempt.reconciliation_token, attempt.retry_anchor,
  attempt.retry_authorized_at, attempt.retry_mutation_id,
  attempt.retry_started_at, attempt.retry_reconciliation_token,
  attempt.backend_correlation, attempt.completion_identity,
  attempt.diagnostic, attempt.prepared_at,
  attempt.external_call_started_at, attempt.accepted_at,
  attempt.reconciled_at
FROM conversation_creation_attempts AS attempt
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = attempt.tenant_id
  AND backend.id = attempt.backend_instance_id
-- Terminal legacy clones are represented only by aborted_thread_forks below;
-- retaining an attempt would leave a second, contradictory replay authority.
WHERE NOT (
  attempt.creation_kind = 'automation_clone'
  AND attempt.phase = 'aborted_unpersisted'
);

DROP TRIGGER automation_runs_queued_provenance_delete;
DROP TRIGGER automation_runs_queued_provenance_update;
DROP TRIGGER queued_inputs_trigger_provenance_insert;
DROP TRIGGER queued_inputs_trigger_provenance_update;
DROP TRIGGER pi_binding_details_path_not_provisional_insert;
DROP TRIGGER pi_binding_details_path_not_provisional_update;
DROP TABLE pi_creation_details;
DROP TABLE conversation_creation_attempts;
DROP TABLE automation_runs;
DROP TABLE backend_checkpoints;
ALTER TABLE backend_checkpoints_v20 RENAME TO backend_checkpoints;
ALTER TABLE automation_runs_v20 RENAME TO automation_runs;
ALTER TABLE conversation_creation_attempts_v20 RENAME TO conversation_creation_attempts;

CREATE UNIQUE INDEX conversation_creation_attempts_one_active
  ON conversation_creation_attempts(tenant_id, owner_principal_id, application_thread_id)
  WHERE phase NOT IN ('bound', 'aborted_unpersisted');
CREATE UNIQUE INDEX automation_runs_one_nonterminal
  ON automation_runs(tenant_id, owner_principal_id, automation_id)
  WHERE state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain');
CREATE INDEX automation_runs_expired_claims
  ON automation_runs(lease_expires_at, tenant_id, owner_principal_id, automation_id, id)
  WHERE state IN ('claimed', 'dispatching');
CREATE INDEX automation_runs_history
  ON automation_runs(tenant_id, owner_principal_id, automation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX automation_runs_child_lineage
  ON automation_runs(tenant_id, owner_principal_id, child_thread_id)
  WHERE child_thread_id IS NOT NULL;
CREATE UNIQUE INDEX automation_runs_occurrence_key_unique
  ON automation_runs(tenant_id, owner_principal_id, automation_id, occurrence_key);
CREATE INDEX automation_runs_application_summary_latest
  ON automation_runs(tenant_id, owner_principal_id, automation_id,
    scheduled_for DESC, created_at DESC, id DESC);

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
BEFORE UPDATE OF tenant_id, owner_principal_id, automation_id, id,
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

CREATE TABLE thread_fork_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  provider_parent_backend_conversation_id TEXT CHECK (
    provider_parent_backend_conversation_id IS NULL
    OR length(provider_parent_backend_conversation_id) BETWEEN 1 AND 128
  ),
  source_thread_state TEXT NOT NULL CHECK (source_thread_state IN ('resolved', 'unresolved')),
  source_thread_id TEXT,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  source_turn_state TEXT NOT NULL CHECK (source_turn_state IN ('resolved', 'unresolved')),
  source_turn_id TEXT CHECK (source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 160),
  source_turn_revision INTEGER CHECK (
    source_turn_revision IS NULL OR source_turn_revision >= 0
  ),
  source_checkpoint_id TEXT,
  boundary_kind TEXT NOT NULL CHECK (boundary_kind = 'completed_turn_inclusive'),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'user_fork', 'automation_fork', 'agent_fork', 'imported_native_fork'
  )),
  initiating_principal_id TEXT,
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  branch_method TEXT NOT NULL CHECK (branch_method IN ('provider_native', 'provider_history_import')),
  creation_operation_id TEXT CHECK (
    creation_operation_id IS NULL OR length(creation_operation_id) BETWEEN 1 AND 128
  ),
  origin_state TEXT NOT NULL CHECK (origin_state IN ('prepared', 'committed')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  committed_at INTEGER CHECK (committed_at IS NULL OR committed_at >= created_at),
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
    source_thread_id, backend_instance_id)
    REFERENCES backend_checkpoints(tenant_id, owner_principal_id, id,
      application_thread_id, backend_instance_id) ON DELETE RESTRICT,
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
  CHECK (origin_kind <> 'user_fork' OR source_turn_revision IS NOT NULL),
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

CREATE INDEX thread_fork_origins_by_source
  ON thread_fork_origins(tenant_id, owner_principal_id, source_thread_id,
    created_at DESC, child_thread_id DESC);

CREATE TABLE thread_lineage_closure (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  ancestor_thread_id TEXT NOT NULL,
  descendant_thread_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 1),
  descendant_created_at INTEGER NOT NULL CHECK (descendant_created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, ancestor_thread_id, descendant_thread_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, ancestor_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, descendant_thread_id)
    REFERENCES thread_fork_origins(tenant_id, owner_principal_id, child_thread_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX thread_lineage_closure_page
  ON thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_created_at DESC, descendant_thread_id DESC
  );
CREATE INDEX thread_lineage_closure_ancestors
  ON thread_lineage_closure(
    tenant_id, owner_principal_id, descendant_thread_id,
    ancestor_thread_id, depth
  );

CREATE TABLE aborted_thread_forks (
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
  source_kind TEXT NOT NULL CHECK (source_kind IN ('automation', 'user_fork')),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  diagnostic TEXT NOT NULL CHECK (
    length(CAST(diagnostic AS BLOB)) BETWEEN 1 AND 500
  ),
  aborted_at INTEGER NOT NULL CHECK (aborted_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, creation_operation_id),
  UNIQUE (tenant_id, owner_principal_id, reserved_child_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, source_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id,
    source_automation_id, source_automation_run_id
  ) REFERENCES automation_runs(
    tenant_id, owner_principal_id, automation_id, id
  ) ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'user_fork' AND source_turn_id IS NOT NULL
      AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL)
  )
) STRICT;

INSERT INTO aborted_thread_forks(
  tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, source_kind, source_automation_id,
  source_automation_run_id, diagnostic, aborted_at
)
SELECT tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, NULL, NULL, 'automation',
  source_automation_id, source_automation_run_id, diagnostic, aborted_at
FROM migration_020_aborted_forks;

UPDATE thread_principal_state
SET automation_context_run_id = NULL,
  automation_context_source_thread_id = NULL,
  automation_context_at = NULL,
  automation_context_outcome = NULL,
  automation_context_diagnostic = NULL
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = thread_principal_state.tenant_id
    AND aborted.owner_principal_id = thread_principal_state.principal_id
    AND aborted.reserved_child_thread_id =
      thread_principal_state.automation_context_source_thread_id
);

DELETE FROM pi_submission_details
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = pi_submission_details.tenant_id
    AND aborted.owner_principal_id = pi_submission_details.owner_principal_id
    AND aborted.reserved_child_thread_id =
      pi_submission_details.application_thread_id
);
DELETE FROM queued_inputs
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = queued_inputs.tenant_id
    AND aborted.owner_principal_id = queued_inputs.owner_principal_id
    AND aborted.reserved_child_thread_id = queued_inputs.application_thread_id
);
DELETE FROM submission_completion_observations
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = submission_completion_observations.tenant_id
    AND aborted.owner_principal_id =
      submission_completion_observations.owner_principal_id
    AND aborted.reserved_child_thread_id =
      submission_completion_observations.application_thread_id
);
DELETE FROM mutation_receipts
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = mutation_receipts.tenant_id
    AND aborted.owner_principal_id = mutation_receipts.principal_id
    AND aborted.reserved_child_thread_id = mutation_receipts.thread_id
);
DELETE FROM provider_feature_mutation_receipts
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = provider_feature_mutation_receipts.tenant_id
    AND aborted.owner_principal_id =
      provider_feature_mutation_receipts.owner_principal_id
    AND aborted.reserved_child_thread_id =
      provider_feature_mutation_receipts.application_thread_id
);
DELETE FROM pi_binding_details
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = pi_binding_details.tenant_id
    AND aborted.owner_principal_id = pi_binding_details.owner_principal_id
    AND aborted.reserved_child_thread_id =
      pi_binding_details.application_thread_id
);
DELETE FROM conversation_bindings
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = conversation_bindings.tenant_id
    AND aborted.owner_principal_id = conversation_bindings.owner_principal_id
    AND aborted.reserved_child_thread_id =
      conversation_bindings.application_thread_id
);
DELETE FROM pi_thread_settings
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = pi_thread_settings.tenant_id
    AND aborted.owner_principal_id = pi_thread_settings.owner_principal_id
    AND aborted.reserved_child_thread_id =
      pi_thread_settings.application_thread_id
);
DELETE FROM prompt_stashes
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = prompt_stashes.tenant_id
    AND aborted.owner_principal_id = prompt_stashes.principal_id
    AND aborted.reserved_child_thread_id = prompt_stashes.thread_id
);
DELETE FROM thread_drafts
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = thread_drafts.tenant_id
    AND aborted.owner_principal_id = thread_drafts.principal_id
    AND aborted.reserved_child_thread_id = thread_drafts.thread_id
);
DELETE FROM thread_principal_state
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = thread_principal_state.tenant_id
    AND aborted.owner_principal_id = thread_principal_state.principal_id
    AND aborted.reserved_child_thread_id = thread_principal_state.thread_id
);
DELETE FROM backend_checkpoints
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.tenant_id = backend_checkpoints.tenant_id
    AND aborted.owner_principal_id = backend_checkpoints.owner_principal_id
    AND aborted.creation_operation_id = backend_checkpoints.id
);
DELETE FROM application_threads
WHERE EXISTS (
  SELECT 1 FROM migration_020_aborted_forks AS aborted
  WHERE aborted.child_reused = 0
    AND aborted.tenant_id = application_threads.tenant_id
    AND aborted.owner_principal_id = application_threads.owner_principal_id
    AND aborted.reserved_child_thread_id = application_threads.id
);

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
  AND NEW.provider_parent_backend_conversation_id IS
    OLD.provider_parent_backend_conversation_id
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
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
) OR (
  OLD.origin_kind = 'imported_native_fork'
  AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
  AND OLD.source_thread_state = 'unresolved' AND OLD.source_thread_id IS NULL
  AND NEW.source_thread_state = 'resolved' AND NEW.source_thread_id IS NOT NULL
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.owner_principal_id = OLD.owner_principal_id
  AND NEW.child_thread_id = OLD.child_thread_id
  AND NEW.provider_parent_backend_conversation_id =
    OLD.provider_parent_backend_conversation_id
  AND NEW.environment_id = OLD.environment_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.backend_instance_id = OLD.backend_instance_id
  AND NEW.connection_profile_id = OLD.connection_profile_id
  AND NEW.source_turn_revision IS OLD.source_turn_revision
  AND NEW.boundary_kind = OLD.boundary_kind
  AND NEW.origin_kind = OLD.origin_kind
  AND NEW.initiating_principal_id IS OLD.initiating_principal_id
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.committed_at = OLD.committed_at
) OR (
  OLD.origin_kind = 'imported_native_fork'
  AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
  AND OLD.source_thread_state = 'resolved'
  AND NEW.source_thread_state = 'resolved'
  AND NEW.source_thread_id = OLD.source_thread_id
  AND OLD.source_turn_state = 'unresolved' AND OLD.source_turn_id IS NULL
  AND NEW.source_turn_state = 'resolved' AND NEW.source_turn_id IS NOT NULL
  AND OLD.source_checkpoint_id IS NULL
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.owner_principal_id = OLD.owner_principal_id
  AND NEW.child_thread_id = OLD.child_thread_id
  AND NEW.provider_parent_backend_conversation_id =
    OLD.provider_parent_backend_conversation_id
  AND NEW.environment_id = OLD.environment_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.backend_instance_id = OLD.backend_instance_id
  AND NEW.connection_profile_id = OLD.connection_profile_id
  AND NEW.source_turn_revision IS OLD.source_turn_revision
  AND NEW.boundary_kind = OLD.boundary_kind
  AND NEW.origin_kind = OLD.origin_kind
  AND NEW.initiating_principal_id IS OLD.initiating_principal_id
  AND NEW.source_automation_id IS OLD.source_automation_id
  AND NEW.source_automation_run_id IS OLD.source_automation_run_id
  AND NEW.branch_method = OLD.branch_method
  AND NEW.creation_operation_id IS OLD.creation_operation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.committed_at = OLD.committed_at
))
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TABLE thread_lineage_placement (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  placement_mode TEXT NOT NULL CHECK (placement_mode IN ('nested_under_source', 'top_level')),
  placement_state TEXT NOT NULL CHECK (placement_state IN ('default', 'explicit')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, child_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id)
    REFERENCES thread_fork_origins(tenant_id, owner_principal_id, child_thread_id)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO thread_fork_origins(
  tenant_id, owner_principal_id, child_thread_id,
  provider_parent_backend_conversation_id,
  source_thread_state, source_thread_id,
  environment_id, workspace_id, backend_instance_id, connection_profile_id,
  source_turn_state, source_turn_id, source_turn_revision,
  source_checkpoint_id, boundary_kind,
  origin_kind, initiating_principal_id, source_automation_id,
  source_automation_run_id, branch_method, creation_operation_id,
  origin_state, created_at, committed_at
)
SELECT candidate.tenant_id, candidate.owner_principal_id,
  candidate.child_thread_id, NULL, 'resolved', candidate.source_thread_id,
  source.environment_id, source.workspace_id, source.backend_instance_id,
  source.connection_profile_id, 'unresolved', NULL, NULL,
  candidate.source_checkpoint_id, 'completed_turn_inclusive',
  'automation_fork', candidate.owner_principal_id,
  candidate.source_automation_id, candidate.source_automation_run_id,
  'provider_native', candidate.creation_operation_id,
  CASE WHEN candidate.committed_at IS NULL THEN 'prepared' ELSE 'committed' END,
  candidate.created_at, candidate.committed_at
FROM migration_020_fork_candidates AS candidate
JOIN application_threads AS source
  ON source.tenant_id = candidate.tenant_id
  AND source.owner_principal_id = candidate.owner_principal_id
  AND source.id = candidate.source_thread_id;

INSERT INTO thread_lineage_placement
SELECT tenant_id, owner_principal_id, child_thread_id,
  'nested_under_source', 'default', 0, coalesce(committed_at, created_at)
FROM thread_fork_origins;

WITH RECURSIVE lineage(
  tenant_id, owner_principal_id, ancestor_thread_id,
  descendant_thread_id, depth, descendant_created_at
) AS (
  SELECT tenant_id, owner_principal_id, source_thread_id,
    child_thread_id, 1, created_at
  FROM thread_fork_origins
  WHERE source_thread_state = 'resolved' AND origin_state = 'committed'
  UNION ALL
  SELECT lineage.tenant_id, lineage.owner_principal_id,
    lineage.ancestor_thread_id, child.child_thread_id,
    lineage.depth + 1, child.created_at
  FROM lineage
  JOIN thread_fork_origins AS child
    ON child.tenant_id = lineage.tenant_id
    AND child.owner_principal_id = lineage.owner_principal_id
    AND child.source_thread_state = 'resolved'
    AND child.origin_state = 'committed'
    AND child.source_thread_id = lineage.descendant_thread_id
)
INSERT INTO thread_lineage_closure(
  tenant_id, owner_principal_id, ancestor_thread_id,
  descendant_thread_id, depth, descendant_created_at
)
SELECT tenant_id, owner_principal_id, ancestor_thread_id,
  descendant_thread_id, depth, descendant_created_at
FROM lineage;

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
    source.depth + 1 + descendant.depth,
    descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
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
    source.depth + 1 + descendant.depth,
    descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
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
    source.depth + 1 + descendant.depth,
    descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id
      AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;

DROP TABLE migration_020_target_guard;
DROP TABLE migration_020_candidate_conflicts;
DROP TABLE migration_020_fork_candidates;
DROP TABLE migration_020_aborted_forks;
`,
} as const;
