import { createThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConnectionSettingPreferenceRepository } from "../../db/repositories/connection-setting-preference-repository.js";
import { PiConversationRepository } from "./pi-conversation-repository.js";
import { acquireNativeStoreLock, lockIdentity } from "../../security/locks.js";
import {
  NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES,
  type BackendModule,
  type BackendModuleConfigurationInput,
  type BackendDiscoveryAdapter,
  type BackendModuleRuntime,
  type BackendModuleRuntimeContext,
  type BackendNativeStoreLifecycle,
  type PreparedBackendModule,
} from "../module.js";
import { PiBackendThreadPersistenceAdapter } from "./pi-backend-thread-persistence-adapter.js";
import { PiSavedAgentAdapter } from "./pi-saved-agent-adapter.js";
import { PiBackendDriverFactory } from "./pi-driver-factory.js";
import {
  resolvePiStorage,
  resolveRemotePiStorage,
  type PiStorage,
} from "./pi-storage.js";
import { PiThreadActionPersistence } from "./pi-thread-action-persistence.js";
import { PiThreadPresentationProvider } from "./pi-thread-presentation-provider.js";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import { resolveStateDirectory } from "../../config/config.js";
import {
  compileBackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../model-policy.js";
import { PiAutomationExecutionPolicy } from "./pi-automation-execution-policy.js";
import { PI_PROTOCOL_RELEASE } from "./pi-release.js";

class PiBackendModuleRuntime implements BackendModuleRuntime {
  readonly scope;
  readonly instance;
  readonly driverFactory;
  readonly threadPersistence;
  readonly bindingDetails;
  readonly presentation;
  readonly actionPersistence;
  readonly discoveryPersistence;
  readonly discovery;
  readonly savedAgents;
  readonly automationExecutionPolicy;
  readonly installationAdvisories = NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES;
  readonly managedProviderTerminals = Object.freeze({
    async authorizeAdmission(): Promise<never> {
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "Managed terminals are not supported by the Pi backend.",
        false,
      );
    },
    async attachViewer(): Promise<never> {
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "Managed terminals are not supported by the Pi backend.",
        false,
      );
    },
  });
  readonly #remoteServiceCwd?: string;
  #closed = false;

  constructor(
    context: BackendModuleRuntimeContext,
    storage: PiStorage,
    namespaceKey: string,
    workspacePathMode: "local_canonical" | "remote_semantic",
    modelPolicy: CompiledBackendModelPolicy,
  ) {
    this.scope = context.scope;
    this.instance = context.instance;
    const pi = new PiConversationRepository(context.database);
    this.automationExecutionPolicy = new PiAutomationExecutionPolicy(
      pi,
      modelPolicy,
    );
    const preferences = new ConnectionSettingPreferenceRepository(
      context.database,
    );
    const persistence = new PiBackendThreadPersistenceAdapter(pi, preferences);
    const remoteServiceCwd = path.join(
      storage.agentDir,
      "sedes-remote-services",
      context.instance.id,
      context.environmentOperations.environmentId,
    );
    this.#remoteServiceCwd =
      context.environmentOperations.environmentKind !== "local"
        ? remoteServiceCwd
        : undefined;
    this.driverFactory = new PiBackendDriverFactory({
      resolveThreadEnvironment: createThreadEnvironmentResolver(context),
      scope: context.scope,
      instance: context.instance,
      nativeDiscoveryNamespaceKey: namespaceKey,
      toolProvenanceKey: context.toolProvenanceKey,
      agentTools: context.agentTools,
      agentToolSourceCapabilities: context.agentToolSourceCapabilities,
      agentToolCli: context.agentToolCli,
      ...(context.environmentOperations.environmentKind !== "local"
        ? {
            resolveRemoteWorkspace: (workspace) => {
              const tools = context.environmentOperations.workspaceTools;
              const workspaceContext =
                context.environmentOperations.workspaceContext;
              const workspaceSkills =
                context.environmentOperations.workspaceSkills;
              if (
                tools.availability !== "available" ||
                tools.implementation !== "sidecar" ||
                workspaceContext.availability !== "available" ||
                workspaceContext.implementation !== "sidecar"
              ) {
                throw new Error("pi_remote_workspace_operations_unavailable");
              }
              return {
                semanticCwd: workspace.canonicalPath,
                serviceCwd: remoteServiceCwd,
                executor: tools.forWorkspace(workspace),
                contextReader: workspaceContext.forWorkspace(workspace),
                ...(workspaceSkills.availability === "available" &&
                workspaceSkills.implementation === "sidecar"
                  ? { skillReader: workspaceSkills.forWorkspace(workspace) }
                  : {}),
                environmentLabel:
                  context.environmentOperations.environmentLabel,
              };
            },
          }
        : {}),
      toolAccessPolicy: (scope, applicationThreadId) =>
        pi.getSettings(scope, applicationThreadId).toolMode,
      // A bound attached session is authoritative for the settings it owns.
      // Reserved/creating sessions still carry Pi's own resolved defaults and
      // must not overwrite the durable draft selections before first-send
      // initialization applies them. Tool access is Sedes-owned policy and
      // stays untouched either way.
      onEffectiveSettings: (scope, applicationThreadId, settings) => {
        if (!settings.model || !settings.thinkingLevel) return;
        pi.syncObservedSettingsForBoundThread(scope, applicationThreadId, {
          modelProvider: settings.model.provider,
          modelId: settings.model.id,
          thinkingLevel: settings.thinkingLevel,
        });
      },
      agentDir: storage.agentDir,
      ...(storage.sessionDirectoryOverride
        ? { sessionDirectory: storage.sessionDirectoryOverride }
        : {}),
      workspacePathMode,
      modelPolicy,
      ...(context.workspaceIsolation
        ? { isolatedWorkspaces: context.workspaceIsolation }
        : {}),
    });
    this.threadPersistence = persistence;
    this.bindingDetails = persistence;
    this.presentation = new PiThreadPresentationProvider(pi, modelPolicy);
    this.actionPersistence = new PiThreadActionPersistence(pi, preferences);
    this.discoveryPersistence = persistence;
    this.savedAgents = new PiSavedAgentAdapter({
      preferences,
      persistence,
    });
    this.discovery = {
      nativeNamespaceKey(connection) {
        if (
          connection.backendInstanceId !== context.instance.id ||
          connection.kind !== "pi_sdk"
        ) {
          throw new Error("pi_discovery_connection_mismatch");
        }
        return namespaceKey;
      },
    } satisfies BackendDiscoveryAdapter;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("pi_backend_runtime_closed");
    if (this.#remoteServiceCwd) {
      await mkdir(this.#remoteServiceCwd, { mode: 0o700, recursive: true });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.driverFactory.close();
  }
}

class PreparedPiBackendModule implements PreparedBackendModule {
  readonly backendInstanceId: string;
  readonly module: BackendModule;
  readonly nativeStores: readonly BackendNativeStoreLifecycle[];
  readonly nativeNamespaces: PreparedBackendModule["nativeNamespaces"];
  readonly #storage: PiStorage;
  readonly #namespaceKey: string;
  readonly #lockRuntimeRoot: string;
  readonly #executionEnvironmentId: string | undefined;
  readonly #workspacePathMode: "local_canonical" | "remote_semantic";
  readonly #modelPolicy: CompiledBackendModelPolicy;

  constructor(module: BackendModule, input: BackendModuleConfigurationInput) {
    this.module = module;
    this.backendInstanceId = input.backend.id;
    this.#modelPolicy = compileBackendModelPolicy(
      input.backend.modelPolicy,
      "provider_model_effort",
    );
    const executionEnvironmentIds = new Set(
      input.connections
        .filter(({ enabled }) => enabled)
        .map(({ executionEnvironmentId }) => executionEnvironmentId),
    );
    const executionEnvironmentId = [...executionEnvironmentIds][0];
    if (
      input.backend.enabled &&
      (executionEnvironmentIds.size !== 1 || !executionEnvironmentId)
    ) {
      throw new Error("pi_execution_environment_invalid");
    }
    this.#executionEnvironmentId = executionEnvironmentId;
    const executionEnvironment = executionEnvironmentId
      ? input.executionEnvironments.find(
          ({ id }) => id === executionEnvironmentId,
        )
      : undefined;
    if (executionEnvironmentId && !executionEnvironment) {
      throw new Error("pi_execution_environment_invalid");
    }
    this.#storage =
      executionEnvironment !== undefined && executionEnvironment.kind !== "local"
        ? resolveRemotePiStorage(
            {
              installationStateDirectory: resolveStateDirectory(
                input.environment,
              ),
              backendInstanceId: input.backend.id,
              executionEnvironmentId: executionEnvironment.id,
            },
            input.environment,
          )
        : resolvePiStorage(input.environment);
    this.#workspacePathMode =
      executionEnvironment !== undefined && executionEnvironment.kind !== "local"
        ? "remote_semantic"
        : "local_canonical";
    this.#namespaceKey = lockIdentity(this.#storage.sessionDirectory);
    this.#lockRuntimeRoot = input.environment.XDG_RUNTIME_DIR
      ? path.resolve(input.environment.XDG_RUNTIME_DIR)
      : path.join(os.homedir(), ".local", "state");
    this.nativeStores = input.backend.enabled
      ? [
          Object.freeze({
            sortKey: `pi\0${this.#namespaceKey}`,
            namespaceKey: this.#namespaceKey,
            label: "Pi session store",
            acquire: async () => {
              await mkdir(this.#storage.sessionDirectory, {
                mode: 0o700,
                recursive: true,
              });
              const lock = await acquireNativeStoreLock(
                await realpath(this.#storage.sessionDirectory),
                this.#lockRuntimeRoot,
                "Pi session store",
              );
              return { release: () => lock.release() };
            },
          }),
        ]
      : [];
    this.nativeNamespaces = Object.freeze(
      this.nativeStores.map(({ sortKey, namespaceKey }) =>
        Object.freeze({ sortKey, namespaceKey }),
      ),
    );
  }

  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime {
    if (
      context.instance.id !== this.backendInstanceId ||
      context.instance.tenantId !== context.scope.tenantId ||
      context.instance.kind !== "pi" ||
      context.instance.protocolRelease !== PI_PROTOCOL_RELEASE ||
      context.connections.some(
        (connection) =>
          connection.backendInstanceId !== context.instance.id ||
          connection.tenantId !== context.scope.tenantId ||
          connection.ownerPrincipalId !== context.scope.principalId ||
          connection.kind !== "pi_sdk" ||
          connection.executionEnvironmentId !== this.#executionEnvironmentId,
      )
    ) {
      throw new Error("pi_backend_runtime_context_invalid");
    }
    return new PiBackendModuleRuntime(
      context,
      this.#storage,
      this.#namespaceKey,
      this.#workspacePathMode,
      this.#modelPolicy,
    );
  }
}

export class PiBackendModule implements BackendModule {
  readonly backendKind = "pi" as const;
  readonly connectionKinds = ["pi_sdk"] as const;
  readonly protocolRelease = PI_PROTOCOL_RELEASE;

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    if (
      input.backend.kind !== this.backendKind ||
      (input.backend.enabled &&
        input.backend.protocolRelease !== PI_PROTOCOL_RELEASE) ||
      input.backend.moduleConfiguration !== undefined ||
      input.connections.some(
        (connection) =>
          connection.backendInstanceId !== input.backend.id ||
          connection.kind !== "pi_sdk" ||
          connection.moduleConfiguration !== undefined,
      )
    ) {
      throw new Error("pi_backend_configuration_invalid");
    }
    return new PreparedPiBackendModule(this, input);
  }
}
