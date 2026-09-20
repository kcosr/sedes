import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { SavedAgentApplicationService } from "../../src/server/application/saved-agent-application-service.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import type { SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import { savedAgentBackendTypeIdSchema } from "../../src/shared/protocol/saved-agents.js";
import type { AgentToolBootstrapPolicy } from "../../src/shared/protocol/saved-agents.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const workspaceId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const typeId = savedAgentBackendTypeIdSchema.parse("test-agent");
const otherTypeId = savedAgentBackendTypeIdSchema.parse("other-agent");
const agentAuthority = {
  id: "environment-grant-1",
  callerKind: "thread_agent",
  defaults: {
    kind: "thread_agent",
    environmentId: "environment-1",
    workspaceId,
    threadId: "source-thread",
  },
  policyIdentity: {
    ownerKind: "thread",
    ownerId: "source-thread",
    revision: 1,
  },
  admittedEnvironmentIds: ["environment-1"],
  targetEnvironmentIds: ["environment-1"],
  resolvedResourceRefs: [
    {
      kind: "workspace",
      id: workspaceId,
      environmentId: "environment-1",
    },
  ],
  display: { targetEnvironmentLabels: [], resourceLabels: [] },
  canonicalInputDigest: "input-digest",
  authorityDigest: "authority-digest",
} as const;

function adapter(fails: boolean): SavedAgentBackendAdapter {
  return {
    typeId,
    backendKind: "pi",
    presentation: {
      typeId,
      label: { text: "Test Agent" },
      brand: "pi",
    },
    overrideSchemaVersion: 1,
    validateOverrides: ({ overrides }) => ({
      backendTypeId: typeId,
      schemaVersion: 1,
      overrides,
    }),
    prepareResolutionContext: () => ({
      backendTypeId: typeId,
      schemaVersion: 1,
      value: {},
    }),
    resolve: ({ overrides }) => {
      if (fails) {
        throw new DomainError("invalid_transition", "Target is incompatible.");
      }
      return {
        backendTypeId: typeId,
        schemaVersion: 1,
        normalizedValues: overrides.overrides,
        value: { selected: true },
      };
    },
    describeEditor: () => ({
      backendTypeId: typeId,
      fields: [],
      canonicalOverrides: [],
    }),
    captureThreadConfiguration: () => ({
      backendTypeId: typeId,
      schemaVersion: 1,
      settingsRevision: 7,
      overrides: [{ id: "model", value: "copied-model" }],
    }),
    assertThreadConfigurationCapture: () => undefined,
    initializeNewThread: () => undefined,
  };
}

function fixture(
  input: {
    readonly sedesTools?: AgentToolBootstrapPolicy;
    readonly adapterAFails?: boolean;
    readonly adapterBFails?: boolean;
    readonly sourceWorkspaceId?: string;
    readonly workspaceEnvironmentId?: string;
    readonly eligibleToolIds?: ReadonlySet<string>;
    readonly sourceAvailable?: boolean;
    readonly toolPolicyChangesBeforeFence?: boolean;
    readonly isolationUnavailable?: boolean;
    readonly agentBackendTypeId?: string;
    readonly admittedIsolationNetworkProfiles?: ReadonlySet<
      "isolated" | "execution_host"
    >;
    readonly configurationCopyReplay?: {
      readonly applicationThreadId: string;
      readonly workspaceId: string;
      readonly targetId: string;
      readonly draft: Record<string, never>;
    };
    readonly configurationCopyReplayAfterCreate?: {
      readonly applicationThreadId: string;
      readonly workspaceId: string;
      readonly targetId: string;
      readonly draft: Record<string, never>;
    };
  } = {},
) {
  const database = new Database(":memory:");
  const workspaceEnvironmentId =
    input.workspaceEnvironmentId ?? "environment-1";
  const profiles = [
    {
      id: "target-a",
      backendInstanceId: "backend-a",
      executionEnvironmentId: workspaceEnvironmentId,
      label: "Server A",
      enabled: 1 as const,
      configurationRevision: 0,
      configurationFingerprint: "profile-a",
      kind: "pi_sdk" as const,
    },
    {
      id: "target-b",
      backendInstanceId: "backend-b",
      executionEnvironmentId: workspaceEnvironmentId,
      label: "Server B",
      enabled: 1 as const,
      configurationRevision: 0,
      configurationFingerprint: "profile-b",
      kind: "pi_sdk" as const,
    },
  ];
  const backends = new Map([
    [
      "backend-a",
      {
        id: "backend-a",
        kind: "pi" as const,
        enabled: 1 as const,
        configurationRevision: 0,
        configurationFingerprint: "backend-a",
      },
    ],
    [
      "backend-b",
      {
        id: "backend-b",
        kind: "pi" as const,
        enabled: 1 as const,
        configurationRevision: 0,
        configurationFingerprint: "backend-b",
      },
    ],
  ]);
  const adapters = new SavedAgentBackendAdapterRegistry([
    {
      backendInstanceId: "backend-a",
      adapter: adapter(input.adapterAFails ?? true),
    },
    {
      backendInstanceId: "backend-b",
      adapter: adapter(input.adapterBFails ?? false),
    },
  ]);
  let lifecycleCreateCompleted = false;
  const createServerDraft = vi.fn(async (_scope, draftInput) => {
    draftInput.bootstrap?.assertDurableFences({
      assertActive: vi.fn(),
    });
    lifecycleCreateCompleted = true;
    return {
      applicationThreadId: "30000000-0000-4000-8000-000000000001",
      draft: {},
      targetId: draftInput.connectionProfileId,
    };
  });
  const initializeToolPolicy = vi.fn();
  const handoffThreadChange = vi.fn();
  const listAgents = vi.fn(() => ({ items: [] }));
  const requireAgentSelectable = vi.fn(async () => undefined);
  const catalog = vi.fn(async () => ({
    models: [],
    commands: [],
    skills: [],
    notices: [],
  }));
  const inventory = {
    assertWorkspaceActive: vi.fn(),
    database,
    getWorkspace: (_scope: unknown, requestedWorkspaceId: string) => ({
      id: requestedWorkspaceId,
      environmentId: workspaceEnvironmentId,
      canonicalPath: "/workspace",
      revision: 0,
      environmentConfigurationRevision: 0,
    }),
    getEnvironment: () => ({
      id: workspaceEnvironmentId,
      kind: "local" as const,
    }),
    getThread: (requestedScope: RequestScope, threadId: string) => {
      if (
        requestedScope.tenantId !== scope.tenantId ||
        requestedScope.principalId !== scope.principalId
      ) {
        throw new DomainError("not_found", "The thread was not found.");
      }
      return {
        thread: {
          id: threadId,
          workspaceId: input.sourceWorkspaceId ?? workspaceId,
          environmentId: workspaceEnvironmentId,
          backendInstanceId: "backend-a",
          connectionProfileId: "target-a",
          availability:
            input.sourceAvailable === false ? "missing" : "available",
        },
      };
    },
  };
  const getToolPolicy = vi
    .fn()
    .mockReturnValueOnce({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: "source-thread",
      enabled: true,
      presentation: { surface: "native", mode: "individual" },
      accessBoundary: "unrestricted",
      revision: 3,
      updatedAt: 1,
      enabledToolIds: ["task.list"],
    })
    .mockImplementation(() => ({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: "source-thread",
      enabled: true,
      presentation: { surface: "native", mode: "individual" },
      accessBoundary: "unrestricted",
      revision: input.toolPolicyChangesBeforeFence ? 4 : 3,
      updatedAt: input.toolPolicyChangesBeforeFence ? 2 : 1,
      enabledToolIds: ["task.list"],
    }));
  const reserveWorkspace = vi.fn();
  const service = new SavedAgentApplicationService({
    agents: {
      list: listAgents,
      get: () => ({
        id: agentId,
        name: "Reviewer",
        backendTypeId: input.agentBackendTypeId ?? typeId,
        backend: adapter(false).presentation,
        backendOverrides: [],
        ...(input.sedesTools ? { sedesTools: input.sedesTools } : {}),
        revision: 0,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      }),
    } as never,
    repository: {
      database,
      assertRevision: vi.fn(),
    } as never,
    adapters,
    configuration: {
      database,
      listProfiles: () => profiles,
      getProfile: (_scope: unknown, id: string) =>
        profiles.find((profile) => profile.id === id)!,
      getBackend: (_scope: unknown, id: string) => backends.get(id)!,
    } as never,
    inventory: inventory as never,
    targets: {
      lifecycle: async (
        _scope: unknown,
        input: { connectionProfileId: string; workspaceId: string },
      ) => ({
        connection: {
          ...profiles.find(({ id }) => id === input.connectionProfileId)!,
          tenantId: scope.tenantId,
          ownerPrincipalId: scope.principalId,
          templateId: input.connectionProfileId,
          kind: "pi_sdk" as const,
          enabled: true,
        },
        workspace: {
          canonicalPath: "/workspace",
          authorityRevision: 0,
          summary: {
            id: input.workspaceId,
            environmentId: workspaceEnvironmentId,
            displayName: "Workspace",
            displayPath: "/workspace",
            availability: "available" as const,
            trustState: "trusted" as const,
            revision: 0,
          },
        },
      }),
    } as never,
    targetHealth: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
      requireAgentSelectable,
    },
    registry: {
      driver: () => ({
        catalog,
      }),
    } as never,
    lifecycle: {
      createServerDraft,
      findThreadConfigurationCopy: vi.fn(
        () =>
          input.configurationCopyReplay ??
          (lifecycleCreateCompleted
            ? (input.configurationCopyReplayAfterCreate ?? {
                applicationThreadId: "30000000-0000-4000-8000-000000000001",
                workspaceId: input.sourceWorkspaceId ?? workspaceId,
                targetId: "target-a",
                draft: {},
              })
            : undefined),
      ),
    } as never,
    toolPolicies: {
      database,
      get: getToolPolicy,
      getDurable: getToolPolicy,
      initialize: initializeToolPolicy,
    } as never,
    toolEligibility: {
      eligibleToolIds: input.eligibleToolIds ?? new Set(),
      presentationOptions: () => [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
    },
    toolCatalog: { list: () => ({ groups: [] }) },
    executionWorkspaces: {
      assertAvailable: vi.fn(({ networkProfile }) => {
        if (input.isolationUnavailable) {
          throw new DomainError(
            "runtime_unavailable",
            "Isolated workspace execution is unavailable.",
            true,
          );
        }
        if (
          !(input.admittedIsolationNetworkProfiles ?? new Set(["isolated"])).has(
            networkProfile,
          )
        ) {
          throw new DomainError(
            "runtime_unavailable",
            "The selected isolated network profile is not admitted.",
            true,
          );
        }
      }),
      selection: () => ({ kind: "direct" as const }),
      reserve: reserveWorkspace,
    },
    publications: { handoffThreadChange },
  });
  return {
    database,
    service,
    createServerDraft,
    initializeToolPolicy,
    handoffThreadChange,
    listAgents,
    inventory,
    requireAgentSelectable,
    getToolPolicy,
    catalog,
    reserveWorkspace,
  };
}

describe("SavedAgentApplicationService", () => {
  it("materializes a same-settings copy from the server-owned source target and policies", async () => {
    const current = fixture({
      adapterAFails: false,
      eligibleToolIds: new Set(["task.list"]),
    });
    try {
      await expect(
        current.service.createThreadFromSettings(scope, "source-thread", {
          title: "New thread",
          mutationId: "30000000-0000-4000-8000-000000000001",
        }),
      ).resolves.toEqual({
        threadId: "30000000-0000-4000-8000-000000000001",
        workspaceId,
        targetId: "target-a",
      });

      const lifecycleInput = current.createServerDraft.mock.calls[0]![1];
      expect(lifecycleInput).toMatchObject({
        workspaceId,
        connectionProfileId: "target-a",
        title: "New thread",
        configurationCopy: {
          sourceApplicationThreadId: "source-thread",
          mutationId: "30000000-0000-4000-8000-000000000001",
        },
        bootstrap: {
          backendConfiguration: {
            normalizedValues: [{ id: "model", value: "copied-model" }],
          },
        },
      });
      const transaction = { assertActive: vi.fn() };
      lifecycleInput.bootstrap.initializeAgentTools({
        transaction,
        applicationThreadId: "copied-thread",
        now: 123,
      });
      expect(current.initializeToolPolicy).toHaveBeenCalledWith(
        scope,
        "copied-thread",
        {
          enabled: true,
          enabledToolIds: ["task.list"],
          presentation: { surface: "native", mode: "individual" },
          accessBoundary: "unrestricted",
          now: 123,
        },
      );
      expect(current.handoffThreadChange).toHaveBeenCalledWith(
        scope,
        "30000000-0000-4000-8000-000000000001",
      );
    } finally {
      current.database.close();
    }
  });

  it("replays the immutable creation result and heals application publication", async () => {
    const current = fixture({
      configurationCopyReplay: {
        applicationThreadId: "copied-thread",
        workspaceId: "original-workspace",
        targetId: "original-target",
        draft: {},
      },
    });
    try {
      await expect(
        current.service.createThreadFromSettings(scope, "source-thread", {
          title: "New thread",
          mutationId: "30000000-0000-4000-8000-000000000002",
        }),
      ).resolves.toEqual({
        threadId: "copied-thread",
        workspaceId: "original-workspace",
        targetId: "original-target",
      });
      expect(current.createServerDraft).not.toHaveBeenCalled();
      expect(current.handoffThreadChange).toHaveBeenCalledWith(
        scope,
        "copied-thread",
      );
    } finally {
      current.database.close();
    }
  });

  it("returns the immutable receipt when a concurrent copy wins inside lifecycle creation", async () => {
    const current = fixture({
      adapterAFails: false,
      eligibleToolIds: new Set(["task.list"]),
      configurationCopyReplayAfterCreate: {
        applicationThreadId: "30000000-0000-4000-8000-000000000001",
        workspaceId: "original-workspace",
        targetId: "original-target",
        draft: {},
      },
    });
    try {
      await expect(
        current.service.createThreadFromSettings(scope, "source-thread", {
          title: "New thread",
          mutationId: "30000000-0000-4000-8000-000000000005",
        }),
      ).resolves.toEqual({
        threadId: "30000000-0000-4000-8000-000000000001",
        workspaceId: "original-workspace",
        targetId: "original-target",
      });
      expect(current.createServerDraft).toHaveBeenCalledOnce();
      expect(current.handoffThreadChange).toHaveBeenCalledWith(
        scope,
        "30000000-0000-4000-8000-000000000001",
      );
    } finally {
      current.database.close();
    }
  });

  it("rejects an unavailable source before creating a child", async () => {
    const current = fixture({ sourceAvailable: false });
    try {
      await expect(
        current.service.createThreadFromSettings(scope, "source-thread", {
          title: "New thread",
          mutationId: "30000000-0000-4000-8000-000000000003",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
      expect(current.handoffThreadChange).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("denies a foreign principal before reading source configuration or tool policy", async () => {
    const current = fixture({
      adapterAFails: false,
      eligibleToolIds: new Set(["task.list"]),
    });
    try {
      await expect(
        current.service.createThreadFromSettings(
          { tenantId: scope.tenantId, principalId: "other-principal" },
          "source-thread",
          {
            title: "New thread",
            mutationId: "30000000-0000-4000-8000-000000000006",
          },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(current.catalog).not.toHaveBeenCalled();
      expect(current.getToolPolicy).not.toHaveBeenCalled();
      expect(current.createServerDraft).not.toHaveBeenCalled();
      expect(current.handoffThreadChange).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("fails the durable fence when the source tool policy changes", async () => {
    const current = fixture({
      adapterAFails: false,
      eligibleToolIds: new Set(["task.list"]),
      toolPolicyChangesBeforeFence: true,
    });
    try {
      await expect(
        current.service.createThreadFromSettings(scope, "source-thread", {
          title: "New thread",
          mutationId: "30000000-0000-4000-8000-000000000004",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.handoffThreadChange).not.toHaveBeenCalled();
      expect(current.initializeToolPolicy).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("rejects an unadmitted authoring workspace before target health or catalog reads", async () => {
    const current = fixture({ workspaceEnvironmentId: "environment-2" });
    try {
      await expect(
        current.service.optionsForAgentTool(
          scope,
          { workspaceId, targetId: "target-a", overrides: [] },
          undefined,
          {
            id: "authority-1",
            callerKind: "thread_agent",
            defaults: {
              kind: "thread_agent",
              environmentId: "environment-1",
              workspaceId,
              threadId: "source-thread",
            },
            policyIdentity: {
              ownerKind: "thread",
              ownerId: "source-thread",
              revision: 1,
            },
            admittedEnvironmentIds: ["environment-1"],
            targetEnvironmentIds: [],
            resolvedResourceRefs: [],
            display: { targetEnvironmentLabels: [], resourceLabels: [] },
            canonicalInputDigest: "input-digest",
            authorityDigest: "authority-digest",
          },
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(current.requireAgentSelectable).not.toHaveBeenCalled();
      expect(current.catalog).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("derives the Saved Agent backend filter from an exact Target", () => {
    const current = fixture();
    try {
      current.service.list(scope, {
        targetId: "target-a",
        nameSearch: "review",
        pageSize: 25,
      });
      expect(current.listAgents).toHaveBeenCalledWith(scope, {
        backendTypeId: typeId,
        nameSearch: "review",
        pageSize: 25,
      });
    } finally {
      current.database.close();
    }
  });

  it("creates a fresh custom Pi draft through ordinary defaults when no inline configuration is supplied", async () => {
    const current = fixture();
    try {
      const result = await current.service.createThread(
        scope,
        {
          workspaceId,
          title: "Configure after creation",
          executionWorkspace: { kind: "direct" },
          configuration: { kind: "custom", targetId: "target-a" },
        },
        { kind: "http_ui" },
      );
      expect(result.targetId).toBe("target-a");
      expect(current.createServerDraft).toHaveBeenCalledWith(
        scope,
        {
          workspaceId,
          connectionProfileId: "target-a",
          title: "Configure after creation",
        },
        undefined,
      );
      expect(current.createServerDraft.mock.calls[0]![1]).not.toHaveProperty(
        "bootstrap",
      );
      expect(current.handoffThreadChange).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("rejects an isolated selection when the local runtime did not pass preflight", async () => {
    const current = fixture({ isolationUnavailable: true });
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Unavailable isolation",
            executionWorkspace: {
              kind: "isolated",
              workspaceAccess: "writable_clone",
              networkProfile: "isolated",
            },
            configuration: { kind: "custom", targetId: "target-a" },
          },
          { kind: "http_ui" },
        ),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("rejects execution-host networking unless operator policy admits it", async () => {
    const denied = fixture();
    try {
      await expect(
        denied.service.createThread(
          scope,
          {
            workspaceId,
            title: "Host network denied",
            executionWorkspace: {
              kind: "isolated",
              workspaceAccess: "read_only",
              networkProfile: "execution_host",
            },
            configuration: { kind: "custom", targetId: "target-a" },
          },
          { kind: "http_ui" },
        ),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(denied.createServerDraft).not.toHaveBeenCalled();
    } finally {
      denied.database.close();
    }

    const admitted = fixture({
      admittedIsolationNetworkProfiles: new Set([
        "isolated",
        "execution_host",
      ]),
    });
    try {
      await expect(
        admitted.service.createThread(
          scope,
          {
            workspaceId,
            title: "Host network admitted",
            executionWorkspace: {
              kind: "isolated",
              workspaceAccess: "writable_clone",
              networkProfile: "execution_host",
            },
            configuration: { kind: "custom", targetId: "target-a" },
          },
          { kind: "http_ui" },
        ),
      ).resolves.toMatchObject({ targetId: "target-a" });
      expect(admitted.createServerDraft).toHaveBeenCalledOnce();
    } finally {
      admitted.database.close();
    }
  });

  it("describes selected-target authoring options before strict backend resolution is complete", async () => {
    const current = fixture();
    try {
      await expect(
        current.service.options(scope, {
          workspaceId,
          targetId: "target-a",
          overrides: [],
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        target: { id: "target-a" },
        configuration: { fields: [], canonicalOverrides: [] },
      });
    } finally {
      current.database.close();
    }
  });

  it("rejects a template target from a different Saved Agent backend type", async () => {
    const current = fixture({
      adapterAFails: false,
      agentBackendTypeId: otherTypeId,
    });
    try {
      await expect(
        current.service.prepareThreadTemplateSelection(scope, {
          workspaceId,
          targetId: "target-a",
          executionWorkspace: { kind: "direct" },
          agentId,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message:
          "The template target uses a different Saved Agent backend type.",
      });
    } finally {
      current.database.close();
    }
  });

  it("materializes every same-type instance before inferring the unique compatible target", async () => {
    const current = fixture();
    try {
      const result = await current.service.createThread(
        scope,
        {
          workspaceId,
          title: "Review",
          executionWorkspace: { kind: "direct" },
          configuration: { kind: "saved_agent", agentId },
        },
        { kind: "http_ui" },
      );
      expect(result.targetId).toBe("target-b");
      expect(current.createServerDraft).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({ connectionProfileId: "target-b" }),
        undefined,
      );
      expect(current.handoffThreadChange).toHaveBeenCalledWith(
        scope,
        result.threadId,
      );
    } finally {
      current.database.close();
    }
  });

  it("rejects inferred Saved Agent creation when no candidate is compatible", async () => {
    const current = fixture({ adapterAFails: true, adapterBFails: true });
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Review",
            executionWorkspace: { kind: "direct" },
            configuration: { kind: "saved_agent", agentId },
          },
          { kind: "http_ui" },
        ),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
      expect(current.handoffThreadChange).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("rejects inferred Saved Agent creation when multiple candidates are compatible", async () => {
    const current = fixture({ adapterAFails: false, adapterBFails: false });
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Review",
            executionWorkspace: { kind: "direct" },
            configuration: { kind: "saved_agent", agentId },
          },
          { kind: "http_ui" },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
      expect(current.handoffThreadChange).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("rejects a forged trusted caller association without constraining the destination workspace", async () => {
    const current = fixture();
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Review",
            executionWorkspace: { kind: "direct" },
            configuration: {
              kind: "custom",
              targetId: "target-b",
            },
          },
          {
            kind: "agent_tool",
            initiator: {
              kind: "thread_agent",
              sourceThreadId: "source-thread",
              sourceWorkspaceId: "different-workspace",
            },
            mutationId: "mutation-forged",
            environmentAuthority: agentAuthority,
          },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("allows a trusted agent caller to create in a different destination workspace", async () => {
    const sourceWorkspaceId = "40000000-0000-4000-8000-000000000001";
    const current = fixture({ sourceWorkspaceId });
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Cross-workspace review",
            executionWorkspace: { kind: "direct" },
            configuration: { kind: "custom", targetId: "target-b" },
          },
          {
            kind: "agent_tool",
            initiator: {
              kind: "thread_agent",
              sourceThreadId: "source-thread",
              sourceWorkspaceId,
            },
            mutationId: "mutation-cross-workspace",
            environmentAuthority: agentAuthority,
          },
        ),
      ).resolves.toMatchObject({ workspaceId, targetId: "target-b" });
      expect(current.createServerDraft).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({ workspaceId }),
        undefined,
      );
      expect(current.handoffThreadChange).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("rechecks the destination workspace after target health resolution", async () => {
    const sourceWorkspaceId = "40000000-0000-4000-8000-000000000001";
    const current = fixture({ sourceWorkspaceId });
    current.requireAgentSelectable.mockImplementationOnce(async () => {
      current.inventory.getWorkspace = (
        _scope: unknown,
        requestedWorkspaceId: string,
      ) => ({
        id: requestedWorkspaceId,
        environmentId: "environment-2",
        canonicalPath: "/workspace",
        revision: 1,
        environmentConfigurationRevision: 1,
      });
    });
    try {
      await expect(
        current.service.createThread(
          scope,
          {
            workspaceId,
            title: "Changed destination",
            executionWorkspace: { kind: "direct" },
            configuration: { kind: "custom", targetId: "target-b" },
          },
          {
            kind: "agent_tool",
            initiator: {
              kind: "thread_agent",
              sourceThreadId: "source-thread",
              sourceWorkspaceId,
            },
            mutationId: "mutation-changed-destination",
            environmentAuthority: agentAuthority,
          },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(current.createServerDraft).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("bootstraps an active CLI tool policy without requiring CLI provisioning", async () => {
    const toolId = "task.list";
    const sedesTools = {
      enabled: true,
      enabledToolIds: [toolId],
      presentation: { surface: "cli" as const, mode: "progressive" as const },
      accessBoundary: "unrestricted" as const,
    };
    const current = fixture({
      eligibleToolIds: new Set([toolId]),
      sedesTools,
    });
    try {
      await current.service.createThread(
        scope,
        {
          workspaceId,
          title: "Review",
          executionWorkspace: { kind: "direct" },
          configuration: { kind: "saved_agent", agentId, targetId: "target-b" },
        },
        { kind: "http_ui" },
      );

      const lifecycleInput = current.createServerDraft.mock.calls[0]![1];
      expect(lifecycleInput.savedAgentOrigin).toEqual({
        agentId,
        agentRevision: 0,
        agentName: "Reviewer",
      });
      expect(lifecycleInput.bootstrap).not.toHaveProperty("agentId");
      expect(lifecycleInput.bootstrap).not.toHaveProperty("savedAgentId");

      // Materialization owns a complete policy copy. A later Saved Agent edit
      // cannot retroactively change the thread policy waiting to be committed.
      (sedesTools as { accessBoundary: string }).accessBoundary = "environment";

      const transaction = { assertActive: vi.fn() };
      lifecycleInput.bootstrap.initializeAgentTools({
        transaction,
        applicationThreadId: "thread-created-from-snapshot",
        now: 123,
      });
      expect(transaction.assertActive).toHaveBeenCalledOnce();
      expect(current.initializeToolPolicy).toHaveBeenCalledWith(
        scope,
        "thread-created-from-snapshot",
        {
          enabled: true,
          enabledToolIds: [toolId],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "unrestricted",
          now: 123,
        },
      );
    } finally {
      current.database.close();
    }
  });
});
