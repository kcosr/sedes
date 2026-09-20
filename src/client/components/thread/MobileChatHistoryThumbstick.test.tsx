// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  historyRailNaturalHeight,
  historyRailPixelsPerEntry,
  historyRailPosition,
  historyScrubIndex,
  MobileChatHistoryThumbstick,
} from "./MobileChatHistoryThumbstick.js";
import type { ChatHistoryEntry } from "./ChatHistoryRail.js";

const entries: readonly ChatHistoryEntry[] = [
  {
    itemId: "user-1",
    turnId: "turn-1",
    userPreview: "First question",
    assistantPreview: "First answer",
    responseState: "available",
  },
  {
    itemId: "user-2",
    turnId: "turn-2",
    userPreview: "Second question",
    assistantPreview: "Second answer",
    responseState: "available",
  },
  {
    itemId: "user-3",
    turnId: "turn-3",
    userPreview: "Latest question",
    assistantPreview: "Latest answer",
    responseState: "available",
  },
];

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("mobile chat history thumbstick", () => {
  it("maps direct travel at the mobile rail's entry cadence", () => {
    expect(historyScrubIndex(5, 0, 10, 28)).toBe(5);
    expect(historyScrubIndex(5, -19, 10, 28)).toBe(5);
    expect(historyScrubIndex(5, -20, 10, 28)).toBe(4);
    expect(historyScrubIndex(5, 20, 10, 28)).toBe(6);
    expect(historyScrubIndex(5, -500, 10, 28)).toBe(0);
    expect(historyScrubIndex(5, 500, 10, 28)).toBe(9);
  });

  it("keeps short histories compact at the roomier mobile cadence", () => {
    expect(historyRailNaturalHeight(3)).toBe(88);
    expect(historyRailNaturalHeight(10)).toBe(284);
    expect(historyRailPixelsPerEntry(10, 284)).toBe(28);
  });

  it("fits every history tick into one normalized rail", () => {
    expect(historyRailPosition(0, 10)).toBe(0);
    expect(historyRailPosition(4.5, 10)).toBe(0.5);
    expect(historyRailPosition(9, 10)).toBe(1);
    expect(historyRailPosition(-5, 10)).toBe(0);
    expect(historyRailPosition(20, 10)).toBe(1);
  });

  it("becomes proportionally more sensitive as message count grows", () => {
    const compactSpacing = historyRailPixelsPerEntry(10, 284);
    const compressedSpacing = historyRailPixelsPerEntry(100, 320);
    expect(historyScrubIndex(9, -40, 10, compactSpacing)).toBe(8);
    expect(historyScrubIndex(99, -40, 100, compressedSpacing)).toBe(87);
  });

  it("renders and commits a single history entry while remaining absent for none", () => {
    const onSelect = vi.fn();
    const view = render(
      <MobileChatHistoryThumbstick
        entries={[]}
        getActiveItemId={() => undefined}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Tap to jump to the latest user message; hold to scrub conversation history",
      }),
    ).toBeNull();

    view.rerender(
      <MobileChatHistoryThumbstick
        entries={[entries[0]!]}
        getActiveItemId={() => "user-1"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });
    fireEvent.pointerDown(target, {
      button: 0,
      clientY: 400,
      isPrimary: true,
      pointerId: 6,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(240));

    expect(screen.getByRole("status")).toHaveTextContent("Message 1 of 1");
    expect(screen.getByRole("status")).toHaveTextContent("First answer");

    fireEvent.pointerUp(target, {
      clientY: 400,
      isPrimary: true,
      pointerId: 6,
      pointerType: "touch",
    });
    expect(onSelect).toHaveBeenCalledWith("user-1");
  });

  it("directly scrubs while moving, stops while held still, and seeks on release", () => {
    const onSelect = vi.fn();
    render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={() => "user-3"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });

    fireEvent.pointerDown(target, {
      button: 0,
      clientX: 200,
      clientY: 400,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(240));

    expect(target).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Message 3 of 3");
    expect(screen.getByRole("status")).toHaveTextContent("Latest answer");

    fireEvent.pointerMove(target, {
      clientX: 200,
      clientY: 380,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
    });

    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(screen.getByRole("status")).toHaveTextContent("Second answer");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.pointerMove(target, {
      clientX: 200,
      clientY: 338,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
    });

    expect(screen.getByRole("status")).toHaveTextContent("Message 1 of 3");
    expect(screen.getByRole("status")).toHaveTextContent("First answer");

    fireEvent.pointerUp(target, {
      clientX: 200,
      clientY: 338,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
    });

    expect(onSelect).toHaveBeenCalledWith("user-1");
    expect(target).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("jumps to the latest user message on a quick tap", () => {
    const onSelect = vi.fn();
    render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={() => "user-2"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });

    fireEvent.pointerDown(target, {
      button: 0,
      clientX: 200,
      clientY: 400,
      isPrimary: true,
      pointerId: 8,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(target, {
      clientX: 200,
      clientY: 400,
      isPrimary: true,
      pointerId: 8,
      pointerType: "touch",
    });

    fireEvent.click(target, { detail: 1 });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("user-3");
    expect(target).toHaveAttribute("aria-expanded", "false");
    act(() => vi.advanceTimersByTime(1_600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels interrupted pointer gestures without seeking", () => {
    const onSelect = vi.fn();
    render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={() => "user-3"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });

    fireEvent.pointerDown(target, {
      button: 0,
      clientX: 200,
      clientY: 400,
      isPrimary: true,
      pointerId: 9,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(240));
    fireEvent.pointerCancel(target, { pointerId: 9, pointerType: "touch" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(target).toHaveAttribute("aria-expanded", "false");
  });

  it("provides keyboard scanning and commit semantics", () => {
    const onSelect = vi.fn();
    render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={() => "user-3"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });

    fireEvent.click(target, { detail: 0 });
    fireEvent.keyDown(target, { key: "ArrowUp" });
    expect(screen.getByRole("status")).toHaveTextContent("Second question");
    fireEvent.click(target, { detail: 0 });

    expect(onSelect).toHaveBeenCalledWith("user-2");
    expect(target).toHaveAttribute("aria-expanded", "false");
  });

  it("samples the current message when each pointer scrub starts", () => {
    let currentItemId = "user-3";
    const getActiveItemId = vi.fn(() => currentItemId);
    render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={getActiveItemId}
        assistantLabel="Assistant"
        onSelect={vi.fn()}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });
    expect(getActiveItemId).not.toHaveBeenCalled();

    fireEvent.pointerDown(target, {
      button: 0,
      clientY: 400,
      isPrimary: true,
      pointerId: 10,
      pointerType: "touch",
    });
    // Seeking can change the visible message without rerendering this control.
    currentItemId = "user-2";
    act(() => vi.advanceTimersByTime(240));
    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(getActiveItemId).toHaveBeenCalledTimes(1);

    currentItemId = "user-1";
    fireEvent.pointerMove(target, {
      clientY: 400,
      isPrimary: true,
      pointerId: 10,
      pointerType: "touch",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(getActiveItemId).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(target, { pointerId: 10, pointerType: "touch" });

    fireEvent.pointerDown(target, {
      button: 0,
      clientY: 400,
      isPrimary: true,
      pointerId: 11,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(240));
    expect(screen.getByRole("status")).toHaveTextContent("Message 1 of 3");
    expect(getActiveItemId).toHaveBeenCalledTimes(2);
  });

  it("uses the latest getter when a keyboard interaction starts", () => {
    const getActiveItemId = vi.fn(() => "user-3");
    const view = render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={getActiveItemId}
        assistantLabel="Assistant"
        onSelect={vi.fn()}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });
    expect(getActiveItemId).not.toHaveBeenCalled();
    fireEvent.keyDown(target, { key: "ArrowUp" });
    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(getActiveItemId).toHaveBeenCalledTimes(1);

    const nextGetActiveItemId = vi.fn(() => "user-1");
    view.rerender(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={nextGetActiveItemId}
        assistantLabel="Assistant"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.keyDown(target, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Message 3 of 3");
    expect(nextGetActiveItemId).not.toHaveBeenCalled();
    fireEvent.keyDown(target, { key: "Escape" });

    fireEvent.keyDown(target, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Message 2 of 3");
    expect(nextGetActiveItemId).toHaveBeenCalledTimes(1);
    expect(getActiveItemId).toHaveBeenCalledTimes(1);
  });

  it("retains the previewed message when older entries are prepended", () => {
    const onSelect = vi.fn();
    const view = render(
      <MobileChatHistoryThumbstick
        entries={entries}
        getActiveItemId={() => "user-2"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });
    fireEvent.click(target, { detail: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Second question");

    view.rerender(
      <MobileChatHistoryThumbstick
        entries={[
          {
            itemId: "user-0",
            turnId: "turn-0",
            userPreview: "Earlier question",
            assistantPreview: "Earlier answer",
            responseState: "available",
          },
          ...entries,
        ]}
        getActiveItemId={() => "user-2"}
        assistantLabel="Assistant"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Message 3 of 4");
    expect(screen.getByRole("status")).toHaveTextContent("Second question");
  });
});
