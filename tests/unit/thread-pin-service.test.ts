import { describe, expect, it, vi } from "vitest";
import { InventoryService } from "../../src/server/domain/inventory-service.js";

describe("InventoryService thread pinning", () => {
  it("publishes only the application thread projection after persistence", async () => {
    const scope = { tenantId: "tenant", principalId: "principal" };
    const setThreadPinned = vi.fn(() => ({
      pinned: true,
      pinRevision: 1,
      replayed: false,
    }));
    const publishThreadChange = vi.fn(async () => undefined);
    const service = new InventoryService(
      { setThreadPinned } as never,
      {
        publishMany() {},
        publishApplicationThread: publishThreadChange,
      },
    );

    await service.setPinned(
      scope,
      "thread",
      {
        pinned: true,
        expectedRevision: 0,
        mutationId: "11111111-1111-4111-8111-111111111111",
      },
      100,
    );

    expect(setThreadPinned).toHaveBeenCalledWith(scope, "thread", {
      pinned: true,
      expectedRevision: 0,
      mutationId: "11111111-1111-4111-8111-111111111111",
      now: 100,
    });
    expect(publishThreadChange).toHaveBeenCalledWith(scope, "thread");
  });

  it("keeps a committed pin successful and retries a failed application publication", async () => {
    const scope = { tenantId: "tenant", principalId: "principal" };
    const repository = {
      setThreadPinned: vi.fn(() => ({
        pinned: true,
        pinRevision: 1,
        replayed: false,
      })),
      getNearestSnoozeDeadline: vi.fn(() => null),
      wakeDueSnoozes: vi.fn(() => []),
    };
    const publishApplicationThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockResolvedValue(undefined);
    const onRetryPending = vi.fn();
    const service = new InventoryService(repository as never, {
      publishMany() {},
      publishApplicationThread,
      onRetryPending,
    });

    await expect(
      service.setPinned(
        scope,
        "thread",
        {
          pinned: true,
          expectedRevision: 0,
          mutationId: "11111111-1111-4111-8111-111111111111",
        },
        100,
      ),
    ).resolves.toBeUndefined();
    expect(onRetryPending).toHaveBeenCalledOnce();
    expect(service.getNearestDeadline()).toBe(1_100);

    await service.wakeDue(1_100);

    expect(publishApplicationThread).toHaveBeenCalledTimes(2);
    expect(service.getNearestDeadline()).toBeNull();
  });
});
