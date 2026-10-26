import { PiSessionClaims } from "../pi-session-claims.js";
import { createHash, createHmac } from "node:crypto";
import type { PiNativeConnectionDefaults } from "../../../../shared/protocol/pi-configuration.js";
import { ConnectionSettingPreferenceRepository } from "../../../db/repositories/connection-setting-preference-repository.js";
import { createThreadEnvironmentResolver } from "../../../environment-variables/runtime-environment.js";
import { ManagedTerminalCarrierError } from "../../../terminal/managed-terminal-carrier.js";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY, type AgentConnectionProfile } from "../../contracts.js";
import { parsePiNativeBackendConfiguration } from "./pi-native-backend-configuration.js";
import { NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES, type BackendModule, type BackendModuleConfigurationInput,
  type BackendModuleRuntime, type BackendModuleRuntimeContext, type BackendRuntimeAdministration, type BackendRuntimeRecoveryContext,
  type PreparedBackendModule } from "../../module.js";
import type { BackendDriverFactory } from "../../registry.js";
import { PiAutomationExecutionPolicy } from "../pi-automation-execution-policy.js";
import { PiBackendThreadPersistenceAdapter } from "../pi-backend-thread-persistence-adapter.js";
import { PiSavedAgentAdapter } from "../pi-saved-agent-adapter.js";
import { PiThreadActionPersistence } from "../pi-thread-action-persistence.js";
import { PiThreadPresentationProvider } from "../pi-thread-presentation-provider.js";
import { PiNativeConversationDriver, parsePiNativeBindingDetail } from "./driver/driver.js";
import { PiNativeHost } from "./host/native-host.js";
import { PiNativeThreadRepository } from "./pi-native-thread-repository.js";
import { PiNativeRemotePort } from "./sidecar/remote-port.js";
import { piNativeRuntimeCapability } from "./sidecar/wire.js";
import { PiNativeError, type PiNativePort, type PiNativeRuntimeConfiguration } from "./port.js";
import { PiNativeAgentToolService } from "./agent-tools.js";
import { recoverPiNativeRuntimeAdministration } from "./runtime-administration.js";
import { stopPiNativeRuntime } from "./runtime-control.js";
import { piNativeRecoveryMessage } from "./diagnostics.js";

export const PI_NATIVE_PROTOCOL_RELEASE = "1.4.0";

export interface PiNativeModuleDependencies {
  createPort(input: {
    readonly context: BackendModuleRuntimeContext;
    readonly configuration: PiNativeRuntimeConfiguration;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }): PiNativePort;
}

const productionDependencies: PiNativeModuleDependencies = {
  createPort({ context, configuration, environment }) {
    if (context.environmentOperations.environmentKind !== "local") {
      if (!context.sidecarRuntime) throw new Error("pi_native_sidecar_required");
      return new PiNativeRemotePort({ configuration, sidecarRuntime: context.sidecarRuntime });
    }
    return new PiNativeHost({ configuration, channels: context.environmentChannel, environment,
      authenticationKey: createHmac("sha256", context.toolProvenanceKey)
        .update("sedes.pi-native.operations.v1\0")
        .update(JSON.stringify([configuration.tenantId, configuration.principalId,
          configuration.backendInstanceId, configuration.executionEnvironmentId])).digest() });
  },
};

const managedProviderTerminals = Object.freeze({
  async authorizeAdmission(): Promise<never> {
    throw new ManagedTerminalCarrierError("terminal_unavailable", "Managed provider terminals are unavailable for Pi.", false);
  },
  async attachViewer(): Promise<never> {
    throw new ManagedTerminalCarrierError("terminal_unavailable", "Managed provider terminals are unavailable for Pi.", false);
  },
});

function administration(context: Pick<BackendModuleRuntimeContext, "database" | "scope" | "instance" | "environmentOperations">,
  port: PiNativePort): BackendRuntimeAdministration {
  return {
    async inspect() {
      const inspected = await port.inspect();
      const find = context.database.prepare(`SELECT application_thread_id AS id FROM conversation_bindings
        WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ?
          AND execution_environment_id = ? AND backend_conversation_id = ?`);
      return { state: inspected.state, incarnation: inspected.runtimeId, revision: inspected.revision,
        blockers: inspected.blockers,
        retainedThreadIds: inspected.retainedSessions.flatMap(session => {
          const row = find.get(context.scope.tenantId, context.scope.principalId, context.instance.id,
            context.environmentOperations.environmentId, session.sessionId) as { id: string } | undefined;
          return row ? [row.id] : [];
        }) };
    },
    stop: input => stopPiNativeRuntime(port, input),
    restart: input => stopPiNativeRuntime(port, input),
  };
}

class PiNativeModuleRuntime implements BackendModuleRuntime {
  readonly scope;
  readonly instance;
  readonly driverFactory: BackendDriverFactory;
  readonly threadPersistence;
  readonly bindingDetails;
  readonly presentation;
  readonly actionPersistence;
  readonly discoveryPersistence;
  readonly discovery;
  readonly savedAgents;
  readonly automationExecutionPolicy;
  readonly administration;
  readonly installationAdvisories = NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES;
  readonly managedProviderTerminals = managedProviderTerminals;
  readonly #drivers = new Map<string, PiNativeConversationDriver>();
  readonly #agentTools;
  #closed = false;
  #closeComplete = false;
  #closing?: Promise<void>;

  constructor(readonly context: BackendModuleRuntimeContext, readonly port: PiNativePort,
    readonly prepared: PreparedPiNativeModule) {
    this.scope = context.scope;
    this.instance = context.instance;
    this.#agentTools = new PiNativeAgentToolService({ facade: context.agentTools,
      cli: context.agentToolCli, sourceCapabilities: context.agentToolSourceCapabilities,
      remote: context.environmentOperations.environmentKind !== "local" });
    const repository = new PiNativeThreadRepository(context.database);
    const preferences = new ConnectionSettingPreferenceRepository(context.database);
    const resolveDefaults = (connection: AgentConnectionProfile) => {
      const defaults = prepared.defaults.get(connection.templateId);
      return defaults ? {
        ...(defaults.provider && defaults.model ? { modelProvider: defaults.provider, modelId: defaults.model } : {}),
        ...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}),
      } : {};
    };
    const persistence = new PiBackendThreadPersistenceAdapter(repository, preferences, {
      connectionKind: "pi_rpc", resolveDefaults,
      parseBinding: value => { const parsed = parsePiNativeBindingDetail(value);
        return { backendConversationId: parsed.sessionId, sessionFile: parsed.sessionFile }; },
    });
    this.threadPersistence = persistence;
    this.bindingDetails = persistence;
    this.discoveryPersistence = persistence;
    this.presentation = new PiThreadPresentationProvider(repository, prepared.modelPolicy,
      { backendKind: "pi_native", connectionKind: "pi_rpc" });
    this.actionPersistence = new PiThreadActionPersistence(repository, preferences);
    this.automationExecutionPolicy = new PiAutomationExecutionPolicy(repository, prepared.modelPolicy);
    this.savedAgents = new PiSavedAgentAdapter({ preferences, persistence, resolveDefaults,
      profile: { backendKind: "pi_native", connectionKind: "pi_rpc", label: "Pi" } });
    this.administration = administration(context, port);
    this.discovery = { nativeNamespaceKey: (connection: AgentConnectionProfile) => {
      this.#assertConnection(connection); return prepared.namespaceKey;
    } };
    this.driverFactory = {
      scope: this.scope, instance: this.instance, connectionKinds: ["pi_rpc"],
      supportsConversationCreation: true, creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: connection => {
        this.#assertConnection(connection);
        const existing = this.#drivers.get(connection.id);
        if (existing) {
          if (existing.connection.configurationRevision !== connection.configurationRevision)
            throw new Error("pi_native_configuration_changed");
          return existing;
        }
        const driver = new PiNativeConversationDriver({ instance: this.instance, connection, port,
          claimNativeSession: (scope, input) => new PiSessionClaims(context.database).reserve(scope, input),
          modelPolicy: prepared.modelPolicy, operations: repository, usage: context.usage, agentTools: this.#agentTools,
          outputArtifacts: context.outputArtifacts, resolveThreadEnvironment: createThreadEnvironmentResolver(context),
          settings: { getSettings: (scope, id) => repository.getSettings(scope, id),
            syncObserved: (scope, id, settings) => {
              if (!settings.model || !settings.thinkingLevel) return;
              repository.syncObservedSettingsForBoundThread(scope, id, { modelProvider: settings.model.provider,
                modelId: settings.model.id, thinkingLevel: settings.thinkingLevel });
            } },
        });
        this.#drivers.set(connection.id, driver);
        return driver;
      },
    };
  }

  #assertConnection(connection: AgentConnectionProfile): void {
    if (this.#closed || connection.kind !== "pi_rpc" || connection.backendInstanceId !== this.instance.id ||
        connection.tenantId !== this.scope.tenantId || connection.ownerPrincipalId !== this.scope.principalId ||
        connection.executionEnvironmentId !== this.prepared.executionEnvironmentId ||
        !this.context.connections.some(candidate => candidate.id === connection.id && candidate.templateId === connection.templateId))
      throw new Error("pi_native_connection_mismatch");
  }
  agentToolRuntimeAvailability(input: Parameters<PiNativeAgentToolService["availability"]>[0]) {
    return this.#agentTools.availability(input);
  }
  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    if (this.port instanceof PiNativeRemotePort) return this.port.startupEnvironmentState();
    try { const state = await this.port.inspect();
      return state.state === "unknown" ? "unknown" : state.retainedSessions.length ? "started" : "not_started";
    } catch { return "unknown"; }
  }
  async stopBeforeConversationCleanup(): Promise<void> {
    // Local close owns process cleanup. Remote close only disposes main-side
    // attachment authority: Stop may have failed or retired the entire service.
    // Neither case permits another forced remote Stop during actor cleanup.
    await this.port.close();
  }
  async start(): Promise<void> { if (this.#closed) throw new Error("pi_native_runtime_closed"); }
  async close(): Promise<void> {
    if (this.#closeComplete) return;
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const cleanup = (async () => {
      const outcomes = await Promise.allSettled([...this.#drivers.values()].map(driver => driver.close()));
      // Every driver gets a cleanup attempt. Keep the port usable until all
      // handles have released: closing it would make a failed release permanent.
      const errors = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Pi runtime cleanup is incomplete.");
      await this.port.close();
      await this.#agentTools.close();
      this.#drivers.clear();
      this.#closeComplete = true;
    })();
    this.#closing = cleanup;
    try { await cleanup; } finally { if (this.#closing === cleanup) this.#closing = undefined; }
  }
}

class PreparedPiNativeModule implements PreparedBackendModule {
  readonly backendInstanceId;
  readonly nativeStores = Object.freeze([]);
  readonly nativeNamespaces;
  readonly runtime;
  readonly defaults = new Map<string, PiNativeConnectionDefaults>();
  readonly modelPolicy;
  readonly executionEnvironmentId?: string;
  readonly environmentKind?: "local" | "ssh" | "outbound";
  readonly namespaceKey;
  readonly startupEnvironmentVariables;
  #created = false;
  constructor(readonly module: BackendModule, readonly input: BackendModuleConfigurationInput,
    readonly dependencies: PiNativeModuleDependencies) {
    this.backendInstanceId = input.backend.id;
    const configuration = parsePiNativeBackendConfiguration(input);
    this.runtime = configuration.moduleConfiguration;
    this.modelPolicy = configuration.modelPolicy;
    this.startupEnvironmentVariables = configuration.startupEnvironmentVariables;
    for (const [id, defaults] of configuration.defaultsByConnectionId) this.defaults.set(id, defaults);
    this.executionEnvironmentId = configuration.executionEnvironmentId;
    this.environmentKind = configuration.environmentKind;
    // Runtime modes share provider files but retain distinct discovery ownership.
    this.namespaceKey = `pi-native:${createHash("sha256").update(JSON.stringify([
      this.executionEnvironmentId, this.runtime.agentDirectory ?? null, this.runtime.sessionDirectory ?? null,
    ])).digest("hex")}`;
    this.nativeNamespaces = input.backend.enabled
      ? Object.freeze([{ sortKey: this.namespaceKey, namespaceKey: this.namespaceKey }]) : Object.freeze([]);
  }
  configuration(scope: BackendModuleRuntimeContext["scope"]): PiNativeRuntimeConfiguration {
    if (!this.executionEnvironmentId) throw new Error("pi_native_execution_environment_invalid");
    return { ...scope, backendInstanceId: this.backendInstanceId, executionEnvironmentId: this.executionEnvironmentId,
      ...this.runtime, startupEnvironmentVariables: this.startupEnvironmentVariables };
  }
  async recoverAdministration(context: BackendRuntimeRecoveryContext) {
    const configured = new Map(this.input.connections.map(connection => [connection.id, connection]));
    if (context.instance.id !== this.backendInstanceId || context.instance.kind !== "pi_native" ||
        context.instance.protocolRelease !== PI_NATIVE_PROTOCOL_RELEASE || context.instance.tenantId !== context.scope.tenantId ||
        !this.executionEnvironmentId || this.environmentKind === "local" || !this.environmentKind ||
        configured.size !== this.input.connections.length || context.connections.length !== configured.size ||
        new Set(context.connections.map(connection => connection.id)).size !== context.connections.length ||
        new Set(context.connections.map(connection => connection.templateId)).size !== context.connections.length ||
        context.connections.some(connection => {
          const original = configured.get(connection.templateId);
          return !original || connection.kind !== "pi_rpc" || connection.backendInstanceId !== this.backendInstanceId ||
            connection.tenantId !== context.scope.tenantId || connection.ownerPrincipalId !== context.scope.principalId ||
            connection.executionEnvironmentId !== this.executionEnvironmentId || connection.enabled !== original.enabled;
        })) throw new Error("pi_native_runtime_context_invalid");
    return recoverPiNativeRuntimeAdministration({ context, configuration: this.configuration(context.scope) });
  }
  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime {
    const configured = new Map(this.input.connections.map(connection => [connection.id, connection]));
    if (this.#created || !this.input.backend.enabled || !context.instance.enabled ||
        context.instance.id !== this.backendInstanceId || context.instance.kind !== "pi_native" ||
        context.instance.protocolRelease !== PI_NATIVE_PROTOCOL_RELEASE || context.instance.tenantId !== context.scope.tenantId ||
        context.environmentOperations.environmentKind !== this.environmentKind ||
        context.environmentOperations.environmentId !== this.executionEnvironmentId ||
        context.environmentChannel.executionEnvironmentId !== this.executionEnvironmentId ||
        context.environmentChannel.scope.tenantId !== context.scope.tenantId ||
        context.environmentChannel.scope.principalId !== context.scope.principalId ||
        context.connections.length !== configured.size ||
        new Set(context.connections.map(connection => connection.id)).size !== configured.size ||
        new Set(context.connections.map(connection => connection.templateId)).size !== configured.size ||
        context.connections.some(connection => {
          const original = configured.get(connection.templateId);
          return !original || connection.kind !== "pi_rpc" || connection.backendInstanceId !== this.backendInstanceId ||
            connection.tenantId !== context.scope.tenantId || connection.ownerPrincipalId !== context.scope.principalId ||
            connection.executionEnvironmentId !== original.executionEnvironmentId || connection.enabled !== original.enabled;
        })) throw new Error("pi_native_runtime_context_invalid");
    if ((this.environmentKind === "local") === Boolean(context.sidecarRuntime))
      throw new Error("pi_native_runtime_topology_invalid");
    this.#created = true;
    return new PiNativeModuleRuntime(context, this.dependencies.createPort({ context,
      configuration: this.configuration(context.scope), environment: this.input.environment }), this);
  }
}

export class PiNativeBackendModule implements BackendModule {
  readonly backendKind = "pi_native" as const;
  readonly connectionKinds = ["pi_rpc"] as const;
  readonly protocolRelease = PI_NATIVE_PROTOCOL_RELEASE;
  readonly startupPolicy = "composition_only" as const;
  readonly remoteRuntimeCapabilities = Object.freeze([piNativeRuntimeCapability]);
  constructor(readonly dependencies: PiNativeModuleDependencies = productionDependencies) {}
  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    if (input.backend.kind !== this.backendKind ||
        (input.backend.enabled && input.backend.protocolRelease !== this.protocolRelease))
      throw new Error("pi_native_configuration_invalid");
    return new PreparedPiNativeModule(this, input, this.dependencies);
  }
  runtimeDiagnostic(error: unknown) {
    if (error instanceof PiNativeError) return { connectionState: "recovery_required" as const,
      message: piNativeRecoveryMessage(error.code) ?? "The Pi runtime is unavailable. Verify Pi 1.4.0 and the configured native directories on the execution host." };
    return undefined;
  }
}
