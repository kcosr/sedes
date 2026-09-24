import { UsageService } from "../../src/server/usage/usage-service.js";
import { randomUUID } from "node:crypto";
import type { Request as ExpressRequest } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { PrincipalApplicationPreferenceRepository } from "../../src/server/db/repositories/principal-application-preference-repository.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import { PrincipalApplicationPreferenceService } from "../../src/server/domain/principal-application-preference-service.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../../src/server/identity/identity-provider.js";
import type { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import type { ExecutionTargetReader } from "../../src/server/application/execution-target-reader.js";
import type { ConversationLifecycleService } from "../../src/server/conversations/conversation-lifecycle-service.js";
import type { ThreadApplicationService } from "../../src/server/conversations/thread-application-service.js";
import type { ThreadHistoryService } from "../../src/server/conversations/thread-history-service.js";
import type { InventoryService } from "../../src/server/domain/inventory-service.js";
import type { AutomationService } from "../../src/server/domain/automation-service.js";
import type { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import type { ThreadAttentionService } from "../../src/server/domain/thread-attention-service.js";
import type { AutomationPrecheckExecutor } from "../../src/server/runtime/automation-precheck-executor.js";
import type { ExecutionEnvironmentProvider } from "../../src/server/execution/contracts.js";
import type { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import type { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { TASK_DETAILS_MAX_CHARACTERS } from "../../src/shared/index.js";
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
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

const unusedRoute = () => {
  throw new Error("route_not_under_test");
};

function fixture() {
  const database = openOverlayDatabase(":memory:");
  const owner = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(owner);
  const workspace = legacy.rememberWorkspace(
    owner,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-http",
      displayName: "Tasks over HTTP",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const thread = legacy.createThread(
    owner,
    { workspaceId: workspace.id, title: "Task anchor" },
    200,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);

  const publishTaskChange = vi.fn<
    (scope: RequestScope, taskId: string) => Promise<void>
  >(async () => undefined);
  const tasks = new TaskService(new TaskRepository(database), {
    publishTaskChange,
  });
  const identity: IdentityProvider<ExpressRequest> = {
    resolve: async () => owner,
  };
  const config: AppConfig = {
    authenticationRequired: true,
    experimentalUsageEnabled: false,
    host: "127.0.0.1",
    port: 4783,
    stateDirectory: "/tmp/tasks-http-state",
    allowedTailscaleHosts: [],
    packagedClientOrigins: [],
    conversationRetentionMilliseconds: 600_000,
    conversationRuntimeBudget: 8,
  };
  const executionTargets: ExecutionTargetReader = {
    read: async () => ({ executionTargets: [], defaultTargetId: null }),
    requireSelectable: async () => undefined,
  };
  const app = createNormalizedApp({
    usage: new UsageService(database, {enabled: true}),
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config,
    csrfToken: "tasks-csrf",
    identity,
    agentTools: unavailableAgentToolRouterDependencies(),
    executionTargets,
    savedAgents: {
      list: unusedRoute,
      get: unusedRoute,
      createAgent: unusedRoute,
      updateAgent: unusedRoute,
      deleteAgent: unusedRoute,
      options: unusedRoute,
      resolveAgent: unusedRoute,
      createThread: unusedRoute,
    } as never,
    threadTemplates: {} as never,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: {
      publishAuthoritativeReplacement: unusedRoute,
    } as unknown as ApplicationSnapshotPublicationBoundary,
    notifications: {} as never,
    principalPreferences: new PrincipalApplicationPreferenceService({
      repository: new PrincipalApplicationPreferenceRepository(database),
    }),
    threads: { snapshot: unusedRoute } as unknown as ThreadApplicationService,
    history: { loadOlder: unusedRoute } as unknown as ThreadHistoryService,
    threadRuntimes: {
      quiet: unusedRoute,
    } as unknown as ThreadRuntimeCoordinator,
    threadSnapshots: {
      publish: unusedRoute,
    } as unknown as ThreadSnapshotPublisher,
    lifecycle: {
      createServerDraft: unusedRoute,
    } as unknown as ConversationLifecycleService,
    inventory: {} as unknown as InventoryService,
    threadGroups: {} as never,
    tasks,
    workspaceFiles: {
      list: unusedRoute,
      read: unusedRoute,
      status: unusedRoute,
    } as never,
    threadArchives: { impact: unusedRoute } as unknown as ThreadArchiveService,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets: {
      impact: unusedRoute,
      forceReset: unusedRoute,
    } as never,
    attention: { dismiss: unusedRoute } as unknown as ThreadAttentionService,
    execution: {
      validateWorkspace: unusedRoute,
    } as unknown as ExecutionEnvironmentProvider,
    automations: { preview: unusedRoute } as unknown as AutomationService,
    automationPrechecks: {
      test: unusedRoute,
    } as unknown as AutomationPrecheckExecutor,
    lineage: {
      forkManual: unusedRoute,
      updatePlacement: unusedRoute,
      listDescendants: unusedRoute,
    },
  });
  const withHost = (test: request.Test) => test.set("Host", "127.0.0.1:4783");
  const mutate = (test: request.Test) =>
    withHost(test).set("X-CSRF-Token", "tasks-csrf");
  return {
    app,
    owner,
    workspaceId: workspace.id,
    threadId: thread.thread.id,
    publishTaskChange,
    withHost,
    mutate,
    close() {
      database.close();
    },
  };
}

describe("tasks HTTP contract", () => {
  it("rejects ill-formed UTF-16 task content as invalid input", async () => {
    const current = fixture();
    try {
      for (const body of [
        { title: "bad\ud800title" },
        { title: "Valid", details: "bad\udc00details" },
        { title: "Valid", files: ["/tmp/bad\ud800.txt"] },
      ]) {
        await current
          .mutate(request(current.app).post("/api/tasks"))
          .send({
            mutationId: randomUUID(),
            scope: { kind: "global" },
            ...body,
          })
          .expect(400);
      }
    } finally {
      current.close();
    }
  });

  it("creates task content, pin state, and file metadata atomically", async () => {
    const current = fixture();
    try {
      await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "Complete initial task",
          details: "No follow-up patch required",
          pinned: true,
          files: ["/tmp/spec.md"],
          scope: { kind: "global" },
        })
        .expect(201)
        .expect(({ body }) => {
          expect(body.task).toMatchObject({
            title: "Complete initial task",
            details: "No follow-up patch required",
            pinned: true,
            files: ["/tmp/spec.md"],
            completedAt: null,
            revision: 0,
          });
        });
    } finally {
      current.close();
    }
  });

  it("accepts a maximum-size escaped task document and rejects one character more", async () => {
    const current = fixture();
    try {
      const created = await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "Large document",
          scope: { kind: "global" },
        })
        .expect(201);
      const taskId = created.body.task.id as string;
      const details = "\u0001".repeat(TASK_DETAILS_MAX_CHARACTERS);

      await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 0,
          details,
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body.task.details).toBe(details);
        });

      await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 1,
          details: "x".repeat(TASK_DETAILS_MAX_CHARACTERS + 1),
        })
        .expect(400)
        .expect(({ body }) => {
          expect(body.error.code).toBe("bad_request");
        });
    } finally {
      current.close();
    }
  });

  it("creates, updates, moves, and deletes a task, publishing each committed mutation", async () => {
    const current = fixture();
    try {
      const created = await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "Review the release notes",
          scope: { kind: "thread", threadId: current.threadId },
        })
        .expect(201);
      expect(created.body.task).toMatchObject({
        id: expect.any(String),
        scope: { kind: "thread", threadId: current.threadId },
        title: "Review the release notes",
        details: "",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const taskId = created.body.task.id as string;

      const updated = await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 0,
          title: "Review and publish the release notes",
          details: "Include the migration section",
          completed: true,
          pinned: true,
          files: ["/does/not/need/to/exist.md", "/tmp/release.zip"],
          scope: { kind: "workspace", workspaceId: current.workspaceId },
        })
        .expect(200);
      expect(updated.body.task).toMatchObject({
        id: taskId,
        title: "Review and publish the release notes",
        details: "Include the migration section",
        pinned: true,
        files: ["/does/not/need/to/exist.md", "/tmp/release.zip"],
        scope: { kind: "workspace", workspaceId: current.workspaceId },
        completedAt: expect.any(String),
        revision: 1,
      });

      const moved = await current
        .mutate(request(current.app).post(`/api/tasks/${taskId}/move`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 1,
          scope: { kind: "global" },
        })
        .expect(200);
      expect(moved.body.task).toMatchObject({
        id: taskId,
        scope: { kind: "global" },
        revision: 2,
      });

      await current
        .mutate(request(current.app).delete(`/api/tasks/${taskId}`))
        .expect(204);
      await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 2,
          completed: false,
        })
        .expect(404);

      expect(
        current.publishTaskChange.mock.calls.map(
          ([, publishedTaskId]) => publishedTaskId,
        ),
      ).toEqual([taskId, taskId, taskId, taskId]);
      expect(current.publishTaskChange).toHaveBeenCalledWith(
        current.owner,
        taskId,
      );
    } finally {
      current.close();
    }
  });

  it("maps stale revisions, unknown tasks, and invalid bodies to contract errors", async () => {
    const current = fixture();
    try {
      const created = await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "Conflict target",
          scope: { kind: "global" },
        })
        .expect(201);
      const taskId = created.body.task.id as string;
      current.publishTaskChange.mockClear();

      await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 5,
          completed: true,
        })
        .expect(409)
        .expect(({ body }) => {
          expect(body.error).toMatchObject({
            code: "task_revision_conflict",
            retryable: false,
          });
        });

      await current
        .mutate(request(current.app).patch(`/api/tasks/${randomUUID()}`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 0,
          completed: true,
        })
        .expect(404)
        .expect(({ body }) => {
          expect(body.error.code).toBe("not_found");
        });

      await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "",
          scope: { kind: "global" },
        })
        .expect(400)
        .expect(({ body }) => {
          expect(body.error.code).toBe("bad_request");
        });
      await current
        .mutate(request(current.app).post("/api/tasks"))
        .send({
          mutationId: randomUUID(),
          title: "Unknown scope kind",
          scope: { kind: "galaxy" },
        })
        .expect(400);
      await current
        .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
        .send({ mutationId: randomUUID(), expectedRevision: 0 })
        .expect(400)
        .expect(({ body }) => {
          expect(body.error.code).toBe("bad_request");
        });
      for (const files of [
        ["relative.md"],
        ["/duplicate", "/duplicate"],
        ["/contains\0nul"],
      ]) {
        await current
          .mutate(request(current.app).patch(`/api/tasks/${taskId}`))
          .send({
            mutationId: randomUUID(),
            expectedRevision: 0,
            files,
          })
          .expect(400)
          .expect(({ body }) => {
            expect(body.error.code).toBe("bad_request");
          });
      }
      await current
        .mutate(request(current.app).post(`/api/tasks/${taskId}/move`))
        .send({
          mutationId: randomUUID(),
          expectedRevision: 0,
          scope: { kind: "workspace" },
        })
        .expect(400);

      expect(current.publishTaskChange).not.toHaveBeenCalled();
      await current
        .withHost(request(current.app).get("/api/tasks"))
        .expect(404);
    } finally {
      current.close();
    }
  });
});
