import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const databases: ReturnType<typeof savedAgentDatabase>["database"][] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const { database, scope } = savedAgentDatabase(161);
  databases.push(database);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    id: randomUUID(),
    environmentId: environment.id,
    canonicalPath: "/tmp/claude-desired-settings-migration",
    displayName: "Claude settings",
    project: { kind: "new", name: "Claude settings" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 200,
  });
  const profile = database.prepare(`SELECT id, backend_instance_id AS backendInstanceId
    FROM agent_connection_profiles LIMIT 1`).get() as { id: string; backendInstanceId: string };
  const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title: "Claude settings",
    now: 201,
  });
  const target = {
    backendInstanceId: profile.backendInstanceId,
    connectionProfileId: profile.id,
    executionEnvironmentId: environment.id,
  };
  const insertLegacySettings = (revision = 12) => database.prepare(`
    INSERT INTO claude_thread_settings (
      tenant_id, owner_principal_id, application_thread_id,
      backend_instance_id, connection_profile_id, execution_environment_id,
      desired_model, desired_effort, desired_permission_mode,
      effective_model, effective_model_state, effective_model_generation,
      effective_effort, effective_effort_state, effective_effort_generation,
      effective_permission_mode, effective_permission_classification,
      effective_permission_state, effective_permission_generation,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?,
      'claude-sonnet-5', 'high', 'acceptEdits',
      'claude-haiku-4-5', 'confirmed', 3,
      'medium', 'confirmed', 3,
      'default', 'recognized', 'confirmed', 3,
      ?, 202, 220)
  `).run(scope.tenantId, scope.principalId, thread.id,
    target.backendInstanceId, target.connectionProfileId, target.executionEnvironmentId, revision);
  return { database, scope, thread, target, insertLegacySettings };
}

describe("Claude desired settings revision migration", () => {
  it("preserves existing settings and seeds an independent revision that runtime evidence cannot advance", () => {
    const { database, scope, thread, insertLegacySettings } = fixture();
    insertLegacySettings();
    const before = database.prepare("SELECT * FROM claude_thread_settings").get();

    applyDatabaseMigrations(database, backendNormalizedMigrations);

    expect(database.prepare("SELECT * FROM claude_thread_settings").get())
      .toEqual({ ...before as Record<string, unknown>, desired_revision: 12 });
    const settings = new ClaudeThreadRepository(database);
    expect(settings.get(scope, thread.id)).toMatchObject({ revision: 12, desiredRevision: 12 });
    settings.markEffectiveUnknown(scope, thread.id, { expectedRevision: 12, now: 221 });
    settings.confirmEffectiveModel(scope, thread.id, {
      expectedRevision: 13, model: "claude-sonnet-5", queryGeneration: 4, now: 222,
    });
    settings.confirmEffectiveEffort(scope, thread.id, {
      expectedRevision: 14, effort: "high", queryGeneration: 4, now: 223,
    });
    settings.confirmEffectivePermissionMode(scope, thread.id, {
      expectedRevision: 15, permissionMode: "acceptEdits", classification: "recognized",
      queryGeneration: 4, now: 224,
    });
    expect(settings.get(scope, thread.id)).toMatchObject({
      model: "claude-sonnet-5", effort: "high", permissionMode: "acceptEdits",
      revision: 16, desiredRevision: 12,
    });

    const confirmed = settings.get(scope, thread.id);
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    expect(settings.get(scope, thread.id)).toEqual(confirmed);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("initializes new rows at zero and rejects malformed desired revisions", () => {
    const { database, scope, thread, target } = fixture();
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    const settings = new ClaudeThreadRepository(database);
    const initialized = settings.initialize(scope, thread.id, target, {
      model: "claude-sonnet-5", effort: "high", permissionMode: "acceptEdits",
    }, 202);
    expect(initialized).toMatchObject({ revision: 0, desiredRevision: 0 });

    const update = database.prepare(`UPDATE claude_thread_settings SET desired_revision = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?`);
    for (const invalid of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "invalid"]) {
      expect(() => update.run(invalid, scope.tenantId, scope.principalId, thread.id)).toThrow();
      expect(settings.get(scope, thread.id)).toEqual(initialized);
    }
  });

  it("rolls back an upgrade with an out-of-range legacy revision", () => {
    const { database, insertLegacySettings } = fixture();
    insertLegacySettings(Number.MAX_SAFE_INTEGER + 1);
    const before = database.prepare("SELECT * FROM claude_thread_settings").get();

    expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations))
      .toThrow(/CHECK constraint failed/u);

    expect(database.prepare("SELECT * FROM claude_thread_settings").get()).toEqual(before);
    expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 162").get()).toBeUndefined();
    expect(() => database.prepare("SELECT desired_revision FROM claude_thread_settings"))
      .toThrow("no such column");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });
});
