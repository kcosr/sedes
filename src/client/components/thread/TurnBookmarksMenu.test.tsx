// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
