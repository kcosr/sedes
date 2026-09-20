import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { BackendRuntimeRecoveryContext } from "../../src/server/backends/module.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { claudePersistentAttachmentSchema } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { ClaudeSidecarRuntimeConnection, registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import { recoverClaudeRuntimeAdministration } from "../../src/server/backends/claude/runtime/claude-runtime-administration.js";
import { createClaudeFramedCarrier, createFakePersistentClaudeRuntime } from "../helpers/persistent-claude-fixture.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "claude" };
const configuration = { ...scope, executablePath: "/bin/claude", configDirectory: "/config", initializationTimeoutMs: 1000 };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const native = createFakePersistentClaudeRuntime();
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration });
  const createRuntime = vi.fn(() => native.runtime);
  const artifact = vi.fn(async () => { throw new Error("recovery_must_not_load_artifact"); });
  const hosts = new ClaudePersistentRuntimeRegistry({ scope, executionEnvironmentId: scope.executionEnvironmentId,
    environmentChannel: {} as ExecutionEnvironmentChannelProvider, environment: {}, services, artifact, createRuntime });
  const carrier = await createClaudeFramedCarrier();
  const controllerEpoch = services.attach(serviceConfiguration);
  const detach = registerClaudePersistentRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, controllerEpoch, onDetach: () => services.detach(controllerEpoch) });
  await carrier.start();
  const release = vi.fn();
  const context: BackendRuntimeRecoveryContext = {
    database: {} as BackendRuntimeRecoveryContext["database"], scope,
    instance: { id: scope.backendInstanceId, tenantId: scope.tenantId, kind: "claude_agent_sdk", label: "Claude", enabled: false, configurationRevision: 0, protocolRelease: "0.3.274" },
    connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "claude_agent_sdk", backendInstanceId: scope.backendInstanceId, executionEnvironmentId: scope.executionEnvironmentId, label: "Claude", enabled: false, configurationRevision: 0 }],
    sidecarRuntime: { acquireRecovery: vi.fn(async () => ({ channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation, closed: new Promise(() => {}), release })) },
  };
  cleanup.push(async () => { detach(); await carrier.close(); await native.runtime.close(); });
  return { ...native, services, hosts, context, createRuntime, artifact, release, detach, controllerEpoch, connection: new ClaudeSidecarRuntimeConnection(carrier.mainChannel) };
}

it("recovers only existing providers and releases every administrative attachment", async () => {
  const f = await fixture();
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration })).resolves.toBeUndefined();
  expect(f.createRuntime).not.toHaveBeenCalled(); expect(f.artifact).not.toHaveBeenCalled();
  const runtimeId = await f.connection.ensure(configuration);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const snapshot = await admin.inspect();
  expect(snapshot).toMatchObject({ state: "idle", incarnation: runtimeId, revision: "0", blockers: [], startupEnvironmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await admin.restart({ expectedRevision: snapshot.revision, force: false });
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
  await admin.stop({ expectedRevision: snapshot.revision, force: false });
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration })).resolves.toBeUndefined();
  expect(f.createRuntime).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledTimes(6);
});

it("rejects wrong scope, configuration drift, stale controller and changed incarnation", async () => {
  const f = await fixture();
  await f.connection.ensure(configuration);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration: { ...configuration, principalId: "intruder" } })).rejects.toThrow("scope_denied");
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration: { ...configuration, executablePath: "/changed" } })).rejects.toThrow();
  await expect(f.connection.lookup({ ...configuration, principalId: "intruder" }, f.controllerEpoch)).rejects.toThrow();
  await expect(f.connection.lookup(configuration, f.controllerEpoch + 1)).rejects.toThrow();
  const observed = await admin.inspect();
  await expect(admin.stop({ expectedRevision: "stale", force: true })).rejects.toMatchObject({
    name: "BackendRuntimeControlRejectedError", reason: "confirmation_stale", cause: { code: "claude_persistent_confirmation_stale" },
  });
  expect(f.runtime.close).not.toHaveBeenCalled();
  await admin.stop({ expectedRevision: observed.revision, force: false });
  await f.connection.ensure(configuration);
  await expect(admin.inspect()).rejects.toThrow("incarnation_changed");
  await expect(admin.stop({ expectedRevision: observed.revision, force: true })).rejects.toThrow("incarnation_changed");
});

it.each(["active_work", "pending_interaction", "unsettled_outcome", "cleanup_unproven"] as const)("blocks retirement for %s and never fabricates cleanup", async blocker => {
  const f = await fixture();
  const id = await f.connection.ensure(configuration);
  const host = f.hosts.get(id);
  const observed = vi.spyOn(host, "snapshot").mockReturnValue({ state: blocker === "cleanup_unproven" ? "unknown" : "active", revision: "7", blockers: [blocker] });
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  await expect(admin.inspect()).resolves.toMatchObject({ blockers: [blocker] });
  const reason = blocker === "cleanup_unproven" ? "cleanup_unproven" : "blocked";
  await expect(admin.stop({ expectedRevision: "7", force: false })).rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason });
  await expect(f.connection.stop({ configuration, runtimeId: id, controllerEpoch: f.controllerEpoch, expectedRevision: "7", force: false }))
    .rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason });
  expect(f.runtime.close).not.toHaveBeenCalled();
  await admin.stop({ expectedRevision: "7", force: true });
  expect(f.runtime.close).toHaveBeenCalledOnce();
  observed.mockRestore();
});

it("retains cleanup failure evidence and distinguishes disconnection from positive absence", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  f.runtime.close.mockRejectedValueOnce(new Error("worker_exit_unproven"));
  const cleanupError = await admin.stop({ expectedRevision: "0", force: false }).catch(error => error);
  expect(cleanupError).toBeInstanceOf(Error);
  expect(cleanupError).not.toBeInstanceOf(BackendRuntimeControlRejectedError);
  expect(f.hosts.lookup(configuration, f.controllerEpoch)?.runtimeId).toBe(runtimeId);
  await expect(admin.inspect()).resolves.toMatchObject({ state: "unknown", blockers: ["cleanup_unproven"] });
  f.detach();
  expect(f.runtime.close).toHaveBeenCalledOnce();
  await expect(admin.stop({ expectedRevision: "1", force: true })).rejects.toThrow();
  await expect(recoverClaudeRuntimeAdministration({ context: { ...f.context, sidecarRuntime: { acquireRecovery: async () => { throw new Error("carrier_unavailable"); } } }, configuration })).rejects.toThrow("carrier_unavailable");
});

it("allows a fresh forced Stop after the owner positively reports incomplete cleanup", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  f.runtime.close.mockRejectedValueOnce(new Error("worker_exit_unproven"));
  await expect(admin.stop({ expectedRevision: "0", force: true })).rejects.toMatchObject({
    name: "BackendRuntimeControlRejectedError", reason: "cleanup_unproven", cause: { code: "claude_persistent_cleanup_unproven" },
  });
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)?.runtimeId).toBe(runtimeId);
  const retry = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const observed = await retry.inspect();
  expect(observed).toMatchObject({ state: "unknown", blockers: ["cleanup_unproven"] });
  await retry.stop({ expectedRevision: observed.revision, force: true });
  expect(f.runtime.close).toHaveBeenCalledTimes(2);
  expect(f.createRuntime).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
});


it("preserves an idle stop confirmation across native reads and existing-session attachment", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  const request = { queryId: sessionId, sessionId, cwd: "/workspace", launch: "new" as const, environment: {}, enableCanUseTool: false };
  await f.connection.execute({ ...authority, action: "open", replay: "full", request });
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const observed = await admin.inspect();
  await f.connection.execute({ ...authority, action: "info", request: { sessionId, dir: "/workspace" } });
  await f.connection.execute({ ...authority, action: "messages", request: { sessionId, dir: "/workspace" } });
  await f.connection.execute({ ...authority, action: "list", request: { dir: "/workspace" } });
  await f.connection.execute({ ...authority, action: "probe", request: { cwd: "/workspace" } });
  await f.connection.execute({ ...authority, action: "submission_disposition", request: { sessionId, operationId: randomUUID(), cwd: "/workspace" } });
  await f.connection.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } });
  await f.connection.execute({ ...authority, action: "open", replay: "full", request: { ...request, launch: "resume" } });
  await f.connection.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: 0 } });
  expect(await admin.inspect()).toEqual(observed);
  await admin.stop({ expectedRevision: observed.revision, force: false });
  expect(f.runtime.close).toHaveBeenCalledOnce();
});

it("still fences stop confirmations while a provider mutation is in flight", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  await f.connection.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false,
  } });
  const before = f.hosts.inspect(runtimeId);
  let finish!: () => void;
  f.sessions[0]!.setModel.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const mutation = f.hosts.get(runtimeId).execute({ ...authority, action: "set_model", request: { queryId: sessionId, model: "claude-sonnet-4-6" } }, () => {});
  expect(f.hosts.inspect(runtimeId)).toMatchObject({ state: "active", blockers: ["active_work"] });
  await expect(f.hosts.stop(runtimeId, before.revision, true)).rejects.toThrow("claude_persistent_confirmation_stale");
  expect(f.runtime.close).not.toHaveBeenCalled();
  finish();
  await mutation;
  const settled = f.hosts.inspect(runtimeId);
  expect(settled.blockers).toEqual([]);
  await f.hosts.stop(runtimeId, settled.revision, false);
});


it.each(["idle", "active", "pending_permission"] as const)("retires a %s provider after production-shaped worker shutdown failures", async state => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  const host = f.hosts.get(runtimeId);
  await host.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: state === "pending_permission",
  } }, () => {});
  const native = f.sessions[0]!;
  if (state === "active") await host.execute({ ...authority, action: "send", request: { queryId: sessionId, operationId: randomUUID(), content: "Keep working." } }, () => {});
  const permission = state === "pending_permission" ? native.askPermission() : undefined;
  if (state !== "idle") host.detach();
  // ClaudeManagedRuntimeOwner.close -> WorkerClient.close -> workerFailed for
  // every resident query. These are shutdown notifications, not SDK results.
  f.runtime.close.mockImplementationOnce(async () => {
    native.options.onFailure!(new Error("claude_managed_runtime_closed"));
    await native.close();
  });
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const observed = await admin.inspect();
  await admin.stop({ expectedRevision: observed.revision, force: state !== "idle" });
  if (permission) await expect(permission).resolves.toMatchObject({ behavior: "deny" });
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
  const replacementId = await f.connection.ensure(configuration);
  expect(replacementId).not.toBe(runtimeId);
  expect(f.createRuntime).toHaveBeenCalledTimes(2);
});

it("preserves an answered permission receipt during automatic shutdown and keeps its handoff frozen", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  const host = f.hosts.get(runtimeId);
  await host.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
  } }, () => {});
  const native = f.sessions[0]!;
  const pending = native.options.canUseTool!("Read", {}, { requestId: "ask", toolUseID: "tool", signal: new AbortController().signal });
  const response = { behavior: "allow" as const, updatedInput: {} };
  await host.execute({ ...authority, action: "respond_permission", request: { sessionId, requestId: "ask", toolUseID: "tool", response } }, () => {});
  await expect(pending).resolves.toEqual(response);
  host.detach();
  f.runtime.close.mockImplementationOnce(async () => {
    native.options.onFailure!(new Error("claude_managed_runtime_closed"));
    await native.options.onPermissionResponseDelivered!({ requestId: "ask", toolUseID: "tool" });
    await native.close();
  });
  const restore = vi.spyOn(host, "restoreAdmission");
  await expect(host.stop()).rejects.toThrow("sidecar_resource_handoff_pending");
  expect(restore).not.toHaveBeenCalled();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBe(host);
  const retained = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, () => {}));
  expect(retained.events.map(event => event.payload.kind)).toEqual(["permission_delivered"]);
  expect(retained.failureCode).toBeNull();
  await expect(host.execute({ ...authority, action: "send", request: { queryId: sessionId, operationId: randomUUID(), content: "New work is forbidden." } }, () => {})).rejects.toThrow("claude_persistent_runtime_stopped");
  await host.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence: retained.events[0]!.sequence } }, () => {});
  const drained = claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, () => {}));
  expect(drained).toMatchObject({ failureCode: null, events: [] });
  expect(host.snapshot().blockers).not.toContain("unsettled_outcome");
  await f.hosts.stop(runtimeId, host.snapshot().revision, false);
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
});

it("retains deferred shutdown failure evidence when native cleanup cannot be proven", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  const host = f.hosts.get(runtimeId);
  await host.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false,
  } }, () => {});
  f.runtime.close.mockImplementationOnce(async () => {
    f.sessions[0]!.options.onFailure!(new Error("claude_managed_runtime_closed"));
    throw new Error("worker_exit_unproven");
  });
  await expect(f.hosts.stop(runtimeId, host.snapshot().revision, true)).rejects.toMatchObject({
    message: "claude_persistent_cleanup_unproven", cause: { message: "worker_exit_unproven" },
  });
  expect(host.snapshot()).toMatchObject({ state: "unknown", blockers: ["cleanup_unproven", "unsettled_outcome"] });
});

it("discovers positive absence when an admitted recovery carrier has no Claude host", async () => {
  const f = await fixture();
  const supported = vi.spyOn(f.connection.channel, "supportsOperation").mockReturnValue(false);
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration }))
    .resolves.toBeUndefined();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.createRuntime).not.toHaveBeenCalled();
  supported.mockRestore();
});

it("fails closed when Claude capability disappears after recovering a provider", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const supported = vi.spyOn(f.connection.channel, "supportsOperation").mockReturnValue(false);
  await expect(admin.inspect()).rejects.toThrow("claude_remote_runtime_unsupported");
  await expect(admin.stop({ expectedRevision: "0", force: false })).rejects.toThrow("claude_remote_runtime_unsupported");
  await expect(admin.restart({ expectedRevision: "0", force: true })).rejects.toThrow("claude_remote_runtime_unsupported");
  expect(f.release).toHaveBeenCalledTimes(4);
  expect(f.runtime.close).not.toHaveBeenCalled();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)?.runtimeId).toBe(runtimeId);
  supported.mockRestore();
});

it("rejects a closed framed recovery channel instead of authorizing provider absence", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  await f.connection.channel.peer.close("test_recovery_close_race");
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration }))
    .rejects.toThrow("sidecar_protocol_peer_closed");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.runtime.close).not.toHaveBeenCalled();
  expect(f.hosts.get(runtimeId)).toBeDefined();
});

it("rejects a recovery channel before its framed hello completes", async () => {
  const f = await fixture();
  const carrier = await createClaudeFramedCarrier();
  cleanup.push(async () => await carrier.close());
  carrier.mainPeer.start(); carrier.hostPeer.start();
  vi.mocked(f.context.sidecarRuntime.acquireRecovery).mockResolvedValue({
    channel: carrier.mainChannel, controllerEpoch: f.controllerEpoch,
    serviceIncarnation: f.services.serviceIncarnation, closed: new Promise(() => {}), release: f.release,
  });
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration }))
    .rejects.toThrow("sidecar_protocol_hello_required");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.createRuntime).not.toHaveBeenCalled();
});

it("does not mistake a partial Claude operation contract for initial absence", async () => {
  const f = await fixture();
  const supported = vi.spyOn(f.connection.channel, "supportsOperation")
    .mockImplementation(operation => operation.operation === "runtime.lookup");
  await expect(recoverClaudeRuntimeAdministration({ context: f.context, configuration }))
    .rejects.toThrow("claude_remote_runtime_unsupported");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.createRuntime).not.toHaveBeenCalled();
  supported.mockRestore();
});

it.each(["detach", "evict"] as const)("preserves a confirmed idle stop across clean presentation %s", async action => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  await f.connection.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false,
  } });
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration }))!;
  const confirmed = await admin.inspect();
  await f.connection.execute({ ...authority, action, request: { sessionId } });
  expect(f.sessions[0]!.close).toHaveBeenCalledTimes(action === "evict" ? 1 : 0);
  expect(await admin.inspect()).toEqual(confirmed);
  await admin.stop({ expectedRevision: confirmed.revision, force: true });
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
});

it("does not let clean idle detachment bless new provider work after confirmation", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const open = async () => {
    const sessionId = randomUUID();
    await f.connection.execute({ ...authority, action: "open", replay: "full", request: {
      queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false,
    } });
    return sessionId;
  };
  const sessionId = await open();
  const before = f.hosts.inspect(runtimeId);
  await open();
  await f.connection.execute({ ...authority, action: "detach", request: { sessionId } });
  await expect(f.hosts.stop(runtimeId, before.revision, true)).rejects.toThrow("claude_persistent_confirmation_stale");
  expect(f.runtime.close).not.toHaveBeenCalled();
});

it("retains failed idle-eviction cleanup evidence and rejects the earlier stop confirmation", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const authority = { runtimeId, controllerEpoch: f.controllerEpoch };
  const sessionId = randomUUID();
  await f.connection.execute({ ...authority, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false,
  } });
  const before = f.hosts.inspect(runtimeId);
  f.sessions[0]!.close.mockRejectedValueOnce(new Error("cleanup_unproven"));
  await expect(f.connection.execute({ ...authority, action: "evict", request: { sessionId } })).rejects.toThrow();
  const after = f.hosts.inspect(runtimeId);
  expect(after).toMatchObject({ state: "unknown", blockers: ["cleanup_unproven"] });
  expect(after.revision).not.toBe(before.revision);
  await expect(f.hosts.stop(runtimeId, before.revision, true)).rejects.toThrow("claude_persistent_confirmation_stale");
  await f.hosts.stop(runtimeId, after.revision, true);
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(configuration, f.controllerEpoch)).toBeUndefined();
});

it("allows exact pending permission settlement on a recovery controller but rejects new sessions and turns", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const host = f.hosts.get(runtimeId);
  const sessionId = randomUUID();
  const request = { queryId: sessionId, sessionId, cwd: "/workspace", launch: "new" as const, environment: {}, enableCanUseTool: true };
  await host.execute({ runtimeId, controllerEpoch: f.controllerEpoch, action: "open", replay: "full", request }, () => {});
  const pending = f.sessions[0]!.options.canUseTool!("Read", {}, { requestId: "pending", toolUseID: "tool", signal: new AbortController().signal });
  const epoch = f.services.attach(serviceConfiguration, "recovery");
  const authority = { runtimeId, controllerEpoch: epoch };
  await host.execute({ ...authority, action: "attach", replay: "unacknowledged", request: { sessionId } }, () => {});
  const response = { behavior: "allow" as const, updatedInput: {} };
  await host.execute({ ...authority, action: "respond_permission", request: { sessionId, requestId: "pending", toolUseID: "tool", response } }, () => {});
  await expect(pending).resolves.toEqual(response);
  await expect(host.execute({ ...authority, action: "send", request: { queryId: sessionId, operationId: randomUUID(), content: "new turn" } }, () => {})).rejects.toThrow("sidecar_recovery_attachment_read_only");
  const other = randomUUID();
  await expect(host.execute({ ...authority, action: "open", replay: "full", request: { ...request, queryId: other, sessionId: other, cwd: "/new-root" } }, () => {})).rejects.toThrow("sidecar_recovery_attachment_read_only");
});

it("never uses retained recovery permission authority to approve work after host admission freezes", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const host = f.hosts.get(runtimeId);
  const sessionId = randomUUID();
  await host.execute({ runtimeId, controllerEpoch: f.controllerEpoch, action: "open", replay: "full", request: {
    queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true,
  } }, () => {});
  const pending = f.sessions[0]!.options.canUseTool!("Read", {}, { requestId: "pending", toolUseID: "tool", signal: new AbortController().signal });
  const epoch = f.services.attach(serviceConfiguration, "recovery");
  host.freezeAdmission();
  const base = { runtimeId, controllerEpoch: epoch, action: "respond_permission" as const };
  const request = { sessionId, requestId: "pending", toolUseID: "tool" };
  await expect(host.execute({ ...base, request: { ...request, response: { behavior: "allow", updatedInput: {} } } }, () => {})).rejects.toThrow("claude_persistent_admission_frozen");
  await host.execute({ ...base, request: { ...request, response: { behavior: "deny", message: "Stopping" } } }, () => {});
  await expect(pending).resolves.toMatchObject({ behavior: "deny" });
});

it("reattaches pending startup configuration and explicitly retires the old host", async () => {
  const f = await fixture();
  const runtimeId = await f.connection.ensure(configuration);
  const desired = { ...configuration, startupEnvironmentVariables: { TEST_START: { kind: "literal" as const, value: "new" } } };
  await expect(f.connection.ensure(desired)).resolves.toBe(runtimeId);
  await expect(f.connection.lookup(desired, f.controllerEpoch)).resolves.toBe(runtimeId);
  const admin = (await recoverClaudeRuntimeAdministration({ context: f.context, configuration: desired }))!;
  const snapshot = await admin.inspect();
  expect(snapshot.incarnation).toBe(runtimeId);
  expect(snapshot.startupEnvironmentFingerprint).toBe(f.hosts.inspect(runtimeId).startupEnvironmentFingerprint);
  await admin.restart({ expectedRevision: snapshot.revision, force: false });
  expect(f.runtime.close).toHaveBeenCalledOnce();
  expect(f.createRuntime).toHaveBeenCalledOnce();
  expect(f.hosts.lookup(desired, f.controllerEpoch)).toBeUndefined();
});
