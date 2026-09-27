import { randomUUID } from "node:crypto";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { backendStartupEnvironmentVariables, mergeResolvedEnvironment, resolveEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import type { AgentConnectionProfile } from "../contracts.js";
import { NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES, type BackendModule, type BackendModuleConfigurationInput, type BackendModuleRuntime, type BackendModuleRuntimeContext, type BackendRuntimeAdministration, type BackendRuntimeInspection, type PreparedBackendModule } from "../module.js";
import { parseOpenCodeBackendConfiguration, type PreparedOpenCodeBackendConfiguration } from "./opencode-backend-configuration.js";
import { OpenCodeRuntime, openCodeRuntimeNamespaceKey, type OpenCodeRuntimeInput } from "./opencode-runtime.js";
import { OPENCODE_RELEASE, OpenCodeRuntimeError } from "./opencode-release.js";
import { BackendRuntimeControlRejectedError } from "../runtime-control.js";
import { OpenCodeThreadRepository } from "./opencode-thread-repository.js";
import { OpenCodeBackendThreadPersistenceAdapter } from "./opencode-backend-thread-persistence-adapter.js";
import { OpenCodeBackendDriverFactory } from "./opencode-driver-factory.js";
import { OpenCodeThreadActionPersistence } from "./opencode-thread-action-persistence.js";
import { OpenCodeThreadPresentationProvider } from "./opencode-thread-presentation-provider.js";
import { OpenCodeSavedAgentBackendAdapter } from "./opencode-saved-agent-adapter.js";
import { OpenCodeAutomationExecutionPolicy } from "./opencode-automation-execution-policy.js";

type NativeRuntime = Pick<OpenCodeRuntime, "nativeNamespaceKey" | "start" | "health" | "snapshot" | "stop" | "close">;
type NativeRuntimeFactory = (input: OpenCodeRuntimeInput) => NativeRuntime;
const managedTerminals = Object.freeze({
  async authorizeAdmission(): Promise<never> { throw terminalUnavailable(); },
  async attachViewer(): Promise<never> { throw terminalUnavailable(); },
});

/** Deliberately absent from compiledBackendModuleCatalog until conversation execution is qualified. */
export class OpenCodeBackendModule implements BackendModule {
  readonly backendKind = "opencode" as const;
  readonly connectionKinds = ["opencode_http"] as const;
  readonly protocolRelease = OPENCODE_RELEASE;
  constructor(readonly createNativeRuntime: NativeRuntimeFactory = input => new OpenCodeRuntime(input)) {}

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    const configuration = parseOpenCodeBackendConfiguration(input);
    if (input.backend.protocolRelease !== OPENCODE_RELEASE) throw new Error("opencode_protocol_release_invalid");
    const environments = new Set(input.connections.filter(connection => connection.enabled).map(connection => connection.executionEnvironmentId));
    if (configuration.enabled && environments.size !== 1) throw new Error("opencode_execution_environment_invalid");
    const environmentId = configuration.enabled ? [...environments][0]! : undefined;
    const namespace = environmentId ? openCodeRuntimeNamespaceKey(environmentId, configuration.nativeStorePath) : undefined;
    let created = false;
    return {
      backendInstanceId: configuration.backendInstanceId,
      module: this,
      nativeNamespaces: namespace ? Object.freeze([{ sortKey: `opencode:${namespace}`, namespaceKey: namespace }]) : Object.freeze([]),
      // The lazy resident runtime acquires its physical store lease before HTTP or process admission.
      nativeStores: Object.freeze([]),
      createRuntime: context => {
        if (created || !configuration.enabled || !environmentId || !namespace ||
            context.environmentOperations.environmentKind !== "local" || context.instance.kind !== "opencode" ||
            context.instance.id !== configuration.backendInstanceId || context.instance.protocolRelease !== OPENCODE_RELEASE ||
            !context.instance.enabled || context.instance.tenantId !== context.scope.tenantId ||
            context.environmentChannel.executionEnvironmentId !== environmentId ||
            context.environmentChannel.scope.tenantId !== context.scope.tenantId ||
            context.environmentChannel.scope.principalId !== context.scope.principalId ||
            context.connections.length !== input.connections.length ||
            new Set(context.connections.map(connection => connection.id)).size !== context.connections.length ||
            new Set(context.connections.map(connection => connection.templateId)).size !== context.connections.length) {
          throw new Error("opencode_runtime_context_invalid");
        }
        for (const connection of context.connections) {
          const configured = input.connections.find(candidate => candidate.id === connection.templateId);
          if (!configured || connection.kind !== "opencode_http" || connection.backendInstanceId !== context.instance.id ||
              connection.tenantId !== context.scope.tenantId || connection.ownerPrincipalId !== context.scope.principalId ||
              connection.executionEnvironmentId !== configured.executionEnvironmentId || connection.enabled !== configured.enabled) {
            throw new Error("opencode_runtime_connection_invalid");
          }
        }
        created = true;
        return new OpenCodeModuleRuntime(context, configuration, input, namespace, this.createNativeRuntime);
      },
    };
  }
}

class OpenCodeModuleRuntime implements BackendModuleRuntime {
  readonly scope;
  readonly instance;
  readonly driverFactory;
  readonly threadPersistence;
  readonly bindingDetails;
  readonly discoveryPersistence;
  readonly discovery;
  readonly presentation;
  readonly actionPersistence = new OpenCodeThreadActionPersistence();
  readonly savedAgents = new OpenCodeSavedAgentBackendAdapter();
  readonly automationExecutionPolicy = new OpenCodeAutomationExecutionPolicy();
  readonly installationAdvisories = NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES;
  readonly managedProviderTerminals = managedTerminals;
  readonly administration: BackendRuntimeAdministration | undefined;
  readonly stopBeforeConversationCleanup: (() => Promise<void>) | undefined;
  readonly #incarnation = randomUUID();
  #owner?: NativeRuntime;
  #opening?: Promise<NativeRuntime>;
  #closed = false;
  #closePromise?: Promise<void>;
  #revision = 0;
  #lastShutdownIncomplete = false;
  #administrating = false;
  readonly #startup;

  constructor(readonly context: BackendModuleRuntimeContext, readonly configuration: PreparedOpenCodeBackendConfiguration,
    readonly input: BackendModuleConfigurationInput, readonly namespace: string, readonly createNativeRuntime: NativeRuntimeFactory) {
    this.scope = context.scope; this.instance = context.instance;
    this.#startup = backendStartupEnvironmentVariables(input);
    const repository = new OpenCodeThreadRepository({ database: context.database, scope: context.scope,
      backendInstanceId: context.instance.id, nativeNamespaceKey: namespace });
    const persistence = new OpenCodeBackendThreadPersistenceAdapter(repository);
    this.threadPersistence = this.bindingDetails = this.discoveryPersistence = persistence;
    this.presentation = new OpenCodeThreadPresentationProvider(context.scope, context.instance.id);
    const connections = new Map(context.connections.map(connection => [connection.id, connection]));
    this.discovery = { nativeNamespaceKey: (connection: AgentConnectionProfile) => {
      const admitted = connections.get(connection.id);
      if (!admitted || connection.tenantId !== context.scope.tenantId || connection.ownerPrincipalId !== context.scope.principalId ||
          connection.backendInstanceId !== context.instance.id || connection.kind !== "opencode_http" ||
          connection.executionEnvironmentId !== admitted.executionEnvironmentId || connection.templateId !== admitted.templateId) {
        throw new Error("opencode_discovery_authority_invalid");
      }
      return namespace;
    } };
    this.driverFactory = new OpenCodeBackendDriverFactory({ scope: context.scope, instance: context.instance, connections: context.connections,
      health: async () => {
        try { const owner = await this.#native(); this.#assertOpen(); await owner.start(); return await owner.health(); }
        catch { return { available: false, checkedAt: new Date().toISOString() }; }
      } });
    if (configuration.connection.ownership === "owned") {
      this.administration = {
        inspect: async () => this.#inspect(),
        stop: input => this.#administer(input, false),
        restart: input => this.#administer(input, true),
      };
      this.stopBeforeConversationCleanup = async () => { await this.#stop(); };
    }
  }

  async start(): Promise<void> { this.#assertOpen(); }
  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    const state = this.#owner?.snapshot().state;
    return !this.#opening && (!state || state === "stopped") ? "not_started" : state === "ready" ? "started" : "unknown";
  }
  close(): Promise<void> {
    this.#closed = true;
    return this.#closePromise ??= (async () => {
      await this.#opening?.catch(() => undefined);
      await this.#owner?.close();
    })();
  }

  async #native(): Promise<NativeRuntime> {
    this.#assertOpen();
    if (this.#owner) return this.#owner;
    if (this.#opening) return this.#opening;
    this.#opening = (async () => {
      const environment = this.configuration.connection.ownership === "owned"
        ? mergeResolvedEnvironment(this.input.environment, await resolveEnvironmentVariables(this.#startup, this.input.environment))
        : this.input.environment;
      this.#assertOpen();
      const configured = this.configuration.connection;
      const owner = this.createNativeRuntime({
        authority: { ...this.context.scope, backendInstanceId: this.context.instance.id,
          executionEnvironmentId: this.context.environmentChannel.executionEnvironmentId },
        nativeStorePath: this.configuration.nativeStorePath,
        configDirectory: this.configuration.configDirectory,
        environment,
        connection: configured.ownership === "owned" ? configured : { ownership: "external", channel: { type: "http", url: configured.channel.url } },
        ...(configured.ownership === "external" ? { externalPassword: async () => {
          this.#assertOpen();
          const secret = await this.context.environmentChannel.resolveSecret({ ...this.context.scope,
            backendInstanceId: this.context.instance.id, executionEnvironmentId: this.context.environmentChannel.executionEnvironmentId },
            configured.channel.authentication.secret, ++this.#revision, AbortSignal.timeout(10_000), "http_basic_password");
          try { this.#assertOpen(); return secret.value; } finally { secret.discard(); }
        } } : {}),
      });
      if (owner.nativeNamespaceKey !== this.namespace) throw new Error("opencode_runtime_namespace_changed");
      return this.#owner = owner;
    })().finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  #inspect(): BackendRuntimeInspection {
    this.#assertOpen();
    const snapshot = this.#owner?.snapshot();
    const idle = (!snapshot || snapshot.state === "stopped") && !this.#opening;
    return {
      // A ready resident owner proves runtime presence; activity counts remain unknown.
      state: idle && !this.#lastShutdownIncomplete ? "idle" : snapshot?.state === "ready" ? "active" : "unknown",
      incarnation: snapshot?.generation ?? this.#incarnation,
      revision: configurationFingerprint({ snapshot: snapshot ?? null, revision: this.#revision, opening: !!this.#opening }),
      blockers: snapshot?.state === "cleanup_unproved" ? ["cleanup_unproven"] : this.#lastShutdownIncomplete ? ["unsettled_outcome"] : idle ? [] : ["unknown_state"],
      ...(snapshot?.state === "ready" ? { startupEnvironmentFingerprint: configurationFingerprint(this.#startup) } : {}),
      // Native foreground/background inventory is not yet projected; absent counts mean unknown.
    };
  }
  async #administer(input: { expectedRevision: string; force: boolean }, restart: boolean): Promise<void> {
    const state = this.#inspect();
    if (this.#administrating || state.revision !== input.expectedRevision) {
      throw new BackendRuntimeControlRejectedError("confirmation_stale");
    }
    if (!input.force && state.blockers.length) throw new BackendRuntimeControlRejectedError("blocked");
    this.#administrating = true; this.#revision++;
    try {
      await this.#stop();
      if (restart) { const owner = await this.#native(); await owner.start(); this.#lastShutdownIncomplete = false; }
    } catch (error) {
      if (error instanceof OpenCodeRuntimeError &&
          ["opencode_owned_cleanup_unproved", "opencode_native_store_initialization_unproved"].includes(error.code)) {
        throw new BackendRuntimeControlRejectedError("cleanup_unproven", { cause: error });
      }
      throw error;
    } finally { this.#administrating = false; this.#revision++; }
  }
  async #stop(): Promise<void> {
    await this.#opening;
    if (!this.#owner) return;
    const result = await this.#owner.stop();
    if (result.nativeInterrupts !== "not_owned") {
      this.#lastShutdownIncomplete = result.nativeInterrupts === "incomplete";
    }
  }
  #assertOpen(): void { if (this.#closed) throw new Error("opencode_module_runtime_closed"); }
}
function terminalUnavailable(): ManagedTerminalCarrierError {
  return new ManagedTerminalCarrierError("terminal_unavailable", "Managed OpenCode terminals are unavailable.", false);
}
