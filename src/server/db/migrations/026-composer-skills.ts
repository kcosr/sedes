import type { DatabaseMigration } from "../migrate.js";

export const composerSkillsMigration: DatabaseMigration = {
  version: 26,
  name: "composer-skills",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE thread_drafts
  ADD COLUMN selected_skill_id TEXT
  CHECK (selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160);

ALTER TABLE prompt_stashes
  ADD COLUMN selected_skill_id TEXT
  CHECK (selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160);

ALTER TABLE queued_inputs
  ADD COLUMN selected_skill_id TEXT
  CHECK (selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160);

ALTER TABLE conversation_creation_attempts
  ADD COLUMN initial_skill_id TEXT
  CHECK (initial_skill_id IS NULL OR length(initial_skill_id) BETWEEN 1 AND 160);

UPDATE mutation_receipts
SET result_json = json_set(
  result_json,
  '$.version', 2,
  '$.selectedSkillId', NULL
)
WHERE operation_kind = 'conversation_steer';
`,
};
