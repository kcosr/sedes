import { UsageService } from "./usage/usage-service.js";
import { mergeEnvironmentVariableOverrides } from "../shared/protocol/environment-variables.js";
import { EnvironmentVariablesService } from "./environment-variables/environment-variables-service.js";
import { fencePriorLifecycleForStop } from "./configuration-admin/configuration-lifecycle-fencing.js";
import { QuestionRequestService } from "./domain/question-request-service.js";
import { randomUUID } from "node:crypto";
import { QuestionRequestRepository } from "./db/repositories/question-request-repository.js";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request as ExpressRequest } from "express";
import type Database from "better-sqlite3";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "./backends/contracts.js";
import type { AgentToolCliAvailability, BackendModuleRuntime } from "./backends/module.js";
import { BackendRuntimeControlRejectedError } from "./backends/runtime-control.js";
import { SIDECAR_WIRE_VERSION } from "../internal/sidecar-protocol/index.js";
import { deferAgentToolAutomationShutdown } from "./agent-tools/application/agent-tool-shutdown.js";
import { AgentBackendRegistry } from "./backends/registry.js";
import { compiledBackendModuleCatalog } from "./backends/compiled-module-catalog.js";
import { BackendAutomationExecutionPolicyRouter } from "./runtime/automation-execution-policy.js";
import {
  ApplicationSnapshotPublicationBoundary,
  ApplicationSnapshotService,
  ApplicationThreadChangePublisher,
} from "./application/application-snapshot-service.js";
import { DatabaseApplicationThreadSummaryReader } from "./application/database-application-summary-reader.js";
import { DatabaseApplicationLineageSummaryReader } from "./application/database-application-lineage-summary-reader.js";
import { DatabaseExecutionTargetReader } from "./application/execution-target-reader.js";
import {
  CompositeInstallationAdvisoryReader,
  NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
  subscribeInstallationAdvisoryPublication,
  type InstallationAdvisoryBackendEnvironment,
} from "./application/installation-advisory-reader.js";
import { SavedAgentApplicationService } from "./application/saved-agent-application-service.js";
import { ThreadTemplateApplicationService } from "./application/thread-template-application-service.js";
import { WorkspaceApplicationService } from "./application/workspace-application-service.js";
import { loadBootstrapConfigurationFile, resolveDatabaseBackendConfiguration, resolveBackendConfigurationFilename } from "./config/backend-configuration.js";
import { loadConfig } from "./config/config.js";
import { SidecarServiceManagementError, SidecarServiceStagingError } from "./sidecar/sidecar-provisioner.js";
import { sidecarOwnershipRecoveryCode, sidecarOwnershipRecoveryMessage, type SidecarOwnershipRecoveryCode } from "./sidecar/sidecar-ownership-recovery-diagnostic.js";
import { commitWithConfigurationRemovalGuard } from "./configuration-admin/configuration-removal-guard.js";
import { ConfigurationOperationRecoveryService } from "./configuration-admin/configuration-operation-recovery-service.js";
import { SidecarOperationRecoveryClient } from "./sidecar/sidecar-operation-recovery-client.js";
import { ConfigurationRepository } from "./configuration-admin/configuration-repository.js";
import { HostPairingRepository } from "./host-pairing/host-pairing-repository.js";
import type { HostPairingAdministration } from "./configuration-admin/host-pairing-routes.js";
import { OutboundConnectionRegistry } from "./outbound/outbound-connection-registry.js";
import { attachOutboundCarrier } from "./outbound/outbound-carrier.js";
import { OutboundSidecarProvisioner } from "./sidecar/outbound-sidecar-provisioner.js";
import { ConfigurationAdminService, type ConfigurationRuntimeAdapter } from "./configuration-admin/configuration-admin-service.js";
import { ConfigurationProjection } from "./configuration-admin/configuration-projection.js";
import { configurationFingerprint } from "./config/configuration-fingerprint.js";
import type { ConfigurationRuntimeState } from "../shared/protocol/configuration-admin.js";
import type { SidecarServiceStatus } from "../internal/sidecar-protocol/service-management-v1.js";
import {
  ConversationActorManager,
  type AuthoritativeCompletionObserver,
} from "./conversations/conversation-actor-manager.js";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
  type BackendDiscoveryScanPolicy,
} from "./conversations/backend-discovery-service.js";
import { ConversationLifecycleService } from "./conversations/conversation-lifecycle-service.js";
import { ThreadForkService } from "./conversations/thread-fork-service.js";
import {
  DatabaseActorTargetResolver,
  DatabaseConversationTargetStore,
  DatabaseLifecycleTargetResolver,
  DatabaseThreadApplicationQueueReader,
  DatabaseThreadApplicationRecoveryReader,
} from "./conversations/database-conversation-adapters.js";
import {
  DatabaseThreadApplicationInventoryReader,
  DatabaseThreadApplicationPresentationReader,
} from "./conversations/database-thread-application-readers.js";
import { InteractionBroker } from "./conversations/interaction-broker.js";
import { RuntimeBackedQueuedInputConversationGateway } from "./conversations/queued-input-conversation-gateway.js";
import { QueuedInputDispatcher } from "./conversations/queued-input-dispatcher.js";
import { ThreadCompletionCallbackDispatcher } from "./conversations/thread-completion-callback-dispatcher.js";
import { reportBackgroundError } from "./report-background-error.js";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
} from "./conversations/thread-application-service.js";
import { ThreadHistoryService } from "./conversations/thread-history-service.js";
import { ThreadMutationGateway } from "./conversations/thread-mutation-gateway.js";
import { ThreadMessagesService } from "./conversations/thread-messages-service.js";
import {
  createPrincipalAgentToolClientEligibility,
  createThreadAgentToolPolicyDependencies,
} from "./conversations/thread-agent-tool-policy-dependencies.js";
import { prepareBackendNormalizedDatabase } from "./db/backend-normalized-startup.js";
import { AutomationRepository } from "./db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "./db/repositories/backend-checkpoint-repository.js";
import { BackendConfigurationRepository } from "./db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "./db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "./db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "./db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "./db/repositories/conversation-operation-repository.js";
import { DeliveryInputSnapshotRepository } from "./db/repositories/delivery-input-snapshot-repository.js";
import { InventoryRepository } from "./db/repositories/inventory-repository.js";
import { ConversationTurnBookmarkRepository } from "./db/repositories/conversation-turn-bookmark-repository.js";
import { CannedPromptRepository } from "./db/repositories/canned-prompt-repository.js";
import { ThreadGroupRepository } from "./db/repositories/thread-group-repository.js";
import { ThreadForceResetRepository } from "./db/repositories/thread-force-reset-repository.js";
import { NotificationRepository } from "./db/repositories/notification-repository.js";
import { NotificationLifecycleObserver } from "./domain/notification-lifecycle-observer.js";
import { NotificationService } from "./domain/notification-service.js";
import { PrincipalApplicationPreferenceRepository } from "./db/repositories/principal-application-preference-repository.js";
import { WorkspaceFileRootRepository } from "./db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "./db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceDiffReviewRepository } from "./db/repositories/workspace-diff-review-repository.js";
import { TaskRepository } from "./db/repositories/task-repository.js";
import { QueuedInputRepository } from "./db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "./db/repositories/submission-completion-repository.js";
import { ThreadLineageRepository } from "./db/repositories/thread-lineage-repository.js";
import { ThreadCompletionCallbackRepository } from "./db/repositories/thread-completion-callback-repository.js";
import { ThreadAgentToolPolicyRepository } from "./db/repositories/thread-agent-tool-policy-repository.js";
import { PrincipalAgentToolClientRepository } from "./db/repositories/principal-agent-tool-client-repository.js";
import { ComposerAttachmentRepository } from "./db/repositories/composer-attachment-repository.js";
import { OutputImageArtifactRepository } from "./db/repositories/output-image-artifact-repository.js";
import { SavedAgentRepository } from "./db/repositories/saved-agent-repository.js";
import { ThreadTemplateRepository } from "./db/repositories/thread-template-repository.js";
import { LateBoundBackendAgentToolFacade } from "./agent-tools/adapters/backend-facade.js";
import { AgentManagementService } from "./agent-tools/application/agent-management-service.js";
import { AgentThreadControlService } from "./agent-tools/application/agent-thread-control-service.js";
import { AgentThreadInventoryControlService } from "./agent-tools/application/agent-thread-inventory-control-service.js";
import { DatabaseAgentToolApplicationReader } from "./agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "./agent-tools/application/database-agent-tool-source-authority.js";
import { CanonicalInlineAgentToolService } from "./agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { SourceScopedAgentToolService } from "./agent-tools/application/source-scoped-agent-tool-service.js";
import { PrincipalAgentToolClientService } from "./agent-tools/application/principal-agent-tool-client-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "./agent-tools/environment/environment-authority.js";
import { PolicyCheckedAgentToolHttpService } from "./agent-tools/http/agent-tool-http-service.js";
import { AutomationAgentToolService } from "./agent-tools/tools/automation-agent-tool-service.js";
import { ThreadWorktreeAgentToolService } from "./agent-tools/tools/thread-worktree-agent-tool-service.js";
import { GrokCliWebSearchProvider } from "./web-search/grok-cli-web-search-provider.js";
import { WebSearchService } from "./web-search/web-search-service.js";
import { AutomationService } from "./domain/automation-service.js";
import { DurableScheduler } from "./domain/durable-scheduler.js";
import { InventoryService } from "./domain/inventory-service.js";
import { ConversationTurnBookmarkService } from "./domain/conversation-turn-bookmark-service.js";
import { CannedPromptService } from "./domain/canned-prompt-service.js";
import { TaskService } from "./domain/task-service.js";
import { WorkpadService } from "./domain/workpad-service.js";
import { WorkpadRepository } from "./db/repositories/workpad-repository.js";
import { WorkpadAgentToolService } from "./agent-tools/tools/workpad-agent-tool-service.js";
import { WorkspaceFileService } from "./domain/workspace-file-service.js";
import { WorkspaceDiffReviewService } from "./domain/workspace-diff-review-service.js";
import { ComposerAttachmentBlobStore } from "./composer-attachments/blob-store.js";
import { ComposerAttachmentService } from "./composer-attachments/service.js";
import { ComposerAttachmentDeliveryService } from "./composer-attachments/composer-attachment-delivery-service.js";
import { OutputArtifactBlobStore } from "./output-artifacts/blob-store.js";
import { OutputArtifactService } from "./output-artifacts/service.js";
import { PiSandboxAllocationRepository } from "./pi-sandbox/pi-sandbox-allocation-repository.js";
import { PiSandboxExecutionWorkspaceReader } from "./pi-sandbox/pi-sandbox-presentation.js";
import { PiSandboxMaterializer } from "./pi-sandbox/pi-sandbox-materializer.js";
import { PiSandboxLifecycleService } from "./pi-sandbox/pi-sandbox-lifecycle-service.js";
import type { ThreadWorkspaceIsolationResolver } from "./execution/thread-workspace-isolation.js";
import { CompositeExecutionAttachmentStager } from "./composer-attachments/composite-execution-attachment-stager.js";
import type { ExecutionAttachmentStager } from "./composer-attachments/execution-attachment-stager.js";
import { ThreadArchiveService } from "./domain/thread-archive-service.js";
import { ThreadBulkInventoryService } from "./domain/thread-bulk-inventory-service.js";
import { DomainError } from "./domain/errors.js";
import { ThreadForceResetService } from "./domain/thread-force-reset-service.js";
import { PrincipalApplicationPreferenceService } from "./domain/principal-application-preference-service.js";
import { ThreadAttentionService } from "./domain/thread-attention-service.js";
import { ThreadGroupService } from "./domain/thread-group-service.js";
import { SavedAgentService } from "./domain/saved-agent-service.js";
import { ScopedApplicationEventHubs } from "./events/application-event-hub.js";
import { ConversationEventBridge } from "./events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "./events/thread-event-presentation.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeCoordinator,
  ThreadRuntimeNotIdleError,
} from "./events/thread-runtime-coordinator.js";
import { ThreadSnapshotPublisher } from "./events/thread-snapshot-publisher.js";
import { CompositeExecutionEnvironment } from "./execution/composite-execution-environment.js";
import type { ExecutionEnvironmentProvider } from "./execution/contracts.js";
import type { RequestScope } from "./identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "./execution/environment-channel.js";
import type { InteractiveTerminalEnvironmentProvider } from "./execution/interactive-terminal.js";
import { type EnvironmentOperations } from "./execution/environment-operations.js";
import {
  loadSidecarArtifactRegistration,
  type SidecarArtifactRegistration,
} from "./sidecar/sidecar-artifact.js";
import { SidecarClientSession } from "./sidecar/sidecar-client-session.js";
import { SidecarRuntimeOwner } from "./sidecar/sidecar-runtime.js";
import { CompositeWorkspaceFileProvider } from "./workspace-files/composite-workspace-file-provider.js";
import { type WorkspaceFileProvider } from "./workspace-files/contracts.js";
import { SingleUserIdentityProvider } from "./identity/identity-provider.js";
import { AuthenticationRepository } from "./authentication/authentication-repository.js";
import { AuthenticationAdmission, deriveClientNavigationNamespace } from "./authentication/authentication-admission.js";
import { createNormalizedApp } from "./normalized-app.js";
import {
  AutomationQueueRunObserver,
  LifecycleAutomationConversationGateway,
} from "./runtime/automation-conversation-gateway.js";
import { ConversationLifecycleAutomationFirstInput } from "./runtime/conversation-lifecycle-automation.js";
import { AutomationDispatcher } from "./runtime/automation-dispatcher.js";
import { AutomationPrecheckExecutor } from "./runtime/automation-precheck-executor.js";
import { PrincipalBackendRuntimeCollection, type BackendRuntimeRetirementAuthority } from "./runtime/principal-backend-runtime-collection.js";
import { createExecutionEnvironmentRuntime, type ExecutionEnvironmentRuntime } from "./runtime/execution-environment-runtime.js";
import {
  managedSshAgentToolCliAvailability,
  resolveLocalAgentToolCliAvailability,
} from "./runtime/agent-tool-cli-availability.js";
import { groupBackendDiscoveryProfiles } from "./runtime/backend-discovery-groups.js";
import { StartupResourceStack } from "./runtime/startup-resource-stack.js";
import {
  ApplicationDrainController,
  DetachedOperationDrainGate,
  HttpRequestOperationGate,
  LongLivedHttpConnectionRegistry,
  closeHttpServerBounded,
} from "./runtime/application-shutdown.js";
import { acquireStateDirectoryLock } from "./security/locks.js";
import { createCsrfToken } from "./security/http-security.js";
import {
  ManagedTerminalAdmissionTokens,
  attachManagedTerminalCarrier,
} from "./terminal/managed-terminal-carrier.js";
import { ProductionManagedTerminalAuthority } from "./terminal/production-managed-terminal-authority.js";
import { TerminalRepository } from "./terminals/terminal-repository.js";
import { TerminalJournalStore } from "./terminals/terminal-journal.js";
import { TerminalService, TerminalServiceError } from "./terminals/terminal-service.js";
import {
  TerminalAdmissionTokens,
  attachTerminalCarrier,
} from "./terminals/terminal-carrier.js";
import { deriveLineageCursorSigningKey, deriveSidecarInstallationIdentity, loadOrCreateToolProvenanceKey } from "./security/installation-secret.js";

export interface RunningApplication {
  readonly authenticationRequired: boolean;
  createManagementPairing(): { token: string; expiresAt: string };
  createManagedLocalPairing(): { token: string; expiresAt: string };
  readonly server: Server;
  readonly listening: {
    readonly host: "127.0.0.1" | "0.0.0.0";
    readonly port: number;
  };
  close(): Promise<void>;
}

export interface ProductionApplicationDependencies {
  /** Test-only release registration override; production loads the bundled manifest. */
  readonly sidecarArtifactRegistration?: SidecarArtifactRegistration;
  /** Test-only passwd-home seam for disposable sshd running as the current uid. */
  readonly sidecarAccountHomeForTests?: string;
}

async function loadProductionSidecarArtifact(): Promise<SidecarArtifactRegistration> {
  // Both source execution (`src/server`) and compiled execution (`dist/server`)
  // resolve through the repository/build root to this same release artifact.
  const manifestPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../dist/sidecar/manifest.json",
  );
  try {
    return await loadSidecarArtifactRegistration(manifestPath);
  } catch (error) {
    throw new Error(
      "production_sidecar_artifact_startup_failed: run npm run build:sidecar and verify dist/sidecar/manifest.json",
      { cause: error },
    );
  }
}

/**
 * Owns production follow-up work that must begin only after the current
 * authoritative observer promise has returned. The setImmediate boundary is
 * deliberate: a microtask can run before the observer chain's await
 * continuation and recreate the same-actor eviction cycle.
 */
export class DeferredProductionOperations {
  readonly #onError: (error: unknown) => void;
  readonly #operations = new Set<Promise<void>>();
  #closing = false;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  defer(operation: () => void | Promise<void>): void {
    if (this.#closing) return;
    const completion = new Promise<void>((resolve) => setImmediate(resolve))
      .then(operation)
      .catch(this.#onError);
    this.#operations.add(completion);
    void completion.then(
      () => this.#operations.delete(completion),
      () => this.#operations.delete(completion),
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

function backendInstance(
  record: ReturnType<BackendConfigurationRepository["getBackend"]>,
): AgentBackendInstance {
  return {
    id: record.id,
    tenantId: record.tenantId,
    kind: record.kind,
    label: record.label,
    enabled: record.enabled === 1,
    configurationRevision: record.configurationRevision,
    protocolRelease: record.protocolRelease,
  };
}

function connectionProfile(
  record: ReturnType<BackendConfigurationRepository["getProfile"]>,
): AgentConnectionProfile {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ownerPrincipalId: record.ownerPrincipalId,
    templateId: record.templateId,
    kind: record.kind,
    backendInstanceId: record.backendInstanceId,
    executionEnvironmentId: record.executionEnvironmentId,
    label: record.label,
    enabled: record.enabled === 1,
    configurationRevision: record.configurationRevision,
  };
}

/**
 * End-state production composition. Production always owns the configured Pi
 * SDK backend through the normalized registry and actor boundaries; fake
 * drivers remain test-only dependencies of isolated services.
 */
export async function startProductionApplication(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionApplicationDependencies = {},
): Promise<RunningApplication> {
  const configurationFilename =
    resolveBackendConfigurationFilename(environment);
  const bootstrapConfiguration = await loadBootstrapConfigurationFile(
    configurationFilename,
  );
  const config = loadConfig(environment, bootstrapConfiguration);
  const resources = new StartupResourceStack();
  const drain = new ApplicationDrainController();
  const discoveryOperations = new DetachedOperationDrainGate();
  const requestOperations = new HttpRequestOperationGate();
  const longLivedConnections = new LongLivedHttpConnectionRegistry();
  const authoritativeCompletionFollowUp = new DeferredProductionOperations(
    reportBackgroundError("Authoritative completion follow-up"),
  );
  let database: Database.Database | undefined;
  let server: Server | undefined;
  let scheduler: DurableScheduler | undefined;
  let automationDispatcher: AutomationDispatcher | undefined;
  let queueDispatcher: QueuedInputDispatcher | undefined;
  let mutations: ThreadMutationGateway | undefined;
  let runtimes: ThreadRuntimeCoordinator | undefined;
  let interactions: InteractionBroker | undefined;
  let actors: ConversationActorManager | undefined;
  let execution: CompositeExecutionEnvironment | undefined;
  let applicationSnapshots: ApplicationSnapshotPublicationBoundary | undefined;
  let threadSnapshots: ThreadSnapshotPublisher | undefined;

  try {
    const stateLock = await acquireStateDirectoryLock(config.stateDirectory);
    resources.defer("state directory lock", () => stateLock.release());
    const startup = await prepareBackendNormalizedDatabase({
      stateDirectory: config.stateDirectory,
      locksHeld: true,
      quiescentCutoverConfirmed:
        environment.SEDES_QUIESCENT_CUTOVER_CONFIRMED === "1",
    });
    database = startup.database;
    resources.defer("application database", () => {
      database?.close();
    });
    // This is the final publication gate. It is registered before every
    // producer so LIFO shutdown closes all of them first, yet after SQLite so
    // admitted publications retain their durable dependency until drained.
    resources.defer(
      "application snapshot publication boundary",
      () => applicationSnapshots?.close(),
      { mode: "ownership_critical" },
    );
    const toolProvenanceKey = await loadOrCreateToolProvenanceKey(
      config.stateDirectory,
    );
    const lineageCursorSigningKey =
      deriveLineageCursorSigningKey(toolProvenanceKey);

    const identity = new SingleUserIdentityProvider<ExpressRequest>(database);
    const scope = identity.getScope();
    const usage = new UsageService(database);
    usage.recoverInterruptedCapture();
    resources.defer("usage timeline backfill", usage.startTimelineBackfill());
    resources.defer("usage revision subscription", usage.subscribe((scope, threadId, revision) => runtimes?.publishUsageRevisionIfLoaded(scope, threadId, revision)));
    const authenticationRepository = new AuthenticationRepository(config.stateDirectory);
    resources.defer("authentication database", () => authenticationRepository.close());
    const csrfToken = createCsrfToken();
    const authentication = new AuthenticationAdmission(authenticationRepository, config.stateDirectory, {
      required: config.authenticationRequired,
      navigationNamespace: deriveClientNavigationNamespace(toolProvenanceKey, scope),
      canEnrollSidecar: connectorId => {
        if (authenticationRepository.hasConnectorIdentity(connectorId)) return true;
        const existing = hostPairings.list(scope);
        return ![...existing.pairings, ...existing.registrations].some(record => record.connectorId === connectorId);
      },
    });
    resources.defer("authentication connections", () => authentication.close());
    const configurationRepository = new ConfigurationRepository(database);
    const environmentVariables = new EnvironmentVariablesService(database, configurationRepository);
    let desiredConfiguration = configurationRepository.get(scope);
    const configurationProjection = new ConfigurationProjection(database, {
      pi: compiledBackendModuleCatalog.protocolReleaseForBackendKind("pi"),
      codex_app_server: compiledBackendModuleCatalog.protocolReleaseForBackendKind("codex_app_server"),
      claude_agent_sdk: compiledBackendModuleCatalog.protocolReleaseForBackendKind("claude_agent_sdk"),
      grok_build: compiledBackendModuleCatalog.protocolReleaseForBackendKind("grok_build"),
    });
    database.transaction(() => configurationProjection.project(scope, desiredConfiguration.configuration))();
    let backendConfigurationFile = resolveDatabaseBackendConfiguration(
      desiredConfiguration.configuration,
      compiledBackendModuleCatalog,
    );
    const sidecarInstallationId = deriveSidecarInstallationIdentity(toolProvenanceKey);
    const hostPairings = new HostPairingRepository(database, configurationRepository, {
      project: (candidate, document) => configurationProjection.project(candidate, document),
    });
    const outboundConnections = new OutboundConnectionRegistry({
      repository: hostPairings,
      installationId: sidecarInstallationId,
      environmentRevision(candidate, environmentId) {
        const snapshot = configurationRepository.get(candidate);
        const definition = snapshot.configuration.executionEnvironments.find(item => item.id === environmentId && item.kind === "outbound");
        // Lifecycle preference/receipt revisions do not change the host's
        // configuration. A command must retain management access after its
        // intent is committed, and unrelated hosts must stay connected.
        return definition ? configurationFingerprint({
          environment: definition,
          backends: snapshot.configuration.targets.filter(target => target.executionEnvironmentId === environmentId)
            .map(target => ({id: target.backendInstanceId, kind: target.kind})),
        }) : undefined;
      },
    });
    resources.defer("outbound connection registry", () => outboundConnections.close());
    const piSandboxAllocations = new PiSandboxAllocationRepository(database);
    piSandboxAllocations.reconcileInterruptedOperations(scope, {
      now: Date.now(),
    });
    const piSandboxMaterializer = new PiSandboxMaterializer(
      piSandboxAllocations,
      { allocationRoot: path.join(config.stateDirectory, "thread-workspaces") },
    );
    const piSandboxExecutionWorkspaces = new PiSandboxExecutionWorkspaceReader(
      piSandboxAllocations,
    );
    const composerAttachmentRepository = new ComposerAttachmentRepository(
      database,
    );
    const composerAttachments = new ComposerAttachmentService(
      new ComposerAttachmentBlobStore(config.stateDirectory),
      composerAttachmentRepository,
    );
    await composerAttachments.initialize();
    const outputArtifacts = new OutputArtifactService(
      new OutputArtifactBlobStore(config.stateDirectory),
      new OutputImageArtifactRepository(database),
    );
    await outputArtifacts.initialize();
    const notifications = new NotificationService({
      repository: new NotificationRepository(database),
      onError: (message) =>
        reportBackgroundError("Notification script")(new Error(message)),
    });
    resources.defer("notification scripts", () => notifications.close(), {
      mode: "ownership_critical",
    });
    const principalPreferences = new PrincipalApplicationPreferenceService({
      repository: new PrincipalApplicationPreferenceRepository(database),
    });
    const cannedPrompts = new CannedPromptService(
      new CannedPromptRepository(database),
    );
    const backendConfiguration = new BackendConfigurationRepository(database);
    const registry = new AgentBackendRegistry();
    const agentTools = new LateBoundBackendAgentToolFacade();
    resources.defer("backend agent tools", () => agentTools.close());
    const agentToolSources = new DatabaseAgentToolSourceAuthority(
      database,
      toolProvenanceKey,
    );
    let webSearchConfiguration = backendConfigurationFile.webSearch;
    const webSearchProvider = new GrokCliWebSearchProvider({
      workDirectory: path.join(
        config.stateDirectory,
        "web-search",
        "workspace",
      ),
      ...(webSearchConfiguration?.grokHome
        ? { grokHome: webSearchConfiguration.grokHome }
        : {}),
      environment,
    });
    const webSearchAvailability = webSearchConfiguration
      ? await webSearchProvider.checkAvailability()
      : {available: false, reason: "Web search is not configured."};
    const webSearch = new WebSearchService(
      webSearchProvider,
      webSearchAvailability,
    );
    const agentToolRuntimeAvailability = new Map([
      ["research.web_search", webSearchAvailability] as const,
    ]);
    const agentToolPolicyDependencies = createThreadAgentToolPolicyDependencies(
      agentToolRuntimeAvailability,
    );
    const agentToolPolicies = new ThreadAgentToolPolicyRepository(
      database,
      agentToolPolicyDependencies.eligibility,
    );
    const principalAgentToolClients = new PrincipalAgentToolClientRepository(
      database,
      createPrincipalAgentToolClientEligibility(),
    );
    let profiles = backendConfiguration
      .listProfiles(scope)
      .map(connectionProfile);
    const inventoryRepository = new InventoryRepository(database);
    const notificationLifecycle = new NotificationLifecycleObserver(
      inventoryRepository,
      (eventScope, payload, eventKey, assistantResult) =>
        notifications.emit(eventScope, payload, eventKey, assistantResult),
    );
    const turnBookmarkRepository = new ConversationTurnBookmarkRepository(
      database,
      inventoryRepository,
    );
    const threadGroupRepository = new ThreadGroupRepository(database);
    const executionEnvironments = new Map<string, ExecutionEnvironmentProvider>();
    const environmentChannels = new Map<string, ExecutionEnvironmentChannelProvider>();
    const workspaceFileProviders = new Map<string, WorkspaceFileProvider>();
    const attachmentStagers = new Map<string, ExecutionAttachmentStager>();
    const terminalProviders = new Map<string, InteractiveTerminalEnvironmentProvider>();
    const environmentOperations = new Map<string, EnvironmentOperations>();
    const workspaceIsolations = new Map<string, ThreadWorkspaceIsolationResolver>();
    const advertisedWorkspaceIsolationNetworkProfiles = new Map<string, readonly ("isolated" | "execution_host")[]>();
    const environmentRuntimes = new Map<string, ExecutionEnvironmentRuntime>();
    const appliedEnvironmentRevisions = new Map<string, number>();
    const appliedEnvironmentFingerprints = new Map<string, string>();
    const environmentPreparationFailures = new Map<string, unknown>();
    const environmentRuntimeFingerprint = (id: string) => configurationFingerprint({
      environment: (() => { const found = desiredConfiguration.configuration.executionEnvironments.find(item => item.id === id); if (!found) return null; const { environmentVariables: _variables, ...transport } = found; return transport; })(),
      backends: desiredConfiguration.configuration.targets.filter(target => target.executionEnvironmentId === id)
        .map(target => ({id: target.backendInstanceId, kind: target.kind})),
    });
    const agentToolSidecarRuntimes = new Map<string, SidecarRuntimeOwner<SidecarClientSession>>();
    let sidecarArtifactPromise: Promise<SidecarArtifactRegistration> | undefined;
    const sidecarArtifact = (): Promise<SidecarArtifactRegistration> => {
      sidecarArtifactPromise ??= dependencies.sidecarArtifactRegistration
        ? Promise.resolve(dependencies.sidecarArtifactRegistration)
        : loadProductionSidecarArtifact();
      return sidecarArtifactPromise;
    };
    let publishExecutionEnvironmentChange: ((environmentId: string) => void) | undefined;
    const reportRemoteAvailability = async (environmentId: string, available: boolean, diagnosticCode?: string): Promise<void> => {
      const before = inventoryRepository.getEnvironment(scope, environmentId);
      const after = inventoryRepository.updateEnvironmentAvailability(scope, environmentId, {
        available, ...(diagnosticCode ? { diagnosticCode } : {}), now: Date.now(),
      });
      if (after.revision !== before.revision && !drain.isDraining) publishExecutionEnvironmentChange?.(environmentId);
    };
    const createEnvironmentRuntime = async (environmentId: string): Promise<ExecutionEnvironmentRuntime> => {
      const configured = desiredConfiguration.configuration.executionEnvironments.find(item => item.id === environmentId);
      if (!configured) throw new Error("execution_environment_configuration_missing");
      const record = inventoryRepository.getEnvironment(scope, environmentId);
      const localPiBackendInstanceIds = [...new Set(profiles.filter(profile => profile.enabled &&
        profile.kind === "pi_sdk" && profile.executionEnvironmentId === environmentId).map(profile => profile.backendInstanceId))];
      return await createExecutionEnvironmentRuntime({
        configured, record, scope, stateDirectory: config.stateDirectory, environment,
        toolProvenanceKey, installationId: sidecarInstallationId,
        authorizedRuntimeCapabilities: [{capabilityId: "environment_variables", majorVersion: 1, operations: ["variables.resolve"]}, ...new Map(backendConfigurationFile.backends
          .filter(backend => profiles.some(profile => profile.backendInstanceId === backend.id && profile.executionEnvironmentId === environmentId))
          .flatMap(backend => compiledBackendModuleCatalog.requireModule(backend.kind).remoteRuntimeCapabilities ?? [])
          .map(capability => [capability.capabilityId, capability] as const)).values()],
        activeEnvironmentRecord: () => inventoryRepository.getEnvironment(scope, environmentId),
        automaticConnectionEnabled: () => configurationRepository.runtime(scope, "environment", environmentId).preference === "automatic",
        reportAvailability: (available, diagnosticCode) => reportRemoteAvailability(environmentId, available, diagnosticCode),
        ...(configured.kind === "outbound" ? {outboundConnection: {
          createProvisioner: (options: Omit<ConstructorParameters<typeof OutboundSidecarProvisioner>[0], "registry">) =>
            new OutboundSidecarProvisioner({...options, registry: outboundConnections}),
          isConnected: () => outboundConnections.isConnected(scope, environmentId),
          subscribe: (listener: (connected: boolean) => void) => outboundConnections.subscribe(event => {
            if (event.scope.tenantId === scope.tenantId && event.scope.principalId === scope.principalId && event.environmentId === environmentId) {
              listener(event.connected && outboundConnections.isConnected(scope, environmentId));
            }
          }),
        }} : {}),
        sidecarArtifact, agentToolSources, agentTools, localPiBackendInstanceIds,
        piSandbox: {allocations: piSandboxAllocations, materializer: piSandboxMaterializer},
        onBackgroundError: reportBackgroundError("Execution environment runtime"),
        ...(dependencies.sidecarAccountHomeForTests ? {sidecarAccountHomeForTests: dependencies.sidecarAccountHomeForTests} : {}),
      });
    };
    const publishEnvironmentRuntime = (runtime: ExecutionEnvironmentRuntime): void => {
      const id = runtime.environmentId;
      environmentRuntimes.set(id, runtime);
      executionEnvironments.set(id, runtime.provider);
      environmentChannels.set(id, runtime.channels);
      workspaceFileProviders.set(id, runtime.workspaceFiles);
      attachmentStagers.set(id, runtime.attachments);
      environmentOperations.set(id, runtime.operations);
      if (runtime.terminal) terminalProviders.set(id, runtime.terminal);
      else terminalProviders.delete(id);
      if (runtime.agentToolCliRuntime) agentToolSidecarRuntimes.set(id, runtime.agentToolCliRuntime);
      else agentToolSidecarRuntimes.delete(id);
      for (const [backendId, isolation] of runtime.workspaceIsolations) workspaceIsolations.set(backendId, isolation);
      for (const [backendId, profiles] of runtime.networkProfiles) advertisedWorkspaceIsolationNetworkProfiles.set(backendId, profiles);
      const desired = configurationRepository.runtime(scope, "environment", id);
      appliedEnvironmentRevisions.set(id, desired.desiredRevision);
      appliedEnvironmentFingerprints.set(id, environmentRuntimeFingerprint(id));
      if (desiredConfiguration.configuration.executionEnvironments.find(item => item.id === id)?.kind === "local") {
        inventoryRepository.updateEnvironmentAvailability(scope, id, {available: true, now: Date.now()});
      }
      environmentPreparationFailures.delete(id);
    };
    for (const configured of desiredConfiguration.configuration.executionEnvironments) {
      try { publishEnvironmentRuntime(await createEnvironmentRuntime(configured.id)); }
      catch (error) { environmentPreparationFailures.set(configured.id, error); }
    }
    resources.defer("execution environment runtimes", async () => {
      const results = await Promise.allSettled([...environmentRuntimes.values()].map(runtime => runtime.close()));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Execution environment cleanup failed.");
    }, {mode: "ownership_critical"});
    execution = new CompositeExecutionEnvironment({scope, environments: executionEnvironments});
    const executionAttachmentStager = new CompositeExecutionAttachmentStager({
      scope,
      providers: attachmentStagers,
    });
    resources.defer("execution attachment stagers", () =>
      executionAttachmentStager.close(),
    );
    const attachmentDelivery = new ComposerAttachmentDeliveryService(
      composerAttachments,
      executionAttachmentStager,
      composerAttachmentRepository,
    );
    const workspaceFileRoots = new WorkspaceFileRootRepository(database);
    const workspaceFileLinkedWorktrees =
      new WorkspaceFileLinkedWorktreeRepository(database);
    let inventory!: InventoryService;
    const workspaceFileRouter = new CompositeWorkspaceFileProvider({scope, providers: workspaceFileProviders});
    const workspaceFiles = new WorkspaceFileService(
      inventoryRepository,
      workspaceFileRoots,
      workspaceFileLinkedWorktrees,
      execution,
      workspaceFileRouter,
      {
        publishApplicationThreadChanges: (eventScope, applicationThreadIds) =>
          inventory.publishApplicationThreadChanges(
            eventScope,
            applicationThreadIds,
          ),
      },
    );
    const workspaceDiffReviews = new WorkspaceDiffReviewService(
      inventoryRepository,
      workspaceFileRoots,
      workspaceFileLinkedWorktrees,
      new WorkspaceDiffReviewRepository(database),
    );
    resources.defer("workspace file watchers", () => workspaceFiles.close());
    const localAgentToolCli = await resolveLocalAgentToolCliAvailability({
      endpoint: `http://127.0.0.1:${config.port}`,
      inheritedPath: environment.PATH,
    });
    const agentToolCli = new Map<string, AgentToolCliAvailability>(
      backendConfigurationFile.executionEnvironments.map((configured) => [
        configured.id,
        configured.kind === "local"
          ? localAgentToolCli
          : agentToolSidecarRuntimes.has(configured.id)
            ? managedSshAgentToolCliAvailability({
                scope,
                executionEnvironmentId: configured.id,
                runtime: agentToolSidecarRuntimes.get(configured.id)!,
              })
            : {
                availability: "unavailable" as const,
                reason: "remote_environment" as const,
              },
      ]),
    );
    const runtimeModules = new PrincipalBackendRuntimeCollection({scope, registry,
      desiredInstanceRevision: id => backendConfiguration.getBackend(scope, id).configurationRevision,
    });
    resources.defer("backend runtime collection", () => runtimeModules.close(), {
      mode: "ownership_critical",
    });
    let retireBackendRuntime: BackendRuntimeRetirementAuthority = {
      async run() { throw new Error("backend_retirement_authority_unavailable"); },
    };
    const backendPreparationFailures = new Map<string, unknown>();
    const appliedBackendRevisions = new Map<string, number>();
    const appliedBackendFingerprints = new Map<string, string>();
    const backendIncarnations = new Map<string, string>();
    const appliedStartupEnvironmentFingerprints = new Map<string, string>();
    const startupEnvironmentFingerprint = (id: string): string => {
      const document = desiredConfiguration.configuration;
      const backend = document.backends.find(item => item.id === id);
      if (!backend || backend.kind === "pi" || (backend.kind === "codex_app_server" && backend.moduleConfiguration.connection.ownership === "external")) return configurationFingerprint({});
      const target = document.targets.find(item => item.backendInstanceId === id && item.enabled);
      const host = document.executionEnvironments.find(item => item.id === target?.executionEnvironmentId);
      return configurationFingerprint(mergeEnvironmentVariableOverrides(host?.environmentVariables?.startup ?? {}, backend.environmentVariables?.startup ?? {}));
    };
    const backendRuntimeFingerprint = (id: string): string => configurationFingerprint({
      backend: (() => { const backend = backendConfigurationFile.backends.find(item => item.id === id); if (!backend) return null;
        const { environmentVariables: _variables, ...configuration } = backend; return configuration; })(),
      targets: backendConfigurationFile.targets.filter(target => target.backendInstanceId === id),
      startupEnvironment: startupEnvironmentFingerprint(id),
    });
    const startupEnvironmentPending = (id: string): boolean => appliedStartupEnvironmentFingerprints.has(id) &&
      appliedStartupEnvironmentFingerprints.get(id) !== startupEnvironmentFingerprint(id);

    const applyBackendRuntime = async (backendId: string): Promise<void> => {
      const configured = backendConfigurationFile.backends.find(item => item.id === backendId);
      if (!configured || !configured.enabled) {
        await runtimeModules.remove(backendId, retireBackendRuntime);
        appliedBackendRevisions.delete(backendId);
        appliedBackendFingerprints.delete(backendId);
        backendIncarnations.delete(backendId);
        return;
      }
      try {
        const connections = profiles.filter(profile => profile.backendInstanceId === backendId);
        const environmentIds = new Set(connections.filter(profile => profile.enabled).map(profile => profile.executionEnvironmentId));
        if (environmentIds.size !== 1) throw new Error("backend_runtime_execution_environment_invalid");
        const environmentId = [...environmentIds][0]!;
        const environmentChannel = environmentChannels.get(environmentId);
        const operations = environmentOperations.get(environmentId);
        const cli = agentToolCli.get(environmentId);
        if (!environmentChannel || !operations || !cli) throw new Error("backend_runtime_environment_unavailable");
        const prepared = compiledBackendModuleCatalog.prepare({
          backends: [configured],
          connections: backendConfigurationFile.targets.filter(target => target.backendInstanceId === backendId),
          executionEnvironments: backendConfigurationFile.executionEnvironments,
          environment,
        })[0];
        if (!prepared) throw new Error("backend_runtime_preparation_missing");
        const workspaceIsolation = workspaceIsolations.get(backendId);
        const result = await runtimeModules.apply({
          prepared,
          context: {
            database: database!, scope, usage,
            executionEnvironmentVariables: (threadId) => environmentVariables.effective(scope, threadId),
            instance: backendInstance(backendConfiguration.getBackend(scope, backendId)),
            connections, environmentChannel, environmentOperations: operations,
            ...(workspaceIsolation ? { workspaceIsolation } : {}),
            toolProvenanceKey, agentTools, outputArtifacts,
            agentToolSourceCapabilities: agentToolSources, agentToolCli: cli,
            ...(environmentRuntimes.get(environmentId)?.sidecarRuntime ? {
              sidecarRuntime: {
                async acquire(signal = new AbortController().signal, options = {}) {
                  const owner = environmentRuntimes.get(environmentId)!.sidecarRuntime!;
                  const lease = options.existingOnly
                    ? await owner.acquireRetainedRecovery(scope, environmentId, signal)
                    : await owner.acquireOperation(scope, environmentId, signal);
                  return {channel: lease.session.runtimeChannel,
                    controllerEpoch: lease.serviceStatus.controllerEpoch,
                    serviceIncarnation: lease.serviceStatus.serviceIncarnation,
                    closed: lease.session.closed, release: () => lease.release()};
                },
              },
            } : {}),
          },
        }, retireBackendRuntime);
        if (result.status === "failed") throw result.error;
        backendPreparationFailures.delete(backendId);
        appliedBackendRevisions.set(backendId, configurationRepository.runtime(scope, "backend", backendId).desiredRevision);
        appliedBackendFingerprints.set(backendId, backendRuntimeFingerprint(backendId));
        appliedStartupEnvironmentFingerprints.set(backendId, startupEnvironmentFingerprint(backendId));
        backendIncarnations.set(backendId, randomUUID());
      } catch (error) {
        if (error instanceof ThreadRuntimeNotIdleError) { backendPreparationFailures.delete(backendId); return; }
        backendPreparationFailures.set(backendId, error);
      }
    };
    for (const configured of backendConfigurationFile.backends) {
      const preference = desiredConfiguration.runtimes.find(item => item.resourceKind === "backend" && item.resourceId === configured.id)?.preference;
      if (!preference || preference === "automatic") await applyBackendRuntime(configured.id);
    }
    const moduleRuntimes = runtimeModules.runtimes;
    const bindingPersistence = runtimeModules.threadPersistence;
    const bindingDetails = runtimeModules.bindingDetails;
    const presentationProviders = runtimeModules.presentation;
    const actionPersistence = runtimeModules.actionPersistence;
    const discoveryPersistence = runtimeModules.discoveryPersistence;
    const bindings = new ConversationBindingRepository(database);
    const creation = new ConversationCreationRepository(database);
    const drafts = new ConversationDraftRepository(database);
    const completion = new SubmissionCompletionRepository(database);
    const deliveryInputSnapshots = new DeliveryInputSnapshotRepository(
      database,
    );
    const queueRepository = new QueuedInputRepository(database);
    const completionCallbacks = new ThreadCompletionCallbackRepository(
      database,
    );
    const operationRepository = new ConversationOperationRepository(database);
    const lineageRepository = new ThreadLineageRepository(database);
    const automationRepository = new AutomationRepository(database);
    const terminalRepository = new TerminalRepository(database);
    const targets = new DatabaseConversationTargetStore({
      database,
      bindings,
      bindingDetails,
      registry,
      environments: execution,
    });
    const actorTargets = new DatabaseActorTargetResolver(targets);
    // This phase runs after ordinary application-summary producers close but
    // before backend runtimes and environment channels. It drains any capture
    // that can depend on those runtimes while leaving admission open for the
    // final availability observations emitted by their teardown.
    resources.defer(
      "application snapshot publication producer drain",
      () => applicationSnapshots?.flush(),
      { mode: "ownership_critical" },
    );
    let questions: QuestionRequestService | undefined;
    let observeAuthoritativeCompletion:
      AuthoritativeCompletionObserver | undefined;
    actors = new ConversationActorManager({
      environments: execution,
      attachmentDelivery,
      deliveryInputSnapshots,
      retentionMilliseconds: config.conversationRetentionMilliseconds,
      runtimeBudget: config.conversationRuntimeBudget,
      onHistoricalQuestion: (eventScope, threadId, sourceItemId) =>
        questions?.remember(eventScope, threadId, sourceItemId),
      onNonblockingQuestions: (eventScope, threadId, sourceItemId, payload) =>
        questions?.observe(eventScope, threadId, sourceItemId, payload),
      onAuthoritativeSubmission: (eventScope, applicationThreadId, input) =>
        mutations?.observeAuthoritativeSubmission(
          eventScope,
          applicationThreadId,
          input.backendCorrelation,
        ),
      onAuthoritativeCompletion: (eventScope, applicationThreadId, input) =>
        observeAuthoritativeCompletion?.(
          eventScope,
          applicationThreadId,
          input,
        ),
    });
    resources.defer("conversation actors", () => actors?.close(), {
      mode: "ownership_critical",
    });
    const lifecycleTargets = new DatabaseLifecycleTargetResolver(targets);
    const lifecycle = new ConversationLifecycleService({
      environmentVariables,
      registry,
      targets: lifecycleTargets,
      backendPersistence: bindingPersistence,
      bindings,
      creation,
      drafts,
      completion,
      actors,
      attachmentDelivery,
    });
    const applicationThreadSummaries =
      new DatabaseApplicationThreadSummaryReader({
        inventory: inventoryRepository,
        queue: queueRepository,
        completion,
      });
    const automationExecutionPolicy =
      new BackendAutomationExecutionPolicyRouter(
        database,
        runtimeModules.automationExecutionPolicy,
      );
    const forks = new ThreadForkService({
      environmentVariables,
      database,
      targets,
      actors,
      backendPersistence: bindingPersistence,
      bindings,
      creation,
      checkpoints: new BackendCheckpointRepository(database),
      lineage: lineageRepository,
      inventory: inventoryRepository,
      operations: operationRepository,
      deliveryInputSnapshots,
      outputArtifacts,
      automations: automationRepository,
      automationExecutionPolicy,
      descendantTerminalSummaries: terminalRepository,
      executionWorkspaces: {
        copySelection(
          eventScope,
          sourceApplicationThreadId,
          childApplicationThreadId,
        ) {
          const source = piSandboxAllocations.getForThread(
            eventScope,
            sourceApplicationThreadId,
          );
          if (!source) return;
          const sourceBinding = bindings.getBinding(
            eventScope,
            sourceApplicationThreadId,
          );
          if (
            !sourceBinding ||
            sourceBinding.executionEnvironmentId !==
              source.executionEnvironmentId ||
            !advertisedWorkspaceIsolationNetworkProfiles
              .get(sourceBinding.backendInstanceId)
              ?.includes(source.networkProfile)
          ) {
            throw new DomainError(
              "runtime_unavailable",
              "The source thread's isolated workspace policy is no longer admitted.",
              true,
            );
          }
          piSandboxMaterializer.reserve(eventScope, {
            applicationThreadId: childApplicationThreadId,
            executionEnvironmentId: source.executionEnvironmentId,
            sourceWorkspaceId: source.sourceWorkspaceId,
            sourceCanonicalPath: source.sourceCanonicalPath,
            workspaceAccess: source.workspaceAccess,
            networkProfile: source.networkProfile,
          });
        },
      },
      descendantSummaries: applicationThreadSummaries,
      lineageCursorSigningKey,
    });

    const threadHubs = new ScopedThreadEventHubRegistry();
    const applicationHubs = new ScopedApplicationEventHubs();
    interactions = new InteractionBroker({
      onOpened: (eventScope, interaction) =>
        notificationLifecycle.interactionOpened(eventScope, interaction),
    });
    resources.defer(
      "interaction broker",
      () => {
        interactions?.detachForShutdown();
        return interactions?.close();
      },
      { mode: "ownership_critical" },
    );
    const threadInventory = new DatabaseThreadApplicationInventoryReader({
      inventory: inventoryRepository,
      queue: queueRepository,
      completion,
      agentTools: agentToolPolicies,
      agentToolCatalog: agentToolPolicyDependencies.catalog,
      directoryBrowsingAvailability: (requestScope, environmentId) =>
        execution!.directoryBrowsingAvailability(requestScope, environmentId),
      executionWorkspaces: piSandboxExecutionWorkspaces,
    });
    const threadPresentation = new DatabaseThreadApplicationPresentationReader({
      targets,
      providers: presentationProviders,
    });
    const threads = new ThreadApplicationService({
      usage,
      inventory: threadInventory,
      conversations: new ActorBackedThreadApplicationConversationReader({
        actors,
        targets: actorTargets,
      }),
      queue: new DatabaseThreadApplicationQueueReader(queueRepository),
      presentation: threadPresentation,
      recovery: new DatabaseThreadApplicationRecoveryReader({
        creation,
        operations: operationRepository,
        targets: lifecycleTargets,
        registry,
        forks,
      }),
      interactions,
      actionPersistence,
      attachmentDelivery,
    });
    const history = new ThreadHistoryService({ usage, inventory: threadInventory });
    threads.bindHistory(history);
    const agentToolApplication = new DatabaseAgentToolApplicationReader(
      database,
      identity,
      threads,
      agentToolSources,
    );

    let publishApplicationThread: ApplicationThreadChangePublisher | undefined;
    runtimes = new ThreadRuntimeCoordinator({
      actors,
      targets: actorTargets,
      bridge: new ConversationEventBridge(new ThreadEventPresentation(threads), (scope, threadId, turns) => usage.registerVisibleTurns(scope, threadId, turns)),
      interactions,
      hubs: threadHubs,
      retentionMilliseconds: config.conversationRetentionMilliseconds,
      onThreadChanged: (eventScope, applicationThreadId) =>
        publishApplicationThread?.publish(eventScope, applicationThreadId),
      onAuthoritativeSettled: async (eventScope, applicationThreadId) => {
        await mutations?.onAuthoritativeSettled(
          eventScope,
          applicationThreadId,
        );
        await queueDispatcher!.onAuthoritativeSettled(
          eventScope,
          applicationThreadId,
        );
      },
    });
    actors.bindPressureReclaimer((request) =>
      runtimes?.tryReclaimOldestIdleRuntime(request),
    );
    const piSandboxLifecycle = new PiSandboxLifecycleService({
      allocations: piSandboxAllocations,
      materializer: piSandboxMaterializer,
      runtimeRetirement: runtimes,
    });
    resources.defer("thread runtimes", () => runtimes?.closeForShutdown(), {
      mode: "ownership_critical",
    });
    resources.defer(
      "thread snapshot publications",
      () => threadSnapshots?.close(),
      { mode: "ownership_critical" },
    );
    forks.bindDescendantRunStates(runtimes);
    history.bindRuntimes(runtimes);
    const queueGateway = new RuntimeBackedQueuedInputConversationGateway({
      runtimes,
      targets: actorTargets,
      attachmentDelivery,
    });
    let observeAutomationQueue: AutomationQueueRunObserver | undefined;
    queueDispatcher = new QueuedInputDispatcher({
      repository: queueRepository,
      gateway: queueGateway,
      publisher: {
        publish(eventScope, applicationThreadId, event) {
          threadHubs.thread(eventScope, applicationThreadId).publish(event);
          for (const item of queueRepository.list(
            eventScope,
            applicationThreadId,
          )) {
            observeAutomationQueue?.observe(
              eventScope,
              applicationThreadId,
              item,
            );
          }
          void publishApplicationThread
            ?.publish(eventScope, applicationThreadId)
            .catch(() => undefined);
          try {
            threadSnapshots?.schedule(eventScope, applicationThreadId);
          } catch {
            // Queue state is durable and will be present in the next snapshot.
          }
        },
      },
      retryPolicy: {
        maximumRetries: 5,
        baseDelayMilliseconds: 1_000,
        maximumDelayMilliseconds: 60_000,
      },
      isDispatchBlocked: (eventScope, applicationThreadId) =>
        inventoryRepository.isWorkspaceRemoved(eventScope, inventoryRepository.getThread(eventScope, applicationThreadId).thread.workspaceId) ||
        operationRepository.hasBlockingThreadOperation(
          eventScope,
          applicationThreadId,
        ),
    });
    questions = new QuestionRequestService({
      repository: new QuestionRequestRepository(database, inventoryRepository),
      inventory: inventoryRepository,
      queue: queueRepository,
    gateway: queueGateway,
      dispatch: queueDispatcher,
      publish(eventScope, threadId, result) {
        void publishApplicationThread
          ?.publish(eventScope, threadId)
          .catch(reportBackgroundError("Question summary publication"));
        const hub = threadHubs.thread(eventScope, threadId);
        if (hub.projectionGeneration) {
          hub.publish({
            type: "questions_changed",
            generation: hub.projectionGeneration,
            ...result,
          });
        }
      },
      onOpened(eventScope, request) {
        notificationLifecycle.questionOpened(eventScope, {
          ...request,
          questionCount: request.questions.length,
        });
      },
    });
    const completionCallbackDispatcher = new ThreadCompletionCallbackDispatcher(
      {
        callbacks: completionCallbacks,
        inventory: inventoryRepository,
        repository: queueRepository,
        gateway: queueGateway,
        queue: queueDispatcher,
        onRetryError: reportBackgroundError("Thread completion callback retry"),
      },
    );
    resources.defer("queued input dispatcher", () => queueDispatcher?.close(), {
      mode: "ownership_critical",
    });
    resources.defer(
      "thread completion callback dispatcher",
      () => completionCallbackDispatcher.close(),
      { mode: "ownership_critical" },
    );

    const executionTargets = new DatabaseExecutionTargetReader({
      configuration: backendConfiguration,
      registry,
      environmentOperations,
      workspaceIsolationNetworkProfiles:
        advertisedWorkspaceIsolationNetworkProfiles,
      defaultTargetTemplateId: backendConfigurationFile.defaultTargetId,
      onHealthError: (error, profile) =>
        reportBackgroundError(
          `Backend health for target ${profile.templateId}`,
        )(error),
    });
    retireBackendRuntime = {
      async run<Result>(runtime: BackendModuleRuntime, change: () => Promise<Result>): Promise<Result> {
        if (runtime.scope.tenantId !== scope.tenantId || runtime.scope.principalId !== scope.principalId) {
          throw new DomainError("not_found", "The runtime is unavailable in this scope.");
        }
        const admission = registry.suspend(scope, runtime.instance.id);
        executionTargets.invalidateHealth();
        try {
          await admission.drained;
          const rows = database!.prepare(`SELECT id FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ? ORDER BY id`)
            .all(scope.tenantId, scope.principalId, runtime.instance.id) as {id: string}[];
          let operation = change;
          for (const row of rows.reverse()) {
            const next = operation;
            operation = () => runtimes!.runWithRuntimeRetired(scope, row.id, next);
          }
          return await operation();
        } finally {
          executionTargets.invalidateHealth();
          admission.release();
        }
      },
    };
    const savedAgentAdapters = runtimeModules.savedAgentAdapters;
    const savedAgentRepository = new SavedAgentRepository(database);
    const savedAgentDomain = new SavedAgentService(
      savedAgentRepository,
      savedAgentAdapters,
    );
    const savedAgents = new SavedAgentApplicationService({
      environmentVariables,
      agents: savedAgentDomain,
      repository: savedAgentRepository,
      adapters: savedAgentAdapters,
      configuration: backendConfiguration,
      inventory: inventoryRepository,
      targets,
      targetHealth: executionTargets,
      registry,
      lifecycle,
      toolPolicies: agentToolPolicies,
      toolEligibility: agentToolPolicyDependencies.eligibility,
      toolCatalog: agentToolPolicyDependencies.catalog,
      executionWorkspaces: {
        assertAvailable({
          backendInstanceId,
          executionEnvironmentId,
          networkProfile,
        }) {
          const profilesForBackend = profiles.filter(
            (profile) =>
              profile.backendInstanceId === backendInstanceId &&
              profile.executionEnvironmentId === executionEnvironmentId,
          );
          if (
            profilesForBackend.length === 0 ||
            !advertisedWorkspaceIsolationNetworkProfiles
              .get(backendInstanceId)
              ?.includes(networkProfile)
          ) {
            throw new DomainError(
              "runtime_unavailable",
              "Isolated workspace execution is unavailable.",
              true,
            );
          }
        },
        selection(eventScope, applicationThreadId) {
          const allocation = piSandboxAllocations.getForThread(
            eventScope,
            applicationThreadId,
          );
          return allocation
            ? {
                kind: "isolated" as const,
                workspaceAccess: allocation.workspaceAccess,
                networkProfile: allocation.networkProfile,
              }
            : { kind: "direct" as const };
        },
        reserve: (eventScope, input) =>
          piSandboxMaterializer.reserve(eventScope, input),
      },
      publications: {
        handoffThreadChange(eventScope, applicationThreadId) {
          if (!applicationSnapshots) {
            throw new Error("saved_agent_publication_boundary_unavailable");
          }
          applicationSnapshots.handoffThreadChange(
            eventScope,
            applicationThreadId,
          );
        },
      },
    });
    const threadTemplates = new ThreadTemplateApplicationService({
      repository: new ThreadTemplateRepository(database),
      savedAgents,
    });
    const taskRepository = new TaskRepository(database);
    const environmentRecords = new Map(
      inventoryRepository
        .listEnvironments(scope)
        .map((record) => [record.id, record]),
    );
    const backendAdvisoryEnvironments = new Map<
      string,
      InstallationAdvisoryBackendEnvironment
    >();
    for (const [backendInstanceId] of moduleRuntimes) {
      const environmentIds = [
        ...new Set(
          profiles
            .filter(
              (profile) =>
                profile.enabled &&
                profile.backendInstanceId === backendInstanceId,
            )
            .map((profile) => profile.executionEnvironmentId),
        ),
      ];
      if (environmentIds.length !== 1) {
        throw new Error("installation_advisory_backend_environment_invalid");
      }
      const environmentId = environmentIds[0]!;
      const environmentRecord = environmentRecords.get(environmentId);
      if (!environmentRecord) {
        throw new Error("installation_advisory_backend_environment_invalid");
      }
      backendAdvisoryEnvironments.set(backendInstanceId, {
        id: environmentRecord.id,
        kind: environmentRecord.kind,
        label: environmentRecord.label,
      });
    }
    const installationAdvisories = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: moduleRuntimes,
      backendEnvironments: backendAdvisoryEnvironments,
    });
    const application = new ApplicationSnapshotService(
      inventoryRepository,
      applicationThreadSummaries,
      runtimes,
      executionTargets,
      new DatabaseApplicationLineageSummaryReader(lineageRepository),
      taskRepository,
      threadGroupRepository,
      (requestScope, environmentId) =>
        execution!.directoryBrowsingAvailability(requestScope, environmentId),
      terminalRepository,
      installationAdvisories,
    );
    const activeApplicationSnapshots =
      new ApplicationSnapshotPublicationBoundary(application, applicationHubs);
    applicationSnapshots = activeApplicationSnapshots;
    targets.bindWorkspacePublications(activeApplicationSnapshots);
    const unsubscribeInstallationAdvisories =
      subscribeInstallationAdvisoryPublication(
        installationAdvisories,
        scope,
        () => activeApplicationSnapshots.publishAuthoritativeReplacement(scope),
        reportBackgroundError("Installation advisory publication"),
      );
    resources.defer(
      "installation advisory publication subscription",
      unsubscribeInstallationAdvisories,
    );
    const threadGroups = new ThreadGroupService(
      threadGroupRepository,
      activeApplicationSnapshots,
    );
    publishExecutionEnvironmentChange = (environmentId) =>
      activeApplicationSnapshots.handoffEnvironmentChange(scope, environmentId);
    forks.bindApplicationSnapshots(activeApplicationSnapshots);
    publishApplicationThread = new ApplicationThreadChangePublisher(
      activeApplicationSnapshots,
    );
    const activeThreadSnapshots = new ThreadSnapshotPublisher(
      bindings,
      threads,
      runtimes,
      (eventScope, applicationThreadId) =>
        publishApplicationThread!.publish(eventScope, applicationThreadId),
      reportBackgroundError("Thread snapshot publication"),
    );
    threadSnapshots = activeThreadSnapshots;
    inventory = new InventoryService(
      inventoryRepository,
      {
        publishMany(eventScope, states) {
          scheduler?.rearm();
          activeApplicationSnapshots.handoffStructuralThreadChanges(eventScope, states.map(({ threadId }) => threadId));
          activeThreadSnapshots.scheduleMany(
            eventScope,
            states.map(({ threadId }) => threadId),
          );
        },
        onRetryPending: () => scheduler?.rearm(),
        publishApplicationThread: (eventScope, applicationThreadId) =>
          activeApplicationSnapshots.publishThreadChange(
            eventScope,
            applicationThreadId,
          ),
      },
      (eventScope, state) =>
        notificationLifecycle.deadlineWake(eventScope, state),
    );
    const turnBookmarks = new ConversationTurnBookmarkService(
      turnBookmarkRepository,
      {
        handoffThreadChange: (eventScope, applicationThreadId) =>
          activeApplicationSnapshots.handoffThreadChange(
            eventScope,
            applicationThreadId,
          ),
      },
    );
    const tasks = new TaskService(
      taskRepository,
      activeApplicationSnapshots,
      () => scheduler?.rearm(),
    );
    const workpads = new WorkpadService(
      new WorkpadRepository(database),
      activeApplicationSnapshots,
      () => scheduler?.rearm(),
    );
    forks.bindTaskPublications(tasks);
    const threadArchives = new ThreadArchiveService({
      inventory: inventoryRepository,
      lineage: lineageRepository,
      summaries: applicationThreadSummaries,
      runtimes,
      publications: inventory,
      tasks: taskRepository,
      taskPublications: tasks,
      executionWorkspaces: piSandboxLifecycle,
    });
    const threadBulkInventory = new ThreadBulkInventoryService({
      inventory: inventoryRepository,
      summaries: applicationThreadSummaries,
      runtimes,
      publications: inventory,
      tasks: taskRepository,
      taskPublications: tasks,
    });
    const threadForceResets = new ThreadForceResetService({
      repository: new ThreadForceResetRepository(database),
      interactions,
      runtimes,
      scheduleThreadPublications: (eventScope, threadIds) =>
        activeThreadSnapshots.scheduleMany(eventScope, threadIds),
      publishTaskChange: (eventScope, taskId) =>
        tasks.publishTaskChange(eventScope, taskId),
      onPostCommitError: reportBackgroundError(
        "Thread force-reset publication",
      ),
    });
    observeAuthoritativeCompletion = async (
      eventScope,
      applicationThreadId,
      input,
    ) => {
      const observed = await queueDispatcher!.onAuthoritativeCompletion(
        eventScope,
        applicationThreadId,
        input,
      );
      if (!observed) return;
      notificationLifecycle.completion(eventScope, observed);
      authoritativeCompletionFollowUp.defer(async () => {
        const failures: unknown[] = [];
        try {
          await completionCallbackDispatcher.deliverReady(eventScope);
        } catch (error) {
          failures.push(error);
        }
        try {
          await mutations?.recoverThread(eventScope, applicationThreadId);
        } catch (error) {
          failures.push(error);
        }
        try {
          await inventory.wakeForRuntimeSignal(
            eventScope,
            applicationThreadId,
            "completion",
          );
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Authoritative completion follow-up did not finish cleanly.",
          );
        }
      });
    };
    const attention = new ThreadAttentionService({
      inventory: inventoryRepository,
      completions: completion,
      queue: queueDispatcher,
      publish: (eventScope, applicationThreadId) => {
        activeThreadSnapshots.schedule(eventScope, applicationThreadId);
      },
    });
    mutations = new ThreadMutationGateway({
      bindings,
      inventory: inventoryRepository,
      lifecycle,
      forks,
      queue: queueDispatcher,
      operations: operationRepository,
      completions: completion,
      queueGateway,
      runtimes,
      interactions,
      presentation: threadPresentation,
      agentToolPolicies,
      actionPersistence,
      publishThreadSnapshot: (eventScope, applicationThreadId) =>
        activeThreadSnapshots.publish(eventScope, applicationThreadId),
      onPublicationError: reportBackgroundError("Thread mutation publication"),
      onThreadChanged: (eventScope, applicationThreadId) =>
        publishApplicationThread!.publish(eventScope, applicationThreadId),
    });
    resources.defer("thread mutations", () => mutations?.close(), {
      mode: "ownership_critical",
    });
    resources.defer(
      "authoritative completion follow-up",
      () => authoritativeCompletionFollowUp.close(),
      { mode: "ownership_critical" },
    );
    threads.bindMutations(mutations);

    const automations = new AutomationService({
      repository: automationRepository,
      inventory: inventoryRepository,
      // Automation state is part of both the open thread projection and the
      // application inventory. ThreadSnapshotPublisher updates the loaded
      // thread first, then publishes the matching application summary.
      publisher: activeThreadSnapshots,
      onChanged: () => scheduler?.rearm(),
      onReconcileError: reportBackgroundError("Automation reconciliation"),
      onRunLifecycle: (eventScope, input) =>
        notificationLifecycle.automation(eventScope, input),
      executionPolicy: automationExecutionPolicy,
    });
    const automationPrechecks = new AutomationPrecheckExecutor(
      inventoryRepository,
      execution,
    );

    const automationFirstInput = new ConversationLifecycleAutomationFirstInput(
      lifecycle,
    );
    const automationGateway = new LifecycleAutomationConversationGateway({
      threads: {
        read(eventScope, applicationThreadId) {
          const thread = inventoryRepository.getThread(
            eventScope,
            applicationThreadId,
          ).thread;
          return {
            backingState: thread.backingState,
            revision: thread.revision,
          };
        },
      },
      queue: queueDispatcher,
      queueRepository,
      firstInput: automationFirstInput,
      branches: forks,
      executionPolicy: automationExecutionPolicy,
    });
    automationDispatcher = new AutomationDispatcher({
      repository: automationRepository,
      gateway: automationGateway,
      inventory: inventoryRepository,
      service: automations,
      prechecks: automationPrechecks,
    });
    automations.bindDispatcher(automationDispatcher);
    const workspaceManagement = new WorkspaceApplicationService({
      inventory: inventoryRepository,
      execution,
      publications: activeApplicationSnapshots,
      discoverWorkspace: discoverOpenedWorkspace,
    });
    const managementAgentTools = new AgentManagementService({
      database,
      inventory: inventoryRepository,
      threadSummaries: applicationThreadSummaries,
      runtimes,
      workspaces: workspaceManagement,
      taskRepository,
      tasks,
    });
    const automationAgentTools = new AutomationAgentToolService({
      automations,
      threads,
      inventory: inventoryRepository,
    });
    const threadControlAgentTools = {
      messages: new ThreadMessagesService({
        inventory: threadInventory,
        runtimes,
      }),
      send: new AgentThreadControlService(mutations, inventoryRepository),
      forks,
      inventory: new AgentThreadInventoryControlService({
        inventory: inventoryRepository,
        threads: inventoryRepository,
        lineage: lineageRepository,
        archives: threadArchives,
        transitions: inventory,
      }),
    };
    const canonicalAgentTools = new CanonicalInlineAgentToolService({
      workpads: new WorkpadAgentToolService({ workpads, authorityReader: agentToolSources }),
      application: agentToolApplication,
      management: managementAgentTools,
      automations: automationAgentTools,
      savedAgents,
      threadCreation: savedAgents,
      threadControl: threadControlAgentTools,
      webSearch,
      threadWorktrees: new ThreadWorktreeAgentToolService(
        workspaceFiles,
        inventory,
      ),
      unavailableToolIds: new Set(
        [...agentToolRuntimeAvailability]
          .filter(([, availability]) => !availability.available)
          .map(([toolId]) => toolId),
      ),
    });
    deferAgentToolAutomationShutdown(resources, {
      closeCanonical: () => canonicalAgentTools.close(),
      disposeDispatcher: () => automationDispatcher?.dispose(),
    });
    const agentToolEnvironmentAuthority =
      new AgentToolEnvironmentAuthorityResolver(agentToolSources);
    const sourceScopedAgentTools = new SourceScopedAgentToolService(
      canonicalAgentTools,
      agentToolPolicies,
      agentToolEnvironmentAuthority,
      agentToolSources,
      runtimes,
      interactions,
    );
    const principalClientAgentTools = new PrincipalAgentToolClientService(
      toolProvenanceKey,
      database,
      principalAgentToolClients,
      canonicalAgentTools,
      agentToolEnvironmentAuthority,
      Date.now,
      {},
      agentToolPolicyDependencies.catalog,
    );
    agentTools.bind(sourceScopedAgentTools);
    const httpAgentTools = new PolicyCheckedAgentToolHttpService(
      sourceScopedAgentTools,
    );
    observeAutomationQueue = new AutomationQueueRunObserver({
      repository: automationRepository,
      queue: queueRepository,
      publisher: automations,
    });

    await forks.recoverAllActive(scope);
    await queueDispatcher.recover(scope);
    await completionCallbackDispatcher.deliverReady(scope);
    await mutations.recoverUncertain(scope);
    observeAutomationQueue.recover();
    scheduler = new DurableScheduler(
      [
        automations,
        {
          getNearestDeadline: () => inventory.getNearestDeadline(),
          reconcileDue: (now) => inventory.wakeDue(now).then(() => undefined),
        },
        {
          getNearestDeadline: () => tasks.getNearestDeadline(),
          reconcileDue: (now) => tasks.reconcileDue(now),
        },
        {
          getNearestDeadline: () => workpads.getNearestDeadline(),
          reconcileDue: (now) => workpads.reconcileDue(now),
        },
      ],
      { onError: reportBackgroundError("Durable scheduling") },
    );

    const createDiscoveryServices = () => {
    const discoveryProfiles = groupBackendDiscoveryProfiles(
      profiles.filter(profile => profile.enabled && moduleRuntimes.has(profile.backendInstanceId)).map((profile) => {
        const runtime = moduleRuntimes.get(profile.backendInstanceId);
        if (!runtime) throw new Error("backend_runtime_missing");
        return {
          profile,
          isDefault: profile.templateId === backendConfigurationFile.defaultTargetId,
          nativeNamespaceKey: runtime.discovery.nativeNamespaceKey(profile),
        };
      }),
    );
    return discoveryProfiles.map(
      ({ profile, connectionProfileIds }) => ({
        executionEnvironmentId: profile.executionEnvironmentId,
        service: new BackendDiscoveryService({
          targets,
          inventory: inventoryRepository,
          bindings,
          lineage: lineageRepository,
          forks,
          persistence: discoveryPersistence,
          connectionProfileId: profile.id,
          connectionProfileIds,
          onAncestryReconciliationConflict: (
            _eventScope,
            error,
            childThreadId,
          ) =>
            reportBackgroundError(
              `Native ancestry reconciliation for thread ${childThreadId}`,
            )(error),
          onForkReconciliationError: (
            _eventScope,
            error,
            applicationOperationId,
          ) =>
            reportBackgroundError(
              `Fork reconciliation for operation ${applicationOperationId}`,
            )(error),
          onThreadChanged: (eventScope, applicationThreadId) =>
            activeThreadSnapshots.publish(eventScope, applicationThreadId),
        }),
      }),
    );
    };
    let discoveryServices = createDiscoveryServices();
    async function discoverWorkspace(
      eventScope: typeof scope,
      workspaceId: string,
      policy: BackendDiscoveryScanPolicy,
      signal: AbortSignal,
    ) {
      if (inventoryRepository.isWorkspaceRemoved(eventScope, workspaceId)) return;
      const workspace = inventoryRepository.getWorkspace(
        eventScope,
        workspaceId,
      );
      const results = await Promise.allSettled(
        discoveryServices
          .filter(
            ({ executionEnvironmentId }) =>
              executionEnvironmentId === workspace.environmentId,
          )
          .map(({ service }) =>
            service.discoverWorkspace(eventScope, workspaceId, policy, signal),
          ),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map(({ reason }) => reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more backend discovery scans failed.",
        );
      }
    }

    async function discoverOpenedWorkspace(
      eventScope: typeof scope,
      workspaceId: string,
    ): Promise<void> {
      await (discoveryOperations.admit(async (signal) => {
        try {
          await discoverWorkspace(
            eventScope,
            workspaceId,
            EXHAUSTIVE_DISCOVERY_SCAN,
            signal,
          );
        } catch (error) {
          reportBackgroundError("Conversation discovery")(error);
        }
      }) ?? Promise.resolve());
    }

    const discoverRecentWorkspaces = async (signal: AbortSignal) => {
      const byEnvironment = new Map<
        string,
        ReturnType<typeof inventoryRepository.listWorkspaces>
      >();
      for (const workspace of inventoryRepository.listWorkspaces(scope)) {
        if (workspace.availability !== "available") continue;
        const group = byEnvironment.get(workspace.environmentId) ?? [];
        group.push(workspace);
        byEnvironment.set(workspace.environmentId, group);
      }
      await Promise.all(
        [...byEnvironment.values()].map(async (workspaces) => {
          for (const workspace of workspaces) {
            if (signal.aborted) return;
            try {
              await discoverWorkspace(
                scope,
                workspace.id,
                {
                  kind: "bounded_recent",
                  maximumPages: 1,
                },
                signal,
              );
            } catch (error) {
              reportBackgroundError(
                `Conversation discovery for ${workspace.canonicalPath}`,
              )(error);
            }
          }
        }),
      );
    };
    scheduler.start();
    resources.defer("durable scheduler", () => scheduler?.stop(), {
      mode: "ownership_critical",
    });
    // Registered after every discovery dependency so LIFO shutdown drains
    // detached scans before disposing runtimes or the application database.
    resources.defer(
      "detached discovery operations",
      () => discoveryOperations.close(),
      { mode: "ownership_critical" },
    );

    const managedTerminalAuthority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: moduleRuntimes,
    });
    const managedTerminalAdmissions = new ManagedTerminalAdmissionTokens(
      managedTerminalAuthority,
    );
    const terminalService = new TerminalService({
      environmentVariables: (candidate, environmentId) => environmentVariables.environmentDefaults(candidate, environmentId),
      inventory: inventoryRepository,
      repository: terminalRepository,
      journal: new TerminalJournalStore({
        stateDirectory: config.stateDirectory,
      }),
      providers: terminalProviders,
      onTerminalSummaryChanged: (changedScope, changedThreadId) => {
        void activeApplicationSnapshots
          .publishThreadChange(changedScope, changedThreadId, {
            forcePublication: true,
          })
          .catch(reportBackgroundError("Terminal summary publication"));
      },
    });
    terminalService.recover(scope);
    resources.defer("application terminals", () => terminalService.close(), {
      mode: "ownership_critical",
    });
    const managementAbort = new AbortController();
    const managementSignal = () => AbortSignal.any([managementAbort.signal, AbortSignal.timeout(10_000)]);
    // Staging (30s), owned-process shutdown and replacement have a separate
    // budget from read-only status probes and HTTP acknowledgement.
    const lifecycleSignal = () => AbortSignal.any([managementAbort.signal, AbortSignal.timeout(90_000)]);
    // Background reconnection shares the configuration queue with every other
    // operation; a slow or absent host must not stall them for a full budget.
    const maintenanceSignal = () => AbortSignal.any([managementAbort.signal, AbortSignal.timeout(40_000)]);
    const observedServices = new Map<string, SidecarServiceStatus | null>();
    const backendPresence = new Map<string, boolean>();
    const observedBackends = new Map<string, Awaited<ReturnType<NonNullable<BackendModuleRuntime["administration"]>["inspect"]>>>();
    const remoteBackendObservations = new WeakMap<BackendModuleRuntime, { serviceIdentity: string; pending: Promise<void> }>();
    const observationFailures = new Map<string, "unreachable" | SidecarOwnershipRecoveryCode>();
    const requiresOwnershipRecovery = (error: unknown): boolean => sidecarOwnershipRecoveryCode(error) !== undefined;
    const observationFailure = (error: unknown) => sidecarOwnershipRecoveryCode(error) ?? "unreachable" as const;
    const ownershipRecovery = (key: string, preparationError: unknown): SidecarOwnershipRecoveryCode | undefined => {
      const failure = observationFailures.get(key);
      return failure && failure !== "unreachable" ? failure : sidecarOwnershipRecoveryCode(preparationError);
    };
    // A host that answered but refused or could not start an attachment is not
    // unreachable. Its management status stays observable and its reason is shown.
    const sidecarReportedCode = (error: unknown): string | undefined => {
      for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
        if (error instanceof SidecarServiceManagementError) return error.code;
        if (/^sidecar_(revision_changed|automatic_connection_disabled|intentionally_disconnected|runtime_closed|transport_unavailable)$/u.test(error.message)) return error.message;
      }
      return undefined;
    };
    const attachmentBlocks = new Map<string, string>();
    const unadmittedSince = new Map<string, number>();
    const attachmentBlockMessage = (code: string): string | null => {
      switch (code) {
        case "sidecar_service_upgrade_blocked": return "A newer sidecar is staged, but active resources block an automatic upgrade. Use Upgrade and restart to interrupt them, or wait until the host is idle.";
        case "sidecar_runtime_upgrade_required": return "The installed sidecar is incompatible with this server. Upgrade and restart it to restore remote operations.";
        case "sidecar_service_cleanup_unproven": return "Resource cleanup is unconfirmed; replacement is blocked. Stop the service to retry its cleanup.";
        case "sidecar_resource_handoff_pending": case "sidecar_service_not_ready": return "Final terminal history or operation outcomes must be recovered before this service can stop.";
        case "sidecar_service_confirmation_stale": return "The sidecar's resources changed during an automatic upgrade attempt. It is retried automatically.";
        case "sidecar_revision_changed": return "Saved configuration changes are pending. Restart the sidecar to apply them.";
        case "sidecar_service_retirement_in_progress": return "The previous sidecar is still exiting. Retry shortly.";
        case "sidecar_service_startup_locked": return "Another sidecar start is in progress on the host. Retry shortly.";
        case "sidecar_automatic_connection_disabled": case "sidecar_intentionally_disconnected": case "sidecar_runtime_closed": case "sidecar_transport_unavailable": return null;
        default: return `The sidecar could not be started on the host (${code}). Retry, or inspect the host.`;
      }
    };
    let configurationTail: Promise<unknown> = Promise.resolve();
    const serializeConfiguration = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = configurationTail.catch(() => undefined).then(operation);
      configurationTail = result.catch(() => undefined);
      return result;
    };
    const assertManagementScope = (candidate: RequestScope): void => {
      if (candidate.tenantId !== scope.tenantId || candidate.principalId !== scope.principalId) {
        throw new DomainError("not_found", "Configuration is unavailable in this scope.");
      }
      configurationRepository.assertPrincipal(candidate);
    };
    const backendThreads = async (backendId: string) => {
      const rows = database!.prepare(`SELECT id FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ? ORDER BY id`)
        .all(scope.tenantId, scope.principalId, backendId) as {id: string}[];
      const loaded = await Promise.all(rows.map(row => runtimes!.captureLoadedRuntime(scope, row.id)));
      return loaded.filter((item): item is NonNullable<typeof item> => item !== undefined);
    };
    const backendHasRemoteProvider = (id: string): boolean => {
      const configured = backendConfigurationFile.backends.find(item => item.id === id);
      const environmentId = profiles.find(profile => profile.backendInstanceId === id)?.executionEnvironmentId;
      return Boolean(configured && environmentId && inventoryRepository.getEnvironment(scope, environmentId).kind !== "local" && compiledBackendModuleCatalog.requireModule(configured.kind).remoteRuntimeCapabilities?.length);
    };
    const recoverBackendAdministration = async (id: string) => {
      const connections = profiles.filter(profile => profile.backendInstanceId === id);
      const environmentId = connections[0]?.executionEnvironmentId;
      if (!environmentId || connections.some(profile => profile.executionEnvironmentId !== environmentId)) throw new DomainError("runtime_unavailable", "The backend execution identity cannot be recovered.", true);
      const environmentRuntime = environmentRuntimes.get(environmentId);
      const remote = backendHasRemoteProvider(id);
      if (!remote) return moduleRuntimes.get(id)?.administration;
      const owner = environmentRuntime?.sidecarRuntime;
      if (!owner) throw new DomainError("runtime_unavailable", "The execution host is unavailable for backend recovery.", true);
      const service = await owner.inspectService(managementSignal());
      observedServices.set(environmentId, service ?? null);
      if (!service) { backendPresence.set(id, false); observedBackends.delete(id); return undefined; }
      const configured = backendConfigurationFile.backends.find(item => item.id === id);
      if (!configured) throw new DomainError("runtime_unavailable", "The retained backend configuration is unavailable.", true);
      const prepared = compiledBackendModuleCatalog.prepare({
        backends: [configured], connections: backendConfigurationFile.targets.filter(target => target.backendInstanceId === id),
        executionEnvironments: backendConfigurationFile.executionEnvironments, environment,
      })[0];
      if (!prepared?.recoverAdministration) throw new DomainError("runtime_unavailable", "This backend does not support detached administration.", true);
      const administration = await prepared.recoverAdministration({
        database: database!, scope, instance: backendInstance(backendConfiguration.getBackend(scope, id)), connections,
        sidecarRuntime: {async acquireRecovery(signal = managementSignal()) {
          const lease = await owner.acquireRecovery(scope, environmentId, signal);
          return {channel: lease.session.runtimeChannel, controllerEpoch: lease.serviceStatus.controllerEpoch,
            serviceIncarnation: lease.serviceStatus.serviceIncarnation, closed: lease.session.closed, release: () => lease.release()};
        }},
      });
      backendPresence.set(id, administration !== undefined);
      if (!administration) observedBackends.delete(id);
      return administration;
    };
    const captureAdministrativeResource = async (record: ConfigurationRuntimeState, refresh: boolean, refreshProvider = true) => {
      const current = configurationRepository.get(scope);
      const id = record.resourceId;
      const key = `${record.resourceKind}:${id}`;
      const interruptions: string[] = [];
      let runtime: ConfigurationRuntimeState;
      let service: SidecarServiceStatus | undefined;
      let administration: BackendModuleRuntime["administration"];
      let backendObservation: Awaited<ReturnType<NonNullable<BackendModuleRuntime["administration"]>["inspect"]>> | undefined;
      if (record.resourceKind === "environment") {
        const definition = current.configuration.executionEnvironments.find(item => item.id === id);
        const owner = environmentRuntimes.get(id)?.sidecarRuntime;
        if (refresh && owner) {
          // Refresh backend-owned native inventory before binding an environment
          // impact token. The independent management status still works when a
          // provider runtime cannot be recovered or speaks an older dialect.
          for (const backend of (refreshProvider ? current.configuration.backends : []).filter(backend => current.configuration.targets.some(target => target.backendInstanceId === backend.id && target.executionEnvironmentId === id))) {
            try { const control = backendHasRemoteProvider(backend.id) ? await recoverBackendAdministration(backend.id) : moduleRuntimes.get(backend.id)?.administration; if (control) observedBackends.set(backend.id, await control.inspect()); }
            catch { /* Stable management inventory remains authoritative below. */ }
          }
          try { observedServices.set(id, await owner.inspectService(managementSignal()) ?? null); observationFailures.delete(key); }
          catch (error) { observationFailures.set(key, observationFailure(error)); }
        }
        service = observedServices.get(id) ?? undefined;
        const terminalImpact = terminalService.impact(scope, id);
        const blockers = service?.resources.filter(item => item.state !== "idle" || item.blockers.length > 0) ?? [];
        interruptions.push(...blockers.map(item => `${item.kind} ${item.resourceId} (${item.state}): ${item.blockers.join(", ") || "no additional blockers"}`));
        if (terminalImpact.liveCount) interruptions.push(`${terminalImpact.liveCount} live terminal(s) will be interrupted.`);
        if (terminalImpact.unknownCount) interruptions.push(`${terminalImpact.unknownCount} terminal(s) have unconfirmed process state.`);
        const remote = definition !== undefined && definition.kind !== "local";
        const outboundOffline = definition?.kind === "outbound" && !outboundConnections.isConnected(scope, id);
        const recoveryRequired = ownershipRecovery(key, environmentPreparationFailures.get(id));
        const observed = observedServices.has(id);
        const disconnected = record.preference === "disconnected" && observed && !service?.attached && !observationFailures.has(key);
        const stopped = record.preference === "stopped" && observed && (!service || service.state === "stopped") && !observationFailures.has(key);
        const prepared = appliedEnvironmentFingerprints.get(id) === environmentRuntimeFingerprint(id) && appliedEnvironmentRevisions.get(id) === record.desiredRevision;
        const applied = definition === undefined
          ? !environmentRuntimes.has(id)
          : remote
            ? prepared && (stopped || (disconnected && !service) || Boolean(service && service.configurationState === "applied" &&
              service.effectiveConfiguration.environmentRevision === inventoryRepository.getEnvironment(scope, id).configurationRevision &&
              service.effectiveConfiguration.operationsRevision === inventoryRepository.getEnvironment(scope, id).operationsConfigurationRevision &&
              (record.preference !== "disconnected" || disconnected)))
            : prepared;
        runtime = {...record,
          effectiveRevision: applied ? record.desiredRevision : record.effectiveRevision,
          applyState: outboundOffline || observationFailures.has(key) || environmentPreparationFailures.has(id) ? "unavailable" : applied ? "applied" : "pending",
          connectionState: outboundOffline ? "unreachable" : recoveryRequired ? "recovery_required" : stopped ? "stopped" : disconnected ? "disconnected" : observationFailures.has(key) ? "unreachable" : remote ? service?.attached ? "connected" : observed ? "disconnected" : "unknown" : environmentRuntimes.has(id) ? "connected" : "stopped",
          incarnation: service?.serviceIncarnation ?? (remote ? null : environmentRuntimes.has(id) ? `local:${sidecarInstallationId}:${id}` : null),
          softwareVersion: service?.buildId ?? null,
          upgradeState: !remote ? "current" : !service || !owner ? "unknown" : service.artifactSha256 === owner.artifact.artifactSha256 ? "current" : service.runtimeWireVersion === SIDECAR_WIRE_VERSION ? "pending" : "required",
          activeResources: Math.max(blockers.length, terminalImpact.liveCount + terminalImpact.unknownCount),
          supportedActions: owner && definition && !outboundOffline ? ["connect", "disconnect", "start", "stop", "restart", "upgrade"] : [],
          lastError: outboundOffline ? "The host connector is offline. Start it on the host or wait for it to reconnect; retained work has not been discarded." : recoveryRequired ? sidecarOwnershipRecoveryMessage(recoveryRequired) : observationFailures.has(key) ? "The execution host is unreachable; retained work has not been discarded." : environmentPreparationFailures.has(id) ? "The environment could not apply its configuration. Check its settings and installed sidecar artifacts." : service?.state === "handoff_pending" ? "Final terminal history or operation outcomes must be recovered before this service can stop." : service?.state === "cleanup_unproven" ? "Resource cleanup is unconfirmed; replacement is blocked. Stop the service to retry its cleanup." : attachmentBlocks.has(id) && !service?.attached ? attachmentBlockMessage(attachmentBlocks.get(id)!) : null,
        };
      } else {
        const definition = current.configuration.backends.find(item => item.id === id);
        const owned = moduleRuntimes.get(id);
        const remote = backendHasRemoteProvider(id);
        const serviceIdentity = () => {
          const environmentId = profiles.find(profile => profile.backendInstanceId === id)?.executionEnvironmentId;
          const observed = environmentId ? observedServices.get(environmentId) : undefined;
          return configurationFingerprint(observed ? { incarnation: observed.serviceIncarnation, epoch: observed.controllerEpoch, attached: observed.attached } : null);
        };
        const cached = owned && remote ? remoteBackendObservations.get(owned) : undefined;
        if (refresh || (owned && remote && cached?.serviceIdentity !== serviceIdentity())) {
          const observation = { serviceIdentity: serviceIdentity(), pending: Promise.resolve() };
          // Module preparation knows desired startup settings, not those of a
          // retained remote process. Recover its applied fingerprint once per
          // module/attachment using existing-only administration, never ensure.
          observation.pending = (async () => {
            try {
              administration = remote ? await recoverBackendAdministration(id) : owned?.administration;
              if (administration) observedBackends.set(id, await administration.inspect());
              observationFailures.delete(key);
            } catch (error) {
              observationFailures.set(key, observationFailure(error));
              if (owned && remote && remoteBackendObservations.get(owned) === observation) remoteBackendObservations.delete(owned);
            }
            finally { observation.serviceIdentity = serviceIdentity(); }
          })();
          if (owned && remote) remoteBackendObservations.set(owned, observation);
          await observation.pending;
        } else if (cached) {
          await cached.pending;
        }
        backendObservation = observedBackends.get(id);
        if (backendObservation?.startupEnvironmentFingerprint) {
          appliedStartupEnvironmentFingerprints.set(id, backendObservation.startupEnvironmentFingerprint);
        }
        const loaded = await backendThreads(id);
        const active = loaded.filter(item => item.runState !== "idle");
        interruptions.push(...active.map(item => `Thread ${item.threadId}: ${item.runState}`));
        interruptions.push(...(backendObservation?.blockers ?? []).map(blocker => `Provider resource: ${blocker}`));
        const intentionallyAbsent = !definition?.enabled || record.preference !== "automatic";
        const recoveryRequired = ownershipRecovery(key, backendPreparationFailures.get(id));
        const applied = intentionallyAbsent ? !owned && (record.preference !== "stopped" || !remote || backendPresence.get(id) === false) : appliedBackendRevisions.get(id) === record.desiredRevision && Boolean(owned) && !startupEnvironmentPending(id) &&
          !observationFailures.has(key) && (!owned?.administration || Boolean(backendObservation && backendObservation.state !== "unknown"));
        runtime = {...record,
          effectiveRevision: applied ? record.desiredRevision : record.effectiveRevision,
          applyState: backendPreparationFailures.has(id) || observationFailures.has(key) ? "unavailable" : applied ? "applied" : "pending",
          startupEnvironmentPending: (Boolean(owned) || Boolean(backendObservation)) && startupEnvironmentPending(id),
          connectionState: recoveryRequired ? "recovery_required" : observationFailures.has(key) ? "unreachable" : record.preference === "disconnected" && !owned ? "disconnected" : !owned ? remote && backendPresence.get(id) !== false ? backendPresence.get(id) === true ? "disconnected" : "unknown" : "stopped" : owned.administration && !backendObservation ? "unknown" : "connected",
          incarnation: backendObservation?.incarnation ?? backendIncarnations.get(id) ?? null,
          softwareVersion: null,
          upgradeState: "current",
          activeResources: Math.max(active.length, backendObservation?.state === "active" || backendObservation?.state === "unknown" ? 1 : 0),
          supportedActions: definition ? definition.enabled ? ["connect", ...(remote ? ["disconnect" as const] : []), "start", "stop", "restart"] : [...(remote ? ["disconnect" as const] : []), "stop"] : [],
          lastError: recoveryRequired ? sidecarOwnershipRecoveryMessage(recoveryRequired) : backendPreparationFailures.has(id) ? "This backend could not apply its configuration. Check its settings and execution environment." : observationFailures.has(key) ? "Provider state is unavailable; active work and retained outcomes may still exist." : null,
        };
      }
      return {runtime, service, backendObservation, administration, interruptions: interruptions.length > 128 ? [...interruptions.slice(0, 127), `${interruptions.length - 127} additional affected resources.`] : interruptions,
        fence: configurationFingerprint({resourceKind: record.resourceKind, id, incarnation: runtime.incarnation,
          // Main reattaching advances the controller epoch without changing any
          // resource; the sidecar still validates the epoch it is finally given.
          service: service ? {state: service.state, resources: service.resourcesFingerprint, configuration: service.desiredConfiguration} : null,
          backend: backendObservation?.revision ?? null,
          loaded: record.resourceKind === "backend" ? await backendThreads(id) : null}),
      };
    };
    const withdrawEnvironmentRuntime = async (id: string): Promise<void> => {
      const current = environmentRuntimes.get(id);
      if (!current) return;
      await terminalService.detachEnvironment(scope, id);
      await current.close();
      environmentRuntimes.delete(id);
      execution!.remove(scope, id);
      workspaceFileRouter.remove(scope, id);
      executionAttachmentStager.remove(scope, id);
      executionEnvironments.delete(id); environmentChannels.delete(id); workspaceFileProviders.delete(id);
      attachmentStagers.delete(id); terminalProviders.delete(id); environmentOperations.delete(id);
      agentToolSidecarRuntimes.delete(id); agentToolCli.delete(id);
      for (const backendId of current.workspaceIsolations.keys()) workspaceIsolations.delete(backendId);
      for (const backendId of current.networkProfiles.keys()) advertisedWorkspaceIsolationNetworkProfiles.delete(backendId);
      appliedEnvironmentRevisions.delete(id); appliedEnvironmentFingerprints.delete(id);
    };
    const reconciliationFingerprint = () => configurationFingerprint({
      configurationRevision: desiredConfiguration.revision,
      environments: [...appliedEnvironmentRevisions],
      backends: [...appliedBackendRevisions],
      environmentFailures: [...environmentPreparationFailures.keys()],
      backendFailures: [...backendPreparationFailures.keys()],
    });
    const reconcileLiveConfiguration = async (): Promise<void> => {
      const before = reconciliationFingerprint();
      const previousEnvironments = new Map(environmentRuntimes);
      const previousBackends = new Map(moduleRuntimes);
      desiredConfiguration = configurationRepository.get(scope);
      backendConfigurationFile = resolveDatabaseBackendConfiguration(desiredConfiguration.configuration, compiledBackendModuleCatalog);
      profiles = backendConfiguration.listProfiles(scope).map(connectionProfile);
      const environmentIds = new Set([...environmentRuntimes.keys(), ...desiredConfiguration.configuration.executionEnvironments.map(item => item.id)]);
      for (const id of environmentIds) {
        const definition = desiredConfiguration.configuration.executionEnvironments.find(item => item.id === id);
        if (definition && appliedEnvironmentFingerprints.get(id) === environmentRuntimeFingerprint(id)) {
          appliedEnvironmentRevisions.set(id, configurationRepository.runtime(scope, "environment", id).desiredRevision);
          continue;
        }
        try {
          const record = configurationRepository.runtime(scope, "environment", id);
          const removedRevokedHost = !definition && hostPairings.pairingForEnvironment(scope, id)?.state === "revoked";
          // Removal already passed the main-side resource guards. A revoked
          // host cannot supply another remote observation; withdraw only its
          // local attachment, without claiming the daemon has stopped.
          if (!removedRevokedHost) {
            const evidence = await captureAdministrativeResource(record, true);
            if (evidence.runtime.activeResources > 0 || evidence.service?.resources.some(item => item.blockers.length > 0) || observationFailures.has(`environment:${id}`)) continue;
          }
          const boundBackends = [...moduleRuntimes.keys()].filter(backendId => profiles.some(profile => profile.backendInstanceId === backendId && profile.executionEnvironmentId === id));
          // Check every main-side actor before withdrawing any sibling runtime.
          const loaded = await Promise.all(boundBackends.map(backendThreads));
          if (loaded.some(threads => threads.some(thread => thread.runState !== "idle"))) {
            environmentPreparationFailures.delete(id);
            continue;
          }
          for (const backendId of boundBackends) {
            await runtimeModules.remove(backendId, retireBackendRuntime);
            appliedBackendFingerprints.delete(backendId); appliedBackendRevisions.delete(backendId);
          }
          await withdrawEnvironmentRuntime(id);
          if (definition) {
            const runtime = await createEnvironmentRuntime(id);
            publishEnvironmentRuntime(runtime);
            execution!.set(scope, id, runtime.provider);
            workspaceFileRouter.set(scope, id, runtime.workspaceFiles);
            executionAttachmentStager.set(scope, id, runtime.attachments);
            agentToolCli.set(id, definition.kind === "local" ? localAgentToolCli : runtime.agentToolCliRuntime ? managedSshAgentToolCliAvailability({scope, executionEnvironmentId: id, runtime: runtime.agentToolCliRuntime}) : {availability: "unavailable", reason: "remote_environment"});
          }
        } catch (error) {
          if (error instanceof ThreadRuntimeNotIdleError) environmentPreparationFailures.delete(id);
          else environmentPreparationFailures.set(id, error);
        }
      }
      for (const id of new Set([...moduleRuntimes.keys(), ...desiredConfiguration.configuration.backends.map(item => item.id)])) {
        const definition = desiredConfiguration.configuration.backends.find(item => item.id === id);
        const record = configurationRepository.runtime(scope, "backend", id);
        if (!definition?.enabled || record.preference !== "automatic") {
          try { await runtimeModules.remove(id, retireBackendRuntime); appliedBackendFingerprints.delete(id); appliedBackendRevisions.delete(id); }
          catch (error) {
            if (error instanceof ThreadRuntimeNotIdleError) backendPreparationFailures.delete(id);
            else backendPreparationFailures.set(id, error);
          }
          continue;
        }
        // An environment-only edit also advances the desired backend revision.
        // Keep its old effective revision until every bound environment applies.
        if (profiles.some(profile => profile.enabled && profile.backendInstanceId === id &&
          appliedEnvironmentFingerprints.get(profile.executionEnvironmentId) !== environmentRuntimeFingerprint(profile.executionEnvironmentId))) continue;
        const configured = backendConfigurationFile.backends.find(item => item.id === id)!;
        const fingerprint = backendRuntimeFingerprint(id);
        if (fingerprint === appliedBackendFingerprints.get(id)) { appliedBackendRevisions.set(id, record.desiredRevision); continue; }
        // A startup edit is desired state only. Saving must never restart a
        // running process, even when it currently has no active thread.
        const existing = moduleRuntimes.get(id);
        if (existing && startupEnvironmentPending(id) && await existing.startupEnvironmentState?.() !== "not_started") continue;
        const observed = await captureAdministrativeResource(record, Boolean(moduleRuntimes.get(id)?.administration));
        if (observed.runtime.activeResources > 0 || observed.backendObservation?.blockers.length || observationFailures.has(`backend:${id}`)) continue;
        await applyBackendRuntime(id);
      }
      backendAdvisoryEnvironments.clear();
      for (const [id] of moduleRuntimes) {
        const profile = profiles.find(profile => profile.enabled && profile.backendInstanceId === id);
        if (profile) {
          const record = inventoryRepository.getEnvironment(scope, profile.executionEnvironmentId);
          backendAdvisoryEnvironments.set(id, {id: record.id, kind: record.kind, label: record.label});
        }
      }
      const runtimesChanged = previousEnvironments.size !== environmentRuntimes.size ||
        [...environmentRuntimes].some(([id, runtime]) => previousEnvironments.get(id) !== runtime) ||
        previousBackends.size !== moduleRuntimes.size ||
        [...moduleRuntimes].some(([id, runtime]) => previousBackends.get(id) !== runtime);
      const changed = runtimesChanged || before !== reconciliationFingerprint();
      if (changed) {
        executionTargets.invalidateHealth();
        discoveryServices = createDiscoveryServices();
      }
      if (configurationFingerprint(webSearchConfiguration ?? null) !== configurationFingerprint(backendConfigurationFile.webSearch ?? null)) {
        webSearchConfiguration = backendConfigurationFile.webSearch;
        const provider = new GrokCliWebSearchProvider({
          workDirectory: path.join(config.stateDirectory, "web-search", "workspace"),
          ...(webSearchConfiguration?.grokHome ? {grokHome: webSearchConfiguration.grokHome} : {}), environment,
        });
        const availability = webSearchConfiguration ? await provider.checkAvailability() : {available: false, reason: "Web search is not configured."};
        webSearch.reconfigure(provider, availability);
        agentToolRuntimeAvailability.set("research.web_search", availability);
      }
      executionTargets.setDefaultTargetTemplateId(backendConfigurationFile.defaultTargetId);
      // Replacing advisory sources publishes through their existing subscriber.
      const advisoryRuntimesChanged = installationAdvisories.replaceRuntimes(scope, moduleRuntimes);
      if (changed && !advisoryRuntimesChanged) await activeApplicationSnapshots.publishAuthoritativeReplacement(scope);
    };
    const detachBackend = async (id: string, effect?: () => Promise<void>): Promise<void> => {
      const rows = database!.prepare(`SELECT id FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ? ORDER BY id`)
        .all(scope.tenantId, scope.principalId, id) as {id: string}[];
      const previews = await Promise.all(rows.map(async row => ({id: row.id, evidence: await runtimes!.captureLoadedRuntime(scope, row.id)})));
      const retirement: BackendRuntimeRetirementAuthority = {
        async run<Result>(_runtime: BackendModuleRuntime, change: () => Promise<Result>): Promise<Result> {
          const admission = registry.suspend(scope, id);
          executionTargets.invalidateHealth();
          try {
            await admission.drained;
            let operation = async () => { await effect?.(); return change(); };
            for (const preview of previews.reverse()) {
              const next = operation;
              operation = () => runtimes!.runWithRuntimeDetached(scope, preview.id, preview.evidence, next);
            }
            return await operation();
          } finally { admission.release(); executionTargets.invalidateHealth(); }
        },
      };
      if (moduleRuntimes.has(id)) await runtimeModules.remove(id, retirement);
      else await effect?.();
      appliedBackendFingerprints.delete(id); appliedBackendRevisions.delete(id); backendIncarnations.delete(id); observedBackends.delete(id);
    };
    // Explicit Stop fences every selected backend before closing actors. Remote
    // shutdown completes before handle detachment, so an outstanding provider
    // call cannot make its own shutdown wait forever for a borrowed connection.
    const stopBackends = async <Result>(ids: readonly string[], effect: () => Promise<Result>): Promise<Result> => {
      const selected = [...new Set(ids)];
      const admissions = selected.map(id => registry.suspend(scope, id));
      executionTargets.invalidateHealth();
      try {
        const threadIds = selected.flatMap(id => (database!.prepare(`SELECT id FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ? ORDER BY id`)
          .all(scope.tenantId, scope.principalId, id) as {id: string}[]).map(row => row.id));
        let value!: Result;
        let effectSucceeded = false;
        return await runtimes!.runWithRuntimesStopped(scope, threadIds, async () => {
          let effectFailed = false;
          try { value = await effect(); effectSucceeded = true; }
          catch (error) { effectFailed = true; throw error; }
          finally {
            // Actor cleanup also runs after a rejected host command. Retire
            // provider connections first so it cannot emit late responses on
            // an external server which the command deliberately left running.
            const results = await Promise.allSettled(selected.map(async id =>
              moduleRuntimes.get(id)?.stopBeforeConversationCleanup?.()));
            const failures = results.flatMap((result, index) => {
              if (result.status !== "rejected") return [];
              reportBackgroundError(`Backend ${selected[index]} connection retirement`)(result.reason);
              return [result.reason];
            });
            if (!effectFailed && failures.length) throw new AggregateError(failures, "Backend connection retirement failed");
          }
        }, async () => {
          await Promise.all(admissions.map(admission => admission.drained));
          for (const id of selected) {
            await runtimeModules.remove(id, {run: (_runtime, change) => change()});
            appliedBackendFingerprints.delete(id); appliedBackendRevisions.delete(id);
            // A rejected remote command still retires the now-closed local
            // module, but does not prove the provider host stopped.
            if (effectSucceeded) {
              backendIncarnations.delete(id); observedBackends.delete(id); backendPresence.set(id, false);
            }
          }
          return value;
        });
      } finally { for (const admission of admissions) admission.release(); executionTargets.invalidateHealth(); }
    };
    const environmentBackendIds = (environmentId: string): string[] => [...new Set(
      configurationRepository.get(scope).configuration.targets.filter(target => target.executionEnvironmentId === environmentId)
        .map(target => target.backendInstanceId))];
    const recoverLifecycleReceipt: NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]> = async (candidate, input) => {
      assertManagementScope(candidate);
      const {request, result} = input;
      if (request.resourceKind === "backend") {
        if (!backendHasRemoteProvider(request.resourceId) || !["stop", "restart"].includes(request.action)) return undefined;
        try {
          const administration = await recoverBackendAdministration(request.resourceId);
          const observation = administration ? await administration.inspect() : undefined;
          if (request.action === "stop" ? observation !== undefined : !observation || observation.incarnation === request.expectedIncarnation || observation.state === "unknown") return undefined;
          if (observation) observedBackends.set(request.resourceId, observation);
          const runtime = (await captureAdministrativeResource(result.runtime, false)).runtime;
          return {...result, state: "applied", runtime: {...runtime, effectiveRevision: result.runtime.desiredRevision,
            applyState: "applied", lastError: null, ...(!observation ? {connectionState: "stopped", incarnation: null, activeResources: 0} : {})}};
        } catch { return undefined; }
      }
      const owner = environmentRuntimes.get(request.resourceId)?.sidecarRuntime;
      if (!owner) return undefined;
      const settledRuntime = async () => {
        const runtime = (await captureAdministrativeResource(result.runtime, false)).runtime;
        return {...runtime, effectiveRevision: result.runtime.desiredRevision, applyState: "applied" as const, lastError: null};
      };
      if (!["stop", "restart", "upgrade"].includes(request.action)) {
        // Connect, start and disconnect leave no remote receipt; the current
        // attachment state is their entire outcome.
        try {
          const service = await owner.inspectService(managementSignal());
          observedServices.set(request.resourceId, service ?? null);
          observationFailures.delete(`environment:${request.resourceId}`);
          const attached = Boolean(service?.attached);
          if (request.action === "disconnect" ? attached : !attached) {
            const runtime = (await captureAdministrativeResource(result.runtime, false)).runtime;
            return {...result, state: "unavailable", runtime: {...runtime, lastError: runtime.lastError ?? "The connection command did not complete. Select the action again."}};
          }
          return {...result, state: "applied", runtime: await settledRuntime()};
        } catch { return undefined; }
      }
      try {
        let receipt = await owner.inspectServiceReceipt(request.mutationId, managementSignal());
        if (!receipt) {
          // The command was never admitted remotely. An unchanged confirmed
          // service proves nothing happened; a reached end state settles it.
          const service = await owner.inspectService(managementSignal());
          observedServices.set(request.resourceId, service ?? null);
          observationFailures.delete(`environment:${request.resourceId}`);
          if (request.action === "stop" ? !service || service.state === "stopped" : service && service.serviceIncarnation !== request.expectedIncarnation &&
            service.state === "ready" && service.configurationState === "applied" && service.artifactSha256 === owner.artifact.artifactSha256) {
            return {...result, state: "applied", runtime: {...await settledRuntime(), ...(request.action === "stop" && !service ? {connectionState: "stopped", incarnation: null, activeResources: 0} : {})}};
          }
          if (!service || service.serviceIncarnation !== request.expectedIncarnation || service.state !== "ready") return undefined;
          // Request bytes may still be in flight for a short while after the
          // acknowledgement was lost, and the service admits them whenever
          // they land. After repeated null observations the mutation id is
          // withdrawn remotely: a late arrival is then refused, so "nothing
          // changed" is truthful. An admission that raced ahead is returned
          // instead and settles like any other receipt.
          const firstSeen = unadmittedSince.get(request.mutationId) ?? Date.now();
          unadmittedSince.set(request.mutationId, firstSeen);
          if (Date.now() - firstSeen < 60_000) return undefined;
          receipt = await owner.withdrawServiceReceipt(request.mutationId, service.serviceIncarnation, managementSignal());
          unadmittedSince.delete(request.mutationId);
          if (!receipt) return undefined;
        }
        if (receipt.serviceIncarnation !== request.expectedIncarnation) return undefined;
        // A definite refusal finishes this command even if a later status
        // probe fails. Handoff requires a fresh action after result recovery;
        // the old mutation will never resume merely by polling its receipt.
        if (receipt.state === "withdrawn" || receipt.state === "failed" || receipt.state === "handoff_pending") return {...result, state: "rejected", runtime: {
          ...(receipt.state === "withdrawn" ? (await captureAdministrativeResource(result.runtime, false)).runtime : result.runtime),
          lastError: receipt.state === "withdrawn"
            ? `The ${request.action} command never reached the sidecar; nothing changed. Select the action again.`
            : receipt.state === "handoff_pending"
            ? "The sidecar requires final history or operation outcomes to be recovered before stopping. Recover retained work, then retry the lifecycle action."
            : receipt.code === "sidecar_management_requester_gone"
            ? `The connection was lost before the sidecar acted on the ${request.action} command; nothing changed. Select the action again.`
            : `The sidecar rejected the ${request.action} operation (${receipt.code ?? "sidecar_management_failed"}). Inspect its current state before retrying.`}};
        const service = await owner.inspectService(managementSignal());
        observedServices.set(request.resourceId, service ?? null);
        observationFailures.delete(`environment:${request.resourceId}`);
        const runtime = (await captureAdministrativeResource(result.runtime, false)).runtime;
        if (receipt.state !== "completed") return undefined;
        if (request.action !== "stop" && (!service || service.serviceIncarnation === request.expectedIncarnation || service.state !== "ready" || service.configurationState !== "applied" || service.artifactSha256 !== owner.artifact.artifactSha256)) return undefined;
        return {...result, state: "applied", runtime: {...runtime,
          effectiveRevision: result.runtime.desiredRevision, applyState: "applied", lastError: null,
          ...(request.action === "stop" && !service ? {connectionState: "stopped", incarnation: null, activeResources: 0} : {}),
        }};
      } catch { return undefined; }
    };
    const configurationRuntime: ConfigurationRuntimeAdapter = {
      recoverLifecycle(candidate, input) { return serializeConfiguration(() => recoverLifecycleReceipt(candidate, input)); },
      async observe(candidate, snapshot) {
        assertManagementScope(candidate);
        return Promise.all(snapshot.runtimes.map(async record => (await captureAdministrativeResource(record, false)).runtime));
      },
      async reconcile(candidate) { assertManagementScope(candidate); outboundConnections.refresh(candidate); await serializeConfiguration(reconcileLiveConfiguration); },
      async commitConfiguration(candidate, previous, next, commit) {
        assertManagementScope(candidate);
        return serializeConfiguration(() => commitWithConfigurationRemovalGuard({
          previous: previous.configuration, next, commit,
          async withBackendStopped(id, callback) {
            const admission = registry.suspend(scope, id);
            try {
              await admission.drained;
              if (moduleRuntimes.has(id) || (await backendThreads(id)).length > 0) throw new DomainError("conflict", "Stop the backend and recover retained outcomes before removing its definition or target.");
              if (backendHasRemoteProvider(id) && await recoverBackendAdministration(id)) throw new DomainError("conflict", "The remote backend still owns resources. Stop it and recover retained outcomes before removal.");
              return await callback();
            } catch (error) {
              if (error instanceof DomainError) throw error;
              throw new DomainError("conflict", "Backend shutdown could not be confirmed. Keep its definition until the execution host is reachable and retained work is recovered.");
            } finally { admission.release(); }
          },
          async withEnvironmentStopped(id, callback) {
            try {
              return await terminalService.runWithEnvironmentRetired(scope, id, async () => {
                const owner = environmentRuntimes.get(id)?.sidecarRuntime;
                const definition = previous.configuration.executionEnvironments.find(item => item.id === id);
                const revokedOutbound = definition?.kind === "outbound" && hostPairings.getPairing(scope, definition.pairingId).state === "revoked";
                // Revocation has already removed remote authority. Removing
                // the desired definition retains history and is not a remote
                // cleanup claim; existing main-side resource guards still run.
                if (definition && definition.kind !== "local" && !revokedOutbound) {
                  if (!owner) throw new DomainError("conflict", "Execution host shutdown cannot be confirmed. Restore its runtime configuration before removal.");
                  const service = await owner.inspectService(managementSignal());
                  if (service && service.state !== "stopped") throw new DomainError("conflict", "Stop the execution service and recover retained work before removing this environment.");
                }
                return await callback();
              });
            } catch (error) {
              if (error instanceof DomainError) throw error;
              throw new DomainError("conflict", error instanceof TerminalServiceError ? error.message : "Execution host shutdown could not be confirmed. Keep its definition until retained work is recovered.");
            }
          },
        }));
      },
      async impact(candidate, _request, record) {
        assertManagementScope(candidate);
        return serializeConfiguration(() => captureAdministrativeResource(record, true));
      },
      async execute(candidate, input) {
        assertManagementScope(candidate);
        return serializeConfiguration(async () => {
          const {request} = input;
          const evidence = await captureAdministrativeResource(input.runtime, true, false);
          const result = (state: "applied" | "rejected" | "unavailable" | "unknown", runtime = evidence.runtime) => ({mutationId: request.mutationId, state, runtime});
          if (request.expectedIncarnation !== evidence.runtime.incarnation ||
            (input.expectedFence !== null && input.expectedFence !== evidence.fence)) {
            return result("rejected", {...evidence.runtime, lastError: "Resource state changed. Inspect the current impact and confirm a new action."});
          }
          const id = request.resourceId;
          const key = `${request.resourceKind}:${id}`;
          // A receipt must describe the command that was admitted even when a
          // later save or command has already advanced the live runtime record.
          const admitted = (): ConfigurationRuntimeState => ({...configurationRepository.runtime(scope, request.resourceKind, id),
            desiredRevision: input.runtime.desiredRevision, preference: input.runtime.preference});
          if (evidence.runtime.connectionState === "recovery_required" && request.action !== "disconnect") return result("unavailable");
          if (["stop", "restart", "upgrade"].includes(request.action) && observationFailures.has(key)) return result("unavailable");
          const receiptOwner = request.resourceKind === "environment" ? environmentRuntimes.get(id)?.sidecarRuntime : undefined;
          const priorFence = await fencePriorLifecycleForStop({
            request, pending: configurationRepository.pendingLifecycle(scope),
            priorHasRemoteExecutor: request.resourceKind === "backend" ? backendHasRemoteProvider(id) :
              configurationRepository.get(scope).configuration.executionEnvironments.some(environment => environment.id === id && environment.kind !== "local"),
            ...(receiptOwner ? { management: {
              inspectServiceReceipt: mutationId => receiptOwner.inspectServiceReceipt(mutationId, managementSignal()),
              withdrawServiceReceipt: (mutationId, incarnation) => receiptOwner.withdrawServiceReceipt(mutationId, incarnation, managementSignal()),
              inspectService: () => receiptOwner.inspectService(managementSignal()),
            } } : {}),
            recover: previous => recoverLifecycleReceipt(scope, previous),
            complete: (previous, settled) => { configurationRepository.completeLifecycle(scope, previous.request, settled); },
          });
          if (!priorFence.allowed) return result("rejected", {...evidence.runtime, lastError: priorFence.message});
          let effectConfirmed = false;
          if (request.resourceKind === "environment") {
            const owner = environmentRuntimes.get(id)?.sidecarRuntime;
            if (!owner) return result("unavailable");
            // Reconciliation may have replaced the owner with the saved revision;
            // always attach through the current one.
            const attach = async (): Promise<{refused: "rejected" | "unavailable" | undefined; runtime: ConfigurationRuntimeState}> => {
              const current = environmentRuntimes.get(id)?.sidecarRuntime;
              if (!current) return {refused: "unavailable", runtime: (await captureAdministrativeResource(admitted(), false)).runtime};
              try {
                observedServices.set(id, await current.connect(lifecycleSignal()));
                attachmentBlocks.delete(id);
                observationFailures.delete(key);
                await terminalService.reconcileRemote(scope, id);
                return {refused: undefined, runtime: (await captureAdministrativeResource(admitted(), false)).runtime};
              } catch (error) {
                reportBackgroundError(`Execution environment ${id} attachment (${request.action})`)(error);
                const code = requiresOwnershipRecovery(error) ? undefined : sidecarReportedCode(error);
                if (code) {
                  attachmentBlocks.set(id, code);
                  try { observedServices.set(id, await current.inspectService(managementSignal()) ?? null); observationFailures.delete(key); }
                  catch (probe) { observationFailures.set(key, observationFailure(probe)); }
                } else observationFailures.set(key, observationFailure(error));
                const runtime = (await captureAdministrativeResource(admitted(), false)).runtime;
                return {refused: code && !observationFailures.has(key) ? "rejected" : "unavailable", runtime};
              }
            };
            if (request.action === "connect" || request.action === "start") {
              await reconcileLiveConfiguration();
              const attached = await attach();
              if (attached.refused) return result(attached.refused, attached.runtime);
              effectConfirmed = true;
            } else if (request.action === "disconnect") {
              await terminalService.detachEnvironment(scope, id);
              await owner.disconnect();
              attachmentBlocks.delete(id);
              effectConfirmed = true;
            } else {
              const service = evidence.service;
              if (!service) {
                await stopBackends(environmentBackendIds(id), async () => undefined);
                if (request.action !== "stop") {
                  await reconcileLiveConfiguration();
                  const attached = await attach();
                  if (attached.refused) return result(attached.refused, attached.runtime);
                } else observedServices.set(id, null);
                effectConfirmed = true;
              } else {
                try {
                  const status = await owner.controlService({operation: request.action as "stop" | "restart" | "upgrade", mutationId: request.mutationId,
                    expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch: service.controllerEpoch,
                    expectedConfiguration: service.desiredConfiguration, expectedResourcesFingerprint: service.resourcesFingerprint,
                    force: true}, lifecycleSignal(), async effect => {
                      await terminalService.detachEnvironment(scope, id);
                      return stopBackends(environmentBackendIds(id), effect);
                    });
                  observedServices.set(id, status ?? null);
                  attachmentBlocks.delete(id);
                } catch (error) {
                  if (error instanceof SidecarServiceStagingError) {
                    return result("unavailable", {...evidence.runtime, lastError:
                      "The new sidecar could not be staged. No shutdown command was sent; the existing service was left in place. Retry the upgrade after checking the remote installation."});
                  }
                  let status = error instanceof SidecarServiceManagementError ? error.status : undefined;
                  if (!status) {
                    try { status = await owner.inspectService(managementSignal()); }
                    catch {
                      if (!(error instanceof SidecarServiceManagementError && error.outcome === "rejected")) throw error;
                    }
                  }
                  observedServices.set(id, status ?? null);
                  if (error instanceof SidecarServiceManagementError && error.code === "sidecar_service_confirmation_stale") {
                    return result("rejected", {...evidence.runtime, lastError: "Resource state changed during confirmation. Local conversation connections were closed; remote work may still be running. Refresh the current impact before trying again."});
                  }
                  if (status?.state === "handoff_pending") {
                    try { await terminalService.reconcileRemote(scope, id, {recoveryOnly: true}); }
                    catch { return result("rejected", {...evidence.runtime, lastError: "Final history or operation outcomes could not be recovered. Recover retained work, then retry the lifecycle action."}); }
                    return result("rejected", {...evidence.runtime, lastError: "Final terminal history was recovered. Inspect retained operation outcomes and confirm a new lifecycle action."});
                  }
                  if (error instanceof SidecarServiceManagementError && error.outcome === "rejected") {
                    return result("rejected", {...evidence.runtime, lastError:
                      status?.state === "cleanup_unproven" ? "The sidecar could not finish stopping its owned resources. Cleanup remains unconfirmed." :
                      `The sidecar rejected the ${request.action} operation (${error.code}). Local conversation connections were closed; refresh the host status before retrying.`});
                  }
                  throw error;
                }
                effectConfirmed = true;
                if (request.action !== "stop") {
                  // The old service is gone, so a pending saved revision can now
                  // replace the owner before the replacement service attaches.
                  await reconcileLiveConfiguration();
                  const attached = await attach();
                  if (attached.refused) return result("applied", attached.runtime);
                }
              }
            }
          } else {
            if (request.action === "disconnect") await detachBackend(id);
            else if (request.action === "stop" || request.action === "restart") {
              try {
                await stopBackends([id], async () => {
                  if (evidence.administration && evidence.backendObservation) {
                    await evidence.administration.stop({expectedRevision: evidence.backendObservation.revision, force: true});
                  }
                });
              } catch (error) {
                if (!(error instanceof BackendRuntimeControlRejectedError)) throw error;
                reportBackgroundError(`Backend ${id} lifecycle ${request.action}`)(error);
                const after = await captureAdministrativeResource(admitted(), false, false);
                const reason = error.reason === "confirmation_stale"
                  ? "Resource state changed during confirmation."
                  : error.reason === "cleanup_unproven"
                    ? "The provider could not confirm cleanup of its owned resources."
                    : "The provider refused shutdown because retained work still blocks it.";
                return result("rejected", {...after.runtime, lastError:
                  `${reason} Local conversation connections were closed; remote work may still be running. Refresh the current impact and retry Stop.`});
              }
              backendPresence.set(id, false);
            }
            if (["connect", "start", "restart"].includes(request.action)) await applyBackendRuntime(id);
          }
          if (request.resourceKind === "environment" && appliedEnvironmentFingerprints.get(id) === environmentRuntimeFingerprint(id)) {
            appliedEnvironmentRevisions.set(id, configurationRepository.runtime(scope, "environment", id).desiredRevision);
          }
          if (!effectConfirmed) observationFailures.delete(key);
          const after = await captureAdministrativeResource(admitted(), true);
          await activeApplicationSnapshots.publishAuthoritativeReplacement(scope);
          // A confirmed remote effect is applied even when a later probe fails;
          // the runtime projection carries that probe's own outcome.
          return result(!effectConfirmed && after.runtime.applyState === "unavailable" ? "unavailable" : "applied", after.runtime);
        });
      },
    };
    const configurationAdmin = new ConfigurationAdminService(configurationRepository, {
      authorize: assertManagementScope, projection: configurationProjection, runtime: configurationRuntime,
      onLifecycleError: (error, operation) => reportBackgroundError(
        `Lifecycle ${operation.action} ${operation.resourceKind} ${operation.resourceId} (${operation.mutationId})`)(error),
      authorizeSecretReference: candidate => assertManagementScope(candidate),
    });
    const applyPairingMutation = async <Result>(candidate: RequestScope, commit: () => Result): Promise<Result> => {
      assertManagementScope(candidate);
      return await serializeConfiguration(async () => {
        const result = commit();
        // Association decisions are already durable. Fence carriers immediately;
        // a failed runtime application must not turn acceptance into a failure.
        outboundConnections.refresh(candidate);
        try { await reconcileLiveConfiguration(); }
        catch (error) { reportBackgroundError("Outbound host reconciliation")(error); }
        return result;
      });
    };
    const hostPairingAdmin: HostPairingAdministration = {
      async list(candidate) {
        assertManagementScope(candidate);
        const result = hostPairings.list(candidate);
        const observed = <T extends {connectorId: string; lastSeenAt: string}>(record: T) => {
          const presence = outboundConnections.presence(candidate, record.connectorId);
          return {...record, connected: presence.connected, lastSeenAt: presence.lastSeenAt ?? record.lastSeenAt};
        };
        return {registrations: result.registrations.map(observed), pairings: result.pairings.map(observed)};
      },
      accept: (candidate, request) => applyPairingMutation(candidate, () => hostPairings.accept(candidate, request)),
      async deny(candidate, request) {
        assertManagementScope(candidate);
        const result = hostPairings.deny(candidate, request);
        outboundConnections.refresh(candidate);
        return result;
      },
      revoke: (candidate, request) => applyPairingMutation(candidate, () => {
        const result = hostPairings.revoke(candidate, request);
        authentication.revokeConnector(result.pairing.connectorId);
        return result;
      }),
      reapprove: (candidate, request) => applyPairingMutation(candidate, () => hostPairings.reapprove(candidate, request)),
    };
    const unsubscribeOutboundReconciliation = outboundConnections.subscribe(event => {
      if (event.scope.tenantId !== scope.tenantId || event.scope.principalId !== scope.principalId ||
        !event.connected || !event.environmentId || drain.isDraining) return;
      void serializeConfiguration(reconcileLiveConfiguration).catch(reportBackgroundError("Outbound host connected"));
    });
    resources.defer("outbound configuration subscription", unsubscribeOutboundReconciliation);
    const configurationOperationRecovery = new ConfigurationOperationRecoveryService({
      authorize: assertManagementScope,
      kinds(candidate, environmentId) {
        assertManagementScope(candidate);
        const definition = configurationRepository.get(candidate).configuration.executionEnvironments.find(item => item.id === environmentId);
        if (!definition || definition.kind === "local") throw new DomainError("not_found", "Remote operation recovery is unavailable in this environment.");
        // Retained outcomes remain recoverable after their normal capability is removed.
        return ["file", "workspace", "shell"];
      },
      async acquire(candidate, environmentId) {
        assertManagementScope(candidate);
        const owner = environmentRuntimes.get(environmentId)?.sidecarRuntime;
        if (!owner) throw new DomainError("runtime_unavailable", "The execution host is unavailable for operation recovery.", true);
        const lease = await owner.acquireRecovery(candidate, environmentId, managementSignal(), [
          {capabilityId: "workspace_files", majorVersion: 8},
          {capabilityId: "workspace_tools", majorVersion: 2},
          {capabilityId: "workspace_context", majorVersion: 1},
        ]);
        return {client: new SidecarOperationRecoveryClient(lease.session),
          serviceIncarnation: lease.serviceStatus.serviceIncarnation, release: () => lease.release()};
      },
    });
    let maintenanceRunning = false;
    let lifecycleRecoveryOffset = 0;
    const maintenanceTimer = setInterval(() => {
      if (maintenanceRunning || managementAbort.signal.aborted) return;
      maintenanceRunning = true;
      void serializeConfiguration(async () => {
        await reconcileLiveConfiguration();
        await Promise.all(configurationRepository.get(scope).runtimes.map(async record => {
          const key = `${record.resourceKind}:${record.resourceId}`;
          const owner = record.resourceKind === "environment" ? environmentRuntimes.get(record.resourceId)?.sidecarRuntime : undefined;
          if (record.preference !== "automatic") {
            // Intentional stop/disconnect suppresses attachment, not observation:
            // the service's own status still proves that preference holds.
            if (!owner) return;
            try { observedServices.set(record.resourceId, await owner.inspectService(managementSignal()) ?? null); observationFailures.delete(key); }
            catch (error) { observationFailures.set(key, observationFailure(error)); }
            configurationRepository.observe(scope, (await captureAdministrativeResource(record, false)).runtime);
            return;
          }
          if (owner) {
            try {
              // Owner admission performs an idle-only upgrade using authoritative service blockers.
              observedServices.set(record.resourceId, await owner.connect(maintenanceSignal()));
              attachmentBlocks.delete(record.resourceId);
              await terminalService.reconcileRemote(scope, record.resourceId);
              observationFailures.delete(key);
            } catch (error) {
              const code = requiresOwnershipRecovery(error) ? undefined : sidecarReportedCode(error);
              // A sleeping or disconnected outbound host is expected; its
              // offline state is already exposed by the administration view.
              if (code !== "sidecar_transport_unavailable") {
                reportBackgroundError(`Execution environment ${record.resourceId} attachment (automatic)`)(error);
              }
              if (code) {
                attachmentBlocks.set(record.resourceId, code);
                try { observedServices.set(record.resourceId, await owner.inspectService(managementSignal()) ?? null); observationFailures.delete(key); }
                catch (probe) { observationFailures.set(key, observationFailure(probe)); }
              } else observationFailures.set(key, observationFailure(error));
            }
          }
          configurationRepository.observe(scope, (await captureAdministrativeResource(record, false)).runtime);
        }));
        const pending = configurationRepository.pendingLifecycle(scope).filter(entry => entry.result.runtime.preference === "automatic");
        const start = pending.length === 0 ? 0 : lifecycleRecoveryOffset % pending.length;
        const selected = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 8);
        lifecycleRecoveryOffset = start + selected.length;
        await Promise.all(selected.map(async entry => {
          const recovered = await recoverLifecycleReceipt(scope, entry);
          if (recovered) configurationRepository.completeLifecycle(scope, entry.request, recovered);
        }));
      }).catch(reportBackgroundError("Execution configuration maintenance")).finally(() => { maintenanceRunning = false; });
    }, 30_000);
    maintenanceTimer.unref();
    resources.defer("execution configuration maintenance", async () => {
      clearInterval(maintenanceTimer); managementAbort.abort(); await configurationTail; await configurationAdmin.settleLifecycleOperations();
    }, {mode: "ownership_critical"});
    const terminalAdmissions = new TerminalAdmissionTokens(terminalService);
    // HTTP transport closure can destroy a client socket while its async route
    // handler continues committing durable state. Drain those handler promises
    // before any service producer, runtime, publication boundary, or SQLite.
    resources.defer(
      "HTTP request operations",
      () => requestOperations.close(),
      {
        mode: "ownership_critical",
      },
    );
    const app = createNormalizedApp({
      usage,
      environmentVariables,
      authentication,
      hostPairingAdmin,
      outboundArtifact: sidecarArtifact,
      outboundConnectorDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/connector"),
      configurationAdmin,
      configurationOperationRecovery,
      workpads,
      tasks,
      workspaceFiles,
      workspaceDiffReviews,
      config,
      csrfToken,
      identity,
      executionTargets,
      savedAgents,
      threadTemplates,
      applicationSnapshots: activeApplicationSnapshots,
      principalPreferences,
      notifications,
      questions,
      cannedPrompts,
      threads,
      history,
      threadRuntimes: runtimes,
      threadSnapshots: activeThreadSnapshots,
      lifecycle,
      inventory,
      turnBookmarks,
      threadGroups,
      threadArchives,
      threadBulkInventory,
      threadExecutionWorkspaces: piSandboxLifecycle,
      threadForceResets,
      attention,
      execution,
      automations,
      automationPrechecks,
      agentTools: {
        sources: agentToolApplication,
        tools: httpAgentTools,
        clients: principalClientAgentTools,
      },
      drain,
      requestOperations,
      longLivedConnections,
      managedTerminalAdmissions,
      terminals: {
        service: terminalService,
        admissions: terminalAdmissions,
      },
      composerAttachments,
      outputArtifacts,
      lineage: forks,
      discoverWorkspace: discoverOpenedWorkspace,
      clientDirectory: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../client",
      ),
    });
    const listeningServer = app.listen(config.port, config.host);
    server = listeningServer;
    resources.defer(
      "HTTP server",
      () => closeHttpServerBounded(server, longLivedConnections),
      { deadlineMilliseconds: 12_000 },
    );
    const outboundCarrier = attachOutboundCarrier(listeningServer, {
      authentication,
      config, identity, registry: outboundConnections, connections: longLivedConnections, drain,
    });
    resources.defer("outbound host carrier", () => outboundCarrier.close());
    const managedTerminalCarrier = attachManagedTerminalCarrier(
      listeningServer,
      {
        authentication,
        config,
        identity,
        admissions: managedTerminalAdmissions,
        authority: managedTerminalAuthority,
        connections: longLivedConnections,
        drain,
      },
    );
    // Registered after HTTP so LIFO shutdown first rejects new upgrades and
    // closes upgraded viewers, then drains SSE and ordinary HTTP sockets.
    resources.defer("managed terminal carrier", () =>
      managedTerminalCarrier.close(),
    );
    const terminalCarrier = attachTerminalCarrier(listeningServer, {
      authentication,
      config,
      identity,
      admissions: terminalAdmissions,
      service: terminalService,
      connections: longLivedConnections,
      drain,
    });
    resources.defer("application terminal carrier", () =>
      terminalCarrier.close(),
    );
    await new Promise<void>((resolve, reject) => {
      listeningServer.once("listening", resolve);
      listeningServer.once("error", reject);
    });
    const listeningAddress = listeningServer.address();
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("production_listening_address_invalid");
    }
    const listening = Object.freeze({
      host: config.host,
      port: listeningAddress.port,
    });
    process.stdout.write(
      `Sedes listening on http://${listening.host}:${listening.port}\n`,
    );
    void discoveryOperations
      .admit((signal) => discoverRecentWorkspaces(signal))
      ?.catch(reportBackgroundError("Startup conversation discovery"));
    let closePromise: Promise<void> | undefined;
    return {
      authenticationRequired: config.authenticationRequired,
      createManagementPairing: () => authenticationRepository.createPairing({ kind: "management" }),
      createManagedLocalPairing: () => authenticationRepository.createPairing({ kind: "management", managedLocal: true }),
      server: listeningServer,
      listening,
      close: () => {
        // A teardown-induced availability transition remains durable for the
        // next bootstrap, but there are no authoritative live clients after
        // drain begins. Stop this producer before the publication boundary is
        // closed so runtime/channel teardown cannot enqueue into a closed SSE
        // generation.
        drain.beginDrain();
        // Stop detached admission at the same boundary as HTTP mutation
        // admission, rather than waiting for the resource stack to reach it.
        void discoveryOperations.close().catch(() => undefined);
        closePromise ??= resources.dispose();
        return closePromise;
      },
    };
  } catch (error) {
    await resources.dispose(error);
    throw error;
  }
}
