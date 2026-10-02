import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";
import { authenticatedProductionFetch } from "../helpers/authenticated-production-client.js";
import { randomUUID } from "node:crypto";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
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
import { configurationDocumentSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { SidecarRuntimeOwner, SidecarUnavailableError } from "../../src/server/sidecar/sidecar-runtime.js";
import { SidecarServiceManagementError, SidecarServiceStagingError } from "../../src/server/sidecar/sidecar-provisioner.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import type { SidecarServiceStatus } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import * as retainedWork from "../../src/server/runtime/retained-provider-work.js";
import type { BackendModuleRuntime, BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { OpenCodeBackendModule } from "../../src/server/backends/opencode/opencode-backend-module.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { openCodeRuntimeNamespaceKey } from "../../src/server/backends/opencode/opencode-runtime.js";

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

function installOpenCodeFixture(observedStorePath: string, start: (signal?: AbortSignal) => Promise<void> = async () => {}, close = async () => {}) {
  const created: { runtime: BackendModuleRuntime; context: BackendModuleRuntimeContext }[] = [];
  const module = new OpenCodeBackendModule(input => {
    let ready = false;
    return {
      get nativeNamespaceKey() {
        if (!ready) throw new Error("fixture_opencode_not_started");
        return openCodeRuntimeNamespaceKey(input.authority.executionEnvironmentId, observedStorePath);
      },
      start: async (signal?: AbortSignal) => { await start(signal); ready = true; },
      health: async () => ({ available: ready, checkedAt: new Date().toISOString() }),
      snapshot: () => ({ state: ready ? "ready" : "stopped", ownership: "owned", references: 0,
        ...(ready ? { generation: "fixture-opencode" } : {}) }),
      acquire: (): never => { throw new Error("unexpected_conversation_acquisition"); },
      assertCurrent: async () => { if (!ready) throw new Error("fixture_opencode_not_started"); },
      admitToolSession: async (): Promise<never> => { throw new Error("unexpected_tool_admission"); },
      releaseToolSession: () => {},
      stop: async () => { ready = false; return { cleanup: "proved", nativeInterrupts: "not_owned" }; },
      close: async () => { ready = false; return { cleanup: "proved", nativeInterrupts: "not_owned" }; },
    };
  });
  vi.spyOn(compiledBackendModuleCatalog.requireModule("opencode"), "prepare").mockImplementation(input => {
    const prepared = module.prepare(input);
    return { ...prepared, createRuntime(context) {
      const runtime = prepared.createRuntime(context);
      created.push({ runtime, context });
      const runtimeClose = runtime.close.bind(runtime);
      runtime.close = async () => { await close(); await runtimeClose(); };
      return runtime;
    } };
  });
  return created;
}

function addBackgroundOpenCode(configuration: ConfigurationDocument, environmentId: string) {
  configuration.backends.push({ id: "background-opencode", kind: "opencode", label: "Background", enabled: true, modelPolicy: { type: "catalog" },
    moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } } });
  configuration.targets.push({ id: "background-opencode-target", kind: "opencode_http", backendInstanceId: "background-opencode",
    executionEnvironmentId: environmentId, label: "Background", enabled: true,
    moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } });
}

describe("production configuration reconciliation", () => {
  it("attaches a replacement module's retained work before the old pass settles", async () => {
    const modules: BackendModuleRuntime[] = [];
    const installAdministration = (runtime: BackendModuleRuntime) => {
      const incarnation = `retained-module-${modules.indexOf(runtime)}`;
      Object.defineProperty(runtime, "administration", { value: {
        inspect: async () => ({ state: "idle", incarnation, revision: incarnation, blockers: [], retainedThreadIds: ["retained-thread"] }),
        stop: async () => undefined, restart: async () => undefined,
      } });
    };
    let installOnCreate = false;
    const prepare = compiledBackendModuleCatalog.prepare.bind(compiledBackendModuleCatalog);
    vi.spyOn(compiledBackendModuleCatalog, "prepare").mockImplementation(input => prepare(input).map(prepared => {
      if (prepared.backendInstanceId !== "idle-pi") return prepared;
      const create = prepared.createRuntime.bind(prepared);
      prepared.createRuntime = context => {
        const runtime = create(context); modules.push(runtime);
        if (installOnCreate) installAdministration(runtime);
        return runtime;
      };
      return prepared;
    }));
    const releases: (() => void)[] = [];
    const attach = vi.spyOn(retainedWork, "attachRetainedThreads").mockImplementation(() => new Promise(resolve => {
      releases.push(() => resolve({ complete: false, attachedThreadIds: [] }));
    }));
    try {
      const { service, scope } = await fixture();
      installOnCreate = true; installAdministration(modules[0]!);
      const impact = async (action: "start" | "stop") => service.impact(scope, {
        resourceKind: "backend", resourceId: "idle-pi", action, expectedRevision: (await service.get(scope)).revision,
      });
      const apply = async (action: "start" | "stop") => {
        const preview = await impact(action);
        return service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "idle-pi", action,
          expectedRevision: (await service.get(scope)).revision, expectedIncarnation: preview.incarnation, impactToken: preview.token });
      };
      expect((await apply("stop")).state).toBe("applied");
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
      expect((await apply("start")).state).toBe("applied");
      expect(modules).toHaveLength(2);
      await impact("stop");
      // The replacement can attach without waiting for old hydration.
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
      releases[0]!();
      // Let the old admission/finalizer finish, then inspect the replacement
      // again while its own pass is still held. No duplicate is admitted.
      await new Promise<void>(resolve => setImmediate(resolve));
      await impact("stop");
      expect(attach).toHaveBeenCalledTimes(2);
    } finally { for (const release of releases) release(); }
  });

  it("keeps unrelated saves and lifecycle commands available during provider startup", async () => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let startupSignal: AbortSignal | undefined;
    const start = vi.fn(async (signal?: AbortSignal) => { startupSignal = signal; await held; });
    installOpenCodeFixture(path.join(directory!, "background-opencode.db"), start);
    try {
      const configuration = structuredClone(snapshot.configuration);
      addBackgroundOpenCode(configuration, environmentId);
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode"))
        .toMatchObject({ applyState: "pending", connectionState: "reconciling", effectiveRevision: null });
      configuration.backends.find(backend => backend.id === "idle-pi")!.label = "Unrelated edit";
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration });
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "idle-pi", action: "stop",
        expectedRevision: (await service.get(scope)).revision });
      const stopped = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "idle-pi", action: "stop",
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
      expect(stopped.state).toBe("applied");
      expect(startupSignal?.aborted).toBe(false);
      expect(start).toHaveBeenCalledOnce();
      release();
      await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode"))
        .toMatchObject({ applyState: "applied", connectionState: "connected" }));
    } finally { release(); }
  });

  it("cancels a superseded startup and publishes only the current configuration", async () => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const signals: AbortSignal[] = [];
    const start = vi.fn(async (signal?: AbortSignal) => { signals.push(signal!); if (signals.length === 1) await held; });
    installOpenCodeFixture(path.join(directory!, "background-opencode.db"), start);
    try {
      const configuration = structuredClone(snapshot.configuration);
      addBackgroundOpenCode(configuration, environmentId);
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      configuration.backends.find(backend => backend.id === "background-opencode")!.environmentVariables = {
        startup: { FIXTURE_REVISION: { kind: "literal", value: "second" } }, execution: {},
      };
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration });
      expect(signals[0]!.aborted).toBe(true);
      const pending = (await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode")!;
      expect(pending).toMatchObject({ applyState: "pending", effectiveRevision: null });
      release();
      await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode"))
        .toMatchObject({ applyState: "applied", effectiveRevision: pending.desiredRevision }));
      expect(start).toHaveBeenCalledTimes(2);
      expect(signals[1]!.aborted).toBe(false);
    } finally { release(); }
  });

  it.each(["backend", "environment"] as const)("keeps a pending %s definition when cancellation cannot prove cleanup", async resource => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let cleanupPending = true;
    const start = vi.fn(async (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error("fixture_cancelled"));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    }));
    installOpenCodeFixture(path.join(directory!, "background-opencode.db"), start,
      async () => { if (cleanupPending) throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); });
    try {
      const configuration = structuredClone(snapshot.configuration);
      const backgroundEnvironmentId = environmentId;
      addBackgroundOpenCode(configuration, backgroundEnvironmentId);
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      if (resource === "backend") {
        configuration.backends = configuration.backends.filter(backend => backend.id !== "background-opencode");
        configuration.targets = configuration.targets.filter(target => target.backendInstanceId !== "background-opencode");
      } else {
        const replacementEnvironmentId = randomUUID();
        configuration.executionEnvironments = [{ id: replacementEnvironmentId, kind: "ssh", label: "Replacement host",
          hostAlias: "test-target", workspaceRoots: ["/workspace"], operations: { kind: "sidecar", enabledCapabilities: ["workspace_tools", "workspace_context"] } }];
        configuration.targets = configuration.targets.map(target => ({ ...target, executionEnvironmentId: replacementEnvironmentId }));
      }
      await expect(service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration }))
        .rejects.toThrow(resource === "backend" ? "Backend shutdown could not be confirmed" : "Execution host shutdown could not be confirmed");
      expect((await service.get(scope)).configuration.backends.some(backend => backend.id === "background-opencode")).toBe(true);
      expect((await service.get(scope)).configuration.executionEnvironments.some(host => host.id === backgroundEnvironmentId)).toBe(true);
      await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode")?.lastError)
        .toContain("Use backend Stop to retry cleanup before using Start"));
      // Once the in-flight attempt has settled, the retained collection entry
      // still owns its original host and must keep both definitions available.
      await expect(service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration }))
        .rejects.toThrow(resource === "backend" ? "Backend shutdown could not be confirmed" : "Execution host shutdown could not be confirmed");
      expect((await service.get(scope)).configuration.executionEnvironments.some(host => host.id === backgroundEnvironmentId)).toBe(true);
    } finally { cleanupPending = false; }
  });

  it.each(["opencode_executable_unavailable", "opencode_owned_cleanup_unproved"])("backs off %s startup failures while permitting initial attachment and explicit retries after proved cleanup", async code => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let unavailable = true;
    const start = vi.fn(async () => { if (unavailable) throw new OpenCodeRuntimeError(code); });
    installOpenCodeFixture(path.join(directory!, "background-opencode.db"), start);
    const configuration = structuredClone(snapshot.configuration);
    addBackgroundOpenCode(configuration, environmentId);
    const save = async () => service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration });
    await save();
    await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode")?.applyState).toBe("unavailable"));
    expect(start).toHaveBeenCalledOnce();
    if (code === "opencode_owned_cleanup_unproved") {
      expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode"))
        .toMatchObject({ connectionState: "unknown", lastError: expect.stringContaining("cleanup of its local owned resources completed") });
    }
    // A retained main-side observation is not authority to block initial
    // attachment when this collection has no published runtime to replace.
    const database = service.repository.database;
    const workspace = new InventoryRepository(database).upsertWorkspace(scope, { environmentId, canonicalPath: directory!,
      displayName: "Retained", project: { kind: "new", name: "Retained" }, available: true, trustState: "trusted", environmentConfigurationRevision: 1, now });
    const connection = database.prepare("SELECT id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ?")
      .get(scope.tenantId, scope.principalId, "background-opencode-target") as { id: string };
    const thread = new ConversationBindingRepository(database).createUnboundThread(scope, { workspaceId: workspace.id,
      connectionProfileId: connection.id, title: "Retained", now });
    const capture = ThreadRuntimeCoordinator.prototype.captureLoadedRuntime;
    vi.spyOn(ThreadRuntimeCoordinator.prototype, "captureLoadedRuntime").mockImplementation(function(this: ThreadRuntimeCoordinator, candidate, id) {
      return id === thread.id ? Promise.resolve({ kind: "conversation_runtime", threadId: id, generation: "retained", runState: "starting" })
        : capture.call(this, candidate, id);
    });
    for (const label of ["Edit one", "Edit two"]) {
      configuration.backends.find(backend => backend.id === "idle-pi")!.label = label;
      await save();
    }
    expect(start).toHaveBeenCalledOnce();
    now += 5_000;
    await save();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "background-opencode")?.applyState).toBe("unavailable"));
    unavailable = false;
    const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "background-opencode", action: "start",
      expectedRevision: (await service.get(scope)).revision });
    const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "background-opencode", action: "start",
      expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
    expect(result).toMatchObject({ state: "applied", runtime: { applyState: "applied", connectionState: "connected" } });
    expect(start).toHaveBeenCalledTimes(3);
  });

  it.each(["connect", "start"] as const)("retries a repaired failed backend immediately on explicit %s", async action => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let fenced = true;
    const start = vi.fn(async () => { if (fenced) throw new OpenCodeRuntimeError("opencode_runtime_owner_already_owned"); });
    installOpenCodeFixture(path.join(directory!, "observed-opencode.db"), start);
    const configuration = structuredClone(snapshot.configuration);
    configuration.backends.push({ id: "repair-opencode", kind: "opencode", label: "Repair", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } } });
    configuration.targets.push({ id: "repair-opencode-target", kind: "opencode_http", backendInstanceId: "repair-opencode",
      executionEnvironmentId: environmentId, label: "Repair", enabled: true,
      moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } });
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    const current = () => service.get(scope);
    await vi.waitFor(async () => expect((await current()).runtimes.find(runtime => runtime.resourceId === "repair-opencode"))
      .toMatchObject({ applyState: "unavailable", connectionState: "recovery_required" }));
    const retry = async () => {
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "repair-opencode", action,
        expectedRevision: (await current()).revision });
      return service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "repair-opencode", action,
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
    };
    const failedStarts = start.mock.calls.length;
    expect((await retry()).state).toBe("unavailable");
    expect(start.mock.calls.length).toBeGreaterThan(failedStarts);
    fenced = false;
    const repairedStarts = start.mock.calls.length;
    const result = await retry();
    expect(result).toMatchObject({ state: "applied", runtime: { applyState: "applied", connectionState: "connected", lastError: null } });
    expect(start.mock.calls.length).toBeGreaterThan(repairedStarts);
    expect(result.runtime.effectiveRevision).toBe(result.runtime.desiredRevision);
  });

  it("allows Stop for a published backend whose health reports unproved cleanup", async () => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let cleanupRequired = false;
    const created = installOpenCodeFixture(path.join(directory!, "published-cleanup.db"), async () => {
      if (cleanupRequired) throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved");
    });
    const configuration = structuredClone(snapshot.configuration);
    addBackgroundOpenCode(configuration, environmentId);
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(item => item.resourceId === "background-opencode"))
      .toMatchObject({ connectionState: "connected", applyState: "applied" }));
    cleanupRequired = true;
    expect(await created[0]!.runtime.driverFactory.create(created[0]!.context.connections[0]!).health()).toMatchObject({ available: false });
    expect((await service.get(scope)).runtimes.find(item => item.resourceId === "background-opencode"))
      .toMatchObject({ connectionState: "recovery_required", lastError: expect.stringContaining("Use backend Stop") });
    for (const action of ["connect", "start", "stop"] as const) {
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "background-opencode", action,
        expectedRevision: (await service.get(scope)).revision });
      const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "background-opencode", action,
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
      expect(result).toMatchObject(action === "stop" ? { state: "applied", runtime: { connectionState: "stopped" } } :
        { state: "unavailable", runtime: { connectionState: "recovery_required" } });
    }
  });

  it("retries remote native cleanup with Stop after the failed main runtime has closed", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Cleanup host", hostAlias: "test-target",
      workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    addBackgroundOpenCode(configuration, environmentId);
    const status: SidecarServiceStatus = { scope: { ...scope, installationId: "installation", executionEnvironmentId: environmentId },
      serviceIncarnation: "retained-service", buildId: "test-build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      controllerEpoch: 1, attached: true, attachmentMode: "recovery", state: "ready", configurationState: "applied",
      desiredConfiguration: { environmentRevision: 0, operationsRevision: 0 }, effectiveConfiguration: { environmentRevision: 0, operationsRevision: 0 },
      resources: [], resourcesFingerprint: "b".repeat(64) };
    const inspectService = vi.spyOn(SidecarRuntimeOwner.prototype, "inspectService").mockResolvedValue(status);
    const acquire = vi.spyOn(SidecarRuntimeOwner.prototype, "acquireOperation")
      .mockRejectedValue(new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"));
    let stopped = false;
    const stop = vi.fn(async () => { stopped = true; });
    const control = { inspect: async () => ({ state: "active" as const, incarnation: "retained-provider", revision: "retained-revision", blockers: ["cleanup_unproven" as const] }),
      stop, restart: stop };
    const prepare = compiledBackendModuleCatalog.prepare.bind(compiledBackendModuleCatalog);
    vi.spyOn(compiledBackendModuleCatalog, "prepare").mockImplementation(input => prepare(input).map(prepared => {
      if (prepared.backendInstanceId === "background-opencode") prepared.recoverAdministration = async () => stopped ? undefined : control;
      return prepared;
    }));
    const reserve = vi.spyOn(PrincipalBackendRuntimeCollection.prototype, "reserveStartup");
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(item => item.resourceId === "background-opencode"))
      .toMatchObject({ connectionState: "recovery_required", lastError: expect.stringContaining("Use backend Stop") }));
    const collection = reserve.mock.contexts[0] as PrincipalBackendRuntimeCollection;
    expect(collection.failures.get("background-opencode")).toMatchObject({ cleanupPending: false });
    const lifecycle = async (action: "start" | "stop") => {
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "background-opencode", action,
        expectedRevision: (await service.get(scope)).revision });
      return service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "background-opencode", action,
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
    };
    const starts = acquire.mock.calls.length;
    expect((await lifecycle("start")).state).toBe("unavailable");
    expect(acquire).toHaveBeenCalledTimes(starts);
    inspectService.mockRejectedValue(new Error("fixture_host_unreachable"));
    expect((await lifecycle("stop")).state).toBe("unavailable");
    expect(stop).not.toHaveBeenCalled();
    inspectService.mockResolvedValue(status);
    expect(await lifecycle("stop")).toMatchObject({ state: "applied", runtime: { connectionState: "stopped" } });
    expect(stop).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(starts);
  });

  it("keeps explicit backend retry blocked while startup cleanup remains unproved", async () => {
    const { service, scope, snapshot, environmentId } = await fixture();
    let cleanupPending = true;
    let fenced = true;
    const start = vi.fn(async () => { if (fenced) throw new OpenCodeRuntimeError("opencode_runtime_owner_already_owned"); });
    installOpenCodeFixture(path.join(directory!, "observed-opencode.db"), start,
      async () => { if (cleanupPending) throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); });
    try {
      const configuration = structuredClone(snapshot.configuration);
      configuration.backends.push({ id: "repair-opencode", kind: "opencode", label: "Repair", enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } } });
      configuration.targets.push({ id: "repair-opencode-target", kind: "opencode_http", backendInstanceId: "repair-opencode",
        executionEnvironmentId: environmentId, label: "Repair", enabled: true,
        moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } });
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
      await vi.waitFor(async () => expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "repair-opencode"))
        .toMatchObject({ connectionState: "recovery_required", lastError: expect.stringContaining("Use backend Stop to retry cleanup before using Start") }));
      configuration.backends.find(backend => backend.id === "idle-pi")!.label = "Unrelated cleanup edit";
      await service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration });
      expect((await service.get(scope)).runtimes.find(runtime => runtime.resourceId === "repair-opencode")?.lastError)
        .toContain("Use backend Stop to retry cleanup before using Start");
      const failedStarts = start.mock.calls.length;
      expect(failedStarts).toBeGreaterThan(0);
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: "repair-opencode", action: "connect",
        expectedRevision: (await service.get(scope)).revision });
      const result = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "repair-opencode", action: "connect",
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
      expect(result).toMatchObject({ state: "unavailable", runtime: { applyState: "unavailable", connectionState: "recovery_required" } });
      expect(start).toHaveBeenCalledTimes(failedStarts);
      cleanupPending = false;
      fenced = false;
      for (const action of ["stop", "start"] as const) {
        const retryImpact = await service.impact(scope, { resourceKind: "backend", resourceId: "repair-opencode", action,
          expectedRevision: (await service.get(scope)).revision });
        const retry = await service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: "repair-opencode", action,
          expectedRevision: retryImpact.configurationRevision, expectedIncarnation: retryImpact.incarnation, impactToken: retryImpact.token });
        expect(retry.state).toBe("applied");
      }
      expect(start.mock.calls.length).toBeGreaterThan(failedStarts);
    } finally { cleanupPending = false; }
  });

  it.each(["pi", "claude", "codex", "opencode"])("restarts %s after removing a connection without reusing its historical profile", async kind => {
    const { service, scope, environmentId, snapshot } = await fixture();
    const configuration = structuredClone(snapshot.configuration);
    const backendId = kind === "pi" ? "idle-pi" : kind === "claude" ? "busy-claude" : `removed-target-${kind}`;
    if (kind === "codex") {
      await mkdir(path.join(directory!, "removed-target-codex"));
      configuration.backends.push({ id: backendId, kind: "codex_app_server", label: "Codex", enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: {
          connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: process.execPath,
            workingDirectory: directory!, codexHome: path.join(directory!, "removed-target-codex") } },
          policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
        } });
      configuration.targets.push({ id: `${backendId}-target`, kind: "codex_app_server", label: "Codex", enabled: true, backendInstanceId: backendId, executionEnvironmentId: environmentId,
        moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } } } });
    }
    if (kind === "opencode") {
      // Exercise production profile reconciliation with an observed native
      // identity; this configuration test does not launch a provider binary.
      const observedStorePath = path.join(directory!, "native-default-opencode.db");
      installOpenCodeFixture(observedStorePath);
      configuration.backends.push({ id: backendId, kind: "opencode", label: "OpenCode", enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } } });
      configuration.targets.push({ id: `${backendId}-target`, kind: "opencode_http", label: "OpenCode", enabled: true,
        backendInstanceId: backendId, executionEnvironmentId: environmentId,
        moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } });
    }
    const original = configuration.targets.find(target => target.backendInstanceId === backendId)!;
    const removedId = `${backendId}-removed`;
    const disabledId = `${backendId}-disabled`;
    configuration.targets.push({ ...structuredClone(original), id: removedId });
    configuration.targets.push({ ...structuredClone(original), id: disabledId, enabled: false });
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    const lifecycle = async (action: "stop" | "start") => {
      const current = await service.get(scope);
      const impact = await service.impact(scope, { resourceKind: "backend", resourceId: backendId, action, expectedRevision: current.revision });
      return service.lifecycle(scope, { mutationId: randomUUID(), resourceKind: "backend", resourceId: backendId, action,
        expectedRevision: impact.configurationRevision, expectedIncarnation: impact.incarnation, impactToken: impact.token });
    };
    expect((await lifecycle("stop")).state).toBe("applied");
    configuration.targets = configuration.targets.filter(target => target.id !== removedId);
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: (await service.get(scope)).revision, configuration });
    const applied = vi.spyOn(PrincipalBackendRuntimeCollection.prototype, kind === "opencode" ? "reserveStartup" : "apply");
    expect((await lifecycle("start")).state).toBe("applied");
    const assertConnections = () => {
      const plan = applied.mock.calls.filter(([value]) => value.context.instance.id === backendId).at(-1)![0];
      expect(plan.context.connections.map(connection => connection.templateId).sort()).toEqual([original.id, disabledId].sort());
      expect(plan.context.connections.find(connection => connection.templateId === disabledId)?.enabled).toBe(false);
    };
    assertConnections();
    expect(service.repository.database.prepare("SELECT enabled FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ?")
      .get(scope.tenantId, scope.principalId, removedId)).toEqual({ enabled: 0 });
    await application!.close(); application = undefined;
    applied.mockClear();
    const reopened = await openApplication();
    await vi.waitFor(async () => expect((await reopened.service.get(reopened.scope)).runtimes.find(runtime => runtime.resourceId === backendId)?.applyState).toBe("applied"));
    assertConnections();
    // Two full production boots plus configuration saves and runtime stop/start
    // need headroom when this integration test shares the suite's workers.
  }, 15_000);

  it("serves HTTP and Settings while an initial SSH provider connection is pending and cancels it on close", async () => {
    const { service, scope, snapshot } = await fixture();
    const environmentId = randomUUID();
    const configuration = structuredClone(snapshot.configuration);
    configuration.executionEnvironments.push({ id: environmentId, kind: "ssh", label: "Held host", hostAlias: "held-test-target", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    configuration.backends.push({ id: "held-opencode", kind: "opencode", label: "Held", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } } });
    configuration.targets.push({ id: "held-opencode-target", kind: "opencode_http", backendInstanceId: "held-opencode",
      executionEnvironmentId: environmentId, label: "Held", enabled: true,
      moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } });
    const acquire = vi.spyOn(SidecarRuntimeOwner.prototype, "acquireOperation").mockRejectedValue(new Error("fixture_host_offline"));
    await service.save(scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await application!.close(); application = undefined;
    let pendingSignal: AbortSignal | undefined;
    let cancelPending: (() => void) | undefined;
    acquire.mockImplementation(async (_scope, _id, signal) => {
      pendingSignal = signal;
      await new Promise<never>((_resolve, reject) => {
        cancelPending = () => reject(signal?.reason ?? new Error("fixture_cancelled"));
        if (signal?.aborted) cancelPending();
        else signal?.addEventListener("abort", cancelPending, { once: true });
      });
      throw new Error("unreachable");
    });
    try {
      const reopened = await openApplication();
      await vi.waitFor(() => expect(pendingSignal).toBeDefined());
      expect(pendingSignal!.aborted).toBe(false);
      expect((await reopened.service.get(reopened.scope)).runtimes.find(runtime => runtime.resourceId === "held-opencode"))
        .toMatchObject({ applyState: "pending", effectiveRevision: null });
      await application!.close(); application = undefined;
      expect(pendingSignal!.aborted).toBe(true);
    } finally { cancelPending?.(); }
  }, 15_000);

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
    const carrier = await createSidecarFramedCarrier();
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
