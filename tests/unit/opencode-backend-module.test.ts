import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeBackendModule } from "../../src/server/backends/opencode/opencode-backend-module.js";
import { openCodeRuntimeNamespaceKey, type OpenCodeRuntimeInput, type OpenCodeRuntimeSnapshot } from "../../src/server/backends/opencode/opencode-runtime.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { BackendModuleCatalog } from "../../src/server/backends/module-catalog.js";
import type { BackendModuleConfigurationInput, BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
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
  const connection = { id: "profile", ...scope, ownerPrincipalId: scope.principalId, templateId: "profile-template", kind: "opencode_http" as const,
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

describe("OpenCode M1 private module foundation", () => {
  it("is available only through an explicit test catalog and does not start during preparation", async () => {
    expect(compiledBackendModuleCatalog.moduleForBackendKind("opencode")).toBeUndefined();
    expect(compiledBackendModuleCatalog.moduleForConnectionKind("opencode_http")).toBeUndefined();
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
    expect(runtime.driverFactory.supportsConversationCreation).toBe(false);
    expect(runtime.driverFactory.creationIdentity).toBeUndefined();
    expect(runtime.savedAgents.presentation).toMatchObject({ brand: "opencode", typeId: "opencode" });
    expect(runtime.bindingDetails).toBe(runtime.threadPersistence);
    expect(runtime.discoveryPersistence).toBe(runtime.threadPersistence);
    expect(runtime.discovery.nativeNamespaceKey(fixture.connection)).toBe(prepared.nativeNamespaces[0]!.namespaceKey);
    expect(runtime.installationAdvisories.active()).toEqual([]);
    const driver = runtime.driverFactory.create(fixture.connection);
    await expect(driver.catalog({} as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(driver.create({} as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(driver.attach({} as never)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(() => runtime.savedAgents.validateOverrides({ overrides: [] })).toThrow(/unavailable/u);
    expect(() => runtime.automationExecutionPolicy.assertCanAutomate(scope, "thread")).toThrow(/unavailable/u);
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
