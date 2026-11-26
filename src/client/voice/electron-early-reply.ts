import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MAX_EARLY_REPLY_BYTES, type EarlyReplyFrame } from "../../shared/protocol/early-reply.js";
import type { VoiceNotification } from "../../shared/protocol/notification.js";
import { electronSpeechText, voiceChunkRanges, voiceChunks } from "./electron-voice-policy.js";
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
export interface EarlySpeechChunk { text: string; frontier?: Frontier; attribution?: boolean }

/** Live source and physical request cursors are discarded when a reply gives up its queue position.
 * Only verified, fully drained chunks advance its compact receipt. */
export class ElectronEarlyReply {
  readonly identity: Pick<Begin, "replyId" | "threadId" | "threadTitle" | "turnId" | "itemId" | "generation" | "userInputRevision" | "origin">;
  readonly openedAt: number;
  lastSpanAt: number;
  raw = "";
  rawBytes = 0;
  retired = false;
  yielded = false;
  suppressed = false;
  attributed = false;
  frontier?: Frontier;
  timer?: ReturnType<typeof setTimeout>;
  /** A notification or new group can wake a starved worker or stage its next request. */
  changed?: () => void;
  cancelLookahead?: () => void;
  readonly #frames = new Map<number, string>();
  readonly #ends: Array<{ end: number; paragraph: boolean }> = [];
  #nextSentence = 0;
  #prepared = "";
  #physical: EarlySpeechChunk[] = [];
  constructor(frame: Begin, now: number, readonly streamId: string) {
    const { replyId, threadId, threadTitle, turnId, itemId, generation, userInputRevision, origin } = frame;
    this.identity = { replyId, threadId, threadTitle, turnId, itemId, generation, userInputRevision, origin };
    this.openedAt = this.lastSpanAt = now;
    this.receive(frame, now);
  }
  receive(frame: EarlyReplyFrame, now: number): "invalid" | "duplicate" | "accepted" {
    if (frame.threadId !== this.identity.threadId || frame.turnId !== this.identity.turnId ||
        frame.itemId !== this.identity.itemId || frame.generation !== this.identity.generation) return "invalid";
    const signature = digest(JSON.stringify(frame));
    const previous = this.#frames.get(frame.seq);
    if (previous) return previous === signature ? "duplicate" : "invalid";
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
    } else if (frame.kind === "yield") this.yielded = true;
    this.#frames.set(frame.seq, signature);
    return "accepted";
  }

  /** Requests are planned from exact cumulative Markdown, including separators supplied across frames. */
  next(settings: NativeVoiceSettings, mode: NativeEarlyReplyPlaybackMode, limit: number): EarlySpeechChunk | undefined {
    if (this.#physical.length) return this.#physical.shift();
    const first = this.#nextSentence, start = first ? this.#ends[first - 1]!.end : 0;
    let endIndex = first;
    const firstSentence = this.#ends[first];
    if (!firstSentence || this.retired || mode === "off") return;
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
      this.yielded = true; this.#nextSentence = this.#ends.length; return;
    }
    if (!first && settings.speechContent === "both") {
      const title = electronSpeechText(this.identity.threadTitle, settings.cleanSpeechText);
      const chunks = voiceChunks(title, limit);
      this.#physical.push(...chunks.map((text, index) => ({ text, attribution: index === chunks.length - 1 })));
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
    return this.#physical.shift();
  }

  matches(final: string, clean: boolean, frontier = this.frontier): boolean {
    if (!frontier) return true;
    const prepared = electronSpeechText(final, clean);
    return final.length >= frontier.rawEnd && prepared.length >= frontier.preparedEnd &&
      digest(final.slice(0, frontier.rawEnd)) === frontier.rawHash && digest(prepared.slice(0, frontier.preparedEnd)) === frontier.preparedHash;
  }
  /** Null requests the ordinary context-first completion renderer. Each returned part is already formatted. */
  continuation(notice: VoiceNotification, settings: NativeVoiceSettings, lastAudibleOwner: string | undefined): string[] | null {
    const result = notice.payload.assistantResult, raw = result?.final?.text ?? "";
    if (settings.speechContent === "announcements" || !this.frontier && !this.attributed ||
        !this.matches(raw, settings.cleanSpeechText)) return null;
    const clean = (text: string) => electronSpeechText(text, settings.cleanSpeechText);
    const remaining = clean(raw).slice(this.frontier?.preparedEnd ?? 0).trimStart();
    const final = [remaining, ...(result?.final?.truncation ? ["The remaining response was truncated."] : [])];
    const rest: string[] = [];
    for (const key of ["provisional", "partial", "unclassified"] as const) {
      if (result?.[key]?.text) rest.push(clean(result[key]!.text));
      if (result?.[key]?.truncation) rest.push("The remaining response was truncated.");
    }
    if (settings.speechContent === "messages") return [...final, ...rest];
    if (lastAudibleOwner !== this.identity.replyId) return [clean(notice.payload.message || this.identity.threadTitle), clean(notice.payload.title), ...final, ...rest];
    return [...final, clean(notice.payload.title), ...(this.attributed ? [] : [clean(notice.payload.message)]), ...rest];
  }
  detach(): void {
    this.retired = true; clearTimeout(this.timer); this.timer = undefined;
    this.raw = ""; this.rawBytes = 0;
    this.#prepared = ""; this.#frames.clear(); this.#ends.length = 0; this.#physical.length = 0;
    this.cancelLookahead?.(); this.cancelLookahead = undefined;
    this.changed?.(); this.changed = undefined;
  }
}
