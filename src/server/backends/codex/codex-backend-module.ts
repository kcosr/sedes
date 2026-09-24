import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { attachmentDiagnostic } from "../../diagnostics/attachment-diagnostics.js";
import { backendStartupEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { createThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { CodexRemoteRuntimeSupervisor } from "./runtime/codex-remote-runtime-supervisor.js";
import { CodexRuntimeReceiptStore } from "./runtime/codex-runtime-receipt-store.js";
import { createCodexRuntimeTransport } from "./runtime/codex-runtime-transport.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type {
  BackendDiscoveryAdapter,
  BackendModule,
  BackendModuleConfigurationInput,
  BackendModuleRuntime,
  BackendModuleRuntimeContext,
  BackendNativeStoreLifecycle,
  PreparedBackendModule,
} from "../module.js";
import {
  parseCodexBackendConfiguration,
  type CodexBackendModuleConfiguration,
  type PreparedCodexBackendConfiguration,
} from "./codex-backend-configuration.js";
import { CodexBackendThreadPersistenceAdapter } from "./codex-backend-thread-persistence-adapter.js";
import { CodexDaemonSupervisor } from "./codex-daemon-supervisor.js";
import { CodexBackendDriverFactory } from "./codex-driver-factory.js";
import {
  codexNativeStoreNamespaceKey,
  createCodexNativeStoreLifecycle,
} from "./codex-native-store-lock.js";
import { CodexNativeStoreOwnershipGate } from "./codex-native-store-ownership.js";
import { CodexThreadActionPersistence } from "./codex-thread-action-persistence.js";
import {
  CODEX_APP_SERVER_RELEASE,
  type VerifiedCodexRuntimeVersion,
} from "./codex-release-guard.js";
import {
  resolveCodexRuntimeConfiguration,
  type CodexRuntimeConfigurationInput,
  type ResolvedCodexRuntimeConfiguration,
} from "./codex-runtime-config.js";
import { CodexThreadPresentationProvider } from "./codex-thread-presentation-provider.js";
import { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import { CodexFastModeSessionRegistry } from "./codex-fast-mode-session.js";
import type {
  CodexExecutionSettingsProvider,
  CodexObservedExecutionSettings,
} from "./codex-conversation-handle.js";
import {
  CodexThreadExecutionSettingsRepository,
  type CodexExecutionSettingsTuple,
} from "./codex-thread-execution-settings-repository.js";
import { codexForkSettingsEligibility } from "./codex-fork-settings-eligibility.js";
import {
  isCodexExecutionPolicyAllowed,
  type CodexExecutionPolicyAllowlist,
  type CodexExecutionPolicySelection,
} from "./codex-execution-policy.js";
import { ProviderFeatureMutationRepository } from "../../db/repositories/provider-feature-mutation-repository.js";
import { PrincipalApplicationPreferenceRepository } from "../../db/repositories/principal-application-preference-repository.js";
import type {
  CodexClientLifecycleSnapshot,
  CodexSharedClientFacade,
} from "./codex-client-facade.js";
import { CodexServerRequestRouter } from "./codex-server-request-router.js";
import { copyCodexSubmissionCorrelationKey } from "./codex-submission-correlation.js";
import type {
  ProviderTransportScope,
  FramedMessageTransport,
  FramedTransportFactory,
  FramedTransportLifecycleObserver,
} from "../../provider-protocol/transport/assured-framed-transport.js";
import {
  BackendError,
  type AgentConnectionProfile,
  type ConversationSubmissionSource,
} from "../contracts.js";
import { canonicalLocalEnvironmentDirectorySync } from "../../execution/local-environment-channel.js";
import { CodexManagedTuiController } from "./codex-managed-tui-controller.js";
import { codexManagedTuiCapability, CodexRuntimeManagedTuiLauncher, CodexRuntimeManagedTuiRegistry } from "./runtime/codex-runtime-managed-tui.js";
import { recoverCodexRuntimeAdministration } from "./runtime/codex-runtime-administration.js";
import {
  codexManagedTuiModelPolicySupported,
  codexTuiLaunchPolicyRepresentable,
  EnvironmentCodexManagedTuiLauncher,
} from "./codex-managed-tui-launcher.js";
import { DatabaseCodexAgentToolCliEnvironmentProvider } from "./codex-agent-tool-cli-environment.js";
import { CodexSavedAgentBackendAdapter } from "./codex-saved-agent-adapter.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { assertCodexLiveModelSelection } from "./codex-live-model-selection.js";
import { CodexAutomationExecutionPolicy } from "./codex-automation-execution-policy.js";
import { CodexInstallationAdvisorySource } from "./codex-installation-advisories.js";

type CodexRuntimeSupervisor = {
  readonly administration?: import("../module.js").BackendRuntimeAdministration;
  readonly client: CodexSharedClientFacade;
  start(): Promise<void>;
  close(): Promise<void>;
};

type CreateSupervisorInput = {
  readonly scope: ProviderTransportScope;
  readonly expectedCodexHome?: string;
  readonly transportFactory: FramedTransportFactory;
  readonly nativeStoreOwnership?: CodexNativeStoreOwnershipGate;
  readonly maximumRestartAttempts?: number | "unbounded";
  readonly serverRequestRouter: CodexServerRequestRouter;
  readonly onRuntimeVersionAssessment: (
    assessment: VerifiedCodexRuntimeVersion,
  ) => void;
  readonly expectedRuntimeVersion?: () => string | undefined;
};

export interface CodexBackendModuleDependencies {
  readonly resolveRuntimeConfiguration: (
    input: CodexRuntimeConfigurationInput,
  ) => Promise<ResolvedCodexRuntimeConfiguration>;
  readonly createTransportFactory: (input: {
    readonly scope: ProviderTransportScope;
    readonly configuration: ResolvedCodexRuntimeConfiguration;
    readonly environmentChannel: BackendModuleRuntimeContext["environmentChannel"];
  }) => FramedTransportFactory;
  readonly createSupervisor: (
    input: CreateSupervisorInput,
  ) => CodexRuntimeSupervisor;
}

const productionDependencies: CodexBackendModuleDependencies = Object.freeze({
  resolveRuntimeConfiguration: resolveCodexRuntimeConfiguration,
  createTransportFactory: createCodexRuntimeTransport,
  createSupervisor: (input: CreateSupervisorInput) =>
    new CodexDaemonSupervisor(input),
});

class DeferredCodexTransportFactory implements FramedTransportFactory {
  #delegate: FramedTransportFactory | undefined;

  configure(delegate: FramedTransportFactory): void {
    if (this.#delegate) {
      throw new Error("codex_runtime_transport_already_configured");
    }
    this.#delegate = delegate;
  }

  open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
    lifecycle?: FramedTransportLifecycleObserver,
  ): Promise<FramedMessageTransport> {
    if (!this.#delegate) {
      return Promise.reject(
        new Error("codex_runtime_transport_not_configured"),
      );
    }
    return this.#delegate.open(
      expectedScope,
      connectionGeneration,
      signal,
      lifecycle,
    );
  }
}

class CodexBackendModuleRuntime implements BackendModuleRuntime {
  get administration() { return this.#supervisor.administration; }
  readonly scope;
  readonly instance;
  readonly driverFactory;
  readonly threadPersistence;
  readonly bindingDetails;
  readonly presentation;
  readonly actionPersistence;
  readonly discoveryPersistence;
  readonly discovery;
  readonly managedProviderTerminals;
  readonly savedAgents;
  readonly automationExecutionPolicy;
  readonly installationAdvisories = new CodexInstallationAdvisorySource();
  readonly #context: BackendModuleRuntimeContext;
  readonly #prepared: PreparedCodexBackendConfiguration;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #expectedCodexHome: string | undefined;
  readonly #dependencies: CodexBackendModuleDependencies;
  readonly #executionEnvironmentId: string;
  readonly #transport = new DeferredCodexTransportFactory();
  readonly #serverRequests = new CodexServerRequestRouter();
  readonly #supervisor: CodexRuntimeSupervisor;
  readonly #settingsRepository: CodexThreadExecutionSettingsRepository;
  readonly #goalSessions: CodexGoalSessionRegistry;
  readonly #fastModeSessions: CodexFastModeSessionRegistry;
  readonly #managedTui: CodexManagedTuiController;
  readonly #remoteManagedTui: CodexRuntimeManagedTuiRegistry | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closeRequested = false;
  #activeConfirmationGeneration: number | undefined;
  #unsubscribeLifecycle: (() => void) | undefined;
  #availabilityPublication: Promise<void> = Promise.resolve();
  #ownedRuntimeVersion: string | undefined;
  #appliedOwnedPath: string | undefined;

  constructor(input: {
    readonly context: BackendModuleRuntimeContext;
    readonly prepared: PreparedCodexBackendConfiguration;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly startupEnvironmentVariables: EnvironmentVariableOverrides;
    readonly expectedCodexHome?: string;
    readonly namespaceKey: string;
    readonly ownership?: CodexNativeStoreOwnershipGate;
    readonly dependencies: CodexBackendModuleDependencies;
  }) {
    this.#context = input.context;
    this.#prepared = input.prepared;
    this.#environment = input.environment;
    this.#startupEnvironmentVariables = input.startupEnvironmentVariables;
    this.#expectedCodexHome = input.expectedCodexHome;
    this.#dependencies = input.dependencies;
    this.#executionEnvironmentId =
      input.context.environmentChannel.executionEnvironmentId;
    this.scope = input.context.scope;
    this.instance = input.context.instance;
    const runtimeScope = this.#runtimeScope();
    this.#supervisor = input.context.sidecarRuntime
      ? new CodexRemoteRuntimeSupervisor({
          scope: runtimeScope,
          provider: input.context.sidecarRuntime,
          configuration: { startupEnvironmentVariables: this.#startupEnvironmentVariables, instance: input.context.instance, connections: input.context.connections, connection: input.prepared.configuration.connection },
          serverRequests: this.#serverRequests,
          receipts: new CodexRuntimeReceiptStore(input.context.database),
          onRuntimeVersionAssessment: assessment => this.installationAdvisories.observe(assessment),
        })
      : input.dependencies.createSupervisor({
      scope: runtimeScope,
      ...(input.expectedCodexHome
        ? { expectedCodexHome: input.expectedCodexHome }
        : {}),
      transportFactory: this.#transport,
      ...(input.ownership ? { nativeStoreOwnership: input.ownership } : {}),
      ...(input.prepared.configuration.connection.ownership === "external"
        ? { maximumRestartAttempts: "unbounded" as const }
        : {}),
      serverRequestRouter: this.#serverRequests,
      onRuntimeVersionAssessment: (assessment) =>
        this.installationAdvisories.observe(assessment),
      ...(input.prepared.configuration.connection.ownership === "owned"
        ? { expectedRuntimeVersion: () => this.#ownedRuntimeVersion }
        : {}),
    });
    const settingsRepository = new CodexThreadExecutionSettingsRepository(
      input.context.database,
    );
    this.#settingsRepository = settingsRepository;
    this.automationExecutionPolicy = new CodexAutomationExecutionPolicy(
      input.context.database,
      input.prepared.modelPolicy,
    );
    const executionPolicy = input.prepared.configuration.policy;
    const configuredDefaultsByTemplateId = new Map(
      input.prepared.connections.map((connection) => [
        connection.id,
        executionPolicySelection(connection.configuration.defaults),
      ]),
    );
    const defaultExecutionPolicyByConnectionId = new Map(
      input.context.connections.map((connection) => {
        const policy = configuredDefaultsByTemplateId.get(
          connection.templateId,
        );
        if (!policy) throw new Error("codex_connection_default_policy_missing");
        return [connection.id, policy] as const;
      }),
    );
    const executionSettings = new CodexExecutionSettingsRepositoryAdapter(
      settingsRepository,
      executionPolicy,
      input.prepared.modelPolicy,
    );
    this.#goalSessions = new CodexGoalSessionRegistry();
    this.#fastModeSessions = new CodexFastModeSessionRegistry();
    const remoteSupervisor = this.#supervisor instanceof CodexRemoteRuntimeSupervisor ? this.#supervisor : undefined;
    this.#remoteManagedTui = remoteSupervisor && input.prepared.configuration.connection.ownership === "external"
      ? new CodexRuntimeManagedTuiRegistry({
          connect: () => remoteSupervisor.attachment(),
          onRuntimeVersionAssessment: assessment => this.installationAdvisories.observe(assessment),
        })
      : undefined;
    this.#managedTui = new CodexManagedTuiController({
      supportsThreadEnvironment: (scope, threadId) => scope.tenantId === input.context.scope.tenantId && scope.principalId === input.context.scope.principalId && Object.keys(input.context.executionEnvironmentVariables?.(threadId) ?? {}).length === 0,
      ...(remoteSupervisor ? { isRuntimeSupported: () => remoteSupervisor.managedTuiAvailable() } : {}),
      ...(this.#remoteManagedTui ? { registry: this.#remoteManagedTui } : {}),
      client: this.#supervisor.client,
      isResumable: (scope, applicationThreadId) =>
        input.context.database
          .prepare(
            `
          SELECT 1 AS resumable
          FROM submission_completion_observations
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
          LIMIT 1
        `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) !==
        undefined,
      isPolicyRepresentable: (scope, applicationThreadId) => {
        const current = settingsRepository.find(
          scope,
          applicationThreadId,
        )?.desired;
        return (
          current != null &&
          codexTuiLaunchPolicyRepresentable(current) &&
          input.prepared.modelPolicy.isSelectionAllowed({
            modelId: current.model,
            reasoningEffort: current.reasoningEffort,
          })
        );
      },
      isModelSelectionAllowed: (model, reasoningEffort) =>
        input.prepared.modelPolicy.isSelectionAllowed({
          modelId: model,
          reasoningEffort,
        }),
    });
    this.managedProviderTerminals = this.#managedTui;
    this.driverFactory = new CodexBackendDriverFactory({
      onError: error => attachmentDiagnostic("codex_backend_observer_failed", {
        backendInstanceId: input.context.instance.id,
        stage: "backend_observer",
      }, error),
      usageSink: input.context.usage,
      nativeNamespace: input.namespaceKey,
      resolveThreadEnvironment: createThreadEnvironmentResolver(input.context),
      scope: input.context.scope,
      instance: input.context.instance,
      client: this.#supervisor.client,
      serverRequests: this.#serverRequests,
      toolProvenanceKey: copyCodexSubmissionCorrelationKey(
        input.context.toolProvenanceKey,
      ),
      modelPolicy: input.prepared.modelPolicy,
      executionSettings,
      outputArtifacts: input.context.outputArtifacts,
      agentToolCliEnvironment: new DatabaseCodexAgentToolCliEnvironmentProvider(
        {
          database: input.context.database,
          backendInstanceId: input.context.instance.id,
          runtime: input.context.agentToolCli,
          sourceCapabilities: input.context.agentToolSourceCapabilities,
          agentTools: input.context.agentTools,
          ...(input.prepared.configuration.connection.ownership === "owned" ? {
            appliedOwnedPath: async () => {
              if (remoteSupervisor) return await remoteSupervisor.appliedOwnedPath();
              if (this.#appliedOwnedPath === undefined) throw new Error("codex_owned_environment_unavailable");
              return this.#appliedOwnedPath;
            },
          } : {}),
        },
      ),
      composerSkillPreferences: new PrincipalApplicationPreferenceRepository(
        input.context.database,
      ),
      goalSessions: this.#goalSessions,
      fastModeSessions: this.#fastModeSessions,
      managedTui: this.#managedTui,
      connections: input.prepared.connections,
      materializedConnections: input.context.connections,
    });
    const resolveConnectionDefaults = (connection: AgentConnectionProfile) =>
      input.prepared.connections.find(({ id }) => id === connection.templateId)
        ?.configuration.defaults;
    const persistence = new CodexBackendThreadPersistenceAdapter({
      database: input.context.database,
      scope: input.context.scope,
      backendInstanceId: input.context.instance.id,
      executionSettings: settingsRepository,
      executionPolicy,
      modelPolicy: input.prepared.modelPolicy,
      resolveConnectionDefaults,
    });
    this.savedAgents = new CodexSavedAgentBackendAdapter({
      executionPolicy,
      modelPolicy: input.prepared.modelPolicy,
      backendInstanceId: input.context.instance.id,
      resolveConnectionDefaults,
      persistence,
    });
    this.threadPersistence = persistence;
    this.bindingDetails = persistence;
    this.discoveryPersistence = persistence;
    this.presentation = new CodexThreadPresentationProvider({
      settings: settingsRepository,
      executionPolicy,
      modelPolicy: input.prepared.modelPolicy,
      goalSessions: this.#goalSessions,
      fastModeRuntime: this.#fastModeSessions,
      managedTui: this.#managedTui,
    });
    this.actionPersistence = new CodexThreadActionPersistence({
      database: input.context.database,
      scope: input.context.scope,
      backendInstanceId: input.context.instance.id,
      settings: settingsRepository,
      featureMutations: new ProviderFeatureMutationRepository(
        input.context.database,
      ),
      executionPolicy,
      modelPolicy: input.prepared.modelPolicy,
      defaultExecutionPolicyByConnectionId,
      goalSessions: this.#goalSessions,
      fastModeRuntime: this.#fastModeSessions,
      managedTui: this.#managedTui,
    });
    this.discovery = {
      nativeNamespaceKey: (connection) => {
        this.#assertDiscoveryConnection(connection);
        return input.namespaceKey;
      },
    } satisfies BackendDiscoveryAdapter;
  }

  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    if (this.#context.sidecarRuntime) return this.#supervisor.client.lifecycleSnapshot().state === "ready" ? "started" : "unknown";
    return this.#startPromise ? "started" : "not_started";
  }

  start(): Promise<void> {
    if (this.#closePromise) {
      return Promise.reject(new Error("codex_backend_runtime_closed"));
    }
    this.#startPromise ??= this.#performStart();
    return this.#startPromise;
  }

  close(): Promise<void> {
    this.#closeRequested = true;
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async stopBeforeConversationCleanup(): Promise<void> {
    if (!this.#context.sidecarRuntime && this.#prepared.configuration.connection.ownership === "owned") {
      await this.driverFactory.ownership.interruptOwnedActiveTurns();
    }
    // External UDS/TCP endpoints are disconnected, never interrupted. Closing
    // the RPC client first also prevents late approval denials/unsubscribe
    // requests when the main-side conversation handles are subsequently freed.
    // For a sidecar this closes only the main attachment, including when the
    // scoped host Stop was rejected; native provider lifetime stays remote.
    await this.#supervisor.close();
  }

  async #performStart(): Promise<void> {
    if (this.#context.sidecarRuntime) {
      if (this.#remoteManagedTui && codexManagedTuiModelPolicySupported(this.#prepared.modelPolicy.policy)) {
        this.#managedTui.configure(new CodexRuntimeManagedTuiLauncher({
          ...(this.#prepared.configuration.tuiExecutablePath ? { configuredExecutablePath: this.#prepared.configuration.tuiExecutablePath } : {}),
          settings: authority => {
            const current = this.#settingsRepository.find(authority.scope, authority.applicationThreadId)?.desired;
            if (!current || !codexTuiLaunchPolicyRepresentable(current) || !this.#prepared.modelPolicy.isSelectionAllowed({ modelId: current.model, reasoningEffort: current.reasoningEffort })) throw new Error("codex_tui_execution_policy_unrepresentable");
            return current;
          },
          validateModelSelection: async ({ authority, settings, signal }) => {
            await assertCodexLiveModelSelection({ client: this.#supervisor.client, expectedGeneration: authority.appServerGeneration, model: settings.model, reasoningEffort: settings.reasoningEffort, signal });
          },
        }));
      } else {
        this.#managedTui.unavailable(this.#remoteManagedTui
          ? "Managed TUI is unavailable when this backend restricts model selection."
          : "Managed TUI is unavailable for an owned stdio Codex backend.");
      }
      this.#invalidateEffectiveConfirmations();
      this.#unsubscribeLifecycle = this.#supervisor.client.subscribeLifecycle(this.#consumeLifecycle);
      await this.#supervisor.start();
      await this.#availabilityPublication;
      return;
    }
    try {
      const resolved = await this.#dependencies.resolveRuntimeConfiguration({
        scope: this.#context.scope,
        instance: this.#context.instance,
        connections: this.#context.connections,
        connection: this.#prepared.configuration.connection,
        startupEnvironmentVariables: this.#startupEnvironmentVariables,
        environmentChannel: this.#context.environmentChannel,
        environment: this.#environment,
      });
      if (
        "codexHome" in resolved &&
        resolved.codexHome !== this.#expectedCodexHome
      ) {
        throw new Error("codex_runtime_native_home_changed");
      }
      if (resolved.connection.ownership === "owned") {
        this.#appliedOwnedPath = resolved.childEnvironment?.PATH ?? "";
        this.#ownedRuntimeVersion =
          resolved.connection.channel.executable.version;
        this.installationAdvisories.observe(
          resolved.connection.channel.executable,
        );
      }
      if (this.#closeRequested) {
        throw new Error("codex_backend_runtime_closed");
      }
      this.#transport.configure(
        this.#dependencies.createTransportFactory({
          scope: this.#runtimeScope(),
          configuration: resolved,
          environmentChannel: this.#context.environmentChannel,
        }),
      );
      if (
        resolved.connection.ownership === "external" &&
        codexManagedTuiModelPolicySupported(
          this.#prepared.modelPolicy.policy,
        ) &&
        this.#context.environmentChannel.resolveOwnedProcessExecutable !==
          undefined &&
        this.#context.environmentChannel.openOwnedPty !== undefined &&
        this.#context.environmentChannel.prepareManagedProcessEndpoint !==
          undefined
      ) {
        const launcher = new EnvironmentCodexManagedTuiLauncher({
          channels: this.#context.environmentChannel,
          configuration: resolved,
          ...(this.#prepared.configuration.tuiExecutablePath
            ? {
                configuredExecutablePath:
                  this.#prepared.configuration.tuiExecutablePath,
              }
            : {}),
          environment: this.#environment,
          settings: (authority) => {
            const current = this.#settingsRepository.find(
              authority.scope,
              authority.applicationThreadId,
            )?.desired;
            if (
              !current ||
              !codexTuiLaunchPolicyRepresentable(current) ||
              !this.#prepared.modelPolicy.isSelectionAllowed({
                modelId: current.model,
                reasoningEffort: current.reasoningEffort,
              })
            ) {
              throw new Error("codex_tui_execution_policy_unrepresentable");
            }
            return current;
          },
          validateModelSelection: async ({ authority, settings, signal }) =>
            await assertCodexLiveModelSelection({
              client: this.#supervisor.client,
              expectedGeneration: authority.appServerGeneration,
              model: settings.model,
              reasoningEffort: settings.reasoningEffort,
              signal,
            }),
          onRuntimeVersionAssessment: (assessment) =>
            this.installationAdvisories.observe(assessment),
        });
        this.#managedTui.configure(launcher);
      } else {
        this.#managedTui.unavailable(
          !codexManagedTuiModelPolicySupported(
            this.#prepared.modelPolicy.policy,
          )
            ? "Managed TUI is unavailable when this backend restricts model selection."
            : resolved.connection.ownership === "external"
              ? "This execution environment cannot launch managed terminals."
              : "Managed TUI is unavailable for an owned stdio Codex backend.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "codex_runtime_scope_invalid" ||
          error.message === "codex_runtime_native_home_changed" ||
          error.message === "codex_backend_runtime_closed")
      ) {
        throw error;
      }
      // A syntactically and securely configured but unavailable Codex server
      // remains registered with unavailable health. Healthy backends and the
      // application continue starting; no mutation can use an unready client.
      this.installationAdvisories.clear();
      const lifecycle = this.#supervisor.client.lifecycleSnapshot();
      this.#supervisor.client.updateLifecycle({
        state: "unavailable",
        generation: lifecycle.generation,
        unavailableReason: "runtime_configuration_unavailable",
      });
      await this.#context.environmentChannel.reportRuntimeAvailability(
        this.#runtimeScope(),
        {
          availability: "unavailable",
          diagnosticCode: "backend_runtime_configuration_unavailable",
        },
      );
      return;
    }
    // Persistence failure here is an application safety failure, not backend
    // unavailability. It must propagate and abort startup.
    this.#invalidateEffectiveConfirmations();
    this.#unsubscribeLifecycle = this.#supervisor.client.subscribeLifecycle(
      this.#consumeLifecycle,
    );
    await this.#supervisor.start().catch(() => undefined);
    await this.#availabilityPublication;
  }

  async #performClose(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    try {
      await this.#managedTui.close();
      await this.#supervisor.close();
      // Closing this runtime is itself the authoritative final availability
      // transition. Queue it after supervisor teardown (which may also emit a
      // synchronous lifecycle transition) and retain ownership until every
      // queued environment persistence operation settles.
      this.#publishRuntimeAvailability({
        availability: "unavailable",
        diagnosticCode: "backend_runtime_unavailable",
      });
      await this.#availabilityPublication;
    } finally {
      this.#unsubscribeLifecycle?.();
      this.#unsubscribeLifecycle = undefined;
      this.installationAdvisories.clear();
    }
  }

  readonly #consumeLifecycle = (
    lifecycle: CodexClientLifecycleSnapshot,
  ): void => {
    void this.#managedTui.consumeLifecycle().catch(() => undefined);
    if (lifecycle.state === "ready" || lifecycle.state === "idle") {
      if (this.#supervisor instanceof CodexRemoteRuntimeSupervisor && this.#supervisor.managedTuiAvailable()) {
        void this.#remoteManagedTui?.connect().catch(() => undefined);
      }
      this.#publishRuntimeAvailability({ availability: "available" });
    } else {
      this.installationAdvisories.clear();
      if (
        lifecycle.state === "circuit_open" ||
        (lifecycle.state === "unavailable" && lifecycle.generation > 0)
      ) {
        this.#publishRuntimeAvailability({
          availability: "unavailable",
          diagnosticCode:
            lifecycle.state === "circuit_open"
              ? "backend_runtime_circuit_open"
              : "backend_runtime_unavailable",
        });
      }
    }
    if (lifecycle.state === "ready" || lifecycle.state === "idle") {
      if (
        this.#activeConfirmationGeneration !== undefined &&
        this.#activeConfirmationGeneration !== lifecycle.generation
      ) {
        this.#invalidateEffectiveConfirmations();
      }
      this.#activeConfirmationGeneration = lifecycle.generation;
      return;
    }
    if (this.#activeConfirmationGeneration === undefined) return;
    this.#invalidateEffectiveConfirmations();
    this.#activeConfirmationGeneration = undefined;
  };

  #publishRuntimeAvailability(
    observation:
      | Readonly<{ readonly availability: "available" }>
      | Readonly<{
          readonly availability: "unavailable";
          readonly diagnosticCode: string;
        }>,
  ): void {
    this.#availabilityPublication = this.#availabilityPublication
      .catch(() => undefined)
      .then(() =>
        this.#context.environmentChannel.reportRuntimeAvailability(
          this.#runtimeScope(),
          observation,
        ),
      );
    // Lifecycle listeners are synchronous. Retain the rejecting promise so
    // startup can fail closed while also attaching a handler for failures from
    // later, asynchronously published lifecycle transitions.
    void this.#availabilityPublication.catch(() => undefined);
  }

  #invalidateEffectiveConfirmations(): void {
    try {
      this.#settingsRepository.invalidateConfirmedForBackend(
        this.scope,
        this.instance.id,
        Date.now(),
      );
    } catch (error) {
      // A runtime that cannot revoke generation-bound confirmation is unsafe
      // to keep serving. Closing is idempotent and the startup call still
      // propagates its original persistence failure to the caller.
      void this.#supervisor.close().catch(() => undefined);
      throw error;
    }
  }

  #runtimeScope(): ProviderTransportScope {
    return Object.freeze({
      tenantId: this.scope.tenantId,
      principalId: this.scope.principalId,
      backendInstanceId: this.instance.id,
      executionEnvironmentId: this.#executionEnvironmentId,
    });
  }

  #assertDiscoveryConnection(
    connection: BackendModuleRuntimeContext["connections"][number],
  ): void {
    const materialized = this.#context.connections.find(
      ({ id }) => id === connection.id,
    );
    const configured = this.#prepared.connections.find(
      ({ id }) => id === connection.templateId,
    );
    if (
      !materialized ||
      !configured ||
      materialized.templateId !== connection.templateId ||
      materialized.configurationRevision !== connection.configurationRevision ||
      materialized.executionEnvironmentId !==
        connection.executionEnvironmentId ||
      connection.kind !== "codex_app_server" ||
      connection.tenantId !== this.scope.tenantId ||
      connection.ownerPrincipalId !== this.scope.principalId ||
      connection.backendInstanceId !== this.instance.id ||
      connection.enabled !== configured.enabled
    ) {
      throw new Error("codex_discovery_connection_mismatch");
    }
  }
}

export class CodexExecutionSettingsRepositoryAdapter implements CodexExecutionSettingsProvider {
  readonly #executionPolicy: CodexExecutionPolicyAllowlist;
  readonly #modelPolicy: CompiledBackendModelPolicy;

  constructor(
    readonly repository: CodexThreadExecutionSettingsRepository,
    executionPolicy: CodexExecutionPolicyAllowlist,
    modelPolicy: CompiledBackendModelPolicy,
  ) {
    this.#executionPolicy = executionPolicy;
    this.#modelPolicy = modelPolicy;
  }

  desiredSettings(
    scope: BackendModuleRuntimeContext["scope"],
    applicationThreadId: string,
  ): CodexExecutionSettingsTuple | null {
    return this.repository.find(scope, applicationThreadId)?.desired ?? null;
  }

  resolveFastModeDisabled(
    scope: BackendModuleRuntimeContext["scope"],
    input: { readonly applicationThreadId: string; readonly now: number },
  ): CodexExecutionSettingsTuple | null {
    const current = this.repository.find(scope, input.applicationThreadId);
    if (!current?.desired || current.desired.serviceTier === "standard") {
      return current?.desired ?? null;
    }
    return this.repository.updateDesired(scope, input.applicationThreadId, {
      expectedRevision: current.revision,
      desired: { ...current.desired, serviceTier: "standard" },
      now: input.now,
    }).desired;
  }

  forkSettingsEligibility(
    scope: BackendModuleRuntimeContext["scope"],
    applicationThreadId: string,
  ) {
    const eligibility = codexForkSettingsEligibility(
      this.repository.find(scope, applicationThreadId),
      this.#executionPolicy,
    );
    if (
      eligibility.availability === "available" &&
      !this.#modelPolicy.isSelectionAllowed({
        modelId: eligibility.settings.model,
        reasoningEffort: eligibility.settings.reasoningEffort,
      })
    ) {
      return {
        availability: "unavailable" as const,
        settingsRevision: eligibility.settingsRevision,
        reason: "policy_disallowed" as const,
      };
    }
    return eligibility;
  }

  freezeOperationSnapshot(
    scope: BackendModuleRuntimeContext["scope"],
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
      readonly source: ConversationSubmissionSource;
      readonly now: number;
    },
  ) {
    const snapshot = this.repository.freezeOperationSnapshot(scope, input);
    if (
      !isCodexExecutionPolicyAllowed(snapshot.settings, this.#executionPolicy)
    ) {
      throw new BackendError({
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage:
          "The selected Codex execution policy is no longer allowed.",
        backendCode: "codex_execution_policy_rejected",
      });
    }
    if (
      !this.#modelPolicy.isSelectionAllowed({
        modelId: snapshot.settings.model,
        reasoningEffort: snapshot.settings.reasoningEffort,
      })
    ) {
      throw new BackendError({
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage:
          "This model or reasoning effort is not allowed by the backend policy.",
        backendCode: "model_policy_rejected",
      });
    }
    return snapshot;
  }

  observeEffective(
    scope: BackendModuleRuntimeContext["scope"],
    input: {
      readonly applicationThreadId: string;
      readonly settings: CodexObservedExecutionSettings;
      readonly initializeDesired?: CodexExecutionSettingsTuple;
      readonly confirmationGeneration: number;
      readonly now: number;
    },
  ): void {
    const current = this.repository.find(scope, input.applicationThreadId);
    if (!current) throw new Error("codex_execution_settings_not_found");
    const initializeDesired = input.initializeDesired;
    if (
      initializeDesired &&
      matchesImportedNativeTuple(input.settings, initializeDesired) &&
      isCodexExecutionPolicyAllowed(initializeDesired, this.#executionPolicy) &&
      this.#modelPolicy.isSelectionAllowed({
        modelId: initializeDesired.model,
        reasoningEffort: initializeDesired.reasoningEffort,
      })
    ) {
      // The backend is authoritative for the complete recognized tuple it
      // reports: adopt it as desired intent even over an existing Sedes
      // selection. An identical tuple falls through to the ordinary
      // effective-confirmation path so revision is not churned.
      if (
        current.desired !== null &&
        sameDesiredTuple(current.desired, initializeDesired)
      ) {
        // fall through
      } else {
        const effective =
          input.settings.reasoningEffort === null
            ? null
            : {
                model: input.settings.model,
                reasoningEffort: input.settings.reasoningEffort,
                serviceTier: input.settings.serviceTier,
                serviceTierClassification:
                  input.settings.serviceTierClassification,
                sandboxMode: input.settings.sandboxMode,
                sandboxClassification: input.settings.sandboxClassification,
                networkAccess: input.settings.networkAccess,
                networkClassification: input.settings.networkClassification,
                approvalPolicy: input.settings.approvalPolicy,
                approvalPolicyClassification:
                  input.settings.approvalPolicyClassification,
                approvalReviewer: input.settings.approvalReviewer,
                approvalReviewerClassification:
                  input.settings.approvalReviewerClassification,
              };
        this.repository.adoptImportedObservation(
          scope,
          input.applicationThreadId,
          {
            expectedRevision: current.revision,
            desired: initializeDesired,
            effective,
            daemonGeneration: input.confirmationGeneration,
            now: input.now,
          },
        );
        return;
      }
    }
    if (input.settings.reasoningEffort === null) {
      if (current.effectiveConfirmationState === "unconfirmed") return;
      if (current.effectiveConfirmationState === "unknown") return;
      this.repository.markConfirmationUnknown(
        scope,
        input.applicationThreadId,
        { expectedRevision: current.revision, now: input.now },
      );
      return;
    }
    if (input.settings.policyObservation === "incomplete") {
      // A coarse thread start/resume observation cannot prove the network and
      // workspace restrictions that Sedes will send with the next turn.
      if (current.effectiveConfirmationState === "unconfirmed") return;
      if (current.effectiveConfirmationState === "unknown") return;
      this.repository.markConfirmationUnknown(
        scope,
        input.applicationThreadId,
        { expectedRevision: current.revision, now: input.now },
      );
      return;
    }
    const effective = {
      model: input.settings.model,
      reasoningEffort: input.settings.reasoningEffort,
      serviceTier: input.settings.serviceTier,
      serviceTierClassification: input.settings.serviceTierClassification,
      sandboxMode: input.settings.sandboxMode,
      sandboxClassification: input.settings.sandboxClassification,
      networkAccess: input.settings.networkAccess,
      networkClassification: input.settings.networkClassification,
      approvalPolicy: input.settings.approvalPolicy,
      approvalPolicyClassification: input.settings.approvalPolicyClassification,
      approvalReviewer: input.settings.approvalReviewer,
      approvalReviewerClassification:
        input.settings.approvalReviewerClassification,
    };
    if (
      current.effectiveConfirmationState === "confirmed" &&
      current.effectiveDaemonGeneration === input.confirmationGeneration &&
      sameExecutionSettings(current.effective, effective)
    ) {
      return;
    }
    this.repository.confirmEffective(scope, input.applicationThreadId, {
      expectedRevision: current.revision,
      effective,
      daemonGeneration: input.confirmationGeneration,
      now: input.now,
    });
  }

  markEffectiveUnknown(
    scope: BackendModuleRuntimeContext["scope"],
    input: { readonly applicationThreadId: string; readonly now: number },
  ): void {
    const current = this.repository.find(scope, input.applicationThreadId);
    if (!current || current.effectiveConfirmationState === "unknown") return;
    this.repository.markConfirmationUnknown(scope, input.applicationThreadId, {
      expectedRevision: current.revision,
      now: input.now,
    });
  }
}

function sameDesiredTuple(
  left: CodexExecutionSettingsTuple,
  right: CodexExecutionSettingsTuple,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.sandboxMode === right.sandboxMode &&
    left.networkAccess === right.networkAccess &&
    left.approvalPolicy === right.approvalPolicy &&
    left.approvalReviewer === right.approvalReviewer
  );
}

function matchesImportedNativeTuple(
  observed: CodexObservedExecutionSettings,
  desired: CodexExecutionSettingsTuple,
): boolean {
  return (
    observed.policyObservation === "complete" &&
    observed.sandboxClassification === "recognized" &&
    observed.sandboxMode === desired.sandboxMode &&
    observed.networkClassification === "recognized" &&
    observed.networkAccess === desired.networkAccess &&
    observed.approvalPolicyClassification === "recognized" &&
    observed.approvalPolicy === desired.approvalPolicy &&
    observed.approvalReviewerClassification === "recognized" &&
    observed.approvalReviewer === desired.approvalReviewer &&
    observed.model === desired.model &&
    observed.serviceTierClassification === "recognized" &&
    // The initialization candidate deliberately retains an existing
    // Sedes-owned tier while every other axis remains provider-authoritative.
    // Require a recognized native observation, but allow the effective tier
    // to remain pending until its settings notification confirms replay.
    observed.serviceTier !== null &&
    (observed.reasoningEffort === null ||
      observed.reasoningEffort === desired.reasoningEffort)
  );
}

function sameExecutionSettings(
  left: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly serviceTier: "standard" | "fast" | null;
    readonly serviceTierClassification: "recognized" | "external_custom";
    readonly sandboxMode: string | null;
    readonly sandboxClassification: "recognized" | "external_custom";
    readonly networkAccess: string | null;
    readonly networkClassification: "recognized" | "external_custom";
    readonly approvalPolicy: string | null;
    readonly approvalPolicyClassification: "recognized" | "external_custom";
    readonly approvalReviewer: string | null;
    readonly approvalReviewerClassification: "recognized" | "external_custom";
  } | null,
  right: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly serviceTier: "standard" | "fast" | null;
    readonly serviceTierClassification: "recognized" | "external_custom";
    readonly sandboxMode: string | null;
    readonly sandboxClassification: "recognized" | "external_custom";
    readonly networkAccess: string | null;
    readonly networkClassification: "recognized" | "external_custom";
    readonly approvalPolicy: string | null;
    readonly approvalPolicyClassification: "recognized" | "external_custom";
    readonly approvalReviewer: string | null;
    readonly approvalReviewerClassification: "recognized" | "external_custom";
  },
): boolean {
  return (
    left !== null &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.serviceTierClassification === right.serviceTierClassification &&
    left.sandboxMode === right.sandboxMode &&
    left.sandboxClassification === right.sandboxClassification &&
    left.networkAccess === right.networkAccess &&
    left.networkClassification === right.networkClassification &&
    left.approvalPolicy === right.approvalPolicy &&
    left.approvalPolicyClassification === right.approvalPolicyClassification &&
    left.approvalReviewer === right.approvalReviewer &&
    left.approvalReviewerClassification === right.approvalReviewerClassification
  );
}

function executionPolicySelection(
  value: CodexExecutionPolicySelection,
): CodexExecutionPolicySelection {
  return {
    sandboxMode: value.sandboxMode,
    networkAccess: value.networkAccess,
    approvalPolicy: value.approvalPolicy,
    approvalReviewer: value.approvalReviewer,
  };
}

class PreparedCodexBackendModule implements PreparedBackendModule {
  readonly backendInstanceId: string;
  readonly module: BackendModule;
  readonly nativeStores: readonly BackendNativeStoreLifecycle[];
  readonly nativeNamespaces: PreparedBackendModule["nativeNamespaces"];
  readonly #prepared: PreparedCodexBackendConfiguration;
  readonly #enabled: boolean;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #canonicalNativeStoreHome: string | undefined;
  readonly #expectedCodexHome: string | undefined;
  readonly #namespaceKey: string | undefined;
  readonly #ownership: CodexNativeStoreOwnershipGate | undefined;
  readonly #dependencies: CodexBackendModuleDependencies;
  #runtimeCreated = false;

  async recoverAdministration(context: import("../module.js").BackendRuntimeRecoveryContext) {
    if (context.instance.id !== this.backendInstanceId || context.instance.kind !== "codex_app_server") throw new Error("codex_backend_runtime_context_invalid");
    return await recoverCodexRuntimeAdministration({ context, configuration: {
      instance: context.instance, connections: context.connections,
      connection: this.#prepared.configuration.connection,
      startupEnvironmentVariables: this.#startupEnvironmentVariables,
    } });
  }

  constructor(
    module: BackendModule,
    input: BackendModuleConfigurationInput,
    prepared: PreparedCodexBackendConfiguration,
    dependencies: CodexBackendModuleDependencies,
  ) {
    this.module = module;
    this.backendInstanceId = input.backend.id;
    this.#prepared = prepared;
    this.#enabled = input.backend.enabled;
    this.#environment = Object.freeze({ ...input.environment });
    this.#startupEnvironmentVariables = prepared.configuration.connection.ownership === "owned" ? backendStartupEnvironmentVariables(input) : {};
    this.#dependencies = dependencies;
    if (!input.backend.enabled) {
      this.#ownership = undefined;
      this.#canonicalNativeStoreHome = undefined;
      this.#expectedCodexHome = undefined;
      this.#namespaceKey = undefined;
      this.nativeStores = Object.freeze([]);
      this.nativeNamespaces = Object.freeze([]);
      return;
    }
    const enabledEnvironmentIds = new Set(input.connections.filter(connection => connection.enabled).map(connection => connection.executionEnvironmentId));
    const remote = input.executionEnvironments.some(environment => enabledEnvironmentIds.has(environment.id) && environment.kind !== "local");
    if (remote) {
      if (enabledEnvironmentIds.size !== 1) throw new Error("codex_remote_execution_environment_invalid");
      this.#ownership = undefined;
      this.#canonicalNativeStoreHome = undefined;
      this.#expectedCodexHome = undefined;
      const executionEnvironmentId = [...enabledEnvironmentIds][0]!;
      this.#namespaceKey = prepared.configuration.connection.ownership === "external"
        ? externalDiscoveryNamespaceKey(executionEnvironmentId, prepared.configuration.connection)
        : createHash("sha256").update(JSON.stringify(["sedes.codex-remote-owned.v1", executionEnvironmentId, prepared.configuration.connection.channel.codexHome ?? null])).digest("base64url");
      this.nativeStores = Object.freeze([]);
      this.nativeNamespaces = Object.freeze([{ sortKey: `codex:${this.#namespaceKey}`, namespaceKey: this.#namespaceKey }]);
      return;
    }
    if (prepared.configuration.connection.ownership === "owned") {
      const configuredHome =
        prepared.configuration.connection.channel.codexHome;
      const home = input.environment.HOME ?? homedir();
      const defaultHome = path.join(home, ".codex");
      this.#canonicalNativeStoreHome = configuredHome
        ? canonicalLocalEnvironmentDirectorySync(configuredHome)
        : path.join(canonicalLocalEnvironmentDirectorySync(home), ".codex");
      this.#expectedCodexHome = configuredHome
        ? this.#canonicalNativeStoreHome
        : defaultHome;
      this.#namespaceKey = codexNativeStoreNamespaceKey(
        this.#canonicalNativeStoreHome,
      );
      this.nativeNamespaces = Object.freeze([
        Object.freeze({
          sortKey: `codex:${this.#namespaceKey}`,
          namespaceKey: this.#namespaceKey,
        }),
      ]);
    } else {
      this.#canonicalNativeStoreHome = undefined;
      this.#expectedCodexHome = undefined;
      const executionEnvironmentIds = new Set(
        input.connections
          .filter(({ enabled }) => enabled)
          .map(({ executionEnvironmentId }) => executionEnvironmentId),
      );
      const executionEnvironmentId = [...executionEnvironmentIds][0];
      if (executionEnvironmentIds.size !== 1 || !executionEnvironmentId) {
        throw new Error("codex_external_execution_environment_invalid");
      }
      this.#namespaceKey = externalDiscoveryNamespaceKey(
        executionEnvironmentId,
        prepared.configuration.connection,
      );
      this.nativeNamespaces = Object.freeze([
        Object.freeze({
          sortKey: `codex:${this.#namespaceKey}`,
          namespaceKey: this.#namespaceKey,
        }),
      ]);
    }
    if (prepared.configuration.connection.ownership === "owned") {
      if (!this.#canonicalNativeStoreHome) {
        throw new Error("codex_owned_native_home_invalid");
      }
      this.#ownership = new CodexNativeStoreOwnershipGate();
      const nativeStore = createCodexNativeStoreLifecycle({
        canonicalCodexHome: this.#canonicalNativeStoreHome,
        createIfMissing:
          prepared.configuration.connection.channel.codexHome === undefined,
        label: `Codex native home ${input.backend.id}`,
        ownership: this.#ownership,
      });
      this.nativeStores = Object.freeze([nativeStore]);
    } else {
      this.#ownership = undefined;
      this.nativeStores = Object.freeze([]);
    }
  }

  createRuntime(context: BackendModuleRuntimeContext): BackendModuleRuntime {
    if (!this.#enabled) {
      throw new Error("codex_disabled_runtime_not_creatable");
    }
    if (this.#runtimeCreated) {
      throw new Error("codex_backend_runtime_already_created");
    }
    this.#assertRuntimeContext(context);
    const namespaceKey =
      this.#namespaceKey ??
      externalDiscoveryNamespaceKey(
        context.environmentChannel.executionEnvironmentId,
        this.#prepared.configuration.connection,
      );
    this.#runtimeCreated = true;
    return new CodexBackendModuleRuntime({
      context,
      prepared: this.#prepared,
      startupEnvironmentVariables: this.#startupEnvironmentVariables,
      environment: this.#environment,
      ...(this.#expectedCodexHome
        ? { expectedCodexHome: this.#expectedCodexHome }
        : {}),
      namespaceKey,
      ...(this.#ownership ? { ownership: this.#ownership } : {}),
      dependencies: this.#dependencies,
    });
  }

  #assertRuntimeContext(context: BackendModuleRuntimeContext): void {
    const configuredByTemplate = new Map(
      this.#prepared.connections.map((connection) => [
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
      context.instance.kind !== "codex_app_server" ||
      context.instance.protocolRelease !== CODEX_APP_SERVER_RELEASE ||
      this.#prepared.protocolRelease !== CODEX_APP_SERVER_RELEASE ||
      !context.instance.enabled ||
      configuredByTemplate.size !== this.#prepared.connections.length ||
      profilesByTemplate.size !== context.connections.length ||
      profilesByTemplate.size !== configuredByTemplate.size ||
      new Set(context.connections.map(({ id }) => id)).size !==
        context.connections.length ||
      enabledEnvironmentIds.size !== 1 ||
      !enabledEnvironmentIds.has(
        context.environmentChannel.executionEnvironmentId,
      ) ||
      context.environmentChannel.scope.tenantId !== context.scope.tenantId ||
      context.environmentChannel.scope.principalId !== context.scope.principalId
    ) {
      throw new Error("codex_backend_runtime_context_invalid");
    }
    for (const [templateId, configured] of configuredByTemplate) {
      const profile = profilesByTemplate.get(templateId);
      if (
        !profile ||
        profile.kind !== "codex_app_server" ||
        profile.tenantId !== context.scope.tenantId ||
        profile.ownerPrincipalId !== context.scope.principalId ||
        profile.backendInstanceId !== context.instance.id ||
        profile.enabled !== configured.enabled
      ) {
        throw new Error("codex_backend_runtime_context_invalid");
      }
    }
  }
}

function externalDiscoveryNamespaceKey(
  executionEnvironmentId: string,
  connection: CodexBackendModuleConfiguration["connection"],
): string {
  if (connection.ownership !== "external") {
    throw new Error("codex_external_discovery_namespace_invalid");
  }
  const endpoint =
    connection.channel.type === "unix_websocket"
      ? ["unix_websocket", connection.channel.socketPath]
      : ["tcp_websocket", connection.channel.url];
  return (
    createHash("sha256")
      // Stable opaque claim identity shared with pre-rename processes and
      // persisted runtime plans. This is not product-facing branding.
      .update("harness.codex-external-discovery.v1\n")
      .update(JSON.stringify([executionEnvironmentId, ...endpoint]))
      .digest("base64url")
  );
}

export class CodexBackendModule implements BackendModule {
  readonly remoteRuntimeCapabilities = Object.freeze([{ capabilityId: "codex_runtime", majorVersion: 1, operations: ["runtime.ensure", "runtime.lookup", "runtime.execute"] }, codexManagedTuiCapability]);
  readonly backendKind = "codex_app_server" as const;
  readonly connectionKinds = ["codex_app_server"] as const;
  readonly protocolRelease = CODEX_APP_SERVER_RELEASE;
  readonly #dependencies: CodexBackendModuleDependencies;

  constructor(
    dependencies: CodexBackendModuleDependencies = productionDependencies,
  ) {
    this.#dependencies = dependencies;
  }

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    const prepared = parseCodexBackendConfiguration(input);
    return new PreparedCodexBackendModule(
      this,
      input,
      prepared,
      this.#dependencies,
    );
  }
}
