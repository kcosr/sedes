import { describe, expect, it, vi } from "vitest";
import { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { randomUUID } from "node:crypto";
import type { TaskScope } from "../../src/shared/protocol/tasks.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
} from "../../src/server/agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

function service() {
  return {
    management: new AgentManagementService({
      database: {} as never,
      inventory: {
        getThread: () => ({
          thread: { connectionProfileId: "source-target" },
        }),
        getWorkspace: () => ({}),
      } as never,
      threadSummaries: {} as never,
      runtimes: {} as never,
      workspaces: {} as never,
      taskRepository: {} as never,
      tasks: {} as never,
      authorityReader: {} as never,
    }),
  };
}

function discoveryFixture() {
  const current = savedAgentDatabase();
  const inventory = new InventoryRepository(current.database);
  const environment = current.database
    .prepare(
      `SELECT id, label FROM execution_environments
       WHERE tenant_id = ? AND owner_principal_id = ?`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as {
    id: string;
    label: string;
  };
  const profile = current.database
    .prepare(
      `SELECT id FROM agent_connection_profiles
       WHERE tenant_id = ? AND owner_principal_id = ?`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const workspaceA = inventory.upsertWorkspace(current.scope, {
    id: "10000000-0000-4000-8000-000000000001",
    environmentId: environment.id,
    canonicalPath: "/tmp/discovery-a",
    displayName: "Same project",
    project: { kind: "new", name: "Same project" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: 0,
    now: 1_000,
  });
  const workspaceB = inventory.upsertWorkspace(current.scope, {
    id: "10000000-0000-4000-8000-000000000002",
    environmentId: environment.id,
    canonicalPath: "/tmp/discovery-b",
    displayName: "Other project",
    project: { kind: "new", name: "Other project" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: 0,
    now: 2_000,
  });
  const remoteEnvironmentId = "30000000-0000-4000-8000-000000000001";
  current.database
    .prepare(
      `INSERT INTO execution_environments(
         tenant_id, owner_principal_id, id, kind, label, availability,
         diagnostic_code, revision, configuration_revision,
         configuration_fingerprint, created_at, updated_at
       )
       SELECT tenant_id, owner_principal_id, ?, 'ssh', 'Remote', availability,
         diagnostic_code, revision, configuration_revision,
         configuration_fingerprint, created_at, updated_at
       FROM execution_environments
       WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
    )
    .run(
      remoteEnvironmentId,
      current.scope.tenantId,
      current.scope.principalId,
      environment.id,
    );
  const remoteWorkspace = inventory.upsertWorkspace(current.scope, {
    id: "10000000-0000-4000-8000-000000000003",
    environmentId: remoteEnvironmentId,
    canonicalPath: "/tmp/discovery-remote",
    displayName: "Remote project",
    // The same project on another environment.
    project: { kind: "existing", projectId: workspaceA.projectId },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: 0,
    now: 2_500,
  });
  const bindings = new ConversationBindingRepository(current.database);
  const older = bindings.createUnboundThread(current.scope, {
    id: "20000000-0000-4000-8000-000000000001",
    workspaceId: workspaceA.id,
    connectionProfileId: profile.id,
    title: "USER DOCS",
    now: 3_000,
  });
  const newer = bindings.createUnboundThread(current.scope, {
    id: "20000000-0000-4000-8000-000000000002",
    workspaceId: workspaceB.id,
    connectionProfileId: profile.id,
    title: "User docs follow-up",
    now: 4_000,
  });
  const tiedFirst = bindings.createUnboundThread(current.scope, {
    id: "20000000-0000-4000-8000-000000000003",
    workspaceId: workspaceA.id,
    connectionProfileId: profile.id,
    title: "Tie first",
    now: 5_000,
  });
  const tiedSecond = bindings.createUnboundThread(current.scope, {
    id: "20000000-0000-4000-8000-000000000004",
    workspaceId: workspaceA.id,
    connectionProfileId: profile.id,
    title: "Tie second",
    now: 5_000,
  });
  const summaries = new Map([
    [
      older.id,
      {
        id: older.id,
        workspaceId: workspaceA.id,
        title: { text: "USER DOCS" },
      },
    ],
    [
      newer.id,
      {
        id: newer.id,
        workspaceId: workspaceB.id,
        title: { text: "User docs follow-up" },
      },
    ],
    [
      tiedFirst.id,
      {
        id: tiedFirst.id,
        workspaceId: workspaceA.id,
        title: { text: "Tie first" },
      },
    ],
    [
      tiedSecond.id,
      {
        id: tiedSecond.id,
        workspaceId: workspaceA.id,
        title: { text: "Tie second" },
      },
    ],
  ]);
  const management = new AgentManagementService({
    database: current.database,
    inventory,
    threadSummaries: {
      listByIds: (_scope: unknown, ids: readonly string[]) =>
        ids.map((id) => {
          const state = current.database
            .prepare(
              `SELECT inventory_state AS inventoryState
               FROM thread_principal_state
               WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
            )
            .get(current.scope.tenantId, current.scope.principalId, id) as {
            inventoryState: "active" | "snoozed" | "settled" | "archived";
          };
          return {
            ...summaries.get(id)!,
            backingState: "unbound",
            available: true,
            inventoryState: state.inventoryState,
            automation: null,
          };
        }),
    } as never,
    runtimes: { captureLoadedState: async () => undefined },
    workspaces: {} as never,
    taskRepository: {} as never,
    tasks: {} as never,
    authorityReader: {} as never,
  });
  const environmentAuthority = {
    id: "environment-authority-1",
    callerKind: "thread_agent" as const,
    defaults: {
      kind: "thread_agent" as const,
      environmentId: environment.id,
      workspaceId: workspaceA.id,
      projectId: "project-1",
      threadId: "source-thread",
    },
    policyIdentity: {
      ownerKind: "thread" as const,
      ownerId: "source-thread",
      revision: 1,
    },
    admittedEnvironmentIds: [environment.id],
    targetEnvironmentIds: [environment.id],
    resolvedResourceRefs: [
      {
        kind: "workspace" as const,
        id: workspaceA.id,
        environmentId: environment.id,
      },
      {
        kind: "workspace" as const,
        id: workspaceB.id,
        environmentId: environment.id,
      },
    ],
    display: { targetEnvironmentLabels: [], resourceLabels: [] },
    canonicalInputDigest: "input-digest",
    authorityDigest: "authority-digest",
  };
  return {
    ...current,
    management,
    environment,
    workspaceA,
    workspaceB,
    remoteEnvironmentId,
    remoteWorkspace,
    older,
    newer,
    tiedFirst,
    tiedSecond,
    environmentAuthority,
  };
}

describe("AgentManagementService discovery", () => {
  it("lists workspaces with recency and bounded environment identity", () => {
    const current = discoveryFixture();
    try {
      expect(
        current.database
          .prepare(
            `SELECT name FROM pragma_index_list('workspaces')
             WHERE name = 'workspaces_principal_last_opened'`,
          )
          .get(),
      ).toEqual({ name: "workspaces_principal_last_opened" });
      expect(
        current.management.listWorkspaces(
          current.scope,
          {
            scope: { kind: "default_environment" },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).toEqual({
        items: [
          {
            id: current.workspaceB.id,
            label: "Other project",
            availability: "available",
            lastOpenedAt: new Date(2_000).toISOString(),
            environment: current.environment,
            project: { id: current.workspaceB.projectId, name: "Other project" },
          },
          {
            id: current.workspaceA.id,
            label: "Same project",
            availability: "available",
            lastOpenedAt: new Date(1_000).toISOString(),
            environment: current.environment,
            project: { id: current.workspaceA.projectId, name: "Same project" },
          },
        ],
      });
      const firstPage = current.management.listWorkspaces(
        current.scope,
        {
          scope: { kind: "default_environment" },
          pageSize: 1,
        },
        current.environmentAuthority,
      );
      expect(firstPage).toEqual({
        items: [expect.objectContaining({ id: current.workspaceB.id })],
        nextCursor: expect.any(String),
      });
      expect(
        current.management.listWorkspaces(
          current.scope,
          {
            scope: { kind: "default_environment" },
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          {
            ...current.environmentAuthority,
            id: "workspace-continuation-grant",
            canonicalInputDigest: "workspace-cursor-input-digest",
            authorityDigest: "workspace-cursor-authority-digest",
          },
        ),
      ).toEqual({
        items: [expect.objectContaining({ id: current.workspaceA.id })],
      });
      expect(() =>
        current.management.listWorkspaces(
          current.scope,
          {
            scope: { kind: "default_environment" },
            pageSize: 2,
            cursor: firstPage.nextCursor,
          },
          current.environmentAuthority,
        ),
      ).toThrow("The management-list cursor is invalid.");
      expect(() =>
        current.management.listWorkspaces(
          {
            tenantId: current.scope.tenantId,
            principalId: "foreign-principal",
          },
          {
            scope: { kind: "default_environment" },
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          current.environmentAuthority,
        ),
      ).toThrow("The management-list cursor is invalid.");
      expect(() =>
        current.management.listWorkspaces(
          current.scope,
          {
            scope: {
              kind: "environment",
              environmentId: current.remoteEnvironmentId,
            },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).toThrow("The requested resource is unavailable.");
      const allEnvironmentAuthority = {
        ...current.environmentAuthority,
        admittedEnvironmentIds: [
          current.environment.id,
          current.remoteEnvironmentId,
        ].sort(),
        targetEnvironmentIds: [
          current.environment.id,
          current.remoteEnvironmentId,
        ].sort(),
        authorityDigest: "all-environments-digest",
      };
      expect(
        current.management
          .listWorkspaces(
            current.scope,
            { scope: { kind: "all_allowed_environments" }, pageSize: 10 },
            allEnvironmentAuthority,
          )
          .items.map(({ id, project }) => [id, project]),
      ).toEqual([
        [current.remoteWorkspace.id, { id: current.workspaceA.projectId, name: "Same project" }],
        [current.workspaceB.id, { id: current.workspaceB.projectId, name: "Other project" }],
        [current.workspaceA.id, { id: current.workspaceA.projectId, name: "Same project" }],
      ]);
      expect(() =>
        current.management.listWorkspaces(
          current.scope,
          {
            scope: { kind: "default_environment" },
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          {
            ...current.environmentAuthority,
            policyIdentity: {
              ...current.environmentAuthority.policyIdentity,
              revision: 2,
            },
          },
        ),
      ).toThrow("The management-list cursor is invalid.");
    } finally {
      current.database.close();
    }
  });

  it("searches all principal workspaces by default in fixed activity order", async () => {
    const current = discoveryFixture();
    try {
      expect(
        current.database
          .prepare(
            `SELECT name FROM pragma_index_list('application_threads')
             WHERE name = 'application_threads_principal_activity'`,
          )
          .get(),
      ).toEqual({ name: "application_threads_principal_activity" });
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          { query: "user docs", pageSize: 10 },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            id: current.newer.id,
            lastActivityAt: new Date(4_000).toISOString(),
            workspace: { id: current.workspaceB.id, label: "Other project" },
            environment: current.environment,
          }),
          expect.objectContaining({
            id: current.older.id,
            lastActivityAt: new Date(3_000).toISOString(),
            workspace: { id: current.workspaceA.id, label: "Same project" },
            environment: current.environment,
          }),
        ],
      });
      const firstPage = await current.management.listThreads(
        current.scope,
        undefined,
        { query: "user docs", pageSize: 1 },
        current.environmentAuthority,
      );
      expect(firstPage).toEqual({
        items: [expect.objectContaining({ id: current.newer.id })],
        nextCursor: expect.any(String),
      });
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            query: "user docs",
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          {
            ...current.environmentAuthority,
            id: "thread-continuation-grant",
            canonicalInputDigest: "thread-cursor-input-digest",
            authorityDigest: "thread-cursor-authority-digest",
          },
        ),
      ).resolves.toEqual({
        items: [expect.objectContaining({ id: current.older.id })],
      });
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            query: "different query",
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          current.environmentAuthority,
        ),
      ).rejects.toMatchObject({ code: "cursor_invalid" });
    } finally {
      current.database.close();
    }
  });

  it("honors source-workspace and last-activity filters", async () => {
    const current = discoveryFixture();
    try {
      await expect(
        current.management.listThreads(
          current.scope,
          current.workspaceA.id,
          {
            scope: { kind: "default_workspace" },
            query: "USER DOCS",
            lastActivityAfter: new Date(2_500).toISOString(),
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({
        items: [expect.objectContaining({ id: current.older.id })],
      });
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            scope: { kind: "default_workspace" },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).rejects.toThrow("agent_source_workspace_unavailable");
      await expect(
        current.management.listThreads(
          current.scope,
          current.workspaceA.id,
          {
            scope: { kind: "workspace", workspaceId: "missing-workspace" },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      current.database.close();
    }
  });

  it("uses scalar scope identity and stable id ties across thread pages", async () => {
    const current = discoveryFixture();
    try {
      const firstPage = await current.management.listThreads(
        current.scope,
        undefined,
        {
          scope: { kind: "workspace", workspaceId: current.workspaceA.id },
          query: "tie",
          pageSize: 1,
        },
        current.environmentAuthority,
      );
      expect(firstPage).toEqual({
        items: [expect.objectContaining({ id: current.tiedFirst.id })],
        nextCursor: expect.any(String),
      });
      const reorderedScope = {
        workspaceId: current.workspaceA.id,
        kind: "workspace" as const,
      };
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            scope: reorderedScope,
            query: "tie",
            pageSize: 1,
            cursor: firstPage.nextCursor,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({
        items: [expect.objectContaining({ id: current.tiedSecond.id })],
      });
    } finally {
      current.database.close();
    }
  });

  it("filters lifecycle and treats lastActivityAfter as a strict boundary", async () => {
    const current = discoveryFixture();
    try {
      current.database
        .prepare(
          `UPDATE thread_principal_state
           SET inventory_state = 'settled'
           WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.older.id,
        );
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            lifecycle: "settled",
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            id: current.older.id,
            lifecycle: "settled",
          }),
        ],
      });
      await expect(
        current.management.listThreads(
          current.scope,
          undefined,
          {
            query: "User docs follow-up",
            lastActivityAfter: new Date(4_000).toISOString(),
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({ items: [] });
    } finally {
      current.database.close();
    }
  });

  it("keeps principal and tenant scope non-enumerating", async () => {
    const current = discoveryFixture();
    try {
      const foreignPrincipal = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      const foreignTenant = {
        tenantId: "foreign-tenant",
        principalId: current.scope.principalId,
      };
      await expect(
        current.management.listThreads(
          foreignPrincipal,
          undefined,
          {
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({ items: [] });
      await expect(
        current.management.listThreads(
          foreignTenant,
          undefined,
          {
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).resolves.toEqual({ items: [] });
      await expect(
        current.management.listThreads(
          foreignPrincipal,
          undefined,
          {
            scope: { kind: "workspace", workspaceId: current.workspaceA.id },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        current.management.listWorkspaces(
          foreignPrincipal,
          {
            scope: { kind: "default_environment" },
            pageSize: 10,
          },
          current.environmentAuthority,
        ),
      ).toEqual({ items: [] });
    } finally {
      current.database.close();
    }
  });
});

describe("AgentManagementService task authority", () => {
  function taskFixture() {
    const current = discoveryFixture();
    const reader = new DatabaseAgentToolSourceAuthority(
      current.database,
      new Uint8Array(32).fill(9),
    );
    const taskRepository = new TaskRepository(current.database);
    const management = new AgentManagementService({
      database: current.database,
      inventory: new InventoryRepository(current.database),
      threadSummaries: {} as never,
      runtimes: {} as never,
      workspaces: {} as never,
      taskRepository,
      tasks: new TaskService(taskRepository, {
        publishTaskChange: async () => undefined,
      }),
      authorityReader: reader,
    });
    const defaults = {
      kind: "thread_agent" as const,
      environmentId: current.environment.id,
      workspaceId: current.workspaceA.id,
      projectId: current.workspaceA.projectId,
      threadId: current.older.id,
    };
    /** Resolves like admission and assumes any needed approval was granted. */
    const admit = (toolId: string, input: unknown) => {
      const tool = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.find(
        (entry) => entry.id === toolId,
      )!;
      const resolved = new AgentToolEnvironmentAuthorityResolver(
        reader,
      ).resolve({ tool, input, scope: current.scope, defaults });
      return createTrustedEnvironmentAuthorityGrant({
        ...resolved,
        tool,
        callerKind: "thread_agent",
        defaults,
        policyIdentity: {
          ownerKind: "thread",
          ownerId: current.older.id,
          revision: 1,
        },
        admittedEnvironmentIds: [
          current.environment.id,
          ...resolved.targetEnvironmentIds,
        ],
      });
    };
    let clock = 6_000;
    const create = (title: string, taskScope: TaskScope) =>
      taskRepository.create(current.scope, {
        title,
        scope: taskScope,
        mutationId: randomUUID(),
        now: (clock += 10),
      });
    const list = (
      grant: ReturnType<typeof admit>,
      taskScope: TaskScope,
      scopeMode: "exact" | "subtree",
      cursor?: string,
      pageSize = 50,
    ) =>
      management.listTasks(current.scope, taskScope, grant, {
        scopeMode,
        projection: "summary",
        pageSize,
        ...(cursor ? { cursor } : {}),
      });
    return { ...current, reader, taskRepository, management, admit, create, list };
  }

  it("lists a project across its locations only with exactly the admitted environments", () => {
    const f = taskFixture();
    try {
      const project = { kind: "project" as const, projectId: f.workspaceA.projectId };
      const shared = f.create("Shared", project);
      const threadTask = f.create("On a thread", { kind: "thread", threadId: f.older.id });
      f.create("Elsewhere", { kind: "project", projectId: f.workspaceB.projectId });
      const exact = f.admit("task.list", { scope: { kind: "project" }, scopeMode: "exact" });
      // The caller's environment is a member, so it is inside the project.
      expect(exact.targetEnvironmentIds).toEqual([f.environment.id]);
      expect(f.list(exact, project, "exact").items.map(({ id }) => id)).toEqual([shared.id]);
      expect(f.list(exact, project, "exact").items[0]).toMatchObject({
        scope: project,
        associatedProjectId: f.workspaceA.projectId,
      });
      // A subtree spans every member environment, so an exact grant cannot serve it.
      expect(() => f.list(exact, project, "subtree")).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      const subtree = f.admit("task.list", { scope: { kind: "project" }, scopeMode: "subtree" });
      expect(subtree.targetEnvironmentIds).toEqual(
        [f.environment.id, f.remoteEnvironmentId].sort(),
      );
      expect(
        f.list(subtree, project, "subtree").items.map(({ id }) => id).sort(),
      ).toEqual([shared.id, threadTask.id].sort());
      expect(() =>
        f.list(exact, { kind: "project", projectId: f.workspaceB.projectId }, "exact"),
      ).toThrow(/unavailable/);
    } finally {
      f.database.close();
    }
  });

  it("rechecks a project task against its project's current membership", () => {
    const f = taskFixture();
    try {
      const task = f.create("Shared", { kind: "project", projectId: f.workspaceA.projectId });
      const grant = f.admit("task.get", { taskId: task.id });
      expect(f.management.getTask(f.scope, task.id, grant)).toMatchObject({
        id: task.id,
        scope: { kind: "project", projectId: f.workspaceA.projectId },
      });
      const inventory = new InventoryRepository(f.database);
      inventory.upsertWorkspace(f.scope, {
        environmentId: f.environment.id,
        canonicalPath: "/tmp/discovery-a-copy",
        displayName: "Same project copy",
        project: { kind: "existing", projectId: f.workspaceA.projectId },
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: 0,
        now: 7_000,
      });
      expect(() => f.management.getTask(f.scope, task.id, grant)).toThrow(/unavailable/);
      expect(f.management.getTask(f.scope, task.id, f.admit("task.get", { taskId: task.id })).id).toBe(task.id);
    } finally {
      f.database.close();
    }
  });

  it("authorizes project destinations for creation and moves", async () => {
    const f = taskFixture();
    try {
      const inventory = new InventoryRepository(f.database);
      const remoteOnly = inventory.upsertWorkspace(f.scope, {
        environmentId: f.remoteEnvironmentId,
        canonicalPath: "/tmp/remote-only",
        displayName: "Remote only",
        project: { kind: "new", name: "Remote only" },
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: 0,
        now: 7_000,
      });
      const destination = { kind: "project" as const, projectId: remoteOnly.projectId };
      const local = f.admit("task.create", { title: "Local", scope: { kind: "project" } });
      // A destination the grant did not resolve is denied, even without environments of its own.
      expect(() =>
        f.management.createTask(f.scope, randomUUID(), local, {
          title: "Smuggled",
          taskScope: destination,
        }),
      ).toThrow(/unavailable/);
      const remote = f.admit("task.create", { title: "Remote", scope: destination });
      expect(remote.targetEnvironmentIds).toEqual([f.remoteEnvironmentId]);
      const created = await f.management.createTask(f.scope, randomUUID(), remote, {
        title: "Remote",
        taskScope: destination,
      });
      expect(created.scope).toEqual(destination);

      const movable = f.create("Movable", { kind: "global" });
      const update = f.admit("task.update", {
        taskId: movable.id,
        expectedRevision: 0,
        scope: { kind: "project" },
      });
      await expect(
        Promise.resolve().then(() =>
          f.management.updateTask(f.scope, randomUUID(), movable.id, update, {
            expectedRevision: 0,
            scope: destination,
          }),
        ),
      ).rejects.toThrow(/unavailable/);
      const moved = await f.management.updateTask(f.scope, randomUUID(), movable.id, update, {
        expectedRevision: 0,
        scope: { kind: "project", projectId: f.workspaceA.projectId },
      });
      expect(moved).toMatchObject({ scope: { kind: "project", projectId: f.workspaceA.projectId }, revision: 1 });
      // The admitted revision is stale now.
      expect(() =>
        f.management.updateTask(f.scope, randomUUID(), movable.id, update, {
          expectedRevision: 1,
          title: "Raced",
        }),
      ).toThrow(/unavailable/);
    } finally {
      f.database.close();
    }
  });

  it("uses stable continuation authority across separately admitted task pages", () => {
    const f = taskFixture();
    try {
      const first = f.create("First", { kind: "global" });
      const second = f.create("Second", { kind: "global" });
      const global = { kind: "global" as const };
      const page = f.list(
        f.admit("task.list", { scope: global, scopeMode: "exact", pageSize: 1 }),
        global,
        "exact",
        undefined,
        1,
      );
      expect(page.items.map(({ id }) => id)).toEqual([first.id]);
      const next = f.list(
        f.admit("task.list", {
          scope: global,
          scopeMode: "exact",
          pageSize: 1,
          cursor: page.nextCursor,
        }),
        global,
        "exact",
        page.nextCursor,
        1,
      );
      expect(next.items.map(({ id }) => id)).toEqual([second.id]);
      expect(() =>
        f.list(
          f.admit("task.list", { scope: { kind: "project" }, scopeMode: "exact" }),
          global,
          "exact",
        ),
      ).toThrow(/unavailable|not_found|target/);
    } finally {
      f.database.close();
    }
  });
});
