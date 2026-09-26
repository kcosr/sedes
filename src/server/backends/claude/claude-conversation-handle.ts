import { ClaudeUsageAccounting } from "./claude-usage-accounting.js";
import type { UsageSink } from "../../usage/contracts.js";
import { turnFailure } from "../turn-failure.js";
import type { ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { claudeMessageIsChildOwned } from "./claude-message-scope.js";
import { ClaudeBackgroundActivity } from "./claude-background-activity.js";
import { claudeCommandLifecycle, claudeResultIsUnrelated, claudeResultUserMessageIds } from "./claude-result-lifecycle.js";
import { createHash, randomBytes } from "node:crypto";
import type {
  EffortLevel,
  PermissionMode,
  SDKMessage,
  SDKResultMessage,
  SDKStartupFailureReason,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendCapabilityDocument,
  BackendConversationEvent,
  BackendConversationSnapshot,
  BackendItem,
  BackendTurn,
  SequencedBackendEvent,
} from "../../../shared/protocol/backend.js";
import {
  hasDeliverableComposerInput,
  usageSnapshotSchema,
  type UsageSnapshot,
} from "../../../shared/protocol/conversation.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  boundDisplayText,
  boundText,
} from "../../conversations/payload-policy.js";
import type {
  BackendActionResult,
  BackendEventListener,
  BackendHistoryPage,
  BackendMutationReconciliation,
  ConversationBinding,
  ConversationHandle,
  EstablishedBackendProjection,
  EstablishProjectionInput,
  HistoryPageInput,
  InteractionResponseInput,
  InterruptTurnInput,
  RegisteredBackendActionInput,
  SteerTurnInput,
  SteerTurnResult,
  SubmitTurnInput,
  SubmitTurnResult,
  Unsubscribe,
} from "../contracts.js";
import { BackendError } from "../contracts.js";
import { claudeContextExcerptEnvelope } from "./claude-context-excerpts.js";
import {
  assertClaudeHistorySession,
  assertClaudeMessageItemPayload,
  ClaudeHistoryProjectionError,
  projectClaudeHistoryPageAtIndex,
  locateClaudeHistoryTurn,
  projectClaudeLatestSnapshot,
  type ClaudeHistoryAuthentication,
  type ClaudeHistoryProjection,
} from "./claude-history-projector.js";
import { ClaudeInteractionBridge } from "./claude-interaction-bridge.js";
import type {
  ClaudeRuntimeClient,
  ClaudeRuntimeSession,
} from "./claude-runtime-client.js";
import type { ClaudeRuntimeVersionAssessment } from "./claude-release-guard.js";
import type { ClaudeForkBoundaryAuthentication } from "./claude-fork-context-boundary.js";
import { claudeAttachmentEnvelope } from "./claude-attachment-manifest.js";
import { claudeSubmissionContent } from "./claude-native-images.js";
import type {
  ClaudeTerminalStatus,
  ClaudeThreadRepository,
} from "./claude-thread-repository.js";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolPresentationMode } from "../../../shared/protocol/conversation.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  claudeAgentToolCliEnvironment,
  claudeAgentToolMcpServer,
} from "./claude-agent-tool-cli-environment.js";
import {
  isClaudePermissionMode,
  isClaudePermissionModeAllowed,
  type ClaudePermissionMode,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";
import { findClaudeSafeSkill } from "./claude-skills.js";
import { ClaudeOperationalNoticeProjector } from "./claude-operational-notices.js";

const MAXIMUM_EVENT_JOURNAL = 256;
const MAXIMUM_ACKNOWLEDGEMENT_WAIT_MS = 30_000;
const MAXIMUM_SUBMISSION_HISTORY_READ_MS = 5_000;
const MAXIMUM_REPLAY_RECORDS = 1_024;
const CLAUDE_HANDLE_HISTORY_CURSOR_PREFIX = "claude-handle-history:v1:";
const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

type SequencedSubscriber = {
  readonly after: number;
  readonly listener: BackendEventListener;
};

type PendingSubmission = {
  readonly steering: boolean;
  readonly reconciliationToken: string;
  readonly fingerprint: string;
  readonly nativeText: string;
  readonly result: SubmitTurnResult;
  readonly promise: Promise<void>;
  readonly accept: () => void;
  readonly reject: (error: unknown) => void;
  accepted: boolean;
  admissionError?: BackendError;
  observationEnded?: boolean;
};

export interface ClaudePermissionModeEvidence {
  readonly generation: number;
  readonly mode: PermissionMode;
  readonly source: "init" | "setter" | "status";
}

export interface ClaudeModelEvidence {
  readonly generation: number;
  readonly model: string;
  readonly source: "init" | "setter";
}

export interface ClaudeEffortEvidence {
  readonly generation: number;
  readonly effort: EffortLevel | null;
  readonly source: "setter";
}

export interface ClaudeConversationHandleInput {
  readonly usage: UsageSink;
  readonly nativeNamespace: string;
  readonly binding: ConversationBinding;
  readonly canonicalWorkspacePath: string;
  readonly workspaceId: string;
  readonly opaqueBindingDetail: string;
  readonly runtimeClient: ClaudeRuntimeClient;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  readonly settings: ClaudeThreadRepository;
  readonly permissionPolicy: ClaudePermissionPolicy;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly attachmentProvenanceKey: Uint8Array;
  readonly agentToolCli?: AgentToolCliAvailability;
  readonly agentToolCliMode?: AgentToolPresentationMode;
  /** Native presentation: `sourceCapability` is then bound to MCP. */
  readonly agentToolMcpMode?: AgentToolPresentationMode;
  readonly sourceCapability?: string;
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  readonly childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly onVersionAssessment?: (
    assessment: ClaudeRuntimeVersionAssessment,
  ) => void;
  readonly onVersionAssessmentFailed?: () => void;
  readonly forkBoundaryAuthentication: ClaudeForkBoundaryAuthentication;
  readonly loadInitialMessages: () => Promise<readonly SessionMessage[]>;
  readonly launch?: "new" | "resume";
  readonly resumeSession?: boolean;
  readonly title?: string;
  readonly queryGeneration: number;
  /** Omit only for a fenced no-input import or policy-recovery attach. */
  readonly permissionMode?: ClaudePermissionMode;
  /** Enables, but does not select, bypassPermissions for this query. */
  readonly allowDangerouslySkipPermissions?: true;
  readonly onPermissionModeEvidence?: (
    evidence: ClaudePermissionModeEvidence,
  ) => void;
  readonly onModelEvidence?: (evidence: ClaudeModelEvidence) => void;
  readonly onEffortEvidence?: (evidence: ClaudeEffortEvidence) => void;
  readonly onEffectiveAxisUnknown?: (
    generation: number,
    axis: "model" | "effort" | "permission",
  ) => void;
  readonly onQueryGenerationLost?: (generation: number) => void;
  readonly releaseSession: () => void;
  /** Exact managed endpoint lifecycle hold, when the query runs remotely. */
  readonly releaseAgentToolCli?: () => void;
  readonly agentToolCliClosed?: Promise<unknown>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** One attached Sedes conversation over one warm official Agent SDK query. */
export class ClaudeConversationHandle implements ConversationHandle {
  readonly #usageAccounting: ClaudeUsageAccounting | undefined;
  readonly #usageTurnByMessageUuid = new Map<string, string>();
  readonly #usageTurnByInputUuid = new Map<string, string>();
  #inheritedUsage: ClaudeHistoryProjection["inheritedUsage"];
  readonly binding: ConversationBinding;
  readonly #canonicalWorkspacePath: string;
  readonly #workspaceId: string;
  readonly #opaqueBindingDetail: string;
  readonly #runtimeClient: ClaudeRuntimeClient;
  readonly #settings: ClaudeThreadRepository;
  readonly #permissionPolicy: ClaudePermissionPolicy;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #attachmentProvenanceKey: Uint8Array;
  readonly #childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #forkBoundaryAuthentication: ClaudeForkBoundaryAuthentication;
  readonly #scope: RequestScope;
  readonly #session: ClaudeRuntimeSession;
  readonly #interactions: ClaudeInteractionBridge;
  readonly #operationalNotices: ClaudeOperationalNoticeProjector;
  readonly #backgroundActivity = new ClaudeBackgroundActivity();
  readonly #releaseSession: () => void;
  readonly #releaseAgentToolCli: () => void;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  #terminalResultRevision = 0;
  readonly #onPermissionModeEvidence: (
    evidence: ClaudePermissionModeEvidence,
  ) => void;
  readonly #onModelEvidence: (evidence: ClaudeModelEvidence) => void;
  readonly #onEffortEvidence: (evidence: ClaudeEffortEvidence) => void;
  readonly #onEffectiveAxisUnknown: (
    generation: number,
    axis: "model" | "effort" | "permission",
  ) => void;
  readonly #onQueryGenerationLost: (generation: number) => void;
  readonly #listeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #sequencedSubscribers = new Set<SequencedSubscriber>();
  readonly #journal: SequencedBackendEvent[] = [];
  readonly #messages: SessionMessage[];
  readonly #projectionMessages: SessionMessage[];
  readonly #submissions = new Map<string, PendingSubmission>();
  readonly #interrupts = new Map<string, string>();
  readonly #renames = new Map<string, string>();
  readonly #partialItems = new Map<
    string,
    {
      readonly backendTurnId: string;
      readonly messageId: string;
      readonly blockIndex: number;
      readonly semanticKind: "assistant_message" | "reasoning";
      readonly sourceOrder: number;
      text: string;
    }
  >();
  #partialMessageId: string | undefined;
  #partialMessageSourceOrderBase: number | undefined;
  readonly #startupSupersededMessageUuids = new Set<string>();
  /** Claude Code's reported session state, including work it started itself. */
  #providerState: "idle" | "running" | "requires_action" = "idle";
  /**
   * A live turn Claude started itself; it carries no Sedes input identity.
   * `ownsTurn` is false while its output extends the settled previous turn.
   */
  #providerTurn:
    | { readonly startIndex?: number; messageId?: string; boundaryUuid?: string; ownsTurn: boolean }
    | undefined;
  /** A non-ambient task finished; its notification can start the next turn. */
  #taskNotificationPending = false;
  /** Live boundary markers for provider-started turns, by first message ID. */
  readonly #providerTurnBoundaries = new Map<string, string>();
  #projection: ClaudeHistoryProjection;
  #projectionTurnOffset = 0;
  #projectionUserMessageOrdinalBase = 0;
  #historyCursorNonce = randomBytes(16).toString("base64url");
  #usage: UsageSnapshot;
  #runState: BackendConversationSnapshot["runState"];
  #effectiveModel: string | undefined;
  #effectiveEffort: EffortLevel | null | undefined;
  #effectivePermissionMode: PermissionMode | undefined;
  readonly #sessionGeneration: number;
  #lastModelEvidence: string | undefined;
  #lastEffortEvidence: EffortLevel | null | undefined;
  readonly #ready: Promise<void>;
  #nextSequence = 0;
  #projectionEpoch = 0;
  #projectionClaimed = false;
  #projectionInvalidated = false;
  #submissionReserved = false;
  #closed = false;
  #sessionReleased = false;
  #initialHistoryLoaded = false;
  #resolveInitialHistory!: () => void;
  readonly #initialHistory = new Promise<void>((resolve) => {
    this.#resolveInitialHistory = resolve;
  });
  #closePromise: Promise<void> | undefined;

  constructor(input: ClaudeConversationHandleInput) {
    this.binding = input.binding;
    this.#usageAccounting = input.usage.enabled ? new ClaudeUsageAccounting({sink: input.usage, binding: input.binding, nativeNamespace: input.nativeNamespace}) : undefined;
    this.#canonicalWorkspacePath = input.canonicalWorkspacePath;
    this.#workspaceId = input.workspaceId;
    this.#opaqueBindingDetail = input.opaqueBindingDetail;
    this.#runtimeClient = input.runtimeClient;
    this.#settings = input.settings;
    this.#permissionPolicy = input.permissionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#attachmentProvenanceKey = new Uint8Array(
      input.attachmentProvenanceKey,
    );
    if (this.#attachmentProvenanceKey.byteLength !== 32) {
      throw new Error("claude_attachment_provenance_key_invalid");
    }
    this.#childEnvironment = input.childEnvironment;
    this.#forkBoundaryAuthentication = input.forkBoundaryAuthentication;
    this.#scope = {
      tenantId: input.binding.tenantId,
      principalId: input.binding.ownerPrincipalId,
    };
    this.#releaseSession = input.releaseSession;
    this.#releaseAgentToolCli = input.releaseAgentToolCli ?? (() => undefined);
    this.#now = input.now ?? Date.now;
    this.#onError = input.onError ?? (() => undefined);
    this.#onPermissionModeEvidence =
      input.onPermissionModeEvidence ?? (() => undefined);
    this.#onModelEvidence = input.onModelEvidence ?? (() => undefined);
    this.#onEffortEvidence = input.onEffortEvidence ?? (() => undefined);
    this.#onEffectiveAxisUnknown =
      input.onEffectiveAxisUnknown ?? (() => undefined);
    this.#onQueryGenerationLost =
      input.onQueryGenerationLost ?? (() => undefined);
    if (
      !Number.isSafeInteger(input.queryGeneration) ||
      input.queryGeneration < 1
    ) {
      throw new Error("claude_query_generation_invalid");
    }
    this.#sessionGeneration = input.queryGeneration;
    this.#messages = [];
    this.#projectionMessages = [];
    this.#projection = this.#projectLatest(this.#messages);
    this.#usage = this.#projection.usage ?? {};
    this.#runState = this.#projection.snapshot.runState;
    this.#operationalNotices = new ClaudeOperationalNoticeProjector(
      input.binding.backendConversationId,
    );
    this.#interactions = new ClaudeInteractionBridge({
      now: this.#now,
      emit: (event) => this.#emit(event),
    });
    const desired = this.#desiredSettings();
    const desiredModelSelectionAllowed =
      desired.model !== null &&
      modelEffortAllowed(this.#modelPolicy, desired.model, desired.effort);
    const desiredMode = desiredPermissionMode(desired);
    const suppliedMode = input.permissionMode;
    const initialPermissionMode =
      desiredMode &&
      isClaudePermissionModeAllowed(desiredMode, this.#permissionPolicy)
        ? desiredMode
        : suppliedMode &&
            isClaudePermissionModeAllowed(suppliedMode, this.#permissionPolicy)
          ? suppliedMode
          : undefined;
    if (input.agentToolMcpMode && input.agentToolCliMode) {
      throw new Error("claude_agent_tool_presentation_ambiguous");
    }
    const agentToolMcp = input.agentToolMcpMode
      ? claudeAgentToolMcpServer({
          availability: input.agentToolCli,
          applicationThreadId: input.binding.applicationThreadId,
          sourceCapability: input.sourceCapability,
          mode: input.agentToolMcpMode,
        })
      : undefined;
    // Native presentation still strips ambient Sedes variables from the query.
    const environment = claudeAgentToolCliEnvironment({
      availability: input.agentToolMcpMode ? undefined : input.agentToolCli,
      applicationThreadId: input.binding.applicationThreadId,
      sourceCapability: input.sourceCapability,
      mode: input.agentToolCliMode,
      parentEnvironment: input.childEnvironment,
    });
    this.#session = input.runtimeClient.createSession({
      executionEnvironment: input.executionEnvironment,
      executablePath: input.executablePath,
      initializationTimeoutMs: input.initializationTimeoutMs,
      sessionId: input.binding.backendConversationId,
      cwd: input.canonicalWorkspacePath,
      launch: input.launch ?? (input.resumeSession === true ? "resume" : "new"),
      ...(input.title ? { title: input.title } : {}),
      ...(desiredModelSelectionAllowed && desired.model
        ? { model: desired.model }
        : {}),
      ...(desiredModelSelectionAllowed && asEffort(desired.effort)
        ? { effort: asEffort(desired.effort) }
        : {}),
      ...(initialPermissionMode
        ? { permissionMode: initialPermissionMode }
        : {}),
      ...(input.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      canUseTool: this.#interactions.canUseTool,
      onPermissionResponseDelivered: (response) =>
        this.#interactions.permissionResponseDelivered(response),
      onPermissionResponseDeliveryFailed: (response) =>
        this.#interactions.permissionResponseDeliveryFailed(response),
      environment,
      ...(agentToolMcp ? { agentToolMcp } : {}),
      ...(input.onVersionAssessment
        ? { onVersionAssessment: input.onVersionAssessment }
        : {}),
      ...(input.onVersionAssessmentFailed
        ? { onVersionAssessmentFailed: input.onVersionAssessmentFailed }
        : {}),
      onMessage: async (message, evidence) => {
        // Retained remote output must follow native history hydration. Keep
        // delivery pending so the runtime only acknowledges applied output.
        if (this.#session.flushMessages) await this.#initialHistory;
        if (evidence && message.type === "user" && message.uuid) {
          const associated = this.#settings.associateSteerOperation(this.#scope, this.binding.applicationThreadId, message.uuid, evidence.consumedTurnRootUuid);
          if (associated && this.#messages.some(({ uuid }) => uuid === message.uuid)) {
            const previous = this.#projection.snapshot;
            this.#refreshProjection(true);
            this.#emitProjectionDelta(previous, this.#projection.snapshot);
          }
        }
        this.#usageAccounting?.beginDelivery();
        await this.#consume(message);
        return this.#usageAccounting?.deliveryCommitted === false ? false : undefined;
      },
      onFailure: (error) => {
        if (
          error instanceof Error &&
          error.message === "claude_session_identity_mismatch"
        ) {
          this.#invalidateProjection("claude_session_identity_mismatch");
          return;
        }
        this.#fail(error);
      },
    });
    this.#ready = this.#session.start().then(async (initialization) => {
      this.#usageAccounting?.admitQuery(this.#session.startupProbeUuid, this.#session.reattached === true);
      if (this.#session.backgroundActivity) {
        if (this.#session.pendingBackgroundTaskIds === undefined) throw new Error("claude_background_attachment_state_incomplete");
        this.#backgroundActivity.restore(this.#session.backgroundActivity, this.#session.pendingBackgroundTaskIds);
      } else if (!this.#session.reattached && this.#backgroundActivity.snapshot().state === "unknown" && !this.#backgroundActivity.retirementBlocked) this.#backgroundActivity.reset();
      const initialMessages = await input.loadInitialMessages();
      this.#installInitialMessages(initialMessages);
      this.#effectiveModel =
        initialization.actualModel ?? desired.model ?? undefined;
      if (this.#effectiveModel) {
        this.#recordModelEvidence(this.#effectiveModel, "init");
      }
      if (this.#effectivePermissionMode === undefined) {
        this.#recordPermissionModeEvidence(
          initialization.actualPermissionMode,
          "init",
        );
      }
      this.#resolveInitialHistory();
      await this.#session.flushMessages?.();
      if (
        this.#session.reattached &&
        this.#session.confirmedEffort !== undefined
      ) {
        this.#effectiveEffort = this.#session.confirmedEffort;
        this.#recordEffortEvidence(this.#session.confirmedEffort ?? undefined);
      } else if (desiredModelSelectionAllowed && !this.#session.reattached) {
        const effort = asEffort(desired.effort);
        await this.#session.setEffort(effort);
        if (!this.#closed) {
          this.#effectiveEffort = effort ?? null;
          this.#recordEffortEvidence(effort);
        }
      }
    });
    // A persistent runtime owns the stable CLI ingress as well as the query.
    // Its failure callback fences service loss; an old SSH lease closing only
    // makes the ingress temporarily unavailable while that runtime reconnects.
    if (input.agentToolCliClosed) {
      const lostAgentToolCli = (error: unknown) => {
        if (!this.#closed && this.#session.lifetime !== "persistent_service") {
          this.#fail(error);
        }
      };
      void input.agentToolCliClosed.then(
        () =>
          lostAgentToolCli(
            new Error("claude_agent_tool_cli_generation_closed"),
          ),
        lostAgentToolCli,
      );
    }
  }

  static async create(
    input: ClaudeConversationHandleInput,
  ): Promise<ClaudeConversationHandle> {
    const resolvedAgentToolCli = await resolveClaudeAgentToolCli(
      input.agentToolCli,
    );
    const { agentToolCli: _unresolvedAgentToolCli, ...baseInput } = input;
    let handle: ClaudeConversationHandle;
    try {
      handle = new ClaudeConversationHandle({
        ...baseInput,
        ...(resolvedAgentToolCli.availability
          ? { agentToolCli: resolvedAgentToolCli.availability }
          : {}),
        ...(resolvedAgentToolCli.release
          ? { releaseAgentToolCli: resolvedAgentToolCli.release }
          : {}),
        ...(resolvedAgentToolCli.closed
          ? { agentToolCliClosed: resolvedAgentToolCli.closed }
          : {}),
      });
    } catch (error) {
      resolvedAgentToolCli.release?.();
      throw error;
    }
    try {
      await handle.#ready;
      return handle;
    } catch (error) {
      await handle.close();
      throw mapClaudeError(error, "Claude could not attach to the session.");
    }
  }

  get retirementBlocked(): boolean {
    return this.#backgroundActivity.retirementBlocked ||
      (!this.#closed && !this.#projectionInvalidated &&
        (this.#providerState !== "idle" ||
          [...this.#submissions.values()].some(submission => !submission.accepted && !submission.observationEnded)));
  }

  async establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    await this.#ready;
    this.#assertOpen();
    if (input.signal.aborted) throw cancelled(input.signal.reason);
    this.#projectionEpoch += 1;
    this.#projectionClaimed = false;
    const epoch = this.#projectionEpoch;
    const after = this.#nextSequence - 1;
    const projection = this.#projection;
    return {
      handleSequence: after,
      snapshot: this.#snapshot(projection.snapshot),
      history: this.#historyWindow(projection),
      subscribeFromNext: (listener) =>
        this.#subscribeFrom(epoch, after, listener),
    };
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    this.#assertOpen();
    await this.#ready;
    input.signal?.throwIfAborted();
    try {
      const before =
        input.cursor === undefined
          ? undefined
          : parseClaudeHandleHistoryCursor(
              input.cursor,
              this.#historyCursorNonce,
            );
      const selectionInput = {
        before,
        limit: input.limit,
        authentication: this.#historyAuthentication(),
      } as const;
      const preliminary = projectClaudeHistoryPageAtIndex(
        this.#messages,
        selectionInput,
      );
      const terminalReceipts = this.#terminalReceipts(
        preliminary.page.orderedBackendTurnIds,
      );
      const selected =
        terminalReceipts.length === 0
          ? preliminary
          : projectClaudeHistoryPageAtIndex(this.#messages, {
              ...selectionInput,
              terminalReceipts,
            });
      this.#usageAccounting?.registerTurns(Object.values(selected.page.turnsById));
      return {
        ...selected.page,
        ...(selected.previousTurnIndex !== undefined
          ? {
              previousCursor: claudeHandleHistoryCursor(
                this.#historyCursorNonce,
                selected.previousTurnIndex,
              ),
            }
          : {}),
      };
    } catch (error) {
      throw mapClaudeHistoryRequestError(error);
    }
  }

  async locateTurn(
    input: Parameters<ConversationHandle["locateTurn"]>[0],
  ): ReturnType<ConversationHandle["locateTurn"]> {
    this.#assertOpen();
    await this.#ready;
    input.signal?.throwIfAborted();
    try {
      const selectionInput = {
        matchesBackendTurnId: input.matchesBackendTurnId,
        maximumTurnCandidates: input.maximumTurnCandidates,
        authentication: this.#historyAuthentication(),
      } as const;
      const preliminary = locateClaudeHistoryTurn(
        this.#messages,
        selectionInput,
      );
      input.signal?.throwIfAborted();
      if (preliminary.status !== "found") return preliminary;
      const backendTurnId = preliminary.page.orderedBackendTurnIds[0]!;
      const terminalReceipts = this.#terminalReceipts([backendTurnId]);
      if (terminalReceipts.length === 0) return preliminary;
      const selected = locateClaudeHistoryTurn(this.#messages, {
        ...selectionInput,
        matchesBackendTurnId: (candidate) => candidate === backendTurnId,
        terminalReceipts,
      });
      input.signal?.throwIfAborted();
      if (selected.status !== "found") {
        throw new ClaudeHistoryProjectionError("claude_history_invalid");
      }
      return selected;
    } catch (error) {
      throw mapClaudeHistoryRequestError(error);
    }
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    await this.#ready;
    return this.#capabilities();
  }

  #historyAuthentication(): ClaudeHistoryAuthentication {
    const permittedByOperationId = new Map<string, boolean>();
    const skillByNativeUserUuid = new Map<string, string | null>();
    return {
      steerOperations: this.#settings.listSteerOperations(this.#scope, this.binding.applicationThreadId),
      taskLifecycleReceipts: this.#settings.listTaskLifecycleReceipts(this.#scope, this.binding.applicationThreadId, this.binding.backendConversationId),
      attachmentProvenanceKey: this.#attachmentProvenanceKey,
      forkBoundaryAuthentication: this.#forkBoundaryAuthentication,
      isApplicationInputOperation: (applicationOperationId) => {
        const cached = permittedByOperationId.get(applicationOperationId);
        if (cached !== undefined) return cached;
        const permitted = this.#settings.hasOperationSnapshot(this.#scope, {
          applicationThreadId: this.binding.applicationThreadId,
          applicationOperationId,
        });
        permittedByOperationId.set(applicationOperationId, permitted);
        return permitted;
      },
      resolveSkillName: (nativeUserMessageUuid) => {
        if (skillByNativeUserUuid.has(nativeUserMessageUuid)) {
          return skillByNativeUserUuid.get(nativeUserMessageUuid) ?? undefined;
        }
        const skillName = this.#settings.findSkillInvocation(
          this.#scope,
          this.binding.applicationThreadId,
          nativeUserMessageUuid,
        )?.skillName;
        skillByNativeUserUuid.set(nativeUserMessageUuid, skillName ?? null);
        return skillName;
      },
    };
  }

  #capabilities(): BackendCapabilityDocument {
    const desired = this.#desiredSettings();
    const submissionReadiness = this.#submissionReadiness(desired);
    const branchingReadiness = this.#confirmedSettingsReadiness(desired);
    return {
      revision: `claude-c4:${desired.revision}:${this.#effectiveModel ?? ""}:${this.#effectiveEffort ?? ""}:${this.#effectivePermissionMode ?? ""}`,
      actions: ["rename", "set_model", "set_thinking_level"],
      deliveryModes: submissionReadiness.available ? ["submit", ...(branchingReadiness.available ? ["steer" as const] : [])] : [],
      steerTarget: "conversation",
      composerAttachments: { fileStaging: true, nativeImage: true },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: branchingReadiness.available
        ? {
            availability: "available",
            boundaries: ["latest_completed", "selected_completed_turn"],
            method: "provider_native",
            sourceMustBeIdle: true,
            settingsInheritance: "application_applied",
            fidelity: {
              instructions: false,
              messages: true,
              toolCalls: true,
              toolResults: true,
              compaction: true,
              attachments: false,
              settings: true,
              limitations: [
                {
                  text: "Claude reloads environment instructions for the child and does not copy file-history snapshots. Attachment-ended structured-output turns are not forkable.",
                },
              ],
            },
            childIdentity: "application_reserved",
            creationRecovery: "idempotent",
          }
        : {
            availability: "unavailable",
            reason: boundDisplayText(branchingReadiness.reason),
          },
      interactionKinds: ["confirmation", "decision", "questionnaire"],
      // The SDK's dollar estimate is API-equivalent telemetry, not a charge
      // against the externally authenticated subscription plan.
      usageSections: ["counters"],
      usageAccounting: "supported",
      effectiveSettings: {
        ...(this.#effectiveModel
          ? {
              model: {
                provider: this.binding.connectionProfileId,
                id: this.#effectiveModel,
              },
            }
          : {}),
        ...(this.#effectiveEffort
          ? { thinkingLevel: this.#effectiveEffort }
          : {}),
      },
    };
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    return structuredClone(this.#usage);
  }

  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertOpen();
    if (this.#runState !== "idle" && this.#runState !== "failed") {
      throw claudeError(
        "invalid_state",
        "Claude must be settled before a submission retry anchor is captured.",
        "claude_retry_anchor_requires_settled",
      );
    }
    return JSON.stringify({
      version: 1,
      messageCount: this.#messages.length,
      lastMessageUuid: this.#messages.at(-1)?.uuid ?? null,
      transcriptFingerprint: transcriptFingerprint(this.#messages),
    });
  }

  hasPendingSubmissionObservation(operationId: string): boolean {
    const pending = this.#submissions.get(operationId);
    return !this.#closed && !this.#projectionInvalidated && !this.#session.closed &&
      pending !== undefined && !pending.accepted && !pending.observationEnded;
  }

  hasUnconfirmedSubmission(operationId: string): boolean {
    const pending = this.#submissions.get(operationId);
    return pending !== undefined && !pending.accepted;
  }

  /** Stop waiting after the owning runtime ended; consumption remains unknown. */
  endSubmissionObservation(operationId: string): boolean {
    const pending = this.#submissions.get(operationId);
    if (pending?.accepted) return false;
    if (pending) {
      pending.observationEnded = true;
      pending.admissionError = claudeError("submission_unknown", "Claude delivery tracking ended before consumption could be confirmed.", "claude_submission_tracking_ended", false, true);
      pending.reject(pending.admissionError);
    }
    return true;
  }

  /** Called only after the driver obtains exact runtime non-admission proof. */
  forgetProvenUnsentSubmission(operationId: string): boolean {
    const pending = this.#submissions.get(operationId);
    if (pending?.accepted) return false;
    this.#settings.forgetUnconsumedSteerOperation(this.#scope, this.binding.applicationThreadId, operationId);
    if (pending) {
      this.#submissions.delete(operationId);
      pending.reject(claudeError("invalid_state", "Claude did not receive this input.", "claude_submission_not_sent"));
    }
    return true;
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    return this.#sendInput(input, false);
  }

  async #sendInput(input: SubmitTurnInput, steering: boolean): Promise<SubmitTurnResult> {
    this.#assertOpen();
    if (!hasDeliverableComposerInput(input)) {
      throw claudeError(
        "rejected",
        "The Claude submission input is empty.",
        "claude_submission_empty",
      );
    }
    const nativePrompt = this.#resolveNativePrompt(input);
    const readiness = this.#submissionReadiness(this.#desiredSettings());
    if (!readiness.available) {
      throw claudeError(
        readiness.code === "claude_permission_mode_rejected"
          ? "rejected"
          : "unavailable",
        readiness.reason,
        readiness.code,
      );
    }
    const fingerprint = `${steering ? "steer" : "submit"}:${submissionFingerprint(input)}`;
    const prior = this.#submissions.get(input.applicationOperationId);
    if (prior) {
      if (
        prior.reconciliationToken !== input.reconciliationToken ||
        prior.fingerprint !== fingerprint
      ) {
        throw claudeError(
          "rejected",
          "The Claude submission operation was replayed with different input.",
          "claude_submission_replay_mismatch",
        );
      }
      if (prior.admissionError && !prior.accepted) throw prior.admissionError;
      if (!steering) await prior.promise;
      return prior.result;
    }
    if (
      this.#submissionReserved ||
      (!steering && (
        (this.#runState !== "idle" && this.#runState !== "failed") ||
        // Claude merges inputs queued together into one turn; admit the next
        // ordinary input only after the previous one has started its turn.
        this.#hasSubmissionAwaitingStart(false)
      ))
    ) {
      throw claudeError(
        "invalid_state",
        "A Claude turn is already active.",
        "claude_turn_already_active",
      );
    }
    this.#submissionReserved = true;
    try {
      const desired = this.#settings.freezeOperationSnapshot(this.#scope, {
        applicationThreadId: this.binding.applicationThreadId,
        applicationOperationId: input.applicationOperationId,
        now: this.#now(),
      });
      const effort = asEffort(desired.effort);
      const permissionMode = desired.permissionMode;
      this.#assertModelPolicyAllowed(desired.model, desired.effort);
      if (
        !isClaudePermissionModeAllowed(permissionMode, this.#permissionPolicy)
      ) {
        throw claudeError(
          "rejected",
          "The selected Claude permission mode is no longer allowed.",
          "claude_permission_mode_rejected",
        );
      }
      if (!steering) {
        try {
          await this.#session.setModel(desired.model);
          this.#effectiveModel = desired.model;
          if (this.#effectiveModel && !this.#closed) {
            this.#recordModelEvidence(this.#effectiveModel, "setter");
          }
          this.#emit({
            type: "capabilities_changed",
            capabilities: this.#capabilities(),
          });
        } catch (error) {
          this.#markEffectiveAxisUnknown("model");
          throw mapClaudePreSubmissionError(error, "settings");
        }
        try {
          const generation = this.#sessionGeneration;
          await this.#session.setPermissionMode(permissionMode);
          if (generation === this.#sessionGeneration && !this.#closed) {
            this.#recordPermissionModeEvidence(permissionMode, "setter");
          }
        } catch (error) {
          this.#markEffectiveAxisUnknown("permission");
          throw mapClaudePreSubmissionError(error, "settings");
        }
        try {
          await this.#session.setEffort(effort);
          this.#effectiveEffort = effort ?? null;
          if (!this.#closed) this.#recordEffortEvidence(effort);
          this.#emit({
            type: "capabilities_changed",
            capabilities: this.#capabilities(),
          });
        } catch (error) {
          this.#markEffectiveAxisUnknown("effort");
          throw mapClaudePreSubmissionError(error, "settings");
        }
      }
      const liveSettings = this.#desiredSettings();
      const confirmed = this.#confirmedSettingsReadiness({
        ...liveSettings,
        model: desired.model,
        effort: desired.effort,
        permissionMode: desired.permissionMode,
      });
      if (!confirmed.available) {
        throw claudeError(
          confirmed.code === "claude_permission_mode_rejected"
            ? "rejected"
            : "unavailable",
          confirmed.reason,
          confirmed.code,
        );
      }
      const result: SubmitTurnResult = {
        accepted: true,
        reconciliationToken: input.reconciliationToken,
        completionCorrelation: input.applicationOperationId,
      };
      let accept!: () => void;
      let reject!: (error: unknown) => void;
      const acknowledgement = new Promise<void>((resolve, rejectPromise) => {
        accept = resolve;
        reject = rejectPromise;
      });
      // A transport failure can reject this while send itself is still pending.
      void acknowledgement.catch(() => undefined);
      const envelopedPrompt = claudeAttachmentEnvelope({
        key: this.#attachmentProvenanceKey,
        operationId: input.applicationOperationId,
        attachments: input.attachments,
        prompt: claudeContextExcerptEnvelope(
          {
            operationId: input.applicationOperationId,
            contextExcerpts: input.contextExcerpts,
            prompt: nativePrompt.prompt,
          },
          this.#forkBoundaryAuthentication,
        ),
      });
      const providerPrompt = nativePrompt.skillName
        ? `/${nativePrompt.skillName}${envelopedPrompt.length > 0 ? ` ${envelopedPrompt}` : ""}`
        : envelopedPrompt;
      const pending: PendingSubmission = {
        steering,
        reconciliationToken: input.reconciliationToken,
        fingerprint,
        nativeText: providerPrompt,
        result,
        promise: acknowledgement,
        accept,
        reject,
        accepted: false,
      };
      const nativeContent = await claudeSubmissionContent(
        input,
        pending.nativeText,
      );
      if (nativePrompt.skillName) {
        if (
          !this.#session.safeSkills.some(
            ({ commandName }) => commandName === nativePrompt.skillName,
          )
        ) {
          throw claudeError(
            "rejected",
            "The selected Claude skill is no longer available.",
            "claude_skill_unavailable",
          );
        }
        try {
          this.#settings.recordSkillInvocation(
            this.#scope,
            this.binding.applicationThreadId,
            {
              nativeUserMessageUuid: input.applicationOperationId,
              skillName: nativePrompt.skillName,
              now: this.#now(),
            },
          );
        } catch (error) {
          throw mapClaudePreSubmissionError(error, "skill");
        }
      }
      this.#makeSubmissionRoom();
      if (steering) {
        try { this.#settings.recordSteerOperation(this.#scope, this.binding.applicationThreadId, input.applicationOperationId); }
        catch (error) { throw mapClaudePreSubmissionError(error, "steer"); }
      }
      this.#submissions.set(input.applicationOperationId, pending);
      const terminalResultRevision = this.#terminalResultRevision;
      try {
        this.#assertModelPolicyAllowed(desired.model, desired.effort);
        await withTimeout(
          (async () => {
            await this.#session.send({
              operationId: input.applicationOperationId,
              content: nativeContent,
              ...(steering ? { priority: "next" as const } : {}),
            });
            if (!steering) await acknowledgement;
          })(),
          MAXIMUM_ACKNOWLEDGEMENT_WAIT_MS,
          "claude_submission_acknowledgement_timeout",
        );
        return result;
      } catch (error) {
        const failure = mapClaudeMutationError(error, steering ? "steer" : "submit", true);
        if (!steering && failure.crossedSubmissionBoundary) {
          if (failure.backendCode === "claude_submission_acknowledgement_timeout") {
            await this.#recoverPersistedSubmission(input.applicationOperationId);
          }
          if (pending.accepted) return result;
        }
        if (this.#submissions.get(input.applicationOperationId) === pending) {
          if (failure.crossedSubmissionBoundary) pending.admissionError = failure;
          else {
            this.#submissions.delete(input.applicationOperationId);
            if (steering) this.#settings.forgetUnconsumedSteerOperation(this.#scope, this.binding.applicationThreadId, input.applicationOperationId);
          }
        }
        if (error instanceof BackendError &&
            error.backendCode === "claude_persistent_query_busy" &&
            !error.crossedSubmissionBoundary &&
            terminalResultRevision === this.#terminalResultRevision) {
          this.#setRunState("running");
        }
        throw failure;
      }
    } finally {
      this.#submissionReserved = false;
    }
  }

  async #recoverPersistedSubmission(operationId: string): Promise<void> {
    if (this.#closed || this.#projectionInvalidated) return;
    try {
      // First model output can legitimately take longer than the acknowledgment
      // budget. Exact canonical input identity proves an ordinary send without
      // resending it or pretending that a queued Steer has been consumed.
      const messages = await withTimeout(this.#runtimeClient.getSessionMessages(
        this.binding.backendConversationId, { dir: this.#canonicalWorkspacePath }, this.#childEnvironment,
      ), MAXIMUM_SUBMISSION_HISTORY_READ_MS, "claude_submission_history_timeout");
      if (this.#closed || this.#projectionInvalidated) return;
      assertClaudeHistorySession(messages, this.binding.backendConversationId);
      const projection = this.#projectLatest(messages);
      if (![...projection.nativeUserMessageUuidByBackendTurnId.values()].includes(operationId)) return;
      const native = messages.find(message => message.type === "user" && message.uuid === operationId);
      if (native) await this.#consume(native as SDKMessage);
    } catch {
      // Missing, delayed, malformed or unavailable history proves nothing.
      // Preserve uncertainty and the waiter for later exact native evidence.
    }
  }

  #resolveNativePrompt(input: SubmitTurnInput): {
    readonly prompt: string;
    readonly skillName?: string;
  } {
    if (input.selectedSkillId) {
      let skill;
      try {
        skill = findClaudeSafeSkill(
          this.#session.safeSkills,
          input.selectedSkillId,
        );
      } catch {
        throw claudeError(
          "rejected",
          "The selected Claude skill is no longer available.",
          "claude_skill_unavailable",
        );
      }
      return { prompt: input.text, skillName: skill.commandName };
    }
    const trimmed = input.text.trimStart();
    const slash = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/u.exec(trimmed);
    if (!slash) return { prompt: input.text };
    if (
      !this.#session.safeSkills.some(
        ({ commandName }) => commandName === slash[1],
      )
    ) {
      throw unavailable(
        "This Claude slash command is not supported through Sedes.",
        "claude_slash_commands_unavailable",
      );
    }
    const commandName = slash[1]!;
    const userText = trimmed.slice(slash[0].length);
    return { prompt: userText, skillName: commandName };
  }

  async steer(input: SteerTurnInput): Promise<SteerTurnResult> {
    this.#assertOpen();
    if (input.target.kind !== "conversation") {
      throw claudeError("rejected", "Claude steering targets the conversation.", "claude_steer_target_invalid");
    }
    const readiness = this.#confirmedSettingsReadiness(this.#desiredSettings());
    if (!readiness.available) throw unavailable(readiness.reason, readiness.code);
    const result = await this.#sendInput({ ...input, source: { kind: "user" } }, true);
    const turn = Object.values(this.#projection.snapshot.turnsById)
      .find(turn => turn.completionCorrelations?.includes(input.applicationOperationId));
    return {
      reconciliationToken: result.reconciliationToken,
      completionCorrelation: result.completionCorrelation,
      ...(turn ? { status: "accepted" as const, backendTurnId: turn.backendTurnId }
        : { status: "pending_materialization" as const }),
    };
  }

  async interrupt(input: InterruptTurnInput): Promise<void> {
    this.#assertOpen();
    const prior = this.#interrupts.get(input.applicationOperationId);
    if (prior) {
      if (prior !== input.expectedBackendTurnId) {
        throw claudeError(
          "rejected",
          "The Claude interrupt was replayed for another turn.",
          "claude_interrupt_replay_mismatch",
        );
      }
      return;
    }
    if (
      this.#runState !== "running" ||
      this.#activeBackendTurnId() !== input.expectedBackendTurnId
    ) {
      throw claudeError(
        "invalid_state",
        "The active Claude turn changed before interrupt.",
        "claude_interrupt_target_changed",
      );
    }
    await this.#session.interrupt();
    rememberBounded(
      this.#interrupts,
      input.applicationOperationId,
      input.expectedBackendTurnId,
    );
    // The native terminal result can arrive before the control response.
    // Do not resurrect a settled turn (or mark a later turn as stopping).
    if (this.#runState === "running" &&
        this.#activeBackendTurnId() === input.expectedBackendTurnId) {
      this.#setRunState("stopping");
    }
  }

  async reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    const prior = this.#interrupts.get(input.applicationOperationId);
    if (prior) {
      if (prior !== input.expectedBackendTurnId) {
        throw claudeError(
          "rejected",
          "The Claude interrupt was replayed for another turn.",
          "claude_interrupt_replay_mismatch",
        );
      }
      return { outcome: "accepted" };
    }
    return this.#projection.snapshot.activeBackendTurnId ===
      input.expectedBackendTurnId
      ? { outcome: "unknown" }
      : { outcome: "accepted" };
  }

  async perform(
    input: RegisteredBackendActionInput,
  ): Promise<BackendActionResult> {
    this.#assertOpen();
    if (input.action === "rename") {
      const previous = this.#renames.get(input.applicationOperationId);
      if (previous !== undefined) {
        if (previous !== input.title) {
          throw claudeError(
            "rejected",
            "The Claude rename was replayed with another title.",
            "claude_rename_replay_mismatch",
          );
        }
        return { accepted: true };
      }
      await this.#runtimeClient.renameSession(
        this.binding.backendConversationId,
        input.title,
        {
          dir: this.#canonicalWorkspacePath,
        },
        this.#childEnvironment,
      );
      rememberBounded(this.#renames, input.applicationOperationId, input.title);
      return { accepted: true };
    }
    throw unavailable(
      input.action === "compact"
        ? "Claude compaction is not supported."
        : input.action === "set_tool_access"
          ? "Claude tool-access mutation is not supported."
          : "Claude settings are persisted locally and applied at the next turn boundary.",
      `claude_${input.action}_handle_unavailable`,
    );
  }

  async reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    if (input.action !== "rename") return { outcome: "unknown" };
    const previous = this.#renames.get(input.applicationOperationId);
    if (previous !== undefined) {
      if (previous !== input.title) {
        throw claudeError(
          "rejected",
          "The Claude rename was replayed with another title.",
          "claude_rename_replay_mismatch",
        );
      }
      return { outcome: "accepted" };
    }
    const info = await this.#runtimeClient.getSessionInfo(
      this.binding.backendConversationId,
      {
        dir: this.#canonicalWorkspacePath,
      },
      this.#childEnvironment,
    );
    if (info && info.sessionId !== this.binding.backendConversationId) {
      throw this.#invalidateProjection("claude_session_identity_mismatch");
    }
    return info?.customTitle === input.title
      ? { outcome: "accepted" }
      : { outcome: "not_applied" };
  }

  async respond(input: InteractionResponseInput): Promise<void> {
    this.#assertOpen();
    await this.#interactions.respond(input);
  }

  async reconcileInteractionResponse(
    input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    return this.#interactions.reconcile(input);
  }

  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(options?: { readonly reason: "evicted" }): Promise<void> {
    if (this.#closed) return this.#closePromise;
    this.#closed = true;
    this.#usageAccounting?.close();
    // Detaching first fences remote permission callbacks before the local
    // interaction bridge settles its waiters during main-server shutdown.
    // Projection invalidation may already have detached the runtime; local
    // handle teardown still belongs to close() and must run exactly once.
    this.#closePromise ??= this.#session.close(options).finally(() => {
      this.#releaseAdmission();
    });
    this.#interactions.close();
    this.#resolveInitialHistory();
    for (const submission of this.#submissions.values()) {
      submission.reject(new Error("claude_conversation_handle_closed"));
    }
    this.#submissions.clear();
    this.#listeners.clear();
    this.#sequencedSubscribers.clear();
    return this.#closePromise;
  }

  async #consume(message: SDKMessage): Promise<void> {
    if (this.#closed || this.#projectionInvalidated) return;
    if (claudeMessageIsChildOwned(message)) {
      // These frames are explicitly child-owned. They do not belong in the
      // parent timeline and are not evidence of ambiguous parent correlation.
      return;
    }
    const lifecycle = claudeCommandLifecycle(message);
    if (lifecycle) {
      this.#consumeCommandLifecycle(lifecycle);
      return;
    }
    if (message.type === "system" && message.session_id === this.binding.backendConversationId) {
      if (this.#backgroundActivity.consume(message)) {
        this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
        return;
      }
      if (message.subtype === "task_started" && this.#backgroundActivity.observeTaskStarted(message)) {
        this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
      }
      if (message.subtype === "task_started" && !message.ambient && !message.skip_transcript &&
          (message.spawn_depth === undefined || message.spawn_depth === 1) && message.tool_use_id &&
          message.task_type === "local_agent") {
        this.#settings.writeTaskStarted(this.#scope, this.binding.applicationThreadId, this.binding.backendConversationId, {
          nativeTaskId: message.task_id, nativeToolUseId: message.tool_use_id,
          description: boundDisplayText(message.description).text, now: this.#now(),
        });
      }
      if (message.subtype === "task_updated" &&
          (message.patch.status === "completed" || message.patch.status === "failed" || message.patch.status === "killed")) {
        this.#consumeTaskTerminal({ nativeTaskId: message.task_id,
          status: message.patch.status === "killed" ? "stopped" : message.patch.status });
        if (this.#backgroundActivity.settleTask(message.task_id)) {
          this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
        }
        return;
      }
      if (message.subtype === "task_notification") {
        if (!message.ambient && !message.skip_transcript) {
          this.#consumeTaskTerminal({ nativeTaskId: message.task_id, nativeToolUseId: message.tool_use_id, status: message.status });
          this.#taskNotificationPending = true;
        }
        if (this.#backgroundActivity.settleTask(message.task_id)) {
          // Reevaluate idle retirement only after the durable receipt above.
          // Inventory remains exactly the provider's latest replacement level.
          this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
        }
        return;
      }
    }
    const operationalNotice = this.#operationalNotices.project(
      message,
      this.#now,
    );
    if (operationalNotice) {
      this.#emit({ type: "notice", notice: operationalNotice });
    }
    if (message.type === "conversation_reset") {
      this.#usageAccounting?.reset();
      this.#invalidateProjection("claude_conversation_reset_unsupported");
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "local_command_output"
    ) {
      this.#invalidateProjection("claude_local_command_output_unsupported");
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "model_refusal_fallback"
    ) {
      this.#consumeModelFallback(message);
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.permissionMode
    ) {
      this.#recordPermissionModeEvidence(message.permissionMode, "status");
    }
    // Only an exact native input UUID proves which turn consumed a Sedes
    // input. Unstamped output belongs to whatever turn Claude is running.
    if (message.type === "stream_event" || message.type === "assistant" || message.type === "result") {
      const consumed = claudeResultUserMessageIds(message);
      for (const operationId of consumed) {
        // Persist native evidence even if transport admission timed out and the
        // in-memory waiter has gone away; reconciliation can then use history.
        const associated = this.#settings.associateSteerOperation(this.#scope, this.binding.applicationThreadId, operationId, consumed[0]!);
        if (associated && this.#messages.some(({ uuid }) => uuid === operationId)) {
          const previous = this.#projection.snapshot;
          this.#refreshProjection(true);
          this.#emitProjectionDelta(previous, this.#projection.snapshot);
        }
        this.#materializePendingUser(operationId, consumed[0]);
      }
      const outputMessageId = modelOutputMessageId(message);
      if (consumed.length === 0 && outputMessageId !== undefined) this.#observeProviderOutput(outputMessageId);
    }
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      this.#consumeProviderState(message.state);
      return;
    }
    if (message.type === "result") {
      this.#consumeResult(message);
      return;
    }
    if (message.type === "stream_event") {
      this.#consumePartial(message);
      return;
    }
    if (message.type !== "user" && message.type !== "assistant") return;
    const sessionMessage = liveSessionMessage(message);
    if (!sessionMessage) {
      this.#emit({
        type: "resnapshot_required",
        reason: "ambiguous_correlation",
      });
      return;
    }
    if (message.type === "assistant" && message.supersedes) {
      this.#rewriteProjection(message.supersedes);
    }
    if (message.type === "assistant") {
      const messageId = message.message.id;
      for (const [key, partial] of this.#partialItems) {
        if (partial.messageId === messageId) this.#partialItems.delete(key);
      }
    }
    if (message.type === "user" && message.uuid &&
        this.#settings.listSteerOperations(this.#scope, this.binding.applicationThreadId).get(message.uuid) === null) {
      // A replay/echo of queued input does not establish which turn consumes it.
      // Wait for exact consumption stamps or the owner's retained evidence.
      return;
    }
    if (!this.#messages.some(({ uuid }) => uuid === sessionMessage.uuid)) {
      const previous = this.#projection;
      this.#messages.push(sessionMessage);
      this.#projectionMessages.push(sessionMessage);
      this.#refreshProjection();
      this.#usage = mergeUsage(this.#projection.usage ?? {}, this.#usage);
      this.#emitProjectionDelta(previous.snapshot, this.#projection.snapshot);
      if (message.type === "user" && [...this.#projection.nativeUserMessageUuidByBackendTurnId.values()].includes(message.uuid!)) {
        this.#beginSedesTurn();
      }
      this.#emit({ type: "usage_changed", usage: this.#usage });
    }
    // Retained replay can repeat an already-projected message whose accounting
    // transaction failed. Retry just this message before acknowledging delivery.
    const usageTurnId = this.#usageTurnByMessageUuid.get(sessionMessage.uuid);
    if (usageTurnId && !this.#inheritedUsage?.turns.some(turn => turn.backendTurnId === usageTurnId)) {
      this.#usageAccounting?.message(sessionMessage, usageTurnId, "live");
    }
    if (message.type === "user" && message.uuid) {
      const submission = this.#submissions.get(message.uuid);
      if (submission) {
        submission.accepted = true;
        submission.accept();
      }
    }
  }

  #consumeTaskTerminal(input: {
    nativeTaskId: string; nativeToolUseId?: string; status: "completed" | "failed" | "stopped";
  }): void {
    const changed = this.#settings.writeTaskTerminal(this.#scope, this.binding.applicationThreadId, this.binding.backendConversationId,
      { ...input, now: this.#now() });
    if (!changed) return;
    const previous = this.#projection.snapshot;
    this.#refreshProjection();
    this.#emitProjectionDelta(previous, this.#projection.snapshot);
    // A child can outlive the latest window. Invalidate loaded history pages
    // so their next fetch projects the new receipt on its exact original turn.
    if (JSON.stringify(previous) === JSON.stringify(this.#projection.snapshot)) this.#emit({ type: "resnapshot_required", reason: "history_changed" });
  }

  #consumeModelFallback(
    message: Extract<
      SDKMessage,
      { readonly type: "system"; readonly subtype: "model_refusal_fallback" }
    >,
  ): void {
    this.#rewriteProjection(message.retracted_message_uuids ?? []);
    if (message.scope !== "local") {
      this.#effectiveModel =
        message.direction === "revert"
          ? message.original_model
          : message.fallback_model;
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
  }

  #rewriteProjection(retractedUuids: readonly string[]): void {
    this.#partialItems.clear();
    this.#partialMessageId = undefined;
    this.#partialMessageSourceOrderBase = undefined;
    const retracted = new Set(retractedUuids);
    if (!this.#initialHistoryLoaded) {
      for (const uuid of retracted) {
        this.#startupSupersededMessageUuids.add(uuid);
      }
    }
    if (retracted.size > 0) {
      for (let index = this.#messages.length - 1; index >= 0; index -= 1) {
        if (retracted.has(this.#messages[index]!.uuid)) {
          this.#messages.splice(index, 1);
        }
      }
    }
    this.#historyCursorNonce = randomBytes(16).toString("base64url");
    this.#refreshProjection(true);
    this.#emit({
      type: "resnapshot_required",
      reason: "contradictory_state",
    });
  }

  #installInitialMessages(messages: readonly SessionMessage[]): void {
    assertClaudeHistorySession(messages, this.binding.backendConversationId);
    const merged = messages
      .filter(
        ({ uuid }) =>
          uuid !== this.#session.startupProbeUuid &&
          !this.#startupSupersededMessageUuids.has(uuid),
      )
      .map(copySessionMessage);
    const seen = new Set(merged.map(({ uuid }) => uuid));
    for (const message of this.#messages) {
      if (
        !seen.has(message.uuid) &&
        !this.#startupSupersededMessageUuids.has(message.uuid)
      ) {
        merged.push(copySessionMessage(message));
        seen.add(message.uuid);
      }
    }
    this.#messages.splice(0, this.#messages.length, ...merged);
    this.#startupSupersededMessageUuids.clear();
    this.#initialHistoryLoaded = true;
    this.#refreshProjection(true);
    this.#usage = this.#projection.usage ?? {};
    this.#captureHistoryUsage();
    this.#runState = this.#projection.snapshot.runState;
    const activeTurn = this.#projection.snapshot.activeBackendTurnId === undefined ? undefined
      : this.#projection.snapshot.turnsById[this.#projection.snapshot.activeBackendTurnId];
    // Attaching during a turn Claude started: its result carries no Sedes input.
    this.#providerTurn = this.#runState === "running" && activeTurn && !activeTurn.completionCorrelations?.length
      ? { ownsTurn: true } : undefined;
  }

  #captureHistoryUsage(): void {
    this.#usageAccounting?.messages(this.#messages.flatMap(message => {
      const backendTurnId = this.#usageTurnByMessageUuid.get(message.uuid);
      return backendTurnId && !this.#inheritedUsage?.turns.some(turn => turn.backendTurnId === backendTurnId)
        ? [{message, backendTurnId}] : [];
    }), "history");
  }

  #invalidateProjection(code: string): BackendError {
    const error = new BackendError({
      category: "incompatible_protocol",
      retryable: false,
      crossedSubmissionBoundary: true,
      safeMessage:
        "Claude changed the native conversation in a way this attachment cannot safely project.",
      backendCode: code,
    });
    if (this.#projectionInvalidated) return error;
    this.#partialItems.clear();
    this.#partialMessageId = undefined;
    this.#partialMessageSourceOrderBase = undefined;
    this.#projectionInvalidated = true;
    this.#usageAccounting?.close();
    this.#invalidateBackgroundActivity();
    this.#emit({
      type: "resnapshot_required",
      reason: "contradictory_state",
    });
    this.#setRunState("disconnected");
    this.#emit({
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    for (const submission of this.#submissions.values()) {
      if (!submission.accepted) submission.reject(error);
    }
    this.#closePromise = this.#session
      .close()
      .catch(this.#onError)
      .finally(() => this.#releaseAdmission());
    this.#interactions.close();
    return error;
  }

  #captureResultUsage(message: SDKResultMessage): void {
    if (!this.#usageAccounting) return;
    this.#inheritedUsage = this.#projection.inheritedUsage ?? this.#inheritedUsage;
    this.#usageAccounting?.registerTurns(this.#projection.usageTurns, this.#inheritedUsage);
    for (const [turnId, uuid] of this.#projection.nativeUserMessageUuidByBackendTurnId) this.#usageTurnByInputUuid.set(uuid, turnId);
    for (const turn of this.#projection.usageTurns) {
      for (const correlation of turn.completionCorrelations ?? []) this.#usageTurnByInputUuid.set(correlation, turn.backendTurnId);
    }
    const turns = new Set(claudeResultUserMessageIds(message).flatMap((uuid) => {
      const id = this.#usageTurnByInputUuid.get(uuid); return id ? [id] : [];
    }));
    if (turns.size === 1) this.#usageAccounting?.result(message, [...turns][0]!);
  }

  #consumeResult(message: SDKResultMessage): void {
    this.#usageAccounting?.admitQuery(this.#session.startupProbeUuid, this.#session.reattached === true);
    // Only an applied or reattach-confirmed effort attributes usage, and only to
    // the confirmed model's row; unknown stays null.
    this.#usageAccounting?.pipeline(message, this.#effectiveEffort ?? null, this.#effectiveModel ?? null);
    this.#captureResultUsage(message);
    const correlatedIds = claudeResultUserMessageIds(message);
    // A turn Claude started itself carries no Sedes input identity. Its result
    // ends that turn without writing a receipt for any application turn.
    if (this.#providerTurn && correlatedIds.length === 0) {
      this.#endProviderTurn();
      return;
    }
    const activeId = this.#activeBackendTurnId();
    // Persistent output is correlated by the owner's exact user-message event.
    // A send awaiting admission must not hide a terminal result for older work.
    const pendingIds = this.#session.lifetime === "persistent_service" ? [] : [...this.#submissions]
      .filter(([, submission]) => !submission.accepted && !submission.steering)
      .map(([id]) => id);
    const expectedIds = [...pendingIds,
      ...(activeId ? this.#projection.snapshot.turnsById[activeId]?.completionCorrelations ?? [] : [])];
    if (claudeResultIsUnrelated(message, expectedIds)) return;
    const operationId = this.#resultSubmissionOperationId(message);
    if (operationId) this.#materializePendingUser(operationId);
    // Without a live turn, an uncorrelated result has no application turn to
    // settle; attributing it to the previous turn would forge its receipt.
    if (correlatedIds.length === 0 && this.#runState !== "running" && this.#runState !== "stopping") return;
    const backendTurnId = this.#activeBackendTurnId();
    this.#captureResultUsage(message);
    const priorReceipt = backendTurnId
      ? this.#settings.findTerminalReceipt(this.#scope, {
          applicationThreadId: this.binding.applicationThreadId,
          backendTurnId,
        })
      : undefined;
    // Main can persist a result just before losing its remote acknowledgement.
    // Replaying that receipt must not add the same cumulative usage twice.
    if (priorReceipt?.providerResultUuid === message.uuid) {
      this.#terminalResultRevision++;
      this.#setRunState(priorReceipt.status === "failed" ? "failed" : "idle");
      return;
    }
    const terminalStatus = terminalReceiptStatus(message);
    if (terminalStatus) {
      this.#terminalResultRevision++;
      const backendTurnId =
        this.#projection.snapshot.activeBackendTurnId ??
        this.#projection.snapshot.orderedBackendTurnIds.at(-1);
      let settledStatus: ClaudeTerminalStatus = terminalStatus;
      if (backendTurnId) {
        const previous = this.#projection;
        const terminalAt = this.#now();
        try {
          settledStatus = this.#settings.writeTerminalReceipt(
            this.#scope,
            this.binding.applicationThreadId,
            {
              backendTurnId,
              status: terminalStatus,
              ...(terminalStatus === "failed" ? {
                failureMessage: turnFailure(terminalFailureMessage(message)).message.text,
              } : {}),
              providerTerminalReason: message.terminal_reason ?? message.subtype,
              providerResultUuid: message.uuid,
              terminalAt,
              now: terminalAt,
            },
          ).status;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "claude_terminal_receipt_status_conflict") throw error;
          // Receipts are write-once. A contradictory later result for the same
          // turn keeps the first outcome and must not end the live query.
          const existing = this.#settings.findTerminalReceipt(this.#scope, {
            applicationThreadId: this.binding.applicationThreadId,
            backendTurnId,
          });
          if (!existing) throw error;
          settledStatus = existing.status;
          this.#onError(error);
        }
        this.#refreshProjection();
        this.#emitProjectionDelta(previous.snapshot, this.#projection.snapshot, backendTurnId);
      }
      this.#setRunState(settledStatus === "failed" ? "failed" : "idle");
    }
  }

  #materializePendingUser(operationId: string, nativeTurnRootUuid?: string): void {
    // The persistent owner emits the exact admitted user UUID before output.
    if (this.#session.lifetime === "persistent_service") return;
    const submission = this.#submissions.get(operationId);
    if (!submission) return;
    if (submission.steering) {
      if (!nativeTurnRootUuid) return;
      this.#settings.associateSteerOperation(this.#scope, this.binding.applicationThreadId, operationId, nativeTurnRootUuid);
    }
    if (!this.#messages.some(({ uuid }) => uuid === operationId)) {
      const previous = this.#projection;
      this.#messages.push({
        type: "user",
        uuid: operationId,
        session_id: this.binding.backendConversationId,
        message: { role: "user", content: submission.nativeText },
        parent_tool_use_id: null,
        parent_agent_id: null,
      });
      this.#projectionMessages.push(this.#messages.at(-1)!);
      this.#refreshProjection();
      this.#emitProjectionDelta(previous.snapshot, this.#projection.snapshot);
      if ([...this.#projection.nativeUserMessageUuidByBackendTurnId.values()].includes(operationId)) {
        this.#beginSedesTurn();
      }
    }
    submission.accepted = true;
    submission.accept();
  }

  #resultSubmissionOperationId(message: SDKResultMessage): string | undefined {
    const correlatedIds = claudeResultUserMessageIds(message);
    return correlatedIds.find(id => this.#submissions.get(id)?.accepted === false) ??
      correlatedIds.find(id => this.#submissions.has(id));
  }

  /** `started` is emitted when Claude dequeues an input into a turn. */
  #consumeCommandLifecycle(lifecycle: NonNullable<ReturnType<typeof claudeCommandLifecycle>>): void {
    if (lifecycle.state !== "started") return;
    const submission = this.#submissions.get(lifecycle.commandUuid);
    // The startup probe and inputs this attachment did not send are ignored.
    // A steer's receiving turn is identified only by its consumption stamp.
    if (!submission || submission.steering || submission.accepted || submission.observationEnded) return;
    this.#materializePendingUser(lifecycle.commandUuid);
  }

  #hasSubmissionAwaitingStart(includeSteering: boolean): boolean {
    return [...this.#submissions.values()].some(submission =>
      (includeSteering || !submission.steering) && !submission.accepted &&
      !submission.admissionError && !submission.observationEnded);
  }

  #beginSedesTurn(): void {
    // A Sedes input can take over a turn Claude started, for example a steer
    // folded into a notification turn. Publish the new active turn either way.
    this.#providerTurn = undefined;
    this.#setRunState("running", true);
  }

  #beginProviderTurn(): void {
    this.#providerTurn = { startIndex: this.#messages.length, ownsTurn: false };
    this.#setRunState("running");
  }

  #endProviderTurn(): void {
    // Publish the settled turn before idle, as a Sedes turn result does.
    const previous = this.#projection.snapshot;
    this.#refreshProjection();
    this.#emitProjectionDelta(previous, this.#projection.snapshot, this.#activeBackendTurnId());
    this.#providerTurn = undefined;
    this.#setRunState("idle");
  }

  /** Model output with no Sedes input stamp while no turn is live. */
  #observeProviderOutput(messageId: string): void {
    if (!this.#initialHistoryLoaded) return;
    if (this.#runState !== "running" && this.#runState !== "stopping") this.#beginProviderTurn();
    if (this.#providerTurn && this.#providerTurn.messageId === undefined) this.#providerTurn.messageId = messageId;
  }

  #consumeProviderState(state: "idle" | "running" | "requires_action"): void {
    const previous = this.#providerState;
    this.#providerState = state;
    if (this.#initialHistoryLoaded) {
      if (state !== "idle") {
        // Claude began work while no Sedes input is awaiting its turn: a task
        // notification or peer hand-back started this turn.
        if (previous === "idle" && this.#runState !== "running" && this.#runState !== "stopping" &&
            !this.#hasSubmissionAwaitingStart(true)) this.#beginProviderTurn();
      } else if (this.#providerTurn) {
        // Claude finished work that produced no result, for example a drain
        // that did not query the model.
        this.#endProviderTurn();
      }
    }
    if ((previous === "idle") !== (state === "idle")) {
      // Retirement eligibility follows Claude's own state; re-evaluate it.
      this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
    }
  }

  #consumePartial(
    message: Extract<SDKMessage, { readonly type: "stream_event" }>,
  ): void {
    const activeBackendTurnId = this.#activeBackendTurnId();
    if (!activeBackendTurnId || message.parent_tool_use_id !== null) return;
    const event = message.event;
    if (event.type === "message_start") {
      this.#partialMessageId = event.message.id;
      const turn = this.#projection.snapshot.turnsById[activeBackendTurnId];
      this.#partialMessageSourceOrderBase = turn
        ? Math.max(-2, ...turn.orderedBackendItemIds.map(id => this.#projection.snapshot.itemsById[id]!.sourceOrder)
          .filter(order => order % 2 === 0)) + 2
        : undefined;
      return;
    }
    if (event.type === "content_block_start") {
      const messageId = this.#partialMessageId;
      const sourceOrderBase = this.#partialMessageSourceOrderBase;
      if (!messageId || sourceOrderBase === undefined) return;
      const semanticKind: "assistant_message" | "reasoning" | undefined =
        event.content_block.type === "text"
          ? "assistant_message"
          : event.content_block.type === "thinking"
            ? "reasoning"
            : undefined;
      if (!semanticKind) return;
      const text =
        event.content_block.type === "text"
          ? event.content_block.text
          : event.content_block.type === "thinking"
            ? event.content_block.thinking
            : "";
      const partial: {
        readonly backendTurnId: string;
        readonly messageId: string;
        readonly blockIndex: number;
        readonly semanticKind: "assistant_message" | "reasoning";
        readonly sourceOrder: number;
        text: string;
      } = {
        backendTurnId: activeBackendTurnId,
        messageId,
        blockIndex: event.index,
        semanticKind,
        sourceOrder: sourceOrderBase + event.index * 2,
        text,
      };
      const item = partialItem(
        this.binding.backendConversationId,
        activeBackendTurnId,
        partial,
      );
      this.#partialItems.set(`${messageId}\0${event.index}`, partial);
      this.#emit({ type: "item_started", item });
      return;
    }
    if (event.type === "content_block_delta") {
      const messageId = this.#partialMessageId;
      if (!messageId) return;
      const partial = this.#partialItems.get(`${messageId}\0${event.index}`);
      if (!partial) return;
      const delta =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : "";
      if (!delta) return;
      const text = partial.text + delta;
      const item = partialItem(
        this.binding.backendConversationId,
        activeBackendTurnId,
        { ...partial, text },
      );
      partial.text = text;
      this.#emit({ type: "item_updated", item });
      return;
    }
    if (event.type === "message_stop") {
      this.#partialMessageId = undefined;
      this.#partialMessageSourceOrderBase = undefined;
    }
  }

  #refreshProjection(rebuildWindow = false): void {
    const messages = rebuildWindow ? this.#messages : this.#projectionMessages;
    const turnOffset = rebuildWindow ? 0 : this.#projectionTurnOffset;
    const userMessageOrdinalBase = rebuildWindow
      ? 0
      : this.#projectionUserMessageOrdinalBase;
    this.#projection = this.#projectLatest(messages, {
      turnOffset,
      userMessageOrdinalBase,
    });
    if (this.#usageAccounting) {
      this.#inheritedUsage = this.#projection.inheritedUsage ?? this.#inheritedUsage;
      this.#usageAccounting.registerTurns(this.#projection.usageTurns, this.#inheritedUsage);
      for (const [uuid, turnId] of this.#projection.backendTurnIdByMessageUuid) this.#usageTurnByMessageUuid.set(uuid, turnId);
      for (const [turnId, uuid] of this.#projection.nativeUserMessageUuidByBackendTurnId) this.#usageTurnByInputUuid.set(uuid, turnId);
      for (const turn of this.#projection.usageTurns) {
        for (const correlation of turn.completionCorrelations ?? []) this.#usageTurnByInputUuid.set(correlation, turn.backendTurnId);
      }
    }
    const retainedStart =
      this.#projection.window.retainedNativeMessageStartIndex;
    const retainedMessages = messages.slice(retainedStart);
    this.#projectionMessages.splice(
      0,
      this.#projectionMessages.length,
      ...retainedMessages,
    );
    this.#projectionTurnOffset = this.#projection.window.retainedStartTurnIndex;
    this.#projectionUserMessageOrdinalBase =
      this.#projection.window.retainedUserMessageOrdinal;
  }

  #projectLatest(
    messages: readonly SessionMessage[],
    coordinates?: {
      readonly turnOffset: number;
      readonly userMessageOrdinalBase: number;
    },
  ): ClaudeHistoryProjection {
    const preliminary = projectClaudeLatestSnapshot(
      messages,
      [],
      this.#historyAuthentication(),
      coordinates,
    );
    const terminalReceipts = this.#terminalReceipts(
      preliminary.snapshot.orderedBackendTurnIds,
    );
    return terminalReceipts.length === 0
      ? preliminary
      : projectClaudeLatestSnapshot(
          messages,
          terminalReceipts,
          this.#historyAuthentication(),
          coordinates,
        );
  }

  #historyWindow(projection: ClaudeHistoryProjection): {
    readonly operational: true;
    readonly previousCursor?: string;
  } {
    return {
      operational: true,
      ...(projection.window.latestStartTurnIndex > 0
        ? {
            previousCursor: claudeHandleHistoryCursor(
              this.#historyCursorNonce,
              projection.window.latestStartTurnIndex,
            ),
          }
        : {}),
    };
  }

  #emitProjectionDelta(
    previous: BackendConversationSnapshot,
    next: BackendConversationSnapshot,
    terminalTurnId?: string,
  ): void {
    // History infers completion between assistant/tool blocks. A live turn
    // remains active until its native result; publishing those intermediate
    // guesses makes the shared actor alternate idle/running and hides controls.
    const liveTurnId = this.#liveTurnId();
    const liveTurn = (turn: BackendTurn): BackendTurn => {
      if (turn.status !== "completed") return turn;
      const { endedBy: _endedBy, completedAt: _completedAt, ...active } = turn;
      return { ...active, status: "in_progress" };
    };
    for (const turnId of next.orderedBackendTurnIds) {
      const prior = previous.turnsById[turnId];
      const priorTurn = prior && turnId === liveTurnId ? liveTurn(prior) : prior;
      const projected = next.turnsById[turnId]!;
      const turn = turnId === liveTurnId && turnId !== terminalTurnId
        ? liveTurn(projected)
        : projected;
      if (!priorTurn) this.#emit({ type: "turn_started", turn });
      for (const itemId of turn.orderedBackendItemIds) {
        const priorItem = previous.itemsById[itemId];
        const item = next.itemsById[itemId]!;
        if (!priorItem) {
          this.#emit({
            type:
              item.status === "streaming" ? "item_started" : "item_completed",
            item,
          });
        } else if (!same(priorItem, item)) {
          this.#emit({
            type:
              priorItem.status === "streaming" && item.status !== "streaming"
                ? "item_completed"
                : "item_updated",
            item,
          });
        }
      }
      if (priorTurn && !same(priorTurn, turn)) {
        this.#emit({
          type:
            priorTurn.status === "in_progress" && turn.status !== "in_progress"
              ? "turn_completed"
              : "turn_updated",
          turn,
        });
      }
    }
  }

  #setRunState(state: BackendConversationSnapshot["runState"], republish = false): void {
    if (this.#runState === state && !republish) return;
    this.#runState = state;
    this.#emit({
      type: "run_state_changed",
      state,
      ...(state === "running" || state === "stopping"
        ? this.#activeBackendTurnId()
          ? {
              activeBackendTurnId: this.#activeBackendTurnId(),
            }
          : {}
        : {}),
    });
  }

  #snapshot(
    snapshot: BackendConversationSnapshot,
  ): BackendConversationSnapshot {
    const result = structuredClone(snapshot);
    const activeBackendTurnId = this.#activeBackendTurnId();
    const activeTurn = activeBackendTurnId
      ? result.turnsById[activeBackendTurnId]
      : undefined;
    if (
      activeTurn &&
      activeBackendTurnId &&
      (this.#runState === "running" || this.#runState === "stopping")
    ) {
      const reopened = activeBackendTurnId === this.#liveTurnId();
      const items = [...this.#partialItems.values()]
        .filter((partial) => partial.backendTurnId === activeBackendTurnId)
        .map((partial) =>
          partialItem(
            this.binding.backendConversationId,
            activeBackendTurnId,
            partial,
          ),
        );
      for (const item of items) result.itemsById[item.backendItemId] = item;
      result.turnsById[activeBackendTurnId] = {
        ...activeTurn,
        ...(reopened ? { status: "in_progress" as const } : {}),
        orderedBackendItemIds: [
          ...new Set([
            ...activeTurn.orderedBackendItemIds,
            ...items.map((item) => item.backendItemId),
          ]),
        ],
      };
    }
    return {
      ...result,
      runState: this.#runState,
      backgroundActivity: this.#backgroundActivity.snapshot(),
      ...((this.#runState === "running" || this.#runState === "stopping") &&
      this.#activeBackendTurnId()
        ? { activeBackendTurnId: this.#activeBackendTurnId() }
        : { activeBackendTurnId: undefined }),
    };
  }

  /** The turn kept in progress until its native result, if any. */
  #liveTurnId(): string | undefined {
    if (this.#runState !== "running" && this.#runState !== "stopping") return undefined;
    // Output from a turn Claude started without a visible boundary extends the
    // settled previous turn, as provider history does; it does not reopen it.
    if (this.#providerTurn && !this.#providerTurn.ownsTurn) return undefined;
    return this.#activeBackendTurnId();
  }

  #activeBackendTurnId(): string | undefined {
    return (
      this.#projection.snapshot.activeBackendTurnId ??
      this.#projection.snapshot.orderedBackendTurnIds.at(-1)
    );
  }

  #makeSubmissionRoom(): void {
    if (this.#submissions.size < MAXIMUM_REPLAY_RECORDS) return;
    for (const [operationId, submission] of this.#submissions) {
      if (!submission.accepted && !submission.observationEnded) continue;
      this.#submissions.delete(operationId);
      return;
    }
    throw claudeError(
      "overloaded",
      "Too many Claude submissions are awaiting acknowledgement.",
      "claude_submission_tracking_full",
      true,
    );
  }

  #desiredSettings() {
    return this.#settings.get(this.#scope, this.binding.applicationThreadId);
  }

  #submissionReadiness(settings: ReturnType<ClaudeThreadRepository["get"]>):
    | { readonly available: true }
    | {
        readonly available: false;
        readonly reason: string;
        readonly code: string;
      } {
    if (!settings.permissionMode) {
      return {
        available: false,
        reason: "Select a Claude permission mode before sending or branching.",
        code: "claude_permission_mode_unresolved",
      };
    }
    if (
      !isClaudePermissionModeAllowed(
        settings.permissionMode,
        this.#permissionPolicy,
      )
    ) {
      return {
        available: false,
        reason: "The selected Claude permission mode is no longer allowed.",
        code: "claude_permission_mode_rejected",
      };
    }
    if (!settings.model) {
      return {
        available: false,
        reason: "Select complete Claude execution settings before sending.",
        code: "claude_execution_settings_unresolved",
      };
    }
    if (
      !modelEffortAllowed(this.#modelPolicy, settings.model, settings.effort)
    ) {
      return {
        available: false,
        reason:
          "This model or reasoning effort is not allowed by the backend policy.",
        code: "model_policy_rejected",
      };
    }
    return { available: true };
  }

  #assertModelPolicyAllowed(model: string, effort: string | null): void {
    if (modelEffortAllowed(this.#modelPolicy, model, effort)) {
      return;
    }
    throw claudeError(
      "rejected",
      "This model or reasoning effort is not allowed by the backend policy.",
      "model_policy_rejected",
    );
  }

  #confirmedSettingsReadiness(
    settings: ReturnType<ClaudeThreadRepository["get"]>,
  ):
    | { readonly available: true }
    | {
        readonly available: false;
        readonly reason: string;
        readonly code: string;
      } {
    const submissionReadiness = this.#submissionReadiness(settings);
    if (!submissionReadiness.available) return submissionReadiness;
    if (
      settings.effectiveModelState !== "confirmed" ||
      settings.effectiveModel !== settings.model ||
      settings.effectiveModelGeneration !== this.#sessionGeneration ||
      settings.effectiveEffortState !== "confirmed" ||
      settings.effectiveEffort !== settings.effort ||
      settings.effectiveEffortGeneration !== this.#sessionGeneration ||
      settings.effectivePermissionState !== "confirmed" ||
      settings.effectivePermissionClassification !== "recognized" ||
      settings.effectivePermissionMode !== settings.permissionMode ||
      settings.effectivePermissionGeneration !== this.#sessionGeneration
    ) {
      return {
        available: false,
        reason:
          "Claude has not confirmed the complete execution settings for this session.",
        code: "claude_effective_settings_unconfirmed",
      };
    }
    return { available: true };
  }

  #recordPermissionModeEvidence(
    mode: PermissionMode,
    source: ClaudePermissionModeEvidence["source"],
  ): void {
    const persisted = this.#desiredSettings();
    const persistedModeMatches = isClaudePermissionMode(mode)
      ? persisted.effectivePermissionClassification === "recognized" &&
        persisted.effectivePermissionMode === mode
      : persisted.effectivePermissionClassification === "external_custom" &&
        persisted.effectivePermissionMode === null;
    if (
      this.#effectivePermissionMode === mode &&
      persisted.effectivePermissionState === "confirmed" &&
      persisted.effectivePermissionGeneration === this.#sessionGeneration &&
      persistedModeMatches
    ) {
      return;
    }
    this.#effectivePermissionMode = mode;
    this.#onPermissionModeEvidence({
      generation: this.#sessionGeneration,
      mode,
      source,
    });
    if (!this.#closed) {
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
  }

  #recordModelEvidence(
    model: string,
    source: ClaudeModelEvidence["source"],
  ): void {
    const persisted = this.#desiredSettings();
    if (
      this.#lastModelEvidence === model &&
      persisted.effectiveModelState === "confirmed" &&
      persisted.effectiveModel === model &&
      persisted.effectiveModelGeneration === this.#sessionGeneration
    ) {
      return;
    }
    this.#lastModelEvidence = model;
    this.#onModelEvidence({
      generation: this.#sessionGeneration,
      model,
      source,
    });
  }

  #recordEffortEvidence(effort: EffortLevel | undefined): void {
    const effectiveEffort = effort ?? null;
    const persisted = this.#desiredSettings();
    if (
      this.#lastEffortEvidence === effectiveEffort &&
      persisted.effectiveEffortState === "confirmed" &&
      persisted.effectiveEffort === effectiveEffort &&
      persisted.effectiveEffortGeneration === this.#sessionGeneration
    ) {
      return;
    }
    this.#lastEffortEvidence = effectiveEffort;
    this.#onEffortEvidence({
      generation: this.#sessionGeneration,
      effort: effectiveEffort,
      source: "setter",
    });
  }

  #markEffectiveAxisUnknown(axis: "model" | "effort" | "permission"): void {
    if (axis === "model") {
      this.#effectiveModel = undefined;
      this.#lastModelEvidence = undefined;
    } else if (axis === "effort") {
      this.#effectiveEffort = undefined;
      this.#lastEffortEvidence = undefined;
    } else {
      this.#effectivePermissionMode = undefined;
    }
    this.#onEffectiveAxisUnknown(this.#sessionGeneration, axis);
    if (!this.#closed) {
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
  }

  #markEffectiveUnknown(): void {
    this.#effectiveModel = undefined;
    this.#effectiveEffort = undefined;
    this.#effectivePermissionMode = undefined;
    this.#lastModelEvidence = undefined;
    this.#lastEffortEvidence = undefined;
    this.#onQueryGenerationLost(this.#sessionGeneration);
    if (!this.#closed) {
      this.#emit({
        type: "capabilities_changed",
        capabilities: this.#capabilities(),
      });
    }
  }

  #terminalReceipts(backendTurnIds: readonly string[]) {
    return backendTurnIds.flatMap((backendTurnId) => {
      const receipt = this.#settings.findTerminalReceipt(this.#scope, {
        applicationThreadId: this.binding.applicationThreadId,
        backendTurnId,
      });
      return receipt ? [receipt] : [];
    });
  }

  #emit(event: BackendConversationEvent): void {
    if (this.#closed) return;
    const sequenced = {
      handleSequence: this.#nextSequence,
      event,
    } satisfies SequencedBackendEvent;
    this.#nextSequence += 1;
    this.#journal.push(sequenced);
    if (this.#journal.length > MAXIMUM_EVENT_JOURNAL) this.#journal.shift();
    for (const subscriber of [...this.#sequencedSubscribers]) {
      if (sequenced.handleSequence > subscriber.after)
        this.#invoke(subscriber.listener, sequenced);
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #subscribeFrom(
    epoch: number,
    after: number,
    listener: BackendEventListener,
  ): Unsubscribe {
    this.#assertOpen();
    if (epoch !== this.#projectionEpoch || this.#projectionClaimed) {
      throw claudeError(
        "invalid_state",
        "The Claude projection subscription is stale or already claimed.",
        "claude_projection_subscription_claimed",
      );
    }
    this.#projectionClaimed = true;
    const earliest = this.#journal[0]?.handleSequence;
    const replayedInteractionIds = new Set<string>();
    if (earliest !== undefined && after < earliest - 1) {
      this.#invoke(listener, {
        handleSequence: this.#nextSequence++,
        event: { type: "resnapshot_required", reason: "buffer_overflow" },
      });
    } else {
      for (const event of this.#journal)
        if (event.handleSequence > after) {
          if (event.event.type === "interaction_opened") {
            replayedInteractionIds.add(
              event.event.interaction.backendInteractionId,
            );
          }
          this.#invoke(listener, event);
        }
    }
    const subscriber = { after, listener };
    this.#sequencedSubscribers.add(subscriber);
    for (const interaction of this.#interactions.pendingInteractions()) {
      if (replayedInteractionIds.has(interaction.backendInteractionId))
        continue;
      this.#invoke(listener, {
        handleSequence: this.#nextSequence++,
        event: { type: "interaction_opened", interaction },
      });
    }
    return () => this.#sequencedSubscribers.delete(subscriber);
  }

  #invoke(listener: BackendEventListener, event: SequencedBackendEvent): void {
    try {
      listener(event);
    } catch (error) {
      this.#onError(error);
    }
  }

  #invalidateBackgroundActivity(): void {
    this.#backgroundActivity.invalidate();
    this.#emit({ type: "background_activity_changed", activity: this.#backgroundActivity.snapshot() });
  }

  #fail(error: unknown): void {
    if (this.#closed || this.#projectionInvalidated) return;
    this.#usageAccounting?.close();
    this.#invalidateBackgroundActivity();
    this.#setRunState("disconnected");
    this.#emit({
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    for (const submission of this.#submissions.values()) {
      submission.reject(error);
    }
    this.#submissions.clear();
    this.#closed = true;
    this.#closePromise = this.#session
      .close()
      .catch(this.#onError)
      .finally(() => this.#releaseAdmission());
    this.#interactions.close();
    this.#resolveInitialHistory();
    this.#onError(error);
    this.#listeners.clear();
    this.#sequencedSubscribers.clear();
  }

  #assertOpen(): void {
    if (this.#closed)
      throw claudeError(
        "invalid_state",
        "The Claude conversation is closed.",
        "claude_handle_closed",
      );
    if (this.#projectionInvalidated)
      throw claudeError(
        "incompatible_protocol",
        "The Claude conversation changed native identity and must be reattached.",
        "claude_projection_invalidated",
      );
  }

  #releaseAdmission(): void {
    if (this.#sessionReleased) return;
    this.#sessionReleased = true;
    try {
      this.#markEffectiveUnknown();
    } finally {
      try {
        this.#releaseAgentToolCli();
      } finally {
        this.#releaseSession();
      }
    }
  }
}

async function resolveClaudeAgentToolCli(
  availability: AgentToolCliAvailability | undefined,
): Promise<{
  readonly availability?: AgentToolCliAvailability;
  readonly closed?: Promise<unknown>;
  readonly release?: () => void;
}> {
  if (!availability || availability.availability !== "managed") {
    return { ...(availability ? { availability } : {}) };
  }
  let resolution;
  try {
    resolution = await availability.provider.acquire();
  } catch {
    return {
      availability: Object.freeze({
        availability: "unavailable" as const,
        reason: "remote_environment" as const,
      }),
    };
  }
  if (resolution.availability !== "available") {
    return {
      availability: Object.freeze({
        availability: "unavailable" as const,
        reason: "remote_environment" as const,
      }),
    };
  }
  return {
    availability: Object.freeze({
      availability: "available" as const,
      endpoint: resolution.endpoint,
      executableDirectory: resolution.executableDirectory,
      inheritedPath: resolution.inheritedPath,
    }),
    closed: resolution.closed,
    release: resolution.release,
  };
}

// The SDK's runtime history projection retains these transcript fields even
// though its current SessionMessage declaration omits it.
type ClaudeObservedSessionMessage = SessionMessage & {
  readonly timestamp?: string;
  readonly origin?: unknown;
};

function liveSessionMessage(
  message: SDKMessage,
): ClaudeObservedSessionMessage | undefined {
  if (message.type !== "user" && message.type !== "assistant") return undefined;
  if (
    !message.uuid ||
    !message.session_id ||
    message.parent_tool_use_id !== null
  )
    return undefined;
  if ("subagent_type" in message && message.subagent_type) return undefined;
  return {
    type: message.type,
    uuid: message.uuid,
    session_id: message.session_id,
    message: structuredClone(message.message),
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...("origin" in message && message.origin !== undefined
      ? { origin: structuredClone(message.origin) } : {}),
    ...(message.timestamp !== undefined
      ? { timestamp: message.timestamp }
      : {}),
  };
}

/** Anthropic message ID of a main-thread model response's first frame. */
function modelOutputMessageId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") return message.parent_tool_use_id === null ? message.message.id : undefined;
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return undefined;
  return message.event.type === "message_start" ? message.event.message.id : undefined;
}

function copySessionMessage(message: SessionMessage): SessionMessage {
  return structuredClone(message);
}

function partialItem(
  sessionId: string,
  backendTurnId: string,
  partial: {
    readonly messageId: string;
    readonly blockIndex: number;
    readonly semanticKind: "assistant_message" | "reasoning";
    readonly sourceOrder: number;
    readonly text: string;
  },
): Extract<
  BackendItem,
  { readonly semanticKind: "assistant_message" | "reasoning" }
> {
  const item = {
    backendItemId: `claude-item:${createHash("sha256")
      .update(
        `${sessionId}\0${partial.messageId}\0${partial.blockIndex}\0${partial.semanticKind}`,
      )
      .digest("base64url")}`,
    backendTurnId,
    semanticKind: partial.semanticKind,
    status: "streaming" as const,
    sourceOrder: partial.sourceOrder,
    markdown: partial.semanticKind === "assistant_message"
      ? { text: partial.text }
      : boundText(partial.text),
  };
  // The complete item has the same byte ceiling as a message text. Checking
  // it also checks its nested text without serializing that growing text twice.
  assertClaudeMessageItemPayload(item);
  return item;
}

function modelEffortAllowed(
  policy: CompiledBackendModelPolicy,
  modelId: string,
  effort: string | null,
): boolean {
  return effort === null
    ? policy.isModelWithoutReasoningEffortAllowed({ modelId })
    : policy.isSelectionAllowed({ modelId, reasoningEffort: effort });
}

function claudeHandleHistoryCursor(nonce: string, before: number): string {
  return `${CLAUDE_HANDLE_HISTORY_CURSOR_PREFIX}${nonce}:${before}`;
}

function parseClaudeHandleHistoryCursor(
  cursor: string,
  expectedNonce: string,
): number {
  if (Buffer.byteLength(cursor, "utf8") > 512) {
    throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
  }
  const match = /^claude-handle-history:v1:([A-Za-z0-9_-]{22}):(\d+)$/u.exec(
    cursor,
  );
  const before = match ? Number(match[2]) : Number.NaN;
  if (
    !match ||
    match[1] !== expectedNonce ||
    !Number.isSafeInteger(before) ||
    before < 1
  ) {
    throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
  }
  return before;
}

function mergeUsage(
  projected: UsageSnapshot,
  prior: UsageSnapshot,
): UsageSnapshot {
  const counterKeys = [
    "userMessages",
    "assistantMessages",
    "toolCalls",
    "toolResults",
    "totalMessages",
    "compactions",
  ] as const;
  return usageSnapshotSchema.parse({
    ...((projected.context ?? prior.context)
      ? { context: projected.context ?? prior.context }
      : {}),
    ...((projected.counters ?? prior.counters)
      ? {
          counters: Object.fromEntries(
            counterKeys.flatMap((key) => {
              const left = projected.counters?.[key];
              const right = prior.counters?.[key];
              return left === undefined && right === undefined
                ? []
                : [[key, Math.max(left ?? 0, right ?? 0)]];
            }),
          ),
        }
      : {}),

  });
}

const startupFailureMessages: Record<SDKStartupFailureReason, string> = {
  org_pin_api_key_conflict: "Claude organization policy conflicts with the configured API key.",
  org_verify_failed: "Claude could not verify the required organization.",
  org_pin_mismatch: "Claude is signed into a different organization than required.",
  managed_settings_invalid: "Claude managed settings are invalid.",
  remote_settings_required_unavailable: "Required Claude remote settings are unavailable.",
  gateway_signin_required: "Claude gateway sign-in is required.",
  gateway_access_denied: "Claude gateway access was denied.",
  proxy_invalid: "Claude proxy configuration is invalid.",
  temp_dir_unusable: "Claude cannot use its temporary directory.",
  cwd_unavailable: "Claude cannot access the working directory.",
  shell_tool_missing: "A shell tool required by Claude is unavailable.",
  session_held_by_background: "The Claude session is held by background work.",
  worktree_resume_refused: "Claude refused to resume the worktree.",
  worktree_unverified: "Claude could not verify the worktree.",
  cli_version_too_old: "The installed Claude CLI version is too old.",
  bypass_root: "Claude cannot bypass permissions while running as root.",
};

function firstDiagnosticLine(details: readonly string[]): string | undefined {
  for (const detail of details) {
    for (const line of detail.split(/\r?\n/)) {
      const text = line.trim();
      if (text && !/^(?:at\s|Traceback\b|File\s+["']|[A-Za-z]*Error:\s*$)/.test(text)) return text;
    }
  }
  return undefined;
}

function terminalFailureMessage(message: SDKResultMessage): string | undefined {
  if (message.subtype === "success") return firstDiagnosticLine([message.result]);
  // Startup result.errors mirrors stderr. Never copy it into durable UI state.
  if (message.startup_failure_reason !== undefined) return startupFailureMessages[message.startup_failure_reason];
  const details = firstDiagnosticLine(message.errors);
  if (details) return details;
  switch (message.subtype) {
    case "error_max_turns": return "Claude reached the configured turn limit.";
    case "error_max_budget_usd": return "Claude reached the configured spending limit.";
    case "error_max_structured_output_retries": return "Claude exceeded the structured output retry limit.";
    case "error_during_execution": return undefined;
  }
}

function terminalReceiptStatus(
  message: SDKResultMessage,
): ClaudeTerminalStatus {
  if (
    message.terminal_reason === "aborted_streaming" ||
    message.terminal_reason === "aborted_tools"
  ) {
    return "interrupted";
  }
  return message.is_error ? "failed" : "completed";
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAXIMUM_REPLAY_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function same(
  left: BackendTurn | BackendItem,
  right: BackendTurn | BackendItem,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function transcriptFingerprint(messages: readonly SessionMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(message.uuid).update("\0");
  return hash.digest("base64url");
}

function submissionFingerprint(input: SubmitTurnInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: input.source,
        text: input.text,
        contextExcerpts: input.contextExcerpts,
        attachments: input.attachments,
        taskContexts: input.taskContexts,
        selectedSkillId: input.selectedSkillId ?? null,
      }),
    )
    .digest("base64url");
}

function asEffort(value: string | null): EffortLevel | undefined {
  if (value === null) return undefined;
  if (!EFFORTS.has(value as EffortLevel)) {
    throw claudeError(
      "rejected",
      "The configured Claude effort is unavailable.",
      "claude_effort_invalid",
    );
  }
  return value as EffortLevel;
}

function desiredPermissionMode(
  value: unknown,
): ClaudePermissionMode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const mode = Reflect.get(value, "permissionMode");
  return mode === "default" ||
    mode === "acceptEdits" ||
    mode === "dontAsk" ||
    mode === "auto" ||
    mode === "bypassPermissions"
    ? mode
    : undefined;
}

function unavailable(message: string, code: string): BackendError {
  return claudeError("unavailable", message, code);
}

function cancelled(reason: unknown): BackendError {
  return new BackendError(
    {
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
      safeMessage: "Claude projection establishment was cancelled.",
      backendCode: "claude_projection_cancelled",
    },
    { cause: reason },
  );
}

function claudeError(
  category: ConstructorParameters<typeof BackendError>[0]["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  crossedSubmissionBoundary = false,
  cause?: unknown,
): BackendError {
  return new BackendError({
    category,
    retryable,
    crossedSubmissionBoundary,
    safeMessage,
    backendCode,
  }, cause === undefined ? undefined : { cause });
}

function mapClaudeError(error: unknown, message: string): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof ClaudeHistoryProjectionError) return mapClaudeHistoryRequestError(error);
  return new BackendError(
    {
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
      safeMessage: message,
      backendCode: error instanceof Error ? error.message : "claude_sdk_error",
    },
    { cause: error },
  );
}

function mapClaudeHistoryRequestError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof ClaudeHistoryProjectionError) {
    if (error.code === "claude_message_payload_too_large") {
      return claudeError(
        "incompatible_protocol",
        "Claude returned conversation content that exceeds the supported message size.",
        error.code,
        false,
        false,
        error,
      );
    }
    if (error.code === "claude_history_cursor_invalid") {
      return claudeError(
        "rejected",
        "The Claude history cursor is invalid.",
        error.code,
      );
    }
    if (error.code === "claude_history_lookup_invalid") {
      return claudeError(
        "rejected",
        "The Claude history lookup bound is invalid.",
        error.code,
      );
    }
    if (error.code === "history_too_large") {
      return claudeError(
        "unavailable",
        "This Claude history page could not be projected within the shared transfer limit.",
        error.code,
        true,
      );
    }
    return claudeError(
      "incompatible_protocol",
      "The retained Claude history is incomplete or invalid.",
      error.code,
    );
  }
  return mapClaudeError(error, "Claude history is temporarily unavailable.");
}

function mapClaudeMutationError(
  error: unknown,
  mutation: string,
  crossedSubmissionBoundary: boolean,
): BackendError {
  if (error instanceof BackendError) return error;
  return new BackendError(
    {
      category: "submission_unknown",
      retryable: false,
      crossedSubmissionBoundary,
      safeMessage: `The Claude ${mutation} outcome could not be confirmed.`,
      backendCode:
        error instanceof Error ? error.message : "claude_mutation_error",
    },
    { cause: error },
  );
}

function mapClaudePreSubmissionError(
  error: unknown,
  operation: string,
): BackendError {
  if (error instanceof BackendError) return error;
  return new BackendError(
    {
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
      safeMessage: `Claude could not apply the ${operation} before submission.`,
      backendCode:
        error instanceof Error ? error.message : "claude_pre_submission_error",
    },
    { cause: error },
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
