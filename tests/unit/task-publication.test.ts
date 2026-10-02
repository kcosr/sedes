import { describe, expect, it } from "vitest";
import type { ApplicationEventEnvelope } from "../../src/shared/protocol/application.js";
import {
  ApplicationSnapshotPublicationBoundary,
  ApplicationSnapshotService,
} from "../../src/server/application/application-snapshot-service.js";
import type { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import type { AssociatedTaskRecord } from "../../src/server/db/repositories/task-repository.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import type { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  principalId: "10000000-0000-4000-8000-000000000002",
};

const GLOBAL_TASK_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_TASK_ID = "20000000-0000-4000-8000-000000000002";
const THREAD_TASK_ID = "20000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000003";
const THREAD_ID = "30000000-0000-4000-8000-000000000002";

// 2024-08-01T00:00:00.000Z
const EPOCH = 1_722_470_400_000;

function taskRecord(
  overrides: Partial<AssociatedTaskRecord>,
): AssociatedTaskRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    id: GLOBAL_TASK_ID,
    scopeKind: "global",
    projectId: null,
    threadId: null,
    associatedProjectId: null,
    associatedWorkspaceId: null,
    title: "Task",
    details: "",
    pinned: false,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

function snapshotService(
  tasks: readonly AssociatedTaskRecord[],
  removed: { readonly project?: boolean; readonly location?: boolean } = {},
) {
  const inventory = {
    isWorkspaceRemoved: () => removed.location === true,
    isProjectRemoved: () => removed.project === true,
    listEnvironments: () => [
      {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        id: "environment-1",
        kind: "local" as const,
        label: "Local",
        availability: "available" as const,
        diagnosticCode: null,
        revision: 0,
      },
    ],
    listActiveProjects: () =>
      removed.project ? [] : [{ id: PROJECT_ID, name: "Project", revision: 0 }],
    listWorkspaces: () => removed.location ? [] : [
      {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        environmentId: "environment-1",
        projectId: PROJECT_ID,
        id: WORKSPACE_ID,
        canonicalPath: "/tmp/task-workspace",
        displayName: "Task workspace",
        availability: "available" as const,
        trustState: "trusted" as const,
        revision: 0,
        lastOpenedAt: EPOCH,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    ],
    countThreadsByInventoryState: () => ({
      active: 0,
      snoozed: 0,
      settled: 0,
      archived: 0,
    }),
  } as unknown as InventoryRepository;
  return new ApplicationSnapshotService(
    inventory,
    {
      list: () => [],
      listByIds: () => [],
      forkSelectionSaturated: () => false,
      structure: () => undefined,
    },
    {
      captureLoadedState: async () => undefined,
    } as unknown as Pick<ThreadRuntimeCoordinator, "captureLoadedState">,
    {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    {
      list: () => ({
        forkOrigins: [],
        lineagePlacements: [],
        lineageFamilies: [],
      }),
    },
    {
      listAssociated: () => tasks,
      listAssociatedByThread: (_scope, threadId) =>
        tasks.filter(
          (task) => task.scopeKind === "thread" && task.threadId === threadId,
        ),
      findAssociated: (_scope, taskId) => tasks.find(({ id }) => id === taskId),
    },
    { list: () => [] },
    () => "unavailable",
    { summariesByThread: () => new Map() },
  );
}

describe("task publication", () => {
  it("captures tasks in the application snapshot with ISO timestamps and scope shapes", async () => {
    const service = snapshotService([
      taskRecord({
        id: GLOBAL_TASK_ID,
        title: "Global task",
        completedAt: EPOCH + 2_000,
        revision: 2,
        updatedAt: EPOCH + 2_000,
      }),
      taskRecord({
        id: WORKSPACE_TASK_ID,
        scopeKind: "project",
        projectId: PROJECT_ID,
        associatedProjectId: PROJECT_ID,
        title: "Project task",
        details: "With details",
      }),
      taskRecord({
        id: THREAD_TASK_ID,
        scopeKind: "thread",
        threadId: THREAD_ID,
        associatedProjectId: PROJECT_ID,
        associatedWorkspaceId: WORKSPACE_ID,
        title: "Thread task",
      }),
    ]);

    const snapshot = await service.capture(scope);

    expect(snapshot.tasks).toEqual([
      {
        id: GLOBAL_TASK_ID,
        scope: { kind: "global" },
        associatedProjectId: null,
        title: "Global task",
        details: "",
        pinned: false,
        files: [],
        completedAt: "2024-08-01T00:00:02.000Z",
        revision: 2,
        createdAt: "2024-08-01T00:00:00.000Z",
        updatedAt: "2024-08-01T00:00:02.000Z",
      },
      {
        id: WORKSPACE_TASK_ID,
        scope: { kind: "project", projectId: PROJECT_ID },
        associatedProjectId: PROJECT_ID,
        title: "Project task",
        details: "With details",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: "2024-08-01T00:00:00.000Z",
        updatedAt: "2024-08-01T00:00:00.000Z",
      },
      {
        id: THREAD_TASK_ID,
        scope: { kind: "thread", threadId: THREAD_ID },
        associatedProjectId: PROJECT_ID,
        title: "Thread task",
        details: "",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: "2024-08-01T00:00:00.000Z",
        updatedAt: "2024-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("publishes a task upsert for an existing task", async () => {
    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshotService([
        taskRecord({
          id: WORKSPACE_TASK_ID,
          scopeKind: "project",
          projectId: PROJECT_ID,
          associatedProjectId: PROJECT_ID,
          title: "Publish me",
          pinned: true,
          files: ["/tmp/publish-me.md"],
          revision: 1,
        }),
      ]),
      new ScopedApplicationEventHubs(),
    );
    const published: ApplicationEventEnvelope["event"][] = [];
    const subscription = boundary
      .hub(scope)
      .subscribe(({ event }) => published.push(event));

    const initial = await boundary.snapshots.capture(scope);
    boundary
      .hub(scope)
      .publish({
        type: "snapshot",
        generation: boundary.hub(scope).generation,
        snapshot: { ...initial, tasks: [] },
      });
    published.length = 0;
    await boundary.publishTaskChange(scope, WORKSPACE_TASK_ID);
    await boundary.flush();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "task_upsert",
      task: {
        id: WORKSPACE_TASK_ID,
        scope: { kind: "project", projectId: PROJECT_ID },
        associatedProjectId: PROJECT_ID,
        title: "Publish me",
        pinned: true,
        files: ["/tmp/publish-me.md"],
        revision: 1,
        createdAt: "2024-08-01T00:00:00.000Z",
      },
    });
    subscription.close();
  });

  it("hides project tasks only with their project and thread tasks with their location", async () => {
    const records = [
      taskRecord({
        id: WORKSPACE_TASK_ID,
        scopeKind: "project",
        projectId: PROJECT_ID,
        associatedProjectId: PROJECT_ID,
      }),
      taskRecord({
        id: THREAD_TASK_ID,
        scopeKind: "thread",
        threadId: THREAD_ID,
        associatedProjectId: PROJECT_ID,
        associatedWorkspaceId: WORKSPACE_ID,
      }),
    ];
    // A removed location hides its thread tasks; its project's tasks stay.
    const locationRemoved = await snapshotService(records, {
      location: true,
    }).capture(scope);
    expect(locationRemoved.tasks.map(({ id }) => id)).toEqual([
      WORKSPACE_TASK_ID,
    ]);
    const removedProject = await snapshotService(records, {
      location: true,
      project: true,
    }).capture(scope);
    expect(removedProject.tasks).toEqual([]);

    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshotService(records, { location: true }),
      new ScopedApplicationEventHubs(),
    );
    const published: ApplicationEventEnvelope["event"][] = [];
    const subscription = boundary
      .hub(scope)
      .subscribe(({ event }) => published.push(event));
    boundary.hub(scope).publish({
      type: "snapshot",
      generation: boundary.hub(scope).generation,
      snapshot: { ...locationRemoved, tasks: [] },
    });
    published.length = 0;
    await boundary.publishTaskChange(scope, THREAD_TASK_ID);
    await boundary.publishTaskChange(scope, WORKSPACE_TASK_ID);
    await boundary.flush();
    expect(published).toEqual([
      expect.objectContaining({
        type: "task_upsert",
        task: expect.objectContaining({ id: WORKSPACE_TASK_ID }),
      }),
    ]);
    subscription.close();
  });

  it("publishes a task removal when the task row is gone", async () => {
    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshotService([]),
      new ScopedApplicationEventHubs(),
    );
    const published: ApplicationEventEnvelope["event"][] = [];
    const subscription = boundary
      .hub(scope)
      .subscribe(({ event }) => published.push(event));

    const initial = await snapshotService([taskRecord({})]).capture(scope);
    boundary
      .hub(scope)
      .publish({
        type: "snapshot",
        generation: boundary.hub(scope).generation,
        snapshot: initial,
      });
    published.length = 0;
    await boundary.publishTaskChange(scope, GLOBAL_TASK_ID);
    await boundary.flush();

    expect(published).toEqual([
      expect.objectContaining({ type: "task_remove", taskId: GLOBAL_TASK_ID }),
    ]);
    subscription.close();
  });

  it("suppresses an identical repeat publication within one generation and republishes a change", async () => {
    const records = [taskRecord({ id: GLOBAL_TASK_ID, title: "Steady task" })];
    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshotService(records),
      new ScopedApplicationEventHubs(),
    );
    const published: ApplicationEventEnvelope["event"][] = [];
    const subscription = boundary
      .hub(scope)
      .subscribe(({ event }) => published.push(event));

    const initial = await boundary.snapshots.capture(scope);
    boundary
      .hub(scope)
      .publish({
        type: "snapshot",
        generation: boundary.hub(scope).generation,
        snapshot: { ...initial, tasks: [] },
      });
    published.length = 0;
    await boundary.publishTaskChange(scope, GLOBAL_TASK_ID);
    await boundary.flush();
    await boundary.publishTaskChange(scope, GLOBAL_TASK_ID);
    await boundary.flush();
    expect(published.map(({ type }) => type)).toEqual(["task_upsert"]);

    records[0] = taskRecord({
      id: GLOBAL_TASK_ID,
      title: "Steady task",
      completedAt: EPOCH + 1_000,
      revision: 1,
      updatedAt: EPOCH + 1_000,
    });
    await boundary.publishTaskChange(scope, GLOBAL_TASK_ID);
    await boundary.flush();
    expect(published.map(({ type }) => type)).toEqual([
      "task_upsert",
      "task_upsert",
    ]);
    expect(published[1]).toMatchObject({
      type: "task_upsert",
      task: { revision: 1, completedAt: "2024-08-01T00:00:01.000Z" },
    });
    subscription.close();
  });
});
