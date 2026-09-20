/**
 * Atomic persistence cutover for the backend-neutral runtime.
 *
 * This migration intentionally remains outside the deployed migration list
 * until the runtime/browser cutover lands. It reads its operator-selected IDs
 * from connection-local TEMP tables populated by migrate.ts; no operator value
 * is interpolated into this checksum-locked SQL.
 */
export const backendNormalizationMigration = {
  version: 10,
  name: "backend_normalization_foundation",
  sql: `
PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE migration_010_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO migration_010_guard
SELECT abs(count(*) - 1) FROM temp.backend_normalization_context;

INSERT INTO migration_010_guard
SELECT count(*)
FROM principals AS principal
LEFT JOIN temp.backend_normalization_profiles AS profile
  ON profile.tenant_id = principal.tenant_id
  AND profile.owner_principal_id = principal.id
WHERE profile.profile_id IS NULL;

INSERT INTO migration_010_guard
SELECT count(*)
FROM application_threads AS thread
LEFT JOIN temp.backend_normalization_profiles AS profile
  ON profile.tenant_id = thread.tenant_id
  AND profile.owner_principal_id = thread.owner_principal_id
  AND profile.execution_environment_id = thread.environment_id
WHERE profile.profile_id IS NULL;

INSERT INTO migration_010_guard
SELECT count(*)
FROM application_threads AS thread
LEFT JOIN pending_first_sends AS pending
  ON pending.tenant_id = thread.tenant_id
  AND pending.principal_id = thread.owner_principal_id
  AND pending.thread_id = thread.id
WHERE
  (thread.backing_state = 'draft'
    AND (thread.materialization_attempt_id IS NOT NULL OR pending.attempt_id IS NOT NULL))
  OR
  (thread.backing_state IN ('materializing', 'materialization_failed')
    AND thread.materialization_attempt_id IS NULL)
  OR
  (pending.attempt_id IS NOT NULL
    AND pending.attempt_id <> thread.materialization_attempt_id);

INSERT INTO migration_010_guard
SELECT count(*)
FROM application_threads
WHERE backing_state = 'native'
  AND (reserved_native_session_id IS NULL OR native_session_path IS NULL);

INSERT INTO migration_010_guard
SELECT count(*)
FROM application_threads
WHERE native_session_path IS NOT NULL
  AND length(CAST(json_object(
    'version', 1,
    'backendConversationId', reserved_native_session_id,
    'sessionFile', native_session_path
  ) AS BLOB)) > 4096;

INSERT INTO migration_010_guard
SELECT count(*)
FROM pending_first_sends AS pending
LEFT JOIN application_threads AS thread
  ON thread.tenant_id = pending.tenant_id
  AND thread.owner_principal_id = pending.principal_id
  AND thread.id = pending.thread_id
WHERE thread.id IS NULL;

INSERT INTO migration_010_guard
SELECT count(*)
FROM thread_principal_state
WHERE wake_reason = 'automation';

CREATE TABLE agent_backend_instances (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind = 'pi'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  protocol_release TEXT NOT NULL CHECK (protocol_release = '0.83.0'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_backend_instances(
  tenant_id, id, kind, label, enabled, configuration_revision,
  protocol_release, created_at, updated_at
)
SELECT
  tenant.id,
  context.backend_instance_id,
  'pi',
  context.backend_label,
  context.backend_enabled,
  0,
  context.protocol_release,
  context.applied_at,
  context.applied_at
FROM tenants AS tenant
CROSS JOIN temp.backend_normalization_context AS context;

CREATE TABLE agent_connection_profiles (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  template_id TEXT NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'pi_sdk'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, template_id),
  UNIQUE (
    tenant_id, owner_principal_id, id, backend_instance_id,
    execution_environment_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, backend_instance_id)
    REFERENCES agent_backend_instances(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, execution_environment_id)
    REFERENCES execution_environments(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_connection_profiles(
  tenant_id, owner_principal_id, id, template_id, backend_instance_id,
  execution_environment_id, kind, label, enabled, configuration_revision,
  created_at, updated_at
)
SELECT
  profile.tenant_id,
  profile.owner_principal_id,
  profile.profile_id,
  context.connection_template_id,
  context.backend_instance_id,
  profile.execution_environment_id,
  'pi_sdk',
  context.connection_label,
  context.connection_enabled,
  0,
  context.applied_at,
  context.applied_at
FROM temp.backend_normalization_profiles AS profile
CROSS JOIN temp.backend_normalization_context AS context;

CREATE TABLE application_threads_v10 (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  backing_state TEXT NOT NULL CHECK (
    backing_state IN ('unbound', 'creating', 'bound', 'creation_unknown')
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  availability TEXT NOT NULL CHECK (
    availability IN (
      'available', 'missing', 'quarantined', 'environment_unavailable'
    )
  ),
  reconciliation_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, id, backend_instance_id,
    connection_profile_id, environment_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id, workspace_id)
    REFERENCES workspaces(
      tenant_id, owner_principal_id, environment_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, connection_profile_id,
    backend_instance_id, environment_id
  ) REFERENCES agent_connection_profiles(
    tenant_id, owner_principal_id, id, backend_instance_id,
    execution_environment_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO application_threads_v10(
  tenant_id, id, owner_principal_id, environment_id, workspace_id,
  backend_instance_id, connection_profile_id, backing_state, title,
  availability, reconciliation_at, last_activity_at, revision, created_at,
  updated_at
)
SELECT
  thread.tenant_id,
  thread.id,
  thread.owner_principal_id,
  thread.environment_id,
  thread.workspace_id,
  context.backend_instance_id,
  profile.profile_id,
  CASE
    WHEN thread.backing_state = 'draft' THEN 'unbound'
    WHEN thread.backing_state = 'materializing'
      AND thread.attempt_phase = 'submitting' THEN 'creation_unknown'
    WHEN thread.backing_state = 'materializing' THEN 'creating'
    WHEN thread.backing_state = 'native'
      AND thread.materialization_attempt_id IS NULL THEN 'bound'
    WHEN thread.backing_state = 'materialization_failed'
      AND thread.attempt_phase = 'aborted_unpersisted'
      AND thread.native_session_path IS NULL THEN 'unbound'
    ELSE 'creation_unknown'
  END,
  thread.title,
  thread.availability,
  thread.reconciliation_at,
  thread.last_activity_at,
  thread.revision,
  thread.created_at,
  thread.updated_at
FROM application_threads AS thread
JOIN temp.backend_normalization_profiles AS profile
  ON profile.tenant_id = thread.tenant_id
  AND profile.owner_principal_id = thread.owner_principal_id
  AND profile.execution_environment_id = thread.environment_id
CROSS JOIN temp.backend_normalization_context AS context;

CREATE TABLE conversation_bindings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  backend_conversation_id TEXT NOT NULL
    CHECK (length(backend_conversation_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  UNIQUE (
    tenant_id, backend_instance_id, execution_environment_id,
    backend_conversation_id
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, execution_environment_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES application_threads_v10(
    tenant_id, owner_principal_id, id, backend_instance_id,
    connection_profile_id, environment_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO conversation_bindings(
  tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
  connection_profile_id, execution_environment_id, backend_conversation_id,
  created_at
)
SELECT
  thread.tenant_id,
  thread.owner_principal_id,
  thread.id,
  context.backend_instance_id,
  profile.profile_id,
  thread.environment_id,
  thread.reserved_native_session_id,
  thread.created_at
FROM application_threads AS thread
JOIN temp.backend_normalization_profiles AS profile
  ON profile.tenant_id = thread.tenant_id
  AND profile.owner_principal_id = thread.owner_principal_id
  AND profile.execution_environment_id = thread.environment_id
CROSS JOIN temp.backend_normalization_context AS context
WHERE thread.native_session_path IS NOT NULL;

CREATE TABLE pi_binding_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL CHECK (
    length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
  ),
  native_session_path TEXT NOT NULL
    CHECK (length(native_session_path) BETWEEN 1 AND 4096),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  UNIQUE (
    tenant_id, backend_instance_id, execution_environment_id,
    native_session_path
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, execution_environment_id
  ) REFERENCES conversation_bindings(
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, execution_environment_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO pi_binding_details
SELECT
  thread.tenant_id,
  thread.owner_principal_id,
  thread.id,
  context.backend_instance_id,
  thread.environment_id,
  json_object(
    'version', 1,
    'backendConversationId', thread.reserved_native_session_id,
    'sessionFile', thread.native_session_path
  ),
  thread.native_session_path
FROM application_threads AS thread
CROSS JOIN temp.backend_normalization_context AS context
WHERE thread.native_session_path IS NOT NULL;

CREATE TABLE pi_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT CHECK (
    thinking_level IS NULL OR thinking_level IN (
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )
  ),
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('read_only', 'full')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
) STRICT;

INSERT INTO pi_thread_settings(
  tenant_id, owner_principal_id, application_thread_id, model_provider,
  model_id, thinking_level, tool_mode, revision
)
SELECT
  thread.tenant_id,
  thread.owner_principal_id,
  thread.id,
  preference.model_provider,
  preference.model_id,
  CASE
    WHEN preference.thinking_level IN (
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    ) THEN preference.thinking_level
    ELSE NULL
  END,
  thread.tool_mode,
  coalesce(preference.revision, 0)
FROM application_threads AS thread
LEFT JOIN thread_start_preferences AS preference
  ON preference.tenant_id = thread.tenant_id
  AND preference.thread_id = thread.id;

INSERT INTO migration_010_guard
SELECT abs(
  (SELECT count(*) FROM pi_thread_settings)
  - (SELECT count(*) FROM application_threads)
);

CREATE TABLE backend_checkpoints (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'conversation_leaf'),
  opaque_reference TEXT NOT NULL
    CHECK (length(opaque_reference) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, backend_instance_id)
    REFERENCES agent_backend_instances(tenant_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO backend_checkpoints(
  tenant_id, owner_principal_id, id, application_thread_id,
  backend_instance_id, kind, opaque_reference, created_at
)
SELECT
  run.tenant_id,
  run.owner_principal_id,
  run.id,
  run.anchor_thread_id,
  context.backend_instance_id,
  'conversation_leaf',
  run.source_leaf_entry_id,
  run.updated_at
FROM automation_runs AS run
CROSS JOIN temp.backend_normalization_context AS context
WHERE run.source_leaf_entry_id IS NOT NULL;

CREATE TABLE automation_definitions_v10 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  anchor_thread_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  prompt TEXT NOT NULL CHECK (length(CAST(prompt AS BLOB)) BETWEEN 1 AND 65536),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('same_thread', 'clone')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  schedule_kind TEXT NOT NULL CHECK (
    schedule_kind IN ('date_time', 'interval', 'cron')
  ),
  run_at INTEGER CHECK (run_at IS NULL OR run_at >= 0),
  interval_anchor_at INTEGER CHECK (
    interval_anchor_at IS NULL OR interval_anchor_at >= 0
  ),
  interval_seconds INTEGER CHECK (
    interval_seconds IS NULL
    OR interval_seconds BETWEEN 300 AND 31536000
  ),
  cron_expression TEXT CHECK (
    cron_expression IS NULL OR length(cron_expression) BETWEEN 1 AND 160
  ),
  time_zone TEXT CHECK (
    time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 120
  ),
  misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('coalesce', 'skip')),
  next_run_at INTEGER CHECK (next_run_at IS NULL OR next_run_at >= 0),
  last_scheduled_at INTEGER CHECK (
    last_scheduled_at IS NULL OR last_scheduled_at >= 0
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  precheck_command TEXT CHECK (
    precheck_command IS NULL
    OR length(CAST(precheck_command AS BLOB)) BETWEEN 1 AND 4096
  ),
  precheck_timeout_seconds INTEGER CHECK (
    precheck_timeout_seconds IS NULL
    OR precheck_timeout_seconds BETWEEN 1 AND 60
  ),
  precheck_include_stdout INTEGER CHECK (
    precheck_include_stdout IS NULL OR precheck_include_stdout IN (0, 1)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (precheck_command IS NULL)
      = (precheck_timeout_seconds IS NULL)
    AND (precheck_command IS NULL)
      = (precheck_include_stdout IS NULL)
  ),
  CHECK (
    (schedule_kind = 'date_time'
      AND run_at IS NOT NULL
      AND interval_anchor_at IS NULL
      AND interval_seconds IS NULL
      AND cron_expression IS NULL
      AND time_zone IS NULL)
    OR
    (schedule_kind = 'interval'
      AND run_at IS NULL
      AND interval_anchor_at IS NOT NULL
      AND interval_seconds IS NOT NULL
      AND cron_expression IS NULL
      AND time_zone IS NULL)
    OR
    (schedule_kind = 'cron'
      AND run_at IS NULL
      AND interval_anchor_at IS NULL
      AND interval_seconds IS NULL
      AND cron_expression IS NOT NULL
      AND time_zone IS NOT NULL)
  ),
  CHECK (
    deleted_at IS NULL OR (enabled = 0 AND next_run_at IS NULL)
  ),
  CHECK (
    completed_at IS NULL
    OR (schedule_kind = 'date_time' AND enabled = 0 AND next_run_at IS NULL)
  ),
  CHECK (enabled = 1 OR next_run_at IS NULL)
) STRICT;

INSERT INTO automation_definitions_v10
SELECT * FROM automation_definitions;

CREATE UNIQUE INDEX automation_definitions_v10_one_per_thread
  ON automation_definitions_v10(
    tenant_id, owner_principal_id, anchor_thread_id
  )
  WHERE deleted_at IS NULL;

CREATE TABLE automation_runs_v10 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  occurrence_kind TEXT NOT NULL CHECK (
    occurrence_kind IN ('scheduled', 'manual')
  ),
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 240),
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 0),
  coalesced_count INTEGER NOT NULL DEFAULT 0 CHECK (coalesced_count >= 0),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('same_thread', 'clone')),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'dispatching', 'queued', 'running', 'completed', 'failed',
    'skipped', 'uncertain'
  )),
  claim_token TEXT,
  lease_expires_at INTEGER,
  claim_attempt_count INTEGER NOT NULL CHECK (claim_attempt_count >= 1),
  prompt_snapshot TEXT CHECK (
    prompt_snapshot IS NULL
    OR length(CAST(prompt_snapshot AS BLOB)) BETWEEN 1 AND 65536
  ),
  dispatch_mutation_id TEXT NOT NULL
    CHECK (length(dispatch_mutation_id) BETWEEN 1 AND 128),
  anchor_thread_id TEXT NOT NULL,
  child_thread_id TEXT,
  source_checkpoint_id TEXT,
  lineage_kind TEXT CHECK (
    lineage_kind IS NULL OR lineage_kind = 'automation_clone'
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR length(error_code) BETWEEN 1 AND 120
  ),
  error_diagnostic TEXT CHECK (
    error_diagnostic IS NULL OR length(error_diagnostic) BETWEEN 1 AND 500
  ),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= claimed_at),
  accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= claimed_at),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= claimed_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  precheck_command_snapshot TEXT CHECK (
    precheck_command_snapshot IS NULL
    OR length(CAST(precheck_command_snapshot AS BLOB)) BETWEEN 1 AND 4096
  ),
  precheck_timeout_seconds INTEGER CHECK (
    precheck_timeout_seconds IS NULL
    OR precheck_timeout_seconds BETWEEN 1 AND 60
  ),
  precheck_include_stdout INTEGER CHECK (
    precheck_include_stdout IS NULL OR precheck_include_stdout IN (0, 1)
  ),
  precheck_status TEXT NOT NULL CHECK (precheck_status IN (
    'not_configured', 'pending', 'checking', 'passed', 'skipped', 'failed'
  )),
  precheck_started_at INTEGER CHECK (
    precheck_started_at IS NULL OR precheck_started_at >= claimed_at
  ),
  precheck_finished_at INTEGER CHECK (
    precheck_finished_at IS NULL
    OR (
      precheck_started_at IS NOT NULL
      AND precheck_finished_at >= precheck_started_at
    )
  ),
  precheck_exit_code INTEGER,
  precheck_duration_ms INTEGER CHECK (
    precheck_duration_ms IS NULL OR precheck_duration_ms >= 0
  ),
  precheck_stdout_bytes INTEGER CHECK (
    precheck_stdout_bytes IS NULL OR precheck_stdout_bytes >= 0
  ),
  precheck_stdout_included INTEGER CHECK (
    precheck_stdout_included IS NULL OR precheck_stdout_included IN (0, 1)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, automation_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_checkpoint_id)
    REFERENCES backend_checkpoints(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (run_mode = 'same_thread'
      AND child_thread_id IS NULL
      AND source_checkpoint_id IS NULL
      AND lineage_kind IS NULL)
    OR
    (run_mode = 'clone' AND lineage_kind = 'automation_clone')
  ),
  CHECK (
    (state IN ('claimed', 'dispatching')
      AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state NOT IN ('claimed', 'dispatching')
      AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('claimed', 'dispatching', 'uncertain')
      AND prompt_snapshot IS NOT NULL)
    OR
    (state IN ('completed', 'failed', 'skipped')
      AND prompt_snapshot IS NULL)
    OR state IN ('queued', 'running')
  ),
  CHECK (
    (state = 'claimed'
      AND started_at IS NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR
    (state = 'dispatching'
      AND started_at IS NOT NULL AND accepted_at IS NULL AND finished_at IS NULL)
    OR
    (state IN ('queued', 'running')
      AND started_at IS NOT NULL AND accepted_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (state = 'uncertain'
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR
    (state IN ('completed', 'failed', 'skipped')
      AND finished_at IS NOT NULL)
  ),
  CHECK (
    (precheck_command_snapshot IS NULL)
      = (precheck_timeout_seconds IS NULL)
    AND (precheck_command_snapshot IS NULL)
      = (precheck_include_stdout IS NULL)
    AND (
      (precheck_command_snapshot IS NULL
        AND precheck_status = 'not_configured')
      OR
      (precheck_command_snapshot IS NOT NULL
        AND precheck_status <> 'not_configured')
    )
  )
) STRICT;

INSERT INTO automation_runs_v10(
  tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
  scheduled_for, occurrence_key, definition_revision, coalesced_count,
  run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
  prompt_snapshot, dispatch_mutation_id, anchor_thread_id, child_thread_id,
  source_checkpoint_id, lineage_kind, error_code, error_diagnostic, claimed_at,
  started_at, accepted_at, finished_at, created_at, updated_at,
  precheck_command_snapshot, precheck_timeout_seconds,
  precheck_include_stdout, precheck_status, precheck_started_at,
  precheck_finished_at, precheck_exit_code, precheck_duration_ms,
  precheck_stdout_bytes, precheck_stdout_included
)
SELECT
  tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
  scheduled_for, occurrence_key, definition_revision, coalesced_count,
  run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
  prompt_snapshot, dispatch_mutation_id, anchor_thread_id, child_thread_id,
  CASE WHEN source_leaf_entry_id IS NULL THEN NULL ELSE id END,
  lineage_kind, error_code, error_diagnostic, claimed_at, started_at,
  accepted_at, finished_at, created_at, updated_at,
  precheck_command_snapshot, precheck_timeout_seconds,
  precheck_include_stdout, precheck_status, precheck_started_at,
  precheck_finished_at, precheck_exit_code, precheck_duration_ms,
  precheck_stdout_bytes, precheck_stdout_included
FROM automation_runs;

CREATE TABLE conversation_creation_attempts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (
    creation_kind IN ('first_input', 'automation_clone')
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('composer', 'automation')
  ),
  source_automation_id TEXT,
  source_automation_run_id TEXT,
  initial_input_text TEXT CHECK (
    initial_input_text IS NULL
    OR length(CAST(initial_input_text AS BLOB)) BETWEEN 1 AND 65536
  ),
  consumed_draft_revision INTEGER CHECK (
    consumed_draft_revision IS NULL OR consumed_draft_revision >= 1
  ),
  requested_backend_conversation_id TEXT NOT NULL CHECK (
    length(requested_backend_conversation_id) BETWEEN 1 AND 128
  ),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'external_call_started', 'conversation_identified',
    'first_submission_started', 'accepted_unpersisted', 'bound',
    'aborted_unpersisted', 'recovery_required'
  )),
  provisional_backend_conversation_id TEXT
    CHECK (
      provisional_backend_conversation_id IS NULL
      OR length(provisional_backend_conversation_id) BETWEEN 1 AND 128
    ),
  reconciliation_token TEXT
    CHECK (
      reconciliation_token IS NULL
      OR length(reconciliation_token) BETWEEN 1 AND 512
    ),
  retry_anchor TEXT CHECK (
    retry_anchor IS NULL
    OR length(CAST(retry_anchor AS BLOB)) BETWEEN 1 AND 4096
  ),
  retry_authorized_at INTEGER,
  retry_mutation_id TEXT
    CHECK (retry_mutation_id IS NULL OR length(retry_mutation_id) BETWEEN 1 AND 128),
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
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, attempt_id
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id, attempt_id,
    backend_instance_id, execution_environment_id
  ),
  UNIQUE (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES application_threads_v10(
    tenant_id, owner_principal_id, id, backend_instance_id,
    connection_profile_id, environment_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, source_automation_id)
    REFERENCES automation_definitions_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, source_automation_id,
    source_automation_run_id
  ) REFERENCES automation_runs_v10(
    tenant_id, owner_principal_id, automation_id, id
  ) ON DELETE RESTRICT,
  CHECK (
    (creation_kind = 'first_input' AND initial_input_text IS NOT NULL)
    OR
    (creation_kind = 'automation_clone' AND initial_input_text IS NULL)
  ),
  CHECK (
    (source_kind = 'composer'
      AND source_automation_id IS NULL AND source_automation_run_id IS NULL)
    OR
    (source_kind = 'automation'
      AND source_automation_id IS NOT NULL
      AND source_automation_run_id IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'composer'
      AND (
        consumed_draft_revision IS NOT NULL
        OR phase = 'aborted_unpersisted'
      ))
    OR
    (source_kind = 'automation' AND consumed_draft_revision IS NULL)
  ),
  CHECK (
    (retry_mutation_id IS NULL AND retry_started_at IS NULL
      AND retry_reconciliation_token IS NULL)
    OR
    (retry_mutation_id IS NOT NULL AND retry_started_at IS NOT NULL
      AND retry_reconciliation_token IS NOT NULL
      AND retry_anchor IS NOT NULL)
  ),
  CHECK (
    retry_anchor IS NULL
    OR phase IN ('first_submission_started', 'recovery_required')
  ),
  CHECK (
    phase <> 'first_submission_started' OR retry_anchor IS NOT NULL
  ),
  CHECK (retry_authorized_at IS NULL OR retry_mutation_id IS NULL),
  CHECK (
    phase NOT IN (
      'conversation_identified', 'first_submission_started',
      'accepted_unpersisted', 'bound'
    )
    OR provisional_backend_conversation_id IS NOT NULL
  ),
  CHECK (
    phase NOT IN (
      'external_call_started', 'conversation_identified',
      'first_submission_started', 'accepted_unpersisted', 'bound'
    )
    OR external_call_started_at IS NOT NULL
  ),
  CHECK (
    phase NOT IN ('accepted_unpersisted', 'bound')
    OR accepted_at IS NOT NULL
  ),
  CHECK (phase != 'bound' OR reconciled_at IS NOT NULL),
  CHECK (
    accepted_at IS NOT NULL
    OR (backend_correlation IS NULL AND completion_identity IS NULL)
  ),
  CHECK (
    (retry_authorized_at IS NULL AND retry_mutation_id IS NULL)
    OR phase = 'recovery_required'
  ),
  CHECK (
    external_call_started_at IS NULL
    OR external_call_started_at >= prepared_at
  ),
  CHECK (accepted_at IS NULL OR accepted_at >= prepared_at),
  CHECK (reconciled_at IS NULL OR reconciled_at >= prepared_at),
  CHECK (
    retry_authorized_at IS NULL OR retry_authorized_at >= prepared_at
  ),
  CHECK (retry_started_at IS NULL OR retry_started_at >= prepared_at)
) STRICT;

CREATE UNIQUE INDEX conversation_creation_attempts_one_active
  ON conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE phase NOT IN ('bound', 'aborted_unpersisted');

INSERT INTO conversation_creation_attempts(
  tenant_id, owner_principal_id, application_thread_id, attempt_id,
  mutation_id, backend_instance_id, connection_profile_id,
  execution_environment_id, creation_kind, source_kind,
  source_automation_id, source_automation_run_id, initial_input_text, phase,
  consumed_draft_revision,
  requested_backend_conversation_id, provisional_backend_conversation_id,
  reconciliation_token, retry_anchor, retry_mutation_id,
  retry_started_at, retry_reconciliation_token, diagnostic,
  prepared_at, external_call_started_at, accepted_at, reconciled_at
)
SELECT
  thread.tenant_id,
  thread.owner_principal_id,
  thread.id,
  thread.materialization_attempt_id,
  coalesce(pending.mutation_id, clone_run.dispatch_mutation_id,
    thread.materialization_attempt_id),
  context.backend_instance_id,
  profile.profile_id,
  thread.environment_id,
  CASE WHEN pending.attempt_id IS NULL THEN 'automation_clone' ELSE 'first_input' END,
  CASE
    WHEN pending.attempt_id IS NOT NULL THEN pending.source_kind
    ELSE 'automation'
  END,
  coalesce(pending.automation_id, clone_run.automation_id),
  coalesce(pending.automation_run_id, clone_run.id),
  pending.text,
  CASE
    WHEN thread.backing_state = 'native'
      AND thread.attempt_phase = 'accepted_unpersisted'
      THEN 'accepted_unpersisted'
    WHEN thread.backing_state = 'materialization_failed'
      AND thread.attempt_phase = 'aborted_unpersisted'
      AND thread.native_session_path IS NULL
      THEN 'aborted_unpersisted'
    WHEN thread.backing_state = 'materialization_failed'
      THEN 'recovery_required'
    WHEN thread.attempt_phase = 'submitting'
      THEN 'recovery_required'
    WHEN thread.attempt_phase = 'accepted_unpersisted'
      THEN 'accepted_unpersisted'
    ELSE 'prepared'
  END,
  CASE
    WHEN pending.source_kind = 'composer'
      AND NOT (
        thread.backing_state = 'materialization_failed'
        AND thread.attempt_phase = 'aborted_unpersisted'
        AND thread.native_session_path IS NULL
      )
      THEN draft.revision + 1
    ELSE NULL
  END,
  coalesce(thread.reserved_native_session_id, thread.id),
  thread.reserved_native_session_id,
  CASE
    WHEN pending.retry_mutation_id IS NOT NULL
      THEN pending.retry_mutation_id
    WHEN thread.attempt_phase = 'submitting'
      THEN pending.mutation_id
    ELSE NULL
  END,
  CASE
    WHEN pending.retry_anchor_entry_count IS NULL
      OR thread.attempt_phase = 'accepted_unpersisted'
      THEN NULL
    ELSE json_object(
      'version', 1,
      'entryId', pending.retry_anchor_entry_id,
      'entryCount', pending.retry_anchor_entry_count
    )
  END,
  CASE
    WHEN thread.attempt_phase <> 'accepted_unpersisted'
      THEN pending.retry_mutation_id
    ELSE NULL
  END,
  CASE
    WHEN thread.attempt_phase <> 'accepted_unpersisted'
      AND pending.retry_mutation_id IS NOT NULL
      THEN thread.updated_at
    ELSE NULL
  END,
  CASE
    WHEN thread.attempt_phase <> 'accepted_unpersisted'
      THEN pending.retry_mutation_id
    ELSE NULL
  END,
  thread.attempt_diagnostic_code,
  coalesce(pending.created_at, clone_run.created_at, thread.updated_at),
  CASE
    WHEN thread.attempt_phase IN ('submitting', 'accepted_unpersisted')
      OR thread.backing_state IN ('native', 'materialization_failed')
      THEN thread.updated_at
    ELSE NULL
  END,
  CASE
    WHEN thread.attempt_phase = 'accepted_unpersisted' THEN thread.updated_at
    ELSE NULL
  END,
  NULL
FROM application_threads AS thread
JOIN temp.backend_normalization_profiles AS profile
  ON profile.tenant_id = thread.tenant_id
  AND profile.owner_principal_id = thread.owner_principal_id
  AND profile.execution_environment_id = thread.environment_id
LEFT JOIN pending_first_sends AS pending
  ON pending.tenant_id = thread.tenant_id
  AND pending.principal_id = thread.owner_principal_id
  AND pending.thread_id = thread.id
LEFT JOIN thread_drafts AS draft
  ON draft.tenant_id = thread.tenant_id
  AND draft.principal_id = thread.owner_principal_id
  AND draft.thread_id = thread.id
LEFT JOIN automation_runs AS clone_run
  ON clone_run.tenant_id = thread.tenant_id
  AND clone_run.owner_principal_id = thread.owner_principal_id
  AND clone_run.child_thread_id = thread.id
  AND clone_run.id = thread.materialization_attempt_id
CROSS JOIN temp.backend_normalization_context AS context
WHERE thread.materialization_attempt_id IS NOT NULL;

CREATE TABLE pi_creation_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL CHECK (
    length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
  ),
  native_session_path TEXT NOT NULL
    CHECK (length(native_session_path) BETWEEN 1 AND 4096),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, attempt_id
  ),
  UNIQUE (
    tenant_id, backend_instance_id, execution_environment_id,
    native_session_path
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, attempt_id,
    backend_instance_id, execution_environment_id
  ) REFERENCES conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id, attempt_id,
    backend_instance_id, execution_environment_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO pi_creation_details(
  tenant_id, owner_principal_id, application_thread_id, attempt_id,
  backend_instance_id, execution_environment_id, opaque_binding_detail,
  native_session_path
)
SELECT
  attempt.tenant_id,
  attempt.owner_principal_id,
  attempt.application_thread_id,
  attempt.attempt_id,
  attempt.backend_instance_id,
  attempt.execution_environment_id,
  json_object(
    'version', 1,
    'backendConversationId', attempt.provisional_backend_conversation_id,
    'sessionFile', thread.native_session_path
  ),
  thread.native_session_path
FROM conversation_creation_attempts AS attempt
JOIN application_threads AS thread
  ON thread.tenant_id = attempt.tenant_id
  AND thread.owner_principal_id = attempt.owner_principal_id
  AND thread.id = attempt.application_thread_id
WHERE attempt.provisional_backend_conversation_id IS NOT NULL
  AND thread.native_session_path IS NOT NULL;

CREATE TRIGGER pi_binding_details_path_not_provisional_insert
BEFORE INSERT ON pi_binding_details
WHEN EXISTS (
  SELECT 1
  FROM pi_creation_details AS provisional
  WHERE provisional.tenant_id = NEW.tenant_id
    AND provisional.backend_instance_id = NEW.backend_instance_id
    AND provisional.execution_environment_id = NEW.execution_environment_id
    AND provisional.native_session_path = NEW.native_session_path
    AND provisional.application_thread_id <> NEW.application_thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Pi native session path is already provisionally owned');
END;

CREATE TRIGGER pi_creation_details_path_not_bound_insert
BEFORE INSERT ON pi_creation_details
WHEN EXISTS (
  SELECT 1
  FROM pi_binding_details AS binding
  WHERE binding.tenant_id = NEW.tenant_id
    AND binding.backend_instance_id = NEW.backend_instance_id
    AND binding.execution_environment_id = NEW.execution_environment_id
    AND binding.native_session_path = NEW.native_session_path
    AND binding.application_thread_id <> NEW.application_thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Pi native session path is already bound');
END;

CREATE TRIGGER pi_binding_details_path_not_provisional_update
BEFORE UPDATE OF
  backend_instance_id, execution_environment_id, native_session_path
ON pi_binding_details
WHEN EXISTS (
  SELECT 1
  FROM pi_creation_details AS provisional
  WHERE provisional.tenant_id = NEW.tenant_id
    AND provisional.backend_instance_id = NEW.backend_instance_id
    AND provisional.execution_environment_id = NEW.execution_environment_id
    AND provisional.native_session_path = NEW.native_session_path
    AND provisional.application_thread_id <> NEW.application_thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Pi native session path is already provisionally owned');
END;

CREATE TRIGGER pi_creation_details_path_not_bound_update
BEFORE UPDATE OF
  backend_instance_id, execution_environment_id, native_session_path
ON pi_creation_details
WHEN EXISTS (
  SELECT 1
  FROM pi_binding_details AS binding
  WHERE binding.tenant_id = NEW.tenant_id
    AND binding.backend_instance_id = NEW.backend_instance_id
    AND binding.execution_environment_id = NEW.execution_environment_id
    AND binding.native_session_path = NEW.native_session_path
    AND binding.application_thread_id <> NEW.application_thread_id
)
BEGIN
  SELECT RAISE(ABORT, 'Pi native session path is already bound');
END;

CREATE TABLE pi_submission_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  creation_attempt_id TEXT,
  accepted_user_entry_id TEXT CHECK (
    accepted_user_entry_id IS NULL
    OR length(accepted_user_entry_id) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    creation_attempt_id
  ) REFERENCES conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id, attempt_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO pi_submission_details(
  tenant_id, owner_principal_id, application_thread_id, operation_id,
  creation_attempt_id, accepted_user_entry_id
)
SELECT
  pending.tenant_id,
  pending.principal_id,
  pending.thread_id,
  pending.mutation_id,
  pending.attempt_id,
  run.pi_user_entry_id
FROM pending_first_sends AS pending
LEFT JOIN automation_runs AS run
  ON run.tenant_id = pending.tenant_id
  AND run.owner_principal_id = pending.principal_id
  AND run.id = pending.automation_run_id;

INSERT OR IGNORE INTO pi_submission_details(
  tenant_id, owner_principal_id, application_thread_id, operation_id,
  creation_attempt_id, accepted_user_entry_id
)
SELECT
  run.tenant_id,
  run.owner_principal_id,
  coalesce(run.child_thread_id, run.anchor_thread_id),
  run.dispatch_mutation_id,
  NULL,
  run.pi_user_entry_id
FROM automation_runs AS run
WHERE run.pi_user_entry_id IS NOT NULL;

UPDATE pi_submission_details
SET accepted_user_entry_id = (
  SELECT run.pi_user_entry_id
  FROM automation_runs AS run
  WHERE run.tenant_id = pi_submission_details.tenant_id
    AND run.owner_principal_id = pi_submission_details.owner_principal_id
    AND run.dispatch_mutation_id = pi_submission_details.operation_id
    AND run.pi_user_entry_id IS NOT NULL
)
WHERE EXISTS (
  SELECT 1
  FROM automation_runs AS run
  WHERE run.tenant_id = pi_submission_details.tenant_id
    AND run.owner_principal_id = pi_submission_details.owner_principal_id
    AND run.dispatch_mutation_id = pi_submission_details.operation_id
    AND run.pi_user_entry_id IS NOT NULL
);

CREATE TABLE queued_inputs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  application_thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 65536),
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
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, retry_of_id
  ) REFERENCES queued_inputs(
    tenant_id, owner_principal_id, application_thread_id, id
  )
    ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX queued_inputs_one_explicit_retry
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id, retry_of_id
  )
  WHERE retry_of_id IS NOT NULL;

CREATE TABLE submission_completion_observations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 200),
  accepted_at INTEGER NOT NULL,
  backend_correlation TEXT CHECK (
    backend_correlation IS NULL
    OR length(backend_correlation) BETWEEN 1 AND 512
  ),
  last_completion_identity TEXT CHECK (
    last_completion_identity IS NULL
    OR length(last_completion_identity) BETWEEN 1 AND 512
  ),
  completion_observed_at INTEGER,
  attention_created_at INTEGER,
  acknowledged_at INTEGER,
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (last_completion_identity IS NULL AND completion_observed_at IS NULL)
    OR
    (last_completion_identity IS NOT NULL AND completion_observed_at IS NOT NULL)
  ),
  CHECK (
    attention_created_at IS NULL OR completion_observed_at IS NOT NULL
  )
) STRICT;

INSERT INTO submission_completion_observations(
  tenant_id, owner_principal_id, application_thread_id, operation_id,
  accepted_at, backend_correlation, last_completion_identity,
  completion_observed_at, attention_created_at, acknowledged_at
)
SELECT
  receipt.tenant_id,
  receipt.principal_id,
  receipt.thread_id,
  receipt.mutation_id,
  receipt.created_at,
  run.pi_user_entry_id,
  NULL, NULL, NULL,
  context.applied_at
FROM mutation_receipts AS receipt
LEFT JOIN automation_runs AS run
  ON run.tenant_id = receipt.tenant_id
  AND run.owner_principal_id = receipt.principal_id
  AND run.dispatch_mutation_id = receipt.mutation_id
CROSS JOIN temp.backend_normalization_context AS context
WHERE receipt.mutation_kind IN (
    'first_send', 'automation_first_send', 'native_send',
    'automation_send', 'materialization_retry'
  )
  AND receipt.result_code IN ('accepted', 'accepted_unpersisted');

INSERT INTO submission_completion_observations(
  tenant_id, owner_principal_id, application_thread_id, operation_id,
  accepted_at, backend_correlation, last_completion_identity,
  completion_observed_at, attention_created_at, acknowledged_at
)
SELECT
  state.tenant_id,
  state.principal_id,
  state.thread_id,
  'migration-attention-' || state.thread_id,
  state.latest_agent_completion_at,
  state.latest_agent_completion_id,
  state.latest_agent_completion_id,
  state.latest_agent_completion_at,
  state.latest_agent_completion_at,
  CASE
    WHEN state.seen_agent_completion_id = state.latest_agent_completion_id
      THEN state.latest_agent_completion_at
    ELSE NULL
  END
FROM thread_principal_state AS state
WHERE state.latest_agent_completion_id IS NOT NULL;

CREATE TABLE thread_principal_state_v10 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  inventory_state TEXT NOT NULL CHECK (
    inventory_state IN ('active', 'snoozed', 'settled', 'archived')
  ),
  state_changed_at INTEGER NOT NULL,
  snoozed_at INTEGER,
  snoozed_until INTEGER,
  woke_at INTEGER,
  wake_reason TEXT CHECK (
    wake_reason IS NULL OR wake_reason IN (
      'manual', 'deadline', 'completion', 'failure', 'needs-input', 'activity'
    )
  ),
  wake_acknowledged_at INTEGER,
  inventory_revision INTEGER NOT NULL DEFAULT 0 CHECK (inventory_revision >= 0),
  wake_reminder_text TEXT CHECK (
    wake_reminder_text IS NULL
    OR (
      length(wake_reminder_text) BETWEEN 1 AND 1000
      AND length(CAST(wake_reminder_text AS BLOB)) <= 4096
    )
  ),
  automation_context_run_id TEXT CHECK (
    automation_context_run_id IS NULL
    OR length(automation_context_run_id) BETWEEN 1 AND 128
  ),
  automation_context_source_thread_id TEXT CHECK (
    automation_context_source_thread_id IS NULL
    OR length(automation_context_source_thread_id) BETWEEN 1 AND 128
  ),
  automation_context_at INTEGER,
  automation_context_outcome TEXT CHECK (
    automation_context_outcome IS NULL
    OR automation_context_outcome IN ('triggered', 'failed')
  ),
  automation_context_diagnostic TEXT CHECK (
    automation_context_diagnostic IS NULL
    OR length(automation_context_diagnostic) BETWEEN 1 AND 500
  ),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES application_threads_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, principal_id, automation_context_source_thread_id
  ) REFERENCES application_threads_v10(
    tenant_id, owner_principal_id, id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, principal_id, automation_context_run_id
  ) REFERENCES automation_runs_v10(
    tenant_id, owner_principal_id, id
  ) ON DELETE RESTRICT,
  CHECK (
    (inventory_state = 'snoozed'
      AND snoozed_at IS NOT NULL AND snoozed_until IS NOT NULL)
    OR
    (inventory_state <> 'snoozed'
      AND snoozed_at IS NULL AND snoozed_until IS NULL)
  ),
  CHECK (
    inventory_state = 'active'
    OR (woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL)
  ),
  CHECK (
    (woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL)
    OR (woke_at IS NOT NULL AND wake_reason IS NOT NULL)
  ),
  CHECK (
    (automation_context_run_id IS NULL
      AND automation_context_source_thread_id IS NULL
      AND automation_context_at IS NULL
      AND automation_context_outcome IS NULL
      AND automation_context_diagnostic IS NULL)
    OR
    (automation_context_run_id IS NOT NULL
      AND automation_context_source_thread_id IS NOT NULL
      AND automation_context_at IS NOT NULL
      AND automation_context_outcome IS NOT NULL)
  )
) STRICT;

INSERT INTO thread_principal_state_v10(
  tenant_id, principal_id, thread_id, inventory_state, state_changed_at,
  snoozed_at, snoozed_until, woke_at, wake_reason, wake_acknowledged_at,
  inventory_revision, wake_reminder_text, automation_context_run_id,
  automation_context_source_thread_id, automation_context_at,
  automation_context_outcome, automation_context_diagnostic
)
SELECT
  tenant_id, principal_id, thread_id, inventory_state, state_changed_at,
  snoozed_at, snoozed_until, woke_at,
  wake_reason,
  wake_acknowledged_at, inventory_revision, wake_reminder_text,
  automation_context_run_id, automation_context_source_thread_id,
  automation_context_at, automation_context_outcome,
  automation_context_diagnostic
FROM thread_principal_state;

CREATE TABLE thread_drafts_v10 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state_v10(
      tenant_id, principal_id, thread_id
    ) ON DELETE RESTRICT
) STRICT;
INSERT INTO thread_drafts_v10 SELECT * FROM thread_drafts;
UPDATE thread_drafts_v10
SET text = '', revision = revision + 1
WHERE EXISTS (
  SELECT 1
  FROM conversation_creation_attempts AS attempt
  WHERE attempt.tenant_id = thread_drafts_v10.tenant_id
    AND attempt.owner_principal_id = thread_drafts_v10.principal_id
    AND attempt.application_thread_id = thread_drafts_v10.thread_id
    AND attempt.source_kind = 'composer'
    AND attempt.consumed_draft_revision = thread_drafts_v10.revision + 1
);

CREATE TABLE prompt_stashes_v10 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, thread_id, id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state_v10(
      tenant_id, principal_id, thread_id
    ) ON DELETE RESTRICT
) STRICT;
INSERT INTO prompt_stashes_v10 SELECT * FROM prompt_stashes;

CREATE TABLE mutation_receipts_v10 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 1 AND 80),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(result_json) <= 4096
  ),
  replayable INTEGER NOT NULL CHECK (replayable IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state_v10(
      tenant_id, principal_id, thread_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO mutation_receipts_v10(
  tenant_id, principal_id, thread_id, mutation_id, operation_kind,
  request_fingerprint, result_code, result_json, replayable, created_at
)
SELECT
  tenant_id,
  principal_id,
  thread_id,
  mutation_id,
  CASE mutation_kind
    WHEN 'first_send' THEN 'conversation_create_submit'
    WHEN 'automation_first_send' THEN 'automation_create_submit'
    WHEN 'native_send' THEN 'conversation_input'
    WHEN 'automation_send' THEN 'automation_input'
    WHEN 'native_abort' THEN 'conversation_interrupt'
    WHEN 'native_compact' THEN 'conversation_compact'
    WHEN 'native_rename' THEN 'conversation_rename'
    WHEN 'config' THEN 'conversation_settings'
    WHEN 'materialization_retry' THEN 'creation_retry'
    ELSE mutation_kind
  END,
  request_fingerprint,
  CASE
    WHEN result_code = 'submitting'
      AND mutation_kind IN (
        'native_send', 'automation_send', 'native_abort', 'native_compact',
        'native_rename', 'config', 'materialization_retry'
      )
      THEN 'uncertain'
    ELSE result_code
  END,
  CASE
    WHEN mutation_kind IN ('first_send', 'automation_first_send')
      THEN json_object(
        'creationAttemptId',
        json_extract(result_json, '$.attemptId')
      )
    WHEN mutation_kind = 'inventory'
      THEN json_object(
        'tenantId', json_extract(result_json, '$.tenantId'),
        'principalId', json_extract(result_json, '$.principalId'),
        'threadId', json_extract(result_json, '$.threadId'),
        'inventoryState', json_extract(result_json, '$.inventoryState'),
        'stateChangedAt', json_extract(result_json, '$.stateChangedAt'),
        'snoozedAt', json_extract(result_json, '$.snoozedAt'),
        'snoozedUntil', json_extract(result_json, '$.snoozedUntil'),
        'wokeAt', json_extract(result_json, '$.wokeAt'),
        'wakeReason', json_extract(result_json, '$.wakeReason'),
        'wakeAcknowledgedAt',
          json_extract(result_json, '$.wakeAcknowledgedAt'),
        'wakeReminderText', json_extract(result_json, '$.wakeReminderText'),
        'automationContextRunId',
          json_extract(result_json, '$.automationContextRunId'),
        'automationContextSourceThreadId',
          json_extract(result_json, '$.automationContextSourceThreadId'),
        'automationContextAt',
          json_extract(result_json, '$.automationContextAt'),
        'automationContextOutcome',
          json_extract(result_json, '$.automationContextOutcome'),
        'automationContextDiagnostic',
          json_extract(result_json, '$.automationContextDiagnostic'),
        'inventoryRevision',
          json_extract(result_json, '$.inventoryRevision')
      )
    WHEN result_code = 'submitting'
      THEN json_object(
        'diagnostic', 'The pre-cutover operation outcome is uncertain.'
      )
    ELSE result_json
  END,
  CASE
    WHEN mutation_kind IN (
      'first_send', 'automation_first_send', 'native_send',
      'automation_send', 'native_abort', 'native_compact',
      'native_rename', 'config', 'materialization_retry'
    ) THEN 0
    ELSE 1
  END,
  created_at
FROM mutation_receipts;

CREATE TABLE automation_mutation_receipts_v10 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  automation_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (
    mutation_kind IN ('create', 'update', 'state', 'delete')
  ),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions_v10(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT
) STRICT;
INSERT INTO automation_mutation_receipts_v10
SELECT * FROM automation_mutation_receipts;

INSERT INTO migration_010_guard
SELECT abs(
  (SELECT count(*) FROM application_threads)
  - (SELECT count(*) FROM application_threads_v10)
);
INSERT INTO migration_010_guard
SELECT abs(
  (SELECT count(*) FROM automation_definitions)
  - (SELECT count(*) FROM automation_definitions_v10)
);
INSERT INTO migration_010_guard
SELECT abs(
  (SELECT count(*) FROM automation_runs)
  - (SELECT count(*) FROM automation_runs_v10)
);
INSERT INTO migration_010_guard
SELECT abs(
  (SELECT count(*) FROM thread_principal_state)
  - (SELECT count(*) FROM thread_principal_state_v10)
);
INSERT INTO migration_010_guard
SELECT count(*)
FROM application_threads_v10 AS thread
LEFT JOIN conversation_bindings AS binding
  ON binding.tenant_id = thread.tenant_id
  AND binding.owner_principal_id = thread.owner_principal_id
  AND binding.application_thread_id = thread.id
WHERE
  (thread.backing_state = 'bound' AND binding.application_thread_id IS NULL)
  OR
  (thread.backing_state IN ('unbound', 'creating')
    AND binding.application_thread_id IS NOT NULL);

DROP TABLE automation_mutation_receipts;
DROP TABLE pending_first_sends;
DROP TABLE mutation_receipts;
DROP TABLE thread_drafts;
DROP TABLE prompt_stashes;
DROP TABLE thread_principal_state;
DROP TABLE thread_start_preferences;
DROP TABLE automation_runs;
DROP TABLE automation_definitions;
DROP TABLE application_threads;

ALTER TABLE application_threads_v10 RENAME TO application_threads;
ALTER TABLE automation_definitions_v10 RENAME TO automation_definitions;
ALTER TABLE automation_runs_v10 RENAME TO automation_runs;
ALTER TABLE thread_principal_state_v10 RENAME TO thread_principal_state;
ALTER TABLE thread_drafts_v10 RENAME TO thread_drafts;
ALTER TABLE prompt_stashes_v10 RENAME TO prompt_stashes;
ALTER TABLE mutation_receipts_v10 RENAME TO mutation_receipts;
ALTER TABLE automation_mutation_receipts_v10
  RENAME TO automation_mutation_receipts;

CREATE INDEX application_threads_workspace_activity
  ON application_threads(
    tenant_id, workspace_id, last_activity_at DESC, id
  );
CREATE INDEX thread_principal_state_active
  ON thread_principal_state(
    tenant_id, principal_id, inventory_state, thread_id
  );
CREATE INDEX thread_principal_state_snooze_deadline
  ON thread_principal_state(
    snoozed_until, tenant_id, principal_id, thread_id
  )
  WHERE inventory_state = 'snoozed';
CREATE INDEX thread_principal_state_changed
  ON thread_principal_state(
    tenant_id, principal_id, inventory_state, state_changed_at DESC, thread_id
  );
CREATE INDEX prompt_stashes_newest
  ON prompt_stashes(
    tenant_id, principal_id, thread_id, created_at DESC, id
  );
CREATE INDEX mutation_receipts_created
  ON mutation_receipts(tenant_id, principal_id, created_at);
CREATE INDEX automation_definitions_due
  ON automation_definitions(
    next_run_at, tenant_id, owner_principal_id, id
  )
  WHERE enabled = 1 AND completed_at IS NULL AND deleted_at IS NULL
    AND next_run_at IS NOT NULL;
CREATE INDEX automation_definitions_anchor
  ON automation_definitions(
    tenant_id, owner_principal_id, anchor_thread_id, updated_at DESC, id
  )
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX automation_definitions_one_per_thread
  ON automation_definitions(
    tenant_id, owner_principal_id, anchor_thread_id
  )
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX automation_runs_one_nonterminal
  ON automation_runs(tenant_id, owner_principal_id, automation_id)
  WHERE state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain');
CREATE INDEX automation_runs_expired_claims
  ON automation_runs(
    lease_expires_at, tenant_id, owner_principal_id, automation_id, id
  )
  WHERE state IN ('claimed', 'dispatching');
CREATE INDEX automation_runs_history
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id, created_at DESC, id DESC
  );
CREATE UNIQUE INDEX automation_runs_child_lineage
  ON automation_runs(tenant_id, owner_principal_id, child_thread_id)
  WHERE child_thread_id IS NOT NULL;
CREATE INDEX automation_mutation_receipts_created
  ON automation_mutation_receipts(
    tenant_id, owner_principal_id, created_at
  );
CREATE INDEX queued_inputs_dispatch
  ON queued_inputs(
    state, next_attempt_at, tenant_id, owner_principal_id,
    application_thread_id, sequence
  )
  WHERE state IN ('pending', 'retry_wait');
CREATE INDEX submission_completion_attention
  ON submission_completion_observations(
    tenant_id, owner_principal_id, attention_created_at
  )
  WHERE attention_created_at IS NOT NULL AND acknowledged_at IS NULL;

CREATE UNIQUE INDEX submission_completion_backend_correlation
  ON submission_completion_observations(
    tenant_id, owner_principal_id, application_thread_id,
    backend_correlation
  )
  WHERE backend_correlation IS NOT NULL;

DROP TABLE migration_010_guard;
`,
} as const;
