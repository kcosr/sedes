import { runtimeLaunchDigest } from "../../src/server/backends/provider-launch-digest.js";
import { attachFixturePolicy, installFixturePolicy } from "../helpers/execution-policy-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarFrameWriteError, SidecarOperationRegistry, SidecarProtocolPeer, controlHelloOperation, registerControlV3Operations,
  type SidecarFrame, type SidecarFrameSendOptions, type SidecarFrameTransport, type SidecarTransportClosure } from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel, type SidecarRuntimeLease } from "../../src/server/sidecar/runtime-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { AntigravityHost } from "../../src/server/backends/antigravity/host/native-host.js";
import { AntigravityHostRegistry } from "../../src/server/backends/antigravity/host/host-registry.js";
import { AntigravityRemotePort, inspectRetainedAntigravityOwner } from "../../src/server/backends/antigravity/sidecar/remote-port.js";
import { registerAntigravityHost } from "../../src/server/backends/antigravity/sidecar/register-host.js";
import { AntigravityAcpConnection } from "../../src/server/backends/antigravity/acp-connection.js";
import { antigravityHistorySchema, antigravityRuntimeCapability } from "../../src/server/backends/antigravity/sidecar/wire.js";
import type { AntigravityHistory, AntigravityIdentity, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-antigravity-sidecar-test-")));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const executablePath = path.join(cwd, "agy");
  await copyFile(fileURLToPath(new URL("../fixtures/antigravity/fake-antigravity-acp-peer.mjs", import.meta.url)), executablePath); await chmod(executablePath, 0o755);
  const configuration: AntigravityRuntimeConfiguration = { ...scope, backendInstanceId: "backend", executionEnvironmentId: "remote", executablePath, initializationTimeoutMs: 1000 };
  const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: "remote", environment: process.env });
  cleanup.push(async () => channels.close());
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, executionEnvironmentId: "remote", installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration });
  let failCleanup = false;
  const launched = vi.fn();
  const readHistory = vi.fn(async (identity: AntigravityIdentity): Promise<AntigravityHistory> => ({ ...identity, native: { steps: [], executions: [], revision: "a".repeat(64) } }));
  const createHost = vi.fn((configuration: AntigravityRuntimeConfiguration) => {
    const host = new AntigravityHost({ configuration, channels, environment: process.env, observationWaitMs: 5,
      history: { read: readHistory, forget: async () => undefined, close: async () => undefined },
      launch: async input => {
        launched(); const peer = await AntigravityAcpConnection.open(input); const close = peer.close.bind(peer);
        vi.spyOn(peer, "close").mockImplementation(async () => { if (failCleanup) throw new Error("cleanup_uncertain"); await close(); }); return peer;
      } });
    cleanup.push(() => host.close()); return host;
  });
  const hosts = new AntigravityHostRegistry({ scope, executionEnvironmentId: "remote", channels, environment: process.env, services, createHost });
  return { cwd, configuration, services, hosts, launched, createHost, readHistory, failCleanup(value: boolean) { failCleanup = value; } };
}
async function attachment(f: Awaited<ReturnType<typeof fixture>>, mode: "normal" | "recovery" = "normal", supportedAntigravityMajor: number = antigravityRuntimeCapability.majorVersion) {
  const left = new Transport(), right = new Transport(); left.peer = right; right.peer = left;
  const epoch = attachFixturePolicy(f.services, serviceConfiguration, mode, { roots: [], capabilities: [],
    backends: [{ id: f.configuration.backendInstanceId, kind: "antigravity", generation: 1, launchDigest: runtimeLaunchDigest.antigravity(f.configuration), targets: [{id:"target", generation:1}] }] });
  const leftRegistry = new SidecarOperationRegistry(), rightRegistry = new SidecarOperationRegistry();
  const sedes = new SidecarProtocolPeer({ role: "sedes", transport: left, sessionNonce: "n".repeat(48), registry: leftRegistry });
  const sidecar = new SidecarProtocolPeer({ role: "sidecar", transport: right, sessionNonce: "n".repeat(48), registry: rightRegistry });
  const channel = new SidecarRuntimeChannel(sedes, leftRegistry), hostChannel = new SidecarRuntimeChannel(sidecar, rightRegistry);
  const detach = registerAntigravityHost({ registry: rightRegistry, channel: hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: epoch, getExecutionPolicy: () => f.services.executionPolicy(epoch), isRecoveryController: () => f.services.recoveryController });
  const capabilities = rightRegistry.capabilities().map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }));
  registerControlV3Operations(rightRegistry, { buildId: "test", artifactSha256: "a".repeat(64), enabledSidecarCapabilities: capabilities, enabledSedesCapabilities: leftRegistry.capabilities() });
  sedes.start(); sidecar.start();
  const supported = capabilities.map(capability => capability.capabilityId === "antigravity_runtime"
    ? { ...capability, majorVersion: supportedAntigravityMajor } : capability);
  await sedes.call(controlHelloOperation, { compression: "none", expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), supportedSidecarCapabilities: supported, offeredSedesCapabilities: leftRegistry.capabilities() });
  const release = vi.fn();
  const lease: SidecarRuntimeLease = { channel, controllerEpoch: epoch, serviceIncarnation: f.services.serviceIncarnation, closed: left.closed, release };
  let disconnected = false;
  const disconnect = async () => { if (disconnected) return; disconnected = true;
    detach(); f.services.detach(epoch); channel.close(); hostChannel.close(); await sedes.close("test_complete"); };
  cleanup.push(disconnect); return { lease, channel, disconnect, epoch, release };
}
function proxy(f: Awaited<ReturnType<typeof fixture>>, getLease: () => SidecarRuntimeLease) {
  const runtime = { acquire: vi.fn(async () => getLease()), acquireExisting: vi.fn(async () => getLease()) };
  const port = new AntigravityRemotePort({ configuration: f.configuration, sidecarRuntime: runtime }); cleanup.push(() => port.close()); return { port, runtime };
}
describe("Antigravity persistent sidecar", () => {
  it("inspects a retained owner by its original ID without its saved definition or launch authority", async () => {
    const f = await fixture(), initial = await attachment(f);
    await proxy(f, () => initial.lease).port.create({ cwd: f.cwd, operationId: "original" });
    await initial.disconnect();
    const recovery = await attachment(f, "recovery");
    const signal = AbortSignal.timeout(5000);
    await expect(inspectRetainedAntigravityOwner(recovery.lease, "other", signal)).resolves.toBe(false);
    await expect(inspectRetainedAntigravityOwner(recovery.lease, f.configuration.backendInstanceId, signal)).resolves.toBe(true);
    expect(f.launched).toHaveBeenCalledOnce();
    expect(f.createHost).toHaveBeenCalledOnce();
  });

  it("delivers a cold-load approval and the resulting session settings through the sidecar", async () => {
    const f = await fixture(), connected = await attachment(f), { port } = proxy(f, () => connected.lease);
    const identity = { sessionId: "cold-load", cwd: f.cwd };
    const opening = await port.attach({ ...identity,
      executionEnvironment: { AGY_FIXTURE_LOAD_PERMISSION: { kind: "literal", value: "wait" } } });
    expect(opening.loading).toBe(true);
    expect(opening.pendingPermissions).toHaveLength(1);
    const permission = opening.pendingPermissions[0]!;
    expect(permission.request.sessionId).toBe(identity.sessionId);
    await port.request({ handleId: opening.handleId, operationId: "answer", command: {
      type: "permission", requestId: permission.requestId, response: { outcome: { outcome: "selected", optionId: "allow" } },
    } });
    await vi.waitFor(async () => {
      const observed = await port.observe({ handleId: opening.handleId, afterSequence: opening.throughSequence });
      expect(observed.events).toContainEqual(expect.objectContaining({ kind: "session_loaded" }));
    });
    const loaded = await port.attachExisting(identity);
    expect(loaded?.handleId).toBe(opening.handleId);
    expect(loaded?.loading).toBeUndefined();
    expect(loaded?.pendingPermissions).toEqual([]);
    expect(loaded?.setup.session.configOptions).toContainEqual(expect.objectContaining({ id: "model", currentValue: "fixture-model" }));
  });

  it.each([
    { outcome: "selected", concurrent: false }, { outcome: "selected", concurrent: true },
    { outcome: "selected", concurrent: "published" }, { outcome: "cancelled", concurrent: false },
  ] as const)("uses truthful carrier authority for a $outcome permission after reconnect (concurrent: $concurrent)", async ({ outcome, concurrent }) => {
    const f = await fixture(), first = await attachment(f), initial = proxy(f, () => first.lease);
    const identity = await initial.port.create({ cwd: f.cwd, operationId: "create" });
    const original = await initial.port.attach(identity);
    await initial.port.request({ handleId: original.handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "permission" }] } });
    let requestId: string | undefined;
    await vi.waitFor(async () => { requestId = (await initial.port.attachExisting(identity))?.pendingPermissions[0]?.requestId; expect(requestId).toBeDefined(); });
    await initial.port.close(); await first.disconnect();
    const recovery = await attachment(f, "recovery");
    let answering: Promise<unknown> | undefined;
    const resumed = proxy(f, () => concurrent === "published" ? { ...recovery.lease, get closed() {
      // #open has published its attachment but its opening promise has not
      // settled yet. An approval must still join and promote that recovery.
      answering = answer();
      return recovery.lease.closed;
    } } : recovery.lease);
    const answer = () => resumed.port.request({ handleId: original.handleId, operationId: "answer", command: { type: "permission", requestId: requestId!,
      response: { outcome: outcome === "selected" ? { outcome: "selected", optionId: "allow" } : { outcome: "cancelled" } } } });
    let finish!: (lease: SidecarRuntimeLease) => void;
    if (concurrent === true) resumed.runtime.acquireExisting.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reconnect = resumed.port.attachExisting(identity);
    if (concurrent === true) await vi.waitFor(() => expect(finish).toBeDefined());
    else if (!concurrent) expect(await reconnect).toMatchObject({ handleId: original.handleId });
    resumed.runtime.acquire.mockImplementationOnce(async () => {
      // Drain the old carrier's read before replacing its controller epoch.
      if (concurrent) await reconnect;
      return (await attachment(f)).lease;
    });
    if (concurrent !== "published") answering = answer();
    if (concurrent === true) finish(recovery.lease);
    await reconnect;
    expect(answering).toBeDefined();
    await answering;
    await vi.waitFor(async () => expect(await resumed.port.outcome({ handleId: original.handleId, operationId: "answer" })).toMatchObject({ status: "completed" }));
    expect(resumed.runtime.acquire).toHaveBeenCalledTimes(outcome === "selected" ? 1 : 0);
    expect(f.launched).toHaveBeenCalledOnce(); expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("returns retained create receipts after backend withdrawal without launching a second peer", async () => {
    const f = await fixture(), carrier = await attachment(f), { port } = proxy(f, () => carrier.lease);
    const request = { cwd: f.cwd, operationId: "original" };
    const identity = await port.create(request);
    installFixturePolicy(f.services, carrier.epoch, serviceConfiguration, { roots: [], capabilities: [], backends: [] });
    await expect(port.create(request)).resolves.toEqual(identity);
    await port.acknowledgeCreation({ operationId: request.operationId, ...identity });
    await expect(port.create(request)).resolves.toEqual(identity);
    await expect(port.create({ ...request, operationId: "new" })).rejects.toMatchObject({ delivery: "not_sent" });
    expect(f.launched).toHaveBeenCalledOnce();
  });

  it("uses one retained fallback when normal reconnect encounters configuration drift", async () => {
    const f = await fixture(), first = await attachment(f); let current = first.lease;
    const { port, runtime } = proxy(f, () => current);
    const identity = await port.create({ cwd: f.cwd, operationId: "create" });
    await first.disconnect();
    const recovery = await attachment(f, "recovery"); current = recovery.lease;
    runtime.acquire.mockClear();
    runtime.acquire.mockRejectedValueOnce(new Error("sidecar_revision_changed"));
    await expect(port.readHistory(identity)).resolves.toMatchObject({ sessionId: identity.sessionId });
    expect(runtime.acquire).toHaveBeenCalledTimes(2);
    expect(runtime.acquire).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), { existingOnly: true });
    expect(runtime.acquireExisting).not.toHaveBeenCalled();
    expect(recovery.release).not.toHaveBeenCalled();
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("does not promote a proxy restricted to retained authority", async () => {
    const f = await fixture(), first = await attachment(f), initial = proxy(f, () => first.lease);
    const identity = await initial.port.create({ cwd: f.cwd, operationId: "create" });
    const original = await initial.port.attach(identity);
    await initial.port.close(); await first.disconnect();
    const recovery = await attachment(f, "recovery");
    const runtime = { acquire: vi.fn(async () => recovery.lease), acquireExisting: vi.fn(async () => recovery.lease) };
    const port = new AntigravityRemotePort({ configuration: f.configuration, sidecarRuntime: runtime, existingOnly: true });
    cleanup.push(() => port.close());
    expect(await port.attachExisting(identity)).toMatchObject({ handleId: original.handleId });
    await expect(port.request({ handleId: original.handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "must not execute" }] } }))
      .rejects.toMatchObject({ code: "antigravity_recovery_read_only" });
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.acquireExisting).toHaveBeenCalledOnce();
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("transfers history only when the exact native revision changes", async () => {
    const f = await fixture(), connected = await attachment(f), { port } = proxy(f, () => connected.lease);
    const identity = { sessionId: "native-session", cwd: f.cwd };
    const first = await port.readHistory(identity);
    expect(first?.native.revision).toBe("a".repeat(64));
    const encoded = vi.spyOn(SidecarRuntimeChannel.prototype, "encodeBody");
    f.readHistory.mockClear();
    await expect(port.readHistory({ ...identity, knownRevision: "a".repeat(64) })).resolves.toBeNull();
    expect(f.readHistory).toHaveBeenCalledOnce();
    expect(encoded).toHaveBeenLastCalledWith({ status: "ok", runtimeVersion: null, value: null });
    const updated: AntigravityHistory = { ...identity, native: { executions: [], revision: "b".repeat(64),
      steps: [
        { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: "ec2e00ac-87cb-48ab-9240-26e19de7e980", state: "failed" }] },
        { index: 1, type: 17, status: 3, hasSubtrajectory: false, standaloneSystemDiagnostic: true, error: "Individual quota reached." },
      ] } };
    f.readHistory.mockResolvedValue(updated);
    await expect(port.readHistory({ ...identity, knownRevision: "a".repeat(64) })).resolves.toEqual(updated);
    await expect(port.readHistory(identity)).resolves.toEqual(updated);
    expect(f.launched).not.toHaveBeenCalled();
  });
  it("rejects an unchanged response without a caller revision", async () => {
    const f = await fixture(), connected = await attachment(f), { port } = proxy(f, () => connected.lease);
    await port.connect();
    const host = (await f.hosts.lookup(f.configuration, connected.epoch))!;
    vi.spyOn(host, "readHistory").mockResolvedValue(null);
    await expect(port.readHistory({ sessionId: "native-session", cwd: f.cwd }))
      .rejects.toMatchObject({ code: "antigravity_history_revision_unproven" });
  });
  it("requires executor evidence inventory in its versioned private history contract", () => {
    expect(antigravityRuntimeCapability.majorVersion).toBe(6);
    const history = { sessionId: "session", cwd: "/workspace", native: { steps: [], revision: "a".repeat(64) } };
    expect(antigravityHistorySchema.safeParse(history).success).toBe(false);
    expect(antigravityHistorySchema.safeParse({ ...history, native: { ...history.native, executions: [] } }).success).toBe(true);
  });
  it("publishes normalized provider ownership through service status", async () => {
    const f = await fixture(), connected = await attachment(f);
    const { port } = proxy(f, () => connected.lease);
    await port.connect();
    const host = (await f.hosts.lookup(f.configuration, connected.epoch))!;
    const resource = () => f.services.status().resources.find(value => value.resourceId === host.runtimeId);
    expect(resource()).toEqual({ resourceId: host.runtimeId, kind: "provider", state: "idle", revision: host.snapshot().revision, blockers: [] });
    await port.create({ cwd: f.cwd, operationId: "create" });
    const retained = host.snapshot();
    expect(retained.retainedSessions).toHaveLength(1);
    expect(retained.blockers).toContain("unsettled_outcome");
    expect(resource()).toEqual({ resourceId: host.runtimeId, kind: "provider", state: retained.state,
      revision: retained.revision, blockers: retained.blockers });
  });
  it("keeps a turn alive across controller loss and resumes exact retained outcomes", async () => {
    const f = await fixture(); const first = await attachment(f); let current = first.lease;
    const { port } = proxy(f, () => current);
    const identity = await port.create({ cwd: f.cwd, operationId: "create" }); const original = await port.attach(identity);
    await port.request({ handleId: original.handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    await first.disconnect();
    const second = await attachment(f); current = second.lease;
    const restored = await port.attachExisting(identity);
    expect(restored).toMatchObject({ handleId: original.handleId, generation: original.generation }); expect(f.launched).toHaveBeenCalledOnce();
    expect(await port.outcome({ handleId: original.handleId, operationId: "send" })).toEqual({ status: "pending" });
    await port.request({ handleId: original.handleId, operationId: "cancel", command: { type: "cancel" } });
    await vi.waitFor(async () => expect(await port.outcome({ handleId: original.handleId, operationId: "send" })).toMatchObject({ status: "completed", result: { stopReason: "cancelled" } }));
    await port.close(); expect((await f.hosts.lookupRetained("backend", second.epoch))?.snapshot().retainedSessions).toHaveLength(1);
  });
  it("restores a new main-side proxy without launching a replacement or replaying input", async () => {
    const f = await fixture(), first = await attachment(f); const initial = proxy(f, () => first.lease);
    const identity = await initial.port.create({ cwd: f.cwd, operationId: "create" }); const original = await initial.port.attach(identity);
    await initial.port.close(); await first.disconnect();
    const second = await attachment(f); const resumed = proxy(f, () => second.lease);
    expect(await resumed.port.attachExisting(identity)).toMatchObject({ handleId: original.handleId, generation: original.generation });
    expect(resumed.runtime.acquire).not.toHaveBeenCalled(); expect(resumed.runtime.acquireExisting).toHaveBeenCalledOnce(); expect(f.launched).toHaveBeenCalledOnce();
    // The same retained owner can regain ordinary authority only after exact
    // current-configuration lookup; it never starts a competing runtime.
    await resumed.port.request({ handleId: original.handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    await vi.waitFor(async () => expect(await resumed.port.outcome({ handleId: original.handleId, operationId: "send" })).toMatchObject({ status: "completed" }));
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("fences a changed service incarnation rather than ensuring a replacement runtime", async () => {
    const f = await fixture(), first = await attachment(f); let lease = first.lease; const { port } = proxy(f, () => lease);
    const identity = await port.create({ cwd: f.cwd, operationId: "create" }); await first.disconnect();
    const second = await attachment(f); lease = { ...second.lease, serviceIncarnation: "replacement-service" };
    await expect(port.attachExisting(identity)).rejects.toMatchObject({ code: "antigravity_runtime_incarnation_changed", delivery: "sent_outcome_unknown" });
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("releases handles of a replaced service locally without contacting the successor", async () => {
    const f = await fixture(), first = await attachment(f); let lease = first.lease; const { port, runtime } = proxy(f, () => lease);
    const identity = await port.create({ cwd: f.cwd, operationId: "create" }); const { handleId } = await port.attach(identity);
    await first.disconnect();
    // The carrier alone does not prove replacement.
    expect(port.serviceReplaced).toBe(false);
    const second = await attachment(f); lease = { ...second.lease, serviceIncarnation: "replacement-service" };
    const call = vi.spyOn(second.lease.channel, "call");
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toMatchObject({ code: "antigravity_runtime_incarnation_changed" });
    expect(port.serviceReplaced).toBe(true);
    await expect(port.release({ handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId })).resolves.toBeUndefined();
    await expect(port.inspect()).rejects.toMatchObject({ code: "antigravity_runtime_incarnation_changed" });
    expect(call).not.toHaveBeenCalled();
    // Once proven, release no longer needs any carrier.
    runtime.acquireExisting.mockRejectedValue(new Error("sidecar_unavailable"));
    await expect(port.release({ handleId })).resolves.toBeUndefined();
    await expect(port.release({ handleId: "unknown-handle" })).rejects.toMatchObject({ code: "antigravity_runtime_incarnation_changed" });
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("reacquires normal service authority before promoting a retained recovery carrier", async () => {
    const f = await fixture(), first = await attachment(f), initial = proxy(f, () => first.lease);
    const identity = await initial.port.create({ cwd: f.cwd, operationId: "create" }); const original = await initial.port.attach(identity);
    await initial.port.close(); await first.disconnect();
    const recovery = await attachment(f, "recovery"), resumed = proxy(f, () => recovery.lease);
    expect(await resumed.port.attachExisting(identity)).toMatchObject({ handleId: original.handleId });
    resumed.runtime.acquire.mockImplementationOnce(async () => (await attachment(f)).lease);
    await resumed.port.request({ handleId: original.handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    await vi.waitFor(async () => expect(await resumed.port.outcome({ handleId: original.handleId, operationId: "send" })).toMatchObject({ status: "completed" }));
    expect(resumed.runtime.acquire).toHaveBeenCalledOnce(); expect(recovery.release).toHaveBeenCalledOnce(); expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("distinguishes a changed startup contract from exact retained lookup", async () => {
    const f = await fixture(), connected = await attachment(f);
    const host = await f.hosts.ensure(f.configuration, connected.epoch);
    const changed = { ...f.configuration, startupEnvironmentVariables: { NOTE: { kind: "literal" as const, value: "changed" } } };
    await expect(f.hosts.ensure(changed, connected.epoch)).rejects.toMatchObject({ code: "antigravity_configuration_restart_required" });
    await expect(f.hosts.lookup(changed, connected.epoch)).resolves.toBe(host);
    expect(f.createHost).toHaveBeenCalledOnce();
  });
  it("denies wrong scope and incompatible capability 5 before execution", async () => {
    const f = await fixture(), connected = await attachment(f, "normal", 5);
    await expect(f.hosts.ensure({ ...f.configuration, principalId: "wrong" }, connected.epoch)).rejects.toMatchObject({ code: "antigravity_configuration_scope_denied" });
    const { port } = proxy(f, () => connected.lease);
    await expect(port.create({ cwd: f.cwd, operationId: "create" })).rejects.toMatchObject({ code: "antigravity_remote_unsupported" });
    expect(f.createHost).not.toHaveBeenCalled();
  });
  it("retains ownership after uncertain cleanup and rejects a competing replacement", async () => {
    const f = await fixture(), connected = await attachment(f), { port } = proxy(f, () => connected.lease);
    await port.create({ cwd: f.cwd, operationId: "create" }); const before = await port.inspect();
    f.failCleanup(true);
    try {
      await expect(port.stop({ expectedRevision: before.revision, force: true })).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
      const retained = await port.inspect(); expect(retained.blockers).toContain("cleanup_unproven");
      await expect(port.attach({ sessionId: "different", cwd: f.cwd })).rejects.toMatchObject({ code: "antigravity_cleanup_unproven", delivery: "not_sent" });
      expect(f.createHost).toHaveBeenCalledOnce();
    } finally { f.failCleanup(false); }
  });
});
class Queue implements AsyncIterable<SidecarFrame> {
  readonly values: SidecarFrame[] = []; readonly waiters: ((value: IteratorResult<SidecarFrame>) => void)[] = []; ended = false;
  push(value: SidecarFrame) { const waiter = this.waiters.shift(); waiter ? waiter({ value, done: false }) : this.values.push(value); }
  end() { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SidecarFrame> { return { next: async () => { const value = this.values.shift(); return value ? { value, done: false } : this.ended ? { value: undefined, done: true } : await new Promise(resolve => this.waiters.push(resolve)); } }; }
}
class Transport implements SidecarFrameTransport {
  readonly assurance = { kind: "memory", carrierGeneration: 1 }; readonly frames = new Queue(); readonly closed: Promise<SidecarTransportClosure>;
  resolve!: (value: SidecarTransportClosure) => void; peer?: Transport;
  constructor() { this.closed = new Promise(resolve => { this.resolve = resolve; }); }
  commitCompression(_mode: "none" | "zstd") {}
  async send(bytes: Uint8Array, _options: SidecarFrameSendOptions) {
    if (!this.peer || this.frames.ended) throw new SidecarFrameWriteError("closed", "not_sent"); this.peer.frames.push({ bytes: Uint8Array.from(bytes) }); return { disposition: "sent" as const };
  }
  async close(reason: string) { this.frames.end(); this.resolve({ reason }); if (this.peer) { this.peer.frames.end(); this.peer.resolve({ reason }); } }
}
