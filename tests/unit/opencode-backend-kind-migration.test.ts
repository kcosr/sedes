import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("OpenCode v2 identity migration", () => {
  it("upgrades schema 121 so a new OpenCode thread has a readable Native/Progressive tool policy", () => {
    const { database, scope } = savedAgentDatabase(121);
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = insertPreProjectWorkspace(database, scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/opencode-policy-migration",
        displayName: "OpenCode policy migration",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 150,
      });
      const bindings = new ConversationBindingRepository(database);
      const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
      const existing = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: profile.id,
        title: "Existing Pi thread", now: 160,
      });
      // Read schema-121 rows through their historical contract. The current
      // repository reads the resource-scope columns introduced by migration 148.
      const historicalPolicy = (threadId: string) => ({
        policy: database.prepare("SELECT * FROM thread_agent_tool_policies WHERE application_thread_id=?").get(threadId),
        entries: database.prepare("SELECT * FROM thread_agent_tool_policy_entries WHERE application_thread_id=? ORDER BY tool_id").all(threadId),
      });
      const existingPolicy = historicalPolicy(existing.id);
      const applied = database.prepare("SELECT * FROM schema_migrations WHERE version <= 121 ORDER BY version").all();

      applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= 122));
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 121 ORDER BY version").all()).toEqual(applied);
      expect(historicalPolicy(existing.id)).toEqual(existingPolicy);
      database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id,owner_principal_id,id,kind,label,enabled,protocol_release,created_at,updated_at)
        VALUES (?,?,'opencode-v2','opencode','OpenCode v2',1,'2.0.18',200,200)`)
        .run(scope.tenantId, scope.principalId);
      database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,created_at,updated_at)
        VALUES (?,?,'opencode-profile','opencode-template','opencode-v2','opencode',?,'opencode_http','OpenCode',1,200,200)`)
        .run(scope.tenantId, scope.principalId, environment.id);
      const thread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: "opencode-profile",
        title: "OpenCode thread", now: 210,
      });

      expect(historicalPolicy(thread.id)).toMatchObject({
        policy: { enabled: 0, presentation_surface: "native", presentation_mode: "progressive",
          access_boundary: "environment", revision: 0, updated_at: 210 },
        entries: [],
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const policies = new ThreadAgentToolPolicyRepository(
        database, createThreadAgentToolPolicyDependencies().eligibility,
      );
      expect(policies.get(scope, existing.id)).toMatchObject({
        enabled: false, presentation: { surface: "native", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        revision: 0, updatedAt: 160, enabledToolIds: [],
      });

      expect(policies.get(scope, thread.id)).toEqual({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: thread.id,
        enabled: false,
        presentation: { surface: "native", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        revision: 0,
        updatedAt: 210,
        enabledToolIds: [],
        policySet: null,
      });
      const currentThread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: "opencode-profile",
        title: "Current OpenCode thread", now: 220,
      });
      expect(policies.get(scope, currentThread.id)).toMatchObject({
        enabled: false, presentation: { surface: "native", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
        revision: 0, updatedAt: 220, enabledToolIds: [],
      });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("preserves existing identities and principal ownership guards while admitting only matching v2 kinds", () => {
    const { database, scope } = savedAgentDatabase(119);
    try {
      const backends = database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all();
      const profiles = database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all()).toEqual(backends);
      expect(database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all()).toEqual(profiles);
      const insert = database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id,owner_principal_id,id,kind,label,enabled,protocol_release,created_at,updated_at)
        VALUES (?,?,'opencode-v2','opencode','OpenCode v2',1,'2.0.18',200,200)`);
      expect(() => insert.run(scope.tenantId, null)).toThrow("backend_principal_required");
      insert.run(scope.tenantId, scope.principalId);
      expect(() => database.prepare("UPDATE agent_backend_instances SET owner_principal_id = NULL WHERE id = 'opencode-v2'").run()).toThrow("backend_principal_immutable");
      const profile = database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,created_at,updated_at)
        SELECT tenant_id,owner_principal_id,'opencode-profile','opencode-template','opencode-v2','opencode',execution_environment_id,?,'OpenCode',1,200,200 FROM agent_connection_profiles LIMIT 1`);
      expect(() => profile.run("pi_sdk")).toThrow();
      profile.run("opencode_http");
      expect(() => database.prepare("UPDATE agent_connection_profiles SET owner_principal_id='other' WHERE id='opencode-profile'").run()).toThrow("backend_principal_mismatch");
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(() => database.prepare("DELETE FROM principals WHERE tenant_id=? AND id=?").run(scope.tenantId, scope.principalId)).toThrow("backend_principal_still_referenced");
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { database.close(); }
  });
});
