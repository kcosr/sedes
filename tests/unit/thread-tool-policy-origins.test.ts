import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadToolPolicyOriginRepository } from "../../src/server/db/repositories/thread-tool-policy-origin-repository.js";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture() {
  const current = savedAgentDatabase(125);
  const inventory = new InventoryRepository(current.database);
  const environment = inventory.getLocalEnvironment(current.scope);
  const workspace = insertPreProjectWorkspace(current.database, current.scope, {
    environmentId: environment.id, canonicalPath: "/tmp/tool-policy-origins",
    displayName: "Tool policy origins", available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  const profile = current.database.prepare(`SELECT id FROM agent_connection_profiles
    WHERE tenant_id=? AND owner_principal_id=? LIMIT 1`)
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(current.database);
  const source = bindings.createUnboundThread(current.scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title: "Source", now: 120,
  });
  const child = bindings.createUnboundThread(current.scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title: "Copy", now: 120,
  });
  applyDatabaseMigrations(current.database, backendNormalizedMigrations);
  return { ...current, source, child, origins: new ThreadToolPolicyOriginRepository(current.database) };
}

describe("thread tool policy origins", () => {
  it("leaves pre-existing origins unknown and captures policy labels independently of mutable sets", () => {
    const current = fixture();
    try {
      const { database, scope, source, origins } = current;
      expect(origins.get(scope, source.id)).toBeNull();
      const policies = new ToolPolicyRepository(database);
      const definition = { name: "Everyday", enabledToolIds: ["thread.list"],
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } };
      const policy = policies.create(scope, definition, 130);
      const origin = { source: "account" as const,
        policySet: { id: policy.id, name: policy.name, revision: policy.revision } };
      expect(() => origins.record(scope, source.id, origin, 140)).toThrow(/outside_transaction/);
      database.transaction(() => origins.record(scope, source.id, origin, 140))();
      policies.update(scope, policy.id, { ...definition, name: "Changed", enabledToolIds: [] }, 0, 150);
      policies.delete(scope, policy.id, 1);
      expect(origins.get(scope, source.id)).toEqual(origin);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("keeps copies immutable and scoped while allowing thread deletion to cascade", () => {
    const current = fixture();
    try {
      const { database, scope, source, child, origins } = current;
      const origin = { source: "thread" as const,
        policySet: { id: "11111111-1111-4111-8111-111111111111", name: "Reviewer", revision: 3 } };
      database.transaction(() => {
        origins.record(scope, source.id, origin, 140);
        expect(origins.copy(scope, source.id, child.id, 150)).toEqual(origin);
      })();
      expect(origins.get(scope, child.id)).toEqual(origin);
      expect(origins.get({ ...scope, principalId: "another-principal" }, child.id)).toBeNull();
      expect(() => database.transaction(() => origins.copy(
        { ...scope, tenantId: "another-tenant" }, source.id, child.id, 160,
      ))()).toThrow(/source thread was not found/);
      expect(() => database.transaction(() => origins.record(scope, child.id, { source: "default" }, 160))())
        .toThrow(/already been captured/);
      expect(() => database.prepare("UPDATE thread_tool_policy_origins SET source='backend'").run())
        .toThrow(/immutable/);
      expect(() => database.prepare("DELETE FROM thread_tool_policy_origins").run()).toThrow(/immutable/);
      // Existing draft/principal machinery must be retired before a thread is deleted.
      database.prepare("DELETE FROM thread_drafts WHERE tenant_id=? AND principal_id=? AND thread_id=?")
        .run(scope.tenantId, scope.principalId, child.id);
      database.prepare("DELETE FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?")
        .run(scope.tenantId, scope.principalId, child.id);
      database.prepare("DELETE FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?")
        .run(scope.tenantId, scope.principalId, child.id);
      expect(origins.get(scope, child.id)).toBeNull();
      expect(origins.get(scope, source.id)).toEqual(origin);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("preserves an unknown origin when copying a pre-existing thread", () => {
    const current = fixture();
    try {
      current.database.transaction(() => {
        expect(current.origins.copy(current.scope, current.source.id, current.child.id, 150)).toBeNull();
      })();
      expect(current.origins.get(current.scope, current.child.id)).toBeNull();
    } finally { current.database.close(); }
  });
});
