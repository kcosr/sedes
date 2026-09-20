import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture() {
  const current = savedAgentDatabase(90);
  const inventory = new InventoryRepository(current.database);
  const environment = inventory.getLocalEnvironment(current.scope);
  const workspace = inventory.upsertWorkspace(current.scope, {
    environmentId: environment.id, canonicalPath: "/tmp/access-boundary", displayName: "Boundary",
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  const profile = current.database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const createThread = () => new ConversationBindingRepository(current.database).createUnboundThread(current.scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title: "Boundary", now: 120,
  });
  return { ...current, createThread };
}

function legacyPolicy(otherEnvironments: "ask" | "allow") {
  return { enabled: true, enabledToolIds: ["agent.context"], presentation: { surface: "native", mode: "progressive" }, environmentAccess: { otherEnvironments } };
}

function insertAgent(current: ReturnType<typeof fixture>, id: string, policy: unknown) {
  current.database.prepare(`INSERT INTO saved_agents(
    tenant_id, owner_principal_id, id, name, description, backend_type_id,
    backend_overrides_schema_version, backend_overrides_json, sedes_tools_json,
    revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, '', 'pi', 1, '[]', ?, 7, 130, 140)`).run(
    current.scope.tenantId, current.scope.principalId, id, id, JSON.stringify(policy),
  );
}

describe("agent tool access boundary migration", () => {
  it("maps both existing boundaries, preserves policy entries and revisions, and defaults new threads to environment", () => {
    const current = fixture();
    try {
      const threads = [current.createThread(), current.createThread()];
      for (const [index, oldValue] of (["ask", "allow"] as const).entries()) {
        current.database.prepare("UPDATE thread_agent_tool_policies SET other_environment_access = ?, revision = 4 WHERE application_thread_id = ?").run(oldValue, threads[index]!.id);
        current.database.prepare("INSERT INTO thread_agent_tool_policy_entries VALUES (?, ?, ?, 'agent.context')").run(current.scope.tenantId, current.scope.principalId, threads[index]!.id);
        insertAgent(current, `99999999-9999-4999-8999-99999999999${index}`, legacyPolicy(oldValue));
      }
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      for (const [index, boundary] of (["environment", "unrestricted"] as const).entries()) {
        expect(current.database.prepare("SELECT access_boundary, revision FROM thread_agent_tool_policies WHERE application_thread_id = ?").get(threads[index]!.id)).toEqual({ access_boundary: boundary, revision: 4 });
        const agent = new SavedAgentRepository(current.database).get(current.scope, `99999999-9999-4999-8999-99999999999${index}`);
        expect(agent.sedesTools).toEqual({ enabled: true, enabledToolIds: ["agent.context"], presentation: { surface: "native", mode: "progressive" }, accessBoundary: boundary });
        expect(agent.revision).toBe(7);
      }
      expect(current.database.prepare("SELECT count(*) AS count FROM thread_agent_tool_policy_entries").get()).toEqual({ count: 2 });
      const thread = current.createThread();
      expect(current.database.prepare("SELECT access_boundary FROM thread_agent_tool_policies WHERE application_thread_id = ?").get(thread.id)).toEqual({ access_boundary: "environment" });
      current.database.prepare("UPDATE thread_agent_tool_policies SET access_boundary = 'thread' WHERE application_thread_id = ?").run(thread.id);
      expect(() => current.database.prepare("UPDATE thread_agent_tool_policies SET access_boundary = 'ask'").run()).toThrow();
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("fails atomically on malformed durable policy JSON", () => {
    const current = fixture();
    try {
      insertAgent(current, "99999999-9999-4999-8999-999999999990", legacyPolicy("ask"));
      insertAgent(current, "99999999-9999-4999-8999-999999999991", { ...legacyPolicy("allow"), unexpected: true });
      expect(() => applyDatabaseMigrations(current.database, backendNormalizedMigrations)).toThrow();
      expect(current.database.prepare("SELECT sedes_tools_json AS policy FROM saved_agents WHERE id = '99999999-9999-4999-8999-999999999990'").get()).toEqual({ policy: JSON.stringify(legacyPolicy("ask")) });
      expect(current.database.prepare("SELECT name FROM pragma_table_info('thread_agent_tool_policies') WHERE name = 'other_environment_access'").get()).toBeDefined();
    } finally { current.database.close(); }
  });
});
