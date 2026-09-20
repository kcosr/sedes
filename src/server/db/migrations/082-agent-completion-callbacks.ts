import type { DatabaseMigration } from "../migrate.js";
import { annotatedContext, isNonWhitespace } from "./038-context-excerpts.js";

const jsonArrayConstraint = (column: string) => `
  CHECK (
    json_valid(${column})
    AND json_type(${column}) = 'array'
    AND length(CAST(${column} AS BLOB)) <= 4194304
  )`;

/**
 * Durable, principal-scoped completion continuations. The callback obligation
 * is intentionally separate from queue delivery state: completion
 * materialization creates exactly one ordinary queued input, after which the
 * existing queue owns delivery and recovery.
 */
export const agentCompletionCallbacksMigration: DatabaseMigration = {
  version: 82,
  name: "agent-completion-callbacks",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE submission_completion_observations
  ADD COLUMN application_turn_id TEXT CHECK (
    application_turn_id IS NULL OR length(application_turn_id) BETWEEN 1 AND 160
  );
ALTER TABLE submission_completion_observations
  ADD COLUMN completion_outcome TEXT CHECK (
    completion_outcome IS NULL
    OR completion_outcome IN ('completed', 'interrupted', 'failed')
  );
ALTER TABLE submission_completion_observations
  ADD COLUMN assistant_result_json TEXT CHECK (
    assistant_result_json IS NULL OR (
      json_valid(assistant_result_json)
      AND json_type(assistant_result_json) = 'object'
      AND length(CAST(assistant_result_json AS BLOB)) <= 65536
    )
  );

CREATE TRIGGER submission_completion_final_snapshot_insert
BEFORE INSERT ON submission_completion_observations
WHEN NOT (
  (NEW.application_turn_id IS NULL
    AND NEW.completion_outcome IS NULL
    AND NEW.assistant_result_json IS NULL)
  OR
  (NEW.last_completion_identity IS NOT NULL
    AND NEW.completion_observed_at IS NOT NULL
    AND NEW.application_turn_id IS NOT NULL
    AND NEW.completion_outcome IS NOT NULL
    AND NEW.assistant_result_json IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Completion final snapshot is incomplete');
END;

CREATE TRIGGER submission_completion_final_snapshot_update
BEFORE UPDATE OF last_completion_identity, completion_observed_at,
  application_turn_id, completion_outcome, assistant_result_json
ON submission_completion_observations
WHEN NOT (
  (NEW.application_turn_id IS NULL
    AND NEW.completion_outcome IS NULL
    AND NEW.assistant_result_json IS NULL)
  OR
  (NEW.last_completion_identity IS NOT NULL
    AND NEW.completion_observed_at IS NOT NULL
    AND NEW.application_turn_id IS NOT NULL
    AND NEW.completion_outcome IS NOT NULL
    AND NEW.assistant_result_json IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Completion final snapshot is incomplete');
END;

CREATE TRIGGER submission_completion_final_snapshot_immutable
BEFORE UPDATE OF application_turn_id, completion_outcome, assistant_result_json
ON submission_completion_observations
WHEN OLD.application_turn_id IS NOT NULL AND (
  NEW.application_turn_id IS NOT OLD.application_turn_id
  OR NEW.completion_outcome IS NOT OLD.completion_outcome
  OR NEW.assistant_result_json IS NOT OLD.assistant_result_json
)
BEGIN
  SELECT RAISE(ABORT, 'Completion final snapshot is immutable');
END;

ALTER TABLE delivery_input_snapshots
  ADD COLUMN origin_json TEXT CHECK (
    origin_json IS NULL OR (
      json_valid(origin_json)
      AND json_type(origin_json) = 'object'
      AND length(CAST(origin_json AS BLOB)) <= 4096
    )
  );

CREATE TABLE thread_completion_callbacks (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 36),
  caller_thread_id TEXT NOT NULL CHECK (
    length(caller_thread_id) BETWEEN 1 AND 128
  ),
  target_thread_id TEXT NOT NULL CHECK (
    length(target_thread_id) BETWEEN 1 AND 128
  ),
  target_operation_id TEXT NOT NULL CHECK (
    length(target_operation_id) BETWEEN 1 AND 200
  ),
  state TEXT NOT NULL CHECK (
    state IN ('registered', 'materialized', 'cancelled')
  ),
  registered_at INTEGER NOT NULL CHECK (registered_at >= 0),
  materialized_at INTEGER CHECK (materialized_at IS NULL OR materialized_at >= 0),
  cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at >= 0),
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL
    OR length(CAST(cancellation_reason AS BLOB)) BETWEEN 1 AND 500
  ),
  cancellation_mutation_id TEXT CHECK (
    cancellation_mutation_id IS NULL
    OR length(cancellation_mutation_id) BETWEEN 1 AND 160
  ),
  completion_identity TEXT CHECK (
    completion_identity IS NULL
    OR length(completion_identity) BETWEEN 1 AND 512
  ),
  source_thread_label_json TEXT CHECK (
    source_thread_label_json IS NULL OR (
      json_valid(source_thread_label_json)
      AND json_type(source_thread_label_json) = 'object'
      AND length(CAST(source_thread_label_json AS BLOB)) <= 4096
    )
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, target_thread_id, target_operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, caller_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, target_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT,
  CHECK (caller_thread_id <> target_thread_id),
  CHECK (
    (state = 'registered'
      AND materialized_at IS NULL AND cancelled_at IS NULL
      AND cancellation_reason IS NULL AND cancellation_mutation_id IS NULL
      AND completion_identity IS NULL
      AND source_thread_label_json IS NULL)
    OR
    (state = 'materialized'
      AND materialized_at IS NOT NULL AND cancelled_at IS NULL
      AND cancellation_reason IS NULL AND cancellation_mutation_id IS NULL
      AND completion_identity IS NOT NULL
      AND source_thread_label_json IS NOT NULL)
    OR
    (state = 'cancelled'
      AND materialized_at IS NULL AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL AND cancellation_mutation_id IS NOT NULL
      AND completion_identity IS NULL
      AND source_thread_label_json IS NULL)
  )
) STRICT;

CREATE INDEX thread_completion_callbacks_registered_target
  ON thread_completion_callbacks(
    tenant_id, owner_principal_id, target_thread_id, target_operation_id
  ) WHERE state = 'registered';
CREATE INDEX thread_completion_callbacks_registered_caller
  ON thread_completion_callbacks(
    tenant_id, owner_principal_id, caller_thread_id, registered_at, id
  ) WHERE state = 'registered';

CREATE TRIGGER thread_completion_callbacks_transition
BEFORE UPDATE ON thread_completion_callbacks
WHEN OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.owner_principal_id IS NOT NEW.owner_principal_id
  OR OLD.id IS NOT NEW.id
  OR OLD.caller_thread_id IS NOT NEW.caller_thread_id
  OR OLD.target_thread_id IS NOT NEW.target_thread_id
  OR OLD.target_operation_id IS NOT NEW.target_operation_id
  OR OLD.registered_at IS NOT NEW.registered_at
  OR OLD.state <> 'registered'
  OR NEW.state = 'registered'
BEGIN
  SELECT RAISE(ABORT, 'Completion callback registration is immutable');
END;

CREATE TABLE queued_inputs_v82 (
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
  ),
  requested_steer_turn_id TEXT CHECK (
    requested_steer_turn_id IS NULL
    OR length(requested_steer_turn_id) BETWEEN 1 AND 160
  ),
  steer_fallback_at INTEGER CHECK (
    steer_fallback_at IS NULL OR steer_fallback_at >= 0
  ),
  resolved_delivery_mode TEXT NOT NULL DEFAULT 'queue' CHECK (
    resolved_delivery_mode IN ('submit', 'steer', 'queue')
  ),
  resolved_steer_turn_id TEXT CHECK (
    resolved_steer_turn_id IS NULL
    OR length(resolved_steer_turn_id) BETWEEN 1 AND 160
  ),
  completion_callback_id TEXT CHECK (
    completion_callback_id IS NULL OR length(completion_callback_id) = 36
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
      AND requested_steer_turn_id IS NULL)
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
    requested_steer_turn_id IS NULL OR (
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
      requested_steer_turn_id IS NOT NULL
      AND requested_delivery_mode = 'queue'
    )
  ),
  CHECK ((resolved_delivery_mode = 'steer') =
    (resolved_steer_turn_id IS NOT NULL)),
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

INSERT INTO queued_inputs_v82(
  tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, context_excerpts_json,
  delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint,
  initiating_agent_thread_id, initiating_tool_client_id, task_contexts_json,
  requested_delivery_mode, requested_thread_revision,
  requested_draft_revision, requested_steer_turn_id, steer_fallback_at,
  resolved_delivery_mode, resolved_steer_turn_id, completion_callback_id
)
SELECT tenant_id, owner_principal_id, id, application_thread_id, sequence,
  mutation_id, text, state, retry_of_id, created_at, dispatch_started_at,
  accepted_at, resolved_at, reconciliation_token, retry_anchor,
  backend_correlation, retry_count, invalid_state_requeues, next_attempt_at,
  diagnostic, failure_acknowledged_at, trigger_kind, source_automation_id,
  source_automation_run_id, selected_skill_id, context_excerpts_json,
  delivery_mode, cancellation_mutation_id, cancellation_request_fingerprint,
  initiating_agent_thread_id, initiating_tool_client_id, task_contexts_json,
  requested_delivery_mode, requested_thread_revision,
  requested_draft_revision, requested_steer_turn_id, steer_fallback_at,
  resolved_delivery_mode, resolved_steer_turn_id, NULL
FROM queued_inputs;

DROP TABLE queued_inputs;
ALTER TABLE queued_inputs_v82 RENAME TO queued_inputs;

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
`,
};
