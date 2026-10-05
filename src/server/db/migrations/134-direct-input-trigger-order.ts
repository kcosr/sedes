import type { DatabaseMigration } from "../migrate.js";

/** Restore the pre-133 admission trigger creation order without rewriting
 * deployed migration history or changing durable rows and trigger definitions. */
export const directInputTriggerOrderMigration: DatabaseMigration = {
  version: 134,
  name: "direct_input_trigger_order",
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER conversation_creation_attempts_force_reset_immutable_update;
DROP TRIGGER conversation_creation_attempts_force_reset_immutable_delete;
DROP TRIGGER conversation_creation_attempts_fork_contract_insert;
DROP TRIGGER conversation_creation_attempts_fork_contract_update;
DROP TRIGGER conversation_creation_attempts_content_insert;
DROP TRIGGER conversation_creation_attempts_content_update;
DROP TRIGGER conversation_creation_force_reset_automation_insert;
DROP TRIGGER conversation_creation_attempts_project_admission;
DROP TRIGGER input_activity_creation_insert;
DROP TRIGGER input_activity_creation_update;
DROP TRIGGER queued_inputs_completion_callback_insert;
DROP TRIGGER queued_inputs_agent_control_provenance_insert;
DROP TRIGGER queued_inputs_principal_client_provenance_insert;
DROP TRIGGER queued_inputs_caller_provenance_update;
DROP TRIGGER queued_inputs_trigger_provenance_insert;
DROP TRIGGER queued_inputs_trigger_provenance_update;
DROP TRIGGER queued_inputs_retry_provenance_parent_update;
DROP TRIGGER queued_inputs_cancellation_marker_insert;
DROP TRIGGER queued_inputs_cancellation_marker_update;
DROP TRIGGER queued_inputs_content_insert;
DROP TRIGGER queued_inputs_content_update;
DROP TRIGGER queued_inputs_delivery_mode_insert;
DROP TRIGGER queued_inputs_delivery_mode_update;
DROP TRIGGER queued_inputs_force_reset_automation_insert;
DROP TRIGGER queued_inputs_automation_source_insert;
DROP TRIGGER queued_inputs_completion_callback_update;
DROP TRIGGER queued_inputs_project_admission;
DROP TRIGGER input_activity_queue_insert;
DROP TRIGGER input_activity_queue_update;

CREATE TRIGGER conversation_creation_attempts_force_reset_immutable_update
BEFORE UPDATE ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset creation attempt is immutable');
END;

CREATE TRIGGER conversation_creation_attempts_force_reset_immutable_delete
BEFORE DELETE ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset creation attempt is immutable');
END;

CREATE TRIGGER conversation_creation_attempts_fork_contract_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN (NEW.creation_kind = 'fork'
    AND (NEW.fork_child_identity IS NULL OR NEW.fork_creation_recovery IS NULL))
  OR (NEW.creation_kind = 'first_input'
    AND (NEW.fork_child_identity IS NOT NULL
      OR NEW.fork_creation_recovery IS NOT NULL
      OR NEW.fork_uncertainty_kind IS NOT NULL))
  OR (NEW.fork_uncertainty_kind = 'fork_unknown'
    AND (NEW.creation_kind <> 'fork'
      OR NEW.fork_creation_recovery <> 'potentially_unknown'
      OR NEW.phase <> 'recovery_required'))
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE TRIGGER conversation_creation_attempts_fork_contract_update
BEFORE UPDATE OF creation_kind, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, phase ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NULL AND ((OLD.creation_kind = 'fork'
    AND (NEW.fork_child_identity IS NOT OLD.fork_child_identity
      OR NEW.fork_creation_recovery IS NOT OLD.fork_creation_recovery))
  OR (NEW.creation_kind = 'fork'
    AND (NEW.fork_child_identity IS NULL OR NEW.fork_creation_recovery IS NULL))
  OR (NEW.creation_kind = 'first_input'
    AND (NEW.fork_child_identity IS NOT NULL
      OR NEW.fork_creation_recovery IS NOT NULL
      OR NEW.fork_uncertainty_kind IS NOT NULL))
  OR (NEW.fork_uncertainty_kind = 'fork_unknown'
    AND (NEW.creation_kind <> 'fork'
      OR NEW.fork_creation_recovery <> 'potentially_unknown'
      OR NEW.phase <> 'recovery_required')))
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE TRIGGER conversation_creation_attempts_content_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (trim(NEW.initial_input_text, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> '')
  AND NEW.initial_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.initial_context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> ''
  )
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
WHEN OLD.force_reset_at IS NULL
  AND NEW.initial_input_text IS NOT NULL
  AND NOT (trim(NEW.initial_input_text, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> '')
  AND NEW.initial_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.initial_context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> ''
  )
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

CREATE TRIGGER conversation_creation_force_reset_automation_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.source_automation_run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM automation_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.owner_principal_id = NEW.owner_principal_id
      AND run.automation_id = NEW.source_automation_id
      AND run.id = NEW.source_automation_run_id
      AND run.force_reset_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation cannot create a conversation');
END;

CREATE TRIGGER conversation_creation_attempts_project_admission BEFORE INSERT ON conversation_creation_attempts
    WHEN EXISTS (SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
      ON workspace.tenant_id = thread.tenant_id AND workspace.owner_principal_id = thread.owner_principal_id
      AND workspace.id = thread.workspace_id
      WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.owner_principal_id
        AND thread.id = NEW.application_thread_id AND workspace.removed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'The project was removed. Restore it before starting new work.'); END;

CREATE TRIGGER input_activity_creation_insert AFTER INSERT ON conversation_creation_attempts
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id AND id = NEW.application_thread_id;
END;

CREATE TRIGGER input_activity_creation_update AFTER UPDATE OF phase ON conversation_creation_attempts
WHEN OLD.phase IS NOT NEW.phase
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id AND id = NEW.application_thread_id;
END;

CREATE TRIGGER queued_inputs_completion_callback_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.completion_callback_id IS NOT NULL AND (
  NEW.trigger_kind <> 'user'
  OR NEW.source_automation_id IS NOT NULL
  OR NEW.source_automation_run_id IS NOT NULL
  OR NEW.initiating_agent_thread_id IS NOT NULL
  OR NEW.initiating_tool_client_id IS NOT NULL
  OR NEW.retry_of_id IS NOT NULL
  OR NEW.requested_thread_revision IS NOT NULL
  OR NEW.requested_draft_revision IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM thread_completion_callbacks AS callback
    WHERE callback.tenant_id = NEW.tenant_id
      AND callback.owner_principal_id = NEW.owner_principal_id
      AND callback.id = NEW.completion_callback_id
      AND callback.caller_thread_id = NEW.application_thread_id
      AND callback.state = 'registered'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Completion callback queue provenance is invalid');
END;

CREATE TRIGGER queued_inputs_agent_control_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT NULL AND (
  NEW.trigger_kind <> 'user'
  OR NEW.source_automation_id IS NOT NULL
  OR NEW.source_automation_run_id IS NOT NULL
  OR NEW.initiating_tool_client_id IS NOT NULL
  OR NEW.completion_callback_id IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM application_threads AS source
    WHERE source.tenant_id = NEW.tenant_id
      AND source.owner_principal_id = NEW.owner_principal_id
      AND source.id = NEW.initiating_agent_thread_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Agent-control queue source thread is invalid');
END;

CREATE TRIGGER queued_inputs_principal_client_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.initiating_tool_client_id IS NOT NULL AND (
  NEW.trigger_kind <> 'user'
  OR NEW.source_automation_id IS NOT NULL
  OR NEW.source_automation_run_id IS NOT NULL
  OR NEW.initiating_agent_thread_id IS NOT NULL
  OR NEW.completion_callback_id IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM principal_agent_tool_clients AS client
    WHERE client.tenant_id = NEW.tenant_id
      AND client.owner_principal_id = NEW.owner_principal_id
      AND client.id = NEW.initiating_tool_client_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Principal-client queue initiator is invalid');
END;

CREATE TRIGGER queued_inputs_caller_provenance_update
BEFORE UPDATE OF initiating_agent_thread_id, initiating_tool_client_id,
  completion_callback_id, trigger_kind, source_automation_id,
  source_automation_run_id ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
  OR NEW.initiating_tool_client_id IS NOT OLD.initiating_tool_client_id
  OR NEW.completion_callback_id IS NOT OLD.completion_callback_id
  OR NEW.trigger_kind IS NOT OLD.trigger_kind
  OR NEW.source_automation_id IS NOT OLD.source_automation_id
  OR NEW.source_automation_run_id IS NOT OLD.source_automation_run_id
BEGIN
  SELECT RAISE(ABORT, 'Queued input caller provenance is immutable');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.retry_of_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM queued_inputs AS parent
  WHERE parent.tenant_id = NEW.tenant_id
    AND parent.owner_principal_id = NEW.owner_principal_id
    AND parent.application_thread_id = NEW.application_thread_id
    AND parent.id = NEW.retry_of_id
    AND parent.trigger_kind = NEW.trigger_kind
    AND parent.source_automation_id IS NEW.source_automation_id
    AND parent.source_automation_run_id IS NEW.source_automation_run_id
    AND parent.initiating_agent_thread_id IS NEW.initiating_agent_thread_id
    AND parent.initiating_tool_client_id IS NEW.initiating_tool_client_id
    AND parent.completion_callback_id IS NEW.completion_callback_id
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input retry provenance is invalid');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_update
BEFORE UPDATE OF tenant_id, owner_principal_id, id, application_thread_id,
  mutation_id, retry_of_id, trigger_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id,
  initiating_tool_client_id, completion_callback_id ON queued_inputs
WHEN (NEW.retry_of_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM queued_inputs AS parent
  WHERE parent.tenant_id = NEW.tenant_id
    AND parent.owner_principal_id = NEW.owner_principal_id
    AND parent.application_thread_id = NEW.application_thread_id
    AND parent.id = NEW.retry_of_id
    AND parent.trigger_kind = NEW.trigger_kind
    AND parent.source_automation_id IS NEW.source_automation_id
    AND parent.source_automation_run_id IS NEW.source_automation_run_id
    AND parent.initiating_agent_thread_id IS NEW.initiating_agent_thread_id
    AND parent.initiating_tool_client_id IS NEW.initiating_tool_client_id
    AND parent.completion_callback_id IS NEW.completion_callback_id
)) OR (NEW.trigger_kind = 'automation' AND NOT EXISTS (
  SELECT 1 FROM automation_runs AS run
  WHERE run.tenant_id = NEW.tenant_id
    AND run.owner_principal_id = NEW.owner_principal_id
    AND run.automation_id = NEW.source_automation_id
    AND run.id = NEW.source_automation_run_id
    AND coalesce(run.child_thread_id, run.anchor_thread_id) =
      NEW.application_thread_id
    AND (NEW.retry_of_id IS NOT NULL
      OR run.dispatch_mutation_id = NEW.mutation_id)
))
BEGIN
  SELECT RAISE(ABORT, 'Queued input trigger provenance is invalid');
END;

CREATE TRIGGER queued_inputs_retry_provenance_parent_update
BEFORE UPDATE OF tenant_id, owner_principal_id, id, application_thread_id,
  trigger_kind, source_automation_id, source_automation_run_id,
  initiating_agent_thread_id, initiating_tool_client_id,
  completion_callback_id ON queued_inputs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS child
  WHERE child.tenant_id = OLD.tenant_id
    AND child.owner_principal_id = OLD.owner_principal_id
    AND child.application_thread_id = OLD.application_thread_id
    AND child.retry_of_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input retry provenance parent is referenced');
END;

CREATE TRIGGER queued_inputs_cancellation_marker_insert
BEFORE INSERT ON queued_inputs
WHEN NOT ((NEW.cancellation_mutation_id IS NULL
    AND NEW.cancellation_request_fingerprint IS NULL)
  OR (NEW.state = 'cancelled'
    AND NEW.cancellation_mutation_id IS NOT NULL
    AND NEW.cancellation_request_fingerprint IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'Queued input cancellation marker is invalid');
END;

CREATE TRIGGER queued_inputs_cancellation_marker_update
BEFORE UPDATE OF state, cancellation_mutation_id,
  cancellation_request_fingerprint ON queued_inputs
WHEN NOT ((NEW.cancellation_mutation_id IS NULL
    AND NEW.cancellation_request_fingerprint IS NULL)
  OR (NEW.state = 'cancelled'
    AND NEW.cancellation_mutation_id IS NOT NULL
    AND NEW.cancellation_request_fingerprint IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'Queued input cancellation marker is invalid');
END;

CREATE TRIGGER queued_inputs_content_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (trim(NEW.text, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> '')
  AND NEW.selected_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> ''
  )
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
WHEN NOT (trim(NEW.text, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> '')
  AND NEW.selected_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)) <> ''
  )
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

CREATE TRIGGER queued_inputs_delivery_mode_insert
BEFORE INSERT ON queued_inputs
WHEN (NEW.state IN ('dispatching', 'uncertain')
    AND (NEW.delivery_mode IS NULL
      OR NEW.delivery_mode NOT IN ('submit', 'steer')))
  OR (NEW.state NOT IN ('dispatching', 'uncertain')
    AND NEW.delivery_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued input delivery mode is invalid');
END;

CREATE TRIGGER queued_inputs_delivery_mode_update
BEFORE UPDATE OF state, delivery_mode ON queued_inputs
WHEN (NEW.state IN ('dispatching', 'uncertain')
    AND (NEW.delivery_mode IS NULL
      OR NEW.delivery_mode NOT IN ('submit', 'steer')))
  OR (NEW.state NOT IN ('dispatching', 'uncertain')
    AND NEW.delivery_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued input delivery mode is invalid');
END;

CREATE TRIGGER queued_inputs_force_reset_automation_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.source_automation_run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM automation_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.owner_principal_id = NEW.owner_principal_id
      AND run.automation_id = NEW.source_automation_id
      AND run.id = NEW.source_automation_run_id
      AND run.force_reset_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation cannot enqueue input');
END;

CREATE TRIGGER queued_inputs_automation_source_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.trigger_kind = 'automation' AND NOT EXISTS (
  SELECT 1 FROM automation_runs AS run
  WHERE run.tenant_id = NEW.tenant_id
    AND run.owner_principal_id = NEW.owner_principal_id
    AND run.automation_id = NEW.source_automation_id
    AND run.id = NEW.source_automation_run_id
    AND coalesce(run.child_thread_id, run.anchor_thread_id) =
      NEW.application_thread_id
    AND (NEW.retry_of_id IS NOT NULL
      OR run.dispatch_mutation_id = NEW.mutation_id)
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input automation provenance is invalid');
END;

CREATE TRIGGER queued_inputs_completion_callback_update
BEFORE UPDATE OF completion_callback_id, tenant_id, owner_principal_id,
  application_thread_id, trigger_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id,
  initiating_tool_client_id, retry_of_id, requested_thread_revision,
  requested_draft_revision
ON queued_inputs
WHEN OLD.completion_callback_id IS NOT NEW.completion_callback_id
  OR NEW.completion_callback_id IS NOT NULL
BEGIN
  SELECT CASE WHEN OLD.completion_callback_id IS NOT NEW.completion_callback_id
    THEN RAISE(ABORT, 'Completion callback queue provenance is immutable')
  END;
  SELECT CASE WHEN NEW.completion_callback_id IS NOT NULL AND (
    NEW.trigger_kind <> 'user'
    OR NEW.source_automation_id IS NOT NULL
    OR NEW.source_automation_run_id IS NOT NULL
    OR NEW.initiating_agent_thread_id IS NOT NULL
    OR NEW.initiating_tool_client_id IS NOT NULL
    OR NEW.retry_of_id IS NOT NULL
    OR NEW.requested_thread_revision IS NOT NULL
    OR NEW.requested_draft_revision IS NOT NULL
  ) THEN RAISE(ABORT, 'Completion callback queue provenance is invalid') END;
END;

CREATE TRIGGER queued_inputs_project_admission BEFORE INSERT ON queued_inputs
WHEN EXISTS (
  SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
    ON workspace.tenant_id = thread.tenant_id
    AND workspace.owner_principal_id = thread.owner_principal_id
    AND workspace.id = thread.workspace_id
  WHERE thread.tenant_id = NEW.tenant_id
    AND thread.owner_principal_id = NEW.owner_principal_id
    AND thread.id = NEW.application_thread_id
    AND workspace.removed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'The project was removed. Restore it before starting new work.');
END;

CREATE TRIGGER input_activity_queue_insert AFTER INSERT ON queued_inputs
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id AND id = NEW.application_thread_id;
END;

CREATE TRIGGER input_activity_queue_update AFTER UPDATE OF state, resolved_delivery_mode, failure_acknowledged_at ON queued_inputs
WHEN (OLD.state IS NOT NEW.state AND NEW.state IN ('uncertain', 'failed', 'cancelled'))
  OR OLD.resolved_delivery_mode IS NOT NEW.resolved_delivery_mode
  OR OLD.failure_acknowledged_at IS NOT NEW.failure_acknowledged_at
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id AND id = NEW.application_thread_id;
END;
`,
};
