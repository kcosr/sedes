import { readFileSync } from "node:fs";
import { electronSpeechText } from "../../src/client/voice/electron-voice-policy.js";
import { describe, expect, it } from "vitest";
import { EarlyReplyScanner } from "../../src/server/conversations/early-reply-scanner.js";
import { type EarlyReplySegment } from "../../src/shared/protocol/early-reply.js";

function scan(source: string, cuts: number[]) {
  const scanner = new EarlyReplyScanner();
  const segments: EarlyReplySegment[] = [];
  let stop: string | undefined;
  for (const end of [...cuts, source.length]) {
    const result = scanner.update(source.slice(0, end));
    segments.push(...result.segments);
    if (result.stop) { stop = result.stop; break; }
  }
  return { segments, stop };
}

describe("incremental final-answer speech boundaries", () => {
  const fixtures: [string, string[], string?][] = [
    ["First sentence. Another sentence! Third one", ["First sentence.", " Another sentence!"]],
    ["Mr. Reed met Dr. Kay at 4.30. He left.", ["Mr. Reed met Dr. Kay at 4.30."]],
    ["It costs 1.25 units… More.", [], "markup"],
    ["Wait... Still writing. More", ["Wait... Still writing."]],
    ["It sounded “clear!” We agreed. More", ["It sounded “clear!”", " We agreed."]],
    ["Short paragraph\r\n   \r\nNext.", ["Short paragraph\r\n   \r\n"]],
    ["Hello.\n\nNew paragraph! More", ["Hello.\n\n", "New paragraph!"]],
    ["最初です。次です！最後", ["最初です。", "次です！"]],
    ["Cafe\u0301 is open. Another line", ["Cafe\u0301 is open."]],
    ["Early words. Now see [label][id].\n\n[id]: example", ["Early words."], "markup"],
    ["A valid start. Next includes a 😀 symbol.", ["A valid start."], "markup"],
    ["1. This is a list. Next sentence.", [], "markup"],
    ["    code line. This follows.", [], "markup"],
    ["The address is example.org. Do visit.", [], "markup"],
    ["First sentence. Visit example.xyz. Then stop.", ["First sentence."], "markup"],
    ["Visit www.example.com。次の文", [], "markup"],
    ["See http:foo。次の文", [], "markup"],
    ["Opening. Visit example.org！次の文", ["Opening."], "markup"],
    ["A custom:resource. Next sentence.", [], "markup"],
    ["First sentence.\n1. List item.", ["First sentence."], "markup"],
    ["No markup.\n\n# A heading", ["No markup.\n\n"], "markup"],
  ];
  it.each(fixtures)("is invariant to partitions of %j", (source, pieces, expectedStop) => {
    const whole = scan(source, []);
    expect(whole.segments.map(s => s.text)).toEqual(pieces);
    expect(whole.stop).toBe(expectedStop);
    const everyCut = Array.from({ length: source.length }, (_, i) => i);
    expect(scan(source, everyCut)).toEqual(whole);
    for (const cut of everyCut) expect(scan(source, [cut])).toEqual(whole);
    let offset = 0;
    for (const span of whole.segments) {
      expect(span.rawStart).toBe(offset);
      expect(span.text).toBe(source.slice(offset, span.rawEnd));
      offset = span.rawEnd;
    }
  });
  it("waits for boundary evidence and detects changes even to the withheld suffix", () => {
    const scanner = new EarlyReplyScanner();
    expect(scanner.update("First part.")).toEqual({ segments: [] });
    expect(scanner.update("First part. What").segments).toEqual([{ text: "First part.", rawStart: 0, rawEnd: 11, paragraphEnd: false }]);
    expect(scanner.update("First part. When")).toEqual({ segments: [], stop: "source_changed" });
  });
  it("releases only printable cumulative prefixes from the shared formatter corpus", () => {
    const corpus: Array<{ name: string; source: string; segments: string[] }> = JSON.parse(
      readFileSync(new URL("../../android/app/src/test/resources/early-reply-prefixes.json", import.meta.url), "utf8"),
    );
    for (const { name, source, segments } of corpus) {
      const result = scan(source, []);
      expect(result.segments.map(span => span.text), name).toEqual(segments);
      for (const clean of [true, false]) {
        const finalSpeech = electronSpeechText(source, clean);
        let previous = "";
        for (const span of result.segments) {
          const prepared = electronSpeechText(source.slice(0, span.rawEnd), clean);
          expect(prepared.startsWith(previous) && finalSpeech.startsWith(prepared), name).toBe(true);
          previous = prepared;
        }
      }
    }
  });
  it("flushes a completed append as one contiguous frame, even across paragraphs", () => {
    const scanner = new EarlyReplyScanner();
    const opening = "Yes. This";
    expect(scanner.update(opening).segments.map(span => span.text)).toEqual(["Yes."]);
    const suffix = " This is a test.\n\nAnd this is the end";
    const result = scanner.update("Yes." + suffix, true);
    expect(result).toEqual({segments: [{rawStart: 4, rawEnd: 4 + suffix.length, text: suffix, paragraphEnd: true}]});
    expect(scanner.update("Yes." + suffix, true)).toEqual({segments: []});
  });
  it.each(["[", "https:private", "www.example.org", "example.com", "最後。www.example.com", "\n1.", "x😀"])(
    "checks the last grapheme and unterminated token for markup on completion: %s", tail => {
      const scanner = new EarlyReplyScanner();
      scanner.update("Yes. Here");
      expect(scanner.update("Yes. Here is " + tail, true).stop).toBe("markup");
    });
  it("retains trailing whitespace, handles a standalone short reply, and respects byte limits on flush", () => {
    const scanner = new EarlyReplyScanner();
    expect(scanner.update("Yes.\n\n").segments[0]?.text).toBe("Yes.\n\n");
    expect(scanner.update("Yes.\n\n ", true).segments).toEqual([{rawStart: 6, rawEnd: 7, text: " ", paragraphEnd: true}]);
    expect(new EarlyReplyScanner(4).update("Yes.", true).segments[0]?.text).toBe("Yes.");
    expect(new EarlyReplyScanner(3).update("Yes.", true)).toEqual({segments: [], stop: "limit"});
    expect(new EarlyReplyScanner().update(" \n", true)).toEqual({segments: []});
  });
  it("bounds a giant delta and leaves the rest for terminal reconciliation", () => {
    expect(new EarlyReplyScanner().update("a" + "\u0301".repeat(5000))).toEqual({segments: [], stop: "limit"});
    const result = new EarlyReplyScanner().update("Opening. Another " + "漢".repeat(100_000));
    expect(result.stop).toBe("limit");
    expect(result.segments.map(s => s.text)).toEqual(["Opening."]);
  });
});
