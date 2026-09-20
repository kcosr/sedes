// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextUsageMeter } from "./ContextUsageMeter";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContextUsageMeter", () => {
  it("opens a compact usage explanation by click", () => {
    render(
      <ContextUsageMeter
        usage={{
          usedTokens: 81_000,
          windowTokens: 258_000,
          percent: 31.4,
        }}
      />,
    );

    const button = screen.getByRole("button", { name: /context window/i });
    expect(button).toHaveAttribute("data-level", "normal");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "31% used (69% left)",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "81k / 258k tokens used",
    );
  });

  it("uses exact warning thresholds while clamping the ring fill", () => {
    const { rerender } = render(
      <ContextUsageMeter
        usage={{ usedTokens: 69_900, windowTokens: 100_000, percent: 69.9 }}
      />,
    );
    const button = screen.getByRole("button", { name: /context window/i });
    expect(button).toHaveAttribute("data-level", "normal");

    rerender(
      <ContextUsageMeter
        usage={{ usedTokens: 70_000, windowTokens: 100_000, percent: 70 }}
      />,
    );
    expect(button).toHaveAttribute("data-level", "warning");

    rerender(
      <ContextUsageMeter
        usage={{ usedTokens: 89_900, windowTokens: 100_000, percent: 89.9 }}
      />,
    );
    expect(button).toHaveAttribute("data-level", "warning");

    rerender(
      <ContextUsageMeter
        usage={{ usedTokens: 112_000, windowTokens: 100_000, percent: 112 }}
      />,
    );
    expect(button).toHaveAttribute("data-level", "danger");
    expect(button.style.getPropertyValue("--context-usage")).toBe("100.00%");
    expect(button).toHaveAccessibleName(/112% used \(0.0% left\)/i);
  });

  it("explains an unknown token count without inventing usage", () => {
    render(
      <ContextUsageMeter
        usage={{ windowTokens: 1_000_000 }}
      />,
    );

    const button = screen.getByRole("button", { name: /usage unknown/i });
    expect(button).toHaveAccessibleName(/1M token window/i);
    expect(button).toHaveAttribute("data-level", "normal");
  });
});
