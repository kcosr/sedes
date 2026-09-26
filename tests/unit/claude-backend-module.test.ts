import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeBackendModule } from "../../src/server/backends/claude/claude-backend-module.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import type { BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

function fakeSdk(): ClaudeSdkFacade {
  return {
    readCliRelease: vi.fn(async () => "2.1.274"),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    })),
    createQuery: vi.fn(() => {
      throw new Error("not expected");
    }),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: crypto.randomUUID() })),
  } as unknown as ClaudeSdkFacade;
}

function moduleWithSdk(sdk: ClaudeSdkFacade): ClaudeBackendModule {
  const client = new ClaudeSdkRuntimeAdapter(sdk);
  return new ClaudeBackendModule({
    createRuntimeClient: () => ({ client, close: () => undefined }),
  });
}

function configuration(
  executablePath = process.execPath,
  configDirectory = "/tmp/sedes-claude-config",
) {
  return {
    backend: {
      id: "claude-local",
      kind: "claude_agent_sdk" as const,
      protocolRelease: "0.3.274",
      enabled: true,
      modelPolicy: { type: "catalog" as const },
      moduleConfiguration: {
        executablePath,
        configDirectory,
        permissionPolicy: {
          allowedModes: [
            "default",
            "acceptEdits",
            "dontAsk",
            "auto",
            "bypassPermissions",
          ],
        },
      },
    },
    connections: [
      {
        id: "claude-target",
        kind: "claude_agent_sdk" as const,
        backendInstanceId: "claude-local",
        executionEnvironmentId: "environment-1",
        enabled: true,
        moduleConfiguration: { defaults: { permissionMode: "default" } },
      },
    ],
    executionEnvironments: [{ id: "environment-1", kind: "local" as const }],
    environment: {},
  };
}

describe("ClaudeBackendModule", () => {
  it("retains a structurally valid disabled backend without native claims", () => {
    const input = configuration();
    input.backend.enabled = false;
    input.connections[0]!.enabled = false;

    const prepared = moduleWithSdk(fakeSdk()).prepare(input);

    expect(prepared.nativeNamespaces).toEqual([]);
    expect(prepared.nativeStores).toEqual([]);
  });

  it.each(["ssh", "outbound"] as const)("prepares enabled %s Claude without opening provider authority", (kind) => {
    const sdk = fakeSdk();
    const input = configuration();
    const prepared = moduleWithSdk(sdk).prepare({
      ...input,
      executionEnvironments: [{ id: "environment-1", kind }],
    });
    expect(prepared.nativeNamespaces).toHaveLength(1);
    expect(prepared.nativeStores).toEqual([]);
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing configured execution environment", () => {
    expect(() => moduleWithSdk(fakeSdk()).prepare({
      ...configuration(), executionEnvironments: [],
    })).toThrow("claude_external_execution_environment_invalid");
  });

  it("scopes the native default namespace to the execution environment without reading the main home", () => {
    const module = moduleWithSdk(fakeSdk());
    const input = configuration();
    const { configDirectory: _directory, ...moduleConfiguration } = input.backend.moduleConfiguration;
    const defaults = {
      ...input,
      backend: { ...input.backend, moduleConfiguration },
      environment: { HOME: "/main/home", CLAUDE_CONFIG_DIR: "/main/claude" },
      executionEnvironments: [{ id: "environment-1", kind: "ssh" as const }],
    };
    const prepared = module.prepare(defaults);
    expect(prepared.nativeNamespaces).toHaveLength(1);
    expect(module.prepare({ ...defaults, environment: { HOME: "/different/main" } }).nativeNamespaces)
      .toEqual(prepared.nativeNamespaces);
    expect(module.prepare({
      ...defaults,
      connections: defaults.connections.map(connection => ({ ...connection, executionEnvironmentId: "environment-2" })),
      executionEnvironments: [{ id: "environment-2", kind: "ssh" }],
    }).nativeNamespaces).not.toEqual(prepared.nativeNamespaces);
    expect(module.prepare(input).nativeNamespaces).not.toEqual(prepared.nativeNamespaces);
  });

  it.each(["ssh", "outbound"] as const)("rejects a %s runtime context for a prepared local target", (kind) => {
    const createRuntimeClient = vi.fn();
    const prepared = new ClaudeBackendModule({ createRuntimeClient })
      .prepare(configuration());
    expect(() => prepared.createRuntime({
      environmentOperations: { environmentKind: kind },
    } as BackendModuleRuntimeContext)).toThrow("claude_backend_runtime_context_invalid");
    expect(createRuntimeClient).not.toHaveBeenCalled();
  });

  it.each(["ssh", "outbound"] as const)("retains disabled %s definitions without native claims or local fallback", (kind) => {
    const input = configuration();
    const prepared = moduleWithSdk(fakeSdk()).prepare({
      ...input,
      backend: { ...input.backend, enabled: false },
      connections: input.connections.map((connection) => ({ ...connection, enabled: false })),
      executionEnvironments: [{ id: "environment-1", kind }],
    });
    expect(prepared.nativeNamespaces).toEqual([]);
    expect(prepared.nativeStores).toEqual([]);
    expect(() => prepared.createRuntime({} as BackendModuleRuntimeContext))
      .toThrow("claude_disabled_runtime_not_creatable");
  });

  it.each(["local", "ssh", "outbound"] as const)("is compiled and prepares an externally authenticated %s runtime", async (environmentKind) => {
    expect(
      compiledBackendModuleCatalog.moduleForBackendKind("claude_agent_sdk"),
    ).toBeInstanceOf(ClaudeBackendModule);

    const current = savedAgentDatabase();
    try {
      const sdk = fakeSdk();
      const prepared = moduleWithSdk(sdk).prepare(
        { ...configuration(), executionEnvironments: [{ id: "environment-1", kind: environmentKind }] },
      );
      expect(prepared.nativeStores).toEqual([]);
      expect(prepared.nativeNamespaces).toHaveLength(1);
      expect(prepared.nativeNamespaces[0]?.namespaceKey).toBe(
        `claude-agent-sdk:${createHash("sha256")
          .update("harness.claude-agent-sdk.external-discovery.v1\n")
          .update(JSON.stringify(["environment-1", "/tmp/sedes-claude-config"]))
          .digest("base64url")}`,
      );
      const instance = {
        id: "claude-local",
        tenantId: scope.tenantId,
        kind: "claude_agent_sdk" as const,
        label: "Claude",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.3.274",
      };
      const connection = {
        id: "claude-connection",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "claude-target",
        kind: "claude_agent_sdk" as const,
        backendInstanceId: instance.id,
        executionEnvironmentId: "environment-1",
        label: "Claude",
        enabled: true,
        configurationRevision: 0,
      };
      const context: BackendModuleRuntimeContext = {
        usage: NO_USAGE_SINK,
        database: current.database,
        scope,
        instance,
        connections: [connection],
        environmentChannel: {
          scope,
          executionEnvironmentId: "environment-1",
        } as BackendModuleRuntimeContext["environmentChannel"],
        ...(environmentKind !== "local" ? { sidecarRuntime: { acquire: vi.fn() } } : {}),
        environmentOperations: unavailableEnvironmentOperations({
          environmentId: "environment-1",
          environmentKind,
          environmentLabel: "Local",
        }),
        toolProvenanceKey: new Uint8Array(32),
        agentTools: {} as BackendModuleRuntimeContext["agentTools"],
        outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
        viewedImageCapture: {} as BackendModuleRuntimeContext["viewedImageCapture"],
        agentToolSourceCapabilities,
        agentToolCli: {
          availability: "unavailable",
          reason: "cli_unavailable",
        },
      };
      if (environmentKind !== "local") {
        expect(() => prepared.createRuntime({ ...context, sidecarRuntime: undefined }))
          .toThrow("claude_sidecar_runtime_required");
      } else {
        expect(() => prepared.createRuntime({ ...context, sidecarRuntime: { acquire: vi.fn() } }))
          .toThrow("claude_backend_runtime_context_invalid");
      }
      for (const wrongScope of [
        { ...scope, tenantId: "other-tenant" },
        { ...scope, principalId: "other-principal" },
      ]) {
        expect(() => prepared.createRuntime({ ...context, scope: wrongScope }))
          .toThrow("claude_backend_runtime_context_invalid");
      }
      expect(() => prepared.createRuntime({ ...context, environmentChannel: {
        ...context.environmentChannel, executionEnvironmentId: "other-environment",
      } })).toThrow("claude_backend_runtime_context_invalid");
      expect(() => prepared.createRuntime({ ...context, environmentOperations: {
        ...context.environmentOperations, environmentId: "other-environment",
      } })).toThrow("claude_backend_runtime_context_invalid");
      const acquireRecovery = vi.fn();
      for (const wrongScope of [
        { ...scope, tenantId: "other-tenant" },
        { ...scope, principalId: "other-principal" },
      ]) {
        await expect(prepared.recoverAdministration?.({
          database: current.database, scope: wrongScope, instance, connections: [connection],
          sidecarRuntime: { acquireRecovery },
        })).rejects.toThrow("claude_backend_runtime_context_invalid");
      }
      expect(acquireRecovery).not.toHaveBeenCalled();
      if (environmentKind !== "local") {
        acquireRecovery.mockRejectedValueOnce(new Error("recovery_carrier_unavailable"));
        await expect(prepared.recoverAdministration?.({
          database: current.database, scope, instance, connections: [connection],
          sidecarRuntime: { acquireRecovery },
        })).rejects.toThrow("recovery_carrier_unavailable");
        expect(acquireRecovery).toHaveBeenCalledOnce();
      }
      const runtime = prepared.createRuntime(context);

      await runtime.start();
      expect(sdk.createQuery).not.toHaveBeenCalled();
      expect(runtime.driverFactory.supportsConversationCreation).toBe(true);
      expect(runtime.driverFactory.creationIdentity?.assignment).toBe(
        "application",
      );
      expect(runtime.discovery.nativeNamespaceKey(connection)).toBe(
        prepared.nativeNamespaces[0]?.namespaceKey,
      );
      await expect(
        runtime.actionPersistence.afterInterruptAccepted({}),
      ).resolves.toBe(false);
      await expect(
        runtime.managedProviderTerminals.authorizeAdmission({
          scope,
          applicationThreadId: "thread-1",
        }),
      ).rejects.toMatchObject({ code: "terminal_unavailable" });
      await runtime.close();
    } finally {
      current.database.close();
    }
  });

  it("defers environment-owned executable validation and rejects invalid target config", () => {
    const module = moduleWithSdk(fakeSdk());
    expect(() => module.prepare(configuration("/missing/claude"))).not.toThrow();
    expect(() =>
      module.prepare({
        ...configuration(),
        connections: [
          {
            ...configuration().connections[0]!,
            moduleConfiguration: { apiKey: "forbidden" },
          },
        ],
      }),
    ).toThrow();
  });

  it("claims one shared external namespace and validates runtime identity", () => {
    const module = moduleWithSdk(fakeSdk());
    const prepared = module.prepare(configuration());
    const sameStoreConfiguration = configuration();
    sameStoreConfiguration.backend.id = "claude-other";
    sameStoreConfiguration.connections[0]!.backendInstanceId = "claude-other";
    const sameStore = module.prepare(sameStoreConfiguration);
    const otherStore = module.prepare(
      configuration(process.execPath, "/tmp/sedes-claude-other-config"),
    );

    expect(sameStore.nativeNamespaces).toEqual(prepared.nativeNamespaces);
    expect(otherStore.nativeNamespaces).not.toEqual(prepared.nativeNamespaces);
    expect(prepared.nativeStores).toEqual([]);

    const current = savedAgentDatabase();
    try {
      const instance = {
        id: "claude-local",
        tenantId: scope.tenantId,
        kind: "claude_agent_sdk" as const,
        label: "Claude",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.3.274",
      };
      const connection = {
        id: "claude-connection",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "claude-target",
        kind: "claude_agent_sdk" as const,
        backendInstanceId: instance.id,
        executionEnvironmentId: "environment-1",
        label: "Claude",
        enabled: false,
        configurationRevision: 0,
      };
      expect(() =>
        prepared.createRuntime({
          usage: NO_USAGE_SINK,
          database: current.database,
          scope,
          instance,
          connections: [connection],
          environmentChannel: {
            scope,
            executionEnvironmentId: "environment-1",
          } as BackendModuleRuntimeContext["environmentChannel"],
          environmentOperations: unavailableEnvironmentOperations({
            environmentId: "environment-1",
            environmentKind: "local",
            environmentLabel: "Local",
          }),
          toolProvenanceKey: new Uint8Array(32),
          agentTools: {} as BackendModuleRuntimeContext["agentTools"],
          outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
          viewedImageCapture: {} as BackendModuleRuntimeContext["viewedImageCapture"],
          agentToolSourceCapabilities,
          agentToolCli: {
            availability: "unavailable",
            reason: "cli_unavailable",
          },
        }),
      ).toThrow("claude_backend_runtime_context_invalid");
    } finally {
      current.database.close();
    }
  });
});
