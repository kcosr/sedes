import { MAX_EARLY_REPLY_BYTES } from "../../shared/protocol/early-reply.js";
import type { BackendCapabilityDocument, BackendConversationEvent, BackendItem, BackendTurn } from "../../shared/protocol/backend.js";
import type { ConversationProjector } from "./conversation-projector.js";

export interface EarlyReplySource {
  readonly event: "turn.completed" | "turn.progress";
  readonly applicationTurnId: string;
  readonly applicationItemId: string;
  readonly backendCorrelations: readonly string[];
}

type NonFinalPhase = "provisional" | "partial" | "unclassified";
type IncompleteReason = "observation_ended" | "source_changed" | "authority_lost" | "superseded";
export type EarlyReplyEnd = [reason: IncompleteReason] | [reason: "item_done", text: string, precedingPhases: readonly NonFinalPhase[]];

export interface EarlyReplyObservation {
  observe(text: string, precedingPhases: readonly NonFinalPhase[]): void;
  finish(...end: EarlyReplyEnd): void;
}

export type CaptureEarlyReply = (source: EarlyReplySource) => EarlyReplyObservation | null | undefined;

type SpeechStart = "final" | "provisional";
type SpeechItemEvent = Extract<BackendConversationEvent, {type: "item_started" | "item_completed" | "item_updated"}>;

interface ObservedItem {
  readonly source: EarlyReplySource;
  readonly phase: SpeechStart;
  readonly backendItemId: string;
  readonly backendTurnId: string;
  readonly generation: string;
  readonly observation: EarlyReplyObservation;
  orderedSettlement?: "received" | "reconciling";
  pendingProgress: number;
  itemClosed: boolean;
  withdrawn: boolean;
  previousText: string;
  precedingPhases: NonFinalPhase[];
}

/** The first final answer belongs to the turn. Every commentary item has its own authoritative publication. */
export class LiveSpeechTracker {
  #attemptedFinalTurn?: string;
  readonly #items = new Map<string, ObservedItem>();

  constructor(private readonly capture: CaptureEarlyReply, private readonly skipProgress?: (source: EarlyReplySource) => void) {}

  #precedingPhases(projector: ConversationProjector, turnId: string): NonFinalPhase[] {
    const phases = new Set<NonFinalPhase>();
    for (const assistant of projector.assistantItemsForTurn(turnId)) {
      if (assistant.responsePhase !== "final" && assistant.markdown.text.trim()) {
        phases.add(assistant.responsePhase ?? "unclassified");
      }
    }
    return [...phases];
  }

  #settlesFinal(item: ObservedItem, turn: BackendTurn): boolean {
    return item.phase === "final" && turn.status === "completed" && turn.backendTurnId === item.backendTurnId &&
      turn.orderedBackendItemIds.includes(item.backendItemId) &&
      item.source.backendCorrelations.some(id => turn.completionCorrelations?.includes(id));
  }

  /** A later gap can race the application of a contiguous native item or turn completion. */
  noteOrderedSettlement(event: BackendConversationEvent): void {
    if (event.type === "turn_completed" && event.completionProvenance !== "recovered") {
      for (const item of this.#items.values()) {
        if (this.#settlesFinal(item, event.turn)) item.orderedSettlement = "received";
      }
    } else if ((event.type === "item_completed" || event.type === "item_updated") && event.liveProgress) {
      const item = this.#items.get(event.item.backendItemId);
      if (item?.phase === "provisional" && item.backendTurnId === event.item.backendTurnId) item.orderedSettlement = "received";
    }
  }

  projectionGap(): void {
    for (const item of this.#items.values()) {
      if (!item.orderedSettlement) this.#withdraw(item, "authority_lost");
      else if (item.orderedSettlement !== "reconciling") {
        item.orderedSettlement = "reconciling";
        if (!item.itemClosed && !item.withdrawn) this.#signal(item, "observation_ended");
      }
    }
  }

  #signal(item: ObservedItem, ...end: EarlyReplyEnd): void {
    try { item.observation.finish(...end); }
    catch { /* Voice observation cannot invalidate the provider projection. */ }
  }

  #withdraw(item: ObservedItem, reason: "authority_lost" | "source_changed"): void {
    if (item.phase === "final") return this.#retire(item, reason);
    // The early lane has lost authority. A later live progress event can still settle this item.
    if (!item.withdrawn) this.#signal(item, reason);
    item.withdrawn = true;
    item.previousText = "";
  }

  withdrawAuthority(): void {
    for (const item of this.#items.values()) this.#withdraw(item, "authority_lost");
  }

  /** A refresh can discover a settled turn without a corresponding live progress or terminal event. */
  settleInactiveProgress(projector: ConversationProjector): void {
    for (const item of this.#items.values()) {
      if (item.phase !== "provisional") continue;
      const turn = projector.backendTurnById(item.backendTurnId);
      if (projector.runState === "idle" || projector.runState === "failed" || (turn && turn.status !== "in_progress")) {
        this.#retire(item, "authority_lost");
      }
    }
  }

  #retire(item: ObservedItem, reason: IncompleteReason): void {
    this.#items.delete(item.backendItemId);
    if (!item.withdrawn) this.#signal(item, reason);
    if (item.phase === "provisional" && !item.pendingProgress) {
      try { this.skipProgress?.(item.source); }
      catch { /* Settlement is a passive side effect. */ }
    }
  }

  /** A control or generation can change while a qualified native close awaits submission admission. */
  resolveProgress(itemId: string, disposition: "settled" | "deferred"): void {
    for (const item of this.#items.values()) {
      if (item.phase !== "provisional" || item.source.applicationItemId !== itemId || !item.pendingProgress) continue;
      if (disposition === "settled") this.#items.delete(item.backendItemId);
      else {
        item.pendingProgress--;
        this.#withdraw(item, "authority_lost");
      }
      return;
    }
  }

  finish(reason: IncompleteReason): void {
    for (const item of this.#items.values()) this.#retire(item, reason);
  }

  accept(
    event: BackendConversationEvent, projector: ConversationProjector, activeTurnId: string | undefined,
    capabilities: BackendCapabilityDocument["liveSpeechStarts"] | undefined, continuous: boolean, receivedBeforeGap: boolean,
    newItemStart: boolean, progressScheduled: boolean,
  ): void {
    const itemEvent = event.type === "item_started" || event.type === "item_updated" || event.type === "item_completed" ? event : undefined;
    for (const current of this.#items.values()) {
      const ownItem = itemEvent?.item.backendItemId === current.backendItemId && itemEvent.item.backendTurnId === current.backendTurnId;
      const handoff = ownItem && progressScheduled;
      if ((event.type === "turn_completed" || event.type === "turn_updated") &&
          event.turn.backendTurnId === current.backendTurnId && event.turn.status !== "in_progress") {
        const confirmed = (event.type !== "turn_completed" || event.completionProvenance !== "recovered") &&
          this.#settlesFinal(current, event.turn);
        if (confirmed && current.itemClosed) this.#items.delete(current.backendItemId);
        else this.#retire(current, confirmed ? "observation_ended" : "authority_lost");
      } else if (current.phase === "provisional" && (projector.runState === "idle" || projector.runState === "failed")) {
        this.#retire(current, "authority_lost");
      } else if (current.phase === "provisional" && handoff && itemEvent) {
        this.#observe(current, itemEvent.item, true);
      } else if (current.phase === "provisional" && ownItem && itemEvent && itemEvent.type !== "item_started" &&
          itemEvent.liveProgress && itemEvent.item.semanticKind === "assistant_message" && itemEvent.item.responsePhase === "partial") {
        // A qualified partial-answer publication is independent of this commentary opening.
        this.#retire(current, "source_changed");
      } else if (!(continuous || (current.orderedSettlement === "reconciling" && receivedBeforeGap)) ||
          !capabilities?.[current.phase] || projector.runState !== "running" || current.generation !== projector.generation ||
          activeTurnId !== current.source.applicationTurnId ||
          (event.type === "turn_updated" && event.turn.backendTurnId === current.backendTurnId &&
           !current.source.backendCorrelations.some(id => event.turn.completionCorrelations?.includes(id)))) {
        this.#withdraw(current, "authority_lost");
      } else if (ownItem && itemEvent) {
        this.#observe(current, itemEvent.item, handoff);
      } else if (current.phase === "final" && !current.itemClosed && itemEvent?.item.backendTurnId === current.backendTurnId &&
          itemEvent.item.semanticKind === "assistant_message") {
        // A new nonempty section can change which phase is spoken first while the final offer awaits durable admission.
        if (itemEvent.item.responsePhase === "final" && projector.assistantItemsForTurn(current.backendTurnId)
            .find(candidate => candidate.responsePhase === "final")?.backendItemId !== current.backendItemId) {
          this.#retire(current, "source_changed");
        } else {
          current.precedingPhases = this.#precedingPhases(projector, current.backendTurnId);
          try { current.observation.observe(current.previousText, current.precedingPhases); }
          catch { this.#retire(current, "authority_lost"); }
        }
      }
    }
    if (!newItemStart || event.type !== "item_started" || !event.liveSpeechStart || !continuous ||
        !capabilities?.[event.liveSpeechStart] || projector.runState !== "running" ||
        this.#items.has(event.item.backendItemId) || this.#items.size >= 64) return;
    const phase = event.liveSpeechStart;
    const { item } = event;
    if (item.semanticKind !== "assistant_message" || item.responsePhase !== phase || item.status !== "streaming") return;
    const turn = projector.backendTurnById(item.backendTurnId);
    const projectedItem = projector.itemForBackendId(item.backendItemId);
    if (!turn?.completionCorrelations?.length || turn.status !== "in_progress" || !projectedItem || projectedItem.turnId !== activeTurnId) return;
    if (phase === "final") {
      if (turn.backendTurnId === this.#attemptedFinalTurn ||
          projector.assistantItemsForTurn(turn.backendTurnId).find(candidate => candidate.responsePhase === "final")?.backendItemId !== item.backendItemId) return;
      this.#attemptedFinalTurn = turn.backendTurnId;
    }
    const source: EarlyReplySource = {
      event: phase === "final" ? "turn.completed" : "turn.progress",
      applicationTurnId: projectedItem.turnId, applicationItemId: phase === "provisional" ? projector.durableItemId(item) : projectedItem.id,
      backendCorrelations: Object.freeze([...turn.completionCorrelations]),
    };
    let observation: EarlyReplyObservation | null | undefined;
    try { observation = this.capture(source); }
    catch { return; }
    if (!observation) return;
    const observed: ObservedItem = { source, phase, backendItemId: item.backendItemId, backendTurnId: turn.backendTurnId,
      generation: projector.generation, observation, pendingProgress: 0, itemClosed: false, withdrawn: false, previousText: "",
      precedingPhases: phase === "final" ? this.#precedingPhases(projector, turn.backendTurnId) : [] };
    this.#items.set(item.backendItemId, observed);
    this.#observe(observed, item, false);
  }

  #observe(current: ObservedItem, item: BackendItem, progressScheduled: boolean): void {
    // Keep only the scanner's bounded prefix plus grapheme lookahead and its limit sentinel.
    const text = item.semanticKind === "assistant_message" ? item.markdown.text.slice(0, MAX_EARLY_REPLY_BYTES + 3) : "";
    const changed = item.semanticKind !== "assistant_message" || item.responsePhase !== current.phase ||
      (current.itemClosed ? text !== current.previousText : !text.startsWith(current.previousText));
    if (current.phase === "provisional" && progressScheduled) {
      if (changed) this.#withdraw(current, "source_changed");
      if (!current.itemClosed && !current.withdrawn) this.#closeItem(current, text);
      current.pendingProgress++;
      return;
    }
    if (changed) {
      this.#withdraw(current, "source_changed");
      return;
    }
    if (current.phase === "provisional" && item.status !== "streaming") {
      // An unannotated close can still be followed by a genuinely qualified item_updated.
      if (item.status === "completed") this.#withdraw(current, "authority_lost");
      else this.#retire(current, "authority_lost");
      return;
    }
    if (current.withdrawn) return;
    if (item.status === "completed") {
      if (!current.itemClosed) this.#closeItem(current, text);
    } else if (item.status !== "streaming" || current.itemClosed) {
      this.#retire(current, "authority_lost");
    } else {
      current.previousText = text;
      try { current.observation.observe(text, current.precedingPhases); }
      catch { this.#withdraw(current, "authority_lost"); }
    }
  }

  #closeItem(current: ObservedItem, text: string): void {
    current.itemClosed = true;
    current.previousText = text;
    this.#signal(current, "item_done", text, current.precedingPhases);
  }
}

/** Freeze the recipient at capture time and coalesce text behind preceding durable submission observers. */
export function afterSubmissionAdmission(
  sink: EarlyReplyObservation, admission: Promise<void>, isCurrent: () => boolean,
): EarlyReplyObservation {
  let finished: EarlyReplyEnd[0] | undefined;
  let admitted = false;
  let pending: Parameters<EarlyReplyObservation["observe"]> | undefined;
  const observation: EarlyReplyObservation = {
    observe(text, phases) {
      if (finished) return;
      if (!isCurrent()) return observation.finish("authority_lost");
      if (admitted) sink.observe(text, phases);
      else pending = [text, phases];
    },
    finish(...end) {
      const [reason] = end;
      if (finished && (finished !== "item_done" && finished !== "observation_ended" ||
          reason === "item_done" || reason === "observation_ended")) return;
      pending = undefined;
      // Before admission no recipient has opened. Never release buffered prose on a late admission.
      if (reason === "item_done" && !admitted) end = ["observation_ended"];
      else if (reason === "item_done" && !isCurrent()) end = ["authority_lost"];
      finished = end[0];
      sink.finish(...end);
    },
  };
  void admission.then(() => {
    if (finished) return;
    admitted = true;
    if (pending) {
      const [text, phases] = pending;
      pending = undefined;
      observation.observe(text, phases);
    }
  }).catch(() => {
    try { observation.finish("authority_lost"); }
    catch { /* Voice observation is passive. */ }
  });
  return observation;
}
