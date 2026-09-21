import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  BackendCapabilityDocument,
  BackendConversationEvent,
  BackendConversationSnapshot,
  SequencedBackendEvent,
} from "../../../shared/protocol/backend.js";
import {
  backendConversationSnapshotSchema,
  backendHistoryPageSchema,
  backendItemSchema,
  backendTurnSchema,
} from "../../../shared/protocol/backend.js";
import {
  hasDeliverableComposerInput,
  type UsageSnapshot,
} from "../../../shared/protocol/conversation.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import {
  boundedDisplayTextSchema,
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../../shared/protocol/payload.js";
import type {
  BackendActionResult,
  BackendMutationReconciliation,
  BackendEventListener,
  BackendHistoryPage,
  ConversationBinding,
  ConversationHandle,
  EstablishedBackendProjection,
  EstablishProjectionInput,
  HistoryPageInput,
  InteractionResponseInput,
  InterruptTurnInput,
  LocateTurnInput,
  LocateTurnResult,
  RegisteredBackendActionInput,
  SteerTurnInput,
  SteerTurnResult,
  SubmitTurnInput,
  SubmitTurnResult,
  Unsubscribe,
} from "../contracts.js";
import { BackendError } from "../contracts.js";
import type { ExecutionScope } from "../../execution/contracts.js";
import type { OutputArtifactPublisher } from "../../output-artifacts/contracts.js";
import type {
  CodexClientLifecycleSnapshot,
  CodexLifecycleListener,
  CodexNotificationListener,
  CodexSharedClientFacade,
} from "./codex-client-facade.js";
import {
  assertCodexAttestedServerNotificationParams,
  CodexAppServerBindingError,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  CODEX_C1_MAX_ITEMS_PER_TURN,
  codexThreadReadMethod,
  codexThreadResumeMethod,
  codexThreadUnsubscribeMethod,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadResumeResponse,
  type CodexTurn,
} from "./codex-c1-protocol.js";
import {
  CodexPaginatedHistoryAdapter,
  type CodexPaginatedNativePage,
} from "./codex-paginated-history-adapter.js";
import { CODEX_HISTORY_TIMEOUT_MILLISECONDS } from "./codex-history-timeouts.js";
import { isCodexDiscoverableThread } from "./codex-thread-binding.js";
import {
  codexC2NotificationSchemas,
  codexThreadCompactStartMethod,
  codexThreadSetNameMethod,
  codexThreadSettingsUpdateMethod,
  codexTurnInterruptMethod,
  codexTurnStartMethod,
  codexTurnSteerMethod,
  isCodexC2NotificationMethod,
  type CodexC2NotificationMethod,
} from "./codex-c2-protocol.js";
import {
  defaultCodexComposerSkillPreferenceReader,
  resolveCodexSkill,
  type CodexComposerSkillPreferenceReader,
} from "./codex-skills.js";
import {
  codexContextExcerptCarrier,
  codexContextExcerptFingerprint,
} from "./codex-context-excerpts.js";
import { codexTaskContextFingerprint } from "./codex-task-contexts.js";
import {
  stagedAttachmentFingerprint,
  stagedAttachmentManifest,
} from "../staged-attachment-manifest.js";
import {
  CodexHistoryProjectionError,
  codexNativeItemCoordinate,
  codexBackendTurnId,
  materializeCodexGeneratedImagePublications,
  projectCodexItemSlice,
  projectCodexHistory,
  projectCodexUsage,
  selectCodexNativeHistorySlice,
  type CodexHistoryProjection,
  type CodexProjectedItemCoordinate,
  type CodexStreamingNativeItems,
} from "./codex-history-projector.js";
import {
  CodexLiveProjectionOverlay,
  type CodexLiveProjectionFlushItem,
  type CodexLiveProjectionSeed,
} from "./codex-live-projection-overlay.js";
import { CodexProjectionWorkQueue } from "./codex-projection-work-queue.js";
import {
  codexClientUserMessageId,
  copyCodexSubmissionCorrelationKey,
  type CodexSubmissionCorrelationScope,
} from "./codex-submission-correlation.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./rpc/errors.js";
import { isCodexRpcUndecodableNotification } from "./rpc/codex-rpc-client.js";
import {
  CodexInteractionBridge,
  CodexInteractionBridgeError,
} from "./codex-interaction-bridge.js";
import type {
  CodexServerRequestRoute,
  CodexServerRequestRouter,
} from "./codex-server-request-router.js";
import {
  codexExecutionPolicy,
  isCodexApprovalPolicy,
  isCodexApprovalReviewer,
  type CodexApprovalPolicy,
  type CodexApprovalReviewer,
  type CodexNetworkAccess,
  type CodexSandboxMode,
} from "./codex-execution-policy.js";
import {
  withCodexAgentToolCliEnvironment,
  withCodexExecutionEnvironment,
  type CodexAgentToolCliEnvironmentProvider,
  type CodexAgentToolCliEnvironmentResolution,
} from "./codex-agent-tool-cli-environment.js";
import type { CodexExecutionSettingsTuple } from "./codex-thread-execution-settings-repository.js";
import {
  decodeCodexServiceTier,
  encodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";
import type { CodexForkSettingsEligibility } from "./codex-fork-settings-eligibility.js";
import {
  availableCodexGoalActionIds,
  CODEX_GOAL_FEATURE_REF,
  desiredPostconditionForCodexGoalAction,
  type CodexGoalActionId,
} from "./codex-goal-feature.js";
import type { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import {
  refineCodexThreadGoalClearedNotification,
  refineCodexThreadGoalUpdatedNotification,
} from "./codex-goal-protocol.js";
import {
  CodexFastModeSessionRegistry,
  type CodexFastModeProjection,
} from "./codex-fast-mode-session.js";
import {
  CODEX_TUI_FEATURE_REF,
  type CodexTuiActionId,
} from "./codex-tui-feature.js";

export type { CodexExecutionSettingsTuple };

interface CodexObservedExecutionSettingsBase {
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: CodexServiceTierSelection | null;
  readonly serviceTierClassification: "recognized" | "external_custom";
  readonly sandboxMode: CodexSandboxMode | null;
  readonly sandboxClassification: "recognized" | "external_custom";
  readonly networkAccess: CodexNetworkAccess | null;
  readonly networkClassification: "recognized" | "external_custom";
  readonly approvalPolicy: CodexApprovalPolicy | null;
  readonly approvalPolicyClassification: "recognized" | "external_custom";
  readonly approvalReviewer: CodexApprovalReviewer | null;
  readonly approvalReviewerClassification: "recognized" | "external_custom";
}

export type CodexObservedExecutionSettings =
  CodexObservedExecutionSettingsBase & {
    readonly policyObservation: "complete" | "incomplete";
  };

/**
 * Backend-owned execution-settings authority. The driver never imports the
 * SQLite repository; composition may provide it directly or through a thin
 * adapter while tests can prove the exact provider boundary independently.
 */
export interface CodexExecutionSettingsProvider {
  desiredSettings(
    scope: ExecutionScope,
    applicationThreadId: string,
  ): CodexExecutionSettingsTuple | null;
  resolveFastModeDisabled(
    scope: ExecutionScope,
    input: { readonly applicationThreadId: string; readonly now: number },
  ): CodexExecutionSettingsTuple | null;
  forkSettingsEligibility(
    scope: ExecutionScope,
    applicationThreadId: string,
  ): CodexForkSettingsEligibility;
  freezeOperationSnapshot(
    scope: ExecutionScope,
    input: {
      readonly applicationThreadId: string;
      readonly applicationOperationId: string;
      readonly source: SubmitTurnInput["source"];
      readonly now: number;
    },
  ):
    | { readonly settings: CodexExecutionSettingsTuple }
    | Promise<{ readonly settings: CodexExecutionSettingsTuple }>;
  observeEffective(
    scope: ExecutionScope,
    input: {
      readonly applicationThreadId: string;
      readonly settings: CodexObservedExecutionSettings;
      readonly initializeDesired?: CodexExecutionSettingsTuple;
      readonly confirmationGeneration: number;
      readonly now: number;
    },
  ): void;
  markEffectiveUnknown(
    scope: ExecutionScope,
    input: { readonly applicationThreadId: string; readonly now: number },
  ): void;
}

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_UNSUBSCRIBE_ATTEMPTS = 2;
const MAXIMUM_ESTABLISHMENT_ATTEMPTS = 5;
const MAXIMUM_EVENT_JOURNAL = 256;
const MAXIMUM_PAGINATED_ESTABLISHMENT_NOTIFICATIONS = 1_000;
const MAXIMUM_PAGINATED_ESTABLISHMENT_NOTIFICATION_BYTES =
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES;
const SNAPSHOT_TURN_LIMIT = 10;
const HISTORY_PAGE_LIMIT = 500;
const MAXIMUM_RETRY_ANCHOR_BYTES = 4_096;
const RETRY_ANCHOR_PREFIX = "codex-retry-anchor:";
const CODEX_LIVE_PROJECTION_INTERVAL_MILLISECONDS = 50;
const CODEX_AUTH_RECOVERY_STARTED_NOTICE =
  "Codex is recovering model provider authentication.";
const CODEX_AUTH_RECOVERY_COMPLETED_NOTICE =
  "Codex recovered model provider authentication.";

type EventSubscriber = {
  readonly after: number;
  readonly listener: BackendEventListener;
};

type CodexSettingsObservationReceipt = {
  readonly generation: number;
  readonly inboundSequence: number;
  readonly modelProvider: string;
  readonly settings: CodexObservedExecutionSettings;
};

type CodexStableResumeProjection = {
  readonly snapshot: BackendConversationSnapshot;
  readonly history: EstablishedBackendProjection["history"];
  readonly generation: number;
  readonly inboundSequence: number;
};

type CodexWindowProjection = CodexHistoryProjection & {
  readonly startNativeTurnIndex: number;
};

export interface CodexConversationHandleInput {
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly binding: ConversationBinding;
  readonly canonicalWorkspacePath: string;
  readonly workspaceId: string;
  readonly opaqueBindingDetail: string;
  readonly client: CodexSharedClientFacade;
  readonly serverRequests: CodexServerRequestRouter;
  readonly toolProvenanceKey: Uint8Array;
  readonly correlationAncestorThreadIds: readonly string[];
  readonly executionSettings: CodexExecutionSettingsProvider;
  readonly outputArtifacts: OutputArtifactPublisher;
  readonly fastModeSessions?: CodexFastModeSessionRegistry;
  readonly agentToolCliEnvironment?: CodexAgentToolCliEnvironmentProvider;
  readonly composerSkillPreferences?: CodexComposerSkillPreferenceReader;
  readonly validateExecutionSettings: (
    settings: CodexExecutionSettingsTuple,
  ) => Promise<readonly ("text" | "image")[] | undefined>;
  readonly assertModelPolicyAllowed?: (
    model: string,
    reasoningEffort: string,
  ) => void;
  readonly resolveImportedReasoningEffort: (
    model: string,
    observedReasoningEffort: string | null,
  ) => Promise<string | undefined>;
  readonly resolveModelInputModalities?: (
    model: string,
    fresh: boolean,
  ) => Promise<readonly ("text" | "image")[]>;
  /** Shared Goal projection registry for this backend instance. */
  readonly goalSessions?: CodexGoalSessionRegistry;
  readonly managedTui?: import("./codex-managed-tui-controller.js").CodexManagedTuiController;
  readonly now?: () => number;
  readonly releaseOwnership: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A logical thread attachment over the principal/profile-shared Codex client.
 *
 * The handle owns no process. Generation loss is projected immediately, and
 * replacement generations are reconciled through a complete, bounded native
 * history before any replacement snapshot is published.
 */
export class CodexConversationHandle implements ConversationHandle {
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly binding: ConversationBinding;
  readonly #canonicalWorkspacePath: string;
  readonly #workspaceId: string;
  readonly #opaqueBindingDetail: string;
  readonly #client: CodexSharedClientFacade;
  readonly #executionSettings: CodexExecutionSettingsProvider;
  readonly #outputArtifacts: OutputArtifactPublisher;
  readonly #verifiedGeneratedImagePublicationKeys = new Set<string>();
  readonly #fastModeSessions: CodexFastModeSessionRegistry;
  readonly #agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider;
  #agentToolCliEnvironmentLease:
    | Extract<
        CodexAgentToolCliEnvironmentResolution,
        { readonly availability: "available" }
      >
    | undefined;
  readonly #composerSkillPreferences: CodexComposerSkillPreferenceReader;
  readonly #validateExecutionSettingsForTurn: (
    settings: CodexExecutionSettingsTuple,
  ) => Promise<readonly ("text" | "image")[] | undefined>;
  readonly #assertModelPolicyAllowed: (
    model: string,
    reasoningEffort: string,
  ) => void;
  readonly #resolveImportedReasoningEffort: (
    model: string,
    observedReasoningEffort: string | null,
  ) => Promise<string | undefined>;
  readonly #resolveModelInputModalities: (
    model: string,
    fresh: boolean,
  ) => Promise<readonly ("text" | "image")[]>;
  readonly #goalSessions: CodexGoalSessionRegistry | undefined;
  readonly #managedTui:
    | import("./codex-managed-tui-controller.js").CodexManagedTuiController
    | undefined;
  readonly #managedTuiRuntimeLeaseId = randomUUID();
  readonly #now: () => number;
  readonly #correlationScope: CodexSubmissionCorrelationScope;
  readonly #interactions: CodexInteractionBridge;
  readonly #releaseOwnership: () => void;
  readonly #runtimeLease: { release(evicted?: boolean): Promise<void> } | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #projectionWorkQueue: CodexProjectionWorkQueue;
  readonly #liveProjectionOverlay: CodexLiveProjectionOverlay;
  readonly #listeners = new Set<(event: BackendConversationEvent) => void>();
  #notificationWork = Promise.resolve();
  #pendingNotificationWork = 0;
  readonly #eventSubscribers = new Set<EventSubscriber>();
  readonly #journal: SequencedBackendEvent[] = [];
  readonly #unsubscribeNotifications: Unsubscribe;
  readonly #unsubscribeLifecycle: Unsubscribe;
  readonly #unsubscribeManagedTui: Unsubscribe;
  #nextHandleSequence = 0;
  #lastMutationInboundSequence = 0;
  #lastMutationGeneration = 0;
  #lastUnreplayableEstablishmentMutationSequence = 0;
  #lastUnreplayableEstablishmentMutationGeneration = 0;
  #paginatedEstablishmentNotifications: {
    readonly notification: Parameters<CodexNotificationListener>[0];
    readonly bytes: number;
  }[] = [];
  #paginatedEstablishmentNotificationBytes = 0;
  #paginatedEstablishmentNotificationOverflow:
    | { readonly generation: number | null; readonly throughSequence: number }
    | undefined;
  #paginatedEstablishmentCatchUp:
    { readonly generation: number; readonly afterSequence: number } | undefined;
  #paginatedEstablishmentCatchUpDraining = false;
  #replayingPaginatedEstablishmentNotification = false;
  #lastGoalNotificationInboundSequence = 0;
  #lastGoalNotificationGeneration = 0;
  #lastSettingsObservationInboundSequence = 0;
  #lastSettingsObservationGeneration = 0;
  #lastSettingsObservation: CodexSettingsObservationReceipt | undefined;
  #appliedSettingsObservationInboundSequence = 0;
  #appliedSettingsObservationGeneration = 0;
  #desiredInitializationSettled: Promise<void> | undefined;
  #projectionEpoch = 0;
  #projectionSubscriptionClaimed = false;
  #establishing = false;
  #establishmentSettled: Promise<void> | undefined;
  #establishedGeneration = 0;
  #subscribedGeneration = 0;
  #snapshotWindow: BackendConversationSnapshot | undefined;
  #projectedItemByNativeCoordinate = new Map<
    string,
    CodexProjectedItemCoordinate
  >();
  #projectedItemCount = 0;
  #projectionSerializedBytes = 0;
  #projectionInstallEpoch = 0;
  #projectionInvalidated = false;
  #terminalErrorRecoveryGeneration: number | undefined;
  #terminalErrorFallbackThread: CodexThread | undefined;
  #failureFencedGeneration: number | undefined;
  #nativeThread: CodexThread | undefined;
  #paginatedHistoryAdapter: CodexPaginatedHistoryAdapter | undefined;
  #paginatedHistoryPreviousCursor: string | undefined;
  #nativeTurnById = new Map<string, CodexThread["turns"][number]>();
  #streamingNativeItems = new Map<string, Set<string>>();
  #historyNonce = randomUUID();
  #usage: UsageSnapshot = {};
  #usageGeneration = 0;
  #model:
    | {
        readonly provider: string;
        readonly id: string;
        readonly reasoningEffort?: string;
      }
    | undefined;
  #modelInputModalities: readonly ("text" | "image")[] = ["text"];
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #mutationInFlight = false;
  readonly #compactOperations = new Map<
    string,
    "accepted" | "outcome_unknown"
  >();
  readonly #interruptOperations = new Map<string, string>();
  readonly #submitOperations = new Map<
    string,
    | {
        readonly reconciliationToken: string;
        readonly source: SubmitTurnInput["source"];
        readonly selectedSkillId: string | undefined;
        readonly taskContextsFingerprint: string;
        readonly contextExcerptsFingerprint: string;
        readonly attachmentsFingerprint: string;
        readonly state: "outcome_unknown";
      }
    | {
        readonly reconciliationToken: string;
        readonly source: SubmitTurnInput["source"];
        readonly selectedSkillId: string | undefined;
        readonly taskContextsFingerprint: string;
        readonly contextExcerptsFingerprint: string;
        readonly attachmentsFingerprint: string;
        readonly state: "accepted";
        readonly result: SubmitTurnResult;
      }
  >();
  readonly #steerOperations = new Map<
    string,
    | {
        readonly reconciliationToken: string;
        readonly selectedSkillId: string | undefined;
        readonly taskContextsFingerprint: string;
        readonly contextExcerptsFingerprint: string;
        readonly attachmentsFingerprint: string;
        readonly state: "outcome_unknown";
      }
    | {
        readonly reconciliationToken: string;
        readonly selectedSkillId: string | undefined;
        readonly taskContextsFingerprint: string;
        readonly contextExcerptsFingerprint: string;
        readonly attachmentsFingerprint: string;
        readonly state: "accepted";
        readonly result: SteerTurnResult;
      }
  >();

  constructor(input: CodexConversationHandleInput) {
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.binding = input.binding;
    this.#canonicalWorkspacePath = input.canonicalWorkspacePath;
    this.#workspaceId = input.workspaceId;
    this.#opaqueBindingDetail = input.opaqueBindingDetail;
    this.#client = input.client;
    this.#executionSettings = input.executionSettings;
    this.#outputArtifacts = input.outputArtifacts;
    this.#fastModeSessions =
      input.fastModeSessions ?? new CodexFastModeSessionRegistry();
    this.#agentToolCliEnvironment =
      input.agentToolCliEnvironment ??
      Object.freeze({
        acquire: async () =>
          Object.freeze({
            availability: "unavailable" as const,
            reason: "unverifiable_thread_context" as const,
          }),
      });
    this.#composerSkillPreferences =
      input.composerSkillPreferences ??
      defaultCodexComposerSkillPreferenceReader;
    this.#validateExecutionSettingsForTurn = input.validateExecutionSettings;
    this.#assertModelPolicyAllowed =
      input.assertModelPolicyAllowed ?? (() => undefined);
    this.#resolveImportedReasoningEffort = input.resolveImportedReasoningEffort;
    this.#resolveModelInputModalities =
      input.resolveModelInputModalities ?? (async () => ["text"]);
    this.#goalSessions = input.goalSessions;
    this.#managedTui = input.managedTui;
    this.#now = input.now ?? (() => Date.now());
    this.#correlationScope = {
      toolProvenanceKey: copyCodexSubmissionCorrelationKey(
        input.toolProvenanceKey,
      ),
      tenantId: input.binding.tenantId,
      principalId: input.binding.ownerPrincipalId,
      backendInstanceId: input.binding.backendInstanceId,
      nativeThreadId: input.binding.backendConversationId,
      correlationAncestorThreadIds: input.correlationAncestorThreadIds,
    };
    this.#releaseOwnership = input.releaseOwnership;
    this.#runtimeLease = input.client.residency?.retain();
    this.#onError = input.onError ?? (() => undefined);
    this.#projectionWorkQueue = new CodexProjectionWorkQueue(() => {
      this.#invalidateProjection("buffer_overflow");
    });
    this.#liveProjectionOverlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: CODEX_LIVE_PROJECTION_INTERVAL_MILLISECONDS,
      enqueue: (operation) => this.#projectionWorkQueue.enqueue(operation),
      onFlush: (items) => {
        const published = this.#flushLiveProjection(items);
        if (published === false) {
          this.#invalidateProjection("contradictory_state");
        }
        return published;
      },
      onInvalid: () => this.#invalidateProjection("buffer_overflow"),
    });
    this.#interactions = new CodexInteractionBridge({
      router: input.serverRequests,
      nativeThreadId: input.binding.backendConversationId,
      ownsRoute: (route) => this.#ownsServerRequestRoute(route),
      emit: (event) => this.#emit(event),
    });
    this.#unsubscribeNotifications = this.#client.subscribeNotifications(
      this.#consumeNotification,
    );
    this.#unsubscribeLifecycle = this.#client.subscribeLifecycle(
      this.#consumeLifecycle,
    );
    this.#unsubscribeManagedTui = this.#managedTui
      ? this.#managedTui.registry.subscribeState((authority) => {
          if (
            authority.scope.tenantId !== this.binding.tenantId ||
            authority.scope.principalId !== this.binding.ownerPrincipalId ||
            authority.applicationThreadId !==
              this.binding.applicationThreadId ||
            authority.backendInstanceId !== this.binding.backendInstanceId ||
            authority.connectionProfileId !==
              this.binding.connectionProfileId ||
            authority.executionEnvironmentId !==
              this.binding.executionEnvironmentId ||
            authority.backendConversationId !==
              this.binding.backendConversationId ||
            this.#establishedGeneration === 0 ||
            this.#closed
          ) {
            return;
          }
          this.#emit({
            type: "capabilities_changed",
            capabilities: this.#capabilities(),
          });
        })
      : () => undefined;
  }

  async establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    if (this.#establishing) {
      throw codexError(
        "invalid_state",
        "The Codex projection is already being reconciled.",
        "codex_projection_already_reconciling",
      );
    }
    if (input.signal.aborted) throw projectionCancelled(input.signal.reason);
    this.#establishing = true;
    this.#resetPaginatedEstablishmentNotifications();
    this.#verifiedGeneratedImagePublicationKeys.clear();
    // One cold-load budget spans metadata, resume, paginated hydration and
    // stabilization retries. A new provider request must not restart the clock.
    const deadlineController = new AbortController();
    const deadline = setTimeout(
      () => deadlineController.abort(new Error("codex_establishment_deadline")),
      CODEX_HISTORY_TIMEOUT_MILLISECONDS,
    );
    const signal = AbortSignal.any([input.signal, deadlineController.signal]);
    const operation = this.#establishProjectionUntilQuiet(signal);
    this.#establishmentSettled = operation.then(
      () => undefined,
      () => undefined,
    );
    let retainPaginatedCatchUp = false;
    try {
      let projection: Pick<CodexStableResumeProjection, "snapshot" | "history">;
      try {
        projection = await operation;
      } catch (error) {
        if (deadlineController.signal.aborted && !input.signal.aborted) {
          throw codexError(
            "unavailable",
            "Codex thread loading did not complete within the request deadline.",
            "codex_establishment_deadline",
            true,
            error,
          );
        }
        const fallback = this.#installExhaustedErrorProjection(error);
        if (!fallback) throw error;
        projection = fallback;
      }
      this.#assertOpen();
      this.#projectionEpoch += 1;
      this.#projectionSubscriptionClaimed = false;
      const epoch = this.#projectionEpoch;
      const handleSequence = this.#nextHandleSequence - 1;
      retainPaginatedCatchUp =
        this.#paginatedEstablishmentCatchUp !== undefined;
      return {
        handleSequence,
        snapshot: projection.snapshot,
        history: projection.history,
        subscribeFromNext: (listener) => {
          const unsubscribe = this.#subscribeFrom(
            epoch,
            handleSequence,
            listener,
          );
          this.#releasePaginatedEstablishmentNotifications();
          return unsubscribe;
        },
      };
    } finally {
      clearTimeout(deadline);
      this.#establishing = false;
      this.#establishmentSettled = undefined;
      if (retainPaginatedCatchUp) {
        this.#releasePaginatedEstablishmentNotifications();
      } else {
        this.#resetPaginatedEstablishmentNotifications();
      }
    }
  }

  async #establishProjectionUntilQuiet(
    signal: AbortSignal,
  ): Promise<Pick<CodexStableResumeProjection, "snapshot" | "history">> {
    for (
      let attempt = 0;
      attempt < MAXIMUM_ESTABLISHMENT_ATTEMPTS;
      attempt += 1
    ) {
      let resumed: CodexStableResumeProjection;
      try {
        resumed = await this.#readResumeUntilQuiet(signal);
      } catch (error) {
        const recoveryGeneration = this.#terminalErrorRecoveryGeneration;
        const lifecycle = this.#client.lifecycleSnapshot();
        if (
          recoveryGeneration === undefined ||
          lifecycle.state !== "ready" ||
          lifecycle.generation !== recoveryGeneration
        ) {
          throw error;
        }
        if (
          (error instanceof BackendError &&
            error.backendCode === "codex_projection_not_quiet") ||
          attempt === MAXIMUM_ESTABLISHMENT_ATTEMPTS - 1
        ) {
          throw codexError(
            "unavailable",
            "Codex history did not become stable during error reconciliation.",
            "codex_projection_not_quiet",
            true,
            error,
          );
        }
        continue;
      }
      this.#assertEstablishmentMayContinue(signal);
      this.#assertCurrentReceipt(resumed.generation);
      const goalNotificationSequenceBeforeRefresh =
        this.#lastGoalNotificationGeneration === resumed.generation
          ? this.#lastGoalNotificationInboundSequence
          : 0;
      // Authoritative Goal reread before advertising current state. Failures
      // withdraw the feature rather than projecting malformed native state.
      await this.#refreshGoalProjection(signal);
      await this.#drainPendingSettingsObservation(signal);
      this.#assertEstablishmentMayContinue(signal);
      this.#assertCurrentReceipt(resumed.generation);
      if (this.#establishmentMutationRequiresRetry(resumed)) {
        continue;
      }
      if (
        this.#lastGoalNotificationGeneration === resumed.generation &&
        this.#lastGoalNotificationInboundSequence >
          goalNotificationSequenceBeforeRefresh
      ) {
        const trailingGoalNotificationSequence =
          this.#lastGoalNotificationInboundSequence;
        await this.#refreshGoalProjection(signal);
        await this.#drainPendingSettingsObservation(signal);
        this.#assertEstablishmentMayContinue(signal);
        this.#assertCurrentReceipt(resumed.generation);
        if (this.#establishmentMutationRequiresRetry(resumed)) {
          continue;
        }
        if (
          this.#lastGoalNotificationGeneration === resumed.generation &&
          this.#lastGoalNotificationInboundSequence >
            trailingGoalNotificationSequence
        ) {
          // Goal churn must not make otherwise-stable history unavailable.
          // The registry coalesces this invalidation with a trailing reread.
          this.#invalidateGoalProjection();
        }
      }
      return { snapshot: resumed.snapshot, history: resumed.history };
    }
    throw codexError(
      "unavailable",
      "Codex history did not become stable during reconciliation.",
      "codex_projection_not_quiet",
      true,
    );
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    const snapshot = this.#snapshotWindow;
    const nativeThread = this.#nativeThread;
    if (!snapshot || !nativeThread) {
      throw codexError(
        "invalid_state",
        "Codex history is not established.",
        "codex_history_not_established",
      );
    }
    if (this.#projectionInvalidated) {
      throw codexError(
        "unavailable",
        "Codex history must be reconciled before paging.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration
    ) {
      throw codexError(
        "unavailable",
        "Codex history must be reconciled with the current daemon generation.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > HISTORY_PAGE_LIMIT
    ) {
      throw codexError(
        "rejected",
        "The requested Codex history page size is invalid.",
        "codex_history_page_limit_invalid",
      );
    }
    if (nativeThread.historyMode === "paginated") {
      const adapter = this.#paginatedHistoryAdapter;
      if (!adapter) {
        throw codexError(
          "invalid_state",
          "Codex paginated history is not established.",
          "codex_history_not_established",
        );
      }
      if (input.cursor === undefined) {
        const projection = await this.#projectNativeHistorySliceDurably(
          nativeThread,
          nativeThread.turns.length,
          input.limit,
        );
        const retainedNativeTurnIds = new Set(
          nativeThread.turns
            .slice(projection.startNativeTurnIndex)
            .map(({ id }) => id),
        );
        return historyPage(
          projection.snapshot,
          projection.snapshot.orderedBackendTurnIds,
          adapter.cursorAfterCurrentTurns(retainedNativeTurnIds),
        );
      }
      try {
        const expectedInstallEpoch = this.#projectionInstallEpoch;
        const page = await adapter.page(
          input.cursor,
          input.limit,
          input.signal,
        );
        const projection = await this.#projectNativeHistorySliceDurably(
          page.thread,
          page.thread.turns.length,
          input.limit,
        );
        if (
          this.#projectionInvalidated ||
          this.#projectionInstallEpoch !== expectedInstallEpoch ||
          this.#client.lifecycleSnapshot().generation !==
            this.#establishedGeneration
        ) {
          throw codexError(
            "unavailable",
            "Codex history changed while the page was loading.",
            "codex_history_reconciliation_required",
            true,
          );
        }
        return historyPage(
          projection.snapshot,
          projection.snapshot.orderedBackendTurnIds,
          adapter.cursorAfterProjection(page, projection.startNativeTurnIndex),
        );
      } catch (error) {
        throw mapCodexReadError(error);
      }
    }
    if (nativeThread.historyMode !== "legacy") {
      throw codexError(
        "incompatible_protocol",
        "Codex returned an unknown history mode.",
        "codex_history_mode_invalid",
      );
    }
    const beforeNativeTurnIndex =
      input.cursor === undefined
        ? nativeThread.turns.length
        : this.#parseHistoryCursor(input.cursor);
    const projection = await this.#projectNativeHistorySliceDurably(
      nativeThread,
      beforeNativeTurnIndex,
      input.limit,
    );
    const turnIds = projection.snapshot.orderedBackendTurnIds;
    return historyPage(
      projection.snapshot,
      turnIds,
      projection.startNativeTurnIndex > 0
        ? this.#historyCursor(projection.startNativeTurnIndex)
        : undefined,
    );
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    if (this.#projectionInvalidated) {
      throw codexError(
        "unavailable",
        "Codex history must be reconciled before locating a turn.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    if (
      !Number.isSafeInteger(input.maximumTurnCandidates) ||
      input.maximumTurnCandidates <= 0
    ) {
      throw codexError(
        "rejected",
        "The requested Codex turn lookup limit is invalid.",
        "codex_turn_lookup_limit_invalid",
      );
    }
    const nativeThread = this.#nativeThread;
    if (!this.#snapshotWindow || !nativeThread) {
      throw codexError(
        "invalid_state",
        "Codex history is not established.",
        "codex_history_not_established",
      );
    }
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration
    ) {
      throw codexError(
        "unavailable",
        "Codex history must be reconciled with the current daemon generation.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    const signal = input.signal ?? new AbortController().signal;
    try {
      if (nativeThread.historyMode === "paginated") {
        const adapter = this.#paginatedHistoryAdapter;
        if (!adapter) {
          throw codexError(
            "unavailable",
            "Codex paginated history must be reconciled before locating a turn.",
            "codex_history_reconciliation_required",
            true,
          );
        }
        const located = await adapter.locateTurn(
          {
            matchesBackendTurnId: input.matchesBackendTurnId,
            maximumTurnCandidates: input.maximumTurnCandidates,
          },
          signal,
        );
        if (located.status !== "found") return located;
        return await this.#projectLocatedTurn(nativeThread, located.turn);
      }
      if (nativeThread.historyMode !== "legacy") {
        throw codexError(
          "incompatible_protocol",
          "Codex returned an unknown history mode.",
          "codex_history_mode_invalid",
        );
      }
      let examined = 0;
      for (let index = nativeThread.turns.length - 1; index >= 0; index -= 1) {
        if (examined >= input.maximumTurnCandidates) {
          return { status: "search_limit_reached" };
        }
        const turn = nativeThread.turns[index]!;
        examined += 1;
        if (
          !input.matchesBackendTurnId(
            codexBackendTurnId(nativeThread.id, turn.id),
          )
        ) {
          continue;
        }
        return await this.#projectLocatedTurn(nativeThread, turn);
      }
      return { status: "not_found" };
    } catch (error) {
      throw mapCodexReadError(error);
    }
  }

  async #projectLocatedTurn(
    sourceThread: CodexThread,
    turn: CodexTurn,
  ): Promise<LocateTurnResult> {
    const thread: CodexThread = {
      ...sourceThread,
      status:
        activeNativeTurnId(sourceThread) === turn.id
          ? { type: "active", activeFlags: [] }
          : { type: "idle" },
      turns: [turn],
    };
    const projection = await this.#projectNativeHistorySliceDurably(
      thread,
      1,
      1,
    );
    const turnIds = projection.snapshot.orderedBackendTurnIds;
    if (turnIds.length === 0) return { status: "not_found" };
    if (turnIds.length !== 1) {
      throw codexError(
        "incompatible_protocol",
        "Codex projected an invalid targeted history result.",
        "codex_turn_lookup_projection_invalid",
      );
    }
    return {
      status: "found",
      page: historyPage(projection.snapshot, turnIds, undefined),
    };
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    if (this.#model) {
      await this.#refreshModelInputModalities(this.#model.id);
    }
    return this.#capabilities();
  }

  #capabilities(): BackendCapabilityDocument {
    const forkSettings = this.#executionSettings.forkSettingsEligibility(
      this.#scope(),
      this.binding.applicationThreadId,
    );
    const effectiveSettings =
      forkSettings.availability === "available"
        ? {
            model: {
              // Available branching means this complete tuple is the durable,
              // policy-allowed inheritance authority. Keep the advertised
              // checkpoint settings on that same authority even when a new,
              // empty Codex thread cannot yet be resumed to populate #model.
              provider: this.binding.connectionProfileId,
              id: forkSettings.settings.model,
            },
            thinkingLevel: forkSettings.settings.reasoningEffort,
          }
        : this.#model
          ? {
              model: {
                // The stable model catalog has no native provider discriminator.
                // Use the immutable normalized connection namespace consistently
                // for both catalog and effective settings.
                provider: this.binding.connectionProfileId,
                id: this.#model.id,
              },
              ...(this.#model.reasoningEffort
                ? { thinkingLevel: this.#model.reasoningEffort }
                : {}),
            }
          : {};
    return {
      revision: `codex-c5:${this.#establishedGeneration}:${this.#model?.provider ?? ""}:${this.#model?.id ?? ""}:${this.#model?.reasoningEffort ?? ""}:${this.#modelInputModalities.join(",")}:${forkSettings.availability}:${forkSettings.settingsRevision}`,
      actions: ["rename", "compact"],
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
      composerAttachments: {
        fileStaging: true,
        nativeImage:
          this.#model !== undefined &&
          this.#modelInputModalities.includes("image"),
      },
      nonblockingQuestions: true,
      providerOutputArtifacts: { nativeImage: true },
      supportsHistory: true,
      branching:
        forkSettings.availability === "available"
          ? {
              availability: "available",
              boundaries: [
                "latest_completed",
                "selected_completed_turn",
                "latest_provider_snapshot",
              ],
              method: "provider_native",
              sourceMustBeIdle: false,
              settingsInheritance: "application_applied",
              fidelity: {
                instructions: true,
                messages: true,
                toolCalls: true,
                toolResults: true,
                compaction: true,
                attachments: true,
                settings: true,
                limitations: [
                  {
                    text: "Codex native archive may archive spawned descendants, and native delete may permanently delete them. Sedes top-level placement does not sever this native ancestry.",
                  },
                ],
              },
              childIdentity: "provider_assigned",
              creationRecovery: "potentially_unknown",
            }
          : {
              availability: "unavailable",
              reason: {
                text:
                  forkSettings.reason === "external_custom"
                    ? "This Codex thread uses execution settings Sedes cannot safely inherit."
                    : forkSettings.reason === "policy_disallowed"
                      ? "This Codex thread uses execution settings that are no longer allowed."
                      : "Wait for Codex to confirm this thread's effective settings before forking.",
              },
            },
      interactionKinds: [
        "choice",
        "confirmation",
        "text_input",
        "editor",
        "decision",
        "questionnaire",
        "form",
      ],
      usageSections: ["context", "tokens"],
      effectiveSettings,
    };
  }

  async #refreshModelInputModalities(
    model: string,
    fresh = false,
  ): Promise<void> {
    const inputModalities = await this.#resolveModelInputModalities(
      model,
      fresh,
    );
    if (this.#model?.id === model) {
      this.#modelInputModalities = inputModalities;
    }
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration
    ) {
      return {};
    }
    return structuredClone(this.#usage);
  }

  async readCurrent(): Promise<{
    readonly snapshot: BackendConversationSnapshot;
    readonly usage: UsageSnapshot;
  }> {
    this.#assertOpen();
    if (this.#snapshotWindow) {
      const lifecycle = this.#client.lifecycleSnapshot();
      const runState =
        lifecycle.state === "ready" &&
        lifecycle.generation === this.#establishedGeneration
          ? this.#snapshotWindow.runState
          : (lifecycleRunState(lifecycle) ?? "reconciling");
      const snapshot = structuredClone(this.#snapshotWindow);
      snapshot.runState = runState;
      if (runState !== "running") {
        delete snapshot.activeBackendTurnId;
      }
      return {
        snapshot,
        usage:
          lifecycle.state === "ready" &&
          lifecycle.generation === this.#establishedGeneration
            ? structuredClone(this.#usage)
            : {},
      };
    }
    if (this.#establishing && this.#establishmentSettled) {
      await this.#establishmentSettled;
      if (this.#snapshotWindow) return await this.readCurrent();
    }
    const established = await this.establishProjection({
      signal: new AbortController().signal,
    });
    return {
      snapshot: established.snapshot,
      usage: structuredClone(this.#usage),
    };
  }

  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertOpen();
    await this.#notificationWork;
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration ||
      !this.#nativeThread
    ) {
      throw codexError(
        "unavailable",
        "Codex must be reconciled before a submission can start.",
        "codex_submission_anchor_reconciliation_required",
        true,
      );
    }
    if (this.#nativeThread.status.type === "active") {
      throw codexError(
        "invalid_state",
        "A new Codex turn cannot start while the thread is active.",
        "codex_submission_anchor_thread_active",
      );
    }
    // Anchor from the cached authoritative thread rather than a full
    // thread/read: on large rollouts that read dominates queue dispatch
    // latency. The cached thread is applied through this handle's
    // notification stream at the established generation, and Codex history
    // is append-only with content-derived terminal identities, so if the
    // cache ever trails the daemon the anchor simply cannot match at
    // reconciliation — the outcome degrades to unresolved (fail closed),
    // never to a false not_accepted. The Pi backend anchors from local
    // authoritative session state the same way.
    return serializeCodexSubmissionRetryAnchor(this.#nativeThread);
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    this.#assertOpen();
    await this.#notificationWork;
    if (!hasDeliverableComposerInput(input)) {
      throw codexError(
        "rejected",
        "The Codex submission input is empty.",
        "codex_submission_empty",
      );
    }
    return await this.#withMutation(async () => {
      const taskContextsFingerprint = codexTaskContextMutationFingerprint(
        input.taskContexts,
        "submit",
      );
      const contextExcerptsFingerprint = codexContextExcerptMutationFingerprint(
        input.contextExcerpts,
        "submit",
      );
      const attachmentsFingerprint = stagedAttachmentFingerprint(
        input.attachments,
      );
      let submissionBoundaryCrossed = false;
      const previous = this.#submitOperations.get(input.applicationOperationId);
      if (previous) {
        if (
          previous.reconciliationToken !== input.reconciliationToken ||
          !sameSubmissionSource(previous.source, input.source) ||
          previous.selectedSkillId !== input.selectedSkillId ||
          previous.taskContextsFingerprint !== taskContextsFingerprint ||
          previous.contextExcerptsFingerprint !== contextExcerptsFingerprint ||
          previous.attachmentsFingerprint !== attachmentsFingerprint
        ) {
          throw codexError(
            "rejected",
            "The Codex submission operation was replayed with another identity.",
            "codex_submission_replay_mismatch",
          );
        }
        if (previous.state === "outcome_unknown") {
          throw mutationOutcomeUnknown("submit");
        }
        return previous.result;
      }
      const thread = this.#assertMutableProjection();
      if (thread.status.type === "active") {
        throw codexError(
          "invalid_state",
          "A Codex turn is already active.",
          "codex_turn_already_active",
        );
      }
      const clientUserMessageId = codexClientUserMessageId({
        ...this.#correlationScope,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      });
      try {
        const executionSnapshot =
          await this.#executionSettings.freezeOperationSnapshot(this.#scope(), {
            applicationThreadId: this.binding.applicationThreadId,
            applicationOperationId: input.applicationOperationId,
            source: input.source,
            now: this.#now(),
          });
        const executionSettings = executionSnapshot.settings;
        const validatedInputModalities =
          await this.#validateExecutionSettingsForTurn(executionSettings);
        const inputModalities =
          validatedInputModalities ??
          (await this.#resolveModelInputModalities(
            executionSettings.model,
            true,
          ));
        if (this.#model?.id === executionSettings.model) {
          this.#modelInputModalities = inputModalities;
        }
        const pathCarrierAttachments = inputModalities.includes("image")
          ? input.attachments.filter(({ kind }) => kind === "file")
          : input.attachments;
        const providerPolicy = codexExecutionPolicy(executionSettings).turn;
        const selectedSkill = input.selectedSkillId
          ? await resolveCodexSkill(
              this.#client,
              this.#canonicalWorkspacePath,
              input.selectedSkillId,
              this.#composerSkillPreferences.read(this.#scope())
                .showOpenAIComposerSkills,
            ).catch((error: unknown) => {
              if (
                error instanceof Error &&
                error.message === "codex_skill_unavailable"
              ) {
                throw error;
              }
              throw mapCodexReadError(error);
            })
          : undefined;
        const settingsObservationSequenceBeforeRequest =
          this.#lastSettingsObservationGeneration ===
          this.#establishedGeneration
            ? this.#lastSettingsObservationInboundSequence
            : 0;
        const response = await this.#client.requestWithReceipt(
          codexTurnStartMethod,
          {
            threadId: thread.id,
            clientUserMessageId,
            input: [
              ...(selectedSkill
                ? [
                    {
                      type: "skill" as const,
                      name: selectedSkill.name,
                      path: selectedSkill.path,
                    },
                  ]
                : []),
              ...(pathCarrierAttachments.length > 0
                ? [
                    {
                      type: "text" as const,
                      text: stagedAttachmentManifest({
                        key: this.#correlationScope.toolProvenanceKey,
                        correlation: clientUserMessageId,
                        attachments: pathCarrierAttachments,
                      }),
                      text_elements: [],
                    },
                  ]
                : []),
              ...(input.contextExcerpts.length > 0
                ? [
                    {
                      type: "text" as const,
                      text: codexContextExcerptCarrier({
                        toolProvenanceKey:
                          this.#correlationScope.toolProvenanceKey,
                        clientUserMessageId,
                        contextExcerpts: input.contextExcerpts,
                      }),
                      text_elements: [],
                    },
                  ]
                : []),
              ...(input.text.trim().length > 0
                ? [
                    {
                      type: "text" as const,
                      text: input.text,
                      text_elements: [],
                    },
                  ]
                : []),
              ...(inputModalities.includes("image")
                ? input.attachments
                    .filter(({ kind }) => kind === "image")
                    .map(({ agentPath }) => ({
                      type: "localImage" as const,
                      path: agentPath,
                    }))
                : []),
            ],
            model: executionSettings.model,
            serviceTier: encodeCodexServiceTier(executionSettings.serviceTier),
            effort: executionSettings.reasoningEffort,
            approvalPolicy: providerPolicy.approvalPolicy,
            approvalsReviewer: providerPolicy.approvalsReviewer,
            sandboxPolicy: providerPolicy.sandboxPolicy,
          },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, runtimeCorrelation: { kind: "start", applicationOperationId: input.applicationOperationId, applicationThreadId: this.binding.applicationThreadId } },
        );
        submissionBoundaryCrossed = true;
        this.#assertMutationReceipt(response.generation);
        if (
          this.#lastSettingsObservationGeneration !== response.generation ||
          this.#lastSettingsObservationInboundSequence <=
            settingsObservationSequenceBeforeRequest
        ) {
          // A successful current-generation turn/start receipt confirms the
          // exact immutable tuple used to create that turn. Prefer any full
          // settings notification that raced the response; otherwise the
          // receipt is the authoritative confirmation boundary. Populate the
          // handle-local tuple as well as durable effective settings: an empty
          // provider-created thread cannot be resumed before its first turn,
          // so #model is otherwise still unresolved when that turn is steered.
          const capabilitiesRevisionBeforeConfirmation =
            this.#capabilities().revision;
          this.#model = {
            provider: thread.modelProvider,
            id: executionSettings.model,
            reasoningEffort: executionSettings.reasoningEffort,
          };
          this.#modelInputModalities = inputModalities;
          this.#confirmEffective(
            {
              model: executionSettings.model,
              reasoningEffort: executionSettings.reasoningEffort,
              serviceTier: executionSettings.serviceTier,
              serviceTierClassification: "recognized",
              sandboxMode: executionSettings.sandboxMode,
              sandboxClassification: "recognized",
              networkAccess: executionSettings.networkAccess,
              networkClassification: "recognized",
              approvalPolicy: executionSettings.approvalPolicy,
              approvalPolicyClassification: "recognized",
              approvalReviewer: executionSettings.approvalReviewer,
              approvalReviewerClassification: "recognized",
              policyObservation: "complete",
            },
            response.generation,
          );
          const confirmedCapabilities = this.#capabilities();
          if (
            confirmedCapabilities.revision !==
            capabilitiesRevisionBeforeConfirmation
          ) {
            this.#emit({
              type: "capabilities_changed",
              capabilities: confirmedCapabilities,
            });
          }
        }
        const acceptedTurn = materializeAcceptedTurn(response.result.turn);
        // turn/start notifications are delivered on the same app-server
        // connection and may precede the request receipt. In particular, the
        // user item can already be present while the stable receipt still
        // contains only an identity-only turn. Treat the receipt as an
        // ensure-started delta over the current generation instead of
        // replacing newer notification-derived state.
        const currentThread = this.#assertMutableProjection();
        const alreadyObserved = currentThread.turns.some(
          ({ id }) => id === acceptedTurn.id,
        );
        const updatedThread: CodexThread = alreadyObserved
          ? currentThread
          : {
              ...currentThread,
              status: { type: "active", activeFlags: [] },
              turns: [...currentThread.turns, acceptedTurn],
            };
        // #installAndEmitTurnStart already projects the full thread and
        // proves the accepted turn projectable (it throws otherwise); the
        // backend turn identity is a pure hash of the native identity, so a
        // second full-history projection here would be pure latency on
        // large rollouts. The already-observed turn reached this handle
        // through the notification path, which only installs projected
        // state.
        const acceptedBackendTurnId = alreadyObserved
          ? codexBackendTurnId(currentThread.id, acceptedTurn.id)
          : this.#installAndEmitTurnStart(updatedThread, acceptedTurn.id);
        const result = {
          accepted: true,
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
          backendTurnId: acceptedBackendTurnId,
        } satisfies SubmitTurnResult;
        this.#submitOperations.set(input.applicationOperationId, {
          reconciliationToken: input.reconciliationToken,
          source: input.source,
          selectedSkillId: input.selectedSkillId,
          taskContextsFingerprint,
          contextExcerptsFingerprint,
          attachmentsFingerprint,
          state: "accepted",
          result,
        });
        return result;
      } catch (error) {
        if (
          submissionBoundaryCrossed ||
          (error instanceof CodexRpcDeliveryError &&
            error.delivery === "sent_outcome_unknown")
        ) {
          this.#submitOperations.set(input.applicationOperationId, {
            reconciliationToken: input.reconciliationToken,
            source: input.source,
            selectedSkillId: input.selectedSkillId,
            taskContextsFingerprint,
            contextExcerptsFingerprint,
            attachmentsFingerprint,
            state: "outcome_unknown",
          });
        }
        const mapped = mapCodexMutationError(error, "submit");
        if (!submissionBoundaryCrossed || mapped.crossedSubmissionBoundary) {
          throw mapped;
        }
        throw new BackendError(
          {
            category: mapped.category,
            retryable: mapped.retryable,
            crossedSubmissionBoundary: true,
            safeMessage: mapped.safeMessage,
            ...(mapped.backendCode ? { backendCode: mapped.backendCode } : {}),
            ...(mapped.steerRejectionReason
              ? { steerRejectionReason: mapped.steerRejectionReason }
              : {}),
          },
          {
            cause: mapped,
            ...(mapped.lateMutationReconciliation
              ? {
                  lateMutationReconciliation: mapped.lateMutationReconciliation,
                }
              : {}),
          },
        );
      }
    });
  }

  async steer(input: SteerTurnInput): Promise<SteerTurnResult> {
    if (input.target.kind !== "turn") {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "This backend requires an exact turn steering target.",
      });
    }
    const expectedBackendTurnId = input.target.turnId;
    this.#assertOpen();
    await this.#notificationWork;
    if (!hasDeliverableComposerInput(input)) {
      throw codexError(
        "rejected",
        "The Codex steering input is empty.",
        "codex_steer_empty",
      );
    }
    return await this.#withMutation(async () => {
      const taskContextsFingerprint = codexTaskContextMutationFingerprint(
        input.taskContexts,
        "steer",
      );
      const contextExcerptsFingerprint = codexContextExcerptMutationFingerprint(
        input.contextExcerpts,
        "steer",
      );
      const attachmentsFingerprint = stagedAttachmentFingerprint(
        input.attachments,
      );
      const previous = this.#steerOperations.get(input.applicationOperationId);
      if (previous) {
        if (
          previous.reconciliationToken !== input.reconciliationToken ||
          previous.selectedSkillId !== input.selectedSkillId ||
          previous.taskContextsFingerprint !== taskContextsFingerprint ||
          previous.contextExcerptsFingerprint !== contextExcerptsFingerprint ||
          previous.attachmentsFingerprint !== attachmentsFingerprint
        ) {
          throw codexError(
            "rejected",
            "The Codex steering operation was replayed with another identity.",
            "codex_steer_replay_mismatch",
          );
        }
        if (previous.state === "outcome_unknown") {
          throw mutationOutcomeUnknown("steer");
        }
        return previous.result;
      }
      const thread = this.#assertMutableProjection();
      const turnId = activeNativeTurnId(thread);
      if (
        !turnId ||
        codexBackendTurnId(thread.id, turnId) !== expectedBackendTurnId
      ) {
        throw codexSteerTargetUnavailable(
          "The active Codex turn changed before steering.",
          "codex_steer_target_changed",
        );
      }
      try {
        if (!this.#model?.reasoningEffort) {
          throw codexError(
            "rejected",
            "The active Codex model and reasoning effort are not resolved.",
            "model_policy_rejected",
          );
        }
        this.#assertModelPolicyAllowed(
          this.#model.id,
          this.#model.reasoningEffort,
        );
        const inputModalities = this.#model
          ? await this.#resolveModelInputModalities(this.#model.id, true)
          : (["text"] as const);
        if (this.#model) this.#modelInputModalities = inputModalities;
        const pathCarrierAttachments = inputModalities.includes("image")
          ? input.attachments.filter(({ kind }) => kind === "file")
          : input.attachments;
        const selectedSkill = input.selectedSkillId
          ? await resolveCodexSkill(
              this.#client,
              this.#canonicalWorkspacePath,
              input.selectedSkillId,
              this.#composerSkillPreferences.read(this.#scope())
                .showOpenAIComposerSkills,
            ).catch((error: unknown) => {
              if (
                error instanceof Error &&
                error.message === "codex_skill_unavailable"
              ) {
                throw error;
              }
              throw mapCodexReadError(error);
            })
          : undefined;
        const clientUserMessageId = codexClientUserMessageId({
          ...this.#correlationScope,
          applicationOperationId: input.applicationOperationId,
          reconciliationToken: input.reconciliationToken,
        });
        const response = await this.#client.requestWithReceipt(
          codexTurnSteerMethod,
          {
            threadId: thread.id,
            clientUserMessageId,
            input: [
              ...(selectedSkill
                ? [
                    {
                      type: "skill" as const,
                      name: selectedSkill.name,
                      path: selectedSkill.path,
                    },
                  ]
                : []),
              ...(pathCarrierAttachments.length > 0
                ? [
                    {
                      type: "text" as const,
                      text: stagedAttachmentManifest({
                        key: this.#correlationScope.toolProvenanceKey,
                        correlation: clientUserMessageId,
                        attachments: pathCarrierAttachments,
                      }),
                      text_elements: [],
                    },
                  ]
                : []),
              ...(input.contextExcerpts.length > 0
                ? [
                    {
                      type: "text" as const,
                      text: codexContextExcerptCarrier({
                        toolProvenanceKey:
                          this.#correlationScope.toolProvenanceKey,
                        clientUserMessageId,
                        contextExcerpts: input.contextExcerpts,
                      }),
                      text_elements: [],
                    },
                  ]
                : []),
              ...(input.text.trim().length > 0
                ? [
                    {
                      type: "text" as const,
                      text: input.text,
                      text_elements: [],
                    },
                  ]
                : []),
              ...(inputModalities.includes("image")
                ? input.attachments
                    .filter(({ kind }) => kind === "image")
                    .map(({ agentPath }) => ({
                      type: "localImage" as const,
                      path: agentPath,
                    }))
                : []),
            ],
            expectedTurnId: turnId,
          },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, runtimeCorrelation: { kind: "steer", applicationOperationId: input.applicationOperationId, applicationThreadId: this.binding.applicationThreadId } },
        );
        this.#assertMutationReceipt(response.generation);
        if (response.result.turnId !== turnId) {
          throw codexError(
            "incompatible_protocol",
            "Codex acknowledged steering a different active turn.",
            "codex_steer_turn_mismatch",
            false,
            undefined,
            true,
          );
        }
        const result = {
          status: "accepted",
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
          backendTurnId: expectedBackendTurnId,
        } satisfies SteerTurnResult;
        this.#steerOperations.set(input.applicationOperationId, {
          reconciliationToken: input.reconciliationToken,
          selectedSkillId: input.selectedSkillId,
          taskContextsFingerprint,
          contextExcerptsFingerprint,
          attachmentsFingerprint,
          state: "accepted",
          result,
        });
        return result;
      } catch (error) {
        if (
          error instanceof CodexRpcDeliveryError &&
          error.delivery === "sent_outcome_unknown"
        ) {
          this.#steerOperations.set(input.applicationOperationId, {
            reconciliationToken: input.reconciliationToken,
            selectedSkillId: input.selectedSkillId,
            taskContextsFingerprint,
            contextExcerptsFingerprint,
            attachmentsFingerprint,
            state: "outcome_unknown",
          });
        }
        throw mapCodexMutationError(error, "steer");
      }
    });
  }

  async interrupt(input: InterruptTurnInput): Promise<void> {
    this.#assertOpen();
    await this.#notificationWork;
    await this.#withMutation(async () => {
      const priorTarget = this.#interruptOperations.get(
        input.applicationOperationId,
      );
      if (priorTarget) {
        if (priorTarget !== input.expectedBackendTurnId) {
          throw codexError(
            "rejected",
            "The Codex interrupt operation was replayed for another turn.",
            "codex_interrupt_replay_mismatch",
          );
        }
        return;
      }
      const thread = this.#assertMutableProjection();
      const turnId = activeNativeTurnId(thread);
      if (
        !turnId ||
        codexBackendTurnId(thread.id, turnId) !== input.expectedBackendTurnId
      ) {
        throw codexError(
          "invalid_state",
          "The active Codex turn changed before interrupt.",
          "codex_interrupt_target_changed",
        );
      }
      try {
        const response = await this.#client.requestWithReceipt(
          codexTurnInterruptMethod,
          { threadId: thread.id, turnId },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        this.#assertMutationReceipt(response.generation);
        this.#interruptOperations.set(
          input.applicationOperationId,
          input.expectedBackendTurnId,
        );
        // The target may terminalize while the interrupt receipt is in flight.
        // Do not overwrite that newer projection, or a replacement turn, with
        // a synthesized stopping state that no later notification will repair.
        // A received-but-queued completion may still yield stopping -> idle,
        // which is ordered and convergent.
        if (
          !this.#projectionInvalidated &&
          this.#snapshotWindow?.activeBackendTurnId ===
            input.expectedBackendTurnId
        ) {
          this.#emit({
            type: "run_state_changed",
            state: "stopping",
            activeBackendTurnId: input.expectedBackendTurnId,
          });
        }
      } catch (error) {
        throw mapCodexMutationError(error, "interrupt");
      }
    });
  }

  async reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    await this.#notificationWork;
    return await this.#withMutation(async () => {
      const priorTarget = this.#interruptOperations.get(
        input.applicationOperationId,
      );
      if (priorTarget) {
        if (priorTarget !== input.expectedBackendTurnId) {
          throw codexError(
            "rejected",
            "The Codex interrupt operation was replayed for another turn.",
            "codex_interrupt_replay_mismatch",
          );
        }
        return { outcome: "accepted" };
      }
      const currentThread = this.#assertMutableProjection();
      try {
        const response = await this.#client.requestWithReceipt(
          codexThreadReadMethod,
          {
            threadId: this.binding.backendConversationId,
            includeTurns: false,
          },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        this.#assertCurrentReceipt(response.generation);
        this.#validateThread(response.result.thread);
        if (response.result.thread.historyMode !== currentThread.historyMode) {
          throw codexError(
            "incompatible_protocol",
            "Codex changed history mode while reconciling the interrupt.",
            "codex_history_mode_changed",
          );
        }
        return response.result.thread.status.type === "active" &&
          this.#snapshotWindow?.activeBackendTurnId ===
            input.expectedBackendTurnId
          ? { outcome: "unknown" }
          : { outcome: "accepted" };
      } catch (error) {
        throw mapCodexReadError(error);
      }
    });
  }

  async perform(
    input: RegisteredBackendActionInput,
  ): Promise<BackendActionResult> {
    this.#assertOpen();
    return await this.#withMutation(async () => {
      const thread = this.#assertMutableProjection();
      switch (input.action) {
        case "rename": {
          try {
            const inspected = await this.#client.requestWithReceipt(
              codexThreadReadMethod,
              { threadId: thread.id, includeTurns: false },
              { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
            );
            this.#assertCurrentReceipt(inspected.generation);
            this.#validateThread(inspected.result.thread);
            if (
              assertCodexHistoryMode(inspected.result.thread) !==
              thread.historyMode
            ) {
              throw codexError(
                "incompatible_protocol",
                "Codex changed history mode while renaming the thread.",
                "codex_history_mode_changed",
              );
            }
            if (inspected.result.thread.name === input.title) {
              return { accepted: true };
            }
            const response = await this.#client.requestWithReceipt(
              codexThreadSetNameMethod,
              { threadId: thread.id, name: input.title },
              { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
            );
            this.#assertMutationReceipt(response.generation);
            this.#nativeThread = {
              ...thread,
              name: input.title,
            };
            return { accepted: true };
          } catch (error) {
            throw mapCodexMutationError(error, "rename");
          }
        }
        case "compact": {
          if (input.instructions?.trim()) {
            throw codexError(
              "rejected",
              "Codex compaction does not accept custom instructions.",
              "codex_compaction_instructions_unsupported",
            );
          }
          const previous = this.#compactOperations.get(
            input.applicationOperationId,
          );
          if (previous === "accepted") return { accepted: true };
          if (previous === "outcome_unknown") {
            throw mutationOutcomeUnknown("compact");
          }
          try {
            if (!this.#model?.reasoningEffort) {
              throw codexError(
                "rejected",
                "The active Codex model and reasoning effort are not resolved.",
                "model_policy_rejected",
              );
            }
            this.#assertModelPolicyAllowed(
              this.#model.id,
              this.#model.reasoningEffort,
            );
            const response = await this.#client.requestWithReceipt(
              codexThreadCompactStartMethod,
              { threadId: thread.id },
              { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
            );
            this.#assertMutationReceipt(response.generation);
            this.#compactOperations.set(
              input.applicationOperationId,
              "accepted",
            );
            return { accepted: true };
          } catch (error) {
            if (
              error instanceof CodexRpcDeliveryError &&
              error.delivery === "sent_outcome_unknown"
            ) {
              this.#compactOperations.set(
                input.applicationOperationId,
                "outcome_unknown",
              );
            }
            throw mapCodexMutationError(error, "compact");
          }
        }
        case "set_model":
        case "set_thinking_level":
        case "set_tool_access":
          throw codexError(
            "invalid_state",
            "This Codex setting is not mutable through this handle.",
            "codex_setting_action_unavailable",
          );
      }
    });
  }

  async reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    return await this.#withMutation(async () => {
      if (input.action === "compact") {
        return this.#compactOperations.get(input.applicationOperationId) ===
          "accepted"
          ? { outcome: "accepted" }
          : { outcome: "unknown" };
      }
      if (input.action !== "rename") return { outcome: "unknown" };
      try {
        const currentThread = this.#assertMutableProjection();
        const response = await this.#client.requestWithReceipt(
          codexThreadReadMethod,
          {
            threadId: this.binding.backendConversationId,
            includeTurns: false,
          },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        this.#assertCurrentReceipt(response.generation);
        this.#validateThread(response.result.thread);
        if (
          assertCodexHistoryMode(response.result.thread) !==
          currentThread.historyMode
        ) {
          throw codexError(
            "incompatible_protocol",
            "Codex changed history mode while reconciling the rename.",
            "codex_history_mode_changed",
          );
        }
        this.#nativeThread = {
          ...currentThread,
          name: response.result.thread.name,
        };
        return response.result.thread.name === input.title
          ? { outcome: "accepted" }
          : { outcome: "not_applied" };
      } catch (error) {
        throw mapCodexReadError(error);
      }
    });
  }

  async respond(input: InteractionResponseInput): Promise<void> {
    this.#assertOpen();
    try {
      await this.#interactions.respond(input);
    } catch (error) {
      throw mapCodexInteractionError(error);
    }
  }

  async reconcileInteractionResponse(
    input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    try {
      return this.#interactions.reconcile(input);
    } catch (error) {
      throw mapCodexInteractionError(error);
    }
  }

  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Durable Goal create/pause/resume/clear. Receipts are prepared by the
   * application mutation boundary before this call.
   */
  async mutateProviderFeature(input: {
    readonly featureId: string;
    readonly schemaVersion: number;
    readonly actionId: string;
    readonly arguments: unknown;
  }): Promise<{
    readonly outcome: "accepted" | "uncertain" | "rejected";
    readonly projectedState?: unknown;
    readonly safeMessage?: string;
  }> {
    this.#assertOpen();
    if (
      input.featureId === CODEX_TUI_FEATURE_REF.featureId &&
      input.schemaVersion === CODEX_TUI_FEATURE_REF.schemaVersion
    ) {
      if (
        !this.#managedTui ||
        input.arguments !== null ||
        (input.actionId !== "start" && input.actionId !== "stop")
      ) {
        return {
          outcome: "rejected",
          safeMessage: "The managed Codex TUI action is unavailable.",
        };
      }
      const lifecycle = this.#client.lifecycleSnapshot();
      if (
        lifecycle.state !== "ready" ||
        lifecycle.generation !== this.#establishedGeneration ||
        this.#establishedGeneration === 0
      ) {
        return {
          outcome: "rejected",
          safeMessage: "Codex must be reconciled before the TUI can change.",
        };
      }
      return await this.#managedTui.perform(
        this.#managedTuiAuthority(),
        input.actionId as CodexTuiActionId,
      );
    }
    if (
      input.featureId !== CODEX_GOAL_FEATURE_REF.featureId ||
      input.schemaVersion !== CODEX_GOAL_FEATURE_REF.schemaVersion
    ) {
      return {
        outcome: "rejected",
        safeMessage: "The provider feature is not supported by this handle.",
      };
    }
    if (!this.#goalSessions) {
      return {
        outcome: "rejected",
        safeMessage: "Codex Goal projection is unavailable.",
      };
    }
    const actionId = input.actionId as CodexGoalActionId;
    if (
      actionId !== "create" &&
      actionId !== "pause" &&
      actionId !== "resume" &&
      actionId !== "clear"
    ) {
      return {
        outcome: "rejected",
        safeMessage: "The Goal action is not registered.",
      };
    }
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration ||
      this.#establishedGeneration === 0
    ) {
      return {
        outcome: "rejected",
        safeMessage: "Codex must be reconciled before Goal can change.",
      };
    }
    const scope = this.#scope();
    const current =
      this.#goalSessions.projection(scope, this.binding.applicationThreadId) ??
      (await this.#goalSessions.refresh({
        scope,
        applicationThreadId: this.binding.applicationThreadId,
        nativeThreadId: this.binding.backendConversationId,
        connectionGeneration: this.#establishedGeneration,
        client: this.#client,
      }));
    if (current.availability !== "available") {
      return {
        outcome: "rejected",
        safeMessage:
          current.unavailableReason ?? "Codex Goal is temporarily unavailable.",
      };
    }
    let desired;
    try {
      desired = desiredPostconditionForCodexGoalAction({
        actionId,
        arguments: input.arguments,
        currentState: current.state,
      });
    } catch {
      return {
        outcome: "rejected",
        safeMessage: "The Goal action arguments are invalid.",
      };
    }
    if (!availableCodexGoalActionIds(current.state).includes(actionId)) {
      return {
        outcome: "rejected",
        safeMessage: "The requested Goal action is not available.",
      };
    }
    const outcome = await this.#goalSessions.mutateNative({
      client: this.#client,
      nativeThreadId: this.binding.backendConversationId,
      actionId,
      desired,
      arguments: input.arguments,
      currentState: current.state,
    });
    if (outcome.kind === "accepted") {
      this.#goalSessions.publishObserved({
        scope,
        applicationThreadId: this.binding.applicationThreadId,
        nativeThreadId: this.binding.backendConversationId,
        connectionGeneration: this.#establishedGeneration,
        state: outcome.state,
      });
      return {
        outcome: "accepted",
        projectedState: outcome.state,
      };
    }
    if (outcome.kind === "uncertain") {
      if (outcome.observed) {
        this.#goalSessions.publishObserved({
          scope,
          applicationThreadId: this.binding.applicationThreadId,
          nativeThreadId: this.binding.backendConversationId,
          connectionGeneration: this.#establishedGeneration,
          state: outcome.observed,
        });
      } else {
        this.#goalSessions.withdraw({
          scope,
          applicationThreadId: this.binding.applicationThreadId,
          nativeThreadId: this.binding.backendConversationId,
          connectionGeneration: this.#establishedGeneration,
          reason: outcome.reason,
        });
      }
      return {
        outcome: "uncertain",
        ...(outcome.observed ? { projectedState: outcome.observed } : {}),
        safeMessage:
          "The Goal mutation could not be confirmed. Refresh the thread.",
      };
    }
    return {
      outcome: "rejected",
      safeMessage: outcome.reason,
    };
  }

  close(options?: { readonly reason: "evicted" }): Promise<void> {
    this.#closePromise ??= this.#performClose(options?.reason === "evicted");
    return this.#closePromise;
  }

  /** Best-effort shutdown of Sedes-owned stdio only; never used by ordinary handle close. */
  async interruptForOwnedStop(): Promise<void> {
    const lifecycle = this.#client.lifecycleSnapshot();
    const thread = this.#nativeThread;
    const turnId = thread && activeNativeTurnId(thread);
    if (this.#closing || this.#closed || !thread || !turnId || lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration) return;
    try {
      await this.#client.requestWithReceipt(codexTurnInterruptMethod, { threadId: thread.id, turnId }, { timeoutMilliseconds: 1_000 });
    } catch { /* Owned transport EOF/termination still follows a refused or timed-out interrupt. */ }
  }

  async #refreshGoalProjection(signal?: AbortSignal): Promise<void> {
    if (!this.#goalSessions || this.#establishedGeneration === 0) return;
    await this.#goalSessions.refresh({
      scope: this.#scope(),
      applicationThreadId: this.binding.applicationThreadId,
      nativeThreadId: this.binding.backendConversationId,
      connectionGeneration: this.#establishedGeneration,
      client: this.#client,
      ...(signal ? { signal } : {}),
    });
  }

  /** Replay only Sedes's durable tier; all other resume fields stay native. */
  async #replayDesiredServiceTier(
    observation: CodexSettingsObservationReceipt,
    desired: CodexServiceTierSelection | undefined,
    fastModeEnabled: boolean,
    signal: AbortSignal,
  ): Promise<CodexSettingsObservationReceipt> {
    if (
      desired === undefined ||
      (desired === "fast" && !fastModeEnabled) ||
      (observation.settings.serviceTierClassification === "recognized" &&
        observation.settings.serviceTier === desired)
    ) {
      return observation;
    }
    const response = await this.#client.requestWithReceipt(
      codexThreadSettingsUpdateMethod,
      {
        threadId: this.binding.backendConversationId,
        serviceTier: encodeCodexServiceTier(desired),
      },
      {
        timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
        signal,
      },
    );
    this.#assertEstablishmentMayContinue(signal);
    this.#assertCurrentReceipt(response.generation);
    // The empty settings/update receipt proves request acceptance, not the
    // resulting full thread settings. Only a validated settings notification
    // may advance effective tier; absent that observation, keep the resume
    // value so presentation remains pending.
    return this.#newerSettingsObservation(observation) ?? observation;
  }

  async #reconcileDisabledFastMode(
    projection: CodexFastModeProjection,
    syncManagedTui = true,
  ): Promise<CodexServiceTierSelection | undefined> {
    if (projection.unavailableReason !== "feature_disabled") {
      return this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      )?.serviceTier;
    }
    let resolved: CodexExecutionSettingsTuple | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (
        !sameDisabledProjection(
          this.#fastModeSessions.projection(
            this.#scope(),
            this.binding.applicationThreadId,
          ),
          projection,
        )
      ) {
        return undefined;
      }
      try {
        resolved = this.#executionSettings.resolveFastModeDisabled(
          this.#scope(),
          {
            applicationThreadId: this.binding.applicationThreadId,
            now: this.#now(),
          },
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
    if (resolved && this.#managedTui && syncManagedTui) {
      try {
        await this.#managedTui.syncSettings(
          this.#scope(),
          this.binding.applicationThreadId,
          resolved,
        );
      } catch (error) {
        this.#reportError(error);
      }
    }
    return resolved?.serviceTier;
  }

  async #recoverFastModeProjection(
    projection: CodexFastModeProjection,
  ): Promise<void> {
    if (this.#closing || this.#closed) return;
    if (projection.unavailableReason === "feature_disabled") {
      try {
        if (await this.#restoreSupersedingFastModeSettings(projection)) {
          return;
        }
        const retainedServiceTier = await this.#reconcileDisabledFastMode(
          projection,
          false,
        );
        if (retainedServiceTier) {
          if (await this.#restoreSupersedingFastModeSettings(projection)) {
            return;
          }
          let currentDesired = this.#executionSettings.desiredSettings(
            this.#scope(),
            this.binding.applicationThreadId,
          );
          if (!currentDesired || currentDesired.serviceTier !== "standard") {
            return;
          }
          if (this.#managedTui) {
            const synchronized = await this.#syncRecoveredDisabledManagedTui(
              projection,
              currentDesired,
            );
            if (!synchronized) return;
            currentDesired = synchronized;
          }
          if (await this.#restoreSupersedingFastModeSettings(projection)) {
            return;
          }
          const generation = this.#establishedGeneration;
          const lifecycle = this.#client.lifecycleSnapshot();
          const projectionBeforeWrite = this.#fastModeSessions.projection(
            this.#scope(),
            this.binding.applicationThreadId,
          );
          if (
            !this.#closing &&
            !this.#closed &&
            generation !== 0 &&
            lifecycle.state === "ready" &&
            lifecycle.generation === generation &&
            sameDisabledProjection(projectionBeforeWrite, projection)
          ) {
            const response = await this.#client.requestWithReceipt(
              codexThreadSettingsUpdateMethod,
              {
                threadId: this.binding.backendConversationId,
                serviceTier: encodeCodexServiceTier(currentDesired.serviceTier),
              },
              { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
            );
            if (response.generation !== generation) {
              throw codexError(
                "unavailable",
                "The Codex daemon generation changed during Fast mode recovery.",
                "codex_generation_changed",
                true,
              );
            }
            this.#assertCurrentReceipt(response.generation);
            await this.#restoreSupersedingFastModeSettings(projection);
          }
        }
      } catch (error) {
        this.#reportError(error);
      }
    } else if (projection.enabled && projection.availability === "available") {
      const desired = this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (desired) {
        try {
          await this.#fastModeSessions.syncServiceTier(
            this.#scope(),
            this.binding.applicationThreadId,
            desired.serviceTier,
          );
        } catch (error) {
          this.#reportError(error);
        }
      }
    }
    if (this.#establishedGeneration !== 0 && !this.#closing && !this.#closed) {
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
  }

  async #restoreSupersedingFastModeSettings(
    recoveredProjection: CodexFastModeProjection,
  ): Promise<boolean> {
    if (this.#closing || this.#closed) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentProjection = this.#fastModeSessions.projection(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (sameDisabledProjection(currentProjection, recoveredProjection)) {
        return false;
      }
      const currentDesired = this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (!currentDesired) return true;
      const updates: Promise<unknown>[] = [];
      if (currentProjection?.availability === "available") {
        updates.push(
          this.#fastModeSessions.syncServiceTier(
            this.#scope(),
            this.binding.applicationThreadId,
            currentDesired.serviceTier,
          ),
        );
      }
      if (this.#managedTui) {
        updates.push(
          this.#managedTui.syncSettings(
            this.#scope(),
            this.binding.applicationThreadId,
            currentDesired,
          ),
        );
      }
      await Promise.all(updates);
      if (this.#closing || this.#closed) return true;
      const projectionAfterSync = this.#fastModeSessions.projection(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (sameDisabledProjection(projectionAfterSync, recoveredProjection)) {
        return false;
      }
      const desiredAfterSync = this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (
        desiredAfterSync &&
        sameProjection(currentProjection, projectionAfterSync) &&
        sameDesiredSettings(currentDesired, desiredAfterSync)
      ) {
        return true;
      }
    }
    throw new Error("codex_fast_mode_recovery_stabilization_failed");
  }

  async #syncRecoveredDisabledManagedTui(
    recoveredProjection: CodexFastModeProjection,
    initialDesired: CodexExecutionSettingsTuple,
  ): Promise<CodexExecutionSettingsTuple | undefined> {
    if (!this.#managedTui) return initialDesired;
    let desired = initialDesired;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.#managedTui.syncSettings(
        this.#scope(),
        this.binding.applicationThreadId,
        desired,
      );
      if (await this.#restoreSupersedingFastModeSettings(recoveredProjection)) {
        return undefined;
      }
      const desiredAfterSync = this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      );
      if (!desiredAfterSync || desiredAfterSync.serviceTier !== "standard") {
        return undefined;
      }
      if (sameDesiredSettings(desired, desiredAfterSync)) {
        return desiredAfterSync;
      }
      desired = desiredAfterSync;
    }
    throw new Error("codex_fast_mode_tui_stabilization_failed");
  }

  #invalidateGoalProjection(): void {
    if (!this.#goalSessions || this.#establishedGeneration === 0) return;
    this.#goalSessions.scheduleInvalidation({
      scope: this.#scope(),
      applicationThreadId: this.binding.applicationThreadId,
      nativeThreadId: this.binding.backendConversationId,
      connectionGeneration: this.#establishedGeneration,
      client: this.#client,
      onSettled: () => {
        // Republish through the actor so clients receive a fresh presentation
        // snapshot with updated provider feature state.
        this.#emit({
          type: "capabilities_changed",
          capabilities: this.#capabilities(),
        });
      },
    });
  }

  async #readResumeUntilQuiet(
    signal: AbortSignal,
  ): Promise<CodexStableResumeProjection> {
    try {
      for (
        let attempt = 0;
        attempt < MAXIMUM_ESTABLISHMENT_ATTEMPTS;
        attempt += 1
      ) {
        this.#resetPaginatedEstablishmentNotifications();
        this.#assertEstablishmentMayContinue(signal);
        const lifecycle = this.#client.lifecycleSnapshot();
        if (lifecycle.state !== "ready") {
          throw codexError(
            "unavailable",
            "The Codex daemon is not ready.",
            "codex_daemon_not_ready",
            true,
          );
        }

        const inspected = await this.#client.requestWithReceipt(
          codexThreadReadMethod,
          {
            threadId: this.binding.backendConversationId,
            includeTurns: false,
          },
          {
            timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS,
            signal,
          },
        );
        this.#assertEstablishmentMayContinue(signal);
        this.#assertCurrentReceipt(inspected.generation);
        this.#validateThread(inspected.result.thread);
        const historyMode = assertCodexHistoryMode(inspected.result.thread);

        const desiredBeforeResume = this.#executionSettings.desiredSettings(
          this.#scope(), this.binding.applicationThreadId,
        );
        let resumed;
        try {
          resumed = await this.#client.persistentSessions?.reattachThread(
            this.binding.backendConversationId,
            {
              timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS,
              signal,
            },
          );
          if (!resumed) {
            const cliEnvironment =
              await this.#acquireAgentToolCliEnvironment(signal);
            this.#assertEstablishmentMayContinue(signal);
            const lifecycleAfterCliEnvironment = this.#client.lifecycleSnapshot();
            if (
              lifecycleAfterCliEnvironment.state !== "ready" ||
              lifecycleAfterCliEnvironment.generation !== inspected.generation
            ) {
              continue;
            }
            this.#assertCurrentReceipt(inspected.generation);
            const executionEnvironment = await this.#resolveThreadEnvironment(this.binding.applicationThreadId);
            const resumeConfig = withCodexAgentToolCliEnvironment(
              withCodexExecutionEnvironment({}, executionEnvironment),
              {
                resolution: cliEnvironment,
                executionEnvironment,
                applicationThreadId: this.binding.applicationThreadId,
              },
            );
            resumed = await this.#client.requestWithReceipt(
              codexThreadResumeMethod,
              {
                threadId: this.binding.backendConversationId,
                ...(desiredBeforeResume
                  ? {
                      serviceTier: encodeCodexServiceTier(
                        desiredBeforeResume.serviceTier,
                      ),
                    }
                  : {}),
                ...(Object.keys(resumeConfig).length > 0
                  ? { config: resumeConfig }
                  : {}),
                ...(historyMode === "paginated"
                  ? {
                      excludeTurns: true as const,
                      initialTurnsPage: {
                        limit: SNAPSHOT_TURN_LIMIT,
                        sortDirection: "desc" as const,
                        itemsView: "notLoaded" as const,
                      },
                    }
                  : {}),
              },
              {
                environmentVariablesFingerprint: this.#resolveThreadEnvironment.fingerprint?.(this.binding.applicationThreadId),
                timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS,
                signal,
              },
            );
          }
        } catch (resumeError) {
          if (!isUnmaterializedThreadError(resumeError)) {
            throw resumeError;
          }
          if (resumeError.generation !== inspected.generation) {
            continue;
          }
          const lifecycleBeforeEmptyConfirmation =
            this.#client.lifecycleSnapshot();
          if (
            lifecycleBeforeEmptyConfirmation.state !== "ready" ||
            lifecycleBeforeEmptyConfirmation.generation !== inspected.generation
          ) {
            continue;
          }
          if (historyMode === "paginated") {
            if (
              inspected.result.thread.turns.length !== 0 ||
              inspected.result.thread.status.type === "active"
            ) {
              throw resumeError;
            }
            const projectionThread: CodexThread = {
              ...inspected.result.thread,
              status: { type: "idle" },
              turns: [],
            };
            const adapter = new CodexPaginatedHistoryAdapter({
              client: this.#client,
              thread: inspected.result.thread,
              generation: inspected.generation,
              correlationScope: this.#correlationScope,
            });
            const page: CodexPaginatedNativePage = {
              thread: projectionThread,
              source: { syntheticNativeTurnIds: [], segments: [] },
            };
            const projection =
              await this.#projectThreadHistoryDurably(projectionThread);
            const current = this.#client.lifecycleSnapshot();
            if (
              current.state !== "ready" ||
              current.generation !== inspected.generation
            ) {
              continue;
            }
            this.#subscribedGeneration = inspected.generation;
            this.#model = undefined;
            this.#modelInputModalities = ["text"];
            const installed = this.#installProjection(
              projection,
              projectionThread,
              inspected.generation,
              projectionThread,
              new Map(),
              { adapter, page },
            );
            return {
              ...installed,
              generation: inspected.generation,
              inboundSequence: inspected.inboundSequence,
            };
          }
          let fullHistoryConfirmed = false;
          try {
            await this.#client.requestWithReceipt(
              codexThreadReadMethod,
              {
                threadId: this.binding.backendConversationId,
                includeTurns: true,
              },
              {
                timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS,
                signal,
              },
            );
            fullHistoryConfirmed = true;
          } catch (confirmationError) {
            if (!isUnmaterializedThreadError(confirmationError)) {
              throw confirmationError;
            }
            if (confirmationError.generation !== inspected.generation) {
              continue;
            }
          }
          if (fullHistoryConfirmed) {
            // A successful full-history read disproves the empty-thread
            // classification. Preserve the original resume failure rather
            // than installing a metadata-only projection.
            throw resumeError;
          }
          // Current Codex releases reject resume for an empty thread, but the
          // attempt still carries the freshly resolved config so a release
          // that can materialize here never establishes with stale CLI
          // eligibility. For the known rejection, thread/start remains the
          // authoritative config source until the first message materializes
          // the thread.
          const projection = await this.#projectThreadHistoryDurably(
            inspected.result.thread,
          );
          const current = this.#client.lifecycleSnapshot();
          if (
            current.state !== "ready" ||
            current.generation !== inspected.generation
          ) {
            continue;
          }
          this.#subscribedGeneration = inspected.generation;
          this.#model = undefined;
          this.#modelInputModalities = ["text"];
          const installed = this.#installProjection(
            projection,
            inspected.result.thread,
            inspected.generation,
          );
          return {
            ...installed,
            generation: inspected.generation,
            inboundSequence: inspected.inboundSequence,
          };
        }
        // A successful resume subscribes this connection even if close or a
        // lifecycle transition raced its response.
        this.#subscribedGeneration = resumed.generation;
        this.#assertEstablishmentMayContinue(signal);
        this.#assertCurrentReceipt(resumed.generation);
        this.#validateThread(resumed.result.thread);
        if (resumed.result.cwd !== this.#canonicalWorkspacePath) {
          throw bindingMismatch();
        }
        if (assertCodexHistoryMode(resumed.result.thread) !== historyMode) {
          throw codexError(
            "incompatible_protocol",
            "Codex changed history mode while the thread was attaching.",
            "codex_history_mode_changed",
          );
        }
        let projection: CodexWindowProjection;
        let projectionThread: CodexThread;
        let paginatedInstallation:
          | {
              readonly adapter: CodexPaginatedHistoryAdapter;
              readonly page: CodexPaginatedNativePage;
            }
          | undefined;
        if (historyMode === "legacy") {
          assertCompleteLegacyResume(resumed.result);
          projectionThread = resumed.result.thread;
          projection =
            await this.#projectThreadHistoryDurably(projectionThread);
        } else {
          const adapter = new CodexPaginatedHistoryAdapter({
            client: this.#client,
            thread: resumed.result.thread,
            generation: resumed.generation,
            correlationScope: this.#correlationScope,
          });
          const page = await adapter.bootstrap(resumed.result, signal);
          projectionThread = page.thread;
          projection = await this.#projectThreadHistoryDurably(page.thread);
          paginatedInstallation = { adapter, page };
        }
        if (
          this.#establishmentMutationRequiresRetry(
            resumed,
            historyMode === "paginated",
          )
        ) {
          continue;
        }
        const current = this.#client.lifecycleSnapshot();
        if (
          current.state !== "ready" ||
          current.generation !== resumed.generation
        ) {
          continue;
        }
        let settingsReceipt: CodexSettingsObservationReceipt = {
          generation: resumed.generation,
          inboundSequence: resumed.inboundSequence,
          modelProvider: resumed.result.modelProvider,
          settings: codexObservedThreadExecutionSettings(
            resumed.result.model,
            resumed.result.reasoningEffort,
            resumed.result.serviceTier,
            resumed.result.approvalPolicy,
            resumed.result.approvalsReviewer,
            resumed.result.sandbox,
          ),
        };
        const fastModeProjection = await this.#fastModeSessions.refresh({
          scope: this.#scope(),
          applicationThreadId: this.binding.applicationThreadId,
          nativeThreadId: this.binding.backendConversationId,
          connectionGeneration: resumed.generation,
          client: this.#client,
          signal,
          onRecovered: async (projection) =>
            await this.#recoverFastModeProjection(projection),
          shouldRecover: () => !this.#closing && !this.#closed,
        });
        const retainedServiceTier =
          fastModeProjection.unavailableReason === "feature_disabled"
            ? await this.#reconcileDisabledFastMode(fastModeProjection)
            : desiredBeforeResume?.serviceTier;
        settingsReceipt = await this.#replayDesiredServiceTier(
          settingsReceipt,
          retainedServiceTier,
          fastModeProjection.enabled &&
            fastModeProjection.availability === "available",
          signal,
        );
        let historyRaced = false;
        for (
          let settingsAttempt = 0;
          settingsAttempt < MAXIMUM_ESTABLISHMENT_ATTEMPTS;
          settingsAttempt += 1
        ) {
          const newerSettings = this.#newerSettingsObservation(settingsReceipt);
          if (newerSettings) settingsReceipt = newerSettings;
          // The resumed backend tuple is authoritative for desired intent:
          // always resolve the import candidate, not only when the durable
          // row is empty.
          const desiredReasoningEffort =
            await this.#resolveImportedReasoningEffort(
              settingsReceipt.settings.model,
              settingsReceipt.settings.reasoningEffort,
            );
          this.#assertEstablishmentMayContinue(signal);
          this.#assertCurrentReceipt(resumed.generation);
          if (
            this.#establishmentMutationRequiresRetry(
              resumed,
              historyMode === "paginated",
            )
          ) {
            historyRaced = true;
            break;
          }
          const racedSettings = this.#newerSettingsObservation(settingsReceipt);
          if (racedSettings) {
            const valuesMatch = sameSettingsObservation(
              settingsReceipt,
              racedSettings,
            );
            settingsReceipt = racedSettings;
            if (!valuesMatch) continue;
          }
          this.#model = {
            provider: settingsReceipt.modelProvider,
            id: settingsReceipt.settings.model,
            ...(settingsReceipt.settings.reasoningEffort
              ? { reasoningEffort: settingsReceipt.settings.reasoningEffort }
              : {}),
          };
          this.#modelInputModalities = ["text"];
          await this.#refreshModelInputModalities(
            settingsReceipt.settings.model,
          );
          this.#confirmEffective(
            settingsReceipt.settings,
            resumed.generation,
            importedDesiredSettings(
              settingsReceipt.settings,
              desiredReasoningEffort,
              retainedServiceTier,
            ),
          );
          this.#markSettingsObservationApplied(settingsReceipt);
          const installed = this.#installProjection(
            projection,
            projectionThread,
            resumed.generation,
            projectionThread,
            inferLiveProjectionItems(projectionThread),
            paginatedInstallation,
          );
          this.#armPaginatedEstablishmentCatchUp(
            historyMode,
            resumed.generation,
            resumed.inboundSequence,
          );
          return {
            ...installed,
            generation: resumed.generation,
            inboundSequence: resumed.inboundSequence,
          };
        }
        if (historyRaced) continue;
        this.#assertEstablishmentMayContinue(signal);
        this.#assertCurrentReceipt(resumed.generation);
        if (
          this.#establishmentMutationRequiresRetry(
            resumed,
            historyMode === "paginated",
          )
        ) {
          continue;
        }
        settingsReceipt =
          this.#newerSettingsObservation(settingsReceipt) ?? settingsReceipt;
        this.#model = {
          provider: settingsReceipt.modelProvider,
          id: settingsReceipt.settings.model,
          ...(settingsReceipt.settings.reasoningEffort
            ? { reasoningEffort: settingsReceipt.settings.reasoningEffort }
            : {}),
        };
        this.#modelInputModalities = ["text"];
        await this.#refreshModelInputModalities(settingsReceipt.settings.model);
        // Settings-only churn must not make stable history unavailable. The
        // next-turn guard remains unresolved and fail-closed. A later stable
        // observation can retry initialization without rereading history.
        this.#confirmEffective(settingsReceipt.settings, resumed.generation);
        this.#markSettingsObservationApplied(settingsReceipt);
        const installed = this.#installProjection(
          projection,
          projectionThread,
          resumed.generation,
          projectionThread,
          inferLiveProjectionItems(projectionThread),
          paginatedInstallation,
        );
        this.#armPaginatedEstablishmentCatchUp(
          historyMode,
          resumed.generation,
          resumed.inboundSequence,
        );
        return {
          ...installed,
          generation: resumed.generation,
          inboundSequence: resumed.inboundSequence,
        };
      }
      throw codexError(
        "unavailable",
        "Codex history did not become stable during reconciliation.",
        "codex_projection_not_quiet",
        true,
      );
    } catch (error) {
      if (signal.aborted) throw projectionCancelled(signal.reason);
      throw mapCodexReadError(error);
    }
  }

  #installProjection(
    projection: CodexWindowProjection,
    settledNativeThread: CodexThread,
    generation: number,
    liveNativeThread: CodexThread = settledNativeThread,
    streamingNativeItems: CodexStreamingNativeItems = inferLiveProjectionItems(
      liveNativeThread,
    ),
    paginatedInstallation?: {
      readonly adapter: CodexPaginatedHistoryAdapter;
      readonly page: CodexPaginatedNativePage;
    },
  ): Pick<CodexStableResumeProjection, "snapshot" | "history"> {
    return this.#projectionWorkQueue.execute(() => {
      if (
        this.#snapshotWindow &&
        !this.#projectionInvalidated &&
        serializedUtf8Bytes(this.#snapshotWindow) !==
          this.#projectionSerializedBytes
      ) {
        throw codexError(
          "incompatible_protocol",
          "The Codex projection byte ledger drifted.",
          "codex_projection_byte_ledger_drift",
          false,
          undefined,
          true,
        );
      }
      const snapshot = projection.snapshot;
      const projectionBytes = verifiedCodexProjectionBytes(projection);
      const normalizedSettled = normalizeCodexTurnStatuses(settledNativeThread);
      const normalizedLive = normalizeCodexTurnStatuses(liveNativeThread);
      if (
        this.#nativeThread &&
        this.#nativeThread.historyMode !== normalizedSettled.historyMode
      ) {
        throw codexError(
          "incompatible_protocol",
          "Codex changed history mode for an attached thread.",
          "codex_history_mode_changed",
        );
      }
      if (
        normalizedSettled.historyMode !== "legacy" &&
        normalizedSettled.historyMode !== "paginated"
      ) {
        throw codexError(
          "incompatible_protocol",
          "Codex returned an unknown history mode.",
          "codex_history_mode_invalid",
        );
      }
      if (paginatedInstallation) {
        if (normalizedSettled.historyMode !== "paginated") {
          throw codexError(
            "incompatible_protocol",
            "Codex mixed paginated history authority with a legacy thread.",
            "codex_history_mode_changed",
          );
        }
        paginatedInstallation.adapter.installCurrentBoundary(
          paginatedInstallation.page,
          projection.startNativeTurnIndex,
          new Set(projection.backendTurnIdByNativeId.keys()),
        );
        this.#paginatedHistoryAdapter = paginatedInstallation.adapter;
      } else if (normalizedSettled.historyMode === "legacy") {
        this.#paginatedHistoryAdapter = undefined;
        this.#paginatedHistoryPreviousCursor = undefined;
      } else if (!this.#paginatedHistoryAdapter) {
        throw codexError(
          "invalid_state",
          "Codex paginated history authority is not installed.",
          "codex_history_not_established",
        );
      }
      const retainedSettled =
        normalizedSettled.historyMode === "paginated"
          ? {
              ...normalizedSettled,
              turns: normalizedSettled.turns.filter(({ id }) =>
                projection.backendTurnIdByNativeId.has(id),
              ),
            }
          : normalizedSettled;
      this.#projectionInstallEpoch += 1;
      this.#snapshotWindow = snapshot;
      this.#projectedItemByNativeCoordinate = new Map(
        projection.projectedItemByNativeCoordinate,
      );
      this.#projectedItemCount = projection.projectedItemCount;
      this.#projectionSerializedBytes = projectionBytes;
      this.#nativeThread = retainedSettled;
      const projectedNativeTurnIds = new Set(
        [...projection.projectedItemByNativeCoordinate.values()].map(
          ({ nativeTurnId }) => nativeTurnId,
        ),
      );
      for (const nativeTurnId of projection.backendTurnIdByNativeId.keys()) {
        projectedNativeTurnIds.add(nativeTurnId);
      }
      this.#nativeTurnById = new Map(
        retainedSettled.turns
          .filter(({ id }) => projectedNativeTurnIds.has(id))
          .map((turn) => [turn.id, turn]),
      );
      this.#streamingNativeItems =
        copyStreamingNativeItems(streamingNativeItems);
      this.#projectionInvalidated = false;
      this.#terminalErrorRecoveryGeneration = undefined;
      this.#terminalErrorFallbackThread = undefined;
      this.#failureFencedGeneration = undefined;
      this.#liveProjectionOverlay.reset({
        generation,
        installEpoch: this.#projectionInstallEpoch,
        seeds: liveProjectionSeeds(
          normalizedLive,
          projection,
          this.#streamingNativeItems,
        ),
      });
      if (this.#liveProjectionOverlay.invalidated) {
        throw codexError(
          "incompatible_protocol",
          "The Codex live projection exceeded its bounded state.",
          "codex_live_projection_overflow",
          false,
          undefined,
          true,
        );
      }
      if (this.#establishing || this.#establishedGeneration !== generation) {
        this.#historyNonce = randomUUID();
      }
      if (retainedSettled.historyMode === "paginated") {
        this.#paginatedHistoryPreviousCursor =
          this.#paginatedHistoryAdapter!.cursorAfterCurrentTurns(
            new Set(retainedSettled.turns.map(({ id }) => id)),
          );
      }
      this.#establishedGeneration = generation;
      this.#interactions.activate(generation);
      if (this.#usageGeneration !== generation) {
        this.#usage = {};
        this.#usageGeneration = 0;
      }
      return {
        snapshot: structuredClone(this.#snapshotWindow),
        history: {
          operational: true,
          ...((
            retainedSettled.historyMode === "paginated"
              ? this.#paginatedHistoryPreviousCursor
              : projection.startNativeTurnIndex > 0
                ? this.#historyCursor(projection.startNativeTurnIndex)
                : undefined
          )
            ? {
                previousCursor:
                  retainedSettled.historyMode === "paginated"
                    ? this.#paginatedHistoryPreviousCursor
                    : this.#historyCursor(projection.startNativeTurnIndex),
              }
            : {}),
        },
      };
    });
  }

  #validateThread(thread: CodexThread): void {
    if (
      thread.id !== this.binding.backendConversationId ||
      !isCodexDiscoverableThread(thread, this.#canonicalWorkspacePath)
    ) {
      throw bindingMismatch();
    }
  }

  #assertCurrentReceipt(generation: number): void {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (lifecycle.state !== "ready" || lifecycle.generation !== generation) {
      throw codexError(
        "unavailable",
        "The Codex daemon generation changed during reconciliation.",
        "codex_generation_changed",
        true,
      );
    }
  }

  #assertMutableProjection(): CodexThread {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#establishedGeneration ||
      !this.#nativeThread ||
      !this.#snapshotWindow
    ) {
      throw codexError(
        "unavailable",
        "Codex must be reconciled before it can be mutated.",
        "codex_mutation_reconciliation_required",
        true,
      );
    }
    return this.#nativeThread;
  }

  #assertMutationReceipt(generation: number): void {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      generation !== this.#establishedGeneration ||
      lifecycle.generation !== generation
    ) {
      throw mutationOutcomeUnknown("generation_changed");
    }
  }

  async #withMutation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#mutationInFlight) {
      throw codexError(
        "invalid_state",
        "Another Codex mutation is already in progress.",
        "codex_mutation_in_progress",
        true,
      );
    }
    this.#mutationInFlight = true;
    try {
      return await operation();
    } finally {
      this.#mutationInFlight = false;
    }
  }

  #projectThreadHistory(thread: CodexThread): CodexWindowProjection {
    const normalized = normalizeCodexTurnStatuses(thread);
    return this.#projectNativeHistorySlice(
      normalized,
      normalized.turns.length,
      SNAPSHOT_TURN_LIMIT,
      this.#streamingNativeItemsForProjection(normalized),
    );
  }

  #projectNativeHistorySlice(
    thread: CodexThread,
    beforeNativeTurnIndex: number,
    visibleLimit: number,
    streamingNativeItems: CodexStreamingNativeItems = new Map(),
  ): CodexWindowProjection {
    let candidateLimit = visibleLimit;
    for (;;) {
      try {
        const selected = selectCodexNativeHistorySlice(
          thread,
          this.#correlationScope,
          beforeNativeTurnIndex,
          candidateLimit,
        );
        return {
          ...projectCodexThreadHistory(
            selected.thread,
            this.#correlationScope,
            streamingNativeItems,
            this.#generatedImageProjectionContext(),
          ),
          startNativeTurnIndex: selected.startNativeTurnIndex,
        };
      } catch (error) {
        const mapped = mapCodexHistoryProjectionError(error);
        if (
          !(mapped instanceof BackendError) ||
          mapped.backendCode !== "history_too_large" ||
          candidateLimit === 1
        ) {
          throw mapped;
        }
        candidateLimit = Math.max(1, Math.floor(candidateLimit / 2));
      }
    }
  }

  async #projectNativeHistorySliceDurably(
    thread: CodexThread,
    beforeNativeTurnIndex: number,
    visibleLimit: number,
    streamingNativeItems: CodexStreamingNativeItems = new Map(),
  ): Promise<CodexWindowProjection> {
    const context = this.#generatedImageProjectionContext();
    const normalized = normalizeCodexTurnStatuses(thread);
    let candidateLimit = visibleLimit;
    for (;;) {
      try {
        const selected = this.#projectNativeHistorySlice(
          normalized,
          beforeNativeTurnIndex,
          candidateLimit,
          streamingNativeItems,
        );
        const projection = await materializeCodexGeneratedImagePublications(
          selected,
          context,
        );
        const projectionBytes = verifiedCodexProjectionBytes(projection);
        if (projectionBytes > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
          throw codexError(
            "unavailable",
            "This Codex thread is too large to display safely.",
            "history_too_large",
          );
        }
        return {
          ...projection,
          startNativeTurnIndex: selected.startNativeTurnIndex,
        };
      } catch (error) {
        const mapped = mapCodexHistoryProjectionError(error);
        if (
          !(mapped instanceof BackendError) ||
          mapped.backendCode !== "history_too_large" ||
          candidateLimit === 1
        ) {
          throw mapped;
        }
        candidateLimit = Math.max(1, Math.floor(candidateLimit / 2));
      }
    }
  }

  async #projectThreadHistoryDurably(
    thread: CodexThread,
  ): Promise<CodexWindowProjection> {
    const normalized = normalizeCodexTurnStatuses(thread);
    return await this.#projectNativeHistorySliceDurably(
      normalized,
      normalized.turns.length,
      SNAPSHOT_TURN_LIMIT,
      this.#streamingNativeItemsForProjection(normalized),
    );
  }

  async #projectThreadHistoryWithStreamingItemsDurably(
    thread: CodexThread,
    streamingNativeItems: CodexStreamingNativeItems,
  ): Promise<CodexWindowProjection> {
    const normalized = normalizeCodexTurnStatuses(thread);
    return await this.#projectNativeHistorySliceDurably(
      normalized,
      normalized.turns.length,
      SNAPSHOT_TURN_LIMIT,
      streamingNativeItems,
    );
  }

  #streamingNativeItemsForProjection(
    thread: CodexThread,
  ): CodexStreamingNativeItems {
    if (!this.#establishing) return this.#streamingNativeItems;
    return inferStreamingNativeItems(thread);
  }

  #withStreamingNativeItem(
    turnId: string,
    itemId: string,
  ): Map<string, Set<string>> {
    const next = copyStreamingNativeItems(this.#streamingNativeItems);
    const items = next.get(turnId) ?? new Set<string>();
    items.add(itemId);
    next.set(turnId, items);
    return next;
  }

  #withoutStreamingNativeItem(
    turnId: string,
    itemId: string,
  ): Map<string, Set<string>> {
    const next = copyStreamingNativeItems(this.#streamingNativeItems);
    const items = next.get(turnId);
    if (!items) return next;
    items.delete(itemId);
    if (items.size === 0) next.delete(turnId);
    return next;
  }

  #withoutStreamingNativeTurn(turnId: string): Map<string, Set<string>> {
    const next = copyStreamingNativeItems(this.#streamingNativeItems);
    next.delete(turnId);
    return next;
  }

  #projectThreadHistoryWithStreamingItems(
    thread: CodexThread,
    streamingNativeItems: CodexStreamingNativeItems,
  ): CodexWindowProjection {
    const normalized = normalizeCodexTurnStatuses(thread);
    return this.#projectNativeHistorySlice(
      normalized,
      normalized.turns.length,
      SNAPSHOT_TURN_LIMIT,
      streamingNativeItems,
    );
  }

  #generatedImageProjectionContext() {
    return {
      scope: {
        tenantId: this.binding.tenantId,
        principalId: this.binding.ownerPrincipalId,
      },
      applicationThreadId: this.binding.applicationThreadId,
      outputArtifacts: this.#outputArtifacts,
      verifiedPublicationKeys: this.#verifiedGeneratedImagePublicationKeys,
    } as const;
  }

  async #installTerminalizedStreamingProjection(thread: CodexThread) {
    const previousSnapshot = this.#snapshotWindow;
    const previousNativeThread = this.#nativeThread;
    const expectedInstallEpoch = this.#projectionInstallEpoch;
    const projection =
      await this.#projectThreadHistoryWithStreamingItemsDurably(
        thread,
        new Map(),
      );
    if (
      this.#closing ||
      this.#closed ||
      this.#projectionInstallEpoch !== expectedInstallEpoch ||
      this.#nativeThread !== previousNativeThread
    ) {
      throw new Error("codex_projection_changed_during_artifact_publication");
    }
    const completedItems = Object.values(projection.snapshot.itemsById).filter(
      (item) =>
        previousSnapshot?.itemsById[item.backendItemId]?.status ===
          "streaming" && item.status !== "streaming",
    );
    const changedTurns = Object.values(projection.snapshot.turnsById).filter(
      (turn) => {
        const previous = previousSnapshot?.turnsById[turn.backendTurnId];
        return previous && JSON.stringify(previous) !== JSON.stringify(turn);
      },
    );
    this.#installProjection(
      projection,
      thread,
      this.#establishedGeneration,
      thread,
      new Map(),
    );
    this.#streamingNativeItems = new Map();
    for (const item of completedItems) {
      this.#emit({ type: "item_completed", item });
    }
    for (const turn of changedTurns) {
      this.#emit({ type: "turn_updated", turn });
    }
    return projection;
  }

  #installExhaustedErrorProjection(
    error: unknown,
  ): Pick<CodexStableResumeProjection, "snapshot" | "history"> | undefined {
    const generation = this.#terminalErrorRecoveryGeneration;
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      !(error instanceof BackendError) ||
      error.backendCode !== "codex_projection_not_quiet" ||
      generation === undefined ||
      lifecycle.state !== "ready" ||
      lifecycle.generation !== generation ||
      !this.#nativeThread
    ) {
      return undefined;
    }
    const settledThread = this.#nativeThread;
    const fallbackSource =
      this.#terminalErrorFallbackThread ?? this.#nativeThread;
    const streamingNativeItems = copyStreamingNativeItems(
      this.#streamingNativeItems,
    );
    const failedThread: CodexThread = {
      ...fallbackSource,
      status: { type: "systemError" },
      turns: fallbackSource.turns.map((turn) =>
        turn.status === "inProgress"
          ? {
              ...turn,
              status: "failed" as const,
              completedAt: turn.completedAt ?? this.#now() / 1_000,
              items: turn.items.map(failInProgressNativeItem),
            }
          : turn,
      ),
    };
    const projected = this.#projectThreadHistoryWithStreamingItems(
      failedThread,
      new Map(),
    );
    const failureItems = { ...projected.snapshot.itemsById };
    for (const [nativeTurnId, nativeItemIds] of streamingNativeItems) {
      for (const nativeItemId of nativeItemIds) {
        const projectedCoordinate =
          projected.projectedItemByNativeCoordinate.get(
            codexNativeItemCoordinate(nativeTurnId, nativeItemId),
          );
        if (
          !projectedCoordinate ||
          !["agentMessage", "plan", "reasoning"].includes(
            projectedCoordinate.itemType,
          )
        ) {
          continue;
        }
        for (const backendItemId of projectedCoordinate.orderedBackendItemIds) {
          const item = failureItems[backendItemId];
          if (!item) continue;
          failureItems[backendItemId] = backendItemSchema.parse({
            ...item,
            status: "interrupted",
            ...(item.semanticKind === "plan"
              ? {
                  entries: item.entries.map((entry) => ({
                    ...entry,
                    status:
                      entry.status === "in_progress"
                        ? ("cancelled" as const)
                        : entry.status,
                  })),
                }
              : {}),
          });
        }
      }
    }
    const failureSnapshot = backendConversationSnapshotSchema.parse({
      ...projected.snapshot,
      itemsById: failureItems,
    });
    const projection: CodexWindowProjection = {
      ...projected,
      snapshot: failureSnapshot,
      serializedSnapshotBytes: serializedUtf8Bytes(failureSnapshot),
    };
    const installed = this.#installProjection(
      projection,
      settledThread,
      generation,
      failedThread,
      new Map(),
    );
    this.#terminalErrorRecoveryGeneration = undefined;
    this.#terminalErrorFallbackThread = undefined;
    this.#failureFencedGeneration = generation;
    return installed;
  }

  #installAndEmitTurnStart(thread: CodexThread, nativeTurnId: string): string {
    const projection = this.#projectThreadHistory(thread);
    const backendTurnId = projection.backendTurnIdByNativeId.get(nativeTurnId);
    const turn = backendTurnId
      ? projection.snapshot.turnsById[backendTurnId]
      : undefined;
    if (!backendTurnId || !turn) {
      throw codexError(
        "incompatible_protocol",
        "Codex started a turn that could not be projected.",
        "codex_started_turn_unprojectable",
        false,
        undefined,
        true,
      );
    }
    this.#installProjection(projection, thread, this.#establishedGeneration);
    this.#emit({ type: "turn_started", turn });
    for (const itemId of turn.orderedBackendItemIds) {
      const item = projection.snapshot.itemsById[itemId];
      if (!item) continue;
      this.#emit({
        type: item.status === "streaming" ? "item_started" : "item_completed",
        item,
      });
    }
    this.#emit({
      type: "run_state_changed",
      state: "running",
      activeBackendTurnId: backendTurnId,
    });
    return backendTurnId;
  }

  #flushLiveProjection(
    items: readonly CodexLiveProjectionFlushItem[],
  ): ReadonlySet<string> | false {
    try {
      const lifecycle = this.#client.lifecycleSnapshot();
      const snapshot = this.#snapshotWindow;
      if (
        this.#projectionInvalidated ||
        lifecycle.state !== "ready" ||
        lifecycle.generation !== this.#establishedGeneration ||
        !snapshot ||
        !this.#nativeThread
      ) {
        return false;
      }
      const replacements: Array<{
        readonly oldItem: BackendConversationSnapshot["itemsById"][string];
        readonly newItem: BackendConversationSnapshot["itemsById"][string];
      }> = [];
      const additions: BackendConversationSnapshot["itemsById"][string][] = [];
      const turnReplacements: Array<{
        readonly oldTurn: BackendConversationSnapshot["turnsById"][string];
        readonly newTurn: BackendConversationSnapshot["turnsById"][string];
      }> = [];
      const coordinateReplacements: Array<{
        readonly key: string;
        readonly coordinate: CodexProjectedItemCoordinate;
      }> = [];
      const publishedCoordinates = new Set<string>();
      let byteDelta = 0;
      for (const live of items) {
        const liveKey = codexNativeItemCoordinate(
          live.nativeTurnId,
          live.nativeItemId,
        );
        const coordinate = this.#projectedItemByNativeCoordinate.get(liveKey);
        const nativeTurn = this.#nativeTurnById.get(live.nativeTurnId);
        if (
          !coordinate ||
          coordinate.nativeOrdinal !== live.coordinate.nativeOrdinal ||
          coordinate.itemType !== live.item.type ||
          !nativeTurn ||
          !this.#streamingNativeItems
            .get(live.nativeTurnId)
            ?.has(live.nativeItemId)
        ) {
          return false;
        }
        const projected = projectCodexItemSlice(
          this.#nativeThread.id,
          nativeTurn,
          live.item,
          coordinate.backendTurnId,
          coordinate.nativeOrdinal,
          coordinate.sourceOrder,
          true,
          this.#correlationScope,
          undefined,
          undefined,
          this.#generatedImageProjectionContext(),
          [],
        ).map((item) => backendItemSchema.parse(item));
        const oldSliceIds = coordinate.orderedBackendItemIds;
        const sameShape =
          projected.length === oldSliceIds.length &&
          projected.every(
            (item, index) => item.backendItemId === oldSliceIds[index],
          );
        const isTailExtension =
          !sameShape &&
          coordinate.itemType === "fileChange" &&
          projected.length > oldSliceIds.length &&
          oldSliceIds.every(
            (backendItemId, index) =>
              projected[index]?.backendItemId === backendItemId,
          ) &&
          nativeTurn.items.at(-1)?.id === live.nativeItemId;
        if (!sameShape && !isTailExtension) {
          return false;
        }
        let changed = false;
        for (const newItem of projected.slice(0, oldSliceIds.length)) {
          const oldItem = snapshot.itemsById[newItem.backendItemId];
          if (
            !oldItem ||
            !sameLiveSliceIdentity(oldItem, newItem, coordinate.itemType)
          ) {
            return false;
          }
          if (JSON.stringify(oldItem) === JSON.stringify(newItem)) continue;
          byteDelta +=
            serializedUtf8Bytes(newItem) - serializedUtf8Bytes(oldItem);
          replacements.push({ oldItem, newItem });
          changed = true;
        }
        if (isTailExtension) {
          const oldTurn = snapshot.turnsById[coordinate.backendTurnId];
          if (
            !oldTurn ||
            oldTurn.status !== "in_progress" ||
            !endsWithExactIds(oldTurn.orderedBackendItemIds, oldSliceIds)
          ) {
            return false;
          }
          const appendedItems = projected.slice(oldSliceIds.length);
          if (
            appendedItems.some(({ status }) => status !== "streaming") ||
            turnReplacements.some(
              ({ oldTurn: pendingTurn }) =>
                pendingTurn.backendTurnId === oldTurn.backendTurnId,
            ) ||
            appendedItems.some(
              (item) =>
                snapshot.itemsById[item.backendItemId] !== undefined ||
                additions.some(
                  ({ backendItemId }) => backendItemId === item.backendItemId,
                ),
            )
          ) {
            return false;
          }
          const nextOrderedIds = [
            ...oldTurn.orderedBackendItemIds,
            ...appendedItems.map(({ backendItemId }) => backendItemId),
          ];
          if (nextOrderedIds.length > CODEX_C1_MAX_ITEMS_PER_TURN) {
            return false;
          }
          const newTurn = backendTurnSchema.parse({
            ...oldTurn,
            orderedBackendItemIds: nextOrderedIds,
          });
          byteDelta +=
            serializedUtf8Bytes(newTurn) - serializedUtf8Bytes(oldTurn);
          for (const newItem of appendedItems) {
            byteDelta += serializedRecordAdditionBytes(
              newItem.backendItemId,
              newItem,
              this.#projectedItemCount + additions.length > 0,
            );
            additions.push(newItem);
          }
          turnReplacements.push({ oldTurn, newTurn });
          coordinateReplacements.push({
            key: liveKey,
            coordinate: {
              ...coordinate,
              orderedBackendItemIds: projected.map(
                ({ backendItemId }) => backendItemId,
              ),
            },
          });
          changed = true;
        }
        if (changed) {
          publishedCoordinates.add(liveKey);
        }
      }
      if (
        this.#projectionSerializedBytes + byteDelta >
        MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES
      ) {
        return false;
      }
      for (const { newItem } of replacements) {
        snapshot.itemsById[newItem.backendItemId] = newItem;
      }
      for (const newItem of additions) {
        snapshot.itemsById[newItem.backendItemId] = newItem;
      }
      for (const { newTurn } of turnReplacements) {
        snapshot.turnsById[newTurn.backendTurnId] = newTurn;
      }
      for (const { key, coordinate } of coordinateReplacements) {
        this.#projectedItemByNativeCoordinate.set(key, coordinate);
      }
      this.#projectedItemCount += additions.length;
      this.#projectionSerializedBytes += byteDelta;
      for (const { newItem } of replacements) {
        this.#emit({ type: "item_updated", item: newItem });
      }
      for (const newItem of additions) {
        this.#emit({ type: "item_started", item: newItem });
      }
      for (const { newTurn } of turnReplacements) {
        this.#emit({ type: "turn_updated", turn: newTurn });
      }
      return publishedCoordinates;
    } catch (error) {
      this.#reportError(error);
      return false;
    }
  }

  #clearPaginatedHistoryAuthority(): void {
    this.#paginatedHistoryAdapter = undefined;
    this.#paginatedHistoryPreviousCursor = undefined;
  }

  #invalidateProjection(
    reason: Extract<
      BackendConversationEvent,
      { readonly type: "resnapshot_required" }
    >["reason"],
  ): void {
    if (this.#projectionInvalidated) return;
    this.#projectionInvalidated = true;
    this.#projectionInstallEpoch += 1;
    this.#clearPaginatedHistoryAuthority();
    this.#liveProjectionOverlay.dispose();
    if (
      !this.#closing &&
      !this.#closed &&
      !this.#establishing &&
      this.#establishedGeneration !== 0
    ) {
      this.#emit({ type: "resnapshot_required", reason });
    }
  }

  #assertEstablishmentMayContinue(signal: AbortSignal): void {
    if (signal.aborted) throw projectionCancelled(signal.reason);
    if (this.#closing || this.#closed) {
      throw conversationClosed();
    }
  }

  readonly #consumeNotification: CodexNotificationListener = (notification) => {
    if (this.#deferPaginatedEstablishmentNotification(notification)) return;
    if (
      this.#pendingNotificationWork === 0 &&
      !mayCompleteGeneratedImage(notification) &&
      !(
        notification.method === "turn/completed" &&
        this.#nativeThread?.historyMode === "paginated"
      )
    ) {
      void this.#consumeNotificationNow(notification).catch((error) => {
        this.#reportError(error);
        this.#projectionWorkQueue.enqueue(() => {
          this.#invalidateProjection("contradictory_state");
        });
      });
      return;
    }
    if (this.#pendingNotificationWork >= 1_000) {
      this.#projectionWorkQueue.enqueue(() => {
        this.#invalidateProjection("buffer_overflow");
      });
      return;
    }
    this.#pendingNotificationWork += 1;
    const operation = this.#notificationWork.then(async () => {
      await this.#consumeNotificationNow(notification);
    });
    this.#notificationWork = operation
      .catch((error) => {
        this.#reportError(error);
        this.#projectionWorkQueue.enqueue(() => {
          this.#invalidateProjection("contradictory_state");
        });
      })
      .finally(() => {
        this.#pendingNotificationWork -= 1;
      });
  };

  readonly #consumeNotificationNow = async (
    notification: Parameters<CodexNotificationListener>[0],
  ): Promise<void> => {
    if (this.#closing || this.#closed) return;
    if (isCodexRpcUndecodableNotification(notification)) {
      if (notification.nativeThreadId !== this.binding.backendConversationId) {
        return;
      }
      this.#recordMutation(notification.generation, notification.sequence);
      this.#reportError(new Error(notification.code));
      this.#invalidateProjection("contradictory_state");
      return;
    }
    const threadId = notificationThreadId(notification.params);
    if (threadId !== this.binding.backendConversationId) return;
    if (notification.method === "thread/tokenUsage/updated") {
      try {
        const parsed = codexC2NotificationSchemas[
          "thread/tokenUsage/updated"
        ].parse(notification.params);
        this.#usage = projectCodexUsage(parsed.tokenUsage);
        this.#usageGeneration = notification.generation;
      } catch (error) {
        this.#recordMutation(notification.generation, notification.sequence);
        this.#reportError(error);
        if (!this.#establishing) {
          this.#emit({
            type: "resnapshot_required",
            reason: "contradictory_state",
          });
        }
        return;
      }
      if (!this.#establishing) {
        this.#emit({ type: "usage_changed", usage: this.#usage });
      }
      return;
    }
    if (notification.method === "thread/settings/updated") {
      try {
        const observation = this.#rememberSettingsObservation(
          notification.generation,
          notification.sequence,
          notification.params,
        );
        if (this.#establishing) return;
        if (notification.generation !== this.#establishedGeneration) {
          this.#emit({ type: "resnapshot_required", reason: "sequence_gap" });
          return;
        }
        this.#applySettingsObservation(observation);
        this.#scheduleDesiredInitialization(observation);
      } catch (error) {
        this.#recordMutation(notification.generation, notification.sequence);
        this.#reportError(error);
        if (!this.#establishing) {
          this.#emit({
            type: "resnapshot_required",
            reason: "contradictory_state",
          });
        }
      }
      return;
    }
    if (
      notification.method === "thread/goal/updated" ||
      notification.method === "thread/goal/cleared"
    ) {
      try {
        if (notification.method === "thread/goal/updated") {
          refineCodexThreadGoalUpdatedNotification(
            assertCodexAttestedServerNotificationParams(
              "thread/goal/updated",
              notification.params,
            ),
          );
        } else {
          refineCodexThreadGoalClearedNotification(
            assertCodexAttestedServerNotificationParams(
              "thread/goal/cleared",
              notification.params,
            ),
          );
        }
        this.#recordGoalNotification(
          notification.generation,
          notification.sequence,
        );
        if (!this.#establishing) {
          if (notification.generation !== this.#establishedGeneration) {
            this.#emit({
              type: "resnapshot_required",
              reason: "sequence_gap",
            });
          } else {
            this.#invalidateGoalProjection();
          }
        }
      } catch (error) {
        this.#recordMutation(notification.generation, notification.sequence);
        this.#reportError(error);
        if (!this.#establishing) {
          this.#emit({
            type: "resnapshot_required",
            reason: "contradictory_state",
          });
        }
      }
      return;
    }
    if (notification.method === "mcpServer/startupStatus/updated") {
      // Informational MCP startup progress has no transcript projection in
      // Sedes and cannot invalidate a thread/read or thread/resume receipt.
      return;
    }
    if (
      notification.method === "modelProvider/authRecoveryStarted" ||
      notification.method === "modelProvider/authRecoveryCompleted"
    ) {
      try {
        codexC2NotificationSchemas[notification.method].parse(
          notification.params,
        );
        if (!this.#establishing) {
          const completed =
            notification.method === "modelProvider/authRecoveryCompleted";
          this.#emit({
            type: "notice",
            notice: {
              id: `codex-auth-recovery:${notification.generation}:${notification.sequence}`,
              tone: completed ? "success" : "warning",
              message: boundedDisplayTextSchema.parse({
                text: completed
                  ? CODEX_AUTH_RECOVERY_COMPLETED_NOTICE
                  : CODEX_AUTH_RECOVERY_STARTED_NOTICE,
              }),
              createdAt: new Date(
                notification.emittedAtMs ?? this.#now(),
              ).toISOString(),
            },
          });
        }
      } catch (error) {
        this.#reportError(error);
        if (!this.#establishing) {
          this.#emit({
            type: "resnapshot_required",
            reason: "contradictory_state",
          });
        }
      }
      return;
    }
    if (notification.method === "warning") {
      try {
        const parsed = codexC2NotificationSchemas.warning.parse(
          notification.params,
        );
        if (!this.#establishing) {
          this.#emit({
            type: "notice",
            notice: {
              id: `codex-warning:${notification.generation}:${notification.sequence}`,
              tone: "warning",
              message: boundedDisplayTextSchema.parse({ text: parsed.message }),
              createdAt: new Date(
                notification.emittedAtMs ?? this.#now(),
              ).toISOString(),
            },
          });
        }
      } catch (error) {
        this.#reportError(error);
        if (!this.#establishing) {
          this.#emit({
            type: "resnapshot_required",
            reason: "contradictory_state",
          });
        }
      }
      return;
    }
    this.#recordMutation(notification.generation, notification.sequence);
    if (this.#establishing) return;
    if (
      this.#failureFencedGeneration === notification.generation &&
      isFailureFencedTranscriptNotification(notification.method)
    ) {
      if (!this.#projectionInvalidated) {
        this.#emit({ type: "run_state_changed", state: "reconciling" });
        this.#invalidateProjection("contradictory_state");
      }
      return;
    }
    if (
      notification.generation !== this.#establishedGeneration ||
      !isCodexC2NotificationMethod(notification.method)
    ) {
      this.#invalidateProjection("sequence_gap");
      return;
    }
    if (this.#projectionInvalidated) return;
    try {
      if (
        !(await this.#applyStableNotification(
          notification.generation,
          notification.sequence,
          notification.method,
          notification.params,
        ))
      ) {
        this.#invalidateProjection("contradictory_state");
      }
    } catch (error) {
      this.#reportError(error);
      this.#invalidateProjection("contradictory_state");
    }
  };

  async #applyStableNotification(
    generation: number,
    sequence: number,
    method: CodexC2NotificationMethod,
    params: unknown,
  ): Promise<boolean> {
    const thread = this.#nativeThread;
    if (!thread) return false;
    switch (method) {
      case "thread/status/changed": {
        const parsed =
          codexC2NotificationSchemas["thread/status/changed"].parse(params);
        if (
          parsed.status.type === "idle" &&
          thread.turns.at(-1)?.status === "inProgress"
        ) {
          // Codex can publish idle immediately before the authoritative
          // turn/completed notification, including after every item has
          // completed. Do not infer interruption or retention from this
          // transport-level hint; the terminal turn is the authority.
          return true;
        }
        const updated = { ...thread, status: parsed.status };
        const liveUpdated = materializeLiveThread(
          updated,
          this.#liveProjectionOverlay.materializedItems(),
        );
        const projection =
          parsed.status.type === "active"
            ? this.#projectThreadHistoryWithStreamingItems(
                liveUpdated,
                this.#streamingNativeItems,
              )
            : await this.#installTerminalizedStreamingProjection(liveUpdated);
        if (parsed.status.type === "active") {
          this.#installProjection(
            projection,
            updated,
            this.#establishedGeneration,
            liveUpdated,
            this.#streamingNativeItems,
          );
        }
        this.#emit({
          type: "run_state_changed",
          state: projection.snapshot.runState,
          ...(projection.snapshot.activeBackendTurnId
            ? {
                activeBackendTurnId: projection.snapshot.activeBackendTurnId,
              }
            : {}),
        });
        return true;
      }
      case "turn/started":
      case "turn/completed": {
        const parsed =
          method === "turn/started"
            ? codexC2NotificationSchemas["turn/started"].parse(params)
            : codexC2NotificationSchemas["turn/completed"].parse(params);
        const notificationTurn = materializeNotificationTurn(
          thread.turns.find(({ id }) => id === parsed.turn.id),
          parsed.turn,
          method,
          this.#streamingNativeItems.get(parsed.turn.id) ?? new Set(),
        );
        if (!notificationTurn) return false;
        const streamingNativeItems = this.#withoutStreamingNativeTurn(
          notificationTurn.id,
        );
        if (method === "turn/completed") {
          this.#liveProjectionOverlay.removeTurn(notificationTurn.id);
        }
        const notificationUpdated: CodexThread = {
          ...thread,
          status:
            method === "turn/started"
              ? { type: "active", activeFlags: [] }
              : notificationTurn.status === "failed"
                ? { type: "systemError" }
                : { type: "idle" },
          turns: replaceById(thread.turns, notificationTurn),
        };
        let paginatedInstallation:
          | {
              readonly adapter: CodexPaginatedHistoryAdapter;
              readonly page: CodexPaginatedNativePage;
            }
          | undefined;
        let updated = notificationUpdated;
        const expectedInstallEpoch = this.#projectionInstallEpoch;
        if (
          method === "turn/completed" &&
          notificationUpdated.historyMode === "paginated"
        ) {
          const adapter = this.#paginatedHistoryAdapter;
          if (!adapter) return false;
          const page = await adapter.refreshCurrentHead(
            SNAPSHOT_TURN_LIMIT,
            new AbortController().signal,
          );
          if (page.thread.status.type === "active") {
            // The provider head advanced beyond this completion before its
            // turn/started lifecycle reached Sedes. Installing that turn
            // would publish an active id with no incremental turn/item
            // events, so require one atomic replacement instead.
            return false;
          }
          if (
            this.#closing ||
            this.#closed ||
            this.#projectionInvalidated ||
            this.#projectionInstallEpoch !== expectedInstallEpoch ||
            this.#nativeThread !== thread ||
            this.#client.lifecycleSnapshot().generation !== generation
          ) {
            return false;
          }
          updated = {
            ...notificationUpdated,
            status: page.thread.status,
            turns: page.thread.turns,
          };
          paginatedInstallation = { adapter, page };
        }
        const liveUpdated = materializeLiveThread(
          updated,
          this.#liveProjectionOverlay.materializedItems(),
        );
        let projection = this.#projectThreadHistoryWithStreamingItems(
          liveUpdated,
          streamingNativeItems,
        );
        if (projection.pendingGeneratedImages.length > 0) {
          projection = {
            ...(await materializeCodexGeneratedImagePublications(
              projection,
              this.#generatedImageProjectionContext(),
            )),
            startNativeTurnIndex: projection.startNativeTurnIndex,
          };
          if (
            this.#closing ||
            this.#closed ||
            this.#projectionInstallEpoch !== expectedInstallEpoch ||
            this.#nativeThread !== thread
          ) {
            return false;
          }
        }
        const backendTurnId = projection.backendTurnIdByNativeId.get(
          notificationTurn.id,
        );
        const projectedTurn = backendTurnId
          ? projection.snapshot.turnsById[backendTurnId]
          : undefined;
        if (!projectedTurn) return false;
        const previousSnapshot = this.#snapshotWindow;
        const previousTurn = backendTurnId
          ? previousSnapshot?.turnsById[backendTurnId]
          : undefined;
        const changedItems = projectedTurn.orderedBackendItemIds
          .map((itemId) => projection.snapshot.itemsById[itemId])
          .filter(
            (item): item is NonNullable<typeof item> =>
              !!item &&
              JSON.stringify(
                previousSnapshot?.itemsById[item.backendItemId],
              ) !== JSON.stringify(item),
          );
        this.#installProjection(
          projection,
          updated,
          this.#establishedGeneration,
          liveUpdated,
          streamingNativeItems,
          paginatedInstallation,
        );
        this.#streamingNativeItems = streamingNativeItems;
        const turnChanged =
          !previousTurn ||
          JSON.stringify(previousTurn) !== JSON.stringify(projectedTurn);
        if (method === "turn/started" && turnChanged) {
          this.#emit({ type: "turn_started", turn: projectedTurn });
        }
        for (const item of changedItems) {
          const previousItem = previousSnapshot?.itemsById[item.backendItemId];
          this.#emit({
            type:
              item.status === "streaming"
                ? previousItem
                  ? "item_updated"
                  : "item_started"
                : "item_completed",
            item,
          });
        }
        if (method === "turn/completed" && turnChanged) {
          this.#emit({ type: "turn_completed", turn: projectedTurn });
        }
        this.#emit({
          type: "run_state_changed",
          state: projection.snapshot.runState,
          ...(projection.snapshot.activeBackendTurnId
            ? {
                activeBackendTurnId: projection.snapshot.activeBackendTurnId,
              }
            : {}),
        });
        return true;
      }
      case "item/started":
      case "item/completed": {
        const parsed =
          method === "item/started"
            ? codexC2NotificationSchemas["item/started"].parse(params)
            : codexC2NotificationSchemas["item/completed"].parse(params);
        const currentTurn = thread.turns.find(({ id }) => id === parsed.turnId);
        const currentItem = currentTurn?.items.find(
          ({ id }) => id === parsed.item.id,
        );
        if (
          !currentTurn ||
          (method === "item/started" && currentItem !== undefined) ||
          (method === "item/completed" &&
            currentItem !== undefined &&
            currentItem.type !== parsed.item.type)
        ) {
          return false;
        }
        const updated = replaceNativeTurnItem(
          thread,
          parsed.turnId,
          parsed.item,
        );
        if (!updated) return false;
        const streamingNativeItems =
          method === "item/started"
            ? this.#withStreamingNativeItem(parsed.turnId, parsed.item.id)
            : this.#withoutStreamingNativeItem(parsed.turnId, parsed.item.id);
        if (method === "item/completed") {
          this.#liveProjectionOverlay.remove(parsed.turnId, parsed.item.id);
        }
        const liveUpdated = materializeLiveThread(
          updated,
          this.#liveProjectionOverlay.materializedItems(),
        );
        const expectedInstallEpoch = this.#projectionInstallEpoch;
        let projection = this.#projectThreadHistoryWithStreamingItems(
          liveUpdated,
          streamingNativeItems,
        );
        if (projection.pendingGeneratedImages.length > 0) {
          projection = {
            ...(await materializeCodexGeneratedImagePublications(
              projection,
              this.#generatedImageProjectionContext(),
            )),
            startNativeTurnIndex: projection.startNativeTurnIndex,
          };
          if (
            this.#closing ||
            this.#closed ||
            this.#projectionInstallEpoch !== expectedInstallEpoch ||
            this.#nativeThread !== thread
          ) {
            return false;
          }
        }
        const backendTurnId = projection.backendTurnIdByNativeId.get(
          parsed.turnId,
        );
        const projectedTurn = backendTurnId
          ? projection.snapshot.turnsById[backendTurnId]
          : undefined;
        const previousTurn = backendTurnId
          ? this.#snapshotWindow?.turnsById[backendTurnId]
          : undefined;
        const items = projectedTurn
          ? projectedTurn.orderedBackendItemIds
              .map((itemId) => projection.snapshot.itemsById[itemId])
              .filter(
                (item): item is NonNullable<typeof item> =>
                  !!item &&
                  JSON.stringify(
                    this.#snapshotWindow?.itemsById[item.backendItemId],
                  ) !== JSON.stringify(item),
              )
          : [];
        this.#installProjection(
          projection,
          updated,
          this.#establishedGeneration,
          liveUpdated,
          streamingNativeItems,
        );
        this.#streamingNativeItems = streamingNativeItems;
        for (const item of items) {
          this.#emit({
            type:
              item.status === "streaming"
                ? method === "item/started"
                  ? "item_started"
                  : "item_updated"
                : "item_completed",
            item,
          });
        }
        if (
          projectedTurn &&
          (!previousTurn ||
            JSON.stringify(previousTurn) !== JSON.stringify(projectedTurn))
        ) {
          this.#emit({ type: "turn_updated", turn: projectedTurn });
        }
        return true;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/commandExecution/outputDelta": {
        const parsed = codexC2NotificationSchemas[method].parse(params);
        return this.#liveProjectionOverlay.appendText(
          parsed.turnId,
          parsed.itemId,
          method === "item/agentMessage/delta"
            ? "agentMessage"
            : method === "item/plan/delta"
              ? "plan"
              : "commandExecution",
          parsed.delta,
        );
      }
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        if (method === "item/reasoning/summaryPartAdded") {
          const parsed = codexC2NotificationSchemas[method].parse(params);
          return this.#liveProjectionOverlay.addReasoningSummaryPart(
            parsed.turnId,
            parsed.itemId,
            parsed.summaryIndex,
          );
        }
        if (method === "item/reasoning/summaryTextDelta") {
          const parsed = codexC2NotificationSchemas[method].parse(params);
          return this.#liveProjectionOverlay.appendReasoningSummary(
            parsed.turnId,
            parsed.itemId,
            parsed.summaryIndex,
            parsed.delta,
          );
        }
        const parsed = codexC2NotificationSchemas[method].parse(params);
        return this.#liveProjectionOverlay.appendReasoningContent(
          parsed.turnId,
          parsed.itemId,
          parsed.contentIndex,
          parsed.delta,
        );
      }
      case "item/fileChange/patchUpdated": {
        const parsed =
          codexC2NotificationSchemas["item/fileChange/patchUpdated"].parse(
            params,
          );
        return this.#liveProjectionOverlay.replaceFileChanges(
          parsed.turnId,
          parsed.itemId,
          parsed.changes,
        );
      }
      case "item/mcpToolCall/progress": {
        const parsed =
          codexC2NotificationSchemas["item/mcpToolCall/progress"].parse(params);
        return this.#liveProjectionOverlay.appendMcpProgress(
          parsed.turnId,
          parsed.itemId,
          parsed.message,
        );
      }
      case "item/fileChange/outputDelta":
        // Codex's file-change output stream is informational command output;
        // the normalized file item is driven by patchUpdated and completed.
        // It does not invalidate the canonical projection.
        codexC2NotificationSchemas[method].parse(params);
        return true;
      case "thread/name/updated": {
        const parsed =
          codexC2NotificationSchemas["thread/name/updated"].parse(params);
        this.#nativeThread = { ...thread, name: parsed.threadName ?? null };
        return true;
      }
      case "error": {
        const parsed = codexC2NotificationSchemas.error.parse(params);
        // A retryable provider error is not a lifecycle boundary. Preserve
        // the active projection and streaming overlay until Codex either
        // resumes deltas or publishes an actual item/turn completion.
        if (parsed.willRetry) return true;
        this.#terminalErrorRecoveryGeneration = generation;
        this.#terminalErrorFallbackThread = materializeLiveThread(
          {
            ...thread,
            turns: thread.turns.map((turn) => turn.id === parsed.turnId
              ? { ...turn, error: parsed.error }
              : turn),
          },
          this.#liveProjectionOverlay.materializedItems(),
        );
        this.#failureFencedGeneration = undefined;
        this.#emit({ type: "run_state_changed", state: "reconciling" });
        this.#invalidateProjection("contradictory_state");
        return true;
      }
      case "thread/settings/updated":
        // Routed before history-mutation accounting by #consumeNotification.
        return false;
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted":
        // Routed as transient notices before history-mutation accounting.
        return false;
      case "warning":
        // Routed as an informational notice before history-mutation accounting.
        return false;
      case "thread/goal/updated":
      case "thread/goal/cleared": {
        // Notifications are invalidation hints only — coalesce and reread via get.
        if (method === "thread/goal/updated") {
          refineCodexThreadGoalUpdatedNotification(
            assertCodexAttestedServerNotificationParams(
              "thread/goal/updated",
              params,
            ),
          );
        } else {
          refineCodexThreadGoalClearedNotification(
            assertCodexAttestedServerNotificationParams(
              "thread/goal/cleared",
              params,
            ),
          );
        }
        this.#invalidateGoalProjection();
        return true;
      }
      case "turn/diff/updated":
      case "turn/plan/updated":
        // These are aggregate presentation hints. Canonical transcript state
        // is carried by fileChange/patchUpdated and plan item lifecycle/delta
        // notifications, so the aggregate cannot invalidate or replace it.
        codexC2NotificationSchemas[method].parse(params);
        return true;
      case "thread/compacted":
        // Compaction rewrites durable history and is a true projection
        // replacement boundary.
        codexC2NotificationSchemas[method].parse(params);
        this.#invalidateProjection("sequence_gap");
        return true;
      case "serverRequest/resolved": {
        const parsed =
          codexC2NotificationSchemas["serverRequest/resolved"].parse(params);
        this.#interactions.observeProviderResolved(
          generation,
          parsed.requestId,
        );
        return true;
      }
      case "thread/tokenUsage/updated":
        return true;
    }
  }

  readonly #consumeLifecycle: CodexLifecycleListener = (lifecycle) => {
    this.#projectionWorkQueue.enqueue(() => {
      this.#consumeLifecycleNow(lifecycle);
    });
  };

  readonly #consumeLifecycleNow: CodexLifecycleListener = (lifecycle) => {
    if (lifecycle.state !== "ready") {
      this.#interactions.deactivate("codex_interaction_daemon_generation_lost");
      this.#streamingNativeItems.clear();
      this.#liveProjectionOverlay.dispose();
      this.#projectionInvalidated = true;
      this.#terminalErrorRecoveryGeneration = undefined;
      this.#terminalErrorFallbackThread = undefined;
      this.#failureFencedGeneration = undefined;
      this.#verifiedGeneratedImagePublicationKeys.clear();
      this.#clearPaginatedHistoryAuthority();
    } else if (
      this.#establishedGeneration !== 0 &&
      lifecycle.generation !== this.#establishedGeneration
    ) {
      this.#streamingNativeItems.clear();
      this.#liveProjectionOverlay.dispose();
      this.#projectionInvalidated = true;
      this.#terminalErrorRecoveryGeneration = undefined;
      this.#terminalErrorFallbackThread = undefined;
      this.#failureFencedGeneration = undefined;
      this.#verifiedGeneratedImagePublicationKeys.clear();
      this.#clearPaginatedHistoryAuthority();
    }
    if (this.#closing || this.#closed || this.#establishedGeneration === 0) {
      return;
    }
    if (lifecycle.state === "ready") {
      if (lifecycle.generation === this.#establishedGeneration) {
        try {
          this.#interactions.activate(lifecycle.generation);
        } catch (error) {
          this.#reportError(error);
          if (!this.#establishing) {
            this.#emit({
              type: "resnapshot_required",
              reason: "contradictory_state",
            });
          }
        }
      }
      if (
        lifecycle.generation !== this.#establishedGeneration &&
        !this.#establishing
      ) {
        this.#usage = {};
        this.#usageGeneration = 0;
        this.#model = undefined;
        this.#modelInputModalities = ["text"];
        this.#markConfirmationUnknown();
        this.#emit({
          type: "run_state_changed",
          state: "reconciling",
        });
        this.#emit({
          type: "resnapshot_required",
          reason: "sequence_gap",
        });
      }
      return;
    }
    this.#usage = {};
    this.#usageGeneration = 0;
    this.#model = undefined;
    this.#modelInputModalities = ["text"];
    this.#markConfirmationUnknown();
    if (!this.#establishing) {
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
    const state = lifecycleRunState(lifecycle);
    if (state && !this.#establishing) {
      this.#emit({ type: "run_state_changed", state });
    }
  };

  #scope(): ExecutionScope {
    return {
      tenantId: this.binding.tenantId,
      principalId: this.binding.ownerPrincipalId,
    };
  }

  #newerSettingsObservation(
    current: CodexSettingsObservationReceipt,
  ): CodexSettingsObservationReceipt | undefined {
    const latest = this.#lastSettingsObservation;
    return latest?.generation === current.generation &&
      latest.inboundSequence > current.inboundSequence
      ? latest
      : undefined;
  }

  #rememberSettingsObservation(
    generation: number,
    inboundSequence: number,
    params: unknown,
  ): CodexSettingsObservationReceipt {
    const parsed =
      codexC2NotificationSchemas["thread/settings/updated"].parse(params);
    const observation = {
      generation,
      inboundSequence,
      modelProvider: parsed.threadSettings.modelProvider,
      settings: codexObservedExecutionSettings(
        parsed.threadSettings.model,
        parsed.threadSettings.effort,
        parsed.threadSettings.serviceTier,
        parsed.threadSettings.approvalPolicy,
        parsed.threadSettings.approvalsReviewer,
        parsed.threadSettings.sandboxPolicy,
      ),
    } satisfies CodexSettingsObservationReceipt;
    this.#lastSettingsObservationGeneration = generation;
    this.#lastSettingsObservationInboundSequence = inboundSequence;
    this.#lastSettingsObservation = observation;
    return observation;
  }

  #applySettingsObservation(
    observation: CodexSettingsObservationReceipt,
  ): void {
    this.#model = {
      provider: observation.modelProvider,
      id: observation.settings.model,
      ...(observation.settings.reasoningEffort
        ? { reasoningEffort: observation.settings.reasoningEffort }
        : {}),
    };
    this.#modelInputModalities = ["text"];
    this.#confirmEffective(observation.settings, observation.generation);
    this.#markSettingsObservationApplied(observation);
    this.#emit({
      type: "capabilities_changed",
      capabilities: this.#capabilities(),
    });
    void this.#refreshModelInputModalities(observation.settings.model)
      .then(() => {
        if (this.#model?.id !== observation.settings.model) return;
        this.#emit({
          type: "capabilities_changed",
          capabilities: this.#capabilities(),
        });
      })
      .catch((error: unknown) => this.#reportError(error));
  }

  async #drainPendingSettingsObservation(signal: AbortSignal): Promise<void> {
    for (
      let attempt = 0;
      attempt < MAXIMUM_ESTABLISHMENT_ATTEMPTS;
      attempt += 1
    ) {
      const observation = this.#pendingSettingsObservation();
      if (!observation) return;
      const desiredReasoningEffort = await this.#resolveImportedReasoningEffort(
        observation.settings.model,
        observation.settings.reasoningEffort,
      );
      this.#assertEstablishmentMayContinue(signal);
      this.#assertCurrentReceipt(observation.generation);
      if (this.#pendingSettingsObservation() !== observation) continue;
      this.#model = {
        provider: observation.modelProvider,
        id: observation.settings.model,
        ...(observation.settings.reasoningEffort
          ? { reasoningEffort: observation.settings.reasoningEffort }
          : {}),
      };
      this.#modelInputModalities = ["text"];
      await this.#refreshModelInputModalities(observation.settings.model);
      this.#confirmEffective(
        observation.settings,
        observation.generation,
        importedDesiredSettings(
          observation.settings,
          desiredReasoningEffort,
          this.#executionSettings.desiredSettings(
            this.#scope(),
            this.binding.applicationThreadId,
          )?.serviceTier,
        ),
      );
      this.#markSettingsObservationApplied(observation);
      return;
    }
    const latest = this.#pendingSettingsObservation();
    if (latest) this.#applySettingsObservation(latest);
  }

  #pendingSettingsObservation(): CodexSettingsObservationReceipt | undefined {
    const latest = this.#lastSettingsObservation;
    if (!latest) return undefined;
    if (latest.generation !== this.#establishedGeneration) return undefined;
    return this.#appliedSettingsObservationGeneration !== latest.generation ||
      this.#appliedSettingsObservationInboundSequence < latest.inboundSequence
      ? latest
      : undefined;
  }

  #markSettingsObservationApplied(
    observation: CodexSettingsObservationReceipt,
  ): void {
    this.#appliedSettingsObservationGeneration = observation.generation;
    this.#appliedSettingsObservationInboundSequence =
      observation.inboundSequence;
  }

  #scheduleDesiredInitialization(
    observation: CodexSettingsObservationReceipt,
  ): void {
    if (this.#desiredInitializationSettled) {
      return;
    }
    const operation = this.#reconcileDesiredInitialization(observation);
    const settled = operation
      .catch((error: unknown) => {
        if (!this.#closing && !this.#closed) this.#reportError(error);
      })
      .finally(() => {
        if (this.#desiredInitializationSettled === settled) {
          this.#desiredInitializationSettled = undefined;
        }
        if (this.#closing || this.#closed) return;
        const latest = this.#lastSettingsObservation;
        if (
          latest?.generation === observation.generation &&
          latest.inboundSequence > observation.inboundSequence
        ) {
          this.#scheduleDesiredInitialization(latest);
        }
      });
    this.#desiredInitializationSettled = settled;
  }

  async #reconcileDesiredInitialization(
    observation: CodexSettingsObservationReceipt,
  ): Promise<void> {
    const desiredReasoningEffort = await this.#resolveImportedReasoningEffort(
      observation.settings.model,
      observation.settings.reasoningEffort,
    );
    if (this.#closing || this.#closed) return;
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== observation.generation ||
      observation.generation !== this.#establishedGeneration ||
      this.#lastSettingsObservation !== observation ||
      desiredReasoningEffort === undefined
    ) {
      return;
    }
    const initializeDesired = importedDesiredSettings(
      observation.settings,
      desiredReasoningEffort,
      this.#executionSettings.desiredSettings(
        this.#scope(),
        this.binding.applicationThreadId,
      )?.serviceTier,
    );
    if (!initializeDesired) return;
    this.#confirmEffective(
      observation.settings,
      observation.generation,
      initializeDesired,
    );
    this.#emit({
      type: "capabilities_changed",
      capabilities: this.#capabilities(),
    });
  }

  #confirmEffective(
    settings: CodexObservedExecutionSettings,
    confirmationGeneration: number,
    initializeDesired?: CodexExecutionSettingsTuple,
  ): void {
    try {
      this.#executionSettings.observeEffective(this.#scope(), {
        applicationThreadId: this.binding.applicationThreadId,
        settings,
        ...(initializeDesired ? { initializeDesired } : {}),
        confirmationGeneration,
        now: this.#now(),
      });
    } catch (error) {
      // A concurrent desired-setting revision may legitimately make this
      // confirmation stale. Keep it pending rather than destabilizing the
      // authoritative conversation projection.
      this.#reportError(error);
    }
  }

  #markConfirmationUnknown(): void {
    try {
      this.#executionSettings.markEffectiveUnknown(this.#scope(), {
        applicationThreadId: this.binding.applicationThreadId,
        now: this.#now(),
      });
    } catch (error) {
      this.#reportError(error);
    }
  }

  #recordMutation(
    generation: number,
    sequence: number,
    replayableDuringPaginatedEstablishment = false,
  ): void {
    if (
      !replayableDuringPaginatedEstablishment &&
      !this.#replayingPaginatedEstablishmentNotification &&
      (this.#establishing || this.#paginatedEstablishmentCatchUp !== undefined)
    ) {
      if (
        generation !== this.#lastUnreplayableEstablishmentMutationGeneration
      ) {
        this.#lastUnreplayableEstablishmentMutationGeneration = generation;
        this.#lastUnreplayableEstablishmentMutationSequence = sequence;
      } else {
        this.#lastUnreplayableEstablishmentMutationSequence = Math.max(
          this.#lastUnreplayableEstablishmentMutationSequence,
          sequence,
        );
      }
    }
    if (generation !== this.#lastMutationGeneration) {
      this.#lastMutationGeneration = generation;
      this.#lastMutationInboundSequence = sequence;
      return;
    }
    this.#lastMutationInboundSequence = Math.max(
      this.#lastMutationInboundSequence,
      sequence,
    );
  }

  #deferPaginatedEstablishmentNotification(
    notification: Parameters<CodexNotificationListener>[0],
  ): boolean {
    if (
      (!this.#establishing &&
        this.#paginatedEstablishmentCatchUp === undefined) ||
      isCodexRpcUndecodableNotification(notification) ||
      notificationThreadId(notification.params) !==
        this.binding.backendConversationId ||
      !isPaginatedTranscriptNotification(notification.method)
    ) {
      return false;
    }
    this.#recordMutation(notification.generation, notification.sequence, true);
    const overflow = this.#paginatedEstablishmentNotificationOverflow;
    if (overflow) {
      this.#paginatedEstablishmentNotificationOverflow = {
        generation:
          overflow.generation === notification.generation
            ? overflow.generation
            : null,
        throughSequence: Math.max(
          overflow.throughSequence,
          notification.sequence,
        ),
      };
      return true;
    }
    const bytes = serializedUtf8Bytes({
      method: notification.method,
      params: notification.params,
    });
    if (
      this.#paginatedEstablishmentNotifications.length >=
        MAXIMUM_PAGINATED_ESTABLISHMENT_NOTIFICATIONS ||
      this.#paginatedEstablishmentNotificationBytes + bytes >
        MAXIMUM_PAGINATED_ESTABLISHMENT_NOTIFICATION_BYTES
    ) {
      this.#paginatedEstablishmentNotificationOverflow = {
        generation: notification.generation,
        throughSequence: notification.sequence,
      };
      return true;
    }
    this.#paginatedEstablishmentNotifications.push({ notification, bytes });
    this.#paginatedEstablishmentNotificationBytes += bytes;
    return true;
  }

  #resetPaginatedEstablishmentNotifications(): void {
    this.#paginatedEstablishmentNotifications = [];
    this.#paginatedEstablishmentNotificationBytes = 0;
    this.#paginatedEstablishmentNotificationOverflow = undefined;
    this.#paginatedEstablishmentCatchUp = undefined;
    this.#paginatedEstablishmentCatchUpDraining = false;
    this.#lastUnreplayableEstablishmentMutationSequence = 0;
    this.#lastUnreplayableEstablishmentMutationGeneration = 0;
  }

  #establishmentMutationRequiresRetry(
    receipt: { readonly generation: number; readonly inboundSequence: number },
    allowPaginatedCatchUp = this.#paginatedEstablishmentCatchUp?.generation ===
      receipt.generation &&
      this.#paginatedEstablishmentCatchUp.afterSequence ===
        receipt.inboundSequence,
  ): boolean {
    if (allowPaginatedCatchUp) {
      this.#discardSupersededPaginatedEstablishmentNotifications(receipt);
    }
    if (
      this.#lastMutationGeneration !== receipt.generation ||
      this.#lastMutationInboundSequence <= receipt.inboundSequence
    ) {
      return false;
    }
    if (!allowPaginatedCatchUp) return true;
    if (
      this.#paginatedEstablishmentNotificationOverflow ||
      (this.#lastUnreplayableEstablishmentMutationGeneration ===
        receipt.generation &&
        this.#lastUnreplayableEstablishmentMutationSequence >
          receipt.inboundSequence)
    ) {
      throw codexError(
        "unavailable",
        "Codex paginated catch-up could not preserve the live resume boundary.",
        "codex_paginated_catch_up_unavailable",
        true,
      );
    }
    return false;
  }

  #discardSupersededPaginatedEstablishmentNotifications(receipt: {
    readonly generation: number;
    readonly inboundSequence: number;
  }): void {
    this.#paginatedEstablishmentNotifications =
      this.#paginatedEstablishmentNotifications.filter((entry) => {
        const superseded =
          entry.notification.generation === receipt.generation &&
          entry.notification.sequence <= receipt.inboundSequence;
        if (superseded) {
          this.#paginatedEstablishmentNotificationBytes = Math.max(
            0,
            this.#paginatedEstablishmentNotificationBytes - entry.bytes,
          );
        }
        return !superseded;
      });
    const overflow = this.#paginatedEstablishmentNotificationOverflow;
    if (
      overflow?.generation === receipt.generation &&
      overflow.throughSequence <= receipt.inboundSequence
    ) {
      this.#paginatedEstablishmentNotificationOverflow = undefined;
    }
  }

  #armPaginatedEstablishmentCatchUp(
    historyMode: CodexThread["historyMode"],
    generation: number,
    afterSequence: number,
  ): void {
    this.#paginatedEstablishmentCatchUp =
      historyMode === "paginated" ? { generation, afterSequence } : undefined;
  }

  #releasePaginatedEstablishmentNotifications(): void {
    const catchUp = this.#paginatedEstablishmentCatchUp;
    if (!catchUp) {
      this.#resetPaginatedEstablishmentNotifications();
      return;
    }
    if (this.#paginatedEstablishmentCatchUpDraining) return;
    this.#paginatedEstablishmentCatchUpDraining = true;
    const operation = this.#notificationWork.then(
      async () => await this.#drainPaginatedEstablishmentNotifications(catchUp),
    );
    this.#notificationWork = operation.catch((error) => {
      if (this.#paginatedEstablishmentCatchUp !== catchUp) return;
      this.#reportError(error);
      this.#resetPaginatedEstablishmentNotifications();
      this.#invalidateProjection("contradictory_state");
    });
  }

  async #drainPaginatedEstablishmentNotifications(catchUp: {
    readonly generation: number;
    readonly afterSequence: number;
  }): Promise<void> {
    let lastSequence = catchUp.afterSequence;
    for (;;) {
      if (this.#paginatedEstablishmentCatchUp !== catchUp) return;
      if (this.#paginatedEstablishmentNotificationOverflow) {
        throw new Error("codex_paginated_establishment_buffer_overflow");
      }
      const entry = this.#paginatedEstablishmentNotifications.shift();
      if (!entry) {
        this.#resetPaginatedEstablishmentNotifications();
        return;
      }
      this.#paginatedEstablishmentNotificationBytes = Math.max(
        0,
        this.#paginatedEstablishmentNotificationBytes - entry.bytes,
      );
      const { notification } = entry;
      if (notification.generation !== catchUp.generation) {
        throw new Error("codex_paginated_establishment_generation_changed");
      }
      if (notification.sequence <= catchUp.afterSequence) {
        continue;
      }
      if (notification.sequence <= lastSequence) {
        throw new Error("codex_paginated_establishment_sequence_invalid");
      }
      lastSequence = notification.sequence;
      this.#replayingPaginatedEstablishmentNotification = true;
      try {
        await this.#consumeNotificationNow(notification);
      } finally {
        this.#replayingPaginatedEstablishmentNotification = false;
      }
      if (this.#paginatedEstablishmentCatchUp !== catchUp) return;
      if (this.#projectionInvalidated) {
        this.#resetPaginatedEstablishmentNotifications();
        return;
      }
    }
  }

  #recordGoalNotification(generation: number, sequence: number): void {
    if (generation !== this.#lastGoalNotificationGeneration) {
      this.#lastGoalNotificationGeneration = generation;
      this.#lastGoalNotificationInboundSequence = sequence;
      return;
    }
    this.#lastGoalNotificationInboundSequence = Math.max(
      this.#lastGoalNotificationInboundSequence,
      sequence,
    );
  }

  #emit(event: BackendConversationEvent): void {
    if (this.#closed) return;
    const sequenced = {
      handleSequence: this.#nextHandleSequence,
      event,
    } satisfies SequencedBackendEvent;
    this.#nextHandleSequence += 1;
    this.#journal.push(sequenced);
    if (this.#journal.length > MAXIMUM_EVENT_JOURNAL) {
      this.#journal.splice(0, this.#journal.length - MAXIMUM_EVENT_JOURNAL);
    }
    for (const subscriber of [...this.#eventSubscribers]) {
      if (sequenced.handleSequence <= subscriber.after) continue;
      this.#invokeEventListener(subscriber.listener, sequenced);
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  #subscribeFrom(
    epoch: number,
    after: number,
    listener: BackendEventListener,
  ): Unsubscribe {
    this.#assertOpen();
    if (
      epoch !== this.#projectionEpoch ||
      this.#projectionSubscriptionClaimed
    ) {
      throw codexError(
        "invalid_state",
        "The Codex projection subscription is stale or already claimed.",
        "codex_projection_subscription_claimed",
      );
    }
    this.#projectionSubscriptionClaimed = true;
    const earliest = this.#journal[0]?.handleSequence;
    if (earliest !== undefined && after < earliest - 1) {
      this.#invokeEventListener(listener, {
        handleSequence: this.#nextHandleSequence,
        event: {
          type: "resnapshot_required",
          reason: "buffer_overflow",
        },
      });
      this.#nextHandleSequence += 1;
    } else {
      for (const event of this.#journal) {
        if (event.handleSequence > after) {
          this.#invokeEventListener(listener, event);
        }
      }
    }
    const subscriber = { after, listener };
    this.#eventSubscribers.add(subscriber);
    // A thread/resume performed while establishing this projection can replay
    // a still-pending Codex server request. That request is not represented in
    // thread history, so its interaction-opened event may precede the new
    // projection baseline. Re-emit the bridge's authoritative pending set to
    // the newly installed projection subscriber.
    for (const interaction of this.#interactions.pendingInteractions()) {
      this.#invokeEventListener(listener, {
        handleSequence: this.#nextHandleSequence,
        event: { type: "interaction_opened", interaction },
      });
      this.#nextHandleSequence += 1;
    }
    return () => this.#eventSubscribers.delete(subscriber);
  }

  #invokeEventListener(
    listener: BackendEventListener,
    event: SequencedBackendEvent,
  ): void {
    try {
      listener(event);
    } catch (error) {
      this.#reportError(error);
    }
  }

  async #performClose(evicted = false): Promise<void> {
    if (this.#closing || this.#closed) return;
    this.#closing = true;
    this.#projectionWorkQueue.execute(() => {
      this.#projectionInvalidated = true;
      this.#projectionInstallEpoch += 1;
      this.#clearPaginatedHistoryAuthority();
      this.#liveProjectionOverlay.dispose();
    });
    await this.#establishmentSettled;
    await this.#desiredInitializationSettled;
    await this.#notificationWork;
    this.#interactions.close();
    this.#closed = true;
    this.#unsubscribeNotifications();
    this.#unsubscribeLifecycle();
    this.#unsubscribeManagedTui();
    let release = false;
    try {
      const lifecycle = this.#client.lifecycleSnapshot();
      if (
        this.#subscribedGeneration === 0 ||
        lifecycle.generation !== this.#subscribedGeneration ||
        lifecycle.state !== "ready"
      ) {
        release = true;
        return;
      }
      await this.#unsubscribeBestEffort(this.#subscribedGeneration, evicted);
      release = true;
    } catch (error) {
      throw mapCodexReadError(error);
    } finally {
      this.#releaseAgentToolCliEnvironmentLease();
      await this.#managedTui?.releaseRuntime(
        this.#managedTuiAuthority(),
        this.#establishedGeneration,
      );
      this.#listeners.clear();
      this.#eventSubscribers.clear();
      this.#journal.length = 0;
      this.#nativeThread = undefined;
      this.#nativeTurnById.clear();
      this.#streamingNativeItems.clear();
      this.#snapshotWindow = undefined;
      this.#projectedItemByNativeCoordinate.clear();
      this.#projectedItemCount = 0;
      this.#projectionSerializedBytes = 0;
      if (release) {
        this.#releaseOwnership();
        await this.#runtimeLease?.release(evicted);
      }
    }
  }

  async #unsubscribeBestEffort(generation: number, evicted = false): Promise<void> {
    if (this.#client.persistentSessions) {
      await this.#client.persistentSessions.detachThread(this.binding.backendConversationId, generation, evicted);
      return;
    }
    let unsubscribeFailure: unknown;
    for (
      let attempt = 0;
      attempt < MAXIMUM_UNSUBSCRIBE_ATTEMPTS;
      attempt += 1
    ) {
      const lifecycle = this.#client.lifecycleSnapshot();
      if (lifecycle.generation !== generation || lifecycle.state !== "ready") {
        return;
      }
      try {
        await this.#client.requestWithReceipt(
          codexThreadUnsubscribeMethod,
          { threadId: this.binding.backendConversationId },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        return;
      } catch (error) {
        unsubscribeFailure = error;
        const current = this.#client.lifecycleSnapshot();
        if (current.generation !== generation || current.state !== "ready") {
          return;
        }
        if (!(error instanceof CodexRpcDeliveryError)) break;
      }
    }

    // thread/unsubscribe is connection-local and idempotent: a retry proves
    // either `unsubscribed` or `notSubscribed` when its response arrives. Once
    // this idle handle has detached all local listeners and interaction
    // routing, a still-ambiguous response leaves only a harmless stale remote
    // subscription until the shared connection naturally closes. Report that
    // uncertainty, but do not quarantine the thread or disrupt sibling work by
    // retiring their shared generation.
    this.#reportError(
      codexError(
        "unavailable",
        "Codex could not confirm release of an idle thread subscription.",
        "codex_unsubscribe_reconciliation_unproven",
        true,
        unsubscribeFailure,
      ),
    );
  }

  async #acquireAgentToolCliEnvironment(
    signal: AbortSignal,
  ): Promise<CodexAgentToolCliEnvironmentResolution> {
    if (this.#agentToolCliEnvironmentLease) {
      return this.#agentToolCliEnvironmentLease;
    }
    let resolution: CodexAgentToolCliEnvironmentResolution;
    try {
      resolution = await this.#agentToolCliEnvironment.acquire(
        this.#scope(),
        this.binding.applicationThreadId,
        { signal },
      );
    } catch (error) {
      this.#reportError(error);
      return Object.freeze({
        availability: "unavailable",
        reason: "sidecar_unavailable",
      });
    }
    if (resolution.availability !== "available") return resolution;
    if (this.#closing || this.#closed || signal.aborted) {
      resolution.release();
      return Object.freeze({
        availability: "unavailable",
        reason: "sidecar_unavailable",
      });
    }
    this.#installAgentToolCliEnvironmentLease(resolution);
    return resolution;
  }

  #installAgentToolCliEnvironmentLease(
    lease: Extract<
      CodexAgentToolCliEnvironmentResolution,
      { readonly availability: "available" }
    >,
  ): void {
    if (this.#agentToolCliEnvironmentLease) {
      throw new Error("codex_agent_tool_cli_lease_already_installed");
    }
    this.#agentToolCliEnvironmentLease = lease;
    void lease.closed.then(
      () => this.#retireAgentToolCliEnvironmentLease(lease),
      (error) => {
        this.#reportError(error);
        this.#retireAgentToolCliEnvironmentLease(lease);
      },
    );
  }

  #retireAgentToolCliEnvironmentLease(
    lease: Extract<
      CodexAgentToolCliEnvironmentResolution,
      { readonly availability: "available" }
    >,
  ): void {
    if (this.#agentToolCliEnvironmentLease !== lease) return;
    this.#agentToolCliEnvironmentLease = undefined;
    lease.release();
  }

  #releaseAgentToolCliEnvironmentLease(): void {
    const lease = this.#agentToolCliEnvironmentLease;
    if (!lease) return;
    this.#agentToolCliEnvironmentLease = undefined;
    lease.release();
  }

  #managedTuiAuthority(): import("./codex-managed-tui-controller.js").CodexManagedTuiHandleAuthority {
    return {
      scope: this.#scope(),
      applicationThreadId: this.binding.applicationThreadId,
      backendInstanceId: this.binding.backendInstanceId,
      connectionProfileId: this.binding.connectionProfileId,
      executionEnvironmentId: this.binding.executionEnvironmentId,
      backendConversationId: this.binding.backendConversationId,
      workspaceId: this.#workspaceId,
      canonicalWorkspacePath: this.#canonicalWorkspacePath,
      opaqueBindingDetail: this.#opaqueBindingDetail,
      runtimeLeaseId: this.#managedTuiRuntimeLeaseId,
    };
  }

  #historyCursor(before: number): string {
    return `codex-history:${this.#historyNonce}:${before}`;
  }

  #parseHistoryCursor(cursor: string): number {
    const match = /^codex-history:([0-9a-f-]{36}):(\d+)$/u.exec(cursor);
    const before = match ? Number(match[2]) : Number.NaN;
    if (
      !match ||
      match[1] !== this.#historyNonce ||
      !Number.isSafeInteger(before) ||
      before <= 0 ||
      !this.#nativeThread ||
      before > this.#nativeThread.turns.length
    ) {
      throw codexError(
        "rejected",
        "The Codex history cursor is invalid or stale.",
        "codex_history_cursor_invalid",
      );
    }
    return before;
  }

  #ownsServerRequestRoute(route: CodexServerRequestRoute): boolean {
    if (
      route.nativeThreadId !== this.binding.backendConversationId ||
      !this.#nativeThread
    ) {
      return false;
    }
    if (!route.nativeTurnId) {
      if (!route.nativeCallId) return route.nativeItemId === undefined;
      const activeTurnId = activeNativeTurnId(this.#nativeThread);
      return Boolean(
        activeTurnId &&
        this.#nativeThread.turns.some(
          ({ id, status }) => id === activeTurnId && status === "inProgress",
        ),
      );
    }
    const turn = this.#nativeThread.turns.find(
      ({ id }) => id === route.nativeTurnId,
    );
    if (
      !turn ||
      turn.status !== "inProgress" ||
      activeNativeTurnId(this.#nativeThread) !== turn.id
    ) {
      return false;
    }
    // Permission requests may arrive before the corresponding item-started
    // notification, and requests raised by a nested custom tool can reference
    // an item that is not represented in the stable thread projection. The
    // generation-qualified exclusive thread lease plus the one current active
    // turn are the authorization boundary; an observed item is only eventual
    // presentation state and cannot be required for routing.
    return true;
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) throw conversationClosed();
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics never affect projection delivery.
    }
  }
}

function assertCompleteLegacyResume(response: CodexThreadResumeResponse): void {
  if (
    response.initialTurnsPage != null ||
    response.turnsBackwardsCursor != null ||
    response.itemsBackwardsCursor != null
  ) {
    throw codexError(
      "incompatible_protocol",
      "Codex returned paginated history that cannot be projected completely.",
      "codex_history_incomplete",
    );
  }
}

export function selectCodexSnapshotWindow(
  snapshot: BackendConversationSnapshot,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly start: number;
} {
  const start = Math.max(
    0,
    snapshot.orderedBackendTurnIds.length - SNAPSHOT_TURN_LIMIT,
  );
  const turnIds = snapshot.orderedBackendTurnIds.slice(start);
  const turnsById = Object.fromEntries(
    turnIds.map((turnId) => [turnId, snapshot.turnsById[turnId]!]),
  );
  const itemIds = turnIds.flatMap(
    (turnId) => turnsById[turnId]!.orderedBackendItemIds,
  );
  const itemsById = Object.fromEntries(
    itemIds.map((itemId) => [itemId, snapshot.itemsById[itemId]!]),
  );
  return {
    start,
    snapshot: {
      orderedBackendTurnIds: turnIds,
      turnsById,
      itemsById,
      runState: snapshot.runState,
      ...(snapshot.activeBackendTurnId &&
      turnsById[snapshot.activeBackendTurnId]
        ? { activeBackendTurnId: snapshot.activeBackendTurnId }
        : {}),
    },
  };
}

function historyPage(
  snapshot: BackendConversationSnapshot,
  turnIds: readonly string[],
  previousCursor: string | undefined,
): BackendHistoryPage {
  const turnsById = Object.fromEntries(
    turnIds.map((turnId) => [turnId, snapshot.turnsById[turnId]!]),
  );
  const itemIds = turnIds.flatMap(
    (turnId) => turnsById[turnId]!.orderedBackendItemIds,
  );
  return backendHistoryPageSchema.parse({
    orderedBackendTurnIds: turnIds,
    turnsById,
    itemsById: Object.fromEntries(
      itemIds.map((itemId) => [itemId, snapshot.itemsById[itemId]!]),
    ),
    ...(previousCursor ? { previousCursor } : {}),
  });
}

export function projectCodexThreadHistory(
  thread: CodexThread,
  correlationScope: CodexSubmissionCorrelationScope,
  streamingNativeItems: CodexStreamingNativeItems,
  generatedImages: import("./codex-history-projector.js").CodexGeneratedImageProjectionContext,
) {
  try {
    return projectCodexHistory(
      thread,
      correlationScope,
      streamingNativeItems,
      generatedImages,
    );
  } catch (error) {
    throw mapCodexHistoryProjectionError(error);
  }
}

export function mapCodexHistoryProjectionError(error: unknown): unknown {
  if (!(error instanceof CodexHistoryProjectionError)) return error;
  if (error.code === "codex_message_payload_too_large") {
    return codexError(
      "incompatible_protocol",
      "Codex returned conversation content that exceeds the supported message size.",
      error.code,
      false,
      error,
    );
  }
  if (error.code === "history_too_large") {
    return codexError(
      "unavailable",
      "This Codex thread is too large to display safely.",
      "history_too_large",
      false,
      error,
    );
  }
  return codexError(
    "incompatible_protocol",
    "Codex returned incomplete or invalid thread history.",
    error.code,
    false,
    error,
  );
}

function copyStreamingNativeItems(
  source: CodexStreamingNativeItems,
): Map<string, Set<string>> {
  return new Map(
    [...source].map(([turnId, itemIds]) => [turnId, new Set(itemIds)]),
  );
}

function inferStreamingNativeItems(
  thread: CodexThread,
): Map<string, Set<string>> {
  const activeTurn = thread.turns.at(-1);
  if (activeTurn?.status !== "inProgress") return new Map();
  const lastItem = activeTurn.items.at(-1);
  if (
    lastItem?.type !== "agentMessage" &&
    lastItem?.type !== "plan" &&
    lastItem?.type !== "reasoning"
  ) {
    return new Map();
  }
  // Native history has no lifecycle field for delta-bearing text items. On
  // attach, the last such item of an active turn is the only truthful live
  // candidate until item/completed supplies the terminal boundary. Persist
  // this inference when the projection installs so unrelated notifications
  // cannot prematurely make the item terminal.
  return new Map([[activeTurn.id, new Set([lastItem.id])]]);
}

function inferLiveProjectionItems(
  thread: CodexThread,
): Map<string, Set<string>> {
  const inferred = inferStreamingNativeItems(thread);
  const activeTurn = thread.turns.at(-1);
  if (activeTurn?.status !== "inProgress") return inferred;
  for (const item of activeTurn.items) {
    if (
      supportsLiveProjection(item) &&
      "status" in item &&
      item.status === "inProgress"
    ) {
      const items = inferred.get(activeTurn.id) ?? new Set<string>();
      items.add(item.id);
      inferred.set(activeTurn.id, items);
    }
  }
  return inferred;
}

function liveProjectionSeeds(
  thread: CodexThread,
  projection: CodexHistoryProjection,
  streamingNativeItems: CodexStreamingNativeItems,
): readonly CodexLiveProjectionSeed[] {
  const seeds: CodexLiveProjectionSeed[] = [];
  for (const turn of thread.turns) {
    const liveIds = streamingNativeItems.get(turn.id);
    if (!liveIds) continue;
    for (const item of turn.items) {
      if (!liveIds.has(item.id) || !supportsLiveProjection(item)) continue;
      const coordinate = projection.projectedItemByNativeCoordinate.get(
        codexNativeItemCoordinate(turn.id, item.id),
      );
      if (!coordinate || coordinate.itemType !== item.type) continue;
      seeds.push({ item, coordinate });
    }
  }
  return seeds;
}

function supportsLiveProjection(item: CodexThreadItem): boolean {
  return (
    item.type === "agentMessage" ||
    item.type === "plan" ||
    item.type === "commandExecution" ||
    item.type === "reasoning" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall"
  );
}

function materializeLiveThread(
  settled: CodexThread,
  liveItems: readonly CodexLiveProjectionFlushItem[],
): CodexThread {
  if (liveItems.length === 0) return settled;
  const replacements = new Map(
    liveItems.map(({ nativeTurnId, nativeItemId, item }) => [
      codexNativeItemCoordinate(nativeTurnId, nativeItemId),
      item,
    ]),
  );
  return {
    ...settled,
    turns: settled.turns.map((turn) => ({
      ...turn,
      items: turn.items.map(
        (item) =>
          replacements.get(codexNativeItemCoordinate(turn.id, item.id)) ?? item,
      ),
    })),
  };
}

type CodexSubmissionRetryAnchor = {
  readonly version: 2;
  readonly threadId: string;
  readonly historyMode: "legacy" | "paginated";
  readonly terminalTurnId: string | null;
  readonly terminalIdentityDigest: string;
};

export function serializeCodexSubmissionRetryAnchor(
  thread: CodexThread,
): string {
  return serializeCodexSubmissionRetryAnchorWithDomain(
    thread,
    "sedes.codex-terminal-identity.v1\0",
  );
}

function serializeCodexSubmissionRetryAnchorWithDomain(
  thread: CodexThread,
  terminalIdentityDomain: string,
): string {
  const terminalTurn = thread.turns.at(-1);
  const anchor: CodexSubmissionRetryAnchor = {
    version: 2,
    threadId: thread.id,
    historyMode: thread.historyMode,
    terminalTurnId: terminalTurn?.id ?? null,
    terminalIdentityDigest: terminalTurnIdentityDigest(
      terminalTurn,
      terminalIdentityDomain,
    ),
  };
  const encoded = Buffer.from(JSON.stringify(anchor), "utf8").toString(
    "base64url",
  );
  const serialized = `${RETRY_ANCHOR_PREFIX}${encoded}`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES) {
    throw codexError(
      "internal",
      "Codex could not capture a bounded submission retry anchor.",
      "codex_submission_anchor_oversized",
    );
  }
  return serialized;
}

export function codexSubmissionRetryAnchorMatches(
  serialized: string,
  thread: CodexThread,
): boolean {
  const anchor = parseCodexSubmissionRetryAnchor(serialized);
  if (!anchor) return false;
  const current = serializeCodexSubmissionRetryAnchor(thread);
  if (current === serialized) return true;
  // Pre-rename v2 anchors are durable retry evidence. Recompute their exact
  // historical bytes only for comparison; newly captured anchors stay Sedes.
  return (
    serializeCodexSubmissionRetryAnchorWithDomain(
      thread,
      "harness.codex-terminal-identity.v1\0",
    ) === serialized
  );
}

function parseCodexSubmissionRetryAnchor(
  serialized: string,
): CodexSubmissionRetryAnchor | undefined {
  if (
    !serialized.startsWith(RETRY_ANCHOR_PREFIX) ||
    Buffer.byteLength(serialized, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES
  ) {
    return undefined;
  }
  const encoded = serialized.slice(RETRY_ANCHOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Object.keys(decoded).length !== 5 ||
    !("version" in decoded) ||
    decoded.version !== 2 ||
    !("threadId" in decoded) ||
    typeof decoded.threadId !== "string" ||
    decoded.threadId.length === 0 ||
    !("historyMode" in decoded) ||
    (decoded.historyMode !== "legacy" && decoded.historyMode !== "paginated") ||
    !("terminalTurnId" in decoded) ||
    (decoded.terminalTurnId !== null &&
      (typeof decoded.terminalTurnId !== "string" ||
        decoded.terminalTurnId.length === 0)) ||
    !("terminalIdentityDigest" in decoded) ||
    typeof decoded.terminalIdentityDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(decoded.terminalIdentityDigest)
  ) {
    return undefined;
  }
  return decoded as CodexSubmissionRetryAnchor;
}

function terminalTurnIdentityDigest(
  turn: CodexThread["turns"][number] | undefined,
  domain: string,
) {
  const hash = createHash("sha256").update(domain);
  if (!turn) return hash.update("empty").digest("base64url");
  hash
    .update(turn.id)
    .update("\0")
    .update(turn.status)
    .update("\0")
    .update(turn.error?.message ?? "");
  for (const item of turn.items) {
    hash
      .update("\0")
      .update(item.type)
      .update("\0")
      .update(item.id)
      .update("\0");
    if ("status" in item && typeof item.status === "string") {
      hash.update(item.status);
    }
  }
  return hash.digest("base64url");
}

export function normalizeCodexTurnStatuses(thread: CodexThread): CodexThread {
  const inProgressIndexes = thread.turns.flatMap((turn, index) =>
    turn.status === "inProgress" ? [index] : [],
  );
  if (inProgressIndexes.length === 0) return thread;
  const staleIndexes =
    thread.status.type === "active" &&
    thread.turns.at(-1)?.status === "inProgress"
      ? inProgressIndexes.slice(0, -1)
      : inProgressIndexes;
  if (staleIndexes.length === 0) return thread;

  const stale = new Set(staleIndexes);
  return {
    ...thread,
    turns: thread.turns.map((turn, index) =>
      stale.has(index) ? { ...turn, status: "interrupted" as const } : turn,
    ),
  };
}

function activeNativeTurnId(thread: CodexThread): string | undefined {
  if (thread.status.type !== "active") return undefined;
  const active = thread.turns.filter(({ status }) => status === "inProgress");
  return active.length === 1 ? active[0]!.id : undefined;
}

function isFailureFencedTranscriptNotification(method: string): boolean {
  return (
    method === "thread/status/changed" ||
    method === "thread/compacted" ||
    method === "error" ||
    method.startsWith("turn/") ||
    method.startsWith("item/")
  );
}

function failInProgressNativeItem(item: CodexThreadItem): CodexThreadItem {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return item.status === "inProgress"
        ? { ...item, status: "failed" }
        : item;
    case "imageGeneration":
      return item.status === "in_progress"
        ? { ...item, status: "failed" }
        : item;
    default:
      return item;
  }
}

function materializeAcceptedTurn(
  turn: CodexThread["turns"][number],
): CodexThread["turns"][number] {
  if (turn.itemsView === "full") return turn;
  if (
    turn.itemsView === "notLoaded" &&
    turn.status === "inProgress" &&
    turn.items.length === 0
  ) {
    // Stable 0.153.0 acknowledges turn/start with an identity-only turn.
    // Subsequent notifications supply its items; the acceptance receipt itself
    // is sufficient to install an empty live turn without inventing native
    // item identities or issuing another mutation.
    return { ...turn, itemsView: "full" };
  }
  throw codexError(
    "incompatible_protocol",
    "Codex acknowledged a turn with an unsupported partial item view.",
    "codex_started_turn_partial",
    false,
    undefined,
    true,
  );
}

function materializeNotificationTurn(
  current: CodexThread["turns"][number] | undefined,
  turn: CodexThread["turns"][number],
  method: "turn/started" | "turn/completed",
  streamingItemIds: ReadonlySet<string>,
): CodexThread["turns"][number] | undefined {
  if (method === "turn/completed" && current) {
    if (turn.itemsView !== "full") {
      // A terminal summary proves turn status but not retention of provisional
      // output. It is safe to close over the live cut only after every
      // streaming item received its own item/completed evidence.
      return streamingItemIds.size === 0
        ? { ...turn, items: current.items, itemsView: "full" }
        : undefined;
    }
    const terminalItems = turn.items;
    const terminalById = new Map(terminalItems.map((item) => [item.id, item]));
    if (
      current.items.some((item) => {
        const terminal = terminalById.get(item.id);
        return !terminal || terminal.type !== item.type;
      })
    ) {
      // A full terminal view explicitly omitted a live item. Incremental
      // projection has no item-removal event, so require a true authoritative
      // replacement rather than fabricating retention.
      return undefined;
    }
    const liveIds = new Set(current.items.map((item) => item.id));
    let sawNewItem = false;
    for (const terminalItem of terminalItems) {
      if (!liveIds.has(terminalItem.id)) {
        sawNewItem = true;
      } else if (sawNewItem) {
        // Unknown terminal items are representable only as a pure tail
        // extension. An interleaved item would either reorder existing
        // normalized identities or guess at a provider ID rewrite.
        return undefined;
      }
    }
    // Item order is established by the live lifecycle. Completion may rewrite
    // payloads, reorder its full view, or omit provisional items; none of those
    // may renumber already-published normalized identities. Apply terminal
    // payloads in-place and append only genuinely new terminal items.
    const items = [
      ...current.items.map((item) => terminalById.get(item.id) ?? item),
      ...terminalItems.filter((item) => !liveIds.has(item.id)),
    ];
    return { ...turn, items, itemsView: "full" };
  }
  if (turn.itemsView === "full") return turn;
  if (
    method === "turn/started" &&
    turn.itemsView === "notLoaded" &&
    turn.status === "inProgress" &&
    turn.items.length === 0
  ) {
    return current
      ? {
          ...turn,
          items: current.items,
          itemsView: "full",
        }
      : { ...turn, itemsView: "full" };
  }
  return undefined;
}

function replaceById<Item extends { readonly id: string }>(
  items: readonly Item[],
  replacement: Item,
): Item[] {
  const index = items.findIndex(({ id }) => id === replacement.id);
  if (index < 0) return [...items, replacement];
  return items.map((item, itemIndex) =>
    itemIndex === index ? replacement : item,
  );
}

function replaceNativeTurnItem(
  thread: CodexThread,
  turnId: string,
  item: CodexThread["turns"][number]["items"][number],
): CodexThread | undefined {
  const turn = thread.turns.find(({ id }) => id === turnId);
  if (!turn) return undefined;
  return {
    ...thread,
    turns: replaceById(thread.turns, {
      ...turn,
      items: replaceById(turn.items, item),
    }),
  };
}

function notificationThreadId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  if ("threadId" in params && typeof params.threadId === "string") {
    return params.threadId;
  }
  if (
    "thread" in params &&
    typeof params.thread === "object" &&
    params.thread !== null &&
    "id" in params.thread &&
    typeof params.thread.id === "string"
  ) {
    return params.thread.id;
  }
  return undefined;
}

function isPaginatedTranscriptNotification(method: string): boolean {
  switch (method) {
    case "thread/tokenUsage/updated":
    case "thread/settings/updated":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "mcpServer/startupStatus/updated":
    case "warning":
      return false;
    default:
      return true;
  }
}

function mayCompleteGeneratedImage(
  notification: Parameters<CodexNotificationListener>[0],
): boolean {
  if (isCodexRpcUndecodableNotification(notification)) return false;
  if (notification.method === "item/completed") {
    const params = notification.params as {
      readonly item?: { readonly type?: unknown };
    };
    return params.item?.type === "imageGeneration";
  }
  if (notification.method === "turn/completed") {
    const params = notification.params as {
      readonly turn?: {
        readonly items?: readonly { readonly type?: unknown }[];
      };
    };
    return (
      params.turn?.items?.some(({ type }) => type === "imageGeneration") ===
      true
    );
  }
  return false;
}

export function verifiedCodexProjectionBytes(
  projection: Pick<
    CodexHistoryProjection,
    "snapshot" | "serializedSnapshotBytes"
  >,
): number {
  const actualBytes = serializedUtf8Bytes(projection.snapshot);
  if (actualBytes !== projection.serializedSnapshotBytes) {
    throw codexError(
      "incompatible_protocol",
      "The Codex projection byte receipt did not match its snapshot.",
      "codex_projection_byte_ledger_drift",
      false,
      undefined,
      true,
    );
  }
  return actualBytes;
}

function serializedRecordAdditionBytes(
  key: string,
  value: unknown,
  recordAlreadyHasEntries: boolean,
): number {
  return (
    serializedUtf8Bytes({ [key]: value }) -
    serializedUtf8Bytes({}) +
    (recordAlreadyHasEntries ? 1 : 0)
  );
}

function endsWithExactIds(
  complete: readonly string[],
  suffix: readonly string[],
): boolean {
  if (suffix.length > complete.length) return false;
  const offset = complete.length - suffix.length;
  return suffix.every((value, index) => complete[offset + index] === value);
}

function sameLiveSliceIdentity(
  previous: BackendConversationSnapshot["itemsById"][string],
  next: BackendConversationSnapshot["itemsById"][string],
  itemType: CodexThreadItem["type"],
): boolean {
  if (
    previous.backendItemId !== next.backendItemId ||
    previous.backendTurnId !== next.backendTurnId ||
    previous.semanticKind !== next.semanticKind ||
    previous.sourceOrder !== next.sourceOrder ||
    previous.startedAt !== next.startedAt
  ) {
    return false;
  }
  if (itemType !== "fileChange") return true;
  if (
    previous.semanticKind !== "file_change" ||
    next.semanticKind !== "file_change"
  ) {
    return previous.semanticKind === next.semanticKind;
  }
  return (
    previous.operation === next.operation &&
    JSON.stringify(previous.path) === JSON.stringify(next.path) &&
    JSON.stringify(previous.destinationPath) ===
      JSON.stringify(next.destinationPath)
  );
}

function lifecycleRunState(
  lifecycle: CodexClientLifecycleSnapshot,
): "disconnected" | "reconciling" | undefined {
  switch (lifecycle.state) {
    case "starting":
    case "reconciling":
      return "reconciling";
    case "unavailable":
    case "circuit_open":
    case "closing":
    case "closed":
      return "disconnected";
    case "ready":
      return undefined;
  }
}

function projectionCancelled(cause: unknown): BackendError {
  return codexError(
    "unavailable",
    "Codex projection establishment was cancelled.",
    "codex_projection_cancelled",
    true,
    cause,
  );
}

function conversationClosed(): BackendError {
  return codexError(
    "invalid_state",
    "The Codex conversation is closed.",
    "codex_conversation_closed",
  );
}

function bindingMismatch(): BackendError {
  return codexError(
    "permission_denied",
    "The Codex thread does not match this conversation binding.",
    "codex_thread_binding_mismatch",
  );
}

function isUnmaterializedThreadError(
  error: unknown,
): error is CodexRpcRemoteError {
  return (
    error instanceof CodexRpcRemoteError &&
    /(?:not materialized yet|no rollout found)/iu.test(error.message)
  );
}

export function codexObservedExecutionSettings(
  model: string,
  reasoningEffort: string | null,
  nativeServiceTier: string | null,
  approvalPolicy: unknown,
  approvalsReviewer: unknown,
  sandboxPolicy: unknown,
): CodexObservedExecutionSettings {
  const sandbox = observedSandboxPolicy(sandboxPolicy);
  const observedApprovalPolicy = isCodexApprovalPolicy(approvalPolicy)
    ? approvalPolicy
    : null;
  const observedApprovalReviewer = isCodexApprovalReviewer(approvalsReviewer)
    ? approvalsReviewer
    : null;
  const serviceTier = decodeCodexServiceTier(nativeServiceTier);
  return {
    model,
    reasoningEffort,
    serviceTier: serviceTier ?? null,
    serviceTierClassification:
      serviceTier === undefined ? "external_custom" : "recognized",
    ...sandbox,
    approvalPolicy: observedApprovalPolicy,
    approvalPolicyClassification:
      observedApprovalPolicy === null ? "external_custom" : "recognized",
    approvalReviewer: observedApprovalReviewer,
    approvalReviewerClassification:
      observedApprovalReviewer === null ? "external_custom" : "recognized",
    policyObservation: "complete",
  };
}

export function codexObservedThreadExecutionSettings(
  model: string,
  reasoningEffort: string | null,
  nativeServiceTier: string | null,
  approvalPolicy: unknown,
  approvalsReviewer: unknown,
  sandboxPolicy: unknown,
): CodexObservedExecutionSettings {
  return {
    ...codexObservedExecutionSettings(
      model,
      reasoningEffort,
      nativeServiceTier,
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy,
    ),
    policyObservation: "complete",
  };
}

function observedSandboxPolicy(
  sandboxPolicy: unknown,
): Pick<
  CodexObservedExecutionSettingsBase,
  | "sandboxMode"
  | "sandboxClassification"
  | "networkAccess"
  | "networkClassification"
> {
  if (!isRecord(sandboxPolicy) || typeof sandboxPolicy.type !== "string") {
    return externalSandboxObservation();
  }
  if (sandboxPolicy.type === "dangerFullAccess") {
    return {
      sandboxMode: "danger-full-access",
      sandboxClassification: "recognized",
      networkAccess: "enabled",
      networkClassification: "recognized",
    };
  }
  if (
    sandboxPolicy.type === "readOnly" &&
    typeof sandboxPolicy.networkAccess === "boolean"
  ) {
    return {
      sandboxMode: "read-only",
      sandboxClassification: "recognized",
      networkAccess: observedNetworkAccess(sandboxPolicy.networkAccess),
      networkClassification: "recognized",
    };
  }
  if (
    sandboxPolicy.type === "workspaceWrite" &&
    typeof sandboxPolicy.networkAccess === "boolean"
  ) {
    const sandboxRecognized =
      Array.isArray(sandboxPolicy.writableRoots) &&
      sandboxPolicy.writableRoots.length === 0 &&
      sandboxPolicy.excludeTmpdirEnvVar === true &&
      sandboxPolicy.excludeSlashTmp === true;
    return {
      sandboxMode: sandboxRecognized ? "workspace-write" : null,
      sandboxClassification: sandboxRecognized
        ? "recognized"
        : "external_custom",
      networkAccess: observedNetworkAccess(sandboxPolicy.networkAccess),
      networkClassification: "recognized",
    };
  }
  if (sandboxPolicy.type === "externalSandbox") {
    // External `restricted` is not equivalent to Sedes's disabled boolean;
    // an explicit native `enabled` value is still independently recognizable.
    const enabled = sandboxPolicy.networkAccess === "enabled";
    return {
      sandboxMode: null,
      sandboxClassification: "external_custom",
      networkAccess: enabled ? "enabled" : null,
      networkClassification: enabled ? "recognized" : "external_custom",
    };
  }
  return externalSandboxObservation();
}

function externalSandboxObservation(): Pick<
  CodexObservedExecutionSettingsBase,
  | "sandboxMode"
  | "sandboxClassification"
  | "networkAccess"
  | "networkClassification"
> {
  return {
    sandboxMode: null,
    sandboxClassification: "external_custom",
    networkAccess: null,
    networkClassification: "external_custom",
  };
}

function observedNetworkAccess(value: boolean): CodexNetworkAccess {
  return value ? "enabled" : "disabled";
}

function importedDesiredSettings(
  observed: CodexObservedExecutionSettings,
  reasoningEffort: string | undefined,
  retainedServiceTier?: CodexServiceTierSelection,
): CodexExecutionSettingsTuple | undefined {
  if (
    reasoningEffort === undefined ||
    observed.policyObservation !== "complete" ||
    observed.sandboxClassification !== "recognized" ||
    observed.sandboxMode === null ||
    observed.networkClassification !== "recognized" ||
    observed.networkAccess === null ||
    observed.approvalPolicyClassification !== "recognized" ||
    observed.approvalPolicy === null ||
    observed.approvalReviewerClassification !== "recognized" ||
    observed.approvalReviewer === null ||
    observed.serviceTierClassification !== "recognized" ||
    observed.serviceTier === null
  ) {
    return undefined;
  }
  return {
    model: observed.model,
    reasoningEffort,
    serviceTier: retainedServiceTier ?? observed.serviceTier,
    sandboxMode: observed.sandboxMode,
    networkAccess: observed.networkAccess,
    approvalPolicy: observed.approvalPolicy,
    approvalReviewer: observed.approvalReviewer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSettingsObservation(
  left: CodexSettingsObservationReceipt,
  right: CodexSettingsObservationReceipt,
): boolean {
  return (
    left.modelProvider === right.modelProvider &&
    left.settings.model === right.settings.model &&
    left.settings.reasoningEffort === right.settings.reasoningEffort &&
    left.settings.serviceTier === right.settings.serviceTier &&
    left.settings.serviceTierClassification ===
      right.settings.serviceTierClassification &&
    left.settings.sandboxMode === right.settings.sandboxMode &&
    left.settings.sandboxClassification ===
      right.settings.sandboxClassification &&
    left.settings.networkAccess === right.settings.networkAccess &&
    left.settings.networkClassification ===
      right.settings.networkClassification &&
    left.settings.approvalPolicy === right.settings.approvalPolicy &&
    left.settings.approvalPolicyClassification ===
      right.settings.approvalPolicyClassification &&
    left.settings.approvalReviewer === right.settings.approvalReviewer &&
    left.settings.approvalReviewerClassification ===
      right.settings.approvalReviewerClassification &&
    left.settings.policyObservation === right.settings.policyObservation
  );
}

function sameDesiredSettings(
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

function sameProjection(
  left: CodexFastModeProjection | undefined,
  right: CodexFastModeProjection | undefined,
): boolean {
  return (
    left?.revision === right?.revision &&
    left?.availability === right?.availability &&
    left?.unavailableReason === right?.unavailableReason
  );
}

function sameDisabledProjection(
  current: CodexFastModeProjection | undefined,
  recovered: CodexFastModeProjection,
): boolean {
  return (
    current?.revision === recovered.revision &&
    current.unavailableReason === "feature_disabled"
  );
}

function mapCodexReadError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexRpcDeliveryError) {
    return codexError(
      "unavailable",
      "The Codex daemon is unavailable.",
      error.message,
      true,
      error,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    if (error.code === -32001) {
      return codexError(
        "overloaded",
        "The Codex daemon is overloaded.",
        "codex_remote_overloaded",
        true,
        error,
      );
    }
    if (error.code === -32601 || error.code === -32602) {
      return codexError(
        "incompatible_protocol",
        "The Codex daemon rejected a required released operation.",
        `codex_remote_${error.code}`,
        false,
        error,
      );
    }
    return codexError(
      "unavailable",
      "Codex could not read the thread.",
      `codex_remote_${error.code}`,
      false,
      error,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      error.message,
      false,
      error,
    );
  }
  if (
    (error instanceof CodexAppServerBindingError &&
      error.direction === "client_request_result") ||
    (error instanceof Error && error.name === "ZodError")
  ) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      "codex_c1_protocol_invalid",
      false,
      error,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the read safely.",
    "codex_read_internal",
    false,
    error,
  );
}

function assertCodexHistoryMode(thread: CodexThread): "legacy" | "paginated" {
  switch (thread.historyMode) {
    case "legacy":
    case "paginated":
      return thread.historyMode;
    default:
      throw codexError(
        "incompatible_protocol",
        "Codex returned an unknown history mode.",
        "codex_history_mode_invalid",
      );
  }
}

function mutationOutcomeUnknown(operation: string): BackendError {
  return codexError(
    "submission_unknown",
    "Codex may have accepted the mutation; reconcile authoritative thread state before retrying.",
    `codex_${operation}_outcome_unknown`,
    true,
    undefined,
    true,
  );
}

function sameSubmissionSource(
  left: SubmitTurnInput["source"],
  right: SubmitTurnInput["source"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "user" ||
      (right.kind === "automation" &&
        left.automationId === right.automationId &&
        left.automationRunId === right.automationRunId))
  );
}

function codexContextExcerptMutationFingerprint(
  contextExcerpts: readonly ContextExcerpt[],
  operation: "submit" | "steer",
): string {
  try {
    return codexContextExcerptFingerprint(contextExcerpts);
  } catch (error) {
    throw mapCodexMutationError(error, operation);
  }
}

function codexTaskContextMutationFingerprint(
  taskContexts: SubmitTurnInput["taskContexts"],
  operation: "submit" | "steer",
): string {
  try {
    return codexTaskContextFingerprint(taskContexts);
  } catch (error) {
    throw mapCodexMutationError(error, operation);
  }
}

function mapCodexInteractionError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexInteractionBridgeError) {
    return codexError(
      error.outcomeUnknown ? "unavailable" : "rejected",
      error.outcomeUnknown
        ? "The Codex interaction response outcome cannot be determined."
        : "The Codex interaction response is invalid or no longer pending.",
      error.code,
      error.outcomeUnknown,
      error,
      error.outcomeUnknown,
      error.lateMutationReconciliation,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the interaction response safely.",
    "codex_interaction_internal",
    false,
    error,
  );
}

function mapCodexMutationError(
  error: unknown,
  operation: string,
): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof Error && error.message === "codex_skill_unavailable") {
    return codexError(
      "rejected",
      "The selected Codex skill is no longer available in this workspace.",
      "codex_skill_unavailable",
    );
  }
  if (error instanceof CodexAppServerBindingError) {
    const expectedMethod = {
      submit: codexTurnStartMethod.method,
      steer: codexTurnSteerMethod.method,
      interrupt: codexTurnInterruptMethod.method,
      rename: codexThreadSetNameMethod.method,
      compact: codexThreadCompactStartMethod.method,
    }[operation];
    if (
      error.method === expectedMethod &&
      error.direction === "client_request_params"
    ) {
      return codexError(
        "rejected",
        "The Codex mutation input is invalid or too large.",
        "codex_mutation_input_invalid",
        false,
        error,
      );
    }
    if (
      error.method === expectedMethod &&
      error.direction === "client_request_result"
    ) {
      return codexError(
        "submission_unknown",
        "Codex returned an invalid mutation response; its outcome is unknown.",
        "codex_mutation_response_invalid",
        true,
        error,
        true,
      );
    }
    return codexError(
      "internal",
      "Codex could not complete the mutation safely.",
      "codex_mutation_internal",
      false,
      error,
    );
  }
  if (error instanceof CodexRpcDeliveryError) {
    if (error.delivery === "sent_outcome_unknown") {
      return mutationOutcomeUnknown(operation);
    }
    return codexError(
      "unavailable",
      "The Codex daemon was unavailable before the mutation was sent.",
      error.message,
      true,
      error,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    const staleSteerCode = codexStaleSteerRejectionCode(error, operation);
    if (staleSteerCode) {
      return codexSteerTargetUnavailable(
        "The active Codex turn changed before steering.",
        staleSteerCode,
        error,
      );
    }
    return codexError(
      error.code === -32001 ? "overloaded" : "rejected",
      error.code === -32001
        ? "The Codex daemon is overloaded."
        : "Codex rejected the mutation.",
      `codex_remote_${error.code}`,
      error.code === -32001,
      error,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "submission_unknown",
      "Codex returned an invalid mutation response; its outcome is unknown.",
      "codex_mutation_response_invalid",
      true,
      error,
      true,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return codexError(
      "rejected",
      "The Codex mutation input is invalid or too large.",
      "codex_mutation_input_invalid",
      false,
      error,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the mutation safely.",
    "codex_mutation_internal",
    false,
    error,
  );
}

function codexStaleSteerRejectionCode(
  error: CodexRpcRemoteError,
  operation: string,
): string | undefined {
  if (
    operation !== "steer" ||
    error.method !== codexTurnSteerMethod.method ||
    error.code !== -32600
  ) {
    return undefined;
  }
  return error.rejectionReason === "no_active_turn" ? "codex_steer_no_active_turn"
    : error.rejectionReason === "expected_turn_mismatch" ? "codex_steer_expected_turn_mismatch" : undefined;
}

function codexSteerTargetUnavailable(
  safeMessage: string,
  backendCode: string,
  cause?: unknown,
): BackendError {
  return new BackendError(
    {
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage,
      backendCode,
      steerRejectionReason: "target_no_longer_active",
    },
    cause === undefined ? undefined : { cause },
  );
}

function codexError(
  category: BackendError["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  cause?: unknown,
  crossedSubmissionBoundary = false,
  lateMutationReconciliation?: Promise<BackendMutationReconciliation>,
): BackendError {
  return new BackendError(
    {
      category,
      retryable,
      crossedSubmissionBoundary,
      safeMessage,
      backendCode,
    },
    cause === undefined && lateMutationReconciliation === undefined
      ? undefined
      : { cause, lateMutationReconciliation },
  );
}
