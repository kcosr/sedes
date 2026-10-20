// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Heatmap } from "./Heatmap.js";
import { TimeSeriesChart } from "./TimeSeriesChart.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubDensity(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: touch,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function pointer(type: "pointerleave" | "pointerdown", target: Element, pointerType: string) {
  // React derives pointerleave from pointerout; jsdom's events carry no
  // pointerType, so set it on the native event React reads.
  const event = new Event(type === "pointerleave" ? "pointerout" : type, { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    clientX: { value: 10 },
    relatedTarget: { value: document.body },
  });
  fireEvent(target, event);
}

const cells = [
  { weekday: 0, hour: 9, value: 2_500 },
  { weekday: 2, hour: 14, value: 100 },
];

function renderHeatmap() {
  render(<Heatmap cells={cells} format={(value) => `${value} tokens`} label="Tokens by weekday and hour" />);
  const heatmap = screen.getByRole("group", { name: "Tokens by weekday and hour" });
  const readout = heatmap.querySelector(".usage-heatmap-readout")!;
  const grid = heatmap.querySelector(".usage-heatmap-grid")!;
  const cell = (weekday: number, hour: number) =>
    grid.querySelectorAll(".usage-heatmap-row")[weekday]!.querySelectorAll(".usage-heatmap-cell")[hour]!;
  return { heatmap, readout, grid, cell };
}

describe("Heatmap", () => {
  it("keeps the live readout and scale outside the hidden grid", () => {
    stubDensity(false);
    const { heatmap, readout, grid } = renderHeatmap();
    expect(heatmap).not.toHaveAttribute("role", "img");
    expect(grid).toHaveAttribute("aria-hidden", "true");
    expect(grid.contains(readout)).toBe(false);
    expect(readout).toHaveAttribute("aria-live", "polite");
    expect(readout.closest("[aria-hidden=true], [role=img]")).toBeNull();
    expect(readout).toHaveTextContent("Hover a cell for its total");
  });

  it("asks touch users to tap and keeps a tapped cell as the finger lifts", () => {
    stubDensity(true);
    const { readout, grid, cell } = renderHeatmap();
    expect(readout).toHaveTextContent("Tap a cell for its total");
    pointer("pointerdown", cell(2, 14), "touch");
    expect(readout).toHaveTextContent("100 tokens Wed");
    pointer("pointerleave", grid, "touch");
    expect(readout).toHaveTextContent("100 tokens Wed");
    pointer("pointerleave", grid, "mouse");
    expect(readout).toHaveTextContent("Tap a cell for its total");
  });

  it("moves between cells with the arrow keys and clears on Escape", () => {
    stubDensity(false);
    const { heatmap, readout, cell } = renderHeatmap();
    fireEvent.focus(heatmap);
    // Focus starts on the busiest cell.
    expect(readout).toHaveTextContent("2500 tokens Mon");
    expect(cell(0, 9)).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(heatmap, { key: "ArrowRight" });
    expect(cell(0, 10)).toHaveAttribute("data-active", "true");
    expect(readout).toHaveTextContent("0 tokens Mon");
    fireEvent.keyDown(heatmap, { key: "ArrowDown" });
    expect(cell(1, 10)).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(heatmap, { key: "ArrowUp" });
    fireEvent.keyDown(heatmap, { key: "ArrowUp" });
    expect(cell(0, 10)).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(heatmap, { key: "End" });
    expect(cell(0, 23)).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(heatmap, { key: "Escape" });
    expect(readout).toHaveTextContent("Hover a cell for its total");
  });
});

describe("TimeSeriesChart", () => {
  it("keeps a tapped readout as the finger lifts and clears when a mouse leaves", () => {
    stubDensity(true);
    const { container } = render(
      <TimeSeriesChart
        buckets={[
          { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" },
          { start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
        ]}
        granularity="day"
        series={[{ id: "tokens", label: "Tokens", color: "#000", values: [5, 7] }]}
        mode="bars"
        format={(value) => `${value}`}
        ariaLabel="Tokens per day"
      />,
    );
    const plot = container.querySelector('svg rect[fill="transparent"]')!;
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 100, top: 0, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    pointer("pointerdown", plot, "touch");
    expect(screen.getByRole("status")).toHaveTextContent("5");
    pointer("pointerleave", plot, "touch");
    expect(screen.getByRole("status")).toHaveTextContent("5");
    pointer("pointerleave", plot, "mouse");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
