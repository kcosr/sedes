import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { MAXIMUM_THREAD_INPUT_BYTES } from "../../src/shared/protocol/context-excerpts.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("unified thread input limit migration", () => {
  it("preserves creation rows, indexes, trigger order and foreign keys, with transactional rollback", () => {
    const { database, scope } = savedAgentDatabase(143);
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.upsertWorkspace(scope, {
        id: randomUUID(), environmentId: environment.id, canonicalPath: "/tmp/unified-input-migration",
        displayName: "Unified input", project: { kind: "new", name: "Unified input" },
        available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
      });
      const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
      const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: profile.id, title: "Composer migration", now: 201,
      });
      const draft = inventory.saveDraft(scope, thread.id, {
        text: "Original draft", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: 0, now: 202,
      });
      const attempt = new ConversationCreationRepository(database).prepare(scope, thread.id, {
        attemptId: randomUUID(), mutationId: randomUUID(), expectedThreadRevision: 0,
        creationKind: "first_input", sourceKind: "composer", initialInputText: draft.text,
        initialContextExcerpts: [], initialAttachmentIds: [], initialTaskReferences: [],
        expectedDraftRevision: draft.revision, backendCreationCorrelation: randomUUID(), now: 203,
      });
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
      expect(() => update.run(text, attempt.attemptId)).toThrow(/CHECK constraint/u);
      expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations, {
        verifyBeforeCommit: (_database, migration) => { if (migration.version === 144) throw new Error("test_rollback"); },
      })).toThrow("test_rollback");
      expect(rows()).toEqual(beforeRows);
      expect(objects()).toEqual(beforeObjects);
      expect(foreignKeys()).toEqual(beforeForeignKeys);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 144").get()).toBeUndefined();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(rows()).toEqual(beforeRows);
      expect(objects()).toEqual(beforeObjects);
      expect(foreignKeys()).toEqual(beforeForeignKeys);
      expect(() => update.run(text, attempt.attemptId)).not.toThrow();
      expect(() => update.run(text + "x", attempt.attemptId)).toThrow(/CHECK constraint/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { database.close(); }
  });
});
