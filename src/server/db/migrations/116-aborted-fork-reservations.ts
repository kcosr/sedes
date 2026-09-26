import type { DatabaseMigration } from "../migrate.js";

/**
 * An aborted fork keeps its application-reserved native child identity, so
 * discovery never imports an orphaned provider child under the source's
 * title, and records whether starting another fork of the same boundary is
 * worth offering. Older aborted forks recorded neither.
 */
export const abortedForkReservationsMigration: DatabaseMigration = {
  version: 116,
  name: "aborted_fork_reservations",
  sql: `
ALTER TABLE aborted_thread_forks ADD COLUMN reserved_backend_instance_id TEXT CHECK (
  reserved_backend_instance_id IS NULL OR length(reserved_backend_instance_id) BETWEEN 1 AND 160
);
ALTER TABLE aborted_thread_forks ADD COLUMN reserved_backend_conversation_id TEXT CHECK (
  reserved_backend_conversation_id IS NULL OR length(reserved_backend_conversation_id) BETWEEN 1 AND 512
);
ALTER TABLE aborted_thread_forks ADD COLUMN restartable INTEGER NOT NULL DEFAULT 1 CHECK (restartable IN (0, 1));
CREATE INDEX aborted_thread_forks_reserved_child
  ON aborted_thread_forks(tenant_id, owner_principal_id, reserved_backend_instance_id, reserved_backend_conversation_id)
  WHERE reserved_backend_conversation_id IS NOT NULL;
`,
};
