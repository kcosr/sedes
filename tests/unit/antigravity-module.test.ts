import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityBackendModule } from "../../src/server/backends/antigravity/module.js";
import { ANTIGRAVITY_PROTOCOL_RELEASE } from "../../src/server/backends/antigravity/release-profile.js";
import { AntigravityDriver } from "../../src/server/backends/antigravity/driver.js";
import type { AntigravityPort } from "../../src/server/backends/antigravity/port.js";
import type { BackendModuleConfigurationInput, BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import type { AgentBackendInstance, AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { planBackendNativeStores } from "../../src/server/runtime/backend-module-startup.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function configuration(backendId = "backend", geminiDirectory?: string, environmentId = "environment"): BackendModuleConfigurationInput {
  return { backend: { id: backendId, kind: "antigravity", protocolRelease: ANTIGRAVITY_PROTOCOL_RELEASE, enabled: true, modelPolicy: { type: "catalog" },
    moduleConfiguration: { initializationTimeoutMs: 30_000, ...(geminiDirectory === undefined ? {} : { geminiDirectory }) } },
    connections: [{ id: "target", kind: "antigravity_acp", backendInstanceId: backendId, executionEnvironmentId: environmentId, enabled: true, moduleConfiguration: { defaults: {} } }],
    executionEnvironments: [{ id: environmentId, kind: "ssh" }], environment: {} };
}
function fixture(geminiDirectory?: string) {
  const database = new Database(":memory:"); cleanup.push(async () => database.close());
  const scope = { tenantId: "tenant", principalId: "principal" };
  const instance: AgentBackendInstance = { id: "backend", tenantId: scope.tenantId, kind: "antigravity", label: "Antigravity", enabled: true,
    configurationRevision: 0, protocolRelease: ANTIGRAVITY_PROTOCOL_RELEASE };
  const connection: AgentConnectionProfile = { id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, backendInstanceId: instance.id,
    templateId: "target", executionEnvironmentId: "environment", kind: "antigravity_acp", label: "Target", enabled: true, configurationRevision: 0 };
  const release = vi.fn(), acquire = vi.fn(async () => ({ availability: "available" as const, endpoint: "unix:///tmp/sedes-module-test.sock", executableDirectory: "/host/bin",
    inheritedPath: "/usr/bin", closed: new Promise(() => {}), release }));
  const context: BackendModuleRuntimeContext = { database, scope, instance, connections: [connection], usage: NO_USAGE_SINK,
    environmentOperations: unavailableEnvironmentOperations({ environmentId: "environment", environmentKind: "ssh", environmentLabel: "Host" }),
    environmentChannel: { scope, executionEnvironmentId: "environment" } as BackendModuleRuntimeContext["environmentChannel"],
    sidecarRuntime: { acquire: vi.fn(), acquireExisting: vi.fn() }, toolProvenanceKey: new Uint8Array(32).fill(7),
    outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"], viewedImageCapture: {} as BackendModuleRuntimeContext["viewedImageCapture"],
    agentToolSourceCapabilities: { issue: vi.fn(() => "scoped-source-capability") },
    agentToolCli: { availability: "managed", provider: { acquire } },
    agentTools: { eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [], readPolicy: () => ({ enabled: true,
      presentation: { surface: "native", mode: "progressive" }, enabledToolIds: ["thread.status"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } }),
      invoke: vi.fn() },
  };
  const closePort = vi.fn(async () => {}), port = { close: closePort } as unknown as AntigravityPort;
  const createPort = vi.fn(() => port), module = new AntigravityBackendModule(createPort), prepared = module.prepare(configuration("backend", geminiDirectory));
  const runtime = prepared.createRuntime(context); cleanup.push(() => runtime.close());
  const driver = runtime.driverFactory.create(connection) as AntigravityDriver;
  const lease = () => driver.input.agentTools!.prepareLaunch({ scope, applicationThreadId: "thread", workspaceId: "workspace", executionEnvironmentId: "environment" });
  return { runtime, driver, closePort, release, acquire, lease, createPort, prepared };
}

describe("Antigravity module ownership", () => {
  it("reserves one owner per environment across default, explicit and aliased profile paths", () => {
    const createPort = vi.fn(), module = new AntigravityBackendModule(createPort);
    const profiles = [undefined, "/host/.gemini", "/host/profile-link", "/another/profile"];
    for (const directory of profiles) {
      const first = module.prepare(configuration("first")), second = module.prepare(configuration("second", directory));
      expect(first.nativeNamespaces).toEqual(second.nativeNamespaces);
      expect(() => planBackendNativeStores([first, second])).toThrow("backend_native_namespace_reused");
    }
    expect(() => planBackendNativeStores([module.prepare(configuration("first")), module.prepare(configuration("second", undefined, "other-host"))])).not.toThrow();
    expect(createPort).not.toHaveBeenCalled();
  });
  it("allows multiple targets and leaves disabled backends without ownership claims", () => {
    const module = new AntigravityBackendModule(), input = configuration();
    const multiple = module.prepare({ ...input, connections: [...input.connections, { ...input.connections[0]!, id: "other-target", moduleConfiguration: { defaults: { modelId: "different" } } }] });
    expect(multiple.nativeNamespaces).toHaveLength(1);
    expect(module.prepare({ ...input, backend: { ...input.backend, enabled: false }, connections: input.connections.map(connection => ({ ...connection, enabled: false })) }).nativeNamespaces).toEqual([]);
    expect(module.prepare({ ...input, backend: { ...input.backend, enabled: false }, connections: [] }).nativeNamespaces).toEqual([]);
  });
  it("keeps binding namespace sensitive to profile changes under the broad owner reservation", () => {
    const first = fixture(), second = fixture("/different/profile");
    expect(first.prepared.nativeNamespaces).toEqual(second.prepared.nativeNamespaces);
    expect(first.driver.nativeBinding("4c8ece79-6741-451f-8aa5-e01d576ed055", "/workspace").nativeNamespaceKey)
      .not.toEqual(second.driver.nativeBinding("4c8ece79-6741-451f-8aa5-e01d576ed055", "/workspace").nativeNamespaceKey);
  });
  it("closes the owner despite a driver failure, then retries releases before dropping endpoint authority", async () => {
    const f = fixture(); await f.lease(); let ownerClosed = false;
    f.closePort.mockImplementation(async () => { ownerClosed = true; });
    const closeDriver = vi.spyOn(f.driver, "close").mockImplementation(async () => { if (!ownerClosed) throw new Error("handle_release_failed"); });
    f.release.mockImplementation(() => { expect(ownerClosed).toBe(true); expect(closeDriver).toHaveBeenCalledTimes(2); });
    await f.runtime.close(); expect(f.closePort).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });
  it("retains endpoint authority after unproven owner cleanup and retries the same owner", async () => {
    const f = fixture(); await f.lease();
    f.closePort.mockRejectedValueOnce(new Error("owner_cleanup_unproven"));
    const closeDriver = vi.spyOn(f.driver, "close").mockRejectedValueOnce(new Error("handle_release_failed")).mockResolvedValue(undefined);
    await expect(f.runtime.close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.closePort).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
    expect(await f.lease()).toMatchObject({ endpoint: "unix:///tmp/sedes-module-test.sock" }); expect(f.acquire).toHaveBeenCalledOnce();
    await f.runtime.close(); expect(f.closePort).toHaveBeenCalledTimes(2); expect(closeDriver).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledOnce();
  });
});
