import type { DatabaseMigration } from "../migrate.js";

/** A dismissal of delivery must not acknowledge a subsequently failed turn. */
export const automationResultDismissalMigration: DatabaseMigration = {
  version: 147,
  name: "automation_result_dismissal",
  sql: `
DROP TRIGGER automation_runs_ack_immutable;

-- These dismissals preceded the failure, so the user has not acknowledged it.
--
-- Migration 146 introduced per-run acknowledgement. For every delivered or
-- failed run without a legacy notice slot (a dismissed or superseded notice,
-- or a run that never had one) it carried that state forward as
-- acknowledged_at = coalesce(finished_at, updated_at), which is finished_at
-- because both states require it. The backdated value precedes any turn
-- settlement; the carried-over acknowledgement really took effect when 146
-- was applied. A turn settled by then failed under a release that had no
-- turn-failure notice, so there is nothing to reopen. A turn settled later
-- failed after that acknowledgement, exactly like a failure after a real
-- dismissal, and is reopened as current settlement does atomically. A real
-- dismissal is recorded after 146 was applied, so any failure it precedes
-- settled after 146 too and is always reopened. When 146 and 147 are applied
-- together, no carried-over acknowledgement is reopened here; turns still
-- running at the upgrade are handled by settlement.
UPDATE automation_runs
SET acknowledged_at = NULL
WHERE state = 'completed' AND force_reset_at IS NULL
  AND turn_outcome IN ('failed', 'interrupted')
  AND acknowledged_at < turn_settled_at
  AND NOT (
    acknowledged_at = finished_at
    AND turn_settled_at <= (
      SELECT applied_at FROM schema_migrations WHERE version = 146
    )
  )
  AND EXISTS (
    SELECT 1 FROM automation_definitions AS definition
    WHERE definition.tenant_id = automation_runs.tenant_id
      AND definition.owner_principal_id = automation_runs.owner_principal_id
      AND definition.id = automation_runs.automation_id
      AND definition.deleted_at IS NULL
  );

CREATE TRIGGER automation_runs_ack_immutable
BEFORE UPDATE OF acknowledged_at ON automation_runs
WHEN OLD.acknowledged_at IS NOT NULL
  AND NEW.acknowledged_at IS NOT OLD.acknowledged_at
  AND NOT (
    OLD.state = 'completed' AND NEW.state = 'completed'
    AND OLD.turn_id IS NULL AND NEW.turn_id IS NOT NULL
    AND NEW.turn_outcome IN ('failed', 'interrupted')
    AND NEW.acknowledged_at IS NULL
  )
BEGIN SELECT RAISE(ABORT, 'Automation acknowledgement is immutable'); END;

DROP INDEX automation_runs_failed_turn_history;
CREATE INDEX automation_runs_problem_turn_history
  ON automation_runs(tenant_id, owner_principal_id, automation_id,
    created_at DESC, id DESC, state, turn_outcome)
  WHERE turn_outcome IN ('failed', 'interrupted');
`,
};
