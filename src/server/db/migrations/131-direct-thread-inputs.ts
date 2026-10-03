import type { DatabaseMigration } from "../migrate.js";

/** Content input has its own durable identity and never consumes a composer draft. */
export const directThreadInputsMigration: DatabaseMigration = {
  version: 131,
  name: "direct_thread_inputs",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE conversation_creation_attempts_v131 (
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
    initial_input_text IS NULL OR length(CAST(initial_input_text AS BLOB)) <= 65536
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

INSERT INTO conversation_creation_attempts_v131 SELECT * FROM conversation_creation_attempts;
DROP TABLE conversation_creation_attempts;
ALTER TABLE conversation_creation_attempts_v131 RENAME TO conversation_creation_attempts;

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

CREATE TABLE direct_input_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  admitted_mode TEXT NOT NULL CHECK (admitted_mode IN ('submit','queue','steer')),
  queued_input_id TEXT,
  creation_attempt_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((queued_input_id IS NULL) <> (creation_attempt_id IS NULL)),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  -- Keep the bounded identity proof even if its thread is eventually removed.
  -- Otherwise the same principal mutation could create a second input elsewhere.
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER direct_input_receipts_immutable BEFORE UPDATE ON direct_input_receipts
BEGIN SELECT RAISE(ABORT, 'Direct input receipts are immutable'); END;

CREATE TABLE input_client_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) = 36),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER input_client_origins_immutable BEFORE UPDATE ON input_client_origins
BEGIN SELECT RAISE(ABORT, 'Input client origins are immutable'); END;

CREATE TABLE thread_turn_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_turn_id TEXT NOT NULL CHECK (length(application_turn_id) BETWEEN 1 AND 160),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128),
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) = 36),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, application_turn_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER thread_turn_origins_immutable BEFORE UPDATE ON thread_turn_origins
BEGIN SELECT RAISE(ABORT, 'Turn client origins are immutable'); END;

ALTER TABLE application_threads ADD COLUMN input_activity_revision INTEGER NOT NULL DEFAULT 0
  CHECK (input_activity_revision >= 0);

-- Durable admission and lifecycle transitions cannot disappear between two observations.
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
CREATE TRIGGER input_activity_thread_lifecycle AFTER UPDATE OF backing_state, availability, workspace_id, environment_id, force_reset_at ON application_threads
WHEN OLD.backing_state IS NOT NEW.backing_state OR OLD.availability IS NOT NEW.availability
  OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.environment_id IS NOT NEW.environment_id
  OR OLD.force_reset_at IS NOT NEW.force_reset_at
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id AND id = NEW.id;
END;
CREATE TRIGGER input_activity_inventory AFTER UPDATE OF inventory_state ON thread_principal_state
WHEN OLD.inventory_state IS NOT NEW.inventory_state
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.principal_id AND id = NEW.thread_id;
END;

`,
};
