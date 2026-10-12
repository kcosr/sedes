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
  style: Record<string, string>;
}

const initialStyle = {
  overflowX: "visible", overflowY: "visible", marginBottom: "0", borderBottomWidth: "0",
  position: "static", display: "block", contain: "none", willChange: "auto",
  contentVisibility: "visible", transform: "none", translate: "none",
  rotate: "none", scale: "none", perspective: "none", filter: "none",
  backdropFilter: "none",
};

function measureContent(
  elements: { bottom: number; overflow?: string; parent?: number; style?: Record<string, string> }[],
  scrollHeight = 600,
  styles: { body?: Record<string, string>; root?: Record<string, string> } = {},
  authoredScript?: string,
): PageMeasurement {
  const body: MeasuredElement & { scrollWidth: number; querySelectorAll(): MeasuredElement[] } = {
    parentElement: null,
    getBoundingClientRect: () => ({ bottom: 100 }),
    style: { ...initialStyle, ...styles.body },
    scrollWidth: 768,
    querySelectorAll: () => children,
  };
  const children: MeasuredElement[] = [];
  for (const element of elements) children.push({
    parentElement: element.parent === undefined ? body : children[element.parent]!,
    getBoundingClientRect: () => ({ bottom: element.bottom }),
    style: { ...initialStyle, overflowY: element.overflow ?? "visible", ...element.style },
  });
  const host = {
    Object, Math, WeakMap, Promise, parseFloat,
    innerHeight: 600, innerWidth: 768, scrollY: 0,
    document: { body, documentElement: { scrollHeight, scrollWidth: 768, style: { ...initialStyle, ...styles.root } } },
    getComputedStyle: (element: MeasuredElement) => element.style,
    requestAnimationFrame: () => 0,
  };
  runInNewContext(`(${PAGE_MEASUREMENT_INSTALL_SOURCE})(host)`, { host });
  if (authoredScript) runInNewContext(authoredScript, host);
  return (host as typeof host & { __sedesMeasurePage(): PageMeasurement }).__sedesMeasurePage();
}

describe("authored page measurements", () => {
  it.each([
    ["a global function declaration", 'function WeakMap() { throw new Error("authored WeakMap called"); }'],
    ["a global property assignment", "globalThis.WeakMap = undefined;"],
  ])("keeps measuring after authored code replaces WeakMap with %s", (_description, authoredScript) => {
    expect(measureContent([
      { bottom: 350, overflow: "hidden" },
      { bottom: 10_000, parent: 0 },
      { bottom: 485 },
    ], 600, {}, authoredScript)).toEqual(measurement(600, 485, 768));
  });

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

  it.each([
    ["fixed", "hidden"], ["fixed", "clip"],
    ["absolute", "hidden"], ["absolute", "clip"],
  ])("includes %s content that escapes a static overflow:%s clip", (position, overflow) => {
    // In a 240px-tall browser viewport, a fixed child from y=50 to y=150
    // remains visible below its 100px static parent's overflow clip. The
    // document scroll height stays 240, so it cannot repair a wrong clip.
    expect(measureContent([
      { bottom: 100, overflow },
      { bottom: 150, parent: 0, style: { position } },
    ], 240).naturalHeight).toBe(150);
  });

  it("keeps the absolute containing block's clip while skipping an inner static clip", () => {
    expect(measureContent([
      { bottom: 200, overflow: "hidden", style: { position: "relative" } },
      { bottom: 100, overflow: "hidden", parent: 0 },
      { bottom: 300, parent: 1, style: { position: "absolute" } },
    ]).naturalHeight).toBe(200);
  });

  it("clips absolute content when its clipping parent establishes its containing block", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden", style: { position: "relative" } },
      { bottom: 150, parent: 0, style: { position: "absolute" } },
    ], 240).naturalHeight).toBe(100);
  });

  it("lets fixed content escape a merely positioned ancestor and carries the result to descendants", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden", style: { position: "relative" } },
      { bottom: 150, parent: 0, style: { position: "fixed" } },
      { bottom: 200, parent: 1 },
    ], 240).naturalHeight).toBe(200);
  });

  it.each<Record<string, string>>([
    { transform: "matrix(1, 0, 0, 1, 0, 0)" },
    { translate: "0px" },
    { rotate: "0deg" },
    { scale: "1" },
    { perspective: "100px" },
    { filter: "blur(0px)" },
    { backdropFilter: "blur(0px)" },
    { contain: "layout" },
    { contain: "paint" },
    { contain: "strict" },
    { contain: "content" },
    { willChange: "transform" },
    { contentVisibility: "auto" },
  ])("keeps fixed content clipped by its actual containing block: %j", (style) => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden", style },
      { bottom: 150, parent: 0, style: { position: "fixed" } },
    ], 240).naturalHeight).toBe(100);
  });

  it("keeps outer clipping around a transformed fixed containing block", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden" },
      { bottom: 150, parent: 0, style: { transform: "matrix(1, 0, 0, 1, 0, 0)" } },
      { bottom: 200, parent: 1, style: { position: "fixed" } },
    ], 240).naturalHeight).toBe(100);
  });

  it("restores a fixed descendant's own clip after it escapes an ancestor", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden" },
      { bottom: 150, overflow: "hidden", parent: 0, style: { position: "fixed" } },
      { bottom: 200, parent: 1 },
    ], 240).naturalHeight).toBe(150);
  });

  it.each<Record<string, string>>([
    { transform: "matrix(1, 0, 0, 1, 0, 0)" },
    { contain: "layout" },
    { willChange: "transform" },
    { contentVisibility: "auto" },
  ])("does not invent a containing block for non-replaced inline content: %j", (style) => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden" },
      { bottom: 10, parent: 0, style: { display: "inline", ...style } },
      { bottom: 150, parent: 1, style: { position: "fixed" } },
    ], 240).naturalHeight).toBe(150);
  });

  it("preserves a filter's containing block on a non-replaced inline element", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden" },
      { bottom: 10, parent: 0, style: { display: "inline", filter: "blur(0px)" } },
      { bottom: 150, parent: 1, style: { position: "fixed" } },
    ], 240).naturalHeight).toBe(100);
  });

  it("ignores a transform on display:contents when resolving a fixed containing block", () => {
    expect(measureContent([
      { bottom: 100, overflow: "hidden" },
      { bottom: 0, parent: 0, style: { display: "contents", transform: "matrix(1, 0, 0, 1, 0, 0)" } },
      { bottom: 150, parent: 1, style: { position: "fixed" } },
    ], 240).naturalHeight).toBe(150);
  });

  it("keeps viewport-propagated body overflow out of natural content sizing", () => {
    expect(measureContent([
      { bottom: 150, style: { position: "fixed" } },
    ], 240, { body: { overflowY: "hidden", transform: "matrix(1, 0, 0, 1, 0, 0)" } }).naturalHeight).toBe(150);
  });

  it("applies the body's own overflow when the root stops its propagation", () => {
    expect(measureContent([
      { bottom: 150, style: { position: "fixed" } },
    ], 240, {
      body: { overflowY: "hidden", transform: "matrix(1, 0, 0, 1, 0, 0)" },
      root: { overflowY: "hidden" },
    }).naturalHeight).toBe(100);
  });

  it("applies body overflow when containment stops viewport propagation", () => {
    expect(measureContent([
      { bottom: 150, style: { position: "fixed" } },
    ], 240, { body: { overflowY: "hidden", contain: "layout" } }).naturalHeight).toBe(100);
  });
});
