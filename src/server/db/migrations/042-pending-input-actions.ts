import type { DatabaseMigration } from "../migrate.js";

/**
 * Adds durable application-owned queue delivery metadata. Provider-native
 * queue state remains outside Sedes authority.
 */
export const pendingInputActionsMigration: DatabaseMigration = {
  version: 42,
  name: "pending-input-actions",
  sql: `
ALTER TABLE queued_inputs
  ADD COLUMN delivery_mode TEXT CHECK (
    delivery_mode IS NULL OR delivery_mode IN ('submit', 'steer')
  );

ALTER TABLE queued_inputs
  ADD COLUMN cancellation_mutation_id TEXT CHECK (
    cancellation_mutation_id IS NULL
    OR length(cancellation_mutation_id) BETWEEN 1 AND 128
  );

ALTER TABLE queued_inputs
  ADD COLUMN cancellation_request_fingerprint TEXT CHECK (
    cancellation_request_fingerprint IS NULL
    OR length(cancellation_request_fingerprint) = 64
  );

UPDATE queued_inputs
SET delivery_mode = 'submit'
WHERE state IN ('dispatching', 'uncertain');

CREATE UNIQUE INDEX queued_inputs_cancellation_mutation
  ON queued_inputs(
    tenant_id, owner_principal_id, application_thread_id,
    cancellation_mutation_id
  )
  WHERE cancellation_mutation_id IS NOT NULL;

CREATE TRIGGER queued_inputs_delivery_mode_insert
BEFORE INSERT ON queued_inputs
WHEN (NEW.state IN ('dispatching', 'uncertain')
    AND (
      NEW.delivery_mode IS NULL
      OR NEW.delivery_mode NOT IN ('submit', 'steer')
    ))
  OR (NEW.state NOT IN ('dispatching', 'uncertain')
    AND NEW.delivery_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued input delivery mode is invalid');
END;

CREATE TRIGGER queued_inputs_delivery_mode_update
BEFORE UPDATE OF state, delivery_mode ON queued_inputs
WHEN (NEW.state IN ('dispatching', 'uncertain')
    AND (
      NEW.delivery_mode IS NULL
      OR NEW.delivery_mode NOT IN ('submit', 'steer')
    ))
  OR (NEW.state NOT IN ('dispatching', 'uncertain')
    AND NEW.delivery_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued input delivery mode is invalid');
END;

CREATE TRIGGER queued_inputs_cancellation_marker_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (
  (NEW.cancellation_mutation_id IS NULL
    AND NEW.cancellation_request_fingerprint IS NULL)
  OR
  (NEW.state = 'cancelled'
    AND NEW.cancellation_mutation_id IS NOT NULL
    AND NEW.cancellation_request_fingerprint IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input cancellation marker is invalid');
END;

CREATE TRIGGER queued_inputs_cancellation_marker_update
BEFORE UPDATE OF state, cancellation_mutation_id,
  cancellation_request_fingerprint ON queued_inputs
WHEN NOT (
  (NEW.cancellation_mutation_id IS NULL
    AND NEW.cancellation_request_fingerprint IS NULL)
  OR
  (NEW.state = 'cancelled'
    AND NEW.cancellation_mutation_id IS NOT NULL
    AND NEW.cancellation_request_fingerprint IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Queued input cancellation marker is invalid');
END;

UPDATE mutation_receipts
SET result_json = json_set(
  result_json,
  '$.version', 4,
  '$.source', 'draft'
)
WHERE operation_kind = 'conversation_steer'
  AND json_extract(result_json, '$.version') = 3;
`,
};
