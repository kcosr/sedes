import { describe, expect, it, vi } from "vitest";
import { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

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
  });
  const environmentAuthority = {
    id: "environment-authority-1",
    callerKind: "thread_agent" as const,
    defaults: {
      kind: "thread_agent" as const,
      environmentId: environment.id,
      workspaceId: workspaceA.id,
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
          },
          {
            id: current.workspaceA.id,
            label: "Same project",
            availability: "available",
            lastOpenedAt: new Date(1_000).toISOString(),
            environment: current.environment,
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
          .items.map(({ id }) => id),
      ).toEqual([
        current.remoteWorkspace.id,
        current.workspaceB.id,
        current.workspaceA.id,
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

describe("AgentManagementService task mutation", () => {
  it("binds task lists to query targets rather than the broader admitted universe", () => {
    const listPageWithEnvironmentAuthority = vi.fn(() => ({
      projection: "summary" as const,
      items: [],
    }));
    const management = new AgentManagementService({
      database: {} as never,
      inventory: {} as never,
      threadSummaries: {} as never,
      runtimes: {} as never,
      workspaces: {} as never,
      taskRepository: { listPageWithEnvironmentAuthority } as never,
      tasks: {} as never,
    });
    const authority = {
      id: "global-exact-grant",
      callerKind: "principal_client" as const,
      defaults: {
        kind: "principal_client" as const,
        environmentId: "environment-a",
      },
      policyIdentity: {
        ownerKind: "principal_client" as const,
        ownerId: "client-a",
        revision: 3,
        credentialGeneration: 1,
      },
      admittedEnvironmentIds: ["environment-a", "environment-b"],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "global-exact-input",
      authorityDigest: "global-exact-authority",
    };

    management.listTasks(scope, { kind: "global" }, authority, {
      scopeMode: "exact",
      projection: "summary",
      pageSize: 50,
    });

    expect(listPageWithEnvironmentAuthority).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        taskScope: { kind: "global" },
        scopeMode: "exact",
        targetEnvironmentIds: [],
      }),
    );
  });

  it("uses stable continuation authority across separately admitted task pages", () => {
    const listPageWithEnvironmentAuthority = vi.fn(
      (
        _requestScope: unknown,
        _input: {
          readonly continuationAuthorityDigest: string;
          readonly cursor?: string;
        },
      ) => ({
        projection: "summary" as const,
        items: [],
      }),
    );
    const management = new AgentManagementService({
      database: {} as never,
      inventory: {} as never,
      threadSummaries: {} as never,
      runtimes: {} as never,
      workspaces: {} as never,
      taskRepository: { listPageWithEnvironmentAuthority } as never,
      tasks: {} as never,
    });
    const authority = {
      id: "task-list-grant-1",
      callerKind: "thread_agent" as const,
      defaults: {
        kind: "thread_agent" as const,
        environmentId: "environment-a",
        workspaceId: "workspace-a",
        threadId: "thread-a",
      },
      policyIdentity: {
        ownerKind: "thread" as const,
        ownerId: "thread-a",
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-a"],
      targetEnvironmentIds: ["environment-a"],
      resolvedResourceRefs: [],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "task-list-input-1",
      authorityDigest: "task-list-authority-1",
    };
    const request = {
      scopeMode: "subtree" as const,
      projection: "summary" as const,
      pageSize: 1,
    };

    management.listTasks(scope, { kind: "global" }, authority, request);
    management.listTasks(
      scope,
      { kind: "global" },
      {
        ...authority,
        id: "task-list-grant-2",
        canonicalInputDigest: "task-list-cursor-input",
        authorityDigest: "task-list-cursor-authority",
      },
      { ...request, cursor: "cursor-1" },
    );

    const firstBinding = listPageWithEnvironmentAuthority.mock.calls[0]![1];
    const secondBinding = listPageWithEnvironmentAuthority.mock.calls[1]![1];
    expect(secondBinding.continuationAuthorityDigest).toBe(
      firstBinding.continuationAuthorityDigest,
    );
    expect(secondBinding.cursor).toBe("cursor-1");
  });

  it("rejects a task update when the task revision changed after authority resolution", async () => {
    const update = vi.fn();
    const management = new AgentManagementService({
      database: {} as never,
      inventory: {} as never,
      threadSummaries: {} as never,
      runtimes: {} as never,
      workspaces: {} as never,
      taskRepository: {
        resolveTaskEnvironmentAuthority: () => ({
          taskId: "task-1",
          revision: 5,
          scopeKind: "workspace",
          environmentId: "environment-a",
        }),
      } as never,
      tasks: { update } as never,
    });
    const staleAuthority = {
      id: "authority-1",
      callerKind: "thread_agent" as const,
      defaults: {
        kind: "thread_agent" as const,
        environmentId: "environment-a",
        workspaceId: "workspace-a",
        threadId: "thread-a",
      },
      policyIdentity: {
        ownerKind: "thread" as const,
        ownerId: "thread-a",
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-a"],
      targetEnvironmentIds: ["environment-a"],
      resolvedResourceRefs: [
        {
          kind: "task" as const,
          id: "task-1",
          environmentId: "environment-a",
          revision: 4,
        },
      ],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "input",
      authorityDigest: "authority",
    };

    expect(() =>
      management.updateTask(scope, "mutation-1", "task-1", staleAuthority, {
        expectedRevision: 5,
        title: "Raced update",
      }),
    ).toThrow(/unavailable/);
    expect(update).not.toHaveBeenCalled();
  });
});
