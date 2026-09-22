import {
  MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  MAXIMUM_NORMALIZED_TIMELINE_TURNS,
  normalizedThreadEventSchema,
  threadCheckpointSchema,
  threadEventEnvelopeSchema,
  type NormalizedThreadEvent,
  type ThreadEventEnvelope,
  type NormalizedThreadSnapshot,
  type ThreadForkSourceCapability,
  type ThreadCheckpoint,
  type RuntimeNotice,
} from "../../shared/protocol/conversation.js";
import {
  EventHub,
  type EventHubOptions,
  type EventSubscription,
  type SequencedEvent,
} from "./event-hub.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../shared/protocol/payload.js";

export interface ThreadEventSubscription {
  readonly watermark: number;
  readonly replay: readonly ThreadEventEnvelope[];
  close(): void;
}

export interface ThreadCheckpointSubscription extends ThreadEventSubscription {
  readonly checkpoint: ThreadCheckpoint | undefined;
}

function envelope(
  event: SequencedEvent<NormalizedThreadEvent>,
): ThreadEventEnvelope {
  return threadEventEnvelopeSchema.parse({
    eventId: event.id,
    projectionGeneration: event.data.generation,
    event: event.data,
  });
}

/**
 * Validated normalized thread publication boundary.
 *
 * The first event for every projection generation must be a complete snapshot.
 * Transport IDs remain owned by EventHub and are embedded into the browser
 * envelope rather than being confused with projection generations.
 */
export class ThreadEventHub {
  readonly #hub: EventHub<NormalizedThreadEvent>;
  readonly #subscriberCountListeners = new Set<(count: number) => void>();
  #internalSubscriberCount = 0;
  #projectionGeneration?: string;
  #snapshot?: NormalizedThreadSnapshot;
  #checkpoint?: ThreadCheckpoint;
  #notices: readonly RuntimeNotice[] = [];
  #capabilityThreadRevision = 0;
  #capabilityRunState: NormalizedThreadSnapshot["runState"] = "idle";

  constructor(options: EventHubOptions = {}) {
    this.#hub = new EventHub({
      ...options,
      supersedesReplay: (type) => type === "snapshot",
    });
  }

  get transportGeneration(): string {
    return this.#hub.generation;
  }

  get watermark(): number {
    return this.#hub.watermark;
  }

  get subscriberCount(): number {
    return Math.max(
      0,
      this.#hub.subscriberCount - this.#internalSubscriberCount,
    );
  }

  get retainedEventCount(): number {
    return this.#hub.retainedEventCount;
  }

  get retainedBytes(): number {
    return this.#hub.retainedBytes;
  }

  get projectionGeneration(): string | undefined {
    return this.#projectionGeneration;
  }

  get snapshot(): NormalizedThreadSnapshot | undefined {
    return this.#snapshot;
  }

  get threadSummary(): NormalizedThreadSnapshot["thread"] | undefined {
    return this.#snapshot?.thread;
  }

  eventIdAt(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("thread_event_sequence_invalid");
    }
    return `${this.#hub.generation}.${sequence}`;
  }

  sequenceOf(eventId: string): number | undefined {
    const prefix = `${this.#hub.generation}.`;
    if (!eventId.startsWith(prefix)) return undefined;
    const rawSequence = eventId.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(rawSequence)) return undefined;
    const sequence = Number(rawSequence);
    return Number.isSafeInteger(sequence) &&
      sequence >= 0 &&
      sequence <= this.#hub.watermark
      ? sequence
      : undefined;
  }

  publish(rawEvent: NormalizedThreadEvent): ThreadEventEnvelope {
    const event = normalizedThreadEventSchema.parse(rawEvent);
    if (event.type === "snapshot") {
      this.#projectionGeneration = event.generation;
      this.#snapshot = event.snapshot;
      this.#notices = [];
      this.#capabilityThreadRevision = event.snapshot.thread.threadRevision;
      this.#capabilityRunState = event.snapshot.capabilities.runState;
    } else if (event.generation !== this.#projectionGeneration) {
      throw new Error("thread_projection_snapshot_required");
    } else {
      if (
        event.type === "capabilities_changed" &&
        event.threadRevision < this.#capabilityThreadRevision
      ) {
        throw new Error("thread_projection_thread_revision_regressed");
      }
      this.#snapshot = applyIncremental(this.#snapshot, event);
      if (event.type === "capabilities_changed")
        this.#capabilityThreadRevision = event.threadRevision;
      if (event.type === "application_state_changed")
        this.#capabilityThreadRevision = event.state.thread.threadRevision;
      if (event.type === "capabilities_changed")
        this.#capabilityRunState = event.capabilities.runState;
      if (event.type === "application_state_changed")
        this.#capabilityRunState = event.state.capabilities.runState;
      if (event.type === "notice")
        this.#notices = [...this.#notices, event.notice].slice(-100);
    }
    this.#checkpoint = undefined;
    const published = envelope(this.#hub.publish(event.type, event));
    return published;
  }

  subscribe(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription = this.#subscribe(listener, lastEventId);
    this.#notifySubscriberCountChanged();
    let closed = false;
    return {
      watermark: subscription.watermark,
      replay: subscription.replay,
      close: () => {
        if (closed) return;
        closed = true;
        subscription.close();
        this.#notifySubscriberCountChanged();
      },
    };
  }

  /** Process-local observers do not own or keep a backend runtime alive. */
  subscribeInternal(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription = this.#subscribe(listener, lastEventId);
    this.#internalSubscriberCount += 1;
    let closed = false;
    return {
      watermark: subscription.watermark,
      replay: subscription.replay,
      close: () => {
        if (closed) return;
        closed = true;
        this.#internalSubscriberCount = Math.max(
          0,
          this.#internalSubscriberCount - 1,
        );
        subscription.close();
      },
    };
  }

  onSubscriberCountChanged(listener: (count: number) => void): () => void {
    this.#subscriberCountListeners.add(listener);
    return () => this.#subscriberCountListeners.delete(listener);
  }

  #subscribe(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription: EventSubscription<NormalizedThreadEvent> =
      this.#hub.subscribe((event) => listener(envelope(event)), lastEventId);
    try {
      return {
        watermark: subscription.watermark,
        replay: subscription.replay.map(envelope),
        close: () => subscription.close(),
      };
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  #notifySubscriberCountChanged(): void {
    const count = this.subscriberCount;
    for (const listener of [...this.#subscriberCountListeners]) {
      try {
        listener(count);
      } catch {
        // Runtime retention observers cannot interrupt stream ownership.
      }
    }
  }

  /** Captures only already-published state; never reads or publishes provider state. */
  currentCheckpoint(): ThreadCheckpoint | undefined {
    if (!this.#snapshot || !this.#projectionGeneration) return undefined;
    this.#checkpoint ??= threadCheckpointSchema.parse({
      eventId: this.eventIdAt(this.watermark),
      projectionGeneration: this.#projectionGeneration,
      snapshot: this.#snapshot,
      notices: this.#notices,
      capabilityThreadRevision: this.#capabilityThreadRevision,
      capabilityRunState: this.#capabilityRunState,
    });
    return this.#checkpoint;
  }

  /** Capture and subscribe before retention callbacks can publish newer events. */
  subscribeFromCurrentSnapshot(
    listener: (event: ThreadEventEnvelope) => void,
  ): ThreadCheckpointSubscription {
    const checkpoint = this.currentCheckpoint();
    const subscription = this.subscribe(listener);
    return {
      ...subscription,
      checkpoint,
    };
  }

  canReplay(lastEventId: string | undefined): boolean {
    return this.#hub.canReplay(lastEventId);
  }

  replayBytesAfter(lastEventId: string | undefined): number | undefined {
    return this.#hub.replayBytesAfter(lastEventId);
  }

  replayCostExceeds(
    lastEventId: string,
    budget: number,
    cost: (event: ThreadEventEnvelope) => number,
  ): boolean | undefined {
    return this.#hub.replayCostExceeds(lastEventId, budget, (event) =>
      cost({
        eventId: event.id,
        projectionGeneration: event.data.generation,
        event: event.data,
      }),
    );
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Entity revisions are monotonic within one projection generation (the
 * projector bumps a revision on every change and emits nothing for identical
 * content). A regression — or different content at the same revision — is
 * therefore only possible when two publication streams interleave into one
 * hub, which would poison the retained replay suffix for every future
 * attach. Fail closed so the publisher's recovery path replaces the
 * projection instead of retaining a corrupted history.
 */
function assertRevisionMonotonic(
  prior: { readonly revision: number } | undefined,
  next: { readonly revision: number },
  regressedCode: string,
  conflictCode: string,
): void {
  if (!prior) return;
  if (next.revision < prior.revision) throw new Error(regressedCode);
  if (next.revision === prior.revision && !sameValue(prior, next)) {
    throw new Error(conflictCode);
  }
}

function assertThreadSummaryMonotonic(
  prior: NormalizedThreadSnapshot["thread"],
  next: NormalizedThreadSnapshot["thread"],
): void {
  if (
    next.inventoryRevision < prior.inventoryRevision ||
    next.threadRevision < prior.threadRevision
  ) {
    throw new Error("thread_projection_thread_revision_regressed");
  }
}

function assertProviderFeatureProjectionMonotonic(
  prior: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
  next: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
): void {
  for (const capability of next.capabilities.providerFeatures) {
    const priorCapability = prior.capabilities.providerFeatures.find(
      ({ ref }) =>
        ref.featureId === capability.ref.featureId &&
        ref.schemaVersion === capability.ref.schemaVersion,
    );
    if (!priorCapability) continue;
    if (capability.revision < priorCapability.revision) {
      throw new Error("thread_projection_provider_feature_revision_regressed");
    }
    if (capability.revision !== priorCapability.revision) continue;
    const stateFor = (
      projection: Pick<
        NormalizedThreadSnapshot,
        "capabilities" | "providerFeatures"
      >,
    ) =>
      projection.providerFeatures.find(
        ({ ref }) =>
          ref.featureId === capability.ref.featureId &&
          ref.schemaVersion === capability.ref.schemaVersion,
      );
    if (
      !sameProviderFeatureRevisionProjection(
        priorCapability,
        capability,
        stateFor(prior),
        stateFor(next),
      )
    ) {
      throw new Error("thread_projection_provider_feature_revision_conflict");
    }
  }
}

function sameProviderFeatureRevisionProjection(
  priorCapability: NormalizedThreadSnapshot["capabilities"]["providerFeatures"][number],
  nextCapability: NormalizedThreadSnapshot["capabilities"]["providerFeatures"][number],
  priorState: NormalizedThreadSnapshot["providerFeatures"][number] | undefined,
  nextState: NormalizedThreadSnapshot["providerFeatures"][number] | undefined,
): boolean {
  if (!sameValue(priorState, nextState)) return false;
  if (sameValue(priorCapability, nextCapability)) return true;
  if (
    priorCapability.availability === "unavailable" ||
    nextCapability.availability === "unavailable"
  ) {
    return false;
  }
  const {
    availability: _priorAvailability,
    unavailableReason: _priorReason,
    operations: priorOperations,
    ...priorProviderCapability
  } = priorCapability;
  const {
    availability: _nextAvailability,
    unavailableReason: _nextReason,
    operations: nextOperations,
    ...nextProviderCapability
  } = nextCapability;
  if (!sameValue(priorProviderCapability, nextProviderCapability)) return false;
  if (!sameOperationProjection(priorOperations, nextOperations)) return false;
  return (
    priorCapability.availability !== nextCapability.availability ||
    sameValue(
      priorCapability.unavailableReason,
      nextCapability.unavailableReason,
    )
  );
}

function sameOperationProjection(
  prior: readonly unknown[],
  next: readonly unknown[],
): boolean {
  if (sameValue(prior, next)) return true;
  if (prior.length === 0 || next.length === 0) return false;
  const orderedSubset = (
    subset: readonly unknown[],
    superset: readonly unknown[],
  ): boolean => {
    let subsetIndex = 0;
    for (const operation of superset) {
      if (sameValue(subset[subsetIndex], operation)) subsetIndex += 1;
    }
    return subsetIndex === subset.length;
  };
  return orderedSubset(prior, next) || orderedSubset(next, prior);
}

function applyIncremental(
  snapshot: NormalizedThreadSnapshot | undefined,
  event: Exclude<NormalizedThreadEvent, { readonly type: "snapshot" }>,
): NormalizedThreadSnapshot {
  if (!snapshot) throw new Error("thread_projection_snapshot_required");
  let next: NormalizedThreadSnapshot;
  switch (event.type) {
    case "history_prepend": {
      if (
        event.page.orderedTurnIds.some((turnId) =>
          Object.hasOwn(snapshot.turnsById, turnId),
        ) ||
        Object.keys(event.page.itemsById).some((itemId) =>
          Object.hasOwn(snapshot.itemsById, itemId),
        )
      ) {
        throw new Error("thread_projection_history_overlap");
      }
      const forksByTurnId = {
        ...forkCapabilities(event.page.turnsById, snapshot.forkSource),
        ...snapshot.forksByTurnId,
      };
      next = {
        ...snapshot,
        orderedTurnIds: [
          ...event.page.orderedTurnIds,
          ...snapshot.orderedTurnIds,
        ],
        turnsById: { ...event.page.turnsById, ...snapshot.turnsById },
        forksByTurnId,
        itemsById: { ...event.page.itemsById, ...snapshot.itemsById },
        history: event.page.previousCursor
          ? { hasOlder: true, olderCursor: event.page.previousCursor }
          : { hasOlder: false },
      };
      if (
        next.orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
        Object.keys(next.itemsById).length >
          MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
        serializedUtf8Bytes(next) > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
      ) {
        throw new Error("thread_projection_history_limit_exceeded");
      }
      break;
    }
    case "turn_upsert":
      assertRevisionMonotonic(
        snapshot.turnsById[event.turn.id],
        event.turn,
        "thread_projection_turn_revision_regressed",
        "thread_projection_turn_revision_conflict",
      );
      next = {
        ...snapshot,
        orderedTurnIds: Object.hasOwn(snapshot.turnsById, event.turn.id)
          ? snapshot.orderedTurnIds
          : [...snapshot.orderedTurnIds, event.turn.id],
        turnsById: { ...snapshot.turnsById, [event.turn.id]: event.turn },
        forksByTurnId: {
          ...snapshot.forksByTurnId,
          [event.turn.id]: clampTurnFork(event.fork, snapshot.forkSource),
        },
      };
      break;
    case "fork_source_state_changed":
      next = {
        ...snapshot,
        forkSource: event.forkSource,
        forksByTurnId: forkCapabilities(snapshot.turnsById, event.forkSource),
      };
      break;
    case "item_upsert":
      assertRevisionMonotonic(
        snapshot.itemsById[event.item.id],
        event.item,
        "thread_projection_item_revision_regressed",
        "thread_projection_item_revision_conflict",
      );
      next = {
        ...snapshot,
        itemsById: { ...snapshot.itemsById, [event.item.id]: event.item },
      };
      break;
    case "run_state":
      next = {
        ...snapshot,
        thread: { ...snapshot.thread, runState: event.state },
        capabilities: { ...snapshot.capabilities, runState: event.state },
        runState: event.state,
        ...(event.activeTurnId
          ? { activeTurnId: event.activeTurnId }
          : { activeTurnId: undefined }),
      };
      break;
    case "queue_changed":
      if (event.threadRevision < snapshot.thread.threadRevision) {
        throw new Error("thread_projection_thread_revision_regressed");
      }
      if (
        event.threadRevision === snapshot.thread.threadRevision &&
        !sameValue(snapshot.queue, event.items)
      ) {
        throw new Error("thread_projection_queue_revision_conflict");
      }
      next = {
        ...snapshot,
        thread: {
          ...snapshot.thread,
          threadRevision: event.threadRevision,
          queuedInputCount: event.items.length,
        },
        queue: event.items,
      };
      break;
    case "capabilities_changed":
      assertProviderFeatureProjectionMonotonic(snapshot, event);
      next = {
        ...snapshot,
        thread: {
          ...snapshot.thread,
          threadRevision: Math.max(
            snapshot.thread.threadRevision,
            event.threadRevision,
          ),
        },
        capabilities: { ...event.capabilities, runState: snapshot.runState },
        providerFeatures: event.providerFeatures,
      };
      break;
    case "interaction_opened": {
      const existingIndex = snapshot.interactions.findIndex(
        ({ id }) => id === event.interaction.id,
      );
      const interactions = [...snapshot.interactions];
      if (existingIndex === -1) interactions.push(event.interaction);
      else interactions[existingIndex] = event.interaction;
      next = {
        ...snapshot,
        interactions,
      };
      break;
    }
    case "interaction_resolved":
      next = {
        ...snapshot,
        interactions: snapshot.interactions.filter(
          ({ id }) => id !== event.interactionId,
        ),
      };
      break;
    case "usage_revision_changed":
      next = snapshot;
      break;
    case "usage_changed":
      next = { ...snapshot, usage: event.usage };
      break;
    case "background_activity_changed":
      next = { ...snapshot, backgroundActivity: event.activity };
      break;
    case "thread_changed":
      next = { ...snapshot, thread: event.thread };
      break;
    case "draft_changed":
      next = { ...snapshot, draft: event.draft };
      break;
    case "stashes_changed":
      next = { ...snapshot, stashes: event.stashes };
      break;
    case "settings_changed":
      next = { ...snapshot, settings: event.settings };
      break;
    case "attention_changed":
      next = { ...snapshot, attention: event.attention };
      break;
    case "application_state_changed":
      assertThreadSummaryMonotonic(snapshot.thread, event.state.thread);
      assertRevisionMonotonic(
        snapshot.draft,
        event.state.draft,
        "thread_projection_draft_revision_regressed",
        "thread_projection_draft_revision_conflict",
      );
      assertRevisionMonotonic(
        snapshot.settings,
        event.state.settings,
        "thread_projection_settings_revision_regressed",
        "thread_projection_settings_revision_conflict",
      );
      assertRevisionMonotonic(
        snapshot.agentTools,
        event.state.agentTools,
        "thread_projection_agent_tool_revision_regressed",
        "thread_projection_agent_tool_revision_conflict",
      );
      assertProviderFeatureProjectionMonotonic(snapshot, event.state);
      next = {
        ...snapshot,
        ...event.state,
        ...(event.state.recovery
          ? { recovery: event.state.recovery }
          : { recovery: undefined }),
        forksByTurnId: forkCapabilities(
          snapshot.turnsById,
          event.state.forkSource,
        ),
      };
      break;
    case "questions_changed":
    case "notice":
      return snapshot;
  }
  return next;
}

function forkCapabilities(
  turnsById: NormalizedThreadSnapshot["turnsById"],
  forkSource: ThreadForkSourceCapability,
): NormalizedThreadSnapshot["forksByTurnId"] {
  return Object.fromEntries(
    Object.values(turnsById).map((turn) => {
      const turnEligible =
        turn.status === "completed" && turn.endedBy === "agent_settled";
      const available =
        turnEligible && forkSource.selectedCompletedTurn.available;
      return [
        turn.id,
        {
          sourceTurnId: turn.id,
          expectedTurnRevision: turn.revision,
          available,
          ...(available
            ? {}
            : {
                unavailableReason: turnEligible
                  ? forkSource.selectedCompletedTurn.unavailableReason!
                  : {
                      text: "Only a successfully completed turn can be forked.",
                    },
              }),
        },
      ];
    }),
  );
}

function clampTurnFork(
  fork: NormalizedThreadSnapshot["forksByTurnId"][string],
  forkSource: ThreadForkSourceCapability,
): NormalizedThreadSnapshot["forksByTurnId"][string] {
  if (!fork.available || forkSource.selectedCompletedTurn.available) {
    return fork;
  }
  return {
    sourceTurnId: fork.sourceTurnId,
    expectedTurnRevision: fork.expectedTurnRevision,
    available: false,
    unavailableReason: forkSource.selectedCompletedTurn.unavailableReason!,
  };
}
