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
  it("bounds a giant delta and leaves the rest for terminal reconciliation", () => {
    expect(new EarlyReplyScanner().update("a" + "\u0301".repeat(5000))).toEqual({segments: [], stop: "limit"});
    const result = new EarlyReplyScanner().update("Opening. Another " + "漢".repeat(100_000));
    expect(result.stop).toBe("limit");
    expect(result.segments.map(s => s.text)).toEqual(["Opening."]);
  });
});
