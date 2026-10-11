// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskAddRow, type TaskAddDraft } from "./TaskAddRow.js";

afterEach(cleanup);

function renderDraft(variant: "row" | "bar") {
  const onParentKeyDown = vi.fn();
  const onAdd = vi.fn();
  function Draft(): React.JSX.Element {
    const [draft, setDraft] = useState<TaskAddDraft>({
      title: "Draft title",
      notes: "Draft notes",
      notesOpen: true,
      pinned: true,
    });
    return (
      <div onKeyDown={onParentKeyDown}>
        <TaskAddRow
          variant={variant}
          placeholder="Add a task"
          draft={draft}
          defaultPinned={false}
          inputRef={null}
          onDraftChange={setDraft}
          onAdd={onAdd}
          onPasteMany={vi.fn()}
        />
      </div>
    );
  }
  render(<Draft />);
  return { onParentKeyDown, onAdd };
}

describe.each(["row", "bar"] as const)("TaskAddRow %s Escape", (variant) => {
  it.each([
    ["Add a task", "New task notes", "Draft notes"],
    ["New task notes", "Add a task", "Draft title"],
  ])("clears only %s, retains focus, then blurs when empty", async (label, otherLabel, otherValue) => {
    const user = userEvent.setup();
    const { onParentKeyDown, onAdd } = renderDraft(variant);
    const input = screen.getByRole("textbox", { name: label });
    const other = screen.getByRole("textbox", { name: otherLabel });
    await user.click(input);

    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(other).toHaveValue(otherValue);
    expect(screen.getByRole("textbox", { name: "New task notes" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pin new task" })).toHaveAttribute("aria-pressed", "true");

    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(input).not.toHaveFocus();
    expect(other).toHaveValue(otherValue);
    expect(screen.getByRole("textbox", { name: "New task notes" })).toBeVisible();
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();

    // Notes remains editable after both Escape presses.
    const notes = screen.getByRole("textbox", { name: "New task notes" });
    await user.type(notes, " More notes");
    expect(notes).toHaveValue(`${label === "New task notes" ? "" : "Draft notes"} More notes`);
  });

  it.each(["Add a task", "New task notes"])("ignores composing Escape in populated and empty %s", async (label) => {
    const user = userEvent.setup();
    renderDraft(variant);
    const input = screen.getByRole("textbox", { name: label });
    await user.click(input);
    const value = label === "Add a task" ? "Draft title" : "Draft notes";

    expect(fireEvent.keyDown(input, { key: "Escape", isComposing: true })).toBe(true);
    expect(input).toHaveValue(value);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "" } });
    expect(fireEvent.keyDown(input, { key: "Escape", isComposing: true })).toBe(true);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });
});
