import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const databases: ReturnType<typeof savedAgentDatabase>["database"][] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const { database, scope } = savedAgentDatabase(172);
  databases.push(database);
  const inventory = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  const settings = new ClaudeThreadRepository(database);
  const operations = new ConversationOperationRepository(database);
  const owner = [scope.tenantId, scope.principalId] as const;
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id, canonicalPath: "/tmp/claude-manual-titles", displayName: "Claude titles",
    project: { kind: "new", name: "Claude titles" }, available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  const pi = database.prepare("SELECT id FROM agent_connection_profiles WHERE kind = 'pi_sdk'").get() as { id: string };
  const target = { backendInstanceId: "claude", connectionProfileId: "claude-local", executionEnvironmentId: environment.id };
  database.prepare(`INSERT INTO agent_backend_instances
    (tenant_id, owner_principal_id, id, kind, label, enabled, protocol_release, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude_agent_sdk', 'Claude', 1, '0.3.319', 100, 100)`).run(...owner);
  database.prepare(`INSERT INTO agent_connection_profiles
    (tenant_id, owner_principal_id, id, template_id, backend_instance_id, backend_kind, execution_environment_id,
     kind, label, enabled, created_at, updated_at)
    VALUES (?, ?, 'claude-local', 'claude-local', 'claude', 'claude_agent_sdk', ?, 'claude_agent_sdk', 'Claude', 1, 100, 100)`)
    .run(...owner, environment.id);

  function create(title: string, connectionProfileId = target.connectionProfileId) {
    const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId, title, now: 120 });
    if (connectionProfileId === target.connectionProfileId) {
      settings.initialize(scope, thread.id, target, { model: null, effort: null, permissionMode: null }, 120);
    }
    return thread.id;
  }
  const read = (id: string) => inventory.getThread(scope, id).thread;
  const draftRename = (id: string, title: string, now: number) => inventory.renameThread(scope, id, {
    title, expectedRevision: read(id).revision, mutationId: randomUUID(), now,
  });
  function nativeReceipt(id: string, title: string, now: number, accepted: boolean) {
    const mutationId = randomUUID();
    operations.prepareBackendAction(scope, id, {
      mutationId, expectedThreadRevision: read(id).revision, operation: { action: "rename", title }, now,
    });
    operations.markBackendActionStarted(scope, mutationId);
    if (accepted) operations.acceptBackendAction(scope, mutationId);
    return mutationId;
  }
  const override = (id: string) => database.prepare(`SELECT local_title_override FROM claude_thread_settings
    WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?`).pluck().get(...owner, id);
  const generation = () => database.prepare(`SELECT inventory_generation FROM principal_generations
    WHERE tenant_id = ? AND principal_id = ?`).pluck().get(...owner) as number;
  const migrate = () => applyDatabaseMigrations(database, backendNormalizedMigrations.filter(({ version }) => version <= 173));
  return { database, scope, owner, inventory, bindings, pi, create, read, draftRename, nativeReceipt, override, generation, migrate };
}

it("restores each Claude thread's latest successful rename and preserves unrelated inventory", () => {
  const f = fixture();
  const bound = f.create("Initial title");
  f.draftRename(bound, "Draft name", 130);
  f.bindings.bindDiscoveredConversation(f.scope, bound, { backendConversationId: randomUUID(), now: 140 });
  f.nativeReceipt(bound, "First bound name", 150, true);
  f.nativeReceipt(bound, "Final bound name", 150, true);
  f.nativeReceipt(bound, "Unconfirmed name", 160, false);
  f.inventory.markDiscoveredAvailable(f.scope, bound, { title: "Generated name", now: 170, updatedAt: 170 });

  const draft = f.create("Draft");
  f.draftRename(draft, "Draft name to retain", 130);
  const untouched = f.create("Generated");
  f.bindings.bindDiscoveredConversation(f.scope, untouched, { backendConversationId: randomUUID(), now: 135 });
  f.nativeReceipt(untouched, "Superseded title", 140, true);
  f.nativeReceipt(untouched, "Unconfirmed only", 150, false);
  const missingTitle = f.nativeReceipt(untouched, "No retained title", 160, true);
  f.database.prepare("UPDATE mutation_receipts SET result_json = '{}' WHERE mutation_id = ?").run(missingTitle);
  const pi = f.create("Other backend", f.pi.id);
  // Settings have a foreign key to the exact target but no CHECK on its backend kind.
  f.database.prepare(`INSERT INTO claude_thread_settings(tenant_id, owner_principal_id, application_thread_id,
    backend_instance_id, connection_profile_id, execution_environment_id, effective_model_state,
    effective_effort_state, effective_permission_state, revision, created_at, updated_at)
    SELECT tenant_id, owner_principal_id, id, backend_instance_id, connection_profile_id, environment_id,
      'unconfirmed', 'unconfirmed', 'unconfirmed', 0, created_at, updated_at FROM application_threads
    WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).run(...f.owner, pi);
  f.draftRename(pi, "Pi rename", 130);
  f.bindings.bindDiscoveredConversation(f.scope, pi, { backendConversationId: randomUUID(), now: 140 });
  f.inventory.markDiscoveredAvailable(f.scope, pi, { title: "Pi native title", now: 170, updatedAt: 170 });
  const [boundBefore, draftBefore, untouchedBefore, piBefore] = [f.read(bound), f.read(draft), f.read(untouched), f.read(pi)];
  const generation = f.generation();

  f.migrate();

  expect(f.read(bound)).toMatchObject({ title: "Final bound name", revision: boundBefore.revision + 1,
    lastActivityAt: boundBefore.lastActivityAt });
  expect(f.read(draft)).toEqual(draftBefore);
  expect(f.read(untouched)).toEqual(untouchedBefore);
  expect(f.read(pi)).toEqual(piBefore);
  expect([f.override(bound), f.override(draft), f.override(untouched), f.override(pi)]).toEqual([1, 1, 0, 0]);
  expect(f.generation()).toBe(generation + 1);
  f.migrate();
  expect(f.generation()).toBe(generation + 1);
  expect(f.database.pragma("foreign_key_check")).toEqual([]);
});

it("rolls back a draft rename if its Claude settings row is missing", () => {
  const f = fixture();
  const id = f.create("Draft");
  f.migrate();
  f.database.prepare(`DELETE FROM claude_thread_settings
    WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?`).run(...f.owner, id);
  const before = f.read(id);
  const generation = f.generation();
  expect(() => f.draftRename(id, "Rename", 150)).toThrow("claude_thread_settings_missing");
  expect(f.read(id)).toEqual(before);
  expect(f.generation()).toBe(generation);
});
