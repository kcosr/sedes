import type { DatabaseMigration } from "../migrate.js";

export const parkedThreadInventoryMigration: DatabaseMigration = {
  version: 172,
  name: "parked_thread_inventory",
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE thread_principal_state_v172 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  inventory_state TEXT NOT NULL CHECK (
    inventory_state IN ('active', 'snoozed', 'parked', 'archived')
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
    wake_reminder_text IS NULL OR (
      length(wake_reminder_text) BETWEEN 1 AND 1000
      AND length(CAST(wake_reminder_text AS BLOB)) <= 4096
    )
  ),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  pin_revision INTEGER NOT NULL DEFAULT 0 CHECK (pin_revision BETWEEN 0 AND 9007199254740991),
  group_assignment_revision INTEGER NOT NULL DEFAULT 0 CHECK (group_assignment_revision BETWEEN 0 AND 9007199254740991),
  bookmark_revision INTEGER NOT NULL DEFAULT 0 CHECK (bookmark_revision BETWEEN 0 AND 9007199254740991),
  preferred_worktree_root_id TEXT CHECK (preferred_worktree_root_id IS NULL OR length(preferred_worktree_root_id) BETWEEN 1 AND 128),
  preferred_worktree_revision INTEGER NOT NULL DEFAULT 0 CHECK (preferred_worktree_revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  CHECK (
    (inventory_state = 'snoozed' AND snoozed_at IS NOT NULL AND snoozed_until IS NOT NULL)
    OR (inventory_state <> 'snoozed' AND snoozed_at IS NULL AND snoozed_until IS NULL)
  ),
  CHECK (inventory_state = 'active' OR (woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL)),
  CHECK ((woke_at IS NULL AND wake_reason IS NULL AND wake_acknowledged_at IS NULL) OR (woke_at IS NOT NULL AND wake_reason IS NOT NULL))
) STRICT;

INSERT INTO thread_principal_state_v172(
  tenant_id, principal_id, thread_id, inventory_state, state_changed_at,
  snoozed_at, snoozed_until, woke_at, wake_reason, wake_acknowledged_at,
  inventory_revision, wake_reminder_text, pinned, pin_revision,
  group_assignment_revision, bookmark_revision, preferred_worktree_root_id, preferred_worktree_revision
)
SELECT tenant_id, principal_id, thread_id,
  CASE inventory_state WHEN 'settled' THEN 'parked' ELSE inventory_state END,
  state_changed_at,
  snoozed_at, snoozed_until, woke_at, wake_reason, wake_acknowledged_at,
  inventory_revision, wake_reminder_text, pinned, pin_revision,
  group_assignment_revision, bookmark_revision, preferred_worktree_root_id, preferred_worktree_revision
FROM thread_principal_state;

DROP TABLE thread_principal_state;
ALTER TABLE thread_principal_state_v172 RENAME TO thread_principal_state;

CREATE INDEX thread_principal_state_active
  ON thread_principal_state(tenant_id, principal_id, inventory_state, thread_id);
CREATE INDEX thread_principal_state_snooze_deadline
  ON thread_principal_state(snoozed_until, tenant_id, principal_id, thread_id)
  WHERE inventory_state = 'snoozed';
CREATE INDEX thread_principal_state_changed
  ON thread_principal_state(tenant_id, principal_id, inventory_state, state_changed_at DESC, thread_id);

CREATE TRIGGER thread_preferred_worktree_insert_guard
BEFORE INSERT ON thread_principal_state
WHEN NEW.preferred_worktree_root_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_threads AS thread
  JOIN workspace_file_linked_worktree_roots AS root
    ON root.tenant_id = thread.tenant_id AND root.owner_principal_id = thread.owner_principal_id
    AND root.workspace_id = thread.workspace_id AND root.root_id = NEW.preferred_worktree_root_id
    AND root.availability = 'available'
  WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.principal_id AND thread.id = NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'preferred worktree is not available for the thread workspace'); END;

CREATE TRIGGER thread_preferred_worktree_update_guard
BEFORE UPDATE OF preferred_worktree_root_id ON thread_principal_state
WHEN NEW.preferred_worktree_root_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_threads AS thread
  JOIN workspace_file_linked_worktree_roots AS root
    ON root.tenant_id = thread.tenant_id AND root.owner_principal_id = thread.owner_principal_id
    AND root.workspace_id = thread.workspace_id AND root.root_id = NEW.preferred_worktree_root_id
    AND root.availability = 'available'
  WHERE thread.tenant_id = NEW.tenant_id AND thread.owner_principal_id = NEW.principal_id AND thread.id = NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'preferred worktree is not available for the thread workspace'); END;

CREATE TRIGGER input_activity_inventory AFTER UPDATE OF inventory_state ON thread_principal_state
WHEN OLD.inventory_state IS NOT NEW.inventory_state
BEGIN
  UPDATE application_threads SET input_activity_revision = input_activity_revision + 1
  WHERE tenant_id = NEW.tenant_id AND owner_principal_id = NEW.principal_id AND id = NEW.thread_id;
END;

-- Preserve committed mutation identities while upgrading the replayed state.
UPDATE mutation_receipts
SET operation_kind = 'park_thread',
    result_json = CASE
      WHEN json_extract(result_json, '$.state.inventoryState') = 'settled'
        THEN json_set(result_json, '$.state.inventoryState', 'parked')
      ELSE result_json
    END
WHERE operation_kind = 'settle_thread';

UPDATE mutation_receipts
SET result_json = json_set(result_json, '$.inventoryState', 'parked')
WHERE operation_kind = 'inventory_transition'
  AND json_extract(result_json, '$.inventoryState') = 'settled';
`,
};
