import { MAX_EARLY_REPLY_FRAMES, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";

type OpenReply = {
  readonly event: Extract<EarlyReplyFrame, {kind: "begin"}>["event"];
  readonly progressParkRevision?: number;
  readonly identity: Pick<EarlyReplyFrame, "replyId" | "threadId" | "turnId" | "itemId" | "generation" | "seq">;
};
const MAX_REPLIES_PER_RESERVATION = 4096;

/**
 * The source scanner can expire before the terminal arrives. Retain only the
 * identifiers needed for that decision, including the exact recipient's sequence
 * (it can opt out while others continue). Disconnect destroys the whole ledger.
 */
export class EarlyReplyDelivery {
  readonly #open = new Map<string, OpenReply>();
  readonly #suppressed = new Set<string>();

  hasOpen(replyId: string): boolean {
    return this.#open.has(replyId);
  }

  *openProgressForTurn(threadId: string, turnId: string): Iterable<string> {
    for (const reply of this.#open.values()) {
      if (reply.event === "turn.progress" && reply.identity.threadId === threadId && reply.identity.turnId === turnId) yield reply.identity.replyId;
    }
  }

  discardParkedProgress(threadId: string, revision: number, send: (frame: EarlyReplyFrame) => boolean): void {
    for (const [replyId, reply] of this.#open) {
      if (reply.identity.threadId === threadId && reply.event === "turn.progress" &&
          reply.progressParkRevision !== undefined && reply.progressParkRevision < revision) this.terminal(replyId, false, send);
    }
  }

  mayOpen(replyId: string): boolean {
    return !this.#open.has(replyId) && !this.#suppressed.has(replyId) &&
      this.#open.size + this.#suppressed.size < MAX_REPLIES_PER_RESERVATION;
  }

  mayDeliverTerminal(replyId: string): boolean {
    return !this.#suppressed.has(replyId);
  }

  send(frame: EarlyReplyFrame, deliver: (frame: EarlyReplyFrame) => boolean): boolean {
    const {replyId, threadId, turnId, itemId, generation} = frame;
    const prior = this.#open.get(replyId);
    if (frame.kind === "begin" ? !this.mayOpen(replyId) : !prior) return false;
    const seq = prior?.identity.seq ?? 0;
    if (seq > MAX_EARLY_REPLY_FRAMES - 1) return false;
    if (frame.kind === "append" && seq !== frame.seq) return false;
    // An opted-out reservation can still receive a control frame after missing appends.
    // Only recipients that received the entire item can flush their below-minimum tail.
    let outgoing = frame;
    if (frame.kind === "yield") {
      const reason = frame.reason === "item_done" && seq !== frame.seq ? "observation_ended" : frame.reason;
      outgoing = {...frame, seq, reason};
    } else if (frame.kind === "cancel") outgoing = {...frame, seq};
    if (!deliver(outgoing)) return false;
    this.#open.set(replyId, {
      event: frame.kind === "begin" ? frame.event : prior!.event,
      progressParkRevision: frame.kind === "begin" ? frame.progressParkRevision : prior!.progressParkRevision,
      identity: {replyId, threadId, turnId, itemId, generation, seq: seq + 1},
    });
    return true;
  }

  terminal(replyId: string, delivered: boolean, send: (frame: EarlyReplyFrame) => boolean): void {
    const reply = this.#open.get(replyId);
    if (!reply) return;
    this.#open.delete(replyId);
    if (delivered) return;
    this.#suppressed.add(replyId);
    send({...reply.identity, kind: "cancel", reason: "publication_suppressed"});
  }
}
