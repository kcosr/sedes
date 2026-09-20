import type { DatabaseMigration } from "../migrate.js";
import { annotatedContext, isNonWhitespace } from "./038-context-excerpts.js";

const taskArrayConstraint = (column: string) => `
  CHECK (
    json_valid(${column})
    AND json_type(${column}) = 'array'
    AND length(CAST(${column} AS BLOB)) <= 4194304
  )`;

/**
 * Drafts and stashes retain live principal-owned task references. Every
 * delivery authority snapshots those references into immutable task contexts
 * before it consumes or fences the draft. Neither shape has a foreign key to
 * tasks: deletion must leave a visible missing draft reference and must not
 * invalidate already accepted work.
 */
export const composerTaskReferencesMigration: DatabaseMigration = {
  version: 55,
  name: "composer-task-references",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE thread_drafts
  ADD COLUMN task_references_json TEXT NOT NULL DEFAULT '[]'
  ${taskArrayConstraint("task_references_json")};

ALTER TABLE prompt_stashes
  ADD COLUMN task_references_json TEXT NOT NULL DEFAULT '[]'
  ${taskArrayConstraint("task_references_json")};

ALTER TABLE queued_inputs
  ADD COLUMN task_contexts_json TEXT NOT NULL DEFAULT '[]'
  ${taskArrayConstraint("task_contexts_json")};

ALTER TABLE queued_inputs
  ADD COLUMN requested_delivery_mode TEXT
  CHECK (requested_delivery_mode IS NULL OR requested_delivery_mode IN ('submit', 'queue'));

ALTER TABLE queued_inputs
  ADD COLUMN requested_thread_revision INTEGER
  CHECK (requested_thread_revision IS NULL OR requested_thread_revision >= 0);

ALTER TABLE queued_inputs
  ADD COLUMN requested_draft_revision INTEGER
  CHECK (requested_draft_revision IS NULL OR requested_draft_revision >= 0)
  CHECK (
    (
      requested_delivery_mode IS NULL
      AND requested_thread_revision IS NULL
      AND requested_draft_revision IS NULL
    ) OR (
      requested_delivery_mode IS NOT NULL
      AND requested_thread_revision IS NOT NULL
      AND requested_draft_revision IS NOT NULL
      AND trigger_kind = 'user'
      AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND retry_of_id IS NULL
    )
  );

ALTER TABLE conversation_creation_attempts
  ADD COLUMN initial_task_contexts_json TEXT NOT NULL DEFAULT '[]'
  ${taskArrayConstraint("initial_task_contexts_json")};

ALTER TABLE mutation_receipts
  ADD COLUMN task_contexts_json TEXT NOT NULL DEFAULT '[]'
  ${taskArrayConstraint("task_contexts_json")};

DROP TRIGGER prompt_stashes_content_insert;
DROP TRIGGER prompt_stashes_content_update;
DROP TRIGGER queued_inputs_content_insert;
DROP TRIGGER queued_inputs_content_update;
DROP TRIGGER conversation_creation_attempts_content_insert;
DROP TRIGGER conversation_creation_attempts_content_update;

CREATE TRIGGER prompt_stashes_content_insert
BEFORE INSERT ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
  AND json_array_length(NEW.task_references_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM stash_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.principal_id = NEW.principal_id
      AND link.thread_id = NEW.thread_id
      AND link.stash_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

CREATE TRIGGER prompt_stashes_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json,
  task_references_json ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
  AND json_array_length(NEW.task_references_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM stash_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.principal_id = NEW.principal_id
      AND link.thread_id = NEW.thread_id
      AND link.stash_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

CREATE TRIGGER queued_inputs_content_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
  AND json_array_length(NEW.task_contexts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM queued_input_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.queued_input_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER queued_inputs_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json,
  task_contexts_json ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
  AND json_array_length(NEW.task_contexts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM queued_input_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.queued_input_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
  AND json_array_length(NEW.initial_task_contexts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM creation_attempt_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.attempt_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_skill_id,
  initial_context_excerpts_json, initial_task_contexts_json
ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
  AND json_array_length(NEW.initial_task_contexts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM creation_attempt_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.attempt_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;
`,
};
