import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { earlyReplyAnnouncement, MAX_EARLY_REPLY_BYTES, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";
import type { VoiceNotification } from "../../shared/protocol/notification.js";
import { electronSpeechText, notificationMessageParts, prepareSpeechParts, resultParts, voiceChunkRanges } from "./electron-voice-policy.js";
import type { NativeEarlyReplyPlaybackMode, NativeVoiceSettings } from "./native-voice-plugin.js";

type Begin = Extract<EarlyReplyFrame, { kind: "begin" }>;
const encoder = new TextEncoder();
const digest = (text: string) => bytesToHex(sha256(encoder.encode(text)));
const minimumWords = { responsive: 6, balanced: 15, natural: 15 };
const longParagraphWords = 60;
const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });

function wordCount(text: string, maximum = Infinity): number {
  let count = 0;
  let previousEnd = -1;
  for (const { segment, index } of wordSegmenter.segment(text)) {
    if (!/[\p{L}\p{N}]/u.test(segment)) continue;
    // ICU can separate compounds, contractions and numeric suffixes such as the ² in m².
    const joinedWord = previousEnd >= 0 && /^['‘’‐‑-]$/u.test(text.slice(previousEnd, index));
    const numericSuffix = index === previousEnd && /^\p{No}+$/u.test(segment);
    if (!joinedWord && !numericSuffix) {
      count++;
      if (count === maximum) break;
    }
    previousEnd = index + segment.length;
  }
  return count;
}

interface Frontier {
  rawEnd: number;
  rawHash: string;
  preparedEnd: number;
  preparedHash: string;
}
export interface EarlySpeechChunk { text: string; frontier?: Frontier; preambleEnd?: number }

/** Live source and physical request cursors are discarded when a reply gives up its queue position.
 * Only verified, fully drained chunks advance its compact receipt. */
export class ElectronEarlyReply {
  readonly identity: Pick<Begin, "replyId" | "event" | "threadId" | "threadTitle" | "turnId" | "itemId" | "generation" | "userInputRevision" | "origin">;
  readonly openedAt: number;
  lastSpanAt: number;
  raw = "";
  rawBytes = 0;
  retired = false;
  #yield?: Extract<EarlyReplyFrame, { kind: "yield" }>["reason"] | "presentation";
  get yielded(): boolean { return this.#yield !== undefined; }
  suppressed = false;
  preambleEnd = 0;
  #preamble = "";
  frontier?: Frontier;
  timer?: ReturnType<typeof setTimeout>;
  /** A notification or new group can wake a starved worker or stage its next request. */
  changed?: () => void;
  cancelLookahead?: () => void;
  readonly #frames = new Map<number, string>();
  readonly #ends: Array<{ end: number; paragraph: boolean; totalWords: number; paragraphWords: number }> = [];
  #presentation?: Pick<NativeVoiceSettings, "cleanSpeechText" | "speechContent">;
  #nextSentence = 0;
  #qualifiedThrough = -1;
  #prepared = "";
  #partialSentence?: string;
  #preambleChunks: EarlySpeechChunk[] = [];
  constructor(frame: Begin, now: number, readonly streamId: string) {
    const { replyId, event, threadId, threadTitle, turnId, itemId, generation, userInputRevision, origin } = frame;
    this.identity = { replyId, event, threadId, threadTitle, turnId, itemId, generation, userInputRevision, origin };
    this.openedAt = this.lastSpanAt = now;
    this.receive(frame, now);
  }
  receive(frame: EarlyReplyFrame, now: number): "invalid" | "ignored" | "accepted" {
    if (frame.threadId !== this.identity.threadId || frame.turnId !== this.identity.turnId ||
        frame.itemId !== this.identity.itemId || frame.generation !== this.identity.generation) return "invalid";
    // A device formatter can yield while the server still owns a live stream.
    // Its later spans cannot affect the current speaker, but its cancellation
    // remains authoritative regardless of how many spans we ignored.
    if (this.#yield === "presentation") return frame.kind === "cancel" ? "accepted" : "ignored";
    const signature = digest(JSON.stringify(frame));
    const previous = this.#frames.get(frame.seq);
    if (previous) return previous === signature ? "ignored" : "invalid";
    if (this.retired || this.yielded && frame.kind !== "cancel" || frame.seq !== this.#frames.size) return "invalid";
    if (frame.kind === "begin" || frame.kind === "append") {
      const bytes = encoder.encode(frame.text).length;
      if (frame.rawStart !== this.raw.length || this.rawBytes + bytes > MAX_EARLY_REPLY_BYTES) return "invalid";
      if (frame.text) {
        const previous = this.#ends.at(-1);
        const words = wordCount(frame.text);
        this.#ends.push({ end: frame.rawEnd, paragraph: frame.paragraphEnd, totalWords: (previous?.totalWords ?? 0) + words,
          paragraphWords: (previous && !previous.paragraph ? previous.paragraphWords : 0) + words });
      } else {
        const last = this.#ends.at(-1);
        if (!last || last.paragraph) return "invalid";
        last.paragraph = true;
      }
      this.raw += frame.text; this.rawBytes += bytes;
      this.lastSpanAt = now;
    } else if (frame.kind === "yield") this.#yield = frame.reason;
    this.#frames.set(frame.seq, signature);
    return "accepted";
  }

  presentationSettings(settings: NativeVoiceSettings): NativeVoiceSettings {
    // Input and announcements-only remain authoritative device restrictions.
    if (!this.#presentation || settings.audioMode !== "speak" || settings.speechContent === "announcements") return settings;
    return { ...settings, ...this.#presentation };
  }

  #preparedThrough(index: number, clean: boolean): string {
    if (index === this.#nextSentence && this.#partialSentence !== undefined) return this.#partialSentence;
    return electronSpeechText(this.raw.slice(0, this.#ends[index]!.end), clean);
  }

  #bodyEnd(mode: Exclude<NativeEarlyReplyPlaybackMode, "off">, clean: boolean, limit: number): number | undefined {
    const first = this.#nextSentence;
    const eligible: number[] = [];
    const previousWords = this.#partialSentence === undefined ? this.#ends[first - 1]?.totalWords ?? 0
      : this.#ends[first]!.totalWords - wordCount(this.#partialSentence.slice(this.#prepared.length), minimumWords[mode]);
    // A qualified group can span several physical requests. Its remaining
    // sentences are already eligible, even if its last request is short.
    for (let index = first; index < this.#ends.length; index++) {
      const span = this.#ends[index]!;
      // Only item_done guarantees the full message. A partial yield can close a group at
      // this boundary, but a short prefix must wait to join the terminal continuation.
      if (index <= this.#qualifiedThrough || this.#yield === "item_done" || span.totalWords - previousWords >= minimumWords[mode] &&
          (this.yielded || mode !== "natural" || span.paragraph || span.paragraphWords >= longParagraphWords)) eligible.push(index);
    }
    if (!eligible.length) return;
    const firstEligible = eligible[0]!, lastEligible = eligible.at(-1)!;
    if (first === lastEligible) return first;

    // Measure prepared speech, including normalized paragraph separators. A
    // large backlog only needs logarithmically many cumulative Markdown renders.
    const fits = (index: number) => this.#preparedThrough(index, clean)
      .slice(this.#prepared.length).trimStart().length <= limit;
    if (fits(lastEligible)) return lastEligible;
    let low = first, high = lastEligible - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) low = middle + 1;
      else high = middle - 1;
    }
    const fitting = eligible.findLast(index => index <= high);
    if (fitting !== undefined) return fitting;
    this.#qualifiedThrough = Math.max(this.#qualifiedThrough, firstEligible);
    return Math.max(first, high);
  }

  /** Requests are planned from exact cumulative Markdown, including separators supplied across frames. */
  next(settings: NativeVoiceSettings, mode: NativeEarlyReplyPlaybackMode, limit: number): EarlySpeechChunk | undefined {
    if (this.#preambleChunks.length) return this.#preambleChunks.shift();
    if (this.retired || this.#yield === "presentation" || mode === "off") return;
    if (!this.#presentation && settings.speechContent === "both") {
      this.#presentation = { cleanSpeechText: settings.cleanSpeechText, speechContent: settings.speechContent };
      this.#preamble = prepareSpeechParts([earlyReplyAnnouncement(this.identity.event), this.identity.threadTitle], settings);
      for (const chunk of voiceChunkRanges(this.#preamble, limit)) {
        this.#preambleChunks.push({ text: chunk.text, preambleEnd: chunk.end });
      }
      return this.#preambleChunks.shift();
    }
    const endIndex = this.#bodyEnd(mode, settings.cleanSpeechText, limit);
    if (endIndex === undefined) return;
    const end = this.#ends[endIndex]!.end;
    const raw = this.raw.slice(0, end);
    const prepared = this.#preparedThrough(endIndex, settings.cleanSpeechText);
    if (!prepared.startsWith(this.#prepared)) {
      this.#yield = "presentation"; return;
    }
    const addition = prepared.slice(this.#prepared.length).trimStart();
    const chunk = voiceChunkRanges(addition, limit).next().value;
    const offset = chunk ? prepared.length - addition.length + chunk.end : prepared.length;
    this.#prepared = prepared.slice(0, offset);
    if (offset === prepared.length) {
      this.#nextSentence = endIndex + 1;
      this.#partialSentence = undefined;
    } else {
      // Only commit this request. The remainder can share the next request with
      // a later sentence that arrives before the next lookahead slot opens.
      this.#partialSentence = prepared;
      this.#qualifiedThrough = Math.max(this.#qualifiedThrough, endIndex);
    }
    if (!chunk) return;
    this.#presentation ??= { cleanSpeechText: settings.cleanSpeechText, speechContent: settings.speechContent };
    // When cleanup changes offsets, verify the raw group and the exact prepared
    // prefix delivered by this request. A 1:1 source also has a raw inner offset.
    const rawEnd = prepared === raw.trimEnd() ? offset : end;
    return { text: chunk.text, frontier: { rawEnd, rawHash: digest(raw.slice(0, rawEnd)), preparedEnd: offset,
      preparedHash: digest(this.#prepared) } };
  }

  matches(final: string, clean: boolean, frontier = this.frontier): boolean {
    if (!frontier) return true;
    const prepared = electronSpeechText(final, clean);
    return final.length >= frontier.rawEnd && prepared.length >= frontier.preparedEnd &&
      digest(final.slice(0, frontier.rawEnd)) === frontier.rawHash && digest(prepared.slice(0, frontier.preparedEnd)) === frontier.preparedHash;
  }
  sealedSection(notice: VoiceNotification) {
    return this.identity.event === "turn.progress" ? notice.payload.progress : notice.payload.assistantResult?.final;
  }
  canPromoteBody(notice: VoiceNotification, settings: NativeVoiceSettings, lastOwner: string | undefined): boolean {
    if (settings.speechContent === "announcements" || (settings.speechContent === "both" && lastOwner !== this.identity.replyId)) return false;
    // Until a final-body request drains, speech follows the terminal's selected phase order.
    // Two phases can start with identical words.
    return !!this.frontier || this.identity.event !== "turn.completed" ||
      !resultParts(notice.payload.assistantResult, "beforeFinal").some(text => electronSpeechText(text, settings.cleanSpeechText));
  }
  /** Null requests the ordinary context-first renderer. Each returned part is already formatted. */
  continuation(notice: VoiceNotification, settings: NativeVoiceSettings, lastAudibleOwner: string | undefined): string[] | null {
    if (settings.audioMode !== "speak" || !this.frontier && !this.preambleEnd) return null;
    const remainingPreamble = this.#preamble.slice(this.preambleEnd).trimStart();
    const sameSpeaker = lastAudibleOwner === this.identity.replyId;
    if (settings.speechContent === "announcements") {
      if (!this.preambleEnd) return null;
      if (!remainingPreamble) return [];
      return sameSpeaker ? [remainingPreamble] : null;
    }
    const clean = (text: string) => electronSpeechText(text, settings.cleanSpeechText);
    const section = this.sealedSection(notice), raw = section?.text ?? "";
    let body: string[];
    if (this.frontier && this.matches(raw, settings.cleanSpeechText)) {
      body = [clean(raw).slice(this.frontier.preparedEnd).trimStart()];
      if (section?.truncation) body.push("The remaining response was truncated.");
      body.push(...resultParts(notice.payload.assistantResult, "beforeFinal").map(clean));
    } else {
      // A corrected answer restarts its body. The preamble has its own playback receipt.
      body = notificationMessageParts(notice.payload).map(clean);
    }
    if (settings.speechContent !== "both" || !body.some(Boolean)) return body;
    const preamble = sameSpeaker ? remainingPreamble
      : prepareSpeechParts([notice.payload.title, notice.payload.message], settings);
    return [preamble, ...body];
  }
  detach(): void {
    this.retired = true; clearTimeout(this.timer); this.timer = undefined;
    this.raw = ""; this.rawBytes = 0;
    this.#partialSentence = undefined; this.#prepared = ""; this.#frames.clear(); this.#ends.length = 0; this.#preambleChunks.length = 0;
    this.cancelLookahead?.(); this.cancelLookahead = undefined;
    this.changed?.(); this.changed = undefined;
  }
}
