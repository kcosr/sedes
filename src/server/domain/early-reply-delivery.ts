import { MAX_EARLY_REPLY_FRAMES, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";

type OpenReply = Pick<EarlyReplyFrame, "replyId" | "threadId" | "turnId" | "itemId" | "generation" | "seq">;
const MAX_REPLIES_PER_RESERVATION = 4096;

/**
 * The source scanner can expire before the terminal arrives. Retain only the
 * identifiers needed for that decision, including the exact recipient's sequence
 * (it can opt out while others continue). Disconnect destroys the whole ledger.
 */
export class EarlyReplyDelivery {
  readonly #open = new Map<string, OpenReply>();
  readonly #suppressed = new Set<string>();

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
    const seq = prior?.seq ?? 0;
    if (seq > MAX_EARLY_REPLY_FRAMES - 1) return false;
    if (frame.kind === "append" && seq !== frame.seq) return false;
    const outgoing = frame.kind === "yield" || frame.kind === "cancel" ? {...frame, seq} : frame;
    if (!deliver(outgoing)) return false;
    this.#open.set(replyId, {replyId, threadId, turnId, itemId, generation, seq: seq + 1});
    return true;
  }

  terminal(replyId: string, delivered: boolean, send: (frame: EarlyReplyFrame) => boolean): void {
    const reply = this.#open.get(replyId);
    if (!reply) return;
    this.#open.delete(replyId);
    if (delivered) return;
    this.#suppressed.add(replyId);
    send({...reply, kind: "cancel", reason: "publication_suppressed"});
  }
}
