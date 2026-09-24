import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { PiBackendModule } from "../../src/server/backends/pi/pi-backend-module.js";
import { PiBackendDriverFactory } from "../../src/server/backends/pi/pi-driver-factory.js";
import { resolveRemotePiStorage } from "../../src/server/backends/pi/pi-storage.js";
import { lockIdentity } from "../../src/server/security/locks.js";
import { planBackendNativeStores } from "../../src/server/runtime/backend-module-startup.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import type { BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const scope = Object.freeze({ tenantId: "tenant", principalId: "principal" });
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;
const instance: AgentBackendInstance = Object.freeze({
  id: "pi-instance",
  tenantId: scope.tenantId,
  kind: "pi",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.86.0",
});
const connection: AgentConnectionProfile = Object.freeze({
  id: "pi-connection",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "pi-template",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "environment",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
});

const unavailableEnvironmentOperations = Object.freeze({
  environmentId: "environment",
  environmentKind: "local" as const,
  environmentLabel: "Local",
  workspaceTools: {
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  },
  workspaceContext: {
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  },
  workspaceSkills: {
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  },
});

describe("Pi backend module", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("retains a structurally valid disabled backend on an incompatible release", () => {
    const prepared = new PiBackendModule().prepare({
      backend: {
        id: instance.id,
        kind: "pi",
        protocolRelease: "0.82.0",
        enabled: false,
        modelPolicy: { type: "catalog" },
      },
      connections: [
        {
          id: connection.id,
          kind: "pi_sdk",
          backendInstanceId: instance.id,
          executionEnvironmentId: connection.executionEnvironmentId,
          enabled: false,
        },
      ],
      executionEnvironments: [{ id: "environment", kind: "local" }],
      environment: {},
    });

    expect(prepared.nativeNamespaces).toEqual([]);
    expect(prepared.nativeStores).toEqual([]);

    expect(() =>
      new PiBackendModule().prepare({
        backend: {
          id: instance.id,
          kind: "pi",
          protocolRelease: "0.82.0",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
        connections: [],
        executionEnvironments: [],
        environment: {},
      }),
    ).toThrow("pi_backend_configuration_invalid");
  });

  it("disposes the runtime-owned discovery snapshot store exactly once", async () => {
    const closeFactory = vi.spyOn(PiBackendDriverFactory.prototype, "close");
    const prepared = new PiBackendModule().prepare({
      backend: {
        id: instance.id,
        kind: "pi",
        protocolRelease: "0.86.0",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      connections: [
        {
          id: connection.id,
          kind: "pi_sdk",
          backendInstanceId: instance.id,
          executionEnvironmentId: connection.executionEnvironmentId,
          enabled: true,
        },
      ],
      executionEnvironments: [{ id: "environment", kind: "local" }],
      environment: {
        PI_CODING_AGENT_DIR: "/tmp/sedes-pi-module-agent",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/sedes-pi-module-sessions",
      },
    });
    const context = {
      usage: NO_USAGE_SINK,
      database: {} as Database.Database,
      scope,
      instance,
      connections: [connection],
      environmentChannel:
        {} as BackendModuleRuntimeContext["environmentChannel"],
      environmentOperations: unavailableEnvironmentOperations,
      toolProvenanceKey: new Uint8Array(32).fill(0x42),
      outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
      agentTools: {
        eligibleCatalog: () => [],
        catalogSummaries: () => [],
        describeMany: () => [],
        readPolicy: () => ({
          enabled: false,
          presentation: {
            surface: "native" as const,
            mode: "individual" as const,
          },
          accessBoundary: "environment" as const,
          enabledToolIds: [],
        }),
        invoke: async () => {
          throw new Error("unexpected_agent_tool_invocation");
        },
      },
      agentToolSourceCapabilities,
      agentToolCli: {
        availability: "unavailable" as const,
        reason: "remote_environment" as const,
      },
    } satisfies BackendModuleRuntimeContext;
    const runtime = prepared.createRuntime(context);

    expect(runtime.savedAgents).toMatchObject({
      typeId: "pi",
      backendKind: "pi",
      presentation: {
        typeId: "pi",
        label: { text: "Pi SDK" },
        brand: "pi",
      },
      overrideSchemaVersion: 1,
    });
    expect(runtime.installationAdvisories.active()).toEqual([]);
    await expect(
      runtime.actionPersistence.afterInterruptAccepted({}),
    ).resolves.toBe(false);

    await runtime.close();
    await runtime.close();

    expect(closeFactory).toHaveBeenCalledOnce();
    closeFactory.mockRestore();
  });

  it.each(["ssh", "outbound"] as const)("plans and locks an isolated %s store before runtime without starting its sidecar", async (kind) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-pi-remote-store-"),
    );
    temporaryDirectories.push(root);
    const stateDirectory = path.join(root, "state");
    const prepared = new PiBackendModule().prepare({
      backend: {
        id: instance.id,
        kind: "pi",
        protocolRelease: "0.86.0",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      connections: [
        {
          id: connection.id,
          kind: "pi_sdk",
          backendInstanceId: instance.id,
          executionEnvironmentId: connection.executionEnvironmentId,
          enabled: true,
        },
      ],
      executionEnvironments: [{ id: "environment", kind }],
      environment: {
        APP_STATE_DIR: stateDirectory,
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "local-sessions"),
        XDG_RUNTIME_DIR: path.join(root, "runtime"),
      },
    });

    expect(prepared.nativeStores).toHaveLength(1);
    const expectedStorage = resolveRemotePiStorage(
      {
        installationStateDirectory: stateDirectory,
        backendInstanceId: instance.id,
        executionEnvironmentId: connection.executionEnvironmentId,
      },
      { PI_CODING_AGENT_DIR: path.join(root, "agent") },
    );
    expect(prepared.nativeStores[0]).toMatchObject({
      namespaceKey: lockIdentity(expectedStorage.sessionDirectory),
      sortKey: `pi\0${lockIdentity(expectedStorage.sessionDirectory)}`,
    });
    const lease = await prepared.nativeStores[0]!.acquire();
    const remoteStore = path.join(
      stateDirectory,
      "remote-pi-native-sessions",
      "v1",
    );
    expect(await realpath(remoteStore)).toBe(remoteStore);
    expect(expectedStorage.sessionDirectory).not.toBe(
      path.join(root, "local-sessions"),
    );

    let channelTouched = false;
    const runtime = prepared.createRuntime({
      usage: NO_USAGE_SINK,
      database: {} as Database.Database,
      scope,
      instance,
      connections: [connection],
      environmentChannel: new Proxy(
        {},
        {
          get() {
            channelTouched = true;
            throw new Error("history_only_started_sidecar");
          },
        },
      ) as BackendModuleRuntimeContext["environmentChannel"],
      environmentOperations: {
        environmentId: "environment",
        environmentKind: kind,
        environmentLabel: "Remote",
        workspaceTools: {
          availability: "available",
          implementation: "sidecar",
          forWorkspace: () => {
            throw new Error("passive_history_started_sidecar_tools");
          },
        },
        workspaceContext: {
          availability: "available",
          implementation: "sidecar",
          forWorkspace: () => {
            throw new Error("passive_history_started_sidecar_context");
          },
        },
        workspaceSkills: {
          availability: "unavailable",
          reason: "not_configured",
        },
      },
      toolProvenanceKey: new Uint8Array(32).fill(0x42),
      outputArtifacts: {} as BackendModuleRuntimeContext["outputArtifacts"],
      agentTools: {
        eligibleCatalog: () => [],
        catalogSummaries: () => [],
        describeMany: () => [],
        readPolicy: () => ({
          enabled: false,
          presentation: {
            surface: "native" as const,
            mode: "individual" as const,
          },
          accessBoundary: "environment" as const,
          enabledToolIds: [],
        }),
        invoke: async () => {
          throw new Error("unexpected_agent_tool_invocation");
        },
      },
      agentToolSourceCapabilities,
      agentToolCli: {
        availability: "unavailable",
        reason: "remote_environment",
      },
    });
    runtime.driverFactory.create(connection);
    expect(channelTouched).toBe(false);

    await runtime.close();
    await lease.release();
  });

  it("rejects a configured local Pi store that overlaps a remote namespace before acquisition", () => {
    const stateDirectory = "/var/lib/sedes";
    const remoteEnvironmentId = "11111111-1111-4111-8111-111111111111";
    const remoteStorage = resolveRemotePiStorage(
      {
        installationStateDirectory: stateDirectory,
        backendInstanceId: "pi-remote",
        executionEnvironmentId: remoteEnvironmentId,
      },
      { PI_CODING_AGENT_DIR: "/var/lib/pi-agent" },
    );
    const remote = new PiBackendModule().prepare({
      backend: {
        id: "pi-remote",
        kind: "pi",
        protocolRelease: "0.86.0",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      connections: [
        {
          id: "remote-target",
          kind: "pi_sdk",
          backendInstanceId: "pi-remote",
          executionEnvironmentId: remoteEnvironmentId,
          enabled: true,
        },
      ],
      executionEnvironments: [{ id: remoteEnvironmentId, kind: "ssh" }],
      environment: { APP_STATE_DIR: stateDirectory },
    });
    const local = new PiBackendModule().prepare({
      backend: {
        id: "pi-local",
        kind: "pi",
        protocolRelease: "0.86.0",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      connections: [
        {
          id: "local-target",
          kind: "pi_sdk",
          backendInstanceId: "pi-local",
          executionEnvironmentId: "local-environment",
          enabled: true,
        },
      ],
      executionEnvironments: [{ id: "local-environment", kind: "local" }],
      environment: {
        PI_CODING_AGENT_DIR: "/var/lib/pi-agent",
        PI_CODING_AGENT_SESSION_DIR: remoteStorage.sessionDirectory,
      },
    });

    expect(() => planBackendNativeStores([remote, local])).toThrow(
      "backend_native_namespace_reused",
    );
  });
});
