import { turnFailure } from "../backends/turn-failure.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackgroundActivity } from "../../shared/protocol/background-activity.js";
import {
  conversationItemSchema,
  historyPageSchema,
  MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  MAXIMUM_NORMALIZED_TIMELINE_TURNS,
  type ConversationItem,
  type ConversationTurn,
  type HistoryPage,
  type NormalizedThreadEvent,
  type ThreadForkSourceCapability,
  type ThreadRunState,
  type TurnForkCapability,
} from "../../shared/protocol/conversation.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  serializedUtf8Bytes,
} from "../../shared/protocol/payload.js";
import type {
  BackendConversationEvent,
  BackendConversationSnapshot,
  BackendItem,
  BackendTurn,
  BackendBranchingCapability,
  SequencedBackendEvent,
} from "../../shared/protocol/backend.js";
import {
  backendConversationSnapshotSchema,
  backendHistoryPageSchema,
} from "../../shared/protocol/backend.js";
import type { BackendHistoryPage } from "../backends/contracts.js";
import { assertBoundedSerializedPayload } from "./payload-policy.js";
import {
  canonicalUserMessageContent,
  type DeliveryInputSnapshotResolver,
} from "./delivery-input-projection.js";

const phaseOrder = new Map<string, number>([
  ["arguments_streaming", 0],
  ["arguments_complete", 1],
  ["preflight_or_executing", 2],
  ["result_streaming", 3],
  ["completed", 4],
  ["failed", 4],
  ["interrupted", 4],
]);

export interface ProjectedConversationTimeline {
  readonly generation: string;
  readonly orderedTurnIds: readonly string[];
  readonly turnsById: Readonly<Record<string, ConversationTurn>>;
  readonly itemsById: Readonly<Record<string, ConversationItem>>;
  readonly runState: ThreadRunState;
  readonly backgroundActivity?: BackgroundActivity;
  readonly activeTurnId?: string;
}

export interface ResolvedApplicationTurnLocator {
  readonly backendTurnId: string;
  readonly canonicalTurnId: string;
  readonly backendTurn: BackendTurn;
  readonly turn: ConversationTurn;
}

const activeSourceHistoricalForkStates = new Set<ThreadRunState>([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "stopping",
]);

function branchingAllowsBoundaryForSourceState(input: {
  readonly branching: BackendBranchingCapability;
  readonly sourceRunState: ThreadRunState;
}): boolean {
  if (input.branching.availability !== "available") return false;
  if (input.sourceRunState === "idle") return true;
  return (
    !input.branching.sourceMustBeIdle &&
    activeSourceHistoricalForkStates.has(input.sourceRunState)
  );
}

export function branchingAllowsSelectedCompletedTurnForSourceState(input: {
  readonly branching: BackendBranchingCapability;
  readonly sourceRunState: ThreadRunState;
}): boolean {
  return branchingAllowsBoundaryForSourceState(input);
}

export function projectedTurnForkCapability(input: {
  readonly turn: ConversationTurn;
  readonly branching: BackendBranchingCapability;
  readonly sourceRunState: ThreadRunState;
}): TurnForkCapability {
  const turnCompleted =
    input.turn.status === "completed" && input.turn.endedBy === "agent_settled";
  const selectedTurnSupported =
    input.branching.availability === "available" &&
    input.branching.boundaries.includes("selected_completed_turn");
  const sourceStateAllowed =
    branchingAllowsSelectedCompletedTurnForSourceState(input);
  const available =
    turnCompleted && selectedTurnSupported && sourceStateAllowed;
  const unavailableReason = !turnCompleted
    ? { text: "Only a successfully completed turn can be forked." }
    : input.branching.availability === "unavailable"
      ? input.branching.reason
      : !input.branching.boundaries.includes("selected_completed_turn")
        ? { text: "This backend cannot fork a selected completed turn." }
        : !sourceStateAllowed
          ? { text: "The source thread must be idle before it can be forked." }
          : undefined;
  return {
    sourceTurnId: input.turn.id,
    expectedTurnRevision: input.turn.revision,
    available,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

export function projectedThreadForkSourceCapability(input: {
  readonly branching: BackendBranchingCapability;
  readonly sourceRunState: ThreadRunState;
}): ThreadForkSourceCapability {
  if (input.branching.availability === "unavailable") {
    return {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: input.branching.reason,
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: input.branching.reason,
      },
    };
  }
  const sourceStateAllowed = branchingAllowsBoundaryForSourceState(input);
  const sourceStateReason = {
    text: "The source thread must be idle before it can be forked.",
  };
  const selectedSupported = input.branching.boundaries.includes(
    "selected_completed_turn",
  );
  const latestSnapshotSupported = input.branching.boundaries.includes(
    "latest_provider_snapshot",
  );
  return {
    selectedCompletedTurn:
      selectedSupported && sourceStateAllowed
        ? { available: true }
        : {
            available: false,
            unavailableReason: selectedSupported
              ? sourceStateReason
              : { text: "This backend cannot fork a selected completed turn." },
          },
    latestProviderSnapshot:
      latestSnapshotSupported && sourceStateAllowed
        ? { available: true }
        : {
            available: false,
            unavailableReason: latestSnapshotSupported
              ? sourceStateReason
              : {
                  text: "This backend cannot fork its latest provider snapshot.",
                },
          },
  };
}

export type ProjectedThreadEvent =
  | Exclude<NormalizedThreadEvent, { readonly type: "turn_upsert" }>
  | Omit<
      Extract<NormalizedThreadEvent, { readonly type: "turn_upsert" }>,
      "fork"
    >;

export type ProjectionApplication =
  | {
      readonly kind: "events";
      readonly events: readonly ProjectedThreadEvent[];
    }
  | {
      readonly kind: "resnapshot_required";
      readonly reason: string;
    }
  | {
      readonly kind: "backend_event";
      readonly event: Extract<
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
    };

function opaqueId(namespace: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  // Permanent persisted-ID format identifier. Product renames must not change
  // application turn or item identities already referenced by durable state.
  hash.update(`harness-${namespace}-v1\0`);
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `${namespace}_${hash.digest("base64url").slice(0, 32)}`;
}

export function applicationTurnIdForBackendTurn(input: {
  readonly backendInstanceId: string;
  readonly sourceApplicationThreadId: string;
  readonly backendTurnId: string;
}): string {
  return opaqueId(
    "turn",
    input.backendInstanceId,
    input.sourceApplicationThreadId,
    input.backendTurnId,
  );
}

function browserRunState(
  state: BackendConversationSnapshot["runState"],
): ThreadRunState {
  return state;
}

function terminalStatus(status: BackendItem["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}

function statusCanAdvance(
  current: BackendItem["status"],
  next: BackendItem["status"],
): boolean {
  return current === next || !terminalStatus(current);
}

function phaseCanAdvance(current: BackendItem, next: BackendItem): boolean {
  if (!("phase" in current) || !("phase" in next)) return true;
  const currentOrder = phaseOrder.get(current.phase);
  const nextOrder = phaseOrder.get(next.phase);
  if (currentOrder === undefined || nextOrder === undefined) return false;
  if (currentOrder === 4) return current.phase === next.phase;
  return nextOrder >= currentOrder;
}

export class ConversationProjector {
  readonly #backendInstanceId: string;
  readonly #bindingIdentity: string;
  readonly #resolveDeliveryInputSnapshot?: DeliveryInputSnapshotResolver;
  #generation = randomUUID();
  #lastHandleSequence = -1;
  #backendTurns = new Map<string, BackendTurn>();
  #backendItems = new Map<string, BackendItem>();
  #turnIds = new Map<string, string>();
  #itemIds = new Map<string, string>();
  #turns = new Map<string, ConversationTurn>();
  #turnRevisions = new Map<string, number>();
  #items = new Map<string, ConversationItem>();
  #orderedTurnIds: string[] = [];
  #runState: ThreadRunState = "idle";
  #backgroundActivity: BackgroundActivity | undefined;
  #activeTurnId: string | undefined;
  #invalidated = false;
  #timelineBytes = 0;

  constructor(input: {
    readonly backendInstanceId: string;
    readonly bindingIdentity: string;
    readonly resolveDeliveryInputSnapshot?: DeliveryInputSnapshotResolver;
  }) {
    this.#backendInstanceId = input.backendInstanceId;
    this.#bindingIdentity = input.bindingIdentity;
    this.#resolveDeliveryInputSnapshot = input.resolveDeliveryInputSnapshot;
  }

  replace(
    snapshot: BackendConversationSnapshot,
    throughHandleSequence: number,
  ): ProjectedConversationTimeline {
    if (
      !Number.isSafeInteger(throughHandleSequence) ||
      throughHandleSequence < -1
    ) {
      throw new Error("backend_snapshot_sequence_invalid");
    }
    const boundedSnapshot = backendConversationSnapshotSchema.parse(snapshot);
    const generation = randomUUID();
    const backendTurns = new Map(Object.entries(boundedSnapshot.turnsById));
    const backendItems = new Map(Object.entries(boundedSnapshot.itemsById));
    const turnIds = new Map<string, string>();
    const itemIds = new Map<string, string>();
    const turns = new Map<string, ConversationTurn>();
    const turnRevisions = new Map<string, number>();
    const items = new Map<string, ConversationItem>();
    const orderedTurnIds: string[] = [];
    for (const backendTurnId of boundedSnapshot.orderedBackendTurnIds) {
      const backendTurn = backendTurns.get(backendTurnId);
      if (!backendTurn || backendTurn.backendTurnId !== backendTurnId) {
        throw new Error("backend_snapshot_turn_reference_missing");
      }
      if (turnIds.has(backendTurnId)) {
        throw new Error("backend_snapshot_turn_reference_duplicate");
      }
      const turnId = this.#durableTurnId(backendTurnId);
      turnIds.set(backendTurnId, turnId);
      orderedTurnIds.push(turnId);
      for (const backendItemId of backendTurn.orderedBackendItemIds) {
        const backendItem = backendItems.get(backendItemId);
        if (
          !backendItem ||
          backendItem.backendItemId !== backendItemId ||
          backendItem.backendTurnId !== backendTurnId
        ) {
          throw new Error("backend_snapshot_item_reference_invalid");
        }
        if (itemIds.has(backendItemId)) {
          throw new Error("backend_snapshot_item_reference_duplicate");
        }
        const itemId = this.#durableItemId(backendItem);
        itemIds.set(backendItemId, itemId);
        items.set(itemId, this.#projectItem(backendItem, itemId, turnId, 0));
      }
      turns.set(
        turnId,
        this.#projectTurnWithItemIds(backendTurn, turnId, 0, itemIds),
      );
      turnRevisions.set(turnId, 0);
    }

    if (
      backendItems.size !== itemIds.size ||
      backendTurns.size !== turnIds.size
    ) {
      throw new Error("backend_snapshot_contains_unreferenced_records");
    }

    const runState = browserRunState(boundedSnapshot.runState);
    const activeTurnId = boundedSnapshot.activeBackendTurnId
      ? turnIds.get(boundedSnapshot.activeBackendTurnId)
      : undefined;
    if (boundedSnapshot.activeBackendTurnId && !activeTurnId) {
      throw new Error("backend_snapshot_active_turn_missing");
    }

    this.#generation = generation;
    this.#lastHandleSequence = throughHandleSequence;
    this.#backendTurns = backendTurns;
    this.#backendItems = backendItems;
    this.#turnIds = turnIds;
    this.#itemIds = itemIds;
    this.#turns = turns;
    this.#turnRevisions = turnRevisions;
    this.#items = items;
    this.#orderedTurnIds = orderedTurnIds;
    this.#runState = runState;
    this.#backgroundActivity = boundedSnapshot.backgroundActivity;
    this.#activeTurnId = activeTurnId;
    if (!this.#refreshTimelineBytes()) {
      throw new Error("normalized_timeline_limit_exceeded");
    }
    this.#invalidated = false;
    return this.timeline();
  }

  apply(input: SequencedBackendEvent): ProjectionApplication {
    if (this.#invalidated) {
      return {
        kind: "resnapshot_required",
        reason: "projector_invalidated",
      };
    }
    if (input.handleSequence !== this.#lastHandleSequence + 1) {
      return this.#invalidate("backend_sequence_gap");
    }
    const event = input.event;
    if (event.type === "resnapshot_required") {
      return this.#invalidate(event.reason);
    }
    let result: ProjectionApplication;
    if (event.type === "background_activity_changed") {
      this.#backgroundActivity = event.activity;
      result = {
        kind: "events",
        events: [{ type: "background_activity_changed", generation: this.#generation, activity: event.activity }],
      };
    } else if (event.type === "run_state_changed") {
      if (
        (event.state === "idle" || event.state === "failed") &&
        this.#hasUnresolvedTurnItems()
      ) {
        return this.#invalidate("backend_turn_items_unresolved_at_settlement");
      }
      const activeTurnId = event.activeBackendTurnId
        ? this.#turnIds.get(event.activeBackendTurnId)
        : undefined;
      if (event.activeBackendTurnId && !activeTurnId) {
        return this.#invalidate("backend_active_turn_missing");
      }
      this.#runState = browserRunState(event.state);
      this.#activeTurnId = activeTurnId;
      result = {
        kind: "events",
        events: [
          {
            type: "run_state",
            generation: this.#generation,
            state: this.#runState,
            ...(activeTurnId ? { activeTurnId } : {}),
          },
        ],
      };
    } else if (
      event.type === "turn_started" ||
      event.type === "turn_updated" ||
      event.type === "turn_completed"
    ) {
      result = this.#applyTurn(event.turn);
    } else if (
      event.type === "item_started" ||
      event.type === "item_updated" ||
      event.type === "item_completed"
    ) {
      result = this.#applyItem(event.item);
    } else {
      result = { kind: "backend_event", event };
    }
    if (result.kind === "resnapshot_required") {
      this.#invalidated = true;
      return result;
    }
    this.#lastHandleSequence = input.handleSequence;
    return result;
  }

  timeline(): ProjectedConversationTimeline {
    return {
      generation: this.#generation,
      orderedTurnIds: [...this.#orderedTurnIds],
      turnsById: Object.fromEntries(this.#turns),
      itemsById: Object.fromEntries(this.#items),
      runState: this.#runState,
      ...(this.#backgroundActivity ? { backgroundActivity: this.#backgroundActivity } : {}),
      ...(this.#activeTurnId ? { activeTurnId: this.#activeTurnId } : {}),
    };
  }

  backendTurnId(turnId: string): string | undefined {
    for (const [backendTurnId, projectedTurnId] of this.#turnIds) {
      if (projectedTurnId === turnId) return backendTurnId;
    }
    return undefined;
  }

  matchesApplicationTurnId(
    backendTurnId: string,
    applicationTurnId: string,
  ): boolean {
    return this.#durableTurnId(backendTurnId) === applicationTurnId;
  }

  resolveCurrentTurn(
    turnId: string,
  ): ResolvedApplicationTurnLocator | undefined {
    const backendTurnId = this.backendTurnId(turnId);
    if (!backendTurnId) return undefined;
    const backendTurn = this.#backendTurns.get(backendTurnId);
    const turn = this.#turns.get(turnId);
    if (!backendTurn || !turn) return undefined;
    return {
      backendTurnId,
      canonicalTurnId: this.#durableTurnId(backendTurnId),
      backendTurn,
      turn,
    };
  }

  resolveHistoryTurn(
    page: BackendHistoryPage,
    turnId: string,
  ): ResolvedApplicationTurnLocator | undefined {
    const boundedPage = backendHistoryPageSchema.parse(page);
    for (const backendTurnId of boundedPage.orderedBackendTurnIds) {
      if (this.#durableTurnId(backendTurnId) !== turnId) continue;
      const backendTurn = boundedPage.turnsById[backendTurnId];
      if (!backendTurn) {
        throw new Error("backend_history_turn_reference_missing");
      }
      const itemIds = new Map<string, string>();
      for (const backendItemId of backendTurn.orderedBackendItemIds) {
        const item = boundedPage.itemsById[backendItemId];
        if (!item) throw new Error("backend_history_item_reference_invalid");
        itemIds.set(backendItemId, this.#durableItemId(item));
      }
      const turn = this.#projectTurnWithItemIds(
        backendTurn,
        turnId,
        0,
        itemIds,
      );
      return {
        backendTurnId,
        canonicalTurnId: turnId,
        backendTurn,
        turn,
      };
    }
    return undefined;
  }

  /** Server-only classification evidence; never exposed in browser items. */
  assistantItemsForTurn(backendTurnId: string): readonly Extract<BackendItem, { semanticKind: "assistant_message" }>[] {
    const turn = this.#backendTurns.get(backendTurnId);
    if (!turn) throw new Error("authoritative_completion_turn_unresolved");
    return turn.orderedBackendItemIds.map((id) => this.#backendItems.get(id))
      .filter((item): item is Extract<BackendItem, { semanticKind: "assistant_message" }> =>
        item?.semanticKind === "assistant_message");
  }

  backendTurns(): readonly BackendTurn[] {
    return [...this.#backendTurns.values()];
  }

  /**
   * Projects a bounded backend history page without adding it to the live
   * projection. The same durable identity functions are used for both paths,
   * so an older page can be prepended without exposing backend-native IDs.
   */
  projectHistoryPage(
    page: BackendHistoryPage,
    context: {
      readonly branching: BackendBranchingCapability;
      readonly sourceRunState: ThreadRunState;
    },
  ): HistoryPage {
    const boundedPage = backendHistoryPageSchema.parse(page);
    const backendTurns = new Map(Object.entries(boundedPage.turnsById));
    const backendItems = new Map(Object.entries(boundedPage.itemsById));
    const turnIds = new Map<string, string>();
    const itemIds = new Map<string, string>();
    const orderedTurnIds: string[] = [];

    for (const backendTurnId of boundedPage.orderedBackendTurnIds) {
      const backendTurn = backendTurns.get(backendTurnId);
      if (!backendTurn || backendTurn.backendTurnId !== backendTurnId) {
        throw new Error("backend_history_turn_reference_missing");
      }
      if (turnIds.has(backendTurnId)) {
        throw new Error("backend_history_turn_reference_duplicate");
      }
      const turnId = this.#durableTurnId(backendTurnId);
      turnIds.set(backendTurnId, turnId);
      orderedTurnIds.push(turnId);
      for (const backendItemId of backendTurn.orderedBackendItemIds) {
        const backendItem = backendItems.get(backendItemId);
        if (
          !backendItem ||
          backendItem.backendItemId !== backendItemId ||
          backendItem.backendTurnId !== backendTurnId
        ) {
          throw new Error("backend_history_item_reference_invalid");
        }
        if (itemIds.has(backendItemId)) {
          throw new Error("backend_history_item_reference_duplicate");
        }
        itemIds.set(backendItemId, this.#durableItemId(backendItem));
      }
    }

    if (
      backendTurns.size !== turnIds.size ||
      backendItems.size !== itemIds.size
    ) {
      throw new Error("backend_history_contains_unreferenced_records");
    }

    return historyPageSchema.parse({
      orderedTurnIds,
      turnsById: Object.fromEntries(
        boundedPage.orderedBackendTurnIds.map((backendTurnId) => {
          const backendTurn = backendTurns.get(backendTurnId)!;
          const turnId = turnIds.get(backendTurnId)!;
          return [
            turnId,
            this.#projectTurnWithItemIds(backendTurn, turnId, 0, itemIds),
          ];
        }),
      ),
      forksByTurnId: Object.fromEntries(
        boundedPage.orderedBackendTurnIds.map((backendTurnId) => {
          const turnId = turnIds.get(backendTurnId)!;
          const turn = this.#projectTurnWithItemIds(
            backendTurns.get(backendTurnId)!,
            turnId,
            0,
            itemIds,
          );
          return [
            turnId,
            projectedTurnForkCapability({
              turn,
              branching: context.branching,
              sourceRunState: context.sourceRunState,
            }),
          ];
        }),
      ),
      forkSource: projectedThreadForkSourceCapability({
        branching: context.branching,
        sourceRunState: context.sourceRunState,
      }),
      itemsById: Object.fromEntries(
        boundedPage.orderedBackendTurnIds.flatMap((backendTurnId) => {
          const backendTurn = backendTurns.get(backendTurnId)!;
          const turnId = turnIds.get(backendTurnId)!;
          return backendTurn.orderedBackendItemIds.map((backendItemId) => {
            const backendItem = backendItems.get(backendItemId)!;
            const itemId = itemIds.get(backendItemId)!;
            return [itemId, this.#projectItem(backendItem, itemId, turnId, 0)];
          });
        }),
      ),
      ...(boundedPage.previousCursor
        ? { previousCursor: boundedPage.previousCursor }
        : {}),
    });
  }

  #applyTurn(backendTurn: BackendTurn): ProjectionApplication {
    const prior = this.#backendTurns.get(backendTurn.backendTurnId);
    if (prior && equalBackendTurn(prior, backendTurn)) {
      return { kind: "events", events: [] };
    }
    if (
      prior &&
      prior.status !== backendTurn.status &&
      prior.status !== "in_progress"
    ) {
      return this.#invalidate("backend_turn_state_regressed");
    }
    // A mutation receipt can establish the turn identity before the backend's
    // start notification supplies its timestamp. That one-way enrichment is a
    // normal delta; changing or removing an observed timestamp is not.
    const startedAtRegressedOrChanged =
      prior?.startedAt !== undefined &&
      prior.startedAt !== backendTurn.startedAt;
    if (
      prior &&
      (startedAtRegressedOrChanged ||
        prior.backendTurnId !== backendTurn.backendTurnId ||
        !isPrefix(
          prior.orderedBackendItemIds,
          backendTurn.orderedBackendItemIds,
        ))
    ) {
      return this.#invalidate("backend_turn_identity_changed");
    }
    if (prior?.failure && JSON.stringify(prior.failure) !== JSON.stringify(backendTurn.failure)) {
      return this.#invalidate("backend_turn_failure_changed");
    }
    let referencesUnseenItem = false;
    for (const backendItemId of backendTurn.orderedBackendItemIds) {
      const itemId = this.#itemIds.get(backendItemId);
      if (!itemId) {
        referencesUnseenItem = true;
        continue;
      }
      const item = this.#backendItems.get(backendItemId);
      if (!item || item.backendTurnId !== backendTurn.backendTurnId) {
        return this.#invalidate("backend_turn_item_reference_invalid");
      }
    }
    if (referencesUnseenItem && backendTurn.status !== "in_progress") {
      return this.#invalidate("backend_turn_items_unresolved_at_settlement");
    }
    let turnId = this.#turnIds.get(backendTurn.backendTurnId);
    const isNewTurn = !turnId;
    if (!turnId) {
      // Backend turn identity is authoritative at the normalized boundary.
      // Derive the same opaque locator used by snapshots and history so a
      // completed live turn remains selectable after actor reconstruction.
      turnId = this.#durableTurnId(backendTurn.backendTurnId);
      this.#turnIds.set(backendTurn.backendTurnId, turnId);
      this.#orderedTurnIds.push(turnId);
    }
    this.#backendTurns.set(backendTurn.backendTurnId, backendTurn);

    const priorProjectedTurn = this.#turns.get(turnId);
    // Backend turn views are authoritative, but a subscriber cannot apply a
    // turn that references an item it has not seen. Retain the complete
    // backend view above while exposing only the currently materialized item
    // subsequence. An existing turn that introduces an unseen item stays
    // unchanged until that item's event can be emitted first.
    if (!isNewTurn && referencesUnseenItem) {
      return { kind: "events", events: [] };
    }
    const turn = this.#projectApplicableTurn(
      backendTurn,
      turnId,
      (this.#turnRevisions.get(turnId) ?? -1) + 1,
    );
    if (priorProjectedTurn && equalConversationTurn(priorProjectedTurn, turn)) {
      return { kind: "events", events: [] };
    }
    this.#turnRevisions.set(turnId, turn.revision);
    this.#turns.set(turnId, turn);
    if (!this.#refreshTimelineBytes()) {
      return this.#invalidate("normalized_timeline_limit_exceeded");
    }
    return {
      kind: "events",
      events: [
        {
          type: "turn_upsert",
          generation: this.#generation,
          turn,
        },
      ],
    };
  }

  #applyItem(backendItem: BackendItem): ProjectionApplication {
    const prior = this.#backendItems.get(backendItem.backendItemId);
    if (
      prior &&
      (!statusCanAdvance(prior.status, backendItem.status) ||
        !phaseCanAdvance(prior, backendItem))
    ) {
      return this.#invalidate("backend_item_state_regressed");
    }
    if (
      prior &&
      (prior.semanticKind !== backendItem.semanticKind ||
        prior.backendTurnId !== backendItem.backendTurnId ||
        prior.sourceOrder !== backendItem.sourceOrder ||
        prior.startedAt !== backendItem.startedAt)
    ) {
      return this.#invalidate("backend_item_identity_changed");
    }
    const turnId = this.#turnIds.get(backendItem.backendTurnId);
    const backendTurn = this.#backendTurns.get(backendItem.backendTurnId);
    if (!turnId || !backendTurn) {
      return this.#invalidate("backend_item_turn_missing");
    }
    let itemId = this.#itemIds.get(backendItem.backendItemId);
    if (!itemId) {
      itemId = this.#provisionalItemId(backendItem);
      this.#itemIds.set(backendItem.backendItemId, itemId);
    }
    const priorItem = this.#items.get(itemId);
    const item = this.#projectItem(
      backendItem,
      itemId,
      turnId,
      (priorItem?.revision ?? -1) + 1,
    );
    if (
      prior?.semanticKind === "assistant_message" &&
      backendItem.semanticKind === "assistant_message" &&
      prior.responsePhase !== backendItem.responsePhase &&
      priorItem &&
      isDeepStrictEqual({ ...item, revision: priorItem.revision }, priorItem)
    ) {
      // Server-only evidence may change after a message is complete. Retain it
      // without inventing a public revision that violates terminal immutability.
      this.#backendItems.set(backendItem.backendItemId, backendItem);
      return { kind: "events", events: [] };
    }
    const itemByteDelta = priorItem
      ? serializedUtf8Bytes(item) - serializedUtf8Bytes(priorItem)
      : serializedUtf8Bytes({ [itemId]: item }) -
        2 +
        (this.#items.size > 0 ? 1 : 0);
    this.#backendItems.set(backendItem.backendItemId, backendItem);
    this.#items.set(itemId, item);

    const ordered = [...backendTurn.orderedBackendItemIds];
    const priorProjectedTurn = this.#turns.get(turnId)!;
    if (!ordered.includes(backendItem.backendItemId)) {
      ordered.push(backendItem.backendItemId);
      ordered.sort((leftId, rightId) => {
        const left =
          leftId === backendItem.backendItemId
            ? backendItem
            : this.#backendItems.get(leftId);
        const right =
          rightId === backendItem.backendItemId
            ? backendItem
            : this.#backendItems.get(rightId);
        return (left?.sourceOrder ?? 0) - (right?.sourceOrder ?? 0);
      });
      const updatedBackendTurn = {
        ...backendTurn,
        orderedBackendItemIds: ordered,
      };
      this.#backendTurns.set(backendItem.backendTurnId, updatedBackendTurn);
    }
    const currentBackendTurn = this.#backendTurns.get(
      backendItem.backendTurnId,
    )!;
    const candidateTurn = this.#projectApplicableTurn(
      currentBackendTurn,
      turnId,
      (this.#turnRevisions.get(turnId) ?? -1) + 1,
    );
    const turnChanged = !equalConversationTurn(
      priorProjectedTurn,
      candidateTurn,
    );
    let turnByteDelta = 0;
    if (turnChanged) {
      const nextTurn = candidateTurn;
      this.#turns.set(turnId, nextTurn);
      turnByteDelta =
        serializedUtf8Bytes(nextTurn) - serializedUtf8Bytes(priorProjectedTurn);
      this.#turnRevisions.set(turnId, nextTurn.revision);
    }
    const nextTimelineBytes =
      this.#timelineBytes + itemByteDelta + turnByteDelta;
    if (
      this.#orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      this.#turns.size > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      this.#items.size > MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
      nextTimelineBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
    ) {
      return this.#invalidate("normalized_timeline_limit_exceeded");
    }
    this.#timelineBytes = nextTimelineBytes;

    const events: ProjectedThreadEvent[] = [
      {
        type: "item_upsert",
        generation: this.#generation,
        item,
      },
    ];
    if (turnChanged) {
      events.push({
        type: "turn_upsert",
        generation: this.#generation,
        turn: this.#turns.get(turnId)!,
      });
    }
    return {
      kind: "events",
      events,
    };
  }

  #projectTurn(
    backendTurn: BackendTurn,
    id: string,
    revision = 0,
  ): ConversationTurn {
    return this.#projectTurnWithItemIds(
      backendTurn,
      id,
      revision,
      this.#itemIds,
    );
  }

  #projectApplicableTurn(
    backendTurn: BackendTurn,
    id: string,
    revision: number,
  ): ConversationTurn {
    const orderedBackendItemIds = backendTurn.orderedBackendItemIds.filter(
      (backendItemId) => this.#itemIds.has(backendItemId),
    );
    const projectableTurn: BackendTurn = {
      ...backendTurn,
      orderedBackendItemIds,
    };
    return this.#projectTurnWithItemIds(
      projectableTurn,
      id,
      revision,
      this.#itemIds,
    );
  }

  #hasUnresolvedTurnItems(): boolean {
    for (const backendTurn of this.#backendTurns.values()) {
      if (
        backendTurn.orderedBackendItemIds.some(
          (backendItemId) =>
            !this.#backendItems.has(backendItemId) ||
            !this.#itemIds.has(backendItemId),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  #projectTurnWithItemIds(
    backendTurn: BackendTurn,
    id: string,
    revision: number,
    itemIds: ReadonlyMap<string, string>,
  ): ConversationTurn {
    return {
      id,
      revision,
      status: backendTurn.status,
      ...(backendTurn.status === "failed" ? { failure: backendTurn.failure ?? turnFailure(undefined) } : {}),
      ...(backendTurn.endedBy ? { endedBy: backendTurn.endedBy } : {}),
      ...(backendTurn.startedAt ? { startedAt: backendTurn.startedAt } : {}),
      ...(backendTurn.completedAt
        ? { completedAt: backendTurn.completedAt }
        : {}),
      orderedItemIds: backendTurn.orderedBackendItemIds.map((backendItemId) => {
        const itemId = itemIds.get(backendItemId);
        if (!itemId) throw new Error("backend_turn_item_not_projected");
        return itemId;
      }),
    };
  }

  #projectItem(
    backendItem: BackendItem,
    id: string,
    turnId: string,
    revision: number,
  ): ConversationItem {
    const {
      backendItemId: _backendItemId,
      backendTurnId: _backendTurnId,
      semanticKind,
      sourceOrder: _sourceOrder,
      ...payload
    } = backendItem;
    // Backend completion classification is not part of the browser contract.
    if ("responsePhase" in payload) delete payload.responsePhase;
    const canonicalPayload =
      backendItem.semanticKind === "user_message" &&
      backendItem.deliveryOperationId !== undefined
        ? (() => {
            const snapshot = this.#resolveDeliveryInputSnapshot?.(
              backendItem.deliveryOperationId,
            );
            return snapshot
              ? {
                  ...payload,
                  content: canonicalUserMessageContent({
                    snapshot,
                    providerContent: backendItem.content,
                  }),
                  ...("origin" in snapshot && snapshot.origin !== undefined
                    ? { origin: snapshot.origin }
                    : {}),
                }
              : payload;
          })()
        : payload;
    const projected = conversationItemSchema.parse({
      ...canonicalPayload,
      ...(backendItem.semanticKind === "assistant_message" &&
      backendItem.nonblockingQuestions
        ? {
            nonblockingQuestions: {
              ...backendItem.nonblockingQuestions,
              sourceItemId: this.#durableItemId(backendItem),
            },
          }
        : {}),
      id,
      turnId,
      kind: semanticKind,
      revision,
    });
    assertBoundedSerializedPayload(
      projected,
      projected.kind === "user_message" ||
        projected.kind === "assistant_message"
        ? MAXIMUM_MESSAGE_ITEM_BYTES
        : undefined,
    );
    return projected;
  }

  #durableTurnId(backendTurnId: string): string {
    return applicationTurnIdForBackendTurn({
      backendInstanceId: this.#backendInstanceId,
      sourceApplicationThreadId: this.#bindingIdentity,
      backendTurnId,
    });
  }

  #durableItemId(item: BackendItem): string {
    return opaqueId(
      "item",
      this.#backendInstanceId,
      this.#bindingIdentity,
      item.backendTurnId,
      item.backendItemId,
    );
  }

  #provisionalItemId(item: BackendItem): string {
    return opaqueId(
      "live_item",
      this.#backendInstanceId,
      this.#bindingIdentity,
      this.#generation,
      item.backendTurnId,
      item.backendItemId,
    );
  }

  #refreshTimelineBytes(): boolean {
    if (
      this.#orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      this.#turns.size > MAXIMUM_NORMALIZED_TIMELINE_TURNS ||
      this.#items.size > MAXIMUM_NORMALIZED_TIMELINE_ITEMS
    ) {
      return false;
    }
    const bytes = serializedUtf8Bytes({
      orderedTurnIds: this.#orderedTurnIds,
      turnsById: Object.fromEntries(this.#turns),
      itemsById: Object.fromEntries(this.#items),
    });
    if (bytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) return false;
    this.#timelineBytes = bytes;
    return true;
  }

  #invalidate(reason: string): ProjectionApplication {
    this.#invalidated = true;
    return { kind: "resnapshot_required", reason };
  }
}

function isPrefix(
  prefix: readonly string[],
  complete: readonly string[],
): boolean {
  return (
    prefix.length <= complete.length &&
    prefix.every((value, index) => complete[index] === value)
  );
}

function equalBackendTurn(left: BackendTurn, right: BackendTurn): boolean {
  return (
    left.backendTurnId === right.backendTurnId &&
    left.status === right.status &&
    left.endedBy === right.endedBy &&
    JSON.stringify(left.failure) === JSON.stringify(right.failure) &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.orderedBackendItemIds.length === right.orderedBackendItemIds.length &&
    left.orderedBackendItemIds.every(
      (value, index) => right.orderedBackendItemIds[index] === value,
    )
  );
}

function equalConversationTurn(
  left: ConversationTurn,
  right: ConversationTurn,
): boolean {
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.endedBy === right.endedBy &&
    JSON.stringify(left.failure) === JSON.stringify(right.failure) &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.orderedItemIds.length === right.orderedItemIds.length &&
    left.orderedItemIds.every(
      (value, index) => right.orderedItemIds[index] === value,
    )
  );
}
