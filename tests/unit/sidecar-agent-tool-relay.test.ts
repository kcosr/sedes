import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
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
import { DatabaseAgentToolSourceAuthority, type EnvironmentScopedAgentToolSourceResolver } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { registerSidecarAgentToolRelayOperations } from "../../src/server/agent-tools/sidecar/sidecar-agent-tool-relay.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { captureOpenCodeInvocation, type OpenCodeToolInvocationStamp } from "../../src/server/backends/opencode/opencode-tool-invocation.js";

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
  options: { readonly source?: TrustedAgentToolSource; readonly openCodeTools?: boolean; readonly sources?: EnvironmentScopedAgentToolSourceResolver } = {},
) {
  const sources = options.sources ?? {
    resolveCapabilityInExecutionEnvironment: vi.fn(() => ({
      source: options.source ?? source,
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
    openCodeTools: options.openCodeTools,
  });
  return { registry, sources, tools, invoke };
}

function context(signal = new AbortController().signal) {
  return { requestId: randomUUID(), signal };
}

describe("sidecar agent-tool relay", () => {
  it("registers private OpenCode invocation only when explicitly authorized", () => {
    expect(fixture().registry.resolve(openCodeToolInvokeOperation)).toBeUndefined();
    expect(fixture({}, "cli", { openCodeTools: true }).registry.resolve(openCodeToolInvokeOperation)).toBeDefined();
  });

  it.each(["cli", "mcp"] as const)("keeps the host stamp through canonical source resolution and async %s facade execution", async presentation => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE workspaces (tenant_id TEXT, owner_principal_id TEXT, environment_id TEXT, id TEXT, removed_at INTEGER);
      CREATE TABLE agent_backend_instances (tenant_id TEXT, id TEXT, kind TEXT);
      CREATE TABLE application_threads (tenant_id TEXT, owner_principal_id TEXT, environment_id TEXT, workspace_id TEXT, backend_instance_id TEXT, id TEXT);
      CREATE TABLE thread_principal_state (tenant_id TEXT, principal_id TEXT, thread_id TEXT, inventory_state TEXT);
    `);
    database.prepare("INSERT INTO workspaces VALUES (?,?,?,?,NULL)").run(scope.tenantId, scope.principalId, environmentId, "workspace-1");
    database.prepare("INSERT INTO agent_backend_instances VALUES (?,?,?)").run(scope.tenantId, "backend-1", "opencode");
    database.prepare("INSERT INTO application_threads VALUES (?,?,?,?,?,?)").run(scope.tenantId, scope.principalId, environmentId, "workspace-1", "backend-1", sourceThreadId);
    database.prepare("INSERT INTO thread_principal_state VALUES (?,?,?,?)").run(scope.tenantId, scope.principalId, sourceThreadId, "active");
    const captured: (OpenCodeToolInvocationStamp | undefined)[] = [];
    const accessDecisionAuthority = { acquire: vi.fn() };
    const authority = new DatabaseAgentToolSourceAuthority(database, new Uint8Array(32).fill(7), () => {
      captured.push(captureOpenCodeInvocation()); return accessDecisionAuthority;
    });
    const nativeSource = { ...source, backendKind: "opencode" as const };
    const capability = authority.issue(nativeSource, "execution_environment_sidecar", presentation);
    const sources: EnvironmentScopedAgentToolSourceResolver = { resolveCapabilityInExecutionEnvironment: async (...args) => {
      captured.push(captureOpenCodeInvocation()); await Promise.resolve();
      return authority.resolveCapabilityInExecutionEnvironment(...args);
    } };
    const invoke = vi.fn(async (input: Parameters<BackendAgentToolFacade["invoke"]>[0]) => {
      await Promise.resolve(); captured.push(captureOpenCodeInvocation());
      expect(input).toMatchObject({ source: nativeSource, adapter: presentation, accessDecisionAuthority });
      return { invocationId: "invocation-1", state: "completed" as const, output: {} };
    });
    const current = fixture({ invoke: <Output>(input: Parameters<BackendAgentToolFacade["invoke"]>[0]) =>
      invoke(input) as Promise<SedesToolInvocationResult<Output>> }, presentation, { sources, openCodeTools: true });
    const stamp = openCodeStamp();
    try {
      await expect(current.registry.resolve(openCodeToolInvokeOperation)!.handler({ stamp,
        request: { ...toolRequest(), sourceCapability: capability } }, context())).resolves.toMatchObject({ outcome: "ok" });
      expect(captured).toHaveLength(3);
      for (const value of captured) { expect(value).toEqual(stamp); expect(Object.isFrozen(value)).toBe(true); }
      expect(captureOpenCodeInvocation()).toBeUndefined();
      expect(accessDecisionAuthority.acquire).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it.each(["thread", "tenant", "principal", "environment", "backend"] as const)("rejects mismatched %s authority before even a read-only OpenCode invocation", async field => {
    const stamp = openCodeStamp();
    const mismatched: TrustedAgentToolSource = { ...source, backendKind: "opencode",
      ...(field === "thread" ? { sourceThreadId: randomUUID() } : {}),
      ...(field === "tenant" ? { scope: { ...scope, tenantId: "other" } } : {}),
      ...(field === "principal" ? { scope: { ...scope, principalId: "other" } } : {}),
      ...(field === "environment" ? { sourceEnvironmentId: "other-environment" } : {}),
      ...(field === "backend" ? { backendKind: "codex_app_server" } : {}) };
    const current = fixture({}, "cli", { source: mismatched, openCodeTools: true });
    await expect(current.registry.resolve(openCodeToolInvokeOperation)!.handler({ stamp, request: toolRequest() }, context()))
      .resolves.toMatchObject({ outcome: "error", error: { code: "permission_denied", retryable: false } });
    expect(current.invoke).not.toHaveBeenCalled(); expect(captureOpenCodeInvocation()).toBeUndefined();
  });

  it("isolates concurrent reverse invocations while one source resolution is suspended", async () => {
    const first = openCodeStamp(), second = { ...openCodeStamp(), inputId: "msg_other",
      authority: { ...openCodeStamp().authority, session: { ...openCodeStamp().authority.session, applicationThreadId: randomUUID() } } };
    let entered!: () => void, release!: () => void;
    const resolving = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const resolvedStamps: string[] = [], invokedStamps: string[] = [];
    const sources: EnvironmentScopedAgentToolSourceResolver = { resolveCapabilityInExecutionEnvironment: async (_scope, _environment, capability) => {
      if (capability === sourceCapability) { entered(); await held; }
      const stamp = captureOpenCodeInvocation()!; resolvedStamps.push(stamp.inputId!);
      return { source: { ...source, backendKind: "opencode", sourceThreadId: capability === sourceCapability
        ? first.authority.session.applicationThreadId : second.authority.session.applicationThreadId }, presentation: "cli" };
    } };
    const current = fixture({ invoke: async <Output>(input: Parameters<BackendAgentToolFacade["invoke"]>[0]) => {
      await Promise.resolve(); const stamp = captureOpenCodeInvocation()!;
      expect(stamp.authority.session.applicationThreadId).toBe(input.source.sourceThreadId); invokedStamps.push(stamp.inputId!);
      return { invocationId: randomUUID(), state: "completed", output: {} as Output };
    } }, "cli", { sources, openCodeTools: true });
    const handler = current.registry.resolve(openCodeToolInvokeOperation)!.handler;
    const firstCall = handler({ stamp: first, request: toolRequest() }, context());
    await resolving;
    try {
      await expect(handler({ stamp: second, request: { ...toolRequest(), sourceCapability: `${sourceCapability}-other` } }, context())).resolves.toMatchObject({ outcome: "ok" });
      expect(resolvedStamps).toEqual(["msg_other"]); expect(captureOpenCodeInvocation()).toBeUndefined();
    } finally { release(); }
    await expect(firstCall).resolves.toMatchObject({ outcome: "ok" });
    expect(resolvedStamps).toEqual(["msg_other", "msg_current"]); expect(invokedStamps).toEqual(resolvedStamps);
  });

  it("rejects unstamped OpenCode invocation while leaving its catalog and other backends available", async () => {
    const current = fixture({}, "cli", { source: { ...source, backendKind: "opencode" }, openCodeTools: true });
    await expect(current.registry.resolve(agentToolsInvokeOperation)!.handler(toolRequest(), context()))
      .resolves.toMatchObject({ outcome: "error", error: { code: "permission_denied" } });
    expect(current.invoke).not.toHaveBeenCalled();
    await expect(current.registry.resolve(agentToolsCatalogOperation)!.handler({ sourceCapability }, context()))
      .resolves.toMatchObject({ outcome: "ok" });
    const generic = fixture({}, "mcp", { openCodeTools: true });
    await expect(generic.registry.resolve(agentToolsInvokeOperation)!.handler(toolRequest(), context())).resolves.toMatchObject({ outcome: "ok" });
    expect(generic.invoke).toHaveBeenCalledOnce(); expect(captureOpenCodeInvocation()).toBeUndefined();
  });

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

function toolRequest() { return { sourceCapability, toolId: "agent.context", schemaVersion: 2, requestId: "read-only-request", input: {} }; }
function openCodeStamp(): OpenCodeToolInvocationStamp {
  return { authority: { ...scope, executionEnvironmentId: environmentId, backendInstanceId: "backend-1", runtimeId: "runtime", nativeGeneration: "generation",
    directory: "/workspace", session: { applicationThreadId: sourceThreadId, nativeSessionID: "ses_source", bindingFingerprint: "b".repeat(64) } },
    journalId: "journal", throughSequence: 1, nativeContinuity: "continuity", inputId: "msg_current", authorityEpoch: 1, nativeConnected: true };
}
