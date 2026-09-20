export const automationDispatchMigration = {
  version: 4,
  name: "automation_dispatch",
  sql: `
ALTER TABLE pending_first_sends
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'composer'
  CHECK (source_kind IN ('composer', 'automation'));

ALTER TABLE pending_first_sends
  ADD COLUMN automation_id TEXT
  CHECK (automation_id IS NULL OR length(automation_id) BETWEEN 1 AND 128);

ALTER TABLE pending_first_sends
  ADD COLUMN automation_run_id TEXT
  CHECK (automation_run_id IS NULL OR length(automation_run_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX pending_first_sends_automation_run
  ON pending_first_sends(
    tenant_id, principal_id, automation_id, automation_run_id
  )
  WHERE source_kind = 'automation';

CREATE TRIGGER pending_first_sends_source_insert
BEFORE INSERT ON pending_first_sends
BEGIN
  SELECT CASE
    WHEN NEW.source_kind = 'composer'
      AND (NEW.automation_id IS NOT NULL OR NEW.automation_run_id IS NOT NULL)
    THEN RAISE(ABORT, 'composer_first_send_has_automation_identity')
    WHEN NEW.source_kind = 'automation'
      AND (NEW.automation_id IS NULL OR NEW.automation_run_id IS NULL)
    THEN RAISE(ABORT, 'automation_first_send_missing_identity')
    WHEN NEW.source_kind = 'automation'
      AND NOT EXISTS (
        SELECT 1
        FROM automation_runs AS run
        WHERE run.tenant_id = NEW.tenant_id
          AND run.owner_principal_id = NEW.principal_id
          AND run.automation_id = NEW.automation_id
          AND run.id = NEW.automation_run_id
          AND (
            run.anchor_thread_id = NEW.thread_id
            OR run.child_thread_id = NEW.thread_id
          )
      )
    THEN RAISE(ABORT, 'automation_first_send_identity_mismatch')
  END;
END;

CREATE TRIGGER pending_first_sends_source_update
BEFORE UPDATE OF source_kind, automation_id, automation_run_id, thread_id
ON pending_first_sends
BEGIN
  SELECT CASE
    WHEN NEW.source_kind = 'composer'
      AND (NEW.automation_id IS NOT NULL OR NEW.automation_run_id IS NOT NULL)
    THEN RAISE(ABORT, 'composer_first_send_has_automation_identity')
    WHEN NEW.source_kind = 'automation'
      AND (NEW.automation_id IS NULL OR NEW.automation_run_id IS NULL)
    THEN RAISE(ABORT, 'automation_first_send_missing_identity')
    WHEN NEW.source_kind = 'automation'
      AND NOT EXISTS (
        SELECT 1
        FROM automation_runs AS run
        WHERE run.tenant_id = NEW.tenant_id
          AND run.owner_principal_id = NEW.principal_id
          AND run.automation_id = NEW.automation_id
          AND run.id = NEW.automation_run_id
          AND (
            run.anchor_thread_id = NEW.thread_id
            OR run.child_thread_id = NEW.thread_id
          )
      )
    THEN RAISE(ABORT, 'automation_first_send_identity_mismatch')
  END;
END;

CREATE TABLE automation_mutation_receipts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  automation_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL
    CHECK (mutation_kind IN ('update', 'state', 'delete')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
  FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
    REFERENCES automation_definitions(
      tenant_id, owner_principal_id, id
    ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX automation_mutation_receipts_created
  ON automation_mutation_receipts(
    tenant_id, owner_principal_id, created_at
  );
`,
} as const;
