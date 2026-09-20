import { describe, expect, it, vi } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  AttachConversationInput,
} from "../../src/server/backends/contracts.js";
import { ClaudeBackendDriverFactory } from "../../src/server/backends/claude/claude-driver-factory.js";
import type { ClaudeRuntimeClient } from "../../src/server/backends/claude/claude-runtime-client.js";
import type { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const sessionId = "11111111-1111-4111-8111-111111111111";
const instance: AgentBackendInstance = {
  id: "claude-backend",
  tenantId: scope.tenantId,
  kind: "claude_agent_sdk",
  label: "Claude",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.3.274",
};
const agentTools: BackendAgentToolFacade = {
  eligibleCatalog: () => [],
  catalogSummaries: () => [],
  describeMany: () => [],
  readPolicy: () => ({
    enabled: false,
    presentation: { surface: "cli", mode: "progressive" },
    accessBoundary: "environment",
    enabledToolIds: [],
  }),
  invoke: async () => {
    throw new Error("claude_factory_agent_tool_invocation_unexpected");
  },
};

function connection(id: string): AgentConnectionProfile {
  return {
    id,
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    templateId: `${id}-template`,
    kind: "claude_agent_sdk",
    backendInstanceId: instance.id,
    executionEnvironmentId: "environment-1",
    label: id,
    enabled: true,
    configurationRevision: 1,
  };
}

function attachInput(
  selected: AgentConnectionProfile,
  applicationThreadId: string,
): AttachConversationInput {
  return {
    scope,
    binding: {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId,
      backendInstanceId: instance.id,
      connectionProfileId: selected.id,
      executionEnvironmentId: selected.executionEnvironmentId,
      backendConversationId: sessionId,
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    workspace: {
      authorityRevision: 1,
      summary: {
        id: "workspace-1",
        environmentId: selected.executionEnvironmentId,
        displayName: "Workspace",
        displayPath: "/workspace",
        availability: "available",
        trustState: "trusted",
        revision: 1,
      },
      canonicalPath: "/workspace",
    },
    opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
  };
}

describe("ClaudeBackendDriverFactory", () => {
  it("claims one native session across profiles and releases a failed claim", async () => {
    const pending: Array<{ readonly reject: (error: Error) => void }> = [];
    const getSessionInfo = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          pending.push({ reject });
        }),
    );
    const runtimeClient = { getSessionInfo } as unknown as ClaudeRuntimeClient;
    const firstConnection = connection("claude-first");
    const secondConnection = connection("claude-second");
    const factory = new ClaudeBackendDriverFactory({
      scope,
      instance,
      runtimeClient,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      probeDirectory: "/operator/.claude",
      settings: {} as ClaudeThreadRepository,
      permissionPolicy: { allowedModes: ["default"] },
      modelPolicy: compileBackendModelPolicy(
        { type: "catalog" },
        "model_effort",
      ),
      attachmentProvenanceKey: new Uint8Array(32),
      connections: [firstConnection, secondConnection],
      agentToolCli: {
        availability: "unavailable",
        reason: "cli_unavailable",
      },
      agentToolSourceCapabilities: {
        issue: () => "htr2_" + "a".repeat(64),
      },
      agentTools,
      toolProvenanceKey: new Uint8Array(32),
      childEnvironment: {},
    });
    const firstDriver = factory.create(firstConnection);
    const secondDriver = factory.create(secondConnection);

    const firstAttach = firstDriver.attach(
      attachInput(firstConnection, "thread-first"),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await expect(
      secondDriver.attach(attachInput(secondConnection, "thread-second")),
    ).rejects.toMatchObject({
      category: "unavailable",
      safeMessage: "The Claude session is already attached.",
    });
    expect(getSessionInfo).toHaveBeenCalledOnce();

    pending[0]!.reject(new Error("first attach failed"));
    await expect(firstAttach).rejects.toMatchObject({
      category: "unavailable",
    });

    const retry = secondDriver.attach(
      attachInput(secondConnection, "thread-second"),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.reject(new Error("retry attach failed"));
    await expect(retry).rejects.toMatchObject({ category: "unavailable" });
    await factory.close();
  });
});
