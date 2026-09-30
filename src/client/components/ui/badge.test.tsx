// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge.js";

afterEach(cleanup);

describe("Badge", () => {
  it("defaults to a small, soft, neutral badge", () => {
    render(<Badge>Draft</Badge>);
    const badge = screen.getByText("Draft");
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge).toHaveAttribute("data-tone", "neutral");
    expect(badge).toHaveAttribute("data-appearance", "soft");
    expect(badge).toHaveClass("h-5", "text-(length:--text-label)", "bg-muted-foreground/12", "text-muted-foreground");
  });

  it.each([
    ["info", "soft", ["text-info", "bg-info-soft"]],
    ["success", "soft", ["text-success", "bg-success-soft"]],
    ["warning", "outline", ["text-warning", "border-warning-border", "bg-transparent"]],
    ["destructive", "outline", ["text-destructive", "border-destructive-border"]],
    ["neutral", "outline", ["text-muted-foreground", "border-border"]],
  ] as const)("renders tone %s with appearance %s", (tone, appearance, classes) => {
    render(<Badge tone={tone} appearance={appearance}>Label</Badge>);
    expect(screen.getByText("Label")).toHaveClass(...classes);
  });

  it("has an extra-small size", () => {
    render(<Badge size="xs">New</Badge>);
    expect(screen.getByText("New")).toHaveClass("h-4", "text-(length:--text-micro)");
  });
});
