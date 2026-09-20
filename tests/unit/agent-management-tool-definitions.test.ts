import { describe, expect, it, vi } from "vitest";
import type { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import type {
  AgentToolDefinition,
  TrustedToolInvocationContext,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import {
  createTaskCreateToolDefinition,
  createTaskGetToolDefinition,
  createTaskListToolDefinition,
  createTaskUpdateToolDefinition,
} from "../../src/server/agent-tools/tools/task-management-tools.js";
import {
  createThreadCreateToolDefinition,
  createThreadListToolDefinition,
} from "../../src/server/agent-tools/tools/thread-management-tools.js";
import { createEnvironmentListToolDefinition } from "../../src/server/agent-tools/tools/environment-list-tool.js";
import { createWorkspaceListToolDefinition } from "../../src/server/agent-tools/tools/workspace-list-tool.js";
import { createWorkspaceOpenToolDefinition } from "../../src/server/agent-tools/tools/workspace-open-tool.js";

describe("agent management tool definitions", () => {
  const service = {} as AgentManagementService;
  const definitions: AgentToolDefinition[] = [
    createEnvironmentListToolDefinition(service),
    createWorkspaceListToolDefinition(service),
    createWorkspaceOpenToolDefinition(service),
    createThreadListToolDefinition(service),
    createThreadCreateToolDefinition({ createThread: vi.fn() }),
    createTaskListToolDefinition(service),
    createTaskGetToolDefinition(service),
    createTaskCreateToolDefinition(service),
    createTaskUpdateToolDefinition(service),
  ];

  it("registers closed bounded versioned contracts with truthful grouping and effects", () => {
    const registry = new AgentToolRegistry();
    for (const definition of definitions) registry.register(definition);
    expect(registry.list().map(({ id }) => id)).toEqual([
      "environment.list",
      "workspace.list",
      "workspace.open",
      "thread.list",
      "thread.create",
      "task.list",
      "task.get",
      "task.create",
      "task.update",
    ]);
    expect(
      definitions
        .filter(({ effects }) => effects.application === "write")
        .map(({ id }) => id),
    ).toEqual([
      "workspace.open",
      "thread.create",
      "task.create",
      "task.update",
    ]);
    expect(registry.get("workspace.list", 4).schemaVersion).toBe(4);
    expect(registry.get("thread.list", 5).schemaVersion).toBe(5);
    expect(registry.get("thread.create", 5).schemaVersion).toBe(5);
    expect(() => registry.get("thread.create", 4)).toThrow();
    expect(registry.get("task.list", 3).schemaVersion).toBe(3);
  });

  it("enforces paging and task bounds identically through canonical schemas", () => {
    const registry = new AgentToolRegistry();
    for (const definition of definitions) registry.register(definition);
    expect(
      registry.validatesInput("workspace.list", 4, { pageSize: 100 }),
    ).toBe(true);
    expect(
      registry.validatesInput("workspace.list", 4, { pageSize: 101 }),
    ).toBe(false);
    expect(
      registry.validatesInput("workspace.list", 4, {
        scope: { kind: "environment", environmentId: "environment-a" },
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("workspace.list", 4, {
        scope: { kind: "environment" },
      }),
    ).toBe(false);
    expect(registry.validatesInput("environment.list", 1, {})).toBe(true);
    expect(
      registry.validatesInput("thread.list", 5, {
        scope: { kind: "all_allowed_environments" },
        query: "user docs",
        lifecycle: "active",
        lastActivityAfter: "2026-08-09T00:00:00.000Z",
        hasAutomation: false,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.list", 5, {
        scope: { kind: "workspace" },
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.list", 5, { titleFilter: "obsolete" }),
    ).toBe(false);
    expect(
      registry.validatesInput("environment.list", 1, { environmentId: "x" }),
    ).toBe(false);
    expect(
      registry.validatesInput("workspace.open", 1, {
        environmentId: "environment-a",
        path: "/srv/projects/sedes",
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("workspace.open", 1, {
        environmentId: "environment-a",
        path: "x".repeat(4_097),
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("task.create", 1, {
        title: "Bounded task",
        scope: { kind: "global" },
        files: ["/tmp/design.md"],
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("task.update", 1, {
        taskId: "task-1",
        expectedRevision: -1,
        completed: true,
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("task.list", 3, {
        scope: { kind: "workspace" },
        scopeMode: "subtree",
        completed: false,
        pinned: true,
        query: "release",
        projection: "full",
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("task.list", 3, {
        scope: { kind: "global" },
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("task.update", 1, {
        taskId: "task-1",
        expectedRevision: 0,
      }),
    ).toBe(false);
  });

  it("passes server-derived scope and cancellation to environment and workspace management", async () => {
    const listEnvironments = vi.fn(() => [
      {
        id: "environment-a",
        label: "Rocky 8",
        availability: "available" as const,
      },
    ]);
    const openWorkspaceForAgent = vi.fn(async () => ({
      workspaceId: "workspace-a",
      environmentId: "environment-a",
      label: "sedes",
      availability: "available" as const,
    }));
    const listWorkspaces = vi.fn(() => ({ items: [] }));
    const scoped = {
      listEnvironments,
      listWorkspaces,
      openWorkspaceForAgent,
    } as unknown as AgentManagementService;
    const context = invocationContext();

    await expect(
      createEnvironmentListToolDefinition(scoped).execute({}, context),
    ).resolves.toEqual({
      items: [
        { id: "environment-a", label: "Rocky 8", availability: "available" },
      ],
    });
    await expect(
      createWorkspaceOpenToolDefinition(scoped).execute(
        { environmentId: "environment-a", path: "/srv/projects/sedes" },
        context,
      ),
    ).resolves.toMatchObject({ workspaceId: "workspace-a" });
    await expect(
      createWorkspaceListToolDefinition(scoped).execute({}, context),
    ).resolves.toEqual({ items: [] });
    const expectedScope = {
      tenantId: context.tenantId,
      principalId: context.principalId,
    };
    expect(listEnvironments).toHaveBeenCalledWith(expectedScope);
    expect(openWorkspaceForAgent).toHaveBeenCalledWith(
      expectedScope,
      { environmentId: "environment-a", path: "/srv/projects/sedes" },
      context.environmentAuthority,
      context.abortSignal,
    );
    expect(listWorkspaces).toHaveBeenCalledWith(
      expectedScope,
      { scope: { kind: "default_environment" }, pageSize: 50 },
      context.environmentAuthority,
    );
  });

  it("passes validated task updates and preserves stale revision conflicts", async () => {
    const updatedTask = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Updated",
      details: "",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 4,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:01:00.000Z",
    };
    const updateTask = vi
      .fn()
      .mockResolvedValueOnce(updatedTask)
      .mockRejectedValueOnce(
        new DomainError("task_revision_conflict", "Task changed."),
      );
    const definition = createTaskUpdateToolDefinition({
      updateTask,
    } as unknown as AgentManagementService);
    const context = invocationContext();
    await expect(
      definition.execute(
        {
          taskId: updatedTask.id,
          expectedRevision: 3,
          title: "Updated",
        },
        context,
      ),
    ).resolves.toEqual(updatedTask);
    expect(updateTask).toHaveBeenCalledWith(
      { tenantId: context.tenantId, principalId: context.principalId },
      context.mutationId,
      updatedTask.id,
      context.environmentAuthority,
      expect.objectContaining({ expectedRevision: 3, title: "Updated" }),
    );
    await expect(
      definition.execute(
        {
          taskId: updatedTask.id,
          expectedRevision: 3,
          completed: true,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "task_revision_conflict" });
  });

  it("uses trusted task target defaults and the authoritative path validator", async () => {
    const listTasks = vi.fn().mockReturnValue({
      projection: "summary",
      items: [],
    });
    const listDefinition = createTaskListToolDefinition({
      listTasks,
    } as unknown as AgentManagementService);
    const context = invocationContext();
    await listDefinition.execute(
      { scope: { kind: "thread" }, scopeMode: "exact" },
      context,
    );
    expect(listTasks).toHaveBeenCalledWith(
      { tenantId: context.tenantId, principalId: context.principalId },
      { kind: "thread", threadId: context.defaults.threadId },
      context.environmentAuthority,
      { scopeMode: "exact", projection: "summary", pageSize: 50 },
    );
    await listDefinition.execute(
      {
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        scopeMode: "subtree",
      },
      context,
    );
    expect(listTasks).toHaveBeenLastCalledWith(
      { tenantId: context.tenantId, principalId: context.principalId },
      { kind: "workspace", workspaceId: "workspace-a" },
      context.environmentAuthority,
      { scopeMode: "subtree", projection: "summary", pageSize: 50 },
    );
    await expect(
      listDefinition.execute(
        { scope: { kind: "thread" }, scopeMode: "exact", query: "   " },
        context,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(listTasks).toHaveBeenCalledTimes(2);

    const createDefinition = createTaskCreateToolDefinition({
      createTask: vi.fn(),
    } as unknown as AgentManagementService);
    await expect(
      createDefinition.execute(
        {
          title: "Bad path",
          files: ["relative.md"],
          scope: { kind: "global" },
        },
        context,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("normalizes thread creation titles through the shared application contract", async () => {
    const createThread = vi.fn(async () => ({
      threadId: "created-thread",
      workspaceId: "source-workspace",
      targetId: "target-1",
    }));
    const definition = createThreadCreateToolDefinition({
      createThread,
    });
    const abortSignal = new AbortController().signal;
    const context: TrustedToolInvocationContext = {
      ...invocationContext(),
      subject: {
        kind: "thread_agent",
        sourceThreadId: "source-thread",
        backendKind: "pi",
      },
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-a",
        workspaceId: "source-workspace",
        threadId: "source-thread",
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: "source-thread",
        revision: 1,
      },
      environmentAuthority: {
        id: "environment-grant-1",
        callerKind: "thread_agent",
        defaults: {
          kind: "thread_agent",
          environmentId: "environment-a",
          workspaceId: "source-workspace",
          threadId: "source-thread",
        },
        policyIdentity: {
          ownerKind: "thread",
          ownerId: "source-thread",
          revision: 1,
        },
        admittedEnvironmentIds: ["environment-a"],
        targetEnvironmentIds: ["environment-a"],
        resolvedResourceRefs: [
          {
            kind: "workspace",
            id: "source-workspace",
            environmentId: "environment-a",
          },
        ],
        display: { targetEnvironmentLabels: [], resourceLabels: [] },
        canonicalInputDigest: "input-digest",
        authorityDigest: "authority-digest",
      },
      abortSignal,
    };

    const configuration = {
      kind: "saved_agent" as const,
      agentId: "10000000-0000-4000-8000-000000000012",
    };
    await definition.execute({ title: " \n ", configuration }, context);
    await definition.execute(
      { title: "  Review\nnext\r\nline  ", configuration },
      context,
    );

    expect(createThread).toHaveBeenNthCalledWith(
      1,
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        title: "New thread",
        workspaceId: "source-workspace",
        configuration,
        executionWorkspace: { kind: "direct" },
      },
      {
        kind: "agent_tool",
        initiator: {
          kind: "thread_agent",
          sourceThreadId: "source-thread",
          sourceWorkspaceId: "source-workspace",
        },
        mutationId: context.mutationId,
        environmentAuthority: context.environmentAuthority,
      },
      abortSignal,
    );
    expect(createThread).toHaveBeenNthCalledWith(
      2,
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        title: "Review next line",
        workspaceId: "source-workspace",
        configuration,
        executionWorkspace: { kind: "direct" },
      },
      {
        kind: "agent_tool",
        initiator: {
          kind: "thread_agent",
          sourceThreadId: "source-thread",
          sourceWorkspaceId: "source-workspace",
        },
        mutationId: context.mutationId,
        environmentAuthority: context.environmentAuthority,
      },
      abortSignal,
    );
  });

  it("creates a principal-client thread with client provenance and no controller thread", async () => {
    const createThread = vi.fn(async () => ({
      threadId: "created-thread",
      workspaceId: "principal-workspace",
      targetId: "target-1",
    }));
    const definition = createThreadCreateToolDefinition({ createThread });
    const base = invocationContext();
    const defaults = {
      kind: "principal_client" as const,
      environmentId: "environment-1",
      workspaceId: "principal-workspace",
    };
    const policyIdentity = {
      ownerKind: "principal_client" as const,
      ownerId: "client-1",
      revision: 3,
      credentialGeneration: 2,
    };
    const context: TrustedToolInvocationContext = {
      ...base,
      subject: {
        kind: "principal_client",
        clientId: "client-1",
        credentialGeneration: 2,
      },
      defaults,
      policyIdentity,
      environmentAuthority: {
        ...base.environmentAuthority,
        callerKind: "principal_client",
        defaults,
        policyIdentity,
      },
    };

    await definition.execute(
      {
        title: "External draft",
        configuration: { kind: "custom", targetId: "target-1" },
      },
      context,
    );

    expect(createThread).toHaveBeenCalledWith(
      { tenantId: context.tenantId, principalId: context.principalId },
      {
        title: "External draft",
        workspaceId: "principal-workspace",
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      },
      {
        kind: "agent_tool",
        initiator: { kind: "principal_client", clientId: "client-1" },
        mutationId: context.mutationId,
        environmentAuthority: context.environmentAuthority,
      },
      context.abortSignal,
    );
  });

  it("defaults thread discovery to the source environment without workspace context", async () => {
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    const definition = createThreadListToolDefinition({
      listThreads,
    } as unknown as AgentManagementService);
    const context: TrustedToolInvocationContext = {
      ...invocationContext(),
      subject: {
        kind: "principal_client",
        clientId: "client-1",
        credentialGeneration: 1,
      },
      defaults: { kind: "principal_client", environmentId: "environment-1" },
      policyIdentity: {
        ownerKind: "principal_client",
        ownerId: "client-1",
        revision: 1,
        credentialGeneration: 1,
      },
      environmentAuthority: {
        ...invocationContext().environmentAuthority,
        callerKind: "principal_client",
        defaults: {
          kind: "principal_client",
          environmentId: "environment-1",
        },
        policyIdentity: {
          ownerKind: "principal_client",
          ownerId: "client-1",
          revision: 1,
          credentialGeneration: 1,
        },
      },
    };

    await expect(definition.execute({}, context)).resolves.toEqual({
      items: [],
    });
    expect(listThreads).toHaveBeenLastCalledWith(
      { tenantId: context.tenantId, principalId: context.principalId },
      undefined,
      { scope: { kind: "default_environment" }, pageSize: 50 },
      context.environmentAuthority,
      context.abortSignal,
    );
    await expect(
      definition.execute(
        { lastActivityAfter: "not-a-valid-timestamp" },
        context,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(listThreads).toHaveBeenCalledTimes(1);
  });
});

function invocationContext(): TrustedToolInvocationContext {
  return {
    invocationId: "invocation-1",
    mutationId: "10000000-0000-4000-8000-000000000099",
    tenantId: "tenant-1",
    principalId: "principal-1",
    subject: {
      kind: "thread_agent",
      sourceThreadId: "10000000-0000-4000-8000-000000000010",
      backendKind: "pi",
    },
    defaults: {
      kind: "thread_agent",
      environmentId: "environment-1",
      workspaceId: "10000000-0000-4000-8000-000000000011",
      threadId: "10000000-0000-4000-8000-000000000010",
    },
    policyIdentity: {
      ownerKind: "thread",
      ownerId: "10000000-0000-4000-8000-000000000010",
      revision: 0,
    },
    adapter: "http",
    effectiveCapabilities: [],
    hasCapability: () => false,
    environmentAuthority: {
      id: "authority-1",
      callerKind: "thread_agent",
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-1",
        workspaceId: "10000000-0000-4000-8000-000000000011",
        threadId: "10000000-0000-4000-8000-000000000010",
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: "10000000-0000-4000-8000-000000000010",
        revision: 0,
      },
      admittedEnvironmentIds: ["environment-1"],
      targetEnvironmentIds: ["environment-1"],
      resolvedResourceRefs: [],
      display: {
        defaultEnvironmentLabel: "Local",
        targetEnvironmentLabels: ["Local"],
        resourceLabels: [],
      },
      canonicalInputDigest: "a".repeat(64),
      authorityDigest: "b".repeat(64),
    },
    requestId: "request-1",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}
