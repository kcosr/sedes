import type { DatabaseMigration } from "../migrate.js";

/** Raise durable direct-input storage to the existing 256 KiB delivery budget.
 * Composer and tool admission keep their existing, narrower text contracts. */
export const largeDirectInputsMigration: DatabaseMigration = {
  version: 133,
  name: "large_direct_inputs",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE conversation_creation_attempts_v133 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('first_input', 'fork')),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'composer', 'automation', 'user_fork', 'agent_control', 'principal_client', 'direct_input'
  )),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  initiating_tool_client_id TEXT CHECK (
    initiating_tool_client_id IS NULL OR length(initiating_tool_client_id) = 36
  ),
  initial_input_text TEXT CHECK (
    initial_input_text IS NULL OR length(CAST(initial_input_text AS BLOB)) <= CASE WHEN source_kind = 'direct_input' THEN 262144 ELSE 65536 END
  ),
  consumed_draft_revision INTEGER CHECK (
    consumed_draft_revision IS NULL OR consumed_draft_revision >= 1
  ),
  backend_creation_correlation TEXT NOT NULL CHECK (
    length(backend_creation_correlation) BETWEEN 1 AND 128
  ),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'external_call_started', 'conversation_identified',
    'first_submission_started', 'accepted_unpersisted', 'bound',
    'aborted_unpersisted', 'recovery_required'
  )),
  provisional_backend_conversation_id TEXT CHECK (
    provisional_backend_conversation_id IS NULL
    OR length(provisional_backend_conversation_id) BETWEEN 1 AND 128
  ),
  provisional_opaque_binding_detail TEXT CHECK (
    provisional_opaque_binding_detail IS NULL
    OR length(CAST(provisional_opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
  ),
  reconciliation_token TEXT CHECK (
    reconciliation_token IS NULL OR length(reconciliation_token) BETWEEN 1 AND 512
  ),
  retry_anchor TEXT CHECK (
    retry_anchor IS NULL OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096
  ),
  retry_authorized_at INTEGER,
  retry_mutation_id TEXT CHECK (
    retry_mutation_id IS NULL OR length(retry_mutation_id) BETWEEN 1 AND 128
  ),
  retry_started_at INTEGER,
  retry_reconciliation_token TEXT CHECK (
    retry_reconciliation_token IS NULL
    OR length(retry_reconciliation_token) BETWEEN 1 AND 512
  ),
  backend_correlation TEXT CHECK (
    backend_correlation IS NULL OR length(backend_correlation) BETWEEN 1 AND 512
  ),
  completion_identity TEXT CHECK (
    completion_identity IS NULL OR length(completion_identity) BETWEEN 1 AND 512
  ),
  diagnostic TEXT CHECK (
    diagnostic IS NULL OR length(diagnostic) BETWEEN 1 AND 500
  ),
  prepared_at INTEGER NOT NULL,
  external_call_started_at INTEGER,
  accepted_at INTEGER,
  reconciled_at INTEGER,
  fork_child_identity TEXT CHECK (
    fork_child_identity IS NULL
    OR fork_child_identity IN ('application_reserved', 'provider_assigned')
  ),
  fork_creation_recovery TEXT CHECK (
    fork_creation_recovery IS NULL OR fork_creation_recovery IN (
      'idempotent', 'exactly_reconcilable', 'potentially_unknown'
    )
  ),
  fork_uncertainty_kind TEXT CHECK (
    fork_uncertainty_kind IS NULL OR fork_uncertainty_kind = 'fork_unknown'
  ),
  initial_skill_id TEXT CHECK (
    initial_skill_id IS NULL OR length(initial_skill_id) BETWEEN 1 AND 160
  ),
  initial_context_excerpts_json TEXT NOT NULL DEFAULT '[]'

  CHECK (
    json_valid(initial_context_excerpts_json)
    AND json_type(initial_context_excerpts_json) = 'array'
    AND length(CAST(initial_context_excerpts_json AS BLOB)) <= 4194304
  ),
  force_reset_at INTEGER CHECK (
    force_reset_at IS NULL OR force_reset_at >= prepared_at
  ),
  force_reset_mutation_id TEXT CHECK (
    (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
    OR (force_reset_at IS NOT NULL
      AND length(force_reset_mutation_id) BETWEEN 1 AND 128)
  ),
  initial_task_contexts_json TEXT NOT NULL DEFAULT '[]'

  CHECK (
    json_valid(initial_task_contexts_json)
    AND json_type(initial_task_contexts_json) = 'array'
    AND length(CAST(initial_task_contexts_json AS BLOB)) <= 4194304
  ), codex_runtime_receipts_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(codex_runtime_receipts_json)
    AND json_type(codex_runtime_receipts_json) = 'object'
    AND length(CAST(codex_runtime_receipts_json AS BLOB)) <= 32768), environment_variables_fingerprint TEXT NOT NULL
  DEFAULT '1642127e7e9a75120bbcbf74d7f1e157020082004748bab16dab3c89fea15f8c',
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, attempt_id),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, attempt_id,
    backend_instance_id, execution_environment_id),
  UNIQUE (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id,
      backend_instance_id, connection_profile_id, environment_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_agent_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_tool_client_id)
    REFERENCES principal_agent_tool_clients(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id,
    source_automation_run_id)
    REFERENCES automation_runs(tenant_id, owner_principal_id, automation_id, id)
    ON DELETE RESTRICT,
  CHECK ((creation_kind = 'first_input' AND initial_input_text IS NOT NULL)
    OR (creation_kind = 'fork' AND initial_input_text IS NULL)),
  CHECK (
    (source_kind IN ('composer', 'user_fork', 'direct_input')
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL)
    OR (source_kind = 'agent_control' AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL AND initiating_tool_client_id IS NULL)
    OR (source_kind = 'principal_client' AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NOT NULL)
  ),
  CHECK (
    (creation_kind = 'first_input' AND source_kind IN (
      'composer', 'automation', 'agent_control', 'principal_client', 'direct_input'
    )) OR (creation_kind = 'fork' AND source_kind IN (
      'user_fork', 'automation', 'agent_control', 'principal_client'
    ))
  ),
  CHECK (creation_kind <> 'fork'
    OR phase NOT IN ('first_submission_started', 'accepted_unpersisted')),
  CHECK ((source_kind = 'composer'
      AND (consumed_draft_revision IS NOT NULL OR phase = 'aborted_unpersisted'))
    OR (source_kind <> 'composer' AND consumed_draft_revision IS NULL)),
  CHECK ((retry_mutation_id IS NULL AND retry_started_at IS NULL
      AND retry_reconciliation_token IS NULL)
    OR (retry_mutation_id IS NOT NULL AND retry_started_at IS NOT NULL
      AND retry_reconciliation_token IS NOT NULL AND retry_anchor IS NOT NULL)),
  CHECK (retry_anchor IS NULL
    OR phase IN ('first_submission_started', 'recovery_required')),
  CHECK (phase <> 'first_submission_started' OR retry_anchor IS NOT NULL),
  CHECK (retry_authorized_at IS NULL OR retry_mutation_id IS NULL),
  CHECK (phase NOT IN ('conversation_identified', 'first_submission_started',
    'accepted_unpersisted', 'bound')
    OR provisional_backend_conversation_id IS NOT NULL),
  CHECK (phase NOT IN ('conversation_identified', 'first_submission_started',
    'accepted_unpersisted', 'bound')
    OR provisional_opaque_binding_detail IS NOT NULL),
  CHECK (phase NOT IN ('external_call_started', 'conversation_identified',
    'first_submission_started', 'accepted_unpersisted', 'bound')
    OR external_call_started_at IS NOT NULL),
  CHECK (phase NOT IN ('accepted_unpersisted', 'bound') OR accepted_at IS NOT NULL),
  CHECK (phase <> 'bound' OR reconciled_at IS NOT NULL),
  CHECK (accepted_at IS NOT NULL
    OR (backend_correlation IS NULL AND completion_identity IS NULL)),
  CHECK ((retry_authorized_at IS NULL AND retry_mutation_id IS NULL)
    OR phase = 'recovery_required'),
  CHECK (external_call_started_at IS NULL OR external_call_started_at >= prepared_at),
  CHECK (accepted_at IS NULL OR accepted_at >= prepared_at),
  CHECK (reconciled_at IS NULL OR reconciled_at >= prepared_at),
  CHECK (retry_authorized_at IS NULL OR retry_authorized_at >= prepared_at),
  CHECK (retry_started_at IS NULL OR retry_started_at >= prepared_at)
) STRICT;

INSERT INTO conversation_creation_attempts_v133 (tenant_id, owner_principal_id, application_thread_id, attempt_id, mutation_id, backend_instance_id, connection_profile_id, execution_environment_id, creation_kind, source_kind, source_automation_id, source_automation_run_id, initiating_agent_thread_id, initiating_tool_client_id, initial_input_text, consumed_draft_revision, backend_creation_correlation, phase, provisional_backend_conversation_id, provisional_opaque_binding_detail, reconciliation_token, retry_anchor, retry_authorized_at, retry_mutation_id, retry_started_at, retry_reconciliation_token, backend_correlation, completion_identity, diagnostic, prepared_at, external_call_started_at, accepted_at, reconciled_at, fork_child_identity, fork_creation_recovery, fork_uncertainty_kind, initial_skill_id, initial_context_excerpts_json, force_reset_at, force_reset_mutation_id, initial_task_contexts_json, codex_runtime_receipts_json, environment_variables_fingerprint)
SELECT tenant_id, owner_principal_id, application_thread_id, attempt_id, mutation_id, backend_instance_id, connection_profile_id, execution_environment_id, creation_kind, source_kind, source_automation_id, source_automation_run_id, initiating_agent_thread_id, initiating_tool_client_id, initial_input_text, consumed_draft_revision, backend_creation_correlation, phase, provisional_backend_conversation_id, provisional_opaque_binding_detail, reconciliation_token, retry_anchor, retry_authorized_at, retry_mutation_id, retry_started_at, retry_reconciliation_token, backend_correlation, completion_identity, diagnostic, prepared_at, external_call_started_at, accepted_at, reconciled_at, fork_child_identity, fork_creation_recovery, fork_uncertainty_kind, initial_skill_id, initial_context_excerpts_json, force_reset_at, force_reset_mutation_id, initial_task_contexts_json, codex_runtime_receipts_json, environment_variables_fingerprint FROM conversation_creation_attempts;
DROP TABLE conversation_creation_attempts;
ALTER TABLE conversation_creation_attempts_v133 RENAME TO conversation_creation_attempts;

-- Preserve the prior creation order of admission guards.
CREATE UNIQUE INDEX conversation_creation_attempts_one_active
  ON conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE force_reset_at IS NULL
    AND phase NOT IN ('bound', 'aborted_unpersisted');

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

CREATE INDEX conversation_creation_attempts_codex_create_receipt ON conversation_creation_attempts(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.create.operationId')
);

CREATE INDEX conversation_creation_attempts_codex_fork_receipt ON conversation_creation_attempts(
  tenant_id, owner_principal_id,
  json_extract(codex_runtime_receipts_json, '$.fork.operationId')
);

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

CREATE TABLE queued_inputs_v133 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 262144),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'retry_wait', 'dispatching', 'accepted', 'uncertain',
    'failed', 'cancelled'
  )),
  retry_of_id TEXT CHECK (
    retry_of_id IS NULL OR length(retry_of_id) BETWEEN 1 AND 128
  ),
  created_at INTEGER NOT NULL,
  dispatch_started_at INTEGER,
  accepted_at INTEGER,
  resolved_at INTEGER,
  reconciliation_token TEXT CHECK (
    reconciliation_token IS NULL OR length(reconciliation_token) BETWEEN 1 AND 512
  ),
  retry_anchor TEXT CHECK (
    retry_anchor IS NULL OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096
  ),
  backend_correlation TEXT CHECK (
    backend_correlation IS NULL OR length(backend_correlation) BETWEEN 1 AND 512
  ),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  invalid_state_requeues INTEGER NOT NULL DEFAULT 0
    CHECK (invalid_state_requeues BETWEEN 0 AND 1),
  next_attempt_at INTEGER,
  diagnostic TEXT CHECK (
    diagnostic IS NULL OR length(diagnostic) BETWEEN 1 AND 500
  ),
  failure_acknowledged_at INTEGER,
  trigger_kind TEXT NOT NULL DEFAULT 'user'
    CHECK (trigger_kind IN ('user', 'automation')),
  source_automation_id TEXT CHECK (
    source_automation_id IS NULL OR length(source_automation_id) BETWEEN 1 AND 128
  ),
  source_automation_run_id TEXT CHECK (
    source_automation_run_id IS NULL
    OR length(source_automation_run_id) BETWEEN 1 AND 128
  ),
  selected_skill_id TEXT CHECK (
    selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160
  ),
  context_excerpts_json TEXT NOT NULL DEFAULT '[]'

  CHECK (
    json_valid(context_excerpts_json)
    AND json_type(context_excerpts_json) = 'array'
    AND length(CAST(context_excerpts_json AS BLOB)) <= 4194304
  ),
  delivery_mode TEXT CHECK (
    delivery_mode IS NULL OR delivery_mode IN ('submit', 'steer')
  ),
  cancellation_mutation_id TEXT CHECK (
    cancellation_mutation_id IS NULL
    OR length(cancellation_mutation_id) BETWEEN 1 AND 128
  ),
  cancellation_request_fingerprint TEXT CHECK (
    cancellation_request_fingerprint IS NULL
    OR length(cancellation_request_fingerprint) = 64
  ),
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  initiating_tool_client_id TEXT CHECK (
    initiating_tool_client_id IS NULL OR length(initiating_tool_client_id) = 36
  ),
  task_contexts_json TEXT NOT NULL DEFAULT '[]'

  CHECK (
    json_valid(task_contexts_json)
    AND json_type(task_contexts_json) = 'array'
    AND length(CAST(task_contexts_json AS BLOB)) <= 4194304
  ),
  requested_delivery_mode TEXT CHECK (
    requested_delivery_mode IS NULL
    OR requested_delivery_mode IN ('submit', 'queue')
  ),
  requested_thread_revision INTEGER CHECK (
    requested_thread_revision IS NULL OR requested_thread_revision >= 0
  ),
  requested_draft_revision INTEGER CHECK (
    requested_draft_revision IS NULL OR requested_draft_revision >= 0
  ),
  requested_steer_target_json TEXT CHECK (
    requested_steer_target_json IS NULL
    OR (json_valid(requested_steer_target_json) AND (
      (json_extract(requested_steer_target_json, '$.kind') = 'conversation' AND json_remove(requested_steer_target_json, '$.kind') = '{}')
      OR (json_extract(requested_steer_target_json, '$.kind') = 'turn'
        AND json_type(requested_steer_target_json, '$.turnId') = 'text'
        AND length(json_extract(requested_steer_target_json, '$.turnId')) BETWEEN 1 AND 160
        AND json_remove(requested_steer_target_json, '$.kind', '$.turnId') = '{}')
    )) IS TRUE
  ),
  steer_fallback_at INTEGER CHECK (
    steer_fallback_at IS NULL OR steer_fallback_at >= 0
  ),
  resolved_delivery_mode TEXT NOT NULL DEFAULT 'queue' CHECK (
    resolved_delivery_mode IN ('submit', 'steer', 'queue')
  ),
  resolved_steer_target_json TEXT CHECK (
    resolved_steer_target_json IS NULL
    OR (json_valid(resolved_steer_target_json) AND (
      (json_extract(resolved_steer_target_json, '$.kind') = 'conversation' AND json_remove(resolved_steer_target_json, '$.kind') = '{}')
      OR (json_extract(resolved_steer_target_json, '$.kind') = 'turn'
        AND json_type(resolved_steer_target_json, '$.turnId') = 'text'
        AND length(json_extract(resolved_steer_target_json, '$.turnId')) BETWEEN 1 AND 160
        AND json_remove(resolved_steer_target_json, '$.kind', '$.turnId') = '{}')
    )) IS TRUE
  ),
  completion_callback_id TEXT CHECK (
    completion_callback_id IS NULL OR length(completion_callback_id) = 36
  ),
  question_response_origin_json TEXT CHECK (question_response_origin_json IS NULL OR json_valid(question_response_origin_json)), failure_reason TEXT CHECK (
  failure_reason IS NULL OR failure_reason = 'not_sent'
),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, sequence),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, mutation_id),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id, retry_of_id)
    REFERENCES queued_inputs(
      tenant_id, owner_principal_id, application_thread_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_agent_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_tool_client_id)
    REFERENCES principal_agent_tool_clients(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, completion_callback_id)
    REFERENCES thread_completion_callbacks(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  CHECK (retry_of_id IS NULL OR retry_of_id <> id),
  CHECK (
    (trigger_kind = 'automation'
      AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NULL
      AND completion_callback_id IS NULL)
    OR (trigger_kind = 'user'
      AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND ((completion_callback_id IS NOT NULL
          AND initiating_agent_thread_id IS NULL
          AND initiating_tool_client_id IS NULL
          AND retry_of_id IS NULL)
        OR (completion_callback_id IS NULL
          AND NOT (initiating_agent_thread_id IS NOT NULL
            AND initiating_tool_client_id IS NOT NULL))))
  ),
  CHECK (
    (requested_delivery_mode IS NULL
      AND requested_thread_revision IS NULL
      AND requested_draft_revision IS NULL
      AND requested_steer_target_json IS NULL)
    OR (completion_callback_id IS NULL
      AND requested_delivery_mode IS NOT NULL
      AND requested_thread_revision IS NOT NULL
      AND requested_draft_revision IS NOT NULL
      AND trigger_kind = 'user'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NULL
      AND retry_of_id IS NULL)
    OR (completion_callback_id IS NOT NULL
      AND requested_delivery_mode IS NOT NULL
      AND requested_thread_revision IS NULL
      AND requested_draft_revision IS NULL)
  ),
  CHECK (
    requested_steer_target_json IS NULL OR (
      requested_delivery_mode = 'queue'
      AND ((completion_callback_id IS NOT NULL
          AND requested_thread_revision IS NULL
          AND requested_draft_revision IS NULL)
        OR (completion_callback_id IS NULL
          AND requested_thread_revision IS NOT NULL
          AND requested_draft_revision IS NOT NULL))
    )
  ),
  CHECK (
    steer_fallback_at IS NULL OR (
      requested_steer_target_json IS NOT NULL
      AND requested_delivery_mode = 'queue'
    )
  ),
  CHECK ((resolved_delivery_mode = 'steer') =
    (resolved_steer_target_json IS NOT NULL)),
  CHECK (
    (state IN ('pending', 'retry_wait')
      AND dispatch_started_at IS NULL AND accepted_at IS NULL
      AND resolved_at IS NULL AND reconciliation_token IS NULL
      AND retry_anchor IS NULL)
    OR (state IN ('dispatching', 'uncertain')
      AND dispatch_started_at IS NOT NULL AND accepted_at IS NULL
      AND resolved_at IS NULL AND reconciliation_token IS NOT NULL
      AND retry_anchor IS NOT NULL)
    OR (state = 'accepted'
      AND dispatch_started_at IS NOT NULL AND accepted_at IS NOT NULL
      AND resolved_at IS NOT NULL AND reconciliation_token IS NULL
      AND retry_anchor IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND resolved_at IS NOT NULL AND accepted_at IS NULL
      AND reconciliation_token IS NULL AND retry_anchor IS NULL)
  ),
  CHECK (backend_correlation IS NULL OR state IN ('uncertain', 'accepted')),
  CHECK (state <> 'failed' OR diagnostic IS NOT NULL),
  CHECK ((state = 'retry_wait' AND next_attempt_at IS NOT NULL)
    OR (state <> 'retry_wait' AND next_attempt_at IS NULL)),
  CHECK (failure_acknowledged_at IS NULL OR (
    state = 'failed' AND resolved_at IS NOT NULL
    AND failure_acknowledged_at >= resolved_at
  ))
) STRICT;

INSERT INTO queued_inputs_v133 (tenant_id, owner_principal_id, id, application_thread_id, sequence, mutation_id, text, state, retry_of_id, created_at, dispatch_started_at, accepted_at, resolved_at, reconciliation_token, retry_anchor, backend_correlation, retry_count, invalid_state_requeues, next_attempt_at, diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id, source_automation_run_id, selected_skill_id, context_excerpts_json, delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint, initiating_agent_thread_id, initiating_tool_client_id, task_contexts_json, requested_delivery_mode, requested_thread_revision, requested_draft_revision, requested_steer_target_json, steer_fallback_at, resolved_delivery_mode, resolved_steer_target_json, completion_callback_id, question_response_origin_json, failure_reason)
SELECT tenant_id, owner_principal_id, id, application_thread_id, sequence, mutation_id, text, state, retry_of_id, created_at, dispatch_started_at, accepted_at, resolved_at, reconciliation_token, retry_anchor, backend_correlation, retry_count, invalid_state_requeues, next_attempt_at, diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id, source_automation_run_id, selected_skill_id, context_excerpts_json, delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint, initiating_agent_thread_id, initiating_tool_client_id, task_contexts_json, requested_delivery_mode, requested_thread_revision, requested_draft_revision, requested_steer_target_json, steer_fallback_at, resolved_delivery_mode, resolved_steer_target_json, completion_callback_id, question_response_origin_json, failure_reason FROM queued_inputs;
DROP TABLE queued_inputs;
ALTER TABLE queued_inputs_v133 RENAME TO queued_inputs;

-- Preserve the prior creation order of admission guards.
CREATE UNIQUE INDEX queued_inputs_one_explicit_retry
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id, retry_of_id
  ) WHERE retry_of_id IS NOT NULL;

CREATE INDEX queued_inputs_dispatch
  ON queued_inputs(
    state, next_attempt_at, tenant_id, owner_principal_id,
    application_thread_id, sequence
  ) WHERE state IN ('pending', 'retry_wait');

CREATE UNIQUE INDEX queued_inputs_cancellation_mutation
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id,
    cancellation_mutation_id
  ) WHERE cancellation_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX queued_inputs_completion_callback
  ON queued_inputs(tenant_id, owner_principal_id, completion_callback_id)
  WHERE completion_callback_id IS NOT NULL;

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

CREATE INDEX queued_inputs_application_summary
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id,
    state, failure_acknowledged_at
  )
  WHERE state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
    OR (state = 'failed' AND failure_acknowledged_at IS NULL);

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
