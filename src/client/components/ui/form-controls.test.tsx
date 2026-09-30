// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { Checkbox } from "./checkbox.js";
import { controlVariants } from "./control.js";
import { Input } from "./input.js";
import { Label } from "./label.js";
import { NativeSelect } from "./native-select.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

const CONTROL_BOX = [
  "rounded-(--radius-ctl)",
  "border-input",
  "text-(length:--text-input)",
  "focus-visible:ring-3",
  "focus-visible:ring-ring/50",
  "aria-invalid:border-destructive",
];

describe("form controls", () => {
  it("share one control box with a density-aware height", () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <NativeSelect aria-label="Kind">
          <option>Local</option>
        </NativeSelect>
        <Select>
          <SelectTrigger aria-label="Environment">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
        </Select>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    const native = screen.getByRole("combobox", { name: "Kind" });
    const trigger = screen.getByRole("combobox", { name: "Environment" });
    for (const control of [input, textarea, native, trigger]) {
      expect(control).toHaveClass(...CONTROL_BOX);
    }
    for (const control of [input, native, trigger]) {
      expect(control).toHaveClass("h-(--control-default)");
    }
    expect(textarea).not.toHaveClass("h-(--control-default)");
    expect(input).not.toHaveClass("h-9", "text-base", "md:text-sm");
  });

  it("gives the compact size the fixed control step", () => {
    expect(controlVariants({ size: "sm" })).toContain("h-(--control-sm)");
    render(
      <NativeSelect aria-label="Scope" size="sm">
        <option>All</option>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "Scope" });
    expect(select).toHaveClass("h-(--control-sm)");
    expect(select).not.toHaveClass("h-(--control-default)");
  });

  it("lets call sites override the box", () => {
    render(<Input aria-label="Search" className="h-6 text-xs" />);
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input).toHaveClass("h-6", "text-xs");
    expect(input).not.toHaveClass("h-(--control-default)", "text-(length:--text-input)");
  });

  it("sets labels at 13px medium", () => {
    render(<Label>Name</Label>);
    expect(screen.getByText("Name")).toHaveClass("text-(length:--text-ui)", "font-medium");
  });

  it("keeps Checkbox on the tokens", () => {
    render(<Checkbox aria-label="Pin" />);
    expect(screen.getByRole("checkbox", { name: "Pin" })).toHaveClass(
      "size-(--icon-md)",
      "rounded-(--radius-inline)",
      "focus-visible:ring-3",
      "disabled:opacity-(--disabled-opacity)",
    );
  });
});

describe("Button", () => {
  it("fills destructive solid with white text and a darker hover", () => {
    render(<Button variant="destructive">Remove environment</Button>);
    const button = screen.getByRole("button", { name: "Remove environment" });
    expect(button).toHaveAttribute("data-variant", "destructive");
    expect(button).toHaveClass(
      "bg-(--destructive-solid)",
      "text-white",
      "hover:bg-(--destructive-solid-hover)",
    );
    expect(button).not.toHaveClass("bg-destructive/10", "text-destructive");
  });

  it.each([
    ["xs", "h-(--control-xs)"],
    ["sm", "h-(--control-sm)"],
    ["default", "h-(--control-md)"],
    ["lg", "h-(--control-lg)"],
    ["icon-xs", "size-(--control-xs)"],
    ["icon-sm", "size-(--control-sm)"],
    ["icon", "size-(--control-md)"],
    ["icon-lg", "size-(--control-lg)"],
  ] as const)("maps size %s to the control step", (size, height) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveClass(height);
  });

  it("does not follow the density switch by itself", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveClass("h-(--control-default)");
  });
});
