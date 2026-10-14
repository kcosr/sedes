import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("page response input origin migration", () => {
  it("renames retained question provenance transactionally without losing queue data or integrity", () => {
    const { database, scope } = savedAgentDatabase(144);
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.upsertWorkspace(scope, {
        id: randomUUID(), environmentId: environment.id, canonicalPath: "/tmp/page-response-migration",
        displayName: "Page responses", project: { kind: "new", name: "Page responses" },
        available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
      });
      const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
      const bindings = new ConversationBindingRepository(database);
      const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id,
        connectionProfileId: profile.id, title: "Retained replies", now: 201 });
      bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: randomUUID(), now: 202 });
      const origin = { kind: "question_response", requestId: "question-request", sourceItemId: "question-source",
        answers: [{ questionIndex: 0, question: "Proceed?", answer: "Yes" }] };
      database.prepare(`INSERT INTO queued_inputs (tenant_id, owner_principal_id, id, application_thread_id,
        sequence, mutation_id, text, state, created_at, is_user_input, question_response_origin_json)
        VALUES (?, ?, 'question-input', ?, 1, 'question-operation', 'Exact old reply', 'pending', 203, 1, ?)`)
        .run(scope.tenantId, scope.principalId, thread.id, JSON.stringify(origin));
      const before = database.prepare("SELECT * FROM queued_inputs").get() as Record<string, unknown>;
      const triggerOrder = () => database.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = 'queued_inputs' AND type = 'trigger' ORDER BY rowid").all();
      const beforeTriggers = triggerOrder();
      expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations, {
        verifyBeforeCommit: (_database, migration) => { if (migration.version === 145) throw new Error("migration_rollback"); },
      })).toThrow("migration_rollback");
      expect(database.prepare("SELECT * FROM queued_inputs").get()).toEqual(before);
      expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 145").get()).toBeUndefined();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const { question_response_origin_json: retainedOrigin, ...rest } = before;
      expect(database.prepare("SELECT * FROM queued_inputs").get()).toEqual({ ...rest, input_origin_json: retainedOrigin });
      expect(() => database.prepare("SELECT question_response_origin_json FROM queued_inputs")).toThrow("no such column");
      expect(triggerOrder()).toEqual(beforeTriggers);
      expect(new QueuedInputRepository(database).get(scope, thread.id, "question-input"))
        .toMatchObject({ text: "Exact old reply", inputOrigin: origin, isUserInput: 1 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { database.close(); }
  });
});
