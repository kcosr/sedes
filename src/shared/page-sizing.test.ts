import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAGE_MEASUREMENT_INSTALL_SOURCE, stabilizePageHeight, type PageMeasurement } from "./page-sizing.js";

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

interface MeasuredElement {
  parentElement: MeasuredElement | null;
  getBoundingClientRect(): { bottom: number };
  style: { overflowY: string; marginBottom: string; borderBottomWidth: string };
}

function measureContent(elements: { bottom: number; overflow?: string; parent?: number }[], scrollHeight = 600): PageMeasurement {
  const body: MeasuredElement & { scrollWidth: number; querySelectorAll(): MeasuredElement[] } = {
    parentElement: null,
    getBoundingClientRect: () => ({ bottom: 100 }),
    style: { overflowY: "visible", marginBottom: "0", borderBottomWidth: "0" },
    scrollWidth: 768,
    querySelectorAll: () => children,
  };
  const children: MeasuredElement[] = [];
  for (const element of elements) children.push({
    parentElement: element.parent === undefined ? body : children[element.parent]!,
    getBoundingClientRect: () => ({ bottom: element.bottom }),
    style: { overflowY: element.overflow ?? "visible", marginBottom: "0", borderBottomWidth: "0" },
  });
  const host = {
    Object, Math, WeakMap, Promise, parseFloat,
    innerHeight: 600, innerWidth: 768, scrollY: 0,
    document: { body, documentElement: { scrollHeight, scrollWidth: 768 } },
    getComputedStyle: (element: MeasuredElement) => element.style,
    requestAnimationFrame: () => 0,
  };
  runInNewContext(`(${PAGE_MEASUREMENT_INSTALL_SOURCE})(host)`, { host });
  return (host as typeof host & { __sedesMeasurePage(): PageMeasurement }).__sedesMeasurePage();
}

describe("authored page measurements", () => {
  it.each(["hidden", "clip", "auto", "scroll"])("excludes descendants clipped by overflow %s", (overflow) => {
    // Like Three.js SVGRenderer: the path geometry can extend far beyond
    // the stage even though none of it paints outside the clipped viewport.
    expect(measureContent([
      { bottom: 350, overflow },
      { bottom: 350, parent: 0 },
      { bottom: 10_000, parent: 1 },
      { bottom: 485 },
    ]).naturalHeight).toBe(485);
  });

  it("preserves visible SVG and positioned overflow", () => {
    expect(measureContent([
      { bottom: 350 },
      { bottom: 350, parent: 0 },
      { bottom: 1200, parent: 1 },
    ]).naturalHeight).toBe(1200);
  });

  it("keeps outer clipping when an inner viewport is taller", () => {
    expect(measureContent([
      { bottom: 350, overflow: "hidden" },
      { bottom: 800, parent: 0, overflow: "hidden" },
      { bottom: 10_000, parent: 1 },
    ]).naturalHeight).toBe(350);
  });

  it("preserves real document scroll overflow", () => {
    expect(measureContent([{ bottom: 350, overflow: "hidden" }, { bottom: 10_000, parent: 0 }], 1500).naturalHeight).toBe(1500);
  });
});
