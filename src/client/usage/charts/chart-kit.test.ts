import { describe, expect, it } from "vitest";
import { OTHER_COLOR, UNKNOWN_COLOR, assignSeriesColors, niceTicks, seriesColor } from "./chart-kit.js";

describe("usage chart kit", () => {
  it("keeps a series' color when filters remove other series", () => {
    const order = ["opus", "sonnet", null, "haiku"];
    const full = assignSeriesColors([{ key: "opus", other: false }, { key: "sonnet", other: false }, { key: "haiku", other: false }], order);
    const filtered = assignSeriesColors([{ key: "haiku", other: false }], order);
    expect(full).toEqual([seriesColor(0), seriesColor(1), seriesColor(2)]);
    expect(filtered).toEqual([seriesColor(2)]);
  });

  it("keeps unknown and Other neutral and gives unranked keys a free slot", () => {
    const colors = assignSeriesColors([
      { key: "opus", other: false }, { key: null, other: false }, { key: "new-model", other: false }, { key: null, other: true },
    ], ["opus"]);
    expect(colors).toEqual([seriesColor(0), UNKNOWN_COLOR, seriesColor(1), OTHER_COLOR]);
  });

  it("rounds axis ticks to clean steps", () => {
    expect(niceTicks(7_300_000)).toEqual([0, 2_000_000, 4_000_000, 6_000_000, 8_000_000]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(0.83)).toEqual([0, 0.5, 1]);
  });
});
