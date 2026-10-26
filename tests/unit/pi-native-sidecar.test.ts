import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SidecarFrameWriteError, SidecarOperationRegistry, SidecarProtocolPeer, controlHelloOperation,
  registerControlV2Operations, type SidecarFrame, type SidecarFrameSendOptions, type SidecarFrameTransport,
  type SidecarTransportClosure } from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel, type SidecarRuntimeLease, type SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { sidecarRuntimeBodySchema } from "../../src/server/sidecar/runtime-body-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { PiNativeHost, type PiNativeSessionLauncher } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiNativeHostRegistry } from "../../src/server/backends/pi/native/host/host-registry.js";
import { PiNativeRemotePort } from "../../src/server/backends/pi/native/sidecar/remote-port.js";
import { registerPiNativeHost } from "../../src/server/backends/pi/native/sidecar/register-host.js";
import { piNativeExecuteOperation } from "../../src/server/backends/pi/native/sidecar/wire.js";
import { PiNativeError, type PiNativePort, type PiNativeRuntimeConfiguration } from "../../src/server/backends/pi/native/port.js";
import { rpc } from "../../src/server/backends/pi/native/driver/port-session.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import type { BackendModuleConfigurationInput, BackendRuntimeRecoveryContext } from "../../src/server/backends/module.js";
import { recoverPiNativeRuntimeAdministration } from "../../src/server/backends/pi/native/runtime-administration.js";
import { PiNativeBackendModule } from "../../src/server/backends/pi/native/pi-native-backend-module.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const configuration: PiNativeRuntimeConfiguration = { ...scope, backendInstanceId: "backend", executionEnvironmentId: "remote", initializationTimeoutMs: 1000, projectTrusted: false };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const identity = { sessionId: "native-session", sessionFile: "/workspace/native.jsonl", cwd: "/workspace" };
const idleState = { ...identity, isStreaming: false, isCompacting: false, pendingMessageCount: 0, isIdle: true };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(options: { maximumEventBytes?: number; maximumOperations?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-pi-sidecar-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, executionEnvironmentId: "remote", installationId: "installation" },
    buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration });
  const requests = vi.fn(async (command: unknown): Promise<unknown> => ["get_state", "snapshot"].includes((command as { type: string }).type) ? idleState : { ok: true });
  const launches = vi.fn();
  const close = vi.fn(async () => {});
  const respondUI = vi.fn(async () => {});
  const releaseWriter = vi.fn(async () => {});
  const ended = deferred<void>();
  const createHost = vi.fn((runtime: PiNativeRuntimeConfiguration, key: Uint8Array) => {
    const launch: PiNativeSessionLauncher = async input => {
      launches(input);
      return { rpc: { request: requests, respondUI, closed: ended.promise },
        bridge: { request: requests, closed: ended.promise }, close, version: "1.4.0" } as unknown as Awaited<ReturnType<PiNativeSessionLauncher>>;
    };
    const host = new PiNativeHost({ configuration: runtime, channels: {} as ExecutionEnvironmentChannelProvider,
      environment: {}, authenticationKey: key, launch, acquireWriter: async () => ({ release: releaseWriter }), observationWaitMs: 1, ...options,
      store: { resolveSessionDirectory: async () => "/execution-host/canonical/sessions", create: async () => identity, fork: async () => identity, reconcileFork: async () => null, listSessions: async () => ({ sessions: [] }),
        readHistory: async () => ({ ...identity, entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" }) } });
    cleanup.push(() => host.close());
    return host;
  });
  const hosts = new PiNativeHostRegistry({ scope, executionEnvironmentId: "remote", channels: {} as ExecutionEnvironmentChannelProvider,
    environment: {}, serviceDirectory: directory, services, createHost });
  return { services, hosts, createHost, requests, close, respondUI, releaseWriter, launches, ended };
}

async function attachment(f: Awaited<ReturnType<typeof fixture>>, mode: "normal" | "recovery" = "normal") {
  const left = new Transport(), right = new Transport(); left.peer = right; right.peer = left;
  const epoch = f.services.attach(serviceConfiguration, mode);
  const leftRegistry = new SidecarOperationRegistry(), rightRegistry = new SidecarOperationRegistry();
  const sedes = new SidecarProtocolPeer({ role: "sedes", transport: left, sessionNonce: "n".repeat(48), registry: leftRegistry });
  const sidecar = new SidecarProtocolPeer({ role: "sidecar", transport: right, sessionNonce: "n".repeat(48), registry: rightRegistry });
  const channel = new SidecarRuntimeChannel(sedes, leftRegistry), hostChannel = new SidecarRuntimeChannel(sidecar, rightRegistry);
  const detach = registerPiNativeHost({ registry: rightRegistry, channel: hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: epoch });
  const capabilities = rightRegistry.capabilities().map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }));
  registerControlV2Operations(rightRegistry, { buildId: "test", artifactSha256: "a".repeat(64), enabledSidecarCapabilities: capabilities, enabledSedesCapabilities: leftRegistry.capabilities() });
  sedes.start(); sidecar.start();
  await sedes.call(controlHelloOperation, { compression: "none", expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), authorizedSidecarCapabilities: capabilities, offeredSedesCapabilities: leftRegistry.capabilities() });
  const release = vi.fn();
  const lease: SidecarRuntimeLease = { channel, controllerEpoch: epoch, serviceIncarnation: f.services.serviceIncarnation, closed: left.closed, release };
  let disconnected = false;
  const disconnect = async () => {
    if (disconnected) return; disconnected = true;
    detach(); f.services.detach(epoch); channel.close(); hostChannel.close(); await sedes.close("test_complete");
  };
  cleanup.push(disconnect);
  return { lease, channel, disconnect, release, epoch };
}
function proxy(lease: SidecarRuntimeLease, existingOnly = false) {
  const runtime = { acquire: vi.fn(async () => lease), acquireExisting: vi.fn(async () => lease) } satisfies SidecarRuntimeProvider;
  const port = new PiNativeRemotePort({ configuration, sidecarRuntime: runtime, existingOnly });
  cleanup.push(() => port.close());
  return { port, runtime };
}
function recoveryContext(lease: SidecarRuntimeLease): BackendRuntimeRecoveryContext {
  return {
    database: { prepare: () => ({ get: () => undefined }) } as unknown as BackendRuntimeRecoveryContext["database"],
    scope,
    instance: { id: configuration.backendInstanceId, tenantId: scope.tenantId, kind: "pi_native", label: "Pi", enabled: false, protocolRelease: "1.4.0", configurationRevision: 0 },
    connections: ["first", "disabled"].map(id => ({ id: `profile-${id}`, templateId: id, kind: "pi_rpc", tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId, backendInstanceId: configuration.backendInstanceId, executionEnvironmentId: configuration.executionEnvironmentId,
      label: id, enabled: false, configurationRevision: 0 })),
    sidecarRuntime: { acquireRecovery: vi.fn(async () => lease) },
  };
}

describe("native Pi persistent sidecar", () => {
  it("releases timed-out remote observations only after settlement and preserves Stop admission", async () => {
    const f = await fixture({ maximumOperations: 5 }), first = await attachment(f), { port } = proxy(first.lease);
    const { handleId } = await port.attach(identity);
    for (let index = 0; index < 6; index++) {
      const pending = deferred<unknown>(), cancellation = new AbortController();
      f.requests.mockImplementation(async command => (command as { type: string }).type === "snapshot" ? pending.promise : { ok: true });
      const read = { handleId, operationId: `read-${index}` };
      await port.request({ ...read, retainOutcome: false, command: { channel: "companion", command: { type: "snapshot" } } }, cancellation.signal);
      cancellation.abort();
      expect(await port.abandonObservation(read)).toBe("pending");
      expect(await port.outcome(read)).toEqual({ status: "pending" });
      const stopIds: string[] = [];
      for (const [channel, type] of [["companion", "begin_stop"], ["rpc", "clear_queue"], ["rpc", "abort"], ["companion", "end_stop"]] as const) {
        const operationId = `stop-${index}-${type}`; stopIds.push(operationId);
        await port.request({ handleId, operationId, retainOutcome: true, command: { channel, command: { type } } });
        await vi.waitFor(async () => expect((await port.outcome({ handleId, operationId })).status).toBe("completed"));
      }
      for (const operationId of stopIds) await port.acknowledgeOperation({ handleId, operationId });
      pending.resolve({ entries: ["retained snapshot".repeat(1000)] });
      await vi.waitFor(async () => expect(await port.abandonObservation(read)).toBe("released"));
      expect(await port.abandonObservation(read)).toBe("released");
      await expect(port.outcome(read)).rejects.toThrow("pi_native_operation_unknown");
    }
    expect(await port.abandonObservation({ handleId, operationId: "missing" })).toBe("released");
    const retained = { handleId, operationId: "retained" };
    await port.request({ ...retained, retainOutcome: true, command: { channel: "rpc", command: { type: "abort" } } });
    await expect(port.abandonObservation(retained)).rejects.toThrow("pi_native_observation_abandon_denied");
    await vi.waitFor(async () => expect((await port.outcome(retained)).status).toBe("completed"));
    expect(await port.outcome(retained)).toEqual({ status: "completed", result: { ok: true } });
    await expect(port.abandonObservation({ ...retained, extra: true } as typeof retained)).rejects.toMatchObject({ delivery: "not_sent" });
  });

  it("preserves cancellation capacity after refused reads, recovers a lost request, and rejects its late frame", async () => {
    const f = await fixture(), connection = await attachment(f), { port, runtime } = proxy(connection.lease);
    const session = await port.attach(identity), original = connection.channel.call.bind(connection.channel);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "companion", payload: { type: "state_changed" } });
    const abandon = vi.spyOn(port, "abandonObservation");
    const refusal = vi.spyOn(port, "request").mockImplementation(async () => { throw new PiNativeError("pi_native_operation_capacity", "not_sent"); });
    try {
      // Even more refusals than the 4,096-marker budget must consume none.
      for (let index = 0; index < 4_100; index++) {
        await expect(rpc(port, session, { type: "get_state" }))
          .rejects.toMatchObject({ backendCode: "pi_native_operation_capacity", crossedSubmissionBoundary: false });
      }
      expect(abandon).not.toHaveBeenCalled();
    } finally { refusal.mockRestore(); }
    let missing: Parameters<PiNativePort["request"]>[0] | undefined;
    const call = vi.spyOn(connection.channel, "call").mockImplementation(async (...args) => {
      const command = await connection.channel.decodeBody(sidecarRuntimeBodySchema.parse(args[1])) as {
        action: string; input?: Parameters<PiNativePort["request"]>[0];
      };
      if (command.action === "request" && !missing) {
        missing = command.input!;
        throw Object.assign(new Error("request delivery unconfirmed"), { delivery: "sent_outcome_unknown" });
      }
      return original(...args);
    });
    try {
      await expect(rpc(port, session, { type: "get_state" })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
      expect(abandon).toHaveBeenCalledOnce();
      expect(missing).toMatchObject({ handleId: session.handleId, retainOutcome: false });
      expect(f.requests).not.toHaveBeenCalled();
      expect(await rpc(port, session, { type: "get_state" })).toEqual(idleState);
      expect(f.requests).toHaveBeenCalledTimes(1);
    } finally { call.mockRestore(); }
    await connection.disconnect();
    const replacement = await attachment(f);
    runtime.acquire.mockResolvedValue(replacement.lease);
    expect(await port.abandonObservation({ handleId: missing!.handleId, operationId: missing!.operationId })).toBe("released");
    await expect(port.request(missing!))
      .rejects.toMatchObject({ code: "pi_native_operation_abandoned", delivery: "sent_outcome_unknown" });
    await expect(port.request({ ...missing!, retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "late work" } } }))
      .rejects.toMatchObject({ code: "pi_native_operation_abandoned", delivery: "sent_outcome_unknown" });
    expect(await rpc(port, session, { type: "get_state" })).toEqual(idleState);
    expect(f.requests).toHaveBeenCalledTimes(2);
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("restores control-only gap recovery across carriers and cancels native dialogs only for explicit Stop", async () => {
    const f = await fixture({ maximumEventBytes: 1024 }), first = await attachment(f), original = proxy(first.lease);
    const session = await original.port.attach(identity);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "rpc", payload: { type: "agent_start" } });
    launch.onEvent?.({ kind: "rpc", payload: { type: "session_info_changed", name: "overflow".repeat(200) } });
    launch.onEvent?.({ kind: "rpc", payload: { type: "extension_ui_request", id: "dialog", method: "input", title: "Value" } });
    await first.disconnect();
    const next = await attachment(f, "recovery"), { port, runtime } = proxy(next.lease, true);
    expect(await port.attachForControl(identity)).toMatchObject({ handleId: session.handleId, generation: session.generation });
    expect(f.respondUI).not.toHaveBeenCalled();
    expect(f.requests).not.toHaveBeenCalled();
    await expect(port.request({ handleId: session.handleId, operationId: "denied", retainOutcome: true,
      command: { channel: "companion", command: { type: "resolve_tool_approval", id: "approval", approved: true } } }))
      .rejects.toMatchObject({ code: "pi_native_recovery_control_only", delivery: "not_sent" });
    await next.disconnect();
    const replacement = await attachment(f, "recovery");
    runtime.acquireExisting.mockResolvedValue(replacement.lease);
    await port.request({ handleId: session.handleId, operationId: "stop", retainOutcome: true,
      command: { channel: "companion", command: { type: "begin_stop" } } });
    await vi.waitFor(async () => expect((await port.outcome({ handleId: session.handleId, operationId: "stop" })).status).toBe("completed"));
    expect(f.respondUI).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "dialog", cancelled: true });
    await expect(port.observe({ handleId: session.handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(2);
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
  });

  it("recovers an observation gap through strict existing-only calls without replacing the host", async () => {
    const f = await fixture({ maximumEventBytes: 1024 }), first = await attachment(f), original = proxy(first.lease);
    const session = await original.port.attach(identity);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "rpc", payload: { type: "session_info_changed", name: "retained" } });
    launch.onEvent?.({ kind: "rpc", payload: { type: "session_info_changed", name: "overflow".repeat(200) } });
    await first.disconnect();
    const next = await attachment(f, "recovery"), { port, runtime } = proxy(next.lease, true);
    const drain = await port.attachForDrain(identity);
    expect(drain).toMatchObject({ handleId: session.handleId, closed: true, observationGap: true, throughSequence: 1 });
    const gap = { handleId: session.handleId, generation: session.generation, throughSequence: 1 };
    await expect(port.acknowledgeObservationGap({ ...gap, extra: true } as typeof gap)).rejects.toMatchObject({ delivery: "not_sent" });
    await expect(port.acknowledgeObservationGap({ ...gap, generation: "wrong" })).rejects.toThrow("pi_native_session_identity_mismatch");
    await expect(port.acknowledgeObservationGap(gap)).rejects.toThrow("pi_native_observation_recovery_unapplied");
    await next.disconnect();
    const replacement = await attachment(f, "recovery");
    runtime.acquireExisting.mockResolvedValue(replacement.lease);
    const page = await port.observe({ handleId: session.handleId, afterSequence: 0 });
    expect(page.events[0]?.payload).toMatchObject({ name: "retained" });
    await port.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    expect((await port.inspect()).blockers).toContain("unknown_state");
    await port.acknowledgeObservationGap(gap);
    expect((await port.inspect()).blockers).not.toContain("unknown_state");
    await port.release({ handleId: session.handleId });
    expect(["retired", "absent"]).toContain(await port.retireSession(identity));
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a residency drain separate from unrelated normal session operations", async () => {
    const f = await fixture(), first = await attachment(f), original = proxy(first.lease);
    const drained = await original.port.attach(identity);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "companion", payload: { type: "state_changed" } });
    await first.disconnect();
    const next = await attachment(f), { port, runtime } = proxy(next.lease);
    expect(await port.attachForDrain(identity)).toMatchObject({ handleId: drained.handleId });
    expect(runtime.acquire).not.toHaveBeenCalled();
    const other = await port.attach({ ...identity, sessionId: "other", sessionFile: "/workspace/other.jsonl" });
    const [page, outcome] = await Promise.all([
      port.observe({ handleId: drained.handleId, afterSequence: 0 }),
      port.request({ handleId: other.handleId, operationId: "send", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "other work" } } }),
    ]);
    expect(page.events).toHaveLength(1);
    expect(outcome.status).toBe("pending");
    expect(runtime.acquire).toHaveBeenCalledTimes(1);
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(1);
    await port.acknowledge({ handleId: drained.handleId, throughSequence: page.throughSequence });
    await port.release({ handleId: drained.handleId });
    await vi.waitFor(async () => expect((await port.outcome({ handleId: other.handleId, operationId: "send" })).status).toBe("completed"));
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(2);
  });

  it("resolves canonical session directories through strict read-only remote and recovery calls without launching Pi", async () => {
    const f = await fixture(), first = await attachment(f), original = proxy(first.lease);
    expect(await original.port.resolveSessionDirectory({ cwd: identity.cwd })).toBe("/execution-host/canonical/sessions");
    await expect(original.port.resolveSessionDirectory({ cwd: identity.cwd, unexpected: true } as { cwd: string })).rejects.toMatchObject({ delivery: "not_sent" });
    await first.disconnect();
    const next = await attachment(f, "recovery"), { port, runtime } = proxy(next.lease, true);
    expect(await port.resolveSessionDirectory({ cwd: identity.cwd })).toBe("/execution-host/canonical/sessions");
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).not.toHaveBeenCalled();
    expect(f.requests).not.toHaveBeenCalled();
  });

  it("accepts forced Stop during streaming and archives only an accepted confirmation before cleanup", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease);
    await port.attach(identity);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    const delta = () => launch.onEvent?.({ kind: "rpc", payload: { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "output" } } });
    launch.onEvent?.({ kind: "rpc", payload: { type: "agent_start" } });
    delta();
    const confirmed = await port.inspect();
    const archive = vi.spyOn(f.services, "recordAbandonment").mockImplementation(async record => {
      expect(record).toMatchObject({ resourceId: confirmed.runtimeId, reason: "operator_backend_stop", evidence: { revision: confirmed.revision } });
      expect(f.close).not.toHaveBeenCalled();
      delta();
    });
    for (let index = 0; index < 100; index++) delta();
    expect((await port.inspect()).revision).toBe(confirmed.revision);
    await expect(port.stop({ expectedRevision: "stale", force: true })).rejects.toThrow("pi_native_confirmation_stale");
    await expect(port.stop({ expectedRevision: confirmed.revision, force: false })).rejects.toThrow("pi_native_restart_blocked");
    expect(archive).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    await port.stop({ expectedRevision: confirmed.revision, force: true });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("drains changed-environment sessions through retained lookup and upgrades the next normal attachment", async () => {
    const f = await fixture(), first = await attachment(f), original = proxy(first.lease);
    const session = await original.port.attach({ ...identity, executionEnvironment: { MODE: { kind: "literal", value: "old" } } });
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "rpc", payload: { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "retained" } } });
    await first.disconnect();
    const next = await attachment(f), { port, runtime } = proxy(next.lease);
    runtime.acquire.mockRejectedValue(new Error("normal acquisition must not be used to drain"));
    expect(await port.attachForDrain(identity)).toMatchObject({ handleId: session.handleId, closed: false });
    expect(await port.readHistory(identity)).toMatchObject(identity);
    const page = await port.observe({ handleId: session.handleId, afterSequence: 0 });
    expect(page.events).toMatchObject([{ kind: "stream", payload: { type: "message_snapshot", text: "retained" } }]);
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(1);
    await port.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    await port.release({ handleId: session.handleId });
    expect(await port.retireSession(identity)).toBe("retired");
    runtime.acquire.mockResolvedValue(next.lease);
    expect(await port.attach({ ...identity, executionEnvironment: { MODE: { kind: "literal", value: "new" } } })).not.toMatchObject({ handleId: session.handleId });
    expect(runtime.acquire).toHaveBeenCalledTimes(1);
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(2);
  });

  it("keeps closed-session drain on existing-only carriers across reconnect", async () => {
    const f = await fixture(), first = await attachment(f), original = proxy(first.lease);
    const session = await original.port.attach(identity);
    const launch = f.launches.mock.calls[0]![0] as Parameters<PiNativeSessionLauncher>[0];
    launch.onEvent?.({ kind: "rpc", payload: { type: "extension_ui_request", id: "choice", method: "confirm", title: "Choose" } });
    f.ended.resolve();
    await first.disconnect();
    const next = await attachment(f, "recovery"), { port, runtime } = proxy(next.lease);
    expect(await port.attachForDrain(identity)).toMatchObject({ handleId: session.handleId, closed: true });
    await next.disconnect();
    const replacement = await attachment(f, "recovery");
    runtime.acquireExisting.mockResolvedValue(replacement.lease);
    const page = await port.observe({ handleId: session.handleId, afterSequence: 0 });
    expect(page.closed).toBe(true);
    expect(page.events.map(event => event.payload.type)).toEqual(["extension_ui_request", "failure"]);
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(2);
    expect((await port.inspect()).blockers).not.toContain("pending_interaction");
    await port.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    await port.release({ handleId: session.handleId });
    expect(["absent", "retired"]).toContain(await port.retireSession(identity));
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("preserves definite unsent validation failures across the host boundary", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease);
    const { handleId } = await port.attach(identity);
    await expect(port.request({ handleId, operationId: "invalid", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: 3 } } })).rejects.toMatchObject({ code: "pi_native_command_invalid", delivery: "not_sent" });
    expect((await port.attach(identity)).retainedOperationIds).toEqual([]);
    expect(f.requests).not.toHaveBeenCalled();
  });

  it("proves absent residency through existing-only lookup without creating a host", async () => {
    const f = await fixture(), first = await attachment(f), { port, runtime } = proxy(first.lease);
    expect(await port.retireSession(identity)).toBe("absent");
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(1);
    expect(f.createHost).not.toHaveBeenCalled();
    expect(f.launches).not.toHaveBeenCalled();
  });

  it("awaits proved native residency cleanup over the control lane", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease), closing = deferred<void>();
    const session = await port.attach(identity);
    f.close.mockImplementation(() => closing.promise);
    await port.release({ handleId: session.handleId });
    let complete = false;
    const result = port.retireSession(identity).then(value => { complete = true; return value; });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(complete).toBe(false);
    expect(f.releaseWriter).not.toHaveBeenCalled();
    closing.resolve();
    expect(await result).toBe("retired");
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
    expect(await port.retireSession(identity)).toBe("absent");
  });

  it("preserves cleanup failure and exact identity through remote residency release", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease);
    const session = await port.attach(identity);
    await expect(port.retireSession({ ...identity, sessionId: "wrong" })).rejects.toThrow("pi_native_session_identity_mismatch");
    expect(await port.retireSession(identity)).toBe("busy");
    f.close.mockRejectedValue(new Error("still alive"));
    await port.release({ handleId: session.handleId });
    await expect(port.retireSession(identity)).rejects.toThrow("pi_native_cleanup_unproven");
    expect(f.releaseWriter).not.toHaveBeenCalled();
    f.close.mockResolvedValue();
    expect(await port.retireSession(identity)).toBe("retired");
  });

  it("never turns unavailable retained residency into confirmed absence", async () => {
    const f = await fixture(), first = await attachment(f), { port, runtime } = proxy(first.lease);
    await port.attach(identity);
    runtime.acquireExisting.mockRejectedValue(new Error("carrier unavailable"));
    await expect(port.retireSession(identity)).rejects.toThrow("carrier unavailable");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("transports strict fork settings and reconciles only the reserved child", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease);
    const host = await f.hosts.ensure(configuration, first.epoch);
    const reconcile = vi.spyOn(host, "reconcileFork").mockResolvedValue(identity);
    const input = { cwd: identity.cwd, sourceSessionId: "source", sourceSessionFile: "/workspace/source.jsonl", sourceEntryId: "entry",
      childSessionId: identity.sessionId, operationId: "fork", inheritedSettings: { model: { provider: "provider", id: "model" }, thinkingLevel: "low" as const, toolAccess: "read_only" as const } };
    expect(await port.reconcileFork(input)).toEqual(identity);
    expect(reconcile.mock.calls[0]?.[0]).toEqual(input);
    await expect(port.reconcileFork({ ...input, inheritedSettings: { ...input.inheritedSettings, surprise: true } } as typeof input)).rejects.toThrow();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("carries only the strict main-owned tool environment beside user overrides", async () => {
    const f = await fixture(), first = await attachment(f), { port } = proxy(first.lease);
    await port.attach({ ...identity, executionEnvironment: { CUSTOM: { kind: "literal", value: "custom" } },
      agentToolEnvironment: { SEDES_AGENT_TOOL_ENDPOINT: null, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "authority", PATH: "/tools:/bin" } });
    expect(f.launches.mock.calls[0]?.[0].executionEnvironment).toEqual({ CUSTOM: "custom", SEDES_AGENT_TOOL_ENDPOINT: null,
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "authority", PATH: "/tools:/bin" });
    await expect(port.attach({ ...identity, agentToolEnvironment: { NODE_OPTIONS: "--inspect" } as never })).rejects.toThrow();
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("preserves the native owner and accepted operation across carrier replacement", async () => {
    const f = await fixture(), first = await attachment(f), pending = deferred<unknown>();
    f.requests.mockImplementation(() => pending.promise);
    const { port, runtime } = proxy(first.lease);
    const session = await port.attach(identity);
    expect(await port.readHistory(session)).toMatchObject(identity);
    await port.request({ handleId: session.handleId, operationId: "send", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "hello" } } });
    await first.disconnect();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.releaseWriter).not.toHaveBeenCalled();
    const next = await attachment(f);
    runtime.acquire.mockResolvedValue(next.lease);
    pending.resolve({ accepted: true });
    await vi.waitFor(async () => expect(await port.outcome({ handleId: session.handleId, operationId: "send" })).toEqual({ status: "completed", result: { accepted: true } }));
    expect(await port.attach(identity)).toMatchObject({ handleId: session.handleId, retainedOperationIds: ["send"] });
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveBeenCalledTimes(1);
    await port.close();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("disposes only known local handles after the remote port closes without contacting the service", async () => {
    const f = await fixture(), connection = await attachment(f), { port } = proxy(connection.lease);
    const session = await port.attach(identity);
    await port.close();
    const call = vi.spyOn(connection.channel, "call");
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    expect(call).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.releaseWriter).not.toHaveBeenCalled();
    const replacement = proxy(connection.lease);
    expect(await replacement.port.attach(identity)).toMatchObject({ handleId: session.handleId });
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("uses existing-only recovery for inspection and controls while fencing new work", async () => {
    const f = await fixture(), first = await attachment(f), original = proxy(first.lease);
    const session = await original.port.attach(identity);
    await original.port.request({ handleId: session.handleId, operationId: "retained", retainOutcome: true, command: { channel: "rpc", command: { type: "get_state" } } });
    await first.disconnect();
    const next = await attachment(f, "recovery"), { port, runtime } = proxy(next.lease, true);
    expect((await port.inspect()).retainedSessions[0]?.handleId).toBe(session.handleId);
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(1);
    await expect(port.request({ handleId: session.handleId, operationId: "new", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "new" } } })).rejects.toThrow("pi_native_recovery_read_only");
    expect(await port.request({ handleId: session.handleId, operationId: "stop", retainOutcome: true, command: { channel: "rpc", command: { type: "abort" } } })).toEqual({ status: "pending" });
    await expect(port.attach({ ...identity, sessionFile: "/workspace/other.jsonl" })).rejects.toThrow("pi_native_recovery_read_only");
    expect(f.createHost).toHaveBeenCalledTimes(1);
  });

  it("distinguishes confirmed absence from loss of the execution host", async () => {
    const f = await fixture(), connection = await attachment(f, "recovery"), { port } = proxy(connection.lease, true);
    await expect(port.inspect()).rejects.toMatchObject({ code: "pi_native_retained_runtime_missing", delivery: "not_sent" });
    expect(f.createHost).not.toHaveBeenCalled();
    const unavailable = new PiNativeRemotePort({ configuration, existingOnly: true, sidecarRuntime: {
      acquire: async () => { throw new Error("must not start"); }, acquireExisting: async () => { throw new Error("host unavailable"); },
    } });
    cleanup.push(() => unavailable.close());
    await expect(unavailable.inspect()).rejects.toThrow("host unavailable");
  });

  it("never retries a command automatically after an uncertain wire response", async () => {
    const f = await fixture(), connection = await attachment(f), { port } = proxy(connection.lease);
    const session = await port.attach(identity), call = connection.channel.call.bind(connection.channel);
    vi.spyOn(connection.channel, "call").mockImplementationOnce(async (...args) => { await call(...args); throw new Error("response lost"); });
    await expect(port.request({ handleId: session.handleId, operationId: "send", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "hello" } } })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.requests).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await port.outcome({ handleId: session.handleId, operationId: "send" })).status).toBe("completed"));
    expect(f.requests).toHaveBeenCalledTimes(1);
  });

  it("releases exact handles after a separate administration port stops the host", async () => {
    const f = await fixture(), connection = await attachment(f), { port } = proxy(connection.lease);
    const session = await port.attach(identity);
    const administration = (await recoverPiNativeRuntimeAdministration({ context: recoveryContext(connection.lease), configuration }))!;
    await administration.stop({ expectedRevision: (await administration.inspect()).revision, force: true });
    expect(await f.hosts.lookupRetained(configuration.backendInstanceId, connection.epoch)).toBeUndefined();
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    await expect(port.attach(identity)).rejects.toThrow("pi_native_runtime_not_attached");
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
    expect(f.createHost).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost retirement release reply on the same service without creating a host", async () => {
    const f = await fixture(), first = await attachment(f), { port, runtime } = proxy(first.lease);
    const session = await port.attach(identity), inspection = await port.inspect();
    await port.stop({ expectedRevision: inspection.revision, force: true });
    const call = first.channel.call.bind(first.channel);
    vi.spyOn(first.channel, "call").mockImplementationOnce(async (...args) => { await call(...args); throw new Error("release reply lost"); });
    await expect(port.release({ handleId: session.handleId })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await first.disconnect();
    const next = await attachment(f, "recovery");
    runtime.acquireExisting.mockResolvedValue(next.lease);
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    expect(runtime.acquire).toHaveBeenCalledTimes(1);
    expect(runtime.acquireExisting).toHaveBeenCalledTimes(1);
    expect(f.createHost).toHaveBeenCalledTimes(1);
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    const other = await fixture(), replacement = await attachment(other, "recovery");
    runtime.acquireExisting.mockResolvedValue(replacement.lease);
    await expect(port.release({ handleId: session.handleId })).rejects.toThrow("pi_native_runtime_incarnation_changed");
    expect(other.createHost).not.toHaveBeenCalled();
  });

  it("keeps a lost ordinary release retry valid after session cleanup and a later host stop", async () => {
    const f = await fixture(), connection = await attachment(f), { port } = proxy(connection.lease);
    const session = await port.attach(identity), call = connection.channel.call.bind(connection.channel);
    vi.spyOn(connection.channel, "call").mockImplementationOnce(async (...args) => { await call(...args); throw new Error("release reply lost"); });
    await expect(port.release({ handleId: session.handleId })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await vi.waitFor(async () => expect((await port.inspect()).retainedSessions).toEqual([]));
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await port.stop({ expectedRevision: (await port.inspect()).revision, force: true });
    await expect(port.release({ handleId: session.handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.createHost).toHaveBeenCalledTimes(1);
  });

  it("checks controller metadata and the operation lane on the actual framed wire", async () => {
    const f = await fixture(), connection = await attachment(f), { port } = proxy(connection.lease);
    const inspection = await port.inspect();
    const send = async (value: unknown) => connection.channel.decodeBody(await connection.channel.call(piNativeExecuteOperation, await connection.channel.encodeBody(value)));
    await expect(send({ action: "attach", runtimeId: inspection.runtimeId, input: identity, controllerEpoch: connection.epoch + 1, serviceIncarnation: f.services.serviceIncarnation })).resolves.toMatchObject({ status: "failed", failure: { code: "pi_native_controller_stale" } });
    await expect(send({ action: "inspect", runtimeId: inspection.runtimeId, input: {}, controllerEpoch: connection.epoch, serviceIncarnation: f.services.serviceIncarnation })).resolves.toMatchObject({ status: "failed", failure: { code: "pi_native_operation_lane_invalid" } });
  });

  it("refuses a replacement service incarnation instead of ensuring a fresh runtime", async () => {
    const f = await fixture(), first = await attachment(f), { port, runtime } = proxy(first.lease);
    await port.inspect();
    await first.disconnect();
    const other = await fixture(), next = await attachment(other);
    runtime.acquire.mockResolvedValue(next.lease);
    await expect(port.inspect()).rejects.toThrow("pi_native_runtime_incarnation_changed");
    expect(other.createHost).not.toHaveBeenCalled();
  });

  it("uses a read-only retained attachment after a sidecar configuration revision changes", async () => {
    const f = await fixture(), first = await attachment(f), { port, runtime } = proxy(first.lease);
    const inspection = await port.inspect();
    await first.disconnect();
    const next = await attachment(f, "recovery");
    runtime.acquire.mockRejectedValueOnce(new Error("sidecar_revision_changed")).mockResolvedValue(next.lease);
    expect((await port.inspect()).runtimeId).toBe(inspection.runtimeId);
    expect(runtime.acquire).toHaveBeenLastCalledWith(expect.any(AbortSignal), { existingOnly: true });
    expect(f.createHost).toHaveBeenCalledTimes(1);
  });

  it("rechecks controller ownership after asynchronous abandonment recording", async () => {
    const f = await fixture(), connection = await attachment(f);
    const host = await f.hosts.ensure(configuration, connection.epoch), recording = deferred<void>();
    vi.spyOn(f.services, "recordAbandonment").mockImplementation(() => recording.promise);
    const authority = { assertCurrent: () => f.services.assertController(connection.epoch), assertAdmission: () => f.services.assertAdmission(connection.epoch) };
    const stopping = f.hosts.stop(host.runtimeId, host.snapshot().revision, true, undefined, authority);
    f.services.attach(serviceConfiguration);
    recording.resolve();
    await expect(stopping).rejects.toThrow("sidecar_controller_stale");
    expect(await f.hosts.lookupRetained(configuration.backendInstanceId, f.services.controllerEpoch)).toBe(host);
  });

  it("scope-checks registry creation and requires restart for identity edits", async () => {
    const f = await fixture(), connection = await attachment(f);
    await expect(f.hosts.ensure({ ...configuration, principalId: "other" }, connection.epoch)).rejects.toThrow("pi_native_configuration_scope_denied");
    const [first, second] = await Promise.all([f.hosts.ensure(configuration, connection.epoch), f.hosts.ensure(configuration, connection.epoch)]);
    expect(first).toBe(second); expect(f.createHost).toHaveBeenCalledTimes(1);
    await expect(f.hosts.ensure({ ...configuration, executablePath: "/other/pi" }, connection.epoch)).rejects.toThrow("pi_native_configuration_restart_required");
    await expect(f.hosts.ensure({ ...configuration, startupEnvironmentVariables: {} }, connection.epoch)).resolves.toBe(first);
  });
});

describe("native Pi retained administration", () => {
  it("recovers disabled targets without creating hosts and releases every lease", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    expect(await recoverPiNativeRuntimeAdministration({ context, configuration })).toBeUndefined();
    expect(f.createHost).not.toHaveBeenCalled();
    const host = await f.hosts.ensure(configuration, connection.epoch);
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration: { ...configuration, executablePath: "/desired/new/pi" } }))!;
    const snapshot = await administration.inspect();
    expect(snapshot).toMatchObject({ incarnation: host.runtimeId, state: "idle", retainedThreadIds: [] });
    await administration.restart({ expectedRevision: snapshot.revision, force: false });
    await administration.stop({ expectedRevision: snapshot.revision, force: false });
    expect(await recoverPiNativeRuntimeAdministration({ context, configuration })).toBeUndefined();
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(6);
  });

  it("maps retained sessions only to this scope, backend, and execution environment", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const host = await f.hosts.ensure(configuration, connection.epoch), initial = host.snapshot();
    vi.spyOn(host, "snapshot").mockReturnValue({ ...initial, retainedSessions: ["bound", "wrong-environment", "unbound"].map(sessionId => ({
      ...identity, sessionId, handleId: sessionId, generation: "generation", throughSequence: 0, retainedAfterSequence: 0, retainedOperationIds: [],
    })) });
    const database = new Database(":memory:");
    cleanup.push(async () => { database.close(); });
    database.exec(`CREATE TABLE conversation_bindings (tenant_id TEXT, owner_principal_id TEXT, backend_instance_id TEXT,
      backend_conversation_id TEXT, execution_environment_id TEXT, application_thread_id TEXT)`);
    const insert = database.prepare("INSERT INTO conversation_bindings VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(scope.tenantId, scope.principalId, configuration.backendInstanceId, "bound", "old-environment", "old-thread");
    insert.run(scope.tenantId, scope.principalId, configuration.backendInstanceId, "bound", "remote", "thread");
    insert.run(scope.tenantId, scope.principalId, configuration.backendInstanceId, "wrong-environment", "other", "wrong-thread");
    insert.run(scope.tenantId, "other-principal", configuration.backendInstanceId, "unbound", "remote", "private-thread");
    const administration = (await recoverPiNativeRuntimeAdministration({ context: { ...context, database }, configuration }))!;
    expect((await administration.inspect()).retainedThreadIds).toEqual(["thread"]);
  });

  it("fences replacement runtime and service incarnations throughout recovery", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const host = await f.hosts.ensure(configuration, connection.epoch);
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration }))!;
    await f.hosts.stop(host.runtimeId, host.snapshot().revision, false);
    await f.hosts.ensure(configuration, connection.epoch);
    await expect(administration.inspect()).rejects.toThrow("pi_native_administration_incarnation_changed");
    await expect(administration.stop({ expectedRevision: "0", force: true })).rejects.toThrow("pi_native_administration_incarnation_changed");
    const other = await fixture(), replacement = await attachment(other);
    vi.mocked(context.sidecarRuntime.acquireRecovery).mockResolvedValue(replacement.lease);
    await expect(administration.stop({ expectedRevision: "0", force: true })).rejects.toThrow("pi_native_administration_incarnation_changed");
    expect(other.createHost).not.toHaveBeenCalled();
  });

  it("does not confuse partial capabilities, failed readiness, or disconnection with absence", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const supports = vi.spyOn(connection.channel, "supportsOperation").mockReturnValue(false);
    expect(await recoverPiNativeRuntimeAdministration({ context, configuration })).toBeUndefined();
    supports.mockImplementation(operation => operation.operation === "runtime.control");
    await expect(recoverPiNativeRuntimeAdministration({ context, configuration })).rejects.toThrow("pi_native_remote_runtime_unsupported");
    supports.mockReturnValue(false);
    const readiness = vi.spyOn(connection.channel, "assertReady").mockImplementation(() => { throw new Error("carrier not ready"); });
    await expect(recoverPiNativeRuntimeAdministration({ context, configuration })).rejects.toThrow("carrier not ready");
    readiness.mockRestore(); supports.mockRestore();
    vi.mocked(context.sidecarRuntime.acquireRecovery).mockRejectedValue(new Error("transport unavailable"));
    await expect(recoverPiNativeRuntimeAdministration({ context, configuration })).rejects.toThrow("transport unavailable");
  });

  it("does not treat lost capabilities as retirement of an already recovered owner", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    await f.hosts.ensure(configuration, connection.epoch);
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration }))!;
    vi.spyOn(connection.channel, "supportsOperation").mockReturnValue(false);
    await expect(administration.stop({ expectedRevision: "0", force: false })).rejects.toThrow("pi_native_remote_runtime_unsupported");
  });

  it("preserves rejected confirmations and failed cleanup for a later controlled retry", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const host = await f.hosts.ensure(configuration, connection.epoch);
    await host.attach(identity);
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration }))!;
    await expect(administration.stop({ expectedRevision: "stale", force: true })).rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason: "confirmation_stale",
      cause: { name: "PiNativeError", code: "pi_native_confirmation_stale", delivery: "not_sent" } });
    f.close.mockRejectedValueOnce(new Error("child survived"));
    await expect(administration.stop({ expectedRevision: (await administration.inspect()).revision, force: true })).rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason: "cleanup_unproven",
      cause: { name: "PiNativeError", code: "pi_native_cleanup_unproven", delivery: "sent_outcome_unknown" } });
    expect((await administration.inspect()).blockers).toContain("cleanup_unproven");
    expect(f.releaseWriter).not.toHaveBeenCalled();
    await administration.stop({ expectedRevision: (await administration.inspect()).revision, force: true });
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("reports positively refused busy retirement without treating it as transport failure", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const host = await f.hosts.ensure(configuration, connection.epoch), initial = host.snapshot();
    vi.spyOn(host, "snapshot").mockReturnValue({ ...initial, state: "active", blockers: ["active_work"] });
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration }))!;
    await expect(administration.stop({ expectedRevision: initial.revision, force: false })).rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason: "blocked",
      cause: { name: "PiNativeError", code: "pi_native_restart_blocked", delivery: "not_sent" } });
    expect(await f.hosts.lookupRetained(configuration.backendInstanceId, connection.epoch)).toBe(host);
    expect(f.close).not.toHaveBeenCalled();
  });

  it("preserves unknown host and transport failures throughout retained runtime control", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const host = await f.hosts.ensure(configuration, connection.epoch);
    const administration = (await recoverPiNativeRuntimeAdministration({ context, configuration }))!;
    const request = { expectedRevision: host.snapshot().revision, force: true };
    const stop = vi.spyOn(host, "stop");
    for (const action of ["stop", "restart"] as const) {
      stop.mockRejectedValueOnce(new PiNativeError("pi_native_unrecognized_control_failure", "sent_outcome_unknown"));
      const error = await administration[action](request).catch(error => error);
      expect(error).toBeInstanceOf(PiNativeError);
      expect(error).not.toBeInstanceOf(BackendRuntimeControlRejectedError);
      expect(error).toMatchObject({ code: "pi_native_unrecognized_control_failure", delivery: "sent_outcome_unknown" });
    }
    const original = connection.channel.call.bind(connection.channel);
    const lost = Object.assign(new Error("pi_native_cleanup_unproven"), { code: "pi_native_cleanup_unproven" });
    const call = vi.spyOn(connection.channel, "call").mockImplementation(async (...args) => {
      const command = await connection.channel.decodeBody(sidecarRuntimeBodySchema.parse(args[1])) as { action: string };
      if (command.action === "stop") throw lost;
      return original(...args);
    });
    try {
      for (const action of ["stop", "restart"] as const) {
        const error = await administration[action](request).catch(error => error);
        expect(error).toBeInstanceOf(PiNativeError);
        expect(error).not.toBeInstanceOf(BackendRuntimeControlRejectedError);
        expect(error).toMatchObject({ code: "pi_native_sidecar_unavailable", delivery: "sent_outcome_unknown" });
        expect(error.cause).toBe(lost);
      }
    } finally { call.mockRestore(); stop.mockRestore(); }
    expect(await f.hosts.lookupRetained(configuration.backendInstanceId, connection.epoch)).toBe(host);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.createHost).toHaveBeenCalledTimes(1);
  });

  it("validates every configured target including disabled entries before acquiring authority", async () => {
    const f = await fixture(), connection = await attachment(f), context = recoveryContext(connection.lease);
    const input: BackendModuleConfigurationInput = {
      backend: { id: configuration.backendInstanceId, kind: "pi_native", enabled: false, protocolRelease: "1.4.0", modelPolicy: { type: "catalog" }, moduleConfiguration: {} },
      connections: context.connections.map(profile => ({ id: profile.templateId, kind: "pi_rpc", backendInstanceId: configuration.backendInstanceId, executionEnvironmentId: "remote", enabled: false, moduleConfiguration: {} })),
      executionEnvironments: [{ id: "remote", kind: "ssh" }], environment: {},
    };
    const prepared = new PiNativeBackendModule().prepare(input);
    for (const changed of [
      { connections: context.connections.slice(0, 1) },
      { connections: [context.connections[0]!, context.connections[0]!] },
      { connections: context.connections.map(profile => ({ ...profile, enabled: true })) },
      { connections: context.connections.map(profile => ({ ...profile, ownerPrincipalId: "other" })) },
      { connections: context.connections.map(profile => ({ ...profile, executionEnvironmentId: "other" })) },
      { instance: { ...context.instance, kind: "pi" as const } },
    ]) await expect(prepared.recoverAdministration!({ ...context, ...changed })).rejects.toThrow("pi_native_runtime_context_invalid");
    expect(context.sidecarRuntime.acquireRecovery).not.toHaveBeenCalled();
    await expect(prepared.recoverAdministration!(context)).resolves.toBeUndefined();
    expect(f.createHost).not.toHaveBeenCalled();
    const local = new PiNativeBackendModule().prepare({ ...input, executionEnvironments: [{ id: "remote", kind: "local" }] });
    await expect(local.recoverAdministration!(context)).rejects.toThrow("pi_native_runtime_context_invalid");
  });

  it("probes startup state without creating a service, host, or process", async () => {
    const f = await fixture(), connection = await attachment(f), { port, runtime } = proxy(connection.lease);
    expect(await port.startupEnvironmentState()).toBe("not_started");
    expect(runtime.acquire).not.toHaveBeenCalled(); expect(f.createHost).not.toHaveBeenCalled();
    await f.hosts.ensure(configuration, connection.epoch);
    expect(await port.startupEnvironmentState()).toBe("started");
    expect(f.close).not.toHaveBeenCalled(); expect(f.requests).not.toHaveBeenCalled();
    runtime.acquireExisting.mockRejectedValueOnce(new Error("unavailable"));
    expect(await port.startupEnvironmentState()).toBe("unknown");
    expect(runtime.acquire).not.toHaveBeenCalled();
  });
});

class Queue implements AsyncIterable<SidecarFrame> {
  readonly values: SidecarFrame[] = [];
  readonly waiters: ((result: IteratorResult<SidecarFrame>) => void)[] = [];
  ended = false;
  push(value: SidecarFrame) { const waiter = this.waiters.shift(); waiter ? waiter({ value, done: false }) : this.values.push(value); }
  end() { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SidecarFrame> {
    return { next: async () => { const value = this.values.shift(); return value ? { value, done: false } : this.ended ? { value: undefined, done: true } : await new Promise(resolve => this.waiters.push(resolve)); } };
  }
}
class Transport implements SidecarFrameTransport {
  readonly assurance = { kind: "memory", carrierGeneration: 1 };
  readonly frames = new Queue();
  readonly closed: Promise<SidecarTransportClosure>;
  resolve!: (closure: SidecarTransportClosure) => void;
  peer?: Transport;
  constructor() { this.closed = new Promise(resolve => { this.resolve = resolve; }); }
  commitCompression(_mode: "none" | "zstd"): void {}
  async send(bytes: Uint8Array, _options: SidecarFrameSendOptions) {
    if (!this.peer || this.frames.ended) throw new SidecarFrameWriteError("closed", "not_sent");
    this.peer.frames.push({ bytes: Uint8Array.from(bytes) }); return { disposition: "sent" as const };
  }
  async close(reason: string) {
    this.frames.end(); this.resolve({ reason });
    if (this.peer) { this.peer.frames.end(); this.peer.resolve({ reason }); }
  }
}
