import { describe, expect, it, vi } from "vitest";
import { PiNativeAgentToolService } from "../../src/server/backends/pi/native/agent-tools.js";
import type { PiNativePort, PiNativeAttachment, PiNativeHistory } from "../../src/server/backends/pi/native/port.js";
import type { PiManagedEvent } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import type { AttachConversationInput } from "../../src/server/backends/contracts.js";
import type { BackendAgentToolFacade, BackendAgentToolPolicy, BackendAgentToolInvocationInput } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import { createClientControlToolDefinitions } from "../../src/server/agent-tools/tools/client-control-tools.js";
import type { AgentToolDescription, AgentToolDefinition, SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import type { AgentToolCliAvailability, AgentToolCliRuntimeResolution } from "../../src/server/backends/module.js";
import { BackendAgentToolRequestError, type BackendAgentToolAccessDecisionAuthority } from "../../src/server/agent-tools/adapters/backend-facade.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const attachment: PiNativeAttachment = { sessionId: "native-session", sessionFile: "/sessions/native.jsonl", cwd: "/workspace",
  handleId: "handle", generation: "generation", throughSequence: 0, retainedAfterSequence: 0, retainedOperationIds: [] };
const conversation = { scope, binding: { applicationThreadId: "thread" },
  workspace: { summary: { id: "workspace", environmentId: "environment" } } } as AttachConversationInput;
const call = (id = "request", assistantEntryId = "assistant"): Extract<PiManagedEvent, { type: "agent_tool_call" }> => ({
  type: "agent_tool_call", id, toolCallId: "tool-call", name: "sedes_agent_context", arguments: {}, assistantEntryId, userEntryId: "user",
});
function completedHistory(): Pick<PiNativeHistory, "sessionId" | "toolCalls" | "toolResults"> {
  return { sessionId: attachment.sessionId,
    toolCalls: [{ toolCallId: "tool-call", toolName: "sedes_agent_context", assistantEntryId: "assistant", userEntryId: "user",
      arguments: {}, managed: "agent", sourceInfo: { source: "extension", path: "/managed/extension.ts" } }],
    toolResults: [{ toolCallId: "tool-call", assistantEntryId: "assistant", userEntryId: "user", content: [{ type: "text", text: "Done" }], isError: false }],
  };
}
function setup(cli: AgentToolCliAvailability = { availability: "unavailable", reason: "cli_unavailable" }, remote = false,
  definition: AgentToolDefinition = agentContextToolDefinition) {
  const registry = new AgentToolRegistry(); registry.register(definition);
  const artifact = registry.artifact(definition.id, definition.schemaVersion);
  const description: AgentToolDescription = { id: artifact.id, schemaVersion: artifact.schemaVersion,
    label: artifact.adapters.pi!.label, description: artifact.description, inputSchema: artifact.inputSchema, outputSchema: artifact.outputSchema,
    effects: artifact.effects, execution: { form: artifact.execution.form, waitCeilingMilliseconds: 30_000,
      supportsCancellation: artifact.execution.supportsCancellation, idempotency: artifact.execution.idempotency,
      progress: artifact.execution.progress, maximumInputBytes: artifact.execution.maximumInputBytes,
      maximumOutputBytes: artifact.execution.maximumOutputBytes, uncertainExternalOutcome: artifact.execution.uncertainExternalOutcome } };
  const state: { policy: BackendAgentToolPolicy; mode: "read_only" | "ask" | "full" } = { mode: "full", policy: {
    enabled: true, presentation: { surface: "native", mode: "individual" }, enabledToolIds: [artifact.id],
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } } };
  const invoke = vi.fn(async (_input: BackendAgentToolInvocationInput): Promise<SedesToolInvocationResult<unknown>> => ({ invocationId: "invocation", state: "completed", output: { ok: true } }));
  const facade: BackendAgentToolFacade = { eligibleCatalog: () => [artifact], readPolicy: () => state.policy,
    catalogSummaries: () => [{ id: artifact.id, schemaVersion: artifact.schemaVersion, label: description.label,
      description: description.description, effects: description.effects, group: { id: artifact.catalog.groupId, order: artifact.catalog.order } }],
    describeMany: () => [description], invoke: invoke as BackendAgentToolFacade["invoke"] };
  const commands: Readonly<Record<string, unknown>>[] = [];
  const port = { request: vi.fn(async (input: Parameters<PiNativePort["request"]>[0]) => {
    commands.push(input.command.command); return { status: "completed" as const, result: {} };
  }), acknowledgeOperation: vi.fn(async () => {}) } as unknown as PiNativePort;
  const issue = vi.fn(() => "stable-thread-source-reference");
  const clientAuthority = vi.fn((_userEntryId: string): BackendAgentToolAccessDecisionAuthority => ({
    acquire: async signal => ({ signal, isCurrent: () => true, release() {} }),
  }));
  const service = new PiNativeAgentToolService({ facade, cli, remote, sourceCapabilities: { issue } });
  const bridge = service.createBridge({ attachment, conversation, port, getToolMode: () => state.mode,
    clientControlAuthority: userEntryId => clientAuthority(userEntryId) });
  const resolved = () => commands.filter(command => command.type === "resolve_agent_tool");
  return { state, invoke, commands, service, bridge, resolved, issue, artifact, clientAuthority, port };
}

describe("native Pi Sedes tools", () => {
  it("configures only currently admitted native tools and removes them when policy is disabled", async () => {
    const fixture = setup();
    expect(await fixture.bridge.configure()).toEqual(["sedes_agent_context"]);
    expect(fixture.commands[0]).toMatchObject({ type: "configure_agent_tools", tools: [{ name: "sedes_agent_context", readOnly: true }] });
    fixture.state.policy = { ...fixture.state.policy, enabled: false };
    expect(await fixture.bridge.configure()).toEqual([]);
    expect(fixture.commands[1]).toMatchObject({ tools: [] });
  });
  it("binds invocations to server scope and stable native call identity across replay", async () => {
    const fixture = setup();
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    fixture.bridge.onEvent(call("replayed"));
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(2));
    fixture.bridge.onEvent(call("next", "other-assistant"));
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(3));
    expect(fixture.invoke.mock.calls[0]![0]).toMatchObject({ source: { scope, sourceThreadId: "thread", backendKind: "pi_native" }, adapter: "pi_rpc" });
    const ids = fixture.invoke.mock.calls.map(([input]) => input.request.requestId);
    expect(ids[0]).toEqual(ids[1]); expect(ids[2]).not.toEqual(ids[0]);
    expect(fixture.resolved()[0]).toMatchObject({ isError: false, result: { details: {
      invocation: { invocationId: "invocation" }, agentToolInvocation: { toolId: "agent.context", schemaVersion: fixture.artifact.schemaVersion, invocationId: "invocation" },
    }, structuredContent: { ok: true } } });
    expect(fixture.clientAuthority).not.toHaveBeenCalled();
  });
  it("rechecks policy at invocation and rejects unexpected arguments", async () => {
    const fixture = setup(); await fixture.bridge.configure();
    fixture.state.policy = { ...fixture.state.policy, enabled: false };
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    expect(fixture.invoke).not.toHaveBeenCalled(); expect(fixture.resolved()[0]).toMatchObject({ isError: true });
    fixture.state.policy = { ...fixture.state.policy, enabled: true };
    fixture.bridge.onEvent({ ...call("bad-args"), arguments: { unauthorized: true } });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(2));
    expect(fixture.invoke).not.toHaveBeenCalled(); expect(fixture.resolved()[1]).toMatchObject({ isError: true });
  });
  it("uses the progressive read lane and rejects an effect classification mismatch", async () => {
    const fixture = setup(); fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "native", mode: "progressive" } };
    expect(await fixture.bridge.configure()).toEqual(["sedes_catalog", "sedes_read"]);
    const args = { toolId: fixture.artifact.id, schemaVersion: fixture.artifact.schemaVersion, input: {} };
    fixture.bridge.onEvent({ ...call(), name: "sedes_read", arguments: args, parentToolCallId: "codemode-call" });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    fixture.bridge.onEvent({ ...call("wrong-lane"), name: "sedes_act", arguments: args });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(2));
    expect(fixture.invoke).toHaveBeenCalledTimes(1); expect(fixture.resolved()[1]).toMatchObject({ isError: true });
  });
  it("cancels only the attached invocation wait when the native call ends", async () => {
    const fixture = setup(); let received: AbortSignal | undefined;
    fixture.invoke.mockImplementation(async input => { received = input.signal; return await new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); });
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(received).toBeDefined());
    fixture.bridge.onEvent({ type: "agent_tool_cancelled", id: "request" });
    expect(received!.aborted).toBe(true); expect(fixture.resolved()).toEqual([]);
    expect(fixture.bridge.hasPendingCalls()).toBe(false);
    fixture.bridge.close();
  });
  it("retains an unresolved native tool event when result delivery fails", async () => {
    const fixture = setup();
    vi.spyOn(fixture.port, "request").mockRejectedValueOnce(new Error("reply_channel_lost"));
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(fixture.port.request).toHaveBeenCalledOnce());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.bridge.hasPendingCalls()).toBe(true);
    fixture.bridge.onEvent({ type: "agent_tool_cancelled", id: "request" });
    expect(fixture.bridge.hasPendingCalls()).toBe(false);
    fixture.bridge.onEvent(call("next"));
    await vi.waitFor(() => expect(fixture.bridge.hasPendingCalls()).toBe(false));
    expect(fixture.port.request).toHaveBeenCalledTimes(2);
  });
  it("settles a lost tool reply only from matching authenticated native completion", async () => {
    const fixture = setup();
    vi.spyOn(fixture.port, "request").mockRejectedValueOnce(new Error("reply_channel_lost"));
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(fixture.port.request).toHaveBeenCalledOnce());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.bridge.hasPendingCalls()).toBe(true);
    const history = completedHistory();
    expect(() => fixture.bridge.reconcileHistory({ ...history, sessionId: "another-session" })).toThrow("history_mismatch");
    const mismatches = [
      { ...history, toolCalls: [] },
      { ...history, toolResults: [] },
      { ...history, toolResults: history.toolResults.map(result => ({ ...result, userEntryId: "another-user" })) },
      ...[
        { assistantEntryId: "another-assistant" }, { toolCallId: "another-tool-call" }, { toolName: "sedes_other" },
        { parentToolCallId: "another-parent" }, { arguments: { changed: true } }, { managed: "mcp" as const },
      ].map(change => ({ ...history, toolCalls: history.toolCalls.map(call => ({ ...call, ...change })) })),
    ];
    for (const mismatch of mismatches) {
      fixture.bridge.reconcileHistory(mismatch);
      expect(fixture.bridge.hasPendingCalls()).toBe(true);
    }
    fixture.bridge.reconcileHistory(history);
    expect(fixture.bridge.hasPendingCalls()).toBe(false);
    expect(fixture.invoke.mock.calls[0]![0].signal.aborted).toBe(true);
    fixture.bridge.onEvent(call("retained-event-replay"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.invoke).toHaveBeenCalledOnce();
    expect(fixture.port.request).toHaveBeenCalledOnce();
    fixture.bridge.close();
  });
  it("does not redispatch a completed tool event replayed after a fresh attachment", async () => {
    const fixture = setup();
    fixture.bridge.reconcileHistory(completedHistory());
    fixture.bridge.onEvent(call());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.port.request).not.toHaveBeenCalled();
    expect(fixture.bridge.hasPendingCalls()).toBe(false);
    fixture.bridge.close();
  });
  it.each(["individual", "progressive"] as const)("fences %s client controls to the exact originating native user entry", async mode => {
    const definition = createClientControlToolDefinitions().find(definition => definition.id === "client.end_interaction")!;
    const fixture = setup(undefined, false, definition);
    fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "native", mode } };
    const applied = vi.fn(), released = vi.fn();
    const acquire = vi.fn(async (userEntryId: string, signal: AbortSignal) => {
      if (userEntryId !== "current-user") throw new BackendAgentToolRequestError({ code: "permission_denied", retryable: false, message: "The originating Pi turn is no longer current." });
      return { signal, isCurrent: () => true, release: released };
    });
    fixture.clientAuthority.mockImplementation(userEntryId => ({ acquire: signal => acquire(userEntryId, signal) }));
    // The production facade acquires this lease after capturing the normalized
    // client turn and before dispatching any client command.
    fixture.invoke.mockImplementation(async input => {
      const lease = await input.accessDecisionAuthority!.acquire(input.signal);
      try {
        if (!lease.isCurrent()) throw new Error("stale_origin");
        applied();
        return { invocationId: "client-invocation", state: "completed", output: { ok: true } };
      } finally { lease.release(); }
    });
    const named: Pick<Extract<PiManagedEvent, { type: "agent_tool_call" }>, "name" | "arguments"> = { name: mode === "individual" ? "sedes_client_end_interaction" : "sedes_act",
      arguments: mode === "individual" ? {} : { toolId: definition.id, schemaVersion: definition.schemaVersion, input: {} } };
    fixture.bridge.onEvent({ ...call("retained-old"), ...named, userEntryId: "older-user" });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    expect(fixture.resolved()[0]).toMatchObject({ isError: true });
    expect(applied).not.toHaveBeenCalled();
    fixture.bridge.onEvent({ ...call("current"), ...named, userEntryId: "current-user", parentToolCallId: "code-mode-parent" });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(2));
    expect(applied).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    expect(fixture.clientAuthority.mock.calls.map(([id]) => id)).toEqual(["older-user", "current-user"]);
    expect(fixture.resolved()[1]).toMatchObject({ isError: false, result: { details: {
      agentToolInvocation: { toolId: definition.id, schemaVersion: definition.schemaVersion, invocationId: "client-invocation" },
    } } });
  });
  it("rejects client controls if the runtime fails to supply originating-turn authority", async () => {
    const definition = createClientControlToolDefinitions().find(definition => definition.id === "client.list")!;
    const fixture = setup(undefined, false, definition);
    fixture.clientAuthority.mockReturnValue(undefined as unknown as BackendAgentToolAccessDecisionAuthority);
    fixture.bridge.onEvent({ ...call(), name: "sedes_client_list" });
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.resolved()[0]).toMatchObject({ isError: true });
  });
  it("retains canonical invocation identity with failed tool results", async () => {
    const fixture = setup();
    fixture.invoke.mockResolvedValue({ invocationId: "failed-invocation", state: "failed",
      error: { code: "unavailable", message: "Unavailable now.", retryable: true } });
    fixture.bridge.onEvent(call());
    await vi.waitFor(() => expect(fixture.resolved()).toHaveLength(1));
    expect(fixture.resolved()[0]).toMatchObject({ isError: true, result: { details: {
      invocation: { state: "failed", invocationId: "failed-invocation" },
      agentToolInvocation: { toolId: fixture.artifact.id, schemaVersion: fixture.artifact.schemaVersion, invocationId: "failed-invocation" },
    } } });
  });
  it("scrubs inherited CLI authority when native tools are selected", async () => {
    const fixture = setup(); const launched = await fixture.service.prepareLaunch(conversation);
    expect(launched.environment).toEqual({ SEDES_AGENT_TOOL_ENDPOINT: null, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null,
      SEDES_AGENT_TOOL_CLIENT_TOKEN: null, SEDES_AGENT_TOOL_CLI_MODE: null });
    expect(fixture.issue).not.toHaveBeenCalled();
  });
  it("issues scoped stable CLI authority with the execution-host transport", async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ availability: "available" as const,
      endpoint: "unix:///tmp/sedes-cli.sock", executableDirectory: "/sidecar/bin", inheritedPath: "/usr/bin", closed: new Promise(() => {}), release }));
    const cli = { availability: "managed" as const, provider: { acquire } };
    const fixture = setup(cli, true); fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "cli", mode: "progressive" } };
    const [launch, reattached] = await Promise.all([fixture.service.prepareLaunch(conversation), fixture.service.prepareLaunch(conversation)]);
    expect(launch.environment).toMatchObject({ PATH: "/sidecar/bin:/usr/bin", SEDES_AGENT_TOOL_CLI_MODE: "progressive", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "stable-thread-source-reference" });
    expect(reattached).toEqual(launch);
    expect(fixture.issue).toHaveBeenCalledWith(expect.objectContaining({ backendKind: "pi_native", sourceThreadId: "thread" }), "execution_environment_sidecar", "cli");
    fixture.bridge.close();
    expect(release).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(1);
    fixture.state.policy = { ...fixture.state.policy, enabled: false };
    expect(await fixture.service.prepareLaunch(conversation)).toEqual(launch);
    expect(release).not.toHaveBeenCalled();
    await fixture.service.close();
    await fixture.service.close();
    expect(release).toHaveBeenCalledTimes(1);
    await expect(fixture.service.prepareLaunch(conversation)).rejects.toThrow("pi_native_agent_tool_service_closed");
  });
  it("provisions CLI authority before enablement and selection change in a resident process", async () => {
    const fixture = setup({ availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/bin", inheritedPath: "/usr/bin" });
    fixture.state.policy = { ...fixture.state.policy, enabled: false, enabledToolIds: [], presentation: { surface: "cli", mode: "individual" } };
    const disabled = await fixture.service.prepareLaunch(conversation);
    expect(disabled.environment.SEDES_AGENT_TOOL_ENDPOINT).toBe("http://127.0.0.1:4784");
    expect(disabled.environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY).toBe("stable-thread-source-reference");
    fixture.state.policy = { ...fixture.state.policy, enabled: true, enabledToolIds: [fixture.artifact.id] };
    expect(await fixture.service.prepareLaunch(conversation)).toEqual(disabled);
    await fixture.service.close();
  });
  it("reacquires a managed endpoint only after its retained generation closes", async () => {
    let closeEndpoint!: () => void;
    const release = vi.fn();
    const endpoint = { availability: "available" as const, endpoint: "unix:///tmp/sedes-cli.sock", executableDirectory: "/sidecar/bin", inheritedPath: "/usr/bin",
      closed: new Promise<void>(resolve => { closeEndpoint = resolve; }), release };
    const nextRelease = vi.fn();
    const acquire = vi.fn().mockResolvedValueOnce(endpoint).mockResolvedValueOnce({ ...endpoint, closed: new Promise(() => {}), release: nextRelease });
    const fixture = setup({ availability: "managed", provider: { acquire } }, true);
    fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "cli", mode: "individual" } };
    await fixture.service.prepareLaunch(conversation);
    closeEndpoint();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await fixture.service.prepareLaunch(conversation);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(nextRelease).not.toHaveBeenCalled();
    await fixture.service.close();
    expect(release).toHaveBeenCalledOnce();
    expect(nextRelease).toHaveBeenCalledOnce();
  });
  it("releases an endpoint acquired while runtime shutdown is in progress", async () => {
    let completeAcquire!: (value: Extract<AgentToolCliRuntimeResolution, { availability: "available" }>) => void;
    let acquisitionSignal: AbortSignal | undefined;
    const acquire = vi.fn((options?: { signal?: AbortSignal }) => {
      acquisitionSignal = options?.signal;
      return new Promise<Parameters<typeof completeAcquire>[0]>(resolve => { completeAcquire = resolve; });
    });
    const fixture = setup({ availability: "managed", provider: { acquire } }, true);
    fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "cli", mode: "individual" } };
    const preparing = fixture.service.prepareLaunch(conversation);
    const rejected = expect(preparing).rejects.toThrow("pi_native_agent_tool_service_closed");
    const closing = fixture.service.close();
    expect(acquisitionSignal?.aborted).toBe(true);
    const release = vi.fn();
    completeAcquire({ availability: "available", endpoint: "unix:///tmp/sedes-cli.sock", executableDirectory: "/sidecar/bin", inheritedPath: "/usr/bin", closed: new Promise(() => {}), release });
    await rejected;
    await closing;
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases a managed endpoint if its scope cannot be trusted", async () => {
    const release = vi.fn();
    const fixture = setup({ availability: "managed", provider: { acquire: async () => ({ availability: "available", endpoint: "https://elsewhere.invalid", executableDirectory: "/bin", inheritedPath: "/usr/bin", closed: Promise.resolve(), release }) } }, true);
    fixture.state.policy = { ...fixture.state.policy, presentation: { surface: "cli", mode: "individual" } };
    await expect(fixture.service.prepareLaunch(conversation)).rejects.toThrow("pi_native_cli_environment_invalid");
    expect(release).toHaveBeenCalledTimes(1); expect(fixture.issue).not.toHaveBeenCalled();
  });
});
