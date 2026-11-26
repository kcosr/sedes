import { MAX_EARLY_REPLY_BYTES } from "../../shared/protocol/early-reply.js";
import type { BackendConversationEvent } from "../../shared/protocol/backend.js";
import type { ConversationProjector } from "./conversation-projector.js";

export interface EarlyReplySource {
  readonly applicationTurnId: string;
  readonly applicationItemId: string;
  readonly backendCorrelations: readonly string[];
}

type NonFinalPhase = "provisional" | "partial" | "unclassified";
export interface EarlyReplyObservation {
  observe(text: string, precedingPhases: readonly NonFinalPhase[]): void;
  finish(reason: "item_done" | "source_changed" | "authority_lost" | "superseded"): void;
}

export type CaptureEarlyReply = (source: EarlyReplySource) => EarlyReplyObservation | null | undefined;

/** Tracks only the first continuously observed final assistant item in the active turn. */
export class LiveFinalReplyTracker {
  #attemptedTurn?: string;
  #active?: {
    readonly source: EarlyReplySource;
    readonly backendItemId: string;
    readonly backendTurnId: string;
    readonly generation: string;
    readonly observation: EarlyReplyObservation;
    itemClosed: boolean;
    previousText: string;
    precedingPhases: NonFinalPhase[];
  };

  constructor(private readonly capture: CaptureEarlyReply) {}

  #precedingPhases(projector: ConversationProjector, turnId: string): NonFinalPhase[] {
    const phases = new Set<NonFinalPhase>();
    for (const assistant of projector.assistantItemsForTurn(turnId)) {
      if (assistant.responsePhase !== "final" && assistant.markdown.text.trim()) {
        phases.add(assistant.responsePhase ?? "unclassified");
      }
    }
    return [...phases];
  }

  finish(reason: Parameters<EarlyReplyObservation["finish"]>[0]): void {
    const current = this.#active;
    this.#active = undefined;
    try { current?.observation.finish(reason); }
    catch { /* Voice observation cannot invalidate the provider projection. */ }
  }

  accept(
    event: BackendConversationEvent,
    projector: ConversationProjector,
    activeTurnId: string | undefined,
    supported: boolean,
    newItemStart: boolean,
  ): void {
    const current = this.#active;
    if (current && (event.type === "turn_completed" || event.type === "turn_updated") &&
        event.turn.backendTurnId === current.backendTurnId && event.turn.status !== "in_progress") {
      if (current.itemClosed && event.turn.status === "completed") this.#active = undefined;
      else this.finish(event.turn.status === "completed" ? "item_done" : "authority_lost");
      return;
    }
    if (!supported || projector.runState !== "running" ||
        (current && (current.generation !== projector.generation || activeTurnId !== current.source.applicationTurnId))) {
      this.finish("authority_lost");
      return;
    }
    if (current && event.type === "turn_updated" && event.turn.backendTurnId === current.backendTurnId &&
        !current.source.backendCorrelations.some(id => event.turn.completionCorrelations?.includes(id))) {
      this.finish("authority_lost");
      return;
    }
    if (event.type !== "item_started" && event.type !== "item_updated" && event.type !== "item_completed") return;
    const item = event.item;
    if (current && current.backendItemId !== item.backendItemId) {
      // Another section may become nonempty while the first offer is still
      // waiting for durable admission. Refresh that pending offer's phase evidence.
      if (!current.itemClosed && current.backendTurnId === item.backendTurnId && item.semanticKind === "assistant_message") {
        if (item.responsePhase === "final" && projector.assistantItemsForTurn(current.backendTurnId)
            .find(candidate => candidate.responsePhase === "final")?.backendItemId !== current.backendItemId) {
          this.finish("source_changed");
          return;
        }
        current.precedingPhases = this.#precedingPhases(projector, current.backendTurnId);
        try { current.observation.observe(current.previousText, current.precedingPhases); }
        catch { this.finish("authority_lost"); }
      }
      return;
    }
    if (!current && (!newItemStart || event.type !== "item_started" || !event.liveFinalStart ||
        item.backendTurnId === this.#attemptedTurn)) return;
    const turn = projector.backendTurnById(item.backendTurnId);
    const projectedItem = projector.itemForBackendId(item.backendItemId);
    if (!turn?.completionCorrelations?.length || turn.status !== "in_progress" || !projectedItem ||
        activeTurnId !== projectedItem.turnId ||
        (current && !current.source.backendCorrelations.some(id => turn.completionCorrelations!.includes(id)))) {
      this.finish("authority_lost");
      return;
    }
    if (item.semanticKind !== "assistant_message" || item.responsePhase !== "final") {
      this.finish("source_changed");
      return;
    }
    if (!current) {
      const firstFinal = projector.assistantItemsForTurn(turn.backendTurnId).find(candidate => candidate.responsePhase === "final");
      if (firstFinal?.backendItemId !== item.backendItemId) return;
      this.#attemptedTurn = turn.backendTurnId;
      const source: EarlyReplySource = {
        applicationTurnId: projectedItem.turnId,
        applicationItemId: projectedItem.id,
        backendCorrelations: Object.freeze([...turn.completionCorrelations]),
      };
      let observation: EarlyReplyObservation | null | undefined;
      try { observation = this.capture(source); }
      catch { return; }
      if (!observation) return;
      this.#active = { source, backendItemId: item.backendItemId, backendTurnId: turn.backendTurnId,
        generation: projector.generation, observation, itemClosed: false, previousText: "", precedingPhases: this.#precedingPhases(projector, turn.backendTurnId) };
    }
    const active = this.#active!;
    // Two units cover scanner grapheme lookahead. The extra unit reports a
    // limit even for one enormous delta, without retaining the entire reply.
    const text = item.markdown.text.slice(0, MAX_EARLY_REPLY_BYTES + 3);
    if (!text.startsWith(active.previousText)) {
      this.finish("source_changed");
      return;
    }
    if (item.status === "completed") {
      if (!active.itemClosed) {
        active.itemClosed = true;
        // Yield buffered output now. Retain cancellation authority until the
        // turn settles, in case this projection or its owner disappears first.
        try { active.observation.finish("item_done"); }
        catch { this.finish("authority_lost"); }
      }
      return;
    }
    if (item.status !== "streaming" || active.itemClosed) {
      this.finish("authority_lost");
      return;
    }
    active.previousText = text;
    try { active.observation.observe(text, active.precedingPhases); }
    catch { this.finish("authority_lost"); }
  }
}

/** Freeze the recipient at capture time and coalesce text behind preceding durable submission observers. */
export function afterSubmissionAdmission(
  sink: EarlyReplyObservation, admission: Promise<void>, lifetime: AbortSignal, isCurrent: () => boolean,
): EarlyReplyObservation {
  let finished: Parameters<EarlyReplyObservation["finish"]>[0] | undefined;
  let admitted = false;
  let pending: Parameters<EarlyReplyObservation["observe"]> | undefined;
  const observation: EarlyReplyObservation = {
    observe(text, phases) {
      if (finished) return;
      if (!isCurrent()) return observation.finish("authority_lost");
      if (admitted) sink.observe(text, phases);
      else pending = [text, phases];
    },
    finish(reason) {
      if (finished && (finished !== "item_done" || reason === "item_done")) return;
      finished = reason;
      pending = undefined;
      lifetime.removeEventListener("abort", retire);
      sink.finish(reason);
    },
  };
  const retire = () => {
    try { observation.finish("authority_lost"); }
    catch { /* Voice observation is passive. */ }
  };
  lifetime.addEventListener("abort", retire, { once: true });
  if (lifetime.aborted) retire();
  void admission.then(() => {
    if (finished) return;
    admitted = true;
    if (pending) {
      const [text, phases] = pending;
      pending = undefined;
      observation.observe(text, phases);
    }
  }).catch(retire);
  return observation;
}
