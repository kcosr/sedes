import path from "node:path";
import { lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import {
  CodexBackendModule,
  type CodexBackendModuleDependencies,
} from "../../src/server/backends/codex/codex-backend-module.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { CodexBackendDriverFactory } from "../../src/server/backends/codex/codex-driver-factory.js";
import { CodexRemoteRuntimeSupervisor } from "../../src/server/backends/codex/runtime/codex-remote-runtime-supervisor.js";
import { CODEX_APP_SERVER_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import type { ResolvedCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import type {
  FramedMessageTransport,
  FramedTransportFactory,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import type {
  BackendModuleConfigurationInput,
  BackendModuleRuntimeContext,
} from "../../src/server/backends/module.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { LateBoundBackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

const scope = Object.freeze({
  tenantId: "tenant-one",
  principalId: "principal-one",
});
const backendInstanceId = "codex-primary";
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const filename of temporaryPaths.splice(0).reverse()) {
    await rm(filename, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const created = await mkdtemp(path.join(homedir(), ".sedes-codex-module-"));
  temporaryPaths.push(created);
  return await realpath(created);
}

function configuration(input: {
  readonly codexHome?: string;
  readonly workingDirectory: string;
  readonly enabled?: boolean;
  readonly ownership?: "owned" | "external";
  readonly backendId?: string;
  readonly executionEnvironmentId?: string;
  readonly socketPath?: string;
  readonly tcpUrl?: string;
  readonly tokenVariable?: string;
  readonly environment?: Record<string, string | undefined>;
}): BackendModuleConfigurationInput {
  const configuredBackendId = input.backendId ?? backendInstanceId;
  const executionEnvironmentId = input.executionEnvironmentId ?? "local";
  return {
    backend: {
      id: configuredBackendId,
      kind: "codex_app_server",
      protocolRelease: CODEX_APP_SERVER_RELEASE,
      enabled: input.enabled ?? true,
      modelPolicy: {
        type: "allowlist",
        allowed: [{ modelIds: ["gpt-test"] }],
      },
      moduleConfiguration: {
        connection:
          input.ownership === "external"
            ? {
                ownership: "external",
                channel: input.tcpUrl
                  ? {
                      type: "tcp_websocket",
                      url: input.tcpUrl,
                      authentication: {
                        type: "capability_token",
                        secret: {
                          source: "environment",
                          variable:
                            input.tokenVariable ?? "SEDES_CODEX_TEST_TOKEN",
                        },
                      },
                    }
                  : {
                      type: "unix_websocket",
                      socketPath:
                        input.socketPath ?? "/run/user/1000/codex.sock",
                    },
              }
            : {
                ownership: "owned",
                channel: {
                  type: "process_stdio",
                  executablePath: "/usr/bin/false",
                  workingDirectory: input.workingDirectory,
                  ...(input.codexHome ? { codexHome: input.codexHome } : {}),
                },
              },
        policy: {
          allowedSandboxModes: ["read-only"],
          allowedNetworkAccess: ["disabled"],
          allowedApprovalPolicies: ["never"],
          allowedApprovalReviewers: ["user"],
        },
      },
    },
    connections: [
      {
        id: "codex-default",
        kind: "codex_app_server",
        backendInstanceId: configuredBackendId,
        executionEnvironmentId,
        enabled: true,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "read-only",
            networkAccess: "disabled",
            approvalPolicy: "never",
            approvalReviewer: "user",
            model: { type: "fixed", modelId: "gpt-test" },
          },
        },
      },
      {
        id: "codex-disabled",
        kind: "codex_app_server",
        backendInstanceId: configuredBackendId,
        executionEnvironmentId,
        enabled: false,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "read-only",
            networkAccess: "disabled",
            approvalPolicy: "never",
            approvalReviewer: "user",
            model: { type: "fixed", modelId: "gpt-test" },
          },
        },
      },
    ],
    executionEnvironments: [
      {
        id: executionEnvironmentId,
        kind:
          input.ownership === "external" && executionEnvironmentId !== "local"
            ? "ssh"
            : "local",
      },
    ],
    environment: input.environment ?? {},
  };
}

function instance(
  enabled = true,
  id = backendInstanceId,
  runtimeScope: RequestScope = scope,
): AgentBackendInstance {
  return Object.freeze({
    id,
    tenantId: runtimeScope.tenantId,
    kind: "codex_app_server",
    label: "Codex",
    enabled,
    configurationRevision: 1,
    protocolRelease: CODEX_APP_SERVER_RELEASE,
  });
}

function connection(
  templateId: "codex-default" | "codex-disabled",
  executionEnvironmentId = "local",
): AgentConnectionProfile {
  const enabled = templateId === "codex-default";
  return Object.freeze({
    id: `${scope.principalId}-${templateId}`,
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    templateId,
    kind: "codex_app_server",
    backendInstanceId,
    executionEnvironmentId,
    label: templateId,
    enabled,
    configurationRevision: 1,
  });
}

function context(
  connections: readonly AgentConnectionProfile[] = [
    connection("codex-default"),
    connection("codex-disabled"),
  ],
  runtimeScope: RequestScope = scope,
  runtimeInstance = instance(true, backendInstanceId, runtimeScope),
  executionEnvironmentId = "local",
): BackendModuleRuntimeContext {
  return {
    database: {
      prepare: () => ({
        run: () => ({ changes: 0 }),
      }),
    } as unknown as Database.Database,
    scope: runtimeScope,
    instance: runtimeInstance,
    connections,
    environmentChannel: new LocalEnvironmentChannelProvider({
      scope: runtimeScope,
      executionEnvironmentId,
    }),
    environmentOperations: unavailableEnvironmentOperations({
      environmentId: executionEnvironmentId,
      environmentKind: "local",
      environmentLabel: "Local",
    }),
    toolProvenanceKey: new Uint8Array(32),
    agentTools: new LateBoundBackendAgentToolFacade(),
    outputArtifacts: createInMemoryOutputArtifactPublisher(),
    agentToolSourceCapabilities,
    agentToolCli: {
      availability: "available",
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "/tmp/sedes-cli",
      inheritedPath: "/usr/bin",
    },
  };
}

function resolvedConfiguration(
  input: Parameters<
    CodexBackendModuleDependencies["resolveRuntimeConfiguration"]
  >[0],
): ResolvedCodexRuntimeConfiguration {
  const executionEnvironmentId =
    input.connections.find(({ enabled }) => enabled)?.executionEnvironmentId ??
    input.environmentChannel.executionEnvironmentId;
  if (input.connection.ownership === "external") {
    return Object.freeze({
      scope: input.scope,
      instance: input.instance,
      executionEnvironmentId,
      connection: {
        ownership: "external" as const,
        channel:
          input.connection.channel.type === "unix_websocket"
            ? {
                type: "unix_websocket" as const,
                socketPath: input.connection.channel.socketPath,
              }
            : {
                type: "tcp_websocket" as const,
                url: input.connection.channel.url,
                authentication: input.connection.channel.authentication,
              },
      },
    });
  }
  const home = input.environment.HOME ?? homedir();
  const configuredCodexHome = input.connection.channel.codexHome;
  const nativeStoreHome = configuredCodexHome ?? path.join(home, ".codex");
  const childEnvironment: Record<string, string> = {
    PATH: input.environment.PATH ?? "",
    HOME: home,
  };
  if (configuredCodexHome) childEnvironment.CODEX_HOME = nativeStoreHome;
  const resolved: ResolvedCodexRuntimeConfiguration = {
    scope: input.scope,
    instance: input.instance,
    executionEnvironmentId,
    codexHome: nativeStoreHome,
    nativeStoreHome,
    connection: {
      ownership: "owned",
      channel: {
        type: "process_stdio",
        process: {
          kind: "owned_process",
          scope: {
            ...input.scope,
            backendInstanceId: input.instance.id,
            executionEnvironmentId,
          },
          executable: {
            kind: "executable",
            canonicalPath: "/usr/bin/false",
          },
          workingDirectory: {
            kind: "directory",
            canonicalPath: input.connection.channel.workingDirectory,
          },
        },
        executable: {
          path: "/usr/bin/false",
          version: "0.153.0",
          newerThanTested: false,
        },
        workingDirectory: input.connection.channel.workingDirectory,
      },
    },
    childEnvironment: Object.freeze(childEnvironment),
  };
  return Object.freeze(resolved);
}

function fakeDependencies() {
  const resolveRuntimeConfiguration = vi.fn(
    async (
      input: Parameters<
        CodexBackendModuleDependencies["resolveRuntimeConfiguration"]
      >[0],
    ) => resolvedConfiguration(input),
  );
  const transport: FramedTransportFactory = {
    open: async () =>
      Promise.reject<FramedMessageTransport>(
        new Error("transport must not open in module tests"),
      ),
  };
  const createTransportFactory = vi.fn(
    (
      _input: Parameters<
        CodexBackendModuleDependencies["createTransportFactory"]
      >[0],
    ) => transport,
  );
  const starts: Array<ReturnType<typeof vi.fn>> = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const clients: CodexSharedClientFacade[] = [];
  const supervisorInputs: Array<
    Parameters<CodexBackendModuleDependencies["createSupervisor"]>[0]
  > = [];
  const createSupervisor: CodexBackendModuleDependencies["createSupervisor"] =
    vi.fn((input) => {
      supervisorInputs.push(input);
      const client = new CodexSharedClientFacade({
        current: () => undefined,
        latestGeneration: () => 0,
        retireGeneration: async () => undefined,
      });
      const start = vi.fn(async () => {
        client.updateLifecycle({ state: "starting", generation: 0 });
        input.nativeStoreOwnership?.armLaunch();
        client.updateLifecycle({ state: "ready", generation: 1 });
      });
      const close = vi.fn(async () => {
        input.nativeStoreOwnership?.proveClosed();
      });
      starts.push(start);
      closes.push(close);
      clients.push(client);
      return {
        client,
        start,
        close,
      };
    });
  return {
    dependencies: {
      resolveRuntimeConfiguration,
      createTransportFactory,
      createSupervisor,
    } satisfies CodexBackendModuleDependencies,
    resolveRuntimeConfiguration,
    createTransportFactory,
    createSupervisor,
    starts,
    closes,
    clients,
    supervisorInputs,
  };
}

describe("CodexBackendModule", () => {
  it("defaults owned stdio to HOME/.codex without setting CODEX_HOME and claims that native namespace", async () => {
    const home = await temporaryDirectory();
    const defaultCodexHome = path.join(home, ".codex");
    const workingDirectory = await temporaryDirectory();
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({
        workingDirectory,
        environment: { HOME: home, PATH: "/usr/bin" },
      }),
    );

    expect(prepared.nativeStores).toHaveLength(1);
    await expect(lstat(defaultCodexHome)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const lease = await prepared.nativeStores[0]!.acquire();
    expect((await stat(defaultCodexHome)).isDirectory()).toBe(true);
    expect(prepared.nativeNamespaces).toEqual([
      expect.objectContaining({
        namespaceKey: prepared.nativeStores[0]!.namespaceKey,
      }),
    ]);
    const runtime = prepared.createRuntime(context());
    expect(fakes.supervisorInputs[0]!.expectedCodexHome).toBe(defaultCodexHome);

    await runtime.start();
    const resolutionInput = fakes.resolveRuntimeConfiguration.mock.calls[0]![0];
    expect(resolutionInput.connection).toEqual({
      ownership: "owned",
      channel: {
        type: "process_stdio",
        executablePath: "/usr/bin/false",
        workingDirectory,
      },
    });
    const resolved =
      fakes.createTransportFactory.mock.calls[0]![0].configuration;
    expect(resolved).toMatchObject({
      codexHome: defaultCodexHome,
      nativeStoreHome: defaultCodexHome,
      childEnvironment: { HOME: home, PATH: "/usr/bin" },
    });
    expect(
      "CODEX_HOME" in
        (resolved as { childEnvironment: object }).childEnvironment,
    ).toBe(false);
    expect(
      runtime.discovery.nativeNamespaceKey(context().connections[0]!),
    ).toBe(prepared.nativeStores[0]!.namespaceKey);
    await runtime.close();
    await lease.release();
  });

  it("composes one principal-scoped shared runtime and retains its native lock until cleanup is proven", async () => {
    const codexHome = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    const parentEnvironment: Record<string, string | undefined> = {
      PATH: "/captured/bin",
    };
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({
        codexHome,
        workingDirectory,
        environment: parentEnvironment,
      }),
    );
    expect(prepared.nativeStores).toHaveLength(1);
    const store = prepared.nativeStores[0]!;
    const lease = await store.acquire();

    const runtime = prepared.createRuntime(context());
    expect(runtime.driverFactory).toBeInstanceOf(CodexBackendDriverFactory);
    expect(runtime.driverFactory.supportsConversationCreation).toBe(true);
    expect(
      runtime.discovery.nativeNamespaceKey(context().connections[0]!),
    ).toBe(store.namespaceKey);
    expect(
      runtime.discovery.nativeNamespaceKey(context().connections[1]!),
    ).toBe(store.namespaceKey);
    expect(fakes.createSupervisor).toHaveBeenCalledOnce();
    expect(fakes.resolveRuntimeConfiguration).not.toHaveBeenCalled();
    expect(fakes.createTransportFactory).not.toHaveBeenCalled();
    expect(fakes.starts).toHaveLength(1);
    expect(fakes.starts[0]).not.toHaveBeenCalled();

    parentEnvironment.PATH = "/mutated/bin";
    await Promise.all([runtime.start(), runtime.start()]);
    expect(fakes.resolveRuntimeConfiguration).toHaveBeenCalledOnce();
    expect(
      fakes.resolveRuntimeConfiguration.mock.calls[0]![0].environment.PATH,
    ).toBe("/captured/bin");
    expect(fakes.createTransportFactory).toHaveBeenCalledOnce();
    expect(fakes.starts[0]).toHaveBeenCalledOnce();
    expect(fakes.supervisorInputs[0]!.expectedRuntimeVersion?.()).toBe(
      "0.153.0",
    );
    expect(runtime.installationAdvisories.active()).toEqual([]);
    const advisoryListener = vi.fn();
    runtime.installationAdvisories.subscribe(advisoryListener);
    fakes.supervisorInputs[0]!.onRuntimeVersionAssessment({
      version: "0.152.0",
      newerThanTested: true,
    });
    expect(runtime.installationAdvisories.active()).toEqual([
      expect.objectContaining({
        id: "runtime-newer-than-tested",
        title: { text: "Codex is newer than tested" },
      }),
    ]);
    expect(advisoryListener).toHaveBeenCalledOnce();
    fakes.clients[0]!.updateLifecycle({ state: "unavailable", generation: 1 });
    expect(runtime.installationAdvisories.active()).toEqual([]);
    expect(advisoryListener).toHaveBeenCalledTimes(2);
    fakes.supervisorInputs[0]!.onRuntimeVersionAssessment({
      version: "0.152.0",
      newerThanTested: true,
    });
    expect(runtime.installationAdvisories.active()).toHaveLength(1);
    expect(advisoryListener).toHaveBeenCalledTimes(3);
    await expect(lease.release()).rejects.toThrow(
      "codex_native_store_retained_cleanup_unproven",
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(runtime.installationAdvisories.active()).toEqual([]);
    expect(advisoryListener).toHaveBeenCalledTimes(4);
    expect(fakes.closes[0]).toHaveBeenCalledOnce();
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("shares one client across threads but separates backend and principal runtimes", async () => {
    const firstHome = await temporaryDirectory();
    const firstWorkspace = await temporaryDirectory();
    const firstFakes = fakeDependencies();
    const firstRuntime = new CodexBackendModule(firstFakes.dependencies)
      .prepare(
        configuration({
          codexHome: firstHome,
          workingDirectory: firstWorkspace,
        }),
      )
      .createRuntime(context());
    const profile = connection("codex-default");
    const firstThreadDriver = firstRuntime.driverFactory.create(profile);
    const secondThreadDriver = firstRuntime.driverFactory.create(profile);
    expect(secondThreadDriver).toBe(firstThreadDriver);
    expect(firstFakes.clients).toHaveLength(1);

    const secondBackendId = "codex-secondary";
    const secondHome = await temporaryDirectory();
    const secondWorkspace = await temporaryDirectory();
    const secondFakes = fakeDependencies();
    const secondConnections = context().connections.map((candidate) => ({
      ...candidate,
      id: `secondary-${candidate.templateId}`,
      backendInstanceId: secondBackendId,
    }));
    const secondRuntime = new CodexBackendModule(secondFakes.dependencies)
      .prepare(
        configuration({
          backendId: secondBackendId,
          codexHome: secondHome,
          workingDirectory: secondWorkspace,
        }),
      )
      .createRuntime(
        context(secondConnections, scope, instance(true, secondBackendId)),
      );

    const otherPrincipal = {
      tenantId: scope.tenantId,
      principalId: "principal-two",
    };
    const thirdBackendId = "codex-third";
    const thirdFakes = fakeDependencies();
    const thirdConnections = context().connections.map((candidate) => ({
      ...candidate,
      id: `third-${candidate.templateId}`,
      ownerPrincipalId: otherPrincipal.principalId,
      backendInstanceId: thirdBackendId,
    }));
    const thirdRuntime = new CodexBackendModule(thirdFakes.dependencies)
      .prepare(
        configuration({
          backendId: thirdBackendId,
          codexHome: await temporaryDirectory(),
          workingDirectory: await temporaryDirectory(),
        }),
      )
      .createRuntime(
        context(
          thirdConnections,
          otherPrincipal,
          instance(true, thirdBackendId, otherPrincipal),
        ),
      );

    expect(secondFakes.clients[0]).not.toBe(firstFakes.clients[0]);
    expect(thirdFakes.clients[0]).not.toBe(firstFakes.clients[0]);
    await Promise.all([
      firstRuntime.close(),
      secondRuntime.close(),
      thirdRuntime.close(),
    ]);
  });

  it("invalidates backend-wide confirmations at startup and across daemon replacement", async () => {
    const codexHome = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    const invalidations = vi
      .spyOn(
        CodexThreadExecutionSettingsRepository.prototype,
        "invalidateConfirmedForBackend",
      )
      .mockReturnValue(0);
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({ codexHome, workingDirectory }),
    );
    const runtime = prepared.createRuntime(context());

    await runtime.start();
    expect(invalidations).toHaveBeenCalledTimes(1);
    expect(invalidations.mock.calls[0]![0]).toEqual(scope);
    expect(invalidations.mock.calls[0]![1]).toBe(backendInstanceId);
    expect(invalidations.mock.calls[0]![2]).toEqual(expect.any(Number));

    const client = fakes.clients[0]!;
    client.updateLifecycle({ state: "reconciling", generation: 1 });
    expect(invalidations).toHaveBeenCalledTimes(2);
    client.updateLifecycle({ state: "starting", generation: 2 });
    client.updateLifecycle({ state: "ready", generation: 2 });
    expect(invalidations).toHaveBeenCalledTimes(2);

    // Also fence a provider implementation that publishes a replacement-ready
    // generation without first exposing an unavailable lifecycle state.
    client.updateLifecycle({ state: "ready", generation: 3 });
    expect(invalidations).toHaveBeenCalledTimes(3);
    expect(
      invalidations.mock.calls
        .slice(1)
        .every(
          ([observedScope, observedBackend]) =>
            observedScope === scope && observedBackend === backendInstanceId,
        ),
    ).toBe(true);

    await runtime.close();
    invalidations.mockRestore();
  });

  it("publishes execution-environment availability only from backend lifecycle readiness", async () => {
    const fakes = fakeDependencies();
    const runtimeContext = context();
    const availability = vi.spyOn(
      runtimeContext.environmentChannel,
      "reportRuntimeAvailability",
    );
    const runtime = new CodexBackendModule(fakes.dependencies)
      .prepare(
        configuration({
          codexHome: await temporaryDirectory(),
          workingDirectory: await temporaryDirectory(),
        }),
      )
      .createRuntime(runtimeContext);

    expect(availability).not.toHaveBeenCalled();
    await runtime.start();
    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({
        backendInstanceId,
        executionEnvironmentId: "local",
      }),
      { availability: "available" },
    );

    fakes.clients[0]!.updateLifecycle({
      state: "unavailable",
      generation: 1,
    });
    await vi.waitFor(() =>
      expect(availability).toHaveBeenLastCalledWith(
        expect.objectContaining({
          backendInstanceId,
          executionEnvironmentId: "local",
        }),
        {
          availability: "unavailable",
          diagnosticCode: "backend_runtime_unavailable",
        },
      ),
    );
    await runtime.close();
  });

  it("awaits the final availability persistence queued synchronously by supervisor close", async () => {
    const fakes = fakeDependencies();
    const runtimeContext = context();
    let releaseFinalAvailability!: () => void;
    const finalAvailability = new Promise<void>((resolve) => {
      releaseFinalAvailability = resolve;
    });
    const availability = vi
      .spyOn(runtimeContext.environmentChannel, "reportRuntimeAvailability")
      .mockImplementation(async (_scope, observation) => {
        if (observation.availability === "unavailable") {
          await finalAvailability;
        }
      });
    const runtime = new CodexBackendModule(fakes.dependencies)
      .prepare(
        configuration({
          codexHome: await temporaryDirectory(),
          workingDirectory: await temporaryDirectory(),
        }),
      )
      .createRuntime(runtimeContext);

    await runtime.start();
    fakes.closes[0]!.mockImplementationOnce(async () => {
      fakes.clients[0]!.updateLifecycle({
        state: "unavailable",
        generation: 1,
      });
    });

    let closeSettled = false;
    const closing = runtime.close().then(() => {
      closeSettled = true;
    });
    await vi.waitFor(() =>
      expect(availability).toHaveBeenLastCalledWith(
        expect.objectContaining({ backendInstanceId }),
        {
          availability: "unavailable",
          diagnosticCode: "backend_runtime_unavailable",
        },
      ),
    );
    expect(closeSettled).toBe(false);

    releaseFinalAvailability();
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("propagates persistence invalidation failure without starting the daemon", async () => {
    const invalidations = vi
      .spyOn(
        CodexThreadExecutionSettingsRepository.prototype,
        "invalidateConfirmedForBackend",
      )
      .mockImplementation(() => {
        throw new Error("persistence_unavailable");
      });
    const fakes = fakeDependencies();
    const runtime = new CodexBackendModule(fakes.dependencies)
      .prepare(
        configuration({
          codexHome: await temporaryDirectory(),
          workingDirectory: await temporaryDirectory(),
        }),
      )
      .createRuntime(context());

    try {
      await expect(runtime.start()).rejects.toThrow("persistence_unavailable");
      expect(fakes.starts[0]).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      invalidations.mockRestore();
    }
  });

  it("rejects incomplete, duplicate, or cross-principal materialized profile mappings", async () => {
    const codexHome = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    const prepared = new CodexBackendModule(
      fakeDependencies().dependencies,
    ).prepare(configuration({ codexHome, workingDirectory }));
    const enabled = connection("codex-default");
    const disabled = connection("codex-disabled");

    expect(() => prepared.createRuntime(context([enabled]))).toThrow(
      "codex_backend_runtime_context_invalid",
    );
    expect(() =>
      prepared.createRuntime(
        context([enabled, { ...disabled, templateId: enabled.templateId }]),
      ),
    ).toThrow("codex_backend_runtime_context_invalid");
    expect(() =>
      prepared.createRuntime(
        context([
          { ...enabled, ownerPrincipalId: "another-principal" },
          disabled,
        ]),
      ),
    ).toThrow("codex_backend_runtime_context_invalid");
    expect(() =>
      prepared.createRuntime(
        context([{ ...enabled, enabled: false }, disabled]),
      ),
    ).toThrow("codex_backend_runtime_context_invalid");
  });

  it("consumes a prepared native-store ownership gate for exactly one principal runtime", async () => {
    const codexHome = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    const prepared = new CodexBackendModule(
      fakeDependencies().dependencies,
    ).prepare(configuration({ codexHome, workingDirectory }));
    const runtime = prepared.createRuntime(context());
    const otherScope = {
      tenantId: scope.tenantId,
      principalId: "principal-two",
    };
    const otherConnections = context().connections.map((profile) => ({
      ...profile,
      id: `${otherScope.principalId}-${profile.templateId}`,
      ownerPrincipalId: otherScope.principalId,
    }));

    expect(() =>
      prepared.createRuntime({
        ...context(otherConnections),
        scope: otherScope,
      }),
    ).toThrow("codex_backend_runtime_already_created");
    await runtime.close();
  });

  it("does not preflight or launch a disabled backend", () => {
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({
        codexHome: "/definitely/missing/codex-home",
        workingDirectory: "/definitely/missing/workspace",
        enabled: false,
      }),
    );

    expect(prepared.nativeStores).toEqual([]);
    expect(() =>
      prepared.createRuntime({
        ...context(),
        instance: instance(false),
      }),
    ).toThrow("codex_disabled_runtime_not_creatable");
    expect(fakes.createSupervisor).not.toHaveBeenCalled();
    expect(fakes.resolveRuntimeConfiguration).not.toHaveBeenCalled();
    expect(fakes.createTransportFactory).not.toHaveBeenCalled();
  });

  it("keeps an unavailable external backend registered without claiming its server lock", async () => {
    const workingDirectory = await temporaryDirectory();
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({ workingDirectory, ownership: "external" }),
    );
    expect(prepared.nativeStores).toEqual([]);
    const runtime = prepared.createRuntime(context());
    fakes.starts[0]!.mockRejectedValueOnce(
      new Error("codex_unix_websocket_unavailable"),
    );

    await expect(runtime.start()).resolves.toBeUndefined();
    const driver = runtime.driverFactory.create(connection("codex-default"));
    await expect(driver.health()).resolves.toMatchObject({
      available: false,
      diagnostic: { text: "The Codex daemon is not ready." },
    });
    await runtime.close();
  });

  it("keeps outbound native authority remote for owned and external runtimes", async () => {
    const workingDirectory = await temporaryDirectory();
    const executionEnvironmentId = "11111111-1111-4111-8111-111111111111";
    const fakes = fakeDependencies();
    const module = new CodexBackendModule(fakes.dependencies);
    for (const ownership of ["owned", "external"] as const) {
      const input = configuration({ workingDirectory, executionEnvironmentId, ownership });
      const ssh = module.prepare({ ...input, executionEnvironments: [{ id: executionEnvironmentId, kind: "ssh" }] });
      const outbound = module.prepare({ ...input, executionEnvironments: [{ id: executionEnvironmentId, kind: "outbound" }] });
      expect(outbound.nativeStores).toEqual([]);
      expect(outbound.nativeNamespaces).toEqual(ssh.nativeNamespaces);
      expect(fakes.resolveRuntimeConfiguration).not.toHaveBeenCalled();
    }
  });

  it.each(["owned", "external"] as const)("closes only the main attachment before cleaning up a remote %s Codex presentation", async ownership => {
    const executionEnvironmentId = "11111111-1111-4111-8111-111111111111";
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare({
      ...configuration({ workingDirectory: await temporaryDirectory(), executionEnvironmentId, ownership }),
      executionEnvironments: [{ id: executionEnvironmentId, kind: "ssh" }],
    });
    const acquire = vi.fn(async () => { throw new Error("unexpected_remote_acquisition"); });
    const runtime = prepared.createRuntime({
      ...context([connection("codex-default", executionEnvironmentId), connection("codex-disabled", executionEnvironmentId)], scope, instance(), executionEnvironmentId),
      sidecarRuntime: { acquire },
    });
    const close = vi.spyOn(CodexRemoteRuntimeSupervisor.prototype, "close");
    const interrupt = vi.spyOn((runtime.driverFactory as CodexBackendDriverFactory).ownership, "interruptOwnedActiveTurns");
    try {
      await runtime.stopBeforeConversationCleanup!();
      expect(close).toHaveBeenCalledOnce();
      expect(acquire).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
      expect(fakes.closes).toHaveLength(0);
    } finally { await runtime.close(); close.mockRestore(); }
  });

  it("keys an external namespace by execution environment and endpoint without a native home", async () => {
    const workingDirectory = await temporaryDirectory();
    const sshEnvironmentId = "11111111-1111-4111-8111-111111111111";
    const otherEnvironmentId = "22222222-2222-4222-8222-222222222222";
    const fakes = fakeDependencies();
    const module = new CodexBackendModule(fakes.dependencies);
    const first = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        environment: { HOME: "/unrelated/ambient/home" },
      }),
    );
    const sameEndpointAndEnvironment = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        environment: {
          HOME: "/different/ambient/home",
          CODEX_HOME: "/ignored",
        },
      }),
    );
    const otherEnvironment = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: otherEnvironmentId,
      }),
    );
    const otherEndpoint = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        socketPath: "/run/user/1000/other-codex.sock",
      }),
    );
    const tcpFirstCredential = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        tcpUrl: "wss://codex.example.test:443",
        tokenVariable: "SEDES_CODEX_FIRST_TOKEN",
      }),
    );
    const tcpRotatedCredential = module.prepare(
      configuration({
        workingDirectory,
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        tcpUrl: "wss://codex.example.test:443",
        tokenVariable: "SEDES_CODEX_ROTATED_TOKEN",
      }),
    );

    expect(first.nativeStores).toEqual([]);
    expect(first.nativeNamespaces).toHaveLength(1);
    expect(first.nativeNamespaces[0]!.namespaceKey).toBe(
      "L_wa5TBoAHnoxVibjiv8mxri6gu2OYFPGmhOWSXEmhU",
    );
    expect(fakes.resolveRuntimeConfiguration).not.toHaveBeenCalled();
    expect(sameEndpointAndEnvironment.nativeNamespaces[0]!.namespaceKey).toBe(
      first.nativeNamespaces[0]!.namespaceKey,
    );
    expect(otherEnvironment.nativeNamespaces[0]!.namespaceKey).not.toBe(
      first.nativeNamespaces[0]!.namespaceKey,
    );
    expect(otherEndpoint.nativeNamespaces[0]!.namespaceKey).not.toBe(
      first.nativeNamespaces[0]!.namespaceKey,
    );
    expect(tcpRotatedCredential.nativeNamespaces[0]!.namespaceKey).toBe(
      tcpFirstCredential.nativeNamespaces[0]!.namespaceKey,
    );
  });

  it("starts an external endpoint without resolving or expecting a Codex home", async () => {
    const sshEnvironmentId = "11111111-1111-4111-8111-111111111111";
    const externalConnections = [
      connection("codex-default", sshEnvironmentId),
      connection("codex-disabled", sshEnvironmentId),
    ];
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({
        workingDirectory: await temporaryDirectory(),
        ownership: "external",
        executionEnvironmentId: sshEnvironmentId,
        environment: { HOME: "/ambient/home", CODEX_HOME: "/ambient/codex" },
      }),
    );
    const runtime = prepared.createRuntime(
      context(externalConnections, scope, instance(), sshEnvironmentId),
    );

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(fakes.resolveRuntimeConfiguration).toHaveBeenCalledOnce();
    const resolved =
      fakes.createTransportFactory.mock.calls[0]![0].configuration;
    expect(resolved).toEqual({
      scope,
      instance: expect.objectContaining({ id: backendInstanceId }),
      executionEnvironmentId: sshEnvironmentId,
      connection: {
        ownership: "external",
        channel: {
          type: "unix_websocket",
          socketPath: "/run/user/1000/codex.sock",
        },
      },
    });
    expect("codexHome" in resolved).toBe(false);
    expect("nativeStoreHome" in resolved).toBe(false);
    expect("childEnvironment" in resolved).toBe(false);
    expect(fakes.supervisorInputs[0]!.expectedCodexHome).toBeUndefined();
    expect(fakes.supervisorInputs[0]!.expectedRuntimeVersion).toBeUndefined();
    expect(fakes.starts[0]).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it.each(["uds", "tcp"] as const)("disconnects a direct external %s client before conversation cleanup without interrupting owned turns", async channel => {
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(configuration({
      workingDirectory: await temporaryDirectory(), ownership: "external",
      ...(channel === "tcp" ? { tcpUrl: "ws://127.0.0.1:4788", environment: { SEDES_CODEX_TEST_TOKEN: "test-token" } } : {}),
    }));
    const runtime = prepared.createRuntime(context());
    await runtime.start();
    const factory = runtime.driverFactory as CodexBackendDriverFactory;
    const interrupt = vi.spyOn(factory.ownership, "interruptOwnedActiveTurns");
    const request = vi.spyOn(fakes.clients[0]!, "request");
    const requestWithReceipt = vi.spyOn(fakes.clients[0]!, "requestWithReceipt");
    await runtime.stopBeforeConversationCleanup!();
    expect(fakes.closes[0]).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(requestWithReceipt).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("attempts known owned-turn interruption before closing the direct owned transport", async () => {
    const fakes = fakeDependencies();
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(configuration({ workingDirectory: await temporaryDirectory() }));
    const runtime = prepared.createRuntime(context());
    await runtime.start();
    const order: string[] = [];
    vi.spyOn((runtime.driverFactory as CodexBackendDriverFactory).ownership, "interruptOwnedActiveTurns").mockImplementation(async () => { order.push("interrupt"); });
    fakes.closes[0]!.mockImplementation(async () => { order.push("close"); });
    await runtime.stopBeforeConversationCleanup!();
    expect(order).toEqual(["interrupt", "close"]);
    await runtime.close();
  });

  it("keeps an owned configured-home drift fatal", async () => {
    const ownedHome = await temporaryDirectory();
    const ownedFakes = fakeDependencies();
    ownedFakes.resolveRuntimeConfiguration.mockImplementationOnce(
      async (input) => {
        const resolved = resolvedConfiguration(input);
        if (!("codexHome" in resolved) || resolved.codexHome === undefined) {
          throw new Error("expected_owned_runtime_configuration");
        }
        return {
          ...resolved,
          codexHome: `${ownedHome}-canonicalized-differently`,
        };
      },
    );
    const ownedRuntime = new CodexBackendModule(ownedFakes.dependencies)
      .prepare(
        configuration({
          codexHome: ownedHome,
          workingDirectory: await temporaryDirectory(),
        }),
      )
      .createRuntime(context());

    await expect(ownedRuntime.start()).rejects.toThrow(
      "codex_runtime_native_home_changed",
    );
    expect(ownedFakes.starts[0]).not.toHaveBeenCalled();
    expect(
      ownedFakes.supervisorInputs[0]!.maximumRestartAttempts,
    ).toBeUndefined();
    await ownedRuntime.close();
  });

  it("isolates an unavailable owned executable while preserving safe health", async () => {
    const codexHome = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    const fakes = fakeDependencies();
    fakes.resolveRuntimeConfiguration.mockRejectedValueOnce(
      new Error("environment_channel_executable_invalid:/private/secret"),
    );
    const prepared = new CodexBackendModule(fakes.dependencies).prepare(
      configuration({ codexHome, workingDirectory }),
    );
    const runtimeContext = context();
    const availability = vi.spyOn(
      runtimeContext.environmentChannel,
      "reportRuntimeAvailability",
    );
    const runtime = prepared.createRuntime(runtimeContext);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(fakes.starts[0]).not.toHaveBeenCalled();
    const health = await runtime.driverFactory
      .create(connection("codex-default"))
      .health();
    expect(health).toEqual({
      available: false,
      checkedAt: expect.any(String),
      diagnostic: {
        text: "The Codex runtime configuration is unavailable.",
      },
    });
    expect(JSON.stringify(health)).not.toContain("/private/secret");
    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({
        backendInstanceId,
        executionEnvironmentId: "local",
      }),
      {
        availability: "unavailable",
        diagnosticCode: "backend_runtime_configuration_unavailable",
      },
    );
    await runtime.close();
  });

  it("is registered in the production compiled-module catalog", () => {
    const module =
      compiledBackendModuleCatalog.moduleForBackendKind("codex_app_server");

    expect(module).toBeInstanceOf(CodexBackendModule);
    expect(
      compiledBackendModuleCatalog.moduleForConnectionKind("codex_app_server"),
    ).toBe(module);
  });
});
