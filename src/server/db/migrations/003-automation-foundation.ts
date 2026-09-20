export const automationFoundationMigration = {
  version: 3,
  name: "automation_foundation",
  sql: `
PRAGMA defer_foreign_keys = ON;

ALTER TABLE thread_drafts RENAME TO thread_drafts_before_automation;
ALTER TABLE prompt_stashes RENAME TO prompt_stashes_before_automation;
ALTER TABLE pending_first_sends RENAME TO pending_first_sends_before_automation;
ALTER TABLE mutation_receipts RENAME TO mutation_receipts_before_automation;
ALTER TABLE thread_principal_state RENAME TO thread_principal_state_before_automation;

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
      'manual', 'deadline', 'completion', 'failure', 'needs-input', 'activity',
      'automation'
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

INSERT INTO thread_principal_state
SELECT * FROM thread_principal_state_before_automation;

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

INSERT INTO thread_drafts
SELECT * FROM thread_drafts_before_automation;

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

INSERT INTO prompt_stashes
SELECT * FROM prompt_stashes_before_automation;

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

INSERT INTO pending_first_sends
SELECT * FROM pending_first_sends_before_automation;

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

INSERT INTO mutation_receipts
SELECT * FROM mutation_receipts_before_automation;

DROP TABLE thread_drafts_before_automation;
DROP TABLE prompt_stashes_before_automation;
DROP TABLE pending_first_sends_before_automation;
DROP TABLE mutation_receipts_before_automation;
DROP TABLE thread_principal_state_before_automation;

CREATE INDEX thread_principal_state_active
  ON thread_principal_state(tenant_id, principal_id, inventory_state, thread_id);
CREATE INDEX thread_principal_state_snooze_deadline
  ON thread_principal_state(snoozed_until, tenant_id, principal_id, thread_id)
  WHERE inventory_state = 'snoozed';
CREATE INDEX thread_principal_state_changed
  ON thread_principal_state(tenant_id, principal_id, inventory_state, state_changed_at DESC, thread_id);
CREATE INDEX prompt_stashes_newest
  ON prompt_stashes(tenant_id, principal_id, thread_id, created_at DESC, id);
CREATE INDEX mutation_receipts_created
  ON mutation_receipts(tenant_id, principal_id, created_at);

CREATE TABLE automation_definitions (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  anchor_thread_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  prompt TEXT NOT NULL
    CHECK (length(CAST(prompt AS BLOB)) BETWEEN 1 AND 65536),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('same_thread', 'clone')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  schedule_kind TEXT NOT NULL
    CHECK (schedule_kind IN ('date_time', 'interval', 'cron')),
  run_at INTEGER CHECK (run_at IS NULL OR run_at >= 0),
  interval_anchor_at INTEGER
    CHECK (interval_anchor_at IS NULL OR interval_anchor_at >= 0),
  interval_seconds INTEGER
    CHECK (
      interval_seconds IS NULL
      OR interval_seconds BETWEEN 300 AND 31536000
    ),
  cron_expression TEXT
    CHECK (
      cron_expression IS NULL
      OR length(cron_expression) BETWEEN 1 AND 160
    ),
  time_zone TEXT
    CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 120),
  misfire_policy TEXT NOT NULL
    CHECK (misfire_policy IN ('coalesce', 'skip')),
  next_run_at INTEGER CHECK (next_run_at IS NULL OR next_run_at >= 0),
  last_scheduled_at INTEGER
    CHECK (last_scheduled_at IS NULL OR last_scheduled_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      schedule_kind = 'date_time'
      AND run_at IS NOT NULL
      AND interval_anchor_at IS NULL
      AND interval_seconds IS NULL
      AND cron_expression IS NULL
      AND time_zone IS NULL
    )
    OR
    (
      schedule_kind = 'interval'
      AND run_at IS NULL
      AND interval_anchor_at IS NOT NULL
      AND interval_seconds IS NOT NULL
      AND cron_expression IS NULL
      AND time_zone IS NULL
    )
    OR
    (
      schedule_kind = 'cron'
      AND run_at IS NULL
      AND interval_anchor_at IS NULL
      AND interval_seconds IS NULL
      AND cron_expression IS NOT NULL
      AND time_zone IS NOT NULL
    )
  ),
  CHECK (
    deleted_at IS NULL
    OR (enabled = 0 AND next_run_at IS NULL)
  ),
  CHECK (
    completed_at IS NULL
    OR (
      schedule_kind = 'date_time'
      AND enabled = 0
      AND next_run_at IS NULL
    )
  ),
  CHECK (enabled = 1 OR next_run_at IS NULL)
) STRICT;

CREATE INDEX automation_definitions_due
  ON automation_definitions(next_run_at, tenant_id, owner_principal_id, id)
  WHERE enabled = 1 AND completed_at IS NULL AND deleted_at IS NULL
    AND next_run_at IS NOT NULL;
CREATE INDEX automation_definitions_anchor
  ON automation_definitions(
    tenant_id, owner_principal_id, anchor_thread_id, updated_at DESC, id
  )
  WHERE deleted_at IS NULL;

CREATE TABLE automation_runs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  occurrence_kind TEXT NOT NULL
    CHECK (occurrence_kind IN ('scheduled', 'manual')),
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 240),
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 0),
  coalesced_count INTEGER NOT NULL DEFAULT 0
    CHECK (coalesced_count BETWEEN 0 AND 1000000),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('same_thread', 'clone')),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'dispatching', 'queued', 'running', 'completed', 'failed',
    'skipped', 'uncertain'
  )),
  claim_token TEXT CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 1 AND 128
  ),
  lease_expires_at INTEGER
    CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  claim_attempt_count INTEGER NOT NULL
    CHECK (claim_attempt_count BETWEEN 1 AND 1000000),
  prompt_snapshot TEXT CHECK (
    prompt_snapshot IS NULL
    OR length(CAST(prompt_snapshot AS BLOB)) BETWEEN 1 AND 65536
  ),
  dispatch_mutation_id TEXT NOT NULL
    CHECK (length(dispatch_mutation_id) BETWEEN 1 AND 128),
  anchor_thread_id TEXT NOT NULL,
  child_thread_id TEXT,
  source_leaf_entry_id TEXT CHECK (
    source_leaf_entry_id IS NULL
    OR length(source_leaf_entry_id) BETWEEN 1 AND 128
  ),
  lineage_kind TEXT CHECK (
    lineage_kind IS NULL OR lineage_kind = 'automation_clone'
  ),
  lineage_metadata TEXT CHECK (
    lineage_metadata IS NULL OR length(lineage_metadata) BETWEEN 1 AND 500
  ),
  pi_user_entry_id TEXT CHECK (
    pi_user_entry_id IS NULL OR length(pi_user_entry_id) BETWEEN 1 AND 128
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
  PRIMARY KEY (tenant_id, owner_principal_id, automation_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, automation_id, occurrence_key
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, anchor_thread_id)
    REFERENCES application_threads(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, child_thread_id)
    REFERENCES application_threads(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (
      run_mode = 'same_thread'
      AND child_thread_id IS NULL
      AND source_leaf_entry_id IS NULL
      AND lineage_kind IS NULL
      AND lineage_metadata IS NULL
    )
    OR
    (
      run_mode = 'clone'
      AND lineage_kind = 'automation_clone'
    )
  ),
  CHECK (
    (
      state IN ('claimed', 'dispatching')
      AND claim_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      state NOT IN ('claimed', 'dispatching')
      AND claim_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (
    (
      state IN ('claimed', 'dispatching', 'uncertain')
      AND prompt_snapshot IS NOT NULL
    )
    OR
    (
      state IN ('completed', 'failed', 'skipped')
      AND prompt_snapshot IS NULL
    )
    OR state IN ('queued', 'running')
  ),
  CHECK (
    (state = 'claimed'
      AND started_at IS NULL
      AND accepted_at IS NULL
      AND finished_at IS NULL)
    OR
    (state = 'dispatching'
      AND started_at IS NOT NULL
      AND accepted_at IS NULL
      AND finished_at IS NULL)
    OR
    (state IN ('queued', 'running')
      AND started_at IS NOT NULL
      AND accepted_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (state = 'uncertain'
      AND started_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (state IN ('completed', 'failed', 'skipped')
      AND finished_at IS NOT NULL)
  ),
  CHECK (
    (state = 'completed' AND error_code IS NULL AND error_diagnostic IS NULL)
    OR state <> 'completed'
  )
) STRICT;

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
`,
} as const;
