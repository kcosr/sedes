import type { DatabaseMigration } from "../migrate.js";

export const userInputRevisionMigration: DatabaseMigration = {
  version: 141,
  name: "user_input_revision",
  sql: `
ALTER TABLE application_threads ADD COLUMN user_input_revision INTEGER NOT NULL DEFAULT 0
  CHECK (user_input_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE queued_inputs ADD COLUMN is_user_input INTEGER NOT NULL DEFAULT 0
  CHECK (is_user_input IN (0, 1));
-- Existing ordinary inputs, including their retry rows, keep their classification.
UPDATE queued_inputs SET is_user_input = 1
WHERE trigger_kind = 'user' AND initiating_agent_thread_id IS NULL
  AND initiating_tool_client_id IS NULL AND completion_callback_id IS NULL;
CREATE TRIGGER queued_input_user_classification_immutable
BEFORE UPDATE OF is_user_input ON queued_inputs
WHEN NEW.is_user_input IS NOT OLD.is_user_input
BEGIN SELECT RAISE(ABORT, 'Queued input user classification is immutable'); END;
CREATE INDEX queued_input_user_supersession ON queued_inputs(
  tenant_id, owner_principal_id, application_thread_id, state
) WHERE is_user_input = 1;
`,
};
