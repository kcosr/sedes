import { describe, expect, it, vi } from "vitest";
import type { ApplicationThreadDurableSummary } from "../../src/server/application/application-snapshot-service.js";
import { ApplicationSnapshotService } from "../../src/server/application/application-snapshot-service.js";
import type { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  principalId: "10000000-0000-4000-8000-000000000002",
};

function thread(
  id: string,
  workspaceId: string,
  lastActivityAt: string,
): ApplicationThreadDurableSummary {
  return {
    id,
    workspaceId,
    targetId:
      workspaceId === "workspace-local" ? "target-local" : "target-remote",
    title: { text: id },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 0,
    pinned: false,
    pinRevision: 0,
    preferredWorktree: null,
    preferredWorktreeRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    threadRevision: 0,
    available: true,
    lastActivityAt,
    stateChangedAt: lastActivityAt,
    automation: null,
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
  };
}

describe("ApplicationSnapshotService", () => {
  it("projects every scoped environment and gathers threads from each one", async () => {
    const list = vi.fn((_scope: RequestScope, environmentId: string) =>
      environmentId === "environment-local"
        ? [
            thread(
              "thread-local",
              "workspace-local",
              "2026-08-04T00:00:00.000Z",
            ),
          ]
        : [
            thread(
              "thread-remote",
              "workspace-remote",
              "2026-08-05T00:00:00.000Z",
            ),
          ],
    );
    const inventory = {
      listEnvironments: () => [
        {
          id: "environment-local",
          kind: "local",
          label: "This machine",
          availability: "available",
          diagnosticCode: null,
        },
        {
          id: "environment-ssh",
          kind: "ssh",
          label: "Build host",
          availability: "unavailable",
          diagnosticCode: "ssh_unreachable",
        },
      ],
      listWorkspaces: () => [
        {
          id: "workspace-local",
          environmentId: "environment-local",
          canonicalPath: "/work/local",
          displayName: "Local workspace",
          availability: "available",
        },
        {
          id: "workspace-remote",
          environmentId: "environment-ssh",
          canonicalPath: "/work/remote",
          displayName: "Remote workspace",
          availability: "available",
        },
      ],
      countThreadsByInventoryState: () => ({
        active: 2,
        snoozed: 0,
        settled: 0,
        archived: 0,
      }),
    } as unknown as InventoryRepository;
    const service = new ApplicationSnapshotService(
      inventory,
      { list, listByIds: () => [], forkSelectionSaturated: () => false, structure: () => undefined },
      { captureLoadedState: async () => undefined },
      {
        read: async () => ({
          executionTargets: [
            {
              id: "target-local",
              environmentId: "environment-local",
              label: { text: "Local Pi" },
              backend: { label: { text: "Pi" }, brand: "pi" },
              workspaceExecution: { kind: "direct_only" },
              available: true,
            },
            {
              id: "target-remote",
              environmentId: "environment-ssh",
              label: { text: "Remote Pi" },
              backend: { label: { text: "Pi" }, brand: "pi" },
              workspaceExecution: { kind: "direct_only" },
              available: true,
            },
            {
              id: "target-remote-required",
              environmentId: "environment-ssh",
              label: { text: "Remote Codex" },
              backend: { label: { text: "Codex" }, brand: "codex" },
              workspaceExecution: { kind: "direct_only" },
              available: true,
            },
          ],
          defaultTargetId: "target-remote",
        }),
        requireSelectable: async () => undefined,
        environmentAvailabilityDisposition: (_scope, targetId) =>
          targetId === "target-remote"
            ? "active_preflight"
            : "requires_available_environment",
      },
      {
        list: () => ({
          forkOrigins: [],
          lineagePlacements: [],
          lineageFamilies: [],
        }),
      },
      {
        listAssociated: () => [],
        listAssociatedByThread: () => [],
        findAssociated: () => undefined,
      },
      { list: () => [] },
      (_scope, environmentId) =>
        environmentId === "environment-local" ? "available" : "unavailable",
      {
        summariesByThread: (_scope, threadIds) =>
          new Map(
            threadIds.map((threadId) => [
              threadId,
              threadId === "thread-remote"
                ? { runningCount: 1, retainedCount: 2 }
                : { runningCount: 0, retainedCount: 0 },
            ]),
          ),
      },
    );

    const snapshot = await service.capture(scope);

    expect(list.mock.calls.map(([, environmentId]) => environmentId)).toEqual([
      "environment-local",
      "environment-ssh",
    ]);
    expect(snapshot.environments).toEqual([
      {
        id: "environment-local",
        kind: "local",
        label: { text: "This machine" },
        available: true,
        directoryBrowsing: "available",
      },
      {
        id: "environment-ssh",
        kind: "ssh",
        label: { text: "Build host" },
        available: false,
        directoryBrowsing: "unavailable",
        diagnostic: { text: "ssh_unreachable" },
      },
    ]);
    expect(snapshot.threads.map(({ id }) => id)).toEqual([
      "thread-remote",
      "thread-local",
    ]);
    expect(snapshot.threads[0]?.terminalSummary).toEqual({
      runningCount: 1,
      retainedCount: 2,
    });
    expect(snapshot.executionTargets).toHaveLength(3);
    expect(snapshot.executionTargets[1]).toMatchObject({
      id: "target-remote",
      available: true,
    });
    expect(snapshot.executionTargets[2]).toMatchObject({
      id: "target-remote-required",
      available: false,
      unavailableReason: {
        text: "The execution environment is unavailable.",
      },
    });
    expect(snapshot.defaultNewThreadTargetId).toBe("target-remote");
  });

  it("omits targets of removed empty hosts while preserving disabled targets and retained thread history", async () => {
    const service = new ApplicationSnapshotService(
      {
        listEnvironments: () => [
          { id: "environment-local", kind: "local", label: "This machine", availability: "available", diagnosticCode: null },
          { id: "environment-ssh", kind: "ssh", label: "Retained host", availability: "unavailable", diagnosticCode: "configuration_removed" },
        ],
        listWorkspaces: () => [{
          id: "workspace-remote", environmentId: "environment-ssh", canonicalPath: "/work/retained",
          displayName: "Retained workspace", availability: "unavailable",
        }],
        countThreadsByInventoryState: () => ({ active: 1, snoozed: 0, settled: 0, archived: 0 }),
      } as unknown as InventoryRepository,
      {
        list: (_scope, environmentId) => environmentId === "environment-ssh"
          ? [thread("thread-retained", "workspace-remote", "2026-08-05T00:00:00.000Z")] : [],
        listByIds: () => [], forkSelectionSaturated: () => false, structure: () => undefined,
      },
      { captureLoadedState: async () => undefined },
      {
        read: async () => ({
          // Removed profiles remain durable identities and therefore can still
          // be described by the target reader, even for an empty removed host.
          executionTargets: [
            ["target-local", "environment-local"],
            ["target-remote", "environment-ssh"],
            ["target-empty", "environment-empty"],
          ].map(([id, environmentId]) => ({
            id: id!, environmentId: environmentId!, label: { text: id! },
            backend: { label: { text: "Pi" }, brand: "pi" as const },
            workspaceExecution: { kind: "direct_only" as const },
            available: false as const, unavailableReason: { text: "This target is disabled." },
          })),
          defaultTargetId: "target-empty",
        }),
        requireSelectable: async () => undefined,
      },
      { list: () => ({ forkOrigins: [], lineagePlacements: [], lineageFamilies: [] }) },
      { listAssociated: () => [], listAssociatedByThread: () => [], findAssociated: () => undefined },
      { list: () => [] },
      () => "unavailable",
      { summariesByThread: () => new Map() },
    );

    const snapshot = await service.capture(scope);
    expect(snapshot.executionTargets.map(({ id, available }) => ({ id, available }))).toEqual([
      { id: "target-local", available: false },
      { id: "target-remote", available: false },
    ]);
    expect(snapshot.environments.map(({ id }) => id)).toEqual(["environment-local", "environment-ssh"]);
    expect(snapshot.threads).toContainEqual(expect.objectContaining({ id: "thread-retained", targetId: "target-remote" }));
    expect(snapshot.defaultNewThreadTargetId).toBeNull();
  });

  it("retains matching thread and task workspace associations across awaited reads", async () => {
    const movingThreadId = "10000000-0000-4000-8000-000000000004";
    const initialWorkspaceId = "10000000-0000-4000-8000-000000000005";
    const movedWorkspaceId = "10000000-0000-4000-8000-000000000006";
    let currentWorkspaceId = initialWorkspaceId;
    let releaseTargetRead!: () => void;
    const targetReadGate = new Promise<void>((resolve) => {
      releaseTargetRead = resolve;
    });
    const listAssociated = vi.fn(() => [
      {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        id: "10000000-0000-4000-8000-000000000003",
        scopeKind: "thread" as const,
        environmentId: null,
        workspaceId: null,
        threadId: movingThreadId,
        associatedWorkspaceId: currentWorkspaceId,
        title: "Moving thread task",
        details: "",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const service = new ApplicationSnapshotService(
      {
        listEnvironments: () => [
          {
            id: "environment-local",
            kind: "local",
            label: "This machine",
            availability: "available",
            diagnosticCode: null,
          },
        ],
        listWorkspaces: () =>
          [initialWorkspaceId, movedWorkspaceId].map((id) => ({
            id,
            environmentId: "environment-local",
            canonicalPath: `/work/${id}`,
            displayName: id,
            availability: "available",
          })),
        countThreadsByInventoryState: () => ({
          active: 1,
          snoozed: 0,
          settled: 0,
          archived: 0,
        }),
      } as unknown as InventoryRepository,
      {
        list: () => [
          {
            ...thread(
              movingThreadId,
              currentWorkspaceId,
              "2026-08-09T00:00:00.000Z",
            ),
            targetId: "target-local",
          },
        ],
        listByIds: () => [], forkSelectionSaturated: () => false, structure: () => undefined,
      },
      { captureLoadedState: async () => undefined },
      {
        read: async () => {
          await targetReadGate;
          return {
            executionTargets: [
              {
                id: "target-local",
                environmentId: "environment-local",
                label: { text: "Local Pi" },
                backend: { label: { text: "Pi" }, brand: "pi" as const },
                workspaceExecution: { kind: "direct_only" as const },
                available: true,
              },
            ],
            defaultTargetId: "target-local",
          };
        },
        requireSelectable: async () => undefined,
        environmentAvailabilityDisposition: () =>
          "requires_available_environment",
      },
      {
        list: () => ({
          forkOrigins: [],
          lineagePlacements: [],
          lineageFamilies: [],
        }),
      },
      {
        listAssociated,
        listAssociatedByThread: () => [],
        findAssociated: () => undefined,
      },
      { list: () => [] },
      () => "available",
      { summariesByThread: () => new Map() },
    );

    const capture = service.capture(scope);
    expect(listAssociated).toHaveBeenCalledTimes(1);

    currentWorkspaceId = movedWorkspaceId;
    releaseTargetRead();
    const snapshot = await capture;

    expect(snapshot.threads[0]?.workspaceId).toBe(initialWorkspaceId);
    expect(snapshot.tasks[0]?.associatedWorkspaceId).toBe(initialWorkspaceId);
    expect(listAssociated).toHaveBeenCalledTimes(1);
  });
});
