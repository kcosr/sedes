import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadAppliedToolPolicySetRepository } from "../../src/server/db/repositories/thread-applied-tool-policy-set-repository.js";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture(latestVersion = 152, threadCount = 2) {
  const current = savedAgentDatabase(125);
  const inventory = new InventoryRepository(current.database);
  const environment = inventory.getLocalEnvironment(current.scope);
  const workspace = insertPreProjectWorkspace(current.database, current.scope, {
    environmentId: environment.id, canonicalPath: "/tmp/applied-tool-policies",
    displayName: "Applied tool policies", available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  const profile = current.database.prepare(`SELECT id FROM agent_connection_profiles
    WHERE tenant_id=? AND owner_principal_id=? LIMIT 1`)
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(current.database);
  const threads = Array.from({ length: threadCount }, (_, index) => bindings.createUnboundThread(current.scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title: `Thread ${index}`, now: 120,
  }));
  applyDatabaseMigrations(current.database, backendNormalizedMigrations.filter(migration => migration.version <= latestVersion));
  return { ...current, threads, associations: new ThreadAppliedToolPolicySetRepository(current.database) };
}

const definition = {
  name: "Everyday", enabledToolIds: ["thread.list", "task.list"],
  resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
};
const metadata = { id: "11111111-1111-4111-8111-111111111111", name: "Everyday", revision: 3 };

describe("current applied thread tool policy sets", () => {
  it("requires a transaction and replaces or clears the current association", () => {
    const current = fixture();
    try {
      const { database, scope, threads: [source], associations } = current;
      const threadId = source!.id;
      expect(associations.get(scope, threadId)).toBeNull();
      expect(() => associations.set(scope, threadId, metadata, 130)).toThrow(/outside_transaction/);
      expect(() => associations.clear(scope, threadId)).toThrow(/outside_transaction/);
      database.transaction(() => {
        expect(associations.set(scope, threadId, metadata, 130)).toEqual(metadata);
        const replacement = { ...metadata, name: "Reviewer", revision: 4 };
        expect(associations.set(scope, threadId, replacement, 140)).toEqual(replacement);
        expect(associations.get(scope, threadId)).toEqual(replacement);
        expect(associations.set(scope, threadId, null, 150)).toBeNull();
      })();
      expect(associations.get(scope, threadId)).toBeNull();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("preserves independent metadata after named-set edits and deletion", () => {
    const current = fixture();
    try {
      const { database, scope, threads: [source], associations } = current;
      const policies = new ToolPolicyRepository(database);
      const policy = policies.create(scope, definition, 130);
      const applied = { id: policy.id, name: policy.name, revision: policy.revision };
      database.transaction(() => associations.set(scope, source!.id, applied, 140))();
      policies.update(scope, policy.id, { ...definition, name: "Changed" }, 0, 150);
      policies.delete(scope, policy.id, 1);
      expect(associations.get(scope, source!.id)).toEqual(applied);
      database.transaction(() => associations.clear(scope, source!.id))();
      expect(associations.get(scope, source!.id)).toBeNull();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("denies wrong tenant/principal mutations and rolls back associations with their caller", () => {
    const current = fixture();
    try {
      const { database, scope, threads: [source, child], associations } = current;
      database.transaction(() => associations.set(scope, source!.id, metadata, 130))();
      for (const wrongScope of [{ ...scope, tenantId: "another-tenant" }, { ...scope, principalId: "another-principal" }]) {
        expect(associations.get(wrongScope, source!.id)).toBeNull();
        expect(() => database.transaction(() => associations.set(wrongScope, source!.id, metadata, 130))()).toThrow(/thread was not found/);
        expect(() => database.transaction(() => associations.clear(wrongScope, source!.id))()).toThrow(/thread was not found/);
      }
      expect(associations.get(scope, source!.id)).toEqual(metadata);
      database.transaction(() => associations.clear(scope, source!.id))();
      expect(() => database.transaction(() => {
        associations.set(scope, source!.id, metadata, 130);
        throw new Error("rollback marker");
      })()).toThrow("rollback marker");
      expect(associations.get(scope, source!.id)).toBeNull();
      expect(() => database.transaction(() => associations.set(scope, "missing-thread", metadata, 140))()).toThrow(/thread was not found/);
      database.transaction(() => associations.set(scope, child!.id, metadata, 150))();
      database.prepare("DELETE FROM thread_drafts WHERE tenant_id=? AND principal_id=? AND thread_id=?")
        .run(scope.tenantId, scope.principalId, child!.id);
      database.prepare("DELETE FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?")
        .run(scope.tenantId, scope.principalId, child!.id);
      database.prepare("DELETE FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?")
        .run(scope.tenantId, scope.principalId, child!.id);
      expect(associations.get(scope, child!.id)).toBeNull();
    } finally { current.database.close(); }
  });
});

describe("applied tool policy set migration", () => {
  it("retains only provably unchanged revision-zero named snapshots", () => {
    const current = fixture(151, 11);
    try {
      const { database, scope, threads, associations } = current;
      const policies = new ToolPolicyRepository(database);
      const stored = threads.map((thread, index) => {
        const policy = policies.create(scope, { ...definition, name: `Policy ${index}` }, 130);
        database.prepare(`UPDATE thread_agent_tool_policies SET enabled=1,allow_other_environments=0,allow_other_projects=1
          WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?`)
          .run(scope.tenantId, scope.principalId, thread.id);
        for (const toolId of definition.enabledToolIds) {
          database.prepare(`INSERT INTO thread_agent_tool_policy_entries(tenant_id,owner_principal_id,application_thread_id,tool_id)
            VALUES(?,?,?,?)`).run(scope.tenantId, scope.principalId, thread.id, toolId);
        }
        database.prepare(`INSERT INTO thread_tool_policy_origins(tenant_id,owner_principal_id,thread_id,source,
          policy_set_id,policy_set_name,policy_set_revision,created_at) VALUES(?,?,?,'account',?,?,?,140)`)
          .run(scope.tenantId, scope.principalId, thread.id, policy.id, policy.name, policy.revision);
        return policy;
      });
      const updateThread = (index: number, change: string) => database.prepare(`UPDATE thread_agent_tool_policies SET ${change}
        WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?`)
        .run(scope.tenantId, scope.principalId, threads[index]!.id);
      updateThread(1, "revision=1");
      updateThread(2, "allow_other_environments=1");
      updateThread(3, "enabled=0");
      database.prepare(`DELETE FROM thread_agent_tool_policy_entries WHERE tenant_id=? AND owner_principal_id=?
        AND application_thread_id=? AND tool_id='task.list'`).run(scope.tenantId, scope.principalId, threads[4]!.id);
      policies.update(scope, stored[5]!.id, definition, 0, 150);
      policies.delete(scope, stored[6]!.id, 0);
      database.prepare("UPDATE tool_policy_sets SET enabled_tool_ids_json=? WHERE id=?")
        .run(JSON.stringify(["thread.list", "thread.list"]), stored[7]!.id);
      database.prepare("UPDATE tool_policy_sets SET name='Renamed outside repository' WHERE id=?").run(stored[8]!.id);
      updateThread(9, "allow_other_projects=0");
      database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES(?,?,'local_human',100)")
        .run(scope.tenantId, "another-principal");
      database.prepare("UPDATE tool_policy_sets SET owner_principal_id='another-principal' WHERE id=?")
        .run(stored[10]!.id);

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(associations.get(scope, threads[0]!.id)).toEqual({ id: stored[0]!.id, name: stored[0]!.name, revision: 0 });
      for (const thread of threads.slice(1)) expect(associations.get(scope, thread.id)).toBeNull();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name='thread_tool_policy_origins'").get()).toBeUndefined();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("leaves pre-existing Custom policies without an association", () => {
    const current = fixture(151);
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      for (const thread of current.threads) expect(current.associations.get(current.scope, thread.id)).toBeNull();
    } finally { current.database.close(); }
  });
});
