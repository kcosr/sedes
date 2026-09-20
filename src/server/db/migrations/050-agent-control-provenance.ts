import type { DatabaseMigration } from "../migrate.js";

const sqliteUnicodeWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((codePoint) => `char(${codePoint})`)
  .join(" || ");

/**
 * Adds principal-scoped, thread-attributed provenance for agent-control
 * submissions and forks. Agent-control first sends intentionally do not
 * consume the independently owned browser composer draft.
 */
export const agentControlProvenanceMigration: DatabaseMigration = {
  version: 50,
  name: "agent-control-provenance",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE conversation_creation_attempts_v50 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('first_input', 'fork')),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('composer', 'automation', 'user_fork', 'agent_control')
  ),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
  ),
  initial_input_text TEXT CHECK (
    initial_input_text IS NULL
    OR length(CAST(initial_input_text AS BLOB)) <= 65536
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
  initial_context_excerpts_json TEXT NOT NULL DEFAULT '[]' CHECK (
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
      AND initiating_agent_thread_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL)
    OR (source_kind = 'agent_control' AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL)
  ),
  CHECK (
    (creation_kind = 'first_input'
      AND source_kind IN ('composer', 'automation', 'agent_control'))
    OR (creation_kind = 'fork'
      AND source_kind IN ('user_fork', 'automation', 'agent_control'))
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

INSERT INTO conversation_creation_attempts_v50(
  tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initiating_agent_thread_id,
  initial_input_text, consumed_draft_revision, backend_creation_correlation,
  phase, provisional_backend_conversation_id,
  provisional_opaque_binding_detail, reconciliation_token, retry_anchor,
  retry_authorized_at, retry_mutation_id, retry_started_at,
  retry_reconciliation_token, backend_correlation, completion_identity,
  diagnostic, prepared_at, external_call_started_at, accepted_at,
  reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id,
  initial_context_excerpts_json, force_reset_at, force_reset_mutation_id
)
SELECT tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, NULL,
  initial_input_text, consumed_draft_revision, backend_creation_correlation,
  phase, provisional_backend_conversation_id,
  provisional_opaque_binding_detail, reconciliation_token, retry_anchor,
  retry_authorized_at, retry_mutation_id, retry_started_at,
  retry_reconciliation_token, backend_correlation, completion_identity,
  diagnostic, prepared_at, external_call_started_at, accepted_at,
  reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id,
  initial_context_excerpts_json, force_reset_at, force_reset_mutation_id
FROM conversation_creation_attempts;

DROP TABLE conversation_creation_attempts;
ALTER TABLE conversation_creation_attempts_v50
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
WHEN (OLD.creation_kind = 'fork'
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
      OR NEW.phase <> 'recovery_required'))
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_pair_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork'
    AND NEW.source_kind IN ('user_fork', 'agent_control')
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_pair_update
BEFORE UPDATE OF fork_context_boundary_version, fork_context_boundary_state,
  creation_kind, source_kind ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork'
    AND NEW.source_kind IN ('user_fork', 'agent_control')
  ))
  OR NEW.fork_context_boundary_version IS NOT OLD.fork_context_boundary_version
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_transition
BEFORE UPDATE OF fork_context_boundary_state ON conversation_creation_attempts
WHEN OLD.fork_context_boundary_version = 1
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
  AND NEW.source_kind IN ('user_fork', 'agent_control')
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_update
BEFORE UPDATE OF phase, fork_context_boundary_state
ON conversation_creation_attempts
WHEN NEW.phase = 'bound' AND NEW.creation_kind = 'fork'
  AND NEW.source_kind IN ('user_fork', 'agent_control')
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

CREATE TRIGGER conversation_creation_attempts_content_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (trim(NEW.initial_input_text, ${sqliteUnicodeWhitespace}) <> '')
  AND NEW.initial_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.initial_context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'),
        ${sqliteUnicodeWhitespace}) <> ''
  )
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_skill_id,
  initial_context_excerpts_json ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (trim(NEW.initial_input_text, ${sqliteUnicodeWhitespace}) <> '')
  AND NEW.initial_skill_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.initial_context_excerpts_json) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND trim(json_extract(excerpt.value, '$.note'),
        ${sqliteUnicodeWhitespace}) <> ''
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

-- Keep the force-reset tombstone guard newest so it remains the first update
-- guard SQLite evaluates, preserving the authoritative immutable diagnostic.
DROP TRIGGER conversation_creation_attempts_force_reset_immutable_update;
DROP TRIGGER conversation_creation_attempts_force_reset_immutable_delete;
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

ALTER TABLE queued_inputs ADD COLUMN initiating_agent_thread_id TEXT CHECK (
  initiating_agent_thread_id IS NULL
  OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
);

CREATE TRIGGER queued_inputs_agent_control_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT NULL AND (
  NEW.trigger_kind <> 'user'
  OR NEW.source_automation_id IS NOT NULL
  OR NEW.source_automation_run_id IS NOT NULL
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

CREATE TRIGGER queued_inputs_agent_control_provenance_update
BEFORE UPDATE OF initiating_agent_thread_id ON queued_inputs
WHEN NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
BEGIN
  SELECT RAISE(ABORT, 'Agent-control queue source thread is immutable');
END;

ALTER TABLE thread_fork_origins ADD COLUMN initiating_agent_thread_id TEXT CHECK (
  initiating_agent_thread_id IS NULL
  OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
);

CREATE TRIGGER thread_fork_origins_agent_control_insert
BEFORE INSERT ON thread_fork_origins
WHEN (NEW.origin_kind = 'agent_fork') !=
      (NEW.initiating_agent_thread_id IS NOT NULL)
  OR (NEW.initiating_agent_thread_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM application_threads AS source
    WHERE source.tenant_id = NEW.tenant_id
      AND source.owner_principal_id = NEW.owner_principal_id
      AND source.id = NEW.initiating_agent_thread_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is invalid');
END;

CREATE TRIGGER thread_fork_origins_agent_control_update
BEFORE UPDATE OF origin_kind, initiating_agent_thread_id ON thread_fork_origins
WHEN NEW.origin_kind IS NOT OLD.origin_kind
  OR NEW.initiating_agent_thread_id IS NOT OLD.initiating_agent_thread_id
BEGIN
  SELECT RAISE(ABORT, 'Agent fork initiating thread is immutable');
END;

CREATE TRIGGER application_threads_agent_control_provenance_delete
BEFORE DELETE ON application_threads
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS queued
  WHERE queued.tenant_id = OLD.tenant_id
    AND queued.owner_principal_id = OLD.owner_principal_id
    AND queued.initiating_agent_thread_id = OLD.id
) OR EXISTS (
  SELECT 1 FROM thread_fork_origins AS origin
  WHERE origin.tenant_id = OLD.tenant_id
    AND origin.owner_principal_id = OLD.owner_principal_id
    AND origin.initiating_agent_thread_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent-control provenance source thread is referenced');
END;

CREATE TABLE aborted_thread_forks_v50 (
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
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('automation', 'user_fork', 'agent_control')
  ),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initiating_agent_thread_id TEXT CHECK (
    initiating_agent_thread_id IS NULL
    OR length(initiating_agent_thread_id) BETWEEN 1 AND 128
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
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id,
    source_automation_run_id)
    REFERENCES automation_runs(tenant_id, owner_principal_id, automation_id, id)
    ON DELETE RESTRICT,
  CHECK ((source_kind = 'user_fork' AND source_turn_id IS NOT NULL
      AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL
      AND initiating_agent_thread_id IS NULL)
    OR (source_kind = 'agent_control' AND source_turn_id IS NOT NULL
      AND source_turn_revision IS NOT NULL
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL
      AND initiating_agent_thread_id IS NOT NULL))
) STRICT;

INSERT INTO aborted_thread_forks_v50(
  tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, source_kind, source_automation_id,
  source_automation_run_id, initiating_agent_thread_id, diagnostic, aborted_at
)
SELECT tenant_id, owner_principal_id, creation_operation_id,
  reserved_child_thread_id, source_thread_id, source_turn_id,
  source_turn_revision, source_kind, source_automation_id,
  source_automation_run_id, NULL, diagnostic, aborted_at
FROM aborted_thread_forks;

DROP TABLE aborted_thread_forks;
ALTER TABLE aborted_thread_forks_v50 RENAME TO aborted_thread_forks;
`,
} as const;
