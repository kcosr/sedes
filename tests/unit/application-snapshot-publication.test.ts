import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../src/shared/protocol/application.js";
import type { ApplicationThreadDurableSummary } from "../../src/server/application/application-snapshot-service.js";
import {
  ApplicationSnapshotPublicationBoundary,
  type ApplicationSnapshotService,
} from "../../src/server/application/application-snapshot-service.js";
import type { AssociatedTaskRecord } from "../../src/server/db/repositories/task-repository.js";
import { presentAssociatedTask } from "../../src/server/application/task-presentation.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  principalId: "10000000-0000-4000-8000-000000000002",
};
const TASK_WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const MOVED_TASK_WORKSPACE_ID = "30000000-0000-4000-8000-000000000002";

function snapshot(active: number): NormalizedApplicationSnapshot {
  return {
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "available" as const,
      },
    ],
    workspaces: [],
    threads: [],
    forkOrigins: [],
    lineagePlacements: [],
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
    advisories: [],
    defaultNewThreadTargetId: "target-1",
    counts: { active, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function capturedService(
  capture: (scope: RequestScope) => Promise<NormalizedApplicationSnapshot>,
  extra: Record<string, unknown> = {},
): ApplicationSnapshotService {
  const captureMetadata = new WeakMap<
    NormalizedApplicationSnapshot,
    ReadonlyMap<string, boolean>
  >();
  return {
    ...extra,
    captureMetadata,
    capture: async (requestedScope: RequestScope) => {
      const result = await capture(requestedScope);
      captureMetadata.set(
        result,
        new Map(result.environments.map(({ id }) => [id, false])),
      );
      return result;
    },
  } as unknown as ApplicationSnapshotService;
}

function durableSummary(
  threadId: string,
  threadRevision: number,
): ApplicationThreadDurableSummary {
  return {
    id: threadId,
    workspaceId: TASK_WORKSPACE_ID,
    targetId: "target-1",
    title: { text: "Thread" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    pinned: false,
    pinRevision: 0,
    preferredWorktree: null,
    preferredWorktreeRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    threadRevision,
    available: true,
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    stateChangedAt: "2026-08-04T00:00:00.000Z",
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

function associatedThreadTask(
  threadId: string,
  associatedWorkspaceId: string,
): AssociatedTaskRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    id: "20000000-0000-4000-8000-000000000001",
    scopeKind: "thread",
    environmentId: null,
    workspaceId: null,
    threadId,
    associatedWorkspaceId,
    title: "Thread task",
    details: "",
    pinned: false,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: 1_722_470_400_000,
    updatedAt: 1_722_470_400_000,
  };
}

function incrementalSnapshots(input: {
  readonly summaries: readonly ApplicationThreadDurableSummary[];
  readonly tasks?: readonly AssociatedTaskRecord[];
  readonly runState?: NormalizedApplicationThreadSummary["runState"];
  readonly terminalSummary?: NormalizedApplicationThreadSummary["terminalSummary"];
  readonly active?: number;
  readonly groups?: NormalizedApplicationSnapshot["groups"];
}) {
  const terminalSummary = input.terminalSummary ?? {
    runningCount: 0,
    retainedCount: 0,
  };
  const currentSnapshot = async (): Promise<NormalizedApplicationSnapshot> => {
    return {
      ...snapshot(input.active ?? 1),
      workspaces: [
        ...new Set(input.summaries.map((thread) => thread.workspaceId)),
      ].map((id) => ({
        id,
        environmentId: "environment-1",
        label: { text: "Workspace" },
        displayPath: { text: "/workspace" },
        available: true,
      })),
      threads: input.summaries.map((current) => ({
        ...current,
        terminalSummary,
        runState: input.runState ?? "idle",
      })),
      groups: input.groups ?? [],
      advisories: [],
      tasks: (input.tasks ?? []).map(presentAssociatedTask),
    };
  };
  const capture = vi.fn(currentSnapshot);
  const service = capturedService(capture, {
    inventory: {
      isWorkspaceRemoved: () => false,
      countThreadsByInventoryState: () => ({
        active: input.active ?? 1,
        snoozed: 0,
        settled: 0,
        archived: 0,
      }),
    },
    summaries: {
      listByIds: vi.fn((_scope, ids: readonly string[]) =>
        input.summaries.filter((thread) => ids.includes(thread.id)),
      ),
      structure: vi.fn((_scope, id: string) =>
        input.summaries.some((thread) => thread.id === id)
          ? {
              environmentId: "environment-1",
              isFork: false,
              isForkSource: false,
            }
          : undefined,
      ),
    },
    terminalSummaries: {
      summariesByThread: vi.fn(
        (_scope, threadIds: readonly string[]) =>
          new Map(threadIds.map((threadId) => [threadId, terminalSummary])),
      ),
    },
    runtimes: {
      captureLoadedState: vi.fn(async () =>
        input.runState === undefined ? undefined : { runState: input.runState },
      ),
    },
    tasks: {
      listAssociatedByThread: vi.fn((_scope, threadId) =>
        (input.tasks ?? []).filter(
          (task) => task.scopeKind === "thread" && task.threadId === threadId,
        ),
      ),
    },
  });
  service.capture = vi.fn(service.capture);
  return service;
}

describe("ApplicationSnapshotPublicationBoundary", () => {
  it("coalesces 20000 same-thread hints during recovery into one reread and preserves force", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      const changes: NormalizedApplicationThreadSummary[] = [];
      hub.subscribe(({ event }) => {
        if (event.type === "thread_upsert") changes.push(event.thread);
      });
      await boundary.checkpoint(scope, hub);
      const recovery = boundary.checkpoint(scope, hub, true);
      await vi.advanceTimersByTimeAsync(0);
      const admissions: Promise<void>[] = [];
      for (let index = 0; index < 20_000; index++) {
        admissions.push(
          boundary.publishThreadChange(scope, "thread-1", {
            forcePublication: index === 10,
          }),
        );
      }
      await Promise.all(admissions);
      summaries[0] = durableSummary("thread-1", 7);
      expect(service.summaries.listByIds).not.toHaveBeenCalled();
      expect(service.runtimes.captureLoadedState).not.toHaveBeenCalled();
      let flushed = false;
      const flushing = boundary.flush().then(() => {
        flushed = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(flushed).toBe(false);
      expect(service.capture).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([recovery, flushing]);
      expect(flushed).toBe(true);
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(service.summaries.listByIds).toHaveBeenCalledTimes(1);
      expect(service.runtimes.captureLoadedState).toHaveBeenCalledTimes(1);
      // The fresh baseline already includes revision 7, so this single event
      // proves the early force flag survived 19989 later ordinary hints.
      expect(changes).toHaveLength(1);
      expect(changes[0]?.threadRevision).toBe(7);
      await boundary.publishThreadChange(scope, "thread-1", {
        forcePublication: true,
      });
      await boundary.publishThreadChange(scope, "thread-1", {
        forcePublication: true,
      });
      await boundary.flush();
      expect(changes).toHaveLength(3);
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces task rereads and keeps the highest workpad revision for each document or draft", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(async () => snapshot(0));
    const taskId = "20000000-0000-4000-8000-000000000001";
    let row: AssociatedTaskRecord = {
      ...associatedThreadTask("thread-1", TASK_WORKSPACE_ID),
      scopeKind: "global",
      threadId: null,
      associatedWorkspaceId: null,
    };
    const findAssociated = vi.fn(() => row);
    const service = capturedService(capture, {
      tasks: { findAssociated },
      inventory: { isWorkspaceRemoved: () => false },
    });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: Array<
      import("../../src/shared/protocol/application.js").NormalizedApplicationEvent
    > = [];
    hub.subscribe(({ event }) => events.push(event));
    try {
      await boundary.checkpoint(scope, hub);
      capture.mockImplementationOnce(() => pending.promise);
      await boundary.publishAuthoritativeReplacement(scope);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
      for (let revision = 1; revision <= 100; revision++) {
        row = { ...row, revision };
        await boundary.publishTaskChange(scope, taskId);
        await boundary.publishWorkpadChange(
          scope,
          "workpad-1",
          revision,
          "document",
        );
      }
      await boundary.publishWorkpadChange(scope, "workpad-1", 20, "document");
      await boundary.publishWorkpadChange(scope, "workpad-1", 3, "draft");
      await boundary.publishWorkpadChange(scope, "workpad-1", 5, "draft");
      await boundary.publishWorkpadChange(scope, "workpad-2", 7, "document");
      expect(findAssociated).not.toHaveBeenCalled();
      pending.resolve(snapshot(0));
      await boundary.flush();
      expect(findAssociated).toHaveBeenCalledTimes(1);
      expect(
        events.filter((event) => event.type === "task_upsert"),
      ).toMatchObject([{ task: { id: taskId, revision: 100 } }]);
      expect(
        events.filter((event) => event.type === "workpad_changed"),
      ).toMatchObject([
        { workpadId: "workpad-1", change: "document", revision: 100 },
        { workpadId: "workpad-1", change: "draft", revision: 5 },
        { workpadId: "workpad-2", change: "document", revision: 7 },
      ]);
      await boundary.publishWorkpadChange(scope, "workpad-1", 101, "document");
      await boundary.publishWorkpadChange(scope, "workpad-1", 102, "document");
      await boundary.flush();
      expect(
        events.filter((event) => event.type === "workpad_changed").slice(-2),
      ).toMatchObject([{ revision: 101 }, { revision: 102 }]);
    } finally {
      pending.resolve(snapshot(0));
      await boundary.close();
    }
  });

  it("retains one subsequent reread for hints arriving during an awaited coalesced thread read", async () => {
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const initial = await service.capture(scope);
    const pending = deferred<NormalizedApplicationSnapshot>();
    const runtimeStarted = deferred<void>();
    const runtimeFinished = deferred<void>();
    vi.mocked(service.capture)
      .mockClear()
      .mockImplementationOnce(() => pending.promise);
    vi.mocked(service.runtimes.captureLoadedState).mockImplementationOnce(
      async () => {
        runtimeStarted.resolve();
        await runtimeFinished.promise;
        return undefined;
      },
    );
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const revisions: number[] = [];
    hub.subscribe(({ event }) => {
      if (event.type === "thread_upsert")
        revisions.push(event.thread.threadRevision);
    });
    try {
      const seed = boundary.checkpoint(scope, hub);
      await vi.waitFor(() => expect(service.capture).toHaveBeenCalledTimes(1));
      summaries[0] = durableSummary("thread-1", 7);
      await boundary.publishThreadChange(scope, "thread-1");
      pending.resolve(initial);
      await runtimeStarted.promise;
      summaries[0] = durableSummary("thread-1", 8);
      for (let index = 0; index < 100; index++)
        await boundary.publishThreadChange(scope, "thread-1");
      let flushed = false;
      const flushing = boundary.flush().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBe(false);
      runtimeFinished.resolve();
      await Promise.all([seed, flushing]);
      expect(service.summaries.listByIds).toHaveBeenCalledTimes(2);
      expect(service.runtimes.captureLoadedState).toHaveBeenCalledTimes(2);
      expect(revisions).toEqual([7, 8]);
      expect(
        hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
      ).toBe(8);
    } finally {
      pending.resolve(initial);
      runtimeFinished.resolve();
      await boundary.close();
    }
  });

  it("merges a later force hint when a coalesced runtime read must retry after replacement", async () => {
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const initial = await service.capture(scope);
    const pending = deferred<NormalizedApplicationSnapshot>();
    const runtimeStarted = deferred<void>();
    const runtimeFinished = deferred<void>();
    vi.mocked(service.capture)
      .mockClear()
      .mockImplementationOnce(() => pending.promise);
    vi.mocked(service.runtimes.captureLoadedState).mockImplementationOnce(
      async () => {
        runtimeStarted.resolve();
        await runtimeFinished.promise;
        return undefined;
      },
    );
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const revisions: number[] = [];
    hub.subscribe(({ event }) => {
      if (event.type === "thread_upsert")
        revisions.push(event.thread.threadRevision);
    });
    try {
      const seed = boundary.checkpoint(scope, hub);
      await vi.waitFor(() => expect(service.capture).toHaveBeenCalledTimes(1));
      summaries[0] = durableSummary("thread-1", 7);
      await boundary.publishThreadChange(scope, "thread-1");
      pending.resolve(initial);
      await runtimeStarted.promise;
      summaries[0] = durableSummary("thread-1", 8);
      await boundary.publishAuthoritativeReplacement(scope);
      await boundary.publishThreadChange(scope, "thread-1", {
        forcePublication: true,
      });
      await boundary.publishThreadChange(scope, "thread-1");
      runtimeFinished.resolve();
      await seed;
      await boundary.flush();
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(service.summaries.listByIds).toHaveBeenCalledTimes(2);
      expect(service.runtimes.captureLoadedState).toHaveBeenCalledTimes(2);
      // Revision 7 was abandoned. The second capture already contains 8;
      // only the force hint makes its post-capture reread publish this event.
      expect(revisions).toEqual([8]);
      expect(
        hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
      ).toBe(8);
    } finally {
      pending.resolve(initial);
      runtimeFinished.resolve();
      await boundary.close();
    }
  });

  it("drops queued hints with a retired owner and does not leak force into its next generation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const service = incrementalSnapshots({
      summaries: [durableSummary("thread-1", 6)],
    });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      const subscriber = hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      const recovery = boundary
        .checkpoint(scope, hub, true)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      await boundary.publishThreadChange(scope, "thread-1", {
        forcePublication: true,
      });
      subscriber.close();
      expect(await recovery).toMatchObject({
        message: "application_projection_closed",
      });
      await boundary.flush();
      expect(service.summaries.listByIds).not.toHaveBeenCalled();
      const next = boundary.hub(scope);
      const changed = vi.fn();
      next.subscribe(({ event }) => {
        if (event.type === "thread_upsert") changed();
      });
      await boundary.checkpoint(scope, next);
      await boundary.publishThreadChange(scope, "thread-1");
      await boundary.flush();
      expect(next.generation).not.toBe(hub.generation);
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(service.summaries.listByIds).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("folds sustained deltas after a structural capture without recapture storms", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const summaries = [durableSummary("thread-1", 1)];
    const service = incrementalSnapshots({ summaries });
    const captureCurrent = vi.mocked(service.capture).getMockImplementation()!;
    const initial = await captureCurrent(scope);
    const capture = vi
      .fn(async (requested: RequestScope) => {
        const baseline = await captureCurrent(requested);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return baseline;
      })
      .mockResolvedValueOnce(initial);
    service.capture = capture;
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: string[] = [];
    const workpadRevisions: number[] = [];
    hub.subscribe(({ event }) => {
      events.push(event.type);
      if (event.type === "workpad_changed")
        workpadRevisions.push(event.revision);
    });
    let ticker: NodeJS.Timeout | undefined;
    try {
      await boundary.checkpoint(scope, hub);
      await boundary.publishAuthoritativeReplacement(scope);
      let revision = 1;
      ticker = setInterval(() => {
        summaries[0] = durableSummary("thread-1", ++revision);
        void boundary.publishThreadChange(scope, "thread-1");
        void boundary.publishWorkpadChange(
          scope,
          "20000000-0000-4000-8000-000000000006",
          revision,
          "document",
        );
      }, 10);
      await vi.advanceTimersByTimeAsync(400);
      clearInterval(ticker);
      await boundary.flush();
      expect(capture).toHaveBeenCalledTimes(2);
      expect(events.filter((type) => type === "snapshot")).toHaveLength(2);
      // The two hints waiting for the baseline merge to revision 3. All
      // subsequent ready-stream revisions are still published individually.
      expect(workpadRevisions).toEqual(
        Array.from({ length: 39 }, (_, index) => index + 3),
      );
      expect(events).toContain("thread_upsert");
      expect(
        hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
      ).toBe(41);
      expect(hub.requestedEpoch).toBe(hub.coveredEpoch);
    } finally {
      clearInterval(ticker);
      await boundary.close();
      vi.useRealTimers();
    }
  });

  it("does not reject a committed producer when its last subscriber leaves during capture", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(async () => snapshot(1));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const subscriber = hub.subscribe(() => undefined);
    await boundary.checkpoint(scope, hub);
    capture.mockImplementationOnce(() => pending.promise);
    const producer = boundary.publishAuthoritativeReplacement(scope);
    await expect(producer).resolves.toBeUndefined();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    const consumer = boundary.checkpoint(scope, hub);
    const rejected = expect(consumer).rejects.toThrow(
      "application_projection_closed",
    );
    subscriber.close();
    await rejected;
    pending.resolve(snapshot(2));
    await boundary.flush();
    expect(boundary.hubs.peek(scope)).toBeUndefined();
    await expect(producer).resolves.toBeUndefined();
    await boundary.close();
  });

  it("admits committed producers during backoff and flushes without polling or an early capture", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const capture = vi.fn(async () => snapshot(1));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      hub.recoverySpacing = 16_000;
      const recovery = boundary.checkpoint(scope, hub, true);
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        boundary.publishAuthoritativeReplacement(scope),
      ).resolves.toBeUndefined();
      await expect(
        boundary.publishWorkpadChange(
          scope,
          "20000000-0000-4000-8000-000000000006",
          1,
          "document",
        ),
      ).resolves.toBeUndefined();
      expect(performance.now()).toBe(0);
      let flushed = false;
      const polling = vi.spyOn(globalThis, "setImmediate");
      const flushing = boundary.flush().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(polling).not.toHaveBeenCalled();
      polling.mockRestore();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(flushed).toBe(false);
      expect(capture).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([recovery, flushing]);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(flushed).toBe(true);
      expect(hub.watermark).toBe(3);
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("suppresses a delta when a structural replacement arrives during its runtime read", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const runtimeStarted = deferred<void>();
    const runtimeFinished = deferred<void>();
    try {
      const hub = boundary.hub(scope);
      const events: string[] = [];
      hub.subscribe(({ event }) => events.push(event.type));
      await boundary.checkpoint(scope, hub);
      vi.mocked(service.runtimes.captureLoadedState).mockImplementationOnce(
        async () => {
          runtimeStarted.resolve();
          await runtimeFinished.promise;
          return undefined;
        },
      );
      summaries[0] = durableSummary("thread-1", 7);
      const delta = boundary.publishThreadChange(scope, "thread-1");
      await runtimeStarted.promise;
      summaries[0] = {
        ...durableSummary("thread-1", 8),
        title: { text: "Current durable title" },
      };
      const replacement = boundary.publishAuthoritativeReplacement(scope);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.capture).toHaveBeenCalledTimes(1);
      runtimeFinished.resolve();
      // An expected structural replacement does not enter timed recovery.
      await vi.advanceTimersByTimeAsync(0);
      expect(service.capture).toHaveBeenCalledTimes(2);
      await Promise.all([delta, replacement]);
      expect(events).toEqual(["snapshot", "snapshot"]);
      expect(hub.currentCheckpoint()?.event.snapshot.threads[0]).toMatchObject({
        threadRevision: 8,
        title: { text: "Current durable title" },
      });
      expect(performance.now()).toBe(0);
    } finally {
      runtimeFinished.resolve();
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops remaining task publications when a thread subscriber requests replacement", async () => {
    const threadId = "30000000-0000-4000-8000-000000000003";
    const summaries = [durableSummary("existing-thread", 1)];
    const tasks: AssociatedTaskRecord[] = [];
    const service = incrementalSnapshots({ summaries, tasks });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: string[] = [];
    hub.subscribe(({ event }) => {
      events.push(event.type);
      if (event.type === "thread_upsert") {
        boundary.handoffAuthoritativeReplacement(scope);
      }
    });
    try {
      await boundary.checkpoint(scope, hub);
      summaries.push(durableSummary(threadId, 1));
      tasks.push(associatedThreadTask(threadId, TASK_WORKSPACE_ID));
      await boundary.publishThreadChange(scope, threadId);
      await boundary.flush();
      expect(events).toEqual(["snapshot", "thread_upsert", "snapshot"]);
      expect(service.tasks.listAssociatedByThread).not.toHaveBeenCalled();
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(hub.currentCheckpoint()?.event.snapshot.tasks).toEqual(
        tasks.map(presentAssociatedTask),
      );
      expect(
        hub.currentCheckpoint()?.event.snapshot.threads.map(({ id }) => id),
      ).toEqual(["existing-thread", threadId]);
    } finally {
      await boundary.close();
    }
  });

  it("coalesces repeated recovery requests with exponential spacing and a clean-interval reset", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const capture = vi.fn(async () => snapshot(1));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      for (const delay of [
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]) {
        const before = capture.mock.calls.length;
        const recoveries = Array.from({ length: 5 }, () =>
          boundary.checkpoint(scope, hub, true),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(hub.state).toBe("recapturing");
        expect(capture).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(capture).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.all(recoveries);
        expect(capture).toHaveBeenCalledTimes(before + 1);
        expect(hub.state).toBe("ready");
      }
      await vi.advanceTimersByTimeAsync(60_000);
      const before = capture.mock.calls.length;
      // Sixty clean seconds also already satisfy the reset minimum interval.
      await boundary.checkpoint(scope, hub, true);
      expect(capture).toHaveBeenCalledTimes(before + 1);
      const next = boundary.checkpoint(scope, hub, true);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(capture).toHaveBeenCalledTimes(before + 1);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(capture).toHaveBeenCalledTimes(before + 2);
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not apply recovery backoff to a structural follow-up after successful recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(async () => snapshot(3));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      capture.mockImplementationOnce(() => pending.promise);
      const recovery = boundary.checkpoint(scope, hub, true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(capture).toHaveBeenCalledTimes(2);
      const structural = boundary.publishAuthoritativeReplacement(scope);
      pending.resolve(snapshot(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).toHaveBeenCalledTimes(3);
      const [recovered] = await Promise.all([recovery, structural]);
      await boundary.flush();
      expect(recovered.snapshot.counts.active).toBe(2);
      expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(3);
      expect(hub.recoverySpacing).toBe(1_000);
      expect(performance.now()).toBe(1_000);
    } finally {
      pending.resolve(snapshot(2));
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not classify a passive join of structural capture as recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(async () => snapshot(3));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      capture.mockImplementationOnce(() => pending.promise);
      const first = boundary.publishAuthoritativeReplacement(scope);
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(hub.state).toBe("recapturing");
      expect(hub.invalidReason).toBeUndefined();
      const passive = boundary.checkpoint(scope, hub);
      const second = boundary.publishAuthoritativeReplacement(scope);
      pending.resolve(snapshot(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).toHaveBeenCalledTimes(3);
      const [, joined] = await Promise.all([first, passive, second]);
      await boundary.flush();
      expect(joined.snapshot.counts.active).toBe(2);
      expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(3);
      expect(hub.recoverySpacing).toBe(0);
      expect(performance.now()).toBe(0);
    } finally {
      pending.resolve(snapshot(2));
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("honors a force request arriving while structural capture waits for the publication lane", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const runtimeStarted = deferred<void>();
    const runtimeFinished = deferred<void>();
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      vi.mocked(service.runtimes.captureLoadedState).mockImplementationOnce(
        async () => {
          runtimeStarted.resolve();
          await runtimeFinished.promise;
          return undefined;
        },
      );
      summaries[0] = durableSummary("thread-1", 7);
      const delta = boundary.publishThreadChange(scope, "thread-1");
      await runtimeStarted.promise;
      const structural = boundary.publishAuthoritativeReplacement(scope);
      // Let the capture driver queue behind the suspended delta before the
      // forced request upgrades that same operation to recovery.
      await vi.advanceTimersByTimeAsync(0);
      const forced = boundary.checkpoint(scope, hub, true);
      runtimeFinished.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.capture).toHaveBeenCalledTimes(1);
      expect(hub.recoverySpacing).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(service.capture).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const [, , recovered] = await Promise.all([delta, structural, forced]);
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(hub.currentCheckpoint()).toBe(recovered.envelope);
      expect(recovered.snapshot.threads[0]?.threadRevision).toBe(7);
      expect(hub.recoverySpacing).toBe(1_000);
      expect(performance.now()).toBe(1_000);
    } finally {
      runtimeFinished.resolve();
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels delayed recovery on shutdown without starting another capture", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const capture = vi.fn(async () => snapshot(1));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      const recovery = boundary
        .checkpoint(scope, hub, true)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      await boundary.close();
      expect(await recovery).toMatchObject({
        message: "application_projection_closed",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(hub.state).toBe("closed");
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("audits after sixty seconds of changes and defers idle audits until reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now());
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    try {
      const hub = boundary.hub(scope);
      const subscription = hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      const materialize = vi.spyOn(hub.projection!, "materialize");
      summaries[0] = durableSummary("thread-1", 7);
      await boundary.publishThreadChange(scope, "thread-1");
      await boundary.flush();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(materialize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(service.capture).toHaveBeenCalledTimes(1);

      summaries[0] = durableSummary("thread-1", 8);
      await boundary.publishThreadChange(scope, "thread-1");
      await boundary.flush();
      subscription.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(materialize).toHaveBeenCalledTimes(1);
      const resumed = hub.subscribe(() => undefined);
      await boundary.checkpoint(scope, hub);
      expect(materialize).toHaveBeenCalledTimes(2);
      expect(service.capture).toHaveBeenCalledTimes(1);
      expect(
        hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
      ).toBe(8);
      resumed.close();
    } finally {
      await boundary.close();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("drops absent producers and retires idle replacements without capture", async () => {
    const capture = vi.fn(async () => snapshot(1));
    const hubs = new ScopedApplicationEventHubs();
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      hubs,
    );
    await boundary.publishAuthoritativeReplacement(scope);
    await boundary.publishWorkpadChange(scope, "workpad-1", 1, "document");
    expect(hubs.retainedHubCount).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    const hub = boundary.hub(scope);
    const subscription = hub.subscribe(() => undefined);
    await boundary.checkpoint(scope, hub);
    subscription.close();
    await boundary.publishAuthoritativeReplacement(scope);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(hub.state).toBe("closed");
    expect(hubs.retainedHubCount).toBe(0);
    await boundary.close();
  });

  it("admits bulk structural changes during a blocked seed before runtime callbacks", async () => {
    const groupId = "40000000-0000-4000-8000-000000000001";
    const summaries = [{ ...durableSummary("thread-1", 1), groupId }];
    const groups = [
      {
        id: groupId,
        name: "Group",
        revision: 1,
        memberCount: 1,
        activeMemberCount: 1,
      },
    ];
    const input = { summaries, groups, active: 1 };
    const service = incrementalSnapshots(input);
    const stale = await service.capture(scope);
    stale.groups = stale.groups.map((group) => ({ ...group }));
    const pending = deferred<NormalizedApplicationSnapshot>();
    vi.mocked(service.capture)
      .mockClear()
      .mockImplementationOnce(() => pending.promise);
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const published: NormalizedApplicationSnapshot[] = [];
    hub.subscribe(({ event }) => {
      if (event.type === "snapshot") published.push(event.snapshot);
    });
    try {
      const seed = boundary.checkpoint(scope, hub);
      await vi.waitFor(() => expect(service.capture).toHaveBeenCalledTimes(1));

      // The archive commits while capture is blocked. Its ordinary per-thread
      // runtime notifications have not run; the structural admission itself
      // must require a newer capture and cover a subsequently joining client.
      summaries[0] = {
        ...summaries[0]!,
        inventoryState: "archived",
        inventoryRevision: 2,
      };
      groups[0] = { ...groups[0]!, activeMemberCount: 0 };
      input.active = 0;
      boundary.handoffStructuralThreadChanges(scope, ["thread-1"]);
      boundary.handoffStructuralThreadChanges(scope, ["thread-1"]);
      const joined = boundary.checkpoint(scope, hub);
      pending.resolve(stale);

      const [initial, current] = await Promise.all([seed, joined]);
      await boundary.flush();
      expect(initial.snapshot.groups[0]?.activeMemberCount).toBe(1);
      expect(current.snapshot.groups[0]?.activeMemberCount).toBe(0);
      expect(current.snapshot.threads[0]?.inventoryState).toBe("archived");
      expect(current.snapshot.counts.active).toBe(0);
      expect(
        published.map((value) => value.groups[0]?.activeMemberCount),
      ).toEqual([1, 0]);
      expect(hub.currentCheckpoint()?.event.snapshot).toEqual(current.snapshot);
      expect(hub.pendingReplacement).toBe(false);
      expect(service.capture).toHaveBeenCalledTimes(2);
      expect(service.runtimes.captureLoadedState).not.toHaveBeenCalled();
    } finally {
      pending.resolve(stale);
      await boundary.close();
    }
  });

  it("shares the seed and current checkpoint between subscribers without recapture", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(() => pending.promise);
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const firstSubscription = hub.subscribe(() => undefined);
    const first = boundary.checkpoint(scope, hub);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const secondSubscription = hub.subscribe(() => undefined);
    const second = boundary.checkpoint(scope, hub);
    pending.resolve(snapshot(1));
    const results = await Promise.all([first, second]);
    expect(results[0].envelope).toBe(results[1].envelope);
    const warm = await boundary.checkpoint(scope, hub);
    expect(warm.envelope).toBe(results[0].envelope);
    expect(capture).toHaveBeenCalledTimes(1);
    firstSubscription.close();
    secondSubscription.close();
    await boundary.close();
  });

  it("makes explicit recovery during capture wait for one later capture", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi
      .fn(async () => snapshot(2))
      .mockImplementationOnce(() => pending.promise);
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    hub.subscribe(() => undefined);
    const initial = boundary.checkpoint(scope, hub);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const recovery = boundary.checkpoint(scope, hub, true);
    pending.resolve(snapshot(1));
    const recovered = await recovery;
    expect((await initial).snapshot.counts.active).toBe(1);
    expect(recovered.snapshot.counts.active).toBe(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(hub.currentCheckpoint()?.event.snapshot.counts.active).toBe(2);
    await boundary.close();
  });

  it("retires a failed seed and lets the next subscriber seed a new generation", async () => {
    const capture = vi
      .fn(async () => snapshot(2))
      .mockRejectedValueOnce(new Error("capture failed"));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    const first = boundary.hub(scope);
    first.subscribe(() => undefined);
    await expect(boundary.checkpoint(scope, first)).rejects.toThrow(
      "capture failed",
    );
    expect(first.state).toBe("closed");
    const second = boundary.hub(scope);
    second.subscribe(() => undefined);
    expect(second.generation).not.toBe(first.generation);
    expect(
      (await boundary.checkpoint(scope, second)).snapshot.counts.active,
    ).toBe(2);
    expect(capture).toHaveBeenCalledTimes(2);
    await boundary.close();
  });

  it("applies a delta crossing initial capture after the seed without another capture", async () => {
    const summaries = [durableSummary("thread-1", 6)];
    const service = incrementalSnapshots({ summaries });
    const initial = await service.capture(scope);
    const pending = deferred<NormalizedApplicationSnapshot>();
    vi.mocked(service.capture)
      .mockClear()
      .mockImplementationOnce(() => pending.promise);
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: string[] = [];
    hub.subscribe(({ event }) => events.push(event.type));
    const seed = boundary.checkpoint(scope, hub);
    await vi.waitFor(() => expect(service.capture).toHaveBeenCalledTimes(1));
    summaries[0] = durableSummary("thread-1", 7);
    const delta = boundary.publishThreadChange(scope, "thread-1");
    pending.resolve(initial);
    await Promise.all([seed, delta]);
    await boundary.flush();
    expect(events).toEqual(["snapshot", "thread_upsert"]);
    expect(service.capture).toHaveBeenCalledTimes(1);
    expect(
      hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
    ).toBe(7);
    await boundary.close();
  });

  it("retires a pending seed immediately when its last subscriber leaves", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(() => pending.promise);
    const hubs = new ScopedApplicationEventHubs();
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      hubs,
    );
    const hub = boundary.hub(scope);
    const subscription = hub.subscribe(() => undefined);
    const result = boundary.checkpoint(scope, hub).catch((error) => error);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    subscription.close();
    expect(hub.state).toBe("closed");
    expect(hubs.retainedHubCount).toBe(0);
    expect(await result).toMatchObject({
      message: "application_projection_closed",
    });
    pending.resolve(snapshot(1));
    await boundary.close();
    expect(hub.state).toBe("closed");
  });

  it("coalesces one grouped bulk archive page into a structural replacement", async () => {
    const groupId = "40000000-0000-4000-8000-000000000001";
    const summaries = Array.from({ length: 100 }, (_, index) => ({
      ...durableSummary(`thread-${index}`, 1),
      groupId,
    }));
    const groups = [
      {
        id: groupId,
        name: "Group",
        revision: 1,
        memberCount: 100,
        activeMemberCount: 100,
      },
    ];
    const service = incrementalSnapshots({ summaries, groups, active: 100 });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: string[] = [];
    hub.subscribe(({ event }) => events.push(event.type));
    await boundary.checkpoint(scope, hub);
    for (let index = 0; index < summaries.length; index += 1) {
      summaries[index] = {
        ...summaries[index]!,
        inventoryState: "archived",
        inventoryRevision: 2,
      };
    }
    groups[0] = { ...groups[0]!, activeMemberCount: 0 };
    boundary.handoffStructuralThreadChanges(
      scope,
      summaries.map(({ id }) => id),
    );
    await Promise.all(
      summaries.map(({ id }) => boundary.publishThreadChange(scope, id)),
    );
    await boundary.flush();
    expect(service.capture).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["snapshot", "snapshot"]);
    expect(
      hub.currentCheckpoint()?.event.snapshot.groups[0]?.activeMemberCount,
    ).toBe(0);
    expect(
      hub
        .currentCheckpoint()
        ?.event.snapshot.threads.every(
          (thread) => thread.inventoryState === "archived",
        ),
    ).toBe(true);
    await boundary.close();
  });

  it("recovers an in-lane fold failure without exposing the delta or deadlocking", async () => {
    const summaries = [durableSummary("thread-1", 7)];
    const service = incrementalSnapshots({ summaries });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      service,
      new ScopedApplicationEventHubs(),
    );
    const hub = boundary.hub(scope);
    const events: string[] = [];
    hub.subscribe(({ event }) => events.push(event.type));
    await boundary.checkpoint(scope, hub);
    hub.lastCaptureAt = -Infinity;
    vi.spyOn(service.summaries, "listByIds").mockReturnValueOnce([
      durableSummary("thread-1", 6),
    ]);
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();
    expect(events).toEqual(["snapshot", "snapshot"]);
    expect(
      hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
    ).toBe(7);
    summaries[0] = durableSummary("thread-1", 8);
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();
    expect(events.at(-1)).toBe("thread_upsert");
    expect(
      hub.currentCheckpoint()?.event.snapshot.threads[0]?.threadRevision,
    ).toBe(8);
    await boundary.close();
  });

  it("owns and drains a handed-off full replacement", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(() => pending.promise);
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );

    boundary.hub(scope).subscribe(() => undefined);
    boundary.handoffAuthoritativeReplacement(scope);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = boundary.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    pending.resolve(snapshot(1));
    await closing;
    expect(closed).toBe(true);
  });

  it("stops admission and drains already-admitted publication tails", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(vi.fn(() => pending.promise)),
      new ScopedApplicationEventHubs(),
    );

    boundary.hub(scope).subscribe(() => undefined);
    const publication = boundary.publishAuthoritativeReplacement(scope);
    let closeSettled = false;
    const closing = boundary.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    await expect(
      boundary.publishAuthoritativeReplacement(scope),
    ).rejects.toThrow("application_snapshot_publication_boundary_closed");

    pending.resolve(snapshot(1));
    await publication;
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("flushes admitted work without closing later availability admission", async () => {
    const first = deferred<NormalizedApplicationSnapshot>();
    const capture = vi
      .fn<() => Promise<NormalizedApplicationSnapshot>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(snapshot(2));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );

    boundary.hub(scope).subscribe(() => undefined);
    const publication = boundary.publishAuthoritativeReplacement(scope);
    const flushing = boundary.flush();
    first.resolve(snapshot(1));
    await Promise.all([publication, flushing]);

    await boundary.publishAuthoritativeReplacement(scope);
    await boundary.flush();
    expect(
      boundary.hub(scope).currentCheckpoint()?.event.snapshot.counts.active,
    ).toBe(2);
  });

  it("publishes an authoritative replacement for an environment availability change", async () => {
    const capture = vi.fn(async () => snapshot(1));
    const getEnvironment = vi.fn(() => ({
      id: "environment-1",
      kind: "local" as const,
      label: "Remote",
      availability: "unavailable" as const,
      diagnosticCode: "backend_runtime_unavailable",
    }));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture, { inventory: { getEnvironment } }),
      new ScopedApplicationEventHubs(),
    );
    const published: NormalizedApplicationSnapshot[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "snapshot") published.push(event.snapshot);
    });

    await boundary.publishEnvironmentChange(scope, "environment-1");
    await boundary.flush();

    expect(getEnvironment).toHaveBeenCalledWith(scope, "environment-1");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(published).toEqual([snapshot(1)]);
    subscription.close();
  });

  it("hands off an environment replacement produced during snapshot capture", async () => {
    const getEnvironment = vi.fn(() => ({
      id: "environment-1",
      kind: "ssh" as const,
      label: "Remote",
      availability: "available" as const,
      diagnosticCode: null,
    }));
    let boundary!: ApplicationSnapshotPublicationBoundary;
    const capture = vi
      .fn<() => Promise<NormalizedApplicationSnapshot>>()
      .mockImplementationOnce(async () => {
        boundary.handoffEnvironmentChange(scope, "environment-1");
        return snapshot(1);
      })
      .mockResolvedValueOnce(snapshot(2));
    boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture, { inventory: { getEnvironment } }),
      new ScopedApplicationEventHubs(),
    );

    boundary.hub(scope).subscribe(() => undefined);
    await boundary.publishAuthoritativeReplacement(scope);
    await boundary.flush();

    expect(getEnvironment).toHaveBeenCalledWith(scope, "environment-1");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("publishes a newer crossing mutation after a delayed stale capture", async () => {
    const stale = deferred<NormalizedApplicationSnapshot>();
    let durableActive = 1;
    const capture = vi
      .fn<() => Promise<NormalizedApplicationSnapshot>>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementation(async () => snapshot(durableActive));
    const hubs = new ScopedApplicationEventHubs();
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      hubs,
    );
    const published: NormalizedApplicationSnapshot[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "snapshot") published.push(event.snapshot);
    });

    const older = boundary.publishAuthoritativeReplacement(scope);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    durableActive = 2;
    const newer = boundary.publishAuthoritativeReplacement(scope);

    expect(capture).toHaveBeenCalledTimes(1);
    stale.resolve(snapshot(1));
    await Promise.all([older, newer]);
    await boundary.flush();

    expect(published.map(({ counts }) => counts.active)).toEqual([1, 2]);
    const replayHub = boundary.hub(scope);
    expect(replayHub.canReplay(replayHub.eventIdAt(1))).toBe(false);
    expect(replayHub.currentCheckpoint()?.event.snapshot.counts.active).toBe(2);
    subscription.close();
  });

  it("coalesces concurrent requests admitted before capture starts", async () => {
    const slowFirst = deferred<NormalizedApplicationSnapshot>();
    const capture = vi
      .fn<() => Promise<NormalizedApplicationSnapshot>>()
      .mockImplementationOnce(() => slowFirst.promise)
      .mockResolvedValueOnce(snapshot(2));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );

    boundary.hub(scope).subscribe(() => undefined);
    const first = boundary.publishAuthoritativeReplacement(scope);
    const second = boundary.publishAuthoritativeReplacement(scope);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);

    slowFirst.resolve(snapshot(1));
    await Promise.all([first, second]);
    await boundary.flush();
    expect(
      boundary.hub(scope).currentCheckpoint()?.event.snapshot.counts.active,
    ).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("publishes a thread upsert incrementally with the composed run state", async () => {
    const summaries = [durableSummary("thread-1", 6)];
    const boundary = new ApplicationSnapshotPublicationBoundary(
      incrementalSnapshots({
        summaries,
        runState: "running",
        terminalSummary: { runningCount: 1, retainedCount: 2 },
        active: 3,
      }),
      new ScopedApplicationEventHubs(),
    );
    const published: Extract<
      Parameters<
        Parameters<ReturnType<typeof boundary.hub>["subscribe"]>[0]
      >[0]["event"],
      { type: "thread_upsert" }
    >[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "thread_upsert") published.push(event);
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    summaries[0] = durableSummary("thread-1", 7);
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "thread_upsert",
      thread: {
        id: "thread-1",
        threadRevision: 7,
        runState: "running",
        terminalSummary: { runningCount: 1, retainedCount: 2 },
      },
      counts: { active: 3 },
    });
    subscription.close();
  });

  it("publishes a thread removal when the thread leaves the scoped projection", async () => {
    const summaries = [durableSummary("thread-1", 7)];
    const boundary = new ApplicationSnapshotPublicationBoundary(
      incrementalSnapshots({ summaries }),
      new ScopedApplicationEventHubs(),
    );
    const published: string[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      published.push(event.type);
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    summaries.length = 0;
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();

    expect(published).toEqual(["snapshot", "thread_remove"]);
    subscription.close();
  });

  it("suppresses a repeated identical thread change within one hub generation", async () => {
    const boundary = new ApplicationSnapshotPublicationBoundary(
      incrementalSnapshots({
        summaries: [durableSummary("thread-1", 7)],
        runState: "running",
      }),
      new ScopedApplicationEventHubs(),
    );
    const published: string[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      published.push(event.type);
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();

    expect(published).toEqual(["snapshot"]);
    subscription.close();
  });

  it("force-publishes an identical thread projection for terminal inventory invalidation", async () => {
    const boundary = new ApplicationSnapshotPublicationBoundary(
      incrementalSnapshots({
        summaries: [durableSummary("thread-1", 7)],
        runState: "running",
        terminalSummary: { runningCount: 1, retainedCount: 1 },
      }),
      new ScopedApplicationEventHubs(),
    );
    const published: NormalizedApplicationThreadSummary[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "thread_upsert") published.push(event.thread);
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();
    await boundary.publishThreadChange(scope, "thread-1", {
      forcePublication: true,
    });
    await boundary.flush();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ threadRevision: 7 });
    subscription.close();
  });

  it("republishes after a genuine summary change", async () => {
    const summaries = [durableSummary("thread-1", 7)];
    const snapshots = incrementalSnapshots({
      summaries,
      runState: "running",
    });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshots,
      new ScopedApplicationEventHubs(),
    );
    const published: number[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "thread_upsert") {
        published.push(event.thread.threadRevision);
      }
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();
    summaries[0] = durableSummary("thread-1", 8);
    await boundary.publishThreadChange(scope, "thread-1");
    await boundary.flush();

    expect(published).toEqual([8]);
    subscription.close();
  });

  it("refreshes only the moved thread's task associations", async () => {
    const threadId = "30000000-0000-4000-8000-000000000001";
    const summaries = [durableSummary(threadId, 7)];
    const tasks = [associatedThreadTask(threadId, TASK_WORKSPACE_ID)];
    const snapshots = incrementalSnapshots({ summaries, tasks });
    const boundary = new ApplicationSnapshotPublicationBoundary(
      snapshots,
      new ScopedApplicationEventHubs(),
    );
    const published: NormalizedApplicationSnapshot["tasks"][number][] = [];
    const replacements: NormalizedApplicationSnapshot[] = [];
    const subscription = boundary.hub(scope).subscribe(({ event }) => {
      if (event.type === "task_upsert") published.push(event.task);
      if (event.type === "snapshot") replacements.push(event.snapshot);
    });

    await boundary.checkpoint(scope, boundary.hub(scope));
    await boundary.publishThreadChange(scope, threadId);
    await boundary.flush();
    expect(snapshots.tasks.listAssociatedByThread).not.toHaveBeenCalled();

    summaries[0] = { ...summaries[0]!, threadRevision: 8 };
    await boundary.publishThreadChange(scope, threadId);
    await boundary.flush();
    expect(snapshots.tasks.listAssociatedByThread).not.toHaveBeenCalled();

    summaries[0] = {
      ...summaries[0]!,
      workspaceId: MOVED_TASK_WORKSPACE_ID,
      threadRevision: 9,
    };
    tasks[0] = associatedThreadTask(threadId, MOVED_TASK_WORKSPACE_ID);
    await boundary.publishThreadChange(scope, threadId);
    await boundary.flush();

    expect(snapshots.tasks.listAssociatedByThread).not.toHaveBeenCalled();
    expect(snapshots.capture).toHaveBeenCalledTimes(2);
    expect(
      published.map(({ associatedWorkspaceId }) => associatedWorkspaceId),
    ).toEqual([]);
    expect(replacements.at(-1)?.tasks[0]?.associatedWorkspaceId).toBe(
      MOVED_TASK_WORKSPACE_ID,
    );
    subscription.close();
  });
});

describe("Workpad application stream invalidations", () => {
  it("serializes document and draft changes with snapshots and isolates principals", async () => {
    const pending = deferred<NormalizedApplicationSnapshot>();
    const capture = vi.fn(async () => snapshot(0));
    const boundary = new ApplicationSnapshotPublicationBoundary(
      capturedService(capture),
      new ScopedApplicationEventHubs(),
    );
    const otherPrincipal = {
      ...scope,
      principalId: "10000000-0000-4000-8000-000000000003",
    };
    const otherTenant = {
      ...scope,
      tenantId: "10000000-0000-4000-8000-000000000004",
    };
    const workpadId = "20000000-0000-4000-8000-000000000006";
    const events: unknown[] = [];
    const principalEvents: unknown[] = [];
    const tenantEvents: unknown[] = [];
    const subscriptions = [
      boundary.hub(scope).subscribe(({ event }) => events.push(event)),
      boundary
        .hub(otherPrincipal)
        .subscribe(({ event }) => principalEvents.push(event)),
      boundary
        .hub(otherTenant)
        .subscribe(({ event }) => tenantEvents.push(event)),
    ];
    await Promise.all(
      [scope, otherPrincipal, otherTenant].map((requestedScope) =>
        boundary.checkpoint(requestedScope, boundary.hub(requestedScope)),
      ),
    );
    events.length = principalEvents.length = tenantEvents.length = 0;
    capture.mockImplementationOnce(() => pending.promise);
    const replacement = boundary.publishAuthoritativeReplacement(scope);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(4));
    const document = boundary.publishWorkpadChange(
      scope,
      workpadId,
      2,
      "document",
    );
    const draft = boundary.publishWorkpadChange(scope, workpadId, 1, "draft");
    await boundary.publishWorkpadChange(
      otherPrincipal,
      workpadId,
      2,
      "document",
    );
    await boundary.publishWorkpadChange(otherTenant, workpadId, 2, "document");
    expect(events).toEqual([]);
    expect(principalEvents).toEqual([
      expect.objectContaining({
        type: "workpad_changed",
        workpadId,
        revision: 2,
        change: "document",
      }),
    ]);
    expect(tenantEvents).toHaveLength(1);
    pending.resolve(snapshot(0));
    await Promise.all([replacement, document, draft]);
    await boundary.flush();
    expect(events).toEqual([
      expect.objectContaining({ type: "snapshot" }),
      expect.objectContaining({
        type: "workpad_changed",
        workpadId,
        revision: 2,
        change: "document",
      }),
      expect.objectContaining({
        type: "workpad_changed",
        workpadId,
        revision: 1,
        change: "draft",
      }),
    ]);
    await boundary.publishWorkpadChange(scope, workpadId, 3, "document");
    await boundary.publishWorkpadChange(scope, workpadId, 2, "draft");
    await boundary.flush();
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "workpad_changed",
        workpadId,
        revision: 3,
        change: "document",
      }),
      expect.objectContaining({
        type: "workpad_changed",
        workpadId,
        revision: 2,
        change: "draft",
      }),
    ]);
    await boundary.close();
    await expect(
      boundary.publishWorkpadChange(scope, workpadId, 3, "document"),
    ).rejects.toThrow("application_snapshot_publication_boundary_closed");
    subscriptions.forEach((subscription) => subscription.close());
  });
});
