import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/server/backends/contracts.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { NativeArchiveOperationRepository } from "../../src/server/db/repositories/native-archive-operation-repository.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

async function fixture() {
  const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
  const { applicationThreadId: threadId } = await h.lifecycle.createServerDraft(h.scope, {
    workspaceId: h.workspaceRecord.id,
    connectionProfileId: h.connection.id,
    title: "Archived conversation",
  });
  await h.mutations.admitInput(h.scope, threadId, {
    mutationId: randomUUID(), text: "Initial conversation",
    origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
  });
  await vi.waitFor(() => expect(h.actors.observeInputRuntime(h.scope, threadId)?.settled).toBe(true));
  await Promise.all(h.completionFollowUps.splice(0));
  await h.runtimes.runWithRuntimeRetired(h.scope, threadId, async () => {
    h.inventoryRepository.transitionInventory(h.scope, threadId, {
      expectedRevision: h.inventoryRepository.getInventory(h.scope, threadId).inventoryRevision,
      mutationId: randomUUID(), change: { action: "archive" }, now: Date.now(),
    });
  });
  const archived = await h.runtimes.acquire(h.scope, threadId);
  expect(archived.hub.snapshot?.thread.inventoryState).toBe("archived");
  const attach = vi.spyOn(h.driver, "attach");
  const service = new InventoryService(h.inventoryRepository, {
    publishMany: (scope, states) => h.threadSnapshots.publishMany(scope, states.map(state => state.threadId)),
    publishApplicationThread: async () => undefined,
  }, undefined, {
    run: (scope, id, operation) => h.runtimes.runWithRuntimeRetired(scope, id, operation),
  });
  const restore = (scope = h.scope) => service.transition(scope, threadId, {
    expectedRevision: h.inventoryRepository.getInventory(h.scope, threadId).inventoryRevision,
    mutationId: randomUUID(), change: { action: "restore" },
  });
  return { ...h, threadId, archived, attach, restore };
}

describe("restore publication after passive runtime retirement", () => {
  it("replaces the existing viewer's archived baseline and allows input without reconnecting", async () => {
    const h = await fixture();
    const subscriber = h.archived.hub.subscribe(() => undefined);
    const generation = h.archived.hub.projectionGeneration;
    h.archived.release();
    try {
      await h.restore();
      expect(h.archived.actor.closed).toBe(true);
      expect(h.archived.hub.projectionGeneration).not.toBe(generation);
      expect(h.archived.hub.snapshot?.thread.inventoryState).toBe("active");
      expect(h.archived.hub.snapshot?.capabilities.deliveryModes).toContainEqual(
        expect.objectContaining({ id: "submit", available: true }),
      );
      expect(h.attach).toHaveBeenCalledOnce();
      await expect(h.mutations.admitInput(h.scope, h.threadId, {
        mutationId: randomUUID(), text: "Continue after restore",
        origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
      })).resolves.toMatchObject({ admittedMode: "submit" });
    } finally { subscriber.close(); h.archived.release(); await h.close(); }
  });

  it("does not attach an execution runtime when the restored thread has no viewers", async () => {
    const h = await fixture();
    h.archived.release();
    try {
      await h.restore();
      expect(h.archived.actor.closed).toBe(true);
      expect(h.attach).not.toHaveBeenCalled();
      expect(await h.runtimes.captureLoadedRuntime(h.scope, h.threadId)).toBeUndefined();
      expect(h.inventoryRepository.getInventory(h.scope, h.threadId).inventoryState).toBe("active");
    } finally { await h.close(); }
  });

  it("publishes the restored inventory as disconnected if execution cannot attach", async () => {
    const h = await fixture();
    const subscriber = h.archived.hub.subscribe(() => undefined);
    h.archived.release();
    h.attach.mockRejectedValueOnce(new BackendError({
      category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
      safeMessage: "Provider is unavailable.",
    }));
    try {
      await h.restore();
      expect(h.archived.hub.snapshot?.thread.inventoryState).toBe("active");
      expect(h.archived.hub.snapshot?.runState).toBe("disconnected");
      expect(h.archived.hub.snapshot?.capabilities.deliveryModes).not.toContainEqual(
        expect.objectContaining({ id: "submit", available: true }),
      );
      expect(h.attach).toHaveBeenCalledOnce();
    } finally { subscriber.close(); await h.close(); }
  });

  it("shows current recovery state without execution while native restoration is uncertain", async () => {
    const h = await fixture();
    const subscriber = h.archived.hub.subscribe(() => undefined);
    h.archived.release();
    const binding = h.bindings.getBinding(h.scope, h.threadId)!;
    new NativeArchiveOperationRepository(h.database).begin(h.scope, {
      ...binding, createdAt: new Date(binding.createdAt).toISOString(),
    }, "restore");
    try {
      await h.restore();
      expect(h.archived.hub.snapshot?.thread.inventoryState).toBe("active");
      expect(h.archived.hub.snapshot?.recovery).toMatchObject({ kind: "operation_uncertain", recoverable: true });
      expect(h.archived.hub.snapshot?.capabilities.deliveryModes).not.toContainEqual(
        expect.objectContaining({ id: "submit", available: true }),
      );
      expect(h.attach).not.toHaveBeenCalled();
    } finally { subscriber.close(); await h.close(); }
  });

  it("does not execute for another principal or an unchanged archive", async () => {
    const h = await fixture();
    const subscriber = h.archived.hub.subscribe(() => undefined);
    h.archived.release();
    try {
      await expect(h.restore({ ...h.scope, principalId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
      await h.runtimes.runWithRuntimeRetired(h.scope, h.threadId, async () => undefined);
      await h.threadSnapshots.publish(h.scope, h.threadId);
      expect(h.archived.hub.snapshot?.thread.inventoryState).toBe("archived");
      expect(h.archived.hub.snapshot?.capabilities.deliveryModes).not.toContainEqual(
        expect.objectContaining({ id: "submit", available: true }),
      );
      expect(h.attach).not.toHaveBeenCalled();
    } finally { subscriber.close(); await h.close(); }
  });
});
