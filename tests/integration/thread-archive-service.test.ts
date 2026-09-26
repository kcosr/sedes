import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { ArchivedThreadRuntimeRetirement } from "../../src/server/domain/thread-runtime-archive-retirement.js";
import {
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../../src/server/events/thread-runtime-coordinator.js";
import type { ThreadRunState } from "../../src/shared/protocol/conversation.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
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
      canonicalPath: "/tmp/archive-family",
      displayName: "Archive family",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const root = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Root" },
    200,
  );
  const child = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Child" },
    210,
  );
  const grandchild = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Grandchild" },
    220,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const bindings = new ConversationBindingRepository(database);
  for (const [threadId, now] of [
    [root.thread.id, 400],
    [child.thread.id, 410],
    [grandchild.thread.id, 420],
  ] as const) {
    bindings.bindDiscoveredConversation(scope, threadId, {
      backendConversationId: `session-${threadId}`,
      now,
    });
  }
  const lineage = new ThreadLineageRepository(database);
  lineage.recordImportedNativeOrigin(scope, {
    childThreadId: child.thread.id,
    providerParentBackendConversationId: `session-${root.thread.id}`,
    sourceThreadId: root.thread.id,
    sourceTurnState: "unresolved",
    branchMethod: "provider_native",
    now: 430,
  });
  lineage.recordImportedNativeOrigin(scope, {
    childThreadId: grandchild.thread.id,
    providerParentBackendConversationId: `session-${child.thread.id}`,
    sourceThreadId: child.thread.id,
    sourceTurnState: "unresolved",
    branchMethod: "provider_native",
    now: 440,
  });
  const inventory = new InventoryRepository(database);
  const runtimeStates = new Map<string, ThreadRunState>();
  const publishCommitted = vi.fn(async () => undefined);
  const questions = new QuestionRequestRepository(database, inventory);
  const tasks = new TaskRepository(database);
  const publishTaskChange = vi.fn(async () => undefined);
  const deleteExecutionWorkspace = vi.fn(
    async (
      _scope: typeof scope,
      _threadId: string,
      _input: {
        readonly expectedRevision: number;
        readonly operationId: string;
      },
    ) => undefined,
  );
  const runWithRuntimeRetired = vi.fn(
    async <Result>(
      _scope: typeof scope,
      _threadId: string,
      operation: () => Promise<Result>,
    ): Promise<Result> => operation(),
  );
  const releaseProviderResidency = vi.fn(async (_scope: typeof scope, _threadId: string): Promise<void> => undefined);
  const summaries = {
    listByIds: (requestedScope: typeof scope, threadIds: readonly string[]) =>
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
  };
  const service = new ThreadArchiveService({
    inventory,
    lineage,
    summaries,
    runtimes: {
      captureLoadedState: async (_scope, threadId) => {
        const runState = runtimeStates.get(threadId);
        return runState ? { runState } : undefined;
      },
      runWithRuntimeRetired:
        runWithRuntimeRetired as unknown as ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"],
      releaseProviderResidency,
    },
    publications: { publishCommitted },
    tasks,
    taskPublications: { publishTaskChange },
    executionWorkspaces: {
      status: async () => ({ kind: "direct" as const }),
      delete: deleteExecutionWorkspace,
    },
    now: () => 500,
  });
  const stashPrompt = (
    threadId: string,
    text: string,
    mutationId: string,
    now: number,
  ) => {
    const draft = inventory.getDraft(scope, threadId);
    const saved = inventory.saveDraft(scope, threadId, {
      text,
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: draft.revision,
      now,
    });
    return inventory.stashDraft(scope, threadId, {
      expectedDraftRevision: saved.revision,
      mutationId,
      maximumStashes: 50,
      now: now + 1,
    });
  };
  return {
    database,
    scope,
    bindings,
    rootId: root.thread.id,
    childId: child.thread.id,
    grandchildId: grandchild.thread.id,
    inventory,
    lineage,
    runtimeStates,
    publishCommitted,
    publishTaskChange,
    deleteExecutionWorkspace,
    runWithRuntimeRetired,
    releaseProviderResidency,
    tasks,
    questions,
    service,
    stashPrompt,
  };
}

describe("thread family archive service", () => {
  it("counts pending questions across the archive family and preserves them on restore", async () => {
    const current = fixture();
    try {
      for (const [id, count] of [
        [current.rootId, 1],
        [current.childId, 2],
      ] as const) {
        current.questions.admit(current.scope, id, `question-${id}`, {
          questions: Array.from({ length: count }, (_, index) => ({
            title: `Question ${index}`,
            options: null,
          })),
        }, 450);
      }
      expect(
        (await current.service.impact(current.scope, current.rootId)).pendingQuestions,
      ).toEqual({ root: 1, descendants: 2 });
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true,
        expectedRevision: 0,
        expectedStashedPromptCount: 0,
        mutationId: "archive-with-questions",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(
        current.questions.list(current.scope, current.rootId).requests[0]?.questions,
      ).toHaveLength(1);
      current.inventory.transitionInventory(current.scope, current.rootId, {
        expectedRevision: current.inventory.getInventory(
          current.scope, current.rootId,
        ).inventoryRevision,
        mutationId: "restore-with-questions",
        change: { action: "restore" },
        now: 600,
      });
      expect(
        (await current.service.impact(current.scope, current.rootId)).pendingQuestions,
      ).toEqual({ root: 1, descendants: 0 });
      expect(
        current.questions.list(current.scope, current.childId).requests[0]?.questions,
      ).toHaveLength(2);
    } finally {
      current.database.close();
    }
  });

  it("reports root and descendant stash counts for the authoritative archive set", async () => {
    const current = fixture();
    try {
      current.stashPrompt(
        current.rootId,
        "Root follow-up",
        "archive-impact-root-stash",
        450,
      );
      current.stashPrompt(
        current.childId,
        "Child follow-up one",
        "archive-impact-child-stash-one",
        452,
      );
      current.stashPrompt(
        current.childId,
        "Child follow-up two",
        "archive-impact-child-stash-two",
        454,
      );

      await expect(
        current.service.impact(current.scope, current.rootId),
      ).resolves.toMatchObject({
        descendantCount: 2,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 1, descendants: 2 },
      });
    } finally {
      current.database.close();
    }
  });

  it("rejects a stale settle stash count and preserves the confirmed stash", async () => {
    const current = fixture();
    try {
      current.stashPrompt(
        current.rootId,
        "Settle later",
        "settle-stale-stash",
        450,
      );

      await expect(
        current.service.settle(current.scope, current.rootId, {
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          mutationId: "settle-stale-stash-count",
        }),
      ).rejects.toThrow("Stashed prompts changed");
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });

      await current.service.settle(current.scope, current.rootId, {
        expectedRevision: 0,
        expectedStashedPromptCount: 1,
        mutationId: "settle-confirmed-stash-count",
      });
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "settled", inventoryRevision: 1 });
      expect(
        current.inventory.listStashes(current.scope, current.rootId),
      ).toHaveLength(1);
    } finally {
      current.database.close();
    }
  });

  it("rejects a stale family archive stash count atomically", async () => {
    const current = fixture();
    try {
      current.stashPrompt(
        current.rootId,
        "Root archive later",
        "archive-stale-root-stash",
        450,
      );
      current.stashPrompt(
        current.grandchildId,
        "Descendant archive later",
        "archive-stale-descendant-stash",
        452,
      );

      await expect(
        current.service.archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          expectedStashedPromptCount: 1,
          mutationId: "archive-stale-family-stash-count",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toThrow("Stashed prompts changed");
      for (const threadId of [
        current.rootId,
        current.childId,
        current.grandchildId,
      ]) {
        expect(
          current.inventory.getInventory(current.scope, threadId),
        ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      }

      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true,
        expectedRevision: 0,
        expectedStashedPromptCount: 2,
        mutationId: "archive-confirmed-family-stash-count",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(
        current.inventory.listStashes(current.scope, current.rootId),
      ).toHaveLength(1);
      expect(
        current.inventory.listStashes(current.scope, current.grandchildId),
      ).toHaveLength(1);
    } finally {
      current.database.close();
    }
  });

  it("settles and moves open thread tasks atomically with replay publication", async () => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Follow up after settling",
        scope: { kind: "thread", threadId: current.rootId },
        mutationId: "settle-task-create",
        now: 450,
      });
      const input = {
        expectedRevision: 0,
        mutationId: "settle-with-task-disposition",
        openTaskDisposition: "move_to_workspace",
      } as const;

      await current.service.settle(current.scope, current.rootId, input);
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: 1,
      });
      expect(current.tasks.get(current.scope, task.id)).toMatchObject({
        scopeKind: "workspace",
        threadId: null,
        revision: 1,
      });
      expect(current.publishTaskChange).toHaveBeenCalledWith(
        current.scope,
        task.id,
      );

      await current.service.settle(current.scope, current.rootId, input);
      expect(
        current.inventory.getInventory(current.scope, current.rootId)
          .inventoryRevision,
      ).toBe(1);
      expect(current.publishTaskChange).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("keeps isolated workspaces explicitly and executes only an exact delete disposition", async () => {
    const kept = fixture();
    try {
      expect(() =>
        kept.service.assertExecutionWorkspaceDeletionAllowed(
          kept.scope,
          kept.rootId,
        ),
      ).toThrow("Archive the thread");
      await kept.service.archive(kept.scope, kept.rootId, {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-keep-workspace",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(() =>
        kept.service.assertExecutionWorkspaceDeletionAllowed(
          kept.scope,
          kept.rootId,
        ),
      ).not.toThrow();
      expect(kept.deleteExecutionWorkspace).not.toHaveBeenCalled();
    } finally {
      kept.database.close();
    }

    const deleted = fixture();
    try {
      const disposition = {
        kind: "delete" as const,
        expectedRevision: 4,
        operationId: "20000000-0000-4000-8000-000000000010",
      };
      await deleted.service.archive(deleted.scope, deleted.rootId, {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-delete-workspace",
        executionWorkspaceDisposition: disposition,
      });
      expect(deleted.deleteExecutionWorkspace).toHaveBeenCalledWith(
        deleted.scope,
        deleted.rootId,
        disposition,
      );
      await expect(
        deleted.service.archive(deleted.scope, deleted.rootId, {
          includeDescendants: false,
          expectedRevision: 0,
          mutationId: "archive-delete-workspace",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toThrow("mutation ID was reused");
      expect(deleted.deleteExecutionWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      deleted.database.close();
    }
  });

  it("holds retirement through the archive commit and keeps workspace deletion outside the retirement fence", async () => {
    const current = fixture();
    try {
      const activeRetirements = new Set<string>();
      current.runWithRuntimeRetired.mockImplementation(
        async (_scope, threadId, operation) => {
          if (activeRetirements.has(threadId)) {
            throw new Error("nested_runtime_retirement");
          }
          activeRetirements.add(threadId);
          try {
            return await operation();
          } finally {
            activeRetirements.delete(threadId);
          }
        },
      );
      current.deleteExecutionWorkspace.mockImplementation(
        async (scope, threadId) => {
          expect(activeRetirements.size).toBe(0);
          await current.runWithRuntimeRetired(
            scope,
            threadId,
            async () => undefined,
          );
        },
      );

      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-retire-before-workspace-delete",
        executionWorkspaceDisposition: {
          kind: "delete",
          expectedRevision: 4,
          operationId: "20000000-0000-4000-8000-000000000030",
        },
      });

      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(2);
      expect(
        current.runWithRuntimeRetired.mock.invocationCallOrder[0],
      ).toBeLessThan(current.publishCommitted.mock.invocationCallOrder[0]!);
      expect(current.publishCommitted.mock.invocationCallOrder[0]).toBeLessThan(
        current.deleteExecutionWorkspace.mock.invocationCallOrder[0]!,
      );
    } finally {
      current.database.close();
    }
  });

  it("rejects a family archive before commit when a runtime becomes busy", async () => {
    const current = fixture();
    try {
      current.runWithRuntimeRetired.mockImplementation(
        async (_scope, threadId, operation) => {
          if (threadId === current.childId) {
            throw new ThreadRuntimeNotIdleError();
          }
          return operation();
        },
      );

      await expect(
        current.service.archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          mutationId: "archive-retire-family",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toMatchObject({ code: "invalid_transition", retryable: false });
      expect(current.publishCommitted).not.toHaveBeenCalled();
      for (const threadId of [
        current.rootId,
        current.childId,
        current.grandchildId,
      ]) {
        expect(
          current.inventory.getInventory(current.scope, threadId),
        ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      }
    } finally {
      current.database.close();
    }
  });

  it("releases every archived thread's provider residency inside its fence and refuses while provider work is outstanding", async () => {
    const current = fixture();
    try {
      const fenced = new Set<string>();
      current.runWithRuntimeRetired.mockImplementation(async (_scope, threadId, operation) => {
        fenced.add(threadId);
        try { return await operation(); } finally { fenced.delete(threadId); }
      });
      current.releaseProviderResidency.mockImplementation(async (_scope, threadId) => {
        expect(fenced.has(threadId)).toBe(true);
        // A remote query with running background work cannot be retired.
        if (threadId === current.grandchildId) throw new ThreadRuntimeNotIdleError();
      });
      await expect(
        current.service.archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          mutationId: "archive-remote-busy",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.inventory.getInventory(current.scope, current.rootId)).toMatchObject({ inventoryState: "active" });
      current.releaseProviderResidency.mockResolvedValue(undefined);
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true,
        expectedRevision: 0,
        mutationId: "archive-remote-released",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(new Set(current.releaseProviderResidency.mock.calls.map(([, threadId]) => threadId)))
        .toEqual(new Set([current.rootId, current.childId, current.grandchildId]));
      expect(current.inventory.getInventory(current.scope, current.rootId)).toMatchObject({ inventoryState: "archived" });
    } finally {
      current.database.close();
    }
  });

  it("blocks a family archive when any runtime retirement is unproven", async () => {
    const current = fixture();
    try {
      const orderedThreadIds = [
        current.rootId,
        current.childId,
        current.grandchildId,
      ].sort();
      const failedThreadId = orderedThreadIds[1]!;
      current.runWithRuntimeRetired.mockImplementation(
        async (_scope, threadId, operation) => {
          if (threadId === failedThreadId) {
            throw new ThreadRuntimeRetirementUnprovenError(
              new Error(`unproven-${threadId}`),
            );
          }
          return operation();
        },
      );

      const failure = await current.service
        .archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          mutationId: "archive-unproven-family",
          executionWorkspaceDisposition: { kind: "keep" },
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "operation_outcome_uncertain",
        retryable: false,
        cause: expect.any(ThreadRuntimeRetirementUnprovenError),
      });
      expect(
        current.runWithRuntimeRetired.mock.calls.map(
          ([, threadId]) => threadId,
        ),
      ).toEqual(orderedThreadIds.slice(0, 2));
      expect(current.publishCommitted).not.toHaveBeenCalled();
      for (const threadId of [
        current.rootId,
        current.childId,
        current.grandchildId,
      ]) {
        expect(
          current.inventory.getInventory(current.scope, threadId),
        ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      }
    } finally {
      current.database.close();
    }
  });

  it("retries retirement on post-commit publication replay and ignores a restored replay target", async () => {
    const current = fixture();
    try {
      current.publishCommitted.mockRejectedValueOnce(
        new Error("first-publication-failed"),
      );
      const input = {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-runtime-replay",
        executionWorkspaceDisposition: { kind: "keep" as const },
      };

      await expect(
        current.service.archive(current.scope, current.rootId, input),
      ).rejects.toThrow("first-publication-failed");
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });

      await expect(
        current.service.archive(current.scope, current.rootId, input),
      ).resolves.toEqual([current.rootId]);
      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(2);
      expect(current.publishCommitted).toHaveBeenCalledTimes(2);
      expect(
        current.inventory.getInventory(current.scope, current.rootId)
          .inventoryRevision,
      ).toBe(1);

      current.inventory.transitionInventory(current.scope, current.rootId, {
        expectedRevision: 1,
        mutationId: "restore-after-archive-runtime-replay",
        change: { action: "restore" },
        now: 510,
      });
      await expect(
        current.service.archive(current.scope, current.rootId, input),
      ).resolves.toEqual([current.rootId]);
      expect(current.runWithRuntimeRetired).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("replays archive deletion after the external filesystem effect fails", async () => {
    const current = fixture();
    try {
      current.deleteExecutionWorkspace
        .mockRejectedValueOnce(
          new DomainError(
            "operation_outcome_uncertain",
            "The isolated workspace deletion can be retried.",
            true,
          ),
        )
        .mockResolvedValueOnce(undefined);
      const input = {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-delete-replay",
        executionWorkspaceDisposition: {
          kind: "delete" as const,
          expectedRevision: 2,
          operationId: "20000000-0000-4000-8000-000000000023",
        },
      };
      await expect(
        current.service.archive(current.scope, current.rootId, input),
      ).rejects.toMatchObject({
        code: "operation_outcome_uncertain",
        retryable: true,
      });
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });

      await expect(
        current.service.archive(current.scope, current.rootId, input),
      ).resolves.toEqual([current.rootId]);
      expect(current.deleteExecutionWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  async function expectDescendantReservationBlocks(
    current: ReturnType<typeof fixture>,
    mutationId: string,
  ): Promise<void> {
    await expect(
      current.service.impact(current.scope, current.rootId),
    ).resolves.toEqual({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: {
        available: false,
        unavailableReason: "A descendant is active and cannot be archived.",
      },
    });
    await expect(
      current.service.archive(current.scope, current.rootId, {
        includeDescendants: true,
        expectedRevision: 0,
        mutationId,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    ).rejects.toThrow("cannot be archived while one of its threads is active");
    for (const threadId of [
      current.rootId,
      current.childId,
      current.grandchildId,
    ]) {
      expect(
        current.inventory.getInventory(current.scope, threadId),
      ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
    }
    expect(current.publishCommitted).not.toHaveBeenCalled();
  }

  it("reports a running descendant and atomically rejects archive-all", async () => {
    const current = fixture();
    try {
      current.runtimeStates.set(current.childId, "running");
      await expect(
        current.service.impact(current.scope, current.rootId),
      ).resolves.toEqual({
        descendantCount: 2,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: {
          root: { items: [], total: 0, omitted: 0 },
          descendants: { items: [], total: 0, omitted: 0 },
        },
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: {
          available: false,
          unavailableReason: "A descendant is running and cannot be archived.",
        },
      });
      await expect(
        current.service.archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          mutationId: "archive-running-family",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toThrow(
        "cannot be archived while one of its threads is active",
      );
      for (const threadId of [
        current.rootId,
        current.childId,
        current.grandchildId,
      ]) {
        expect(
          current.inventory.getInventory(current.scope, threadId)
            .inventoryState,
        ).toBe("active");
      }
      expect(current.publishCommitted).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("archives the complete deep family once and replays the same mutation", async () => {
    const current = fixture();
    try {
      const input = {
        includeDescendants: true,
        expectedRevision: 0,
        mutationId: "archive-complete-family",
        executionWorkspaceDisposition: { kind: "keep" },
      } as const;
      await current.service.archive(current.scope, current.rootId, input);
      for (const threadId of [
        current.rootId,
        current.childId,
        current.grandchildId,
      ]) {
        expect(
          current.inventory.getInventory(current.scope, threadId),
        ).toMatchObject({
          inventoryState: "archived",
          inventoryRevision: 1,
        });
      }
      current.runtimeStates.set(current.rootId, "running");
      await current.service.archive(current.scope, current.rootId, input);
      expect(current.publishCommitted).toHaveBeenCalledTimes(2);
      expect(current.publishCommitted).toHaveBeenLastCalledWith(
        current.scope,
        expect.arrayContaining([
          expect.objectContaining({ threadId: current.rootId }),
          expect.objectContaining({ threadId: current.childId }),
          expect.objectContaining({ threadId: current.grandchildId }),
        ]),
        500,
      );
      expect(
        current.inventory.getInventory(current.scope, current.rootId)
          .inventoryRevision,
      ).toBe(1);
    } finally {
      current.database.close();
    }
  });

  it("reports distinct root and descendant open-task summaries with ownership", async () => {
    const current = fixture();
    try {
      const rootTask = current.tasks.create(current.scope, {
        title: "Duplicate warning title",
        scope: { kind: "thread", threadId: current.rootId },
        mutationId: "archive-impact-root-task",
        now: 450,
      });
      const childTask = current.tasks.create(current.scope, {
        title: "Duplicate warning title",
        scope: { kind: "thread", threadId: current.childId },
        mutationId: "archive-impact-child-task",
        now: 451,
      });
      const completed = current.tasks.create(current.scope, {
        title: "Completed warning title",
        scope: { kind: "thread", threadId: current.grandchildId },
        mutationId: "archive-impact-completed-task",
        now: 452,
      });
      current.tasks.update(current.scope, completed.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "archive-impact-complete-task",
        now: 453,
      });

      await expect(
        current.service.impact(current.scope, current.rootId),
      ).resolves.toMatchObject({
        openTasks: {
          root: {
            items: [
              {
                id: rootTask.id,
                title: "Duplicate warning title",
                threadId: current.rootId,
              },
            ],
            total: 1,
            omitted: 0,
          },
          descendants: {
            items: [
              {
                id: childTask.id,
                title: "Duplicate warning title",
                threadId: current.childId,
              },
            ],
            total: 1,
            omitted: 0,
          },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("bounds root task summaries with truthful omission accounting", async () => {
    const current = fixture();
    try {
      for (let index = 0; index < 101; index += 1) {
        current.tasks.create(current.scope, {
          title: `Root archive task ${index}`,
          scope: { kind: "thread", threadId: current.rootId },
          mutationId: `archive-impact-bound-${index}`,
          now: 450 + index,
        });
      }

      const impact = await current.service.impact(
        current.scope,
        current.rootId,
      );
      expect(impact.openTasks.root).toMatchObject({ total: 101, omitted: 1 });
      expect(impact.openTasks.root.items).toHaveLength(100);
      expect(impact.openTasks.descendants).toEqual({
        items: [],
        total: 0,
        omitted: 0,
      });
    } finally {
      current.database.close();
    }
  });

  it("reports only descendants that are not already archived", async () => {
    const current = fixture();
    try {
      current.tasks.create(current.scope, {
        title: "Task retained on an archived descendant",
        scope: { kind: "thread", threadId: current.childId },
        mutationId: "archived-descendant-task",
        now: 450,
      });
      await current.service.archive(current.scope, current.childId, {
        includeDescendants: false,
        expectedRevision: 0,
        mutationId: "archive-child-only",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      current.runtimeStates.set(current.childId, "running");

      await expect(
        current.service.impact(current.scope, current.rootId),
      ).resolves.toMatchObject({
        descendantCount: 1,
        openTasks: {
          descendants: { items: [], total: 0, omitted: 0 },
        },
        archiveAll: { available: true },
      });

      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true,
        expectedRevision: 0,
        mutationId: "archive-mixed-family",
        executionWorkspaceDisposition: { kind: "keep" },
      });

      expect(
        current.inventory.getInventory(current.scope, current.childId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });
      expect(
        current.inventory.getInventory(current.scope, current.grandchildId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });

      await expect(
        current.service.impact(current.scope, current.rootId),
      ).resolves.toEqual({
        descendantCount: 0,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: {
          root: { items: [], total: 0, omitted: 0 },
          descendants: { items: [], total: 0, omitted: 0 },
        },
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      });
    } finally {
      current.database.close();
    }
  });

  it("does not disclose a family across principals", async () => {
    const current = fixture();
    try {
      await expect(
        current.service.impact(
          {
            tenantId: current.scope.tenantId,
            principalId: "different-principal",
          },
          current.rootId,
        ),
      ).rejects.toThrow("thread was not found");
    } finally {
      current.database.close();
    }
  });

  it("disables and rejects archive-all for a prepared descendant fork origin", async () => {
    const current = fixture();
    try {
      const source = current.bindings.findThreadDefinition(
        current.scope,
        current.childId,
      )!;
      const checkpoint = new BackendCheckpointRepository(
        current.database,
      ).create(current.scope, current.childId, {
        id: "archive-prepared-fork-checkpoint",
        applicationTurnId: "archive-prepared-fork-turn",
        opaqueReference: "archive-prepared-fork-reference",
        now: 450,
      });
      const preparedChild = current.bindings.createUnboundThread(
        current.scope,
        {
          workspaceId: source.workspaceId,
          connectionProfileId: source.connectionProfileId,
          title: "Prepared descendant",
          now: 451,
        },
      );
      current.lineage.prepareOrigin(current.scope, {
        childThreadId: preparedChild.id,
        sourceThreadId: current.childId,
        sourceTurnId: "archive-prepared-fork-turn",
        sourceTurnCompletedAt: 449,
        sourceTurnRevision: 1,
        sourceCheckpointId: checkpoint.id,
        originKind: "user_fork",
        initiatingPrincipalId: current.scope.principalId,
        branchMethod: "provider_native",
        creationOperationId: "archive-prepared-fork-operation",
        now: 452,
      });

      await expectDescendantReservationBlocks(
        current,
        "archive-with-prepared-fork",
      );
    } finally {
      current.database.close();
    }
  });

  it("disables and rejects archive-all for active descendant automation", async () => {
    const current = fixture();
    try {
      const automations = new AutomationRepository(current.database);
      automations.createDefinition(current.scope, {
        id: "archive-descendant-automation",
        anchorThreadId: current.childId,
        name: "Archive blocker",
        prompt: "Keep the descendant active",
        precheck: null,
        runMode: "same_thread",
        enabled: true,
        schedule: { kind: "date_time", runAt: 10_000 },
        misfirePolicy: "coalesce",
        nextRunAt: 10_000,
        now: 450,
      });
      automations.createManualRun(
        current.scope,
        "archive-descendant-automation",
        {
          runId: "archive-descendant-automation-run",
          occurrenceKey: "archive-descendant-automation-occurrence",
          scheduledFor: 451,
          claimToken: "archive-descendant-automation-claim",
          leaseExpiresAt: 10_000,
          dispatchMutationId: "archive-descendant-automation-dispatch",
          now: 451,
        },
      );

      await expectDescendantReservationBlocks(
        current,
        "archive-with-active-automation",
      );
    } finally {
      current.database.close();
    }
  });

  it("disables and rejects archive-all for a prepared descendant provider feature", async () => {
    const current = fixture();
    try {
      new ProviderFeatureMutationRepository(current.database).prepare(
        current.scope,
        {
          applicationThreadId: current.grandchildId,
          mutationId: "archive-descendant-provider-feature",
          featureId: "execution-settings",
          schemaVersion: 1,
          actionId: "set-model",
          requestFingerprint: "a".repeat(64),
          expectedThreadRevision: 0,
          expectedFeatureRevision: 0,
          desiredPostcondition: { model: "test-model" },
          now: 450,
        },
      );

      await expectDescendantReservationBlocks(
        current,
        "archive-with-prepared-provider-feature",
      );
    } finally {
      current.database.close();
    }
  });
});
