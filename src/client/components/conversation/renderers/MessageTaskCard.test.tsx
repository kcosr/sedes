// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const reveal = vi.hoisted(() => vi.fn());
vi.mock("../../../app/tasks-reveal.js", () => ({ revealTask: reveal }));

import { MessageTaskCard } from "./MessageTaskCard.js";

afterEach(() => {
  cleanup();
  reveal.mockReset();
});

const taskId = "84f9a3b0-9c14-456d-b08d-58d325d869d0";

function card(): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)!;
}

describe("MessageTaskCard", () => {
  it("shows the title and a notes preview, with the identifiers behind Details", async () => {
    const user = userEvent.setup();
    render(
      <MessageTaskCard
        taskId={taskId}
        title="Audit checkout error states"
        notes={"Walk every error branch.\n\nKnown gaps: card declined."}
        revision={4}
      />,
    );

    expect(card()).toHaveClass("message-task-card");
    expect(card()).toHaveTextContent("Audit checkout error states");
    expect(card().querySelector(".message-task-card-notes")).toHaveTextContent(
      "Walk every error branch. Known gaps: card declined.",
    );
    expect(card()).not.toHaveTextContent("Completed");
    expect(card()).not.toHaveTextContent(taskId);

    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(card()).toHaveAttribute("data-state", "open");
    expect(card()).toHaveTextContent(`Task ID${taskId}`);
    expect(card()).toHaveTextContent("Revision4");

    await user.click(details);
    expect(card()).not.toHaveTextContent(taskId);
  });

  it("marks a task that was completed when the message was sent", () => {
    render(
      <MessageTaskCard taskId={taskId} title="Write migration notes" completed />,
    );

    expect(card()).toHaveAttribute("data-completed", "true");
    expect(card()).toHaveTextContent("Completed");
    expect(card().querySelector(".message-task-card-notes")).toBeNull();
  });

  it("reveals the task in Tasks from Open task", async () => {
    const user = userEvent.setup();
    render(<MessageTaskCard taskId={taskId} title="Audit checkout error states" />);

    await user.click(
      screen.getByRole("button", { name: "Open task: Audit checkout error states" }),
    );

    expect(reveal).toHaveBeenCalledWith(taskId);
  });

  it("omits the revision for a reference that has not been delivered yet", async () => {
    const user = userEvent.setup();
    render(<MessageTaskCard taskId={taskId} title="Pending task" />);

    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(card()).toHaveTextContent(`Task ID${taskId}`);
    expect(card()).not.toHaveTextContent("Revision");
  });
});
