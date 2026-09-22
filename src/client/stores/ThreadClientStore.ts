import { UsageQueryCache } from "./UsageQueryCache.js";
import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import type {
  QuestionRequest,
  QuestionRequestsResult,
  QuestionRequestStatus,
  RespondToQuestionRequest,
} from "../../shared/protocol/questions.js";
import { useSyncExternalStore } from "react";
import type {
  ActivityDetailMode,
  SteerTarget,
  ComposerSkillCatalog,
  ComposerAttachmentDescriptor,
  ConversationItem,
  NormalizedDraft,
  NormalizedStash,
  NormalizedThreadSnapshot,
  ForkThreadRequest,
  ForkThreadResult,
  TurnForkCapability,
  ThreadApplicationOperation,
  ThreadEventEnvelope,
  ThreadCheckpoint,
  ThreadHistorySeekResult,
  ThreadLoadError,
  TurnBookmark,
  QueuedInputSummary,
} from "../../shared/index.js";
import {
  hasDeliverableComposerInput,
  normalizedDraftSchema,
} from "../../shared/index.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import {
  getDiagnosticCategoryEnabled,
  getHistoryPageSize,
} from "../app/settings.js";
import {
  beginThreadLoadAttempt,
  recordThreadLoadDiagnostic,
  recordThreadLoadDiagnosticAt,
  type ThreadLoadAttempt,
} from "../app/thread-load-diagnostics.js";
import { recordStreamingDiagnostic } from "../app/diagnostics.js";
import type {
  ConnectionState,
  EventStreamTransport,
  StreamSubscription,
} from "../api/EventStreamTransport.js";
import { messageFrom } from "./ApplicationClientStore.js";
import {
  NormalizedThreadStore,
  type NormalizedThreadApplyResult,
} from "./NormalizedThreadStore.js";

export interface ThreadClientState {
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly loadFailure?: ThreadLoadError;
  readonly terminalLoadError?: string;
  readonly actionError?: string;
  readonly connection: ConnectionState;
  readonly authoritative: boolean;
  readonly actionPending: boolean;
  /** Bridges a pending delivery receipt until its authoritative snapshot lands. */
  readonly pendingDeliveryThreadRevision?: number;
  /**
   * Client presentation state for composer input that has synchronously moved
   * out of the composer but has not fully converged with server authority.
   */
  readonly pendingComposerTransfers: readonly PendingComposerTransfer[];
  /** Queue rows converted to Steer remain visible until exact materialization. */
  readonly pendingQueuedSteers: readonly PendingQueuedSteer[];
  readonly historyLoading: boolean;
  readonly forkAttempts: Readonly<Record<string, TurnForkAttempt>>;
  readonly questionRequests: readonly QuestionRequest[];
  readonly questionRevision: number;
  /** Durable resolution evidence for question facets in the current projection. */
  readonly questionStatuses: Readonly<Record<string, QuestionRequestStatus>>;
  readonly questionInboxOpenRevision: number;
  readonly questionInboxConsumedOpenRevision: number;
  readonly questionInboxClosedQuestionKeys: readonly string[];
  readonly questionStatus: "loading" | "ready" | "error";
  readonly questionError?: string;
  readonly questionDrafts: Readonly<Record<string, readonly string[]>>;
  readonly pendingQuestionIds: readonly string[];
  readonly pendingQuestionReplies: readonly PendingQuestionReply[];
  readonly bookmarks: readonly TurnBookmark[];
  readonly bookmarkRevision: number;
  readonly bookmarkStatus: "loading" | "ready" | "error";
  readonly bookmarkError?: string;
  readonly pendingBookmarkTurnIds: readonly string[];
  readonly snapshot?: NormalizedThreadSnapshot;
  readonly stashes: readonly NormalizedStash[];
}

type TurnBookmarkPreview = Pick<
  TurnBookmark,
  "userPreview" | "assistantPreview" | "responseState"
>;

type TurnBookmarkMutation =
  | {
      readonly turnId: string;
      readonly bookmarked: true;
      readonly preview: TurnBookmarkPreview;
    }
  | { readonly turnId: string; readonly bookmarked: false };

export interface PendingQuestionReply {
  readonly id: string;
  readonly requestId: string;
  readonly answers: readonly {
    questionIndex: number;
    question: string;
    answer: string;
  }[];
  readonly queuedInput?: QueuedInputSummary;
  readonly deliveryOperationId?: string;
}

export type ComposerDeliveryMode = "submit" | "steer" | "queue";
export type ComposerSteerPhase = "sending" | "steering" | "unconfirmed";

export type ThreadProjectionViewportAnchor =
  | { readonly kind: "live"; readonly activityDetail: ActivityDetailMode }
  | {
      readonly kind: "element";
      readonly activityDetail: ActivityDetailMode;
      readonly attribute:
        "data-activity-first-item-id" | "data-item-id" | "data-turn-id";
      readonly id: string;
      readonly viewportOffset: number;
    };

export interface PendingQueuedSteer {
  readonly operationId: string;
  readonly queuedInputId: string;
  readonly preview: string;
  readonly attachmentCount: number;
  readonly taskCount: number;
  readonly startedAt: number;
  readonly presentationSequence: number;
  readonly phase: ComposerSteerPhase;
  readonly requestState: "requesting" | "receipt_received" | "request_failed";
}

export interface PendingComposerTransferPresentation {
  /** Display metadata is presentation-only and never enters normalized history. */
  readonly selectedSkillLabel?: string;
}

export interface PendingComposerTransfer {
  readonly operationId: string;
  /** Immutable browser intent used for mutation replay and diagnostics. */
  readonly mode: ComposerDeliveryMode;
  /** Authoritative server disposition once a receipt or queue row is observed. */
  readonly resolvedDeliveryMode?: ComposerDeliveryMode;
  readonly captured: NormalizedDraft;
  readonly capturedPresentation: PendingComposerTransferPresentation;
  readonly startedAt: number;
  readonly presentationSequence: number;
  readonly baselineThreadRevision: number;
  readonly baselineOrderedTurnIds: readonly string[];
  readonly baselineTailTurnId?: string;
  readonly baselineTailTurnItemIds: readonly string[];
  readonly baselineTailItemId?: string;
  readonly baselineActiveTurnId?: string;
  /** Immutable targeting contract captured when the user chooses Steer. */
  readonly steerTarget?: SteerTarget;
  readonly acceptanceEvidence:
    "none" | "durably_queued" | "pending_materialization" | "accepted";
  readonly presentation: "transcript" | "pending_steer" | "pending_queue";
  readonly requestState:
    "saving" | "requesting" | "receipt_received" | "request_failed";
  readonly authorityState:
    | "client_only"
    | "queue_owned"
    | "materialized"
    | "rolled_back_tombstone"
    | "retired";
  readonly queuedInputId?: string;
  readonly materializedItemId?: string;
  readonly steerPhase?: ComposerSteerPhase;
  /** Composer must merge the captured contribution before acknowledging it. */
  readonly rollbackRequired: boolean;
  /** The composer reports that it restored this exact captured contribution. */
  readonly rollbackApplied: boolean;
  /** Late exact authority requires conservative inverse composer reconciliation. */
  readonly lateMaterializationRequiresComposerReconciliation: boolean;
  /** Retain a nonvisual tombstone after rollback so late evidence is harmless. */
  readonly retainTombstoneAfterRollback: boolean;
}

export type TurnForkAttempt =
  | { readonly phase: "pending" }
  | {
      readonly phase: "request_failed";
      readonly retryable: boolean;
      readonly diagnostic: string;
    }
  | {
      readonly phase: "recovery_required";
      readonly childThreadId: string;
      readonly retryable: boolean;
      readonly diagnostic: string;
    }
  | {
      readonly phase: "aborted";
      readonly childThreadId: string;
      readonly diagnostic: string;
    };

export const LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY =
  "$latest_provider_snapshot";

export class DeliveryRecoveryRequiredError extends Error {
  override readonly name = "DeliveryRecoveryRequiredError";

  constructor(
    readonly retryable: boolean,
    readonly draft: NormalizedDraft,
  ) {
    super(
      retryable
        ? "Delivery requires recovery before it can be retried."
        : "Delivery outcome requires manual recovery.",
    );
  }
}

function isProvenQueueMutationFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "operation_outcome_uncertain" &&
    error.code !== "backend_submission_unknown"
  );
}

/**
 * Flush cadence while a turn streams: deltas arriving every frame are
 * rendered a few times per second instead of on every frame.
 */
const STREAMING_FLUSH_INTERVAL_MS = 150;
const MAXIMUM_LOAD_ALL_HISTORY_PAGES = 200;
const MAXIMUM_AUTOMATIC_LOAD_RETRIES = 3;

const initialState: ThreadClientState = {
  status: "loading",
  connection: "reconnecting",
  authoritative: false,
  actionPending: false,
  pendingComposerTransfers: [],
  pendingQueuedSteers: [],
  historyLoading: false,
  forkAttempts: {},
  questionRequests: [],
  questionRevision: -1,
  questionStatuses: {},
  questionInboxOpenRevision: 0,
  questionInboxConsumedOpenRevision: 0,
  questionInboxClosedQuestionKeys: [],
  questionStatus: "loading",
  questionDrafts: {},
  pendingQuestionIds: [],
  pendingQuestionReplies: [],
  bookmarks: [],
  bookmarkRevision: 0,
  bookmarkStatus: "loading",
  pendingBookmarkTurnIds: [],
  stashes: [],
};

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>["operation"];
type InteractionResponse = Extract<
  ThreadApplicationOperation,
  { readonly kind: "respond" }
>["response"];

export interface SetAgentToolPolicyInput {
  readonly expectedPolicyRevision: number;
  readonly enabled: boolean;
  readonly enabledToolIds: readonly string[];
  readonly presentation: NormalizedThreadSnapshot["agentTools"]["presentation"];
  readonly accessBoundary: NormalizedThreadSnapshot["agentTools"]["accessBoundary"];
}

export class ThreadClientStore {
  readonly threadId: string;
  readonly normalized = new NormalizedThreadStore();
  readonly usage: UsageQueryCache;
  readonly #api: ApiClient;
  readonly #transport: EventStreamTransport;
  #state = initialState;
  readonly #listeners = new Set<() => void>();
  readonly #activityDetailWillChangeListeners = new Set<
    (activityDetail: ActivityDetailMode) => void
  >();
  #projectionViewportAnchor?: ThreadProjectionViewportAnchor;
  #normalizedUnsubscribe?: () => void;
  #subscription?: StreamSubscription;
  #loadAttempt?: ThreadLoadAttempt;
  #streamWasLive = false;
  #started = false;
  #paused = false;
  #disposed = false;
  #resubscribing = false;
  #resubscribeAttempts = 0;
  #automaticLoadRetries = 0;
  #resubscribeTimer?: ReturnType<typeof globalThis.setTimeout>;
  #healthyResetTimer?: ReturnType<typeof globalThis.setTimeout>;
  #subscriptionEpoch = 0;
  #projectionEpoch = 0;
  #activityDetail: ActivityDetailMode;
  // Streaming deltas can arrive faster than the full apply → derive →
  // render pipeline runs, saturating the main thread. Envelopes are
  // buffered and applied in one pass per animation frame, so React
  // re-renders at most once per frame regardless of delta rate.
  #pendingEnvelopes: ThreadEventEnvelope[] = [];
  #envelopeFlushFrame?: number;
  #envelopeFlushTimer?: ReturnType<typeof globalThis.setTimeout>;
  #envelopeFlushScheduledAt?: number;
  #applyingBatch = false;
  #draftFlush?: () => Promise<NormalizedDraft | undefined>;
  #mutationChain: Promise<unknown> = Promise.resolve();
  #bookmarkMutationChain: Promise<unknown> = Promise.resolve();
  readonly #bookmarkPreviewRefreshAttempts = new Map<string, string>();
  #bookmarkLoadGeneration = 0;
  #questionLoadGeneration = 0;
  #questionStatusLoadGeneration = 0;
  #questionStatusProjectionKey = "";
  #questionStatusAcceptedSourceKey = "";
  #questionStatusRevision = -1;
  #publishedBookmarkRevision = 0;
  #historyLoad?: Promise<void>;
  #capabilityThreadRevision?: number;
  #pendingDeliveryBridgeKind?: "revision" | "pending_materialization";
  #nextTransferPresentationSequence = 1;
  readonly #historySeeks = new Map<string, Promise<ThreadHistorySeekResult>>();
  readonly #forkRequests = new Map<string, ForkThreadRequest>();
  readonly #forkInFlight = new Map<string, Promise<ForkThreadResult>>();
  readonly #queuedInputMutationIds = new Map<string, string>();
  readonly #visibleCompletionAcknowledgements = new Map<
    string,
    Promise<void>
  >();
  readonly #visibilityWaitCancellations = new Set<() => void>();

  constructor(
    threadId: string,
    api: ApiClient,
    transport: EventStreamTransport,
    activityDetail: ActivityDetailMode = "full",
  ) {
    this.threadId = threadId;
    this.#api = api;
    this.usage = new UsageQueryCache(threadId, api);
    this.#transport = transport;
    this.#activityDetail = activityDetail;
    this.#normalizedUnsubscribe = this.normalized.subscribe(() => {
      // A batched flush derives once at batch end; per-envelope derives
      // inside the batch are wasted work.
      if (this.#applyingBatch) return;
      this.#deriveNormalizedState();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ThreadClientState => this.#state;

  get awaitingRunStateCapabilities(): boolean {
    return this.normalized.awaitingRunStateCapabilities;
  }

  get snapshotSerializedBytes(): number {
    return this.normalized.snapshotSerializedBytes;
  }

  get activityDetail(): ActivityDetailMode {
    return this.#activityDetail;
  }

  subscribeActivityDetailWillChange = (
    listener: (activityDetail: ActivityDetailMode) => void,
  ): (() => void) => {
    this.#activityDetailWillChangeListeners.add(listener);
    return () => this.#activityDetailWillChangeListeners.delete(listener);
  };

  rememberProjectionViewportAnchor(
    anchor: ThreadProjectionViewportAnchor,
  ): void {
    this.#projectionViewportAnchor = anchor;
  }

  takeProjectionViewportAnchor(
    activityDetail: ActivityDetailMode,
  ): ThreadProjectionViewportAnchor | undefined {
    const anchor = this.#projectionViewportAnchor;
    if (!anchor || anchor.activityDetail !== activityDetail) return undefined;
    this.#projectionViewportAnchor = undefined;
    return anchor;
  }

  setActivityDetail(activityDetail: ActivityDetailMode): void {
    if (this.#disposed || activityDetail === this.#activityDetail) return;
    this.#projectionViewportAnchor = undefined;
    for (const listener of this.#activityDetailWillChangeListeners) {
      listener(activityDetail);
    }
    this.#activityDetail = activityDetail;
    this.#projectionEpoch += 1;
    this.#subscriptionEpoch += 1;
    this.#cancelEnvelopeFlush();
    this.#pendingEnvelopes = [];
    this.#historyLoad = undefined;
    this.#historySeeks.clear();
    this.#capabilityThreadRevision = undefined;
    if (this.#resubscribeTimer !== undefined) {
      globalThis.clearTimeout(this.#resubscribeTimer);
      this.#resubscribeTimer = undefined;
    }
    this.#resubscribing = false;
    this.#resubscribeAttempts = 0;
    this.#automaticLoadRetries = 0;
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#streamWasLive = false;
    this.normalized.resetProjection();
    this.#replaceState({
      ...this.#state,
      status: "loading",
      error: undefined,
      loadFailure: undefined,
      terminalLoadError: undefined,
      actionError: undefined,
      connection:
        this.#started && !this.#paused ? "reconnecting" : "disconnected",
      authoritative: false,
      historyLoading: false,
      snapshot: undefined,
    });
    if (this.#started && !this.#paused) this.#subscribeToEvents();
  }

  start(loadAttempt?: ThreadLoadAttempt): Promise<void> {
    if (loadAttempt) this.#loadAttempt = loadAttempt;
    if (!this.#started) {
      this.#started = true;
      recordThreadLoadDiagnostic(this.#loadAttempt, "store_start_requested");
      this.#subscribeToEvents();
      void this.loadBookmarks();
    } else {
      recordThreadLoadDiagnostic(this.#loadAttempt, "retained_store_reused", {
        status: this.#state.status,
      });
      if (this.#paused) {
        this.#paused = false;
        this.#resubscribeAttempts = 0;
        this.#automaticLoadRetries = 0;
        this.#streamWasLive = false;
        this.normalized.prepareForReconnect();
        this.#replaceState({
          ...this.#state,
          status: this.#state.snapshot ? "ready" : "loading",
          error: undefined,
          loadFailure: undefined,
          terminalLoadError: undefined,
          connection: "reconnecting",
          authoritative: false,
        });
        this.#subscribeToEvents();
      }
    }
    return Promise.resolve();
  }

  retryLoad(): void {
    if (this.#disposed) return;
    if (this.#resubscribeTimer !== undefined) {
      globalThis.clearTimeout(this.#resubscribeTimer);
      this.#resubscribeTimer = undefined;
    }
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    this.#resubscribing = false;
    this.#resubscribeAttempts = 0;
    this.#automaticLoadRetries = 0;
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#streamWasLive = false;
    this.normalized.prepareForReconnect();
    this.#loadAttempt =
      beginThreadLoadAttempt(this.threadId, "reconnect") ?? this.#loadAttempt;
    this.#replaceState({
      ...this.#state,
      status: this.#state.snapshot ? "ready" : "loading",
      error: undefined,
      loadFailure: undefined,
      terminalLoadError: undefined,
      connection:
        this.#started && !this.#paused ? "reconnecting" : "disconnected",
      authoritative: false,
    });
    if (this.#started && !this.#paused) this.#subscribeToEvents();
  }

  pause(reason: "inactive"): void {
    if (this.#disposed || this.#paused) return;
    this.#paused = true;
    this.#subscriptionEpoch += 1;
    this.#cancelEnvelopeFlush();
    this.#pendingEnvelopes = [];
    if (this.#resubscribeTimer !== undefined) {
      globalThis.clearTimeout(this.#resubscribeTimer);
      this.#resubscribeTimer = undefined;
    }
    this.#resubscribing = false;
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#streamWasLive = false;
    this.normalized.prepareForReconnect();
    this.#replaceState({
      ...this.#state,
      connection: "disconnected",
      authoritative: false,
    });
    recordThreadLoadDiagnostic(this.#loadAttempt, "thread_stream_suspended", {
      reason,
      bytes: this.snapshotSerializedBytes,
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.usage.dispose();
    this.#subscriptionEpoch += 1;
    this.#cancelEnvelopeFlush();
    this.#pendingEnvelopes = [];
    if (this.#resubscribeTimer !== undefined) {
      globalThis.clearTimeout(this.#resubscribeTimer);
      this.#resubscribeTimer = undefined;
    }
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#normalizedUnsubscribe?.();
    this.#normalizedUnsubscribe = undefined;
    for (const cancel of this.#visibilityWaitCancellations) cancel();
    this.#visibilityWaitCancellations.clear();
    this.#activityDetailWillChangeListeners.clear();
    this.#projectionViewportAnchor = undefined;
    this.#listeners.clear();
  }

  stageComposerTransfer(
    operationId: string,
    mode: ComposerDeliveryMode,
    draft: NormalizedDraft,
    capturedPresentation: PendingComposerTransferPresentation = {},
  ): void {
    if (
      this.#state.pendingDeliveryThreadRevision !== undefined ||
      this.#state.pendingComposerTransfers.some(
        (transfer) =>
          transfer.requestState === "saving" ||
          transfer.requestState === "requesting",
      )
    ) {
      throw new Error(
        "Wait for the pending delivery to resolve before delivering more input.",
      );
    }
    if (!hasDeliverableComposerInput(draft)) {
      throw new Error("A composer transfer requires deliverable input.");
    }
    if (
      !operationId ||
      this.#state.pendingComposerTransfers.some(
        (transfer) => transfer.operationId === operationId,
      )
    ) {
      throw new Error("A composer transfer requires a unique operation ID.");
    }
    if (this.#state.pendingComposerTransfers.length >= 500) {
      throw new Error(
        "Pending delivery projection is full. Reload before sending more input.",
      );
    }
    const snapshot = this.#requireSnapshot();
    const steerMode = snapshot.capabilities.deliveryModes.find(
      ({ id }) => id === "steer",
    )?.steerTarget;
    if (
      mode === "steer" &&
      (!steerMode || (steerMode === "turn" && !snapshot.activeTurnId))
    ) {
      throw new Error("A Steer transfer requires a supported delivery target.");
    }
    const steerTarget = mode !== "steer"
      ? undefined
      : steerMode === "conversation"
        ? { kind: "conversation" as const }
        : { kind: "turn" as const, turnId: snapshot.activeTurnId! };
    let baselineTailTurnId: string | undefined;
    let baselineTailTurnItemIds: readonly string[] = [];
    let baselineTailItemId: string | undefined;
    for (
      let index = snapshot.orderedTurnIds.length - 1;
      index >= 0;
      index -= 1
    ) {
      const turnId = snapshot.orderedTurnIds[index];
      if (!turnId) continue;
      const itemId = snapshot.turnsById[turnId]?.orderedItemIds.at(-1);
      if (!itemId) continue;
      baselineTailTurnId = turnId;
      baselineTailTurnItemIds = [
        ...(snapshot.turnsById[turnId]?.orderedItemIds ?? []),
      ];
      baselineTailItemId = itemId;
      break;
    }
    const captured: NormalizedDraft = {
      ...draft,
      contextExcerpts: [...draft.contextExcerpts],
      attachments: [...draft.attachments],
      taskReferences: [...draft.taskReferences],
    };
    const transfer: PendingComposerTransfer = {
      operationId,
      mode,
      captured,
      ...(steerTarget ? { steerTarget } : {}),
      capturedPresentation: { ...capturedPresentation },
      startedAt: Date.now(),
      presentationSequence: this.#nextTransferPresentationSequence++,
      baselineThreadRevision: snapshot.thread.threadRevision,
      baselineOrderedTurnIds: [...snapshot.orderedTurnIds],
      ...(baselineTailTurnId ? { baselineTailTurnId } : {}),
      baselineTailTurnItemIds,
      ...(baselineTailItemId ? { baselineTailItemId } : {}),
      ...(snapshot.activeTurnId
        ? { baselineActiveTurnId: snapshot.activeTurnId }
        : {}),
      acceptanceEvidence: "none",
      presentation:
        mode === "submit"
          ? "transcript"
          : mode === "steer"
            ? "pending_steer"
            : "pending_queue",
      requestState: "saving",
      authorityState: "client_only",
      ...(mode === "steer" ? { steerPhase: "sending" as const } : {}),
      rollbackRequired: false,
      rollbackApplied: false,
      lateMaterializationRequiresComposerReconciliation: false,
      retainTombstoneAfterRollback: false,
    };
    this.#setPendingComposerTransfers([
      ...this.#state.pendingComposerTransfers,
      transfer,
    ]);
  }

  abandonComposerTransfer(operationId: string): void {
    this.#setPendingComposerTransfers(
      this.#state.pendingComposerTransfers.filter(
        (transfer) => transfer.operationId !== operationId,
      ),
    );
  }

  acknowledgeComposerTransferRollback(operationId: string): void {
    const transfer = this.#composerTransfer(operationId);
    if (!transfer?.rollbackRequired) return;
    if (transfer.retainTombstoneAfterRollback) {
      this.#updateComposerTransfer(operationId, {
        rollbackRequired: false,
        rollbackApplied: true,
      });
      return;
    }
    this.abandonComposerTransfer(operationId);
  }

  acknowledgeLateComposerTransferReconciliation(operationId: string): void {
    const transfer = this.#composerTransfer(operationId);
    if (!transfer?.lateMaterializationRequiresComposerReconciliation) return;
    this.abandonComposerTransfer(operationId);
  }

  prepareForReconnect(): void {
    if (this.#disposed || this.#paused) return;
    this.normalized.prepareForReconnect();
    this.#replaceState({
      ...this.#state,
      authoritative: false,
      connection: "reconnecting",
    });
  }

  /**
   * Draft text is composer-local state: keystrokes never enter this store,
   * so the transcript and header do not re-render while typing. The composer
   * registers a flush callback for the rare operations that must not strand
   * unsaved text (moving an unbound draft to another workspace); unmount and
   * debounce flushes stay in the composer itself.
   */
  registerDraftFlush(
    flush: () => Promise<NormalizedDraft | undefined>,
  ): () => void {
    this.#draftFlush = flush;
    return () => {
      if (this.#draftFlush === flush) this.#draftFlush = undefined;
    };
  }

  /**
   * Persists composer-owned draft text. Autosave is silent on success — no
   * UI "saving" flag. Failures surface via actionError (and the composer
   * maps 409 to its conflict banner); the error is rethrown for the caller.
   */
  async saveDraft(draft: NormalizedDraft): Promise<NormalizedDraft> {
    try {
      return await this.#api.saveDraft(this.threadId, draft);
    } catch (error) {
      this.#replaceState({
        ...this.#state,
        actionError: messageFrom(error),
      });
      throw error;
    }
  }

  listSkills(): Promise<ComposerSkillCatalog> {
    return this.#api.listSkills(this.threadId);
  }

  uploadComposerAttachment(
    attachmentId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<ComposerAttachmentDescriptor> {
    return this.#api.uploadComposerAttachment(
      this.threadId,
      attachmentId,
      file,
      signal,
    );
  }

  loadComposerAttachmentContent(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.#api.loadComposerAttachmentContent(
      this.threadId,
      attachmentId,
      signal,
    );
  }

  loadOutputArtifactContent(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.#api.loadOutputArtifactContent(
      this.threadId,
      artifactId,
      signal,
    );
  }

  stash(draft: NormalizedDraft): Promise<NormalizedDraft> {
    return this.#mutate(async () => {
      if (
        !draft.text.trim() &&
        !draft.selectedSkillId &&
        draft.contextExcerpts.length === 0 &&
        draft.attachments.length === 0 &&
        draft.taskReferences.length === 0
      )
        return draft;
      const result = await this.#api.createStash(
        this.threadId,
        draft.revision,
        crypto.randomUUID(),
      );
      this.#replaceState({
        ...this.#state,
        stashes: result.stashes,
      });
      return result.draft;
    });
  }

  restoreStash(
    stashId: string,
    draft: NormalizedDraft,
  ): Promise<NormalizedDraft> {
    return this.#mutate(async () => {
      const result = await this.#api.restoreStash(
        this.threadId,
        stashId,
        draft.revision,
        crypto.randomUUID(),
      );
      this.#replaceState({
        ...this.#state,
        stashes: result.stashes,
      });
      return result.draft;
    });
  }

  deleteStash(stashId: string): Promise<void> {
    return this.#mutate(async () => {
      const result = await this.#api.deleteStash(this.threadId, stashId);
      this.#replaceState({ ...this.#state, stashes: result.stashes });
    });
  }

  dismissAttention(
    attention:
      | { kind: "wake"; wokeAt: string }
      | { kind: "automation_context"; runId: string },
  ): Promise<void> {
    return this.#mutate(async () => {
      await this.#api.dismissThreadAttention(
        this.threadId,
        attention,
        crypto.randomUUID(),
      );
    });
  }

  dismissQueueFailure(queuedInputId: string): Promise<void> {
    return this.#queueMutation(async () => {
      const requestKey = `dismiss_failure\0${queuedInputId}`;
      const mutationId = this.#queuedInputMutationId(requestKey);
      try {
        await this.#api.dismissThreadAttention(
          this.threadId,
          { kind: "queue_failure", queuedInputId },
          mutationId,
        );
      } catch (error) {
        if (isProvenQueueMutationFailure(error)) {
          this.#queuedInputMutationIds.delete(requestKey);
        }
        throw error;
      }
      this.#queuedInputMutationIds.delete(requestKey);
    });
  }

  acknowledgeVisibleCompletion(operationId: string): Promise<void> {
    const existing = this.#visibleCompletionAcknowledgements.get(operationId);
    if (existing) return existing;
    const acknowledgement = this.#acknowledgeVisibleCompletion(
      operationId,
    ).catch((error: unknown) => {
      this.#visibleCompletionAcknowledgements.delete(operationId);
      throw error;
    });
    this.#visibleCompletionAcknowledgements.set(operationId, acknowledgement);
    return acknowledgement;
  }

  async #acknowledgeVisibleCompletion(operationId: string): Promise<void> {
    if (!(await this.#waitUntilVisible()) || this.#disposed) return;
    const delays = [250, 1_000] as const;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#api.dismissThreadAttention(
          this.threadId,
          { kind: "unseen_completion", operationId },
          crypto.randomUUID(),
        );
        return;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || this.#disposed) throw error;
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, delay);
        });
      }
    }
  }

  #waitUntilVisible(): Promise<boolean> {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    ) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (visible: boolean) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("visibilitychange", onVisibility);
        this.#visibilityWaitCancellations.delete(cancel);
        resolve(visible);
      };
      const onVisibility = () => {
        if (document.visibilityState === "visible") finish(true);
      };
      const cancel = () => finish(false);
      this.#visibilityWaitCancellations.add(cancel);
      document.addEventListener("visibilitychange", onVisibility);
    });
  }

  clearActionError(): void {
    if (this.#state.actionError) {
      this.#replaceState({ ...this.#state, actionError: undefined });
    }
  }

  deliver(
    mode: ComposerDeliveryMode,
    draft: NormalizedDraft,
    operationId: string,
  ): Promise<NormalizedDraft> {
    const delivery = this.#mutate(async () => {
      const prepared = this.#composerTransfer(operationId);
      if (!prepared) {
        throw new Error("Delivery was not prepared by the composer.");
      }
      if (prepared.mode !== mode) {
        this.#recordComposerTransferFailure(operationId, false);
        throw new Error("Delivery mode does not match its prepared transfer.");
      }
      if (this.#state.pendingDeliveryThreadRevision !== undefined) {
        this.#recordComposerTransferFailure(operationId, false);
        throw new Error(
          "Wait for the pending steer to appear before delivering more input.",
        );
      }
      const snapshot = this.#requireSnapshot();
      const capability = snapshot.capabilities.deliveryModes.find(
        ({ id }) => id === mode,
      );
      if (!capability || (!capability.available && mode !== "steer")) {
        this.#recordComposerTransferFailure(operationId, false);
        throw new Error(
          capability?.unavailableReason?.text ??
            `${mode} is unavailable for this thread.`,
        );
      }
      if (snapshot.recovery) {
        this.#recordComposerTransferFailure(operationId, false);
        throw new Error(
          "Resolve the uncertain operation before delivering another prompt.",
        );
      }
      if (!hasDeliverableComposerInput(draft)) {
        this.#recordComposerTransferFailure(operationId, false);
        throw new Error("Delivery input is no longer deliverable.");
      }
      this.#updateComposerTransfer(operationId, {
        requestState: "requesting",
      });
      let result;
      try {
        result = await this.#api.operateThread(this.threadId, {
          kind: "deliver",
          mode,
          mutationId: operationId,
          expectedThreadRevision: snapshot.thread.threadRevision,
          expectedDraftRevision: draft.revision,
          ...(mode === "steer"
            ? { steerTarget: prepared.steerTarget! }
            : {}),
        });
      } catch (error) {
        this.#recordComposerTransferFailure(
          operationId,
          !isProvenQueueMutationFailure(error),
        );
        throw error;
      }
      if (
        result.status === "delivery_accepted" ||
        result.status === "delivery_queued"
      ) {
        if (
          (result.status === "delivery_accepted" &&
            result.operationId !== operationId) ||
          result.draft.text !== "" ||
          result.draft.contextExcerpts.length !== 0 ||
          result.draft.attachments.length !== 0 ||
          result.draft.taskReferences.length !== 0 ||
          result.draft.revision <= draft.revision
        ) {
          this.#recordComposerTransferFailure(operationId, true);
          throw new Error(
            "Delivery returned an invalid authoritative draft receipt.",
          );
        }
        this.#applyResolvedDeliveryMode(
          operationId,
          result.resolvedDeliveryMode,
        );
        if (result.resolvedDeliveryMode === "steer") {
          this.#setPendingSteerPhase(operationId, "steering");
        }
        this.#updateComposerTransfer(operationId, {
          requestState: "receipt_received",
          acceptanceEvidence:
            result.status === "delivery_queued" ? "durably_queued" : "accepted",
          ...(result.status === "delivery_queued"
            ? { queuedInputId: result.queuedInputId }
            : {}),
        });
        this.#retireTerminalMaterializedTransfer(operationId);
        this.#setPendingDeliveryBridge(result.threadRevision, "revision");
        return result.draft;
      }
      if (result.status === "delivery_pending_materialization") {
        const authoritative = normalizedDraftSchema.safeParse(result.draft);
        if (
          result.resolvedDeliveryMode !== "steer" ||
          result.operationId !== operationId ||
          !authoritative.success ||
          authoritative.data.revision < draft.revision ||
          !hasDeliverableComposerInput(authoritative.data)
        ) {
          this.#recordComposerTransferFailure(operationId, true);
          throw new Error(
            "Delivery returned an invalid pending-materialization receipt.",
          );
        }
        this.#applyResolvedDeliveryMode(
          operationId,
          result.resolvedDeliveryMode,
        );
        this.#setPendingSteerPhase(operationId, "steering");
        this.#updateComposerTransfer(operationId, {
          requestState: "receipt_received",
          acceptanceEvidence: "pending_materialization",
        });
        this.#retireTerminalMaterializedTransfer(operationId);
        const current = this.#state.snapshot;
        this.#setPendingDeliveryBridge(
          result.threadRevision,
          "pending_materialization",
        );
        return current && current.draft.revision > authoritative.data.revision
          ? current.draft
          : authoritative.data;
      }
      if (result.status === "recovery_required") {
        const authoritative = normalizedDraftSchema.safeParse(result.draft);
        if (
          !authoritative.success ||
          authoritative.data.revision < draft.revision
        ) {
          if (mode === "steer") {
            this.#recordComposerTransferFailure(operationId, true);
          } else {
            this.#recordComposerTransferFailure(operationId, true);
          }
          throw new Error(
            "Delivery returned an invalid authoritative recovery draft receipt.",
          );
        }
        if (mode === "steer") {
          this.#recordComposerTransferFailure(operationId, true);
        } else {
          this.#recordComposerTransferFailure(operationId, true);
        }
        throw new DeliveryRecoveryRequiredError(
          result.retryable,
          authoritative.data,
        );
      }
      this.#recordComposerTransferFailure(operationId, true);
      throw new Error(
        "Delivery did not produce an authoritative draft receipt.",
      );
    });
    return delivery.catch((error: unknown) => {
      // A disconnect can make #mutate fail its authoritative-snapshot guard
      // before the operation closure runs. A still-saving transfer proves no
      // delivery request started and must roll back instead of wedging Steer.
      if (this.#composerTransfer(operationId)?.requestState === "saving") {
        this.#recordComposerTransferFailure(operationId, false);
      }
      throw error;
    });
  }

  cancelQueuedInput(queuedInputId: string): Promise<void> {
    return this.#queueMutation(async (snapshot, generation) => {
      const requestKey = `cancel\0${queuedInputId}`;
      const mutationId = this.#queuedInputMutationId(requestKey);
      let result;
      try {
        result = await this.#api.operateThread(this.threadId, {
          kind: "cancel_queued_input",
          queuedInputId,
          mutationId,
          expectedThreadRevision: snapshot.thread.threadRevision,
        });
      } catch (error) {
        if (isProvenQueueMutationFailure(error)) {
          this.#queuedInputMutationIds.delete(requestKey);
        }
        throw error;
      }
      if (
        result.status !== "queue_cancelled" ||
        result.queuedInputId !== queuedInputId ||
        result.mutationId !== mutationId
      ) {
        throw new Error("Queue cancellation returned an invalid receipt.");
      }
      this.#queuedInputMutationIds.delete(requestKey);
      this.#removePendingQueuedSteersForInput(queuedInputId);
      this.#applyQueueMutationResult(generation, result);
    });
  }

  restoreQueuedInput(
    queuedInputId: string,
    draft: NormalizedDraft,
  ): Promise<NormalizedDraft> {
    return this.#queueMutation(async (snapshot, generation) => {
      const requestKey = `restore\0${queuedInputId}`;
      const mutationId = this.#queuedInputMutationId(requestKey);
      let result;
      try {
        result = await this.#api.operateThread(this.threadId, {
          kind: "restore_queued_input",
          queuedInputId,
          mutationId,
          expectedThreadRevision: snapshot.thread.threadRevision,
          expectedDraftRevision: draft.revision,
        });
      } catch (error) {
        if (isProvenQueueMutationFailure(error)) {
          this.#queuedInputMutationIds.delete(requestKey);
        }
        throw error;
      }
      const authoritative =
        result.status === "queue_restored"
          ? normalizedDraftSchema.safeParse(result.draft)
          : undefined;
      if (
        result.status !== "queue_restored" ||
        result.queuedInputId !== queuedInputId ||
        result.mutationId !== mutationId ||
        !authoritative?.success ||
        authoritative.data.revision <= draft.revision
      ) {
        throw new Error("Queue restoration returned an invalid receipt.");
      }
      this.#queuedInputMutationIds.delete(requestKey);
      this.#removePendingQueuedSteersForInput(queuedInputId);
      this.#applyQueueMutationResult(generation, {
        ...result,
        draft: authoritative.data,
      });
      return authoritative.data;
    });
  }

  steerQueuedInput(queuedInputId: string): Promise<void> {
    const stagedSnapshot = this.#requireSnapshot();
    const stagedItem = stagedSnapshot.queue.find(
      (item) => item.id === queuedInputId,
    );
    if (!stagedItem) {
      return Promise.reject(
        new Error("The queued input is no longer present."),
      );
    }
    const requestKey = `steer\0${queuedInputId}`;
    const mutationId = this.#queuedInputMutationId(requestKey);
    const alreadyStaged = this.#state.pendingQueuedSteers.some(
      (pending) => pending.operationId === mutationId,
    );
    if (!alreadyStaged) {
      if (this.#state.pendingQueuedSteers.length >= 500) {
        this.#queuedInputMutationIds.delete(requestKey);
        return Promise.reject(
          new Error(
            "Too many unresolved Steer presentations are retained. Reload the thread before steering more queued input.",
          ),
        );
      }
      this.#setPendingQueuedSteers([
        ...this.#state.pendingQueuedSteers,
        {
          operationId: mutationId,
          queuedInputId,
          preview: stagedItem.preview.text,
          attachmentCount: stagedItem.attachmentCount,
          taskCount: stagedItem.taskCount,
          startedAt: Date.now(),
          presentationSequence: this.#nextTransferPresentationSequence++,
          phase: "sending",
          requestState: "requesting",
        },
      ]);
    }
    let requestStarted = false;
    const queuedMutation = this.#queueMutation(async (snapshot, generation) => {
      if (this.#state.pendingDeliveryThreadRevision !== undefined) {
        this.#removePendingQueuedSteer(mutationId);
        throw new Error(
          "Wait for the previous steering input to appear before steering again.",
        );
      }
      let result;
      try {
        requestStarted = true;
        result = await this.#api.operateThread(this.threadId, {
          kind: "steer_queued_input",
          queuedInputId,
          mutationId,
          expectedThreadRevision: snapshot.thread.threadRevision,
        });
      } catch (error) {
        if (isProvenQueueMutationFailure(error)) {
          this.#queuedInputMutationIds.delete(requestKey);
          this.#removePendingQueuedSteer(mutationId);
        } else {
          this.#updatePendingQueuedSteer(mutationId, {
            phase: "unconfirmed",
            requestState: "request_failed",
          });
        }
        throw error;
      }
      if (
        (result.status !== "queue_steer_accepted" &&
          result.status !== "queue_steer_pending_materialization" &&
          result.status !== "queue_steer_recovery_required") ||
        result.queuedInputId !== queuedInputId ||
        result.operationId !== mutationId
      ) {
        this.#updatePendingQueuedSteer(mutationId, {
          phase: "unconfirmed",
          requestState: "request_failed",
        });
        throw new Error("Queued Steer returned an invalid receipt.");
      }
      this.#queuedInputMutationIds.delete(requestKey);
      this.#updatePendingQueuedSteer(mutationId, {
        phase:
          result.status === "queue_steer_recovery_required"
            ? "unconfirmed"
            : "steering",
        requestState: "receipt_received",
      });
      this.#applyQueueMutationResult(generation, result);
      if (result.status === "queue_steer_pending_materialization") {
        this.#setPendingDeliveryBridge(
          result.threadRevision,
          "pending_materialization",
        );
      }
      if (result.status === "queue_steer_recovery_required") {
        throw new Error(
          "Steer delivery is unconfirmed. Use recovery before sending more input.",
        );
      }
    });
    return queuedMutation.catch((error: unknown) => {
      if (!requestStarted) {
        this.#queuedInputMutationIds.delete(requestKey);
        this.#removePendingQueuedSteer(mutationId);
      }
      throw error;
    });
  }

  /**
   * Interrupts the active agent turn. User-facing controls should label this
   * action “Stop”; “interrupt” is the backend operation name only.
   */
  stopActiveTurn(): Promise<void> {
    return this.#mutate(async () => {
      this.#requireOperation("interrupt");
      await this.#api.operateThread(this.threadId, {
        kind: "interrupt",
        operationId: crypto.randomUUID(),
      });
    });
  }

  loadOlderHistory(): Promise<void> {
    return this.#loadHistory(false);
  }

  loadAllOlderHistory(): Promise<void> {
    return this.#loadHistory(true);
  }

  #loadHistory(loadAll: boolean): Promise<void> {
    if (this.#historyLoad) return this.#historyLoad;
    const load = this.#loadOlderHistory(loadAll);
    const joined = load.finally(() => {
      if (this.#historyLoad === joined) this.#historyLoad = undefined;
    });
    this.#historyLoad = joined;
    return joined;
  }

  async #loadOlderHistory(loadAll: boolean): Promise<void> {
    if (this.#disposed) return;
    const projectionEpoch = this.#projectionEpoch;
    const snapshot = this.#requireSnapshot();
    if (
      !snapshot.capabilities.history.available ||
      !snapshot.capabilities.history.paginated ||
      !snapshot.history.hasOlder
    ) {
      throw new Error("Earlier conversation history is not available.");
    }
    this.#replaceState({
      ...this.#state,
      historyLoading: true,
      actionError: undefined,
    });
    try {
      const limit = getHistoryPageSize();
      let pages = 0;
      while (pages < (loadAll ? MAXIMUM_LOAD_ALL_HISTORY_PAGES : 1)) {
        if (this.#disposed) return;
        const current = this.#requireSnapshot();
        if (!current.history.hasOlder) return;
        const cursor = current.history.olderCursor;
        const envelope = await this.#api.loadOlderHistory(
          this.threadId,
          cursor,
          limit,
          this.#activityDetail,
        );
        if (projectionEpoch !== this.#projectionEpoch) {
          throw new Error("Activity detail changed while history was loading.");
        }
        if (!envelopeMatchesActivityDetail(envelope, this.#activityDetail)) {
          throw new Error(
            "History returned the wrong activity detail projection.",
          );
        }
        if (this.#disposed) return;
        pages += 1;
        const result = this.normalized.apply(envelope);
        if (this.#disposed) return;
        if (result.kind === "resnapshot_required") {
          this.#replaceState({
            ...this.#state,
            authoritative: false,
            error: `Thread history needs a new snapshot: ${result.reason}`,
          });
          this.#resubscribe();
          return;
        }
        const next = this.#requireSnapshot();
        if (!loadAll || !next.history.hasOlder) return;
        if (next.history.olderCursor === cursor) {
          throw new Error("Earlier conversation history did not advance.");
        }
      }
      if (this.#requireSnapshot().history.hasOlder) {
        throw new Error(
          "Earlier conversation history exceeded the bounded load-all limit.",
        );
      }
    } catch (error) {
      if (this.#disposed) return;
      if (projectionEpoch !== this.#projectionEpoch) {
        throw error;
      }
      this.#replaceState({
        ...this.#state,
        actionError: messageFrom(error),
      });
      throw error;
    } finally {
      if (!this.#disposed && projectionEpoch === this.#projectionEpoch) {
        this.#replaceState({
          ...this.#state,
          historyLoading: false,
        });
      }
    }
  }

  seekHistoryTurn(targetTurnId: string): Promise<ThreadHistorySeekResult> {
    const inFlight = this.#historySeeks.get(targetTurnId);
    if (inFlight) return inFlight;
    const projectionEpoch = this.#projectionEpoch;
    const operation = this.#api
      .seekHistoryTurn(this.threadId, targetTurnId, this.#activityDetail)
      .then((result) => {
        if (projectionEpoch !== this.#projectionEpoch) {
          throw new Error("Activity detail changed while history was loading.");
        }
        if (
          result.status === "found" &&
          !itemsMatchActivityDetail(
            Object.values(result.page.itemsById),
            this.#activityDetail,
          )
        ) {
          throw new Error(
            "History returned the wrong activity detail projection.",
          );
        }
        return result;
      })
      .finally(() => {
        if (this.#historySeeks.get(targetTurnId) === operation) {
          this.#historySeeks.delete(targetTurnId);
        }
      });
    this.#historySeeks.set(targetTurnId, operation);
    return operation;
  }

  async loadQuestionRequests(): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#questionLoadGeneration;
    const revisionAtStart = this.#state.questionRevision;
    try {
      const result = await this.#api.listQuestionRequests(this.threadId);
      if (this.#disposed || generation !== this.#questionLoadGeneration) return;
      this.#applyQuestionRequests(result);
    } catch (error) {
      if (
        this.#disposed ||
        generation !== this.#questionLoadGeneration ||
        this.#state.questionRevision > revisionAtStart
      )
        return;
      this.#replaceState({
        ...this.#state,
        questionStatus: "error",
        questionError: messageFrom(error),
      });
    }
  }

  requestQuestionInboxOpen(): void {
    this.#replaceState({
      ...this.#state,
      questionInboxOpenRevision: this.#state.questionInboxOpenRevision + 1,
    });
  }

  closeQuestionInbox(): void {
    this.#replaceState({
      ...this.#state,
      questionInboxClosedQuestionKeys: this.#state.questionRequests.flatMap(
        (request) => request.questions.map(
          (question) => `${request.id}:${question.index}`,
        ),
      ),
      questionInboxConsumedOpenRevision: this.#state.questionInboxOpenRevision,
    });
  }

  acknowledgeQuestionInboxOpen(): void {
    this.#replaceState({
      ...this.#state,
      questionInboxClosedQuestionKeys: [],
      questionInboxConsumedOpenRevision: this.#state.questionInboxOpenRevision,
    });
  }

  setQuestionDraft(questionId: string, answers: readonly string[]): void {
    this.#replaceState({
      ...this.#state,
      questionDrafts: { ...this.#state.questionDrafts, [questionId]: answers },
    });
  }

  async respondToQuestion(
    request: QuestionRequest,
    answers: RespondToQuestionRequest["answers"],
  ): Promise<void> {
    this.#requireSnapshot();
    if (this.#state.pendingQuestionIds.includes(request.id)) return;
    const id = `question:${request.id}:${request.revision}`;
    const reply: PendingQuestionReply = {
      id,
      requestId: request.id,
      answers: answers.map(({ questionIndex, answer }) => {
        const question = request.questions.find(
          ({ index }) => index === questionIndex,
        );
        if (!question) throw new Error("This question is no longer open.");
        return { questionIndex, question: question.title, answer };
      }),
    };
    this.#replaceState({
      ...this.#state,
      pendingQuestionReplies: [
        ...this.#state.pendingQuestionReplies.filter((item) => item.id !== id),
        reply,
      ],
    });
    return this.#mutateQuestion(request, async () => {
      try {
        const result = await this.#api.respondToQuestion(this.threadId, request.id, {
          revision: request.revision,
          answers,
        });
        if (!this.#disposed) {
          this.#replaceState({
            ...this.#state,
            pendingQuestionReplies: this.#state.pendingQuestionReplies.flatMap((item) => {
              if (item.id !== id) return [item];
              if (result.deliveryState === "cancelled" || result.deliveryState === "failed") return [];
              return [{
                ...item,
                deliveryOperationId: result.deliveryOperationId,
                ...(result.queuedInput ? { queuedInput: result.queuedInput } : {}),
              }];
            }),
          });
        }
        return result;
      } catch (error) {
        if (!this.#disposed) {
          this.#replaceState({
            ...this.#state,
            pendingQuestionReplies: this.#state.pendingQuestionReplies.filter(
              (item) => item.id !== id,
            ),
          });
        }
        throw error;
      }
    });
  }

  async dismissQuestion(request: QuestionRequest): Promise<void> {
    return this.#mutateQuestion(request, () =>
      this.#api.dismissQuestion(this.threadId, request.id, {
        revision: request.revision,
      }),
    );
  }

  async #mutateQuestion(
    request: QuestionRequest,
    mutate: () => Promise<QuestionRequestsResult>,
  ): Promise<void> {
    this.#requireSnapshot();
    if (this.#state.pendingQuestionIds.includes(request.id)) return;
    this.#replaceState({
      ...this.#state,
      pendingQuestionIds: [...this.#state.pendingQuestionIds, request.id],
    });
    try {
      this.#applyQuestionRequests(await mutate());
    } catch (error) {
      // Reconcile a conflicting action from another client, while retaining
      // this client's answer draft if the request is still open.
      void this.loadQuestionRequests();
      throw error;
    } finally {
      if (!this.#disposed)
        this.#replaceState({
          ...this.#state,
          pendingQuestionIds: this.#state.pendingQuestionIds.filter(
            (id) => id !== request.id,
          ),
        });
    }
  }

  #applyQuestionRequests(result: QuestionRequestsResult): void {
    if (this.#disposed || result.revision < this.#state.questionRevision)
      return;
    const pendingIndices = new Map(
      result.requests.map((request) => [
        request.id,
        new Set(request.questions.map((question) => question.index)),
      ]),
    );
    const pendingQuestionKeys = new Set(
      result.requests.flatMap((request) => request.questions.map(
        (question) => `${request.id}:${question.index}`,
      )),
    );
    this.#replaceState({
      ...this.#state,
      questionInboxClosedQuestionKeys:
        this.#state.questionInboxClosedQuestionKeys.filter(
          (key) => pendingQuestionKeys.has(key),
        ),
      questionRequests: result.requests,
      questionRevision: result.revision,
      questionStatus: "ready",
      questionError: undefined,
      questionDrafts: Object.fromEntries(
        Object.entries(this.#state.questionDrafts)
          .filter(([id]) => pendingIndices.has(id))
          .map(([id, answers]) => [
            id,
            answers.map((answer, index) =>
              pendingIndices.get(id)!.has(index) ? answer : "",
            ),
          ]),
      ),
    });
  }

  async loadBookmarks(background = false): Promise<void> {
    if (this.#disposed) return;
    // A quiet conflict check must not invalidate a foreground reload that owns
    // the loading indicator, especially if the quiet request would then fail.
    if (background && this.#state.bookmarkStatus === "loading") return;
    const generation = ++this.#bookmarkLoadGeneration;
    if (!background) {
      this.#replaceState({
        ...this.#state,
        bookmarkStatus: "loading",
        bookmarkError: undefined,
      });
    }
    try {
      const result = await this.#api.listTurnBookmarks(this.threadId);
      if (
        this.#disposed ||
        generation !== this.#bookmarkLoadGeneration ||
        result.revision < this.#state.bookmarkRevision
      )
        return;
      const retainedTurnIds = new Set(
        result.bookmarks.map(({ turnId }) => turnId),
      );
      for (const turnId of this.#bookmarkPreviewRefreshAttempts.keys()) {
        if (!retainedTurnIds.has(turnId)) {
          this.#bookmarkPreviewRefreshAttempts.delete(turnId);
        }
      }
      this.#replaceState({
        ...this.#state,
        bookmarks: result.bookmarks,
        bookmarkRevision: result.revision,
        bookmarkStatus: "ready",
        bookmarkError: background ? this.#state.bookmarkError : undefined,
      });
      this.#publishedBookmarkRevision = result.revision;
    } catch (error) {
      if (
        this.#disposed || background ||
        generation !== this.#bookmarkLoadGeneration
      ) return;
      this.#replaceState({
        ...this.#state,
        bookmarkStatus: "error",
        bookmarkError: messageFrom(error),
      });
    }
  }

  observePublishedBookmarkRevision(revision: number): void {
    if (revision === this.#publishedBookmarkRevision) return;
    this.#publishedBookmarkRevision = revision;
    if (revision !== this.#state.bookmarkRevision) {
      void this.loadBookmarks(this.#state.bookmarkStatus === "ready");
    }
  }

  setTurnBookmarked(input: TurnBookmarkMutation): Promise<void> {
    return this.#mutateTurnBookmark(input);
  }

  /** Complete a loaded terminal reply without re-adding or degrading a bookmark. */
  refreshTurnBookmarkPreview(input: {
    readonly turnId: string;
    readonly preview: TurnBookmarkPreview;
  }): Promise<void> {
    if (this.#disposed || this.#state.bookmarkStatus !== "ready") {
      return Promise.resolve();
    }
    const current = this.#state.bookmarks.find(
      ({ turnId }) => turnId === input.turnId,
    );
    const reply = input.preview.assistantPreview;
    const savedReply = current?.assistantPreview ?? "";
    // An unfinished link/image is still literal in a streaming Markdown
    // preview. Once its closing delimiter arrives the URL/brackets disappear,
    // so compare the stable visible label instead of requiring the raw syntax.
    const savedVisiblePrefix = savedReply
      .replace(/!?\[([^\]]*)\](?:\([^)]*)?$/u, "$1")
      .replace(/!?\[([^\]]*)$/u, "$1")
      .trimEnd();
    const completesMarkdown =
      savedVisiblePrefix !== savedReply &&
      savedVisiblePrefix.length > 0 &&
      reply?.startsWith(savedVisiblePrefix);
    // A terminal history window can omit earlier replies. Only extend the saved
    // visible text; never replace it with a missing or unrelated retained suffix.
    // This also makes reconciliation converge across differently bounded views.
    if (
      !current ||
      !reply ||
      reply === savedReply ||
      (!completesMarkdown && !reply.startsWith(savedReply))
    ) {
      return Promise.resolve();
    }
    const preview = { ...input.preview, userPreview: current.userPreview };
    const revision = this.#state.bookmarkRevision;
    const attempt = JSON.stringify([
      revision,
      this.#bookmarkLoadGeneration,
      preview,
    ]);
    if (this.#bookmarkPreviewRefreshAttempts.get(input.turnId) === attempt) {
      return Promise.resolve();
    }
    // Failed background refreshes must not loop on unrelated transcript renders.
    // A later bookmark load or revision change permits reconciliation again.
    this.#bookmarkPreviewRefreshAttempts.set(input.turnId, attempt);
    return this.#mutateTurnBookmark(
      { turnId: input.turnId, preview, bookmarked: true },
      revision,
    );
  }

  #mutateTurnBookmark(
    input: TurnBookmarkMutation,
    refreshRevision?: number,
  ): Promise<void> {
    const { turnId, bookmarked } = input;
    const background = refreshRevision !== undefined;
    const operation = this.#bookmarkMutationChain.then(async () => {
      if (this.#disposed) return;
      // The user-facing mutation is an upsert. For background refresh, both
      // local queue admission and the server's revision CAS must still refer to
      // the existing bookmark we observed. Never retry this as a fresh add.
      if (
        refreshRevision !== undefined &&
        (this.#state.bookmarkStatus !== "ready" ||
          this.#state.bookmarkRevision !== refreshRevision ||
          !this.#state.bookmarks.some((bookmark) => bookmark.turnId === turnId))
      ) {
        return;
      }
      if (this.#state.bookmarkStatus !== "ready") {
        throw new Error(
          "Bookmarks must finish loading before they can be changed.",
        );
      }
      if (!background) {
        const pendingBookmarkTurnIds = [
          ...new Set([...this.#state.pendingBookmarkTurnIds, turnId]),
        ];
        this.#replaceState({
          ...this.#state,
          pendingBookmarkTurnIds,
          bookmarkError: undefined,
        });
      }
      try {
        const result = await this.#api.setTurnBookmark(
          this.threadId,
          turnId,
          bookmarked
            ? {
                bookmarked: true,
                expectedRevision: this.#state.bookmarkRevision,
                mutationId: crypto.randomUUID(),
                userPreview: input.preview.userPreview,
                assistantPreview: input.preview.assistantPreview,
                responseState: input.preview.responseState,
              }
            : {
                bookmarked: false,
                expectedRevision: this.#state.bookmarkRevision,
                mutationId: crypto.randomUUID(),
              },
        );
        if (this.#disposed || result.revision < this.#state.bookmarkRevision)
          return;
        if (!result.bookmark) this.#bookmarkPreviewRefreshAttempts.delete(turnId);
        const bookmarks = result.bookmark
          ? [
              ...this.#state.bookmarks.filter(
                (bookmark) => bookmark.turnId !== turnId,
              ),
              result.bookmark,
            ].sort((left, right) => left.createdAt - right.createdAt)
          : this.#state.bookmarks.filter(
              (bookmark) => bookmark.turnId !== turnId,
            );
        this.#replaceState({
          ...this.#state,
          bookmarks,
          bookmarkRevision: result.revision,
          bookmarkStatus: "ready",
          bookmarkError: background ? this.#state.bookmarkError : undefined,
        });
      } catch (error) {
        const revisionConflict =
          error instanceof ApiError &&
          error.code === "bookmark_revision_conflict";
        if (revisionConflict) {
          await this.loadBookmarks(background);
        }
        if (!this.#disposed && !background && !revisionConflict) {
          this.#replaceState({
            ...this.#state,
            bookmarkError: messageFrom(error),
          });
        }
        throw error;
      } finally {
        if (!this.#disposed && !background) {
          this.#replaceState({
            ...this.#state,
            pendingBookmarkTurnIds: this.#state.pendingBookmarkTurnIds.filter(
              (pendingTurnId) => pendingTurnId !== turnId,
            ),
          });
        }
      }
    });
    this.#bookmarkMutationChain = operation.catch(() => undefined);
    return operation;
  }

  forkTurn(
    capability: TurnForkCapability,
    options?: { readonly restart?: boolean; readonly environmentVariables?: EnvironmentVariableOverrides },
  ): Promise<ForkThreadResult> {
    if (!capability.available) {
      return Promise.reject(
        new Error(
          capability.unavailableReason?.text ??
            "This completed turn cannot be forked right now.",
        ),
      );
    }
    return this.#fork(
      capability.sourceTurnId,
      {
        boundary: "selected_completed_turn",
        sourceTurnId: capability.sourceTurnId,
        expectedTurnRevision: capability.expectedTurnRevision,
        ...(options?.environmentVariables ? { environmentVariables: options.environmentVariables } : {}),
        mutationId: crypto.randomUUID(),
      },
      options,
    );
  }

  forkLatestProviderSnapshot(options?: {
    readonly restart?: boolean;
    readonly environmentVariables?: EnvironmentVariableOverrides;
  }): Promise<ForkThreadResult> {
    const snapshot = this.#requireSnapshot();
    const capability = snapshot.forkSource.latestProviderSnapshot;
    if (!capability.available) {
      return Promise.reject(
        new Error(
          capability.unavailableReason?.text ??
            "The latest provider snapshot cannot be forked right now.",
        ),
      );
    }
    return this.#fork(
      LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY,
      {
        boundary: "latest_provider_snapshot",
        ...(options?.environmentVariables ? { environmentVariables: options.environmentVariables } : {}),
        mutationId: crypto.randomUUID(),
      },
      options,
    );
  }

  #fork(
    attemptKey: string,
    freshRequest: ForkThreadRequest,
    options?: { readonly restart?: boolean },
  ): Promise<ForkThreadResult> {
    const inFlight = this.#forkInFlight.get(attemptKey);
    if (inFlight) return inFlight;
    this.#requireSnapshot();
    const prior = this.#state.forkAttempts[attemptKey];
    if (prior?.phase === "request_failed" && !prior.retryable) {
      return Promise.reject(new Error(prior.diagnostic));
    }
    if (prior?.phase === "recovery_required" && !prior.retryable) {
      return Promise.reject(
        new Error(
          "This fork has unresolved provider work. Open its recovery thread instead of creating another fork.",
        ),
      );
    }
    const keepRequest =
      !options?.restart &&
      ((prior?.phase === "request_failed" && prior.retryable) ||
        (prior?.phase === "recovery_required" && prior.retryable));
    const request = keepRequest
      ? this.#forkRequests.get(attemptKey)
      : freshRequest;
    if (!request) {
      return Promise.reject(new Error("The fork retry could not be resumed."));
    }
    this.#forkRequests.set(attemptKey, request);
    this.#setForkAttempt(attemptKey, { phase: "pending" });
    const operation = this.#api
      .forkThread(this.threadId, request)
      .then((result) => {
        if (result.status === "created") {
          this.#clearForkAttempt(attemptKey);
          this.#forkRequests.delete(attemptKey);
        } else if (result.status === "recovery_required") {
          this.#setForkAttempt(attemptKey, {
            phase: "recovery_required",
            childThreadId: result.childThreadId,
            retryable: result.retryable,
            diagnostic: result.diagnostic,
          });
        } else {
          this.#setForkAttempt(attemptKey, {
            phase: "aborted",
            childThreadId: result.childThreadId,
            diagnostic: result.diagnostic,
          });
          this.#forkRequests.delete(attemptKey);
        }
        return result;
      })
      .catch((error: unknown) => {
        const retryable = !(error instanceof ApiError) || error.retryable;
        this.#setForkAttempt(attemptKey, {
          phase: "request_failed",
          retryable,
          diagnostic: messageFrom(error),
        });
        if (!retryable) this.#forkRequests.delete(attemptKey);
        throw error;
      })
      .finally(() => {
        this.#forkInFlight.delete(attemptKey);
      });
    this.#forkInFlight.set(attemptKey, operation);
    return operation;
  }

  clearForkAttempt(sourceTurnId: string): void {
    if (this.#forkInFlight.has(sourceTurnId)) return;
    const attempt = this.#state.forkAttempts[sourceTurnId];
    if (
      (attempt?.phase === "request_failed" && attempt.retryable) ||
      attempt?.phase === "recovery_required"
    ) {
      return;
    }
    this.#clearForkAttempt(sourceTurnId);
    this.#forkRequests.delete(sourceTurnId);
  }

  perform(
    operation: PerformOperation,
  ): Promise<
    import("../../shared/protocol/api.js").ThreadApplicationMutationResult
  > {
    return this.#mutate(async () => {
      const snapshot = this.#requireSnapshot();
      this.#requirePerformCapability(operation);
      const settingsAction = operation.action === "set_setting";
      return await this.#api.operateThread(this.threadId, {
        kind: "perform",
        mutationId: crypto.randomUUID(),
        expectedThreadRevision: snapshot.thread.threadRevision,
        ...(settingsAction
          ? { expectedSettingsRevision: snapshot.settings.revision }
          : {}),
        operation,
      });
    });
  }

  setAgentToolPolicy(
    input: SetAgentToolPolicyInput,
  ): Promise<
    import("../../shared/protocol/api.js").ThreadApplicationMutationResult
  > {
    return this.#mutate(async () => {
      const snapshot = this.#requireSnapshot();
      const liveCliPolicy =
        snapshot.agentTools.presentation.surface === "cli" &&
        input.presentation.surface ===
          snapshot.agentTools.presentation.surface &&
        input.presentation.mode === snapshot.agentTools.presentation.mode;
      if (
        snapshot.runState !== "idle" &&
        snapshot.runState !== "failed" &&
        !liveCliPolicy
      ) {
        throw new Error(
          "Native tool policy and presentation changes require an idle thread.",
        );
      }
      if (snapshot.agentTools.revision !== input.expectedPolicyRevision) {
        throw new Error(
          "Agent tool settings changed in another client. Review the current settings and try again.",
        );
      }
      if (
        !snapshot.agentTools.presentationOptions.some(
          ({ surface, modes }) =>
            surface === input.presentation.surface &&
            modes.includes(input.presentation.mode),
        )
      ) {
        throw new Error("The selected agent tool presentation is unavailable.");
      }
      const eligibleToolIds = new Set(
        snapshot.agentTools.groups.flatMap(({ tools }) =>
          tools
            .filter(({ available }) => available !== false)
            .map(({ id }) => id),
        ),
      );
      if (
        new Set(input.enabledToolIds).size !== input.enabledToolIds.length ||
        input.enabledToolIds.some((id) => !eligibleToolIds.has(id))
      ) {
        throw new Error("The selected agent tool set is no longer available.");
      }
      return await this.#api.operateThread(this.threadId, {
        kind: "set_agent_tool_policy",
        mutationId: crypto.randomUUID(),
        expectedPolicyRevision: input.expectedPolicyRevision,
        enabled: input.enabled,
        enabledToolIds: [...input.enabledToolIds],
        presentation: input.presentation,
        accessBoundary: input.accessBoundary,
      });
    });
  }

  moveDraft(workspaceId: string): Promise<void> {
    return this.#mutate(async () => {
      let snapshot = this.#requireSnapshot();
      if (snapshot.thread.backingState !== "unbound") {
        throw new Error("Only a draft thread can change workspaces.");
      }
      this.#requireOperation("move_draft");
      if (workspaceId === snapshot.workspace.id) return;
      // Persist any composer-local draft text before the move so it travels
      // with the thread instead of being stranded on the old workspace.
      await this.#draftFlush?.();
      snapshot = this.#requireSnapshot();
      if (snapshot.thread.backingState !== "unbound") {
        throw new Error("Only a draft thread can change workspaces.");
      }
      this.#requireOperation("move_draft");
      if (workspaceId === snapshot.workspace.id) return;
      await this.#api.operateThread(this.threadId, {
        kind: "move_draft",
        workspaceId,
        expectedThreadRevision: snapshot.thread.threadRevision,
        mutationId: crypto.randomUUID(),
      });
    });
  }

  respond(interactionId: string, response: InteractionResponse): Promise<void> {
    return this.#mutate(async () => {
      const snapshot = this.#requireSnapshot();
      const interaction = snapshot.interactions.find(
        ({ id }) => id === interactionId,
      );
      if (!interaction) throw new Error("The interaction is no longer open.");
      const generation = this.normalized.state.generation;
      const capability = snapshot.capabilities.interactions.find(
        ({ kind }) => kind === interaction.kind,
      );
      if (!capability?.available) {
        throw new Error(
          capability?.unavailableReason?.text ??
            "This interaction cannot be answered right now.",
        );
      }
      const result = await this.#api.operateThread(this.threadId, {
        kind: "respond",
        operationId: crypto.randomUUID(),
        interactionId,
        response,
      });
      if (result.status === "recovery_required") {
        if (!result.retryable) {
          const projection = this.normalized.applyInteractionResolution(
            interactionId, generation,
          );
          if (projection.kind === "resnapshot_required") this.#resubscribe();
        }
        throw new Error(
          result.retryable
            ? "The response outcome is uncertain. Recover it before trying again."
            : "The response outcome is uncertain. The request was closed because it cannot be retried safely.",
        );
      }
      if (result.status !== "completed") {
        throw new Error(
          "The interaction response returned an invalid receipt.",
        );
      }
      const projection = this.normalized.applyInteractionResolution(
        interactionId, generation,
      );
      if (projection.kind === "resnapshot_required") this.#resubscribe();
    });
  }

  recoverUncertain(): Promise<void> {
    return this.#mutate(async () => {
      const generation = this.normalized.state.generation;
      if (!generation) throw new Error("Thread projection generation missing.");
      const result = await this.#api.operateThread(this.threadId, {
        kind: "recover_uncertain",
      });
      if (
        result.status === "delivery_accepted" ||
        result.status === "delivery_pending_materialization"
      ) {
        const pending = this.#liveSteerTransfer();
        if (pending && result.operationId !== pending.operationId) {
          throw new Error(
            "Delivery recovery returned another pending steer operation.",
          );
        }
        if (pending) {
          this.#applyResolvedDeliveryMode(
            pending.operationId,
            result.resolvedDeliveryMode,
          );
        }
        if (pending && result.resolvedDeliveryMode === "steer") {
          this.#setPendingSteerPhase(pending.operationId, "steering");
          this.#updateComposerTransfer(pending.operationId, {
            requestState: "receipt_received",
            acceptanceEvidence:
              result.status === "delivery_pending_materialization"
                ? "pending_materialization"
                : "accepted",
          });
        }
        this.#setPendingDeliveryBridge(
          result.threadRevision,
          result.status === "delivery_pending_materialization"
            ? "pending_materialization"
            : "revision",
        );
      }
      if (result.status === "recovery_required") {
        const pending = this.#liveSteerTransfer();
        if (pending) {
          this.#setPendingSteerPhase(pending.operationId, "unconfirmed");
        }
      }
      if (
        result.status === "queue_steer_accepted" ||
        result.status === "queue_steer_pending_materialization" ||
        result.status === "queue_steer_recovery_required" ||
        result.status === "queue_steer_restored"
      ) {
        this.#applyQueueMutationResult(generation, result);
        if (result.status === "queue_steer_pending_materialization") {
          this.#setPendingDeliveryBridge(
            result.threadRevision,
            "pending_materialization",
          );
        }
      }
    });
  }

  #requireOperation(
    id: NormalizedThreadSnapshot["capabilities"]["operations"][number]["id"],
  ): void {
    const descriptor = this.#requireSnapshot().capabilities.operations.find(
      (operation) => operation.id === id,
    );
    if (!descriptor?.available) {
      throw new Error(
        descriptor?.unavailableReason?.text ??
          `${id} is unavailable for this thread.`,
      );
    }
  }

  #requirePerformCapability(operation: PerformOperation): void {
    if (operation.action === "rename" || operation.action === "compact") {
      this.#requireOperation(operation.action);
      return;
    }
    if (operation.action === "perform_provider_feature") {
      const capability =
        this.#requireSnapshot().capabilities.providerFeatures.find(
          ({ ref }) =>
            ref.featureId === operation.feature.featureId &&
            ref.schemaVersion === operation.feature.schemaVersion,
        );
      const descriptor = capability?.operations.find(
        ({ actionId }) => actionId === operation.actionId,
      );
      if (
        capability?.availability !== "available" ||
        !descriptor ||
        capability.revision !== operation.expectedFeatureRevision
      ) {
        throw new Error(
          capability?.unavailableReason?.text ??
            `${capability?.label.text ?? operation.feature.featureId} is unavailable.`,
        );
      }
      return;
    }
    const settingId = operation.settingId;
    const descriptor = this.#requireSnapshot().capabilities.settings.find(
      ({ id }) => id === settingId,
    );
    if (!descriptor?.available) {
      throw new Error(
        descriptor?.unavailableReason?.text ??
          `${descriptor?.label.text ?? settingId} is unavailable.`,
      );
    }
  }

  #requireSnapshot(): NormalizedThreadSnapshot {
    if (
      this.#state.connection !== "connected" ||
      !this.#state.authoritative ||
      !this.#state.snapshot
    ) {
      throw new Error(
        "Wait for the thread to reconnect and receive an authoritative snapshot.",
      );
    }
    return this.#state.snapshot;
  }

  #subscribeToEvents(): void {
    this.#subscription?.close();
    const epoch = ++this.#subscriptionEpoch;
    // A fresh attach replaces the projection; drop any batch buffered from
    // the previous (possibly poisoned) stream.
    this.#cancelEnvelopeFlush();
    this.#pendingEnvelopes = [];
    // A new attach invalidates any healthy-window reset from its predecessor.
    // The replacement timer is armed only after this attach reaches live;
    // time spent in a slow failing acquisition is not recovery evidence.
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    this.#subscription = this.#transport.subscribeThread(this.threadId, {
      activityDetail: this.#activityDetail,
      onConnection: (connection) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        if (connection !== "connected") {
          if (this.#healthyResetTimer !== undefined) {
            globalThis.clearTimeout(this.#healthyResetTimer);
            this.#healthyResetTimer = undefined;
          }
          if (this.#streamWasLive) {
            this.#loadAttempt =
              beginThreadLoadAttempt(this.threadId, "reconnect") ??
              this.#loadAttempt;
            this.#streamWasLive = false;
          }
          recordThreadLoadDiagnostic(
            this.#loadAttempt,
            connection === "disconnected"
              ? "stream_disconnected"
              : "stream_reconnecting",
            { connection },
          );
          this.normalized.prepareForReconnect();
          this.#replaceState({
            ...this.#state,
            connection,
            authoritative: false,
          });
          return;
        }
        this.usage.invalidate();
        this.normalized.confirmReplayCaughtUp();
        this.#replaceState({ ...this.#state, connection });
      },
      // The live marker is the server's replay-handshake boundary. Apply the
      // complete replay suffix synchronously before onConnection restores
      // authority, rather than leaving it queued for a later animation frame.
      onLive: () => {
        this.#flushEnvelopes();
        const accepted =
          !this.#disposed &&
          !this.#paused &&
          epoch === this.#subscriptionEpoch &&
          !this.#resubscribing;
        if (accepted) {
          this.#automaticLoadRetries = 0;
          if (this.#healthyResetTimer !== undefined) {
            globalThis.clearTimeout(this.#healthyResetTimer);
          }
          // Quiet threads may emit no incrementals after recovery, so an
          // accepted live handshake that remains healthy resets backoff.
          this.#healthyResetTimer = globalThis.setTimeout(() => {
            this.#healthyResetTimer = undefined;
            this.#resubscribeAttempts = 0;
          }, 15_000);
        }
        return accepted;
      },
      getReplayCursor: () => this.normalized.replayCursor,
      onProtocolError: (error) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        this.#applyProtocolFailure(error, false);
      },
      onTerminalProtocolError: (error) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        this.#applyProtocolFailure(error, true);
      },
      onLoadError: (failure) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        this.normalized.prepareForReconnect();
        const automaticallyRetry =
          failure.error.retryable &&
          this.#automaticLoadRetries < MAXIMUM_AUTOMATIC_LOAD_RETRIES;
        if (automaticallyRetry) this.#automaticLoadRetries += 1;
        recordThreadLoadDiagnostic(this.#loadAttempt, "thread_load_failed", {
          code: failure.error.code,
          requestId: failure.requestId,
          retryable: failure.error.retryable,
        });
        this.#replaceState({
          ...this.#state,
          status: this.#state.snapshot ? "ready" : "error",
          error: failure.error.message,
          loadFailure: failure,
          terminalLoadError: undefined,
          connection: automaticallyRetry ? "reconnecting" : "disconnected",
          authoritative: false,
        });
        if (automaticallyRetry) this.#resubscribe();
      },
      onCheckpoint: (checkpoint) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        this.#applyCheckpoint(checkpoint);
      },
      onEnvelope: (envelope) => {
        if (this.#disposed || epoch !== this.#subscriptionEpoch) return;
        if (!envelopeMatchesActivityDetail(envelope, this.#activityDetail)) {
          throw new Error(
            "Thread stream returned the wrong activity detail projection.",
          );
        }
        this.#pendingEnvelopes.push(envelope);
        if (envelope.event.type === "snapshot") {
          // First-paint latency: a snapshot (initial attach, recovery
          // replacement) flushes the whole buffer immediately, preserving
          // ordering since it is the buffer's tail.
          this.#flushEnvelopes();
          return;
        }
        this.#scheduleEnvelopeFlush();
      },
      ...(this.#loadAttempt
        ? {
            loadDiagnostics: {
              onEventSourceCreated: ({ cursorAvailable }) =>
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "event_source_created",
                  { cursorAvailable },
                ),
              onResponseHeadersReceived: () =>
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "response_headers_received",
                ),
              onCheckpointParsed: ({
                eventDataCharacters,
                durationMilliseconds,
              }) => {
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "snapshot_received",
                  { eventDataCharacters },
                );
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "snapshot_json_parsed",
                  { durationMilliseconds },
                );
              },
              onEnvelopeParsed: ({
                envelope,
                eventDataCharacters,
                durationMilliseconds,
              }) => {
                if (envelope.event.type !== "snapshot") return;
                const parsedAt = performance.now();
                recordThreadLoadDiagnosticAt(
                  this.#loadAttempt,
                  "snapshot_received",
                  parsedAt - durationMilliseconds,
                  { eventDataCharacters },
                );
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "snapshot_json_parsed",
                  { durationMilliseconds },
                );
              },
              onHandshakeDiagnostic: (diagnostic) =>
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "server_handshake_timing_received",
                  {
                    requestId: diagnostic.requestId,
                    routeSetupMilliseconds: diagnostic.routeSetupMilliseconds,
                    runtimeAcquireMilliseconds:
                      diagnostic.runtimeAcquireMilliseconds,
                    requestToHeadersMilliseconds:
                      diagnostic.requestToHeadersMilliseconds,
                  },
                ),
              onServerDiagnostic: (diagnostic) =>
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "server_snapshot_timing_received",
                  {
                    handshake: diagnostic.handshake,
                    routeSetupMilliseconds: diagnostic.routeSetupMilliseconds,
                    runtimeAcquireMilliseconds:
                      diagnostic.runtimeAcquireMilliseconds,
                    requestToSnapshotWriteMilliseconds:
                      diagnostic.requestToSnapshotWriteMilliseconds,
                    snapshotCaptureMilliseconds:
                      diagnostic.snapshotCaptureMilliseconds,
                    snapshotEncodeMilliseconds:
                      diagnostic.snapshotEncodeMilliseconds,
                    snapshotSummaryMilliseconds:
                      diagnostic.snapshotSummaryMilliseconds,
                    snapshotWriteMilliseconds:
                      diagnostic.snapshotWriteMilliseconds,
                    bytes: diagnostic.snapshotFrameBytes,
                    turnCount: diagnostic.turnCount,
                    itemCount: diagnostic.itemCount,
                    largestTurnItemCount: diagnostic.largestTurnItemCount,
                  },
                ),
              onReplayDiagnostic: (diagnostic) =>
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "server_replay_outcome_received",
                  {
                    cursorSource: diagnostic.cursorSource,
                    outcome: diagnostic.outcome,
                    replayedEventCount: diagnostic.replayedEventCount,
                  },
                ),
              onLive: ({
                cursorAvailable,
                envelopeCount,
                snapshotReceived,
              }) => {
                this.#streamWasLive = true;
                const handshake = snapshotReceived
                  ? cursorAvailable
                    ? "replacement_snapshot"
                    : "initial_snapshot"
                  : envelopeCount > 0
                    ? "replay_events"
                    : "replay_caught_up";
                recordThreadLoadDiagnostic(
                  this.#loadAttempt,
                  "resume_handshake_completed",
                  {
                    handshake,
                    cursorAvailable,
                    batchSize: envelopeCount,
                  },
                );
                recordThreadLoadDiagnostic(this.#loadAttempt, "stream_live");
              },
            },
          }
        : {}),
    });
  }

  #scheduleEnvelopeFlush(): void {
    if (
      this.#envelopeFlushFrame !== undefined ||
      this.#envelopeFlushTimer !== undefined
    ) {
      return;
    }
    // While a turn streams, deltas arrive every frame or faster; flushing a
    // few times per second keeps per-flush markdown re-parse and transcript
    // element-recreation costs from saturating the main thread. Every other
    // state keeps the next-frame flush for interactivity.
    if (this.#state.snapshot?.runState === "running") {
      this.#envelopeFlushScheduledAt = performance.now();
      recordStreamingDiagnostic("stream_batch_scheduled", {
        batchSize: this.#pendingEnvelopes.length,
        runState: this.#state.snapshot.runState,
        scheduledDelayMilliseconds: STREAMING_FLUSH_INTERVAL_MS,
      });
      this.#envelopeFlushTimer = globalThis.setTimeout(() => {
        this.#envelopeFlushTimer = undefined;
        const scheduledAt = this.#envelopeFlushScheduledAt;
        this.#envelopeFlushScheduledAt = undefined;
        recordStreamingDiagnostic("stream_batch_timer_fired", {
          batchSize: this.#pendingEnvelopes.length,
          durationMilliseconds:
            scheduledAt === undefined ? null : performance.now() - scheduledAt,
          scheduledDelayMilliseconds: STREAMING_FLUSH_INTERVAL_MS,
        });
        this.#flushEnvelopes();
      }, STREAMING_FLUSH_INTERVAL_MS);
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      this.#envelopeFlushFrame = requestAnimationFrame(() => {
        this.#envelopeFlushFrame = undefined;
        this.#flushEnvelopes();
      });
      return;
    }
    this.#envelopeFlushTimer = globalThis.setTimeout(() => {
      this.#envelopeFlushTimer = undefined;
      this.#flushEnvelopes();
    }, 16);
  }

  #cancelEnvelopeFlush(): void {
    if (
      this.#envelopeFlushFrame !== undefined &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(this.#envelopeFlushFrame);
    }
    this.#envelopeFlushFrame = undefined;
    if (this.#envelopeFlushTimer !== undefined) {
      globalThis.clearTimeout(this.#envelopeFlushTimer);
      this.#envelopeFlushTimer = undefined;
    }
    this.#envelopeFlushScheduledAt = undefined;
  }

  /**
   * Applies the buffered envelopes in arrival order with a single
   * derive/notify at the end. A resnapshot_required result stops the batch
   * (the remaining envelopes target the dead projection) and resubscribes
   * once. The resubscribe backoff resets only on genuine progress — an
   * incremental applied in a batch that did not also invalidate — because a
   * poisoned projection delivers a clean anchor snapshot followed by a
   * regressing suffix every cycle.
   */
  #flushEnvelopes(): void {
    this.#cancelEnvelopeFlush();
    if (this.#disposed) {
      this.#pendingEnvelopes = [];
      return;
    }
    const batch = this.#pendingEnvelopes;
    if (batch.length === 0) return;
    this.#pendingEnvelopes = [];
    let diagnosticSnapshot: ThreadEventEnvelope | undefined;
    if (this.#loadAttempt && getDiagnosticCategoryEnabled("thread_load")) {
      for (let index = batch.length - 1; index >= 0; index -= 1) {
        if (batch[index]?.event.type === "snapshot") {
          diagnosticSnapshot = batch[index];
          break;
        }
      }
    }
    const diagnosticApplyStartedAt = diagnosticSnapshot
      ? performance.now()
      : undefined;
    // TEMPORARY DIAGNOSTIC (localStorage sedes.debug.client=1):
    // per-frame batch apply cost on large snapshots.
    const debugClient =
      typeof localStorage !== "undefined" &&
      localStorage.getItem("sedes.debug.client") === "1";
    const streamingDiagnostics = getDiagnosticCategoryEnabled("streaming");
    const batchStart =
      debugClient || streamingDiagnostics ? performance.now() : 0;
    let applied = 0;
    let madeProgress = false;
    let resnapshot: string | undefined;
    let diagnosticSnapshotApplied = false;
    this.#applyingBatch = true;
    try {
      for (const envelope of batch) {
        const result = this.normalized.apply(envelope);
        if (result.kind === "resnapshot_required") {
          resnapshot = result.reason;
          break;
        }
        if (result.kind === "applied") {
          if (envelope === diagnosticSnapshot) {
            diagnosticSnapshotApplied = true;
          }
          if (envelope.event.type === "usage_revision_changed") this.usage.invalidate(envelope.event.revision);
          if (envelope.event.type === "snapshot") this.usage.invalidate();
          if (envelope.event.type === "questions_changed") {
            this.#applyQuestionRequests(envelope.event);
          } else if (envelope.event.type === "snapshot") {
            this.#questionStatusProjectionKey = "";
            void this.loadQuestionRequests();
          }
          this.#observeCapabilityProjection(envelope);
          this.#observeComposerQueuePresentation(envelope);
          applied += 1;
          if (envelope.event.type !== "snapshot") madeProgress = true;
        }
      }
    } finally {
      this.#applyingBatch = false;
    }
    const batchApplyMilliseconds =
      debugClient || streamingDiagnostics ? performance.now() - batchStart : 0;
    if (debugClient) {
      if (batchApplyMilliseconds > 8) {
        console.warn(
          `[client-delta] batch size=${batch.length} applied=${applied} ms=${batchApplyMilliseconds.toFixed(1)}${
            resnapshot ? ` resnapshot=${resnapshot}` : ""
          }`,
        );
      }
    }
    if (applied > 0) this.#deriveNormalizedState();
    if (
      streamingDiagnostics &&
      batch.some(({ event }) => event.type === "item_upsert")
    ) {
      recordStreamingDiagnostic("stream_batch_applied", {
        applied,
        batchSize: batch.length,
        durationMilliseconds: performance.now() - batchStart,
        outcome: resnapshot ? "resnapshot_required" : "applied",
        runState: this.#state.snapshot?.runState ?? null,
      });
    }
    if (
      diagnosticSnapshot?.event.type === "snapshot" &&
      diagnosticApplyStartedAt !== undefined
    ) {
      const snapshot = diagnosticSnapshot.event.snapshot;
      recordThreadLoadDiagnostic(
        this.#loadAttempt,
        diagnosticSnapshotApplied
          ? "snapshot_store_applied"
          : "snapshot_store_rejected",
        {
          durationMilliseconds: performance.now() - diagnosticApplyStartedAt,
          batchSize: batch.length,
          applied,
          turnCount: snapshot.orderedTurnIds.length,
          itemCount: Object.keys(snapshot.itemsById).length,
          status: diagnosticSnapshotApplied ? "applied" : "rejected",
        },
      );
    }
    if (madeProgress && !resnapshot) this.#resubscribeAttempts = 0;
    if (resnapshot !== undefined) {
      recordThreadLoadDiagnostic(this.#loadAttempt, "resume_cursor_cleared", {
        reason: "replacement_required",
      });
      this.#replaceState({
        ...this.#state,
        authoritative: false,
        error: `Thread stream needs a new snapshot: ${resnapshot}`,
      });
      this.#resubscribe();
    }
  }

  #applyCheckpoint(checkpoint: ThreadCheckpoint): void {
    // Preserve arrival ordering if a recovery checkpoint supersedes a batch
    // already queued from this connection. An ignored stale checkpoint must
    // not discard that batch or change its authority.
    this.#flushEnvelopes();
    if (this.#resubscribing) return;
    const startedAt = performance.now();
    let result: NormalizedThreadApplyResult;
    this.#applyingBatch = true;
    try {
      if (
        !itemsMatchActivityDetail(
          Object.values(checkpoint.snapshot.itemsById),
          this.#activityDetail,
        )
      ) {
        throw new Error(
          "Thread checkpoint returned the wrong activity detail projection.",
        );
      }
      result = this.normalized.applyCheckpoint(checkpoint);
      if (result.kind === "applied") {
        this.usage.invalidate();
        this.#capabilityThreadRevision = this.normalized.capabilityThreadRevision;
        this.#questionStatusProjectionKey = "";
        void this.loadQuestionRequests();
        this.#observeComposerQueuePresentation({
          eventId: checkpoint.eventId,
          projectionGeneration: checkpoint.projectionGeneration,
          event: {
            type: "snapshot",
            generation: checkpoint.projectionGeneration,
            snapshot: checkpoint.snapshot,
          },
        });
      }
    } finally {
      this.#applyingBatch = false;
    }
    this.#deriveNormalizedState();
    recordThreadLoadDiagnostic(
      this.#loadAttempt,
      result.kind === "applied"
        ? "snapshot_store_applied"
        : result.kind === "ignored"
          ? "snapshot_store_ignored"
          : "snapshot_store_rejected",
      {
        durationMilliseconds: performance.now() - startedAt,
        turnCount: checkpoint.snapshot.orderedTurnIds.length,
        itemCount: Object.keys(checkpoint.snapshot.itemsById).length,
        status: result.kind === "resnapshot_required" ? "rejected" : result.kind,
      },
    );
    if (result.kind === "resnapshot_required") {
      this.#replaceState({
        ...this.#state,
        authoritative: false,
        error: `Thread checkpoint needs a new snapshot: ${result.reason}`,
      });
      this.#resubscribe();
    }
  }

  #resubscribe(): void {
    if (this.#resubscribing || this.#disposed) return;
    this.#resubscribing = true;
    // A fresh invalidation cancels any pending healthy-window reset.
    if (this.#healthyResetTimer !== undefined) {
      globalThis.clearTimeout(this.#healthyResetTimer);
      this.#healthyResetTimer = undefined;
    }
    // A poisoned server projection makes every fresh attach fail the same
    // way; exponential backoff keeps that failure mode from spinning an
    // unbounded EventSource reconnect loop.
    const attempt = this.#resubscribeAttempts;
    this.#resubscribeAttempts = Math.min(attempt + 1, 32);
    const delayMilliseconds = Math.min(250 * 2 ** attempt, 10_000);
    this.#resubscribeTimer = globalThis.setTimeout(() => {
      this.#resubscribeTimer = undefined;
      this.#resubscribing = false;
      if (!this.#disposed) {
        this.#replaceState({
          ...this.#state,
          connection: "reconnecting",
          authoritative: false,
        });
        this.#loadAttempt =
          beginThreadLoadAttempt(this.threadId, "reconnect") ??
          this.#loadAttempt;
        this.#streamWasLive = false;
        this.#subscribeToEvents();
      }
    }, delayMilliseconds);
  }

  #deriveNormalizedState(): void {
    const normalized = this.normalized.state;
    const snapshot = normalized.snapshot;
    if (snapshot) {
      this.#reconcileComposerTransfers(snapshot);
      this.#reconcilePendingQueuedSteers(snapshot);
    }
    const pendingDeliveryThreadRevision =
      this.#state.pendingDeliveryThreadRevision !== undefined &&
      (this.#pendingDeliveryBridgeKind === "pending_materialization"
        ? this.#needsPendingDeliveryBridge(
            this.#state.pendingDeliveryThreadRevision,
            snapshot,
          )
        : !snapshot ||
          snapshot.thread.threadRevision <
            this.#state.pendingDeliveryThreadRevision)
        ? this.#state.pendingDeliveryThreadRevision
        : undefined;
    if (pendingDeliveryThreadRevision === undefined) {
      this.#pendingDeliveryBridgeKind = undefined;
    }
    const {
      pendingDeliveryThreadRevision: _pendingDeliveryThreadRevision,
      ...currentState
    } = this.#state;
    this.#replaceState({
      ...currentState,
      status: snapshot ? "ready" : this.#state.status,
      error: normalized.authoritative ? undefined : this.#state.error,
      loadFailure: normalized.authoritative
        ? undefined
        : this.#state.loadFailure,
      terminalLoadError: normalized.authoritative
        ? undefined
        : this.#state.terminalLoadError,
      authoritative: normalized.authoritative,
      snapshot,
      stashes: snapshot?.stashes ?? this.#state.stashes,
      ...(pendingDeliveryThreadRevision === undefined
        ? {}
        : { pendingDeliveryThreadRevision }),
    });
  }

  #applyProtocolFailure(error: Error, terminal: boolean): void {
    recordThreadLoadDiagnostic(this.#loadAttempt, "protocol_error", {
      reason: terminal
        ? "thread_load_error_invalid"
        : "normalized_event_invalid",
    });
    // A malformed normalized envelope is reopened by the transport, while a
    // malformed terminal control frame is closed fail-safe. In either case
    // the retained normalized snapshot is hard-invalid: a replacement
    // snapshot, not a cursor-only caught-up marker, is required to restore
    // authority.
    this.normalized.requireReplacement();
    recordThreadLoadDiagnostic(this.#loadAttempt, "resume_cursor_cleared", {
      reason: "protocol_error",
    });
    this.#replaceState({
      ...this.#state,
      status: this.#state.snapshot ? "ready" : "error",
      error: error.message,
      terminalLoadError: terminal ? error.message : undefined,
      connection: "disconnected",
      authoritative: false,
    });
  }

  #reconcileComposerTransfers(snapshot: NormalizedThreadSnapshot): void {
    if (this.#state.pendingComposerTransfers.length === 0) return;
    const authoritativeItems = new Map(
      Object.entries(snapshot.itemsById).flatMap(([itemId, item]) =>
        item.kind === "user_message" && item.deliveryOperationId
          ? [[item.deliveryOperationId, itemId] as const]
          : [],
      ),
    );
    const authoritativeQueue = new Map(
      snapshot.queue.map((queued) => [queued.deliveryOperationId, queued]),
    );
    let transfers = [...this.#state.pendingComposerTransfers];

    for (const materializing of [...transfers].sort(
      (left, right) => left.presentationSequence - right.presentationSequence,
    )) {
      const itemId = authoritativeItems.get(materializing.operationId);
      if (!itemId) continue;
      transfers = transfers.map((transfer) => {
        if (
          transfer.operationId !== materializing.operationId &&
          transfer.presentation === "transcript" &&
          transfer.authorityState === "client_only" &&
          transfer.presentationSequence > materializing.presentationSequence &&
          transfer.baselineTailItemId === materializing.baselineTailItemId
        ) {
          return { ...transfer, baselineTailItemId: itemId };
        }
        if (transfer.operationId !== materializing.operationId) return transfer;
        return {
          ...transfer,
          authorityState: "materialized" as const,
          materializedItemId: itemId,
          rollbackRequired: false,
          lateMaterializationRequiresComposerReconciliation:
            transfer.lateMaterializationRequiresComposerReconciliation ||
            transfer.rollbackApplied,
        };
      });
    }

    transfers = transfers.flatMap((transfer) => {
      if (transfer.authorityState === "materialized") {
        const requestTerminal =
          transfer.requestState === "receipt_received" ||
          transfer.requestState === "request_failed";
        if (
          requestTerminal &&
          !transfer.lateMaterializationRequiresComposerReconciliation
        ) {
          return [];
        }
        return [transfer];
      }
      const queued = authoritativeQueue.get(transfer.operationId);
      if (queued) {
        transfer = this.#withResolvedDeliveryMode(
          transfer,
          queued.resolvedDeliveryMode,
        );
      }
      const currentMode = transfer.resolvedDeliveryMode ?? transfer.mode;
      if (transfer.lateMaterializationRequiresComposerReconciliation) {
        return [
          queued
            ? {
                ...transfer,
                queuedInputId: queued.id,
              }
            : transfer,
        ];
      }
      if (transfer.authorityState === "rolled_back_tombstone") {
        if (!queued || currentMode === "steer") return [transfer];
        if (!transfer.rollbackApplied) return [];
        return [
          {
            ...transfer,
            authorityState: "queue_owned" as const,
            queuedInputId: queued.id,
            rollbackRequired: false,
            lateMaterializationRequiresComposerReconciliation: true,
          },
        ];
      }

      if (queued && currentMode === "queue") {
        // The durable row is now the sole presentation and correlation
        // authority. No client transfer metadata is needed after handoff.
        return [];
      } else if (queued && currentMode === "submit") {
        if (
          queued.state === "retry_wait" ||
          queued.state === "uncertain" ||
          queued.state === "failed"
        ) {
          // Demotion is one-way because the authoritative row remains visible
          // without a client transfer that could suppress or recreate a bubble.
          return [];
        } else if (
          (queued.state === "pending" || queued.state === "dispatching") &&
          transfer.authorityState === "client_only"
        ) {
          transfer = { ...transfer, queuedInputId: queued.id };
        }
      } else if (queued && currentMode === "steer") {
        if (queued.state === "failed") {
          return [];
        }
        transfer = {
          ...transfer,
          authorityState: "queue_owned" as const,
          queuedInputId: queued.id,
          steerPhase:
            queued.state === "uncertain"
              ? ("unconfirmed" as const)
              : queued.state === "dispatching"
                ? ("steering" as const)
                : transfer.steerPhase,
        };
      }

      const requestTerminal =
        transfer.requestState === "receipt_received" ||
        transfer.requestState === "request_failed";
      const settled =
        snapshot.runState === "idle" || snapshot.runState === "failed";
      const unresolvedRecovery = snapshot.recovery !== undefined;

      if (
        currentMode === "steer" &&
        transfer.acceptanceEvidence === "none" &&
        requestTerminal &&
        settled &&
        !unresolvedRecovery &&
        transfer.steerTarget?.kind === "turn" &&
        transfer.baselineActiveTurnId !== undefined &&
        snapshot.activeTurnId !== transfer.baselineActiveTurnId &&
        snapshot.thread.threadRevision >= transfer.baselineThreadRevision
      ) {
        return [
          {
            ...transfer,
            authorityState: "rolled_back_tombstone" as const,
            rollbackRequired: true,
            retainTombstoneAfterRollback: false,
          },
        ];
      }

      return [transfer];
    });

    const unchanged =
      transfers.length === this.#state.pendingComposerTransfers.length &&
      transfers.every(
        (transfer, index) =>
          transfer === this.#state.pendingComposerTransfers[index],
      );
    if (!unchanged) this.#setPendingComposerTransfers(transfers);
  }

  #observeCapabilityProjection(envelope: ThreadEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "snapshot") {
      this.#capabilityThreadRevision = event.snapshot.thread.threadRevision;
      return;
    }
    if (event.type === "capabilities_changed") {
      this.#capabilityThreadRevision = event.threadRevision;
      return;
    }
    if (event.type === "application_state_changed") {
      this.#capabilityThreadRevision = event.state.thread.threadRevision;
    }
  }

  #observeComposerQueuePresentation(envelope: ThreadEventEnvelope): void {
    const event = envelope.event;
    const queue =
      event.type === "snapshot"
        ? event.snapshot.queue
        : event.type === "queue_changed"
          ? event.items
          : undefined;
    if (!queue || this.#state.pendingComposerTransfers.length === 0) return;
    const queueByOperationId = new Map(
      queue.map((item) => [item.deliveryOperationId, item]),
    );
    const transfers = this.#state.pendingComposerTransfers.filter(
      (transfer) => {
        const item = queueByOperationId.get(transfer.operationId);
        if (!item || transfer.authorityState !== "client_only") return true;
        const currentMode = item.resolvedDeliveryMode;
        if (currentMode === "queue") return false;
        if (
          currentMode === "submit" &&
          (item.state === "retry_wait" ||
            item.state === "uncertain" ||
            item.state === "failed")
        ) {
          return false;
        }
        if (currentMode === "steer" && item.state === "failed") return false;
        return true;
      },
    );
    if (transfers.length !== this.#state.pendingComposerTransfers.length) {
      this.#setPendingComposerTransfers(transfers);
    }
  }

  #needsPendingDeliveryBridge(
    threadRevision: number,
    snapshot = this.#state.snapshot,
  ): boolean {
    if (!snapshot || this.#capabilityThreadRevision === undefined) return true;
    if (this.#capabilityThreadRevision < threadRevision) return true;
    if (this.#capabilityThreadRevision > threadRevision) return false;
    return snapshot.capabilities.deliveryModes.some(
      ({ available }) => available,
    );
  }

  #setPendingDeliveryBridge(
    threadRevision: number,
    kind: "revision" | "pending_materialization",
  ): void {
    const needed =
      kind === "pending_materialization"
        ? this.#needsPendingDeliveryBridge(threadRevision)
        : !this.#state.snapshot ||
          this.#state.snapshot.thread.threadRevision < threadRevision;
    if (!needed) return;
    this.#pendingDeliveryBridgeKind = kind;
    this.#replaceState({
      ...this.#state,
      pendingDeliveryThreadRevision: threadRevision,
    });
  }

  #setPendingSteerPhase(operationId: string, phase: ComposerSteerPhase): void {
    const pending = this.#composerTransfer(operationId);
    // An exact transcript event may win the race with the HTTP response. In
    // that case reconciliation already removed the row and the late receipt
    // must not recreate it.
    if (
      !pending ||
      (pending.resolvedDeliveryMode ?? pending.mode) !== "steer"
    ) {
      return;
    }
    if (pending.steerPhase === phase) return;
    this.#updateComposerTransfer(operationId, { steerPhase: phase });
  }

  #composerTransfer(operationId: string): PendingComposerTransfer | undefined {
    return this.#state.pendingComposerTransfers.find(
      (transfer) => transfer.operationId === operationId,
    );
  }

  #reconcilePendingQueuedSteers(snapshot: NormalizedThreadSnapshot): void {
    if (this.#state.pendingQueuedSteers.length === 0) return;
    const materialized = new Set(
      Object.values(snapshot.itemsById).flatMap((item) =>
        item.kind === "user_message" && item.deliveryOperationId
          ? [item.deliveryOperationId]
          : [],
      ),
    );
    const queueById = new Map(snapshot.queue.map((item) => [item.id, item]));
    const pending = this.#state.pendingQueuedSteers.flatMap((steer) => {
      if (materialized.has(steer.operationId)) return [];
      const queued = queueById.get(steer.queuedInputId);
      if (!queued) {
        return steer.requestState === "request_failed" ? [] : [steer];
      }
      if (queued.deliveryOperationId !== steer.operationId) {
        return steer.requestState === "requesting" ? [steer] : [];
      }
      const phase =
        queued.state === "uncertain"
          ? ("unconfirmed" as const)
          : queued.state === "dispatching"
            ? ("steering" as const)
            : steer.phase;
      return phase === steer.phase ? [steer] : [{ ...steer, phase }];
    });
    if (
      pending.length !== this.#state.pendingQueuedSteers.length ||
      pending.some(
        (steer, index) => steer !== this.#state.pendingQueuedSteers[index],
      )
    ) {
      this.#setPendingQueuedSteers(pending);
    }
  }

  #updatePendingQueuedSteer(
    operationId: string,
    update: Partial<PendingQueuedSteer>,
  ): void {
    const index = this.#state.pendingQueuedSteers.findIndex(
      (pending) => pending.operationId === operationId,
    );
    if (index < 0) return;
    const pending = [...this.#state.pendingQueuedSteers];
    pending[index] = { ...pending[index]!, ...update };
    this.#setPendingQueuedSteers(pending);
  }

  #removePendingQueuedSteer(operationId: string): void {
    this.#setPendingQueuedSteers(
      this.#state.pendingQueuedSteers.filter(
        (pending) => pending.operationId !== operationId,
      ),
    );
  }

  #removePendingQueuedSteersForInput(queuedInputId: string): void {
    const pending = this.#state.pendingQueuedSteers.filter(
      (candidate) => candidate.queuedInputId !== queuedInputId,
    );
    if (pending.length === this.#state.pendingQueuedSteers.length) return;
    this.#setPendingQueuedSteers(pending);
  }

  #setPendingQueuedSteers(pending: readonly PendingQueuedSteer[]): void {
    this.#replaceState({ ...this.#state, pendingQueuedSteers: pending });
  }

  #liveSteerTransfer(): PendingComposerTransfer | undefined {
    return this.#state.pendingComposerTransfers.find(
      (transfer) =>
        (transfer.resolvedDeliveryMode ?? transfer.mode) === "steer" &&
        transfer.presentation === "pending_steer" &&
        transfer.authorityState === "client_only",
    );
  }

  #updateComposerTransfer(
    operationId: string,
    update: Partial<PendingComposerTransfer>,
  ): void {
    const index = this.#state.pendingComposerTransfers.findIndex(
      (transfer) => transfer.operationId === operationId,
    );
    if (index < 0) return;
    const transfers = [...this.#state.pendingComposerTransfers];
    transfers[index] = { ...transfers[index]!, ...update };
    this.#setPendingComposerTransfers(transfers);
  }

  #withResolvedDeliveryMode(
    transfer: PendingComposerTransfer,
    resolvedDeliveryMode: ComposerDeliveryMode,
  ): PendingComposerTransfer {
    const { steerPhase: priorSteerPhase, ...rest } = transfer;
    return {
      ...rest,
      resolvedDeliveryMode,
      presentation:
        resolvedDeliveryMode === "submit"
          ? "transcript"
          : resolvedDeliveryMode === "steer"
            ? "pending_steer"
            : "pending_queue",
      ...(resolvedDeliveryMode === "steer"
        ? { steerPhase: priorSteerPhase ?? ("sending" as const) }
        : {}),
    };
  }

  #applyResolvedDeliveryMode(
    operationId: string,
    resolvedDeliveryMode: ComposerDeliveryMode,
  ): void {
    const transfer = this.#composerTransfer(operationId);
    if (!transfer) return;
    this.#updateComposerTransfer(
      operationId,
      this.#withResolvedDeliveryMode(transfer, resolvedDeliveryMode),
    );
  }

  #setPendingComposerTransfers(
    transfers: readonly PendingComposerTransfer[],
  ): void {
    this.#replaceState({
      ...this.#state,
      pendingComposerTransfers: transfers,
    });
  }

  #recordComposerTransferFailure(
    operationId: string,
    ambiguous: boolean,
  ): void {
    const transfer = this.#composerTransfer(operationId);
    if (!transfer) return;
    if (
      (transfer.resolvedDeliveryMode ?? transfer.mode) !== "steer" &&
      this.#state.snapshot?.queue.some(
        (queued) => queued.deliveryOperationId === operationId,
      )
    ) {
      // Durable application admission is exact authority even when the HTTP
      // response is lost. The queue row, not composer rollback, owns recovery.
      this.abandonComposerTransfer(operationId);
      return;
    }
    if (transfer.authorityState === "materialized") {
      this.#updateComposerTransfer(operationId, {
        requestState: "request_failed",
      });
      this.#retireTerminalMaterializedTransfer(operationId);
      return;
    }
    if (
      (transfer.resolvedDeliveryMode ?? transfer.mode) === "steer" &&
      ambiguous
    ) {
      this.#updateComposerTransfer(operationId, {
        requestState: "request_failed",
        steerPhase: "unconfirmed",
      });
      if (this.#state.snapshot) {
        this.#reconcileComposerTransfers(this.#state.snapshot);
      }
      return;
    }
    this.#updateComposerTransfer(operationId, {
      requestState: "request_failed",
      authorityState: "rolled_back_tombstone",
      rollbackRequired: true,
      retainTombstoneAfterRollback: ambiguous,
    });
    if (this.#state.snapshot) {
      this.#reconcileComposerTransfers(this.#state.snapshot);
    }
  }

  #retireTerminalMaterializedTransfer(operationId: string): void {
    const transfer = this.#composerTransfer(operationId);
    if (
      !transfer ||
      transfer.authorityState !== "materialized" ||
      (transfer.requestState !== "receipt_received" &&
        transfer.requestState !== "request_failed")
    ) {
      return;
    }
    if (transfer.rollbackApplied) {
      this.#updateComposerTransfer(operationId, {
        lateMaterializationRequiresComposerReconciliation: true,
      });
      return;
    }
    this.abandonComposerTransfer(operationId);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      this.#requireSnapshot();
      this.#replaceState({
        ...this.#state,
        actionPending: true,
        actionError: undefined,
      });
      try {
        return await operation();
      } catch (error) {
        this.#replaceState({
          ...this.#state,
          actionError: messageFrom(error),
        });
        throw error;
      } finally {
        this.#replaceState({ ...this.#state, actionPending: false });
      }
    };
    const run = this.#mutationChain.then(execute, execute);
    this.#mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #queueMutation<Result>(
    operation: (
      snapshot: NormalizedThreadSnapshot,
      generation: string,
    ) => Promise<Result>,
  ): Promise<Result> {
    const execute = async () => {
      const snapshot = this.#requireSnapshot();
      const generation = this.normalized.state.generation;
      if (!generation) throw new Error("Thread projection generation missing.");
      try {
        return await operation(snapshot, generation);
      } catch (error) {
        if (error instanceof ApiError && error.code === "conflict") {
          this.normalized.requireReplacement();
          this.#deriveNormalizedState();
          this.#resubscribe();
        }
        throw error;
      }
    };
    const run = this.#mutationChain.then(execute, execute);
    this.#mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #queuedInputMutationId(requestKey: string): string {
    const existing = this.#queuedInputMutationIds.get(requestKey);
    if (existing) return existing;
    const mutationId = crypto.randomUUID();
    this.#queuedInputMutationIds.set(requestKey, mutationId);
    return mutationId;
  }

  #applyQueueMutationResult(
    generation: string,
    result: {
      readonly threadRevision: number;
      readonly queue: NormalizedThreadSnapshot["queue"];
      readonly draft?: NormalizedDraft;
    },
  ): void {
    const applied = this.normalized.applyQueueMutationProjection({
      generation,
      threadRevision: result.threadRevision,
      queue: result.queue,
      ...(result.draft ? { draft: result.draft } : {}),
    });
    if (applied.kind !== "resnapshot_required") return;
    this.#deriveNormalizedState();
    this.#replaceState({
      ...this.#state,
      authoritative: false,
      error: `Thread queue needs a new snapshot: ${applied.reason}`,
    });
    this.#resubscribe();
    throw new Error("The queue changed concurrently. Refreshing thread state.");
  }

  #setForkAttempt(sourceTurnId: string, attempt: TurnForkAttempt): void {
    this.#replaceState({
      ...this.#state,
      forkAttempts: { ...this.#state.forkAttempts, [sourceTurnId]: attempt },
    });
  }

  #clearForkAttempt(sourceTurnId: string): void {
    if (!(sourceTurnId in this.#state.forkAttempts)) return;
    const forkAttempts = { ...this.#state.forkAttempts };
    delete forkAttempts[sourceTurnId];
    this.#replaceState({ ...this.#state, forkAttempts });
  }

  #replaceState(state: ThreadClientState): void {
    // A receipt only bridges the gap to the ordinary queue/transcript projection.
    // Match typed origin before the receipt too: SSE may arrive before HTTP.
    const pendingQuestionReplies = state.pendingQuestionReplies.filter((reply) => {
      const matches = (origin: QueuedInputSummary["inputOrigin"]) =>
        origin?.kind === "question_response" &&
        origin.requestId === reply.requestId &&
        origin.answers.length === reply.answers.length &&
        origin.answers.every(({ questionIndex, answer }) =>
          reply.answers.some((candidate) =>
            candidate.questionIndex === questionIndex && candidate.answer === answer,
          ),
        );
      const operationMatches = (operationId: string | undefined) =>
        reply.deliveryOperationId !== undefined &&
        operationId === reply.deliveryOperationId;
      const queued = state.snapshot?.queue.some((item) =>
        operationMatches(item.deliveryOperationId) || matches(item.inputOrigin),
      );
      const materialized = Object.values(state.snapshot?.itemsById ?? {}).some((item) =>
        item.kind === "user_message" &&
        (operationMatches(item.deliveryOperationId) || matches(item.origin)),
      );
      return !queued && !materialized;
    });
    this.#state = pendingQuestionReplies.length === state.pendingQuestionReplies.length
      ? state : { ...state, pendingQuestionReplies };
    this.#refreshProjectedQuestionStatuses();
    for (const listener of this.#listeners) listener();
  }

  #refreshProjectedQuestionStatuses(): void {
    const sourceItemIds = [...new Set(
      Object.values(this.#state.snapshot?.itemsById ?? {}).flatMap((item) =>
        item.kind === "assistant_message" && item.nonblockingQuestions
          ? [item.nonblockingQuestions.sourceItemId] : [],
      ),
    )].sort();
    const revision = this.#state.questionRevision;
    const sourceKey = JSON.stringify(sourceItemIds);
    const key = JSON.stringify([revision, sourceItemIds]);
    if (key === this.#questionStatusProjectionKey) return;
    const forceRefresh = this.#questionStatusProjectionKey === "";
    this.#questionStatusProjectionKey = key;
    const generation = ++this.#questionStatusLoadGeneration;
    // Retain durable evidence while refreshing, but never accumulate off-page
    // entries. Pending actions remain governed by the current inbox authority.
    const projected = new Set(sourceItemIds);
    this.#state = {
      ...this.#state,
      questionStatuses: Object.fromEntries(
        Object.entries(this.#state.questionStatuses).filter(([id]) => projected.has(id)),
      ),
    };
    if (this.#questionStatusAcceptedSourceKey !== sourceKey) {
      this.#questionStatusAcceptedSourceKey = "";
    } else if (!forceRefresh && this.#questionStatusRevision >= revision) {
      // Inbox hydration can catch up to a status read that already included
      // this revision. It does not require a duplicate request.
      return;
    }
    if (sourceItemIds.length === 0 || this.#disposed) return;
    void Promise.resolve().then(async () => {
      if (this.#disposed || generation !== this.#questionStatusLoadGeneration) return;
      try {
        const statuses: Record<string, QuestionRequestStatus> = {};
        let resultRevision: number | undefined;
        for (let offset = 0; offset < sourceItemIds.length; offset += 100) {
          const batch = sourceItemIds.slice(offset, offset + 100);
          const result = await this.#api.listQuestionStatuses(this.threadId, batch);
          if (this.#disposed || generation !== this.#questionStatusLoadGeneration) return;
          if (
            result.revision < Math.max(revision, this.#questionStatusRevision) ||
            (resultRevision !== undefined && result.revision !== resultRevision)
          ) return;
          resultRevision = result.revision;
          for (const status of result.statuses) {
            if (batch.includes(status.sourceItemId)) statuses[status.sourceItemId] = status;
          }
        }
        this.#questionStatusRevision = resultRevision!;
        this.#questionStatusAcceptedSourceKey = sourceKey;
        this.#replaceState({ ...this.#state, questionStatuses: statuses });
      } catch {
        // Status decoration is optional. The inbox remains usable when this
        // read fails; the next snapshot, page, or question revision retries it.
      }
    });
  }
}

const fullActivityKinds = new Set<ConversationItem["kind"]>([
  "reasoning",
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
]);

function itemsMatchActivityDetail(
  items: readonly ConversationItem[],
  activityDetail: ActivityDetailMode,
): boolean {
  return items.every((item) =>
    activityDetail === "summary"
      ? !fullActivityKinds.has(item.kind)
      : item.kind !== "activity_summary",
  );
}

function envelopeMatchesActivityDetail(
  envelope: ThreadEventEnvelope,
  activityDetail: ActivityDetailMode,
): boolean {
  const event = envelope.event;
  if (event.type === "snapshot") {
    return itemsMatchActivityDetail(
      Object.values(event.snapshot.itemsById),
      activityDetail,
    );
  }
  if (event.type === "history_prepend") {
    return itemsMatchActivityDetail(
      Object.values(event.page.itemsById),
      activityDetail,
    );
  }
  return event.type !== "item_upsert"
    ? true
    : itemsMatchActivityDetail([event.item], activityDetail);
}

export function useThreadStore(store: ThreadClientStore): ThreadClientState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
