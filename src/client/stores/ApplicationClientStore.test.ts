import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import type { EventStreamTransport } from "../api/EventStreamTransport.js";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  type ApplicationEventEnvelope,
} from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { ApplicationClientStore } from "./ApplicationClientStore.js";

const applicationHubId = "10000000-0000-4000-8000-000000000001";
const applicationSession = {
  clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
  version: SEDES_VERSION,
  csrfToken: "a".repeat(32),
  providerPulseEnabled: true,
};
const applicationSnapshot = {
  advisories: [],
  environments: [],
  workspaces: [],
  executionTargets: [],
  defaultNewThreadTargetId: null,
  threads: [],
  groups: [],
  forkOrigins: [],
  lineagePlacements: [],
  lineageFamilies: [],
  counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
  tasks: [],
};

function applicationSnapshotEnvelope(sequence = 0): ApplicationEventEnvelope {
  return {
    eventId: `${applicationHubId}.${sequence}`,
    applicationGeneration: "application-1",
    event: {
      type: "snapshot",
      generation: "application-1",
      snapshot: applicationSnapshot,
    },
  };
}

function applicationTransport() {
  type ApplicationSubscriptionInput = Parameters<
    EventStreamTransport["subscribeApplication"]
  >[0];
  const subscriptions: ApplicationSubscriptionInput[] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const transport = {
    subscribeApplication: vi.fn((input: ApplicationSubscriptionInput) => {
      subscriptions.push(input);
      const close = vi.fn();
      closes.push(close);
      return { close };
    }),
    reconnectAll: vi.fn(),
  } as unknown as EventStreamTransport;
  return { transport, subscriptions, closes };
}

describe("ApplicationClientStore session and inventory lifecycle", () => {
  it("resynchronizes Workpads when a live replay reconnects without a snapshot", async () => {
    const api = { session: vi.fn().mockResolvedValue(applicationSession) } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const stream = subscriptions[0]!;
    stream.onEnvelope(applicationSnapshotEnvelope());
    stream.onConnection("connected");
    const changed = vi.fn();
    store.normalized.subscribeWorkpadChanges(changed);
    stream.onEnvelope({
      eventId: `${applicationHubId}.1`, applicationGeneration: "application-1",
      event: { type: "workpad_changed", generation: "application-1", workpadId: "workpad-1", revision: 2, change: "document" },
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ workpadId: "workpad-1", revision: 2, change: "document" });
    changed.mockClear();
    stream.onConnection("reconnecting");
    // The event cursor is already advanced even if its separate GET failed.
    expect(stream.getReplayCursor?.()).toBe(`${applicationHubId}.1`);
    stream.onConnection("connected");
    expect(changed).toHaveBeenCalledExactlyOnceWith(undefined);
    stream.onConnection("connected");
    expect(changed).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("loads the small session before subscribing and becomes ready from SSE", async () => {
    let resolveSession!: (session: typeof applicationSession) => void;
    const sessionPending = new Promise<typeof applicationSession>((resolve) => {
      resolveSession = resolve;
    });
    const api = {
      session: vi.fn(() => sessionPending),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);

    const initialize = store.initialize();
    expect(transport.subscribeApplication).not.toHaveBeenCalled();
    resolveSession(applicationSession);
    await initialize;

    expect(api.session).toHaveBeenCalledWith(undefined);
    expect(transport.subscribeApplication).toHaveBeenCalledOnce();
    expect(subscriptions[0]?.getReplayCursor?.()).toBeUndefined();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      authoritative: true,
      providerPulseEnabled: true,
    });
    expect(subscriptions[0]?.getReplayCursor?.()).toBe(`${applicationHubId}.0`);
  });

  it("deduplicates resume metadata refreshes and reconnects retained streams", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());
    vi.mocked(api.session).mockClear();

    await Promise.all([store.resume(), store.resume()]);

    expect(api.session).toHaveBeenCalledOnce();
    expect(api.session).toHaveBeenCalledWith({ refresh: true });
    expect(transport.reconnectAll).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().authoritative).toBe(true);
  });

  it("recreates a rejected application stream without its stale cursor and waits for replacement inventory", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions, closes } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope(4));
    expect(subscriptions[0]?.getReplayCursor?.()).toBe(`${applicationHubId}.4`);

    let refreshSettled = false;
    const refresh = store.refresh().then(() => {
      refreshSettled = true;
    });
    await Promise.resolve();

    expect(closes[0]).toHaveBeenCalledOnce();
    expect(transport.subscribeApplication).toHaveBeenCalledTimes(2);
    expect(subscriptions[1]?.getReplayCursor?.()).toBeUndefined();
    expect(subscriptions[0]?.initialHandshake).toBeUndefined();
    expect(subscriptions[1]?.initialHandshake).toBe(
      "authoritative_replacement",
    );
    expect(api.session).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      authoritative: false,
      snapshot: applicationSnapshot,
    });
    expect(refreshSettled).toBe(false);

    subscriptions[1]?.onEnvelope(applicationSnapshotEnvelope(5));
    await refresh;

    expect(refreshSettled).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      authoritative: true,
      snapshot: applicationSnapshot,
    });
  });

  it("replaces a rejected replacement stream again before settling refresh", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions, closes } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope(4));

    let refreshSettled = false;
    const refresh = store.refresh().then(() => {
      refreshSettled = true;
    });
    await Promise.resolve();
    subscriptions[1]?.onEnvelope({
      eventId: `${applicationHubId}.5`,
      applicationGeneration: "application-1",
      event: {
        type: "inventory_counts_changed",
        generation: "application-1",
        counts: applicationSnapshot.counts,
      },
    });
    await vi.waitFor(() =>
      expect(transport.subscribeApplication).toHaveBeenCalledTimes(3),
    );

    expect(closes[1]).toHaveBeenCalledOnce();
    expect(subscriptions[2]?.getReplayCursor?.()).toBeUndefined();
    expect(refreshSettled).toBe(false);

    subscriptions[2]?.onEnvelope(applicationSnapshotEnvelope(6));
    await refresh;

    expect(refreshSettled).toBe(true);
    expect(store.getSnapshot().authoritative).toBe(true);
  });

  it("stops after three rejected replacement streams and exposes a retryable error", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope(4));

    const refresh = store.refresh();
    await vi.waitFor(() =>
      expect(transport.subscribeApplication).toHaveBeenCalledTimes(2),
    );
    for (let index = 1; index <= 3; index += 1) {
      subscriptions[index]?.onEnvelope({
        eventId: `${applicationHubId}.${4 + index}`,
        applicationGeneration: "application-1",
        event: {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: applicationSnapshot.counts,
        },
      });
      if (index < 3) {
        await vi.waitFor(() =>
          expect(transport.subscribeApplication).toHaveBeenCalledTimes(
            index + 2,
          ),
        );
      }
    }
    await refresh;

    expect(transport.subscribeApplication).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      authoritative: false,
      error:
        "Application inventory could not be synchronized: initial_application_snapshot_missing.",
    });

    subscriptions[3]?.onEnvelope({
      eventId: `${applicationHubId}.8`,
      applicationGeneration: "application-1",
      event: {
        type: "inventory_counts_changed",
        generation: "application-1",
        counts: applicationSnapshot.counts,
      },
    });
    await Promise.resolve();
    expect(transport.subscribeApplication).toHaveBeenCalledTimes(4);
    expect(api.session).toHaveBeenCalledOnce();
  });

  it("surfaces a terminal application stream failure while awaiting initial inventory", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();

    subscriptions[0]?.onTerminalError?.(
      new Error("The application event stream closed permanently."),
    );

    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      connection: "disconnected",
      authoritative: false,
      error: "The application event stream closed permanently.",
    });
  });

  it("keeps authoritative inventory visible when its application stream closes", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());

    subscriptions[0]?.onTerminalError?.(
      new Error("The application event stream closed permanently."),
    );

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      connection: "disconnected",
      authoritative: true,
      error: "The application event stream closed permanently.",
    });
  });

  it("reloads session metadata when retrying after an initial session failure", async () => {
    const api = {
      session: vi
        .fn()
        .mockRejectedValueOnce(new Error("Session temporarily unavailable."))
        .mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);

    await expect(store.initialize()).rejects.toThrow(
      "Session temporarily unavailable.",
    );
    expect(store.getSnapshot().status).toBe("error");

    const retry = store.refresh();
    expect(store.getSnapshot().status).toBe("loading");
    await vi.waitFor(() =>
      expect(transport.subscribeApplication).toHaveBeenCalledOnce(),
    );
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());
    await retry;

    expect(api.session).toHaveBeenNthCalledWith(1, undefined);
    expect(api.session).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      authoritative: true,
      providerPulseEnabled: true,
    });
  });

  it("reconnects retained streams after a transient session metadata failure", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());
    vi.mocked(api.session).mockRejectedValueOnce(
      new Error("Incompatible application session."),
    );

    await expect(store.resume()).rejects.toThrow(
      "Incompatible application session.",
    );

    expect(transport.reconnectAll).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      error: "Incompatible application session.",
    });
  });

  it("reconnects retained streams before a resume metadata request settles", async () => {
    let resolveSession!: (session: typeof applicationSession) => void;
    const api = {
      session: vi
        .fn()
        .mockResolvedValueOnce(applicationSession)
        .mockImplementationOnce(
          () =>
            new Promise<typeof applicationSession>((resolve) => {
              resolveSession = resolve;
            }),
        ),
    } as unknown as ApiClient;
    const { transport, subscriptions } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());

    const resume = store.resume();
    const sameResume = store.resume();

    expect(transport.reconnectAll).toHaveBeenCalledTimes(2);
    expect(api.session).toHaveBeenLastCalledWith({ refresh: true });
    resolveSession(applicationSession);
    await Promise.all([resume, sameResume]);
  });

  it("settles an in-flight replacement and fails closed for incompatible session metadata", async () => {
    const api = {
      session: vi.fn().mockResolvedValue(applicationSession),
    } as unknown as ApiClient;
    const { transport, subscriptions, closes } = applicationTransport();
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    subscriptions[0]?.onEnvelope(applicationSnapshotEnvelope());
    const interruptedRefresh = store.refresh();
    await vi.waitFor(() =>
      expect(transport.subscribeApplication).toHaveBeenCalledTimes(2),
    );
    vi.mocked(api.session).mockRejectedValueOnce(
      new ApiError(
        502,
        "client_protocol_mismatch",
        "Incompatible application session.",
        false,
      ),
    );

    await expect(store.resume()).rejects.toThrow(
      "Incompatible application session.",
    );

    expect(transport.reconnectAll).toHaveBeenCalledOnce();
    expect(closes[1]).toHaveBeenCalledOnce();
    await interruptedRefresh;
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "Incompatible application session.",
    });
    subscriptions[1]?.onEnvelope(applicationSnapshotEnvelope());
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "Incompatible application session.",
    });

    const recovery = store.refresh();
    await vi.waitFor(() =>
      expect(transport.subscribeApplication).toHaveBeenCalledTimes(3),
    );
    subscriptions[2]?.onEnvelope(applicationSnapshotEnvelope());
    await recovery;
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      error: undefined,
    });
  });
});

describe("ApplicationClientStore created-thread workspace handoff", () => {
  it("owns and disposes the shared canned-prompt store", () => {
    const store = new ApplicationClientStore(
      {} as ApiClient,
      {} as EventStreamTransport,
    );
    const dispose = vi.spyOn(store.cannedPrompts, "dispose");

    store.dispose();
    store.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("retains the requested workspace while application publication catches up", async () => {
    const api = {
      createThread: vi.fn().mockResolvedValue({
        threadId: "thread-new",
        workspaceId: "workspace-2",
        targetId: "target-1",
      }),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);

    expect(store.workspaceIdForThread("thread-new")).toBeUndefined();
    await expect(
      store.createThread({
        workspaceId: "workspace-2",
        title: "New thread",
        executionWorkspace: { kind: "direct" },
        configuration: { kind: "custom", targetId: "target-1" },
      }),
    ).resolves.toEqual({
      threadId: "thread-new",
      workspaceId: "workspace-2",
      targetId: "target-1",
    });
    expect(store.workspaceIdForThread("thread-new")).toBe("workspace-2");
    expect(store.workspaceIdForThread("unrelated-thread")).toBeUndefined();
  });

  it("retains the server-derived workspace for a same-settings child", async () => {
    const api = {
      createThreadFromSettings: vi.fn().mockResolvedValue({
        threadId: "thread-copy",
        workspaceId: "workspace-source",
        targetId: "target-source",
      }),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);

    await expect(
      store.createThreadFromSettings("thread-source", {
        title: "New thread",
      }),
    ).resolves.toEqual({
      threadId: "thread-copy",
      workspaceId: "workspace-source",
      targetId: "target-source",
    });
    expect(api.createThreadFromSettings).toHaveBeenCalledWith("thread-source", {
      title: "New thread",
      mutationId: expect.any(String),
    });
    expect(store.workspaceIdForThread("thread-copy")).toBe("workspace-source");
  });

  it("retains one settings-copy mutation identity across a failed UI lifecycle", async () => {
    const api = {
      createThreadFromSettings: vi
        .fn()
        .mockRejectedValueOnce(new Error("Response lost"))
        .mockResolvedValueOnce({
          threadId: "thread-copy",
          workspaceId: "workspace-source",
          targetId: "target-source",
        }),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);
    const request = { title: "New thread" };

    await expect(
      store.createThreadFromSettings("thread-source", request),
    ).rejects.toThrow("Response lost");
    const firstMutationId = vi.mocked(api.createThreadFromSettings).mock
      .calls[0]![1].mutationId;

    await expect(
      store.createThreadFromSettings("thread-source", request),
    ).resolves.toMatchObject({ threadId: "thread-copy" });
    expect(api.createThreadFromSettings).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(api.createThreadFromSettings).mock.calls[1]![1].mutationId,
    ).toBe(firstMutationId);
  });

  it("publishes settings-copy pending state across UI surfaces", async () => {
    let resolveCopy!: (result: {
      threadId: string;
      workspaceId: string;
      targetId: string;
    }) => void;
    const pendingCopy = new Promise<{
      threadId: string;
      workspaceId: string;
      targetId: string;
    }>((resolve) => {
      resolveCopy = resolve;
    });
    const api = {
      createThreadFromSettings: vi.fn(() => pendingCopy),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);
    const pendingSnapshots: string[][] = [];
    const unsubscribe = store.subscribe(() => {
      pendingSnapshots.push([
        ...store.getSnapshot().pendingThreadConfigurationCopySourceIds,
      ]);
    });

    const copy = store.createThreadFromSettings("thread-source", {
      title: "New thread",
    });
    expect(store.getSnapshot().pendingThreadConfigurationCopySourceIds).toEqual(
      ["thread-source"],
    );

    resolveCopy({
      threadId: "thread-copy",
      workspaceId: "workspace-source",
      targetId: "target-source",
    });
    await copy;
    expect(store.getSnapshot().pendingThreadConfigurationCopySourceIds).toEqual(
      [],
    );
    expect(pendingSnapshots).toEqual([["thread-source"], []]);
    unsubscribe();
  });
});

describe("ApplicationClientStore bulk inventory", () => {
  const impact = {
    action: "settle" as const,
    targets: [
      { threadId: "thread-a", expectedRevision: 3 },
      { threadId: "thread-b", expectedRevision: 7 },
    ],
    targetCount: 2,
    pendingQuestionCount: 0,
    affectedCount: 1,
    unchangedCount: 1,
    blockers: { items: [], total: 0, omitted: 0 },
    openTasks: { items: [], total: 0, omitted: 0 },
    stashedPromptCount: 2,
    available: true,
  };

  it("requests authoritative impact in the supplied roster order", async () => {
    const api = {
      getBulkInventoryImpact: vi.fn().mockResolvedValue(impact),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);

    await expect(
      store.getBulkInventoryImpact("settle", ["thread-b", "thread-a"]),
    ).resolves.toBe(impact);
    expect(api.getBulkInventoryImpact).toHaveBeenCalledWith({
      action: "settle",
      threadIds: ["thread-b", "thread-a"],
    });
  });

  it("constructs one frozen confirmed request for exact retries", async () => {
    const api = {
      mutateBulkInventory: vi
        .fn()
        .mockRejectedValueOnce(new Error("Response lost"))
        .mockResolvedValueOnce({ changedThreadIds: ["thread-a"] }),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, {} as EventStreamTransport);
    const request = store.createBulkInventoryMutationRequest(impact);

    expect(request).toMatchObject({
      action: "settle",
      targets: impact.targets,
      expectedStashedPromptCount: 2,
      expectedOpenTaskCount: 0,
      mutationId: expect.any(String),
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.targets)).toBe(true);

    await expect(store.mutateBulkInventory(request)).rejects.toThrow(
      "Response lost",
    );
    await expect(store.mutateBulkInventory(request)).resolves.toEqual({
      changedThreadIds: ["thread-a"],
    });
    expect(api.mutateBulkInventory).toHaveBeenNthCalledWith(1, request);
    expect(api.mutateBulkInventory).toHaveBeenNthCalledWith(2, request);
  });
});
