import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture() {
  const { database, scope } = savedAgentDatabase(171);
  const inventory = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: "/tmp/parked-thread-inventory-migration",
    displayName: "Inventory migration",
    project: { kind: "new", name: "Inventory migration" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 110,
  });
  const owner = [scope.tenantId, scope.principalId] as const;
  const profile = database
    .prepare(`SELECT id FROM agent_connection_profiles
              WHERE tenant_id = ? AND owner_principal_id = ? AND enabled = 1`)
    .get(...owner) as { id: string };
  const createThread = (title: string) => bindings.createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title,
    now: 120,
  }).id;
  const migrate = () => applyDatabaseMigrations(database, backendNormalizedMigrations.filter(({ version }) => version <= 172));
  return { database, scope, inventory, workspace, owner, createThread, migrate };
}

describe("migration 172 parked thread inventory", () => {
  it("rewrites old inventory values and preserves related state, guards, indexes and foreign keys", () => {
    const { database, scope, inventory, workspace, owner, createThread, migrate } = fixture();
    try {
      const threadId = createThread("Parked");
      const snoozedId = createThread("Snoozed");
      const rootId = randomUUID();
      database.prepare(`
        INSERT INTO workspace_file_linked_worktree_roots(
          tenant_id, owner_principal_id, workspace_id, root_id, canonical_path,
          canonical_git_dir, identity_token, display_label, branch_ref, head_oid,
          availability, revision, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, '/tmp/feature', '/tmp/main/.git/worktrees/feature',
          ?, 'feature', 'refs/heads/feature', ?, 'available', 1, 130, 130)
      `).run(...owner, workspace.id, rootId, "1".repeat(64), "a".repeat(40));
      database.prepare(`
        UPDATE thread_principal_state SET inventory_state = 'settled',
          state_changed_at = 140, inventory_revision = 2, pinned = 1, pin_revision = 3,
          group_assignment_revision = 4, bookmark_revision = 5,
          preferred_worktree_root_id = ?, preferred_worktree_revision = 6
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `).run(rootId, ...owner, threadId);
      database.prepare(`
        INSERT INTO conversation_turn_bookmarks(
          tenant_id, principal_id, thread_id, turn_id, user_preview, response_state, created_at
        ) VALUES (?, ?, ?, 'turn', 'Question', 'no_response', 135)
      `).run(...owner, threadId);
      inventory.transitionInventory(scope, snoozedId, {
        expectedRevision: 0,
        mutationId: "snooze",
        change: { action: "snooze", snoozedUntil: 900, wakeReminderText: "Follow up" },
        now: 140,
      });
      const readInventoryRows = () => database.prepare(`
        SELECT * FROM thread_principal_state WHERE tenant_id = ? AND principal_id = ? ORDER BY thread_id
      `).all(...owner) as { thread_id: string; inventory_state: string }[];
      const readActivityRevision = () => database.prepare(`
        SELECT input_activity_revision AS revision FROM application_threads
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `).get(...owner, threadId) as { revision: number };
      const readSchema = () => database.prepare(`
        SELECT type, name, sql FROM sqlite_schema
        WHERE tbl_name = 'thread_principal_state' AND type IN ('index', 'trigger')
        ORDER BY name
      `).all();
      const rowsBefore = readInventoryRows();
      const revisionBefore = readActivityRevision().revision;
      const schemaBefore = readSchema();
      expect(database.prepare("SELECT max(version) AS version FROM schema_migrations").get())
        .toEqual({ version: 171 });

      migrate();

      expect(database.prepare("SELECT max(version) AS version FROM schema_migrations").get())
        .toEqual({ version: 172 });
      expect(readInventoryRows()).toEqual(rowsBefore.map((row) => row.thread_id === threadId
        ? { ...row, inventory_state: "parked" }
        : row));
      expect(readSchema()).toEqual(schemaBefore);
      expect(readActivityRevision().revision).toBe(revisionBefore);
      expect(database.prepare(`
        SELECT user_preview AS preview FROM conversation_turn_bookmarks
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `).get(...owner, threadId)).toEqual({ preview: "Question" });
      const setInventory = database.prepare(`
        UPDATE thread_principal_state SET inventory_state = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `);
      expect(() => setInventory.run("settled", ...owner, threadId)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(`
        UPDATE thread_principal_state SET preferred_worktree_root_id = 'unknown'
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `).run(...owner, threadId)).toThrow("preferred worktree is not available");
      setInventory.run("active", ...owner, threadId);
      expect(readActivityRevision().revision).toBe(revisionBefore + 1);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }
  });

  it("replays committed browser inventory mutations through the renamed operations", () => {
    const { database, scope, inventory, owner, createThread, migrate } = fixture();
    try {
      const threadId = createThread("Already parked");
      const historicState = {
        ...inventory.getInventory(scope, threadId),
        inventoryState: "settled",
        inventoryRevision: 1,
        stateChangedAt: 130,
      };
      const insertReceipt = database.prepare(`
        INSERT INTO mutation_receipts(
          tenant_id, principal_id, thread_id, mutation_id, operation_kind,
          request_fingerprint, result_code, result_json, replayable, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 1, 130)
      `);
      const hash = (input: unknown) => createHash("sha256")
        .update(JSON.stringify(input)).digest("hex");
      insertReceipt.run(...owner, threadId, "park", "settle_thread",
        hash(["settle_thread", threadId, 0, "keep", 0]),
        JSON.stringify({ state: historicState, movedTaskIds: [] }));
      insertReceipt.run(...owner, threadId, "transition", "inventory_transition",
        hash(["inventory_transition", threadId, 0, { action: "settle" }]),
        JSON.stringify(historicState));
      const unparked = {
        ...historicState, inventoryState: "active", inventoryRevision: 2, stateChangedAt: 140,
      };
      insertReceipt.run(...owner, threadId, "unpark", "inventory_transition",
        hash(["inventory_transition", threadId, 1, { action: "unsettle" }]),
        JSON.stringify(unparked));
      const targetThreadIds = [threadId, createThread("Bulk target")].sort();
      const targets = targetThreadIds.map((id) => ({ threadId: id, expectedRevision: 0 }));
      insertReceipt.run(...owner, targetThreadIds[0]!, "bulk", "bulk_inventory_transition",
        hash(["bulk_inventory_transition", "settle", targetThreadIds.map((id) => [id, 0]), "keep"]),
        JSON.stringify({ version: 1, targetThreadIds, changedThreadIds: [threadId], movedTaskIds: [] }));

      migrate();

      const replayState = { ...historicState, inventoryState: "parked" };
      expect(inventory.parkThread(scope, threadId, {
        expectedRevision: 0, mutationId: "park", expectedStashedPromptCount: 0, now: 190,
      })).toEqual({ state: replayState, replayed: true, movedTaskIds: [] });
      expect(inventory.transitionInventory(scope, threadId, {
        expectedRevision: 0, mutationId: "transition", change: { action: "park" }, now: 190,
      })).toEqual({ state: replayState, replayed: true });
      expect(inventory.transitionInventory(scope, threadId, {
        expectedRevision: 1, mutationId: "unpark", change: { action: "unpark" }, now: 190,
      })).toEqual({ state: unparked, replayed: true });
      expect(inventory.bulkInventoryTransition(scope, {
        action: "park", targets, mutationId: "bulk", blockedThreadIds: new Set(), now: 190,
      })).toMatchObject({ changedThreadIds: [threadId], movedTaskIds: [], replayed: true });
      expect(inventory.getInventory(scope, threadId).inventoryState).toBe("active");
    } finally {
      database.close();
    }
  });
});

describe("migration 174 park until done", () => {
  it("binds self-park policy to the exact current turn and ignores superseded reads and mutation retries", () => {
    const { database, scope, createThread } = fixture();
    try {
      const threadId = createThread("Current turn");
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      let activeTurn = "original";
      const inventory = new InventoryRepository(database, () => activeTurn);
      const first = { selfParkTurnId: activeTurn, expectedRevision: 0, mutationId: randomUUID(), now: 150 };
      inventory.parkThread(scope, threadId, first);
      const stored = () => database.prepare(`
        SELECT parked_until_turn_id AS turn, park_keep_on_success AS keep, progress_park_revision AS epoch
        FROM thread_principal_state WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `).get(scope.tenantId, scope.principalId, threadId);
      expect(stored()).toEqual({ turn: "original", keep: 1, epoch: 1 });
      inventory.transitionInventory(scope, threadId, { change: { action: "unpark" }, expectedRevision: 1, mutationId: randomUUID(), now: 151 });
      // The new turn took over before the self-park request from the old turn committed.
      activeTurn = "replacement";
      inventory.parkThread(scope, threadId, { ...first, mutationId: randomUUID(), expectedRevision: 2, now: 152 });
      expect(stored()).toEqual({ turn: "replacement", keep: 0, epoch: 2 });
      expect(inventory.parkThread(scope, threadId, { ...first, selfParkTurnId: undefined }).replayed).toBe(true);
      expect(inventory.unparkIfTurnEnded(scope, threadId, () => "interrupted", 153, 1)).toBeUndefined();
      expect(stored()).toEqual({ turn: "replacement", keep: 0, epoch: 2 });
      expect(inventory.unparkIfTurnEnded(scope, threadId, id => id === activeTurn ? "completed" : undefined, 154, 2)?.inventoryState).toBe("active");
      expect(stored()).toEqual({ turn: null, keep: 0, epoch: 2 });
    } finally { database.close(); }
  });

  it("preserves existing parks and advances the voice revision once per committed park", () => {
    const { database, scope, owner, createThread, migrate, inventory } = fixture();
    try {
      const threadId = createThread("Parked before upgrade");
      const companion = createThread("Active before upgrade");
      migrate();
      database.prepare("UPDATE thread_principal_state SET inventory_state = 'parked' WHERE tenant_id=? AND principal_id=? AND thread_id=?")
        .run(...owner, threadId);
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const stored = (id = threadId) => database.prepare(`
        SELECT inventory_state AS state, parked_until_turn_id AS target, park_keep_on_success AS keep, progress_park_revision AS revision
        FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?
      `).get(...owner, id);
      expect(stored()).toEqual({ state: "parked", target: null, keep: 0, revision: 1 });
      expect(stored(companion)).toEqual({ state: "active", target: null, keep: 0, revision: 0 });
      inventory.transitionInventory(scope, threadId, {
        expectedRevision: 0, mutationId: randomUUID(), change: { action: "unpark" }, now: 130,
      });
      expect(stored()).toEqual({ state: "active", target: null, keep: 0, revision: 1 });
      const bulk = {
        action: "park" as const,
        targets: [{ threadId, expectedRevision: 1 }, { threadId: companion, expectedRevision: 0 }],
        mutationId: randomUUID(),
        blockedThreadIds: new Set<string>(),
        now: 140,
      };
      expect(inventory.bulkInventoryTransition(scope, bulk).replayed).toBe(false);
      expect(inventory.bulkInventoryTransition(scope, bulk).replayed).toBe(true);
      expect(stored()).toEqual({ state: "parked", target: null, keep: 0, revision: 2 });
    } finally { database.close(); }
  });
});
