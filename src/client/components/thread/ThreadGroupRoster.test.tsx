// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThreadGroupRoster,
  type ThreadGroupRosterRenderState,
} from "./ThreadGroupRoster.js";

interface Member {
  readonly id: string;
  readonly title: string;
}

const members: readonly Member[] = [
  { id: "one", title: "First thread" },
  { id: "two", title: "Second thread" },
  { id: "three", title: "Third thread" },
];

beforeEach(() => {
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(cleanup);

function memberButton(member: Member, state: ThreadGroupRosterRenderState) {
  return (
    <button type="button" onClick={state.close}>
      {member.title}
    </button>
  );
}

function renderPopover(
  overrides: Partial<
    React.ComponentProps<typeof ThreadGroupRoster<Member>>
  > = {},
) {
  const callbacks = {
    onOpenChange: vi.fn(),
    onEscape: vi.fn(),
  };
  render(
    <ThreadGroupRoster
      label="Sidebar work"
      members={members}
      representativeId="one"
      selectedId="two"
      density="compact"
      presentation="popover"
      open
      anchor={<button type="button">Stack anchor</button>}
      renderMember={memberButton}
      {...callbacks}
      {...overrides}
    />,
  );
  return callbacks;
}

describe("ThreadGroupRoster", () => {
  it("renders a count-free roster and exposes representative and selection state", async () => {
    renderPopover();

    const roster = await screen.findByRole("dialog", {
      name: "Sidebar work",
    });
    expect(within(roster).getByRole("list")).toBeVisible();
    expect(within(roster).getAllByRole("listitem")).toHaveLength(3);
    expect(within(roster).getByTestId("thread-group-roster")).toBeVisible();
    expect(
      within(roster).getAllByTestId("thread-group-member")[0],
    ).toHaveAttribute("data-thread-id", "one");
    expect(within(roster).queryByText("3")).toBeNull();
    expect(
      roster.querySelector('[data-thread-group-roster-member="one"]'),
    ).toHaveAttribute("data-representative", "true");
    expect(
      roster.querySelector('[data-thread-group-roster-member="two"]'),
    ).toHaveAttribute("aria-current", "true");
  });

  it("focuses the selected member, then moves among member controls with arrow keys", async () => {
    const user = userEvent.setup();
    renderPopover({ autoFocusMembers: true });

    const selected = await screen.findByRole("button", {
      name: "Second thread",
    });
    await waitFor(() => expect(selected).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Third thread" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "First thread" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Third thread" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "First thread" })).toHaveFocus();
  });

  it("does not steal focus when its desktop popover opens from hover", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();

    renderPopover();

    await screen.findByRole("dialog", { name: "Sidebar work" });
    await waitFor(() => expect(anchor).toHaveFocus());
    anchor.remove();
  });

  it("closes the desktop roster when its surrounding list scrolls", async () => {
    const callbacks = renderPopover();
    const roster = await screen.findByRole("dialog", { name: "Sidebar work" });

    fireEvent.scroll(within(roster).getByRole("list"));
    expect(callbacks.onOpenChange).not.toHaveBeenCalled();

    fireEvent.scroll(document.body);
    expect(callbacks.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("reports Escape interactions to its owner", async () => {
    const user = userEvent.setup();
    const callbacks = renderPopover();

    await screen.findByRole("dialog", { name: "Sidebar work" });
    await user.keyboard("{Escape}");
    expect(callbacks.onEscape).toHaveBeenCalledOnce();
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses a modal bottom sheet and closes after a member action", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ThreadGroupRoster
        label="Mobile group"
        members={members}
        representativeId="one"
        selectedId="three"
        density="card"
        presentation="sheet"
        open
        onOpenChange={onOpenChange}
        anchor={<button type="button">Mobile stack face</button>}
        renderMember={memberButton}
      />,
    );

    // A modal Dialog aria-hides the underlying anchor while it is open, but
    // the stack face must stay mounted so it can return when the sheet closes.
    expect(screen.getByText("Mobile stack face")).toBeInTheDocument();
    const sheet = await screen.findByRole("dialog", { name: "Mobile group" });
    expect(sheet).toHaveClass("thread-group-roster-sheet");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    await waitFor(() =>
      expect(
        within(sheet).getByRole("button", { name: "Third thread" }),
      ).toHaveFocus(),
    );

    await user.click(
      within(sheet).getByRole("button", { name: "First thread" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses the mobile sheet after a downward handle drag but not a short drag", async () => {
    const onOpenChange = vi.fn();
    render(
      <ThreadGroupRoster
        label="Mobile group"
        members={members}
        representativeId="one"
        density="compact"
        presentation="sheet"
        open
        onOpenChange={onOpenChange}
        renderMember={memberButton}
      />,
    );

    const handle = await screen.findByRole("button", {
      name: "Close Mobile group roster",
    });
    fireEvent.pointerDown(handle, {
      pointerId: 7,
      pointerType: "touch",
      button: 0,
      clientY: 100,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 7,
      pointerType: "touch",
      clientY: 108,
    });
    fireEvent.pointerUp(handle, {
      pointerId: 7,
      pointerType: "touch",
      clientY: 108,
    });
    fireEvent.click(handle);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, {
      pointerId: 8,
      pointerType: "touch",
      button: 0,
      clientY: 100,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 8,
      pointerType: "touch",
      clientY: 184,
    });
    fireEvent.pointerUp(handle, {
      pointerId: 8,
      pointerType: "touch",
      clientY: 184,
    });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("falls back to the representative when the selected id is absent", async () => {
    renderPopover({ selectedId: "not-visible", autoFocusMembers: true });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "First thread" }),
      ).toHaveFocus(),
    );
  });
});
