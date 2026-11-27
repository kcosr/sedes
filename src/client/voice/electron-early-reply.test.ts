import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ElectronEarlyReply } from "./electron-early-reply.js";
import { ElectronEarlyOutput } from "./electron-early-output.js";
import { electronVoiceDefaults } from "./electron-voice-state.js";
import type { EarlyReplyFrame } from "../../shared/protocol/early-reply.js";

const common = { replyId: "a".repeat(64), threadId: crypto.randomUUID(), turnId: "turn", itemId: "source", generation: 1 };
const settings = { ...electronVoiceDefaults(), speechContent: "messages" as const };
function source(text: string, paragraphEnd = false) {
  const frame: Extract<EarlyReplyFrame, { kind: "begin" }> = { ...common, kind: "begin", event: "turn.completed", seq: 0, threadTitle: "Title", userInputRevision: 1,
    rawStart: 0, rawEnd: text.length, text, paragraphEnd };
  return new ElectronEarlyReply(frame, 0, crypto.randomUUID());
}
function append(reply: ElectronEarlyReply, seq: number, text: string, paragraphEnd = false) {
  expect(reply.receive({ ...common, seq, kind: "append", rawStart: reply.raw.length, rawEnd: reply.raw.length + text.length, text, paragraphEnd }, 10)).toBe("accepted");
}
describe("Electron early phrasing and source reconciliation", () => {
  const sentence = (count: number, word: string) => Array(count).fill(word).join(" ") + ". ";
  it("uses the shared six-word readiness cases for Responsive speech", () => {
    const corpus: { text: string; ready: boolean }[] = JSON.parse(readFileSync(
      new URL("../../../android/app/src/test/resources/early-reply-responsive.json", import.meta.url), "utf8"));
    for (const { text, ready } of corpus) {
      expect(!!source(text).next(settings, "responsive", 1000), text).toBe(ready);
    }
  });
  it.each([["responsive", 6], ["balanced", 15], ["natural", 15]] as const)(
    "starts each %s group at %i words and releases a short tail on yield", (mode, minimum) => {
      const first = sentence(minimum - 1, "short");
      const reply = source(first, true);
      const next = () => reply.next(settings, mode, 1000)?.text;
      expect(next()).toBeUndefined();
      append(reply, 1, "Done. ", true); expect(next()).toBe(first + "Done.");
      append(reply, 2, "One. Two."); expect(next()).toBeUndefined();
      reply.receive({ ...common, seq: 3, kind: "yield", reason: "item_done" }, 20);
      expect(next()).toBe("One. Two."); expect(next()).toBeUndefined();
    });
  it.each(["responsive", "balanced", "natural"] as const)("packs the farthest ready %s endpoint under the provider limit", mode => {
    const a = sentence(15, "a"), b = sentence(15, "b"), c = sentence(15, "c");
    const reply = source(a, true); append(reply, 1, b, true); append(reply, 2, c, true);
    const limit = (a + b).trimEnd().length;
    expect(reply.next(settings, mode, limit)?.text).toBe((a + b).trimEnd());
    expect(reply.next(settings, mode, limit)?.text).toBe(c.trimEnd());
  });
  it("carries short paragraphs forward without ending Natural speech inside a short open paragraph", () => {
    const first = sentence(8, "a"), second = sentence(7, "b"), third = sentence(20, "c");
    const reply = source(first, true); append(reply, 1, second, true); append(reply, 2, third);
    expect(reply.next(settings, "natural", 4096)?.text).toBe((first + second).trimEnd());
    expect(reply.next(settings, "natural", 4096)).toBeUndefined();
    append(reply, 3, "", true);
    expect(reply.next(settings, "natural", 4096)?.text).toBe(third.trimEnd());
  });
  it("counts Natural's 60 words from the paragraph start across requests and resets at its actual end", () => {
    const pre = sentence(59, "a"), endpoint = "Ready. ", remainder = sentence(14, "b"), nextParagraph = sentence(15, "c");
    const reply = source(pre);
    const next = () => reply.next(settings, "natural", 4096)?.text;
    expect(next()).toBeUndefined();
    append(reply, 1, endpoint); expect(next()).toBe((pre + endpoint).trimEnd());
    append(reply, 2, remainder); expect(next()).toBeUndefined();
    append(reply, 3, "Done. "); expect(next()).toBe(remainder + "Done.");
    append(reply, 4, "", true); append(reply, 5, nextParagraph);
    expect(next()).toBeUndefined();
    append(reply, 6, "", true); expect(next()).toBe(nextParagraph.trimEnd());
  });
  it("qualifies an oversized group before splitting and preserves sentence boundaries and the short remainder", () => {
    const reply = source("Extraordinarily. ");
    const next = () => reply.next(settings, "responsive", 9)?.text;
    expect(next()).toBeUndefined();
    append(reply, 1, "Two words. "); expect(next()).toBeUndefined();
    append(reply, 2, "And three more.");
    const chunks = [];
    for (let text = next(); text; text = next()) chunks.push(text);
    expect(chunks.every(text => text.length <= 9)).toBe(true);
    expect(chunks).toEqual(["Extraordi", "narily.", "Two ", "words.", "And ", "three ", "more."]);
  });
  it("packs new sentences with the still-owed tail of an oversized group", () => {
    const first = "Extraordinary developments. ";
    const cap = first.trimEnd().length;
    const reply = source(first); append(reply, 1, "A B C D. ");
    expect(reply.next(settings, "responsive", cap)?.text).toBe(first.trimEnd());
    append(reply, 2, "E F.");
    expect(reply.next(settings, "responsive", cap)?.text).toBe("A B C D. E F.");
    expect(reply.next(settings, "responsive", cap)).toBeUndefined();
  });
  it.each([
    [" A b c d e f.", true],
    [" A b c d e.", true],
    [" A b c d.", false],
  ] as const)("counts the unsent end of a split sentence with fresh Responsive text %s", (fresh, qualifies) => {
    const original = "Supercalifragilistic expialidocious words keep going now.";
    const reply = source(original);
    const next = () => reply.next(settings, "responsive", 20);
    expect(next()?.text).toBe("Supercalifragilistic");
    expect(next()?.text.trim()).toBe("expialidocious");
    const lastDrained = next()!;
    expect(lastDrained.text).toBe("words keep going ");
    reply.frontier = lastDrained.frontier;
    append(reply, 1, fresh);
    const pending = next()!;
    expect(pending.text).toBe(qualifies ? "now." + fresh : "now.");
    expect(next()).toBeUndefined();
    const corrected = original.replace("now.", "again.") + fresh;
    expect(reply.matches(corrected, true, pending.frontier)).toBe(false);
    reply.detach(); expect(reply.matches(corrected, true)).toBe(true);
  });
  it.each([
    [15, false, false], [15, true, true], [60, false, true],
  ] as const)("catches up a split Natural sentence with %i paragraph words and the next paragraph-end flag %s", (words, closed, qualifies) => {
    const word = "w".repeat(30);
    const reply = source((word + " ").repeat(words - 1) + "now.", words < 60);
    const next = () => reply.next(settings, "natural", 34)?.text;
    for (let i = 1; i < words; i++) expect(next()).toBe(word + " ");
    const fresh = " " + sentence(14, "x").trimEnd();
    append(reply, 1, fresh, closed);
    expect(next()).toBe(qualifies ? "now." + fresh : "now.");
    expect(next()).toBeUndefined();
  });
  it.each(["responsive", "balanced", "natural"] as const)("speaks the Both preamble immediately and only once in %s", mode => {
    const reply = source("Yes.");
    const both = { ...settings, speechContent: "both" as const };
    expect(reply.next(both, mode, 1000)?.text).toBe("Agent finished\n\nTitle");
    expect(reply.next(both, mode, 1000)).toBeUndefined();
    reply.receive({ ...common, seq: 1, kind: "yield", reason: "markup" }, 20);
    expect(reply.next(both, mode, 1000)?.text).toBe("Yes.");
    expect(reply.next(both, mode, 1000)).toBeUndefined();
  });
  it("recognizes a fully drained physical prefix even when later words in the same sentence were corrected", () => {
    const reply = source("Alpha alpha alpha alpha long tail. ");
    const first = reply.next(settings, "responsive", 12)!;
    expect(first.text).toBe("Alpha alpha ");
    reply.frontier = first.frontier;
    reply.detach();
    expect(reply.raw).toBe("");
    expect(reply.matches("Alpha alpha changed.", true)).toBe(true);
    expect(reply.matches("Revised alpha changed.", true)).toBe(false);
  });
  it("limits staged PCM to two seconds and backpressures the overflow packet until promotion", async () => {
    const audible = vi.fn();
    const output = new ElectronEarlyOutput(audible);
    const full = new Uint8Array(96_000), packet = new Uint8Array(9600);
    await output.append(full);
    let acknowledged = false;
    const pending = output.append(packet).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false); expect(audible).not.toHaveBeenCalled();
    const sink = { append: vi.fn(async (_pcm: Uint8Array) => {}), cancel: vi.fn(), finish: vi.fn(async () => {}) };
    output.promote(sink); await pending; await output.finish();
    expect(sink.append.mock.calls.map(([pcm]) => pcm)).toEqual([full, packet]); expect(audible).toHaveBeenCalledTimes(2);
  });
});
