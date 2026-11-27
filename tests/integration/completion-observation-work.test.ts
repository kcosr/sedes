import { describe, expect, it, vi } from "vitest";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { InventoryRepository, type InventoryRuntimeWakeSignal, type InventoryWakeReason } from "../../src/server/db/repositories/inventory-repository.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

function writes(database: ReturnType<typeof applicationSummaryFixture>["database"]): number {
  return (database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

describe("backend-neutral completion observation work", () => {
  it.each(["unclassified", "unavailable"] as const)("preserves a frozen %s classification when a newer projector repartitions the same reply", classification => {
    const f = applicationSummaryFixture(1);
    try {
      const threadId = f.ids[0]!;
      f.bindings.bindDiscoveredConversation(f.scope, threadId, { backendConversationId: "native", now: 400 });
      f.completion.recordAccepted(f.scope, threadId, { operationId: "submit", acceptedAt: 500, backendCorrelation: "submit" });
      const result = { text: "Inspecting the source.\n\nThe fix is ready." };
      const terminal = { backendCorrelation: "submit", completionIdentity: "native-turn:completed", observedAt: 600,
        applicationTurnId: "application-turn", outcome: "completed" as const, result,
        classifiedResult: classification === "unavailable" ? null : { partial: null, provisional: null, final: null, unclassified: result },
      };
      const original = f.completion.observeBackendCompletion(f.scope, threadId, terminal)!.record;
      const stable = writes(f.database);
      const replacement = new SubmissionCompletionRepository(f.database);
      const reclassified = { partial: null, provisional: { text: "Inspecting the source." }, final: { text: "The fix is ready." }, unclassified: null };
      for (let replay = 0; replay < 3; replay += 1) {
        expect(replacement.observeBackendCompletion(f.scope, threadId, { ...terminal, observedAt: 700 + replay, classifiedResult: reclassified }))
          .toEqual({ changed: false, record: original });
        expect(replacement.observeCompletion(f.scope, threadId, "submit", {
          completionIdentity: terminal.completionIdentity, observedAt: 700 + replay, createAttention: true,
          finalized: { applicationTurnId: terminal.applicationTurnId, outcome: terminal.outcome, result, classifiedResult: reclassified },
        })).toEqual(original);
      }
      expect(replacement.get(f.scope, threadId, "submit")).toEqual(original);
      expect(writes(f.database)).toBe(stable);
    } finally { f.database.close(); }
  });

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
      const signal = { kind: "submission_completion", acceptedAt: 650, completionObservedAt: 659, outcome: "completed" } as const;
      const stable = writes(f.database);
      for (let replay = 0; replay < 10; replay += 1) await service.wakeForRuntimeSignal(f.scope, threadId, signal, 660 + replay);
      expect(writes(f.database)).toBe(stable);
      expect(capture).not.toHaveBeenCalled();
      await service.transition(f.scope, threadId, { expectedRevision: 0, mutationId: "snooze", change: { action: "snooze", snoozedUntil: 10_000 } }, 600);
      capture.mockClear();
      capture.mockRejectedValueOnce(new Error("capture unavailable"));
      const beforeWake = writes(f.database);
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, signal, 700)).rejects.toThrow("capture unavailable");
      expect(repository.getInventory(f.scope, threadId)).toMatchObject({ inventoryState: "active", wokeAt: 700, inventoryRevision: 2 });
      expect(writes(f.database)).toBeGreaterThan(beforeWake);
      const afterWake = writes(f.database);
      await service.wakeForRuntimeSignal(f.scope, threadId, signal, 701);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(writes(f.database)).toBe(afterWake);
      for (let replay = 0; replay < 10; replay += 1) await service.wakeForRuntimeSignal(f.scope, threadId, signal, 800 + replay);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(application).not.toHaveBeenCalled();
      expect(writes(f.database)).toBe(afterWake);
    } finally { f.database.close(); }
  });

  it.each<{
    name: string;
    signal: InventoryRuntimeWakeSignal;
    reason: InventoryWakeReason | null;
  }>([
    {
      name: "successful submission accepted before Snooze",
      signal: { kind: "submission_completion", acceptedAt: 599, completionObservedAt: 650, outcome: "completed" },
      reason: null,
    },
    {
      name: "successful submission accepted in the same millisecond",
      signal: { kind: "submission_completion", acceptedAt: 600, completionObservedAt: 650, outcome: "completed" },
      reason: "completion",
    },
    {
      name: "successful submission accepted after Snooze",
      signal: { kind: "submission_completion", acceptedAt: 601, completionObservedAt: 650, outcome: "completed" },
      reason: "completion",
    },
  ])("applies the wake rule for a $name", async ({ signal, reason }) => {
    const f = applicationSummaryFixture(1);
    try {
      const repository = new InventoryRepository(f.database);
      const publishMany = vi.fn();
      const service = new InventoryService(repository, { publishMany, publishApplicationThread() {} });
      const threadId = f.ids[0]!;
      await service.transition(f.scope, threadId, {
        expectedRevision: 0,
        mutationId: "snooze",
        change: { action: "snooze", snoozedUntil: 800, wakeReminderText: "Review the reply" },
      }, 600);
      publishMany.mockClear();
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, signal, 700)).resolves.toMatchObject({
        inventoryState: reason === null ? "snoozed" : "active",
        inventoryRevision: reason === null ? 1 : 2,
        wokeAt: reason === null ? null : 700,
        wakeReason: reason,
        wakeReminderText: "Review the reply",
      });
      expect(publishMany).toHaveBeenCalledTimes(reason === null ? 0 : 1);
    } finally { f.database.close(); }
  });

  it.each([
    { outcome: "failed", reason: "failure" },
    { outcome: "interrupted", reason: "completion" },
  ] as const)("wakes on a new $outcome observation and preserves a later snooze on replay", async ({ outcome, reason }) => {
    const f = applicationSummaryFixture(1);
    try {
      const repository = new InventoryRepository(f.database);
      const publishMany = vi.fn();
      const service = new InventoryService(repository, { publishMany, publishApplicationThread() {} });
      const threadId = f.ids[0]!;
      f.bindings.bindDiscoveredConversation(f.scope, threadId, { backendConversationId: "native", now: 400 });
      f.completion.recordAccepted(f.scope, threadId, {
        operationId: "submit", acceptedAt: 450, backendCorrelation: "submit",
      });
      await service.transition(f.scope, threadId, {
        expectedRevision: 0, mutationId: "snooze",
        change: { action: "snooze", snoozedUntil: 1_000 },
      }, 500);
      const terminal = {
        backendCorrelation: "submit",
        completionIdentity: "terminal",
        applicationTurnId: "application-turn",
        outcome,
        result: { text: "" },
        classifiedResult: null,
      };
      const first = f.completion.observeBackendCompletion(f.scope, threadId, {
        ...terminal, observedAt: 550,
      });
      expect(first).toMatchObject({ changed: true, record: { completionObservedAt: 550 } });
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, {
        kind: "submission_completion",
        acceptedAt: first!.record.acceptedAt,
        completionObservedAt: first!.record.completionObservedAt,
        outcome,
      }, 560)).resolves.toMatchObject({ inventoryState: "active", wakeReason: reason, wokeAt: 560 });

      const snoozed = await service.transition(f.scope, threadId, {
        expectedRevision: 2, mutationId: "snooze-again",
        change: { action: "snooze", snoozedUntil: 1_100 },
      }, 600);
      publishMany.mockClear();
      const replay = f.completion.observeBackendCompletion(f.scope, threadId, {
        ...terminal, observedAt: 700,
      });
      expect(replay).toEqual({ changed: false, record: first!.record });
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, {
        kind: "submission_completion",
        acceptedAt: replay!.record.acceptedAt,
        completionObservedAt: replay!.record.completionObservedAt,
        outcome,
      }, 710)).resolves.toEqual(snoozed);
      expect(publishMany).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("uses the renewed snooze timestamp and preserves a deadline wake on completion replay", async () => {
    const f = applicationSummaryFixture(1);
    try {
      const repository = new InventoryRepository(f.database);
      const publishMany = vi.fn();
      const service = new InventoryService(repository, { publishMany, publishApplicationThread() {} });
      const threadId = f.ids[0]!;
      await service.transition(f.scope, threadId, {
        expectedRevision: 0, mutationId: "snooze",
        change: { action: "snooze", snoozedUntil: 800 },
      }, 600);
      await service.transition(f.scope, threadId, {
        expectedRevision: 1, mutationId: "renew-snooze",
        change: { action: "snooze", snoozedUntil: 900 },
      }, 750);
      const signal = { kind: "submission_completion", acceptedAt: 700, completionObservedAt: 775, outcome: "completed" } as const;
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, signal, 800)).resolves.toMatchObject({
        inventoryState: "snoozed", snoozedAt: 750, snoozedUntil: 900,
      });
      await expect(service.wakeDue(899)).resolves.toEqual([]);
      await expect(service.wakeDue(900)).resolves.toEqual([
        expect.objectContaining({ inventoryState: "active", wakeReason: "deadline", wokeAt: 900 }),
      ]);
      publishMany.mockClear();
      await expect(service.wakeForRuntimeSignal(f.scope, threadId, signal, 901)).resolves.toMatchObject({
        inventoryState: "active", inventoryRevision: 3, wakeReason: "deadline", wokeAt: 900,
      });
      expect(publishMany).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("lists unresolved correlated submissions for startup recovery newest first within one backend and scope", () => {
    const f = applicationSummaryFixture(6);
    try {
      const backendInstanceId = (f.database.prepare("SELECT backend_instance_id AS id FROM application_threads WHERE id = ?")
        .get(f.ids[0]) as { id: string }).id;
      const [newest, older, parked, archived, resolved, unbound] = f.ids as [string, string, string, string, string, string];
      for (const [index, threadId] of [newest, older, parked, archived, resolved].entries()) {
        f.bindings.bindDiscoveredConversation(f.scope, threadId, { backendConversationId: `native-${index}`, now: 400 });
      }
      // The newest accepted operation orders a thread; an older unresolved one adds no duplicate.
      f.completion.recordAccepted(f.scope, newest, { operationId: "newest-old", acceptedAt: 1_000, backendCorrelation: "newest-old" });
      f.completion.recordAccepted(f.scope, newest, { operationId: "newest", acceptedAt: 5_000, backendCorrelation: "newest" });
      f.completion.recordAccepted(f.scope, older, { operationId: "older", acceptedAt: 2_000, backendCorrelation: "older" });
      f.completion.recordAccepted(f.scope, parked, { operationId: "parked", acceptedAt: 2_000, backendCorrelation: "parked" });
      f.completion.recordAccepted(f.scope, archived, { operationId: "archived", acceptedAt: 4_000, backendCorrelation: "archived" });
      f.completion.recordAccepted(f.scope, resolved, { operationId: "resolved", acceptedAt: 4_500, backendCorrelation: "resolved" });
      f.completion.observeCompletion(f.scope, resolved, "resolved", { completionIdentity: "native:completed", observedAt: 4_600, createAttention: true });
      // Without a correlation, attachment has no evidence to close the row.
      f.completion.recordAccepted(f.scope, older, { operationId: "uncorrelated", acceptedAt: 6_000 });
      // An unbound thread has no conversation to attach.
      f.database.prepare(`INSERT INTO submission_completion_observations(tenant_id, owner_principal_id, application_thread_id, operation_id, accepted_at, backend_correlation)
        VALUES (?, ?, ?, 'unbound', 7000, 'unbound')`).run(f.scope.tenantId, f.scope.principalId, unbound);
      const setState = (threadId: string, state: string) => f.database.prepare(`UPDATE thread_principal_state SET inventory_state = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`).run(state, f.scope.tenantId, f.scope.principalId, threadId);
      setState(parked, "parked");
      setState(archived, "archived");

      const list = (input: Partial<Parameters<typeof f.completion.listUnresolvedSubmissionThreads>[1]> = {}) =>
        f.completion.listUnresolvedSubmissionThreads(f.scope, { backendInstanceId, acceptedSince: 0, limit: 16, ...input });
      const ordered = [older, parked].sort();
      expect(list()).toEqual([
        { threadId: newest, latestAcceptedAt: 5_000 },
        ...ordered.map(threadId => ({ threadId, latestAcceptedAt: 2_000 })),
      ]);
      // Keyset pages break ties by thread ID without repeating or skipping.
      const first = list({ limit: 2 });
      expect(first.map(item => item.threadId)).toEqual([newest, ordered[0]]);
      expect(list({ limit: 2, after: first.at(-1)! })).toEqual([{ threadId: ordered[1], latestAcceptedAt: 2_000 }]);
      // The cutoff is inclusive and applies to each accepted operation.
      expect(list({ acceptedSince: 2_000 }).map(item => item.threadId)).toEqual([newest, ...ordered]);
      expect(list({ acceptedSince: 2_001 })).toEqual([{ threadId: newest, latestAcceptedAt: 5_000 }]);
      expect(list({ acceptedSince: 5_001 })).toEqual([]);
      expect(list({ backendInstanceId: "another-backend" })).toEqual([]);
      expect(f.completion.listUnresolvedSubmissionThreads({ ...f.scope, principalId: "other" },
        { backendInstanceId, acceptedSince: 0, limit: 16 })).toEqual([]);
      f.database.prepare("UPDATE application_threads SET availability = 'missing' WHERE id = ?").run(older);
      expect(list().map(item => item.threadId)).toEqual([newest, parked]);

      const plan = (f.database.prepare(`EXPLAIN QUERY PLAN SELECT application_thread_id FROM submission_completion_observations
        WHERE tenant_id = ? AND owner_principal_id = ? AND completion_observed_at IS NULL AND backend_correlation IS NOT NULL AND accepted_at >= ?`)
        .all(f.scope.tenantId, f.scope.principalId, 0) as { detail: string }[]).map(row => row.detail).join("\n");
      expect(plan).toContain("submission_completion_observations_unresolved");
    } finally { f.database.close(); }
  });
});
