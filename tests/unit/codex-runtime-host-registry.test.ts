import { CodexRemoteRuntimeSupervisor } from "../../src/server/backends/codex/runtime/codex-remote-runtime-supervisor.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import { codexRuntimeMethod } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { CodexRuntimeHostRegistry } from "../../src/server/backends/codex/runtime/codex-runtime-host-registry.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { CodexSidecarRuntimeConnection, registerCodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { createClaudeFramedCarrier } from "../helpers/persistent-claude-fixture.js";

const native = vi.hoisted(() => ({ launches: 0, closes: 0, cleanupFailure: false }));
vi.mock("../../src/server/backends/codex/codex-runtime-config.js", () => ({
  resolveCodexRuntimeConfiguration: async (input: { startupEnvironmentVariables?: { PATH?: { kind: string; value?: string } }; connection: { ownership: string; channel: { codexHome?: string } } }) => ({ ...input,
    ...(input.connection.ownership === "owned" ? { childEnvironment: input.startupEnvironmentVariables?.PATH?.kind === "literal" ? { PATH: input.startupEnvironmentVariables.PATH.value } : {}, codexHome: input.connection.channel.codexHome } : {}),
  }),
}));
vi.mock("../../src/server/backends/codex/runtime/codex-runtime-transport.js", () => ({ createCodexRuntimeTransport: () => ({}) }));
vi.mock("../../src/server/backends/codex/codex-daemon-supervisor.js", async () => {
  const { CodexSharedClientFacade } = await import("../../src/server/backends/codex/codex-client-facade.js");
  return { CodexDaemonSupervisor: class {
    readonly client = new CodexSharedClientFacade({
      current: () => ({ generation: 1, request: async () => undefined as never,
        requestWithReceipt: async () => ({ result: { data: [], nextCursor: null } as never, generation: 1, inboundSequence: 1 }) }),
      latestGeneration: () => 1, retireGeneration: async () => {},
    });
    constructor() { native.launches++; }
    async start() { this.client.updateLifecycle({ state: "ready", generation: 1 }); }
    snapshot() { return { state: "ready", ...(native.cleanupFailure ? { cleanupUncertainty: {} } : {}) }; }
    async close() { native.closes++; if (native.cleanupFailure) throw new Error("native_cleanup_unproven"); }
  } };
});

const scope = { tenantId: "tenant", principalId: "principal" };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const configuration = {
  instance: { id: "backend", tenantId: scope.tenantId, kind: "codex_app_server" as const, label: "Codex", enabled: true, configurationRevision: 1, protocolRelease: "0.153.0" as const },
  connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "codex_app_server" as const, backendInstanceId: "backend", executionEnvironmentId: "remote", label: "Codex", enabled: true, configurationRevision: 1 }],
  connection: { ownership: "external" as const, channel: { type: "unix_websocket" as const, socketPath: "/provider/codex.sock" } },
};
function fixture() {
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, installationId: "installation", executionEnvironmentId: "remote" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive });
  const epoch = services.attach(serviceConfiguration);
  const hosts = new CodexRuntimeHostRegistry({ scope, executionEnvironmentId: "remote", environment: {}, environmentChannel: {} as ExecutionEnvironmentChannelProvider, services });
  return { services, hosts, epoch, archive };
}
beforeEach(() => { native.launches = 0; native.closes = 0; native.cleanupFailure = false; });

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
    evidence: expect.objectContaining({ ownership: "external", operations: [expect.objectContaining({ operationId: "unacknowledged" })] }) }));
  expect(JSON.stringify(f.archive.mock.calls)).not.toContain("private name");
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
  const carrier = await createClaudeFramedCarrier();
  const detach = registerCodexRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel,
    hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const connection = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  const authority = { scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  try {
    await carrier.start();
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
  const epoch = f.services.attach({ ...serviceConfiguration, operationsRevision: 2 });
  await expect(f.hosts.lookup({ ...configuration, instance: { ...configuration.instance, enabled: false, configurationRevision: 0 } }, epoch)).resolves.toBe(host);
  await expect(f.hosts.ensure(configuration, epoch)).resolves.toBe(host);
  await expect(f.hosts.lookup({ ...configuration, connections: [{ ...configuration.connections[0]!, ownerPrincipalId: "intruder" }] }, epoch)).rejects.toThrow("scope_denied");
  await expect(f.hosts.lookup(configuration, f.epoch)).rejects.toThrow("controller_stale");
  const other = { ...configuration, instance: { ...configuration.instance, id: "other" }, connections: [{ ...configuration.connections[0]!, backendInstanceId: "other" }] };
  await expect(f.hosts.lookup(other, epoch)).resolves.toBeUndefined();
  await expect(f.hosts.ensure(other, epoch)).rejects.toThrow("configuration_pending");
  expect(native.launches).toBe(1);
  await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, false);
});

it("reattaches across pending startup edits while preserving native identity", async () => {
  const f = fixture();
  const host = await f.hosts.ensure(configuration, f.epoch);
  const desired = { ...configuration, startupEnvironmentVariables: { TEST_START: { kind: "literal" as const, value: "new" } } };
  await expect(f.hosts.ensure(desired, f.epoch)).resolves.toBe(host);
  await expect(f.hosts.lookup(desired, f.epoch)).resolves.toBe(host);
  await expect(f.hosts.lookup({ ...desired, connection: { ...desired.connection, channel: { type: "unix_websocket", socketPath: "/changed" } } }, f.epoch)).rejects.toThrow("restart_required");
  await expect(f.hosts.lookup({ ...desired, connections: [{ ...desired.connections[0]!, ownerPrincipalId: "intruder" }] }, f.epoch)).rejects.toThrow("scope_denied");
  const snapshot = await f.hosts.inspect(host.runtimeId);
  expect(snapshot.startupEnvironmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  await f.hosts.stop(host.runtimeId, snapshot.revision, false);
  await expect(f.hosts.lookup(desired, f.epoch)).resolves.toBeUndefined();
  expect(native.launches).toBe(1);
});

it("reads the applied owned PATH across pending startup edits and changes it only after explicit restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-owned-path-"));
  const f = fixture();
  const owned = { ...configuration, connection: { ownership: "owned" as const, channel: { type: "process_stdio" as const, executablePath: "/usr/bin/false", workingDirectory: directory, codexHome: directory } }, startupEnvironmentVariables: { PATH: { kind: "literal" as const, value: "/applied/bin" } } };
  const desired = { ...owned, startupEnvironmentVariables: { PATH: { kind: "literal" as const, value: "/pending/bin" } } };
  const carrier = await createClaudeFramedCarrier();
  const detach = registerCodexRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts: f.hosts, services: f.services, controllerEpoch: f.epoch, onDetach: () => f.services.detach(f.epoch) });
  const connection = new CodexSidecarRuntimeConnection(carrier.mainChannel);
  let host = await f.hosts.ensure(owned, f.epoch);
  const authority = () => ({ scope: { ...scope, executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: host.runtimeId, controllerId: String(f.epoch) });
  try {
    await carrier.start(); await connection.attach(authority(), () => {});
    expect(await connection.appliedOwnedPath(authority())).toBe("/applied/bin");
    const appliedFingerprint = (await f.hosts.inspect(host.runtimeId)).startupEnvironmentFingerprint;
    await expect(f.hosts.ensure(desired, f.epoch)).resolves.toBe(host);
    expect(await f.hosts.lookup(desired, f.epoch)).toBe(host);
    expect(await connection.appliedOwnedPath(authority())).toBe("/applied/bin");
    // A new main-server supervisor knows only desired configuration. It must
    // still attach and perform native RPC using the retained applied owner.
    await connection.detach(authority());
    const replacement = new CodexRemoteRuntimeSupervisor({ scope: authority().scope, configuration: desired,
      provider: { acquire: async () => ({ channel: carrier.mainChannel, controllerEpoch: f.epoch, serviceIncarnation: f.services.serviceIncarnation, closed: new Promise<void>(() => {}), release() {} }) },
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
    host = await f.hosts.ensure(desired, f.epoch); await connection.attach(authority(), () => {});
    expect(await connection.appliedOwnedPath(authority())).toBe("/pending/bin");
    expect(native.launches).toBe(2);
  } finally { await f.hosts.stop(host.runtimeId, (await f.hosts.inspect(host.runtimeId)).revision, true); connection.close(); detach(); await carrier.close(); await rm(directory, { recursive: true, force: true }); }
});
