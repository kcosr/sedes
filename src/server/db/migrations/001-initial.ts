export const initialMigration = {
  version: 1,
  name: "initial_scoped_overlay",
  sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE principals (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'local_human'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_environments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'local'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  diagnostic_code TEXT CHECK (diagnostic_code IS NULL OR length(diagnostic_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, kind),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE workspaces (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  id TEXT NOT NULL,
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 4096),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  trust_state TEXT NOT NULL CHECK (trust_state IN ('trusted', 'untrusted')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_opened_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, environment_id, id),
  UNIQUE (tenant_id, environment_id, canonical_path),
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id)
    REFERENCES execution_environments(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE application_threads (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  backing_state TEXT NOT NULL
    CHECK (backing_state IN ('draft', 'materializing', 'native', 'materialization_failed')),
  reserved_native_session_id TEXT,
  native_session_path TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('read_only', 'full')),
  availability TEXT NOT NULL
    CHECK (availability IN ('available', 'missing', 'quarantined', 'environment_unavailable')),
  reconciliation_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  materialization_attempt_id TEXT,
  attempt_phase TEXT
    CHECK (attempt_phase IS NULL OR attempt_phase IN (
      'prepared', 'submitting', 'accepted_unpersisted', 'aborted_unpersisted'
    )),
  attempt_diagnostic_code TEXT
    CHECK (attempt_diagnostic_code IS NULL OR length(attempt_diagnostic_code) <= 120),
  uncertain_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, environment_id, workspace_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, environment_id, id) ON DELETE RESTRICT,
  CHECK (
    (backing_state = 'draft'
      AND reserved_native_session_id IS NULL
      AND native_session_path IS NULL
      AND materialization_attempt_id IS NULL
      AND attempt_phase IS NULL
      AND attempt_diagnostic_code IS NULL
      AND uncertain_at IS NULL)
    OR
    (backing_state = 'materializing'
      AND reserved_native_session_id IS NOT NULL
      AND native_session_path IS NULL
      AND materialization_attempt_id IS NOT NULL
      AND attempt_phase IS NOT NULL)
    OR
    (backing_state = 'materialization_failed'
      AND reserved_native_session_id IS NOT NULL
      AND native_session_path IS NULL
      AND materialization_attempt_id IS NOT NULL
      AND attempt_phase IS NOT NULL)
    OR
    (backing_state = 'native'
      AND reserved_native_session_id IS NOT NULL
      AND native_session_path IS NOT NULL
      AND (
        (materialization_attempt_id IS NULL
          AND attempt_phase IS NULL
          AND attempt_diagnostic_code IS NULL
          AND uncertain_at IS NULL)
        OR
        (materialization_attempt_id IS NOT NULL AND attempt_phase IS NOT NULL)
      ))
  )
) STRICT;

CREATE UNIQUE INDEX application_threads_native_id_unique
  ON application_threads(tenant_id, environment_id, reserved_native_session_id)
  WHERE reserved_native_session_id IS NOT NULL;

CREATE UNIQUE INDEX application_threads_native_path_unique
  ON application_threads(tenant_id, environment_id, native_session_path)
  WHERE native_session_path IS NOT NULL;

CREATE INDEX application_threads_workspace_activity
  ON application_threads(tenant_id, workspace_id, last_activity_at DESC, id);

CREATE TABLE thread_principal_state (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  inventory_state TEXT NOT NULL
    CHECK (inventory_state IN ('active', 'snoozed', 'settled', 'archived')),
  state_changed_at INTEGER NOT NULL,
  snoozed_at INTEGER,
  snoozed_until INTEGER,
  woke_at INTEGER,
  wake_reason TEXT
    CHECK (wake_reason IS NULL OR wake_reason IN (
      'manual', 'deadline', 'completion', 'failure', 'needs-input', 'activity'
    )),
  wake_acknowledged_at INTEGER,
  inventory_revision INTEGER NOT NULL DEFAULT 0 CHECK (inventory_revision >= 0),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  CHECK (
    (inventory_state = 'snoozed' AND snoozed_at IS NOT NULL AND snoozed_until IS NOT NULL)
    OR
    (inventory_state <> 'snoozed' AND snoozed_at IS NULL AND snoozed_until IS NULL)
  ),
  CHECK (
    (inventory_state = 'active')
    OR
    (woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL)
  ),
  CHECK (
    (woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL)
    OR
    (woke_at IS NOT NULL AND wake_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX thread_principal_state_active
  ON thread_principal_state(tenant_id, principal_id, inventory_state, thread_id);
CREATE INDEX thread_principal_state_snooze_deadline
  ON thread_principal_state(snoozed_until, tenant_id, principal_id, thread_id)
  WHERE inventory_state = 'snoozed';
CREATE INDEX thread_principal_state_changed
  ON thread_principal_state(tenant_id, principal_id, inventory_state, state_changed_at DESC, thread_id);

CREATE TABLE thread_drafts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE thread_start_preferences (
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id)
    REFERENCES application_threads(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
) STRICT;

CREATE TABLE prompt_stashes (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, thread_id, id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX prompt_stashes_newest
  ON prompt_stashes(tenant_id, principal_id, thread_id, created_at DESC, id);

CREATE TABLE pending_first_sends (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at INTEGER NOT NULL,
  retry_mutation_id TEXT,
  retry_anchor_entry_id TEXT,
  retry_anchor_entry_count INTEGER
    CHECK (retry_anchor_entry_count IS NULL OR retry_anchor_entry_count >= 0),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  UNIQUE (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT,
  CHECK (
    (
      retry_mutation_id IS NULL
      AND retry_anchor_entry_id IS NULL
      AND retry_anchor_entry_count IS NULL
    )
    OR
    (
      retry_mutation_id IS NOT NULL
      AND retry_anchor_entry_count IS NOT NULL
      AND (
        (retry_anchor_entry_count = 0 AND retry_anchor_entry_id IS NULL)
        OR
        (retry_anchor_entry_count > 0 AND retry_anchor_entry_id IS NOT NULL)
      )
    )
  )
) STRICT;

CREATE TABLE mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (length(mutation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 1 AND 80),
  result_json TEXT NOT NULL CHECK (length(result_json) <= 4096),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX mutation_receipts_created
  ON mutation_receipts(tenant_id, principal_id, created_at);

CREATE TABLE principal_generations (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  inventory_generation INTEGER NOT NULL DEFAULT 0 CHECK (inventory_generation >= 0),
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;
`,
} as const;
