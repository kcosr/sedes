import type { DatabaseMigration } from "../migrate.js";

/**
 * Records how the agent turn an automation run started ended, from the
 * backend-neutral completion rail. The settlement is run history only: it is
 * separate from the run state, which keeps meaning delivery.
 *
 * - `turn_id`, `turn_outcome` and `turn_settled_at` (Sedes's observation of the
 *   turn end) are set together and never change once set.
 * - `turn_started_at` and `turn_ended_at` are the turn's own times when the
 *   backend reports them. Each needs a settlement, may be filled in later by
 *   a replay that carries it, and never changes once set.
 * - Lookups from a rail observation go by dispatch mutation; failed turns are
 *   indexed for the run-history problems filter and counts.
 *
 * Runs whose turn the rail already settled are backfilled. Force-reset runs
 * are immutable and stay unsettled.
 *
 * `automation_definitions.runs_revision` advances with every change to the
 * definition's run history that clients present: a new run, or a change to a
 * presented run column, including its turn settlement and turn times. Triggers
 * keep it in the run's own statement, so no writer can miss it, and an update
 * that leaves those columns unchanged does not advance it.
 */
export const automationTurnSettlementMigration: DatabaseMigration = {
  version: 136,
  name: "automation_turn_settlement",
  sql: `
ALTER TABLE automation_runs
  ADD COLUMN turn_id TEXT CHECK (
    turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 160
  );
ALTER TABLE automation_runs
  ADD COLUMN turn_outcome TEXT CHECK (
    turn_outcome IS NULL
    OR turn_outcome IN ('completed', 'interrupted', 'failed')
  );
ALTER TABLE automation_runs
  ADD COLUMN turn_settled_at INTEGER CHECK (
    turn_settled_at IS NULL OR turn_settled_at >= 0
  );
ALTER TABLE automation_runs
  ADD COLUMN turn_started_at INTEGER CHECK (
    turn_started_at IS NULL OR turn_started_at >= 0
  );
ALTER TABLE automation_runs
  ADD COLUMN turn_ended_at INTEGER CHECK (
    turn_ended_at IS NULL OR (
      turn_ended_at >= 0
      AND (turn_started_at IS NULL OR turn_ended_at >= turn_started_at)
    )
  );

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

CREATE INDEX automation_runs_dispatch_mutation
  ON automation_runs(tenant_id, owner_principal_id, dispatch_mutation_id);
CREATE INDEX automation_runs_failed_turn_history
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id,
    created_at DESC, id DESC, state
  )
  WHERE turn_outcome = 'failed';

UPDATE automation_runs AS run
SET turn_id = observation.application_turn_id,
  turn_outcome = observation.completion_outcome,
  turn_settled_at = observation.completion_observed_at
FROM submission_completion_observations AS observation
WHERE observation.tenant_id = run.tenant_id
  AND observation.owner_principal_id = run.owner_principal_id
  AND observation.application_thread_id =
    coalesce(run.child_thread_id, run.anchor_thread_id)
  AND observation.operation_id = run.dispatch_mutation_id
  AND observation.application_turn_id IS NOT NULL
  AND run.turn_id IS NULL
  AND run.force_reset_at IS NULL;

ALTER TABLE automation_definitions
  ADD COLUMN runs_revision INTEGER NOT NULL DEFAULT 0 CHECK (runs_revision >= 0);

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
BEGIN
  UPDATE automation_definitions SET runs_revision = runs_revision + 1
  WHERE tenant_id = NEW.tenant_id
    AND owner_principal_id = NEW.owner_principal_id
    AND id = NEW.automation_id;
END;
`,
};
