import { describe, expect, it, vi } from "vitest";
import type {
  AgentToolDefinition,
  TrustedToolInvocationContext,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import {
  createSavedAgentCreateToolDefinition,
  createSavedAgentDeleteToolDefinition,
  createSavedAgentGetToolDefinition,
  createSavedAgentListToolDefinition,
  createSavedAgentOptionsToolDefinition,
  createSavedAgentUpdateToolDefinition,
  type SavedAgentCanonicalToolService,
} from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";
import { createThreadCreateToolDefinition } from "../../src/server/agent-tools/tools/thread-management-tools.js";
import { createPiAgentToolSet } from "../../src/server/backends/pi/pi-agent-tool-adapter.js";
import { PiToolAccessController } from "../../src/server/backends/pi/pi-tool-access.js";

const agentId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const targetId = "target-one";

function service(
  overrides: Partial<SavedAgentCanonicalToolService> = {},
): SavedAgentCanonicalToolService {
  const agent = {
    id: agentId,
    name: "Careful reviewer",
    backendTypeId: "pi",
    backend: { typeId: "pi", label: { text: "Pi" }, brand: "pi" as const },
    backendOverrides: [],
    revision: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  return {
    list: () => ({ items: [] }),
    get: () => agent,
    optionsForAgentTool: async () => ({ kind: "targets", targets: [] }),
    createAgentForAgentTool: () => agent,
    updateAgentForAgentTool: () => agent,
    deleteAgent: () => ({ deleted: true, agentId }),
    ...overrides,
  };
}

function definitions(value = service()): readonly AgentToolDefinition[] {
  return [
    createSavedAgentListToolDefinition(value),
    createSavedAgentGetToolDefinition(value),
    createSavedAgentOptionsToolDefinition(value),
    createSavedAgentCreateToolDefinition(value),
    createSavedAgentUpdateToolDefinition(value),
    createSavedAgentDeleteToolDefinition(value),
  ];
}

function context(): TrustedToolInvocationContext {
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
      workspaceId,
      threadId: "10000000-0000-4000-8000-000000000010",
    },
    policyIdentity: {
      ownerKind: "thread",
      ownerId: "10000000-0000-4000-8000-000000000010",
      revision: 1,
    },
    environmentAuthority: {
      id: "authority-1",
      callerKind: "thread_agent",
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-1",
        workspaceId,
        threadId: "10000000-0000-4000-8000-000000000010",
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: "10000000-0000-4000-8000-000000000010",
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-1"],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [
        { kind: "workspace", id: workspaceId, environmentId: "environment-1" },
      ],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
    },
    adapter: "http",
    effectiveCapabilities: [],
    hasCapability: () => false,
    requestId: "request-1",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

describe("Saved Agent canonical tools", () => {
  it("registers six independently exposable contracts with truthful effects", () => {
    const registry = new AgentToolRegistry();
    definitions().forEach((definition) => registry.register(definition));

    expect(registry.list().map(({ id }) => id)).toEqual([
      "saved_agent.list",
      "saved_agent.get",
      "saved_agent.options",
      "saved_agent.create",
      "saved_agent.update",
      "saved_agent.delete",
    ]);
    expect(registry.list().map(({ effects }) => effects.application)).toEqual([
      "read",
      "read",
      "read",
      "write",
      "write",
      "destructive",
    ]);
    for (const id of [
      "saved_agent.list",
      "saved_agent.get",
      "saved_agent.options",
      "saved_agent.create",
      "saved_agent.update",
    ]) {
      expect(registry.get(id, 5).schemaVersion).toBe(5);
      expect(() => registry.get(id, 4)).toThrow();
    }
    expect(
      registry
        .list()
        .every((definition) =>
          definition.effects.application === "read"
            ? !definition.execution.uncertainExternalOutcome
            : definition.execution.uncertainExternalOutcome,
        ),
    ).toBe(true);
  });

  it("keeps Pi native read-only filtering and write approval classification truthful", () => {
    const registry = new AgentToolRegistry();
    definitions().forEach((definition) => registry.register(definition));
    const artifacts = registry
      .list()
      .map((definition) =>
        registry.artifact(definition.id, definition.schemaVersion),
      );
    const set = createPiAgentToolSet({
      facade: {
        eligibleCatalog: () => artifacts,
        catalogSummaries: () => [],
        describeMany: () => [],
        readPolicy: () => ({
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          enabledToolIds: artifacts.map(({ id }) => id),
          accessBoundary: "environment",
          revision: 1,
        }),
        invoke: vi.fn(),
      },
      source: {
        scope: { tenantId: "tenant-1", principalId: "principal-1" },
        sourceThreadId: "thread-1",
        sourceWorkspaceId: workspaceId,
        sourceEnvironmentId: "environment-1",
        backendKind: "pi",
      },
      manager: {} as never,
      toolAccess: new PiToolAccessController("full"),
      authentication: {
        conversationId: "conversation-1",
        installationKey: new Uint8Array(32).fill(1),
      },
      providerTurnCorrelation: () => undefined,
    });

    expect(
      set.descriptors.flatMap((descriptor) =>
        "toolId" in descriptor && descriptor.readOnly
          ? [descriptor.toolId]
          : [],
      ),
    ).toEqual(["saved_agent.list", "saved_agent.get", "saved_agent.options"]);
    expect(
      set.descriptors.flatMap((descriptor) =>
        "toolId" in descriptor && !descriptor.readOnly
          ? [descriptor.toolId]
          : [],
      ),
    ).toEqual([
      "saved_agent.create",
      "saved_agent.update",
      "saved_agent.delete",
    ]);
  });

  it("derives trusted scope and the source workspace while preserving authoring context", async () => {
    const list = vi.fn(() => ({ items: [] }));
    const options = vi.fn(async () => ({
      kind: "targets" as const,
      targets: [],
    }));
    const createAgent = vi.fn(() => service().get({} as never, agentId));
    const updateAgent = vi.fn(() => service().get({} as never, agentId));
    const value = service({
      list,
      optionsForAgentTool: options,
      createAgentForAgentTool: createAgent,
      updateAgentForAgentTool: updateAgent,
    });
    const invocation = context();

    await createSavedAgentListToolDefinition(value).execute({}, invocation);
    await createSavedAgentOptionsToolDefinition(value).execute({}, invocation);
    await createSavedAgentCreateToolDefinition(value).execute(
      {
        name: "Careful reviewer",
        authoringContext: { workspaceId, targetId },
        backendOverrides: [],
      },
      invocation,
    );
    await createSavedAgentUpdateToolDefinition(value).execute(
      {
        agentId,
        expectedRevision: 0,
        authoringContext: { workspaceId, targetId },
        backendOverrides: [],
      },
      invocation,
    );

    const trustedScope = { tenantId: "tenant-1", principalId: "principal-1" };
    expect(list).toHaveBeenCalledWith(trustedScope, { pageSize: 50 });
    expect(options).toHaveBeenCalledWith(
      trustedScope,
      { workspaceId },
      invocation.abortSignal,
      invocation.environmentAuthority,
    );
    expect(createAgent).toHaveBeenCalledWith(
      trustedScope,
      {
        name: "Careful reviewer",
        authoringContext: { workspaceId, targetId },
        backendOverrides: [],
      },
      invocation.abortSignal,
      invocation.environmentAuthority,
    );
    expect(updateAgent).toHaveBeenCalledWith(
      trustedScope,
      agentId,
      {
        expectedRevision: 0,
        authoringContext: { workspaceId, targetId },
        backendOverrides: [],
      },
      invocation.abortSignal,
      invocation.environmentAuthority,
    );
  });

  it("rejects duplicate overrides and incomplete updates before domain mutation", async () => {
    const createAgent = vi.fn();
    const updateAgent = vi.fn();
    const value = service({
      createAgentForAgentTool: createAgent,
      updateAgentForAgentTool: updateAgent,
    });
    await expect(
      createSavedAgentCreateToolDefinition(value).execute(
        {
          name: "Reviewer",
          authoringContext: { workspaceId, targetId },
          backendOverrides: [
            { id: "model", value: "one" },
            { id: "model", value: "two" },
          ],
        },
        context(),
      ),
    ).rejects.toThrow();
    await expect(
      createSavedAgentUpdateToolDefinition(value).execute(
        { agentId, expectedRevision: 0 } as never,
        context(),
      ),
    ).rejects.toThrow();
    expect(createAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("publishes only strict thread.create@5 saved-Agent and Custom branches", () => {
    const registry = new AgentToolRegistry();
    registry.register(
      createThreadCreateToolDefinition({ createThread: vi.fn() }),
    );
    expect(
      registry.validatesInput("thread.create", 5, {
        title: "Review",
        configuration: { kind: "saved_agent", agentId },
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.create", 5, {
        title: "Review",
        configuration: {
          kind: "custom",
          targetId,
          backendOverrides: [{ id: "model", value: "model-one" }],
        },
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.create", 5, {
        title: "Legacy",
        targetId,
      }),
    ).toBe(false);
    expect(() => registry.get("thread.create", 4)).toThrow();
    expect(registry.get("thread.create", 5).execution.maximumInputBytes).toBe(
      256 * 1_024,
    );

    const largestToolPolicy = {
      enabled: true,
      enabledToolIds: Array.from(
        { length: 512 },
        (_, index) =>
          `tool.${index.toString().padStart(3, "0")}.${"x".repeat(118)}`,
      ),
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "unrestricted",
    };
    const largestCustomRequest = {
      title: "Review",
      configuration: {
        kind: "custom",
        targetId,
        backendOverrides: Array.from({ length: 32 }, (_, index) => ({
          id: `field.${index}`,
          value: "x".repeat(240),
        })),
        sedesTools: largestToolPolicy,
      },
    };
    expect(
      registry.validatesInput("thread.create", 5, largestCustomRequest),
    ).toBe(true);
    const serializedBytes = Buffer.byteLength(
      JSON.stringify(largestCustomRequest),
      "utf8",
    );
    expect(serializedBytes).toBeGreaterThan(4_096);
    expect(serializedBytes).toBeLessThan(
      registry.get("thread.create", 5).execution.maximumInputBytes,
    );
  });

  it.each([
    {
      label: "custom",
      configuration: { kind: "custom" as const, targetId },
    },
    {
      label: "saved Agent",
      configuration: { kind: "saved_agent" as const, agentId },
    },
  ])(
    "passes an explicit direct execution workspace to the $label creation service",
    async ({ configuration }) => {
      const createThread = vi.fn(async () => ({
        threadId: "10000000-0000-4000-8000-000000000020",
        workspaceId,
        targetId,
      }));
      const definition = createThreadCreateToolDefinition({ createThread });

      await definition.execute(
        { title: "Review", configuration },
        context(),
      );

      expect(createThread).toHaveBeenCalledWith(
        { tenantId: "tenant-1", principalId: "principal-1" },
        {
          title: "Review",
          workspaceId,
          configuration,
          executionWorkspace: { kind: "direct" },
        },
        expect.objectContaining({
          kind: "agent_tool",
          mutationId: "10000000-0000-4000-8000-000000000099",
        }),
        expect.any(AbortSignal),
      );
    },
  );
});
