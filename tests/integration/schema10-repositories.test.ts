import { randomUUID } from "node:crypto";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { serializePiBindingDetail } from "../../src/server/backends/pi/pi-session-store.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { ComposerAttachmentRepository } from "../../src/server/db/repositories/composer-attachment-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { ConversationTurnBookmarkRepository } from "../../src/server/db/repositories/conversation-turn-bookmark-repository.js";
import { ConnectionSettingPreferenceRepository } from "../../src/server/db/repositories/connection-setting-preference-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import {
  QueuedInputRepository,
  type QueueRetryPolicy,
} from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { DeliveryInputSnapshotRepository } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { presentTask } from "../../src/server/application/task-presentation.js";
import {
  composerInputUtf8Bytes,
  MAXIMUM_COMPOSER_INPUT_BYTES,
} from "../../src/shared/protocol/context-excerpts.js";

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

describe("thread completion callback persistence", () => {
  it("materializes a finalized callback into exactly one provenance-bearing queue row", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const bindings = new ConversationBindingRepository(fixture.database);
      const pi = new PiConversationRepository(fixture.database);
      fixture.database.transaction(() => {
        const backendConversationId = `session-${fixture.secondThreadId}`;
        bindings.bindDiscoveredConversation(
          fixture.scope,
          fixture.secondThreadId,
          { backendConversationId, now: 510 },
        );
        pi.saveBindingDetails(fixture.scope, fixture.secondThreadId, {
          backendConversationId,
          opaqueBindingDetail: serializePiBindingDetail(
            backendConversationId,
            `/tmp/${fixture.secondThreadId}.jsonl`,
          ),
          nativeSessionPath: `/tmp/${fixture.secondThreadId}.jsonl`,
        });
      })();

      const callbacks = new ThreadCompletionCallbackRepository(
        fixture.database,
      );
      const completion = new SubmissionCompletionRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const callbackId = "018f47cb-5f45-7f93-8d8d-bdb808b1f031";
      expect(
        callbacks.register(fixture.scope, {
          id: callbackId,
          callerThreadId: fixture.secondThreadId,
          targetThreadId: fixture.threadId,
          targetOperationId: "callback-target-operation",
          registeredAt: 600,
        }),
      ).toMatchObject({ replayed: false, callback: { state: "registered" } });
      expect(
        callbacks.register(fixture.scope, {
          id: callbackId,
          callerThreadId: fixture.secondThreadId,
          targetThreadId: fixture.threadId,
          targetOperationId: "callback-target-operation",
          registeredAt: 999,
        }),
      ).toMatchObject({ replayed: true, callback: { id: callbackId } });
      expect(() =>
        callbacks.register(fixture.scope, {
          callerThreadId: fixture.threadId,
          targetThreadId: fixture.threadId,
          targetOperationId: "self-callback-operation",
          registeredAt: 601,
        }),
      ).toThrow(/cannot register.*itself/i);
      expect(
        callbacks.find(
          {
            tenantId: fixture.scope.tenantId,
            principalId: "different-principal",
          },
          callbackId,
        ),
      ).toBeUndefined();
      completion.recordAccepted(fixture.scope, fixture.threadId, {
        operationId: "callback-target-operation",
        acceptedAt: 610,
        backendCorrelation: "callback-target-correlation",
      });
      completion.observeCompletion(
        fixture.scope,
        fixture.threadId,
        "callback-target-operation",
        {
          completionIdentity: "callback-completion-identity",
          observedAt: 620,
          createAttention: true,
          finalized: {
            applicationTurnId: "callback-target-turn",
            outcome: "completed",
            result: { text: "Target result" },
            classifiedResult: null,
          },
        },
      );
      expect(
        callbacks.listReadyForMaterialization(fixture.scope),
      ).toMatchObject([
        {
          callback: { id: callbackId },
          applicationTurnId: "callback-target-turn",
          result: { text: "Target result" },
        },
      ]);

      const callerRevision = (
        fixture.database
          .prepare(
            `SELECT revision FROM application_threads
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.secondThreadId,
          ) as { revision: number }
      ).revision;
      const materialized = queue.enqueue(
        fixture.scope,
        fixture.secondThreadId,
        {
          id: "callback-queue-item",
          mutationId: "callback-queue-operation",
          text: "Agent result from Repository fixture:\n\nTarget result",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "completion_callback",
            expectedThreadRevision: callerRevision,
            callbackId,
            completionIdentity: "callback-completion-identity",
            sourceThreadLabel: { text: "Repository fixture" },
            requestedDeliveryMode: "submit",
            resolvedDeliveryMode: "submit",
          },
          now: 630,
        },
      );
      expect(materialized.item).toMatchObject({
        completionCallbackId: callbackId,
        inputOrigin: {
          kind: "agent_result",
          callbackId,
          sourceThreadId: fixture.threadId,
          sourceThreadLabel: { text: "Repository fixture" },
        },
      });
      expect(callbacks.get(fixture.scope, callbackId)).toMatchObject({
        state: "materialized",
        completionIdentity: "callback-completion-identity",
      });
      expect(callbacks.listReadyForMaterialization(fixture.scope)).toEqual([]);
      expect(() =>
        queue.restoreIdempotently(
          fixture.scope,
          fixture.secondThreadId,
          "callback-queue-item",
          {
            mutationId: "restore-callback-input",
            expectedThreadRevision: callerRevision + 1,
            expectedDraftRevision: 0,
            now: 640,
          },
        ),
      ).toThrow(/browser-origin user queued input/i);
    } finally {
      fixture.database.close();
    }
  });
});

function operatorBackend<T extends { readonly protocolRelease: string }>(
  backend: T,
): Omit<T, "protocolRelease"> {
  const { protocolRelease: _protocolRelease, ...configured } = backend;
  return configured;
}

describe("persistent thread groups", () => {
  it("keeps empty groups, preserves archived membership, and deletes explicitly", () => {
    const fixture = createFixture();
    try {
      const groups = new ThreadGroupRepository(fixture.database);
      const created = groups.createAndAssign(fixture.scope, fixture.threadId, {
        name: "Design",
        expectedRevision: 0,
        mutationId: "group-create",
        now: 400,
      });
      expect(groups.list(fixture.scope)).toMatchObject([
        { id: created.groupId, name: "Design", memberCount: 1 },
      ]);

      groups.assign(fixture.scope, fixture.threadId, {
        groupId: null,
        expectedRevision: 1,
        mutationId: "group-remove",
        now: 410,
      });
      expect(groups.list(fixture.scope)).toMatchObject([
        { id: created.groupId, memberCount: 0, activeMemberCount: 0 },
      ]);
      expect(() =>
        groups.createAndAssign(fixture.scope, fixture.threadId, {
          name: " design ",
          expectedRevision: 2,
          mutationId: "group-duplicate",
          now: 420,
        }),
      ).toThrowError(expect.objectContaining({ code: "group_name_conflict" }));

      groups.assign(fixture.scope, fixture.secondThreadId, {
        groupId: created.groupId,
        expectedRevision: 0,
        mutationId: "group-reassign",
        now: 430,
      });
      fixture.database
        .prepare(
          `UPDATE thread_principal_state SET inventory_state = 'archived'
           WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.secondThreadId,
        );
      expect(groups.list(fixture.scope)).toMatchObject([
        { id: created.groupId, memberCount: 1, activeMemberCount: 0 },
      ]);

      groups.delete(fixture.scope, created.groupId!, {
        expectedRevision: 0,
        expectedMemberCount: 1,
        mutationId: "group-delete",
        now: 440,
      });
      expect(groups.list(fixture.scope)).toEqual([]);
      expect(
        groups.getAssignment(fixture.scope, fixture.secondThreadId),
      ).toEqual({
        threadId: fixture.secondThreadId,
        groupId: null,
        revision: 2,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("enforces revisions and mutation-receipt replay", () => {
    const fixture = createFixture();
    try {
      const groups = new ThreadGroupRepository(fixture.database);
      const createInput = {
        name: "Reusable",
        expectedRevision: 0,
        mutationId: "group-replay-create",
        now: 450,
      } as const;
      const created = groups.createAndAssign(
        fixture.scope,
        fixture.threadId,
        createInput,
      );
      expect(
        groups.createAndAssign(fixture.scope, fixture.threadId, createInput),
      ).toEqual({ ...created, replayed: true });
      expect(
        groups.getAssignment(fixture.scope, fixture.threadId).revision,
      ).toBe(1);
      expect(groups.list(fixture.scope)).toHaveLength(1);

      expect(() =>
        groups.createAndAssign(fixture.scope, fixture.threadId, {
          ...createInput,
          name: "Different request",
        }),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
      expect(() =>
        groups.assign(fixture.scope, fixture.threadId, {
          groupId: null,
          expectedRevision: 0,
          mutationId: "group-stale-assignment",
          now: 460,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "group_assignment_revision_conflict" }),
      );
      expect(() =>
        groups.rename(fixture.scope, created.groupId!, {
          name: "Renamed",
          expectedRevision: 1,
          mutationId: "group-stale-rename",
          now: 470,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "group_revision_conflict" }),
      );

      const renameInput = {
        name: "Renamed",
        expectedRevision: 0,
        mutationId: "group-replay-rename",
        now: 480,
      } as const;
      const renamed = groups.rename(
        fixture.scope,
        created.groupId!,
        renameInput,
      );
      expect(
        groups.rename(fixture.scope, created.groupId!, renameInput),
      ).toEqual({ ...renamed, replayed: true });
      expect(() =>
        groups.delete(fixture.scope, created.groupId!, {
          expectedRevision: 1,
          expectedMemberCount: 0,
          mutationId: "group-stale-member-count",
          now: 490,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "group_revision_conflict" }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("normalizes before enforcing name bounds and cascades hard deletion", () => {
    const fixture = createFixture();
    try {
      const groups = new ThreadGroupRepository(fixture.database);
      expect(() =>
        groups.createAndAssign(fixture.scope, fixture.threadId, {
          name: "\uFDFA".repeat(120),
          expectedRevision: 0,
          mutationId: "group-expanded-name",
          now: 500,
        }),
      ).toThrowError(expect.objectContaining({ code: "bad_request" }));

      const created = groups.createAndAssign(
        fixture.scope,
        fixture.secondThreadId,
        {
          name: "Temporary child",
          expectedRevision: 0,
          mutationId: "group-hard-delete",
          now: 510,
        },
      );
      fixture.database
        .prepare(
          `DELETE FROM thread_drafts
           WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.secondThreadId,
        );
      fixture.database
        .prepare(
          `DELETE FROM thread_principal_state
           WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.secondThreadId,
        );
      expect(groups.get(fixture.scope, created.groupId!)).toMatchObject({
        memberCount: 0,
        activeMemberCount: 0,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("denies another principal access to group membership", () => {
    const fixture = createFixture();
    try {
      const groups = new ThreadGroupRepository(fixture.database);
      groups.createAndAssign(fixture.scope, fixture.threadId, {
        name: "Private",
        expectedRevision: 0,
        mutationId: "group-private",
        now: 500,
      });
      const foreignScope = {
        tenantId: fixture.scope.tenantId,
        principalId: "foreign-principal",
      };
      expect(groups.list(foreignScope)).toEqual([]);
      expect(() =>
        groups.getAssignment(foreignScope, fixture.threadId),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      fixture.database.close();
    }
  });
});

describe("conversation turn bookmarks", () => {
  it("persists bounded previews with atomic revision and replay semantics", () => {
    const fixture = createFixture();
    try {
      const bookmarks = new ConversationTurnBookmarkRepository(
        fixture.database,
        new InventoryRepository(fixture.database),
      );
      const mutationId = "11111111-1111-4111-8111-111111111176";
      const created = bookmarks.set(
        fixture.scope,
        fixture.threadId,
        "turn-durable-one",
        {
          bookmarked: true,
          expectedRevision: 0,
          mutationId,
          userPreview: "How should bookmarks work?",
          assistantPreview: "Use the durable enclosing turn.",
          responseState: "responded",
        },
        700,
      );
      expect(created).toEqual({
        revision: 1,
        bookmark: {
          turnId: "turn-durable-one",
          userPreview: "How should bookmarks work?",
          assistantPreview: "Use the durable enclosing turn.",
          responseState: "responded",
          createdAt: 700,
        },
        replayed: false,
      });
      expect(
        bookmarks.set(
          fixture.scope,
          fixture.threadId,
          "turn-durable-one",
          {
            bookmarked: true,
            expectedRevision: 0,
            mutationId,
            userPreview: "How should bookmarks work?",
            assistantPreview: "Use the durable enclosing turn.",
            responseState: "responded",
          },
          800,
        ),
      ).toEqual({ ...created, replayed: true });
      expect(bookmarks.list(fixture.scope, fixture.threadId)).toEqual({
        revision: 1,
        bookmarks: [created.bookmark],
      });
      expect(() =>
        bookmarks.set(
          fixture.scope,
          fixture.threadId,
          "turn-durable-one",
          {
            bookmarked: false,
            expectedRevision: 0,
            mutationId: "22222222-2222-4222-8222-222222222276",
          },
          900,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "bookmark_revision_conflict" }),
      );
      expect(() =>
        bookmarks.set(
          fixture.scope,
          fixture.threadId,
          "turn-durable-two",
          {
            bookmarked: false,
            expectedRevision: 1,
            mutationId,
          },
          900,
        ),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
    } finally {
      fixture.database.close();
    }
  });

  it("denies the wrong principal scope and declares cascading thread ownership", () => {
    const fixture = createFixture();
    try {
      const bookmarks = new ConversationTurnBookmarkRepository(
        fixture.database,
        new InventoryRepository(fixture.database),
      );
      bookmarks.set(
        fixture.scope,
        fixture.threadId,
        "turn-durable-one",
        {
          bookmarked: true,
          expectedRevision: 0,
          mutationId: "33333333-3333-4333-8333-333333333376",
          userPreview: "User preview",
          assistantPreview: null,
          responseState: "no_response",
        },
        700,
      );
      const foreignScope = {
        tenantId: fixture.scope.tenantId,
        principalId: "foreign-principal",
      };
      expect(() => bookmarks.list(foreignScope, fixture.threadId)).toThrowError(
        expect.objectContaining({ code: "not_found" }),
      );

      for (const table of [
        "conversation_turn_bookmarks",
        "conversation_turn_bookmark_mutation_receipts",
      ]) {
        const foreignKeys = fixture.database
          .prepare(`PRAGMA foreign_key_list(${table})`)
          .all() as { table: string; on_delete: string }[];
        expect(foreignKeys).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table: "thread_principal_state",
              on_delete: "CASCADE",
            }),
          ]),
        );
      }
    } finally {
      fixture.database.close();
    }
  });

  it("updates an existing bookmark when the thread is at capacity", () => {
    const fixture = createFixture();
    try {
      const bookmarks = new ConversationTurnBookmarkRepository(
        fixture.database,
        new InventoryRepository(fixture.database),
      );
      bookmarks.set(
        fixture.scope,
        fixture.threadId,
        "turn-at-capacity",
        {
          bookmarked: true,
          expectedRevision: 0,
          mutationId: "44444444-4444-4444-8444-444444444476",
          userPreview: "Original preview",
          assistantPreview: null,
          responseState: "no_response",
        },
        700,
      );
      const insert = fixture.database.prepare(`
        INSERT INTO conversation_turn_bookmarks(
          tenant_id, principal_id, thread_id, turn_id, user_preview,
          assistant_preview, response_state, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'no_response', ?)
      `);
      fixture.database.transaction(() => {
        for (let index = 1; index < 500; index += 1) {
          insert.run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
            `capacity-turn-${index}`,
            `Preview ${index}`,
            700 + index,
          );
        }
      })();

      expect(
        bookmarks.set(
          fixture.scope,
          fixture.threadId,
          "turn-at-capacity",
          {
            bookmarked: true,
            expectedRevision: 1,
            mutationId: "55555555-5555-4555-8555-555555555576",
            userPreview: "Updated preview",
            assistantPreview: "Updated response",
            responseState: "responded",
          },
          1_300,
        ),
      ).toMatchObject({
        revision: 2,
        replayed: false,
        bookmark: {
          turnId: "turn-at-capacity",
          userPreview: "Updated preview",
          assistantPreview: "Updated response",
          responseState: "responded",
          createdAt: 700,
        },
      });
    } finally {
      fixture.database.close();
    }
  });
});

type Fixture = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly secondThreadId: string;
  readonly workspaceId: string;
  readonly secondWorkspaceId: string;
};

function createFixture(maximumMigrationVersion = Number.POSITIVE_INFINITY): Fixture {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/schema10-repositories",
      displayName: "Schema 10 repositories",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const secondWorkspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/schema10-repositories-second",
      displayName: "Second schema 10 workspace",
      availability: "available",
      trustState: "trusted",
    },
    110,
  );
  const thread = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Repository fixture" },
    200,
  );
  inventory.saveDraft(
    scope,
    thread.thread.id,
    { text: "durable initial input", expectedRevision: 0 },
    210,
  );
  const secondThread = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Second repository fixture" },
    220,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations.filter(({ version }) => version <= maximumMigrationVersion));
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "schema10-repositories" }, 300);
  new InventoryRepository(database).updateEnvironmentAvailability(scope, environment.id, { available: true, now: 300 });
  return {
    database,
    scope,
    threadId: thread.thread.id,
    secondThreadId: secondThread.thread.id,
    workspaceId: workspace.id,
    secondWorkspaceId: secondWorkspace.id,
  };
}

function bindDiscovered(fixture: Fixture): ConversationBindingRepository {
  const bindings = new ConversationBindingRepository(fixture.database);
  const pi = new PiConversationRepository(fixture.database);
  fixture.database.transaction(() => {
    bindings.bindDiscoveredConversation(fixture.scope, fixture.threadId, {
      backendConversationId: `session-${fixture.threadId}`,
      now: 500,
    });
    const backendConversationId = `session-${fixture.threadId}`;
    const nativeSessionPath = `/tmp/${fixture.threadId}.jsonl`;
    pi.saveBindingDetails(fixture.scope, fixture.threadId, {
      backendConversationId,
      opaqueBindingDetail: serializePiBindingDetail(
        backendConversationId,
        nativeSessionPath,
      ),
      nativeSessionPath,
    });
  })();
  return bindings;
}

function threadRevision(fixture: Fixture): number {
  return (
    fixture.database
      .prepare(
        `
          SELECT revision
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(
        fixture.scope.tenantId,
        fixture.scope.principalId,
        fixture.threadId,
      ) as { revision: number }
  ).revision;
}

function inventoryGeneration(fixture: Fixture): number {
  return (
    fixture.database
      .prepare(
        `SELECT inventory_generation AS generation
         FROM principal_generations
         WHERE tenant_id = ? AND principal_id = ?`,
      )
      .get(fixture.scope.tenantId, fixture.scope.principalId) as {
      generation: number;
    }
  ).generation;
}

describe("discovered thread revisions", () => {
  it("admits the initial composer input after unchanged rediscovery", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const before = inventory.getThread(fixture.scope, fixture.threadId);
      const generation = inventoryGeneration(fixture);

      for (const [index, observed] of [
        { title: before.thread.title, updatedAt: before.thread.lastActivityAt },
        { updatedAt: before.thread.lastActivityAt },
        {
          title: before.thread.title,
          updatedAt: before.thread.lastActivityAt - 1,
        },
        { updatedAt: before.thread.lastActivityAt - 1 },
      ].entries()) {
        const now = 600 + index;
        const reconciled = inventory.markDiscoveredAvailable(
          fixture.scope,
          fixture.threadId,
          { ...observed, now },
        );
        expect(reconciled.thread).toMatchObject({
          title: before.thread.title,
          availability: "available",
          lastActivityAt: before.thread.lastActivityAt,
          revision: before.thread.revision,
          reconciliationAt: now,
        });
        expect(inventoryGeneration(fixture)).toBe(generation);
      }

      const accepted = queue.enqueue(fixture.scope, fixture.threadId, {
        mutationId: "submit-after-unchanged-rediscovery",
        text: before.draft.text,
        contextExcerpts: before.draft.contextExcerpts,
        attachmentIds: before.draft.attachments.map(({ id }) => id),
        taskReferences: before.draft.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "submit",
          resolvedDeliveryMode: "submit",
          expectedThreadRevision: before.thread.revision,
          expectedDraftRevision: before.draft.revision,
        },
        now: 610,
      });
      expect(accepted.item).toMatchObject({
        text: before.draft.text,
        requestedDeliveryMode: "submit",
        resolvedDeliveryMode: "submit",
        requestedThreadRevision: before.thread.revision,
      });
      expect(inventory.getDraft(fixture.scope, fixture.threadId)).toMatchObject({
        text: "",
        revision: before.draft.revision + 1,
      });
    } finally {
      fixture.database.close();
    }
  });

  it.each(["title", "availability", "activity"] as const)(
    "rejects stale composer input after discovery changes %s",
    (dimension) => {
      const fixture = createFixture();
      try {
        bindDiscovered(fixture);
        const inventory = new InventoryRepository(fixture.database);
        const queue = new QueuedInputRepository(fixture.database);
        if (dimension === "availability") {
          const { thread } = inventory.getThread(
            fixture.scope,
            fixture.threadId,
          );
          inventory.finishDiscovery(
            fixture.scope,
            thread.environmentId,
            fixture.workspaceId,
            thread.backendInstanceId,
            [thread.connectionProfileId],
            new Set(),
            510,
          );
        }
        const before = inventory.getThread(fixture.scope, fixture.threadId);
        const generation = inventoryGeneration(fixture);
        const title =
          dimension === "title" ? "Renamed by provider" : before.thread.title;
        const lastActivityAt =
          before.thread.lastActivityAt + (dimension === "activity" ? 1 : 0);
        const reconciled = inventory.markDiscoveredAvailable(
          fixture.scope,
          fixture.threadId,
          {
            ...(dimension === "title" ? { title } : {}),
            updatedAt: lastActivityAt,
            now: 600,
          },
        );
        expect(reconciled.thread).toMatchObject({
          title,
          availability: "available",
          lastActivityAt,
          revision: before.thread.revision + 1,
          reconciliationAt: 600,
        });
        expect(inventoryGeneration(fixture)).toBe(generation + 1);
        expect(() =>
          queue.enqueue(fixture.scope, fixture.threadId, {
            mutationId: `submit-after-changed-${dimension}`,
            text: before.draft.text,
            contextExcerpts: before.draft.contextExcerpts,
            attachmentIds: before.draft.attachments.map(({ id }) => id),
            taskReferences: before.draft.taskReferences,
            source: {
              kind: "composer",
              requestedDeliveryMode: "submit",
              resolvedDeliveryMode: "submit",
              expectedThreadRevision: before.thread.revision,
              expectedDraftRevision: before.draft.revision,
            },
            now: 610,
          }),
        ).toThrow("The thread changed before the input could be queued.");
        expect(queue.list(fixture.scope, fixture.threadId)).toEqual([]);
        expect(inventory.getDraft(fixture.scope, fixture.threadId)).toEqual(
          before.draft,
        );
      } finally {
        fixture.database.close();
      }
    },
  );

  it("rejects wrong-scope and unbound discovery without changing inventory", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const before = inventory.getThread(fixture.scope, fixture.threadId);
      const unbound = inventory.getThread(fixture.scope, fixture.secondThreadId);
      const generation = inventoryGeneration(fixture);
      for (const scope of [
        { ...fixture.scope, tenantId: "other-tenant" },
        { ...fixture.scope, principalId: "other-principal" },
      ]) {
        expect(() =>
          inventory.markDiscoveredAvailable(scope, fixture.threadId, {
            title: "Wrong scope",
            updatedAt: 600,
            now: 600,
          }),
        ).toThrow(new DomainError("not_found", "The thread was not found."));
      }
      expect(() =>
        inventory.markDiscoveredAvailable(
          fixture.scope,
          fixture.secondThreadId,
          {
            title: "Unbound",
            updatedAt: 600,
            now: 600,
          },
        ),
      ).toThrow("Only a bound thread can be reconciled from discovery.");
      expect(inventory.getThread(fixture.scope, fixture.threadId)).toEqual(before);
      expect(inventory.getThread(fixture.scope, fixture.secondThreadId)).toEqual(
        unbound,
      );
      expect(inventoryGeneration(fixture)).toBe(generation);
    } finally {
      fixture.database.close();
    }
  });
});

function createAutomationQueueSource(
  fixture: Fixture,
  mutationId: string,
): {
  readonly automationId: string;
  readonly automationRunId: string;
  readonly claimToken: string;
} {
  const automationId = "queue-provenance-automation";
  const automationRunId = "queue-provenance-run";
  const repository = new AutomationRepository(fixture.database);
  repository.createDefinition(fixture.scope, {
    id: automationId,
    anchorThreadId: fixture.threadId,
    name: "Queue provenance",
    prompt: "Queue provenance fixture",
    precheck: null,
    runMode: "same_thread",
    enabled: true,
    schedule: { kind: "date_time", runAt: 10_000 },
    misfirePolicy: "coalesce",
    nextRunAt: 10_000,
    now: 580,
  });
  const claimToken = "queue-provenance-claim";
  repository.createManualRun(fixture.scope, automationId, {
    runId: automationRunId,
    occurrenceKey: "queue-provenance-occurrence",
    scheduledFor: 581,
    claimToken,
    leaseExpiresAt: 10_000,
    dispatchMutationId: mutationId,
    now: 581,
  });
  return { automationId, automationRunId, claimToken };
}

describe("inactive schema-10 repositories", () => {
  it("persists immutable scoped delivery input snapshots with exact replay semantics", () => {
    const fixture = createFixture();
    try {
      const repository = new DeliveryInputSnapshotRepository(fixture.database);
      const tasks = new TaskRepository(fixture.database);
      const task = presentTask(
        tasks.create(fixture.scope, {
          title: "Snapshot task",
          details: "Immutable delivery context",
          scope: { kind: "global" },
          mutationId: "delivery-snapshot-task",
          now: 600,
        }),
      );
      const excerpt = {
        id: "018f47cb-5f45-7f93-8d8d-bdb808b1f021",
        excerpt: "durable excerpt",
        note: "retain this",
        source: {
          kind: "conversation_message" as const,
          itemId: "snapshot-source-message",
          itemRevision: 1,
        },
        locator: { kind: "text_quote" as const },
      };
      const input = {
        applicationOperationId: "delivery-operation-1",
        text: "original prompt",
        selectedSkillId: "selected-skill",
        contextExcerpts: [excerpt],
        taskContexts: [task],
        attachments: [
          {
            descriptor: {
              id: "018f47cb-5f45-7f93-8d8d-bdb808b1f022",
              kind: "image" as const,
              fileName: "evidence.png",
              mediaType: "image/png" as const,
              byteSize: 123,
            },
            sha256: "a".repeat(64),
          },
        ],
        origin: {
          kind: "agent_result" as const,
          callbackId: "018f47cb-5f45-7f93-8d8d-bdb808b1f030",
          sourceThreadId: fixture.secondThreadId,
          sourceThreadLabel: { text: "Worker agent" },
        },
        createdAt: 610,
      };

      const prepared = repository.prepare(
        fixture.scope,
        fixture.threadId,
        input,
      );
      expect(prepared).toMatchObject({
        deliveryOperationId: "delivery-operation-1",
        text: "original prompt",
        selectedSkillId: "selected-skill",
        contextExcerpts: [excerpt],
        taskContexts: [task],
        attachments: input.attachments,
        origin: input.origin,
        createdAt: 610,
      });
      expect(prepared.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(Object.isFrozen(prepared.attachments)).toBe(true);

      expect(
        repository.prepare(fixture.scope, fixture.threadId, {
          ...input,
          createdAt: 999,
        }),
      ).toEqual(prepared);
      expect(() =>
        repository.prepare(fixture.scope, fixture.threadId, {
          ...input,
          text: "different prompt",
          createdAt: 999,
        }),
      ).toThrow(/different prepared input/i);

      const wrongScope = {
        tenantId: fixture.scope.tenantId,
        principalId: "someone-else",
      };
      expect(
        repository.find(wrongScope, fixture.threadId, "delivery-operation-1"),
      ).toBeUndefined();
      expect(() =>
        repository.prepare(wrongScope, fixture.threadId, {
          ...input,
          applicationOperationId: "wrong-scope-operation",
        }),
      ).toThrow(/thread was not found/i);

      expect(() =>
        fixture.database
          .prepare(
            `
              UPDATE delivery_input_snapshots SET original_text = 'mutated'
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ? AND application_operation_id = ?
            `,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
            "delivery-operation-1",
          ),
      ).toThrow(/immutable/i);
      expect(
        repository.remove(
          fixture.scope,
          fixture.threadId,
          "delivery-operation-1",
        ),
      ).toBe(true);
      expect(
        repository.find(
          fixture.scope,
          fixture.threadId,
          "delivery-operation-1",
        ),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  it("persists principal thread pins independently from inventory lifecycle", () => {
    const fixture = createFixture();
    try {
      const inventory = new InventoryRepository(fixture.database);
      const initial = inventory.getInventory(fixture.scope, fixture.threadId);
      expect(initial).toMatchObject({
        pinned: 0,
        pinRevision: 0,
        inventoryRevision: 0,
        stateChangedAt: 200,
      });

      const pinned = inventory.setThreadPinned(
        fixture.scope,
        fixture.threadId,
        {
          pinned: true,
          expectedRevision: 0,
          mutationId: "pin-thread",
          now: 400,
        },
      );
      expect(pinned).toEqual({
        pinned: true,
        pinRevision: 1,
        replayed: false,
      });
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        pinned: 1,
        pinRevision: 1,
        inventoryRevision: 0,
        stateChangedAt: 200,
      });

      for (const [index, action] of [
        "snooze",
        "wake",
        "settle",
        "archive",
        "restore",
      ].entries()) {
        const current = inventory.getInventory(fixture.scope, fixture.threadId);
        inventory.transitionInventory(fixture.scope, fixture.threadId, {
          expectedRevision: current.inventoryRevision,
          mutationId: `pin-preserving-transition-${action}`,
          change:
            action === "snooze"
              ? { action, snoozedUntil: 10_000 }
              : ({ action } as
                  | { readonly action: "wake" }
                  | { readonly action: "settle" }
                  | { readonly action: "archive" }
                  | { readonly action: "restore" }),
          now: 500 + index,
        });
        expect(
          inventory.getInventory(fixture.scope, fixture.threadId),
        ).toMatchObject({ pinned: 1, pinRevision: 1 });
      }

      const unpinned = inventory.setThreadPinned(
        fixture.scope,
        fixture.threadId,
        {
          pinned: false,
          expectedRevision: 1,
          mutationId: "unpin-archived-restored-thread",
          now: 600,
        },
      );
      expect(unpinned).toEqual({
        pinned: false,
        pinRevision: 2,
        replayed: false,
      });
      expect(
        inventory.setThreadPinned(fixture.scope, fixture.threadId, {
          pinned: false,
          expectedRevision: 1,
          mutationId: "unpin-archived-restored-thread",
          now: 700,
        }),
      ).toEqual({ pinned: false, pinRevision: 2, replayed: true });
      expect(() =>
        inventory.setThreadPinned(fixture.scope, fixture.threadId, {
          pinned: true,
          expectedRevision: 1,
          mutationId: "stale-pin-revision",
          now: 700,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "pin_revision_conflict" }),
      );
      expect(() =>
        inventory.setThreadPinned(
          { ...fixture.scope, principalId: "foreign-principal" },
          fixture.threadId,
          {
            pinned: true,
            expectedRevision: 0,
            mutationId: "foreign-pin",
            now: 700,
          },
        ),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      fixture.database.close();
    }
  });

  it("activates a settled bound thread when composer input enters the durable queue", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-submit",
          change: { action: "settle" },
          now: 510,
        },
      );
      expect(settled.state.inventoryState).toBe("settled");

      const queued = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "settled-submit",
        mutationId: "settled-submit-operation",
        text: "durable initial input",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "submit",
          resolvedDeliveryMode: "submit",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: 1,
        },
        now: 520,
      });
      expect(queued.replayed).toBe(false);
      const active = inventory.getInventory(fixture.scope, fixture.threadId);
      expect(active).toMatchObject({
        inventoryState: "active",
        inventoryRevision: settled.state.inventoryRevision + 1,
        stateChangedAt: 520,
      });

      // Provider dispatch may still be waiting; queue admission is the durable
      // Sedes acceptance boundary that consumed the composer input.
      expect(queued.item.state).toBe("pending");
      expect(
        queue.claimHead(
          fixture.scope,
          fixture.threadId,
          "settled-submit-anchor",
          530,
        )?.state,
      ).toBe("dispatching");
      queue.markAccepted(fixture.scope, fixture.threadId, queued.item.id, {
        expectedState: "dispatching",
        acceptedAt: 540,
        backendCorrelation: "settled-submit-correlation",
      });
      const settledAgain = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: active.inventoryRevision,
          mutationId: "settle-after-submit",
          change: { action: "settle" },
          now: 550,
        },
      );
      expect(
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "ignored-settled-submit-replay-id",
          mutationId: "settled-submit-operation",
          text: "durable initial input",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "submit",
            resolvedDeliveryMode: "submit",
            expectedThreadRevision: queued.item.requestedThreadRevision!,
            expectedDraftRevision: 1,
          },
          now: 580,
        }),
      ).toMatchObject({ replayed: true, item: { id: queued.item.id } });
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: settledAgain.state.inventoryRevision,
        stateChangedAt: 550,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("activates a settled bound thread for a direct agent send while it waits in queue", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-agent-send",
          change: { action: "settle" },
          now: 510,
        },
      );
      const queued = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "settled-agent-send",
        mutationId: "settled-agent-send-operation",
        text: "Agent-originated follow-up",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "agent_control",
          expectedThreadRevision: threadRevision(fixture),
          initiatingAgentThreadId: fixture.secondThreadId,
        },
        now: 520,
      });
      expect(queued.item).toMatchObject({
        state: "pending",
        initiatingAgentThreadId: fixture.secondThreadId,
        inputOrigin: {
          kind: "agent_message",
          sourceThreadId: fixture.secondThreadId,
        },
      });
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "active",
        inventoryRevision: settled.state.inventoryRevision + 1,
        stateChangedAt: 520,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("leaves a settled bound thread settled when queue admission is rejected", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-rejected-admission",
          change: { action: "settle" },
          now: 510,
        },
      );
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "rejected-settled-admission",
          mutationId: "rejected-settled-admission-operation",
          text: "Rejected before admission",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "agent_control",
            expectedThreadRevision: threadRevision(fixture) - 1,
            initiatingAgentThreadId: fixture.secondThreadId,
          },
          now: 520,
        }),
      ).toThrow("thread changed before the input could be queued");
      expect(queue.list(fixture.scope, fixture.threadId)).toEqual([]);
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: settled.state.inventoryRevision,
        stateChangedAt: 510,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("activates a settled unbound thread at first-send acceptance but not on replay", () => {
    const fixture = createFixture();
    try {
      const inventory = new InventoryRepository(fixture.database);
      const creation = new ConversationCreationRepository(fixture.database);
      const bindings = new ConversationBindingRepository(fixture.database);
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-first-send",
          change: { action: "settle" },
          now: 510,
        },
      );
      creation.prepare(fixture.scope, fixture.threadId, {
        attemptId: "settled-first-send-attempt",
        mutationId: "settled-first-send-operation",
        expectedThreadRevision: threadRevision(fixture),
        creationKind: "first_input",
        sourceKind: "agent_control",
        initiatingAgentThreadId: fixture.secondThreadId,
        initialInputText: "Start from an agent tool",
        initialAttachmentIds: [],
        backendCreationCorrelation: "settled-first-send-conversation",
        now: 520,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.threadId,
        "settled-first-send-attempt",
        530,
      );
      creation.recordConversationIdentified(
        fixture.scope,
        fixture.threadId,
        "settled-first-send-attempt",
        {
          backendConversationId: "settled-first-send-conversation",
          opaqueBindingDetail: "settled-first-send-detail",
          reconciliationToken: "settled-first-send-create-token",
          now: 540,
        },
      );
      creation.markFirstSubmissionStarted(
        fixture.scope,
        fixture.threadId,
        "settled-first-send-attempt",
        {
          reconciliationToken: "settled-first-send-submit-token",
          retryAnchor: "settled-first-send-anchor",
          now: 550,
        },
      );
      creation.markAcceptedUnpersisted(
        fixture.scope,
        fixture.threadId,
        "settled-first-send-attempt",
        {
          expected: "first_submission_started",
          acceptedAt: 560,
          reconciliationToken: "settled-first-send-submit-token",
          backendCorrelation: "settled-first-send-operation",
        },
      );
      const active = inventory.getInventory(fixture.scope, fixture.threadId);
      expect(active).toMatchObject({
        inventoryState: "active",
        inventoryRevision: settled.state.inventoryRevision + 1,
        stateChangedAt: 560,
      });

      bindings.bindCreatedConversation(fixture.scope, fixture.threadId, {
        attemptId: "settled-first-send-attempt",
        backendConversationId: "settled-first-send-conversation",
        acceptedAt: 560,
      });
      const settledAgain = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: active.inventoryRevision,
          mutationId: "settle-after-first-send",
          change: { action: "settle" },
          now: 570,
        },
      );
      expect(() =>
        creation.markAcceptedUnpersisted(
          fixture.scope,
          fixture.threadId,
          "settled-first-send-attempt",
          {
            expected: "first_submission_started",
            acceptedAt: 560,
          },
        ),
      ).toThrow("not in the expected phase");
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: settledAgain.state.inventoryRevision,
        stateChangedAt: 570,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("activates a settled thread only when a prepared Steer becomes accepted", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const draft = new ConversationDraftRepository(fixture.database).get(
        fixture.scope,
        fixture.threadId,
      );
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-steer",
          change: { action: "settle" },
          now: 510,
        },
      );
      const receipt = operations.prepareSteer(fixture.scope, fixture.threadId, {
        mutationId: "settled-steer-operation",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: [],
        taskReferences: [],
        expectedThreadRevision: threadRevision(fixture),
        expectedDraftRevision: draft.revision,
        now: 520,
      });
      expect(receipt.state).toBe("prepared");
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId).inventoryState,
      ).toBe("settled");

      operations.markSteerSubmissionStarted(
        fixture.scope,
        receipt.mutationId,
        { kind: "turn" as const, turnId: "settled-steer-active-turn" },
      );
      operations.acceptSteer(fixture.scope, receipt.mutationId, 530);
      const active = inventory.getInventory(fixture.scope, fixture.threadId);
      expect(active).toMatchObject({
        inventoryState: "active",
        inventoryRevision: settled.state.inventoryRevision + 1,
        stateChangedAt: 530,
      });

      const settledAgain = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: active.inventoryRevision,
          mutationId: "settle-after-steer",
          change: { action: "settle" },
          now: 540,
        },
      );
      expect(
        operations.acceptSteer(fixture.scope, receipt.mutationId, 550).state,
      ).toBe("accepted");
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: settledAgain.state.inventoryRevision,
        stateChangedAt: 540,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("leaves a settled thread settled when a prepared Steer is rejected", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const inventory = new InventoryRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const draft = new ConversationDraftRepository(fixture.database).get(
        fixture.scope,
        fixture.threadId,
      );
      const settled = inventory.transitionInventory(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: inventory.getInventory(
            fixture.scope,
            fixture.threadId,
          ).inventoryRevision,
          mutationId: "settle-before-rejected-steer",
          change: { action: "settle" },
          now: 510,
        },
      );
      const receipt = operations.prepareSteer(fixture.scope, fixture.threadId, {
        mutationId: "rejected-settled-steer-operation",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: [],
        taskReferences: [],
        expectedThreadRevision: threadRevision(fixture),
        expectedDraftRevision: draft.revision,
        now: 520,
      });
      operations.rejectSteerBeforeAcceptance(fixture.scope, receipt.mutationId);
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId),
      ).toMatchObject({
        inventoryState: "settled",
        inventoryRevision: settled.state.inventoryRevision,
        stateChangedAt: 510,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("persists, stashes, and restores an annotated context-only composer snapshot", () => {
    const fixture = createFixture();
    try {
      const inventory = new InventoryRepository(fixture.database);
      const excerpt = {
        id: "018f47cb-5f45-7f93-8d8d-bdb808b1f011",
        excerpt: "const answer = 42;",
        note: "Please explain this line.",
        source: {
          kind: "conversation_message" as const,
          itemId: "normalized-user-message-1",
          itemRevision: 4,
        },
        locator: {
          kind: "text_quote" as const,
          prefix: "Earlier: ",
          suffix: " Later.",
        },
      };
      const saved = inventory.saveDraft(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: [excerpt],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 310,
      });
      expect(saved.contextExcerpts).toEqual([excerpt]);
      const bindings = new ConversationBindingRepository(fixture.database);
      expect(() =>
        bindings.moveUnboundThreadWorkspace(fixture.scope, fixture.threadId, {
          workspaceId: fixture.secondWorkspaceId,
          expectedThreadRevision: threadRevision(fixture),
          mutationId: "move-with-active-context",
          now: 315,
        }),
      ).toThrow("Remove this draft's context excerpts");

      const stashed = inventory.stashDraft(fixture.scope, fixture.threadId, {
        expectedDraftRevision: saved.revision,
        mutationId: "stash-context-only",
        maximumStashes: 50,
        now: 320,
      });
      expect(stashed.stash).toMatchObject({
        text: "",
        contextExcerpts: [excerpt],
      });
      expect(stashed.draft.contextExcerpts).toEqual([]);

      const duplicateDraft = inventory.saveDraft(
        fixture.scope,
        fixture.threadId,
        {
          text: "",
          contextExcerpts: [excerpt],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: stashed.draft.revision,
          now: 322,
        },
      );
      const service = new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      });
      expect(() =>
        service.restoreStash(
          fixture.scope,
          fixture.threadId,
          stashed.stash.id,
          {
            expectedDraftRevision: duplicateDraft.revision,
            mutationId: "restore-duplicate-context",
          },
          323,
        ),
      ).toThrow(
        new DomainError(
          "invalid_transition",
          "The stashed prompt contains a context excerpt already in the draft.",
        ),
      );
      const clearedDraft = inventory.saveDraft(
        fixture.scope,
        fixture.threadId,
        {
          text: "",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: duplicateDraft.revision,
          now: 324,
        },
      );
      expect(() =>
        bindings.moveUnboundThreadWorkspace(fixture.scope, fixture.threadId, {
          workspaceId: fixture.secondWorkspaceId,
          expectedThreadRevision: threadRevision(fixture),
          mutationId: "move-with-stashed-context",
          now: 325,
        }),
      ).toThrow("Remove this draft's context excerpts");

      const restored = inventory.restoreStash(
        fixture.scope,
        fixture.threadId,
        stashed.stash.id,
        {
          expectedDraftRevision: clearedDraft.revision,
          mutationId: "restore-context-only",
          now: 330,
        },
      );
      expect(restored.draft).toMatchObject({
        text: "",
        contextExcerpts: [excerpt],
      });
      expect(inventory.listStashes(fixture.scope, fixture.threadId)).toEqual(
        [],
      );
    } finally {
      fixture.database.close();
    }
  });

  it("reports the restored context excerpt count limit as a domain error", () => {
    const fixture = createFixture();
    try {
      const inventory = new InventoryRepository(fixture.database);
      const excerpts = Array.from({ length: 16 }, (_, index) => ({
        id: `018f47cb-5f45-7f93-8d8d-${String(index + 1).padStart(12, "0")}`,
        excerpt: `selected text ${index + 1}`,
        source: {
          kind: "workspace_file" as const,
          rootId: "primary" as const,
          path: "src/example.ts",
          revision: "revision-1",
        },
        locator: {
          kind: "line_range" as const,
          startLine: index + 1,
          endLine: index + 1,
        },
      }));
      const saved = inventory.saveDraft(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: excerpts,
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 331,
      });
      const stashed = inventory.stashDraft(fixture.scope, fixture.threadId, {
        expectedDraftRevision: saved.revision,
        mutationId: "stash-maximum-context",
        maximumStashes: 50,
        now: 332,
      });
      const current = inventory.saveDraft(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: [
          {
            ...excerpts[0]!,
            id: "018f47cb-5f45-7f93-8d8d-999999999999",
          },
        ],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: stashed.draft.revision,
        now: 333,
      });
      const service = new InventoryService(inventory, {
        publishMany() {},
        publishApplicationThread() {},
      });

      expect(() =>
        service.restoreStash(
          fixture.scope,
          fixture.threadId,
          stashed.stash.id,
          {
            expectedDraftRevision: current.revision,
            mutationId: "restore-too-many-context",
          },
          334,
        ),
      ).toThrow(
        new DomainError(
          "invalid_transition",
          "A draft can contain at most 16 context excerpts.",
        ),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("maps corrupt steering context receipts to a domain conflict", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const draft = drafts.get(fixture.scope, fixture.threadId);
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareSteer(fixture.scope, fixture.threadId, {
        mutationId: "corrupt-steer-context",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        expectedThreadRevision: threadRevision(fixture),
        expectedDraftRevision: draft.revision,
        now: 340,
      });
      const row = fixture.database
        .prepare(
          `SELECT result_json AS resultJson
           FROM mutation_receipts
           WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
        )
        .get(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          "corrupt-steer-context",
        ) as { resultJson: string };
      const result = JSON.parse(row.resultJson) as Record<string, unknown>;
      result.contextExcerpts = [{ id: "not-an-excerpt" }];
      fixture.database
        .prepare(
          `UPDATE mutation_receipts SET result_json = ?
           WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
        )
        .run(
          JSON.stringify(result),
          fixture.scope.tenantId,
          fixture.scope.principalId,
          "corrupt-steer-context",
        );

      expect(() =>
        operations.getSteer(fixture.scope, "corrupt-steer-context"),
      ).toThrow(
        new DomainError(
          "conflict",
          "The steering operation receipt is corrupt.",
        ),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("materializes current task state atomically and preserves accepted replays after deletion", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const tasks = new TaskRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const acceptedTask = tasks.create(fixture.scope, {
        title: "Draft label",
        details: "Draft details",
        scope: { kind: "global" },
        mutationId: "task-context-create-accepted",
        now: 560,
      });
      const draft = drafts.save(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [acceptedTask.id],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 561,
      });
      expect(draft.taskReferences).toEqual([
        { taskId: acceptedTask.id, titleSnapshot: "Draft label" },
      ]);
      tasks.update(fixture.scope, acceptedTask.id, {
        title: "Current title",
        details: "Current details",
        expectedRevision: acceptedTask.revision,
        mutationId: "task-context-update-accepted",
        now: 562,
      });
      const request = {
        mutationId: "task-context-enqueue-accepted",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: draft.attachments.map(({ id }) => id),
        taskReferences: draft.taskReferences,
        source: {
          kind: "composer" as const,
          requestedDeliveryMode: "queue" as const,
          resolvedDeliveryMode: "queue" as const,
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 563,
      };
      const accepted = queue.enqueue(fixture.scope, fixture.threadId, request);
      expect(accepted.item).toMatchObject({
        requestedDeliveryMode: "queue",
        resolvedDeliveryMode: "queue",
        requestedThreadRevision: request.source.expectedThreadRevision,
        requestedDraftRevision: request.source.expectedDraftRevision,
      });
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE queued_inputs SET requested_delivery_mode = NULL
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            accepted.item.id,
          ),
      ).toThrow();
      expect(accepted.item.taskContexts).toMatchObject([
        {
          id: acceptedTask.id,
          title: "Current title",
          details: "Current details",
          revision: 1,
        },
      ]);
      expect(tasks.remove(fixture.scope, acceptedTask.id)).toBe(true);
      expect(
        queue.findComposerDeliveryReplay(fixture.scope, fixture.threadId, {
          mutationId: request.mutationId,
          requestedDeliveryMode: "queue",
          expectedThreadRevision: request.source.expectedThreadRevision,
          expectedDraftRevision: request.source.expectedDraftRevision,
        }),
      ).toEqual(accepted.item);
      expect(() =>
        queue.findComposerDeliveryReplay(fixture.scope, fixture.threadId, {
          mutationId: request.mutationId,
          requestedDeliveryMode: "submit",
          expectedThreadRevision: request.source.expectedThreadRevision,
          expectedDraftRevision: request.source.expectedDraftRevision,
        }),
      ).toThrow("delivery mutation ID was reused");
      expect(() =>
        queue.findComposerDeliveryReplay(fixture.scope, fixture.threadId, {
          mutationId: request.mutationId,
          requestedDeliveryMode: "queue",
          expectedThreadRevision: request.source.expectedThreadRevision + 1,
          expectedDraftRevision: request.source.expectedDraftRevision,
        }),
      ).toThrow("delivery mutation ID was reused");
      expect(
        queue.enqueue(fixture.scope, fixture.threadId, {
          ...request,
          id: "ignored-task-context-replay-id",
          now: 999,
        }),
      ).toMatchObject({
        replayed: true,
        item: {
          taskContexts: [{ id: acceptedTask.id, title: "Current title" }],
        },
      });

      const missingTask = tasks.create(fixture.scope, {
        title: "Will disappear",
        scope: { kind: "global" },
        mutationId: "task-context-create-missing",
        now: 570,
      });
      const missingDraft = drafts.save(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [missingTask.id],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 571,
      });
      tasks.remove(fixture.scope, missingTask.id);
      const retained = drafts.save(fixture.scope, fixture.threadId, {
        text: "Still keep the stale chip",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [missingTask.id],
        expectedRevision: missingDraft.revision,
        now: 572,
      });
      expect(retained.taskReferences).toEqual(missingDraft.taskReferences);
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          mutationId: "task-context-enqueue-missing",
          text: retained.text,
          contextExcerpts: retained.contextExcerpts,
          attachmentIds: [],
          taskReferences: retained.taskReferences,
          source: {
            kind: "composer",
            requestedDeliveryMode: "queue",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: threadRevision(fixture),
            expectedDraftRevision: retained.revision,
          },
          now: 573,
        }),
      ).toThrow(
        new DomainError(
          "task_reference_unresolved",
          "An attached task no longer exists. Remove the missing task before sending.",
        ),
      );
      expect(drafts.get(fixture.scope, fixture.threadId)).toEqual(retained);
      expect(queue.list(fixture.scope, fixture.threadId)).toMatchObject([
        { mutationId: "task-context-enqueue-accepted" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("persists an exact target-bound composer Steer intent", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const draft = drafts.get(fixture.scope, fixture.threadId);
      const request = {
        mutationId: "target-bound-steer-intent",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: draft.attachments.map(({ id }) => id),
        taskReferences: draft.taskReferences,
        source: {
          kind: "composer" as const,
          requestedDeliveryMode: "steer" as const,
          resolvedDeliveryMode: "steer" as const,
          requestedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          resolvedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 580,
      };

      const accepted = queue.enqueue(fixture.scope, fixture.threadId, request);
      expect(accepted.item).toMatchObject({
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
        resolvedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
        state: "pending",
        deliveryMode: null,
      });
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE queued_inputs SET resolved_delivery_mode = NULL
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            accepted.item.id,
          ),
      ).toThrow();
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE queued_inputs SET resolved_steer_target_json = NULL
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            accepted.item.id,
          ),
      ).toThrow();
      expect(
        queue.claimHead(
          fixture.scope,
          fixture.threadId,
          "submission-anchor-must-not-claim-steer",
          581,
        ),
      ).toBeUndefined();
      expect(
        queue.get(fixture.scope, fixture.threadId, accepted.item.id),
      ).toMatchObject({ state: "pending", deliveryMode: null });
      expect(
        fixture.database
          .prepare(
            `SELECT requested_delivery_mode AS requestedDeliveryMode,
              requested_steer_target_json AS requestedSteerTargetJson
             FROM queued_inputs
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            accepted.item.id,
          ),
      ).toEqual({
        requestedDeliveryMode: "queue",
        requestedSteerTargetJson: JSON.stringify({ kind: "turn", turnId: "active-turn-1" }),
      });
      expect(
        queue.findComposerDeliveryReplay(fixture.scope, fixture.threadId, {
          mutationId: request.mutationId,
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          expectedThreadRevision: request.source.expectedThreadRevision,
          expectedDraftRevision: request.source.expectedDraftRevision,
        }),
      ).toEqual(accepted.item);
      expect(() =>
        queue.findComposerDeliveryReplay(fixture.scope, fixture.threadId, {
          mutationId: request.mutationId,
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn" as const, turnId: "different-active-turn" },
          expectedThreadRevision: request.source.expectedThreadRevision,
          expectedDraftRevision: request.source.expectedDraftRevision,
        }),
      ).toThrow("delivery mutation ID was reused");
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          ...request,
          source: {
            ...request.source,
            requestedSteerTarget: { kind: "turn" as const, turnId: "different-active-turn" },
            resolvedSteerTarget: { kind: "turn" as const, turnId: "different-active-turn" },
          },
          now: 999,
        }),
      ).toThrow("queue mutation ID was reused");
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE queued_inputs SET requested_delivery_mode = 'submit'
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            accepted.item.id,
          ),
      ).toThrow();
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a target-bound Steer behind ordinary queued work", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const firstDraft = drafts.get(fixture.scope, fixture.threadId);
      queue.enqueue(fixture.scope, fixture.threadId, {
        mutationId: "ordinary-queue-before-steer",
        text: firstDraft.text,
        contextExcerpts: firstDraft.contextExcerpts,
        attachmentIds: firstDraft.attachments.map(({ id }) => id),
        taskReferences: firstDraft.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: firstDraft.revision,
        },
        now: 590,
      });
      const emptyDraft = drafts.get(fixture.scope, fixture.threadId);
      const steerDraft = drafts.save(fixture.scope, fixture.threadId, {
        text: "Do not admit this behind ordinary queued work",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: emptyDraft.revision,
        now: 591,
      });

      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          mutationId: "blocked-steer-behind-queue",
          text: steerDraft.text,
          contextExcerpts: steerDraft.contextExcerpts,
          attachmentIds: steerDraft.attachments.map(({ id }) => id),
          taskReferences: steerDraft.taskReferences,
          source: {
            kind: "composer",
            requestedDeliveryMode: "steer",
            resolvedDeliveryMode: "steer",
            requestedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
            resolvedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
            expectedThreadRevision: threadRevision(fixture),
            expectedDraftRevision: steerDraft.revision,
          },
          now: 592,
        }),
      ).toThrow(/existing queued input/i);
      expect(drafts.get(fixture.scope, fixture.threadId)).toEqual(steerDraft);
      expect(queue.list(fixture.scope, fixture.threadId)).toMatchObject([
        { mutationId: "ordinary-queue-before-steer" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("allows resolved Steers to stack even when Send supplied the first intent", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const queue = new QueuedInputRepository(fixture.database);
      const firstDraft = drafts.get(fixture.scope, fixture.threadId);
      const first = queue.enqueue(fixture.scope, fixture.threadId, {
        mutationId: "send-resolved-steer-1",
        text: firstDraft.text,
        contextExcerpts: firstDraft.contextExcerpts,
        attachmentIds: firstDraft.attachments.map(({ id }) => id),
        taskReferences: firstDraft.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "submit",
          resolvedDeliveryMode: "steer",
          resolvedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: firstDraft.revision,
        },
        now: 593,
      });
      const emptyDraft = drafts.get(fixture.scope, fixture.threadId);
      const secondDraft = drafts.save(fixture.scope, fixture.threadId, {
        text: "Stack this behind the first resolved Steer",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: emptyDraft.revision,
        now: 594,
      });

      const second = queue.enqueue(fixture.scope, fixture.threadId, {
        mutationId: "explicit-steer-2",
        text: secondDraft.text,
        contextExcerpts: secondDraft.contextExcerpts,
        attachmentIds: secondDraft.attachments.map(({ id }) => id),
        taskReferences: secondDraft.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          resolvedDeliveryMode: "steer",
          resolvedSteerTarget: { kind: "turn" as const, turnId: "active-turn-1" },
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: secondDraft.revision,
        },
        now: 595,
      });

      expect(queue.list(fixture.scope, fixture.threadId)).toMatchObject([
        { id: first.item.id, resolvedDeliveryMode: "steer" },
        { id: second.item.id, resolvedDeliveryMode: "steer" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("snapshots task context when accepting a first-input creation attempt", () => {
    const fixture = createFixture();
    try {
      const tasks = new TaskRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const creation = new ConversationCreationRepository(fixture.database);
      const task = tasks.create(fixture.scope, {
        title: "Creation draft label",
        details: "Creation draft details",
        scope: { kind: "global" },
        mutationId: "creation-task-context-create",
        now: 580,
      });
      const draft = drafts.save(fixture.scope, fixture.threadId, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [task.id],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 581,
      });
      tasks.update(fixture.scope, task.id, {
        title: "Creation current title",
        details: "Creation current details",
        expectedRevision: task.revision,
        mutationId: "creation-task-context-update",
        now: 582,
      });
      const request = {
        attemptId: "creation-task-context-attempt",
        mutationId: "creation-task-context-prepare",
        expectedThreadRevision: 0,
        creationKind: "first_input" as const,
        sourceKind: "composer" as const,
        initialInputText: draft.text,
        initialContextExcerpts: draft.contextExcerpts,
        initialAttachmentIds: draft.attachments.map(({ id }) => id),
        initialTaskReferences: draft.taskReferences,
        expectedDraftRevision: draft.revision,
        backendCreationCorrelation: "creation-task-context-correlation",
        now: 583,
      };
      const prepared = creation.prepare(
        fixture.scope,
        fixture.threadId,
        request,
      );
      expect(prepared.initialTaskContexts).toMatchObject([
        {
          id: task.id,
          title: "Creation current title",
          details: "Creation current details",
          revision: 1,
        },
      ]);
      tasks.remove(fixture.scope, task.id);
      expect(
        creation.prepare(fixture.scope, fixture.threadId, {
          ...request,
          now: 999,
        }),
      ).toEqual(prepared);
    } finally {
      fixture.database.close();
    }
  });

  it("uses canonical multi-task byte accounting at the exact acceptance boundary", () => {
    for (const extraByte of [0, 1]) {
      const fixture = createFixture();
      try {
        bindDiscovered(fixture);
        const tasks = new TaskRepository(fixture.database);
        const drafts = new ConversationDraftRepository(fixture.database);
        const queue = new QueuedInputRepository(fixture.database);
        const taskContexts = ["first", "second", "third", "fourth"].map(
          (suffix, index) =>
            presentTask(
              tasks.create(fixture.scope, {
                title: `Boundary ${suffix}`,
                details: `${suffix}:`.padEnd(49_000, "d"),
                scope: { kind: "global" },
                mutationId: `task-context-boundary-create-${suffix}`,
                now: 590 + index,
              }),
            ),
        );
        const taskBytes = composerInputUtf8Bytes({
          text: "",
          contextExcerpts: [],
          taskContexts,
        });
        const text = "x".repeat(
          MAXIMUM_COMPOSER_INPUT_BYTES - taskBytes + extraByte,
        );
        expect(
          composerInputUtf8Bytes({
            text,
            contextExcerpts: [],
            taskContexts,
          }),
        ).toBe(MAXIMUM_COMPOSER_INPUT_BYTES + extraByte);
        const draft = drafts.save(fixture.scope, fixture.threadId, {
          text,
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: taskContexts.map(({ id }) => id),
          expectedRevision: drafts.get(fixture.scope, fixture.threadId)
            .revision,
          now: 592,
        });
        const enqueue = () =>
          queue.enqueue(fixture.scope, fixture.threadId, {
            mutationId: `task-context-boundary-enqueue-${extraByte}`,
            text: draft.text,
            contextExcerpts: [],
            attachmentIds: [],
            taskReferences: draft.taskReferences,
            source: {
              kind: "composer",
              requestedDeliveryMode: "queue",
              resolvedDeliveryMode: "queue",
              expectedThreadRevision: threadRevision(fixture),
              expectedDraftRevision: draft.revision,
            },
            now: 593,
          });
        if (extraByte === 0) {
          expect(enqueue().item.taskContexts).toEqual(taskContexts);
          expect(queue.list(fixture.scope, fixture.threadId)).toHaveLength(1);
        } else {
          expect(enqueue).toThrow(
            new DomainError(
              "task_context_too_large",
              "The attached task content is too large to send. Remove a task or shorten its details.",
            ),
          );
          expect(queue.list(fixture.scope, fixture.threadId)).toEqual([]);
          expect(drafts.get(fixture.scope, fixture.threadId)).toEqual(draft);
        }
      } finally {
        fixture.database.close();
      }
    }
  });

  it("links an already-materialized descendant subtree when an imported parent resolves", () => {
    const fixture = createFixture();
    try {
      const bindings = bindDiscovered(fixture);
      bindings.bindDiscoveredConversation(
        fixture.scope,
        fixture.secondThreadId,
        {
          backendConversationId: `session-${fixture.secondThreadId}`,
          now: 510,
        },
      );
      const lineage = new ThreadLineageRepository(fixture.database);
      lineage.recordImportedNativeOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        providerParentBackendConversationId: `session-${fixture.threadId}`,
        sourceTurnState: "unresolved",
        branchMethod: "provider_native",
        now: 520,
      });
      const secondDefinition = bindings.findThreadDefinition(
        fixture.scope,
        fixture.secondThreadId,
      )!;
      const grandchild = bindings.createUnboundThread(fixture.scope, {
        workspaceId: fixture.workspaceId,
        connectionProfileId: secondDefinition.connectionProfileId,
        title: "Already imported grandchild",
        now: 530,
      });
      bindings.bindDiscoveredConversation(fixture.scope, grandchild.id, {
        backendConversationId: `session-${grandchild.id}`,
        now: 531,
      });
      lineage.recordImportedNativeOrigin(fixture.scope, {
        childThreadId: grandchild.id,
        providerParentBackendConversationId: `session-${fixture.secondThreadId}`,
        sourceThreadId: fixture.secondThreadId,
        sourceTurnState: "unresolved",
        branchMethod: "provider_native",
        now: 532,
      });

      expect(
        lineage.listDescendants(fixture.scope, fixture.threadId, { limit: 10 })
          .descendants,
      ).toEqual([]);
      expect(
        lineage
          .listDescendants(fixture.scope, fixture.secondThreadId, { limit: 10 })
          .descendants.map(({ childThreadId }) => childThreadId),
      ).toEqual([grandchild.id]);

      lineage.reconcileImportedNativeSource(
        fixture.scope,
        fixture.secondThreadId,
        {
          providerParentBackendConversationId: `session-${fixture.threadId}`,
          sourceThreadId: fixture.threadId,
          sourceTurnState: "unresolved",
          now: 540,
        },
      );

      expect(
        lineage
          .listDescendants(fixture.scope, fixture.threadId, { limit: 10 })
          .descendants.map(({ childThreadId }) => childThreadId),
      ).toEqual([grandchild.id, fixture.secondThreadId]);
      expect(
        fixture.database
          .prepare(
            `SELECT depth FROM thread_lineage_closure
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND ancestor_thread_id = ? AND descendant_thread_id = ?`,
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
            grandchild.id,
          ),
      ).toEqual({ depth: 2 });
    } finally {
      fixture.database.close();
    }
  });

  it("keeps an unresolved imported parent top-level until reconciliation without overriding explicit placement", () => {
    const fixture = createFixture();
    try {
      const bindings = bindDiscovered(fixture);
      bindings.bindDiscoveredConversation(
        fixture.scope,
        fixture.secondThreadId,
        {
          backendConversationId: `session-${fixture.secondThreadId}`,
          now: 510,
        },
      );
      const lineage = new ThreadLineageRepository(fixture.database);
      const imported = lineage.recordImportedNativeOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        providerParentBackendConversationId: `session-${fixture.threadId}`,
        sourceTurnState: "unresolved",
        branchMethod: "provider_native",
        now: 520,
      });
      expect(imported).toMatchObject({
        sourceThreadState: "unresolved",
        sourceThreadId: null,
      });
      expect(
        lineage.getPlacement(fixture.scope, fixture.secondThreadId),
      ).toMatchObject({
        placementMode: "top_level",
        placementState: "default",
        revision: 0,
      });
      expect(() =>
        lineage.updatePlacement(fixture.scope, fixture.secondThreadId, {
          placementMode: "nested_under_source",
          expectedRevision: 0,
          mutationId: "invalid-unresolved-nesting",
          now: 530,
        }),
      ).toThrow("cannot nest under an unresolved source");

      const explicit = lineage.updatePlacement(
        fixture.scope,
        fixture.secondThreadId,
        {
          placementMode: "top_level",
          expectedRevision: 0,
          mutationId: "explicit-top-level",
          now: 540,
        },
      );
      expect(() =>
        lineage.reconcileImportedNativeSource(
          fixture.scope,
          fixture.secondThreadId,
          {
            providerParentBackendConversationId: "changed-native-parent",
            sourceThreadId: fixture.threadId,
            sourceTurnState: "unresolved",
            now: 545,
          },
        ),
      ).toThrow("provider parent evidence changed");
      lineage.reconcileImportedNativeSource(
        fixture.scope,
        fixture.secondThreadId,
        {
          providerParentBackendConversationId: `session-${fixture.threadId}`,
          sourceThreadId: fixture.threadId,
          sourceTurnState: "unresolved",
          now: 550,
        },
      );
      expect(
        lineage.getPlacement(fixture.scope, fixture.secondThreadId),
      ).toEqual(explicit);
      expect(
        lineage.reconcileImportedNativeSource(
          fixture.scope,
          fixture.secondThreadId,
          {
            providerParentBackendConversationId: `session-${fixture.threadId}`,
            sourceThreadId: fixture.threadId,
            sourceTurnState: "resolved",
            sourceTurnId: "later-resolved-turn",
            now: 555,
          },
        ),
      ).toMatchObject({
        sourceThreadState: "resolved",
        sourceTurnState: "resolved",
        sourceTurnId: "later-resolved-turn",
      });

      lineage.updatePlacement(fixture.scope, fixture.secondThreadId, {
        placementMode: "nested_under_source",
        expectedRevision: 1,
        mutationId: "explicit-nested",
        now: 560,
      });
      expect(
        lineage.updatePlacement(fixture.scope, fixture.secondThreadId, {
          placementMode: "top_level",
          expectedRevision: 0,
          mutationId: "explicit-top-level",
          now: 540,
        }),
      ).toEqual(explicit);
      const secondDefinition = bindings.findThreadDefinition(
        fixture.scope,
        fixture.secondThreadId,
      )!;
      const grandchild = bindings.createUnboundThread(fixture.scope, {
        workspaceId: fixture.workspaceId,
        connectionProfileId: secondDefinition.connectionProfileId,
        title: "Nested imported grandchild",
        now: 570,
      });
      bindings.bindDiscoveredConversation(fixture.scope, grandchild.id, {
        backendConversationId: `session-${grandchild.id}`,
        now: 571,
      });
      lineage.recordImportedNativeOrigin(fixture.scope, {
        childThreadId: grandchild.id,
        providerParentBackendConversationId: `session-${fixture.secondThreadId}`,
        sourceThreadId: fixture.secondThreadId,
        sourceTurnState: "unresolved",
        branchMethod: "provider_native",
        now: 572,
      });
      const foreignScope: RequestScope = {
        tenantId: fixture.scope.tenantId,
        principalId: "foreign-principal",
      };
      expect(() =>
        lineage.updatePlacement(foreignScope, fixture.secondThreadId, {
          placementMode: "top_level",
          expectedRevision: 0,
          mutationId: "explicit-top-level",
          now: 540,
        }),
      ).toThrow("fork origin was not found");
      expect(
        lineage
          .listDescendants(fixture.scope, fixture.threadId, { limit: 10 })
          .descendants.map((origin) => origin.childThreadId),
      ).toEqual([grandchild.id, fixture.secondThreadId]);
      expect(
        lineage
          .listDescendants(fixture.scope, fixture.secondThreadId, { limit: 10 })
          .descendants.map((origin) => origin.childThreadId),
      ).toEqual([grandchild.id]);
      expect(
        lineage.countDescendants(fixture.scope, [
          fixture.threadId,
          fixture.secondThreadId,
        ]),
      ).toEqual(
        expect.arrayContaining([
          { sourceThreadId: fixture.threadId, descendantCount: 2 },
          { sourceThreadId: fixture.secondThreadId, descendantCount: 1 },
        ]),
      );
      expect(
        lineage.countDescendants(foreignScope, [fixture.threadId]),
      ).toEqual([]);
      expect(
        fixture.database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT closure.descendant_thread_id
             FROM thread_lineage_closure AS closure
             JOIN thread_fork_origins AS origin
               ON origin.tenant_id = closure.tenant_id
               AND origin.owner_principal_id = closure.owner_principal_id
               AND origin.child_thread_id = closure.descendant_thread_id
             WHERE closure.tenant_id = ? AND closure.owner_principal_id = ?
               AND closure.ancestor_thread_id = ?
               AND origin.origin_state = 'committed'
               AND (closure.descendant_created_at,
                 closure.descendant_thread_id) < (?, ?)
             ORDER BY closure.descendant_created_at DESC,
               closure.descendant_thread_id DESC
             LIMIT 11`,
          )
          .all(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
            Number.MAX_SAFE_INTEGER,
            "page-cursor-ceiling",
          ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringContaining("thread_lineage_closure_page"),
          }),
        ]),
      );
      expect(
        fixture.database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT ancestor_thread_id, depth
             FROM thread_lineage_closure
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND descendant_thread_id = ?`,
          )
          .all(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            grandchild.id,
          ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringContaining("thread_lineage_closure_ancestors"),
          }),
        ]),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("commits prepared fork provenance atomically with the child binding", () => {
    const fixture = createFixture();
    try {
      const bindings = bindDiscovered(fixture);
      const checkpoint = new BackendCheckpointRepository(
        fixture.database,
      ).create(fixture.scope, fixture.threadId, {
        id: "fork-checkpoint",
        applicationTurnId: "fork-source-turn",
        opaqueReference: "fork-source-leaf",
        now: 520,
      });
      const lineage = new ThreadLineageRepository(fixture.database);
      expect(() =>
        lineage.prepareOrigin(fixture.scope, {
          childThreadId: fixture.secondThreadId,
          sourceThreadId: fixture.threadId,
          sourceTurnId: "fork-source-turn",
          sourceTurnCompletedAt: 510,
          sourceTurnRevision: 1,
          sourceCheckpointId: checkpoint.id,
          originKind: "user_fork",
          initiatingPrincipalId: fixture.scope.principalId,
          branchMethod: "provider_native",
          creationOperationId: "x".repeat(129),
          now: 529,
        }),
      ).toThrow();
      lineage.prepareOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        sourceThreadId: fixture.threadId,
        sourceTurnId: "fork-source-turn",
        sourceTurnCompletedAt: 510,
        sourceTurnRevision: 1,
        sourceCheckpointId: checkpoint.id,
        originKind: "user_fork",
        initiatingPrincipalId: fixture.scope.principalId,
        branchMethod: "provider_native",
        creationOperationId: "fork-mutation",
        now: 530,
      });
      const creation = new ConversationCreationRepository(fixture.database);
      creation.prepare(fixture.scope, fixture.secondThreadId, {
        attemptId: "fork-attempt",
        mutationId: "fork-mutation",
        expectedThreadRevision: 0,
        creationKind: "fork",
        forkChildIdentity: "application_reserved",
        forkCreationRecovery: "idempotent",
        sourceKind: "user_fork",
        initialInputText: null,
        initialAttachmentIds: [],
        backendCreationCorrelation: "fork-correlation",
        now: 540,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.secondThreadId,
        "fork-attempt",
        550,
      );
      creation.recordConversationIdentified(
        fixture.scope,
        fixture.secondThreadId,
        "fork-attempt",
        {
          backendConversationId: "fork-child-native",
          opaqueBindingDetail: "fork-child-detail",
          now: 560,
        },
      );
      bindings.bindCreatedConversation(fixture.scope, fixture.secondThreadId, {
        attemptId: "fork-attempt",
        backendConversationId: "fork-child-native",
        acceptedAt: 570,
      });
      expect(
        lineage.getOrigin(fixture.scope, fixture.secondThreadId),
      ).toMatchObject({
        originState: "committed",
        committedAt: 570,
        creationOperationId: "fork-mutation",
        sourceTurnCompletedAt: 510,
      });
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE thread_fork_origins
             SET source_turn_completed_at = ?
             WHERE child_thread_id = ?`,
          )
          .run(511, fixture.secondThreadId),
      ).toThrow("Fork origins are immutable");
    } finally {
      fixture.database.close();
    }
  });

  it("persists provider-snapshot checkpoints and unresolved-turn lineage fail closed", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const checkpoints = new BackendCheckpointRepository(fixture.database);
      const checkpoint = checkpoints.createProviderSnapshot(
        fixture.scope,
        fixture.threadId,
        {
          id: "provider-snapshot-checkpoint",
          opaqueReference: "provider-snapshot-reference",
          now: 520,
        },
      );
      expect(checkpoint).toMatchObject({
        applicationTurnId: null,
        boundaryKind: "provider_snapshot_at_acceptance",
      });
      expect(
        checkpoints.createProviderSnapshot(fixture.scope, fixture.threadId, {
          id: "provider-snapshot-checkpoint",
          opaqueReference: "provider-snapshot-reference",
          now: 999,
        }),
      ).toEqual(checkpoint);

      const lineage = new ThreadLineageRepository(fixture.database);
      const origin = lineage.prepareProviderSnapshotOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        sourceThreadId: fixture.threadId,
        sourceCheckpointId: checkpoint.id,
        initiatingPrincipalId: fixture.scope.principalId,
        branchMethod: "provider_native",
        creationOperationId: "provider-snapshot-fork",
        now: 530,
      });
      expect(origin).toMatchObject({
        sourceThreadState: "resolved",
        sourceTurnState: "unresolved",
        sourceTurnId: null,
        sourceTurnRevision: null,
        sourceTurnCompletedAt: null,
        boundaryKind: "provider_snapshot_at_acceptance",
        originKind: "user_fork",
      });
      expect(
        lineage.prepareProviderSnapshotOrigin(fixture.scope, {
          childThreadId: fixture.secondThreadId,
          sourceThreadId: fixture.threadId,
          sourceCheckpointId: checkpoint.id,
          initiatingPrincipalId: fixture.scope.principalId,
          branchMethod: "provider_native",
          creationOperationId: "provider-snapshot-fork",
          now: 999,
        }),
      ).toEqual(origin);

      const completed = checkpoints.create(fixture.scope, fixture.threadId, {
        id: "completed-checkpoint-for-snapshot-denial",
        applicationTurnId: "completed-turn",
        opaqueReference: "completed-reference",
        now: 540,
      });
      expect(() =>
        lineage.prepareProviderSnapshotOrigin(fixture.scope, {
          childThreadId: fixture.secondThreadId,
          sourceThreadId: fixture.threadId,
          sourceCheckpointId: completed.id,
          initiatingPrincipalId: fixture.scope.principalId,
          branchMethod: "provider_native",
          creationOperationId: "different-provider-snapshot-fork",
          now: 550,
        }),
      ).toThrow("The fork checkpoint does not match its source turn.");
      expect(() =>
        lineage.prepareOrigin(fixture.scope, {
          childThreadId: fixture.secondThreadId,
          sourceThreadId: fixture.threadId,
          sourceTurnId: "completed-turn",
          sourceTurnCompletedAt: 500,
          sourceTurnRevision: 1,
          sourceCheckpointId: checkpoint.id,
          originKind: "user_fork",
          initiatingPrincipalId: fixture.scope.principalId,
          branchMethod: "provider_native",
          creationOperationId: "completed-with-snapshot-checkpoint",
          now: 560,
        }),
      ).toThrow("The fork checkpoint does not match its source turn.");

      const creation = new ConversationCreationRepository(fixture.database);
      creation.prepare(fixture.scope, fixture.secondThreadId, {
        attemptId: "provider-snapshot-attempt",
        mutationId: "provider-snapshot-fork",
        expectedThreadRevision: 0,
        creationKind: "fork",
        forkChildIdentity: "application_reserved",
        forkCreationRecovery: "idempotent",
        sourceKind: "user_fork",
        initialInputText: null,
        initialAttachmentIds: [],
        backendCreationCorrelation: "provider-snapshot-correlation",
        now: 570,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.secondThreadId,
        "provider-snapshot-attempt",
        580,
      );
      expect(() =>
        lineage.abortPreparedFork(fixture.scope, fixture.secondThreadId, {
          creationOperationId: "provider-snapshot-fork",
          diagnostic: "Provider rejected the snapshot fork.",
          restartable: true,
          now: 590,
        }),
      ).toThrow("Only a proven-uncreated prepared fork can be removed.");
      const aborted = lineage.abortPreparedProviderSnapshotFork(
        fixture.scope,
        fixture.secondThreadId,
        {
          creationOperationId: "provider-snapshot-fork",
          diagnostic: "Provider rejected the snapshot fork.",
          restartable: true,
          now: 590,
        },
      );
      expect(aborted).toMatchObject({
        sourceTurnId: null,
        sourceTurnRevision: null,
        boundaryKind: "provider_snapshot_at_acceptance",
      });
      expect(() =>
        lineage.abortPreparedFork(fixture.scope, fixture.secondThreadId, {
          creationOperationId: "provider-snapshot-fork",
          diagnostic: "Provider rejected the snapshot fork.",
          restartable: true,
          now: 590,
        }),
      ).toThrow("The aborted fork operation changed during replay.");
    } finally {
      fixture.database.close();
    }
  });

  it("atomically tombstones and removes a proven-uncreated prepared fork", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const checkpoint = new BackendCheckpointRepository(
        fixture.database,
      ).create(fixture.scope, fixture.threadId, {
        id: "aborted-fork-checkpoint",
        applicationTurnId: "aborted-source-turn",
        opaqueReference: "aborted-source-leaf",
        now: 520,
      });
      const lineage = new ThreadLineageRepository(fixture.database);
      lineage.prepareOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        sourceThreadId: fixture.threadId,
        sourceTurnId: "aborted-source-turn",
        sourceTurnCompletedAt: 510,
        sourceTurnRevision: 3,
        sourceCheckpointId: checkpoint.id,
        originKind: "user_fork",
        initiatingPrincipalId: fixture.scope.principalId,
        branchMethod: "provider_native",
        creationOperationId: "aborted-fork-operation",
        now: 530,
      });
      const creation = new ConversationCreationRepository(fixture.database);
      creation.prepare(fixture.scope, fixture.secondThreadId, {
        attemptId: "aborted-fork-attempt",
        mutationId: "aborted-fork-operation",
        expectedThreadRevision: 0,
        creationKind: "fork",
        forkChildIdentity: "application_reserved",
        forkCreationRecovery: "idempotent",
        sourceKind: "user_fork",
        initialInputText: null,
        initialAttachmentIds: [],
        backendCreationCorrelation: "aborted-fork-correlation",
        now: 540,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.secondThreadId,
        "aborted-fork-attempt",
        550,
      );

      expect(
        lineage.abortPreparedFork(fixture.scope, fixture.secondThreadId, {
          creationOperationId: "aborted-fork-operation",
          diagnostic: "Provider rejected the fork before creation.",
          restartable: true,
          now: 560,
        }),
      ).toMatchObject({
        reservedChildThreadId: fixture.secondThreadId,
        sourceTurnId: "aborted-source-turn",
        sourceTurnRevision: 3,
      });
      expect(
        lineage.findAbortedOperation(fixture.scope, "aborted-fork-operation"),
      ).toMatchObject({ reservedChildThreadId: fixture.secondThreadId });
      expect(
        new ConversationBindingRepository(
          fixture.database,
        ).findThreadDefinition(fixture.scope, fixture.secondThreadId),
      ).toBeUndefined();
      expect(
        creation.findByMutationId(fixture.scope, "aborted-fork-operation"),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  it("promotes an aborted fork child's tasks to its workspace before deletion", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const checkpoint = new BackendCheckpointRepository(
        fixture.database,
      ).create(fixture.scope, fixture.threadId, {
        id: "task-abort-checkpoint",
        applicationTurnId: "task-abort-source-turn",
        opaqueReference: "task-abort-source-leaf",
        now: 520,
      });
      const lineage = new ThreadLineageRepository(fixture.database);
      lineage.prepareOrigin(fixture.scope, {
        childThreadId: fixture.secondThreadId,
        sourceThreadId: fixture.threadId,
        sourceTurnId: "task-abort-source-turn",
        sourceTurnCompletedAt: 510,
        sourceTurnRevision: 3,
        sourceCheckpointId: checkpoint.id,
        originKind: "user_fork",
        initiatingPrincipalId: fixture.scope.principalId,
        branchMethod: "provider_native",
        creationOperationId: "task-abort-operation",
        now: 530,
      });
      const creation = new ConversationCreationRepository(fixture.database);
      creation.prepare(fixture.scope, fixture.secondThreadId, {
        attemptId: "task-abort-attempt",
        mutationId: "task-abort-operation",
        expectedThreadRevision: 0,
        creationKind: "fork",
        forkChildIdentity: "application_reserved",
        forkCreationRecovery: "idempotent",
        sourceKind: "user_fork",
        initialInputText: null,
        initialAttachmentIds: [],
        backendCreationCorrelation: "task-abort-correlation",
        now: 540,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.secondThreadId,
        "task-abort-attempt",
        550,
      );
      const tasks = new TaskRepository(fixture.database);
      const openTask = tasks.create(fixture.scope, {
        title: "Pinned to the provisional child",
        scope: { kind: "thread", threadId: fixture.secondThreadId },
        mutationId: "task-abort-open-task",
        now: 545,
      });
      const doneTask = tasks.create(fixture.scope, {
        title: "Completed on the provisional child",
        scope: { kind: "thread", threadId: fixture.secondThreadId },
        mutationId: "task-abort-done-task",
        now: 546,
      });
      tasks.update(fixture.scope, doneTask.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "task-abort-done-complete",
        now: 547,
      });

      const promoted: string[][] = [];
      lineage.abortPreparedFork(fixture.scope, fixture.secondThreadId, {
        creationOperationId: "task-abort-operation",
        diagnostic: "Provider rejected the fork before creation.",
        restartable: true,
        now: 560,
        onThreadTasksPromoted: (taskIds) => promoted.push([...taskIds]),
      });

      expect(promoted).toHaveLength(1);
      expect([...promoted[0]!].sort()).toEqual(
        [openTask.id, doneTask.id].sort(),
      );
      for (const promotedTaskId of [openTask.id, doneTask.id]) {
        expect(tasks.get(fixture.scope, promotedTaskId)).toMatchObject({
          scopeKind: "workspace",
          threadId: null,
          revision: expect.any(Number),
          updatedAt: 560,
        });
        expect(
          tasks.get(fixture.scope, promotedTaskId).workspaceId,
        ).not.toBeNull();
      }
      expect(
        new ConversationBindingRepository(
          fixture.database,
        ).findThreadDefinition(fixture.scope, fixture.secondThreadId),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  it("moves unbound drafts with strict revision and mutation replay semantics", () => {
    const fixture = createFixture();
    try {
      const bindings = new ConversationBindingRepository(fixture.database);
      const profile = fixture.database
        .prepare(
          `
            SELECT id
            FROM agent_connection_profiles
            WHERE tenant_id = ? AND owner_principal_id = ?
            LIMIT 1
          `,
        )
        .get(fixture.scope.tenantId, fixture.scope.principalId) as {
        readonly id: string;
      };
      const created = bindings.createUnboundThread(fixture.scope, {
        id: "movable-draft",
        workspaceId: fixture.workspaceId,
        connectionProfileId: profile.id,
        title: "Movable draft",
        now: 400,
      });
      const firstMove = {
        workspaceId: fixture.secondWorkspaceId,
        expectedThreadRevision: 0,
        mutationId: "move-draft-1",
        now: 410,
      };

      expect(
        bindings.moveUnboundThreadWorkspace(
          fixture.scope,
          created.id,
          firstMove,
        ),
      ).toMatchObject({
        workspaceId: fixture.secondWorkspaceId,
        backingState: "unbound",
      });
      expect(
        bindings.moveUnboundThreadWorkspace(
          fixture.scope,
          created.id,
          firstMove,
        ),
      ).toMatchObject({ workspaceId: fixture.secondWorkspaceId });
      expect(() =>
        bindings.moveUnboundThreadWorkspace(fixture.scope, created.id, {
          ...firstMove,
          workspaceId: fixture.workspaceId,
        }),
      ).toThrow(/mutation ID was reused/i);
      expect(() =>
        bindings.moveUnboundThreadWorkspace(fixture.scope, created.id, {
          workspaceId: fixture.workspaceId,
          expectedThreadRevision: 0,
          mutationId: "move-draft-stale",
          now: 420,
        }),
      ).toThrow(/thread changed/i);

      const noOp = bindings.moveUnboundThreadWorkspace(
        fixture.scope,
        created.id,
        {
          workspaceId: fixture.secondWorkspaceId,
          expectedThreadRevision: 1,
          mutationId: "move-draft-no-op",
          now: 430,
        },
      );
      expect(noOp.workspaceId).toBe(fixture.secondWorkspaceId);
      expect(
        fixture.database
          .prepare(
            `
              SELECT revision
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(fixture.scope.tenantId, fixture.scope.principalId, created.id),
      ).toEqual({ revision: 1 });

      bindings.bindDiscoveredConversation(fixture.scope, created.id, {
        backendConversationId: "conversation-after-move",
        now: 440,
      });
      expect(() =>
        bindings.moveUnboundThreadWorkspace(fixture.scope, created.id, {
          workspaceId: fixture.workspaceId,
          expectedThreadRevision: 2,
          mutationId: "move-after-first-send",
          now: 450,
        }),
      ).toThrow(/unbound draft/i);
      expect(
        bindings.isUnboundThreadWorkspaceMoveReplay(
          fixture.scope,
          created.id,
          firstMove,
        ),
      ).toBe(true);
    } finally {
      fixture.database.close();
    }
  });

  it("materializes scoped profiles and retains removed identities and preferences", () => {
    const fixture = createFixture();
    try {
      const reader = new BackendConfigurationRepository(fixture.database);
      const repository = new ConfigurationRepository(fixture.database);
      const projection = new ConfigurationProjection(fixture.database, {
        pi: compiledBackendModuleCatalog.protocolReleaseForBackendKind("pi"),
        codex_app_server: compiledBackendModuleCatalog.protocolReleaseForBackendKind("codex_app_server"),
        claude_agent_sdk: compiledBackendModuleCatalog.protocolReleaseForBackendKind("claude_agent_sdk"),
        grok_build: compiledBackendModuleCatalog.protocolReleaseForBackendKind("grok_build"),
      });
      const save = (configuration: ConfigurationDocument) => repository.save(fixture.scope, {
        mutationId: randomUUID(), expectedRevision: repository.get(fixture.scope).revision, configuration,
      }, document => projection.project(fixture.scope, document));
      const original = repository.get(fixture.scope).configuration;
      const expanded = structuredClone(original);
      expanded.backends.push({ ...expanded.backends[0]!, id: "pi-spare", label: "Spare Pi" });
      expanded.targets.push({ ...expanded.targets[0]!, id: "local-spare", backendInstanceId: "pi-spare", label: "Spare SDK" });
      save(expanded);
      const spare = reader.getProfileByTemplate(fixture.scope, "local-spare");
      expect(spare).toMatchObject({ enabled: 1, configurationRevision: 0 });
      const preferences = new ConnectionSettingPreferenceRepository(fixture.database);
      preferences.save(fixture.scope, spare.id, "model", "preserved-model", 410);
      save(original);
      expect(reader.getProfileByTemplate(fixture.scope, "local-spare")).toMatchObject({ id: spare.id, enabled: 0 });
      expect(reader.getBackend(fixture.scope, "pi-spare").enabled).toBe(0);
      expect(preferences.find(fixture.scope, spare.id, "model")).toMatchObject({ value: "preserved-model" });
      save(expanded);
      expect(reader.getProfileByTemplate(fixture.scope, "local-spare")).toMatchObject({ id: spare.id, enabled: 1 });
      expect(preferences.find(fixture.scope, spare.id, "model")).toMatchObject({ value: "preserved-model" });
      const retargeted = structuredClone(expanded);
      retargeted.targets[1]!.backendInstanceId = "pi-primary";
      retargeted.targets[0]!.backendInstanceId = "pi-spare";
      expect(() => save(retargeted)).toThrow(/immutable/);
      const replacementOnly = { ...original, backends: [], targets: [], defaultTargetId: null };
      save(replacementOnly);
      expect(reader.getBackend(fixture.scope, "pi-primary").enabled).toBe(0);
      expect(fixture.database.prepare("SELECT backend_instance_id AS backendId FROM application_threads WHERE id = ?").get(fixture.threadId)).toEqual({ backendId: "pi-primary" });
    } finally { fixture.database.close(); }
  });

  it("increments backend configuration revisions once for canonical model policy changes", () => {
    const fixture = createFixture();
    try {
      let now = 400;
      const repository = new ConfigurationRepository(fixture.database, () => now);
      const projection = new ConfigurationProjection(fixture.database, {
        pi: compiledBackendModuleCatalog.protocolReleaseForBackendKind("pi"), codex_app_server: "unused", claude_agent_sdk: "unused", grok_build: "unused",
      }, () => now);
      const reader = new BackendConfigurationRepository(fixture.database);
      const before = reader.getBackend(fixture.scope, "pi-primary");
      const document = repository.get(fixture.scope).configuration;
      document.backends[0]!.modelPolicy = { type: "allowlist", allowed: [{ providerIds: ["openai"], modelIds: ["model-a"] }] };
      const save = () => repository.save(fixture.scope, { mutationId: randomUUID(), expectedRevision: repository.get(fixture.scope).revision, configuration: document }, next => projection.project(fixture.scope, next));
      save();
      const first = reader.getBackend(fixture.scope, "pi-primary");
      expect(first.configurationRevision).toBe(before.configurationRevision + 1);
      now = 500;
      document.backends[0]!.modelPolicy = { type: "allowlist", allowed: [{ modelIds: ["model-a"], providerIds: ["openai"] }] };
      save();
      expect(reader.getBackend(fixture.scope, "pi-primary")).toEqual(first);
      now = 600;
      document.backends[0]!.enabled = false;
      document.targets[0]!.enabled = false;
      document.defaultTargetId = null;
      save();
      expect(reader.getBackend(fixture.scope, "pi-primary")).toMatchObject({ configurationRevision: before.configurationRevision + 2, enabled: 0 });
    } finally { fixture.database.close(); }
  });

  it("increments preference revisions without moving timestamps backward", () => {
    const fixture = createFixture();
    try {
      const profile = new BackendConfigurationRepository(
        fixture.database,
      ).getProfileByTemplate(fixture.scope, "local-primary");
      const preferences = new ConnectionSettingPreferenceRepository(
        fixture.database,
      );

      expect(
        preferences.save(fixture.scope, profile.id, "model", "first", 500),
      ).toMatchObject({
        value: "first",
        revision: 0,
        createdAt: 500,
        updatedAt: 500,
      });
      expect(
        preferences.save(fixture.scope, profile.id, "model", "second", 600),
      ).toMatchObject({
        value: "second",
        revision: 1,
        createdAt: 500,
        updatedAt: 600,
      });
      expect(
        preferences.save(fixture.scope, profile.id, "model", "third", 550),
      ).toMatchObject({
        value: "third",
        revision: 2,
        createdAt: 500,
        updatedAt: 600,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("persists creation recovery, binding, Pi details/settings, and checkpoints", () => {
    const fixture = createFixture();
    try {
      const creation = new ConversationCreationRepository(fixture.database);
      const bindings = new ConversationBindingRepository(fixture.database);
      const pi = new PiConversationRepository(fixture.database);
      const prepared = creation.prepare(fixture.scope, fixture.threadId, {
        attemptId: "attempt-1",
        mutationId: "operation-1",
        expectedThreadRevision: 0,
        creationKind: "first_input",
        sourceKind: "composer",
        initialInputText: "durable initial input",
        initialContextExcerpts: [],
        initialAttachmentIds: [],
        initialTaskReferences: [],
        expectedDraftRevision: 1,
        backendCreationCorrelation: "pi-session-1",
        now: 400,
      });
      expect(prepared.phase).toBe("prepared");
      expect(
        creation.prepare(fixture.scope, fixture.threadId, {
          attemptId: "attempt-1",
          mutationId: "operation-1",
          expectedThreadRevision: 0,
          creationKind: "first_input",
          sourceKind: "composer",
          initialInputText: "durable initial input",
          initialContextExcerpts: [],
          initialAttachmentIds: [],
          initialTaskReferences: [],
          expectedDraftRevision: 1,
          backendCreationCorrelation: "pi-session-1",
          now: 401,
        }),
      ).toEqual(prepared);

      creation.markExternalCallStarted(
        fixture.scope,
        fixture.threadId,
        "attempt-1",
        410,
      );
      creation.recordConversationIdentified(
        fixture.scope,
        fixture.threadId,
        "attempt-1",
        {
          backendConversationId: "pi-session-1",
          opaqueBindingDetail: "pi-session-detail-1",
          reconciliationToken: "reconcile-1",
          now: 420,
        },
      );
      expect(() =>
        creation.markFirstSubmissionStarted(
          fixture.scope,
          fixture.threadId,
          "attempt-1",
          {
            reconciliationToken: "submission-reconcile-1",
            retryAnchor: "x".repeat(4_097),
            now: 429,
          },
        ),
      ).toThrow();
      creation.markFirstSubmissionStarted(
        fixture.scope,
        fixture.threadId,
        "attempt-1",
        {
          reconciliationToken: "submission-reconcile-1",
          retryAnchor: '{"version":1,"position":"entry-8"}',
          now: 430,
        },
      );

      const submission = pi.createSubmissionDetails(
        fixture.scope,
        fixture.threadId,
        {
          operationId: "operation-1",
          creationAttemptId: "attempt-1",
        },
      );
      expect(submission).toMatchObject({
        operationId: "operation-1",
        creationAttemptId: "attempt-1",
      });
      pi.recordAcceptedUserEntry(
        fixture.scope,
        fixture.threadId,
        "operation-1",
        "user-entry-10",
      );

      expect(() =>
        bindings.bindCreatedConversation(fixture.scope, fixture.threadId, {
          attemptId: "attempt-1",
          backendConversationId: "pi-session-1",
          acceptedAt: 440,
        }),
      ).toThrow("cannot be bound");
      creation.markAcceptedUnpersisted(
        fixture.scope,
        fixture.threadId,
        "attempt-1",
        {
          expected: "first_submission_started",
          acceptedAt: 440,
          reconciliationToken: "submission-reconcile-1",
          backendCorrelation: "pi-turn-1",
        },
      );
      expect(
        fixture.database.transaction(() => {
          const bound = bindings.bindCreatedConversation(
            fixture.scope,
            fixture.threadId,
            {
              attemptId: "attempt-1",
              backendConversationId: "pi-session-1",
              acceptedAt: 440,
            },
          );
          pi.saveBindingDetails(fixture.scope, fixture.threadId, {
            backendConversationId: "pi-session-1",
            opaqueBindingDetail: serializePiBindingDetail(
              "pi-session-1",
              "/tmp/pi-session-1.jsonl",
            ),
            nativeSessionPath: "/tmp/pi-session-1.jsonl",
          });
          return bound;
        })(),
      ).toMatchObject({
        backendConversationId: "pi-session-1",
        backendInstanceId: "pi-primary",
      });
      expect(
        creation.get(fixture.scope, fixture.threadId, "attempt-1"),
      ).toMatchObject({ phase: "bound", acceptedAt: 440, reconciledAt: 440 });
      expect(
        pi.getBindingDetails(fixture.scope, fixture.threadId),
      ).toMatchObject({ nativeSessionPath: "/tmp/pi-session-1.jsonl" });
      expect(
        fixture.database
          .prepare(
            "SELECT text, revision FROM thread_drafts WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?",
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
          ),
      ).toEqual({ text: "", revision: 2 });

      expect(
        pi.updateSettings(fixture.scope, fixture.threadId, {
          expectedRevision: 0,
          modelProvider: "openai",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "low",
          toolMode: "full",
        }),
      ).toMatchObject({
        revision: 1,
        modelProvider: "openai",
        modelId: "gpt-5.6-luna",
      });
      expect(() =>
        pi.updateSettings(fixture.scope, fixture.threadId, {
          expectedRevision: 1,
          modelProvider: "openai",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "unsupported",
          toolMode: "full",
        }),
      ).toThrow("thinking level is not supported");
      expect(
        new BackendCheckpointRepository(fixture.database).create(
          fixture.scope,
          fixture.threadId,
          {
            id: "checkpoint-1",
            applicationTurnId: "turn-1",
            opaqueReference: "pi-leaf-entry-10",
            now: 450,
          },
        ),
      ).toMatchObject({
        id: "checkpoint-1",
        backendInstanceId: "pi-primary",
        opaqueReference: "pi-leaf-entry-10",
      });
      expect(() =>
        fixture.database.transaction(() => {
          bindings.bindDiscoveredConversation(
            fixture.scope,
            fixture.secondThreadId,
            {
              backendConversationId: "pi-session-1",
              now: 460,
            },
          );
          pi.saveBindingDetails(fixture.scope, fixture.secondThreadId, {
            backendConversationId: "pi-session-1",
            opaqueBindingDetail: serializePiBindingDetail(
              "pi-session-1",
              "/tmp/pi-session-1.jsonl",
            ),
            nativeSessionPath: "/tmp/pi-session-1.jsonl",
          });
        })(),
      ).toThrow("already owned");

      const foreignScope = {
        tenantId: fixture.scope.tenantId,
        principalId: "another-principal",
      };
      expect(() => bindings.getTarget(foreignScope, fixture.threadId)).toThrow(
        "thread was not found",
      );
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("enforces phase fields and revises the thread when retry authority changes", () => {
    const fixture = createFixture();
    try {
      const creation = new ConversationCreationRepository(fixture.database);
      creation.prepare(fixture.scope, fixture.threadId, {
        attemptId: "attempt-phase-constraints",
        mutationId: "operation-phase-constraints",
        expectedThreadRevision: 0,
        creationKind: "first_input",
        sourceKind: "composer",
        initialInputText: "durable initial input",
        initialContextExcerpts: [],
        initialAttachmentIds: [],
        initialTaskReferences: [],
        expectedDraftRevision: 1,
        backendCreationCorrelation: "pi-session-phase-constraints",
        now: 500,
      });
      creation.markExternalCallStarted(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        510,
      );
      creation.recordConversationIdentified(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        {
          backendConversationId: "pi-session-phase-constraints",
          opaqueBindingDetail: "pi-session-phase-detail",
          now: 520,
        },
      );
      creation.markFirstSubmissionStarted(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        {
          reconciliationToken: "phase-reconciliation",
          retryAnchor: '{"version":1,"position":"phase"}',
          now: 530,
        },
      );

      expect(() =>
        fixture.database
          .prepare(
            `
              UPDATE conversation_creation_attempts
              SET accepted_at = NULL, phase = 'accepted_unpersisted'
              WHERE application_thread_id = ?
            `,
          )
          .run(fixture.threadId),
      ).toThrow();
      expect(() =>
        fixture.database
          .prepare(
            `
              UPDATE conversation_creation_attempts
              SET provisional_backend_conversation_id = NULL
              WHERE application_thread_id = ?
            `,
          )
          .run(fixture.threadId),
      ).toThrow();

      creation.markRecoveryRequired(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        {
          expected: "first_submission_started",
          reconciliationToken: "phase-reconciliation",
          diagnostic: "submission result unknown",
          now: 540,
        },
      );
      const beforeAuthorization = fixture.database
        .prepare(
          `
            SELECT revision, updated_at AS updatedAt
            FROM application_threads WHERE id = ?
          `,
        )
        .get(fixture.threadId) as { revision: number; updatedAt: number };
      creation.authorizeRetry(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        {
          expectedRetryMutationId: null,
          diagnostic: "not accepted",
          now: 550,
        },
      );
      const afterAuthorization = fixture.database
        .prepare(
          `
            SELECT revision, updated_at AS updatedAt
            FROM application_threads WHERE id = ?
          `,
        )
        .get(fixture.threadId) as { revision: number; updatedAt: number };
      expect(afterAuthorization).toEqual({
        revision: beforeAuthorization.revision + 1,
        updatedAt: 550,
      });

      creation.claimRetry(
        fixture.scope,
        fixture.threadId,
        "attempt-phase-constraints",
        {
          retryMutationId: "retry-phase-constraints",
          reconciliationToken: "retry-phase-constraints",
          retryAnchor: '{"version":1,"position":"retry"}',
          now: 560,
        },
      );
      expect(
        fixture.database
          .prepare(
            `
              SELECT revision, updated_at AS updatedAt
              FROM application_threads WHERE id = ?
            `,
          )
          .get(fixture.threadId),
      ).toEqual({
        revision: afterAuthorization.revision + 1,
        updatedAt: 560,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("enforces ordered durable queue retries, uncertainty, cancellation, and explicit retry", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const queuedConversationExcerpt = {
        id: "018f47cb-5f45-7f93-8d8d-bdb808b1f014",
        excerpt: "Retry this selected response.",
        source: {
          kind: "conversation_message" as const,
          itemId: "normalized-assistant-message-retry",
          itemRevision: 11,
        },
        locator: {
          kind: "text_quote" as const,
          prefix: "Before retry: ",
          suffix: " After retry.",
        },
      };
      drafts.save(fixture.scope, fixture.threadId, {
        text: "first",
        contextExcerpts: [queuedConversationExcerpt],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 590,
      });
      const retryPolicy: QueueRetryPolicy = {
        maximumRetries: 1,
        baseDelayMilliseconds: 100,
        maximumDelayMilliseconds: 1_000,
      };
      const automationSource = createAutomationQueueSource(
        fixture,
        "queue-operation-2",
      );
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "automation-with-context",
          mutationId: "automation-with-context-operation",
          text: "automation input",
          contextExcerpts: [
            {
              id: "018f47cb-5f45-7f93-8d8d-bdb808b1f012",
              excerpt: "selected text",
              source: {
                kind: "workspace_file",
                rootId: "primary",
                path: "src/example.ts",
                revision: "revision-2",
              },
              locator: {
                kind: "line_range",
                startLine: 1,
                endLine: 1,
              },
            },
          ],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "automation",
            expectedThreadRevision: 1,
            automationId: automationSource.automationId,
            automationRunId: automationSource.automationRunId,
          },
          now: 598,
        }),
      ).toThrow(
        new DomainError(
          "invalid_transition",
          "Automation queue inputs cannot contain interactive composer context.",
        ),
      );
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "stale-queue",
          mutationId: "stale-operation",
          text: "first",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "queue",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: 1,
            expectedDraftRevision: 1,
          },
          now: 599,
        }),
      ).toThrow("composer draft changed");
      expect(queue.list(fixture.scope, fixture.threadId)).toEqual([]);
      const first = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "queue-1",
        mutationId: "queue-operation-1",
        text: "first",
        contextExcerpts: [queuedConversationExcerpt],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: 1,
          expectedDraftRevision: 2,
        },
        now: 600,
      });
      expect(first.replayed).toBe(false);
      expect(first.item.contextExcerpts).toEqual([queuedConversationExcerpt]);
      expect(
        fixture.database
          .prepare(
            "SELECT text, revision FROM thread_drafts WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?",
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
          ),
      ).toEqual({ text: "", revision: 3 });
      expect(
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "ignored-replay-id",
          mutationId: "queue-operation-1",
          text: "first",
          contextExcerpts: [queuedConversationExcerpt],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "queue",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: 1,
            expectedDraftRevision: 2,
          },
          now: 601,
        }),
      ).toMatchObject({ replayed: true, item: { id: "queue-1", sequence: 1 } });
      queue.enqueue(fixture.scope, fixture.threadId, {
        id: "queue-2",
        mutationId: "queue-operation-2",
        text: "second",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: 2,
          automationId: automationSource.automationId,
          automationRunId: automationSource.automationRunId,
        },
        now: 610,
      });

      expect(() =>
        queue.claimHead(
          fixture.scope,
          fixture.threadId,
          "x".repeat(4_097),
          619,
        ),
      ).toThrow();
      expect(
        queue.get(fixture.scope, fixture.threadId, "queue-1"),
      ).toMatchObject({ state: "pending", retryAnchor: null });
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-1", 620)?.id,
      ).toBe("queue-1");
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-2", 621),
      ).toBeUndefined();
      expect(
        queue.handleCleanFailure(fixture.scope, fixture.threadId, "queue-1", {
          expectedState: "dispatching",
          retryable: true,
          diagnostic: "temporary",
          now: 630,
          retryPolicy,
        }),
      ).toMatchObject({
        state: "retry_wait",
        retryCount: 1,
        nextAttemptAt: 730,
      });
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-3", 729),
      ).toBeUndefined();
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-4", 730)?.id,
      ).toBe("queue-1");
      const beforeFailureRevision = threadRevision(fixture);
      expect(
        queue.handleCleanFailure(fixture.scope, fixture.threadId, "queue-1", {
          expectedState: "dispatching",
          retryable: true,
          diagnostic: "retry exhausted",
          now: 740,
          retryPolicy,
        }),
      ).toMatchObject({ state: "failed", failureAcknowledgedAt: null });
      expect(threadRevision(fixture)).toBe(beforeFailureRevision + 1);
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-5", 741),
      ).toBeUndefined();
      expect(() =>
        fixture.database
          .prepare(
            `
              INSERT INTO queued_inputs(
                tenant_id, owner_principal_id, id, application_thread_id,
                sequence, mutation_id, text, state, retry_of_id, created_at
              )
              VALUES (?, ?, 'cross-thread-retry', ?, 1,
                'cross-thread-retry-operation', 'first', 'pending',
                'queue-1', 745)
            `,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.secondThreadId,
          ),
      ).toThrow();
      const beforeExplicitRetryRevision = threadRevision(fixture);
      const failedRetry = queue.retryFailed(
        fixture.scope,
        fixture.threadId,
        "queue-1",
        {
          id: "queue-4",
          mutationId: "queue-operation-4",
          now: 750,
        },
      );
      expect(failedRetry).toMatchObject({
        replayed: false,
        item: {
          retryOfId: "queue-1",
          retryCount: 0,
          state: "pending",
          text: "first",
          contextExcerpts: [queuedConversationExcerpt],
        },
      });
      expect(threadRevision(fixture)).toBe(beforeExplicitRetryRevision + 1);
      expect(() =>
        fixture.database
          .prepare(
            `
              INSERT INTO queued_inputs(
                tenant_id, owner_principal_id, id, application_thread_id,
                sequence, mutation_id, text, state, retry_of_id, created_at
              )
              VALUES (?, ?, 'duplicate-retry', ?, 4,
                'duplicate-retry-operation', 'first', 'pending',
                'queue-1', 751)
            `,
          )
          .run(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            fixture.threadId,
          ),
      ).toThrow();

      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-6", 760)?.id,
      ).toBe("queue-2");
      queue.markUncertain(fixture.scope, fixture.threadId, "queue-2", {
        now: 761,
        reconciliationToken: "queue-reconcile-2",
        diagnostic: "connection lost",
      });
      expect(queue.listRecoveryRequired(fixture.scope)).toMatchObject([
        { id: "queue-2", state: "uncertain" },
      ]);
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-7", 761),
      ).toBeUndefined();
      const beforeAcceptanceRevision = threadRevision(fixture);
      expect(
        queue.markAccepted(fixture.scope, fixture.threadId, "queue-2", {
          expectedState: "uncertain",
          acceptedAt: 770,
          backendCorrelation: "pi-user-entry-2",
        }),
      ).toMatchObject({ state: "accepted", acceptedAt: 770 });
      expect(threadRevision(fixture)).toBe(beforeAcceptanceRevision + 1);
      expect(queue.listRecoveryRequired(fixture.scope)).toEqual([]);

      const automations = new AutomationRepository(fixture.database);
      automations.updateRunState(
        fixture.scope,
        automationSource.automationId,
        automationSource.automationRunId,
        {
          expectedState: "claimed",
          state: "failed",
          claimToken: automationSource.claimToken,
          errorCode: "fixture_superseded",
          errorDiagnostic: "The fixture created a newer queue dispatch.",
          now: 775,
        },
      );
      const nextAutomationRunId = "queue-provenance-run-2";
      automations.createManualRun(
        fixture.scope,
        automationSource.automationId,
        {
          runId: nextAutomationRunId,
          occurrenceKey: "queue-provenance-occurrence-2",
          scheduledFor: 776,
          claimToken: "queue-provenance-claim-2",
          leaseExpiresAt: 10_000,
          dispatchMutationId: "queue-operation-3",
          now: 776,
        },
      );

      const cancellable = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "queue-3",
        mutationId: "queue-operation-3",
        text: "cancel me",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: threadRevision(fixture),
          automationId: automationSource.automationId,
          automationRunId: nextAutomationRunId,
        },
        now: 780,
      }).item;
      const beforeCancellationRevision = threadRevision(fixture);
      expect(
        queue.cancel(fixture.scope, fixture.threadId, cancellable.id, {
          diagnostic: "user cancelled",
          now: 790,
        }),
      ).toMatchObject({ state: "cancelled", resolvedAt: 790 });
      expect(threadRevision(fixture)).toBe(beforeCancellationRevision + 1);
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-8", 810)?.id,
      ).toBe("queue-4");
      expect(
        queue.handleInvalidState(fixture.scope, fixture.threadId, "queue-4", {
          diagnostic: "actor became busy",
          now: 820,
          retryPolicy,
        }),
      ).toMatchObject({
        state: "pending",
        invalidStateRequeues: 1,
        retryCount: 0,
      });
      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "anchor-9", 830)?.id,
      ).toBe("queue-4");
      expect(
        queue.handleInvalidState(fixture.scope, fixture.threadId, "queue-4", {
          diagnostic: "actor raced twice",
          now: 840,
          retryPolicy,
        }),
      ).toMatchObject({
        state: "retry_wait",
        invalidStateRequeues: 1,
        retryCount: 1,
        nextAttemptAt: 940,
      });
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("persists idempotent user cancellation and queue-source Steer without touching the current draft", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const completions = new SubmissionCompletionRepository(fixture.database);

      const initialDraft = drafts.get(fixture.scope, fixture.threadId);
      const cancellable = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "cancel-idempotent-row",
        mutationId: "cancel-idempotent-enqueue",
        text: initialDraft.text,
        contextExcerpts: initialDraft.contextExcerpts,
        attachmentIds: initialDraft.attachments.map(({ id }) => id),
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: initialDraft.revision,
        },
        now: 600,
      }).item;
      const cancelRevision = threadRevision(fixture);
      const cancellation = queue.cancelIdempotently(
        fixture.scope,
        fixture.threadId,
        cancellable.id,
        {
          mutationId: "cancel-idempotent-operation",
          expectedThreadRevision: cancelRevision,
          now: 610,
        },
      );
      expect(cancellation).toMatchObject({
        replayed: false,
        item: {
          state: "cancelled",
          cancellationMutationId: "cancel-idempotent-operation",
        },
      });
      expect(threadRevision(fixture)).toBe(cancelRevision + 1);
      expect(
        queue.cancelIdempotently(
          fixture.scope,
          fixture.threadId,
          cancellable.id,
          {
            mutationId: "cancel-idempotent-operation",
            expectedThreadRevision: 0,
            now: 999,
          },
        ),
      ).toMatchObject({ replayed: true, item: { resolvedAt: 610 } });
      expect(() =>
        queue.cancelIdempotently(
          fixture.scope,
          fixture.threadId,
          "another-row",
          {
            mutationId: "cancel-idempotent-operation",
            expectedThreadRevision: threadRevision(fixture),
            now: 620,
          },
        ),
      ).toThrow(
        new DomainError(
          "conflict",
          "The cancellation mutation ID is already used for another queued input.",
        ),
      );

      const queuedDraft = drafts.save(fixture.scope, fixture.threadId, {
        text: "steer this queued input",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 630,
      });
      const steerExpectedThreadRevision = threadRevision(fixture);
      const steered = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "queue-source-steer-row",
        mutationId: "queue-source-steer-enqueue",
        text: queuedDraft.text,
        contextExcerpts: queuedDraft.contextExcerpts,
        attachmentIds: queuedDraft.attachments.map(({ id }) => id),
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: steerExpectedThreadRevision,
          expectedDraftRevision: queuedDraft.revision,
        },
        now: 640,
      }).item;
      const currentDraft = drafts.save(fixture.scope, fixture.threadId, {
        text: "do not clear this current draft",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 650,
      });
      const reservationRevision = threadRevision(fixture);
      const reservation = queue.reserveHeadForSteer(
        fixture.scope,
        fixture.threadId,
        steered.id,
        {
          steerOperationId: "queue-source-steer-operation",
          expectedThreadRevision: reservationRevision,
          now: 660,
        },
      );
      expect(reservation).toMatchObject({
        priorState: "pending",
        priorNextAttemptAt: null,
        priorDiagnostic: null,
        item: { state: "dispatching", deliveryMode: "steer" },
      });
      const receipt = operations.prepareQueuedInputSteer(
        fixture.scope,
        fixture.threadId,
        {
          mutationId: "queue-source-steer-operation",
          queuedInputId: steered.id,
          text: steered.text,
          contextExcerpts: steered.contextExcerpts,
          attachmentIds: steered.attachments.map(({ id }) => id),
          taskContexts: steered.taskContexts,
          expectedThreadRevision: reservationRevision,
          priorQueueState: reservation.priorState,
          priorNextAttemptAt: reservation.priorNextAttemptAt,
          priorDiagnostic: reservation.priorDiagnostic,
          now: 660,
        },
      );
      expect(receipt).toMatchObject({
        source: "queued_input",
        queuedInputId: steered.id,
        state: "prepared",
      });
      operations.markSteerSubmissionStarted(
        fixture.scope,
        receipt.mutationId,
        { kind: "turn" as const, turnId: "active-turn-1" },
      );
      operations.markSteerPendingMaterialization(
        fixture.scope,
        receipt.mutationId,
        670,
      );
      expect(
        operations.getSteer(fixture.scope, receipt.mutationId),
      ).toMatchObject({ state: "pending_materialization" });
      expect(
        queue.get(fixture.scope, fixture.threadId, steered.id),
      ).toMatchObject({ state: "dispatching", deliveryMode: "steer" });
      const acceptanceRevision = threadRevision(fixture);
      fixture.database.transaction(() => {
        operations.acceptSteer(fixture.scope, receipt.mutationId, 680);
        completions.recordAccepted(fixture.scope, fixture.threadId, {
          operationId: receipt.applicationOperationId,
          acceptedAt: 680,
          backendCorrelation: "backend-queue-steer",
        });
        queue.acceptSteered(fixture.scope, fixture.threadId, steered.id, {
          steerOperationId: receipt.mutationId,
          expectedState: "dispatching",
          acceptedAt: 680,
          backendCorrelation: "backend-queue-steer",
        });
      })();
      expect(threadRevision(fixture)).toBe(acceptanceRevision + 1);
      expect(
        queue.get(fixture.scope, fixture.threadId, steered.id),
      ).toMatchObject({ state: "accepted", deliveryMode: null });
      expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
        text: currentDraft.text,
        revision: currentDraft.revision,
      });
      expect(
        completions.find(
          fixture.scope,
          fixture.threadId,
          receipt.applicationOperationId,
        ),
      ).toMatchObject({ backendCorrelation: "backend-queue-steer" });
      expect(
        completions.find(fixture.scope, fixture.threadId, steered.mutationId),
      ).toBeUndefined();
      expect(() =>
        fixture.database
          .prepare(
            `UPDATE queued_inputs SET delivery_mode = 'steer'
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(fixture.scope.tenantId, fixture.scope.principalId, steered.id),
      ).toThrow();
    } finally {
      fixture.database.close();
    }
  });

  it("rejects cancel and restore after a failed user input is acknowledged", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const source = drafts.get(fixture.scope, fixture.threadId);
      const queued = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "acknowledged-failure-row",
        mutationId: "acknowledged-failure-enqueue",
        text: source.text,
        contextExcerpts: source.contextExcerpts,
        attachmentIds: source.attachments.map(({ id }) => id),
        taskReferences: source.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: source.revision,
        },
        now: 600,
      }).item;
      expect(
        queue.claimHead(
          fixture.scope,
          fixture.threadId,
          "acknowledged-failure-anchor",
          610,
        ),
      ).toMatchObject({ id: queued.id, state: "dispatching" });
      expect(
        queue.handleCleanFailure(fixture.scope, fixture.threadId, queued.id, {
          expectedState: "dispatching",
          retryable: false,
          diagnostic: "proven not accepted",
          now: 620,
          retryPolicy: {
            maximumRetries: 0,
            baseDelayMilliseconds: 100,
            maximumDelayMilliseconds: 100,
          },
        }),
      ).toMatchObject({ state: "failed", failureAcknowledgedAt: null });
      expect(
        queue.acknowledgeFailure(
          fixture.scope,
          fixture.threadId,
          queued.id,
          630,
        ),
      ).toMatchObject({ state: "failed", failureAcknowledgedAt: 630 });

      const expectedThreadRevision = threadRevision(fixture);
      const expectedDraftRevision = drafts.get(
        fixture.scope,
        fixture.threadId,
      ).revision;
      expect(() =>
        queue.cancelIdempotently(fixture.scope, fixture.threadId, queued.id, {
          mutationId: "acknowledged-failure-cancel",
          expectedThreadRevision,
          now: 640,
        }),
      ).toThrow("unacknowledged failed");
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, queued.id, {
          mutationId: "acknowledged-failure-restore",
          expectedThreadRevision,
          expectedDraftRevision,
          now: 650,
        }),
      ).toThrow("unacknowledged failed");
      expect(
        queue.get(fixture.scope, fixture.threadId, queued.id),
      ).toMatchObject({
        state: "failed",
        failureAcknowledgedAt: 630,
        cancellationMutationId: null,
      });
      expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
        text: "",
        revision: expectedDraftRevision,
      });
      expect(threadRevision(fixture)).toBe(expectedThreadRevision);
    } finally {
      fixture.database.close();
    }
  });

  it("atomically restores the complete queued composer payload and replays its receipt", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const attachments = new ComposerAttachmentRepository(fixture.database);
      const firstAttachmentId = "018f47cb-5f45-7f93-8d8d-111111111111";
      const secondAttachmentId = "018f47cb-5f45-7f93-8d8d-222222222222";
      for (const [index, attachmentId] of [
        firstAttachmentId,
        secondAttachmentId,
      ].entries()) {
        attachments.recordUpload(
          fixture.scope,
          fixture.threadId,
          attachmentId,
          {
            digest: String(index + 1).repeat(64),
            byteSize: index + 1,
            descriptor:
              index === 0
                ? {
                    id: attachmentId,
                    kind: "image",
                    fileName: "first.png",
                    mediaType: "image/png",
                    byteSize: index + 1,
                  }
                : {
                    id: attachmentId,
                    kind: "file",
                    fileName: "second.txt",
                    mediaType: "application/octet-stream",
                    byteSize: index + 1,
                  },
            ...(index === 0 ? { imageWidth: 10, imageHeight: 20 } : {}),
          },
          600 + index,
        );
      }
      const excerpt = {
        id: "018f47cb-5f45-7f93-8d8d-333333333333",
        excerpt: "selected restore context",
        source: {
          kind: "workspace_file" as const,
          rootId: "primary" as const,
          path: "src/restore.ts",
          revision: "restore-revision",
        },
        locator: {
          kind: "line_range" as const,
          startLine: 3,
          endLine: 4,
        },
      };
      const current = drafts.get(fixture.scope, fixture.threadId);
      const source = drafts.save(fixture.scope, fixture.threadId, {
        text: "restore every structured field",
        selectedSkillId: "skill:restore",
        contextExcerpts: [excerpt],
        attachmentIds: [secondAttachmentId, firstAttachmentId],
        taskReferenceIds: [],
        expectedRevision: current.revision,
        now: 610,
      });
      const queued = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "structured-restore-row",
        mutationId: "structured-restore-enqueue",
        text: source.text,
        selectedSkillId: source.selectedSkillId ?? undefined,
        contextExcerpts: source.contextExcerpts,
        attachmentIds: source.attachments.map(({ id }) => id),
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: source.revision,
        },
        now: 620,
      }).item;
      const emptyDraft = drafts.get(fixture.scope, fixture.threadId);
      const expectedThreadRevision = threadRevision(fixture);
      const restored = queue.restoreIdempotently(
        fixture.scope,
        fixture.threadId,
        queued.id,
        {
          mutationId: "structured-restore-operation",
          expectedThreadRevision,
          expectedDraftRevision: emptyDraft.revision,
          now: 630,
        },
      );
      expect(restored).toMatchObject({
        replayed: false,
        item: { state: "cancelled", diagnostic: "Restored to composer." },
        draft: {
          text: source.text,
          selectedSkillId: "skill:restore",
          contextExcerpts: [excerpt],
          revision: emptyDraft.revision + 1,
        },
      });
      expect(restored.draft.attachments.map(({ id }) => id)).toEqual([
        secondAttachmentId,
        firstAttachmentId,
      ]);
      expect(threadRevision(fixture)).toBe(expectedThreadRevision + 1);
      expect(
        queue.restoreIdempotently(fixture.scope, fixture.threadId, queued.id, {
          mutationId: "structured-restore-operation",
          expectedThreadRevision,
          expectedDraftRevision: emptyDraft.revision,
          now: 999,
        }),
      ).toMatchObject({
        replayed: true,
        draft: { revision: restored.draft.revision },
      });
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, queued.id, {
          mutationId: "structured-restore-operation",
          expectedThreadRevision: expectedThreadRevision + 1,
          expectedDraftRevision: emptyDraft.revision,
          now: 1000,
        }),
      ).toThrow("mutation ID is already used");
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it.each(["text", "skill", "context", "attachments"] as const)(
    "rejects restoration when the durable draft has nonempty %s",
    (dimension) => {
      const fixture = createFixture();
      try {
        bindDiscovered(fixture);
        const queue = new QueuedInputRepository(fixture.database);
        const drafts = new ConversationDraftRepository(fixture.database);
        const current = drafts.get(fixture.scope, fixture.threadId);
        const source = drafts.save(fixture.scope, fixture.threadId, {
          text: "queued restore source",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: current.revision,
          now: 600,
        });
        const queued = queue.enqueue(fixture.scope, fixture.threadId, {
          id: `nonempty-${dimension}-restore-row`,
          mutationId: `nonempty-${dimension}-restore-enqueue`,
          text: source.text,
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "queue",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: threadRevision(fixture),
            expectedDraftRevision: source.revision,
          },
          now: 610,
        }).item;
        const empty = drafts.get(fixture.scope, fixture.threadId);
        let attachmentIds: string[] = [];
        if (dimension === "attachments") {
          const attachmentId = "018f47cb-5f45-7f93-8d8d-444444444444";
          new ComposerAttachmentRepository(fixture.database).recordUpload(
            fixture.scope,
            fixture.threadId,
            attachmentId,
            {
              digest: "4".repeat(64),
              byteSize: 4,
              descriptor: {
                id: attachmentId,
                kind: "file",
                fileName: "occupied.txt",
                mediaType: "application/octet-stream",
                byteSize: 4,
              },
            },
            620,
          );
          attachmentIds = [attachmentId];
        }
        const excerpt = {
          id: "018f47cb-5f45-7f93-8d8d-555555555555",
          excerpt: "occupied context",
          source: {
            kind: "workspace_file" as const,
            rootId: "primary" as const,
            path: "src/occupied.ts",
            revision: "occupied-revision",
          },
          locator: {
            kind: "line_range" as const,
            startLine: 1,
            endLine: 1,
          },
        };
        const occupied = drafts.save(fixture.scope, fixture.threadId, {
          text: dimension === "text" ? " " : "",
          ...(dimension === "skill"
            ? { selectedSkillId: "skill:occupied" }
            : {}),
          contextExcerpts: dimension === "context" ? [excerpt] : [],
          attachmentIds,
          taskReferenceIds: [],
          expectedRevision: empty.revision,
          now: 630,
        });
        const beforeThreadRevision = threadRevision(fixture);
        expect(() =>
          queue.restoreIdempotently(
            fixture.scope,
            fixture.threadId,
            queued.id,
            {
              mutationId: `nonempty-${dimension}-restore-operation`,
              expectedThreadRevision: beforeThreadRevision,
              expectedDraftRevision: occupied.revision,
              now: 640,
            },
          ),
        ).toThrow("composer must be empty");
        expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
          revision: occupied.revision,
          text: occupied.text,
        });
        expect(
          queue.get(fixture.scope, fixture.threadId, queued.id).state,
        ).toBe("pending");
        expect(threadRevision(fixture)).toBe(beforeThreadRevision);
      } finally {
        fixture.database.close();
      }
    },
  );

  it("rejects non-browser provenance, terminal state, wrong scope, and stale revision fences without partial changes", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const agent = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "agent-control-restore-row",
        mutationId: "agent-control-restore-enqueue",
        text: "agent control input",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "agent_control",
          expectedThreadRevision: threadRevision(fixture),
          initiatingAgentThreadId: fixture.secondThreadId,
        },
        now: 600,
      }).item;
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, agent.id, {
          mutationId: "agent-control-restore-operation",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: drafts.get(fixture.scope, fixture.threadId)
            .revision,
          now: 610,
        }),
      ).toThrow("Only browser-origin user queued input");

      const automationSource = createAutomationQueueSource(
        fixture,
        "automation-restore-enqueue",
      );
      const automation = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "automation-restore-row",
        mutationId: "automation-restore-enqueue",
        text: "automation input",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: threadRevision(fixture),
          automationId: automationSource.automationId,
          automationRunId: automationSource.automationRunId,
        },
        now: 620,
      }).item;
      expect(() =>
        queue.restoreIdempotently(
          fixture.scope,
          fixture.threadId,
          automation.id,
          {
            mutationId: "automation-restore-operation",
            expectedThreadRevision: threadRevision(fixture),
            expectedDraftRevision: drafts.get(fixture.scope, fixture.threadId)
              .revision,
            now: 630,
          },
        ),
      ).toThrow("Only browser-origin user queued input");

      const current = drafts.get(fixture.scope, fixture.threadId);
      const source = drafts.save(fixture.scope, fixture.threadId, {
        text: "browser restore input",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: current.revision,
        now: 640,
      });
      const browser = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "browser-restore-fences-row",
        mutationId: "browser-restore-fences-enqueue",
        text: source.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: source.revision,
        },
        now: 650,
      }).item;
      const empty = drafts.get(fixture.scope, fixture.threadId);
      const currentThreadRevision = threadRevision(fixture);
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, browser.id, {
          mutationId: "stale-thread-restore-operation",
          expectedThreadRevision: currentThreadRevision - 1,
          expectedDraftRevision: empty.revision,
          now: 660,
        }),
      ).toThrow("thread changed");
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, browser.id, {
          mutationId: "stale-draft-restore-operation",
          expectedThreadRevision: currentThreadRevision,
          expectedDraftRevision: empty.revision - 1,
          now: 670,
        }),
      ).toThrow("draft changed");
      expect(() =>
        queue.restoreIdempotently(
          fixture.scope,
          fixture.secondThreadId,
          browser.id,
          {
            mutationId: "wrong-thread-restore-operation",
            expectedThreadRevision: currentThreadRevision,
            expectedDraftRevision: empty.revision,
            now: 680,
          },
        ),
      ).toThrow();
      expect(queue.get(fixture.scope, fixture.threadId, browser.id).state).toBe(
        "pending",
      );
      expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
        text: "",
        revision: empty.revision,
      });
      expect(threadRevision(fixture)).toBe(currentThreadRevision);
      queue.cancel(fixture.scope, fixture.threadId, browser.id, { now: 690 });
      expect(() =>
        queue.restoreIdempotently(fixture.scope, fixture.threadId, browser.id, {
          mutationId: "terminal-restore-operation",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: empty.revision,
          now: 700,
        }),
      ).toThrow(
        "Only pending, retry-scheduled, or unacknowledged failed",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("retains a scope-authorized cancellation projection after archival", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const draft = new ConversationDraftRepository(fixture.database).get(
        fixture.scope,
        fixture.threadId,
      );
      const item = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "cancel-before-archive",
        mutationId: "cancel-before-archive-enqueue",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: draft.attachments.map(({ id }) => id),
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 600,
      }).item;
      const expectedThreadRevision = threadRevision(fixture);
      queue.cancelIdempotently(fixture.scope, fixture.threadId, item.id, {
        mutationId: "cancel-before-archive-operation",
        expectedThreadRevision,
        now: 610,
      });
      fixture.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'archived'
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
        );

      expect(
        queue.cancelIdempotently(fixture.scope, fixture.threadId, item.id, {
          mutationId: "cancel-before-archive-operation",
          expectedThreadRevision: 0,
          now: 999,
        }),
      ).toMatchObject({ replayed: true, item: { state: "cancelled" } });
      expect(
        queue.readProjectionState(fixture.scope, fixture.threadId),
      ).toEqual({
        threadRevision: expectedThreadRevision + 1,
        records: [expect.objectContaining({ id: item.id, state: "cancelled" })],
      });
      expect(() =>
        queue.readProjectionState(
          { ...fixture.scope, principalId: "another-principal" },
          fixture.threadId,
        ),
      ).toThrow("thread was not found");
    } finally {
      fixture.database.close();
    }
  });

  it("restores the exact retry boundary when a prepared queue-source Steer is proven not applied", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const draft = drafts.get(fixture.scope, fixture.threadId);
      const item = queue.enqueue(fixture.scope, fixture.threadId, {
        id: "restore-queue-source-steer-row",
        mutationId: "restore-queue-source-enqueue",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: draft.attachments.map(({ id }) => id),
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 600,
      }).item;
      queue.claimHead(fixture.scope, fixture.threadId, "retry-boundary", 610);
      const retry = queue.handleCleanFailure(
        fixture.scope,
        fixture.threadId,
        item.id,
        {
          expectedState: "dispatching",
          retryable: true,
          diagnostic: "temporary failure",
          now: 620,
          retryPolicy: {
            maximumRetries: 2,
            baseDelayMilliseconds: 100,
            maximumDelayMilliseconds: 1_000,
          },
        },
      );
      expect(retry).toMatchObject({
        state: "retry_wait",
        nextAttemptAt: 720,
        diagnostic: "temporary failure",
      });
      const expectedThreadRevision = threadRevision(fixture);
      const reservation = queue.reserveHeadForSteer(
        fixture.scope,
        fixture.threadId,
        item.id,
        {
          steerOperationId: "restore-queue-source-steer",
          expectedThreadRevision,
          now: 630,
        },
      );
      expect(reservation).toMatchObject({
        priorState: "retry_wait",
        priorNextAttemptAt: 720,
        priorDiagnostic: "temporary failure",
      });
      const receipt = operations.prepareQueuedInputSteer(
        fixture.scope,
        fixture.threadId,
        {
          mutationId: "restore-queue-source-steer",
          queuedInputId: item.id,
          text: item.text,
          contextExcerpts: item.contextExcerpts,
          attachmentIds: item.attachments.map(({ id }) => id),
          taskContexts: item.taskContexts,
          expectedThreadRevision,
          priorQueueState: reservation.priorState,
          priorNextAttemptAt: reservation.priorNextAttemptAt,
          priorDiagnostic: reservation.priorDiagnostic,
          now: 630,
        },
      );
      const beforeRestoreRevision = threadRevision(fixture);
      fixture.database.transaction(() => {
        operations.rejectSteerBeforeAcceptance(
          fixture.scope,
          receipt.mutationId,
        );
        queue.restoreSteerReservation(
          fixture.scope,
          fixture.threadId,
          item.id,
          {
            steerOperationId: receipt.mutationId,
            expectedState: "dispatching",
            priorState: receipt.priorQueueState,
            priorNextAttemptAt: receipt.priorNextAttemptAt,
            priorDiagnostic: receipt.priorDiagnostic,
            now: 640,
          },
        );
      })();
      expect(threadRevision(fixture)).toBe(beforeRestoreRevision + 1);
      expect(queue.get(fixture.scope, fixture.threadId, item.id)).toMatchObject(
        {
          state: "retry_wait",
          deliveryMode: null,
          nextAttemptAt: 720,
          diagnostic: "temporary failure",
        },
      );
      expect(
        operations.findSteer(fixture.scope, receipt.mutationId),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  it("prepares a skill-only steering operation from the authoritative draft", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const draft = drafts.save(fixture.scope, fixture.threadId, {
        text: "",
        selectedSkillId: "opaque-review-skill",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 590,
      });
      const operations = new ConversationOperationRepository(fixture.database);

      expect(
        operations.prepareSteer(fixture.scope, fixture.threadId, {
          mutationId: "skill-only-steer",
          text: "",
          selectedSkillId: "opaque-review-skill",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
          now: 600,
        }),
      ).toMatchObject({
        mutationId: "skill-only-steer",
        selectedSkillId: "opaque-review-skill",
        expectedDraftRevision: draft.revision,
        state: "prepared",
      });
      expect(operations.listPreparedDraftSteers(fixture.scope)).toEqual([
        expect.objectContaining({
          mutationId: "skill-only-steer",
          source: "draft",
          state: "prepared",
        }),
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("retains a pending steer draft and preserves a newer edit on materialization", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const drafts = new ConversationDraftRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const submitted = drafts.save(fixture.scope, fixture.threadId, {
        text: "Steer this exact draft",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: drafts.get(fixture.scope, fixture.threadId).revision,
        now: 600,
      });
      const receipt = operations.prepareSteer(fixture.scope, fixture.threadId, {
        mutationId: "pending-draft-steer",
        text: submitted.text,
        contextExcerpts: submitted.contextExcerpts,
        attachmentIds: submitted.attachments.map(({ id }) => id),
        taskReferences: [],
        expectedThreadRevision: threadRevision(fixture),
        expectedDraftRevision: submitted.revision,
        now: 610,
      });
      expect(() =>
        operations.prepareSteer(fixture.scope, fixture.threadId, {
          mutationId: "second-prepared-draft-steer",
          text: submitted.text,
          contextExcerpts: submitted.contextExcerpts,
          attachmentIds: submitted.attachments.map(({ id }) => id),
          taskReferences: [],
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: submitted.revision,
          now: 611,
        }),
      ).toThrow("Wait for the previous steering input to appear");
      operations.markSteerSubmissionStarted(
        fixture.scope,
        receipt.mutationId,
        { kind: "turn" as const, turnId: "active-turn-1" },
      );
      expect(operations.listPreparedDraftSteers(fixture.scope)).toEqual([]);
      const beforePendingRevision = threadRevision(fixture);
      expect(
        operations.markSteerPendingMaterialization(
          fixture.scope,
          receipt.mutationId,
          620,
        ),
      ).toMatchObject({ state: "pending_materialization" });
      expect(threadRevision(fixture)).toBe(beforePendingRevision + 1);
      expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
        text: submitted.text,
        revision: submitted.revision,
      });
      expect(
        operations.hasPendingMaterializationSteer(
          fixture.scope,
          fixture.threadId,
        ),
      ).toBe(true);
      expect(() =>
        operations.prepareSteer(fixture.scope, fixture.threadId, {
          mutationId: "second-pending-draft-steer",
          text: submitted.text,
          contextExcerpts: submitted.contextExcerpts,
          attachmentIds: submitted.attachments.map(({ id }) => id),
          taskReferences: [],
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: submitted.revision,
          now: 630,
        }),
      ).toThrow("Wait for the previous steering input to appear");

      const newer = drafts.save(fixture.scope, fixture.threadId, {
        text: "A newer composer edit",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: submitted.revision,
        now: 640,
      });
      operations.acceptSteer(fixture.scope, receipt.mutationId, 650);

      expect(
        operations.getSteer(fixture.scope, receipt.mutationId),
      ).toMatchObject({ state: "accepted" });
      expect(drafts.get(fixture.scope, fixture.threadId)).toMatchObject({
        text: newer.text,
        revision: newer.revision,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("arbitrates archive atomically with durable queue work and stores a compact replay receipt", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const inventory = new InventoryRepository(fixture.database);
      const draft = fixture.database
        .prepare(
          "SELECT text, revision FROM thread_drafts WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?",
        )
        .get(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
        ) as { text: string; revision: number };
      queue.enqueue(fixture.scope, fixture.threadId, {
        id: "archive-barrier-queue",
        mutationId: "archive-barrier-queue-operation",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 600,
      });
      expect(
        inventory.findArchiveDurablyBlockedThreadIds(fixture.scope, [
          fixture.threadId,
        ]),
      ).toEqual(new Set([fixture.threadId]));

      expect(() =>
        inventory.archiveThreads(fixture.scope, fixture.threadId, {
          expectedRevision: 0,
          mutationId: "archive-barrier",
          includeDescendants: false,
          expectedThreadIds: [fixture.threadId],
          blockedThreadIds: new Set(),
          executionWorkspaceDisposition: { kind: "keep" },
          now: 610,
        }),
      ).toThrow("active or unresolved work");
      expect(
        inventory.getInventory(fixture.scope, fixture.threadId).inventoryState,
      ).toBe("active");

      fixture.database
        .prepare(
          "UPDATE queued_inputs SET state = 'cancelled', resolved_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?",
        )
        .run(
          620,
          fixture.scope.tenantId,
          fixture.scope.principalId,
          "archive-barrier-queue",
        );
      const archived = inventory.archiveThreads(
        fixture.scope,
        fixture.threadId,
        {
          expectedRevision: 0,
          mutationId: "archive-barrier",
          includeDescendants: false,
          expectedThreadIds: [fixture.threadId],
          blockedThreadIds: new Set(),
          executionWorkspaceDisposition: { kind: "keep" },
          now: 630,
        },
      );
      expect(archived).toMatchObject({
        replayed: false,
        states: [{ threadId: fixture.threadId, inventoryState: "archived" }],
      });
      const receipt = fixture.database
        .prepare(
          "SELECT result_json AS resultJson FROM mutation_receipts WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?",
        )
        .get(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          "archive-barrier",
        ) as { resultJson: string };
      expect(JSON.parse(receipt.resultJson)).toEqual({
        version: 2,
        threadIds: [fixture.threadId],
        movedTaskIds: [],
      });

      fixture.database
        .prepare(
          "UPDATE application_threads SET availability = 'missing' WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?",
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
        );
      expect(
        inventory.findArchiveThreadsReplay(fixture.scope, fixture.threadId, {
          expectedRevision: 0,
          mutationId: "archive-barrier",
          includeDescendants: false,
        }),
      ).toMatchObject({
        threadIds: [fixture.threadId],
        states: [{ threadId: fixture.threadId, inventoryState: "archived" }],
      });
      expect(() =>
        inventory.findArchiveThreadsReplay(fixture.scope, fixture.threadId, {
          expectedRevision: 1,
          mutationId: "archive-barrier",
          includeDescendants: false,
        }),
      ).toThrow("mutation ID was reused");
    } finally {
      fixture.database.close();
    }
  });

  it("rejects enqueue and dispatch claims after archival", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const queue = new QueuedInputRepository(fixture.database);
      const draft = fixture.database
        .prepare(
          "SELECT text, revision FROM thread_drafts WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?",
        )
        .get(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
        ) as { text: string; revision: number };
      queue.enqueue(fixture.scope, fixture.threadId, {
        id: "archived-claim-queue",
        mutationId: "archived-claim-operation",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: threadRevision(fixture),
          expectedDraftRevision: draft.revision,
        },
        now: 600,
      });
      fixture.database
        .prepare(
          "UPDATE thread_principal_state SET inventory_state = 'archived', inventory_revision = inventory_revision + 1 WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?",
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
        );

      expect(
        queue.claimHead(fixture.scope, fixture.threadId, "archive-anchor", 610),
      ).toBeUndefined();
      expect(
        queue.get(fixture.scope, fixture.threadId, "archived-claim-queue"),
      ).toMatchObject({ state: "pending", retryAnchor: null });
      expect(() =>
        queue.enqueue(fixture.scope, fixture.threadId, {
          id: "archived-enqueue",
          mutationId: "archived-enqueue-operation",
          text: "blocked",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "queue",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: threadRevision(fixture),
            expectedDraftRevision: draft.revision + 1,
          },
          now: 620,
        }),
      ).toThrow("archived thread cannot accept queued input");
    } finally {
      fixture.database.close();
    }
  });

  it("acknowledges one thread-level completion state through the visible completion", () => {
    const fixture = createFixture();
    try {
      bindDiscovered(fixture);
      const repository = new SubmissionCompletionRepository(fixture.database);
      repository.recordAccepted(fixture.scope, fixture.threadId, {
        operationId: "send-1",
        acceptedAt: 600,
        backendCorrelation: "user-entry-1",
      });
      expect(
        repository.observeCompletion(
          fixture.scope,
          fixture.threadId,
          "send-1",
          {
            completionIdentity: "assistant-entry-1",
            observedAt: 700,
            createAttention: true,
          },
        ),
      ).toMatchObject({
        lastCompletionIdentity: "assistant-entry-1",
        attentionCreatedAt: 700,
        acknowledgedAt: null,
      });
      expect(repository.listUnacknowledged(fixture.scope)).toHaveLength(1);
      repository.recordAccepted(fixture.scope, fixture.threadId, {
        operationId: "z-visible",
        acceptedAt: 710,
        backendCorrelation: "user-entry-2",
      });
      repository.observeCompletion(
        fixture.scope,
        fixture.threadId,
        "z-visible",
        {
          completionIdentity: "assistant-entry-2",
          observedAt: 750,
          createAttention: true,
        },
      );
      repository.recordAccepted(fixture.scope, fixture.threadId, {
        operationId: "a-late",
        acceptedAt: 740,
        backendCorrelation: "user-entry-3",
      });
      expect(
        repository.observeCompletion(
          fixture.scope,
          fixture.threadId,
          "a-late",
          {
            completionIdentity: "assistant-entry-3",
            observedAt: 750,
            createAttention: true,
          },
        ),
      ).toMatchObject({ attentionCreatedAt: 751 });
      expect(repository.listUnacknowledged(fixture.scope)).toHaveLength(3);

      expect(
        repository.acknowledgeThrough(
          fixture.scope,
          fixture.threadId,
          "z-visible",
          800,
        ),
      ).toMatchObject({ acknowledgedAt: 800 });
      expect(repository.listUnacknowledged(fixture.scope)).toMatchObject([
        { operationId: "a-late", acknowledgedAt: null },
      ]);
      expect(
        repository.acknowledgeThrough(
          fixture.scope,
          fixture.threadId,
          "z-visible",
          900,
        ),
      ).toMatchObject({ acknowledgedAt: 800 });
      expect(
        repository.find(
          {
            tenantId: fixture.scope.tenantId,
            principalId: "another-principal",
          },
          fixture.threadId,
          "send-1",
        ),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  it("strictly parses interaction-response receipts and scrubs accepted response content", () => {
    const fixture = createFixture();
    const operationId = "00000000-0000-4000-8000-000000000001";
    try {
      const repository = new ConversationOperationRepository(fixture.database);
      repository.prepareRecoverableInteractionResponse(
        fixture.scope,
        fixture.threadId,
        {
          operationId,
          interactionId: "interaction-1",
          response: { kind: "text_input", value: "private response text" },
          backendResponse: {
            applicationOperationId: operationId,
            interactionId: "pi-interaction-1",
            kind: "text_input",
            value: "private response text",
          },
          now: 600,
        },
      );
      repository.markInteractionResponseStarted(fixture.scope, operationId);
      const accepted = repository.acceptInteractionResponse(
        fixture.scope,
        operationId,
      );

      expect(accepted).toMatchObject({
        operationId,
        interactionId: "interaction-1",
        state: "accepted",
      });
      expect(accepted.response).toBeUndefined();
      expect(accepted.backendResponse).toBeUndefined();
      const stored = fixture.database
        .prepare(
          `
            SELECT result_json AS resultJson
            FROM mutation_receipts
            WHERE mutation_id = ?
          `,
        )
        .get(operationId) as { resultJson: string };
      expect(stored.resultJson).not.toContain("private response text");

      fixture.database
        .prepare(
          `
            UPDATE mutation_receipts
            SET result_json = json_set(
              result_json,
              '$.response',
              json('{"kind":"text_input","value":"injected"}')
            )
            WHERE mutation_id = ?
          `,
        )
        .run(operationId);
      expect(() =>
        repository.getInteractionResponse(fixture.scope, operationId),
      ).toThrow("conversation_interaction_response_receipt_payload_invalid");
    } finally {
      fixture.database.close();
    }
  });

  it("CAS-accepts only the exact uncertain interaction response and preserves abandonment", () => {
    const fixture = createFixture();
    const repository = new ConversationOperationRepository(fixture.database);
    const operationId = "00000000-0000-4000-8000-000000000002";
    const response = { kind: "confirmation" as const, confirmed: true };
    try {
      repository.prepareRecoverableInteractionResponse(
        fixture.scope,
        fixture.threadId,
        {
          operationId,
          interactionId: "interaction-cas",
          response,
          backendResponse: {
            applicationOperationId: operationId,
            interactionId: "provider-interaction-cas",
            ...response,
          },
          now: 610,
        },
      );
      repository.markInteractionResponseStarted(fixture.scope, operationId);

      expect(
        repository.acceptInteractionResponseIfUncertain(
          fixture.scope,
          fixture.threadId,
          {
            operationId,
            interactionId: "interaction-cas",
            response: { kind: "confirmation", confirmed: false },
          },
        ),
      ).toBe(false);
      expect(
        repository.acceptInteractionResponseIfUncertain(
          { ...fixture.scope, principalId: "another-principal" },
          fixture.threadId,
          { operationId, interactionId: "interaction-cas", response },
        ),
      ).toBe(false);
      expect(
        repository.acceptInteractionResponseIfUncertain(
          fixture.scope,
          fixture.threadId,
          { operationId, interactionId: "interaction-cas", response },
        ),
      ).toBe(true);
      expect(
        repository.getInteractionResponse(fixture.scope, operationId),
      ).toMatchObject({ state: "accepted", interactionId: "interaction-cas" });

      const abandonedOperationId = "00000000-0000-4000-8000-000000000003";
      repository.prepareRecoverableInteractionResponse(
        fixture.scope,
        fixture.threadId,
        {
          operationId: abandonedOperationId,
          interactionId: "interaction-abandoned",
          response,
          backendResponse: {
            applicationOperationId: abandonedOperationId,
            interactionId: "provider-interaction-abandoned",
            ...response,
          },
          now: 620,
        },
      );
      repository.markInteractionResponseStarted(
        fixture.scope,
        abandonedOperationId,
      );
      fixture.database
        .prepare(
          `
            UPDATE mutation_receipts
            SET result_code = 'abandoned'
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          `,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          abandonedOperationId,
        );

      expect(
        repository.acceptInteractionResponseIfUncertain(
          fixture.scope,
          fixture.threadId,
          {
            operationId: abandonedOperationId,
            interactionId: "interaction-abandoned",
            response,
          },
        ),
      ).toBe(false);
      expect(() =>
        repository.getInteractionResponse(fixture.scope, abandonedOperationId),
      ).toThrow("explicitly abandoned");
    } finally {
      fixture.database.close();
    }
  });

  it("replays every abandoned conversation-operation receipt as a precise conflict", () => {
    const fixture = createFixture();
    const repository = new ConversationOperationRepository(fixture.database);
    const cases = [
      {
        mutationId: "abandoned-steer",
        operationKind: "conversation_steer",
        replay: () => repository.getSteer(fixture.scope, "abandoned-steer"),
        message: "The steering operation was explicitly abandoned.",
      },
      {
        mutationId: "abandoned-interrupt",
        operationKind: "conversation_interrupt",
        replay: () =>
          repository.getInterrupt(fixture.scope, "abandoned-interrupt"),
        message: "The interrupt operation was explicitly abandoned.",
      },
      ...[
        ["rename", "conversation_rename"],
        ["compact", "conversation_compact"],
        ["settings", "conversation_settings"],
      ].map(([suffix, operationKind]) => ({
        mutationId: `abandoned-${suffix}`,
        operationKind: operationKind!,
        replay: () =>
          repository.getBackendAction(fixture.scope, `abandoned-${suffix}`),
        message: "The backend action operation was explicitly abandoned.",
      })),
    ];
    try {
      const insert = fixture.database.prepare(
        `
          INSERT INTO mutation_receipts(
            tenant_id, principal_id, thread_id, mutation_id,
            operation_kind, request_fingerprint, result_code, result_json,
            replayable, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'abandoned', '{}', 0, 700)
        `,
      );
      for (const testCase of cases) {
        insert.run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          fixture.threadId,
          testCase.mutationId,
          testCase.operationKind,
          "f".repeat(64),
        );
        expect(testCase.replay).toThrow(
          new DomainError("conflict", testCase.message),
        );
      }
    } finally {
      fixture.database.close();
    }
  });

  it("strictly restores server-private decision and questionnaire response receipts", () => {
    const fixture = createFixture();
    const questionnaireOperationId = "00000000-0000-4000-8000-000000000011";
    const decisionOperationId = "00000000-0000-4000-8000-000000000012";
    try {
      const repository = new ConversationOperationRepository(fixture.database);
      repository.prepareRecoverableInteractionResponse(
        fixture.scope,
        fixture.threadId,
        {
          operationId: questionnaireOperationId,
          interactionId: "browser-questionnaire",
          response: {
            kind: "questionnaire",
            answers: [
              {
                questionId: "browser-question",
                answer: { kind: "unanswered" },
              },
            ],
          },
          backendResponse: {
            applicationOperationId: questionnaireOperationId,
            interactionId: "q".repeat(512),
            kind: "questionnaire",
            answers: [
              {
                questionId: "question".repeat(64),
                answer: { kind: "unanswered" },
              },
            ],
          },
          now: 700,
        },
      );
      expect(
        repository.getInteractionResponse(
          fixture.scope,
          questionnaireOperationId,
        ).backendResponse,
      ).toMatchObject({ kind: "questionnaire" });

      repository.prepareRecoverableInteractionResponse(
        fixture.scope,
        fixture.threadId,
        {
          operationId: decisionOperationId,
          interactionId: "browser-decision",
          response: { kind: "decision", selectedActionId: "browser-action" },
          backendResponse: {
            applicationOperationId: decisionOperationId,
            interactionId: "backend-decision",
            kind: "decision",
            selectedActionId: "a".repeat(512),
          },
          now: 701,
        },
      );
      expect(
        repository.getInteractionResponse(fixture.scope, decisionOperationId)
          .backendResponse,
      ).toMatchObject({ kind: "decision", selectedActionId: "a".repeat(512) });

      expect(() =>
        repository.prepareRecoverableInteractionResponse(
          fixture.scope,
          fixture.threadId,
          {
            operationId: "00000000-0000-4000-8000-000000000013",
            interactionId: "obsolete-auto-resolution",
            response: {
              kind: "questionnaire",
              answers: [
                {
                  questionId: "browser-question",
                  answer: { kind: "text", value: "answered" },
                },
              ],
            },
            backendResponse: {
              applicationOperationId: "00000000-0000-4000-8000-000000000013",
              interactionId: "backend-questionnaire",
              kind: "questionnaire",
              resolution: "auto",
              answers: [
                {
                  questionId: "backend-question",
                  answer: { kind: "text", value: "answered" },
                },
              ],
            } as never,
            now: 702,
          },
        ),
      ).toThrow("conversation_interaction_response_backend_payload_invalid");
    } finally {
      fixture.database.close();
    }
  });
});


describe("explicit Steer target persistence", () => {
  it("migrates exact-turn queue and v4 receipt targets once, preserving scoped identity", () => {
    const fixture = createFixture(100);
    try {
      fixture.database.prepare(`INSERT INTO queued_inputs (
        tenant_id, owner_principal_id, application_thread_id, id, sequence, mutation_id,
        text, state, created_at, requested_delivery_mode, requested_thread_revision,
        requested_draft_revision, requested_steer_turn_id, resolved_delivery_mode, resolved_steer_turn_id
      ) VALUES (?, ?, ?, 'old-steer', 1, 'old-operation', 'original text', 'pending', 600,
        'queue', 1, 1, 'original-turn', 'steer', 'original-turn')`).run(
          fixture.scope.tenantId, fixture.scope.principalId, fixture.threadId);
      fixture.database.prepare(`INSERT INTO mutation_receipts (
        tenant_id, principal_id, thread_id, mutation_id, operation_kind, request_fingerprint,
        result_code, result_json, task_contexts_json, replayable, created_at
      ) VALUES (?, ?, ?, 'old-steer-receipt', 'conversation_steer', ?, 'pending_materialization', ?, '[]', 1, 601)`).run(
        fixture.scope.tenantId, fixture.scope.principalId, fixture.threadId, "a".repeat(64),
        JSON.stringify({ version: 4, source: "draft", applicationOperationId: "old-steer-receipt",
          reconciliationToken: "old-steer-receipt", expectedThreadRevision: 1, expectedDraftRevision: 1,
          selectedSkillId: null, contextExcerpts: [], expectedActiveTurnId: "original-turn" }));
      applyDatabaseMigrations(fixture.database, backendNormalizedMigrations);
      const queue = new QueuedInputRepository(fixture.database);
      expect(queue.get(fixture.scope, fixture.threadId, "old-steer")).toMatchObject({
        state: "pending", requestedSteerTarget: { kind: "turn", turnId: "original-turn" },
        resolvedSteerTarget: { kind: "turn", turnId: "original-turn" }, text: "original text",
      });
      expect(new ConversationOperationRepository(fixture.database).getSteer(fixture.scope, "old-steer-receipt")).toMatchObject({
        state: "pending_materialization", target: { kind: "turn", turnId: "original-turn" },
      });
      expect(() => queue.get({ ...fixture.scope, principalId: "other-principal" }, fixture.threadId, "old-steer")).toThrow();
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
      expect(fixture.database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(() => fixture.database.prepare("SELECT requested_steer_turn_id FROM queued_inputs")).toThrow();
    } finally { fixture.database.close(); }
  });

  it("rejects malformed persisted targets and round trips conversation targets without sentinel IDs", () => {
    const fixture = createFixture();
    try {
      const insert = fixture.database.prepare(`INSERT INTO queued_inputs (
        tenant_id, owner_principal_id, application_thread_id, id, sequence, mutation_id,
        text, state, created_at, requested_delivery_mode, requested_thread_revision,
        requested_draft_revision, requested_steer_target_json, resolved_delivery_mode, resolved_steer_target_json
      ) VALUES (?, ?, ?, 'conversation-target', 1, 'conversation-operation', 'new guidance', 'pending', 600,
        'queue', 1, 1, ?, 'steer', ?)`);
      for (const malformed of [{}, { kind: null }, { kind: "turn" }, { kind: "turn", turnId: "" },
        { kind: "turn", turnId: 1 }, { kind: "conversation", turnId: "invented" }, { kind: "unknown" }]) {
        expect(() => insert.run(fixture.scope.tenantId, fixture.scope.principalId, fixture.threadId,
          JSON.stringify(malformed), JSON.stringify(malformed))).toThrow();
      }
      insert.run(fixture.scope.tenantId, fixture.scope.principalId, fixture.threadId,
        '{"kind":"conversation"}', '{"kind":"conversation"}');
      expect(new QueuedInputRepository(fixture.database).get(fixture.scope, fixture.threadId, "conversation-target")).toMatchObject({
        requestedSteerTarget: { kind: "conversation" }, resolvedSteerTarget: { kind: "conversation" },
      });
    } finally { fixture.database.close(); }
  });
});
