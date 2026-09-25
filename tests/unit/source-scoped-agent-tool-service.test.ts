import { describe, expect, it, vi } from "vitest";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import type { AgentToolPresentation } from "../../src/shared/index.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { Type } from "typebox";
import type { AgentToolDefinition } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import type { ApplicationDecisionPresentation } from "../../src/server/conversations/interaction-broker.js";
import { createSavedAgentDeleteToolDefinition } from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";

const source = Object.freeze({
  scope: { tenantId: "tenant", principalId: "principal" },
  sourceThreadId: "thread-1",
  sourceWorkspaceId: "workspace-1",
  sourceEnvironmentId: "environment-1",
  backendKind: "pi" as const,
});

const environmentAuthority = new AgentToolEnvironmentAuthorityResolver({
  resolveEnvironment: () => undefined,
  resolveWorkspace: () => undefined,
  resolveThread: () => undefined,
  resolveThreadFamily: () => undefined,
  resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
  listEnvironments: () => [
    { id: "environment-1", environmentId: "environment-1", label: "Local" },
  ],
});
const sourceRevalidator = { resolveInScope: () => source };
const approvalAuthority = {
  acquireAgentToolApprovalAuthority: async () => ({
    generation: "generation-1",
    signal: new AbortController().signal,
    isCurrent: () => true,
    release: () => undefined,
  }),
};
const denyApprovals = {
  requestApplicationDecision: async () => "deny" as const,
};

function crossEnvironmentWriteDefinition(): AgentToolDefinition {
  return {
    ...agentContextToolDefinition,
    id: "example.cross_environment",
    description: "Exercises cross-environment approval presentation.",
    environmentAuthority: {
      kind: "direct_resource",
      resource: "environment",
      inputField: "environmentId",
    },
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          environmentId: Type.String({ minLength: 1, maxLength: 128 }),
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
          message: Type.String({ minLength: 1, maxLength: 4_096 }),
          password: Type.String({ minLength: 1, maxLength: 4_096 }),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 4,
        },
      ),
    ),
    effects: {
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    },
    execution: {
      ...agentContextToolDefinition.execution,
      concurrencyClass: "example_cross_environment_write",
      maximumInputBytes: 32 * 1_024,
      uncertainExternalOutcome: true,
    },
    catalog: {
      groupId: "context",
      label: "Cross-environment example",
      order: 999,
    },
    adapters: {
      pi: {
        name: "sedes_example_cross_environment",
        label: "Sedes cross-environment example",
      },
      mcp: { name: "sedes_example_cross_environment" },
      http: { invocation: "inline" },
      cli: { command: "example.cross_environment" },
    },
  };
}

function allEnvironmentQueryDefinition(): AgentToolDefinition {
  return {
    ...agentContextToolDefinition,
    id: "example.all_allowed_environments",
    description: "Exercises all-environment approval presentation.",
    environmentAuthority: { kind: "scoped_query", resource: "workspace" },
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          scope: Type.Object(
            {
              kind: Type.String({
                enum: ["all_allowed_environments"],
                maxLength: 24,
              }),
            },
            { additionalProperties: false, maxProperties: 1 },
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    adapters: {
      pi: {
        name: "sedes_example_all_allowed_environments",
        label: "Sedes all-environment example",
      },
      mcp: { name: "sedes_example_all_allowed_environments" },
      http: { invocation: "inline" },
      cli: { command: "example.all_allowed_environments" },
    },
  };
}

function service(
  presentation: AgentToolPresentation,
  caller: typeof source | Omit<typeof source, "backendKind"> & {
    readonly backendKind: "pi" | "codex_app_server" | "claude_agent_sdk" | "grok_build";
  } = source,
) {
  const canonical = new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
    invocationId: () => "invocation-1",
  });
  const policies = {
    get: () => ({
      enabled: true,
      enabledToolIds: ["agent.context"],
      presentation,
      accessBoundary: "environment" as const,
      revision: 1,
    }),
  } as unknown as ThreadAgentToolPolicyRepository;
  return new SourceScopedAgentToolService(
    canonical,
    policies,
    environmentAuthority,
    { resolveInScope: () => caller },
    approvalAuthority,
    denyApprovals,
  );
}

describe("SourceScopedAgentToolService", () => {
  it("executes the catalog-exposed destructive saved Agent deletion", async () => {
    const agentId = "10000000-0000-4000-8000-000000000001";
    const deleteAgent = vi.fn(() => ({
      agentId,
      deleted: true,
    }));
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        createSavedAgentDeleteToolDefinition({ deleteAgent } as never),
      ],
      invocationId: () => "delete-invocation",
    });
    const current = new SourceScopedAgentToolService(
      canonical,
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["saved_agent.delete"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 3,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      environmentAuthority,
      sourceRevalidator,
      approvalAuthority,
      denyApprovals,
    );

    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "saved_agent.delete",
          schemaVersion: 1,
          requestId: "delete-agent",
          input: { agentId, expectedRevision: 4 },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      output: { agentId, deleted: true },
    });
    expect(deleteAgent).toHaveBeenCalledExactlyOnceWith(
      source.scope,
      agentId,
      4,
    );
  });

  it("revalidates the source immediately before every invocation", async () => {
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    const policies = {
      get: vi.fn(() => ({
        enabled: true,
        enabledToolIds: ["agent.context"],
        presentation: { surface: "cli" as const, mode: "progressive" as const },
        accessBoundary: "unrestricted" as const,
        revision: 2,
      })),
    } as unknown as ThreadAgentToolPolicyRepository;
    const resolveInScope = vi.fn(() => {
      throw new CanonicalAgentToolRequestError(
        "not_found",
        "The source thread was not found.",
      );
    });
    const current = new SourceScopedAgentToolService(
      canonical,
      policies,
      environmentAuthority,
      { resolveInScope },
      approvalAuthority,
      denyApprovals,
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "archived-after-attach",
          input: {},
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ toolError: { code: "not_found" } });
    expect(resolveInScope).toHaveBeenCalledExactlyOnceWith(
      source.scope,
      source.sourceThreadId,
      expect.any(AbortSignal),
    );
    expect(policies.get).not.toHaveBeenCalled();
  });

  it.each([
    ["sourceWorkspaceId", "workspace-2"],
    ["sourceEnvironmentId", "environment-2"],
    ["backendKind", "codex_app_server"],
  ] as const)("rejects stale attached %s authority", async (field, value) => {
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus: async () => undefined },
      }),
      {
        get: vi.fn(() => {
          throw new Error("policy_must_not_be_read");
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      environmentAuthority,
      {
        resolveInScope: () => ({ ...source, [field]: value }),
      },
      approvalAuthority,
      denyApprovals,
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: `stale-${field}`,
          input: {},
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      toolError: {
        code: "permission_denied",
        message: "The agent-tool source authority changed.",
      },
    });
  });

  it.each([
    ["environment", false],
    ["unrestricted", true],
  ] as const)(
    "%s policy gates another environment before canonical execution",
    async (accessBoundary, executes) => {
      const readThreadStatus = vi.fn(async () => ({
        threadId: "thread-2",
        backend: "pi" as const,
        lifecycle: "active" as const,
        activity: "idle" as const,
      }));
      const current = new SourceScopedAgentToolService(
        new CanonicalInlineAgentToolService({
          application: { readThreadStatus },
        }),
        {
          get: () => ({
            enabled: true,
            enabledToolIds: ["thread.status"],
            presentation: {
              surface: "cli" as const,
              mode: "progressive" as const,
            },
            accessBoundary,
            revision: 4,
          }),
        } as unknown as ThreadAgentToolPolicyRepository,
        new AgentToolEnvironmentAuthorityResolver({
          resolveEnvironment: () => undefined,
          resolveWorkspace: () => undefined,
          resolveThread: (_scope, id) =>
            id === "thread-2"
              ? { id, environmentId: "environment-2", label: "Remote" }
              : undefined,
          resolveThreadFamily: () => undefined,
          resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
          listEnvironments: () => [
            {
              id: "environment-1",
              environmentId: "environment-1",
              label: "Local",
            },
            {
              id: "environment-2",
              environmentId: "environment-2",
              label: "Remote",
            },
          ],
        }),
        sourceRevalidator,
        approvalAuthority,
        denyApprovals,
      );
      const invocation = current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: `cross-environment-${accessBoundary}`,
          input: { threadId: "thread-2" },
        },
        signal: new AbortController().signal,
      });
      if (executes) {
        await expect(invocation).resolves.toMatchObject({ state: "completed" });
        expect(readThreadStatus).toHaveBeenCalledOnce();
      } else {
        await expect(invocation).rejects.toMatchObject({
          toolError: {
            code: "permission_denied",
            message: "Access outside the configured boundary was denied.",
          },
        });
        expect(readThreadStatus).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for one application approval and revalidates before execution", async () => {
    const readThreadStatus = vi.fn(async () => ({
      threadId: "thread-2",
      backend: "pi" as const,
      lifecycle: "active" as const,
      activity: "idle" as const,
    }));
    const policy = {
      enabled: true,
      enabledToolIds: ["thread.status"],
      presentation: { surface: "cli" as const, mode: "progressive" as const },
      accessBoundary: "environment" as const,
      revision: 7,
    };
    const policies = { get: vi.fn(() => policy) };
    const resolveInScope = vi.fn(() => source);
    const requestApplicationDecision = vi.fn(async () => "allow" as const);
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus },
      }),
      policies as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: () => undefined,
        resolveWorkspace: () => undefined,
        resolveThread: (_scope, id) =>
          id === "thread-2"
            ? { id, environmentId: "environment-2", label: "Remote thread" }
            : undefined,
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [
          {
            id: "environment-1",
            environmentId: "environment-1",
            label: "Local",
          },
          {
            id: "environment-2",
            environmentId: "environment-2",
            label: "Remote",
          },
        ],
      }),
      { resolveInScope },
      approvalAuthority,
      { requestApplicationDecision },
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "approved-cross-environment",
          input: { threadId: "thread-2" },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(resolveInScope).toHaveBeenCalledTimes(2);
    expect(policies.get).toHaveBeenCalledTimes(2);
    expect(requestApplicationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: expect.objectContaining({
          title: { text: "Allow Thread status?" },
          code: { text: "thread.status@2 · read" },
          message: {
            text: 'This tool wants to access Remote for Remote thread. Arguments: {"threadId":"thread-2"}.',
          },
          destructive: false,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(readThreadStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ["approval runtime", "cancelled"],
    ["source authority", "permission_denied"],
    ["thread policy", "permission_denied"],
    ["resolved environment authority", "permission_denied"],
    ["tool definition", "permission_denied"],
  ] as const)(
    "fails closed when %s changes while approval is pending",
    async (drift, expectedCode) => {
      let approved = false;
      const readThreadStatus = vi.fn(async () => ({
        threadId: "thread-2",
        backend: "pi" as const,
        lifecycle: "active" as const,
        activity: "idle" as const,
      }));
      const canonical = new CanonicalInlineAgentToolService({
        application: { readThreadStatus },
      });
      const originalGet = canonical.registry.get.bind(canonical.registry);
      vi.spyOn(canonical.registry, "get").mockImplementation((id, version) => {
        const definition = originalGet(id, version);
        return drift === "tool definition" && approved
          ? {
              ...definition,
              catalog: { ...definition.catalog, label: "Changed label" },
            }
          : definition;
      });
      const policies = {
        get: vi.fn(() => ({
          enabled: true,
          enabledToolIds: ["thread.status"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: drift === "thread policy" && approved ? 8 : 7,
        })),
      };
      const resolveInScope = vi.fn(() =>
        drift === "source authority" && approved
          ? { ...source, sourceWorkspaceId: "workspace-moved" }
          : source,
      );
      const current = new SourceScopedAgentToolService(
        canonical,
        policies as unknown as ThreadAgentToolPolicyRepository,
        new AgentToolEnvironmentAuthorityResolver({
          resolveEnvironment: () => undefined,
          resolveWorkspace: () => undefined,
          resolveThread: (_scope, id) => ({
            id,
            environmentId: "environment-2",
            workspaceId:
              drift === "resolved environment authority" && approved
                ? "workspace-remote-moved"
                : "workspace-remote",
            label: "Remote thread",
          }),
          resolveThreadFamily: () => undefined,
          resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
          listEnvironments: () => [
            {
              id: "environment-1",
              environmentId: "environment-1",
              label: "Local",
            },
            {
              id: "environment-2",
              environmentId: "environment-2",
              label: "Remote",
            },
          ],
        }),
        { resolveInScope },
        {
          acquireAgentToolApprovalAuthority: async () => ({
            generation: "generation-1",
            signal: new AbortController().signal,
            isCurrent: () => !(drift === "approval runtime" && approved),
            release: () => undefined,
          }),
        },
        {
          requestApplicationDecision: async () => {
            approved = true;
            return "allow" as const;
          },
        },
      );

      await expect(
        current.invoke({
          source,
          adapter: "cli",
          request: {
            toolId: "thread.status",
            schemaVersion: 2,
            requestId: `post-approval-${drift.replaceAll(" ", "-")}`,
            input: { threadId: "thread-2" },
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ toolError: { code: expectedCode } });
      expect(readThreadStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects canonical input drift while approval is pending", async () => {
    const input = {
      environmentId: "environment-2",
      path: "/srv/projects/sedes",
      message: "before approval",
      password: "redacted",
    };
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus: async () => undefined },
        additionalDefinitions: [crossEnvironmentWriteDefinition()],
      }),
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["example.cross_environment"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 1,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: (_scope, id) => ({
          id,
          environmentId: id,
          label: id,
        }),
        resolveWorkspace: () => undefined,
        resolveThread: () => undefined,
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [],
      }),
      sourceRevalidator,
      approvalAuthority,
      {
        requestApplicationDecision: async () => {
          input.message = "after approval";
          return "allow" as const;
        },
      },
    );

    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "example.cross_environment",
          schemaVersion: 2,
          requestId: "post-approval-input-drift",
          input,
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });

  it("shows only other environments, bounded authority arguments, and declared consequences", async () => {
    const presentations: ApplicationDecisionPresentation[] = [];
    const requestApplicationDecision = vi.fn(
      async (request: { presentation: ApplicationDecisionPresentation }) => {
        presentations.push(request.presentation);
        return "deny" as const;
      },
    );
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus: async () => undefined },
        additionalDefinitions: [crossEnvironmentWriteDefinition()],
      }),
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["example.cross_environment"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 1,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: (_scope, id) => ({
          id,
          environmentId: id,
          label: id === "environment-1" ? "Local" : "Remote",
        }),
        resolveWorkspace: () => undefined,
        resolveThread: () => undefined,
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [
          {
            id: "environment-1",
            environmentId: "environment-1",
            label: "Local",
          },
          {
            id: "environment-2",
            environmentId: "environment-2",
            label: "Remote",
          },
        ],
      }),
      sourceRevalidator,
      approvalAuthority,
      { requestApplicationDecision },
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "example.cross_environment",
          schemaVersion: 2,
          requestId: "present-cross-environment-write",
          input: {
            environmentId: "environment-2",
            path: "/srv/projects/sedes",
            message: "do not copy this free-form content",
            password: "super-secret",
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ toolError: { code: "permission_denied" } });

    const presentation = presentations[0];
    expect(presentation).toBeDefined();
    expect(presentation?.message?.text).toBe(
      'This tool wants to access Remote. Arguments: {"environmentId":"environment-2","message":"[string:34]","password":"[redacted]","path":"/srv/projects/sedes"}. This starts model work. This may create a durable external side effect.',
    );
    expect(presentation?.message?.text).not.toContain("Local, Remote");
    expect(presentation?.message?.text).not.toContain("super-secret");
    expect(presentation?.code?.text).toBe(
      "example.cross_environment@2 · write · starts model work · external side effect",
    );
  });

  it("omits the source environment from all-environment approval copy", async () => {
    const presentations: ApplicationDecisionPresentation[] = [];
    const requestApplicationDecision = vi.fn(
      async (request: { presentation: ApplicationDecisionPresentation }) => {
        presentations.push(request.presentation);
        return "deny" as const;
      },
    );
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus: async () => undefined },
        additionalDefinitions: [allEnvironmentQueryDefinition()],
      }),
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["example.all_allowed_environments"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 1,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: () => undefined,
        resolveWorkspace: () => undefined,
        resolveThread: () => undefined,
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [
          {
            id: "environment-1",
            environmentId: "environment-1",
            label: "Local",
          },
          {
            id: "environment-2",
            environmentId: "environment-2",
            label: "Remote",
          },
        ],
      }),
      sourceRevalidator,
      approvalAuthority,
      { requestApplicationDecision },
    );

    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "example.all_allowed_environments",
          schemaVersion: 2,
          requestId: "present-all-environments",
          input: { scope: { kind: "all_allowed_environments" } },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ toolError: { code: "permission_denied" } });

    expect(presentations[0]?.message?.text).toBe(
      'This tool wants to access Remote. Arguments: {"scope":{"kind":"[string:24]"}}.',
    );
  });

  it("maps exhausted approval capacity to retryable tool unavailability", async () => {
    const requestApplicationDecision = vi.fn(async () => {
      throw new DomainError("runtime_unavailable", "capacity", true);
    });
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus: vi.fn() },
      }),
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["thread.status"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 1,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: () => undefined,
        resolveWorkspace: () => undefined,
        resolveThread: () => ({
          id: "thread-2",
          environmentId: "environment-2",
        }),
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [],
      }),
      sourceRevalidator,
      approvalAuthority,
      { requestApplicationDecision },
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "approval-capacity",
          input: { threadId: "thread-2" },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      toolError: { code: "unavailable", retryable: true },
    });
  });

  it("maps broker force-reset abandonment to cancellation", async () => {
    const readThreadStatus = vi.fn();
    const current = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({
        application: { readThreadStatus },
      }),
      {
        get: () => ({
          enabled: true,
          enabledToolIds: ["thread.status"],
          presentation: {
            surface: "cli" as const,
            mode: "progressive" as const,
          },
          accessBoundary: "environment" as const,
          revision: 1,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: () => undefined,
        resolveWorkspace: () => undefined,
        resolveThread: () => ({
          id: "thread-2",
          environmentId: "environment-2",
        }),
        resolveThreadFamily: () => undefined,
        resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: () => undefined,
        listEnvironments: () => [],
      }),
      sourceRevalidator,
      approvalAuthority,
      {
        requestApplicationDecision: async () => {
          throw new DOMException(
            "The interaction request was cancelled.",
            "AbortError",
          );
        },
      },
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "approval-force-reset",
          input: { threadId: "thread-2" },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      toolError: { code: "cancelled", retryable: false },
    });
    expect(readThreadStatus).not.toHaveBeenCalled();
  });

  it.each(["progressive", "individual"] as const)(
    "re-reads live CLI %s policy for enable, grant changes, and disable",
    async (mode) => {
      const policy = {
        enabled: false,
        enabledToolIds: [] as string[],
        presentation: { surface: "cli" as const, mode },
        accessBoundary: "environment" as const,
        revision: 1,
      };
      const policies = {
        get: vi.fn(() => ({ ...policy })),
      } as unknown as ThreadAgentToolPolicyRepository;
      const current = new SourceScopedAgentToolService(
        new CanonicalInlineAgentToolService({
          application: { readThreadStatus: async () => undefined },
        }),
        policies,
        environmentAuthority,
        sourceRevalidator,
        approvalAuthority,
        denyApprovals,
      );

      const invoke = () =>
        current.invoke({
          source,
          adapter: "cli" as const,
          request: {
            toolId: "agent.context",
            schemaVersion: 2,
            requestId: "live-policy",
            input: {},
          },
          signal: new AbortController().signal,
        });
      const denied = {
        toolError: { code: "permission_denied", retryable: false },
      };
      expect(current.catalogSummaries(source, "cli")).toEqual([]);
      await expect(invoke()).rejects.toMatchObject(denied);

      policy.enabled = true;
      policy.revision++;
      expect(current.catalogSummaries(source, "cli")).toEqual([]);
      await expect(invoke()).rejects.toMatchObject(denied);

      policy.enabledToolIds = ["agent.context"];
      policy.revision++;
      expect(current.catalogSummaries(source, "cli")).toHaveLength(1);
      expect(current.describeMany(source, "cli", ["agent.context"])).toHaveLength(1);
      await expect(invoke()).resolves.toMatchObject({
        state: "completed",
        output: { threadId: source.sourceThreadId },
      });

      policy.enabledToolIds = [];
      policy.revision++;
      expect(current.catalogSummaries(source, "cli")).toEqual([]);
      expect(() => current.describeMany(source, "cli", ["agent.context"]))
        .toThrow();
      await expect(invoke()).rejects.toMatchObject(denied);

      policy.enabledToolIds = ["agent.context"];
      policy.enabled = false;
      policy.revision++;
      expect(current.catalogSummaries(source, "cli")).toEqual([]);
      await expect(invoke()).rejects.toMatchObject(denied);

      policy.enabled = true;
      policy.revision++;
      await expect(invoke()).resolves.toMatchObject({ state: "completed" });
    },
  );

  it("returns compact summaries and ordered all-or-nothing descriptions", () => {
    const current = service({ surface: "native", mode: "progressive" });
    const policyRead = vi.spyOn(current.policies, "get");
    const summaries = current.catalogSummaries(source, "pi_sdk");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "agent.context",
      label: "Agent context",
    });
    expect(summaries[0]).not.toHaveProperty("inputSchema");
    expect(summaries[0]).not.toHaveProperty("adapters");

    expect(
      current.describeMany(source, "pi_sdk", ["agent.context"]),
    ).toMatchObject([
      {
        id: "agent.context",
        execution: { waitCeilingMilliseconds: 30_000 },
      },
    ]);
    expect(policyRead).toHaveBeenCalledTimes(2);
    expect(() =>
      current.describeMany(source, "pi_sdk", [
        "agent.context",
        "thread.status",
      ]),
    ).toThrow();
  });

  it("rejects invalid description batches before catalog resolution", () => {
    const current = service({ surface: "native", mode: "progressive" });
    for (const toolIds of [
      [],
      ["agent.context", "agent.context"],
      Array.from({ length: 17 }, (_, index) => `tool.${index}`),
    ]) {
      expect(() => current.describeMany(source, "pi_sdk", toolIds)).toThrow();
    }
  });

  it("fails closed for stale Pi-native invocation in CLI presentation mode", async () => {
    const started = vi.fn();
    await expect(
      service({ surface: "cli", mode: "progressive" }).invoke({
        source,
        adapter: "pi_sdk",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "stale-native-call",
          input: {},
        },
        signal: new AbortController().signal,
        onInvocationStarted: started,
      }),
    ).rejects.toMatchObject({
      toolError: { code: "permission_denied" },
    });
    expect(started).not.toHaveBeenCalled();
  });

  it.each(["progressive", "individual"] as const)(
    "forwards Pi invocation-start correlation in native %s presentation mode",
    async (mode) => {
      const started = vi.fn();
      await expect(
        service({ surface: "native", mode }).invoke({
          source,
          adapter: "pi_sdk",
          request: {
            toolId: "agent.context",
            schemaVersion: 2,
            requestId: `native-${mode}-call`,
            input: {},
          },
          signal: new AbortController().signal,
          onInvocationStarted: started,
        }),
      ).resolves.toMatchObject({ state: "completed" });
      expect(started).toHaveBeenCalledExactlyOnceWith("invocation-1");
    },
  );

  it.each([
    ["progressive", "http"],
    ["progressive", "cli"],
    ["individual", "http"],
    ["individual", "cli"],
  ] as const)(
    "fails closed for %s presentation through the %s adapter",
    async (mode, adapter) => {
      await expect(
        service({ surface: "native", mode }).invoke({
          source,
          adapter,
          request: {
            toolId: "agent.context",
            schemaVersion: 2,
            requestId: `native-${mode}-${adapter}-call`,
            input: {},
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        toolError: { code: "permission_denied" },
      });
    },
  );

  it.each([
    ["progressive", "http"],
    ["progressive", "cli"],
    ["individual", "http"],
    ["individual", "cli"],
  ] as const)(
    "permits CLI %s presentation through the %s adapter",
    async (mode, adapter) => {
      await expect(
        service({ surface: "cli", mode }).invoke({
          source,
          adapter,
          request: {
            toolId: "agent.context",
            schemaVersion: 2,
            requestId: `cli-${adapter}-call`,
            input: {},
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ state: "completed" });
    },
  );

  const nativeAdmission = [
    ["pi", "native", "pi_sdk", true],
    ["pi", "native", "mcp", false],
    ["pi", "cli", "mcp", false],
    ["codex_app_server", "native", "mcp", true],
    ["codex_app_server", "native", "pi_sdk", false],
    ["codex_app_server", "native", "cli", false],
    ["codex_app_server", "cli", "mcp", false],
    ["claude_agent_sdk", "native", "mcp", true],
    ["claude_agent_sdk", "native", "http", false],
    ["claude_agent_sdk", "cli", "mcp", false],
    ["grok_build", "native", "mcp", false],
    ["grok_build", "native", "pi_sdk", false],
  ] as const;

  it.each(nativeAdmission)(
    "%s %s presentation admits adapter %s: %s",
    async (backendKind, surface, adapter, admitted) => {
      const caller = { ...source, backendKind };
      for (const mode of ["progressive", "individual"] as const) {
        const current = service({ surface, mode }, caller);
        expect(
          current.catalogSummaries(caller, adapter).map(({ id }) => id),
        ).toEqual(admitted ? ["agent.context"] : []);
        const invocation = current.invoke({
          source: caller,
          adapter,
          request: {
            toolId: "agent.context",
            schemaVersion: 2,
            requestId: `${backendKind}-${surface}-${mode}-${adapter}`,
            input: {},
          },
          signal: new AbortController().signal,
        });
        if (admitted) {
          await expect(invocation).resolves.toMatchObject({
            state: "completed",
          });
        } else {
          await expect(invocation).rejects.toMatchObject({
            toolError: { code: "permission_denied" },
          });
        }
      }
    },
  );

  it("never treats the HTTP invocation hop as a discovery adapter", () => {
    expect(
      service({ surface: "cli", mode: "progressive" }).catalogSummaries(
        source,
        "http",
      ),
    ).toEqual([]);
  });
});

describe("thread access boundary", () => {
  const cases = [
    { name: "source context", declaration: { kind: "source_only" }, input: {}, prompt: false },
    { name: "public research", declaration: { kind: "public_information" }, input: {}, prompt: false },
    { name: "environment directory", declaration: { kind: "installation_directory" }, input: {}, prompt: true },
    { name: "global metadata", declaration: { kind: "environment_neutral" }, input: {}, prompt: true },
    { name: "same thread", declaration: { kind: "direct_resource", resource: "thread" }, input: { threadId: "thread-1" }, prompt: false },
    { name: "sibling thread", declaration: { kind: "direct_resource", resource: "thread" }, input: { threadId: "thread-2" }, prompt: true },
    { name: "workspace", declaration: { kind: "direct_resource", resource: "workspace" }, input: { workspaceId: "workspace-1" }, prompt: true },
    ...(["task", "workpad"] as const).flatMap((resource) => [
      { name: `${resource} same thread`, declaration: { kind: "direct_resource", resource }, input: { [`${resource}Id`]: "self" }, prompt: false },
      { name: `${resource} other thread`, declaration: { kind: "direct_resource", resource }, input: { [`${resource}Id`]: "other" }, prompt: true },
      { name: `${resource} global`, declaration: { kind: "direct_resource", resource }, input: { [`${resource}Id`]: "global" }, prompt: true },
      { name: `${resource} project`, declaration: { kind: "direct_resource", resource }, input: { [`${resource}Id`]: "project" }, prompt: true },
      { name: `${resource} global query`, declaration: { kind: "scoped_query", resource }, input: { scope: { kind: "global" } }, prompt: true },
      { name: `${resource} thread query`, declaration: { kind: "scoped_query", resource }, input: { scope: { kind: "thread", threadId: "thread-1" } }, prompt: false },
      { name: `${resource} move global`, declaration: { kind: "scope_transition", resource }, input: { [`${resource}Id`]: "self", scope: { kind: "global" } }, prompt: true },
      { name: `${resource} create self`, declaration: { kind: "scope_transition", resource }, input: { scope: { kind: "thread", threadId: "thread-1" } }, prompt: false },
    ]),
  ];
  for (const backendKind of ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"] as const) {
    it.each(cases)(`${backendKind}: $name`, async ({ declaration, input, prompt }) => {
      const caller = { ...source, backendKind };
      const definition: AgentToolDefinition = {
        ...agentContextToolDefinition,
        id: "example.boundary",
        environmentAuthority: declaration as AgentToolDefinition["environmentAuthority"],
        adapters: { pi: { name: "sedes_example_boundary", label: "Boundary" }, mcp: { name: "sedes_example_boundary" }, cli: { command: "example.boundary" }, http: { invocation: "inline" } },
        inputSchema: normalizeCanonicalAgentToolSchema(Type.Object({
          taskId: Type.Optional(Type.String({ maxLength: 128 })),
          workpadId: Type.Optional(Type.String({ maxLength: 128 })),
          threadId: Type.Optional(Type.String({ maxLength: 128 })),
          workspaceId: Type.Optional(Type.String({ maxLength: 128 })),
          scope: Type.Optional(Type.Object({ kind: Type.String({ maxLength: 32 }), threadId: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false, maxProperties: 2 })),
        }, { $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT, additionalProperties: false, maxProperties: 5 })),
      };
      const fact = (_scope: unknown, id: string) => ({ id, revision: 1,
        scopeKind: id === "global" ? "global" as const : id === "project" ? "workspace" as const : "thread" as const,
        ...(id === "global" ? {} : { environmentId: source.sourceEnvironmentId }),
        ...(id === "self" || id === "other" ? { threadId: id === "self" ? source.sourceThreadId : "thread-2" } : {}),
      });
      const requestApplicationDecision = vi.fn(async () => "deny" as const);
      const service = new SourceScopedAgentToolService(
        new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined }, additionalDefinitions: [definition] }),
        { get: () => ({ enabled: true, enabledToolIds: [definition.id], presentation: { surface: "cli", mode: "progressive" }, accessBoundary: "thread", revision: 1 }) } as unknown as ThreadAgentToolPolicyRepository,
        new AgentToolEnvironmentAuthorityResolver({
          ...environmentAuthority.reader,
          resolveThread: (_scope, id) => ({ id, environmentId: source.sourceEnvironmentId }),
          resolveWorkspace: (_scope, id) => ({ id, environmentId: source.sourceEnvironmentId }),
          resolveTask: fact, resolveWorkpad: fact,
        }),
        { resolveInScope: () => caller }, approvalAuthority, { requestApplicationDecision },
      );
      const result = service.invoke({ source: caller, adapter: "cli", request: { toolId: definition.id, schemaVersion: definition.schemaVersion, requestId: "boundary", input }, signal: new AbortController().signal });
      if (prompt) await expect(result).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
      else await expect(result).resolves.toMatchObject({ state: "completed" });
      expect(requestApplicationDecision).toHaveBeenCalledTimes(prompt ? 1 : 0);
    });
  }
});

it.each(["saved_agent", "task", "workpad"] as const)(
  "revalidates %s revision after a same-environment thread-boundary approval",
  async (resource) => {
    let revision = 1;
    const definition = {
      ...crossEnvironmentWriteDefinition(),
      environmentAuthority: { kind: "direct_resource" as const, resource, inputField: "environmentId" },
    };
    const requestApplicationDecision = vi.fn(async () => {
      revision += 1;
      return "allow" as const;
    });
    const service = new SourceScopedAgentToolService(
      new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined }, additionalDefinitions: [definition] }),
      { get: () => ({ enabled: true, enabledToolIds: [definition.id], presentation: { surface: "cli", mode: "progressive" }, accessBoundary: "thread", revision: 1 }) } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        ...environmentAuthority.reader,
        resolveSavedAgent: (_scope, id) => ({ id, revision }),
        resolveTask: (_scope, id) => ({ id, revision, scopeKind: "global" }),
        resolveWorkpad: (_scope, id) => ({ id, revision, scopeKind: "global" }),
      }),
      sourceRevalidator, approvalAuthority, { requestApplicationDecision },
    );
    await expect(service.invoke({ source, adapter: "cli", request: {
      toolId: definition.id, schemaVersion: definition.schemaVersion, requestId: "stale-resource",
      input: { environmentId: "target", path: "/example", message: "edit", password: "unused" },
    }, signal: new AbortController().signal })).rejects.toMatchObject({
      toolError: { code: "permission_denied", message: "The access request changed while approval was pending." },
    });
    expect(requestApplicationDecision).toHaveBeenCalledOnce();
  },
);
