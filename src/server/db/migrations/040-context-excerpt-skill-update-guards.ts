import type { DatabaseMigration } from "../migrate.js";

const sqliteWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((codePoint) => `char(${codePoint})`)
  .join(" || ");

const isNonWhitespace = (value: string) =>
  `trim(${value}, ${sqliteWhitespace}) <> ''`;

const annotatedContext = (column: string) => `EXISTS (
    SELECT 1
    FROM json_each(${column}) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND ${isNonWhitespace("json_extract(excerpt.value, '$.note')")}
  )`;

/**
 * Keeps the empty-input guards active when a skill is removed from an
 * otherwise empty queued or first-input payload.
 */
export const contextExcerptSkillUpdateGuardsMigration: DatabaseMigration = {
  version: 40,
  name: "context-excerpt-skill-update-guards",
  sql: `
DROP TRIGGER queued_inputs_content_update;

CREATE TRIGGER queued_inputs_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json
ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

DROP TRIGGER conversation_creation_attempts_content_update;

CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_skill_id,
  initial_context_excerpts_json
ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;
`,
};
