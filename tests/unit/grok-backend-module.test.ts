import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { describe, expect, it } from "vitest";
import { GrokBackendModule } from "../../src/server/backends/grok/grok-backend-module.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import type { BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

function configuration(
  environment: Record<string, string> = { HOME: "/tmp/grok-home-owner" },
) {
  return {
    backend: {
      id: "grok-local",
      kind: "grok_build" as const,
      protocolRelease: "1.x",
      enabled: true,
      modelPolicy: { type: "catalog" as const },
      moduleConfiguration: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/grok/bin/grok",
            workingDirectoryPolicy: "workspace",
          },
        },
        authentication: { type: "native" },
        security: {
          profile: "unrestricted_v1",
          sandboxProfile: "off",
          networkAccess: "enabled",
          approvalMode: "full_access",
        },
      },
    },
    connections: [
      {
        id: "grok-target",
        kind: "grok_acp" as const,
        backendInstanceId: "grok-local",
        executionEnvironmentId: "environment-1",
        enabled: true,
        moduleConfiguration: {
          defaults: {
            model: { type: "catalogDefault" as const },
            reasoningEffort: { type: "modelDefault" as const },
          },
        },
      },
    ],
    executionEnvironments: [{ id: "environment-1", kind: "local" as const }],
    environment,
  };
}

describe("GrokBackendModule", () => {
  it.each(["ssh", "outbound"] as const)("rejects enabled %s execution without provider authority", (kind) => {
    expect(() => new GrokBackendModule().prepare({
      ...configuration(), executionEnvironments: [{ id: "environment-1", kind }],
    })).toThrow("grok_execution_environment_invalid");
  });

  it.each(["ssh", "outbound"] as const)("rejects %s runtime injection into a local target", (kind) => {
    const prepared = new GrokBackendModule().prepare(configuration());
    expect(() => prepared.createRuntime({ environmentOperations: { environmentKind: kind } } as BackendModuleRuntimeContext))
      .toThrow("grok_remote_execution_unsupported");
  });

  it("retains a structurally valid disabled backend without native claims", () => {
    const input = configuration();
    input.backend.enabled = false;
    input.connections[0]!.enabled = false;

    const prepared = new GrokBackendModule().prepare(input);

    expect(prepared.nativeNamespaces).toEqual([]);
    expect(prepared.nativeStores).toEqual([]);
  });

  it("is compiled, claims the native installation namespace, and starts lazily", async () => {
    expect(
      compiledBackendModuleCatalog.moduleForBackendKind("grok_build"),
    ).toBeInstanceOf(GrokBackendModule);
    expect(
      compiledBackendModuleCatalog.moduleForConnectionKind("grok_acp"),
    ).toBeInstanceOf(GrokBackendModule);

    const prepared = new GrokBackendModule().prepare(configuration());
    expect(prepared.nativeStores).toEqual([]);
    expect(prepared.nativeNamespaces).toHaveLength(1);
    expect(prepared.nativeNamespaces[0]?.namespaceKey).toMatch(/^grok:/u);

    const current = savedAgentDatabase();
    try {
      const instance = {
        id: "grok-local",
        tenantId: scope.tenantId,
        kind: "grok_build" as const,
        label: "Grok",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "1.x",
      };
      const connection = {
        id: "grok-connection",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "grok-target",
        kind: "grok_acp" as const,
        backendInstanceId: instance.id,
        executionEnvironmentId: "environment-1",
        label: "Grok",
        enabled: true,
        configurationRevision: 0,
      };
      const runtime = prepared.createRuntime({
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
        usage: NO_USAGE_SINK, outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
        agentToolSourceCapabilities,
        agentToolCli: {
          availability: "unavailable",
          reason: "cli_unavailable",
        },
      });
      await runtime.start();
      expect(runtime.driverFactory.creationIdentity?.assignment).toBe(
        "provider",
      );
      expect(runtime.savedAgents.presentation).toMatchObject({
        typeId: "grok",
        brand: "grok",
      });
      expect(runtime.discovery.nativeNamespaceKey(connection)).toBe(
        prepared.nativeNamespaces[0]?.namespaceKey,
      );
      expect(() =>
        runtime.automationExecutionPolicy.assertCanAutomate(scope, "thread-1"),
      ).toThrow(/not supported/u);
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

  it("derives namespace identity from effective native home without creating it", () => {
    const module = new GrokBackendModule();
    const first = module.prepare(configuration({ HOME: "/tmp/one" }));
    const same = module.prepare(
      configuration({ HOME: "/tmp/other", GROK_HOME: "/tmp/grok-explicit" }),
    );
    const explicitAgain = module.prepare(
      configuration({ HOME: "/tmp/one", GROK_HOME: "/tmp/grok-explicit" }),
    );
    expect(first.nativeNamespaces).not.toEqual(same.nativeNamespaces);
    expect(same.nativeNamespaces).toEqual(explicitAgain.nativeNamespaces);
  });

  it("rejects duplicate runtime connection template identities", () => {
    const configured = configuration();
    configured.connections.push({
      ...configured.connections[0]!,
      id: "grok-target-2",
    });
    const prepared = new GrokBackendModule().prepare(configured);
    const current = savedAgentDatabase();
    try {
      const instance = {
        id: "grok-local",
        tenantId: scope.tenantId,
        kind: "grok_build" as const,
        label: "Grok",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "1.x",
      };
      const connection = {
        id: "grok-connection-1",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "grok-target",
        kind: "grok_acp" as const,
        backendInstanceId: instance.id,
        executionEnvironmentId: "environment-1",
        label: "Grok",
        enabled: true,
        configurationRevision: 0,
      };
      expect(() =>
        prepared.createRuntime({
          database: current.database,
          scope,
          instance,
          connections: [connection, { ...connection, id: "grok-connection-2" }],
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
          usage: NO_USAGE_SINK, outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
          agentToolSourceCapabilities,
          agentToolCli: {
            availability: "unavailable",
            reason: "cli_unavailable",
          },
        }),
      ).toThrow("grok_backend_runtime_context_invalid");
    } finally {
      current.database.close();
    }
  });
});
