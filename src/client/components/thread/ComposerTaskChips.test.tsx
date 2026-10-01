// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerTaskChips,
  type ComposerTaskChipModel,
} from "./ComposerTaskChips.js";

afterEach(cleanup);

const chips: readonly ComposerTaskChipModel[] = [
  { taskId: "open", label: "Add retry with backoff", state: "available" },
  { taskId: "done", label: "Write migration notes", state: "completed" },
  { taskId: "gone", label: "Deleted task", state: "missing" },
  { taskId: "wait", label: "Not yet known", state: "checking" },
];

function chip(taskId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)!;
}

describe("ComposerTaskChips", () => {
  it("renders nothing without tasks", () => {
    const { container } = render(
      <ComposerTaskChips chips={[]} onRemove={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the attached tasks as compact pills", () => {
    render(<ComposerTaskChips chips={chips} onRemove={() => undefined} />);

    const list = screen.getByRole("list", { name: "Attached tasks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(chip("open")).toHaveClass("composer-task-chip");
    expect(chip("open")).toHaveAttribute("data-state", "available");
    expect(chip("open")).toHaveTextContent(/^Add retry with backoff$/u);
  });

  it("explains completed, missing and checking states in a tooltip and in text", () => {
    render(<ComposerTaskChips chips={chips} onRemove={() => undefined} />);

    expect(chip("open")).toHaveAttribute("title", "Add retry with backoff");
    expect(chip("done")).toHaveAttribute(
      "title",
      "Write migration notes\nThis task is completed. It is still sent with the prompt.",
    );
    expect(chip("gone")).toHaveAttribute(
      "title",
      "Deleted task\nThis task no longer exists. Remove it before sending.",
    );
    expect(chip("wait")).toHaveAttribute(
      "title",
      "Not yet known\nChecking this task…",
    );
    expect(within(chip("done")).getByText("Completed")).toHaveClass("sr-only");
    expect(within(chip("gone")).getByText("Missing task")).toHaveClass("sr-only");
    expect(within(chip("wait")).getByText("Checking")).toHaveClass("sr-only");
  });

  it("removes a task from its labelled × button, also from the keyboard", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<ComposerTaskChips chips={chips} onRemove={onRemove} />);

    await user.click(
      screen.getByRole("button", { name: "Remove task: Add retry with backoff" }),
    );
    expect(onRemove).toHaveBeenLastCalledWith("open");

    screen.getByRole("button", { name: "Remove task: Deleted task" }).focus();
    await user.keyboard("{Enter}");
    expect(onRemove).toHaveBeenLastCalledWith("gone");
    await user.keyboard(" ");
    expect(onRemove).toHaveBeenCalledTimes(3);
  });
});
