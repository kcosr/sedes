import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { earlyReplyAnnouncement, MAX_EARLY_REPLY_BYTES, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";
import type { VoiceNotification } from "../../shared/protocol/notification.js";
import { electronSpeechText, notificationMessageParts, prepareSpeechParts, voiceChunkRanges } from "./electron-voice-policy.js";
import type { NativeEarlyReplyPlaybackMode, NativeVoiceSettings } from "./native-voice-plugin.js";

type Begin = Extract<EarlyReplyFrame, { kind: "begin" }>;
const encoder = new TextEncoder();
const digest = (text: string) => bytesToHex(sha256(encoder.encode(text)));

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
  #yield: "none" | "server" | "presentation" = "none";
  get yielded(): boolean { return this.#yield !== "none"; }
  suppressed = false;
  preambleEnd = 0;
  #preamble = "";
  frontier?: Frontier;
  timer?: ReturnType<typeof setTimeout>;
  /** A notification or new group can wake a starved worker or stage its next request. */
  changed?: () => void;
  cancelLookahead?: () => void;
  readonly #frames = new Map<number, string>();
  readonly #ends: Array<{ end: number; paragraph: boolean }> = [];
  #presentation?: Pick<NativeVoiceSettings, "cleanSpeechText" | "speechContent">;
  #nextSentence = 0;
  #prepared = "";
  #physical: EarlySpeechChunk[] = [];
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
      if (frame.text) this.#ends.push({ end: frame.rawEnd, paragraph: frame.paragraphEnd });
      else {
        const last = this.#ends.at(-1);
        if (!last || last.paragraph) return "invalid";
        last.paragraph = true;
      }
      this.raw += frame.text; this.rawBytes += bytes;
      this.lastSpanAt = now;
    } else if (frame.kind === "yield") this.#yield = "server";
    this.#frames.set(frame.seq, signature);
    return "accepted";
  }

  presentationSettings(settings: NativeVoiceSettings): NativeVoiceSettings {
    // Input and announcements-only remain authoritative device restrictions.
    if (!this.#presentation || settings.audioMode !== "speak" || settings.speechContent === "announcements") return settings;
    return { ...settings, ...this.#presentation };
  }

  /** Requests are planned from exact cumulative Markdown, including separators supplied across frames. */
  next(settings: NativeVoiceSettings, mode: NativeEarlyReplyPlaybackMode, limit: number): EarlySpeechChunk | undefined {
    if (this.#physical.length) return this.#physical.shift();
    const first = this.#nextSentence, start = first ? this.#ends[first - 1]!.end : 0;
    let endIndex = first;
    const firstSentence = this.#ends[first];
    if (!firstSentence || this.retired || this.#yield === "presentation" || mode === "off") return;
    if (mode === "balanced" && first > 0) {
      while (!this.#ends[endIndex]!.paragraph && this.#ends[endIndex + 1] && this.#ends[endIndex + 1]!.end - start <= 240) endIndex++;
    } else if (mode === "natural") {
      while (!this.#ends[endIndex]!.paragraph && this.#ends[endIndex]!.end - start < 320) {
        if (!this.#ends[endIndex + 1]) { if (!this.yielded) return; break; }
        endIndex++;
      }
    }
    const end = this.#ends[endIndex]!.end;
    const raw = this.raw.slice(0, end);
    const prepared = electronSpeechText(raw, settings.cleanSpeechText);
    if (!prepared.startsWith(this.#prepared)) {
      this.#yield = "presentation"; return;
    }
    if (!first && settings.speechContent === "both") {
      this.#preamble = prepareSpeechParts([earlyReplyAnnouncement(this.identity.event), this.identity.threadTitle], settings);
      for (const chunk of voiceChunkRanges(this.#preamble, limit)) {
        this.#physical.push({ text: chunk.text, preambleEnd: chunk.end });
      }
    }
    const addition = prepared.slice(this.#prepared.length).trimStart();
    const startOffset = prepared.length - addition.length;
    const directMapping = prepared === raw.trimEnd();
    for (const chunk of voiceChunkRanges(addition, limit)) {
      const offset = startOffset + chunk.end;
      // Most prose maps 1:1, including chunks within long groups. For Markdown
      // whose cleanup changes offsets, verify the complete group and inner spoken offset.
      const rawEnd = directMapping ? offset : end;
      this.#physical.push({ text: chunk.text, frontier: { rawEnd, rawHash: digest(raw.slice(0, rawEnd)), preparedEnd: offset,
        preparedHash: digest(prepared.slice(0, offset)) } });
    }
    this.#nextSentence = endIndex + 1; this.#prepared = prepared;
    if (this.#physical.length) this.#presentation ??= { cleanSpeechText: settings.cleanSpeechText, speechContent: settings.speechContent };
    return this.#physical.shift();
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
  /** Null requests the ordinary context-first renderer. Each returned part is already formatted. */
  continuation(notice: VoiceNotification, settings: NativeVoiceSettings, lastAudibleOwner: string | undefined): string[] | null {
    if (settings.audioMode !== "speak" || !this.frontier && !this.preambleEnd) return null;
    const remainingPreamble = this.#preamble.slice(this.preambleEnd).trimStart();
    if (settings.speechContent === "announcements") return this.preambleEnd ? [remainingPreamble] : null;
    const clean = (text: string) => electronSpeechText(text, settings.cleanSpeechText);
    const section = this.sealedSection(notice), raw = section?.text ?? "";
    let body: string[];
    if (this.frontier && this.matches(raw, settings.cleanSpeechText)) {
      body = [clean(raw).slice(this.frontier.preparedEnd).trimStart()];
      if (section?.truncation) body.push("The remaining response was truncated.");
      const result = notice.payload.assistantResult;
      for (const key of ["provisional", "partial", "unclassified"] as const) {
        if (result?.[key]?.text) body.push(clean(result[key]!.text));
        if (result?.[key]?.truncation) body.push("The remaining response was truncated.");
      }
    } else {
      // A corrected answer restarts its body. The preamble has its own playback receipt.
      body = notificationMessageParts(notice.payload).map(clean);
    }
    if (settings.speechContent !== "both" || !body.some(Boolean)) return body;
    const preamble = lastAudibleOwner === this.identity.replyId ? remainingPreamble
      : prepareSpeechParts([notice.payload.title, notice.payload.message], settings);
    return [preamble, ...body];
  }
  detach(): void {
    this.retired = true; clearTimeout(this.timer); this.timer = undefined;
    this.raw = ""; this.rawBytes = 0;
    this.#prepared = ""; this.#frames.clear(); this.#ends.length = 0; this.#physical.length = 0;
    this.cancelLookahead?.(); this.cancelLookahead = undefined;
    this.changed?.(); this.changed = undefined;
  }
}
