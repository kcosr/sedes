import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ConfigurationEnvironment } from "../../shared/protocol/configuration-admin.js";
import { SidecarOperationRegistry } from "../../internal/sidecar-protocol/index.js";
import { sidecarServiceScopeSchema, type SidecarServiceScope, type SidecarServiceConfiguration } from "../../internal/sidecar-protocol/service-management-v1.js";
import type { BackendAgentToolFacade } from "../agent-tools/adapters/backend-facade.js";
import type { EnvironmentScopedAgentToolSourceResolver } from "../agent-tools/application/database-agent-tool-source-authority.js";
import { registerSidecarAgentToolRelayOperations } from "../agent-tools/sidecar/sidecar-agent-tool-relay.js";
import type { InventoryEnvironmentRecord } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ExecutionEnvironmentProvider,
  ValidatedWorkspace,
} from "../execution/contracts.js";
import {
  validEnvironmentChannelScope,
  type ExecutionEnvironmentChannelProvider,
} from "../execution/environment-channel.js";
import {
  unavailableEnvironmentOperations,
  type EnvironmentOperations,
} from "../execution/environment-operations.js";
import { LocalExecutionEnvironment } from "../execution/local-execution-environment.js";
import { LocalEnvironmentChannelProvider } from "../execution/local-environment-channel.js";
import { LocalInteractiveTerminalProvider } from "../execution/local-interactive-terminal-provider.js";
import type { InteractiveTerminalEnvironmentProvider } from "../execution/interactive-terminal.js";
import { RemoteExecutionEnvironment } from "../execution/remote-execution-environment.js";
import { isWithinRemoteRoot } from "../execution/remote-path.js";
import { SshEnvironmentAvailabilityAggregator } from "../execution/ssh-environment-availability.js";
import { SshInteractiveTerminalProvider } from "../execution/ssh-interactive-terminal-provider.js";
import { SshEnvironmentError } from "../execution/ssh-open-ssh.js";
import { SidecarDirectoryBrowserProvider } from "../execution/sidecar-directory-browser-provider.js";
import type { ThreadWorkspaceIsolationResolver } from "../execution/thread-workspace-isolation.js";
import { LocalExecutionAttachmentStager } from "../composer-attachments/local-execution-attachment-stager.js";
import { SidecarExecutionAttachmentStager } from "../composer-attachments/sidecar-execution-attachment-stager.js";
import {
  UnsupportedExecutionAttachmentStager,
  type ExecutionAttachmentStager,
} from "../composer-attachments/execution-attachment-stager.js";
import { LocalWorkspaceFileProvider } from "../workspace-files/local-workspace-file-provider.js";
import { SidecarWorkspaceFileProvider } from "../workspace-files/sidecar-workspace-file-provider.js";
import {
  UnsupportedWorkspaceFileProvider,
  type WorkspaceFileProvider,
} from "../workspace-files/contracts.js";
import { SidecarWorkspaceToolExecutor } from "../workspace-tools/sidecar-workspace-tool-executor.js";
import { SidecarWorkspaceContextReader } from "../workspace-context/sidecar-workspace-context-reader.js";
import { SidecarWorkspaceSkillReader } from "../workspace-skills/sidecar-workspace-skill-reader.js";
import { LocalPiSandboxRuntime } from "../pi-sandbox/local-pi-sandbox-runtime.js";
import {
  LocalThreadWorkspaceIsolationResolver,
  UnavailableThreadWorkspaceIsolationResolver,
} from "../pi-sandbox/local-thread-workspace-isolation.js";
import type { PiSandboxAllocationRepository } from "../pi-sandbox/pi-sandbox-allocation-repository.js";
import type { PiSandboxMaterializer } from "../pi-sandbox/pi-sandbox-materializer.js";
import { loadPiSandboxWorkerArtifact } from "../pi-sandbox/pi-sandbox-worker-artifact.js";
import { defaultPiSandboxSystemMounts } from "../pi-sandbox/bubblewrap-policy.js";
import { deriveAgentToolCliEndpointKey } from "../security/installation-secret.js";
import type { SidecarArtifactRegistration } from "../sidecar/sidecar-artifact.js";
import { SshSidecarArtifactInstaller } from "../sidecar/ssh-sidecar-artifact-installer.js";
import type { SidecarProvisioner } from "../sidecar/sidecar-provisioner.js";
import { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import {
  SidecarRuntimeOwner,
  type SidecarRuntimeOwnerOptions,
} from "../sidecar/sidecar-runtime.js";
import { StartupResourceStack } from "./startup-resource-stack.js";

type SidecarRuntime = SidecarRuntimeOwner<SidecarClientSession>;

export interface ExecutionEnvironmentRuntime {
  readonly environmentId: string;
  readonly provider: ExecutionEnvironmentProvider;
  readonly channels: ExecutionEnvironmentChannelProvider;
  readonly workspaceFiles: WorkspaceFileProvider;
  readonly attachments: ExecutionAttachmentStager;
  readonly terminal?: InteractiveTerminalEnvironmentProvider;
  readonly operations: EnvironmentOperations;
  readonly sidecarRuntime?: SidecarRuntime;
  /** Present only when the environment grants the agent-tools CLI capability. */
  readonly agentToolCliRuntime?: SidecarRuntime;
  readonly workspaceIsolations: ReadonlyMap<
    string,
    ThreadWorkspaceIsolationResolver
  >;
  readonly networkProfiles: ReadonlyMap<
    string,
    readonly ("isolated" | "execution_host")[]
  >;
  /** Caller first fences admissions, drains operations and detaches terminals.
   * Remote close detaches this controller; it does not stop the sidecar. */
  close(): Promise<void>;
}

export interface ExecutionEnvironmentRuntimeInput {
  readonly outboundConnection?: {
    createProvisioner(input: {
      readonly artifact: SidecarArtifactRegistration;
      readonly serviceScope: SidecarServiceScope;
      readonly configuration: SidecarServiceConfiguration;
      readonly agentToolEndpointKey: string;
    }): SidecarProvisioner;
    isConnected(): boolean;
    subscribe(listener: (connected: boolean) => void): () => void;
  };
  readonly configured: ConfigurationEnvironment;
  readonly record: InventoryEnvironmentRecord;
  readonly scope: RequestScope;
  readonly stateDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly toolProvenanceKey: Uint8Array;
  readonly installationId: string;
  /** Compiled backend grants are independent of ancillary Files/tool grants. */
  readonly authorizedRuntimeCapabilities: SidecarRuntimeOwnerOptions<SidecarClientSession>["authorizedRuntimeCapabilities"];
  readonly activeEnvironmentRecord: () => InventoryEnvironmentRecord;
  readonly automaticConnectionEnabled: () => boolean | Promise<boolean>;
  readonly reportAvailability: (
    available: boolean,
    diagnosticCode?: string,
  ) => void | Promise<void>;
  readonly sidecarArtifact: () => Promise<SidecarArtifactRegistration>;
  readonly agentToolSources: EnvironmentScopedAgentToolSourceResolver;
  readonly agentTools: BackendAgentToolFacade;
  readonly localPiBackendInstanceIds: readonly string[];
  readonly piSandbox: {
    readonly allocations: PiSandboxAllocationRepository;
    readonly materializer: PiSandboxMaterializer;
  };
  readonly onBackgroundError: (error: unknown) => void;
  readonly sidecarAccountHomeForTests?: string;
  /** Deterministic local capability/packaging probes for composition tests. */
  readonly sandboxProbe?: (filename: string) => Promise<boolean>;
  readonly sandboxWorkerArtifact?: () => ReturnType<
    typeof loadPiSandboxWorkerArtifact
  >;
}

/** Builds one environment without publishing it or initiating an SSH connection.
 * Main's reconciliation authority owns retirement and atomic map publication.
 * Local provider configuration and remote service identity never use a global
 * workspace-root fallback or a browser-selected principal. */
export async function createExecutionEnvironmentRuntime(
  input: ExecutionEnvironmentRuntimeInput,
): Promise<ExecutionEnvironmentRuntime> {
  const { configured, record, scope } = input;
  assertRecord(scope, configured, record);
  const activeRecord = () => {
    const current = input.activeEnvironmentRecord();
    assertRecord(scope, configured, current);
    return current;
  };
  const activeConfigurationRevision = () =>
    activeRecord().configurationRevision;
  const resources = new StartupResourceStack();
  const workspaceIsolations = new Map<
    string,
    ThreadWorkspaceIsolationResolver
  >();
  const networkProfiles = new Map<
    string,
    readonly ("isolated" | "execution_host")[]
  >();
  const close = () => resources.dispose();
  try {
    if (configured.kind === "local") {
      const provider = new LocalExecutionEnvironment({
        environmentId: record.id,
        scope,
        allowedRoots: configured.workspaceRoots,
        label: configured.label,
        environment: input.environment,
        configurationRevision: record.configurationRevision,
        activeConfigurationRevision,
      });
      resources.defer("local execution provider", () => provider.close(), {
        mode: "ownership_critical",
      });
      const channels = new LocalEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: record.id,
        environment: input.environment,
      });
      resources.defer("local execution channels", () => channels.close(), {
        mode: "ownership_critical",
      });
      const workspaceFiles = new LocalWorkspaceFileProvider({
        scope,
        environmentId: record.id,
      });
      resources.defer("local workspace files", () => workspaceFiles.close(), {
        mode: "ownership_critical",
      });
      const attachments = new LocalExecutionAttachmentStager({
        scope,
        environmentId: record.id,
        stateDirectory: input.stateDirectory,
        installationKey: input.toolProvenanceKey,
      });
      resources.defer("local attachment staging", () => attachments.close(), {
        mode: "ownership_critical",
      });
      const terminal = new LocalInteractiveTerminalProvider({
        scope,
        environmentId: record.id,
        environment: input.environment,
      });
      const localPiIds = [...new Set(input.localPiBackendInstanceIds)];
      if (localPiIds.length > 0) {
        const sandboxAvailable = await (
          input.sandboxProbe ?? bubblewrapRuntimeAvailable
        )("/usr/bin/bwrap");
        if (sandboxAvailable) {
          const artifact = await (
            input.sandboxWorkerArtifact ??
            (() =>
              loadPiSandboxWorkerArtifact(
                path.resolve(
                  path.dirname(fileURLToPath(import.meta.url)),
                  "../../../dist/pi-sandbox-worker/manifest.json",
                ),
              ))
          )();
          const runtime = new LocalPiSandboxRuntime({
            environmentLabel: configured.label,
            channels,
            bubblewrapExecutablePath: "/usr/bin/bwrap",
            workerNodePath: process.execPath,
            workerArtifact: artifact,
          });
          resources.defer("local Pi sandbox runtime", () => runtime.close(), {
            mode: "ownership_critical",
          });
          for (const backendInstanceId of localPiIds) {
            const profiles = Object.freeze([
              ...configured.workspaceIsolation.networkProfiles,
            ]);
            networkProfiles.set(backendInstanceId, profiles);
            workspaceIsolations.set(
              backendInstanceId,
              new LocalThreadWorkspaceIsolationResolver({
                allocations: input.piSandbox.allocations,
                materializer: input.piSandbox.materializer,
                runtime,
                backendInstanceId,
                admittedNetworkProfiles: new Set(profiles),
              }),
            );
          }
        } else {
          for (const backendInstanceId of localPiIds)
            workspaceIsolations.set(
              backendInstanceId,
              new UnavailableThreadWorkspaceIsolationResolver(
                input.piSandbox.allocations,
              ),
            );
        }
      }
      return {
        environmentId: record.id,
        provider,
        channels,
        workspaceFiles,
        attachments,
        terminal,
        operations: unavailableEnvironmentOperations({
          environmentId: record.id,
          environmentKind: "local",
          environmentLabel: configured.label,
        }),
        workspaceIsolations,
        networkProfiles,
        close,
      };
    }

    const outbound = configured.kind === "outbound" ? input.outboundConnection : undefined;
    if (configured.kind === "outbound" && !outbound) throw new Error("outbound_connection_registry_unavailable");
    const platform = configured.kind === "outbound" ? configured.platform : "linux";
    let directoryBrowser: SidecarDirectoryBrowserProvider | undefined;
    const provider = new RemoteExecutionEnvironment({
      ...(configured.kind === "outbound"
        ? {kind: "outbound" as const, isExecutionAvailable: () => outbound!.isConnected()}
        : {kind: "ssh" as const}),
      platform,
      environmentId: record.id,
      scope,
      allowedRoots: configured.workspaceRoots,
      label: configured.label,
      availability: outbound ? "unavailable" : record.availability,
      diagnosticCode: outbound ? "outbound_environment_connecting" : record.diagnosticCode,
      revision: record.revision,
      configurationRevision: record.configurationRevision,
      activeConfigurationRevision,
      reportAvailability: input.reportAvailability,
      directoryBrowser: () => directoryBrowser,
    });
    resources.defer("remote execution provider", () => provider.close(), {
      mode: "ownership_critical",
    });
    const availability = new SshEnvironmentAvailabilityAggregator({
      configurationRevision: record.configurationRevision,
      activeConfigurationRevision,
      reportAvailability: (available, diagnosticCode) =>
        provider.observeAvailability(available, diagnosticCode),
    });
    let channelsClosed = false;
    // Remote provider protocols run inside the sidecar. This facade deliberately
    // has no raw SSH socket/worker/process/secret path around that owner.
    const unsupported = async (): Promise<never> => {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_environment_capability_unsupported",
      );
    };
    const channels: ExecutionEnvironmentChannelProvider = {
      scope: Object.freeze({ ...scope }),
      executionEnvironmentId: record.id,
      reportRuntimeAvailability: async (requestScope, observation) => {
        if (
          channelsClosed ||
          !validEnvironmentChannelScope(requestScope) ||
          requestScope.tenantId !== scope.tenantId ||
          requestScope.principalId !== scope.principalId ||
          requestScope.executionEnvironmentId !== record.id ||
          activeConfigurationRevision() !== record.configurationRevision
        ) {
          throw new SshEnvironmentError(
            "unavailable",
            "ssh_environment_capability_unsupported",
          );
        }
        // Outbound reachability belongs to the current sidecar attachment;
        // stale backend observations cannot revive a disconnected host.
        if (!outbound) await availability.reportBackendObservation(requestScope.backendInstanceId, observation);
      },
      resolveDirectory: unsupported,
      prepareOwnedProcess: unsupported,
      openOwnedProcess: unsupported,
      openPrivateUnixStream: unsupported,
      openAssuredTcpStream: unsupported,
      resolveSecret: unsupported,
    };
    resources.defer(
      "SSH environment channels",
      () => {
        channelsClosed = true;
      },
      { mode: "ownership_critical" },
    );
    // The management owner remains available to inspect and retire resources
    // retained by an earlier configuration, even with no normal runtime grants.
    const artifact = await input.sidecarArtifact();
    const installerOptions = {
      artifact,
      serviceScope: sidecarServiceScopeSchema.parse({
        installationId: input.installationId,
        ...scope,
        executionEnvironmentId: record.id,
      }),
      configuration: {
        environmentRevision: record.configurationRevision,
        operationsRevision: record.operationsConfigurationRevision,
      },
      agentToolEndpointKey: deriveAgentToolCliEndpointKey(
        input.toolProvenanceKey,
        scope,
        record.id,
      ),
      ...(input.sidecarAccountHomeForTests
        ? { testOnlyAccountHome: input.sidecarAccountHomeForTests }
        : {}),
    };
    const provisioner = configured.kind === "ssh"
      ? new SshSidecarArtifactInstaller({...installerOptions, host: configured.hostAlias})
      : outbound!.createProvisioner(installerOptions);
    const sedesOperations = new SidecarOperationRegistry();
    const capabilities =
      configured.operations.kind === "sidecar"
        ? configured.operations.enabledCapabilities
        : [];
    const agentToolCliEnabled = capabilities.includes("agent_tools_cli");
    if (agentToolCliEnabled)
      registerSidecarAgentToolRelayOperations(sedesOperations, {
        authority: { scope, executionEnvironmentId: record.id },
        sources: input.agentToolSources,
        tools: input.agentTools,
      });
    const runtimeOptions = {
      scope,
      executionEnvironmentId: record.id,
      environmentConfigurationRevision: record.configurationRevision,
      operationsConfigurationRevision: record.operationsConfigurationRevision,
      activeEnvironmentConfigurationRevision: activeConfigurationRevision,
      activeOperationsConfigurationRevision: () =>
        activeRecord().operationsConfigurationRevision,
      isAutomaticConnectionEnabled: input.automaticConnectionEnabled,
      isTransportAvailable: () => !outbound || outbound.isConnected(),
      artifact,
      provisioner,
      authorizedRuntimeCapabilities: input.authorizedRuntimeCapabilities,
      authorizedCapabilities: capabilities.map((capabilityId) =>
        capabilityId === "workspace_files"
          ? ({ capabilityId, majorVersion: 7 } as const)
          : capabilityId === "agent_tools_cli"
            ? ({ capabilityId, majorVersion: 3 } as const)
            : capabilityId === "workspace_tools"
              ? ({ capabilityId, majorVersion: 2 } as const)
            : capabilityId === "interactive_terminal"
              ? ({ capabilityId, majorVersion: 2 } as const)
              : ({ capabilityId, majorVersion: 1 } as const),
      ),
      sedesOperations,
      startSession: SidecarClientSession.start,
      onLifecycleEvidence: (
        evidence: Parameters<
          SshEnvironmentAvailabilityAggregator["reportSidecarObservation"]
        >[0],
      ) => outbound
        ? provider.observeAvailability(outbound.isConnected() && evidence.availability === "available",
          evidence.availability === "unavailable" ? evidence.diagnosticCode : "outbound_environment_offline")
        : availability.reportSidecarObservation(evidence),
      onBackgroundError: input.onBackgroundError,
    };
    const runtime = new SidecarRuntimeOwner<SidecarClientSession>(
      runtimeOptions,
    );
    resources.defer(
      "persistent sidecar attachment",
      () => runtime.close("environment_runtime_retired"),
      { mode: "ownership_critical" },
    );
    if (outbound) {
      const controller = new AbortController();
      let tail: Promise<void> = Promise.resolve();
      const changed = (connected: boolean) => {
        // Mark a lost connection synchronously at its owning registry; this
        // serialized path joins cleanup before attaching its successor.
        tail = tail.then(async () => {
          if (controller.signal.aborted) return;
          if (!connected || !outbound.isConnected()) {
            await provider.observeAvailability(false, "outbound_environment_offline");
            await runtime.disconnectTransport("outbound_connection_lost");
          } else if (await input.automaticConnectionEnabled()) {
            try { await runtime.connect(controller.signal); }
            catch (error) {
              if (!controller.signal.aborted) {
                await provider.observeAvailability(false, "outbound_runtime_unavailable");
                input.onBackgroundError(error);
              }
            }
          }
        }).catch(input.onBackgroundError);
      };
      const unsubscribe = outbound.subscribe(changed);
      changed(outbound.isConnected());
      resources.defer("outbound connection subscription", async () => {
        unsubscribe(); controller.abort(); await tail;
      }, {mode: "ownership_critical"});
    }
    const terminal = new SshInteractiveTerminalProvider({
      scope,
      environmentId: record.id,
      configurationRevision: record.configurationRevision,
      activeConfigurationRevision,
      runtime,
      enabled: capabilities.includes("interactive_terminal"),
    });
    if (capabilities.includes("directory_browser"))
      directoryBrowser = new SidecarDirectoryBrowserProvider({
        platform,
        scope,
        environmentId: record.id,
        policyRoots: configured.workspaceRoots,
        runtime,
      });
    const workspaceFiles = capabilities.includes("workspace_files")
      ? new SidecarWorkspaceFileProvider({
          scope,
          environmentId: record.id,
          policyRoots: configured.workspaceRoots,
          runtime,
        })
      : new UnsupportedWorkspaceFileProvider();
    resources.defer("remote workspace files", () => workspaceFiles.close(), {
      mode: "ownership_critical",
    });
    const attachments = capabilities.includes("composer_attachments")
      ? new SidecarExecutionAttachmentStager({
          scope,
          environmentId: record.id,
          installationKey: input.toolProvenanceKey,
          runtime,
        })
      : new UnsupportedExecutionAttachmentStager();
    resources.defer("remote attachment staging", () => attachments.close(), {
      mode: "ownership_critical",
    });
    return {
      environmentId: record.id,
      provider,
      channels,
      workspaceFiles,
      attachments,
      terminal,
      sidecarRuntime: runtime,
      ...(agentToolCliEnabled ? { agentToolCliRuntime: runtime } : {}),
      operations: sidecarEnvironmentOperations({
        scope,
        environmentKind: configured.kind,
        environmentId: record.id,
        environmentLabel: configured.label,
        policyRoots: configured.workspaceRoots,
        runtime,
        enabledCapabilities: capabilities,
      }),
      workspaceIsolations,
      networkProfiles,
      close,
    };
  } catch (error) {
    await resources.dispose(error);
    throw error;
  }
}

function assertRecord(
  scope: RequestScope,
  configured: ConfigurationEnvironment,
  record: InventoryEnvironmentRecord,
): void {
  if (
    !scope.tenantId ||
    !scope.principalId ||
    record.tenantId !== scope.tenantId ||
    record.ownerPrincipalId !== scope.principalId ||
    record.id !== configured.id ||
    record.kind !== configured.kind
  ) {
    throw new Error("execution_environment_runtime_scope_invalid");
  }
}

function sidecarEnvironmentOperations(input: {
  readonly scope: RequestScope;
  readonly environmentKind: "ssh" | "outbound";
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly policyRoots: readonly string[];
  readonly runtime: SidecarRuntime;
  readonly enabledCapabilities: readonly string[];
}): EnvironmentOperations {
  const policyRoot = (workspace: ValidatedWorkspace): string => {
    if (workspace.summary.environmentId !== input.environmentId)
      throw new Error("environment_workspace_operations_unavailable");
    const root = input.policyRoots
      .filter((candidate) => isWithinRemoteRoot(workspace.canonicalPath, candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (!root) throw new Error("environment_workspace_operations_unavailable");
    return root;
  };
  const workspaceOperationsEnabled =
    input.enabledCapabilities.includes("workspace_tools") &&
    input.enabledCapabilities.includes("workspace_context");
  const unavailable = Object.freeze({
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  });
  return Object.freeze({
    environmentId: input.environmentId,
    environmentKind: input.environmentKind,
    environmentLabel: input.environmentLabel,
    workspaceTools: workspaceOperationsEnabled
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceToolExecutor({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              policyRootPath: policyRoot(workspace),
            }),
        })
      : unavailable,
    workspaceContext: workspaceOperationsEnabled
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceContextReader({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              policyRootPath: policyRoot(workspace),
            }),
        })
      : unavailable,
    workspaceSkills: input.enabledCapabilities.includes("workspace_skills")
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceSkillReader({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              policyRootPath: policyRoot(workspace),
            }),
        })
      : unavailable,
  });
}

const execFile = promisify(execFileCallback);

async function bubblewrapRuntimeAvailable(filename: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const canonical = await realpath(filename).catch(() => undefined);
  const metadata = canonical
    ? await stat(canonical).catch(() => undefined)
    : undefined;
  if (
    !canonical ||
    !metadata?.isFile() ||
    !(await access(canonical, fsConstants.X_OK).then(
      () => true,
      () => false,
    ))
  )
    return false;
  const mounts: string[] = [];
  for (const mount of defaultPiSandboxSystemMounts())
    if (await stat(mount).catch(() => undefined))
      mounts.push("--ro-bind", mount, mount);
  try {
    await execFile(
      filename,
      [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--assert-userns-disabled",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        ...mounts,
        "--",
        "/usr/bin/true",
      ],
      { env: {}, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}
