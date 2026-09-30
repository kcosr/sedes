// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@client/components/ui/button";
import { StatusPill } from "@client/components/ui/status-pill";
import { Tag } from "@client/components/ui/tag";
import { EntityList, EntityRow } from "./EntityList.js";

afterEach(cleanup);

describe("EntityList and EntityRow", () => {
  it("makes the whole row one control named by its content", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onMenu = vi.fn();
    render(
      <EntityList aria-label="Environments">
        <EntityRow
          icon={<svg />}
          title="Build server"
          subtitle="SSH host · 2 backends"
          tags={<Tag>Default</Tag>}
          status={<StatusPill tone="success">Connected</StatusPill>}
          actions={<Button size="icon-sm" variant="ghost" aria-label="Build server actions" onClick={onMenu} />}
          onSelect={onSelect}
        />
      </EntityList>,
    );
    const list = screen.getByRole("list", { name: "Environments" });
    const row = within(list).getByRole("listitem");
    const main = within(row).getByRole("button", { name: "Build server" });
    expect(main).toHaveAttribute("data-slot", "entity-row-main");
    expect(main).toHaveAccessibleDescription(/SSH host · 2 backends/);
    expect(main).toHaveAccessibleDescription(/Default\s*Connected/);
    expect(within(main).getByText("SSH host · 2 backends")).toHaveAttribute("title", "SSH host · 2 backends");
    await user.click(main);
    expect(onSelect).toHaveBeenCalledOnce();

    // The actions slot is its own tab stop, outside the main button.
    await user.tab();
    expect(screen.getByRole("button", { name: "Build server actions" })).toHaveFocus();
    expect(main.contains(screen.getByRole("button", { name: "Build server actions" }))).toBe(false);
    await user.keyboard("{Enter}");
    expect(onMenu).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("activates from the keyboard and marks the selected row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <EntityList>
        <EntityRow title="Local" selected onSelect={onSelect} />
        <EntityRow title="Build server" onSelect={onSelect} />
      </EntityList>,
    );
    const local = screen.getByRole("button", { name: "Local" });
    expect(local).toHaveAttribute("aria-current", "true");
    expect(local.closest("li")).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "Build server" })).not.toHaveAttribute("aria-current");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Build server" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("adds a decorative chevron to drill-down rows", () => {
    const { container } = render(
      <EntityList>
        <EntityRow title="General" subtitle="Sidebar and panels." href="/settings/general" chevron />
        <EntityRow title="Local" />
      </EntityList>,
    );
    const [drill, plain] = container.querySelectorAll("[data-slot=entity-row-main]");
    expect(drill!.querySelector("[data-slot=entity-row-chevron]")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("link", { name: "General" })).toHaveAccessibleDescription("Sidebar and panels.");
    expect(plain!.querySelector("[data-slot=entity-row-chevron]")).toBeNull();
  });

  it("renders rows as links for routes and disables rows", () => {
    render(
      <EntityList>
        <EntityRow title="Local" href="/settings/environments/local" selected />
        <EntityRow title="Removed host" href="/settings/environments/gone" disabled />
      </EntityList>,
    );
    const link = screen.getByRole("link", { name: "Local" });
    expect(link).toHaveAttribute("href", "/settings/environments/local");
    expect(link).toHaveAttribute("aria-current", "page");
    const disabled = screen.getByRole("button", { name: "Removed host" });
    expect(disabled).toBeDisabled();
    expect(disabled.closest("li")).toHaveAttribute("data-disabled", "true");
  });
});
