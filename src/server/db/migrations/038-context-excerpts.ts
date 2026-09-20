import type { DatabaseMigration } from "../migrate.js";

const contextArrayConstraint = `
  CHECK (
    json_valid(context_excerpts_json)
    AND json_type(context_excerpts_json) = 'array'
    AND length(CAST(context_excerpts_json AS BLOB)) <= 4194304
  )`;

const sqliteWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((codePoint) => `char(${codePoint})`)
  .join(" || ");

export const isNonWhitespace = (value: string) =>
  `trim(${value}, ${sqliteWhitespace}) <> ''`;

export const annotatedContext = (column: string) => `EXISTS (
    SELECT 1
    FROM json_each(${column}) AS excerpt
    WHERE json_type(excerpt.value, '$.note') = 'text'
      AND ${isNonWhitespace("json_extract(excerpt.value, '$.note')")}
  )`;

/**
 * Context excerpts are principal-owned composer snapshots. Paths and source
 * locators stored here are presentation provenance and confer no read
 * authority.
 */
export const contextExcerptsMigration: DatabaseMigration = {
  version: 38,
  name: "context-excerpts",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE thread_drafts
  ADD COLUMN context_excerpts_json TEXT NOT NULL DEFAULT '[]'
  ${contextArrayConstraint};

CREATE TABLE prompt_stashes_v38 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  selected_skill_id TEXT CHECK (
    selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160
  ),
  context_excerpts_json TEXT NOT NULL DEFAULT '[]'
  ${contextArrayConstraint},
  PRIMARY KEY (tenant_id, principal_id, thread_id, id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(
      tenant_id, principal_id, thread_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO prompt_stashes_v38(
  tenant_id, principal_id, thread_id, id, text, created_at,
  selected_skill_id, context_excerpts_json
)
SELECT tenant_id, principal_id, thread_id, id, text, created_at,
  selected_skill_id, '[]'
FROM prompt_stashes;

DROP TABLE prompt_stashes;
ALTER TABLE prompt_stashes_v38 RENAME TO prompt_stashes;

CREATE INDEX prompt_stashes_newest
  ON prompt_stashes(
    tenant_id, principal_id, thread_id, created_at DESC, id
  );

CREATE TRIGGER prompt_stashes_content_insert
BEFORE INSERT ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

CREATE TRIGGER prompt_stashes_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json
ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

DROP TRIGGER automation_runs_queued_provenance_delete;
DROP TRIGGER automation_runs_queued_provenance_update;

CREATE TABLE queued_inputs_v38 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  text TEXT NOT NULL CHECK (
    length(CAST(text AS BLOB)) <= 65536
  ),
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
    reconciliation_token IS NULL
    OR length(reconciliation_token) BETWEEN 1 AND 512
  ),
  retry_anchor TEXT CHECK (
    retry_anchor IS NULL
    OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096
  ),
  backend_correlation TEXT CHECK (
    backend_correlation IS NULL
    OR length(backend_correlation) BETWEEN 1 AND 512
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
    source_automation_id IS NULL
    OR length(source_automation_id) BETWEEN 1 AND 128
  ),
  source_automation_run_id TEXT CHECK (
    source_automation_run_id IS NULL
    OR length(source_automation_run_id) BETWEEN 1 AND 128
  ),
  selected_skill_id TEXT CHECK (
    selected_skill_id IS NULL OR length(selected_skill_id) BETWEEN 1 AND 160
  ),
  context_excerpts_json TEXT NOT NULL DEFAULT '[]'
  ${contextArrayConstraint},
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id, sequence
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id, mutation_id
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id, id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, retry_of_id
  ) REFERENCES queued_inputs_v38(
    tenant_id, owner_principal_id, application_thread_id, id
  ) ON DELETE RESTRICT,
  CHECK (retry_of_id IS NULL OR retry_of_id <> id),
  CHECK (
    (state IN ('pending', 'retry_wait')
      AND dispatch_started_at IS NULL
      AND accepted_at IS NULL
      AND resolved_at IS NULL
      AND reconciliation_token IS NULL
      AND retry_anchor IS NULL)
    OR
    (state = 'dispatching'
      AND dispatch_started_at IS NOT NULL
      AND accepted_at IS NULL
      AND resolved_at IS NULL
      AND reconciliation_token IS NOT NULL
      AND retry_anchor IS NOT NULL)
    OR
    (state = 'uncertain'
      AND dispatch_started_at IS NOT NULL
      AND accepted_at IS NULL
      AND resolved_at IS NULL
      AND reconciliation_token IS NOT NULL
      AND retry_anchor IS NOT NULL)
    OR
    (state = 'accepted'
      AND dispatch_started_at IS NOT NULL
      AND accepted_at IS NOT NULL
      AND resolved_at IS NOT NULL
      AND reconciliation_token IS NULL
      AND retry_anchor IS NULL)
    OR
    (state IN ('failed', 'cancelled')
      AND resolved_at IS NOT NULL
      AND accepted_at IS NULL
      AND reconciliation_token IS NULL
      AND retry_anchor IS NULL)
  ),
  CHECK (
    backend_correlation IS NULL OR state IN ('uncertain', 'accepted')
  ),
  CHECK (state <> 'failed' OR diagnostic IS NOT NULL),
  CHECK (
    (state = 'retry_wait' AND next_attempt_at IS NOT NULL)
    OR (state <> 'retry_wait' AND next_attempt_at IS NULL)
  ),
  CHECK (
    failure_acknowledged_at IS NULL
    OR (
      state = 'failed'
      AND resolved_at IS NOT NULL
      AND failure_acknowledged_at >= resolved_at
    )
  )
) STRICT;

INSERT INTO queued_inputs_v38(
  tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, context_excerpts_json
)
SELECT tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, '[]'
FROM queued_inputs;

DROP TABLE queued_inputs;
ALTER TABLE queued_inputs_v38 RENAME TO queued_inputs;

CREATE UNIQUE INDEX queued_inputs_one_explicit_retry
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id, retry_of_id
  )
  WHERE retry_of_id IS NOT NULL;

CREATE INDEX queued_inputs_dispatch
  ON queued_inputs(
    state, next_attempt_at, tenant_id, owner_principal_id,
    application_thread_id, sequence
  )
  WHERE state IN ('pending', 'retry_wait');

CREATE TRIGGER automation_runs_queued_provenance_delete
BEFORE DELETE ON automation_runs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS queued
  WHERE queued.tenant_id = OLD.tenant_id
    AND queued.owner_principal_id = OLD.owner_principal_id
    AND queued.source_automation_id = OLD.automation_id
    AND queued.source_automation_run_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run is referenced by queued input provenance');
END;

CREATE TRIGGER automation_runs_queued_provenance_update
BEFORE UPDATE OF tenant_id, owner_principal_id, automation_id, id,
  dispatch_mutation_id, anchor_thread_id, child_thread_id
ON automation_runs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS queued
  WHERE queued.tenant_id = OLD.tenant_id
    AND queued.owner_principal_id = OLD.owner_principal_id
    AND queued.source_automation_id = OLD.automation_id
    AND queued.source_automation_run_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Automation run is referenced by queued input provenance');
END;

CREATE TRIGGER queued_inputs_content_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER queued_inputs_content_update
BEFORE UPDATE OF text, context_excerpts_json ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (
  (NEW.trigger_kind = 'user'
    AND NEW.source_automation_id IS NULL
    AND NEW.source_automation_run_id IS NULL
    AND (
      NEW.retry_of_id IS NULL
      OR EXISTS (
        SELECT 1 FROM queued_inputs AS parent
        WHERE parent.tenant_id = NEW.tenant_id
          AND parent.owner_principal_id = NEW.owner_principal_id
          AND parent.application_thread_id = NEW.application_thread_id
          AND parent.id = NEW.retry_of_id
          AND parent.trigger_kind = 'user'
          AND parent.source_automation_id IS NULL
          AND parent.source_automation_run_id IS NULL
      )
    ))
  OR
  (NEW.trigger_kind = 'automation'
    AND NEW.source_automation_id IS NOT NULL
    AND NEW.source_automation_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM automation_runs AS run
      WHERE run.tenant_id = NEW.tenant_id
        AND run.owner_principal_id = NEW.owner_principal_id
        AND run.automation_id = NEW.source_automation_id
        AND run.id = NEW.source_automation_run_id
        AND coalesce(run.child_thread_id, run.anchor_thread_id) =
          NEW.application_thread_id
        AND (
          (NEW.retry_of_id IS NULL
            AND run.dispatch_mutation_id = NEW.mutation_id)
          OR
          (NEW.retry_of_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM queued_inputs AS parent
            WHERE parent.tenant_id = NEW.tenant_id
              AND parent.owner_principal_id = NEW.owner_principal_id
              AND parent.application_thread_id = NEW.application_thread_id
              AND parent.id = NEW.retry_of_id
              AND parent.trigger_kind = 'automation'
              AND parent.source_automation_id = NEW.source_automation_id
              AND parent.source_automation_run_id =
                NEW.source_automation_run_id
          ))
        )
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input trigger provenance is invalid');
END;

CREATE TRIGGER queued_inputs_trigger_provenance_update
BEFORE UPDATE OF
  tenant_id, owner_principal_id, id, application_thread_id,
  mutation_id, retry_of_id, trigger_kind,
  source_automation_id, source_automation_run_id
ON queued_inputs
WHEN NOT (
  (NEW.trigger_kind = 'user'
    AND NEW.source_automation_id IS NULL
    AND NEW.source_automation_run_id IS NULL
    AND (
      NEW.retry_of_id IS NULL
      OR EXISTS (
        SELECT 1 FROM queued_inputs AS parent
        WHERE parent.tenant_id = NEW.tenant_id
          AND parent.owner_principal_id = NEW.owner_principal_id
          AND parent.application_thread_id = NEW.application_thread_id
          AND parent.id = NEW.retry_of_id
          AND parent.trigger_kind = 'user'
          AND parent.source_automation_id IS NULL
          AND parent.source_automation_run_id IS NULL
      )
    ))
  OR
  (NEW.trigger_kind = 'automation'
    AND NEW.source_automation_id IS NOT NULL
    AND NEW.source_automation_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM automation_runs AS run
      WHERE run.tenant_id = NEW.tenant_id
        AND run.owner_principal_id = NEW.owner_principal_id
        AND run.automation_id = NEW.source_automation_id
        AND run.id = NEW.source_automation_run_id
        AND coalesce(run.child_thread_id, run.anchor_thread_id) =
          NEW.application_thread_id
        AND (
          (NEW.retry_of_id IS NULL
            AND run.dispatch_mutation_id = NEW.mutation_id)
          OR
          (NEW.retry_of_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM queued_inputs AS parent
            WHERE parent.tenant_id = NEW.tenant_id
              AND parent.owner_principal_id = NEW.owner_principal_id
              AND parent.application_thread_id = NEW.application_thread_id
              AND parent.id = NEW.retry_of_id
              AND parent.trigger_kind = 'automation'
              AND parent.source_automation_id = NEW.source_automation_id
              AND parent.source_automation_run_id =
                NEW.source_automation_run_id
          ))
        )
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input trigger provenance is invalid');
END;

CREATE TRIGGER queued_inputs_retry_provenance_parent_update
BEFORE UPDATE OF
  tenant_id, owner_principal_id, id, application_thread_id,
  trigger_kind, source_automation_id, source_automation_run_id
ON queued_inputs
WHEN EXISTS (
  SELECT 1 FROM queued_inputs AS child
  WHERE child.tenant_id = OLD.tenant_id
    AND child.owner_principal_id = OLD.owner_principal_id
    AND child.application_thread_id = OLD.application_thread_id
    AND child.retry_of_id = OLD.id
    AND NOT (
      NEW.tenant_id = child.tenant_id
      AND NEW.owner_principal_id = child.owner_principal_id
      AND NEW.id = child.retry_of_id
      AND NEW.application_thread_id = child.application_thread_id
      AND NEW.trigger_kind = child.trigger_kind
      AND NEW.source_automation_id IS child.source_automation_id
      AND NEW.source_automation_run_id IS child.source_automation_run_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input retry provenance parent is referenced');
END;

CREATE TABLE conversation_creation_attempts_v38 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('first_input', 'fork')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('composer', 'automation', 'user_fork')),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
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
    retry_anchor IS NULL
    OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096
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
    fork_creation_recovery IS NULL
    OR fork_creation_recovery IN (
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
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id, attempt_id),
  UNIQUE (tenant_id, owner_principal_id, application_thread_id, attempt_id,
    backend_instance_id, execution_environment_id),
  UNIQUE (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id,
      backend_instance_id, connection_profile_id, environment_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id,
    source_automation_run_id)
    REFERENCES automation_runs(tenant_id, owner_principal_id, automation_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (creation_kind = 'first_input' AND initial_input_text IS NOT NULL)
    OR (creation_kind = 'fork' AND initial_input_text IS NULL)
  ),
  CHECK (
    (source_kind = 'composer' AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL)
    OR (source_kind = 'user_fork' AND source_automation_id IS NULL
      AND source_automation_run_id IS NULL)
    OR (source_kind = 'automation' AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL)
  ),
  CHECK (
    (creation_kind = 'first_input' AND source_kind IN ('composer', 'automation'))
    OR (creation_kind = 'fork' AND source_kind IN ('user_fork', 'automation'))
  ),
  CHECK (creation_kind <> 'fork'
    OR phase NOT IN ('first_submission_started', 'accepted_unpersisted')),
  CHECK (
    (source_kind = 'composer'
      AND (consumed_draft_revision IS NOT NULL OR phase = 'aborted_unpersisted'))
    OR (source_kind <> 'composer' AND consumed_draft_revision IS NULL)
  ),
  CHECK (
    (retry_mutation_id IS NULL AND retry_started_at IS NULL
      AND retry_reconciliation_token IS NULL)
    OR (retry_mutation_id IS NOT NULL AND retry_started_at IS NOT NULL
      AND retry_reconciliation_token IS NOT NULL AND retry_anchor IS NOT NULL)
  ),
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
  CHECK (external_call_started_at IS NULL
    OR external_call_started_at >= prepared_at),
  CHECK (accepted_at IS NULL OR accepted_at >= prepared_at),
  CHECK (reconciled_at IS NULL OR reconciled_at >= prepared_at),
  CHECK (retry_authorized_at IS NULL OR retry_authorized_at >= prepared_at),
  CHECK (retry_started_at IS NULL OR retry_started_at >= prepared_at)
) STRICT;

INSERT INTO conversation_creation_attempts_v38(
  tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initial_input_text,
  consumed_draft_revision, backend_creation_correlation, phase,
  provisional_backend_conversation_id, provisional_opaque_binding_detail,
  reconciliation_token, retry_anchor, retry_authorized_at, retry_mutation_id,
  retry_started_at, retry_reconciliation_token, backend_correlation,
  completion_identity, diagnostic, prepared_at, external_call_started_at,
  accepted_at, reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id, initial_context_excerpts_json
)
SELECT tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initial_input_text,
  consumed_draft_revision, backend_creation_correlation, phase,
  provisional_backend_conversation_id, provisional_opaque_binding_detail,
  reconciliation_token, retry_anchor, retry_authorized_at, retry_mutation_id,
  retry_started_at, retry_reconciliation_token, backend_correlation,
  completion_identity, diagnostic, prepared_at, external_call_started_at,
  accepted_at, reconciled_at, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, fork_context_boundary_version,
  fork_context_boundary_state, initial_skill_id, '[]'
FROM conversation_creation_attempts;

DROP TABLE conversation_creation_attempts;
ALTER TABLE conversation_creation_attempts_v38
  RENAME TO conversation_creation_attempts;

CREATE UNIQUE INDEX conversation_creation_attempts_one_active
  ON conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE phase NOT IN ('bound', 'aborted_unpersisted');

CREATE TRIGGER conversation_creation_attempts_content_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_context_excerpts_json
ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_fork_contract_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN (
  NEW.creation_kind = 'fork'
  AND (NEW.fork_child_identity IS NULL OR NEW.fork_creation_recovery IS NULL)
) OR (
  NEW.creation_kind = 'first_input'
  AND (NEW.fork_child_identity IS NOT NULL
    OR NEW.fork_creation_recovery IS NOT NULL
    OR NEW.fork_uncertainty_kind IS NOT NULL)
) OR (
  NEW.fork_uncertainty_kind = 'fork_unknown'
  AND (NEW.creation_kind <> 'fork'
    OR NEW.fork_creation_recovery <> 'potentially_unknown'
    OR NEW.phase <> 'recovery_required')
)
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE TRIGGER conversation_creation_attempts_fork_contract_update
BEFORE UPDATE OF creation_kind, fork_child_identity, fork_creation_recovery,
  fork_uncertainty_kind, phase
ON conversation_creation_attempts
WHEN (
  OLD.creation_kind = 'fork'
  AND (NEW.fork_child_identity IS NOT OLD.fork_child_identity
    OR NEW.fork_creation_recovery IS NOT OLD.fork_creation_recovery)
) OR (
  NEW.creation_kind = 'fork'
  AND (NEW.fork_child_identity IS NULL OR NEW.fork_creation_recovery IS NULL)
) OR (
  NEW.creation_kind = 'first_input'
  AND (NEW.fork_child_identity IS NOT NULL
    OR NEW.fork_creation_recovery IS NOT NULL
    OR NEW.fork_uncertainty_kind IS NOT NULL)
) OR (
  NEW.fork_uncertainty_kind = 'fork_unknown'
  AND (NEW.creation_kind <> 'fork'
    OR NEW.fork_creation_recovery <> 'potentially_unknown'
    OR NEW.phase <> 'recovery_required')
)
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_pair_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork' AND NEW.source_kind = 'user_fork'
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
    NEW.creation_kind = 'fork' AND NEW.source_kind = 'user_fork'
  ))
  OR NEW.fork_context_boundary_version IS NOT OLD.fork_context_boundary_version
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_transition
BEFORE UPDATE OF fork_context_boundary_state ON conversation_creation_attempts
WHEN OLD.fork_context_boundary_version = 1
  AND NEW.fork_context_boundary_state IS NOT OLD.fork_context_boundary_state
  AND NOT (
    (OLD.fork_context_boundary_state = 'pending'
      AND NEW.fork_context_boundary_state = 'applying')
    OR (OLD.fork_context_boundary_state = 'applying'
      AND NEW.fork_context_boundary_state IN ('pending', 'applied', 'unknown'))
    OR (OLD.fork_context_boundary_state IN ('pending', 'applying', 'unknown')
      AND NEW.fork_context_boundary_state = 'applied')
  )
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary transition');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.phase = 'bound'
  AND NEW.creation_kind = 'fork'
  AND NEW.source_kind = 'user_fork'
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_update
BEFORE UPDATE OF phase, fork_context_boundary_state
ON conversation_creation_attempts
WHEN NEW.phase = 'bound'
  AND NEW.creation_kind = 'fork'
  AND NEW.source_kind = 'user_fork'
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

UPDATE mutation_receipts
SET result_json = json_set(
  result_json,
  '$.version', 3,
  '$.contextExcerpts', json('[]')
)
WHERE operation_kind = 'conversation_steer';
`,
};
