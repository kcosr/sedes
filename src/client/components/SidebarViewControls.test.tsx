// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_VIEW_DEFAULTS,
  type SidebarViewPreferences,
} from "../app/sidebar-view-model.js";
import { SidebarViewControls } from "./SidebarViewControls.js";

// jsdom lacks the observer and pointer-capture APIs Radix popovers
// (floating-ui) touch.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderControls(overrides?: Partial<SidebarViewPreferences>) {
  const handlers = {
    onGroupByChange: vi.fn(),
    onStackByChange: vi.fn(),
    onSortChange: vi.fn(),
    onDensityChange: vi.fn(),
    onPeekToggle: vi.fn(),
    onPinnedOnlyToggle: vi.fn(),
    onShowToggle: vi.fn(),
    onGroupForksToggle: vi.fn(),
    onBackendIconsToggle: vi.fn(),
    onResetMode: vi.fn(),
    onOptionsOpenChange: vi.fn(),
  };
  const prefs = (
    o?: Partial<SidebarViewPreferences>,
  ): SidebarViewPreferences => ({
    ...SIDEBAR_VIEW_DEFAULTS,
    groupBy: "project",
    ...o,
  });
  const view = render(
    <SidebarViewControls preferences={prefs(overrides)} {...handlers} />,
  );
  const rerender = (o?: Partial<SidebarViewPreferences>) =>
    view.rerender(<SidebarViewControls preferences={prefs(o)} {...handlers} />);
  return { handlers, view, rerender };
}

async function openOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("view-options-trigger"));
  return await screen.findByRole("dialog", { name: "View options" });
}

describe("SidebarViewControls", () => {
  it("quick toggle flips from Projects to the remembered alt view", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({ lastAltGroupBy: "time" });

    const toggle = screen.getByTestId("view-quick-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAccessibleName("Switch to Timeline");

    await user.click(toggle);
    expect(handlers.onGroupByChange).toHaveBeenCalledExactlyOnceWith("time");
  });

  it("quick toggle flips back to Projects from an alt view", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({
      groupBy: "state",
      lastAltGroupBy: "state",
    });

    const toggle = screen.getByTestId("view-quick-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName("Switch to Projects");

    await user.click(toggle);
    expect(handlers.onGroupByChange).toHaveBeenCalledExactlyOnceWith("project");
  });

  it("group-by row selects the view and closes the popover", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls();
    await openOptions(user);

    const row = screen.getByRole("radio", { name: "Timeline" });
    expect(row).toHaveAttribute("aria-checked", "false");
    await user.click(row);

    expect(handlers.onGroupByChange).toHaveBeenCalledExactlyOnceWith("time");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "View options" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers thread-group stacking independently from organization", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({ groupBy: "time" });
    await openOptions(user);
    const stackOptions = screen.getByRole("radiogroup", { name: "Stack by" });
    await user.click(
      within(stackOptions).getByRole("radio", { name: "Thread groups" }),
    );
    expect(handlers.onStackByChange).toHaveBeenCalledExactlyOnceWith("group");
    expect(handlers.onGroupByChange).not.toHaveBeenCalled();
  });

  it("shows the selected stack setting alongside Projects organization", async () => {
    const user = userEvent.setup();
    renderControls({ groupBy: "project", stackBy: "project" });
    await openOptions(user);
    const groupOptions = screen.getByRole("radiogroup", { name: "Group by" });
    const stackOptions = screen.getByRole("radiogroup", { name: "Stack by" });
    expect(
      within(groupOptions).getByRole("radio", { name: "Projects" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(stackOptions).getByRole("radio", { name: "Projects" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("active sort row asks the parent to flip direction and stays open", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls();
    await openOptions(user);

    // project mode default: sortBy activity, direction desc.
    const active = screen.getByRole("radio", {
      name: "Activity, descending — activate to reverse",
    });
    expect(active).toHaveAttribute("aria-checked", "true");
    expect(active).toHaveAttribute("data-direction", "desc");

    await user.click(active);
    expect(handlers.onSortChange).toHaveBeenCalledExactlyOnceWith("activity");
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Alphabetical" }));
    expect(handlers.onSortChange).toHaveBeenLastCalledWith("alpha");
  });

  it("announces sort direction on the active row and re-announces on flip", async () => {
    const user = userEvent.setup();
    const { rerender } = renderControls();
    await openOptions(user);

    // Only the active row carries the direction/flip affordance; inactive
    // rows keep their plain visible label.
    expect(
      screen.getByRole("radio", {
        name: "Activity, descending — activate to reverse",
      }),
    ).toHaveAttribute("data-direction", "desc");
    expect(
      screen.getByRole("radio", { name: "Alphabetical" }),
    ).toBeInTheDocument();

    // Parent flips direction after the re-select; the announcement follows.
    rerender({ modes: { project: { direction: "asc" } } });
    expect(
      screen.getByRole("radio", {
        name: "Activity, ascending — activate to reverse",
      }),
    ).toHaveAttribute("data-direction", "asc");
  });

  it("density, peek, and show rows fire their callbacks in an alt view", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({ groupBy: "time" });
    await openOptions(user);

    await user.click(screen.getByRole("radio", { name: "Card" }));
    expect(handlers.onDensityChange).toHaveBeenCalledExactlyOnceWith("card");

    await user.click(
      screen.getByRole("checkbox", { name: "Peek details on hover" }),
    );
    expect(handlers.onPeekToggle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("checkbox", { name: "Pinned only" }));
    expect(handlers.onPinnedOnlyToggle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("checkbox", { name: "Snoozed" }));
    await user.click(screen.getByRole("checkbox", { name: "Settled" }));
    await user.click(screen.getByRole("checkbox", { name: "Drafts" }));
    expect(handlers.onShowToggle.mock.calls).toEqual([
      ["snoozed"],
      ["settled"],
      ["drafts"],
    ]);

    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
  });

  it("keeps Timeline display controls available while stacking", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({ groupBy: "time", stackBy: "group" });
    await openOptions(user);

    await user.click(screen.getByRole("radio", { name: "Card" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Peek details on hover" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Pinned only" }));

    expect(handlers.onDensityChange).toHaveBeenCalledExactlyOnceWith("card");
    expect(handlers.onPeekToggle).toHaveBeenCalledOnce();
    expect(handlers.onPinnedOnlyToggle).toHaveBeenCalledOnce();
  });

  it("omits flat-only controls while keeping Projects controls live", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls();
    await openOptions(user);

    expect(screen.queryByRole("radio", { name: "Compact" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Card" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Peek details on hover" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Pinned only" })).toBeNull();
    expect(handlers.onDensityChange).not.toHaveBeenCalled();
    expect(handlers.onPeekToggle).not.toHaveBeenCalled();

    // Sort, Show, and fork-families rows stay live in Projects mode.
    await user.click(screen.getByRole("radio", { name: "Alphabetical" }));
    expect(handlers.onSortChange).toHaveBeenCalledExactlyOnceWith("alpha");
    await user.click(
      screen.getByRole("checkbox", { name: "Group fork families" }),
    );
    expect(handlers.onGroupForksToggle).toHaveBeenCalledOnce();
  });

  it("disabled rows do not fire", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls({ groupBy: "time" });
    await openOptions(user);

    const archived = screen.getByRole("checkbox", { name: /Archived/ });
    expect(archived).toBeDisabled();
    expect(archived).toHaveTextContent(
      "Needs archived threads on the snapshot wire",
    );
    await user.click(archived).catch(() => {});
    expect(handlers.onShowToggle).not.toHaveBeenCalled();

    const forks = screen.getByRole("checkbox", {
      name: /Group fork families/,
    });
    expect(forks).toBeDisabled();
    expect(forks).toHaveTextContent("Forks list flat outside Projects");
    await user.click(forks).catch(() => {});
    expect(handlers.onGroupForksToggle).not.toHaveBeenCalled();
  });

  it("dirty dot tracks per-mode defaults and show filters", () => {
    const { view } = renderControls();
    expect(screen.queryByTestId("view-options-dirty-dot")).toBeNull();
    view.unmount();

    // A mode override that differs from SIDEBAR_MODE_DEFAULTS dirties it...
    const changed = renderControls({
      groupBy: "time",
      modes: { time: { density: "card" } },
    });
    expect(screen.getByTestId("view-options-dirty-dot")).toBeInTheDocument();
    changed.view.unmount();

    const pinnedOnly = renderControls({
      groupBy: "time",
      modes: { time: { pinnedOnly: true } },
    });
    expect(screen.getByTestId("view-options-dirty-dot")).toBeInTheDocument();
    pinnedOnly.view.unmount();

    // ...an override equal to the mode's defaults does not...
    const redundant = renderControls({
      groupBy: "state",
      modes: { state: { sortBy: "stateChanged" } },
    });
    expect(screen.queryByTestId("view-options-dirty-dot")).toBeNull();
    redundant.view.unmount();

    // ...and any Show filter turned off dirties it too.
    renderControls({
      show: { snoozed: true, settled: false, drafts: true },
    });
    expect(screen.getByTestId("view-options-dirty-dot")).toBeInTheDocument();
  });

  it("backend icons row is on by default, fires its callback, and dirties the dot when off", async () => {
    const user = userEvent.setup();
    const { handlers, view } = renderControls();
    await openOptions(user);

    const row = screen.getByRole("checkbox", { name: "Backend icons" });
    expect(row).toHaveAttribute("aria-checked", "true");
    await user.click(row);
    expect(handlers.onBackendIconsToggle).toHaveBeenCalledOnce();
    view.unmount();

    // Hiding brand marks is a non-default display choice, so it dirties the dot.
    renderControls({ showBackendIcons: false });
    expect(screen.getByTestId("view-options-dirty-dot")).toBeInTheDocument();
    await openOptions(user);
    expect(
      screen.getByRole("checkbox", { name: "Backend icons" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("omits flat-only controls in Projects mode", async () => {
    const user = userEvent.setup();
    const project = renderControls({});
    await user.click(screen.getByTestId("view-options-trigger"));
    expect(screen.queryByRole("radiogroup", { name: "Density" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Peek details on hover" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Pinned only" })).toBeNull();
    project.view.unmount();

    // Sort overrides still apply in Projects mode, so they dirty it.
    renderControls({ modes: { project: { direction: "asc" } } });
    expect(screen.getByTestId("view-options-dirty-dot")).toBeInTheDocument();
  });

  it("reports popover open state through onOptionsOpenChange", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls();
    await openOptions(user);

    expect(handlers.onOptionsOpenChange).toHaveBeenCalledExactlyOnceWith(true);

    // Selecting a group-by row closes the popover and reports the close.
    await user.click(screen.getByRole("radio", { name: "Timeline" }));
    expect(handlers.onOptionsOpenChange).toHaveBeenLastCalledWith(false);
    expect(handlers.onOptionsOpenChange.mock.calls).toEqual([[true], [false]]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "View options" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("reset row fires onResetMode", async () => {
    const user = userEvent.setup();
    const { handlers } = renderControls();
    await openOptions(user);

    await user.click(screen.getByRole("button", { name: "Reset this view" }));
    expect(handlers.onResetMode).toHaveBeenCalledOnce();
  });
});
