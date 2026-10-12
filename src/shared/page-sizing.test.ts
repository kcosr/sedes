import { describe, expect, it } from "vitest";
import { stabilizePageHeight, type PageMeasurement } from "./page-sizing.js";

const measurement = (viewportHeight: number, naturalHeight: number, width = 390): PageMeasurement => ({ width, viewportHeight, naturalHeight, contentWidth: width });

describe("page content sizing", () => {
  it("stops the viewport feedback from 100vh plus margins and padding", () => {
    const first = stabilizePageHeight(undefined, measurement(600, 616));
    expect(first.acceptedHeight).toBe(616);
    const applied = stabilizePageHeight(first, measurement(616, 632));
    expect(applied).toMatchObject({ acceptedHeight: 616, frozen: true });
    expect(stabilizePageHeight(applied, measurement(616, 632))).toEqual(applied);
  });

  it("stops multiplying viewport units and negative viewport feedback", () => {
    const doubled = stabilizePageHeight(undefined, measurement(600, 1200));
    expect(stabilizePageHeight(doubled, measurement(1200, 2400))).toMatchObject({ acceptedHeight: 1200, frozen: true });
    const reduced = stabilizePageHeight(undefined, measurement(600, 580));
    expect(stabilizePageHeight(reduced, measurement(580, 560))).toMatchObject({ acceptedHeight: 580, frozen: true });
  });

  it("still fits compact components and real content changes after a frozen layout", () => {
    const compact = stabilizePageHeight(undefined, measurement(600, 80));
    expect(stabilizePageHeight(compact, measurement(80, 80))).toMatchObject({ acceptedHeight: 80, frozen: false });
    const frozen = stabilizePageHeight(stabilizePageHeight(undefined, measurement(600, 616)), measurement(616, 632));
    const changed = stabilizePageHeight(frozen, measurement(616, 700));
    expect(changed).toMatchObject({ acceptedHeight: 700, frozen: false, steps: 0 });
    expect(stabilizePageHeight(frozen, measurement(616, 100, 768))).toMatchObject({ acceptedHeight: 100, frozen: false, steps: 0 });
  });

  it("bounds pathological feedback and ignores duplicate observations", () => {
    let state = stabilizePageHeight(undefined, measurement(600, 200));
    for (let step = 0; step < 12; step++) state = stabilizePageHeight(state, measurement(500 - step * 10, 210 + step));
    expect(state.frozen).toBe(true);
    expect(state.steps).toBe(6);
    expect(stabilizePageHeight(undefined, measurement(600, 1_000_000)).acceptedHeight).toBe(8192);
  });
});
