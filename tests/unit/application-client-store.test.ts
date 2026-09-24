// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/client/api/ApiClient.js";
import type { EventStreamTransport } from "../../src/client/api/EventStreamTransport.js";
import { ApplicationClientStore } from "../../src/client/stores/ApplicationClientStore.js";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  type ApplicationEventEnvelope,
  type NormalizedApplicationSession,
  type NormalizedApplicationSnapshot,
  type NormalizedApplicationThreadSummary,
  type NormalizedThreadDescendantsPage,
} from "../../src/shared/index.js";
import { SEDES_VERSION } from "../../src/shared/version.js";

const now = "2026-07-30T15:00:00.000Z";

function thread(id: string, title = id): NormalizedApplicationThreadSummary {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: title },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    preferredWorktree: null,
    preferredWorktreeRevision: 0,
    pinned: false,
    pinRevision: 3,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: now,
    stateChangedAt: now,
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
  };
}

function snapshot(): NormalizedApplicationSnapshot {
  const root = thread("root", "Source context");
  const child = thread("child", "Needle result");
  return {
    advisories: [],
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "available" as const,
      },
    ],
    workspaces: [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        label: { text: "Workspace" },
        displayPath: { text: "/workspace" },
        available: true,
      },
    ],
    threads: [root, child],
    forkOrigins: [
      {
        childThreadId: "child",
        sourceThreadId: "root",
        sourceTurnId: "turn-root",
        sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
        boundaryKind: "completed_turn_inclusive",
        originKind: "user_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        branchMethod: "provider_native",
        createdAt: now,
      },
    ],
    lineagePlacements: [
      {
        childThreadId: "child",
        mode: "nested_under_source",
        revision: 2,
        updatedAt: now,
      },
    ],
    groups: [],
    lineageFamilies: [],
    executionTargets: [
      {
        id: "target-1",
        environmentId: "environment-1",
        label: { text: "Local SDK" },
        backend: { label: { text: "Pi" }, brand: "pi" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    defaultNewThreadTargetId: null,
    counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}

function session(providerPulseEnabled = true): NormalizedApplicationSession {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "csrf",
    experimentalUsageEnabled: false,
    providerPulseEnabled,
  };
}

function snapshotEnvelope(): ApplicationEventEnvelope {
  return {
    eventId: "00000000-0000-4000-8000-000000000001.0",
    applicationGeneration: "generation-1",
    event: {
      type: "snapshot",
      generation: "generation-1",
      snapshot: snapshot(),
    },
  };
}

const transport = {
  subscribeApplication: (input: {
    onEnvelope: (envelope: ApplicationEventEnvelope) => void;
  }) => {
    input.onEnvelope(snapshotEnvelope());
    return { close: () => undefined };
  },
  subscribeThread: () => {
    throw new Error("not used");
  },
  reconnectAll: () => undefined,
  closeAll: () => undefined,
} as unknown as EventStreamTransport;

describe("ApplicationClientStore lineage", () => {
  it("retains Provider Pulse availability from session metadata", async () => {
    const api = {
      session: vi.fn(async () => session(false)),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);

    await store.initialize();

    expect(store.getSnapshot().providerPulseEnabled).toBe(false);
  });

  it("mutates pin state against its independent revision", async () => {
    const mutateThreadPin = vi.fn(async () => undefined);
    const store = new ApplicationClientStore(
      { mutateThreadPin } as unknown as ApiClient,
      transport,
    );
    const summary = thread("pin-me");

    await store.setThreadPinned(summary, true);

    expect(mutateThreadPin).toHaveBeenCalledWith(summary.id, {
      pinned: true,
      expectedRevision: summary.pinRevision,
      mutationId: expect.any(String),
    });
  });

  it("requires a confirmed stash count before settle or archive mutations", async () => {
    const mutateInventory = vi.fn(async () => undefined);
    const api = {
      session: vi.fn(async () => session()),
      mutateInventory,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const root = snapshot().threads[0]!;

    await expect(store.mutateInventory(root, "settle")).rejects.toThrow(
      "confirmed stashed-prompt count",
    );
    await expect(store.mutateInventory(root, "archive")).rejects.toThrow(
      "confirmed stashed-prompt count",
    );
    expect(mutateInventory).not.toHaveBeenCalled();
  });

  it("sends a trimmed immediate reminder without a snooze deadline", async () => {
    const mutateInventory = vi.fn(async () => undefined);
    const api = {
      session: vi.fn(async () => session()),
      mutateInventory,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const root = snapshot().threads[0]!;

    await expect(store.mutateInventory(root, "remind")).rejects.toThrow(
      "Reminder text is required",
    );
    await store.mutateInventory(root, "remind", {
      wakeReminder: "  Review this result  ",
    });

    expect(mutateInventory).toHaveBeenCalledOnce();
    expect(mutateInventory).toHaveBeenCalledWith(root.id, {
      action: "remind",
      wakeReminder: "Review this result",
      expectedRevision: root.inventoryRevision,
      mutationId: expect.any(String),
    });
  });

  it("forwards an explicit open-task disposition when settling", async () => {
    const mutateInventory = vi.fn(async () => undefined);
    const api = {
      session: vi.fn(async () => session()),
      mutateInventory,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const root = snapshot().threads[0]!;

    await store.mutateInventory(root, "settle", {
      openTaskDisposition: "move_to_global",
      expectedStashedPromptCount: 2,
    });

    expect(mutateInventory).toHaveBeenCalledWith(root.id, {
      action: "settle",
      expectedRevision: root.inventoryRevision,
      mutationId: expect.any(String),
      expectedStashedPromptCount: 2,
      openTaskDisposition: "move_to_global",
    });
  });

  it("forwards archive workspace disposition and lifecycle revisions", async () => {
    const mutateInventory = vi.fn(async () => undefined);
    const getThreadExecutionWorkspace = vi.fn(async () => ({
      kind: "direct" as const,
    }));
    const deleteThreadExecutionWorkspace = vi.fn(async () => ({
      state: "deleted" as const,
      allocationRevision: 4,
      operationId: "10000000-0000-4000-8000-000000000001",
    }));
    const importThreadExecutionWorkspace = vi.fn(async () => ({
      branch: "sedes/thread",
      headOid: "a".repeat(40),
      sourceRepositoryPath: "/repo",
    }));
    const handoffThreadExecutionWorkspace = vi.fn(async () => ({
      state: "retained" as const,
      allocationRevision: 4,
      workspacePath: "/sandbox/repo",
      branch: "sedes/thread",
    }));
    const api = {
      session: vi.fn(async () => session()),
      mutateInventory,
      getThreadExecutionWorkspace,
      deleteThreadExecutionWorkspace,
      importThreadExecutionWorkspace,
      handoffThreadExecutionWorkspace,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const root = snapshot().threads[0]!;

    await store.mutateInventory(root, "archive", {
      expectedStashedPromptCount: 0,
      executionWorkspaceDisposition: {
        kind: "delete",
        expectedRevision: 3,
        operationId: "10000000-0000-4000-8000-000000000002",
      },
    });
    await store.getThreadExecutionWorkspace(root.id);
    await store.deleteThreadExecutionWorkspace(root.id, 3);
    await store.importThreadExecutionWorkspace(root.id, 3);
    await store.handoffThreadExecutionWorkspace(root.id, 3);

    expect(mutateInventory).toHaveBeenCalledWith(
      root.id,
      expect.objectContaining({
        action: "archive",
        executionWorkspaceDisposition: {
          kind: "delete",
          expectedRevision: 3,
          operationId: "10000000-0000-4000-8000-000000000002",
        },
      }),
    );
    expect(getThreadExecutionWorkspace).toHaveBeenCalledWith(root.id);
    for (const method of [
      deleteThreadExecutionWorkspace,
      importThreadExecutionWorkspace,
      handoffThreadExecutionWorkspace,
    ]) {
      expect(method).toHaveBeenCalledWith(root.id, {
        expectedRevision: 3,
        operationId: expect.any(String),
      });
    }
  });

  it("uses the normalized impact read and family archive mutation", async () => {
    const impact = {
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      archiveOnly: { available: true as const },
      archiveAll: { available: true as const },
    };
    const getThreadArchiveImpact = vi.fn(async () => impact);
    const archiveThreads = vi.fn(async () => ({
      archivedThreadIds: ["root-thread", "child-thread"],
    }));
    const api = {
      session: vi.fn(async () => session()),
      getThreadArchiveImpact,
      archiveThreads,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();
    const root = snapshot().threads[0]!;

    await expect(store.getThreadArchiveImpact(root.id)).resolves.toEqual(
      impact,
    );
    await expect(
      store.archiveThreadFamily(root, {
        expectedStashedPromptCount: 3,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    ).resolves.toEqual(["root-thread", "child-thread"]);

    expect(getThreadArchiveImpact).toHaveBeenCalledWith(root.id);
    expect(archiveThreads).toHaveBeenCalledWith(root.id, {
      action: "archive_family",
      expectedRevision: root.inventoryRevision,
      expectedStashedPromptCount: 3,
      executionWorkspaceDisposition: { kind: "keep" },
      mutationId: expect.any(String),
    });
  });

  it("forwards the caller-owned force-reset mutation id", async () => {
    const impact = {
      blockerFingerprint: "f".repeat(64),
      resettable: true,
      blockers: [{ kind: "fork_origin" as const, count: 1 }],
      affectedThreadIds: ["root"],
      warnings: [],
    };
    const getThreadForceResetImpact = vi.fn(async () => impact);
    const forceResetThread = vi.fn(async () => ({
      resetAt: 1,
      blockerFingerprint: impact.blockerFingerprint,
      resetBlockers: impact.blockers,
      affectedThreadIds: impact.affectedThreadIds,
    }));
    const api = {
      session: vi.fn(async () => session()),
      getThreadForceResetImpact,
      forceResetThread,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();

    await expect(store.getThreadForceResetImpact("root")).resolves.toEqual(
      impact,
    );
    const mutationId = "10000000-0000-4000-8000-000000000007";
    await store.forceResetThread("root", impact.blockerFingerprint, mutationId);

    expect(getThreadForceResetImpact).toHaveBeenCalledWith("root");
    expect(forceResetThread).toHaveBeenCalledWith(
      "root",
      impact.blockerFingerprint,
      mutationId,
    );
  });

  it("keeps nested ancestors as search context", async () => {
    const api = {
      session: vi.fn(async () => session()),
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();

    store.setSearch("needle");

    expect(
      store
        .getSnapshot()
        .visibleThreads.map(({ id }) => id)
        .sort(),
    ).toEqual(["child", "root"]);
  });

  it("coalesces bounded descendant pages and forwards placement revisions", async () => {
    let release!: (page: NormalizedThreadDescendantsPage) => void;
    const listThreadDescendants = vi.fn(
      () =>
        new Promise<NormalizedThreadDescendantsPage>(
          (resolve) => (release = resolve),
        ),
    );
    const updateThreadLineagePlacement = vi.fn(
      async () => snapshot().lineagePlacements[0]!,
    );
    const api = {
      session: vi.fn(async () => session()),
      listThreadDescendants,
      updateThreadLineagePlacement,
    } as unknown as ApiClient;
    const store = new ApplicationClientStore(api, transport);
    await store.initialize();

    const first = store.loadMoreDescendants("root");
    const second = store.loadMoreDescendants("root");
    expect(first).toBe(second);
    expect(listThreadDescendants).toHaveBeenCalledWith("root", {
      pageSize: 50,
    });
    const current = snapshot();
    release({
      descendants: [
        {
          thread: current.threads.find(({ id }) => id === "child")!,
          origin: current.forkOrigins[0]!,
          placement: current.lineagePlacements[0]!,
        },
      ],
    });
    await Promise.all([first, second]);
    expect(store.getSnapshot().descendantPages.root).toMatchObject({
      descendants: [],
      loading: false,
      loaded: true,
    });

    const placement = snapshot().lineagePlacements[0]!;
    await store.updateLineagePlacement(placement, "top_level");
    expect(updateThreadLineagePlacement).toHaveBeenCalledWith("child", {
      mode: "top_level",
      expectedRevision: 2,
      mutationId: expect.any(String),
    });
  });
});
