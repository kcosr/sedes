import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

it("upgrades deployed usage accounting while preserving historical session gaps", () => {
  // This checksum was already deployed. Editing migration 110 prevents upgrades.
  expect(createHash("sha256").update(durableUsageAccountingMigration.sql).digest("hex"))
    .toBe("75139f91af158ee7315f269f751c1dd73015062a652460463f8d0ef6213ead61");
  const { database, scope } = savedAgentDatabase(110);
  try {
    const inventory = new InventoryRepository(database);
    const environment = inventory.getLocalEnvironment(scope);
    const workspace = inventory.upsertWorkspace(scope, {
      environmentId: environment.id, canonicalPath: "/tmp/usage-migration",
      displayName: "Migration", available: true, trustState: "trusted",
      environmentConfigurationRevision: environment.configurationRevision, now: 110,
    });
    const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
    const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
      workspaceId: workspace.id, connectionProfileId: profile.id, title: "Migration", now: 120,
    });
    database.prepare("INSERT INTO usage_thread_state(tenant_id, principal_id, thread_id) VALUES (?, ?, ?)")
      .run(scope.tenantId, scope.principalId, thread.id);
    database.prepare(`INSERT INTO usage_sources
      (id, tenant_id, principal_id, thread_id, backend_id, environment_id, workspace_id,
       native_namespace, native_session, epoch, normalization_version, baseline, capture_state)
      VALUES ('source', ?, ?, ?, 'pi-primary', ?, ?, 'store', 'session', 'epoch', 'v1', 'unknown', 'idle')`)
      .run(scope.tenantId, scope.principalId, thread.id, environment.id, workspace.id);
    database.prepare(`INSERT INTO usage_gaps(source_id, reason, subject, recorded_at)
      VALUES ('source', 'capture_gap', 'historical', '2026-09-21T00:00:00Z')`).run();

    applyDatabaseMigrations(database, backendNormalizedMigrations);
    expect(database.prepare("SELECT * FROM usage_gaps").get()).toEqual({
      source_id: "source", reason: "capture_gap", subject: "historical",
      recorded_at: "2026-09-21T00:00:00Z", affects_session: 1,
    });
    database.prepare(`INSERT INTO usage_gaps(source_id, reason, subject, recorded_at, affects_session)
      VALUES ('source', 'conflict', 'turn-only', '2026-09-21T00:00:01Z', 0)`).run();
    expect(database.prepare("SELECT affects_session FROM usage_gaps WHERE subject = 'turn-only'").get())
      .toEqual({ affects_session: 0 });
    expect(() => database.prepare("UPDATE usage_gaps SET affects_session = 2").run()).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations)).not.toThrow();
  } finally {
    database.close();
  }
});
