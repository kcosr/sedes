import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function fixture(threadCount = 4) {
  const value = applicationSummaryFixture(threadCount);
  databases.push(value.database);
  return value;
}

function observeStatements(database: Database.Database) {
  const statements: string[] = [];
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("WITH requested_threads") ||
      sql.includes("AS isForkSource") ||
      sql.includes("LIMIT 1 OFFSET ?")) {
      statements.push(sql);
      for (const method of ["all", "get"] as const) {
        const execute = statement[method].bind(statement);
        vi.spyOn(statement, method).mockImplementation((...parameters: unknown[]) => {
          executions.push({ sql, parameters });
          return execute(...parameters);
        });
      }
    }
    return statement;
  });
  return { statements, executions };
}

describe("application summary prepared statements", () => {
  it("rebinds scope, IDs and environment across readers without changing deduplication or order", () => {
    const f = fixture();
    const observed = observeStatements(f.database);
    const reader = f.createReader();
    const [first, second, third, fourth] = f.ids as [string, string, string, string];
    const ids = (rows: ReturnType<typeof reader.list>) => rows.map(row => row.id);

    expect(reader.listByIds(f.scope, [])).toEqual([]);
    expect(() => reader.listByIds(f.scope, Array(101).fill(first))).toThrow("application_summary_page_too_large");
    expect(observed.statements).toHaveLength(0);
    expect(observed.executions).toHaveLength(0);
    expect(ids(reader.listByIds(f.scope, [first, third, first]))).toEqual([third, first]);
    expect(ids(f.createReader().listByIds(f.scope, [second, fourth]))).toEqual([fourth, second]);
    expect(ids(reader.listByIds(f.scope, [second, first]))).toEqual([first, second]);
    expect(ids(reader.listByIds(f.scope, [fourth]))).toEqual([fourth]);
    expect(reader.listByIds(f.scope, ["missing-thread"])).toEqual([]);
    expect(reader.list(f.scope, "missing-environment")).toEqual([]);
    expect(ids(reader.list(f.scope, f.environment.id))).toEqual([fourth, third, first, second]);
    expect(reader.structure(f.scope, first)).toEqual({ environmentId: f.environment.id, isFork: false, isForkSource: false });
    expect(reader.structure(f.scope, "missing-thread")).toBeUndefined();
    expect(reader.forkSelectionSaturated(f.scope, f.environment.id)).toBe(false);
    expect(reader.forkSelectionSaturated(f.scope, "missing-environment")).toBe(false);

    for (const scope of [
      { ...f.scope, tenantId: "another-tenant" },
      { ...f.scope, principalId: "another-principal" },
    ]) {
      expect(reader.listByIds(scope, [first, third])).toEqual([]);
      expect(reader.list(scope, f.environment.id)).toEqual([]);
      expect(reader.structure(scope, first)).toBeUndefined();
      expect(reader.forkSelectionSaturated(scope, f.environment.id)).toBe(false);
    }
    expect(ids(reader.listByIds(f.scope, [first, third]))).toEqual([third, first]);
    expect(observed.statements).toHaveLength(5);
    expect(observed.executions).toHaveLength(20);
    expect(observed.executions[0]?.parameters.slice(0, 4)).toEqual([first, third, f.scope.tenantId, f.scope.principalId]);
    expect(observed.executions[1]?.parameters.slice(0, 4)).toEqual([second, fourth, f.scope.tenantId, f.scope.principalId]);
  });

  it("retains at most the 100 supported ID shapes and three fixed queries", () => {
    const f = fixture();
    const observed = observeStatements(f.database);
    const reader = f.createReader();
    for (let pass = 0; pass < 2; pass += 1) {
      for (let count = 1; count <= 100; count += 1) {
        const requested = [f.ids[0]!, ...Array.from({ length: count - 1 }, (_, index) => `missing-${pass}-${index}`)];
        expect(reader.listByIds(f.scope, requested).map(row => row.id)).toEqual([f.ids[0]]);
      }
      reader.list(f.scope, f.environment.id);
      reader.structure(f.scope, f.ids[0]!);
      reader.forkSelectionSaturated(f.scope, f.environment.id);
    }
    expect(observed.statements).toHaveLength(103);
    expect(observed.executions).toHaveLength(206);
  });

  it("reads writes and transaction rollback without retaining summary results", () => {
    const f = fixture();
    const observed = observeStatements(f.database);
    const reader = f.createReader();
    const threadId = f.ids[0]!;
    const original = reader.listByIds(f.scope, [threadId])[0]!;
    const originalList = reader.list(f.scope, f.environment.id);
    const workpads = new WorkpadRepository(f.database);
    const automation = new AutomationRepository(f.database);
    const update = f.database.prepare(`UPDATE application_threads SET title = ?, last_activity_at = 1000
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`);
    const write = () => {
      update.run("Changed", f.scope.tenantId, f.scope.principalId, threadId);
      f.bindings.bindDiscoveredConversation(f.scope, threadId, { backendConversationId: "fresh-native-id", now: 900 });
      workpads.create(f.scope, { title: "Fresh workpad", scope: { kind: "thread", threadId } });
      f.completion.recordAccepted(f.scope, threadId, { operationId: "accepted", acceptedAt: 900 });
      f.completion.observeCompletion(f.scope, threadId, "accepted", { completionIdentity: "completed", observedAt: 901, createAttention: true });
      automation.createDefinition(f.scope, {
        id: "fresh-automation", anchorThreadId: threadId, name: "Fresh automation", prompt: "Run",
        precheck: null, runMode: "same_thread", enabled: true,
        schedule: { kind: "date_time", runAt: 2_000 }, misfirePolicy: null, nextRunAt: 2_000, now: 900,
      });
    };
    const expectChanged = () => {
      expect(reader.listByIds(f.scope, [threadId])[0]).toMatchObject({
        title: { text: "Changed" }, backendSessionId: "fresh-native-id", nonArchivedWorkpadCount: 1,
        attention: { unseenCompletion: true }, automations: { totalCount: 1 },
      });
      expect(reader.list(f.scope, f.environment.id)[0]?.id).toBe(threadId);
    };
    expect(() => f.database.transaction(() => {
      write();
      expectChanged();
      throw new Error("rollback-fixture");
    })()).toThrow("rollback-fixture");
    expect(reader.listByIds(f.scope, [threadId])[0]).toEqual(original);
    expect(reader.list(f.scope, f.environment.id)).toEqual(originalList);
    f.database.transaction(write)();
    expectChanged();
    expect(original.title).toEqual({ text: "Thread 0" });
    expect(original.nonArchivedWorkpadCount).toBe(0);
    expect(observed.statements).toHaveLength(2);
    expect(observed.executions).toHaveLength(8);
  });

  it("refreshes cached structure statements after committed lineage writes", () => {
    const f = fixture();
    const observed = observeStatements(f.database);
    const reader = f.createReader();
    const [source, child] = f.ids as [string, string];
    expect(reader.structure(f.scope, source)?.isForkSource).toBe(false);
    expect(reader.structure(f.scope, child)?.isFork).toBe(false);
    f.bindings.bindDiscoveredConversation(f.scope, source, { backendConversationId: "source-native", now: 900 });
    f.bindings.bindDiscoveredConversation(f.scope, child, { backendConversationId: "child-native", now: 900 });
    new ThreadLineageRepository(f.database).recordImportedNativeOrigin(f.scope, {
      childThreadId: child, providerParentBackendConversationId: "source-native", sourceThreadId: source,
      sourceTurnState: "unresolved", branchMethod: "provider_native", now: 900,
    });
    expect(reader.structure(f.scope, source)?.isForkSource).toBe(true);
    expect(reader.structure(f.scope, child)?.isFork).toBe(true);
    expect(observed.statements).toHaveLength(1);
    expect(observed.executions).toHaveLength(4);
  });

  it("keeps independent connection statements and rejects mixed repository connections", () => {
    const first = fixture();
    const second = fixture();
    const firstObserved = observeStatements(first.database);
    const secondObserved = observeStatements(second.database);
    const firstReader = first.createReader();
    const secondReader = second.createReader();
    const threadId = first.ids[0]!;
    second.database.prepare("UPDATE application_threads SET title = 'Second connection' WHERE id = ?").run(threadId);
    for (let index = 0; index < 2; index += 1) {
      expect(firstReader.listByIds(first.scope, [threadId])[0]?.title.text).toBe("Thread 0");
      expect(secondReader.listByIds(second.scope, [threadId])[0]?.title.text).toBe("Second connection");
    }
    expect(firstObserved.statements).toHaveLength(1);
    expect(secondObserved.statements).toHaveLength(1);
    expect(firstObserved.executions).toHaveLength(2);
    expect(secondObserved.executions).toHaveLength(2);
    expect(() => new DatabaseApplicationThreadSummaryReader({
      inventory: new InventoryRepository(first.database),
      queue: new QueuedInputRepository(second.database), completion: first.completion,
    })).toThrow("application_summary_database_mismatch");
  });
});
