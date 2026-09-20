import type Database from "better-sqlite3";
import { expect } from "vitest";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

export function expectBackendSessionSummary(
  database: Database.Database, scope: RequestScope, threadId: string, backendSessionId: string,
): void {
  const summaries = new DatabaseApplicationThreadSummaryReader({
    inventory: new InventoryRepository(database),
    queue: new QueuedInputRepository(database),
    completion: new SubmissionCompletionRepository(database),
  });
  expect(summaries.listByIds(scope, [threadId])[0]).toMatchObject({ backendSessionId });
  expect(summaries.listByIds({ ...scope, principalId: "foreign-principal" }, [threadId])).toEqual([]);
  expect(summaries.listByIds({ ...scope, tenantId: "foreign-tenant" }, [threadId])).toEqual([]);
}
