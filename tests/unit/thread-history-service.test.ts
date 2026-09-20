import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../src/shared/protocol/payload.js";
import type { ConversationActorSnapshotState } from "../../src/server/conversations/conversation-actor.js";
import { MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES } from "../../src/server/conversations/conversation-actor.js";
import { ThreadHistoryService } from "../../src/server/conversations/thread-history-service.js";
import type { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function actorState(): ConversationActorSnapshotState {
  return {
    timeline: {
      generation: "projection-1",
      orderedTurnIds: ["turn-current"],
      turnsById: {
        "turn-current": {
          id: "turn-current",
          revision: 0,
          status: "completed",
          endedBy: "agent_settled",
          orderedItemIds: [],
        },
      },
      itemsById: {},
      runState: "idle",
    },
    backendCapabilities: {
      revision: "capabilities-1",
      actions: [],
      deliveryModes: ["submit"],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "unavailable",
        reason: { text: "Branching is unavailable in this fixture." },
      },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: {},
    },
    usage: {},
    history: {
      operational: true,
      previousCursor: "pi-history:native-secret",
    },
  };
}

function applicationSnapshot(
  state: ConversationActorSnapshotState = actorState(),
): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: state.timeline.runState,
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Workspace" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Machine" },
      available: true,
      directoryBrowsing: "available" as const,
    },
    draft: {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 0,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: [...state.timeline.orderedTurnIds],
    turnsById: { ...state.timeline.turnsById },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: {
          text: "Branching is unavailable in this fixture.",
        },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Latest provider snapshot forking is unavailable in this fixture.",
        },
      },
    },
    forksByTurnId: Object.fromEntries(
      state.timeline.orderedTurnIds.map((turnId) => [
        turnId,
        {
          sourceTurnId: turnId,
          expectedTurnRevision: state.timeline.turnsById[turnId]?.revision ?? 0,
          available: false,
          unavailableReason: {
            text: "Branching is unavailable in this fixture.",
          },
        },
      ]),
    ),
    itemsById: { ...state.timeline.itemsById },
    history: { hasOlder: false },
    runState: state.timeline.runState,
    queue: [],
    capabilities: {
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        nativeImage: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        policy: {
          maximumAttachments: 8,
          maximumImages: 4,
          maximumAggregateBytes: 67_108_864,
          maximumFileBytes: 26_214_400,
          maximumImageBytes: 16_777_216,
          maximumImagePixels: 40_000_000,
          maximumImageDimension: 16_384,
          imageMediaTypes: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ],
        },
      },
      revision: "capabilities-1",
      backend: { label: { text: "Pi" } },
      interactionMode: "interactive",
      runState: state.timeline.runState,
      operations: [],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      history: { available: true, paginated: true },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun: true,
      },
    },
    settings: { revision: 0, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}

function snapshotNearByteLimit(
  remainingBytes: number,
): NormalizedThreadSnapshot {
  const base = applicationSnapshot();
  const createdAt = "2026-07-30T15:00:00.000Z";
  const stashes = Array.from({ length: 133 }, (_, index) => ({
    id: `padding-${index}`,
    text: "x".repeat(251_500),
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    createdAt,
  }));
  const withEmptyTail = {
    ...base,
    stashes: [
      ...stashes,
      {
        id: "padding-tail",
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt,
      },
    ],
  };
  const target = MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - remainingBytes;
  const tailLength = target - serializedUtf8Bytes(withEmptyTail);
  if (tailLength < 0 || tailLength > 262_144) {
    throw new Error("test_snapshot_padding_invalid");
  }
  return {
    ...withEmptyTail,
    stashes: [
      ...stashes,
      {
        id: "padding-tail",
        text: "x".repeat(tailLength),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt,
      },
    ],
  };
}

function inventory() {
  return {
    getAuthorized: vi.fn(
      async (requestScope: RequestScope, applicationThreadId: string) => ({
        tenantId: requestScope.tenantId,
        ownerPrincipalId: requestScope.principalId,
        thread: { id: applicationThreadId },
      }),
    ),
  };
}

describe("ThreadHistoryService", () => {
  it("seeks a normalized source turn beyond the live window after restart", async () => {
    const targetTurnId = "turn-target-beyond-1000";
    const makeRuntime = () => {
      const locateTurn = vi.fn(async () => ({
        status: "found" as const,
        page: {
          orderedTurnIds: [targetTurnId],
          turnsById: {
            [targetTurnId]: {
              id: targetTurnId,
              revision: 0,
              status: "completed" as const,
              endedBy: "agent_settled" as const,
              orderedItemIds: [],
            },
          },
          forkSource: {
            selectedCompletedTurn: { available: true as const },
            latestProviderSnapshot: {
              available: false as const,
              unavailableReason: {
                text: "Latest provider snapshot forking is unsupported.",
              },
            },
          },
          forksByTurnId: {
            [targetTurnId]: {
              sourceTurnId: targetTurnId,
              expectedTurnRevision: 0,
              available: true as const,
            },
          },
          itemsById: {},
        },
      }));
      const release = vi.fn();
      return {
        locateTurn,
        release,
        coordinator: {
          acquire: vi.fn(async () => ({
            actor: {
              captureSnapshotState: vi.fn(async () => actorState()),
              locateTurn,
            },
            hub: { publish: vi.fn() },
            release,
          })),
        } as unknown as ThreadRuntimeCoordinator,
      };
    };

    for (let restart = 0; restart < 2; restart += 1) {
      const runtime = makeRuntime();
      const service = new ThreadHistoryService({
        inventory: inventory() as never,
      });
      service.bindRuntimes(runtime.coordinator);

      const result = await service.seekTurn(scope, "thread-1", targetTurnId);

      expect(result.status).toBe("found");
      if (result.status !== "found") throw new Error("expected found turn");
      expect(result.page.turnsById[targetTurnId]).toBeDefined();
      expect(result.page.previousCursor).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("provider-secret");
      expect(runtime.locateTurn).toHaveBeenCalledWith({
        targetTurnId,
        maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES,
      });
      expect(runtime.release).toHaveBeenCalledOnce();
    }
  });

  it("stops a targeted seek at the explicit total-work bound", async () => {
    const locateTurn = vi.fn(async () => ({
      status: "search_limit_reached" as const,
    }));
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: {
          captureSnapshotState: vi.fn(async () => actorState()),
          locateTurn,
        },
        hub: { publish: vi.fn() },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);

    const result = await service.seekTurn(scope, "thread-1", "turn-too-deep");

    expect(result).toMatchObject({
      status: "unavailable",
      targetTurnId: "turn-too-deep",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(locateTurn).toHaveBeenCalledWith({
      targetTurnId: "turn-too-deep",
      maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns authoritative absence from targeted lookup", async () => {
    const locateTurn = vi.fn(async () => ({ status: "not_found" as const }));
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: {
          captureSnapshotState: vi.fn(async () => actorState()),
          locateTurn,
        },
        hub: { publish: vi.fn() },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);

    await expect(
      service.seekTurn(scope, "thread-1", "turn-absent"),
    ).resolves.toEqual({ status: "not_found", targetTurnId: "turn-absent" });
    expect(locateTurn).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the live window without invoking targeted history lookup", async () => {
    const locateTurn = vi.fn();
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: {
          captureSnapshotState: vi.fn(async () => actorState()),
          locateTurn,
        },
        hub: { publish: vi.fn() },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);

    const result = await service.seekTurn(scope, "thread-1", "turn-current");

    expect(result).toMatchObject({
      status: "found",
      targetTurnId: "turn-current",
    });
    expect(locateTurn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed when a backend does not expose normalized older history", async () => {
    const state: ConversationActorSnapshotState = {
      ...actorState(),
      history: { operational: false },
    };
    const history = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: {
          captureSnapshotState: vi.fn(async () => state),
          history,
        },
        hub: { publish: vi.fn() },
        release: vi.fn(),
      })),
    } as unknown as ThreadRuntimeCoordinator);

    await expect(
      service.seekTurn(scope, "thread-1", "turn-unavailable"),
    ).resolves.toMatchObject({
      status: "unavailable",
      retryable: false,
    });
    expect(history).not.toHaveBeenCalled();
  });

  it("fails closed before source-turn seek for another principal", async () => {
    const runtimes = {
      acquire: vi.fn(),
    } as unknown as ThreadRuntimeCoordinator;
    const scopedInventory = {
      getAuthorized: vi.fn(async () => ({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        thread: { id: "thread-1" },
      })),
    };
    const service = new ThreadHistoryService({
      inventory: scopedInventory as never,
    });
    service.bindRuntimes(runtimes);

    await expect(
      service.seekTurn(
        { tenantId: scope.tenantId, principalId: "foreign-principal" },
        "thread-1",
        "turn-private",
      ),
    ).rejects.toThrow("thread_history_scope_mismatch");
    expect(runtimes.acquire).not.toHaveBeenCalled();
  });

  it("wraps backend cursors and publishes exactly one retry-stable envelope", async () => {
    const publish = vi.fn((event) => ({
      eventId: "transport-1.4",
      projectionGeneration: "projection-1",
      event,
    }));
    const history = vi.fn(async () => ({
      generation: "projection-1",
      page: {
        orderedTurnIds: ["turn-older"],
        forkSource: {
          selectedCompletedTurn: { available: true },
          latestProviderSnapshot: {
            available: false,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        turnsById: {
          "turn-older": {
            id: "turn-older",
            revision: 0,
            status: "completed",
            orderedItemIds: [],
          },
        },
        forksByTurnId: {
          "turn-older": {
            sourceTurnId: "turn-older",
            expectedTurnRevision: 0,
            available: true,
          },
        },
        itemsById: {},
        previousCursor: "pi-history:next-native-secret",
      },
    }));
    const release = vi.fn();
    const runtimes = {
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator;
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes(runtimes);

    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    expect(window).toMatchObject({ hasOlder: true });
    if (!window.hasOlder) throw new Error("expected history cursor");
    expect(window.olderCursor).toMatch(/^history_[0-9a-f-]+$/);
    expect(window.olderCursor).not.toContain("pi-history");

    const first = await service.loadOlder(
      scope,
      "thread-1",
      window.olderCursor,
      10,
    );
    const retry = await service.loadOlder(
      scope,
      "thread-1",
      window.olderCursor,
      10,
    );
    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 25),
    ).rejects.toMatchObject({
      code: "cursor_invalid",
      message:
        "The conversation history cursor was already used with another page size.",
    });

    expect(retry).toBe(first);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith({
      cursor: "pi-history:native-secret",
      limit: 10,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const envelope = first as ThreadEventEnvelope;
    expect(envelope.event.type).toBe("history_prepend");
    if (envelope.event.type !== "history_prepend") {
      throw new Error("expected history prepend");
    }
    expect(envelope.event.page.previousCursor).toMatch(/^history_/);
    expect(envelope.event.page.previousCursor).not.toContain("pi-history");
  });

  it("rejects a concurrent cursor reuse with another page size", async () => {
    let resolveHistory!: (value: {
      generation: string;
      page: {
        orderedTurnIds: string[];
        turnsById: Record<string, never>;
        forkSource: {
          selectedCompletedTurn: {
            available: false;
            unavailableReason: { text: string };
          };
          latestProviderSnapshot: {
            available: false;
            unavailableReason: { text: string };
          };
        };
        forksByTurnId: Record<string, never>;
        itemsById: Record<string, never>;
      };
    }) => void;
    const history = vi.fn(
      () =>
        new Promise<Parameters<typeof resolveHistory>[0]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: {
          publish: vi.fn((event) => ({
            eventId: "transport-1.5",
            projectionGeneration: "projection-1",
            event,
          })),
        },
        release: vi.fn(),
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    const first = service.loadOlder(scope, "thread-1", window.olderCursor, 10);
    await vi.waitFor(() => expect(history).toHaveBeenCalledOnce());
    const sameLimit = service.loadOlder(
      scope,
      "thread-1",
      window.olderCursor,
      10,
    );
    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 25),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(history).toHaveBeenCalledOnce();
    resolveHistory({
      generation: "projection-1",
      page: {
        orderedTurnIds: [],
        turnsById: {},
        forkSource: {
          selectedCompletedTurn: {
            available: false,
            unavailableReason: { text: "No older history." },
          },
          latestProviderSnapshot: {
            available: false,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        forksByTurnId: {},
        itemsById: {},
      },
    });
    const [firstResult, sameLimitResult] = await Promise.all([
      first,
      sameLimit,
    ]);
    expect(sameLimitResult).toBe(firstResult);
    expect(firstResult).toMatchObject({
      event: { type: "history_prepend" },
    });
  });

  it("allows a failed cursor fetch to retry with another page size", async () => {
    const history = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValueOnce({
        generation: "projection-1",
        page: {
          orderedTurnIds: [],
          turnsById: {},
          forkSource: {
            selectedCompletedTurn: {
              available: false,
              unavailableReason: { text: "No older history." },
            },
            latestProviderSnapshot: {
              available: false,
              unavailableReason: {
                text: "Latest provider snapshot forking is unsupported.",
              },
            },
          },
          forksByTurnId: {},
          itemsById: {},
        },
      });
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: {
          publish: vi.fn((event) => ({
            eventId: "transport-1.5",
            projectionGeneration: "projection-1",
            event,
          })),
        },
        release: vi.fn(),
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 10),
    ).rejects.toThrow("provider temporarily unavailable");
    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 25),
    ).resolves.toMatchObject({ event: { type: "history_prepend" } });

    expect(history).toHaveBeenNthCalledWith(1, {
      cursor: "pi-history:native-secret",
      limit: 10,
    });
    expect(history).toHaveBeenNthCalledWith(2, {
      cursor: "pi-history:native-secret",
      limit: 25,
    });
  });

  it("fails closed for a cursor presented by another owner", async () => {
    const runtimes = {
      acquire: vi.fn(),
    } as unknown as ThreadRuntimeCoordinator;
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes(runtimes);
    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(
        { tenantId: scope.tenantId, principalId: "another-owner" },
        "thread-1",
        window.olderCursor,
        10,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(runtimes.acquire).not.toHaveBeenCalled();
  });

  it("does not expose a history window until runtime pagination is bound", () => {
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    expect(service.operational(actorState())).toBe(false);
    expect(
      service.window(scope, "thread-1", actorState(), applicationSnapshot()),
    ).toEqual({ hasOlder: false });
  });

  it("rejects a backend page that exceeds the requested whole-turn capacity", async () => {
    const history = vi.fn(async () => ({
      generation: "projection-1",
      page: {
        orderedTurnIds: ["older-1", "older-2"],
        forkSource: {
          selectedCompletedTurn: { available: true as const },
          latestProviderSnapshot: {
            available: false as const,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        turnsById: Object.fromEntries(
          ["older-1", "older-2"].map((id) => [
            id,
            {
              id,
              revision: 0,
              status: "completed" as const,
              orderedItemIds: [],
            },
          ]),
        ),
        forksByTurnId: Object.fromEntries(
          ["older-1", "older-2"].map((id) => [
            id,
            {
              sourceTurnId: id,
              expectedTurnRevision: 0,
              available: true,
            },
          ]),
        ),
        itemsById: {},
      },
    }));
    const publish = vi.fn((event) => ({
      eventId: "transport-1.7",
      projectionGeneration: "projection-1",
      event,
    }));
    const release = vi.fn();
    const runtimes = {
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator;
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes(runtimes);
    const initialState = actorState();
    const state: ConversationActorSnapshotState = {
      ...initialState,
      timeline: {
        ...initialState.timeline,
        orderedTurnIds: Array.from(
          { length: 999 },
          (_, index) => `turn-${index}`,
        ),
      },
    };
    const window = service.window(
      scope,
      "thread-1",
      state,
      applicationSnapshot(state),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 10),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: false,
      message:
        "The backend returned an invalid history page for the requested page size.",
    });
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith({
      cursor: "pi-history:native-secret",
      limit: 1,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an invalid backend page without adaptive retries", async () => {
    const history = vi.fn(async () => ({
      generation: "projection-1",
      page: {
        orderedTurnIds: ["missing-turn-record"],
        turnsById: {},
        itemsById: {},
      },
    }));
    const publish = vi.fn();
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 100),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: false,
      message:
        "The backend returned an invalid history page for the requested page size.",
    });
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith({
      cursor: "pi-history:native-secret",
      limit: 100,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects empty or repeated backend cursor pages that make no progress", async () => {
    for (const page of [
      {
        orderedTurnIds: ["turn-older"],
        turnsById: {},
        itemsById: {},
        previousCursor: "pi-history:native-secret",
      },
      {
        orderedTurnIds: [],
        turnsById: {},
        itemsById: {},
        previousCursor: "pi-history:different-but-empty",
      },
    ]) {
      const runtimes = {
        acquire: vi.fn(async () => ({
          actor: {
            history: vi.fn(async () => ({
              generation: "projection-1",
              page,
            })),
          },
          hub: { publish: vi.fn() },
          release: vi.fn(),
        })),
      } as unknown as ThreadRuntimeCoordinator;
      const service = new ThreadHistoryService({
        inventory: inventory() as never,
      });
      service.bindRuntimes(runtimes);
      const window = service.window(
        scope,
        "thread-1",
        actorState(),
        applicationSnapshot(),
      );
      if (!window.hasOlder) throw new Error("expected history cursor");

      await expect(
        service.loadOlder(scope, "thread-1", window.olderCursor, 10),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
    }
  });

  it("rejects an unsplittable whole turn without fabricating end of history", async () => {
    const history = vi.fn(async () => ({
      generation: "projection-1",
      page: {
        orderedTurnIds: ["older-large"],
        forkSource: {
          selectedCompletedTurn: { available: true as const },
          latestProviderSnapshot: {
            available: false as const,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        turnsById: {
          "older-large": {
            id: "older-large",
            revision: 0,
            status: "completed" as const,
            orderedItemIds: ["older-large:item"],
          },
        },
        forksByTurnId: {
          "older-large": {
            sourceTurnId: "older-large",
            expectedTurnRevision: 0,
            available: true,
          },
        },
        itemsById: {
          "older-large:item": {
            id: "older-large:item",
            turnId: "older-large",
            kind: "assistant_message" as const,
            status: "completed" as const,
            revision: 0,
            markdown: { text: "x".repeat(40_000) },
          },
        },
        previousCursor: "pi-history:before-large",
      },
    }));
    const publish = vi.fn();
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const initialState = actorState();
    const state: ConversationActorSnapshotState = {
      ...initialState,
      timeline: {
        ...initialState.timeline,
        orderedTurnIds: Array.from(
          { length: 999 },
          (_, index) => `turn-${index}`,
        ),
      },
    };
    const initial = snapshotNearByteLimit(10_000);
    const window = service.window(scope, "thread-1", state, initial);
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 5),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
      message:
        "One earlier conversation turn is too large to transfer within the normalized history window.",
    });
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith({
      cursor: "pi-history:native-secret",
      limit: 1,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not discard a real continuation merely because the terminal shape would fit", async () => {
    const placeholder = "history_00000000-0000-4000-8000-000000000000";
    const page = {
      orderedTurnIds: ["older-boundary"],
      forkSource: {
        selectedCompletedTurn: { available: true as const },
        latestProviderSnapshot: {
          available: false as const,
          unavailableReason: { text: "Unavailable." },
        },
      },
      turnsById: {
        "older-boundary": {
          id: "older-boundary",
          revision: 0,
          status: "completed" as const,
          orderedItemIds: ["older-boundary:item"],
        },
      },
      forksByTurnId: {
        "older-boundary": {
          sourceTurnId: "older-boundary",
          expectedTurnRevision: 0,
          available: true,
        },
      },
      itemsById: {
        "older-boundary:item": {
          id: "older-boundary:item",
          turnId: "older-boundary",
          kind: "assistant_message" as const,
          status: "completed" as const,
          revision: 0,
          markdown: { text: "boundary" },
        },
      },
      previousCursor: "pi-history:still-older",
    };
    const bytesAfter = (
      initial: NormalizedThreadSnapshot,
      history: { hasOlder: boolean; olderCursor?: string },
    ) => {
      const currentHistory = { hasOlder: true, olderCursor: placeholder };
      const current = { ...initial, history: currentHistory };
      const collectionBytes = (value: readonly unknown[] | object) =>
        serializedUtf8Bytes(value) - 2;
      return (
        serializedUtf8Bytes(current) +
        collectionBytes(page.orderedTurnIds) +
        1 +
        collectionBytes(page.turnsById) +
        1 +
        collectionBytes(page.forksByTurnId) +
        1 +
        collectionBytes(page.itemsById) +
        serializedUtf8Bytes(history) -
        serializedUtf8Bytes(currentHistory)
      );
    };
    const probe = snapshotNearByteLimit(10_000);
    const probeCandidate = bytesAfter(probe, {
      hasOlder: true,
      olderCursor: placeholder,
    });
    const historyGap =
      serializedUtf8Bytes({ hasOlder: true, olderCursor: placeholder }) -
      serializedUtf8Bytes({ hasOlder: false });
    const remainingBytes =
      10_000 +
      (probeCandidate - MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) -
      Math.floor(historyGap / 2);
    const initial = snapshotNearByteLimit(remainingBytes);
    expect(
      bytesAfter(initial, { hasOlder: true, olderCursor: placeholder }),
    ).toBeGreaterThan(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES);
    expect(bytesAfter(initial, { hasOlder: false })).toBeLessThanOrEqual(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    );

    const history = vi.fn(async (_input: { limit: number }) => ({
      generation: "projection-1",
      page,
    }));
    const publish = vi.fn();
    const release = vi.fn();
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release,
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const initialState = actorState();
    const state: ConversationActorSnapshotState = {
      ...initialState,
      timeline: {
        ...initialState.timeline,
        orderedTurnIds: Array.from(
          { length: 998 },
          (_, index) => `turn-${index}`,
        ),
      },
    };
    const window = service.window(scope, "thread-1", state, initial);
    if (!window.hasOlder) throw new Error("expected history cursor");

    await expect(
      service.loadOlder(scope, "thread-1", window.olderCursor, 5),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
      message:
        "One earlier conversation turn is too large to transfer within the normalized history window.",
    });
    expect(history.mock.calls.map(([input]) => input.limit)).toEqual([2, 1]);
    expect(publish).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("adaptively retries a structurally valid oversized multi-turn page", async () => {
    const page = (turnCount: number) => {
      const ids = Array.from(
        { length: turnCount },
        (_, index) => `large-turn-${index}`,
      );
      const itemIdsByTurn = new Map(
        ids.map((turnId) => [
          turnId,
          Array.from(
            { length: 260 },
            (_, itemIndex) => `${turnId}:item-${itemIndex}`,
          ),
        ]),
      );
      return {
        orderedTurnIds: ids,
        forkSource: {
          selectedCompletedTurn: { available: true as const },
          latestProviderSnapshot: {
            available: false as const,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        turnsById: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              id,
              revision: 0,
              status: "completed" as const,
              orderedItemIds: itemIdsByTurn.get(id)!,
            },
          ]),
        ),
        forksByTurnId: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              sourceTurnId: id,
              expectedTurnRevision: 0,
              available: true,
            },
          ]),
        ),
        itemsById: Object.fromEntries(
          ids.flatMap((turnId) =>
            itemIdsByTurn.get(turnId)!.map((itemId) => [
              itemId,
              {
                id: itemId,
                turnId,
                kind: "assistant_message" as const,
                status: "completed" as const,
                revision: 0,
                markdown: { text: "x".repeat(65_536) },
              },
            ]),
          ),
        ),
        previousCursor: `pi-history:before-${turnCount}`,
      };
    };
    const history = vi.fn(async ({ limit }: { limit: number }) => ({
      generation: "projection-1",
      page: page(limit === 1 ? 1 : 2),
    }));
    const publish = vi.fn((event) => ({
      eventId: "transport-1.85",
      projectionGeneration: "projection-1",
      event,
    }));
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes({
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release: vi.fn(),
      })),
    } as unknown as ThreadRuntimeCoordinator);
    const window = service.window(
      scope,
      "thread-1",
      actorState(),
      applicationSnapshot(),
    );
    if (!window.hasOlder) throw new Error("expected history cursor");

    const envelope = await service.loadOlder(
      scope,
      "thread-1",
      window.olderCursor,
      5,
    );

    expect(history.mock.calls.map(([input]) => input.limit)).toEqual([5, 2, 1]);
    expect(envelope.event).toMatchObject({
      type: "history_prepend",
      page: { orderedTurnIds: ["large-turn-0"] },
    });
    if (envelope.event.type !== "history_prepend") {
      throw new Error("expected history prepend");
    }
    expect(serializedUtf8Bytes(envelope.event.page)).toBeLessThanOrEqual(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it("shrinks history requests to the newest whole-turn suffix that fits the cumulative byte budget", async () => {
    const largeText = "x".repeat(40_000);
    const page = (count: number) => {
      const ids = count === 1 ? ["older-near"] : ["older-far", "older-near"];
      return {
        orderedTurnIds: ids,
        forkSource: {
          selectedCompletedTurn: { available: true as const },
          latestProviderSnapshot: {
            available: false as const,
            unavailableReason: {
              text: "Latest provider snapshot forking is unsupported.",
            },
          },
        },
        turnsById: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              id,
              revision: 0,
              status: "completed" as const,
              orderedItemIds: [`${id}:item`],
            },
          ]),
        ),
        forksByTurnId: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              sourceTurnId: id,
              expectedTurnRevision: 0,
              available: true,
            },
          ]),
        ),
        itemsById: Object.fromEntries(
          ids.map((id) => [
            `${id}:item`,
            {
              id: `${id}:item`,
              turnId: id,
              kind: "assistant_message" as const,
              status: "completed" as const,
              revision: 0,
              markdown: { text: largeText },
            },
          ]),
        ),
        previousCursor:
          count === 1 ? "pi-history:before-near" : "pi-history:before-far",
      };
    };
    const history = vi.fn(async ({ limit }: { limit: number }) => ({
      generation: "projection-1",
      page: page(limit === 1 ? 1 : 2),
    }));
    const publish = vi.fn((event) => ({
      eventId: "transport-1.9",
      projectionGeneration: "projection-1",
      event,
    }));
    const runtimes = {
      acquire: vi.fn(async () => ({
        actor: { history },
        hub: { publish },
        release: vi.fn(),
      })),
    } as unknown as ThreadRuntimeCoordinator;
    const service = new ThreadHistoryService({
      inventory: inventory() as never,
    });
    service.bindRuntimes(runtimes);
    const initial = snapshotNearByteLimit(60_000);
    const window = service.window(scope, "thread-1", actorState(), initial);
    if (!window.hasOlder) throw new Error("expected history cursor");

    const envelope = await service.loadOlder(
      scope,
      "thread-1",
      window.olderCursor,
      100,
    );
    expect(history.mock.calls.map(([input]) => input.limit)).toEqual([
      100, 50, 25, 12, 6, 3, 1,
    ]);
    expect(envelope.event).toMatchObject({
      type: "history_prepend",
      page: {
        orderedTurnIds: ["older-near"],
      },
    });
    if (envelope.event.type !== "history_prepend") {
      throw new Error("expected history prepend");
    }
    expect(envelope.event.page.previousCursor).toMatch(/^history_/);
    const merged = {
      ...initial,
      orderedTurnIds: [
        ...envelope.event.page.orderedTurnIds,
        ...initial.orderedTurnIds,
      ],
      turnsById: {
        ...envelope.event.page.turnsById,
        ...initial.turnsById,
      },
      itemsById: {
        ...envelope.event.page.itemsById,
        ...initial.itemsById,
      },
      history: {
        hasOlder: true as const,
        olderCursor: envelope.event.page.previousCursor!,
      },
    };
    expect(serializedUtf8Bytes(merged)).toBeLessThanOrEqual(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    );
  });
});
