// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox.js";
import { Field } from "./field.js";
import { Input } from "./input.js";
import { NativeSelect } from "./native-select.js";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Switch } from "./switch.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

describe("Field", () => {
  it("labels the control and describes it with its description", async () => {
    const user = userEvent.setup();
    render(
      <Field label="Location" description="An absolute path on the selected environment.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Location" });
    expect(input).toHaveAccessibleDescription("An absolute path on the selected environment.");
    expect(input).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByText("Location"));
    expect(input).toHaveFocus();
  });

  it("shows an error under the control with an icon and marks it invalid", () => {
    const { container } = render(
      <Field label="Name" description="Shown in the sidebar." error="Enter a name.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a name. Shown in the sidebar.");
    const error = container.querySelector("[data-slot=field-error]")!;
    expect(error).toHaveTextContent("Enter a name.");
    expect(error.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-slot=field]")).toHaveAttribute("data-invalid", "true");
    // Vertical order: label, control, description, error.
    const order = [...container.querySelector("[data-slot=field]")!.children].map(
      (child) => child.getAttribute("data-slot") ?? child.tagName.toLowerCase(),
    );
    expect(order).toEqual(["field-label", "input", "field-description", "field-error"]);
  });

  it("puts label and description beside the control when horizontal", () => {
    const { container } = render(
      <Field label="Start a new thread here" description="Opens the project right after it is added." orientation="horizontal">
        <Switch />
      </Field>,
    );
    const field = container.querySelector("[data-slot=field]")!;
    expect(field).toHaveAttribute("data-orientation", "horizontal");
    expect(field.querySelector("[data-slot=field-text]")).toHaveTextContent("Start a new thread here");
    expect(field.querySelector("[data-slot=field-control] [role=switch]")).not.toBeNull();
    expect(screen.getByRole("switch", { name: "Start a new thread here" })).toHaveAccessibleDescription(
      "Opens the project right after it is added.",
    );
  });

  it("wires every control primitive", () => {
    render(
      <>
        <Field label="Notes" error="Too long.">
          <Textarea />
        </Field>
        <Field label="Kind">
          <NativeSelect>
            <option>Local</option>
          </NativeSelect>
        </Field>
        <Field label="Environment" description="Where threads run.">
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
          </Select>
        </Field>
        <Field label="Pinned">
          <Checkbox />
        </Field>
        <Field label="Density" description="Row height in the sidebar.">
          <SegmentedControl defaultValue="compact">
            <SegmentedControlItem value="compact">Compact</SegmentedControlItem>
          </SegmentedControl>
        </Field>
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox", { name: "Kind" }).tagName).toBe("SELECT");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveAccessibleDescription("Where threads run.");
    expect(screen.getByRole("checkbox", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Density" })).toHaveAccessibleDescription("Row height in the sidebar.");
  });

  it("keeps ids and descriptions the control sets itself", () => {
    render(
      <>
        <p id="extra">Also read this.</p>
        <Field label="Token" id="pairing-token" description="From the host.">
          <Input aria-describedby="extra" />
        </Field>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Token" });
    expect(input).toHaveAttribute("id", "pairing-token");
    expect(input).toHaveAccessibleDescription("Also read this. From the host.");
  });

  it("dims the label when disabled", () => {
    const { container } = render(
      <Field label="Name" disabled>
        <Input disabled />
      </Field>,
    );
    expect(container.querySelector("[data-slot=field]")).toHaveAttribute("data-disabled", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  });
});
