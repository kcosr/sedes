import { describe, expect, it, vi } from "vitest";
import { InventoryService } from "../../src/server/domain/inventory-service.js";

const scope = { tenantId: "tenant", principalId: "principal" };

describe("inventory restore maintenance", () => {
  it("holds restoration maintenance across commit and native restore, then publishes after release", async () => {
    const order: string[] = [];
    const state = { ...scope, threadId: "thread", inventoryState: "active", inventoryRevision: 1 };
    const transitionInventory = vi.fn(() => { order.push("commit"); return { state }; });
    const publishMany = vi.fn(async () => { order.push("publish"); });
    const service = new InventoryService({
      transitionInventory, getInventory: () => ({ inventoryState: "archived" }),
    } as never, {
      publishMany, publishApplicationThread: vi.fn(async () => undefined),
    }, undefined, {
      async run(eventScope, threadId, operation) {
        expect(eventScope).toEqual(scope);
        expect(threadId).toBe("thread");
        order.push("fence");
        const committed = await operation();
        order.push("native-restore");
        order.push("release");
        return committed;
      },
    });
    await service.transition(scope, "thread", {
      change: { action: "restore" }, expectedRevision: 0, mutationId: "restore",
    });
    expect(order).toEqual(["fence", "commit", "native-restore", "release", "publish"]);
    expect(transitionInventory).toHaveBeenCalledOnce();
  });

  it("does not perform restoration maintenance for unrelated inventory transitions", async () => {
    const run = vi.fn();
    const service = new InventoryService({
      transitionInventory: vi.fn(() => ({ state: { threadId: "thread", inventoryState: "settled" } })),
    } as never, {
      publishMany: vi.fn(), publishApplicationThread: vi.fn(async () => undefined),
    }, undefined, { run });
    await service.transition(scope, "thread", {
      change: { action: "settle" }, expectedRevision: 0, mutationId: "settle",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("validates an active restore replay without retiring work that started afterward", async () => {
    const run = vi.fn(async () => { throw new Error("runtime_has_active_work"); });
    const state = { threadId: "thread", inventoryState: "active", inventoryRevision: 1 };
    const transitionInventory = vi.fn(() => ({ state, replayed: true }));
    const service = new InventoryService({
      transitionInventory, getInventory: () => state,
    } as never, {
      publishMany: vi.fn(), publishApplicationThread: vi.fn(async () => undefined),
    }, undefined, { run });
    await expect(service.transition(scope, "thread", {
      change: { action: "restore" }, expectedRevision: 0, mutationId: "restore-replay",
    })).resolves.toEqual(state);
    expect(transitionInventory).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});
