import { launchAdmission } from "../../src/server/backends/provider-policy-admission.js";
import { runtimeLaunchDigest } from "../../src/server/backends/provider-launch-digest.js";
import { attachFixturePolicy, installFixturePolicy } from "../helpers/execution-policy-fixture.js";
import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";
import { createCodexRuntimeTransport } from "../../src/server/backends/codex/runtime/codex-runtime-transport.js";
import { CodexRemoteRuntimeSupervisor } from "../../src/server/backends/codex/runtime/codex-remote-runtime-supervisor.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import { codexRuntimeMethod } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { CodexRuntimeHostRegistry } from "../../src/server/backends/codex/runtime/codex-runtime-host-registry.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { sidecarAbandonmentEvidenceCarriesWork } from "../../src/server/sidecar/sidecar-abandonment-archive.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { CodexSidecarRuntimeConnection, registerCodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";

const native = vi.hoisted(() => ({ launches: 0, closes: 0, cleanupFailure: false, beforeReady: undefined as (() => Promise<void>) | undefined }));
vi.mock("../../src/server/backends/codex/codex-runtime-config.js", () => ({
  resolveCodexRuntimeConfiguration: async (input: { startupEnvironmentVariables?: { PATH?: { kind: string; value?: string } }; connection: { ownership: string; channel: { codexHome?: string } } }) => ({ ...input,
    ...(input.connection.ownership === "owned" ? { childEnvironment: input.startupEnvironmentVariables?.PATH?.kind === "literal" ? { PATH: input.startupEnvironmentVariables.PATH.value } : {}, codexHome: input.connection.channel.codexHome } : {}),
  }),
}));
vi.mock("../../src/server/backends/codex/runtime/codex-runtime-transport.js", () => ({ createCodexRuntimeTransport: vi.fn(() => ({})) }));
vi.mock("../../src/server/backends/codex/codex-daemon-supervisor.js", async () => {
  const { CodexSharedClientFacade } = await import("../../src/server/backends/codex/codex-client-facade.js");
  return { CodexDaemonSupervisor: class {
    readonly client = new CodexSharedClientFacade({
      current: () => ({ generation: 1, request: async () => undefined as never,
        requestWithReceipt: async () => ({ result: { data: [], nextCursor: null } as never, generation: 1, inboundSequence: 1 }) }),
      latestGeneration: () => 1, retireGeneration: async () => {},
    });
    constructor(readonly input: { isLaunchCurrent?: () => boolean }) { native.launches++; }
    async start() { await native.beforeReady?.(); this.client.updateLifecycle({ state: "ready", generation: 1 }); }
    async park() { this.client.updateLifecycle({ state: "idle", generation: 1 }); }
    async wake() {
      if (this.client.lifecycleSnapshot().state !== "idle") return;
      if (this.input.isLaunchCurrent?.() === false) throw new Error("codex_runtime_configuration_restart_required");
      await this.start();
    }
    snapshot() { return { state: this.client.lifecycleSnapshot().state, ...(native.cleanupFailure ? { cleanupUncertainty: {} } : {}) }; }
    async close() { native.closes++; if (native.cleanupFailure) throw new Error("native_cleanup_unproven"); }
  } };
});

const scope = { tenantId: "tenant", principalId: "principal" };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const configuration = {
  instance: { id: "backend", tenantId: scope.tenantId, kind: "codex_app_server" as const, label: "Codex", enabled: true, configurationRevision: 1, protocolRelease: "0.169.0" as const },
  connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "codex_app_server" as const, backendInstanceId: "backend", executionEnvironmentId: "remote", label: "Codex", enabled: true, configurationRevision: 1 }],
  connection: { ownership: "external" as const, channel: { type: "unix_websocket" as const, socketPath: "/provider/codex.sock" } },
};
function codexGrant(config: Parameters<CodexRuntimeHostRegistry["ensure"]>[0]) {
  return {roots: [], capabilities: [], backends: [{ id: config.instance.id, kind: "codex_app_server" as const, generation: 1,
    launchDigest: runtimeLaunchDigest.codex_app_server(config, config.startupEnvironmentVariables), targets: [{id: "template", generation: 1}] }] };
}
function fixture(config: Parameters<CodexRuntimeHostRegistry["ensure"]>[0] = configuration) {
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, installationId: "installation", executionEnvironmentId: "remote" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive });
  const epoch = attachFixturePolicy(services, serviceConfiguration, "normal", codexGrant(config));
  const hosts = new CodexRuntimeHostRegistry({ scope, executionEnvironmentId: "remote", environment: {}, environmentChannel: {} as ExecutionEnvironmentChannelProvider, services });
  return { services, hosts, epoch, archive };
}
beforeEach(() => { native.launches = 0; native.closes = 0; native.cleanupFailure = false; native.beforeReady = undefined; });

it("reports native-store refusals over runtime.ensure before launch and keeps private failures off the wire", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-ensure-lock-"));
  const lock = path.join(directory, ".harness-codex-runtime.lock");
  const owner = path.join(lock, "owner.json");
  const owned = { ...configuration, connection: { ownership: "owned" as const,
    channel: { type: "process_stdio" as const, executablePath: process.execPath, workingDirectory: directory, codexHome: directory } } };
  const f = fixture(owned);
  const carrier = await createSidecarFramedCarrier();
  const detach = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(f.epoch), registry: carrier.hostRegistry, channel: carrier.hostChannel,
    hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const connection = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  try {
    await mkdir(lock, { mode: 0o700 });
    await carrier.start();
    for (const [pid, code] of [[process.pid, "codex_native_store_already_locked"], [0, "codex_native_store_stale_lock_requires_operator"]] as const) {
      const record = JSON.stringify({ version: 1, pid, nonce: "legacy" });
      await writeFile(owner, record, { mode: 0o600 });
      await expect(connection.ensure(owned)).rejects.toMatchObject({ code, retryable: false });
      expect(await readFile(owner, "utf8")).toBe(record);
    }
    const ensure = vi.spyOn(f.hosts, "ensure");
    ensure.mockRejectedValueOnce(new Error("codex_native_store_exclusivity_requires_operator"));
    await expect(connection.ensure(owned)).rejects.toMatchObject({ code: "codex_native_store_exclusivity_requires_operator" });
    ensure.mockRejectedValueOnce(new Error("codex_native_store_private_path=/home/provider"));
    await expect(connection.ensure(owned)).rejects.toMatchObject({ code: "sidecar_operation_failed" });
    expect(native.launches).toBe(0);
  } finally { connection.close(); detach(); await carrier.close(); await rm(directory, { recursive: true, force: true }); }
});

it("forces an external unknown runtime closed with retained outcomes, preserving scoped abandonment evidence", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const authority = { scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: host.runtimeId, controllerId: "controller" };
  await host.attach(authority, () => {});
  await host.submit(authority, { operationId: "unacknowledged", generation: 1, method: "thread/name/set", params: { threadId: "thread", name: "private name" }, timeoutMilliseconds: 1000 });
  await vi.waitFor(() => expect(host.readRetainedOutcome("unacknowledged").status).not.toBe("pending"));
  vi.spyOn(host, "activity").mockReturnValue("unknown");
  const observed = await f.hosts.inspect(host.runtimeId);
  expect(observed.blockers).toEqual(expect.arrayContaining(["unknown_state", "unsettled_outcome"]));
  await expect(f.hosts.stop(host.runtimeId, observed.revision, false)).rejects.toThrow("cleanup_unproven");
  await expect(f.hosts.stop(host.runtimeId, "stale", true)).rejects.toThrow("confirmation_stale");
  expect(f.archive).not.toHaveBeenCalled();
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true);
  expect(native.closes).toBe(1);
  expect(f.services.status().resources).toEqual([]);
  expect(f.archive).toHaveBeenCalledWith(expect.objectContaining({ resourceId: host.runtimeId, kind: "codex_app_server",
    evidence: expect.objectContaining({ phase: "before_shutdown", ownership: "external", state: "unknown", blockers: expect.arrayContaining(["unknown_state", "unsettled_outcome"]),
      operations: [expect.objectContaining({ operationId: "unacknowledged" })] }) }));
  expect(JSON.stringify(f.archive.mock.calls)).not.toContain("private name");
});

it("reports an idle runtime's forced stop as idle to the archive, but not while a managed terminal is live", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true);
  const idle = f.archive.mock.calls.map(([record]) => (record as { evidence: unknown }).evidence);
  expect(idle).toEqual([expect.objectContaining({ phase: "before_shutdown", state: "idle", blockers: [], activity: "idle" }), expect.objectContaining({ phase: "after_shutdown" })]);
  expect(idle.map(sidecarAbandonmentEvidenceCarriesWork)).toEqual([false, false]);

  const g = fixture();
  const live = await g.hosts.ensure(configuration, g.epoch);
  vi.spyOn(g.hosts.managedTui, "activity").mockReturnValue({ state: "active", revision: "terminal", blockers: ["live_terminal"] });
  await g.hosts.stop(live.runtimeId, (await g.hosts.inspect(live.runtimeId)).revision, true);
  const [before] = g.archive.mock.calls.map(([record]) => (record as { evidence: unknown }).evidence);
  expect(before).toMatchObject({ phase: "before_shutdown", state: "active", blockers: ["active_work", "live_terminal"], activity: "idle", operations: [], pendingRequests: [] });
  expect(sidecarAbandonmentEvidenceCarriesWork(before)).toBe(true);
});

it("closes external native RPC before abandoning local approvals or stopping managed terminals", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const interrupt = vi.spyOn(host, "interruptOwnedActiveTurns");
  const abandon = vi.spyOn(host, "abandonPendingWork").mockImplementation(() => { expect(native.closes).toBe(1); });
  const stopTerminals = vi.spyOn(f.hosts.managedTui, "stopRuntime").mockImplementation(async () => { expect(native.closes).toBe(1); });
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true);
  expect(interrupt).not.toHaveBeenCalled();
  expect(abandon).toHaveBeenCalledOnce();
  expect(stopTerminals).toHaveBeenCalledOnce();
  expect(native.closes).toBe(1);
});

it("shares concurrent bootstrap, rejects wrong scope and changed execution configuration", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.hosts.ensure(configuration, f.epoch), f.hosts.ensure(configuration, f.epoch)]);
  expect(first).toBe(second);
  expect(native.launches).toBe(1);
  await expect(f.hosts.ensure({ ...configuration, connections: [{ ...configuration.connections[0]!, ownerPrincipalId: "intruder" }] }, f.epoch)).rejects.toThrow("scope_denied");
  await expect(f.hosts.ensure({ ...configuration, connection: { ...configuration.connection, channel: { type: "unix_websocket", socketPath: "/other.sock" } } }, f.epoch)).rejects.toThrow("restart_required");
  const state = await f.hosts.inspect(first.runtimeId);
  expect(f.services.status().resources).toEqual([{ resourceId: first.runtimeId, kind: "provider", state: "idle", revision: state.revision, blockers: [] }]);
  await f.hosts.stop(first.runtimeId, state.revision, false);
});

it("uses TUI revisions and fences TUI admission before recapturing backend activity", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const before = await f.hosts.inspect(host.runtimeId);
  const freeze = vi.spyOn(f.hosts.managedTui, "freezeAdmission");
  const restore = vi.spyOn(f.hosts.managedTui, "restoreAdmission");
  const activity = vi.spyOn(f.hosts.managedTui, "activity").mockReturnValue({ state: "active", revision: "new-terminal", blockers: ["live_terminal"] });
  await expect(f.hosts.stop(host.runtimeId, before.revision, false)).rejects.toThrow("confirmation_stale");
  expect(freeze).toHaveBeenCalledWith(host.runtimeId);
  expect(restore).toHaveBeenCalledWith(host.runtimeId);
  const active = await f.hosts.inspect(host.runtimeId);
  expect(active.blockers).toContain("live_terminal");
  await expect(f.hosts.stop(host.runtimeId, active.revision, false)).rejects.toThrow("restart_blocked");
  expect(native.closes).toBe(0);
  activity.mockRestore();
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, false);
  expect(native.closes).toBe(1);
});

it("retains a runtime with cleanup uncertainty even after explicit force", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  native.cleanupFailure = true;
  const current = await f.hosts.inspect(host.runtimeId);
  await expect(f.hosts.stop(host.runtimeId, current.revision, true)).rejects.toThrow("cleanup_unproven");
  expect(f.hosts.get(host.runtimeId)).toBe(host);
  expect(native.closes).toBe(1);
  native.cleanupFailure = false;
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, false);
});

it("reports forced cleanup failure over the carrier and retries only the retained owner", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const carrier = await createSidecarFramedCarrier();
  const detach = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(f.epoch), registry: carrier.hostRegistry, channel: carrier.hostChannel,
    hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const connection = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  const authority = { scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  try {
    await carrier.start();
    expect(await connection.lookup(configuration)).toBe(host.runtimeId);
    const close = vi.spyOn(f.hosts.getRuntime(host.runtimeId).supervisor, "close").mockRejectedValueOnce(new Error("unexpected_shutdown_error"));
    await expect(connection.stop(authority, (await connection.inspect(authority)).revision, true)).rejects.toMatchObject({
      name: "SidecarOperationError", code: "sidecar_operation_failed",
    });
    close.mockRestore();
    native.cleanupFailure = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = await connection.inspect(authority);
      await expect(connection.stop(authority, observed.revision, true)).rejects.toMatchObject({
        name: "BackendRuntimeControlRejectedError", reason: "cleanup_unproven", cause: { code: "codex_runtime_cleanup_unproven" },
      });
      expect(f.hosts.get(host.runtimeId)).toBe(host);
    }
    expect(native.closes).toBe(2);
    // This fake supplies new cleanup proof; real supervisors may continue to
    // reject when their original process ownership still cannot be proven.
    native.cleanupFailure = false;
    await connection.stop(authority, (await connection.inspect(authority)).revision, true);
    expect(native.closes).toBe(3);
    expect(native.launches).toBe(1);
    expect(() => f.hosts.get(host.runtimeId)).toThrow("codex_runtime_unknown");
  } finally { connection.close(); detach(); await carrier.close(); }
});

it("looks up retained runtimes and permits receipt recovery while new admission is fenced", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const epoch = f.services.attach({ ...serviceConfiguration, operationsRevision: 2 }, "recovery");
  await expect(f.hosts.lookup({ ...configuration, instance: { ...configuration.instance, enabled: false, configurationRevision: 0 } }, epoch)).resolves.toBe(host);
  await expect(f.hosts.ensure(configuration, epoch)).resolves.toBe(host);
  await expect(f.hosts.lookup({ ...configuration, connections: [{ ...configuration.connections[0]!, ownerPrincipalId: "intruder" }] }, epoch)).rejects.toThrow("scope_denied");
  await expect(f.hosts.lookup(configuration, f.epoch)).rejects.toThrow("controller_stale");
  const other = { ...configuration, instance: { ...configuration.instance, id: "other" }, connections: [{ ...configuration.connections[0]!, backendInstanceId: "other" }] };
  await expect(f.hosts.lookup(other, epoch)).resolves.toBeUndefined();
  await expect(f.hosts.ensure(other, epoch)).rejects.toThrow("recovery_attachment_read_only");
  expect(native.launches).toBe(1);
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, false);
});

it("binds the original launch before initialize and fences later replacements against installed policy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-launch-stamp-"));
  const owned = { ...configuration, connection: { ownership: "owned" as const, channel: { type: "process_stdio" as const, executablePath: "/usr/bin/false", workingDirectory: directory, codexHome: directory } } };
  const changed = { ...owned, startupEnvironmentVariables: { TEST: { kind: "literal" as const, value: "new" } } };
  const f = fixture(owned);
  const carrier = await createSidecarFramedCarrier();
  const detach = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(f.epoch), registry: carrier.hostRegistry,
    channel: carrier.hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  let initializing!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { initializing = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  native.beforeReady = () => { initializing(); return hold; };
  const remote = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  try {
    await carrier.start();
    const launching = remote.ensure(owned);
    await entered;
    const original = codexGrant(owned);
    const digest = original.backends[0]!.launchDigest;
    expect(f.hosts.observedLaunchDigest("backend")).toBe(digest);
    const spawn = vi.mocked(createCodexRuntimeTransport).mock.calls.at(-1)![0].assertLaunchAdmission!;
    expect(spawn).not.toThrow();
    installFixturePolicy(f.services, f.epoch, serviceConfiguration, codexGrant(changed));
    expect(spawn).toThrow("backend_policy_denied");
    release();
    await expect(launching).rejects.toMatchObject({ code: "backend_policy_denied" });
    await expect(remote.ensure(changed)).rejects.toMatchObject({ code: "codex_runtime_configuration_restart_required" });
    expect(f.hosts.observedLaunchDigest("backend")).toBe(digest);
    installFixturePolicy(f.services, f.epoch, serviceConfiguration, { ...original, backends: original.backends.map(grant => ({ ...grant, generation: 2 })) });
    expect(spawn).toThrow("backend_policy_denied");
    const host = await f.hosts.lookup(owned, f.epoch);
    expect(host).toBeDefined();
    expect(native.launches).toBe(1);
    await f.hosts.stop(host!.runtimeId, (await f.hosts.inspect(host!.runtimeId)).revision, false);
  } finally { release(); remote.close(); detach(); await carrier.close(); await rm(directory, { recursive: true, force: true }); }
});

it("reattaches across pending startup edits while preserving native identity", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const desired = { ...configuration, startupEnvironmentVariables: { TEST_START: { kind: "literal" as const, value: "new" } } };
  await expect(f.hosts.ensure(desired, f.epoch)).rejects.toThrow("codex_runtime_configuration_restart_required");
  await expect(f.hosts.lookup(desired, f.epoch)).resolves.toBe(host);
  await expect(f.hosts.lookup({ ...desired, connection: { ...desired.connection, channel: { type: "unix_websocket", socketPath: "/changed" } } }, f.epoch)).rejects.toThrow("restart_required");
  await expect(f.hosts.lookup({ ...desired, connections: [{ ...desired.connections[0]!, ownerPrincipalId: "intruder" }] }, f.epoch)).rejects.toThrow("scope_denied");
  const snapshot = await f.hosts.inspect(host.runtimeId);
  expect(snapshot.startupEnvironmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  await f.hosts.stop(host.runtimeId, snapshot.revision, false);
  await expect(f.hosts.lookup(desired, f.epoch)).resolves.toBeUndefined();
  expect(native.launches).toBe(1);
});

it.each([false, true])("wakes a parked provider under the latest saved launch configuration (retry after failed launch: %s)", async retry => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-parked-relaunch-"));
  const owned = { ...configuration, connection: { ownership: "owned" as const,
    channel: { type: "process_stdio" as const, executablePath: "/usr/bin/false", workingDirectory: directory, codexHome: directory } },
    startupEnvironmentVariables: { PATH: { kind: "literal" as const, value: "/original/bin" } } };
  let desired = owned;
  const f = fixture(owned);
  const carrier = await createSidecarFramedCarrier();
  const detach = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(f.epoch), registry: carrier.hostRegistry,
    channel: carrier.hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const compact = vi.fn(() => 0);
  const pending = vi.fn<import("../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js").CodexRuntimeReceiptSink["pending"]>(() => []);
  const main = new CodexRemoteRuntimeSupervisor({
    scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: owned.instance.id },
    configuration: owned, readCurrentLaunchConfiguration: () => desired, serverRequests: new CodexServerRequestRouter(),
    provider: { acquireExisting: vi.fn(), acquire: async () => ({ channel: carrier.mainChannel, controllerEpoch: f.epoch,
      serviceIncarnation: f.services.serviceIncarnation, closed: new Promise<void>(() => {}), release() {} }) },
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending,
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: compact, releaseRejected: () => false },
  });
  try {
    await carrier.start();
    const original = await main.attachment();
    await main.client.residency!.retain().release(true);
    expect(main.client.lifecycleSnapshot().state).toBe("idle");
    expect(f.hosts.observedLaunchDigest(owned.instance.id)).toBeNull();
    desired = { ...owned, startupEnvironmentVariables: { PATH: { kind: "literal", value: "/changed/bin" } } };
    installFixturePolicy(f.services, f.epoch, serviceConfiguration, codexGrant(desired));
    const work = main.client.residency!.retain();
    const request = () => main.client.request(codexRuntimeMethod("model/list"), {}, { timeoutMilliseconds: 1000 });
    const heldTui = vi.spyOn(f.hosts.managedTui, "activity").mockReturnValue({ state: "active", revision: "terminal", blockers: ["live_terminal"] });
    expect(f.hosts.observedLaunchDigest(owned.instance.id)).toBe(codexGrant(owned).backends[0]!.launchDigest);
    await expect(request()).rejects.toMatchObject({ code: "codex_runtime_configuration_restart_required" });
    expect((await main.attachment()).runtimeId).toBe(original.runtimeId);
    expect(native.closes).toBe(0);
    heldTui.mockRestore();
    pending.mockReturnValueOnce([{ method: "turn/start", operationId: "turn", requestFingerprint: "0".repeat(64), state: "reserved",
      correlation: { kind: "start", applicationThreadId: "thread", applicationOperationId: "operation" }, outcome: null }]);
    await expect(request()).rejects.toMatchObject({ code: "codex_runtime_configuration_restart_required" });
    expect((await main.attachment()).runtimeId).toBe(original.runtimeId);

    const eligible = desired;
    desired = { ...desired, connection: { ...desired.connection, channel: { ...desired.connection.channel, codexHome: directory + "-other-store" } } };
    installFixturePolicy(f.services, f.epoch, serviceConfiguration, codexGrant(desired));
    await expect(request()).rejects.toMatchObject({ code: "codex_runtime_configuration_restart_required" });
    expect((await main.attachment()).runtimeId).toBe(original.runtimeId);
    expect(native.closes).toBe(0);
    desired = eligible;
    installFixturePolicy(f.services, f.epoch, serviceConfiguration, codexGrant(desired));
    if (retry) {
      native.beforeReady = async () => { throw new Error("test_bootstrap_failed"); };
      await expect(request()).rejects.toMatchObject({ code: "sidecar_operation_failed" });
      expect(await f.hosts.lookup(eligible, f.epoch)).toBeUndefined();
      native.beforeReady = undefined;
      desired = { ...eligible, startupEnvironmentVariables: { PATH: { kind: "literal", value: "/newest/bin" } } };
      installFixturePolicy(f.services, f.epoch, serviceConfiguration, codexGrant(desired));
    }
    const terminalResult = { data: [], nextCursor: null };
    expect(await Promise.all([request(), request()])).toEqual([terminalResult, terminalResult]);
    expect((await main.attachment()).runtimeId).not.toBe(original.runtimeId);
    expect(main.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 2 });
    expect(await main.appliedOwnedPath()).toBe(desired.startupEnvironmentVariables.PATH.value);
    expect(f.hosts.observedLaunchDigest(owned.instance.id)).toBe(codexGrant(desired).backends[0]!.launchDigest);
    expect(native.launches).toBe(retry ? 3 : 2);
    expect(native.closes).toBe(retry ? 2 : 1);
    if (retry) expect(compact).not.toHaveBeenCalled(); // An absent runtime after failed bootstrap carries no retirement receipt.
    else expect(compact).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: original.runtimeId }),
      expect.objectContaining({ disposition: "confirmed_retired", runtimeId: original.runtimeId }));
    expect(f.archive).not.toHaveBeenCalled();
    await work.release();
  } finally {
    await main.close();
    const host = await f.hosts.lookup(desired, f.epoch);
    if (host) await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true);
    detach(); await carrier.close(); await rm(directory, { recursive: true, force: true });
  }
});

it("reads the applied owned PATH across pending startup edits and changes it only after explicit restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-owned-path-"));
  const owned = { ...configuration, connection: { ownership: "owned" as const, channel: { type: "process_stdio" as const, executablePath: "/usr/bin/false", workingDirectory: directory, codexHome: directory } }, startupEnvironmentVariables: { PATH: { kind: "literal" as const, value: "/applied/bin" } } };
  const f = fixture(owned);
  const desired = { ...owned, startupEnvironmentVariables: { PATH: { kind: "literal" as const, value: "/pending/bin" } } };
  const carrier = await createSidecarFramedCarrier();
  const detach = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(f.epoch), registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const connection = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  const getExecutionPolicy = () => f.services.executionPolicy(f.epoch);
  let host = await f.hosts.ensure(owned, f.epoch);
  launchAdmission({ getExecutionPolicy }, "codex_app_server", "backend", codexGrant(owned).backends[0]!.launchDigest).bind(host);
  const authority = () => ({ scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: host.runtimeId, controllerId: String(f.epoch) });
  try {
    await carrier.start();
    await expect(connection.attach(authority(), () => {})).rejects.toMatchObject({ code: "codex_runtime_not_attached" });
    expect(await connection.lookup(owned)).toBe(host.runtimeId);
    await connection.attach(authority(), () => {});
    expect(await connection.appliedOwnedPath(authority())).toBe("/applied/bin");
    const appliedFingerprint = (await f.hosts.inspect(host.runtimeId)).startupEnvironmentFingerprint;
    await expect(f.hosts.ensure(desired, f.epoch)).rejects.toThrow("codex_runtime_configuration_restart_required");
    expect(await f.hosts.lookup(desired, f.epoch)).toBe(host);
    expect(await connection.appliedOwnedPath(authority())).toBe("/applied/bin");
    // A new main-server supervisor knows only desired configuration. It must
    // still attach and perform native RPC using the retained applied owner.
    await connection.detach(authority());
    const replacement = new CodexRemoteRuntimeSupervisor({ scope: authority().scope, configuration: desired,
      provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire: async () => ({ channel: carrier.mainChannel, controllerEpoch: f.epoch, serviceIncarnation: f.services.serviceIncarnation, closed: new Promise<void>(() => {}), release() {} }) },
      serverRequests: new CodexServerRequestRouter(),
      receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [], reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
    });
    try {
      expect((await replacement.attachment()).runtimeId).toBe(host.runtimeId);
      expect(replacement.client.lifecycleSnapshot().state).toBe("ready");
      expect(await replacement.appliedOwnedPath()).toBe("/applied/bin");
      await expect(replacement.client.request(codexRuntimeMethod("model/list"), {}, { timeoutMilliseconds: 1000 })).resolves.toEqual({ data: [], nextCursor: null });
      expect((await f.hosts.inspect(host.runtimeId)).startupEnvironmentFingerprint).toBe(appliedFingerprint);
      expect(native.launches).toBe(1);
    } finally { await replacement.close(); }
    await connection.attach(authority(), () => {});
    await expect(connection.appliedOwnedPath({ ...authority(), scope: { ...authority().scope, principalId: "other" } })).rejects.toThrow();
    await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, false);
    const next = codexGrant(desired);
    f.services.detach(f.epoch);
    detach();
    await carrier.close();
    const epoch = attachFixturePolicy(f.services, serviceConfiguration, "normal", next);
    const freshCarrier = await createSidecarFramedCarrier();
    const release = registerCodexRuntimeHost({ getExecutionPolicy: () => f.services.executionPolicy(epoch), registry: freshCarrier.hostRegistry,
      channel: freshCarrier.hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: epoch, onDetach: () => f.services.detach(epoch) });
    try {
      await freshCarrier.start();
      const fresh = new CodexSidecarRuntimeConnection(freshCarrier.mainChannel);
      const runtimeId = await fresh.ensure(desired);
      host = f.hosts.get(runtimeId);
      const current = { ...authority(), controllerId: String(epoch) };
      await fresh.attach(current, () => {});
      expect(await fresh.appliedOwnedPath(current)).toBe("/pending/bin");
    } finally { release(); await freshCarrier.close(); }
    expect(native.launches).toBe(2);
  } finally { await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true); connection.close(); detach(); await carrier.close(); await rm(directory, { recursive: true, force: true }); }
});
