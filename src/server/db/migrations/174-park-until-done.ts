import type { DatabaseMigration } from "../migrate.js";

export const parkUntilDoneMigration: DatabaseMigration = {
  version: 174,
  name: "park_until_done",
  sql: `
ALTER TABLE thread_principal_state ADD COLUMN parked_until_turn_id TEXT
  CHECK (parked_until_turn_id IS NULL OR length(parked_until_turn_id) BETWEEN 1 AND 160);
ALTER TABLE thread_principal_state ADD COLUMN progress_park_revision INTEGER NOT NULL DEFAULT 0
  CHECK (progress_park_revision BETWEEN 0 AND 9007199254740991);

-- A root submit prepared in the current unparked epoch proves that a later
-- live progress item in its turn opened after the last park, even on reattach.
ALTER TABLE delivery_input_snapshots ADD COLUMN root_submit_park_revision INTEGER
  CHECK (root_submit_park_revision BETWEEN 0 AND 9007199254740991);

-- Existing manual parks have no observed turn to unpark, but their open
-- progress items must remain silent if the user unparks after the upgrade.
UPDATE thread_principal_state SET progress_park_revision = 1 WHERE inventory_state = 'parked';

-- Single and bulk park, accepted input, automation, reset and manual unpark
-- all change this row. Retire the old target even for a non-manual transition.
CREATE TRIGGER inventory_park_transition AFTER UPDATE OF inventory_state ON thread_principal_state
WHEN OLD.inventory_state <> NEW.inventory_state
  AND (OLD.inventory_state = 'parked' OR NEW.inventory_state = 'parked')
BEGIN
  UPDATE thread_principal_state
    SET parked_until_turn_id = NULL,
        progress_park_revision = progress_park_revision + (NEW.inventory_state = 'parked')
    WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id AND thread_id = NEW.thread_id;
END;
`,
};
