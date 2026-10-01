// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control.js";

afterEach(cleanup);

function Density({ onValueChange }: { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState("comfortable");
  return (
    <SegmentedControl
      aria-label="Density"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange(next);
      }}
    >
      <SegmentedControlItem value="compact">Compact</SegmentedControlItem>
      <SegmentedControlItem value="comfortable">Comfortable</SegmentedControlItem>
      <SegmentedControlItem value="spacious" disabled>Spacious</SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("SegmentedControl", () => {
  it("is a radiogroup with the selected segment marked", () => {
    render(<Density onValueChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Density" })).toHaveClass("h-(--control-default)");
    const selected = screen.getByRole("radio", { name: "Comfortable" });
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(selected).toHaveAttribute("data-state", "on");
    expect(selected).toHaveClass("data-[state=on]:bg-popover", "data-[state=on]:shadow-(--elevation-1)");
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "false");
  });

  it("selects another segment and never clears the selection", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Density onValueChange={onValueChange} />);
    await user.click(screen.getByRole("radio", { name: "Compact" }));
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Compact" }));
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Spacious" }));
    expect(onValueChange.mock.calls).toEqual([["compact"]]);
  });

  it("works uncontrolled and moves focus with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <SegmentedControl aria-label="View" defaultValue="list" size="sm">
        <SegmentedControlItem value="list">List</SegmentedControlItem>
        <SegmentedControlItem value="board">Board</SegmentedControlItem>
      </SegmentedControl>,
    );
    expect(screen.getByRole("radiogroup", { name: "View" })).toHaveClass("h-(--control-sm)");
    expect(screen.getByRole("radio", { name: "List" })).toHaveClass("text-(length:--text-meta)");
    await user.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Board" })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "false");
  });
});
