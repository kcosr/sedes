import { describe, expect, it, vi } from "vitest";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

function writes(database: ReturnType<typeof applicationSummaryFixture>["database"]): number {
  return (database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

describe("backend-neutral completion observation work", () => {
  it("records each accepted input on one native turn, enriches once, and rejects conflicting replay", () => {
    const f = applicationSummaryFixture(2);
    try {
      const threadId = f.ids[0]!;
      f.bindings.bindDiscoveredConversation(f.scope, threadId, { backendConversationId: "native", now: 400 });
      for (const [index, operationId] of ["submit", "steer-one", "steer-two"].entries()) {
        f.completion.recordAccepted(f.scope, threadId, { operationId, acceptedAt: 500 + index, backendCorrelation: operationId });
      }
      const terminal = {
        completionIdentity: "native-turn:completed", observedAt: 600,
        applicationTurnId: "application-turn", outcome: "completed" as const,
        result: { text: "Full terminal reply" }, classifiedResult: null,
      };
      const observe = (operationId: string, repository = f.completion) => repository.observeBackendCompletion(f.scope, threadId, {
        ...terminal, backendCorrelation: operationId,
      });
      // Recovery can establish terminal identity before normalized history.
      f.completion.observeCompletion(f.scope, threadId, "submit", {
        completionIdentity: terminal.completionIdentity, observedAt: 550, createAttention: true,
      });
      const beforeEnrichment = writes(f.database);
      expect(observe("submit")).toMatchObject({ changed: true, record: { completionObservedAt: 550, assistantResult: terminal.result } });
      expect(writes(f.database) - beforeEnrichment).toBe(1);
      for (const operationId of ["steer-one", "steer-two"]) {
        const before = writes(f.database);
        expect(observe(operationId)?.changed).toBe(true);
        expect(writes(f.database) - before).toBe(2);
      }
      const revision = new InventoryRepository(f.database).getThread(f.scope, threadId).thread.revision;
      const stable = writes(f.database);
      // A replacement repository has no memory of the first observer.
      const replacement = new SubmissionCompletionRepository(f.database);
      for (let replay = 0; replay < 20; replay += 1) {
        for (const operationId of ["submit", "steer-one", "steer-two"]) {
          expect(observe(operationId, replacement)?.changed).toBe(false);
        }
      }
      expect(writes(f.database)).toBe(stable);
      expect(new InventoryRepository(f.database).getThread(f.scope, threadId).thread.revision).toBe(revision);
      expect(replacement.listUnacknowledged(f.scope).map(item => item.operationId)).toEqual(["submit", "steer-one", "steer-two"]);
      expect(replacement.observeBackendCompletion({ ...f.scope, principalId: "other" }, threadId, { ...terminal, backendCorrelation: "submit" })).toBeUndefined();
      expect(replacement.observeBackendCompletion(f.scope, f.ids[1]!, { ...terminal, backendCorrelation: "submit" })).toBeUndefined();
      for (const conflict of [
        { completionIdentity: "different" }, { applicationTurnId: "different" },
        { outcome: "failed" as const }, { result: { text: "different" } },
      ]) {
        expect(() => replacement.observeBackendCompletion(f.scope, threadId, { ...terminal, ...conflict, backendCorrelation: "submit" })).toThrow(/different/);
      }
      expect(writes(f.database)).toBe(stable);
    } finally { f.database.close(); }
  });

  it("publishes a real wake once, skips all no-op wake work, and retries failed publication", async () => {
    const f = applicationSummaryFixture(1);
    try {
      const repository = new InventoryRepository(f.database);
      const capture = vi.fn(async () => undefined);
      const application = vi.fn(async () => undefined);
      const service = new InventoryService(repository, { publishMany: capture, publishApplicationThread: application });
      const threadId = f.ids[0]!;
      const stable = writes(f.database);
      for (let replay = 0; replay < 10; replay += 1) await service.wakeForRuntimeSignal(f.scope, threadId, "completion", 500 + replay);
      expect(writes(f.database)).toBe(stable);
      expect(capture).not.toHaveBeenCalled();
      await service.transition(f.scope, threadId, { expectedRevision: 0, mutationId: "snooze", change: { action: "snooze", snoozedUntil: 10_000 } }, 600);
      capture.mockClear();
      capture.mockRejectedValueOnce(new Error("capture unavailable"));
      const beforeWake = writes(f.database);
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, "completion", 700)).rejects.toThrow("capture unavailable");
      expect(repository.getInventory(f.scope, threadId)).toMatchObject({ inventoryState: "active", wokeAt: 700, inventoryRevision: 2 });
      expect(writes(f.database)).toBeGreaterThan(beforeWake);
      const afterWake = writes(f.database);
      await service.wakeForRuntimeSignal(f.scope, threadId, "completion", 701);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(writes(f.database)).toBe(afterWake);
      for (let replay = 0; replay < 10; replay += 1) await service.wakeForRuntimeSignal(f.scope, threadId, "completion", 800 + replay);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(application).not.toHaveBeenCalled();
      expect(writes(f.database)).toBe(afterWake);
    } finally { f.database.close(); }
  });
});
