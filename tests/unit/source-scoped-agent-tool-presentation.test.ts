import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";
import { describe, expect, it, vi } from "vitest";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import type { AgentToolPresentation } from "../../src/shared/index.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { createSavedAgentDeleteToolDefinition } from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";

const source = Object.freeze({
  scope: { tenantId: "tenant", principalId: "principal" },
  sourceThreadId: "thread-1",
  sourceWorkspaceId: "workspace-1",
  sourceEnvironmentId: "environment-1",
  backendKind: "pi" as const,
});

const environmentAuthority = new AgentToolEnvironmentAuthorityResolver({
  resolveProject: () => undefined,
  resolveWorkspaceProject: () => "project-1",
  resolveEnvironment: () => undefined,
  resolveWorkspace: () => undefined,
  resolveAutomation: () => undefined,
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
      resourceScope: {allowOtherEnvironments:false,allowOtherProjects:true} as const,
      revision: 1,
    }),
  } as unknown as ThreadAgentToolPolicyRepository;
  return new SourceScopedAgentToolService(
    canonical,
    policies,
    environmentAuthority,
    { resolveInScope: () => caller }, testAgentToolExecutionAuthority,
  );
}

describe("SourceScopedAgentToolService presentation", () => {
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
          resourceScope: {allowOtherEnvironments:false,allowOtherProjects:true} as const,
          revision: 3,
        }),
      } as unknown as ThreadAgentToolPolicyRepository,
      environmentAuthority,
      sourceRevalidator, testAgentToolExecutionAuthority,
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
        resourceScope: {allowOtherEnvironments:true,allowOtherProjects:true} as const,
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
      { resolveInScope }, testAgentToolExecutionAuthority,
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "agent.context",
          schemaVersion: 4,
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
      }, testAgentToolExecutionAuthority,
    );
    await expect(
      current.invoke({
        source,
        adapter: "cli",
        request: {
          toolId: "agent.context",
          schemaVersion: 4,
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

  it.each(["progressive", "individual"] as const)(
    "re-reads live CLI %s policy for enable, grant changes, and disable",
    async (mode) => {
      const policy = {
        enabled: false,
        enabledToolIds: [] as string[],
        presentation: { surface: "cli" as const, mode },
        resourceScope: {allowOtherEnvironments:false,allowOtherProjects:true} as const,
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
        sourceRevalidator, testAgentToolExecutionAuthority,
      );

      const invoke = () =>
        current.invoke({
          source,
          adapter: "cli" as const,
          request: {
            toolId: "agent.context",
            schemaVersion: 4,
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
          schemaVersion: 4,
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
            schemaVersion: 4,
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
            schemaVersion: 4,
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
            schemaVersion: 4,
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
            schemaVersion: 4,
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
