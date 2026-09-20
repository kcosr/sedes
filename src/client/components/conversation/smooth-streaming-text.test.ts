import { describe, expect, it } from "vitest";
import {
  beginTerminalSettlement,
  createOpaqueStreamFade,
  hasPendingFade,
  INITIAL_ANIMATED_GRAPHEMES,
  MAX_ANIMATED_GRAPHEMES,
  MIN_STREAM_OPACITY,
  observeStreamFade,
  opacityAt,
  segmentGraphemes,
  TERMINAL_SETTLE_MS,
} from "./smooth-streaming-text.js";

describe("stream fade scheduling", () => {
  it("segments combining and joined glyphs as complete graphemes", () => {
    expect(segmentGraphemes("A👨‍👩‍👧‍👦e\u0301")).toEqual([
      "A",
      "👨‍👩‍👧‍👦",
      "e\u0301",
    ]);
  });

  it("bounds initial and replacement animation to the newest 48 graphemes", () => {
    const initial = observeStreamFade(undefined, "a".repeat(200), 1_000);
    expect(initial.animated).toHaveLength(INITIAL_ANIMATED_GRAPHEMES);
    expect(initial.animated[0]?.index).toBe(152);

    const replacement = observeStreamFade(initial, "b".repeat(300), 1_150);
    expect(replacement.animated).toHaveLength(INITIAL_ANIMATED_GRAPHEMES);
    expect(replacement.animated[0]?.index).toBe(252);
  });

  it("establishes mounted streaming text as an opaque observation baseline", () => {
    const initial = createOpaqueStreamFade("already received", 1_000);

    expect(initial.opaquePrefix).toBe("already received");
    expect(initial.animated).toEqual([]);
    expect(hasPendingFade(initial, 1_000)).toBe(false);

    const appended = observeStreamFade(
      initial,
      "already received next",
      1_150,
    );
    expect(appended.opaquePrefix).toBe("already received");
    expect(appended.animated.map((record) => record.grapheme).join(""))
      .toBe(" next");
  });

  it("preserves prior arrivals on append and bounds retained records and lag", () => {
    const initial = observeStreamFade(undefined, "start", 1_000);
    const priorArrivals = initial.animated.map((record) => record.arrivalMs);
    const smallAppend = observeStreamFade(initial, "start next", 1_150);
    expect(
      smallAppend.animated
        .filter((record) => record.index < initial.graphemeCount)
        .map((record) => record.arrivalMs),
    ).toEqual(priorArrivals);

    const appended = observeStreamFade(
      initial,
      `start${"x".repeat(300)}`,
      1_150,
    );
    expect(appended.animated.length).toBeLessThanOrEqual(
      MAX_ANIMATED_GRAPHEMES,
    );
    expect(appended.animated.at(-1)?.arrivalMs).toBeLessThanOrEqual(1_500);
  });

  it("treats a combining or ZWJ extension as a replacement", () => {
    const combiningStart = observeStreamFade(undefined, "e", 0);
    const combiningEnd = observeStreamFade(combiningStart, "e\u0301", 100);
    expect(combiningEnd.graphemeCount).toBe(1);
    expect(combiningEnd.animated).toEqual([
      expect.objectContaining({ index: 0, grapheme: "e\u0301" }),
    ]);

    const joinedStart = observeStreamFade(undefined, "👨", 0);
    const joinedEnd = observeStreamFade(joinedStart, "👨‍👩", 100);
    expect(joinedEnd.graphemeCount).toBe(1);
    expect(joinedEnd.animated).toHaveLength(1);
  });

  it("settles on elapsed time without another source observation", () => {
    const fade = observeStreamFade(undefined, "answer", 100);
    expect(hasPendingFade(fade, 100)).toBe(true);
    expect(opacityAt(fade.animated[0]!, 100)).toBe(MIN_STREAM_OPACITY);
    expect(hasPendingFade(fade, 2_000)).toBe(false);
    expect(opacityAt(fade.animated.at(-1)!, 2_000)).toBe(1);
  });

  it("makes every retained grapheme opaque by the terminal deadline", () => {
    const fade = observeStreamFade(undefined, "terminal answer", 100);
    const settling = beginTerminalSettlement(fade, 150);
    expect(
      settling.animated.every(
        (record) =>
          opacityAt(record, 150 + TERMINAL_SETTLE_MS) === 1,
      ),
    ).toBe(true);
  });
});
