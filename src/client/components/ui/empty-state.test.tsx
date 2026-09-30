// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { EmptyState } from "./empty-state.js";
import { KeyValueList } from "./key-value-list.js";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders a dashed panel with icon, title, description and action", () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No environments yet"
        description="Add this machine, an SSH host, or pair a host."
        action={<Button>Add environment</Button>}
      />,
    );
    const panel = container.querySelector("[data-slot=empty-state]")!;
    expect(panel).toHaveAttribute("data-variant", "panel");
    expect(panel).toHaveClass("border-dashed", "rounded-(--radius-card)", "text-center");
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("No environments yet")).toHaveClass("font-medium");
    expect(screen.getByRole("button", { name: "Add environment" })).toBeInTheDocument();
  });

  it("renders a quiet inline line", () => {
    const { container } = render(<EmptyState variant="inline" title="No variables." description="Add one below." />);
    const inline = container.querySelector("[data-slot=empty-state]")!;
    expect(inline).toHaveAttribute("data-variant", "inline");
    expect(inline).not.toHaveClass("border-dashed");
    expect(screen.getByText("No variables.")).toHaveClass("text-muted-foreground");
    expect(screen.getByText("Add one below.")).toHaveClass("text-(length:--text-meta)");
  });
});

describe("KeyValueList", () => {
  it("renders a description list on a max-content grid", () => {
    const { container } = render(
      <KeyValueList
        items={[
          { label: "Host", value: "build.example.com" },
          { label: "Revision", value: "7f3c2a1", mono: true },
          { key: "roots", label: <span>Workspace roots</span>, value: "/srv/work" },
        ]}
      />,
    );
    const list = container.querySelector("dl")!;
    expect(list).toHaveClass("grid-cols-[max-content_minmax(0,1fr)]");
    const terms = [...list.querySelectorAll("dt")].map((node) => node.textContent);
    const values = [...list.querySelectorAll("dd")].map((node) => node.textContent);
    expect(terms).toEqual(["Host", "Revision", "Workspace roots"]);
    expect(values).toEqual(["build.example.com", "7f3c2a1", "/srv/work"]);
    expect(screen.getByText("7f3c2a1")).toHaveClass("font-mono", "break-all");
    expect(screen.getByText("build.example.com")).not.toHaveClass("font-mono");
  });
});
