// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "./checkbox.js";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu.js";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu.js";
import { Field } from "./field.js";
import { Input } from "./input.js";
import { NativeSelect } from "./native-select.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";
import { Switch } from "./switch.js";
import { Textarea } from "./textarea.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe("Field context across portals", () => {
  // React context flows through portals, so floating and modal content
  // rendered under a Field must start outside it.
  function expectUnwired(input: HTMLElement, fieldControl: HTMLElement) {
    expect(input.id).not.toBe(fieldControl.id);
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
  }

  function FieldWith({ children }: { readonly children: React.ReactNode }) {
    return (
      <Field label="Name" description="Shown in the sidebar." error="Enter a name.">
        <Input />
        {children}
      </Field>
    );
  }

  it.each([
    [
      "popover",
      <Popover open key="popover">
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent aria-label="Details">
          <Input aria-label="Inner" />
        </PopoverContent>
      </Popover>,
    ],
    [
      "dropdown menu",
      <DropdownMenu open key="dropdown">
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <Input aria-label="Inner" />
        </DropdownMenuContent>
      </DropdownMenu>,
    ],
    [
      "dropdown menu as a sheet",
      <DropdownMenu open presentation="sheet" key="sheet">
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Actions">
          <Input aria-label="Inner" />
        </DropdownMenuContent>
      </DropdownMenu>,
    ],
    [
      "dialog",
      <Dialog open key="dialog">
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Rename</DialogTitle>
          <Input aria-label="Inner" />
        </DialogContent>
      </Dialog>,
    ],
  ] as const)("does not wire a control inside a %s", (_name, surface) => {
    render(<FieldWith>{surface}</FieldWith>);
    const fieldControl = screen.getByRole("textbox", { name: "Name", hidden: true });
    expect(fieldControl).toHaveAttribute("aria-invalid", "true");
    expectUnwired(screen.getByRole("textbox", { name: "Inner", hidden: true }), fieldControl);
  });

  it("does not wire a control inside a context menu", () => {
    render(
      <FieldWith>
        <ContextMenu>
          <ContextMenuTrigger>Row</ContextMenuTrigger>
          <ContextMenuContent>
            <Input aria-label="Inner" />
          </ContextMenuContent>
        </ContextMenu>
      </FieldWith>,
    );
    fireEvent.contextMenu(screen.getByText("Row"));
    expectUnwired(
      screen.getByRole("textbox", { name: "Inner" }),
      screen.getByRole("textbox", { name: "Name", hidden: true }),
    );
  });

  it("does not wire a control inside select content", () => {
    render(
      <Field label="Environment" error="Choose one.">
        <Select open value="local">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local</SelectItem>
            <Input aria-label="Inner" />
          </SelectContent>
        </Select>
      </Field>,
    );
    const trigger = screen.getByRole("combobox", { name: "Environment", hidden: true });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expectUnwired(screen.getByRole("textbox", { name: "Inner" }), trigger);
  });
});
