import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  agentToolsCatalogOperation,
  agentToolsDescribeOperation,
  agentToolsInvokeOperation,
  SidecarOperationRegistry,
} from "../../src/internal/sidecar-protocol/index.js";
import {
  BackendAgentToolRequestError,
  type BackendAgentToolFacade,
  type TrustedAgentToolSource,
} from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { EnvironmentScopedAgentToolSourceResolver } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { registerSidecarAgentToolRelayOperations } from "../../src/server/agent-tools/sidecar/sidecar-agent-tool-relay.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  principalId: "principal-1",
});
const environmentId = "environment-1";
const sourceThreadId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const sourceCapability = "source-capability-1234567890abcdefghijklmnop";
const source: TrustedAgentToolSource = Object.freeze({
  scope,
  sourceThreadId,
  sourceWorkspaceId: "workspace-1",
  sourceEnvironmentId: environmentId,
  backendKind: "codex_app_server",
});

function fixture(
  overrides: Partial<BackendAgentToolFacade> = {},
  presentation: "cli" | "mcp" = "cli",
) {
  const sources = {
    resolveCapabilityInExecutionEnvironment: vi.fn(() => ({
      source,
      presentation,
    })),
  } satisfies EnvironmentScopedAgentToolSourceResolver;
  const invoke = vi.fn(async (_input: unknown) => ({
    invocationId: "invocation-1",
    state: "completed" as const,
    output: { threadId: sourceThreadId },
  }));
  const tools: BackendAgentToolFacade = Object.assign(
    {
      eligibleCatalog: vi.fn(() => []),
      catalogSummaries: vi.fn(() => [
        {
          id: "agent.context",
          schemaVersion: 2,
          label: "Agent context",
          description: "Context",
          group: { id: "context" as const, order: 10 },
          effects: {
            application: "read" as const,
            modelUsage: "none" as const,
            external: "none" as const,
          },
        },
      ]),
      describeMany: vi.fn(() => []),
      readPolicy: vi.fn(() => ({
        enabled: true,
        presentation: { surface: "cli" as const, mode: "progressive" as const },
        accessBoundary: "environment" as const,
        enabledToolIds: ["agent.context"],
      })),
      invoke: <Output = unknown>(input: unknown) =>
        invoke(input) as Promise<SedesToolInvocationResult<Output>>,
    } satisfies BackendAgentToolFacade,
    overrides,
  );
  const registry = new SidecarOperationRegistry();
  registerSidecarAgentToolRelayOperations(registry, {
    authority: { scope, executionEnvironmentId: environmentId },
    sources,
    tools,
  });
  return { registry, sources, tools, invoke };
}

function context(signal = new AbortController().signal) {
  return { requestId: randomUUID(), signal };
}

describe("sidecar agent-tool relay", () => {
  it("derives source authority from the sidecar scope and uses the CLI catalog", async () => {
    const current = fixture();
    const result = await current.registry
      .resolve(agentToolsCatalogOperation)!
      .handler({ sourceCapability }, context());
    expect(result).toMatchObject({
      outcome: "ok",
      tools: [{ id: "agent.context" }],
    });
    expect(
      current.sources.resolveCapabilityInExecutionEnvironment,
    ).toHaveBeenCalledWith(
      scope,
      environmentId,
      sourceCapability,
      expect.any(AbortSignal),
    );
    expect(current.tools.catalogSummaries).toHaveBeenCalledWith(source, "cli");
  });

  it("forwards closed description and invocation requests through adapter cli", async () => {
    const current = fixture();
    await current.registry
      .resolve(agentToolsDescribeOperation)!
      .handler({ sourceCapability, toolIds: ["agent.context"] }, context());
    expect(current.tools.describeMany).toHaveBeenCalledWith(source, "cli", [
      "agent.context",
    ]);

    const request = {
      sourceCapability,
      toolId: "agent.context",
      schemaVersion: 2,
      requestId: "tool-request-1",
      input: {},
    };
    const signal = new AbortController().signal;
    await expect(
      current.registry
        .resolve(agentToolsInvokeOperation)!
        .handler(request, context(signal)),
    ).resolves.toMatchObject({
      outcome: "ok",
      result: { state: "completed" },
    });
    expect(current.invoke).toHaveBeenCalledWith({
      source,
      adapter: "cli",
      request: {
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "tool-request-1",
        input: {},
      },
      signal,
    });
  });

  it("uses adapter mcp for every operation when the reference names MCP", async () => {
    const current = fixture({}, "mcp");
    await current.registry
      .resolve(agentToolsCatalogOperation)!
      .handler({ sourceCapability }, context());
    expect(current.tools.catalogSummaries).toHaveBeenCalledWith(source, "mcp");
    await current.registry
      .resolve(agentToolsDescribeOperation)!
      .handler({ sourceCapability, toolIds: ["agent.context"] }, context());
    expect(current.tools.describeMany).toHaveBeenCalledWith(source, "mcp", [
      "agent.context",
    ]);
    await current.registry.resolve(agentToolsInvokeOperation)!.handler(
      {
        sourceCapability,
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "tool-request-1",
        input: {},
      },
      context(),
    );
    expect(current.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ source, adapter: "mcp" }),
    );
  });

  it("preserves safe facade errors and hides unexpected failures", async () => {
    const denied = fixture({
      describeMany: vi.fn(() => {
        throw new BackendAgentToolRequestError({
          code: "not_found",
          message: "The requested tool is unavailable.",
          retryable: false,
        });
      }),
    });
    await expect(
      denied.registry
        .resolve(agentToolsDescribeOperation)!
        .handler({ sourceCapability, toolIds: ["agent.context"] }, context()),
    ).resolves.toEqual({
      outcome: "error",
      error: {
        code: "not_found",
        message: "The requested tool is unavailable.",
        retryable: false,
      },
    });

    const failed = fixture({
      catalogSummaries: vi.fn(() => {
        throw new Error("database path and secret detail");
      }),
    });
    await expect(
      failed.registry
        .resolve(agentToolsCatalogOperation)!
        .handler({ sourceCapability }, context()),
    ).resolves.toEqual({
      outcome: "error",
      error: {
        code: "internal_error",
        message: "The agent-tool request failed.",
        retryable: false,
      },
    });
  });

  it("fails a cancelled reverse request before facade execution", async () => {
    const current = fixture();
    const controller = new AbortController();
    controller.abort(new Error("remote_cli_closed"));
    await expect(
      current.registry
        .resolve(agentToolsCatalogOperation)!
        .handler({ sourceCapability }, context(controller.signal)),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "cancelled" },
    });
    expect(current.tools.catalogSummaries).not.toHaveBeenCalled();
  });
});
