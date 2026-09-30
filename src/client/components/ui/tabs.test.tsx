// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CountBadge } from "./count-badge.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

afterEach(cleanup);

describe("Tabs", () => {
  it("underlines the active tab and shows its panel", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Environment">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="backends">
            Backends <CountBadge count={3} />
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Health summary</TabsContent>
        <TabsContent value="backends">Backend list</TabsContent>
        <TabsContent value="activity">Activity log</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tablist", { name: "Environment" })).toHaveClass("border-b", "border-border-soft");
    const overview = screen.getByRole("tab", { name: "Overview" });
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(overview).toHaveClass("data-[state=active]:shadow-[inset_0_-2px_0_var(--foreground)]");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Health summary");

    await user.click(screen.getByRole("tab", { name: "Backends 3" }));
    expect(screen.getByRole("tab", { name: "Backends 3" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Backend list");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Activity log");
  });

  it("keeps triggers at least the density control height", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "A" })).toHaveClass(
      "min-h-[max(var(--control-lg),var(--control-default))]",
    );
  });
});
