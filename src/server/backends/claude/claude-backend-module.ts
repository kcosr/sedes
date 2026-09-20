import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { backendStartupEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { createThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackendDiscoveryAdapter,
  BackendModule,
  BackendModuleConfigurationInput,
  BackendModuleRuntime,
  BackendModuleRuntimeContext,
  BackendRuntimeRecoveryContext,
  PreparedBackendModule,
} from "../module.js";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import { ClaudeBackendThreadPersistenceAdapter } from "./claude-backend-thread-persistence-adapter.js";
import {
  parseClaudeBackendConfiguration,
  type PreparedClaudeBackendConfiguration,
} from "./claude-backend-configuration.js";
import { ClaudeBackendDriverFactory } from "./claude-driver-factory.js";
import { ClaudeManagedRuntimeOwner } from "./claude-managed-runtime-owner.js";
import { ClaudePersistentRuntimeClient } from "./runtime/claude-remote-runtime-client.js";
import { claudePersistentRuntimeOperations } from "./runtime/claude-sidecar-runtime.js";
import { recoverClaudeRuntimeAdministration } from "./runtime/claude-runtime-administration.js";
import type { ClaudeRuntimeClient } from "./claude-runtime-client.js";
import { ClaudeSavedAgentBackendAdapter } from "./claude-saved-agent-adapter.js";
import { ClaudeModelEffortCatalog } from "./claude-model-effort-catalog.js";
import { CLAUDE_AGENT_SDK_RELEASE } from "./claude-sdk-facade.js";
import { loadClaudeRuntimeWorkerArtifact } from "./worker/claude-runtime-worker-artifact.js";
import { ClaudeThreadActionPersistence } from "./claude-thread-action-persistence.js";
import { ClaudeThreadPresentationProvider } from "./claude-thread-presentation-provider.js";
import type { AgentConnectionProfile } from "../contracts.js";
import { ClaudeAutomationExecutionPolicy } from "./claude-automation-execution-policy.js";
import { ClaudeRuntimeInstallationAdvisories } from "./claude-runtime-installation-advisories.js";

export interface ClaudeBackendModuleDependencies {
  readonly createRuntimeClient: (input: {
    readonly context: BackendModuleRuntimeContext;
    readonly prepared: PreparedClaudeBackendConfiguration;
    readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  }) => Readonly<{
    readonly client: ClaudeRuntimeClient;
    readonly close: () => void | Promise<void>;
  }>;
}

const productionDependencies: ClaudeBackendModuleDependencies = Object.freeze({
  createRuntimeClient: ({
    context,
    prepared,
    startupEnvironmentVariables,
  }: {
    readonly context: BackendModuleRuntimeContext;
    readonly prepared: PreparedClaudeBackendConfiguration;
    readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  }) => {
    if (context.environmentOperations.environmentKind !== "local") {
      if (!context.sidecarRuntime) throw new Error("claude_sidecar_runtime_required");
      const client = new ClaudePersistentRuntimeClient({
        scope: { ...context.scope, backendInstanceId: context.instance.id,
          executionEnvironmentId: context.environmentChannel.executionEnvironmentId },
        sidecarRuntime: context.sidecarRuntime,
        executablePath: prepared.runtime.executablePath ?? "claude",
        configDirectory: prepared.runtime.configDirectory,
        initializationTimeoutMs: prepared.runtime.initializationTimeoutMs,
        startupEnvironmentVariables,
      });
      return Object.freeze({ client, close: () => client.close() });
    }
    const owner = new ClaudeManagedRuntimeOwner({
      scope: {
        ...context.scope,
        backendInstanceId: context.instance.id,
        executionEnvironmentId:
          context.environmentChannel.executionEnvironmentId,
      },
      environmentKind: "local",
      artifact: productionClaudeRuntimeWorkerArtifact(),
      channels: context.environmentChannel,
      workingDirectory: prepared.runtime.configDirectory ?? "/",
      executablePath: prepared.runtime.executablePath ?? "claude",
      configDirectory: prepared.runtime.configDirectory,
      initializationTimeoutMs: prepared.runtime.initializationTimeoutMs,
        startupEnvironmentVariables,
    });
    return Object.freeze({
      client: owner,
      close: () => owner.close(),
    });
  },
});

let productionClaudeRuntimeWorkerArtifactPromise:
  ReturnType<typeof loadClaudeRuntimeWorkerArtifact> | undefined;

function productionClaudeRuntimeWorkerArtifact() {
  const manifestPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../dist/claude-runtime-worker/manifest.json",
  );
  productionClaudeRuntimeWorkerArtifactPromise ??=
    loadClaudeRuntimeWorkerArtifact(manifestPath).catch((error) => {
      productionClaudeRuntimeWorkerArtifactPromise = undefined;
      throw new Error(
        "production_claude_runtime_worker_artifact_unavailable: run npm run build:claude-runtime-worker and verify dist/claude-runtime-worker/manifest.json",
        { cause: error },
      );
    });
  return productionClaudeRuntimeWorkerArtifactPromise;
}

const unsupportedManagedTerminals = Object.freeze({
  async authorizeAdmission(): Promise<never> {
    throw new ManagedTerminalCarrierError(
      "terminal_unavailable",
      "Managed terminals are not supported by the Claude backend.",
      false,
    );
  },
  async attachViewer(): Promise<never> {
    throw new ManagedTerminalCarrierError(
      "terminal_unavailable",
      "Managed terminals are not supported by the Claude backend.",
      false,
    );
  },
});

class ClaudeBackendModuleRuntime implements BackendModuleRuntime {
  readonly scope;
  readonly instance;
  readonly driverFactory;
  readonly threadPersistence;
  readonly bindingDetails;
  readonly presentation;
  readonly actionPersistence;
  readonly discoveryPersistence;
  readonly discovery;
  readonly installationAdvisories;
  readonly savedAgents;
  readonly automationExecutionPolicy;
  readonly managedProviderTerminals = unsupportedManagedTerminals;
  readonly #runtimeClient: ClaudeRuntimeClient;
  readonly #closeRuntimeClient: () => void | Promise<void>;
  #closed = false;

  constructor(
    context: BackendModuleRuntimeContext,
    prepared: PreparedClaudeBackendConfiguration,
    runtimeClient: ClaudeRuntimeClient,
    closeRuntimeClient: () => void | Promise<void>,
    namespaceKey: string,
  ) {
    this.scope = context.scope;
    this.instance = context.instance;
    this.#runtimeClient = runtimeClient;
    this.#closeRuntimeClient = closeRuntimeClient;
    const preparedConnections = new Map(
      prepared.connections.map((connection) => [connection.id, connection]),
    );
    const resolveConnectionDefaults = (connection: AgentConnectionProfile) => {
      const configured = preparedConnections.get(connection.templateId);
      if (!configured || configured.enabled !== connection.enabled) {
        return undefined;
      }
      return {
        permissionMode: configured.configuration.defaults.permissionMode,
      };
    };
    const persistence = new ClaudeBackendThreadPersistenceAdapter({
      database: context.database,
      scope: context.scope,
      backendInstanceId: context.instance.id,
      resolveConnectionDefaults,
    });
    persistence.settings.invalidateConfirmedForBackend(
      context.scope,
      context.instance.id,
      Date.now(),
    );
    this.automationExecutionPolicy = new ClaudeAutomationExecutionPolicy(
      persistence.settings,
      prepared.modelPolicy,
    );
    this.threadPersistence = persistence;
    this.bindingDetails = persistence;
    this.discoveryPersistence = persistence;
    const modelEfforts = new ClaudeModelEffortCatalog();
    this.installationAdvisories = new ClaudeRuntimeInstallationAdvisories();
    this.presentation = new ClaudeThreadPresentationProvider(
      persistence.settings,
      modelEfforts,
      prepared.runtime.permissionPolicy,
      prepared.modelPolicy,
    );
    this.actionPersistence = new ClaudeThreadActionPersistence(
      context.database,
      context.scope,
      context.instance.id,
      persistence.settings,
      modelEfforts,
      prepared.runtime.permissionPolicy,
      prepared.modelPolicy,
    );
    this.savedAgents = new ClaudeSavedAgentBackendAdapter({
      persistence,
      permissionPolicy: prepared.runtime.permissionPolicy,
      modelPolicy: prepared.modelPolicy,
      resolveConnectionDefaults,
    });
    this.driverFactory = new ClaudeBackendDriverFactory({
      resolveThreadEnvironment: createThreadEnvironmentResolver(context),
      scope: context.scope,
      instance: context.instance,
      runtimeClient,
      executablePath: prepared.runtime.executablePath ?? "claude",
      initializationTimeoutMs: prepared.runtime.initializationTimeoutMs,
      probeDirectory: prepared.runtime.configDirectory ?? "/",
      settings: persistence.settings,
      permissionPolicy: prepared.runtime.permissionPolicy,
      modelPolicy: prepared.modelPolicy,
      attachmentProvenanceKey: context.toolProvenanceKey,
      connections: context.connections,
      agentToolCli: context.agentToolCli,
      agentToolSourceCapabilities: context.agentToolSourceCapabilities,
      agentTools: context.agentTools,
      toolProvenanceKey: context.toolProvenanceKey,
      childEnvironment: Object.freeze({}),
      beginVersionObservation: (source) =>
        this.installationAdvisories.beginObservation(source),
    });
    this.discovery = {
      nativeNamespaceKey(connection) {
        if (
          connection.kind !== "claude_agent_sdk" ||
          connection.backendInstanceId !== context.instance.id
        ) {
          throw new Error("claude_discovery_connection_mismatch");
        }
        return namespaceKey;
      },
    } satisfies BackendDiscoveryAdapter;
  }

  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    return this.#runtimeClient.startupEnvironmentState?.() ?? "unknown";
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("claude_backend_runtime_closed");
    // Authentication and availability are target health, not global startup.
    // A health/catalog call initializes the external CLI without a model turn.
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.installationAdvisories.clear();
    await this.driverFactory.close();
    await this.#closeRuntimeClient();
  }
}

class PreparedClaudeBackendModule implements PreparedBackendModule {
  readonly backendInstanceId: string;
  readonly module: BackendModule;
  readonly nativeNamespaces: PreparedBackendModule["nativeNamespaces"];
  readonly nativeStores = Object.freeze([]);
  readonly #prepared: PreparedClaudeBackendConfiguration;
  readonly #configuredConnections: BackendModuleConfigurationInput["connections"];
  readonly #configuredExecutionEnvironments: BackendModuleConfigurationInput["executionEnvironments"];
  readonly #enabled: boolean;
  readonly #executionEnvironmentId: string | undefined;
  readonly #executionEnvironmentKind: "local" | "ssh" | "outbound" | undefined;
  readonly #namespaceKey: string | undefined;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #dependencies: ClaudeBackendModuleDependencies;
  #runtimeCreated = false;

  constructor(
    module: BackendModule,
    input: BackendModuleConfigurationInput,
    prepared: PreparedClaudeBackendConfiguration,
    dependencies: ClaudeBackendModuleDependencies,
  ) {
    this.module = module;
    this.backendInstanceId = prepared.backendInstanceId;
    this.#prepared = prepared;
    this.#configuredConnections = Object.freeze([...input.connections]);
    this.#configuredExecutionEnvironments = Object.freeze([...input.executionEnvironments]);
    this.#enabled = input.backend.enabled;
    this.#dependencies = dependencies;
    this.#startupEnvironmentVariables = backendStartupEnvironmentVariables(input);
    if (!input.backend.enabled) {
      this.#executionEnvironmentId = undefined;
      this.#executionEnvironmentKind = undefined;
      this.#namespaceKey = undefined;
      this.nativeNamespaces = Object.freeze([]);
      return;
    }
    const executionEnvironmentIds = new Set(
      input.connections
        .filter(({ enabled }) => enabled)
        .map(({ executionEnvironmentId }) => executionEnvironmentId),
    );
    const executionEnvironmentId = [...executionEnvironmentIds][0];
    if (executionEnvironmentIds.size !== 1 || !executionEnvironmentId) {
      throw new Error("claude_external_execution_environment_invalid");
    }
    const environment = input.executionEnvironments.find(
      ({ id }) => id === executionEnvironmentId,
    );
    if (!environment) {
      throw new Error("claude_external_execution_environment_invalid");
    }
    this.#executionEnvironmentKind = environment.kind;
    this.#executionEnvironmentId = executionEnvironmentId;
    this.#namespaceKey = claudeExternalNamespaceKey(
      executionEnvironmentId,
      prepared.runtime.configDirectory,
    );
    this.nativeNamespaces = Object.freeze([
      Object.freeze({
        sortKey: `claude-agent-sdk\0${this.#namespaceKey}`,
        namespaceKey: this.#namespaceKey,
      }),
    ]);
  }

  async recoverAdministration(context: BackendRuntimeRecoveryContext) {
    const configured = new Map(this.#configuredConnections.map(connection => [connection.id, connection]));
    const environments = new Set(this.#configuredConnections.map(connection => connection.executionEnvironmentId));
    const executionEnvironmentId = [...environments][0];
    if (
      context.instance.id !== this.backendInstanceId ||
      context.instance.kind !== "claude_agent_sdk" ||
      context.instance.tenantId !== context.scope.tenantId ||
      context.instance.protocolRelease !== CLAUDE_AGENT_SDK_RELEASE ||
      environments.size !== 1 || !executionEnvironmentId ||
      !this.#configuredExecutionEnvironments.some(environment => environment.id === executionEnvironmentId && environment.kind !== "local") ||
      configured.size !== this.#configuredConnections.length ||
      context.connections.length !== configured.size ||
      new Set(context.connections.map(connection => connection.id)).size !== context.connections.length ||
      new Set(context.connections.map(connection => connection.templateId)).size !== context.connections.length ||
      context.connections.some(connection => {
        const target = configured.get(connection.templateId);
        return !target || connection.kind !== "claude_agent_sdk" ||
          connection.backendInstanceId !== this.backendInstanceId ||
          connection.executionEnvironmentId !== executionEnvironmentId ||
          connection.tenantId !== context.scope.tenantId ||
          connection.ownerPrincipalId !== context.scope.principalId ||
          connection.enabled !== target.enabled;
      })
    ) throw new Error("claude_backend_runtime_context_invalid");
    return await recoverClaudeRuntimeAdministration({ context, configuration: {
      ...context.scope, backendInstanceId: this.backendInstanceId, executionEnvironmentId,
      executablePath: this.#prepared.runtime.executablePath ?? "claude",
      configDirectory: this.#prepared.runtime.configDirectory,
      initializationTimeoutMs: this.#prepared.runtime.initializationTimeoutMs,
      startupEnvironmentVariables: this.#startupEnvironmentVariables,
    } });
  }

  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime {
    if (!this.#enabled) {
      throw new Error("claude_disabled_runtime_not_creatable");
    }
    if (context.environmentOperations.environmentKind !== this.#executionEnvironmentKind) {
      throw new Error("claude_backend_runtime_context_invalid");
    }
    if (this.#executionEnvironmentKind !== "local" && !context.sidecarRuntime) {
      throw new Error("claude_sidecar_runtime_required");
    }
    if (this.#executionEnvironmentKind === "local" && context.sidecarRuntime) {
      throw new Error("claude_backend_runtime_context_invalid");
    }
    if (this.#runtimeCreated) {
      throw new Error("claude_backend_runtime_already_created");
    }
    const configuredByTemplate = new Map(
      this.#configuredConnections.map((connection) => [
        connection.id,
        connection,
      ]),
    );
    const profilesByTemplate = new Map(
      context.connections.map((connection) => [
        connection.templateId,
        connection,
      ]),
    );
    const enabledEnvironmentIds = new Set(
      context.connections
        .filter(({ enabled }) => enabled)
        .map(({ executionEnvironmentId }) => executionEnvironmentId),
    );
    if (
      context.instance.id !== this.backendInstanceId ||
      context.instance.tenantId !== context.scope.tenantId ||
      context.instance.kind !== "claude_agent_sdk" ||
      context.instance.protocolRelease !== CLAUDE_AGENT_SDK_RELEASE ||
      !context.instance.enabled ||
      configuredByTemplate.size !== this.#configuredConnections.length ||
      profilesByTemplate.size !== context.connections.length ||
      profilesByTemplate.size !== configuredByTemplate.size ||
      new Set(context.connections.map(({ id }) => id)).size !==
        context.connections.length ||
      enabledEnvironmentIds.size !== 1 ||
      !this.#executionEnvironmentId ||
      !enabledEnvironmentIds.has(this.#executionEnvironmentId) ||
      context.environmentOperations.environmentId !== this.#executionEnvironmentId ||
      context.environmentChannel.executionEnvironmentId !==
        this.#executionEnvironmentId ||
      context.environmentChannel.scope.tenantId !== context.scope.tenantId ||
      context.environmentChannel.scope.principalId !==
        context.scope.principalId ||
      !this.#namespaceKey
    ) {
      throw new Error("claude_backend_runtime_context_invalid");
    }
    for (const [templateId, configured] of configuredByTemplate) {
      const profile = profilesByTemplate.get(templateId);
      if (
        !profile ||
        profile.kind !== "claude_agent_sdk" ||
        profile.tenantId !== context.scope.tenantId ||
        profile.ownerPrincipalId !== context.scope.principalId ||
        profile.backendInstanceId !== context.instance.id ||
        profile.executionEnvironmentId !== configured.executionEnvironmentId ||
        profile.enabled !== configured.enabled
      ) {
        throw new Error("claude_backend_runtime_context_invalid");
      }
    }
    this.#runtimeCreated = true;
    const runtimeClient = this.#dependencies.createRuntimeClient({
      context,
      prepared: this.#prepared,
      startupEnvironmentVariables: this.#startupEnvironmentVariables,
    });
    return new ClaudeBackendModuleRuntime(
      context,
      this.#prepared,
      runtimeClient.client,
      runtimeClient.close,
      this.#namespaceKey,
    );
  }
}

export class ClaudeBackendModule implements BackendModule {
  readonly remoteRuntimeCapabilities = Object.freeze([Object.freeze({
    capabilityId: "claude_persistent_runtime", majorVersion: 1,
    operations: Object.freeze(claudePersistentRuntimeOperations.map(operation => operation.operation)),
  })]);
  readonly backendKind = "claude_agent_sdk" as const;
  readonly connectionKinds = ["claude_agent_sdk"] as const;
  readonly protocolRelease = CLAUDE_AGENT_SDK_RELEASE;
  readonly #dependencies: ClaudeBackendModuleDependencies;

  constructor(
    dependencies: ClaudeBackendModuleDependencies = productionDependencies,
  ) {
    this.#dependencies = dependencies;
  }

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    const prepared = parseClaudeBackendConfiguration(input);
    return new PreparedClaudeBackendModule(
      this,
      input,
      prepared,
      this.#dependencies,
    );
  }
}

function claudeExternalNamespaceKey(
  executionEnvironmentId: string,
  configDirectory: string | undefined,
): string {
  const identity = createHash("sha256")
    // This invisible domain is a durable native-discovery identity. Keep the
    // historical value across product renames so existing discoveries do not
    // move to a different namespace.
    .update("harness.claude-agent-sdk.external-discovery.v1\n")
    // The execution account's default is an environment-owned identity. Never
    // substitute the main server's home when preparing a remote backend.
    .update(JSON.stringify([executionEnvironmentId, configDirectory ?? null]))
    .digest("base64url");
  return `claude-agent-sdk:${identity}`;
}
