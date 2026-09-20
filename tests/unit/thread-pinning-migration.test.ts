import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

describe("migration 062 thread pinning", () => {
  it("backfills existing principal-thread rows and enforces bounded pin state", () => {
    const value = savedAgentDatabase(61);
    try {
      const inventory = new InventoryRepository(value.database);
      const environment = inventory.getLocalEnvironment(value.scope);
      const workspace = inventory.upsertWorkspace(value.scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/thread-pinning-migration",
        displayName: "Thread pinning migration",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 110,
      });
      const profile = value.database
        .prepare(
          `SELECT id FROM agent_connection_profiles
           WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY id LIMIT 1`,
        )
        .get(value.scope.tenantId, value.scope.principalId) as {
        readonly id: string;
      };
      const thread = new ConversationBindingRepository(
        value.database,
      ).createUnboundThread(value.scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Existing thread",
        now: 120,
      });

      applyDatabaseMigrations(value.database, backendNormalizedMigrations);

      expect(
        value.database
          .prepare(`SELECT max(version) AS version FROM schema_migrations`)
          .get(),
      ).toEqual({ version: latestBackendNormalizedVersion });
      expect(
        value.database
          .prepare(
            `SELECT pinned, pin_revision AS pinRevision
             FROM thread_principal_state
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .get(value.scope.tenantId, value.scope.principalId, thread.id),
      ).toEqual({ pinned: 0, pinRevision: 0 });
      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_principal_state SET pinned = 2
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .run(value.scope.tenantId, value.scope.principalId, thread.id),
      ).toThrow();
      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_principal_state SET pin_revision = -1
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .run(value.scope.tenantId, value.scope.principalId, thread.id),
      ).toThrow();
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
      expect(value.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      value.database.close();
    }
  });
});
