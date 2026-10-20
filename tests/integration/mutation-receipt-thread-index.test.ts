import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActivityService } from "../../src/server/conversations/thread-activity-service.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function fixture(latestVersion?: number) {
  const current = savedAgentDatabase(latestVersion);
  databases.push(current.database);
  return current;
}

const indexes = (database: Database.Database) => (database
  .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'mutation_receipts'")
  .all() as { name: string }[]).map(({ name }) => name);

/** Captures every executed receipt statement with its bound parameters and returns their query plans. */
async function receiptPlans(database: Database.Database, run: () => Promise<unknown>): Promise<string[]> {
  const executed: Array<{ sql: string; parameters: unknown[] }> = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.includes("mutation_receipts")) return statement;
    for (const method of ["all", "get", "run"] as const) {
      const execute = statement[method].bind(statement) as (...parameters: unknown[]) => unknown;
      vi.spyOn(statement, method).mockImplementation(((...parameters: unknown[]) => {
        executed.push({ sql, parameters });
        return execute(...parameters);
      }) as never);
    }
    return statement;
  });
  await run().catch(() => undefined); // Plans only; the missing thread rejects the activity capture.
  vi.mocked(database.prepare).mockRestore();
  expect(executed.length).toBeGreaterThan(0);
  return executed.map(({ sql, parameters }) => (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[])
    .map(({ detail }) => detail)
    .join("\n"));
}

describe("mutation receipt thread index", () => {
  it("is added by migration 153", () => {
    const before = fixture(152);
    expect(indexes(before.database)).not.toContain("mutation_receipts_thread_state");
    applyDatabaseMigrations(before.database, backendNormalizedMigrations);
    expect(indexes(before.database)).toContain("mutation_receipts_thread_state");
    expect(before.database.prepare("SELECT version FROM schema_migrations WHERE version = 153").get()).toEqual({ version: 153 });
  }, 15_000);

  it("serves the per-thread recovery checks without walking the principal's receipts", async () => {
    const { database, scope } = fixture();
    const operations = new ConversationOperationRepository(database);
    const activity = new ThreadActivityService({
      database,
      actors: { observeInputRuntime: () => undefined, isInputRuntimeDormant: () => true, subscribeInputActivity: () => () => undefined },
      presentation: { readCached: async () => { throw new Error("not read"); } },
    });
    const threadId = "thread-without-receipts";
    try {
      // Observe from the connection's first preparation; statements are cached per connection.
      const plans = await receiptPlans(database, async () => {
        operations.findUncertainThreadOperation(scope, threadId);
        operations.hasPendingMaterializationDraftSteer(scope, threadId);
        operations.hasBlockingSteer(scope, threadId, "submit");
        operations.expireInterrupts(scope, 1_000, threadId);
        await activity.capture(scope, threadId);
      });
      // Uncertain, draft Steer, blocking Steer, three expiry statements and the activity capture.
      expect(plans).toHaveLength(7);
      const receiptLookups = plans.flatMap(plan => plan.split("\n"))
        .filter(detail => /^SEARCH (mutation_receipts|receipt) /.test(detail));
      expect(receiptLookups).toHaveLength(8);
      for (const detail of receiptLookups) {
        expect(detail).toMatch(/USING (COVERING )?INDEX mutation_receipts_thread_state \(tenant_id=\? AND principal_id=\? AND thread_id=\?/);
      }
    } finally {
      activity.close();
    }
  });
});
