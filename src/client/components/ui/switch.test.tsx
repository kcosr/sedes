// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./switch.js";

afterEach(cleanup);

describe("Switch", () => {
  it("is a switch that flips on click and Space", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Start a new thread here" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Start a new thread here" });
    expect(control).toHaveAttribute("aria-checked", "false");
    await user.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("data-state", "checked");
    await user.keyboard(" ");
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("respects controlled and disabled state", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Sound" checked disabled onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Sound" });
    expect(control).toBeDisabled();
    await user.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(control).toHaveAttribute("aria-checked", "true");
  });
});
