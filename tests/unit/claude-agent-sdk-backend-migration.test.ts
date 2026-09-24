import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { assertClaudePermissionMigrationQuiescent } from "../../src/server/db/migrations/054-claude-permission-settings.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

const EMPTY_CONFIGURATION_FINGERPRINT =
  "24668c7a96a190bd6dcd0a35b773fa05901690fc5cef5c6dd37a59fbf0e6b5ae";

describe("Claude Agent SDK backend migration", () => {
  it("refuses the permission cutover while Claude work is nonterminal", () => {
    const current = savedAgentDatabase(52);
    try {
      current.database.pragma("foreign_keys = OFF");
      current.database
        .prepare(
          `
          INSERT INTO agent_backend_instances(
            tenant_id, id, kind, label, enabled, configuration_revision,
            protocol_release, created_at, updated_at, configuration_fingerprint
          ) VALUES (?, 'claude-local', 'claude_agent_sdk', 'Claude', 1, 0,
            '0.3.226', 100, 100, ?)
        `,
        )
        .run(current.scope.tenantId, EMPTY_CONFIGURATION_FINGERPRINT);
      current.database
        .prepare(
          `
          INSERT INTO conversation_creation_attempts(
            tenant_id, owner_principal_id, application_thread_id, attempt_id,
            mutation_id, backend_instance_id, connection_profile_id,
            execution_environment_id, creation_kind, source_kind,
            initial_input_text, consumed_draft_revision,
            backend_creation_correlation, phase, prepared_at
          ) VALUES (?, ?, 'thread-a', 'attempt-a', 'mutation-a',
            'claude-local', 'claude-profile', 'environment-a',
            'first_input', 'composer', 'prompt', 1, 'correlation-a',
            'prepared', 100)
        `,
        )
        .run(current.scope.tenantId, current.scope.principalId);

      expect(() =>
        applyDatabaseMigrations(current.database, backendNormalizedMigrations),
      ).toThrow(
        /Claude permission migration requires a quiescent backend; resolve nonterminal creation attempts/,
      );
      expect(
        current.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 53 });
      current.database
        .prepare(
          `UPDATE conversation_creation_attempts
           SET phase = 'aborted_unpersisted'
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id = 'thread-a'`,
        )
        .run(current.scope.tenantId, current.scope.principalId);
      expect(() =>
        assertClaudePermissionMigrationQuiescent(current.database),
      ).not.toThrow();
    } finally {
      current.database.close();
    }
  });

  it("advances Claude Saved Agent envelopes without changing overrides", () => {
    const current = savedAgentDatabase(52);
    try {
      const overrides = JSON.stringify([
        { id: "model", value: "claude-sonnet-5" },
        { id: "reasoning_effort", value: "medium" },
      ]);
      current.database
        .prepare(
          `
        INSERT INTO saved_agents(
          tenant_id, owner_principal_id, id, name, description,
          backend_type_id, backend_overrides_schema_version,
          backend_overrides_json, harness_tools_json, revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'Claude agent', '', 'claude', 1, ?, NULL, 0, 100, 100)
      `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          "00000000-0000-4000-8000-000000000053",
          overrides,
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        current.database
          .prepare(
            `
          SELECT backend_overrides_schema_version AS schemaVersion,
            backend_overrides_json AS overridesJson
          FROM saved_agents
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND id = '00000000-0000-4000-8000-000000000053'
        `,
          )
          .get(current.scope.tenantId, current.scope.principalId),
      ).toEqual({ schemaVersion: 2, overridesJson: overrides });
    } finally {
      current.database.close();
    }
  });

  it("refuses to relabel an invalid Claude Saved Agent v1 envelope", () => {
    const current = savedAgentDatabase(52);
    try {
      current.database
        .prepare(
          `
          INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, harness_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'Invalid Claude agent', '', 'claude', 1,
            ?, NULL, 0, 100, 100)
        `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          "00000000-0000-4000-8000-000000000054",
          JSON.stringify([{ id: "permission_mode", value: "default" }]),
        );

      expect(() =>
        applyDatabaseMigrations(current.database, backendNormalizedMigrations),
      ).toThrow(/its v1 overrides are invalid/);
      expect(
        current.database
          .prepare(
            `SELECT backend_overrides_schema_version AS schemaVersion
             FROM saved_agents
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND id = '00000000-0000-4000-8000-000000000054'`,
          )
          .get(current.scope.tenantId, current.scope.principalId),
      ).toEqual({ schemaVersion: 1 });
    } finally {
      current.database.close();
    }
  });

  it("preserves existing targets and constrains Claude kinds and release shape", () => {
    const current = savedAgentDatabase(48);
    try {
      const beforeBackend = current.database
        .prepare(
          `SELECT kind, protocol_release AS protocolRelease,
             configuration_fingerprint AS configurationFingerprint
           FROM agent_backend_instances`,
        )
        .get();
      const environment = current.database
        .prepare(
          `SELECT id FROM execution_environments
           WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'`,
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        id: string;
      };

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        current.database
          .prepare(
            `SELECT kind, protocol_release AS protocolRelease,
               configuration_fingerprint AS configurationFingerprint
             FROM agent_backend_instances`,
          )
          .get(),
      ).toEqual(beforeBackend);
      expect(
        current.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: latestBackendNormalizedVersion });

      const insertBackend = current.database.prepare(`
        INSERT INTO agent_backend_instances(
          tenant_id, owner_principal_id, id, kind, label, enabled, configuration_revision,
          protocol_release, created_at, updated_at, configuration_fingerprint
        ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, 200, 200, ?)
      `);
      expect(() =>
        insertBackend.run(
          current.scope.tenantId,
          current.scope.principalId,
          "claude-local",
          "claude_agent_sdk",
          "Claude",
          "0.3.226",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          current.scope.tenantId,
          current.scope.principalId,
          "claude-other-release",
          "claude_agent_sdk",
          "Claude",
          "0.3.225",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          current.scope.tenantId,
          current.scope.principalId,
          "claude-empty-release",
          "claude_agent_sdk",
          "Claude",
          "",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).toThrow(/constraint/i);

      const insertProfile = current.database.prepare(`
        INSERT INTO agent_connection_profiles(
          tenant_id, owner_principal_id, id, template_id,
          backend_instance_id, backend_kind, execution_environment_id,
          kind, label, enabled, configuration_revision, created_at, updated_at,
          configuration_fingerprint
        ) VALUES (?, ?, ?, ?, 'claude-local', 'claude_agent_sdk', ?, ?, ?, 1,
          0, 200, 200, ?)
      `);
      expect(() =>
        insertProfile.run(
          current.scope.tenantId,
          current.scope.principalId,
          "claude-profile",
          "claude-template",
          environment.id,
          "claude_agent_sdk",
          "Claude",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).not.toThrow();
      expect(() =>
        insertProfile.run(
          current.scope.tenantId,
          current.scope.principalId,
          "claude-wrong-profile",
          "claude-wrong-template",
          environment.id,
          "pi_sdk",
          "Wrong",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).toThrow(/constraint/i);

      expect(
        current.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN (
                 'claude_thread_settings', 'claude_binding_details',
                 'claude_turn_terminal_receipts', 'claude_usage_ledgers',
                 'claude_operation_settings_snapshots'
               )
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "claude_binding_details" },
        { name: "claude_operation_settings_snapshots" },
        { name: "claude_thread_settings" },
        { name: "claude_turn_terminal_receipts" },
      ]);
      expect(
        (
          current.database.pragma(
            "foreign_key_list(claude_turn_terminal_receipts)",
          ) as { table: string; on_delete: string }[]
        )
          .filter((foreignKey) => foreignKey.table === "application_threads")
          .map((foreignKey) => foreignKey.on_delete),
      ).toEqual(["CASCADE", "CASCADE", "CASCADE"]);
      expect(
        (
          current.database.pragma("foreign_key_list(usage_thread_state)") as {
            table: string;
            on_delete: string;
          }[]
        )
          .filter((foreignKey) => foreignKey.table === "application_threads")
          .map((foreignKey) => foreignKey.on_delete),
      ).toEqual(["RESTRICT", "RESTRICT", "RESTRICT"]);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(current.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      current.database.close();
    }
  });

  it("rolls back the rebuild and restores SQLite alter and foreign-key policy", () => {
    const current = savedAgentDatabase(48);
    try {
      expect(() =>
        applyDatabaseMigrations(current.database, backendNormalizedMigrations, {
          verifyBeforeCommit(_database, migration) {
            if (migration.version === 49) {
              throw new Error("injected migration 49 verification failure");
            }
          },
        }),
      ).toThrow("injected migration 49 verification failure");

      expect(
        current.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 48 });
      expect(current.database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        current.database.pragma("legacy_alter_table", { simple: true }),
      ).toBe(0);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(
        current.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'claude_thread_settings'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      current.database.close();
    }
  });
});
