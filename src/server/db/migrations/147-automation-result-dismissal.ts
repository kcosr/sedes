import type { DatabaseMigration } from "../migrate.js";

/** A dismissal of delivery must not acknowledge a subsequently failed turn. */
export const automationResultDismissalMigration: DatabaseMigration = {
  version: 147,
  name: "automation_result_dismissal",
  sql: `
DROP TRIGGER automation_runs_ack_immutable;

-- These dismissals preceded the failure, so the user has not acknowledged it.
UPDATE automation_runs
SET acknowledged_at = NULL
WHERE state = 'completed' AND force_reset_at IS NULL
  AND turn_outcome IN ('failed', 'interrupted')
  AND acknowledged_at < turn_settled_at
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
