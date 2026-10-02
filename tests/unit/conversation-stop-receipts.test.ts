import { describe, expect, it } from "vitest";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";

function fixture(version?: number) {
  const current = savedAgentDatabase(version);
  const environment = current.database.prepare("SELECT id FROM execution_environments WHERE kind = 'local'").get() as { id: string };
  const profile = current.database.prepare("SELECT id FROM agent_connection_profiles").get() as { id: string };
  const seed = {
    id: "0198bb10-0000-7000-8000-000000000001", environmentId: environment.id,
    canonicalPath: "/tmp/stop-receipts", displayName: "Stop receipts", available: true,
    trustState: "trusted", environmentConfigurationRevision: 0, now: 100,
  } as const;
  const workspace = version === undefined
    ? new InventoryRepository(current.database).upsertWorkspace(current.scope, { ...seed, project: { kind: "new", name: seed.displayName } })
    : insertPreProjectWorkspace(current.database, current.scope, seed);
  const threadId = "0198bb10-0000-7000-8000-000000000002";
  new ConversationBindingRepository(current.database).createUnboundThread(current.scope, {
    id: threadId, workspaceId: workspace.id, connectionProfileId: profile.id, title: "Stop receipts", now: 101,
  });
  return { ...current, threadId, operations: new ConversationOperationRepository(current.database) };
}

describe("conversation Stop receipts", () => {
  it("keeps the original deadline and terminal unknown state despite replay and late acknowledgement", () => {
    const { database, scope, threadId, operations } = fixture();
    try {
      const first = operations.prepareInterrupt(scope, threadId, { operationId: "stop-1", now: 1000 });
      operations.markInterruptStarted(scope, "stop-1");
      const retry = operations.prepareInterrupt(scope, threadId, { operationId: "stop-1", now: 30_999 });
      expect(retry.deadlineAt).toBe(first.deadlineAt);
      operations.expireInterrupts(scope, 30_999);
      expect(operations.getInterrupt(scope, "stop-1").state).toBe("uncertain");
      operations.expireInterrupts(scope, 31_000);
      expect(operations.getInterrupt(scope, "stop-1")).toMatchObject({ state: "failed_unknown", failureDiagnostic: expect.any(String) });
      expect(operations.acceptInterrupt(scope, "stop-1").state).toBe("failed_unknown");
      expect(operations.hasBlockingThreadOperation(scope, threadId)).toBe(false);
      expect(operations.prepareInterrupt(scope, threadId, { operationId: "stop-2", now: 31_001 }).deadlineAt).toBe(61_001);
      expect(operations.getInterrupt(scope, "stop-1").state).toBe("failed_unknown");
    } finally { database.close(); }
  });

  it("expires only its principal's receipts and removes proven undispatched work", () => {
    const { database, scope, threadId, operations } = fixture();
    try {
      operations.prepareInterrupt(scope, threadId, { operationId: "unsent", now: 1000 });
      operations.prepareInterrupt(scope, threadId, { operationId: "sent", now: 1000 });
      operations.markInterruptStarted(scope, "sent");
      const stranger = { ...scope, principalId: "another-principal" };
      operations.expireInterrupts(stranger, 31_000);
      expect(operations.findInterrupt(stranger, "sent")).toBeUndefined();
      expect(operations.getInterrupt(scope, "sent").state).toBe("uncertain");
      operations.expireInterrupts(scope, 31_000);
      expect(operations.findInterrupt(scope, "unsent")).toBeUndefined();
      expect(operations.getInterrupt(scope, "sent").state).toBe("failed_unknown");
    } finally { database.close(); }
  });

  it("migrates old turn-targeted receipts without permitting them to dispatch session Stop", () => {
    const { database, scope, threadId, operations } = fixture(118);
    try {
      for (const state of ["prepared", "uncertain", "accepted"]) {
        database.prepare(`INSERT INTO mutation_receipts(tenant_id, principal_id, thread_id, mutation_id,
          operation_kind, request_fingerprint, result_code, result_json, replayable, created_at)
          VALUES (?, ?, ?, ?, 'conversation_interrupt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, ?, 1000)`)
          .run(scope.tenantId, scope.principalId, threadId, state, state,
            JSON.stringify({ version: 1, applicationOperationId: state, expectedActiveTurnId: "old-turn" }), state === "uncertain" ? 0 : 1);
      }
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(operations.findInterrupt(scope, "prepared")).toBeUndefined();
      expect(operations.getInterrupt(scope, "uncertain")).toMatchObject({ state: "failed_unknown", deadlineAt: 31_000 });
      expect(operations.getInterrupt(scope, "accepted")).toMatchObject({ state: "accepted", deadlineAt: 31_000 });
      const payloads = database.prepare("SELECT result_json AS payload FROM mutation_receipts WHERE operation_kind = 'conversation_interrupt'").all() as { payload: string }[];
      for (const { payload } of payloads) expect(JSON.parse(payload)).not.toHaveProperty("expectedActiveTurnId");
    } finally { database.close(); }
  });
});
