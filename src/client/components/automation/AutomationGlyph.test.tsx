// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationGlyph } from "./AutomationGlyph.js";

afterEach(cleanup);

describe("AutomationGlyph", () => {
  it.each([
    ["repeat", "lucide-repeat"],
    ["pause", "lucide-circle-pause"],
    ["triangle", "lucide-triangle-alert"],
    ["archive", "lucide-archive"],
    ["snoozed", "lucide-moon"],
  ] as const)("draws the %s glyph as a bare icon", (glyph, iconClass) => {
    const { container } = render(<AutomationGlyph glyph={glyph} />);
    const icon = container.firstElementChild!;
    expect(icon).toHaveClass("automation-glyph", iconClass);
    expect(icon).toHaveAttribute("data-automation-glyph", glyph);
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("draws the sending spinner with the shared comet ring", () => {
    const { container } = render(<AutomationGlyph glyph="spinner" tone="info" size="list" />);
    const spinner = container.firstElementChild!;
    expect(spinner.tagName).toBe("SPAN");
    expect(spinner).toHaveClass("automation-glyph", "comet-spinner");
    expect(spinner).toHaveAttribute("data-size", "list");
    expect(spinner).toHaveAttribute("data-tone", "info");
  });

  it.each([
    ["sidebar", "14", "2"],
    ["list", "16", "2"],
    ["header", "18", "1.8"],
  ] as const)("sizes icons for the %s", (size, pixels, stroke) => {
    const { container } = render(<AutomationGlyph glyph="repeat" size={size} />);
    const icon = container.firstElementChild!;
    expect(icon).toHaveAttribute("width", pixels);
    expect(icon).toHaveAttribute("height", pixels);
    expect(icon).toHaveAttribute("stroke-width", stroke);
    expect(icon).toHaveAttribute("data-size", size);
  });

  it("colors only the tones that carry meaning; Active stays a neutral glyph", () => {
    const toneOf = (tone: Parameters<typeof AutomationGlyph>[0]["tone"]) => {
      const { container } = render(<AutomationGlyph glyph="triangle" tone={tone} />);
      const value = container.firstElementChild!.getAttribute("data-tone");
      cleanup();
      return value;
    };
    expect(toneOf("danger")).toBe("danger");
    expect(toneOf("warning")).toBe("warning");
    expect(toneOf("info")).toBe("info");
    expect(toneOf("success")).toBeNull();
    expect(toneOf("neutral")).toBeNull();
    expect(toneOf(undefined)).toBeNull();
  });

  it("is an image named by its label when given one", () => {
    render(<AutomationGlyph glyph="pause" label="Automation paused" className="extra" />);
    const glyph = screen.getByRole("img", { name: "Automation paused" });
    expect(glyph).toHaveClass("automation-glyph", "extra");
    expect(glyph).not.toHaveAttribute("aria-hidden");
    cleanup();
    render(<AutomationGlyph glyph="spinner" label="Sending" />);
    expect(screen.getByRole("img", { name: "Sending" })).toHaveClass("comet-spinner");
  });
});
