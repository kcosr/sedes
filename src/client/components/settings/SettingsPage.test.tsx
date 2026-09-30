// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { DangerZone, DangerZoneItem } from "./DangerZone.js";
import { SettingsField, SwitchField } from "./SettingsField.js";
import { SettingsPage } from "./SettingsPage.js";
import { SettingsSection, SettingsSubgroup } from "./SettingsSection.js";

afterEach(cleanup);

describe("SettingsPage", () => {
  it("renders the title, description and actions with the primary last", () => {
    const headingRef = createRef<HTMLHeadingElement>();
    const { container } = render(
      <SettingsPage
        title="Environments"
        description="Where threads run."
        headingRef={headingRef}
        actions={<><Button variant="outline">Pair a host</Button><Button>Add environment</Button></>}
      >
        <p>Body</p>
      </SettingsPage>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Environments" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(headingRef.current).toBe(heading);
    expect(screen.getByText("Where threads run.")).toHaveAttribute("data-slot", "settings-page-description");
    const actions = container.querySelector("[data-slot=settings-page-actions]")!;
    expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Pair a host", "Add environment"]);
    expect(container.querySelector("[data-slot=settings-page]")).toHaveAttribute("data-width", "default");
    expect(container.querySelector("[data-slot=settings-page-body]")).toHaveTextContent("Body");
  });

  it("renders a back link or button and the wide width", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault());
    const { rerender, container } = render(
      <SettingsPage title="General" width="wide" back={{ label: "Settings", href: "/settings", onNavigate }} />,
    );
    expect(container.querySelector("[data-slot=settings-page]")).toHaveAttribute("data-width", "wide");
    const link = screen.getByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings");
    await user.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();

    rerender(<SettingsPage title="General" back={{ label: "Environments", onNavigate }} />);
    await user.click(screen.getByRole("button", { name: "Environments" }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsSection", () => {
  it("names the section by its title and frames a card body", () => {
    const { container } = render(
      <SettingsSection title="Workspace access" description="Folders threads may use." card actions={<Button size="sm">Add</Button>}>
        <p>Rows</p>
      </SettingsSection>,
    );
    const section = screen.getByRole("region", { name: "Workspace access" });
    expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent("Workspace access");
    expect(container.querySelector("[data-slot=settings-section-body]")).toHaveAttribute("data-card", "true");
    expect(within(section).getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("renders a plain body without a header when untitled, and subgroups", () => {
    const { container } = render(
      <SettingsSection>
        <SettingsSubgroup title="Advanced" description="Executable paths and timeouts.">
          <p>Advanced rows</p>
        </SettingsSubgroup>
      </SettingsSection>,
    );
    expect(container.querySelector("[data-slot=settings-section-header]")).toBeNull();
    expect(container.querySelector("[data-slot=settings-section-body]")).not.toHaveAttribute("data-card");
    expect(screen.getByRole("group", { name: "Advanced" })).toHaveTextContent("Advanced rows");
    expect(screen.getByRole("heading", { level: 3, name: "Advanced" })).toHaveAttribute("data-slot", "settings-subgroup-title");
  });
});

describe("SettingsField and SwitchField", () => {
  it("lays a field out as a horizontal row by default and stacked on request", () => {
    const { container } = render(
      <>
        <SettingsField label="Name" description="Shown in the sidebar." error="Enter a name.">
          <Input />
        </SettingsField>
        <SettingsField label="Notes" layout="stacked">
          <Input />
        </SettingsField>
      </>,
    );
    const [row, stacked] = container.querySelectorAll("[data-slot=settings-field]");
    expect(row).toHaveAttribute("data-orientation", "horizontal");
    expect(stacked).toHaveAttribute("data-orientation", "vertical");
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter a name. Shown in the sidebar.");
  });

  it("toggles a switch row from its label", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { container } = render(
      <SwitchField label="Play a sound" description="When a turn finishes." onCheckedChange={onCheckedChange} />,
    );
    expect(container.querySelector("[data-slot=switch-field]")).toHaveAttribute("data-orientation", "horizontal");
    const control = screen.getByRole("switch", { name: "Play a sound" });
    expect(control).toHaveAccessibleDescription("When a turn finishes.");
    await user.click(screen.getByText("Play a sound"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(control).toHaveAttribute("aria-checked", "true");
  });

  it("disables the switch with the row", () => {
    render(<SwitchField label="Play a sound" checked disabled />);
    expect(screen.getByRole("switch", { name: "Play a sound" })).toBeDisabled();
  });
});

describe("DangerZone", () => {
  it("is a titled card section of destructive items", () => {
    const { container } = render(
      <DangerZone>
        <DangerZoneItem
          title="Remove environment"
          description="Its backends are removed too. This can't be undone."
          action={<Button variant="destructive">Remove…</Button>}
        />
      </DangerZone>,
    );
    const section = screen.getByRole("region", { name: "Danger zone" });
    expect(section).toHaveAttribute("data-variant", "danger");
    expect(container.querySelector("[data-slot=settings-section-body]")).toHaveAttribute("data-card", "true");
    expect(within(section).getByText("Remove environment")).toHaveAttribute("data-slot", "danger-zone-title");
    expect(within(section).getByRole("button", { name: "Remove…" })).toHaveAttribute("data-variant", "destructive");
  });
});
