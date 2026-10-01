// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExactToolSelector, type ExactToolGroup } from "./ExactToolSelector.js";

afterEach(cleanup);

const groups: readonly ExactToolGroup[] = [
  {
    id: "threads",
    label: "Threads",
    description: "Inspect and control threads.",
    tools: [
      {
        id: "thread.status",
        label: "Thread status",
        description: "Read thread status.",
        effects: { application: "read", modelUsage: "none", external: "none" },
      },
      {
        id: "thread.send",
        label: "Send message",
        description: "Send a message and start model work.",
        effects: {
          application: "write",
          modelUsage: "agent_execution",
          external: "durable_side_effect",
        },
      },
      {
        id: "thread.fork",
        label: "Fork thread",
        description: "Fork a thread.",
        available: false,
        unavailableReason: "Forking is off.",
      },
    ],
  },
  {
    id: "research",
    label: "Research",
    description: "Research public information.",
    tools: [
      {
        id: "research.web",
        label: "Web search",
        description: "Search the web.",
        available: false,
      },
    ],
  },
];

describe("ExactToolSelector", () => {
  it("collapses each group behind a trigger that summarizes its selection", () => {
    render(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.status"]}
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Threads" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Unavailable tools do not count toward what can be granted.
    expect(trigger).toHaveAccessibleDescription(
      "1 of 2 tools Inspect and control threads.",
    );
    expect(screen.getByRole("group", { name: "Threads" })).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: "Thread status" }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("checkbox", { name: "Thread status" }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Fork thread" })).toBeDisabled();

    expect(
      screen.getByRole("button", { name: "Research" }),
    ).toHaveAccessibleDescription(
      "No tools available Research public information.",
    );
    expect(
      screen.getByRole("checkbox", { name: "Select all Research tools" }),
    ).toBeDisabled();
  });

  it("keeps select-all beside the trigger and grants only available tools", () => {
    const onChange = vi.fn();
    const view = render(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.status"]}
        onChange={onChange}
      />,
    );

    const selectAll = screen.getByRole("checkbox", {
      name: "Select all Threads tools",
    });
    expect(selectAll).toHaveAccessibleDescription("Inspect and control threads.");
    expect(selectAll).toHaveAttribute("data-state", "indeterminate");
    expect(
      screen.getByRole("button", { name: "Threads" }),
    ).not.toContainElement(selectAll);

    fireEvent.click(selectAll);
    expect(onChange).toHaveBeenLastCalledWith(["thread.status", "thread.send"]);
    // Selecting from the header leaves the group closed.
    expect(
      screen.getByRole("button", { name: "Threads" }),
    ).toHaveAttribute("aria-expanded", "false");

    view.rerender(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.status", "thread.send"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all Threads tools" }),
    );
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("flags a risky selection only when effects are shown", () => {
    const view = render(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.send"]}
        showEffects
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Threads" }),
    ).toHaveAccessibleDescription(
      "1 of 2 tools High risk Inspect and control threads.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(
      screen.getByRole("checkbox", { name: "Send message" }),
    ).toHaveAccessibleDescription(
      "Send a message and start model work. Starts model execution",
    );

    view.rerender(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.send"]}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Threads" }),
    ).toHaveAccessibleDescription("1 of 2 tools Inspect and control threads.");
  });

  it("opens groups that hold selections needing removal", () => {
    const onChange = vi.fn();
    render(
      <ExactToolSelector
        groups={groups}
        selectedToolIds={["thread.fork", "missing.tool"]}
        unavailableToolIds={["missing.tool"]}
        onChange={onChange}
      />,
    );

    const threads = screen.getByRole("button", { name: "Threads" });
    expect(threads).toHaveAttribute("aria-expanded", "true");
    expect(threads).toHaveAccessibleDescription(
      "0 of 2 tools 1 unavailable Inspect and control threads.",
    );
    expect(screen.getByRole("checkbox", { name: "Fork thread" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Research" }),
    ).toHaveAttribute("aria-expanded", "false");

    expect(
      screen.getByRole("button", { name: "Unavailable selections" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Remove unavailable tool missing.tool" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(["thread.fork"]);
  });
});
