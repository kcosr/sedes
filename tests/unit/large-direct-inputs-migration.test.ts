import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { DirectInputRepository } from "../../src/server/db/repositories/direct-input-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { largeDirectInputText } from "../support/large-direct-input.js";

describe("large direct-input storage migration", () => {
  it("keeps the deployed migration 133 checksum immutable", () => {
    const migration = backendNormalizedMigrations.find(migration => migration.version === 133)!;
    expect(createHash("sha256").update(migration.sql).digest("hex"))
      .toBe("43e5db02c7165ec0bf05db23d55c4e626c61d7950b9f16540345ff97a491c726");
  });

  it.each(["older database", "already deployed 133"])("preserves durable work and admission guards upgrading an %s", (path) => {
    const { database, scope } = savedAgentDatabase(132);
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.upsertWorkspace(scope, {
        id: randomUUID(), environmentId: environment.id, canonicalPath: "/tmp/large-direct-migration",
        displayName: "Large direct input", project: { kind: "new", name: "Large direct input" },
        available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
      });
      const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
      const bindings = new ConversationBindingRepository(database);
      const createThread = () => bindings.createUnboundThread(scope, { workspaceId: workspace.id,
        connectionProfileId: profile.id, title: "Migration input", now: 201 });
      const firstThread = createThread();
      const queueThread = createThread();
      const request = { mutationId: randomUUID(), origin: { clientId: randomUUID() }, text: "Original first input",
        runningPolicy: { mode: "queue" as const } };
      const attempts = new ConversationCreationRepository(database);
      const receipts = new DirectInputRepository(database);
      const attemptId = randomUUID();
      database.transaction(() => {
        attempts.prepare(scope, firstThread.id, { attemptId, mutationId: request.mutationId,
          expectedThreadRevision: inventory.getThread(scope, firstThread.id).thread.revision,
          creationKind: "first_input", sourceKind: "direct_input", initialInputText: request.text,
          initialAttachmentIds: [], backendCreationCorrelation: request.mutationId, origin: request.origin, now: 202 });
        receipts.record(scope, firstThread.id, request, { admittedMode: "submit", creationAttemptId: attemptId, now: 202 });
      })();
      const queuedId = randomUUID();
      const queueRequest = { ...request, mutationId: randomUUID(), text: "Original queued input" };
      database.transaction(() => {
        database.prepare(`INSERT INTO queued_inputs (tenant_id, owner_principal_id, id, application_thread_id,
          sequence, mutation_id, text, state, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 'pending', 202)`)
          .run(scope.tenantId, scope.principalId, queuedId, queueThread.id, queueRequest.mutationId, queueRequest.text);
        receipts.record(scope, queueThread.id, queueRequest, { admittedMode: "queue", queuedInputId: queuedId, now: 202 });
      })();
      const objects = () => database.prepare(`SELECT name, type, sql FROM sqlite_schema
        WHERE tbl_name IN ('conversation_creation_attempts', 'queued_inputs') AND type IN ('trigger', 'index')
          AND sql IS NOT NULL ORDER BY type, name`).all();
      const rows = () => ({ attempts: database.prepare("SELECT * FROM conversation_creation_attempts").all(),
        queue: database.prepare("SELECT * FROM queued_inputs").all(),
        receipts: database.prepare("SELECT * FROM direct_input_receipts").all() });
      const beforeObjects = objects();
      const triggerOrder = () => database.prepare(`SELECT tbl_name, name FROM sqlite_schema
        WHERE tbl_name IN ('conversation_creation_attempts', 'queued_inputs') AND type = 'trigger'
        ORDER BY tbl_name, rowid`).all();
      const beforeTriggerOrder = triggerOrder();
      const beforeRows = rows();
      const beforeReceipts = [receipts.lookup(scope, request.mutationId), receipts.lookup(scope, queueRequest.mutationId)];
      const foreignKeys = () => [database.pragma("foreign_key_list(conversation_creation_attempts)"), database.pragma("foreign_key_list(queued_inputs)")];
      const beforeForeignKeys = foreignKeys();
      expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations, {
        verifyBeforeCommit: (_database, migration) => { if (migration.version === 133) throw new Error("test_upgrade_rollback"); },
      })).toThrow("test_upgrade_rollback");
      expect(rows()).toEqual(beforeRows);
      expect(objects()).toEqual(beforeObjects);
      expect(triggerOrder()).toEqual(beforeTriggerOrder);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      if (path === "already deployed 133") {
        applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= 133));
        const applied = database.prepare("SELECT * FROM schema_migrations WHERE version = 133").get();
        expect(applied).toMatchObject({ checksum: "43e5db02c7165ec0bf05db23d55c4e626c61d7950b9f16540345ff97a491c726" });
        const originalOrder = triggerOrder();
        expect(originalOrder).not.toEqual(beforeTriggerOrder);
        expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations, {
          verifyBeforeCommit: (_database, migration) => { if (migration.version === 134) throw new Error("test_order_rollback"); },
        })).toThrow("test_order_rollback");
        expect(triggerOrder()).toEqual(originalOrder);
        expect(rows()).toEqual(beforeRows);
        expect(objects()).toEqual(beforeObjects);
        expect(database.prepare("SELECT * FROM schema_migrations WHERE version = 133").get()).toEqual(applied);
        expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 134").get()).toBeUndefined();
      }
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(objects()).toEqual(beforeObjects);
      expect(triggerOrder()).toEqual(beforeTriggerOrder);
      expect(foreignKeys()).toEqual(beforeForeignKeys);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(rows()).toEqual(beforeRows);
      expect([receipts.lookup(scope, request.mutationId), receipts.lookup(scope, queueRequest.mutationId)]).toEqual(beforeReceipts);
      const updateFirst = database.prepare("UPDATE conversation_creation_attempts SET initial_input_text = ? WHERE attempt_id = ?");
      const updateQueue = database.prepare("UPDATE queued_inputs SET text = ? WHERE id = ?");
      expect(Buffer.byteLength(largeDirectInputText)).toBe(262_144);
      updateFirst.run(largeDirectInputText, attemptId);
      updateQueue.run(largeDirectInputText, queuedId);
      expect(() => updateFirst.run(largeDirectInputText + "x", attemptId)).toThrow(/CHECK constraint/u);
      expect(() => updateQueue.run(largeDirectInputText + "x", queuedId)).toThrow(/CHECK constraint/u);
      expect(() => new QueuedInputRepository(database).enqueue(scope, queueThread.id, {
        mutationId: randomUUID(), text: "é".repeat(32_768) + "x", contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "composer", expectedThreadRevision: 0, expectedDraftRevision: 0,
          requestedDeliveryMode: "queue", resolvedDeliveryMode: "queue" }, now: 203,
      })).toThrow("Queued input exceeds the text byte limit.");
      expect(() => database.prepare(`UPDATE conversation_creation_attempts
        SET source_kind = 'composer', consumed_draft_revision = 1 WHERE attempt_id = ?`).run(attemptId)).toThrow(/CHECK constraint/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { database.close(); }
  });
});
