import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

it("adds optional Claude diagnostics without changing existing terminal evidence", () => {
  const { database, scope } = savedAgentDatabase(108);
  try {
    const inventory = new InventoryRepository(database);
    const environment = inventory.getLocalEnvironment(scope);
    const workspace = inventory.upsertWorkspace(scope, {
      environmentId: environment.id, canonicalPath: "/tmp/failure-migration",
      displayName: "Migration", available: true, trustState: "trusted",
      environmentConfigurationRevision: environment.configurationRevision, now: 110,
    });
    const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
    const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
      workspaceId: workspace.id, connectionProfileId: profile.id, title: "Migration", now: 120,
    });
    database.prepare(`INSERT INTO claude_turn_terminal_receipts
      (tenant_id, owner_principal_id, application_thread_id, backend_turn_id,
       status, terminal_at, created_at, updated_at)
      VALUES (?, ?, ?, 'turn', 'failed', 1, 1, 1)`).run(scope.tenantId, scope.principalId, thread.id);
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    expect(database.prepare(`SELECT status, failure_message FROM claude_turn_terminal_receipts`).get())
      .toEqual({ status: "failed", failure_message: null });
    database.prepare(`UPDATE claude_turn_terminal_receipts SET failure_message = 'Bad model'`).run();
    expect(() => database.prepare(`UPDATE claude_turn_terminal_receipts SET status = 'completed'`).run()).toThrow();
  } finally { database.close(); }
});
