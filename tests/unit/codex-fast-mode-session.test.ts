import { describe, expect, it, vi } from "vitest";
import type { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";

const scope = { tenantId: "tenant-one", principalId: "principal-one" };

describe("Codex Fast mode session authority", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "independently admits Fast=%s and Ultrafast=%s while retaining Standard",
    async (fastEnabled, ultrafastEnabled) => {
      const requestWithReceipt = vi.fn(async (method: { method: string }) => ({
        generation: 4, inboundSequence: 1,
        result: method.method === "experimentalFeature/list" ? {
          data: [feature("fast_mode", fastEnabled), feature("ultrafast_mode", ultrafastEnabled)], nextCursor: null,
        } : {},
      }));
      const client = { lifecycleSnapshot: () => ({ state: "ready", generation: 4 }), requestWithReceipt } as unknown as CodexSharedClientFacade;
      const registry = new CodexFastModeSessionRegistry();
      expect(await registry.refresh({ scope, applicationThreadId: "thread-one", nativeThreadId: "native-one", connectionGeneration: 4, client }))
        .toMatchObject({ fastEnabled, ultrafastEnabled, availability: fastEnabled || ultrafastEnabled ? "available" : "unavailable" });
      for (const [selection, enabled] of [["standard", true], ["fast", fastEnabled], ["ultrafast", ultrafastEnabled]] as const) {
        const before = requestWithReceipt.mock.calls.length;
        const sync = registry.syncServiceTier(scope, "thread-one", selection);
        if (enabled) {
          await expect(sync).resolves.toBeUndefined();
          expect(requestWithReceipt).toHaveBeenCalledTimes(before + 1);
        } else {
          await expect(sync).rejects.toThrow("codex_fast_mode_session_unavailable");
          expect(requestWithReceipt).toHaveBeenCalledTimes(before);
        }
      }
      await expect(registry.syncServiceTier({ ...scope, principalId: "other" }, "thread-one", "standard"))
        .rejects.toThrow("codex_fast_mode_session_unavailable");
    },
  );

  it("does not infer an absent Ultrafast flag from Fast", async () => {
    const client = {
      lifecycleSnapshot: () => ({ state: "ready", generation: 4 }),
      requestWithReceipt: vi.fn(async () => ({ generation: 4, inboundSequence: 1,
        result: { data: [feature("fast_mode", true)], nextCursor: null } })),
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();
    await registry.refresh({ scope, applicationThreadId: "thread-one", nativeThreadId: "native-one", connectionGeneration: 4, client });
    expect(registry.projection(scope, "thread-one")).toMatchObject({ fastEnabled: true, ultrafastEnabled: false });
    await expect(registry.syncServiceTier(scope, "thread-one", "ultrafast")).rejects.toThrow("codex_fast_mode_session_unavailable");
  });

  it("replaces independent policies after reconnect without reusing prior-generation admission", async () => {
    let generation = 4;
    const client = {
      lifecycleSnapshot: () => ({ state: "ready", generation }),
      requestWithReceipt: vi.fn(async (method: { method: string }) => ({ generation, inboundSequence: 1,
        result: method.method === "experimentalFeature/list" ? { data: [feature("fast_mode", generation === 4), feature("ultrafast_mode", generation === 5)], nextCursor: null } : {} })),
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();
    const refresh = () => registry.refresh({ scope, applicationThreadId: "thread-one", nativeThreadId: "native-one", connectionGeneration: generation, client });
    await refresh();
    expect(registry.projection(scope, "thread-one")).toMatchObject({ fastEnabled: true, ultrafastEnabled: false });
    generation = 5;
    expect(registry.projection(scope, "thread-one")).toMatchObject({ availability: "unavailable", unavailableReason: "generation_changed" });
    await expect(registry.syncServiceTier(scope, "thread-one", "fast")).rejects.toThrow("codex_fast_mode_generation_changed");
    await refresh();
    expect(registry.projection(scope, "thread-one")).toMatchObject({ fastEnabled: false, ultrafastEnabled: true, availability: "available" });
    await expect(registry.syncServiceTier(scope, "thread-one", "fast")).rejects.toThrow("codex_fast_mode_session_unavailable");
    await expect(registry.syncServiceTier(scope, "thread-one", "ultrafast")).resolves.toBeUndefined();
  });

  it("paginates loaded-thread feature state and generation-fences projection and sync", async () => {
    let generation = 4;
    const requestWithReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        generation: 4,
        inboundSequence: 1,
        result: {
          data: [feature("other_feature", false)],
          nextCursor: "page-two",
        },
      })
      .mockResolvedValueOnce({
        generation: 4,
        inboundSequence: 2,
        result: {
          data: [feature("fast_mode", true)],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        generation: 4,
        inboundSequence: 3,
        result: {},
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();

    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 4,
        client,
      }),
    ).resolves.toMatchObject({ fastEnabled: true, availability: "available" });
    expect(requestWithReceipt.mock.calls[1]?.[1]).toMatchObject({
      threadId: "native-one",
      cursor: "page-two",
    });

    await registry.syncServiceTier(scope, "thread-one", "fast");
    expect(requestWithReceipt.mock.calls[2]?.[1]).toEqual({
      threadId: "native-one",
      serviceTier: "priority",
    });

    generation = 5;
    expect(registry.projection(scope, "thread-one")).toMatchObject({
      fastEnabled: true,
      availability: "unavailable",
      unavailableReason: "generation_changed",
    });
    await expect(
      registry.syncServiceTier(scope, "thread-one", "standard"),
    ).rejects.toThrow("codex_fast_mode_generation_changed");
  });

  it("fails closed on a repeated pagination cursor", async () => {
    const requestWithReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        generation: 2,
        inboundSequence: 1,
        result: { data: [], nextCursor: "repeat" },
      })
      .mockResolvedValueOnce({
        generation: 2,
        inboundSequence: 2,
        result: { data: [], nextCursor: "repeat" },
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 2 }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();

    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 2,
        client,
      }),
    ).resolves.toMatchObject({
      fastEnabled: false,
      availability: "unavailable",
      unavailableReason: "feature_unavailable",
    });
  });

  it.each(["fast_mode", "ultrafast_mode"])("fails closed when %s is not stable", async (name) => {
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 3 }),
      requestWithReceipt: vi.fn().mockResolvedValue({
        generation: 3,
        inboundSequence: 1,
        result: {
          data: [{ ...feature(name, true), stage: "beta" }],
          nextCursor: null,
        },
      }),
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();

    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 3,
        client,
      }),
    ).resolves.toMatchObject({
      fastEnabled: false,
      availability: "unavailable",
      unavailableReason: "feature_unavailable",
    });
  });

  it("recovers transient feature discovery within the same daemon generation", async () => {
    const requestWithReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary feature-list failure"))
      .mockResolvedValueOnce({
        generation: 6,
        inboundSequence: 2,
        result: {
          data: [feature("fast_mode", true)],
          nextCursor: null,
        },
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 6 }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    const onRecovered = vi.fn();
    const registry = new CodexFastModeSessionRegistry({
      recoveryDelaysMilliseconds: [0],
    });

    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 6,
        client,
        onRecovered,
      }),
    ).resolves.toMatchObject({
      availability: "unavailable",
      unavailableReason: "feature_unavailable",
    });
    await vi.waitFor(() =>
      expect(onRecovered).toHaveBeenCalledWith(
        expect.objectContaining({
          fastEnabled: true,
          availability: "available",
        }),
      ),
    );
    expect(registry.projection(scope, "thread-one")).toMatchObject({
      fastEnabled: true,
      availability: "available",
    });
    expect(requestWithReceipt).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight recovery overwrite a newer daemon generation", async () => {
    let generation = 6;
    let resolveRecovery!: (value: {
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }) => void;
    const recoveryResponse = new Promise<{
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }>((resolve) => {
      resolveRecovery = resolve;
    });
    const requestWithReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary feature-list failure"))
      .mockImplementationOnce(async () => await recoveryResponse)
      .mockResolvedValueOnce({
        generation: 7,
        inboundSequence: 3,
        result: {
          data: [feature("fast_mode", true)],
          nextCursor: null,
        },
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    const onRecovered = vi.fn();
    const registry = new CodexFastModeSessionRegistry({
      recoveryDelaysMilliseconds: [0],
    });

    await registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 6,
      client,
      onRecovered,
    });
    await vi.waitFor(() => expect(requestWithReceipt).toHaveBeenCalledTimes(2));

    generation = 7;
    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 7,
        client,
      }),
    ).resolves.toMatchObject({ fastEnabled: true, availability: "available" });

    resolveRecovery({
      generation: 6,
      inboundSequence: 2,
      result: {
        data: [feature("fast_mode", false)],
        nextCursor: null,
      },
    });
    await vi.waitFor(() =>
      expect(registry.projection(scope, "thread-one")).toMatchObject({
        fastEnabled: true,
        availability: "available",
      }),
    );
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("replaces a recovery owned by an inactive handle in the same generation", async () => {
    const requestWithReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("old handle discovery failure"))
      .mockRejectedValueOnce(new Error("new handle discovery failure"))
      .mockResolvedValueOnce({
        generation: 8,
        inboundSequence: 3,
        result: {
          data: [feature("fast_mode", true)],
          nextCursor: null,
        },
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 8 }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    let oldHandleActive = true;
    const oldOnRecovered = vi.fn();
    const newOnRecovered = vi.fn();
    const registry = new CodexFastModeSessionRegistry({
      recoveryDelaysMilliseconds: [10],
    });

    await registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 8,
      client,
      onRecovered: oldOnRecovered,
      shouldRecover: () => oldHandleActive,
    });
    oldHandleActive = false;
    await registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 8,
      client,
      onRecovered: newOnRecovered,
      shouldRecover: () => true,
    });

    await vi.waitFor(() =>
      expect(newOnRecovered).toHaveBeenCalledWith(
        expect.objectContaining({
          fastEnabled: true,
          availability: "available",
        }),
      ),
    );
    expect(oldOnRecovered).not.toHaveBeenCalled();
    expect(requestWithReceipt).toHaveBeenCalledTimes(3);
  });

  it("fences an inactive owner's in-flight recovery within the same generation", async () => {
    let resolveOldRecovery!: (value: {
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }) => void;
    const oldRecoveryResponse = new Promise<{
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }>((resolve) => {
      resolveOldRecovery = resolve;
    });
    const requestWithReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("old handle discovery failure"))
      .mockImplementationOnce(async () => await oldRecoveryResponse)
      .mockRejectedValueOnce(new Error("new handle discovery failure"))
      .mockResolvedValueOnce({
        generation: 9,
        inboundSequence: 4,
        result: {
          data: [feature("fast_mode", true)],
          nextCursor: null,
        },
      });
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 9 }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    let oldHandleActive = true;
    const oldOnRecovered = vi.fn();
    const newOnRecovered = vi.fn();
    const registry = new CodexFastModeSessionRegistry({
      recoveryDelaysMilliseconds: [0],
    });

    await registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 9,
      client,
      onRecovered: oldOnRecovered,
      shouldRecover: () => oldHandleActive,
    });
    await vi.waitFor(() => expect(requestWithReceipt).toHaveBeenCalledTimes(2));

    oldHandleActive = false;
    await registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 9,
      client,
      onRecovered: newOnRecovered,
      shouldRecover: () => true,
    });
    await vi.waitFor(() =>
      expect(newOnRecovered).toHaveBeenCalledWith(
        expect.objectContaining({
          fastEnabled: true,
          availability: "available",
        }),
      ),
    );

    resolveOldRecovery({
      generation: 9,
      inboundSequence: 2,
      result: {
        data: [feature("fast_mode", false)],
        nextCursor: null,
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registry.projection(scope, "thread-one")).toMatchObject({
      fastEnabled: true,
      availability: "available",
    });
    expect(oldOnRecovered).not.toHaveBeenCalled();
    expect(requestWithReceipt).toHaveBeenCalledTimes(4);
  });

  it("does not let a stale generation displace a newer in-flight refresh authority", async () => {
    let resolveCurrentRefresh!: (value: {
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }) => void;
    const currentRefreshResponse = new Promise<{
      generation: number;
      inboundSequence: number;
      result: {
        data: ReturnType<typeof feature>[];
        nextCursor: null;
      };
    }>((resolve) => {
      resolveCurrentRefresh = resolve;
    });
    const requestWithReceipt = vi
      .fn()
      .mockImplementationOnce(async () => await currentRefreshResponse);
    const client = {
      lifecycleSnapshot: () => ({ state: "ready" as const, generation: 11 }),
      requestWithReceipt,
    } as unknown as CodexSharedClientFacade;
    const registry = new CodexFastModeSessionRegistry();

    const currentRefresh = registry.refresh({
      scope,
      applicationThreadId: "thread-one",
      nativeThreadId: "native-one",
      connectionGeneration: 11,
      client,
    });
    await vi.waitFor(() => expect(requestWithReceipt).toHaveBeenCalledTimes(1));

    await expect(
      registry.refresh({
        scope,
        applicationThreadId: "thread-one",
        nativeThreadId: "native-one",
        connectionGeneration: 10,
        client,
      }),
    ).resolves.toMatchObject({
      availability: "unavailable",
      unavailableReason: "generation_changed",
    });
    expect(requestWithReceipt).toHaveBeenCalledTimes(1);

    resolveCurrentRefresh({
      generation: 11,
      inboundSequence: 1,
      result: {
        data: [feature("fast_mode", true)],
        nextCursor: null,
      },
    });
    await expect(currentRefresh).resolves.toMatchObject({
      fastEnabled: true,
      availability: "available",
    });
    expect(registry.projection(scope, "thread-one")).toMatchObject({
      fastEnabled: true,
      availability: "available",
    });
  });
});

function feature(name: string, enabled: boolean) {
  return {
    name,
    stage: "stable",
    displayName: name,
    description: null,
    announcement: null,
    enabled,
    defaultEnabled: false,
  };
}
