import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const EMPTY_CONFIGURATION_FINGERPRINT =
  "24668c7a96a190bd6dcd0a35b773fa05901690fc5cef5c6dd37a59fbf0e6b5ae";

describe("migration 063 Grok Build backend", () => {
  it("preserves existing targets and admits only the exact Grok kind pair and release", () => {
    const value = savedAgentDatabase(62);
    try {
      const before = value.database
        .prepare(
          `SELECT kind, protocol_release AS protocolRelease,
             configuration_fingerprint AS configurationFingerprint
           FROM agent_backend_instances ORDER BY id`,
        )
        .all();
      const environment = value.database
        .prepare(
          `SELECT id FROM execution_environments
           WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'`,
        )
        .get(value.scope.tenantId, value.scope.principalId) as {
        readonly id: string;
      };

      applyDatabaseMigrations(
        value.database,
        backendNormalizedMigrations.filter(({ version }) => version <= 63),
      );

      expect(
        value.database
          .prepare(
            `SELECT kind, protocol_release AS protocolRelease,
               configuration_fingerprint AS configurationFingerprint
             FROM agent_backend_instances ORDER BY id`,
          )
          .all(),
      ).toEqual(before);
      expect(
        value.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 63 });

      const insertBackend = value.database.prepare(`
        INSERT INTO agent_backend_instances(
          tenant_id, id, kind, label, enabled, configuration_revision,
          protocol_release, created_at, updated_at, configuration_fingerprint
        ) VALUES (?, ?, 'grok_build', 'Grok', 1, 0, ?, 200, 200, ?)
      `);
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "grok-local",
          "1.x",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "grok-wrong-release",
          "1.0.4",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).toThrow(/constraint/i);

      const insertProfile = value.database.prepare(`
        INSERT INTO agent_connection_profiles(
          tenant_id, owner_principal_id, id, template_id,
          backend_instance_id, backend_kind, execution_environment_id,
          kind, label, enabled, configuration_revision, created_at, updated_at,
          configuration_fingerprint
        ) VALUES (?, ?, ?, ?, 'grok-local', 'grok_build', ?, ?, 'Grok', 1,
          0, 200, 200, ?)
      `);
      expect(() =>
        insertProfile.run(
          value.scope.tenantId,
          value.scope.principalId,
          "grok-profile",
          "grok-template",
          environment.id,
          "grok_acp",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).not.toThrow();
      expect(() =>
        insertProfile.run(
          value.scope.tenantId,
          value.scope.principalId,
          "grok-wrong-profile",
          "grok-wrong-template",
          environment.id,
          "pi_sdk",
          EMPTY_CONFIGURATION_FINGERPRINT,
        ),
      ).toThrow(/constraint/i);

      expect(
        value.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'grok_binding_details'`,
          )
          .get(),
      ).toEqual({ name: "grok_binding_details" });
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
      expect(value.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      value.database.close();
    }
  });

  it("creates the Grok binding and model-settings tables on a fresh latest database", () => {
    const value = savedAgentDatabase();
    try {
      expect(
        value.database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'grok_binding_details'`,
          )
          .get(),
      ).toBeDefined();
      expect(
        value.database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'grok_thread_settings'`,
          )
          .get(),
      ).toBeDefined();
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  it("backfills unknown settings for Grok threads that predate migration 064", () => {
    const value = savedAgentDatabase(63);
    try {
      const environment = value.database
        .prepare(
          `SELECT id FROM execution_environments
           WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'`,
        )
        .get(value.scope.tenantId, value.scope.principalId) as {
        readonly id: string;
      };
      value.database
        .prepare(
          `INSERT INTO agent_backend_instances(
             tenant_id, id, kind, label, enabled, configuration_revision,
             protocol_release, created_at, updated_at, configuration_fingerprint
           ) VALUES (?, 'grok-local', 'grok_build', 'Grok', 1, 0, '1.x',
             200, 200, ?)`,
        )
        .run(value.scope.tenantId, EMPTY_CONFIGURATION_FINGERPRINT);
      value.database
        .prepare(
          `INSERT INTO agent_connection_profiles(
             tenant_id, owner_principal_id, id, template_id,
             backend_instance_id, backend_kind, execution_environment_id,
             kind, label, enabled, configuration_revision, created_at, updated_at,
             configuration_fingerprint
           ) VALUES (?, ?, 'grok-profile', 'grok-template', 'grok-local',
             'grok_build', ?, 'grok_acp', 'Grok', 1, 0, 200, 200, ?)`,
        )
        .run(
          value.scope.tenantId,
          value.scope.principalId,
          environment.id,
          EMPTY_CONFIGURATION_FINGERPRINT,
        );
      const workspace = new InventoryRepository(value.database).upsertWorkspace(
        value.scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/grok-migration-064",
          displayName: "Grok migration",
          available: true,
          trustState: "trusted",
          environmentConfigurationRevision: 0,
          now: 210,
        },
      );
      new ConversationBindingRepository(value.database).createUnboundThread(
        value.scope,
        {
          id: "grok-thread-before-settings",
          workspaceId: workspace.id,
          connectionProfileId: "grok-profile",
          title: "Existing Grok thread",
          now: 220,
        },
      );

      applyDatabaseMigrations(value.database, backendNormalizedMigrations);

      expect(
        value.database
          .prepare(
            `SELECT desired_model AS model, desired_effort AS effort,
               effective_state AS effectiveState, revision
             FROM grok_thread_settings
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND application_thread_id = ?`,
          )
          .get(
            value.scope.tenantId,
            value.scope.principalId,
            "grok-thread-before-settings",
          ),
      ).toEqual({
        model: null,
        effort: null,
        effectiveState: "unknown",
        revision: 0,
      });
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  it("advances only valid empty Grok v1 Saved Agent envelopes to v2", () => {
    const value = savedAgentDatabase(63);
    try {
      const insert = value.database.prepare(
        `INSERT INTO saved_agents(
           tenant_id, owner_principal_id, id, name, description,
           backend_type_id, backend_overrides_schema_version,
           backend_overrides_json, harness_tools_json, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const rows = [
        {
          id: "00000000-0000-4000-8000-000000000064",
          name: "Legacy Grok",
          description: "Preserve me",
          backendTypeId: "grok",
          schemaVersion: 1,
          overridesJson: "[]",
          sedesToolsJson:
            '{"enabled":false,"enabledToolIds":[],"presentationMode":"cli","environmentAccess":{"otherEnvironments":"ask"}}',
          revision: 7,
          createdAt: 111,
          updatedAt: 222,
        },
        {
          id: "00000000-0000-4000-8000-000000000065",
          name: "Invalid Grok v1",
          description: "Fail closed",
          backendTypeId: "grok",
          schemaVersion: 1,
          overridesJson: JSON.stringify([{ id: "model", value: "unexpected" }]),
          sedesToolsJson: null,
          revision: 3,
          createdAt: 112,
          updatedAt: 223,
        },
        {
          id: "00000000-0000-4000-8000-000000000066",
          name: "Other backend",
          description: "Untouched",
          backendTypeId: "claude",
          schemaVersion: 1,
          overridesJson: "[]",
          sedesToolsJson: null,
          revision: 4,
          createdAt: 113,
          updatedAt: 224,
        },
        {
          id: "00000000-0000-4000-8000-000000000067",
          name: "Current Grok",
          description: "Already current",
          backendTypeId: "grok",
          schemaVersion: 2,
          overridesJson: JSON.stringify([
            { id: "model", value: "grok-build" },
            { id: "reasoning_effort", value: "low" },
          ]),
          sedesToolsJson: null,
          revision: 5,
          createdAt: 114,
          updatedAt: 225,
        },
      ] as const;
      for (const row of rows) {
        insert.run(
          value.scope.tenantId,
          value.scope.principalId,
          row.id,
          row.name,
          row.description,
          row.backendTypeId,
          row.schemaVersion,
          row.overridesJson,
          row.sedesToolsJson,
          row.revision,
          row.createdAt,
          row.updatedAt,
        );
      }

      applyDatabaseMigrations(value.database, backendNormalizedMigrations);

      const migrated = value.database
        .prepare(
          `SELECT id, name, description,
             backend_type_id AS backendTypeId,
             backend_overrides_schema_version AS schemaVersion,
             backend_overrides_json AS overridesJson,
             sedes_tools_json AS sedesToolsJson,
             revision, created_at AS createdAt, updated_at AS updatedAt
           FROM saved_agents
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND id IN (?, ?, ?, ?)
           ORDER BY id`,
        )
        .all(
          value.scope.tenantId,
          value.scope.principalId,
          ...rows.map(({ id }) => id),
        );
      expect(migrated).toEqual(
        rows.map((row, index) => ({
          ...row,
          schemaVersion: index === 0 ? 2 : row.schemaVersion,
          ...(index === 0
            ? {
                sedesToolsJson:
                  '{"enabled":false,"enabledToolIds":[],"presentation":{"surface":"cli","mode":"progressive"},"accessBoundary":"environment"}',
              }
            : {}),
        })),
      );
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      value.database.close();
    }
  });
});
