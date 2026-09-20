import type { DatabaseMigration } from "../migrate.js";
import { annotatedContext, isNonWhitespace } from "./038-context-excerpts.js";

const jsonArrayConstraint = (column: string) => `
  CHECK (
    json_valid(${column})
    AND json_type(${column}) = 'array'
    AND length(CAST(${column} AS BLOB)) <= 4194304
  )`;

/**
 * Adds explicit principal-client initiators without overloading the existing
 * thread-agent provenance columns. Every rebuilt table keeps the initiators
 * mutually exclusive and scope-qualified through composite foreign keys.
 */
export const principalToolClientProvenanceMigration: DatabaseMigration = {
  version: 61,
  name: "principal_tool_client_provenance",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_tool_creation_origins (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  initiator_kind TEXT NOT NULL CHECK (
    initiator_kind IN ('thread_agent', 'principal_client')
  ),
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  initiating_tool_client_id TEXT CHECK (
    initiating_tool_client_id IS NULL
    OR length(initiating_tool_client_id) = 36
  ),
  creation_mutation_id TEXT NOT NULL CHECK (
    length(creation_mutation_id) BETWEEN 1 AND 128
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, thread_id),
  UNIQUE (tenant_id, owner_principal_id, creation_mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_agent_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, initiating_tool_client_id)
    REFERENCES principal_agent_tool_clients(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (initiator_kind = 'thread_agent'
      AND initiating_agent_thread_id IS NOT NULL
      AND initiating_tool_client_id IS NULL)
    OR (initiator_kind = 'principal_client'
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER thread_tool_creation_origins_immutable_update
BEFORE UPDATE ON thread_tool_creation_origins
BEGIN
  SELECT RAISE(ABORT, 'Thread tool creation origins are immutable');
END;

CREATE TRIGGER thread_tool_creation_origins_immutable_delete
BEFORE DELETE ON thread_tool_creation_origins
WHEN EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id = OLD.tenant_id
    AND thread.owner_principal_id = OLD.owner_principal_id
    AND thread.id = OLD.thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Thread tool creation origins are immutable');
END;

CREATE TABLE conversation_creation_attempts_v61 (
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
    'composer', 'automation', 'user_fork', 'agent_control', 'principal_client'
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
  fork_context_boundary_version INTEGER CHECK (
    fork_context_boundary_version IS NULL OR fork_context_boundary_version = 1
  ),
  fork_context_boundary_state TEXT CHECK (
    fork_context_boundary_state IS NULL OR fork_context_boundary_state IN (
      'pending', 'applying', 'applied', 'unknown'
    )
  ),
  initial_skill_id TEXT CHECK (
    initial_skill_id IS NULL OR length(initial_skill_id) BETWEEN 1 AND 160
  ),
  initial_context_excerpts_json TEXT NOT NULL DEFAULT '[]'
    ${jsonArrayConstraint("initial_context_excerpts_json")},
  force_reset_at INTEGER CHECK (
    force_reset_at IS NULL OR force_reset_at >= prepared_at
  ),
  force_reset_mutation_id TEXT CHECK (
    (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
    OR (force_reset_at IS NOT NULL
      AND length(force_reset_mutation_id) BETWEEN 1 AND 128)
  ),
  initial_task_contexts_json TEXT NOT NULL DEFAULT '[]'
    ${jsonArrayConstraint("initial_task_contexts_json")},
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
    (source_kind IN ('composer', 'user_fork')
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
      'composer', 'automation', 'agent_control', 'principal_client'
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

INSERT INTO conversation_creation_attempts_v61(
  tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initiating_agent_thread_id,
  initiating_tool_client_id, initial_input_text, consumed_draft_revision,
  backend_creation_correlation, phase, provisional_backend_conversation_id,
  provisional_opaque_binding_detail, reconciliation_token, retry_anchor,
  retry_authorized_at, retry_mutation_id, retry_started_at,
  retry_reconciliation_token, backend_correlation, completion_identity,
  diagnostic, prepared_at, external_call_started_at, accepted_at,
  reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id,
  initial_context_excerpts_json, force_reset_at, force_reset_mutation_id,
  initial_task_contexts_json
)
SELECT tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initiating_agent_thread_id,
  NULL, initial_input_text, consumed_draft_revision,
  backend_creation_correlation, phase, provisional_backend_conversation_id,
  provisional_opaque_binding_detail, reconciliation_token, retry_anchor,
  retry_authorized_at, retry_mutation_id, retry_started_at,
  retry_reconciliation_token, backend_correlation, completion_identity,
  diagnostic, prepared_at, external_call_started_at, accepted_at,
  reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id,
  initial_context_excerpts_json, force_reset_at, force_reset_mutation_id,
  initial_task_contexts_json
FROM conversation_creation_attempts;

DROP TABLE conversation_creation_attempts;
ALTER TABLE conversation_creation_attempts_v61
  RENAME TO conversation_creation_attempts;

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

CREATE TRIGGER conversation_creation_attempts_boundary_pair_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork'
    AND NEW.source_kind IN ('user_fork', 'agent_control', 'principal_client')
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_pair_update
BEFORE UPDATE OF fork_context_boundary_version, fork_context_boundary_state,
  creation_kind, source_kind ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NULL AND (((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork'
    AND NEW.source_kind IN ('user_fork', 'agent_control', 'principal_client')
  ))
  OR NEW.fork_context_boundary_version IS NOT OLD.fork_context_boundary_version)
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_transition
BEFORE UPDATE OF fork_context_boundary_state ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NULL
  AND OLD.fork_context_boundary_version = 1
  AND NEW.fork_context_boundary_state IS NOT OLD.fork_context_boundary_state
  AND NOT ((OLD.fork_context_boundary_state = 'pending'
      AND NEW.fork_context_boundary_state = 'applying')
    OR (OLD.fork_context_boundary_state = 'applying'
      AND NEW.fork_context_boundary_state IN ('pending', 'applied', 'unknown'))
    OR (OLD.fork_context_boundary_state IN ('pending', 'applying', 'unknown')
      AND NEW.fork_context_boundary_state = 'applied'))
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary transition');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.phase = 'bound' AND NEW.creation_kind = 'fork'
  AND NEW.source_kind IN ('user_fork', 'agent_control', 'principal_client')
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_update
BEFORE UPDATE OF phase, fork_context_boundary_state
ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NULL
  AND NEW.phase = 'bound' AND NEW.creation_kind = 'fork'
  AND NEW.source_kind IN ('user_fork', 'agent_control', 'principal_client')
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
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
WHEN OLD.force_reset_at IS NULL
  AND NEW.initial_input_text IS NOT NULL
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

CREATE TABLE queued_inputs_v61 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 65536),
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
    ${jsonArrayConstraint("context_excerpts_json")},
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
    ${jsonArrayConstraint("task_contexts_json")},
  requested_delivery_mode TEXT CHECK (
    requested_delivery_mode IS NULL
    OR requested_delivery_mode IN ('submit', 'queue')
  ),
  requested_thread_revision INTEGER CHECK (
    requested_thread_revision IS NULL OR requested_thread_revision >= 0
  ),
  requested_draft_revision INTEGER CHECK (
    requested_draft_revision IS NULL OR requested_draft_revision >= 0
  ) CHECK (
    (requested_delivery_mode IS NULL
      AND requested_thread_revision IS NULL
      AND requested_draft_revision IS NULL)
    OR (requested_delivery_mode IS NOT NULL
      AND requested_thread_revision IS NOT NULL
      AND requested_draft_revision IS NOT NULL
      AND trigger_kind = 'user'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NULL
      AND retry_of_id IS NULL)
  ),
  requested_steer_turn_id TEXT CHECK (
    requested_steer_turn_id IS NULL
    OR length(requested_steer_turn_id) BETWEEN 1 AND 160
  ) CHECK (
    requested_steer_turn_id IS NULL OR (
      requested_delivery_mode = 'queue'
      AND requested_thread_revision IS NOT NULL
      AND requested_draft_revision IS NOT NULL
      AND trigger_kind = 'user'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NULL
      AND retry_of_id IS NULL
    )
  ),
  steer_fallback_at INTEGER CHECK (
    steer_fallback_at IS NULL OR (
      steer_fallback_at >= 0
      AND requested_steer_turn_id IS NOT NULL
      AND requested_delivery_mode = 'queue'
    )
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
  CHECK (retry_of_id IS NULL OR retry_of_id <> id),
  CHECK (
    (trigger_kind = 'automation'
      AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL
      AND initiating_tool_client_id IS NULL)
    OR (trigger_kind = 'user'
      AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND NOT (initiating_agent_thread_id IS NOT NULL
        AND initiating_tool_client_id IS NOT NULL))
  ),
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

INSERT INTO queued_inputs_v61(
  tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, context_excerpts_json,
  delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint,
  initiating_agent_thread_id, initiating_tool_client_id, task_contexts_json,
  requested_delivery_mode, requested_thread_revision,
  requested_draft_revision, requested_steer_turn_id, steer_fallback_at
)
SELECT tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, context_excerpts_json,
  delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint,
  initiating_agent_thread_id, NULL, task_contexts_json,
  requested_delivery_mode, requested_thread_revision,
  requested_draft_revision, requested_steer_turn_id, steer_fallback_at
FROM queued_inputs;

DROP TABLE queued_inputs;
ALTER TABLE queued_inputs_v61 RENAME TO queued_inputs;

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

CREATE TRIGGER queued_inputs_agent_control_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT NULL AND (
  NEW.trigger_kind <> 'user'
  OR NEW.source_automation_id IS NOT NULL
  OR NEW.source_automation_run_id IS NOT NULL
  OR NEW.initiating_tool_client_id IS NOT NULL
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
  trigger_kind, source_automation_id, source_automation_run_id ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
  OR NEW.initiating_tool_client_id IS NOT OLD.initiating_tool_client_id
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
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input retry provenance is invalid');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_update
BEFORE UPDATE OF tenant_id, owner_principal_id, id, application_thread_id,
  mutation_id, retry_of_id, trigger_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id,
  initiating_tool_client_id ON queued_inputs
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
  initiating_agent_thread_id, initiating_tool_client_id ON queued_inputs
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

CREATE TABLE aborted_thread_forks_v61 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL CHECK (
    length(creation_operation_id) BETWEEN 1 AND 128
  ),
  reserved_child_thread_id TEXT NOT NULL CHECK (
    length(reserved_child_thread_id) BETWEEN 1 AND 128
  ),
  source_thread_id TEXT NOT NULL,
  source_turn_id TEXT CHECK (
    source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 160
  ),
  source_turn_revision INTEGER CHECK (
    source_turn_revision IS NULL OR source_turn_revision >= 0
  ),
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN (
    'completed_turn_inclusive', 'provider_snapshot_at_acceptance'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'automation', 'user_fork', 'agent_control', 'principal_client'
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
  diagnostic TEXT NOT NULL CHECK (
    length(CAST(diagnostic AS BLOB)) BETWEEN 1 AND 500
  ),
  aborted_at INTEGER NOT NULL CHECK (aborted_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, creation_operation_id),
  UNIQUE (tenant_id, owner_principal_id, reserved_child_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, source_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
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
  CHECK (
    (source_kind = 'user_fork'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL
      AND ((boundary_kind = 'completed_turn_inclusive'
          AND source_turn_id IS NOT NULL AND source_turn_revision IS NOT NULL)
        OR (boundary_kind = 'provider_snapshot_at_acceptance'
          AND source_turn_id IS NULL AND source_turn_revision IS NULL)))
    OR (source_kind = 'automation'
      AND boundary_kind = 'completed_turn_inclusive'
      AND source_automation_id IS NOT NULL AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL)
    OR (source_kind = 'agent_control'
      AND boundary_kind = 'completed_turn_inclusive'
      AND source_turn_id IS NOT NULL AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL AND initiating_tool_client_id IS NULL)
    OR (source_kind = 'principal_client'
      AND boundary_kind = 'completed_turn_inclusive'
      AND source_turn_id IS NOT NULL AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NOT NULL)
  )
) STRICT;

INSERT INTO aborted_thread_forks_v61(
  tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, boundary_kind, source_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id,
  initiating_tool_client_id, diagnostic, aborted_at
)
SELECT tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, boundary_kind, source_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id,
  NULL, diagnostic, aborted_at
FROM aborted_thread_forks;

DROP TABLE aborted_thread_forks;
ALTER TABLE aborted_thread_forks_v61 RENAME TO aborted_thread_forks;

CREATE TABLE thread_fork_origins_v61 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  provider_parent_backend_conversation_id TEXT CHECK (
    provider_parent_backend_conversation_id IS NULL
    OR length(provider_parent_backend_conversation_id) BETWEEN 1 AND 128
  ),
  source_thread_state TEXT NOT NULL CHECK (
    source_thread_state IN ('resolved', 'unresolved')
  ),
  source_thread_id TEXT,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  source_turn_state TEXT NOT NULL CHECK (
    source_turn_state IN ('resolved', 'unresolved')
  ),
  source_turn_id TEXT CHECK (
    source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 160
  ),
  source_turn_revision INTEGER CHECK (
    source_turn_revision IS NULL OR source_turn_revision >= 0
  ),
  source_checkpoint_id TEXT,
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN (
    'completed_turn_inclusive', 'provider_snapshot_at_acceptance'
  )),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'user_fork', 'automation_fork', 'agent_fork',
    'principal_client_fork', 'imported_native_fork'
  )),
  initiating_principal_id TEXT,
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  branch_method TEXT NOT NULL CHECK (
    branch_method IN ('provider_native', 'provider_history_import')
  ),
  creation_operation_id TEXT CHECK (
    creation_operation_id IS NULL
    OR length(creation_operation_id) BETWEEN 1 AND 128
  ),
  origin_state TEXT NOT NULL CHECK (origin_state IN ('prepared', 'committed')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  committed_at INTEGER CHECK (committed_at IS NULL OR committed_at >= created_at),
  source_turn_completed_at INTEGER CHECK (
    source_turn_completed_at IS NULL OR (
      source_turn_state = 'resolved' AND source_turn_id IS NOT NULL
    )
  ),
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  initiating_tool_client_id TEXT CHECK (
    initiating_tool_client_id IS NULL OR length(initiating_tool_client_id) = 36
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, child_thread_id),
  UNIQUE (tenant_id, owner_principal_id, creation_operation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id, workspace_id,
      backend_instance_id, connection_profile_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_thread_id, workspace_id,
    backend_instance_id, connection_profile_id, environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id, workspace_id,
      backend_instance_id, connection_profile_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_checkpoint_id,
    source_thread_id, backend_instance_id, boundary_kind)
    REFERENCES backend_checkpoints(tenant_id, owner_principal_id, id,
      application_thread_id, backend_instance_id, boundary_kind) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, initiating_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
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
  CHECK ((source_thread_state = 'resolved' AND source_thread_id IS NOT NULL)
    OR (source_thread_state = 'unresolved' AND source_thread_id IS NULL)),
  CHECK (source_thread_id IS NULL OR child_thread_id <> source_thread_id),
  CHECK (source_thread_state = 'resolved' OR (
    source_turn_state = 'unresolved' AND source_turn_id IS NULL
    AND source_checkpoint_id IS NULL
  )),
  CHECK ((source_turn_state = 'resolved' AND source_turn_id IS NOT NULL)
    OR (source_turn_state = 'unresolved' AND source_turn_id IS NULL)),
  CHECK (source_turn_state = 'resolved' OR source_turn_revision IS NULL),
  CHECK (boundary_kind = 'provider_snapshot_at_acceptance'
    OR origin_kind <> 'user_fork' OR source_turn_revision IS NOT NULL),
  CHECK (boundary_kind = 'completed_turn_inclusive' OR (
    source_thread_state = 'resolved' AND source_thread_id IS NOT NULL
    AND source_turn_state = 'unresolved' AND source_turn_id IS NULL
    AND source_turn_revision IS NULL AND source_turn_completed_at IS NULL
    AND source_checkpoint_id IS NOT NULL AND origin_kind = 'user_fork'
  )),
  CHECK ((origin_kind = 'imported_native_fork') =
    (provider_parent_backend_conversation_id IS NOT NULL)),
  CHECK ((origin_state = 'prepared' AND committed_at IS NULL)
    OR (origin_state = 'committed' AND committed_at IS NOT NULL)),
  CHECK (
    (origin_kind = 'user_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL)
    OR (origin_kind = 'automation_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NOT NULL AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL)
    OR (origin_kind = 'agent_fork' AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL AND initiating_tool_client_id IS NULL)
    OR (origin_kind = 'principal_client_fork'
      AND initiating_principal_id IS NOT NULL
      AND source_checkpoint_id IS NOT NULL AND creation_operation_id IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NOT NULL)
    OR (origin_kind = 'imported_native_fork'
      AND initiating_principal_id IS NULL AND creation_operation_id IS NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL AND initiating_tool_client_id IS NULL
      AND origin_state = 'committed')
  )
) STRICT;

INSERT INTO thread_fork_origins_v61(
  tenant_id, owner_principal_id, child_thread_id,
  provider_parent_backend_conversation_id, source_thread_state,
  source_thread_id, environment_id, workspace_id, backend_instance_id,
  connection_profile_id, source_turn_state, source_turn_id,
  source_turn_revision, source_checkpoint_id, boundary_kind, origin_kind,
  initiating_principal_id, source_automation_id, source_automation_run_id,
  branch_method, creation_operation_id, origin_state, created_at, committed_at,
  source_turn_completed_at, initiating_agent_thread_id,
  initiating_tool_client_id
)
SELECT tenant_id, owner_principal_id, child_thread_id,
  provider_parent_backend_conversation_id, source_thread_state,
  source_thread_id, environment_id, workspace_id, backend_instance_id,
  connection_profile_id, source_turn_state, source_turn_id,
  source_turn_revision, source_checkpoint_id, boundary_kind, origin_kind,
  initiating_principal_id, source_automation_id, source_automation_run_id,
  branch_method, creation_operation_id, origin_state, created_at, committed_at,
  source_turn_completed_at, initiating_agent_thread_id, NULL
FROM thread_fork_origins;

DROP TABLE thread_fork_origins;
ALTER TABLE thread_fork_origins_v61 RENAME TO thread_fork_origins;

CREATE INDEX thread_fork_origins_by_source
  ON thread_fork_origins(tenant_id, owner_principal_id, source_thread_id,
    created_at DESC, child_thread_id DESC);

CREATE TRIGGER thread_fork_origins_agent_control_insert
BEFORE INSERT ON thread_fork_origins
WHEN (NEW.origin_kind = 'agent_fork') !=
    (NEW.initiating_agent_thread_id IS NOT NULL)
  OR (NEW.initiating_agent_thread_id IS NOT NULL AND (
    NEW.initiating_tool_client_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM application_threads AS source
      WHERE source.tenant_id = NEW.tenant_id
        AND source.owner_principal_id = NEW.owner_principal_id
        AND source.id = NEW.initiating_agent_thread_id
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is invalid');
END;

CREATE TRIGGER thread_fork_origins_principal_client_insert
BEFORE INSERT ON thread_fork_origins
WHEN (NEW.origin_kind = 'principal_client_fork') !=
    (NEW.initiating_tool_client_id IS NOT NULL)
  OR (NEW.initiating_tool_client_id IS NOT NULL AND (
    NEW.initiating_agent_thread_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM principal_agent_tool_clients AS client
      WHERE client.tenant_id = NEW.tenant_id
        AND client.owner_principal_id = NEW.owner_principal_id
        AND client.id = NEW.initiating_tool_client_id
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'Principal-client fork initiator is invalid');
END;

CREATE TRIGGER thread_fork_origins_agent_control_update
BEFORE UPDATE OF origin_kind, initiating_agent_thread_id ON thread_fork_origins
WHEN NEW.origin_kind IS NOT OLD.origin_kind
  OR NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is immutable');
END;

CREATE TRIGGER thread_fork_origins_principal_client_update
BEFORE UPDATE OF origin_kind, initiating_tool_client_id ON thread_fork_origins
WHEN NEW.origin_kind IS NOT OLD.origin_kind
  OR NEW.initiating_tool_client_id IS NOT OLD.initiating_tool_client_id
BEGIN
  SELECT RAISE(ABORT, 'Principal-client fork initiator is immutable');
END;

CREATE TRIGGER thread_fork_origins_immutable_delete
BEFORE DELETE ON thread_fork_origins
WHEN NOT (
  OLD.origin_state = 'prepared' AND EXISTS (
    SELECT 1 FROM aborted_thread_forks AS aborted
    WHERE aborted.tenant_id = OLD.tenant_id
      AND aborted.owner_principal_id = OLD.owner_principal_id
      AND aborted.creation_operation_id = OLD.creation_operation_id
      AND aborted.reserved_child_thread_id = OLD.child_thread_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_origins_immutable_update
BEFORE UPDATE ON thread_fork_origins
WHEN NOT (
  (OLD.origin_state = 'prepared' AND OLD.committed_at IS NULL
    AND NEW.origin_state = 'committed' AND NEW.committed_at IS NOT NULL
    AND NEW.tenant_id = OLD.tenant_id
    AND NEW.owner_principal_id = OLD.owner_principal_id
    AND NEW.child_thread_id = OLD.child_thread_id
    AND NEW.provider_parent_backend_conversation_id IS
      OLD.provider_parent_backend_conversation_id
    AND NEW.source_thread_state = OLD.source_thread_state
    AND NEW.source_thread_id IS OLD.source_thread_id
    AND NEW.environment_id = OLD.environment_id
    AND NEW.workspace_id = OLD.workspace_id
    AND NEW.backend_instance_id = OLD.backend_instance_id
    AND NEW.connection_profile_id = OLD.connection_profile_id
    AND NEW.source_turn_state = OLD.source_turn_state
    AND NEW.source_turn_id IS OLD.source_turn_id
    AND NEW.source_turn_revision IS OLD.source_turn_revision
    AND NEW.source_checkpoint_id IS OLD.source_checkpoint_id
    AND NEW.boundary_kind = OLD.boundary_kind
    AND NEW.origin_kind = OLD.origin_kind
    AND NEW.initiating_principal_id IS OLD.initiating_principal_id
    AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
    AND NEW.initiating_tool_client_id IS OLD.initiating_tool_client_id
    AND NEW.source_automation_id IS OLD.source_automation_id
    AND NEW.source_automation_run_id IS OLD.source_automation_run_id
    AND NEW.branch_method = OLD.branch_method
    AND NEW.creation_operation_id IS OLD.creation_operation_id
    AND NEW.created_at = OLD.created_at
    AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at)
  OR
  (OLD.origin_kind = 'imported_native_fork'
    AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
    AND OLD.source_thread_state = 'unresolved'
    AND NEW.source_thread_state = 'resolved'
    AND OLD.source_thread_id IS NULL AND NEW.source_thread_id IS NOT NULL
    AND NEW.tenant_id = OLD.tenant_id
    AND NEW.owner_principal_id = OLD.owner_principal_id
    AND NEW.child_thread_id = OLD.child_thread_id
    AND NEW.provider_parent_backend_conversation_id =
      OLD.provider_parent_backend_conversation_id
    AND NEW.environment_id = OLD.environment_id
    AND NEW.workspace_id = OLD.workspace_id
    AND NEW.backend_instance_id = OLD.backend_instance_id
    AND NEW.connection_profile_id = OLD.connection_profile_id
    AND NEW.source_turn_state = OLD.source_turn_state
    AND NEW.source_turn_id IS OLD.source_turn_id
    AND NEW.source_turn_revision IS OLD.source_turn_revision
    AND NEW.source_checkpoint_id IS OLD.source_checkpoint_id
    AND NEW.boundary_kind = OLD.boundary_kind
    AND NEW.initiating_principal_id IS OLD.initiating_principal_id
    AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
    AND NEW.initiating_tool_client_id IS OLD.initiating_tool_client_id
    AND NEW.source_automation_id IS OLD.source_automation_id
    AND NEW.source_automation_run_id IS OLD.source_automation_run_id
    AND NEW.branch_method = OLD.branch_method
    AND NEW.creation_operation_id IS OLD.creation_operation_id
    AND NEW.created_at = OLD.created_at
    AND NEW.committed_at = OLD.committed_at
    AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at)
  OR
  (OLD.origin_kind = 'imported_native_fork'
    AND OLD.origin_state = 'committed' AND NEW.origin_state = 'committed'
    AND OLD.source_thread_state = 'resolved'
    AND NEW.source_thread_state = 'resolved'
    AND NEW.source_thread_id = OLD.source_thread_id
    AND OLD.source_turn_state = 'unresolved'
    AND NEW.source_turn_state = 'resolved'
    AND OLD.source_turn_id IS NULL AND NEW.source_turn_id IS NOT NULL
    AND OLD.source_checkpoint_id IS NULL
    AND NEW.tenant_id = OLD.tenant_id
    AND NEW.owner_principal_id = OLD.owner_principal_id
    AND NEW.child_thread_id = OLD.child_thread_id
    AND NEW.provider_parent_backend_conversation_id =
      OLD.provider_parent_backend_conversation_id
    AND NEW.environment_id = OLD.environment_id
    AND NEW.workspace_id = OLD.workspace_id
    AND NEW.backend_instance_id = OLD.backend_instance_id
    AND NEW.connection_profile_id = OLD.connection_profile_id
    AND NEW.source_turn_revision IS OLD.source_turn_revision
    AND NEW.boundary_kind = OLD.boundary_kind
    AND NEW.initiating_principal_id IS OLD.initiating_principal_id
    AND NEW.initiating_agent_thread_id IS OLD.initiating_agent_thread_id
    AND NEW.initiating_tool_client_id IS OLD.initiating_tool_client_id
    AND NEW.source_automation_id IS OLD.source_automation_id
    AND NEW.source_automation_run_id IS OLD.source_automation_run_id
    AND NEW.branch_method = OLD.branch_method
    AND NEW.creation_operation_id IS OLD.creation_operation_id
    AND NEW.created_at = OLD.created_at
    AND NEW.committed_at = OLD.committed_at
    AND NEW.source_turn_completed_at IS OLD.source_turn_completed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_origins_fork_point_immutable
BEFORE UPDATE OF source_turn_completed_at ON thread_fork_origins
WHEN NEW.source_turn_completed_at IS NOT OLD.source_turn_completed_at
BEGIN
  SELECT RAISE(ABORT, 'Fork origins are immutable');
END;

CREATE TRIGGER thread_fork_force_reset_automation_insert
BEFORE INSERT ON thread_fork_origins
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
  SELECT RAISE(ABORT, 'Force-reset automation cannot create a fork');
END;

CREATE TRIGGER thread_force_reset_abandoned_fork_commit
BEFORE UPDATE OF origin_state ON thread_fork_origins
WHEN OLD.origin_state = 'prepared' AND NEW.origin_state = 'committed'
  AND EXISTS (
    SELECT 1 FROM thread_force_reset_abandoned_forks AS abandoned
    WHERE abandoned.tenant_id = OLD.tenant_id
      AND abandoned.principal_id = OLD.owner_principal_id
      AND abandoned.child_thread_id = OLD.child_thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset fork origin cannot be committed');
END;

CREATE TRIGGER thread_lineage_closure_origin_insert
AFTER INSERT ON thread_fork_origins
WHEN NEW.source_thread_state = 'resolved' AND NEW.origin_state = 'committed'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;

CREATE TRIGGER thread_lineage_closure_origin_commit
AFTER UPDATE OF origin_state ON thread_fork_origins
WHEN OLD.origin_state = 'prepared' AND NEW.origin_state = 'committed'
  AND NEW.source_thread_state = 'resolved'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;

CREATE TRIGGER thread_lineage_closure_source_resolution
AFTER UPDATE OF source_thread_state, source_thread_id ON thread_fork_origins
WHEN OLD.source_thread_state = 'unresolved'
  AND NEW.source_thread_state = 'resolved'
  AND NEW.origin_state = 'committed'
BEGIN
  INSERT INTO thread_lineage_closure(
    tenant_id, owner_principal_id, ancestor_thread_id,
    descendant_thread_id, depth, descendant_created_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id,
    source.ancestor_thread_id, descendant.descendant_thread_id,
    source.depth + 1 + descendant.depth, descendant.descendant_created_at
  FROM (
    SELECT ancestor_thread_id, depth FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND descendant_thread_id = NEW.source_thread_id
    UNION ALL SELECT NEW.source_thread_id, 0
  ) AS source
  CROSS JOIN (
    SELECT descendant_thread_id, depth, descendant_created_at
    FROM thread_lineage_closure
    WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.owner_principal_id
      AND ancestor_thread_id = NEW.child_thread_id
    UNION ALL SELECT NEW.child_thread_id, 0, NEW.created_at
  ) AS descendant;
END;
`,
} as const;
