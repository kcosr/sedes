import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { backendStartupEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { createThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import type { AgentConnectionProfile } from "../contracts.js";
import type {
  BackendDiscoveryAdapter,
  BackendModule,
  BackendModuleConfigurationInput,
  BackendModuleRuntime,
  BackendModuleRuntimeContext,
  PreparedBackendModule,
} from "../module.js";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import { buildGrokChildEnvironment } from "./grok-child-environment.js";
import {
  parseGrokBackendConfiguration,
  type GrokBackendConfigurationInput,
  type PreparedGrokBackendConfiguration,
} from "./grok-backend-configuration.js";
import { GrokBackendDriverFactory } from "./grok-driver-factory.js";
import { GrokBackendThreadPersistenceAdapter } from "./grok-backend-thread-persistence-adapter.js";
import { grokNativeNamespaceKey } from "./grok-native-namespace.js";
import {
  assertGrokProductionProfileAdmitted,
  GROK_ACP_COMPATIBILITY_RELEASE,
} from "./grok-release-guard.js";
import { GrokThreadPresentationProvider } from "./grok-thread-presentation-provider.js";
import { GrokThreadActionPersistence } from "./grok-thread-action-persistence.js";
import { GrokSavedAgentBackendAdapter } from "./grok-saved-agent-adapter.js";
import { GrokAutomationExecutionPolicy } from "./grok-automation-execution-policy.js";
import { GrokModelEffortCatalog } from "./grok-model-effort-catalog.js";
import { GrokRuntimeAdvisorySource } from "./grok-runtime-advisories.js";

const unsupportedManagedTerminals = Object.freeze({
  async authorizeAdmission(): Promise<never> {
    throw new ManagedTerminalCarrierError(
      "terminal_unavailable",
      "Managed terminals are not supported by the Grok backend.",
      false,
    );
  },
  async attachViewer(): Promise<never> {
    throw new ManagedTerminalCarrierError(
      "terminal_unavailable",
      "Managed terminals are not supported by the Grok backend.",
      false,
    );
  },
});

class GrokBackendModuleRuntime implements BackendModuleRuntime {
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
  readonly automationExecutionPolicy = new GrokAutomationExecutionPolicy();
  readonly managedProviderTerminals = unsupportedManagedTerminals;
  #closed = false;

  constructor(input: {
    readonly context: BackendModuleRuntimeContext;
    readonly configuration: GrokBackendConfigurationInput;
    readonly prepared: PreparedGrokBackendConfiguration;
    readonly startupEnvironmentVariables: EnvironmentVariableOverrides;
    readonly childEnvironment: Readonly<Record<string, string | undefined>>;
    readonly nativeNamespaceKey: string;
  }) {
    this.scope = input.context.scope;
    this.instance = input.context.instance;
    const installationAdvisories = new GrokRuntimeAdvisorySource();
    this.installationAdvisories = installationAdvisories;
    const preparedConnections = new Map(
      input.prepared.connections.map((connection) => [
        connection.id,
        connection,
      ]),
    );
    const resolveConnectionDefaults = (connection: AgentConnectionProfile) => {
      const configured = preparedConnections.get(connection.templateId);
      return configured?.enabled === connection.enabled
        ? configured.configuration.defaults
        : undefined;
    };
    const persistence = new GrokBackendThreadPersistenceAdapter({
      database: input.context.database,
      scope: input.context.scope,
      backendInstanceId: input.context.instance.id,
      nativeNamespaceKey: input.nativeNamespaceKey,
      resolveConnectionDefaults,
      modelPolicy: input.prepared.modelPolicy,
    });
    this.threadPersistence = persistence;
    this.bindingDetails = persistence;
    this.discoveryPersistence = persistence;
    const modelEfforts = new GrokModelEffortCatalog();
    this.presentation = new GrokThreadPresentationProvider(
      persistence.settings,
      modelEfforts,
      input.prepared.modelPolicy,
    );
    this.actionPersistence = new GrokThreadActionPersistence(
      input.context.database,
      input.context.scope,
      input.context.instance.id,
      persistence.settings,
      modelEfforts,
      input.prepared.modelPolicy,
    );
    this.savedAgents = new GrokSavedAgentBackendAdapter({
      persistence,
      modelPolicy: input.prepared.modelPolicy,
      resolveConnectionDefaults,
    });
    this.driverFactory = new GrokBackendDriverFactory({
      resolveThreadEnvironment: createThreadEnvironmentResolver(input.context),
      startupEnvironmentVariables: input.startupEnvironmentVariables,
      scope: input.context.scope,
      instance: input.context.instance,
      connections: input.context.connections,
      configuration: input.configuration,
      environmentChannel: input.context.environmentChannel,
      environment: input.childEnvironment,
      submissionCorrelationKey: input.context.toolProvenanceKey,
      agentToolCli: input.context.agentToolCli,
      agentToolSourceCapabilities: input.context.agentToolSourceCapabilities,
      agentTools: input.context.agentTools,
      settings: persistence.settings,
      outputArtifacts: input.context.outputArtifacts,
      beginRuntimeAssessmentObservation: () =>
        installationAdvisories.beginObservation(),
    });
    this.discovery = {
      nativeNamespaceKey: (connection) => {
        if (
          connection.kind !== "grok_acp" ||
          connection.backendInstanceId !== input.context.instance.id
        ) {
          throw new Error("grok_discovery_connection_mismatch");
        }
        return input.nativeNamespaceKey;
      },
    } satisfies BackendDiscoveryAdapter;
  }

  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> { return this.driverFactory.startupEnvironmentState(); }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("grok_backend_runtime_closed");
    // Native authentication and executable availability are target health,
    // not global application-startup requirements.
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.driverFactory.close();
    } finally {
      this.installationAdvisories.close();
    }
  }
}

class PreparedGrokBackendModule implements PreparedBackendModule {
  readonly backendInstanceId: string;
  readonly module: BackendModule;
  readonly nativeNamespaces: PreparedBackendModule["nativeNamespaces"];
  readonly nativeStores = Object.freeze([]);
  readonly #configuration: GrokBackendConfigurationInput;
  readonly #prepared: PreparedGrokBackendConfiguration;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #nativeNamespaceKey: string | undefined;
  #runtimeCreated = false;

  constructor(
    module: BackendModule,
    configuration: GrokBackendConfigurationInput,
    prepared: PreparedGrokBackendConfiguration,
    environment: Readonly<Record<string, string | undefined>>,
    startupEnvironmentVariables: EnvironmentVariableOverrides,
  ) {
    this.module = module;
    this.backendInstanceId = prepared.backendInstanceId;
    this.#configuration = configuration;
    this.#prepared = prepared;
    this.#startupEnvironmentVariables = startupEnvironmentVariables;
    this.#childEnvironment = buildGrokChildEnvironment(environment);
    if (!prepared.enabled || !prepared.executionEnvironmentId) {
      this.#nativeNamespaceKey = undefined;
      this.nativeNamespaces = Object.freeze([]);
      return;
    }
    this.#nativeNamespaceKey = grokNativeNamespaceKey(
      prepared.executionEnvironmentId,
      this.#childEnvironment,
    );
    this.nativeNamespaces = Object.freeze([
      Object.freeze({
        sortKey: `grok-acp\0${this.#nativeNamespaceKey}`,
        namespaceKey: this.#nativeNamespaceKey,
      }),
    ]);
  }

  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime {
    if (context.environmentOperations.environmentKind !== "local") {
      throw new Error("grok_remote_execution_unsupported");
    }
    if (this.#runtimeCreated) {
      throw new Error("grok_backend_runtime_already_created");
    }
    if (
      !this.#prepared.enabled ||
      !this.#prepared.executionEnvironmentId ||
      !this.#nativeNamespaceKey ||
      context.instance.id !== this.backendInstanceId ||
      context.instance.tenantId !== context.scope.tenantId ||
      context.instance.kind !== "grok_build" ||
      context.instance.protocolRelease !== GROK_ACP_COMPATIBILITY_RELEASE ||
      !context.instance.enabled ||
      context.environmentChannel.executionEnvironmentId !==
        this.#prepared.executionEnvironmentId ||
      context.environmentChannel.scope.tenantId !== context.scope.tenantId ||
      context.environmentChannel.scope.principalId !== context.scope.principalId
    ) {
      throw new Error("grok_backend_runtime_context_invalid");
    }
    const configuredByTemplate = new Map(
      this.#prepared.connections.map((connection) => [
        connection.id,
        connection,
      ]),
    );
    if (
      configuredByTemplate.size !== this.#prepared.connections.length ||
      context.connections.length !== configuredByTemplate.size ||
      new Set(context.connections.map(({ id }) => id)).size !==
        context.connections.length ||
      new Set(context.connections.map(({ templateId }) => templateId)).size !==
        context.connections.length
    ) {
      throw new Error("grok_backend_runtime_context_invalid");
    }
    for (const connection of context.connections) {
      const configured = configuredByTemplate.get(connection.templateId);
      if (
        !configured ||
        connection.kind !== "grok_acp" ||
        connection.tenantId !== context.scope.tenantId ||
        connection.ownerPrincipalId !== context.scope.principalId ||
        connection.backendInstanceId !== context.instance.id ||
        connection.executionEnvironmentId !==
          configured.executionEnvironmentId ||
        connection.enabled !== configured.enabled
      ) {
        throw new Error("grok_backend_runtime_context_invalid");
      }
    }
    this.#runtimeCreated = true;
    return new GrokBackendModuleRuntime({
      context,
      configuration: this.#configuration,
      prepared: this.#prepared,
      childEnvironment: this.#childEnvironment,
      startupEnvironmentVariables: this.#startupEnvironmentVariables,
      nativeNamespaceKey: this.#nativeNamespaceKey,
    });
  }
}

export class GrokBackendModule implements BackendModule {
  readonly backendKind = "grok_build" as const;
  readonly connectionKinds = ["grok_acp"] as const;
  readonly protocolRelease = GROK_ACP_COMPATIBILITY_RELEASE;

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    const configuration = grokConfiguration(input);
    const prepared = parseGrokBackendConfiguration(configuration);
    if (prepared.enabled) assertGrokProductionProfileAdmitted();
    return new PreparedGrokBackendModule(
      this,
      configuration,
      prepared,
      input.environment,
      backendStartupEnvironmentVariables(input),
    );
  }
}

function grokConfiguration(
  input: BackendModuleConfigurationInput,
): GrokBackendConfigurationInput {
  if (
    input.backend.kind !== "grok_build" ||
    input.connections.some(({ kind }) => kind !== "grok_acp")
  ) {
    throw new Error("grok_backend_configuration_invalid");
  }
  return {
    backend: input.backend as GrokBackendConfigurationInput["backend"],
    connections:
      input.connections as GrokBackendConfigurationInput["connections"],
    executionEnvironments: input.executionEnvironments,
  };
}
