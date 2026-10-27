import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiNativeBackendModule, PI_NATIVE_PROTOCOL_RELEASE, type PiNativeModuleDependencies } from "../../src/server/backends/pi/native/pi-native-backend-module.js";
import { PiNativeThreadRepository } from "../../src/server/backends/pi/native/pi-native-thread-repository.js";
import { PiNativeAgentToolService } from "../../src/server/backends/pi/native/agent-tools.js";
import { PiNativeError, type PiNativePort, type PiNativeInspection } from "../../src/server/backends/pi/native/port.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import { PiNativeConversationDriver, serializePiNativeBindingDetail } from "../../src/server/backends/pi/native/driver/driver.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { encodePiModelSetting } from "../../src/server/backends/pi/pi-thread-presentation-provider.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";
import type { AgentBackendInstance, AgentConnectionProfile, BackendCatalog } from "../../src/server/backends/contracts.js";
import type { BackendModuleConfigurationInput, BackendModuleRuntime, BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConnectionSettingPreferenceRepository } from "../../src/server/db/repositories/connection-setting-preference-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import type { PiNativeConnectionDefaults } from "../../src/shared/protocol/pi-configuration.js";

const catalog: BackendCatalog = {
  models: ["configured", "preferred"].map(id => ({ provider: "provider", id, label: id,
    inputModalities: ["text"], supportedReasoningEfforts: ["off", "low", "high"] })),
  commands: [], skills: [], notices: [],
};
const nativeDefaultCatalog: BackendCatalog = { ...catalog, models: catalog.models.map(model => model.id === "preferred"
  ? { ...model, isDefault: true, defaultReasoningEffort: "high" } : model) };
const databases: Database.Database[] = [];
const runtimes: BackendModuleRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const database of databases.splice(0)) database.close();
});

function fakePort() {
  const unused = async (): Promise<never> => { throw new Error("unexpected_provider_io"); };
  return {
    resolveSessionDirectory: vi.fn(async () => "/workspace/sessions"),
    catalog: vi.fn(unused), create: vi.fn(unused), fork: vi.fn(unused), reconcileFork: vi.fn(unused), listSessions: vi.fn(unused),
    readHistory: vi.fn(unused), attach: vi.fn(unused), attachForDrain: vi.fn(unused), attachForControl: vi.fn(unused), request: vi.fn(unused), outcome: vi.fn(unused),
    acknowledgeOperation: vi.fn(unused), abandonObservation: vi.fn(unused), observe: vi.fn(unused), acknowledge: vi.fn(unused), acknowledgeObservationGap: vi.fn(unused), release: vi.fn(unused),
    inspect: vi.fn(async (): Promise<PiNativeInspection> => ({ runtimeId: "runtime", revision: "revision-1",
      state: "idle", blockers: [], retainedSessions: [] })),
    stop: vi.fn(async () => undefined), retireSession: vi.fn(unused), close: vi.fn(async () => undefined),
  } satisfies PiNativePort;
}

function fixture(environmentKind: "local" | "ssh" | "outbound" = "local",
  defaults: PiNativeConnectionDefaults = { provider: "provider", model: "configured", thinkingLevel: "low" }) {
  const { database, scope } = savedAgentDatabase();
  databases.push(database);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id, canonicalPath: "/tmp/pi-native-module", displayName: "Native Pi module",
    project: { kind: "new", name: "Native Pi module" }, available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 200,
  });
  database.prepare(`INSERT INTO agent_backend_instances
    (tenant_id, owner_principal_id, id, kind, label, enabled, protocol_release, created_at, updated_at)
    VALUES (?, ?, 'native-pi', 'pi_native', 'Pi', 1, ?, 1, 1)`)
    .run(scope.tenantId, scope.principalId, PI_NATIVE_PROTOCOL_RELEASE);
  database.prepare(`INSERT INTO agent_connection_profiles
    (tenant_id, owner_principal_id, id, template_id, backend_instance_id, backend_kind,
      execution_environment_id, kind, label, enabled, created_at, updated_at)
    VALUES (?, ?, 'native-profile', 'native-target', 'native-pi', 'pi_native', ?, 'pi_rpc', 'Pi', 1, 1, 1)`)
    .run(scope.tenantId, scope.principalId, environment.id);
  const configuration = new BackendConfigurationRepository(database);
  const profile = configuration.getProfile(scope, "native-profile");
  const sdkProfile = configuration.listProfiles(scope).find(profile => profile.kind === "pi_sdk")!;
  const connection: AgentConnectionProfile = { ...profile, enabled: profile.enabled === 1 };
  const sdkConnection: AgentConnectionProfile = { ...sdkProfile, enabled: sdkProfile.enabled === 1 };
  const backend = configuration.getBackend(scope, "native-pi");
  const instance: AgentBackendInstance = { ...backend, enabled: backend.enabled === 1 };
  const input: BackendModuleConfigurationInput = {
    backend: { id: instance.id, kind: "pi_native", enabled: true, protocolRelease: PI_NATIVE_PROTOCOL_RELEASE,
      modelPolicy: { type: "catalog" }, moduleConfiguration: { agentDirectory: "/tmp/native-agent", projectTrusted: false },
      environmentVariables: { execution: {}, startup: { PI_BACKEND: { kind: "literal", value: "backend" } } } },
    connections: [{ id: connection.templateId, kind: "pi_rpc", backendInstanceId: instance.id,
      executionEnvironmentId: environment.id, enabled: true,
      moduleConfiguration: { defaults } }],
    executionEnvironments: [{ id: environment.id, kind: environmentKind,
      environmentVariables: { execution: {}, startup: { PI_HOST: { kind: "literal", value: "host" } } } }],
    environment: { PI_TEST: "process" },
  };
  const context: BackendModuleRuntimeContext = {
    usage: NO_USAGE_SINK, database, scope, instance, connections: [connection],
    environmentChannel: { scope, executionEnvironmentId: environment.id } as BackendModuleRuntimeContext["environmentChannel"],
    environmentOperations: unavailableEnvironmentOperations({ environmentId: environment.id, environmentKind, environmentLabel: "Host" }),
    ...(environmentKind === "local" ? {} : { sidecarRuntime: { acquire: vi.fn(async () => { throw new Error("unexpected_sidecar_start"); }),
      acquireExisting: vi.fn(async () => { throw new Error("unexpected_sidecar_attach"); }) } }),
    toolProvenanceKey: new Uint8Array(32).fill(0x42),
    outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
    viewedImageCapture: {} as BackendModuleRuntimeContext["viewedImageCapture"],
    agentToolSourceCapabilities: createFakeAgentToolSourceCapabilities().issuer,
    agentToolCli: { availability: "unavailable", reason: "cli_unavailable" },
    agentTools: { eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [],
      readPolicy: () => ({ enabled: false, presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true }, enabledToolIds: [] }),
      invoke: async () => { throw new Error("unexpected_agent_tool_invocation"); } },
  };
  const port = fakePort();
  const createPort = vi.fn((_input: Parameters<PiNativeModuleDependencies["createPort"]>[0]) => port);
  const module = new PiNativeBackendModule({ createPort });
  const prepared = module.prepare(input);
  const bindings = new ConversationBindingRepository(database);
  const repository = new PiNativeThreadRepository(database);
  const preferences = new ConnectionSettingPreferenceRepository(database);
  const createThread = (id: string, target = connection) => bindings.createUnboundThread(scope, {
    id, workspaceId: workspace.id, connectionProfileId: target.id, title: id, now: 300,
  }).id;
  const createRuntime = () => { const runtime = prepared.createRuntime(context); runtimes.push(runtime); return runtime; };
  return { database, scope, environment, workspace, connection, sdkConnection, instance, input, context, port,
    createPort, module, prepared, bindings, repository, preferences, createThread, createRuntime };
}

describe("native Pi module composition", () => {
  it.each(["local", "ssh", "outbound"] as const)("composes %s without provider I/O and validates exact runtime authority", async kind => {
    const target = fixture(kind);
    const { context, prepared, createPort, connection, port } = target;
    expect(prepared.nativeStores).toEqual([]);
    expect(prepared.nativeNamespaces).toHaveLength(1);
    expect(createPort).not.toHaveBeenCalled();
    for (const changed of [
      { scope: { ...target.scope, tenantId: "other" } },
      { scope: { ...target.scope, principalId: "other" } },
      { instance: { ...target.instance, kind: "pi" as const } },
      { connections: [{ ...connection, kind: "pi_sdk" as const }] },
      { connections: [{ ...connection, templateId: "other" }] },
      { environmentChannel: { ...context.environmentChannel, executionEnvironmentId: "other" } },
      { environmentOperations: { ...context.environmentOperations, environmentId: "other" } },
    ]) expect(() => prepared.createRuntime({ ...context, ...changed })).toThrow("pi_native_runtime_context_invalid");
    expect(() => prepared.createRuntime({ ...context, sidecarRuntime: kind === "local"
      ? { acquire: vi.fn(), acquireExisting: vi.fn() } : undefined })).toThrow("pi_native_runtime_topology_invalid");
    expect(createPort).not.toHaveBeenCalled();
    const runtime = target.createRuntime();
    expect(createPort).toHaveBeenCalledOnce();
    expect(createPort.mock.calls[0]?.[0]).toMatchObject({ configuration: { ...target.scope,
      backendInstanceId: "native-pi", executionEnvironmentId: target.environment.id,
      agentDirectory: "/tmp/native-agent", projectTrusted: false, initializationTimeoutMs: 30_000,
      startupEnvironmentVariables: { PI_HOST: { kind: "literal", value: "host" }, PI_BACKEND: { kind: "literal", value: "backend" } } } });
    await runtime.start();
    expect(port.attach).not.toHaveBeenCalled();
    expect(port.catalog).not.toHaveBeenCalled();
    expect(runtime.driverFactory.connectionKinds).toEqual(["pi_rpc"]);
    expect(runtime.driverFactory.creationIdentity?.assignment).toBe("application");
    expect(runtime.discovery.nativeNamespaceKey(connection)).toBe(prepared.nativeNamespaces[0]!.namespaceKey);
    const driver = runtime.driverFactory.create(connection);
    expect(runtime.driverFactory.create(connection)).toBe(driver);
    expect(() => runtime.driverFactory.create({ ...connection, configurationRevision: 99 })).toThrow("pi_native_configuration_changed");
    expect(() => runtime.driverFactory.create(target.sdkConnection)).toThrow("pi_native_connection_mismatch");
    expect(() => prepared.createRuntime(context)).toThrow("pi_native_runtime_context_invalid");
    expect(runtime.savedAgents).toMatchObject({ typeId: "pi_native", backendKind: "pi_native",
      presentation: { typeId: "pi_native", label: { text: "Pi" }, brand: "pi" } });
    expect(runtime.agentToolRuntimeAvailability?.({ scope: target.scope, applicationThreadId: "thread", isolatedWorkspace: false,
      presentation: { surface: "native", mode: "individual" } })).toEqual({ availability: "available" });
    expect(runtime.agentToolRuntimeAvailability?.({ scope: target.scope, applicationThreadId: "thread", isolatedWorkspace: false,
      presentation: { surface: "cli", mode: "progressive" } })).toMatchObject({ availability: "unavailable", reason: expect.stringContaining("endpoint") });
    expect(runtime.agentToolRuntimeAvailability?.({ scope: target.scope, applicationThreadId: "thread", isolatedWorkspace: true,
      presentation: { surface: "native", mode: "individual" } })).toMatchObject({ availability: "unavailable" });
    await expect(runtime.managedProviderTerminals.authorizeAdmission({ scope: target.scope, applicationThreadId: "thread" }))
      .rejects.toMatchObject({ code: "terminal_unavailable" });
    await runtime.close();
    await runtime.close();
    expect(port.close).toHaveBeenCalledOnce();
    await expect(runtime.start()).rejects.toThrow("pi_native_runtime_closed");
    expect(() => runtime.driverFactory.create(connection)).toThrow("pi_native_connection_mismatch");
  });

  it("keeps native namespace identity independent of main's home and rejects active release mismatches", () => {
    const target = fixture();
    expect(target.module.prepare({ ...target.input, environment: { HOME: "/other/main" } }).nativeNamespaces)
      .toEqual(target.prepared.nativeNamespaces);
    expect(() => target.module.prepare({ ...target.input, backend: { ...target.input.backend, protocolRelease: "unsupported" } }))
      .toThrow("pi_native_configuration_invalid");
    const disabled = target.module.prepare({ ...target.input,
      backend: { ...target.input.backend, enabled: false, protocolRelease: "unsupported" },
      connections: target.input.connections.map(connection => ({ ...connection, enabled: false })) });
    expect(disabled.nativeNamespaces).toEqual([]);
    expect(() => disabled.createRuntime(target.context)).toThrow("pi_native_runtime_context_invalid");
    expect(target.createPort).not.toHaveBeenCalled();
  });

  it("reports bounded runtime diagnostics and treats inspection failure as unknown", async () => {
    const target = fixture();
    const runtime = target.createRuntime();
    expect(await runtime.startupEnvironmentState?.()).toBe("not_started");
    target.port.inspect.mockRejectedValueOnce(new Error("sensitive-host-path"));
    expect(await runtime.startupEnvironmentState?.()).toBe("unknown");
    expect(target.module.runtimeDiagnostic(new Error("unrelated"))).toBeUndefined();
    expect(target.module.runtimeDiagnostic(new PiNativeError("sensitive-host-path")))
      .toEqual({ connectionState: "recovery_required", message: expect.not.stringContaining("sensitive-host-path") });
    expect(target.module.runtimeDiagnostic(new PiNativeError("pi_session_native_writer_cleanup_required")))
      .toMatchObject({ message: expect.stringContaining("process and its descendants have exited") });
    expect(target.module.runtimeDiagnostic(new PiNativeError("pi_native_session_configuration_conflict")))
      .toMatchObject({ message: expect.stringContaining("earlier environment settings") });
  });

  it.each(["local", "ssh", "outbound"] as const)("normalizes only positively known %s runtime control refusals", async kind => {
    const target = fixture(kind), runtime = target.createRuntime();
    const request = { expectedRevision: "revision-1", force: true };
    const known = [
      [new PiNativeError("pi_native_confirmation_stale"), "confirmation_stale"],
      [new PiNativeError("pi_native_restart_blocked"), "blocked"],
      [new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown"), "cleanup_unproven"],
    ] as const;
    for (const [cause, reason] of known) for (const action of ["stop", "restart"] as const) {
      target.port.stop.mockRejectedValueOnce(cause);
      const error = await runtime.administration![action](request).catch(error => error);
      expect(error).toBeInstanceOf(BackendRuntimeControlRejectedError);
      expect(error.reason).toBe(reason);
      expect(error.cause).toBe(cause);
    }
    const unknown = [
      new PiNativeError("pi_native_unrecognized_control_failure", "not_sent"),
      new PiNativeError("pi_native_sidecar_unavailable", "sent_outcome_unknown"),
      new PiNativeError("pi_native_confirmation_stale", "sent_outcome_unknown"),
      Object.assign(new Error("pi_native_cleanup_unproven"), { code: "pi_native_cleanup_unproven", delivery: "not_sent" }),
    ];
    for (const cause of unknown) for (const action of ["stop", "restart"] as const) {
      target.port.stop.mockRejectedValueOnce(cause);
      await expect(runtime.administration![action](request)).rejects.toBe(cause);
    }
    expect(target.port.stop).toHaveBeenCalledTimes((known.length + unknown.length) * 2);
    expect(target.port.inspect).not.toHaveBeenCalled();
    expect(target.port.close).not.toHaveBeenCalled();
  });

  it.each(["ssh", "outbound"] as const)("does not replace a refused %s Stop with forced cleanup", async kind => {
    const target = fixture(kind);
    const runtime = target.createRuntime();
    target.port.stop.mockRejectedValueOnce(new PiNativeError("pi_native_runtime_changed"));
    await expect(runtime.administration!.stop({ expectedRevision: "stale", force: false }))
      .rejects.toThrow("pi_native_runtime_changed");
    await runtime.stopBeforeConversationCleanup?.();
    expect(target.port.stop).toHaveBeenCalledExactlyOnceWith({ expectedRevision: "stale", force: false });
    expect(target.port.inspect).not.toHaveBeenCalled();
    expect(target.port.close).toHaveBeenCalledOnce();
  });

  it("completes local pre-cleanup after administration already stopped the host", async () => {
    const target = fixture(), runtime = target.createRuntime();
    target.port.stop.mockImplementation(async () => {
      target.port.inspect.mockRejectedValue(new PiNativeError("pi_native_runtime_closed"));
    });
    await runtime.administration!.stop({ expectedRevision: "revision-1", force: true });
    await expect(runtime.stopBeforeConversationCleanup!()).resolves.toBeUndefined();
    await expect(runtime.stopBeforeConversationCleanup!()).resolves.toBeUndefined();
    expect(target.port.inspect).not.toHaveBeenCalled();
    expect(target.port.stop).toHaveBeenCalledOnce();
    expect(target.port.close).toHaveBeenCalledTimes(2);
  });

  it("retains CLI endpoints until native cleanup succeeds and allows failed cleanup to be retried", async () => {
    const target = fixture();
    const runtime = target.createRuntime();
    const driver = runtime.driverFactory.create(target.connection) as PiNativeConversationDriver;
    const closeDriver = vi.spyOn(driver, "close").mockRejectedValueOnce(new Error("driver_cleanup_unconfirmed"));
    const closeTools = vi.spyOn(PiNativeAgentToolService.prototype, "close");
    try {
      target.port.close.mockRejectedValueOnce(new Error("process_cleanup_unconfirmed"));
      await expect(runtime.close()).rejects.toThrow("Pi runtime cleanup is incomplete.");
      expect(closeDriver).toHaveBeenCalledOnce();
      expect(target.port.close).not.toHaveBeenCalled();
      expect(closeTools).not.toHaveBeenCalled();
      await expect(runtime.close()).rejects.toThrow("process_cleanup_unconfirmed");
      expect(closeDriver).toHaveBeenCalledTimes(2);
      expect(target.port.close).toHaveBeenCalledOnce();
      expect(closeTools).not.toHaveBeenCalled();
      await runtime.close();
      expect(closeDriver).toHaveBeenCalledTimes(3);
      expect(target.port.close).toHaveBeenCalledTimes(2);
      expect(closeTools).toHaveBeenCalledOnce();
      expect(closeTools.mock.invocationCallOrder[0]).toBeGreaterThan(target.port.close.mock.invocationCallOrder[1]!);
      await runtime.close();
      expect(closeTools).toHaveBeenCalledOnce();
    } finally { closeDriver.mockRestore(); closeTools.mockRestore(); }
  });

  it("maps retained runtime sessions only to this native backend's thread bindings", async () => {
    const target = fixture();
    const runtime = target.createRuntime();
    const native = target.createThread("native-retained");
    const sdk = target.createThread("sdk-retained", target.sdkConnection);
    const copyRow = (table: string, id: string, changes: Record<string, unknown>) => {
      const row = { ...(target.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>), ...changes };
      target.database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    };
    const historicalEnvironment = "00000000-0000-4000-8000-000000000001";
    copyRow("execution_environments", target.environment.id, { id: historicalEnvironment, kind: "ssh" });
    copyRow("agent_connection_profiles", target.connection.id, { id: "historical-native-profile", template_id: "historical-native-target", execution_environment_id: historicalEnvironment });
    const historicalWorkspace = new InventoryRepository(target.database).upsertWorkspace(target.scope, {
      environmentId: historicalEnvironment, canonicalPath: "/tmp/pi-native-historical", displayName: "Historical native",
      project: { kind: "new", name: "Historical native" }, available: true, trustState: "trusted",
      environmentConfigurationRevision: target.environment.configurationRevision, now: 400,
    });
    const historical = target.bindings.createUnboundThread(target.scope, { id: "historical-native-thread", workspaceId: historicalWorkspace.id,
      connectionProfileId: "historical-native-profile", title: "Historical native", now: 400 }).id;
    target.bindings.bindDiscoveredConversation(target.scope, historical, { backendConversationId: "native-session", now: 450 });
    target.bindings.bindDiscoveredConversation(target.scope, native, { backendConversationId: "native-session", now: 500 });
    target.bindings.bindDiscoveredConversation(target.scope, sdk, { backendConversationId: "sdk-session", now: 500 });
    target.port.inspect.mockResolvedValue({ runtimeId: "retained-runtime", revision: "retained-revision", state: "active",
      blockers: ["active_work"], retainedSessions: ["native-session", "sdk-session"].map(sessionId => ({
        sessionId, sessionFile: `/tmp/native/${sessionId}.jsonl`, cwd: "/tmp/pi-native-module",
        handleId: sessionId, generation: "generation", throughSequence: 2, retainedAfterSequence: 0, retainedOperationIds: [],
      })) });
    expect(await runtime.administration!.inspect()).toEqual({ state: "active", incarnation: "retained-runtime",
      revision: "retained-revision", blockers: ["active_work"], retainedThreadIds: [native] });
    expect(await runtime.startupEnvironmentState?.()).toBe("started");
  });
});

describe("native Pi scoped persistence", () => {
  it("initializes drafts and Saved Agents from the single advertised native model and effort", () => {
    const target = fixture("local", {});
    const runtime = target.createRuntime();
    const thread = target.createThread("native-account-default");
    runtime.threadPersistence.initializeNewThread(target.scope, thread, target.connection, nativeDefaultCatalog);
    expect(target.repository.getSettings(target.scope, thread)).toMatchObject({ modelProvider: "provider", modelId: "preferred", thinkingLevel: "high" });
    expect(() => runtime.threadPersistence.validateInitialization(target.scope, thread, nativeDefaultCatalog)).not.toThrow();
    const context = { scope: target.scope, connection: target.connection, catalog: nativeDefaultCatalog,
      workspace: { summary: { environmentId: target.environment.id } } as never };
    const resolved = runtime.savedAgents.resolve({ ...context,
      prepared: runtime.savedAgents.prepareResolutionContext(context), overrides: runtime.savedAgents.validateOverrides({ overrides: [] }) });
    expect(resolved.normalizedValues).toEqual([
      { id: "model", value: encodePiModelSetting("provider", "preferred") },
      { id: "thinking_level", value: "high" }, { id: "tool_access", value: "full" },
    ]);
  });

  it.each(["configuration", "preference"] as const)("keeps an unavailable explicit %s model unresolved instead of selecting the native default", source => {
    const target = fixture("local", source === "configuration" ? { provider: "provider", model: "missing" } : {});
    const runtime = target.createRuntime();
    if (source === "preference") target.preferences.save(target.scope, target.connection.id, "model", encodePiModelSetting("provider", "missing"), 400);
    const thread = target.createThread("missing-explicit-model");
    runtime.threadPersistence.initializeNewThread(target.scope, thread, target.connection, nativeDefaultCatalog);
    expect(target.repository.getSettings(target.scope, thread).modelId).toBeNull();
    expect(() => runtime.threadPersistence.validateInitialization(target.scope, thread, nativeDefaultCatalog)).toThrow("Choose an available model");
    const context = { scope: target.scope, connection: target.connection, catalog: nativeDefaultCatalog,
      workspace: { summary: { environmentId: target.environment.id } } as never };
    expect(() => runtime.savedAgents.resolve({ ...context,
      prepared: runtime.savedAgents.prepareResolutionContext(context), overrides: runtime.savedAgents.validateOverrides({ overrides: [] }) }))
      .toThrow("Choose a Pi model");
  });

  it.each(["ambiguous_model", "unavailable_effort"] as const)("requires a user choice when native defaults have %s", failure => {
    const target = fixture("local", {});
    const runtime = target.createRuntime();
    const invalid: BackendCatalog = { ...catalog, models: catalog.models.map(model => failure === "ambiguous_model"
      ? { ...model, isDefault: true, defaultReasoningEffort: "high" }
      : model.id === "preferred" ? { ...model, isDefault: true, defaultReasoningEffort: "max" } : model) };
    const thread = target.createThread("invalid-native-default");
    runtime.threadPersistence.initializeNewThread(target.scope, thread, target.connection, invalid);
    expect(() => runtime.threadPersistence.validateInitialization(target.scope, thread, invalid)).toThrow();
    const context = { scope: target.scope, connection: target.connection, catalog: invalid,
      workspace: { summary: { environmentId: target.environment.id } } as never };
    expect(() => runtime.savedAgents.resolve({ ...context,
      prepared: runtime.savedAgents.prepareResolutionContext(context), overrides: runtime.savedAgents.validateOverrides({ overrides: [] }) })).toThrow();
  });

  it("uses native target defaults and preferences without reading or writing SDK settings", () => {
    const target = fixture();
    const runtime = target.createRuntime();
    target.preferences.save(target.scope, target.sdkConnection.id, "model", encodePiModelSetting("provider", "preferred"), 400);
    target.preferences.save(target.scope, target.sdkConnection.id, "thinking_level", "high", 401);
    const thread = target.createThread("native-defaults");
    runtime.threadPersistence.initializeNewThread(target.scope, thread, target.connection, nativeDefaultCatalog);
    expect(target.repository.getSettings(target.scope, thread)).toMatchObject({ modelProvider: "provider", modelId: "configured", thinkingLevel: "low", revision: 0 });
    const sdk = new PiConversationRepository(target.database);
    expect(() => sdk.getSettings(target.scope, thread)).toThrow("Pi settings were not found");
    target.preferences.save(target.scope, target.connection.id, "model", encodePiModelSetting("provider", "preferred"), 402);
    target.preferences.save(target.scope, target.connection.id, "thinking_level", "high", 403);
    const preferred = target.createThread("native-preferred");
    runtime.threadPersistence.initializeNewThread(target.scope, preferred, target.connection, nativeDefaultCatalog);
    expect(target.repository.getSettings(target.scope, preferred)).toMatchObject({ modelId: "preferred", thinkingLevel: "high" });
    const sdkThread = target.createThread("sdk-thread", target.sdkConnection);
    sdk.initializeSettings(target.scope, sdkThread, { toolMode: "ask" });
    expect(() => target.repository.initializeSettings(target.scope, sdkThread, { toolMode: "full" })).toThrow();
    expect(() => runtime.threadPersistence.initializeNewThread(target.scope, sdkThread, target.sdkConnection, catalog)).toThrow();
    for (const scope of [{ ...target.scope, principalId: "other" }, { ...target.scope, tenantId: "other" }]) {
      expect(() => target.repository.getSettings(scope, thread)).toThrow();
      expect(() => target.repository.updateSettings(scope, thread, { expectedRevision: 0, modelProvider: "p", modelId: "m", thinkingLevel: "high", toolMode: "full" })).toThrow();
    }
    expect(sdk.getSettings(target.scope, sdkThread)).toMatchObject({ toolMode: "ask", revision: 0 });
  });

  it("resolves native Saved Agents with strict envelopes and rechecks changed preferences at commit", () => {
    const target = fixture();
    const runtime = target.createRuntime();
    const context = { scope: target.scope, connection: target.connection, catalog,
      workspace: { summary: { environmentId: target.environment.id } } as never };
    const prepared = runtime.savedAgents.prepareResolutionContext(context);
    const overrides = runtime.savedAgents.validateOverrides({ overrides: [{ id: "tool_access", value: "ask" }] });
    const resolved = runtime.savedAgents.resolve({ ...context, prepared, overrides });
    expect(resolved).toMatchObject({ backendTypeId: "pi_native", normalizedValues: [
      { id: "model", value: encodePiModelSetting("provider", "configured") },
      { id: "thinking_level", value: "low" }, { id: "tool_access", value: "ask" },
    ] });
    expect(() => runtime.savedAgents.resolve({ ...context, prepared: { ...prepared, backendTypeId: "pi" }, overrides })).toThrow();
    expect(() => runtime.savedAgents.prepareResolutionContext({ ...context, connection: target.sdkConnection })).toThrow();
    expect(() => runtime.savedAgents.prepareResolutionContext({ ...context, scope: { ...target.scope, principalId: "other" } })).toThrow();
    const thread = target.createThread("saved-native");
    target.database.transaction(() => runtime.savedAgents.initializeNewThread({
      transaction: ConversationCreationTransaction.fromActiveDatabase(target.database), scope: target.scope,
      applicationThreadId: thread, connection: target.connection, resolved,
    }))();
    expect(target.repository.getSettings(target.scope, thread)).toMatchObject({ modelId: "configured", thinkingLevel: "low", toolMode: "ask" });
    target.preferences.save(target.scope, target.connection.id, "thinking_level", "high", 500);
    const stale = target.createThread("saved-stale");
    expect(() => target.database.transaction(() => runtime.savedAgents.initializeNewThread({
      transaction: ConversationCreationTransaction.fromActiveDatabase(target.database), scope: target.scope,
      applicationThreadId: stale, connection: target.connection, resolved,
    }))()).toThrow("target defaults changed");
    expect(() => target.repository.getSettings(target.scope, stale)).toThrow();
  });

  it("fences operation replays by thread, scope, kind, request and immutable completed receipt", () => {
    const target = fixture();
    const thread = target.createThread("operations");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    const input = { operationId: "operation", kind: "submission" as const, requestHash: "a".repeat(64) };
    expect(target.repository.prepareOperation(target.scope, thread, input)).toMatchObject({ state: "prepared", dispatchStarted: false, receiptJson: null });
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    expect(target.repository.prepareOperation(target.scope, thread, input)).toMatchObject({ state: "sent" });
    expect(() => target.repository.completeOperation(target.scope, thread, input.operationId, { state: "prepared" })).toThrow();
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "unknown" });
    const receipt = { state: "completed" as const, receiptJson: JSON.stringify({ accepted: true, turnId: "turn" }) };
    expect(target.repository.completeOperation(target.scope, thread, input.operationId, receipt)).toMatchObject(receipt);
    expect(target.repository.completeOperation(target.scope, thread, input.operationId, receipt)).toMatchObject(receipt);
    expect(() => target.repository.completeOperation(target.scope, thread, input.operationId, { ...receipt, receiptJson: "{}" })).toThrow();
    expect(() => target.repository.prepareOperation(target.scope, thread, { ...input, requestHash: "b".repeat(64) })).toThrow();
    expect(() => target.repository.prepareOperation(target.scope, thread, { ...input, kind: "action" })).toThrow();
    for (const scope of [{ ...target.scope, principalId: "other" }, { ...target.scope, tenantId: "other" }]) {
      expect(target.repository.getOperation(scope, thread, input.operationId)).toBeUndefined();
      expect(() => target.repository.prepareOperation(scope, thread, input)).toThrow();
      expect(() => target.repository.completeOperation(scope, thread, input.operationId, receipt)).toThrow();
    }
    const sdkThread = target.createThread("sdk-operation", target.sdkConnection);
    expect(() => target.repository.prepareOperation(target.scope, sdkThread, input)).toThrow();
    expect(target.repository.getOperation(target.scope, thread, input.operationId)).toMatchObject(receipt);
  });

  it("resets only the exact sent submission with positive non-dispatch evidence", () => {
    const target = fixture(); const thread = target.createThread("unsent-operation");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    const input = { operationId: "operation", kind: "submission" as const, requestHash: "a".repeat(64) };
    target.repository.prepareOperation(target.scope, thread, input);
    const reset = (scope = target.scope, requestHash = input.requestHash, prepareAttempt = 0) => target.repository.resetUnsentOperation(scope, thread, input.operationId, requestHash, prepareAttempt);
    expect(() => reset()).toThrow();
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    expect(() => reset(target.scope, "b".repeat(64))).toThrow();
    expect(() => reset({ ...target.scope, principalId: "other" })).toThrow();
    expect(() => reset({ ...target.scope, tenantId: "other" })).toThrow();
    expect(reset()).toMatchObject({ requestHash: input.requestHash, state: "prepared", dispatchStarted: false, prepareAttempt: 1, receiptJson: null });
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    expect(() => reset()).toThrow();
    expect(reset(target.scope, input.requestHash, 1)).toMatchObject({ state: "prepared", prepareAttempt: 2 });
    expect(() => target.repository.prepareOperation(target.scope, thread, { ...input, requestHash: "b".repeat(64) })).toThrow();
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "unknown" });
    expect(() => reset()).toThrow();
    const receipt = { state: "completed" as const, receiptJson: JSON.stringify({ accepted: true }) };
    target.repository.completeOperation(target.scope, thread, input.operationId, receipt);
    expect(() => reset()).toThrow();
    expect(target.repository.getOperation(target.scope, thread, input.operationId)).toMatchObject(receipt);
    target.repository.prepareOperation(target.scope, thread, { ...input, operationId: "action", kind: "action" });
    target.repository.completeOperation(target.scope, thread, "action", { state: "sent" });
    expect(() => target.repository.resetUnsentOperation(target.scope, thread, "action", input.requestHash, 0)).toThrow();
  });

  it("marks only the exact prepared submission attempt before dispatch", () => {
    const target = fixture(); const thread = target.createThread("dispatch-boundary");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    const input = { operationId: "operation", kind: "submission" as const, requestHash: "a".repeat(64) };
    target.repository.prepareOperation(target.scope, thread, input);
    const mark = (scope = target.scope, requestHash = input.requestHash, prepareAttempt = 0) =>
      target.repository.markSubmissionDispatched(scope, thread, input.operationId, requestHash, prepareAttempt);
    expect(() => mark()).toThrow();
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    expect(() => mark(target.scope, "b".repeat(64))).toThrow();
    expect(() => mark({ ...target.scope, principalId: "other" })).toThrow();
    expect(() => mark({ ...target.scope, tenantId: "other" })).toThrow();
    expect(() => mark(target.scope, input.requestHash, 1)).toThrow();
    expect(() => target.repository.markSubmissionDispatched(target.scope, "other", input.operationId, input.requestHash, 0)).toThrow();
    target.repository.resetUnsentOperation(target.scope, thread, input.operationId, input.requestHash, 0);
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    expect(() => mark()).toThrow();
    expect(mark(target.scope, input.requestHash, 1)).toMatchObject({ state: "sent", dispatchStarted: true, prepareAttempt: 1 });
    expect(mark(target.scope, input.requestHash, 1)).toMatchObject({ state: "sent", dispatchStarted: true, prepareAttempt: 1 });

    for (const kind of ["action", "interrupt"] as const) {
      target.repository.prepareOperation(target.scope, thread, { ...input, operationId: kind, kind });
      target.repository.completeOperation(target.scope, thread, kind, { state: "sent" });
      expect(() => target.repository.markSubmissionDispatched(target.scope, thread, kind, input.requestHash, 0)).toThrow();
    }
    for (const state of ["unknown", "completed"] as const) {
      target.repository.prepareOperation(target.scope, thread, { ...input, operationId: state });
      target.repository.completeOperation(target.scope, thread, state, { state });
      expect(() => target.repository.markSubmissionDispatched(target.scope, thread, state, input.requestHash, 0)).toThrow();
    }
    target.repository.prepareOperation(target.scope, thread, { ...input, operationId: "receipted" });
    target.repository.completeOperation(target.scope, thread, "receipted", { state: "sent", receiptJson: "{}" });
    expect(() => target.repository.markSubmissionDispatched(target.scope, thread, "receipted", input.requestHash, 0)).toThrow();
  });

  it("never resets a dispatched submission or erases its marker during reconciliation", () => {
    const target = fixture(); const thread = target.createThread("dispatched-operation");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    const input = { operationId: "operation", kind: "submission" as const, requestHash: "a".repeat(64) };
    target.repository.prepareOperation(target.scope, thread, input);
    target.repository.completeOperation(target.scope, thread, input.operationId, { state: "sent" });
    target.repository.markSubmissionDispatched(target.scope, thread, input.operationId, input.requestHash, 0);
    const reset = () => target.repository.resetUnsentOperation(target.scope, thread, input.operationId, input.requestHash, 0);
    expect(reset).toThrow();
    expect(() => target.database.prepare("UPDATE pi_native_operations SET dispatch_started = 0").run()).toThrow("dispatch cannot be cleared");
    expect(() => target.database.prepare("UPDATE pi_native_operations SET state = 'prepared'").run()).toThrow();
    expect(() => target.database.prepare("UPDATE pi_native_operations SET operation_kind = 'action'").run()).toThrow();
    expect(target.repository.completeOperation(target.scope, thread, input.operationId, { state: "unknown" }))
      .toMatchObject({ state: "unknown", dispatchStarted: true });
    expect(reset).toThrow();
    const receipt = { state: "completed" as const, receiptJson: JSON.stringify({ accepted: true, turnId: "turn" }) };
    expect(target.repository.completeOperation(target.scope, thread, input.operationId, receipt))
      .toMatchObject({ ...receipt, dispatchStarted: true });
    expect(target.repository.prepareOperation(target.scope, thread, input)).toMatchObject({ ...receipt, dispatchStarted: true });
    expect(reset).toThrow();
  });

  it("preserves prepared-versus-dispatched evidence across database close and reopen", async () => {
    const target = fixture(); const thread = target.createThread("durable-dispatch");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    const requestHash = "a".repeat(64);
    for (const operationId of ["prepared-only", "dispatched"]) {
      target.repository.prepareOperation(target.scope, thread, { operationId, kind: "submission", requestHash });
      target.repository.completeOperation(target.scope, thread, operationId, { state: "sent" });
    }
    target.repository.markSubmissionDispatched(target.scope, thread, "dispatched", requestHash, 0);
    const directory = await mkdtemp(join(tmpdir(), "pi-dispatch-"));
    const filename = join(directory, "overlay.sqlite");
    let reopened: Database.Database | undefined;
    try {
      await target.database.backup(filename);
      target.database.close();
      databases.splice(databases.indexOf(target.database), 1);
      reopened = new Database(filename);
      const repository = new PiNativeThreadRepository(reopened);
      expect(repository.getOperation(target.scope, thread, "prepared-only")).toMatchObject({ state: "sent", dispatchStarted: false });
      expect(repository.getOperation(target.scope, thread, "dispatched")).toMatchObject({ state: "sent", dispatchStarted: true });
      expect(repository.resetUnsentOperation(target.scope, thread, "prepared-only", requestHash, 0))
        .toMatchObject({ state: "prepared", prepareAttempt: 1, dispatchStarted: false });
      expect(() => repository.resetUnsentOperation(target.scope, thread, "dispatched", requestHash, 0)).toThrow();
      reopened.close();
      reopened = new Database(filename);
      const durable = new PiNativeThreadRepository(reopened);
      expect(durable.getOperation(target.scope, thread, "prepared-only")).toMatchObject({ state: "prepared", prepareAttempt: 1, dispatchStarted: false });
      expect(durable.getOperation(target.scope, thread, "dispatched")).toMatchObject({ state: "sent", prepareAttempt: 0, dispatchStarted: true });
    } finally {
      if (reopened?.open) reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts observed model settings only after binding and preserves Sedes tool access", () => {
    const target = fixture();
    const thread = target.createThread("observed-native");
    target.repository.initializeSettings(target.scope, thread, {
      modelProvider: "provider", modelId: "configured", thinkingLevel: "low", toolMode: "read_only",
    });
    const observed = { modelProvider: "provider", modelId: "preferred", thinkingLevel: "high" };
    expect(target.repository.syncObservedSettingsForBoundThread(target.scope, thread, observed)).toBe(false);
    target.bindings.bindDiscoveredConversation(target.scope, thread, { backendConversationId: "observed", now: 500 });
    expect(target.repository.syncObservedSettingsForBoundThread(target.scope, thread, observed)).toBe(true);
    expect(target.repository.getSettings(target.scope, thread)).toMatchObject({ ...observed, toolMode: "read_only", revision: 1 });
    expect(target.repository.syncObservedSettingsForBoundThread(target.scope, thread, observed)).toBe(false);
    expect(() => target.repository.updateSettings(target.scope, thread, {
      expectedRevision: 0, ...observed, toolMode: "full",
    })).toThrow("settings changed");
    expect(target.repository.getSettings(target.scope, thread).toolMode).toBe("read_only");
  });

  it("keeps submission correlations and binding details native-only", () => {
    const target = fixture();
    const runtime = target.createRuntime();
    const thread = target.createThread("native-bound");
    target.repository.initializeSettings(target.scope, thread, { toolMode: "full" });
    target.bindings.bindDiscoveredConversation(target.scope, thread, { backendConversationId: "session", now: 500 });
    const detail = serializePiNativeBindingDetail({ sessionId: "session", sessionFile: "/tmp/native/session.jsonl", cwd: "/tmp/pi-native-module" });
    runtime.threadPersistence.saveBoundBindingDetail(target.scope, thread, detail);
    expect(runtime.bindingDetails.getBindingDetail(target.scope, thread)).toBe(detail);
    expect(new PiConversationRepository(target.database).getBindingDetail(target.scope, thread)).toBeUndefined();
    expect(() => runtime.threadPersistence.saveBoundBindingDetail(target.scope, thread, JSON.stringify({ version: 1, backendConversationId: "session", sessionFile: "/tmp/native/session.jsonl" }))).toThrow();
    target.repository.createSubmissionDetails(target.scope, thread, { operationId: "submit" });
    target.repository.recordAcceptedUserEntry(target.scope, thread, "submit", "entry");
    expect(target.repository.recordAcceptedUserEntry(target.scope, thread, "submit", "entry")).toMatchObject({ acceptedUserEntryId: "entry" });
    expect(() => target.repository.recordAcceptedUserEntry(target.scope, thread, "submit", "different")).toThrow();
    expect(target.repository.findSubmissionDetails({ ...target.scope, principalId: "other" }, thread, "submit")).toBeUndefined();
    const sdkThread = target.createThread("sdk-bound", target.sdkConnection);
    target.bindings.bindDiscoveredConversation(target.scope, sdkThread, { backendConversationId: "sdk-session", now: 500 });
    expect(() => target.repository.createSubmissionDetails(target.scope, sdkThread, { operationId: "submit" })).toThrow();
    expect(() => target.repository.saveBindingDetails(target.scope, sdkThread, {
      backendConversationId: "sdk-session", opaqueBindingDetail: detail, nativeSessionPath: "/tmp/native/sdk.jsonl",
    })).toThrow();
  });

  it("uses native settings for presentation and automation, rejecting SDK presentation targets", async () => {
    const target = fixture();
    const runtime = target.createRuntime();
    const thread = target.createThread("native-presentation");
    runtime.threadPersistence.initializeNewThread(target.scope, thread, target.connection, catalog);
    const input = { scope: target.scope, applicationThreadId: thread, backend: target.instance,
      connection: target.connection, catalog, workspace: {} as never };
    const presentation = await runtime.presentation.read(input);
    expect(presentation.settings.values).toContainEqual({ id: "model", desiredValue: encodePiModelSetting("provider", "configured"), effectiveValue: null, applicationState: "draft" });
    await expect(runtime.presentation.read({ ...input, backend: { ...target.instance, kind: "pi" }, connection: target.sdkConnection }))
      .rejects.toThrow("pi_thread_presentation_target_invalid");
    expect(() => runtime.automationExecutionPolicy.assertCanAutomate(target.scope, thread)).not.toThrow();
    expect(() => runtime.automationExecutionPolicy.assertCanAutomate({ ...target.scope, principalId: "other" }, thread)).toThrow();
    target.repository.updateSettings(target.scope, thread, { expectedRevision: 0, modelProvider: "provider", modelId: "configured", thinkingLevel: null, toolMode: "full" });
    expect(() => runtime.automationExecutionPolicy.assertCanAutomate(target.scope, thread)).toThrow("Choose an allowed Pi model");
  });
});
