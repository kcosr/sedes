import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { MAXIMUM_THREAD_INPUT_BYTES } from "../../src/shared/protocol/context-excerpts.js";
import { savedAgentDatabase, insertPreRootGrantWorkspace } from "../support/saved-agent-fixture.js";

describe("unified thread input limit migration", () => {
  it("preserves creation rows, indexes, trigger order and foreign keys, with transactional rollback", () => {
    const { database, scope } = savedAgentDatabase(143);
    // Test migration 144 in isolation: later migrations intentionally change
    // foreign keys outside conversation creation.
    const inputLimitMigrations = backendNormalizedMigrations.filter(
      (migration) => migration.version <= 144,
    );
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = insertPreRootGrantWorkspace(database, scope, {
        id: randomUUID(), environmentId: environment.id, canonicalPath: "/tmp/unified-input-migration",
        displayName: "Unified input", project: { kind: "new", name: "Unified input" },
        available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
      });
      const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
      const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: profile.id, title: "Composer migration", now: 201,
      });
      // Seed a composer capture using the columns written by schema 143.
      const attemptId = randomUUID();
      database.prepare(`INSERT INTO conversation_creation_attempts (
        tenant_id, owner_principal_id, application_thread_id, attempt_id, mutation_id, backend_instance_id,
        connection_profile_id, execution_environment_id, creation_kind, source_kind, initial_input_text,
        consumed_draft_revision, backend_creation_correlation, phase, prepared_at)
        SELECT tenant_id, owner_principal_id, id, ?, ?, backend_instance_id, connection_profile_id,
          environment_id, 'first_input', 'composer', 'Original draft', 2, ?, 'prepared', 203
        FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(attemptId, randomUUID(), randomUUID(), scope.tenantId, scope.principalId, thread.id);
      const rows = () => database.prepare("SELECT * FROM conversation_creation_attempts").all();
      const objects = () => database.prepare(`SELECT type, name, sql FROM sqlite_schema
        WHERE tbl_name = 'conversation_creation_attempts' AND type IN ('trigger', 'index')
          AND sql IS NOT NULL ORDER BY rowid`).all();
      const foreignKeys = () => database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        .map(row => ({ name: (row as { name: string }).name,
          keys: database.pragma(`foreign_key_list('${(row as { name: string }).name}')`) }));
      const beforeRows = rows();
      const beforeObjects = objects();
      const beforeForeignKeys = foreignKeys();
      const update = database.prepare("UPDATE conversation_creation_attempts SET initial_input_text = ? WHERE attempt_id = ?");
      const text = "é".repeat(MAXIMUM_THREAD_INPUT_BYTES / 2);
      expect(() => update.run(text, attemptId)).toThrow(/CHECK constraint/u);
      expect(() => applyDatabaseMigrations(database, inputLimitMigrations, {
        verifyBeforeCommit: (_database, migration) => { if (migration.version === 144) throw new Error("test_rollback"); },
      })).toThrow("test_rollback");
      expect(rows()).toEqual(beforeRows);
      expect(objects()).toEqual(beforeObjects);
      expect(foreignKeys()).toEqual(beforeForeignKeys);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 144").get()).toBeUndefined();
      applyDatabaseMigrations(database, inputLimitMigrations);
      expect(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: 144 });
      expect(rows()).toEqual(beforeRows);
      expect(objects()).toEqual(beforeObjects);
      expect(foreignKeys()).toEqual(beforeForeignKeys);
      expect(() => update.run(text, attemptId)).not.toThrow();
      expect(() => update.run(text + "x", attemptId)).toThrow(/CHECK constraint/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { database.close(); }
  });
});
