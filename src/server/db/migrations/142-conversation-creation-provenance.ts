import type { DatabaseMigration } from "../migrate.js";

export const conversationCreationProvenanceMigration: DatabaseMigration = {
  version: 142,
  name: "conversation_creation_provenance",
  sql: `
CREATE TABLE conversation_creation_provenance (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  backend_instance_id TEXT NOT NULL,
  connection_profile_id TEXT NOT NULL,
  execution_environment_id TEXT NOT NULL,
  backend_conversation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('first_input', 'fork')),
  verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('binding', 'migration', 'repair')),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id)
    REFERENCES conversation_bindings(tenant_id, owner_principal_id, application_thread_id,
      backend_instance_id, connection_profile_id, execution_environment_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id, attempt_id)
    REFERENCES conversation_creation_attempts(tenant_id, owner_principal_id, application_thread_id, attempt_id)
) STRICT;
CREATE TRIGGER conversation_creation_provenance_immutable BEFORE UPDATE ON conversation_creation_provenance
BEGIN SELECT RAISE(ABORT, 'Conversation creation provenance is immutable'); END;

-- Existing identified creations have both an authoritative native identity and
-- a matching durable binding. Abandoned creations require explicit repair.
INSERT INTO conversation_creation_provenance
SELECT binding.tenant_id, binding.owner_principal_id, binding.application_thread_id,
  binding.backend_instance_id, binding.connection_profile_id, binding.execution_environment_id,
  binding.backend_conversation_id, attempt.attempt_id, attempt.creation_kind,
  binding.created_at, 'migration'
FROM conversation_bindings AS binding
JOIN conversation_creation_attempts AS attempt
  ON attempt.tenant_id=binding.tenant_id AND attempt.owner_principal_id=binding.owner_principal_id
  AND attempt.application_thread_id=binding.application_thread_id
  AND attempt.backend_instance_id=binding.backend_instance_id
  AND attempt.connection_profile_id=binding.connection_profile_id
  AND attempt.execution_environment_id=binding.execution_environment_id
  AND attempt.provisional_backend_conversation_id=binding.backend_conversation_id
WHERE attempt.phase IN ('conversation_identified','first_submission_started','accepted_unpersisted','recovery_required','bound')
  AND attempt.force_reset_at IS NULL AND attempt.external_call_started_at IS NOT NULL
  AND attempt.provisional_opaque_binding_detail IS NOT NULL
  AND (SELECT count(*) FROM conversation_creation_attempts AS candidate
    WHERE candidate.tenant_id=binding.tenant_id AND candidate.owner_principal_id=binding.owner_principal_id
      AND candidate.application_thread_id=binding.application_thread_id
      AND candidate.provisional_backend_conversation_id=binding.backend_conversation_id
      AND candidate.phase IN ('conversation_identified','first_submission_started','accepted_unpersisted','recovery_required','bound')
      AND candidate.force_reset_at IS NULL)=1;

CREATE TABLE conversation_creation_provenance_repairs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  repair_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL CHECK (length(evidence_fingerprint)=64),
  repaired_at INTEGER NOT NULL CHECK (repaired_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, repair_id),
  -- Audit survives thread/binding cleanup and cannot veto it.
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER conversation_creation_provenance_repairs_immutable BEFORE UPDATE ON conversation_creation_provenance_repairs
BEGIN SELECT RAISE(ABORT, 'Conversation provenance repair receipts are immutable'); END;
`,
};
