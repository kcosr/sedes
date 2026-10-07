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
`,
};
