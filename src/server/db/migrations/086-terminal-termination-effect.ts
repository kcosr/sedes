import type { DatabaseMigration } from "../migrate.js";

export const terminalTerminationEffectMigration: DatabaseMigration = {
  version: 86,
  name: "terminal_termination_effect",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE terminals ADD COLUMN termination_effect TEXT NOT NULL DEFAULT 'end_process'
  CHECK (termination_effect IN ('end_process', 'disconnect_transport'));
ALTER TABLE terminals ADD COLUMN delete_transport_closed INTEGER
  CHECK (delete_transport_closed IS NULL OR delete_transport_closed IN (0, 1));

UPDATE terminals SET termination_effect = 'disconnect_transport'
WHERE EXISTS (
  SELECT 1 FROM execution_environments AS environment
  WHERE environment.tenant_id = terminals.tenant_id
    AND environment.owner_principal_id = terminals.owner_principal_id
    AND environment.id = terminals.environment_id
    AND environment.kind = 'ssh'
);
UPDATE terminals SET delete_transport_closed = 0 WHERE delete_mutation_id IS NOT NULL;

CREATE TRIGGER terminal_termination_effect_immutable
BEFORE UPDATE OF termination_effect ON terminals
WHEN NEW.termination_effect <> OLD.termination_effect
BEGIN
  SELECT RAISE(ABORT, 'Terminal termination effect is immutable');
END;
`,
};
