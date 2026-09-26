import { describe, expect, it, vi } from "vitest";
import { ThreadForceResetService } from "../../src/server/domain/thread-force-reset-service.js";

const scope = { tenantId: "tenant", principalId: "principal" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function committed() {
  return {
    resetAt: 200,
    blockerFingerprint: "fingerprint",
    resetBlockers: [{ kind: "conversation_operation" as const, count: 1 }],
    affectedThreadIds: ["thread-1"],
    promotedTaskIds: [],
    replayed: false,
    resetConversationRuntimes: [],
  };
}

function impact() {
  return {
    blockerFingerprint: "fingerprint",
    resettable: true,
    blockers: [{ kind: "conversation_operation" as const, count: 1 }],
    affectedThreads: [{ threadId: "thread-1", title: "Thread" }],
    warnings: [],
  };
}

const noPendingInteractions = {
  listPending: () => [],
  abandonPending: async () => undefined,
};

const noLoadedRuntimes = {
  captureLoadedRuntime: vi.fn(async () => undefined),
  forceResetLoadedRuntime: vi.fn(async () => false),
};

const runtime = {
  kind: "conversation_runtime" as const,
  threadId: "thread-1",
  generation: "generation-1",
  runState: "running" as const,
  activeTurnId: "turn-1",
};

describe("ThreadForceResetService", () => {
  it("awaits exact loaded runtime replacement before scheduling application publication", async () => {
    const gate = deferred();
    const order: string[] = [];
    const forceResetLoadedRuntime = vi.fn(async () => {
      order.push("replacement-started");
      await gate.promise;
      order.push("replacement-finished");
      return true;
    });
    const scheduleThreadPublications = vi.fn(() => {
      order.push("application-scheduled");
    });
    const service = new ThreadForceResetService({
      repository: {
        impact: vi.fn(() => impact()),
        forceReset: vi.fn(() => ({
          ...committed(),
          resetConversationRuntimes: [runtime],
        })),
      } as never,
      interactions: noPendingInteractions,
      runtimes: {
        captureLoadedRuntime: vi.fn(async () => runtime),
        forceResetLoadedRuntime,
      },
      scheduleThreadPublications,
      now: () => 200,
    });

    let settled = false;
    const reset = service
      .forceReset(scope, "thread-1", {
        expectedBlockerFingerprint: "fingerprint",
        mutationId: "mutation-1",
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() =>
      expect(forceResetLoadedRuntime).toHaveBeenCalledOnce(),
    );
    expect(settled).toBe(false);
    expect(scheduleThreadPublications).not.toHaveBeenCalled();

    gate.resolve();
    await expect(reset).resolves.toMatchObject({
      resetAt: 200,
      affectedThreadIds: ["thread-1"],
    });
    expect(order).toEqual([
      "replacement-started",
      "replacement-finished",
      "application-scheduled",
    ]);
  });

  it("reports a runtime replacement failure without failing the committed reset", async () => {
    const failure = new Error("replacement failed");
    const onPostCommitError = vi.fn(() => {
      throw new Error("diagnostic observer failed");
    });
    const scheduleThreadPublications = vi.fn();
    const service = new ThreadForceResetService({
      repository: {
        impact: vi.fn(() => impact()),
        forceReset: vi.fn(() => ({
          ...committed(),
          resetConversationRuntimes: [runtime],
        })),
      } as never,
      interactions: noPendingInteractions,
      runtimes: {
        captureLoadedRuntime: vi.fn(async () => runtime),
        forceResetLoadedRuntime: vi.fn(async () => {
          throw failure;
        }),
      },
      scheduleThreadPublications,
      onPostCommitError,
      now: () => 200,
    });

    await expect(
      service.forceReset(scope, "thread-1", {
        expectedBlockerFingerprint: "fingerprint",
        mutationId: "mutation-1",
      }),
    ).resolves.toMatchObject({ resetAt: 200 });
    expect(onPostCommitError).toHaveBeenCalledWith(failure);
    expect(scheduleThreadPublications).toHaveBeenCalledWith(scope, [
      "thread-1",
    ]);
  });

  it("previews and locally abandons exact pending interactions before replacement publication", async () => {
    const order: string[] = [];
    const pending = [{ id: "pending-approval" }];
    const repository = {
      impact: vi.fn(
        (
          _scope: typeof scope,
          _threadId: string,
          pendingInteractions: readonly {
            readonly kind: "pending_interaction";
            readonly id: string;
            readonly threadId: string;
          }[] = [],
        ) => ({
          blockerFingerprint:
            pendingInteractions.length === 0 ? "database" : "combined",
          resettable: pendingInteractions.length > 0,
          blockers:
            pendingInteractions.length === 0
              ? []
              : [{ kind: "pending_interaction" as const, count: 1 }],
          affectedThreads: [{ threadId: "thread-1", title: "Thread" }],
          warnings: [],
        }),
      ),
      forceReset: vi.fn(() => ({
        resetAt: 200,
        blockerFingerprint: "combined",
        resetBlockers: [{ kind: "pending_interaction" as const, count: 1 }],
        affectedThreadIds: ["thread-1"],
        promotedTaskIds: [],
        replayed: false,
        resetConversationRuntimes: [],
      })),
    };
    const denied = deferred();
    const interactions = {
      listPending: vi.fn(() => pending),
      abandonPending: vi.fn(async () => {
        order.push("interactions-abandoned");
        await denied.promise;
        order.push("provider-denied");
      }),
    };
    const service = new ThreadForceResetService({
      repository: repository as never,
      interactions,
      runtimes: {
        ...noLoadedRuntimes,
        forceResetLoadedRuntime: vi.fn(async () => {
          order.push("replacement-published");
          return true;
        }),
      },
      now: () => 200,
    });

    await expect(service.impact(scope, "thread-1")).resolves.toMatchObject({
      resettable: true,
      blockerFingerprint: "combined",
      blockers: [{ kind: "pending_interaction", count: 1 }],
    });
    const reset = service.forceReset(scope, "thread-1", {
      expectedBlockerFingerprint: "combined",
      mutationId: "mutation-pending",
    });
    await vi.waitFor(() => expect(order).toEqual(["interactions-abandoned"]));
    // The provider denial is delivered before the runtime can be replaced.
    denied.resolve();
    await expect(reset).resolves.toMatchObject({
      resetBlockers: [{ kind: "pending_interaction", count: 1 }],
    });

    expect(repository.forceReset).toHaveBeenCalledWith(scope, "thread-1", {
      expectedBlockerFingerprint: "combined",
      mutationId: "mutation-pending",
      now: 200,
      conversationRuntimes: [],
      pendingInteractions: [
        {
          kind: "pending_interaction",
          id: "pending-approval",
          threadId: "thread-1",
        },
      ],
    });
    expect(interactions.abandonPending).toHaveBeenCalledWith(
      scope,
      "thread-1",
      ["pending-approval"],
    );
    expect(order).toEqual(["interactions-abandoned", "provider-denied"]);
  });

  it("replaces the runtime after a bounded wait when a provider cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const interactions = {
        listPending: vi.fn(() => [{ id: "stuck-approval" }]),
        abandonPending: vi.fn(() => never),
      };
      const forceResetLoadedRuntime = vi.fn(async () => true);
      const scheduleThreadPublications = vi.fn();
      const service = new ThreadForceResetService({
        repository: {
          impact: vi.fn(() => impact()),
          forceReset: vi.fn(() => ({
            ...committed(),
            resetConversationRuntimes: [runtime],
          })),
        } as never,
        interactions,
        runtimes: {
          captureLoadedRuntime: vi.fn(async () => runtime),
          forceResetLoadedRuntime,
        },
        scheduleThreadPublications,
        now: () => 400,
      });
      let settled = false;
      const reset = service
        .forceReset(scope, "thread-1", {
          expectedBlockerFingerprint: "fingerprint",
          mutationId: "stuck-cancellation",
        })
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(interactions.abandonPending).toHaveBeenCalledWith(
        scope,
        "thread-1",
        ["stuck-approval"],
      );
      expect(forceResetLoadedRuntime).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(reset).resolves.toMatchObject({
        affectedThreadIds: ["thread-1"],
      });
      expect(forceResetLoadedRuntime).toHaveBeenCalledWith(
        scope,
        "thread-1",
        runtime,
      );
      expect(scheduleThreadPublications).toHaveBeenCalledWith(scope, [
        "thread-1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abandon interactions opened after a force-reset receipt replay", async () => {
    const interactions = {
      listPending: vi.fn(() => [{ id: "new-approval" }]),
      abandonPending: vi.fn(async () => undefined),
    };
    const forceResetLoadedRuntime = vi.fn(async () => true);
    const service = new ThreadForceResetService({
      repository: {
        impact: vi.fn(() => impact()),
        forceReset: vi.fn(() => ({ ...committed(), replayed: true })),
      } as never,
      interactions,
      runtimes: {
        captureLoadedRuntime: vi.fn(async () => ({
          ...runtime,
          generation: "newer-generation",
        })),
        forceResetLoadedRuntime,
      },
      now: () => 300,
    });

    await service.forceReset(scope, "thread-1", {
      expectedBlockerFingerprint: "fingerprint",
      mutationId: "replayed-mutation",
    });

    expect(interactions.abandonPending).not.toHaveBeenCalled();
    expect(forceResetLoadedRuntime).not.toHaveBeenCalled();
  });
});
