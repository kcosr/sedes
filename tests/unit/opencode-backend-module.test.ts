import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeBackendModule } from "../../src/server/backends/opencode/opencode-backend-module.js";
import { openCodeRuntimeNamespaceKey, type OpenCodeRuntimeInput, type OpenCodeRuntimeSnapshot } from "../../src/server/backends/opencode/opencode-runtime.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { BackendModuleCatalog } from "../../src/server/backends/module-catalog.js";
import type { BackendModuleConfigurationInput, BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { openCodeRuntimeTarget, type OpenCodeConversationRuntime } from "../../src/server/backends/opencode/opencode-conversation-context.js";
import { OpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { runWithOpenCodeInvocation } from "../../src/server/backends/opencode/opencode-tool-invocation.js";
import { OpenCodeThreadRepository } from "../../src/server/backends/opencode/opencode-thread-repository.js";
import { OpenCodeConversationBackendDriver } from "../../src/server/backends/opencode/opencode-conversation-driver.js";

const databases: Database.Database[] = [];
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const database of databases.splice(0)) database.close(); vi.restoreAllMocks(); });
const scope = { tenantId: "tenant", principalId: "principal" };
const authority = { ...scope, backendInstanceId: "opencode", executionEnvironmentId: "local" };
function configuration(ownership: "owned" | "external" = "owned"): BackendModuleConfigurationInput {
  return {
    backend: { id: "opencode", kind: "opencode", protocolRelease: "2.0.18", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { nativeStorePath: "/native/opencode.db", connection: ownership === "owned"
        ? { ownership, channel: { type: "process_stdio", executablePath: "/bin/opencode2", workingDirectory: "/workspace" } }
        : { ownership, channel: { type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode", secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } } } },
    connections: [{ id: "profile-template", kind: "opencode_http", backendInstanceId: "opencode", executionEnvironmentId: "local", enabled: true,
      moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } }],
    executionEnvironments: [{ id: "local", kind: "local" }], environment: { HOME: "/home/fixture" },
  };
}
function context() {
  const database = new Database(":memory:"); databases.push(database);
  const instance = { id: "opencode", tenantId: "tenant", kind: "opencode" as const, label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" };
  const connection = { id: "profile", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "profile-template", kind: "opencode_http" as const,
    backendInstanceId: "opencode", executionEnvironmentId: "local", label: "OpenCode", enabled: true, configurationRevision: 1 };
  const discard = vi.fn();
  const resolveSecret = vi.fn(async () => ({ value: "fixture-basic-password", identity: {}, discard }));
  const value: BackendModuleRuntimeContext = {
    scope, database, instance, connections: [connection], usage: NO_USAGE_SINK,
    environmentChannel: { scope, executionEnvironmentId: "local", resolveSecret } as unknown as BackendModuleRuntimeContext["environmentChannel"],
    environmentOperations: { environmentKind: "local" } as BackendModuleRuntimeContext["environmentOperations"],
    toolProvenanceKey: new Uint8Array(32), agentTools: {} as BackendModuleRuntimeContext["agentTools"],
    outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"], viewedImageCapture: {} as BackendModuleRuntimeContext["viewedImageCapture"],
    agentToolSourceCapabilities: {} as BackendModuleRuntimeContext["agentToolSourceCapabilities"], agentToolCli: { availability: "unavailable", reason: "cli_unavailable" },
  };
  return { value, connection, resolveSecret, discard };
}
function nativeFactory() {
  function native(input: OpenCodeRuntimeInput) {
    let state: OpenCodeRuntimeSnapshot["state"] = "stopped";
    const result = {
      nativeNamespaceKey: openCodeRuntimeNamespaceKey(input.authority.executionEnvironmentId, input.nativeStorePath),
      start: vi.fn(async () => { if (input.connection.ownership === "external") await input.externalPassword!(); state = "ready"; }),
      health: vi.fn(async () => ({ available: state === "ready", checkedAt: new Date().toISOString() })),
      acquire: vi.fn((): never => { throw new Error("unexpected conversation acquisition in module fixture"); }),
      assertCurrent: vi.fn(async () => undefined),
      admitToolSession: vi.fn(async (): Promise<never> => { throw new Error("unexpected tool admission"); }),
      releaseToolSession: vi.fn(),
      snapshot: () => ({ state, ownership: input.connection.ownership, references: 0, ...(state === "ready" ? { generation: "owner-generation" } : {}) }),
      stop: vi.fn(async () => {
        const nativeInterrupts = state === "stopped" ? "not_owned" as const : "incomplete" as const;
        state = "stopped";
        return { cleanup: "proved" as const, nativeInterrupts };
      }),
      close: vi.fn(async () => { state = "stopped"; return { cleanup: "proved" as const, nativeInterrupts: "not_owned" as const }; }),
    };
    return result;
  }
  const instances: ReturnType<typeof native>[] = [];
  return { create: vi.fn((input: OpenCodeRuntimeInput) => { const instance = native(input); instances.push(instance); return instance; }), instances };
}

async function persistedInvocationFixture() {
  const persisted = savedAgentDatabase(); databases.push(persisted.database);
  const { database, scope } = persisted;
  const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
  const wire = createOpenCodeApiFixture(), base = context();
  const instance = { ...base.value.instance, tenantId: scope.tenantId };
  const connection = { ...base.connection, tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, executionEnvironmentId: environmentId };
  database.prepare(`INSERT INTO agent_backend_instances
    (tenant_id,owner_principal_id,id,kind,label,enabled,configuration_revision,protocol_release,created_at,updated_at)
    VALUES (?,?,?,'opencode','OpenCode',1,1,'2.0.18',100,100)`).run(scope.tenantId, scope.principalId, instance.id);
  database.prepare(`INSERT INTO agent_connection_profiles
    (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,configuration_revision,created_at,updated_at)
    VALUES (?,?,?,?,?,'opencode',?,'opencode_http','OpenCode',1,1,100,100)`)
    .run(scope.tenantId, scope.principalId, connection.id, connection.templateId, instance.id, environmentId);
  const workspace = new InventoryRepository(database).upsertWorkspace(scope, {
    environmentId, canonicalPath: wire.directory, displayName: "Persisted OpenCode", available: true,
    trustState: "trusted", environmentConfigurationRevision: 1, now: 100,
  });
  const bindings = new ConversationBindingRepository(database);
  const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: connection.id, title: "Recovered", now: 100 });
  const binding = bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: wire.sessionID, now: 100 });
  const input = configuration();
  const configured = { ...input, connections: input.connections.map(item => ({ ...item, executionEnvironmentId: environmentId })),
    executionEnvironments: [{ id: environmentId, kind: "local" as const }] };
  const runtimeContext = { ...base.value, scope, database, instance, connections: [connection],
    environmentChannel: { ...base.value.environmentChannel, scope, executionEnvironmentId: environmentId } };
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch });
  const host = new OpenCodeNativeHost({ ...scope, backendInstanceId: instance.id, executionEnvironmentId: environmentId,
    runtimeId: "persisted-runtime", nativeGeneration: "persisted-generation" }, new OpenCodeHttpNativeAdapter(client), {
    assertCurrent: async () => {}, installSessionEnvironment: vi.fn(async () => { throw new Error("recovery must not install environment"); }),
    ensureMcpRegistration: vi.fn(async () => { throw new Error("recovery must not register MCP"); }),
  }, client.lifetime);
  const namespace = openCodeRuntimeNamespaceKey(environmentId, "/native/opencode.db");
  const identity = { pid: process.pid, startTime: "1", uid: process.getuid?.() ?? 0, executablePath: "/native/opencode2",
    executable: { device: "1", inode: "2" }, nativeStorePath: "/native/opencode.db", store: { device: "1", inode: "3" }, storeObservation: "open_file" as const };
  let state: OpenCodeRuntimeSnapshot["state"] = "stopped";
  const owner: OpenCodeConversationRuntime & { close(): Promise<{ cleanup: "proved"; nativeInterrupts: "not_owned" }>; stop(): Promise<{ cleanup: "proved"; nativeInterrupts: "not_owned" }> } = {
    nativeNamespaceKey: namespace,
    start: vi.fn(async () => { state = "ready"; }), health: async () => ({ available: state === "ready", checkedAt: new Date().toISOString() }),
    snapshot: () => ({ state, ownership: "owned", references: 0, generation: "persisted-generation", identity }),
    assertCurrent: vi.fn(async () => { if (state !== "ready") throw new Error("not ready"); }),
    acquire: vi.fn(target => { const port = host.acquire(target); let released = false;
      return { client: port, generation: "persisted-generation", identity, release: () => { if (!released) { released = true; host.release(port); } } }; }),
    admitToolSession: vi.fn(async (): Promise<never> => { throw new Error("recovery must not admit tools"); }), releaseToolSession: vi.fn(),
    stop: async () => ({ cleanup: "proved", nativeInterrupts: "not_owned" }),
    close: async () => { host.close(); client.close(); return { cleanup: "proved", nativeInterrupts: "not_owned" }; },
  };
  const factory = vi.fn(() => owner);
  const runtime = new OpenCodeBackendModule(factory).prepare(configured).createRuntime(runtimeContext);
  cleanups.push(() => runtime.close());
  const driver = runtime.driverFactory.create(connection);
  if (!(driver instanceof OpenCodeConversationBackendDriver)) throw new Error("unexpected backend driver");
  const repository = new OpenCodeThreadRepository({ database, scope, backendInstanceId: instance.id, nativeNamespaceKey: namespace });
  repository.saveBinding(scope, thread.id, { version: 1, ...scope, sessionId: wire.sessionID, backendInstanceId: instance.id,
    connectionProfileId: connection.id, executionEnvironmentId: environmentId, canonicalWorkspacePath: wire.directory, nativeNamespaceKey: namespace });
  const target = { scope, binding: { ...binding, createdAt: new Date(binding.createdAt).toISOString() },
    opaqueBindingDetail: repository.getBinding(scope, thread.id)!,
    workspace: { canonicalPath: wire.directory, authorityRevision: workspace.environmentConfigurationRevision,
      summary: { id: workspace.id, environmentId, displayName: workspace.displayName, displayPath: wire.directory,
        availability: workspace.availability, trustState: workspace.trustState, revision: workspace.revision } } };
  driver.input.settings.initialize(scope, thread.id, { backendInstanceId: instance.id, connectionProfileId: connection.id,
    executionEnvironmentId: environmentId }, { providerID: "provider", id: "model" }, 100);
  driver.input.settings.captureOperation(scope, { applicationThreadId: thread.id, applicationOperationId: "creation",
    operationKind: "create", expectedRevision: 0, now: 100 });
  repository.reserveOperation(scope, { applicationThreadId: thread.id, applicationOperationId: "creation", operationKind: "create",
    nativeSessionId: wire.sessionID, nativeInputId: null, connectionProfileId: connection.id, executionEnvironmentId: environmentId,
    requestFingerprint: "a".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, 100);
  repository.markDispatched(scope, thread.id, "creation", "create", 101);
  repository.recordOutcome(scope, thread.id, "creation", "create", { expected: "dispatched", disposition: "accepted", nativeEvidenceFingerprint: "b".repeat(64), now: 102 });
  database.prepare(`INSERT INTO conversation_creation_attempts
    (tenant_id,owner_principal_id,application_thread_id,attempt_id,mutation_id,backend_instance_id,connection_profile_id,execution_environment_id,
      creation_kind,source_kind,initial_input_text,consumed_draft_revision,backend_creation_correlation,phase,provisional_backend_conversation_id,
      provisional_opaque_binding_detail,prepared_at,external_call_started_at,accepted_at,reconciled_at)
    VALUES (?,?,?,'creation-attempt','creation',?,?,?,'first_input','composer','initial input',1,?,'bound',?,?,100,101,102,103)`)
    .run(scope.tenantId, scope.principalId, thread.id, instance.id, connection.id, environmentId, wire.sessionID, wire.sessionID, target.opaqueBindingDetail);
  expect(repository.hasCreatedRoot(scope, thread.id, wire.sessionID)).toBe(true);
  await driver.health();
  const lease = owner.acquire(openCodeRuntimeTarget(target));
  const observer = new OpenCodeInputObserver(driver.input, target, owner, lease, client.lifetime);
  cleanups.push(() => { observer.close(); lease.release(); });
  await observer.start();
  const evidence = new OpenCodeInputEvidenceRepository(repository);
  repository.reserveOperation(scope, { applicationThreadId: thread.id, connectionProfileId: connection.id,
    executionEnvironmentId: environmentId, nativeSessionId: wire.sessionID, applicationOperationId: "persisted-input", operationKind: "submit",
    nativeInputId: "msg_persisted", requestFingerprint: "a".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, 100);
  observer.track(evidence.begin(scope, thread.id, "persisted-input", "submit", observer.trackerId, "queue"));
  repository.markDispatched(scope, thread.id, "persisted-input", "submit", 101);
  observer.recordAdmission("persisted-input", "submit", { id: "msg_persisted", sessionID: wire.sessionID, type: "user",
    payload: { text: "current owned input" }, delivery: "queue", time: { created: 100 } });
  wire.send({ id: "evt_persisted", type: "session.inbox.delivered", created: 102,
    durable: { aggregateID: wire.sessionID, seq: 1, version: 1 }, data: { sessionID: wire.sessionID, inboxID: "msg_persisted" } });
  await vi.waitFor(() => expect(evidence.get(scope, thread.id, "persisted-input", "submit").consumedFingerprint).not.toBeNull());
  const stamp = host.captureToolInvocation(openCodeRuntimeTarget(target));
  observer.close(); lease.release();
  const source = { scope, sourceThreadId: thread.id, sourceWorkspaceId: workspace.id, sourceEnvironmentId: environmentId, backendKind: "opencode" as const };
  return { database, wire, host, owner, factory, runtime, target, source, stamp, configured, runtimeContext };
}

describe("OpenCode compiled module", () => {
  it("recovers exact invocation authority from persisted inventory and native binding without bootstrap effects", async () => {
    const f = await persistedInvocationFixture();
    const before = f.wire.requests.length;
    const authority = runWithOpenCodeInvocation(f.stamp, () => f.runtime.agentToolAccessDecisionAuthority!(f.source));
    const approval = await authority.acquire(new AbortController().signal);
    expect(approval.isCurrent()).toBe(true);
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.owner.start).toHaveBeenCalledOnce();
    expect(f.owner.admitToolSession).not.toHaveBeenCalled();
    expect(f.wire.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
    expect(f.wire.requests.slice(before).some(request => request.pathname === `/api/session/${f.wire.sessionID}`)).toBe(true);
    approval.release();
  });

  it("denies a mismatched invocation stamp and a changed persisted native binding", async () => {
    const f = await persistedInvocationFixture();
    const before = f.wire.requests.length;
    const stamp = { ...f.stamp, authority: { ...f.stamp.authority,
      session: { ...f.stamp.authority.session, bindingFingerprint: "f".repeat(64) } } };
    const mismatched = runWithOpenCodeInvocation(stamp, () => f.runtime.agentToolAccessDecisionAuthority!(f.source));
    await expect(mismatched.acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    const exact = runWithOpenCodeInvocation(f.stamp, () => f.runtime.agentToolAccessDecisionAuthority!(f.source));
    f.database.prepare("UPDATE conversation_bindings SET backend_conversation_id='ses_replaced' WHERE application_thread_id=?")
      .run(f.source.sourceThreadId);
    await expect(exact.acquire(new AbortController().signal)).rejects.toBeDefined();
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.owner.start).toHaveBeenCalledOnce();
    expect(f.owner.admitToolSession).not.toHaveBeenCalled();
    expect(f.wire.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
  });

  it("does not construct a local native owner for a retained invocation after module replacement", async () => {
    const f = await persistedInvocationFixture();
    const factory = nativeFactory();
    const replacement = new OpenCodeBackendModule(factory.create).prepare(f.configured).createRuntime(f.runtimeContext);
    cleanups.push(() => replacement.close());
    const authority = runWithOpenCodeInvocation(f.stamp, () => replacement.agentToolAccessDecisionAuthority!(f.source));
    await expect(authority.acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("is registered in production and does not start during preparation", async () => {
    expect(compiledBackendModuleCatalog.moduleForBackendKind("opencode")).toBeInstanceOf(OpenCodeBackendModule);
    expect(compiledBackendModuleCatalog.moduleForConnectionKind("opencode_http")).toBe(compiledBackendModuleCatalog.moduleForBackendKind("opencode"));
    const factory = nativeFactory(); const module = new OpenCodeBackendModule(factory.create);
    expect(new BackendModuleCatalog([module]).moduleForBackendKind("opencode")).toBe(module);
    const prepared = module.prepare(configuration());
    expect(prepared.nativeStores).toEqual([]);
    expect(prepared.nativeNamespaces).toEqual([{ sortKey: `opencode:${openCodeRuntimeNamespaceKey("local", "/native/opencode.db")}`,
      namespaceKey: openCodeRuntimeNamespaceKey("local", "/native/opencode.db") }]);
    const fixture = context(); const runtime = prepared.createRuntime(fixture.value);
    await runtime.start();
    expect(factory.create).not.toHaveBeenCalled();
    expect(await runtime.startupEnvironmentState!()).toBe("not_started");
    expect(runtime.driverFactory.supportsConversationCreation).toBe(true);
    expect(runtime.driverFactory.creationIdentity).toMatchObject({ assignment: "application", createReplay: "idempotent" });
    expect(runtime.savedAgents.presentation).toMatchObject({ brand: "opencode", typeId: "opencode" });
    expect(runtime.bindingDetails).toBe(runtime.threadPersistence);
    expect(runtime.discoveryPersistence).toBe(runtime.threadPersistence);
    expect(runtime.discovery.nativeNamespaceKey(fixture.connection)).toBe(prepared.nativeNamespaces[0]!.namespaceKey);
    expect(runtime.installationAdvisories.active()).toEqual([]);
    const driver = runtime.driverFactory.create(fixture.connection);
    await expect(driver.catalog({} as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(driver.create({} as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(driver.attach({ scope: { ...scope, principalId: "another-principal" } } as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(runtime.savedAgents.validateOverrides({ overrides: [] })).toMatchObject({ backendTypeId: "opencode", overrides: [] });
    expect(() => runtime.automationExecutionPolicy.assertCanAutomate(scope, "thread")).toThrow();
    await expect(runtime.managedProviderTerminals.authorizeAdmission({} as never)).rejects.toMatchObject({ code: "terminal_unavailable" });
    expect(factory.create).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("checks scope and topology without borrowing another connection's runtime", async () => {
    const factory = nativeFactory(); const module = new OpenCodeBackendModule(factory.create);
    const prepared = module.prepare(configuration()); const fixture = context();
    expect(() => prepared.createRuntime({ ...fixture.value, scope: { ...scope, principalId: "other" } })).toThrow();
    const runtime = prepared.createRuntime(fixture.value);
    expect(() => prepared.createRuntime(fixture.value)).toThrow();
    for (const change of [{ ownerPrincipalId: "other" }, { tenantId: "other" }, { executionEnvironmentId: "other" },
      { backendInstanceId: "other" }, { configurationRevision: 2 }, { enabled: false }]) {
      expect(() => runtime.driverFactory.create({ ...fixture.connection, ...change })).toThrow();
    }
    expect(factory.create).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("retains bounded lazy health diagnostics, clears them on success, and ignores older completions", async () => {
    const fixture = context(), factory = nativeFactory();
    const runtime = new OpenCodeBackendModule(factory.create).prepare(configuration()).createRuntime(fixture.value);
    expect(runtime.runtimeDiagnostic?.()).toBeUndefined();
    expect(factory.create).not.toHaveBeenCalled();
    const driver = runtime.driverFactory.create(fixture.connection);
    await driver.health();
    const owner = factory.instances[0]!;
    owner.start.mockRejectedValueOnce(new OpenCodeRuntimeError("opencode_native_store_already_owned"));
    const failed = await driver.health();
    expect(failed).toMatchObject({ available: false, diagnostic: { text: expect.stringContaining("opencode-owner inspect") } });
    expect(runtime.runtimeDiagnostic?.()).toMatchObject({ connectionState: "recovery_required" });
    await driver.health();
    expect(runtime.runtimeDiagnostic?.()).toBeUndefined();
    let entered!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    owner.start.mockImplementationOnce(() => { entered(); return new Promise<void>((_resolve, fail) => { reject = fail; }); });
    const old = driver.health(); await started;
    await driver.health();
    reject(new OpenCodeRuntimeError("opencode_native_store_already_owned")); await old;
    expect(runtime.runtimeDiagnostic?.()).toBeUndefined();
    await runtime.close();
  });

  it("starts the owner lazily and requires explicit confirmation for unknown activity", async () => {
    const factory = nativeFactory(); const fixture = context();
    const runtime = new OpenCodeBackendModule(factory.create).prepare(configuration()).createRuntime(fixture.value);
    const driver = runtime.driverFactory.create(fixture.connection);
    expect(await driver.health()).toMatchObject({ available: true });
    expect(await runtime.startupEnvironmentState!()).toBe("started");
    expect(factory.create).toHaveBeenCalledOnce();
    const state = await runtime.administration!.inspect();
    expect(state).toMatchObject({ state: "active", blockers: ["unknown_state"] });
    expect(state.activity).toBeUndefined();
    await expect(runtime.administration!.stop({ expectedRevision: state.revision, force: false })).rejects.toMatchObject({ reason: "blocked" });
    expect(factory.instances[0]!.stop).not.toHaveBeenCalled();
    await runtime.administration!.stop({ expectedRevision: state.revision, force: true });
    expect(factory.instances[0]!.stop).toHaveBeenCalledOnce();
    expect(await runtime.administration!.inspect()).toMatchObject({ blockers: ["unsettled_outcome"] });
    await runtime.stopBeforeConversationCleanup!();
    expect(await runtime.administration!.inspect()).toMatchObject({ blockers: ["unsettled_outcome"] });
    await expect(runtime.administration!.restart({ expectedRevision: state.revision, force: true })).rejects.toMatchObject({ reason: "confirmation_stale" });
    const stopped = await runtime.administration!.inspect();
    await runtime.administration!.restart({ expectedRevision: stopped.revision, force: true });
    expect(await runtime.administration!.inspect()).toMatchObject({ state: "active", blockers: ["unknown_state"] });
    await runtime.close(); await runtime.close();
    expect(factory.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("resolves external Basic credentials lazily and closes only the client", async () => {
    const factory = nativeFactory(); const fixture = context();
    const runtime = new OpenCodeBackendModule(factory.create).prepare(configuration("external")).createRuntime(fixture.value);
    expect(runtime.administration).toBeUndefined();
    expect(runtime.stopBeforeConversationCleanup).toBeUndefined();
    expect(fixture.resolveSecret).not.toHaveBeenCalled();
    const driver = runtime.driverFactory.create(fixture.connection);
    expect(await driver.health()).toMatchObject({ available: true });
    expect(fixture.resolveSecret).toHaveBeenCalledWith(authority, { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" }, 1, expect.any(AbortSignal), "http_basic_password");
    expect(fixture.discard).toHaveBeenCalledOnce();
    await runtime.close();
    expect(factory.instances[0]!.close).toHaveBeenCalledOnce();
    expect(factory.instances[0]!.stop).not.toHaveBeenCalled();
  });

  it("reports an unverified partial store lease as a typed Restart rejection", async () => {
    const factory = nativeFactory(); const fixture = context();
    const runtime = new OpenCodeBackendModule(factory.create).prepare(configuration()).createRuntime(fixture.value);
    await runtime.driverFactory.create(fixture.connection).health();
    const owner = factory.instances[0]!;
    owner.start.mockRejectedValueOnce(new OpenCodeRuntimeError("opencode_native_store_initialization_unproved"));
    const state = await runtime.administration!.inspect();
    await expect(runtime.administration!.restart({ expectedRevision: state.revision, force: true }))
      .rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason: "cleanup_unproven" });
    await runtime.close();
  });

  it("reports unproved owned cleanup as a typed administration rejection", async () => {
    const factory = nativeFactory(); const fixture = context();
    const runtime = new OpenCodeBackendModule(factory.create).prepare(configuration()).createRuntime(fixture.value);
    await runtime.driverFactory.create(fixture.connection).health();
    const owner = factory.instances[0]!;
    for (const action of ["stop", "restart"] as const) {
      owner.stop.mockRejectedValueOnce(new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"));
      const state = await runtime.administration!.inspect();
      await expect(runtime.administration![action]({ expectedRevision: state.revision, force: true }))
        .rejects.toMatchObject({ reason: "cleanup_unproven" });
    }
    expect(owner.start).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("retains disabled configuration without namespace claims and rejects unknown protocol releases", () => {
    const module = new OpenCodeBackendModule(); const input = configuration();
    const disabled = { ...input, backend: { ...input.backend, enabled: false }, connections: input.connections.map(connection => ({ ...connection, enabled: false })) };
    expect(module.prepare(disabled).nativeNamespaces).toEqual([]);
    expect(() => module.prepare({ ...input, backend: { ...input.backend, protocolRelease: "2.0.19" } })).toThrow("opencode_protocol_release_invalid");
  });
});
