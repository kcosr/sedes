import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("thread Saved Agent origins migration", () => {
  it("preserves immutable captured provenance after its Agent is deleted", () => {
    const current = savedAgentDatabase(74);
    try {
      const inventory = new InventoryRepository(current.database);
      const environment = inventory.getLocalEnvironment(current.scope);
      const workspace = inventory.upsertWorkspace(current.scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/thread-agent-origin",
        displayName: "Thread origin",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 110,
      });
      const profile = current.database
        .prepare(
          `SELECT id FROM agent_connection_profiles
           WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY id LIMIT 1`,
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        readonly id: string;
      };
      const thread = new ConversationBindingRepository(
        current.database,
      ).createUnboundThread(current.scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Captured origin",
        now: 120,
      });
      const agent = {
        id: "99999999-9999-4999-8999-999999999999",
        name: "Careful Agent",
        revision: 0,
      } as const;
      current.database
        .prepare(
          `INSERT INTO saved_agents(
             tenant_id, owner_principal_id, id, name, description,
             backend_type_id, backend_overrides_schema_version,
             backend_overrides_json, harness_tools_json, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, '', 'test-agent', 1, '[]', NULL, 0, 130, 130)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          agent.id,
          agent.name,
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const agents = new SavedAgentRepository(current.database);
      current.database
        .prepare(
          `INSERT INTO thread_saved_agent_origins(
             tenant_id, owner_principal_id, thread_id, agent_id,
             agent_revision, agent_name, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          thread.id,
          agent.id,
          agent.revision,
          agent.name,
          140,
        );

      expect(() =>
        current.database
          .prepare(
            `UPDATE thread_saved_agent_origins SET agent_name = 'Changed'
             WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?`,
          )
          .run(current.scope.tenantId, current.scope.principalId, thread.id),
      ).toThrow(/immutable/i);

      agents.delete(current.scope, agent.id, {
        expectedRevision: agent.revision,
      });
      expect(
        current.database
          .prepare(
            `SELECT agent_id AS agentId, agent_revision AS revision,
              agent_name AS name
             FROM thread_saved_agent_origins
             WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?`,
          )
          .get(current.scope.tenantId, current.scope.principalId, thread.id),
      ).toEqual({ agentId: agent.id, revision: 0, name: "Careful Agent" });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
