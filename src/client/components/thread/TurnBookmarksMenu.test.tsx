// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnBookmark } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { TurnBookmarksMenu } from "./TurnBookmarksMenu.js";

afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function bookmark(turnId: string, userPreview: string): TurnBookmark {
  return {
    turnId,
    userPreview,
    assistantPreview: `Answer to ${userPreview}`,
    responseState: "responded",
    createdAt: 1,
  };
}

describe("turn bookmarks menu", () => {
  it("shows both previews and removes a bookmark explicitly", async () => {
    const setTurnBookmarked = vi.fn(() => Promise.resolve());
    const onSelectTurn = vi.fn(() => false);
    render(
      <TurnBookmarksMenu
        bookmarks={[
          {
            turnId: "turn-1",
            userPreview: "How should bookmarks work?",
            assistantPreview: "Use the durable turn boundary.",
            responseState: "responded",
            createdAt: 1,
          },
        ]}
        status="ready"
        pendingTurnIds={[]}
        store={{ setTurnBookmarked } as unknown as ThreadClientStore}
        mobile={false}
        onSelectTurn={onSelectTurn}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Bookmarks, 1" });
    expect(trigger).toHaveAttribute("data-has-items", "true");
    expect(trigger.querySelector(".thread-bookmarks-count")).toBeNull();
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Bookmarks" });
    expect(popover).toHaveAttribute("data-slot", "popover-content");
    expect(
      screen.getByRole("heading", { name: "Bookmarks" }).tagName,
    ).toBe("H2");
    expect(screen.getByText("How should bookmarks work?")).toBeInTheDocument();
    expect(
      screen.getByText("Use the durable turn boundary."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("How should bookmarks work?"));
    await waitFor(() => expect(onSelectTurn).toHaveBeenCalledWith("turn-1"));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove bookmark: How should bookmarks work?",
      }),
    );
    expect(setTurnBookmarked).toHaveBeenCalledWith({
      turnId: "turn-1",
      bookmarked: false,
    });
  });

  it("moves between bookmarks with the arrow keys and keeps remove a Tab stop", () => {
    render(
      <TurnBookmarksMenu
        bookmarks={[
          bookmark("turn-1", "First question"),
          bookmark("turn-2", "Second question"),
          bookmark("turn-3", "Third question"),
        ]}
        status="ready"
        pendingTurnIds={["turn-2"]}
        store={{ setTurnBookmarked: vi.fn() } as unknown as ThreadClientStore}
        mobile={false}
        onSelectTurn={vi.fn(() => false)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks, 3" }));
    const list = screen.getByRole("list");
    const links = within(list)
      .getAllByRole("listitem")
      .map((row) => within(row).getAllByRole("button")[0]!);
    expect(links[0]).toHaveAccessibleName(
      /^You:\s*First question\s*Assistant:\s*Answer to First question$/,
    );
    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: "ArrowDown" });
    expect(links[1]).toHaveFocus();
    fireEvent.keyDown(links[1]!, { key: "End" });
    expect(links[2]).toHaveFocus();
    fireEvent.keyDown(links[2]!, { key: "ArrowDown" });
    expect(links[0]).toHaveFocus();
    fireEvent.keyDown(links[0]!, { key: "ArrowUp" });
    expect(links[2]).toHaveFocus();

    const remove = screen.getByRole("button", {
      name: "Remove bookmark: Third question",
    });
    expect(remove).not.toHaveAttribute("tabindex", "-1");
    remove.focus();
    fireEvent.keyDown(remove, { key: "Home" });
    expect(links[0]).toHaveFocus();
    // A pending removal disables only that row's remove action.
    expect(
      screen.getByRole("button", { name: "Remove bookmark: Second question" }),
    ).toBeDisabled();
    expect(links[1]).toBeEnabled();
  });

  it("shows loading, empty and retryable error states", () => {
    const loadBookmarks = vi.fn(() => Promise.resolve());
    const store = { loadBookmarks } as unknown as ThreadClientStore;
    const props = {
      pendingTurnIds: [],
      store,
      mobile: false,
      onSelectTurn: vi.fn(() => false),
    };
    const { rerender } = render(
      <TurnBookmarksMenu {...props} bookmarks={[]} status="loading" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading bookmarks…");

    rerender(<TurnBookmarksMenu {...props} bookmarks={[]} status="ready" />);
    expect(
      screen.getByText("Bookmark a user message to find that turn here."),
    ).toBeVisible();

    rerender(
      <TurnBookmarksMenu
        {...props}
        bookmarks={[]}
        status="error"
        error="Bookmarks are offline."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Bookmarks are offline.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(loadBookmarks).toHaveBeenCalledOnce();

    rerender(
      <TurnBookmarksMenu
        {...props}
        bookmarks={[bookmark("turn-1", "Kept question")]}
        status="error"
        error="Bookmarks could not be refreshed."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Bookmarks could not be refreshed.",
    );
    expect(screen.getByText("Kept question")).toBeVisible();
  });

  it("presents the shared bottom sheet on touch and selects after closing", async () => {
    const onSelectTurn = vi.fn(() => true);
    render(
      <TurnBookmarksMenu
        bookmarks={[bookmark("turn-1", "Mobile question")]}
        status="ready"
        pendingTurnIds={[]}
        store={{ setTurnBookmarked: vi.fn() } as unknown as ThreadClientStore}
        mobile
        onSelectTurn={onSelectTurn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks, 1" }));
    const sheet = screen.getByRole("dialog", { name: "Bookmarks" });
    expect(sheet).toHaveAttribute("data-slot", "dialog-content");
    expect(sheet).toHaveAttribute("data-layout", "sheet");
    expect(sheet).toHaveAccessibleDescription("Saved turns in this thread.");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    fireEvent.click(within(sheet).getByText("Mobile question"));
    await waitFor(() => expect(onSelectTurn).toHaveBeenCalledWith("turn-1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
