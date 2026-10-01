// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksPanelToggle } from "./TasksPanelToggle.js";

afterEach(cleanup);

function badge(): HTMLElement | null {
  return screen
    .getByTestId("tasks-panel-toggle")
    .querySelector('[data-slot="count-badge"]');
}

describe("TasksPanelToggle", () => {
  it("shows no badge and no count without open tasks", () => {
    render(<TasksPanelToggle open={false} onToggle={() => undefined} />);

    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel",
    );
    expect(badge()).toBeNull();
  });

  it("badges the open count of the current context, neutral and untinted", () => {
    render(
      <TasksPanelToggle open={false} onToggle={() => undefined} count={3} />,
    );

    const toggle = screen.getByTestId("tasks-panel-toggle");
    expect(toggle).toHaveAccessibleName("Open Tasks panel, 3 open tasks");
    expect(badge()).toHaveTextContent("3");
    expect(badge()).toHaveAttribute("data-tone", "neutral");
    expect(badge()).toHaveAttribute("aria-hidden", "true");
    expect(toggle).not.toHaveAttribute("data-has-items");
  });

  it("names a single task and caps large counts", () => {
    const { rerender } = render(
      <TasksPanelToggle open={false} onToggle={() => undefined} count={1} />,
    );
    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel, 1 open task",
    );

    rerender(
      <TasksPanelToggle open={false} onToggle={() => undefined} count={120} />,
    );
    expect(badge()).toHaveTextContent("99+");
    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel, 120 open tasks",
    );
  });

  it("asks its host to toggle Tasks and reflects the open state", () => {
    const onToggle = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <TasksPanelToggle
          open={open}
          count={2}
          onToggle={(invoker) => {
            onToggle(invoker);
            setOpen((current) => !current);
          }}
        />
      );
    }
    render(<Harness />);
    const toggle = screen.getByTestId("tasks-panel-toggle");

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Close Tasks panel, 2 open tasks");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("Open Tasks panel, 2 open tasks");
  });

  it("tells open but off stage apart from closed", () => {
    const { rerender } = render(
      <TasksPanelToggle open={false} onToggle={() => undefined} count={2} />,
    );
    const toggle = screen.getByTestId("tasks-panel-toggle");
    expect(toggle).toHaveAttribute("data-state", "closed");

    rerender(
      <TasksPanelToggle open={false} collapsed onToggle={() => undefined} count={2} />,
    );
    expect(toggle).toHaveAttribute("data-state", "collapsed");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("Show collapsed Tasks panel, 2 open tasks");

    // Shown, it is simply open.
    rerender(
      <TasksPanelToggle open collapsed onToggle={() => undefined} count={2} />,
    );
    expect(toggle).toHaveAttribute("data-state", "open");
    expect(toggle).toHaveAccessibleName("Close Tasks panel, 2 open tasks");
  });
});
