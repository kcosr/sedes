import { recordVoiceDiagnostic } from "../diagnostics/voice-diagnostics.js";
import { MAX_EARLY_REPLY_FRAMES, earlyReplyFrameSchema, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";
import type { NotificationAssistantResultPhase } from "../../shared/protocol/notification.js";
import type { EarlyReplyObservation } from "../conversations/early-reply-observation.js";
import { EarlyReplyScanner } from "../conversations/early-reply-scanner.js";
import type { RequestScope } from "../identity/identity-provider.js";

const MAX_LIFETIME_MS = 600_000;
const MAX_STALL_MS = 60_000;

type YieldReason = Extract<EarlyReplyFrame, {kind: "yield"}>["reason"];
type CancelReason = Extract<EarlyReplyFrame, {kind: "cancel"}>["reason"];

export type EarlyReplyAuthority = {
  readonly threadTitle: string;
  readonly origin?: {readonly clientId: string};
  readonly userInputRevision: number;
  /** Checked on the ordered actor rail, after preceding submission admission. */
  readonly admitted: () => boolean;
  /** Re-evaluate durable input after admission and before publishing new speech. */
  readonly fresh: () => boolean;
};

type Recipient = {readonly voiceStreamId: string; send(frame: EarlyReplyFrame): boolean};

export class EarlyReplyPublication implements EarlyReplyObservation {
  readonly #capturedAt = performance.now();
  readonly #scanner = new EarlyReplyScanner();
  readonly #candidates: Set<Recipient>;
  readonly #opened = new Set<Recipient>();
  #seq = 0;
  #publishing = true;
  #cancelled = false;
  #initialAuthorityChecked = false;
  readonly #absolute: NodeJS.Timeout;
  #stallDeadline = 0;
  #inactivity?: NodeJS.Timeout;

  constructor(
    readonly scope: RequestScope, readonly threadId: string, readonly turnId: string, readonly itemId: string,
    readonly generation: number, readonly replyId: string, readonly phases: readonly NotificationAssistantResultPhase[],
    recipients: readonly Recipient[], private readonly authority: EarlyReplyAuthority, private readonly policyCurrent: () => boolean,
    private readonly onRetired: () => void,
  ) {
    this.#candidates = new Set(recipients);
    recordVoiceDiagnostic("early_reply_captured", {
      sourceEventId: this.replyId, recipientCount: this.#candidates.size,
    });
    this.#absolute = setTimeout(() => {
      this.cancel("expired");
      this.dispose();
    }, MAX_LIFETIME_MS).unref();
    this.#armStall();
  }

  #armStall(): void {
    clearTimeout(this.#inactivity);
    this.#stallDeadline = performance.now() + MAX_STALL_MS;
    this.#inactivity = setTimeout(() => this.yield("stall"), MAX_STALL_MS).unref();
  }

  observe(text: string, precedingPhases: readonly ("partial" | "provisional" | "unclassified")[]): void {
    if (!this.#publishing) return;
    // A queued provider callback can run before a delayed timer after host suspension.
    const now = performance.now();
    if (now >= this.#capturedAt + MAX_LIFETIME_MS) {
      this.cancel("expired");
      this.dispose();
      return;
    }
    if (now >= this.#stallDeadline) { this.yield("stall"); return; }
    try {
      const result = this.#scanner.update(text);
      if (!this.#initialAuthorityChecked || result.segments.length) {
        if (!this.policyCurrent()) { this.cancel("policy_changed"); return; }
        if (!this.authority.admitted()) { this.cancel("authority_lost"); return; }
        if (!this.checkFreshness()) return;
        this.#initialAuthorityChecked = true;
      }
      for (const segment of result.segments) {
        if (this.#seq === 0 && precedingPhases.some(phase => this.phases.includes(phase))) {
          this.cancel("source_changed");
          return;
        }
        // Reserve room for yield, a later authority cancellation, and the terminal decision.
        if (this.#seq >= MAX_EARLY_REPLY_FRAMES - 2) { this.yield("limit"); return; }
        const common = this.#common();
        const frame: EarlyReplyFrame = this.#seq === 0
          ? {...common, kind: "begin", seq: 0, rawStart: 0, rawEnd: segment.rawEnd,
            text: segment.text, paragraphEnd: segment.paragraphEnd, threadTitle: this.authority.threadTitle,
            userInputRevision: this.authority.userInputRevision, ...(this.authority.origin ? {origin: this.authority.origin} : {})}
          : {...common, kind: "append", ...segment};
        earlyReplyFrameSchema.parse(frame);
        for (const recipient of this.#candidates) {
          if (recipient.send(frame)) this.#opened.add(recipient);
          else this.remove(recipient.voiceStreamId);
        }
        if (frame.kind === "begin") {
          recordVoiceDiagnostic("early_reply_first_segment", {
            sourceEventId: this.replyId, deliveredCount: this.#opened.size,
            durationMs: performance.now() - this.#capturedAt,
          });
        }
        this.#seq++;
        if (!this.#publishing) return;
        this.#armStall();
      }
      if (result.stop === "source_changed") this.cancel(result.stop);
      else if (result.stop) this.yield(result.stop);
    } catch {
      this.cancel("authority_lost");
    }
  }

  checkFreshness(): boolean {
    if (this.#cancelled) return false;
    try { if (this.authority.fresh()) return true; }
    catch { this.cancel("authority_lost"); return false; }
    this.cancel("superseded");
    return false;
  }

  finish(reason: "item_done" | "source_changed" | "authority_lost" | "superseded"): void {
    if (reason === "item_done") this.yield(reason);
    else this.cancel(reason);
  }

  #common() {
    return {replyId: this.replyId, threadId: this.threadId, turnId: this.turnId, itemId: this.itemId,
      generation: this.generation, seq: this.#seq};
  }

  yield(reason: YieldReason): void {
    if (this.#publishing) this.#stop({...this.#common(), kind: "yield", reason});
  }

  cancel(reason: CancelReason): void {
    if (!this.#cancelled) {
      this.#cancelled = true;
      this.#stop({...this.#common(), kind: "cancel", reason});
    }
  }

  #stop(frame: Extract<EarlyReplyFrame, {kind: "yield" | "cancel"}>): void {
    recordVoiceDiagnostic("early_reply_stopped", {
      sourceEventId: this.replyId, earlyReason: frame.reason, recipientCount: this.#opened.size,
      durationMs: performance.now() - this.#capturedAt,
    });
    this.#publishing = false;
    clearTimeout(this.#inactivity);
    for (const recipient of this.#opened) {
      if (!recipient.send(frame)) this.#opened.delete(recipient);
    }
    this.#seq++;
    this.#candidates.clear();
    if (!this.#opened.size) this.dispose();
  }

  /** Off removes a reservation from future appends. A live opener still needs its terminal decision. */
  remove(voiceStreamId: string, disconnected = true): void {
    for (const recipient of this.#candidates) {
      if (recipient.voiceStreamId === voiceStreamId) this.#candidates.delete(recipient);
    }
    if (disconnected) for (const recipient of this.#opened) {
      if (recipient.voiceStreamId === voiceStreamId) this.#opened.delete(recipient);
    }
    if (!this.#candidates.size) {
      this.#publishing = false;
      clearTimeout(this.#inactivity);
      if (!this.#opened.size) this.dispose();
    }
  }

  dispose(): void {
    this.#publishing = false;
    this.#cancelled = true;
    clearTimeout(this.#absolute);
    clearTimeout(this.#inactivity);
    this.#candidates.clear();
    this.#opened.clear();
    this.onRetired();
  }
}
