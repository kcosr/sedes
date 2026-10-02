import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolCliRequest } from "../../src/internal/agent-tool-cli-protocol/index.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { registerSidecarAgentToolRelayOperations } from "../../src/server/agent-tools/sidecar/sidecar-agent-tool-relay.js";
import { captureOpenCodeInvocation, type OpenCodeToolInvocationStamp } from "../../src/server/backends/opencode/opencode-tool-invocation.js";
import { relayAgentToolCliRequest, relayAgentToolRequest } from "../../src/server/sidecar/agent-tool-request-relay.js";
import { SidecarRuntimeAttachment } from "../../src/server/sidecar/sidecar-runtime-attachment.js";
import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const source: TrustedAgentToolSource = { scope: { tenantId: "tenant", principalId: "principal" },
  sourceThreadId: "thread", sourceWorkspaceId: "workspace", sourceEnvironmentId: "environment", backendKind: "opencode" };
const stamp: OpenCodeToolInvocationStamp = { authority: { ...source.scope, executionEnvironmentId: "environment",
  backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation", directory: "/workspace",
  session: { applicationThreadId: "thread", nativeSessionID: "ses_fixture", bindingFingerprint: "binding" } },
  journalId: "journal", throughSequence: 1, nativeContinuity: "continuity", inputId: "msg_input", authorityEpoch: 1, nativeConnected: true };
function request(): AgentToolCliRequest {
  return { protocolVersion: 3, requestId: randomUUID(), sourceCapability: "source-capability-1234567890abcdefghijklmnop",
    operation: { type: "invoke", request: { toolId: "agent.context", schemaVersion: 3, requestId: randomUUID(), input: {} } } };
}
async function fixture(presentation: "mcp" | "cli" = "mcp", openCodeTools = true) {
  const attachment = new SidecarRuntimeAttachment();
  let epoch = 0;
  const invoke = vi.fn(async (_value: unknown) => ({ invocationId: "invocation", state: "completed" as const, output: { ok: true } }));
  const tools: BackendAgentToolFacade = {
    eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [],
    readPolicy: () => ({ enabled: true, presentation: { surface: presentation === "mcp" ? "native" : "cli", mode: "progressive" }, accessBoundary: "environment", enabledToolIds: ["agent.context"] }),
    invoke: <Output>(input: unknown) => invoke(input) as Promise<SedesToolInvocationResult<Output>>,
  };
  const resolve = vi.fn(async () => {
    await Promise.resolve();
    expect(captureOpenCodeInvocation()).toEqual(stamp);
    return { source, presentation };
  });
  const connect = async () => {
    const carrier = await createSidecarFramedCarrier(); cleanups.push(() => carrier.close());
    registerSidecarAgentToolRelayOperations(carrier.mainRegistry, {
      authority: { scope: source.scope, executionEnvironmentId: "environment" },
      sources: { resolveCapabilityInExecutionEnvironment: resolve }, tools, openCodeTools,
    });
    await carrier.start({ prepareSedesCapabilities: () => ({ endpoint: "unix:///fixture/agent-tools.sock",
      executableDirectory: "/fixture/bin", inheritedPath: "/usr/bin" }) }); attachment.replace(carrier.hostPeer, ++epoch); attachment.ready(epoch);
    return carrier;
  };
  await connect();
  const capture = vi.fn(() => stamp);
  return { attachment, connect, invoke, resolve, capture,
    call: () => presentation === "cli" ? relayAgentToolCliRequest(attachment, request(), new AbortController().signal, capture)
      : relayAgentToolRequest(attachment, request(), new AbortController().signal, stamp),
    detach: () => attachment.detach(epoch) };
}

describe("OpenCode private tool relay over production framing", () => {
  it.each(["mcp", "cli"] as const)("gives an upgrade instruction for a missing private %s route without using generic invoke", async presentation => {
    const f = await fixture(presentation, false);
    await expect(f.call()).rejects.toMatchObject({ toolError: { code: "unavailable", retryable: false,
      message: expect.stringContaining("Upgrade and reconnect") } });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(["mcp", "cli"] as const)("carries immutable native authority beside canonical %s input", async presentation => {
    const f = await fixture(presentation);
    f.invoke.mockImplementationOnce(async input => {
      await Promise.resolve(); expect(captureOpenCodeInvocation()).toEqual(stamp);
      expect(input).toMatchObject({ source, adapter: presentation, request: { toolId: "agent.context", input: {} } });
      return { invocationId: "invocation", state: "completed", output: { ok: true } };
    });
    const pending = f.call();
    if (presentation === "cli") expect(f.capture).toHaveBeenCalledOnce();
    expect(f.resolve).not.toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({ type: "invoke", value: { state: "completed", output: { ok: true } } });
    expect(f.invoke).toHaveBeenCalledOnce(); expect(captureOpenCodeInvocation()).toBeUndefined();
  });

  it("reports lost replies as uncertain and never replays them after replacement", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.invoke.mockImplementationOnce(async () => {
      entered(); await held;
      return { invocationId: "invocation", state: "completed", output: { ok: true } };
    });
    const result = f.call().catch(error => error);
    await running; f.detach();
    expect(await result).toMatchObject({ toolError: { code: "uncertain_outcome", retryable: false } });
    await expect(f.call()).rejects.toMatchObject({ toolError: { code: "unavailable", retryable: true } });
    expect(f.invoke).toHaveBeenCalledOnce();
    await f.connect(); release(); await Promise.resolve();
    expect(f.invoke).toHaveBeenCalledOnce();
    await expect(f.call()).resolves.toMatchObject({ type: "invoke", value: { state: "completed" } });
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
});
