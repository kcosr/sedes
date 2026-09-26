import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadForceResetRepository } from "../../src/server/db/repositories/thread-force-reset-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
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

type Fixture = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly rootId: string;
  readonly childId: string;
  readonly grandchildId: string;
  readonly workspaceId: string;
};

function fixture(): Fixture {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/thread-force-reset",
      displayName: "Thread force reset",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const create = (title: string, now: number) =>
    legacy.createThread(scope, { workspaceId: workspace.id, title }, now).thread
      .id;
  const rootId = create("Root", 200);
  const childId = create("Child", 210);
  const grandchildId = create("Grandchild", 220);
  legacy.saveDraft(
    scope,
    rootId,
    { text: "queued after reset audit", expectedRevision: 0 },
    230,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  return {
    database,
    scope,
    rootId,
    childId,
    grandchildId,
    workspaceId: workspace.id,
  };
}

function revision(current: Fixture, threadId: string): number {
  return (
    current.database
      .prepare(
        `SELECT revision FROM application_threads
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(current.scope.tenantId, current.scope.principalId, threadId) as {
      readonly revision: number;
    }
  ).revision;
}

function bind(
  current: Fixture,
  threadId: string,
  nativeId = `session-${threadId}`,
): void {
  new ConversationBindingRepository(
    current.database,
  ).bindDiscoveredConversation(current.scope, threadId, {
    backendConversationId: nativeId,
    now: 400,
  });
}

function registerCompletionCallback(
  current: Fixture,
  input: {
    readonly id: string;
    readonly callerThreadId: string;
    readonly targetThreadId: string;
    readonly targetOperationId: string;
  },
): void {
  current.database
    .prepare(
      `INSERT INTO thread_completion_callbacks(
         tenant_id, owner_principal_id, id, caller_thread_id,
         target_thread_id, target_operation_id, state, registered_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?)`,
    )
    .run(
      current.scope.tenantId,
      current.scope.principalId,
      input.id,
      input.callerThreadId,
      input.targetThreadId,
      input.targetOperationId,
      450,
    );
}

function prepareFork(
  current: Fixture,
  sourceThreadId: string,
  childThreadId: string,
  suffix: string,
): void {
  const checkpoint = new BackendCheckpointRepository(current.database).create(
    current.scope,
    sourceThreadId,
    {
      id: `checkpoint-${suffix}`,
      applicationTurnId: `turn-${suffix}`,
      opaqueReference: `leaf-${suffix}`,
      now: 500,
    },
  );
  new ThreadLineageRepository(current.database).prepareOrigin(current.scope, {
    childThreadId,
    sourceThreadId,
    sourceTurnId: `turn-${suffix}`,
    sourceTurnCompletedAt: 490,
    sourceTurnRevision: 1,
    sourceCheckpointId: checkpoint.id,
    originKind: "user_fork",
    initiatingPrincipalId: current.scope.principalId,
    branchMethod: "provider_native",
    creationOperationId: `fork-${suffix}`,
    now: 510,
  });
}

function prepareForkCreation(current: Fixture): void {
  prepareFork(current, current.rootId, current.childId, "root-child");
  const creation = new ConversationCreationRepository(current.database);
  creation.prepare(current.scope, current.childId, {
    attemptId: "fork-attempt",
    mutationId: "fork-root-child",
    expectedThreadRevision: revision(current, current.childId),
    creationKind: "fork",
    forkChildIdentity: "provider_assigned",
    forkCreationRecovery: "potentially_unknown",
    sourceKind: "user_fork",
    initialInputText: null,
    initialAttachmentIds: [],
    backendCreationCorrelation: "fork-correlation",
    now: 520,
  });
  creation.markExternalCallStarted(
    current.scope,
    current.childId,
    "fork-attempt",
    530,
  );
}

function prepareRootBlockers(current: Fixture): {
  readonly queueId: string;
  readonly interruptId: string;
  readonly featureMutationId: string;
  readonly automationId: string;
  readonly automationRunId: string;
  readonly taskId: string;
  readonly completedTaskId: string;
} {
  bind(current, current.rootId);

  const drafts = new ConversationDraftRepository(current.database);
  const draft = drafts.get(current.scope, current.rootId);
  const queue = new QueuedInputRepository(current.database);
  const queued = queue.enqueue(current.scope, current.rootId, {
    id: "reset-queue",
    mutationId: "reset-queue-mutation",
    text: draft.text,
    contextExcerpts: draft.contextExcerpts,
    taskReferences: draft.taskReferences,
    attachmentIds: draft.attachments.map(({ id }) => id),
    source: {
      kind: "composer",
      requestedDeliveryMode: "queue",
      resolvedDeliveryMode: "queue",
      expectedThreadRevision: revision(current, current.rootId),
      expectedDraftRevision: draft.revision,
    },
    now: 540,
  }).item;
  expect(
    queue.claimHead(current.scope, current.rootId, "reset-queue-anchor", 545)
      ?.id,
  ).toBe(queued.id);

  const interruptId = "00000000-0000-4000-8000-000000000111";
  new ConversationOperationRepository(current.database).prepareInterrupt(
    current.scope,
    current.rootId,
    { operationId: interruptId, expectedActiveTurnId: "turn-active", now: 550 },
  );

  const featureMutationId = "feature-reset";
  new ProviderFeatureMutationRepository(current.database).prepare(
    current.scope,
    {
      applicationThreadId: current.rootId,
      mutationId: featureMutationId,
      featureId: "example.feature",
      schemaVersion: 1,
      actionId: "apply",
      requestFingerprint: "a".repeat(64),
      expectedThreadRevision: revision(current, current.rootId),
      expectedFeatureRevision: 1,
      desiredPostcondition: { enabled: true },
      now: 560,
    },
  );

  const automations = new AutomationRepository(current.database);
  const automationId = "automation-reset";
  const automationRunId = "automation-reset-run";
  automations.createDefinition(current.scope, {
    id: automationId,
    anchorThreadId: current.rootId,
    name: "Reset audit",
    prompt: "Run after the reset audit",
    precheck: null,
    runMode: "same_thread",
    enabled: true,
    schedule: { kind: "date_time", runAt: 10_000 },
    misfirePolicy: "coalesce",
    nextRunAt: 10_000,
    now: 570,
  });
  const claimToken = "automation-reset-claim";
  automations.createManualRun(current.scope, automationId, {
    runId: automationRunId,
    occurrenceKey: "automation-reset-occurrence",
    scheduledFor: 571,
    claimToken,
    leaseExpiresAt: 20_000,
    dispatchMutationId: "automation-reset-dispatch",
    now: 571,
  });
  automations.updateRunState(current.scope, automationId, automationRunId, {
    expectedState: "claimed",
    state: "dispatching",
    claimToken,
    retainPromptSnapshot: true,
    now: 572,
  });

  prepareForkCreation(current);
  const taskId = new TaskRepository(current.database).create(current.scope, {
    title: "Follow up on provisional child",
    scope: { kind: "thread", threadId: current.childId },
    mutationId: "child-task-create",
    now: 580,
  }).id;
  const tasks = new TaskRepository(current.database);
  const completedTask = tasks.create(current.scope, {
    title: "Completed work on provisional child",
    scope: { kind: "thread", threadId: current.childId },
    mutationId: "completed-child-task-create",
    now: 581,
  });
  const completedTaskId = tasks.update(current.scope, completedTask.id, {
    completed: true,
    expectedRevision: completedTask.revision,
    mutationId: "completed-child-task-finish",
    now: 582,
  }).id;
  return {
    queueId: queued.id,
    interruptId,
    featureMutationId,
    automationId,
    automationRunId,
    taskId,
    completedTaskId,
  };
}

function archiveService(
  current: Fixture,
  runtimeStates = new Map<string, ThreadRunState>(),
): ThreadArchiveService {
  const inventory = new InventoryRepository(current.database);
  const tasks = new TaskRepository(current.database);
  return new ThreadArchiveService({
    inventory,
    lineage: new ThreadLineageRepository(current.database),
    summaries: {
      listByIds: (scope, threadIds) =>
        threadIds.map((threadId) => {
          const aggregate = inventory.getThread(scope, threadId);
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
          pendingQuestionCount: 0,
            stashedPromptCount: 0,
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
    },
    runtimes: {
      captureLoadedState: async (_scope, threadId) => {
        const runState = runtimeStates.get(threadId);
        return runState ? { runState } : undefined;
      },
      runWithRuntimeRetired: async (_scope, _threadId, operation) =>
        operation(),
    },
    publications: { publishCommitted: async () => undefined },
    tasks,
    taskPublications: { publishTaskChange: async () => undefined },
    executionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    now: () => 900,
  });
}

describe("thread force-reset repository", () => {
  it("blocks archive at both callback endpoints and atomically cancels registered callbacks", () => {
    const current = fixture();
    try {
      const callbackId = "11111111-1111-4111-8111-111111111111";
      registerCompletionCallback(current, {
        id: callbackId,
        callerThreadId: current.rootId,
        targetThreadId: current.childId,
        targetOperationId: "callback-target-operation",
      });
      const inventory = new InventoryRepository(current.database);
      expect(
        inventory.findArchiveDurablyBlockedThreadIds(current.scope, [
          current.rootId,
          current.childId,
          current.grandchildId,
        ]),
      ).toEqual(new Set([current.rootId, current.childId]));
      expect(() =>
        inventory.archiveThreads(current.scope, current.rootId, {
          expectedRevision: 0,
          mutationId: "archive-registered-callback",
          includeDescendants: false,
          expectedThreadIds: [current.rootId],
          blockedThreadIds: new Set(),
          executionWorkspaceDisposition: { kind: "keep" },
          now: 490,
        }),
      ).toThrow("active or unresolved work");

      const resets = new ThreadForceResetRepository(current.database);
      const impact = resets.impact(current.scope, current.childId);
      expect(impact).toMatchObject({
        resettable: true,
        blockers: [{ kind: "completion_callback", count: 1 }],
        affectedThreads: [{ threadId: current.childId, title: expect.any(String) }],
      });

      expect(() =>
        resets.forceReset(current.scope, current.childId, {
          expectedBlockerFingerprint: "0".repeat(64),
          mutationId: "stale-callback-reset",
          now: 500,
        }),
      ).toThrow("state changed");
      expect(
        current.database
          .prepare(
            `SELECT state FROM thread_completion_callbacks
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(current.scope.tenantId, current.scope.principalId, callbackId),
      ).toEqual({ state: "registered" });

      const committed = resets.forceReset(current.scope, current.childId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "callback-force-reset",
        now: 510,
      });
      expect(committed).toMatchObject({
        resetBlockers: [{ kind: "completion_callback", count: 1 }],
      });
      expect(
        current.database
          .prepare(
            `SELECT state, cancelled_at AS cancelledAt,
               cancellation_reason AS cancellationReason,
               cancellation_mutation_id AS cancellationMutationId
             FROM thread_completion_callbacks
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(current.scope.tenantId, current.scope.principalId, callbackId),
      ).toEqual({
        state: "cancelled",
        cancelledAt: 510,
        cancellationReason:
          "The user force-reset an endpoint of this registered callback.",
        cancellationMutationId: "callback-force-reset",
      });
      expect(
        inventory.findArchiveDurablyBlockedThreadIds(current.scope, [
          current.rootId,
          current.childId,
        ]),
      ).toEqual(new Set());
    } finally {
      current.database.close();
    }
  });

  it("admits, fingerprints, and receipts pending interactions as the only blockers", () => {
    const current = fixture();
    try {
      const resets = new ThreadForceResetRepository(current.database);
      const pendingInteractions = [
        {
          kind: "pending_interaction" as const,
          id: "pending-approval",
          threadId: current.rootId,
        },
      ];
      const preview = resets.impact(
        current.scope,
        current.rootId,
        pendingInteractions,
      );
      expect(preview).toMatchObject({
        resettable: true,
        blockers: [{ kind: "pending_interaction", count: 1 }],
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "provider_side_effects_may_remain" }),
        ]),
      });

      expect(() =>
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: preview.blockerFingerprint,
          mutationId: "pending-interaction-changed",
          now: 500,
          pendingInteractions: [
            { ...pendingInteractions[0]!, id: "another-approval" },
          ],
        }),
      ).toThrow("state changed");

      const committed = resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: preview.blockerFingerprint,
        mutationId: "pending-interaction-reset",
        now: 510,
        pendingInteractions,
      });
      expect(committed).toMatchObject({
        replayed: false,
        resetAt: 510,
        resetBlockers: [{ kind: "pending_interaction", count: 1 }],
      });
      expect(
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: preview.blockerFingerprint,
          mutationId: "pending-interaction-reset",
          now: 999,
        }),
      ).toMatchObject({ replayed: true, resetAt: 510 });
    } finally {
      current.database.close();
    }
  });

  it("requires an exact scoped preview and replays before mutable eligibility", () => {
    const current = fixture();
    try {
      bind(current, current.rootId);
      const operations = new ConversationOperationRepository(current.database);
      operations.prepareInterrupt(current.scope, current.rootId, {
        operationId: "00000000-0000-4000-8000-000000000201",
        expectedActiveTurnId: "active-one",
        now: 500,
      });
      const resets = new ThreadForceResetRepository(current.database);
      const preview = resets.impact(current.scope, current.rootId);
      expect(preview).toMatchObject({
        resettable: true,
        blockers: [{ kind: "conversation_operation", count: 1 }],
      });
      expect(() =>
        resets.impact(
          { ...current.scope, principalId: "wrong-principal" },
          current.rootId,
        ),
      ).toThrow("not found");

      operations.prepareInterrupt(current.scope, current.rootId, {
        operationId: "00000000-0000-4000-8000-000000000202",
        expectedActiveTurnId: "active-two",
        now: 510,
      });
      expect(() =>
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: preview.blockerFingerprint,
          mutationId: "force-reset-cas",
          now: 600,
        }),
      ).toThrow("state changed");

      const currentPreview = resets.impact(current.scope, current.rootId);
      const committed = resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: currentPreview.blockerFingerprint,
        mutationId: "force-reset-cas",
        now: 610,
      });
      expect(committed).toMatchObject({
        replayed: false,
        resetAt: 610,
        resetBlockers: [{ kind: "conversation_operation", count: 2 }],
      });

      operations.prepareInterrupt(current.scope, current.rootId, {
        operationId: "00000000-0000-4000-8000-000000000203",
        expectedActiveTurnId: "active-after-reset",
        now: 620,
      });
      const replay = resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: currentPreview.blockerFingerprint,
        mutationId: "force-reset-cas",
        now: 999,
      });
      expect(replay).toMatchObject({ replayed: true, resetAt: 610 });
      expect(
        operations.findInterrupt(
          current.scope,
          "00000000-0000-4000-8000-000000000203",
        )?.state,
      ).toBe("prepared");
      expect(() =>
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: resets.impact(
            current.scope,
            current.rootId,
          ).blockerFingerprint,
          mutationId: "force-reset-cas",
          now: 630,
        }),
      ).toThrow("reused");
      expect(() =>
        resets.forceReset(
          { ...current.scope, principalId: "wrong-principal" },
          current.rootId,
          {
            expectedBlockerFingerprint: currentPreview.blockerFingerprint,
            mutationId: "force-reset-cas",
            now: 630,
          },
        ),
      ).toThrow("not found");
    } finally {
      current.database.close();
    }
  });

  it.each(["source"] as const)(
    "atomically tombstones every blocker from the prepared fork %s and preserves real runtime activity",
    async (invocation) => {
      const current = fixture();
      try {
        const seeded = prepareRootBlockers(current);
        const resets = new ThreadForceResetRepository(current.database);
        const invokedThreadId =
          invocation === "source" ? current.rootId : current.childId;
        const impact = resets.impact(current.scope, invokedThreadId);
        expect(impact.blockers).toEqual([
          { kind: "queued_input", count: 1 },
          { kind: "conversation_operation", count: 1 },
          { kind: "provider_feature_operation", count: 1 },
          { kind: "creation_attempt", count: 1 },
          { kind: "thread_creation_state", count: 1 },
          { kind: "fork_origin", count: 1 },
          { kind: "automation_run", count: 1 },
        ]);
        expect(impact.affectedThreads.map(({ threadId }) => threadId)).toEqual(
          [current.rootId, current.childId].sort(),
        );
        expect(impact.warnings.map(({ code }) => code)).toEqual([
          "provider_side_effects_may_remain",
          "native_fork_orphan_may_remain",
          "provider_activity_may_reappear",
        ]);

        const reset = resets.forceReset(current.scope, invokedThreadId, {
          expectedBlockerFingerprint: impact.blockerFingerprint,
          mutationId: `force-reset-${invocation}`,
          now: 700,
        });
        expect(reset.affectedThreadIds).toEqual(
          [current.rootId, current.childId].sort(),
        );
        expect(reset.promotedTaskIds).toEqual(
          [seeded.taskId, seeded.completedTaskId].sort(),
        );

        const queue = new QueuedInputRepository(current.database).get(
          current.scope,
          current.rootId,
          seeded.queueId,
        );
        expect(queue).toMatchObject({
          state: "failed",
          resolvedAt: 700,
          failureAcknowledgedAt: 700,
        });
        expect(
          current.database
            .prepare(
              `SELECT result_code AS resultCode FROM mutation_receipts
               WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
            )
            .get(
              current.scope.tenantId,
              current.scope.principalId,
              seeded.interruptId,
            ),
        ).toEqual({ resultCode: "abandoned" });
        expect(
          new ProviderFeatureMutationRepository(current.database).find(
            current.scope,
            seeded.featureMutationId,
          ),
        ).toMatchObject({ state: "abandoned", forceResetAt: 700 });
        expect(
          new ConversationCreationRepository(
            current.database,
          ).findActiveForThread(current.scope, current.childId),
        ).toBeUndefined();
        expect(
          new ConversationCreationRepository(current.database).listActiveForks(
            current.scope,
          ),
        ).toEqual([]);
        const child = new InventoryRepository(current.database).getThread(
          current.scope,
          current.childId,
        );
        expect(child.thread.backingState).toBe("creation_unknown");
        expect(child.inventory.inventoryState).toBe("archived");
        expect(
          new TaskRepository(current.database).get(
            current.scope,
            seeded.taskId,
          ),
        ).toMatchObject({
          scopeKind: "thread",
          threadId: current.rootId,
          revision: 1,
        });
        expect(
          new TaskRepository(current.database).get(
            current.scope,
            seeded.completedTaskId,
          ),
        ).toMatchObject({
          scopeKind: "thread",
          threadId: current.rootId,
          revision: 2,
          completedAt: 582,
        });
        expect(
          new AutomationRepository(current.database).getRun(
            current.scope,
            seeded.automationId,
            seeded.automationRunId,
          ),
        ).toMatchObject({ state: "failed", errorCode: "force_reset" });
        expect(
          new AutomationRepository(current.database).getDefinition(
            current.scope,
            seeded.automationId,
          ),
        ).toMatchObject({ enabled: true, nextRunAt: 10_000 });

        const inventory = new InventoryRepository(current.database);
        expect(
          inventory.findArchiveDurablyBlockedThreadIds(current.scope, [
            current.rootId,
            current.childId,
          ]),
        ).toEqual(new Set());
        const runtimeStates = new Map<string, ThreadRunState>([
          [current.rootId, "running"],
        ]);
        const archives = archiveService(current, runtimeStates);
        await expect(
          archives.impact(current.scope, current.rootId),
        ).resolves.toMatchObject({
          archiveOnly: {
            available: false,
            unavailableReason: "This thread is running and cannot be archived.",
          },
        });
        runtimeStates.delete(current.rootId);
        await expect(
          archives.impact(current.scope, current.rootId),
        ).resolves.toMatchObject({
          archiveOnly: { available: true },
          archiveAll: { available: true },
        });
        expect(() =>
          new QueuedInputRepository(current.database).markAccepted(
            current.scope,
            current.rootId,
            seeded.queueId,
            { expectedState: "dispatching", acceptedAt: 710 },
          ),
        ).toThrow("not awaiting acceptance");
        expect(() =>
          new ConversationOperationRepository(current.database).acceptInterrupt(
            current.scope,
            seeded.interruptId,
          ),
        ).toThrow("explicitly abandoned");
        expect(() =>
          new ProviderFeatureMutationRepository(current.database).accept(
            current.scope,
            seeded.featureMutationId,
            {
              requestFingerprint: "a".repeat(64),
              result: { enabled: true },
              now: 710,
            },
          ),
        ).toThrow();
        expect(() =>
          current.database
            .prepare(
              `UPDATE conversation_creation_attempts SET phase = 'bound'
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND application_thread_id = ? AND attempt_id = ?`,
            )
            .run(
              current.scope.tenantId,
              current.scope.principalId,
              current.childId,
              "fork-attempt",
            ),
        ).toThrow("immutable");
        expect(() =>
          new ThreadLineageRepository(current.database).commitOrigin(
            current.scope,
            current.childId,
            "fork-root-child",
            710,
          ),
        ).toThrow();
        expect(() =>
          current.database
            .prepare(
              `UPDATE automation_runs SET state = 'completed'
               WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
            )
            .run(
              current.scope.tenantId,
              current.scope.principalId,
              seeded.automationRunId,
            ),
        ).toThrow("immutable");
        expect(() =>
          new QueuedInputRepository(current.database).enqueue(
            current.scope,
            current.rootId,
            {
              id: "late-automation-queue",
              mutationId: "automation-reset-dispatch",
              text: "Late automation work",
              contextExcerpts: [],
              taskReferences: [],
              attachmentIds: [],
              source: {
                kind: "automation",
                expectedThreadRevision: revision(current, current.rootId),
                automationId: seeded.automationId,
                automationRunId: seeded.automationRunId,
              },
              now: 720,
            },
          ),
        ).toThrow("Force-reset automation cannot enqueue input");
        expect(() =>
          new ConversationCreationRepository(current.database).prepare(
            current.scope,
            current.grandchildId,
            {
              attemptId: "late-automation-creation",
              mutationId: "automation-reset-dispatch",
              expectedThreadRevision: revision(current, current.grandchildId),
              creationKind: "first_input",
              sourceKind: "automation",
              sourceAutomationId: seeded.automationId,
              sourceAutomationRunId: seeded.automationRunId,
              initialInputText: "Late automation creation",
              initialAttachmentIds: [],
              backendCreationCorrelation: "late-automation-creation",
              now: 721,
            },
          ),
        ).toThrow("Force-reset automation cannot create a conversation");
        expect(() =>
          current.database
            .prepare(
              `INSERT INTO thread_fork_origins(
                 tenant_id, owner_principal_id, child_thread_id,
                 provider_parent_backend_conversation_id, source_thread_state,
                 source_thread_id, environment_id, workspace_id,
                 backend_instance_id, connection_profile_id, source_turn_state,
                 source_turn_id, source_turn_revision, source_checkpoint_id,
                 boundary_kind, origin_kind, initiating_principal_id,
                 source_automation_id, source_automation_run_id, branch_method,
                 creation_operation_id, origin_state, created_at, committed_at
               )
               SELECT tenant_id, owner_principal_id, ?,
                 provider_parent_backend_conversation_id, source_thread_state,
                 source_thread_id, environment_id, workspace_id,
                 backend_instance_id, connection_profile_id, source_turn_state,
                 source_turn_id, source_turn_revision, source_checkpoint_id,
                 boundary_kind, 'automation_fork', ?, ?, ?, branch_method,
                 ?, 'prepared', ?, NULL
               FROM thread_fork_origins
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND child_thread_id = ?`,
            )
            .run(
              current.grandchildId,
              current.scope.principalId,
              seeded.automationId,
              seeded.automationRunId,
              "automation-reset-dispatch",
              722,
              current.scope.tenantId,
              current.scope.principalId,
              current.childId,
            ),
        ).toThrow("Force-reset automation cannot create a fork");
        expect(() =>
          new ConversationCreationRepository(current.database).prepare(
            current.scope,
            current.childId,
            {
              attemptId: "replacement-attempt",
              mutationId: "replacement-create",
              expectedThreadRevision: revision(current, current.childId),
              creationKind: "fork",
              forkChildIdentity: "provider_assigned",
              forkCreationRecovery: "potentially_unknown",
              sourceKind: "user_fork",
              initialInputText: null,
              initialAttachmentIds: [],
              backendCreationCorrelation: "replacement-correlation",
              now: 730,
            },
          ),
        ).toThrow("no longer an unchanged unbound draft");
        await expect(
          archives.archive(current.scope, current.rootId, {
            includeDescendants: false,
            expectedRevision: new InventoryRepository(
              current.database,
            ).getInventory(current.scope, current.rootId).inventoryRevision,
            mutationId: `archive-after-force-reset-${invocation}`,
            executionWorkspaceDisposition: { kind: "keep" },
          }),
        ).resolves.toEqual([current.rootId]);
        expect(
          new InventoryRepository(current.database).getInventory(
            current.scope,
            current.rootId,
          ).inventoryState,
        ).toBe("archived");
      } finally {
        current.database.close();
      }
    },
  );

  it("resets only a prepared fork child when started from it and never reaches its running source", () => {
    const current = fixture();
    try {
      const seeded = prepareRootBlockers(current);
      const resets = new ThreadForceResetRepository(current.database);
      const running = { kind: "conversation_runtime" as const, threadId: current.rootId,
        generation: "source-generation", runState: "running" as const, activeTurnId: "source-turn" };
      // The source's loaded runtime is not part of a child-scoped reset.
      expect(() => resets.impact(current.scope, current.childId, [], [running])).toThrow("invalid or stale");
      const impact = resets.impact(current.scope, current.childId);
      expect(impact.affectedThreads).toEqual([{ threadId: current.childId, title: expect.any(String) }]);
      expect(impact.blockers).toEqual([
        { kind: "creation_attempt", count: 1 },
        { kind: "thread_creation_state", count: 1 },
        { kind: "fork_origin", count: 1 },
      ]);
      const reset = resets.forceReset(current.scope, current.childId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "force-reset-child-only",
        now: 700,
      });
      expect(reset.affectedThreadIds).toEqual([current.childId]);
      // The child's tasks still move to the retained source.
      expect(reset.promotedTaskIds).toEqual([seeded.taskId, seeded.completedTaskId].sort());
      expect(new QueuedInputRepository(current.database).get(current.scope, current.rootId, seeded.queueId))
        .toMatchObject({ state: "dispatching" });
      expect(new ProviderFeatureMutationRepository(current.database).find(current.scope, seeded.featureMutationId))
        .not.toMatchObject({ state: "abandoned" });
      expect(new InventoryRepository(current.database).getThread(current.scope, current.childId).inventory.inventoryState)
        .toBe("archived");
      expect(new ConversationCreationRepository(current.database).findActiveForThread(current.scope, current.childId))
        .toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("names affected threads with their loaded runtime's run state and background work", () => {
    const current = fixture();
    try {
      prepareRootBlockers(current);
      const resets = new ThreadForceResetRepository(current.database);
      const background = { state: "known" as const, agents: 2, commands: 0, other: 0 };
      const runtime = { kind: "conversation_runtime" as const, threadId: current.rootId,
        generation: "source-generation", runState: "idle" as const, backgroundActivity: background };
      const impact = resets.impact(current.scope, current.rootId, [], [runtime]);
      expect(impact.affectedThreads.find(({ threadId }) => threadId === current.rootId))
        .toMatchObject({ runtime: { runState: "idle", backgroundActivity: background } });
      expect(impact.warnings[0]).toMatchObject({ code: "running_work_will_stop" });
      const settled = resets.impact(current.scope, current.rootId, [], [{ ...runtime, backgroundActivity:
        { state: "known", agents: 0, commands: 0, other: 0 } }]);
      // A change in background work changes what the user reviewed.
      expect(settled.blockerFingerprint).not.toBe(impact.blockerFingerprint);
      expect(settled.warnings.map(({ code }) => code)).not.toContain("running_work_will_stop");
    } finally {
      current.database.close();
    }
  });

  it("moves every prepared-fork chain task to the first retained source", () => {
    const current = fixture();
    try {
      bind(current, current.rootId);
      prepareFork(current, current.rootId, current.childId, "chain-one");
      // This simulates a legacy/corrupt partially-bound child. Force reset must
      // still avoid stranding the grandchild's task on the archived child.
      bind(current, current.childId, "session-chain-child");
      prepareFork(current, current.childId, current.grandchildId, "chain-two");
      const tasks = new TaskRepository(current.database);
      const childTask = tasks.create(current.scope, {
        title: "Child task",
        scope: { kind: "thread", threadId: current.childId },
        mutationId: "chain-child-task",
        now: 600,
      });
      const grandchildTask = tasks.create(current.scope, {
        title: "Grandchild task",
        scope: { kind: "thread", threadId: current.grandchildId },
        mutationId: "chain-grandchild-task",
        now: 601,
      });
      const resets = new ThreadForceResetRepository(current.database);
      const impact = resets.impact(current.scope, current.rootId);
      expect(impact.blockers).toEqual([{ kind: "fork_origin", count: 2 }]);
      resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "force-reset-chain",
        now: 700,
      });
      for (const task of [childTask, grandchildTask]) {
        expect(tasks.get(current.scope, task.id)).toMatchObject({
          scopeKind: "thread",
          threadId: current.rootId,
          revision: 1,
        });
      }
    } finally {
      current.database.close();
    }
  });

  it("acknowledges an existing failed queue item without rewriting its failure evidence", () => {
    const current = fixture();
    try {
      bind(current, current.rootId);
      const drafts = new ConversationDraftRepository(current.database);
      const draft = drafts.get(current.scope, current.rootId);
      const queue = new QueuedInputRepository(current.database);
      const queued = queue.enqueue(current.scope, current.rootId, {
        id: "failed-reset-queue",
        mutationId: "failed-reset-queue-mutation",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        taskReferences: draft.taskReferences,
        attachmentIds: draft.attachments.map(({ id }) => id),
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: revision(current, current.rootId),
          expectedDraftRevision: draft.revision,
        },
        now: 500,
      }).item;
      expect(
        queue.claimHead(current.scope, current.rootId, "failed-anchor", 510)
          ?.id,
      ).toBe(queued.id);
      queue.handleCleanFailure(current.scope, current.rootId, queued.id, {
        expectedState: "dispatching",
        retryable: false,
        diagnostic: "Original provider rejection diagnostic.",
        now: 520,
        retryPolicy: {
          maximumRetries: 1,
          baseDelayMilliseconds: 100,
          maximumDelayMilliseconds: 1_000,
        },
      });
      expect(queue.get(current.scope, current.rootId, queued.id)).toMatchObject(
        {
          state: "failed",
          resolvedAt: 520,
          diagnostic: "Original provider rejection diagnostic.",
          failureAcknowledgedAt: null,
        },
      );

      const resets = new ThreadForceResetRepository(current.database);
      const impact = resets.impact(current.scope, current.rootId);
      expect(impact.blockers).toEqual([{ kind: "queued_input", count: 1 }]);
      resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "force-reset-failed-queue",
        now: 700,
      });

      expect(queue.get(current.scope, current.rootId, queued.id)).toMatchObject(
        {
          state: "failed",
          resolvedAt: 520,
          diagnostic: "Original provider rejection diagnostic.",
          failureAcknowledgedAt: 700,
        },
      );
    } finally {
      current.database.close();
    }
  });

  it("rejects a late clone-child bind with a structured conflict after force reset", () => {
    const current = fixture();
    try {
      bind(current, current.rootId);
      const automations = new AutomationRepository(current.database);
      const automation = automations.createDefinition(current.scope, {
        id: "late-bind-automation",
        anchorThreadId: current.rootId,
        name: "Late bind reset audit",
        prompt: "Create a branch",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: { kind: "date_time", runAt: 10_000 },
        misfirePolicy: "coalesce",
        nextRunAt: 10_000,
        now: 500,
      });
      const run = automations.createManualRun(current.scope, automation.id, {
        runId: "late-bind-run",
        occurrenceKey: "late-bind-occurrence",
        scheduledFor: 510,
        claimToken: "late-bind-claim",
        leaseExpiresAt: 20_000,
        dispatchMutationId: "late-bind-dispatch",
        now: 510,
      }).run;
      const checkpoint = new BackendCheckpointRepository(
        current.database,
      ).create(current.scope, current.rootId, {
        id: "late-bind-checkpoint",
        applicationTurnId: "late-bind-source-turn",
        opaqueReference: "late-bind-leaf",
        now: 520,
      });
      new ThreadLineageRepository(current.database).prepareOrigin(
        current.scope,
        {
          childThreadId: current.childId,
          sourceThreadId: current.rootId,
          sourceTurnId: "late-bind-source-turn",
          sourceTurnCompletedAt: null,
          sourceCheckpointId: checkpoint.id,
          originKind: "automation_fork",
          initiatingPrincipalId: current.scope.principalId,
          sourceAutomationId: automation.id,
          sourceAutomationRunId: run.id,
          branchMethod: "provider_native",
          creationOperationId: run.dispatchMutationId,
          now: 530,
        },
      );
      const creation = new ConversationCreationRepository(current.database);
      creation.prepare(current.scope, current.childId, {
        attemptId: "late-bind-attempt",
        mutationId: run.dispatchMutationId,
        expectedThreadRevision: revision(current, current.childId),
        creationKind: "fork",
        forkChildIdentity: "application_reserved",
        forkCreationRecovery: "idempotent",
        sourceKind: "automation",
        sourceAutomationId: automation.id,
        sourceAutomationRunId: run.id,
        initialInputText: null,
        initialAttachmentIds: [],
        backendCreationCorrelation: "late-bind-correlation",
        now: 540,
      });
      creation.markExternalCallStarted(
        current.scope,
        current.childId,
        "late-bind-attempt",
        550,
      );
      creation.recordConversationIdentified(
        current.scope,
        current.childId,
        "late-bind-attempt",
        {
          backendConversationId: "late-bind-child",
          opaqueBindingDetail: "late-bind-detail",
          now: 560,
        },
      );
      new ConversationBindingRepository(
        current.database,
      ).bindCreatedConversation(current.scope, current.childId, {
        attemptId: "late-bind-attempt",
        backendConversationId: "late-bind-child",
        acceptedAt: 570,
      });

      const resets = new ThreadForceResetRepository(current.database);
      const impact = resets.impact(current.scope, current.rootId);
      expect(impact.blockers).toEqual([{ kind: "automation_run", count: 1 }]);
      resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "force-reset-late-bind",
        now: 700,
      });

      let thrown: unknown;
      try {
        automations.bindForkChild(current.scope, automation.id, run.id, {
          childThreadId: current.childId,
          now: 710,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect(thrown).toMatchObject({
        code: "conflict",
        message: "The automation branch lineage changed in another operation.",
      });
    } finally {
      current.database.close();
    }
  });

  it("reports a clean thread without inventing a resettable runtime blocker", () => {
    const current = fixture();
    try {
      const resets = new ThreadForceResetRepository(current.database);
      const impact = resets.impact(current.scope, current.rootId);
      expect(impact).toMatchObject({
        resettable: false,
        blockers: [],
        affectedThreads: [{ threadId: current.rootId, title: expect.any(String) }],
      });
      expect(() =>
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: impact.blockerFingerprint,
          mutationId: "force-reset-empty",
          now: 500,
        }),
      ).toThrow("no unresolved Sedes state");
    } finally {
      current.database.close();
    }
  });

  it("admits a runtime-only reset with exact generation and state CAS evidence", () => {
    const current = fixture();
    try {
      const resets = new ThreadForceResetRepository(current.database);
      const runtime = {
        kind: "conversation_runtime" as const,
        threadId: current.rootId,
        generation: "runtime-generation-1",
        runState: "waiting_for_input" as const,
        activeTurnId: "turn-1",
      };
      const impact = resets.impact(
        current.scope,
        current.rootId,
        [],
        [runtime],
      );
      expect(impact).toMatchObject({
        resettable: true,
        blockers: [{ kind: "conversation_runtime", count: 1 }],
      });

      expect(() =>
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: impact.blockerFingerprint,
          mutationId: "runtime-stale",
          now: 500,
          conversationRuntimes: [
            { ...runtime, generation: "runtime-generation-2" },
          ],
        }),
      ).toThrow("state changed");

      const committed = resets.forceReset(current.scope, current.rootId, {
        expectedBlockerFingerprint: impact.blockerFingerprint,
        mutationId: "runtime-reset",
        now: 510,
        conversationRuntimes: [runtime],
      });
      expect(committed).toMatchObject({
        replayed: false,
        resetBlockers: [{ kind: "conversation_runtime", count: 1 }],
        resetConversationRuntimes: [runtime],
      });
      expect(
        resets.forceReset(current.scope, current.rootId, {
          expectedBlockerFingerprint: impact.blockerFingerprint,
          mutationId: "runtime-reset",
          now: 999,
          conversationRuntimes: [
            { ...runtime, generation: "newer-generation" },
          ],
        }),
      ).toMatchObject({
        replayed: true,
        resetConversationRuntimes: [],
      });
    } finally {
      current.database.close();
    }
  });
});
