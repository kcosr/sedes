import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import {
  COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES,
  composerAttachmentDescriptorSchema,
} from "../../../shared/protocol/composer-attachments.js";
import type {
  BackendConversationEvent,
  BackendConversationSnapshot,
  BackendCapabilityDocument,
  BackendItem,
  BackendTurn,
  SequencedBackendEvent,
} from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import {
  boundDisplayText,
  boundText,
  preserveMessageText,
} from "../../conversations/payload-policy.js";
import type { ExecutionEnvironmentChannelProvider } from "../../execution/environment-channel.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import {
  BackendError,
  stagedComposerAttachmentSchema,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type AttachConversationInput,
  type BackendActionResult,
  type BackendCatalog,
  type BackendCatalogContext,
  type BackendCheckpointRef,
  type BackendHealth,
  type BackendHistoryPage,
  type BackendMutationReconciliation,
  type BranchConversationInput,
  type ConversationBackendDriver,
  type ConversationBinding,
  type ConversationHandle,
  type ConversationReadResult,
  type CanonicalComposerAttachmentEvidence,
  type CreateConversationInput,
  type CreateConversationResult,
  type DiscoverConversationsInput,
  type DiscoveredConversation,
  type DiscoveredConversationPage,
  type EstablishedBackendProjection,
  type EstablishProjectionInput,
  type HistoryPageInput,
  type InteractionResponseInput,
  type InterruptTurnInput,
  type LocateTurnInput,
  type LocateTurnResult,
  type ReadConversationInput,
  type ReconcileSubmissionInput,
  type RegisteredBackendActionInput,
  type ResolveBranchCheckpointInput,
  type SteerTurnInput,
  type SteerTurnResult,
  type SubmissionReconciliation,
  type SubmitTurnInput,
  type SubmitTurnResult,
  type Unsubscribe,
} from "../contracts.js";
import { GROK_ACP_COMPATIBILITY_RELEASE } from "./grok-release-guard.js";
import {
  AcpBindingError,
  AcpDeliveryError,
  AcpRemoteError,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import {
  parseGrokBackendConfiguration,
  type GrokBackendConfigurationInput,
  type GrokConnectionModuleConfiguration,
} from "./grok-backend-configuration.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { AgentToolCliAvailability } from "../module.js";
import {
  GrokAuthenticationRequiredError,
  projectGrokNativeSessionTitle,
  type GrokEffectiveSessionConfiguration,
  type GrokModelCatalog,
} from "./grok-acp-dialect.js";
import {
  parseGrokConversationBindingDetail,
  serializeGrokConversationBindingDetail,
  type GrokConversationBindingDetail,
} from "./grok-conversation-binding.js";
import {
  GrokDiscoverySnapshotStore,
  type GrokDiscoverySnapshotBinding,
} from "./grok-discovery-snapshot-store.js";
import {
  effectiveGrokNativeHome,
  grokNativeNamespaceKey,
} from "./grok-native-namespace.js";
import {
  GrokNormalizedHistoryError,
  grokNormalizedItemId,
  inspectGrokNormalizedHistory,
  locateGrokHistoryTurnWithGeneratedImages,
  projectSelectedGrokHistoryPageWithGeneratedImages,
  projectSelectedGrokLatestHistoryWithGeneratedImages,
  projectGrokLatestHistoryWithGeneratedImages,
  recoverableInterruptedGrokPromptId,
  sanitizeGrokLiveGeneratedImageMarkdown,
} from "./grok-normalized-history.js";
import { GrokNativeHistoryProjectionError } from "./grok-native-history-projection.js";
import { GrokNativeHistoryReadError } from "./grok-native-history-reader.js";
import { writeGrokDeliveryDiagnostic } from "./grok-delivery-diagnostics.js";
import type {
  GrokHistoryRecord,
  GrokHistoryTextRecord,
} from "./grok-history-projector.js";
import { GrokOwnedStdioTransportFactory } from "./grok-owned-stdio-transport.js";
import {
  GrokRuntimeVersionCache,
  resolveGrokWorkspaceRuntimeConfiguration,
  type ResolvedGrokWorkspaceRuntimeConfiguration,
} from "./grok-runtime-config.js";
import {
  admittedGrokRuntimeSupportsImageInput,
  grokRuntimeIncompatibilityCode,
} from "./grok-release-guard.js";
import {
  GrokPromptOutcomeUnknownError,
  GrokSessionLifecycle,
} from "./grok-session-lifecycle.js";
import { GROK_ACP_IMAGE_INPUT_PATH_REGISTERED } from "./grok-acp-connection.js";
import { GrokSessionRegistry } from "./grok-session-registry.js";
import {
  copyGrokSubmissionCorrelationKey,
  grokSubmissionPromptId,
  grokSubmissionPromptIdReadCandidates,
  type GrokSubmissionCorrelationScope,
} from "./grok-submission-correlation.js";
import type { GrokThreadSettingsStore } from "./grok-thread-repository.js";
import type { OutputArtifactPublisher } from "../../output-artifacts/contracts.js";
import type { GrokGeneratedImageProjectionContext } from "./grok-normalized-history.js";
import type { GrokRuntimeAssessmentObservation } from "./grok-runtime-advisories.js";

const MAXIMUM_EVENT_JOURNAL = 128;
const MAXIMUM_RETRY_ANCHOR_BYTES = 4_096;
const GROK_HISTORY_PUBLICATION_INTERVAL_MILLISECONDS = 50;

interface GrokSubmissionEntry {
  readonly reconciliationToken: string;
  readonly fingerprint: string;
  accepted: Promise<SubmitTurnResult>;
  completion: Promise<void>;
  acceptedByProvider: boolean;
  uncertain: boolean;
}

interface GrokInterruptEntry {
  readonly applicationOperationId: string;
  readonly expectedBackendTurnId: string;
  readonly outcome: "pending" | "accepted" | "unknown";
}

interface GrokRenameEntry {
  readonly applicationOperationId: string;
  readonly title: string;
}

export interface GrokConversationDriverInput {
  readonly configuration: GrokBackendConfigurationInput;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly submissionCorrelationKey: Uint8Array;
  readonly agentToolCli: AgentToolCliAvailability;
  readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly agentTools: BackendAgentToolFacade;
  readonly settings: GrokThreadSettingsStore;
  readonly outputArtifacts: OutputArtifactPublisher;
  readonly beginRuntimeAssessmentObservation?: () => GrokRuntimeAssessmentObservation;
  readonly discoverySnapshots?: GrokDiscoverySnapshotStore;
  readonly now?: () => string;
  readonly promptPostTerminalSettlementDeadlineMilliseconds?: number;
}

/**
 * Normalized Grok surface for one exact configured target. Production
 * reachability remains controlled by the compiled module catalog.
 */
export class GrokConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  #startupLaunchAttempted = false;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #executablePath: string | undefined;
  readonly #environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #defaults: GrokConnectionModuleConfiguration["defaults"];
  readonly #agentToolCli: AgentToolCliAvailability;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentTools: BackendAgentToolFacade;
  readonly #settings: GrokThreadSettingsStore;
  readonly #outputArtifacts: OutputArtifactPublisher;
  readonly #beginRuntimeAssessmentObservation:
    (() => GrokRuntimeAssessmentObservation) | undefined;
  readonly #nativeHome: string;
  readonly #submissionCorrelationKey: Uint8Array;
  readonly #nativeNamespaceKey: string;
  readonly #snapshots: GrokDiscoverySnapshotStore;
  readonly #now: () => string;
  readonly #promptPostTerminalSettlementDeadlineMilliseconds:
    number | undefined;
  readonly #handles = new Map<string, GrokConversationHandle | null>();
  readonly #operations = new Set<Promise<void>>();
  readonly #runtimeVersionCache = new GrokRuntimeVersionCache();
  readonly #runtimeImageInputSupport = new WeakMap<
    GrokSessionLifecycle,
    boolean
  >();
  #nextGeneration = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: GrokConversationDriverInput) {
    this.#submissionCorrelationKey = copyGrokSubmissionCorrelationKey(
      input.submissionCorrelationKey,
    );
    const configuration = parseGrokBackendConfiguration(input.configuration);
    const configuredConnection = configuration.connections.find(
      ({ id }) => id === input.connection.templateId,
    );
    if (
      !configuredConnection ||
      input.instance.id !== configuration.backendInstanceId ||
      input.instance.tenantId !== input.connection.tenantId ||
      input.instance.kind !== "grok_build" ||
      input.instance.protocolRelease !== GROK_ACP_COMPATIBILITY_RELEASE ||
      input.connection.kind !== "grok_acp" ||
      input.connection.backendInstanceId !== input.instance.id ||
      input.connection.executionEnvironmentId !==
        configuredConnection.executionEnvironmentId ||
      input.connection.enabled !== configuredConnection.enabled ||
      configuration.executionEnvironmentId !==
        input.environmentChannel.executionEnvironmentId ||
      configuredConnection.executionEnvironmentId !==
        input.environmentChannel.executionEnvironmentId ||
      input.environmentChannel.scope.tenantId !== input.instance.tenantId ||
      input.environmentChannel.scope.principalId !==
        input.connection.ownerPrincipalId
    ) {
      throw new Error("grok_conversation_driver_configuration_invalid");
    }
    this.#startupEnvironmentVariables = input.startupEnvironmentVariables ?? {};
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = Object.freeze({ ...input.instance });
    this.connection = Object.freeze({ ...input.connection });
    this.#executablePath =
      configuration.runtime.connection.channel.executablePath;
    this.#modelPolicy = configuration.modelPolicy;
    this.#defaults = configuredConnection.configuration.defaults;
    this.#agentToolCli = input.agentToolCli;
    this.#agentToolSourceCapabilities = input.agentToolSourceCapabilities;
    this.#agentTools = input.agentTools;
    this.#settings = input.settings;
    this.#outputArtifacts = input.outputArtifacts;
    this.#beginRuntimeAssessmentObservation =
      input.beginRuntimeAssessmentObservation;
    this.#environmentChannel = input.environmentChannel;
    this.#environment = Object.freeze({ ...input.environment });
    this.#nativeHome = effectiveGrokNativeHome(this.#environment);
    this.#nativeNamespaceKey = grokNativeNamespaceKey(
      this.connection.executionEnvironmentId,
      this.#environment,
    );
    this.#snapshots =
      input.discoverySnapshots ?? new GrokDiscoverySnapshotStore();
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#promptPostTerminalSettlementDeadlineMilliseconds =
      input.promptPostTerminalSettlementDeadlineMilliseconds;
  }

  async health(): Promise<BackendHealth> {
    if (!this.instance.enabled || !this.connection.enabled || this.#closed) {
      return {
        available: false,
        checkedAt: this.#now(),
        diagnostic: boundDisplayText("The Grok backend is disabled."),
      };
    }
    const releaseOperation = this.#beginOperation();
    let lifecycle: GrokSessionLifecycle | undefined;
    let healthWorkspace: string | undefined;
    let available = false;
    let diagnostic =
      "The native Grok installation is unavailable or incompatible.";
    try {
      healthWorkspace = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "sedes-grok-health-")),
      );
      lifecycle = await this.#openLifecycleAtPath(healthWorkspace);
      this.#resolveCreationConfiguration(lifecycle.modelCatalog);
      available = true;
    } catch (error) {
      diagnostic =
        error instanceof GrokAuthenticationRequiredError
          ? error.safeMessage
          : diagnostic;
    } finally {
      try {
        await lifecycle?.close("grok_health_complete");
      } catch {
        available = false;
        diagnostic = "The native Grok installation could not be closed safely.";
      }
      if (healthWorkspace) {
        try {
          await rm(healthWorkspace, { force: true, recursive: true });
        } catch {
          available = false;
          diagnostic = "The Grok health workspace could not be removed safely.";
        }
      }
    }
    releaseOperation();
    return available
      ? { available: true, checkedAt: this.#now() }
      : {
          available: false,
          checkedAt: this.#now(),
          diagnostic: boundDisplayText(diagnostic),
        };
  }

  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    this.#assertScope(context.scope);
    this.#assertWorkspace(context.workspace);
    this.#assertOperational();
    const releaseOperation = this.#beginOperation();
    let lifecycle: GrokSessionLifecycle | undefined;
    let result: BackendCatalog | undefined;
    let failure: unknown;
    try {
      lifecycle = await this.#openLifecycle(context.workspace);
      result = {
        models: this.#projectCatalog(
          lifecycle.modelCatalog,
          this.#runtimeImageInputSupport.get(lifecycle) === true,
        ),
        commands: [],
        skills: [],
        notices: [],
      };
    } catch (error) {
      failure = mapReadError(error, "The Grok model catalog is unavailable.");
    }
    try {
      await lifecycle?.close("grok_catalog_complete");
    } catch (error) {
      failure ??= mapReadError(error, "Grok catalog cleanup failed.");
    }
    releaseOperation();
    if (failure !== undefined) throw failure;
    return result!;
  }

  async discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertOperational();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw grokError(
        "rejected",
        "The requested Grok discovery page size is invalid.",
        "grok_discovery_page_limit_invalid",
      );
    }
    const releaseOperation = this.#beginOperation();
    try {
      throwIfAborted(input.signal);
      const binding = this.#discoveryBinding(input.workspace);
      if (input.cursor) {
        return this.#snapshots.continuePage({
          binding,
          cursor: input.cursor,
          pageSize: input.limit,
        });
      }
      let lifecycle: GrokSessionLifecycle | undefined;
      let result: DiscoveredConversationPage | undefined;
      let failure: unknown;
      try {
        lifecycle = await this.#openLifecycle(input.workspace, input.signal);
        const sessions = await lifecycle.listSessions({ signal: input.signal });
        throwIfAborted(input.signal);
        const conversations: DiscoveredConversation[] = sessions.map(
          (session) => {
            const updatedAt = normalizedTimestamp(session.updatedAt);
            return Object.freeze({
              backendConversationId: session.sessionId,
              canonicalWorkspacePath: input.workspace.canonicalPath,
              ...(session.title
                ? { title: boundDisplayText(session.title).text }
                : {}),
              updatedAt,
              opaqueBindingDetail: this.#bindingDetail(
                session.sessionId,
                input.workspace,
              ),
            });
          },
        );
        result = this.#snapshots.createFirstPage({
          binding,
          conversations,
          pageSize: input.limit,
        });
      } catch (error) {
        failure = input.signal.aborted
          ? input.signal.reason
          : mapReadError(error, "Grok conversation discovery is unavailable.");
      }
      try {
        await lifecycle?.close("grok_discovery_complete");
      } catch (error) {
        const cleanupFailure = mapReadError(
          error,
          "Grok discovery process cleanup failed.",
        );
        failure =
          failure === undefined
            ? cleanupFailure
            : grokError(
                "unavailable",
                "Grok discovery failed and its owned process could not be cleaned up safely.",
                "grok_discovery_cleanup_failed",
                true,
                new AggregateError([failure, cleanupFailure]),
              );
      }
      if (failure !== undefined) throw failure;
      return result!;
    } finally {
      releaseOperation();
    }
  }

  async create(
    input: CreateConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertOperational();
    if (
      input.requestedBackendConversationId !== undefined ||
      !bounded(input.creationCorrelation, 1_024) ||
      !bounded(input.applicationOperationId, 1_024) ||
      !bounded(input.applicationThreadId, 1_024)
    ) {
      throw grokError(
        "rejected",
        "Grok creation requires provider-assigned identity and one durable correlation.",
        "grok_create_identity_invalid",
      );
    }
    const releaseOperation = this.#beginOperation();
    let lifecycle: GrokSessionLifecycle | undefined;
    let providerContacted = false;
    let providerCreated = false;
    let result: CreateConversationResult | undefined;
    let failure: BackendError | undefined;
    try {
      lifecycle = await this.#openLifecycle(input.workspace, undefined, undefined, input.applicationThreadId);
      providerContacted = true;
      const requestedConfiguration = this.#desiredConfiguration(
        input.applicationThreadId,
        lifecycle.modelCatalog,
      );
      const created = await lifecycle.newSession({
        configuration: requestedConfiguration,
      });
      providerCreated = true;
      this.#assertEffectiveConfiguration(
        lifecycle.modelCatalog,
        created.configuration,
      );
      const effectiveEffort = created.configuration.reasoningEffort;
      if (
        !effectiveEffort ||
        created.configuration.modelId !== requestedConfiguration.modelId ||
        effectiveEffort !== requestedConfiguration.reasoningEffort
      ) {
        throw modelConfigurationUnavailable();
      }
      this.#settings.confirmEffective(
        this.#threadScope(),
        input.applicationThreadId,
        {
          model: created.configuration.modelId,
          effort: effectiveEffort,
          now: Date.now(),
        },
      );
      await lifecycle.closeSession(created.state.sessionId);
      result = Object.freeze({
        backendConversationId: created.state.sessionId,
        reconciliationToken: stableToken("create", [
          input.applicationOperationId,
          input.creationCorrelation,
          created.state.sessionId,
        ]),
        opaqueBindingDetail: this.#bindingDetail(
          created.state.sessionId,
          input.workspace,
        ),
      });
    } catch (error) {
      failure = mapCreateError(error, providerCreated, providerContacted);
    }
    try {
      await lifecycle?.close("grok_create_complete");
    } catch (error) {
      const cleanupFailure = mapCreateError(
        error,
        providerCreated,
        providerContacted,
      );
      const outcomeUnknown =
        providerCreated ||
        failure?.crossedSubmissionBoundary === true ||
        cleanupFailure.crossedSubmissionBoundary;
      failure = failure
        ? grokError(
            outcomeUnknown ? "submission_unknown" : "unavailable",
            outcomeUnknown
              ? "Grok created or may have created a session and its owned process could not be cleaned up safely."
              : "Grok creation failed and its owned process could not be cleaned up safely.",
            "grok_create_cleanup_failed",
            !outcomeUnknown,
            new AggregateError([failure, cleanupFailure]),
            outcomeUnknown,
          )
        : cleanupFailure;
    }
    try {
      if (failure) throw failure;
      return result!;
    } finally {
      releaseOperation();
    }
  }

  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    const detail = this.#assertConversationInput(input);
    this.#assertOperational();
    const ownershipKey = this.#ownershipKey(detail);
    if (this.#handles.has(ownershipKey)) {
      throw grokError(
        "invalid_state",
        "This Grok conversation is already attached.",
        "grok_conversation_already_attached",
      );
    }
    const releaseOperation = this.#beginOperation();
    // Claim synchronously before process acquisition so concurrent attaches
    // cannot race two native processes onto one provider session.
    this.#handles.set(ownershipKey, null);
    let lifecycle: GrokSessionLifecycle | undefined;
    let handle: GrokConversationHandle | undefined;
    let pendingHistoryChange = false;
    try {
      lifecycle = await this.#openLifecycle(
        input.workspace,
        undefined,
        (record) => {
          if (handle) handle.providerHistoryRecordChanged(record);
          else pendingHistoryChange = true;
        },
        input.binding.applicationThreadId,
        async () => {
          if (handle) await handle.providerHistoryChanged();
          else pendingHistoryChange = true;
        },
      );
      const loaded = await lifecycle.loadSession(detail.sessionId);
      this.#assertEffectiveConfiguration(
        lifecycle.modelCatalog,
        loaded.configuration,
      );
      const effectiveEffort = loaded.configuration.reasoningEffort;
      if (!effectiveEffort) throw modelConfigurationUnavailable();
      this.#settings.confirmEffective(
        this.#threadScope(),
        input.binding.applicationThreadId,
        {
          model: loaded.configuration.modelId,
          effort: effectiveEffort,
          now: Date.now(),
        },
      );
      const submissionCorrelation = this.#submissionCorrelationScope(detail);
      const generatedImages: GrokGeneratedImageProjectionContext = {
        scope: this.#threadScope(),
        applicationThreadId: input.binding.applicationThreadId,
        outputArtifacts: this.#outputArtifacts,
        authority: {
          nativeHome: this.#nativeHome,
          canonicalWorkspacePath: detail.canonicalWorkspacePath,
          sessionId: detail.sessionId,
        },
      };
      const interruptedPromptId = recoverableInterruptedGrokPromptId(
        loaded.history,
        submissionCorrelation,
      );
      const attachedHistory = interruptedPromptId
        ? await lifecycle.recoverInterruptedSedesPrompt(
            detail.sessionId,
            interruptedPromptId,
          )
        : loaded.history;
      const initialProjection =
        await projectGrokLatestHistoryWithGeneratedImages(
          attachedHistory,
          submissionCorrelation,
          generatedImages,
        );
      handle = new GrokConversationHandle({
        binding: input.binding,
        lifecycle,
        sessionId: detail.sessionId,
        submissionCorrelation,
        initialSnapshot: initialProjection.snapshot,
        settings: this.#settings,
        modelPolicy: this.#modelPolicy,
        effectiveConfiguration: loaded.configuration,
        runtimeSupportsImageInput:
          this.#runtimeImageInputSupport.get(lifecycle) === true,
        generatedImages,
        onClosed: () => {
          if (this.#handles.get(ownershipKey) === handle) {
            this.#handles.delete(ownershipKey);
          }
        },
      });
      if (pendingHistoryChange) await handle.providerHistoryChanged();
      this.#assertOperational();
      this.#handles.set(ownershipKey, handle);
      return handle;
    } catch (error) {
      this.#handles.delete(ownershipKey);
      const mapped = mapReadError(
        error,
        "Grok could not load this conversation.",
      );
      try {
        await lifecycle?.close("grok_attach_failed");
      } catch (cleanupError) {
        throw grokError(
          "unavailable",
          "Grok attach failed and its owned process could not be cleaned up safely.",
          "grok_attach_cleanup_failed",
          true,
          new AggregateError([mapped, cleanupError]),
        );
      }
      throw mapped;
    } finally {
      releaseOperation();
    }
  }

  async read(input: ReadConversationInput): Promise<ConversationReadResult> {
    const detail = this.#assertConversationInput(input);
    this.#assertOperational();
    const resident = this.#handles.get(this.#ownershipKey(detail));
    if (resident) {
      const projection = await resident.establishProjection({
        signal: new AbortController().signal,
      });
      return {
        snapshot: projection.snapshot,
        usage: await resident.usage(),
      };
    }
    if (resident === null) {
      throw grokError(
        "invalid_state",
        "This Grok conversation is still attaching.",
        "grok_conversation_attach_in_progress",
        true,
      );
    }
    const handle = await this.attach(input);
    let result: ConversationReadResult | undefined;
    let failure: unknown;
    try {
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      result = {
        snapshot: projection.snapshot,
        usage: await handle.usage(),
      };
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw grokError(
          "unavailable",
          "Grok read failed and its native session could not be unloaded safely.",
          "grok_read_cleanup_failed",
          true,
          new AggregateError([failure, cleanupError]),
        );
      }
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
    return result!;
  }

  async resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    throw unsupported("branching");
  }

  async branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    throw unsupported("branching");
  }

  async reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertOperational();
    const releaseOperation = this.#beginOperation();
    try {
      if (
        !input.binding ||
        !input.opaqueBindingDetail ||
        !bounded(input.applicationOperationId, 160) ||
        !bounded(input.reconciliationToken, 4_096)
      ) {
        return unresolved(
          "Grok submission reconciliation is missing its exact durable identity.",
        );
      }
      const anchor = parseRetryAnchor(input.retryAnchor);
      if (!anchor) {
        return unresolved(
          "Grok submission reconciliation is missing its valid pre-submit transcript anchor.",
        );
      }
      let lifecycle: GrokSessionLifecycle | undefined;
      let loaded = false;
      let conclusion: SubmissionReconciliation = unresolved(
        "Grok could not authoritatively reconcile the submission.",
      );
      try {
        const detail = this.#assertConversationInput({
          scope: input.scope,
          workspace: input.workspace,
          binding: input.binding,
          opaqueBindingDetail: input.opaqueBindingDetail,
        });
        const correlation = this.#submissionCorrelationScope(detail);
        if (
          !submissionScopeFingerprintMatches(
            anchor.scopeFingerprint,
            correlation,
          )
        ) {
          conclusion = unresolved(
            "Grok submission reconciliation received an anchor for a different native conversation scope.",
          );
        } else {
          const expectedPromptIds = grokSubmissionPromptIdReadCandidates({
            ...correlation,
            applicationOperationId: input.applicationOperationId,
            reconciliationToken: input.reconciliationToken,
          });
          lifecycle = await this.#openLifecycle(input.workspace, undefined, undefined, input.binding.applicationThreadId);
          const state = await lifecycle.loadSession(detail.sessionId);
          this.#assertEffectiveConfiguration(
            lifecycle.modelCatalog,
            state.configuration,
          );
          loaded = true;
          const exactMatchingTurns = expectedPromptIds.flatMap(
            (expectedPromptId) =>
              inspectGrokNormalizedHistory(
                state.history,
                correlation,
                input.applicationOperationId,
                expectedPromptId,
              ).matchingTurns,
          );
          const operationEvidence = inspectGrokNormalizedHistory(
            state.history,
            correlation,
            input.applicationOperationId,
          );
          if (
            exactMatchingTurns.length === 1 &&
            operationEvidence.matchingTurns.length === 1
          ) {
            const backendTurn = exactMatchingTurns[0]!;
            conclusion = {
              status: "accepted",
              backendTurn,
              ...(backendTurn.status === "completed" ||
              backendTurn.status === "interrupted" ||
              backendTurn.status === "failed"
                ? {
                    completionIdentity: `${backendTurn.backendTurnId}:${backendTurn.status}`,
                  }
                : {}),
            };
          } else if (operationEvidence.matchingTurns.length > 0) {
            conclusion = unresolved(
              "Grok exposed duplicate authenticated turns for this submission.",
            );
          } else {
            conclusion =
              operationEvidence.transcriptFingerprint ===
              anchor.transcriptFingerprint
                ? { status: "not_accepted", retryable: true }
                : unresolved(
                    "Grok did not expose the exact submission and its transcript diverged from the pre-submit anchor.",
                  );
          }
        }
      } catch {
        conclusion = unresolved(
          "Grok could not authoritatively reconcile the submission.",
        );
      }
      let cleanupFailed = false;
      if (lifecycle) {
        if (loaded) {
          try {
            await lifecycle.closeSession(input.binding.backendConversationId);
          } catch {
            cleanupFailed = true;
          }
        }
        try {
          await lifecycle.close("grok_submission_reconciliation_complete");
        } catch {
          cleanupFailed = true;
        }
      }
      // Cleanup disposition cannot revoke a submission outcome already proven
      // from authoritative native replay. Keep cleanup uncertainty visible when
      // the semantic result was unresolved, but preserve accepted/not-accepted
      // evidence so a wedged recovery process cannot prevent convergence.
      return cleanupFailed && conclusion.status === "unresolved"
        ? unresolved(
            "Grok reconciliation completed, but its owned process did not clean up safely.",
          )
        : conclusion;
    } finally {
      releaseOperation();
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await Promise.all([...this.#operations]);
      this.#snapshots.close();
      const closures = await Promise.allSettled(
        [...this.#handles.values()]
          .filter((handle): handle is GrokConversationHandle => handle !== null)
          .map(async (handle) => await handle.close()),
      );
      this.#handles.clear();
      const failures = closures.flatMap((closure) =>
        closure.status === "rejected" ? [closure.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "grok_conversation_driver_close_failed",
        );
      }
    })();
    return await this.#closePromise;
  }

  #beginOperation(): () => void {
    let resolve!: () => void;
    const operation = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.#operations.add(operation);
    return () => {
      this.#operations.delete(operation);
      resolve();
    };
  }

  async #openLifecycle(
    workspace: ValidatedWorkspace,
    signal?: AbortSignal,
    publish?: (record: GrokHistoryRecord) => void | Promise<void>,
    sourceThreadId?: string,
    publishAuthoritative?: () => void | Promise<void>,
  ): Promise<GrokSessionLifecycle> {
    throwIfAborted(signal);
    return await this.#openLifecycleAtPath(
      workspace.canonicalPath,
      signal,
      publish,
      sourceThreadId
        ? {
            sourceThreadId,
            sourceWorkspaceId: workspace.summary.id,
          }
        : undefined,
      publishAuthoritative,
    );
  }

  startupEnvironmentState(): "not_started" | "started" { return this.#startupLaunchAttempted ? "started" : "not_started"; }

  async #openLifecycleAtPath(
    canonicalWorkspace: string,
    signal?: AbortSignal,
    publish?: (record: GrokHistoryRecord) => void | Promise<void>,
    agentToolSource?: {
      readonly sourceThreadId: string;
      readonly sourceWorkspaceId: string;
    },
    publishAuthoritative?: () => void | Promise<void>,
  ): Promise<GrokSessionLifecycle> {
    throwIfAborted(signal);
    this.#startupLaunchAttempted = true;
    const trustedAgentToolSource = agentToolSource
      ? {
          scope: {
            tenantId: this.instance.tenantId,
            principalId: this.connection.ownerPrincipalId,
          },
          sourceThreadId: agentToolSource.sourceThreadId,
          sourceWorkspaceId: agentToolSource.sourceWorkspaceId,
          sourceEnvironmentId: this.connection.executionEnvironmentId,
          backendKind: "grok_build" as const,
        }
      : undefined;
    const agentToolPolicy =
      trustedAgentToolSource && this.#agentToolCli.availability === "available"
        ? this.#agentTools.readPolicy(trustedAgentToolSource)
        : undefined;
    const sourceCapability =
      trustedAgentToolSource &&
      agentToolPolicy?.presentation.surface === "cli" &&
      this.#agentToolCli.availability === "available"
        ? this.#agentToolSourceCapabilities.issue(
            trustedAgentToolSource,
            "management_http",
            "cli",
          )
        : undefined;
    const runtimeObservation = this.#beginRuntimeAssessmentObservation?.();
    let runtime: ResolvedGrokWorkspaceRuntimeConfiguration;
    try {
      runtime = await resolveGrokWorkspaceRuntimeConfiguration({
        scope: {
          tenantId: this.instance.tenantId,
          principalId: this.connection.ownerPrincipalId,
        },
        backendInstanceId: this.instance.id,
        executionEnvironmentId: this.connection.executionEnvironmentId,
        executablePath: this.#executablePath,
        canonicalWorkspace,
        environmentChannel: this.#environmentChannel,
        environment: this.#environment,
        startupEnvironmentVariables: this.#startupEnvironmentVariables,
        executionEnvironment: agentToolSource ? await this.#resolveThreadEnvironment(agentToolSource.sourceThreadId) : {},
        versionCache: this.#runtimeVersionCache,
        ...(sourceCapability
          ? {
              agentToolCliEnvironment: {
                availability: this.#agentToolCli,
                sourceCapability,
                mode: agentToolPolicy!.presentation.mode,
              },
            }
          : {}),
      });
    } catch (error) {
      runtimeObservation?.failed();
      throw error;
    }
    runtimeObservation?.admitted(runtime.executable.assessment);
    throwIfAborted(signal);
    const factory = new GrokOwnedStdioTransportFactory({
      runtime,
      channels: this.#environmentChannel,
    });
    const generation = ++this.#nextGeneration;
    const transport = await factory.open(
      generation,
      signal ?? new AbortController().signal,
    );
    const lifecycle = await GrokSessionLifecycle.open({
      transport,
      owner: {
        scope: factory.scope,
        nativeNamespaceKey: this.#nativeNamespaceKey,
        workspace: canonicalWorkspace,
        connectionGeneration: generation,
        processOwnerId: randomUUID(),
      },
      registry: new GrokSessionRegistry(),
      inlineSessionUpdates: true,
      ...(this.#promptPostTerminalSettlementDeadlineMilliseconds !== undefined
        ? {
            promptPostTerminalSettlementDeadlineMilliseconds:
              this.#promptPostTerminalSettlementDeadlineMilliseconds,
          }
        : {}),
      ...(publish ? { publish } : {}),
      ...(publishAuthoritative ? { publishAuthoritative } : {}),
      ...(signal ? { signal } : {}),
    });
    this.#runtimeImageInputSupport.set(
      lifecycle,
      admittedGrokRuntimeSupportsImageInput(runtime.executable),
    );
    return lifecycle;
  }

  #projectCatalog(
    catalog: GrokModelCatalog,
    runtimeSupportsImageInput: boolean,
  ): BackendCatalog["models"] {
    return Object.freeze(
      catalog.availableModels.flatMap((model) => {
        const advertisedEfforts = model.supportedReasoningEfforts;
        const efforts = this.#modelPolicy.filterReasoningEfforts(
          { modelId: model.modelId },
          advertisedEfforts,
        );
        if (
          advertisedEfforts.length > 0
            ? efforts.length === 0
            : !this.#modelPolicy.isModelWithoutReasoningEffortAllowed({
                modelId: model.modelId,
              })
        ) {
          return [];
        }
        return [
          Object.freeze({
            provider: this.connection.id,
            id: model.modelId,
            label: boundDisplayText(model.name).text,
            inputModalities: Object.freeze([
              "text" as const,
              ...(runtimeSupportsImageInput &&
              GROK_ACP_IMAGE_INPUT_PATH_REGISTERED &&
              model.imageInput !== false
                ? (["image" as const] as const)
                : []),
            ]),
            ...(model.modelId === catalog.currentModelId
              ? { isDefault: true as const }
              : {}),
            ...(efforts.length > 0
              ? {
                  supportedReasoningEfforts: Object.freeze([...efforts]),
                  ...(model.defaultReasoningEffort &&
                  efforts.includes(model.defaultReasoningEffort)
                    ? { defaultReasoningEffort: model.defaultReasoningEffort }
                    : {}),
                }
              : {}),
          }),
        ];
      }),
    );
  }

  #resolveCreationConfiguration(
    catalog: GrokModelCatalog,
  ): GrokEffectiveSessionConfiguration {
    const modelId =
      this.#defaults.model.type === "fixed"
        ? this.#defaults.model.modelId
        : catalog.currentModelId;
    const model = catalog.availableModels.find(
      (candidate) => candidate.modelId === modelId,
    );
    if (!model) throw modelConfigurationUnavailable();
    const reasoningEffort =
      this.#defaults.reasoningEffort.type === "fixed"
        ? this.#defaults.reasoningEffort.effortId
        : model.defaultReasoningEffort;
    const configuration = Object.freeze({
      modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    this.#assertEffectiveConfiguration(catalog, configuration);
    return configuration;
  }

  #desiredConfiguration(
    applicationThreadId: string,
    catalog: GrokModelCatalog,
  ): GrokEffectiveSessionConfiguration {
    const settings = this.#settings.get(
      this.#threadScope(),
      applicationThreadId,
    );
    if (!settings.model || !settings.effort) {
      throw modelConfigurationUnavailable();
    }
    const configuration = Object.freeze({
      modelId: settings.model,
      reasoningEffort: settings.effort,
    });
    this.#assertEffectiveConfiguration(catalog, configuration);
    return configuration;
  }

  #threadScope() {
    return Object.freeze({
      tenantId: this.instance.tenantId,
      principalId: this.connection.ownerPrincipalId,
    });
  }

  #assertEffectiveConfiguration(
    catalog: GrokModelCatalog,
    configuration: GrokEffectiveSessionConfiguration,
  ): void {
    const model = catalog.availableModels.find(
      (candidate) => candidate.modelId === configuration.modelId,
    );
    if (!model) throw modelConfigurationUnavailable();
    const efforts = model.supportedReasoningEfforts;
    if (
      efforts.length > 0
        ? !configuration.reasoningEffort ||
          !efforts.includes(configuration.reasoningEffort) ||
          !this.#modelPolicy.isSelectionAllowed(configuration)
        : configuration.reasoningEffort !== undefined ||
          !this.#modelPolicy.isModelWithoutReasoningEffortAllowed(configuration)
    ) {
      throw modelConfigurationUnavailable();
    }
  }

  #assertConversationInput(
    input: AttachConversationInput | ReadConversationInput,
  ): GrokConversationBindingDetail {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    const binding = input.binding;
    const detail = parseGrokConversationBindingDetail(
      input.opaqueBindingDetail,
    );
    if (
      binding.tenantId !== this.instance.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      !bounded(binding.applicationThreadId, 1_024) ||
      binding.backendConversationId !== detail.sessionId ||
      detail.tenantId !== this.instance.tenantId ||
      detail.principalId !== this.connection.ownerPrincipalId ||
      detail.backendInstanceId !== this.instance.id ||
      detail.connectionProfileId !== this.connection.id ||
      detail.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      detail.canonicalWorkspacePath !== input.workspace.canonicalPath ||
      detail.nativeNamespaceKey !== this.#nativeNamespaceKey
    ) {
      throw grokError(
        "permission_denied",
        "The Grok conversation binding does not belong to this target and workspace.",
        "grok_conversation_binding_scope_mismatch",
      );
    }
    return detail;
  }

  #bindingDetail(sessionId: string, workspace: ValidatedWorkspace): string {
    return serializeGrokConversationBindingDetail({
      version: 1,
      sessionId,
      tenantId: this.instance.tenantId,
      principalId: this.connection.ownerPrincipalId,
      backendInstanceId: this.instance.id,
      connectionProfileId: this.connection.id,
      executionEnvironmentId: this.connection.executionEnvironmentId,
      canonicalWorkspacePath: workspace.canonicalPath,
      nativeNamespaceKey: this.#nativeNamespaceKey,
    });
  }

  #discoveryBinding(
    workspace: ValidatedWorkspace,
  ): GrokDiscoverySnapshotBinding {
    return Object.freeze({
      tenantId: this.instance.tenantId,
      principalId: this.connection.ownerPrincipalId,
      backendInstanceId: this.instance.id,
      connectionProfileId: this.connection.id,
      executionEnvironmentId: this.connection.executionEnvironmentId,
      canonicalWorkspacePath: workspace.canonicalPath,
      nativeNamespaceKey: this.#nativeNamespaceKey,
    });
  }

  #ownershipKey(detail: GrokConversationBindingDetail): string {
    return JSON.stringify([
      detail.tenantId,
      detail.principalId,
      detail.backendInstanceId,
      detail.connectionProfileId,
      detail.executionEnvironmentId,
      detail.canonicalWorkspacePath,
      detail.nativeNamespaceKey,
      detail.sessionId,
    ]);
  }

  #submissionCorrelationScope(
    detail: GrokConversationBindingDetail,
  ): GrokSubmissionCorrelationScope {
    return Object.freeze({
      installationKey: new Uint8Array(this.#submissionCorrelationKey),
      tenantId: detail.tenantId,
      principalId: detail.principalId,
      backendInstanceId: detail.backendInstanceId,
      connectionProfileId: detail.connectionProfileId,
      executionEnvironmentId: detail.executionEnvironmentId,
      nativeNamespaceKey: detail.nativeNamespaceKey,
      canonicalWorkspacePath: detail.canonicalWorkspacePath,
      sessionId: detail.sessionId,
    });
  }

  #assertScope(scope: {
    readonly tenantId: string;
    readonly principalId: string;
  }): void {
    if (
      scope.tenantId !== this.instance.tenantId ||
      scope.principalId !== this.connection.ownerPrincipalId
    ) {
      throw grokError(
        "permission_denied",
        "The Grok target does not belong to this principal.",
        "grok_scope_mismatch",
      );
    }
  }

  #assertWorkspace(workspace: ValidatedWorkspace): void {
    if (
      workspace.summary.environmentId !==
        this.connection.executionEnvironmentId ||
      !path.isAbsolute(workspace.canonicalPath) ||
      path.resolve(workspace.canonicalPath) !== workspace.canonicalPath
    ) {
      throw grokError(
        "permission_denied",
        "The workspace does not belong to this Grok execution target.",
        "grok_workspace_scope_mismatch",
      );
    }
  }

  #assertOperational(): void {
    if (this.#closed || !this.instance.enabled || !this.connection.enabled) {
      throw grokError(
        "unavailable",
        "The Grok target is disabled or shutting down.",
        "grok_target_unavailable",
        true,
      );
    }
  }
}

class GrokConversationHandle implements ConversationHandle {
  readonly binding: ConversationBinding;
  readonly #lifecycle: GrokSessionLifecycle;
  readonly #sessionId: string;
  readonly #submissionCorrelation: GrokSubmissionCorrelationScope;
  readonly #settings: GrokThreadSettingsStore;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #effectiveConfiguration: GrokEffectiveSessionConfiguration;
  readonly #runtimeSupportsImageInput: boolean;
  readonly #generatedImages: GrokGeneratedImageProjectionContext;
  readonly #onClosed: () => void;
  readonly #listeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #sequencedListeners = new Set<
    (event: SequencedBackendEvent) => void
  >();
  readonly #journal: SequencedBackendEvent[] = [];
  readonly #submissions = new Map<string, GrokSubmissionEntry>();
  #interrupt: GrokInterruptEntry | undefined;
  #rename: GrokRenameEntry | undefined;
  readonly #completionContinuations = new Set<Promise<void>>();
  #historyRefreshWork = Promise.resolve();
  readonly #liveBlockItemIds = new Map<string, string>();
  readonly #livePromptIdsByItemId = new Map<string, string | undefined>();
  readonly #provisionalLiveItems = new Map<string, BackendItem>();
  readonly #dirtyLiveItemIds = new Set<string>();
  #nextSequence = 0;
  #historyRevision = 0;
  #projectionSnapshot: BackendConversationSnapshot;
  #historyRefreshTimer: NodeJS.Timeout | undefined;
  #authoritativeHistoryRefreshRequired = false;
  #closed = false;
  #finishedClose = false;
  #closePromise: Promise<void> | undefined;
  #fencePromise: Promise<void> | undefined;

  constructor(input: {
    readonly binding: ConversationBinding;
    readonly lifecycle: GrokSessionLifecycle;
    readonly sessionId: string;
    readonly submissionCorrelation: GrokSubmissionCorrelationScope;
    readonly initialSnapshot: BackendConversationSnapshot;
    readonly settings: GrokThreadSettingsStore;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly effectiveConfiguration: GrokEffectiveSessionConfiguration;
    readonly runtimeSupportsImageInput: boolean;
    readonly generatedImages: GrokGeneratedImageProjectionContext;
    readonly onClosed: () => void;
  }) {
    this.binding = Object.freeze({ ...input.binding });
    this.#lifecycle = input.lifecycle;
    this.#sessionId = input.sessionId;
    this.#submissionCorrelation = input.submissionCorrelation;
    this.#projectionSnapshot = input.initialSnapshot;
    this.#settings = input.settings;
    this.#modelPolicy = input.modelPolicy;
    this.#effectiveConfiguration = input.effectiveConfiguration;
    this.#runtimeSupportsImageInput = input.runtimeSupportsImageInput;
    this.#generatedImages = input.generatedImages;
    this.#onClosed = input.onClosed;
    this.#indexHistoryRecords(this.#lifecycle.history(this.#sessionId));
  }

  providerHistoryChanged(): Promise<void> {
    const operation = this.#historyRefreshWork.then(async () => {
      await this.#refreshProviderHistory();
    });
    this.#historyRefreshWork = operation.catch(() => undefined);
    return operation;
  }

  async #refreshProviderHistory(): Promise<void> {
    if (this.#historyRefreshTimer) {
      clearTimeout(this.#historyRefreshTimer);
      this.#historyRefreshTimer = undefined;
    }
    this.#provisionalLiveItems.clear();
    this.#dirtyLiveItemIds.clear();
    this.#authoritativeHistoryRefreshRequired = false;
    if (this.#closed) return;
    let records: readonly GrokHistoryRecord[];
    let next: BackendConversationSnapshot;
    try {
      const page = await this.#lifecycle.historyPage(this.#sessionId, {
        limit: 10,
      });
      records = page.records;
      const projection =
        await projectSelectedGrokLatestHistoryWithGeneratedImages(
          records,
          {
            ...(page.previousCursor
              ? { previousCursor: page.previousCursor }
              : {}),
            previousCursorByPromptId:
              page.previousCursorByPromptId ?? Object.freeze({}),
          },
          this.#submissionCorrelation,
          this.#generatedImages,
        );
      if (this.#closed) return;
      next = projection.snapshot;
    } catch {
      this.#historyRevision += 1;
      writeGrokDeliveryDiagnostic({
        phase: "resnapshot_requested",
        applicationThreadId: this.binding.applicationThreadId,
        revision: this.#historyRevision,
      });
      this.#emit({
        type: "resnapshot_required",
        reason: "contradictory_state",
      });
      return;
    }
    this.#indexHistoryRecords(records);
    this.#pruneInterruptEvidence(next.activeBackendTurnId);
    const events = grokProjectionEvents(this.#projectionSnapshot, next);
    if (events === undefined) {
      this.#historyRevision += 1;
      this.#projectionSnapshot = next;
      writeGrokDeliveryDiagnostic({
        phase: "resnapshot_requested",
        applicationThreadId: this.binding.applicationThreadId,
        revision: this.#historyRevision,
      });
      this.#emit({
        type: "resnapshot_required",
        reason: "contradictory_state",
      });
      return;
    }
    if (events.length === 0) return;
    this.#historyRevision += 1;
    this.#projectionSnapshot = next;
    for (const event of events) this.#emit(event);
  }

  scheduleProviderHistoryChanged(authoritative = false): void {
    if (authoritative) this.#authoritativeHistoryRefreshRequired = true;
    if (this.#closed || this.#historyRefreshTimer) return;
    this.#historyRefreshTimer = setTimeout(() => {
      this.#historyRefreshTimer = undefined;
      if (this.#authoritativeHistoryRefreshRequired) {
        void this.providerHistoryChanged();
      } else {
        this.#flushLiveItems();
      }
    }, GROK_HISTORY_PUBLICATION_INTERVAL_MILLISECONDS);
    this.#historyRefreshTimer.unref?.();
  }

  providerHistoryRecordChanged(record: GrokHistoryRecord): void {
    if (this.#closed) return;
    if (
      record.kind === "turn_completed" ||
      record.kind === "collaboration" ||
      record.kind === "plan" ||
      record.kind === "omission"
    ) {
      void this.providerHistoryChanged();
      return;
    }
    if (record.kind === "tool") {
      this.#liveBlockItemIds.set(
        record.identity.blockId,
        grokNormalizedItemId(record),
      );
      this.scheduleProviderHistoryChanged(true);
      return;
    }
    const backendItemId = this.#liveBlockItemIds.get(record.identity.blockId);
    if (backendItemId === undefined || record.kind === "user_text") {
      void this.providerHistoryChanged();
      return;
    }
    const prior =
      this.#provisionalLiveItems.get(backendItemId) ??
      this.#projectionSnapshot.itemsById[backendItemId];
    const next = appendGrokLiveText(prior, record);
    if (!next) {
      void this.providerHistoryChanged();
      return;
    }
    if (prior === next) return;
    this.#livePromptIdsByItemId.set(backendItemId, record.identity.promptId);
    this.#provisionalLiveItems.set(backendItemId, next);
    this.#dirtyLiveItemIds.add(backendItemId);
    this.scheduleProviderHistoryChanged();
  }

  #indexHistoryRecords(records: readonly GrokHistoryRecord[]): void {
    this.#liveBlockItemIds.clear();
    this.#livePromptIdsByItemId.clear();
    for (const record of records) {
      if (record.kind !== "turn_completed") {
        this.#liveBlockItemIds.set(
          record.identity.blockId,
          grokNormalizedItemId(record),
        );
        this.#livePromptIdsByItemId.set(
          grokNormalizedItemId(record),
          record.identity.promptId,
        );
      }
    }
  }

  #flushLiveItems(): void {
    if (this.#closed) return;
    const itemIds = [...this.#dirtyLiveItemIds];
    this.#dirtyLiveItemIds.clear();
    if (itemIds.length === 0) return;
    const changed: BackendItem[] = [];
    for (const backendItemId of itemIds) {
      const item = this.#provisionalLiveItems.get(backendItemId);
      if (!item) continue;
      changed.push(
        sanitizeGrokLiveGeneratedImageMarkdown(
          item,
          this.#lifecycle.history(this.#sessionId),
          this.#livePromptIdsByItemId.get(backendItemId),
        ),
      );
    }
    if (changed.length === 0) return;
    this.#historyRevision += 1;
    for (const item of changed) this.#emit({ type: "item_updated", item });
  }

  async establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    throwIfAborted(input.signal);
    const revision = this.#historyRevision;
    const page = await this.#lifecycle.historyPage(this.#sessionId, {
      limit: 10,
      signal: input.signal,
    });
    const records = page.records;
    const projectionStartedAt = Date.now();
    const projection =
      await projectSelectedGrokLatestHistoryWithGeneratedImages(
        records,
        {
          ...(page.previousCursor
            ? { previousCursor: page.previousCursor }
            : {}),
          previousCursorByPromptId:
            page.previousCursorByPromptId ?? Object.freeze({}),
        },
        this.#submissionCorrelation,
        this.#generatedImages,
        input.signal,
      );
    throwIfAborted(input.signal);
    this.#assertOpen();
    writeGrokDeliveryDiagnostic({
      phase: "snapshot_projected",
      applicationThreadId: this.binding.applicationThreadId,
      revision,
      records: records.length,
      turns: Object.keys(projection.snapshot.turnsById).length,
      items: Object.keys(projection.snapshot.itemsById).length,
      milliseconds: Date.now() - projectionStartedAt,
    });
    if (revision !== this.#historyRevision) {
      throw grokError(
        "unavailable",
        "Grok history changed while its projection was being established.",
        "grok_projection_changed",
        true,
      );
    }
    this.#projectionSnapshot = projection.snapshot;
    this.#pruneInterruptEvidence(projection.snapshot.activeBackendTurnId);
    const after = this.#nextSequence - 1;
    return {
      handleSequence: after,
      snapshot: projection.snapshot,
      history: {
        operational: true,
        ...(projection.previousCursor
          ? { previousCursor: projection.previousCursor }
          : {}),
      },
      subscribeFromNext: (listener) => {
        this.#assertOpen();
        const earliest = this.#journal[0]?.handleSequence;
        if (earliest !== undefined && after < earliest - 1) {
          listener(
            Object.freeze({
              handleSequence: this.#nextSequence++,
              event: Object.freeze({
                type: "resnapshot_required" as const,
                reason: "buffer_overflow" as const,
              }),
            }),
          );
        } else {
          for (const event of this.#journal) {
            if (event.handleSequence > after) listener(event);
          }
        }
        this.#sequencedListeners.add(listener);
        return () => this.#sequencedListeners.delete(listener);
      },
    };
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    try {
      const page = await this.#lifecycle.historyPage(this.#sessionId, input);
      return await projectSelectedGrokHistoryPageWithGeneratedImages(
        page.records,
        {
          limit: input.limit,
          previousCursor: page.previousCursor,
          previousCursorByPromptId:
            page.previousCursorByPromptId ?? Object.freeze({}),
        },
        this.#submissionCorrelation,
        this.#generatedImages,
        input.signal,
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      throw mapReadError(error, "Grok history is unavailable.");
    }
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(input.maximumTurnCandidates) ||
      input.maximumTurnCandidates < 1
    ) {
      throw grokError(
        "rejected",
        "The Grok turn search limit is invalid.",
        "grok_locate_turn_limit_invalid",
      );
    }
    let retained: ReturnType<GrokSessionLifecycle["retainedHistoryPage"]>;
    let located: Awaited<
      ReturnType<typeof locateGrokHistoryTurnWithGeneratedImages>
    >;
    try {
      retained = this.#lifecycle.retainedHistoryPage(this.#sessionId);
      located = await locateGrokHistoryTurnWithGeneratedImages(
        retained.records,
        {
          matchesBackendTurnId: input.matchesBackendTurnId,
          maximumTurnCandidates: input.maximumTurnCandidates,
        },
        this.#submissionCorrelation,
        this.#generatedImages,
        input.signal,
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      throw mapReadError(error, "Grok history is unavailable.");
    }
    input.signal?.throwIfAborted();
    this.#assertOpen();
    if (located.page) {
      return Object.freeze({ status: "found", page: located.page });
    }
    return located.inspectedTurnCount < located.retainedTurnCount ||
      retained.previousCursor !== undefined ||
      retained.evictedPromptCount > 0
      ? Object.freeze({ status: "search_limit_reached" })
      : Object.freeze({ status: "not_found" });
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    const selectedModel = this.#lifecycle.modelCatalog.availableModels.find(
      (model) => model.modelId === this.#effectiveConfiguration.modelId,
    );
    const nativeImage =
      this.#runtimeSupportsImageInput &&
      GROK_ACP_IMAGE_INPUT_PATH_REGISTERED &&
      selectedModel !== undefined &&
      selectedModel.imageInput !== false;
    const configurationRevision = createHash("sha256")
      .update(JSON.stringify({ ...this.#effectiveConfiguration, nativeImage }))
      .digest("base64url")
      .slice(0, 32);
    return {
      revision: `grok-private-submit-rename-image:v5:${configurationRevision}`,
      actions: ["rename"],
      deliveryModes: ["submit"],
      steerTarget: null,
      composerAttachments: { fileStaging: true, nativeImage },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: true },
      supportsHistory: true,
      branching: {
        availability: "unavailable",
        reason: boundDisplayText(
          "This private Grok integration does not support branching.",
        ),
      },
      interactionKinds: [],
      usageAccounting: "unsupported",
      usageSections: [],
      effectiveSettings: {
        model: {
          provider: this.binding.connectionProfileId,
          id: this.#effectiveConfiguration.modelId,
        },
        ...(this.#effectiveConfiguration.reasoningEffort
          ? { thinkingLevel: this.#effectiveConfiguration.reasoningEffort }
          : {}),
      },
    };
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    return {};
  }

  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertOpen();
    let evidence;
    try {
      evidence = inspectGrokNormalizedHistory(
        this.#lifecycle.history(this.#sessionId),
        this.#submissionCorrelation,
        "grok-retry-anchor-inspection",
      );
    } catch (error) {
      throw mapReadError(error, "Grok history is unavailable.");
    }
    if (evidence.runState !== "idle") {
      throw grokError(
        "invalid_state",
        "Grok must be authoritatively settled before a submission retry anchor is captured.",
        "grok_retry_anchor_requires_settled",
        true,
      );
    }
    return serializeRetryAnchor(
      submissionScopeFingerprint(this.#submissionCorrelation),
      evidence.transcriptFingerprint,
    );
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    validateSubmissionInput(input);
    const attachmentEvidence = resolveGrokSubmissionAttachments(input);
    const expectedText = deliverableGrokText(input.text);
    const expectedProviderText = expectedText;
    if (attachmentEvidence.some((attachment) => attachment.kind === "image")) {
      const selectedModel = this.#lifecycle.modelCatalog.availableModels.find(
        (model) => model.modelId === this.#effectiveConfiguration.modelId,
      );
      if (
        !this.#runtimeSupportsImageInput ||
        !GROK_ACP_IMAGE_INPUT_PATH_REGISTERED ||
        !selectedModel ||
        selectedModel.imageInput === false
      ) {
        throw grokError(
          "rejected",
          "The selected Grok model does not accept image input.",
          "grok_model_image_input_unsupported",
        );
      }
    }
    this.#assertDesiredConfiguration();
    const fingerprint = submissionFingerprint(input, attachmentEvidence);
    const prior = this.#submissions.get(input.applicationOperationId);
    if (prior) {
      if (
        prior.fingerprint !== fingerprint ||
        prior.reconciliationToken !== input.reconciliationToken
      ) {
        throw grokError(
          "rejected",
          "The Grok submission operation was replayed with different input.",
          "grok_submission_replay_mismatch",
        );
      }
      return await prior.accepted;
    }
    this.#assertOpen();
    const promptId = grokSubmissionPromptId({
      ...this.#submissionCorrelation,
      applicationOperationId: input.applicationOperationId,
      reconciliationToken: input.reconciliationToken,
    });
    let operationEvidence;
    let exactEvidence;
    try {
      const records = this.#lifecycle.history(this.#sessionId);
      operationEvidence = inspectGrokNormalizedHistory(
        records,
        this.#submissionCorrelation,
        input.applicationOperationId,
      );
      exactEvidence = inspectGrokNormalizedHistory(
        records,
        this.#submissionCorrelation,
        input.applicationOperationId,
        promptId,
      );
    } catch (error) {
      const mapped = mapReadError(
        error,
        "Grok is unavailable before submission.",
      );
      if (mapped.category === "incompatible_protocol") {
        void this.#fence("grok_submission_preflight_projection_invalid");
      }
      throw mapped;
    }
    if (exactEvidence.matchingTurns.length === 1) {
      const turn = exactEvidence.matchingTurns[0]!;
      if (
        (exactEvidence.userTextDigestByBackendTurnId[turn.backendTurnId] ??
          exactTextDigest("")) !== exactTextDigest(expectedProviderText)
      ) {
        throw grokError(
          "rejected",
          "The Grok submission operation was replayed with different text.",
          "grok_submission_replay_mismatch",
        );
      }
      return Object.freeze({
        accepted: true,
        reconciliationToken: input.reconciliationToken,
        completionCorrelation: input.applicationOperationId,
        backendTurnId: turn.backendTurnId,
      });
    }
    if (
      exactEvidence.matchingTurns.length > 1 ||
      operationEvidence.matchingTurns.length > 0
    ) {
      void this.#fence("grok_submission_correlation_conflict");
      throw grokError(
        "incompatible_protocol",
        "Grok exposed conflicting authenticated submission evidence.",
        "grok_submission_correlation_conflict",
      );
    }
    if (operationEvidence.runState !== "idle") {
      throw grokError(
        "invalid_state",
        "A Grok turn is already active.",
        "grok_turn_already_active",
      );
    }
    if (this.#completionContinuations.size > 0) {
      await Promise.allSettled([...this.#completionContinuations]);
      this.#assertOpen();
    }
    let operation;
    try {
      const promptContent = await grokPromptContent(
        input,
        attachmentEvidence,
        expectedText,
      );
      operation = this.#lifecycle.startPrompt(
        this.#sessionId,
        promptId,
        promptContent,
      );
    } catch (error) {
      throw mapSubmissionError(error, false);
    }
    const entry: GrokSubmissionEntry = {
      reconciliationToken: input.reconciliationToken,
      fingerprint,
      accepted: Promise.resolve(undefined as never),
      completion: Promise.resolve(),
      acceptedByProvider: false,
      uncertain: false,
    };
    entry.accepted = operation.accepted
      .then(async (acceptance) => {
        if (this.#closed) {
          throw new GrokPromptOutcomeUnknownError(
            new Error("grok_conversation_closed_after_prompt_acceptance"),
          );
        }
        if (acceptance.promptId !== promptId) {
          throw new Error("grok_prompt_acceptance_correlation_mismatch");
        }
        const evidence = inspectGrokNormalizedHistory(
          acceptance.history,
          this.#submissionCorrelation,
          input.applicationOperationId,
          promptId,
        );
        const acceptedTurn = evidence.matchingTurns[0];
        if (
          evidence.matchingTurns.length !== 1 ||
          !acceptedTurn ||
          (evidence.userTextDigestByBackendTurnId[acceptedTurn.backendTurnId] ??
            exactTextDigest("")) !== exactTextDigest(expectedProviderText)
        ) {
          throw new Error("grok_prompt_acceptance_projection_mismatch");
        }
        entry.acceptedByProvider = true;
        // Do not expose acceptance before the same authoritative provider
        // evidence has crossed the normalized projection boundary. The async
        // artifact preparation path may yield here; a concurrent handle close
        // must retain the already-crossed provider outcome as uncertain.
        await this.providerHistoryChanged();
        if (this.#closed) {
          throw new GrokPromptOutcomeUnknownError(
            new Error("grok_conversation_closed_after_prompt_acceptance"),
          );
        }
        return Object.freeze({
          accepted: true as const,
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
          backendTurnId: acceptedTurn.backendTurnId,
        });
      })
      .catch((error) => {
        const mapped = mapSubmissionError(error, true);
        entry.uncertain = mapped.crossedSubmissionBoundary;
        if (!entry.uncertain) {
          this.#submissions.delete(input.applicationOperationId);
        } else {
          void this.#fence("grok_submission_acceptance_unknown");
        }
        throw mapped;
      });
    entry.completion = operation.completed
      .then(async (completion) => {
        if (completion.promptId !== promptId) {
          throw new Error("grok_prompt_completion_correlation_mismatch");
        }
        const evidence = inspectGrokNormalizedHistory(
          completion.history,
          this.#submissionCorrelation,
          input.applicationOperationId,
          promptId,
        );
        if (
          evidence.matchingTurns.length !== 1 ||
          evidence.matchingTurns[0]!.status === "in_progress"
        ) {
          throw new Error("grok_prompt_completion_projection_mismatch");
        }
        await this.providerHistoryChanged();
      })
      .catch(async (error) => {
        const mapped = mapSubmissionError(error, true);
        if (!entry.acceptedByProvider && !mapped.crossedSubmissionBoundary) {
          return;
        }
        entry.uncertain = true;
        await this.#fence("grok_submission_completion_failed");
      })
      .finally(() => {
        if (
          !entry.uncertain &&
          this.#submissions.get(input.applicationOperationId) === entry
        ) {
          this.#submissions.delete(input.applicationOperationId);
        }
      });
    this.#submissions.set(input.applicationOperationId, entry);
    this.#completionContinuations.add(entry.completion);
    void entry.completion.finally(() => {
      this.#completionContinuations.delete(entry.completion);
    });
    return await entry.accepted;
  }

  async steer(_input: SteerTurnInput): Promise<SteerTurnResult> {
    throw unsupported("steering");
  }

  #assertDesiredConfiguration(): void {
    const settings = this.#settings.get(
      {
        tenantId: this.binding.tenantId,
        principalId: this.binding.ownerPrincipalId,
      },
      this.binding.applicationThreadId,
    );
    const effort = this.#effectiveConfiguration.reasoningEffort;
    if (
      !effort ||
      settings.model !== this.#effectiveConfiguration.modelId ||
      settings.effort !== effort ||
      !this.#modelPolicy.isSelectionAllowed({
        modelId: settings.model,
        reasoningEffort: settings.effort,
      })
    ) {
      throw grokError(
        "rejected",
        "This Grok model or reasoning effort is unavailable or no longer allowed by backend policy.",
        "model_policy_rejected",
      );
    }
  }

  async interrupt(input: InterruptTurnInput): Promise<void> {
    validateInterruptInput(input);
    this.#assertOpen();
    const prior = this.#interrupt;
    if (prior?.applicationOperationId === input.applicationOperationId) {
      this.#assertInterruptReplay(input, prior);
      if (prior.outcome === "accepted") return;
      throw interruptOutcomeUnknown();
    }
    let projection: BackendConversationSnapshot;
    try {
      const records = this.#lifecycle.history(this.#sessionId);
      projection = (
        await projectGrokLatestHistoryWithGeneratedImages(
          records,
          this.#submissionCorrelation,
          this.#generatedImages,
        )
      ).snapshot;
    } catch (error) {
      throw mapReadError(error, "Grok is unavailable before interrupt.");
    }
    if (
      projection.runState !== "running" ||
      projection.activeBackendTurnId !== input.expectedBackendTurnId
    ) {
      throw grokError(
        "invalid_state",
        "The active Grok turn changed before interrupt.",
        "grok_interrupt_target_changed",
      );
    }
    const promptId = this.#lifecycle.activePromptId(this.#sessionId);
    if (!promptId) {
      throw grokError(
        "invalid_state",
        "The active Grok prompt changed before interrupt.",
        "grok_interrupt_target_changed",
      );
    }
    this.#reserveInterrupt(input);
    try {
      await this.#lifecycle.interruptPrompt(this.#sessionId, promptId);
      if (this.#closed) {
        throw interruptOutcomeUnknown(
          new Error("grok_conversation_closed_after_interrupt"),
        );
      }
      this.#rememberInterrupt(input, "accepted");
      this.#emit({
        type: "run_state_changed",
        state: "stopping",
        activeBackendTurnId: input.expectedBackendTurnId,
      });
    } catch (error) {
      const mapped = mapInterruptError(error);
      if (mapped.crossedSubmissionBoundary) {
        this.#rememberInterrupt(input, "unknown");
      } else if (
        this.#interrupt?.applicationOperationId === input.applicationOperationId
      ) {
        this.#interrupt = undefined;
      }
      throw mapped;
    }
  }

  async reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation> {
    validateInterruptInput(input);
    this.#assertOpen();
    const prior = this.#interrupt;
    if (prior?.applicationOperationId === input.applicationOperationId) {
      this.#assertInterruptReplay(input, prior);
      if (prior.outcome === "accepted") return { outcome: "accepted" };
    }
    try {
      const records = this.#lifecycle.history(this.#sessionId);
      const projection = (
        await projectGrokLatestHistoryWithGeneratedImages(
          records,
          this.#submissionCorrelation,
          this.#generatedImages,
        )
      ).snapshot;
      const outcome: BackendMutationReconciliation =
        projection.activeBackendTurnId === input.expectedBackendTurnId
          ? { outcome: "unknown" }
          : { outcome: "accepted" };
      this.#pruneInterruptEvidence(projection.activeBackendTurnId);
      return outcome;
    } catch (error) {
      throw mapReadError(
        error,
        "Grok interrupt reconciliation is unavailable.",
      );
    }
  }

  async perform(
    input: RegisteredBackendActionInput,
  ): Promise<BackendActionResult> {
    this.#assertOpen();
    const nativeTitle = validateRenameAction(input);
    if (input.action !== "rename") throw unsupported("actions");
    if (this.#rename?.applicationOperationId === input.applicationOperationId) {
      if (this.#rename.title !== input.title) throw renameReplayMismatch();
      return { accepted: true };
    }
    let session;
    try {
      session = await this.#lifecycle.sessionInfo(this.#sessionId);
    } catch (error) {
      throw mapReadError(error, "Grok is unavailable before rename.");
    }
    if (!session) {
      throw grokError(
        "invalid_state",
        "The Grok conversation is no longer available.",
        "grok_rename_session_missing",
      );
    }
    if (session.title === nativeTitle) {
      this.#rename = {
        applicationOperationId: input.applicationOperationId,
        title: input.title,
      };
      return { accepted: true };
    }
    try {
      await this.#lifecycle.renameSession(this.#sessionId, nativeTitle!);
      this.#rename = {
        applicationOperationId: input.applicationOperationId,
        title: input.title,
      };
      return { accepted: true };
    } catch (error) {
      const mapped = mapRenameError(error);
      if (mapped.crossedSubmissionBoundary || this.#lifecycle.closed) {
        await this.#fence("grok_rename_outcome_unknown");
      }
      throw mapped;
    }
  }

  async reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    const nativeTitle = validateRenameAction(input);
    if (input.action !== "rename") return { outcome: "unknown" };
    if (this.#rename?.applicationOperationId === input.applicationOperationId) {
      if (this.#rename.title !== input.title) throw renameReplayMismatch();
      return { outcome: "accepted" };
    }
    try {
      const session = await this.#lifecycle.sessionInfo(this.#sessionId);
      if (!session) {
        throw grokError(
          "invalid_state",
          "The Grok conversation is no longer available.",
          "grok_rename_session_missing",
        );
      }
      return session.title === nativeTitle
        ? { outcome: "accepted" }
        : { outcome: "not_applied" };
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (this.#lifecycle.closed) {
        await this.#fence("grok_rename_reconciliation_handle_closed");
      }
      throw mapReadError(error, "Grok rename reconciliation is unavailable.");
    }
  }

  async respond(_input: InteractionResponseInput): Promise<void> {
    throw unsupported("interaction responses");
  }

  async reconcileInteractionResponse(
    _input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    throw unsupported("interaction response reconciliation");
  }

  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const failures: BackendError[] = [];
      await this.#historyRefreshWork;
      if (this.#fencePromise) {
        try {
          await this.#fencePromise;
        } catch (error) {
          failures.push(
            mapReadError(error, "Grok conversation process cleanup failed."),
          );
        } finally {
          this.#finishClose();
        }
        if (failures.length === 1) throw failures[0];
        return;
      }
      if (this.#completionContinuations.size > 0) {
        try {
          this.#fencePromise ??= this.#lifecycle.close(
            "grok_conversation_prompt_close",
          );
          await this.#fencePromise;
        } catch (error) {
          failures.push(
            mapReadError(error, "Grok conversation process cleanup failed."),
          );
        }
        await Promise.allSettled([...this.#completionContinuations]);
        this.#finishClose();
        if (failures.length === 1) throw failures[0];
        return;
      }
      try {
        await this.#lifecycle.closeSession(this.#sessionId);
      } catch (error) {
        failures.push(
          mapReadError(error, "Grok could not unload this conversation."),
        );
      } finally {
        try {
          await this.#lifecycle.close("grok_conversation_handle_close");
        } catch (error) {
          failures.push(
            mapReadError(error, "Grok conversation process cleanup failed."),
          );
        } finally {
          this.#finishClose();
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw grokError(
          "unavailable",
          "Grok could not unload the conversation or clean up its owned process safely.",
          "grok_conversation_close_cleanup_failed",
          true,
          new AggregateError(failures),
        );
      }
    })();
    return await this.#closePromise;
  }

  #rememberInterrupt(
    input: InterruptTurnInput,
    outcome: Exclude<GrokInterruptEntry["outcome"], "pending">,
  ): void {
    if (
      this.#interrupt?.applicationOperationId !== input.applicationOperationId
    ) {
      return;
    }
    this.#interrupt = {
      applicationOperationId: input.applicationOperationId,
      expectedBackendTurnId: input.expectedBackendTurnId,
      outcome,
    };
  }

  #reserveInterrupt(input: InterruptTurnInput): void {
    this.#interrupt = {
      applicationOperationId: input.applicationOperationId,
      expectedBackendTurnId: input.expectedBackendTurnId,
      outcome: "pending",
    };
  }

  #assertInterruptReplay(
    input: InterruptTurnInput,
    prior: GrokInterruptEntry,
  ): void {
    if (prior.expectedBackendTurnId === input.expectedBackendTurnId) return;
    throw grokError(
      "rejected",
      "The Grok interrupt operation was replayed for another turn.",
      "grok_interrupt_replay_mismatch",
    );
  }

  #pruneInterruptEvidence(activeBackendTurnId: string | undefined): void {
    if (this.#interrupt?.expectedBackendTurnId !== activeBackendTurnId) {
      this.#interrupt = undefined;
    }
  }

  #finishClose(): void {
    if (this.#finishedClose) return;
    this.#finishedClose = true;
    if (this.#historyRefreshTimer) {
      clearTimeout(this.#historyRefreshTimer);
      this.#historyRefreshTimer = undefined;
    }
    this.#provisionalLiveItems.clear();
    this.#dirtyLiveItemIds.clear();
    this.#listeners.clear();
    this.#sequencedListeners.clear();
    this.#onClosed();
  }

  #fence(reason: string): Promise<void> {
    if (!this.#fencePromise) {
      this.#emit({
        type: "resnapshot_required",
        reason: "provider_handle_closed",
      });
      this.#closed = true;
      this.#fencePromise = this.#lifecycle.close(reason).finally(() => {
        this.#finishClose();
      });
    }
    return this.#fencePromise.catch(() => undefined);
  }

  #emit(event: BackendConversationEvent): void {
    const sequenced = Object.freeze({
      handleSequence: this.#nextSequence++,
      event,
    });
    writeGrokDeliveryDiagnostic({
      phase: "handle_event",
      applicationThreadId: this.binding.applicationThreadId,
      event: event.type,
      sequence: sequenced.handleSequence,
    });
    this.#journal.push(sequenced);
    if (this.#journal.length > MAXIMUM_EVENT_JOURNAL) this.#journal.shift();
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Application observers cannot poison the provider notification tail.
      }
    }
    for (const listener of this.#sequencedListeners) {
      try {
        listener(sequenced);
      } catch {
        // Sequenced observers have the same non-authoritative failure boundary.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw grokError(
        "invalid_state",
        "The Grok conversation handle is closed.",
        "grok_conversation_handle_closed",
      );
    }
  }
}

function mapReadError(error: unknown, safeMessage: string): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof Error && error.message === "normalized_payload_exceeds_serialized_byte_limit") {
    return grokError(
      "incompatible_protocol",
      "Grok returned conversation text that exceeds the supported message size.",
      "grok_message_payload_too_large",
      false,
      error,
    );
  }
  if (error instanceof GrokNativeHistoryReadError) {
    return grokError(
      error.code === "grok_native_history_busy" ? "overloaded" : "unavailable",
      error.code === "grok_native_history_busy"
        ? "Grok history is busy with another session operation."
        : "Grok history acquisition was interrupted or exceeded local capacity.",
      error.code,
      error.retryable,
      error,
    );
  }
  if (error instanceof GrokNativeHistoryProjectionError) {
    return grokError(
      error.code === "grok_native_history_cursor_invalid"
        ? "rejected"
        : "incompatible_protocol",
      error.code === "grok_native_history_cursor_invalid"
        ? "The Grok history cursor is invalid or stale."
        : "Grok returned stored history that cannot be projected safely.",
      error.code,
      false,
      error,
    );
  }
  if (error instanceof GrokNormalizedHistoryError) {
    return grokError(
      error.code === "grok_normalized_history_cursor_invalid"
        ? "rejected"
        : "incompatible_protocol",
      error.code === "grok_normalized_history_cursor_invalid"
        ? "The Grok history cursor is invalid or stale."
        : "Grok returned history that cannot be projected safely.",
      error.code,
    );
  }
  if (error instanceof Error && error.message.startsWith("grok_history_")) {
    return grokError(
      "incompatible_protocol",
      "Grok returned history that cannot be projected safely.",
      "grok_normalized_history_invalid",
      false,
      error,
    );
  }
  if (error instanceof AcpRemoteError) {
    if (error.remoteCode === -32601) {
      return grokError(
        "incompatible_protocol",
        "The Grok installation does not provide a required lifecycle method.",
        "grok_remote_method_not_found",
        false,
        error,
      );
    }
    return grokError(
      "rejected",
      "Grok rejected the requested read operation.",
      `grok_remote_${error.remoteCode}`,
      false,
      error,
    );
  }
  if (error instanceof AcpBindingError) {
    if (
      error.code === "acp_binding_protocol_violation" ||
      error.code === "acp_binding_capability_denied"
    ) {
      return grokError(
        "incompatible_protocol",
        "The Grok installation is incompatible with the reviewed protocol profile.",
        error.code,
        false,
        error,
      );
    }
    if (error.code === "acp_binding_overloaded") {
      return grokError(
        "overloaded",
        "The Grok connection is overloaded.",
        error.code,
        true,
        error,
      );
    }
  }
  const runtimeIncompatibility = grokRuntimeIncompatibilityCode(error);
  if (
    runtimeIncompatibility ||
    (error instanceof Error &&
      (error.message === "grok_discovery_timestamp_invalid" ||
        error.message.startsWith("grok_session_list_") ||
        error.message === "grok_acp_initialize_profile_incompatible"))
  ) {
    const backendCode = runtimeIncompatibility ?? (error as Error).message;
    return grokError(
      "incompatible_protocol",
      "The Grok installation returned data outside the reviewed protocol profile.",
      backendCode,
      false,
      error,
    );
  }
  return grokError(
    "unavailable",
    safeMessage,
    "grok_read_unavailable",
    true,
    error,
  );
}

function mapCreateError(
  error: unknown,
  providerCreated: boolean,
  providerContacted: boolean,
): BackendError {
  if (error instanceof BackendError) return error;
  const runtimeIncompatibility = grokRuntimeIncompatibilityCode(error);
  if (runtimeIncompatibility) {
    return grokError(
      "incompatible_protocol",
      "The Grok installation is incompatible with the reviewed protocol profile.",
      runtimeIncompatibility,
      false,
      error,
    );
  }
  if (error instanceof AcpRemoteError) {
    return grokError(
      "rejected",
      "Grok rejected native session creation.",
      `grok_remote_${error.remoteCode}`,
      false,
      error,
    );
  }
  if (error instanceof AcpDeliveryError && error.delivery === "not_sent") {
    return grokError(
      "unavailable",
      "Grok was unavailable before native session creation was sent.",
      "grok_create_not_sent",
      true,
      error,
    );
  }
  if (
    error instanceof AcpBindingError &&
    (error.code === "acp_binding_overloaded" ||
      error.code === "acp_binding_capability_denied")
  ) {
    return grokError(
      error.code === "acp_binding_overloaded"
        ? "overloaded"
        : "incompatible_protocol",
      error.code === "acp_binding_overloaded"
        ? "The Grok connection was overloaded before creation."
        : "The Grok installation does not admit native session creation.",
      error.code,
      error.code === "acp_binding_overloaded",
      error,
    );
  }
  const uncertain =
    providerCreated ||
    (providerContacted &&
      (!(error instanceof AcpDeliveryError) || error.delivery !== "not_sent"));
  return grokError(
    uncertain ? "submission_unknown" : "unavailable",
    uncertain
      ? "Grok created or may have created a native session, but Sedes could not finalize it safely."
      : "Grok could not create a native session.",
    uncertain ? "grok_create_outcome_unknown" : "grok_create_unavailable",
    !uncertain,
    error,
    uncertain,
  );
}

function unsupported(operation: string): BackendError {
  return grokError(
    "rejected",
    `The private Grok integration does not support ${operation}.`,
    "grok_operation_unsupported",
  );
}

function validateRenameAction(
  input: RegisteredBackendActionInput,
): string | undefined {
  if (input.action !== "rename") return undefined;
  if (
    !bounded(input.applicationOperationId, 1_024) ||
    input.title.length < 1 ||
    input.title.length > 240 ||
    input.title !== input.title.trim() ||
    /[\r\n]/u.test(input.title)
  ) {
    throw grokError(
      "rejected",
      "The requested Grok title is invalid.",
      "grok_rename_title_invalid",
    );
  }
  return projectGrokNativeSessionTitle(input.title);
}

function renameReplayMismatch(): BackendError {
  return grokError(
    "rejected",
    "The Grok rename was replayed with another title.",
    "grok_rename_replay_mismatch",
  );
}

function mapRenameError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof AcpRemoteError) {
    return grokError(
      error.remoteCode === -32601 ? "incompatible_protocol" : "rejected",
      error.remoteCode === -32601
        ? "The Grok installation does not provide native session rename."
        : "Grok rejected the requested title.",
      error.remoteCode === -32601
        ? "grok_rename_method_not_found"
        : `grok_remote_${error.remoteCode}`,
      false,
      error,
    );
  }
  if (error instanceof AcpDeliveryError) {
    if (error.delivery === "not_sent") {
      return grokError(
        "unavailable",
        "Grok was unavailable before the rename was sent.",
        "grok_rename_not_sent",
        true,
        error,
      );
    }
    return grokError(
      "submission_unknown",
      "Grok may have applied the title, but Sedes could not confirm it safely.",
      "grok_rename_outcome_unknown",
      false,
      error,
      true,
    );
  }
  if (error instanceof AcpBindingError) {
    if (error.code === "acp_binding_overloaded") {
      return grokError(
        "overloaded",
        "The Grok connection is overloaded before rename.",
        error.code,
        true,
        error,
      );
    }
    if (
      error.code === "acp_binding_protocol_violation" ||
      error.code === "acp_binding_capability_denied"
    ) {
      return grokError(
        "incompatible_protocol",
        "The Grok installation does not provide compatible native rename support.",
        error.code,
        false,
        error,
      );
    }
  }
  return grokError(
    "unavailable",
    "Grok is unavailable before rename.",
    "grok_rename_unavailable",
    true,
    error,
  );
}

function validateSubmissionInput(input: SubmitTurnInput): void {
  const invalidIdentity =
    !bounded(input.applicationOperationId, 160) ||
    !bounded(input.mutationId, 160) ||
    !bounded(input.reconciliationToken, 4_096);
  if (invalidIdentity) {
    throw grokError(
      "rejected",
      "The Grok submission identity is invalid.",
      "grok_submission_identity_invalid",
    );
  }
  if (
    input.source.kind !== "user" ||
    input.selectedSkillId !== undefined ||
    input.contextExcerpts.length !== 0 ||
    input.taskContexts.length !== 0 ||
    input.attachments.some(
      (attachment) =>
        !stagedComposerAttachmentSchema.safeParse(attachment).success,
    )
  ) {
    throw grokError(
      "rejected",
      "Grok accepts only direct user text and normalized staged attachments.",
      "grok_submission_input_unsupported",
    );
  }
  if (
    !validGrokSubmissionText(input.text) ||
    (deliverableGrokText(input.text).length === 0 &&
      input.attachments.length === 0)
  ) {
    throw grokError(
      "rejected",
      "The Grok submission has no valid text or attachment input.",
      "grok_submission_text_invalid",
    );
  }
  const text = deliverableGrokText(input.text);
  if (text && /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/u.test(text.trimStart())) {
    throw grokError(
      "rejected",
      "Grok slash commands are not supported through this backend.",
      "grok_slash_command_unsupported",
    );
  }
}

function validGrokSubmissionText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

function deliverableGrokText(value: string): string {
  return value.trim().length > 0 ? value : "";
}

function resolveGrokSubmissionAttachments(
  input: SubmitTurnInput,
): readonly CanonicalComposerAttachmentEvidence[] {
  if (input.attachments.length === 0) {
    let evidence: readonly CanonicalComposerAttachmentEvidence[];
    try {
      evidence = input.attachmentEvidence?.resolve() ?? [];
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw attachmentEvidenceMismatch(error);
    }
    if (evidence.length !== 0) throw attachmentEvidenceMismatch();
    return Object.freeze([]);
  }
  if (!input.attachmentEvidence) {
    throw grokError(
      "invalid_state",
      "Grok attachment delivery is missing canonical attachment authority.",
      "grok_attachment_delivery_authority_missing",
    );
  }
  let canonicalEvidence: readonly CanonicalComposerAttachmentEvidence[];
  try {
    canonicalEvidence = input.attachmentEvidence.resolve();
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError(
      {
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "A referenced attachment is no longer available.",
        backendCode: "grok_attachment_evidence_unavailable",
      },
      { cause: error },
    );
  }
  if (canonicalEvidence.length !== input.attachments.length) {
    throw attachmentEvidenceMismatch();
  }
  for (let index = 0; index < canonicalEvidence.length; index += 1) {
    const staged = input.attachments[index];
    const canonical = canonicalEvidence[index];
    const canonicalDescriptor = canonical && {
      id: canonical.id,
      kind: canonical.kind,
      fileName: canonical.fileName,
      mediaType: canonical.mediaType,
      byteSize: canonical.byteSize,
    };
    if (
      !staged ||
      !canonical ||
      !composerAttachmentDescriptorSchema.safeParse(canonicalDescriptor)
        .success ||
      !/^[0-9a-f]{64}$/u.test(canonical.sha256) ||
      staged.id !== canonical.id ||
      staged.kind !== canonical.kind ||
      staged.fileName !== canonical.fileName ||
      staged.mediaType !== canonical.mediaType ||
      staged.byteSize !== canonical.byteSize ||
      staged.sha256 !== canonical.sha256 ||
      typeof staged.agentPath !== "string" ||
      staged.agentPath.length === 0 ||
      staged.agentPath.length > 4_096 ||
      staged.agentPath.includes("\0")
    ) {
      throw attachmentEvidenceMismatch();
    }
  }
  return Object.freeze([...canonicalEvidence]);
}

async function grokPromptContent(
  input: SubmitTurnInput,
  attachmentEvidence: readonly CanonicalComposerAttachmentEvidence[],
  text: string,
): Promise<PromptRequest["prompt"]> {
  const content: PromptRequest["prompt"][number][] = [];
  if (text) content.push({ type: "text", text });
  for (let index = 0; index < attachmentEvidence.length; index += 1) {
    const attachment = input.attachments[index];
    const evidence = attachmentEvidence[index];
    if (!attachment || !evidence) throw attachmentEvidenceMismatch();
    if (evidence.kind === "file") {
      content.push({
        type: "resource_link",
        name: evidence.fileName,
        uri: `file://${attachment.agentPath}`,
        mimeType: evidence.mediaType,
        size: evidence.byteSize,
      });
      continue;
    }
    if (
      !COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES.includes(
        evidence.mediaType as (typeof COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES)[number],
      )
    ) {
      throw attachmentEvidenceMismatch();
    }
    const reader = input.attachmentBytes;
    if (!reader) throw attachmentEvidenceMismatch();
    let bytes: Buffer;
    try {
      bytes = await reader.read(attachment);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        {
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "The attachment content could not be read safely.",
          backendCode: "grok_attachment_read_failed",
        },
        { cause: error },
      );
    }
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength !== evidence.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== evidence.sha256
    ) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "A referenced attachment failed its integrity check.",
        backendCode: "grok_attachment_integrity_mismatch",
      });
    }
    content.push({
      type: "image",
      mimeType: evidence.mediaType,
      data: bytes.toString("base64"),
    });
  }
  return content;
}

function attachmentEvidenceMismatch(cause?: unknown): BackendError {
  return grokError(
    "invalid_state",
    "A referenced attachment changed before Grok delivery.",
    "grok_attachment_evidence_mismatch",
    false,
    cause,
  );
}

function submissionFingerprint(
  input: SubmitTurnInput,
  attachmentEvidence: readonly CanonicalComposerAttachmentEvidence[],
): string {
  return createHash("sha256")
    .update("sedes.grok-submission.input.v1\n")
    .update(
      JSON.stringify({
        applicationOperationId: input.applicationOperationId,
        mutationId: input.mutationId,
        source: input.source,
        reconciliationToken: input.reconciliationToken,
        text: input.text,
        selectedSkillId: input.selectedSkillId ?? null,
        contextExcerpts: input.contextExcerpts,
        taskContexts: input.taskContexts,
        attachments: attachmentEvidence.map((attachment, order) => ({
          order,
          ...attachment,
        })),
      }),
    )
    .digest("base64url");
}

function exactTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function grokProjectionEvents(
  prior: BackendConversationSnapshot,
  next: BackendConversationSnapshot,
): readonly BackendConversationEvent[] | undefined {
  if (
    !identifierPrefix(prior.orderedBackendTurnIds, next.orderedBackendTurnIds)
  ) {
    return undefined;
  }
  const events: BackendConversationEvent[] = [];
  for (const backendTurnId of next.orderedBackendTurnIds) {
    const nextTurn = next.turnsById[backendTurnId];
    if (!nextTurn) return undefined;
    const priorTurn = prior.turnsById[backendTurnId];
    if (!priorTurn) {
      events.push({
        type: "turn_started",
        turn: streamingTurn(nextTurn),
      });
      for (const backendItemId of nextTurn.orderedBackendItemIds) {
        const item = next.itemsById[backendItemId];
        if (!item) return undefined;
        events.push(newItemEvent(item));
      }
      if (nextTurn.status !== "in_progress") {
        events.push({ type: "turn_completed", turn: nextTurn });
      }
      continue;
    }
    if (
      priorTurn.status !== "in_progress" &&
      !sameProjectionValue(priorTurn, nextTurn)
    ) {
      return undefined;
    }
    if (
      !identifierPrefix(
        priorTurn.orderedBackendItemIds,
        nextTurn.orderedBackendItemIds,
      )
    ) {
      return undefined;
    }
    for (const backendItemId of nextTurn.orderedBackendItemIds) {
      const nextItem = next.itemsById[backendItemId];
      if (!nextItem) return undefined;
      const priorItem = prior.itemsById[backendItemId];
      if (!priorItem) {
        events.push(newItemEvent(nextItem));
        continue;
      }
      if (sameProjectionValue(priorItem, nextItem)) continue;
      if (priorItem.status !== "streaming") return undefined;
      events.push({
        type:
          nextItem.status === "streaming" ? "item_updated" : "item_completed",
        item: nextItem,
      });
    }
    if (!sameProjectionValue(priorTurn, nextTurn)) {
      events.push({
        type:
          nextTurn.status === "in_progress" ? "turn_updated" : "turn_completed",
        turn: nextTurn,
      });
    }
  }
  if (
    prior.runState !== next.runState ||
    prior.activeBackendTurnId !== next.activeBackendTurnId
  ) {
    events.push({
      type: "run_state_changed",
      state: next.runState,
      ...(next.activeBackendTurnId
        ? { activeBackendTurnId: next.activeBackendTurnId }
        : {}),
    });
  }
  return events;
}

function appendGrokLiveText(
  prior: BackendItem | undefined,
  record: GrokHistoryTextRecord,
): BackendItem | undefined {
  if (!prior || prior.status !== "streaming") return undefined;
  if (
    record.kind === "assistant_text" &&
    prior.semanticKind === "assistant_message"
  ) {
    if (record.text.text.length === 0) return prior;
    return Object.freeze({
      ...prior,
      markdown: preserveMessageText(prior.markdown.text + record.text.text),
    });
  }
  if (record.kind === "reasoning" && prior.semanticKind === "reasoning") {
    if (record.text.text.length === 0) return prior;
    const markdown = boundText(prior.markdown.text + record.text.text);
    if (
      markdown.text === prior.markdown.text &&
      markdown.truncation?.retainedBytes === prior.markdown.truncation?.retainedBytes &&
      markdown.truncation?.reason === prior.markdown.truncation?.reason
    ) return prior;
    return Object.freeze({
      ...prior,
      markdown,
    });
  }
  return undefined;
}

function newItemEvent(item: BackendItem): BackendConversationEvent {
  return {
    type: item.status === "streaming" ? "item_started" : "item_completed",
    item,
  };
}

function streamingTurn(turn: BackendTurn): BackendTurn {
  if (turn.status === "in_progress") return turn;
  const { endedBy: _endedBy, completedAt: _completedAt, ...rest } = turn;
  return { ...rest, status: "in_progress" };
}

function identifierPrefix(
  prior: readonly string[],
  next: readonly string[],
): boolean {
  return (
    prior.length <= next.length &&
    prior.every((identifier, index) => next[index] === identifier)
  );
}

function sameProjectionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeRetryAnchor(
  scopeFingerprint: string,
  transcriptFingerprint: string,
): string {
  return JSON.stringify({
    version: 1,
    scopeFingerprint,
    transcriptFingerprint,
  });
}

function parseRetryAnchor(value: string | undefined):
  | {
      readonly scopeFingerprint: string;
      readonly transcriptFingerprint: string;
    }
  | undefined {
  if (
    value === undefined ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 3 ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("scopeFingerprint" in parsed) ||
      typeof parsed.scopeFingerprint !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed.scopeFingerprint) ||
      !("transcriptFingerprint" in parsed) ||
      typeof parsed.transcriptFingerprint !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed.transcriptFingerprint)
    ) {
      return undefined;
    }
    return {
      scopeFingerprint: parsed.scopeFingerprint,
      transcriptFingerprint: parsed.transcriptFingerprint,
    };
  } catch {
    return undefined;
  }
}

function submissionScopeFingerprint(
  scope: GrokSubmissionCorrelationScope,
): string {
  return submissionScopeFingerprintForDomain(
    scope,
    "sedes.grok-submission.anchor-scope.v1\n",
  );
}

function submissionScopeFingerprintMatches(
  received: string,
  scope: GrokSubmissionCorrelationScope,
): boolean {
  return [
    submissionScopeFingerprint(scope),
    submissionScopeFingerprintForDomain(
      scope,
      "harness.grok-submission.anchor-scope.v1\n",
    ),
  ].some((expected) => {
    const receivedBytes = Buffer.from(received, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      receivedBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(receivedBytes, expectedBytes)
    );
  });
}

function submissionScopeFingerprintForDomain(
  scope: GrokSubmissionCorrelationScope,
  domain: string,
): string {
  return createHash("sha256")
    .update(domain)
    .update(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        scope.backendInstanceId,
        scope.connectionProfileId,
        scope.executionEnvironmentId,
        scope.nativeNamespaceKey,
        scope.canonicalWorkspacePath,
        scope.sessionId,
      ]),
    )
    .digest("base64url");
}

function mapSubmissionError(
  error: unknown,
  providerContacted: boolean,
): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof GrokPromptOutcomeUnknownError) {
    return grokError(
      "submission_unknown",
      "Grok may have accepted the submission, but Sedes could not confirm it safely.",
      error.code,
      false,
      error,
      true,
    );
  }
  if (error instanceof AcpRemoteError) {
    return grokError(
      error.remoteCode === -32601 ? "incompatible_protocol" : "rejected",
      error.remoteCode === -32601
        ? "The Grok installation does not provide prompt submission."
        : "Grok rejected the submission.",
      error.remoteCode === -32601
        ? "grok_prompt_method_not_found"
        : `grok_remote_${error.remoteCode}`,
      false,
      error,
    );
  }
  if (error instanceof AcpDeliveryError && error.delivery === "not_sent") {
    return grokError(
      "unavailable",
      "Grok was unavailable before the submission was sent.",
      "grok_submission_not_sent",
      true,
      error,
    );
  }
  if (
    error instanceof Error &&
    error.message === "grok_prompt_content_invalid"
  ) {
    return grokError(
      "rejected",
      "The Grok prompt content is invalid.",
      "grok_prompt_content_invalid",
      false,
      error,
    );
  }
  if (!providerContacted) {
    return grokError(
      error instanceof AcpBindingError &&
        error.code === "acp_binding_overloaded"
        ? "overloaded"
        : "unavailable",
      "Grok was unavailable before submission.",
      error instanceof AcpBindingError
        ? error.code
        : "grok_submission_unavailable",
      true,
      error,
    );
  }
  return grokError(
    "submission_unknown",
    "Grok may have accepted the submission, but Sedes could not confirm it safely.",
    "grok_submission_outcome_unknown",
    false,
    error,
    true,
  );
}

function mapInterruptError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (
    error instanceof Error &&
    (error.message === "grok_prompt_interrupt_target_invalid" ||
      error.message === "grok_prompt_interrupt_target_changed")
  ) {
    return grokError(
      "invalid_state",
      "The active Grok turn changed before interrupt.",
      "grok_interrupt_target_changed",
    );
  }
  if (error instanceof AcpDeliveryError) {
    if (error.delivery === "not_sent") {
      return grokError(
        "unavailable",
        "Grok was unavailable before the interrupt was sent.",
        "grok_interrupt_not_sent",
        true,
        error,
      );
    }
    return interruptOutcomeUnknown(error);
  }
  if (error instanceof AcpBindingError) {
    if (
      error.code === "acp_binding_protocol_violation" ||
      error.code === "acp_binding_capability_denied"
    ) {
      return grokError(
        "incompatible_protocol",
        "The Grok installation does not provide compatible interrupt support.",
        error.code,
        false,
        error,
      );
    }
    if (error.code === "acp_binding_overloaded") {
      return grokError(
        "overloaded",
        "The Grok connection is overloaded before interrupt.",
        error.code,
        true,
        error,
      );
    }
  }
  return grokError(
    "unavailable",
    "Grok is unavailable before interrupt.",
    "grok_interrupt_unavailable",
    true,
    error,
  );
}

function interruptOutcomeUnknown(cause?: unknown): BackendError {
  return grokError(
    "submission_unknown",
    "Grok may have received the interrupt, but Sedes could not confirm it safely.",
    "grok_interrupt_outcome_unknown",
    false,
    cause,
    true,
  );
}

function validateInterruptInput(input: InterruptTurnInput): void {
  if (
    !bounded(input.applicationOperationId, 160) ||
    !bounded(input.expectedBackendTurnId, 512)
  ) {
    throw grokError(
      "rejected",
      "The Grok interrupt identity is invalid.",
      "grok_interrupt_identity_invalid",
    );
  }
}

function unresolved(diagnostic: string): SubmissionReconciliation {
  return { status: "unresolved", diagnostic: boundDisplayText(diagnostic) };
}

function modelConfigurationUnavailable(): BackendError {
  return grokError(
    "incompatible_protocol",
    "The Grok session model configuration is unavailable or outside the configured policy.",
    "grok_session_model_configuration_unavailable",
  );
}

function grokError(
  category: ConstructorParameters<typeof BackendError>[0]["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  cause?: unknown,
  crossedSubmissionBoundary = false,
): BackendError {
  return new BackendError(
    {
      category,
      retryable,
      crossedSubmissionBoundary,
      safeMessage,
      backendCode,
    },
    cause === undefined ? undefined : { cause },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function bounded(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function normalizedTimestamp(value: string | undefined): string {
  if (
    !value ||
    Buffer.byteLength(value) > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    throw new Error("grok_discovery_timestamp_invalid");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error("grok_discovery_timestamp_invalid");
  }
  return value;
}

function stableToken(label: string, values: readonly unknown[]): string {
  return `${label}:${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("base64url")}`;
}
