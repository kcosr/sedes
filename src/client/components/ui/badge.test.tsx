// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge.js";
import { CountBadge } from "./count-badge.js";
import { StatusPill } from "./status-pill.js";
import { Tag } from "./tag.js";

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

describe("StatusPill", () => {
  it.each([
    ["neutral", "text-muted-foreground"],
    ["success", "text-success"],
    ["info", "text-info"],
    ["warning", "text-warning"],
    ["danger", "text-destructive"],
  ] as const)("shows a %s dot and label", (tone, color) => {
    render(<StatusPill tone={tone}>State</StatusPill>);
    const pill = screen.getByText("State");
    expect(pill).toHaveAttribute("data-slot", "status-pill");
    expect(pill).toHaveAttribute("data-status", tone);
    expect(pill).toHaveClass(color, "rounded-full");
    const dot = pill.querySelector("[data-slot=status-pill-dot]");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveClass("bg-current");
  });
});

describe("CountBadge", () => {
  it("shows the count and caps it", () => {
    render(
      <>
        <CountBadge count={7} data-testid="seven" />
        <CountBadge count={140} tone="primary" data-testid="many" />
        <CountBadge count={12} max={9} tone="warning" data-testid="capped" />
      </>,
    );
    expect(screen.getByTestId("seven")).toHaveTextContent("7");
    expect(screen.getByTestId("seven")).toHaveClass("tabular-nums", "text-(length:--text-micro)");
    expect(screen.getByTestId("many")).toHaveTextContent("99+");
    expect(screen.getByTestId("many")).toHaveClass("bg-primary");
    expect(screen.getByTestId("capped")).toHaveTextContent("9+");
  });
});

describe("Tag", () => {
  it("is a neutral outlined attribute on the nested radius", () => {
    render(<Tag>Default</Tag>);
    expect(screen.getByText("Default")).toHaveClass("border-border", "rounded-(--radius-inline)", "text-(length:--text-label)");
  });
});
