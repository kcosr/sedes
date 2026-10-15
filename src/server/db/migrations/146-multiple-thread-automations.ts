import type { DatabaseMigration } from "../migrate.js";

/** Retains historical IDs and provenance while making pending delivery durable. */
export const multipleThreadAutomationsMigration: DatabaseMigration = {
  version: 146,
  name: "multiple_thread_automations",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
DROP INDEX automation_definitions_one_per_thread;
CREATE INDEX automation_definitions_thread_history ON automation_definitions(tenant_id,owner_principal_id,anchor_thread_id);

CREATE TABLE automation_runs_v146 (
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
    'skipped', 'uncertain', 'deferred', 'cancelled'
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
  precheck_stdout_included INTEGER CHECK (precheck_stdout_included IS NULL OR precheck_stdout_included IN (0, 1)), force_reset_at INTEGER
    CHECK (force_reset_at IS NULL OR force_reset_at >= created_at), force_reset_mutation_id TEXT
    CHECK (
      (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
      OR (
        force_reset_at IS NOT NULL
        AND length(force_reset_mutation_id) BETWEEN 1 AND 128
      )
    ), turn_id TEXT CHECK (
    turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 160
  ), turn_outcome TEXT CHECK (
    turn_outcome IS NULL
    OR turn_outcome IN ('completed', 'interrupted', 'failed')
  ), turn_settled_at INTEGER CHECK (
    turn_settled_at IS NULL OR turn_settled_at >= 0
  ), turn_started_at INTEGER CHECK (
    turn_started_at IS NULL OR turn_started_at >= 0
  ), turn_ended_at INTEGER CHECK (
    turn_ended_at IS NULL OR (
      turn_ended_at >= 0
      AND (turn_started_at IS NULL OR turn_ended_at >= turn_started_at)
    )
  ),
  deferred_reason TEXT CHECK (deferred_reason IS NULL OR deferred_reason IN (
    'snoozed', 'archived', 'project_removed', 'sibling', 'source_materializing',
    'source_recovery', 'source_busy', 'queue_capacity'
  )),
  eligible_at INTEGER CHECK (eligible_at IS NULL OR eligible_at >= 0),
  initial_eligible_at INTEGER NOT NULL CHECK (initial_eligible_at >= 0),
  suppressed_at INTEGER CHECK (suppressed_at IS NULL OR suppressed_at >= 0),
  suppression_pending INTEGER NOT NULL DEFAULT 0 CHECK (suppression_pending IN (0,1)),
  precheck_stdout TEXT,
  acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, automation_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'deferred' AND deferred_reason IS NOT NULL)
    OR state <> 'deferred'),
  CHECK ((run_mode = 'same_thread' AND child_thread_id IS NULL) OR run_mode = 'clone'),
  CHECK (
    (state IN ('claimed', 'dispatching') AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('claimed', 'dispatching') AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('claimed', 'dispatching', 'uncertain', 'deferred') AND prompt_snapshot IS NOT NULL)
    OR (state IN ('completed', 'failed', 'skipped', 'cancelled') AND prompt_snapshot IS NULL)
    OR state IN ('queued', 'running')
  ),
  CHECK (
    (state IN ('claimed', 'deferred') AND started_at IS NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR (state = 'dispatching' AND started_at IS NOT NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR (state IN ('queued', 'running') AND started_at IS NOT NULL AND accepted_at IS NOT NULL AND finished_at IS NULL)
    OR (state = 'uncertain' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('completed', 'failed', 'skipped', 'cancelled') AND finished_at IS NOT NULL)
  ),
  CHECK (
    (precheck_command_snapshot IS NULL) = (precheck_timeout_seconds IS NULL)
    AND (precheck_command_snapshot IS NULL) = (precheck_include_stdout IS NULL)
    AND ((precheck_command_snapshot IS NULL AND precheck_status = 'not_configured')
      OR (precheck_command_snapshot IS NOT NULL AND precheck_status <> 'not_configured'))
  )
) STRICT;

INSERT INTO automation_runs_v146(tenant_id,owner_principal_id,automation_id,id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,coalesced_count,run_mode,state,claim_token,lease_expires_at,claim_attempt_count,prompt_snapshot,dispatch_mutation_id,anchor_thread_id,child_thread_id,error_code,error_diagnostic,claimed_at,started_at,accepted_at,finished_at,created_at,updated_at,precheck_command_snapshot,precheck_timeout_seconds,precheck_include_stdout,precheck_status,precheck_started_at,precheck_finished_at,precheck_exit_code,precheck_duration_ms,precheck_stdout_bytes,precheck_stdout_included,force_reset_at,force_reset_mutation_id,turn_id,turn_outcome,turn_settled_at,turn_started_at,turn_ended_at,initial_eligible_at)
SELECT tenant_id,owner_principal_id,automation_id,id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,coalesced_count,run_mode,state,claim_token,lease_expires_at,claim_attempt_count,prompt_snapshot,dispatch_mutation_id,anchor_thread_id,child_thread_id,error_code,error_diagnostic,claimed_at,started_at,accepted_at,finished_at,created_at,updated_at,precheck_command_snapshot,precheck_timeout_seconds,precheck_include_stdout,precheck_status,precheck_started_at,precheck_finished_at,precheck_exit_code,precheck_duration_ms,precheck_stdout_bytes,precheck_stdout_included,force_reset_at,force_reset_mutation_id,turn_id,turn_outcome,turn_settled_at,turn_started_at,turn_ended_at,scheduled_for FROM automation_runs;

DROP TABLE automation_runs;

ALTER TABLE automation_runs_v146 RENAME TO automation_runs;

CREATE INDEX automation_runs_anchor_state
  ON automation_runs(tenant_id, owner_principal_id, anchor_thread_id, state);

CREATE UNIQUE INDEX automation_runs_child_lineage
  ON automation_runs(tenant_id, owner_principal_id, child_thread_id)
  WHERE child_thread_id IS NOT NULL;

CREATE INDEX automation_runs_dispatch_mutation
  ON automation_runs(tenant_id, owner_principal_id, dispatch_mutation_id);

CREATE INDEX automation_runs_expired_claims
  ON automation_runs(lease_expires_at, tenant_id, owner_principal_id, automation_id, id)
  WHERE state IN ('claimed', 'dispatching');

CREATE INDEX automation_runs_failed_turn_history
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id,
    created_at DESC, id DESC, state
  )
  WHERE turn_outcome = 'failed';

CREATE INDEX automation_runs_history
  ON automation_runs(tenant_id, owner_principal_id, automation_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX automation_runs_occurrence_key_unique
  ON automation_runs(tenant_id, owner_principal_id, automation_id, occurrence_key);

CREATE UNIQUE INDEX automation_runs_one_nonterminal
  ON automation_runs(tenant_id, owner_principal_id, automation_id)
  WHERE state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain', 'deferred');

CREATE INDEX automation_runs_state_history
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id, state,
    created_at DESC, id DESC
  );

CREATE TRIGGER automation_runs_force_reset_immutable_delete
BEFORE DELETE ON automation_runs
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation run is immutable');
END;

CREATE TRIGGER automation_runs_force_reset_immutable_update
BEFORE UPDATE ON automation_runs
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation run is immutable');
END;

CREATE TRIGGER automation_runs_history_revision_insert
AFTER INSERT ON automation_runs
BEGIN
  UPDATE automation_definitions SET runs_revision = runs_revision + 1
  WHERE tenant_id = NEW.tenant_id
    AND owner_principal_id = NEW.owner_principal_id
    AND id = NEW.automation_id;
END;

CREATE TRIGGER automation_runs_history_revision_update
AFTER UPDATE ON automation_runs
WHEN NEW.state IS NOT OLD.state
  OR NEW.occurrence_kind IS NOT OLD.occurrence_kind
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.definition_revision IS NOT OLD.definition_revision
  OR NEW.coalesced_count IS NOT OLD.coalesced_count
  OR NEW.run_mode IS NOT OLD.run_mode
  OR NEW.anchor_thread_id IS NOT OLD.anchor_thread_id
  OR NEW.child_thread_id IS NOT OLD.child_thread_id
  OR NEW.error_code IS NOT OLD.error_code
  OR NEW.error_diagnostic IS NOT OLD.error_diagnostic
  OR NEW.claimed_at IS NOT OLD.claimed_at
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.accepted_at IS NOT OLD.accepted_at
  OR NEW.finished_at IS NOT OLD.finished_at
  OR NEW.force_reset_at IS NOT OLD.force_reset_at
  OR NEW.precheck_status IS NOT OLD.precheck_status
  OR NEW.precheck_command_snapshot IS NOT OLD.precheck_command_snapshot
  OR NEW.precheck_timeout_seconds IS NOT OLD.precheck_timeout_seconds
  OR NEW.precheck_exit_code IS NOT OLD.precheck_exit_code
  OR NEW.precheck_duration_ms IS NOT OLD.precheck_duration_ms
  OR NEW.precheck_stdout_bytes IS NOT OLD.precheck_stdout_bytes
  OR NEW.precheck_stdout_included IS NOT OLD.precheck_stdout_included
  OR NEW.turn_id IS NOT OLD.turn_id
  OR NEW.turn_outcome IS NOT OLD.turn_outcome
  OR NEW.turn_settled_at IS NOT OLD.turn_settled_at
  OR NEW.turn_started_at IS NOT OLD.turn_started_at
  OR NEW.turn_ended_at IS NOT OLD.turn_ended_at
  OR NEW.deferred_reason IS NOT OLD.deferred_reason
  OR NEW.eligible_at IS NOT OLD.eligible_at
  OR NEW.acknowledged_at IS NOT OLD.acknowledged_at
BEGIN
  UPDATE automation_definitions SET runs_revision = runs_revision + 1
  WHERE tenant_id = NEW.tenant_id
    AND owner_principal_id = NEW.owner_principal_id
    AND id = NEW.automation_id;
END;

CREATE TRIGGER automation_runs_project_admission BEFORE INSERT ON automation_runs
    WHEN EXISTS (SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
      ON workspace.tenant_id = thread.tenant_id AND workspace.owner_principal_id = thread.owner_principal_id
      AND workspace.id = thread.workspace_id
      WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.owner_principal_id
        AND thread.id = NEW.anchor_thread_id AND workspace.removed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before starting new work.'); END;

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

CREATE TRIGGER automation_runs_turn_settlement_immutable
BEFORE UPDATE OF turn_id, turn_outcome, turn_settled_at, turn_started_at,
  turn_ended_at
ON automation_runs
WHEN (
  OLD.turn_id IS NOT NULL AND (
    NEW.turn_id IS NOT OLD.turn_id
    OR NEW.turn_outcome IS NOT OLD.turn_outcome
    OR NEW.turn_settled_at IS NOT OLD.turn_settled_at
  )
)
OR (
  OLD.turn_started_at IS NOT NULL
  AND NEW.turn_started_at IS NOT OLD.turn_started_at
)
OR (
  OLD.turn_ended_at IS NOT NULL
  AND NEW.turn_ended_at IS NOT OLD.turn_ended_at
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run turn settlement is immutable');
END;

CREATE TRIGGER automation_runs_turn_settlement_insert
BEFORE INSERT ON automation_runs
WHEN NOT (
  (NEW.turn_id IS NULL
    AND NEW.turn_outcome IS NULL
    AND NEW.turn_settled_at IS NULL
    AND NEW.turn_started_at IS NULL
    AND NEW.turn_ended_at IS NULL)
  OR
  (NEW.turn_id IS NOT NULL
    AND NEW.turn_outcome IS NOT NULL
    AND NEW.turn_settled_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run turn settlement is incomplete');
END;

CREATE TRIGGER automation_runs_turn_settlement_update
BEFORE UPDATE OF turn_id, turn_outcome, turn_settled_at, turn_started_at,
  turn_ended_at
ON automation_runs
WHEN NOT (
  (NEW.turn_id IS NULL
    AND NEW.turn_outcome IS NULL
    AND NEW.turn_settled_at IS NULL
    AND NEW.turn_started_at IS NULL
    AND NEW.turn_ended_at IS NULL)
  OR
  (NEW.turn_id IS NOT NULL
    AND NEW.turn_outcome IS NOT NULL
    AND NEW.turn_settled_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run turn settlement is incomplete');
END;

CREATE INDEX automation_runs_deferred ON automation_runs(eligible_at,created_at,id) WHERE state = 'deferred';

CREATE TRIGGER automation_runs_ack_immutable BEFORE UPDATE OF acknowledged_at ON automation_runs
WHEN OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at
BEGIN SELECT RAISE(ABORT, 'Automation acknowledgement is immutable'); END;
`,
};
