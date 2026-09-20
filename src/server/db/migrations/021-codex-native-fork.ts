import type { DatabaseMigration } from "../migrate.js";

export const codexNativeForkMigration: DatabaseMigration = {
  version: 21,
  name: "codex-native-fork",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE conversation_creation_attempts
  ADD COLUMN fork_child_identity TEXT CHECK (
    fork_child_identity IS NULL
    OR fork_child_identity IN ('application_reserved', 'provider_assigned')
  );

ALTER TABLE conversation_creation_attempts
  ADD COLUMN fork_creation_recovery TEXT CHECK (
    fork_creation_recovery IS NULL
    OR fork_creation_recovery IN (
      'idempotent', 'exactly_reconcilable', 'potentially_unknown'
    )
  );

ALTER TABLE conversation_creation_attempts
  ADD COLUMN fork_uncertainty_kind TEXT CHECK (
    fork_uncertainty_kind IS NULL OR fork_uncertainty_kind = 'fork_unknown'
  );

UPDATE conversation_creation_attempts
SET fork_child_identity = 'application_reserved',
  fork_creation_recovery = 'idempotent'
WHERE creation_kind = 'fork';

CREATE TRIGGER conversation_creation_attempts_fork_contract_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN (
  NEW.creation_kind = 'fork'
  AND (
    NEW.fork_child_identity IS NULL
    OR NEW.fork_creation_recovery IS NULL
  )
) OR (
  NEW.creation_kind = 'first_input'
  AND (
    NEW.fork_child_identity IS NOT NULL
    OR NEW.fork_creation_recovery IS NOT NULL
    OR NEW.fork_uncertainty_kind IS NOT NULL
  )
) OR (
  NEW.fork_uncertainty_kind = 'fork_unknown'
  AND (
    NEW.creation_kind <> 'fork'
    OR NEW.fork_creation_recovery <> 'potentially_unknown'
    OR NEW.phase <> 'recovery_required'
  )
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
  AND (
    NEW.fork_child_identity IS NOT OLD.fork_child_identity
    OR NEW.fork_creation_recovery IS NOT OLD.fork_creation_recovery
  )
) OR (
  NEW.creation_kind = 'fork'
  AND (
    NEW.fork_child_identity IS NULL
    OR NEW.fork_creation_recovery IS NULL
  )
) OR (
  NEW.creation_kind = 'first_input'
  AND (
    NEW.fork_child_identity IS NOT NULL
    OR NEW.fork_creation_recovery IS NOT NULL
    OR NEW.fork_uncertainty_kind IS NOT NULL
  )
) OR (
  NEW.fork_uncertainty_kind = 'fork_unknown'
  AND (
    NEW.creation_kind <> 'fork'
    OR NEW.fork_creation_recovery <> 'potentially_unknown'
    OR NEW.phase <> 'recovery_required'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation creation fork contract violated');
END;

CREATE UNIQUE INDEX conversation_bindings_codex_detail_scope
ON conversation_bindings(
  tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id
);

CREATE TABLE codex_binding_details (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  opaque_binding_detail TEXT NOT NULL CHECK (
    length(CAST(opaque_binding_detail AS BLOB)) BETWEEN 1 AND 4096
    AND json_valid(opaque_binding_detail)
    AND json_type(opaque_binding_detail) = 'object'
    AND json_extract(opaque_binding_detail, '$.version') = 2
    AND json_type(opaque_binding_detail, '$.threadId') = 'text'
    AND length(json_extract(opaque_binding_detail, '$.threadId')) BETWEEN 1 AND 128
    AND json_type(opaque_binding_detail, '$.sessionId') IN ('text', 'null')
    AND (
      json_type(opaque_binding_detail, '$.sessionId') = 'null'
      OR length(json_extract(opaque_binding_detail, '$.sessionId'))
        BETWEEN 1 AND 128
    )
    AND json_type(
      opaque_binding_detail,
      '$.correlationAncestorThreadIds'
    ) = 'array'
    AND json_array_length(
      opaque_binding_detail,
      '$.correlationAncestorThreadIds'
    ) <= 100
    AND json_type(opaque_binding_detail, '$.nativeAncestry')
      IN ('object', 'null')
    AND (
      json_type(opaque_binding_detail, '$.nativeAncestry') = 'null'
      OR (
        json_type(
          opaque_binding_detail,
          '$.nativeAncestry.forkedFromThreadId'
        ) = 'text'
        AND length(json_extract(
          opaque_binding_detail,
          '$.nativeAncestry.forkedFromThreadId'
        )) BETWEEN 1 AND 128
        AND json_type(
          opaque_binding_detail,
          '$.nativeAncestry.sourceTurnId'
        ) IN ('text', 'null')
        AND (
          json_type(
            opaque_binding_detail,
            '$.nativeAncestry.sourceTurnId'
          ) = 'null'
          OR length(json_extract(
            opaque_binding_detail,
            '$.nativeAncestry.sourceTurnId'
          )) BETWEEN 1 AND 128
        )
      )
    )
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES conversation_bindings(
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO codex_binding_details(
  tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id,
  opaque_binding_detail
)
SELECT binding.tenant_id, binding.owner_principal_id,
  binding.application_thread_id, binding.backend_instance_id,
  binding.connection_profile_id, binding.execution_environment_id,
  json_object(
    'version', 2,
    'threadId', binding.backend_conversation_id,
    'sessionId', NULL,
    'correlationAncestorThreadIds', json('[]'),
    'nativeAncestry', NULL
  )
FROM conversation_bindings AS binding
JOIN agent_backend_instances AS backend
  ON backend.tenant_id = binding.tenant_id
  AND backend.id = binding.backend_instance_id
WHERE backend.kind = 'codex_app_server';

UPDATE conversation_creation_attempts
SET provisional_opaque_binding_detail = json_object(
  'version', 2,
  'threadId', provisional_backend_conversation_id,
  'sessionId', NULL,
  'correlationAncestorThreadIds', json('[]'),
  'nativeAncestry', NULL
)
WHERE provisional_opaque_binding_detail IS NOT NULL
  AND provisional_backend_conversation_id IS NOT NULL
  AND backend_instance_id IN (
    SELECT id FROM agent_backend_instances AS backend
    WHERE backend.tenant_id = conversation_creation_attempts.tenant_id
      AND backend.kind = 'codex_app_server'
  );
`,
};
