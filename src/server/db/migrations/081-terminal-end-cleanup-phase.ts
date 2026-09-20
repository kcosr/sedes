import type { DatabaseMigration } from "../migrate.js";

export const terminalEndCleanupPhaseMigration: DatabaseMigration = {
  version: 81,
  name: "terminal_end_cleanup_phase",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE terminals ADD COLUMN delete_cleanup_confirmed INTEGER
  CHECK (delete_cleanup_confirmed IS NULL OR delete_cleanup_confirmed IN (0, 1));

UPDATE terminals
SET delete_cleanup_confirmed = CASE
  WHEN delete_operation_kind = 'terminal_end' THEN 0
  ELSE 1
END
WHERE delete_mutation_id IS NOT NULL;
`,
};
