// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { Callout } from "./callout.js";

afterEach(cleanup);

describe("Callout", () => {
  it("shows a title over a quieter body with the tone's icon", () => {
    const { container } = render(
      <Callout tone="warning" title="Not a Git repository">
        Worktrees and Files review are unavailable for this folder.
      </Callout>,
    );
    const callout = container.querySelector("[data-slot=callout]")!;
    expect(callout).toHaveAttribute("data-tone", "warning");
    expect(callout).toHaveClass("bg-warning-soft", "border-warning-border", "rounded-(--radius-ctl)");
    expect(callout.querySelector("[data-slot=callout-icon]")).toHaveAttribute("aria-hidden", "true");
    expect(callout.querySelector("[data-slot=callout-icon] svg")).not.toBeNull();
    expect(screen.getByText("Not a Git repository")).toHaveClass("font-medium");
    expect(screen.getByText(/Worktrees and Files review/)).toHaveClass("text-muted-foreground", "text-(length:--text-meta)");
  });

  it("uses the body as the message when there is no title", () => {
    render(<Callout tone="danger" role="alert">Could not reach the host.</Callout>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("bg-destructive-soft");
    expect(screen.getByText("Could not reach the host.")).not.toHaveClass("text-muted-foreground");
  });

  it.each([
    ["neutral", "bg-card"],
    ["info", "bg-info-soft"],
    ["danger", "border-destructive-border"],
  ] as const)("renders the %s tone", (tone, className) => {
    const { container } = render(<Callout tone={tone}>Notice</Callout>);
    expect(container.querySelector("[data-slot=callout]")).toHaveClass(className);
  });

  it("renders an action and a custom icon", () => {
    const { container } = render(
      <Callout tone="info" title="2 hosts awaiting approval" action={<Button size="sm">Review</Button>} icon={<svg data-testid="custom" />}>
        Accept them to run threads there.
      </Callout>,
    );
    expect(screen.getByRole("button", { name: "Review" }).closest("[data-slot=callout-action]")).not.toBeNull();
    expect(container.querySelector("[data-slot=callout-icon] [data-testid=custom]")).not.toBeNull();
  });
});
