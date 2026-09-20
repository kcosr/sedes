import type Database from "better-sqlite3";
import type { DatabaseMigration } from "../migrate.js";

/**
 * Cuts Claude thread settings over to the complete permission-aware contract.
 * Existing thread model/effort intent is retained, but permission intent and
 * all effective evidence remain unresolved until the new runtime attaches.
 */
export const claudePermissionSettingsMigration: DatabaseMigration = {
  version: 54,
  name: "claude_permission_settings",
  verifyDatabaseIntegrity: true,
  preflight: assertClaudePermissionMigrationQuiescent,
  sql: `
ALTER TABLE claude_thread_settings RENAME TO claude_thread_settings_v52;

CREATE TABLE claude_thread_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  backend_instance_id TEXT NOT NULL CHECK (
    length(backend_instance_id) BETWEEN 1 AND 128
  ),
  connection_profile_id TEXT NOT NULL CHECK (
    length(connection_profile_id) BETWEEN 1 AND 128
  ),
  execution_environment_id TEXT NOT NULL,
  desired_model TEXT CHECK (
    desired_model IS NULL OR length(desired_model) BETWEEN 1 AND 240
  ),
  desired_effort TEXT CHECK (
    desired_effort IS NULL OR length(desired_effort) BETWEEN 1 AND 120
  ),
  desired_permission_mode TEXT CHECK (
    desired_permission_mode IS NULL OR desired_permission_mode IN (
      'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
    )
  ),
  effective_model TEXT CHECK (
    effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 240
  ),
  effective_model_state TEXT NOT NULL CHECK (
    effective_model_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_model_generation INTEGER CHECK (effective_model_generation > 0),
  effective_effort TEXT CHECK (
    effective_effort IS NULL OR length(effective_effort) BETWEEN 1 AND 120
  ),
  effective_effort_state TEXT NOT NULL CHECK (
    effective_effort_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_effort_generation INTEGER CHECK (effective_effort_generation > 0),
  effective_permission_mode TEXT CHECK (
    effective_permission_mode IS NULL OR effective_permission_mode IN (
      'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
    )
  ),
  effective_permission_classification TEXT CHECK (
    effective_permission_classification IS NULL
    OR effective_permission_classification IN ('recognized', 'external_custom')
  ),
  effective_permission_state TEXT NOT NULL CHECK (
    effective_permission_state IN ('unconfirmed', 'confirmed', 'unknown')
  ),
  effective_permission_generation INTEGER CHECK (
    effective_permission_generation > 0
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (desired_model IS NULL AND desired_effort IS NULL)
    OR (desired_model IS NOT NULL AND desired_effort IS NOT NULL)
  ),
  CHECK (
    (effective_model_state = 'unconfirmed'
      AND effective_model IS NULL AND effective_model_generation IS NULL)
    OR (effective_model_state = 'confirmed'
      AND effective_model IS NOT NULL AND effective_model_generation IS NOT NULL)
    OR (effective_model_state = 'unknown' AND effective_model_generation IS NULL)
  ),
  CHECK (
    (effective_effort_state = 'unconfirmed'
      AND effective_effort IS NULL AND effective_effort_generation IS NULL)
    OR (effective_effort_state = 'confirmed'
      AND effective_effort IS NOT NULL AND effective_effort_generation IS NOT NULL)
    OR (effective_effort_state = 'unknown' AND effective_effort_generation IS NULL)
  ),
  CHECK (
    (effective_permission_state = 'unconfirmed'
      AND effective_permission_mode IS NULL
      AND effective_permission_classification IS NULL
      AND effective_permission_generation IS NULL)
    OR (effective_permission_state = 'confirmed'
      AND effective_permission_classification IS NOT NULL
      AND effective_permission_generation IS NOT NULL
      AND ((effective_permission_classification = 'recognized'
          AND effective_permission_mode IS NOT NULL)
        OR (effective_permission_classification = 'external_custom'
          AND effective_permission_mode IS NULL)))
    OR (effective_permission_state = 'unknown'
      AND effective_permission_generation IS NULL)
  ),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id,
    backend_instance_id, connection_profile_id, environment_id
  ) ON DELETE CASCADE
) STRICT;

INSERT INTO claude_thread_settings(
  tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id,
  desired_model, desired_effort, desired_permission_mode,
  effective_model_state, effective_effort_state,
  effective_permission_state, revision, created_at, updated_at
)
SELECT tenant_id, owner_principal_id, application_thread_id,
  backend_instance_id, connection_profile_id, execution_environment_id,
  desired_model, desired_effort, NULL,
  'unconfirmed', 'unconfirmed', 'unconfirmed', revision, created_at, updated_at
FROM claude_thread_settings_v52;

DROP TABLE claude_thread_settings_v52;

CREATE TABLE claude_operation_settings_snapshots (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  application_operation_id TEXT NOT NULL CHECK (
    length(application_operation_id) BETWEEN 1 AND 128
  ),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 240),
  effort TEXT NOT NULL CHECK (length(effort) BETWEEN 1 AND 120),
  permission_mode TEXT NOT NULL CHECK (permission_mode IN (
    'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
  )),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    application_operation_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES claude_thread_settings(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER claude_operation_settings_snapshots_immutable_update
BEFORE UPDATE ON claude_operation_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
END;

CREATE TRIGGER claude_operation_settings_snapshots_immutable_delete
BEFORE DELETE ON claude_operation_settings_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
END;

-- The v1 and v2 override arrays have identical model/effort syntax. Omitted
-- permission_mode intentionally resolves from the target default at use time.
UPDATE saved_agents
SET backend_overrides_schema_version = 2
WHERE backend_type_id = 'claude'
  AND backend_overrides_schema_version = 1;
`,
};

export function assertClaudePermissionMigrationQuiescent(
  database: Database.Database,
): void {
  assertClaudeSavedAgentV1Overrides(database);
  const checks = [
    {
      label: "creation attempts",
      sql: `
        SELECT 1
        FROM conversation_creation_attempts AS attempt
        JOIN agent_backend_instances AS backend
          ON backend.tenant_id = attempt.tenant_id
         AND backend.id = attempt.backend_instance_id
        WHERE backend.kind = 'claude_agent_sdk'
          AND attempt.phase NOT IN ('bound', 'aborted_unpersisted')
        LIMIT 1
      `,
    },
    {
      label: "queued inputs",
      sql: `
        SELECT 1
        FROM queued_inputs AS queued
        JOIN application_threads AS thread
          ON thread.tenant_id = queued.tenant_id
         AND thread.owner_principal_id = queued.owner_principal_id
         AND thread.id = queued.application_thread_id
        JOIN agent_backend_instances AS backend
          ON backend.tenant_id = thread.tenant_id
         AND backend.id = thread.backend_instance_id
        WHERE backend.kind = 'claude_agent_sdk'
          AND queued.state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
        LIMIT 1
      `,
    },
    {
      label: "conversation mutations",
      sql: `
        SELECT 1
        FROM mutation_receipts AS receipt
        JOIN application_threads AS thread
          ON thread.tenant_id = receipt.tenant_id
         AND thread.owner_principal_id = receipt.principal_id
         AND thread.id = receipt.thread_id
        JOIN agent_backend_instances AS backend
          ON backend.tenant_id = thread.tenant_id
         AND backend.id = thread.backend_instance_id
        WHERE backend.kind = 'claude_agent_sdk'
          AND receipt.result_code IN (
            'prepared', 'uncertain', 'pending_materialization'
          )
        LIMIT 1
      `,
    },
    {
      label: "provider-feature mutations",
      sql: `
        SELECT 1
        FROM provider_feature_mutation_receipts AS receipt
        JOIN application_threads AS thread
          ON thread.tenant_id = receipt.tenant_id
         AND thread.owner_principal_id = receipt.owner_principal_id
         AND thread.id = receipt.application_thread_id
        JOIN agent_backend_instances AS backend
          ON backend.tenant_id = thread.tenant_id
         AND backend.id = thread.backend_instance_id
        WHERE backend.kind = 'claude_agent_sdk'
          AND receipt.state IN ('prepared', 'uncertain')
        LIMIT 1
      `,
    },
    {
      label: "automation runs",
      sql: `
        SELECT 1
        FROM automation_runs AS run
        JOIN application_threads AS thread
          ON thread.tenant_id = run.tenant_id
         AND thread.owner_principal_id = run.owner_principal_id
         AND thread.id = coalesce(run.child_thread_id, run.anchor_thread_id)
        JOIN agent_backend_instances AS backend
          ON backend.tenant_id = thread.tenant_id
         AND backend.id = thread.backend_instance_id
        WHERE backend.kind = 'claude_agent_sdk'
          AND run.state IN (
            'claimed', 'dispatching', 'queued', 'running', 'uncertain'
          )
        LIMIT 1
      `,
    },
  ] as const;
  const active = checks
    .filter(({ sql }) => database.prepare(sql).get() !== undefined)
    .map(({ label }) => label);
  if (active.length === 0) return;
  throw new Error(
    `Claude permission migration requires a quiescent backend; resolve nonterminal ${active.join(
      ", ",
    )} before restarting Sedes.`,
  );
}

function assertClaudeSavedAgentV1Overrides(
  database: Database.Database,
): void {
  const rows = database
    .prepare(
      `SELECT id, backend_overrides_json AS overridesJson
       FROM saved_agents
       WHERE backend_type_id = 'claude'
         AND backend_overrides_schema_version = 1`,
    )
    .all() as readonly {
    readonly id: string;
    readonly overridesJson: string;
  }[];
  for (const row of rows) {
    let overrides: unknown;
    try {
      overrides = JSON.parse(row.overridesJson);
    } catch {
      throw invalidClaudeSavedAgent(row.id);
    }
    if (!Array.isArray(overrides)) throw invalidClaudeSavedAgent(row.id);
    const seen = new Set<string>();
    for (const override of overrides) {
      if (
        typeof override !== "object" ||
        override === null ||
        Array.isArray(override)
      ) {
        throw invalidClaudeSavedAgent(row.id);
      }
      const record = override as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== "id" ||
        keys[1] !== "value" ||
        (record.id !== "model" && record.id !== "reasoning_effort") ||
        typeof record.value !== "string" ||
        record.value.length < 1 ||
        record.value.length > 240 ||
        seen.has(record.id)
      ) {
        throw invalidClaudeSavedAgent(row.id);
      }
      seen.add(record.id);
    }
  }
}

function invalidClaudeSavedAgent(id: string): Error {
  return new Error(
    `Claude permission migration cannot advance Saved Agent ${id}; its v1 overrides are invalid. Repair or remove that Saved Agent before restarting Sedes.`,
  );
}
