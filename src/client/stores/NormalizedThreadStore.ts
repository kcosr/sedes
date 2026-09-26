import {
  MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  MAXIMUM_NORMALIZED_TIMELINE_TURNS,
  threadEventEnvelopeSchema,
  threadCheckpointSchema,
  type ConversationItem,
  type ConversationTurn,
  type NormalizedDraft,
  type NormalizedThreadSnapshot,
  type QueuedInputSummary,
  type RuntimeNotice,
  type ThreadEventEnvelope,
} from "../../shared/index.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../shared/protocol/payload.js";

export interface NormalizedThreadState {
  readonly authoritative: boolean;
  readonly generation?: string;
  readonly snapshot?: NormalizedThreadSnapshot;
  readonly notices: readonly RuntimeNotice[];
}

export type NormalizedThreadApplyResult =
  | { readonly kind: "applied" }
  | { readonly kind: "ignored" }
  | { readonly kind: "resnapshot_required"; readonly reason: string };

type TransportCursor = {
  readonly generation: string;
  readonly sequence: number;
};

function transportCursor(eventId: string): TransportCursor {
  const separator = eventId.lastIndexOf(".");
  return {
    generation: eventId.slice(0, separator),
    sequence: Number(eventId.slice(separator + 1)),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapById<T extends { readonly id: string }>(
  values: readonly T[],
): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

export class NormalizedThreadStore {
  #state: NormalizedThreadState = {
    authoritative: false,
    notices: [],
  };
  #transport?: TransportCursor;
  #replayCursor?: string;
  #recovery: "current" | "catching_up" | "replacement_required" =
    "replacement_required";
  #snapshotBytes = 0;
  #capabilityThreadRevision = 0;
  #capabilityRunState?: NormalizedThreadSnapshot["runState"];
  #checkpointHandshake = false;
  // HTTP receipts may be newer than a connection's published watermark.
  // Retain only freshness evidence; checkpoints still replace all view data.
  #receiptThreadRevision?: number;
  #receiptNeedsConfirmation = false;
  readonly #resolvedInteractionReceipts = new Set<string>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): NormalizedThreadState => this.#state;

  get state(): NormalizedThreadState {
    return this.#state;
  }

  /** Opaque SSE resume token for the last envelope accepted by this store. */
  get replayCursor(): string | undefined {
    return this.#replayCursor;
  }

  /** Current serialized snapshot size, maintained as normalized events apply. */
  get snapshotSerializedBytes(): number {
    return this.#snapshotBytes;
  }

  get capabilityThreadRevision(): number {
    return this.#capabilityThreadRevision;
  }

  /** A live run-state update can precede the matching action capabilities. */
  get awaitingRunStateCapabilities(): boolean {
    const snapshot = this.#state.snapshot;
    return this.#recovery === "current" && snapshot !== undefined &&
      this.#capabilityRunState !== snapshot.runState &&
      !this.#receiptNeedsConfirmation &&
      snapshot.thread.threadRevision >= (this.#receiptThreadRevision ?? 0) &&
      !snapshot.interactions.some(({ id }) => this.#resolvedInteractionReceipts.has(id));
  }

  /**
   * Discards an entire browser projection before changing its server-selected
   * representation. Cursors and generations from one representation must
   * never be reused with another.
   */
  resetProjection(): void {
    this.#transport = undefined;
    this.#replayCursor = undefined;
    this.#recovery = "replacement_required";
    this.#snapshotBytes = 0;
    this.#checkpointHandshake = false;
    this.#clearReceiptFences();
    this.#replaceState({ authoritative: false, notices: [] });
  }

  prepareForReconnect(): void {
    // A transport retry can safely replay a contiguous suffix over the
    // retained projection. Do not let a later connection callback downgrade a
    // hard protocol failure into this softer catch-up state.
    if (this.#recovery === "replacement_required") return;
    this.#recovery = "catching_up";
    if (this.#state.authoritative) {
      this.#replaceState({ ...this.#state, authoritative: false });
    }
  }

  requireReplacement(): void {
    this.#recovery = "replacement_required";
    // A replacement snapshot is a new baseline: the retained transport cursor
    // belongs to the discarded projection and must not gate it (a reused
    // anchor carries an older sequence, so keeping the cursor would either
    // ignore the anchor or wedge recovery behind a poisoned suffix).
    this.#transport = undefined;
    this.#replayCursor = undefined;
    if (this.#state.authoritative) {
      this.#replaceState({ ...this.#state, authoritative: false });
    }
  }

  confirmReplayCaughtUp(): void {
    if (
      this.#recovery !== "catching_up" ||
      this.#state.authoritative ||
      !this.#state.snapshot ||
      !this.#transport
    ) {
      return;
    }
    this.#recovery = "current";
    this.#checkpointHandshake = false;
    this.#replaceState({
      ...this.#state,
      authoritative: this.#authorityReady(this.#state.snapshot),
    });
  }

  applyQueueMutationProjection(input: {
    readonly generation: string;
    readonly threadRevision: number;
    readonly queue: readonly QueuedInputSummary[];
    readonly draft?: NormalizedDraft;
  }): NormalizedThreadApplyResult {
    const snapshot = this.#state.snapshot;
    if (
      !snapshot ||
      this.#recovery === "replacement_required" ||
      input.generation !== this.#state.generation
    ) {
      return { kind: "ignored" };
    }
    if (input.threadRevision < snapshot.thread.threadRevision) {
      return { kind: "ignored" };
    }
    if (input.threadRevision === snapshot.thread.threadRevision) {
      if (!sameValue(snapshot.queue, input.queue)) {
        return this.#invalidate("queue_revision_conflict");
      }
      if (
        input.draft === undefined ||
        input.draft.revision < snapshot.draft.revision ||
        sameValue(snapshot.draft, input.draft)
      ) {
        return { kind: "ignored" };
      }
      if (input.draft.revision === snapshot.draft.revision) {
        return this.#invalidate("draft_revision_conflict");
      }
      this.#receiptThreadRevision = Math.max(
        this.#receiptThreadRevision ?? 0,
        input.threadRevision,
      );
      return this.#setSnapshot({ ...snapshot, draft: input.draft });
    }
    if (
      input.draft &&
      input.draft.revision === snapshot.draft.revision &&
      !sameValue(snapshot.draft, input.draft)
    ) {
      return this.#invalidate("draft_revision_conflict");
    }
    this.#receiptThreadRevision = Math.max(
      this.#receiptThreadRevision ?? 0,
      input.threadRevision,
    );
    return this.#setSnapshot({
      ...snapshot,
      thread: {
        ...snapshot.thread,
        threadRevision: input.threadRevision,
        queuedInputCount: input.queue.length,
      },
      queue: [...input.queue],
      draft:
        input.draft && input.draft.revision > snapshot.draft.revision
          ? input.draft
          : snapshot.draft,
    });
  }

  /**
   * Applies the authoritative completion receipt for a blocking interaction.
   * The HTTP mutation and SSE event are two delivery paths for the same
   * resolution; either may arrive first, so this operation is idempotent and
   * deliberately leaves the transport cursor unchanged.
   */
  applyInteractionResolution(
    interactionId: string,
    generation = this.#state.generation,
  ): NormalizedThreadApplyResult {
    const snapshot = this.#state.snapshot;
    if (
      !snapshot ||
      generation !== this.#state.generation ||
      !snapshot.interactions.some(({ id }) => id === interactionId)
    ) {
      return { kind: "ignored" };
    }
    // At most the supported open-interaction window can await confirmation.
    // A broken stream must recover before another receipt can exceed it.
    if (
      this.#resolvedInteractionReceipts.size >= 32 &&
      !this.#resolvedInteractionReceipts.has(interactionId)
    ) {
      return this.#invalidate("interaction_receipt_limit_exceeded");
    }
    this.#resolvedInteractionReceipts.add(interactionId);
    return this.#setSnapshot({
      ...snapshot,
      interactions: snapshot.interactions.filter(
        ({ id }) => id !== interactionId,
      ),
    });
  }

  apply(rawEnvelope: unknown): NormalizedThreadApplyResult {
    const parsed = threadEventEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return this.#invalidate("invalid_thread_event");
    }
    const envelope = parsed.data;
    const cursor = transportCursor(envelope.eventId);
    const cursorResult = this.#acceptCursor(cursor, envelope);
    if (cursorResult) return cursorResult;

    if (envelope.event.type === "snapshot") {
      const invalid = validateSnapshotDerivedState(envelope.event.snapshot);
      if (invalid) return this.#invalidate(invalid);
      if (envelope.event.generation !== this.#state.generation) {
        this.#clearReceiptFences();
      }
      this.#confirmReceiptProjection(envelope.event.snapshot);
      this.#transport = cursor;
      this.#replayCursor = envelope.eventId;
      this.#recovery = this.#checkpointHandshake ? "catching_up" : "current";
      this.#snapshotBytes = serializedUtf8Bytes(envelope.event.snapshot);
      this.#capabilityThreadRevision =
        envelope.event.snapshot.thread.threadRevision;
      this.#capabilityRunState = envelope.event.snapshot.capabilities.runState;
      this.#replaceState({
        authoritative:
          !this.#checkpointHandshake &&
          this.#authorityReady(envelope.event.snapshot),
        generation: envelope.event.generation,
        snapshot: envelope.event.snapshot,
        notices: [],
      });
      return { kind: "applied" };
    }

    const snapshot = this.#state.snapshot;
    if (
      this.#recovery === "replacement_required" ||
      !snapshot ||
      envelope.event.generation !== this.#state.generation
    ) {
      return this.#invalidate("projection_generation_missing");
    }

    const result = this.#applyIncremental(envelope);
    if (result.kind !== "resnapshot_required") {
      this.#transport = cursor;
      this.#replayCursor = envelope.eventId;
      const event = envelope.event;
      if (event.type === "interaction_resolved") {
        this.#resolvedInteractionReceipts.delete(event.interactionId);
      } else if (event.type === "application_state_changed") {
        this.#confirmReceiptProjection(event.state);
      } else if (
        event.type === "queue_changed" &&
        (result.kind === "applied" ||
          (event.threadRevision ===
            this.#state.snapshot!.thread.threadRevision &&
            sameValue(event.items, this.#state.snapshot!.queue)))
      ) {
        this.#confirmReceiptRevision(event.threadRevision);
      }
      const authoritative =
        this.#recovery === "current" &&
        this.#authorityReady(this.#state.snapshot!);
      if (authoritative !== this.#state.authoritative) {
        this.#replaceState({ ...this.#state, authoritative });
      }
    }
    return result;
  }

  /**
   * A connection-local checkpoint replaces the complete retained projection.
   * Its watermark is not a published snapshot event. Newer events may apply,
   * but only this connection's live marker restores mutation authority.
   */
  applyCheckpoint(rawCheckpoint: unknown): NormalizedThreadApplyResult {
    const parsed = threadCheckpointSchema.safeParse(rawCheckpoint);
    if (!parsed.success) return this.#invalidate("invalid_thread_checkpoint");
    const checkpoint = parsed.data;
    const cursor = transportCursor(checkpoint.eventId);
    if (
      this.#checkpointHandshake &&
      this.#transport?.generation === cursor.generation &&
      this.#transport.sequence === cursor.sequence &&
      this.#state.generation === checkpoint.projectionGeneration
    ) {
      return { kind: "ignored" };
    }
    const cursorResult = this.#acceptCursor(cursor, {
      eventId: checkpoint.eventId,
      projectionGeneration: checkpoint.projectionGeneration,
      event: {
        type: "snapshot",
        generation: checkpoint.projectionGeneration,
        snapshot: checkpoint.snapshot,
      },
    });
    if (cursorResult) return cursorResult;
    const invalid = validateSnapshotDerivedState(checkpoint.snapshot);
    if (invalid) return this.#invalidate(invalid);
    if (checkpoint.projectionGeneration !== this.#state.generation) {
      this.#clearReceiptFences();
    }
    this.#confirmReceiptProjection(checkpoint.snapshot);
    this.#transport = cursor;
    this.#replayCursor = checkpoint.eventId;
    this.#recovery = "catching_up";
    this.#snapshotBytes = serializedUtf8Bytes(checkpoint.snapshot);
    this.#capabilityThreadRevision = checkpoint.capabilityThreadRevision;
    this.#capabilityRunState = checkpoint.capabilityRunState;
    this.#checkpointHandshake = true;
    this.#replaceState({
      authoritative: false,
      generation: checkpoint.projectionGeneration,
      snapshot: checkpoint.snapshot,
      notices: checkpoint.notices,
    });
    return { kind: "applied" };
  }

  #acceptCursor(
    cursor: TransportCursor,
    envelope: ThreadEventEnvelope,
  ): NormalizedThreadApplyResult | undefined {
    const previous = this.#transport;
    if (!previous) {
      return envelope.event.type === "snapshot"
        ? undefined
        : this.#invalidate("initial_snapshot_missing");
    }
    if (cursor.generation !== previous.generation) {
      return envelope.event.type === "snapshot"
        ? undefined
        : this.#invalidate("transport_generation_changed");
    }
    if (cursor.sequence < previous.sequence) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence === previous.sequence &&
      envelope.event.type !== "snapshot"
    ) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence === previous.sequence &&
      envelope.event.type === "snapshot" &&
      this.#state.authoritative
    ) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence !== previous.sequence + 1 &&
      envelope.event.type !== "snapshot"
    ) {
      return this.#invalidate("transport_sequence_gap");
    }
    return undefined;
  }

  #applyIncremental(
    envelope: ThreadEventEnvelope,
  ): NormalizedThreadApplyResult {
    const event = envelope.event;
    const snapshot = this.#state.snapshot!;
    switch (event.type) {
      case "history_prepend": {
        if (historyPageAlreadyApplied(snapshot, event.page)) {
          return { kind: "applied" };
        }
        const error = validateHistoryPrepend(snapshot, event.page);
        if (error) return this.#invalidate(error);
        const pageForks = forkCapabilitiesForTurns(
          event.page.turnsById,
          snapshot.forkSource,
        );
        const merged: NormalizedThreadSnapshot = {
          ...snapshot,
          orderedTurnIds: [
            ...event.page.orderedTurnIds,
            ...snapshot.orderedTurnIds,
          ],
          turnsById: { ...event.page.turnsById, ...snapshot.turnsById },
          forksByTurnId: {
            ...pageForks,
            ...snapshot.forksByTurnId,
          },
          itemsById: { ...event.page.itemsById, ...snapshot.itemsById },
          history: event.page.previousCursor
            ? {
                hasOlder: true,
                olderCursor: event.page.previousCursor,
              }
            : { hasOlder: false },
        };
        return this.#setSnapshot(merged, "history_window_limit_exceeded");
      }
      case "turn_upsert":
        return this.#upsertTurn(
          snapshot,
          event.turn,
          clampTurnFork(event.fork, snapshot.forkSource),
        );
      case "fork_source_state_changed": {
        // This is an application-normalized event. Its availability has
        // already been clamped against inventory and recovery state at the
        // server boundary, so both positive and negative transitions are
        // authoritative here.
        const forksByTurnId = forkCapabilitiesForTurns(
          snapshot.turnsById,
          event.forkSource,
        );
        return this.#setSnapshot({
          ...snapshot,
          forkSource: event.forkSource,
          forksByTurnId,
        });
      }
      case "item_upsert":
        return this.#upsertItem(snapshot, event.item);
      case "run_state":
        if (
          event.activeTurnId &&
          !Object.hasOwn(snapshot.turnsById, event.activeTurnId)
        ) {
          return this.#invalidate("active_turn_missing");
        }
        return this.#setSnapshot({
          ...snapshot,
          thread: { ...snapshot.thread, runState: event.state },
          capabilities: { ...snapshot.capabilities, runState: event.state },
          runState: event.state,
          ...(event.activeTurnId
            ? { activeTurnId: event.activeTurnId }
            : { activeTurnId: undefined }),
        });
      case "background_activity_changed":
        return this.#setSnapshot({
          ...snapshot,
          backgroundActivity: event.activity,
        });
      case "queue_changed":
        if (event.threadRevision < snapshot.thread.threadRevision) {
          return { kind: "ignored" };
        }
        if (event.threadRevision === snapshot.thread.threadRevision) {
          return sameValue(snapshot.queue, event.items)
            ? { kind: "ignored" }
            : this.#invalidate("queue_revision_conflict");
        }
        return this.#setSnapshot({
          ...snapshot,
          thread: {
            ...snapshot.thread,
            threadRevision: event.threadRevision,
            queuedInputCount: event.items.length,
          },
          queue: event.items,
        });
      case "capabilities_changed": {
        if (event.threadRevision < this.#capabilityThreadRevision) {
          return this.#invalidate("thread_revision_regressed");
        }
        const revision = providerFeatureProjectionRevisionResult(
          snapshot,
          event,
        );
        if (revision) return this.#invalidate(revision);
        this.#capabilityThreadRevision = event.threadRevision;
        this.#capabilityRunState = event.capabilities.runState;
        return this.#setSnapshot({
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
        });
      }
      case "interaction_opened": {
        const interactions = mapById(snapshot.interactions);
        interactions.set(event.interaction.id, event.interaction);
        if (interactions.size > 32) {
          return this.#invalidate("interaction_limit_exceeded");
        }
        return this.#setSnapshot({
          ...snapshot,
          interactions: [...interactions.values()],
        });
      }
      case "interaction_resolved":
        return this.#setSnapshot({
          ...snapshot,
          interactions: snapshot.interactions.filter(
            ({ id }) => id !== event.interactionId,
          ),
        });
      case "usage_revision_changed":
        return { kind: "applied" };
      case "usage_changed":
        return this.#setSnapshot({ ...snapshot, usage: event.usage });
      case "thread_changed":
        if (
          event.thread.inventoryRevision < snapshot.thread.inventoryRevision ||
          event.thread.threadRevision < snapshot.thread.threadRevision
        ) {
          return this.#invalidate("thread_revision_regressed");
        }
        if (
          event.thread.runState !== snapshot.runState ||
          event.thread.queuedInputCount !== snapshot.queue.length
        ) {
          return this.#invalidate("thread_derived_state_conflict");
        }
        return this.#setSnapshot({ ...snapshot, thread: event.thread });
      case "draft_changed":
        if (event.draft.revision < snapshot.draft.revision) {
          return this.#invalidate("draft_revision_regressed");
        }
        return this.#setSnapshot({ ...snapshot, draft: event.draft });
      case "stashes_changed":
        return this.#setSnapshot({ ...snapshot, stashes: event.stashes });
      case "settings_changed":
        if (event.settings.revision < snapshot.settings.revision) {
          return this.#invalidate("settings_revision_regressed");
        }
        return this.#setSnapshot({ ...snapshot, settings: event.settings });
      case "attention_changed":
        return this.#setSnapshot({ ...snapshot, attention: event.attention });
      case "application_state_changed": {
        if (
          event.state.thread.inventoryRevision <
            snapshot.thread.inventoryRevision ||
          event.state.thread.threadRevision < snapshot.thread.threadRevision
        ) {
          return this.#invalidate("thread_revision_regressed");
        }
        const draftRevision = revisionResult(snapshot.draft, event.state.draft);
        if (draftRevision) {
          return this.#invalidate(
            draftRevision === "entity_revision_regressed"
              ? "draft_revision_regressed"
              : "draft_revision_conflict",
          );
        }
        const settingsRevision = revisionResult(
          snapshot.settings,
          event.state.settings,
        );
        if (settingsRevision) {
          return this.#invalidate(
            settingsRevision === "entity_revision_regressed"
              ? "settings_revision_regressed"
              : "settings_revision_conflict",
          );
        }
        const agentToolRevision = revisionResult(
          snapshot.agentTools,
          event.state.agentTools,
        );
        if (agentToolRevision) {
          return this.#invalidate(
            agentToolRevision === "entity_revision_regressed"
              ? "agent_tool_policy_revision_regressed"
              : "agent_tool_policy_revision_conflict",
          );
        }
        const revision = providerFeatureProjectionRevisionResult(
          snapshot,
          event.state,
        );
        if (revision) return this.#invalidate(revision);
        this.#capabilityThreadRevision = event.state.thread.threadRevision;
        this.#capabilityRunState = event.state.capabilities.runState;
        return this.#setSnapshot({
          ...snapshot,
          ...event.state,
          ...(event.state.recovery
            ? { recovery: event.state.recovery }
            : { recovery: undefined }),
          forksByTurnId: forkCapabilitiesForTurns(
            snapshot.turnsById,
            event.state.forkSource,
          ),
        });
      }
      case "questions_changed":
        return { kind: "applied" };
      case "notice":
        this.#replaceState({
          ...this.#state,
          notices: [...this.#state.notices, event.notice].slice(-100),
        });
        return { kind: "applied" };
      case "snapshot":
        throw new Error("snapshot handled before incremental dispatch");
    }
  }

  #upsertTurn(
    snapshot: NormalizedThreadSnapshot,
    turn: ConversationTurn,
    fork: NormalizedThreadSnapshot["forksByTurnId"][string],
  ): NormalizedThreadApplyResult {
    const prior = snapshot.turnsById[turn.id];
    const revision = revisionResult(prior, turn);
    if (revision) return this.#invalidate(revision);
    if (
      prior &&
      sameValue(prior, turn) &&
      sameValue(snapshot.forksByTurnId[turn.id], fork)
    ) {
      return { kind: "ignored" };
    }
    for (const itemId of turn.orderedItemIds) {
      const item = snapshot.itemsById[itemId];
      if (!item || item.turnId !== turn.id) {
        return this.#invalidate("turn_item_reference_invalid");
      }
    }
    const next = {
      ...snapshot,
      orderedTurnIds: prior
        ? snapshot.orderedTurnIds
        : [...snapshot.orderedTurnIds, turn.id],
      turnsById: { ...snapshot.turnsById, [turn.id]: turn },
      forksByTurnId: { ...snapshot.forksByTurnId, [turn.id]: fork },
    };
    // Only the turn, its fork capability, and (for a new turn) its ID change.
    // Serializing retained message bodies here makes each turn revision scale
    // with the entire loaded history instead of the changed entities.
    const priorFork = snapshot.forksByTurnId[turn.id];
    const snapshotBytes =
      this.#snapshotBytes +
      (prior
        ? serializedUtf8Bytes(turn) - serializedUtf8Bytes(prior)
        : serializedUtf8Bytes({ [turn.id]: turn }) -
          2 +
          (Object.keys(snapshot.turnsById).length > 0 ? 1 : 0) +
          serializedUtf8Bytes(turn.id) +
          (snapshot.orderedTurnIds.length > 0 ? 1 : 0)) +
      (priorFork
        ? serializedUtf8Bytes(fork) - serializedUtf8Bytes(priorFork)
        : serializedUtf8Bytes({ [turn.id]: fork }) -
          2 +
          (Object.keys(snapshot.forksByTurnId).length > 0 ? 1 : 0));
    if (
      next.orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      snapshotBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
    ) {
      return this.#invalidate("timeline_window_limit_exceeded");
    }
    return this.#setSnapshot(
      next,
      "timeline_window_limit_exceeded",
      snapshotBytes,
    );
  }

  #upsertItem(
    snapshot: NormalizedThreadSnapshot,
    item: ConversationItem,
  ): NormalizedThreadApplyResult {
    if (!snapshot.turnsById[item.turnId]) {
      return this.#invalidate("item_turn_missing");
    }
    const prior = snapshot.itemsById[item.id];
    const revision = revisionResult(prior, item);
    if (revision) return this.#invalidate(revision);
    if (prior && sameValue(prior, item)) return { kind: "ignored" };
    const next = {
      ...snapshot,
      itemsById: { ...snapshot.itemsById, [item.id]: item },
    };
    const snapshotBytes =
      this.#snapshotBytes +
      (prior
        ? serializedUtf8Bytes(item) - serializedUtf8Bytes(prior)
        : serializedUtf8Bytes({ [item.id]: item }) -
          2 +
          (Object.keys(snapshot.itemsById).length > 0 ? 1 : 0));
    if (
      Object.keys(next.itemsById).length > MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
      snapshotBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
    ) {
      return this.#invalidate("timeline_window_limit_exceeded");
    }
    return this.#setSnapshot(
      next,
      "timeline_window_limit_exceeded",
      snapshotBytes,
    );
  }

  #setSnapshot(
    snapshot: NormalizedThreadSnapshot,
    limitReason = "snapshot_window_limit_exceeded",
    knownSerializedBytes?: number,
  ): NormalizedThreadApplyResult {
    let snapshotBytes = knownSerializedBytes;
    if (snapshotBytes === undefined) {
      const previous = this.#state.snapshot;
      snapshotBytes = previous
        ? this.#snapshotBytes + snapshotFieldByteDelta(previous, snapshot)
        : serializedUtf8Bytes(snapshot);
    }
    if (snapshotBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) {
      return this.#invalidate(limitReason);
    }
    this.#snapshotBytes = snapshotBytes;
    this.#replaceState({
      ...this.#state,
      snapshot,
      authoritative:
        this.#recovery === "current" && this.#authorityReady(snapshot),
    });
    return { kind: "applied" };
  }

  #invalidate(reason: string): NormalizedThreadApplyResult {
    this.#recovery = "replacement_required";
    // See requireReplacement: recovery starts from the next snapshot, not
    // from the discarded projection's transport cursor.
    this.#transport = undefined;
    this.#replayCursor = undefined;
    if (this.#state.authoritative) {
      this.#replaceState({ ...this.#state, authoritative: false });
    }
    return { kind: "resnapshot_required", reason };
  }

  #authorityReady(snapshot: NormalizedThreadSnapshot): boolean {
    return (
      this.#capabilityRunState === snapshot.runState &&
      !this.#receiptNeedsConfirmation &&
      snapshot.thread.threadRevision >= (this.#receiptThreadRevision ?? 0) &&
      !snapshot.interactions.some(({ id }) =>
        this.#resolvedInteractionReceipts.has(id),
      )
    );
  }

  #confirmReceiptRevision(revision: number): void {
    if (
      this.#receiptThreadRevision !== undefined &&
      revision >= this.#receiptThreadRevision
    ) {
      this.#receiptThreadRevision = undefined;
      this.#receiptNeedsConfirmation = false;
    }
  }

  #confirmReceiptProjection(
    snapshot: Pick<NormalizedThreadSnapshot, "thread" | "interactions">,
  ): void {
    if (snapshot.thread.threadRevision < (this.#receiptThreadRevision ?? 0)) {
      this.#receiptNeedsConfirmation = true;
    }
    this.#confirmReceiptRevision(snapshot.thread.threadRevision);
    const open = new Set(snapshot.interactions.map(({ id }) => id));
    for (const id of this.#resolvedInteractionReceipts) {
      if (!open.has(id)) this.#resolvedInteractionReceipts.delete(id);
    }
  }

  #clearReceiptFences(): void {
    this.#receiptThreadRevision = undefined;
    this.#receiptNeedsConfirmation = false;
    this.#resolvedInteractionReceipts.clear();
  }

  #replaceState(state: NormalizedThreadState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function snapshotFieldByteDelta(
  previous: NormalizedThreadSnapshot,
  next: NormalizedThreadSnapshot,
): number {
  let delta = 0;
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ]) as Set<keyof NormalizedThreadSnapshot>;
  for (const key of keys) {
    if (previous[key] === next[key]) continue;
    if (key === "itemsById" || key === "turnsById" || key === "forksByTurnId") {
      delta += recordMapByteDelta(previous[key], next[key]);
      continue;
    }
    // Snapshots are immutable and always nonempty. Count each present field
    // with one comma; the single missing trailing comma cancels in the delta.
    // JSON omits undefined fields, including cleared activeTurnId/recovery.
    // Shared timeline maps therefore need no traversal for metadata updates.
    if (previous[key] !== undefined) {
      delta -= serializedUtf8Bytes({ [key]: previous[key] }) - 1;
    }
    if (next[key] !== undefined) {
      delta += serializedUtf8Bytes({ [key]: next[key] }) - 1;
    }
  }
  return delta;
}

function recordMapByteDelta(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): number {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  let delta = Math.max(0, nextKeys.length - 1) - Math.max(0, previousKeys.length - 1);
  for (const key of previousKeys) {
    if (previous[key] !== next[key]) delta -= serializedUtf8Bytes({ [key]: previous[key] }) - 2;
  }
  for (const key of nextKeys) {
    if (previous[key] !== next[key]) delta += serializedUtf8Bytes({ [key]: next[key] }) - 2;
  }
  return delta;
}

function revisionResult<T extends { readonly revision: number }>(
  prior: T | undefined,
  next: T,
): string | undefined {
  if (!prior) return undefined;
  if (next.revision < prior.revision) {
    return "entity_revision_regressed";
  }
  if (next.revision === prior.revision && !sameValue(prior, next)) {
    return "entity_revision_conflict";
  }
  return undefined;
}

function providerFeatureProjectionRevisionResult(
  prior: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
  next: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
): string | undefined {
  for (const capability of next.capabilities.providerFeatures) {
    const priorCapability = prior.capabilities.providerFeatures.find(
      ({ ref }) =>
        ref.featureId === capability.ref.featureId &&
        ref.schemaVersion === capability.ref.schemaVersion,
    );
    if (!priorCapability) continue;
    if (capability.revision < priorCapability.revision) {
      return "provider_feature_revision_regressed";
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
      return "provider_feature_revision_conflict";
    }
  }
  return undefined;
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

function validateSnapshotDerivedState(
  snapshot: NormalizedThreadSnapshot,
): string | undefined {
  if (
    snapshot.thread.runState !== snapshot.runState ||
    snapshot.thread.queuedInputCount !== snapshot.queue.length
  ) {
    return "snapshot_derived_state_conflict";
  }
  return undefined;
}

function historyPageAlreadyApplied(
  snapshot: NormalizedThreadSnapshot,
  page: {
    readonly orderedTurnIds: readonly string[];
    readonly turnsById: Readonly<Record<string, ConversationTurn>>;
    readonly forksByTurnId: NormalizedThreadSnapshot["forksByTurnId"];
    readonly itemsById: Readonly<Record<string, ConversationItem>>;
  },
): boolean {
  if (
    page.orderedTurnIds.length === 0 ||
    page.orderedTurnIds.some(
      (id, index) => snapshot.orderedTurnIds[index] !== id,
    )
  ) {
    return false;
  }
  return (
    Object.entries(page.turnsById).every(
      ([id, turn]) =>
        JSON.stringify(snapshot.turnsById[id]) === JSON.stringify(turn),
    ) &&
    Object.entries(page.itemsById).every(
      ([id, item]) =>
        JSON.stringify(snapshot.itemsById[id]) === JSON.stringify(item),
    )
  );
}

function validateHistoryPrepend(
  snapshot: NormalizedThreadSnapshot,
  page: {
    readonly orderedTurnIds: readonly string[];
    readonly turnsById: Readonly<Record<string, ConversationTurn>>;
    readonly forksByTurnId: NormalizedThreadSnapshot["forksByTurnId"];
    readonly itemsById: Readonly<Record<string, ConversationItem>>;
    readonly previousCursor?: string;
  },
): string | undefined {
  const merged = {
    ...snapshot,
    orderedTurnIds: [...page.orderedTurnIds, ...snapshot.orderedTurnIds],
    turnsById: { ...page.turnsById, ...snapshot.turnsById },
    forksByTurnId: {
      ...forkCapabilitiesForTurns(page.turnsById, snapshot.forkSource),
      ...snapshot.forksByTurnId,
    },
    itemsById: { ...page.itemsById, ...snapshot.itemsById },
    history: page.previousCursor
      ? {
          hasOlder: true as const,
          olderCursor: page.previousCursor,
        }
      : { hasOlder: false as const },
  };
  if (
    merged.orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
    Object.keys(merged.itemsById).length > MAXIMUM_NORMALIZED_TIMELINE_ITEMS
  ) {
    return "history_window_limit_exceeded";
  }
  // #setSnapshot enforces the exact byte budget from immutable field deltas
  // before publishing this merge. Do not serialize all retained text here.
  if (
    page.orderedTurnIds.some((id) => Object.hasOwn(snapshot.turnsById, id)) ||
    Object.keys(page.itemsById).some((id) =>
      Object.hasOwn(snapshot.itemsById, id),
    )
  ) {
    return "history_page_overlap";
  }
  return validateSnapshotDerivedState(merged);
}

function forkCapabilitiesForTurns(
  turnsById: NormalizedThreadSnapshot["turnsById"],
  forkSource: NormalizedThreadSnapshot["forkSource"],
): NormalizedThreadSnapshot["forksByTurnId"] {
  return Object.fromEntries(
    Object.entries(turnsById).map(([turnId, turn]) => {
      const completed =
        turn.status === "completed" && turn.endedBy === "agent_settled";
      const unavailableReason = !completed
        ? { text: "Only a successfully completed turn can be forked." }
        : (turn.forkUnavailableReason ??
          (forkSource.selectedCompletedTurn.available
            ? undefined
            : forkSource.selectedCompletedTurn.unavailableReason!));
      return [
        turnId,
        {
          sourceTurnId: turnId,
          expectedTurnRevision: turn.revision,
          available: unavailableReason === undefined,
          ...(unavailableReason ? { unavailableReason } : {}),
        },
      ];
    }),
  );
}

function clampTurnFork(
  fork: NormalizedThreadSnapshot["forksByTurnId"][string],
  forkSource: NormalizedThreadSnapshot["forkSource"],
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
