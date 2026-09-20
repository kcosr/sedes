import {
  backendConversationEventSchema,
  backendConversationSnapshotSchema,
  type BackendConversationEvent,
  type BackendConversationSnapshot,
  type BackendItem,
  type BackendTurn,
  type SequencedBackendEvent,
} from "../../../shared/protocol/backend.js";
import type { OperationPhase } from "../../../shared/protocol/payload.js";
import {
  BackendError,
  type BackendEventListener,
  type EstablishedBackendProjection,
  type Unsubscribe,
} from "../contracts.js";

export interface PiProjectionEstablisherOptions {
  readonly initialSnapshot: BackendConversationSnapshot;
  readonly initialHistory: EstablishedBackendProjection["history"];
  readonly refreshProjection: () => {
    readonly snapshot: BackendConversationSnapshot;
    readonly history: EstablishedBackendProjection["history"];
  };
  readonly maximumBufferedEvents?: number;
}

const terminalStatuses = new Set<BackendItem["status"]>([
  "completed",
  "failed",
  "interrupted",
]);

const phaseRanks: Readonly<Record<OperationPhase, number>> = {
  arguments_streaming: 0,
  arguments_complete: 1,
  preflight_or_executing: 2,
  result_streaming: 3,
  completed: 4,
  failed: 4,
  interrupted: 4,
};

function operationPhase(item: BackendItem): OperationPhase | undefined {
  return "phase" in item ? item.phase : undefined;
}

function itemCanAdvance(existing: BackendItem, next: BackendItem): boolean {
  if (
    existing.backendTurnId !== next.backendTurnId ||
    existing.semanticKind !== next.semanticKind ||
    existing.sourceOrder !== next.sourceOrder ||
    existing.startedAt !== next.startedAt
  ) {
    return false;
  }
  if (
    terminalStatuses.has(existing.status) &&
    existing.status !== next.status
  ) {
    return false;
  }
  const existingPhase = operationPhase(existing);
  const nextPhase = operationPhase(next);
  if (existingPhase === undefined || nextPhase === undefined) {
    return existingPhase === nextPhase;
  }
  return phaseRanks[nextPhase] >= phaseRanks[existingPhase];
}

function mergeTurn(existing: BackendTurn, next: BackendTurn): BackendTurn {
  if (
    existing.backendTurnId !== next.backendTurnId ||
    existing.startedAt !== next.startedAt ||
    (existing.status !== "in_progress" && existing.status !== next.status)
  ) {
    throw new Error("pi_projection_turn_identity_changed");
  }
  const orderedBackendItemIds = [...existing.orderedBackendItemIds];
  for (const id of next.orderedBackendItemIds) {
    if (!orderedBackendItemIds.includes(id)) orderedBackendItemIds.push(id);
  }
  const completionCorrelations = [...(existing.completionCorrelations ?? [])];
  for (const correlation of next.completionCorrelations ?? []) {
    if (!completionCorrelations.includes(correlation)) {
      completionCorrelations.push(correlation);
    }
  }
  return {
    ...next,
    orderedBackendItemIds,
    ...(completionCorrelations.length > 0 ? { completionCorrelations } : {}),
  };
}

/**
 * One attached Pi handle owns one in-memory normalized generation at a time.
 * Persisted history seeds it once and ordinary SDK observations advance it as
 * deltas. A deliberate refresh closes that generation to later deltas; the
 * next establishment synchronously imports one new persisted baseline.
 */
export class PiProjectionEstablisher {
  readonly #maximumBufferedEvents: number;
  readonly #events: SequencedBackendEvent[] = [];
  readonly #refreshProjection: PiProjectionEstablisherOptions["refreshProjection"];
  #history: EstablishedBackendProjection["history"];
  #snapshot: BackendConversationSnapshot;
  #listener?: BackendEventListener;
  #subscriptionClaimed = false;
  #nextSequence = 0;
  #refreshRequired = false;
  #closed = false;

  constructor(options: PiProjectionEstablisherOptions) {
    this.#snapshot = structuredClone(
      backendConversationSnapshotSchema.parse(options.initialSnapshot),
    );
    this.#history = structuredClone(options.initialHistory);
    this.#refreshProjection = options.refreshProjection;
    this.#maximumBufferedEvents = options.maximumBufferedEvents ?? 512;
    if (
      !Number.isSafeInteger(this.#maximumBufferedEvents) ||
      this.#maximumBufferedEvents <= 0
    ) {
      throw new Error("pi_projection_establisher_options_invalid");
    }
  }

  snapshot(): BackendConversationSnapshot {
    this.#assertOpen();
    return structuredClone(this.#snapshot);
  }

  publish(input: BackendConversationEvent): void {
    if (this.#closed || this.#refreshRequired) return;
    const parsed = backendConversationEventSchema.parse(input);
    let event = parsed;
    if (parsed.type === "resnapshot_required") {
      this.#refreshRequired = true;
    } else {
      const priorSnapshot = structuredClone(this.#snapshot);
      try {
        this.#apply(parsed);
      } catch {
        this.#snapshot = priorSnapshot;
        this.#refreshRequired = true;
        event = {
          type: "resnapshot_required",
          reason: "contradictory_state",
        };
      }
    }
    if (this.#nextSequence >= Number.MAX_SAFE_INTEGER) {
      this.#refreshRequired = true;
      event = { type: "resnapshot_required", reason: "buffer_overflow" };
    }
    const sequenced = {
      handleSequence: this.#nextSequence,
      event,
    } satisfies SequencedBackendEvent;
    this.#nextSequence += 1;
    this.#events.push(sequenced);
    if (this.#events.length > this.#maximumBufferedEvents) {
      this.#events.shift();
    }
    const listener = this.#listener;
    if (listener) listener(sequenced);
  }

  async establishProjection(input: {
    readonly signal: AbortSignal;
  }): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    if (input.signal.aborted) throw this.#abortError();
    if (this.#subscriptionClaimed || this.#listener) {
      throw this.#error(
        "invalid_state",
        false,
        "The Pi projection already has an active event subscriber.",
        "pi_projection_subscriber_state",
      );
    }
    if (this.#refreshRequired) {
      const refreshed = this.#refreshProjection();
      this.#snapshot = structuredClone(
        backendConversationSnapshotSchema.parse(refreshed.snapshot),
      );
      this.#history = structuredClone(refreshed.history);
      this.#refreshRequired = false;
    }
    const handleSequence = this.#nextSequence - 1;
    const snapshot = this.snapshot();
    return {
      handleSequence,
      snapshot,
      history: structuredClone(this.#history),
      subscribeFromNext: (listener) =>
        this.#subscribeFrom(handleSequence, listener),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listener = undefined;
    this.#events.length = 0;
  }

  #subscribeFrom(
    handleSequence: number,
    listener: BackendEventListener,
  ): Unsubscribe {
    this.#assertOpen();
    if (this.#subscriptionClaimed || this.#listener) {
      throw this.#error(
        "invalid_state",
        false,
        "The Pi projection already has an active event subscriber.",
        "pi_projection_subscriber_state",
      );
    }
    this.#subscriptionClaimed = true;
    this.#listener = listener;
    const firstAvailable =
      this.#events[0]?.handleSequence ?? this.#nextSequence;
    if (firstAvailable > handleSequence + 1) {
      listener({
        handleSequence: handleSequence + 1,
        event: { type: "resnapshot_required", reason: "buffer_overflow" },
      });
    } else {
      for (const event of this.#events) {
        if (event.handleSequence > handleSequence) listener(event);
      }
    }
    return () => {
      if (this.#listener !== listener) return;
      this.#listener = undefined;
      this.#subscriptionClaimed = false;
    };
  }

  #apply(event: BackendConversationEvent): void {
    if (event.type === "run_state_changed") {
      if (
        event.activeBackendTurnId &&
        !this.#snapshot.turnsById[event.activeBackendTurnId]
      ) {
        throw new Error("pi_projection_active_turn_missing");
      }
      this.#snapshot.runState = event.state;
      if (event.activeBackendTurnId) {
        this.#snapshot.activeBackendTurnId = event.activeBackendTurnId;
      } else {
        delete this.#snapshot.activeBackendTurnId;
      }
    } else if (
      event.type === "turn_started" ||
      event.type === "turn_updated" ||
      event.type === "turn_completed"
    ) {
      const existing = this.#snapshot.turnsById[event.turn.backendTurnId];
      this.#snapshot.turnsById[event.turn.backendTurnId] = existing
        ? mergeTurn(existing, event.turn)
        : event.turn;
      if (
        !this.#snapshot.orderedBackendTurnIds.includes(event.turn.backendTurnId)
      ) {
        this.#snapshot.orderedBackendTurnIds.push(event.turn.backendTurnId);
      }
    } else if (
      event.type === "item_started" ||
      event.type === "item_updated" ||
      event.type === "item_completed"
    ) {
      const turn = this.#snapshot.turnsById[event.item.backendTurnId];
      if (!turn) throw new Error("pi_projection_item_turn_missing");
      const existing = this.#snapshot.itemsById[event.item.backendItemId];
      if (existing && !itemCanAdvance(existing, event.item)) {
        throw new Error("pi_projection_item_identity_changed");
      }
      this.#snapshot.itemsById[event.item.backendItemId] = event.item;
      if (!turn.orderedBackendItemIds.includes(event.item.backendItemId)) {
        const ids = [...turn.orderedBackendItemIds, event.item.backendItemId];
        ids.sort((leftId, rightId) => {
          const left = this.#snapshot.itemsById[leftId];
          const right = this.#snapshot.itemsById[rightId];
          return (
            (left?.sourceOrder ?? 0) - (right?.sourceOrder ?? 0) ||
            leftId.localeCompare(rightId)
          );
        });
        this.#snapshot.turnsById[event.item.backendTurnId] = {
          ...turn,
          orderedBackendItemIds: ids,
        };
      }
    }
    backendConversationSnapshotSchema.parse(this.#snapshot);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#error(
        "unavailable",
        true,
        "The Pi conversation projection was closed.",
        "pi_projection_closed",
      );
    }
  }

  #abortError(): BackendError {
    return this.#error(
      "unavailable",
      true,
      "Pi projection establishment was cancelled.",
      "pi_projection_cancelled",
    );
  }

  #error(
    category: "invalid_state" | "unavailable",
    retryable: boolean,
    safeMessage: string,
    backendCode: string,
  ): BackendError {
    return new BackendError({
      category,
      retryable,
      crossedSubmissionBoundary: false,
      safeMessage,
      backendCode,
    });
  }
}
