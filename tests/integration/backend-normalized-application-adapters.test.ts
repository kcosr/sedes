import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../../src/server/backends/contracts.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { InMemoryConformanceDriver } from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import { PiThreadPresentationProvider } from "../../src/server/backends/pi/pi-thread-presentation-provider.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { ApplicationSnapshotPublicationBoundary, ApplicationSnapshotService } from "../../src/server/application/application-snapshot-service.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import {
  DatabaseApplicationThreadSummaryReader,
  MAXIMUM_APPLICATION_BOOTSTRAP_FORKS,
} from "../../src/server/application/database-application-summary-reader.js";
import { DatabaseApplicationLineageSummaryReader } from "../../src/server/application/database-application-lineage-summary-reader.js";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
} from "../../src/server/conversations/backend-discovery-service.js";
import {
  DatabaseActorTargetResolver,
  DatabaseConversationTargetStore,
  DatabaseLifecycleTargetResolver,
  DatabaseThreadApplicationQueueReader,
  DatabaseThreadApplicationRecoveryReader,
} from "../../src/server/conversations/database-conversation-adapters.js";
import {
  DatabaseThreadApplicationInventoryReader,
  DatabaseThreadApplicationPresentationReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { ConversationTurnBookmarkRepository } from "../../src/server/db/repositories/conversation-turn-bookmark-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadBulkInventoryService } from "../../src/server/domain/thread-bulk-inventory-service.js";
import { ThreadGroupService } from "../../src/server/domain/thread-group-service.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import type { ConversationActorListener } from "../../src/server/conversations/conversation-actor.js";
import type { DriverInteraction } from "../../src/shared/protocol/backend.js";
import {
  backendInteractionSchema,
  type BackendInteraction,
} from "../../src/shared/protocol/conversation.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import type { executeNotificationScript } from "../../src/server/runtime/notification-script-executor.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { ThreadAttentionService } from "../../src/server/domain/thread-attention-service.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";
import type {
  ExecutionEnvironmentProvider,
  ValidatedWorkspace,
} from "../../src/server/execution/contracts.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

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
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture(latestMigration = Number.POSITIVE_INFINITY): {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly connectionProfileId: string;
  readonly backendConfigurationRevision: number;
} {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacyInventory = new ThreadInventoryService(
    new OverlayRepository(database),
  );
  const environment = legacyInventory.getLocalEnvironment(scope);
  const workspace = legacyInventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp",
      displayName: "Temporary workspace",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const thread = legacyInventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Normalized thread" },
    200,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= latestMigration));
  const backendConfiguration = new BackendConfigurationRepository(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "normalized-application-adapters" }, 400);
  new InventoryRepository(database).updateEnvironmentAvailability(scope, environment.id, { available: true, now: 400 });
  const backend = backendConfiguration.getBackend(scope, "pi-primary");
  const profile = database
    .prepare(
      `
        SELECT id
        FROM agent_connection_profiles
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND template_id = 'local-primary'
      `,
    )
    .get(scope.tenantId, scope.principalId) as { readonly id: string };
  return {
    database,
    scope,
    threadId: thread.thread.id,
    workspaceId: workspace.id,
    environmentId: environment.id,
    connectionProfileId: profile.id,
    backendConfigurationRevision: backend.configurationRevision,
  };
}

function captureFixture(current: ReturnType<typeof fixture>) {
  const inventory = new InventoryRepository(current.database);
  const groups = new ThreadGroupRepository(current.database);
  const tasks = new TaskRepository(current.database);
  const summaries = new DatabaseApplicationThreadSummaryReader({
    inventory,
    queue: new QueuedInputRepository(current.database),
    completion: new SubmissionCompletionRepository(current.database),
  });
  const application = new ApplicationSnapshotService(
    inventory, summaries,
    { captureLoadedState: async () => undefined },
    {
      read: async () => ({
        executionTargets: [{
          id: current.connectionProfileId, environmentId: current.environmentId,
          label: { text: "Local Pi SDK" }, backend: { label: { text: "Primary Pi" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" }, available: true,
        }],
        defaultTargetId: current.connectionProfileId,
      }),
      requireSelectable: async () => undefined,
    },
    new DatabaseApplicationLineageSummaryReader(new ThreadLineageRepository(current.database)),
    tasks, groups, () => "unavailable", { summariesByThread: () => new Map() },
  );
  const boundary = new ApplicationSnapshotPublicationBoundary(application, new ScopedApplicationEventHubs());
  const inventoryService = new InventoryService(inventory, {
    async publishMany(scope, states) {
      const ids = states.map(({ threadId }) => threadId);
      boundary.handoffStructuralThreadChanges(scope, ids);
      await Promise.all(ids.map(id => boundary.publishThreadChange(scope, id)));
    },
    publishApplicationThread: (scope, id) => boundary.publishThreadChange(scope, id),
  });
  return { inventory, groups, tasks, summaries, application, boundary, inventoryService };
}

describe("backend-normalized application adapters", () => {
  it("publishes durable copy-only backend IDs without runtime attachment", async () => {
    const current = fixture();
    const { summaries, application, boundary } = captureFixture(current);
    try {
      const hub = boundary.hub(current.scope);
      const published: string[] = [];
      hub.subscribe(({ event }) => published.push(event.type));
      await boundary.checkpoint(current.scope, hub);
      expect(summaries.listByIds(current.scope, [current.threadId])[0]).not.toHaveProperty("backendSessionId");
      const bindings = new ConversationBindingRepository(current.database);
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "opaque-backend-session", now: 500,
      });
      await boundary.publishThreadChange(current.scope, current.threadId);
      await boundary.flush();
      expect(published).toEqual(["snapshot", "thread_upsert"]);
      const expected = { backendSessionId: "opaque-backend-session", backend: { brand: "pi" } };
      expect(summaries.listByIds(current.scope, [current.threadId])[0]).toMatchObject(expected);
      expect(summaries.list(current.scope, current.environmentId).find(thread => thread.id === current.threadId)).toMatchObject(expected);
      expect(hub.currentCheckpoint()?.event.snapshot.threads.find(thread => thread.id === current.threadId)).toMatchObject(expected);
      expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
      for (const scope of [
        { ...current.scope, principalId: "foreign-principal" },
        { ...current.scope, tenantId: "foreign-tenant" },
      ]) {
        expect(summaries.listByIds(scope, [current.threadId])).toEqual([]);
        expect(summaries.list(scope, current.environmentId)).toEqual([]);
      }
    } finally {
      await boundary.close();
      current.database.close();
    }
  });

  it("keeps real Group counts equal to capture through single and bulk inventory changes", async () => {
    const current = fixture();
    const projection = captureFixture(current);
    const { groups, inventory, inventoryService, application, boundary } = projection;
    try {
      const bindings = new ConversationBindingRepository(current.database);
      const other = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId, connectionProfileId: current.connectionProfileId,
        title: "Second grouped thread", now: 500,
      });
      const ids = [current.threadId, other.id];
      for (const [index, id] of ids.entries()) bindings.bindDiscoveredConversation(current.scope, id, {
        backendConversationId: `group-inventory-native-${index}`, now: 600 + index,
      });
      const group = groups.createAndAssign(current.scope, current.threadId, {
        name: "Inventory group", expectedRevision: 0, mutationId: "create-inventory-group", now: 700,
      });
      groups.assign(current.scope, other.id, {
        groupId: group.groupId, expectedRevision: 0, mutationId: "assign-second-group-member", now: 701,
      });
      const hub = boundary.hub(current.scope);
      const events: string[] = [];
      hub.subscribe(({ event }) => events.push(event.type));
      await boundary.checkpoint(current.scope, hub);
      const assertCurrent = async (activeMemberCount: number) => {
        await boundary.flush();
        const snapshot = hub.currentCheckpoint()!.event.snapshot;
        expect(snapshot).toEqual(await application.capture(current.scope));
        expect(snapshot.groups).toEqual([expect.objectContaining({
          id: group.groupId, memberCount: 2, activeMemberCount,
        })]);
      };
      await assertCurrent(2);
      for (const [index, action] of (["archive", "restore"] as const).entries()) {
        const before = events.length;
        await inventoryService.transition(current.scope, current.threadId, {
          expectedRevision: inventory.getInventory(current.scope, current.threadId).inventoryRevision,
          mutationId: `single-group-${action}`, change: { action },
        }, 800 + index);
        await assertCurrent(action === "archive" ? 1 : 2);
        expect(events.slice(before)).toEqual(["snapshot"]);
      }
      const bulk = new ThreadBulkInventoryService({
        inventory, summaries: projection.summaries,
        runtimes: {
          captureLoadedState: async () => undefined,
          async runWithRuntimeRetired(_scope, _id, operation) { return operation(); },
          async releaseProviderResidency() {},
        },
        publications: inventoryService, tasks: projection.tasks,
        taskPublications: boundary, now: () => 900,
      });
      const impact = await bulk.impact(current.scope, { action: "archive", threadIds: ids });
      const beforeBulk = events.length;
      await bulk.transition(current.scope, {
        action: "archive", targets: impact.targets, mutationId: "bulk-group-archive",
        expectedStashedPromptCount: 0, expectedOpenTaskCount: 0,
      });
      await assertCurrent(0);
      expect(events.slice(beforeBulk)).toEqual(["snapshot"]);
      // Restore is an individual inventory action, not a supported bulk API.
      // Admit both real restores together to exercise their scoped batch lane.
      await Promise.all(ids.map(id => inventoryService.transition(current.scope, id, {
        expectedRevision: inventory.getInventory(current.scope, id).inventoryRevision,
        mutationId: `restore-group-batch-${id}`, change: { action: "restore" },
      }, 1_000)));
      await assertCurrent(2);
    } finally {
      await boundary.close();
      current.database.close();
    }
  });

  it("keeps pin changes incremental when every committed fork fits the selection", async () => {
    const current = fixture();
    const { inventory, application, boundary } = captureFixture(current);
    try {
      const bindings = new ConversationBindingRepository(current.database);
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "unsaturated-source", now: 500,
      });
      const child = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId, connectionProfileId: current.connectionProfileId,
        title: "Unsaturated fork", now: 600,
      });
      bindings.bindDiscoveredConversation(current.scope, child.id, { backendConversationId: "unsaturated-child", now: 600 });
      new ThreadLineageRepository(current.database).recordImportedNativeOrigin(current.scope, {
        childThreadId: child.id, providerParentBackendConversationId: "unsaturated-source",
        sourceThreadId: current.threadId, sourceTurnState: "unresolved", branchMethod: "provider_native", now: 600,
      });
      const capture = vi.spyOn(application, "capture");
      const hub = boundary.hub(current.scope);
      const events: string[] = [];
      hub.subscribe(({ event }) => events.push(event.type));
      await boundary.checkpoint(current.scope, hub);
      inventory.setThreadPinned(current.scope, child.id, {
        pinned: true, expectedRevision: 0, mutationId: "pin-unsaturated-fork", now: 700,
      });
      await boundary.publishThreadChange(current.scope, child.id);
      await boundary.flush();
      expect(events).toEqual(["snapshot", "thread_upsert"]);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
    } finally {
      await boundary.close();
      current.database.close();
    }
  });

  it("reads scoped fork structure and recaptures omitted children and saturated source changes", async () => {
    const current = fixture();
    try {
      const bindings = new ConversationBindingRepository(current.database);
      const lineage = new ThreadLineageRepository(current.database);
      const summaries = new DatabaseApplicationThreadSummaryReader({
        inventory: new InventoryRepository(current.database),
        queue: new QueuedInputRepository(current.database),
        completion: new SubmissionCompletionRepository(current.database),
      });
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "structure-source",
        now: 400,
      });
      expect(summaries.structure(current.scope, current.threadId)).toEqual({
        environmentId: current.environmentId,
        isFork: false,
        isForkSource: false,
      });
      expect(summaries.structure(current.scope, "missing-thread")).toBeUndefined();
      expect(summaries.forkSelectionSaturated(current.scope, current.environmentId)).toBe(false);
      const otherSource = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: current.connectionProfileId,
        title: "Other fork source",
        now: 500,
      });
      bindings.bindDiscoveredConversation(current.scope, otherSource.id, {
        backendConversationId: "other-structure-source", now: 500,
      });
      const addFork = (index: number) => {
        const child = bindings.createUnboundThread(current.scope, {
          id: `structure-child-${index.toString().padStart(4, "0")}`,
          workspaceId: current.workspaceId,
          connectionProfileId: current.connectionProfileId,
          title: `Structure child ${index}`,
          now: 1_000 + index,
        });
        bindings.bindDiscoveredConversation(current.scope, child.id, {
          backendConversationId: `structure-native-child-${index}`,
          now: 1_000 + index,
        });
        lineage.recordImportedNativeOrigin(current.scope, {
          childThreadId: child.id,
          providerParentBackendConversationId: index === 0 ? "structure-source" : "other-structure-source",
          sourceThreadId: index === 0 ? current.threadId : otherSource.id,
          sourceTurnState: "unresolved",
          branchMethod: "provider_native",
          now: 1_000 + index,
        });
      };
      current.database.transaction(() => {
        for (let index = 0; index < MAXIMUM_APPLICATION_BOOTSTRAP_FORKS; index += 1) {
          addFork(index);
        }
      }).immediate();
      expect(summaries.forkSelectionSaturated(current.scope, current.environmentId)).toBe(false);
      addFork(MAXIMUM_APPLICATION_BOOTSTRAP_FORKS);
      expect(summaries.forkSelectionSaturated(current.scope, current.environmentId)).toBe(true);
      expect(summaries.forkSelectionSaturated(current.scope, "another-environment")).toBe(false);
      const selected = summaries.list(current.scope, current.environmentId);
      expect(selected.some(({ id }) => id === "structure-child-0000")).toBe(false);
      expect(summaries.structure(current.scope, "structure-child-0000")).toEqual({
        environmentId: current.environmentId,
        isFork: true,
        isForkSource: false,
      });
      expect(summaries.structure(current.scope, current.threadId)).toEqual({
        environmentId: current.environmentId,
        isFork: false,
        isForkSource: true,
      });
      for (const scope of [
        { ...current.scope, principalId: "foreign-principal" },
        { ...current.scope, tenantId: "foreign-tenant" },
      ]) {
        expect(summaries.forkSelectionSaturated(scope, current.environmentId)).toBe(false);
        expect(summaries.structure(scope, current.threadId)).toBeUndefined();
        expect(summaries.structure(scope, "structure-child-0000")).toBeUndefined();
      }

      const { inventory, groups, application, boundary } = captureFixture(current);
      const hub = boundary.hub(current.scope);
      const published: string[] = [];
      hub.subscribe(({ event }) => published.push(event.type));
      try {
        await boundary.checkpoint(current.scope, hub);
        expect(hub.currentCheckpoint()?.event.snapshot.threads.some(({ id }) => id === "structure-child-0000")).toBe(false);
        inventory.setThreadPinned(current.scope, "structure-child-0000", {
          pinned: true, expectedRevision: 0, mutationId: "select-omitted-fork", now: 4_000,
        });
        await boundary.publishThreadChange(current.scope, "structure-child-0000");
        await boundary.flush();
        expect(published).toEqual(["snapshot", "snapshot"]);
        expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
        expect(hub.currentCheckpoint()?.event.snapshot.forkOrigins.some(({ childThreadId }) => childThreadId === "structure-child-0000")).toBe(true);

        // Return the oldest child to omitted status, then change its source's
        // state. Durable source facts must include that hidden child.
        inventory.setThreadPinned(current.scope, "structure-child-0000", {
          pinned: false, expectedRevision: 1, mutationId: "omit-old-fork-again", now: 4_001,
        });
        await boundary.publishThreadChange(current.scope, "structure-child-0000");
        await boundary.flush();
        expect(hub.currentCheckpoint()?.event.snapshot.threads.some(({ id }) => id === "structure-child-0000")).toBe(false);
        await new InventoryService(inventory, { publishMany() {}, publishApplicationThread() {} }).transition(
          current.scope, current.threadId,
          { expectedRevision: 0, mutationId: "archive-saturated-source", change: { action: "archive" } },
          4_002,
        );
        await boundary.publishThreadChange(current.scope, current.threadId);
        await boundary.flush();
        expect(published).toEqual(["snapshot", "snapshot", "snapshot", "snapshot"]);
        expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
        expect(hub.currentCheckpoint()?.event.snapshot.threads.some(({ id }) => id === "structure-child-0000")).toBe(true);

        await new InventoryService(inventory, { publishMany() {}, publishApplicationThread() {} }).transition(
          current.scope, current.threadId,
          { expectedRevision: 1, mutationId: "restore-saturated-source", change: { action: "restore" } }, 4_003,
        );
        await boundary.publishThreadChange(current.scope, current.threadId);
        await boundary.flush();
        expect(hub.currentCheckpoint()?.event.snapshot.threads.some(({ id }) => id === "structure-child-0000")).toBe(false);
        const groupService = new ThreadGroupService(groups, boundary);
        const group = await groupService.updateAssignment(current.scope, "structure-child-0000", {
          action: "create", name: "Retained forks", expectedRevision: 0, mutationId: "group-omitted-fork",
        }, 4_004);
        await boundary.flush();
        expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
        expect(hub.currentCheckpoint()?.event.snapshot.threads.find(({ id }) => id === "structure-child-0000")?.groupId).toBe(group.groupId);
        await groupService.updateAssignment(current.scope, "structure-child-0000", {
          action: "remove", expectedRevision: 1, mutationId: "ungroup-old-fork",
        }, 4_005);
        await boundary.flush();
        expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
        expect(hub.currentCheckpoint()?.event.snapshot.threads.some(({ id }) => id === "structure-child-0000")).toBe(false);

        const selectedIds = hub.currentCheckpoint()!.event.snapshot.threads.map(({ id }) => id);
        const beforeRankingChange = published.length;
        inventory.markDiscoveredAvailable(current.scope, "structure-child-0001", { updatedAt: 9_000, now: 9_000 });
        await boundary.publishThreadChange(current.scope, "structure-child-0001");
        await boundary.flush();
        expect(published.slice(beforeRankingChange)).toEqual(["thread_upsert"]);
        const stable = hub.currentCheckpoint()!.event.snapshot;
        expect(stable.threads.map(({ id }) => id)).toEqual(selectedIds);
        const latest = await application.capture(current.scope);
        expect(Object.fromEntries(stable.threads.map(thread => [thread.id, thread])))
          .toEqual(Object.fromEntries(latest.threads.map(thread => [thread.id, thread])));
        expect(stable.threads.map(({ id }) => id)).not.toEqual(latest.threads.map(({ id }) => id));
        await boundary.publishAuthoritativeReplacement(current.scope);
        await boundary.flush();
        expect(hub.currentCheckpoint()?.event.snapshot).toEqual(await application.capture(current.scope));
      } finally {
        await boundary.close();
      }
    } finally {
      current.database.close();
    }
  }, 15_000);

  it("keeps targeted queue and completion summaries exact across active, retained and acknowledged records", () => {
    const current = fixture();
    try {
      const bindings = new ConversationBindingRepository(current.database);
      const other = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId, connectionProfileId: current.connectionProfileId,
        title: "Unrelated summary", now: 400,
      });
      bindings.bindDiscoveredConversation(current.scope, current.threadId, { backendConversationId: "targeted-summary-native", now: 400 });
      bindings.bindDiscoveredConversation(current.scope, other.id, { backendConversationId: "other-summary-native", now: 400 });
      const inventory = new InventoryRepository(current.database);
      const queue = new QueuedInputRepository(current.database);
      const completion = new SubmissionCompletionRepository(current.database);
      const summaries = new DatabaseApplicationThreadSummaryReader({ inventory, queue, completion });
      const insert = current.database.prepare(`
        INSERT INTO queued_inputs(tenant_id, owner_principal_id, id, application_thread_id,
          sequence, mutation_id, text, state, created_at, dispatch_started_at, accepted_at,
          resolved_at, reconciliation_token, retry_anchor, next_attempt_at, diagnostic, failure_acknowledged_at, delivery_mode)
        VALUES (@tenant, @principal, @id, @thread, @sequence, @id, 'fixture input', @state, 500,
          @dispatch, @accepted, @resolved, @reconciliation, @anchor, @next, @diagnostic, @acknowledged, @delivery)
      `);
      const add = (thread: string, state: string, sequence: number, acknowledged = false) => {
        const id = `${thread}-queue-${sequence}`;
        const inFlight = state === "dispatching" || state === "uncertain";
        insert.run({ tenant: current.scope.tenantId, principal: current.scope.principalId, id, thread, sequence, state,
          dispatch: inFlight || state === "accepted" ? 510 : null, accepted: state === "accepted" ? 520 : null,
          resolved: ["accepted", "failed", "cancelled"].includes(state) ? 530 : null,
          reconciliation: inFlight ? `reconciliation-${sequence}` : null, anchor: inFlight ? "fixture-anchor" : null,
          next: state === "retry_wait" ? 540 : null, diagnostic: state === "failed" ? "fixture_failure" : null,
          acknowledged: acknowledged ? 550 : null, delivery: inFlight ? "submit" : null });
        return id;
      };
      const active = ["pending", "retry_wait", "dispatching", "uncertain", "failed"];
      current.database.transaction(() => {
        active.forEach((state, index) => add(current.threadId, state, index + 1));
        add(current.threadId, "failed", 6, true);
        add(current.threadId, "accepted", 7);
        add(current.threadId, "cancelled", 8);
        // Retained delivery history must not increase the sidebar's actionable
        // queue count or make a targeted update scan thousands of old records.
        for (let index = 9; index < 2009; index++) add(current.threadId, index % 2 ? "accepted" : "failed", index, index % 2 === 0);
        active.forEach((state, index) => add(other.id, state, index + 1));
      })();
      const observe = (thread: string, operationId: string, createAttention: boolean, at: number) => {
        completion.recordAccepted(current.scope, thread, { operationId, acceptedAt: at });
        completion.observeCompletion(current.scope, thread, operationId, { completionIdentity: `${operationId}-terminal`, observedAt: at + 1, createAttention });
      };
      completion.recordAccepted(current.scope, current.threadId, { operationId: "still-running", acceptedAt: 600 });
      observe(current.threadId, "observed-without-attention", false, 610);
      observe(current.threadId, "acknowledged-completion", true, 620);
      completion.acknowledgeThrough(current.scope, current.threadId, "acknowledged-completion", 630);
      observe(other.id, "other-unseen-completion", true, 640);
      const read = () => summaries.listByIds(current.scope, [current.threadId]);
      expect(read()).toHaveLength(1);
      expect(read()[0]).toMatchObject({ queuedInputCount: 5, attention: { queueFailure: true, unseenCompletion: false } });
      observe(current.threadId, "unseen-completion", true, 650);
      const wanted = read();
      expect(wanted[0]).toMatchObject({ queuedInputCount: 5, attention: { queueFailure: true, unseenCompletion: true } });
      expect(summaries.listByIds(current.scope, [current.threadId, current.threadId, current.threadId])).toEqual(wanted);
      expect(summaries.listByIds(current.scope, Array(100).fill(current.threadId))).toEqual(wanted);
      expect(() => summaries.listByIds(current.scope, Array(101).fill(current.threadId))).toThrow("application_summary_page_too_large");
      expect(summaries.listByIds({ ...current.scope, principalId: "another-principal" }, [current.threadId, other.id])).toEqual([]);
      expect(summaries.listByIds({ ...current.scope, tenantId: "another-tenant" }, [current.threadId, other.id])).toEqual([]);
      expect(summaries.listByIds(current.scope, ["missing-thread"])).toEqual([]);
      queue.acknowledgeFailure(current.scope, current.threadId, `${current.threadId}-queue-5`, 700);
      completion.acknowledgeThrough(current.scope, current.threadId, "unseen-completion", 710);
      expect(read()[0]).toMatchObject({ queuedInputCount: 4, attention: { queueFailure: false, unseenCompletion: false } });
      expect(summaries.listByIds(current.scope, [other.id])[0]).toMatchObject({ queuedInputCount: 5, attention: { queueFailure: true, unseenCompletion: true } });

      const captured: { sql: string; parameters: unknown[] }[] = [];
      const originalPrepare = current.database.prepare.bind(current.database);
      const prepare = vi.spyOn(current.database, "prepare").mockImplementation(sql => {
        const statement = originalPrepare(sql);
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
          captured.push({ sql, parameters });
          return all(...parameters);
        });
        return statement;
      });
      try {
        const targeted = read();
        const bootstrap = summaries.list(current.scope, current.environmentId);
        expect(bootstrap.find(row => row.id === current.threadId)).toEqual(targeted[0]);
        expect(bootstrap.map(row => row.id)).toContain(other.id);
      } finally { prepare.mockRestore(); }
      expect(captured).toHaveLength(2);
      for (const query of captured) {
        const plan = current.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters) as { detail: string }[];
        expect(plan.map(row => row.detail)).toEqual(expect.arrayContaining([
          expect.stringMatching(/SEARCH queue USING (?:COVERING )?INDEX queued_inputs_application_summary \(tenant_id=\? AND owner_principal_id=\? AND application_thread_id=\?/u),
          expect.stringMatching(/SEARCH completion USING (?:COVERING )?INDEX submission_completion_application_summary \(tenant_id=\? AND owner_principal_id=\? AND application_thread_id=\?/u),
          expect.stringMatching(/SEARCH thread USING (?:COVERING )?INDEX \S+ \(tenant_id=\? AND (?:owner_principal_id=\? AND )?id=\?/u),
        ]));
        expect(plan.some(row => /^SCAN (?:thread|queue|completion)(?: |$)/u.test(row.detail))).toBe(false);
      }
    } finally { current.database.close(); }
  });

  it("upgrades real schema 97 delivery records without changing their state or attention", () => {
    const current = fixture(97);
    try {
      const completion = new SubmissionCompletionRepository(current.database);
      // Seed the historical schema directly: current repositories require current columns.
      current.database.prepare(`INSERT INTO submission_completion_observations(
        tenant_id, owner_principal_id, application_thread_id, operation_id,
        accepted_at, last_completion_identity, completion_observed_at, attention_created_at)
        VALUES (?, ?, ?, 'retained-before-upgrade', 500, 'retained-terminal', 510, 510)`)
        .run(current.scope.tenantId, current.scope.principalId, current.threadId);
      current.database.prepare(`INSERT INTO queued_inputs(tenant_id, owner_principal_id, id,
        application_thread_id, sequence, mutation_id, text, state, created_at, resolved_at, diagnostic)
        VALUES (?, ?, 'pre-upgrade-failure', ?, 1, 'pre-upgrade-mutation', 'retained input', 'failed', 500, 510, 'fixture_failure')`)
        .run(current.scope.tenantId, current.scope.principalId, current.threadId);
      const beforeQueue = current.database.prepare("SELECT * FROM queued_inputs").all();
      const migratedQueue = beforeQueue.map((row) => {
        const { requested_steer_turn_id, resolved_steer_turn_id, ...retained } = row as Record<string, unknown>;
        return { ...retained,
          requested_steer_target_json: requested_steer_turn_id === null ? null : JSON.stringify({ kind: "turn", turnId: requested_steer_turn_id }),
          resolved_steer_target_json: resolved_steer_turn_id === null ? null : JSON.stringify({ kind: "turn", turnId: resolved_steer_turn_id }),
        };
      });
      const beforeCompletion = current.database.prepare("SELECT * FROM submission_completion_observations").all();
      expect(current.database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: 97 });
      applyDatabaseMigrations(current.database, backendNormalizedMigrations.filter(migration => migration.version <= 98));
      expect(current.database.prepare("SELECT version, name FROM schema_migrations WHERE version = 98").get()).toEqual({ version: 98, name: "application_summary_active_indexes" });
      expect(current.database.prepare("SELECT * FROM queued_inputs").all()).toEqual(beforeQueue);
      expect(current.database.prepare("SELECT * FROM submission_completion_observations").all()).toEqual(beforeCompletion);
      expect(current.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(current.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('queued_inputs_application_summary', 'submission_completion_application_summary') ORDER BY name").all())
        .toEqual([{ name: "queued_inputs_application_summary" }, { name: "submission_completion_application_summary" }]);
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      expect(current.database.prepare("SELECT * FROM queued_inputs").all()).toEqual(migratedQueue);
      expect(current.database.prepare("SELECT * FROM submission_completion_observations").all()).toEqual(
        beforeCompletion.map((row) => ({ ...row as Record<string, unknown>, classified_result_json: null })),
      );
      const summaries = new DatabaseApplicationThreadSummaryReader({ inventory: new InventoryRepository(current.database), queue: new QueuedInputRepository(current.database), completion });
      expect(summaries.listByIds(current.scope, [current.threadId])[0]).toMatchObject({ queuedInputCount: 1, attention: { queueFailure: true, unseenCompletion: true } });
    } finally { current.database.close(); }
  });

  it("projects principal-scoped remaining question counts across partial answers, dismissal and archival", () => {
    const current = fixture();
    try {
      const inventory = new InventoryRepository(current.database);
      const questions = new QuestionRequestRepository(current.database, inventory);
      const summaries = new DatabaseApplicationThreadSummaryReader({
        inventory,
        queue: new QueuedInputRepository(current.database),
        completion: new SubmissionCompletionRepository(current.database),
      });
      const count = () => summaries
        .list(current.scope, current.environmentId)
        .find(({ id }) => id === current.threadId)?.pendingQuestionCount;
      expect(count()).toBe(0);
      const request = questions.admit(
        current.scope, current.threadId, "question-source", {
        questions: [
          { title: "Where?", options: ["Desk"] },
          { title: "Which color?", options: ["White"] },
        ],
      }, 1000)!;
      expect(count()).toBe(2);
      expect(summaries.list(
        { ...current.scope, principalId: "another-principal" }, current.environmentId,
      )).toEqual([]);
      questions.resolveAnswers(current.scope, current.threadId, request.id, request.revision, [0]);
      expect(count()).toBe(1);
      current.database.prepare("UPDATE thread_principal_state SET inventory_state = 'archived' WHERE thread_id = ?").run(current.threadId);
      expect(summaries.listByIds(current.scope, [current.threadId])[0]?.pendingQuestionCount).toBe(1);
      const remaining = questions.get(current.scope, current.threadId, request.id)!;
      questions.dismiss(current.scope, current.threadId, request.id, remaining.revision);
      expect(summaries.listByIds(current.scope, [current.threadId])[0]?.pendingQuestionCount).toBe(0);
    } finally {
      current.database.close();
    }
  });

  it("finishes discovery only within the scanned connection namespace", () => {
    const current = fixture();
    try {
      const now = 500;
      current.database
        .prepare(
          `
            INSERT INTO agent_connection_profiles(
              tenant_id, owner_principal_id, id, template_id,
              backend_instance_id, backend_kind, execution_environment_id,
              kind, label, enabled, configuration_revision, created_at,
              updated_at
            )
            SELECT
              tenant_id, owner_principal_id, 'secondary-profile', 'secondary',
              backend_instance_id, backend_kind, execution_environment_id,
              kind, 'Secondary', enabled, configuration_revision, ?, ?
            FROM agent_connection_profiles
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          now,
          now,
          current.scope.tenantId,
          current.scope.principalId,
          current.connectionProfileId,
        );
      const bindings = new ConversationBindingRepository(current.database);
      const first = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: current.connectionProfileId,
        title: "First namespace",
        now,
      });
      bindings.bindDiscoveredConversation(current.scope, first.id, {
        backendConversationId: "native-first",
        now,
      });
      const second = bindings.createUnboundThread(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: "secondary-profile",
        title: "Second namespace",
        now,
      });
      bindings.bindDiscoveredConversation(current.scope, second.id, {
        backendConversationId: "native-second",
        now,
      });
      const inventory = new InventoryRepository(current.database);

      inventory.finishDiscovery(
        current.scope,
        current.environmentId,
        current.workspaceId,
        "pi-primary",
        [current.connectionProfileId],
        new Set(["native-first"]),
        now + 1,
      );

      expect(
        inventory.getThread(current.scope, second.id).thread.availability,
      ).toBe("available");
      expect(
        inventory.getThread(current.scope, first.id).thread.availability,
      ).toBe("available");
    } finally {
      current.database.close();
    }
  });

  it("discovers and imports conversations only within the added workspace", async () => {
    const current = fixture();
    try {
      const instance: AgentBackendInstance = {
        id: "pi-primary",
        tenantId: current.scope.tenantId,
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        configurationRevision: current.backendConfigurationRevision,
        protocolRelease: "0.86.0",
      };
      const connection: AgentConnectionProfile = {
        id: current.connectionProfileId,
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        templateId: "local-primary",
        kind: "pi_sdk",
        backendInstanceId: instance.id,
        executionEnvironmentId: current.environmentId,
        label: "Local Pi",
        enabled: true,
        configurationRevision: 0,
      };
      const environment = new LocalExecutionEnvironment({
        environmentId: current.environmentId,
        scope: current.scope,
        allowedRoots: ["/tmp"],
        workspaceTrusted: () => true,
        configurationRevision: 0,
        activeConfigurationRevision: () => 0,
      });
      const workspace = await environment.revalidateWorkspace(current.scope, {
        canonicalPath: "/tmp",
        authorityRevision: 0,
        summary: {
          id: current.workspaceId,
          environmentId: current.environmentId,
          displayName: "Temporary workspace",
          displayPath: "/tmp",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
      });
      const driver = new InMemoryConformanceDriver({
        instance,
        connection,
        now: () => "2026-07-30T12:00:00.000Z",
      });
      await driver.create({
        scope: current.scope,
        workspace,
        applicationThreadId: "seed-discovery",
        applicationOperationId: "seed-discovery",
        source: { kind: "user" },
        requestedBackendConversationId: "discovered-conversation",
        title: "Discovered conversation",
      });
      const registry = new AgentBackendRegistry();
      registry.register({
        scope: current.scope,
        instance,
        connectionKinds: [connection.kind],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create: () => driver,
      });
      const bindings = new ConversationBindingRepository(current.database);
      const inventory = new InventoryRepository(current.database);
      const targets = new DatabaseConversationTargetStore({
        database: current.database,
        bindings,
        bindingDetails: new Map(),
        registry,
        environments: environment,
      });
      targets.bindWorkspacePublications({
        handoffAuthoritativeReplacement: () => undefined,
      });
      let rejectedBindingDetail: string | undefined;
      const persistence = {
        database: current.database,
        initializeThread: () => undefined,
        saveBoundBindingDetail: (
          _scope: unknown,
          _applicationThreadId: string,
          opaqueBindingDetail: string,
        ) => {
          if (opaqueBindingDetail === rejectedBindingDetail) {
            throw new DomainError(
              "conflict",
              "native binding evidence conflicts",
            );
          }
        },
        recordSubmissionIntent: () => undefined,
      };
      const lineage = new ThreadLineageRepository(current.database);
      const reconcileDiscoveredFork = vi.fn(
        async (): Promise<string | undefined> => undefined,
      );
      const ancestryConflicts = vi.fn();
      const forkReconciliationErrors = vi.fn();
      const importTime = Date.parse("2026-08-05T12:00:00.000Z");
      const discovery = new BackendDiscoveryService({
        targets,
        bindings,
        inventory,
        lineage,
        forks: { reconcileDiscoveredFork },
        persistence: new Map([[instance.id, persistence]]),
        connectionProfileId: current.connectionProfileId,
        onAncestryReconciliationConflict: ancestryConflicts,
        onForkReconciliationError: forkReconciliationErrors,
        now: () => importTime,
      });

      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );

      const imported = bindings.findByBackendConversation(
        current.scope,
        instance.id,
        "discovered-conversation",
      );
      expect(imported).toBeDefined();
      expect(imported!.createdAt).toBe(importTime);
      expect(
        inventory.getThread(current.scope, imported!.applicationThreadId)
          .thread,
      ).toMatchObject({
        workspaceId: current.workspaceId,
        title: "Discovered conversation",
        backingState: "bound",
        availability: "available",
        reconciliationAt: importTime,
        lastActivityAt: Date.parse("2026-07-30T12:00:00.000Z"),
        createdAt: importTime,
      });

      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "native-child",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:01:00.000Z",
            opaqueBindingDetail: "child-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
            },
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      const child = bindings.findByBackendConversation(
        current.scope,
        instance.id,
        "native-child",
      )!;
      expect(
        lineage.getOrigin(current.scope, child.applicationThreadId),
      ).toMatchObject({ sourceThreadState: "unresolved" });
      const explicit = lineage.updatePlacement(
        current.scope,
        child.applicationThreadId,
        {
          placementMode: "top_level",
          expectedRevision: 0,
          mutationId: "keep-imported-child-top-level",
          now: 600,
        },
      );

      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "native-child",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:02:00.000Z",
            opaqueBindingDetail: "child-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
            },
          },
          {
            backendConversationId: "native-parent",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:01:30.000Z",
            opaqueBindingDetail: "parent-detail",
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      const parent = bindings.findByBackendConversation(
        current.scope,
        instance.id,
        "native-parent",
      )!;
      expect(
        lineage.getOrigin(current.scope, child.applicationThreadId),
      ).toMatchObject({
        sourceThreadState: "resolved",
        sourceThreadId: parent.applicationThreadId,
        sourceTurnState: "unresolved",
      });
      expect(
        lineage.getPlacement(current.scope, child.applicationThreadId),
      ).toEqual(explicit);

      reconcileDiscoveredFork.mockResolvedValueOnce(child.applicationThreadId);
      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "native-child",
            canonicalWorkspacePath: workspace.canonicalPath,
            title: "Renamed fork child",
            updatedAt: "2026-07-30T12:03:00.000Z",
            opaqueBindingDetail: "updated-child-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
              applicationOperationId: "fork-operation",
              childIdentity: "application_reserved",
              creationRecovery: "idempotent",
            },
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      expect(
        inventory.getThread(current.scope, child.applicationThreadId).thread,
      ).toMatchObject({
        title: "Renamed fork child",
        lastActivityAt: Date.parse("2026-07-30T12:03:00.000Z"),
      });

      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "native-child",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:04:00.000Z",
            opaqueBindingDetail: "updated-child-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "conflicting-parent",
              sourceBackendTurnId: "conflicting-turn",
            },
          },
          {
            backendConversationId: "conflicting-parent",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:03:30.000Z",
            opaqueBindingDetail: "conflicting-parent-detail",
          },
          {
            backendConversationId: "later-conversation",
            canonicalWorkspacePath: workspace.canonicalPath,
            title: "Discovered after conflict",
            updatedAt: "2026-07-30T12:03:45.000Z",
            opaqueBindingDetail: "later-detail",
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      expect(ancestryConflicts).toHaveBeenCalledWith(
        current.scope,
        expect.objectContaining({ code: "conflict" }),
        child.applicationThreadId,
      );
      const importedAfterConflict = bindings.findByBackendConversation(
        current.scope,
        instance.id,
        "later-conversation",
      );
      expect(importedAfterConflict).toBeDefined();
      expect(
        inventory.getThread(
          current.scope,
          importedAfterConflict!.applicationThreadId,
        ).thread.title,
      ).toBe("Discovered after conflict");

      reconcileDiscoveredFork
        .mockImplementationOnce(() => {
          throw new DomainError("conflict", "existing fork evidence conflicts");
        })
        .mockImplementationOnce(() => {
          throw new DomainError("conflict", "unbound fork evidence conflicts");
        });
      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "native-child",
            canonicalWorkspacePath: workspace.canonicalPath,
            title: "Existing fork refreshed after conflict",
            updatedAt: "2026-07-30T12:04:59.000Z",
            opaqueBindingDetail: "refreshed-existing-fork-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
              applicationOperationId: "existing-fork-operation",
              childIdentity: "application_reserved",
              creationRecovery: "idempotent",
            },
          },
          {
            backendConversationId: "poisoned-fork",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:05:00.000Z",
            opaqueBindingDetail: "poisoned-fork-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
              applicationOperationId: "poisoned-fork-operation",
              childIdentity: "application_reserved",
              creationRecovery: "idempotent",
            },
          },
          {
            backendConversationId: "provider-snapshot-orphan",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:05:00.500Z",
            opaqueBindingDetail: "provider-snapshot-orphan-detail",
            nativeAncestry: {
              method: "provider_native",
              parentBackendConversationId: "native-parent",
              applicationOperationId: "provider-snapshot-operation",
              childIdentity: "provider_assigned",
              creationRecovery: "potentially_unknown",
            },
          },
          {
            backendConversationId: "after-fork-error",
            canonicalWorkspacePath: workspace.canonicalPath,
            title: "Discovered after fork error",
            updatedAt: "2026-07-30T12:05:01.000Z",
            opaqueBindingDetail: "after-fork-error-detail",
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      expect(forkReconciliationErrors.mock.calls).toEqual([
        [
          current.scope,
          expect.objectContaining({ code: "conflict" }),
          "existing-fork-operation",
        ],
        [
          current.scope,
          expect.objectContaining({ code: "conflict" }),
          "poisoned-fork-operation",
        ],
        [
          current.scope,
          expect.objectContaining({ code: "conflict" }),
          "provider-snapshot-operation",
        ],
      ]);
      expect(
        inventory.getThread(current.scope, child.applicationThreadId).thread
          .title,
      ).toBe("Existing fork refreshed after conflict");
      expect(
        bindings.findByBackendConversation(
          current.scope,
          instance.id,
          "poisoned-fork",
        ),
      ).toBeUndefined();
      expect(
        bindings.findByBackendConversation(
          current.scope,
          instance.id,
          "provider-snapshot-orphan",
        ),
      ).toBeUndefined();
      expect(
        bindings.findByBackendConversation(
          current.scope,
          instance.id,
          "after-fork-error",
        ),
      ).toBeDefined();

      rejectedBindingDetail = "conflicting-binding-detail";
      vi.spyOn(driver, "discover").mockResolvedValueOnce({
        conversations: [
          {
            backendConversationId: "conflicting-binding",
            canonicalWorkspacePath: workspace.canonicalPath,
            updatedAt: "2026-07-30T12:06:00.000Z",
            opaqueBindingDetail: rejectedBindingDetail,
          },
          {
            backendConversationId: "after-binding-conflict",
            canonicalWorkspacePath: workspace.canonicalPath,
            title: "Discovered after binding conflict",
            updatedAt: "2026-07-30T12:06:01.000Z",
            opaqueBindingDetail: "valid-after-binding-conflict",
          },
        ],
      });
      await discovery.discoverWorkspace(
        current.scope,
        current.workspaceId,
        EXHAUSTIVE_DISCOVERY_SCAN,
        new AbortController().signal,
      );
      expect(
        bindings.findByBackendConversation(
          current.scope,
          instance.id,
          "conflicting-binding",
        ),
      ).toBeUndefined();
      expect(
        bindings.findByBackendConversation(
          current.scope,
          instance.id,
          "after-binding-conflict",
        ),
      ).toBeDefined();
      expect(ancestryConflicts).toHaveBeenCalledWith(
        current.scope,
        expect.objectContaining({ code: "conflict" }),
        expect.any(String),
      );
      environment.close();
    } finally {
      current.database.close();
    }
  });

  it("preserves draft, stash, snooze, settle, archive, and workspace inventory behavior", async () => {
    const current = fixture();
    try {
      const repository = new InventoryRepository(current.database);
      const service = new InventoryService(repository, {
        publishMany() {},
        publishApplicationThread() {},
      });
      expect(repository.getLocalEnvironment(current.scope).id).toBe(
        current.environmentId,
      );
      expect(repository.listWorkspaces(current.scope)).toHaveLength(1);

      const saved = service.saveDraft(
        current.scope,
        current.threadId,
        {
          text: "remember this",
          contextExcerpts: [],
          taskReferenceIds: [],
          attachmentIds: [],
          expectedRevision: 0,
        },
        400,
      );
      expect(saved).toMatchObject({ text: "remember this", revision: 1 });
      const stashed = service.stashDraft(
        current.scope,
        current.threadId,
        {
          expectedDraftRevision: 1,
          mutationId: "stash-operation",
        },
        410,
      );
      expect(stashed.draft).toMatchObject({ text: "", revision: 2 });
      expect(stashed.stash.text).toBe("remember this");
      expect(
        service.stashDraft(
          current.scope,
          current.threadId,
          {
            expectedDraftRevision: 1,
            mutationId: "stash-operation",
          },
          411,
        ).replayed,
      ).toBe(true);
      const restored = service.restoreStash(
        current.scope,
        current.threadId,
        stashed.stash.id,
        {
          expectedDraftRevision: 2,
          mutationId: "restore-operation",
        },
        420,
      );
      expect(restored.draft).toMatchObject({
        text: "remember this",
        revision: 3,
      });

      const snoozed = await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "snooze-operation",
          change: {
            action: "snooze",
            snoozedUntil: 1_000,
            wakeReminderText: "follow up",
          },
        },
        500,
      );
      expect(snoozed).toMatchObject({
        inventoryState: "snoozed",
        inventoryRevision: 1,
        wakeReminderText: "follow up",
      });
      expect(repository.getNearestSnoozeDeadline()).toBe(1_000);
      await expect(service.wakeDue(999)).resolves.toEqual([]);
      await expect(service.wakeDue(1_000)).resolves.toMatchObject([
        {
          inventoryState: "active",
          wakeReason: "deadline",
          inventoryRevision: 2,
        },
      ]);
      const settled = await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 2,
          mutationId: "settle-operation",
          change: { action: "settle" },
        },
        1_100,
      );
      expect(settled.inventoryState).toBe("settled");
      const archived = await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 3,
          mutationId: "archive-operation",
          change: { action: "archive" },
        },
        1_200,
      );
      expect(archived.inventoryState).toBe("archived");
      await expect(
        service.transition(
          current.scope,
          current.threadId,
          {
            expectedRevision: 4,
            mutationId: "restore-thread-operation",
            change: { action: "restore" },
          },
          1_300,
        ),
      ).resolves.toMatchObject({ inventoryState: "active" });
    } finally {
      current.database.close();
    }
  });

  it("repairs failed inventory publications on replay and retries every due wake", async () => {
    const current = fixture();
    try {
      const repository = new InventoryRepository(current.database);
      const publish = vi
        .fn()
        .mockRejectedValueOnce(new Error("projection unavailable"))
        .mockResolvedValue(undefined);
      const onRetryPending = vi.fn();
      const service = new InventoryService(repository, {
        publishMany: publish,
        onRetryPending,
        publishApplicationThread() {},
      });
      const transition = {
        expectedRevision: 0,
        mutationId: "repair-publication",
        change: { action: "settle" as const },
      };

      await expect(
        service.transition(current.scope, current.threadId, transition, 500),
      ).rejects.toThrow("projection unavailable");
      expect(onRetryPending).toHaveBeenCalledOnce();
      expect(service.getNearestDeadline()).not.toBeNull();
      expect(
        repository.getInventory(current.scope, current.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: 1,
      });
      await expect(
        service.transition(current.scope, current.threadId, transition, 501),
      ).resolves.toMatchObject({
        inventoryState: "settled",
        inventoryRevision: 1,
      });
      expect(publish).toHaveBeenCalledTimes(2);

      await service.wakeForRuntimeSignal(
        current.scope,
        current.threadId,
        "completion",
        502,
      );
      expect(publish).toHaveBeenCalledTimes(3);
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 1,
          mutationId: "repair-unsettle",
          change: { action: "unsettle" },
        },
        550,
      );

      const bindings = new ConversationBindingRepository(current.database);
      const second = bindings.createUnboundThread(current.scope, {
        id: "publication-retry-second",
        workspaceId: current.workspaceId,
        connectionProfileId: current.connectionProfileId,
        title: "Second due wake",
        now: 600,
      });
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 2,
          mutationId: "snooze-first",
          change: { action: "snooze", snoozedUntil: 1_000 },
        },
        700,
      );
      await service.transition(
        current.scope,
        second.id,
        {
          expectedRevision: 0,
          mutationId: "snooze-second",
          change: { action: "snooze", snoozedUntil: 1_000 },
        },
        700,
      );
      publish.mockClear();
      publish
        .mockRejectedValueOnce(new Error("first wake publication failed"))
        .mockResolvedValue(undefined);

      await expect(service.wakeDue(1_000)).rejects.toThrow(
        "One or more inventory publications failed.",
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenLastCalledWith(
        current.scope,
        expect.arrayContaining([
          expect.objectContaining({ threadId: current.threadId }),
          expect.objectContaining({ threadId: second.id }),
        ]),
      );
      expect(
        repository.getInventory(current.scope, current.threadId).inventoryState,
      ).toBe("active");
      expect(
        repository.getInventory(current.scope, second.id).inventoryState,
      ).toBe("active");

      const retryAt = service.getNearestDeadline();
      expect(retryAt).not.toBeNull();
      await expect(service.wakeDue(retryAt!)).resolves.toEqual([]);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(service.getNearestDeadline()).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("does not schedule or duplicate a successful publication while it is in flight", async () => {
    const current = fixture();
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    try {
      const repository = new InventoryRepository(current.database);
      const publish = vi.fn(async () => publicationGate);
      const onRetryPending = vi.fn();
      const service = new InventoryService(repository, {
        publishMany: publish,
        onRetryPending,
        publishApplicationThread() {},
      });
      const transition = service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "single-in-flight-publication",
          change: { action: "settle" },
        },
        500,
      );
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

      expect(service.getNearestDeadline()).toBeNull();
      await expect(service.wakeDue(500)).resolves.toEqual([]);
      expect(publish).toHaveBeenCalledOnce();

      releasePublication();
      await transition;
      expect(service.getNearestDeadline()).toBeNull();
      expect(publish).toHaveBeenCalledOnce();
      expect(onRetryPending).not.toHaveBeenCalled();
    } finally {
      releasePublication();
      current.database.close();
    }
  });

  it("projects principal-scoped normalized inventory and attention", async () => {
    const current = fixture();
    try {
      const inventory = new InventoryRepository(current.database);
      const service = new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      });
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "reader-snooze",
          change: {
            action: "snooze",
            snoozedUntil: 700,
            wakeReminderText: "reader reminder",
          },
        },
        500,
      );
      await service.wakeDue(700);
      const queue = new QueuedInputRepository(current.database);
      const completion = new SubmissionCompletionRepository(current.database);
      const reader = new DatabaseThreadApplicationInventoryReader({
        inventory,
        queue,
        completion,
        ...threadAgentToolPolicyReaderDependencies(current.database),
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const projected = await reader.getAuthorized(
        current.scope,
        current.threadId,
      );
      expect(projected).toMatchObject({
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        thread: {
          id: current.threadId,
          backingState: "unbound",
          inventoryState: "active",
          available: true,
        },
        workspace: {
          id: current.workspaceId,
          label: { text: "Temporary workspace" },
        },
        environment: {
          id: current.environmentId,
        },
        attention: {
          wake: {
            text: { text: "reader reminder" },
          },
        },
      });
      current.database.prepare("UPDATE workspaces SET removed_at = 123 WHERE id = ?").run(current.workspaceId);
      const retained = await reader.getAuthorized(current.scope, current.threadId);
      expect(retained.thread).toMatchObject({ available: true, inventoryState: "active" });
      expect(retained.workspace.available).toBe(false);
    } finally {
      current.database.close();
    }
  });

  it("projects captured Saved Agent provenance and live deletion state", async () => {
    const current = fixture();
    try {
      const agents = new SavedAgentRepository(current.database);
      const agent = agents.create(current.scope, {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Careful Agent",
        description: "",
        backendTypeId: "test-agent",
        backendOverridesSchemaVersion: 1,
        backendOverrides: [],
        sedesTools: null,
        now: 400,
      });
      current.database
        .prepare(
          `INSERT INTO thread_saved_agent_origins(
             tenant_id, owner_principal_id, thread_id, agent_id,
             agent_revision, agent_name, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.threadId,
          agent.id,
          agent.revision,
          agent.name,
          410,
        );
      const inventory = new InventoryRepository(current.database);
      const reader = new DatabaseThreadApplicationInventoryReader({
        inventory,
        queue: new QueuedInputRepository(current.database),
        completion: new SubmissionCompletionRepository(current.database),
        ...threadAgentToolPolicyReaderDependencies(current.database),
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });

      await expect(
        reader.getAuthorized(current.scope, current.threadId),
      ).resolves.toMatchObject({
        createdWithAgent: {
          id: agent.id,
          revision: 0,
          name: { text: "Careful Agent" },
          available: true,
        },
      });

      agents.delete(current.scope, agent.id, { expectedRevision: 0 });
      await expect(
        reader.getAuthorized(current.scope, current.threadId),
      ).resolves.toMatchObject({
        createdWithAgent: {
          id: agent.id,
          name: { text: "Careful Agent" },
          available: false,
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("projects and atomically acknowledges wake attention and immediate reminders", async () => {
    const current = fixture();
    try {
      const inventory = new InventoryRepository(current.database);
      const inventoryService = new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      });
      await inventoryService.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "reader-snooze-without-note",
          change: { action: "snooze", snoozedUntil: 700 },
        },
        500,
      );
      await inventoryService.wakeDue(700);

      const queue = new QueuedInputRepository(current.database);
      const completion = new SubmissionCompletionRepository(current.database);
      const threadReader = new DatabaseThreadApplicationInventoryReader({
        inventory,
        queue,
        completion,
        ...threadAgentToolPolicyReaderDependencies(current.database),
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const summaryReader = new DatabaseApplicationThreadSummaryReader({
        inventory,
        queue,
        completion,
      });
      expect(
        (await threadReader.getAuthorized(current.scope, current.threadId))
          .attention,
      ).toEqual({ wake: { wokeAt: new Date(700).toISOString() } });
      expect(
        summaryReader
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId)?.attention.wake,
      ).toBe(true);

      await inventoryService.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 2,
          mutationId: "second-wake-cycle",
          change: {
            action: "snooze",
            snoozedUntil: 900,
            wakeReminderText: "Review the second wake",
          },
        },
        750,
      );
      await inventoryService.wakeDue(900);
      const before = inventory.getInventory(current.scope, current.threadId);
      const reminded = await inventoryService.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: before.inventoryRevision,
          mutationId: "immediate-reminder",
          change: {
            action: "remind",
            wakeReminderText: "Review this immediately",
          },
        },
        900,
      );
      expect(reminded).toMatchObject({
        inventoryState: "active",
        stateChangedAt: before.stateChangedAt,
        snoozedAt: null,
        snoozedUntil: null,
        wokeAt: 901,
        wakeReason: "manual",
        wakeAcknowledgedAt: null,
        wakeReminderText: "Review this immediately",
        inventoryRevision: before.inventoryRevision + 1,
      });
      expect(inventory.getNearestSnoozeDeadline()).toBeNull();
      expect(
        (await threadReader.getAuthorized(current.scope, current.threadId))
          .attention,
      ).toEqual({
        wake: {
          wokeAt: new Date(901).toISOString(),
          text: { text: "Review this immediately" },
        },
      });
      const generationBefore = current.database
        .prepare(
          `SELECT inventory_generation AS value
           FROM principal_generations
           WHERE tenant_id = ? AND principal_id = ?`,
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        readonly value: number;
      };
      const publish = vi.fn();
      const attention = new ThreadAttentionService({
        inventory,
        completions: completion,
        queue: {
          acknowledgeFailure: vi.fn(),
        } as never,
        now: () => 1_000,
        publish,
      });

      await attention.dismiss(current.scope, current.threadId, {
        kind: "wake",
        wokeAt: new Date(900).toISOString(),
        mutationId: "stale-wake-acknowledgement",
      });
      expect(inventory.getInventory(current.scope, current.threadId)).toEqual(
        reminded,
      );

      publish.mockClear();
      await attention.dismiss(current.scope, current.threadId, {
        kind: "wake",
        wokeAt: new Date(901).toISOString(),
        mutationId: "current-wake-acknowledgement",
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(current.scope, current.threadId);
      expect(
        inventory.getInventory(current.scope, current.threadId),
      ).toMatchObject({
        wakeAcknowledgedAt: 1_000,
        wakeReminderText: null,
        inventoryRevision: reminded.inventoryRevision + 1,
      });
      const generationAfter = current.database
        .prepare(
          `SELECT inventory_generation AS value
           FROM principal_generations
           WHERE tenant_id = ? AND principal_id = ?`,
        )
        .get(current.scope.tenantId, current.scope.principalId) as {
        readonly value: number;
      };
      expect(generationAfter.value).toBe(generationBefore.value + 1);
      expect(
        (await threadReader.getAuthorized(current.scope, current.threadId))
          .attention,
      ).toEqual({});
      expect(
        summaryReader
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId)?.attention.wake,
      ).toBe(false);
    } finally {
      current.database.close();
    }
  });

  it("captures a scope-isolated application summary with a constant number of database reads", async () => {
    const current = fixture();
    try {
      const inventory = new InventoryRepository(current.database);
      const queue = new QueuedInputRepository(current.database);
      const completion = new SubmissionCompletionRepository(current.database);
      const bindings = new ConversationBindingRepository(current.database);
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "summary-bound-conversation",
        now: 400,
      });

      const service = new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      });
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "summary-snooze",
          change: {
            action: "snooze",
            snoozedUntil: 700,
            wakeReminderText: "batched reminder",
          },
        },
        500,
      );
      await service.wakeDue(700);

      current.database
        .prepare(
          `
            INSERT INTO queued_inputs(
              tenant_id, owner_principal_id, id, application_thread_id,
              sequence, mutation_id, text, state, created_at
            )
            VALUES (?, ?, 'summary-pending', ?, 1, 'summary-pending-mutation',
              'pending input', 'pending', 710)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.threadId,
        );
      current.database
        .prepare(
          `
            INSERT INTO queued_inputs(
              tenant_id, owner_principal_id, id, application_thread_id,
              sequence, mutation_id, text, state, created_at, resolved_at,
              diagnostic
            )
            VALUES (?, ?, 'summary-failed', ?, 2, 'summary-failed-mutation',
              'failed input', 'failed', 711, 712, 'provider failed')
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.threadId,
        );
      completion.recordAccepted(current.scope, current.threadId, {
        operationId: "summary-completion",
        acceptedAt: 720,
      });
      completion.observeCompletion(
        current.scope,
        current.threadId,
        "summary-completion",
        {
          completionIdentity: "summary-completion-identity",
          observedAt: 730,
          createAttention: true,
        },
      );
      const automation = new AutomationRepository(current.database);
      automation.createDefinition(current.scope, {
        id: "summary-automation",
        anchorThreadId: current.threadId,
        name: "Summary automation",
        prompt: "run the summary automation",
        precheck: {
          command: "true",
          timeoutSeconds: 5,
          includeStdout: false,
        },
        runMode: "same_thread",
        enabled: true,
        schedule: { kind: "date_time", runAt: 900 },
        misfirePolicy: "coalesce",
        nextRunAt: 900,
        now: 740,
      });
      automation.claimScheduledOccurrence(current.scope, "summary-automation", {
        runId: "summary-automation-run",
        occurrenceKey: "summary-occurrence",
        scheduledFor: 900,
        lastScheduledAt: 900,
        nextRunAt: null,
        coalescedCount: 0,
        claimToken: "summary-claim",
        leaseExpiresAt: 1_000,
        dispatchMutationId: "summary-dispatch",
        now: 900,
      });

      service.saveDraft(
        current.scope,
        current.threadId,
        {
          text: "Retained sidebar prompt",
          contextExcerpts: [],
          taskReferenceIds: [],
          attachmentIds: [],
          expectedRevision: 0,
        },
        750,
      );
      const retainedStash = service.stashDraft(
        current.scope,
        current.threadId,
        {
          expectedDraftRevision: 1,
          mutationId: "summary-stash",
        },
        751,
      ).stash;
      const turnBookmarks = new ConversationTurnBookmarkRepository(
        current.database,
        inventory,
      );
      turnBookmarks.set(
        current.scope,
        current.threadId,
        "summary-bookmarked-turn",
        {
          bookmarked: true,
          expectedRevision: 0,
          mutationId: "summary-bookmark",
          userPreview: "Retain this turn in the sidebar summary",
          assistantPreview: "The summary exposes only its bounded count.",
          responseState: "responded",
        },
        752,
      );

      for (let index = 0; index < 49; index += 1) {
        bindings.createUnboundThread(current.scope, {
          id: `summary-thread-${index.toString().padStart(2, "0")}`,
          workspaceId: current.workspaceId,
          connectionProfileId: current.connectionProfileId,
          title: `Summary thread ${index}`,
          initialText: `Draft ${index}`,
          now: 800 + index,
        });
      }

      const summaries = new DatabaseApplicationThreadSummaryReader({
        inventory,
        queue,
        completion,
      });
      const captureLoadedState = vi.fn(
        async (_scope: RequestScope, threadId: string) =>
          threadId === current.threadId
            ? ({ runState: "running" } as const)
            : undefined,
      );
      const application = new ApplicationSnapshotService(
        inventory,
        summaries,
        {
          captureLoadedState,
        },
        {
          read: async () => ({
            executionTargets: [
              {
                id: current.connectionProfileId,
                environmentId: current.environmentId,
                label: { text: "Local Pi SDK" },
                backend: { label: { text: "Primary Pi" }, brand: "pi" },
                workspaceExecution: { kind: "direct_only" },
                available: true,
              },
            ],
            defaultTargetId: current.connectionProfileId,
          }),
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
          listAssociated: () => [],
          listAssociatedByThread: () => [],
          findAssociated: () => undefined,
        },
        { list: () => [] },
        () => "unavailable",
        { summariesByThread: () => new Map() },
      );
      const prepare = vi.spyOn(current.database, "prepare");
      const snapshot = await application.capture(current.scope);

      // One additional bounded read captures fork-selector saturation.
      expect(prepare).toHaveBeenCalledTimes(5);
      expect(captureLoadedState).toHaveBeenCalledTimes(50);
      expect(snapshot.threads).toHaveLength(50);
      expect(snapshot.counts).toEqual({
        active: 50,
        snoozed: 0,
        settled: 0,
        archived: 0,
      });
      expect(
        snapshot.threads.find(({ id }) => id === current.threadId),
      ).toMatchObject({
        id: current.threadId,
        runState: "running",
        queuedInputCount: 2,
        stashedPromptCount: 1,
        pendingQuestionCount: 0,
        turnBookmarkCount: 1,
        backend: { label: { text: "Primary Pi" }, brand: "pi" },
        attention: {
          wake: true,
          automationContext: null,
          unseenCompletion: true,
          queueFailure: true,
        },
        automation: {
          status: "enabled",
          runMode: "same_thread",
          scheduleKind: "date_time",
          revision: 1,
          hasPrecheck: true,
          lastRun: {
            id: "summary-automation-run",
            state: "claimed",
            occurrence: "scheduled",
            scheduledFor: new Date(900).toISOString(),
            resultThreadId: current.threadId,
          },
        },
      });
      await expect(
        service.transition(
          current.scope,
          current.threadId,
          {
            expectedRevision: 2,
            mutationId: "empty-summary-reminder",
            change: {
              action: "snooze",
              snoozedUntil: 1_000,
              wakeReminderText: "",
            },
          },
          750,
        ),
      ).rejects.toThrow("Wake reminder cannot be empty.");
      expect(
        summaries.list(
          {
            tenantId: current.scope.tenantId,
            principalId: "foreign-principal",
          },
          current.environmentId,
        ),
      ).toEqual([]);
      turnBookmarks.set(
        current.scope,
        current.threadId,
        "summary-bookmarked-turn",
        {
          bookmarked: false,
          expectedRevision: 1,
          mutationId: "summary-bookmark-remove",
        },
        753,
      );
      expect(
        summaries
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId),
      ).toMatchObject({ bookmarkRevision: 2, turnBookmarkCount: 0 });

      service.restoreStash(
        current.scope,
        current.threadId,
        retainedStash.id,
        {
          expectedDraftRevision: 2,
          mutationId: "summary-restore-stash",
        },
        752,
      );
      expect(
        summaries
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId)?.stashedPromptCount,
      ).toBe(0);
      const replacementStash = service.stashDraft(
        current.scope,
        current.threadId,
        {
          expectedDraftRevision: 3,
          mutationId: "summary-restash",
        },
        753,
      ).stash;
      expect(
        summaries
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId)?.stashedPromptCount,
      ).toBe(1);
      expect(
        inventory.deleteStash(
          current.scope,
          current.threadId,
          replacementStash.id,
        ),
      ).toBe(true);
      expect(
        summaries
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId)?.stashedPromptCount,
      ).toBe(0);
    } finally {
      vi.restoreAllMocks();
      current.database.close();
    }
  });

  it("bounds recurring fork families in application bootstrap while retaining total counts", async () => {
    const current = fixture();
    try {
      const bindings = new ConversationBindingRepository(current.database);
      const lineage = new ThreadLineageRepository(current.database);
      const inventory = new InventoryRepository(current.database);
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "bootstrap-source",
        now: 400,
      });

      current.database
        .transaction(() => {
          for (
            let index = 0;
            index < MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 3;
            index += 1
          ) {
            const suffix = index.toString().padStart(4, "0");
            const child = bindings.createUnboundThread(current.scope, {
              id: `bootstrap-fork-${suffix}`,
              workspaceId: current.workspaceId,
              connectionProfileId: current.connectionProfileId,
              title: `Bootstrap fork ${suffix}`,
              now: 1_000 + index,
            });
            bindings.bindDiscoveredConversation(current.scope, child.id, {
              backendConversationId: `native-bootstrap-fork-${suffix}`,
              now: 1_000 + index,
            });
            lineage.recordImportedNativeOrigin(current.scope, {
              childThreadId: child.id,
              providerParentBackendConversationId: "bootstrap-source",
              sourceThreadId: current.threadId,
              sourceTurnState: "unresolved",
              branchMethod: "provider_native",
              now: 1_000 + index,
            });
          }
        })
        .immediate();
      lineage.updatePlacement(current.scope, "bootstrap-fork-0000", {
        placementMode: "top_level",
        expectedRevision: 0,
        mutationId: "retain-old-top-level-fork",
        now: 3_000,
      });
      await new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      }).transition(
        current.scope,
        "bootstrap-fork-0001",
        {
          expectedRevision: 0,
          mutationId: "retain-old-lifecycle-root",
          change: { action: "snooze", snoozedUntil: 9_000 },
        },
        3_001,
      );
      inventory.setThreadPinned(current.scope, "bootstrap-fork-0002", {
        pinned: true,
        expectedRevision: 0,
        mutationId: "retain-old-pinned-fork",
        now: 3_002,
      });

      const summaries = new DatabaseApplicationThreadSummaryReader({
        inventory,
        queue: new QueuedInputRepository(current.database),
        completion: new SubmissionCompletionRepository(current.database),
      });
      const application = new ApplicationSnapshotService(
        inventory,
        summaries,
        { captureLoadedState: async () => undefined },
        {
          read: async () => ({
            executionTargets: [
              {
                id: current.connectionProfileId,
                environmentId: current.environmentId,
                label: { text: "Local Pi SDK" },
                backend: { label: { text: "Primary Pi" }, brand: "pi" },
                workspaceExecution: { kind: "direct_only" },
                available: true,
              },
            ],
            defaultTargetId: current.connectionProfileId,
          }),
          requireSelectable: async () => undefined,
        },
        new DatabaseApplicationLineageSummaryReader(lineage),
        {
          listAssociated: () => [],
          listAssociatedByThread: () => [],
          findAssociated: () => undefined,
        },
        { list: () => [] },
        () => "unavailable",
        { summariesByThread: () => new Map() },
      );

      const snapshot = await application.capture(current.scope);

      expect(snapshot.threads).toHaveLength(
        MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 4,
      );
      expect(snapshot.forkOrigins).toHaveLength(
        MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 3,
      );
      expect(snapshot.lineagePlacements).toHaveLength(
        MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 3,
      );
      expect(snapshot.lineageFamilies).toEqual([
        {
          sourceThreadId: current.threadId,
          descendantCount: MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 3,
        },
      ]);
      expect(snapshot.counts.active).toBe(
        MAXIMUM_APPLICATION_BOOTSTRAP_FORKS + 3,
      );
      expect(snapshot.counts.snoozed).toBe(1);
      expect(snapshot.threads.map(({ id }) => id)).toContain(
        "bootstrap-fork-0000",
      );
      expect(snapshot.threads.map(({ id }) => id)).toContain(
        "bootstrap-fork-0001",
      );
      expect(snapshot.threads.map(({ id }) => id)).toContain(
        "bootstrap-fork-0002",
      );
      expect(
        snapshot.threads.find(({ id }) => id === "bootstrap-fork-0002"),
      ).toMatchObject({ pinned: true, pinRevision: 1 });
      expect(snapshot.threads.map(({ id }) => id)).toContain(current.threadId);
      expect(
        new DatabaseApplicationLineageSummaryReader(lineage).list(
          current.scope,
          ["bootstrap-fork-1000"],
        ).forkOrigins,
      ).toEqual([
        expect.objectContaining({
          childThreadId: "bootstrap-fork-1000",
          sourceThreadId: null,
          sourceTurnId: null,
        }),
      ]);
      expect(
        new DatabaseApplicationLineageSummaryReader(lineage).list(
          {
            tenantId: current.scope.tenantId,
            principalId: "foreign-principal",
          },
          snapshot.threads.map(({ id }) => id),
        ),
      ).toEqual({
        forkOrigins: [],
        lineagePlacements: [],
        lineageFamilies: [],
      });
    } finally {
      current.database.close();
    }
  }, 10_000);

  it("resolves lifecycle, actor, queue, and recovery targets without exposing Pi shapes", async () => {
    const current = fixture();
    try {
      const bindings = new ConversationBindingRepository(current.database);
      bindings.bindDiscoveredConversation(current.scope, current.threadId, {
        backendConversationId: "backend-conversation-1",
        now: 400,
      });
      const discoveredInventory = new InventoryRepository(current.database);
      expect(
        discoveredInventory.finishDiscovery(
          current.scope,
          current.environmentId,
          current.workspaceId,
          "pi-primary",
          [current.connectionProfileId],
          new Set(),
          405,
        )[0]?.thread.availability,
      ).toBe("missing");
      discoveredInventory.markDiscoveredAvailable(
        current.scope,
        current.threadId,
        { updatedAt: 406, now: 406 },
      );
      expect(
        discoveredInventory.quarantineDiscoveredConversations(
          current.scope,
          current.environmentId,
          "pi-primary",
          ["backend-conversation-1"],
          407,
        )[0]?.thread.availability,
      ).toBe("quarantined");
      discoveredInventory.updateEnvironmentAvailability(
        current.scope,
        current.environmentId,
        { available: false, now: 407 },
      );
      discoveredInventory.updateEnvironmentAvailability(
        current.scope,
        current.environmentId,
        { available: true, now: 408 },
      );
      expect(
        discoveredInventory.getThread(current.scope, current.threadId).thread
          .availability,
      ).toBe("quarantined");
      discoveredInventory.markDiscoveredAvailable(
        current.scope,
        current.threadId,
        { updatedAt: 409, now: 409 },
      );
      const details = new Map([
        [current.threadId, '{"version":1,"sessionFile":"/tmp/pi.jsonl"}'],
      ]);
      const instance: AgentBackendInstance = {
        id: "pi-primary",
        tenantId: current.scope.tenantId,
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        configurationRevision: current.backendConfigurationRevision,
        protocolRelease: "0.86.0",
      };
      const registry = new AgentBackendRegistry();
      registry.register({
        scope: current.scope,
        instance,
        connectionKinds: ["pi_sdk"],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create(connection: AgentConnectionProfile) {
          return new InMemoryConformanceDriver({ instance, connection });
        },
      });
      let revalidatedAuthorityRevision = 0;
      const revalidateWorkspace = vi.fn(
        async (
          _scope: RequestScope,
          workspace: ValidatedWorkspace,
        ): Promise<ValidatedWorkspace> => ({
          ...workspace,
          authorityRevision: revalidatedAuthorityRevision,
          summary: {
            ...workspace.summary,
            displayName:
              revalidatedAuthorityRevision === 0
                ? workspace.summary.displayName
                : "Renewed temporary workspace",
            trustState:
              revalidatedAuthorityRevision === 0 ? "trusted" : "untrusted",
          },
        }),
      );
      const environments: ExecutionEnvironmentProvider = {
        async listEnvironments() {
          return [];
        },
        directoryBrowsingAvailability: () => "unavailable",
        async browseDirectories() {
          throw new Error("not used");
        },
        async validateWorkspace() {
          throw new Error("not used");
        },
        revalidateWorkspace,
        async acquireLease() {
          throw new Error("not used");
        },
        async executeCommand() {
          throw new Error("not used");
        },
      };
      const store = new DatabaseConversationTargetStore({
        database: current.database,
        bindings,
        bindingDetails: new Map([
          [
            instance.id,
            {
              getBindingDetail(_scope, applicationThreadId) {
                return details.get(applicationThreadId);
              },
            },
          ],
        ]),
        registry,
        environments,
        now: () => 500,
      });
      const lifecycle = new DatabaseLifecycleTargetResolver(store);
      await expect(
        lifecycle.resolve(current.scope, current.threadId),
      ).rejects.toThrow("conversation_target_workspace_publications_unbound");
      expect(revalidateWorkspace).not.toHaveBeenCalled();
      const handoffAuthoritativeReplacement = vi.fn();
      store.bindWorkspacePublications({ handoffAuthoritativeReplacement });
      expect(() =>
        store.bindWorkspacePublications({ handoffAuthoritativeReplacement }),
      ).toThrow("conversation_target_workspace_publications_already_bound");
      current.database
        .prepare(
          `UPDATE execution_environments
           SET availability = 'unavailable',
             diagnostic_code = 'ssh_environment_not_validated'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.environmentId,
        );
      const actor = new DatabaseActorTargetResolver(store);
      await expect(
        lifecycle.resolve(current.scope, current.threadId),
      ).resolves.toMatchObject({
        connection: {
          id: current.connectionProfileId,
          enabled: true,
        },
        workspace: {
          canonicalPath: "/tmp",
        },
        title: "Normalized thread",
      });
      expect(handoffAuthoritativeReplacement).not.toHaveBeenCalled();
      await expect(
        actor.resolve(current.scope, current.threadId),
      ).resolves.toMatchObject({
        binding: {
          applicationThreadId: current.threadId,
          backendConversationId: "backend-conversation-1",
        },
        opaqueBindingDetail: '{"version":1,"sessionFile":"/tmp/pi.jsonl"}',
      });
      const firstUseInventory =
        await new DatabaseThreadApplicationInventoryReader({
          inventory: new InventoryRepository(current.database),
          queue: new QueuedInputRepository(current.database),
          completion: new SubmissionCompletionRepository(current.database),
          ...threadAgentToolPolicyReaderDependencies(current.database),
          directoryBrowsingAvailability: () => "available",
          executionWorkspaces: directThreadExecutionWorkspaceReader,
        }).getAuthorized(current.scope, current.threadId);
      expect(firstUseInventory).toMatchObject({
        thread: { available: true },
        environment: { available: true },
      });
      expect(firstUseInventory.environment).not.toHaveProperty("diagnostic");
      expect(
        new DatabaseApplicationThreadSummaryReader({
          inventory: new InventoryRepository(current.database),
          queue: new QueuedInputRepository(current.database),
          completion: new SubmissionCompletionRepository(current.database),
        })
          .list(current.scope, current.environmentId)
          .find(({ id }) => id === current.threadId),
      ).toMatchObject({ available: true });
      const inventoryBeforeRenewal = new InventoryRepository(current.database);
      const workspaceBeforeRenewal = inventoryBeforeRenewal.getWorkspace(
        current.scope,
        current.workspaceId,
      );
      current.database
        .prepare(
          `
            UPDATE execution_environments
            SET configuration_revision = 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.environmentId,
        );
      revalidatedAuthorityRevision = 1;
      const renewed = await lifecycle.resolve(current.scope, current.threadId);
      expect(handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
      expect(handoffAuthoritativeReplacement).toHaveBeenCalledWith(
        current.scope,
      );
      expect(renewed.workspace).toMatchObject({
        authorityRevision: 1,
        summary: {
          displayName: "Renewed temporary workspace",
          trustState: "untrusted",
          revision: workspaceBeforeRenewal.revision + 1,
        },
      });
      expect(
        inventoryBeforeRenewal.getWorkspace(current.scope, current.workspaceId),
      ).toMatchObject({
        canonicalPath: "/tmp",
        displayName: "Renewed temporary workspace",
        trustState: "untrusted",
        environmentConfigurationRevision: 1,
        revision: workspaceBeforeRenewal.revision + 1,
      });
      await expect(
        actor.resolve(current.scope, current.threadId),
      ).resolves.toMatchObject({
        workspace: {
          canonicalPath: "/tmp",
          authorityRevision: 1,
          summary: {
            displayName: "Renewed temporary workspace",
            trustState: "untrusted",
            revision: workspaceBeforeRenewal.revision + 1,
          },
        },
      });
      expect(handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
      expect(revalidateWorkspace).toHaveBeenCalledTimes(2);
      await expect(
        new DatabaseThreadApplicationInventoryReader({
          inventory: new InventoryRepository(current.database),
          queue: new QueuedInputRepository(current.database),
          completion: new SubmissionCompletionRepository(current.database),
          ...threadAgentToolPolicyReaderDependencies(current.database),
          directoryBrowsingAvailability: () => "unavailable",
          executionWorkspaces: directThreadExecutionWorkspaceReader,
        }).getAuthorized(current.scope, current.threadId),
      ).resolves.toMatchObject({
        backendSessionId: "backend-conversation-1",
      });
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "another-principal",
      };
      await expect(
        lifecycle.resolve(foreignScope, current.threadId),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        new DatabaseThreadApplicationInventoryReader({
          inventory: new InventoryRepository(current.database),
          queue: new QueuedInputRepository(current.database),
          completion: new SubmissionCompletionRepository(current.database),
          ...threadAgentToolPolicyReaderDependencies(current.database),
          directoryBrowsingAvailability: () => "unavailable",
          executionWorkspaces: directThreadExecutionWorkspaceReader,
        }).getAuthorized(foreignScope, current.threadId),
      ).rejects.toMatchObject({ code: "not_found" });

      const queueReader = new DatabaseThreadApplicationQueueReader(
        new QueuedInputRepository(current.database),
      );
      await expect(
        queueReader.list(current.scope, current.threadId),
      ).resolves.toEqual([]);
      const recoveryReader = new DatabaseThreadApplicationRecoveryReader({
        creation: new ConversationCreationRepository(current.database),
        operations: new ConversationOperationRepository(current.database),
        targets: lifecycle,
        registry,
        forks: {
          readRecovery: async () => ({ recoverable: false }),
        },
      });
      await expect(
        recoveryReader.read(current.scope, current.threadId),
      ).resolves.toBeUndefined();
      current.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (?, ?, ?, 'uncertain-settings',
              'conversation_settings', ?, 'uncertain', ?, 0, 450)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.threadId,
          "0".repeat(64),
          JSON.stringify({
            diagnostic: "Settings may already have been applied.",
          }),
        );
      await expect(
        recoveryReader.read(current.scope, current.threadId),
      ).resolves.toMatchObject({
        kind: "operation_uncertain",
        operationCategory: "settings",
        diagnostic: { text: "Settings may already have been applied." },
        submissionMayHaveBeenAccepted: false,
      });
      current.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND mutation_id = 'uncertain-settings'
          `,
        )
        .run(current.scope.tenantId, current.scope.principalId);

      const pi = new PiConversationRepository(current.database);
      const presentation = new DatabaseThreadApplicationPresentationReader({
        targets: store,
        providers: new Map([
          [
            instance.id,
            new PiThreadPresentationProvider(
              pi,
              compileBackendModelPolicy(
                { type: "catalog" },
                "provider_model_effort",
              ),
            ),
          ],
        ]),
      });
      const freshPresentation = await presentation.read(
        current.scope,
        current.threadId,
      );
      expect(freshPresentation).toMatchObject({
        backend: { label: { text: "Primary Pi" }, brand: "pi" },
        interactionMode: "interactive",
        settings: {
          revision: 0,
          values: [
            {
              id: "model",
              desiredValue: null,
              effectiveValue: null,
              applicationState: "effective",
            },
            {
              id: "thinking_level",
              desiredValue: null,
              effectiveValue: null,
              applicationState: "effective",
            },
            {
              id: "tool_access",
              desiredValue: "read_only",
              effectiveValue: "read_only",
              applicationState: "effective",
            },
          ],
        },
        settingDescriptors: [
          { id: "model", available: true },
          { id: "thinking_level", available: false },
          { id: "tool_access", available: true },
        ],
        composerCommands: [{ invocation: "/compact", source: "prompt" }],
      });
      await expect(
        presentation.readCached(current.scope, current.threadId),
      ).resolves.toMatchObject({
        backend: { label: { text: "Primary Pi" }, brand: "pi" },
        settings: { revision: 0 },
      });
      current.database
        .prepare(
          `
            UPDATE workspaces
            SET revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.workspaceId,
        );
      const conservativePresentation = await presentation.readCached(
        current.scope,
        current.threadId,
      );
      expect(conservativePresentation).toMatchObject({
        backend: { label: { text: "Primary Pi" }, brand: "pi" },
        settingDescriptors: [
          { id: "model", available: false },
          { id: "thinking_level", available: true },
          { id: "tool_access", available: true },
        ],
        composerCommands: [],
      });
      expect(conservativePresentation.settings).toEqual(
        freshPresentation.settings,
      );
      discoveredInventory.updateEnvironmentAvailability(
        current.scope,
        current.environmentId,
        { available: false, now: 500 },
      );
      await expect(
        presentation.read(current.scope, current.threadId),
      ).resolves.toMatchObject({
        backend: { label: { text: "Primary Pi" } },
        settingDescriptors: [
          { id: "model", available: false },
          { id: "thinking_level", available: true },
          { id: "tool_access", available: true },
        ],
        composerCommands: [],
      });
    } finally {
      current.database.close();
    }
  });
});

describe("nonblocking question notifications", () => {
  it("dispatches one content-free notification per request and preserves scope, silence, and history suppression", async () => {
    const current = fixture();
    const executor = vi
      .fn<typeof executeNotificationScript>()
      .mockResolvedValue({
        success: true,
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: null,
      });
    let now = 500;
    const service = new NotificationService({
      repository: new NotificationRepository(current.database),
      executor,
      now: () => now,
    });
    const flush = async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };
    try {
      service.update(current.scope, {
        enabled: true,
        assistantResultPhases: [],
        scriptPath: "/usr/local/bin/notify",
        arguments: [],
        timeoutSeconds: 30,
        expectedRevision: 0,
        events: ["question.requested"],
      });
      const observer = new NotificationLifecycleObserver(
        new InventoryRepository(current.database),
        (scope, payload, key, result) => service.emit(scope, payload, key, result),
      );
      const request = {
        id: "application-question",
        threadId: current.threadId,
        questionCount: 3,
        createdAt: new Date(501).toISOString(),
        questions: ["Private prompt"],
        answers: ["Private answer"],
      };
      observer.questionOpened(current.scope, request);
      observer.questionOpened(current.scope, request);
      await flush();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor.mock.calls[0]![0].payload).toEqual({
        schemaVersion: 3,
        notificationId: expect.any(String),
        event: "question.requested",
        occurredAt: request.createdAt,
        title: "Nonblocking questions",
        message: "Normalized thread",
        thread: { id: current.threadId, title: "Normalized thread" },
        workspace: { id: current.workspaceId, name: "Temporary workspace" },
        question: { id: request.id, questionCount: 3 },
      });
      observer.questionOpened(
        { ...current.scope, principalId: "another-principal" },
        { ...request, id: "wrong-principal" },
      );
      observer.questionOpened(
        { ...current.scope, tenantId: "another-tenant" },
        { ...request, id: "wrong-tenant" },
      );
      observer.questionOpened(current.scope, {
        ...request,
        id: "historical",
        createdAt: new Date(499).toISOString(),
      });
      service.setSilenced(current.scope, true);
      observer.questionOpened(current.scope, { ...request, id: "muted" });
      now = 502;
      service.setSilenced(current.scope, false);
      observer.questionOpened(current.scope, { ...request, id: "muted" });
      observer.questionOpened(current.scope, request);
      await flush();
      expect(executor).toHaveBeenCalledTimes(1);
      observer.questionOpened(current.scope, {
        ...request,
        id: "next-request",
        createdAt: new Date(503).toISOString(),
      });
      await flush();
      expect(executor).toHaveBeenCalledTimes(2);
    } finally {
      await service.close();
      current.database.close();
    }
  });
});

function notificationInteraction(
  threadId: string,
  kind: BackendInteraction["kind"],
): BackendInteraction {
  const privateText = { text: "Private prompt contents" };
  const fields = {
    choice: {
      options: [{ id: "option", label: privateText }],
      multiple: false,
    },
    confirmation: { message: privateText },
    text_input: { initialValue: privateText, multiline: false },
    editor: { initialValue: privateText },
    form: { fields: [{ id: "field", label: privateText, required: true, input: { kind: "text" } }] },
    decision: {
      code: privateText,
      actions: [{ id: "action", label: privateText, role: "primary" }],
    },
    questionnaire: {
      questions: [
        {
          id: "question",
          header: privateText,
          prompt: privateText,
          secret: true,
          input: { kind: "text", multiline: false },
        },
      ],
    },
  };
  return backendInteractionSchema.parse({
    id: `normalized-${kind}`,
    threadId,
    kind,
    sourceLabel: privateText,
    title: privateText,
    openedAt: new Date(600).toISOString(),
    secret: true,
    destructive: true,
    cancellable: true,
    ...fields[kind],
  });
}

describe("passive lifecycle notification sources", () => {
  it.each([
    ["decision", "approval.requested"],
    ["confirmation", "approval.requested"],
    ["choice", "input.requested"],
    ["text_input", "input.requested"],
    ["editor", "input.requested"],
    ["questionnaire", "input.requested"],
    ["form", "input.requested"],
  ] as const)(
    "projects %s to %s without prompt contents or cross-scope access",
    (kind, event) => {
      const current = fixture();
      try {
        const emit = vi.fn();
        const observer = new NotificationLifecycleObserver(
          new InventoryRepository(current.database),
          emit,
        );
        const interaction = notificationInteraction(current.threadId, kind);
        observer.interactionOpened(current.scope, interaction);
        expect(emit).toHaveBeenCalledOnce();
        expect(emit.mock.calls[0]!.slice(0, 2)).toMatchObject([
          current.scope,
          {
            event,
            occurredAt: interaction.openedAt,
            thread: { id: current.threadId, title: "Normalized thread" },
            workspace: { id: current.workspaceId, name: "Temporary workspace" },
            interaction: { id: interaction.id, kind },
          },
        ]);
        expect(JSON.stringify(emit.mock.calls)).not.toContain(
          "Private prompt contents",
        );
        observer.interactionOpened(
          { ...current.scope, principalId: "other" },
          interaction,
        );
        observer.interactionOpened(
          { ...current.scope, tenantId: "other" },
          interaction,
        );
        observer.interactionOpened(current.scope, {
          ...interaction,
          threadId: "missing",
        });
        expect(emit).toHaveBeenCalledOnce();
        emit.mockImplementation(() => {
          throw new Error("Notification unavailable");
        });
        expect(() =>
          observer.interactionOpened(current.scope, interaction),
        ).not.toThrow();
      } finally {
        current.database.close();
      }
    },
  );

  it("dispatches selected blocking interactions once and drops silenced occurrences without a backlog", async () => {
    const current = fixture();
    const executor = vi
      .fn<typeof executeNotificationScript>()
      .mockResolvedValue({
        success: true,
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: null,
      });
    const service = new NotificationService({
      repository: new NotificationRepository(current.database),
      executor,
      now: () => 500,
    });
    try {
      service.update(current.scope, {
        enabled: true,
        assistantResultPhases: [],
        scriptPath: "/usr/local/bin/notify",
        arguments: [],
        timeoutSeconds: 30,
        expectedRevision: 0,
        events: ["approval.requested", "input.requested"],
      });
      const observer = new NotificationLifecycleObserver(
        new InventoryRepository(current.database),
        (scope, payload, key, result) => service.emit(scope, payload, key, result),
      );
      const broker = new InteractionBroker({
        onOpened: (scope, interaction) =>
          observer.interactionOpened(scope, interaction),
      });
      let listener: ConversationActorListener | undefined;
      const binding = broker.bind(
        current.scope,
        current.threadId,
        {
          subscribe: (next) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          respond: async () => {},
          interruptForInteractionFailure: async () => {},
        },
        { opened: () => {}, resolved: () => {} },
      );
      const common = {
        sourceLabel: { text: "Private provider label" },
        title: { text: "Private prompt contents" },
        openedAt: new Date(600).toISOString(),
        secret: true,
        destructive: false,
        cancellable: true,
      };
      const approval: DriverInteraction = {
        ...common,
        backendInteractionId: "native-approval",
        kind: "confirmation",
        message: { text: "Private prompt contents" },
      };
      const question: DriverInteraction = {
        ...common,
        backendInteractionId: "native-question",
        kind: "text_input",
        multiline: false,
        initialValue: { text: "Private initial answer" },
      };
      const open = (interaction: DriverInteraction) =>
        listener?.({
          type: "backend_event",
          generation: "generation-1",
          event: { type: "interaction_opened", interaction },
        });
      try {
        open(approval);
        open(approval);
        open(question);
        binding.publishPending();
        await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
        expect(
          executor.mock.calls.map(([input]) => input.payload.event),
        ).toEqual(["approval.requested", "input.requested"]);
        const payloads = executor.mock.calls.map(([input]) => input.payload);
        expect(JSON.stringify(payloads)).not.toContain("Private");
        expect(JSON.stringify(payloads)).not.toContain("native-");
        service.setSilenced(current.scope, true);
        const silencedQuestion = {
          ...question,
          backendInteractionId: "native-silenced-question",
        };
        open(silencedQuestion);
        service.setSilenced(current.scope, false);
        open(silencedQuestion);
        binding.publishPending();
        open({ ...question, backendInteractionId: "native-new-question" });
        await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(3));
        expect(executor.mock.calls[2]![0].payload.event).toBe(
          "input.requested",
        );
        expect(executor.mock.calls[2]![0].payload.interaction?.id).not.toBe(
          payloads[1]!.interaction?.id,
        );
      } finally {
        await binding.release();
        await broker.close();
      }
    } finally {
      await service.close();
      current.database.close();
    }
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "projects finalized %s once per normalized turn key, independent of acknowledgment",
    (outcome) => {
      const current = fixture();
      try {
        const inventory = new InventoryRepository(current.database);
        const completion = new SubmissionCompletionRepository(current.database);
        const emit = vi.fn();
        const observer = new NotificationLifecycleObserver(inventory, emit);
        new ConversationBindingRepository(
          current.database,
        ).bindDiscoveredConversation(current.scope, current.threadId, {
          backendConversationId: "private-conversation",
          now: 450,
        });
        completion.recordAccepted(current.scope, current.threadId, {
          operationId: "accepted-operation",
          acceptedAt: 500,
          backendCorrelation: "private-correlation",
        });
        const partial = completion.observeCompletion(
          current.scope,
          current.threadId,
          "accepted-operation",
          {
            completionIdentity: "private-terminal",
            observedAt: 600,
            createAttention: true,
          },
        );
        observer.completion(current.scope, partial);
        expect(emit).not.toHaveBeenCalled();
        const input = {
          backendCorrelation: "private-correlation",
          completionIdentity: "private-terminal",
          observedAt: 650,
          applicationTurnId: "normalized-turn",
          outcome,
          result: { text: "Private assistant transcript" },
          classifiedResult: { provisional: null, final: { text: "Private assistant transcript" }, unclassified: null },
        };
        const finalized = completion.observeBackendCompletion(
          current.scope,
          current.threadId,
          input,
        )!;
        observer.completion(current.scope, finalized);
        completion.acknowledgeThrough(
          current.scope,
          current.threadId,
          "accepted-operation",
          700,
        );
        observer.completion(
          current.scope,
          completion.observeBackendCompletion(
            current.scope,
            current.threadId,
            input,
          )!,
        );
        completion.recordAccepted(current.scope, current.threadId, {
          operationId: "steered-operation",
          acceptedAt: 501,
          backendCorrelation: "private-steer",
        });
        observer.completion(
          current.scope,
          completion.observeBackendCompletion(current.scope, current.threadId, {
            ...input,
            backendCorrelation: "private-steer",
          })!,
        );
        expect(emit).toHaveBeenCalledTimes(3);
        expect(new Set(emit.mock.calls.map((call) => call[2])).size).toBe(1);
        expect(emit.mock.calls[0]![1]).toMatchObject({
          event: `turn.${outcome}`,
          occurredAt: new Date(600).toISOString(),
          thread: { id: current.threadId, title: "Normalized thread" },
          workspace: { id: current.workspaceId, name: "Temporary workspace" },
          turn: { id: "normalized-turn", outcome },
        });
        expect(JSON.stringify(emit.mock.calls)).not.toContain("private-");
        expect(emit.mock.calls[0]![3]).toEqual(input.classifiedResult);
        expect(JSON.stringify(emit.mock.calls.map((call) => call[1]))).not.toContain(
          "Private assistant transcript",
        );
        observer.completion(
          { ...current.scope, principalId: "other" },
          finalized,
        );
        expect(emit).toHaveBeenCalledTimes(3);
        expect(
          completion.observeBackendCompletion(current.scope, current.threadId, {
            ...input,
            backendCorrelation: "unaccepted-import",
          }),
        ).toBeUndefined();
      } finally {
        current.database.close();
      }
    },
  );

  it("freezes classified completion snapshots and leaves historical classification unavailable", () => {
    const current = fixture();
    try {
      const completion = new SubmissionCompletionRepository(current.database);
      completion.recordAccepted(current.scope, current.threadId, { operationId: "classified", acceptedAt: 500 });
      const finalized = {
        applicationTurnId: "turn", outcome: "completed" as const,
        result: { text: "Checking\n\nDone" },
        classifiedResult: { provisional: { text: "Checking" }, final: { text: "Done" }, unclassified: null },
      };
      const input = { completionIdentity: "complete", observedAt: 600, createAttention: false, finalized };
      const observe = () => completion.observeCompletion(current.scope, current.threadId, "classified", input);
      expect(observe().classifiedResult).toEqual(finalized.classifiedResult);
      finalized.classifiedResult.final.text = "Changed";
      expect(() => observe()).toThrow("different finalized completion snapshot");
      expect(completion.get(current.scope, current.threadId, "classified").classifiedResult?.final?.text).toBe("Done");
      finalized.classifiedResult.final.text = "Done";
      expect(() => completion.get({ ...current.scope, principalId: "other" }, current.threadId, "classified")).toThrow();
      // Simulate a finalized pre-migration record; replay must never reclassify it.
      current.database.prepare("UPDATE submission_completion_observations SET classified_result_json = NULL WHERE operation_id = ?").run("classified");
      expect(observe().classifiedResult).toBeNull();
      expect(observe().assistantResult).toEqual(finalized.result);
    } finally { current.database.close(); }
  });

  it("notifies deadline wakes after commit without a browser, even when its observer fails", async () => {
    const current = fixture();
    try {
      const inventory = new InventoryRepository(current.database);
      const emit = vi.fn(
        (..._args: Parameters<NotificationLifecycleObserver["emit"]>) => {
          expect(current.database.inTransaction).toBe(false);
          throw new Error("script unavailable");
        },
      );
      const observer = new NotificationLifecycleObserver(inventory, emit);
      const service = new InventoryService(
        inventory,
        {
          publishMany() {},
          publishApplicationThread() {},
        },
        (scope, state) => observer.deadlineWake(scope, state),
      );
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 0,
          mutationId: "snooze-notification",
          change: {
            action: "snooze",
            snoozedUntil: 1000,
            wakeReminderText: "Review this",
          },
        },
        500,
      );
      expect(emit).not.toHaveBeenCalled();
      await service.wakeDue(999);
      expect(emit).not.toHaveBeenCalled();
      await expect(service.wakeDue(1100)).resolves.toHaveLength(1);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]!.slice(0, 2)).toMatchObject([
        current.scope,
        {
          event: "thread.woke",
          message: "Review this",
          wake: { reason: "deadline", reminderText: "Review this" },
        },
      ]);
      await service.wakeDue(1200);
      await service.transition(
        current.scope,
        current.threadId,
        {
          expectedRevision: 2,
          mutationId: "snooze-until-completion",
          change: {
            action: "snooze",
            snoozedUntil: 2000,
          },
        },
        1250,
      );
      await service.wakeForRuntimeSignal(
        current.scope,
        current.threadId,
        "completion",
        1300,
      );
      expect(emit).toHaveBeenCalledOnce();
      expect(
        inventory.getInventory(current.scope, current.threadId).inventoryState,
      ).toBe("active");
    } finally {
      current.database.close();
    }
  });
});
