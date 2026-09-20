import { authenticatedProductionFetch } from "../helpers/authenticated-production-client.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationAdminService } from "../../src/server/configuration-admin/configuration-admin-service.js";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseExecutionTargetReader } from "../../src/server/application/execution-target-reader.js";
import { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import { PrincipalBackendRuntimeCollection } from "../../src/server/runtime/principal-backend-runtime-collection.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";
import { configurationDocumentSchema } from "../../src/shared/protocol/configuration-admin.js";
import { SidecarRuntimeOwner, SidecarUnavailableError } from "../../src/server/sidecar/sidecar-runtime.js";
import { SidecarServiceManagementError, SidecarServiceStagingError } from "../../src/server/sidecar/sidecar-provisioner.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import type { SidecarServiceStatus } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { createClaudeFramedCarrier } from "../helpers/persistent-claude-fixture.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";

let application: RunningApplication | undefined;
let directory: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await application?.close();
  application = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function openApplication() {
  const get = vi.spyOn(ConfigurationAdminService.prototype, "get");
  application = await startProductionApplication({
    ...process.env, APP_STATE_DIR: directory!, SEDES_CONFIG_FILE: path.join(directory!, "server.json"), PORT: "0",
    PI_CODING_AGENT_DIR: path.join(directory!, "pi"), XDG_RUNTIME_DIR: path.join(directory!, "runtime"),
  });
  const address = application.server.address();
  if (!address || typeof address === "string") throw new Error("test_server_not_listening");
  const authenticatedFetch = await authenticatedProductionFetch(application);
  const response = await authenticatedFetch(`http://127.0.0.1:${address.port}/api/configuration`);
  expect(response.status).toBe(200);
  const service = get.mock.contexts.at(-1) as ConfigurationAdminService;
  const scope = get.mock.calls.at(-1)![0];
  get.mockRestore();
  return { service, scope };
}

async function fixture() {
  directory = await mkdtemp(path.join(tmpdir(), "sedes-config-reconcile-"));
  await writeFile(path.join(directory, "server.json"), JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
  const { service, scope } = await openApplication();
  const environmentId = randomUUID();
  const document = configurationDocumentSchema.parse({
    executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: [directory], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: [
      { id: "idle-pi", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } },
      { id: "busy-claude", kind: "claude_agent_sdk", label: "Claude", enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: { executablePath: path.join(directory, "uninstalled-claude"), configDirectory: path.join(directory, "claude"), initializationTimeoutMs: 1000, permissionPolicy: { allowedModes: ["default"] } } },
    ],
    targets: [
      { id: "idle-pi-target", backendInstanceId: "idle-pi", executionEnvironmentId: environmentId, kind: "pi_sdk", label: "Pi", enabled: true },
      { id: "busy-claude-target", backendInstanceId: "busy-claude", executionEnvironmentId: environmentId, kind: "claude_agent_sdk", label: "Claude", enabled: true,
        moduleConfiguration: { defaults: { permissionMode: "default" } } },
    ],
    defaultTargetId: "idle-pi-target", webSearch: null,
  });
  await service.save(scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
  const snapshot = await service.get(scope);
  expect(snapshot.runtimes.map(runtime => ({id: runtime.resourceId, applyState: runtime.applyState}))).toEqual(expect.arrayContaining([
    {id: environmentId, applyState: "applied"}, {id: "idle-pi", applyState: "applied"}, {id: "busy-claude", applyState: "applied"},
  ]));
  return { service, scope, environmentId, snapshot };
}

describe("production configuration reconciliation", () => {
  it.each([false, true])("recovers retained startup settings after main restarts (transient inspection failure: %s)", async failFirstInspection => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const backendId = "retained-startup-claude";
    const configuration = structuredClone(snapshot.configuration);
    const appliedStartup = { BUILD_STAGE: { kind: "literal" as const, value: "A" } };
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Retained host", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    configuration.backends.push({ id: backendId, kind: "claude_agent_sdk", label: "Retained Claude", enabled: true, modelPolicy: { type: "catalog" },
      environmentVariables: { execution: {}, startup: appliedStartup },
      moduleConfiguration: { executablePath: "/bin/claude", configDirectory: "/config/claude", initializationTimeoutMs: 1000, permissionPolicy: { allowedModes: ["default"] } } });
    configuration.targets.push({ id: "retained-startup-target", backendInstanceId: backendId, executionEnvironmentId: environmentId, kind: "claude_agent_sdk", label: "Retained Claude", enabled: true,
      moduleConfiguration: { defaults: { permissionMode: "default" } } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "retained-service", buildId: "test-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: true, attachmentMode: "recovery", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    const inspectService = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    const connect = vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockRejectedValue(new Error("unexpected_provider_launch"));
    const acquire = vi.spyOn(SidecarRuntimeOwner.prototype, "acquireOperation").mockRejectedValue(new Error("unexpected_provider_launch"));
    const stop = vi.fn(async () => undefined);
    const inspect = vi.fn(async () => ({ state: "idle" as const, incarnation: "retained-provider", revision: "provider-revision", blockers: [],
      startupEnvironmentFingerprint: configurationFingerprint(appliedStartup) }));
    const recover = vi.fn(async () => ({ inspect, stop, restart: stop }));
    const prepare = compiledBackendModuleCatalog.prepare.bind(compiledBackendModuleCatalog);
    vi.spyOn(compiledBackendModuleCatalog, "prepare").mockImplementation(input => prepare(input).map(prepared => {
      if (prepared.backendInstanceId === backendId) prepared.recoverAdministration = recover;
      return prepared;
    }));
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    expect((await service.get(scope)).runtimes.find(item => item.resourceId === backendId))
      .toMatchObject({ connectionState: "connected", applyState: "applied", startupEnvironmentPending: false });
    configuration.backends.find(item => item.id === backendId)!.environmentVariables!.startup = { BUILD_STAGE: { kind: "literal", value: "B" } };
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: saved.revision, configuration });
    expect((await service.get(scope)).runtimes.find(item => item.resourceId === backendId))
      .toMatchObject({ connectionState: "connected", applyState: "pending", startupEnvironmentPending: true });
    await application!.close();
    application = undefined;
    inspect.mockClear(); recover.mockClear(); inspectService.mockClear();
    if (failFirstInspection) inspect.mockRejectedValueOnce(new Error("transient_observation_failure"));
    const restarted = await openApplication();
    expect((await restarted.service.get(restarted.scope)).runtimes.find(item => item.resourceId === backendId))
      .toMatchObject({ connectionState: "connected", applyState: "pending", startupEnvironmentPending: true, incarnation: "retained-provider" });
    await restarted.service.get(restarted.scope);
    expect(inspect).toHaveBeenCalledTimes(failFirstInspection ? 2 : 1);
    expect(recover).toHaveBeenCalledTimes(failFirstInspection ? 2 : 1);
    expect(inspectService).toHaveBeenCalledTimes(failFirstInspection ? 2 : 1);
    expect(connect).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps owned startup changes pending until an explicit backend restart", async () => {
    const { service, scope, environmentId, snapshot } = await fixture();
    const backendId = "owned-startup-codex";
    await mkdir(path.join(directory!, "startup-codex"));
    const configuration = structuredClone(snapshot.configuration);
    configuration.backends.push({ id: backendId, kind: "codex_app_server", label: "Owned Codex", enabled: true,
      modelPolicy: { type: "catalog" }, environmentVariables: { execution: {}, startup: { BUILD_STAGE: { kind: "literal", value: "A" } } },
      moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: process.execPath,
          workingDirectory: directory!, codexHome: path.join(directory!, "startup-codex") } },
        policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
      } });
    configuration.targets.push({ id: "owned-startup-target", kind: "codex_app_server", label: "Owned Codex", enabled: true,
      backendInstanceId: backendId, executionEnvironmentId: environmentId,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } } } });
    const launches: unknown[] = [];
    const stops = vi.fn(async () => undefined);
    const prepare = compiledBackendModuleCatalog.prepare.bind(compiledBackendModuleCatalog);
    // Keep the real module and composition; substitute only provider launch evidence
    // so this lifecycle test never starts a live Codex process.
    vi.spyOn(compiledBackendModuleCatalog, "prepare").mockImplementation(input => prepare(input).map(prepared => {
      if (prepared.backendInstanceId !== backendId) return prepared;
      const create = prepared.createRuntime.bind(prepared);
      prepared.createRuntime = context => {
        const runtime = create(context);
        const incarnation = `fixture-provider-${launches.length + 1}`;
        launches.push(structuredClone(input.backends.find(item => item.id === backendId)!.environmentVariables!.startup));
        vi.spyOn(runtime, "startupEnvironmentState").mockResolvedValue("started");
        Object.defineProperty(runtime, "administration", { value: {
          inspect: async () => ({ state: "idle" as const, incarnation, revision: incarnation, blockers: [] }),
          stop: stops, restart: stops,
        } });
        return runtime;
      };
      return prepared;
    }));
    const initial = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await service.impact(scope, { resourceKind: "backend", resourceId: backendId, action: "restart", expectedRevision: initial.revision });
    const before = (await service.get(scope)).runtimes.find(item => item.resourceId === backendId)!;
    expect(before).toMatchObject({ connectionState: "connected", applyState: "applied", startupEnvironmentPending: false });
    expect(launches).toEqual([{ BUILD_STAGE: { kind: "literal", value: "A" } }]);
    configuration.backends.find(item => item.id === backendId)!.environmentVariables!.startup.BUILD_STAGE = { kind: "literal", value: "B" };
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: initial.revision, configuration });
    const pending = (await service.get(scope)).runtimes.find(item => item.resourceId === backendId)!;
    expect(pending).toMatchObject({ connectionState: "connected", applyState: "pending", startupEnvironmentPending: true, incarnation: before.incarnation });
    expect(launches).toHaveLength(1);
    expect(stops).not.toHaveBeenCalled();
    const impact = await service.impact(scope, { resourceKind: "backend", resourceId: backendId, action: "restart", expectedRevision: saved.revision });
    const restarted = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: backendId,
      action: "restart", expectedRevision: saved.revision, expectedIncarnation: pending.incarnation, impactToken: impact.token });
    expect(restarted).toMatchObject({ state: "applied", runtime: { connectionState: "connected", startupEnvironmentPending: false } });
    expect(restarted.runtime.incarnation).not.toBe(before.incarnation);
    expect(stops).toHaveBeenCalledOnce();
    expect(launches).toEqual([{ BUILD_STAGE: { kind: "literal", value: "A" } }, { BUILD_STAGE: { kind: "literal", value: "B" } }]);
  });

  it("allows another backend Stop after a confirmed provider refusal but fences uncertain transport outcomes", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const backendId = "retained-claude";
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Retained host", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    configuration.backends.push({ id: backendId, kind: "claude_agent_sdk", label: "Retained Claude", enabled: false, modelPolicy: { type: "catalog" },
      moduleConfiguration: { executablePath: "/bin/claude", configDirectory: "/config/claude", initializationTimeoutMs: 1000, permissionPolicy: { allowedModes: ["default"] } } });
    configuration.targets.push({ id: "retained-claude-target", backendInstanceId: backendId, executionEnvironmentId: environmentId, kind: "claude_agent_sdk", label: "Retained Claude", enabled: false,
      moduleConfiguration: { defaults: { permissionMode: "default" } } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "retained-service", buildId: "test-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: true, attachmentMode: "recovery", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockResolvedValue(status);
    const environmentStop = vi.spyOn(SidecarRuntimeOwner.prototype, "controlService");
    let present = true;
    let refusal: Error | undefined;
    const stop = vi.fn(async () => { if (refusal) throw refusal; present = false; });
    const administration = { inspect: async () => ({state: "idle" as const, incarnation: "retained-provider", revision: "provider-revision", blockers: []}), stop, restart: stop };
    const prepare = compiledBackendModuleCatalog.prepare.bind(compiledBackendModuleCatalog);
    vi.spyOn(compiledBackendModuleCatalog, "prepare").mockImplementation(input => prepare(input).map(prepared => {
      if (prepared.backendInstanceId === backendId) prepared.recoverAdministration = async () => present ? administration : undefined;
      return prepared;
    }));
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    const requestStop = async () => {
      const revision = (await service.get(scope)).revision;
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: backendId, action: "stop", expectedRevision: revision });
      return service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: backendId,
        action: "stop", expectedRevision: revision, expectedIncarnation: "retained-provider", impactToken: impact.token });
    };
    for (const reason of ["confirmation_stale", "blocked", "cleanup_unproven"] as const) {
      present = true;
      refusal = new BackendRuntimeControlRejectedError(reason);
      const rejected = await requestStop();
      expect(rejected).toMatchObject({state: "rejected", runtime: {connectionState: "disconnected", lastError: expect.stringContaining("retry Stop")}});
      expect(await service.lifecycleReceipt(scope, rejected.mutationId)).toEqual(rejected);
      expect(service.repository.pendingLifecycle(scope)).toEqual([]);
      refusal = undefined;
      const beforeRetry = stop.mock.calls.length;
      expect(await requestStop()).toMatchObject({state: "applied", runtime: {connectionState: "stopped"}});
      expect(stop).toHaveBeenCalledTimes(beforeRetry + 1);
    }
    present = true;
    refusal = new Error("transport_response_lost");
    const uncertain = await requestStop();
    expect(uncertain.state).toBe("unknown");
    expect((await service.lifecycleReceipt(scope, uncertain.mutationId)).state).toBe("unknown");
    const attempts = stop.mock.calls.length;
    expect((await requestStop()).state).toBe("rejected");
    expect(stop).toHaveBeenCalledTimes(attempts);
    expect(environmentStop).not.toHaveBeenCalled();
  });

  it("retains underlying attachment errors in main logs for manual and automatic connection attempts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Failing host", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(undefined);
    const connect = vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockRejectedValue(new SidecarUnavailableError({
      cause: new Error("sidecar_hello_build_mismatch", { cause: new Error("expected fixture digest") }),
    }));
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "connect", expectedRevision: saved.revision });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await service.lifecycle(scope, { mutationId: randomUUID(), expectedRevision: saved.revision,
      resourceKind: "environment", resourceId: environmentId, action: "connect", expectedIncarnation: null, impactToken: null });
    expect(result.state).toBe("unavailable");
    const manual = `Execution environment ${environmentId} attachment (connect)`;
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(expect.arrayContaining([
      `${manual} failed: sidecar_unavailable\n`,
      `${manual} cause: sidecar_hello_build_mismatch\n`,
      `${manual} cause: expected fixture digest\n`,
    ]));
    await vi.advanceTimersByTimeAsync(30_001);
    const automatic = `Execution environment ${environmentId} attachment (automatic)`;
    await vi.waitFor(() => expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(expect.arrayContaining([
      `${automatic} failed: sidecar_unavailable\n`,
      `${automatic} cause: sidecar_hello_build_mismatch\n`,
      `${automatic} cause: expected fixture digest\n`,
    ])));
    expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === environmentId))
      .toMatchObject({ connectionState: "unreachable" });

    // An absent outbound carrier is an expected presence state. Maintenance
    // still observes it, but must not emit the same attachment failure each tick.
    connect.mockClear();
    connect.mockRejectedValue(new SidecarUnavailableError({ cause: new Error("sidecar_transport_unavailable") }));
    write.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes(automatic))).toBe(false);
  });

  it("observes and removes a disabled bound Claude backend when the admitted daemon has no Claude host", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Older Node host", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    configuration.backends.push({ id: "unsupported-claude", kind: "claude_agent_sdk", label: "Retained Claude", enabled: false, modelPolicy: { type: "catalog" },
      moduleConfiguration: { executablePath: "/bin/claude", configDirectory: "/config/claude", initializationTimeoutMs: 1000, permissionPolicy: { allowedModes: ["default"] } } });
    configuration.targets.push({ id: "unsupported-claude-target", backendInstanceId: "unsupported-claude", executionEnvironmentId: environmentId, kind: "claude_agent_sdk", label: "Retained Claude", enabled: false,
      moduleConfiguration: { defaults: { permissionMode: "default" } } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "live-service-without-claude", buildId: "test-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: true, attachmentMode: "recovery", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    // Negotiate a real framed daemon handshake with no Claude host registered,
    // as supported Windows or older-Node daemons truthfully advertise.
    const carrier = await createClaudeFramedCarrier();
    try {
      await carrier.start();
      const release = vi.fn();
      const session = { runtimeChannel: carrier.mainChannel, negotiatedCapabilities: [],
        closed: new Promise(() => {}), close: async () => {} };
      vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
      vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockResolvedValue(status);
      const acquire = vi.spyOn(SidecarRuntimeOwner.prototype, "acquireRecovery")
        .mockResolvedValue({ session, serviceStatus: status, carrierGeneration: 1, release });
      const control = vi.spyOn(SidecarRuntimeOwner.prototype, "controlService");
      const commit = vi.spyOn(service.options.runtime!, "commitConfiguration");
      const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
      await service.impact(scope, { resourceKind: "backend", resourceId: "unsupported-claude", action: "stop", expectedRevision: saved.revision });
      expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "unsupported-claude"))
        .toMatchObject({ connectionState: "stopped", incarnation: null, lastError: null });
      const discoveries = acquire.mock.calls.length;
      expect(discoveries).toBeGreaterThan(0);
      const removed = structuredClone(saved.configuration);
      removed.backends = removed.backends.filter(backend => backend.id !== "unsupported-claude");
      removed.targets = removed.targets.filter(target => target.backendInstanceId !== "unsupported-claude");
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: saved.revision, configuration: removed });
      expect(commit).toHaveBeenCalledTimes(2);
      expect(acquire.mock.calls.length).toBeGreaterThan(discoveries);
      expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length);
      expect(service.repository.get(scope).configuration.backends.some(backend => backend.id === "unsupported-claude")).toBe(false);
      expect(control).not.toHaveBeenCalled();
    } finally { await carrier.close(); }
  });

  it("settles an upgrade staging failure so refresh and a new upgrade remain available", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "SSH target", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "live-old-service", buildId: "old-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: false, attachmentMode: "none", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    const inspect = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockResolvedValue(status);
    const control = vi.spyOn(SidecarRuntimeOwner.prototype, "controlService").mockRejectedValue(new SidecarServiceStagingError(new Error("sidecar_install_timeout")));
    const receipt = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectServiceReceipt");
    const stopActors = vi.spyOn(ThreadRuntimeCoordinator.prototype, "runWithRuntimesStopped");
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = (await service.get(scope)).revision;
      const impact = await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "upgrade", expectedRevision: revision });
      const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "environment", resourceId: environmentId,
        expectedRevision: revision, expectedIncarnation: status.serviceIncarnation, action: "upgrade", impactToken: impact.token });
      expect(result).toMatchObject({ state: "unavailable", runtime: { incarnation: status.serviceIncarnation,
        lastError: expect.stringContaining("No shutdown command was sent") } });
      expect(await service.lifecycleReceipt(scope, result.mutationId)).toEqual(result);
      expect(service.repository.pendingLifecycle(scope)).toEqual([]);
    }
    expect(control).toHaveBeenCalledTimes(2);
    expect(stopActors).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    for (const state of ["failed", "handoff_pending"] as const) {
      inspect.mockResolvedValue(status);
      control.mockRejectedValue(new Error("shutdown response was lost"));
      const revision = (await service.get(scope)).revision;
      const impact = await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "upgrade", expectedRevision: revision });
      const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "environment", resourceId: environmentId,
        expectedRevision: revision, expectedIncarnation: status.serviceIncarnation, action: "upgrade", impactToken: impact.token });
      expect(result.state).toBe("unknown");
      receipt.mockResolvedValue({ mutationId: result.mutationId, serviceIncarnation: status.serviceIncarnation,
        requestFingerprint: "c".repeat(64), state, code: state === "failed" ? "sidecar_service_cleanup_unproven" : "sidecar_resource_handoff_pending" });
      inspect.mockRejectedValue(new Error("status probe unavailable"));
      const recovered = await service.lifecycleReceipt(scope, result.mutationId);
      expect(recovered).toMatchObject({ state: "rejected", runtime: { lastError: expect.stringContaining(state === "failed" ? "sidecar_service_cleanup_unproven" : "Recover retained work") } });
      expect(service.repository.pendingLifecycle(scope)).toEqual([]);
    }
  });

  it("withdraws an unacknowledged lifecycle command remotely before reporting that nothing changed", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "SSH target", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "live-service", buildId: "build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: false, attachmentMode: "none", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    const inspect = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "controlService").mockRejectedValue(new Error("shutdown response was lost"));
    const receipt = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectServiceReceipt").mockResolvedValue(undefined);
    const withdraw = vi.spyOn(SidecarRuntimeOwner.prototype, "withdrawServiceReceipt");
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    const lose = async (action: "restart" | "stop") => {
      const revision = (await service.get(scope)).revision;
      const impact = await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action, expectedRevision: revision });
      const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "environment", resourceId: environmentId,
        expectedRevision: revision, expectedIncarnation: status.serviceIncarnation, action, impactToken: impact.token });
      expect(result.state).toBe("unknown");
      return result.mutationId;
    };
    const start = Date.now();
    const unreached = await lose("restart");
    // A missing receipt on an unchanged service stays pending within the
    // in-flight window; nothing is withdrawn yet.
    expect((await service.lifecycleReceipt(scope, unreached)).state).toBe("unknown");
    expect(withdraw).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 61_000);
    withdraw.mockResolvedValueOnce({ mutationId: unreached, requestFingerprint: "d".repeat(64), serviceIncarnation: status.serviceIncarnation, state: "withdrawn" });
    expect(await service.lifecycleReceipt(scope, unreached)).toMatchObject({ state: "rejected", runtime: { incarnation: status.serviceIncarnation,
      lastError: expect.stringContaining("never reached the sidecar; nothing changed") } });
    expect(withdraw).toHaveBeenCalledWith(unreached, status.serviceIncarnation, expect.anything());
    expect(service.repository.pendingLifecycle(scope)).toEqual([]);

    // An admission that raced ahead of the withdrawal is returned instead; the
    // command stays pending and settles through its receipt like any other.
    const raced = await lose("stop");
    expect((await service.lifecycleReceipt(scope, raced)).state).toBe("unknown");
    vi.setSystemTime(start + 130_000);
    withdraw.mockResolvedValueOnce({ mutationId: raced, requestFingerprint: "e".repeat(64), serviceIncarnation: status.serviceIncarnation, state: "accepted" });
    expect((await service.lifecycleReceipt(scope, raced)).state).toBe("unknown");
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(service.repository.pendingLifecycle(scope).map(entry => entry.request.mutationId)).toEqual([raced]);
    receipt.mockResolvedValue({ mutationId: raced, requestFingerprint: "e".repeat(64), serviceIncarnation: status.serviceIncarnation, state: "completed" });
    inspect.mockResolvedValue(undefined);
    expect(await service.lifecycleReceipt(scope, raced)).toMatchObject({ state: "applied", runtime: { connectionState: "stopped", incarnation: null } });
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(service.repository.pendingLifecycle(scope)).toEqual([]);
  });

  it("reports a refused attachment as blocked rather than an unreachable host", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "SSH target", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "older-build-service", buildId: "older-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: false, attachmentMode: "none", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [{ resourceId: "terminal-1", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }], resourcesFingerprint: "b".repeat(64) };
    vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockRejectedValue(new SidecarUnavailableError({ cause: new SidecarServiceManagementError("sidecar_service_upgrade_blocked", status) }));
    const control = vi.spyOn(SidecarRuntimeOwner.prototype, "controlService");
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "connect", expectedRevision: saved.revision });
    const result = await service.lifecycle(scope, { mutationId: randomUUID(), expectedRevision: saved.revision, resourceKind: "environment", resourceId: environmentId, action: "connect", expectedIncarnation: status.serviceIncarnation, impactToken: null });
    expect(result).toMatchObject({ state: "rejected", runtime: { connectionState: "disconnected", upgradeState: "pending", lastError: expect.stringContaining("Upgrade and restart") } });
    expect(result.runtime.lastError).not.toContain("unreachable");
    expect(control).not.toHaveBeenCalled();
    const observed = (await service.get(scope)).runtimes.find(value => value.resourceKind === "environment" && value.resourceId === environmentId);
    expect(observed).toMatchObject({ connectionState: "disconnected", upgradeState: "pending", supportedActions: expect.arrayContaining(["upgrade"]) });
  });

  it.each(["stop", "upgrade"] as const)("uses stable management to %s an incompatible runtime with active work", async action => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "SSH target", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "old-protocol-service", buildId: "old-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION + 1,
      controllerEpoch: 1, attached: false, attachmentMode: "none", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [{ resourceId: "terminal-1", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }], resourcesFingerprint: "b".repeat(64) };
    vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockRejectedValue(new SidecarUnavailableError({ cause: new SidecarServiceManagementError("sidecar_runtime_upgrade_required", status) }));
    const control = vi.spyOn(SidecarRuntimeOwner.prototype, "controlService").mockResolvedValue(undefined);
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    const impact = await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action, expectedRevision: saved.revision });
    expect(impact.activeResources).toBeGreaterThan(0);
    const result = await service.lifecycle(scope, { mutationId: randomUUID(), expectedRevision: saved.revision, resourceKind: "environment", resourceId: environmentId,
      action, expectedIncarnation: status.serviceIncarnation, impactToken: impact.token });
    expect(result.state).toBe("applied");
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ operation: action, force: true,
      expectedServiceIncarnation: status.serviceIncarnation }), expect.any(AbortSignal), expect.any(Function));
    expect(service.repository.pendingLifecycle(scope)).toEqual([]);
  });

  it("distinguishes stale sidecar ownership from host connectivity and blocks duplicate startup", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "SSH target", hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    configuration.backends.push({ id: "remote-codex", kind: "codex_app_server", label: "Remote Codex", enabled: false, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/tmp/codex.sock" } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } });
    configuration.targets.push({ id: "remote-codex-target", kind: "codex_app_server", label: "Remote", enabled: false, backendInstanceId: "remote-codex", executionEnvironmentId: environmentId,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } } } });
    const inspect = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockRejectedValue(new SidecarServiceManagementError("sidecar_service_recovery_required"));
    const connect = vi.spyOn(SidecarRuntimeOwner.prototype, "connect").mockRejectedValue(new Error("unexpected startup"));
    const saved = await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    for (const [resourceKind, resourceId] of [["environment", environmentId], ["backend", "remote-codex"]] as const) {
      await service.impact(scope, { resourceKind, resourceId, action: "stop", expectedRevision: saved.revision });
      const runtime = (await service.get(scope)).runtimes.find(value => value.resourceKind === resourceKind && value.resourceId === resourceId)!;
      expect(runtime).toMatchObject({ connectionState: "recovery_required", applyState: "unavailable", lastError: expect.stringContaining("cannot validate this environment's saved sidecar ownership") });
    }
    const blocked = await service.lifecycle(scope, { mutationId: randomUUID(), expectedRevision: saved.revision, resourceKind: "environment", resourceId: environmentId, action: "start", expectedIncarnation: null, impactToken: null });
    expect(blocked).toMatchObject({ state: "unavailable", runtime: { connectionState: "recovery_required" } });
    expect(connect).not.toHaveBeenCalled();
    const revision = (await service.get(scope)).revision;
    inspect.mockRejectedValue(new SidecarServiceManagementError("sidecar_service_target_identity_unavailable"));
    await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "stop", expectedRevision: revision });
    expect((await service.get(scope)).runtimes.find(value => value.resourceKind === "environment" && value.resourceId === environmentId)).toMatchObject({ connectionState: "recovery_required", lastError: expect.stringContaining("cannot read the host's process identity") });
    for (const [code, message] of [
      ["sidecar_service_owner_unreachable", "process is still running"],
      ["sidecar_service_orphan_cleanup_unproven", "process has exited"],
    ] as const) {
      inspect.mockRejectedValue(new Error("wrapped attachment", { cause: new SidecarServiceManagementError(code) }));
      await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "stop", expectedRevision: revision });
      expect((await service.get(scope)).runtimes.find(value => value.resourceKind === "environment" && value.resourceId === environmentId))
        .toMatchObject({ connectionState: "recovery_required", lastError: expect.stringContaining(message) });
    }
    inspect.mockRejectedValue(new Error("connection refused"));
    await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "stop", expectedRevision: revision });
    expect((await service.get(scope)).runtimes.find(value => value.resourceKind === "environment" && value.resourceId === environmentId)).toMatchObject({ connectionState: "unreachable", lastError: expect.stringContaining("host is unreachable") });
    inspect.mockResolvedValue(undefined);
    await service.impact(scope, { resourceKind: "environment", resourceId: environmentId, action: "stop", expectedRevision: revision });
    expect((await service.get(scope)).runtimes.find(value => value.resourceKind === "environment" && value.resourceId === environmentId)).toMatchObject({ connectionState: "disconnected", lastError: null });
  });

  it("keeps unchanged maintenance passes silent and local disconnect unavailable", async () => {
    const { service, scope, snapshot } = await fixture();
    for (const runtime of snapshot.runtimes.filter(runtime => runtime.resourceKind === "backend")) {
      expect(runtime.supportedActions).toEqual(["connect", "start", "stop", "restart"]);
      await expect(service.lifecycle(scope, {
        mutationId: randomUUID(), expectedRevision: snapshot.revision,
        resourceKind: "backend", resourceId: runtime.resourceId, action: "disconnect",
        expectedIncarnation: runtime.incarnation, impactToken: null,
      })).rejects.toMatchObject({ code: "bad_request" });
    }
    const publish = vi.spyOn(ApplicationSnapshotPublicationBoundary.prototype, "publishAuthoritativeReplacement");
    const invalidate = vi.spyOn(DatabaseExecutionTargetReader.prototype, "invalidateHealth");
    for (let pass = 0; pass < 3; pass++) await service.options.runtime!.reconcile(scope, snapshot);
    expect(publish).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("leaves every sibling runtime and its applied revision intact while an environment edit waits for main-side work", async () => {
    const { service, scope, environmentId, snapshot } = await fixture();
    const database = service.repository.database;
    const prepare = database.prepare.bind(database);
    // Model the coordinator's loaded actor evidence without making a provider call.
    vi.spyOn(database, "prepare").mockImplementation(sql => {
      if (sql.startsWith("SELECT id FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ? ORDER BY id")) {
        return { all: (_tenant: string, _principal: string, backendId: string) => [{ id: `${backendId}-thread` }] } as ReturnType<typeof database.prepare>;
      }
      return prepare(sql);
    });
    let busy = true;
    vi.spyOn(ThreadRuntimeCoordinator.prototype, "captureLoadedRuntime").mockImplementation(async (_scope, threadId) => ({
      threadId, runState: busy && threadId === "busy-claude-thread" ? "running" : "idle",
    }) as Awaited<ReturnType<ThreadRuntimeCoordinator["captureLoadedRuntime"]>>);
    const remove = vi.spyOn(PrincipalBackendRuntimeCollection.prototype, "remove");
    const apply = vi.spyOn(PrincipalBackendRuntimeCollection.prototype, "apply");
    const updated = structuredClone(snapshot.configuration);
    updated.executionEnvironments[0]!.label = "Changed local environment";
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration: updated });
    for (let pass = 0; pass < 3; pass++) await service.options.runtime!.reconcile(scope, service.repository.get(scope));
    expect(remove).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    const pending = await service.get(scope);
    for (const id of [environmentId, "idle-pi", "busy-claude"]) {
      expect(pending.runtimes.find(runtime => runtime.resourceId === id)).toMatchObject({
        applyState: "pending", desiredRevision: snapshot.revision + 1, effectiveRevision: snapshot.revision, lastError: null,
      });
    }
    busy = false;
    await service.options.runtime!.reconcile(scope, pending);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    const applied = await service.get(scope);
    expect(applied.runtimes.every(runtime => runtime.applyState === "applied" && runtime.effectiveRevision === pending.revision)).toBe(true);
  });
});
