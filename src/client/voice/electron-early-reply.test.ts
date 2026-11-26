import { describe, expect, it, vi } from "vitest";
import { ElectronEarlyReply } from "./electron-early-reply.js";
import { ElectronEarlyOutput } from "./electron-early-output.js";
import { electronVoiceDefaults } from "./electron-voice-state.js";
import type { EarlyReplyFrame } from "../../shared/protocol/early-reply.js";

const common = { replyId: "a".repeat(64), threadId: crypto.randomUUID(), turnId: "turn", itemId: "source", generation: 1 };
const settings = { ...electronVoiceDefaults(), speechContent: "messages" as const };
function source(text: string, paragraphEnd = false) {
  const frame: Extract<EarlyReplyFrame, { kind: "begin" }> = { ...common, kind: "begin", seq: 0, threadTitle: "Title", userInputRevision: 1,
    rawStart: 0, rawEnd: text.length, text, paragraphEnd };
  return new ElectronEarlyReply(frame, 0, crypto.randomUUID());
}
function append(reply: ElectronEarlyReply, seq: number, text: string, paragraphEnd = false) {
  expect(reply.receive({ ...common, seq, kind: "append", rawStart: reply.raw.length, rawEnd: reply.raw.length + text.length, text, paragraphEnd }, 10)).toBe("accepted");
}
describe("Electron early phrasing and source reconciliation", () => {
  it.each([
    ["responsive", ["First.", "Second.", "Third.", "Fourth."]],
    ["balanced", ["First.", "Second. Third.", "Fourth."]],
    ["natural", ["First. Second. Third.", "Fourth."]],
  ] as const)("groups whole ready sentences within paragraphs for %s", (mode, expected) => {
    const reply = source("First. ");
    append(reply, 1, "Second. "); append(reply, 2, "Third.\n\n", true); append(reply, 3, "Fourth.", true);
    const chunks = [];
    for (let chunk = reply.next(settings, mode, 1000); chunk; chunk = reply.next(settings, mode, 1000)) chunks.push(chunk.text);
    expect(chunks).toEqual(expected);
  });
  it("releases a long open Natural paragraph at 320 raw units and a short available tail at yield", () => {
    const reply = source("A".repeat(301) + ". ");
    expect(reply.next(settings, "natural", 4096)).toBeUndefined();
    append(reply, 1, "B".repeat(20) + ". "); append(reply, 2, "Small. ");
    expect(reply.next(settings, "natural", 4096)?.text).toBe("A".repeat(301) + ". " + "B".repeat(20) + ".");
    expect(reply.next(settings, "natural", 4096)).toBeUndefined();
    reply.receive({ ...common, seq: 3, kind: "yield", reason: "item_done" }, 20);
    expect(reply.next(settings, "natural", 4096)?.text).toBe("Small.");
  });
  it("recognizes a fully drained physical prefix even when later words in the same sentence were corrected", () => {
    const reply = source("Alpha alpha alpha alpha tail. ");
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
