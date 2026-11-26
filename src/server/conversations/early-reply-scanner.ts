import { MAX_EARLY_REPLY_BYTES, type EarlyReplySegment } from "../../shared/protocol/early-reply.js";

type StopReason = "markup" | "limit" | "source_changed";
type ScanResult = { segments: EarlyReplySegment[]; stop?: StopReason };

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const plainProse = /^[\p{L}\p{M}\p{N}.,!?;:’‘“”"'()—–。！？、，-]+$/u;
const startsWord = /^[\p{L}\p{N}]/u;
const startsCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const cjkEnd = /[。！？][”’"')]*$/u;
const terminator = /([.!?。！？]+)[”’"')]*$/u;
const abbreviation = /(?:^(?:[\p{L}]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.|(?:\p{L}\.){2,})$/iu;
// Unknown DNS suffixes and URI schemes are as ambiguous as common ones.
// Check one preceding label character to keep a long plain word linear.
const looksLikeUrl = /(?:^www\.|^[a-z][a-z\d+.-]*:(?=.)|[\p{L}\p{N}-]\.\p{L}{2,}(?=[.:!?。！？、，)'’”"]|$))/iu;

function endsSentence(word: string): boolean {
  const end = terminator.exec(word);
  if (!end || end[1]!.includes("..")) return false;
  const unquoted = word.replace(/[”’"')]+$/u, "");
  return !abbreviation.test(unquoted);
}

/** Scans only new graphemes on the continuous live rail. A terminal notification
 * retains authority over the remaining Markdown and any subsequent revision. */
export class EarlyReplyScanner {
  #source = "";
  #offset = 0;
  #bytes = 0;
  #released = 0;
  #lineStart = 0;
  #lineHasText = false;
  #wordStart = 0;
  #wordEnd = 0;
  #insideWord = false;
  #stop?: StopReason;

  update(text: string): ScanResult {
    const segments: EarlyReplySegment[] = [];
    if (this.#stop) return { segments, stop: this.#stop };
    if (!text.startsWith(this.#source)) {
      this.#stop = "source_changed";
      return { segments, stop: this.#stop };
    }
    // Even a single huge delta or combining sequence cannot allocate unbounded
    // parser state. Include lookahead for the last possible boundary.
    const source = text.slice(0, MAX_EARLY_REPLY_BYTES + 2);
    for (const { segment } of graphemes.segment(source.slice(this.#offset))) {
      const start = this.#offset;
      const end = start + segment.length;
      // A later delta may add a combining mark, a surrogate half, or a ZWJ.
      // LF is a complete control grapheme, including at the end of CRLF.
      if (end === source.length && !segment.endsWith("\n")) {
        if (this.#bytes + Buffer.byteLength(segment) > MAX_EARLY_REPLY_BYTES) this.#stop = "limit";
        break;
      }
      this.#bytes += Buffer.byteLength(segment);
      if (this.#bytes > MAX_EARLY_REPLY_BYTES) { this.#stop = "limit"; break; }
      this.#offset = end;
      const word = () => source.slice(this.#wordStart, this.#wordEnd);
      const separator = segment === " " || segment === "\n" || segment === "\r" || segment === "\r\n";
      const adjacentCjk = this.#insideWord && startsCjk.test(segment) &&
        cjkEnd.test(source.slice(Math.max(0, start - 8), start));
      if (this.#insideWord && (separator || adjacentCjk)) {
        const finishedWord = word();
        if (looksLikeUrl.test(finishedWord) ||
            (this.#wordStart === this.#lineStart && /^\d+[.)]$/u.test(finishedWord))) {
          this.#stop = "markup";
          break;
        }
      }
      if (separator) {
        this.#insideWord = false;
        if (segment !== " ") {
          if (!this.#lineHasText && this.#lineStart > 0) this.#release(source, end, true, segments);
          this.#lineStart = end;
          this.#lineHasText = false;
        }
        continue;
      }
      if (!plainProse.test(segment) || (!this.#lineHasText && (start !== this.#lineStart || !startsWord.test(segment)))) {
        this.#stop = "markup";
        break;
      }
      this.#lineHasText = true;
      if (!this.#insideWord || adjacentCjk) {
        if (this.#wordEnd > this.#released && startsWord.test(segment) && endsSentence(word())) {
          this.#release(source, this.#wordEnd, false, segments);
        }
        this.#wordStart = start;
      }
      this.#insideWord = true;
      this.#wordEnd = end;
    }
    if (source.length < text.length && !this.#stop) this.#stop = "limit";
    this.#source = this.#stop ? "" : source;
    return this.#stop ? { segments, stop: this.#stop } : { segments };
  }

  #release(source: string, end: number, paragraphEnd: boolean, segments: EarlyReplySegment[]): void {
    if (end <= this.#released) return;
    const text = source.slice(this.#released, end);
    if (!text.trim()) return;
    segments.push({ rawStart: this.#released, rawEnd: end, text, paragraphEnd });
    this.#released = end;
  }
}
