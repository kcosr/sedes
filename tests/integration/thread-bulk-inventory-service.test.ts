import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadBulkInventoryService } from "../../src/server/domain/thread-bulk-inventory-service.js";
import type { ArchivedThreadRuntimeRetirement } from "../../src/server/domain/thread-runtime-archive-retirement.js";
import { ThreadRuntimeRetirementUnprovenError } from "../../src/server/events/thread-runtime-coordinator.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import type { ThreadRunState } from "../../src/shared/protocol/conversation.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture() {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/bulk-stack",
      displayName: "Bulk stack",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const otherWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/bulk-stack-other",
      displayName: "Other stack project",
      availability: "available",
      trustState: "trusted",
    },
    101,
  );
  const threads = ["First", "Second", "Third"].map((title, index) =>
    legacy.createThread(
      scope,
      { workspaceId: workspace.id, title },
      200 + index,
    ),
  );
  threads.push(
    legacy.createThread(
      scope,
      { workspaceId: otherWorkspace.id, title: "Fourth" },
      204,
    ),
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const bindings = new ConversationBindingRepository(database);
  for (const [index, thread] of threads.entries()) {
    bindings.bindDiscoveredConversation(scope, thread.thread.id, {
      backendConversationId: `session-${thread.thread.id}`,
      now: 400 + index,
    });
  }
  const inventory = new InventoryRepository(database);
  const questions = new QuestionRequestRepository(database, inventory);
  const tasks = new TaskRepository(database);
  const runtimeStates = new Map<string, ThreadRunState>();
  const publishCommitted = vi.fn(async () => undefined);
  const publishTaskChange = vi.fn(async () => undefined);
  const runWithRuntimeRetired = vi.fn(
    async <Result>(
      _scope: typeof scope,
      _threadId: string,
      operation: () => Promise<Result>,
    ): Promise<Result> => operation(),
  );
  const listSummariesByIds = vi.fn(
    (requestedScope: typeof scope, threadIds: readonly string[]) =>
      threadIds.map((threadId) => {
        const aggregate = inventory.getThread(requestedScope, threadId);
        return {
          id: threadId,
          workspaceId: aggregate.thread.workspaceId,
          targetId: aggregate.thread.connectionProfileId,
          title: { text: aggregate.thread.title },
          backend: { label: { text: "Pi" }, brand: "pi" as const },
          backingState: aggregate.thread.backingState,
          inventoryState: aggregate.inventory.inventoryState,
          inventoryRevision: aggregate.inventory.inventoryRevision,
          preferredWorktree: null,
          preferredWorktreeRevision: 0,
          pinned: false,
          pinRevision: 0,
          bookmarkRevision: aggregate.inventory.bookmarkRevision,
          turnBookmarkCount: 0,
          groupId: null,
          groupAssignmentRevision: 0,
          threadRevision: aggregate.thread.revision,
          queuedInputCount: 0,
          pendingQuestionCount: questions
            .list(requestedScope, threadId)
            .requests.reduce((total, request) => total + request.questions.length, 0),
          stashedPromptCount: inventory.listStashes(requestedScope, threadId)
            .length,
          available: aggregate.thread.availability === "available",
          lastActivityAt: new Date(
            aggregate.thread.lastActivityAt,
          ).toISOString(),
          stateChangedAt: new Date(
            aggregate.inventory.stateChangedAt,
          ).toISOString(),
          automation: null,
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        };
      }),
  );
  const summaries = {
    listByIds: listSummariesByIds,
  };
  const service = new ThreadBulkInventoryService({
    inventory,
    summaries,
    runtimes: {
      captureLoadedState: async (_requestedScope, threadId) => {
        const runState = runtimeStates.get(threadId);
        return runState ? { runState } : undefined;
      },
      runWithRuntimeRetired:
        runWithRuntimeRetired as unknown as ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"],
    },
    publications: { publishCommitted },
    tasks,
    taskPublications: { publishTaskChange },
    now: () => 500,
  });
  return {
    database,
    scope,
    ids: threads.map(({ thread }) => thread.id),
    inventory,
    tasks,
    runtimeStates,
    publishCommitted,
    publishTaskChange,
    runWithRuntimeRetired,
    listSummariesByIds,
    questions,
    service,
    workspaceIds: [workspace.id, otherWorkspace.id] as const,
  };
}

describe("thread bulk inventory service", () => {
  it("counts pending questions only in affected archive targets", async () => {
    const current = fixture();
    try {
      const [first, second, third] = current.ids as [string, string, string];
      for (const id of [first, third]) {
        current.questions.admit(current.scope, id, `question-${id}`, {
          questions: [{ title: "Next step?", options: null }],
        }, 450);
      }
      const impact = await current.service.impact(current.scope, {
        action: "archive", threadIds: [first, second],
      });
      expect(impact.pendingQuestionCount).toBe(1);
    } finally {
      current.database.close();
    }
  });

  it("reports ordered mixed-state impact and atomically settles affected members with task replay", async () => {
    const current = fixture();
    try {
      const [first, second, third] = current.ids as [string, string, string];
      current.inventory.transitionInventory(current.scope, second, {
        expectedRevision: 0,
        mutationId: "pre-settle-second",
        change: { action: "settle" },
        now: 450,
      });
      const task = current.tasks.create(current.scope, {
        title: "Move with settled stack",
        scope: { kind: "thread", threadId: first },
        mutationId: "bulk-task-create",
        now: 451,
      });
      const impact = await current.service.impact(current.scope, {
        action: "settle",
        threadIds: [third, second, first],
      });
      expect(impact).toMatchObject({
        action: "settle",
        targetCount: 3,
        affectedCount: 2,
        unchangedCount: 1,
        available: true,
        stashedPromptCount: 0,
        openTasks: { total: 1 },
      });
      expect(impact.targets.map(({ threadId }) => threadId)).toEqual([
        third,
        second,
        first,
      ]);
      expect(current.listSummariesByIds).toHaveBeenCalledTimes(1);
      const request = {
        action: "settle" as const,
        targets: impact.targets,
        mutationId: "bulk-settle-mutation",
        expectedStashedPromptCount: 0,
        expectedOpenTaskCount: 1,
        openTaskDisposition: "move_to_workspace" as const,
      };
      await expect(
        current.service.transition(current.scope, request),
      ).resolves.toEqual({
        changedThreadIds: [third, first],
      });
      expect(
        current.inventory.getInventory(current.scope, second),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: 1,
      });
      expect(current.tasks.get(current.scope, task.id)).toMatchObject({
        scopeKind: "workspace",
        revision: 1,
      });
      await expect(
        current.service.transition(current.scope, {
          ...request,
          targets: [...request.targets].reverse(),
        }),
      ).resolves.toEqual({
        changedThreadIds: [third, first],
      });
      expect(current.publishCommitted).toHaveBeenCalledTimes(2);
      expect(current.publishTaskChange).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("blocks the complete settle and fences revisions for unchanged targets", async () => {
    const current = fixture();
    try {
      const [first, second, third] = current.ids as [string, string, string];
      current.inventory.transitionInventory(current.scope, second, {
        expectedRevision: 0,
        mutationId: "pre-settle-unchanged",
        change: { action: "settle" },
        now: 450,
      });
      current.runtimeStates.set(third, "running");
      const impact = await current.service.impact(current.scope, {
        action: "settle",
        threadIds: [first, second, third],
      });
      expect(impact).toMatchObject({
        available: false,
        blockers: { total: 1, items: [{ threadId: third, reason: "running" }] },
      });
      await expect(
        current.service.transition(current.scope, {
          action: "settle",
          targets: impact.targets,
          mutationId: "bulk-settle-blocked",
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
        }),
      ).rejects.toThrow("active or unresolved work");
      expect(
        current.inventory.getInventory(current.scope, first).inventoryState,
      ).toBe("active");
      expect(
        current.inventory.getInventory(current.scope, third).inventoryState,
      ).toBe("active");

      current.runtimeStates.delete(third);
      current.inventory.transitionInventory(current.scope, second, {
        expectedRevision: 1,
        mutationId: "unsettle-noop-fence",
        change: { action: "unsettle" },
        now: 460,
      });
      await expect(
        current.service.transition(current.scope, {
          action: "settle",
          targets: impact.targets,
          mutationId: "bulk-settle-stale-noop",
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
        }),
      ).rejects.toThrow("changed in another client");
      expect(
        current.inventory.getInventory(current.scope, first).inventoryState,
      ).toBe("active");
    } finally {
      current.database.close();
    }
  });

  it("archives exactly the ordered frozen targets and denies another principal scope", async () => {
    const current = fixture();
    try {
      const [first, second] = current.ids as [string, string, string];
      const impact = await current.service.impact(current.scope, {
        action: "archive",
        threadIds: [second, first],
      });
      await expect(
        current.service.transition(current.scope, {
          action: "archive",
          targets: impact.targets,
          mutationId: "bulk-archive-two",
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
        }),
      ).resolves.toEqual({ changedThreadIds: [second, first] });
      expect(
        current.inventory.getInventory(current.scope, first).inventoryState,
      ).toBe("archived");
      expect(
        current.inventory.getInventory(current.scope, second).inventoryState,
      ).toBe("archived");
      expect(
        current.runWithRuntimeRetired.mock.calls.map(
          ([, threadId]) => threadId,
        ),
      ).toEqual([first, second].sort());
      expect(
        current.runWithRuntimeRetired.mock.invocationCallOrder[0],
      ).toBeLessThan(current.publishCommitted.mock.invocationCallOrder[0]!);
      expect(() =>
        current.inventory.getInventory(
          { tenantId: current.scope.tenantId, principalId: "other-principal" },
          current.ids[2]!,
        ),
      ).toThrow("not found");
    } finally {
      current.database.close();
    }
  });

  it("blocks bulk archive commit on unproven retirement and converges on receipt replay", async () => {
    const current = fixture();
    try {
      const [first, second] = current.ids as [string, string, string];
      const impact = await current.service.impact(current.scope, {
        action: "archive",
        threadIds: [second, first],
      });
      const request = {
        action: "archive" as const,
        targets: impact.targets,
        mutationId: "bulk-archive-runtime-replay",
        expectedStashedPromptCount: 0,
        expectedOpenTaskCount: 0,
      };
      current.runWithRuntimeRetired.mockImplementation(
        async (_scope, threadId) => {
          throw new ThreadRuntimeRetirementUnprovenError(
            new Error(`unproven-${threadId}`),
          );
        },
      );

      const failure = await current.service
        .transition(current.scope, request)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "operation_outcome_uncertain",
        retryable: false,
        cause: expect.any(ThreadRuntimeRetirementUnprovenError),
      });
      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(1);
      expect(
        [second, first].map(
          (threadId) =>
            current.inventory.getInventory(current.scope, threadId)
              .inventoryState,
        ),
      ).toEqual(["active", "active"]);
      expect(current.publishCommitted).not.toHaveBeenCalled();

      current.runWithRuntimeRetired.mockImplementation(
        async (_scope, _threadId, operation) => operation(),
      );
      await expect(
        current.service.transition(current.scope, request),
      ).resolves.toEqual({ changedThreadIds: [second, first] });
      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(3);
      expect(current.publishCommitted).toHaveBeenCalledTimes(1);

      current.inventory.transitionInventory(current.scope, first, {
        expectedRevision: 1,
        mutationId: "restore-after-bulk-archive-runtime-replay",
        change: { action: "restore" },
        now: 510,
      });
      await current.service.transition(current.scope, request);
      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(4);
      expect(current.runWithRuntimeRetired.mock.calls.at(-1)?.[1]).toBe(second);
    } finally {
      current.database.close();
    }
  });

  it("unsettles only settled members and reports an all-satisfied stack as unavailable", async () => {
    const current = fixture();
    try {
      const [first, second, third] = current.ids as [string, string, string];
      for (const [index, threadId] of [first, third].entries()) {
        current.inventory.transitionInventory(current.scope, threadId, {
          expectedRevision: 0,
          mutationId: `prepare-unsettle-${index}`,
          change: { action: "settle" },
          now: 450 + index,
        });
      }
      const impact = await current.service.impact(current.scope, {
        action: "unsettle",
        threadIds: [third, second, first],
      });
      expect(impact).toMatchObject({
        affectedCount: 2,
        unchangedCount: 1,
        available: true,
      });
      await expect(
        current.service.transition(current.scope, {
          action: "unsettle",
          targets: impact.targets,
          mutationId: "bulk-unsettle-mixed",
        }),
      ).resolves.toEqual({ changedThreadIds: [third, first] });
      expect(
        current.inventory.getInventory(current.scope, second),
      ).toMatchObject({
        inventoryState: "active",
        inventoryRevision: 0,
      });

      const satisfied = await current.service.impact(current.scope, {
        action: "unsettle",
        threadIds: [third, second, first],
      });
      expect(satisfied).toMatchObject({
        affectedCount: 0,
        unchangedCount: 3,
        available: false,
        blockers: { total: 0 },
      });
      const generationBefore = current.database
        .prepare(
          "SELECT inventory_generation AS generation FROM principal_generations WHERE tenant_id = ? AND principal_id = ?",
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        generation: number;
      };
      await expect(
        current.service.transition(current.scope, {
          action: "unsettle",
          targets: satisfied.targets,
          mutationId: "bulk-unsettle-zero-effect",
        }),
      ).rejects.toThrow("already has the requested inventory state");
      const generationAfter = current.database
        .prepare(
          "SELECT inventory_generation AS generation FROM principal_generations WHERE tenant_id = ? AND principal_id = ?",
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        generation: number;
      };
      expect(generationAfter.generation).toBe(generationBefore.generation);
    } finally {
      current.database.close();
    }
  });

  it("rolls back every inventory and task change when confirmed stash or task counts become stale", async () => {
    const current = fixture();
    try {
      const [first, second] = current.ids as [string, string, string];
      const impact = await current.service.impact(current.scope, {
        action: "settle",
        threadIds: [first, second],
      });
      const draft = current.inventory.getDraft(current.scope, first);
      const saved = current.inventory.saveDraft(current.scope, first, {
        text: "new stash after confirmation",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: draft.revision,
        now: 451,
      });
      current.inventory.stashDraft(current.scope, first, {
        expectedDraftRevision: saved.revision,
        mutationId: "bulk-stale-stash-create",
        maximumStashes: 50,
        now: 452,
      });
      await expect(
        current.service.transition(current.scope, {
          action: "settle",
          targets: impact.targets,
          mutationId: "bulk-stale-stash",
          expectedStashedPromptCount: impact.stashedPromptCount,
          expectedOpenTaskCount: impact.openTasks.total,
        }),
      ).rejects.toThrow("Stashed prompts changed");
      expect(
        [first, second].map(
          (threadId) =>
            current.inventory.getInventory(current.scope, threadId)
              .inventoryState,
        ),
      ).toEqual(["active", "active"]);

      const refreshed = await current.service.impact(current.scope, {
        action: "settle",
        threadIds: [first, second],
      });
      const task = current.tasks.create(current.scope, {
        title: "Added after confirmation",
        scope: { kind: "thread", threadId: second },
        mutationId: "bulk-stale-task-create",
        now: 453,
      });
      await expect(
        current.service.transition(current.scope, {
          action: "settle",
          targets: refreshed.targets,
          mutationId: "bulk-stale-task",
          expectedStashedPromptCount: refreshed.stashedPromptCount,
          expectedOpenTaskCount: refreshed.openTasks.total,
          openTaskDisposition: "move_to_workspace",
        }),
      ).rejects.toThrow("Open tasks changed");
      expect(current.tasks.get(current.scope, task.id)).toMatchObject({
        scopeKind: "thread",
        threadId: second,
        revision: 0,
      });
      expect(
        [first, second].map(
          (threadId) =>
            current.inventory.getInventory(current.scope, threadId)
              .inventoryState,
        ),
      ).toEqual(["active", "active"]);
    } finally {
      current.database.close();
    }
  });

  it("rechecks durable work inside the transaction and changes no stack member", () => {
    const current = fixture();
    try {
      const [first, second] = current.ids as [string, string, string];
      const queue = new QueuedInputRepository(current.database);
      const initial = current.inventory.getThread(current.scope, second);
      current.inventory.saveDraft(current.scope, second, {
        text: "queued work",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: initial.draft.revision,
        now: 450,
      });
      const aggregate = current.inventory.getThread(current.scope, second);
      queue.enqueue(current.scope, second, {
        id: "bulk-durable-queue",
        mutationId: "bulk-durable-queue-operation",
        text: aggregate.draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: aggregate.thread.revision,
          expectedDraftRevision: aggregate.draft.revision,
        },
        now: 451,
      });
      expect(() =>
        current.inventory.bulkInventoryTransition(current.scope, {
          action: "settle",
          targets: [first, second].map((threadId) => ({
            threadId,
            expectedRevision: 0,
          })),
          mutationId: "bulk-durable-barrier",
          blockedThreadIds: new Set(),
          now: 452,
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
          countOpenTasks: () => 0,
        }),
      ).toThrow("active or unresolved work");
      expect(
        [first, second].map(
          (threadId) =>
            current.inventory.getInventory(current.scope, threadId)
              .inventoryState,
        ),
      ).toEqual(["active", "active"]);
    } finally {
      current.database.close();
    }
  });

  it("moves affected tasks to each thread's own workspace in one commit", async () => {
    const current = fixture();
    try {
      const [first, , , fourth] = current.ids as [
        string,
        string,
        string,
        string,
      ];
      const tasks = [first, fourth].map((threadId, index) =>
        current.tasks.create(current.scope, {
          title: `Cross-project task ${index}`,
          scope: { kind: "thread", threadId },
          mutationId: `cross-project-task-${index}`,
          now: 450 + index,
        }),
      );
      const impact = await current.service.impact(current.scope, {
        action: "settle",
        threadIds: [fourth, first],
      });
      await current.service.transition(current.scope, {
        action: "settle",
        targets: impact.targets,
        mutationId: "bulk-cross-project-settle",
        expectedStashedPromptCount: 0,
        expectedOpenTaskCount: 2,
        openTaskDisposition: "move_to_workspace",
      });
      expect(current.tasks.get(current.scope, tasks[0]!.id).workspaceId).toBe(
        current.workspaceIds[0],
      );
      expect(current.tasks.get(current.scope, tasks[1]!.id).workspaceId).toBe(
        current.workspaceIds[1],
      );
    } finally {
      current.database.close();
    }
  });
});
