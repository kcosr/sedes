import type { UsageSink } from "../usage/contracts.js";
import type { EnvironmentVariableOverrides, ConfiguredEnvironmentVariables } from "../../shared/protocol/environment-variables.js";
import type { SidecarUpgradeBlocker } from "../../internal/sidecar-protocol/service-management-v1.js";
import type { SidecarRuntimeProvider, SidecarRuntimeLease } from "../sidecar/runtime-channel.js";
import type Database from "better-sqlite3";
import type { DiscoveredBackendThreadPersistence } from "../conversations/backend-discovery-service.js";
import type { BackendBindingDetailReader } from "../conversations/database-conversation-adapters.js";
import type { BackendThreadPersistenceAdapter } from "../conversations/conversation-lifecycle-service.js";
import type { ThreadBackendPresentationProvider } from "../conversations/database-thread-application-readers.js";
import type { ThreadActionPersistenceProvider } from "../conversations/thread-mutation-gateway.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  BackendKind,
  ConnectionKind,
} from "./contracts.js";
import type { BackendDriverFactory } from "./registry.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { BackendAgentToolFacade } from "../agent-tools/adapters/backend-facade.js";
import type { ExecutionEnvironmentChannelProvider } from "../execution/environment-channel.js";
import type { ManagedTerminalResourceAuthority } from "../terminal/managed-terminal-carrier.js";
import type { SavedAgentBackendAdapter } from "./saved-agent-adapter.js";
import type { EnvironmentOperations } from "../execution/environment-operations.js";
import type { ThreadWorkspaceIsolationResolver } from "../execution/thread-workspace-isolation.js";
import type { OutputArtifactPublisher } from "../output-artifacts/contracts.js";
import type { BackendModelPolicy } from "./model-policy.js";
import type { AutomationExecutionPolicy } from "../runtime/automation-execution-policy.js";
import type { AgentToolSourceCapabilityIssuer } from "../agent-tools/application/database-agent-tool-source-authority.js";
import type { BoundedDisplayText } from "../../shared/protocol/payload.js";

export interface InstallationAdvisoryContribution {
  /** Stable within its contribution source and safe for use in a normalized ID. */
  readonly id: string;
  readonly tone: "info" | "warning" | "error";
  readonly title: BoundedDisplayText;
  readonly message: BoundedDisplayText;
}

/** Process-local active assessment source; intentionally has no durable state. */
export interface InstallationAdvisorySource {
  active(): readonly InstallationAdvisoryContribution[];
  subscribe(listener: () => void): () => void;
}

export type BackendInstallationAdvisoryContribution =
  InstallationAdvisoryContribution;
export type BackendInstallationAdvisorySource = InstallationAdvisorySource;

export const NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES: BackendInstallationAdvisorySource =
  Object.freeze({
    active: () => [],
    subscribe: () => () => undefined,
  });

export interface BackendModuleBackendConfiguration {
  readonly environmentVariables?: ConfiguredEnvironmentVariables;
  readonly id: string;
  readonly kind: BackendKind;
  /** Injected from the compiled module catalog, never parsed from operator JSON. */
  readonly protocolRelease: string;
  readonly enabled: boolean;
  readonly modelPolicy: BackendModelPolicy;
  readonly moduleConfiguration?: Readonly<Record<string, unknown>>;
}

export interface BackendModuleConnectionConfiguration {
  readonly id: string;
  readonly kind: ConnectionKind;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly enabled: boolean;
  readonly moduleConfiguration?: Readonly<Record<string, unknown>>;
}

/** Immutable operator topology available before native stores or SQLite open. */
export interface BackendModuleExecutionEnvironmentConfiguration {
  readonly environmentVariables?: ConfiguredEnvironmentVariables;
  readonly id: string;
  readonly kind: "local" | "ssh" | "outbound";
}

export interface BackendModuleConfigurationInput {
  readonly backend: BackendModuleBackendConfiguration;
  readonly connections: readonly BackendModuleConnectionConfiguration[];
  readonly executionEnvironments: readonly BackendModuleExecutionEnvironmentConfiguration[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * One exclusive claim on a provider-native persistence namespace.
 *
 * `sortKey` is stable before acquisition so the application can acquire every
 * configured native lock in one deterministic order. `namespaceKey` is opaque
 * outside the owning module and is used only to deduplicate connections that
 * address the same native conversation namespace.
 */
export interface BackendNativeStoreLifecycle {
  readonly sortKey: string;
  readonly namespaceKey: string;
  readonly label: string;
  acquire(): Promise<BackendNativeStoreLease>;
}

export interface BackendNativeNamespaceClaim {
  readonly sortKey: string;
  readonly namespaceKey: string;
}

export interface BackendNativeStoreLease {
  release(): Promise<void>;
}

export interface BackendDiscoveryAdapter {
  nativeNamespaceKey(connection: AgentConnectionProfile): string;
}

export interface BackendRuntimeAdministration {
  inspect(): Promise<{ readonly startupEnvironmentFingerprint?: string; readonly state: "idle" | "active" | "unknown"; readonly incarnation: string; readonly revision: string; readonly blockers: readonly SidecarUpgradeBlocker[] }>;
  stop(input: { readonly expectedRevision: string; readonly force: boolean }): Promise<void>;
  restart(input: { readonly expectedRevision: string; readonly force: boolean }): Promise<void>;
}

/** Recovery attaches only to an existing environment service. It must never
 * bootstrap a service, launch a provider, upgrade, or enable a backend. */
export interface BackendRuntimeRecoveryContext {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connections: readonly AgentConnectionProfile[];
  readonly sidecarRuntime: {
    acquireRecovery(signal?: AbortSignal): Promise<SidecarRuntimeLease>;
  };
}

export interface BackendModuleRuntime {
  /** Read-only launch evidence; unknown never authorizes replacing a running owner. */
  startupEnvironmentState?(): Promise<"not_started" | "started" | "unknown">;
  readonly administration?: BackendRuntimeAdministration;
  /** Explicit Stop only: end transport authority before actor cleanup can emit provider effects. */
  stopBeforeConversationCleanup?(): Promise<void>;
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly driverFactory: BackendDriverFactory;
  readonly threadPersistence: BackendThreadPersistenceAdapter;
  readonly bindingDetails: BackendBindingDetailReader;
  readonly presentation: ThreadBackendPresentationProvider;
  readonly actionPersistence: ThreadActionPersistenceProvider;
  readonly discoveryPersistence: DiscoveredBackendThreadPersistence;
  readonly discovery: BackendDiscoveryAdapter;
  /** Required explicit contribution, including the empty unsupported disposition. */
  readonly installationAdvisories: BackendInstallationAdvisorySource;
  /** Required backend-owned SavedAgent configuration contribution. */
  readonly savedAgents: SavedAgentBackendAdapter;
  /** Backend-owned validation of durable settings used by automated turns. */
  readonly automationExecutionPolicy: AutomationExecutionPolicy;
  /**
   * Required, provider-owned terminal authority. Unsupported backends expose a
   * fail-closed implementation rather than leaving composition to infer
   * support from backend kind or optional methods.
   */
  readonly managedProviderTerminals: ManagedTerminalResourceAuthority;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface BackendModuleRuntimeContext {
  readonly usage: UsageSink;
  /** Scope-bound immutable execution snapshot; secret references remain unresolved. */
  readonly executionEnvironmentVariables?: (applicationThreadId: string) => EnvironmentVariableOverrides;
  /** Persistent remote hosting channel, absent for direct local runtimes. */
  readonly sidecarRuntime?: SidecarRuntimeProvider;
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connections: readonly AgentConnectionProfile[];
  /** Exact environment-channel authority shared by every profile in this runtime. */
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
  /** Exact environment-owned operations; each backend chooses its own consumer disposition. */
  readonly environmentOperations: EnvironmentOperations;
  /** Optional thread-owned workspace isolation for this execution environment. */
  readonly workspaceIsolation?: ThreadWorkspaceIsolationResolver;
  readonly toolProvenanceKey: Uint8Array;
  readonly agentTools: BackendAgentToolFacade;
  /** Shared durable publication boundary for backend-produced binary output. */
  readonly outputArtifacts: OutputArtifactPublisher;
  /** Process-local issuer for exact provider-handle source bindings. */
  readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  /** Truthful CLI reachability from this runtime's execution environment. */
  readonly agentToolCli: AgentToolCliAvailability;
}

export type AgentToolCliAvailability =
  | {
      readonly availability: "available";
      readonly endpoint: string;
      readonly executableDirectory: string;
      readonly inheritedPath: string;
    }
  | {
      readonly availability: "unavailable";
      readonly reason: "remote_environment" | "cli_unavailable";
    }
  | {
      readonly availability: "managed";
      readonly provider: AgentToolCliRuntimeProvider;
    };

export type AgentToolCliRuntimeResolution =
  | Readonly<{
      availability: "available";
      endpoint: string;
      executableDirectory: string;
      inheritedPath: string;
      /** Settles when this exact managed endpoint generation is no longer usable. */
      readonly closed: Promise<unknown>;
      /** Idempotent, non-throwing release of the endpoint lifecycle hold. */
      release(): void;
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "remote_environment" | "cli_unavailable" | "sidecar_unavailable";
    }>;

/** Environment-owned lifecycle seam for a managed CLI endpoint. */
export interface AgentToolCliRuntimeProvider {
  acquire(options?: {
    readonly signal?: AbortSignal;
  }): Promise<AgentToolCliRuntimeResolution>;
}

/**
 * Result of provider configuration validation. It may close over parsed,
 * provider-owned configuration, but does not acquire locks, create native
 * directories, open application storage, or start provider processes.
 */
export interface PreparedBackendModule {
  readonly backendInstanceId: string;
  readonly module: BackendModule;
  readonly nativeNamespaces: readonly BackendNativeNamespaceClaim[];
  readonly nativeStores: readonly BackendNativeStoreLifecycle[];
  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime;
  /** Undefined means positively absent in the authenticated existing service;
   * unavailable carriers or mismatched authority must reject instead. */
  recoverAdministration?(context: BackendRuntimeRecoveryContext): Promise<BackendRuntimeAdministration | undefined>;
}

/**
 * Build-time provider contribution. Modules are compiled into one catalog;
 * they are not discovered or downloaded at runtime.
 */
export interface BackendModule {
  /** Compiled remote host grants, independently authorized from workspace operations. */
  readonly remoteRuntimeCapabilities?: readonly { readonly capabilityId: string; readonly majorVersion: number; readonly operations: readonly string[] }[];
  readonly backendKind: BackendKind;
  readonly connectionKinds: readonly ConnectionKind[];
  /** Exact compiled protocol/profile evidence persisted with backend instances. */
  readonly protocolRelease: string;
  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule;
}
