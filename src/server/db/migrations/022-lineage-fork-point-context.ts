import type { DatabaseMigration } from "../migrate.js";

/**
 * Keeps the source turn's completion time with immutable provenance so the
 * application sidebar can describe the fork point without reopening provider
 * history. Older/imported origins remain explicitly unknown.
 */
export const lineageForkPointContextMigration: DatabaseMigration = {
  version: 22,
  name: "lineage-fork-point-context",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE thread_fork_origins
  ADD COLUMN source_turn_completed_at INTEGER CHECK (
    source_turn_completed_at IS NULL OR (
      source_turn_state = 'resolved'
      AND source_turn_id IS NOT NULL
    )
  );

CREATE TRIGGER thread_fork_origins_fork_point_immutable
BEFORE UPDATE OF source_turn_completed_at ON thread_fork_origins
WHEN NEW.source_turn_completed_at IS NOT OLD.source_turn_completed_at
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;
`,
};
