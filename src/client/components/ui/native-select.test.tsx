// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSelect } from "./native-select.js";

afterEach(cleanup);

describe("NativeSelect", () => {
  it("renders a native select without the platform arrow, and a chevron", () => {
    const { container } = render(
      <NativeSelect aria-label="Kind" defaultValue="ssh">
        <option value="local">Local</option>
        <option value="ssh">SSH host</option>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "Kind" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("ssh");
    expect(select).toHaveClass("appearance-none", "pr-8");
    expect(container.querySelector("[data-slot=native-select-wrapper] > svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps its wrapper as tall as the select, so a stretching parent cannot move the chevron", () => {
    const { container } = render(
      <NativeSelect aria-label="Kind">
        <option value="local">Local</option>
      </NativeSelect>,
    );
    const wrapper = container.querySelector("[data-slot=native-select-wrapper]")!;
    expect(wrapper).toHaveClass("h-fit", "relative");
    expect(wrapper.querySelector("svg")).toHaveClass("top-1/2", "-translate-y-1/2");
  });

  it("forwards change events and puts className on the box", () => {
    const onChange = vi.fn();
    const { container } = render(
      <NativeSelect aria-label="Kind" className="w-40" value="local" onChange={onChange}>
        <option value="local">Local</option>
        <option value="ssh">SSH host</option>
      </NativeSelect>,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "ssh" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-slot=native-select-wrapper]")).toHaveClass("w-40");
  });

  it("passes disabled to the select", () => {
    render(
      <NativeSelect aria-label="Kind" disabled>
        <option>Local</option>
      </NativeSelect>,
    );
    expect(screen.getByRole("combobox", { name: "Kind" })).toBeDisabled();
  });
});
