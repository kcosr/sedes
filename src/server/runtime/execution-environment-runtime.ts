import { canonicalLocalWorkspaceRoots } from "../execution/local-workspace-roots.js";
import type { InstalledExecutionPolicy } from "../../internal/sidecar-protocol/execution-policy.js";
import { execFile as execFileCallback } from "node:child_process";
import { AGENT_TOOL_CLI_CAPABILITY } from "../../internal/agent-tool-cli-protocol/capability.js";
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
import { workspaceRootGrant } from "../execution/workspace-root-grant.js";
import { SshEnvironmentAvailabilityAggregator } from "../execution/ssh-environment-availability.js";
import { SshInteractiveTerminalProvider } from "../execution/ssh-interactive-terminal-provider.js";
import { SshEnvironmentError } from "../execution/ssh-open-ssh.js";
import { SidecarDirectoryBrowserProvider } from "../execution/sidecar-directory-browser-provider.js";
import type { ThreadWorkspaceIsolationResolver } from "../execution/thread-workspace-isolation.js";
import { LocalExecutionAttachmentStager } from "../composer-attachments/local-execution-attachment-stager.js";
import { SidecarExecutionAttachmentStager } from "../composer-attachments/sidecar-execution-attachment-stager.js";
import {
  type ExecutionAttachmentStager,
} from "../composer-attachments/execution-attachment-stager.js";
import { LocalWorkspaceFileProvider } from "../workspace-files/local-workspace-file-provider.js";
import { SidecarWorkspaceFileProvider } from "../workspace-files/sidecar-workspace-file-provider.js";
import {
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
  readonly ensureLocalPiBackend?: (backendInstanceId: string) => Promise<void>;
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
  readonly readDesiredPolicy?: () => InstalledExecutionPolicy;
  readonly onPolicyChanged?: () => void;
  readonly policyRecovery?: SidecarRuntimeOwnerOptions<SidecarClientSession>["policyRecovery"];
  readonly readWorkspaceBinding?: (workspaceId: string, rootId?: string) => {authorityRootId?: string; authorityRevision: number} | undefined;
  readonly readWorkspaceRoots: () => InstalledExecutionPolicy["snapshot"]["roots"];
  readonly outboundConnection?: {
    createProvisioner(input: {
      readonly artifact: SidecarArtifactRegistration;
      readonly serviceScope: SidecarServiceScope;
      readonly configuration: SidecarServiceConfiguration;
      readonly requiresPolicyRecovery?: (incarnation: string) => boolean;
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
  readonly connectionCompression: () => boolean;
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
  // A replaced transport invalidates the owner through close(). Durable policy
  // revisions advance on live edits and cannot identify the transport.
  const activeConfigurationRevision = () => { activeRecord(); return record.configurationRevision; };
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
        readWorkspaceRoots: input.readWorkspaceRoots,
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
        readWorkspaceRoots: input.readWorkspaceRoots,
        readWorkspaceBinding: input.readWorkspaceBinding,
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
      let sandboxRuntime: Promise<LocalPiSandboxRuntime | undefined> | undefined;
      let sandboxClosed = false;
      const prepareSandbox = async () => {
        if (!(await (input.sandboxProbe ?? bubblewrapRuntimeAvailable)("/usr/bin/bwrap"))) return undefined;
        const artifact = await (input.sandboxWorkerArtifact ?? (() => loadPiSandboxWorkerArtifact(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/pi-sandbox-worker/manifest.json"),
        )))();
        return new LocalPiSandboxRuntime({
          environmentLabel: configured.label, channels, bubblewrapExecutablePath: "/usr/bin/bwrap",
          workerNodePath: process.execPath, workerArtifact: artifact,
        });
      };
      resources.defer("local Pi sandbox runtime", async () => {
        sandboxClosed = true;
        await (await sandboxRuntime)?.close();
      }, {mode: "ownership_critical"});
      const ensureLocalPiBackend = async (backendInstanceId: string) => {
        if (sandboxClosed) throw new Error("environment_runtime_retired");
        if (workspaceIsolations.has(backendInstanceId)) return;
        sandboxRuntime ??= prepareSandbox().catch(error => { sandboxRuntime = undefined; throw error; });
        const runtime = await sandboxRuntime;
        if (sandboxClosed) throw new Error("environment_runtime_retired");
        if (runtime) {
          const profiles = Object.freeze([...configured.workspaceIsolation.networkProfiles]);
          networkProfiles.set(backendInstanceId, profiles);
          workspaceIsolations.set(backendInstanceId, new LocalThreadWorkspaceIsolationResolver({
            allocations: input.piSandbox.allocations, materializer: input.piSandbox.materializer, runtime,
            readWorkspaceRoots: () => canonicalLocalWorkspaceRoots(input.readWorkspaceRoots()), backendInstanceId, admittedNetworkProfiles: new Set(profiles),
          }));
        } else {
          workspaceIsolations.set(backendInstanceId, new UnavailableThreadWorkspaceIsolationResolver(input.piSandbox.allocations, () => canonicalLocalWorkspaceRoots(input.readWorkspaceRoots())));
        }
      };
      for (const backendId of input.localPiBackendInstanceIds) await ensureLocalPiBackend(backendId);
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
        ensureLocalPiBackend,
        workspaceIsolations,
        networkProfiles,
        close,
      };
    }

    const outbound = configured.kind === "outbound" ? input.outboundConnection : undefined;
    if (configured.kind === "outbound" && !outbound) throw new Error("outbound_connection_registry_unavailable");
    const platform = configured.kind === "outbound" ? configured.platform : "linux";
    const readDesiredPolicy = input.readDesiredPolicy;
    if (!readDesiredPolicy) throw new Error("remote_execution_policy_missing");
    const readWorkspaceRoots = () => runtime.acquirableWorkspaceRoots();
    const readRootPaths = () => readWorkspaceRoots().map(root => root.path);
    let directoryBrowser: SidecarDirectoryBrowserProvider | undefined;
    const provider = new RemoteExecutionEnvironment({
      ...(configured.kind === "outbound"
        ? {kind: "outbound" as const, isExecutionAvailable: () => outbound!.isConnected()}
        : {kind: "ssh" as const}),
      platform,
      environmentId: record.id,
      scope,
      allowedRoots: configured.workspaceRoots,
      confirmWorkspacePolicy: () => runtime.confirmWorkspacePolicy(),
      readWorkspaceRoots,
      label: configured.label,
      availability: outbound ? "unavailable" : record.availability,
      diagnosticCode: outbound ? "outbound_environment_connecting" : record.diagnosticCode,
      revision: record.revision,
      configurationRevision: record.configurationRevision,
      activeConfigurationRevision,
      reportAvailability: input.reportAvailability,
      directoryBrowser: () => readDesiredPolicy().snapshot.capabilities.some(grant => grant.id === "directory_browser") ? directoryBrowser : undefined,
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
      requiresPolicyRecovery: (id: string) => input.policyRecovery?.blocked(id) === true,
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
    registerSidecarAgentToolRelayOperations(sedesOperations, {
      authority: { scope, executionEnvironmentId: record.id },
      sources: input.agentToolSources,
      tools: input.agentTools,
      retainRoute: binding => runtime.retainToolRoute(binding.backendInstanceId, binding.backendGeneration, binding.capabilityGeneration),
      authorizeSource: (backendId, binding) => runtime.policyRouteGeneration(backendId) === binding.capabilityGeneration &&
        runtime.policyBackendGeneration(backendId) === binding.backendGeneration,
      openCodeTools: true,
    });
    const runtimeOptions = {
      readDesiredPolicy,
      onPolicyChanged: input.onPolicyChanged,
      policyRecovery: input.policyRecovery,
      scope,
      executionEnvironmentId: record.id,
      isAutomaticConnectionEnabled: input.automaticConnectionEnabled,
      connectionCompression: input.connectionCompression,
      isTransportAvailable: () => !outbound || outbound.isConnected(),
      artifact,
      provisioner,
      authorizedRuntimeCapabilities: input.authorizedRuntimeCapabilities,
      authorizedCapabilities: (["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills",
        "composer_attachments", "agent_tools_cli", "interactive_terminal"] as const).map((capabilityId) =>
        capabilityId === "workspace_files"
          ? ({ capabilityId, majorVersion: 8 } as const)
          : capabilityId === "agent_tools_cli"
            ? AGENT_TOOL_CLI_CAPABILITY
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
    const runtime: SidecarRuntime = new SidecarRuntimeOwner<SidecarClientSession>(
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
      enabled: true,
      readWorkspaceRoots,
      readTerminalGeneration: () => runtime.acquirableCapabilityGeneration("interactive_terminal"),
    });
    directoryBrowser = new SidecarDirectoryBrowserProvider({
        platform,
        scope,
        environmentId: record.id,
        policyRoots: configured.workspaceRoots,
        readPolicyRoots: readRootPaths,
        confirmed: () => runtime.canAcquireCapability("directory_browser", 1),
        readWorkspaceRoots,
        readFeatureGeneration: () => runtime.policyCapabilityGeneration("directory_browser"),
        confirmWorkspacePolicy: () => runtime.confirmWorkspacePolicy(),
        runtime,
      });
    const workspaceFiles = new SidecarWorkspaceFileProvider({
          scope,
          environmentId: record.id,
          policyRoots: configured.workspaceRoots,
          readPolicyRoots: readRootPaths, enabled: () => runtime.canAcquireCapability("workspace_files", 8),
            selectPolicyRoot: (candidate, workspaceId, rootId) => {
              const binding = workspaceId ? input.readWorkspaceBinding?.(workspaceId, rootId) : undefined;
              if (workspaceId && !binding) return undefined;
              const grant = workspaceRootGrant(readWorkspaceRoots(), candidate, binding);
              const featureGeneration = runtime.acquirableCapabilityGeneration("workspace_files");
              return grant && featureGeneration !== undefined ? {path: grant.path, key: `${grant.id}/${grant.generation}/${featureGeneration}`} : undefined;
            },
          runtime,
        });
    resources.defer("remote workspace files", () => workspaceFiles.close(), {
      mode: "ownership_critical",
    });
    const attachments = new SidecarExecutionAttachmentStager({
          scope,
          environmentId: record.id,
          installationKey: input.toolProvenanceKey,
          enabled: () => runtime.canAcquireCapability("composer_attachments", 1),
          readAttachmentGeneration: () => runtime.acquirableCapabilityGeneration("composer_attachments"),
          runtime,
        });
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
      agentToolCliRuntime: runtime,
      operations: sidecarEnvironmentOperations({
        scope,
        environmentKind: configured.kind,
        environmentId: record.id,
        environmentLabel: configured.label,
        readWorkspaceRoots,
        runtime,
        enabled: (id, version) => runtime.canAcquireCapability(id, version),
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
  readonly readWorkspaceRoots: ExecutionEnvironmentRuntimeInput["readWorkspaceRoots"];
  readonly runtime: SidecarRuntime;
  readonly enabled: (id: string, version: number) => boolean;
}): EnvironmentOperations {
  const workspaceAdmission = (workspace: ValidatedWorkspace, feature: string) => {
    if (workspace.summary.environmentId !== input.environmentId)
      throw new Error("environment_workspace_operations_unavailable");
    const grant = workspaceRootGrant(input.readWorkspaceRoots(), workspace.canonicalPath, workspace);
    const generation = input.runtime.acquirableCapabilityGeneration(feature);
    if (!grant || generation === undefined) throw new Error("environment_workspace_operations_unavailable");
    return {policyRootPath: grant.path, assertCurrent() {
      if (input.runtime.acquirableCapabilityGeneration(feature) !== generation ||
          !workspaceRootGrant(input.readWorkspaceRoots(), workspace.canonicalPath, workspace)) {
        throw new Error("environment_workspace_operations_unavailable");
      }
    }};
  };
  const workspaceOperationsEnabled = () => input.enabled("workspace_tools", 2) && input.enabled("workspace_context", 1);
  const unavailable = Object.freeze({
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  });
  return Object.freeze({
    environmentId: input.environmentId,
    environmentKind: input.environmentKind,
    environmentLabel: input.environmentLabel,
    get workspaceTools() { return workspaceOperationsEnabled()
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceToolExecutor({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              ...workspaceAdmission(workspace, "workspace_tools"),
            }),
        })
      : unavailable; },
    get workspaceContext() { return workspaceOperationsEnabled()
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceContextReader({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              ...workspaceAdmission(workspace, "workspace_context"),
            }),
        })
      : unavailable; },
    get workspaceSkills() { return input.enabled("workspace_skills", 1)
      ? Object.freeze({
          availability: "available" as const,
          implementation: "sidecar" as const,
          forWorkspace: (workspace: ValidatedWorkspace) =>
            new SidecarWorkspaceSkillReader({
              runtime: input.runtime,
              scope: input.scope,
              environmentId: input.environmentId,
              declaredPath: workspace.canonicalPath,
              ...workspaceAdmission(workspace, "workspace_skills"),
            }),
        })
      : unavailable; },
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
