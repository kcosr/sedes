import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
} from "../../src/shared/protocol/conversation.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function snapshot(title = "Thread"): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Latest provider snapshot forking is unavailable in this fixture.",
        },
      },
    },
    forksByTurnId: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: title },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: "idle",
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
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    history: { hasOlder: false },
    runState: "idle",
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
      backend: { label: { text: "Backend" } },
      interactionMode: "interactive",
      runState: "idle",
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

function applicationState(
  value: NormalizedThreadSnapshot,
): Extract<
  NormalizedThreadEvent,
  { readonly type: "application_state_changed" }
>["state"] {
  const {
    backendSessionId: _backendSessionId,
    orderedTurnIds: _orderedTurnIds,
    turnsById: _turnsById,
    itemsById: _itemsById,
    forksByTurnId: _forksByTurnId,
    history: _history,
    runState: _runState,
    activeTurnId: _activeTurnId,
    usage: _usage,
    ...state
  } = value;
  return state;
}

describe("ThreadSnapshotPublisher", () => {
  it("publishes every changed application summary after a batch", async () => {
    const onThreadChanged = vi.fn(async () => undefined);
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "unbound" })),
      } as never,
      { snapshot: vi.fn(async () => snapshot()) } as never,
      {
        quiet: vi.fn(() => ({
          hub: {},
          publishIfUnowned: vi.fn(() => true),
          release: vi.fn(),
        })),
      } as never,
      onThreadChanged,
    );

    await publisher.publishMany(scope, ["thread-1", "thread-2"]);

    expect(onThreadChanged.mock.calls).toEqual([
      [scope, "thread-1"],
      [scope, "thread-2"],
    ]);
  });

  it("publishes Saved Agent origin availability as application state", () => {
    const current = snapshot();
    const captured = applicationState({
      ...current,
      createdWithAgent: {
        id: "11111111-1111-4111-8111-111111111111",
        revision: 3,
        name: { text: "Careful Agent" },
        available: false,
      },
    });

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "generation-1",
        current,
        captured,
      ),
    ).toEqual([
      {
        type: "application_state_changed",
        generation: "generation-1",
        state: captured,
      },
    ]);
  });

  it("publishes dormant bound inventory only to the application summary", async () => {
    const publishApplicationIncrementalsIfLoaded = vi.fn(async () => false);
    const acquire = vi.fn(() => {
      throw new Error("dormant backend must not be acquired");
    });
    const quietRelease = vi.fn();
    const onThreadChanged = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: vi.fn() } as never,
      {
        publishApplicationIncrementalsIfLoaded,
        acquire,
        quiet: vi.fn(() => ({
          hub: { subscriberCount: 0, snapshot: snapshot() },
          release: quietRelease,
        })),
      } as never,
      onThreadChanged,
    );

    await publisher.publish(scope, "thread-1");

    expect(publishApplicationIncrementalsIfLoaded).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(quietRelease).toHaveBeenCalledOnce();
    expect(onThreadChanged).toHaveBeenCalledOnce();
  });

  it("does not attach a dormant bound provider for an application overlay", async () => {
    const acquire = vi.fn();
    const capture = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: capture } as never,
      {
        publishApplicationIncrementalsIfLoaded: vi.fn(async () => false),
        acquire,
        quiet: vi.fn(() => ({
          hub: { subscriberCount: 0, snapshot: snapshot() },
          release: vi.fn(),
        })),
      } as never,
    );

    await publisher.publish(scope, "thread-1");

    expect(acquire).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("re-baselines a loaded bound hub without acquiring a dormant runtime", async () => {
    const publishAuthoritativeReplacementIfLoaded = vi.fn(async () => true);
    const acquire = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: vi.fn() } as never,
      {
        publishAuthoritativeReplacementIfLoaded,
        acquire,
      } as never,
    );

    await expect(
      publisher.publishAuthoritativeReplacementIfLoaded(scope, "thread-1"),
    ).resolves.toBe(true);
    expect(publishAuthoritativeReplacementIfLoaded).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it("recovers a bound overlay projection conflict with an authoritative replacement", async () => {
    const publishAuthoritativeReplacement = vi.fn(async () => ({
      eventId: "hub.2",
    }));
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      publishAuthoritativeReplacement,
      release,
    }));
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: vi.fn() } as never,
      {
        publishApplicationIncrementalsIfLoaded: vi.fn(async () => {
          throw new Error("thread_projection_agent_tool_revision_conflict");
        }),
        acquire,
      } as never,
    );

    await expect(publisher.publish(scope, "thread-1")).resolves.toBeUndefined();
    expect(acquire).toHaveBeenCalledOnce();
    expect(publishAuthoritativeReplacement).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retries through the bound path when an unbound capture observes first binding", async () => {
    const initial = {
      ...snapshot(),
      thread: { ...snapshot().thread, backingState: "unbound" as const },
    };
    const getTarget = vi
      .fn()
      .mockReturnValueOnce({ backingState: "unbound" })
      .mockReturnValueOnce({ backingState: "unbound" })
      .mockReturnValue({ backingState: "bound" });
    const applicationState = vi.fn(async () => {
      throw new Error("thread_application_bound_state_requires_actor_capture");
    });
    const quietRelease = vi.fn();
    const publishApplicationIncrementalsIfLoaded = vi.fn(async () => true);
    const fullSnapshot = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      { getTarget } as never,
      {
        snapshot: fullSnapshot,
        applicationState,
      } as never,
      {
        quiet: vi.fn(() => ({
          hub: {
            projectionGeneration: "application-generation",
            snapshot: initial,
          },
          release: quietRelease,
        })),
        publishApplicationIncrementalsIfLoaded,
      } as never,
    );

    await expect(publisher.publish(scope, "thread-1")).resolves.toBeUndefined();
    expect(applicationState).toHaveBeenCalledOnce();
    expect(publishApplicationIncrementalsIfLoaded).toHaveBeenCalledOnce();
    expect(quietRelease).toHaveBeenCalledOnce();
    expect(fullSnapshot).not.toHaveBeenCalled();
  });

  it("uses only the runtime-established baseline after first send binds an open quiet stream", async () => {
    const quietSnapshot = {
      ...snapshot(),
      thread: { ...snapshot().thread, backingState: "unbound" as const },
    };
    const publishAuthoritativeReplacement = vi.fn(async () => ({
      eventId: "hub.2",
    }));
    const runtimeRelease = vi.fn();
    const quietRelease = vi.fn();
    const acquire = vi.fn(async () => ({
      publishAuthoritativeReplacement,
      release: runtimeRelease,
    }));
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: vi.fn() } as never,
      {
        publishApplicationIncrementalsIfLoaded: vi.fn(async () => false),
        quiet: vi.fn(() => ({
          hub: { subscriberCount: 1, snapshot: quietSnapshot },
          release: quietRelease,
        })),
        acquire,
      } as never,
    );

    await publisher.publish(scope, "thread-1");

    expect(quietRelease).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(publishAuthoritativeReplacement).not.toHaveBeenCalled();
    expect(runtimeRelease).toHaveBeenCalledOnce();
  });

  it("publishes application incrementals after one initial snapshot and preserves the cursor suffix", async () => {
    const hub = new ThreadEventHub();
    const baseline = hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: snapshot(),
    });
    const captured = snapshot("Renamed");
    const capture = vi.fn(async () => ({
      ...captured,
      thread: {
        ...captured.thread,
        title: { text: "Renamed" },
        threadRevision: 1,
      },
      draft: {
        text: "saved",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 1,
      },
    }));
    const publishApplicationIncrementalsIfLoaded = vi.fn(
      async (_scope, _threadId, captureSnapshot, createEvents) => {
        const next = await captureSnapshot();
        const events = createEvents(
          hub.projectionGeneration!,
          hub.snapshot!,
          next,
        );
        for (const event of events) {
          hub.publish(event);
        }
        return true;
      },
    );
    const onThreadChanged = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      {
        snapshot: vi.fn(),
        applicationStateFromActorCapture: vi.fn(async () =>
          applicationState(await capture()),
        ),
      } as never,
      { publishApplicationIncrementalsIfLoaded } as never,
      onThreadChanged,
    );

    await publisher.publish(scope, "thread-1");

    expect(publishApplicationIncrementalsIfLoaded).toHaveBeenCalledOnce();
    const suffix = hub.subscribe(vi.fn(), baseline.eventId).replay;
    expect(suffix.map(({ event }) => event.type)).toEqual([
      "application_state_changed",
    ]);
    expect(suffix.every(({ event }) => event.type !== "snapshot")).toBe(true);
    expect(hub.canReplay(baseline.eventId)).toBe(true);
    expect(hub.snapshot?.thread.title.text).toBe("Renamed");
    expect(hub.snapshot?.draft).toEqual({
      text: "saved",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    });
    expect(onThreadChanged).toHaveBeenCalledOnce();
  });

  it("uses one initial quiet snapshot and targeted application updates thereafter", async () => {
    const hub = new ThreadEventHub();
    const initial = snapshot();
    const changed = {
      ...initial,
      draft: {
        text: "quiet saved",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 1,
      },
    };
    const capture = vi.fn(async () => initial);
    const captureState = vi.fn(async () => applicationState(changed));
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "unbound" })),
      } as never,
      { snapshot: capture, applicationState: captureState } as never,
      {
        quiet: vi.fn(() => ({
          hub,
          generation: "application-generation",
          publishIfUnowned: (current: NormalizedThreadSnapshot) =>
            hub.publish({
              type: "snapshot",
              generation: "application-generation",
              snapshot: current,
            }),
          release: vi.fn(),
        })),
      } as never,
    );

    await publisher.publish(scope, "thread-1");
    const baseline = hub.subscribeFromCurrentSnapshot(
      vi.fn(),
    ).checkpoint!;
    await publisher.publish(scope, "thread-1");

    expect(capture).toHaveBeenCalledOnce();
    expect(captureState).toHaveBeenCalledOnce();

    const suffix = hub.subscribe(vi.fn(), baseline.eventId).replay;
    expect(suffix.map(({ event }) => event.type)).toEqual([
      "application_state_changed",
    ]);
    expect(hub.retainedEventCount).toBe(2);
    expect(hub.canReplay(baseline.eventId)).toBe(true);
  });

  it("publishes a workspace move as one quiet application-state delta", async () => {
    const hub = new ThreadEventHub();
    const initial = snapshot();
    const moved = {
      ...initial,
      thread: {
        ...initial.thread,
        workspaceId: "workspace-2",
        threadRevision: 1,
      },
      workspace: {
        ...initial.workspace,
        id: "workspace-2",
        displayPath: { text: "/workspace/src" },
      },
    };
    const capture = vi.fn(async () => initial);
    const captureState = vi.fn(async () => applicationState(moved));
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "unbound" })),
      } as never,
      { snapshot: capture, applicationState: captureState } as never,
      {
        quiet: vi.fn(() => ({
          hub,
          generation: "application-generation",
          publishIfUnowned: (current: NormalizedThreadSnapshot) =>
            hub.publish({
              type: "snapshot",
              generation: "application-generation",
              snapshot: current,
            }),
          release: vi.fn(),
        })),
      } as never,
    );

    await publisher.publish(scope, "thread-1");
    const baseline = hub.subscribeFromCurrentSnapshot(
      vi.fn(),
    ).checkpoint!;
    await publisher.publish(scope, "thread-1");

    const suffix = hub.subscribe(vi.fn(), baseline.eventId).replay;
    expect(suffix.map(({ event }) => event.type)).toEqual([
      "application_state_changed",
    ]);
    expect(hub.snapshot?.workspace.displayPath.text).toBe("/workspace/src");
  });

  it("publishes provider feature removal in the application-state delta", () => {
    const initial = snapshot();
    const feature = {
      ref: { featureId: "provider.option", schemaVersion: 1 },
      revision: "revision-1",
      state: {},
    } as never;

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        { ...initial, providerFeatures: [feature] },
        initial,
      ),
    ).toMatchObject([
      {
        type: "application_state_changed",
        state: { providerFeatures: [] },
      },
    ]);
  });

  it("elides an application-state capture that is identical to the current projection", () => {
    const initial = snapshot();

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        initial,
        applicationState(initial),
      ),
    ).toEqual([]);
  });

  it("publishes an execution-workspace change in application state", () => {
    const initial = snapshot();
    const executionWorkspace = {
      kind: "isolated" as const,
      workspaceAccess: "writable_clone" as const,
      state: "ready" as const,
      allocationRevision: 1,
      networkProfile: "isolated" as const,
      hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
      branch: "sedes/thread-1",
      gitStatus: {
        available: true as const,
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        upstream: null,
        aheadCount: null,
      },
    };

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        initial,
        applicationState({ ...initial, executionWorkspace }),
      ),
    ).toMatchObject([
      {
        type: "application_state_changed",
        state: { executionWorkspace },
      },
    ]);
  });

  it("publishes an agent-tool policy change in application state", () => {
    const initial = snapshot();
    const captured = {
      ...initial,
      agentTools: {
        ...initial.agentTools,
        enabled: true,
        groups: [
          {
            id: "threads",
            label: { text: "Threads" },
            description: { text: "Inspect threads." },
            order: 20,
            tools: [
              {
                id: "thread.status",
                label: { text: "Sedes thread status" },
                order: 10,
                effects: {
                  application: "read" as const,
                  modelUsage: "none" as const,
                  external: "none" as const,
                },
                enabled: true,
                available: true,
              },
            ],
          },
        ],
        revision: 1,
      },
    };
    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        initial,
        captured,
      ),
    ).toMatchObject([
      {
        type: "application_state_changed",
        state: { agentTools: captured.agentTools },
      },
    ]);
  });

  it("preserves newer interaction opens and resolutions across an application capture", () => {
    const initial = snapshot();
    const interaction = {
      id: "interaction-1",
      threadId: "thread-1",
      kind: "confirmation" as const,
      sourceLabel: { text: "Agent" },
      title: { text: "Approval" },
      message: { text: "Continue?" },
      openedAt: "2026-08-10T12:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
    } satisfies NormalizedThreadSnapshot["interactions"][number];
    const capturedChange = {
      ...initial,
      thread: {
        ...initial.thread,
        title: { text: "Renamed" },
        threadRevision: 1,
      },
    };

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        { ...initial, interactions: [interaction] },
        applicationState(capturedChange),
      ),
    ).toMatchObject([
      {
        type: "application_state_changed",
        state: { interactions: [interaction] },
      },
    ]);

    expect(
      ThreadSnapshotPublisher.applicationChangeIncrementals(
        "projection-1",
        initial,
        applicationState({ ...capturedChange, interactions: [interaction] }),
      ),
    ).toMatchObject([
      {
        type: "application_state_changed",
        state: { interactions: [] },
      },
    ]);
  });

  it("clears projected recovery after the durable operation is accepted", () => {
    const initial = snapshot();
    const recovering = {
      ...initial,
      capabilities: {
        ...initial.capabilities,
        operations: [
          {
            id: "recover_uncertain" as const,
            label: { text: "Recover" },
            destructive: false,
            available: true,
            parameters: { kind: "none" as const },
          },
        ],
      },
      recovery: {
        kind: "operation_uncertain" as const,
        operationCategory: "other" as const,
        diagnostic: { text: "The response outcome is uncertain." },
        submissionMayHaveBeenAccepted: true,
        recoverable: true,
      },
    };
    const hub = new ThreadEventHub();
    hub.publish({
      type: "snapshot",
      generation: "projection-1",
      snapshot: recovering,
    });

    for (const event of ThreadSnapshotPublisher.applicationChangeIncrementals(
      "projection-1",
      recovering,
      applicationState(initial),
    )) {
      hub.publish(event);
    }

    expect(hub.snapshot?.recovery).toBeUndefined();
    expect(hub.snapshot?.capabilities.operations).not.toContainEqual(
      expect.objectContaining({ id: "recover_uncertain", available: true }),
    );
  });

  it("serializes quiet capture and publication so a later fast snapshot cannot overtake an older capture", async () => {
    const slowOlder = deferred<NormalizedThreadSnapshot>();
    const newer = {
      marker: "newer",
    } as unknown as NormalizedThreadSnapshot;
    const capture = vi
      .fn<() => Promise<NormalizedThreadSnapshot>>()
      .mockImplementationOnce(() => slowOlder.promise)
      .mockResolvedValueOnce(newer);
    const published: NormalizedThreadSnapshot[] = [];
    let sequence = 0;
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "unbound" })),
      } as never,
      { snapshot: capture } as never,
      {
        quiet: vi.fn(() => ({
          hub: {},
          generation: "quiet-generation",
          publishIfUnowned: (snapshot: NormalizedThreadSnapshot) => {
            published.push(snapshot);
            sequence += 1;
            return {
              eventId: `hub.${sequence}`,
              projectionGeneration: "quiet-generation",
              event: {
                type: "snapshot" as const,
                generation: "quiet-generation",
                snapshot,
              },
            };
          },
          release: vi.fn(),
        })),
      } as never,
    );

    const first = publisher.publishAuthoritativeReplacement(scope, "thread-1");
    const second = publisher.publishAuthoritativeReplacement(scope, "thread-1");
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    const older = {
      marker: "older",
    } as unknown as NormalizedThreadSnapshot;
    slowOlder.resolve(older);
    const [firstEnvelope, secondEnvelope] = await Promise.all([first, second]);

    expect(capture).toHaveBeenCalledTimes(2);
    expect(published).toEqual([older, newer]);
    expect(firstEnvelope.eventId).toBe("hub.1");
    expect(secondEnvelope.eventId).toBe("hub.2");
  });

  it("does not let a failed serialized capture poison or retain the next publication", async () => {
    const capture = vi
      .fn<() => Promise<NormalizedThreadSnapshot>>()
      .mockRejectedValueOnce(new Error("capture failed"))
      .mockResolvedValueOnce({} as NormalizedThreadSnapshot)
      .mockResolvedValueOnce({} as NormalizedThreadSnapshot);
    const publishIfUnowned = vi.fn((snapshot: NormalizedThreadSnapshot) => ({
      eventId: "hub.1",
      projectionGeneration: "quiet-generation",
      event: {
        type: "snapshot" as const,
        generation: "quiet-generation",
        snapshot,
      },
    }));
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "unbound" })),
      } as never,
      { snapshot: capture } as never,
      {
        quiet: vi.fn(() => ({
          hub: {},
          generation: "quiet-generation",
          publishIfUnowned,
          release: vi.fn(),
        })),
      } as never,
    );

    const failed = publisher.publishAuthoritativeReplacement(scope, "thread-1");
    const queued = publisher.publishAuthoritativeReplacement(scope, "thread-1");
    await expect(failed).rejects.toThrow("capture failed");
    await expect(queued).resolves.toMatchObject({ eventId: "hub.1" });

    await expect(
      publisher.publishAuthoritativeReplacement(scope, "thread-1"),
    ).resolves.toMatchObject({ eventId: "hub.1" });
    expect(capture).toHaveBeenCalledTimes(3);
    expect(publishIfUnowned).toHaveBeenCalledTimes(2);
  });

  it("schedules an overlay without waiting behind an authoritative replacement and drains it on close", async () => {
    const replacementGate = deferred<void>();
    const publishApplicationIncrementalsIfLoaded = vi.fn(async () => true);
    const release = vi.fn();
    const publisher = new ThreadSnapshotPublisher(
      {
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      { snapshot: vi.fn() } as never,
      {
        acquire: vi.fn(async () => ({
          publishAuthoritativeReplacement: async () => {
            await replacementGate.promise;
            return { eventId: "hub.1" } as never;
          },
          release,
        })),
        publishApplicationIncrementalsIfLoaded,
      } as never,
    );

    const replacement = publisher.publishAuthoritativeReplacement(
      scope,
      "thread-1",
    );
    await Promise.resolve();

    expect(publisher.schedule(scope, "thread-1")).toBeUndefined();
    expect(publishApplicationIncrementalsIfLoaded).not.toHaveBeenCalled();

    let closed = false;
    const close = publisher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    replacementGate.resolve();
    await replacement;
    await close;

    expect(release).toHaveBeenCalledOnce();
    expect(publishApplicationIncrementalsIfLoaded).toHaveBeenCalledOnce();
    expect(() => publisher.schedule(scope, "thread-1")).toThrow("closed");
  });
});
