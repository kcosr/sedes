import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendModuleRuntime,
  BackendModuleRuntimeContext,
  BackendNativeStoreLifecycle,
  PreparedBackendModule,
} from "../../src/server/backends/module.js";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../../src/server/backends/contracts.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import type Database from "better-sqlite3";
import {
  acquireBackendNativeStores,
  initializeBackendModuleRuntimes,
  planBackendNativeStores,
  startBackendModuleRuntime,
} from "../../src/server/runtime/backend-module-startup.js";

const AGENT_TOOL_CLI = new Map([
  [
    "environment-1",
    Object.freeze({
      availability: "available" as const,
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "/tmp/sedes-cli",
      inheritedPath: "/usr/bin",
    }),
  ],
]);
import { StartupResourceStack } from "../../src/server/runtime/startup-resource-stack.js";
import { LateBoundBackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

const ENVIRONMENT_OPERATIONS = new Map([
  [
    "environment-1",
    unavailableEnvironmentOperations({
      environmentId: "environment-1",
      environmentKind: "local",
      environmentLabel: "Local",
    }),
  ],
]);

function prepared(
  backendInstanceId: string,
  nativeStores: readonly BackendNativeStoreLifecycle[],
): PreparedBackendModule {
  return {
    backendInstanceId,
    nativeNamespaces: nativeStores.map(({ sortKey, namespaceKey }) => ({
      sortKey,
      namespaceKey,
    })),
    nativeStores,
  } as unknown as PreparedBackendModule;
}

function store(
  input: Partial<BackendNativeStoreLifecycle> & {
    readonly namespaceKey: string;
    readonly sortKey: string;
  },
): BackendNativeStoreLifecycle {
  return {
    label: input.namespaceKey,
    acquire: input.acquire ?? vi.fn(async () => ({ release: vi.fn() })),
    ...input,
  };
}

function runtime(
  id: string,
  start: () => Promise<void>,
  close: () => Promise<void>,
): BackendModuleRuntime {
  return {
    instance: { id },
    start,
    close,
  } as BackendModuleRuntime;
}

describe("backend module startup", () => {
  it("deduplicates one instance's namespace and sorts the lock plan", () => {
    const second = store({ namespaceKey: "second", sortKey: "b" });
    const first = store({ namespaceKey: "first", sortKey: "a" });
    const duplicate = store({ namespaceKey: "first", sortKey: "a" });

    expect(
      planBackendNativeStores([
        prepared("backend-a", [second, first, duplicate]),
      ]),
    ).toEqual([first, second]);
  });

  it("rejects a native namespace claimed by two backend instances", () => {
    const first = store({ namespaceKey: "shared", sortKey: "a" });
    const second = store({ namespaceKey: "shared", sortKey: "a" });

    expect(() =>
      planBackendNativeStores([
        prepared("backend-a", [first]),
        prepared("backend-b", [second]),
      ]),
    ).toThrow("backend_native_namespace_reused");
    expect(first.acquire).not.toHaveBeenCalled();
    expect(second.acquire).not.toHaveBeenCalled();
  });

  it("rejects namespace reuse even when an external backend acquires no lock", () => {
    const namespace = { namespaceKey: "shared", sortKey: "codex:shared" };
    expect(() =>
      planBackendNativeStores([
        {
          backendInstanceId: "codex-owned",
          nativeNamespaces: [namespace],
          nativeStores: [
            store({
              namespaceKey: namespace.namespaceKey,
              sortKey: namespace.sortKey,
            }),
          ],
        } as unknown as PreparedBackendModule,
        {
          backendInstanceId: "codex-external",
          nativeNamespaces: [namespace],
          nativeStores: [],
        } as unknown as PreparedBackendModule,
      ]),
    ).toThrow("backend_native_namespace_reused");
  });

  it("releases the first native store when the second acquisition fails", async () => {
    const order: string[] = [];
    const first = store({
      namespaceKey: "first",
      sortKey: "a",
      acquire: vi.fn(async () => ({
        release: async () => {
          order.push("release-first");
        },
      })),
    });
    const failure = new Error("second lock unavailable");
    const second = store({
      namespaceKey: "second",
      sortKey: "b",
      acquire: vi.fn(async () => {
        order.push("acquire-second");
        throw failure;
      }),
    });
    const resources = new StartupResourceStack();

    await expect(
      acquireBackendNativeStores([first, second], resources),
    ).rejects.toBe(failure);
    await expect(resources.dispose(failure)).rejects.toBe(failure);
    expect(order).toEqual(["acquire-second", "release-first"]);
  });

  it("closes a partially started second runtime before the first", async () => {
    const order: string[] = [];
    const resources = new StartupResourceStack();
    const first = runtime(
      "first",
      async () => {
        order.push("start-first");
      },
      async () => {
        order.push("close-first");
      },
    );
    const failure = new Error("second runtime failed");
    const second = runtime(
      "second",
      async () => {
        order.push("start-second");
        throw failure;
      },
      async () => {
        order.push("close-second");
      },
    );

    await startBackendModuleRuntime(first, resources);
    await expect(startBackendModuleRuntime(second, resources)).rejects.toBe(
      failure,
    );
    await expect(resources.dispose(failure)).rejects.toBe(failure);
    expect(order).toEqual([
      "start-first",
      "start-second",
      "close-second",
      "close-first",
    ]);
  });

  it("starts two complete module bundles once and unwinds them in reverse", async () => {
    const order: string[] = [];
    let releaseFirstStart!: () => void;
    const secondStartEntered = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    const scope = { tenantId: "tenant-1", principalId: "principal-1" };
    const instances: AgentBackendInstance[] = [
      {
        id: "pi",
        tenantId: scope.tenantId,
        kind: "pi",
        label: "Pi",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "0.86.0",
      },
      {
        id: "codex",
        tenantId: scope.tenantId,
        kind: "codex_app_server",
        label: "Codex",
        enabled: true,
        configurationRevision: 0,
        protocolRelease: "future",
      },
    ];
    const connections: AgentConnectionProfile[] = instances.map((instance) => ({
      id: `${instance.id}-profile`,
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: `${instance.id}-target`,
      kind: instance.kind === "pi" ? "pi_sdk" : "codex_app_server",
      backendInstanceId: instance.id,
      executionEnvironmentId: "environment-1",
      label: instance.label,
      enabled: true,
      configurationRevision: 0,
    }));
    const createRuntime = instances.map((instance) =>
      vi.fn((context: BackendModuleRuntimeContext) => {
        expect(context.scope).toEqual(scope);
        expect(context.connections).toEqual(
          connections.filter(
            ({ backendInstanceId }) => backendInstanceId === instance.id,
          ),
        );
        return {
          scope,
          instance,
          driverFactory: {
            scope,
            instance,
            connectionKinds:
              instance.kind === "pi"
                ? (["pi_sdk"] as const)
                : (["codex_app_server"] as const),
            supportsConversationCreation: instance.kind === "pi",
            ...(instance.kind === "pi"
              ? {
                  creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
                }
              : {}),
            create: (connection: AgentConnectionProfile) =>
              ({ instance, connection }) as never,
          },
          threadPersistence: {},
          bindingDetails: {},
          presentation: {},
          actionPersistence: {},
          discoveryPersistence: {},
          discovery: {},
          start: async () => {
            order.push(`start-${instance.id}`);
            if (instance.id === "pi") await secondStartEntered;
            else {
              expect(registry.instances(scope)).toEqual([]);
              releaseFirstStart();
            }
          },
          close: async () => {
            order.push(`close-${instance.id}`);
          },
        } as unknown as BackendModuleRuntime;
      }),
    );
    const preparedModules = instances.map(
      (instance, index) =>
        ({
          backendInstanceId: instance.id,
          nativeStores: [],
          createRuntime: createRuntime[index],
        }) as unknown as PreparedBackendModule,
    );
    const resources = new StartupResourceStack();
    const registry = new AgentBackendRegistry();
    const agentTools = new LateBoundBackendAgentToolFacade();
    const outputArtifacts = {} as never;
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: "environment-1",
    });

    const started = await initializeBackendModuleRuntimes({
      usage: NO_USAGE_SINK,
      preparedModules,
      database: {} as Database.Database,
      scope,
      instances,
      connections,
      environmentChannels: new Map([["environment-1", environmentChannel]]),
      environmentOperations: ENVIRONMENT_OPERATIONS,
      toolProvenanceKey: new Uint8Array(32),
      agentTools,
      outputArtifacts,
      viewedImageCapture: {} as never,
      agentToolSourceCapabilities,
      agentToolCli: AGENT_TOOL_CLI,
      registry,
      resources,
    });

    expect([...started.runtimes]).toHaveLength(2);
    expect(registry.instances(scope)).toEqual([instances[1], instances[0]]);
    expect(createRuntime[0]).toHaveBeenCalledOnce();
    expect(createRuntime[1]).toHaveBeenCalledOnce();
    expect(createRuntime[0]).toHaveBeenCalledWith(
      expect.objectContaining({ agentTools, outputArtifacts, usage: NO_USAGE_SINK }),
    );
    await resources.dispose();
    expect(order).toEqual([
      "start-pi",
      "start-codex",
      "close-codex",
      "close-pi",
    ]);
  });

  it("does not reach the listener when the second complete bundle fails", async () => {
    const order: string[] = [];
    const scope = { tenantId: "tenant-1", principalId: "principal-1" };
    const instances = ["first", "second"].map((id): AgentBackendInstance => ({
      id,
      tenantId: scope.tenantId,
      kind: "pi",
      label: id,
      enabled: true,
      configurationRevision: 0,
      protocolRelease: "0.86.0",
    }));
    const failure = new Error("second shared daemon failed");
    const preparedModules = instances.map(
      (instance) =>
        ({
          backendInstanceId: instance.id,
          nativeStores: [],
          createRuntime: () =>
            ({
              scope,
              instance,
              driverFactory: {
                scope,
                instance,
                connectionKinds: ["pi_sdk"],
                supportsConversationCreation: true,
                creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
                create: () => {
                  throw new Error("not used");
                },
              },
              threadPersistence: {},
              bindingDetails: {},
              presentation: {},
              actionPersistence: {},
              discoveryPersistence: {},
              discovery: {},
              start: () => {
                order.push(`start-${instance.id}`);
                if (instance.id === "second") throw failure;
                return new Promise<void>((resolve) =>
                  setImmediate(() => {
                    order.push(`settled-${instance.id}`);
                    resolve();
                  }),
                );
              },
              close: async () => {
                order.push(`close-${instance.id}`);
              },
            }) as unknown as BackendModuleRuntime,
        }) as unknown as PreparedBackendModule,
    );
    const resources = new StartupResourceStack();
    const listen = vi.fn();
    const connections: AgentConnectionProfile[] = instances.map((instance) => ({
      id: `${instance.id}-profile`,
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: `${instance.id}-target`,
      kind: "pi_sdk",
      backendInstanceId: instance.id,
      executionEnvironmentId: "environment-1",
      label: instance.label,
      enabled: true,
      configurationRevision: 0,
    }));
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: "environment-1",
    });

    try {
      await initializeBackendModuleRuntimes({
      usage: NO_USAGE_SINK,
        preparedModules,
        database: {} as Database.Database,
        scope,
        instances,
        connections,
        environmentChannels: new Map([["environment-1", environmentChannel]]),
        environmentOperations: ENVIRONMENT_OPERATIONS,
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        viewedImageCapture: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: AGENT_TOOL_CLI,
        registry: new AgentBackendRegistry(),
        resources,
      });
      listen();
    } catch (error) {
      await expect(resources.dispose(error)).rejects.toBe(failure);
    }

    expect(listen).not.toHaveBeenCalled();
    expect(order).toEqual([
      "start-first",
      "start-second",
      "settled-first",
      "close-second",
      "close-first",
    ]);
  });

  it("rejects mixed enabled environments before creating a backend runtime", async () => {
    const scope = { tenantId: "tenant-1", principalId: "principal-1" };
    const instance: AgentBackendInstance = {
      id: "codex",
      tenantId: scope.tenantId,
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      configurationRevision: 0,
      protocolRelease: "future",
    };
    const createRuntime = vi.fn();
    const connection = (id: string, executionEnvironmentId: string) => ({
      id,
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: `${id}-template`,
      kind: "codex_app_server" as const,
      backendInstanceId: instance.id,
      executionEnvironmentId,
      label: id,
      enabled: true,
      configurationRevision: 0,
    });

    await expect(
      initializeBackendModuleRuntimes({
      usage: NO_USAGE_SINK,
        preparedModules: [
          {
            backendInstanceId: instance.id,
            nativeStores: [],
            createRuntime,
          } as unknown as PreparedBackendModule,
        ],
        database: {} as Database.Database,
        scope,
        instances: [instance],
        connections: [
          connection("first", "environment-1"),
          connection("second", "environment-2"),
        ],
        environmentChannels: new Map(),
        environmentOperations: ENVIRONMENT_OPERATIONS,
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        viewedImageCapture: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: AGENT_TOOL_CLI,
        registry: new AgentBackendRegistry(),
        resources: new StartupResourceStack(),
      }),
    ).rejects.toThrow("backend_runtime_execution_environment_invalid");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a wrong-scoped environment channel before creating a backend runtime", async () => {
    const scope = { tenantId: "tenant-1", principalId: "principal-1" };
    const instance: AgentBackendInstance = {
      id: "codex",
      tenantId: scope.tenantId,
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      configurationRevision: 0,
      protocolRelease: "future",
    };
    const createRuntime = vi.fn();
    const connection: AgentConnectionProfile = {
      id: "codex-profile",
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: "codex-template",
      kind: "codex_app_server",
      backendInstanceId: instance.id,
      executionEnvironmentId: "environment-1",
      label: "Codex",
      enabled: true,
      configurationRevision: 0,
    };
    const wrongScopeChannel = new LocalEnvironmentChannelProvider({
      scope: { ...scope, principalId: "foreign-principal" },
      executionEnvironmentId: "environment-1",
    });

    await expect(
      initializeBackendModuleRuntimes({
      usage: NO_USAGE_SINK,
        preparedModules: [
          {
            backendInstanceId: instance.id,
            nativeStores: [],
            createRuntime,
          } as unknown as PreparedBackendModule,
        ],
        database: {} as Database.Database,
        scope,
        instances: [instance],
        connections: [connection],
        environmentChannels: new Map([["environment-1", wrongScopeChannel]]),
        environmentOperations: ENVIRONMENT_OPERATIONS,
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        viewedImageCapture: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: AGENT_TOOL_CLI,
        registry: new AgentBackendRegistry(),
        resources: new StartupResourceStack(),
      }),
    ).rejects.toThrow("backend_runtime_environment_channel_missing");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a missing CLI disposition for an enabled runtime environment", async () => {
    const scope = { tenantId: "tenant-1", principalId: "principal-1" };
    const instance: AgentBackendInstance = {
      id: "codex",
      tenantId: scope.tenantId,
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      configurationRevision: 0,
      protocolRelease: "future",
    };
    const connection: AgentConnectionProfile = {
      id: "codex-profile",
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: "codex-template",
      kind: "codex_app_server",
      backendInstanceId: instance.id,
      executionEnvironmentId: "environment-1",
      label: "Codex",
      enabled: true,
      configurationRevision: 0,
    };
    const createRuntime = vi.fn();
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: "environment-1",
    });

    await expect(
      initializeBackendModuleRuntimes({
      usage: NO_USAGE_SINK,
        preparedModules: [
          {
            backendInstanceId: instance.id,
            nativeStores: [],
            createRuntime,
          } as unknown as PreparedBackendModule,
        ],
        database: {} as Database.Database,
        scope,
        instances: [instance],
        connections: [connection],
        environmentChannels: new Map([["environment-1", environmentChannel]]),
        environmentOperations: ENVIRONMENT_OPERATIONS,
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        viewedImageCapture: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: new Map(),
        registry: new AgentBackendRegistry(),
        resources: new StartupResourceStack(),
      }),
    ).rejects.toThrow("backend_runtime_agent_tool_cli_missing");
    expect(createRuntime).not.toHaveBeenCalled();
    environmentChannel.close();
  });
});
