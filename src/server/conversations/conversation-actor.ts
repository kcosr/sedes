import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type { NonblockingQuestionsPayload } from "../../shared/protocol/questions.js";
import { hasOutstandingBackgroundActivity } from "../../shared/protocol/background-activity.js";
import type {
  BackendConversationEvent,
  BackendCapabilityDocument,
  BackendEffectiveSettings,
} from "../../shared/protocol/backend.js";
import type { NormalizedThreadEvent } from "../../shared/protocol/conversation.js";
import type {
  BackendActionResult,
  BackendMutationReconciliation,
  BackendCheckpointRef,
  BranchCheckpointSelection,
  ConversationHandle,
  EstablishedBackendProjection,
  InteractionResponseInput,
  LocateTurnResult,
  RegisteredBackendActionInput,
  SteerTurnInput,
  SteerTurnResult,
  SubmitTurnInput,
  SubmitTurnResult,
  Unsubscribe,
} from "../backends/contracts.js";
import { BackendError } from "../backends/contracts.js";
import type { UsageSnapshot } from "../../shared/protocol/conversation.js";
import type { HistoryPage } from "../../shared/protocol/conversation.js";
import type { ExecutionEnvironmentLease } from "../execution/contracts.js";
import type { ComposerAttachmentDescriptor } from "../../shared/protocol/composer-attachments.js";
import type { ComposerAttachmentDeliveryService } from "../composer-attachments/composer-attachment-delivery-service.js";
import {
  branchingAllowsSelectedCompletedTurnForSourceState,
  ConversationProjector,
  projectedThreadForkSourceCapability,
  projectedTurnForkCapability,
  type ProjectedConversationTimeline,
  type ProjectionApplication,
  type ProjectedThreadEvent,
} from "./conversation-projector.js";
import { SerializedMailbox } from "./serialized-mailbox.js";
import {
  ProjectionEventCoalescer,
  type ProjectionCoalescerOutput,
  type ProjectionEventClock,
  type ProjectionEventScheduler,
} from "./projection-event-coalescer.js";
import {
  backendDeliveryInput,
  type ApplicationSteerTurnInput,
  type ApplicationSubmitTurnInput,
} from "./delivery-input-projection.js";
import type { PrepareDeliveryInputSnapshot } from "../db/repositories/delivery-input-snapshot-repository.js";
import {
  projectAuthoritativeCompletionResult,
  projectClassifiedAssistantResult,
} from "./completion-result-projection.js";
import type { BoundedText } from "../../shared/protocol/payload.js";

export const DEFAULT_PROJECTION_UPDATE_INTERVAL_MILLISECONDS = 50;
export const DEFAULT_MAXIMUM_PENDING_PROJECTION_ITEMS = 512;
export const DEFAULT_MAXIMUM_PENDING_PROJECTION_BYTES = 16 * 1_024 * 1_024;
export const MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES = 12_800;

type AncillaryBackendEvent = Extract<
  BackendConversationEvent,
  {
    readonly type:
      | "interaction_opened"
      | "interaction_resolved"
      | "capabilities_changed"
      | "usage_changed"
      | "notice";
  }
>;

export type ConversationActorEvent =
  | {
      readonly type: "nonblocking_questions";
      readonly sourceItemId: string;
      readonly payload: NonblockingQuestionsPayload;
    }
  | {
      readonly type: "projection_replaced";
      readonly state: ConversationActorSnapshotState;
    }
  | {
      readonly type: "projection_events";
      readonly generation: string;
      readonly events: readonly NormalizedThreadEvent[];
    }
  | {
      readonly type: "backend_event";
      readonly generation: string;
      readonly event: AncillaryBackendEvent;
    }
  | {
      /**
       * Durable application observers use the backend turn identity to match
       * an accepted submission. This is not a browser projection event.
       */
      readonly type: "authoritative_completion";
      readonly backendCorrelation: string;
      readonly backendTurnId: string;
      readonly applicationTurnId: string;
      readonly completionIdentity: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly result: BoundedText;
      readonly classifiedResult: ClassifiedAssistantResult | null;
    }
  | {
      /** A backend user turn now durably carries an application submission. */
      readonly type: "authoritative_submission";
      readonly backendCorrelation: string;
      readonly backendTurnId: string;
    };

export type ConversationActorListener = (event: ConversationActorEvent) => void;

export interface ConversationActorSnapshotState {
  readonly timeline: ProjectedConversationTimeline;
  readonly backendCapabilities: BackendCapabilityDocument;
  readonly usage: UsageSnapshot;
  readonly history?: {
    readonly operational: boolean;
    /** Backend-opaque and server-internal; never send this value to a client. */
    readonly previousCursor?: string;
  };
}

export interface ConversationActorHistoryCapture {
  readonly generation: string;
  readonly page: HistoryPage;
}

export type ConversationActorLocateTurnResult =
  | {
      readonly status: "found";
      readonly page: HistoryPage;
    }
  | { readonly status: "not_found" }
  | { readonly status: "search_limit_reached" };

type ResolvedBranchCheckpointCommon = {
  readonly reference: BackendCheckpointRef;
  readonly effectiveSettings: BackendEffectiveSettings;
  readonly branching: AvailableBackendBranchingCapability;
};

export type ResolvedBranchCheckpoint = ResolvedBranchCheckpointCommon &
  (
    | {
        readonly boundaryKind: "completed_turn_inclusive";
        readonly sourceTurnId: string;
        readonly sourceTurnCompletedAt: string | null;
        readonly backendTurnId: string;
      }
    | {
        readonly boundaryKind: "provider_snapshot_at_acceptance";
        readonly sourceTurnId: null;
        readonly sourceTurnCompletedAt: null;
        readonly backendTurnId: null;
      }
  );

export type AvailableBackendBranchingCapability = Extract<
  BackendCapabilityDocument["branching"],
  { readonly availability: "available" }
>;

export type ActorBranchCheckpointSelection =
  | { readonly kind: "latest_completed" }
  | { readonly kind: "latest_provider_snapshot" }
  | {
      readonly kind: "selected_completed_turn";
      readonly turnId: string;
      readonly expectedTurnRevision: number;
    };

/**
 * The sole in-process owner of one attached backend conversation.
 *
 * Driver callbacks enter the same mailbox as user mutations, so an event can
 * never race a submit, steer, interrupt, response, or registered action.
 */
export class ConversationActor {
  readonly #handle: ConversationHandle;
  readonly #environmentLease: ExecutionEnvironmentLease;
  readonly #attachmentDelivery: ComposerAttachmentDeliveryService;
  readonly #drainAuthoritativeObservers?: () => Promise<void>;
  readonly #persistDeliveryInputSnapshot?: (
    input: PrepareDeliveryInputSnapshot,
  ) => void;
  readonly #removeDeliveryInputSnapshot?: (operationId: string) => void;
  readonly #projector: ConversationProjector;
  readonly #resolveBranchCheckpoint?: (
    selection: BranchCheckpointSelection,
  ) => Promise<BackendCheckpointRef>;
  readonly #mailbox = new SerializedMailbox();
  readonly #listeners = new Set<ConversationActorListener>();
  readonly #pendingInteractions = new Map<string, Extract<AncillaryBackendEvent, { type: "interaction_opened" }>>();
  readonly #closeListeners = new Set<() => void>();
  readonly #coalescer: ProjectionEventCoalescer;
  #unsubscribeProjection?: Unsubscribe;
  #unsubscribeHandleEvents?: Unsubscribe;
  #started = false;
  #closing = false;
  #explicitStopPending = false;
  #closed = false;
  #closePromise?: Promise<void>;
  #idleCloseAttempt?: Promise<boolean>;
  #establishmentAbort?: AbortController;
  readonly #historyAborts = new Set<AbortController>();
  #establishing = false;
  #handleCloseProven = false;
  #leaseReleaseProven = false;
  #executionCloseBegun = false;
  #executionCloseFinished = false;
  #establishmentEpoch = 0;
  #projectionRecoveryFailureSequence = 0;
  #projectionRecoveryRequired = false;
  #handleReplacementRequired = false;
  #awaitingAuthoritativeIdle = false;
  #synchronousCoalescerOutputs?: ProjectionCoalescerOutput[];
  #snapshotState?: ConversationActorSnapshotState;

  constructor(input: {
    readonly handle: ConversationHandle;
    /** Installed before establishment so durable observers cannot miss startup events. */
    readonly initialObserver?: ConversationActorListener;
    readonly environmentLease: ExecutionEnvironmentLease;
    readonly attachmentDelivery: ComposerAttachmentDeliveryService;
    readonly drainAuthoritativeObservers?: () => Promise<void>;
    readonly persistDeliveryInputSnapshot?: (
      input: PrepareDeliveryInputSnapshot,
    ) => void;
    readonly removeDeliveryInputSnapshot?: (operationId: string) => void;
    readonly projector: ConversationProjector;
    readonly resolveBranchCheckpoint?: (
      selection: BranchCheckpointSelection,
    ) => Promise<BackendCheckpointRef>;
    readonly projectionClock?: ProjectionEventClock;
    readonly projectionScheduler?: ProjectionEventScheduler;
    readonly projectionUpdateIntervalMilliseconds?: number;
    readonly maximumPendingProjectionItems?: number;
    readonly maximumPendingProjectionBytes?: number;
  }) {
    this.#handle = input.handle;
    if (input.initialObserver) this.#listeners.add(input.initialObserver);
    this.#environmentLease = input.environmentLease;
    this.#attachmentDelivery = input.attachmentDelivery;
    this.#drainAuthoritativeObservers = input.drainAuthoritativeObservers;
    this.#persistDeliveryInputSnapshot = input.persistDeliveryInputSnapshot;
    this.#removeDeliveryInputSnapshot = input.removeDeliveryInputSnapshot;
    this.#projector = input.projector;
    this.#resolveBranchCheckpoint = input.resolveBranchCheckpoint;
    this.#coalescer = new ProjectionEventCoalescer({
      intervalMilliseconds:
        input.projectionUpdateIntervalMilliseconds ??
        DEFAULT_PROJECTION_UPDATE_INTERVAL_MILLISECONDS,
      maximumPendingItems:
        input.maximumPendingProjectionItems ??
        DEFAULT_MAXIMUM_PENDING_PROJECTION_ITEMS,
      maximumPendingBytes:
        input.maximumPendingProjectionBytes ??
        DEFAULT_MAXIMUM_PENDING_PROJECTION_BYTES,
      ...(input.projectionClock ? { clock: input.projectionClock } : {}),
      ...(input.projectionScheduler
        ? { scheduler: input.projectionScheduler }
        : {}),
      emit: (output) => this.#enqueueCoalescerOutput(output),
    });
  }

  async start(input: { readonly signal: AbortSignal }): Promise<void> {
    if (this.#started || this.#closing || this.#closed) {
      throw new Error("conversation_actor_start_state_invalid");
    }
    this.#started = true;
    this.#unsubscribeHandleEvents = this.#handle.subscribe((event) => {
      if (
        event.type === "resnapshot_required" &&
        event.reason === "provider_handle_closed"
      ) {
        // Projection replacement deliberately detaches its sequenced
        // subscriber before capturing a new baseline. Keep irreversible
        // handle closure observable through the independent raw event rail.
        this.#handleReplacementRequired = true;
        this.#establishmentAbort?.abort(
          new Error("conversation_actor_handle_replacement_required"),
        );
      }
    });
    await this.#mailbox.enqueue(() => this.#establishProjection(input.signal));
  }

  get timeline(): ProjectedConversationTimeline {
    if (!this.#started || this.#closed) {
      throw new Error("conversation_actor_projection_unavailable");
    }
    return this.#projector.timeline();
  }

  /** Main-turn readiness is independent of background work and cleanup safety. */
  get authoritativelySettled(): boolean {
    if (!this.#started || this.#closing || this.#closed || this.#handleReplacementRequired) return false;
    const state = this.#projector.timeline().runState;
    return !this.#awaitingAuthoritativeIdle && (state === "idle" || state === "failed");
  }

  get canEvict(): boolean {
    if (!this.#started || this.#closing || this.#closed) return false;
    if (this.#handleReplacementRequired) return true;
    const timeline = this.#projector.timeline();
    return (
      !this.#awaitingAuthoritativeIdle &&
      !this.#handle.retirementBlocked &&
      !hasOutstandingBackgroundActivity(timeline.backgroundActivity) &&
      (timeline.runState === "idle" || timeline.runState === "failed")
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  get replacementSafe(): boolean {
    return this.#handleCloseProven && this.#leaseReleaseProven;
  }

  get replacementRequired(): boolean {
    return this.#handleReplacementRequired;
  }

  subscribe(listener: ConversationActorListener): Unsubscribe {
    if (!this.#started || this.#closing || this.#closed) {
      throw new Error("conversation_actor_subscription_unavailable");
    }
    this.#listeners.add(listener);
    try {
      if (!this.#snapshotState) {
        throw new Error("conversation_actor_snapshot_state_unavailable");
      }
      listener({
        type: "projection_replaced",
        state: this.#snapshotState,
      });
      this.#publishSnapshotSubmissions(listener);
      this.#publishSnapshotCompletions(listener);
      for (const event of this.#pendingInteractions.values()) {
        listener({ type: "backend_event", generation: this.#snapshotState.timeline.generation, event });
      }
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onClosed(listener: () => void): Unsubscribe {
    if (this.#closed) {
      listener();
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  history(
    input: Parameters<ConversationHandle["history"]>[0],
  ): Promise<ConversationActorHistoryCapture> {
    const cancellation = new AbortController();
    this.#historyAborts.add(cancellation);
    const signal = input.signal
      ? AbortSignal.any([input.signal, cancellation.signal])
      : cancellation.signal;
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      if (!this.#snapshotState) {
        throw new Error("conversation_actor_snapshot_state_unavailable");
      }
      return {
        generation: this.#projector.timeline().generation,
        page: this.#projector.projectHistoryPage(
          await this.#handle.history({
            ...input,
            signal,
          }),
          {
            branching: this.#snapshotState.backendCapabilities.branching,
            sourceRunState: this.#projector.timeline().runState,
          },
        ),
      };
    }).finally(() => {
      this.#historyAborts.delete(cancellation);
    });
  }

  locateTurn(input: {
    readonly targetTurnId: string;
    readonly maximumTurnCandidates?: number;
    readonly signal?: AbortSignal;
  }): Promise<ConversationActorLocateTurnResult> {
    const cancellation = new AbortController();
    this.#historyAborts.add(cancellation);
    const signal = input.signal
      ? AbortSignal.any([input.signal, cancellation.signal])
      : cancellation.signal;
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      if (!this.#snapshotState) {
        throw new Error("conversation_actor_snapshot_state_unavailable");
      }
      const result = await this.#locateBackendTurn({
        targetTurnId: input.targetTurnId,
        maximumTurnCandidates:
          input.maximumTurnCandidates ??
          MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES,
        signal,
      });
      if (result.status !== "found") return result;
      return {
        status: "found" as const,
        page: this.#projector.projectHistoryPage(result.page, {
          branching: this.#snapshotState.backendCapabilities.branching,
          sourceRunState: this.#projector.timeline().runState,
        }),
      };
    }).finally(() => {
      this.#historyAborts.delete(cancellation);
    });
  }

  backendCapabilities(): Promise<BackendCapabilityDocument> {
    return this.#enqueue(() => this.#handle.backendCapabilities());
  }

  usage(): Promise<UsageSnapshot> {
    return this.#enqueue(() => this.#handle.usage());
  }

  captureSubmissionRetryAnchor(): Promise<string> {
    return this.#enqueue(() => this.#handle.captureSubmissionRetryAnchor());
  }

  replayAuthoritativeCompletions(): Promise<void> {
    return this.#enqueue(() => this.#publishSnapshotCompletions());
  }

  ensureProjectionCurrent(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#handleReplacementRequired) {
        throw new Error("conversation_actor_handle_replacement_required");
      }
      if (this.#projectionRecoveryRequired) {
        await this.#recoverProjection();
      }
      if (this.#handleReplacementRequired) {
        throw new Error("conversation_actor_handle_replacement_required");
      }
    });
  }

  reconcileSubmissionNotAccepted(
    applicationOperationId: string,
  ): Promise<void> {
    return this.#enqueue(() => {
      try {
        this.#removeDeliveryInputSnapshot?.(applicationOperationId);
      } finally {
        this.#awaitingAuthoritativeIdle = false;
      }
    });
  }

  resolveBranchCheckpoint(
    selection: ActorBranchCheckpointSelection,
  ): Promise<ResolvedBranchCheckpoint> {
    return this.#enqueue(() =>
      this.#resolveBranchCheckpointInMailbox(selection),
    );
  }

  withBranchCheckpoint<T>(
    selection: ActorBranchCheckpointSelection,
    operation: (checkpoint: ResolvedBranchCheckpoint) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () =>
      operation(await this.#resolveBranchCheckpointInMailbox(selection)),
    );
  }

  withBranchExecution<T>(
    boundaryKind:
      "completed_turn_inclusive" | "provider_snapshot_at_acceptance",
    operation: (branching: AvailableBackendBranchingCapability) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () => {
      const branching = this.#snapshotState?.backendCapabilities.branching;
      if (!branching || branching.availability !== "available") {
        throw new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage:
            branching?.availability === "unavailable"
              ? branching.reason.text
              : "This conversation cannot be branched.",
        });
      }
      const snapshotBoundary =
        boundaryKind === "provider_snapshot_at_acceptance";
      const boundarySupported = snapshotBoundary
        ? branching.boundaries.includes("latest_provider_snapshot")
        : branching.boundaries.some(
            (boundary) =>
              boundary === "latest_completed" ||
              boundary === "selected_completed_turn",
          );
      if (!boundarySupported) {
        throw new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: snapshotBoundary
            ? "This backend cannot resume a latest-provider-snapshot fork."
            : "This backend cannot resume a completed-turn fork.",
        });
      }
      const sourceRunState = this.#projector.timeline().runState;
      if (
        (this.#awaitingAuthoritativeIdle &&
          (branching.sourceMustBeIdle ||
            (snapshotBoundary &&
              (sourceRunState === "idle" || sourceRunState === "failed")))) ||
        !branchingAllowsSelectedCompletedTurnForSourceState({
          branching,
          sourceRunState,
        })
      ) {
        throw new BackendError({
          category: "invalid_state",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage:
            "The conversation must be authoritatively idle before it can be branched.",
        });
      }
      return operation(branching);
    });
  }

  async #resolveBranchCheckpointInMailbox(
    selection: ActorBranchCheckpointSelection,
  ): Promise<ResolvedBranchCheckpoint> {
    if (!this.#resolveBranchCheckpoint) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "This conversation cannot be branched.",
      });
    }
    const branching = this.#snapshotState?.backendCapabilities.branching;
    if (
      !branching ||
      branching.availability !== "available" ||
      (selection.kind === "selected_completed_turn"
        ? !branching.boundaries.includes("selected_completed_turn")
        : selection.kind === "latest_provider_snapshot"
          ? !branching.boundaries.includes("latest_provider_snapshot")
          : !branching.boundaries.includes("latest_completed"))
    ) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage:
          branching?.availability === "unavailable"
            ? branching.reason.text
            : selection.kind === "selected_completed_turn"
              ? "This backend cannot fork a selected completed turn."
              : selection.kind === "latest_provider_snapshot"
                ? "This backend cannot fork its latest provider snapshot."
                : "This backend cannot fork its latest completed turn.",
      });
    }
    const sourceRunState = this.#projector.timeline().runState;
    if (
      selection.kind === "latest_completed"
        ? this.#awaitingAuthoritativeIdle ||
          (sourceRunState !== "idle" && sourceRunState !== "failed")
        : (this.#awaitingAuthoritativeIdle &&
            (branching.sourceMustBeIdle ||
              (selection.kind === "latest_provider_snapshot" &&
                (sourceRunState === "idle" || sourceRunState === "failed")))) ||
          !branchingAllowsSelectedCompletedTurnForSourceState({
            branching,
            sourceRunState,
          })
    ) {
      throw new BackendError({
        category: "invalid_state",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage:
          selection.kind === "latest_completed"
            ? "The conversation must be authoritatively idle before its latest completed turn can be branched."
            : selection.kind === "latest_provider_snapshot"
              ? "The conversation must have an authoritative active or idle state before its latest provider snapshot can be branched."
              : "The conversation must be authoritatively idle before it can be branched.",
      });
    }
    if (selection.kind === "latest_provider_snapshot") {
      const reference = await this.#resolveBranchCheckpoint({
        kind: "latest_provider_snapshot",
      });
      return {
        reference,
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceTurnId: null,
        sourceTurnCompletedAt: null,
        backendTurnId: null,
        effectiveSettings: {
          ...(this.#snapshotState?.backendCapabilities.effectiveSettings ?? {}),
        },
        branching,
      };
    }
    const selectedInput =
      selection.kind === "selected_completed_turn"
        ? selection
        : (() => {
            const timeline = this.#projector.timeline();
            const turnId = timeline.orderedTurnIds.findLast((candidate) => {
              const turn = timeline.turnsById[candidate];
              return (
                turn?.status === "completed" && turn.endedBy === "agent_settled"
              );
            });
            const turn = turnId ? timeline.turnsById[turnId] : undefined;
            return turnId && turn
              ? { turnId, expectedTurnRevision: turn.revision }
              : undefined;
          })();
    if (
      !selectedInput?.turnId ||
      !Number.isSafeInteger(selectedInput.expectedTurnRevision) ||
      selectedInput.expectedTurnRevision < 0
    ) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "The selected completed turn is invalid.",
      });
    }
    const resolved = await this.#resolveSelectedTurn(selectedInput);
    const reference = await this.#resolveBranchCheckpoint(
      selection.kind === "selected_completed_turn"
        ? {
            kind: "selected_completed_turn",
            backendTurnId: resolved.backendTurnId,
            boundary: "completed_turn_inclusive",
          }
        : { kind: "latest_completed" },
    );
    return {
      reference,
      boundaryKind: "completed_turn_inclusive",
      sourceTurnId: resolved.canonicalTurnId,
      sourceTurnCompletedAt: resolved.turn.completedAt ?? null,
      backendTurnId: resolved.backendTurnId,
      effectiveSettings: {
        ...(this.#snapshotState?.backendCapabilities.effectiveSettings ?? {}),
      },
      branching,
    };
  }

  async #resolveSelectedTurn(input: {
    readonly turnId: string;
    readonly expectedTurnRevision: number;
  }) {
    const current = this.#projector.resolveCurrentTurn(input.turnId);
    if (current) {
      this.#assertBranchableTurn(current.turn, input.expectedTurnRevision);
      return current;
    }
    if (!this.#snapshotState?.history?.operational) {
      throw new BackendError({
        category: "unavailable",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "This backend does not expose older normalized history.",
      });
    }
    const located = await this.#locateBackendTurn({
      targetTurnId: input.turnId,
      maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES,
    });
    if (located.status === "found") {
      const resolved = this.#projector.resolveHistoryTurn(
        located.page,
        input.turnId,
      );
      if (!resolved) {
        throw new Error("backend_targeted_history_turn_reference_missing");
      }
      this.#assertBranchableTurn(resolved.turn, input.expectedTurnRevision);
      return resolved;
    }
    if (located.status === "search_limit_reached") {
      throw new BackendError({
        category: "unavailable",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage:
          "The selected turn is deeper than the bounded source search.",
      });
    }
    throw new BackendError({
      category: "not_found",
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage: "The selected completed turn was not found.",
    });
  }

  async #locateBackendTurn(input: {
    readonly targetTurnId: string;
    readonly maximumTurnCandidates: number;
    readonly signal?: AbortSignal;
  }): Promise<LocateTurnResult> {
    if (
      !Number.isSafeInteger(input.maximumTurnCandidates) ||
      input.maximumTurnCandidates <= 0
    ) {
      throw new Error("conversation_actor_turn_lookup_limit_invalid");
    }
    const result = await this.#handle.locateTurn({
      matchesBackendTurnId: (backendTurnId) =>
        this.#projector.matchesApplicationTurnId(
          backendTurnId,
          input.targetTurnId,
        ),
      maximumTurnCandidates: input.maximumTurnCandidates,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.status !== "found") return result;
    if (
      result.page.previousCursor !== undefined ||
      result.page.orderedBackendTurnIds.length !== 1 ||
      !this.#projector.matchesApplicationTurnId(
        result.page.orderedBackendTurnIds[0]!,
        input.targetTurnId,
      )
    ) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "The backend returned an invalid targeted history result.",
      });
    }
    return result;
  }

  #assertBranchableTurn(
    turn: {
      readonly status: string;
      readonly endedBy?: string;
      readonly revision: number;
    },
    expectedRevision: number,
  ): void {
    if (turn.revision !== expectedRevision) {
      throw new BackendError({
        category: "invalid_state",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage: "The selected turn changed before it could be forked.",
      });
    }
    if (turn.status !== "completed" || turn.endedBy !== "agent_settled") {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "Only a successfully completed turn can be forked.",
      });
    }
  }

  /**
   * Returns the backend-derived snapshot state maintained by the exclusive
   * actor. Projection, capability, and usage events update this state in the
   * same mailbox, so an authoritative publication must not reread the backend
   * or rebuild history merely to capture an already-current state.
   */
  captureSnapshotState(): Promise<ConversationActorSnapshotState> {
    return this.#enqueue(() => {
      if (!this.#snapshotState) {
        throw new Error("conversation_actor_snapshot_state_unavailable");
      }
      return this.#snapshotState;
    });
  }

  /**
   * Returns the last established actor state without entering the actor
   * mailbox or attempting projection recovery. Application-owned overlay
   * publication merges this cached value with the latest thread hub snapshot
   * after its local capture; it must never make a provider read merely to
   * publish a draft, queue, inventory, or settings change.
   */
  peekSnapshotState(): ConversationActorSnapshotState | undefined {
    return this.#snapshotState;
  }

  /**
   * Runs an application-owned mutation in the same mailbox as turn-starting
   * backend mutations, but only while the authoritative actor is settled.
   * This closes the check/write gap for durable next-turn state without
   * coupling the actor to a specific application feature.
   */
  runIfIdle<T>(
    operation: () => T | Promise<T>,
  ): Promise<
    | { readonly executed: false }
    | { readonly executed: true; readonly value: T }
  > {
    return this.#enqueue(async () => {
      const runState = this.#projector.timeline().runState;
      if (
        this.#awaitingAuthoritativeIdle ||
        (runState !== "idle" && runState !== "failed")
      ) {
        return { executed: false };
      }
      return { executed: true, value: await operation() };
    });
  }

  submit(input: ApplicationSubmitTurnInput): Promise<SubmitTurnResult> {
    return this.#runStartingMutation(() =>
      this.#deliverPreparedInput(input, (prepared) =>
        this.#handle.submit(prepared),
      ),
    );
  }

  materializeAttachments(
    attachments: readonly ComposerAttachmentDescriptor[],
    signal?: AbortSignal,
  ) {
    if (attachments.length === 0) {
      return Promise.resolve({
        attachments: [],
        canonicalBytes: {
          read: async () => {
            throw new BackendError({
              category: "invalid_state",
              retryable: false,
              crossedSubmissionBoundary: false,
              safeMessage: "No attachment is authorized for this delivery.",
            });
          },
        },
        canonicalEvidence: { resolve: () => [] },
      });
    }
    return this.#attachmentDelivery.materialize(
      this.#environmentLease.scope,
      this.#handle.binding.applicationThreadId,
      this.#environmentLease,
      attachments,
      signal,
    );
  }

  steer(input: ApplicationSteerTurnInput): Promise<SteerTurnResult> {
    return this.#runStartingMutation(async () => {
      const capabilities = await this.#handle.backendCapabilities();
      if (
        !capabilities.deliveryModes.includes("steer") ||
        capabilities.steerTarget !== input.target.kind
      ) {
        throw new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "This backend does not support the requested steering target.",
        });
      }
      let target = input.target;
      if (target.kind === "turn") {
        const timeline = this.#projector.timeline();
        if (
          timeline.runState !== "running" ||
          timeline.activeTurnId !== target.turnId
        ) {
          throw new BackendError({
            category: "invalid_state",
            retryable: false,
            crossedSubmissionBoundary: false,
            safeMessage: "The active turn changed before steering.",
          });
        }
        const backendTurnId = this.#projector.backendTurnId(target.turnId);
        if (!backendTurnId) {
          throw new BackendError({
            category: "invalid_state",
            retryable: false,
            crossedSubmissionBoundary: false,
            safeMessage: "The steering target is no longer available.",
          });
        }
        target = { kind: "turn", turnId: backendTurnId };
      }
      const result = await this.#deliverPreparedInput(
        { ...input, target },
        (prepared) => this.#handle.steer(prepared),
      );
      if (target.kind === "turn" && result.backendTurnId !== target.turnId) {
        throw new BackendError({
          category: "internal",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "The backend acknowledged Steer for an unexpected turn.",
        });
      }
      return result;
    });
  }

  interrupt(input: {
    readonly applicationOperationId: string;
    readonly expectedActiveTurnId: string;
  }): Promise<void> {
    return this.#enqueue(() => {
      const timeline = this.#projector.timeline();
      if (
        timeline.activeTurnId !== input.expectedActiveTurnId ||
        (timeline.runState !== "running" &&
          timeline.runState !== "waiting_for_approval" &&
          timeline.runState !== "waiting_for_input")
      ) {
        throw new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "The active turn changed before interrupt.",
        });
      }
      const expectedBackendTurnId = this.#projector.backendTurnId(
        input.expectedActiveTurnId,
      );
      if (!expectedBackendTurnId) {
        throw new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "The interrupt target is no longer available.",
        });
      }
      return this.#handle.interrupt({
        applicationOperationId: input.applicationOperationId,
        expectedBackendTurnId,
      });
    });
  }

  async interruptForInteractionFailure(
    applicationOperationId: string,
  ): Promise<void> {
    const activeTurnId = this.timeline.activeTurnId;
    if (!activeTurnId) return;
    try {
      await this.interrupt({
        applicationOperationId,
        expectedActiveTurnId: activeTurnId,
      });
    } catch {
      // A failed provider cancellation is not proof that the unseen prompt
      // disappeared. Closing is the existing terminal runtime fail-closed
      // path; it releases the provider handle and execution-environment lease.
      await this.close();
    }
  }

  reconcileInterrupt(input: {
    readonly applicationOperationId: string;
    readonly expectedActiveTurnId: string;
  }): Promise<BackendMutationReconciliation> {
    return this.#enqueue(() => {
      const expectedBackendTurnId = this.#projector.backendTurnId(
        input.expectedActiveTurnId,
      );
      if (!expectedBackendTurnId) return { outcome: "unknown" };
      return this.#handle.reconcileInterrupt({
        applicationOperationId: input.applicationOperationId,
        expectedBackendTurnId,
      });
    });
  }

  perform(input: RegisteredBackendActionInput): Promise<BackendActionResult> {
    return input.action === "compact"
      ? this.#runStartingMutation(() => this.#handle.perform(input))
      : this.#enqueue(() => this.#handle.perform(input));
  }

  mutateProviderFeature(input: {
    readonly featureId: string;
    readonly schemaVersion: number;
    readonly actionId: string;
    readonly arguments: unknown;
  }): Promise<{
    readonly outcome: "accepted" | "uncertain" | "rejected";
    readonly projectedState?: unknown;
    readonly safeMessage?: string;
  }> {
    return this.#enqueue(async () => {
      if (!this.#handle.mutateProviderFeature) {
        return {
          outcome: "rejected" as const,
          safeMessage:
            "This conversation does not support durable provider features.",
        };
      }
      return this.#handle.mutateProviderFeature(input);
    });
  }

  reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    return this.#enqueue(() => this.#handle.reconcileAction(input));
  }

  respond(input: InteractionResponseInput): Promise<void> {
    return this.#runStartingMutation(() => this.#handle.respond(input));
  }

  reconcileInteractionResponse(
    input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    return this.#enqueue(() =>
      this.#handle.reconcileInteractionResponse(input),
    );
  }

  close(beforeCleanup?: Promise<void>): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#explicitStopPending = beforeCleanup !== undefined;
    this.#establishmentAbort?.abort();
    this.#abortHistoryReads("conversation_actor_history_cancelled_by_close");
    this.#closePromise = (async () => {
      // Operator Stop first fences callers, then lets the scoped provider
      // control use its confirmed observation before detachment changes it.
      if (beforeCleanup) await beforeCleanup;
      if (this.#idleCloseAttempt) {
        const closed = await this.#idleCloseAttempt;
        if (closed) return;
      }
      const failures: unknown[] = [];
      try {
        await this.#mailbox.enqueue(async () => {
          await this.#closeResources(failures);
        });
      } catch (error) {
        failures.push(error);
      } finally {
        await this.#mailbox.close();
        this.#listeners.clear();
        this.#closed = true;
        this.#publishClosed();
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Conversation actor resources did not close cleanly.",
        );
      }
    })();
    return this.#closePromise;
  }

  async closeIfCurrent(
    expected: Pick<
      ProjectedConversationTimeline,
      "generation" | "runState" | "activeTurnId"
    >,
  ): Promise<boolean> {
    if (this.#closed || this.#closing || this.#closePromise) return false;
    return this.#closeConditionally(() => {
      const current = this.timeline;
      return (
        current.generation === expected.generation &&
        current.runState === expected.runState &&
        current.activeTurnId === expected.activeTurnId
      );
    });
  }

  async closeIfIdle(): Promise<boolean> {
    return this.#closeConditionally(() => this.canEvict, true);
  }

  async #closeConditionally(predicate: () => boolean, evicted = false): Promise<boolean> {
    if (this.#closePromise) {
      await this.#closePromise;
      return true;
    }
    if (this.#closing || this.#closed) return this.#closed;
    if (this.#idleCloseAttempt) {
      await this.#idleCloseAttempt;
      if (this.#closed) return false;
    }
    if (this.canEvict && this.#establishing) {
      this.#establishmentAbort?.abort();
    }
    this.#idleCloseAttempt = (async () => {
      const failures: unknown[] = [];
      const claimed = await this.#mailbox.enqueue(async () => {
        if (this.#closing || !predicate()) return false;
        this.#closing = true;
        this.#establishmentAbort?.abort();
        this.#abortHistoryReads("conversation_actor_history_cancelled_by_close");
        await this.#closeResources(failures, evicted);
        return true;
      });
      if (!claimed) return false;
      await this.#mailbox.close();
      this.#listeners.clear();
      this.#closed = true;
      this.#publishClosed();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Conversation actor resources did not close cleanly.",
        );
      }
      return true;
    })();
    try {
      return await this.#idleCloseAttempt;
    } finally {
      if (!this.#closed) this.#idleCloseAttempt = undefined;
    }
  }

  #publishClosed(): void {
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Runtime ownership observers cannot make resource closure fail.
      }
    }
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.#started || this.#closing || this.#closed) {
      return Promise.reject(
        new Error("conversation_actor_operation_unavailable"),
      );
    }
    return this.#mailbox.enqueue(() => {
      if (this.#explicitStopPending) throw new Error("conversation_actor_operation_unavailable");
      return operation();
    });
  }

  async #establishProjection(externalSignal?: AbortSignal): Promise<void> {
    if (this.#handleReplacementRequired) {
      throw new Error("conversation_actor_handle_replacement_required");
    }
    this.#establishmentEpoch += 1;
    const epoch = this.#establishmentEpoch;
    this.#establishmentAbort?.abort();
    const controller = new AbortController();
    this.#establishmentAbort = controller;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const previousSubscription = this.#unsubscribeProjection;
    this.#unsubscribeProjection = undefined;
    previousSubscription?.();
    this.#establishing = true;
    let established: EstablishedBackendProjection;
    try {
      established = await this.#handle.establishProjection({ signal });
    } finally {
      if (this.#establishmentAbort === controller) {
        this.#establishing = false;
      }
    }
    if (this.#handleReplacementRequired) {
      throw new Error("conversation_actor_handle_replacement_required");
    }
    // Each established handle projection replays its authoritative pending
    // interactions. Retire the previous view before accepting that replay.
    this.#pendingInteractions.clear();
    const timeline = this.#projector.replace(
      established.snapshot,
      established.handleSequence,
    );
    this.#projectionRecoveryRequired = false;
    if (timeline.runState === "idle" || timeline.runState === "failed") {
      this.#awaitingAuthoritativeIdle = false;
    }
    this.#coalescer.reset(timeline);
    this.#unsubscribeProjection = this.#subscribeEstablished(
      established,
      epoch,
    );
    const backendCapabilities = await this.#handle.backendCapabilities();
    const state = {
      timeline,
      backendCapabilities,
      usage: await this.#handle.usage(),
      history:
        backendCapabilities.supportsHistory && established.history.operational
          ? {
              operational: true as const,
              ...(established.history.previousCursor
                ? { previousCursor: established.history.previousCursor }
                : {}),
            }
          : { operational: false as const },
    };
    this.#snapshotState = state;
    this.#publish({ type: "projection_replaced", state });
    this.#publishSnapshotSubmissions();
    this.#publishSnapshotCompletions();
  }

  #subscribeEstablished(
    established: EstablishedBackendProjection,
    epoch: number,
  ): Unsubscribe {
    return established.subscribeFromNext((event) => {
      if (this.#closing || this.#closed) return;
      void this.#mailbox
        .enqueue(async () => {
          if (epoch !== this.#establishmentEpoch) return;
          const application = this.#projector.apply(event);
          await this.#applyProjection(application);
          if (application.kind === "resnapshot_required") {
            // The replacement snapshot is the sole authority after a rejected
            // event. Snapshot replay publishes any submission/completion that
            // actually survived recovery.
            return;
          }
          if (
            event.event.type === "turn_started" ||
            event.event.type === "turn_updated" ||
            event.event.type === "turn_completed"
          ) {
            for (const backendCorrelation of event.event.turn
              .completionCorrelations ?? []) {
              this.#publish({
                type: "authoritative_submission",
                backendCorrelation,
                backendTurnId: event.event.turn.backendTurnId,
              });
            }
          }
          if (event.event.type === "turn_completed") {
            if (event.event.turn.status === "in_progress") return;
            const completion = this.#completionResult(
              event.event.turn.backendTurnId,
            );
            const correlations = event.event.turn.completionCorrelations ?? [
              event.event.turn.backendTurnId,
            ];
            for (const backendCorrelation of correlations) {
              this.#publish({
                type: "authoritative_completion",
                backendCorrelation,
                backendTurnId: event.event.turn.backendTurnId,
                applicationTurnId: completion.applicationTurnId,
                completionIdentity: `${event.event.turn.backendTurnId}:${event.event.turn.status}`,
                outcome: event.event.turn.status,
                result: completion.result,
                classifiedResult: completion.classifiedResult,
              });
            }
          }
        })
        .catch(() => {
          // A failed actor operation is surfaced by the next authoritative
          // request. Driver callbacks must never create unhandled rejections.
        });
    });
  }

  #publishSnapshotCompletions(listener?: ConversationActorListener): void {
    for (const backendTurn of this.#projector.backendTurns()) {
      if (
        !backendTurn.completionCorrelations ||
        (backendTurn.status !== "completed" &&
          backendTurn.status !== "interrupted" &&
          backendTurn.status !== "failed")
      ) {
        continue;
      }
      const completion = this.#completionResult(backendTurn.backendTurnId);
      for (const backendCorrelation of backendTurn.completionCorrelations) {
        const event: ConversationActorEvent = {
          type: "authoritative_completion",
          backendCorrelation,
          backendTurnId: backendTurn.backendTurnId,
          applicationTurnId: completion.applicationTurnId,
          completionIdentity: `${backendTurn.backendTurnId}:${backendTurn.status}`,
          outcome: backendTurn.status,
          result: completion.result,
          classifiedResult: completion.classifiedResult,
        };
        if (listener) {
          listener(event);
        } else {
          this.#publish(event);
        }
      }
    }
  }

  #completionResult(backendTurnId: string): {
    readonly applicationTurnId: string;
    readonly result: BoundedText;
    readonly classifiedResult: ClassifiedAssistantResult;
  } {
    return {
      ...projectAuthoritativeCompletionResult({
        backendTurnId,
        timeline: this.#projector.timeline(),
        matchesApplicationTurnId: (candidateBackendTurnId, applicationTurnId) =>
          this.#projector.matchesApplicationTurnId(
            candidateBackendTurnId,
            applicationTurnId,
          ),
      }),
      classifiedResult: projectClassifiedAssistantResult(
        this.#projector.assistantItemsForTurn(backendTurnId),
      ),
    };
  }

  #publishSnapshotSubmissions(listener?: ConversationActorListener): void {
    for (const backendTurn of this.#projector.backendTurns()) {
      for (const backendCorrelation of backendTurn.completionCorrelations ??
        []) {
        const event: ConversationActorEvent = {
          type: "authoritative_submission",
          backendCorrelation,
          backendTurnId: backendTurn.backendTurnId,
        };
        if (listener) listener(event);
        else this.#publish(event);
      }
    }
  }

  async #applyProjection(application: ProjectionApplication): Promise<void> {
    if (application.kind === "resnapshot_required") {
      await this.#recoverProjection();
      return;
    }
    const generation = this.#projector.timeline().generation;
    if (application.kind === "events") {
      const runStateChanged = application.events.some(
        (event) => event.type === "run_state",
      );
      if (this.#snapshotState) {
        this.#snapshotState = {
          ...this.#snapshotState,
          timeline: this.#projector.timeline(),
        };
      }
      const outputs: ProjectionCoalescerOutput[] = [];
      this.#synchronousCoalescerOutputs = outputs;
      try {
        for (const event of application.events) {
          if (
            event.type === "item_upsert" &&
            event.item.kind === "assistant_message" &&
            event.item.nonblockingQuestions &&
            this.#snapshotState?.backendCapabilities.nonblockingQuestions
          ) {
            this.#publish({
              type: "nonblocking_questions",
              sourceItemId: event.item.nonblockingQuestions.sourceItemId,
              payload: { questions: event.item.nonblockingQuestions.questions },
            });
          }
          this.#coalescer.accept(this.#withTurnForkCapability(event));
          if (
            event.type === "run_state" &&
            (event.state === "idle" || event.state === "failed")
          ) {
            this.#awaitingAuthoritativeIdle = false;
          }
        }
        if (runStateChanged && this.#snapshotState) {
          this.#coalescer.accept({
            type: "fork_source_state_changed",
            generation,
            forkSource: projectedThreadForkSourceCapability({
              branching: this.#snapshotState.backendCapabilities.branching,
              sourceRunState: this.#projector.timeline().runState,
            }),
          });
        }
      } finally {
        this.#synchronousCoalescerOutputs = undefined;
      }
      for (const output of outputs) {
        await this.#applyCoalescerOutput(output);
      }
      if (runStateChanged && this.#snapshotState) {
        // Application operation availability is composed from run state and
        // backend capabilities. Follow the incremental run-state event with a
        // capability refresh; the bridge composes the application capability
        // document from this exact actor generation.
        this.#publish({
          type: "backend_event",
          generation,
          event: {
            type: "capabilities_changed",
            capabilities: this.#snapshotState.backendCapabilities,
          },
        });
      }
      return;
    }
    if (application.event.type === "interaction_opened") {
      this.#pendingInteractions.set(application.event.interaction.backendInteractionId, application.event);
    } else if (application.event.type === "interaction_resolved") {
      this.#pendingInteractions.delete(application.event.backendInteractionId);
    }
    if (this.#snapshotState) {
      if (application.event.type === "capabilities_changed") {
        this.#snapshotState = {
          ...this.#snapshotState,
          backendCapabilities: application.event.capabilities,
        };
        this.#publish({
          type: "projection_events",
          generation,
          events: [
            {
              type: "fork_source_state_changed",
              generation,
              forkSource: projectedThreadForkSourceCapability({
                branching: application.event.capabilities.branching,
                sourceRunState: this.#projector.timeline().runState,
              }),
            },
          ],
        });
        // Browser capabilities are a composition of backend and
        // application-owned state. Forward the backend capability change so
        // the bridge can publish one targeted application document from this
        // exact actor generation.
        this.#publish({
          type: "backend_event",
          generation,
          event: application.event,
        });
        return;
      } else if (application.event.type === "usage_changed") {
        this.#snapshotState = {
          ...this.#snapshotState,
          usage: application.event.usage,
        };
      }
    }
    this.#publish({
      type: "backend_event",
      generation,
      event: application.event,
    });
  }

  #withTurnForkCapability(event: ProjectedThreadEvent): NormalizedThreadEvent {
    if (event.type !== "turn_upsert") return event;
    const branching = this.#snapshotState?.backendCapabilities.branching;
    if (!branching) {
      throw new Error("conversation_actor_branching_capability_unavailable");
    }
    return {
      ...event,
      fork: projectedTurnForkCapability({
        turn: event.turn,
        branching,
        sourceRunState: this.#projector.timeline().runState,
      }),
    };
  }

  #enqueueCoalescerOutput(output: ProjectionCoalescerOutput): void {
    if (this.#closing || this.#closed) return;
    if (this.#synchronousCoalescerOutputs) {
      this.#synchronousCoalescerOutputs.push(output);
      return;
    }
    void this.#mailbox
      .enqueue(() => this.#applyCoalescerOutput(output))
      .catch(() => {
        // The actor will be re-established or closed by its owner.
      });
  }

  async #applyCoalescerOutput(
    output: ProjectionCoalescerOutput,
  ): Promise<void> {
    const outputGeneration =
      output.kind === "event" ? output.event.generation : output.generation;
    if (outputGeneration !== this.#projector.timeline().generation) return;
    if (output.kind === "resnapshot_required") {
      await this.#recoverProjection();
      return;
    }
    this.#publish({
      type: "projection_events",
      generation: output.event.generation,
      events: [output.event],
    });
  }

  async #recoverProjection(): Promise<void> {
    if (this.#handleReplacementRequired) {
      this.#failProjectionRecovery(
        new Error("conversation_actor_handle_replacement_required"),
      );
    }
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#establishProjection();
        return;
      } catch (error) {
        failure = error;
        if (this.#closing || this.#closed) throw error;
        await Promise.resolve();
      }
    }
    this.#failProjectionRecovery(failure);
  }

  #failProjectionRecovery(failure: unknown): never {
    if (!this.#projectionRecoveryRequired) {
      this.#projectionRecoveryFailureSequence += 1;
      this.#publish({
        type: "backend_event",
        generation: this.#projector.timeline().generation,
        event: {
          type: "notice",
          notice: {
            id: `projection-recovery-failed-${this.#projectionRecoveryFailureSequence}`,
            tone: "error",
            message: {
              text: "Conversation synchronization failed. Reopen the thread to retry.",
            },
            createdAt: new Date().toISOString(),
          },
        },
      });
    }
    this.#projectionRecoveryRequired = true;
    throw failure;
  }

  #runStartingMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.#abortHistoryReads("conversation_actor_history_preempted_by_mutation");
    return this.#enqueue(async () => {
      this.#awaitingAuthoritativeIdle = true;
      try {
        return await operation();
      } catch (error) {
        if (error instanceof BackendError && !error.crossedSubmissionBoundary) {
          this.#awaitingAuthoritativeIdle = false;
        }
        throw error;
      }
    });
  }

  #abortHistoryReads(reason: string): void {
    for (const cancellation of this.#historyAborts) {
      cancellation.abort(new Error(reason));
    }
  }

  #prepareDeliveryInput(input: ApplicationSubmitTurnInput): SubmitTurnInput;
  #prepareDeliveryInput(input: ApplicationSteerTurnInput): SteerTurnInput;
  #prepareDeliveryInput(
    input: ApplicationSubmitTurnInput | ApplicationSteerTurnInput,
  ): SubmitTurnInput | SteerTurnInput {
    if (!this.#persistDeliveryInputSnapshot) {
      return "source" in input
        ? backendDeliveryInput(input)
        : backendDeliveryInput(input);
    }
    try {
      const deliveryInput =
        "source" in input
          ? backendDeliveryInput(input)
          : backendDeliveryInput(input);
      const attachmentEvidence = input.attachmentEvidence?.resolve() ?? [];
      if (attachmentEvidence.length !== input.attachments.length) {
        throw new Error("canonical_attachment_evidence_unavailable");
      }
      this.#persistDeliveryInputSnapshot({
        applicationOperationId: input.applicationOperationId,
        text: input.text,
        selectedSkillId: input.selectedSkillId ?? null,
        contextExcerpts: input.contextExcerpts,
        taskContexts: input.taskContexts,
        attachments: attachmentEvidence.map(({ sha256, ...descriptor }) => ({
          descriptor,
          sha256,
        })),
        ...(!("inputOrigin" in input) || input.inputOrigin === undefined
          ? {}
          : { origin: input.inputOrigin }),
        createdAt: Date.now(),
      });
      return deliveryInput;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        {
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "The application delivery input could not be prepared.",
        },
        { cause: error },
      );
    }
  }

  #deliverPreparedInput<R>(
    input: ApplicationSubmitTurnInput,
    deliver: (prepared: SubmitTurnInput) => Promise<R>,
  ): Promise<R>;
  #deliverPreparedInput<R>(
    input: ApplicationSteerTurnInput,
    deliver: (prepared: SteerTurnInput) => Promise<R>,
  ): Promise<R>;
  async #deliverPreparedInput<R>(
    input: ApplicationSubmitTurnInput | ApplicationSteerTurnInput,
    deliver:
      | ((prepared: SubmitTurnInput) => Promise<R>)
      | ((prepared: SteerTurnInput) => Promise<R>),
  ): Promise<R> {
    const prepared =
      "source" in input
        ? this.#prepareDeliveryInput(input)
        : this.#prepareDeliveryInput(input);
    try {
      return await (
        deliver as (prepared: SubmitTurnInput | SteerTurnInput) => Promise<R>
      )(prepared);
    } catch (error) {
      if (error instanceof BackendError && !error.crossedSubmissionBoundary) {
        try {
          this.#removeDeliveryInputSnapshot?.(input.applicationOperationId);
        } catch {
          // Preserve the authoritative provider classification. A tolerable
          // orphan snapshot is safer than breaking Steer-to-queue demotion.
        }
      }
      throw error;
    }
  }

  async #closeResources(failures: unknown[], evicted = false): Promise<void> {
    if (!this.#executionCloseBegun) {
      this.#executionCloseBegun = true;
    }
    try {
      await this.#drainAuthoritativeObservers?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#unsubscribeProjection?.();
    } catch (error) {
      failures.push(error);
    } finally {
      this.#unsubscribeProjection = undefined;
    }
    try {
      this.#unsubscribeHandleEvents?.();
    } catch (error) {
      failures.push(error);
    } finally {
      this.#unsubscribeHandleEvents = undefined;
    }
    try {
      this.#coalescer.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#handle.close(evicted ? { reason: "evicted" } : undefined);
      this.#handleCloseProven = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#environmentLease.release();
      this.#leaseReleaseProven = true;
    } catch (error) {
      failures.push(error);
    }
    if (!this.#executionCloseFinished) {
      this.#executionCloseFinished = true;
    }
  }

  #publish(event: ConversationActorEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // One browser subscriber cannot poison the conversation actor.
      }
    }
  }
}
