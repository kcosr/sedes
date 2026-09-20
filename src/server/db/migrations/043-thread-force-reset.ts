import type { DatabaseMigration } from "../migrate.js";

/**
 * Adds durable, user-authoritative abandonment markers. These markers are
 * deliberately separate from provider reconciliation: once written, startup
 * recovery and late provider callbacks cannot make abandoned work live again.
 */
export const threadForceResetMigration: DatabaseMigration = {
  version: 43,
  name: "thread-force-reset",
  sql: `
ALTER TABLE conversation_creation_attempts
  ADD COLUMN force_reset_at INTEGER
    CHECK (force_reset_at IS NULL OR force_reset_at >= prepared_at);
ALTER TABLE conversation_creation_attempts
  ADD COLUMN force_reset_mutation_id TEXT
    CHECK (
      (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
      OR (
        force_reset_at IS NOT NULL
        AND length(force_reset_mutation_id) BETWEEN 1 AND 128
      )
    );

CREATE TRIGGER conversation_creation_attempts_force_reset_immutable_update
BEFORE UPDATE ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset creation attempt is immutable');
END;

ALTER TABLE application_threads
  ADD COLUMN force_reset_at INTEGER
    CHECK (force_reset_at IS NULL OR force_reset_at >= created_at);
ALTER TABLE application_threads
  ADD COLUMN force_reset_mutation_id TEXT
    CHECK (
      (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
      OR (
        force_reset_at IS NOT NULL
        AND length(force_reset_mutation_id) BETWEEN 1 AND 128
      )
    );

CREATE TRIGGER application_threads_force_reset_backing_immutable
BEFORE UPDATE OF backing_state, force_reset_at, force_reset_mutation_id
ON application_threads
WHEN OLD.force_reset_at IS NOT NULL
  AND (
    NEW.backing_state <> OLD.backing_state
    OR NEW.force_reset_at IS NOT OLD.force_reset_at
    OR NEW.force_reset_mutation_id IS NOT OLD.force_reset_mutation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset creation state is immutable');
END;

CREATE TRIGGER conversation_creation_attempts_force_reset_immutable_delete
BEFORE DELETE ON conversation_creation_attempts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset creation attempt is immutable');
END;

DROP INDEX conversation_creation_attempts_one_active;
CREATE UNIQUE INDEX conversation_creation_attempts_one_active
  ON conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id
  )
  WHERE force_reset_at IS NULL
    AND phase NOT IN ('bound', 'aborted_unpersisted');

ALTER TABLE provider_feature_mutation_receipts
  ADD COLUMN force_reset_at INTEGER
    CHECK (force_reset_at IS NULL OR force_reset_at >= created_at);
ALTER TABLE provider_feature_mutation_receipts
  ADD COLUMN force_reset_mutation_id TEXT
    CHECK (
      (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
      OR (
        force_reset_at IS NOT NULL
        AND length(force_reset_mutation_id) BETWEEN 1 AND 128
      )
    );

CREATE TRIGGER provider_feature_receipts_force_reset_immutable_update
BEFORE UPDATE ON provider_feature_mutation_receipts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset provider feature receipt is immutable');
END;

CREATE TRIGGER provider_feature_receipts_force_reset_immutable_delete
BEFORE DELETE ON provider_feature_mutation_receipts
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset provider feature receipt is immutable');
END;

ALTER TABLE automation_runs
  ADD COLUMN force_reset_at INTEGER
    CHECK (force_reset_at IS NULL OR force_reset_at >= created_at);
ALTER TABLE automation_runs
  ADD COLUMN force_reset_mutation_id TEXT
    CHECK (
      (force_reset_at IS NULL AND force_reset_mutation_id IS NULL)
      OR (
        force_reset_at IS NOT NULL
        AND length(force_reset_mutation_id) BETWEEN 1 AND 128
      )
    );

CREATE TRIGGER automation_runs_force_reset_immutable_update
BEFORE UPDATE ON automation_runs
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation run is immutable');
END;

CREATE TRIGGER automation_runs_force_reset_immutable_delete
BEFORE DELETE ON automation_runs
WHEN OLD.force_reset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Force-reset automation run is immutable');
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

CREATE TABLE thread_force_reset_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  blocker_fingerprint TEXT NOT NULL CHECK (
    length(blocker_fingerprint) = 64
    AND blocker_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  blocker_summary_json TEXT NOT NULL CHECK (
    json_valid(blocker_summary_json)
    AND json_type(blocker_summary_json) = 'array'
    AND length(CAST(blocker_summary_json AS BLOB)) <= 4096
  ),
  reset_at INTEGER NOT NULL CHECK (reset_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX thread_force_reset_receipts_by_thread
  ON thread_force_reset_receipts(
    tenant_id, principal_id, thread_id, reset_at DESC, mutation_id DESC
  );

CREATE TABLE thread_force_reset_affected_threads (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  reset_mutation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, reset_mutation_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, reset_mutation_id)
    REFERENCES thread_force_reset_receipts(
      tenant_id, principal_id, mutation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE thread_force_reset_promoted_tasks (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  reset_mutation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, reset_mutation_id, task_id),
  FOREIGN KEY (tenant_id, principal_id, reset_mutation_id)
    REFERENCES thread_force_reset_receipts(
      tenant_id, principal_id, mutation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id, task_id)
    REFERENCES tasks(tenant_id, owner_principal_id, id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE thread_force_reset_abandoned_forks (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  reset_mutation_id TEXT NOT NULL,
  abandoned_at INTEGER NOT NULL CHECK (abandoned_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, child_thread_id),
  FOREIGN KEY (tenant_id, principal_id, child_thread_id)
    REFERENCES thread_fork_origins(
      tenant_id, owner_principal_id, child_thread_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id, reset_mutation_id)
    REFERENCES thread_force_reset_receipts(
      tenant_id, principal_id, mutation_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER thread_force_reset_abandoned_fork_commit
BEFORE UPDATE OF origin_state ON thread_fork_origins
WHEN OLD.origin_state = 'prepared' AND NEW.origin_state = 'committed'
  AND EXISTS (
    SELECT 1
    FROM thread_force_reset_abandoned_forks AS abandoned
    WHERE abandoned.tenant_id = OLD.tenant_id
      AND abandoned.principal_id = OLD.owner_principal_id
      AND abandoned.child_thread_id = OLD.child_thread_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Force-reset fork origin cannot be committed');
END;
`,
} as const;
