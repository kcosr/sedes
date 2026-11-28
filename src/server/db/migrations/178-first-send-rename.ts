import type { DatabaseMigration } from "../migrate.js";

export const firstSendRenameMigration: DatabaseMigration = {
  version: 178,
  name: "first_send_rename",
  sql: `
ALTER TABLE conversation_creation_attempts ADD COLUMN initial_rename_state TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (initial_rename_state IN ('not_sent', 'uncertain', 'accepted'));
ALTER TABLE conversation_creation_attempts ADD COLUMN initial_rename_operation_id TEXT;
ALTER TABLE conversation_creation_attempts ADD COLUMN initial_rename_title TEXT;

-- An older process may already have renamed an identified session before
-- stopping. Absence of a recorded response cannot authorize another write.
UPDATE conversation_creation_attempts SET initial_rename_state = 'uncertain'
WHERE creation_kind = 'first_input' AND provisional_backend_conversation_id IS NOT NULL
  AND phase IN ('conversation_identified', 'first_submission_started', 'recovery_required');
`,
};
