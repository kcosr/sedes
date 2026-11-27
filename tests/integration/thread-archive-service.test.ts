import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadInventoryControlService,
  type ThreadSetStateToolInput,
} from "../../src/server/agent-tools/application/agent-thread-inventory-control-service.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
} from "../../src/server/agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
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
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { ThreadGroupService } from "../../src/server/domain/thread-group-service.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { ArchivedThreadRuntimeRetirement } from "../../src/server/domain/thread-runtime-archive-retirement.js";
import {
  ThreadProviderOutputUndeliveredError,
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

function fixture(nativeArchive?: {
  archive(scope: { tenantId: string; principalId: string }, threadIds: readonly string[]): Promise<void>;
}) {
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
  const runtimeStates = new Map<string, ThreadRunState>();
  const inventory = new InventoryRepository(database, (_scope, threadId) =>
    runtimeStates.get(threadId) === "running" ? "running-turn" : undefined);
  const archiveSafe = new Set<string>();
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
          nonArchivedWorkpadCount: 0,
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
          automations: { totalCount: 0, enabledCount: 0, pausedCount: 0, exhaustedCount: 0, inFlightCount: 0, attentionCount: 0, revision: 0 },
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
        return runState ? { runState, archiveRetirementSafe: archiveSafe.has(threadId) } : undefined;
      },
      runWithRuntimeRetired:
        runWithRuntimeRetired as unknown as ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"],
      releaseProviderResidency,
    },
    publications: { publishCommitted },
    nativeArchive,
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
    archiveSafe,
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

function agentInventory(current: ReturnType<typeof fixture>) {
  const { scope, rootId: threadId } = current;
  const { thread } = current.inventory.getThread(scope, threadId);
  const defaults = {
    kind: "thread_agent" as const,
    threadId,
    workspaceId: thread.workspaceId,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
  };
  const resolver = new AgentToolEnvironmentAuthorityResolver(
    new DatabaseAgentToolSourceAuthority(current.database, new Uint8Array(32)),
  );
  const resourceScope = { allowOtherEnvironments: false, allowOtherProjects: false };
  const groupAssignments = new ThreadGroupRepository(current.database);
  const publishGroups = vi.fn(async () => {});
  const publishPin = vi.fn(async () => {});
  const service = new AgentThreadInventoryControlService({
    inventory: current.inventory,
    threads: current.inventory,
    lineage: current.lineage,
    archives: current.service,
    groupAssignments,
    groups: new ThreadGroupService(groupAssignments, { publishAuthoritativeReplacement: publishGroups }),
    transitions: new InventoryService(current.inventory, {
      publishMany: () => undefined,
      publishApplicationThread: publishPin,
    }),
  });
  function mutation(
    id: "thread.set_state" | "thread.set_pinned" | "thread.set_group" | "thread_group.create",
    input: unknown,
  ) {
    const tool = CANONICAL_AGENT_TOOL_MANIFEST[id];
    return {
      mutationId: randomUUID(),
      environmentAuthority: createTrustedEnvironmentAuthorityGrant({
        ...resolver.resolve({ tool, scope, input, defaults, resourceScope }),
        tool, defaults, resourceScope,
        callerKind: "thread_agent",
        policyIdentity: { ownerKind: "thread", ownerId: threadId, revision: 1 },
        admittedEnvironmentIds: [thread.environmentId],
      }),
    };
  }
  return { service, mutation, groupAssignments, publishPin, publishGroups };
}

describe("thread family archive service", () => {
  it("commits inventory and synchronizes native archive inside the maintenance fence before publication", async () => {
    let fenced = false;
    const archive = vi.fn(async () => {
      expect(fenced).toBe(true);
      expect(current.inventory.getInventory(current.scope, current.rootId).inventoryState).toBe("archived");
    });
    const current = fixture({ archive });
    current.runWithRuntimeRetired.mockImplementation(async (_scope, _id, operation) => {
      fenced = true;
      try { return await operation(); } finally { fenced = false; }
    });
    current.publishCommitted.mockImplementation(async () => { expect(fenced).toBe(false); });
    try {
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: false, expectedRevision: 0, mutationId: "native-archive-order",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(archive).toHaveBeenCalledExactlyOnceWith(current.scope, [current.rootId]);
      expect(current.publishCommitted).toHaveBeenCalledOnce();
    } finally { current.database.close(); }
  });

  it("synchronizes an already archived root on a fresh request without changing inventory again", async () => {
    const archive = vi.fn(async () => undefined);
    const current = fixture({ archive });
    try {
      const input = {
        includeDescendants: false, expectedRevision: 0, mutationId: "initial-native-archive",
        executionWorkspaceDisposition: { kind: "keep" as const },
      };
      await current.service.archive(current.scope, current.rootId, input);
      const revision = current.inventory.getInventory(current.scope, current.rootId).inventoryRevision;
      archive.mockClear();
      await current.service.archive(current.scope, current.rootId, {
        ...input, expectedRevision: revision, mutationId: "manual-native-archive-sweep",
      });
      expect(archive).toHaveBeenCalledExactlyOnceWith(current.scope, [current.rootId]);
      expect(current.inventory.getInventory(current.scope, current.rootId).inventoryRevision).toBe(revision);
    } finally { current.database.close(); }
  });

  it.each([
    ["missing", false], ["missing", true],
    ["quarantined", false], ["quarantined", true],
    ["environment_unavailable", false], ["environment_unavailable", true],
  ] as const)("archives dormant %s threads with descendants=%s without changing provider evidence", async (availability, includeDescendants) => {
    const current = fixture();
    try {
      const ids = [current.rootId, current.childId, current.grandchildId];
      const setAvailability = current.database.prepare(
        "UPDATE application_threads SET availability = ? WHERE id = ?",
      );
      for (const id of ids) setAvailability.run(availability, id);
      await expect(current.service.impact(current.scope, current.rootId)).resolves.toMatchObject({
        archiveOnly: { available: true }, archiveAll: { available: true },
      });
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants, expectedRevision: 0,
        mutationId: `archive-${availability}-${includeDescendants}`,
        executionWorkspaceDisposition: { kind: "keep" },
      });
      for (const id of ids) {
        expect(current.inventory.getThread(current.scope, id).thread.availability).toBe(availability);
        expect(current.inventory.getInventory(current.scope, id).inventoryState).toBe(
          includeDescendants || id === current.rootId ? "archived" : "active",
        );
      }
    } finally { current.database.close(); }
  });

  it("archives an incomplete historical family only with explicit runtime quiescence", async () => {
    const current = fixture();
    try {
      for (const id of [current.rootId, current.childId]) {
        current.runtimeStates.set(id, "disconnected"); current.archiveSafe.add(id);
      }
      await expect(current.service.impact(current.scope, current.rootId)).resolves.toMatchObject({
        archiveOnly: { available: true }, archiveAll: { available: true },
      });
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true, expectedRevision: 0, mutationId: "archive-incomplete-family",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      for (const id of [current.rootId, current.childId, current.grandchildId]) {
        expect(current.inventory.getInventory(current.scope, id).inventoryState).toBe("archived");
        expect(current.runWithRuntimeRetired).toHaveBeenCalledWith(current.scope, id, expect.any(Function), { purpose: "archive" });
        expect(current.releaseProviderResidency).toHaveBeenCalledWith(current.scope, id, { purpose: "archive" });
      }
    } finally { current.database.close(); }
  });

  it.each(["disconnected", "reconciling"] as const)("keeps a quarantined thread with a loaded %s runtime blocked", async (state) => {
    const current = fixture();
    try {
      current.database.prepare("UPDATE application_threads SET availability = 'quarantined' WHERE id = ?").run(current.rootId);
      current.runtimeStates.set(current.rootId, state);
      await expect(current.service.impact(current.scope, current.rootId)).resolves.toMatchObject({
        archiveOnly: { available: false }, archiveAll: { available: false },
      });
      await expect(current.service.archive(current.scope, current.rootId, {
        includeDescendants: false, expectedRevision: 0,
        mutationId: `archive-loaded-${state}`, executionWorkspaceDisposition: { kind: "keep" },
      })).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.inventory.getInventory(current.scope, current.rootId).inventoryState).toBe("active");
    } finally { current.database.close(); }
  });

  it("keeps a missing descendant with unresolved provider work blocked", async () => {
    const current = fixture();
    try {
      current.database.prepare("UPDATE application_threads SET availability = 'missing' WHERE id = ?").run(current.grandchildId);
      new ProviderFeatureMutationRepository(current.database).prepare(current.scope, {
        applicationThreadId: current.grandchildId,
        mutationId: "missing-descendant-provider-work", featureId: "execution-settings",
        schemaVersion: 1, actionId: "set-model", requestFingerprint: "a".repeat(64),
        expectedThreadRevision: 0, expectedMutationRevision: 0,
        desiredPostcondition: { model: "test-model" }, now: 450,
      });
      await expectDescendantReservationBlocks(current, "archive-missing-descendant-provider-work");
    } finally { current.database.close(); }
  });

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

  it("rejects a stale park stash count and preserves the confirmed stash", async () => {
    const current = fixture();
    try {
      current.stashPrompt(
        current.rootId,
        "Park later",
        "park-stale-stash",
        450,
      );

      await expect(
        current.service.park(current.scope, current.rootId, {
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          mutationId: "park-stale-stash-count",
        }),
      ).rejects.toThrow("Stashed prompts changed");
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });

      await current.service.park(current.scope, current.rootId, {
        expectedRevision: 0,
        expectedStashedPromptCount: 1,
        mutationId: "park-confirmed-stash-count",
      });
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({ inventoryState: "parked", inventoryRevision: 1 });
      expect(
        current.inventory.listStashes(current.scope, current.rootId),
      ).toHaveLength(1);
    } finally {
      current.database.close();
    }
  });

  it("sets the running caller's lifecycle with the existing single-thread Park and Snooze guards", async () => {
    const current = fixture();
    try {
      const { scope, rootId: threadId } = current;
      const { service, mutation } = agentInventory(current);
      const setState = (input: ThreadSetStateToolInput) => service.setState(scope, {
        ...input,
        ...mutation("thread.set_state", input),
      });
      const inventory = () => current.inventory.getInventory(scope, threadId);
      const task = current.tasks.create(scope, {
        title: "Follow up after parking",
        scope: { kind: "thread", threadId },
        mutationId: "agent-park-task",
        now: 450,
      });
      current.stashPrompt(threadId, "Keep this prompt", "agent-park-stash", 451);
      current.runtimeStates.set(threadId, "running");

      await expect(setState({ lifecycle: "parked" }))
        .resolves.toEqual({ threadId, lifecycle: "parked" });
      await expect(setState({ lifecycle: "parked" }))
        .resolves.toEqual({ threadId, lifecycle: "parked" });
      expect(current.inventory.unparkIfTurnEnded(scope, threadId, id => id === "running-turn", Date.now())).toBeUndefined();
      expect(inventory()).toMatchObject({ inventoryState: "parked", inventoryRevision: 1 });
      expect(current.tasks.get(scope, task.id)).toMatchObject({
        scopeKind: "thread", threadId, revision: task.revision,
      });
      expect(current.inventory.listStashes(scope, threadId)).toHaveLength(1);
      expect(current.publishTaskChange).not.toHaveBeenCalled();
      expect(current.runWithRuntimeRetired).not.toHaveBeenCalled();

      const until = new Date(Date.now() + 3_600_000).toISOString();
      await expect(setState({ lifecycle: "snoozed", until }))
        .rejects.toMatchObject({ code: "invalid_transition" });
      await expect(setState({ lifecycle: "active" }))
        .resolves.toEqual({ threadId, lifecycle: "active" });

      for (const input of [
        { lifecycle: "snoozed" },
        { lifecycle: "snoozed", until: "2000-01-01T00:00:00.000Z" },
        { lifecycle: "snoozed", until: "2099-01-01 01:00:00.000Z" },
        { lifecycle: "active", reminder: "A wake reminder requires a snooze" },
        { lifecycle: "parked", until },
      ] satisfies ThreadSetStateToolInput[]) {
        await expect(setState(input)).rejects.toMatchObject({ code: "invalid_input" });
      }
      expect(inventory()).toMatchObject({ inventoryState: "active", inventoryRevision: 2 });

      const snoozed = { threadId, lifecycle: "snoozed", snoozedUntil: until, wakeReminder: "Review status" };
      await expect(setState({ lifecycle: "snoozed", until, reminder: "Review status" }))
        .resolves.toEqual(snoozed);
      const later = new Date(Date.parse(until) + 3_600_000).toISOString();
      await expect(setState({ lifecycle: "snoozed", until: later, reminder: "Changed" }))
        .resolves.toEqual(snoozed);
      await expect(setState({ lifecycle: "snoozed", until: "2000-01-01T00:00:00.000Z" }))
        .rejects.toMatchObject({ code: "invalid_input" });
      expect(inventory()).toMatchObject({ inventoryState: "snoozed", inventoryRevision: 3 });

      await expect(setState({ lifecycle: "active" }))
        .resolves.toEqual({ threadId, lifecycle: "active" });
      expect(inventory()).toMatchObject({
        inventoryState: "active", inventoryRevision: 4, wakeReason: "manual",
      });
      await expect(setState({ lifecycle: "snoozed", until }))
        .resolves.toEqual({ threadId, lifecycle: "snoozed", snoozedUntil: until, wakeReminder: null });

      current.inventory.transitionInventory(scope, threadId, {
        expectedRevision: inventory().inventoryRevision,
        mutationId: randomUUID(),
        change: { action: "archive" },
        now: Date.now(),
      });
      await expect(setState({ lifecycle: "active" })).rejects.toMatchObject({
        code: "conflict", message: expect.stringContaining("thread.restore"),
      });
      expect(inventory().inventoryState).toBe("archived");
    } finally {
      current.database.close();
    }
  });

  it("organizes archived threads using independent pin and membership revisions", async () => {
    const current = fixture();
    try {
      const { scope, rootId: threadId, childId } = current;
      const { service, mutation, groupAssignments, publishPin, publishGroups } = agentInventory(current);
      const setPin = (pinned: boolean) => service.setPinned(scope, {
        pinned, ...mutation("thread.set_pinned", { pinned }),
      });
      const create = (name: string) => service.createGroup(scope, {
        name, ...mutation("thread_group.create", { name }),
      });
      const setGroup = (target: string, groupId: string | null) => {
        const input = { threadId: target, groupId };
        return service.setGroup(scope, { ...input, ...mutation("thread.set_group", input) });
      };
      const inventory = () => current.inventory.getInventory(scope, threadId);
      current.inventory.transitionInventory(scope, threadId, {
        expectedRevision: inventory().inventoryRevision,
        mutationId: randomUUID(), change: { action: "archive" }, now: Date.now(),
      });
      const archivedRevision = inventory().inventoryRevision;
      const { groupId } = await create(" Design  ");
      await expect(create("design")).rejects.toMatchObject({ code: "group_name_conflict" });
      expect(groupAssignments.list(scope).map(({ name }) => name)).toEqual(["Design"]);
      await expect(setPin(true)).resolves.toEqual({ threadId, pinned: true });
      await expect(setPin(true)).resolves.toEqual({ threadId, pinned: true });
      expect(publishPin).toHaveBeenCalledTimes(1);
      expect(inventory()).toMatchObject({ pinRevision: 1, inventoryState: "archived", inventoryRevision: archivedRevision });
      await expect(setGroup(childId, groupId)).resolves.toEqual({ threadId: childId, groupId });
      await expect(setGroup(threadId, groupId)).resolves.toEqual({ threadId, groupId });
      expect(groupAssignments.getAssignment(scope, threadId).revision).toBe(1);
      await expect(setGroup(threadId, null)).resolves.toEqual({ threadId, groupId: null });
      await expect(setGroup(threadId, null)).resolves.toEqual({ threadId, groupId: null });
      expect(publishGroups).toHaveBeenCalledTimes(3);
      expect(groupAssignments.getAssignment(scope, threadId).revision).toBe(2);
      const group = groupAssignments.get(scope, groupId);
      groupAssignments.rename(scope, groupId, {
        name: "Ready", expectedRevision: group.revision, mutationId: randomUUID(), now: Date.now(),
      });
      await expect(setGroup(threadId, groupId)).resolves.toEqual({ threadId, groupId });
      const otherPrincipalId = randomUUID();
      const foreignGroupId = randomUUID();
      current.database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)")
        .run(scope.tenantId, otherPrincipalId);
      current.database.prepare(`
        INSERT INTO thread_groups(tenant_id, principal_id, id, name, name_key, created_at, updated_at)
        VALUES (?, ?, ?, 'Private', 'private', 0, 0)
      `).run(scope.tenantId, otherPrincipalId, foreignGroupId);
      await expect(setGroup(threadId, foreignGroupId)).rejects.toMatchObject({ code: "not_found" });
      expect(groupAssignments.getAssignment(scope, threadId)).toMatchObject({ groupId, revision: 3 });
      const renamed = groupAssignments.get(scope, groupId);
      groupAssignments.delete(scope, groupId, {
        expectedRevision: renamed.revision, expectedMemberCount: 2, mutationId: randomUUID(), now: Date.now(),
      });
      await expect(setGroup(threadId, groupId)).rejects.toMatchObject({ code: "not_found" });
      expect(groupAssignments.getAssignment(scope, threadId)).toMatchObject({ groupId: null, revision: 4 });
      await expect(setPin(false)).resolves.toEqual({ threadId, pinned: false });
      expect(inventory()).toMatchObject({ pinRevision: 2, inventoryState: "archived", inventoryRevision: archivedRevision });
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

  it("parks and moves open thread tasks atomically with replay publication", async () => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Follow up after parking",
        scope: { kind: "thread", threadId: current.rootId },
        mutationId: "park-task-create",
        now: 450,
      });
      const input = {
        expectedRevision: 0,
        mutationId: "park-with-task-disposition",
        openTaskDisposition: "move_to_project",
      } as const;

      await current.service.park(current.scope, current.rootId, input);
      expect(
        current.inventory.getInventory(current.scope, current.rootId),
      ).toMatchObject({
        inventoryState: "parked",
        inventoryRevision: 1,
      });
      const { projectId } = current.database
        .prepare(
          `SELECT location.project_id AS projectId
           FROM application_threads AS thread
           JOIN workspaces AS location ON location.id = thread.workspace_id
           WHERE thread.id = ?`,
        )
        .get(current.rootId) as { readonly projectId: string };
      expect(current.tasks.get(current.scope, task.id)).toMatchObject({
        scopeKind: "project",
        projectId,
        threadId: null,
        revision: 1,
      });
      expect(current.publishTaskChange).toHaveBeenCalledWith(
        current.scope,
        task.id,
      );

      await current.service.park(current.scope, current.rootId, input);
      expect(
        current.inventory.getInventory(current.scope, current.rootId)
          .inventoryRevision,
      ).toBe(1);
      expect(current.publishTaskChange).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("keeps isolated workspaces explicitly", async () => {
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
  });

  it("executes only an exact isolated workspace delete disposition", async () => {
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
      // Retained output no runtime could apply is not reported as activity.
      current.releaseProviderResidency.mockImplementation(async (_scope, threadId) => {
        if (threadId === current.grandchildId) throw new ThreadProviderOutputUndeliveredError();
      });
      await expect(
        current.service.archive(current.scope, current.rootId, {
          includeDescendants: true,
          expectedRevision: 0,
          mutationId: "archive-remote-undelivered",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      ).rejects.toMatchObject({ code: "invalid_transition", message: expect.stringContaining("Open the thread so its output is applied") });
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
    const archive = vi.fn(async () => undefined);
    const current = fixture({ archive });
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
      expect(archive).toHaveBeenCalledTimes(2);
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
      expect(archive).toHaveBeenCalledTimes(2);
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
        familySnapshot: expect.any(String),
        root: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
        descendants: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
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
          familySnapshot: expect.any(String),
          root: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
          descendants: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
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
        snapshot: expect.any(String),
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
          descendants: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
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
          familySnapshot: expect.any(String),
          root: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
          descendants: { snapshot: expect.any(String), items: [], total: 0, omitted: 0 },
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
          expectedMutationRevision: 0,
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

describe("reviewed lifecycle task completion", () => {
  it.each(["park", "archive", "archive_family"] as const)("%s completes only reviewed tasks in place and replays publication", async (action) => {
    const current = fixture();
    try {
      const rootTask = current.tasks.create(current.scope, {
        title: "Complete root", scope: { kind: "thread", threadId: current.rootId },
        mutationId: "complete-root-create", now: 450,
      });
      const childTask = current.tasks.create(current.scope, {
        title: "Complete child", scope: { kind: "thread", threadId: current.childId },
        mutationId: "complete-child-create", now: 451,
      });
      const globalTask = current.tasks.create(current.scope, {
        title: "Unrelated", scope: { kind: "global" }, mutationId: "global-create", now: 452,
      });
      const impact = await current.service.impact(current.scope, current.rootId);
      const input = {
        expectedRevision: 0, mutationId: "complete-lifecycle",
        openTaskDisposition: "complete" as const,
        expectedOpenTaskSnapshot: action === "archive_family" ? impact.openTasks.familySnapshot : impact.openTasks.root.snapshot,
      };
      const perform = () => action === "park"
        ? current.service.park(current.scope, current.rootId, input)
        : current.service.archive(current.scope, current.rootId, {
          ...input, includeDescendants: action === "archive_family", executionWorkspaceDisposition: { kind: "keep" },
        });
      current.publishTaskChange.mockRejectedValueOnce(new Error("publication interrupted"));
      await expect(perform()).rejects.toThrow("publication interrupted");
      expect(current.tasks.get(current.scope, rootTask.id)).toMatchObject({
        scopeKind: "thread", threadId: current.rootId, revision: 1, completedAt: 500, updatedAt: 500,
      });
      expect(current.tasks.get(current.scope, childTask.id)).toMatchObject({
        scopeKind: "thread", threadId: current.childId,
        revision: action === "archive_family" ? 1 : 0,
        completedAt: action === "archive_family" ? 500 : null,
      });
      expect(current.tasks.get(current.scope, globalTask.id).completedAt).toBeNull();
      await perform();
      expect(current.tasks.get(current.scope, rootTask.id).revision).toBe(1);
      expect(current.publishTaskChange).toHaveBeenCalledWith(current.scope, rootTask.id);
      // A different reviewed set cannot borrow an existing successful mutation ID.
      input.expectedOpenTaskSnapshot = "0".repeat(64);
      await expect(perform()).rejects.toMatchObject({ code: "conflict" });
    } finally { current.database.close(); }
  });

  it.each(["missing", "added", "replaced", "edited", "wrong-principal", "wrong-thread"] as const)("rejects %s review snapshots without inventory or task changes", async (kind) => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Review this", scope: { kind: "thread", threadId: current.rootId }, mutationId: "review-task", now: 450,
      });
      const impact = await current.service.impact(current.scope, current.rootId);
      let snapshot: string | undefined = impact.openTasks.root.snapshot;
      if (kind === "missing") snapshot = undefined;
      if (kind === "wrong-principal") snapshot = current.tasks.openThreadTaskSnapshot({ ...current.scope, principalId: "other-principal" }, [current.rootId]);
      if (kind === "wrong-thread") snapshot = impact.openTasks.descendants.snapshot;
      if (kind === "replaced") current.tasks.remove(current.scope, task.id);
      if (kind === "added" || kind === "replaced") current.tasks.create(current.scope, {
        title: "Unreviewed", scope: { kind: "thread", threadId: current.rootId }, mutationId: "new-task", now: 460,
      });
      if (kind === "edited") current.tasks.update(current.scope, task.id, {
        title: "Changed meaning", expectedRevision: 0, mutationId: "edit-task", now: 460,
      });
      await expect(current.service.park(current.scope, current.rootId, {
        expectedRevision: 0, mutationId: "stale-complete", openTaskDisposition: "complete", expectedOpenTaskSnapshot: snapshot,
      })).rejects.toMatchObject({ code: kind === "missing" ? "bad_request" : "conflict" });
      expect(current.inventory.getInventory(current.scope, current.rootId)).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      expect(current.tasks.listOpenThreadTaskSummaries(current.scope, [current.rootId], 100).total).toBe(kind === "added" ? 2 : 1);
      expect(current.publishTaskChange).not.toHaveBeenCalled();
    } finally { current.database.close(); }
  });

  it("requires confirmation even for zero tasks and excludes archived descendants", async () => {
    const current = fixture();
    try {
      await expect(current.service.park(current.scope, current.rootId, {
        expectedRevision: 0, mutationId: "empty-without-review", openTaskDisposition: "complete",
      })).rejects.toMatchObject({ code: "bad_request" });
      const retained = current.tasks.create(current.scope, {
        title: "Retain archived task", scope: { kind: "thread", threadId: current.childId },
        mutationId: "retained-task", now: 450,
      });
      await current.service.archive(current.scope, current.childId, {
        includeDescendants: false, expectedRevision: 0, mutationId: "archive-child-before-review",
        executionWorkspaceDisposition: { kind: "keep" },
      });
      const impact = await current.service.impact(current.scope, current.rootId);
      expect(impact.openTasks.root.total + impact.openTasks.descendants.total).toBe(0);
      await current.service.archive(current.scope, current.rootId, {
        includeDescendants: true, expectedRevision: 0, mutationId: "complete-empty-family",
        openTaskDisposition: "complete", expectedOpenTaskSnapshot: impact.openTasks.familySnapshot,
        executionWorkspaceDisposition: { kind: "keep" },
      });
      expect(current.tasks.get(current.scope, retained.id)).toMatchObject({ completedAt: null, revision: 0 });
      expect(current.inventory.getInventory(current.scope, current.rootId).inventoryState).toBe("archived");
    } finally { current.database.close(); }
  });

  it("fences omitted tasks and retries after an atomic rollback", async () => {
    const current = fixture();
    try {
      const tasks = Array.from({ length: 101 }, (_, index) => current.tasks.create(current.scope, {
        title: `Task ${index}`, scope: { kind: "thread" as const, threadId: current.rootId }, mutationId: `many-${index}`, now: 350 + index,
      }));
      const impact = await current.service.impact(current.scope, current.rootId);
      expect(impact.openTasks.root.omitted).toBe(1);
      const omittedTask = tasks[100]!;
      current.tasks.update(current.scope, omittedTask.id, {
        details: "Unseen edit", expectedRevision: 0, mutationId: "edit-omitted", now: 490,
      });
      const input = {
        expectedRevision: 0, mutationId: "complete-many", openTaskDisposition: "complete" as const,
        expectedOpenTaskSnapshot: impact.openTasks.familySnapshot, includeDescendants: true,
        executionWorkspaceDisposition: { kind: "keep" as const },
      };
      await expect(current.service.archive(current.scope, current.rootId, input)).rejects.toMatchObject({ code: "conflict" });
      input.expectedOpenTaskSnapshot = (await current.service.impact(current.scope, current.rootId)).openTasks.familySnapshot;
      const original = current.tasks.applyOpenThreadTaskDisposition.bind(current.tasks);
      const apply = vi.spyOn(current.tasks, "applyOpenThreadTaskDisposition").mockImplementationOnce((...args) => {
        original(...args); throw new Error("task write interrupted");
      });
      await expect(current.service.archive(current.scope, current.rootId, input)).rejects.toThrow("task write interrupted");
      expect(current.tasks.get(current.scope, tasks[0]!.id).completedAt).toBeNull();
      for (const id of [current.rootId, current.childId, current.grandchildId]) expect(current.inventory.getInventory(current.scope, id).inventoryState).toBe("active");
      apply.mockRestore();
      await current.service.archive(current.scope, current.rootId, input);
      expect(current.tasks.listOpenThreadTaskSummaries(current.scope, [current.rootId], 100).total).toBe(0);
      expect(current.tasks.get(current.scope, omittedTask.id)).toMatchObject({ completedAt: 500, revision: 2 });
    } finally { current.database.close(); }
  });
});
