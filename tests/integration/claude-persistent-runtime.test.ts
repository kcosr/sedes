import type { EnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { randomUUID } from "node:crypto";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { CLAUDE_PERSISTENT_PIPELINED_ACKNOWLEDGEMENTS, ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { CLAUDE_PERSISTENT_RETAINED_EVENT_LIMIT } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-host.js";
import { claudePersistentAttachmentSchema, type ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { ClaudeSidecarRuntimeConnection, registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { createClaudeFramedCarrier, createFakePersistentClaudeRuntime } from "../helpers/persistent-claude-fixture.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "ssh-environment", backendInstanceId: "claude-remote" };
const configuration = { ...scope, executablePath: "/provider/claude", configDirectory: "/provider/.claude", initializationTimeoutMs: 5_000 };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: {
  readonly validateAgentToolMcp?: (agentToolMcp: NonNullable<ClaudeRuntimeSessionOptions["agentToolMcp"]>) => void;
} = {}) {
  const native = createFakePersistentClaudeRuntime();
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({
    scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64),
    runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive,
  });
  const createRuntime = vi.fn(() => native.runtime);
  const hosts = new ClaudePersistentRuntimeRegistry({
    scope, executionEnvironmentId: scope.executionEnvironmentId,
    environmentChannel: {} as ExecutionEnvironmentChannelProvider, environment: {}, services,
    artifact: async () => { throw new Error("test_provider_must_not_launch_artifact"); },
    createRuntime,
    ...(options.validateAgentToolMcp ? { validateAgentToolMcp: options.validateAgentToolMcp } : {}),
  });
  let current: SidecarRuntimeLease | undefined;
  const sidecarRuntime: SidecarRuntimeProvider = {
    acquire: vi.fn(async signal => {
      signal?.throwIfAborted();
      if (!current) throw new Error("test_carrier_unavailable");
      return current;
    }),
  };
  const clients: ClaudePersistentRuntimeClient[] = [];
  const carriers: { close(): Promise<void> }[] = [];
  async function attach() {
    const carrier = await createClaudeFramedCarrier();
    const controllerEpoch = services.attach(serviceConfiguration);
    const detach = registerClaudePersistentRuntimeHost({
      registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, controllerEpoch,
      onDetach: () => services.detach(controllerEpoch),
    });
    await carrier.start();
    let disconnected!: () => void;
    const lease: SidecarRuntimeLease = {
      channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
      closed: new Promise<void>(resolve => { disconnected = resolve; }), release: vi.fn(),
    };
    current = lease;
    const attached = {
      ...carrier, lease,
      connection: new ClaudeSidecarRuntimeConnection(carrier.mainChannel),
      async close() {
        if (current === lease) current = undefined;
        detach();
        disconnected();
        await carrier.close();
      },
    };
    carriers.push(attached);
    return attached;
  }
  function client(startupEnvironmentVariables?: EnvironmentVariableOverrides) {
    const value = new ClaudePersistentRuntimeClient({ ...configuration, scope, sidecarRuntime, startupEnvironmentVariables });
    clients.push(value);
    return value;
  }
  async function stop(force: boolean) {
    const status = services.status();
    await services.stop({
      expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
      expectedConfiguration: serviceConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint,
      force, reason: "test_explicit_service_stop",
    });
  }
  cleanups.push(async () => {
    for (const client of clients) await client.close();
    for (const carrier of carriers) await carrier.close();
    await native.runtime.close();
  });
  return { ...native, services, hosts, attach, client, stop, archive, createRuntime };
}

function sessionOptions(sessionId: string, overrides: Partial<ClaudeRuntimeSessionOptions> = {}): ClaudeRuntimeSessionOptions {
  return { executablePath: configuration.executablePath, initializationTimeoutMs: 5_000,
    sessionId, cwd: "/workspace", launch: "new", environment: {}, onMessage: vi.fn(), ...overrides };
}
function delta(sessionId: string, text: string): SDKMessage {
  return { type: "stream_event", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
}
/** Claude stamps the first stream event of the turn that consumed an input. */
function firstDelta(sessionId: string, text: string, operationId: string): SDKMessage {
  return { ...delta(sessionId, text), user_message_uuid: operationId, user_message_uuids: [operationId] } as SDKMessage;
}
function lifecycle(sessionId: string, operationId: string, state: "queued" | "started" | "completed"): SDKMessage {
  return { type: "command_lifecycle", command_uuid: operationId, state, uuid: randomUUID(), session_id: sessionId } as unknown as SDKMessage;
}
function acceptedInput(sessionId: string, operation: { operationId: string; content: string }) {
  return { type: "user", uuid: operation.operationId, session_id: sessionId,
    parent_tool_use_id: null, message: { role: "user", content: operation.content } };
}

describe("Claude persistent runtime through framed replacement carriers", () => {
  const agentToolMcp: NonNullable<ClaudeRuntimeSessionOptions["agentToolMcp"]> = {
    command: "/remote/sedes/sidecar/sedes",
    mode: "individual",
    endpoint: "unix:///run/user/1000/sedes/agent-tools.sock",
    sourceCapability: "m".repeat(48),
  };

  it("admits a Native MCP server only through the sidecar's own validator", async () => {
    const open = (
      attached: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["attach"]>>,
      runtimeId: string,
      request: Record<string, unknown>,
    ) => attached.connection.execute({ action: "open", runtimeId,
      controllerEpoch: attached.lease.controllerEpoch, replay: "full", request } as never);
    const validate = vi.fn((candidate: NonNullable<ClaudeRuntimeSessionOptions["agentToolMcp"]>) => {
      if (candidate.command !== agentToolMcp.command) throw new Error("claude_persistent_agent_tool_mcp_denied");
    });
    const f = await fixture({ validateAgentToolMcp: validate });
    const attached = await f.attach();
    const sessionId = randomUUID();
    await f.client().createSession(sessionOptions(sessionId, { agentToolMcp })).start();
    expect(validate).toHaveBeenCalledWith(agentToolMcp);
    expect(f.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentToolMcp, environment: {} }),
    );
    const runtimeId = f.services.status().resources[0]!.resourceId;
    const request = { queryId: sessionId, sessionId, cwd: "/workspace", launch: "resume",
      enableCanUseTool: false, environment: {}, agentToolMcp };
    // A reattach must present the same MCP authority as the retained query.
    await expect(open(attached, runtimeId, {
      ...request, agentToolMcp: { ...agentToolMcp, mode: "progressive" },
    })).rejects.toThrow();
    await expect(open(attached, runtimeId, { ...request, agentToolMcp: undefined }))
      .rejects.toThrow();
    const other = randomUUID();
    await expect(open(attached, runtimeId, {
      ...request, queryId: other, sessionId: other, launch: "new",
      agentToolMcp: { ...agentToolMcp, command: "/tmp/other/sedes" },
    })).rejects.toThrow();
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);

    const unvalidated = await fixture();
    const unvalidatedCarrier = await unvalidated.attach();
    await unvalidated.client().createSession(sessionOptions(randomUUID())).start();
    const unvalidatedRuntime = unvalidated.services.status().resources[0]!.resourceId;
    const denied = randomUUID();
    await expect(open(unvalidatedCarrier, unvalidatedRuntime, {
      ...request, queryId: denied, sessionId: denied, launch: "new",
    })).rejects.toThrow();
    expect(unvalidated.runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it("reattaches after main restart with pending startup edits and applies them only after explicit restart", async () => {
    const f = await fixture();
    const applied: EnvironmentVariableOverrides = { PATH: { kind: "literal", value: "/applied/bin" } };
    const desired: EnvironmentVariableOverrides = { PATH: { kind: "literal", value: "/pending/bin" } };
    const firstCarrier = await f.attach();
    const first = f.client(applied);
    const sessionId = randomUUID();
    await first.createSession(sessionOptions(sessionId)).start();
    const runtimeId = f.services.status().resources[0]!.resourceId;
    expect(f.createRuntime).toHaveBeenCalledOnce();
    const appliedFingerprint = f.hosts.inspect(runtimeId).startupEnvironmentFingerprint;
    expect(appliedFingerprint).toBe(configurationFingerprint(applied));
    await first.close(); await firstCarrier.close();
    expect(f.runtime.close).not.toHaveBeenCalled();

    const secondCarrier = await f.attach();
    const replacement = f.client(desired);
    await replacement.createSession(sessionOptions(sessionId, { launch: "resume" })).start();
    await expect(replacement.listSessions({ dir: "/workspace" }, {})).resolves.toEqual([]);
    await replacement.createSession(sessionOptions(randomUUID())).start();
    expect(f.runtime.listSessions).toHaveBeenCalledOnce();
    expect(f.createRuntime).toHaveBeenCalledOnce();
    expect(f.runtime.createSession).toHaveBeenCalledTimes(2);
    expect(f.hosts.get(runtimeId).input.configuration.startupEnvironmentVariables).toEqual(applied);
    expect(f.hosts.inspect(runtimeId).startupEnvironmentFingerprint).toBe(appliedFingerprint);
    await expect(secondCarrier.connection.ensure({ ...configuration, startupEnvironmentVariables: desired, executablePath: "/changed/claude" })).rejects.toThrow();
    await replacement.close();
    await secondCarrier.connection.stop({ configuration: { ...configuration, startupEnvironmentVariables: desired }, runtimeId, controllerEpoch: secondCarrier.lease.controllerEpoch, expectedRevision: f.hosts.inspect(runtimeId).revision, force: false });
    const restarted = f.client(desired);
    await restarted.createSession(sessionOptions(randomUUID())).start();
    const newId = f.services.status().resources[0]!.resourceId;
    expect(newId).not.toBe(runtimeId);
    expect(f.createRuntime).toHaveBeenCalledTimes(2);
    expect(f.hosts.get(newId).input.configuration.startupEnvironmentVariables).toEqual(desired);
    expect(f.hosts.inspect(newId).startupEnvironmentFingerprint).toBe(configurationFingerprint(desired));
  });

  it("waits for explicit eviction cleanup before reopening and never attaches to the departing query", async () => {
    const f = await fixture();
    const carrier = await f.attach();
    const client = f.client();
    const sessionId = randomUUID();
    const session = client.createSession(sessionOptions(sessionId));
    await session.start();
    const native = f.sessions[0]!;
    const close = native.close.getMockImplementation()!;
    let finish!: () => void;
    const cleanup = new Promise<void>(resolve => { finish = resolve; });
    native.close.mockImplementationOnce(async () => { await cleanup; await close(); });
    const evicting = session.close({ reason: "evicted" });
    await vi.waitFor(() => expect(native.close).toHaveBeenCalledOnce());
    const authority = { runtimeId: f.services.status().resources[0]!.resourceId, controllerEpoch: carrier.lease.controllerEpoch };
    const execute = vi.spyOn(f.hosts.get(authority.runtimeId), "execute");
    const attaching = expect(carrier.connection.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } })).rejects.toThrow("sidecar_operation_failed");
    await vi.waitFor(() => expect(execute.mock.calls.some(([command]) => command.action === "attach")).toBe(true));
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume" }));
    const opening = restored.start();
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([evicting, attaching, opening]);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(2);
    expect(f.sessions[1]!.closed).toBe(false);
    await restored.close({ reason: "evicted" });
  });

  it("preserves idle queries across detach and closes only the deliberately evicted query", async () => {
    const f = await fixture();
    const carrier = await f.attach();
    const client = f.client();
    const a = client.createSession(sessionOptions(randomUUID()));
    const b = client.createSession(sessionOptions(randomUUID()));
    await Promise.all([a.start(), b.start()]);
    await a.close({ reason: "evicted" });
    expect(f.sessions[0]!.closed).toBe(true);
    expect(f.sessions[1]!.closed).toBe(false);
    await carrier.close();
    expect(f.sessions[1]!.closed).toBe(false);
    await f.attach();
    await client.attachment();
    await b.close({ reason: "evicted" });
    expect(f.sessions[1]!.closed).toBe(true);
  });

  it("reattaches the same active native query after main client replacement and replays disconnected output once", async () => {
    const f = await fixture();
    const first = await f.attach();
    const originalClient = f.client();
    const sessionId = randomUUID();
    const originalMessages = vi.fn();
    const original = originalClient.createSession(sessionOptions(sessionId, { onMessage: originalMessages }));
    await original.start();
    const native = f.sessions[0]!;
    const operation = { operationId: randomUUID(), content: "Keep working remotely." };
    original.send(operation);
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    const beforeDisconnect = firstDelta(sessionId, "Started before the connection was lost.", operation.operationId);
    await native.emit(beforeDisconnect);
    await vi.waitFor(() => expect(originalMessages.mock.calls.map(([message]) => message)).toEqual([acceptedInput(sessionId, operation), beforeDisconnect]));
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual(["active_work"]));
    const originalRuntimeId = f.services.status().resources[0]!.resourceId;
    const incarnation = f.services.serviceIncarnation;

    await originalClient.close();
    await first.close();
    expect(native.close).not.toHaveBeenCalled();
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.services.status().resources[0]!.blockers).toContain("active_work");
    const buffered = [delta(sessionId, "Still "), delta(sessionId, "running remotely.")];
    for (const message of buffered) await native.emit(message);
    expect(originalMessages).toHaveBeenCalledTimes(2);

    const second = await f.attach();
    expect(second.lease.controllerEpoch).toBeGreaterThan(first.lease.controllerEpoch);
    expect(second.lease.serviceIncarnation).toBe(incarnation);
    const restoredMessages = vi.fn();
    const restoredClient = f.client();
    await expect(restoredClient.submissionDisposition({ sessionId, operationId: operation.operationId, cwd: "/workspace" })).resolves.toBe("submitted");
    await expect(restoredClient.submissionDisposition({ sessionId, operationId: operation.operationId, cwd: "/other-workspace" })).resolves.toBe("unknown");
    await expect(restoredClient.submissionDisposition({ sessionId, operationId: randomUUID(), cwd: "/workspace" })).resolves.toBe("unknown");
    await expect(restoredClient.submissionDisposition({ sessionId: randomUUID(), operationId: operation.operationId, cwd: "/workspace" })).resolves.toBe("unknown");
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    const restored = restoredClient.createSession(sessionOptions(sessionId, { launch: "resume", onMessage: restoredMessages }));
    await restored.start();
    // Deltas no main was offered fold into one frame; the offered one stays exact.
    const replay = [acceptedInput(sessionId, operation), beforeDisconnect,
      { ...buffered[1]!, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still running remotely." } } }];
    await vi.waitFor(() => expect(restoredMessages.mock.calls.map(([message]) => message)).toEqual(replay));
    expect(restored.startupProbeUuid).toBe(original.startupProbeUuid);
    expect(f.services.status().resources[0]!.resourceId).toBe(originalRuntimeId);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    expect(native.start).toHaveBeenCalledTimes(1);

    restored.send(operation);
    await restored.setModel("claude-sonnet-4-6");
    expect(native.send).toHaveBeenCalledTimes(1);
    await expect(second.connection.execute({ action: "send", runtimeId: originalRuntimeId, controllerEpoch: second.lease.controllerEpoch,
      request: { queryId: sessionId, operationId: operation.operationId, content: "Conflicting replacement input." } })).rejects.toThrow();
    expect(native.send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual(["active_work"]));
    const subsequent = delta(sessionId, " Continuing.");
    await native.emit(subsequent);
    await vi.waitFor(() => expect(restoredMessages.mock.calls.map(([message]) => message)).toEqual([...replay, subsequent]));
  });

  it("automatically replaces an interrupted carrier without reopening the provider query or resending input", async () => {
    const f = await fixture();
    const first = await f.attach();
    const received = vi.fn();
    const sessionId = randomUUID();
    const session = f.client().createSession(sessionOptions(sessionId, { onMessage: received }));
    await session.start();
    const operation = { operationId: randomUUID(), content: "Continue across disconnect." };
    session.send(operation);
    const native = f.sessions[0]!;
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    const beforeDisconnect = firstDelta(sessionId, "Already delivered.", operation.operationId);
    await native.emit(beforeDisconnect);
    await vi.waitFor(() => expect(received.mock.calls.map(([message]) => message)).toEqual([acceptedInput(sessionId, operation), beforeDisconnect]));
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual(["active_work"]));
    await first.close();
    const message = delta(sessionId, "Retained while the SSH carrier was absent.");
    await native.emit(message);
    await f.attach();
    await vi.waitFor(() => expect(received.mock.calls.map(([message]) => message)).toEqual([acceptedInput(sessionId, operation), beforeDisconnect, message]), { timeout: 3_000 });
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    expect(native.close).not.toHaveBeenCalled();
  });

  it("retains a pending permission for a replacement client and confirms delivery to that client", async () => {
    const f = await fixture();
    const first = await f.attach();
    const originalClient = f.client();
    const sessionId = randomUUID();
    let originalSignal: AbortSignal | undefined;
    const originalPermission = vi.fn<CanUseTool>((_name, _input, options) => {
      originalSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    });
    await originalClient.createSession(sessionOptions(sessionId, { canUseTool: originalPermission })).start();
    const native = f.sessions[0]!;
    const permission = native.options.canUseTool!(
      "Read",
      { file_path: "/workspace/example.txt" },
      {
        requestId: "permission-1",
        toolUseID: "tool-1",
        signal: new AbortController().signal,
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        mcpServer: { name: "fixture-mcp", source: "sdk" },
      },
    ).then(async (response) => {
      await native.options.onPermissionResponseDelivered?.({
        requestId: "permission-1",
        toolUseID: "tool-1",
      });
      return response;
    });
    await vi.waitFor(() => expect(originalPermission).toHaveBeenCalledTimes(1));
    await originalClient.close();
    await first.close();
    expect(originalSignal?.aborted).toBe(true);
    expect(native.close).not.toHaveBeenCalled();
    expect(f.services.status().resources[0]!.blockers).toContain("pending_interaction");

    await f.attach();
    const response = { behavior: "allow" as const, updatedInput: { file_path: "/workspace/example.txt" }, toolUseID: "tool-1" };
    const restoredPermission = vi.fn<CanUseTool>(async () => response);
    const delivered = vi.fn();
    await f.client().createSession(sessionOptions(sessionId, {
      launch: "resume", canUseTool: restoredPermission, onPermissionResponseDelivered: delivered,
    })).start();
    await expect(permission).resolves.toEqual(response);
    expect(restoredPermission).toHaveBeenCalledExactlyOnceWith(
      "Read",
      { file_path: "/workspace/example.txt" },
      expect.objectContaining({
        requestId: "permission-1",
        toolUseID: "tool-1",
        signal: expect.any(AbortSignal),
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        mcpServer: { name: "fixture-mcp", source: "sdk" },
      }),
    );
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledExactlyOnceWith({ requestId: "permission-1", toolUseID: "tool-1" }));
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual([]));
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(["tenantId", "principalId", "executionEnvironmentId"] as const)("denies a wrong %s before creating a provider runtime", async axis => {
    const f = await fixture();
    const attached = await f.attach();
    await expect(attached.connection.ensure({ ...configuration, [axis]: "intruder" })).rejects.toThrow();
    expect(f.runtime.createSession).not.toHaveBeenCalled();
    expect(f.services.status().resources).toEqual([]);
    expect(await attached.connection.ensure(configuration)).toEqual(expect.any(String));
  });

  it("fences stale controllers and refuses a changed runtime configuration", async () => {
    const f = await fixture();
    const first = await f.attach();
    const runtimeId = await first.connection.ensure(configuration);
    const second = await f.attach();
    await expect(first.connection.execute({ action: "probe", runtimeId, controllerEpoch: first.lease.controllerEpoch,
      request: { cwd: "/workspace" } })).rejects.toThrow();
    await expect(second.connection.ensure({ ...configuration, configDirectory: "/other/account" })).rejects.toThrow();
    expect(f.runtime.probe).not.toHaveBeenCalled();
    expect(await second.connection.ensure(configuration)).toBe(runtimeId);
  });

  it("rejects stale eviction without detaching the replacement controller", async () => {
    const f = await fixture();
    const first = await f.attach();
    const original = f.client();
    const sessionId = randomUUID();
    await original.createSession(sessionOptions(sessionId)).start();
    const runtimeId = f.services.status().resources[0]!.resourceId;
    await first.close();
    await original.close();
    const second = await f.attach();
    const received = vi.fn();
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume", onMessage: received }));
    await restored.start();
    const native = f.sessions[0]!;
    await expect(f.hosts.get(runtimeId).execute({ action: "evict", runtimeId,
      controllerEpoch: first.lease.controllerEpoch, request: { sessionId } }, vi.fn()))
      .rejects.toThrow("controller_stale");
    await expect(second.connection.execute({ action: "evict", runtimeId,
      controllerEpoch: first.lease.controllerEpoch, request: { sessionId } })).rejects.toThrow();
    expect(native.close).not.toHaveBeenCalled();
    const message = delta(sessionId, "Replacement attachment is still live.");
    await native.emit(message);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(message));
    await restored.close({ reason: "evicted" });
    expect(native.closed).toBe(true);
  });

  it("rejects changed query authority when reopening an existing native session", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const sessionId = randomUUID();
    await f.client().createSession(sessionOptions(sessionId)).start();
    const runtimeId = f.services.status().resources[0]!.resourceId;
    const request = { queryId: sessionId, sessionId, cwd: "/workspace", launch: "resume" as const,
      enableCanUseTool: false, environment: {} };
    for (const changed of [
      { ...request, cwd: "/other-workspace" },
      { ...request, enableCanUseTool: true },
      { ...request, allowDangerouslySkipPermissions: true as const },
    ]) {
      await expect(attached.connection.execute({ action: "open", runtimeId,
        controllerEpoch: attached.lease.controllerEpoch, replay: "full", request: changed })).rejects.toThrow();
    }
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0]!.start).toHaveBeenCalledTimes(1);
    expect(f.sessions[0]!.close).not.toHaveBeenCalled();
  });

  it("keeps active work on client disposal and terminates it only on an explicit forced service stop", async () => {
    const f = await fixture();
    await f.attach();
    const client = f.client();
    const session = client.createSession(sessionOptions(randomUUID()));
    await session.start();
    const native = f.sessions[0]!;
    session.send({ operationId: randomUUID(), content: "Remain active." });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    await client.close();
    expect(native.close).not.toHaveBeenCalled();
    await expect(f.stop(false)).rejects.toThrow("sidecar_service_upgrade_blocked");
    expect(native.close).not.toHaveBeenCalled();
    await f.stop(true);
    expect(native.closed).toBe(true);
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(f.services.status()).toMatchObject({ state: "stopped", resources: [] });
  });

  it("archives unacknowledged output and forces shutdown without native history or replacement-client adoption", async () => {
    const f = await fixture();
    const first = await f.attach();
    const originalClient = f.client();
    const sessionId = randomUUID();
    const original = originalClient.createSession(sessionOptions(sessionId));
    await original.start();
    const native = f.sessions[0]!;
    const operation = { operationId: randomUUID(), content: "Keep the remote query active." };
    original.send(operation);
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    await originalClient.close();
    await first.close();
    const buffered = firstDelta(sessionId, "This output must survive until main adopts it.", operation.operationId);
    await native.emit(buffered);

    const host = f.hosts.get(f.services.status().resources[0]!.resourceId);
    await expect(host.stop()).rejects.toThrow("sidecar_resource_handoff_pending");
    expect(native.close).not.toHaveBeenCalled();
    f.runtime.getSessionInfo.mockRejectedValue(new Error("native_history_unavailable"));
    f.runtime.getSessionMessages.mockRejectedValue(new Error("native_history_unavailable"));
    await f.stop(true);
    expect(native.closed).toBe(true);
    expect(f.runtime.getSessionInfo).not.toHaveBeenCalled();
    expect(f.archive).toHaveBeenCalledTimes(2);
    expect(f.archive).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "claude_agent_sdk",
      evidence: expect.objectContaining({ phase: "before_shutdown", sessions: [expect.objectContaining({ sessionId, activeOperationIds: [operation.operationId], retainedEventCount: 2 })] }) }));
    expect(JSON.stringify(f.archive.mock.calls)).not.toContain("This output must survive");
    expect(f.services.status()).toMatchObject({ state: "stopped", resources: [] });
  });

  it.each(["success", "error_during_execution"] as const)(
    "keeps pending input, active work and replay across unrelated background receipts until a foreground %s",
    async (subtype) => {
      const f = await fixture();
      const attached = await f.attach();
      const host = f.hosts.ensure(
        configuration,
        attached.lease.controllerEpoch,
      );
      const authority = {
        runtimeId: host.runtimeId,
        controllerEpoch: attached.lease.controllerEpoch,
      };
      const sessionId = randomUUID();
      const delivered: ClaudePersistentEvent[] = [];
      const listener = (event: ClaudePersistentEvent) => {
        delivered.push(event);
      };
      await host.execute(
        {
          ...authority,
          action: "open",
          replay: "full",
          request: {
            queryId: sessionId,
            sessionId,
            cwd: "/workspace",
            launch: "new",
            enableCanUseTool: false,
            environment: {},
          },
        },
        listener,
      );
      const operation = {
        operationId: randomUUID(),
        content: "Do not accept another task's receipt.",
      };
      await host.execute(
        {
          ...authority,
          action: "send",
          request: { queryId: sessionId, ...operation },
        },
        listener,
      );
      const native = f.sessions[0]!;
      const result = (overrides: Record<string, unknown> = {}): SDKMessage =>
        ({
          type: "result",
          subtype: "success",
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: false,
          num_turns: 0,
          result: "",
          stop_reason: null,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          session_id: sessionId,
          ...overrides,
        }) as unknown as SDKMessage;
      const drain = result({
        origin: { kind: "task-notification" },
        user_message_uuid: randomUUID(),
      });
      await native.emit(drain);
      expect(delivered.map((event) => event.payload)).toEqual([
        { kind: "message", message: drain },
      ]);
      expect(host.abandonmentEvidence().sessions[0]).toMatchObject({
        pendingInputIds: [operation.operationId],
        activeOperationIds: [operation.operationId],
      });
      await host.execute(
        {
          ...authority,
          action: "acknowledge",
          request: { sessionId, sequence: delivered[0]!.sequence },
        },
        listener,
      );
      await native.emit(firstDelta(sessionId, "Working", operation.operationId));
      const accepted = delivered.find(
        (event) =>
          event.payload.kind === "message" &&
          event.payload.message.type === "user",
      )!;
      expect(accepted.payload).toEqual({
        kind: "message",
        message: acceptedInput(sessionId, operation),
      });
      for (const event of delivered.splice(0)) {
        await host.execute(
          {
            ...authority,
            action: "acknowledge",
            request: { sessionId, sequence: event.sequence },
          },
          listener,
        );
      }
      const unrelated = result({
        num_turns: 1,
        result: "Another task finished",
        user_message_uuid: randomUUID(),
      });
      await native.emit(unrelated);
      await native.emit(result({ origin: { kind: "task-notification" } }));
      for (const metadata of [
        { stop_reason: "end_turn" },
        { terminal_reason: "completed" },
        { stop_reason: "end_turn", terminal_reason: "completed" },
      ]) {
        await native.emit(
          result({ origin: { kind: "task-notification" }, ...metadata }),
        );
      }
      for (const event of delivered.splice(0)) {
        await host.execute(
          {
            ...authority,
            action: "acknowledge",
            request: { sessionId, sequence: event.sequence },
          },
          listener,
        );
      }
      const replay = claudePersistentAttachmentSchema.parse(
        await host.execute(
          {
            ...authority,
            action: "attach",
            replay: "full",
            request: { sessionId },
          },
          listener,
        ),
      );
      expect(
        replay.events.some(
          (event) =>
            event.payload.kind === "message" &&
            event.payload.message.type === "user",
        ),
      ).toBe(true);
      expect(
        replay.events.some(
          (event) =>
            event.payload.kind === "message" &&
            event.payload.message.type === "stream_event",
        ),
      ).toBe(true);
      expect(host.snapshot().blockers).toEqual(["active_work"]);
      // A correlated foreground zero-turn result remains a valid terminal receipt.
      await native.emit(
        result({
          user_message_uuids: [operation.operationId],
          subtype,
          is_error: subtype !== "success",
          errors: ["foreground failed"],
        }),
      );
      for (const event of delivered.splice(0)) {
        await host.execute(
          {
            ...authority,
            action: "acknowledge",
            request: { sessionId, sequence: event.sequence },
          },
          listener,
        );
      }
      const completed = claudePersistentAttachmentSchema.parse(
        await host.execute(
          {
            ...authority,
            action: "attach",
            replay: "full",
            request: { sessionId },
          },
          listener,
        ),
      );
      expect(completed.events).toEqual([]);
      expect(host.snapshot().blockers).toEqual([]);
    },
  );

  it("reattaches a never-active query with authoritative empty activity instead of unknown", async () => {
    const f = await fixture();
    const carrier = await f.attach();
    const sessionId = randomUUID();
    const first = f.client().createSession(sessionOptions(sessionId));
    await first.start();
    await first.close();
    await carrier.close();
    await f.attach();
    const replacement = f.client().createSession(sessionOptions(sessionId));
    await replacement.start();
    expect(replacement.reattached).toBe(true);
    expect(replacement.backgroundActivity).toEqual({ state: "known", agents: 0, commands: 0, other: 0 });
    await replacement.close({ reason: "evicted" });
    expect(f.sessions[0]!.closed).toBe(true);
  });

  it.each([false, true])("retains inventory and outcome holds across replacement and eviction with initially backgrounded=%s", async (is_backgrounded) => {
    const f = await fixture();
    const carrier = await f.attach();
    const host = f.hosts.ensure(configuration, carrier.lease.controllerEpoch);
    let authority = { runtimeId: host.runtimeId, controllerEpoch: carrier.lease.controllerEpoch };
    const sessionId = randomUUID();
    const delivered: ClaudePersistentEvent[] = [];
    const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
    await host.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {},
    } }, listener);
    const native = f.sessions[0]!;
    const operationId = randomUUID();
    await host.execute({ ...authority, action: "send", request: { queryId: sessionId, operationId, content: "Background work" } }, listener);
    const inventory = (tasks: unknown[]) => ({ type: "system", subtype: "background_tasks_changed",
      uuid: randomUUID(), session_id: sessionId, tasks }) as SDKMessage;
    const active = inventory([{ task_id: "child", task_type: "local_agent", description: "Audit" },
      { task_id: "shell", task_type: "local_bash", description: "Tests" }]);
    await native.emit({ type: "system", subtype: "task_started", task_id: "child", task_type: "local_agent",
      tool_use_id: "call", spawn_depth: 1, is_backgrounded, description: "Audit", uuid: randomUUID(), session_id: sessionId });
    if (!is_backgrounded) await native.emit({ type: "system", subtype: "task_updated", task_id: "child",
      patch: { is_backgrounded: true }, uuid: randomUUID(), session_id: sessionId });
    await native.emit(active);
    await native.emit({ type: "result", subtype: "success", user_message_uuid: operationId,
      num_turns: 1, result: "Started", stop_reason: "end_turn", uuid: randomUUID(), session_id: sessionId } as unknown as SDKMessage);
    for (const event of delivered.splice(0)) await host.execute({ ...authority, action: "acknowledge",
      request: { sessionId, sequence: event.sequence } }, listener);
    expect(host.snapshot().blockers).toContain("active_work");
    await host.execute({ ...authority, action: "evict", request: { sessionId } }, listener);
    expect(native.closed).toBe(false);
    await carrier.close();
    const replacement = await f.attach();
    authority = { runtimeId: host.runtimeId, controllerEpoch: replacement.lease.controllerEpoch };
    const restored = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, listener));
    expect(restored.events.map(event => event.payload)).toEqual([{ kind: "message", message: active }]);
    const empty = inventory([{ task_id: "ambient", task_type: "local_agent", description: "Watcher", ambient: true }]);
    await native.emit(empty);
    for (const event of delivered.splice(0)) await host.execute({ ...authority, action: "acknowledge",
      request: { sessionId, sequence: event.sequence } }, listener);
    const settled = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, listener));
    expect(settled.events.map(event => event.payload)).toEqual([{ kind: "message", message: empty }]);
    expect(settled.backgroundActivity).toMatchObject({ state: "known", agents: 0, commands: 0, other: 0 });
    expect(settled.pendingBackgroundTaskIds).toEqual(["child"]);
    expect(host.snapshot().blockers).toContain("active_work");
    await host.execute({ ...authority, action: "evict", request: { sessionId } }, listener);
    expect(native.closed).toBe(false);
    const waiting = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, listener));
    expect(waiting.pendingBackgroundTaskIds).toEqual(["child"]);
    await native.emit({ type: "system", subtype: "task_updated", task_id: "child", patch: { status: "completed" }, uuid: randomUUID(), session_id: sessionId });
    // A terminal update releases the edge hold, but its receipt must still be acknowledged.
    expect(host.snapshot().blockers).toContain("unsettled_outcome");
    await host.execute({ ...authority, action: "evict", request: { sessionId } }, listener);
    expect(native.closed).toBe(false);
    for (const event of delivered.splice(0)) await host.execute({ ...authority, action: "acknowledge",
      request: { sessionId, sequence: event.sequence } }, listener);
    expect(host.snapshot().blockers).not.toContain("active_work");
    await host.execute({ ...authority, action: "evict", request: { sessionId } }, listener);
    expect(native.closed).toBe(true);
  });

  it("compacts an acknowledged stream beyond the wire event limit and reattaches its complete text", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const host = f.hosts.ensure(configuration, attached.lease.controllerEpoch);
    const authority = { runtimeId: host.runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    const delivered: ClaudePersistentEvent[] = [];
    const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
    await host.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {},
    } }, listener);
    const operation = { operationId: randomUUID(), content: "Produce a long stream." };
    await host.execute({ ...authority, action: "send", request: { queryId: sessionId, ...operation } }, listener);
    const native = f.sessions[0]!;
    // Direct host acknowledgments keep the bound test deterministic and fast;
    // the final response still traverses the production framed wire and codec.
    for (let index = 0; index < 8_200; index++) {
      await native.emit(index === 0 ? firstDelta(sessionId, "x", operation.operationId) : delta(sessionId, "x"));
      for (const event of delivered.splice(0)) {
        await host.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: event.sequence } }, listener);
      }
    }
    const replay = claudePersistentAttachmentSchema.parse(await attached.connection.execute({
      ...authority, action: "attach", replay: "full", request: { sessionId },
    }));
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0]!.payload).toEqual({ kind: "message", message: acceptedInput(sessionId, operation) });
    expect(replay.events[1]!.payload).toMatchObject({ kind: "message", message: {
      type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(8_200) } },
    } });
    expect(host.snapshot().blockers).toEqual(["active_work"]);
    expect(native.close).not.toHaveBeenCalled();
    await f.stop(true);
  });

  it("archives output emitted during native cleanup without requiring replacement-client delivery", async () => {
    const f = await fixture();
    const first = await f.attach();
    const originalClient = f.client();
    const sessionId = randomUUID();
    const original = originalClient.createSession(sessionOptions(sessionId));
    await original.start();
    const native = f.sessions[0]!;
    const operation = { operationId: randomUUID(), content: "Work until service stop." };
    original.send(operation);
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    await originalClient.close();
    await first.close();
    const finalOutput = delta(sessionId, "Last output flushed by provider cleanup.");
    f.runtime.close.mockImplementationOnce(async () => {
      await native.emit(finalOutput);
      await native.close();
    });

    await f.stop(true);
    expect(native.closed).toBe(true);
    expect(f.archive).toHaveBeenLastCalledWith(expect.objectContaining({ evidence: expect.objectContaining({
      phase: "after_shutdown", sessions: [expect.objectContaining({ sessionId, events: expect.arrayContaining([expect.objectContaining({ kind: "message", messageType: "stream_event" })]) })],
    }) }));
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    expect(f.services.status()).toMatchObject({ state: "stopped", resources: [] });
  });

  it("retires an answered permission request before its response or delivery acknowledgement can be lost", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const runtimeId = await attached.connection.ensure(configuration);
    attached.connection.onEvent(runtimeId, () => {});
    const authority = { runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
    } });
    const native = f.sessions[0]!;
    const pending = native.options.canUseTool!("Read", {}, { requestId: "ask", toolUseID: "tool", signal: new AbortController().signal });
    expect(f.hosts.get(runtimeId).snapshot().blockers).toEqual(["pending_interaction"]);
    const response = { behavior: "allow" as const, updatedInput: {}, toolUseID: "tool" };
    await attached.connection.execute({ ...authority, action: "respond_permission", request: { sessionId, requestId: "ask", toolUseID: "tool", response } });
    await expect(pending).resolves.toEqual(response);
    // Simulate replacement after response acceptance but before either the
    // old request ACK or worker delivery acknowledgement reaches main.
    const replacement = await f.attach();
    replacement.connection.onEvent(runtimeId, () => {});
    const current = { runtimeId, controllerEpoch: replacement.lease.controllerEpoch };
    const answered = claudePersistentAttachmentSchema.parse(await replacement.connection.execute({ ...current, action: "attach", replay: "full", request: { sessionId } }));
    expect(answered.events).toEqual([]);
    await native.options.onPermissionResponseDelivered!({ requestId: "ask", toolUseID: "tool" });
    const delivered = claudePersistentAttachmentSchema.parse(await replacement.connection.execute({ ...current, action: "attach", replay: "full", request: { sessionId } }));
    expect(delivered.events.map(event => event.payload.kind)).toEqual(["permission_delivered"]);
    expect(f.hosts.get(runtimeId).snapshot().blockers).toEqual(["unsettled_outcome"]);
    await replacement.connection.execute({ ...current, action: "acknowledge", request: { sessionId, sequence: delivered.events[0]!.sequence } });
    expect(f.hosts.get(runtimeId).snapshot().blockers).toEqual([]);
  });

  it("forces an unanswered permission to terminate without manufacturing an adoption obligation", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const runtimeId = await attached.connection.ensure(configuration);
    attached.connection.onEvent(runtimeId, () => {});
    const authority = { runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
    } });
    const native = f.sessions[0]!;
    const abort = new AbortController();
    const pending = native.options.canUseTool!("Read", {}, { requestId: "ask", toolUseID: "tool", signal: abort.signal });
    expect(f.hosts.get(runtimeId).snapshot().blockers).toEqual(["pending_interaction"]);
    await expect(f.stop(false)).rejects.toThrow("sidecar_service_upgrade_blocked");
    f.runtime.close.mockImplementationOnce(async () => { abort.abort(); await native.close(); });
    await f.stop(true);
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(native.closed).toBe(true);
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
    expect(f.services.status()).toMatchObject({ state: "stopped", resources: [] });
  });

  it("allows denial but never a new permission grant after admission has frozen", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const runtimeId = await attached.connection.ensure(configuration);
    attached.connection.onEvent(runtimeId, () => {});
    const authority = { runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
    } });
    const native = f.sessions[0]!;
    const pending = native.options.canUseTool!("Read", {}, { requestId: "ask", toolUseID: "tool", signal: new AbortController().signal });
    f.hosts.get(runtimeId).freezeAdmission();
    await expect(attached.connection.execute({ ...authority, action: "respond_permission", request: {
      sessionId, requestId: "ask", toolUseID: "tool", response: { behavior: "allow", updatedInput: {} },
    } })).rejects.toThrow("sidecar_operation_failed");
    const response = { behavior: "deny" as const, message: "Stopping this runtime." };
    await attached.connection.execute({ ...authority, action: "respond_permission", request: { sessionId, requestId: "ask", toolUseID: "tool", response } });
    await expect(pending).resolves.toEqual(response);
    await native.options.onPermissionResponseDelivered!({ requestId: "ask", toolUseID: "tool" });
    const snapshot = claudePersistentAttachmentSchema.parse(await attached.connection.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }));
    expect(snapshot.events.map(event => event.payload.kind)).toEqual(["permission_delivered"]);
    await attached.connection.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: snapshot.events[0]!.sequence } });
    expect(f.hosts.get(runtimeId).snapshot().blockers).toEqual([]);
  });

  it("keeps submission disposition unknown after its admission journal retires and the native session resumes", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const runtimeId = await attached.connection.ensure(configuration);
    attached.connection.onEvent(runtimeId, () => {});
    const authority = { runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    const request = { queryId: sessionId, sessionId, cwd: "/workspace", launch: "new" as const, environment: {}, enableCanUseTool: false };
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request });
    const operation = { queryId: sessionId, operationId: randomUUID(), content: "A completed turn." };
    await attached.connection.execute({ ...authority, action: "send", request: operation });
    const host = f.hosts.get(runtimeId);
    const seen: ClaudePersistentEvent[] = [];
    await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, event => seen.push(event));
    await f.sessions[0]!.emit({ type: "result", session_id: sessionId, uuid: randomUUID(), user_message_uuid: operation.operationId } as SDKMessage);
    for (const event of seen) await host.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: event.sequence } }, () => {});
    await attached.connection.execute({ ...authority, action: "evict", request: { sessionId } });
    expect(f.sessions[0]!.closed).toBe(true);
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request: { ...request, launch: "resume" } });
    expect(f.runtime.createSession).toHaveBeenCalledTimes(2);
    await expect(attached.connection.execute({ ...authority, action: "submission_disposition", request: {
      sessionId, operationId: operation.operationId, cwd: "/workspace",
    } })).resolves.toEqual({ disposition: "unknown" });
    // Even after this replacement fails, its empty admission journal cannot
    // prove that an earlier incarnation never submitted the same operation.
    f.sessions[1]!.closed = true;
    await expect(attached.connection.execute({ ...authority, action: "submission_disposition", request: {
      sessionId, operationId: operation.operationId, cwd: "/workspace",
    } })).resolves.toEqual({ disposition: "session_ended" });
  });

  it("retains provider-initiated permission cancellation outside an intentional shutdown", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const runtimeId = await attached.connection.ensure(configuration);
    attached.connection.onEvent(runtimeId, () => {});
    const authority = { runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await attached.connection.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
    } });
    const native = f.sessions[0]!;
    const abort = new AbortController();
    const pending = native.options.canUseTool!("Read", {}, { requestId: "ask", toolUseID: "tool", signal: abort.signal });
    abort.abort();
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    await native.options.onPermissionResponseDeliveryFailed!({ requestId: "ask", toolUseID: "tool", error: new Error("provider_cancelled") });
    const snapshot = claudePersistentAttachmentSchema.parse(await attached.connection.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }));
    expect(snapshot.events.map(event => event.payload.kind)).toEqual(["permission_failed"]);
    expect(f.hosts.inspect(runtimeId).blockers).toEqual(["unsettled_outcome"]);
    await attached.connection.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: snapshot.events[0]!.sequence } });
    expect(f.hosts.inspect(runtimeId).blockers).toEqual([]);
  });
});


describe("Claude rejected sends and retained query failure", () => {
  it.each(["failed", "closed"] as const)("proves an unseen input was not sent only after its complete owner journal is %s", async ended => {
    const f = await fixture(); const carrier = await f.attach();
    const client = f.client(); const sessionId = randomUUID();
    const session = client.createSession(sessionOptions(sessionId));
    await session.start();
    const native = f.sessions[0]!;
    const admittedId = randomUUID(); const absentId = randomUUID();
    await session.send({ operationId: admittedId, content: "Already admitted" });
    const query = { sessionId, operationId: absentId, cwd: "/workspace" };
    await expect(client.submissionDisposition(query)).resolves.toBe("unknown");
    if (ended === "failed") native.options.onFailure?.(new Error("fixture_failed"));
    else native.closed = true;
    await expect(client.submissionDisposition(query)).resolves.toBe("not_sent");
    await expect(client.submissionDisposition({ ...query, operationId: admittedId })).resolves.toBe("session_ended");
    await expect(client.submissionDisposition({ ...query, cwd: "/other" })).resolves.toBe("unknown");
    const authority = { runtimeId: f.services.status().resources[0]!.resourceId, controllerEpoch: carrier.lease.controllerEpoch };
    await expect(carrier.connection.execute({ ...authority, action: "send", request: {
      queryId: sessionId, operationId: absentId, content: "Delayed input", priority: "next",
    } })).resolves.toEqual({ accepted: false, code: "claude_persistent_query_closed" });
    expect(native.send).toHaveBeenCalledTimes(1);
    await expect(client.submissionDisposition(query)).resolves.toBe("not_sent");
  });

  it("keeps a busy query attached and proves rejection before native delivery", async () => {
    const f = await fixture(); await f.attach();
    const onFailure = vi.fn();
    const sessionId = randomUUID();
    const session = f.client().createSession(sessionOptions(sessionId, { onFailure }));
    await session.start();
    const firstId = randomUUID(); const second = { operationId: randomUUID(), content: "second" };
    await session.send({ operationId: firstId, content: "first" });
    await expect(session.send(second)).rejects.toMatchObject({
      category: "invalid_state", crossedSubmissionBoundary: false,
      backendCode: "claude_persistent_query_busy",
    });
    expect(onFailure).not.toHaveBeenCalled();
    expect(f.sessions[0]!.closed).toBe(false);
    expect(f.sessions[0]!.send).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(false);
    await f.sessions[0]!.emit({ type: "result", session_id: sessionId, uuid: randomUUID(), user_message_uuid: firstId } as SDKMessage);
    await session.send(second);
    expect(f.sessions[0]!.send).toHaveBeenCalledTimes(2);
  });

  it("detects an unexpectedly closed query on reattachment without a failure callback", async () => {
    const f = await fixture();
    await f.attach();
    const sessionId = randomUUID();
    const original = f.client().createSession(sessionOptions(sessionId));
    await original.start();
    await original.close();
    f.sessions[0]!.closed = true;

    const onFailure = vi.fn();
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume", onFailure }));
    await restored.start();
    await expect(restored.flushMessages!()).rejects.toMatchObject({
      category: "unavailable", backendCode: "claude_persistent_query_closed",
    });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it("retains query failure after its event was acknowledged and main was replaced", async () => {
    const f = await fixture(); const carrier = await f.attach();
    const sessionId = randomUUID(); const onFailure = vi.fn();
    const session = f.client().createSession(sessionOptions(sessionId, { onFailure }));
    await session.start();
    const native = f.sessions[0]!;
    native.closed = true;
    native.options.onFailure?.(new Error("simulated_native_exit"));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await expect(session.flushMessages!()).rejects.toMatchObject({ backendCode: "claude_persistent_query_failed" });
    await session.close();
    const runtimeId = f.services.status().resources[0]!.resourceId;
    const retained = claudePersistentAttachmentSchema.parse(await carrier.connection.execute({
      runtimeId, controllerEpoch: carrier.lease.controllerEpoch,
      action: "attach", replay: "full", request: { sessionId },
    }));
    expect(retained.events).toEqual([]);
    expect(retained.failureCode).toBe("claude_persistent_query_failed");
    const replacementFailure = vi.fn();
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume", onFailure: replacementFailure }));
    await restored.start();
    await expect(restored.flushMessages!()).rejects.toMatchObject({
      category: "unavailable", backendCode: "claude_persistent_query_failed",
      safeMessage: expect.stringContaining("Restart the Claude backend"),
    });
    expect(replacementFailure).toHaveBeenCalled();
    expect(f.sessions).toHaveLength(1);
    expect(native.send).not.toHaveBeenCalled();
  });
});

describe("native next over persistent replacement carriers", () => {
  it("does not materialize parent inputs or retain replay from explicitly child-owned frames", async () => {
    const f = await fixture(); await f.attach();
    const sessionId = randomUUID(); const firstId = randomUUID(); const steerId = randomUUID();
    const seen: SDKMessage[] = []; const roots: string[] = [];
    const session = f.client().createSession(sessionOptions(sessionId, { onMessage: (message, evidence) => {
      seen.push(message); if (evidence) roots.push(evidence.consumedTurnRootUuid);
    } }));
    await session.start();
    await session.send({ operationId: firstId, content: "Parent input" });
    await session.send({ operationId: steerId, priority: "next", content: "Parent correction" });
    const native = f.sessions[0]!;
    const host = f.hosts.get(f.services.status().resources[0]!.resourceId);
    for (const childIdentity of [{ parent_tool_use_id: "child-agent-launch" }, { parent_tool_use_id: null, subagent_type: "Explore" }]) {
      await native.emit({ type: "assistant", uuid: randomUUID(), session_id: sessionId, ...childIdentity,
        message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: {} }], stop_reason: "tool_use", usage: {} },
      } as unknown as SDKMessage);
      await native.emit({ type: "user", uuid: randomUUID(), session_id: sessionId, ...childIdentity,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-read", content: "Child result" }] },
      } as unknown as SDKMessage);
      await native.emit({ ...delta(sessionId, "Child output"), ...childIdentity,
        user_message_uuid: steerId, user_message_uuids: [firstId, steerId] } as SDKMessage);
    }
    await session.flushMessages?.();
    expect(host.abandonmentEvidence().sessions[0]).toMatchObject({
      pendingInputIds: [firstId, steerId], activeOperationIds: [firstId, steerId], retainedEventCount: 0,
    });
    expect(seen).toEqual([]);
    expect(roots).toEqual([]);
    await native.emit({ ...delta(sessionId, "Main output"),
      user_message_uuid: steerId, user_message_uuids: [firstId, steerId] } as SDKMessage);
    await session.flushMessages?.();
    await vi.waitFor(() => expect(seen.filter(message => message.type === "user").map(message => message.uuid)).toEqual([firstId, steerId]));
    expect(roots).toEqual([firstId]);
    expect(host.abandonmentEvidence().sessions[0]?.pendingInputIds).toEqual([]);
    expect(native.send).toHaveBeenCalledTimes(2);
  });

  it("releases previously consumed inputs when the terminal UUID list is capped", async () => {
    const f = await fixture(); await f.attach();
    const sessionId = randomUUID();
    const session = f.client().createSession(sessionOptions(sessionId));
    await session.start();
    const native = f.sessions[0]!;
    const consumed: string[] = [];
    for (let index = 0; index < 66; index++) {
      const operationId = randomUUID(); consumed.push(operationId);
      await session.send({ operationId, content: `Input ${index}`, ...(index ? { priority: "next" as const } : {}) });
      await native.emit({ ...delta(sessionId, `Reply ${index}`),
        user_message_uuid: operationId, user_message_uuids: consumed.slice(-64),
      } as SDKMessage);
    }
    await native.emit({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sessionId,
      user_message_uuid: consumed.at(-1), user_message_uuids: consumed.slice(-64),
      num_turns: 1, result: "Done", is_error: false, queued_turn_count: 0,
    } as SDKMessage);
    await session.flushMessages?.();
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual([]));
    await session.send({ operationId: randomUUID(), content: "Another turn" });
    expect(native.send).toHaveBeenCalledTimes(67);
  });

  it("admits steer while busy, waits for its exact stamp, retains it across the older result and reconnect", async () => {
    const f = await fixture(); const carrier = await f.attach();
    const sessionId = randomUUID(); const firstId = randomUUID(); const steerId = randomUUID();
    const seen: SDKMessage[] = [];
    const session = f.client().createSession(sessionOptions(sessionId, { onMessage: message => { seen.push(message); } }));
    await session.start();
    await session.send({ operationId: firstId, content: "First" });
    const native = f.sessions[0]!;
    await native.options.onMessage(firstDelta(sessionId, "First output", firstId));
    await vi.waitFor(() => expect(seen.some(message => message.type === "user" && message.uuid === firstId)).toBe(true));
    await session.send({ operationId: steerId, content: "Correction", priority: "next" });
    await native.options.onMessage(acceptedInput(sessionId, { operationId: steerId, content: "Correction" }) as SDKMessage);
    await native.options.onMessage(delta(sessionId, "Old output"));
    await session.flushMessages?.();
    // Native echo may be delivered, but only the later owner event carries
    // consumption evidence. The handle ignores this first pending echo.
    await vi.waitFor(() => expect(seen.filter(message => message.type === "user" && message.uuid === steerId)).toHaveLength(1));
    const terminal = (ids: string[]) => ({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sessionId,
      user_message_uuid: ids.at(-1), user_message_uuids: ids, num_turns: 1, terminal_reason: "completed",
      result: "Done", is_error: false, queued_turn_count: 0, usage: {}, modelUsage: {}, permission_denials: [] }) as unknown as SDKMessage;
    await native.options.onMessage(terminal([firstId]));
    await session.flushMessages?.();
    // Native echo may be delivered, but only the later owner event carries
    // consumption evidence. The handle ignores this first pending echo.
    await vi.waitFor(() => expect(seen.filter(message => message.type === "user" && message.uuid === steerId)).toHaveLength(1));
    await carrier.close(); await f.attach();
    const restoredSeen: SDKMessage[] = []; const consumedRoots: string[] = [];
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume", onMessage: (message, evidence) => {
      restoredSeen.push(message); if (evidence) consumedRoots.push(evidence.consumedTurnRootUuid);
    } }));
    await restored.start();
    await restored.send({ operationId: steerId, content: "Correction", priority: "next" });
    expect(native.send).toHaveBeenCalledTimes(2);
    expect(native.send).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: steerId, priority: "next" }));
    await native.options.onMessage(terminal([steerId]));
    await vi.waitFor(() => expect(consumedRoots).toEqual([steerId]));
    await restored.flushMessages?.();
    expect(restoredSeen.filter(message => message.type === "result" && message.user_message_uuid === steerId)).toHaveLength(1);
  });
});

describe("persistent owner run-state evidence", () => {
  it("materializes an ordinary input only at Claude's exact dequeue, never from unstamped output", async () => {
    const f = await fixture(); await f.attach();
    const sessionId = randomUUID(); const operationId = randomUUID();
    const seen: SDKMessage[] = [];
    const session = f.client().createSession(sessionOptions(sessionId, { onMessage: message => { seen.push(message); } }));
    await session.start();
    await session.send({ operationId, content: "Queued behind Claude's own turn" });
    const native = f.sessions[0]!;
    const host = f.hosts.get(f.services.status().resources[0]!.resourceId);
    // Claude finishes a turn it started itself before dequeuing the input.
    const providerOutput = delta(sessionId, "Notification turn output");
    await native.emit(lifecycle(sessionId, operationId, "queued"));
    await native.emit(providerOutput);
    await native.emit({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sessionId,
      origin: { kind: "task-notification" }, num_turns: 1, result: "Notified", is_error: false } as unknown as SDKMessage);
    await session.flushMessages?.();
    expect(seen.some(message => message.type === "user")).toBe(false);
    expect(host.abandonmentEvidence().sessions[0]).toMatchObject({ pendingInputIds: [operationId], activeOperationIds: [operationId] });
    const started = lifecycle(sessionId, operationId, "started");
    await native.emit(started);
    await session.flushMessages?.();
    await vi.waitFor(() => expect(seen.map(message => message.type)).toEqual([
      "command_lifecycle", "stream_event", "result", "user", "command_lifecycle",
    ]));
    expect(seen[3]).toEqual(acceptedInput(sessionId, { operationId, content: "Queued behind Claude's own turn" }));
    expect(host.abandonmentEvidence().sessions[0]?.pendingInputIds).toEqual([]);
  });

  it("counts Claude's own running state as active work for upgrade and idle retirement", async () => {
    const f = await fixture(); const carrier = await f.attach();
    const sessionId = randomUUID();
    const session = f.client().createSession(sessionOptions(sessionId));
    await session.start();
    const native = f.sessions[0]!;
    const state = (value: "idle" | "running") => ({ type: "system", subtype: "session_state_changed", state: value,
      uuid: randomUUID(), session_id: sessionId }) as SDKMessage;
    await native.emit(state("running"));
    await session.flushMessages?.();
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual(["active_work"]));
    const runtimeId = f.services.status().resources[0]!.resourceId;
    await carrier.connection.execute({ runtimeId, controllerEpoch: carrier.lease.controllerEpoch,
      action: "evict", request: { sessionId } });
    // A turn Claude started itself must not be killed by idle retirement.
    expect(native.closed).toBe(false);
    await session.close();
    const restored = f.client().createSession(sessionOptions(sessionId, { launch: "resume" }));
    await restored.start();
    await native.emit(state("idle"));
    await restored.flushMessages?.();
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual([]));
    await restored.close({ reason: "evicted" });
    await vi.waitFor(() => expect(native.closed).toBe(true));
  });
});

describe("persistent event acknowledgement pipelining", () => {
  it("applies events in order without waiting one acknowledgement round trip each, within a bounded window", async () => {
    const f = await fixture(); await f.attach();
    const sessionId = randomUUID();
    const seen: string[] = [];
    const session = f.client().createSession(sessionOptions(sessionId, { onMessage: message => {
      if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
        seen.push(message.event.delta.text);
      }
    } }));
    await session.start();
    const host = f.hosts.get(f.services.status().resources[0]!.resourceId);
    let releaseAcknowledgements!: () => void;
    const acknowledgementsHeld = new Promise<void>(resolve => { releaseAcknowledgements = resolve; });
    const execute = host.execute.bind(host);
    vi.spyOn(host, "execute").mockImplementation(async (command, listener) => {
      if (command.action === "acknowledge") await acknowledgementsHeld;
      return await execute(command, listener);
    });
    const texts = Array.from({ length: CLAUDE_PERSISTENT_PIPELINED_ACKNOWLEDGEMENTS + 4 }, (_, index) => `chunk-${index}`);
    for (const text of texts) await f.sessions[0]!.emit(delta(sessionId, text));
    // Every in-window event is applied while all acknowledgements are held;
    // the next event is applied and then waits for an acknowledgement slot.
    await vi.waitFor(() => expect(seen).toEqual(texts.slice(0, CLAUDE_PERSISTENT_PIPELINED_ACKNOWLEDGEMENTS + 1)));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen).toHaveLength(CLAUDE_PERSISTENT_PIPELINED_ACKNOWLEDGEMENTS + 1);
    expect(host.abandonmentEvidence().sessions[0]?.retainedEventCount).toBe(texts.length);
    releaseAcknowledgements();
    await session.flushMessages?.();
    expect(seen).toEqual(texts);
    expect(host.abandonmentEvidence().sessions[0]?.retainedEventCount).toBe(0);
  });
});

describe("persistent retained-event accounting", () => {
  async function openDirect() {
    const f = await fixture();
    const attached = await f.attach();
    const host = f.hosts.ensure(configuration, attached.lease.controllerEpoch);
    const authority = { runtimeId: host.runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    const delivered: ClaudePersistentEvent[] = [];
    const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
    await host.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {},
    } }, listener);
    const replay = async () => claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, listener));
    const detach = async () => { await host.execute({ ...authority, action: "detach", request: { sessionId } }, listener); };
    return { f, host, authority, sessionId, delivered, listener, replay, detach, native: f.sessions[0]! };
  }
  const texts = (events: readonly ClaudePersistentEvent[]) => events.map(event => {
    const message = event.payload.kind === "message" ? event.payload.message as unknown as { event?: { delta?: { text?: string } } } : undefined;
    return message?.event?.delta?.text;
  });

  it("counts each unacknowledged message once, so a disconnected main can fall behind by the full bound", async () => {
    const { host, sessionId, native, f } = await openDirect();
    // Main receives these but never acknowledges them. Before, each counted in
    // both the journal and the replay map and the query failed at 4,095.
    for (let index = 0; index < CLAUDE_PERSISTENT_RETAINED_EVENT_LIMIT; index++) await native.emit(delta(sessionId, `${index} `));
    expect(host.abandonmentEvidence().sessions[0]?.retainedEventCount).toBe(CLAUDE_PERSISTENT_RETAINED_EVENT_LIMIT);
    expect(native.close).not.toHaveBeenCalled();
    await expect(native.emit(delta(sessionId, "overflow"))).rejects.toThrow("claude_persistent_event_capacity_exceeded");
    expect(native.close).toHaveBeenCalledTimes(1);
    await f.stop(true);
  });

  it("folds deltas no main was offered, keeping offered, stamped and non-adjacent frames exact", async () => {
    const { host, sessionId, native, delivered, replay, detach, f } = await openDirect();
    await native.emit(delta(sessionId, "offered "));
    expect(delivered).toHaveLength(1);
    await detach();
    // The offered frame may already be applied without its acknowledgement.
    for (const text of ["a", "b", "c"]) await native.emit(delta(sessionId, text));
    await native.emit({ type: "tool_progress", tool_use_id: "tool-1", tool_name: "Bash", parent_tool_use_id: null,
      elapsed_time_seconds: 1, uuid: randomUUID(), session_id: sessionId } as SDKMessage);
    await native.emit(delta(sessionId, "d"));
    await native.emit(firstDelta(sessionId, "e", randomUUID()));
    await native.emit(delta(sessionId, "f"));
    for (let index = 0; index < 20_000; index++) await native.emit(delta(sessionId, "g"));
    expect(delivered).toHaveLength(1);
    const attachment = await replay();
    expect(texts(attachment.events)).toEqual(["offered ", "abc", undefined, "d", "e", `f${"g".repeat(20_000)}`]);
    expect(attachment.events[0]!.sequence).toBe(delivered[0]!.sequence);
    expect(host.abandonmentEvidence().sessions[0]?.retainedEventCount).toBe(6);
    // Everything retained was offered by that attachment; live frames stay exact.
    for (const text of ["h", "i"]) await native.emit(delta(sessionId, text));
    expect(texts(delivered.slice(1))).toEqual(["h", "i"]);
    expect(host.abandonmentEvidence().sessions[0]?.retainedEventCount).toBe(8);
    await f.stop(true);
  });
});

describe("persistent host shutdown evidence", () => {
  const result = (sessionId: string, operationId: string): SDKMessage => ({ type: "result", subtype: "success", duration_ms: 0, duration_api_ms: 0,
    is_error: false, num_turns: 1, result: "Done.", stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    uuid: randomUUID(), session_id: sessionId, user_message_uuid: operationId, user_message_uuids: [operationId] }) as unknown as SDKMessage;
  const running = (sessionId: string) => ({ type: "system", subtype: "session_state_changed", state: "running",
    uuid: randomUUID(), session_id: sessionId }) as SDKMessage;
  type Evidence = { phase: string; startedAfterConfirmation?: boolean;
    sessions: { sessionId: string; liveWork: boolean; events: { kind: string; messageType?: string }[] }[] };
  const evidence = (archive: ReturnType<typeof vi.fn>) => archive.mock.calls.map(([record]) => (record as { evidence: Evidence }).evidence);

  it("fails only interrupted work on a forced stop and keeps a settled session's unacknowledged result", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const host = f.hosts.ensure(configuration, attached.lease.controllerEpoch);
    const authority = { runtimeId: host.runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const delivered: ClaudePersistentEvent[] = [];
    const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
    const [settled, interrupted] = [randomUUID(), randomUUID()];
    const operations = new Map<string, string>();
    for (const sessionId of [settled, interrupted]) {
      await host.execute({ ...authority, action: "open", replay: "full", request: {
        queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {} } }, listener);
      const operationId = randomUUID();
      operations.set(sessionId, operationId);
      await host.execute({ ...authority, action: "send", request: { queryId: sessionId, operationId, content: "Work." } }, listener);
      await f.sessions.find(session => session.options.sessionId === sessionId)!.emit(lifecycle(sessionId, operationId, "started"));
    }
    // Main never acknowledges this result, as when it restarted meanwhile.
    await f.sessions.find(session => session.options.sessionId === settled)!.emit(result(settled, operations.get(settled)!));
    await f.stop(true);
    const [before, after] = evidence(f.archive);
    expect(before!.phase).toBe("before_shutdown");
    expect(before!.sessions.map(({ sessionId, liveWork }) => [sessionId, liveWork])).toEqual([[settled, false], [interrupted, true]]);
    const kinds = (sessionId: string) => after!.sessions.find(session => session.sessionId === sessionId)!.events.map(event => event.messageType ?? event.kind);
    expect(after!.phase).toBe("after_shutdown");
    expect(kinds(settled)).toEqual(["user", "command_lifecycle", "result"]);
    expect(kinds(interrupted)).toEqual(["user", "command_lifecycle", "failed"]);
    expect(delivered.filter(event => event.payload.kind === "failed").map(event => event.sessionId)).toEqual([interrupted]);
  });

  it("records a hard handover when Claude starts work after an unforced stop was confirmed", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const host = f.hosts.ensure(configuration, attached.lease.controllerEpoch);
    const authority = { runtimeId: host.runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await host.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {} } }, () => {});
    await host.execute({ ...authority, action: "detach", request: { sessionId } }, () => {});
    expect(host.snapshot().blockers).toEqual([]);
    const native = f.sessions[0]!;
    // A task notification wakes Claude while the idle stop reads its history.
    f.runtime.getSessionInfo.mockImplementationOnce(async () => { await native.emit(running(sessionId)); return undefined; });
    await expect(host.stop(false, "sidecar_service_replacement")).rejects.toThrow("sidecar_resource_handoff_pending");
    expect(native.closed).toBe(true);
    expect(evidence(f.archive)).toEqual([expect.objectContaining({ phase: "before_shutdown", startedAfterConfirmation: true,
      sessions: [expect.objectContaining({ sessionId, liveWork: true })] })]);
    // Its retained frame is recovery evidence; once applied, the stop completes.
    const retained = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "unacknowledged", request: { sessionId } }, () => {}));
    for (const event of retained.events) await host.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: event.sequence } }, () => {});
    await host.stop(false, "sidecar_service_replacement");
    expect(evidence(f.archive).at(-1)).toMatchObject({ phase: "after_shutdown", startedAfterConfirmation: true });
  });

  it("writes no abandonment record for an unforced stop that ended nothing", async () => {
    const f = await fixture();
    const attached = await f.attach();
    const host = f.hosts.ensure(configuration, attached.lease.controllerEpoch);
    const authority = { runtimeId: host.runtimeId, controllerEpoch: attached.lease.controllerEpoch };
    const sessionId = randomUUID();
    await host.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", enableCanUseTool: false, environment: {} } }, () => {});
    await host.stop(false, "sidecar_service_replacement");
    expect(f.archive).not.toHaveBeenCalled();
  });
});
