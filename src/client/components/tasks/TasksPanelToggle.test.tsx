// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTasksPanelPreferences,
  setTasksPanelOpen,
} from "../../app/tasks-panel-store.js";
import { TasksPanelToggle } from "./TasksPanelToggle.js";

beforeEach(() => {
  window.localStorage.clear();
  setTasksPanelOpen(false);
});

afterEach(cleanup);

function badge(): HTMLElement | null {
  return screen
    .getByTestId("tasks-panel-toggle")
    .querySelector('[data-slot="count-badge"]');
}

describe("TasksPanelToggle", () => {
  it("shows no badge and no count without open tasks", () => {
    render(<TasksPanelToggle />);

    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel",
    );
    expect(badge()).toBeNull();
  });

  it("badges the open count of the current context, neutral and untinted", () => {
    render(<TasksPanelToggle count={3} />);

    const toggle = screen.getByTestId("tasks-panel-toggle");
    expect(toggle).toHaveAccessibleName("Open Tasks panel, 3 open tasks");
    expect(badge()).toHaveTextContent("3");
    expect(badge()).toHaveAttribute("data-tone", "neutral");
    expect(badge()).toHaveAttribute("aria-hidden", "true");
    expect(toggle).not.toHaveAttribute("data-has-items");
  });

  it("names a single task and caps large counts", () => {
    const { rerender } = render(<TasksPanelToggle count={1} />);
    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel, 1 open task",
    );

    rerender(<TasksPanelToggle count={120} />);
    expect(badge()).toHaveTextContent("99+");
    expect(screen.getByTestId("tasks-panel-toggle")).toHaveAccessibleName(
      "Open Tasks panel, 120 open tasks",
    );
  });

  it("opens and closes Tasks", () => {
    render(<TasksPanelToggle count={2} />);
    const toggle = screen.getByTestId("tasks-panel-toggle");

    fireEvent.click(toggle);
    expect(getTasksPanelPreferences().open).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Close Tasks panel, 2 open tasks");

    fireEvent.click(toggle);
    expect(getTasksPanelPreferences().open).toBe(false);
  });
});
