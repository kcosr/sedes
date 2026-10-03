import type { DatabaseMigration } from "../migrate.js";

const completedPlaced = `NEW.completed_at IS NOT NULL AND (NEW.pinned = 1 OR NEW.backlog = 1)`;

/**
 * A task's backlog flag is its stage: still open, but not current work. Pin
 * stays its priority, so the two are independent.
 *
 * Completing a task clears both, and the triggers keep a completed task
 * unpinned and out of the backlog. Tasks completed before this migration
 * lose their pin; that is a real change to the row, so it takes a revision.
 * `updated_at` is left alone so "Recently updated" ordering does not move.
 *
 * Task mutation receipts replay the record they committed, so each gains
 * `backlog: false`. Their pins are left as committed. Request fingerprints
 * are unchanged: a request without `backlog` fingerprints as before.
 */
export const taskBacklogMigration: DatabaseMigration = {
  version: 128,
  name: "task_backlog",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE tasks ADD COLUMN backlog INTEGER NOT NULL DEFAULT 0
  CHECK (backlog IN (0, 1));

UPDATE tasks SET pinned = 0, revision = revision + 1
WHERE completed_at IS NOT NULL AND pinned = 1;

CREATE TRIGGER tasks_completed_unplaced_insert BEFORE INSERT ON tasks
WHEN ${completedPlaced}
BEGIN SELECT RAISE(ABORT, 'A completed task cannot be pinned or in the backlog.'); END;
CREATE TRIGGER tasks_completed_unplaced_update
BEFORE UPDATE OF completed_at, pinned, backlog ON tasks
WHEN ${completedPlaced}
BEGIN SELECT RAISE(ABORT, 'A completed task cannot be pinned or in the backlog.'); END;

UPDATE task_mutation_receipts
SET result_json = json_set(result_json, '$.record.backlog', json('false'))
WHERE operation_kind IN ('create_task', 'update_task', 'move_task')
  AND json_type(result_json, '$.record.backlog') IS NULL;
`,
};
