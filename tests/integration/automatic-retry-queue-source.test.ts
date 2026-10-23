import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { UserInputRevisionRepository } from "../../src/server/db/repositories/user-input-revision-repository.js";
import { projectQueuedInputPresentation, projectQueuedInputSummaries } from "../../src/server/conversations/queued-input-projection.js";
import { deliveryInputOriginSchema, queuedInputSummarySchema } from "../../src/shared/protocol/conversation.js";
import type { ConversationSubmissionSource } from "../../src/server/backends/contracts.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

const text = "Please continue from where you left off.";
type Harness = Awaited<ReturnType<typeof createInMemoryThreadRuntimeHarness>>;

async function boundThread(h: Harness): Promise<string> {
  const { applicationThreadId } = await h.lifecycle.createServerDraft(h.scope, {
    workspaceId: h.workspaceRecord.id, connectionProfileId: h.connection.id,
    title: "Retry source", initialText: "Preserve this composer text",
  });
  await h.mutations.admitInput(h.scope, applicationThreadId, {
    mutationId: randomUUID(), text: "Initial request", origin: { clientId: randomUUID() },
    runningPolicy: { mode: "queue" },
  });
  await vi.waitFor(() => expect(h.actors.observeInputRuntime(h.scope, applicationThreadId)?.settled).toBe(true));
  await Promise.all(h.completionFollowUps.splice(0));
  return applicationThreadId;
}

function retryInput(h: Harness, threadId: string, executionSource: ConversationSubmissionSource = { kind: "user" }) {
  return {
    mutationId: randomUUID(), text, contextExcerpts: [], attachmentIds: [], taskReferences: [], now: Date.now(),
    source: { kind: "automatic_retry" as const,
      expectedThreadRevision: h.inventoryRepository.getThread(h.scope, threadId).thread.revision,
      sourceFailureIdentity: `application-failure:${randomUUID()}`, executionSource },
  };
}

describe("automatic retry queue source", { timeout: 30_000 }, () => {
  it("admits one ordinary Send without consuming the draft or advancing user-written input, and keeps failure evidence private", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const threadId = await boundThread(h);
      const draft = h.inventoryRepository.getDraft(h.scope, threadId);
      const revisions = new UserInputRevisionRepository(h.database);
      const before = revisions.capture(h.scope, threadId, []);
      const input = retryInput(h, threadId);
      const { item } = h.queueRepository.enqueue(h.scope, threadId, input);
      expect(item).toMatchObject({ text, inputOrigin: { kind: "automatic_retry" },
        sourceFailureIdentity: input.source.sourceFailureIdentity, isUserInput: 0,
        resolvedDeliveryMode: "submit", resolvedSteerTarget: null,
        sourceThreadRevision: input.source.expectedThreadRevision, requestedThreadRevision: null });
      expect(h.inventoryRepository.getDraft(h.scope, threadId)).toEqual(draft);
      expect(revisions.capture(h.scope, threadId, [])).toEqual(before);
      const summaries = projectQueuedInputSummaries([item]);
      expect(queuedInputSummarySchema.parse(summaries[0])).toMatchObject({ origin: "automatic_retry", inputOrigin: { kind: "automatic_retry" } });
      const presentation = projectQueuedInputPresentation(item, input.source.expectedThreadRevision + 1, item.mutationId);
      expect(JSON.stringify([summaries, presentation])).not.toContain(input.source.sourceFailureIdentity);
      expect(deliveryInputOriginSchema.safeParse({ kind: "automatic_retry", sourceFailureIdentity: input.source.sourceFailureIdentity }).success).toBe(false);
      expect(h.queueRepository.enqueue(h.scope, threadId, input)).toMatchObject({ replayed: true, item: { id: item.id } });
      expect(revisions.capture(h.scope, threadId, [])).toEqual(before);
    } finally { await h.close(); }
  });

  it("rejects mutation reuse for another failure, stale revisions, wrong principals and alternate delivery intent", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const threadId = await boundThread(h);
      const input = retryInput(h, threadId);
      const { item } = h.queueRepository.enqueue(h.scope, threadId, input);
      for (const source of [
        { ...input.source, sourceFailureIdentity: "another-failure" },
        { ...input.source, expectedThreadRevision: input.source.expectedThreadRevision + 1 },
        { ...input.source, executionSource: { kind: "automation" as const, automationId: "different-source", automationRunId: "different-run" } },
        { kind: "direct_input" as const, resolvedDeliveryMode: "submit" as const, expectedThreadRevision: input.source.expectedThreadRevision },
      ]) expect(() => h.queueRepository.enqueue(h.scope, threadId, { ...input, source })).toThrow("reused with different input");
      expect(() => h.queueRepository.enqueue(h.scope, threadId, { ...input, mutationId: randomUUID() })).toThrow("thread changed");
      expect(() => h.queueRepository.enqueue({ ...h.scope, principalId: randomUUID() }, threadId, input)).toThrow("thread was not found");
      const revision = h.inventoryRepository.getThread(h.scope, threadId).thread.revision;
      expect(() => h.queueRepository.reserveHeadForSteer(h.scope, threadId, item.id, {
        steerOperationId: randomUUID(), expectedThreadRevision: revision, now: Date.now(),
      })).toThrow("cannot be steered");
      expect(() => h.queueRepository.restoreIdempotently(h.scope, threadId, item.id, {
        mutationId: randomUUID(), expectedThreadRevision: revision,
        expectedDraftRevision: h.inventoryRepository.getDraft(h.scope, threadId).revision, now: Date.now(),
      })).toThrow("cannot replace the composer");
    } finally { await h.close(); }
  });

  it("delivers the new continuation through the ordinary dispatcher and retains only normalized attribution", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000, persistDeliveryInputSnapshots: true });
    try {
      const threadId = await boundThread(h);
      const executionSource = { kind: "automation" as const, automationId: randomUUID(), automationRunId: randomUUID() };
      const input = retryInput(h, threadId, executionSource);
      const runtime = await h.runtimes.acquire(h.scope, threadId);
      const submit = vi.spyOn(runtime.actor, "submit");
      const { item } = h.queueRepository.enqueue(h.scope, threadId, input);
      expect(item.automaticRetryExecutionSource).toEqual(executionSource);
      await h.queueDispatcher.dispatchAdmitted(h.scope, threadId);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ source: executionSource, text, inputOrigin: { kind: "automatic_retry" } }));
      runtime.release();
      await vi.waitFor(() => expect(h.queueRepository.get(h.scope, threadId, item.id).state).toBe("accepted"));
      const stored = h.database.prepare(`SELECT original_text AS text, origin_json AS origin
        FROM delivery_input_snapshots WHERE application_operation_id = ?`).get(item.mutationId) as { text: string; origin: string };
      expect(stored.text).toBe(text);
      expect(JSON.parse(stored.origin)).toEqual({ kind: "automatic_retry" });
      expect(stored.origin).not.toContain(input.source.sourceFailureIdentity);
      expect(stored.origin).not.toContain(executionSource.automationId);
    } finally { await h.close(); }
  });
});
