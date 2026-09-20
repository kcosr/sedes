import { annotatedContext, isNonWhitespace } from "./038-context-excerpts.js";

/**
 * Adds Sedes-owned Standard/Fast intent to the complete Codex execution
 * tuple. Existing desired tuples and immutable operation snapshots are
 * conservatively classified as Standard: Sedes did not previously retain a
 * Fast selection, and the database migration cannot consult a live catalog.
 *
 * Existing effective observations are deliberately cleared and returned to
 * `unconfirmed`. Treating an omitted historical native service tier as an
 * observed Standard tier would fabricate provider state. The next
 * generation-fenced provider observation re-establishes effective truth.
 */
export const codexFastModeMigration = {
  version: 39,
  name: "codex_fast_mode",
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER codex_execution_settings_snapshots_immutable_update;
DROP TRIGGER codex_execution_settings_snapshots_immutable_delete;

ALTER TABLE codex_thread_execution_settings
  RENAME TO codex_thread_execution_settings_v36;
ALTER TABLE codex_execution_settings_snapshots
  RENAME TO codex_execution_settings_snapshots_v36;

CREATE TABLE codex_thread_execution_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  desired_model TEXT CHECK (
    desired_model IS NULL OR length(desired_model) BETWEEN 1 AND 120
  ),
  desired_reasoning_effort TEXT CHECK (
    desired_reasoning_effort IS NULL
    OR length(desired_reasoning_effort) BETWEEN 1 AND 120
  ),
  desired_service_tier TEXT CHECK (
    desired_service_tier IS NULL OR desired_service_tier IN ('standard', 'fast')
  ),
  desired_sandbox_mode TEXT CHECK (
    desired_sandbox_mode IS NULL
    OR desired_sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')
  ),
  desired_network_access TEXT CHECK (
    desired_network_access IS NULL OR desired_network_access IN ('disabled', 'enabled')
  ),
  desired_approval_policy TEXT CHECK (
    desired_approval_policy IS NULL
    OR desired_approval_policy IN ('untrusted', 'on-request', 'never')
  ),
  desired_approval_reviewer TEXT CHECK (
    desired_approval_reviewer IS NULL
    OR desired_approval_reviewer IN ('user', 'auto_review')
  ),
  effective_model TEXT CHECK (
    effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 120
  ),
  effective_reasoning_effort TEXT CHECK (
    effective_reasoning_effort IS NULL
    OR length(effective_reasoning_effort) BETWEEN 1 AND 120
  ),
  effective_service_tier TEXT CHECK (
    effective_service_tier IS NULL OR effective_service_tier IN ('standard', 'fast')
  ),
  effective_service_tier_classification TEXT CHECK (
    effective_service_tier_classification IS NULL
    OR effective_service_tier_classification IN ('recognized', 'external_custom')
  ),
  effective_sandbox_mode TEXT CHECK (
    effective_sandbox_mode IS NULL
    OR effective_sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')
  ),
  effective_sandbox_classification TEXT CHECK (
    effective_sandbox_classification IS NULL
    OR effective_sandbox_classification IN ('recognized', 'external_custom')
  ),
  effective_network_access TEXT CHECK (
    effective_network_access IS NULL OR effective_network_access IN ('disabled', 'enabled')
  ),
  effective_network_classification TEXT CHECK (
    effective_network_classification IS NULL
    OR effective_network_classification IN ('recognized', 'external_custom')
  ),
  effective_approval_policy TEXT CHECK (
    effective_approval_policy IS NULL
    OR effective_approval_policy IN ('untrusted', 'on-request', 'never')
  ),
  effective_approval_policy_classification TEXT CHECK (
    effective_approval_policy_classification IS NULL
    OR effective_approval_policy_classification IN ('recognized', 'external_custom')
  ),
  effective_approval_reviewer TEXT CHECK (
    effective_approval_reviewer IS NULL
    OR effective_approval_reviewer IN ('user', 'auto_review')
  ),
  effective_approval_reviewer_classification TEXT CHECK (
    effective_approval_reviewer_classification IS NULL
    OR effective_approval_reviewer_classification IN ('recognized', 'external_custom')
  ),
  effective_daemon_generation INTEGER CHECK (effective_daemon_generation > 0),
  effective_confirmation_state TEXT NOT NULL CHECK (
    effective_confirmation_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (desired_model IS NULL
      AND desired_reasoning_effort IS NULL
      AND desired_service_tier IS NULL
      AND desired_sandbox_mode IS NULL
      AND desired_network_access IS NULL
      AND desired_approval_policy IS NULL
      AND desired_approval_reviewer IS NULL)
    OR
    (desired_model IS NOT NULL
      AND desired_reasoning_effort IS NOT NULL
      AND desired_service_tier IS NOT NULL
      AND desired_sandbox_mode IS NOT NULL
      AND desired_network_access IS NOT NULL
      AND desired_approval_policy IS NOT NULL
      AND desired_approval_reviewer IS NOT NULL
      AND (desired_sandbox_mode <> 'danger-full-access'
        OR desired_network_access = 'enabled'))
  ),
  CHECK (
    (effective_model IS NULL
      AND effective_reasoning_effort IS NULL
      AND effective_service_tier IS NULL
      AND effective_service_tier_classification IS NULL
      AND effective_sandbox_mode IS NULL
      AND effective_sandbox_classification IS NULL
      AND effective_network_access IS NULL
      AND effective_network_classification IS NULL
      AND effective_approval_policy IS NULL
      AND effective_approval_policy_classification IS NULL
      AND effective_approval_reviewer IS NULL
      AND effective_approval_reviewer_classification IS NULL)
    OR
    (effective_model IS NOT NULL
      AND effective_reasoning_effort IS NOT NULL
      AND ((effective_service_tier_classification = 'recognized'
          AND effective_service_tier IS NOT NULL)
        OR (effective_service_tier_classification = 'external_custom'
          AND effective_service_tier IS NULL))
      AND ((effective_sandbox_classification = 'recognized'
          AND effective_sandbox_mode IS NOT NULL)
        OR (effective_sandbox_classification = 'external_custom'
          AND effective_sandbox_mode IS NULL))
      AND ((effective_network_classification = 'recognized'
          AND effective_network_access IS NOT NULL)
        OR (effective_network_classification = 'external_custom'
          AND effective_network_access IS NULL))
      AND ((effective_approval_policy_classification = 'recognized'
          AND effective_approval_policy IS NOT NULL)
        OR (effective_approval_policy_classification = 'external_custom'
          AND effective_approval_policy IS NULL))
      AND ((effective_approval_reviewer_classification = 'recognized'
          AND effective_approval_reviewer IS NOT NULL)
        OR (effective_approval_reviewer_classification = 'external_custom'
          AND effective_approval_reviewer IS NULL))
      AND (effective_sandbox_mode <> 'danger-full-access'
        OR effective_network_classification = 'external_custom'
        OR effective_network_access = 'enabled'))
  ),
  CHECK (
    (effective_confirmation_state = 'unconfirmed'
      AND effective_model IS NULL
      AND effective_daemon_generation IS NULL)
    OR
    (effective_confirmation_state = 'confirmed'
      AND effective_model IS NOT NULL
      AND effective_daemon_generation IS NOT NULL)
    OR
    (effective_confirmation_state = 'unknown'
      AND effective_daemon_generation IS NULL)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO codex_thread_execution_settings(
  tenant_id, owner_principal_id, application_thread_id,
  desired_model, desired_reasoning_effort, desired_service_tier,
  desired_sandbox_mode, desired_network_access, desired_approval_policy,
  desired_approval_reviewer, effective_confirmation_state, revision,
  created_at, updated_at
)
SELECT tenant_id, owner_principal_id, application_thread_id,
  desired_model, desired_reasoning_effort,
  CASE WHEN desired_model IS NULL THEN NULL ELSE 'standard' END,
  desired_sandbox_mode, desired_network_access, desired_approval_policy,
  desired_approval_reviewer, 'unconfirmed',
  revision + CASE
    WHEN desired_model IS NOT NULL OR effective_confirmation_state <> 'unconfirmed'
      THEN 1 ELSE 0 END,
  created_at, updated_at
FROM codex_thread_execution_settings_v36;

CREATE TABLE codex_execution_settings_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 128
  ),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort TEXT NOT NULL CHECK (
    length(reasoning_effort) BETWEEN 1 AND 120
  ),
  service_tier TEXT NOT NULL CHECK (service_tier IN ('standard', 'fast')),
  sandbox_mode TEXT NOT NULL CHECK (
    sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')
  ),
  network_access TEXT NOT NULL CHECK (network_access IN ('disabled', 'enabled')),
  approval_policy TEXT NOT NULL CHECK (
    approval_policy IN ('untrusted', 'on-request', 'never')
  ),
  approval_reviewer TEXT NOT NULL CHECK (
    approval_reviewer IN ('user', 'auto_review')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (sandbox_mode <> 'danger-full-access' OR network_access = 'enabled'),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    application_operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES codex_thread_execution_settings(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

INSERT INTO codex_execution_settings_snapshots(
  tenant_id, owner_principal_id, application_thread_id,
  application_operation_id, settings_revision, model, reasoning_effort,
  service_tier, sandbox_mode, network_access, approval_policy,
  approval_reviewer, created_at
)
SELECT tenant_id, owner_principal_id, application_thread_id,
  application_operation_id, settings_revision, model, reasoning_effort,
  'standard', sandbox_mode, network_access, approval_policy,
  approval_reviewer, created_at
FROM codex_execution_settings_snapshots_v36;

CREATE TRIGGER codex_execution_settings_snapshots_immutable_update
BEFORE UPDATE ON codex_execution_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
END;

CREATE TRIGGER codex_execution_settings_snapshots_immutable_delete
BEFORE DELETE ON codex_execution_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
END;

DROP TABLE codex_execution_settings_snapshots_v36;
DROP TABLE codex_thread_execution_settings_v36;

-- Migration 038 introduced content guards, but its UPDATE triggers did not
-- cover removing the selected skill. Close that database-level gap while
-- preserving the already-deployed migration-038 checksum.
DROP TRIGGER queued_inputs_content_update;
CREATE TRIGGER queued_inputs_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

DROP TRIGGER conversation_creation_attempts_content_update;
CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_skill_id,
  initial_context_excerpts_json
ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;
`,
} as const;
