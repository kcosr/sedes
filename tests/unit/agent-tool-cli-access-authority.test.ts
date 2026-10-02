import { describe, expect, it, vi } from "vitest";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import type { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { SidecarOperationRegistry, agentToolsInvokeOperation } from "../../src/internal/sidecar-protocol/index.js";
import { registerSidecarAgentToolRelayOperations } from "../../src/server/agent-tools/sidecar/sidecar-agent-tool-relay.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { captureOpenCodeInvocation, type OpenCodeToolInvocationStamp } from "../../src/server/backends/opencode/opencode-tool-invocation.js";

const source: TrustedAgentToolSource = { scope: { tenantId: "tenant", principalId: "principal" }, sourceThreadId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
  sourceWorkspaceId: "workspace", sourceEnvironmentId: "local", backendKind: "opencode" };
const request = { toolId: "agent.context", schemaVersion: 3, requestId: "f4c1d10a-ef92-4114-b2b1-2d80f8c509df", input: {} };
describe("CLI trusted access-decision provenance", () => {
  it("forwards only the server-resolved hook through management HTTP", async () => {
    const accessDecisionAuthority = { acquire: vi.fn() };
    const invoke = vi.fn(async (_input: unknown) => ({ invocationId: "invocation", state: "completed" as const, output: {} }));
    const service = new PolicyCheckedAgentToolHttpService({ invoke } as unknown as SourceScopedAgentToolService);
    const signal = new AbortController().signal;
    await service.invoke({ source, presentation: "cli", accessDecisionAuthority }, request, signal);
    expect(invoke).toHaveBeenCalledWith({ source, adapter: "http", request, signal, accessDecisionAuthority });
    invoke.mockClear();
    await service.invoke({ source: { ...source, backendKind: "claude_agent_sdk" }, presentation: "cli" }, request, signal);
    expect(invoke.mock.calls[0]![0]).not.toHaveProperty("accessDecisionAuthority");
  });
  it("preserves the server-resolved hook through the stamped OpenCode relay and rejects unstamped invoke", async () => {
    const accessDecisionAuthority = { acquire: vi.fn() };
    const invoke = vi.fn(async (_input: unknown) => ({ invocationId: "invocation", state: "completed" as const, output: {} }));
    const registry = new SidecarOperationRegistry();
    const stamp: OpenCodeToolInvocationStamp = { authority: { ...source.scope, executionEnvironmentId: source.sourceEnvironmentId,
      backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation", directory: "/workspace",
      session: { applicationThreadId: source.sourceThreadId, nativeSessionID: "ses_fixture", bindingFingerprint: "binding" } },
      journalId: "journal", throughSequence: 1, nativeContinuity: "continuity", inputId: "msg_input", authorityEpoch: 1, nativeConnected: true };
    registerSidecarAgentToolRelayOperations(registry, {
      authority: { scope: source.scope, executionEnvironmentId: source.sourceEnvironmentId },
      sources: { resolveCapabilityInExecutionEnvironment: () => ({ source, presentation: "cli", accessDecisionAuthority }) },
      tools: { invoke } as unknown as BackendAgentToolFacade,
      openCodeTools: true,
    });
    const signal = new AbortController().signal;
    await expect(registry.resolve(agentToolsInvokeOperation)!.handler({ ...request, sourceCapability: "reference" }, { requestId: "relay-request", signal }))
      .resolves.toMatchObject({ outcome: "error", error: { code: "permission_denied" } });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockImplementationOnce(async () => {
      expect(captureOpenCodeInvocation()).toEqual(stamp);
      return { invocationId: "invocation", state: "completed", output: {} };
    });
    await registry.resolve(openCodeToolInvokeOperation)!.handler({ stamp, request: { ...request, sourceCapability: "reference" } }, { requestId: "relay-request", signal });
    expect(invoke).toHaveBeenCalledWith({ source, adapter: "cli", request, signal, accessDecisionAuthority });
  });
});
