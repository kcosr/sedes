import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createExecutionEnvironmentRuntime,
  type ExecutionEnvironmentRuntimeInput,
} from "../../src/server/runtime/execution-environment-runtime.js";
import type { ConfigurationEnvironment } from "../../src/shared/protocol/configuration-admin.js";
import type { InventoryEnvironmentRecord } from "../../src/server/db/repositories/inventory-repository.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";

const fake = vi.hoisted(() => ({
  installerOptions: [] as Record<string, unknown>[],
  runtimeOptions: [] as Record<string, unknown>[],
  terminalOptions: [] as Record<string, unknown>[],
  negotiatedCapabilities: undefined as { capabilityId: string; majorVersion: number; operations: string[] }[] | undefined,
  install: vi.fn(),
  launch: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  disconnectTransport: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));
vi.mock("../../src/server/sidecar/ssh-sidecar-artifact-installer.js", () => ({
  SshSidecarArtifactInstaller: class {
    constructor(options: Record<string, unknown>) {
      fake.installerOptions.push(options);
    }
    install = fake.install;
    launch = fake.launch;
  },
}));
vi.mock("../../src/server/sidecar/sidecar-runtime.js", async (original) => {
  const actual =
    await original<
      typeof import("../../src/server/sidecar/sidecar-runtime.js")
    >();
  return {
    ...actual,
    SidecarRuntimeOwner: class {
      constructor(readonly options: Record<string, unknown>) {
        fake.runtimeOptions.push(options);
      }
      get negotiatedCapabilities() { return this.transportAvailable() ? fake.negotiatedCapabilities ?? [] : []; }
      private transportAvailable() { return (this.options.isTransportAvailable as (() => boolean) | undefined)?.() ?? true; }
      canAcquireCapability(capabilityId: string, majorVersion: number) {
        const matches = (capability: { capabilityId: string; majorVersion: number }) => capability.capabilityId === capabilityId && capability.majorVersion === majorVersion;
        return this.transportAvailable() && (this.options.authorizedCapabilities as { capabilityId: string; majorVersion: number }[]).some(matches) &&
          (fake.negotiatedCapabilities === undefined || fake.negotiatedCapabilities.some(matches));
      }
      connect = fake.connect;
      disconnect = fake.disconnect;
      disconnectTransport = fake.disconnectTransport;
      close = fake.close;
    },
  };
});
vi.mock(
  "../../src/server/execution/ssh-interactive-terminal-provider.js",
  async (original) => {
    const actual = await original<
      typeof import("../../src/server/execution/ssh-interactive-terminal-provider.js")
    >();
    return {
      ...actual,
      SshInteractiveTerminalProvider: class extends actual.SshInteractiveTerminalProvider {
        constructor(options: ConstructorParameters<typeof actual.SshInteractiveTerminalProvider>[0]) {
          super(options);
          fake.terminalOptions.push({ ...options });
        }
      },
    };
  },
);

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const local = (roots: string[]): ConfigurationEnvironment => ({
  id: environmentId,
  kind: "local",
  label: "Local",
  workspaceRoots: roots,
  workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] },
});
const remote = (
  capabilities?: Extract<
    ConfigurationEnvironment,
    { kind: "ssh" }
  >["operations"],
): ConfigurationEnvironment => ({
  id: environmentId,
  kind: "ssh",
  label: "Remote",
  hostAlias: "remote-build",
  workspaceRoots: ["/workspace"],
  operations: capabilities ?? { kind: "none" },
});
function record(
  configured: ConfigurationEnvironment,
): InventoryEnvironmentRecord {
  return {
    ...scope,
    ownerPrincipalId: scope.principalId,
    id: configured.id,
    kind: configured.kind,
    label: configured.label,
    availability: "unavailable",
    diagnosticCode: null,
    revision: 7,
    configurationRevision: 4,
    configurationFingerprint: "test",
    operationsConfigurationRevision: 3,
    operationsConfigurationFingerprint: "test",
  };
}
function input(
  configured: ConfigurationEnvironment,
): ExecutionEnvironmentRuntimeInput {
  const current = record(configured);
  return {
    configured,
    record: current,
    scope,
    stateDirectory: "/tmp/sedes-environment-factory-test",
    environment: {},
    toolProvenanceKey: new Uint8Array(32),
    installationId: "installation-test",
    authorizedRuntimeCapabilities: [],
    activeEnvironmentRecord: () => current,
    automaticConnectionEnabled: () => true,
    reportAvailability: vi.fn(async () => undefined),
    sidecarArtifact: vi.fn(async () => ({ buildId: "test" }) as never),
    agentToolSources: {} as never,
    agentTools: {} as never,
    localPiBackendInstanceIds: [],
    piSandbox: { allocations: {} as never, materializer: {} as never },
    onBackgroundError: vi.fn(),
    sandboxProbe: vi.fn(async () => false),
  };
}
function workspace(id: string, canonicalPath: string): ValidatedWorkspace {
  return {
    canonicalPath,
    authorityRevision: 4,
    summary: {
      id: "workspace",
      environmentId: id,
      displayName: "Workspace",
      displayPath: canonicalPath,
      availability: "available",
      trustState: "trusted",
      revision: 1,
    },
  };
}

beforeEach(() => {
  fake.negotiatedCapabilities = undefined;
  fake.installerOptions.length = 0;
  fake.runtimeOptions.length = 0;
  fake.terminalOptions.length = 0;
  fake.install.mockClear();
  fake.launch.mockClear();
  fake.connect.mockClear();
  fake.disconnect.mockClear();
  fake.close.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("execution environment runtime composition", () => {
  it("uses the database environment roots for local workspace admission", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-env-runtime-"));
    await mkdir(path.join(directory, "allowed"));
    await mkdir(path.join(directory, "other"));
    try {
      const options = input(local([path.join(directory, "allowed")]));
      const runtime = await createExecutionEnvironmentRuntime(options);
      await expect(
        runtime.provider.validateWorkspace(
          scope,
          environmentId,
          path.join(directory, "allowed"),
        ),
      ).resolves.toMatchObject({
        canonicalPath: path.join(directory, "allowed"),
      });
      await expect(
        runtime.provider.validateWorkspace(
          scope,
          environmentId,
          path.join(directory, "other"),
        ),
      ).rejects.toThrow();
      expect(options.sidecarArtifact).not.toHaveBeenCalled();
      expect(options.sandboxProbe).not.toHaveBeenCalled();
      expect(runtime.terminal).toBeDefined();
      expect(runtime.sidecarRuntime).toBeUndefined();
      await runtime.close();
      await expect(
        runtime.provider.validateWorkspace(
          scope,
          environmentId,
          path.join(directory, "allowed"),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects foreign persisted scope before creating resources", async () => {
    const options = input(remote());
    await expect(
      createExecutionEnvironmentRuntime({
        ...options,
        record: { ...options.record, ownerPrincipalId: "other" },
      }),
    ).rejects.toThrow("execution_environment_runtime_scope_invalid");
    expect(options.sidecarArtifact).not.toHaveBeenCalled();
    expect(fake.installerOptions).toEqual([]);
  });

  it("retains SSH management with no normal capabilities without making a network connection", async () => {
    const options = input(remote());
    const runtime = await createExecutionEnvironmentRuntime(options);
    expect(runtime.sidecarRuntime).toBeDefined();
    expect(runtime.terminal).toBeDefined();
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("unavailable");
    expect(runtime.terminal!.recoverTerminal).toBeTypeOf("function");
    expect(fake.terminalOptions[0]!.enabled).toBe(false);
    expect(fake.terminalOptions[0]!.runtime).toBe(runtime.sidecarRuntime);
    expect(fake.runtimeOptions[0]!.authorizedCapabilities).toEqual([]);
    expect(fake.runtimeOptions[0]!.authorizedRuntimeCapabilities).toEqual([]);
    expect(runtime.agentToolCliRuntime).toBeUndefined();
    expect(runtime.workspaceFiles.supportsPrimaryRoot(scope, environmentId)).toBe(false);
    expect(runtime.attachments.supports(scope, environmentId)).toBe(false);
    expect(runtime.operations.workspaceTools.availability).toBe("unavailable");
    expect(runtime.operations.workspaceContext.availability).toBe("unavailable");
    expect(runtime.operations.workspaceSkills.availability).toBe("unavailable");
    expect(options.sidecarArtifact).toHaveBeenCalledOnce();
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.launch).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    await expect(runtime.terminal!.openTerminal({
      scope, environmentId,
      terminalId: "019196f7-a0a8-7bc4-a89b-8cf013978408",
      incarnationId: "019196f7-a0a8-7bc4-a89b-8cf013978409",
      initialCwd: "/remote/workspace", rows: 24, columns: 80,
    })).rejects.toMatchObject({ diagnosticCode: "sidecar_unavailable" });
    await expect(
      runtime.channels.openPrivateUnixStream(
        {
          ...scope,
          executionEnvironmentId: environmentId,
          backendInstanceId: "backend",
        },
        "/remote/socket",
        new AbortController().signal,
      ),
    ).rejects.toThrow("ssh_environment_capability_unsupported");
    expect(runtime.channels.openInstallationManagedWorker).toBeUndefined();
    await runtime.close();
  });

  it("composes a persistent SSH sidecar without initiating network or losing its lifecycle preference", async () => {
    let automatic = false;
    const options = {
      ...input(
        remote({
          kind: "sidecar",
          enabledCapabilities: [
            "directory_browser",
            "workspace_files",
            "workspace_tools",
            "workspace_context",
            "workspace_skills",
            "composer_attachments",
            "agent_tools_cli",
            "interactive_terminal",
          ],
        }),
      ),
      automaticConnectionEnabled: () => automatic,
    };
    const runtime = await createExecutionEnvironmentRuntime(options);
    expect(options.sidecarArtifact).toHaveBeenCalledOnce();
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.launch).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.installerOptions[0]).toMatchObject({
      host: "remote-build",
      serviceScope: {
        installationId: "installation-test",
        ...scope,
        executionEnvironmentId: environmentId,
      },
      configuration: { environmentRevision: 4, operationsRevision: 3 },
    });
    expect(
      await (fake.runtimeOptions[0]!.isAutomaticConnectionEnabled as () => Promise<boolean>)(),
    ).toBe(false);
    automatic = true;
    expect(
      await (fake.runtimeOptions[0]!.isAutomaticConnectionEnabled as () => Promise<boolean>)(),
    ).toBe(true);
    expect(fake.runtimeOptions[0]!.authorizedCapabilities).toContainEqual({
      capabilityId: "interactive_terminal",
      majorVersion: 2,
    });
    expect(runtime.agentToolCliRuntime).toBe(runtime.sidecarRuntime);
    expect(fake.terminalOptions[0]!.runtime).toBe(runtime.sidecarRuntime);
    expect(fake.terminalOptions[0]!.enabled).toBe(true);
    // An authorized initial request may trigger lazy capability negotiation.
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("available");
    fake.negotiatedCapabilities = [{ capabilityId: "interactive_terminal", majorVersion: 2, operations: ["terminal.create"] }];
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("available");
    fake.negotiatedCapabilities = [];
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("unavailable");
    expect(fake.terminalOptions[0]).not.toHaveProperty("host");
    expect(runtime.operations.workspaceTools.availability).toBe("available");
    expect(runtime.operations.workspaceContext.availability).toBe("available");
    expect(runtime.operations.workspaceSkills.availability).toBe("available");
    await runtime.close();
    await runtime.close();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledWith("environment_runtime_retired");
  });

  it("gates outbound terminal availability on immediate presence before its disconnect callback runs", async () => {
    let connected = true;
    let notify: ((connected: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    const configured: ConfigurationEnvironment = { id: environmentId, kind: "outbound", label: "Outbound", platform: "linux", pairingId: "019196f7-a0a8-7bc4-a89b-8cf013978406", workspaceRoots: ["/workspace"], operations: { kind: "sidecar", enabledCapabilities: ["interactive_terminal"] } };
    const options: ExecutionEnvironmentRuntimeInput = { ...input(configured), outboundConnection: {
      isConnected: () => connected,
      subscribe: listener => { notify = listener; return unsubscribe; },
      createProvisioner: vi.fn(() => ({} as never)),
    } };
    fake.negotiatedCapabilities = [{ capabilityId: "interactive_terminal", majorVersion: 2, operations: ["terminal.create"] }];
    const runtime = await createExecutionEnvironmentRuntime(options);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledOnce());
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("available");
    connected = false;
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("unavailable");
    expect(runtime.sidecarRuntime!.negotiatedCapabilities).toEqual([]);
    notify!(false);
    await vi.waitFor(() => expect(fake.disconnectTransport).toHaveBeenCalledWith("outbound_connection_lost"));
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(await (fake.runtimeOptions[0]!.isAutomaticConnectionEnabled as () => Promise<boolean>)()).toBe(true);
    connected = true;
    notify!(true);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(2));
    await runtime.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("creates a provider-only sidecar without granting ancillary operations", async () => {
    const options = {
      ...input(remote()),
      authorizedRuntimeCapabilities: [
        {
          capabilityId: "codex_runtime",
          majorVersion: 1,
          operations: ["runtime.ensure", "runtime.execute"],
        },
      ] as const,
    };
    const runtime = await createExecutionEnvironmentRuntime(options);
    expect(runtime.sidecarRuntime).toBeDefined();
    expect(runtime.agentToolCliRuntime).toBeUndefined();
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("unavailable");
    expect(runtime.attachments.supports(scope, environmentId)).toBe(false);
    expect(runtime.operations.workspaceTools.availability).toBe("unavailable");
    expect(fake.runtimeOptions[0]!.authorizedCapabilities).toEqual([]);
    expect(fake.runtimeOptions[0]!.authorizedRuntimeCapabilities).toBe(
      options.authorizedRuntimeCapabilities,
    );
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("does not grant an agent-tool endpoint or terminal from unrelated capabilities", async () => {
    const runtime = await createExecutionEnvironmentRuntime(
      input(
        remote({ kind: "sidecar", enabledCapabilities: ["directory_browser"] }),
      ),
    );
    expect(runtime.agentToolCliRuntime).toBeUndefined();
    expect(runtime.terminal!.availability(scope, environmentId)).toBe("unavailable");
    expect(runtime.attachments.supports(scope, environmentId)).toBe(false);
    expect(runtime.operations.workspaceTools.availability).toBe("unavailable");
    await runtime.close();
  });

  it("fences remote availability observations by scope, environment revision, and closure", async () => {
    const options = input(remote());
    let current = options.record;
    const runtime = await createExecutionEnvironmentRuntime({
      ...options,
      activeEnvironmentRecord: () => current,
    });
    const channelScope = {
      ...scope,
      executionEnvironmentId: environmentId,
      backendInstanceId: "backend",
    };
    await expect(
      runtime.channels.reportRuntimeAvailability(
        { ...channelScope, principalId: "other" },
        { availability: "available" },
      ),
    ).rejects.toThrow();
    expect(options.reportAvailability).not.toHaveBeenCalled();
    await runtime.channels.reportRuntimeAvailability(channelScope, {
      availability: "available",
    });
    expect(options.reportAvailability).toHaveBeenCalledOnce();
    current = { ...current, configurationRevision: 5 };
    await expect(
      runtime.channels.reportRuntimeAvailability(channelScope, {
        availability: "available",
      }),
    ).rejects.toThrow();
    await runtime.close();
    current = options.record;
    await expect(
      runtime.channels.reportRuntimeAvailability(channelScope, {
        availability: "available",
      }),
    ).rejects.toThrow();
  });

  it("rejects another environment or an out-of-root workspace before constructing a tool consumer", async () => {
    const runtime = await createExecutionEnvironmentRuntime(
      input(
        remote({
          kind: "sidecar",
          enabledCapabilities: ["workspace_tools", "workspace_context"],
        }),
      ),
    );
    const tools = runtime.operations.workspaceTools;
    expect(tools.availability).toBe("available");
    if (tools.availability !== "available") throw new Error("expected tools");
    expect(() => tools.forWorkspace(workspace("other", "/workspace"))).toThrow(
      "environment_workspace_operations_unavailable",
    );
    expect(() =>
      tools.forWorkspace(workspace(environmentId, "/outside")),
    ).toThrow("environment_workspace_operations_unavailable");
    expect(() =>
      tools.forWorkspace(workspace(environmentId, "/workspace/project")),
    ).not.toThrow();
    await runtime.close();
  });

  it("unwinds only its local resources if sandbox artifact loading fails", async () => {
    const providerClose = vi.spyOn(
      LocalExecutionEnvironment.prototype,
      "close",
    );
    const channelsClose = vi.spyOn(
      LocalEnvironmentChannelProvider.prototype,
      "close",
    );
    const filesClose = vi.spyOn(LocalWorkspaceFileProvider.prototype, "close");
    const options = input(local(["/tmp"]));
    await expect(
      createExecutionEnvironmentRuntime({
        ...options,
        localPiBackendInstanceIds: ["pi"],
        sandboxProbe: async () => true,
        sandboxWorkerArtifact: async () => {
          throw new Error("missing sandbox artifact");
        },
      }),
    ).rejects.toThrow("missing sandbox artifact");
    expect(providerClose).toHaveBeenCalledOnce();
    expect(channelsClose).toHaveBeenCalledOnce();
    expect(filesClose).toHaveBeenCalledOnce();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("retains explicit unavailable Pi isolation without advertising unavailable network profiles", async () => {
    const runtime = await createExecutionEnvironmentRuntime({
      ...input(local(["/tmp"])),
      localPiBackendInstanceIds: ["pi-one", "pi-two"],
    });
    expect([...runtime.workspaceIsolations.keys()]).toEqual([
      "pi-one",
      "pi-two",
    ]);
    expect(runtime.networkProfiles.size).toBe(0);
    await runtime.close();
  });
});
