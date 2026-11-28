import { ThreadForceResetRepository } from "../../src/server/db/repositories/thread-force-reset-repository.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BackendConversationSnapshot } from "../../src/shared/protocol/backend.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import type { ConversationArchivePreparation, PrepareConversationArchiveInput } from "../../src/server/backends/contracts.js";
import { settleArchiveSnapshot } from "../../src/server/conversations/archive-snapshot-settlement.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadArchiveObligationRepository } from "../../src/server/db/repositories/thread-archive-obligation-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "../../src/server/events/thread-event-presentation.js";
import { ScopedThreadEventHubRegistry, ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

const snapshot: BackendConversationSnapshot = {
  runState: "idle", orderedBackendTurnIds: ["b-turn"],
  turnsById: { "b-turn": {
    backendTurnId: "b-turn", status: "completed", completionCorrelations: ["b-operation"], orderedBackendItemIds: ["reply"],
  } },
  itemsById: { reply: {
    backendTurnId: "b-turn", backendItemId: "reply", semanticKind: "assistant_message", status: "completed",
    responsePhase: "final", sourceOrder: 0, markdown: { text: "Final answer for B" },
  } },
};

async function fixture() {
  const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
  const { scope, actors, bindings, database, inventoryRepository: inventory } = h;
  const completion = new SubmissionCompletionRepository(database);
  const questions = new QuestionRequestRepository(database, inventory);
  // The fixture provider holds A's active turn until the test releases its owner.
  vi.spyOn(h.driver, "scheduleScriptedResponse").mockImplementation(() => {});
  const acquire = vi.spyOn(actors, "acquire");
  const draft = (title: string) => h.lifecycle.createServerDraft(scope, {
    workspaceId: h.workspaceRecord.id, connectionProfileId: h.connection.id, title, initialText: title,
  });
  const a = await draft("A");
  const b = await draft("B");
  const aId = a.applicationThreadId;
  const bId = b.applicationThreadId;
  await h.lifecycle.startFirstSend(scope, aId, {
    attemptId: randomUUID(), mutationId: randomUUID(), expectedThreadRevision: 0, expectedDraftRevision: a.draft.revision,
  });
  const activeTarget = acquire.mock.calls.find(([target]) => target.binding.applicationThreadId === aId)![0];
  const bBinding = bindings.bindDiscoveredConversation(scope, bId, { backendConversationId: "b-conversation", now: Date.now() });
  const bTarget = { ...activeTarget, binding: { ...bBinding, createdAt: new Date(bBinding.createdAt).toISOString() }, opaqueBindingDetail: "b" };
  completion.recordAccepted(scope, bId, { operationId: "b-operation", backendCorrelation: "b-operation", acceptedAt: Date.now() });
  const attach = vi.spyOn(h.driver, "attach");
  const prepare = vi.fn<(input: PrepareConversationArchiveInput) => Promise<ConversationArchivePreparation>>();
  Object.assign(h.driver, { prepareArchive: prepare });
  const obligations = new ThreadArchiveObligationRepository(database);
  const newCoordinator = () => new ThreadRuntimeCoordinator({
    actors,
    targets: { resolve: async (requestScope, threadId) => {
      inventory.getThread(requestScope, threadId);
      if (threadId === aId) return activeTarget;
      if (threadId === bId) return bTarget;
      throw new Error("unexpected thread");
    } },
    bridge: new ConversationEventBridge(new ThreadEventPresentation(h.threads),
      (requestScope, threadId, turns) => h.usage.registerVisibleTurns(requestScope, threadId, turns)),
    interactions: h.interactions, hubs: new ScopedThreadEventHubRegistry(), retentionMilliseconds: 60_000,
    archiveObligations: new ThreadArchiveObligationRepository(database),
    settleArchiveSnapshot: async (requestScope, threadId, cut, ids) => {
      settleArchiveSnapshot({ bindings, completion, questions, usage: h.usage,
        recordSubmission: () => {}, settleAutomation: () => {} }, requestScope, threadId, cut, ids);
    },
  });
  let coordinator = newCoordinator();
  const archive = (requestScope = scope, mutationId = randomUUID()) => new ThreadArchiveService({
    inventory, lineage: new ThreadLineageRepository(database), runtimes: coordinator,
    summaries: new DatabaseApplicationThreadSummaryReader({ inventory, completion, queue: h.queueRepository }),
    publications: { publishCommitted: vi.fn(async () => {}) },
    tasks: new TaskRepository(database), taskPublications: { publishTaskChange: vi.fn(async () => {}) },
    executionWorkspaces: { status: async () => ({ kind: "direct" }), delete: async () => { throw new Error("unexpected delete"); } },
  }).archive(requestScope, bId, {
    mutationId, includeDescendants: false, expectedRevision: 0, expectedPendingQuestionCount: 0,
    expectedStashedPromptCount: 0, executionWorkspaceDisposition: { kind: "keep" },
  });
  return {
    scope, aId, bId, attach, prepare, completion, inventory, obligations, archive, reset: new ThreadForceResetRepository(database),
    coordinator: () => coordinator,
    restart: async () => { await coordinator.close(); coordinator = newCoordinator(); },
    close: async () => { await coordinator.close(); await h.close(); },
  };
}

describe("sidebar archive through runtime retirement and durable inventory", () => {
  it("settles retained output on the first request for cold B while A's open turn keeps running", async () => {
    const f = await fixture();
    try {
      const active = await f.coordinator().acquire(f.scope, f.aId);
      try {
        expect(active.actor.timeline.runState).toBe("running");
        expect(await f.coordinator().captureLoadedState(f.scope, f.bId)).toBeUndefined();
        const aBefore = f.inventory.getInventory(f.scope, f.aId);
        f.prepare.mockImplementation(async input => {
          expect(input.binding.applicationThreadId).toBe(f.bId);
          input.markRetained("b-owner");
          await input.settle(snapshot, ["b-turn"]);
          expect(f.completion.get(f.scope, f.bId, "b-operation")).toMatchObject({
            lastCompletionIdentity: "b-turn:completed", assistantResult: { text: "Final answer for B" },
            completionOutcome: "completed", attentionCreatedAt: null,
          });
          expect(f.inventory.getInventory(f.scope, f.bId).inventoryState).toBe("active");
          input.markSettled("b-owner");
          return { outcome: "released" };
        });
        await expect(f.archive()).resolves.toEqual([f.bId]);
        expect(f.prepare).toHaveBeenCalledOnce();
        expect(f.inventory.getInventory(f.scope, f.bId).inventoryState).toBe("archived");
        expect(f.obligations.read(f.scope, f.bId)).toBeUndefined();
        expect(f.inventory.getInventory(f.scope, f.aId)).toEqual(aBefore);
        expect(active.actor.timeline.runState).toBe("running");
        expect(f.attach.mock.calls.some(([input]) => input.binding.applicationThreadId === f.bId)).toBe(false);
      } finally { active.release(); }
    } finally { await f.close(); }
  });

  it("keeps newer observations when a reset discards evidence during the original archive probe", async () => {
    const f = await fixture();
    try {
      f.prepare.mockImplementationOnce(async input => {
        input.markObserved();
        const impact = f.reset.impact(f.scope, f.bId);
        f.reset.forceReset(f.scope, f.bId, { mutationId: randomUUID(), expectedBlockerFingerprint: impact.blockerFingerprint, now: Date.now() });
        f.obligations.remember(f.scope, f.bId);
        return { outcome: "released" };
      });
      await expect(f.archive()).rejects.toMatchObject({ code: "invalid_transition", retryable: true });
      expect(f.inventory.getInventory(f.scope, f.bId).inventoryState).toBe("active");
      expect(f.obligations.read(f.scope, f.bId)).toBeDefined();
    } finally { await f.close(); }
  });

  it("archives dormant offline history after the user discards the lost owner's recovery record", async () => {
    const f = await fixture();
    try {
      f.prepare.mockImplementationOnce(async input => {
        input.markRetained("lost-owner");
        return { outcome: "inconclusive" };
      });
      await expect(f.archive()).rejects.toMatchObject({ retryable: true });
      f.prepare.mockResolvedValue({ outcome: "offline" });
      await expect(f.archive()).rejects.toMatchObject({ message: expect.stringContaining("Force reset") });
      const impact = f.reset.impact(f.scope, f.bId);
      expect(impact.blockers).toContainEqual({ kind: "archive_recovery", count: 1 });
      f.reset.forceReset(f.scope, f.bId, { mutationId: randomUUID(), expectedBlockerFingerprint: impact.blockerFingerprint, now: Date.now() });
      await expect(f.archive()).resolves.toEqual([f.bId]);
      expect(f.inventory.getInventory(f.scope, f.bId).inventoryState).toBe("archived");
    } finally { await f.close(); }
  });

  it("retains failed output across a coordinator restart and an offline retry, scoped to B's owner", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      f.prepare.mockImplementationOnce(async input => {
        input.markRetained("original-owner");
        await input.settle(snapshot, ["missing-turn"]);
        throw new Error("unconfirmed output must never be acknowledged");
      });
      await expect(f.archive(f.scope, id)).rejects.toMatchObject({ retryable: true });
      expect(f.obligations.read(f.scope, f.bId)).toMatchObject({ retainedOwner: "original-owner" });
      expect(f.inventory.getInventory(f.scope, f.bId)).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      expect(f.completion.get(f.scope, f.bId, "b-operation").completionObservedAt).toBeNull();

      await f.restart();
      const other = { ...f.scope, principalId: randomUUID() };
      await expect(f.archive(other, id)).rejects.toMatchObject({ code: "not_found" });
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.obligations.read(other, f.bId)).toBeUndefined();
      f.prepare.mockImplementationOnce(async input => {
        expect(input.retainedOwner).toBe("original-owner");
        return { outcome: "offline" };
      });
      await expect(f.archive(f.scope, id)).rejects.toMatchObject({ retryable: true });
      expect(f.inventory.getInventory(f.scope, f.bId)).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      f.prepare.mockImplementationOnce(async input => {
        expect(input.retainedOwner).toBe("original-owner");
        await input.settle(snapshot, ["b-turn"]);
        input.markSettled("original-owner");
        return { outcome: "released" };
      });
      await expect(f.archive(f.scope, id)).resolves.toEqual([f.bId]);
      expect(f.completion.get(f.scope, f.bId, "b-operation").completionOutcome).toBe("completed");
      expect(f.obligations.read(f.scope, f.bId)).toBeUndefined();
      expect(f.attach.mock.calls.some(([input]) => input.binding.applicationThreadId === f.bId)).toBe(false);
    } finally { await f.close(); }
  });
});
